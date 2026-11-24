// Connection backups to your own S3 bucket (Sync → S3 bucket tab).
//
// Same encrypted bundle as Export/Google Drive (connections_export), written
// as a timestamped object so earlier backups stay restorable:
//   <folder>/balaudeck-connections-20261124-153012.balaudeck
// Uses a saved S3 profile (its secret stays in the keychain; SSH-tunnelled
// profiles work through openDbConnection). The last choice is remembered.

import { useEffect, useRef, useState } from "react";
import { api, type DbConnParams } from "./api";
import { openDbConnection } from "./dbConnect";
import type { DbProfile, ImportSummary, S3Entry, SshProfile } from "./types";
import { Icon, Spinner } from "./Icon";
import { ComboInput } from "./ComboInput";
import type { AskOptions } from "./AskModal";

const PREF_KEY = "balaudeck.s3backup";
const EXT = ".balaudeck";

interface Pref {
  profileId: string;
  bucket: string;
  folder: string;
}

function loadPref(): Pref {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    return { profileId: p.profileId ?? "", bucket: p.bucket ?? "", folder: p.folder ?? "balaudeck-backups/" };
  } catch {
    return { profileId: "", bucket: "", folder: "balaudeck-backups/" };
  }
}

/** "a/b" → "a/b/", "" stays "" (bucket root), leading "/" dropped. */
export function normFolder(f: string): string {
  const t = f.trim().replace(/^\/+/, "");
  return !t ? "" : t.endsWith("/") ? t : t + "/";
}

