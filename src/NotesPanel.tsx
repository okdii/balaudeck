import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Note } from "./types";
import { Icon } from "./Icon";
import { renderMarkdown } from "./markdown";

interface Props {
  /** Kept mounted while hidden so an in-progress draft survives a toggle. */
  open: boolean;
  notes: Note[];
  height: number;
  resizing: boolean;
  onResizeStart: (e: ReactPointerEvent) => void;
  onClose: () => void;
  onSave: (note: Note) => Promise<Note>;
  onDelete: (id: string) => Promise<void> | void;
  /** Pop the note out into its own pane in the main area. */
  onOpenInPane: (note: Note) => void;
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
}

function noteTitle(n: Note): string {
  return n.title.trim() || firstLine(n.body) || "Untitled";
}

function relTime(ms?: number): string {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function NotesPanel(props: Props) {
  const { notes } = props;
  const [view, setView] = useState<"list" | "edit">("list");
  // null id = a new, unsaved note; otherwise the id being edited.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const sorted = [...notes].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

  function openList() {
    setView("list");
    setEditingId(null);
    setDirty(false);
  }

  function newNote() {
    setEditingId(null);
    setTitle("");
    setBody("");
    setPreview(false);
    setDirty(false);
    setView("edit");
  }

  function openNote(n: Note) {
    setEditingId(n.id);
    setTitle(n.title);
    setBody(n.body);
    setPreview(true); // open existing notes in read (rendered) mode
    setDirty(false);
    setView("edit");
  }

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await props.onSave({
        id: editingId ?? "",
        title: title.trim(),
        body,
        updated_at: Date.now(),
      });
      setEditingId(saved.id);
      setDirty(false);
    } finally {
      setBusy(false);
    }
  }

  async function back() {
    // Don't silently lose edits: persist a dirty, non-empty draft on the way out.
    if (dirty && (title.trim() || body.trim())) await save();
    openList();
  }

  async function deleteCurrent() {
    if (editingId) await props.onDelete(editingId);
    openList();
  }

  // If the open note vanished (deleted on another device / via sync import) and
  // there are no unsaved edits, fall back to the list instead of stale text.
  useEffect(() => {
    if (view === "edit" && editingId && !dirty && !notes.some((n) => n.id === editingId)) {
      openList();
    }
  }, [notes, view, editingId, dirty]);

  const empty = !title.trim() && !body.trim();

  return (
    <div
      className="notes-panel"
      style={{ height: props.height, display: props.open ? undefined : "none" }}
    >
      <div
        className={"notes-resizer" + (props.resizing ? " dragging" : "")}
        title="Drag to resize notes"
        onPointerDown={props.onResizeStart}
      />
      <div className="notes-head">
        {view === "edit" && (
          <button className="icon" title="Back to notes" onClick={back}>
            <Icon name="back" size={15} />
          </button>
        )}
        <span className="notes-heading">
          {view === "list" ? "Notes" : editingId ? "Edit note" : "New note"}
        </span>
        <div className="head-actions">
          {view === "list" && (
            <button className="icon" title="New note" onClick={newNote}>
              <Icon name="plus" size={15} />
            </button>
          )}
          {view === "edit" && (
            <button
              className="icon"
              title={preview ? "Edit Markdown" : "Preview"}
              onClick={() => setPreview((p) => !p)}
            >
              <Icon name={preview ? "edit" : "eye"} size={15} />
            </button>
          )}
          {view === "edit" && editingId && (
            <button
              className="icon"
              title="Open in panel"
              onClick={() => {
                const n = notes.find((x) => x.id === editingId);
                if (n) props.onOpenInPane(n);
              }}
            >
              <Icon name="detach" size={15} />
            </button>
          )}
          {view === "edit" && editingId && (
            <button className="icon" title="Delete note" onClick={deleteCurrent}>
              <Icon name="trash" size={15} />
            </button>
          )}
          <button className="icon" title="Hide notes" onClick={props.onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
      </div>

      <div className="notes-body">
        {view === "list" ? (
          sorted.length === 0 ? (
            <p className="empty">No notes yet — tap + to add one</p>
          ) : (
            sorted.map((n) => (
              <div key={n.id} className="note-row" onClick={() => openNote(n)}>
                <div className="item-main">
                  <div className="item-name">{noteTitle(n)}</div>
                  <div className="item-sub">{relTime(n.updated_at)}</div>
                </div>
                <div className="item-actions">
                  <button
                    className="icon"
                    title="Open in panel"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onOpenInPane(n);
                    }}
                  >
                    <Icon name="detach" size={14} />
                  </button>
                  <button
                    className="icon"
                    title="Delete note"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onDelete(n.id);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            ))
          )
        ) : (
          <div className="note-editor">
            <input
              className="note-title-input"
              placeholder="Title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setDirty(true);
              }}
            />
            {preview ? (
              <div
                className="note-preview"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }}
              />
            ) : (
              <textarea
                className="note-textarea"
                placeholder="Write in Markdown…"
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setDirty(true);
                }}
              />
            )}
            <div className="note-foot">
              <button
                className="note-save"
                onClick={save}
                disabled={busy || empty || !dirty}
              >
                <Icon name="save" size={14} /> {dirty ? "Save" : "Saved"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
