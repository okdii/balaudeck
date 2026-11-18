import { EditorSelection, Prec, type SelectionRange } from "@codemirror/state";
import { keymap, type Command } from "@codemirror/view";
import { addCursorAbove, addCursorBelow } from "@codemirror/commands";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";

/**
 * Sublime Text's "Split into Lines" (Ctrl/Cmd+Shift+L): every line touched by a
 * selection gets its own selection covering that line's part of it, so one edit
 * (typing, Home/End, deleting) applies to every line at once. A selection that
 * ends at column 0 of the next line doesn't drag that line in, matching Sublime.
 */
export const splitSelectionByLine: Command = (view) => {
  const { state } = view;
  const out: SelectionRange[] = [];
  let changed = false;
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from);
    let last = state.doc.lineAt(r.to);
    if (r.empty || first.number === last.number) {
      out.push(r);
      continue;
    }
    if (r.to === last.from) last = state.doc.line(last.number - 1);
    for (let n = first.number; n <= last.number; n++) {
      const line = state.doc.line(n);
      out.push(EditorSelection.range(Math.max(line.from, r.from), Math.min(line.to, r.to)));
    }
    changed = true;
  }
  if (!changed) return false;
  view.dispatch({
    selection: EditorSelection.create(out, out.length - 1),
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
};

/**
 * Sublime-style multi-cursor keys for the SQL editor, on top of what CodeMirror's
 * basic setup already gives (Cmd/Ctrl+click adds a cursor, Alt+drag selects a
 * column, Cmd/Ctrl+D adds the next match, Esc goes back to one cursor).
 * Highest precedence so Ctrl/Cmd+Shift+L splits lines instead of CodeMirror's
 * default "select all matches", which moves to Alt+F3 / Ctrl+Cmd+G like Sublime.
 */
export const sublimeMultiCursor = Prec.highest(
  keymap.of([
    { key: "Mod-Shift-l", run: splitSelectionByLine, preventDefault: true },
    { key: "Ctrl-Shift-l", run: splitSelectionByLine, preventDefault: true },
    { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
    { key: "Alt-F3", run: selectSelectionMatches, preventDefault: true },
    { mac: "Ctrl-Mod-g", run: selectSelectionMatches, preventDefault: true },
    // Sublime (Windows/Linux) adds cursors with Ctrl+Alt+Up/Down; on macOS
    // CodeMirror's Cmd+Alt+Up/Down already does it.
    { key: "Ctrl-Alt-ArrowUp", run: addCursorAbove, preventDefault: true },
    { key: "Ctrl-Alt-ArrowDown", run: addCursorBelow, preventDefault: true },
  ]),
);