/** 20261124-153012 in local time — sorts by name the same as by date. */
export function backupStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function S3BackupBody({
  setAsk,
  onImported,
  setError,
}: {
  setAsk: (a: AskOptions) => void;
  onImported: () => void;
  setError: (e: string | null) => void;
}) {
  const [profiles, setProfiles] = useState<DbProfile[]>([]);
  const [sshProfiles, setSshProfiles] = useState<SshProfile[]>([]);
  const [pref, setPref] = useState<Pref>(loadPref);
  const [pass, setPass] = useState("");
  const [buckets, setBuckets] = useState<string[]>([]);
  const [backups, setBackups] = useState<S3Entry[] | null>(null);
  const [busy, setBusy] = useState<"" | "connect" | "push" | "pull" | "list">("");
  const [msg, setMsg] = useState("");
  // Open connection (+ tunnel) for the chosen profile, reused across actions.
  const conn = useRef<{ profileId: string; params: DbConnParams; tunnelId: string | null } | null>(null);

  useEffect(() => {
    api
      .profilesLoad()
      .then((s) => {
        const s3 = s.db.filter((p) => p.engine === "s3");
        setProfiles(s3);
        setSshProfiles(s.ssh);
        setPref((p) => (p.profileId || !s3.length ? p : { ...p, profileId: s3[0].id }));
      })
      .catch((e) => setError(String(e)));
    return () => {
      const t = conn.current?.tunnelId;
      if (t) void api.tunnelStop(t).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(pref));
    } catch {
      /* ignore */
    }
  }, [pref]);

  const profile = profiles.find((p) => p.id === pref.profileId) ?? null;
  const folder = normFolder(pref.folder);

  async function params(): Promise<DbConnParams> {
    if (!profile) throw new Error("Pick an S3 connection first.");
    if (conn.current?.profileId === profile.id) return conn.current.params;
    const old = conn.current?.tunnelId;
    if (old) await api.tunnelStop(old).catch(() => {});
    const { params: p, tunnelId } = await openDbConnection(profile, sshProfiles);
    conn.current = { profileId: profile.id, params: p, tunnelId };
    return p;
  }

  async function loadBuckets() {
    setBusy("connect");
    setError(null);
    try {
      const list = await api.s3ListBuckets(await params());
      setBuckets(list.map((b) => b.name));
      if (!pref.bucket && list.length) setPref((p) => ({ ...p, bucket: list[0].name }));
    } catch (e) {
      // Bucket-scoped keys can't list buckets; typing the name still works.
      if (!/access ?denied/i.test(String(e))) setError(String(e));
      setBuckets([]);
    } finally {
      setBusy("");
    }
  }

  async function listBackups() {
    if (!pref.bucket.trim()) return;
    setBusy("list");
    setError(null);
    try {
      const all = await api.s3ListFiles(await params(), pref.bucket.trim(), folder);
      setBackups(all.filter((e) => e.name.endsWith(EXT)));
    } catch (e) {
      setBackups(null);
      setError(String(e));
    } finally {
      setBusy("");
    }
  }

  // New profile → new connection + bucket list; bucket/folder change → relist.
  useEffect(() => {
    setBuckets([]);
    setBackups(null);
    if (profile) void loadBuckets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pref.profileId, profiles.length]);
  useEffect(() => {
    setBackups(null);
    if (!profile || !pref.bucket.trim()) return;
    const t = setTimeout(() => void listBackups(), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pref.profileId, pref.bucket, folder]);

  async function push() {
    setMsg("");
    setError(null);
    const pw = pass.trim();
    if (pw.length < 6) {
      setError("Passphrase must be at least 6 characters.");
      return;
    }
    if (!pref.bucket.trim()) {
      setError("Enter the bucket to back up into.");
      return;
    }
    setBusy("push");
    try {
      const bundle = await api.connectionsExport(pw);
      const key = `${folder}balaudeck-connections-${backupStamp()}${EXT}`;
      await api.s3PutText(await params(), pref.bucket.trim(), key, bundle, "application/octet-stream");
      setMsg(`Backed up to s3://${pref.bucket.trim()}/${key}`);
      setBusy("");
      await listBackups();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }

  function restore(b: S3Entry) {
    setMsg("");
    setError(null);
    const pw = pass.trim();
    if (!pw) {
      setError("Enter the passphrase this backup was made with.");
      return;
    }
    setAsk({
      title: "Restore from S3",
      label: `Merge ${b.name} into your connections? Profiles with the same name are overwritten.`,
      confirmText: "Restore",
      run: async () => {
        setBusy("pull");
        try {
          const text = await api.s3GetText(await params(), pref.bucket.trim(), b.key);
          const s: ImportSummary = await api.connectionsImport(pw, text.trim());
          onImported();
          setMsg(
            `Restored ${b.name}: ${s.ssh} SSH · ${s.db} DB · ${s.sftp} SFTP · ${s.tunnel} tunnel · ` +
              `${s.folders} folders · ${s.queries} queries · ${s.notes} notes · ${s.secrets} secrets.`,
          );
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy("");
        }
      },
    });
  }

  if (!profiles.length) {
    return (
      <div className="sync-body">
        <p className="sync-hint">
          Add an S3 connection first (any S3-compatible storage: AWS S3, MinIO, R2, Wasabi…),
          then come back here to back up your connections into one of its buckets.
        </p>
      </div>
    );
  }

  return (
    <div className="sync-body">
      <label>
        S3 connection
        <select
          value={pref.profileId}
          onChange={(e) => {
            const id = e.target.value;
            setPref((p) => ({ ...p, profileId: id, bucket: "" }));
          }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || `${p.host}:${p.port}`}
            </option>
          ))}
        </select>
      </label>
      <div className="form-row">
        <label className="grow">
          Bucket {busy === "connect" && <Spinner size={11} />}
          <ComboInput
            value={pref.bucket}
            onChange={(v) => setPref((p) => ({ ...p, bucket: v }))}
            options={buckets}
            placeholder="my-backups"
          />
        </label>
        <label className="grow">
          Folder
          <input
            value={pref.folder}
            onChange={(e) => setPref((p) => ({ ...p, folder: e.target.value }))}
            placeholder="balaudeck-backups/"
            spellCheck={false}
          />
        </label>
      </div>
      <label>
        Passphrase
        <input
          type="password"
          autoComplete="off"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          placeholder="encrypts the backup — needed again to restore"
        />
      </label>
      <div className="form-row end">
        <button onClick={push} disabled={!!busy}>
          {busy === "push" ? <Spinner size={13} /> : <Icon name="upload" size={13} />} Back up now
        </button>
      </div>

      <div className="s3b-list-head">
        <span>Backups in this folder</span>
        <button className="icon" title="Refresh" onClick={() => void listBackups()} disabled={!!busy || !pref.bucket.trim()}>
          {busy === "list" ? <Spinner size={12} /> : <Icon name="refresh" size={12} />}
        </button>
      </div>
      {backups === null ? (
        <p className="sync-hint">{pref.bucket.trim() ? "…" : "Pick a bucket to see its backups."}</p>
      ) : backups.length === 0 ? (
        <p className="sync-hint">No backups here yet.</p>
      ) : (
        <ul className="s3b-list">
          {backups.slice(0, 30).map((b) => (
            <li key={b.key}>
              <span className="s3b-name">{b.name.replace(/^balaudeck-connections-/, "").replace(EXT, "")}</span>
              <span className="s3b-meta">
                {b.modified ? new Date(b.modified).toLocaleString() : ""} · {fmtSize(b.size)}
              </span>
              <button className="ghost" onClick={() => restore(b)} disabled={!!busy}>
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="sync-ok">{msg}</p>}
    </div>
  );
}
