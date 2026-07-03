import type { Terminal } from "@xterm/xterm";

/**
 * Fish-style inline autosuggestions + a dropdown of choices for the terminal.
 *
 * A per-host command history is kept locally (localStorage). While typing at a
 * shell prompt, the top history matches are listed in a small dropdown at the
 * prompt and the selected match's remainder is drawn as gray "ghost text" at
 * the cursor. ↑/↓ move the selection, → (at end of line) or a click accepts,
 * Esc dismisses, Enter runs the line as typed and records it. Commands are
 * recorded by reading the ECHOED prompt line from the terminal buffer — so
 * hidden input (password prompts) is never captured.
 */

const LIMIT = 500;
const MAX_CHOICES = 6;
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

/** Most-recent history entries extending `input` (MRU order). */
function matchesFrom(history: string[], input: string): string[] {
  if (input.length < 2) return [];
  const out: string[] = [];
  for (const h of history) {
    if (h.startsWith(input) && h.length > input.length) {
      out.push(h);
      if (out.length >= MAX_CHOICES) break;
    }
  }
  return out;
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
 * Attach ghost-text + dropdown autosuggestions to a terminal.
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

  const list = document.createElement("div");
  list.className = "term-sugg";
  list.style.display = "none";
  container.appendChild(list);

  let input = "";
  let matches: string[] = [];
  let sel = 0;
  let timer = 0;

  function hide() {
    input = "";
    matches = [];
    sel = 0;
    ghost.style.display = "none";
    list.style.display = "none";
  }

  function accept(i: number) {
    const m = matches[i];
    if (m) send(m.slice(input.length));
    hide();
  }

  /** Repaint the ghost + dropdown at the current cursor/selection. */
  function render() {
    if (!matches.length) {
      hide();
      return;
    }
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) {
      hide();
      return;
    }
    const buf = term.buffer.active;
    const vRow = buf.baseY + buf.cursorY - buf.viewportY;
    if (vRow < 0 || vRow >= term.rows) {
      hide();
      return;
    }
    const cellW = screen.clientWidth / term.cols;
    const cellH = screen.clientHeight / term.rows;
    const sr = screen.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    const font = term.options.fontFamily ?? "courier-new, courier, monospace";
    const fontSize = `${term.options.fontSize ?? 14}px`;

    // Ghost: the SELECTED match's remainder, at the cursor.
    ghost.textContent = matches[sel].slice(input.length);
    ghost.style.display = "block";
    ghost.style.left = `${sr.left - cr.left + buf.cursorX * cellW}px`;
    ghost.style.top = `${sr.top - cr.top + vRow * cellH}px`;
    ghost.style.fontFamily = font;
    ghost.style.fontSize = fontSize;
    ghost.style.lineHeight = `${cellH}px`;

    // Dropdown: full candidates, aligned with the start of the typed input,
    // below the prompt line (above it when too close to the bottom).
    list.replaceChildren(
      ...matches.map((m, i) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "term-sugg-item" + (i === sel ? " sel" : "");
        const pre = document.createElement("span");
        pre.className = "pre";
        pre.textContent = input;
        item.append(pre, document.createTextNode(m.slice(input.length)));
        // mousedown (not click) so the terminal never loses focus.
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          accept(i);
        });
        return item;
      }),
    );
    list.style.display = "flex";
    list.style.fontFamily = font;
    list.style.fontSize = fontSize;
    const inputStartX = Math.max(0, buf.cursorX - input.length);
    list.style.left = `${sr.left - cr.left + inputStartX * cellW}px`;
    const estH = matches.length * (cellH + 6) + 10;
    const below = (vRow + 1) * cellH + estH < container.clientHeight;
    list.style.top = below ? `${sr.top - cr.top + (vRow + 1) * cellH + 2}px` : "";
    list.style.bottom = below ? "" : `${cr.height - (sr.top - cr.top) - vRow * cellH + 2}px`;
  }

  function update() {
    const cur = extractInput(term);
    if (!cur) {
      hide();
      return;
    }
    if (cur !== input) sel = 0; // fresh input resets the selection
    input = cur;
    matches = matchesFrom(loadHistory(owner()), input);
    render();
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
    const plain = !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    if (ev.key === "Enter" && plain) {
      const cur = extractInput(term);
      if (cur) recordCommand(owner(), cur);
      hide();
      return true;
    }
    if (matches.length && plain) {
      if (ev.key === "ArrowRight") {
        accept(sel);
        return false;
      }
      if (ev.key === "ArrowDown") {
        sel = (sel + 1) % matches.length;
        render();
        return false;
      }
      if (ev.key === "ArrowUp") {
        sel = (sel - 1 + matches.length) % matches.length;
        render();
        return false;
      }
    }
    if (ev.key === "Escape") hide(); // still passes through to the shell
    return true;
  });

  return {
    dispose() {
      window.clearTimeout(timer);
      disposables.forEach((d) => d.dispose());
      ghost.remove();
      list.remove();
    },
  };
}
