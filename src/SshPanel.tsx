import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { attachTerminalMask } from "./terminalMask";
import { attachTerminalClipboard } from "./terminalClipboard";
import { resolveJump, type Folder, type JumpHostParam, type SshProfile } from "./types";
import { AuthFields, type AuthValue, emptyAuth } from "./AuthFields";
import { Icon } from "./Icon";
import { AiChat } from "./AiChat";
import { makeSshToolset, sshSystemPrompt } from "./ai/tools/ssh";
import { ConnectLauncher } from "./SessionUI";
import { attachAutosuggest, remoteLsCommand } from "./suggest";
import { registerPaneWriter, broadcastInput } from "./broadcast";
import {
  defaultTmuxSession,
  getSettings,
  resolveFontSize,
  termTheme,
  subscribeSettings,
} from "./settings";

/** Which tmux session to attach: the connection's own name wins; otherwise the
 *  Settings default. Null lets the backend apply its built-in "balaudeck" —
 *  which is exactly what teammates on a shared server should override, or they
 *  all land in the same session. */
const tmuxSessionFor = (own?: string | null) =>
  own?.trim() || getSettings().tmuxSession.trim() || null;

export function SshPanel({
  prefill,
  autoConnect,
  sshProfiles = [],
  folders = [],
  paneId = "",
  onConnInfo,
  onSession,
  dcSignal,
  aiOpen,
  onAiClose,
}: {
  prefill?: SshProfile | null;
  autoConnect?: boolean;
  sshProfiles?: SshProfile[];
  folders?: Folder[];
  paneId?: string;
  onConnInfo?: (info: SshProfile) => void;
  onSession?: (label: string) => void;
  dcSignal?: number;
  /** AI chat open state + close, driven by the pane toolbar (App.tsx). */
  aiOpen?: boolean;
  onAiClose?: () => void;
}) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [auth, setAuth] = useState<AuthValue>(emptyAuth());
  const [status, setStatus] = useState("disconnected");
  const [lastError, setLastError] = useState("");
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [manual, setManual] = useState(false);
  // Manual quick-connect extras, mirroring the profile editor: reach the host
  // via a jump/bastion (saved profile or typed in, ProxyJump or nested), and/or
  // run the shell inside tmux so it survives drops.
  const [jumpOn, setJumpOn] = useState(false);
  const [jumpProfileId, setJumpProfileId] = useState("");
  const [jumpManual, setJumpManual] = useState(false);
  const [jHost, setJHost] = useState("");
  const [jPort, setJPort] = useState("22");
  const [jUser, setJUser] = useState("");
  const [jAuth, setJAuth] = useState<AuthValue>(emptyAuth());
  const [jumpMode, setJumpMode] = useState<"forward" | "nested">("forward");
  // Nested mode only: add `-v` to the jump's ssh for verbose diagnostics.
  const [verbose, setVerbose] = useState(false);
  const [tmuxOn, setTmuxOn] = useState(false);
  const [tmuxName, setTmuxName] = useState("");
  const [tmuxMouse, setTmuxMouse] = useState(false);
  const [connLabel, setConnLabel] = useState("");
  const [lost, setLost] = useState(false);
  const [autoReconnect, setAutoReconnect] = useState(
    () => localStorage.getItem("balaudeck.sshAutoReconnect") === "1",
  );
  const [reconnectIn, setReconnectIn] = useState<number | null>(null);

  /** Populate the whole manual form (connection, jump, tmux) from a profile, so
   * opening the manual section shows exactly what the selected host does. */
  function applyProfile(p: SshProfile) {
    setHost(p.host);
    setPort(String(p.port));
    setUser(p.user);
    setAuth({ ...emptyAuth(), auth: p.auth });
    setJumpOn(!!p.jump_profile_id || !!p.jump_host);
    setJumpProfileId(p.jump_profile_id ?? "");
    setJumpManual(!!p.jump_host);
    setJHost(p.jump_host ?? "");
    setJPort(String(p.jump_port ?? 22));
    setJUser(p.jump_user ?? "");
    setJAuth({ ...emptyAuth(), auth: p.jump_auth ?? "password" });
    setJumpMode(p.jump_mode === "nested" ? "nested" : "forward");
    setVerbose(!!p.verbose);
    setTmuxOn(!!p.tmux);
    setTmuxName(p.tmux_session ?? "");
    setTmuxMouse(!!p.tmux_mouse);
  }

  /** Saved-host picked in the dropdown: remember it AND mirror it into the
   * manual form, so expanding "Manual connection" starts prefilled from it. */
  function pickPreset(id: string) {
    setSelectedProfileId(id);
    const p = sshProfiles.find((s) => s.id === id);
    if (p) applyProfile(p);
  }

  useEffect(() => {
    if (prefill) {
      applyProfile(prefill);
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
  // After-login escalation: while set, watch output for a password prompt and
  // send the keychain escalation password once (budget caps the scan window).
  const escalate = useRef<{ budget: number; buf: string } | null>(null);
  // Keys the autosuggest history per connected host (set on connect).
  const histOwner = useRef("ssh:manual");
  // tmux was requested for the CURRENT session (drives scroll keys + keybar).
  const tmuxActive = useRef(false);
  // Missing-tmux banner: the server-side fallback echoes a notice we watch for
  // in the first chunk(s) of output (budget-limited so we stop scanning).
  const [tmuxMissing, setTmuxMissing] = useState(false);
  const sentinelBudget = useRef(0);
  const sentinelText = useRef("");
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
    // Font size + colour scheme come from Settings (Auto resolves to a smaller
    // font on narrow phones; iPad/desktop keep 14).
    const term = new Terminal({
      fontSize: resolveFontSize(),
      cursorBlink: true,
      convertEol: false,
      theme: termTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Blur pattern matches (e.g. IPs) in the terminal output when privacy mode is
    // on. xterm owns this DOM, so we overlay decorations rather than maskText.
    const detachMask = attachTerminalMask(term, termHost.current);
    // Selected text (incl. tmux copy-mode over SSH) → system clipboard.
    const detachClipboard = attachTerminalClipboard(term);

    // Re-apply terminal settings live when the user changes them.
    const unsubscribeSettings = subscribeSettings(() => {
      term.options.fontSize = resolveFontSize();
      term.options.theme = termTheme();
      try {
        fit.fit();
      } catch {
        /* host not laid out yet */
      }
    });

    const writeSelf = (data: string) => {
      if (sessionId.current) invoke("ssh_write", { id: sessionId.current, data });
    };
    const unregisterWriter = registerPaneWriter(paneId, writeSelf);
    term.onData((data) => {
      // With input-sync on for this pane, fan keystrokes out to every synced
      // pane (this one included); otherwise write only to our own session.
      if (!broadcastInput(paneId, data)) writeSelf(data);
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

    // Fish-style inline suggestions: this host's command history + REAL
    // directory entries (listed over a second channel of the same connection).
    const suggest = attachAutosuggest({
      term,
      container: termHost.current,
      owner: () => histOwner.current,
      send: (data) => {
        if (sessionId.current) invoke("ssh_write", { id: sessionId.current, data });
      },
      listDir: async (cwd, dir) => {
        if (!sessionId.current) return [];
        const out = await invoke<string>("ssh_exec", {
          id: sessionId.current,
          cmd: remoteLsCommand(cwd, dir),
        });
        return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      },
      // tmux scroll keys: Shift+PageUp enters copy-mode (C-b [) and pages up;
      // Shift+PageDown pages down inside copy-mode (harmless outside). q exits.
      extraKeys: (ev) => {
        if (!tmuxActive.current || !ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) {
          return undefined;
        }
        if (ev.key === "PageUp") {
          if (sessionId.current) {
            invoke("ssh_write", { id: sessionId.current, data: "\x02[\x1b[5~" });
          }
          return false;
        }
        if (ev.key === "PageDown") {
          if (sessionId.current) {
            invoke("ssh_write", { id: sessionId.current, data: "\x1b[6~" });
          }
          return false;
        }
        return undefined;
      },
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", refit);
      suggest.dispose();
      unsubscribeSettings();
      unregisterWriter();
      if (reconnectTimer.current) clearInterval(reconnectTimer.current);
      if (stableTimer.current) clearTimeout(stableTimer.current);
      // Close the backend shell so unmounting the pane doesn't leak the SSH
      // connection + driver task.
      if (sessionId.current) invoke("ssh_close", { id: sessionId.current });
      unlisten.current.forEach((fn) => fn());
      detachMask();
      detachClipboard();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  /** Jump host for a manual connect — same semantics as the profile editor:
   * off, a saved SSH host, or a typed-in manual jump; forward or nested. */
  function manualJump(): JumpHostParam | undefined {
    if (!jumpOn) return undefined;
    const nested = jumpMode === "nested";
    if (jumpManual) {
      if (!jHost.trim()) return undefined;
      // When the form mirrors a profile whose inline jump matches, its secrets
      // live in the keychain under the synthetic "<id>~jump" owner — pass it so
      // empty typed fields fall back to the stored credentials.
      const src = sshProfiles.find((s) => s.id === selectedProfileId) ?? prefill;
      const fromProfile = !!src?.id && src.jump_host === jHost.trim();
      return {
        host: jHost.trim(),
        port: Number(jPort) || 22,
        user: jUser.trim(),
        auth: jAuth.auth,
        password: jAuth.password || null,
        key: jAuth.key || null,
        passphrase: jAuth.passphrase || null,
        profile_id: fromProfile ? `${src!.id}~jump` : null,
        nested,
      };
    }
    if (jumpProfileId) {
      const j = sshProfiles.find((s) => s.id === jumpProfileId);
      if (j) return { host: j.host, port: j.port, user: j.user, auth: j.auth, profile_id: j.id, nested };
    }
    return undefined;
  }

  async function connect(override?: SshProfile) {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    // Start each session on a clean terminal (RIS). The pane reuses one xterm
    // instance across connects, so without this a mode set by a previous session
    // leaks into the next — e.g. a tmux+mouse connection leaves mouse tracking on,
    // then a later plain/manual connection in the same pane spews mouse-report
    // escapes (`35;44;38M…`) onto the prompt on hover. reset() also clears a
    // stale alt-screen / bracketed-paste / scrollback from the dead session.
    term.reset();
    lastConnect.current = override ?? "manual";
    // Disarm any leftover escalation watch so it can't fire on the new session.
    escalate.current = null;
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
          tmux_session: tmuxSessionFor(override.tmux_session),
          tmux_mouse: override.tmux_mouse ?? false,
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
          // The picked saved host (or the pane's prefill) supplies keychain
          // secrets when the typed fields are left empty.
          profile_id: selectedProfileId || prefill?.id || null,
          jump: manualJump(),
          tmux: tmuxOn,
          tmux_session: tmuxOn ? tmuxSessionFor(tmuxName) : null,
          tmux_mouse: tmuxOn && tmuxMouse,
          verbose: jumpOn && jumpMode === "nested" ? verbose : false,
        };
    // Show who you're logged in as (user@host); the profile name stays on the tab.
    const label = override
      ? `${override.user}@${override.host}`
      : `${params.user}@${params.host}`;
    // Suggestion history is shared per user@host across panes/sessions.
    histOwner.current = `ssh:${label}`;
    tmuxActive.current = !!params.tmux;
    setTmuxMissing(false);
    sentinelBudget.current = params.tmux ? 64 * 1024 : 0;
    sentinelText.current = "";
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

      // Auto-escalation: run the profile's after-login command once the shell has
      // settled, then arm the password watch (answered from the keychain if set).
      const afterLogin = prefill?.after_login?.trim();
      if (afterLogin) {
        window.setTimeout(() => {
          if (sessionId.current !== id) return;
          invoke("ssh_write", { id, data: afterLogin + "\n" }).catch(() => {});
          escalate.current = { budget: 16384, buf: "" };
        }, 600);
      }

      unlisten.current.push(
        await listen<number[]>(`ssh://data/${id}`, (e) => {
          const bytes = new Uint8Array(e.payload);
          term.write(bytes);
          // Auto-escalation: after the after-login command is sent, watch for its
          // password prompt and answer it from the keychain (backend-side, so the
          // password never enters JS). Send once; the budget caps the scan window.
          if (escalate.current) {
            const w = escalate.current;
            w.budget -= bytes.length;
            w.buf = (w.buf + new TextDecoder().decode(bytes)).slice(-512);
            if (/assword[^:]*:\s*$/i.test(w.buf) || /\[sudo\] password/i.test(w.buf)) {
              escalate.current = null;
              invoke("ssh_write_secret", {
                id,
                kind: "ssh",
                profileId: prefill?.id ?? "",
                slot: "escalate_password",
              }).catch(() => {});
            } else if (w.budget <= 0) {
              escalate.current = null;
            }
          }
          // Watch the session's first output for the backend's missing-tmux
          // notice (accumulated across chunks; budget caps the scan).
          if (sentinelBudget.current > 0) {
            sentinelBudget.current -= bytes.length;
            if (sentinelText.current.length < 8192) {
              sentinelText.current += new TextDecoder().decode(bytes);
            }
            if (sentinelText.current.includes("[BalauDeck] tmux not found")) {
              sentinelBudget.current = 0;
              setTmuxMissing(true);
            }
          }
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

  /** Type (NOT run) a cross-distro tmux install one-liner at the prompt, so the
   * user reviews it and presses Enter themselves (sudo may ask a password). */
  function typeInstallTmux() {
    const cmd =
      "sudo apt-get install -y tmux 2>/dev/null || sudo dnf install -y tmux 2>/dev/null || " +
      "sudo yum install -y tmux 2>/dev/null || sudo apk add tmux 2>/dev/null || " +
      "sudo pacman -S --noconfirm tmux";
    if (sessionId.current) invoke("ssh_write", { id: sessionId.current, data: cmd });
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
      <div className="ssh-split">
        <div className="ssh-main">
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

        {connected && tmuxMissing && (
          <div className="term-banner">
            <span className="tb-msg">
              <span className="dot warn" /> tmux isn't installed on this server — the session
              won't persist
            </span>
            <div className="tb-actions">
              <button onClick={typeInstallTmux}>Install tmux</button>
              <button onClick={reconnectNow}>Reconnect</button>
              <button className="ghost" onClick={() => setTmuxMissing(false)}>
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
            presets={sshProfiles.map((p) => ({
              id: p.id,
              label: p.name || `${p.user}@${p.host}`,
              sub: `${p.user}@${p.host}`,
              folderId: p.folder_id ?? null,
            }))}
            folders={folders}
            selectedId={selectedProfileId}
            onSelect={pickPreset}
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
            <AuthFields value={auth} onChange={setAuth} saved={!!(selectedProfileId || prefill?.id)} />

            <div className="jump-field">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={jumpOn}
                  onChange={(e) => setJumpOn(e.target.checked)}
                />
                <span>
                  Connect through a jump host{" "}
                  <small>— ProxyJump / bastion (how to reach this host, not a forward)</small>
                </span>
              </label>
              {jumpOn && (
                <>
                  <label>
                    Jump SSH host <small>— a saved SSH host to route through</small>
                    <select
                      value={jumpManual ? "" : jumpProfileId}
                      disabled={jumpManual}
                      onChange={(e) => setJumpProfileId(e.target.value)}
                    >
                      <option value="">— choose a saved SSH host —</option>
                      {sshProfiles
                        .filter((s) => s.id !== prefill?.id)
                        .map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name || `${s.user}@${s.host}`}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="jump-toggle"
                    onClick={() => {
                      setJumpManual((v) => !v);
                      if (!jumpManual) setJumpProfileId("");
                    }}
                  >
                    <Icon name={jumpManual ? "chevronDown" : "chevronRight"} size={13} />
                    Manual jump host
                  </button>
                  {jumpManual && (
                    <div className="jump-manual">
                      <div className="form-row">
                        <input
                          placeholder="jump host"
                          value={jHost}
                          onChange={(e) => setJHost(e.target.value)}
                        />
                        <input
                          className="port"
                          placeholder="port"
                          value={jPort}
                          onChange={(e) => setJPort(e.target.value)}
                        />
                        <input
                          placeholder="user"
                          value={jUser}
                          onChange={(e) => setJUser(e.target.value)}
                        />
                      </div>
                      <AuthFields value={jAuth} onChange={setJAuth} saved={!!prefill?.jump_host} />
                    </div>
                  )}
                  <label>
                    Routing{" "}
                    <small>— nested runs ssh on the jump (for bastions that block forwarding)</small>
                    <select
                      value={jumpMode}
                      onChange={(e) => setJumpMode(e.target.value as "forward" | "nested")}
                    >
                      <option value="forward">Port-forward (ProxyJump)</option>
                      <option value="nested">Run ssh on the jump (nested)</option>
                    </select>
                  </label>
                  {jumpMode === "nested" && (
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={verbose}
                        onChange={(e) => setVerbose(e.target.checked)}
                      />
                      <span>
                        Verbose <small>— add ssh -v output to the terminal (debug)</small>
                      </span>
                    </label>
                  )}
                </>
              )}
            </div>

            <label className="check-row">
              <input type="checkbox" checked={tmuxOn} onChange={(e) => setTmuxOn(e.target.checked)} />
              <span>
                Persist with tmux <small>— re-attach the same shell on reconnect</small>
              </span>
            </label>
            {tmuxOn && (
              <>
                <label>
                  tmux session name <small>— optional; the Settings default if blank</small>
                  <input
                    value={tmuxName}
                    onChange={(e) => setTmuxName(e.target.value)}
                    placeholder={defaultTmuxSession()}
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={tmuxMouse}
                    onChange={(e) => setTmuxMouse(e.target.checked)}
                  />
                  <span>
                    Mouse scroll <small>— tmux mouse on; hold Shift to select text</small>
                  </span>
                </label>
              </>
            )}

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
          {tmuxActive.current && (
            <>
              <button onClick={() => sendSeq("\x02[\x1b[5~")}>PgUp</button>
              <button onClick={() => sendSeq("\x1b[6~")}>PgDn</button>
            </>
          )}
        </div>
      )}
        </div>

        {aiOpen && (
          <AiChat
            makeToolset={() => makeSshToolset(() => sessionId.current)}
            buildSystem={() => sshSystemPrompt(sessionLabel, connected)}
            placeholder={'Ask about this server — "what\'s using disk?", "is nginx running?", "tail the auth log".'}
            onClose={() => onAiClose?.()}
          />
        )}
      </div>
    </div>
  );
}
