import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { format } from "sql-formatter";
import CodeMirror from "@uiw/react-codemirror";
import { sql as sqlLang, MySQL } from "@codemirror/lang-sql";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Channel } from "@tauri-apps/api/core";
import { api } from "./api";
import type {
  DbProfile,
  DumpProgress,
  ImportProgress,
  QueryResult,
  SavedQuery,
  SchemaObjects,
  SshProfile,
} from "./types";

interface ExportState {
  id: string;
  title: string;
  tablesTotal: number;
  tableIndex: number;
  current: string;
  written: number;
  total: number;
  log: { name: string; rows: number }[];
  paused: boolean;
  done: boolean;
  cancelled: boolean;
}

interface ImportState {
  id: string;
  title: string;
  path: string;
  continueOnError: boolean;
  started: boolean;
  total: number;
  executed: number;
  failed: number;
  paused: boolean;
  done: boolean;
  cancelled: boolean;
  error: string;
  errors: string[];
}
import { Icon, type IconName } from "./Icon";
import { AskModal, type AskOptions } from "./AskModal";
import { ConnectLauncher } from "./SessionUI";

/** Collapse whitespace and strip comments, leaving quoted strings intact. */
function minifySql(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        if (sql[i] === "\\" && i + 1 < n) {
          out += sql[i] + sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            out += q + q;
            i += 2;
            continue;
          }
          out += q;
          i++;
          break;
        }
        out += sql[i];
        i++;
      }
      continue;
    }
    if (/\s/.test(c)) {
      let j = i;
      while (j < n && /\s/.test(sql[j])) j++;
      out += " ";
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out.trim();
}

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
  savedQueries = [],
  onQueriesChanged,
  onSession,
  dcSignal,
}: {
  prefill?: DbProfile | null;
  sshProfiles: SshProfile[];
  dbProfiles?: DbProfile[];
  savedQueries?: SavedQuery[];
  onQueriesChanged?: () => void;
  onSession?: (label: string) => void;
  dcSignal?: number;
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
  const [selectedDb, setSelectedDb] = useState<string | null>(null);
  const [objects, setObjects] = useState<Record<string, SchemaObjects>>({});
  const [openCat, setOpenCat] = useState<Set<string>>(new Set());
  const [activeQuery, setActiveQuery] = useState<SavedQuery | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [manual, setManual] = useState(false);
  const [tunnelVia, setTunnelVia] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [resizing, setResizing] = useState(false);
  const [editorHeight, setEditorHeight] = useState(96);
  const [editorResizing, setEditorResizing] = useState(false);
  const [rowLimit, setRowLimit] = useState(1000);
  // Virtualized result grid: only the visible row window is in the DOM.
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridScroll, setGridScroll] = useState(0);
  const [gridH, setGridH] = useState(480);

  const colWidths = useMemo(() => {
    if (!result) return [];
    const sample = result.rows.slice(0, 200);
    return result.columns.map((c, i) => {
      let maxLen = c.length;
      for (const row of sample) {
        const len = row[i] == null ? 4 : (row[i] as string).length;
        if (len > maxLen) maxLen = len;
      }
      return Math.min(440, Math.max(56, Math.round(maxLen * 7.3) + 28));
    });
  }, [result]);

  useEffect(() => {
    setGridScroll(0);
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }, [result]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    setGridH(el.clientHeight);
    const ro = new ResizeObserver(() => setGridH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [result]);
  const [dark, setDark] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    db: string;
    kind: "db" | "table" | "view" | "routine" | "query";
    name?: string;
    routineKind?: string;
    query?: SavedQuery;
  } | null>(null);
  const [ask, setAsk] = useState<AskOptions | null>(null);
  const [notice, setNotice] = useState("");
  const [exp, setExp] = useState<ExportState | null>(null);
  const [imp, setImp] = useState<ImportState | null>(null);

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

  useEffect(() => {
    onSession?.(connected ? (selectedDb ? `${connLabel} · ${selectedDb}` : connLabel) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, connLabel, selectedDb]);

  useEffect(() => {
    if (dcSignal && dcSignal > 0) disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dcSignal]);

  async function showDdl(
    db: string,
    name: string,
    kind: "table" | "routine" = "table",
    routineKind?: string,
  ) {
    setBusy(true);
    setError("");
    setResult(null);
    const isProc = (routineKind ?? "").toUpperCase() === "PROCEDURE";
    const q =
      kind === "routine"
        ? `SHOW CREATE ${isProc ? "PROCEDURE" : "FUNCTION"} \`${db}\`.\`${name}\`;`
        : `SHOW CREATE TABLE \`${db}\`.\`${name}\`;`;
    const col = kind === "routine" ? 2 : 1;
    setActiveQuery(null);
    setSql(q);
    try {
      const res = await api.dbQuery(baseParams(), q);
      setDdl(res.rows[0]?.[col] ?? "");
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

  function beautify() {
    try {
      setSql(format(sql, { language: "mysql", keywordCase: "upper" }));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshDatabases() {
    const res = await api.dbQuery({ ...baseParams(), database: null }, "SHOW DATABASES;");
    setDatabases(res.rows.map((r) => r[0] ?? "").filter(Boolean));
  }

  function newDatabase() {
    setAsk({
      title: "New database",
      label: "Name for the new database",
      initial: "",
      confirmText: "Create",
      run: (name) => {
        const n = name.trim();
        if (!n) return;
        void (async () => {
          try {
            setError("");
            await api.dbQuery({ ...baseParams(), database: null }, `CREATE DATABASE \`${n}\`;`);
            await refreshDatabases();
            setNotice(`Created database ${n}`);
          } catch (e) {
            setError(String(e));
          }
        })();
      },
    });
  }

  async function exportSql(db: string, table?: string) {
    const path = await save({
      defaultPath: `${table ?? db}.sql`,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!path) return;
    const id = crypto.randomUUID();
    setError("");
    setExp({
      id,
      title: table ?? db,
      tablesTotal: table ? 1 : 0,
      tableIndex: 0,
      current: "",
      written: 0,
      total: 0,
      log: [],
      paused: false,
      done: false,
      cancelled: false,
    });
    const ch = new Channel<DumpProgress>();
    ch.onmessage = (m) =>
      setExp((p) => {
        if (!p) return p;
        switch (m.kind) {
          case "start":
            return { ...p, tablesTotal: m.tables };
          case "table":
            return { ...p, current: m.name, tableIndex: m.index, tablesTotal: m.total, total: m.rows, written: 0 };
          case "rows":
            return { ...p, written: m.written, total: m.total };
          case "table_done":
            return { ...p, log: [...p.log, { name: m.name, rows: m.rows }] };
          case "done":
            return { ...p, done: true };
          case "cancelled":
            return { ...p, done: true, cancelled: true };
          default:
            return p;
        }
      });
    try {
      await api.dbDump(baseParams(), db, table ?? null, path, id, ch);
      setExp((p) => (p ? { ...p, done: true } : p));
    } catch (e) {
      setError(String(e));
      setExp(null);
    }
  }

  function exportPause() {
    setExp((p) => {
      if (!p) return p;
      const paused = !p.paused;
      api.dbJobControl(p.id, paused ? "pause" : "resume").catch(() => {});
      return { ...p, paused };
    });
  }

  function exportCancel() {
    if (exp) api.dbJobControl(exp.id, "cancel").catch(() => {});
  }

  async function importSql(targetDb?: string) {
    const path = await open({ multiple: false, filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (!path || typeof path !== "string") return;
    setError("");
    setImp({
      id: crypto.randomUUID(),
      title: targetDb ?? "",
      path,
      continueOnError: false,
      started: false,
      total: 0,
      executed: 0,
      failed: 0,
      paused: false,
      done: false,
      cancelled: false,
      error: "",
      errors: [],
    });
  }

  async function runImport() {
    if (!imp) return;
    const { id, path, title, continueOnError } = imp;
    setImp({ ...imp, started: true });
    const ch = new Channel<ImportProgress>();
    ch.onmessage = (m) =>
      setImp((p) => {
        if (!p) return p;
        switch (m.kind) {
          case "start":
            return { ...p, total: m.total };
          case "progress":
            return { ...p, executed: m.executed, failed: m.failed, total: m.total };
          case "stmt_error":
            return p.errors.length >= 200 ? p : { ...p, errors: [...p.errors, `#${m.index}: ${m.error}`] };
          case "done":
            return { ...p, executed: m.executed, failed: m.failed, done: true };
          case "cancelled":
            return { ...p, executed: m.executed, failed: m.failed, done: true, cancelled: true };
          case "failed":
            return { ...p, executed: m.executed, done: true, error: m.error };
          default:
            return p;
        }
      });
    try {
      await api.dbImportFile(baseParams(), path, title || null, id, continueOnError, ch);
      setImp((p) => (p ? { ...p, done: true } : p));
      await refreshDatabases();
      if (title) {
        setObjects((o) => {
          const next = { ...o };
          delete next[title];
          return next;
        });
      }
    } catch (e) {
      setError(String(e));
      setImp(null);
    }
  }

  function importPause() {
    setImp((p) => {
      if (!p) return p;
      const paused = !p.paused;
      api.dbJobControl(p.id, paused ? "pause" : "resume").catch(() => {});
      return { ...p, paused };
    });
  }

  function importCancel() {
    if (imp) api.dbJobControl(imp.id, "cancel").catch(() => {});
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
    if (connParams) await api.dbDisconnect(connParams).catch(() => {});
    if (tunnelId) {
      await api.tunnelStop(tunnelId).catch(() => {});
      setTunnelId(null);
    }
    setConnected(false);
    setConnParams(null);
    setDatabases([]);
    setObjects({});
    setOpenCat(new Set());
    setOpenDb(null);
    setSelectedDb(null);
  }

  async function toggleDb(db: string) {
    setSelectedDb(db);
    if (openDb === db) {
      setOpenDb(null);
      return;
    }
    setOpenDb(db);
    if (!objects[db]) {
      try {
        const objs = await api.dbSchemaObjects(baseParams(), db);
        setObjects((o) => ({ ...o, [db]: objs }));
      } catch (e) {
        setError(String(e));
      }
    }
  }

  function toggleCat(db: string, cat: string) {
    const key = `${db}::${cat}`;
    setOpenCat((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function catRow(db: string, cat: string, label: string, icon: IconName, count: number) {
    const open = openCat.has(`${db}::${cat}`);
    return (
      <div className="schema-cat" onClick={() => toggleCat(db, cat)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <Icon name={icon} size={13} /> {label} <span className="cat-count">{count}</span>
      </div>
    );
  }

  async function openTable(db: string, table: string) {
    const q = `SELECT * FROM \`${db}\`.\`${table}\` LIMIT 200;`;
    setActiveQuery(null);
    setSql(q);
    await run(q, db);
  }

  function loadQuery(q: SavedQuery) {
    setActiveQuery(q);
    setSql(q.sql);
    setDdl(null);
  }

  async function saveQuery() {
    if (activeQuery) {
      try {
        const updated = { ...activeQuery, sql };
        await api.querySave(updated);
        setActiveQuery(updated);
        onQueriesChanged?.();
        setNotice(`Updated query "${activeQuery.name}"`);
      } catch (e) {
        setError(String(e));
      }
      return;
    }
    const db = selectedDb ?? openDb;
    if (!db) {
      setNotice("Select a database first, then save the query.");
      return;
    }
    saveCurrentQuery(db);
  }

  const currentProfileId = connParams?.profile_id ?? prefill?.id ?? null;
  function queriesFor(db: string): SavedQuery[] {
    return savedQueries.filter(
      (q) => (q.db_profile_id ?? null) === currentProfileId && (q.database ?? null) === db,
    );
  }

  function saveCurrentQuery(db: string) {
    setAsk({
      title: "Save query",
      label: `Save the current SQL as a named query in ${db}`,
      initial: "",
      confirmText: "Save",
      run: (name) => {
        const n = name.trim();
        if (!n) return;
        void (async () => {
          try {
            setError("");
            const saved = await api.querySave({
              id: "",
              name: n,
              sql,
              db_profile_id: currentProfileId,
              database: db,
            });
            setActiveQuery(saved);
            onQueriesChanged?.();
            setNotice(`Saved query "${n}"`);
          } catch (e) {
            setError(String(e));
          }
        })();
      },
    });
  }

  function renameQuery(q: SavedQuery) {
    setAsk({
      title: "Rename query",
      label: "Query name",
      initial: q.name,
      confirmText: "Rename",
      run: (name) => {
        const n = name.trim();
        if (!n) return;
        void (async () => {
          try {
            await api.querySave({ ...q, name: n });
            if (activeQuery?.id === q.id) setActiveQuery({ ...q, name: n });
            onQueriesChanged?.();
          } catch (e) {
            setError(String(e));
          }
        })();
      },
    });
  }

  async function deleteQuery(q: SavedQuery) {
    try {
      await api.queryDelete(q.id);
      if (activeQuery?.id === q.id) setActiveQuery(null);
      onQueriesChanged?.();
    } catch (e) {
      setError(String(e));
    }
  }

  async function run(sqlText?: string, db?: string) {
    setBusy(true);
    setError("");
    setDdl(null);
    try {
      const res = await api.dbQuery(
        { ...baseParams(), database: db ?? selectedDb ?? (database || null) },
        sqlText ?? sql,
        rowLimit > 0 ? rowLimit : null,
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
      {error && <pre className="error">{error}</pre>}
      {notice && (
        <div className="db-notice" onClick={() => setNotice("")} title="Click to dismiss">
          <Icon name="download" size={13} /> {notice}
        </div>
      )}

      {connected && (
        <div className="db-body" style={{ "--schema-w": `${sidebarWidth}px` } as CSSProperties}>
          <div className="schema">
            <div className="schema-head">
              <button className="ghost" onClick={newDatabase} title="Create a new database">
                <Icon name="plus" size={12} /> DB
              </button>
              <button
                className="ghost"
                onClick={() => importSql(selectedDb ?? undefined)}
                title={selectedDb ? `Import a .sql file into ${selectedDb}` : "Import a .sql file"}
              >
                <Icon name="upload" size={12} /> Import
              </button>
            </div>
            {databases.map((db) => (
              <div key={db}>
                <div
                  className={`schema-db${selectedDb === db ? " selected" : ""}`}
                  onClick={() => toggleDb(db)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, db, kind: "db" });
                  }}
                >
                  <Icon name={openDb === db ? "chevronDown" : "chevronRight"} size={13} />
                  <Icon name="database" size={14} /> {db}
                </div>
                {openDb === db && objects[db] && (
                  <div className="schema-cats">
                    {catRow(db, "tables", "Tables", "table", objects[db].tables.length)}
                    {openCat.has(`${db}::tables`) &&
                      objects[db].tables.map((t) => (
                        <div
                          key={`t-${t}`}
                          className="schema-item"
                          onClick={() => openTable(db, t)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setMenu({ x: e.clientX, y: e.clientY, db, kind: "table", name: t });
                          }}
                        >
                          <Icon name="table" size={13} /> {t}
                        </div>
                      ))}

                    {catRow(db, "views", "Views", "eye", objects[db].views.length)}
                    {openCat.has(`${db}::views`) &&
                      objects[db].views.map((v) => (
                        <div
                          key={`v-${v}`}
                          className="schema-item"
                          onClick={() => openTable(db, v)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setMenu({ x: e.clientX, y: e.clientY, db, kind: "view", name: v });
                          }}
                        >
                          <Icon name="eye" size={13} /> {v}
                        </div>
                      ))}

                    {catRow(db, "functions", "Functions", "fx", objects[db].routines.length)}
                    {openCat.has(`${db}::functions`) &&
                      objects[db].routines.map((r) => (
                        <div
                          key={`r-${r.name}`}
                          className="schema-item"
                          onClick={() => showDdl(db, r.name, "routine", r.kind)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setMenu({
                              x: e.clientX,
                              y: e.clientY,
                              db,
                              kind: "routine",
                              name: r.name,
                              routineKind: r.kind,
                            });
                          }}
                        >
                          <Icon name={r.kind.toUpperCase() === "PROCEDURE" ? "cog" : "fx"} size={13} /> {r.name}
                        </div>
                      ))}

                    {catRow(db, "queries", "Queries", "code", queriesFor(db).length)}
                    {openCat.has(`${db}::queries`) && (
                      <>
                        {queriesFor(db).map((q) => (
                          <div
                            key={`q-${q.id}`}
                            className={`schema-item${activeQuery?.id === q.id ? " active" : ""}`}
                            onClick={() => loadQuery(q)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setMenu({ x: e.clientX, y: e.clientY, db, kind: "query", query: q });
                            }}
                          >
                            <Icon name="code" size={13} /> {q.name}
                          </div>
                        ))}
                        <div className="schema-item add" onClick={() => saveCurrentQuery(db)}>
                          <Icon name="plus" size={13} /> Save current query
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div
            className={`db-resizer${resizing ? " dragging" : ""}`}
            onMouseDown={startResize}
            title="Drag to resize"
          />

          <div className="query-area">
            <CodeMirror
              className="sql-editor"
              value={sql}
              height={`${editorHeight}px`}
              theme={dark ? "dark" : "light"}
              extensions={[sqlLang({ dialect: MySQL })]}
              onChange={(val) => setSql(val)}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                autocompletion: false,
                highlightActiveLine: true,
              }}
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
              <button className="ghost" onClick={beautify} disabled={!sql.trim()} title="Beautify (format) SQL">
                <Icon name="alignLeft" size={13} /> Beautify
              </button>
              <button className="ghost" onClick={() => setSql(minifySql(sql))} disabled={!sql.trim()} title="Minify SQL">
                <Icon name="minimize" size={13} /> Minify
              </button>
              <button
                className="ghost"
                onClick={saveQuery}
                disabled={!sql.trim()}
                title={activeQuery ? `Update saved query "${activeQuery.name}"` : "Save as a new query"}
              >
                <Icon name="save" size={13} /> {activeQuery ? "Save" : "Save…"}
              </button>
              <label className="row-limit" title="Max rows to fetch (0 = no limit)">
                Limit
                <input
                  type="number"
                  min={0}
                  step={500}
                  value={rowLimit}
                  onChange={(e) => setRowLimit(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              {result && (
                <span className={`status${result.truncated ? " truncated" : ""}`}>
                  {result.rows.length.toLocaleString()} rows
                  {result.truncated ? ` (capped at ${rowLimit.toLocaleString()})` : ""} ·{" "}
                  {result.rows_affected} affected · {result.elapsed_ms} ms
                </span>
              )}
            </div>
            {result?.truncated && (
              <div className="trunc-note">
                <Icon name="minimize" size={12} /> Showing the first {rowLimit.toLocaleString()} rows. Raise “Limit”
                (or add a <code>WHERE</code>/<code>LIMIT</code>) to fetch more.
              </div>
            )}
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
              <div
                className="grid-wrap"
                ref={gridRef}
                onScroll={(e) => setGridScroll(e.currentTarget.scrollTop)}
              >
                {(() => {
                  const ROW_H = 31;
                  const total = result.rows.length;
                  const overscan = 10;
                  const start = Math.max(0, Math.floor(gridScroll / ROW_H) - overscan);
                  const end = Math.min(total, Math.ceil((gridScroll + gridH) / ROW_H) + overscan);
                  const padTop = start * ROW_H;
                  const padBottom = Math.max(0, (total - end) * ROW_H);
                  const ncols = result.columns.length;
                  return (
                    <table className="grid">
                      <colgroup>
                        {colWidths.map((w, i) => (
                          <col key={i} style={{ width: w }} />
                        ))}
                      </colgroup>
                      <thead>
                        <tr>
                          {result.columns.map((c, i) => (
                            <th key={i}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {padTop > 0 && (
                          <tr className="vspacer" style={{ height: padTop }}>
                            <td colSpan={ncols} />
                          </tr>
                        )}
                        {result.rows.slice(start, end).map((row, vi) => (
                          <tr key={start + vi}>
                            {row.map((cell, ci) => (
                              <td key={ci} title={cell ?? undefined}>
                                {cell === null ? <em className="null">NULL</em> : cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {padBottom > 0 && (
                          <tr className="vspacer" style={{ height: padBottom }}>
                            <td colSpan={ncols} />
                          </tr>
                        )}
                      </tbody>
                    </table>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {menu && (
        <ul className="ctx-menu" style={{ top: menu.y, left: menu.x }} onClick={(e) => e.stopPropagation()}>
          {menu.kind === "db" && (
            <>
              <li onClick={() => { exportSql(menu.db); setMenu(null); }}>
                <Icon name="download" size={13} /> Export SQL (database)
              </li>
              <li onClick={() => { importSql(menu.db); setMenu(null); }}>
                <Icon name="upload" size={13} /> Import SQL (into this db)
              </li>
              <li onClick={() => { copyText(`\`${menu.db}\``); setMenu(null); }}>
                <Icon name="copy" size={13} /> Copy name
              </li>
            </>
          )}
          {(menu.kind === "table" || menu.kind === "view") && (
            <>
              <li onClick={() => { openTable(menu.db, menu.name!); setMenu(null); }}>
                <Icon name="table" size={13} /> Open data
              </li>
              <li onClick={() => { showDdl(menu.db, menu.name!); setMenu(null); }}>
                <Icon name="code" size={13} /> Show DDL
              </li>
              {menu.kind === "table" && (
                <li onClick={() => { exportSql(menu.db, menu.name); setMenu(null); }}>
                  <Icon name="download" size={13} /> Export SQL
                </li>
              )}
              <li onClick={() => { copyText(`\`${menu.db}\`.\`${menu.name}\``); setMenu(null); }}>
                <Icon name="copy" size={13} /> Copy name
              </li>
            </>
          )}
          {menu.kind === "routine" && (
            <>
              <li onClick={() => { showDdl(menu.db, menu.name!, "routine", menu.routineKind); setMenu(null); }}>
                <Icon name="code" size={13} /> Show DDL
              </li>
              <li onClick={() => { copyText(`\`${menu.db}\`.\`${menu.name}\``); setMenu(null); }}>
                <Icon name="copy" size={13} /> Copy name
              </li>
            </>
          )}
          {menu.kind === "query" && menu.query && (
            <>
              <li onClick={() => { setSql(menu.query!.sql); setMenu(null); }}>
                <Icon name="code" size={13} /> Load into editor
              </li>
              <li onClick={() => { const q = menu.query!; setSql(q.sql); run(q.sql, menu.db); setMenu(null); }}>
                <Icon name="play" size={13} /> Run
              </li>
              <li onClick={() => { renameQuery(menu.query!); setMenu(null); }}>
                <Icon name="edit" size={13} /> Rename
              </li>
              <li onClick={() => { deleteQuery(menu.query!); setMenu(null); }}>
                <Icon name="trash" size={13} /> Delete
              </li>
            </>
          )}
        </ul>
      )}

      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}

      {exp && (
        <div className="pane-overlay">
          <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              {exp.cancelled ? "Export cancelled" : exp.done ? "Export complete" : "Exporting"} — {exp.title}
            </h3>
            <div className="export-row">
              <span>Tables</span>
              <span>
                {exp.tableIndex} / {exp.tablesTotal || "…"}
              </span>
            </div>
            {!exp.done && exp.current && (
              <>
                <div className="export-row">
                  <span className="mono">{exp.current}</span>
                  <span>
                    {exp.written.toLocaleString()}
                    {exp.total ? ` / ~${exp.total.toLocaleString()}` : ""} rows
                    {exp.paused ? " · paused" : ""}
                  </span>
                </div>
                <div className="pbar">
                  <div
                    className="pfill"
                    style={{ width: `${exp.total ? Math.min(100, (exp.written / exp.total) * 100) : 5}%` }}
                  />
                </div>
              </>
            )}
            {exp.log.length > 0 && (
              <div className="export-log">
                {exp.log.map((l) => (
                  <div key={l.name}>
                    <Icon name="table" size={12} /> {l.name} — {l.rows.toLocaleString()} rows
                  </div>
                ))}
              </div>
            )}
            <div className="form-row end">
              {exp.done ? (
                <button onClick={() => setExp(null)}>Close</button>
              ) : (
                <>
                  <button className="ghost" onClick={exportPause}>
                    {exp.paused ? "Resume" : "Pause"}
                  </button>
                  <button className="danger-btn" onClick={exportCancel}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {imp && (
        <div className="pane-overlay">
          <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
            {!imp.started ? (
              <>
                <h3>Import SQL{imp.title ? ` → ${imp.title}` : ""}</h3>
                <div className="export-row">
                  <span>File</span>
                  <span className="mono">{imp.path.split(/[\\/]/).pop()}</span>
                </div>
                {!imp.title && <p className="ask-label">No target database — statements run as-is.</p>}
                <label className="opt-check">
                  <input
                    type="checkbox"
                    checked={imp.continueOnError}
                    onChange={(e) => setImp((p) => (p ? { ...p, continueOnError: e.target.checked } : p))}
                  />
                  Continue on error (skip failed statements)
                </label>
                <div className="form-row end">
                  <button className="ghost" onClick={() => setImp(null)}>
                    Cancel
                  </button>
                  <button onClick={runImport}>Start import</button>
                </div>
              </>
            ) : (
              <>
                <h3>
                  {imp.error
                    ? "Import failed"
                    : imp.cancelled
                      ? "Import cancelled"
                      : imp.done
                        ? "Import complete"
                        : "Importing"}
                  {imp.title ? ` → ${imp.title}` : ""}
                </h3>
                <div className="export-row">
                  <span>Statements</span>
                  <span>
                    {imp.executed.toLocaleString()} ok
                    {imp.failed ? ` · ${imp.failed.toLocaleString()} failed` : ""} /{" "}
                    {imp.total ? imp.total.toLocaleString() : "…"}
                    {imp.paused ? " · paused" : ""}
                  </span>
                </div>
                <div className="pbar">
                  <div
                    className="pfill"
                    style={{
                      width: `${imp.total ? Math.min(100, ((imp.executed + imp.failed) / imp.total) * 100) : 5}%`,
                    }}
                  />
                </div>
                {imp.error && <pre className="error">{imp.error}</pre>}
                {imp.errors.length > 0 && (
                  <div className="export-log">
                    {imp.errors.map((er, i) => (
                      <div key={i} className="err-line">
                        {er}
                      </div>
                    ))}
                  </div>
                )}
                <div className="form-row end">
                  {imp.done ? (
                    <button onClick={() => setImp(null)}>Close</button>
                  ) : (
                    <>
                      <button className="ghost" onClick={importPause}>
                        {imp.paused ? "Resume" : "Pause"}
                      </button>
                      <button className="danger-btn" onClick={importCancel}>
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
