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
  type SshAuth,
  type SshProfile,
} from "./types";
import { storeBuild } from "./updater";

type Source = "dbeaver" | "navicat" | "tableplus" | "sshconfig";

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
  /** ssh config hosts only. */
  auth?: SshAuth | null;
  jump?: string | null;
}
interface ExtScan {
  source: Source;
  path: string;
  connections: ExtConn[];
  notes: string[];
}

const SOURCES: { id: Source; label: string; hint: string; color: string }[] = [
  ...(storeBuild
    ? []
    : [
        {
          id: "sshconfig" as Source,
          label: "SSH config",
          hint: "Reads ~/.ssh/config (Host, HostName, User, Port, IdentityFile, ProxyJump, Include) — SSH hosts.",
          color: "#3b82f6",
        },
      ]),
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

const LABEL: Record<Source, string> = {
  dbeaver: "DBeaver",
  navicat: "Navicat",
  tableplus: "TablePlus",
  sshconfig: "SSH config",
};

const sshKeyOf = (host: string, port: number, user: string) => `${host.toLowerCase()}|${port}|${user}`;

/** "user@host:port" / "host" → parts (ProxyJump syntax). */
function parseHop(s: string): { user: string; host: string; port: number } {
  const at = s.lastIndexOf("@");
  const user = at >= 0 ? s.slice(0, at) : "";
  let rest = at >= 0 ? s.slice(at + 1) : s;
  let port = 22;
  const m = rest.match(/^\[(.+)\]:(\d+)$/) || rest.match(/^([^:]+):(\d+)$/);
  if (m) {
    rest = m[1];
    port = Number(m[2]);
  }
  return { user, host: rest, port };
}

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
  const existingSsh = useMemo(() => new Set(store.ssh.map((s) => sshKeyOf(s.host, s.port, s.user))), [store.ssh]);
  const isDup = (c: ExtConn) =>
    c.engine === "ssh"
      ? existingSsh.has(sshKeyOf(c.host, c.port, c.user))
      : existing.has(keyOf(c.engine, c.host, c.port, c.user, c.database, c.file));

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
          : src === "tableplus"
            ? [{ name: "TablePlus Connections.plist", extensions: ["plist"] }]
            : undefined;
    const p = await open({ multiple: false, filters });
    if (p && !Array.isArray(p)) await runScan(src, p);
  }

  function pickSource(src: Source) {
    if (src === "navicat") void chooseFile(src);
    else void runScan(src, null);
  }

  /** ~/.ssh/config hosts → SSH profiles; ProxyJump to another imported (or
   *  existing) host links to that profile, otherwise becomes an inline jump. */
  async function importSshHosts(folderId: string | null) {
    if (!scan) return { ssh: 0, failed: [] as string[] };
    const failed: string[] = [];
    let n = 0;
    const byAlias = new Map<string, string>();
    for (const s of store.ssh) byAlias.set(s.name, s.id);
    const chosen = Array.from(picked)
      .sort((a, b) => a - b)
      .map((i) => scan.connections[i]);
    // Jump targets first, so a host can link to its bastion's new profile.
    const jumpNames = new Set(chosen.map((c) => c.jump).filter(Boolean) as string[]);
    chosen.sort((a, b) => Number(jumpNames.has(b.name)) - Number(jumpNames.has(a.name)));
    for (const c of chosen) {
      try {
        let key: string | null = null;
        const kp = c.ssh?.key_path;
        if (c.auth === "key" && kp) {
          key = await invoke<string>("ext_import_read_key", { path: kp }).catch(() => null);
        }
        const auth: SshAuth = c.auth === "key" && !key ? "password" : (c.auth ?? "password");
        let jumpFields: Partial<SshProfile> = {};
        if (c.jump) {
          const jid = byAlias.get(c.jump);
          if (jid) jumpFields = { jump_profile_id: jid };
          else if (scan.connections.some((x) => x.name === c.jump)) {
            const t = scan.connections.find((x) => x.name === c.jump)!;
            jumpFields = { jump_host: t.host, jump_port: t.port, jump_user: t.user, jump_auth: t.auth ?? "agent" };
          } else {
            const h = parseHop(c.jump);
            jumpFields = { jump_host: h.host, jump_port: h.port, jump_user: h.user || c.user, jump_auth: "agent" };
          }
        }
        const sp: SshProfile = {
          ...emptySshProfile(),
          name: c.name,
          host: c.host,
          port: c.port || 22,
          user: c.user,
          auth,
          folder_id: folderId,
          ...jumpFields,
        };
        const saved = await api.sshProfileSave(sp, null, key);
        byAlias.set(c.name, saved.id);
        n++;
      } catch (e) {
        failed.push(`${c.name}: ${String(e)}`);
      }
    }
    return { ssh: n, failed };
  }

  async function doImport() {
    if (!scan) return;
    if (scan.source === "sshconfig") {
      setBusy(true);
      setError("");
      try {
        const folderId = useFolder ? (await api.folderCreate("Imported from SSH config")).id : null;
        const r = await importSshHosts(folderId);
        setResult({ db: 0, ssh: r.ssh, skipped: 0, failed: r.failed });
        onImported();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
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
        <p className="iw-hint">Bring your saved connections over from another client or your SSH config. Nothing in the other app is changed.</p>

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
                  <span>{scan.source === "sshconfig" ? "Type" : "Engine"}</span>
                  <span>Host</span>
                  <span>{scan.source === "sshconfig" ? "Auth" : "Password"}</span>
                </div>
                {conns.map((c, i) => {
                  const isSsh = c.engine === "ssh";
                  const meta = c.supported && !isSsh ? DB_ENGINES[c.engine as DbEngine] : null;
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
                          {meta ? meta.badge : isSsh ? "SSH" : c.engine || "?"}
                        </span>
                      </span>
                      <span className="xi-host">
                        {meta?.fileBased ? maskText(c.file ?? "") : maskText(`${c.user ? c.user + "@" : ""}${c.host}:${c.port}`)}
                        {c.ssh && !isSsh && <small>via SSH {maskText(`${c.ssh.user}@${c.ssh.host}`)}</small>}
                        {isSsh && c.jump && <small>via {maskText(c.jump)}</small>}
                      </span>
                      <span className="xi-pw">
                        {isSsh ? (
                          <small title={c.ssh?.key_path ?? undefined}>{c.auth === "key" ? "key" : c.auth === "agent" ? "agent" : "password"}</small>
                        ) : c.password ? (
                          <Icon name="check" size={13} />
                        ) : (
                          "—"
                        )}
                      </span>
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
                {result.db === 0 && result.ssh > 0
                  ? `Imported ${result.ssh} SSH host${result.ssh === 1 ? "" : "s"}`
                  : `Imported ${result.db} connection${result.db === 1 ? "" : "s"}`}
                {result.db > 0 && result.ssh > 0 && ` + ${result.ssh} SSH host${result.ssh === 1 ? "" : "s"}`}
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
