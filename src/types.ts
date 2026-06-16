export type SshAuth = "password" | "key";

export interface SshProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
}

export interface DbProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string | null;
  via_ssh_profile_id: string | null;
}

export interface ProfileStore {
  ssh: SshProfile[];
  db: DbProfile[];
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
  rows: (string | null)[][];
  rows_affected: number;
  elapsed_ms: number;
}

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
