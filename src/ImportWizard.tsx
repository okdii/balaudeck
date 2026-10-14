import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type DbConnParams } from "./api";
import { quoteIdent, qualified, isMysqlFamily } from "./ddl";
import { parseCsv, guessDelimiter } from "./csv";
import { Icon } from "./Icon";

type Mode = "append" | "update" | "upsert" | "delete" | "copy";

/** A workbook (or CSV) on disk. Sheets are read lazily and cached by name;
 *  CSV files use the single key "" . */
type Workbook = {
  path: string;
  fileName: string;
  kind: "csv" | "excel";
  sheets: string[]; // [] for CSV
  grids: Record<string, (string | null)[][]>;
  error?: string;
};

/** One chosen (file, sheet) pair — the unit Navicat maps to a target table. */
type Source = {
  id: string; // `${path}::${sheet}`
  path: string;
  fileName: string;
  sheet: string; // "" for CSV
  label: string; // "Sheet1 (Book.xlsx)" or "data.csv"
  header: string[]; // derived from grid + hasHeader
  body: (string | null)[][]; // data rows (header stripped per hasHeader)
  target: string; // target table name within targetDb (existing or new)
  /** mapping[sourceColIdx] = target column name, or null to skip. For an
   *  existing table this is one of its columns; for a new table it is the
   *  name the column will be created with. */
  mapping: (string | null)[];
  keys: string[]; // target columns that identify a row / become the PK
  pristine: boolean; // mapping is still auto-derived (safe to re-derive)
};

const EXT_EXCEL = ["xlsx", "xls", "xlsb", "ods"];
const CHUNK = 200;
const KEY_MODES: Mode[] = ["update", "upsert", "delete"];

const low = (s: string) => s.trim().toLowerCase();
const baseName = (file: string) => file.replace(/\.[^.]+$/, "");
function sanitizeIdent(raw: string, fallback: string): string {
  const t = (raw ?? "").trim().replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return t || fallback;
}

/** Conservative column-type guess for a *new* table: BIGINT only when every
 *  value is a plain integer (no leading zeros, i64-safe), else text. */
function intLike(values: (string | null)[]): boolean {
  let any = false;
  for (const v of values) {
    if (v == null || v === "") continue;
    any = true;
    if (!/^-?\d+$/.test(v)) return false;
    if (/^-?0\d/.test(v)) return false; // "007" is a code, not a number
    if (v.replace(/^-/, "").length > 18) return false; // keep inside i64
  }
  return any;
}
function colType(engine: string, isKey: boolean, values: (string | null)[]): string {
  if (intLike(values)) {
    if (engine === "sqlite") return "INTEGER";
    if (engine === "postgres") return "bigint";
    return "BIGINT"; // mysql family + mssql
  }
  if (isKey) {
    // A key column needs a bounded length to be a primary key on MySQL/SQL Server.
    if (engine === "postgres") return "text";
    if (engine === "sqlite") return "TEXT";
    if (engine === "mssql") return "NVARCHAR(255)";
    return "VARCHAR(255)";
  }
  if (engine === "postgres") return "text";
  if (engine === "sqlite") return "TEXT";
  if (engine === "mssql") return "NVARCHAR(MAX)";
  return "TEXT";
}

type Incl = { srcIdx: number; col: string };
function included(s: Source): Incl[] {
  return s.mapping
    .map((c, i) => (c ? { srcIdx: i, col: c } : null))
    .filter((x): x is Incl => !!x);
}

function createTableSql(engine: string, db: string, table: string, cols: { name: string; type: string; key: boolean }[]): string {
  const defs = cols.map((c) => `${quoteIdent(engine, c.name)} ${c.type}${c.key ? " NOT NULL" : ""}`);
  const keyCols = cols.filter((c) => c.key);
  if (keyCols.length) defs.push(`PRIMARY KEY (${keyCols.map((c) => quoteIdent(engine, c.name)).join(", ")})`);
  const ifne = engine === "mssql" ? "" : "IF NOT EXISTS ";
  return `CREATE TABLE ${ifne}${qualified(engine, db, table)} (${defs.join(", ")})`;
}

