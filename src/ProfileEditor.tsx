import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DB_ENGINES,
  folderTree,
  type ConnKind,
  type DbEngine,
  type DbProfile,
  type Folder,
  type SftpProfile,
  type SshProfile,
  type TunnelProfile,
} from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { holdMinVisible } from "./busy";
import { defaultTmuxSession } from "./settings";
import { Icon, Spinner } from "./Icon";
import { HostPicker, type Preset } from "./SessionUI";

type AnyProfile = SshProfile | DbProfile | SftpProfile | TunnelProfile;

interface Props {
  kind: ConnKind;
  initial?: AnyProfile;
  /** Preselects the DB engine for a new profile (e.g. "s3" from the Object storage menu entry). */
  presetEngine?: DbEngine;
  /** Preselects the folder for a new profile (e.g. created via a folder's context menu). */
  presetFolder?: string | null;
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

/** Conventional admin user seeded into a NEW profile ("" for engines without one, e.g. S3). */
function defaultDbUser(engine: DbEngine): string {
  return engine === "mysql" || engine === "mariadb"
    ? "root"
    : engine === "postgres"
      ? "postgres"
      : engine === "mssql"
        ? "sa"
        : "";
}

export function ProfileEditor({ kind, initial, presetEngine, presetFolder, sshProfiles, folders, onClose, onSaved }: Props) {
  const isDb = kind === "db";
  const isTunnel = kind === "tunnel";
  const isSshAuth = kind === "ssh" || kind === "sftp";
  const init = initial as Partial<SshProfile & DbProfile & SftpProfile & TunnelProfile> | undefined;
  const editing = !!init?.id;

  // DB engine (only meaningful when isDb); defaults to MySQL for back-compat.
  const [engine, setEngine] = useState<DbEngine>(
    (init?.engine as DbEngine) ?? presetEngine ?? "mysql",
  );
  const eng = DB_ENGINES[engine];
  // Object storage: an S3-compatible endpoint stored as a DB profile (access
  // key = user, secret key = the db password keychain slot).
  const isS3 = isDb && eng.family === "s3";

  const [name, setName] = useState(init?.name ?? "");
  const [host, setHost] = useState(init?.host ?? (isDb ? "127.0.0.1" : ""));
  const [port, setPort] = useState(String(init?.port ?? (isDb ? eng.defaultPort : 22)));
  const [user, setUser] = useState(init?.user ?? (isDb ? defaultDbUser(engine) : ""));
  const [folderId, setFolderId] = useState<string | null>(init?.folder_id ?? presetFolder ?? null);

  // DB-specific
  const [database, setDatabase] = useState(init?.database ?? "");
  const [file, setFile] = useState(init?.file ?? "");
  const [viaSsh, setViaSsh] = useState(init?.via_ssh_profile_id ?? "");
  const [password, setPassword] = useState("");

  // S3-specific
  const [region, setRegion] = useState(init?.region ?? "us-east-1");
  const [tls, setTls] = useState(init?.tls ?? false);
  const [pathStyle, setPathStyle] = useState(init?.path_style ?? true);
  // Whether a secret key is already stored — the field shows masked dots for it
  // (the real value is never loaded). `secretEditing` flips true once the user
  // starts replacing it, so save knows to keep vs overwrite.
  const [secretSaved, setSecretSaved] = useState(false);
  const [secretEditing, setSecretEditing] = useState(false);

  // Searchable SSH-host list for the tunnel picker: a "— direct —" row (id "")
  // to clear back to no tunnel, then every saved SSH host grouped by folder.
  const sshTunnelPresets: Preset[] = [
    { id: "", label: "— direct —" },
    ...sshProfiles.map((s) => ({
      id: s.id,
      label: s.name || `${s.user}@${s.host}`,
      sub: `${s.user}@${s.host}:${s.port}`,
      folderId: s.folder_id,
    })),
  ];

  // Switching engine reseeds the port/user defaults (only for a NEW profile, so
  // an edit keeps its saved values).
  function pickEngine(next: DbEngine) {
    setEngine(next);
    if (!editing) {
      const m = DB_ENGINES[next];
      setPort(String(m.defaultPort));
      setUser(defaultDbUser(next));
    }
  }

  async function browseSqliteFile() {
    try {
      const p = await open({ multiple: false });
      if (typeof p === "string") setFile(p);
    } catch {
      /* user cancelled or dialog unavailable */
    }
  }

  // Tunnel-specific
  const [remoteHost, setRemoteHost] = useState(init?.remote_host ?? "127.0.0.1");
  const [remotePort, setRemotePort] = useState(String(init?.remote_port ?? 3306));
  const [localPort, setLocalPort] = useState(init?.local_port ? String(init.local_port) : "0");
  // Tunnel forwarding mode: "local" (-L) | "dynamic" (-D SOCKS) | "remote" (-R).
  const [tunnelMode, setTunnelMode] = useState(init?.mode ?? "local");
  // The SSH host a tunnel forwards through: a saved profile, or manual entry.
  const [sshHostId, setSshHostId] = useState<string | null>(init?.ssh_profile_id ?? null);
  const [sshManual, setSshManual] = useState(
    isTunnel ? !init?.ssh_profile_id && !!init?.host : false,
  );

  // SSH: persist the shell in a tmux session that survives drops.
  const [tmux, setTmux] = useState(init?.tmux ?? false);
  const [tmuxSession, setTmuxSession] = useState(init?.tmux_session ?? "");
  const [tmuxMouse, setTmuxMouse] = useState(init?.tmux_mouse ?? false);
  // SSH: optional command auto-run after login (e.g. `sudo su -`) + its escalation
  // password (kept in keychain, never prefilled — blank on edit means "keep").
  const [afterLogin, setAfterLogin] = useState(init?.after_login ?? "");
  const [escalatePassword, setEscalatePassword] = useState("");
  // Whether an escalation password is already stored — the field shows masked
  // dots for it (the real value is never loaded). `escalateEditing` flips true
  // once the user starts replacing it, so save knows to keep vs overwrite.
  const [escalateSaved, setEscalateSaved] = useState(false);
  const [escalateEditing, setEscalateEditing] = useState(false);
  useEffect(() => {
    if (kind === "ssh" && init?.id) {
      api
        .secretExists("ssh", init.id, "escalate_password")
        .then(setEscalateSaved)
        .catch(() => {});
    }
    if (kind === "db" && init?.id) {
      api
        .secretExists("db", init.id, "password")
        .then(setSecretSaved)
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // SSH / SFTP: optional jump host (ProxyJump) — connect through a saved SSH
  // host or a manually-entered one, then on to the target.
  const [jumpOn, setJumpOn] = useState(!!init?.jump_profile_id || !!init?.jump_host);
  const [jumpProfileId, setJumpProfileId] = useState(init?.jump_profile_id ?? "");
  const [jumpManual, setJumpManual] = useState(!!init?.jump_host);
  const [jumpHost, setJumpHost] = useState(init?.jump_host ?? "");
  const [jumpPort, setJumpPort] = useState(String(init?.jump_port ?? 22));
  const [jumpUser, setJumpUser] = useState(init?.jump_user ?? "");
  const [jumpAuth, setJumpAuth] = useState<AuthValue>({
    ...emptyAuth(),
    auth: init?.jump_auth ?? "password",
  });
  // SSH only: how to route through the jump — a direct-tcpip forward (ProxyJump)
  // or run ssh on the jump (for bastions that block forwarding).
  const [jumpMode, setJumpMode] = useState<"forward" | "nested">(
    init?.jump_mode === "nested" ? "nested" : "forward",
  );
  // SSH nested mode: add `-v` to the jump's ssh for verbose diagnostics.
  const [verbose, setVerbose] = useState(init?.verbose ?? false);

  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function secrets(a: AuthValue): [string | undefined, string | undefined, string | undefined] {
    return [
      a.auth === "password" ? a.password || undefined : undefined,
      a.auth === "key" ? a.key || undefined : undefined,
      a.auth === "key" ? a.passphrase || undefined : undefined,
    ];
  }

  // The jump-host fields stored on an SSH/SFTP profile (saved host, manual, or none).
  function jumpFields() {
    if (!jumpOn) {
      return { jump_profile_id: null, jump_host: null, jump_port: null, jump_user: null, jump_auth: null, jump_mode: null };
    }
    if (jumpManual) {
      return {
        jump_profile_id: null,
        jump_host: jumpHost.trim() || null,
        jump_port: Number(jumpPort) || 22,
        jump_user: jumpUser.trim() || null,
        jump_auth: jumpAuth.auth,
        jump_mode: jumpMode,
      };
    }
    return { jump_profile_id: jumpProfileId || null, jump_host: null, jump_port: null, jump_user: null, jump_auth: null, jump_mode: jumpMode };
  }

  // Inline jump-host secrets (only when a manual jump host is used).
  function jumpSecrets() {
    if (!jumpOn || !jumpManual) return undefined;
    const [pw, key, pp] = secrets(jumpAuth);
    return { password: pw ?? null, key: key ?? null, passphrase: pp ?? null };
  }

  async function save() {
    setSaving(true);
    setError("");
    const start = Date.now();
    try {
      const id = init?.id ?? "";
      const p = Number(port) || (isDb ? 3306 : 22);

      if (isSshAuth) {
        const profile = { id, name, host, port: p, user, auth: auth.auth, folder_id: folderId };
        if (kind === "ssh") {
          await api.sshProfileSave(
            {
              ...profile,
              ...jumpFields(),
              tmux,
              tmux_session: tmuxSession.trim() || null,
              tmux_mouse: tmux && tmuxMouse,
              verbose,
              after_login: afterLogin.trim() || null,
            },
            ...secrets(auth),
            jumpSecrets(),
            escalateEditing ? escalatePassword.trim() || undefined : undefined,
          );
        } else {
          const sec = secrets(auth);
          const hasInline = sec.some(Boolean);
          await api.sftpProfileSave(
            { ...profile, ...jumpFields(), sftp_command: sftpCommand.trim() || null },
            sec[0],
            sec[1],
            sec[2],
            jumpSecrets(),
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
          mode: tunnelMode,
          remote_host: remoteHost,
          remote_port: Number(remotePort) || 0,
          local_port: Number(localPort) || null,
          folder_id: folderId,
        };
        const sec = useSaved ? ([undefined, undefined, undefined] as const) : secrets(auth);
        await api.tunnelProfileSave(profile, sec[0], sec[1], sec[2]);
      } else {
        if (eng.fileBased && !file.trim()) throw new Error("Choose a database file.");
        if (isS3 && !host.trim()) throw new Error("Enter the endpoint host.");
        await api.dbProfileSave(
          {
            id,
            name,
            engine,
            host,
            port: p,
            user,
            database: isS3 ? null : database || null,
            file: eng.fileBased ? file || null : null,
            region: isS3 ? region.trim() || "us-east-1" : null,
            path_style: isS3 ? pathStyle : null,
            tls: isS3 ? tls : null,
            via_ssh_profile_id: eng.fileBased ? null : viaSsh || null,
            folder_id: folderId,
          },
          password || undefined,
        );
      }
      await holdMinVisible(start);
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const previewLocal = localPort === "0" || !localPort ? "auto" : localPort;

  // Dismiss only when a click BEGINS and ENDS on the dimmed backdrop itself.
  // A bare onClick={onClose} also fired when a text-selection drag inside a
  // field released on the backdrop (e.g. selecting a value to paste over),
  // closing the editor mid-edit.
  const backdropDown = useRef(false);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        backdropDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (backdropDown.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {editing ? "Edit" : "New"} {isS3 ? "Object storage" : LABEL[kind]} profile
        </h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My server" />
        </label>
        <label>
          Folder
          <select value={folderId ?? ""} onChange={(e) => setFolderId(e.target.value || null)}>
            <option value="">— none —</option>
            {folderTree(folders).map(({ folder: f, depth }) => (
              <option key={f.id} value={f.id}>
                {"   ".repeat(depth) + (depth ? "↳ " : "") + f.name}
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
            {isDb && (
              <label>
                Engine
                <select value={engine} onChange={(e) => pickEngine(e.target.value as DbEngine)}>
                  {(Object.keys(DB_ENGINES) as DbEngine[]).map((k) => (
                    <option key={k} value={k}>
                      {DB_ENGINES[k].label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {isDb && eng.fileBased && (
              <label>
                Database file
                <div className="form-row">
                  <input
                    className="grow"
                    placeholder="/path/to/database.sqlite"
                    value={file}
                    onChange={(e) => setFile(e.target.value)}
                  />
                  <button type="button" className="ghost" onClick={browseSqliteFile}>
                    <Icon name="folder" size={14} /> Browse…
                  </button>
                </div>
              </label>
            )}
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
            {(!isDb || !eng.fileBased) && (
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
            )}
            {isS3 && (
              <>
                <label>
                  Region
                  <input
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="us-east-1"
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={tls}
                    onChange={(e) => setTls(e.target.checked)}
                  />
                  <span>
                    Use HTTPS (TLS){" "}
                    <small>
                      — TLS through an SSH tunnel fails hostname verification; use the plain-HTTP
                      port over tunnels
                    </small>
                  </span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={pathStyle}
                    onChange={(e) => setPathStyle(e.target.checked)}
                  />
                  <span>
                    Path-style addressing{" "}
                    <small>— keep on for MinIO, RustFS and IP endpoints</small>
                  </span>
                </label>
              </>
            )}
            {(!isDb || (!eng.fileBased && eng.needsUser)) && (
              <label>
                {isS3 ? "Access key" : "User"}
                <input value={user} onChange={(e) => setUser(e.target.value)} />
              </label>
            )}
            {isSshAuth && (
              <div className="jump-field">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={jumpOn}
                    onChange={(e) => setJumpOn(e.target.checked)}
                  />
                  <span>
                    Connect through a jump host{" "}
                    <small>— ProxyJump / bastion (how to reach this host, not a forward)</small>
                  </span>
                </label>
                {jumpOn && (
                  <>
                    <label>
                      Jump SSH host <small>— a saved SSH host to route through</small>
                      <select
                        value={jumpManual ? "" : jumpProfileId}
                        disabled={jumpManual}
                        onChange={(e) => setJumpProfileId(e.target.value)}
                      >
                        <option value="">— choose a saved SSH host —</option>
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
                        if (!jumpManual) setJumpProfileId("");
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
                        <AuthFields
                          value={jumpAuth}
                          onChange={setJumpAuth}
                          saved={editing && !!init?.jump_host}
                        />
                      </div>
                    )}
                    {kind === "ssh" && (
                      <label>
                        Routing{" "}
                        <small>— nested runs ssh on the jump (for bastions that block forwarding)</small>
                        <select
                          value={jumpMode}
                          onChange={(e) => setJumpMode(e.target.value as "forward" | "nested")}
                        >
                          <option value="forward">Port-forward (ProxyJump)</option>
                          <option value="nested">Run ssh on the jump (nested)</option>
                        </select>
                      </label>
                    )}
                    {kind === "ssh" && jumpMode === "nested" && (
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={verbose}
                          onChange={(e) => setVerbose(e.target.checked)}
                        />
                        <span>
                          Verbose <small>— add ssh -v output to the terminal (debug)</small>
                        </span>
                      </label>
                    )}
                  </>
                )}
              </div>
            )}
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
                  <>
                    <label>
                      tmux session name <small>— optional; the Settings default if blank</small>
                      <input
                        value={tmuxSession}
                        onChange={(e) => setTmuxSession(e.target.value)}
                        placeholder={defaultTmuxSession()}
                      />
                    </label>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={tmuxMouse}
                        onChange={(e) => setTmuxMouse(e.target.checked)}
                      />
                      <span>
                        Mouse scroll <small>— tmux mouse on; hold Shift to select text</small>
                      </span>
                    </label>
                  </>
                )}
                <label>
                  Run after login{" "}
                  <small>— optional; sent once the shell is ready, e.g. sudo su -</small>
                  <input
                    value={afterLogin}
                    onChange={(e) => setAfterLogin(e.target.value)}
                    placeholder="sudo su -"
                  />
                </label>
                {afterLogin.trim() && (
                  <label>
                    Escalation password
                    {escalateSaved && <span className="saved-tag">saved</span>}{" "}
                    <small>
                      {escalateSaved
                        ? "— a password is stored (shown as dots). Click to replace, or leave it to keep."
                        : "— optional; auto-sent at the password prompt. Stored in the keychain, not in plaintext."}
                    </small>
                    <input
                      type="password"
                      value={escalateSaved && !escalateEditing ? "••••••••" : escalatePassword}
                      onFocus={() => {
                        if (escalateSaved && !escalateEditing) {
                          setEscalateEditing(true);
                          setEscalatePassword("");
                        }
                      }}
                      onBlur={() => {
                        // Nothing typed after clicking in — restore the saved dots.
                        if (escalateSaved && escalateEditing && !escalatePassword) setEscalateEditing(false);
                      }}
                      onChange={(e) => {
                        setEscalateEditing(true);
                        setEscalatePassword(e.target.value);
                      }}
                      placeholder="sudo / root password"
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

        {isDb && !eng.fileBased && (
          <>
            {!isS3 && (
              <label>
                {engine === "redis"
                  ? "Database number"
                  : engine === "mongodb"
                    ? "Auth database (optional)"
                    : eng.needsDatabase
                      ? "Database"
                      : "Database (optional)"}
                <input value={database ?? ""} onChange={(e) => setDatabase(e.target.value)} />
              </label>
            )}
            <label>
              Connect through SSH tunnel (optional)
              <HostPicker
                presets={sshTunnelPresets}
                folders={folders}
                selectedId={viaSsh ?? ""}
                onSelect={setViaSsh}
                placeholder="— direct —"
              />
            </label>
          </>
        )}

        {isTunnel && (
          <>
            <label>
              Tunnel type
              <div className="seg tunnel-mode">
                <button
                  type="button"
                  className={tunnelMode === "local" ? "on" : ""}
                  onClick={() => setTunnelMode("local")}
                >
                  Local <small>-L</small>
                </button>
                <button
                  type="button"
                  className={tunnelMode === "dynamic" ? "on" : ""}
                  onClick={() => setTunnelMode("dynamic")}
                >
                  Dynamic <small>-D</small>
                </button>
                <button
                  type="button"
                  className={tunnelMode === "remote" ? "on" : ""}
                  onClick={() => setTunnelMode("remote")}
                >
                  Remote <small>-R</small>
                </button>
              </div>
            </label>

            {tunnelMode === "local" && (
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
            )}

            {tunnelMode === "dynamic" && (
              <label>
                Local SOCKS port <small>— SOCKS5 proxy on this machine; 0 = auto</small>
                <input className="port" placeholder="0" value={localPort} onChange={(e) => setLocalPort(e.target.value)} />
              </label>
            )}

            {tunnelMode === "remote" && (
              <div className="tunnel-target">
                <label>
                  Server bind port <small>— port to open on the SSH server; 0 = server picks</small>
                  <input className="port" placeholder="0" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} />
                </label>
                <label>
                  Local target <small>— service on THIS machine to expose</small>
                  <div className="form-row">
                    <input placeholder="127.0.0.1" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} />
                    <input className="port" placeholder="port" value={localPort} onChange={(e) => setLocalPort(e.target.value)} />
                  </div>
                </label>
              </div>
            )}

            <div className="tunnel-preview">
              {tunnelMode === "local" && (
                <>
                  <code>127.0.0.1:{previewLocal}</code>
                  <Icon name="tunnel" size={13} />
                  <code>{remoteHost || "host"}:{remotePort || "port"}</code>
                </>
              )}
              {tunnelMode === "dynamic" && (
                <>
                  <code>socks5://127.0.0.1:{previewLocal}</code>
                  <Icon name="tunnel" size={13} />
                  <code>via SSH</code>
                </>
              )}
              {tunnelMode === "remote" && (
                <>
                  <code>server:{remotePort && remotePort !== "0" ? remotePort : "auto"}</code>
                  <Icon name="tunnel" size={13} />
                  <code>{remoteHost || "127.0.0.1"}:{localPort || "port"}</code>
                </>
              )}
            </div>
          </>
        )}

        {isDb && !eng.fileBased && !isS3 && (
          <label>
            {engine === "mongodb" ? "Password or mongodb:// URI" : "Password"}{" "}
            {editing ? "(leave blank to keep)" : ""}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {isS3 && (
          <label>
            Secret key {editing ? "(leave blank to keep)" : ""}
            {secretSaved && <span className="saved-tag">saved</span>}
            <input
              type="password"
              value={secretSaved && !secretEditing ? "••••••••" : password}
              onFocus={() => {
                if (secretSaved && !secretEditing) {
                  setSecretEditing(true);
                  setPassword("");
                }
              }}
              onBlur={() => {
                // Nothing typed after clicking in — restore the saved dots.
                if (secretSaved && secretEditing && !password) setSecretEditing(false);
              }}
              onChange={(e) => {
                setSecretEditing(true);
                setPassword(e.target.value);
              }}
            />
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
            {saving ? (
              <>
                <Spinner size={13} /> Saving…
              </>
            ) : (
              "Save"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
