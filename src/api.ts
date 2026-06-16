import { invoke } from "@tauri-apps/api/core";
import type { DbProfile, ProfileStore, QueryResult, SshProfile } from "./types";

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
    params: { host: string; port: number; user: string; password: string; database: string | null },
    sql: string,
  ) => invoke<QueryResult>("db_query", { params, sql }),
};
