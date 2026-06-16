import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function SshPanel() {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("disconnected");

  const termHost = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(null);
  const unlisten = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    if (!termHost.current || termRef.current) return;
    const term = new Terminal({ fontSize: 14, cursorBlink: true, convertEol: false });
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

  async function connect() {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      setStatus("connecting…");
      fit.fit();
      const id = await invoke<string>("ssh_open_shell", {
        params: {
          host,
          port: Number(port),
          user,
          password,
          cols: term.cols,
          rows: term.rows,
        },
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

  return (
    <div className="panel">
      <div className="form-row">
        <input placeholder="host" value={host} onChange={(e) => setHost(e.target.value)} />
        <input
          className="port"
          placeholder="port"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
        <input placeholder="user" value={user} onChange={(e) => setUser(e.target.value)} />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button onClick={connect}>Connect</button>
        <button onClick={disconnect}>Close</button>
        <span className="status">{status}</span>
      </div>
      <div ref={termHost} className="terminal" />
    </div>
  );
}
