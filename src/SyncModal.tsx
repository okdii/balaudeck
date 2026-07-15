import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { GdriveStatus, ImportSummary } from "./types";
import { Icon, Spinner } from "./Icon";
import { AskModal, type AskOptions } from "./AskModal";

const FILE_EXT = "balaudeck";

type Mode = "export" | "import" | "gdrive";

/**
 * Export / import all connection profiles + their secrets as one encrypted,
 * passphrase-protected text bundle. Move the text between Mac / iPhone / iPad
 * (AirDrop, Universal Clipboard, Files) to share the same connections — or sync
 * the same bundle through your own Google Drive (all platforms, Google Drive tab).
 *
 * Save/open to a file works on every platform via tauri-plugin-fs, which
 * handles the Android SAF content:// URI and the iOS security-scoped URL the
 * pickers return (a plain std::fs write can't). Copy/paste stays as a fallback.
 */
export function SyncModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [mode, setMode] = useState<Mode>("export");
  // Google Drive sync runs on every platform (desktop loopback OAuth, mobile
  // deep-link OAuth). The tab body surfaces the not-configured / not-connected
  // states, so we can show it unconditionally.
  const [gdriveSupported, setGdriveSupported] = useState(false);

  // Export
  const [exPass, setExPass] = useState("");
  const [exPass2, setExPass2] = useState("");
  const [bundle, setBundle] = useState("");
  const [copied, setCopied] = useState(false);

  // Import
  const [imPass, setImPass] = useState("");
  const [imText, setImText] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  // Google Drive
  const [gd, setGd] = useState<GdriveStatus | null>(null);
  const [gdPass, setGdPass] = useState("");
  const [gdMsg, setGdMsg] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState<"save" | "load" | null>(null);
  const [gdBusy, setGdBusy] = useState<"connect" | "disconnect" | "push" | "pull" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskOptions | null>(null);

  useEffect(() => {
    // Available on all platforms; the backend `configured` flag + the tab body
    // handle whether a build actually has an OAuth client and is connected.
    setGdriveSupported(true);
    api.gdriveStatus().then(setGd).catch(() => {});
  }, []);

  // Clear the per-action Drive spinner whenever the shared busy flag drops, so
  // each handler only has to SET it (not reset it in every finally).
  useEffect(() => {
    if (!busy) setGdBusy(null);
  }, [busy]);

  // On iOS the OAuth redirect returns asynchronously via the deep-link handler,
  // which emits `gdrive://auth` when the exchange finishes. Refresh the status
  // (and surface any error) when it fires. Harmless on desktop.
  useEffect(() => {
    let un: (() => void) | undefined;
    listen<{ connected: boolean; email: string | null; error: string | null }>(
      "gdrive://auth",
      (e) => {
        if (e.payload.error) setError(e.payload.error);
        else if (e.payload.connected) setGdMsg("Connected to Google Drive.");
        refreshGd();
      },
    )
      .then((u) => {
        un = u;
        // The backend can emit before this listener finishes registering (fast
        // iOS redirect); re-read status so a missed event can't strand the UI.
        refreshGd();
      })
      .catch((err) => setError(`Couldn't listen for the sign-in result: ${err}`));

    // Returning to the app (from Safari on iOS, or the OAuth browser on desktop)
    // re-focuses it — the most reliable "sign-in may have finished" cue; re-poll.
    const onRefocus = () => refreshGd();
    window.addEventListener("focus", onRefocus);
    document.addEventListener("visibilitychange", onRefocus);
    return () => {
      un?.();
      window.removeEventListener("focus", onRefocus);
      document.removeEventListener("visibilitychange", onRefocus);
    };
  }, []);

  async function refreshGd() {
    try {
      setGd(await api.gdriveStatus());
    } catch {
      /* leave prior status */
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    setError(null);
    setCopied(false);
    setBundle("");
    setSummary(null);
    setGdMsg(null);
  }

  async function doExport() {
    setError(null);
    const pass = exPass.trim();
    if (pass.length < 6) {
      setError("Passphrase must be at least 6 characters.");
      return;
    }
    if (pass !== exPass2.trim()) {
      setError("Passphrases do not match.");
      return;
    }
    setBusy(true);
    try {
      setBundle(await api.connectionsExport(pass));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyBundle() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(bundle);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy automatically — select the text above and copy it manually.");
    }
  }

  async function saveBundle() {
    setError(null);
    try {
      const path = await save({
        defaultPath: `balaudeck-connections.${FILE_EXT}`,
        filters: [{ name: "BalauDeck backup", extensions: [FILE_EXT] }],
      });
      // plugin-fs writes the picked target — on Android a SAF content:// URI,
      // on iOS a security-scoped URL — which a plain std::fs write can't handle.
      if (path) {
        setFileBusy("save");
        await writeTextFile(path, bundle);
      }
    } catch (e) {
      setError(`Save to file failed: ${e}. Use the Copy button instead.`);
    } finally {
      setFileBusy(null);
    }
  }

  async function loadFile() {
    setError(null);
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "BalauDeck backup", extensions: [FILE_EXT, "txt"] }],
      });
      if (typeof path === "string") {
        setFileBusy("load");
        setImText(await readTextFile(path));
      }
    } catch (e) {
      setError(`Open file failed: ${e}. Paste the text instead.`);
    } finally {
      setFileBusy(null);
    }
  }

  function doImport() {
    setError(null);
    setSummary(null);
    if (!imText.trim()) {
      setError("Paste the backup text or load it from a file first.");
      return;
    }
    setAsk({
      title: "Import connections",
      label:
        "This merges the backup into your connections — profiles with the same name are overwritten. Continue?",
      confirmText: "Import",
      run: async () => {
        setBusy(true);
        try {
          const s = await api.connectionsImport(imPass, imText.trim());
          setSummary(s);
          onImported();
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      },
    });
  }

  // ---- Google Drive ---------------------------------------------------------

  async function gdConnect() {
    setError(null);
    setGdMsg("Opening Google sign-in…");
    setBusy(true);
    setGdBusy("connect");
    try {
      // Desktop returns already-connected; iOS opens Safari and returns not-yet-
      // connected, completing via the gdrive://auth event when the user returns.
      const s = await api.gdriveConnect();
      setGd(s);
      setGdMsg(
        s.connected
          ? "Connected. Set a passphrase and push to upload your first backup."
          : "Finish signing in in your browser, then return to the app.",
      );
    } catch (e) {
      setGdMsg(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function gdDisconnect() {
    setAsk({
      title: "Disconnect Google Drive",
      label:
        "This removes the link to your Google Drive. Your backup file stays there and you can reconnect any time.",
      confirmText: "Disconnect",
      danger: true,
      run: async () => {
        setError(null);
        setBusy(true);
        setGdBusy("disconnect");
        try {
          await api.gdriveDisconnect();
          await refreshGd();
          setGdMsg("Disconnected from Google Drive.");
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function gdPush() {
    setError(null);
    setGdMsg(null);
    const pass = gdPass.trim();
    // A blank field reuses the cached passphrase (the field is kept empty once
    // one is cached); only validate a freshly typed one. Without a cache, a
    // passphrase is required to create the first backup.
    if (pass ? pass.length < 6 : !gd?.has_passphrase) {
      setError("Passphrase must be at least 6 characters.");
      return;
    }
    setBusy(true);
    setGdBusy("push");
    try {
      await api.gdrivePush(pass);
      setGdPass("");
      await refreshGd();
      setGdMsg("Backup uploaded to Google Drive.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function gdPull() {
    setError(null);
    setGdMsg(null);
    const pass = gdPass.trim();
    // Blank field reuses the cached passphrase (set on the first push/pull).
    if (pass ? pass.length < 6 : !gd?.has_passphrase) {
      setError("Enter the passphrase you used when pushing this backup.");
      return;
    }
    setAsk({
      title: "Pull from Google Drive",
      label:
        "This merges your Google Drive backup into local connections — same-name profiles are overwritten. Continue?",
      confirmText: "Pull",
      run: async () => {
        setBusy(true);
        setGdBusy("pull");
        try {
          const s = await api.gdrivePull(pass);
          setGdPass("");
          onImported();
          await refreshGd();
          setGdMsg(
            `Pulled from Google Drive: ${s.ssh} SSH · ${s.db} DB · ${s.sftp} SFTP · ` +
              `${s.tunnel} tunnel · ${s.folders} folders · ${s.queries} queries · ` +
              `${s.notes} notes · ${s.secrets} secrets.`,
          );
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function gdToggleAuto() {
    if (!gd) return;
    setError(null);
    try {
      await api.gdriveSetAutoSync(!gd.auto_sync);
      await refreshGd();
    } catch (e) {
      setError(String(e));
    }
  }

  // Esc closes; Enter submits the active mode (but not while typing in a textarea).
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "Enter" && !busy) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "TEXTAREA") return;
      e.preventDefault();
      if (mode === "export") doExport();
      else if (mode === "import") doImport();
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sync-modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h3>Sync connections</h3>
        <p className="sync-hint">
          Encrypted backup of all your connections + passwords. Move it (AirDrop
          / Universal Clipboard / Files) to another device and import it there,
          or sync it through your own Google Drive.
        </p>

        <div className="seg solid">
          <button className={mode === "export" ? "on" : ""} onClick={() => switchMode("export")}>
            <Icon name="download" size={14} /> Export
          </button>
          <button className={mode === "import" ? "on" : ""} onClick={() => switchMode("import")}>
            <Icon name="upload" size={14} /> Import
          </button>
          {gdriveSupported && (
            <button className={mode === "gdrive" ? "on" : ""} onClick={() => switchMode("gdrive")}>
              <Icon name="refresh" size={14} /> Google Drive
            </button>
          )}
        </div>

        {mode === "export" ? (
          <div className="sync-body">
            <label>
              Passphrase
              <input
                type="password"
                autoComplete="new-password"
                value={exPass}
                onChange={(e) => setExPass(e.target.value)}
                placeholder="protect this backup"
              />
            </label>
            <label>
              Confirm passphrase
              <input
                type="password"
                autoComplete="new-password"
                value={exPass2}
                onChange={(e) => setExPass2(e.target.value)}
              />
            </label>
            <div className="form-row end">
              <button onClick={doExport} disabled={busy}>
                {busy ? (
                  <>
                    <Spinner size={13} /> Generating…
                  </>
                ) : (
                  "Generate backup"
                )}
              </button>
            </div>

            {bundle && (
              <>
                <textarea className="sync-blob" readOnly value={bundle} rows={6} />
                <div className="form-row end">
                  <button className="ghost" onClick={saveBundle} disabled={fileBusy !== null}>
                    {fileBusy === "save" ? <Spinner size={14} /> : <Icon name="save" size={14} />}{" "}
                    {fileBusy === "save" ? "Saving…" : "Save to file…"}
                  </button>
                  <button onClick={copyBundle}>
                    <Icon name="copy" size={14} /> {copied ? "Copied!" : "Copy"}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : mode === "import" ? (
          <div className="sync-body">
            <label>
              Passphrase
              <input
                type="password"
                autoComplete="off"
                value={imPass}
                onChange={(e) => setImPass(e.target.value)}
                placeholder="the same passphrase used at export"
              />
            </label>
            <label>
              Backup text
              <textarea
                className="sync-blob"
                value={imText}
                onChange={(e) => setImText(e.target.value)}
                rows={6}
                placeholder="paste backup text here…"
              />
            </label>
            <div className="form-row end">
              <button className="ghost" onClick={loadFile} disabled={fileBusy !== null}>
                {fileBusy === "load" ? <Spinner size={14} /> : <Icon name="folder" size={14} />}{" "}
                {fileBusy === "load" ? "Loading…" : "Load from file…"}
              </button>
              <button onClick={doImport} disabled={busy}>
                {busy ? (
                  <>
                    <Spinner size={13} /> Importing…
                  </>
                ) : (
                  "Import"
                )}
              </button>
            </div>

            {summary && (
              <p className="sync-ok">
                Imported: {summary.ssh} SSH · {summary.db} DB · {summary.sftp}{" "}
                SFTP · {summary.tunnel} tunnel · {summary.folders} folders ·{" "}
                {summary.queries} queries · {summary.notes} notes ·{" "}
                {summary.secrets} secrets.
              </p>
            )}
          </div>
        ) : (
          <div className="sync-body">
            {gd && !gd.configured ? (
              <p className="sync-hint">
                No Google OAuth client configured, so Google Drive sync is
                disabled. Add a <code>gdrive_client.json</code> (with your Google
                “Desktop app” <code>client_id</code> + <code>client_secret</code>)
                to the app data dir, or set the{" "}
                <code>BALAUDECK_GOOGLE_CLIENT_ID/SECRET</code> env vars — see{" "}
                <code>src-tauri/src/gdrive.rs</code>.
              </p>
            ) : (
              <GdriveBody
                gd={gd}
                gdPass={gdPass}
                setGdPass={setGdPass}
                busy={busy}
                gdBusy={gdBusy}
                onConnect={gdConnect}
                onDisconnect={gdDisconnect}
                onPush={gdPush}
                onPull={gdPull}
                onToggleAuto={gdToggleAuto}
              />
            )}
            {gdMsg && <p className="sync-ok">{gdMsg}</p>}
          </div>
        )}

        {error && <p className="sync-err">{error}</p>}

        <div className="form-row end">
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {ask && <AskModal ask={ask} onClose={() => setAsk(null)} />}
      </div>
    </div>
  );
}

function fmtTime(ms: number): string {
  if (!ms) return "never";
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "unknown";
  }
}

function GdriveBody({
  gd,
  gdPass,
  setGdPass,
  busy,
  gdBusy,
  onConnect,
  onDisconnect,
  onPush,
  onPull,
  onToggleAuto,
}: {
  gd: GdriveStatus | null;
  gdPass: string;
  setGdPass: (v: string) => void;
  busy: boolean;
  gdBusy: "connect" | "disconnect" | "push" | "pull" | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onPush: () => void;
  onPull: () => void;
  onToggleAuto: () => void;
}) {
  const connected = !!gd?.connected;

  return (
    <>
      <div className="gd-status">
        <span className={`gd-dot ${connected ? "on" : ""}`} />
        {connected ? (
          <span>
            Connected{gd?.email ? ` as ${gd.email}` : ""}
          </span>
        ) : (
          <span>Not connected</span>
        )}
        <div className="gd-status-actions">
          {connected ? (
            <button className="ghost" onClick={onDisconnect} disabled={busy}>
              {gdBusy === "disconnect" ? <Spinner size={14} /> : <Icon name="power" size={14} />} Disconnect
            </button>
          ) : (
            <button onClick={onConnect} disabled={busy}>
              {gdBusy === "connect" ? <Spinner size={14} /> : <Icon name="refresh" size={14} />}{" "}
              {gdBusy === "connect" ? "Connecting…" : "Connect to Google Drive"}
            </button>
          )}
        </div>
      </div>

      {connected && (
        <>
          <label>
            Sync passphrase
            <input
              type="password"
              autoComplete="off"
              value={gdPass}
              onChange={(e) => setGdPass(e.target.value)}
              placeholder={
                gd?.has_passphrase ? "cached — re-enter only to change it" : "protect the Drive backup"
              }
            />
          </label>

          <div className="form-row end">
            <button className="ghost" onClick={onPull} disabled={busy}>
              {gdBusy === "pull" ? <Spinner size={14} /> : <Icon name="download" size={14} />}{" "}
              {gdBusy === "pull" ? "Pulling…" : "Pull from Drive"}
            </button>
            <button onClick={onPush} disabled={busy}>
              {gdBusy === "push" ? <Spinner size={14} /> : <Icon name="upload" size={14} />}{" "}
              {gdBusy === "push" ? "Pushing…" : "Push to Drive"}
            </button>
          </div>

          <label className="gd-auto">
            <input type="checkbox" checked={!!gd?.auto_sync} onChange={onToggleAuto} />
            <span>
              Auto-sync — push shortly after edits, pull on launch. Uses the
              cached passphrase; do one manual push/pull first to cache it.
            </span>
          </label>

          <p className="gd-times">
            Last push: {fmtTime(gd?.last_push_ms ?? 0)} · Last pull:{" "}
            {fmtTime(gd?.last_pull_ms ?? 0)}
          </p>
        </>
      )}
    </>
  );
}
