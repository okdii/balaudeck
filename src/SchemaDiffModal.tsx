import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DbConnParams } from "./api";
import { DB_ENGINES, type DbProfile, type SshProfile } from "./types";
import type { TableSchemaInfo } from "./ddl";
import { diffScript, diffTable, orderDiffs, type DiffKind, type TableDiff } from "./schemaDiff";
import { openDbConnection } from "./dbConnect";
import { Icon, Spinner } from "./Icon";

const isMysqlish = (e: string) => e === "mysql" || e === "mariadb";
const sameFamily = (a: string, b: string) => a === b || (isMysqlish(a) && isMysqlish(b));

const KIND_LABEL: Record<DiffKind, string> = {
  create: "Create",
  alter: "Alter",
  drop: "Drop",
  same: "Identical",
};

/** Searchable single-pick list (connection / database). */
function Pick({
  value,
  options,
  placeholder,
  disabled,
  onPick,
}: {
  value: string;
  options: { id: string; label: string }[];
  placeholder: string;
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="dt-combo">
      <input
        className="dt-combo-input"
        placeholder={placeholder}
        disabled={disabled}
        value={open ? q : options.find((o) => o.id === value)?.label ?? ""}
        onFocus={() => {
          setOpen(true);
          setQ("");
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && (
        <ul className="dt-combo-list">
          {shown.map((o) => (
            <li
              key={o.id}
              className={o.id === value ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(o.id);
                setOpen(false);
              }}
            >
              {o.label}
            </li>
          ))}
          {shown.length === 0 && <li className="dt-combo-empty">No match</li>}
        </ul>
      )}
    </div>
  );
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Schema compare: diff the current (source) database's tables against another
 * database — on this or any saved connection of the same engine — and generate
 * the DDL that brings the TARGET in line with the source. Review per table,
 * copy the script, or apply it to the target.
 */
export function SchemaDiffModal({
  sourceParams,
  sourceDb,
  sourceEngine,
  sourceLabel,
  dbProfiles,
  sshProfiles,
  onClose,
}: {
  sourceParams: DbConnParams;
  sourceDb: string;
  sourceEngine: string;
  sourceLabel: string;
  dbProfiles: DbProfile[];
  sshProfiles: SshProfile[];
  onClose: () => void;
}) {
  const targets = useMemo(
    () => dbProfiles.filter((p) => DB_ENGINES[p.engine]?.family === "sql" && sameFamily(p.engine, sourceEngine)),
    [dbProfiles, sourceEngine],
  );
  const connLabel = (p: DbProfile) => `${p.name || `${p.user}@${p.host}`} (${DB_ENGINES[p.engine]?.label ?? p.engine})`;

  const [targetId, setTargetId] = useState("");
  const [targetConn, setTargetConn] = useState<{ params: DbConnParams; tunnelId: string | null } | null>(null);
  const [targetDbs, setTargetDbs] = useState<string[]>([]);
  const [targetDb, setTargetDb] = useState("");
  const [connBusy, setConnBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<TableDiff[] | null>(null);
  const [srcSchemas, setSrcSchemas] = useState<Map<string, TableSchemaInfo>>(new Map());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [showSame, setShowSame] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [applied, setApplied] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tunnelRef = useRef<string | null>(null);
  useEffect(() => {
    tunnelRef.current = targetConn?.tunnelId ?? null;
  }, [targetConn]);
  useEffect(
    () => () => {
      if (tunnelRef.current) api.tunnelStop(tunnelRef.current).catch(() => {});
    },
    [],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function pickTarget(id: string) {
    setTargetId(id);
    setErr(null);
    setTargetDbs([]);
    setTargetDb("");
    setDiffs(null);
    if (targetConn?.tunnelId) api.tunnelStop(targetConn.tunnelId).catch(() => {});
    setTargetConn(null);
    const prof = targets.find((p) => p.id === id);
    if (!prof) return;
    setConnBusy(true);
    try {
      const conn = await openDbConnection(prof, sshProfiles);
      setTargetConn(conn);
      const dbs = await api.dbListDatabases(conn.params);
      setTargetDbs(dbs);
      const sameServer = conn.params.host === sourceParams.host && conn.params.port === sourceParams.port;
      setTargetDb(dbs.includes(sourceDb) && !sameServer ? sourceDb : dbs.find((d) => d !== sourceDb) ?? dbs[0] ?? "");
    } catch (e) {
      setErr(String(e));
    } finally {
      setConnBusy(false);
    }
  }

  const sameTarget =
    !!targetConn &&
    targetConn.params.host === sourceParams.host &&
    targetConn.params.port === sourceParams.port &&
    (targetConn.params.file ?? "") === (sourceParams.file ?? "") &&
    targetDb === sourceDb;

  async function compare() {
    if (!targetConn || !targetDb) return;
    setErr(null);
    setApplied(null);
    setDiffs(null);
    try {
      setBusy("Listing tables…");
      const [so, to] = await Promise.all([
        api.dbSchemaObjects(sourceParams, sourceDb),
        api.dbSchemaObjects(targetConn.params, targetDb),
      ]);
      const srcSet = new Set(so.tables);
      const tgtSet = new Set(to.tables);
      const all = Array.from(new Set([...so.tables, ...to.tables])).sort((a, b) => a.localeCompare(b));
      let done = 0;
      const load = async (params: DbConnParams, db: string, t: string) => api.dbTableSchema(params, db, t);
      const srcMap = new Map<string, TableSchemaInfo>();
      const result = await pool(all, 4, async (t) => {
        const [s, g] = await Promise.all([
          srcSet.has(t) ? load(sourceParams, sourceDb, t) : Promise.resolve(null),
          tgtSet.has(t) ? load(targetConn.params, targetDb, t) : Promise.resolve(null),
        ]);
        if (s) srcMap.set(t, s);
        done++;
        setBusy(`Comparing ${done}/${all.length}…`);
        return diffTable(sourceEngine, targetDb, t, s, g);
      });
      setSrcSchemas(srcMap);
      setDiffs(result);
      // Drops are opt-in: a table only in the target may be intentional.
      setPicked(new Set(result.filter((d) => d.kind === "create" || d.kind === "alter").map((d) => d.table)));
      setOpen(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(null);
    }
  }

  const changed = diffs?.filter((d) => d.kind !== "same") ?? [];
  const same = diffs?.filter((d) => d.kind === "same") ?? [];
  const chosen = orderDiffs(changed.filter((d) => picked.has(d.table)), srcSchemas);
  const script = diffScript(chosen);
  const stmtCount = chosen.reduce((n, d) => n + d.statements.length, 0);
  const counts = (k: DiffKind) => changed.filter((d) => d.kind === k).length;

  function toggle(t: string) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  }

  async function copy() {
    await navigator.clipboard.writeText(script).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function apply() {
    if (!targetConn) return;
    setConfirm(false);
    setErr(null);
    setBusy("Applying…");
    try {
      await api.dbExecDdl(
        targetConn.params,
        targetDb,
        chosen.flatMap((d) => d.statements),
      );
      setApplied(`Applied ${stmtCount} statement${stmtCount === 1 ? "" : "s"} to ${targetDb}.`);
      setBusy(null);
      await compare();
    } catch (e) {
      setErr(String(e));
      setBusy(null);
    }
  }

  const hasDrops = chosen.some((d) => d.kind === "drop");

  return (
    <div className="pane-overlay" onClick={() => !busy && onClose()}>
      <div className="modal dt-modal sd-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          Schema compare — <code>{sourceLabel}</code> · <code>{sourceDb}</code>
        </h3>
        <p className="muted sd-lead">
          Generates the DDL that makes the <b>target</b> match this database's tables (columns, keys, foreign keys,
          indexes).
        </p>

        <div className="dt-target-row">
          <label>
            Target connection
            <Pick
              value={targetId}
              placeholder="Search connections…"
              options={targets.map((p) => ({ id: p.id, label: connLabel(p) }))}
              onPick={pickTarget}
              disabled={!!busy}
            />
          </label>
          <label>
            Target database
            <Pick
              value={targetDb}
              placeholder={targetConn ? "Search databases…" : "—"}
              options={targetDbs.map((d) => ({ id: d, label: d }))}
              onPick={(d) => {
                setTargetDb(d);
                setDiffs(null);
              }}
              disabled={!targetConn || connBusy || !!busy}
            />
          </label>
          <button className="sd-compare" disabled={!targetConn || !targetDb || sameTarget || !!busy} onClick={compare}>
            {busy && !diffs ? <Spinner size={13} /> : <Icon name="refresh" size={13} />} Compare
          </button>
        </div>
        {connBusy && <div className="muted dt-note">Connecting…</div>}
        {targets.length === 0 && (
          <div className="dt-note dt-err">
            No {DB_ENGINES[sourceEngine as keyof typeof DB_ENGINES]?.label ?? sourceEngine} connection saved to compare
            against.
          </div>
        )}
        {sameTarget && <div className="dt-note dt-err">Target is the same database as the source.</div>}
        {busy && <div className="muted dt-note">{busy}</div>}
        {err && <pre className="error sd-err">{err}</pre>}
        {applied && <div className="dt-note dt-ok">{applied}</div>}

        {diffs && (
          <>
            <div className="sd-summary">
              {changed.length === 0 ? (
                <span className="dt-ok">
                  <Icon name="check" size={13} /> Schemas match — {same.length} table{same.length === 1 ? "" : "s"}{" "}
                  identical.
                </span>
              ) : (
                <>
                  <span className="sd-chip create">{counts("create")} new</span>
                  <span className="sd-chip alter">{counts("alter")} changed</span>
                  <span className="sd-chip drop">{counts("drop")} only in target</span>
                  <span className="muted">{same.length} identical</span>
                  <span className="xi-spacer" />
                  {same.length > 0 && (
                    <label className="opt-check">
                      <input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} /> Show
                      identical
                    </label>
                  )}
                </>
              )}
            </div>

            {(changed.length > 0 || showSame) && (
              <div className="sd-list">
                {[...changed, ...(showSame ? same : [])].map((d) => (
                  <div key={d.table} className={"sd-item" + (open === d.table ? " open" : "")}>
                    <div className="sd-row">
                      <input
                        type="checkbox"
                        disabled={d.kind === "same"}
                        checked={picked.has(d.table)}
                        onChange={() => toggle(d.table)}
                      />
                      <button
                        className="sd-name"
                        disabled={d.kind === "same"}
                        onClick={() => setOpen(open === d.table ? null : d.table)}
                      >
                        <Icon name={open === d.table ? "chevronDown" : "chevronRight"} size={12} />
                        <span>{d.table}</span>
                      </button>
                      <span className={"sd-chip " + d.kind}>{KIND_LABEL[d.kind]}</span>
                      <span className="sd-sum muted">{d.kind === "alter" ? d.summary : d.kind === "create" ? d.summary : ""}</span>
                    </div>
                    {open === d.table && d.statements.length > 0 && (
                      <pre className="sd-sql">{d.statements.map((s) => s.replace(/;\s*$/, "") + ";").join("\n")}</pre>
                    )}
                  </div>
                ))}
              </div>
            )}

            {changed.length > 0 && (
              <>
                {hasDrops && (
                  <div className="dt-note dt-err">
                    <Icon name="info" size={12} /> The script drops tables — their data will be lost.
                  </div>
                )}
                {confirm ? (
                  <div className="sd-confirm">
                    <span>
                      Run {stmtCount} statement{stmtCount === 1 ? "" : "s"} on <code>{targetDb}</code>
                      {hasDrops ? ", including DROP TABLE" : ""}?
                    </span>
                    <span className="xi-spacer" />
                    <button className="ghost" onClick={() => setConfirm(false)}>
                      Cancel
                    </button>
                    <button className={hasDrops ? "danger-btn" : "primary"} onClick={apply}>
                      Run on target
                    </button>
                  </div>
                ) : (
                  <div className="form-row end">
                    <span className="muted sd-count">
                      {chosen.length} table{chosen.length === 1 ? "" : "s"} · {stmtCount} statement
                      {stmtCount === 1 ? "" : "s"}
                    </span>
                    <button className="ghost" onClick={onClose} disabled={!!busy}>
                      Close
                    </button>
                    <button className="ghost" disabled={!stmtCount} onClick={copy}>
                      <Icon name={copied ? "check" : "copy"} size={13} /> {copied ? "Copied" : "Copy SQL"}
                    </button>
                    <button disabled={!stmtCount || !!busy} onClick={() => setConfirm(true)}>
                      <Icon name="chevronRight" size={13} /> Apply to target
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
        {!diffs && (
          <div className="form-row end">
            <button className="ghost" onClick={onClose} disabled={!!busy}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
