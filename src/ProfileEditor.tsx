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
  const init = initial as Partial<SshProfile & DbProfile & SftpProfile & TunnelProfile> | undefined;
  const editing = !!init?.id;

  const [name, setName] = useState(init?.name ?? "");
  const [host, setHost] = useState(init?.host ?? (isDb ? "127.0.0.1" : ""));
  const [port, setPort] = useState(String(init?.port ?? (isDb ? 3306 : 22)));
  const [user, setUser] = useState(init?.user ?? (isDb ? "root" : ""));
  const [folderId, setFolderId] = useState<string | null>(init?.folder_id ?? null);
  const [jumpId, setJumpId] = useState<string | null>(init?.jump_profile_id ?? null);
  const [jumpManual, setJumpManual] = useState(!!init?.jump_host);
  const [jumpHost, setJumpHost] = useState(init?.jump_host ?? "");
  const [jumpPort, setJumpPort] = useState(String(init?.jump_port ?? 22));
  const [jumpUser, setJumpUser] = useState(init?.jump_user ?? "");
  const [jumpAuth, setJumpAuth] = useState<AuthValue>({
    ...emptyAuth(),
    auth: init?.jump_auth ?? "password",
  });

  // DB-specific
  const [database, setDatabase] = useState(init?.database ?? "");
  const [viaSsh, setViaSsh] = useState(init?.via_ssh_profile_id ?? "");
  const [password, setPassword] = useState("");

  // Tunnel-specific
  const [remoteHost, setRemoteHost] = useState(init?.remote_host ?? "127.0.0.1");
  const [remotePort, setRemotePort] = useState(String(init?.remote_port ?? 3306));
  const [localPort, setLocalPort] = useState(init?.local_port ? String(init.local_port) : "0");

  // SSH-credential auth (ssh / sftp / tunnel)
  const [auth, setAuth] = useState<AuthValue>({
    ...emptyAuth(),
    auth: init?.auth ?? "password",
  });

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function secrets(): [string | undefined, string | undefined, string | undefined] {
    return [
      auth.auth === "password" ? auth.password || undefined : undefined,
      auth.auth === "key" ? auth.key || undefined : undefined,
      auth.auth === "key" ? auth.passphrase || undefined : undefined,
    ];
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const id = init?.id ?? "";
      const p = Number(port) || (isDb ? 3306 : 22);
      const jumpFields = jumpManual
        ? {
            jump_profile_id: null,
            jump_host: jumpHost || null,
            jump_port: Number(jumpPort) || 22,
            jump_user: jumpUser || null,
            jump_auth: jumpAuth.auth,
          }
        : { jump_profile_id: jumpId, jump_host: null, jump_port: null, jump_user: null, jump_auth: null };
      const jumpSecrets = jumpManual
        ? {
            password: jumpAuth.auth === "password" ? jumpAuth.password || undefined : undefined,
            key: jumpAuth.auth === "key" ? jumpAuth.key || undefined : undefined,
            passphrase: jumpAuth.auth === "key" ? jumpAuth.passphrase || undefined : undefined,
          }
        : undefined;
      if (kind === "ssh") {
        await api.sshProfileSave(
          { id, name, host, port: p, user, auth: auth.auth, ...jumpFields, folder_id: folderId },
          ...secrets(),
          jumpSecrets,
        );
      } else if (kind === "sftp") {
        await api.sftpProfileSave(
          { id, name, host, port: p, user, auth: auth.auth, ...jumpFields, folder_id: folderId },
          ...secrets(),
          jumpSecrets,
        );
      } else if (kind === "tunnel") {
        await api.tunnelProfileSave(
          {
            id,
            name,
            host,
            port: p,
            user,
            auth: auth.auth,
            ...jumpFields,
            remote_host: remoteHost,
            remote_port: Number(remotePort) || 0,
            local_port: Number(localPort) || null,
            folder_id: folderId,
          },
          ...secrets(),
          jumpSecrets,
        );
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

        {!isDb && (
          <div className="jump-field">
            <label>
              Jump host (optional) <small>— reach this host through another SSH server</small>
              <select
                value={jumpManual ? "" : (jumpId ?? "")}
                disabled={jumpManual}
                onChange={(e) => setJumpId(e.target.value || null)}
              >
                <option value="">— direct —</option>
                {sshProfiles
                  .filter((s) => s.id !== init?.id)
                  .map((s) => (
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
                setJumpManual((v) => !v);
                if (!jumpManual) setJumpId(null);
              }}
            >
              <Icon name={jumpManual ? "chevronDown" : "chevronRight"} size={13} />
              Manual jump host
            </button>
            {jumpManual && (
              <div className="jump-manual">
                <div className="form-row">
                  <input
                    placeholder="jump host"
                    value={jumpHost}
                    onChange={(e) => setJumpHost(e.target.value)}
                  />
                  <input
                    className="port"
                    placeholder="port"
                    value={jumpPort}
                    onChange={(e) => setJumpPort(e.target.value)}
                  />
                  <input
                    placeholder="user"
                    value={jumpUser}
                    onChange={(e) => setJumpUser(e.target.value)}
                  />
                </div>
                <AuthFields value={jumpAuth} onChange={setJumpAuth} saved={!!init?.jump_host} />
              </div>
            )}
          </div>
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
          <div className="tunnel-target">
            <label>
              Remote target <small>— host:port reachable from the SSH server</small>
              <div className="form-row">
                <input
                  placeholder="remote host"
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                />
                <input
                  className="port"
                  placeholder="port"
                  value={remotePort}
                  onChange={(e) => setRemotePort(e.target.value)}
                />
              </div>
            </label>
            <label>
              Local port <small>— port on this machine; 0 = auto</small>
              <input
                className="port"
                placeholder="0"
                value={localPort}
                onChange={(e) => setLocalPort(e.target.value)}
              />
            </label>
          </div>
        )}

        {isDb ? (
          <label>
            Password {editing ? "(leave blank to keep)" : ""}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        ) : (
          <label>
            Authentication {editing ? "(leave blank to keep)" : ""}
            <AuthFields value={auth} onChange={setAuth} saved={editing} />
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
