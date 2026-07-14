export type SshAuth = "password" | "key";

export type ConnKind = "ssh" | "sftp" | "tunnel" | "db";

/**
 * A distinct accent colour per connection kind, so the glyphs in the sidebar
 * list and the "New …" menus are easy to tell apart at a glance. Hues are
 * spread around the wheel (teal / orange / purple / blue). `connColor` returns
 * `undefined` for non-connection panes (local, note) so they keep the default.
 */
export const CONN_COLOR: Record<ConnKind, string> = {
  ssh: "#16a34a", // green
  sftp: "#ef8a45", // orange
  tunnel: "#9333ea", // purple
  db: "#2f6fed", // blue
};

export function connColor(kind: string): string | undefined {
  return (CONN_COLOR as Record<string, string>)[kind];
}

export interface Folder {
  id: string;
  name: string;
  /** Legacy section tag; the sidebar now shows all folders in one tree. */
  kind: string;
  parent_id?: string | null;
}

/**
 * Folders in depth-first tree order with their depth, for hierarchical
 * dropdowns — children render indented under their parent, so same-named
 * folders under different parents are distinguishable. Orphans (missing or
 * cyclic parents) are appended as roots so every folder always appears.
 */
export function folderTree(folders: Folder[]): { folder: Folder; depth: number }[] {
  const ids = new Set(folders.map((f) => f.id));
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const p = f.parent_id && ids.has(f.parent_id) ? f.parent_id : null;
    byParent.set(p, [...(byParent.get(p) ?? []), f]);
  }
  const out: { folder: Folder; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const f of byParent.get(parent) ?? []) {
      if (seen.has(f.id)) continue; // cycle guard
      seen.add(f.id);
      out.push({ folder: f, depth });
      visit(f.id, depth + 1);
    }
  };
  visit(null, 0);
  // Anything unreached (a parent cycle) still gets listed, flat at the root.
  for (const f of folders) {
    if (!seen.has(f.id)) out.push({ folder: f, depth: 0 });
  }
  return out;
}

/** Inline (manual) jump-host fields shared by SSH/SFTP/Tunnel profiles. */
export interface JumpFields {
  jump_profile_id?: string | null;
  jump_host?: string | null;
  jump_port?: number | null;
  jump_user?: string | null;
  jump_auth?: SshAuth | null;
  /** "nested" = run ssh on the jump host (SSH only); else port-forward (ProxyJump). */
  jump_mode?: string | null;
}

export interface SshProfile extends JumpFields {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  folder_id?: string | null;
  /** Run the shell inside `tmux new-session -A` so it survives drops. */
  tmux?: boolean;
  tmux_session?: string | null;
  /** Enable tmux mouse mode on attach so wheel scroll pages the history. */
  tmux_mouse?: boolean;
  /** Add `-v` to the nested-jump ssh command for verbose diagnostics. */
  verbose?: boolean;
  /** Command sent once the shell is ready (e.g. `sudo su -`); its escalation
   *  password, if any, is stored in the keychain and auto-sent at the prompt. */
  after_login?: string | null;
}

export type DbEngine =
  | "mysql"
  | "mariadb"
  | "postgres"
  | "mssql"
  | "sqlite"
  | "mongodb"
  | "redis"
  | "s3";

/** UI/behaviour metadata per engine — drives the ProfileEditor field layout,
 *  the sidebar badge/colour, and which panel a connection opens in. */
export const DB_ENGINES: Record<
  DbEngine,
  {
    label: string;
    /** Short badge shown next to the profile name in the sidebar. */
    badge: string;
    defaultPort: number;
    /** Which panel family renders it: SQL grid, Mongo docs, Redis keys, or S3 objects. */
    family: "sql" | "mongo" | "redis" | "s3";
    needsUser: boolean;
    needsDatabase: boolean;
    /** SQLite: connect to a local file instead of host/port. */
    fileBased: boolean;
    color: string;
  }
