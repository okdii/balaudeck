import { useEffect, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, type DbConnParams } from "./api";
import {
  DB_ENGINES,
  type DbProfile,
  type SshProfile,
  type DumpProgress,
  type ImportProgress,
} from "./types";
import { openDbConnection } from "./dbConnect";
import { Icon } from "./Icon";

type Phase = "setup" | "running" | "done" | "error" | "cancelled";

const isMysqlish = (e: string) => e === "mysql" || e === "mariadb";

/**
 * Navicat-style Data Transfer: copy selected tables — structure and/or data,
 * chosen independently per table — from the current (source) SQL connection to
 * another saved connection of the same engine. Runs as one backend job
 * (`db_transfer`) in two phases: read the source into a transient dump, then
 * stream it into the target. No file the user has to manage; memory stays
 * bounded on the import side. Cross-engine is a later phase.
 */
export function DataTransferModal({
  sourceParams,
  sourceDb,
  sourceEngine,
  sourceLabel,
  tables,
  dbProfiles,
  sshProfiles,
  onClose,
  onDone,
}: {
  sourceParams: DbConnParams;
  sourceDb: string;
  sourceEngine: string;
  sourceLabel: string;
  tables: string[];
  dbProfiles: DbProfile[];
  sshProfiles: SshProfile[];
  onClose: () => void;
  onDone: () => void;
}) {
  // Same-engine targets only (mysql/mariadb are wire-compatible for this).
  const targets = useMemo(
    () =>
      dbProfiles.filter(
        (p) =>
          DB_ENGINES[p.engine]?.family === "sql" &&
          (p.engine === sourceEngine ||
            (isMysqlish(p.engine) && isMysqlish(sourceEngine))),
      ),
    [dbProfiles, sourceEngine],
  );

  const [targetId, setTargetId] = useState("");
  const [targetConn, setTargetConn] = useState<{
    params: DbConnParams;
    tunnelId: string | null;
  } | null>(null);
  const [targetDbs, setTargetDbs] = useState<string[]>([]);
  const [targetDb, setTargetDb] = useState("");
  const [connBusy, setConnBusy] = useState(false);
  const [connErr, setConnErr] = useState<string | null>(null);

  const [sel, setSel] = useState<Record<string, { structure: boolean; data: boolean }>>(
    () => Object.fromEntries(tables.map((t) => [t, { structure: true, data: true }])),
  );
  const [filter, setFilter] = useState("");
  const [continueOnError, setContinueOnError] = useState(false);

  const [phase, setPhase] = useState<Phase>("setup");
  const [dump, setDump] = useState<{
    table: string;
    index: number;
    total: number;
  } | null>(null);
  const [imp, setImp] = useState<{
    bytes: number;
    total: number;
    executed: number;
    failed: number;
  } | null>(null);
  const [paused, setPaused] = useState(false);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const transferId = useRef("");
  const cancelledRef = useRef(false);

  // Keep the live target tunnel id in a ref so unmount can always tear it down.
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

  async function pickTarget(id: string) {
    setTargetId(id);
    setConnErr(null);
    setTargetDbs([]);
    setTargetDb("");
    // Drop any tunnel from a previously-picked target before opening a new one.
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
      setTargetDb(dbs.includes(sourceDb) ? sourceDb : dbs[0] ?? "");
    } catch (e) {
      setConnErr(String(e));
      setTargetConn(null);
    } finally {
      setConnBusy(false);
    }
  }

  const shown = useMemo(
    () => tables.filter((t) => t.toLowerCase().includes(filter.trim().toLowerCase())),
    [tables, filter],
  );
  const allStruct = shown.length > 0 && shown.every((t) => sel[t]?.structure);
  const allData = shown.length > 0 && shown.every((t) => sel[t]?.data);
  const chosen = tables.filter((t) => sel[t]?.structure || sel[t]?.data);

  function toggle(t: string, key: "structure" | "data") {
    setSel((s) => ({ ...s, [t]: { ...(s[t] ?? { structure: false, data: false }), [key]: !s[t]?.[key] } }));
  }
  function setAll(key: "structure" | "data", val: boolean) {
    setSel((s) => {
      const next = { ...s };
      for (const t of shown) next[t] = { ...(next[t] ?? { structure: false, data: false }), [key]: val };
      return next;
    });
  }

  const sameTarget =
    !!targetConn &&
    targetConn.params.host === sourceParams.host &&
    targetConn.params.port === sourceParams.port &&
    targetDb === sourceDb;
  const canRun = !!targetConn && !!targetDb && chosen.length > 0 && !sameTarget;

  async function run() {
    if (!targetConn || !targetDb) return;
    const id = crypto.randomUUID();
    transferId.current = id;
    cancelledRef.current = false;
    setPhase("running");
    setDump(null);
    setImp(null);
    setResultMsg(null);
    setPaused(false);

    const onDump = new Channel<DumpProgress>();
    onDump.onmessage = (m) => {
      if (m.kind === "table") setDump({ table: m.name, index: m.index, total: m.total });
      else if (m.kind === "cancelled") cancelledRef.current = true;
    };
    const onImport = new Channel<ImportProgress>();
    onImport.onmessage = (m) => {
      if (m.kind === "start") setImp({ bytes: 0, total: m.total_bytes, executed: 0, failed: 0 });
      else if (m.kind === "progress")
        setImp({ bytes: m.bytes, total: m.total_bytes, executed: m.executed, failed: m.failed });
      else if (m.kind === "cancelled") cancelledRef.current = true;
    };

    const payload = chosen.map((t) => ({
      table: t,
      structure: !!sel[t]?.structure,
      data: !!sel[t]?.data,
    }));
    try {
      const res = await api.dbTransfer(
        sourceParams,
        sourceDb,
        targetConn.params,
        targetDb,
        payload,
        continueOnError,
        id,
        onDump,
        onImport,
      );
      if (res.error) {
        setPhase("error");
        setResultMsg(res.error);
      } else if (cancelledRef.current) {
        setPhase("cancelled");
        setResultMsg("Transfer cancelled.");
      } else {
        setPhase("done");
        setResultMsg(
          `Done — ${res.executed} statement${res.executed === 1 ? "" : "s"} executed` +
            (res.failed ? `, ${res.failed} failed.` : "."),
        );
        onDone();
      }
    } catch (e) {
      setPhase("error");
      setResultMsg(String(e));
    }
  }

  async function togglePause() {
    if (!transferId.current) return;
    const next = !paused;
    setPaused(next);
    await api.dbJobControl(transferId.current, next ? "pause" : "resume").catch(() => {});
  }
  async function cancel() {
    if (!transferId.current) return;
    await api.dbJobControl(transferId.current, "cancel").catch(() => {});
  }

  const running = phase === "running";
  const impPct = imp && imp.total ? Math.min(100, Math.round((imp.bytes / imp.total) * 100)) : 0;

  return (
    <div className="pane-overlay" onClick={() => (running ? undefined : onClose())}>
      <div className="modal export-modal dt-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          Data Transfer — <code>{sourceLabel}</code> · <code>{sourceDb}</code>
        </h3>

        {phase === "setup" && (
          <>
            <div className="dt-target-row">
              <label>
                Target connection
                <select value={targetId} onChange={(e) => pickTarget(e.target.value)}>
                  <option value="">Choose a saved connection…</option>
                  {targets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || `${p.user}@${p.host}`} ({DB_ENGINES[p.engine]?.label})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Target database
                <select
                  value={targetDb}
                  disabled={!targetConn || connBusy}
                  onChange={(e) => setTargetDb(e.target.value)}
                >
                  {targetDbs.length === 0 && <option value="">—</option>}
                  {targetDbs.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {connBusy && <div className="muted dt-note">Connecting…</div>}
            {connErr && <div className="dt-note dt-err">{connErr}</div>}
            {targets.length === 0 && (
              <div className="dt-note dt-err">
                No other {DB_ENGINES[sourceEngine as keyof typeof DB_ENGINES]?.label ?? sourceEngine}{" "}
                connection saved. Add one to transfer into it.
              </div>
            )}
            {sameTarget && (
              <div className="dt-note dt-err">
                Target is the same server and database as the source — pick a different database or
                connection.
              </div>
            )}

            <div className="dt-tables">
              <div className="dt-tables-top">
                <input
                  className="dt-filter"
                  placeholder="Filter tables…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <span className="muted">
                  {chosen.length}/{tables.length} selected
                </span>
              </div>
              <div className="dt-grid-head">
                <span className="dt-col-name">Table</span>
                <label className="dt-col-check" title="Toggle structure for all shown">
                  <input
                    type="checkbox"
                    checked={allStruct}
                    onChange={(e) => setAll("structure", e.target.checked)}
                  />
                  Structure
                </label>
                <label className="dt-col-check" title="Toggle data for all shown">
                  <input
                    type="checkbox"
                    checked={allData}
                    onChange={(e) => setAll("data", e.target.checked)}
                  />
                  Data
                </label>
              </div>
              <div className="dt-grid">
                {shown.length === 0 && <div className="dt-empty muted">No tables.</div>}
                {shown.map((t) => (
                  <div className="dt-row" key={t}>
                    <span className="dt-col-name" title={t}>
                      <Icon name="table" size={12} /> {t}
                    </span>
                    <label className="dt-col-check">
                      <input
                        type="checkbox"
                        checked={!!sel[t]?.structure}
                        onChange={() => toggle(t, "structure")}
                      />
                    </label>
                    <label className="dt-col-check">
                      <input
                        type="checkbox"
                        checked={!!sel[t]?.data}
                        onChange={() => toggle(t, "data")}
                      />
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <label className="opt-check dt-coe">
              <input
                type="checkbox"
                checked={continueOnError}
                onChange={(e) => setContinueOnError(e.target.checked)}
              />
              Continue on error (skip a failing statement instead of aborting)
            </label>

            <div className="form-row end">
              <button className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button disabled={!canRun} onClick={run}>
                <Icon name="chevronRight" size={13} /> Transfer
              </button>
            </div>
          </>
        )}

        {phase !== "setup" && (
          <div className="dt-progress">
            <div className="dt-phase">
              <span className="dt-phase-label">
                {imp || phase !== "running" ? <Icon name="check" size={13} /> : "•"} Reading source
                {dump ? `: ${dump.table} (${dump.index}/${dump.total})` : "…"}
              </span>
            </div>
            {!imp && running && (
              <div className="pbar indet">
                <div className="pfill" />
              </div>
            )}
            {imp && (
              <div className="dt-phase">
                <span className="dt-phase-label">
                  {running ? "•" : <Icon name="check" size={13} />} Writing to{" "}
                  <code>{targetDb}</code> — {impPct}%
                </span>
                <div className={"pbar" + (imp.total ? "" : " indet")}>
                  <div
                    className="pfill"
                    style={imp.total ? { width: `${impPct}%` } : undefined}
                  />
                </div>
                <span className="muted dt-note">
                  {imp.executed} executed{imp.failed ? `, ${imp.failed} failed` : ""}
                </span>
              </div>
            )}
            {resultMsg && (
              <div className={"dt-note " + (phase === "error" ? "dt-err" : "dt-ok")}>{resultMsg}</div>
            )}
            <div className="form-row end">
              {running ? (
                <>
                  <button className="ghost" onClick={togglePause}>
                    {paused ? "Resume" : "Pause"}
                  </button>
                  <button className="danger-btn" onClick={cancel}>
                    Cancel
                  </button>
                </>
              ) : (
                <button onClick={onClose}>Close</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