/** The parameterised statement for one source + effective mode, plus the
 *  source-column indices to pull (in the order the placeholders expect). */
function buildPlan(
  engine: string,
  db: string,
  table: string,
  cols: Incl[],
  mode: Mode,
  keys: string[],
): { sql: string; idx: number[] } {
  const qt = qualified(engine, db, table);
  const q = (c: string) => quoteIdent(engine, c);
  if (mode === "delete") {
    const ke = keys.map((k) => cols.find((c) => c.col === k)).filter((c): c is Incl => !!c);
    return { sql: `DELETE FROM ${qt} WHERE ${ke.map((c) => `${q(c.col)}=?`).join(" AND ")}`, idx: ke.map((c) => c.srcIdx) };
  }
  if (mode === "update") {
    const ke = keys.map((k) => cols.find((c) => c.col === k)).filter((c): c is Incl => !!c);
    const nk = cols.filter((c) => !keys.includes(c.col));
    return {
      sql: `UPDATE ${qt} SET ${nk.map((c) => `${q(c.col)}=?`).join(", ")} WHERE ${ke.map((c) => `${q(c.col)}=?`).join(" AND ")}`,
      idx: [...nk.map((c) => c.srcIdx), ...ke.map((c) => c.srcIdx)],
    };
  }
  // insert family: append / copy / upsert
  const colList = cols.map((c) => q(c.col)).join(", ");
  const ph = cols.map(() => "?").join(", ");
  const idx = cols.map((c) => c.srcIdx);
  if (mode !== "upsert") return { sql: `INSERT INTO ${qt} (${colList}) VALUES (${ph})`, idx };
  const nonKey = cols.filter((c) => !keys.includes(c.col));
  if (isMysqlFamily(engine)) {
    const upd = nonKey.length
      ? nonKey.map((c) => `${q(c.col)}=VALUES(${q(c.col)})`).join(", ")
      : `${q(keys[0])}=${q(keys[0])}`;
    return { sql: `INSERT INTO ${qt} (${colList}) VALUES (${ph}) ON DUPLICATE KEY UPDATE ${upd}`, idx };
  }
  const conflict = keys.map(q).join(", ");
  const upd = nonKey.map((c) => `${q(c.col)}=EXCLUDED.${q(c.col)}`).join(", ");
  return { sql: `INSERT INTO ${qt} (${colList}) VALUES (${ph}) ON CONFLICT (${conflict}) DO ${upd ? `UPDATE SET ${upd}` : "NOTHING"}`, idx };
}

const MODE_TEXT: Record<Mode, { label: string; blurb: string }> = {
  append: { label: "Append", blurb: "add every source row to the table" },
  update: { label: "Update", blurb: "update rows that match the key — new rows are skipped" },
  upsert: { label: "Append/Update", blurb: "update rows that match the key, insert the rest" },
  delete: { label: "Delete", blurb: "delete the table rows that match the source key" },
  copy: { label: "Copy", blurb: "empty the table first, then load every row" },
};

/**
 * Navicat-style Import Wizard. Load one or more CSV/Excel files into a
 * connection. Each (file, sheet) is a *source* mapped to its own target table
 * — an existing one or a brand-new table the wizard creates from the source
 * columns. Steps: Sources → Sheets → Targets → Mapping → Mode → Run. Five
 * modes (Append, Update, Append/Update, Delete, Copy) match Navicat; Append/
 * Update needs MySQL/Postgres/SQLite, the rest work on every engine.
 */
