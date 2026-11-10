import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { Icon } from "./Icon";
import { SEARCH_DECORATIONS } from "./terminalExtras";

/** A find bar that drives xterm's search addon over the scrollback: type to
 *  highlight matches, Enter / Shift+Enter to step, Esc to close. */
export function TermSearch({
  search,
  term,
  onClose,
}: {
  search: SearchAddon;
  term: Terminal;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [count, setCount] = useState<{ index: number; total: number }>({ index: -1, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const sub = search.onDidChangeResults((r) => {
      setCount(r ? { index: r.resultIndex, total: r.resultCount } : { index: -1, total: 0 });
    });
    inputRef.current?.focus();
    return () => sub.dispose();
  }, [search]);

  const opts = { decorations: SEARCH_DECORATIONS };

  function find(dir: 1 | -1) {
    if (!q) return;
    if (dir === 1) search.findNext(q, opts);
    else search.findPrevious(q, opts);
  }

  function onChange(v: string) {
    setQ(v);
    if (v) search.findNext(v, { ...opts, incremental: true });
    else {
      search.clearDecorations();
      setCount({ index: -1, total: 0 });
    }
  }

  function close() {
    search.clearDecorations();
    onClose();
    term.focus();
  }

  return (
    <div className="term-search" onMouseDown={(e) => e.stopPropagation()}>
      <Icon name="eye" size={13} className="term-search-glyph" />
      <input
        ref={inputRef}
        className="term-search-input"
        placeholder="Find in output"
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            find(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <span className="term-search-count">
        {count.total ? `${count.index + 1}/${count.total}` : q ? "0/0" : ""}
      </span>
      <button className="icon" title="Previous (⇧⏎)" onClick={() => find(-1)} disabled={!count.total}>
        <Icon name="chevronLeft" size={14} />
      </button>
      <button className="icon" title="Next (⏎)" onClick={() => find(1)} disabled={!count.total}>
        <Icon name="chevronRight" size={14} />
      </button>
      <button className="icon" title="Close (Esc)" onClick={close}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
