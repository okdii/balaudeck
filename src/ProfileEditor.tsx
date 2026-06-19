import { useState } from "react";
import { api } from "./api";
import type {
  ConnKind,
  DbProfile,
  Folder,
  SftpProfile,
  SshProfile,
  TunnelProfile,
} from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon } from "./Icon";

type AnyProfile = SshProfile | DbProfile | SftpProfile | TunnelProfile;

interface Props {
  kind: ConnKind;
  initial?: AnyProfile;
  sshProfiles: SshProfile[];
  folders: Folder[];
  onClose: () => void;
  onSaved: () => void;
}

const LABEL: Record<ConnKind, string> = {
  ssh: "SSH",
  sftp: "SFTP",
  tunnel: "Tunnel",
  db: "Database",
};

export function ProfileEditor({ kind, initial, sshProfiles, folders, onClose, onSaved }: Props) {
  const isDb = kind === "db";
  const isTunnel = kind === "tunnel";
  const isSshAuth = kind === "ssh" || kind === "sftp";
  const init = initial as Partial<SshProfile & DbProfile & SftpProfile & TunnelProfile> | undefined;
  const editing = !!init?.id;

  const [name, setName] = useState(init?.name ?? "");
  const [host, setHost] = useState(init?.host ?? (isDb ? "127.0.0.1" : ""));
  const [port, setPort] = useState(String(init?.port ?? (isDb ? 3306 : 22)));
  const [user, setUser] = useState(init?.user ?? (isDb ? "root" : ""));
  const [folderId, setFolderId] = useState<string | null>(init?.folder_id ?? null);

  // DB-specific
  const [database, setDatabase] = useState(init?.database ?? "");
  const [viaSsh, setViaSsh] = useState(init?.via_ssh_profile_id ?? "");
  const [password, setPassword] = useState("");

  // Tunnel-specific
  const [remoteHost, setRemoteHost] = useState(init?.remote_host ?? "127.0.0.1");
  const [remotePort, setRemotePort] = useState(String(init?.remote_port ?? 3306));
  const [localPort, setLocalPort] = useState(init?.local_port ? String(init.local_port) : "0");
  // The SSH host a tunnel forwards through: a saved profile, or manual entry.
  const [sshHostId, setSshHostId] = useState<string | null>(init?.ssh_profile_id ?? null);
  const [sshManual, setSshManual] = useState(
    isTunnel ? !init?.ssh_profile_id && !!init?.host : false,
  );

  // SSH: persist the shell in a tmux session that survives drops.
  const [tmux, setTmux] = useState(init?.tmux ?? false);
  const [tmuxSession, setTmuxSession] = useState(init?.tmux_session ?? "");

  // SSH-credential auth (ssh / sftp profiles, and a tunnel's manual SSH host)
  const [auth, setAuth] = useState<AuthValue>({
    ...emptyAuth(),
    auth: init?.auth ?? "password",
  });

  // SFTP: optionally base the profile on a saved SSH host (prefills the fields
  // and reuses that host's stored credentials).
  const [baseSshId, setBaseSshId] = useState("");
  // SFTP: optional command to run instead of the sftp subsystem (for sudo).
  const [sftpCommand, setSftpCommand] = useState(init?.sftp_command ?? "");
  // SFTP: optional sudo password for the elevated command (kept in keychain,
  // never prefilled — blank on edit means "keep existing").
  const [sudoPassword, setSudoPassword] = useState("");

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function secrets(a: AuthValue): [string | undefined, string | undefined, string | undefined] {
    return [
      a.auth === "password" ? a.password || undefined : undefined,
      a.auth === "key" ? a.key || undefined : undefined,
      a.auth === "key" ? a.passphrase || undefined : undefined,
    ];
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const id = init?.id ?? "";
      const p = Number(port) || (isDb ? 3306 : 22);

      if (isSshAuth) {
        const profile = { id, name, host, port: p, user, auth: auth.auth, folder_id: folderId };
        if (kind === "ssh") {
          await api.sshProfileSave(
            { ...profile, tmux, tmux_session: tmuxSession.trim() || null },
            ...secrets(auth),
          );
        } else {
          const sec = secrets(auth);
          const hasInline = sec.some(Boolean);
          await api.sftpProfileSave(
            { ...profile, sftp_command: sftpCommand.trim() || null },
            sec[0],
            sec[1],
            sec[2],
            undefined,
            baseSshId && !hasInline ? baseSshId : undefined,
            sudoPassword.trim() || undefined,
          );
        }
      } else if (isTunnel) {
        const useSaved = !sshManual && !!sshHostId;
        const ref = useSaved ? sshProfiles.find((s) => s.id === sshHostId) : undefined;
        const profile = {
          id,
          name,
          ssh_profile_id: useSaved ? sshHostId : null,
          host: ref ? ref.host : host,
          port: ref ? ref.port : p,
          user: ref ? ref.user : user,
          auth: ref ? ref.auth : auth.auth,
          jump_profile_id: null,
          jump_host: null,
          jump_port: null,
          jump_user: null,
          jump_auth: null,
          remote_host: remoteHost,
          remote_port: Number(remotePort) || 0,
          local_port: Number(localPort) || null,
          folder_id: folderId,
        };
        const sec = useSaved ? ([undefined, undefined, undefined] as const) : secrets(auth);
        await api.tunnelProfileSave(profile, sec[0], sec[1], sec[2]);
      } else {
        await api.dbProfileSave(
          {
            id,
            name,
            host,
            port: p,
            user,
            database: database || null,
            via_ssh_profile_id: viaSsh || null,
            folder_id: folderId,
          },
          password || undefined,
        );
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const previewLocal = localPort === "0" || !localPort ? "auto" : localPort;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {editing ? "Edit" : "New"} {LABEL[kind]} profile
        </h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My server" />
        </label>
        <label>
          Folder
          <select value={folderId ?? ""} onChange={(e) => setFolderId(e.target.value || null)}>
            <option value="">— none —</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>

        {/* Connection / SSH host */}
        {isTunnel ? (
          <div className="jump-field">
            <label>
              SSH host <small>— the server that forwards</small>
              <select
                value={sshManual ? "" : (sshHostId ?? "")}
                disabled={sshManual}
                onChange={(e) => setSshHostId(e.target.value || null)}
              >
                <option value="">— choose a saved SSH host —</option>
                {sshProfiles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `${s.user}@${s.host}`}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="jump-toggle"
              onClick={() => {
                setSshManual((v) => !v);
                if (!sshManual) setSshHostId(null);
              }}
            >
              <Icon name={sshManual ? "chevronDown" : "chevronRight"} size={13} />
              Manual SSH connection
            </button>
            {sshManual && (
              <div className="jump-manual">
                <div className="form-row">
                  <input placeholder="ssh host" value={host} onChange={(e) => setHost(e.target.value)} />
                  <input className="port" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
                  <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
                </div>
                <AuthFields value={auth} onChange={setAuth} saved={editing && !init?.ssh_profile_id} />
              </div>
            )}
          </div>
        ) : (
          <>
            {kind === "sftp" && sshProfiles.length > 0 && (
              <label>
                Base on saved SSH host <small>— optional; fills the fields below and reuses its login</small>
                <select
                  value={baseSshId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setBaseSshId(id);
                    const s = sshProfiles.find((x) => x.id === id);
                    if (!s) return;
                    setHost(s.host);
                    setPort(String(s.port));
                    setUser(s.user);
                    setAuth((a) => ({ ...a, auth: s.auth }));
                    if (!name.trim()) setName(s.name || `${s.user}@${s.host}`);
                  }}
                >
                  <option value="">— manual entry —</option>
                  {sshProfiles.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || `${s.user}@${s.host}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="form-row">
              <label className="grow">
                Host
                <input value={host} onChange={(e) => setHost(e.target.value)} />
              </label>
              <label className="port-label">
                Port
                <input value={port} onChange={(e) => setPort(e.target.value)} />
              </label>
            </div>
            <label>
              User
              <input value={user} onChange={(e) => setUser(e.target.value)} />
            </label>
            {kind === "ssh" && (
              <>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={tmux}
                    onChange={(e) => setTmux(e.target.checked)}
                  />
                  <span>
                    Persist with tmux <small>— re-attach the same shell on reconnect</small>
                  </span>
                </label>
                {tmux && (
                  <label>
                    tmux session name <small>— optional; per-host default if blank</small>
                    <input
                      value={tmuxSession}
                      onChange={(e) => setTmuxSession(e.target.value)}
                      placeholder="balaudeck"
                    />
                  </label>
                )}
              </>
            )}
            {kind === "sftp" && (
              <label>
                SFTP server command <small>— optional; for sudo, e.g. sudo /usr/lib/openssh/sftp-server</small>
                <input
                  value={sftpCommand}
                  onChange={(e) => setSftpCommand(e.target.value)}
                  placeholder="(default: sftp subsystem)"
                />
              </label>
            )}
            {kind === "sftp" && sftpCommand.trim().toLowerCase().startsWith("sudo") && (
              <label>
                Sudo password{" "}
                <small>— optional; leave blank for passwordless (NOPASSWD) sudo{editing ? ", or to keep the saved one" : ""}</small>
                <input
                  type="password"
                  value={sudoPassword}
                  onChange={(e) => setSudoPassword(e.target.value)}
                  placeholder={editing ? "(keep saved)" : "(NOPASSWD sudo)"}
                />
              </label>
            )}
          </>
        )}

        {isDb && (
          <>
            <label>
              Database (optional)
              <input value={database ?? ""} onChange={(e) => setDatabase(e.target.value)} />
            </label>
            <label>
              Connect through SSH tunnel (optional)
              <select value={viaSsh ?? ""} onChange={(e) => setViaSsh(e.target.value)}>
                <option value="">— direct —</option>
                {sshProfiles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `${s.user}@${s.host}`}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {isTunnel && (
          <>
            <div className="tunnel-target">
              <label>
                Remote target <small>— host:port reachable from the SSH server</small>
                <div className="form-row">
                  <input placeholder="remote host" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} />
                  <input className="port" placeholder="port" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} />
                </div>
              </label>
              <label>
                Local port <small>— port on this machine; 0 = auto</small>
                <input className="port" placeholder="0" value={localPort} onChange={(e) => setLocalPort(e.target.value)} />
              </label>
            </div>
            <div className="tunnel-preview">
              <code>127.0.0.1:{previewLocal}</code>
              <Icon name="tunnel" size={13} />
              <code>
                {remoteHost || "host"}:{remotePort || "port"}
              </code>
            </div>
          </>
        )}

        {isDb && (
          <label>
            Password {editing ? "(leave blank to keep)" : ""}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {isSshAuth && (
          <label>
            Authentication{" "}
            {editing
              ? "(leave blank to keep)"
              : kind === "sftp" && baseSshId
                ? "(leave blank to reuse the SSH host's login)"
                : ""}
            <AuthFields
              value={auth}
              onChange={setAuth}
              saved={editing || (kind === "sftp" && !!baseSshId)}
            />
          </label>
        )}

        {error && <pre className="error">{error}</pre>}
        <div className="form-row end">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
