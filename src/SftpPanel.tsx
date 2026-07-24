import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { resolveJump, type S3Preview, type SftpEntry, type SftpProfile, type SshProfile } from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon } from "./Icon";
import { FilePreview } from "./FilePreview";
import { ConnectLauncher } from "./SessionUI";
import { AskModal, type AskOptions } from "./AskModal";
import { maskText } from "./privacy";
import { subscribeSettings } from "./settings";
import { newJobId } from "./transfers";
import { TransferList } from "./TransferList";

/** The user the SFTP server effectively runs as: the sudo target (a `-u` user,
 *  or root) when an elevated command is set, otherwise the SSH login user. */
function effectiveSftpUser(loginUser: string, sftpCommand?: string | null): string {
  const cmd = (sftpCommand ?? "").trim();
  if (!cmd) return loginUser;
  const dashU = cmd.match(/\bsudo\b.*?\s-u\s+(\S+)/);
  if (dashU) return dashU[1];
  if (/^sudo(\s|$)/.test(cmd)) return "root";
  return loginUser;
}

/** chmod rows: octal bits for each who × permission. */
const PERM_ROWS = [
  { who: "Owner", r: 0o400, w: 0o200, x: 0o100 },
  { who: "Group", r: 0o040, w: 0o020, x: 0o010 },
  { who: "Others", r: 0o004, w: 0o002, x: 0o001 },
] as const;

function joinPath(dir: string, name: string): string {
  if (dir === "/") return `/${name}`;
  return `${dir.replace(/\/$/, "")}/${name}`;
}

