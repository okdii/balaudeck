/** Minimal RFC-4180-ish CSV/TSV parser — quotes, escaped `""`, CRLF/LF. Shared
 *  by the table CSV import and the Import Wizard. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const n = text.length;
  const d = delimiter || ",";
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === d) {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // swallow; the paired \n (or a lone \n) ends the record
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Flush a trailing field/row when the file has no final newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Best-guess field delimiter from the first line (`,`, `;`, or tab). */
export function guessDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let hi = -1;
  for (const d of [",", ";", "\t"]) {
    const c = first.split(d).length - 1;
    if (c > hi) {
      hi = c;
      best = d;
    }
  }
  return best;
}
