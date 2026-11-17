import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

/**
 * A text field with a suggestion dropdown — the replacement for `<datalist>`,
 * which the macOS WebView (WKWebView) never renders.
 *
 *  • The list is portalled to <body> and fixed-positioned from the field's rect,
 *    so overflow containers (modals, scroll panes) never clip it; it flips up
 *    when there's no room below.
 *  • Typing filters the options (substring, case-insensitive); when nothing
 *    matches every option is still offered.
 *  • ↑/↓ move, Enter picks, Esc closes.
 *  • `multi` treats the value as a comma-separated list: the filter applies to
 *    the last item and picking replaces just that item (e.g. index columns).
 */
export function ComboInput({
  value,
  onChange,
  options,
  placeholder,
  className,
  title,
  multi = false,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  title?: string;
  multi?: boolean;
  disabled?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const [hi, setHi] = useState(-1);

  // The part being typed — the last comma-separated item in multi mode.
  const token = multi ? (value.split(",").pop() ?? "").trim() : value.trim();
  const q = token.toLowerCase();
  const matches = q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  const list = matches.length > 0 ? matches : options;

  function place() {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    const above = rect.top;
    const CAP = 240;
    let top: number;
    let maxHeight: number;
    if (below >= 160 || below >= above) {
      top = rect.bottom + 2;
      maxHeight = Math.max(96, Math.min(CAP, below - 12));
    } else {
      maxHeight = Math.max(96, Math.min(CAP, above - 12));
      top = rect.top - maxHeight - 2;
    }
    setPos({ left: rect.left, top, width: Math.max(rect.width, 160), maxHeight });
  }

  function show() {
    if (disabled || options.length === 0) return;
    place();
    setOpen(true);
  }

  function pick(opt: string) {
    if (multi) {
      const parts = value.split(",").map((p) => p.trim());
      parts[parts.length - 1] = opt;
      onChange(parts.filter((p, i) => p || i === parts.length - 1).join(", "));
    } else {
      onChange(opt);
    }
    setOpen(false);
    setHi(-1);
  }

  // Fixed-positioned: a scroll/resize elsewhere would leave it floating, so
  // close then (ignoring scrolls inside the list itself).
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // Keep the highlighted row in view while arrowing.
  useLayoutEffect(() => {
    if (!open || hi < 0) return;
    const el = listRef.current?.children[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [hi, open]);

  return (
    <div ref={boxRef} className={`combo ${className ?? ""}`} title={title}>
      <input
        className="combo-input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => {
          onChange(e.target.value);
          setHi(-1);
          show();
        }}
        onFocus={show}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) show();
            setHi((h) => Math.min(list.length - 1, h + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(0, h - 1));
          } else if (e.key === "Enter" && open && hi >= 0 && hi < list.length) {
            e.preventDefault();
            pick(list[hi]);
          }
        }}
      />
      <button
        type="button"
        className="combo-toggle"
        tabIndex={-1}
        disabled={disabled || options.length === 0}
        title="Show suggestions"
        onMouseDown={(e) => {
          e.preventDefault();
          if (open) setOpen(false);
          else {
            (e.currentTarget.previousElementSibling as HTMLInputElement | null)?.focus();
            show();
          }
        }}
      >
        <Icon name="chevronDown" size={12} />
      </button>
      {open &&
        pos &&
        list.length > 0 &&
        createPortal(
          <ul
            ref={listRef}
            className="combo-list"
            style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
          >
            {list.map((o, i) => (
              <li
                key={o}
                className={(i === hi ? "hi " : "") + (o.toLowerCase() === q ? "active" : "")}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(o);
                }}
              >
                {o}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
