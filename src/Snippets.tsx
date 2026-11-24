// Terminal snippets: saved commands sent to a terminal pane from its header.
// `{{name}}` placeholders are filled in before sending; multi-line commands
// are sent line by line. Synced panes (input broadcast) all receive it.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { getSettings, setSettings, subscribeSettings, type Snippet } from "./settings";
import { sendToPane } from "./broadcast";

const VAR_RX = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Placeholder names in first-seen order. */
export function snippetVars(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(VAR_RX)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The bytes to send: placeholders filled, newlines as Enter. */
export function snippetText(s: Pick<Snippet, "command" | "run">, values: Record<string, string> = {}): string {
  const filled = s.command.replace(VAR_RX, (_, k: string) => values[k] ?? "");
  const body = filled.replace(/\r?\n/g, "\r");
  return s.run ? body + "\r" : body;
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

type Mode = { kind: "list" } | { kind: "edit"; snip: Snippet } | { kind: "fill"; snip: Snippet; vars: string[] };

export function SnippetsMenu({ paneId, onClose }: { paneId: string; onClose: () => void }) {
  const [snips, setSnips] = useState<Snippet[]>(getSettings().snippets);
  useEffect(() => subscribeSettings(() => setSnips(getSettings().snippets)), []);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [values, setValues] = useState<Record<string, string>>({});
  const boxRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Esc.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (boxRef.current?.contains(t) || t.closest?.(".pane-snip")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (mode.kind === "list") onClose();
        else setMode({ kind: "list" });
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [mode, onClose]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? snips.filter((s) => (s.name + "\n" + s.command).toLowerCase().includes(t)) : snips;
  }, [snips, q]);
  useEffect(() => setSel(0), [q]);

  function use(s: Snippet) {
    const vars = snippetVars(s.command);
    if (vars.length) {
      setValues({});
      setMode({ kind: "fill", snip: s, vars });
      return;
    }
    send(s, {});
  }

  function send(s: Snippet, vals: Record<string, string>) {
    sendToPane(paneId, snippetText(s, vals));
    onClose();
  }

  function save(s: Snippet) {
    if (!s.command.trim()) return;
    const named = { ...s, name: s.name.trim() || s.command.trim().split("\n")[0].slice(0, 40) };
    const list = getSettings().snippets;
    const next = list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? named : x)) : [...list, named];
    setSettings({ snippets: next });
    setMode({ kind: "list" });
  }

  function remove(id: string) {
    setSettings({ snippets: getSettings().snippets.filter((x) => x.id !== id) });
  }

  return (
    <div className="snip-menu" ref={boxRef} onClick={(e) => e.stopPropagation()}>
      {mode.kind === "list" && (
        <>
          <div className="snip-search">
            <Icon name="search" size={13} />
            <input
              autoFocus
              placeholder="Search snippets…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((i) => Math.min(shown.length - 1, i + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter" && shown[sel]) {
                  e.preventDefault();
                  use(shown[sel]);
                }
              }}
            />
            <button
              className="icon"
              title="New snippet"
              onClick={() => setMode({ kind: "edit", snip: { id: newId(), name: "", command: q, run: true } })}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
          <div className="snip-list">
            {shown.length === 0 && (
              <div className="snip-empty">
                {snips.length === 0
                  ? "No snippets yet. Save commands you type often — use {{name}} for a value to fill in each time."
                  : "No match."}
              </div>
            )}
            {shown.map((s, i) => (
              <div
                key={s.id}
                className={"snip-row" + (i === sel ? " sel" : "")}
                onMouseEnter={() => setSel(i)}
                onClick={() => use(s)}
                title={s.run ? "Send and run" : "Send to the prompt (not run)"}
              >
                <div className="snip-main">
                  <span className="snip-name">{s.name}</span>
                  <code className="snip-cmd">
                    {s.command.split("\n")[0]}
                    {s.command.trim().includes("\n") && ` (+${s.command.trim().split("\n").length - 1} more)`}
                  </code>
                </div>
                {!s.run && <span className="snip-tag">paste</span>}
                <button
                  className="icon"
                  title="Edit"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMode({ kind: "edit", snip: s });
                  }}
                >
                  <Icon name="edit" size={12} />
                </button>
                <button
                  className="icon"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(s.id);
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {mode.kind === "edit" && (
        <SnippetForm snip={mode.snip} onSave={save} onCancel={() => setMode({ kind: "list" })} />
      )}

      {mode.kind === "fill" && (
        <form
          className="snip-form"
          onSubmit={(e) => {
            e.preventDefault();
            send(mode.snip, values);
          }}
        >
          <div className="snip-form-title">{mode.snip.name}</div>
          {mode.vars.map((v, i) => (
            <label key={v}>
              {v}
              <input
                autoFocus={i === 0}
                value={values[v] ?? ""}
                onChange={(e) => setValues((x) => ({ ...x, [v]: e.target.value }))}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
          ))}
          <code className="snip-preview">{snippetText({ ...mode.snip, run: false }, values)}</code>
          <div className="snip-form-actions">
            <button type="button" onClick={() => setMode({ kind: "list" })}>
              Back
            </button>
            <button type="submit" className="primary">
              {mode.snip.run ? "Run" : "Send"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SnippetForm({
  snip,
  onSave,
  onCancel,
}: {
  snip: Snippet;
  onSave: (s: Snippet) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState(snip);
  return (
    <form
      className="snip-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(s);
      }}
    >
      <label>
        Name
        <input value={s.name} placeholder="e.g. Tail nginx errors" onChange={(e) => setS({ ...s, name: e.target.value })} />
      </label>
      <label>
        Command
        <textarea
          autoFocus
          rows={3}
          value={s.command}
          placeholder={"tail -f /var/log/nginx/error.log\ndocker logs -f {{container}}"}
          onChange={(e) => setS({ ...s, command: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSave(s);
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <label className="opt-check">
        <input type="checkbox" checked={s.run} onChange={(e) => setS({ ...s, run: e.target.checked })} /> Press Enter
        after sending
      </label>
      <div className="snip-hint">
        <code>{"{{name}}"}</code> asks for a value each time. Several lines run one after another.
      </div>
      <div className="snip-form-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!s.command.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}
