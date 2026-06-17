import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { SshProfile } from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon, statusClass } from "./Icon";

export function SshPanel({
  prefill,
  autoConnect,
}: {
  prefill?: SshProfile | null;
  autoConnect?: boolean;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<AuthValue>(emptyAuth());
  const [status, setStatus] = useState("disconnected");

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setAuth({ ...emptyAuth(), auth: prefill.auth });
    }
  }, [prefill]);

  const termHost = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(null);
  const unlisten = useRef<UnlistenFn[]>([]);
  const didAuto = useRef(false);

  // Auto-connect once when opened as a tab from a saved profile (key/password
  // come from the keychain via profile_id, so no input is needed).
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

    const onResize = () => {
      fit.fit();
      if (sessionId.current) {
        invoke("ssh_resize", { id: sessionId.current, cols: term.cols, rows: term.rows });
      }
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
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
      setStatus("connecting…");
      fit.fit();
      const id = await invoke<string>("ssh_open_shell", {
        params: { ...params, cols: term.cols, rows: term.rows },
      });
      sessionId.current = id;
      setStatus("connected");

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
      term.writeln(`\r\n\x1b[31m${String(err)}\x1b[0m`);
    }
  }

  async function disconnect() {
    if (sessionId.current) {
      await invoke("ssh_close", { id: sessionId.current });
      sessionId.current = null;
      setStatus("disconnected");
    }
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

  return (
    <div className="panel terminal-panel">
      <div className="conn-controls">
        <div className="form-row">
          <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
          <input
            className="port"
            placeholder="port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
          <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
          <button onClick={() => connect()}>
            <Icon name="play" size={14} /> Connect
          </button>
          <button className="ghost" onClick={disconnect}>
            Close
          </button>
          <span className="status">
            <span className={"dot " + statusClass(status)} />
            {status}
          </span>
        </div>
        <AuthFields value={auth} onChange={setAuth} saved={!!prefill?.id} />
      </div>
      <div ref={termHost} className="terminal" />
      <div className="keybar">
        {keys.map((k) => (
          <button key={k.label} onClick={() => sendSeq(k.seq)}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
