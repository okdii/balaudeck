import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ConnKind,
  DbProfile,
  DumpProgress,
  Folder,
  ImportProgress,
  ImportSummary,
  JumpHostParam,
  Note,
  ProfileStore,
  QueryResult,
  SavedQuery,
  SchemaObjects,
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
    jump?: { password?: string | null; key?: string | null; passphrase?: string | null },
  ) =>
    invoke<SshProfile>("ssh_profile_save", {
      profile,
      password: password ?? null,
      key: key ?? null,
      passphrase: passphrase ?? null,
      jumpPassword: jump?.password ?? null,
      jumpKey: jump?.key ?? null,
      jumpPassphrase: jump?.passphrase ?? null,
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
    jump?: { password?: string | null; key?: string | null; passphrase?: string | null },
    copySecretFrom?: string | null,
    sudoPassword?: string | null,
  ) =>
    invoke<SftpProfile>("sftp_profile_save", {
      profile,
      password: password ?? null,
      key: key ?? null,
      passphrase: passphrase ?? null,
      jumpPassword: jump?.password ?? null,
      jumpKey: jump?.key ?? null,
      jumpPassphrase: jump?.passphrase ?? null,
      copySecretFrom: copySecretFrom ?? null,
      sudoPassword: sudoPassword ?? null,
    }),
  sftpProfileDelete: (id: string) => invoke<void>("sftp_profile_delete", { id }),

  tunnelProfileSave: (
    profile: TunnelProfile,
    password?: string | null,
    key?: string | null,
    passphrase?: string | null,
    jump?: { password?: string | null; key?: string | null; passphrase?: string | null },
  ) =>
    invoke<TunnelProfile>("tunnel_profile_save", {
      profile,
      password: password ?? null,
      key: key ?? null,
      passphrase: passphrase ?? null,
      jumpPassword: jump?.password ?? null,
      jumpKey: jump?.key ?? null,
      jumpPassphrase: jump?.passphrase ?? null,
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
    maxRows?: number | null,
  ) => invoke<QueryResult>("db_query", { params, sql, maxRows: maxRows ?? null }),

  dbExecBatch: (
    params: {
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      profile_id?: string | null;
    },
    statements: { sql: string; values: (string | null)[] }[],
  ) => invoke<number[]>("db_exec_batch", { params, statements }),

  dbDisconnect: (params: { host: string; port: number; user: string; database?: string | null }) =>
    invoke<void>("db_disconnect", { params }),

  dbDump: (
    params: {
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      profile_id?: string | null;
    },
    database: string,
    table: string | null,
    path: string,
    exportId: string,
    onProgress: Channel<DumpProgress>,
  ) => invoke<number>("db_dump", { params, database, table, path, exportId, onProgress }),

  dbJobControl: (jobId: string, action: "pause" | "resume" | "cancel") =>
    invoke<void>("db_job_control", { jobId, action }),

  dbSchemaObjects: (
    params: {
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      profile_id?: string | null;
    },
    database: string,
  ) => invoke<SchemaObjects>("db_schema_objects", { params, database }),

  querySave: (query: SavedQuery) => invoke<SavedQuery>("query_save", { query }),
  queryDelete: (id: string) => invoke<void>("query_delete", { id }),

  noteSave: (note: Note) => invoke<Note>("note_save", { note }),
  noteDelete: (id: string) => invoke<void>("note_delete", { id }),

  dbImportFile: (
    params: {
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      profile_id?: string | null;
    },
    path: string,
    database: string | null,
    importId: string,
    continueOnError: boolean,
    onProgress: Channel<ImportProgress>,
  ) =>
    invoke<{ executed: number; failed: number; error: string | null }>("db_import_file", {
      params,
      path,
      database,
      importId,
      continueOnError,
      onProgress,
    }),

  sftpConnect: (params: {
    host: string;
    port: number;
    user: string;
    auth?: string;
    password?: string | null;
    key?: string | null;
    passphrase?: string | null;
    profile_id?: string | null;
    jump?: JumpHostParam;
    sftp_command?: string | null;
  }) => invoke<string>("sftp_connect", { params }),
  sftpHome: (id: string) => invoke<string>("sftp_home", { id }),
  sftpList: (id: string, path: string) => invoke<SftpEntry[]>("sftp_list", { id, path }),
  sftpDownload: (id: string, remotePath: string, localPath: string) =>
    invoke<void>("sftp_download", { id, remotePath, localPath }),
  sftpUpload: (id: string, localPath: string, remotePath: string) =>
    invoke<void>("sftp_upload", { id, localPath, remotePath }),
  sftpMkdir: (id: string, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  sftpRename: (id: string, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  sftpChmod: (id: string, path: string, mode: number) =>
    invoke<void>("sftp_chmod", { id, path, mode }),
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
    jump?: JumpHostParam;
    remote_host: string;
    remote_port: number;
    local_port?: number;
  }) => invoke<TunnelInfo>("tunnel_start", { params }),
  tunnelStop: (id: string) => invoke<void>("tunnel_stop", { id }),
  tunnelList: () => invoke<TunnelInfo[]>("tunnel_list"),

  connectionsExport: (passphrase: string) =>
    invoke<string>("connections_export", { passphrase }),
  connectionsImport: (passphrase: string, bundle: string) =>
    invoke<ImportSummary>("connections_import", { passphrase, bundle }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
  currentPlatform: () => invoke<string>("current_platform"),
};
