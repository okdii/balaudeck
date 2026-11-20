// Warp-style AI inside a terminal pane (SSH + local), shared by both panels:
//  • Ask bar — ⌘I / Ctrl+Shift+I, or `# do something` + Enter at the prompt:
//    natural language → one command typed at the prompt (not run).
//  • Agent in the terminal — the chat's run_command types into this live shell.
//  • Explain error — a chip after a command whose output looks like a failure.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import { Icon, Spinner } from "./Icon";
import { getSettings } from "./settings";
import { extractInput } from "./suggest";
import {
  askCommand,
  cleanTerminalText,
  looksLikeError,
  makeTerminalToolset,
  screenText,
  terminalSystemPrompt,
} from "./ai/termAi";
import type { Toolset } from "./ai/tool";

export const IS_APPLE = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
export const ASK_SHORTCUT = IS_APPLE ? "⌘I" : "Ctrl+Shift+I";

export function useTerminalAi(opts: {
  termRef: { current: Terminal | null };
  sessionId: { current: string | null };
  /** Write raw input to this pane's shell. */
  write: (data: string) => void;
  /** e.g. "user@host" (SSH) or "local shell"; shown to the model. */
  label: string;
  /** "an SSH session to `x`" / "a local shell on the user's Mac" */
  where: string;
  onAiOpen?: () => void;
}) {
  const { termRef, sessionId, write, label, where, onAiOpen } = opts;
  const [askOpen, setAskOpen] = useState(false);
  const [askText, setAskText] = useState("");
  const [askBusy, setAskBusy] = useState(false);
  const [askNote, setAskNote] = useState<{ text: string; err?: boolean } | null>(null);
  const askInputRef = useRef<HTMLInputElement>(null);
  const askNoteTimer = useRef(0);
  const [inTerm, setInTerm] = useState(() => localStorage.getItem("balaudeck.aiInTerminal") !== "0");
  useEffect(() => {
    localStorage.setItem("balaudeck.aiInTerminal", inTerm ? "1" : "0");
  }, [inTerm]);
  const taps = useRef(new Set<(chunk: string) => void>());
  const helper = useRef<string | null>(null);
  const busy = useRef(false);
  const errWatch = useRef<{ cmd: string; row: number; out: string; shown: boolean } | null>(null);
  const errTimer = useRef(0);
  const [errChip, setErrChip] = useState<{ cmd: string; text: string } | null>(null);
  const [inject, setInject] = useState<{ id: number; text: string } | null>(null);
  const live = useRef({ label, where, write });
  live.current = { label, where, write };

  const enabled = () => getSettings().ai.enabled;

  function checkError() {
    const w = errWatch.current;
    const term = termRef.current;
    if (!w || w.shown || !term || !enabled()) return;
    const out = cleanTerminalText(w.out);
    if (!looksLikeError(w.cmd, out.split("\n").slice(1).join("\n"))) return;
    w.shown = true;
    setErrChip({ cmd: w.cmd, text: screenText(term, 80, w.row).slice(-6000) });
  }

  function explainError() {
    if (!errChip) return;
    setInject({
      id: Date.now(),
      text:
        "This command failed in my terminal. Explain why in a few sentences and give the fix " +
        "(check with read-only commands if you need to):\n\n```\n" +
        errChip.text +
        "\n```",
    });
    setErrChip(null);
    onAiOpen?.();
  }

  function openAsk(prefill = "", submit = false) {
    if (!sessionId.current) return;
    setAskOpen(true);
    setAskNote(null);
    setAskText(prefill);
    if (submit && prefill) runAsk(prefill);
    else requestAnimationFrame(() => askInputRef.current?.focus());
  }

  function closeAsk() {
    setAskOpen(false);
    setAskBusy(false);
    termRef.current?.focus();
  }

  async function runAsk(text: string) {
    const term = termRef.current;
    const prompt = text.trim();
    if (!term || !prompt || !sessionId.current) return;
    if (!enabled()) {
      setAskNote({ text: "Turn on the AI assistant in Settings → AI Assistant first.", err: true });
      return;
    }
    setAskBusy(true);
    setAskNote(null);
    try {
      const s = await askCommand(prompt, screenText(term, 40), live.current.where);
      if (!sessionId.current) return;
      // Replace whatever is at the prompt with the command — NOT run.
      live.current.write("\x05\x15" + s.command);
      setAskOpen(false);
      setAskText("");
      setAskNote({ text: (s.explanation ? s.explanation + " — " : "") + "press Enter to run it." });
      window.clearTimeout(askNoteTimer.current);
      askNoteTimer.current = window.setTimeout(() => setAskNote(null), 9000);
      term.focus();
    } catch (e) {
      setAskNote({ text: String(e), err: true });
    } finally {
      setAskBusy(false);
    }
  }

  /** Keydown hook for the terminal (call first in extraKeys). */
  function onKey(term: Terminal, ev: KeyboardEvent): boolean | undefined {
    const mod = IS_APPLE ? ev.metaKey && !ev.ctrlKey : ev.ctrlKey && ev.shiftKey;
    if (mod && !ev.altKey && ev.key.toLowerCase() === "i" && enabled()) {
      openAsk();
      return false;
    }
    const plain = !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    if (ev.key !== "Enter" || !plain || !sessionId.current) return undefined;
    const buf = term.buffer.active;
    if (buf.type === "alternate") return undefined;
    const row = buf.baseY + buf.cursorY;
    // `# do something` at the prompt asks the AI instead of running.
    const upto = (buf.getLine(row)?.translateToString(true) ?? "").slice(0, buf.cursorX);
    const hash = /[$#%>❯»]\s+#\s*(\S.*)$/.exec(upto);
    if (hash && enabled()) {
      live.current.write("\x05\x15");
      openAsk(hash[1].trim(), true);
      return false;
    }
    // Remember the command so its output can be checked for errors.
    const ext = extractInput(term);
    setErrChip(null);
    errWatch.current = ext && ext.input.trim() ? { cmd: ext.input.trim(), row, out: "", shown: false } : null;
    return undefined;
  }

  /** Feed decoded shell output (call from the data listener). */
  function onOutput(chunk: string) {
    taps.current.forEach((fn) => fn(chunk));
    const w = errWatch.current;
    if (w && !busy.current && !w.shown && w.out.length < 64 * 1024) {
      w.out += chunk;
      window.clearTimeout(errTimer.current);
      errTimer.current = window.setTimeout(checkError, 700);
    }
  }

  /** Whether the data listener needs to decode output at all. */
  const wantsOutput = () => taps.current.size > 0 || !!errWatch.current;

  const connected = !!sessionId.current;

  const overlay: ReactNode = (
    <>
      {connected && askOpen && (
        <div className="term-ai-bar">
          <Icon name="sparkles" size={14} className="term-ai-icon" />
          <input
            ref={askInputRef}
            value={askText}
            onChange={(e) => setAskText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !askBusy) runAsk(askText);
              if (e.key === "Escape") closeAsk();
            }}
            placeholder="Describe a command — e.g. find the 10 biggest files in /var/log"
            disabled={askBusy}
            spellCheck={false}
            aria-label="Ask AI for a command"
          />
          {askBusy ? (
            <span className="term-ai-busy">
              <Spinner size={13} /> Thinking…
            </span>
          ) : (
            <button className="term-ai-go" onClick={() => runAsk(askText)} disabled={!askText.trim()}>
              Insert
            </button>
          )}
          <button className="icon" title="Close (Esc)" onClick={closeAsk}>
            <Icon name="x" size={13} />
          </button>
          {askNote?.err && <div className="term-ai-note err">{askNote.text}</div>}
        </div>
      )}
      {connected && !askOpen && askNote && (
        <div className={"term-ai-toast" + (askNote.err ? " err" : "")} onClick={() => setAskNote(null)}>
          <Icon name="sparkles" size={12} /> {askNote.text}
        </div>
      )}
      {connected && errChip && !askOpen && (
        <div className="term-ai-err">
          <button className="term-ai-err-go" onClick={explainError} title={errChip.cmd}>
            <Icon name="sparkles" size={12} /> Explain error
          </button>
          <button className="icon" title="Dismiss" onClick={() => setErrChip(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
    </>
  );

  /** Props for <AiChat>: the terminal agent when "run in terminal" is on. */
  function chatProps(fallback: { makeToolset: () => Toolset; buildSystem: () => string }) {
    return {
      makeToolset: () =>
        inTerm && termRef.current
          ? makeTerminalToolset({
              term: termRef.current,
              write: (d: string) => live.current.write(d),
              tap: (fn: (c: string) => void) => {
                taps.current.add(fn);
                return () => {
                  taps.current.delete(fn);
                };
              },
              sessionId: () => sessionId.current,
              helper,
              busy,
            })
          : fallback.makeToolset(),
      buildSystem: () => (inTerm ? terminalSystemPrompt(live.current.where) : fallback.buildSystem()),
      headerExtra: (
        <button
          className={"icon ai-term-toggle" + (inTerm ? " on" : "")}
          title={
            inTerm
              ? "Commands run in the terminal, where you can watch them (click to run them in the background instead)"
              : "Commands run in the background (click to run them in the terminal instead)"
          }
          onClick={() => setInTerm((v) => !v)}
        >
          <Icon name="terminal" size={14} />
        </button>
      ),
      inject,
      onInjected: () => setInject(null),
    };
  }

  return { onKey, onOutput, wantsOutput, overlay, chatProps, askOpen, openAsk, closeAsk, label };
}
