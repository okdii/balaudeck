// Minimal, dependency-free Markdown → HTML for note previews.
//
// Security: the source is HTML-escaped *first*, then only a known, fixed set of
// tags is emitted. No raw user HTML ever reaches the output, and link targets
// are restricted to an http(s)/mailto/relative allowlist — so the result is
// safe to inject with dangerouslySetInnerHTML.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Allow only safe link schemes; reject javascript:, data:, etc. */
function safeUrl(raw: string): string | null {
  const u = raw.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^[/#]/.test(u)) return u; // relative / anchor
  return null;
}

/** Inline spans on already-escaped text: code, links, bold, italic, strike. */
function inline(escaped: string): string {
  const tokens: string[] = [];
  // The \x00 sentinel can't occur in typed/escaped note text.
  const stash = (html: string) => `\x00${tokens.push(html) - 1}\x00`;
  // Protect code spans and links *before* the emphasis passes, so * _ ~ inside
  // a URL or code can't leak <em>/<strong>/<del> tags into the emitted markup.
  let s = escaped.replace(/`([^`]+)`/g, (_m, c) => stash(`<code>${c}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => {
    const safe = safeUrl(url);
    return safe
      ? stash(`<a href="${safe}" target="_blank" rel="noopener noreferrer">${txt}</a>`)
      : txt;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // Restore in a loop: a stashed link can contain a stashed code sentinel
  // (e.g. [`x`](url)), and replace() does not re-scan its own output.
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(/\x00(\d+)\x00/g, (_m, i) => tokens[Number(i)] ?? "");
  }
  return s;
}

const BLOCK_BREAK = /^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+\.\s)/;

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; // closing fence
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) {
      closeList();
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      closeList();
      out.push("<hr/>");
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(escapeHtml(h[2]))}</h${lvl}>`);
      i++;
      continue;
    }
    const bq = line.match(/^\s*>\s?(.*)$/);
    if (bq) {
      closeList();
      out.push(`<blockquote>${inline(escapeHtml(bq[1]))}</blockquote>`);
      i++;
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(escapeHtml(ul[1]))}</li>`);
      i++;
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(escapeHtml(ol[1]))}</li>`);
      i++;
      continue;
    }
    // Paragraph: gather consecutive plain lines.
    closeList();
    const para: string[] = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !BLOCK_BREAK.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
  }
  closeList();
  return out.join("\n");
}
