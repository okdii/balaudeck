export type SshAuth = "password" | "key";

export type ConnKind = "ssh" | "sftp" | "tunnel" | "db";

export interface Folder {
  id: string;
  name: string;
  /** Legacy section tag; the sidebar now shows all folders in one tree. */
  kind: string;
  parent_id?: string | null;
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
  /** Add `-v` to the nested-jump ssh command for verbose diagnostics. */
  verbose?: boolean;
}

export interface DbProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string | null;
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
}

export interface ImportSummary {
  ssh: number;
  db: number;
  sftp: number;
  tunnel: number;
  folders: number;
  queries: number;
  secrets: number;
}

export interface SftpEntry {
  name: string;
  is_dir: boolean;
  size: number;
  mtime: number;
  permissions: number;
}

export interface TunnelInfo {
  id: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
}

export interface QueryResult {
  columns: string[];
  /** Per-column flag: binary columns the grid must not edit as text. */
  binary_cols: boolean[];
  rows: (string | null)[][];
  rows_affected: number;
  elapsed_ms: number;
  truncated: boolean;
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

export function emptyDbProfile(): DbProfile {
  return {
    id: "",
    name: "",
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    database: null,
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
    remote_host: "127.0.0.1",
    remote_port: 3306,
    local_port: null,
  };
}
