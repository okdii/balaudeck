/** Format a query result (columns + rows) for copy-to-clipboard or file export.
 *  Pure and dialect-free — SQL INSERT statements are built by the caller, which
 *  owns the identifier-quoting and literal-escaping for the active engine.
 *  NULL collapses to an empty field in the flat formats (TSV/CSV/Markdown), the
 *  same convention the CSV export has always used; JSON preserves it as `null`. */
type Cell = string | null;

/** Tab-separated — the format spreadsheets accept on paste. */
export function toTsv(columns: string[], rows: Cell[][]): string {
  const esc = (v: Cell) => (v == null ? "" : v.replace(/\t/g, " ").replace(/\r?\n/g, " "));
  const head = columns.map(esc).join("\t");
  const body = rows.map((r) => r.map(esc).join("\t")).join("\n");
  return body ? `${head}\n${body}\n` : `${head}\n`;
}

/** RFC-4180-ish CSV (quotes fields containing comma/quote/newline). */
export function toCsv(columns: string[], rows: Cell[][]): string {
  const esc = (v: Cell) => (v == null ? "" : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = columns.map(esc).join(",");
  const body = rows.map((r) => r.map(esc).join(",")).join("\r\n");
  return body ? `${head}\r\n${body}\r\n` : `${head}\r\n`;
}

/** Array of row objects, keyed by column name; NULL stays `null`. */
export function toJson(columns: string[], rows: Cell[][]): string {
  const objs = rows.map((r) => {
    const o: Record<string, Cell> = {};
    columns.forEach((c, i) => (o[c] = r[i] ?? null));
    return o;
  });
  return JSON.stringify(objs, null, 2);
}

/** GitHub-flavoured Markdown table (escapes pipes, folds newlines to <br>). */
export function toMarkdown(columns: string[], rows: Cell[][]): string {
  const esc = (v: Cell) => (v == null ? "" : v.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"));
  const head = `| ${columns.map(esc).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n");
  return body ? `${head}\n${sep}\n${body}\n` : `${head}\n${sep}\n`;
}

/** One row's values as a single tab-separated line (no header) — for "copy row". */
export function rowToTsv(row: Cell[]): string {
  return row.map((v) => (v == null ? "" : v.replace(/\t/g, " ").replace(/\r?\n/g, " "))).join("\t");
}
