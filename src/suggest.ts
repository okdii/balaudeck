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
/** Persistent per-host directory index: max dirs kept / entries per dir / age. */
const INDEX_DIRS = 50;
const INDEX_ENTRIES = 400;
const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const key = (owner: string) => `balaudeck.hist.${owner}`;
const dirsKey = (owner: string) => `balaudeck.dirs.${owner}`;

type DirIndex = Record<string, { t: number; e: string[] }>;

function loadDirIndex(owner: string): DirIndex {
  try {
    const raw = JSON.parse(localStorage.getItem(dirsKey(owner)) ?? "{}");
    return raw && typeof raw === "object" ? (raw as DirIndex) : {};
  } catch {
    return {};
  }
}

function saveDirEntries(owner: string, dirKeyStr: string, entries: string[]) {
  if (!entries.length) return;
  const idx = loadDirIndex(owner);
  idx[dirKeyStr] = { t: Date.now(), e: entries.slice(0, INDEX_ENTRIES) };
  // LRU cap: drop the oldest dirs beyond the limit.
  const keys = Object.keys(idx);
  if (keys.length > INDEX_DIRS) {
    keys
      .sort((a, b) => idx[a].t - idx[b].t)
      .slice(0, keys.length - INDEX_DIRS)
      .forEach((k) => delete idx[k]);
  }
  try {
    localStorage.setItem(dirsKey(owner), JSON.stringify(idx));
  } catch {
    /* storage full — the live ls path still works */
  }
}

/** Canonical index key for a dir being typed, resolved against the prompt cwd. */
function resolveDirKey(cwd: string | null, dir: string): string | null {
  let d = dir === "" ? "." : dir;
  if (d === ".") {
    if (!cwd) return null;
    d = cwd;
  } else if (!d.startsWith("/") && !d.startsWith("~")) {
    if (!cwd) return null;
    d = `${cwd}/${d}`;
  }
  // Normalize: strip a trailing slash (except the root itself).
  if (d.length > 1 && d.endsWith("/")) d = d.slice(0, -1);
  return d;
}

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

/** Listing commands whose on-screen output we passively index. */
const LS_CMDS = new Set(["ls", "ll", "la", "l"]);

/** The dir a listing command targets ("." = cwd), or null when ambiguous. */
function lsTarget(input: string): string | null {
  const tokens = input.trim().split(/\s+/);
  if (!LS_CMDS.has(tokens[0])) return null;
  const args = tokens.slice(1).filter((t) => !t.startsWith("-"));
  if (args.length === 0) return ".";
  if (args.length === 1) return args[0];
  return null; // several paths listed at once — skip
}

