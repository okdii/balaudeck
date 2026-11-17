import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { maskText } from "./privacy";

export type PaletteGroup = "Connections" | "Open tabs" | "Notes" | "Actions";

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  title: string;
  /** Secondary text (host, folder, shortcut hint …) — also searched. */
  subtitle?: string;
  /** Extra words that match but aren't shown (e.g. engine, kind). */
  keywords?: string;
  icon: IconName;
  color?: string;
  /** Right-aligned hint, e.g. a shortcut. */
  hint?: string;
  run: () => void;
}

const GROUP_ORDER: PaletteGroup[] = ["Open tabs", "Connections", "Notes", "Actions"];

/**
 * Score `q` against `text`: a contiguous substring wins (earlier and at a word
 * start = better); otherwise an in-order subsequence (fewer gaps = better);
 * otherwise -1. Case-insensitive.
 */
function score(q: string, text: string): number {
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) {
    const wordStart = i === 0 || /[\s@._\-/:]/.test(t[i - 1]);
    return 1000 - i + (wordStart ? 200 : 0) - t.length * 0.1;
  }
  let ti = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    if (last >= 0 && at > last + 1) gaps += at - last - 1;
    last = at;
    ti = at + 1;
  }
  return 500 - gaps * 4 - t.length * 0.1;
}

/** Best score over every whitespace-separated term (all must match). */
function itemScore(query: string, it: PaletteItem): number {
  const hay = `${it.title} ${it.subtitle ?? ""} ${it.keywords ?? ""}`;
  let total = 0;
  for (const term of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const s = Math.max(score(term, it.title) + 300, score(term, hay));
    if (s < 0) return -1;
    total += s;
  }
  return total;
}

/**
 * ⌘⇧P / Ctrl+Shift+P quick switcher: connect to a saved host, jump to an open
 * tab, open a note, or run an app action — by typing a few letters.
 */
export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => {
    const query = q.trim();
    if (!query) {
      // No query: open tabs first, then connections, then actions — each in
      // its natural order. Notes are only reachable by searching.
      return GROUP_ORDER.flatMap((g) => items.filter((it) => it.group === g && g !== "Notes"));
    }
    return items
      .map((it) => ({ it, s: itemScore(query, it) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 60)
      .map((x) => x.it);
  }, [q, items]);

  useEffect(() => setSel(0), [q]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    // Let the palette unmount (and give focus back) before the action runs,
    // so e.g. a newly opened terminal can take focus.
    window.setTimeout(it.run, 0);
  };

  // Group headers only while browsing (no query); a search is one ranked list.
  const grouped = !q.trim();

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="palette-search">
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder="Search connections, tabs, notes, actions…"
            value={q}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(results.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(results[sel]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <kbd className="palette-kbd">esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((it, i) => {
            const header = grouped && (i === 0 || results[i - 1].group !== it.group);
            return (
              <div key={it.id}>
                {header && <div className="palette-group">{it.group}</div>}
                <button
                  data-idx={i}
                  className={"palette-item" + (i === sel ? " sel" : "")}
                  onMouseMove={() => i !== sel && setSel(i)}
                  onClick={() => run(it)}
                >
                  <span className="palette-ic">
                    <Icon name={it.icon} size={15} color={it.color} />
                  </span>
                  <span className="palette-main">
                    <span className="palette-title">{maskText(it.title)}</span>
                    {it.subtitle && <span className="palette-sub">{maskText(it.subtitle)}</span>}
                  </span>
                  {!grouped && <span className="palette-tag">{it.group === "Open tabs" ? "Tab" : it.group === "Connections" ? "Connect" : it.group === "Notes" ? "Note" : "Action"}</span>}
                  {it.hint && <kbd className="palette-kbd">{it.hint}</kbd>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