function parentPath(dir: string): string {
  if (dir === "/" || !dir.includes("/")) return "/";
  const p = dir.replace(/\/$/, "").split("/").slice(0, -1).join("/");
  return p === "" ? "/" : p;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function SftpPanel({
  prefill,
  sftpProfiles = [],
  sshProfiles = [],
  autoConnect,
  onConnInfo,
  onSession,
  dcSignal,
}: {
  prefill?: SftpProfile | null;
  sftpProfiles?: SftpProfile[];
  sshProfiles?: SshProfile[];
  autoConnect?: boolean;
  onConnInfo?: (info: SshProfile) => void;
  onSession?: (label: string) => void;
  dcSignal?: number;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<AuthValue>(emptyAuth());
  const [status, setStatus] = useState("disconnected");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [error, setError] = useState("");
  const [lastError, setLastError] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [manual, setManual] = useState(false);
  const [connLabel, setConnLabel] = useState("");
  const [ask, setAsk] = useState<AskOptions | null>(null);
  // Permission (chmod) editor target + working mode (octal bits).
  const [chmod, setChmod] = useState<{ entry: SftpEntry; mode: number } | null>(null);
  // In-panel file preview (replaces the grid while shown). Held with the folder
  // it was opened from so the meta line shows the full remote path.
  const [preview, setPreview] = useState<{ entry: SftpEntry; dir: string; data: S3Preview } | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  // Bumped on every preview request AND on navigate/refresh/disconnect, so a
  // slow preview fetch that resolves after the user moved on is dropped instead
  // of clobbering the current view (the grid stays interactive during the read).
  const previewGen = useRef(0);
  // Names/paths render through maskText, so re-render when privacy settings change.
  const [, setPrivacyRev] = useState(0);
  useEffect(() => subscribeSettings(() => setPrivacyRev((n) => n + 1)), []);

  // Live path for async transfer completions: an upload's refresh-on-done
  // must be skipped when the user has navigated elsewhere while it ran.
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setAuth({ ...emptyAuth(), auth: prefill.auth });
      setSelectedProfileId(prefill.id);
      if (!prefill.id) setManual(true);
      else if (autoConnect) connect(prefill);
    } else {
      setManual(sftpProfiles.length === 0 && sshProfiles.length === 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  async function refresh(id: string, p: string) {
    setError("");
    previewGen.current++; // invalidate any in-flight preview fetch
    setPreview(null);
    setPreviewLoading(false);
    try {
      const list = await api.sftpList(id, p);
      setEntries(list);
      setPath(p);
    } catch (e) {
      setError(String(e));
    }
  }

  async function connect(override?: SftpProfile) {
    setLastError("");
    setStatus("connecting…");
    // Show who the session effectively runs as (user@host), accounting for sudo
    // elevation — e.g. "root@192.168.110.61".
    const loginUser = override ? override.user : user;
    const labelHost = override ? override.host : host;
    const cmd = override ? override.sftp_command : prefill?.sftp_command;
    const label = `${effectiveSftpUser(loginUser, cmd)}@${labelHost}`;
    try {
      const id = await api.sftpConnect(
        override
          ? {
              host: override.host,
              port: override.port,
              user: override.user,
              auth: override.auth,
              profile_id: override.id,
              jump: resolveJump(override, sshProfiles),
              sftp_command: override.sftp_command ?? null,
            }
          : {
              host,
              port: Number(port),
              user,
              auth: auth.auth,
              password: auth.password || null,
              key: auth.key || null,
              passphrase: auth.passphrase || null,
              profile_id: prefill?.id || null,
              jump: resolveJump(prefill, sshProfiles),
              sftp_command: prefill?.sftp_command ?? null,
            },
      );
      setSessionId(id);
      setConnLabel(label);
      setStatus("connected");
      onConnInfo?.(
        override ?? {
          id: prefill?.id ?? "",
          name: prefill?.name ?? label,
          host,
          port: Number(port),
          user,
          auth: auth.auth,
        },
      );
      const home = await api.sftpHome(id).catch(() => "/");
      await refresh(id, home || "/");
    } catch (e) {
      setStatus("error");
      setLastError(String(e));
    }
  }

  // SFTP runs over SSH, so saved SSH hosts are valid SFTP targets too. Offer both
  // (secrets for all profile kinds live under the shared "ssh" keychain entry).
  const presetProfiles: SftpProfile[] = [...sftpProfiles, ...sshProfiles];

  function connectPreset() {
    const p = presetProfiles.find((s) => s.id === selectedProfileId);
    if (p) connect(p);
  }

  async function disconnect() {
    if (sessionId) {
      await api.sftpClose(sessionId);
      setSessionId(null);
      setEntries([]);
      previewGen.current++; // drop any in-flight preview
      setPreview(null);
      setPreviewLoading(false);
    }
    setStatus("disconnected");
  }

  async function enter(e: SftpEntry) {
    if (!sessionId) return;
    if (e.is_dir) await refresh(sessionId, joinPath(path, e.name));
    else await openPreview(e);
  }

  async function openPreview(e: SftpEntry) {
    if (!sessionId) return;
    // Snapshot the request identity: a fetch that resolves after the user
    // navigated, deleted, disconnected, or opened a different file must not
    // clobber the current view.
    const gen = ++previewGen.current;
    const dir = path;
    const sid = sessionId;
    setError("");
    setPreviewLoading(true);
    try {
      const data = await api.sftpPreview(sid, joinPath(dir, e.name));
      if (previewGen.current !== gen) return; // stale — dropped
      setPreview({ entry: e, dir, data });
    } catch (err) {
      if (previewGen.current === gen) setError(String(err));
    } finally {
      if (previewGen.current === gen) setPreviewLoading(false);
    }
  }

  async function download(e: SftpEntry, dir: string = path) {
    if (!sessionId) return;
    const local = await save({ defaultPath: e.name });
    if (!local) return;
    // Resolve against the explicit `dir` (the previewed file's folder), not the
    // live `path` — which may have moved on while a preview was open.
    // Non-blocking: progress (and cancel) live in the transfer queue.
    void api
      .sftpDownload(sessionId, joinPath(dir, e.name), local, newJobId())
      .catch((err) => setError(String(err)));
  }

  // Recursively download a folder: pick a LOCAL destination directory and the
  // remote tree is mirrored into <dest>/<folder>/… as one cancellable transfer.
  async function downloadDir(e: SftpEntry, dir: string = path) {
    if (!sessionId) return;
    const dest = await open({ directory: true });
    if (!dest || Array.isArray(dest)) return;
    void api
      .sftpDownloadDir(sessionId, joinPath(dir, e.name), dest, newJobId())
      .catch((err) => setError(String(err)));
  }

  // Split on both separators so a Windows path (C:\…\file) yields just the name.
  const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || "upload";

  async function upload() {
    if (!sessionId) return;
    const sel = await open({ multiple: true });
    if (!sel) return;
    const locals = Array.isArray(sel) ? sel : [sel];
    if (locals.length === 0) return;
    const sid = sessionId;
    const dir = path;
    // Non-blocking: each file is its own transfer-queue row (progress + cancel);
    // refresh the listing once every upload has settled (if still in this folder).
    const doPut = () => {
      const jobs = locals.map((local) =>
        api
          .sftpUpload(sid, local, joinPath(dir, baseName(local)), newJobId())
          .catch((err) => setError(String(err))),
      );
      void Promise.allSettled(jobs).then(() => {
        if (pathRef.current === dir) return refresh(sid, dir);
      });
    };
    // A PUT silently clobbers, so confirm known collisions first (only the loaded
    // listing is checked — unloaded entries can't be). One prompt covers them all.
    const clashes = locals.filter((l) => entries.some((e) => !e.is_dir && e.name === baseName(l)));
    if (clashes.length > 0) {
      setAsk({
        title: clashes.length === 1 ? "Replace file" : "Replace files",
        label: `${clashes.length} file${clashes.length === 1 ? "" : "s"} already exist here. Replace? This cannot be undone.`,
        confirmText: "Replace",
        danger: true,
        run: doPut,
      });
    } else {
      doPut();
    }
  }

  // Recursively upload a local folder: the tree is mirrored into <path>/<folder>/…
  // as one cancellable transfer.
  async function uploadDir() {
    if (!sessionId) return;
    const local = await open({ directory: true });
    if (!local || Array.isArray(local)) return;
    const sid = sessionId;
    const dir = path;
    const folder = baseName(local);
    const doPut = () => {
      void api
        .sftpUploadDir(sid, local, dir, newJobId())
        .then(() => {
          if (pathRef.current === dir) return refresh(sid, dir);
        })
        .catch((err) => setError(String(err)));
    };
    // Uploading into an existing remote entry of the same name may overwrite files
    // inside it — confirm when the loaded listing already shows that name.
    if (entries.some((e) => e.name === folder)) {
      setAsk({
        title: "Merge folder",
        label: `"${folder}" already exists here. Files inside may be overwritten. Continue?`,
        confirmText: "Upload",
        danger: true,
        run: doPut,
      });
    } else {
      doPut();
    }
  }

  function mkdir() {
    if (!sessionId) return;
    setAsk({
      title: "New folder",
      initial: "",
      confirmText: "Create",
      run: async (name) => {
        if (!sessionId || !name.trim()) return;
        try {
          await api.sftpMkdir(sessionId, joinPath(path, name.trim()));
          await refresh(sessionId, path);
        } catch (err) {
          setError(String(err));
        }
      },
    });
  }

  function rename(e: SftpEntry) {
    if (!sessionId) return;
    setAsk({
      title: "Rename",
      initial: e.name,
      confirmText: "Rename",
      run: async (name) => {
        if (!sessionId || !name.trim() || name === e.name) return;
        try {
          await api.sftpRename(sessionId, joinPath(path, e.name), joinPath(path, name.trim()));
          await refresh(sessionId, path);
        } catch (err) {
          setError(String(err));
        }
      },
    });
  }

  function remove(e: SftpEntry) {
    if (!sessionId) return;
    setAsk({
      title: `Delete ${e.name}?`,
      label: "This cannot be undone.",
      confirmText: "Delete",
      danger: true,
      run: async () => {
        if (!sessionId) return;
        try {
          await api.sftpRemove(sessionId, joinPath(path, e.name), e.is_dir);
          await refresh(sessionId, path);
        } catch (err) {
          setError(String(err));
        }
      },
    });
  }

  async function applyChmod() {
    if (!sessionId || !chmod) return;
    try {
      await api.sftpChmod(sessionId, joinPath(path, chmod.entry.name), chmod.mode & 0o7777);
      await refresh(sessionId, path);
      setChmod(null);
    } catch (err) {
      setError(String(err));
    }
  }

  const connecting = status === "connecting…";

  useEffect(() => {
    onSession?.(sessionId ? connLabel : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, connLabel]);

  useEffect(() => {
    if (dcSignal && dcSignal > 0) disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dcSignal]);

  if (!sessionId) {
    return (
      <div className="panel">
        <ConnectLauncher
          icon="sftp"
          title="Connect SFTP"
          presets={presetProfiles.map((p) => ({ id: p.id, label: p.name || `${p.user}@${p.host}` }))}
          selectedId={selectedProfileId}
          onSelect={setSelectedProfileId}
          onConnect={connectPreset}
          connecting={connecting}
          manualOpen={manual}
          onToggleManual={() => setManual((v) => !v)}
          error={lastError}
        >
          <div className="form-row">
            <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
            <input className="port" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
            <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <AuthFields value={auth} onChange={setAuth} saved={!!prefill?.id} />
          <button onClick={() => connect()} disabled={connecting}>
            <Icon name="play" size={14} /> {connecting ? "Connecting…" : "Connect"}
          </button>
        </ConnectLauncher>
      </div>
    );
  }

  return (
    <div className="panel">
      {sessionId && (
        <>
          <div className="form-row">
            <button
              className="ghost"
              onClick={() => refresh(sessionId, parentPath(path))}
              disabled={path === "/"}
            >
              <Icon name="folderUp" size={14} /> Up
            </button>
            <code className="path">{maskText(path)}</code>
            <button className="ghost" onClick={() => refresh(sessionId, path)}>
              <Icon name="refresh" size={14} /> Refresh
            </button>
            <button onClick={upload}>
              <Icon name="upload" size={14} /> Upload
            </button>
            <button className="ghost" onClick={uploadDir}>
              <Icon name="upload" size={14} /> Upload folder
            </button>
            <button className="ghost" onClick={mkdir}>
              <Icon name="folder" size={14} /> New folder
            </button>
          </div>
          {error && <pre className="error">{error}</pre>}
          <TransferList />
          {previewLoading && !preview && <div className="mongo-meta">Loading preview…</div>}
          {preview ? (
            <FilePreview
              data={preview.data}
              name={preview.entry.name}
              meta={maskText(joinPath(preview.dir, preview.entry.name))}
              onBack={() => setPreview(null)}
              onDownload={() => download(preview.entry, preview.dir)}
            />
          ) : (
          <div className="grid-wrap sftp-wrap">
            <table className="grid sftp">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Perms</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.name}>
                    <td className="clickable name-cell" onClick={() => enter(e)}>
                      <Icon name={e.is_dir ? "folder" : "table"} size={14} className="file-glyph" />
                      {maskText(e.name)}
                    </td>
                    <td>{e.is_dir ? "" : fmtSize(e.size)}</td>
                    <td
                      className="clickable"
                      title="Change permissions"
                      onClick={() => setChmod({ entry: e, mode: e.permissions & 0o7777 })}
                    >
                      {(e.permissions & 0o777).toString(8)}
                    </td>
                    <td className="row-actions">
                      {!e.is_dir && (
                        <button className="icon" title="Preview" onClick={() => openPreview(e)}>
                          <Icon name="eye" size={14} />
                        </button>
                      )}
                      <button
                        className="icon"
                        title={e.is_dir ? "Download folder" : "Download"}
                        onClick={() => (e.is_dir ? downloadDir(e) : download(e))}
                      >
                        <Icon name="download" size={14} />
                      </button>
                      <button
                        className="icon"
                        title="Permissions"
                        onClick={() => setChmod({ entry: e, mode: e.permissions & 0o7777 })}
                      >
                        <Icon name="lock" size={14} />
                      </button>
                      <button className="icon" title="Rename" onClick={() => rename(e)}>
                        <Icon name="edit" size={14} />
                      </button>
                      <button className="icon" title="Delete" onClick={() => remove(e)}>
                        <Icon name="trash" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
      {!sessionId && error && <pre className="error">{error}</pre>}
      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}

      {chmod && (
        <div className="modal-backdrop" onClick={() => setChmod(null)}>
          <div className="modal chmod-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Permissions — {maskText(chmod.entry.name)}</h3>
            <table className="chmod-grid">
              <thead>
                <tr>
                  <th></th>
                  <th>Read</th>
                  <th>Write</th>
                  <th>Execute</th>
                </tr>
              </thead>
              <tbody>
                {PERM_ROWS.map((row) => (
                  <tr key={row.who}>
                    <td>{row.who}</td>
                    {(["r", "w", "x"] as const).map((k) => (
                      <td key={k}>
                        <input
                          type="checkbox"
                          checked={(chmod.mode & row[k]) !== 0}
                          onChange={() =>
                            setChmod((c) =>
                              c
                                ? {
                                    ...c,
                                    mode: c.mode & row[k] ? c.mode & ~row[k] : c.mode | row[k],
                                  }
                                : c,
                            )
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <label className="chmod-octal">
              Octal
              <input
                value={(chmod.mode & 0o7777).toString(8)}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (!/^[0-7]{0,4}$/.test(v)) return;
                  setChmod((c) => (c ? { ...c, mode: v === "" ? 0 : parseInt(v, 8) } : c));
                }}
              />
            </label>
            {error && <pre className="error">{error}</pre>}
            <div className="form-row end">
              <button className="ghost" onClick={() => setChmod(null)}>
                Cancel
              </button>
              <button onClick={applyChmod}>Apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
