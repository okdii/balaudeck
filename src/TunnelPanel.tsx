import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { resolveJump, type SshProfile, type TunnelInfo, type TunnelProfile } from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon } from "./Icon";
import { AskModal, type AskOptions } from "./AskModal";
import { copyToClipboard } from "./clipboard";
import { TunnelDiagram, type TunnelRoute } from "./TunnelDiagram";

export function TunnelPanel({
  tunnelProfiles = [],
  sshProfiles,
  prefill,
  sshPrefill,
  openSignal,
}: {
  tunnelProfiles?: TunnelProfile[];
  sshProfiles: SshProfile[];
  prefill?: TunnelProfile | null;
  sshPrefill?: SshProfile | null;
  /** Bumped by the parent to (re)open the New-tunnel modal on this single
   *  Tunnels page — e.g. when the user picks a saved tunnel or clicks Tunnel. */
  openSignal?: number;
}) {
  const [tunnelId, setTunnelId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [jumpSource, setJumpSource] = useState<SshProfile | TunnelProfile | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<AuthValue>(emptyAuth());
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState("3306");
  const [localPort, setLocalPort] = useState("0");
  const [mode, setMode] = useState("local");
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([]);
  const [error, setError] = useState("");
  const [ask, setAsk] = useState<AskOptions | null>(null);
  const [manual, setManual] = useState(sshProfiles.length === 0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  // The New-tunnel form is a modal over the Active-tunnels page; it closes once
  // a tunnel starts, leaving only the live topology.
  const [showForm, setShowForm] = useState(false);

  async function refresh() {
    setTunnels(await api.tunnelList());
  }

  useEffect(() => {
    refresh();
    // Poll so the list reflects the shared backend state — tunnels can be
    // started elsewhere (e.g. the DB client's "connect through SSH tunnel").
    const timer = setInterval(refresh, 2500);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (prefill?.id) {
      pickTunnel(prefill.id);
    } else if (sshPrefill) {
      setJumpSource(sshPrefill);
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

  // Open the modal when the parent signals a tunnel action. 0 (the initial /
  // restored value) never opens it, so a restored Tunnels tab shows only the
  // active list rather than popping the form on relaunch.
  useEffect(() => {
    if (openSignal && openSignal > 0) setShowForm(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSignal]);

  function pickTunnel(id: string) {
    setTunnelId(id);
    const t = tunnelProfiles.find((x) => x.id === id);
    if (!t) return;
    setRemoteHost(t.remote_host);
    setRemotePort(String(t.remote_port));
    setLocalPort(String(t.local_port ?? 0));
    setMode(t.mode ?? "local");
    // Forward through a referenced saved SSH host (with its own jump) when set,
    // otherwise use the tunnel's own inline SSH credentials.
    const ssh = t.ssh_profile_id ? sshProfiles.find((s) => s.id === t.ssh_profile_id) : undefined;
    if (ssh) {
      setProfileId(ssh.id);
      setHost(ssh.host);
      setPort(String(ssh.port));
      setUser(ssh.user);
      setAuth({ ...emptyAuth(), auth: ssh.auth });
      setJumpSource(ssh);
    } else {
      setProfileId(t.id);
      setHost(t.host);
      setPort(String(t.port));
      setUser(t.user);
      setAuth({ ...emptyAuth(), auth: t.auth });
      setJumpSource(t);
    }
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
      const info = await api.tunnelStart({
        host,
        port: Number(port),
        user,
        auth: auth.auth,
        password: auth.password || null,
        key: auth.key || null,
        passphrase: auth.passphrase || null,
        profile_id: profileId || null,
        jump: resolveJump(jumpSource, sshProfiles),
        mode,
        remote_host: remoteHost,
        remote_port: Number(remotePort),
        local_port: Number(localPort) || 0,
      });
      // Show it immediately from the command's own result so it never depends on
      // the timing of a follow-up list fetch; the poll then reconciles.
      setTunnels((prev) => [info, ...prev.filter((t) => t.id !== info.id)]);
      setAuth({ ...emptyAuth(), auth: auth.auth });
      // Connected — close the form; the live topology on the page takes over.
      setShowForm(false);
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

  /** The equivalent OpenSSH command for the current form — copy/paste runnable.
   * `-N` = just forward, don't run a remote shell (Ctrl-C to stop). */
  function sshCommand(): string {
    const parts = ["ssh", "-N"];
    if (port && port !== "22") parts.push(`-p ${port}`);
    const jump = resolveJump(jumpSource, sshProfiles);
    if (jump?.host) {
      const ju = jump.user ? `${jump.user}@` : "";
      const jp = jump.port && jump.port !== 22 ? `:${jump.port}` : "";
      parts.push(`-J ${ju}${jump.host}${jp}`);
    }
    if (auth.auth === "key") parts.push("-i <path/to/private-key>");
    const rh = remoteHost.trim() || "127.0.0.1";
    if (mode === "local") {
      const rp = remotePort.trim() || "PORT";
      const lp = localPort && localPort !== "0" ? localPort : rp;
      parts.push(`-L ${lp}:${rh}:${rp}`);
    } else if (mode === "dynamic") {
      parts.push(`-D ${localPort && localPort !== "0" ? localPort : "1080"}`);
    } else {
      const bind = remotePort && remotePort !== "0" ? remotePort : "0";
      parts.push(`-R ${bind}:${rh}:${localPort.trim() || "PORT"}`);
    }
    parts.push(`${user.trim() || "user"}@${host.trim() || "host"}`);
    return parts.join(" ");
  }

  async function copyCmd() {
    try {
      await copyToClipboard(sshCommand());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the text is selectable to copy manually */
    }
  }

  // ---- topology diagram data ----
  const previewServer = `${user.trim() || "user"}@${host.trim() || "host"}`;
  const previewVia = resolveJump(jumpSource, sshProfiles)?.host || null;
  const previewRoute: TunnelRoute = (() => {
    const lp = localPort === "0" || !localPort ? "auto" : localPort;
    if (mode === "dynamic") return { mode, source: `socks5://127.0.0.1:${lp}`, target: "anywhere" };
    if (mode === "remote")
      return {
        mode,
        source: `server:${remotePort && remotePort !== "0" ? remotePort : "auto"}`,
        target: `${remoteHost || "127.0.0.1"}:${localPort || "port"}`,
      };
    return { mode, source: `127.0.0.1:${lp}`, target: `${remoteHost || "host"}:${remotePort || "port"}` };
  })();

  function toRoute(t: TunnelInfo): TunnelRoute {
    if (t.mode === "dynamic") return { id: t.id, mode: t.mode, active: true, source: `socks5://127.0.0.1:${t.local_port}`, target: "anywhere" };
    if (t.mode === "remote") return { id: t.id, mode: t.mode, active: true, source: `server:${t.local_port}`, target: `${t.remote_host}:${t.remote_port}` };
    return { id: t.id, mode: t.mode, active: true, source: `127.0.0.1:${t.local_port}`, target: `${t.remote_host}:${t.remote_port}` };
  }

  // Group active tunnels by the SSH server they run through — each server is one
  // hub node with its routes fanning in, like a Cloudflare tunnel's routes.
  const groups = useMemo(() => {
    const m = new Map<string, TunnelInfo[]>();
    for (const t of tunnels) {
      const key = t.ssh_host ? `${t.ssh_user ? `${t.ssh_user}@` : ""}${t.ssh_host}` : "SSH server";
      const arr = m.get(key);
      if (arr) arr.push(t);
      else m.set(key, [t]);
    }
    return [...m.entries()];
  }, [tunnels]);

  function confirmStop(r: TunnelRoute) {
    setAsk({
      title: "Stop tunnel",
      label: `Stop the tunnel ${r.source}? The forwarded connection will close.`,
      confirmText: "Stop",
      danger: true,
      run: () => stop(r.id!),
    });
  }

  return (
    <div className="panel tunnel-panel">
      <div className="tunnel-active">
        <div className="section-head">
          <span>Active tunnels</span>
          <button className="td-new-btn" onClick={() => setShowForm(true)}>
            <Icon name="plus" size={13} /> New tunnel
          </button>
        </div>
        {tunnels.length === 0 ? (
          <div className="tunnel-empty">
            <Icon name="tunnel" size={26} />
            <div className="null">No active tunnels yet.</div>
            <button className="td-new-btn" onClick={() => setShowForm(true)}>
              <Icon name="plus" size={13} /> New tunnel
            </button>
          </div>
        ) : (
          groups.map(([server, list]) => (
            <div className="tunnel-group" key={server}>
              <TunnelDiagram server={server} routes={list.map(toRoute)} onRouteAction={confirmStop} actionLabel="Stop" />
            </div>
          ))
        )}
      </div>

      {showForm && (
        <div className="pane-overlay" onClick={() => (busy ? undefined : setShowForm(false))}>
          <div className="modal tunnel-modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              <Icon name="tunnel" size={16} /> New tunnel
            </h3>

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

            <label>
              Tunnel type
              <div className="seg tunnel-mode">
                <button type="button" className={mode === "local" ? "on" : ""} onClick={() => setMode("local")}>
                  Local <small>-L</small>
                </button>
                <button type="button" className={mode === "dynamic" ? "on" : ""} onClick={() => setMode("dynamic")}>
                  Dynamic <small>-D</small>
                </button>
                <button type="button" className={mode === "remote" ? "on" : ""} onClick={() => setMode("remote")}>
                  Remote <small>-R</small>
                </button>
              </div>
            </label>

            {mode === "local" && (
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
            )}

            {mode === "dynamic" && (
              <div className="tunnel-target">
                <label>
                  Local SOCKS port <small>— SOCKS5 proxy on this machine; 0 = auto</small>
                  <input className="port" placeholder="0" value={localPort} onChange={(e) => setLocalPort(e.target.value)} />
                </label>
              </div>
            )}

            {mode === "remote" && (
              <div className="tunnel-target">
                <label>
                  Server bind port <small>— port to open on the SSH server; 0 = server picks</small>
                  <input className="port" placeholder="0" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} />
                </label>
                <label>
                  Local target <small>— service on THIS machine to expose</small>
                  <div className="form-row">
                    <input placeholder="127.0.0.1" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} />
                    <input className="port" placeholder="port" value={localPort} onChange={(e) => setLocalPort(e.target.value)} />
                  </div>
                </label>
              </div>
            )}

            <TunnelDiagram server={previewServer} via={previewVia} routes={[previewRoute]} />

            <div className="tunnel-cmd">
              <div className="tunnel-cmd-head">
                <span>Or run it in a terminal</span>
                <button type="button" onClick={copyCmd}>
                  <Icon name="copy" size={12} /> {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <code className="tunnel-cmd-line">{sshCommand()}</code>
            </div>

            {error && <pre className="error">{error}</pre>}

            <div className="form-row end">
              <button className="ghost" onClick={() => setShowForm(false)} disabled={busy}>
                Cancel
              </button>
              <button onClick={start} disabled={busy}>
                <Icon name="tunnel" size={14} /> {busy ? "Starting…" : "Start tunnel"}
              </button>
            </div>
          </div>
        </div>
      )}

      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}
    </div>
  );
}
