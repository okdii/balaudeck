import { useEffect, useState } from "react";
import { api } from "./api";
import type { SshProfile, TunnelInfo } from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon } from "./Icon";

export function TunnelPanel({ sshProfiles }: { sshProfiles: SshProfile[] }) {
  const [profileId, setProfileId] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<AuthValue>(emptyAuth());
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("3306");
  const [localPort, setLocalPort] = useState("0");
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [error, setError] = useState("");

  async function refresh() {
    setTunnels(await api.tunnelList());
  }

  useEffect(() => {
    refresh();
  }, []);

  function pickProfile(id: string) {
    setProfileId(id);
    const p = sshProfiles.find((s) => s.id === id);
    if (p) {
      setHost(p.host);
      setPort(String(p.port));
      setUser(p.user);
      setAuth({ ...emptyAuth(), auth: p.auth });
    }
  }

  async function start() {
    setError("");
    try {
      await api.tunnelStart({
        host,
        port: Number(port),
        user,
        auth: auth.auth,
        password: auth.password || null,
        key: auth.key || null,
        passphrase: auth.passphrase || null,
        profile_id: profileId || null,
        remote_host: remoteHost,
        remote_port: Number(remotePort),
        local_port: Number(localPort) || 0,
      });
      setAuth({ ...emptyAuth(), auth: auth.auth });
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function stop(id: string) {
    await api.tunnelStop(id);
    refresh();
  }

  return (
    <div className="panel">
      <div className="form-row">
        <select value={profileId} onChange={(e) => pickProfile(e.target.value)}>
          <option value="">— SSH profile / manual —</option>
          {sshProfiles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name || `${s.user}@${s.host}`}
            </option>
          ))}
        </select>
        <input placeholder="ssh host" value={host} onChange={(e) => setHost(e.target.value)} />
        <input className="port" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
        <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
      </div>
      <AuthFields value={auth} onChange={setAuth} saved={!!profileId} />
      <div className="form-row">
        <input placeholder="remote host" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} />
        <input
          className="port"
          placeholder="remote port"
          value={remotePort}
          onChange={(e) => setRemotePort(e.target.value)}
        />
        <input
          className="port"
          placeholder="local port (0=auto)"
          value={localPort}
          onChange={(e) => setLocalPort(e.target.value)}
        />
        <button onClick={start}>
          <Icon name="tunnel" size={14} /> Start tunnel
        </button>
      </div>
      {error && <pre className="error">{error}</pre>}
      <div className="grid-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Local</th>
              <th>→ Remote</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tunnels.map((t) => (
              <tr key={t.id}>
                <td>127.0.0.1:{t.local_port}</td>
                <td>
                  {t.remote_host}:{t.remote_port}
                </td>
                <td>
                  <button className="icon" onClick={() => stop(t.id)}>
                    Stop
                  </button>
                </td>
              </tr>
            ))}
            {tunnels.length === 0 && (
              <tr>
                <td colSpan={3} className="null">
                  No active tunnels
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
