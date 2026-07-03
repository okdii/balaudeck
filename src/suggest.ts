import type { Terminal } from "@xterm/xterm";

/**
 * Fish-style inline autosuggestions for the terminal.
 *
 * A per-host command history is kept locally (localStorage). While typing at a
 * shell prompt, the best history match's remainder is drawn as gray "ghost
 * text" at the cursor; press → (at end of line) to accept it. Commands are
 * recorded when Enter is pressed, by reading the ECHOED prompt line from the
 * terminal buffer — so hidden input (password prompts) is never captured.
 */

const LIMIT = 500;
const key = (owner: string) => `balaudeck.hist.${owner}`;

function loadHistory(owner: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key(owner)) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function recordCommand(owner: string, cmd: string) {
  const c = cmd.trim();
  // Skip trivial input; single chars (y/n answers etc.) aren't worth suggesting.
  if (c.length < 3) return;
  const h = loadHistory(owner).filter((x) => x !== c);
  h.unshift(c);
  if (h.length > LIMIT) h.length = LIMIT;
  try {
    localStorage.setItem(key(owner), JSON.stringify(h));
  } catch {
    /* storage full/unavailable — suggestions just won't learn */
  }
}

/** Most-recent history entry extending `input`, or null. */
function suggestFrom(history: string[], input: string): string | null {
  if (input.length < 2) return null;
  const hit = history.find((h) => h.startsWith(input) && h.length > input.length);
  return hit ? hit.slice(input.length) : null;
}

/**
 * The user's input on the current prompt line, or null when not at a prompt.
 * Reads the buffer's cursor line and takes the text after the last shell
 * prompt marker ($ # % > ❯ »). Returns null in alternate-screen apps (vim,
 * htop…), when no marker is found (program output), or mid-line editing.
 */
function extractInput(term: Terminal): string | null {
  const buf = term.buffer.active;
  if (buf.type === "alternate") return null;
  const row = buf.baseY + buf.cursorY;
  const line = buf.getLine(row);
  if (!line) return null;
  const text = line.translateToString(true);
  // Only suggest when the cursor sits at the end of the typed text.
  if (text.slice(buf.cursorX).trim() !== "") return null;
  const upto = text.slice(0, buf.cursorX);
  const m = upto.match(/^.*[$#%>❯»]\s(.*)$/);
  if (!m) return null;
  return m[1];
}

export interface Autosuggest {
  dispose: () => void;
}

/**
 * Attach ghost-text autosuggestions to a terminal.
 * `owner()` keys the history (e.g. "ssh:user@host"); `send()` writes the
 * accepted remainder to the backend (pty/ssh channel).
 */
export function attachAutosuggest(opts: {
  term: Terminal;
  container: HTMLElement;
  owner: () => string;
  send: (data: string) => void;
}): Autosuggest {
  const { term, container, owner, send } = opts;

  const ghost = document.createElement("span");
  ghost.className = "term-ghost";
  ghost.style.display = "none";
  container.appendChild(ghost);

  let remainder = "";
  let timer = 0;

  function hide() {
    remainder = "";
    ghost.style.display = "none";
  }

  function update() {
    const input = extractInput(term);
    const sug = input ? suggestFrom(loadHistory(owner()), input) : null;
    if (!sug) {
      hide();
      return;
    }
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) {
      hide();
      return;
    }
    const buf = term.buffer.active;
    // Cursor row relative to the viewport; hidden while scrolled back.
    const vRow = buf.baseY + buf.cursorY - term.buffer.active.viewportY;
    if (vRow < 0 || vRow >= term.rows) {
      hide();
      return;
    }
    const cellW = screen.clientWidth / term.cols;
    const cellH = screen.clientHeight / term.rows;
    const sr = screen.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    remainder = sug;
    ghost.textContent = sug;
    ghost.style.display = "block";
    ghost.style.left = `${sr.left - cr.left + buf.cursorX * cellW}px`;
    ghost.style.top = `${sr.top - cr.top + vRow * cellH}px`;
    ghost.style.fontFamily = term.options.fontFamily ?? "courier-new, courier, monospace";
    ghost.style.fontSize = `${term.options.fontSize ?? 14}px`;
    ghost.style.lineHeight = `${cellH}px`;
  }

  function scheduleUpdate() {
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 30);
  }

  const disposables = [
    term.onWriteParsed(scheduleUpdate),
    term.onScroll(scheduleUpdate),
    term.onResize(hide),
  ];

  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== "keydown") return true;
    if (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      const input = extractInput(term);
      if (input) recordCommand(owner(), input);
      hide();
      return true;
    }
    if (
      remainder &&
      ev.key === "ArrowRight" &&
      !ev.shiftKey &&
      !ev.ctrlKey &&
      !ev.altKey &&
      !ev.metaKey
    ) {
      // Accept the suggestion: type the remainder into the shell ourselves.
      send(remainder);
      hide();
      return false;
    }
    if (ev.key === "Escape") hide(); // still passes through to the shell
    return true;
  });

  return {
    dispose() {
      window.clearTimeout(timer);
      disposables.forEach((d) => d.dispose());
      ghost.remove();
    },
  };
}
