import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/** A local shell terminal (desktop) backed by a PTY in Rust. */
export function LocalPanel() {
  const termHost = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionId = useRef<string | null>(null);
  const unlisten = useRef<UnlistenFn[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (!termHost.current || termRef.current) return;
    const term = new Terminal({ fontSize: 13, cursorBlink: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost.current);
    fit.fit();
    termRef.current = term;

    term.onData((d) => {
      if (sessionId.current) invoke("local_write", { id: sessionId.current, data: d });
    });
    const onResize = () => {
      fit.fit();
      if (sessionId.current) {
        invoke("local_resize", { id: sessionId.current, cols: term.cols, rows: term.rows });
      }
    };
    window.addEventListener("resize", onResize);

    async function open() {
      try {
        fit.fit();
        const id = await invoke<string>("local_open", {
          cols: term.cols,
          rows: term.rows,
          shell: null,
        });
        sessionId.current = id;
        unlisten.current.push(
          await listen<number[]>(`local://data/${id}`, (e) => term.write(new Uint8Array(e.payload))),
        );
        unlisten.current.push(
          await listen(`local://close/${id}`, () => {
            term.writeln("\r\n\x1b[33m[shell exited]\x1b[0m");
            sessionId.current = null;
          }),
        );
        term.focus();
      } catch (err) {
        term.writeln(`\r\n\x1b[31m${String(err)}\x1b[0m`);
      }
    }
    if (!started.current) {
      started.current = true;
      open();
    }

    return () => {
      window.removeEventListener("resize", onResize);
      unlisten.current.forEach((fn) => fn());
      if (sessionId.current) invoke("local_close", { id: sessionId.current });
      term.dispose();
      termRef.current = null;
    };
  }, []);

  return (
    <div className="panel terminal-panel">
      <div ref={termHost} className="terminal" />
    </div>
  );
}
