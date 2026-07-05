import { useEffect, useRef, useState } from "react";
import { api, type DbConnParams } from "./api";
import { openDbConnection } from "./dbConnect";
import type { DbProfile, SshProfile } from "./types";
import { Icon } from "./Icon";

type RKey = { name: string; kind: string; ttl: number };

/** Redis keyspace browser + type-aware value viewer + command console. */
export function RedisPanel({
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
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<RKey[]>([]);
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [value, setValue] = useState<{ kind: string; value: string; ttl: number } | null>(null);
  const [editVal, setEditVal] = useState("");
  const [view, setView] = useState<"keys" | "console">("keys");
  const [cmd, setCmd] = useState("");
  const [output, setOutput] = useState<string[]>([]);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const { params: p, tunnelId } = await openDbConnection(prefill, sshProfiles);
      const res = await api.redisScan(p, "*", 0, 200);
      tunnelIdRef.current = tunnelId;
      setParams(p);
      setKeys(res.keys);
      setCursor(res.cursor);
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
    setKeys([]);
    setSel(null);
    setValue(null);
  }

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

  async function scan(reset: boolean) {
    if (!params) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.redisScan(params, pattern, reset ? 0 : cursor, 200);
      setKeys((k) => (reset ? res.keys : [...k, ...res.keys]));
      setCursor(res.cursor);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openKey(name: string) {
    if (!params) return;
    setSel(name);
    setBusy(true);
    try {
      const v = await api.redisGet(params, name);
      const k = keys.find((x) => x.name === name);
      setValue({ ...v, ttl: k?.ttl ?? -1 });
      setEditVal(v.value);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveString() {
    if (!params || !sel) return;
    setBusy(true);
    setError("");
    try {
      await api.redisSet(params, sel, editVal);
      await openKey(sel);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteKey() {
    if (!params || !sel) return;
    setBusy(true);
    try {
      await api.redisDel(params, sel);
      setSel(null);
      setValue(null);
      await scan(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setTtl() {
    if (!params || !sel) return;
    const s = window.prompt("TTL in seconds (empty or -1 to clear):", "");
    if (s === null) return;
    const secs = s.trim() === "" ? -1 : Number(s);
    if (Number.isNaN(secs)) return;
    setBusy(true);
    try {
      await api.redisExpire(params, sel, secs);
      await openKey(sel);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runCommand() {
    if (!params || !cmd.trim()) return;
    const argv = cmd.trim().split(/\s+/);
    setBusy(true);
    try {
      const out = await api.redisCommand(params, argv);
      setOutput((o) => [...o, `> ${cmd}`, out]);
      setCmd("");
    } catch (e) {
      setOutput((o) => [...o, `> ${cmd}`, `ERR ${e}`]);
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <div className="panel">
        <div className="launcher">
          <div className="launcher-card">
            <h3>
              <Icon name="database" size={16} /> {prefill.name || "Redis"}
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
        <div className="form-row">
          <input
            className="grow"
            placeholder="match, e.g. user:*"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && scan(true)}
          />
          <button className="ghost" onClick={() => scan(true)} disabled={busy}>
            Scan
          </button>
        </div>
        <div className="redis-keys">
          {keys.map((k) => (
            <div
              key={k.name}
              className={"schema-item" + (sel === k.name ? " active" : "")}
              onClick={() => openKey(k.name)}
              title={`${k.kind}${k.ttl >= 0 ? ` · ttl ${k.ttl}s` : ""}`}
            >
              <span className="redis-kind">{k.kind}</span> {k.name}
            </div>
          ))}
          {cursor !== 0 && (
            <button className="ghost" onClick={() => scan(false)} disabled={busy}>
              Load more…
            </button>
          )}
          {keys.length === 0 && !busy && <p className="empty">No keys.</p>}
        </div>
      </div>

      <div className="query-area">
        <div className="seg">
          <button className={view === "keys" ? "on" : ""} onClick={() => setView("keys")}>
            Value
          </button>
          <button className={view === "console" ? "on" : ""} onClick={() => setView("console")}>
            Console
          </button>
        </div>
        {error && <pre className="error">{error}</pre>}
        {view === "keys" ? (
          value && sel ? (
            <>
              <div className="mongo-meta">
                {sel} · {value.kind}
                {value.ttl >= 0 ? ` · ttl ${value.ttl}s` : " · no expiry"}
              </div>
              {value.kind === "string" ? (
                <textarea
                  className="redis-edit"
                  value={editVal}
                  onChange={(e) => setEditVal(e.target.value)}
                />
              ) : (
                <pre className="mongo-doc">{value.value}</pre>
              )}
              <div className="form-row end">
                <button className="ghost" onClick={setTtl} disabled={busy}>
                  TTL…
                </button>
                <button className="ghost danger-btn" onClick={deleteKey} disabled={busy}>
                  Delete key
                </button>
                {value.kind === "string" && (
                  <button onClick={saveString} disabled={busy || editVal === value.value}>
                    <Icon name="save" size={13} /> Save
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="empty">Select a key on the left.</p>
          )
        ) : (
          <>
            <div className="form-row">
              <input
                className="grow"
                placeholder="command, e.g. GET user:1"
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runCommand()}
              />
              <button onClick={runCommand} disabled={busy}>
                Run
              </button>
            </div>
            <pre className="redis-console">{output.join("\n")}</pre>
          </>
        )}
      </div>
    </div>
  );
}
