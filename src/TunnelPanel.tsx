import { useEffect, useState } from "react";
import { api } from "./api";
import { resolveJump, type SshProfile, type TunnelInfo, type TunnelProfile } from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon } from "./Icon";

export function TunnelPanel({
  tunnelProfiles = [],
  sshProfiles,
  prefill,
  sshPrefill,
}: {
  tunnelProfiles?: TunnelProfile[];
  sshProfiles: SshProfile[];
  prefill?: TunnelProfile | null;
  sshPrefill?: SshProfile | null;
}) {
  const [tunnelId, setTunnelId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [jumpProfileId, setJumpProfileId] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<AuthValue>(emptyAuth());
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("3306");
  const [localPort, setLocalPort] = useState("0");
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(sshProfiles.length === 0);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setTunnels(await api.tunnelList());
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (prefill?.id) {
      pickTunnel(prefill.id);
    } else if (sshPrefill) {
      setJumpProfileId(sshPrefill.jump_profile_id ?? null);
      if (sshPrefill.id) {
        pickProfile(sshPrefill.id);
      } else {
        setHost(sshPrefill.host);
        setPort(String(sshPrefill.port));
        setUser(sshPrefill.user);
        setAuth({ ...emptyAuth(), auth: sshPrefill.auth });
        setManual(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, sshPrefill]);

  function pickTunnel(id: string) {
    setTunnelId(id);
    const t = tunnelProfiles.find((x) => x.id === id);
    if (!t) return;
    setProfileId(id); // secrets are keyed by the tunnel profile id
    setJumpProfileId(t.jump_profile_id ?? null);
    setHost(t.host);
    setPort(String(t.port));
    setUser(t.user);
    setAuth({ ...emptyAuth(), auth: t.auth });
    setRemoteHost(t.remote_host);
    setRemotePort(String(t.remote_port));
    setLocalPort(String(t.local_port ?? 0));
  }

  function pickProfile(id: string) {
    setProfileId(id);
    setTunnelId("");
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
    setBusy(true);
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
        jump: resolveJump(jumpProfileId, sshProfiles),
        remote_host: remoteHost,
        remote_port: Number(remotePort),
        local_port: Number(localPort) || 0,
      });
      setAuth({ ...emptyAuth(), auth: auth.auth });
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop(id: string) {
    await api.tunnelStop(id);
    refresh();
  }

  return (
    <div className="panel tunnel-panel">
      <div className="launcher-card tunnel-card">
        <div className="launcher-head">
          <Icon name="tunnel" size={22} />
          <h3>New tunnel</h3>
        </div>

        {tunnelProfiles.length > 0 && (
          <div className="launcher-presets">
            <select value={tunnelId} onChange={(e) => pickTunnel(e.target.value)}>
              <option value="">Choose a saved tunnel…</option>
              {tunnelProfiles.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name || `${t.user}@${t.host}`} → {t.remote_host}:{t.remote_port}
                </option>
              ))}
            </select>
          </div>
        )}

        {sshProfiles.length > 0 && (
          <div className="launcher-presets">
            <select value={profileId} onChange={(e) => pickProfile(e.target.value)}>
              <option value="">Choose a saved SSH host…</option>
              {sshProfiles.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || `${s.user}@${s.host}`}
                </option>
              ))}
            </select>
          </div>
        )}

        <button className="launcher-toggle" onClick={() => setManual((v) => !v)}>
          <Icon name={manual ? "chevronDown" : "chevronRight"} size={14} />
          Manual SSH connection
        </button>
        {manual && (
          <div className="launcher-manual">
            <div className="form-row">
              <input placeholder="ssh host" value={host} onChange={(e) => setHost(e.target.value)} />
              <input className="port" placeholder="port" value={port} onChange={(e) => setPort(e.target.value)} />
              <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
            </div>
            <AuthFields value={auth} onChange={setAuth} saved={!!profileId} />
          </div>
        )}

        <div className="tunnel-target">
          <label>
            Remote target <small>— host:port reachable from the SSH server</small>
            <div className="form-row">
              <input placeholder="remote host" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} />
              <input className="port" placeholder="port" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} />
            </div>
          </label>
          <label>
            Local port <small>— port on this machine; 0 = auto</small>
            <input className="port" placeholder="0" value={localPort} onChange={(e) => setLocalPort(e.target.value)} />
          </label>
        </div>

        <div className="tunnel-preview">
          <code>127.0.0.1:{localPort === "0" || !localPort ? "auto" : localPort}</code>
          <Icon name="tunnel" size={13} />
          <code>
            {remoteHost || "host"}:{remotePort || "port"}
          </code>
        </div>

        <button onClick={start} disabled={busy}>
          <Icon name="tunnel" size={14} /> {busy ? "Starting…" : "Start tunnel"}
        </button>

        {error && <pre className="error">{error}</pre>}
      </div>

      <div className="tunnel-active">
        <div className="section-head">
          <span>Active tunnels</span>
        </div>
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
                  <td className="row-actions">
                    <button className="btn-disconnect btn-sm" onClick={() => stop(t.id)}>
                      <Icon name="power" size={13} /> Stop
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
    </div>
  );
}
