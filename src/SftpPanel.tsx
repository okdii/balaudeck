import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import type { SftpEntry, SshProfile } from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon, statusClass } from "./Icon";

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

export function SftpPanel({ prefill }: { prefill?: SshProfile | null }) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<AuthValue>(emptyAuth());
  const [status, setStatus] = useState("disconnected");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setAuth({ ...emptyAuth(), auth: prefill.auth });
    }
  }, [prefill]);

  async function refresh(id: string, p: string) {
    setError("");
    try {
      const list = await api.sftpList(id, p);
      setEntries(list);
      setPath(p);
    } catch (e) {
      setError(String(e));
    }
  }

  async function connect() {
    setError("");
    setStatus("connecting…");
    try {
      const id = await api.sftpConnect({
        host,
        port: Number(port),
        user,
        auth: auth.auth,
        password: auth.password || null,
        key: auth.key || null,
        passphrase: auth.passphrase || null,
        profile_id: prefill?.id || null,
      });
      setSessionId(id);
      setStatus("connected");
      const home = await api.sftpHome(id).catch(() => "/");
      await refresh(id, home || "/");
    } catch (e) {
      setStatus("error");
      setError(String(e));
    }
  }

  async function disconnect() {
    if (sessionId) {
      await api.sftpClose(sessionId);
      setSessionId(null);
      setEntries([]);
      setStatus("disconnected");
    }
  }

  async function enter(e: SftpEntry) {
    if (!sessionId) return;
    if (e.is_dir) refresh(sessionId, joinPath(path, e.name));
  }

  async function download(e: SftpEntry) {
    if (!sessionId) return;
    const local = await save({ defaultPath: e.name });
    if (!local) return;
    try {
      await api.sftpDownload(sessionId, joinPath(path, e.name), local);
    } catch (err) {
      setError(String(err));
    }
  }

  async function upload() {
    if (!sessionId) return;
    const local = await open({ multiple: false });
    if (!local || Array.isArray(local)) return;
    const name = local.split("/").pop() || "upload";
    try {
      await api.sftpUpload(sessionId, local, joinPath(path, name));
      refresh(sessionId, path);
    } catch (err) {
      setError(String(err));
    }
  }

  async function mkdir() {
    if (!sessionId) return;
    const name = prompt("New folder name:");
    if (!name) return;
    try {
      await api.sftpMkdir(sessionId, joinPath(path, name));
      refresh(sessionId, path);
    } catch (err) {
      setError(String(err));
    }
  }

  async function rename(e: SftpEntry) {
    if (!sessionId) return;
    const name = prompt("Rename to:", e.name);
    if (!name || name === e.name) return;
    try {
      await api.sftpRename(sessionId, joinPath(path, e.name), joinPath(path, name));
      refresh(sessionId, path);
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove(e: SftpEntry) {
    if (!sessionId) return;
    if (!confirm(`Delete ${e.name}?`)) return;
    try {
      await api.sftpRemove(sessionId, joinPath(path, e.name), e.is_dir);
      refresh(sessionId, path);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="panel">
      <div className="form-row">
        <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
        <input className="port" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
        <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
        <button onClick={connect}>
          <Icon name="play" size={14} /> Connect
        </button>
        <button className="ghost" onClick={disconnect}>
          Close
        </button>
        <span className="status">
          <span className={"dot " + statusClass(status)} />
          {status}
        </span>
      </div>
      <AuthFields value={auth} onChange={setAuth} saved={!!prefill?.id} />

      {sessionId && (
        <>
          <div className="form-row">
            <button className="ghost" onClick={() => refresh(sessionId, parentPath(path))} disabled={path === "/"}>
              <Icon name="folderUp" size={14} /> Up
            </button>
            <code className="path">{path}</code>
            <button className="ghost" onClick={() => refresh(sessionId, path)}>
              <Icon name="refresh" size={14} /> Refresh
            </button>
            <button onClick={upload}>
              <Icon name="upload" size={14} /> Upload
            </button>
            <button className="ghost" onClick={mkdir}>
              <Icon name="folder" size={14} /> New folder
            </button>
          </div>
          {error && <pre className="error">{error}</pre>}
          <div className="grid-wrap">
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
                      {e.name}
                    </td>
                    <td>{e.is_dir ? "" : fmtSize(e.size)}</td>
                    <td>{(e.permissions & 0o777).toString(8)}</td>
                    <td className="row-actions">
                      {!e.is_dir && (
                        <button className="icon" title="Download" onClick={() => download(e)}>
                          <Icon name="download" size={14} />
                        </button>
                      )}
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
        </>
      )}
      {!sessionId && error && <pre className="error">{error}</pre>}
    </div>
  );
}
