// ⌘K in the SQL editor: describe what you want and the assistant writes the
// SQL at the cursor — or rewrites the selection. The change lands in the
// editor highlighted; Accept keeps it, Reject puts the old text back.

import { useEffect, useRef, useState } from "react";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { Icon, Spinner } from "./Icon";
import { complete } from "./ai/termAi";
import { getSettings } from "./settings";

/** Context the panel gives the model: dialect, database and the schema bits
 *  that matter for this request. */
export interface SqlAiContext {
  engine: string;
  database: string;
  /** All table/view names in the current database. */
  tables: string[];
  /** Columns for the tables that look relevant ("table: col type, …"). */
  columns: (tables: string[]) => Promise<string[]>;
}

// ---- highlight of the AI's change -------------------------------------------

const setMark = StateEffect.define<{ from: number; to: number } | null>();
const markDeco = Decoration.mark({ class: "cm-ai-change" });
const aiMark = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMark)) deco = e.value && e.value.to > e.value.from ? Decoration.set([markDeco.range(e.value.from, e.value.to)]) : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Editor extension: ⌘K / Ctrl+K opens the bar; the change highlight. */
export function sqlAiExtension(open: () => void) {
  return [
    aiMark,
    Prec.highest(
      keymap.of([
        {
          key: "Mod-k",
          run: () => {
            open();
            return true;
          },
        },
      ]),
    ),
  ];
}

/** Strip code fences / chatter around the SQL the model returned. */
export function extractSql(text: string): string {
  const fence = text.match(/```(?:sql|\w+)?\s*\n([\s\S]*?)```/i);
  return (fence ? fence[1] : text).trim();
}

interface Pending {
  from: number;
  to: number;
  original: string;
}

export function SqlAiBar({
  view,
  ctx,
  onClose,
}: {
  view: EditorView | null;
  ctx: () => SqlAiContext;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ai = getSettings().ai;

  // What the request applies to, captured when the bar opens.
  const [target] = useState(() => {
    const sel = view?.state.selection.main;
    return sel ? { from: sel.from, to: sel.to } : { from: 0, to: 0 };
  });
  const selected = view && target.to > target.from ? view.state.sliceDoc(target.from, target.to) : "";

  useEffect(() => inputRef.current?.focus(), []);

  function finish(keep: boolean) {
    if (!view) return onClose();
    if (pending && !keep) {
      const len = view.state.doc.length;
      const to = Math.min(len, pending.to);
      view.dispatch({ changes: { from: pending.from, to, insert: pending.original }, effects: setMark.of(null) });
    } else {
      view.dispatch({ effects: setMark.of(null) });
    }
    onClose();
    view.focus();
  }

  async function submit() {
    if (!view || !text.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const c = ctx();
      const doc = view.state.doc.toString();
      // A suggestion on screen is what a follow-up instruction refines.
      const part = pending ? view.state.sliceDoc(pending.from, Math.min(view.state.doc.length, pending.to)) : selected;
      const mentioned = c.tables.filter((t) =>
        new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text + "\n" + doc),
      );
      const cols = await c.columns(mentioned.slice(0, 15));
      const system = [
        `You write ${c.engine} SQL for BalauDeck's query editor.`,
        "Reply with ONLY the SQL — no explanation, no markdown fences. Use the user's table and column names exactly.",
        "Prefer safe statements; never add DROP/TRUNCATE/DELETE unless explicitly asked. Keep the user's formatting style.",
      ].join("\n");
      const user = [
        `Database: ${c.database || "(none selected)"}`,
        c.tables.length ? `Tables: ${c.tables.slice(0, 300).join(", ")}` : "",
        cols.length ? `Columns:\n${cols.join("\n")}` : "",
        `Whole editor:\n${doc.slice(0, 6000) || "(empty)"}`,
        part
          ? `Rewrite this selected part:\n${part}\n\nInstruction: ${text}`
          : `Write SQL to insert at the cursor. Instruction: ${text}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const out = extractSql(await complete(system, user, 2000));
      if (!out) throw new Error("The model returned nothing.");
      // If a previous suggestion is showing, replace it (retry) instead.
      const from = pending ? pending.from : target.from;
      const to = pending ? Math.min(view.state.doc.length, pending.to) : target.to;
      const original = pending ? pending.original : view.state.sliceDoc(target.from, target.to);
      const empty = !pending && view.state.doc.length === 0;
      const insert = empty || part ? out : (from > 0 && view.state.sliceDoc(from - 1, from) !== "\n" ? "\n" : "") + out;
      view.dispatch({
        changes: { from, to, insert },
        effects: setMark.of({ from, to: from + insert.length }),
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      setPending({ from, to: from + insert.length, original });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!ai.enabled) {
    return (
      <div className="sql-ai-bar">
        <Icon name="sparkles" size={13} />
        <span className="sql-ai-note">Turn on the AI assistant in Settings → AI to write SQL with ⌘K.</span>
        <button className="icon" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
    );
  }

  return (
    <div className="sql-ai-bar">
      <Icon name="sparkles" size={13} />
      <input
        ref={inputRef}
        value={text}
        placeholder={
          pending
            ? "Refine it, e.g. “only last 30 days” — or Enter to accept"
            : selected
              ? "Change the selection, e.g. “add a LIMIT”, “use a JOIN instead”…"
              : "Describe the query, e.g. “top 10 customers by spend this year”…"
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (pending && !text.trim()) finish(true);
            else {
              void submit();
              if (pending) setText("");
            }
          }
        }}
        disabled={busy}
        spellCheck={false}
      />
      {busy && <Spinner size={13} />}
      {pending && !busy && (
        <>
          <button className="sql-ai-accept" onClick={() => finish(true)} title="Keep the change (Enter)">
            Accept
          </button>
          <button className="ghost" onClick={() => finish(false)} title="Put the old text back (Esc)">
            Reject
          </button>
        </>
      )}
      {!pending && !busy && (
        <button className="icon" onClick={() => finish(false)} title="Close (Esc)">
          <Icon name="x" size={13} />
        </button>
      )}
      {err && <span className="sql-ai-err">{err}</span>}
    </div>
  );
}
