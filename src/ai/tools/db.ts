// SQL database toolset: the agent runs queries + introspects schema on the
// DbPanel's live connection. Read-only queries auto-run; DML/DDL is approval-
// gated (see classify.ts → classifySql, and agentLoop.ts).

import { api, type DbConnParams } from "../../api";
import type { QueryResult } from "../../types";
import type { AiTool } from "../types";
import type { Toolset, ToolCall, ToolRisk, ToolRunResult } from "../tool";
import { classifySql } from "../classify";

/** Live connection context the DbPanel supplies (read at call time). */
export interface DbToolContext {
  params: DbConnParams;
  /** Currently browsed database/schema (may be ""). */
  database: string;
  /** Engine id (mysql, mariadb, postgres, mssql, sqlite). */
  engine: string;
  /** Human label for the system prompt (e.g. user@host or the profile name). */
  label: string;
}

const OUT_CAP = 16000;
const cap = (s: string) => (s.length > OUT_CAP ? s.slice(0, OUT_CAP) + "\n… (truncated)" : s);

const TOOLS: AiTool[] = [
  {
    name: "run_sql",
    description:
      "Run a single SQL statement on the user's connected database and return the result. " +
      "Read-only queries (SELECT/SHOW/DESCRIBE/EXPLAIN) run automatically; statements that change data or schema " +
      "(INSERT/UPDATE/DELETE, CREATE/ALTER/DROP, GRANT/REVOKE, …) require the user's approval, so explain what you " +
      "intend and why before proposing them. One statement per call; write dialect-correct SQL for the engine.",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "A single SQL statement." } },
      required: ["sql"],
      additionalProperties: false,
    },
  },
  {
    name: "list_databases",
    description: "List the databases/schemas available on this connection.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tables",
    description: "List the tables and views in a database (defaults to the current one).",
    inputSchema: {
      type: "object",
      properties: { database: { type: "string", description: "Database/schema name." } },
      additionalProperties: false,
    },
  },
  {
    name: "describe_table",
    description: "Show a table's columns, foreign keys, and indexes.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name." },
        database: { type: "string", description: "Database/schema (defaults to the current one)." },
      },
      required: ["table"],
      additionalProperties: false,
    },
  },
];

export function dbSystemPrompt(ctx: DbToolContext): string {
  const db = ctx.database ? `\`${ctx.database}\`` : "(none selected)";
  return [
    "You are BalauDeck's built-in assistant, embedded in a SQL database panel.",
    `The user is connected to \`${ctx.label}\` (engine ${ctx.engine}); current database ${db}. Help them explore and query the database.`,
    "",
    "Tools: run_sql (one statement per call — read-only queries auto-run, changes need approval), list_databases, list_tables(database?), describe_table(table, database?).",
    "- Prefer the introspection tools over guessing schema; check columns before writing a query.",
    "- Write dialect-correct SQL for this engine. For a mutation, explain it first and propose the smallest safe statement (e.g. a SELECT of the rows first, then the UPDATE with a precise WHERE).",
    "- Be concise. Summarise findings and end with a short, direct answer.",
  ].join("\n");
}

function formatResult(r: QueryResult, maxRows = 100): string {
  if (!r.columns.length) {
    return `OK — ${r.rows_affected} row(s) affected (${r.elapsed_ms} ms).`;
  }
  const rows = r.rows.slice(0, maxRows);
  const cell = (c: string | null) =>
    c === null ? "NULL" : (c.length > 200 ? c.slice(0, 200) + "…" : c).replace(/\s*\n\s*/g, " ");
  const lines = [
    r.columns.join(" | "),
    r.columns.map(() => "---").join(" | "),
    ...rows.map((row) => row.map(cell).join(" | ")),
  ];
  if (r.rows.length > maxRows) lines.push(`… (${maxRows} of ${r.rows.length} rows shown)`);
  else if (r.truncated) lines.push("… (result truncated by the server)");
  else lines.push(`(${r.rows.length} row${r.rows.length === 1 ? "" : "s"}, ${r.elapsed_ms} ms)`);
  return lines.join("\n");
}

/** Build the SQL toolset bound to a getter for the panel's live connection. */
export function makeDbToolset(getCtx: () => DbToolContext): Toolset {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    tools: TOOLS,
    classify(call: ToolCall): ToolRisk {
      if (call.name === "run_sql") return classifySql(str(call.input.sql));
      if (call.name === "list_databases" || call.name === "list_tables" || call.name === "describe_table") {
        return { level: "read" };
      }
      return { level: "write", reason: "unknown tool" };
    },
    async execute(call: ToolCall): Promise<ToolRunResult> {
      const ctx = getCtx();
      try {
        switch (call.name) {
          case "run_sql": {
            const sql = str(call.input.sql);
            if (!sql) return { output: "Empty SQL.", isError: true };
            const params = { ...ctx.params, database: ctx.database || ctx.params.database || null };
            const r = await api.dbQuery(params, sql, 500);
            return { output: cap(formatResult(r)), isError: false };
          }
          case "list_databases": {
            const dbs = await api.dbListDatabases(ctx.params);
            return { output: dbs.length ? dbs.join("\n") : "(no databases)", isError: false };
          }
          case "list_tables": {
            const db = str(call.input.database) || ctx.database;
            if (!db) return { output: "No database selected.", isError: true };
            const o = await api.dbSchemaObjects(ctx.params, db);
            const parts: string[] = [];
            if (o.tables.length) parts.push("Tables:\n" + o.tables.join("\n"));
            if (o.views.length) parts.push("Views:\n" + o.views.join("\n"));
            return { output: cap(parts.join("\n\n")) || "(no tables)", isError: false };
          }
          case "describe_table": {
            const table = str(call.input.table);
            if (!table) return { output: "No table given.", isError: true };
            const db = str(call.input.database) || ctx.database;
            if (!db) return { output: "No database selected.", isError: true };
            const t = await api.dbTableSchema(ctx.params, db, table);
            const cols = t.columns
              .map(
                (c) =>
                  `  ${c.name} ${c.dataType}${c.length ? `(${c.length})` : ""}` +
                  `${c.nullable ? "" : " NOT NULL"}${c.pk ? " PK" : ""}` +
                  `${c.autoIncrement ? " AUTO_INCREMENT" : ""}${c.default ? ` DEFAULT ${c.default}` : ""}`,
              )
              .join("\n");
            const fks = t.foreignKeys
              .map((f) => `  ${f.column} → ${f.refTable}.${f.refColumn}`)
              .join("\n");
            const idx = t.indexes
              .map((i) => `  ${i.unique ? "UNIQUE " : ""}${i.name} (${i.columns.join(", ")})`)
              .join("\n");
            const out = [`Table ${db}.${table}`, "Columns:", cols];
            if (fks) out.push("Foreign keys:", fks);
            if (idx) out.push("Indexes:", idx);
            return { output: cap(out.join("\n")), isError: false };
          }
          default:
            return { output: `Unknown tool: ${call.name}`, isError: true };
        }
      } catch (e) {
        return { output: String(e), isError: true };
      }
    },
  };
}
