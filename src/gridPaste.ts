// Paste a block of cells (from Excel, Numbers, Google Sheets, a CSV file, or
// BalauDeck's own "Copy as TSV") onto the result grid. Pure — no DOM, no React.
//
//  * Spreadsheets put TSV on the clipboard, quoting a cell that holds a tab,
//    newline or quote ("a ""b""" → a "b"); CSV is accepted when every line has
//    the same number of commas; anything else is one value per line.
//  * The block lands with its top-left on the selection's top-left. When the
//    selection is a whole multiple of the block (one value onto a column range,
//    one row onto many rows) the block is tiled to fill it, as spreadsheets do.
//  * Rows that run past the last loaded row become new rows (INSERTs) — the
//    caller asks first.
//  * The literal text NULL becomes SQL NULL; an empty cell stays an empty string
//    (or leaves a NULL cell untouched).

export type Delim = "\t" | "," | "";

export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** Top-left / bottom-right form of a (possibly reversed) anchor→focus range. */
export function normRange(s: CellRange): CellRange {
  return {
    r0: Math.min(s.r0, s.r1),
    c0: Math.min(s.c0, s.c1),
    r1: Math.max(s.r0, s.r1),
    c1: Math.max(s.c0, s.c1),
  };
}

export function inRange(s: CellRange | null, r: number, c: number): boolean {
  if (!s) return false;
  const n = normRange(s);
  return r >= n.r0 && r <= n.r1 && c >= n.c0 && c <= n.c1;
}

/** Quote-aware split of delimited text into rows of fields. */
export function parseDelimited(text: string, delim: "\t" | ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  let atStart = true; // at the start of a field (a quote here opens a quoted field)
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
      i++;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = "";
      atStart = true;
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      atStart = true;
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    atStart = false;
    i++;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** Which delimiter the clipboard text uses. */
export function detectDelim(text: string): Delim {
  if (text.includes("\t")) return "\t";
  const lines = text.split(/\r?\n/);
  if (lines.length > 1) {
    const counts = parseDelimited(text, ",").map((r) => r.length);
    if (counts[0] > 1 && counts.every((n) => n === counts[0])) return ",";
  }
  return "";
}

/** Clipboard text → rows of cells. The one trailing newline spreadsheets add
 *  is dropped; an empty clipboard gives []. */
export function parseClipboard(text: string): string[][] {
  const t = text.replace(/\r?\n$/, "");
  if (t === "") return text === "" ? [] : [[""]];
  const d = detectDelim(t);
  if (d === "") return t.split(/\r?\n/).map((l) => [l]);
  return parseDelimited(t, d);
}

export interface PastePlan {
  /** Cell values for existing rows (null = SQL NULL). */
  cells: { r: number; c: number; v: string | null }[];
  /** Rows beyond the loaded ones: values for columns [startCol, startCol + n). */
  newRows: (string | null)[][];
  startCol: number;
  /** Values dropped: past the last column, or on a column that can't be edited. */
  skipped: number;
  /** The first line matched the column names and was not pasted. */
  droppedHeader: boolean;
}

const toVal = (s: string): string | null => (s === "NULL" ? null : s);

export function planPaste(opts: {
  matrix: string[][];
  sel: CellRange;
  columns: string[];
  rowCount: number;
  canEdit: (c: number) => boolean;
}): PastePlan {
  const { columns, rowCount, canEdit } = opts;
  const sel = normRange(opts.sel);
  let m = opts.matrix;
  let droppedHeader = false;
  if (m.length > 1) {
    const head = m[0].map((s) => s.trim());
    const want = columns.slice(sel.c0, sel.c0 + head.length);
    if (head.length > 1 && head.length === want.length && head.every((h, i) => h === want[i])) {
      m = m.slice(1);
      droppedHeader = true;
    }
  }
  const plan: PastePlan = { cells: [], newRows: [], startCol: sel.c0, skipped: 0, droppedHeader };
  if (!m.length) return plan;
  const mh = m.length;
  const mw = Math.max(...m.map((r) => r.length));
  const sh = sel.r1 - sel.r0 + 1;
  const sw = sel.c1 - sel.c0 + 1;
  // Tile when the selection is bigger than one cell and an exact multiple.
  const tile = sh * sw > 1 && sh % mh === 0 && sw % mw === 0 && (sh > mh || sw > mw);
  const rows = tile ? sh : mh;
  const cols = tile ? sw : mw;
  for (let i = 0; i < rows; i++) {
    const src = m[i % mh];
    const r = sel.r0 + i;
    if (r >= rowCount) {
      // Overflow → a new row; keep the column span the block covers.
      const vals: (string | null)[] = [];
      for (let j = 0; j < cols && sel.c0 + j < columns.length; j++) {
        const s = src[j % mw];
        vals.push(s === undefined ? "" : toVal(s));
      }
      plan.newRows.push(vals);
      continue;
    }
    for (let j = 0; j < cols; j++) {
      const s = src[j % mw];
      if (s === undefined) continue; // ragged line — leave the cell as is
      const c = sel.c0 + j;
      if (c >= columns.length || !canEdit(c)) {
        plan.skipped++;
        continue;
      }
      plan.cells.push({ r, c, v: toVal(s) });
    }
  }
  return plan;
}
