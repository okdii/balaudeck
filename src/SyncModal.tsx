import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import type { ImportSummary } from "./types";
import { Icon } from "./Icon";

const FILE_EXT = "balaudeck";

/**
 * Export / import all connection profiles + their secrets as one encrypted,
 * passphrase-protected text bundle. Move the text between Mac / iPhone / iPad
 * (AirDrop, Universal Clipboard, Files) to share the same connections.
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
  const [mode, setMode] = useState<"export" | "import">("export");
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);

  // Export
  const [exPass, setExPass] = useState("");
  const [exPass2, setExPass2] = useState("");
  const [bundle, setBundle] = useState("");
  const [copied, setCopied] = useState(false);

  // Import
  const [imPass, setImPass] = useState("");
  const [imText, setImText] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .currentPlatform()
      .then((p) => setIsDesktop(["macos", "windows", "linux"].includes(p)))
      .catch(() => setIsDesktop(false));
  }, []);

  function switchMode(m: "export" | "import") {
    setMode(m);
    setError(null);
    setCopied(false);
    setBundle("");
    setSummary(null);
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
      else doImport();
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sync-modal" onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <h3>Sync connections</h3>
        <p className="sync-hint">
          Encrypted backup of all your connections + passwords. Move it (AirDrop
          / Universal Clipboard / Files) to another Mac, iPhone, or iPad and
          import it there.
        </p>

        <div className="seg">
          <button
            className={mode === "export" ? "on" : ""}
            onClick={() => switchMode("export")}
          >
            <Icon name="download" size={14} /> Export
          </button>
          <button
            className={mode === "import" ? "on" : ""}
            onClick={() => switchMode("import")}
          >
            <Icon name="upload" size={14} /> Import
          </button>
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
        ) : (
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
