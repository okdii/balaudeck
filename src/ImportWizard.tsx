import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type DbConnParams } from "./api";
import { quoteIdent, qualified, isMysqlFamily } from "./ddl";
import { parseCsv, guessDelimiter } from "./csv";
import { Icon } from "./Icon";

type Mode = "append" | "upsert" | "copy";
type SourceFile = {
  path: string;
  name: string;
  kind: "csv" | "excel";
  /** All rows including the (possible) header — the header/body split is derived
   *  from `hasHeader` so toggling it never re-reads the file. */
  grid: (string | null)[][];
  sheets?: string[];
  error?: string;
};

const EXT_EXCEL = ["xlsx", "xls", "xlsb", "ods"];
const CHUNK = 200;

/**
 * Navicat-style Import Wizard: load one or more CSV/Excel files into a table.
 * Steps — sources → target table + mode → column mapping (+ key) → run. Modes:
 * Append (insert), Append/Update (upsert by key), Copy (empty then load). Reuses
 * the app's CSV parser, the Excel reader (`read_spreadsheet`), and the batched,
 * transactional `db_exec_batch` (whose per-statement affected count splits
 * Added vs Updated on MySQL).
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
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [busy, setBusy] = useState(false);

  const [targetDb, setTargetDb] = useState(initialDb);
  const [tables, setTables] = useState<string[]>([]);
  const [targetTable, setTargetTable] = useState(initialTable ?? "");
  const [mode, setMode] = useState<Mode>("append");

  const [tableCols, setTableCols] = useState<string[]>([]);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [keys, setKeys] = useState<string[]>([]);

  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState("");
  const [counts, setCounts] = useState({ processed: 0, added: 0, updated: 0, deleted: 0, errors: 0 });
  const [log, setLog] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const cancel = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  const upsertOk = isMysqlFamily(engine) || engine === "postgres" || engine === "sqlite";

  // Header + combined body derived from the raw grids so the header toggle is free.
  const srcHeader = useMemo(() => {
    const g0 = files[0]?.grid;
    if (!g0 || g0.length === 0) return [] as string[];
    return hasHeader
      ? g0[0].map((c) => String(c ?? "").trim())
      : g0[0].map((_, i) => `Column ${i + 1}`);
  }, [files, hasHeader]);
  const body = useMemo(
    () => files.flatMap((f) => (hasHeader ? f.grid.slice(1) : f.grid)),
    [files, hasHeader],
  );

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  async function addFiles() {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Data files", extensions: ["csv", "tsv", "txt", ...EXT_EXCEL] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setBusy(true);
    const next: SourceFile[] = [];
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() || path;
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      try {
        if (EXT_EXCEL.includes(ext)) {
          // Read the raw grid (header off) so the header toggle stays local.
          const s = await api.readSpreadsheet(path, null, false);
          next.push({ path, name, kind: "excel", grid: s.rows, sheets: s.sheets });
        } else {
          const text = await api.readTextFile(path);
          const grid = parseCsv(text, guessDelimiter(text)).filter(
            (r) => !(r.length === 1 && r[0] === ""),
          );
          next.push({ path, name, kind: "csv", grid });
        }
      } catch (e) {
        next.push({ path, name, kind: EXT_EXCEL.includes(ext) ? "excel" : "csv", grid: [], error: String(e) });
      }
    }
    setFiles((f) => [...f, ...next]);
    setBusy(false);
  }

  // Load the target db's tables when the db changes / on entering step 2.
  useEffect(() => {
    if (step !== 2 || !targetDb) return;
    let alive = true;
    api
      .dbSchemaObjects({ ...params, database: targetDb }, targetDb)
      .then((o) => alive && setTables(o.tables))
      .catch(() => alive && setTables([]));
    return () => {
      alive = false;
    };
  }, [step, targetDb]);

  // Fetch the target columns + auto-map by name when entering the mapping step.
  useEffect(() => {
    if (step !== 3 || !targetTable) return;
    let alive = true;
    api
      .dbQuery({ ...params, database: targetDb }, `SELECT * FROM ${qualified(engine, targetDb, targetTable)} WHERE 1=0`)
      .then((res) => {
        if (!alive) return;
        const cols = res.columns;
        setTableCols(cols);
        setMapping(
          srcHeader.map((h) => {
            const hit = cols.find((c) => c.toLowerCase() === h.toLowerCase());
            return hit ?? null;
          }),
        );
        setKeys((k) => k.filter((c) => cols.includes(c)));
      })
      .catch((e) => alive && setErr(`Could not read ${targetTable} columns: ${e}`));
    return () => {
      alive = false;
    };
  }, [step, targetTable]);

  const mapped = useMemo(
    () =>
      mapping
        .map((tc, i) => ({ srcIdx: i, tableCol: tc }))
        .filter((c): c is { srcIdx: number; tableCol: string } => !!c.tableCol),
    [mapping],
  );
  const dupTarget = useMemo(() => {
    const seen = new Set<string>();
    for (const m of mapped) {
      if (seen.has(m.tableCol)) return m.tableCol;
      seen.add(m.tableCol);
    }
    return null;
  }, [mapped]);

  function setMap(i: number, col: string | null) {
    setMapping((m) => m.map((v, j) => (j === i ? col : v)));
  }
  function toggleKey(col: string) {
    setKeys((k) => (k.includes(col) ? k.filter((c) => c !== col) : [...k, col]));
  }

  function buildSql(cols: { srcIdx: number; tableCol: string }[]): string {
    const qt = qualified(engine, targetDb, targetTable);
    const colList = cols.map((c) => quoteIdent(engine, c.tableCol)).join(", ");
    const ph = cols.map(() => "?").join(", ");
    if (mode !== "upsert") return `INSERT INTO ${qt} (${colList}) VALUES (${ph})`;
    const nonKey = cols.filter((c) => !keys.includes(c.tableCol));
    if (isMysqlFamily(engine)) {
      const upd = nonKey.length
        ? nonKey.map((c) => `${quoteIdent(engine, c.tableCol)}=VALUES(${quoteIdent(engine, c.tableCol)})`).join(", ")
        : `${quoteIdent(engine, keys[0])}=${quoteIdent(engine, keys[0])}`;
      return `INSERT INTO ${qt} (${colList}) VALUES (${ph}) ON DUPLICATE KEY UPDATE ${upd}`;
    }
    // postgres / sqlite
    const conflict = keys.map((c) => quoteIdent(engine, c)).join(", ");
    const upd = nonKey.map((c) => `${quoteIdent(engine, c.tableCol)}=EXCLUDED.${quoteIdent(engine, c.tableCol)}`).join(", ");
    return `INSERT INTO ${qt} (${colList}) VALUES (${ph}) ON CONFLICT (${conflict}) DO ${
      upd ? `UPDATE SET ${upd}` : "NOTHING"
    }`;
  }

  async function run() {
    setRunning(true);
    setDone(false);
    setErr("");
    cancel.current = false;
    setCounts({ processed: 0, added: 0, updated: 0, deleted: 0, errors: 0 });
    const started = Date.now();
    const tick = window.setInterval(() => setElapsed((Date.now() - started) / 1000), 200);
    const push = (line: string) => setLog((l) => [...l, line]);
    const qt = qualified(engine, targetDb, targetTable);
    let added = 0;
    let upserted = 0;
    let deleted = 0;
    let processed = 0;
    try {
      push("[IMP] Import start");
      push(`[IMP] Import from - ${files.map((f) => f.name).join(" | ")}`);
      push(`[IMP] Mode - ${mode === "upsert" ? "Append/Update" : mode}`);
      if (mode === "copy") {
        const res = await api.dbExecBatch({ ...params, database: targetDb }, [{ sql: `DELETE FROM ${qt}`, values: [] }], false);
        deleted = res[0] ?? 0;
        setCounts((c) => ({ ...c, deleted }));
        push(`[IMP] Copy - emptied ${qt} (${deleted} row(s))`);
      }
      const sql = buildSql(mapped);
      for (let s = 0; s < body.length; s += CHUNK) {
        if (cancel.current) {
          push("[IMP] Stopped by user");
          break;
        }
        const chunk = body.slice(s, s + CHUNK);
        const statements = chunk.map((r) => ({
          sql,
          values: mapped.map((c) => {
            const v = r[c.srcIdx];
            return emptyAsNull && (v === "" || v == null) ? null : (v ?? null);
          }),
        }));
        const affected = await api.dbExecBatch({ ...params, database: targetDb }, statements, false);
        // Every engine reports affected_rows = 1 for both an insert and an
        // ON-CONFLICT/DUPLICATE-KEY update (MySQL runs with CLIENT_FOUND_ROWS), so
        // there is no reliable insert-vs-update split. Append counts inserts; upsert
        // reports a combined "upserted" total.
        if (mode === "upsert") upserted += chunk.length;
        else for (const a of affected) added += a;
        processed += chunk.length;
        setCounts({ processed, added, updated: upserted, deleted, errors: 0 });
        push(`[IMP] Import data [${targetTable}] — ${processed}/${body.length}`);
      }
      push(
        `[IMP] Import complete — ${
          mode === "upsert" ? `${upserted} upserted` : `${added} added`
        }${deleted ? `, ${deleted} cleared` : ""}`,
      );
      setDone(true);
      onDone(targetDb, targetTable);
    } catch (e) {
      setCounts((c) => ({ ...c, errors: 1 }));
      setErr(`Imported ${processed} row(s), then a batch failed: ${e}`);
      push(`[IMP] ERROR - ${e}`);
    } finally {
      window.clearInterval(tick);
      setElapsed((Date.now() - started) / 1000);
      setRunning(false);
    }
  }

  // ---- step gating ----
  const canNext1 = files.some((f) => !f.error && f.grid.length > 0);
  const canNext2 = !!targetTable && (mode !== "upsert" || upsertOk);
  const canStart =
    mapped.length > 0 &&
    body.length > 0 &&
    !dupTarget &&
    (mode !== "upsert" || keys.length > 0);

  const modeLabel = mode === "upsert" ? "Append/Update" : mode[0].toUpperCase() + mode.slice(1);

  return (
    <div className="pane-overlay" onClick={() => (running ? undefined : onClose())}>
      <div className="modal iw-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <Icon name="upload" size={15} /> Import Wizard
          {targetTable && <span className="muted"> — {targetTable}</span>}
        </h3>
        <div className="iw-steps">
          {["Sources", "Target", "Mapping", "Run"].map((s, i) => (
            <span key={s} className={"iw-step" + (step === i + 1 ? " active" : step > i + 1 ? " done" : "")}>
              {i + 1}. {s}
            </span>
          ))}
        </div>

        <div className="iw-body">
          {step === 1 && (
            <>
              <p className="muted">Add the CSV or Excel file(s) to import. Several files load into the same table.</p>
              <div className="iw-files">
                {files.length === 0 && <div className="iw-empty muted">No files yet.</div>}
                {files.map((f, i) => (
                  <div className="iw-file" key={f.path + i}>
                    <Icon name={f.kind === "excel" ? "table" : "code"} size={13} />
                    <span className="iw-file-name" title={f.path}>
                      {f.name}
                    </span>
                    <span className="muted">
                      {f.error ? <span className="iw-err">{f.error}</span> : `${Math.max(0, f.grid.length - (hasHeader ? 1 : 0))} rows`}
                    </span>
                    <button className="icon" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} title="Remove">
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
                  <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First
                  row is a header
                </label>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="dt-target-row">
                <label>
                  Target database
                  <select value={targetDb} onChange={(e) => { setTargetDb(e.target.value); setTargetTable(""); }}>
                    {databases.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Target table
                  <select value={targetTable} onChange={(e) => setTargetTable(e.target.value)}>
                    <option value="">Choose a table…</option>
                    {tables.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="iw-modes">
                {(["append", "upsert", "copy"] as Mode[]).map((m) => (
                  <label key={m} className={"iw-mode" + (mode === m ? " on" : "") + (m === "upsert" && !upsertOk ? " disabled" : "")}>
                    <input
                      type="radio"
                      name="iw-mode"
                      checked={mode === m}
                      disabled={m === "upsert" && !upsertOk}
                      onChange={() => setMode(m)}
                    />
                    <span>
                      <b>
                        {m === "append" ? "Append" : m === "upsert" ? "Append/Update" : "Copy"}
                      </b>
                      <small>
                        {m === "append"
                          ? " — add every row to the table"
                          : m === "upsert"
                          ? " — update rows that match the key, insert the rest"
                          : " — empty the table first, then load"}
                        {m === "upsert" && !upsertOk ? " (not available for this engine)" : ""}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <p className="muted">
                Map each source column to a table column. {mode === "upsert" && "Tick Key on the column(s) that identify a row."}
              </p>
              {dupTarget && <div className="dt-note dt-err">Two source columns map to “{dupTarget}”. Pick different targets.</div>}
              <div className="iw-map">
                <div className="iw-map-head">
                  <span>Source column</span>
                  <span>Target column</span>
                  {mode === "upsert" && <span className="iw-key-h">Key</span>}
                </div>
                <div className="iw-map-rows">
                  {srcHeader.map((h, i) => (
                    <div className="iw-map-row" key={i}>
                      <span className="iw-src" title={h}>{h || `Column ${i + 1}`}</span>
                      <select value={mapping[i] ?? ""} onChange={(e) => setMap(i, e.target.value || null)}>
                        <option value="">— skip —</option>
                        {tableCols.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      {mode === "upsert" && (
                        <input
                          type="checkbox"
                          className="iw-key"
                          disabled={!mapping[i]}
                          checked={!!mapping[i] && keys.includes(mapping[i]!)}
                          onChange={() => mapping[i] && toggleKey(mapping[i]!)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <label className="opt-check">
                <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} /> Treat
                empty cells as NULL
              </label>
            </>
          )}

          {step === 4 && (
            <div className="iw-run">
              <div className="iw-stats">
                <span>Files: <b>{files.length}</b></span>
                <span>Rows: <b>{body.length}</b></span>
                <span>Into: <b>{targetDb}.{targetTable}</b></span>
                <span>Mode: <b>{modeLabel}</b></span>
              </div>
              <div className="iw-stats">
                <span>Processed: <b>{counts.processed}</b></span>
                {mode === "upsert" ? (
                  <span>Upserted: <b>{counts.updated}</b></span>
                ) : (
                  <span>Added: <b>{counts.added}</b></span>
                )}
                {mode === "copy" && <span>Cleared: <b>{counts.deleted}</b></span>}
                <span>Error: <b>{counts.errors}</b></span>
                <span>Time: <b>{elapsed.toFixed(2)} s</b></span>
              </div>
              {body.length === 0 && !running && !done && (
                <div className="dt-note">
                  No data rows to import — check the file and the “First row is a header” option.
                </div>
              )}
              <div className={"pbar" + (body.length ? "" : " indet")}>
                <div className="pfill" style={body.length ? { width: `${Math.min(100, (counts.processed / body.length) * 100)}%` } : undefined} />
              </div>
              {log.length > 0 && <pre className="iw-log" ref={logRef}>{log.join("\n")}</pre>}
              {err && <div className="dt-note dt-err">{err}</div>}
            </div>
          )}
        </div>

        <div className="form-row end iw-foot">
          {step > 1 && step < 4 && (
            <button className="ghost" onClick={() => setStep(step - 1)}>Back</button>
          )}
          <button className="ghost" onClick={onClose}>{done ? "Close" : "Cancel"}</button>
          {step < 4 && (
            <button
              disabled={(step === 1 && !canNext1) || (step === 2 && !canNext2)}
              onClick={() => setStep(step + 1)}
            >
              Next
            </button>
          )}
          {step === 4 && !done && (
            running ? (
              <button className="danger-btn" onClick={() => (cancel.current = true)}>Stop</button>
            ) : (
              <button disabled={!canStart} onClick={run}>
                <Icon name="play" size={13} /> Start import
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
