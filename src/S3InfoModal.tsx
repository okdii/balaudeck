// Object properties for one S3 key: read-only facts (size, ETag, class…),
// editable tags (PutObjectTagging) and editable headers + user metadata
// (CopyObject onto itself with REPLACE — S3 has no in-place metadata edit).

import { useEffect, useState } from "react";
import { api, type DbConnParams } from "./api";
import type { KeyValue, S3ObjectInfo } from "./types";
import { Icon, Spinner } from "./Icon";
import { maskText } from "./privacy";
import { copyToClipboard } from "./clipboard";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Key/value rows with add/remove — shared by tags and user metadata. */
function KvEditor({
  rows,
  onChange,
  max,
  keyPlaceholder,
  addLabel,
}: {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  max?: number;
  keyPlaceholder: string;
  addLabel: string;
}) {
  const set = (i: number, patch: Partial<KeyValue>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kv-edit">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input
            value={r.key}
            placeholder={keyPlaceholder}
            onChange={(e) => set(i, { key: e.target.value })}
            spellCheck={false}
            aria-label="Key"
          />
          <input
            value={r.value}
            placeholder="value"
            onChange={(e) => set(i, { value: e.target.value })}
            spellCheck={false}
            aria-label="Value"
          />
          <button
            className="icon"
            title="Remove"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      {(max === undefined || rows.length < max) && (
        <button className="ghost kv-add" onClick={() => onChange([...rows, { key: "", value: "" }])}>
          <Icon name="plus" size={12} /> {addLabel}
        </button>
      )}
    </div>
  );
}

const sameKv = (a: KeyValue[], b: KeyValue[]) =>
  a.length === b.length && a.every((x, i) => x.key === b[i].key && x.value === b[i].value);

