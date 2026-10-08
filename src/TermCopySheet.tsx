import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { copyToClipboard } from "./clipboard";

/** How much history the sheet shows — enough to reach recent output without
 *  making the WebView lay out the whole 100k-line scrollback. */
const MAX_LINES = 2000;

/** The terminal buffer (scrollback + screen) as plain text, wrapped rows
 *  re-joined into their logical lines and trailing blank rows dropped. */
export function terminalText(term: Terminal, maxLines = MAX_LINES): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.slice(-maxLines).join("\n");
}

/**
 * Touch-device copy for the terminal. xterm.js has no touch selection and
 * phones have no Cmd-C, so this shows the buffer as ordinary text where the
 * native iOS/Android long-press selection + Copy callout work, plus a
 * "Copy all" button. Opens scrolled to the bottom (the latest output).
 */
export function TermCopySheet({ term, onClose }: { term: Terminal; onClose: () => void }) {
  const [text] = useState(() => terminalText(term));
  const [copied, setCopied] = useState(false);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, []);

  async function copyAll() {
    try {
      await copyToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the text is still selectable */
    }
  }

  return (
    <div className="term-copy-sheet">
      <div className="term-copy-head">
        <span>Long-press to select, or copy everything</span>
        <button onClick={copyAll}>{copied ? "Copied" : "Copy all"}</button>
        <button className="ghost" onClick={onClose}>
          Done
        </button>
      </div>
      <pre ref={pre} className="term-copy-text">
        {text}
      </pre>
    </div>
  );
}
