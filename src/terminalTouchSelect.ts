import type { Terminal } from "@xterm/xterm";
import { copyToClipboard } from "./clipboard";

/** Hold this long (without moving) to start a selection. */
const LONG_PRESS_MS = 450;
/** Finger travel that turns a press into a scroll instead. */
const MOVE_SLOP_PX = 10;

/**
 * Touch selection for xterm.js, which has none of its own (and phones have no
 * Cmd-C). Long-press a word to select it, keep the finger down and drag to
 * extend, then tap the floating "Copy" button. A plain swipe still scrolls and
 * a plain tap still focuses the terminal; tapping anywhere else clears.
 */
export function attachTouchSelect(term: Terminal, container: HTMLElement): () => void {
  const btn = document.createElement("button");
  btn.className = "term-touch-copy";
  btn.textContent = "Copy";
  btn.hidden = true;
  container.appendChild(btn);

  let timer = 0;
  let startX = 0;
  let startY = 0;
  let selecting = false;
  // Selection anchor (buffer coords) and the word it started on.
  let anchor = { col: 0, row: 0, end: 0 };

  /** Buffer cell under a viewport point, clamped to the grid. */
  const cellAt = (x: number, y: number) => {
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    const cellW = screen.clientWidth / term.cols;
    const cellH = screen.clientHeight / term.rows;
    const col = Math.min(term.cols - 1, Math.max(0, Math.floor((x - r.left) / cellW)));
    const vRow = Math.min(term.rows - 1, Math.max(0, Math.floor((y - r.top) / cellH)));
    return { col, row: term.buffer.active.viewportY + vRow };
  };

  /** [start, end] columns of the non-space run at a cell (just the cell if blank). */
  const wordAt = (col: number, row: number) => {
    const text = term.buffer.active.getLine(row)?.translateToString(false) ?? "";
    const blank = (i: number) => i < 0 || i >= text.length || /\s/.test(text[i]);
    if (blank(col)) return [col, col];
    let s = col;
    let e = col;
    while (!blank(s - 1)) s--;
    while (!blank(e + 1)) e++;
    return [s, e];
  };

  /** Select linearly from (c1,r1) to (c2,r2) inclusive, in either order. */
  const selectRange = (c1: number, r1: number, c2: number, r2: number) => {
    if (r2 < r1 || (r2 === r1 && c2 < c1)) [c1, r1, c2, r2] = [c2, r2, c1, r1];
    term.select(c1, r1, (r2 - r1) * term.cols + (c2 - c1) + 1);
  };

  const hideBtn = () => {
    btn.hidden = true;
  };
  const showBtn = (x: number, y: number) => {
    const cr = container.getBoundingClientRect();
    btn.hidden = false;
    const left = Math.min(Math.max(4, x - cr.left - btn.offsetWidth / 2), cr.width - btn.offsetWidth - 4);
    // Above the finger, or below it when too close to the top.
    const above = y - cr.top - btn.offsetHeight - 28;
    btn.style.left = `${left}px`;
    btn.style.top = `${above >= 4 ? above : y - cr.top + 28}px`;
  };

  const cancelTimer = () => {
    clearTimeout(timer);
    timer = 0;
  };

  const onStart = (e: TouchEvent) => {
    lastTouch = Date.now();
    if (e.target === btn) return;
    cancelTimer();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    // A new touch clears any old selection (a tap elsewhere = dismiss).
    if (term.hasSelection()) {
      term.clearSelection();
      hideBtn();
    }
    timer = window.setTimeout(() => {
      timer = 0;
      const cell = cellAt(startX, startY);
      if (!cell) return;
      const [s, end] = wordAt(cell.col, cell.row);
      anchor = { col: s, row: cell.row, end };
      selecting = true;
      selectRange(s, cell.row, end, cell.row);
    }, LONG_PRESS_MS);
  };

  const onMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    if (!selecting) {
      if (timer && Math.hypot(t.clientX - startX, t.clientY - startY) > MOVE_SLOP_PX) cancelTimer();
      return; // let xterm scroll
    }
    e.preventDefault();
    e.stopPropagation();
    const cell = cellAt(t.clientX, t.clientY);
    if (!cell) return;
    const forward = cell.row > anchor.row || (cell.row === anchor.row && cell.col >= anchor.col);
    if (forward) selectRange(anchor.col, anchor.row, Math.max(cell.col, cell.row === anchor.row ? anchor.end : 0), cell.row);
    else selectRange(cell.col, cell.row, anchor.end, anchor.row);
  };

  const onEnd = (e: TouchEvent) => {
    cancelTimer();
    if (!selecting) return;
    selecting = false;
    // Swallow the synthetic click so xterm doesn't clear the selection / pop the keyboard.
    e.preventDefault();
    e.stopPropagation();
    const t = e.changedTouches[0];
    if (term.hasSelection() && t) showBtn(t.clientX, t.clientY);
  };

  // A long-press also fires contextmenu (Android especially). xterm's own handler
  // would move its hidden textarea under the finger and focus it — popping the
  // keyboard and Android's Paste bubble over our selection — so swallow it here,
  // before it reaches xterm, when it comes from a touch.
  let lastTouch = 0;
  const onContextMenu = (e: Event) => {
    if (Date.now() - lastTouch < 1500) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onCopy = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    const text = term.getSelection();
    if (text) copyToClipboard(text).catch(() => {});
    term.clearSelection();
    hideBtn();
  };

  const opts: AddEventListenerOptions = { capture: true, passive: false };
  container.addEventListener("touchstart", onStart, opts);
  container.addEventListener("touchmove", onMove, opts);
  container.addEventListener("touchend", onEnd, opts);
  container.addEventListener("touchcancel", onEnd, opts);
  container.addEventListener("contextmenu", onContextMenu, true);
  btn.addEventListener("click", onCopy);
  // Output that scrolls or clears the screen drops the selection — drop the button too.
  const selSub = term.onSelectionChange(() => {
    if (!term.hasSelection()) hideBtn();
  });

  return () => {
    cancelTimer();
    container.removeEventListener("touchstart", onStart, opts);
    container.removeEventListener("touchmove", onMove, opts);
    container.removeEventListener("touchend", onEnd, opts);
    container.removeEventListener("touchcancel", onEnd, opts);
    container.removeEventListener("contextmenu", onContextMenu, true);
    selSub.dispose();
    btn.remove();
  };
}
