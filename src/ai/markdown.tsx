// Minimal, safe Markdown → React for assistant messages. Handles headings,
// bullet/numbered lists, fenced code blocks, blockquotes, GFM tables, and inline **bold**,
// *italic*, `code`, and [links](url). No raw HTML is ever emitted (everything
// goes through React text/elements), so model output can't inject markup.

import type { ReactNode } from "react";

let seq = 0;
const key = () => `md${seq++}`;

const INLINE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)]+\))/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) out.push(<code key={key()}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={key()}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t);
      if (mm) {
        out.push(
          <a key={key()} href={mm[2]} target="_blank" rel="noreferrer">
            {mm[1]}
          </a>,
        );
      } else out.push(t);
    } else out.push(<em key={key()}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isSpecial = (l: string) =>
  /^```|^#{1,4}\s|^\s*[-*]\s|^\s*\d+\.\s|^\s*>\s?|^\s*\|/.test(l);

// GFM table: a pipe row followed by a |---|:--:| separator row.
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isRow = (l: string) => l.includes("|") && l.trim() !== "";

/** Split a table row into cells; `\|` and pipes inside `code` stay in the cell. */
export function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (c === "\\" && t[k + 1] === "|") {
      cur += "|";
      k++;
    } else if (c === "`") {
      inCode = !inCode;
      cur += c;
    } else if (c === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

type Align = "left" | "right" | "center" | undefined;
const alignOf = (c: string): Align => {
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : undefined;
};
// Numbers (amounts, counts, ids) read better right-aligned when the model
// didn't say otherwise.
const NUMERIC = /^[-+]?(RM\s?|\$)?[\d,]+(\.\d+)?%?$/;

function table(header: string[], aligns: Align[], rows: string[][]): ReactNode {
  const n = header.length;
  const numeric = header.map(
    (_, c) => rows.length > 0 && rows.every((r) => !r[c] || NUMERIC.test(r[c])) && rows.some((r) => r[c]),
  );
  const al = (c: number): Align => aligns[c] ?? (numeric[c] ? "right" : undefined);
  // Copy as tab-separated text so it pastes straight into a spreadsheet.
  const plain = (c: string) => c.replace(/\*\*|`/g, "");
  const tsv = [header, ...rows].map((r) => r.map(plain).join("\t")).join("\n");
  return (
    <div key={key()} className="ai-md-table-block">
      <div className="ai-md-table-meta">
        <span>
          {rows.length} row{rows.length === 1 ? "" : "s"}
        </span>
        <button
          className="ai-md-table-copy"
          title="Copy as tab-separated text (pastes into Excel / Sheets)"
          onClick={(e) => {
            const b = e.currentTarget;
            navigator.clipboard
              ?.writeText(tsv)
              .then(() => {
                b.textContent = "Copied";
                setTimeout(() => (b.textContent = "Copy"), 1200);
              })
              .catch(() => {});
          }}
        >
          Copy
        </button>
      </div>
      <div className="ai-md-table-wrap">
      <table className="ai-md-table">
        <thead>
          <tr>
            {header.map((h, c) => (
              <th key={c} style={{ textAlign: al(c) }}>
                {inline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {Array.from({ length: n }, (_, c) => (
                <td key={c} style={{ textAlign: al(c) }}>
                  {inline(r[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((it) => <li key={key()}>{inline(it)}</li>);
    blocks.push(
      list.ordered ? <ol key={key()}>{items}</ol> : <ul key={key()}>{items}</ul>,
    );
    list = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <pre key={key()} className="ai-md-code">
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (isRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      flush();
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isRow(lines[i]) && !TABLE_SEP.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push(table(header, aligns, rows));
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push(
        <div key={key()} className={"ai-md-h ai-md-h" + h[1].length}>
          {inline(h[2])}
        </div>,
      );
      i++;
      continue;
    }

    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(ul ? ul[1] : ol![1]);
      i++;
      continue;
    }

    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq) {
      flush();
      blocks.push(
        <blockquote key={key()} className="ai-md-quote">
          {inline(bq[1])}
        </blockquote>,
      );
      i++;
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    // Paragraph: gather consecutive plain lines.
    flush();
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={key()} className="ai-md-p">
        {inline(para.join(" "))}
      </p>,
    );
  }
  flush();
  return blocks;
}
