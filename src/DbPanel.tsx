import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { api } from "./api";
import type { DbProfile, QueryResult, SshProfile } from "./types";
import { Icon } from "./Icon";
import { ConnectLauncher, SessionBar } from "./SessionUI";

interface DbParams {
  host: string;
  port: number;
  user: string;
  password?: string | null;
  database?: string | null;
  profile_id?: string | null;
}

export function DbPanel({
  prefill,
  sshProfiles,
  dbProfiles = [],
}: {
  prefill?: DbProfile | null;
  sshProfiles: SshProfile[];
  dbProfiles?: DbProfile[];
}) {
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("3306");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [sql, setSql] = useState("SELECT VERSION();");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [lastError, setLastError] = useState("");
  const [busy, setBusy] = useState(false);

  const [connected, setConnected] = useState(false);
  const [connParams, setConnParams] = useState<DbParams | null>(null);
  const [connLabel, setConnLabel] = useState("");
  const [tunnelId, setTunnelId] = useState<string | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [openDb, setOpenDb] = useState<string | null>(null);
  const [tables, setTables] = useState<Record<string, string[]>>({});
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [manual, setManual] = useState(false);
  const [tunnelVia, setTunnelVia] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [resizing, setResizing] = useState(false);
  const [editorHeight, setEditorHeight] = useState(96);
  const [editorResizing, setEditorResizing] = useState(false);

  function startEditorResize(e: ReactMouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHeight;
    setEditorResizing(true);
    const onMove = (ev: MouseEvent) =>
      setEditorHeight(Math.min(400, Math.max(56, startH + ev.clientY - startY)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setEditorResizing(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }
  const [ddl, setDdl] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; db: string; table: string } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  async function showDdl(db: string, table: string) {
    setBusy(true);
    setError("");
    setResult(null);
    const q = `SHOW CREATE TABLE \`${db}\`.\`${table}\`;`;
    setSql(q);
    try {
      const res = await api.dbQuery(baseParams(), q);
      setDdl(res.rows[0]?.[1] ?? "");
    } catch (e) {
      setDdl(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function copyText(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function startResize(e: ReactMouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    setResizing(true);
    const onMove = (ev: MouseEvent) =>
      setSidebarWidth(Math.min(560, Math.max(140, startW + ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setResizing(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setDatabase(prefill.database ?? "");
      setSelectedProfileId(prefill.id);
      setTunnelVia(prefill.via_ssh_profile_id ?? "");
      disconnect();
    } else {
      setManual(dbProfiles.length === 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  function baseParams(): DbParams {
    return connParams ?? { host, port: Number(port), user, password: password || null };
  }

  async function connect(override?: DbProfile) {
    setLastError("");
    setBusy(true);
    const src = override ?? null;
    const cHost = src ? src.host : host;
    const cPort = src ? src.port : Number(port);
    const cUser = src ? src.user : user;
    const cDb = src ? src.database ?? null : database || null;
    const cProfileId = src ? src.id : prefill?.id || null;
    const cPassword = src ? null : password || null;
    const viaSsh = src ? src.via_ssh_profile_id ?? null : tunnelVia || null;
    const label = src ? src.name || `${src.user}@${src.host}` : `${user}@${host}`;
    try {
      let h = cHost;
      let p = cPort;
      let tid: string | null = null;

      if (viaSsh) {
        const ssh = sshProfiles.find((s) => s.id === viaSsh);
        if (!ssh) throw new Error("SSH profile for tunnel not found");
        const t = await api.tunnelStart({
          host: ssh.host,
          port: ssh.port,
          user: ssh.user,
          auth: ssh.auth,
          profile_id: ssh.id,
          remote_host: cHost,
          remote_port: cPort,
          local_port: 0,
        });
        h = "127.0.0.1";
        p = t.local_port;
        tid = t.id;
      }

      const params: DbParams = {
        host: h,
        port: p,
        user: cUser,
        password: cPassword,
        database: cDb,
        profile_id: cProfileId,
      };
      const res = await api.dbQuery({ ...params, database: null }, "SHOW DATABASES;");
      setDatabases(res.rows.map((r) => r[0] ?? "").filter(Boolean));
      setConnParams(params);
      setConnLabel(tid ? `${label} · tunnel` : label);
      setTunnelId(tid);
      setConnected(true);
    } catch (e) {
      setLastError(String(e));
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  function connectPreset() {
    const p = dbProfiles.find((d) => d.id === selectedProfileId);
    if (p) connect(p);
  }

  async function disconnect() {
    if (tunnelId) {
      await api.tunnelStop(tunnelId).catch(() => {});
      setTunnelId(null);
    }
    setConnected(false);
    setConnParams(null);
    setDatabases([]);
    setTables({});
    setOpenDb(null);
  }

  async function toggleDb(db: string) {
    if (openDb === db) {
      setOpenDb(null);
      return;
    }
    setOpenDb(db);
    if (!tables[db]) {
      try {
        const res = await api.dbQuery(baseParams(), `SHOW TABLES FROM \`${db}\`;`);
        setTables({ ...tables, [db]: res.rows.map((r) => r[0] ?? "").filter(Boolean) });
      } catch (e) {
        setError(String(e));
      }
    }
  }

  async function openTable(db: string, table: string) {
    const q = `SELECT * FROM \`${db}\`.\`${table}\` LIMIT 200;`;
    setSql(q);
    await run(q, db);
  }

  async function run(sqlText?: string, db?: string) {
    setBusy(true);
    setError("");
    setDdl(null);
    try {
      const res = await api.dbQuery(
        { ...baseParams(), database: db ?? (database || null) },
        sqlText ?? sql,
      );
      setResult(res);
    } catch (e) {
      setResult(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <div className="panel">
        <ConnectLauncher
          icon="database"
          title="Connect Database"
          presetLabel="Choose a saved database…"
          presets={dbProfiles.map((d) => ({
            id: d.id,
            label: d.name || `${d.user}@${d.host}${d.via_ssh_profile_id ? " · tunnel" : ""}`,
          }))}
          selectedId={selectedProfileId}
          onSelect={setSelectedProfileId}
          onConnect={connectPreset}
          connecting={busy}
          manualOpen={manual}
          onToggleManual={() => setManual((v) => !v)}
          error={lastError}
        >
          <div className="form-row">
            <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
            <input className="port" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
            <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
          </div>
          <div className="form-row">
            <input
              type="password"
              placeholder={prefill?.id ? "password (saved)" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <input placeholder="database (optional)" value={database} onChange={(e) => setDatabase(e.target.value)} />
          </div>
          <label className="tunnel-select">
            <span>
              <Icon name="tunnel" size={13} /> Connect through SSH tunnel
            </span>
            <select value={tunnelVia} onChange={(e) => setTunnelVia(e.target.value)}>
              <option value="">— direct connection —</option>
              {sshProfiles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || `${s.user}@${s.host}`}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => connect()} disabled={busy}>
            <Icon name="play" size={14} /> {busy ? "Connecting…" : "Connect"}
          </button>
        </ConnectLauncher>
      </div>
    );
  }

  return (
    <div className="panel">
      <SessionBar label={connLabel} onDisconnect={disconnect} />
      {error && <pre className="error">{error}</pre>}

      {connected && (
        <div className="db-body" style={{ "--schema-w": `${sidebarWidth}px` } as CSSProperties}>
          <div className="schema">
            {databases.map((db) => (
              <div key={db}>
                <div className="schema-db" onClick={() => toggleDb(db)}>
                  <Icon name={openDb === db ? "chevronDown" : "chevronRight"} size={13} />
                  <Icon name="database" size={14} /> {db}
                </div>
                {openDb === db &&
                  (tables[db] ?? []).map((t) => (
                    <div
                      key={t}
                      className="schema-table"
                      onClick={() => openTable(db, t)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, db, table: t });
                      }}
                    >
                      <Icon name="table" size={13} /> {t}
                    </div>
                  ))}
              </div>
            ))}
          </div>

          <div
            className={`db-resizer${resizing ? " dragging" : ""}`}
            onMouseDown={startResize}
            title="Drag to resize"
          />

          <div className="query-area">
            <textarea
              className="sql"
              style={{ height: editorHeight }}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
            />
            <div
              className={`editor-resizer${editorResizing ? " dragging" : ""}`}
              onMouseDown={startEditorResize}
              title="Drag to resize editor"
            />
            <div className="form-row">
              <button onClick={() => run()} disabled={busy}>
                <Icon name="play" size={14} /> {busy ? "Running…" : "Run"}
              </button>
              {result && (
                <span className="status">
                  {result.rows.length} rows · {result.rows_affected} affected · {result.elapsed_ms} ms
                </span>
              )}
            </div>
            {ddl !== null && (
              <div className="ddl-wrap">
                <div className="ddl-head">
                  <span>
                    <Icon name="code" size={13} /> DDL
                  </span>
                  <button className="ghost" onClick={() => copyText(ddl)}>
                    <Icon name="copy" size={13} /> Copy
                  </button>
                </div>
                <pre className="ddl">{ddl}</pre>
              </div>
            )}
            {ddl === null && result && (
              <div className="grid-wrap">
                <table className="grid">
                  <thead>
                    <tr>
                      {result.columns.map((c, i) => (
                        <th key={i}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci}>{cell === null ? <em className="null">NULL</em> : cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {menu && (
        <ul className="ctx-menu" style={{ top: menu.y, left: menu.x }} onClick={(e) => e.stopPropagation()}>
          <li
            onClick={() => {
              openTable(menu.db, menu.table);
              setMenu(null);
            }}
          >
            <Icon name="table" size={13} /> Open data
          </li>
          <li
            onClick={() => {
              showDdl(menu.db, menu.table);
              setMenu(null);
            }}
          >
            <Icon name="code" size={13} /> Show DDL
          </li>
          <li
            onClick={() => {
              copyText(`\`${menu.db}\`.\`${menu.table}\``);
              setMenu(null);
            }}
          >
            <Icon name="copy" size={13} /> Copy name
          </li>
        </ul>
      )}
    </div>
  );
}
