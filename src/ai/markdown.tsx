// Minimal, safe Markdown → React for assistant messages. Handles headings,
// bullet/numbered lists, fenced code blocks, blockquotes, and inline **bold**,
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

const isSpecial = (l: string) => /^```|^#{1,4}\s|^\s*[-*]\s|^\s*\d+\.\s|^\s*>\s?/.test(l);

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
