import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { SshProfile } from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon } from "./Icon";

export function SshPanel({
  prefill,
  autoConnect,
  sshProfiles = [],
}: {
  prefill?: SshProfile | null;
  autoConnect?: boolean;
  sshProfiles?: SshProfile[];
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<AuthValue>(emptyAuth());
  const [status, setStatus] = useState("disconnected");
  const [lastError, setLastError] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setAuth({ ...emptyAuth(), auth: prefill.auth });
      setSelectedProfileId(prefill.id);
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
    const term = new Terminal({
      fontSize: 14,
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
        try {
          fit.fit();
        } catch {
          /* container not laid out yet */
        }
        if (sessionId.current) {
          invoke("ssh_resize", { id: sessionId.current, cols: term.cols, rows: term.rows });
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
      unlisten.current.forEach((fn) => fn());
      term.dispose();
      termRef.current = null;
    };
  }, []);

  async function connect(override?: SshProfile) {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
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
        };
    try {
      setLastError("");
      setStatus("connecting…");
      fit.fit();
      const id = await invoke<string>("ssh_open_shell", {
        params: { ...params, cols: term.cols, rows: term.rows },
      });
      sessionId.current = id;
      setStatus("connected");
      requestAnimationFrame(() => fit.fit());

      unlisten.current.push(
        await listen<number[]>(`ssh://data/${id}`, (e) => {
          term.write(new Uint8Array(e.payload));
        }),
      );
      unlisten.current.push(
        await listen(`ssh://close/${id}`, () => {
          setStatus("disconnected");
          sessionId.current = null;
          term.writeln("\r\n\x1b[33m[connection closed]\x1b[0m");
        }),
      );
      term.focus();
    } catch (err) {
      setStatus("error");
      setLastError(String(err));
    }
  }

  function connectPreset() {
    const p = sshProfiles.find((s) => s.id === selectedProfileId);
    if (p) connect(p);
  }

  async function disconnect() {
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
  const sessionLabel = prefill
    ? prefill.name || `${prefill.user}@${prefill.host}`
    : `${user || "?"}@${host || "?"}`;

  return (
    <div className="panel terminal-panel">
      {connected && (
        <div className="session-bar">
          <span className="status">
            <span className="dot ok" />
            {sessionLabel}
          </span>
          <button className="ghost btn-sm" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      )}

      <div className="term-wrap">
        <div ref={termHost} className="terminal" />

        {!connected && (
          <div className="ssh-launcher">
            <div className="launcher-card">
              <div className="launcher-head">
                <Icon name="server" size={22} />
                <h3>Connect SSH</h3>
              </div>

              {sshProfiles.length > 0 && (
                <div className="launcher-presets">
                  <select
                    value={selectedProfileId}
                    onChange={(e) => setSelectedProfileId(e.target.value)}
                  >
                    <option value="">Choose a saved host…</option>
                    {sshProfiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || `${p.user}@${p.host}`}
                      </option>
                    ))}
                  </select>
                  <button onClick={connectPreset} disabled={!selectedProfileId || connecting}>
                    <Icon name="play" size={14} /> {connecting ? "Connecting…" : "Connect"}
                  </button>
                </div>
              )}

              <button className="launcher-toggle" onClick={() => setManual((v) => !v)}>
                <Icon name={manual ? "chevronDown" : "chevronRight"} size={14} />
                Manual connection
              </button>

              {manual && (
                <div className="launcher-manual">
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
                </div>
              )}

              {lastError && <pre className="error">{lastError}</pre>}
            </div>
          </div>
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
