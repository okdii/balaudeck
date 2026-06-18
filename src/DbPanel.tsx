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

interface DesignColumn {
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  def: string;
  pk: boolean;
  ai: boolean;
  orig?: string;
}
interface ForeignKey {
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
  onUpdate: string;
  orig?: string;
}
interface TableIndex {
  name: string;
  columns: string;
  unique: boolean;
  orig?: string;
}
interface DesignerState {
  db: string;
  table: string;
  isNew: boolean;
  columns: DesignColumn[];
  original: DesignColumn[];
  fks: ForeignKey[];
  originalFks: ForeignKey[];
  indexes: TableIndex[];
  originalIndexes: TableIndex[];
}

const FK_ACTIONS = ["", "RESTRICT", "CASCADE", "SET NULL", "NO ACTION"];

const COMMON_TYPES = [
  "INT",
  "INT UNSIGNED",
  "BIGINT",
  "BIGINT UNSIGNED",
  "TINYINT",
  "TINYINT UNSIGNED",
  "SMALLINT",
  "VARCHAR",
  "CHAR",
  "TEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "DATETIME",
  "TIMESTAMP",
  "DATE",
  "TIME",
  "DECIMAL",
  "DOUBLE",
  "FLOAT",
  "BOOLEAN",
  "JSON",
  "BLOB",
  "ENUM",
];

/** Show a global "progress" cursor while any DB panel has work in flight. */
let busyCursorRefs = 0;
function bumpBusyCursor(delta: number) {
  busyCursorRefs = Math.max(0, busyCursorRefs + delta);
  document.body.classList.toggle("app-loading", busyCursorRefs > 0);
}

/** Split a raw column type into base type (+ attrs) and length. */
function parseType(raw: string): { type: string; length: string } {
  const m = raw.trim().match(/^([a-zA-Z]+)\s*(?:\(([^)]*)\))?\s*(.*)$/);
  if (!m) return { type: raw.toUpperCase(), length: "" };
  const base = m[1].toUpperCase();
  const len = (m[2] ?? "").trim();
  const rest = (m[3] ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  return { type: rest ? `${base} ${rest}` : base, length: len };
}

