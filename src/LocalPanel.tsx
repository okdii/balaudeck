import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { attachAutosuggest } from "./suggest";
import { registerPaneWriter, broadcastInput } from "./broadcast";

/** A local shell terminal (desktop) backed by a PTY in Rust. */
export function LocalPanel({ paneId = "" }: { paneId?: string }) {
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

    const writeSelf = (d: string) => {
      if (sessionId.current) invoke("local_write", { id: sessionId.current, data: d });
    };
    const unregisterWriter = registerPaneWriter(paneId, writeSelf);
    term.onData((d) => {
      if (!broadcastInput(paneId, d)) writeSelf(d);
    });
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // Skip while detached / zero-size (transient during a pane split/move),
        // else fitting collapses rows to ~0 and discards scrollback.
        const host = termHost.current;
        if (!host || !host.isConnected || host.clientWidth === 0 || host.clientHeight === 0) return;
        // Fit + resize the PTY ONLY when the geometry really changed — duplicate
        // resizes SIGWINCH the shell repeatedly and make it redraw its prompt
        // (staircase garbage) since the post-layout pulse fires several times.
        try {
          const dims = fit.proposeDimensions();
          if (dims && dims.cols > 0 && dims.rows > 0 && (dims.cols !== term.cols || dims.rows !== term.rows)) {
            fit.fit();
            if (sessionId.current) {
              invoke("local_resize", { id: sessionId.current, cols: term.cols, rows: term.rows });
            }
          }
        } catch {
          /* container not laid out yet */
        }
        // Repaint after a split/relocate DOM move so content isn't left blank.
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

    // Fish-style inline suggestions: local command history + real directory
    // entries from the filesystem.
    const suggest = attachAutosuggest({
      term,
      container: termHost.current,
      owner: () => "local",
      send: (data) => {
        if (sessionId.current) invoke("local_write", { id: sessionId.current, data });
      },
      listDir: (cwd, dir) => invoke<string[]>("local_listdir", { cwd, dir }),
    });

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
      suggest.dispose();
      unregisterWriter();
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
