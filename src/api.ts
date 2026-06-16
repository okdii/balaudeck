import { invoke } from "@tauri-apps/api/core";
import type {
  DbProfile,
  ProfileStore,
  QueryResult,
  SftpEntry,
  SshProfile,
  TunnelInfo,
} from "./types";

export const api = {
  profilesLoad: () => invoke<ProfileStore>("profiles_load"),

  sshProfileSave: (
    profile: SshProfile,
    password?: string | null,
    key?: string | null,
    passphrase?: string | null,
  ) =>
    invoke<SshProfile>("ssh_profile_save", {
      profile,
      password: password ?? null,
      key: key ?? null,
      passphrase: passphrase ?? null,
    }),
  sshProfileDelete: (id: string) => invoke<void>("ssh_profile_delete", { id }),

  dbProfileSave: (profile: DbProfile, password?: string | null) =>
    invoke<DbProfile>("db_profile_save", { profile, password: password ?? null }),
  dbProfileDelete: (id: string) => invoke<void>("db_profile_delete", { id }),

  dbQuery: (
    params: {
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      profile_id?: string | null;
    },
    sql: string,
  ) => invoke<QueryResult>("db_query", { params, sql }),

  sftpConnect: (params: {
    host: string;
    port: number;
    user: string;
    auth?: string;
    password?: string | null;
    profile_id?: string | null;
  }) => invoke<string>("sftp_connect", { params }),
  sftpHome: (id: string) => invoke<string>("sftp_home", { id }),
  sftpList: (id: string, path: string) => invoke<SftpEntry[]>("sftp_list", { id, path }),
  sftpDownload: (id: string, remotePath: string, localPath: string) =>
    invoke<void>("sftp_download", { id, remotePath, localPath }),
  sftpUpload: (id: string, localPath: string, remotePath: string) =>
    invoke<void>("sftp_upload", { id, localPath, remotePath }),
  sftpMkdir: (id: string, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  sftpRename: (id: string, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  sftpRemove: (id: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_remove", { id, path, isDir }),
  sftpClose: (id: string) => invoke<void>("sftp_close", { id }),

  tunnelStart: (params: {
    host: string;
    port: number;
    user: string;
    auth?: string;
    password?: string | null;
    profile_id?: string | null;
    remote_host: string;
    remote_port: number;
    local_port?: number;
  }) => invoke<TunnelInfo>("tunnel_start", { params }),
  tunnelStop: (id: string) => invoke<void>("tunnel_stop", { id }),
  tunnelList: () => invoke<TunnelInfo[]>("tunnel_list"),
};
