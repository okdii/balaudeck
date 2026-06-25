import { useState } from "react";
import type { Note } from "./types";
import { Icon } from "./Icon";
import { renderMarkdown } from "./markdown";

interface Props {
  /** The note to show, looked up live from the store (undefined if deleted). */
  note: Note | undefined;
  onSave: (note: Note) => Promise<Note>;
}

/** A note popped out into the main pane area: renders Markdown, edit on demand. */
export function NotePane({ note, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  if (!note) {
    return (
      <div className="note-pane">
        <p className="empty">This note was deleted.</p>
      </div>
    );
  }
  const n = note;

  function startEdit() {
    setTitle(n.title);
    setBody(n.body);
    setEditing(true);
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      await onSave({ id: n.id, title: title.trim(), body, updated_at: Date.now() });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="note-pane">
      <div className="note-pane-bar">
        {editing ? (
          <>
            <button className="note-save" onClick={save} disabled={busy}>
              <Icon name="save" size={14} /> Save
            </button>
            <button className="icon" title="Cancel" onClick={() => setEditing(false)}>
              <Icon name="x" size={15} />
            </button>
          </>
        ) : (
          <button className="icon" title="Edit note" onClick={startEdit}>
            <Icon name="edit" size={15} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="note-pane-edit">
          <input
            className="note-title-input"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="note-textarea"
            placeholder="Write in Markdown…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
      ) : (
        <div
          className="note-preview note-pane-view"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(n.body) }}
        />
      )}
    </div>
  );
}