> = {
  mysql:    { label: "MySQL",      badge: "MySQL",  defaultPort: 3306,  family: "sql",   needsUser: true,  needsDatabase: false, fileBased: false, color: "#2f6fed" },
  mariadb:  { label: "MariaDB",    badge: "Maria",  defaultPort: 3306,  family: "sql",   needsUser: true,  needsDatabase: false, fileBased: false, color: "#2f6fed" },
  postgres: { label: "PostgreSQL", badge: "PG",     defaultPort: 5432,  family: "sql",   needsUser: true,  needsDatabase: true,  fileBased: false, color: "#3b82f6" },
  mssql:    { label: "SQL Server", badge: "MSSQL",  defaultPort: 1433,  family: "sql",   needsUser: true,  needsDatabase: true,  fileBased: false, color: "#a855f7" },
  sqlite:   { label: "SQLite",     badge: "SQLite", defaultPort: 0,     family: "sql",   needsUser: false, needsDatabase: false, fileBased: true,  color: "#64748b" },
  mongodb:  { label: "MongoDB",    badge: "Mongo",  defaultPort: 27017, family: "mongo", needsUser: true,  needsDatabase: false, fileBased: false, color: "#22c55e" },
  redis:    { label: "Redis",      badge: "Redis",  defaultPort: 6379,  family: "redis", needsUser: false, needsDatabase: false, fileBased: false, color: "#ef4444" },
  s3:       { label: "Object Storage (S3)", badge: "S3", defaultPort: 9000, family: "s3", needsUser: true, needsDatabase: false, fileBased: false, color: "#d97706" },
};

export interface DbProfile {
  id: string;
  name: string;
  /** Defaults to "mysql" on profiles saved before multi-engine support. */
  engine: DbEngine;
  host: string;
  port: number;
  user: string;
  database: string | null;
  /** SQLite file path (engine === "sqlite"). */
  file?: string | null;
  /** S3 only: signing region (default "us-east-1"). */
  region?: string | null;
  /** S3 only: path-style addressing — keep on for MinIO/RustFS/IP endpoints. */
  path_style?: boolean | null;
  /** S3 only: connect over HTTPS instead of plain HTTP. */
  tls?: boolean | null;
  via_ssh_profile_id: string | null;
  folder_id?: string | null;
}

export interface SftpProfile extends JumpFields {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  folder_id?: string | null;
  /** Optional elevated SFTP server command, e.g. `sudo /usr/lib/openssh/sftp-server`. */
  sftp_command?: string | null;
}

export interface TunnelProfile extends JumpFields {
  id: string;
  name: string;
  ssh_profile_id?: string | null;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  /** Forwarding mode: "local" (-L, default) | "dynamic" (-D SOCKS) | "remote" (-R). */
  mode?: string;
  remote_host: string;
  remote_port: number;
  local_port?: number | null;
  folder_id?: string | null;
}

/** Connect-param shape for a jump host (saved profile or manual entry). */
export interface JumpHostParam {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  password?: string | null;
  key?: string | null;
  passphrase?: string | null;
  profile_id?: string | null;
  /** Run ssh on the jump to reach the target, instead of a direct-tcpip forward. */
  nested?: boolean;
}

/**
 * Build the `jump` connect param for a connection. A saved jump profile wins;
 * otherwise an inline (manual) jump is used, whose secrets live in the keychain
 * under the owning profile's synthetic `<id>~jump` account.
 */
export function resolveJump(
  source: (JumpFields & { id?: string }) | null | undefined,
  sshProfiles: SshProfile[],
): JumpHostParam | undefined {
  if (!source) return undefined;
  const nested = source.jump_mode === "nested";
  if (source.jump_profile_id) {
    const j = sshProfiles.find((s) => s.id === source.jump_profile_id);
    if (j) return { host: j.host, port: j.port, user: j.user, auth: j.auth, profile_id: j.id, nested };
  }
  if (source.jump_host && source.jump_host.trim()) {
    return {
      host: source.jump_host,
      port: source.jump_port ?? 22,
      user: source.jump_user ?? "",
      auth: source.jump_auth ?? "password",
      profile_id: source.id ? `${source.id}~jump` : null,
      nested,
    };
  }
  return undefined;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  db_profile_id?: string | null;
  database?: string | null;
}

/** A free-form Markdown note shown in the sidebar. */
export interface Note {
  id: string;
  title: string;
  body: string;
  /** Epoch milliseconds of the last edit; used to sort most-recent first. */
  updated_at?: number;
}

export interface Routine {
  name: string;
  kind: string;
}

export interface SchemaObjects {
  tables: string[];
  views: string[];
  routines: Routine[];
}

export interface ProfileStore {
  ssh: SshProfile[];
  db: DbProfile[];
  sftp: SftpProfile[];
  tunnel: TunnelProfile[];
  folders: Folder[];
  queries: SavedQuery[];
  notes: Note[];
}

