// Toolsets for the non-SQL panes: Redis, MongoDB, S3 and SFTP. Same contract
// as the SQL/SSH ones: reads auto-run (when the user allows it), anything that
// changes data asks first.

import { api, type DbConnParams } from "../../api";
import type { AiTool } from "../types";
import type { Toolset, ToolCall, ToolRisk, ToolRunResult } from "../tool";

const OUT_CAP = 16000;
const cap = (s: string) => (s.length > OUT_CAP ? s.slice(0, OUT_CAP) + "\n… (truncated)" : s);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const obj = (props: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});
const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });

const READ: ToolRisk = { level: "read" };
const write = (reason: string): ToolRisk => ({ level: "write", reason });

function toolset(
  tools: AiTool[],
  risk: (call: ToolCall) => ToolRisk,
  run: (call: ToolCall) => Promise<string>,
  /** Re-list the pane after a change so the user sees it. */
  refresh: () => void,
): Toolset {
  return {
    tools,
    classify: risk,
    async execute(call) {
      try {
        const out = await run(call);
        if (risk(call).level === "write") refresh();
        return { output: cap(out), isError: false } satisfies ToolRunResult;
      } catch (e) {
        return { output: String(e), isError: true };
      }
    },
  };
}

const COMMON = [
  "- Be concise. Summarise what you found and end with a short, direct answer.",
  "- Anything that changes data asks the user first: say what it will do and why before proposing it.",
];

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export interface KvContext {
  /** Reload the pane's view after the assistant changed something. */
  refresh?: () => void;
  params: DbConnParams;
  label: string;
}

/** Commands that only read. Everything else (and KEYS, which blocks the
 *  server on a big keyspace) needs approval. */
const REDIS_READ = new Set(
  (
    "GET MGET STRLEN GETRANGE EXISTS TYPE TTL PTTL EXPIRETIME OBJECT DUMP SCAN HSCAN SSCAN ZSCAN " +
    "HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSTRLEN HRANDFIELD " +
    "LRANGE LLEN LINDEX LPOS SMEMBERS SCARD SISMEMBER SMISMEMBER SRANDMEMBER SINTER SUNION SDIFF " +
    "ZRANGE ZRANGEBYSCORE ZREVRANGE ZREVRANGEBYSCORE ZRANGEBYLEX ZCARD ZSCORE ZMSCORE ZRANK ZREVRANK ZCOUNT ZLEXCOUNT " +
    "XRANGE XREVRANGE XLEN XINFO XPENDING PFCOUNT GETBIT BITCOUNT BITPOS " +
    "INFO DBSIZE PING TIME ECHO LASTSAVE ROLE MEMORY SLOWLOG LATENCY CLIENT CONFIG COMMAND " +
    "JSON.GET JSON.TYPE JSON.STRLEN JSON.OBJKEYS JSON.ARRLEN FT._LIST FT.INFO FT.SEARCH"
  ).split(" "),
);
/** Sub-commands of the admin groups above that only read. */
const REDIS_READ_SUB: Record<string, Set<string>> = {
  MEMORY: new Set(["USAGE", "STATS", "DOCTOR"]),
  SLOWLOG: new Set(["GET", "LEN"]),
  LATENCY: new Set(["LATEST", "HISTORY", "DOCTOR"]),
  CLIENT: new Set(["LIST", "INFO", "GETNAME", "ID"]),
  CONFIG: new Set(["GET"]),
  COMMAND: new Set(["COUNT", "INFO", "DOCS", "LIST"]),
  OBJECT: new Set(["ENCODING", "FREQ", "IDLETIME", "REFCOUNT"]),
  XINFO: new Set(["STREAM", "GROUPS", "CONSUMERS"]),
};

export function classifyRedis(argv: string[]): ToolRisk {
  const c = (argv[0] ?? "").toUpperCase();
  if (!c) return write("empty command");
  if (c === "KEYS") return write("KEYS blocks the server on a large keyspace — prefer SCAN");
  if (!REDIS_READ.has(c)) return write(`${c} changes data or server state`);
  const sub = REDIS_READ_SUB[c];
  if (sub && argv[1] && !sub.has(argv[1].toUpperCase())) return write(`${c} ${argv[1].toUpperCase()} isn't read-only`);
  return READ;
}

