import { invoke, Channel } from "@tauri-apps/api/core";
import type { AiCompleteReq, AiEvent, AiProvider, AiTurn } from "./ai/types";
import type { TableSchemaInfo } from "./ddl";
import type {
  ConnKind,
  DbProfile,
  DbUser,
  DumpProgress,
  UserDetail,
  Folder,
  GdriveStatus,
  ImportProgress,
  ImportSummary,
  JumpHostParam,
  Note,
  ProfileStore,
  QueryResult,
  S3Bucket,
  S3Listing,
  S3Preview,
  SavedQuery,
  SchemaObjects,
  SftpEntry,
  SftpProfile,
  SshProfile,
  TunnelInfo,
  TunnelProfile,
} from "./types";

/** Connection params sent to every DB/Mongo/Redis/S3 command. */
export type DbConnParams = {
  engine?: string;
  host: string;
  port: number;
  user: string;
  password?: string | null;
  database?: string | null;
  file?: string | null;
  profile_id?: string | null;
  /** S3 only: signing region (default "us-east-1"). */
  region?: string | null;
  /** S3 only: path-style addressing — keep on for MinIO/RustFS/IP endpoints. */
  path_style?: boolean | null;
  /** S3 only: connect over HTTPS instead of plain HTTP. */
  tls?: boolean | null;
};

/** Optional S3 destination for `dbDump` — the finished dump is uploaded to
 *  `bucket`/`key` over this S3 connection instead of staying at the local
 *  `path`. With `transfer_job_id` set, the upload streams `transfer://progress`
 *  events (see transfers.ts) and honors transferCancel. */
export type DumpS3Target = {
  /** The S3 connection (engine "s3"). */
  params: DbConnParams;
  bucket: string;
  key: string;
  transfer_job_id?: string | null;
};

