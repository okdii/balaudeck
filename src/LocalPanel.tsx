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

  useEffect(() => {
    if (!termHost.current || termRef.current) return;
    let disposed = false;
    let raf = 0;
    const term = new Terminal({
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#0b0f12" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost.current);
    fit.fit();
    termRef.current = term;

    term.onData((d) => {
      if (sessionId.current) invoke("local_write", { id: sessionId.current, data: d });
    });
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* container not laid out yet */
        }
        if (sessionId.current) {
          invoke("local_resize", { id: sessionId.current, cols: term.cols, rows: term.rows });
        }
      });
    };
    const ro = new ResizeObserver(refit);
    ro.observe(termHost.current);
    window.addEventListener("resize", refit);

    (async () => {
      try {
        fit.fit();
        const id = await invoke<string>("local_open", {
          cols: term.cols,
          rows: term.rows,
          shell: null,
        });
        if (disposed) {
          invoke("local_close", { id });
          return;
        }
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
        if (!disposed) term.writeln(`\r\n\x1b[31m${String(err)}\x1b[0m`);
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", refit);
      unlisten.current.forEach((fn) => fn());
      unlisten.current = [];
      if (sessionId.current) {
        invoke("local_close", { id: sessionId.current });
        sessionId.current = null;
      }
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