const REDIS_TOOLS: AiTool[] = [
  {
    name: "redis_command",
    description:
      "Run one Redis command, given as an argv array (e.g. [\"HGETALL\",\"user:1\"]). Read-only commands run " +
      "automatically; anything that writes, deletes, expires or changes server config needs the user's approval. " +
      "Prefer SCAN over KEYS.",
    inputSchema: obj({ argv: { type: "array", items: { type: "string" }, description: "Command and arguments." } }, ["argv"]),
  },
  {
    name: "scan_keys",
    description: "List keys matching a glob pattern (SCAN), with type and TTL. Returns up to `count` keys.",
    inputSchema: obj({ pattern: S("Glob pattern, e.g. session:*"), count: N("Max keys (default 200).") }),
  },
  {
    name: "get_key",
    description: "Read a key's value (any type), formatted.",
    inputSchema: obj({ key: S("Key name.") }, ["key"]),
  },
  { name: "server_info", description: "Redis INFO (memory, clients, keyspace, persistence…).", inputSchema: obj({}) },
];

export function makeRedisToolset(getCtx: () => KvContext): Toolset {
  return toolset(
    REDIS_TOOLS,
    (call) => {
      if (call.name === "redis_command") {
        const argv = Array.isArray(call.input.argv) ? call.input.argv.map(String) : [];
        return classifyRedis(argv);
      }
      return call.name === "scan_keys" || call.name === "get_key" || call.name === "server_info"
        ? READ
        : write("unknown tool");
    },
    async (call) => {
      const p = getCtx().params;
      switch (call.name) {
        case "redis_command": {
          const argv = Array.isArray(call.input.argv) ? call.input.argv.map(String) : [];
          if (!argv.length) throw new Error("Empty command.");
          return (await api.redisCommand(p, argv)) || "(nil)";
        }
        case "scan_keys": {
          const want = Math.min(2000, num(call.input.count, 200));
          const pattern = str(call.input.pattern) || "*";
          const out: string[] = [];
          let cursor = 0;
          for (let i = 0; i < 50; i++) {
            const r = await api.redisScan(p, pattern, cursor, 500);
            for (const k of r.keys) out.push(`${k.name}  (${k.kind}${k.ttl >= 0 ? `, ttl ${k.ttl}s` : ""})`);
            cursor = r.cursor;
            if (cursor === 0 || out.length >= want) break;
          }
          const more = cursor !== 0 || out.length > want ? "\n… more keys match" : "";
          return out.length ? out.slice(0, want).join("\n") + more : "(no keys match)";
        }
        case "get_key": {
          const r = await api.redisGet(p, str(call.input.key));
          return `type ${r.kind}\n${r.value}`;
        }
        case "server_info":
          return api.redisInfo(p);
      }
      throw new Error(`Unknown tool: ${call.name}`);
    },
    () => getCtx().refresh?.()
  );
}

