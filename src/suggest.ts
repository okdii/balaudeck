import type { Terminal } from "@xterm/xterm";

/**
 * Fish-style inline autosuggestions + a dropdown of choices for the terminal.
 *
 * Two suggestion sources, merged:
 *  1. Per-host command history (localStorage) prefix-matched on the input.
 *  2. REAL directory entries for the path being typed — fetched through
 *     `listDir` (ssh: `ls` on a second exec channel; local: read_dir), so a
 *     folder is only suggested when it actually exists in the current path.
 *
 * The selected match's remainder is drawn as gray "ghost text" at the cursor.
 * ↑/↓ move the selection, → (at end of line) or a click accepts, Esc
 * dismisses, Enter runs the line as typed and records it. Commands are
 * recorded by reading the ECHOED prompt line from the terminal buffer — so
 * hidden input (password prompts) is never captured.
 */

const LIMIT = 500;
const MAX_CHOICES = 6;
const MAX_ROWS = 8;
const DIR_TTL_MS = 5000;
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

/** Commands whose next argument is very likely a path. */
const PATH_CMDS = new Set([
  "cd", "ls", "cat", "less", "more", "tail", "head", "vi", "vim", "nano",
  "rm", "cp", "mv", "mkdir", "rmdir", "touch", "stat", "du", "chmod",
  "chown", "tar", "unzip", "zip", "find", "grep", "code", "source", ".",
]);

/** The path being typed (dir part + base prefix), or null. */
function pathContext(input: string): { dir: string; base: string } | null {
  if (!input) return null;
  const tokens = input.split(/\s+/);
  const first = tokens[0];
  const last = input.endsWith(" ") ? "" : tokens[tokens.length - 1];
  if (last.includes("/")) {
    const i = last.lastIndexOf("/");
    return { dir: last.slice(0, i + 1), base: last.slice(i + 1) };
  }
  // Bare word: only treat it as a path when the command expects one.
  if ((tokens.length >= 2 || input.endsWith(" ")) && PATH_CMDS.has(first)) {
    return { dir: "", base: last };
  }
  return null;
}

/**
 * The user's input on the current prompt line + the cwd shown in the prompt
 * (PS1 like `user@host:~/dir$`), or null when not at a prompt. Reads the
 * buffer's cursor line after the last shell prompt marker ($ # % > ❯ »).
 * Null in alternate-screen apps (vim, htop…) or when no marker is found.
 */
function extractInput(term: Terminal): { input: string; cwd: string | null } | null {
  const buf = term.buffer.active;
  if (buf.type === "alternate") return null;
  const row = buf.baseY + buf.cursorY;
  const line = buf.getLine(row);
  if (!line) return null;
  const text = line.translateToString(true);
  // Only suggest when the cursor sits at the end of the typed text.
  if (text.slice(buf.cursorX).trim() !== "") return null;
  const upto = text.slice(0, buf.cursorX);
  const m = upto.match(/^(.*)[$#%>❯»]\s(.*)$/);
  if (!m) return null;
  const promptSeg = m[1];
  const pm = promptSeg.match(/(~(?:\/[^\s:]*)?|\/[^\s:]*)\s*$/);
  return { input: m[2], cwd: pm ? pm[1] : null };
}

/** Shell command that lists `dir` (relative to `cwd`) one-entry-per-line with
 * a trailing `/` on directories. Exported for the SSH panel's ssh_exec. */
export function remoteLsCommand(cwd: string | null, dir: string): string {
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  const expr = (p: string): string =>
    p === "~" ? '"$HOME"' : p.startsWith("~/") ? `"$HOME"${q(p.slice(1))}` : q(p);
  const cd = cwd ? `cd ${expr(cwd)} 2>/dev/null; ` : "";
  const target = dir === "" ? "'.'" : expr(dir);
  return `${cd}ls -1ap -- ${target} 2>/dev/null | head -300`;
}

export interface Autosuggest {
  dispose: () => void;
}

/**
 * Attach ghost-text + dropdown autosuggestions to a terminal.
 * `owner()` keys the history (e.g. "ssh:user@host"); `send()` writes the
 * accepted remainder to the backend; `listDir` (optional) returns the entries
 * of a directory so path completions reflect what actually exists.
 */
export function attachAutosuggest(opts: {
  term: Terminal;
  container: HTMLElement;
  owner: () => string;
  send: (data: string) => void;
  listDir?: (cwd: string | null, dir: string) => Promise<string[]>;
}): Autosuggest {
  const { term, container, owner, send, listDir } = opts;

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
  let fetchSeq = 0;
  const dirCache = new Map<string, { ts: number; entries: string[] }>();

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

  /** Directory entries via listDir with a short-lived cache. */
  async function entriesFor(cwd: string | null, dir: string): Promise<string[]> {
    if (!listDir) return [];
    const cacheKey = `${cwd ?? ""}|${dir}`;
    const hit = dirCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < DIR_TTL_MS) return hit.entries;
    let entries: string[] = [];
    try {
      entries = await listDir(cwd, dir);
    } catch {
      /* unreachable dir / no session — no path suggestions */
    }
    dirCache.set(cacheKey, { ts: Date.now(), entries });
    return entries;
  }

  function update() {
    const ext = extractInput(term);
    if (!ext) {
      hide();
      return;
    }
    if (ext.input !== input) sel = 0; // fresh input resets the selection
    input = ext.input;
    const hist = matchesFrom(loadHistory(owner()), input);
    matches = hist;
    render();

    // Path completions arrive async; merge them in if the input is unchanged.
    const ctx = pathContext(input);
    if (!ctx || !listDir) return;
    const seq = ++fetchSeq;
    const typed = input;
    void entriesFor(ext.cwd, ctx.dir).then((entries) => {
      if (seq !== fetchSeq || typed !== input) return; // stale keystroke
      const showHidden = ctx.base.startsWith(".");
      const comps = entries
        .filter((e) => e !== "./" && e !== "../")
        .filter((e) => showHidden || !e.startsWith("."))
        .filter((e) => e.startsWith(ctx.base) && e.length > ctx.base.length)
        .slice(0, MAX_CHOICES)
        .map((e) => typed + e.slice(ctx.base.length));
      if (!comps.length) return;
      const merged = [...hist];
      for (const c of comps) {
        if (!merged.includes(c)) merged.push(c);
        if (merged.length >= MAX_ROWS) break;
      }
      matches = merged;
      if (sel >= matches.length) sel = 0;
      render();
    });
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
      const ext = extractInput(term);
      if (ext) recordCommand(owner(), ext.input);
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