/** Parse visible `ls` / `ls -l` output lines into entries (dirs get a `/`). */
function parseLsLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || /^total\s+\d/.test(t)) continue;
    const long = t.match(/^([bcdlps-])[rwxsStT+@.-]{9,}\s/);
    if (long) {
      // Long format: name = everything after the date/time field. Find the
      // last field in positions 5..8 that looks like a time (10:00), a year,
      // or an ISO date, and take what follows.
      const fields = t.split(/\s+/);
      let nameAt = -1;
      for (let i = 5; i < Math.min(fields.length, 9); i++) {
        if (/^(\d{1,2}:\d{2}(:\d{2})?|\d{4}|\d{4}-\d{2}-\d{2})$/.test(fields[i])) nameAt = i + 1;
      }
      if (nameAt < 0 || nameAt >= fields.length) continue;
      let name = fields.slice(nameAt).join(" ");
      if (long[1] === "l") name = name.split(" -> ")[0]; // symlink target
      if (!name || name === "." || name === "..") continue;
      out.push(long[1] === "d" ? `${name}/` : name);
    } else {
      // Columnar format: columns are padded with 2+ spaces.
      for (const cell of t.split(/\s{2,}/)) {
        const name = cell.trim();
        if (name && name !== "." && name !== ".." && name !== "./" && name !== "../") out.push(name);
      }
    }
    if (out.length >= INDEX_ENTRIES) break;
  }
  return out;
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
  /** Ran first for each keydown (xterm allows a single custom key handler, and
   * this module owns it): return false to swallow, true to pass to the shell,
   * undefined to continue into the autosuggest key logic. */
  extraKeys?: (ev: KeyboardEvent) => boolean | undefined;
}): Autosuggest {
  const { term, container, owner, send, listDir, extraKeys } = opts;

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
  // A just-run `ls`/`ll`: once the next prompt appears, its on-screen output is
  // parsed and saved into the persistent directory index (passive indexing).
  let pendingIndex: { row: number; dirKey: string; ts: number } | null = null;

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

  /** Directory entries: short-lived cache → persistent index (served stale
   * while a live listing refreshes it in the background) → live listDir. */
  async function entriesFor(cwd: string | null, dir: string): Promise<string[]> {
    if (!listDir) return [];
    const canon = resolveDirKey(cwd, dir);
    const cacheKey = canon ?? `raw:${cwd ?? ""}|${dir}`;
    const hit = dirCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < DIR_TTL_MS) return hit.entries;

    const fetchLive = async (): Promise<string[]> => {
      let entries: string[] = [];
      try {
        entries = await listDir(cwd, dir);
      } catch {
        /* unreachable dir / no session — no path suggestions */
      }
      dirCache.set(cacheKey, { ts: Date.now(), entries });
      if (canon && entries.length) saveDirEntries(owner(), canon, entries);
      return entries;
    };

    if (canon) {
      const idx = loadDirIndex(owner())[canon];
      if (idx && Date.now() - idx.t < INDEX_TTL_MS) {
        // Serve the indexed listing instantly; refresh live behind it and
        // repaint if the fresh listing differs in size.
        dirCache.set(cacheKey, { ts: Date.now(), entries: idx.e });
        void fetchLive().then((live) => {
          if (live.length && live.length !== idx.e.length) scheduleUpdate();
        });
        return idx.e;
      }
    }
    return fetchLive();
  }

  /** Parse the finished `ls`/`ll` output sitting between the command line and
   * the fresh prompt, and save it into the persistent directory index. */
  function harvestPending() {
    if (!pendingIndex) return;
    const { row, dirKey, ts } = pendingIndex;
    if (Date.now() - ts > 20_000) {
      pendingIndex = null;
      return;
    }
    const buf = term.buffer.active;
    const promptRow = buf.baseY + buf.cursorY;
    if (promptRow <= row) return; // output not finished yet
    pendingIndex = null;
    const lines: string[] = [];
    const start = Math.max(row + 1, promptRow - 200); // cap the scan
    for (let r = start; r < promptRow; r++) {
      const line = buf.getLine(r);
      if (line) lines.push(line.translateToString(true));
    }
    const entries = parseLsLines(lines);
    if (entries.length) {
      saveDirEntries(owner(), dirKey, entries);
      dirCache.set(dirKey, { ts: Date.now(), entries });
    }
  }

  function update() {
    const ext = extractInput(term);
    if (!ext) {
      hide();
      return;
    }
    harvestPending(); // a prompt is visible — index any finished ls output
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
      const real = entries.filter((e) => e !== "./" && e !== "../");
      if (!real.length) return; // no/failed listing — leave history as-is
      const showHidden = ctx.base.startsWith(".");
      // What actually exists leads the list.
      const comps = real
        .filter((e) => showHidden || !e.startsWith("."))
        .filter((e) => e.startsWith(ctx.base) && e.length > ctx.base.length)
        .slice(0, MAX_CHOICES)
        .map((e) => typed + e.slice(ctx.base.length));
      // History must agree with the real listing: keep a relative-path
      // suggestion only when its next segment exists in this directory
      // (absolute and ~ paths are cwd-independent and stay).
      const names = new Set(real.map((e) => (e.endsWith("/") ? e.slice(0, -1) : e)));
      const tokenStart = typed.length - ctx.dir.length - ctx.base.length;
      const validHist = hist.filter((h) => {
        const tok = h.slice(tokenStart).split(/\s+/)[0] ?? "";
        if (tok.startsWith("/") || tok.startsWith("~")) return true;
        const seg = tok.slice(ctx.dir.length).split("/")[0];
        return seg === "" || seg === "." || seg === ".." || names.has(seg);
      });
      const merged: string[] = [];
      for (const c of [...comps, ...validHist]) {
        if (!merged.includes(c)) merged.push(c);
        if (merged.length >= MAX_ROWS) break;
      }
      matches = merged; // possibly empty — every history hit was invalid here
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
    const extra = extraKeys?.(ev);
    if (extra !== undefined) return extra;
    const plain = !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey;
    if (ev.key === "Enter" && plain) {
      const ext = extractInput(term);
      if (ext) {
        recordCommand(owner(), ext.input);
        // If this is a listing command, arm the passive indexer: its output
        // will be parsed into the directory index when the prompt returns.
        const target = lsTarget(ext.input);
        const dirKey = target ? resolveDirKey(ext.cwd, target) : null;
        if (dirKey) {
          const buf = term.buffer.active;
          pendingIndex = { row: buf.baseY + buf.cursorY, dirKey, ts: Date.now() };
        }
      }
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
