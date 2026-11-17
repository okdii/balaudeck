import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { Icon, Spinner } from "./Icon";
import { maskText } from "./privacy";
import {
  DB_ENGINES,
  emptyDbProfile,
  emptySshProfile,
  type DbEngine,
  type ProfileStore,
  type SshProfile,
} from "./types";

type Source = "dbeaver" | "navicat" | "tableplus";

interface ExtSsh {
  host: string;
  port: number;
  user: string;
  password: string | null;
  key_path: string | null;
}
interface ExtConn {
  name: string;
  engine: string;
  supported: boolean;
  host: string;
  port: number;
  user: string;
  database: string | null;
  file: string | null;
  password: string | null;
  folder: string | null;
  ssh: ExtSsh | null;
}
interface ExtScan {
  source: Source;
  path: string;
  connections: ExtConn[];
  notes: string[];
}

const SOURCES: { id: Source; label: string; hint: string; color: string }[] = [
  {
    id: "dbeaver",
    label: "DBeaver",
    hint: "Reads your DBeaver workspace automatically (connections, saved passwords, SSH tunnels).",
    color: "#8a6a3a",
  },
  {
    id: "navicat",
    label: "Navicat",
    hint: "In Navicat: File → Export Connections… (tick “Export password”), then choose the .ncx file.",
    color: "#2f9e44",
  },
  {
    id: "tableplus",
    label: "TablePlus",
    hint: "Reads TablePlus's saved connections on this Mac. Passwords stay in TablePlus's keychain.",
    color: "#f59f00",
  },
];

const LABEL: Record<Source, string> = { dbeaver: "DBeaver", navicat: "Navicat", tableplus: "TablePlus" };

const keyOf = (engine: string, host: string, port: number, user: string, db: string | null | undefined, file?: string | null) =>
  [engine, host.toLowerCase(), port, user, db ?? "", file ?? ""].join("|");

/**
 * Import saved connections from DBeaver / Navicat / TablePlus. The backend
 * reads the other app's files (read-only); this lists them, the user picks,
 * and they're saved as normal BalauDeck profiles (secrets → keychain). A
 * connection that went through an SSH tunnel becomes an SSH profile + a DB
 * profile that uses it.
 */