export interface ImportSummary {
  ssh: number;
  db: number;
  sftp: number;
  tunnel: number;
  folders: number;
  queries: number;
  notes: number;
  secrets: number;
}

/** Google Drive sync connection + status (desktop only for now). */
export interface GdriveStatus {
  /** Build ships a real OAuth client id (not the placeholder). */
  configured: boolean;
  /** A refresh token is stored — the app is linked to a Google account. */
  connected: boolean;
  /** Signed-in account email, if known. */
  email: string | null;
  /** Auto-sync (debounced push + throttled pull) is on. */
  auto_sync: boolean;
  /** A sync passphrase is cached so auto-sync can run unattended. */
  has_passphrase: boolean;
  /** Epoch-ms of the last successful push (0 = never). */
  last_push_ms: number;
  /** Epoch-ms of the last successful pull (0 = never). */
  last_pull_ms: number;
}

export interface SftpEntry {
  name: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  permissions: number;
}

export interface S3Bucket {
  name: string;
  /** Creation time in epoch milliseconds, when the store reports one. */
  created: number | null;
}

/** One row in the object browser — a "folder" (common prefix) or an object. */
export interface S3Entry {
  /** Full key (objects) or prefix ending in "/" (folders). */
  key: string;
  /** Display name: the last path segment of the key. */
  name: string;
  is_dir: boolean;
  size: number;
  /** Last-modified in epoch milliseconds; null for folders. */
  modified: number | null;
}

export interface S3Listing {
  entries: S3Entry[];
  /** Continuation token for the next page; null when this is the last page. */
  next_token: string | null;
}

/** In-panel object preview; `content` is text or base64 depending on `kind`. */
export interface S3Preview {
  kind: "text" | "image" | "pdf" | "binary" | "too-large";
  content: string;
  content_type: string;
  size: number;
  truncated: boolean;
}

export interface TunnelInfo {
  id: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
  mode: string;
}

export interface QueryResult {
  columns: string[];
  /** Per-column flag: binary columns the grid must not edit as text. */
  binary_cols: boolean[];
  rows: (string | null)[][];
  rows_affected: number;
  elapsed_ms: number;
  truncated: boolean;
  /** When every column is a plain, unaliased column of one base table, these
   *  name it so a hand-written SELECT's grid can still be edited. */
  source_db?: string | null;
  source_table?: string | null;
}

/** Progress messages streamed from db_dump over a Tauri channel. */
export type DumpProgress =
  | { kind: "start"; tables: number }
  | { kind: "table"; name: string; index: number; total: number; rows: number }
  | { kind: "rows"; written: number; total: number }
  | { kind: "table_done"; name: string; rows: number }
  | { kind: "done"; tables: number; rows: number }
  | { kind: "cancelled"; tables: number; rows: number };

/** Progress messages streamed from db_import_file over a Tauri channel. */
export type ImportProgress =
  | { kind: "start"; total: number }
  | { kind: "progress"; executed: number; failed: number; total: number }
  | { kind: "stmt_error"; index: number; error: string }
  | { kind: "done"; executed: number; failed: number }
  | { kind: "cancelled"; executed: number; failed: number }
  | { kind: "failed"; executed: number; error: string };

export function emptySshProfile(): SshProfile {
  return { id: "", name: "", host: "", port: 22, user: "", auth: "password" };
}

export function emptyDbProfile(engine: DbEngine = "mysql"): DbProfile {
  const meta = DB_ENGINES[engine];
  return {
    id: "",
    name: "",
    engine,
    host: meta.fileBased ? "" : "127.0.0.1",
    port: meta.defaultPort,
    user: engine === "mysql" || engine === "mariadb" ? "root" : engine === "postgres" ? "postgres" : engine === "mssql" ? "sa" : "",
    database: null,
    file: null,
    region: engine === "s3" ? "us-east-1" : null,
    path_style: engine === "s3" ? true : null,
    tls: engine === "s3" ? false : null,
    via_ssh_profile_id: null,
  };
}

export function emptySftpProfile(): SftpProfile {
  return { id: "", name: "", host: "", port: 22, user: "", auth: "password" };
}

export function emptyTunnelProfile(): TunnelProfile {
  return {
    id: "",
    name: "",
    host: "",
    port: 22,
    user: "",
    auth: "password",
    mode: "local",
    remote_host: "127.0.0.1",
    remote_port: 3306,
    local_port: null,
  };
}
