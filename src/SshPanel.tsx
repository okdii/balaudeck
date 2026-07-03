import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resolveJump, type SshProfile } from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon } from "./Icon";
import { ConnectLauncher } from "./SessionUI";

export function SshPanel({
  prefill,
  autoConnect,
  sshProfiles = [],
  onConnInfo,
  onSession,
  dcSignal,
}: {
  prefill?: SshProfile | null;
  autoConnect?: boolean;
  sshProfiles?: SshProfile[];
  onConnInfo?: (info: SshProfile) => void;
  onSession?: (label: string) => void;
  dcSignal?: number;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<AuthValue>(emptyAuth());
  const [status, setStatus] = useState("disconnected");
  const [lastError, setLastError] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [manual, setManual] = useState(false);
  const [connLabel, setConnLabel] = useState("");
  const [lost, setLost] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(
    () => localStorage.getItem("balaudeck.sshAutoReconnect") === "1",
  );
  const [reconnectIn, setReconnectIn] = useState<number | null>(null);

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setAuth({ ...emptyAuth(), auth: prefill.auth });
      setSelectedProfileId(prefill.id);
      if (!prefill.id) setManual(true);
    } else {
      setManual(sshProfiles.length === 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const termHost = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(null);
  const unlisten = useRef<UnlistenFn[]>([]);
  const didAuto = useRef(false);
  // Reconnect bookkeeping: what we last connected to (a saved profile or the
  // manual form), the backoff countdown timer, and the attempt counter.
  const lastConnect = useRef<SshProfile | "manual" | null>(null);
  const reconnectTimer = useRef<number | null>(null);
  const reconnectAttempt = useRef(0);
  // Zeroes the retry counter once a session has stayed up a while (see connect).
  const stableTimer = useRef<number | null>(null);
  const autoRef = useRef(autoReconnect);
  useEffect(() => {
    autoRef.current = autoReconnect;
    localStorage.setItem("balaudeck.sshAutoReconnect", autoReconnect ? "1" : "0");
  }, [autoReconnect]);

  function clearReconnect() {
    if (reconnectTimer.current) {
      clearInterval(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    setReconnectIn(null);
  }
  function doReconnect() {
    const t = lastConnect.current;
    if (t === "manual") connect();
    else if (t) connect(t);
  }
  function reconnectNow() {
    clearReconnect();
    reconnectAttempt.current = 0;
    setLost(false);
    doReconnect();
  }
  // Auto-reconnect with exponential backoff (2,4,8,16,30,30s), capped at 6
  // tries; after that the manual Reconnect button remains.
  function scheduleReconnect() {
    clearReconnect();
    reconnectAttempt.current += 1;
    if (reconnectAttempt.current > 6) return;
    let secs = Math.min(30, 2 ** reconnectAttempt.current);
    setReconnectIn(secs);
    reconnectTimer.current = window.setInterval(() => {
      secs -= 1;
      if (secs <= 0) {
        clearReconnect();
        doReconnect();
      } else {
        setReconnectIn(secs);
      }
    }, 1000);
  }

  useEffect(() => {
    if (autoConnect && prefill && !didAuto.current) {
      didAuto.current = true;
      const tryConnect = () => {
        if (termRef.current) connect(prefill);
        else setTimeout(tryConnect, 50);
      };
      tryConnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, prefill]);

  useEffect(() => {
    if (!termHost.current || termRef.current) return;
    // iPhone screens are narrow, so 14px feels oversized and fits few columns —
    // use a smaller font on phone-width viewports; iPad/desktop keep 14.
    const fontSize = window.matchMedia("(max-width: 430px)").matches ? 11 : 14;
    const term = new Terminal({
      fontSize,
      cursorBlink: true,
      convertEol: false,
      theme: { background: "#0b0f12" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      if (sessionId.current) invoke("ssh_write", { id: sessionId.current, data });
    });

    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Skip while the host is detached / zero-size (e.g. the transient DOM move
        // when a pane is split or relocated): fitting then would collapse rows to
        // ~0 and discard the scrollback. The next resize (with real size) refits.
        const host = termHost.current;
        if (!host || !host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
        // Fit + notify the server ONLY when the geometry really changed. The
        // post-layout pulse fires several times to catch the DOM move settling;
        // sending duplicate resizes would SIGWINCH the remote shell each time and
        // make it redraw its prompt repeatedly (staircase garbage on screen).
        try {
          const dims = fit.proposeDimensions();
          if (dims && dims.cols > 0 && dims.rows > 0 && (dims.cols !== term.cols || dims.rows !== term.rows)) {
            fit.fit();
            if (sessionId.current) {
              invoke("ssh_resize", { id: sessionId.current, cols: term.cols, rows: term.rows });
            }
          }
        } catch {
          /* container not laid out yet */
        }
        // Moving the xterm DOM to a new slot (split/relocate) can leave the canvas
        // blank even though the buffer + SSH session are intact — force a redraw so
        // the existing content stays visible instead of looking disconnected.
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* renderer not ready */
        }
      });
    };
    const ro = new ResizeObserver(refit);
    ro.observe(termHost.current);
    window.addEventListener("resize", refit);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", refit);
      if (reconnectTimer.current) clearInterval(reconnectTimer.current);
      if (stableTimer.current) clearTimeout(stableTimer.current);
      // Close the backend shell so unmounting the pane doesn't leak the SSH
      // connection + driver task.
      if (sessionId.current) invoke("ssh_close", { id: sessionId.current });
      unlisten.current.forEach((fn) => fn());
      term.dispose();
      termRef.current = null;
    };
  }, []);

  async function connect(override?: SshProfile) {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    lastConnect.current = override ?? "manual";
    // Drop listeners from a previous (now-dead) session id before reconnecting.
    unlisten.current.forEach((fn) => fn());
    unlisten.current = [];
    const params = override
      ? {
          host: override.host,
          port: override.port,
          user: override.user,
          auth: override.auth,
          password: null,
          key: null,
          passphrase: null,
          profile_id: override.id || null,
          jump: resolveJump(override, sshProfiles),
          tmux: override.tmux ?? false,
          tmux_session: override.tmux_session ?? null,
          verbose: override.verbose ?? false,
        }
      : {
          host,
          port: Number(port),
          user,
          auth: auth.auth,
          password: auth.password || null,
          key: auth.key || null,
          passphrase: auth.passphrase || null,
          profile_id: prefill?.id || null,
          jump: resolveJump(prefill, sshProfiles),
          tmux: prefill?.tmux ?? false,
          tmux_session: prefill?.tmux_session ?? null,
          verbose: prefill?.verbose ?? false,
        };
    // Show who you're logged in as (user@host); the profile name stays on the tab.
    const label = override
      ? `${override.user}@${override.host}`
      : `${params.user}@${params.host}`;
    try {
      setLastError("");
      setStatus("connecting…");
      fit.fit();
      const id = await invoke<string>("ssh_open_shell", {
        params: { ...params, cols: term.cols, rows: term.rows },
      });
      sessionId.current = id;
      setConnLabel(label);
      setStatus("connected");
      // A successful (re)connect stops the countdown, but only reset the retry
      // counter once the session has stayed up a while — otherwise a flaky link
      // that connects then immediately drops would reset every cycle and loop
      // forever at the minimum backoff. A drop before this fires keeps climbing.
      setLost(false);
      clearReconnect();
      if (stableTimer.current) clearTimeout(stableTimer.current);
      stableTimer.current = window.setTimeout(() => {
        reconnectAttempt.current = 0;
      }, 45000);
      onConnInfo?.(
        override ?? {
          id: prefill?.id ?? "",
          name: prefill?.name ?? label,
          host: params.host,
          port: params.port,
          user: params.user,
          auth: params.auth,
        },
      );
      requestAnimationFrame(() => fit.fit());

      unlisten.current.push(
        await listen<number[]>(`ssh://data/${id}`, (e) => {
          term.write(new Uint8Array(e.payload));
        }),
      );
      unlisten.current.push(
        await listen<string>(`ssh://close/${id}`, (e) => {
          setStatus("disconnected");
          sessionId.current = null;
          // Session ended before the stability window — don't reset the counter.
          if (stableTimer.current) {
            clearTimeout(stableTimer.current);
            stableTimer.current = null;
          }
          if (e.payload === "lost") {
            term.writeln("\r\n\x1b[33m[connection lost]\x1b[0m");
            setLost(true);
            if (autoRef.current) scheduleReconnect();
          } else {
            term.writeln("\r\n\x1b[33m[connection closed]\x1b[0m");
            setLost(false);
          }
        }),
      );
      term.focus();
    } catch (err) {
      setStatus("error");
      setLastError(String(err));
      // Mid auto-reconnect, keep retrying (server may be briefly unreachable);
      // a first/manual connect failure just surfaces the error.
      if (autoRef.current && reconnectAttempt.current > 0) scheduleReconnect();
    }
  }

  function connectPreset() {
    const p = sshProfiles.find((s) => s.id === selectedProfileId);
    if (p) connect(p);
  }

  async function disconnect() {
    clearReconnect();
    if (stableTimer.current) clearTimeout(stableTimer.current);
    reconnectAttempt.current = 0;
    setLost(false);
    if (sessionId.current) {
      await invoke("ssh_close", { id: sessionId.current });
      sessionId.current = null;
    }
    setStatus("disconnected");
  }

  function sendSeq(seq: string) {
    if (sessionId.current) invoke("ssh_write", { id: sessionId.current, data: seq });
    termRef.current?.focus();
  }

  const keys: { label: string; seq: string }[] = [
    { label: "Esc", seq: "\x1b" },
    { label: "Tab", seq: "\t" },
    { label: "^C", seq: "\x03" },
    { label: "^D", seq: "\x04" },
    { label: "^L", seq: "\x0c" },
    { label: "^Z", seq: "\x1a" },
    { label: "↑", seq: "\x1b[A" },
    { label: "↓", seq: "\x1b[B" },
    { label: "←", seq: "\x1b[D" },
    { label: "→", seq: "\x1b[C" },
  ];

  const connected = status === "connected";
  const connecting = status === "connecting…";
  const sessionLabel = connLabel || (prefill ? `${prefill.user}@${prefill.host}` : "ssh");

  useEffect(() => {
    onSession?.(connected ? sessionLabel : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sessionLabel]);

  useEffect(() => {
    if (dcSignal && dcSignal > 0) disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dcSignal]);

  return (
    <div className="panel terminal-panel">

      <div className="term-wrap">
        <div ref={termHost} className="terminal" />

        {lost && !connected && (
          <div className="term-banner">
            <span className="tb-msg">
              <span className="dot err" /> Connection lost
              {reconnectIn != null &&
                ` — reconnecting in ${reconnectIn}s (try ${reconnectAttempt.current})`}
            </span>
            <div className="tb-actions">
              <label className="tb-auto">
                <input
                  type="checkbox"
                  checked={autoReconnect}
                  onChange={(e) => setAutoReconnect(e.target.checked)}
                />
                Auto
              </label>
              <button onClick={reconnectNow}>
                {reconnectIn != null ? "Reconnect now" : "Reconnect"}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  clearReconnect();
                  reconnectAttempt.current = 0;
                  setLost(false);
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {!connected && !lost && (
          <ConnectLauncher
            overlay
            icon="server"
            title="Connect SSH"
            presets={sshProfiles.map((p) => ({ id: p.id, label: p.name || `${p.user}@${p.host}` }))}
            selectedId={selectedProfileId}
            onSelect={setSelectedProfileId}
            onConnect={connectPreset}
            connecting={connecting}
            manualOpen={manual}
            onToggleManual={() => setManual((v) => !v)}
            error={lastError}
          >
            <div className="form-row">
              <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
              <input
                className="port"
                placeholder="port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
              <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
            </div>
            <AuthFields value={auth} onChange={setAuth} saved={!!prefill?.id} />
            <button onClick={() => connect()} disabled={connecting}>
              <Icon name="play" size={14} /> {connecting ? "Connecting…" : "Connect"}
            </button>
          </ConnectLauncher>
        )}
      </div>

      {connected && (
        <div className="keybar">
          {keys.map((k) => (
            <button key={k.label} onClick={() => sendSeq(k.seq)}>
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