/** Recombine base type + length, placing (len) right after the base keyword. */
function typeSql(c: { type: string; length: string }): string {
  const t = c.type.trim();
  const len = c.length.trim();
  if (!len) return t;
  const sp = t.indexOf(" ");
  return sp === -1 ? `${t}(${len})` : `${t.slice(0, sp)}(${len})${t.slice(sp)}`;
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
    kind: "db" | "table" | "view" | "routine" | "query" | "category";
    name?: string;
    routineKind?: string;
    query?: SavedQuery;
    cat?: string;
  } | null>(null);
  const [ask, setAsk] = useState<AskOptions | null>(null);
  const [notice, setNotice] = useState("");
  const [exp, setExp] = useState<ExportState | null>(null);
  const [imp, setImp] = useState<ImportState | null>(null);
  const [designer, setDesigner] = useState<DesignerState | null>(null);
  const [refCols, setRefCols] = useState<Record<string, string[]>>({});
  const [schemaLoading, setSchemaLoading] = useState(false);
  // Inline data editing: when the grid shows a single table's data ("Open data"),
  // `editTable` carries its db/table/primary-key so edited cells can be persisted.
  const [editTable, setEditTable] = useState<{ db: string; table: string; pk: string[] } | null>(null);
  // Pending cell edits, keyed "row:col" → new value (null = SQL NULL).
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [editingCell, setEditingCell] = useState<{ r: number; c: number } | null>(null);
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; r: number; c: number } | null>(null);
  const [savingEdits, setSavingEdits] = useState(false);

  useEffect(() => {
    if (!menu && !cellMenu) return;
    const close = () => {
      setMenu(null);
      setCellMenu(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, cellMenu]);

  useEffect(() => {
    onSession?.(connected ? (selectedDb ? `${connLabel} · ${selectedDb}` : connLabel) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, connLabel, selectedDb]);

  useEffect(() => {
    if (dcSignal && dcSignal > 0) guardLeave(() => disconnect());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dcSignal]);

  useEffect(() => {
    if (!(busy || schemaLoading)) return;
    bumpBusyCursor(1);
    return () => bumpBusyCursor(-1);
  }, [busy, schemaLoading]);

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
    setDesigner(null);
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
    setDesigner(null);
  }

  async function toggleDb(db: string) {
    setSelectedDb(db);
    if (openDb === db) {
      setOpenDb(null);
      return;
    }
    setOpenDb(db);
    if (!objects[db]) {
      setSchemaLoading(true);
      try {
        const objs = await api.dbSchemaObjects(baseParams(), db);
        setObjects((o) => ({ ...o, [db]: objs }));
      } catch (e) {
        setError(String(e));
      } finally {
        setSchemaLoading(false);
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
      <div
        className="schema-cat"
        onClick={() => toggleCat(db, cat)}
        onContextMenu={
          cat === "tables"
            ? (e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, db, kind: "category", cat });
              }
            : undefined
        }
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <Icon name={icon} size={13} /> {label} <span className="cat-count">{count}</span>
      </div>
    );
  }

  async function openTable(db: string, table: string) {
    const q = `SELECT * FROM ${qid(db)}.${qid(table)} LIMIT 200;`;
    setActiveQuery(null);
    setSql(q);
    // Fetch the primary key in parallel so edited cells can be written back
    // safely (WHERE on the PK). No PK → grid stays read-only.
    const pkPromise = api
      .dbQuery(baseParams(), `SHOW KEYS FROM ${qid(db)}.${qid(table)} WHERE Key_name = 'PRIMARY';`)
      .then((r) => {
        const ci = r.columns.indexOf("Column_name");
        const si = r.columns.indexOf("Seq_in_index");
        if (ci < 0) return [] as string[];
        // Composite PKs span multiple rows; order them by Seq_in_index so the
        // WHERE clause pairs each key column with the right value.
        const rows = si < 0 ? r.rows.slice() : r.rows.slice().sort((a, b) => Number(a[si]) - Number(b[si]));
        return rows.map((row) => row[ci]).filter((v): v is string => v !== null);
      })
      .catch(() => [] as string[]);
    await run(q, db); // clears editTable; we set it again below for this table
    const pk = await pkPromise;
    setEditTable({ db, table, pk });
  }

  // ---- Inline data editing -------------------------------------------------
  const editable = !!editTable && editTable.pk.length > 0;
  const editCount = Object.keys(edits).length;

  /** Backtick-quote a SQL identifier, escaping any embedded backticks. */
  const qid = (name: string) => "`" + name.replace(/`/g, "``") + "`";

  /** Record an edited cell value; drop the edit if it matches the original. */
  function commitEdit(r: number, c: number, raw: string) {
    const orig = result?.rows[r]?.[c] ?? null;
    setEdits((prev) => {
      const k = `${r}:${c}`;
      const next = { ...prev };
      // No change (incl. opening a NULL cell and leaving it empty → keeps NULL).
      if (raw === (orig ?? "")) delete next[k];
      else next[k] = raw;
      return next;
    });
    setEditingCell(null);
  }

  function setCellNull(r: number, c: number) {
    const orig = result?.rows[r]?.[c] ?? null;
    setEdits((prev) => {
      const k = `${r}:${c}`;
      const next = { ...prev };
      if (orig === null) delete next[k];
      else next[k] = null;
      return next;
    });
    setCellMenu(null);
  }

  function revertCell(r: number, c: number) {
    setEdits((prev) => {
      const next = { ...prev };
      delete next[`${r}:${c}`];
      return next;
    });
    setCellMenu(null);
  }

  function discardEdits() {
    setEdits({});
    setEditingCell(null);
  }

  /** Persist every pending edit as a parameterized UPDATE, one per dirty row. */
  async function saveEdits() {
    if (!editTable || !result || editCount === 0) return;
    const { db, table, pk } = editTable;
    if (pk.length === 0) {
      setNotice("This table has no primary key — editing is disabled.");
      return;
    }
    const pkIdx = pk.map((name) => result.columns.indexOf(name));
    if (pkIdx.some((i) => i < 0)) {
      setNotice("Primary-key columns are missing from the result — cannot save.");
      return;
    }
    // Group edited columns by row, then build one parameterized UPDATE per row.
    const byRow = new Map<number, number[]>();
    for (const key of Object.keys(edits)) {
      const [r, c] = key.split(":").map(Number);
      const arr = byRow.get(r);
      if (arr) arr.push(c);
      else byRow.set(r, [c]);
    }
    const captured = result; // guard against a newer query replacing the grid mid-save
    const snapshot = { ...edits };
    const rowOrder: { r: number; cols: number[] }[] = [];
    const statements: { sql: string; values: (string | null)[] }[] = [];
    for (const [r, cols] of byRow) {
      const setClause = cols.map((c) => `${qid(captured.columns[c])} = ?`).join(", ");
      const setValues = cols.map((c) => snapshot[`${r}:${c}`]);
      const whereParts: string[] = [];
      const whereValues: (string | null)[] = [];
      pk.forEach((name, i) => {
        const orig = captured.rows[r][pkIdx[i]];
        if (orig === null) whereParts.push(`${qid(name)} IS NULL`);
        else {
          whereParts.push(`${qid(name)} = ?`);
          whereValues.push(orig);
        }
      });
      statements.push({
        sql: `UPDATE ${qid(db)}.${qid(table)} SET ${setClause} WHERE ${whereParts.join(" AND ")}`,
        values: [...setValues, ...whereValues],
      });
      rowOrder.push({ r, cols });
    }
    setSavingEdits(true);
    setError("");
    try {
      // Atomic: every row must match exactly one row or the whole batch rolls back.
      await api.dbExecBatch(baseParams(), statements);
      setResult((prev) => {
        if (prev !== captured) return prev; // grid was replaced; DB is updated, skip local merge
        const newRows = prev.rows.map((row) => row.slice());
        for (const { r, cols } of rowOrder) for (const c of cols) newRows[r][c] = snapshot[`${r}:${c}`];
        return { ...prev, rows: newRows };
      });
      setEdits({});
      setEditingCell(null);
      setNotice(`Saved ${rowOrder.length} row(s).`);
    } catch (e) {
      // Batch rolled back — nothing was saved; keep the pending edits so the user can retry.
      setError(String(e));
    } finally {
      setSavingEdits(false);
    }
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

  async function refreshObjects(db: string) {
    setSchemaLoading(true);
    try {
      const objs = await api.dbSchemaObjects(baseParams(), db);
      setObjects((o) => ({ ...o, [db]: objs }));
    } catch (e) {
      setError(String(e));
    } finally {
      setSchemaLoading(false);
    }
  }

  function openNewTable(db: string) {
    setError("");
    setDesigner({
      db,
      table: "",
      isNew: true,
      columns: [
        { name: "id", type: "BIGINT UNSIGNED", length: "20", nullable: false, def: "", pk: true, ai: true },
      ],
      original: [],
      fks: [],
      originalFks: [],
      indexes: [],
      originalIndexes: [],
    });
  }

  async function designTable(db: string, table: string) {
    setError("");
    setSchemaLoading(true);
    try {
      const bp = baseParams();
      // Run the three structure queries in parallel (one round-trip instead of
      // three) — opening Design felt laggy over a tunnel doing them serially.
      const [res, fkRes, idxRes] = await Promise.all([
        api.dbQuery(bp, `SHOW COLUMNS FROM \`${db}\`.\`${table}\`;`),
        api.dbQuery(
          bp,
          `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE
           FROM information_schema.KEY_COLUMN_USAGE k
           JOIN information_schema.REFERENTIAL_CONSTRAINTS r
             ON r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
           WHERE k.TABLE_SCHEMA = '${db.replace(/'/g, "''")}' AND k.TABLE_NAME = '${table.replace(/'/g, "''")}'
             AND k.REFERENCED_TABLE_NAME IS NOT NULL;`,
        ),
        api.dbQuery(bp, `SHOW INDEX FROM \`${db}\`.\`${table}\`;`),
      ]);
      const cols: DesignColumn[] = res.rows.map((r) => {
        const parsed = parseType(r[1] ?? "");
        return {
          name: r[0] ?? "",
          type: parsed.type,
          length: parsed.length,
          nullable: (r[2] ?? "").toUpperCase() === "YES",
          def: r[4] ?? "",
          pk: (r[3] ?? "").toUpperCase() === "PRI",
          ai: (r[5] ?? "").toLowerCase().includes("auto_increment"),
          orig: r[0] ?? "",
        };
      });
      const fks: ForeignKey[] = fkRes.rows.map((r) => ({
        name: r[0] ?? "",
        column: r[1] ?? "",
        refTable: r[2] ?? "",
        refColumn: r[3] ?? "",
        onDelete: r[4] ?? "",
        onUpdate: r[5] ?? "",
        orig: r[0] ?? "",
      }));
      const idxMap = new Map<string, { columns: string[]; unique: boolean }>();
      for (const r of idxRes.rows) {
        const key = r[2] ?? "";
        if (!key || key.toUpperCase() === "PRIMARY") continue;
        if (!idxMap.has(key)) idxMap.set(key, { columns: [], unique: (r[1] ?? "1") === "0" });
        idxMap.get(key)!.columns.push(r[4] ?? "");
      }
      const indexes: TableIndex[] = Array.from(idxMap.entries()).map(([name, v]) => ({
        name,
        columns: v.columns.join(", "),
        unique: v.unique,
        orig: name,
      }));
      setDesigner({
        db,
        table,
        isNew: false,
        columns: cols,
        original: cols.map((c) => ({ ...c })),
        fks,
        originalFks: fks.map((f) => ({ ...f })),
        indexes,
        originalIndexes: indexes.map((x) => ({ ...x })),
      });
      fks.forEach((f) => loadRefCols(db, f.refTable));
    } catch (e) {
      setError(String(e));
    } finally {
      setSchemaLoading(false);
    }
  }

  async function loadRefCols(db: string, table: string) {
    const t = table.trim();
    if (!t || refCols[t] || !(objects[db]?.tables ?? []).includes(t)) return;
    try {
      const res = await api.dbQuery(baseParams(), `SHOW COLUMNS FROM \`${db}\`.\`${t}\`;`);
      setRefCols((m) => ({ ...m, [t]: res.rows.map((r) => r[0] ?? "").filter(Boolean) }));
    } catch {
      /* table may be elsewhere or unreadable — leave the suggestions empty */
    }
  }

  function dropTable(db: string, table: string) {
    setAsk({
      title: "Drop table",
      label: `Permanently drop \`${db}\`.\`${table}\`? This cannot be undone.`,
      confirmText: "Drop",
      danger: true,
      run: () => {
        void (async () => {
          setSchemaLoading(true);
          try {
            setError("");
            await api.dbQuery(baseParams(), `DROP TABLE \`${db}\`.\`${table}\`;`);
            await refreshObjects(db);
            setNotice(`Dropped table ${table}`);
          } catch (e) {
            setError(String(e));
          } finally {
            setSchemaLoading(false);
          }
        })();
      },
    });
  }

  function updateCol(i: number, patch: Partial<DesignColumn>) {
    setDesigner((d) =>
      d ? { ...d, columns: d.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) } : d,
    );
  }
  function addCol() {
    setDesigner((d) =>
      d
        ? {
            ...d,
            columns: [
              ...d.columns,
              { name: "", type: "VARCHAR", length: "255", nullable: true, def: "", pk: false, ai: false },
            ],
          }
        : d,
    );
  }
  function removeCol(i: number) {
    setDesigner((d) => (d ? { ...d, columns: d.columns.filter((_, j) => j !== i) } : d));
  }
  function updateFk(i: number, patch: Partial<ForeignKey>) {
    setDesigner((d) => (d ? { ...d, fks: d.fks.map((f, j) => (j === i ? { ...f, ...patch } : f)) } : d));
  }
  function addFk() {
    setDesigner((d) =>
      d
        ? {
            ...d,
            fks: [
              ...d.fks,
              { name: "", column: "", refTable: "", refColumn: "", onDelete: "", onUpdate: "" },
            ],
          }
        : d,
    );
  }
  function removeFk(i: number) {
    setDesigner((d) => (d ? { ...d, fks: d.fks.filter((_, j) => j !== i) } : d));
  }
  function fkValid(f: ForeignKey): boolean {
    return !!(f.column.trim() && f.refTable.trim() && f.refColumn.trim());
  }
  function fkClause(f: ForeignKey): string {
    let s = f.name.trim() ? `CONSTRAINT \`${f.name.trim()}\` ` : "";
    s += `FOREIGN KEY (\`${f.column.trim()}\`) REFERENCES \`${f.refTable.trim()}\` (\`${f.refColumn.trim()}\`)`;
    if (f.onDelete) s += ` ON DELETE ${f.onDelete}`;
    if (f.onUpdate) s += ` ON UPDATE ${f.onUpdate}`;
    return s;
  }
  function fkChanged(f: ForeignKey, o?: ForeignKey): boolean {
    return (
      !o ||
      f.column !== o.column ||
      f.refTable !== o.refTable ||
      f.refColumn !== o.refColumn ||
      f.onDelete !== o.onDelete ||
      f.onUpdate !== o.onUpdate
    );
  }
  function updateIdx(i: number, patch: Partial<TableIndex>) {
    setDesigner((d) => (d ? { ...d, indexes: d.indexes.map((x, j) => (j === i ? { ...x, ...patch } : x)) } : d));
  }
  function addIdx() {
    setDesigner((d) =>
      d ? { ...d, indexes: [...d.indexes, { name: "", columns: "", unique: false }] } : d,
    );
  }
  function removeIdx(i: number) {
    setDesigner((d) => (d ? { ...d, indexes: d.indexes.filter((_, j) => j !== i) } : d));
  }
  function idxCols(x: TableIndex): string {
    return x.columns
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => `\`${c}\``)
      .join(", ");
  }
  function idxValid(x: TableIndex): boolean {
    return !!idxCols(x);
  }
  function idxCreateClause(x: TableIndex): string {
    return `${x.unique ? "UNIQUE " : ""}KEY ${x.name.trim() ? `\`${x.name.trim()}\` ` : ""}(${idxCols(x)})`;
  }
  function idxAddClause(x: TableIndex): string {
    return `ADD ${x.unique ? "UNIQUE INDEX" : "INDEX"} ${x.name.trim() ? `\`${x.name.trim()}\` ` : ""}(${idxCols(x)})`;
  }
  function idxChanged(x: TableIndex, o?: TableIndex): boolean {
    const norm = (s: string) => s.replace(/\s/g, "");
    return !o || norm(x.columns) !== norm(o.columns) || x.unique !== o.unique || x.name !== o.name;
  }

  function quoteDefault(def: string): string {
    const d = def.trim();
    const up = d.toUpperCase();
    if (d === "") return "";
    if (up === "NULL" || up === "CURRENT_TIMESTAMP" || /^-?\d+(\.\d+)?$/.test(d)) return d;
    return `'${d.replace(/'/g, "''")}'`;
  }
  function colDef(c: DesignColumn): string {
    let s = `\`${c.name.trim()}\` ${typeSql(c)}`;
    s += c.nullable ? " NULL" : " NOT NULL";
    if (c.def.trim() !== "") s += ` DEFAULT ${quoteDefault(c.def)}`;
    if (c.ai) s += " AUTO_INCREMENT";
    return s;
  }
  function buildCreateSql(d: DesignerState): string {
    const cols = d.columns.filter((c) => c.name.trim());
    const lines = cols.map(colDef);
    const pk = cols.filter((c) => c.pk).map((c) => `\`${c.name.trim()}\``);
    if (pk.length) lines.push(`PRIMARY KEY (${pk.join(", ")})`);
    for (const f of d.fks.filter(fkValid)) lines.push(fkClause(f));
    for (const x of d.indexes.filter(idxValid)) lines.push(idxCreateClause(x));
    return `CREATE TABLE \`${d.db}\`.\`${d.table.trim()}\` (\n  ${lines.join(",\n  ")}\n);`;
  }
  function buildAlterSql(d: DesignerState): string {
    const clauses: string[] = [];
    const byOrig = new Map(d.original.map((c) => [c.orig, c]));
    const liveOrigs = new Set(d.columns.filter((c) => c.orig).map((c) => c.orig));
    for (const o of d.original) {
      if (!liveOrigs.has(o.orig)) clauses.push(`DROP COLUMN \`${o.orig}\``);
    }
    for (const c of d.columns) {
      if (!c.name.trim()) continue;
      if (!c.orig) {
        clauses.push(`ADD COLUMN ${colDef(c)}`);
      } else {
        const o = byOrig.get(c.orig);
        const changed =
          !o ||
          o.name !== c.name ||
          o.type !== c.type ||
          o.length !== c.length ||
          o.nullable !== c.nullable ||
          o.def !== c.def ||
          o.ai !== c.ai;
        if (changed) clauses.push(`CHANGE COLUMN \`${c.orig}\` ${colDef(c)}`);
      }
    }
    const newPk = d.columns.filter((c) => c.pk).map((c) => `\`${c.name.trim()}\``).join(", ");
    const oldPk = d.original.filter((c) => c.pk).map((c) => `\`${c.name}\``).join(", ");
    if (newPk !== oldPk) {
      if (oldPk) clauses.push("DROP PRIMARY KEY");
      if (newPk) clauses.push(`ADD PRIMARY KEY (${newPk})`);
    }
    const liveFkOrigs = new Set(d.fks.filter((f) => f.orig).map((f) => f.orig));
    for (const o of d.originalFks) {
      if (!liveFkOrigs.has(o.orig)) clauses.push(`DROP FOREIGN KEY \`${o.orig}\``);
    }
    for (const f of d.fks) {
      if (!fkValid(f)) continue;
      if (!f.orig) {
        clauses.push(`ADD ${fkClause(f)}`);
      } else if (fkChanged(f, d.originalFks.find((x) => x.orig === f.orig))) {
        clauses.push(`DROP FOREIGN KEY \`${f.orig}\``);
        clauses.push(`ADD ${fkClause(f)}`);
      }
    }
    const liveIdxOrigs = new Set(d.indexes.filter((x) => x.orig).map((x) => x.orig));
    for (const o of d.originalIndexes) {
      if (!liveIdxOrigs.has(o.orig)) clauses.push(`DROP INDEX \`${o.orig}\``);
    }
    for (const x of d.indexes) {
      if (!idxValid(x)) continue;
      if (!x.orig) {
        clauses.push(idxAddClause(x));
      } else if (idxChanged(x, d.originalIndexes.find((o) => o.orig === x.orig))) {
        clauses.push(`DROP INDEX \`${x.orig}\``);
        clauses.push(idxAddClause(x));
      }
    }
    if (!clauses.length) return "";
    return `ALTER TABLE \`${d.db}\`.\`${d.table}\`\n  ${clauses.join(",\n  ")};`;
  }
  function designerSql(d: DesignerState): string {
    return d.isNew ? buildCreateSql(d) : buildAlterSql(d);
  }
  function previewDesignerSql() {
    if (designer) {
      setActiveQuery(null);
      setSql(designerSql(designer));
    }
  }
  async function saveDesigner() {
    if (!designer) return;
    const d = designer;
    if (d.isNew && !d.table.trim()) {
      setNotice("Enter a table name.");
      return;
    }
    if (!d.columns.some((c) => c.name.trim())) {
      setNotice("Add at least one column.");
      return;
    }
    const sqlText = designerSql(d);
    if (!sqlText) {
      setNotice("No changes to save.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.dbQuery(baseParams(), sqlText);
      await refreshObjects(d.db);
      setDesigner(null);
      setNotice(d.isNew ? `Created table ${d.table}` : `Updated table ${d.table}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** True when the open designer has edits that haven't been saved yet. */
  function isDesignerDirty(): boolean {
    const d = designer;
    if (!d) return false;
    if (d.isNew)
      return (
        !!d.table.trim() ||
        d.columns.some((c) => c.name.trim()) ||
        d.fks.length > 0 ||
        d.indexes.length > 0
      );
    // Existing table: dirty when the generated ALTER would have any clauses.
    return !!designerSql(d);
  }

  /** Run `proceed`, but if the designer OR the data grid has unsaved edits, confirm first. */
  function guardLeave(proceed: () => void) {
    const designerDirty = isDesignerDirty();
    const dataDirty = Object.keys(edits).length > 0;
    if (!designerDirty && !dataDirty) {
      proceed();
      return;
    }
    const label = designerDirty
      ? `“${designer?.table.trim() || "the new table"}” has unsaved changes in the designer. Leave and discard them?`
      : `You have ${Object.keys(edits).length} unsaved cell edit(s). Leave and discard them?`;
    setAsk({
      title: "Discard unsaved changes?",
      label,
      confirmText: "Discard",
      danger: true,
      run: () => proceed(),
    });
  }

  async function run(sqlText?: string, db?: string) {
    setBusy(true);
    setError("");
    setDdl(null);
    setDesigner(null);
    // A fresh query replaces the grid — editing only applies to "Open data".
    setEditTable(null);
    setEdits({});
    setEditingCell(null);
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
                          onClick={() => guardLeave(() => openTable(db, t))}
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
                          onClick={() => guardLeave(() => openTable(db, v))}
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
                          onClick={() => guardLeave(() => showDdl(db, r.name, "routine", r.kind))}
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
              <button onClick={() => guardLeave(() => run())} disabled={busy || savingEdits}>
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
                  {editTable && (editable ? " · double-click a cell to edit" : " · read-only (no primary key)")}
                </span>
              )}
            </div>
            {result?.truncated && (
              <div className="trunc-note">
                <Icon name="minimize" size={12} /> Showing the first {rowLimit.toLocaleString()} rows. Raise “Limit”
                (or add a <code>WHERE</code>/<code>LIMIT</code>) to fetch more.
              </div>
            )}
            {designer && (
              <div className="designer">
                <div className="designer-head">
                  <span className="designer-title">
                    <Icon name="table" size={14} />{" "}
                    {designer.isNew ? "New table" : `Design · ${designer.table}`}
                  </span>
                  <input
                    className="designer-name"
                    placeholder="table name"
                    value={designer.table}
                    disabled={!designer.isNew}
                    onChange={(e) => setDesigner((d) => (d ? { ...d, table: e.target.value } : d))}
                  />
                </div>
                <div className="designer-scroll">
                <div className="designer-grid">
                  <div className="designer-row designer-cols-head">
                    <span>Name</span>
                    <span>Type</span>
                    <span>Length</span>
                    <span>Null</span>
                    <span>Default</span>
                    <span>PK</span>
                    <span>AI</span>
                    <span />
                  </div>
                  {designer.columns.map((c, i) => (
                    <div className="designer-row" key={i}>
                      <input value={c.name} placeholder="column" onChange={(e) => updateCol(i, { name: e.target.value })} />
                      <select value={c.type} onChange={(e) => updateCol(i, { type: e.target.value })}>
                        {(COMMON_TYPES.includes(c.type) ? COMMON_TYPES : [c.type, ...COMMON_TYPES]).map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                      <input value={c.length} placeholder="—" onChange={(e) => updateCol(i, { length: e.target.value })} />
                      <input type="checkbox" checked={c.nullable} onChange={(e) => updateCol(i, { nullable: e.target.checked })} />
                      <input value={c.def} placeholder="—" onChange={(e) => updateCol(i, { def: e.target.value })} />
                      <input type="checkbox" checked={c.pk} onChange={(e) => updateCol(i, { pk: e.target.checked })} />
                      <input type="checkbox" checked={c.ai} onChange={(e) => updateCol(i, { ai: e.target.checked })} />
                      <button className="icon" title="Remove column" onClick={() => removeCol(i)}>
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="designer-fks">
                  <div className="designer-subhead">Foreign keys (relationships)</div>
                  {designer.fks.map((f, i) => (
                    <div className="designer-fk-row" key={i}>
                      <input
                        list="db-cols"
                        placeholder="column"
                        value={f.column}
                        onChange={(e) => updateFk(i, { column: e.target.value })}
                      />
                      <span className="fk-arrow">→</span>
                      <input
                        list="db-tables"
                        placeholder="ref table"
                        value={f.refTable}
                        onChange={(e) => {
                          updateFk(i, { refTable: e.target.value, refColumn: "" });
                          loadRefCols(designer.db, e.target.value);
                        }}
                      />
                      <input
                        list={`fkcols-${i}`}
                        placeholder="ref col"
                        value={f.refColumn}
                        onChange={(e) => updateFk(i, { refColumn: e.target.value })}
                      />
                      <datalist id={`fkcols-${i}`}>
                        {(refCols[f.refTable] ?? []).map((c) => (
                          <option key={c} value={c} />
                        ))}
                      </datalist>
                      <select value={f.onDelete} onChange={(e) => updateFk(i, { onDelete: e.target.value })} title="ON DELETE">
                        {FK_ACTIONS.map((a) => (
                          <option key={a} value={a}>
                            {a ? `DEL: ${a}` : "ON DELETE…"}
                          </option>
                        ))}
                      </select>
                      <select value={f.onUpdate} onChange={(e) => updateFk(i, { onUpdate: e.target.value })} title="ON UPDATE">
                        {FK_ACTIONS.map((a) => (
                          <option key={a} value={a}>
                            {a ? `UPD: ${a}` : "ON UPDATE…"}
                          </option>
                        ))}
                      </select>
                      <button className="icon" title="Remove foreign key" onClick={() => removeFk(i)}>
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  ))}
                  <datalist id="db-cols">
                    {designer.columns
                      .filter((c) => c.name.trim())
                      .map((c) => (
                        <option key={c.name} value={c.name} />
                      ))}
                  </datalist>
                  <datalist id="db-tables">
                    {(objects[designer.db]?.tables ?? []).map((t) => (
                      <option key={t} value={t} />
                    ))}
                  </datalist>
                </div>

                <div className="designer-fks">
                  <div className="designer-subhead">Indexes</div>
                  {designer.indexes.map((x, i) => (
                    <div className="designer-idx-row" key={i}>
                      <input
                        placeholder="index name (optional)"
                        value={x.name}
                        onChange={(e) => updateIdx(i, { name: e.target.value })}
                      />
                      <input
                        list="db-cols"
                        placeholder="columns: col1, col2"
                        value={x.columns}
                        onChange={(e) => updateIdx(i, { columns: e.target.value })}
                      />
                      <label className="idx-unique">
                        <input
                          type="checkbox"
                          checked={x.unique}
                          onChange={(e) => updateIdx(i, { unique: e.target.checked })}
                        />{" "}
                        Unique
                      </label>
                      <button className="icon" title="Remove index" onClick={() => removeIdx(i)}>
                        <Icon name="x" size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                </div>

                <div className="form-row designer-actions">
                  <button onClick={addCol}>
                    <Icon name="plus" size={13} /> Add column
                  </button>
                  <button className="ghost" onClick={addFk}>
                    <Icon name="plus" size={13} /> Add foreign key
                  </button>
                  <button className="ghost" onClick={addIdx}>
                    <Icon name="plus" size={13} /> Add index
                  </button>
                  <button className="ghost" style={{ marginLeft: "auto" }} onClick={previewDesignerSql}>
                    <Icon name="code" size={13} /> Preview SQL
                  </button>
                  <button onClick={saveDesigner} disabled={busy}>
                    <Icon name="save" size={13} /> {busy ? "Saving…" : "Save"}
                  </button>
                  <button className="ghost" onClick={() => guardLeave(() => setDesigner(null))}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {!designer && ddl !== null && (
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
            {!designer && ddl === null && result && editTable && editCount > 0 && (
              <div className="edit-bar">
                <span>
                  {editCount} cell{editCount > 1 ? "s" : ""} changed
                </span>
                <div className="edit-bar-actions">
                  <button className="primary" onClick={() => saveEdits()} disabled={savingEdits}>
                    <Icon name="save" size={13} /> {savingEdits ? "Saving…" : "Save changes"}
                  </button>
                  <button className="ghost" onClick={discardEdits} disabled={savingEdits}>
                    Discard
                  </button>
                </div>
              </div>
            )}
            {!designer && ddl === null && result && (
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
                        {result.rows.slice(start, end).map((row, vi) => {
                          const rIdx = start + vi;
                          return (
                            <tr key={rIdx}>
                              {row.map((cell, ci) => {
                                const k = `${rIdx}:${ci}`;
                                const dirty = k in edits;
                                const val = dirty ? edits[k] : cell;
                                // Binary columns can't round-trip as text — leave them read-only.
                                const cellEditable = editable && !result.binary_cols?.[ci];
                                if (editingCell && editingCell.r === rIdx && editingCell.c === ci) {
                                  return (
                                    <td key={ci} className="editing">
                                      <input
                                        key={k}
                                        className="cell-edit"
                                        defaultValue={val ?? ""}
                                        autoFocus
                                        onFocus={(e) => e.currentTarget.select()}
                                        onBlur={(e) => commitEdit(rIdx, ci, e.currentTarget.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            e.preventDefault();
                                            commitEdit(rIdx, ci, e.currentTarget.value);
                                          } else if (e.key === "Escape") {
                                            e.preventDefault();
                                            setEditingCell(null);
                                          }
                                        }}
                                      />
                                    </td>
                                  );
                                }
                                return (
                                  <td
                                    key={ci}
                                    className={`${dirty ? "dirty-cell" : ""}${cellEditable ? " editable" : ""}`}
                                    title={val ?? undefined}
                                    onDoubleClick={() => cellEditable && setEditingCell({ r: rIdx, c: ci })}
                                    onContextMenu={
                                      cellEditable
                                        ? (e) => {
                                            e.preventDefault();
                                            setCellMenu({ x: e.clientX, y: e.clientY, r: rIdx, c: ci });
                                          }
                                        : undefined
                                    }
                                  >
                                    {val === null ? <em className="null">NULL</em> : val}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
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
          {menu.kind === "category" && menu.cat === "tables" && (
            <li onClick={() => { const db = menu.db; setMenu(null); guardLeave(() => openNewTable(db)); }}>
              <Icon name="plus" size={13} /> New table
            </li>
          )}
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
              <li onClick={() => { const db = menu.db, n = menu.name!; setMenu(null); guardLeave(() => openTable(db, n)); }}>
                <Icon name="table" size={13} /> Open data
              </li>
              <li onClick={() => { const db = menu.db, n = menu.name!; setMenu(null); guardLeave(() => showDdl(db, n)); }}>
                <Icon name="code" size={13} /> Show DDL
              </li>
              {menu.kind === "table" && (
                <>
                  <li onClick={() => { const db = menu.db, n = menu.name!; setMenu(null); guardLeave(() => designTable(db, n)); }}>
                    <Icon name="edit" size={13} /> Design table
                  </li>
                  <li onClick={() => { exportSql(menu.db, menu.name); setMenu(null); }}>
                    <Icon name="download" size={13} /> Export SQL
                  </li>
                </>
              )}
              <li onClick={() => { copyText(`\`${menu.db}\`.\`${menu.name}\``); setMenu(null); }}>
                <Icon name="copy" size={13} /> Copy name
              </li>
              {menu.kind === "table" && (
                <li className="danger" onClick={() => { dropTable(menu.db, menu.name!); setMenu(null); }}>
                  <Icon name="trash" size={13} /> Drop table
                </li>
              )}
            </>
          )}
          {menu.kind === "routine" && (
            <>
              <li onClick={() => { const db = menu.db, n = menu.name!, k = menu.routineKind; setMenu(null); guardLeave(() => showDdl(db, n, "routine", k)); }}>
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
              <li onClick={() => { const q = menu.query!, db = menu.db; setMenu(null); guardLeave(() => { setSql(q.sql); run(q.sql, db); }); }}>
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

      {cellMenu && (
        <ul
          className="ctx-menu"
          style={{ top: cellMenu.y, left: cellMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <li onClick={() => { setEditingCell({ r: cellMenu.r, c: cellMenu.c }); setCellMenu(null); }}>
            <Icon name="edit" size={13} /> Edit
          </li>
          <li onClick={() => setCellNull(cellMenu.r, cellMenu.c)}>
            <Icon name="x" size={13} /> Set NULL
          </li>
          {`${cellMenu.r}:${cellMenu.c}` in edits && (
            <li onClick={() => revertCell(cellMenu.r, cellMenu.c)}>
              <Icon name="refresh" size={13} /> Revert cell
            </li>
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
