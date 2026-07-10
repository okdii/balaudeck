import { useEffect, useRef, useState } from "react";
import { api, type DbConnParams } from "./api";
import { openDbConnection } from "./dbConnect";
import type { DbEngine, DbProfile, SshProfile } from "./types";
import { Icon } from "./Icon";
import { EnginePicker } from "./SessionUI";
import { AskModal, type AskOptions } from "./AskModal";
import { maskText, hasPrivacyMatch } from "./privacy";
import { getSettings, subscribeSettings } from "./settings";

type RKey = { name: string; kind: string; ttl: number };

/** Redis keyspace browser + type-aware value viewer + command console. */
export function RedisPanel({
  prefill,
  sshProfiles,
  onSession,
  dcSignal,
  initialEngine,
  onEngine,
}: {
  prefill?: DbProfile | null;
  sshProfiles: SshProfile[];
  onSession?: (label: string) => void;
  dcSignal?: number;
  initialEngine?: DbEngine;
  onEngine?: (engine: DbEngine) => void;
}) {
  const [params, setParams] = useState<DbConnParams | null>(null);
  const tunnelIdRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Ad-hoc manual launcher (shown when prefill is null): engine picker + fields.
  const [engine, setEngine] = useState<DbEngine>(prefill?.engine ?? initialEngine ?? "redis");
  const [rHost, setRHost] = useState("127.0.0.1");
  const [rPort, setRPort] = useState("6379");
  const [rPassword, setRPassword] = useState("");
  const [rDbNum, setRDbNum] = useState("");
  const [rTunnel, setRTunnel] = useState("");
  const [pattern, setPattern] = useState("*");
  const [keys, setKeys] = useState<RKey[]>([]);
  const [cursor, setCursor] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [value, setValue] = useState<{ kind: string; value: string; ttl: number } | null>(null);
  const [editVal, setEditVal] = useState("");
  // A string value that contains a privacy match shows a masked read-view until
  // clicked (a textarea can't hold blur spans). Re-render on settings changes.
  const [strEditing, setStrEditing] = useState(false);
  const [, setPrivacyRev] = useState(0);
  useEffect(() => subscribeSettings(() => setPrivacyRev((n) => n + 1)), []);
  const [view, setView] = useState<"keys" | "console">("keys");
  const [cmd, setCmd] = useState("");
  const [output, setOutput] = useState<string[]>([]);
  const [ask, setAsk] = useState<AskOptions | null>(null);

  /** Open a connection (saved profile or ad-hoc ephemeral) and scan the keyspace. */
  async function runConnect(profile: DbProfile, password: string | null, label: string) {
    setBusy(true);
    setError("");
    let tunnelId: string | null = null;
    try {
      const { params: p, tunnelId: tid } = await openDbConnection(profile, sshProfiles, password);
      tunnelId = tid;
      const res = await api.redisScan(p, "*", 0, 200);
      tunnelIdRef.current = tunnelId;
      setParams(p);
      setKeys(res.keys);
      setCursor(res.cursor);
      setConnected(true);
      onSession?.(label);
    } catch (e) {
      // A tunnel that opened but was never recorded in the ref would leak —
      // stop it here so failed connects don't stack orphaned tunnels.
      if (tunnelId) await api.tunnelStop(tunnelId).catch(() => {});
      setError(String(e));
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  /** Connect the saved profile (keychain password via profile_id). */
  async function connect() {
    if (!prefill) return;
    await runConnect(prefill, null, prefill.name || `${prefill.host}:${prefill.port}`);
  }

  /** Connect from the ad-hoc manual form with the typed password inline. */
  async function manualConnect() {
    const ephemeral: DbProfile = {
      id: "",
      name: "",
      engine: "redis",
      host: rHost,
      port: Number(rPort),
      user: "",
      database: rDbNum || null,
      file: null,
      region: null,
      path_style: null,
      tls: null,
      via_ssh_profile_id: rTunnel || null,
      folder_id: null,
    };
    await runConnect(ephemeral, rPassword || null, `${rHost}:${rPort}`);
  }

  /** Manual engine picker: switch panes if the user picks another family. */
  function pickEngine(e: DbEngine) {
    if (e === "redis") setEngine(e);
    else onEngine?.(e);
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

  // Auto-connect a saved profile on mount; ad-hoc mode waits for the manual
  // form. Tear the tunnel down on unmount either way.
  useEffect(() => {
    if (prefill) connect();
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
    setStrEditing(false);
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

  function deleteKey() {
    if (!params || !sel) return;
    const key = sel;
    setAsk({
      title: "Delete key",
      label: `Permanently delete "${key}"? This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
      run: async () => {
        setBusy(true);
        try {
          await api.redisDel(params, key);
          setSel(null);
          setValue(null);
          await scan(true);
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function setTtl() {
    if (!params || !sel) return;
    const key = sel;
    setAsk({
      title: "Set TTL",
      label: `Seconds until "${key}" expires. Leave empty or -1 to clear the expiry.`,
      initial: "",
      confirmText: "Apply",
      run: async (s) => {
        const secs = s.trim() === "" ? -1 : Number(s);
        if (Number.isNaN(secs)) {
          setError("TTL must be a number.");
          return;
        }
        setBusy(true);
        try {
          await api.redisExpire(params, key, secs);
          await openKey(key);
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      },
    });
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
    // Saved-profile pane: keep the simple auto/Connect card.
    if (prefill) {
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
    // Ad-hoc pane: manual launcher with an engine picker and connection fields.
    return (
      <div className="panel">
        <div className="launcher">
          <div className="launcher-card">
            <div className="launcher-head">
              <Icon name="database" size={22} />
              <h3>Connect Redis</h3>
            </div>
            <EnginePicker value={engine} onChange={pickEngine} />
            <div className="form-row">
              <input placeholder="host" value={rHost} onChange={(e) => setRHost(e.target.value)} />
              <input
                className="port"
                placeholder="port"
                value={rPort}
                onChange={(e) => setRPort(e.target.value)}
              />
            </div>
            <div className="form-row">
              <input
                type="password"
                placeholder="password (optional)"
                value={rPassword}
                onChange={(e) => setRPassword(e.target.value)}
              />
              <input
                placeholder="database number (optional)"
                value={rDbNum}
                onChange={(e) => setRDbNum(e.target.value)}
              />
            </div>
            <label className="tunnel-select">
              <span>
                <Icon name="tunnel" size={13} /> Connect through SSH tunnel
              </span>
              <select value={rTunnel} onChange={(e) => setRTunnel(e.target.value)}>
                <option value="">— direct connection —</option>
                {sshProfiles.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || `${s.user}@${s.host}`}
                  </option>
                ))}
              </select>
            </label>
            {error && <pre className="error">{error}</pre>}
            <button onClick={manualConnect} disabled={busy}>
              <Icon name="play" size={14} /> {busy ? "Connecting…" : "Connect"}
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
                getSettings().privacyOn && hasPrivacyMatch(editVal) && !strEditing ? (
                  <pre
                    className="mongo-doc redis-str-view"
                    title="Click to edit"
                    onClick={() => setStrEditing(true)}
                  >
                    {maskText(editVal)}
                  </pre>
                ) : (
                  <textarea
                    className="redis-edit"
                    autoFocus={strEditing}
                    value={editVal}
                    onChange={(e) => setEditVal(e.target.value)}
                    onBlur={() => setStrEditing(false)}
                  />
                )
              ) : (
                <pre className="mongo-doc">{maskText(value.value)}</pre>
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
            <pre className="redis-console">{maskText(output.join("\n"))}</pre>
          </>
        )}
      </div>
      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}
    </div>
  );
}
