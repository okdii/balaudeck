import { useEffect, useState } from "react";
import { api } from "./api";
import type { DbProfile, QueryResult, SshProfile } from "./types";
import { Icon } from "./Icon";

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
}: {
  prefill?: DbProfile | null;
  sshProfiles: SshProfile[];
}) {
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("3306");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [sql, setSql] = useState("SELECT VERSION();");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [connected, setConnected] = useState(false);
  const [effHost, setEffHost] = useState("127.0.0.1");
  const [effPort, setEffPort] = useState(3306);
  const [tunnelId, setTunnelId] = useState<string | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [openDb, setOpenDb] = useState<string | null>(null);
  const [tables, setTables] = useState<Record<string, string[]>>({});

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setDatabase(prefill.database ?? "");
      disconnect();
    }
  }, [prefill]);

  function baseParams(): DbParams {
    return {
      host: effHost,
      port: effPort,
      user,
      password: password || null,
      profile_id: prefill?.id || null,
    };
  }

  async function connect() {
    setError("");
    setBusy(true);
    try {
      let h = host;
      let p = Number(port);
      let tid: string | null = null;

      if (prefill?.via_ssh_profile_id) {
        const ssh = sshProfiles.find((s) => s.id === prefill.via_ssh_profile_id);
        if (!ssh) throw new Error("SSH profile for tunnel not found");
        const t = await api.tunnelStart({
          host: ssh.host,
          port: ssh.port,
          user: ssh.user,
          auth: ssh.auth,
          profile_id: ssh.id,
          remote_host: host,
          remote_port: Number(port),
          local_port: 0,
        });
        h = "127.0.0.1";
        p = t.local_port;
        tid = t.id;
      }

      setEffHost(h);
      setEffPort(p);
      setTunnelId(tid);

      const res = await api.dbQuery(
        { host: h, port: p, user, password: password || null, profile_id: prefill?.id || null },
        "SHOW DATABASES;",
      );
      setDatabases(res.rows.map((r) => r[0] ?? "").filter(Boolean));
      setConnected(true);
    } catch (e) {
      setError(String(e));
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (tunnelId) {
      await api.tunnelStop(tunnelId).catch(() => {});
      setTunnelId(null);
    }
    setConnected(false);
    setDatabases([]);
    setTables({});
    setOpenDb(null);
  }

  async function toggleDb(db: string) {
    if (openDb === db) {
      setOpenDb(null);
      return;
    }
    setOpenDb(db);
    if (!tables[db]) {
      try {
        const res = await api.dbQuery(baseParams(), `SHOW TABLES FROM \`${db}\`;`);
        setTables({ ...tables, [db]: res.rows.map((r) => r[0] ?? "").filter(Boolean) });
      } catch (e) {
        setError(String(e));
      }
    }
  }

  async function openTable(db: string, table: string) {
    const q = `SELECT * FROM \`${db}\`.\`${table}\` LIMIT 200;`;
    setSql(q);
    await run(q, db);
  }

  async function run(sqlText?: string, db?: string) {
    setBusy(true);
    setError("");
    try {
      const res = await api.dbQuery(
        { ...baseParams(), database: db ?? (database || null) },
        sqlText ?? sql,
      );
      setResult(res);
    } catch (e) {
      setResult(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="form-row">
        <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} disabled={connected} />
        <input className="port" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} disabled={connected} />
        <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} disabled={connected} />
        <input
          type="password"
          placeholder={prefill?.id ? "password (saved)" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={connected}
        />
        {!connected ? (
          <button onClick={connect} disabled={busy}>
            <Icon name="play" size={14} /> {busy ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <button className="ghost" onClick={disconnect}>
            Disconnect
          </button>
        )}
        <span className="status">
          <span className={"dot " + (connected ? "ok" : busy ? "warn" : "idle")} />
          {connected ? (tunnelId ? `tunnel · 127.0.0.1:${effPort}` : "connected") : "disconnected"}
        </span>
      </div>

      {error && <pre className="error">{error}</pre>}

      {connected && (
        <div className="db-body">
          <div className="schema">
            {databases.map((db) => (
              <div key={db}>
                <div className="schema-db" onClick={() => toggleDb(db)}>
                  <Icon name={openDb === db ? "chevronDown" : "chevronRight"} size={13} />
                  <Icon name="database" size={14} /> {db}
                </div>
                {openDb === db &&
                  (tables[db] ?? []).map((t) => (
                    <div key={t} className="schema-table" onClick={() => openTable(db, t)}>
                      <Icon name="table" size={13} /> {t}
                    </div>
                  ))}
              </div>
            ))}
          </div>

          <div className="query-area">
            <textarea className="sql" value={sql} onChange={(e) => setSql(e.target.value)} rows={4} />
            <div className="form-row">
              <button onClick={() => run()} disabled={busy}>
                <Icon name="play" size={14} /> {busy ? "Running…" : "Run"}
              </button>
              {result && (
                <span className="status">
                  {result.rows.length} rows · {result.rows_affected} affected · {result.elapsed_ms} ms
                </span>
              )}
            </div>
            {result && (
              <div className="grid-wrap">
                <table className="grid">
                  <thead>
                    <tr>
                      {result.columns.map((c, i) => (
                        <th key={i}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci}>{cell === null ? <em className="null">NULL</em> : cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
