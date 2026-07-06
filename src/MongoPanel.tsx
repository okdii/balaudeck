import { useEffect, useRef, useState } from "react";
import { api, type DbConnParams } from "./api";
import { openDbConnection } from "./dbConnect";
import type { DbProfile, SshProfile } from "./types";
import { Icon } from "./Icon";
import { AskModal, type AskOptions } from "./AskModal";
import { maskText } from "./privacy";
import { subscribeSettings } from "./settings";

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
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newText, setNewText] = useState("{\n  \n}");
  const [ask, setAsk] = useState<AskOptions | null>(null);
  // Re-render on privacy-settings changes so masked docs update live.
  const [, setPrivacyRev] = useState(0);
  useEffect(() => subscribeSettings(() => setPrivacyRev((n) => n + 1)), []);

  /** Extract the ObjectId hex from a displayed document's `_id`, if any. */
  function docId(json: string): string | null {
    try {
      const o = JSON.parse(json);
      return typeof o?._id?.$oid === "string" ? o._id.$oid : null;
    } catch {
      return null;
    }
  }

  function deleteDoc(json: string) {
    if (!params || !sel) return;
    const id = docId(json);
    if (!id) {
      setError("This document has no ObjectId _id — can't delete from the UI.");
      return;
    }
    const target = sel;
    setAsk({
      title: "Delete document",
      label: `Permanently delete document _id ${id}? This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
      run: async () => {
        setBusy(true);
        setError("");
        try {
          await api.mongoDelete(params, target.db, target.coll, id);
          await runFind(target.db, target.coll, filter);
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function saveDoc(origJson: string) {
    if (!params || !sel) return;
    const id = docId(origJson);
    if (!id) {
      setError("This document has no ObjectId _id — can't replace it.");
      return;
    }
    // The displayed JSON renders _id as {"$oid": "..."} (MongoDB extended JSON),
    // which the backend's plain-JSON parser rejects. Drop _id here (the replace
    // filter re-applies it by id) so the body is plain JSON the backend can read.
    let body = editText;
    try {
      const o = JSON.parse(editText);
      delete o._id;
      body = JSON.stringify(o);
    } catch {
      // Leave body untouched; the backend surfaces the JSON error.
    }
    setBusy(true);
    setError("");
    try {
      await api.mongoReplace(params, sel.db, sel.coll, id, body);
      setEditIdx(null);
      await runFind(sel.db, sel.coll, filter);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function insertDoc() {
    if (!params || !sel) return;
    setBusy(true);
    setError("");
    try {
      await api.mongoInsert(params, sel.db, sel.coll, newText);
      setNewOpen(false);
      setNewText("{\n  \n}");
      await runFind(sel.db, sel.coll, filter);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

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
              <button className="ghost" onClick={() => setNewOpen((v) => !v)}>
                <Icon name="plus" size={13} /> New
              </button>
            </div>
            {error && <pre className="error">{error}</pre>}
            <div className="mongo-meta">
              {sel.db}.{sel.coll} · {docs.length} shown
              {count !== null ? ` of ${count}` : ""}
            </div>
            <div className="mongo-docs">
              {newOpen && (
                <div className="mongo-doc-edit">
                  <textarea
                    className="redis-edit"
                    value={newText}
                    onChange={(e) => setNewText(e.target.value)}
                  />
                  <div className="form-row end">
                    <button className="ghost" onClick={() => setNewOpen(false)}>
                      Cancel
                    </button>
                    <button onClick={insertDoc} disabled={busy}>
                      Insert
                    </button>
                  </div>
                </div>
              )}
              {docs.map((d, i) =>
                editIdx === i ? (
                  <div key={i} className="mongo-doc-edit">
                    <textarea
                      className="redis-edit"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                    />
                    <div className="form-row end">
                      <button className="ghost" onClick={() => setEditIdx(null)}>
                        Cancel
                      </button>
                      <button onClick={() => saveDoc(d)} disabled={busy}>
                        <Icon name="save" size={13} /> Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="mongo-doc-wrap">
                    <pre className="mongo-doc">{maskText(d)}</pre>
                    <div className="mongo-doc-actions">
                      <button
                        className="icon"
                        title="Edit"
                        onClick={() => {
                          setEditIdx(i);
                          setEditText(d);
                        }}
                      >
                        <Icon name="edit" size={13} />
                      </button>
                      <button className="icon" title="Delete" onClick={() => deleteDoc(d)}>
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </div>
                ),
              )}
              {docs.length === 0 && !busy && !newOpen && <p className="empty">No documents.</p>}
            </div>
          </>
        ) : (
          <p className="empty">Select a collection on the left.</p>
        )}
      </div>
      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}
    </div>
  );
}
