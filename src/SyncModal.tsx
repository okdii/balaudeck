import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import type { ImportSummary } from "./types";
import { Icon } from "./Icon";

const FILE_EXT = "balaudeck";

/**
 * Export / import all connection profiles + their secrets as one encrypted,
 * passphrase-protected text bundle. Move the text between Mac / iPhone / iPad
 * (AirDrop, Universal Clipboard, Files) to share the same connections.
 */
export function SyncModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [mode, setMode] = useState<"export" | "import">("export");

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

  async function doExport() {
    setError(null);
    if (exPass.length < 6) {
      setError("Passphrase sekurang-kurangnya 6 aksara.");
      return;
    }
    if (exPass !== exPass2) {
      setError("Passphrase tidak sepadan.");
      return;
    }
    setBusy(true);
    try {
      setBundle(await api.connectionsExport(exPass));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyBundle() {
    try {
      await navigator.clipboard.writeText(bundle);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Tak boleh salin — pilih teks dan salin manual.");
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
      setError(`Simpan fail gagal: ${e}. Guna butang Salin sebagai ganti.`);
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
      setError(`Buka fail gagal: ${e}. Tampal teks sebagai ganti.`);
    }
  }

  async function doImport() {
    setError(null);
    setSummary(null);
    if (!imText.trim()) {
      setError("Tampal teks backup atau muat dari fail dulu.");
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sync-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Sync connections</h3>
        <p className="sync-hint">
          Backup terenkripsi semua sambungan + password. Pindahkannya (AirDrop /
          Universal Clipboard / Files) ke Mac, iPhone, atau iPad lain dan import
          di sana.
        </p>

        <div className="seg">
          <button
            className={mode === "export" ? "on" : ""}
            onClick={() => {
              setMode("export");
              setError(null);
            }}
          >
            <Icon name="download" size={14} /> Export
          </button>
          <button
            className={mode === "import" ? "on" : ""}
            onClick={() => {
              setMode("import");
              setError(null);
            }}
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
                placeholder="lindungi backup ini"
              />
            </label>
            <label>
              Sahkan passphrase
              <input
                type="password"
                autoComplete="new-password"
                value={exPass2}
                onChange={(e) => setExPass2(e.target.value)}
              />
            </label>
            <div className="form-row end">
              <button onClick={doExport} disabled={busy}>
                {busy ? "Menjana…" : "Jana backup"}
              </button>
            </div>

            {bundle && (
              <>
                <textarea className="sync-blob" readOnly value={bundle} rows={6} />
                <div className="form-row end">
                  <button className="ghost" onClick={saveBundle}>
                    <Icon name="save" size={14} /> Simpan fail…
                  </button>
                  <button onClick={copyBundle}>
                    <Icon name="copy" size={14} /> {copied ? "Disalin!" : "Salin"}
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
                placeholder="passphrase yang sama semasa export"
              />
            </label>
            <label>
              Teks backup
              <textarea
                className="sync-blob"
                value={imText}
                onChange={(e) => setImText(e.target.value)}
                rows={6}
                placeholder="tampal teks backup di sini…"
              />
            </label>
            <div className="form-row end">
              <button className="ghost" onClick={loadFile}>
                <Icon name="folder" size={14} /> Muat dari fail…
              </button>
              <button onClick={doImport} disabled={busy}>
                {busy ? "Mengimport…" : "Import"}
              </button>
            </div>

            {summary && (
              <p className="sync-ok">
                Import berjaya: {summary.ssh} SSH · {summary.db} DB · {summary.sftp}{" "}
                SFTP · {summary.tunnel} tunnel · {summary.folders} folder ·{" "}
                {summary.queries} query · {summary.secrets} secret.
              </p>
            )}
          </div>
        )}

        {error && <p className="sync-err">{error}</p>}

        <div className="form-row end">
          <button className="ghost" onClick={onClose}>
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
