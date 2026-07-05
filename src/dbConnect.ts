import { api, type DbConnParams } from "./api";
import { DB_ENGINES, type DbProfile, type SshProfile } from "./types";

/**
 * Build the backend connection params for a DB profile, starting an SSH tunnel
 * first when the profile routes through one (the backend then only ever sees
 * 127.0.0.1:<local_port>). Shared by the Mongo + Redis panels; the SQL DbPanel
 * has its own copy woven into its richer connect flow.
 */
export async function openDbConnection(
  prefill: DbProfile,
  sshProfiles: SshProfile[],
): Promise<{ params: DbConnParams; tunnelId: string | null }> {
  let host = prefill.host;
  let port = prefill.port;
  let tunnelId: string | null = null;
  const fileBased = DB_ENGINES[prefill.engine]?.fileBased ?? false;
  const viaSsh = prefill.via_ssh_profile_id ?? null;

  if (viaSsh && !fileBased) {
    const ssh = sshProfiles.find((s) => s.id === viaSsh);
    if (!ssh) throw new Error("SSH profile for tunnel not found");
    const t = await api.tunnelStart({
      host: ssh.host,
      port: ssh.port,
      user: ssh.user,
      auth: ssh.auth,
      profile_id: ssh.id,
      remote_host: prefill.host,
      remote_port: prefill.port,
      local_port: 0,
    });
    host = "127.0.0.1";
    port = t.local_port;
    tunnelId = t.id;
  }

  return {
    params: {
      engine: prefill.engine,
      host,
      port,
      user: prefill.user,
      database: prefill.database,
      file: prefill.file ?? null,
      profile_id: prefill.id,
    },
    tunnelId,
  };
}
