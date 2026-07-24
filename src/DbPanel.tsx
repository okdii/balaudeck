import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { format } from "sql-formatter";
import CodeMirror from "@uiw/react-codemirror";
import { sql as sqlLang, MySQL, PostgreSQL, SQLite, MSSQL, StandardSQL, type SQLNamespace } from "@codemirror/lang-sql";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Channel } from "@tauri-apps/api/core";
import { api, type DumpS3Target } from "./api";
import { openDbConnection } from "./dbConnect";
import { newJobId } from "./transfers";
import { TransferList } from "./TransferList";
import { DB_ENGINES } from "./types";
import {
  buildCreate as ddlBuildCreate,
  buildAlter as ddlBuildAlter,
  buildDropTable as ddlBuildDropTable,
  buildCreateDatabase as ddlBuildCreateDatabase,
  designerFromSchema as ddlDesignerFromSchema,
  isMysqlFamily,
  type DesignColumn,
  type ForeignKey,
  type TableIndex,
  type DesignerState,
} from "./ddl";
import type {
  DbEngine,
  DbProfile,
  DbUser,
  DumpProgress,
  ImportProgress,
  QueryResult,
  SavedQuery,
  SchemaObjects,
  SshProfile,
} from "./types";
import {
  blankUserModel,
  buildDropUser,
  cloneMatrix,
  dbPrivs,
  diffPrivileges,
  diffUser,
  globalPrivs,
  scopeKey,
  tablePrivs,
  userFromDetail,
  userSql,
  type MatrixEntry,
  type PrivScope,
  type PrivilegeMatrix,
  type UserModel,
} from "./users";

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

/** The export dialog's destination picker, shown before the dump starts:
 *  "local" keeps today's save-dialog flow; "s3" uploads to a bucket instead. */
interface ExportSetup {
  db: string;
  table: string | null;
  dest: "local" | "s3";
  s3ProfileId: string;
  s3Bucket: string;
  s3Key: string;
}

/** Timestamp for the default S3 dump key, e.g. "20260707-153012" (local time). */
function dumpStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Keep a growing log pinned to its newest line, so the table being dumped right
 * now stays in view instead of scrolling off the bottom unseen.
 *
 * Sticks only while the user is already at the bottom: if they scroll up to
 * read an earlier line, following stops so the view isn't yanked away from
 * them, and resumes once they scroll back down.
 */
function useFollowTail(dep: number) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // "At the bottom" with a little slack for fractional scroll heights.
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return { ref, onScroll };
}

