import { invoke } from "@tauri-apps/api/core";
import type {
  ConnKind,
  DbProfile,
  Folder,
  ProfileStore,
  QueryResult,
  SftpEntry,
  SftpProfile,
  SshProfile,
  TunnelInfo,
  TunnelProfile,
} from "./types";

export const api = {
  profilesLoad: () => invoke<ProfileStore>("profiles_load"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),

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

  sftpProfileSave: (
    profile: SftpProfile,
    password?: string | null,
    key?: string | null,
    passphrase?: string | null,
  ) =>
    invoke<SftpProfile>("sftp_profile_save", {
      profile,
      password: password ?? null,
      key: key ?? null,
      passphrase: passphrase ?? null,
    }),
  sftpProfileDelete: (id: string) => invoke<void>("sftp_profile_delete", { id }),

  tunnelProfileSave: (
    profile: TunnelProfile,
    password?: string | null,
    key?: string | null,
    passphrase?: string | null,
  ) =>
    invoke<TunnelProfile>("tunnel_profile_save", {
      profile,
      password: password ?? null,
      key: key ?? null,
      passphrase: passphrase ?? null,
    }),
  tunnelProfileDelete: (id: string) => invoke<void>("tunnel_profile_delete", { id }),

  folderCreate: (name: string) => invoke<Folder>("folder_create", { name, kind: "all" }),
  folderRename: (id: string, name: string) => invoke<void>("folder_rename", { id, name }),
  folderDelete: (id: string) => invoke<void>("folder_delete", { id }),
  folderMove: (id: string, parentId: string | null, beforeId: string | null) =>
    invoke<void>("folder_move", { id, parentId, beforeId }),
  profileSetFolder: (kind: ConnKind, id: string, folderId: string | null) =>
    invoke<void>("profile_set_folder", { kind, id, folderId }),

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
    key?: string | null;
    passphrase?: string | null;
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
    key?: string | null;
    passphrase?: string | null;
    profile_id?: string | null;
    remote_host: string;
    remote_port: number;
    local_port?: number;
  }) => invoke<TunnelInfo>("tunnel_start", { params }),
  tunnelStop: (id: string) => invoke<void>("tunnel_stop", { id }),
  tunnelList: () => invoke<TunnelInfo[]>("tunnel_list"),
};
