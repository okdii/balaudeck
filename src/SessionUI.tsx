import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { folderTree, type Folder } from "./types";

export interface Preset {
  id: string;
  label: string;
  /** Secondary text (e.g. user@host) — shown small and searched too. */
  sub?: string;
  /** Folder this preset lives in; renders under the folder hierarchy. */
  folderId?: string | null;
}

/**
 * Searchable saved-host dropdown. Items are grouped under their folder
 * hierarchy (indented, like the sidebar) so same-named entries are
 * distinguishable, and a search box filters by name / user@host.
 */
export function HostPicker({
  presets,
  folders = [],
  selectedId,
  onSelect,
  placeholder,
}: {
  presets: Preset[];
  folders?: Folder[];
  selectedId: string;
  onSelect: (id: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Fresh search + focus each time it opens. Also flip the popup above the
  // button when there isn't room below (e.g. this picker near the bottom of a
  // scrollable modal), so the list isn't clipped by the modal's overflow.
  useEffect(() => {
    if (open) {
      setQ("");
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) {
        const below = window.innerHeight - rect.bottom;
        setDropUp(below < 320 && rect.top > below);
      }
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const selected = presets.find((p) => p.id === selectedId);

  type Row =
    | { kind: "folder"; id: string; name: string; depth: number }
    | { kind: "item"; preset: Preset; depth: number };

  const rows = useMemo<Row[]>(() => {
    const needle = q.trim().toLowerCase();
    const match = (p: Preset) =>
      !needle ||
      p.label.toLowerCase().includes(needle) ||
      (p.sub ?? "").toLowerCase().includes(needle);

    const ids = new Set(folders.map((f) => f.id));
    const byFolder = new Map<string | null, Preset[]>();
    for (const p of presets) {
      const key = p.folderId && ids.has(p.folderId) ? p.folderId : null;
      byFolder.set(key, [...(byFolder.get(key) ?? []), p]);
    }

    // Folders worth showing: those with a matching item somewhere below them.
    const parentOf = new Map(folders.map((f) => [f.id, f.parent_id ?? null]));
    const marked = new Set<string>();
    for (const [fid, items] of byFolder) {
      if (!fid || !items.some(match)) continue;
      let cur: string | null = fid;
      const guard = new Set<string>();
      while (cur && !guard.has(cur)) {
        guard.add(cur);
        marked.add(cur);
        cur = parentOf.get(cur) ?? null;
      }
    }

    const out: Row[] = [];
    for (const p of (byFolder.get(null) ?? []).filter(match)) {
      out.push({ kind: "item", preset: p, depth: 0 });
    }
    for (const { folder, depth } of folderTree(folders)) {
      if (!marked.has(folder.id)) continue;
      out.push({ kind: "folder", id: folder.id, name: folder.name, depth });
      for (const p of (byFolder.get(folder.id) ?? []).filter(match)) {
        out.push({ kind: "item", preset: p, depth: depth + 1 });
      }
    }
    return out;
  }, [presets, folders, q]);

  function pick(id: string) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <div className="hostpick" ref={rootRef}>
      <button type="button" className="hostpick-btn" onClick={() => setOpen((v) => !v)}>
        <span className={selected ? "" : "hostpick-ph"}>{selected?.label ?? placeholder}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className={"hostpick-pop" + (dropUp ? " up" : "")}>
          <input
            ref={inputRef}
            className="hostpick-search"
            placeholder="Search hosts…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const first = rows.find((r) => r.kind === "item");
                if (first && first.kind === "item") pick(first.preset.id);
              }
            }}
          />
          <div className="hostpick-list">
            {rows.map((r) =>
              r.kind === "folder" ? (
                <div
                  key={"f" + r.id}
                  className="hostpick-folder"
                  style={{ paddingLeft: 10 + r.depth * 14 }}
                >
                  <Icon name="folder" size={12} /> {r.name}
                </div>
              ) : (
                <button
                  type="button"
                  key={r.preset.id}
                  className={"hostpick-item" + (r.preset.id === selectedId ? " sel" : "")}
                  style={{ paddingLeft: 10 + r.depth * 14 }}
                  onClick={() => pick(r.preset.id)}
                  title={r.preset.sub}
                >
                  <span className="hostpick-name">{r.preset.label}</span>
                </button>
              ),
            )}
            {rows.length === 0 && <div className="hostpick-empty">No matches</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Centered connection launcher: pick a saved preset or expand a manual form. */
export function ConnectLauncher({
  icon,
  title,
  presets,
  folders,
  presetLabel = "Choose a saved host…",
  selectedId,
  onSelect,
  onConnect,
  connecting,
  manualOpen,
  onToggleManual,
  error,
  overlay,
  children,
}: {
  icon: IconName;
  title: string;
  presets: Preset[];
  folders?: Folder[];
  presetLabel?: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onConnect: () => void;
  connecting: boolean;
  manualOpen: boolean;
  onToggleManual: () => void;
  error?: string;
  overlay?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={"launcher" + (overlay ? " over-terminal" : "")}>
      <div className="launcher-card">
        <div className="launcher-head">
          <Icon name={icon} size={22} />
          <h3>{title}</h3>
        </div>

        {presets.length > 0 && (
          <div className="launcher-presets">
            <HostPicker
              presets={presets}
              folders={folders}
              selectedId={selectedId}
              onSelect={onSelect}
              placeholder={presetLabel}
            />
            <button onClick={onConnect} disabled={!selectedId || connecting}>
              <Icon name="play" size={14} /> {connecting ? "Connecting…" : "Connect"}
            </button>
          </div>
        )}

        <button className="launcher-toggle" onClick={onToggleManual}>
          <Icon name={manualOpen ? "chevronDown" : "chevronRight"} size={14} />
          Manual connection
        </button>

        {manualOpen && <div className="launcher-manual">{children}</div>}

        {error && <pre className="error">{error}</pre>}
      </div>
    </div>
  );
}

/** Slim bar shown while a session is connected: status + disconnect. */
export function SessionBar({ label, onDisconnect }: { label: string; onDisconnect: () => void }) {
  return (
    <div className="session-bar">
      <span className="status">
        <span className="dot ok" />
        <span className="session-host">{label}</span>
      </span>
      <button className="btn-disconnect" onClick={onDisconnect}>
        <Icon name="power" size={14} /> Disconnect
      </button>
    </div>
  );
}
