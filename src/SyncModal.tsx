import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { GdriveStatus, ImportSummary } from "./types";
import { Icon } from "./Icon";

const FILE_EXT = "balaudeck";

type Mode = "export" | "import" | "gdrive";

/**
 * Export / import all connection profiles + their secrets as one encrypted,
 * passphrase-protected text bundle. Move the text between Mac / iPhone / iPad
 * (AirDrop, Universal Clipboard, Files) to share the same connections — or sync
 * the same bundle through your own Google Drive (desktop, Google Drive tab).
 *
 * File save/open is shown only on desktop, where a real filesystem path is
 * writable; on iOS/Android the dialog returns a sandbox/SAF location that the
 * plain file write can't use, so mobile relies on copy + paste instead.
 */
export function SyncModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [mode, setMode] = useState<Mode>("export");
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  // Google Drive sync runs on desktop + iOS (not Android yet).
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .currentPlatform()
      .then((p) => {
        setIsDesktop(["macos", "windows", "linux"].includes(p));
        const supported = p !== "android";
        setGdriveSupported(supported);
        if (supported) api.gdriveStatus().then(setGd).catch(() => {});
      })
      .catch(() => setIsDesktop(false));
  }, []);

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
    ).then((u) => {
      un = u;
    });
    return () => un?.();
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
      if (path) await api.writeTextFile(path, bundle);
    } catch (e) {
      setError(`Save to file failed: ${e}. Use the Copy button instead.`);
    }
  }

  async function loadFile() {
    setError(null);
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "BalauDeck backup", extensions: [FILE_EXT, "txt"] }],
      });
      if (typeof path === "string") setImText(await api.readTextFile(path));
    } catch (e) {
      setError(`Open file failed: ${e}. Paste the text instead.`);
    }
  }

  async function doImport() {
    setError(null);
    setSummary(null);
    if (!imText.trim()) {
      setError("Paste the backup text or load it from a file first.");
      return;
    }
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
  }

  // ---- Google Drive ---------------------------------------------------------

  async function gdConnect() {
    setError(null);
    setGdMsg("Opening Google sign-in…");
    setBusy(true);
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

  async function gdDisconnect() {
    setError(null);
    setBusy(true);
    try {
      await api.gdriveDisconnect();
      await refreshGd();
      setGdMsg("Disconnected from Google Drive.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function gdPush() {
    setError(null);
    setGdMsg(null);
    const pass = gdPass.trim();
    if (pass.length < 6) {
      setError("Passphrase must be at least 6 characters.");
      return;
    }
    setBusy(true);
    try {
      await api.gdrivePush(pass);
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
    if (pass.length < 6) {
      setError("Enter the passphrase you used when pushing this backup.");
      return;
    }
    setBusy(true);
    try {
      const s = await api.gdrivePull(pass);
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

        <div className="seg">
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
                {busy ? "Generating…" : "Generate backup"}
              </button>
            </div>

            {bundle && (
              <>
                <textarea className="sync-blob" readOnly value={bundle} rows={6} />
                <div className="form-row end">
                  {isDesktop && (
                    <button className="ghost" onClick={saveBundle}>
                      <Icon name="save" size={14} /> Save to file…
                    </button>
                  )}
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
              {isDesktop && (
                <button className="ghost" onClick={loadFile}>
                  <Icon name="folder" size={14} /> Load from file…
                </button>
              )}
              <button onClick={doImport} disabled={busy}>
                {busy ? "Importing…" : "Import"}
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
              <Icon name="power" size={14} /> Disconnect
            </button>
          ) : (
            <button onClick={onConnect} disabled={busy}>
              <Icon name="refresh" size={14} /> Connect to Google Drive
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
              <Icon name="download" size={14} /> Pull from Drive
            </button>
            <button onClick={onPush} disabled={busy}>
              <Icon name="upload" size={14} /> Push to Drive
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