export function ImportWizard({
  params,
  engine,
  initialDb,
  initialTable,
  databases,
  onClose,
  onDone,
}: {
  params: DbConnParams;
  engine: string;
  initialDb: string;
  initialTable?: string | null;
  databases: string[];
  onClose: () => void;
  onDone: (db: string, table: string) => void;
}) {
  const [step, setStep] = useState(1);
  const [wbs, setWbs] = useState<Workbook[]>([]);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [busy, setBusy] = useState(false);

  const [targetDb, setTargetDb] = useState(initialDb);
  const [tables, setTables] = useState<string[]>([]);
  const [colsCache, setColsCache] = useState<Record<string, string[]>>({}); // table(lower) -> columns
  const [sources, setSources] = useState<Source[]>([]);
  const [activeSrc, setActiveSrc] = useState(0);
  const [mode, setMode] = useState<Mode>("append");

  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const [counts, setCounts] = useState({ processed: 0, added: 0, updated: 0, upserted: 0, deleted: 0, errors: 0 });
  const [log, setLog] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const cancel = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  const upsertOk = isMysqlFamily(engine) || engine === "postgres" || engine === "sqlite";
  const existingSet = useMemo(() => new Set(tables.map(low)), [tables]);
  const isNewTarget = (t: string) => t.trim() !== "" && !existingSet.has(low(t));

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // ---------- step 1: add files ----------
  function headerBody(grid: (string | null)[][]): { header: string[]; body: (string | null)[][] } {
    if (!grid.length) return { header: [], body: [] };
    if (hasHeader) return { header: grid[0].map((c) => String(c ?? "").trim()), body: grid.slice(1) };
    return { header: grid[0].map((_, i) => `Column ${i + 1}`), body: grid };
  }

  async function addFiles() {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Data files", extensions: ["csv", "tsv", "txt", ...EXT_EXCEL] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setBusy(true);
    const next: Workbook[] = [];
    const nextSel: Record<string, boolean> = {};
    for (const path of paths) {
      if (wbs.some((w) => w.path === path)) continue;
      const fileName = path.split(/[\\/]/).pop() || path;
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      try {
        if (EXT_EXCEL.includes(ext)) {
          const s = await api.readSpreadsheet(path, null, false); // first sheet, raw grid
          const grids: Record<string, (string | null)[][]> = { [s.sheet]: s.rows };
          next.push({ path, fileName, kind: "excel", sheets: s.sheets, grids });
          // Pre-select the first sheet only (Navicat default).
          nextSel[`${path}::${s.sheet}`] = true;
        } else {
          const text = await api.readTextFile(path);
          const grid = parseCsv(text, guessDelimiter(text)).filter((r) => !(r.length === 1 && r[0] === ""));
          next.push({ path, fileName, kind: "csv", sheets: [], grids: { "": grid } });
          nextSel[`${path}::`] = true;
        }
      } catch (e) {
        next.push({ path, fileName, kind: EXT_EXCEL.includes(ext) ? "excel" : "csv", sheets: [], grids: {}, error: String(e) });
      }
    }
    setWbs((w) => [...w, ...next]);
    setSel((s) => ({ ...s, ...nextSel }));
    setBusy(false);
  }

  function removeWb(path: string) {
    setWbs((w) => w.filter((x) => x.path !== path));
    setSel((s) => {
      const n = { ...s };
      for (const k of Object.keys(n)) if (k.startsWith(path + "::")) delete n[k];
      return n;
    });
  }

  // Every (file, sheet) row shown on the Sheets step.
  const sheetRows = useMemo(
    () =>
      wbs.flatMap((w) =>
        (w.kind === "excel" ? w.sheets : [""]).map((sh) => ({
          key: `${w.path}::${sh}`,
          wb: w,
          sheet: sh,
        })),
      ),
    [wbs],
  );

  // ---------- load target tables ----------
  useEffect(() => {
    if (step < 2 || !targetDb) return;
    let alive = true;
    api
      .dbSchemaObjects({ ...params, database: targetDb }, targetDb)
      .then((o) => alive && setTables(o.tables))
      .catch(() => alive && setTables([]));
    return () => {
      alive = false;
    };
  }, [step >= 2, targetDb]);

  // ---------- step 2 → 3: materialise sources ----------
  async function materialiseSources(): Promise<Source[]> {
    const chosen = sheetRows.filter((r) => sel[r.key]);
    const out: Source[] = [];
    const wbCopy = wbs.map((w) => ({ ...w, grids: { ...w.grids } }));
    for (const r of chosen) {
      const w = wbCopy.find((x) => x.path === r.wb.path)!;
      if (w.grids[r.sheet] == null) {
        try {
          const s = await api.readSpreadsheet(w.path, r.sheet, false);
          w.grids[r.sheet] = s.rows;
        } catch (e) {
          w.grids[r.sheet] = [];
          w.error = String(e);
        }
      }
      const { header, body } = headerBody(w.grids[r.sheet] ?? []);
      // default target: the table the wizard was opened on, else the sheet /
      // file name, snapped to an existing table when the name already exists.
      let target = initialTable ?? (w.kind === "excel" ? sanitizeIdent(r.sheet, "sheet") : sanitizeIdent(baseName(w.fileName), "data"));
      const existing = tables.find((t) => low(t) === low(target));
      if (existing) target = existing;
      out.push({
        id: r.key,
        path: w.path,
        fileName: w.fileName,
        sheet: r.sheet,
        label: w.kind === "excel" ? `${r.sheet} (${w.fileName})` : w.fileName,
        header,
        body,
        target,
        mapping: header.map(() => null),
        keys: [],
        pristine: true,
      });
    }
    setWbs(wbCopy);
    return out;
  }

  // ---------- fetch columns for existing targets + auto-map pristine sources ----------
  useEffect(() => {
    if (step < 4) return;
    const wanted = Array.from(new Set(sources.filter((s) => !isNewTarget(s.target)).map((s) => low(s.target)))).filter(
      (t) => colsCache[t] == null,
    );
    if (wanted.length === 0) return;
    let alive = true;
    (async () => {
      const found: Record<string, string[]> = {};
      for (const t of wanted) {
        const real = tables.find((x) => low(x) === t) ?? t;
        try {
          const res = await api.dbQuery({ ...params, database: targetDb }, `SELECT * FROM ${qualified(engine, targetDb, real)} WHERE 1=0`);
          found[t] = res.columns;
        } catch {
          found[t] = [];
        }
      }
      if (alive) setColsCache((c) => ({ ...c, ...found }));
    })();
    return () => {
      alive = false;
    };
  }, [step >= 4, sources]);

  // When columns arrive, auto-map any still-pristine source that targets them.
  useEffect(() => {
    setSources((prev) =>
      prev.map((s) => {
        if (!s.pristine || isNewTarget(s.target)) return s;
        const cols = colsCache[low(s.target)];
        if (!cols) return s;
        const mapping = s.header.map((h) => cols.find((c) => low(c) === low(h)) ?? null);
        return { ...s, mapping, keys: s.keys.filter((k) => cols.includes(k)) };
      }),
    );
  }, [colsCache]);

  // ---------- target / mapping edits ----------
  function setTarget(id: string, value: string) {
    setSources((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s;
        if (isNewTarget(value)) {
          const mapping = s.header.map((h, i) => sanitizeIdent(h, `col_${i + 1}`));
          return { ...s, target: value, mapping, keys: s.keys.filter((k) => mapping.includes(k)), pristine: true };
        }
        const cols = colsCache[low(value)];
        const mapping = cols ? s.header.map((h) => cols.find((c) => low(c) === low(h)) ?? null) : s.header.map(() => null);
        return { ...s, target: value, mapping, keys: cols ? s.keys.filter((k) => cols.includes(k)) : [], pristine: true };
      }),
    );
  }
  function setTargetAll(value: string) {
    sources.forEach((s) => setTarget(s.id, value));
  }
  function setMap(idx: number, col: string | null) {
    setSources((prev) =>
      prev.map((s, i) => {
        if (i !== activeSrc) return s;
        const mapping = s.mapping.map((v, j) => (j === idx ? col : v));
        return { ...s, mapping, keys: s.keys.filter((k) => mapping.includes(k)), pristine: false };
      }),
    );
  }
  function toggleKey(col: string) {
    setSources((prev) =>
      prev.map((s, i) =>
        i === activeSrc ? { ...s, keys: s.keys.includes(col) ? s.keys.filter((c) => c !== col) : [...s.keys, col], pristine: false } : s,
      ),
    );
  }

  const cur = sources[activeSrc];
  const curNew = cur ? isNewTarget(cur.target) : false;
  const curCols = cur && !curNew ? colsCache[low(cur.target)] ?? [] : [];
  const dupTarget = useMemo(() => {
    if (!cur) return null;
    const seen = new Set<string>();
    for (const c of included(cur)) {
      if (seen.has(low(c.col))) return c.col;
      seen.add(low(c.col));
    }
    return null;
  }, [cur]);

  // ---------- validation ----------
  const totalRows = useMemo(() => sources.reduce((n, s) => n + s.body.length, 0), [sources]);
  const problems = useMemo(() => {
    const p: string[] = [];
    if (mode === "upsert" && !upsertOk) p.push("Append/Update is not available for this engine.");
    for (const s of sources) {
      const inc = included(s);
      if (inc.length === 0) {
        p.push(`“${s.label}” has no mapped columns.`);
        continue;
      }
      const seen = new Set<string>();
      for (const c of inc) {
        if (seen.has(low(c.col))) p.push(`“${s.label}” maps two columns to “${c.col}”.`);
        seen.add(low(c.col));
      }
      // new tables always insert, so key rules apply only to existing targets
      if (!isNewTarget(s.target) && KEY_MODES.includes(mode)) {
        if (s.keys.length === 0) p.push(`“${s.label}” needs at least one key column for ${MODE_TEXT[mode].label}.`);
        if (mode === "update" && inc.every((c) => s.keys.includes(c.col)))
          p.push(`“${s.label}” has only key columns mapped — nothing to update.`);
      }
    }
    return p;
  }, [sources, mode, upsertOk]);

  const newTargets = useMemo(
    () => Array.from(new Set(sources.filter((s) => isNewTarget(s.target)).map((s) => s.target))),
    [sources, existingSet],
  );

  // ---------- run ----------
  async function run() {
    setRunning(true);
    setDone(false);
    setErr("");
    cancel.current = false;
    setCounts({ processed: 0, added: 0, updated: 0, upserted: 0, deleted: 0, errors: 0 });
    const started = Date.now();
    const tick = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 200);
    const push = (line: string) => setLog((l) => [...l, line]);
    const c = { processed: 0, added: 0, updated: 0, upserted: 0, deleted: 0, errors: 0 };
    const created = new Set<string>();
    const touched = new Set<string>();
    try {
      push("[IMP] Import start");
      for (const s of sources) {
        if (cancel.current) {
          push("[IMP] Stopped by user");
          break;
        }
        const inc = included(s);
        const newTable = isNewTarget(s.target);
        const effMode: Mode = newTable ? "append" : mode;
        const qt = qualified(engine, targetDb, s.target);
        push(`[IMP] ${s.label} → ${s.target}${newTable ? " (new)" : ""} — ${MODE_TEXT[effMode].label}, ${s.body.length} row(s)`);

        if (newTable && !created.has(low(s.target))) {
          const cols = inc.map((ci) => ({
            name: ci.col,
            type: colType(engine, s.keys.includes(ci.col), s.body.map((r) => r[ci.srcIdx] ?? null)),
            key: s.keys.includes(ci.col),
          }));
          await api.dbExecBatch({ ...params, database: targetDb }, [{ sql: createTableSql(engine, targetDb, s.target, cols), values: [] }], false);
          created.add(low(s.target));
          push(`[IMP] Created table ${qt}`);
        }
        if (effMode === "copy") {
          const res = await api.dbExecBatch({ ...params, database: targetDb }, [{ sql: `DELETE FROM ${qt}`, values: [] }], false);
          c.deleted += res[0] ?? 0;
          setCounts({ ...c });
          push(`[IMP] Emptied ${qt} (${res[0] ?? 0} row(s))`);
        }
        const plan = buildPlan(engine, targetDb, s.target, inc, effMode === "copy" ? "append" : effMode, s.keys);
        for (let i = 0; i < s.body.length; i += CHUNK) {
          if (cancel.current) {
            push("[IMP] Stopped by user");
            break;
          }
          const chunk = s.body.slice(i, i + CHUNK);
          const statements = chunk.map((r) => ({
            sql: plan.sql,
            values: plan.idx.map((si) => {
              const v = r[si];
              return emptyAsNull && (v === "" || v == null) ? null : v ?? null;
            }),
          }));
          const affected = await api.dbExecBatch({ ...params, database: targetDb }, statements, false);
          const sum = affected.reduce((a, b) => a + b, 0);
          if (effMode === "update") c.updated += sum;
          else if (effMode === "upsert") c.upserted += chunk.length;
          else if (effMode === "delete") c.deleted += sum;
          else c.added += sum; // append / copy
          c.processed += chunk.length;
          setCounts({ ...c });
          push(`[IMP] ${s.target} — ${Math.min(i + CHUNK, s.body.length)}/${s.body.length}`);
        }
        touched.add(s.target);
      }
      const parts = [
        c.added ? `${c.added} added` : "",
        c.upserted ? `${c.upserted} upserted` : "",
        c.updated ? `${c.updated} updated` : "",
        c.deleted ? `${c.deleted} deleted` : "",
      ].filter(Boolean);
      push(`[IMP] Import complete — ${parts.join(", ") || "nothing to do"}`);
      setDone(true);
      const first = sources[0];
      if (first) onDone(targetDb, first.target);
    } catch (e) {
      c.errors += 1;
      setCounts({ ...c });
      setErr(`Imported ${c.processed} row(s), then a statement failed: ${e}`);
      push(`[IMP] ERROR - ${e}`);
    } finally {
      window.clearInterval(tick);
      setElapsed((Date.now() - started) / 1000);
      setRunning(false);
    }
  }

  // ---------- step gating ----------
  const selectedCount = sheetRows.filter((r) => sel[r.key]).length;
  const canNext1 = wbs.some((w) => !w.error && Object.values(w.grids).some((g) => g.length > 0));
  const canNext2 = selectedCount > 0;
  const canNext3 = sources.length > 0 && sources.every((s) => s.target.trim() !== "");
  const srcHasDup = (s: Source) => {
    const seen = new Set<string>();
    for (const c of included(s)) {
      if (seen.has(low(c.col))) return true;
      seen.add(low(c.col));
    }
    return false;
  };
  const canNext4 = sources.length > 0 && sources.every((s) => included(s).length > 0 && !srcHasDup(s));
  const canStart = sources.length > 0 && totalRows >= 0 && problems.length === 0;

  async function next() {
    if (step === 2) {
      setBusy(true);
      const src = await materialiseSources();
      setSources(src);
      setActiveSrc(0);
      setBusy(false);
    }
    setStep(step + 1);
  }

  const STEPS = ["Sources", "Sheets", "Targets", "Mapping", "Mode", "Run"];

  return (
    <div className="pane-overlay" onClick={() => (running ? undefined : onClose())}>
      <div className="modal iw-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <Icon name="upload" size={15} /> Import Wizard
          {initialTable && <span className="muted"> — {initialTable}</span>}
        </h3>
        <div className="iw-steps">
          {STEPS.map((s, i) => (
            <span key={s} className={"iw-step" + (step === i + 1 ? " active" : step > i + 1 ? " done" : "")}>
              {i + 1}. {s}
            </span>
          ))}
        </div>

        <div className="iw-body">
          {step === 1 && (
            <>
              <p className="muted">Add the CSV or Excel file(s) to import. Each sheet becomes its own source on the next step.</p>
              <div className="iw-files">
                {wbs.length === 0 && <div className="iw-empty muted">No files yet.</div>}
                {wbs.map((w) => (
                  <div className="iw-file" key={w.path}>
                    <Icon name={w.kind === "excel" ? "table" : "code"} size={13} />
                    <span className="iw-file-name" title={w.path}>
                      {w.fileName}
                    </span>
                    <span className="muted">
                      {w.error ? <span className="iw-err">{w.error}</span> : w.kind === "excel" ? `${w.sheets.length} sheet(s)` : `${Math.max(0, (w.grids[""]?.length ?? 0) - (hasHeader ? 1 : 0))} rows`}
                    </span>
                    <button className="icon" onClick={() => removeWb(w.path)} title="Remove">
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="form-row">
                <button onClick={addFiles} disabled={busy}>
                  <Icon name="plus" size={13} /> Add file(s)…
                </button>
                <label className="opt-check">
                  <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First row is a header
                </label>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="muted">Choose which sheet(s) to import. Each ticked row becomes a source you map to a table.</p>
              <div className="iw-sheets">
                <div className="iw-sheet-row iw-sheet-head">
                  <span className="c-pick">Import</span>
                  <span className="c-src">Source</span>
                  <span className="c-sheet">Sheet</span>
                </div>
                {sheetRows.map((r) => (
                  <div className="iw-sheet-row" key={r.key} onClick={() => setSel((s) => ({ ...s, [r.key]: !s[r.key] }))}>
                    <span className="c-pick">
                      <input type="checkbox" checked={!!sel[r.key]} readOnly tabIndex={-1} />
                    </span>
                    <span className="c-src" title={r.wb.fileName}>
                      {r.wb.fileName}
                    </span>
                    <span className="c-sheet" title={r.sheet || undefined}>
                      {r.sheet || "—"}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="dt-target-row">
                <label>
                  Target database
                  <select value={targetDb} onChange={(e) => setTargetDb(e.target.value)}>
                    {databases.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                {sources.length > 1 && (
                  <button className="ghost iw-sameall" onClick={() => setTargetAll(sources[0].target)} title="Use the first source's table for every source">
                    Same table for all
                  </button>
                )}
              </div>
              <p className="muted">Pick an existing table or type a new name — a new table is created from the source columns.</p>
              <div className="iw-map">
                <div className="iw-map-head">
                  <span>Source</span>
                  <span>Target table</span>
                  <span className="iw-new-c">New?</span>
                </div>
                <div className="iw-map-rows">
                  {sources.map((s) => (
                    <div className="iw-map-row" key={s.id}>
                      <span className="iw-src" title={s.label}>
                        {s.label}
                      </span>
                      <input className="iw-tcol" list="iw-tablelist" value={s.target} placeholder="table name" onChange={(e) => setTarget(s.id, e.target.value)} />
                      <span className="iw-new-c">{isNewTarget(s.target) ? <span className="iw-new-badge">NEW</span> : <Icon name="check" size={13} />}</span>
                    </div>
                  ))}
                </div>
              </div>
              <datalist id="iw-tablelist">
                {tables.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </>
          )}

          {step === 4 && cur && (
            <>
              {sources.length > 1 && (
                <div className="dt-target-row">
                  <label>
                    Source
                    <select className="iw-srcpick" value={activeSrc} onChange={(e) => setActiveSrc(Number(e.target.value))}>
                      {sources.map((s, i) => (
                        <option key={s.id} value={i}>
                          {s.label} → {s.target}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              <p className="muted">
                {curNew ? (
                  <>New table <b>{cur.target}</b> — edit column names, untick to skip, tick Key for the primary key.</>
                ) : (
                  <>Map each source column to a <b>{cur.target}</b> column. Tick Key on the column(s) that identify a row.</>
                )}
              </p>
              {dupTarget && <div className="dt-note dt-err">Two columns map to “{dupTarget}”. Pick different targets.</div>}
              <div className="iw-map">
                <div className="iw-map-head">
                  <span>Source column</span>
                  <span>Target column</span>
                  <span className="iw-key-h">Key</span>
                </div>
                <div className="iw-map-rows">
                  {cur.header.map((h, i) => (
                    <div className="iw-map-row" key={i}>
                      <span className="iw-src" title={h}>
                        {h || `Column ${i + 1}`}
                      </span>
                      {curNew ? (
                        <input
                          className="iw-tcol"
                          value={cur.mapping[i] ?? ""}
                          placeholder="— skip —"
                          onChange={(e) => setMap(i, e.target.value.trim() || null)}
                        />
                      ) : (
                        <select className="iw-tcol" value={cur.mapping[i] ?? ""} onChange={(e) => setMap(i, e.target.value || null)}>
                          <option value="">— skip —</option>
                          {curCols.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      )}
                      <input
                        type="checkbox"
                        className="iw-key"
                        disabled={!cur.mapping[i]}
                        checked={!!cur.mapping[i] && cur.keys.includes(cur.mapping[i]!)}
                        onChange={() => cur.mapping[i] && toggleKey(cur.mapping[i]!)}
                      />
                    </div>
                  ))}
                </div>
              </div>
              <label className="opt-check">
                <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} /> Treat empty cells as NULL
              </label>
            </>
          )}

          {step === 5 && (
            <>
              <p className="muted">Choose how the source rows are applied to each target table.</p>
              <div className="iw-modes">
                {(["append", "update", "upsert", "delete", "copy"] as Mode[]).map((m) => {
                  const disabled = m === "upsert" && !upsertOk;
                  return (
                    <label key={m} className={"iw-mode" + (mode === m ? " on" : "") + (disabled ? " disabled" : "")}>
                      <input type="radio" name="iw-mode" checked={mode === m} disabled={disabled} onChange={() => setMode(m)} />
                      <span>
                        <b>{MODE_TEXT[m].label}</b>
                        <small> — {MODE_TEXT[m].blurb}{disabled ? " (not available for this engine)" : ""}</small>
                      </span>
                    </label>
                  );
                })}
              </div>
              {newTargets.length > 0 && KEY_MODES.includes(mode) && (
                <div className="dt-note">New table(s) {newTargets.join(", ")} will be created and filled (Append), since there is nothing yet to {MODE_TEXT[mode].label.toLowerCase()}.</div>
              )}
            </>
          )}

          {step === 6 && (
            <div className="iw-run">
              <div className="iw-stats">
                <span>Sources: <b>{sources.length}</b></span>
                <span>Rows: <b>{totalRows}</b></span>
                <span>Into: <b>{targetDb}</b></span>
                <span>Mode: <b>{MODE_TEXT[mode].label}</b></span>
              </div>
              <div className="iw-stats">
                <span>Processed: <b>{counts.processed}</b></span>
                {counts.added > 0 || (mode !== "update" && mode !== "delete" && mode !== "upsert") ? <span>Added: <b>{counts.added}</b></span> : null}
                {mode === "upsert" && <span>Upserted: <b>{counts.upserted}</b></span>}
                {(mode === "update") && <span>Updated: <b>{counts.updated}</b></span>}
                {(mode === "delete" || mode === "copy") && <span>Deleted: <b>{counts.deleted}</b></span>}
                <span>Error: <b>{counts.errors}</b></span>
                <span>Time: <b>{elapsed.toFixed(2)} s</b></span>
              </div>
              {!running && !done && problems.length > 0 && (
                <div className="dt-note dt-err">
                  {problems.map((p, i) => (
                    <div key={i}>{p}</div>
                  ))}
                </div>
              )}
              <div className={"pbar" + (totalRows ? "" : " indet")}>
                <div className="pfill" style={totalRows ? { width: `${Math.min(100, (counts.processed / totalRows) * 100)}%` } : undefined} />
              </div>
              {log.length > 0 && <pre className="iw-log" ref={logRef}>{log.join("\n")}</pre>}
              {err && <div className="dt-note dt-err">{err}</div>}
            </div>
          )}
        </div>

        <div className="form-row end iw-foot">
          {step > 1 && step < 6 && (
            <button className="ghost" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </button>
          {step < 6 && (
            <button disabled={busy || (step === 1 && !canNext1) || (step === 2 && !canNext2) || (step === 3 && !canNext3) || (step === 4 && !canNext4)} onClick={next}>
              {busy ? "Reading…" : "Next"}
            </button>
          )}
          {step === 6 &&
            !done &&
            (running ? (
              <button className="danger-btn" onClick={() => (cancel.current = true)}>
                Stop
              </button>
            ) : (
              <button disabled={!canStart} onClick={run}>
                <Icon name="play" size={13} /> Start import
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
