import { useEffect, useRef, useState, type CSSProperties } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, type DbConnParams } from "./api";
import { openDbConnection } from "./dbConnect";
import type { DbProfile, S3Bucket, S3Entry, S3Preview, SshProfile } from "./types";
import { Icon } from "./Icon";
import { PdfPreview } from "./PdfPreview";
import { AskModal, type AskOptions } from "./AskModal";
import { maskText } from "./privacy";
import { subscribeSettings } from "./settings";

/** AWS bucket-name rules (3–63 chars, lowercase/digits/dots/hyphens, alnum ends) —
 *  checked client-side so a typo fails fast instead of as a signed request. */
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Row "more actions" flyout (rename/copy/move) — inline-styled because App.css
 *  is shared; colours come from the same variables the rest of the app uses. */
const flyoutStyle: CSSProperties = {
  position: "fixed",
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  boxShadow: "var(--shadow)",
  padding: 4,
  // Right-align the menu to the button's right edge.
  transform: "translateX(-100%)",
};

const flyoutItemStyle: CSSProperties = {
  justifyContent: "flex-start",
  gap: 6,
  whiteSpace: "nowrap",
};

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
  // True when ListBuckets was denied (bucket-scoped credentials) — the
  // sidebar then offers "Open…" to browse a bucket by its exact name.
  const [listDenied, setListDenied] = useState(false);
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
  // Row whose "more actions" flyout is open (rename/copy/move), with the
  // fixed-position anchor taken from the button — WebKit ignores
  // position:relative on table cells, so the menu can't anchor inside the row.
  const [menuFor, setMenuFor] = useState<{ key: string; x: number; y: number } | null>(null);
  // Names render through maskText, so re-render when privacy settings change.
  const [, setPrivacyRev] = useState(0);
  useEffect(() => subscribeSettings(() => setPrivacyRev((n) => n + 1)), []);

  async function connect() {
    setBusy(true);
    setError("");
    let tunnelId: string | null = null;
    try {
      const { params: p, tunnelId: tid } = await openDbConnection(prefill, sshProfiles);
      tunnelId = tid;
      // ListBuckets doubles as the liveness probe — bad endpoint/creds fail here.
      let list: S3Bucket[] = [];
      let denied = false;
      try {
        list = await api.s3ListBuckets(p);
      } catch (e) {
        // AccessDenied proves the endpoint and credentials authenticate — the
        // policy just lacks s3:ListAllMyBuckets. Stay connected with an empty
        // list; "Open…" in the sidebar is the escape hatch.
        if (!/access ?denied/i.test(String(e))) throw e;
        denied = true;
      }
      tunnelIdRef.current = tunnelId;
      setParams(p);
      setBuckets(list);
      setListDenied(denied);
      setConnected(true);
      onSession?.(prefill.name || `${prefill.host}:${prefill.port}`);
    } catch (e) {
      if (tunnelId) await api.tunnelStop(tunnelId).catch(() => {});
      setError(String(e));
      setConnected(false);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    // Invalidate any in-flight list() so a late response can't repopulate state.
    listGen.current++;
    const tid = tunnelIdRef.current;
    if (tid) await api.tunnelStop(tid).catch(() => {});
    tunnelIdRef.current = null;
    setConnected(false);
    setBuckets([]);
    setListDenied(false);
    setBucket(null);
    setPrefix("");
    setEntries([]);
    setNextToken(null);
    setTransfer("");
    setStatus("");
    setPreview(null);
    setMenuFor(null);
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

  // Generation counter for list(): responses from a superseded call are dropped
  // so a slow listing (or a late Load-more append) can't clobber a newer one.
  const listGen = useRef(0);

  /** List one page of `pfx` in bucket `b`; a token appends the next page. */
  async function list(b: string, pfx: string, token: string | null) {
    if (!params) return;
    // Replace-mode starts a new generation; an append joins the current one,
    // so any refresh that starts later invalidates an in-flight append.
    const gen = token === null ? ++listGen.current : listGen.current;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const res = await api.s3ListObjects(params, b, pfx, token);
      if (gen !== listGen.current) return; // stale — a newer list() superseded it
      setEntries((cur) => (token ? [...cur, ...res.entries] : res.entries));
      setNextToken(res.next_token);
    } catch (e) {
      if (gen === listGen.current) setError(String(e));
    } finally {
      if (gen === listGen.current) setBusy(false);
    }
  }

  function openBucket(name: string) {
    if (busy || transfer) return;
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
    // No filter(Boolean): keys can legally contain "//", so empty segments must
    // survive for the rebuilt prefix to match the real one exactly. `prefix` is
    // "" or "/"-terminated, so slice(0, -1) just drops the trailing empty part.
    const segs = prefix.split("/").slice(0, -1);
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
    if (!params || transfer) return;
    setAsk({
      title: "New bucket",
      initial: "",
      confirmText: "Create",
      run: (name) => {
        const n = name.trim();
        if (!BUCKET_NAME_RE.test(n)) {
          return "Bucket names are 3–63 lowercase letters, digits, dots or hyphens.";
        }
        void (async () => {
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
        })();
      },
    });
  }

  /** Escape hatch for credentials without s3:ListAllMyBuckets — open a bucket
   *  by its exact name (listing inside a bucket needs no ListBuckets). */
  function openBucketByName() {
    if (!params || transfer) return;
    setAsk({
      title: "Open bucket",
      label: "Enter the exact bucket name.",
      initial: "",
      confirmText: "Open",
      run: (name) => {
        const n = name.trim();
        if (!BUCKET_NAME_RE.test(n)) {
          return "Bucket names are 3–63 lowercase letters, digits, dots or hyphens.";
        }
        // Add it to the sidebar so it behaves like any listed bucket.
        setBuckets((cur) =>
          cur.some((b) => b.name === n) ? cur : [...cur, { name: n, created: null }],
        );
        openBucket(n);
      },
    });
  }

  function deleteBucket(name: string) {
    if (!params || transfer) return;
    setAsk({
      title: "Delete bucket",
      label: `Permanently delete bucket "${name}"? This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
      run: () => {
        void (async () => {
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
        })();
      },
    });
  }

  function emptyAndDelete(name: string) {
    if (!params || transfer) return;
    setAsk({
      title: "Empty and delete",
      label: `Bucket "${name}" is not empty. Type its name to delete every object inside, then the bucket itself.`,
      initial: "",
      confirmText: "Empty and delete",
      danger: true,
      run: (typed) => {
        if (typed.trim() !== name) {
          return "Bucket name did not match — nothing deleted.";
        }
        void (async () => {
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
        })();
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
    const doPut = async () => {
      setTransfer(`Uploading ${name}…`);
      try {
        await api.s3Upload(params, bucket, prefix + name, local);
        await list(bucket, prefix, null);
      } catch (e) {
        setError(String(e));
      } finally {
        setTransfer("");
      }
    };
    // A PUT silently replaces an existing object, so confirm known collisions
    // first (only the loaded listing is checked — unloaded pages can't be).
    if (entries.some((en) => !en.is_dir && en.name === name)) {
      setAsk({
        title: "Replace object",
        label: `"${name}" already exists here. Replace it? This cannot be undone.`,
        confirmText: "Replace",
        danger: true,
        // Fire-and-forget so the modal closes and the transfer note takes over.
        run: () => {
          void doPut();
        },
      });
    } else {
      await doPut();
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
    if (!params || !bucket || transfer) return;
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
    if (!params || !bucket || transfer) return;
    const b = bucket;
    setAsk({
      title: "Delete folder recursively",
      label: `Every object under "${e.name}/" will be deleted. Type the folder name to confirm.`,
      initial: "",
      confirmText: "Delete all",
      danger: true,
      run: (typed) => {
        if (typed.trim() !== e.name) {
          return "Folder name did not match — nothing deleted.";
        }
        void (async () => {
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
        })();
      },
    });
  }

  /** Rename in place: S3 has no rename, so it's a server-side copy to the same
   *  prefix under the new name, then delete of the source (recursive for folders). */
  function renameEntry(e: S3Entry) {
    if (!params || !bucket || transfer) return;
    const b = bucket;
    setAsk({
      title: e.is_dir ? "Rename folder" : "Rename object",
      initial: e.name,
      confirmText: "Rename",
      run: (name) => {
        if (!name.trim()) return "Enter a name.";
        if (name !== name.trim()) return "No leading or trailing spaces.";
        if (name.includes("/")) return "Names cannot contain \"/\".";
        if (name === e.name) return "Name unchanged.";
        // A copy silently replaces the target, so refuse known collisions
        // (only the loaded listing is checked — unloaded pages can't be).
        if (entries.some((en) => en.name === name && en.is_dir === e.is_dir)) {
          return `"${name}" already exists here.`;
        }
        void (async () => {
          setTransfer(`Renaming ${e.name}…`);
          setError("");
          try {
            if (e.is_dir) {
              const n = await api.s3CopyPrefix(params, b, e.key, b, prefix + name + "/", true);
              await list(b, prefix, null);
              setStatus(`Renamed ${n} object${n === 1 ? "" : "s"}.`);
            } else {
              await api.s3CopyObject(params, b, e.key, b, prefix + name, true);
              await list(b, prefix, null);
              setStatus(`Renamed "${e.name}" to "${name}".`);
            }
          } catch (err) {
            setError(String(err));
          } finally {
            setTransfer("");
          }
        })();
      },
    });
  }

  /** Shared "Copy to…" / "Move to…" modal. The destination is typed as
   *  "bucket" or "bucket/prefix/" — the first "/" splits bucket from prefix.
   *  Move is the same server-side copy with the source deleted afterwards. */
  function copyMoveEntry(e: S3Entry, move: boolean) {
    if (!params || !bucket || transfer) return;
    const b = bucket;
    const verb = move ? "Move" : "Copy";
    setAsk({
      title: `${verb} ${e.is_dir ? "folder" : "object"}`,
      label: `Destination for "${e.name}${e.is_dir ? "/" : ""}" as "bucket" or "bucket/prefix/".`,
      initial: `${b}/${prefix}`,
      confirmText: verb,
      run: (dest) => {
        const d = dest.trim();
        const slash = d.indexOf("/");
        const destBucket = slash < 0 ? d : d.slice(0, slash);
        let destPrefix = slash < 0 ? "" : d.slice(slash + 1);
        if (destPrefix && !destPrefix.endsWith("/")) destPrefix += "/";
        if (!BUCKET_NAME_RE.test(destBucket)) {
          return "Bucket names are 3–63 lowercase letters, digits, dots or hyphens.";
        }
        if (destBucket === b && destPrefix === prefix) {
          return "Source and destination are the same.";
        }
        // Copying a folder into itself would recurse over its own copies.
        if (e.is_dir && destBucket === b && destPrefix.startsWith(e.key)) {
          return "Destination is inside the source folder.";
        }
        void (async () => {
          setTransfer(`${move ? "Moving" : "Copying"} ${e.name}…`);
          setError("");
          try {
            if (e.is_dir) {
              const n = await api.s3CopyPrefix(
                params,
                b,
                e.key,
                destBucket,
                destPrefix + e.name + "/",
                move,
              );
              await list(b, prefix, null);
              setStatus(`${move ? "Moved" : "Copied"} ${n} object${n === 1 ? "" : "s"}.`);
            } else {
              await api.s3CopyObject(params, b, e.key, destBucket, destPrefix + e.name, move);
              await list(b, prefix, null);
              setStatus(`${move ? "Moved" : "Copied"} "${e.name}".`);
            }
          } catch (err) {
            setError(String(err));
          } finally {
            setTransfer("");
          }
        })();
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

  // Keep empty segments (keys with "//") so crumbTo() rebuilds exact prefixes;
  // prefix is "" or "/"-terminated, so slice(0, -1) drops the trailing empty part.
  const segs = prefix.split("/").slice(0, -1);

  return (
    <div className="panel db-body">
      <div className="schema">
        <div className="schema-head">
          <button
            className="ghost"
            onClick={newBucket}
            disabled={busy || !!transfer}
            title="Create a new bucket"
          >
            <Icon name="plus" size={12} /> Bucket
          </button>
          <button
            className="ghost"
            onClick={openBucketByName}
            disabled={busy || !!transfer}
            title="Open a bucket by name (works without ListBuckets permission)"
          >
            <Icon name="bucket" size={12} /> Open…
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
              disabled={busy || !!transfer}
              onClick={(ev) => {
                ev.stopPropagation();
                deleteBucket(b.name);
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))}
        {buckets.length === 0 && !busy && (
          <p className="empty">
            {listDenied
              ? "Listing buckets is not permitted — use “Open…” to browse a bucket by name."
              : "No buckets."}
          </p>
        )}
      </div>

      <div className="query-area">
        {bucket && (
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
                    {s === "" ? "·" : maskText(s)}
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
        )}
        {/* Outside the bucket branch so bulk deletes started from the sidebar
            (no bucket open) still show progress and their outcome. */}
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
        {bucket ? (
          <>
            {preview ? (
              <>
                <div className="form-row">
                  <button className="ghost" onClick={() => setPreview(null)}>
                    <Icon name="back" size={14} /> Back
                  </button>
                  <button
                    className="ghost"
                    onClick={() => download(preview.entry)}
                    disabled={!!transfer}
                  >
                    <Icon name="download" size={14} /> Download
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
                {preview.data.kind === "pdf" && (
                  <PdfPreview data={preview.data.content} name={preview.entry.name} />
                )}
                {(preview.data.kind === "binary" || preview.data.kind === "too-large") && (
                  <p className="empty">
                    {preview.data.kind === "too-large"
                      ? "Too large to preview — use Download."
                      : "Binary content — no preview. Use Download."}
                  </p>
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
                            title="Rename, copy or move"
                            disabled={!!transfer}
                            onClick={(ev) => {
                              const r = ev.currentTarget.getBoundingClientRect();
                              setMenuFor(
                                menuFor?.key === e.key
                                  ? null
                                  : { key: e.key, x: r.right, y: r.bottom + 4 },
                              );
                            }}
                          >
                            ⋯
                          </button>
                          <button
                            className="icon"
                            title="Delete"
                            disabled={!!transfer}
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
          <p className="empty">Select a bucket on the left.</p>
        )}
      </div>
      {menuFor &&
        (() => {
          const entry = entries.find((en) => en.key === menuFor.key);
          if (!entry) return null;
          return (
            <>
              {/* Backdrop closes the flyout on any outside click. */}
              <div
                style={{ position: "fixed", inset: 0, zIndex: 9 }}
                onClick={() => setMenuFor(null)}
              />
              <div style={{ ...flyoutStyle, left: menuFor.x, top: menuFor.y }}>
                <button
                  className="ghost"
                  style={flyoutItemStyle}
                  onClick={() => {
                    setMenuFor(null);
                    renameEntry(entry);
                  }}
                >
                  Rename…
                </button>
                <button
                  className="ghost"
                  style={flyoutItemStyle}
                  onClick={() => {
                    setMenuFor(null);
                    copyMoveEntry(entry, false);
                  }}
                >
                  Copy to…
                </button>
                <button
                  className="ghost"
                  style={flyoutItemStyle}
                  onClick={() => {
                    setMenuFor(null);
                    copyMoveEntry(entry, true);
                  }}
                >
                  Move to…
                </button>
              </div>
            </>
          );
        })()}
      {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}
    </div>
  );
}