export function S3InfoModal({
  params,
  bucket,
  objKey,
  onClose,
}: {
  params: DbConnParams;
  bucket: string;
  objKey: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<S3ObjectInfo | null>(null);
  const [err, setErr] = useState("");
  const [tags, setTags] = useState<KeyValue[]>([]);
  const [meta, setMeta] = useState<KeyValue[]>([]);
  const [headers, setHeaders] = useState({
    contentType: "",
    cacheControl: "",
    contentDisposition: "",
    contentEncoding: "",
  });
  const [busy, setBusy] = useState<"" | "tags" | "meta">("");
  const [note, setNote] = useState("");

  async function load() {
    setErr("");
    try {
      const i = await api.s3ObjectInfo(params, bucket, objKey);
      setInfo(i);
      setTags(i.tags);
      setMeta(i.metadata);
      setHeaders({
        contentType: i.content_type,
        cacheControl: i.cache_control,
        contentDisposition: i.content_disposition,
        contentEncoding: i.content_encoding,
      });
    } catch (e) {
      setErr(String(e));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucket, objKey]);

  const tagsDirty = !!info && !sameKv(tags, info.tags);
  const metaDirty =
    !!info &&
    (!sameKv(meta, info.metadata) ||
      headers.contentType !== info.content_type ||
      headers.cacheControl !== info.cache_control ||
      headers.contentDisposition !== info.content_disposition ||
      headers.contentEncoding !== info.content_encoding);

  async function saveTags() {
    setBusy("tags");
    setErr("");
    setNote("");
    try {
      await api.s3SetTags(
        params,
        bucket,
        objKey,
        tags.filter((t) => t.key.trim() || t.value.trim()),
      );
      await load();
      setNote("Tags saved.");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy("");
    }
  }

  async function saveMeta() {
    setBusy("meta");
    setErr("");
    setNote("");
    try {
      await api.s3SetMetadata(params, bucket, objKey, {
        ...headers,
        metadata: meta.filter((m) => m.key.trim() || m.value.trim()),
      });
      await load();
      setNote("Metadata saved.");
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy("");
    }
  }

  const name = objKey.split("/").pop() || objKey;
  const s3uri = `s3://${bucket}/${objKey}`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal s3-info" onClick={(e) => e.stopPropagation()}>
        <h3>
          <Icon name="info" size={15} /> {maskText(name)}
        </h3>
        {!info && !err && (
          <div className="s3-info-loading">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {info && (
          <>
            <dl className="s3-info-facts">
              <dt>Location</dt>
              <dd>
                <code>{maskText(s3uri)}</code>
                <button className="icon" title="Copy S3 URI" onClick={() => void copyToClipboard(s3uri)}>
                  <Icon name="copy" size={12} />
                </button>
              </dd>
              <dt>Size</dt>
              <dd>
                {fmtSize(info.size)} <small>({info.size.toLocaleString()} bytes)</small>
              </dd>
              {info.modified !== null && (
                <>
                  <dt>Modified</dt>
                  <dd>{new Date(info.modified).toLocaleString()}</dd>
                </>
              )}
              {info.etag && (
                <>
                  <dt>ETag</dt>
                  <dd>
                    <code>{info.etag}</code>
                  </dd>
                </>
              )}
              {info.storage_class && (
                <>
                  <dt>Storage class</dt>
                  <dd>{info.storage_class}</dd>
                </>
              )}
              {info.version_id && info.version_id !== "null" && (
                <>
                  <dt>Version</dt>
                  <dd>
                    <code>{info.version_id}</code>
                  </dd>
                </>
              )}
            </dl>

            <div className="s3-info-section">
              <div className="s3-info-head">
                <span>Tags</span>
                <small>{tags.length}/10</small>
              </div>
              {info.tags_error ? (
                <p className="settings-hint">This server doesn't support object tags ({info.tags_error}).</p>
              ) : (
                <>
                  <KvEditor rows={tags} onChange={setTags} max={10} keyPlaceholder="key" addLabel="Add tag" />
                  <div className="form-row end">
                    <button onClick={saveTags} disabled={!tagsDirty || !!busy}>
                      {busy === "tags" ? "Saving…" : "Save tags"}
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="s3-info-section">
              <div className="s3-info-head">
                <span>Metadata</span>
              </div>
              <div className="s3-info-headers">
                <label>
                  Content-Type
                  <input
                    value={headers.contentType}
                    onChange={(e) => setHeaders({ ...headers, contentType: e.target.value })}
                    placeholder="application/octet-stream"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Cache-Control
                  <input
                    value={headers.cacheControl}
                    onChange={(e) => setHeaders({ ...headers, cacheControl: e.target.value })}
                    placeholder="max-age=3600"
                    spellCheck={false}
                  />
                </label>
                <label>
                  Content-Disposition
                  <input
                    value={headers.contentDisposition}
                    onChange={(e) => setHeaders({ ...headers, contentDisposition: e.target.value })}
                    placeholder='attachment; filename="report.pdf"'
                    spellCheck={false}
                  />
                </label>
                <label>
                  Content-Encoding
                  <input
                    value={headers.contentEncoding}
                    onChange={(e) => setHeaders({ ...headers, contentEncoding: e.target.value })}
                    placeholder="gzip"
                    spellCheck={false}
                  />
                </label>
              </div>
              <div className="s3-info-sub">User metadata (x-amz-meta-*)</div>
              <KvEditor rows={meta} onChange={setMeta} keyPlaceholder="key" addLabel="Add metadata" />
              <p className="settings-hint">
                Saving metadata rewrites the object onto itself (S3 has no in-place edit), so
                its Modified time changes. Tags are kept. Objects over 5 GB can't be rewritten
                this way.
              </p>
              <div className="form-row end">
                <button onClick={saveMeta} disabled={!metaDirty || !!busy}>
                  {busy === "meta" ? "Saving…" : "Save metadata"}
                </button>
              </div>
            </div>
          </>
        )}
        {note && !err && <p className="s3-info-note">{note}</p>}
        {err && <pre className="error">{err}</pre>}
        <div className="form-row end">
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
