import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { attachAutosuggest } from "./suggest";
import { attachTerminalClipboard } from "./terminalClipboard";
import { registerPaneWriter, broadcastInput } from "./broadcast";
import { getSettings, resolveFontSize, termTheme, subscribeSettings } from "./settings";
import { storeBuild } from "./updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AiChat } from "./AiChat";
import { makeLocalToolset, localSystemPrompt } from "./ai/tools/local";

const RELEASES_URL = "https://github.com/okdii/balaudeck/releases/latest";

/**
 * Shown instead of a terminal in the sandboxed App Store build, which cannot
 * open one: macOS only hands the PTY slave (/dev/ttysNNN) to a process holding
 * a `com.apple.sandbox.pty` extension, and only a broker like Terminal.app can
 * issue one — so openpty() fails with EPERM and no entitlement changes that.
 * Explaining the limit beats a tab that errors, or one that silently vanished.
 */
function LocalUnavailable() {
  return (
    <div className="panel local-unavailable">
      <h3>Local terminal isn't available in this build</h3>
      <p>
        This copy of BalauDeck came from the Mac App Store, where apps run
        sandboxed. macOS doesn't let a sandboxed app open a terminal device, so
        a local shell can't run here. It's a platform rule, not a missing
        feature — no setting turns it on.
      </p>
      <p className="muted">
        Everything else works normally: SSH, SFTP, tunnels, databases and object
        storage all connect as usual — those use the network, not a terminal
        device.
      </p>
      <h4>If you need a shell on this Mac</h4>
      <ul>
        <li>
          <b>Add it as an SSH connection.</b> Turn on Remote Login in System
          Settings → General → Sharing, then connect to <code>127.0.0.1</code>{" "}
          like any other host. You get your real shell, with your own files and
          PATH.
        </li>
        <li>
          <b>Or use the direct download.</b> The build on the project's releases
          page isn't sandboxed, so its local terminal works.
        </li>
      </ul>
      <button onClick={() => openUrl(RELEASES_URL).catch(() => {})}>
        Open the releases page
      </button>
    </div>
  );
}

/** A local shell terminal (desktop) backed by a PTY in Rust. */
export function LocalPanel({
  paneId = "",
  aiOpen,
  onAiClose,
}: {
  paneId?: string;
  aiOpen?: boolean;
  onAiClose?: () => void;
}) {
  if (storeBuild) return <LocalUnavailable />;
  return <LocalTerminal paneId={paneId} aiOpen={aiOpen} onAiClose={onAiClose} />;
}

function LocalTerminal({
  paneId = "",
  aiOpen,
  onAiClose,
}: {
  paneId?: string;
  aiOpen?: boolean;
  onAiClose?: () => void;
}) {
  const termHost = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionId = useRef<string | null>(null);
  const unlisten = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    if (!termHost.current || termRef.current) return;
    let disposed = false;
    let raf = 0;
    const term = new Terminal({
      fontSize: resolveFontSize(),
      cursorBlink: true,
      theme: termTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost.current);
    fit.fit();
    termRef.current = term;
    const detachClipboard = attachTerminalClipboard(term);
    const unsubscribeSettings = subscribeSettings(() => {
      term.options.fontSize = resolveFontSize();
      term.options.theme = termTheme();
      try {
        fit.fit();
      } catch {
        /* host not laid out yet */
      }
    });

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
          // Settings → Local terminal; empty means let the backend pick.
          shell: getSettings().localShell || null,
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
      unsubscribeSettings();
      detachClipboard();
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
      <div className="local-split">
        <div className="local-main">
          <div ref={termHost} className="terminal" />
        </div>
        {aiOpen && (
          <AiChat
            makeToolset={() => makeLocalToolset(() => getSettings().localShell || null)}
            buildSystem={() => localSystemPrompt()}
            placeholder={'Ask about this machine — "what\'s using disk?", "is Docker running?", "which node am I on?".'}
            onClose={() => onAiClose?.()}
          />
        )}
      </div>
    </div>
  );
}