export const api = {
  profilesLoad: () => invoke<ProfileStore>("profiles_load"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),

  sshProfileSave: (
    profile: SshProfile,
    password?: string | null,
    key?: string | null,
    passphrase?: string | null,
    jump?: { password?: string | null; key?: string | null; passphrase?: string | null },
    escalatePassword?: string | null,
  ) =>
    invoke<SshProfile>("ssh_profile_save", {
      profile,
      password: password ?? null,
      key: key ?? null,
      passphrase: passphrase ?? null,
      jumpPassword: jump?.password ?? null,
      jumpKey: jump?.key ?? null,
      jumpPassphrase: jump?.passphrase ?? null,
      escalatePassword: escalatePassword ?? null,
    }),
  sshProfileDelete: (id: string) => invoke<void>("ssh_profile_delete", { id }),
  secretExists: (kind: string, id: string, slot: string) =>
    invoke<boolean>("secret_exists", { kind, id, slot }),

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
  profileDuplicate: (kind: ConnKind, id: string) =>
    invoke<ProfileStore>("profile_duplicate", { kind, id }),

  dbQuery: (
    params: {
      engine?: string;
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      file?: string | null;
      profile_id?: string | null;
    },
    sql: string,
    maxRows?: number | null,
  ) => invoke<QueryResult>("db_query", { params, sql, maxRows: maxRows ?? null }),

  dbExecBatch: (
    params: {
      engine?: string;
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      file?: string | null;
      profile_id?: string | null;
    },
    statements: { sql: string; values: (string | null)[] }[],
  ) => invoke<number[]>("db_exec_batch", { params, statements }),

  // Manual transactions (MySQL/MariaDB): pin a connection across statements.
  // The client owns `sessionId` (a UUID) and passes it to every follow-up call.
  dbTxBegin: (params: DbConnParams, sessionId: string) =>
    invoke<void>("db_tx_begin", { params, sessionId }),
  dbTxExec: (sessionId: string, sql: string, maxRows?: number | null) =>
    invoke<QueryResult>("db_tx_exec", { sessionId, sql, maxRows: maxRows ?? null }),
  dbTxCommit: (sessionId: string) => invoke<void>("db_tx_commit", { sessionId }),
  dbTxRollback: (sessionId: string) => invoke<void>("db_tx_rollback", { sessionId }),

  dbDisconnect: (params: {
    engine?: string;
    host: string;
    port: number;
    user: string;
    database?: string | null;
    file?: string | null;
  }) => invoke<void>("db_disconnect", { params }),

  /** Engine-aware list of databases (replaces the frontend's SHOW DATABASES). */
  dbListDatabases: (params: DbConnParams) =>
    invoke<string[]>("db_list_databases", { params }),

  /** Engine-aware primary-key columns of a table (enables the grid row-editor). */
  dbPrimaryKey: (params: DbConnParams, database: string, table: string) =>
    invoke<string[]>("db_primary_key", { params, database, table }),

  /** Engine-aware outgoing foreign keys of a table (powers grid FK click-through).
   *  Each entry: local `column` -> (`refTable`, `refColumn`). */
  dbForeignKeys: (params: DbConnParams, database: string, table: string) =>
    invoke<{ column: string; refTable: string; refColumn: string }[]>("db_foreign_keys", {
      params,
      database,
      table,
    }),

  /** Run designer DDL statements (CREATE/ALTER/DROP, incl. SQLite rebuild) in one
   *  transaction against `database`. Engine-aware on the backend. */
  dbExecDdl: (params: DbConnParams, database: string, statements: string[]) =>
    invoke<void>("db_exec_ddl", { params, database, statements }),

  /** Introspect an existing table's columns/FKs/indexes (drives the designer's
   *  Design mode + Show DDL). Engine-aware on the backend. */
  dbTableSchema: (params: DbConnParams, database: string, table: string) =>
    invoke<TableSchemaInfo>("db_table_schema", { params, database, table }),

  /** User-management: list accounts/roles, engine-aware. */
  dbListUsers: (params: DbConnParams) => invoke<DbUser[]>("db_list_users", { params }),
  /** One account's attributes + raw grants + memberships. */
  dbUserDetail: (params: DbConnParams, user: string, host: string) =>
    invoke<UserDetail>("db_user_detail", { params, user, host }),
  /** Run account-management statements (CREATE/ALTER/DROP USER, GRANT/REVOKE). */
  dbExecUserSql: (params: DbConnParams, statements: string[]) =>
    invoke<void>("db_exec_user_sql", { params, statements }),

  // MongoDB (document store — MongoPanel).
  mongoDatabases: (params: DbConnParams) => invoke<string[]>("mongo_databases", { params }),
  mongoCollections: (params: DbConnParams, database: string) =>
    invoke<string[]>("mongo_collections", { params, database }),
  mongoFind: (
    params: DbConnParams,
    database: string,
    collection: string,
    filter: string,
    limit?: number | null,
  ) => invoke<string[]>("mongo_find", { params, database, collection, filter, limit: limit ?? null }),
  mongoCount: (params: DbConnParams, database: string, collection: string, filter: string) =>
    invoke<number>("mongo_count", { params, database, collection, filter }),
  mongoInsert: (params: DbConnParams, database: string, collection: string, docJson: string) =>
    invoke<string>("mongo_insert", { params, database, collection, docJson }),
  mongoDelete: (params: DbConnParams, database: string, collection: string, idHex: string) =>
    invoke<number>("mongo_delete", { params, database, collection, idHex }),
  mongoReplace: (
    params: DbConnParams,
    database: string,
    collection: string,
    idHex: string,
    docJson: string,
  ) => invoke<number>("mongo_replace", { params, database, collection, idHex, docJson }),

  // Redis (key-value — RedisPanel).
  redisScan: (params: DbConnParams, pattern: string, cursor: number, count?: number | null) =>
    invoke<{ cursor: number; keys: { name: string; kind: string; ttl: number }[] }>("redis_scan", {
      params,
      pattern,
      cursor,
      count: count ?? null,
    }),
  redisGet: (params: DbConnParams, key: string) =>
    invoke<{ kind: string; value: string }>("redis_get", { params, key }),
  redisCommand: (params: DbConnParams, argv: string[]) =>
    invoke<string>("redis_command", { params, argv }),
  redisInfo: (params: DbConnParams) => invoke<string>("redis_info", { params }),
  redisSet: (params: DbConnParams, key: string, value: string) =>
    invoke<void>("redis_set", { params, key, value }),
  redisDel: (params: DbConnParams, key: string) => invoke<number>("redis_del", { params, key }),
  redisExpire: (params: DbConnParams, key: string, seconds: number) =>
    invoke<void>("redis_expire", { params, key, seconds }),

  // S3-compatible object storage (S3Panel).
  s3ListBuckets: (params: DbConnParams) => invoke<S3Bucket[]>("s3_list_buckets", { params }),
  s3CreateBucket: (params: DbConnParams, bucket: string) =>
    invoke<void>("s3_create_bucket", { params, bucket }),
  s3DeleteBucket: (params: DbConnParams, bucket: string) =>
    invoke<void>("s3_delete_bucket", { params, bucket }),
  s3ListObjects: (params: DbConnParams, bucket: string, prefix: string, token?: string | null) =>
    invoke<S3Listing>("s3_list_objects", { params, bucket, prefix, token: token ?? null }),
  /** With a `jobId`, streams `transfer://progress` events (see transfers.ts)
   *  and honors transferCancel; without one it behaves as a plain await. */
  s3Upload: (params: DbConnParams, bucket: string, key: string, localPath: string, jobId?: string) =>
    invoke<void>("s3_upload", { params, bucket, key, localPath, jobId: jobId ?? null }),
  s3Download: (
    params: DbConnParams,
    bucket: string,
    key: string,
    localPath: string,
    jobId?: string,
  ) => invoke<void>("s3_download", { params, bucket, key, localPath, jobId: jobId ?? null }),
  s3DeleteObject: (params: DbConnParams, bucket: string, key: string) =>
    invoke<void>("s3_delete_object", { params, bucket, key }),
  /** Recursively delete everything under `prefix`; returns the object count. */
  s3DeletePrefix: (params: DbConnParams, bucket: string, prefix: string) =>
    invoke<number>("s3_delete_prefix", { params, bucket, prefix }),
  s3CreateFolder: (params: DbConnParams, bucket: string, prefix: string) =>
    invoke<void>("s3_create_folder", { params, bucket, prefix }),
  /** Server-side copy of one object; `deleteSource` turns it into a move/rename. */
  s3CopyObject: (
    params: DbConnParams,
    bucket: string,
    key: string,
    destBucket: string,
    destKey: string,
    deleteSource: boolean,
  ) =>
    invoke<void>("s3_copy_object", { params, bucket, key, destBucket, destKey, deleteSource }),
  /** Recursively copy everything under `prefix` (move when `deleteSource`);
   *  returns the object count. */
  s3CopyPrefix: (
    params: DbConnParams,
    bucket: string,
    prefix: string,
    destBucket: string,
    destPrefix: string,
    deleteSource: boolean,
  ) =>
    invoke<number>("s3_copy_prefix", {
      params,
      bucket,
      prefix,
      destBucket,
      destPrefix,
      deleteSource,
    }),
  s3Preview: (params: DbConnParams, bucket: string, key: string) =>
    invoke<S3Preview>("s3_preview", { params, bucket, key }),

  /** With an `s3` target the dump is uploaded to the bucket instead of kept
   *  at `path` (which is then ignored, but still required by the command). */
  dbDump: (
    params: {
      engine?: string;
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      file?: string | null;
      profile_id?: string | null;
    },
    database: string,
    table: string | null,
    path: string,
    exportId: string,
    onProgress: Channel<DumpProgress>,
    s3?: DumpS3Target | null,
  ) => invoke<number>("db_dump", { params, database, table, path, exportId, onProgress, s3: s3 ?? null }),

  dbJobControl: (jobId: string, action: "pause" | "resume" | "cancel") =>
    invoke<void>("db_job_control", { jobId, action }),

  dbSchemaObjects: (
    params: {
      engine?: string;
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      file?: string | null;
      profile_id?: string | null;
    },
    database: string,
  ) => invoke<SchemaObjects>("db_schema_objects", { params, database }),

  /** One AI turn: stream text deltas over `onEvent`, resolve with the finished
   *  assistant turn (text + tool_use blocks). The API key stays in the keychain
   *  — only the provider/model/messages/tools cross the IPC boundary. */
  aiComplete: (req: AiCompleteReq, onEvent: Channel<AiEvent>) =>
    invoke<AiTurn>("ai_complete", {
      provider: req.provider,
      model: req.model,
      baseUrl: req.baseUrl ?? null,
      system: req.system ?? null,
      messages: req.messages,
      tools: req.tools,
      maxTokens: req.maxTokens ?? null,
      onEvent,
    }),
  /** Save (non-empty) or clear (null/"") a provider's API key in the keychain. */
  aiKeySave: (provider: AiProvider, key: string | null) =>
    invoke<void>("ai_key_save", { provider, key }),
  aiKeyExists: (provider: AiProvider) => invoke<boolean>("ai_key_exists", { provider }),
  /** Models installed on a local Ollama server (for the model picker). */
  aiOllamaModels: (baseUrl: string) => invoke<string[]>("ai_ollama_models", { baseUrl }),

  querySave: (query: SavedQuery) => invoke<SavedQuery>("query_save", { query }),
  queryDelete: (id: string) => invoke<void>("query_delete", { id }),

  noteSave: (note: Note) => invoke<Note>("note_save", { note }),
  noteDelete: (id: string) => invoke<void>("note_delete", { id }),

  dbImportFile: (
    params: {
      engine?: string;
      host: string;
      port: number;
      user: string;
      password?: string | null;
      database?: string | null;
      file?: string | null;
      profile_id?: string | null;
    },
    path: string,
    database: string | null,
    importId: string,
    continueOnError: boolean,
    dropFirst: boolean,
    autocommitOff: boolean,
    multiQuery: boolean,
    encoding: string | null,
    onProgress: Channel<ImportProgress>,
  ) =>
    invoke<{ executed: number; failed: number; error: string | null }>("db_import_file", {
      params,
      path,
      database,
      importId,
      continueOnError,
      dropFirst,
      autocommitOff,
      multiQuery,
      encoding,
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
  /** With a `jobId`, streams `transfer://progress` events (see transfers.ts)
   *  and honors transferCancel; without one it behaves as a plain await. */
  sftpDownload: (id: string, remotePath: string, localPath: string, jobId?: string) =>
    invoke<void>("sftp_download", { id, remotePath, localPath, jobId: jobId ?? null }),
  sftpDownloadDir: (id: string, remoteDir: string, localDir: string, jobId?: string) =>
    invoke<void>("sftp_download_dir", { id, remoteDir, localDir, jobId: jobId ?? null }),
  sftpPreview: (id: string, remotePath: string) =>
    invoke<S3Preview>("sftp_preview", { id, remotePath }),
  sftpUpload: (id: string, localPath: string, remotePath: string, jobId?: string) =>
    invoke<void>("sftp_upload", { id, localPath, remotePath, jobId: jobId ?? null }),
  sftpUploadDir: (id: string, localDir: string, remoteDir: string, jobId?: string) =>
    invoke<void>("sftp_upload_dir", { id, localDir, remoteDir, jobId: jobId ?? null }),
  sftpMkdir: (id: string, path: string) => invoke<void>("sftp_mkdir", { id, path }),
  sftpRename: (id: string, from: string, to: string) => invoke<void>("sftp_rename", { id, from, to }),
  sftpChmod: (id: string, path: string, mode: number) =>
    invoke<void>("sftp_chmod", { id, path, mode }),
  sftpRemove: (id: string, path: string, isDir: boolean) =>
    invoke<void>("sftp_remove", { id, path, isDir }),
  sftpClose: (id: string) => invoke<void>("sftp_close", { id }),

  /** Flag a running job-id transfer for cancellation (cooperative — the
   *  backend cleans up and ends the job with a "cancelled" event, not an error). */
  transferCancel: (id: string) => invoke<void>("transfer_cancel", { id }),

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
    mode?: string;
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
  /** File/dir names in `dir` (dirs get a trailing "/"), capped at 500. */
  listDir: (dir: string, cwd: string | null = null) =>
    invoke<string[]>("local_listdir", { cwd, dir }),
  // Shells installed on this machine, for the Settings → Local terminal picker.
  listShells: () => invoke<{ path: string; label: string }[]>("list_shells"),
  // Store builds only: latest version + a store deep link (App Store lookup for
  // iOS/macOS, latest.json for Android). Null on error / up-to-date-unknown.
  storeLatestVersion: (platform: string) =>
    invoke<{ version: string; url: string } | null>("store_latest_version", { platform }),

  // Google Drive sync (desktop). Push/pull reuse the encrypted export bundle;
  // the passphrase is cached in the keychain so auto-sync can run unattended.
  gdriveStatus: () => invoke<GdriveStatus>("gdrive_auth_status"),
  gdriveConnect: () => invoke<GdriveStatus>("gdrive_auth_start"),
  gdriveDisconnect: () => invoke<void>("gdrive_auth_disconnect"),
  gdriveSetAutoSync: (enabled: boolean) =>
    invoke<void>("gdrive_set_auto_sync", { enabled }),
  gdrivePush: (passphrase: string) => invoke<number>("gdrive_sync_push", { passphrase }),
  gdrivePull: (passphrase: string) =>
    invoke<ImportSummary>("gdrive_sync_pull", { passphrase }),
  /** Unattended push using the cached passphrase; null if not eligible. */
  gdriveAutoPush: () => invoke<number | null>("gdrive_auto_push"),
  /** Unattended, throttled pull using the cached passphrase; null if it didn't run. */
  gdriveAutoPull: () => invoke<ImportSummary | null>("gdrive_auto_pull"),
};
