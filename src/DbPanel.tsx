import { useEffect, useState } from "react";
import { api } from "./api";
import type { DbProfile, QueryResult } from "./types";

export function DbPanel({ prefill }: { prefill?: DbProfile | null }) {
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("3306");
  const [user, setUser] = useState("root");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [sql, setSql] = useState("SELECT VERSION();");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setDatabase(prefill.database ?? "");
    }
  }, [prefill]);

  async function run() {
    setBusy(true);
    setError("");
    try {
      const res = await api.dbQuery(
        { host, port: Number(port), user, password, database: database || null },
        sql,
      );
      setResult(res);
    } catch (err) {
      setResult(null);
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="form-row">
        <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
        <input className="port" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
        <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input placeholder="database" value={database} onChange={(e) => setDatabase(e.target.value)} />
      </div>
      <textarea className="sql" value={sql} onChange={(e) => setSql(e.target.value)} rows={4} />
      <div className="form-row">
        <button onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run"}
        </button>
        {result && (
          <span className="status">
            {result.rows.length} rows · {result.rows_affected} affected · {result.elapsed_ms} ms
          </span>
        )}
      </div>
      {error && <pre className="error">{error}</pre>}
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
  );
}
