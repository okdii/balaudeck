import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type DbConnParams } from "./api";
import { openDbConnection } from "./dbConnect";
import type { DbProfile, S3Bucket, S3Entry, S3Preview, SshProfile } from "./types";
import { Icon } from "./Icon";
import { AskModal, type AskOptions } from "./AskModal";
import { maskText } from "./privacy";
import { subscribeSettings } from "./settings";

/** AWS bucket-name rules (3–63 chars, lowercase/digits/dots/hyphens, alnum ends) —
 *  checked client-side so a typo fails fast instead of as a signed request. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** Parent of "a/b/c/" is "a/b/"; a top-level prefix falls back to "" (bucket root). */
function parentPrefix(p: string): string {
  const parts = p.replace(/\/$/, "").split("/");
  parts.pop();
  return parts.length ? parts.join("/") + "/" : "";
}

/** S3-compatible object browser: buckets on the left, keys under the current
 *  prefix on the right (ListObjectsV2's "/" delimiter provides the folder illusion). */
export function S3Panel({
  prefill,
  sshProfiles,
  onSession,
  dcSignal,
}: {
  prefill: DbProfile;
  sshProfiles: SshProfile[];
  onSession?: (label: string) => void;
  dcSignal?: number;
}) {
  const [params, setParams] = useState<DbConnParams | null>(null);
  const tunnelIdRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [buckets, setBuckets] = useState<S3Bucket[]>([]);
  const [bucket, setBucket] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [entries, setEntries] = useState<S3Entry[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  // Non-empty while a transfer or bulk delete is running; also disables the
  // toolbar so a second operation can't start mid-flight.
  const [transfer, setTransfer] = useState("");
  // Transient outcome line, e.g. "Deleted 42 objects." after a recursive delete.
  const [status, setStatus] = useState("");
  const [preview, setPreview] = useState<{ entry: S3Entry; data: S3Preview } | null>(null);
  const [ask, setAsk] = useState<AskOptions | null>(null);
  // Names render through maskText, so re-render when privacy settings change.
  const [, setPrivacyRev] = useState(0);
  useEffect(() => subscribeSettings(() => setPrivacyRev((n) => n + 1)), []);

  async function connect() {
    setBusy(true);
    setError("");
    try {
      const { params: p, tunnelId } = await openDbConnection(prefill, sshProfiles);
      // ListBuckets doubles as the liveness probe — bad endpoint/creds fail here.
      const list = await api.s3ListBuckets(p);
      tunnelIdRef.current = tunnelId;
      setParams(p);
      setBuckets(list);
      setConnected(true);
      onSession?.(prefill.name || `${prefill.host}:${prefill.port}`);
    } catch (e) {
      setError(String(e));
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    const tid = tunnelIdRef.current;
    if (tid) await api.tunnelStop(tid).catch(() => {});
    tunnelIdRef.current = null;
    setConnected(false);
    setBuckets([]);
    setBucket(null);
    setPrefix("");
    setEntries([]);
    setNextToken(null);
    setTransfer("");
    setStatus("");
    setPreview(null);
  }

  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (dcSignal) disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dcSignal]);

  /** List one page of `pfx` in bucket `b`; a token appends the next page. */
  async function list(b: string, pfx: string, token: string | null) {
    if (!params) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const res = await api.s3ListObjects(params, b, pfx, token);
      setEntries((cur) => (token ? [...cur, ...res.entries] : res.entries));
      setNextToken(res.next_token);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function openBucket(name: string) {
    if (transfer) return;
    setBucket(name);
    setPrefix("");
    setEntries([]);
    setNextToken(null);
    setPreview(null);
    list(name, "", null);
  }

  function openFolder(e: S3Entry) {
    if (!bucket || transfer) return;
    setPrefix(e.key);
    setPreview(null);
    list(bucket, e.key, null);
  }

  function up() {
    if (!bucket || prefix === "" || transfer) return;
    const p = parentPrefix(prefix);
    setPrefix(p);
    setPreview(null);
    list(bucket, p, null);
  }

  /** Jump to a breadcrumb segment; -1 is the bucket root. */
  function crumbTo(i: number) {
    if (!bucket || transfer) return;
    const segs = prefix.split("/").filter(Boolean);
    const p = i < 0 ? "" : segs.slice(0, i + 1).join("/") + "/";
    setPrefix(p);
    setPreview(null);
    list(bucket, p, null);
  }

  async function refreshBuckets() {
    if (!params) return;
    try {
      setBuckets(await api.s3ListBuckets(params));
    } catch (e) {
      setError(String(e));
    }
  }

  function newBucket() {
    if (!params) return;
    setAsk({
      title: "New bucket",
      initial: "",
      confirmText: "Create",
      run: async (name) => {
        const n = name.trim();
        if (!BUCKET_NAME_RE.test(n)) {
          setError("Bucket names are 3–63 lowercase letters, digits, dots or hyphens.");
          return;
        }
        setBusy(true);
        setError("");
        try {
          await api.s3CreateBucket(params, n);
          await refreshBuckets();
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function deleteBucket(name: string) {
    if (!params) return;
    setAsk({
      title: "Delete bucket",
      label: `Permanently delete bucket "${name}"? This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
      run: async () => {
        setBusy(true);
        setError("");
        try {
          await api.s3DeleteBucket(params, name);
          await afterBucketDelete(name);
        } catch (e) {
          const msg = String(e);
          // Non-empty buckets can't be deleted directly — offer the
          // type-the-name "empty and delete" flow instead.
          if (msg.includes("BucketNotEmpty") || /not empty/i.test(msg)) {
            emptyAndDelete(name);
          } else {
            setError(msg);
          }
        } finally {
          setBusy(false);
        }
      },
    });
  }

  function emptyAndDelete(name: string) {
    if (!params) return;
    setAsk({
      title: "Empty and delete",
      label: `Bucket "${name}" is not empty. Type its name to delete every object inside, then the bucket itself.`,
      initial: "",
      confirmText: "Empty and delete",
      danger: true,
      run: async (typed) => {
        if (typed.trim() !== name) {
          setError("Bucket name did not match — nothing deleted.");
          return;
        }
        setTransfer(`Emptying ${name}…`);
        setError("");
        try {
          const n = await api.s3DeletePrefix(params, name, "");
          await api.s3DeleteBucket(params, name);
          await afterBucketDelete(name);
          setStatus(`Deleted ${n} object${n === 1 ? "" : "s"} and bucket "${name}".`);
        } catch (e) {
          setError(String(e));
        } finally {
          setTransfer("");
        }
      },
    });
  }

  async function afterBucketDelete(name: string) {
    if (bucket === name) {
      setBucket(null);
      setPrefix("");
      setEntries([]);
      setNextToken(null);
      setPreview(null);
    }
    await refreshBuckets();
  }

  async function upload() {
    if (!params || !bucket || transfer) return;
    const local = await open({ multiple: false });
    if (!local || Array.isArray(local)) return;
    // Split on both separators so Windows paths (C:\…\file) yield just the name.
    const name = local.split(/[\\/]/).pop() || "upload";
    setTransfer(`Uploading ${name}…`);
    try {
      await api.s3Upload(params, bucket, prefix + name, local);
      await list(bucket, prefix, null);
    } catch (e) {
      setError(String(e));
    } finally {
      setTransfer("");
    }
  }

  async function download(e: S3Entry) {
    if (!params || !bucket || transfer) return;
    const local = await save({ defaultPath: e.name });
    if (!local) return;
    setTransfer(`Downloading ${e.name}…`);
    try {
      await api.s3Download(params, bucket, e.key, local);
    } catch (err) {
      setError(String(err));
    } finally {
      setTransfer("");
    }
  }

  function mkdir() {
    if (!params || !bucket) return;
    const b = bucket;
    setAsk({
      title: "New folder",
      initial: "",
      confirmText: "Create",
      run: async (name) => {
        const n = name.trim().replace(/\/+$/, "");
        if (!n) return;
        try {
          await api.s3CreateFolder(params, b, prefix + n);
          await list(b, prefix, null);
        } catch (e) {
          setError(String(e));
        }
      },
    });
  }

  function removeFile(e: S3Entry) {
    if (!params || !bucket) return;
    const b = bucket;
    setAsk({
      title: `Delete ${e.name}?`,
      label: "This cannot be undone.",
      confirmText: "Delete",
      danger: true,
      run: async () => {
        try {
          await api.s3DeleteObject(params, b, e.key);
          await list(b, prefix, null);
        } catch (err) {
          setError(String(err));
        }
      },
    });
  }

  function removeFolder(e: S3Entry) {
    if (!params || !bucket) return;
    const b = bucket;
    setAsk({
      title: "Delete folder recursively",
      label: `Every object under "${e.name}/" will be deleted. Type the folder name to confirm.`,
      initial: "",
      confirmText: "Delete all",
      danger: true,
      run: async (typed) => {
        if (typed.trim() !== e.name) {
          setError("Folder name did not match — nothing deleted.");
          return;
        }
        setTransfer(`Deleting ${e.name}/…`);
        setError("");
        try {
          const n = await api.s3DeletePrefix(params, b, e.key);
          await list(b, prefix, null);
          setStatus(`Deleted ${n} object${n === 1 ? "" : "s"}.`);
        } catch (err) {
          setError(String(err));
        } finally {
          setTransfer("");
        }
      },
    });
  }

  async function openPreview(e: S3Entry) {
    if (!params || !bucket || transfer) return;
    setBusy(true);
    setError("");
    try {
      const data = await api.s3Preview(params, bucket, e.key);
      setPreview({ entry: e, data });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <div className="panel">
        <div className="launcher">
          <div className="launcher-card">
            <h3>
              <Icon name="bucket" size={16} /> {prefill.name || "Object storage"}
            </h3>
            {error && <pre className="error">{error}</pre>}
            <button onClick={connect} disabled={busy}>
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const segs = prefix.split("/").filter(Boolean);

  return (
    <div className="panel db-body">
      <div className="schema">
        <div className="schema-head">
          <button className="ghost" onClick={newBucket} title="Create a new bucket">
            <Icon name="plus" size={12} /> Bucket
          </button>
        </div>
        {buckets.map((b) => (
          <div
            key={b.name}
            className={"schema-item" + (bucket === b.name ? " active" : "")}
            onClick={() => openBucket(b.name)}
            title={b.created !== null ? `Created ${fmtDate(b.created)}` : undefined}
          >
            <Icon name="bucket" size={13} /> {maskText(b.name)}
            <button
              className="icon"
              style={{ marginLeft: "auto" }}
              title="Delete bucket"
              onClick={(ev) => {
                ev.stopPropagation();
                deleteBucket(b.name);
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
        {buckets.length === 0 && !busy && <p className="empty">No buckets.</p>}
      </div>

      <div className="query-area">
        {bucket ? (
          <>
            <div className="form-row">
              <button className="ghost" onClick={up} disabled={prefix === "" || !!transfer}>
                <Icon name="folderUp" size={14} /> Up
              </button>
              <code className="path">
                <button className="icon" title="Bucket root" onClick={() => crumbTo(-1)}>
                  {maskText(bucket)}
                </button>
                {segs.map((s, i) => (
                  <span key={i}>
                    {"/"}
                    <button className="icon" onClick={() => crumbTo(i)}>
                      {maskText(s)}
                    </button>
                  </span>
                ))}
              </code>
              <button
                className="ghost"
                onClick={() => list(bucket, prefix, null)}
                disabled={!!transfer}
              >
                <Icon name="refresh" size={14} /> Refresh
              </button>
              <button onClick={upload} disabled={!!transfer}>
                <Icon name="upload" size={14} /> Upload
              </button>
              <button className="ghost" onClick={mkdir} disabled={!!transfer}>
                <Icon name="folder" size={14} /> New folder
              </button>
            </div>
            {transfer && (
              <div className="trunc-note">
                <Icon name="refresh" size={12} /> {transfer}
              </div>
            )}
            {status && !transfer && (
              <div className="trunc-note">
                <Icon name="info" size={12} /> {status}
              </div>
            )}
            {error && <pre className="error">{error}</pre>}
            {preview ? (
              <>
                <div className="form-row">
                  <button className="ghost" onClick={() => setPreview(null)}>
                    <Icon name="back" size={14} /> Back
                  </button>
                </div>
                <div className="mongo-meta">
                  {maskText(preview.entry.key)} · {preview.data.content_type} ·{" "}
                  {fmtSize(preview.data.size)}
                  {preview.data.truncated ? " · truncated" : ""}
                </div>
                {preview.data.kind === "text" && (
                  <div className="mongo-docs">
                    <pre className="mongo-doc">{maskText(preview.data.content)}</pre>
                  </div>
                )}
                {preview.data.kind === "image" && (
                  <div className="mongo-docs">
                    <img
                      className="s3-preview-img"
                      src={`data:${preview.data.content_type};base64,${preview.data.content}`}
                      alt={preview.entry.name}
                    />
                  </div>
                )}
                {(preview.data.kind === "binary" || preview.data.kind === "too-large") && (
                  <>
                    <p className="empty">
                      {preview.data.kind === "too-large"
                        ? "Too large to preview."
                        : "Binary content — no preview."}
                    </p>
                    <div className="form-row">
                      <button onClick={() => download(preview.entry)} disabled={!!transfer}>
                        <Icon name="download" size={14} /> Download
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="grid-wrap sftp-wrap">
                <table className="grid sftp">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Size</th>
                      <th>Modified</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.key}>
                        <td
                          className="clickable name-cell"
                          onClick={() => (e.is_dir ? openFolder(e) : openPreview(e))}
                        >
                          <Icon
                            name={e.is_dir ? "folder" : "table"}
                            size={14}
                            className="file-glyph"
                          />
                          {maskText(e.name)}
                        </td>
                        <td>{e.is_dir ? "" : fmtSize(e.size)}</td>
                        <td>{e.modified !== null ? fmtDate(e.modified) : ""}</td>
                        <td className="row-actions">
                          {!e.is_dir && (
                            <>
                              <button className="icon" title="Preview" onClick={() => openPreview(e)}>
                                <Icon name="eye" size={14} />
                              </button>
                              <button className="icon" title="Download" onClick={() => download(e)}>
                                <Icon name="download" size={14} />
                              </button>
                            </>
                          )}
                          <button
                            className="icon"
                            title="Delete"
                            onClick={() => (e.is_dir ? removeFolder(e) : removeFile(e))}
                          >
                            <Icon name="trash" size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {nextToken && (
                  <button
                    className="ghost"
                    onClick={() => list(bucket, prefix, nextToken)}
                    disabled={busy}
                  >
                    Load more…
                  </button>
                )}
                {entries.length === 0 && !busy && <p className="empty">No objects.</p>}
              </div>
            )}
          </>
        ) : (
          <>
            {error && <pre className="error">{error}</pre>}
            <p className="empty">Select a bucket on the left.</p>
          </>
        )}
      </div>
      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}
    </div>
  );
}