export function ExternalImportModal({
  store,
  onClose,
  onImported,
}: {
  store: ProfileStore;
  onClose: () => void;
  onImported: () => void;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [scan, setScan] = useState<ExtScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [useFolder, setUseFolder] = useState(true);
  const [result, setResult] = useState<{ db: number; ssh: number; skipped: number; failed: string[] } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // Connections already in BalauDeck (same engine/host/port/user/db) are
  // flagged and unticked by default, so a re-import doesn't duplicate.
  const existing = useMemo(
    () => new Set(store.db.map((d) => keyOf(d.engine ?? "mysql", d.host, d.port, d.user, d.database, d.file))),
    [store.db],
  );
  const isDup = (c: ExtConn) => existing.has(keyOf(c.engine, c.host, c.port, c.user, c.database, c.file));

  async function runScan(src: Source, path: string | null) {
    setSource(src);
    setError("");
    setScan(null);
    setResult(null);
    setBusy(true);
    try {
      const s = await invoke<ExtScan>("ext_import_scan", { source: src, path });
      setScan(s);
      setPicked(new Set(s.connections.map((c, i) => (c.supported && !isDup(c) ? i : -1)).filter((i) => i >= 0)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseFile(src: Source) {
    const filters =
      src === "navicat"
        ? [{ name: "Navicat export", extensions: ["ncx"] }]
        : src === "dbeaver"
          ? [{ name: "DBeaver data-sources.json", extensions: ["json"] }]
          : [{ name: "TablePlus Connections.plist", extensions: ["plist"] }];
    const p = await open({ multiple: false, filters });
    if (p && !Array.isArray(p)) await runScan(src, p);
  }

  function pickSource(src: Source) {
    if (src === "navicat") void chooseFile(src);
    else void runScan(src, null);
  }

  async function doImport() {
    if (!scan) return;
    setBusy(true);
    setError("");
    let db = 0;
    let sshCount = 0;
    let skipped = 0;
    const failed: string[] = [];
    try {
      let folderId: string | null = null;
      if (useFolder) {
        const f = await api.folderCreate(`Imported from ${LABEL[scan.source]}`);
        folderId = f.id;
      }
      // Reuse an SSH profile for the same bastion (existing or made this run).
      const sshByKey = new Map<string, string>();
      for (const s of store.ssh) sshByKey.set(`${s.host.toLowerCase()}|${s.port}|${s.user}`, s.id);

      for (const i of Array.from(picked).sort((a, b) => a - b)) {
        const c = scan.connections[i];
        if (!c.supported) {
          skipped++;
          continue;
        }
        try {
          let viaSsh: string | null = null;
          if (c.ssh && c.ssh.host) {
            const k = `${c.ssh.host.toLowerCase()}|${c.ssh.port}|${c.ssh.user}`;
            viaSsh = sshByKey.get(k) ?? null;
            if (!viaSsh) {
              let key: string | null = null;
              if (c.ssh.key_path) {
                key = await invoke<string>("ext_import_read_key", { path: c.ssh.key_path }).catch(() => null);
              }
              const sp: SshProfile = {
                ...emptySshProfile(),
                name: `${c.ssh.user || "ssh"}@${c.ssh.host}`,
                host: c.ssh.host,
                port: c.ssh.port || 22,
                user: c.ssh.user,
                auth: c.ssh.key_path ? "key" : "password",
                folder_id: folderId,
              };
              const saved = await api.sshProfileSave(sp, c.ssh.password, key);
              viaSsh = saved.id;
              sshByKey.set(k, saved.id);
              sshCount++;
            }
          }
          const engine = c.engine as DbEngine;
          const base = emptyDbProfile(engine);
          await api.dbProfileSave(
            {
              ...base,
              name: c.name,
              host: DB_ENGINES[engine].fileBased ? "" : c.host,
              port: c.port || base.port,
              user: c.user,
              database: c.database,
              file: c.file,
              via_ssh_profile_id: viaSsh,
              folder_id: folderId,
            },
            c.password,
          );
          db++;
        } catch (e) {
          failed.push(`${c.name}: ${String(e)}`);
        }
      }
      setResult({ db, ssh: sshCount, skipped, failed });
      onImported();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const conns = scan?.connections ?? [];
  const selectable = conns.map((c, i) => (c.supported ? i : -1)).filter((i) => i >= 0);
  const allOn = selectable.length > 0 && selectable.every((i) => picked.has(i));
  const toggle = (i: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal xi-modal" onClick={(e) => e.stopPropagation()}>
        <div className="xi-head">
          <h3>Import connections</h3>
          <button className="icon" title="Close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <p className="iw-hint">Bring your saved database connections over from another client. Nothing in the other app is changed.</p>

        <div className="xi-sources">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              className={"xi-source" + (source === s.id ? " on" : "")}
              onClick={() => pickSource(s.id)}
              disabled={busy}
            >
              <span className="xi-badge" style={{ background: s.color }}>
                {s.label[0]}
              </span>
              <span className="xi-source-main">
                <b>{s.label}</b>
                <small>{s.hint}</small>
              </span>
            </button>
          ))}
        </div>

        {busy && !scan && (
          <div className="xi-status">
            <Spinner size={14} /> Reading…
          </div>
        )}
        {error && (
          <div className="xi-error">
            <pre className="error">{error}</pre>
            {source && (
              <button onClick={() => chooseFile(source)}>
                <Icon name="folder" size={13} /> Choose file…
              </button>
            )}
          </div>
        )}

        {scan && !result && (
          <>
            <div className="xi-path">
              <span title={scan.path}>{scan.path}</span>
              <button className="ghost" onClick={() => source && chooseFile(source)} disabled={busy}>
                Other file…
              </button>
            </div>
            {scan.notes.map((n) => (
              <div className="iw-tip" key={n}>
                <Icon name="info" size={13} /> {n}
              </div>
            ))}
            {conns.length === 0 ? (
              <div className="iw-empty">No connections found in this file.</div>
            ) : (
              <div className="xi-list">
                <div className="xi-row xi-row-head">
                  <input
                    type="checkbox"
                    checked={allOn}
                    onChange={() => setPicked(allOn ? new Set() : new Set(selectable))}
                    title="Select all"
                  />
                  <span>Name</span>
                  <span>Engine</span>
                  <span>Host</span>
                  <span>Password</span>
                </div>
                {conns.map((c, i) => {
                  const meta = c.supported ? DB_ENGINES[c.engine as DbEngine] : null;
                  const dup = c.supported && isDup(c);
                  return (
                    <label className={"xi-row" + (c.supported ? "" : " off")} key={i} title={c.supported ? undefined : "This engine isn't supported by BalauDeck"}>
                      <input type="checkbox" disabled={!c.supported} checked={picked.has(i)} onChange={() => toggle(i)} />
                      <span className="xi-name">
                        {maskText(c.name)}
                        {c.folder && <small> · {maskText(c.folder)}</small>}
                        {dup && <span className="xi-dup">already added</span>}
                      </span>
                      <span>
                        <span className="xi-engine" style={meta ? { color: meta.color, borderColor: meta.color } : undefined}>
                          {meta ? meta.badge : c.engine || "?"}
                        </span>
                      </span>
                      <span className="xi-host">
                        {meta?.fileBased ? maskText(c.file ?? "") : maskText(`${c.user ? c.user + "@" : ""}${c.host}:${c.port}`)}
                        {c.ssh && <small>via SSH {maskText(`${c.ssh.user}@${c.ssh.host}`)}</small>}
                      </span>
                      <span className="xi-pw">{c.password ? <Icon name="check" size={13} /> : "—"}</span>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="xi-foot">
              <label className="opt-check">
                <input type="checkbox" checked={useFolder} onChange={(e) => setUseFolder(e.target.checked)} /> Put them in a folder
                “Imported from {LABEL[scan.source]}”
              </label>
              <span className="xi-spacer" />
              <button onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="primary" onClick={doImport} disabled={busy || picked.size === 0}>
                {busy ? <Spinner size={13} /> : <Icon name="download" size={14} />} Import {picked.size || ""}
              </button>
            </div>
          </>
        )}

        {result && (
          <div className="xi-result">
            <Icon name="check" size={18} />
            <div>
              <b>
                Imported {result.db} connection{result.db === 1 ? "" : "s"}
                {result.ssh > 0 && ` + ${result.ssh} SSH host${result.ssh === 1 ? "" : "s"}`}
              </b>
              {result.failed.length > 0 && <pre className="error">{result.failed.join("\n")}</pre>}
            </div>
            <span className="xi-spacer" />
            <button className="primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