export function redisSystemPrompt(ctx: KvContext): string {
  return [
    "You are BalauDeck's built-in assistant, embedded in a Redis panel.",
    `The user is connected to \`${ctx.label}\`. Help them explore keys, values and server health.`,
    "",
    "Tools: scan_keys(pattern, count), get_key(key), server_info, redis_command(argv).",
    "- Use SCAN-based tools; never KEYS on a server you haven't sized (DBSIZE first).",
    "- For memory questions use MEMORY USAGE on sampled keys and INFO memory.",
    ...COMMON,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

export interface DocContext {
  /** Reload the pane's view after the assistant changed something. */
  refresh?: () => void;
  params: DbConnParams;
  label: string;
  /** Database/collection the user has open, if any. */
  database: string;
  collection: string;
}

const MONGO_TOOLS: AiTool[] = [
  { name: "list_databases", description: "List databases.", inputSchema: obj({}) },
  {
    name: "list_collections",
    description: "List collections in a database (defaults to the open one).",
    inputSchema: obj({ database: S("Database name.") }),
  },
  {
    name: "find",
    description:
      "Find documents. `filter` is a JSON query object (e.g. {\"status\":\"paid\",\"total\":{\"$gt\":100}}). " +
      "Returns up to `limit` documents as JSON (default 20).",
    inputSchema: obj(
      { database: S("Database."), collection: S("Collection."), filter: S("JSON filter, {} for all."), limit: N("Max docs (default 20, max 200).") },
      ["collection"],
    ),
  },
  {
    name: "count",
    description: "Count documents matching a JSON filter.",
    inputSchema: obj({ database: S("Database."), collection: S("Collection."), filter: S("JSON filter.") }, ["collection"]),
  },
  {
    name: "insert_one",
    description: "Insert one document (JSON). Needs approval.",
    inputSchema: obj({ database: S("Database."), collection: S("Collection."), document: S("JSON document.") }, ["collection", "document"]),
  },
  {
    name: "replace_one",
    description: "Replace the document with this _id (24-hex ObjectId) by a new JSON document. Needs approval.",
    inputSchema: obj(
      { database: S("Database."), collection: S("Collection."), id: S("ObjectId hex."), document: S("New JSON document.") },
      ["collection", "id", "document"],
    ),
  },
  {
    name: "delete_one",
    description: "Delete the document with this _id (24-hex ObjectId). Needs approval.",
    inputSchema: obj({ database: S("Database."), collection: S("Collection."), id: S("ObjectId hex.") }, ["collection", "id"]),
  },
];

export function makeMongoToolset(getCtx: () => DocContext): Toolset {
  return toolset(
    MONGO_TOOLS,
    (call) =>
      call.name === "insert_one"
        ? write("inserts a document")
        : call.name === "replace_one"
          ? write("replaces a document")
          : call.name === "delete_one"
            ? write("deletes a document")
            : MONGO_TOOLS.some((t) => t.name === call.name)
              ? READ
              : write("unknown tool"),
    async (call) => {
      const ctx = getCtx();
      const db = str(call.input.database) || ctx.database;
      const coll = str(call.input.collection) || ctx.collection;
      const need = () => {
        if (!db) throw new Error("No database given.");
        if (!coll) throw new Error("No collection given.");
      };
      switch (call.name) {
        case "list_databases":
          return (await api.mongoDatabases(ctx.params)).join("\n") || "(none)";
        case "list_collections":
          if (!db) throw new Error("No database given.");
          return (await api.mongoCollections(ctx.params, db)).join("\n") || "(none)";
        case "find": {
          need();
          const limit = Math.min(200, num(call.input.limit, 20));
          const docs = await api.mongoFind(ctx.params, db, coll, str(call.input.filter) || "{}", limit);
          return docs.length ? docs.join("\n") + `\n(${docs.length} document${docs.length === 1 ? "" : "s"})` : "(no documents)";
        }
        case "count":
          need();
          return String(await api.mongoCount(ctx.params, db, coll, str(call.input.filter) || "{}"));
        case "insert_one":
          need();
          return `Inserted _id ${await api.mongoInsert(ctx.params, db, coll, str(call.input.document))}`;
        case "replace_one":
          need();
          return `Replaced ${await api.mongoReplace(ctx.params, db, coll, str(call.input.id), str(call.input.document))} document(s)`;
        case "delete_one":
          need();
          return `Deleted ${await api.mongoDelete(ctx.params, db, coll, str(call.input.id))} document(s)`;
      }
      throw new Error(`Unknown tool: ${call.name}`);
    },
    () => getCtx().refresh?.()
  );
}

export function mongoSystemPrompt(ctx: DocContext): string {
  const open = ctx.database ? ` Open: \`${ctx.database}${ctx.collection ? "." + ctx.collection : ""}\`.` : "";
  return [
    "You are BalauDeck's built-in assistant, embedded in a MongoDB panel.",
    `The user is connected to \`${ctx.label}\`.${open} Help them explore and query their documents.`,
    "",
    "Tools: list_databases, list_collections, find(filter, limit), count(filter); insert_one / replace_one / delete_one need approval.",
    "- Look at a few documents (find with a small limit) before assuming field names.",
    "- Filters are JSON (MongoDB query operators like $gt, $in, $regex work).",
    ...COMMON,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// S3-compatible object storage
// ---------------------------------------------------------------------------

export interface ObjContext {
  /** Reload the pane's view after the assistant changed something. */
  refresh?: () => void;
  params: DbConnParams;
  label: string;
  bucket: string;
  prefix: string;
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;

const S3_TOOLS: AiTool[] = [
  { name: "list_buckets", description: "List buckets.", inputSchema: obj({}) },
  {
    name: "list_objects",
    description: "List one level of a bucket under a prefix (folders end in /). Follows pages up to `max` entries.",
    inputSchema: obj({ bucket: S("Bucket (defaults to the open one)."), prefix: S("Prefix, e.g. logs/2026/ (\"\" = root)."), max: N("Max entries (default 500).") }),
  },
  {
    name: "read_object",
    description: "Read a text object's content (first part of large files).",
    inputSchema: obj({ bucket: S("Bucket."), key: S("Object key.") }, ["key"]),
  },
  {
    name: "folder_size",
    description: "Total size and object count under a prefix (walks every level — may take a while on big trees).",
    inputSchema: obj({ bucket: S("Bucket."), prefix: S("Prefix.") }),
  },
  {
    name: "put_text",
    description: "Create or overwrite a text object. Needs approval.",
    inputSchema: obj({ bucket: S("Bucket."), key: S("Object key."), content: S("Text content.") }, ["key", "content"]),
  },
  {
    name: "copy_object",
    description: "Copy (or move, with delete_source) an object. Needs approval.",
    inputSchema: obj(
      { bucket: S("Source bucket."), key: S("Source key."), dest_bucket: S("Destination bucket."), dest_key: S("Destination key."), delete_source: { type: "boolean" } },
      ["key", "dest_key"],
    ),
  },
  {
    name: "delete_object",
    description: "Delete one object. Needs approval.",
    inputSchema: obj({ bucket: S("Bucket."), key: S("Object key.") }, ["key"]),
  },
];

export function makeS3Toolset(getCtx: () => ObjContext): Toolset {
  return toolset(
    S3_TOOLS,
    (call) =>
      call.name === "put_text"
        ? write("writes an object")
        : call.name === "copy_object"
          ? write(call.input.delete_source ? "moves an object" : "copies an object")
          : call.name === "delete_object"
            ? write("deletes an object")
            : S3_TOOLS.some((t) => t.name === call.name)
              ? READ
              : write("unknown tool"),
    async (call) => {
      const ctx = getCtx();
      const bucket = str(call.input.bucket) || ctx.bucket;
      const needBucket = () => {
        if (!bucket) throw new Error("No bucket given.");
      };
      switch (call.name) {
        case "list_buckets":
          return (await api.s3ListBuckets(ctx.params)).map((b) => b.name).join("\n") || "(no buckets)";
        case "list_objects": {
          needBucket();
          const prefix = typeof call.input.prefix === "string" ? call.input.prefix : ctx.prefix;
          const max = Math.min(5000, num(call.input.max, 500));
          const out: string[] = [];
          let token: string | null = null;
          do {
            const r = await api.s3ListObjects(ctx.params, bucket, prefix, token);
            for (const e of r.entries)
              out.push(e.is_dir ? `${e.key}` : `${e.key}  ${fmtSize(e.size)}${e.modified ? `  ${new Date(e.modified).toISOString().slice(0, 16)}` : ""}`);
            token = r.next_token;
          } while (token && out.length < max);
          return (out.slice(0, max).join("\n") || "(empty)") + (token || out.length > max ? "\n… more" : "");
        }
        case "read_object": {
          needBucket();
          const r = await api.s3Preview(ctx.params, bucket, str(call.input.key));
          if (r.kind !== "text") return `Not a text object (${r.kind}, ${r.content_type}, ${fmtSize(r.size)}).`;
          return r.content + (r.truncated ? "\n… (truncated)" : "");
        }
        case "folder_size": {
          needBucket();
          let bytes = 0;
          let files = 0;
          const stack = [typeof call.input.prefix === "string" ? call.input.prefix : ctx.prefix];
          let pages = 0;
          while (stack.length && pages < 400) {
            const pre = stack.pop()!;
            let token: string | null = null;
            do {
              const r = await api.s3ListObjects(ctx.params, bucket, pre, token);
              pages++;
              for (const e of r.entries) {
                if (e.is_dir) stack.push(e.key);
                else {
                  bytes += e.size;
                  files++;
                }
              }
              token = r.next_token;
            } while (token && pages < 400);
          }
          return `${files} objects, ${fmtSize(bytes)}${pages >= 400 ? " (stopped after 400 pages — partial)" : ""}`;
        }
        case "put_text":
          needBucket();
          await api.s3PutText(ctx.params, bucket, str(call.input.key), String(call.input.content ?? ""));
          return "Written.";
        case "copy_object": {
          needBucket();
          const dest = str(call.input.dest_bucket) || bucket;
          await api.s3CopyObject(ctx.params, bucket, str(call.input.key), dest, str(call.input.dest_key), !!call.input.delete_source);
          return call.input.delete_source ? "Moved." : "Copied.";
        }
        case "delete_object":
          needBucket();
          await api.s3DeleteObject(ctx.params, bucket, str(call.input.key));
          return "Deleted.";
      }
      throw new Error(`Unknown tool: ${call.name}`);
    },
    () => getCtx().refresh?.()
  );
}

export function s3SystemPrompt(ctx: ObjContext): string {
  const open = ctx.bucket ? ` Open: \`${ctx.bucket}/${ctx.prefix}\`.` : "";
  return [
    "You are BalauDeck's built-in assistant, embedded in an S3-compatible object storage panel.",
    `The user is connected to \`${ctx.label}\`.${open} Help them find, inspect and organise objects.`,
    "",
    "Tools: list_buckets, list_objects(bucket, prefix), read_object(key), folder_size(prefix); put_text / copy_object / delete_object need approval.",
    "- S3 has no real folders: a prefix ending in / is listed as one.",
    ...COMMON,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

export interface FileContext {
  /** Reload the pane's view after the assistant changed something. */
  refresh?: () => void;
  sessionId: string;
  label: string;
  /** Directory the user is looking at. */
  cwd: string;
}

const join = (dir: string, name: string) => (name.startsWith("/") ? name : `${dir.replace(/\/+$/, "")}/${name}`);
const mode = (m: number) => (m & 0o777).toString(8).padStart(3, "0");

const SFTP_TOOLS: AiTool[] = [
  {
    name: "list_dir",
    description: "List a directory (name, size, modified, mode). Relative paths are from the current directory.",
    inputSchema: obj({ path: S("Directory (default: current).") }),
  },
  {
    name: "read_file",
    description: "Read a text file (first part of large files).",
    inputSchema: obj({ path: S("File path.") }, ["path"]),
  },
  {
    name: "find_large",
    description: "Walk a directory tree and list the largest files (stops after ~3000 entries).",
    inputSchema: obj({ path: S("Root directory (default: current)."), top: N("How many (default 20).") }),
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file. Needs approval.",
    inputSchema: obj({ path: S("File path."), content: S("Text content.") }, ["path", "content"]),
  },
  { name: "make_dir", description: "Create a directory. Needs approval.", inputSchema: obj({ path: S("Directory path.") }, ["path"]) },
  {
    name: "rename",
    description: "Rename or move a file/directory. Needs approval.",
    inputSchema: obj({ from: S("Current path."), to: S("New path.") }, ["from", "to"]),
  },
  {
    name: "delete",
    description: "Delete a file, or a directory with everything in it. Needs approval.",
    inputSchema: obj({ path: S("Path."), is_dir: { type: "boolean" } }, ["path"]),
  },
];

export function makeSftpToolset(getCtx: () => FileContext): Toolset {
  const WRITES: Record<string, string> = {
    write_file: "writes a file",
    make_dir: "creates a directory",
    rename: "renames / moves",
    delete: "deletes",
  };
  return toolset(
    SFTP_TOOLS,
    (call) =>
      WRITES[call.name]
        ? write(call.name === "delete" && call.input.is_dir ? "deletes a directory and everything in it" : WRITES[call.name])
        : SFTP_TOOLS.some((t) => t.name === call.name)
          ? READ
          : write("unknown tool"),
    async (call) => {
      const { sessionId: id, cwd } = getCtx();
      const at = (v: unknown) => join(cwd, str(v) || cwd);
      switch (call.name) {
        case "list_dir": {
          const dir = at(call.input.path);
          const list = await api.sftpList(id, dir);
          const rows = list
            .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name))
            .slice(0, 1000)
            .map(
              (e) =>
                `${e.is_dir ? "d" : "-"} ${mode(e.permissions)}  ${e.is_dir ? "".padStart(9) : fmtSize(e.size).padStart(9)}  ${e.mtime ? new Date(e.mtime * 1000).toISOString().slice(0, 16) : ""}  ${e.name}${e.is_dir ? "/" : ""}`,
            );
          return `${dir}\n${rows.join("\n") || "(empty)"}${list.length > 1000 ? "\n… more" : ""}`;
        }
        case "read_file": {
          const r = await api.sftpPreview(id, at(call.input.path));
          if (r.kind !== "text") return `Not a text file (${r.kind}, ${fmtSize(r.size)}).`;
          return r.content + (r.truncated ? "\n… (truncated)" : "");
        }
        case "find_large": {
          const root = at(call.input.path);
          const top = Math.min(100, num(call.input.top, 20));
          const files: { p: string; s: number }[] = [];
          const stack = [root];
          let seen = 0;
          while (stack.length && seen < 3000) {
            const dir = stack.pop()!;
            let list;
            try {
              list = await api.sftpList(id, dir);
            } catch {
              continue; // unreadable directory
            }
            for (const e of list) {
              seen++;
              const p = join(dir, e.name);
              if (e.is_dir) stack.push(p);
              else files.push({ p, s: e.size });
            }
          }
          files.sort((a, b) => b.s - a.s);
          return (
            files
              .slice(0, top)
              .map((f) => `${fmtSize(f.s).padStart(9)}  ${f.p}`)
              .join("\n") + (seen >= 3000 ? "\n(stopped after 3000 entries — partial)" : "")
          );
        }
        case "write_file":
          await api.sftpWriteText(id, at(call.input.path), String(call.input.content ?? ""));
          return "Written.";
        case "make_dir":
          await api.sftpMkdir(id, at(call.input.path));
          return "Created.";
        case "rename":
          await api.sftpRename(id, at(call.input.from), at(call.input.to));
          return "Renamed.";
        case "delete":
          await api.sftpRemove(id, at(call.input.path), !!call.input.is_dir);
          return "Deleted.";
      }
      throw new Error(`Unknown tool: ${call.name}`);
    },
    () => getCtx().refresh?.()
  );
}

export function sftpSystemPrompt(ctx: FileContext): string {
  return [
    "You are BalauDeck's built-in assistant, embedded in an SFTP file browser.",
    `The user is connected to \`${ctx.label}\`, looking at \`${ctx.cwd}\`. Help them find, read and organise files.`,
    "",
    "Tools: list_dir, read_file, find_large; write_file / make_dir / rename / delete need approval.",
    "- There's no shell here — only file operations. Relative paths are from the current directory.",
    "- Check with list_dir before deleting; say exactly which paths you'll delete.",
    ...COMMON,
  ].join("\n");
}

/** What a Redis / Mongo / S3 / SFTP pane tells App so it can host the chat. */
export type StoreAiCtx =
  | { kind: "redis"; ctx: KvContext }
  | { kind: "mongo"; ctx: DocContext }
  | { kind: "s3"; ctx: ObjContext }
  | { kind: "sftp"; ctx: FileContext };
