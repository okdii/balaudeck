import { useEffect, useRef, useState, type ReactNode } from "react";
import CodeMirror, { keymap } from "@uiw/react-codemirror";
import { Icon, Spinner } from "./Icon";
import { isDark } from "./settings";
import { PdfPreview } from "./PdfPreview";
import { maskText, redactText } from "./privacy";
import type { S3Preview } from "./types";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Shared preview pane for a fetched file — text, image, PDF, or a
 * binary/too-large fallback. Used by both the S3 and SFTP browsers so the two
 * file panels render previews identically; each supplies its own backend that
 * returns the same `S3Preview` shape.
 */
export function FilePreview({
  data,
  name,
  meta,
  onBack,
  onDownload,
  downloadDisabled,
  onSave,
}: {
  data: S3Preview;
  /** Basename, used as the image alt text and PDF label. */
  name: string;
  /** Leading text of the meta line (e.g. the masked key/path). */
  meta: ReactNode;
  onBack: () => void;
  onDownload: () => void;
  downloadDisabled?: boolean;
  /** Present when the file can be written back: enables Edit for complete
   *  (non-truncated) text previews. Resolves once saved; throws to report. */
  onSave?: (text: string) => Promise<void>;
}) {
  const editable = !!onSave && data.kind === "text" && !data.truncated;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.content);
  const [saved, setSaved] = useState(data.content);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState("");
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => {
    setEditing(false);
    setDraft(data.content);
    setSaved(data.content);
    setSaveErr("");
  }, [data.content]);
  const dirty = editing && draft !== saved;

  const save = async () => {
    if (!onSave || saving || !dirty) return;
    setSaving(true);
    setSaveErr("");
    try {
      await onSave(draft);
      setSaved(draft);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setSaveErr(String(e));
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Leaving with unsaved edits asks first (Back button or Esc).
  const leave = () => {
    if (dirty) setConfirmLeave(true);
    else onBack();
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  // An image sniffed purely by extension (SFTP has no server content type) may
  // not actually be a decodable image; fall back to the download hint instead of
  // a broken-image glyph.
  const [imgError, setImgError] = useState(false);
  useEffect(() => setImgError(false), [data.content]);

  // Escape returns to the file list — the preview replaces the whole grid, and
  // keyboard/iPad-with-keyboard users expect Esc to dismiss an overlay view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmLeave) setConfirmLeave(false);
        else leaveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmLeave]);

  // Privacy masking never reaches HTML attributes, so redact the filename before
  // it lands in alt / aria-label (it's the one name in the preview that escapes
  // the visual mask).
  const safeName = redactText(name);

  return (
    <>
      <div className="form-row">
        <button className="ghost" onClick={leave}>
          <Icon name="back" size={14} /> Back
        </button>
        <button className="ghost" onClick={onDownload} disabled={downloadDisabled}>
          <Icon name="download" size={14} /> Download
        </button>
        {editable && !editing && (
          <button className="ghost" onClick={() => setEditing(true)} title="Edit this file and save it back">
            <Icon name="edit" size={14} /> Edit
          </button>
        )}
        {editing && (
          <>
            <button className="primary" onClick={save} disabled={!dirty || saving} title="Save (⌘S / Ctrl+S)">
              {saving ? <Spinner size={13} /> : <Icon name="save" size={14} />} Save
            </button>
            <button
              className="ghost"
              onClick={() => {
                setDraft(saved);
                setEditing(false);
              }}
              disabled={saving}
            >
              {dirty ? "Discard" : "Done"}
            </button>
            <span className={"edit-state" + (dirty ? " dirty" : "")}>
              {savedFlash ? "Saved ✓" : dirty ? "● Unsaved changes" : "No changes"}
            </span>
          </>
        )}
      </div>
      {confirmLeave && (
        <div className="edit-confirm">
          <span>You have unsaved changes.</span>
          <button
            className="primary"
            onClick={async () => {
              await saveRef.current();
              setConfirmLeave(false);
            }}
          >
            Save
          </button>
          <button
            className="danger"
            onClick={() => {
              setConfirmLeave(false);
              onBack();
            }}
          >
            Discard
          </button>
          <button className="ghost" onClick={() => setConfirmLeave(false)}>
            Keep editing
          </button>
        </div>
      )}
      {saveErr && <pre className="error">{saveErr}</pre>}
      <div className="mongo-meta">
        {meta} · {data.content_type} · {fmtSize(data.size)}
        {data.truncated ? " · truncated (too large to edit here — use Download)" : ""}
      </div>
      {data.kind === "text" && editing && (
        <div className="file-editor">
          <CodeMirror
            value={draft}
            onChange={setDraft}
            theme={isDark() ? "dark" : "light"}
            height="100%"
            autoFocus
            basicSetup={{ highlightActiveLine: true, foldGutter: false }}
            extensions={[
              keymap.of([
                {
                  key: "Mod-s",
                  preventDefault: true,
                  run: () => {
                    void saveRef.current();
                    return true;
                  },
                },
              ]),
            ]}
          />
        </div>
      )}
      {data.kind === "text" && !editing && (
        <div className="mongo-docs">
          <pre className="mongo-doc">{maskText(data.content)}</pre>
        </div>
      )}
      {data.kind === "image" &&
        (imgError ? (
          <p className="empty">Can't render this image — use Download.</p>
        ) : (
          <div className="mongo-docs">
            <img
              className="s3-preview-img"
              src={`data:${data.content_type};base64,${data.content}`}
              alt={safeName}
              onError={() => setImgError(true)}
            />
          </div>
        ))}
      {data.kind === "pdf" && <PdfPreview data={data.content} name={safeName} />}
      {(data.kind === "binary" || data.kind === "too-large") && (
        <p className="empty">
          {data.kind === "too-large"
            ? "Too large to preview — use Download."
            : "Binary content — no preview. Use Download."}
        </p>
      )}
    </>
  );
}
