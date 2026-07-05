import { useEffect, useRef, useState } from "react";
import { api, type DbConnParams } from "./api";
import { openDbConnection } from "./dbConnect";
import type { DbProfile, SshProfile } from "./types";
import { Icon } from "./Icon";

/** MongoDB document browser: databases → collections → find → JSON documents. */
export function MongoPanel({
  prefill,
  sshProfiles,
  onSession,
  dcSignal,
}: {
  prefill: DbProfile;
  sshProfiles: SshProfile[];
  onSession?: (label: string) => void;
  dcSignal?: number;
}) {
  const [params, setParams] = useState<DbConnParams | null>(null);
  const tunnelIdRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [databases, setDatabases] = useState<string[]>([]);
  const [expandedDb, setExpandedDb] = useState<string | null>(null);
  const [collections, setCollections] = useState<Record<string, string[]>>({});
  const [sel, setSel] = useState<{ db: string; coll: string } | null>(null);
  const [filter, setFilter] = useState("{}");
  const [docs, setDocs] = useState<string[]>([]);
  const [count, setCount] = useState<number | null>(null);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const { params: p, tunnelId } = await openDbConnection(prefill, sshProfiles);
      const dbs = await api.mongoDatabases(p);
      tunnelIdRef.current = tunnelId;
      setParams(p);
      setDatabases(dbs);
      setConnected(true);
      onSession?.(prefill.name || `${prefill.host}:${prefill.port}`);
    } catch (e) {
      setError(String(e));
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    const tid = tunnelIdRef.current;
    if (tid) await api.tunnelStop(tid).catch(() => {});
    tunnelIdRef.current = null;
    setConnected(false);
    setDatabases([]);
    setCollections({});
    setSel(null);
    setDocs([]);
  }

  // Connect on mount; tear the tunnel down on unmount.
  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (dcSignal) disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dcSignal]);

  async function toggleDb(db: string) {
    if (expandedDb === db) {
      setExpandedDb(null);
      return;
    }
    setExpandedDb(db);
    if (!collections[db] && params) {
      try {
        const cols = await api.mongoCollections(params, db);
        setCollections((c) => ({ ...c, [db]: cols }));
      } catch (e) {
        setError(String(e));
      }
    }
  }

  async function runFind(db: string, coll: string, f: string) {
    if (!params) return;
    setBusy(true);
    setError("");
    try {
      const [d, c] = await Promise.all([
        api.mongoFind(params, db, coll, f, 200),
        api.mongoCount(params, db, coll, f).catch(() => null),
      ]);
      setDocs(d);
      setCount(c);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function openColl(db: string, coll: string) {
    setSel({ db, coll });
    setFilter("{}");
    runFind(db, coll, "{}");
  }

  if (!connected) {
    return (
      <div className="panel">
        <div className="launcher">
          <div className="launcher-card">
            <h3>
              <Icon name="database" size={16} /> {prefill.name || "MongoDB"}
            </h3>
            {error && <pre className="error">{error}</pre>}
            <button onClick={connect} disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="panel db-body">
      <div className="schema">
        {databases.map((db) => (
          <div key={db}>
            <div className="schema-db" onClick={() => toggleDb(db)}>
              <Icon name={expandedDb === db ? "chevronDown" : "chevronRight"} size={13} />
              <Icon name="database" size={14} /> {db}
            </div>
            {expandedDb === db && (
              <div className="schema-cats">
                {(collections[db] ?? []).map((coll) => (
                  <div
                    key={coll}
                    className={
                      "schema-item" + (sel?.db === db && sel?.coll === coll ? " active" : "")
                    }
                    onClick={() => openColl(db, coll)}
                  >
                    <Icon name="table" size={13} /> {coll}
                  </div>
                ))}
                {collections[db] && collections[db].length === 0 && (
                  <div className="schema-item null">no collections</div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="query-area">
        {sel ? (
          <>
            <div className="form-row">
              <input
                className="grow"
                placeholder='find filter, e.g. {"qty":{"$gt":100}}'
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runFind(sel.db, sel.coll, filter)}
              />
              <button onClick={() => runFind(sel.db, sel.coll, filter)} disabled={busy}>
                <Icon name="play" size={13} /> Find
              </button>
            </div>
            {error && <pre className="error">{error}</pre>}
            <div className="mongo-meta">
              {sel.db}.{sel.coll} · {docs.length} shown
              {count !== null ? ` of ${count}` : ""}
            </div>
            <div className="mongo-docs">
              {docs.map((d, i) => (
                <pre key={i} className="mongo-doc">
                  {d}
                </pre>
              ))}
              {docs.length === 0 && !busy && <p className="empty">No documents.</p>}
            </div>
          </>
        ) : (
          <p className="empty">Select a collection on the left.</p>
        )}
      </div>
    </div>
  );
}