/** Date half of a dump name: `YYYYMMDD`. */
function dumpDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Directory part of a picked path, handling both separators. Null when the
 *  path has none (or is a mobile content:// URI, where there's no dir to scan). */
function dirOf(p: string): string | null {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 && !p.startsWith("content://") ? p.slice(0, i) : null;
}

/** Where the last dump was saved — scanned to continue that day's numbering. */
const DUMP_DIR_KEY = "balaudeck.dumpDir";

/**
 * Default dump filename: `<db>-<YYYYMMDD>-<n>.sql`.
 *
 * `n` is the next free number for TODAY in `dir`, so repeat dumps of the same
 * database land as -1, -2, -3 rather than the OS appending its own " 2". Only
 * today's files count — yesterday's numbering restarts. Falls back to -1 when
 * the directory can't be read (first ever dump, or a mobile SAF target).
 */
async function nextDumpName(base: string, dir: string | null): Promise<string> {
  const prefix = `${base}-${dumpDate(new Date())}-`;
  let n = 1;
  if (dir) {
    try {
      const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${esc}(\\d+)\\.sql$`, "i");
      for (const name of await api.listDir(dir)) {
        const m = re.exec(name);
        if (m) n = Math.max(n, Number(m[1]) + 1);
      }
    } catch {
      /* unreadable dir — start the day's numbering at 1 */
    }
  }
  return `${prefix}${n}.sql`;
}

interface ImportState {
  id: string;
  title: string;
  path: string;
  continueOnError: boolean;
  dropTables: boolean;
  autocommitOff: boolean;
  multiQuery: boolean;
  encoding: string;
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

/** Bulk CSV → table import: parsed file, column mapping, and progress. */
interface CsvImportState {
  db: string;
  table: string;
  path: string;
  filename: string;
  text: string; // raw file content, kept so delimiter/header toggles re-parse
  tableCols: string[]; // the target table's real columns
  delimiter: string;
  hasHeader: boolean;
  emptyAsNull: boolean;
  header: string[]; // labels for each CSV column
  body: string[][]; // data rows (header excluded)
  preview: string[][]; // first few data rows
  mapping: (string | null)[]; // CSV column i → target table column, or null = skip
  rowCount: number;
  running: boolean;
  done: boolean;
  inserted: number;
  error: string;
}

// DesignColumn / ForeignKey / TableIndex / DesignerState + the dialect DDL
// builders live in ./ddl (imported above) so the designer's SQL generation is
// shared and unit-testable.

/** A SQL editor tab. "query" = a user scratch query; "data" = opened from a
 *  sidebar object (table data / DDL / designer) so query tabs aren't clobbered. */
interface QueryTab {
  id: string;
  kind: "query" | "data";
  title: string;
}
/** One row of the Navicat-style data-grid filter (column · operator · value). */
/** A single column test in the filter tree. `connector` is how this node joins
 *  to the NEXT sibling (AND/OR); the last sibling's connector is ignored. */
interface FilterCondNode {
  kind: "cond";
  id: string;
  enabled: boolean;
  connector: "AND" | "OR";
  column: string;
  op: string;
  value: string;
}
/** A parenthesised group of nodes — lets AND/OR mix unambiguously, Navicat-style. */
interface FilterGroupNode {
  kind: "group";
  id: string;
  enabled: boolean;
  connector: "AND" | "OR";
  children: FilterNode[];
}
type FilterNode = FilterCondNode | FilterGroupNode;
/** Visual filter attached to a table-data tab; rebuilds the WHERE clause.
 *  `applied` is the number of conditions in the WHERE currently shown in the
 *  grid (updated on Apply/Clear), so the funnel badge reflects the live result,
 *  not the in-progress draft. */
interface SortState {
  col: string;
  dir: "ASC" | "DESC";
}
/** One outgoing foreign key of the browsed table: `column` in this table points
 *  at `refColumn` of `refTable` (same database). Powers FK cell click-through. */
interface FkRef {
  column: string;
  refTable: string;
  refColumn: string;
}
/** Per-tab browse view state for a table-data grid (filter + sort + page). */
interface FilterState {
  open: boolean;
  nodes: FilterNode[];
  applied: number;
  /** The table this filter targets. Held here (not read from `editTable`) so the
   *  panel survives a plain Run — which clears `editTable` — without ever letting
   *  a since-changed query misdirect inline edits. */
  table: { db: string; table: string; pk: string[] };
  /** Click-to-sort column (null = natural order) and paging offset. */
  sort: SortState | null;
  offset: number;
  /** Outgoing foreign keys of this table (MySQL only), for cell click-through. */
  fks: FkRef[];
}
const PAGE_SIZE = 200;
/** The per-tab work-area state, saved on tab switch and restored on return. */
/** The Users (privilege-management) work area, one per data tab. */
interface UsersState {
  list: DbUser[];
  filter: string;
  selected: { name: string; host: string } | null;
  model: UserModel | null;
  origModel: UserModel | null;
  matrix: PrivilegeMatrix | null;
  origMatrix: PrivilegeMatrix | null;
  detailTab: "general" | "global" | "objects" | "roles" | "sql";
  isNew: boolean;
  loadingDetail: boolean;
  objDb: string; // database selected in the Object Privileges tab
  objTable: string; // "" = database-level (db.*)
}

interface TabSnapshot {
  sql: string;
  result: QueryResult | null;
  ddl: string | null;
  designer: DesignerState | null;
  users: UsersState | null;
  editTable: { db: string; table: string; pk: string[] } | null;
  edits: Record<string, string | null>;
  activeQuery: SavedQuery | null;
  filters: FilterState | null;
}
function emptyTabSnapshot(): TabSnapshot {
  return { sql: "", result: null, ddl: null, designer: null, users: null, editTable: null, edits: {}, activeQuery: null, filters: null };
}
/** Operators offered in the filter builder; the two NULL ops take no value. */
const FILTER_OPS = ["=", "<>", ">", ">=", "<", "<=", "LIKE", "NOT LIKE", "IN", "IS NULL", "IS NOT NULL"] as const;
const FILTER_NOVAL = new Set(["IS NULL", "IS NOT NULL"]);
function newCondNode(column = ""): FilterCondNode {
  return { kind: "cond", id: crypto.randomUUID(), enabled: true, connector: "AND", column, op: "=", value: "" };
}
function newGroupNode(): FilterGroupNode {
  return { kind: "group", id: crypto.randomUUID(), enabled: true, connector: "AND", children: [newCondNode()] };
}

/** RFC-4180-ish CSV parser: honours quoted fields (with ""-escaped quotes and
 *  embedded delimiters/newlines), a configurable single-char delimiter, and
 *  CRLF or LF line endings. Returns rows of raw string fields. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const n = text.length;
  const d = delimiter || ",";
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === d) {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // swallow; the paired \n (or a lone \n) ends the record
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Flush a final record that isn't newline-terminated.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Guess the delimiter from the header line: the most frequent of , ; or tab. */
function guessDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const cand = [",", ";", "\t"];
  let best = ",";
  let hi = -1;
  for (const d of cand) {
    const c = first.split(d).length - 1;
    if (c > hi) {
      hi = c;
      best = d;
    }
  }
  return best;
}
/** Return a new tree with the node identified by `id` replaced by `fn(node)`. */
function mapFilterNode(nodes: FilterNode[], id: string, fn: (n: FilterNode) => FilterNode): FilterNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n);
    if (n.kind === "group") return { ...n, children: mapFilterNode(n.children, id, fn) };
    return n;
  });
}
/** Return a new tree with the node `id` removed (searched recursively). */
function removeFilterNode(nodes: FilterNode[], id: string): FilterNode[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => (n.kind === "group" ? { ...n, children: removeFilterNode(n.children, id) } : n));
}
/** Append `node` to the root list (parentId null) or into the group `parentId`. */
function addFilterNode(nodes: FilterNode[], parentId: string | null, node: FilterNode): FilterNode[] {
  if (parentId === null) return [...nodes, node];
  return nodes.map((n) => {
    if (n.id === parentId && n.kind === "group") return { ...n, children: [...n.children, node] };
    if (n.kind === "group") return { ...n, children: addFilterNode(n.children, parentId, node) };
    return n;
  });
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

/** Recombine base type + length, placing (len) right after the base keyword. */
function typeSql(c: { type: string; length: string }): string {
  const t = c.type.trim();
  const len = c.length.trim();
  if (!len) return t;
  const sp = t.indexOf(" ");
  return sp === -1 ? `${t}(${len})` : `${t.slice(0, sp)}(${len})${t.slice(sp)}`;
}
import { Icon, Spinner, type IconName } from "./Icon";
import { AskModal, type AskOptions } from "./AskModal";
import { ConnectLauncher, EnginePicker } from "./SessionUI";
import { isDark, subscribeSettings } from "./settings";
import { AiChat } from "./AiChat";
import { makeDbToolset, dbSystemPrompt, type DbToolContext } from "./ai/tools/db";
import { maskText } from "./privacy";
import { loadHistory, pushHistory, clearHistory, type QHistEntry } from "./qhistory";

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
  engine?: string;
  host: string;
  port: number;
  user: string;
  password?: string | null;
  database?: string | null;
  file?: string | null;
  profile_id?: string | null;
}

export function DbPanel({
  prefill,
  initialEngine,
  onEngine,
  sshProfiles,
  dbProfiles = [],
  savedQueries = [],
  onQueriesChanged,
  onSession,
  dcSignal,
  aiOpen,
  onAiClose,
}: {
  prefill?: DbProfile | null;
  initialEngine?: DbEngine;
  onEngine?: (engine: DbEngine) => void;
  sshProfiles: SshProfile[];
  dbProfiles?: DbProfile[];
  savedQueries?: SavedQuery[];
  onQueriesChanged?: () => void;
  onSession?: (label: string) => void;
  dcSignal?: number;
  /** AI chat open state + close, driven by the pane toolbar (App.tsx). */
  aiOpen?: boolean;
  onAiClose?: () => void;
}) {
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("3306");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  // Engine drives dialect quoting / limit / SQL language; seeded from the profile
  // (saved preset) or the pane's ad-hoc engine, defaulting to MySQL.
  const [engine, setEngine] = useState<DbEngine>(
    (prefill?.engine as DbEngine) ?? initialEngine ?? "mysql",
  );
  const [file, setFile] = useState<string | null>(prefill?.file ?? null);
  const isMysql = engine === "mysql" || engine === "mariadb";
  const fmtLang: "mysql" | "mariadb" | "postgresql" | "transactsql" | "sqlite" =
    engine === "postgres"
      ? "postgresql"
      : engine === "mssql"
        ? "transactsql"
        : engine === "sqlite"
          ? "sqlite"
          : engine === "mariadb"
            ? "mariadb"
            : "mysql";
  const cmDialect =
    engine === "postgres"
      ? PostgreSQL
      : engine === "mssql"
        ? MSSQL
        : engine === "sqlite"
          ? SQLite
          : isMysql
            ? MySQL
            : StandardSQL;
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
  // User-dragged height of the filter panel (null = auto/flex).
  const [filterHeight, setFilterHeight] = useState<number | null>(null);
  const [filterResizing, setFilterResizing] = useState(false);
  const filterBarRef = useRef<HTMLDivElement | null>(null);
  const [rowLimit, setRowLimit] = useState(1000);
  // Virtualized result grid: only the visible row window is in the DOM.
  const gridRef = useRef<HTMLDivElement>(null);
  const cellInputRef = useRef<HTMLInputElement>(null);
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

  // Autocomplete schema for the SQL editor, built from the sidebar tree already
  // loaded into `objects` (one entry per database the user has expanded). Only
  // table/view names are in memory — the schema fetch doesn't return columns —
  // so this drives table-name + keyword completion; each name maps to an empty
  // column list. Names collide harmlessly across databases (empty arrays).
  const cmSchema = useMemo<SQLNamespace>(() => {
    const map: Record<string, readonly string[]> = {};
    for (const objs of Object.values(objects)) {
      for (const t of objs.tables) map[t] = [];
      for (const v of objs.views) map[v] = [];
    }
    return map;
  }, [objects]);

  // CodeMirror needs the language extension reconfigured when the dialect or the
  // discovered schema changes, so recompute it (the editor re-applies extensions
  // when this array identity changes).
  const cmExtensions = useMemo(
    () => [sqlLang({ dialect: cmDialect, schema: cmSchema, upperCaseKeywords: true })],
    [cmDialect, cmSchema],
  );

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
  // The SQL editor's light/dark theme follows the app's resolved theme (Settings
  // → Theme, honouring "System"), not the OS directly.
  const [dark, setDark] = useState(isDark);
  // Also re-render on any settings change so masked result cells (privacy
  // patterns) update live.
  const [, setPrivacyRev] = useState(0);
  useEffect(
    () =>
      subscribeSettings(() => {
        setDark(isDark());
        setPrivacyRev((n) => n + 1);
      }),
    [],
  );

  // Guards the resize handles against a second concurrent pointer restarting
  // the drag with a stale baseline.
  const resizingRef = useRef(false);

  function startEditorResize(e: ReactPointerEvent) {
    e.preventDefault();
    if (resizingRef.current) return;
    const startY = e.clientY;
    const startH = editorHeight;
    const handle = e.currentTarget as HTMLElement;
    resizingRef.current = true;
    handle.setPointerCapture(e.pointerId);
    setEditorResizing(true);
    document.body.style.cursor = "row-resize";
    const onMove = (ev: PointerEvent) =>
      setEditorHeight(Math.min(400, Math.max(56, startH + ev.clientY - startY)));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      resizingRef.current = false;
      setEditorResizing(false);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }
  /** Drag the bar under the filter panel to grow/shrink it, mirroring the SQL
   *  editor resizer. Capped so the grid keeps its ~160px minimum (no dead zone). */
  function startFilterResize(e: ReactPointerEvent) {
    e.preventDefault();
    if (resizingRef.current) return;
    const bar = filterBarRef.current;
    const grid = bar?.closest(".query-area")?.querySelector(".grid-wrap") as HTMLElement | null;
    const startY = e.clientY;
    const startH = filterHeight ?? bar?.offsetHeight ?? 220;
    const maxH = Math.max(140, (bar?.offsetHeight ?? startH) + (grid?.offsetHeight ?? 200) - 160);
    const handle = e.currentTarget as HTMLElement;
    resizingRef.current = true;
    handle.setPointerCapture(e.pointerId);
    setFilterResizing(true);
    document.body.style.cursor = "row-resize";
    const onMove = (ev: PointerEvent) =>
      setFilterHeight(Math.min(maxH, Math.max(96, startH + ev.clientY - startY)));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      resizingRef.current = false;
      setFilterResizing(false);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
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
  const [expSetup, setExpSetup] = useState<ExportSetup | null>(null);
  const [imp, setImp] = useState<ImportState | null>(null);
  const [csvImp, setCsvImp] = useState<CsvImportState | null>(null);
  // Progress logs follow their newest line as tables / errors stream in.
  const expLog = useFollowTail(exp?.log.length ?? 0);
  const impLog = useFollowTail(imp?.errors.length ?? 0);
  // Open manual-transaction session id (MySQL only); null = autocommit mode.
  const [txId, setTxId] = useState<string | null>(null);
  const [txBusy, setTxBusy] = useState(false);
  const txRef = useRef<string | null>(null);
  txRef.current = txId;
  // Query-plan (EXPLAIN) result shown in a modal.
  const [explain, setExplain] = useState<{ sql: string; plan: QueryResult } | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [designer, setDesigner] = useState<DesignerState | null>(null);
  const [users, setUsers] = useState<UsersState | null>(null);
  const [refCols, setRefCols] = useState<Record<string, string[]>>({});
  const [schemaLoading, setSchemaLoading] = useState(false);
  // Sidebar search: filters database names and loaded objects by substring.
  const [schemaFilter, setSchemaFilter] = useState("");
  // Query tabs: each tab is an independent SQL workspace. Query tabs are user
  // scratch; data tabs are opened from sidebar objects so they never clobber a
  // query you're writing. Per-tab work-area state lives in tabSnapshots.
  const [tabs, setTabs] = useState<QueryTab[]>([{ id: "q1", kind: "query", title: "Query 1" }]);
  const [activeTab, setActiveTab] = useState("q1");
  // Mirrors activeTab synchronously so async DB calls can tell whether the user
  // is still on the tab that started them (and route results accordingly).
  const activeTabRef = useRef("q1");
  // Per-tab run counter: a late source-table lookup only arms editing if its
  // tab hasn't run a newer query since (a query on another tab never suppresses).
  const runGenRef = useRef<Record<string, number>>({});
  const tabSeq = useRef(2);
  const tabSnapshots = useRef<Record<string, TabSnapshot>>({});
  // Inline data editing: when the grid shows a single table's data ("Open data"),
  // `editTable` carries its db/table/primary-key so edited cells can be persisted.
  const [editTable, setEditTable] = useState<{ db: string; table: string; pk: string[] } | null>(null);
  // Navicat-style visual filter for the current table-data grid (null = none).
  const [filters, setFilters] = useState<FilterState | null>(null);
  // Pending cell edits, keyed "row:col" → new value (null = SQL NULL).
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [editingCell, setEditingCell] = useState<{ r: number; c: number } | null>(null);
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; r: number; c: number } | null>(null);
  const [savingEdits, setSavingEdits] = useState(false);
  // Add-row form: column → typed value (null = dialog closed). Blank fields are
  // omitted from the INSERT so the DB default / auto-increment applies.
  const [newRow, setNewRow] = useState<Record<string, string> | null>(null);
  // Export-format flyout open state.
  const [exportMenu, setExportMenu] = useState(false);
  // Query-history flyout: open + loaded snapshot + search filter.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<QHistEntry[]>([]);
  const [historyFilter, setHistoryFilter] = useState("");

  useEffect(() => {
    if (!menu && !cellMenu && !exportMenu && !historyOpen) return;
    const close = () => {
      setMenu(null);
      setCellMenu(null);
      setExportMenu(false);
      setHistoryOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, cellMenu, exportMenu, historyOpen]);

  useEffect(() => {
    onSession?.(connected ? (selectedDb ? `${connLabel} · ${selectedDb}` : connLabel) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, connLabel, selectedDb]);

  useEffect(() => {
    if (dcSignal && dcSignal > 0) guardLeave(() => disconnect());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dcSignal]);

  // Roll back a still-open manual transaction if the panel unmounts (tab closed).
  useEffect(() => {
    return () => {
      if (txRef.current) api.dbTxRollback(txRef.current).catch(() => {});
    };
  }, []);

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
    const tab = openDataTab(`${db}.${name}`);
    setBusy(true);
    setError("");
    setResult(null);
    setActiveQuery(null);
    setDesigner(null);
    try {
      if (isMysqlFamily(engine)) {
        const isProc = (routineKind ?? "").toUpperCase() === "PROCEDURE";
        const q =
          kind === "routine"
            ? `SHOW CREATE ${isProc ? "PROCEDURE" : "FUNCTION"} \`${db}\`.\`${name}\`;`
            : `SHOW CREATE TABLE \`${db}\`.\`${name}\`;`;
        setSql(q);
        const res = await api.dbQuery(baseParams(), q);
        deliverToTab(tab, { ddl: res.rows[0]?.[kind === "routine" ? 2 : 1] ?? "" });
      } else if (kind === "table") {
        // No portable SHOW CREATE — reconstruct a canonical CREATE from the
        // engine-aware introspected schema.
        const schema = await api.dbTableSchema(baseParams(), db, name);
        const d = ddlDesignerFromSchema(db, name, schema);
        const ddlText = ddlBuildCreate(engine, d).map((s) => s.replace(/;\s*$/, "")).join(";\n") + ";";
        setSql(ddlText);
        deliverToTab(tab, { ddl: ddlText });
      } else {
        deliverToTab(tab, { ddl: "" });
        setNotice("Routine DDL view is available for MySQL/MariaDB connections only.");
      }
    } catch (e) {
      deliverToTab(tab, { ddl: null });
      if (activeTabRef.current === tab) setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function copyText(text: string) {
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  function beautify() {
    try {
      setSql(format(sql, { language: fmtLang, keywordCase: "upper" }));
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshDatabases() {
    const dbs = await api.dbListDatabases({ ...baseParams(), database: null });
    setDatabases(dbs.filter(Boolean));
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
        const createSql = ddlBuildCreateDatabase(engine, n);
        if (!createSql) {
          setNotice("SQLite uses one file per database — create a new .sqlite file instead.");
          return;
        }
        void (async () => {
          try {
            setError("");
            await api.dbQuery({ ...baseParams(), database: null }, createSql);
            await refreshDatabases();
            setNotice(`Created database ${n}`);
          } catch (e) {
            setError(String(e));
          }
        })();
      },
    });
  }

  /** S3-family profiles a dump can be uploaded to (the export dialog's list). */
  const s3Profiles = dbProfiles.filter((p) => DB_ENGINES[p.engine]?.family === "s3");

  /** Open the export dialog: pick a destination (local file / S3), then run. */
  function exportSql(db: string, table?: string) {
    setExpSetup({
      db,
      table: table ?? null,
      dest: "local",
      s3ProfileId: s3Profiles[0]?.id ?? "",
      s3Bucket: "",
      s3Key: `dumps/${table ?? db}-${dumpStamp(new Date())}.sql`,
    });
  }

  /** True when the chosen destination has everything it needs to run. */
  function exportReady(s: ExportSetup): boolean {
    if (s.dest === "local") return true;
    return !!(s.s3ProfileId && s.s3Bucket.trim() && s.s3Key.trim());
  }

  async function runExport() {
    if (!expSetup) return;
    const { db, table, dest, s3ProfileId, s3Bucket, s3Key } = expSetup;
    // Local destination: pick the target file first (cancel aborts, keeping
    // the dialog open). S3 stages to a temp file — `path` is ignored.
    let path = "";
    if (dest === "local") {
      // Default to <db>-<YYYYMMDD>-<n>.sql, continuing today's numbering in the
      // folder the last dump went to — that's where the next one usually goes.
      const lastDir = localStorage.getItem(DUMP_DIR_KEY);
      const name = await nextDumpName(table ?? db, lastDir);
      const sep = lastDir?.includes("\\") ? "\\" : "/";
      const picked = await save({
        defaultPath: lastDir ? `${lastDir}${sep}${name}` : name,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (!picked) return;
      path = picked;
      // Remember where it actually went, so the next dump numbers against it.
      const chosen = dirOf(picked);
      if (chosen) localStorage.setItem(DUMP_DIR_KEY, chosen);
    }
    setExpSetup(null);
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
    // An S3 destination may route through the profile's SSH tunnel — opened
    // here and torn down once the dump (and its upload) settles.
    let tunnelId: string | null = null;
    try {
      let s3: DumpS3Target | null = null;
      if (dest === "s3") {
        const profile = s3Profiles.find((p) => p.id === s3ProfileId);
        if (!profile) throw new Error("S3 connection not found");
        const conn = await openDbConnection(profile, sshProfiles);
        tunnelId = conn.tunnelId;
        // The job id routes the upload phase through the transfer queue shown
        // in the export modal (and makes it cancellable there).
        s3 = { params: conn.params, bucket: s3Bucket.trim(), key: s3Key.trim(), transfer_job_id: newJobId() };
      }
      await api.dbDump(baseParams(), db, table, path, id, ch, s3);
      setExp((p) => (p ? { ...p, done: true } : p));
    } catch (e) {
      setError(String(e));
      setExp(null);
    } finally {
      if (tunnelId) await api.tunnelStop(tunnelId).catch(() => {});
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
      dropTables: false,
      autocommitOff: true,
      multiQuery: true,
      encoding: "utf-8",
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
    const { id, path, title, continueOnError, dropTables, autocommitOff, multiQuery, encoding } = imp;
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
      await api.dbImportFile(
        baseParams(),
        path,
        title || null,
        id,
        continueOnError,
        dropTables,
        autocommitOff,
        multiQuery,
        encoding || null,
        ch,
      );
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

  // ---- Bulk CSV → table import ---------------------------------------------
  /** (Re)derive the CSV import view — header, data rows, preview, and an initial
   *  column mapping — from the raw text under the current delimiter/header
   *  choice. Header names are matched to table columns case-insensitively;
   *  headerless files map by position; anything unmatched is left as "skip". */
  function buildCsvState(base: {
    db: string;
    table: string;
    path: string;
    filename: string;
    text: string;
    tableCols: string[];
    delimiter: string;
    hasHeader: boolean;
    emptyAsNull: boolean;
  }): CsvImportState {
    const { text, delimiter, hasHeader, tableCols } = base;
    // Drop wholly-blank lines (a single empty field) so a trailing newline or
    // stray blank row doesn't become a phantom record.
    const rows = parseCsv(text, delimiter).filter((r) => !(r.length === 1 && r[0] === ""));
    const first = rows[0] ?? [];
    const header = hasHeader ? first.map((h) => h.trim()) : first.map((_, i) => `col${i + 1}`);
    const body = hasHeader ? rows.slice(1) : rows;
    const lower = tableCols.map((c) => c.toLowerCase());
    const mapping: (string | null)[] = header.map((h, i) => {
      const byName = lower.indexOf(h.toLowerCase());
      if (byName >= 0) return tableCols[byName];
      if (!hasHeader && i < tableCols.length) return tableCols[i];
      return null;
    });
    return {
      ...base,
      header,
      body,
      preview: body.slice(0, 5),
      mapping,
      rowCount: body.length,
      running: false,
      done: false,
      inserted: 0,
      error: "",
    };
  }

  /** Pick a CSV file, read it, fetch the target table's columns, and open the
   *  import dialog. Works on every engine (inserts go through dbExecBatch). */
  async function importCsv(db: string, table: string) {
    const path = await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }] });
    if (!path || typeof path !== "string") return;
    setError("");
    setMenu(null);
    let text: string;
    try {
      text = await api.readTextFile(path);
    } catch (e) {
      setError(`Could not read file: ${e}`);
      return;
    }
    let tableCols: string[] = [];
    try {
      // WHERE 1=0 returns the column set with no rows on every SQL engine.
      const res = await api.dbQuery(baseParams(), `SELECT * FROM ${qualifiedTable(db, table)} WHERE 1=0`);
      tableCols = res.columns;
    } catch (e) {
      setError(`Could not read ${table} columns: ${e}`);
      return;
    }
    const filename = path.split(/[\\/]/).pop() || path;
    setCsvImp(
      buildCsvState({
        db,
        table,
        path,
        filename,
        text,
        tableCols,
        delimiter: guessDelimiter(text),
        hasHeader: true,
        emptyAsNull: true,
      }),
    );
  }

  /** Apply a settings change to the CSV import; delimiter/header re-parse. */
  function reconfigureCsv(patch: Partial<Pick<CsvImportState, "delimiter" | "hasHeader" | "emptyAsNull">>) {
    setCsvImp((p) => {
      if (!p) return p;
      const next = { ...p, ...patch };
      if ("delimiter" in patch || "hasHeader" in patch) {
        return buildCsvState({
          db: p.db,
          table: p.table,
          path: p.path,
          filename: p.filename,
          text: p.text,
          tableCols: p.tableCols,
          delimiter: next.delimiter,
          hasHeader: next.hasHeader,
          emptyAsNull: next.emptyAsNull,
        });
      }
      return next;
    });
  }

  /** Change which target column a given CSV column maps to ("" = skip). */
  function setCsvMapping(csvIdx: number, tableCol: string) {
    setCsvImp((p) => {
      if (!p) return p;
      const mapping = p.mapping.slice();
      mapping[csvIdx] = tableCol || null;
      return { ...p, mapping };
    });
  }

  /** Insert every parsed data row into the target table, mapped columns only,
   *  in atomic chunks via the engine-aware exec batch. Reports progress and, on
   *  failure, how many rows were committed before the error. */
  async function runCsvImport() {
    if (!csvImp) return;
    const { db, table, header, mapping, body, emptyAsNull } = csvImp;
    const cols = mapping
      .map((tc, i) => ({ csvIdx: i, tableCol: tc }))
      .filter((c): c is { csvIdx: number; tableCol: string } => c.tableCol != null);
    if (cols.length === 0) {
      setCsvImp({ ...csvImp, error: "Map at least one column before importing." });
      return;
    }
    if (body.length === 0) {
      setCsvImp({ ...csvImp, error: "The file has no data rows to import." });
      return;
    }
    const qualified = qualifiedTable(db, table);
    const names = cols.map((c) => qid(c.tableCol)).join(", ");
    const ph = cols.map(() => "?").join(", ");
    const sql = `INSERT INTO ${qualified} (${names}) VALUES (${ph})`;
    setCsvImp((p) => (p ? { ...p, running: true, done: false, error: "", inserted: 0 } : p));
    const CHUNK = 200;
    let inserted = 0;
    try {
      for (let start = 0; start < body.length; start += CHUNK) {
        const chunk = body.slice(start, start + CHUNK);
        const statements = chunk.map((r) => ({
          sql,
          values: cols.map((c) => {
            const v = r[c.csvIdx] ?? "";
            return emptyAsNull && v === "" ? null : v;
          }),
        }));
        const res = await api.dbExecBatch(baseParams(), statements);
        inserted += res.length;
        setCsvImp((p) => (p ? { ...p, inserted } : p));
      }
      setCsvImp((p) => (p ? { ...p, running: false, done: true, inserted } : p));
      void header; // header retained only for the mapping UI
      // Refresh the grid if we're looking at the table we just loaded into.
      if (filters && filters.table.db === db && filters.table.table === table) {
        await runBrowse(buildWhere(filters), filters.sort, filters.offset);
      }
    } catch (e) {
      setCsvImp((p) =>
        p ? { ...p, running: false, error: `Imported ${inserted} row(s), then a row failed: ${e}` } : p,
      );
    }
  }

  function startResize(e: ReactPointerEvent) {
    e.preventDefault();
    if (resizingRef.current) return;
    const startX = e.clientX;
    const startW = sidebarWidth;
    const handle = e.currentTarget as HTMLElement;
    resizingRef.current = true;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    document.body.style.cursor = "col-resize";
    const onMove = (ev: PointerEvent) =>
      setSidebarWidth(Math.min(560, Math.max(140, startW + ev.clientX - startX)));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      resizingRef.current = false;
      setResizing(false);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setDatabase(prefill.database ?? "");
      setEngine((prefill.engine as DbEngine) ?? "mysql");
      setFile(prefill.file ?? null);
      setSelectedProfileId(prefill.id);
      setTunnelVia(prefill.via_ssh_profile_id ?? "");
      disconnect();
    } else {
      setManual(dbProfiles.length === 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  function baseParams(): DbParams {
    return (
      connParams ?? { engine, host, port: Number(port), user, password: password || null, file }
    );
  }
  /** localStorage key for this connection's query history (per host:port:user). */
  function histKey(): string {
    const p = baseParams();
    return `${p.host}:${p.port}:${p.user}`;
  }

  async function connect(override?: DbProfile) {
    setLastError("");
    setBusy(true);
    const src = override ?? null;
    const cEngine = (src ? src.engine : engine) as DbEngine;
    const meta = DB_ENGINES[cEngine] ?? DB_ENGINES.mysql;
    const cFile = src ? src.file ?? null : file;
    const cHost = src ? src.host : host;
    const cPort = src ? src.port : Number(port);
    const cUser = src ? src.user : user;
    const cDb = src ? src.database ?? null : database || null;
    const cProfileId = src ? src.id : prefill?.id || null;
    const cPassword = src ? null : password || null;
    // SQLite is a local file — never tunnelled.
    const viaSsh = meta.fileBased
      ? null
      : src
        ? src.via_ssh_profile_id ?? null
        : tunnelVia || null;
    const label = src
      ? src.name || `${src.user}@${src.host}`
      : meta.fileBased
        ? cFile?.split("/").pop() ?? "SQLite"
        : `${user}@${host}`;
    let tid: string | null = null;
    try {
      let h = cHost;
      let p = cPort;

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
        engine: cEngine,
        host: h,
        port: p,
        user: cUser,
        password: cPassword,
        database: cDb,
        file: cFile,
        profile_id: cProfileId,
      };
      const dbs = await api.dbListDatabases({ ...params, database: null });
      setDatabases(dbs.filter(Boolean));
      setEngine(cEngine);
      setFile(cFile);
      setConnParams(params);
      setConnLabel(tid ? `${label} · tunnel` : label);
      setTunnelId(tid);
      setConnected(true);
    } catch (e) {
      // A tunnel that opened but was never recorded in state would leak —
      // stop it here so failed connects don't stack orphaned tunnels.
      if (tid) await api.tunnelStop(tid).catch(() => {});
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

  // Ad-hoc engine switch in the manual launcher. Staying within the SQL family
  // keeps this panel and just retunes the dialect/port; picking a non-SQL engine
  // hands off to App so it can re-route the pane to the Mongo/Redis/S3 panel.
  function pickEngine(e: DbEngine) {
    if (DB_ENGINES[e]?.family === "sql") {
      setEngine(e);
      setPort(String(DB_ENGINES[e].defaultPort));
    } else {
      onEngine?.(e);
    }
  }

  async function browseSqliteFile() {
    const picked = await open({ multiple: false });
    if (typeof picked === "string") setFile(picked);
  }

  async function disconnect() {
    // Roll back any open manual transaction before tearing down the pool.
    if (txRef.current) {
      await api.dbTxRollback(txRef.current).catch(() => {});
      setTxId(null);
    }
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
    setUsers(null);
    // Reset query tabs for the next connection.
    tabSnapshots.current = {};
    tabSeq.current = 2;
    setTabs([{ id: "q1", kind: "query", title: "Query 1" }]);
    setActive("q1");
    setSql("");
    setResult(null);
    setEditTable(null);
    setEdits({});
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

  // ---- Query tabs --------------------------------------------------------
  function setActive(id: string) {
    activeTabRef.current = id;
    setActiveTab(id);
  }
  /** Deliver async results to the tab that requested them: to live state if it's
   *  still active, otherwise into that tab's snapshot (so switching back shows it). */
  function deliverToTab(tabId: string, patch: Partial<TabSnapshot>) {
    if (activeTabRef.current === tabId) {
      if ("result" in patch) setResult(patch.result ?? null);
      if ("ddl" in patch) setDdl(patch.ddl ?? null);
      if ("editTable" in patch) setEditTable(patch.editTable ?? null);
      if ("designer" in patch) setDesigner(patch.designer ?? null);
      if ("users" in patch) setUsers(patch.users ?? null);
      if ("filters" in patch) setFilters(patch.filters ?? null);
      return;
    }
    const snap = tabSnapshots.current[tabId];
    if (snap) tabSnapshots.current[tabId] = { ...snap, ...patch };
  }
  /** Edits including the value currently typed into an open (uncommitted) cell
   *  editor, so switching tabs never silently drops in-progress text. */
  function currentEdits(): Record<string, string | null> {
    if (!editingCell || !cellInputRef.current || !result) return edits;
    const { r, c } = editingCell;
    const orig = result.rows[r]?.[c] ?? null;
    const raw = cellInputRef.current.value;
    const next = { ...edits };
    if (raw === (orig ?? "")) delete next[`${r}:${c}`];
    else next[`${r}:${c}`] = raw;
    return next;
  }
  /** True when a cell editor is open and its text differs from the stored value. */
  function openCellDirty(): boolean {
    if (!editingCell || !cellInputRef.current || !result) return false;
    const orig = result.rows[editingCell.r]?.[editingCell.c] ?? null;
    return cellInputRef.current.value !== (orig ?? "");
  }
  function captureSnapshot(): TabSnapshot {
    return { sql, result, ddl, designer, users, editTable, edits: currentEdits(), activeQuery, filters };
  }
  function applySnapshot(s: TabSnapshot) {
    setSql(s.sql);
    setResult(s.result);
    setDdl(s.ddl);
    setDesigner(s.designer);
    setUsers(s.users);
    setEditTable(s.editTable);
    setFilters(s.filters ?? null);
    setEdits(s.edits);
    setActiveQuery(s.activeQuery);
    setEditingCell(null);
    setError("");
    setGridScroll(0);
    if (gridRef.current) gridRef.current.scrollTop = 0;
  }
  function doSwitchTab(id: string) {
    tabSnapshots.current[activeTab] = captureSnapshot();
    setActive(id);
    applySnapshot(tabSnapshots.current[id] ?? emptyTabSnapshot());
  }
  function switchTab(id: string) {
    if (id === activeTab) return;
    // A cell is open with uncommitted text — confirm before leaving this tab.
    if (openCellDirty() && editingCell && cellInputRef.current) {
      const { r, c } = editingCell;
      const raw = cellInputRef.current.value;
      setAsk({
        title: "Unsaved cell edit",
        label: "You have an unsaved change in this cell. Save it before switching tabs?",
        confirmText: "Save",
        run: () => {
          commitEdit(r, c, raw);
          doSwitchTab(id);
        },
      });
      return;
    }
    doSwitchTab(id);
  }
  function newQueryTab() {
    tabSnapshots.current[activeTab] = captureSnapshot();
    const n = tabs.filter((t) => t.kind === "query").length + 1;
    const id = `q${tabSeq.current++}`;
    tabSnapshots.current[id] = emptyTabSnapshot();
    setTabs((prev) => [...prev, { id, kind: "query", title: `Query ${n}` }]);
    setActive(id);
    applySnapshot(emptyTabSnapshot());
  }
  function closeTab(id: string) {
    if (tabs.length <= 1) return;
    const snap = id === activeTab ? captureSnapshot() : tabSnapshots.current[id];
    const dirty = !!snap && (Object.keys(snap.edits).length > 0 || designerDirty(snap.designer));
    const doClose = () => {
      const idx = tabs.findIndex((t) => t.id === id);
      delete tabSnapshots.current[id];
      const next = tabs.filter((t) => t.id !== id);
      setTabs(next);
      if (id === activeTab) {
        const fb = next[Math.min(idx, next.length - 1)];
        setActive(fb.id);
        applySnapshot(tabSnapshots.current[fb.id] ?? emptyTabSnapshot());
      }
    };
    if (dirty) {
      setAsk({
        title: "Discard unsaved changes?",
        label: "This tab has unsaved changes. Close it and discard them?",
        confirmText: "Discard",
        danger: true,
        run: () => doClose(),
      });
    } else {
      doClose();
    }
  }
  /** Open (or switch to) a data tab for a sidebar object, snapshotting the
   *  current tab first so a query you're writing is never clobbered. */
  function openDataTab(title: string): string {
    tabSnapshots.current[activeTab] = captureSnapshot();
    const existing = tabs.find((t) => t.kind === "data" && t.title === title);
    const id = existing ? existing.id : `d${tabSeq.current++}`;
    if (!existing) {
      tabSnapshots.current[id] = emptyTabSnapshot();
      setTabs((prev) => [...prev, { id, kind: "data", title }]);
    }
    setActive(id);
    applySnapshot(emptyTabSnapshot());
    return id;
  }

  /** Quote a SQL identifier per the active engine's dialect. */
  const qid = (name: string) =>
    isMysql
      ? "`" + name.replace(/`/g, "``") + "`"
      : engine === "mssql"
        ? "[" + name.replace(/]/g, "]]") + "]"
        : '"' + name.replace(/"/g, '""') + '"';

  /** Engine-aware browse query for a table, optionally with a WHERE clause.
   *  MySQL/MSSQL qualify as db.table; Postgres/SQLite reference the table alone
   *  (Postgres via search_path, SQLite is a single-file database). */
  function tableSelectSql(db: string, table: string, where?: string, sort?: SortState | null, offset = 0): string {
    const qualified = isMysql || engine === "mssql" ? `${qid(db)}.${qid(table)}` : qid(table);
    const w = where ? ` WHERE ${where}` : "";
    const o = sort ? ` ORDER BY ${qid(sort.col)} ${sort.dir}` : "";
    const off = offset > 0 ? offset : 0;
    if (engine === "mssql") {
      // OFFSET..FETCH needs an ORDER BY; fall back to a stable no-op ordering.
      if (off > 0 || sort) {
        return `SELECT * FROM ${qualified}${w}${o || " ORDER BY (SELECT NULL)"} OFFSET ${off} ROWS FETCH NEXT ${PAGE_SIZE} ROWS ONLY;`;
      }
      return `SELECT TOP ${PAGE_SIZE} * FROM ${qualified}${w};`;
    }
    return `SELECT * FROM ${qualified}${w}${o} LIMIT ${PAGE_SIZE}${off > 0 ? ` OFFSET ${off}` : ""};`;
  }

  /** Outgoing foreign keys of a table — which local column points at which
   *  (refTable, refColumn). Engine-aware (native introspection on the backend for
   *  every engine). Best-effort: any failure yields no FK links. */
  async function fetchForeignKeys(db: string, table: string): Promise<FkRef[]> {
    try {
      return await api.dbForeignKeys(baseParams(), db, table);
    } catch {
      return [];
    }
  }

  async function openTable(db: string, table: string) {
    const tab = openDataTab(`${db}.${table}`);
    const q = tableSelectSql(db, table);
    setActiveQuery(null);
    setSql(q);
    // Inline editing needs the primary key (WHERE on the PK); engine-aware. No
    // PK (or a failure) leaves the grid read-only. FKs power cell click-through.
    const pkPromise: Promise<string[]> = api
      .dbPrimaryKey(baseParams(), db, table)
      .catch(() => [] as string[]);
    const fkPromise = fetchForeignKeys(db, table);
    await run(q, db, tab, false); // clears editTable; we set it again below for this table
    const gen = runGenRef.current[tab]; // this browse's generation
    const [pk, fks] = await Promise.all([pkPromise, fkPromise]);
    // The pk lookup can lag; if the user ran a different query on this tab while
    // it was in flight, don't re-point editTable/filters at the original table.
    if (runGenRef.current[tab] !== gen) return;
    // Reset the visual filter for the freshly-opened table (closed, one blank row).
    deliverToTab(tab, {
      editTable: { db, table, pk },
      filters: { open: false, nodes: [newCondNode()], applied: 0, table: { db, table, pk }, sort: null, offset: 0, fks },
    });
  }

  /** FK click-through: open the referenced table pre-filtered to `col = value`
   *  (or `col IS NULL`). Mirrors openTable but seeds and applies one condition. */
  async function openTableFiltered(db: string, table: string, col: string, value: string | null) {
    const tab = openDataTab(`${db}.${table}`);
    const cond: FilterCondNode =
      value === null ? { ...newCondNode(col), op: "IS NULL" } : { ...newCondNode(col), op: "=", value };
    const where = condToSql(cond) ?? "";
    const q = tableSelectSql(db, table, where || undefined);
    setActiveQuery(null);
    setSql(q);
    const pkPromise: Promise<string[]> = api.dbPrimaryKey(baseParams(), db, table).catch(() => [] as string[]);
    const fkPromise = fetchForeignKeys(db, table);
    await run(q, db, tab, false);
    const gen = runGenRef.current[tab];
    const [pk, fks] = await Promise.all([pkPromise, fkPromise]);
    if (runGenRef.current[tab] !== gen) return;
    deliverToTab(tab, {
      editTable: { db, table, pk },
      filters: { open: true, nodes: [cond], applied: 1, table: { db, table, pk }, sort: null, offset: 0, fks },
    });
  }

  // ---- Navicat-style data-grid filter --------------------------------------
  /** Single-quote a SQL string literal, escaping embedded quotes. MySQL/MariaDB
   *  also treat backslash as an escape inside string literals (unless the
   *  session sets NO_BACKSLASH_ESCAPES), so double it there too — otherwise a
   *  value like `C:\x` matches wrong and a trailing `\` breaks out of the quote.
   *  Postgres (standard_conforming_strings), SQLite and MSSQL don't escape with
   *  backslash, so doubling it there would corrupt the value. */
  const sqlLit = (v: string) => {
    const body = isMysql ? v.replace(/\\/g, "\\\\").replace(/'/g, "''") : v.replace(/'/g, "''");
    return "'" + body + "'";
  };

  /** Inline a parameterized statement's `?` placeholders with quoted values, so
   *  edit/add/delete statements can be recorded in history as readable SQL.
   *  Our generated DML has `?` only as placeholders (identifiers are qid-quoted). */
  function inlineSql(sql: string, values: (string | null)[]): string {
    let i = 0;
    return sql.replace(/\?/g, () => {
      const v = values[i++];
      return v === null ? "NULL" : sqlLit(v);
    });
  }
  /** Record executed edit/add/delete statements in the query history. */
  function recordExec(statements: { sql: string; values: (string | null)[] }[]) {
    for (const st of statements) pushHistory(histKey(), inlineSql(st.sql, st.values), true);
  }

  /** Render one enabled+complete condition to SQL, or null to skip it. */
  function condToSql(c: FilterCondNode): string | null {
    if (!c.enabled || !c.column) return null;
    const col = qid(c.column);
    if (FILTER_NOVAL.has(c.op)) return `${col} ${c.op}`;
    if (c.op === "IN") {
      const items = c.value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      return items.length ? `${col} IN (${items.map(sqlLit).join(", ")})` : null;
    }
    return `${col} ${c.op} ${sqlLit(c.value)}`;
  }

  /** A node's SQL: a condition clause, or a parenthesised group, or null to skip. */
  function nodeToSql(n: FilterNode): string | null {
    if (!n.enabled) return null;
    if (n.kind === "cond") return condToSql(n);
    const inner = joinNodes(n.children);
    return inner ? `(${inner})` : null;
  }

  /** Join a sibling list into `a AND (b OR c) …`, using each node's connector to
   *  bind it to the next surviving sibling. Empty/disabled nodes drop out. */
  function joinNodes(nodes: FilterNode[]): string {
    const parts: { sql: string; connector: "AND" | "OR" }[] = [];
    for (const n of nodes) {
      const sql = nodeToSql(n);
      if (sql) parts.push({ sql, connector: n.connector });
    }
    if (parts.length === 0) return "";
    let out = parts[0].sql;
    for (let i = 1; i < parts.length; i++) out += ` ${parts[i - 1].connector} ${parts[i].sql}`;
    return out;
  }

  /** WHERE body for the whole filter ("" when nothing applies). */
  function buildWhere(f: FilterState): string {
    return joinNodes(f.nodes);
  }

  /** Count of leaf conditions across the tree that would contribute to the WHERE. */
  function countConds(nodes: FilterNode[]): number {
    let n = 0;
    for (const node of nodes) {
      if (!node.enabled) continue;
      if (node.kind === "cond") {
        if (condToSql(node)) n++;
      } else {
        n += countConds(node.children);
      }
    }
    return n;
  }

  function mutateFilter(fn: (f: FilterState) => FilterState) {
    setFilters((f) => (f ? fn(f) : f));
  }
  function toggleFilterOpen() {
    mutateFilter((f) => ({ ...f, open: !f.open, nodes: f.nodes.length ? f.nodes : [newCondNode()] }));
  }
  function updateCond(id: string, patch: Partial<FilterCondNode>) {
    mutateFilter((f) => ({ ...f, nodes: mapFilterNode(f.nodes, id, (n) => (n.kind === "cond" ? { ...n, ...patch } : n)) }));
  }
  function setNodeConnector(id: string, connector: "AND" | "OR") {
    mutateFilter((f) => ({ ...f, nodes: mapFilterNode(f.nodes, id, (n) => ({ ...n, connector })) }));
  }
  function setNodeEnabled(id: string, enabled: boolean) {
    mutateFilter((f) => ({ ...f, nodes: mapFilterNode(f.nodes, id, (n) => ({ ...n, enabled })) }));
  }
  function addCond(parentId: string | null) {
    const firstCol = result?.columns[0] ?? "";
    mutateFilter((f) => ({ ...f, nodes: addFilterNode(f.nodes, parentId, newCondNode(firstCol)) }));
  }
  function addGroup(parentId: string | null) {
    mutateFilter((f) => ({ ...f, nodes: addFilterNode(f.nodes, parentId, newGroupNode()) }));
  }
  function removeNode(id: string) {
    mutateFilter((f) => {
      const nodes = removeFilterNode(f.nodes, id);
      return { ...f, nodes: nodes.length ? nodes : [newCondNode()] };
    });
  }
  /** Re-run the filter's table browse with an explicit WHERE / sort / offset.
   *  Takes them as params (not from `filters`) so it never reads stale state
   *  between a `mutateFilter` setState and the query build. Uses the filter's
   *  own stored table identity (not `editTable`, which a plain Run may have
   *  cleared) and re-arms the edit context for the returned rows. */
  async function runBrowse(where: string, sort: SortState | null, offset: number) {
    if (!filters) return;
    const { db, table, pk } = filters.table;
    const q = tableSelectSql(db, table, where || undefined, sort, offset);
    setActiveQuery(null);
    setSql(q);
    const tab = activeTabRef.current;
    await run(q, db, tab, false);
    deliverToTab(tab, { editTable: { db, table, pk } });
  }
  /** Rebuild the browse query with the filter's WHERE clause and re-run it.
   *  A new filter always returns to the first page; the current sort is kept. */
  function applyFilter() {
    if (!filters) return;
    const where = buildWhere(filters);
    const count = countConds(filters.nodes);
    const sort = filters.sort;
    // Same unsaved-edit guard the Run button uses, so a filter never silently
    // discards pending cell edits.
    guardLeave(() => {
      mutateFilter((f) => ({ ...f, applied: count, offset: 0 }));
      void runBrowse(where, sort, 0);
    });
  }
  /** Drop every condition and re-run the unfiltered browse query (keeps sort). */
  function clearFilter() {
    if (!filters) return;
    const sort = filters.sort;
    guardLeave(() => {
      mutateFilter((f) => ({ ...f, nodes: [newCondNode()], applied: 0, offset: 0 }));
      void runBrowse("", sort, 0);
    });
  }
  /** Click a column header to cycle its sort: none → ASC → DESC → none. Any sort
   *  change returns to the first page but keeps the applied WHERE. */
  function toggleSort(col: string) {
    if (!filters) return;
    const cur = filters.sort;
    const next: SortState | null =
      !cur || cur.col !== col ? { col, dir: "ASC" } : cur.dir === "ASC" ? { col, dir: "DESC" } : null;
    const where = buildWhere(filters);
    guardLeave(() => {
      mutateFilter((f) => ({ ...f, sort: next, offset: 0 }));
      void runBrowse(where, next, 0);
    });
  }
  /** Step the paging window by whole pages (delta = ±1), keeping filter + sort. */
  function pageBy(delta: number) {
    if (!filters) return;
    const next = Math.max(0, filters.offset + delta * PAGE_SIZE);
    if (next === filters.offset) return;
    const where = buildWhere(filters);
    const sort = filters.sort;
    guardLeave(() => {
      mutateFilter((f) => ({ ...f, offset: next }));
      void runBrowse(where, sort, next);
    });
  }
  /** Recursively render a sibling list of filter nodes (conditions + groups),
   *  with a per-node AND/OR toggle between siblings. */
  function renderFilterNodes(nodes: FilterNode[], parentId: string | null, depth: number) {
    const cols = result?.columns ?? [];
    return (
      <div className="filter-nodes">
        {nodes.map((n, i) => {
          const conn =
            i < nodes.length - 1 ? (
              <button
                className={`fc-conn ${n.connector.toLowerCase()}`}
                onClick={() => setNodeConnector(n.id, n.connector === "AND" ? "OR" : "AND")}
                title="Toggle AND / OR"
              >
                {n.connector === "AND" ? "and" : "or"}
              </button>
            ) : null;
          if (n.kind === "cond") {
            return (
              <div className="filter-row cond" key={n.id}>
                <input
                  type="checkbox"
                  className="fc-en"
                  checked={n.enabled}
                  onChange={(e) => setNodeEnabled(n.id, e.target.checked)}
                  title="Enable this condition"
                />
                <select className="fc-col" value={n.column} onChange={(e) => updateCond(n.id, { column: e.target.value })}>
                  <option value="">column…</option>
                  {n.column && !cols.includes(n.column) && <option value={n.column}>{n.column}</option>}
                  {cols.map((col) => (
                    <option key={col} value={col}>
                      {col}
                    </option>
                  ))}
                </select>
                <select className="fc-op" value={n.op} onChange={(e) => updateCond(n.id, { op: e.target.value })}>
                  {FILTER_OPS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
                {!FILTER_NOVAL.has(n.op) && (
                  <input
                    className="fc-val"
                    value={n.value}
                    placeholder={n.op === "IN" ? "a, b, c" : n.op.includes("LIKE") ? "%pattern%" : "value"}
                    onChange={(e) => updateCond(n.id, { value: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && applyFilter()}
                  />
                )}
                <button className="icon-btn" onClick={() => removeNode(n.id)} title="Remove condition">
                  <Icon name="x" size={12} />
                </button>
                {conn}
              </div>
            );
          }
          return (
            <div className="filter-row group" key={n.id}>
              <div className="fc-group-head">
                <input
                  type="checkbox"
                  className="fc-en"
                  checked={n.enabled}
                  onChange={(e) => setNodeEnabled(n.id, e.target.checked)}
                  title="Enable this group"
                />
                <span className="fc-paren">(</span>
                <span className="grow" />
                <button className="icon-btn" onClick={() => removeNode(n.id)} title="Remove group">
                  <Icon name="x" size={12} />
                </button>
              </div>
              <div className="fc-group-body">{renderFilterNodes(n.children, n.id, depth + 1)}</div>
              <div className="fc-group-foot">
                <span className="fc-paren">)</span>
                {conn}
              </div>
            </div>
          );
        })}
        <div className="filter-add">
          <button className="ghost sm" onClick={() => addCond(parentId)}>
            <Icon name="plus" size={11} /> Condition
          </button>
          <button className="ghost sm" onClick={() => addGroup(parentId)} title="Add a parenthesised ( … ) group">
            <span className="grp-glyph">(&nbsp;)</span> Group
          </button>
        </div>
      </div>
    );
  }

  // ---- Inline data editing -------------------------------------------------
  // Inline edits go through db_exec_batch on a separate pooled connection, which
  // is NOT part of an open manual transaction — so disable them while one is
  // active (the user drives DML through the SQL editor instead).
  const editable = !!editTable && editTable.pk.length > 0 && !txId;
  const editCount = Object.keys(edits).length;

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
      const qualified = isMysql || engine === "mssql" ? `${qid(db)}.${qid(table)}` : qid(table);
      statements.push({
        sql: `UPDATE ${qualified} SET ${setClause} WHERE ${whereParts.join(" AND ")}`,
        values: [...setValues, ...whereValues],
      });
      rowOrder.push({ r, cols });
    }
    setSavingEdits(true);
    setError("");
    try {
      // Atomic: every row must match exactly one row or the whole batch rolls back.
      await api.dbExecBatch(baseParams(), statements);
      recordExec(statements);
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

  /** Engine-aware qualified table name for the current edit target. */
  function qualifiedTable(db: string, table: string): string {
    return isMysql || engine === "mssql" ? `${qid(db)}.${qid(table)}` : qid(table);
  }

  /** Delete one row by its primary key, after a confirm. Removes it locally
   *  (re-indexing pending edits) rather than re-fetching the whole grid. */
  function deleteRow(r: number) {
    if (!editTable || !result) return;
    const { db, table, pk } = editTable;
    if (pk.length === 0) {
      setNotice("This table has no primary key — rows can't be deleted safely.");
      return;
    }
    const pkIdx = pk.map((name) => result.columns.indexOf(name));
    if (pkIdx.some((i) => i < 0)) {
      setNotice("Primary-key columns are missing from the result — cannot delete.");
      return;
    }
    const captured = result;
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
    const stmt = {
      sql: `DELETE FROM ${qualifiedTable(db, table)} WHERE ${whereParts.join(" AND ")}`,
      values: whereValues,
    };
    const desc = pk.map((name, i) => `${name} = ${captured.rows[r][pkIdx[i]] ?? "NULL"}`).join(", ");
    setCellMenu(null);
    setAsk({
      title: "Delete row?",
      label: `Permanently delete the row where ${desc}? This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
      run: async () => {
        setSavingEdits(true);
        setError("");
        try {
          // Parameterized + atomic; backend refuses if it matches ≠ 1 row.
          await api.dbExecBatch(baseParams(), [stmt]);
          recordExec([stmt]);
          setResult((prev) => (prev === captured ? { ...prev, rows: prev.rows.filter((_, i) => i !== r) } : prev));
          setEdits((prev) => {
            const next: Record<string, string | null> = {};
            for (const k of Object.keys(prev)) {
              const [rr, cc] = k.split(":").map(Number);
              if (rr === r) continue; // drop edits on the removed row
              next[`${rr > r ? rr - 1 : rr}:${cc}`] = prev[k]; // shift rows below up one
            }
            return next;
          });
          setEditingCell(null);
          setNotice("Deleted 1 row.");
        } catch (e) {
          setError(String(e));
        } finally {
          setSavingEdits(false);
        }
      },
    });
  }

  /** Clone a row: open the Add-row form pre-filled with its values, leaving the
   *  primary-key columns blank so they auto-increment (or the user sets them). */
  function duplicateRow(r: number) {
    if (!editTable || !result) return;
    const pkSet = new Set(editTable.pk);
    const row: Record<string, string> = {};
    result.columns.forEach((c, i) => {
      if (pkSet.has(c)) return; // leave the pk blank
      const v = result.rows[r][i];
      if (v !== null) row[c] = v; // null → omit (uses the column default)
    });
    setCellMenu(null);
    setNewRow(row);
  }

  /** Insert the add-row form as a new record, then refresh the browse. Blank
   *  fields are omitted so the column default / auto-increment kicks in. */
  async function insertRow() {
    if (!editTable || !result || !newRow) return;
    const { db, table } = editTable;
    const cols = result.columns.filter((c) => (newRow[c] ?? "") !== "");
    const qualified = qualifiedTable(db, table);
    let stmt: { sql: string; values: (string | null)[] };
    if (cols.length === 0) {
      // All-defaults insert — dialect-specific syntax.
      const sql = isMysql ? `INSERT INTO ${qualified} () VALUES ()` : `INSERT INTO ${qualified} DEFAULT VALUES`;
      stmt = { sql, values: [] };
    } else {
      const names = cols.map((c) => qid(c)).join(", ");
      const ph = cols.map(() => "?").join(", ");
      stmt = { sql: `INSERT INTO ${qualified} (${names}) VALUES (${ph})`, values: cols.map((c) => newRow[c]) };
    }
    setSavingEdits(true);
    setError("");
    try {
      await api.dbExecBatch(baseParams(), [stmt]);
      recordExec([stmt]);
      setNewRow(null);
      setNotice("Inserted 1 row.");
      // Refresh from the DB so the new row (with its generated id/defaults) shows.
      // "Open data" tabs re-run through the filter; a hand-written query (no
      // filter panel) re-runs the editor SQL as-is.
      if (filters) await runBrowse(buildWhere(filters), filters.sort, filters.offset);
      else await run();
    } catch (e) {
      setError(String(e)); // keep the dialog open so the user can fix and retry
    } finally {
      setSavingEdits(false);
    }
  }

  /** Serialize the current result grid to the chosen format and write it to a
   *  file the user picks. Exports the loaded rows (up to the row limit). */
  async function exportResult(format: "csv" | "json" | "sql") {
    setExportMenu(false);
    if (!result) return;
    const rows = result.rows;
    let content: string;
    if (format === "csv") {
      const esc = (v: string | null) => (v === null ? "" : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      const head = result.columns.map(esc).join(",");
      const body = rows.map((row) => row.map(esc).join(",")).join("\r\n");
      content = body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
    } else if (format === "json") {
      const objs = rows.map((row) => {
        const o: Record<string, string | null> = {};
        result.columns.forEach((c, i) => (o[c] = row[i]));
        return o;
      });
      content = JSON.stringify(objs, null, 2);
    } else {
      // SQL INSERTs — only meaningful when the grid is a known table.
      if (!editTable) return;
      const cols = result.columns.map((c) => qid(c)).join(", ");
      const qualified = qualifiedTable(editTable.db, editTable.table);
      content =
        rows
          .map((row) => `INSERT INTO ${qualified} (${cols}) VALUES (${row.map((v) => (v === null ? "NULL" : sqlLit(v))).join(", ")});`)
          .join("\n") + (rows.length ? "\n" : "");
    }
    const base = editTable?.table ?? "result";
    const ext = format === "sql" ? "sql" : format;
    const path = await save({
      defaultPath: `${base}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return;
    try {
      await api.writeTextFile(path, content);
      setNotice(`Exported ${rows.length} row(s) to ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setError(String(e));
    }
  }

  function loadQuery(q: SavedQuery) {
    // Open the saved query in its own tab so the current editor isn't clobbered.
    tabSnapshots.current[activeTab] = captureSnapshot();
    const id = `q${tabSeq.current++}`;
    const snap = { ...emptyTabSnapshot(), sql: q.sql, activeQuery: q };
    tabSnapshots.current[id] = snap;
    setTabs((prev) => [...prev, { id, kind: "query", title: q.name }]);
    setActive(id);
    applySnapshot(snap);
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

  function deleteQuery(q: SavedQuery) {
    setAsk({
      title: "Delete saved query",
      label: `Delete "${q.name}"? This can't be undone.`,
      confirmText: "Delete",
      danger: true,
      run: async () => {
        try {
          await api.queryDelete(q.id);
          if (activeQuery?.id === q.id) setActiveQuery(null);
          onQueriesChanged?.();
        } catch (e) {
          setError(String(e));
        }
      },
    });
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

  // ---- User / privilege management -----------------------------------------

  function blankUsersState(): UsersState {
    return {
      list: [], filter: "", selected: null, model: null, origModel: null,
      matrix: null, origMatrix: null, detailTab: "general", isNew: false,
      loadingDetail: false, objDb: selectedDb ?? databases[0] ?? "", objTable: "",
    };
  }

  /** Statements the Users panel would run for the current edits. */
  function userStatements(u: UsersState): string[] {
    if (!u.model) return [];
    const stmts = diffUser(engine, u.isNew ? null : u.origModel, u.model);
    stmts.push(...diffPrivileges(engine, u.model, u.origMatrix ?? {}, u.matrix ?? {}));
    return stmts;
  }
  function usersDirty(): boolean {
    return !!users?.model && userStatements(users).length > 0;
  }

  function openUsers() {
    openDataTab("Users");
    setError("");
    setDesigner(null);
    setUsers(blankUsersState());
    void loadUsers();
  }

  async function loadUsers() {
    try {
      const list = await api.dbListUsers(baseParams());
      setUsers((u) => ({ ...(u ?? blankUsersState()), list }));
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadUserDetail(name: string, host: string) {
    setUsers((u) => (u ? { ...u, selected: { name, host }, loadingDetail: true } : u));
    try {
      const d = await api.dbUserDetail(baseParams(), name, host);
      const { model, matrix } = userFromDetail(engine, d, selectedDb ?? database ?? "");
      setUsers((u) =>
        u
          ? {
              ...u, selected: { name, host }, model, origModel: structuredClone(model),
              matrix, origMatrix: cloneMatrix(matrix), isNew: false, detailTab: "general",
              loadingDetail: false,
            }
          : u,
      );
    } catch (e) {
      setError(String(e));
      setUsers((u) => (u ? { ...u, loadingDetail: false } : u));
    }
  }

  function newUser() {
    setUsers((u) =>
      u
        ? { ...u, selected: null, isNew: true, model: blankUserModel(), origModel: null, matrix: {}, origMatrix: {}, detailTab: "general" }
        : u,
    );
  }

  /** Clone the loaded account into a new one (same attributes + privileges),
   *  clearing the name/password so the user supplies fresh credentials. */
  function duplicateUser() {
    setUsers((u) => {
      if (!u || !u.model) return u;
      const model: UserModel = { ...structuredClone(u.model), name: "", password: "", orig: undefined };
      return {
        ...u, selected: null, isNew: true, model, origModel: null,
        matrix: u.matrix ? cloneMatrix(u.matrix) : {}, origMatrix: {}, detailTab: "general",
      };
    });
  }

  function updateUserModel(patch: Partial<UserModel>) {
    setUsers((u) => (u && u.model ? { ...u, model: { ...u.model, ...patch } } : u));
  }

  function toggleUserPriv(scope: PrivScope, priv: string, on: boolean) {
    setUsers((u) => {
      if (!u || !u.matrix) return u;
      const matrix = cloneMatrix(u.matrix);
      const key = scopeKey(scope);
      const e: MatrixEntry = matrix[key] ?? { scope, privs: new Set<string>(), grantOption: false };
      matrix[key] = e;
      if (priv === "GRANT OPTION") e.grantOption = on;
      else if (on) e.privs.add(priv);
      else e.privs.delete(priv);
      if (e.privs.size === 0 && !e.grantOption) delete matrix[key];
      return { ...u, matrix };
    });
  }

  function toggleUserRole(role: string, on: boolean) {
    setUsers((u) => {
      if (!u || !u.model) return u;
      const roles = on
        ? [...new Set([...u.model.roles, role])]
        : u.model.roles.filter((r) => r !== role);
      return { ...u, model: { ...u.model, roles } };
    });
  }

  async function saveUser() {
    if (!users?.model) return;
    if (!users.model.name.trim()) {
      setNotice("Enter a user name.");
      return;
    }
    const stmts = userStatements(users);
    if (!stmts.length) {
      setNotice("No changes to save.");
      return;
    }
    const { name, host } = users.model;
    const wasNew = users.isNew;
    setBusy(true);
    setError("");
    try {
      await api.dbExecUserSql(baseParams(), stmts);
      setNotice(wasNew ? `Created user ${name}` : `Updated user ${name}`);
      await loadUsers();
      await loadUserDetail(name, host);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function deleteUser(name: string, host: string) {
    setAsk({
      title: "Drop user",
      label: `Permanently drop '${name}'@'${host}'? This cannot be undone.`,
      confirmText: "Drop",
      danger: true,
      run: () => {
        void (async () => {
          setBusy(true);
          setError("");
          try {
            await api.dbExecUserSql(baseParams(), buildDropUser(engine, { ...blankUserModel(), name, host }));
            setNotice(`Dropped user ${name}`);
            setUsers((u) =>
              u ? { ...u, selected: null, model: null, origModel: null, matrix: null, origMatrix: null } : u,
            );
            await loadUsers();
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        })();
      },
    });
  }

  function openNewTable(db: string) {
    openDataTab("New table");
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
    const tab = openDataTab(`${db}.${table}`);
    setError("");
    setSchemaLoading(true);
    try {
      // Engine-aware native introspection on the backend (columns + FKs +
      // indexes), mapped to the designer's state.
      const schema = await api.dbTableSchema(baseParams(), db, table);
      const designer = ddlDesignerFromSchema(db, table, schema);
      deliverToTab(tab, { designer });
      designer.fks.forEach((f) => loadRefCols(db, f.refTable));
    } catch (e) {
      if (activeTabRef.current === tab) setError(String(e));
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
      label: `Permanently drop ${qid(table)}? This cannot be undone.`,
      confirmText: "Drop",
      danger: true,
      run: () => {
        void (async () => {
          setSchemaLoading(true);
          try {
            setError("");
            await api.dbQuery(baseParams(), ddlBuildDropTable(engine, db, table));
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
  /** The DDL statement list the designer will run, per the active engine. New
   *  tables use the dialect CREATE builder; existing-table edits use MySQL's
   *  ALTER shape for MySQL/MariaDB and the dialect ALTER builder (per-attribute
   *  for pg/mssql, table-rebuild for SQLite) elsewhere. */
  function designerStatements(d: DesignerState): string[] {
    if (d.isNew) return ddlBuildCreate(engine, d);
    if (isMysqlFamily(engine)) {
      const alter = buildAlterSql(d);
      return alter ? [alter] : [];
    }
    return ddlBuildAlter(engine, d);
  }
  function designerSql(d: DesignerState): string {
    const stmts = designerStatements(d);
    if (!stmts.length) return "";
    return stmts.map((s) => s.replace(/;\s*$/, "")).join(";\n") + ";";
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
    const stmts = designerStatements(d);
    if (!stmts.length) {
      setNotice("No changes to save.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.dbExecDdl(baseParams(), d.db, stmts);
      await refreshObjects(d.db);
      setDesigner(null);
      setNotice(d.isNew ? `Created table ${d.table}` : `Updated table ${d.table}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /** True when a designer has edits that haven't been saved yet (any tab). */
  function designerDirty(d: DesignerState | null): boolean {
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
  function isDesignerDirty(): boolean {
    return designerDirty(designer);
  }

  /** Run `proceed`, but if the designer, the Users panel, OR the data grid has
   *  unsaved edits, confirm first. */
  function guardLeave(proceed: () => void) {
    const isDirty = isDesignerDirty();
    const userDirty = usersDirty();
    const dataDirty = Object.keys(currentEdits()).length > 0;
    if (!isDirty && !userDirty && !dataDirty) {
      proceed();
      return;
    }
    const label = isDirty
      ? `“${designer?.table.trim() || "the new table"}” has unsaved changes in the designer. Leave and discard them?`
      : userDirty
        ? `You have unsaved changes to user “${users?.model?.name ?? ""}”. Leave and discard them?`
        : `You have ${Object.keys(currentEdits()).length} unsaved cell edit(s). Leave and discard them?`;
    setAsk({
      title: "Discard unsaved changes?",
      label,
      confirmText: "Discard",
      danger: true,
      run: () => proceed(),
    });
  }

  async function run(sqlText?: string, db?: string, targetTab?: string, detectSource = true) {
    const tab = targetTab ?? activeTabRef.current;
    const gen = (runGenRef.current[tab] = (runGenRef.current[tab] ?? 0) + 1);
    setBusy(true);
    setError("");
    setDdl(null);
    setDesigner(null);
    setUsers(null);
    // A fresh query replaces the grid; editing is re-enabled below if the result
    // comes from a single identifiable table.
    setEditTable(null);
    setEdits({});
    setEditingCell(null);
    // A hand-written Run isn't a table browse, so drop any stale filter panel
    // from a previous "Open data" in this tab (its Apply/refresh would target
    // the wrong table). openTable/applyFilter pass detectSource=false and keep it.
    if (detectSource) setFilters(null);
    const ranSql = sqlText ?? sql;
    // Route through the pinned connection while a manual transaction is open, so
    // the statement runs inside it. detectSource stays off in tx mode (the grid
    // is read-only there — see `editable`).
    const inTx = txRef.current != null && isMysql;
    try {
      const res = inTx
        ? await api.dbTxExec(txRef.current!, ranSql, rowLimit > 0 ? rowLimit : null)
        : await api.dbQuery(
            { ...baseParams(), database: db ?? selectedDb ?? (database || null) },
            ranSql,
            rowLimit > 0 ? rowLimit : null,
          );
      deliverToTab(tab, { result: res });
      pushHistory(histKey(), ranSql, true);
      // A hand-written SELECT from one unaliased table stays editable: look up
      // its primary key and, if those columns are in the grid, arm editing —
      // but only if no newer query has since replaced this result.
      if (!inTx && detectSource && res.source_db && res.source_table) {
        const sdb = res.source_db;
        const stbl = res.source_table;
        api
          .dbPrimaryKey(baseParams(), sdb, stbl)
          .then((pk) => {
            if (runGenRef.current[tab] === gen && pk.length > 0 && pk.every((c) => res.columns.includes(c))) {
              deliverToTab(tab, { editTable: { db: sdb, table: stbl, pk } });
            }
          })
          .catch(() => {});
      }
    } catch (e) {
      deliverToTab(tab, { result: null });
      pushHistory(histKey(), ranSql, false);
      if (activeTabRef.current === tab) setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // ---- Manual transactions (MySQL) -----------------------------------------
  /** Open a manual transaction: subsequent Runs execute on one pinned
   *  connection and stay uncommitted until Commit/Rollback. */
  async function beginTx() {
    if (txId || !isMysql) return;
    const id = crypto.randomUUID();
    setTxBusy(true);
    setError("");
    try {
      await api.dbTxBegin({ ...baseParams(), database: selectedDb ?? (database || null) }, id);
      setTxId(id);
      setNotice("Transaction started — changes stay uncommitted until you Commit.");
    } catch (e) {
      setError(String(e));
    } finally {
      setTxBusy(false);
    }
  }

  /** Commit or roll back the open transaction, then refresh a table browse (a
   *  safe SELECT) so the grid shows the final state. A non-browse grid is left
   *  as-is — re-running the editor could re-execute a DML statement. */
  async function finishTx(kind: "commit" | "rollback") {
    const id = txId;
    if (!id) return;
    setTxBusy(true);
    setError("");
    try {
      if (kind === "commit") await api.dbTxCommit(id);
      else await api.dbTxRollback(id);
      setTxId(null);
      setNotice(kind === "commit" ? "Transaction committed." : "Transaction rolled back.");
      if (filters) await runBrowse(buildWhere(filters), filters.sort, filters.offset);
    } catch (e) {
      setError(String(e));
    } finally {
      setTxBusy(false);
    }
  }

  /** Run the editor SQL through EXPLAIN and show the query plan in a modal.
   *  Plain EXPLAIN (no ANALYZE) so a SELECT/UPDATE is planned, never executed. */
  async function explainQuery() {
    const body = sql.trim().replace(/;\s*$/, "");
    if (!body) return;
    const prefix = engine === "sqlite" ? "EXPLAIN QUERY PLAN " : "EXPLAIN ";
    setExplaining(true);
    setError("");
    try {
      const plan = await api.dbQuery(
        { ...baseParams(), database: selectedDb ?? (database || null) },
        prefix + body,
        null,
      );
      setExplain({ sql: body, plan });
    } catch (e) {
      setError(String(e));
    } finally {
      setExplaining(false);
    }
  }

  if (!connected) {
    return (
      <div className="panel">
        <ConnectLauncher
          icon="database"
          title="Connect Database"
          presetLabel="Choose a saved database…"
          presets={dbProfiles
            .filter((d) => DB_ENGINES[d.engine]?.family === "sql")
            .map((d) => ({
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
          <EnginePicker value={engine} onChange={pickEngine} />
          {engine === "sqlite" ? (
            // SQLite is a local single-file database — no host/port/user/tunnel.
            <div className="form-row">
              <input
                placeholder="SQLite file path"
                value={file ?? ""}
                onChange={(e) => setFile(e.target.value || null)}
              />
              <button className="ghost" type="button" onClick={browseSqliteFile}>
                <Icon name="folder" size={13} /> Browse…
              </button>
            </div>
          ) : (
            <>
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
            </>
          )}
          <button onClick={() => connect()} disabled={busy}>
            {busy ? <Spinner size={14} /> : <Icon name="play" size={14} />} {busy ? "Connecting…" : "Connect"}
          </button>
        </ConnectLauncher>
      </div>
    );
  }

  const dbCtx = (): DbToolContext => ({
    params: connParams ?? {
      engine,
      host,
      port: Number(port),
      user,
      password: password || null,
      file,
    },
    database: selectedDb ?? database ?? "",
    engine,
    label: connLabel || (connParams ? `${connParams.user}@${connParams.host}` : engine),
  });

  return (
    <div className="panel">
      <div className="db-split">
        <div className="db-main">
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
              {/* Create-database + .sql import/dump are implemented against MySQL
                  only (backtick quoting, mysqldump-style SHOW FULL TABLES), so
                  hide them on the other SQL engines rather than erroring. */}
              {isMysql && (
                <>
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
                </>
              )}
              {/* User management is server-level; offered on all SQL engines that
                  have accounts (i.e. everything except file-based SQLite). */}
              {DB_ENGINES[engine]?.family === "sql" && !DB_ENGINES[engine]?.fileBased && (
                <button className="ghost" onClick={openUsers} title="Manage users & privileges">
                  <Icon name="user" size={12} /> Users
                </button>
              )}
            </div>
            <div className="schema-search">
              <input
                placeholder="Search databases & objects…"
                value={schemaFilter}
                onChange={(e) => setSchemaFilter(e.target.value)}
              />
              {schemaFilter && (
                <button className="icon" title="Clear search" onClick={() => setSchemaFilter("")}>
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>
            {databases.map((db) => {
              const q = schemaFilter.trim().toLowerCase();
              const filtering = q.length > 0;
              const m = (s: string) => s.toLowerCase().includes(q);
              const objs = objects[db];
              const tables = objs ? (filtering ? objs.tables.filter(m) : objs.tables) : [];
              const views = objs ? (filtering ? objs.views.filter(m) : objs.views) : [];
              const routines = objs ? (filtering ? objs.routines.filter((r) => m(r.name)) : objs.routines) : [];
              const queries = filtering ? queriesFor(db).filter((x) => m(x.name)) : queriesFor(db);
              const itemMatch = tables.length + views.length + routines.length + queries.length > 0;
              // When filtering, hide non-matching databases and force matches open.
              if (filtering && !m(db) && !itemMatch) return null;
              const expanded = openDb === db || (filtering && itemMatch);
              const catShown = (count: number) => !filtering || count > 0;
              const catOpen = (cat: string) => (filtering ? true : openCat.has(`${db}::${cat}`));
              return (
                <div key={db}>
                  <div
                    className={`schema-db${selectedDb === db ? " selected" : ""}`}
                    onClick={() => toggleDb(db)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({ x: e.clientX, y: e.clientY, db, kind: "db" });
                    }}
                  >
                    <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
                    <Icon name="database" size={14} /> {db}
                  </div>
                  {expanded && objs && (
                    <div className="schema-cats">
                      {catShown(tables.length) && catRow(db, "tables", "Tables", "table", tables.length)}
                      {catShown(tables.length) &&
                        catOpen("tables") &&
                        tables.map((t) => (
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

                      {catShown(views.length) && catRow(db, "views", "Views", "eye", views.length)}
                      {catShown(views.length) &&
                        catOpen("views") &&
                        views.map((v) => (
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

                      {catShown(routines.length) && catRow(db, "functions", "Functions", "fx", routines.length)}
                      {catShown(routines.length) &&
                        catOpen("functions") &&
                        routines.map((r) => (
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

                      {catShown(queries.length) && catRow(db, "queries", "Queries", "code", queries.length)}
                      {catShown(queries.length) && catOpen("queries") && (
                        <>
                          {queries.map((qq) => (
                            <div
                              key={`q-${qq.id}`}
                              className={`schema-item${activeQuery?.id === qq.id ? " active" : ""}`}
                              onClick={() => loadQuery(qq)}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                setMenu({ x: e.clientX, y: e.clientY, db, kind: "query", query: qq });
                              }}
                            >
                              <Icon name="code" size={13} /> {qq.name}
                            </div>
                          ))}
                          {!filtering && (
                            <div className="schema-item add" onClick={() => saveCurrentQuery(db)}>
                              <Icon name="plus" size={13} /> Save current query
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div
            className={`db-resizer${resizing ? " dragging" : ""}`}
            onPointerDown={startResize}
            title="Drag to resize"
          />

          <div className="query-area">
            <div className="query-tabs">
              {tabs.map((t) => (
                <div
                  key={t.id}
                  className={`query-tab${t.id === activeTab ? " active" : ""}${t.kind === "data" ? " data" : ""}`}
                  onClick={() => switchTab(t.id)}
                  title={t.title}
                >
                  <Icon name={t.kind === "data" ? "table" : "code"} size={12} />
                  <span className="qt-label">{t.kind === "data" ? t.title.split(".").pop() : t.title}</span>
                  {tabs.length > 1 && (
                    <button
                      className="qt-close"
                      title="Close tab"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      }}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </div>
              ))}
              <button className="qt-add" title="New query tab" onClick={newQueryTab}>
                <Icon name="plus" size={13} />
              </button>
            </div>
            <CodeMirror
              className="sql-editor"
              value={sql}
              height={`${editorHeight}px`}
              theme={dark ? "dark" : "light"}
              extensions={cmExtensions}
              onChange={(val) => setSql(val)}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                autocompletion: true,
                highlightActiveLine: true,
              }}
            />
            <div
              className={`editor-resizer${editorResizing ? " dragging" : ""}`}
              onPointerDown={startEditorResize}
              title="Drag to resize editor"
            />
            <div className="form-row">
              <button onClick={() => guardLeave(() => run())} disabled={busy || savingEdits}>
                {busy ? <Spinner size={14} /> : <Icon name="play" size={14} />} {busy ? "Running…" : "Run"}
              </button>
              <span className="tb-sep" />
              <button className="ghost" onClick={beautify} disabled={!sql.trim()} title="Beautify (format) SQL">
                <Icon name="alignLeft" size={13} /> Beautify
              </button>
              <button className="ghost" onClick={() => setSql(minifySql(sql))} disabled={!sql.trim()} title="Minify SQL">
                <Icon name="minimize" size={13} /> Minify
              </button>
              {engine !== "mssql" && (
                <button
                  className="ghost"
                  onClick={explainQuery}
                  disabled={!sql.trim() || explaining}
                  title="Show the query plan (EXPLAIN)"
                >
                  <Icon name="fx" size={13} /> {explaining ? "Explaining…" : "Explain"}
                </button>
              )}
              <span className="tb-sep" />
              <button
                className="ghost"
                onClick={saveQuery}
                disabled={!sql.trim()}
                title={activeQuery ? `Update saved query "${activeQuery.name}"` : "Save as a new query"}
              >
                <Icon name="save" size={13} /> {activeQuery ? "Save" : "Save…"}
              </button>
              <div className="flyout-wrap">
                <button
                  className="ghost"
                  title="Recently-run queries"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHistoryOpen((v) => {
                      const nx = !v;
                      if (nx) {
                        setHistoryList(loadHistory(histKey()));
                        setHistoryFilter("");
                      }
                      return nx;
                    });
                  }}
                >
                  <Icon name="clock" size={13} /> History
                </button>
                {historyOpen && (
                  <div className="history-flyout" onClick={(e) => e.stopPropagation()}>
                    <div className="history-head">
                      <input
                        className="history-search"
                        placeholder="Search history…"
                        value={historyFilter}
                        onChange={(e) => setHistoryFilter(e.target.value)}
                        autoFocus
                      />
                      {historyList.length > 0 && (
                        <button
                          className="ghost sm"
                          onClick={() => {
                            clearHistory(histKey());
                            setHistoryList([]);
                          }}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <div className="history-list">
                      {(() => {
                        const q = historyFilter.trim().toLowerCase();
                        const items = q ? historyList.filter((h) => h.sql.toLowerCase().includes(q)) : historyList;
                        if (items.length === 0)
                          return (
                            <div className="history-empty">{historyList.length ? "No matches." : "No queries yet."}</div>
                          );
                        return items.map((h, i) => (
                          <button
                            key={i}
                            className={`history-item${h.ok ? "" : " failed"}`}
                            title={h.sql}
                            onClick={() => {
                              setSql(h.sql);
                              setActiveQuery(null);
                              setHistoryOpen(false);
                            }}
                          >
                            <span className="history-sql">{h.sql}</span>
                          </button>
                        ));
                      })()}
                    </div>
                  </div>
                )}
              </div>
              {isMysql && (
                <>
                  <span className="tb-sep" />
                  {txId ? (
                    <span className="tx-controls" title="A manual transaction is open">
                      <span className="tx-pill">● Tx</span>
                      <button
                        className="ghost sm"
                        onClick={() => finishTx("commit")}
                        disabled={txBusy || busy}
                        title="Commit — save all changes made since Begin Tx"
                      >
                        <Icon name="save" size={12} /> Commit
                      </button>
                      <button
                        className="ghost sm tx-rollback"
                        onClick={() => finishTx("rollback")}
                        disabled={txBusy || busy}
                        title="Rollback — discard all changes made since Begin Tx"
                      >
                        <Icon name="back" size={12} /> Rollback
                      </button>
                    </span>
                  ) : (
                    <button
                      className="ghost"
                      onClick={beginTx}
                      disabled={txBusy || busy}
                      title="Begin a manual transaction — Runs stay uncommitted until you Commit"
                    >
                      <Icon name="lock" size={13} /> Begin Tx
                    </button>
                  )}
                </>
              )}
              {result && <span className="tb-sep" />}
              {filters && (
                <button
                  className={`ghost${filters.open ? " active" : ""}`}
                  onClick={toggleFilterOpen}
                  title="Filter this table's rows"
                >
                  <Icon name="filter" size={13} /> Filter
                  {filters.applied > 0 && <span className="filter-badge">{filters.applied}</span>}
                </button>
              )}
              {editable && editTable && (
                <button
                  className="ghost"
                  onClick={() => setNewRow({})}
                  disabled={savingEdits}
                  title={`Insert a new row into ${editTable.table}`}
                >
                  <Icon name="plus" size={13} /> Add row
                </button>
              )}
              {result && (
                <div className="flyout-wrap">
                  <button
                    className="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExportMenu((v) => !v);
                    }}
                    title="Export the loaded rows to a file"
                  >
                    <Icon name="download" size={13} /> Export
                  </button>
                  {exportMenu && (
                    <ul className="ctx-menu flyout-menu" onClick={(e) => e.stopPropagation()}>
                      <li onClick={() => exportResult("csv")}>CSV</li>
                      <li onClick={() => exportResult("json")}>JSON</li>
                      {editTable && <li onClick={() => exportResult("sql")}>SQL INSERTs</li>}
                    </ul>
                  )}
                </div>
              )}
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
                  {editTable &&
                    (editable
                      ? " · double-click a cell to edit"
                      : txId
                        ? " · read-only during transaction"
                        : " · read-only (no primary key)")}
                </span>
              )}
              {filters && result && (
                <span className="pager" title="Browse pages (server-side)">
                  <button
                    className="icon-btn"
                    onClick={() => pageBy(-1)}
                    disabled={busy || filters.offset === 0}
                    title="Previous page"
                  >
                    <Icon name="chevronLeft" size={13} />
                  </button>
                  <span className="pager-label">
                    {filters.offset + 1}–{filters.offset + result.rows.length}
                  </span>
                  <button
                    className="icon-btn"
                    onClick={() => pageBy(1)}
                    disabled={busy || result.rows.length < PAGE_SIZE}
                    title="Next page"
                  >
                    <Icon name="chevronRight" size={13} />
                  </button>
                </span>
              )}
            </div>
            {filters?.open && (
              <div
                className="filter-bar"
                ref={filterBarRef}
                style={filterHeight != null ? { height: `${filterHeight}px` } : undefined}
              >
                <div className="filter-head">
                  <span className="filter-title">
                    <Icon name="filter" size={12} /> Filter
                  </span>
                  <span className="filter-hint">click and / or to switch · ( ) groups nest</span>
                  <span className="spacer" />
                  <button className="ghost sm" onClick={clearFilter} disabled={busy} title="Remove all conditions and reload">
                    Clear
                  </button>
                  <button className="primary sm" onClick={applyFilter} disabled={busy} title="Apply filter and reload rows">
                    Apply
                  </button>
                  <button className="icon-btn" onClick={toggleFilterOpen} title="Hide filter">
                    <Icon name="x" size={13} />
                  </button>
                </div>
                <div className="filter-body">{renderFilterNodes(filters.nodes, null, 0)}</div>
              </div>
            )}
            {filters?.open && (
              <div
                className={`filter-resizer${filterResizing ? " dragging" : ""}`}
                onPointerDown={startFilterResize}
                title="Drag to resize the filter panel"
              />
            )}
            {result?.truncated && (
              <div className="trunc-note">
                <Icon name="minimize" size={12} /> Showing the first {rowLimit.toLocaleString()} rows. Raise “Limit”
                (or add a <code>WHERE</code>/<code>LIMIT</code>) to fetch more.
              </div>
            )}
            {users && (
              <div className="users">
                <div className="users-list">
                  <div className="users-toolbar">
                    <button className="ghost" onClick={newUser} title="New user / role">
                      <Icon name="plus" size={12} /> New
                    </button>
                    <button className="ghost" onClick={() => void loadUsers()} title="Refresh">
                      <Icon name="refresh" size={12} />
                    </button>
                  </div>
                  <input
                    className="users-filter"
                    placeholder="Filter users…"
                    value={users.filter}
                    onChange={(e) => setUsers((u) => (u ? { ...u, filter: e.target.value } : u))}
                  />
                  <div className="users-rows">
                    {users.list
                      .filter((u) => `${u.name}@${u.host}`.toLowerCase().includes(users.filter.toLowerCase()))
                      .map((u) => {
                        const sel = users.selected?.name === u.name && users.selected?.host === u.host;
                        return (
                          <div
                            key={`${u.name}@${u.host}`}
                            className={`users-row${sel ? " sel" : ""}`}
                            onClick={() => void loadUserDetail(u.name, u.host)}
                          >
                            <Icon name={u.isRole ? "key" : "user"} size={13} />
                            <span className="users-name">
                              {u.name}
                              {u.host ? <span className="users-host">@{u.host}</span> : null}
                            </span>
                            {u.locked && <Icon name="lock" size={11} />}
                            <button
                              className="icon users-del"
                              title="Drop user"
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteUser(u.name, u.host);
                              }}
                            >
                              <Icon name="trash" size={12} />
                            </button>
                          </div>
                        );
                      })}
                    {users.list.length === 0 && <div className="users-empty">No accounts.</div>}
                  </div>
                </div>
                <div className="users-detail">
                  {!users.model && <div className="users-hint">Select a user on the left, or click New.</div>}
                  {users.model &&
                    (() => {
                      const m = users.model;
                      const tab = users.detailTab;
                      const setTab = (t: UsersState["detailTab"]) => {
                        setUsers((u) => (u ? { ...u, detailTab: t } : u));
                        if (t === "objects" && users.objDb && !objects[users.objDb]) void refreshObjects(users.objDb);
                      };
                      const objScope: PrivScope = users.objTable
                        ? { kind: "table", db: users.objDb, table: users.objTable }
                        : { kind: "database", db: users.objDb };
                      const objPrivList = users.objTable ? tablePrivs(engine) : dbPrivs(engine);
                      const num = (v: string) => Math.max(0, parseInt(v || "0", 10) || 0);
                      return (
                        <>
                          <div className="users-detail-head">
                            <Icon name={m.isRole ? "key" : "user"} size={14} />
                            <span className="users-detail-title">
                              {users.isNew ? "New user" : `${m.name}@${m.host}`}
                            </span>
                          </div>
                          <div className="users-tabs">
                            {(["general", "global", "objects", "roles", "sql"] as const).map((t) => (
                              <button key={t} className={`users-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
                                {{ general: "General", global: "Global Privileges", objects: "Object Privileges", roles: "Roles", sql: "SQL Preview" }[t]}
                              </button>
                            ))}
                          </div>
                          <div className="users-tabbody">
                            {tab === "general" && (
                              <div className="users-general">
                                <label>User name
                                  <input value={m.name} disabled={!users.isNew}
                                    onChange={(e) => updateUserModel({ name: e.target.value })} />
                                </label>
                                {isMysqlFamily(engine) && (
                                  <label>Host
                                    <input value={m.host} disabled={!users.isNew}
                                      onChange={(e) => updateUserModel({ host: e.target.value })} />
                                  </label>
                                )}
                                <label>Password
                                  <input type="password" value={m.password} placeholder={users.isNew ? "" : "(unchanged)"}
                                    onChange={(e) => updateUserModel({ password: e.target.value })} />
                                </label>
                                {isMysqlFamily(engine) && (
                                  <>
                                    <label>Require SSL
                                      <select value={m.requireSsl} onChange={(e) => updateUserModel({ requireSsl: e.target.value })}>
                                        <option value="">None</option>
                                        <option value="SSL">SSL</option>
                                        <option value="X509">X509</option>
                                      </select>
                                    </label>
                                    <label>Max queries/hour
                                      <input value={m.maxQueriesPerHour || ""} onChange={(e) => updateUserModel({ maxQueriesPerHour: num(e.target.value) })} />
                                    </label>
                                    <label>Max updates/hour
                                      <input value={m.maxUpdatesPerHour || ""} onChange={(e) => updateUserModel({ maxUpdatesPerHour: num(e.target.value) })} />
                                    </label>
                                    <label>Max connections/hour
                                      <input value={m.maxConnectionsPerHour || ""} onChange={(e) => updateUserModel({ maxConnectionsPerHour: num(e.target.value) })} />
                                    </label>
                                    <label>Max user connections
                                      <input value={m.maxUserConnections || ""} onChange={(e) => updateUserModel({ maxUserConnections: num(e.target.value) })} />
                                    </label>
                                    <label className="chk"><input type="checkbox" checked={m.accountLocked} onChange={(e) => updateUserModel({ accountLocked: e.target.checked })} /> Account locked</label>
                                    <label className="chk"><input type="checkbox" checked={m.passwordExpired} onChange={(e) => updateUserModel({ passwordExpired: e.target.checked })} /> Expire password now</label>
                                  </>
                                )}
                                {engine === "postgres" && (
                                  <>
                                    <label>Connection limit
                                      <input value={m.maxUserConnections || ""} onChange={(e) => updateUserModel({ maxUserConnections: num(e.target.value) })} />
                                    </label>
                                    <label>Valid until
                                      <input value={m.validUntil ?? ""} placeholder="YYYY-MM-DD HH:MM:SS+00" onChange={(e) => updateUserModel({ validUntil: e.target.value || null })} />
                                    </label>
                                    <label className="chk"><input type="checkbox" checked={m.canLogin} onChange={(e) => updateUserModel({ canLogin: e.target.checked })} /> Can log in</label>
                                    <label className="chk"><input type="checkbox" checked={m.isSuperuser} onChange={(e) => updateUserModel({ isSuperuser: e.target.checked })} /> Superuser</label>
                                    <label className="chk"><input type="checkbox" checked={m.canCreateDb} onChange={(e) => updateUserModel({ canCreateDb: e.target.checked })} /> Create databases</label>
                                    <label className="chk"><input type="checkbox" checked={m.canCreateRole} onChange={(e) => updateUserModel({ canCreateRole: e.target.checked })} /> Create roles</label>
                                  </>
                                )}
                                {engine === "mssql" && (
                                  <label className="chk"><input type="checkbox" checked={m.accountLocked} onChange={(e) => updateUserModel({ accountLocked: e.target.checked })} /> Login disabled</label>
                                )}
                              </div>
                            )}
                            {tab === "global" && (
                              <div className="priv-grid">
                                {globalPrivs(engine).map((p) => {
                                  const e = users.matrix?.[scopeKey({ kind: "global" })];
                                  const checked = p === "GRANT OPTION" ? !!e?.grantOption : !!e?.privs.has(p);
                                  return (
                                    <label key={p} className="priv-item">
                                      <input type="checkbox" checked={checked} onChange={(ev) => toggleUserPriv({ kind: "global" }, p, ev.target.checked)} />
                                      <span>{p}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                            {tab === "objects" && (
                              <div className="users-objects">
                                <div className="users-obj-pickers">
                                  <label>Database
                                    <select value={users.objDb} onChange={(e) => { const db = e.target.value; setUsers((u) => (u ? { ...u, objDb: db, objTable: "" } : u)); if (db && !objects[db]) void refreshObjects(db); }}>
                                      {databases.map((d) => <option key={d} value={d}>{d}</option>)}
                                    </select>
                                  </label>
                                  <label>Object
                                    <select value={users.objTable} onChange={(e) => setUsers((u) => (u ? { ...u, objTable: e.target.value } : u))}>
                                      <option value="">(entire database)</option>
                                      {(objects[users.objDb]?.tables ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                  </label>
                                </div>
                                <div className="priv-grid">
                                  {objPrivList.map((p) => {
                                    const e = users.matrix?.[scopeKey(objScope)];
                                    const checked = p === "GRANT OPTION" ? !!e?.grantOption : !!e?.privs.has(p);
                                    return (
                                      <label key={p} className="priv-item">
                                        <input type="checkbox" checked={checked} onChange={(ev) => toggleUserPriv(objScope, p, ev.target.checked)} />
                                        <span>{p}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {tab === "roles" && (
                              <div className="priv-grid">
                                {users.list.filter((u) => u.isRole).map((r) => (
                                  <label key={`${r.name}@${r.host}`} className="priv-item">
                                    <input type="checkbox" checked={m.roles.includes(r.name)} onChange={(e) => toggleUserRole(r.name, e.target.checked)} />
                                    <span>{r.name}</span>
                                  </label>
                                ))}
                                {users.list.filter((u) => u.isRole).length === 0 && <div className="users-hint">No roles defined.</div>}
                              </div>
                            )}
                            {tab === "sql" && (
                              <textarea className="users-sql" readOnly value={userSql(userStatements(users)) || "-- no changes"} />
                            )}
                          </div>
                          <div className="form-row users-actions">
                            <button className="primary" onClick={() => void saveUser()} disabled={busy}>Save</button>
                            {!users.isNew && (
                              <>
                                <button className="ghost" onClick={duplicateUser}>Duplicate</button>
                                <button className="ghost danger" onClick={() => deleteUser(m.name, m.host)}>Delete</button>
                              </>
                            )}
                          </div>
                        </>
                      );
                    })()}
                </div>
              </div>
            )}
            {!users && designer && (
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
            {!users && !designer && ddl !== null && (
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
            {!users && !designer && ddl === null && result && editTable && editCount > 0 && (
              <div className="edit-bar">
                <span>
                  {editCount} cell{editCount > 1 ? "s" : ""} changed
                </span>
                <div className="edit-bar-actions">
                  <button className="primary" onClick={() => saveEdits()} disabled={savingEdits}>
                    <Icon name="save" size={13} /> {savingEdits ? "Saving…" : "Save changes"}
                  </button>
                  <button
                    className="ghost"
                    disabled={savingEdits}
                    onClick={() =>
                      setAsk({
                        title: "Discard changes",
                        label: `Discard ${editCount} unsaved cell change${editCount === 1 ? "" : "s"}?`,
                        confirmText: "Discard",
                        danger: true,
                        run: discardEdits,
                      })
                    }
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}
            {/* A non-SELECT (UPDATE/INSERT/DELETE/DDL) has no columns, so the
                grid below would render as an empty box — indistinguishable from
                "nothing happened". Report the outcome instead. */}
            {!users && !designer && ddl === null && result && result.columns.length === 0 && (
              <div className="result-ok">
                <Icon name="check" size={18} />
                <div>
                  <div className="result-ok-title">Query OK</div>
                  <div className="muted">
                    {result.rows_affected.toLocaleString()} row
                    {result.rows_affected === 1 ? "" : "s"} affected · {result.elapsed_ms} ms
                    {txId ? " · in transaction (not committed yet)" : ""}
                  </div>
                </div>
              </div>
            )}
            {!users && !designer && ddl === null && result && result.columns.length > 0 && (
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
                          {result.columns.map((c, i) => {
                            // Click-to-sort is only safe on table-data browses,
                            // where the panel controls the SQL (filters set).
                            const sortable = !!filters;
                            const dir = filters?.sort?.col === c ? filters.sort.dir : null;
                            return (
                              <th
                                key={i}
                                className={sortable ? "sortable" : undefined}
                                onClick={sortable ? () => toggleSort(c) : undefined}
                                title={sortable ? "Click to sort" : undefined}
                              >
                                {c}
                                {dir && <span className="sort-arrow">{dir === "ASC" ? " ▲" : " ▼"}</span>}
                              </th>
                            );
                          })}
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
                                // FK click-through: is this column a foreign key?
                                const fk = filters?.fks.find((f) => f.column === result.columns[ci]);
                                if (editingCell && editingCell.r === rIdx && editingCell.c === ci) {
                                  return (
                                    <td key={ci} className="editing">
                                      <input
                                        key={k}
                                        ref={cellInputRef}
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
                                    {val === null ? <em className="null">NULL</em> : maskText(val)}
                                    {fk && val !== null && filters && (
                                      <button
                                        className="fk-jump"
                                        title={`Open ${fk.refTable} where ${fk.refColumn} = this value`}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          openTableFiltered(filters.table.db, fk.refTable, fk.refColumn, val);
                                        }}
                                      >
                                        <Icon name="chevronRight" size={11} />
                                      </button>
                                    )}
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
            <li onClick={() => { const db = menu.db; setMenu(null); openNewTable(db); }}>
              <Icon name="plus" size={13} /> New table
            </li>
          )}
          {menu.kind === "db" && (
            <>
              {isMysql && (
                <>
                  <li onClick={() => { exportSql(menu.db); setMenu(null); }}>
                    <Icon name="download" size={13} /> Export SQL (database)
                  </li>
                  <li onClick={() => { importSql(menu.db); setMenu(null); }}>
                    <Icon name="upload" size={13} /> Import SQL (into this db)
                  </li>
                </>
              )}
              <li onClick={() => { copyText(`\`${menu.db}\``); setMenu(null); }}>
                <Icon name="copy" size={13} /> Copy name
              </li>
            </>
          )}
          {(menu.kind === "table" || menu.kind === "view") && (
            <>
              <li onClick={() => { const db = menu.db, n = menu.name!; setMenu(null); openTable(db, n); }}>
                <Icon name="table" size={13} /> Open data
              </li>
              <li onClick={() => { const db = menu.db, n = menu.name!; setMenu(null); showDdl(db, n); }}>
                <Icon name="code" size={13} /> Show DDL
              </li>
              {menu.kind === "table" && (
                <>
                  <li onClick={() => { const db = menu.db, n = menu.name!; setMenu(null); designTable(db, n); }}>
                    <Icon name="edit" size={13} /> Design table
                  </li>
                  {isMysql && (
                    <li onClick={() => { exportSql(menu.db, menu.name); setMenu(null); }}>
                      <Icon name="download" size={13} /> Export SQL
                    </li>
                  )}
                  <li onClick={() => { const db = menu.db, n = menu.name!; setMenu(null); void importCsv(db, n); }}>
                    <Icon name="upload" size={13} /> Import CSV…
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
              <li onClick={() => { const db = menu.db, n = menu.name!, k = menu.routineKind; setMenu(null); showDdl(db, n, "routine", k); }}>
                <Icon name="code" size={13} /> Show DDL
              </li>
              <li onClick={() => { copyText(`\`${menu.db}\`.\`${menu.name}\``); setMenu(null); }}>
                <Icon name="copy" size={13} /> Copy name
              </li>
            </>
          )}
          {menu.kind === "query" && menu.query && (
            <>
              <li onClick={() => { const q = menu.query!; setMenu(null); loadQuery(q); }}>
                <Icon name="code" size={13} /> Load into editor
              </li>
              <li onClick={() => { const q = menu.query!, db = menu.db; setMenu(null); loadQuery(q); run(q.sql, db); }}>
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
          <li onClick={() => duplicateRow(cellMenu.r)}>
            <Icon name="copy" size={13} /> Duplicate row
          </li>
          <li className="danger" onClick={() => deleteRow(cellMenu.r)}>
            <Icon name="trash" size={13} /> Delete row
          </li>
        </ul>
      )}

      {newRow && editTable && result && (
        <div className="pane-overlay">
          <div className="modal export-modal addrow-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Add row → {editTable.table}</h3>
            <p className="ask-label">
              Leave a field blank to use its default (auto-increment, NULL, or column default).
            </p>
            <div className="addrow-fields">
              {result.columns.map((col) => (
                <label className="addrow-field" key={col}>
                  <span className="addrow-col mono">{col}</span>
                  <input
                    value={newRow[col] ?? ""}
                    placeholder="(default)"
                    onChange={(e) => setNewRow((p) => (p ? { ...p, [col]: e.target.value } : p))}
                    onKeyDown={(e) => e.key === "Enter" && insertRow()}
                  />
                </label>
              ))}
            </div>
            <div className="form-row end">
              <button className="ghost" onClick={() => setNewRow(null)} disabled={savingEdits}>
                Cancel
              </button>
              <button onClick={insertRow} disabled={savingEdits}>
                <Icon name="plus" size={13} /> {savingEdits ? "Inserting…" : "Insert row"}
              </button>
            </div>
          </div>
        </div>
      )}

      {explain && (
        <div className="pane-overlay" onClick={() => setExplain(null)}>
          <div className="modal explain-modal" onClick={(e) => e.stopPropagation()}>
            <div className="explain-head">
              <h3>
                <Icon name="fx" size={15} /> Query plan
              </h3>
              <button className="icon" onClick={() => setExplain(null)} title="Close">
                <Icon name="x" size={16} />
              </button>
            </div>
            <pre className="explain-sql">{explain.sql}</pre>
            <div className="explain-grid-wrap">
              <table className="grid">
                <thead>
                  <tr>
                    {explain.plan.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {explain.plan.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((v, ci) => (
                        <td key={ci}>{v === null ? <em className="null">NULL</em> : v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="form-row end">
              <button onClick={() => setExplain(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}

      {expSetup && (
        <div className="pane-overlay">
          <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Export SQL — {expSetup.table ?? expSetup.db}</h3>
            <div className="seg solid">
              <button
                className={expSetup.dest === "local" ? "on" : ""}
                onClick={() => setExpSetup((p) => (p ? { ...p, dest: "local" } : p))}
              >
                <Icon name="save" size={14} /> Local file
              </button>
              <button
                className={expSetup.dest === "s3" ? "on" : ""}
                onClick={() =>
                  setExpSetup((p) =>
                    p ? { ...p, dest: "s3", s3ProfileId: p.s3ProfileId || s3Profiles[0]?.id || "" } : p,
                  )
                }
              >
                <Icon name="bucket" size={14} /> S3 bucket
              </button>
            </div>
            {expSetup.dest === "local" && (
              <p className="ask-label">Save the dump as a .sql file — you pick the location next.</p>
            )}
            {expSetup.dest === "s3" &&
              (s3Profiles.length === 0 ? (
                <p className="ask-label">
                  No S3 connections saved — add an Object Storage (S3) connection first.
                </p>
              ) : (
                <>
                  <label>
                    S3 connection
                    <select
                      value={expSetup.s3ProfileId}
                      onChange={(e) => setExpSetup((p) => (p ? { ...p, s3ProfileId: e.target.value } : p))}
                    >
                      {s3Profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name || `${p.user}@${p.host}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Bucket
                    <input
                      placeholder="bucket"
                      value={expSetup.s3Bucket}
                      onChange={(e) => setExpSetup((p) => (p ? { ...p, s3Bucket: e.target.value } : p))}
                    />
                  </label>
                  <label>
                    Key
                    <input
                      placeholder="dumps/backup.sql"
                      value={expSetup.s3Key}
                      onChange={(e) => setExpSetup((p) => (p ? { ...p, s3Key: e.target.value } : p))}
                    />
                  </label>
                </>
              ))}
            <div className="form-row end">
              <button className="ghost" onClick={() => setExpSetup(null)}>
                Cancel
              </button>
              <button onClick={runExport} disabled={!exportReady(expSetup)}>
                {expSetup.dest === "local" ? "Choose file…" : "Export"}
              </button>
            </div>
          </div>
        </div>
      )}

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
                <div className={"pbar" + (exp.total ? "" : " indet")}>
                  <div
                    className="pfill"
                    style={
                      exp.total ? { width: `${Math.min(100, (exp.written / exp.total) * 100)}%` } : undefined
                    }
                  />
                </div>
              </>
            )}
            {exp.log.length > 0 && (
              <div className="export-log" ref={expLog.ref} onScroll={expLog.onScroll}>
                {exp.log.map((l) => (
                  <div key={l.name}>
                    <Icon name="table" size={12} /> {l.name} — {l.rows.toLocaleString()} rows
                  </div>
                ))}
              </div>
            )}
            {/* An S3-destination dump uploads after writing — that phase runs
                through the transfer queue, surfaced here because the S3/SFTP
                panels' lists aren't visible from this modal. */}
            <TransferList />
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
                <div className="export-row">
                  <span>Encoding</span>
                  <select
                    className="opt-select"
                    value={imp.encoding}
                    onChange={(e) => setImp((p) => (p ? { ...p, encoding: e.target.value } : p))}
                  >
                    <option value="utf-8">utf-8</option>
                    <option value="windows-1252">latin1 (windows-1252)</option>
                    <option value="iso-8859-1">iso-8859-1</option>
                    <option value="utf-16le">utf-16le</option>
                    <option value="gbk">gbk</option>
                    <option value="big5">big5</option>
                    <option value="shift_jis">shift_jis</option>
                    <option value="euc-kr">euc-kr</option>
                  </select>
                </div>
                {!imp.title && <p className="ask-label">No target database — statements run as-is.</p>}
                <div className="opt-checks">
                  {imp.title && (
                    <label className="opt-check">
                      <input
                        type="checkbox"
                        checked={imp.dropTables}
                        onChange={(e) => setImp((p) => (p ? { ...p, dropTables: e.target.checked } : p))}
                      />
                      <span>
                        Drop all tables in <span className="mono">{imp.title}</span> first
                        <small> — clean-slate import (irreversible)</small>
                      </span>
                    </label>
                  )}
                  <label className="opt-check">
                    <input
                      type="checkbox"
                      checked={imp.continueOnError}
                      onChange={(e) => setImp((p) => (p ? { ...p, continueOnError: e.target.checked } : p))}
                    />
                    <span>Continue on error (skip failed statements)</span>
                  </label>
                  <label className="opt-check">
                    <input
                      type="checkbox"
                      checked={imp.autocommitOff}
                      onChange={(e) => setImp((p) => (p ? { ...p, autocommitOff: e.target.checked } : p))}
                    />
                    <span>
                      SET AUTOCOMMIT=0
                      <small> — one transaction: faster, all-or-nothing rollback</small>
                    </span>
                  </label>
                  <label className={"opt-check" + (imp.continueOnError ? " disabled" : "")}>
                    <input
                      type="checkbox"
                      checked={imp.multiQuery && !imp.continueOnError}
                      disabled={imp.continueOnError}
                      onChange={(e) => setImp((p) => (p ? { ...p, multiQuery: e.target.checked } : p))}
                    />
                    <span>
                      Run multiple queries in each execution
                      <small>
                        {imp.continueOnError
                          ? " — off while Continue on error is on (runs one at a time)"
                          : " — batches statements per round-trip"}
                      </small>
                    </span>
                  </label>
                </div>
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
                  {/* The statement count isn't known until the whole file has
                      been read, decoded and split — seconds on a big dump. Say
                      so, rather than showing a motionless "0 ok / …". */}
                  {!imp.total && !imp.done ? (
                    <span className="spin-inline">
                      <Spinner size={12} />
                      Preparing…
                    </span>
                  ) : (
                    <span>
                      {imp.executed.toLocaleString()} ok
                      {imp.failed ? ` · ${imp.failed.toLocaleString()} failed` : ""} /{" "}
                      {imp.total ? imp.total.toLocaleString() : "…"}
                      {imp.paused ? " · paused" : ""}
                    </span>
                  )}
                </div>
                <div className={"pbar" + (!imp.total && !imp.done ? " indet" : "")}>
                  <div
                    className="pfill"
                    style={
                      imp.total
                        ? { width: `${Math.min(100, ((imp.executed + imp.failed) / imp.total) * 100)}%` }
                        : undefined
                    }
                  />
                </div>
                {!imp.total && !imp.done && (
                  <div className="muted">Reading the file and splitting it into statements…</div>
                )}
                {imp.error && <pre className="error">{imp.error}</pre>}
                {imp.errors.length > 0 && (
                  <div className="export-log" ref={impLog.ref} onScroll={impLog.onScroll}>
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

      {csvImp && (
        <div className="pane-overlay" onClick={() => !csvImp.running && setCsvImp(null)}>
          <div className="modal export-modal addrow-modal csv-import" onClick={(e) => e.stopPropagation()}>
            <h3>
              <Icon name="upload" size={15} /> Import CSV → {csvImp.table}
            </h3>
            <div className="csv-file">
              <span className="mono">{csvImp.filename}</span>
              <span className="muted">
                {csvImp.rowCount.toLocaleString()} data row{csvImp.rowCount === 1 ? "" : "s"} ·{" "}
                {csvImp.header.length} column{csvImp.header.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="csv-opts">
              <label>
                Delimiter
                <select
                  className="opt-select"
                  value={csvImp.delimiter}
                  disabled={csvImp.running}
                  onChange={(e) => reconfigureCsv({ delimiter: e.target.value })}
                >
                  <option value=",">Comma ,</option>
                  <option value=";">Semicolon ;</option>
                  <option value={"\t"}>Tab</option>
                </select>
              </label>
              <label className="opt-check">
                <input
                  type="checkbox"
                  checked={csvImp.hasHeader}
                  disabled={csvImp.running}
                  onChange={(e) => reconfigureCsv({ hasHeader: e.target.checked })}
                />
                <span>First row is a header</span>
              </label>
              <label className="opt-check">
                <input
                  type="checkbox"
                  checked={csvImp.emptyAsNull}
                  disabled={csvImp.running}
                  onChange={(e) => reconfigureCsv({ emptyAsNull: e.target.checked })}
                />
                <span>
                  Empty cells → NULL
                  <small> — otherwise inserted as an empty string</small>
                </span>
              </label>
            </div>

            <div className="csv-map-head">Column mapping</div>
            <div className="csv-map-grid">
              {csvImp.header.map((h, i) => (
                <div className="csv-map-row" key={i}>
                  <span className="csv-src" title={h || `col${i + 1}`}>
                    {h || `col${i + 1}`}
                  </span>
                  <span className="fk-arrow">→</span>
                  <select
                    className="opt-select"
                    value={csvImp.mapping[i] ?? ""}
                    disabled={csvImp.running}
                    onChange={(e) => setCsvMapping(i, e.target.value)}
                  >
                    <option value="">(skip)</option>
                    {csvImp.tableCols.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {csvImp.preview.length > 0 && (
              <div className="csv-preview">
                <table className="grid">
                  <thead>
                    <tr>
                      {csvImp.header.map((h, i) => (
                        <th key={i}>{h || `col${i + 1}`}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvImp.preview.map((r, ri) => (
                      <tr key={ri}>
                        {csvImp.header.map((_, ci) => (
                          <td key={ci}>{maskText(r[ci] ?? "")}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {csvImp.running && (
              <>
                <div className={"pbar" + (csvImp.rowCount ? "" : " indet")}>
                  <div
                    className="pfill"
                    style={
                      csvImp.rowCount
                        ? { width: `${Math.min(100, (csvImp.inserted / csvImp.rowCount) * 100)}%` }
                        : undefined
                    }
                  />
                </div>
                <div className="muted">
                  Inserting {csvImp.inserted.toLocaleString()} / {csvImp.rowCount.toLocaleString()}…
                </div>
              </>
            )}
            {csvImp.done && (
              <div className="csv-ok">
                <Icon name="table" size={13} /> Imported {csvImp.inserted.toLocaleString()} row(s) into {csvImp.table}.
              </div>
            )}
            {csvImp.error && <div className="error">{csvImp.error}</div>}

            <div className="form-row end">
              {csvImp.done ? (
                <button onClick={() => setCsvImp(null)}>Close</button>
              ) : (
                <>
                  <button className="ghost" disabled={csvImp.running} onClick={() => setCsvImp(null)}>
                    Cancel
                  </button>
                  <button disabled={csvImp.running || csvImp.rowCount === 0} onClick={runCsvImport}>
                    Import {csvImp.rowCount.toLocaleString()} row(s)
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
        </div>

        {aiOpen && connected && (
          <AiChat
            makeToolset={() => makeDbToolset(dbCtx)}
            buildSystem={() => dbSystemPrompt(dbCtx())}
            placeholder={
              'Ask about this database — "show all tables", "top 10 rows of orders", "which columns does users have?".'
            }
            onClose={() => onAiClose?.()}
          />
        )}
      </div>
    </div>
  );
}
