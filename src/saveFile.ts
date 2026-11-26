import { invoke } from "@tauri-apps/api/core";
import { save, type SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { api } from "./api";

/**
 * "Save as…" that works on iOS too.
 *
 * On desktop/Android `save()` returns a path we write to. iOS has no such panel:
 * the dialog plugin's `save` exports an EXISTING file from the app's Documents
 * folder to wherever the user picks, and the URL it returns is not writable
 * (writing there failed with "No such file or directory"). So on iOS we write
 * into Documents/<name> first, then open the export picker, then clean up.
 * See src-tauri/src/export.rs.
 */

let iosP: Promise<boolean> | null = null;
export function isIos(): Promise<boolean> {
  return (iosP ??= api
    .currentPlatform()
    .then((p) => p === "ios")
    .catch(() => false));
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || "file";

/** Present the iOS export picker for a file already written to `staged`. */
export async function exportStaged(staged: string, opts?: SaveDialogOptions): Promise<string | null> {
  try {
    return await save({ ...opts, defaultPath: baseName(staged) });
  } finally {
    void invoke("export_cleanup", { path: staged }).catch(() => {});
  }
}

/** iOS: Documents/<name> to write into before `exportStaged`. */
export function stagePath(name: string): Promise<string> {
  return invoke<string>("export_stage", { name: baseName(name) });
}

/** iOS: where folder downloads go (Files → On My iPhone/iPad → BalauDeck → Downloads). */
export function iosDownloadsDir(): Promise<string> {
  return invoke<string>("export_downloads_dir");
}

/**
 * Ask where to save, then let `write(path)` create the file. Resolves to the
 * chosen path/URL, or null when the user cancelled. On iOS the file is written
 * first and the picker appears once `write` has finished.
 */
export async function saveVia(
  opts: SaveDialogOptions & { defaultPath: string },
  write: (path: string) => Promise<unknown>,
): Promise<string | null> {
  if (!(await isIos())) {
    const p = await save(opts);
    if (!p) return null;
    await write(p);
    return p;
  }
  const staged = await stagePath(opts.defaultPath);
  try {
    await write(staged);
  } catch (e) {
    void invoke("export_cleanup", { path: staged }).catch(() => {});
    throw e;
  }
  return exportStaged(staged, opts);
}

/** Save text chosen by the user (plugin-fs on desktop, backend write on iOS). */
export async function saveText(opts: SaveDialogOptions & { defaultPath: string }, text: string) {
  const ios = await isIos();
  return saveVia(opts, (p) => (ios ? api.writeTextFile(p, text) : writeTextFile(p, text)));
}

/** Save bytes chosen by the user. */
export async function saveBytes(opts: SaveDialogOptions & { defaultPath: string }, bytes: Uint8Array) {
  const ios = await isIos();
  return saveVia(opts, (p) =>
    ios ? invoke("export_write", bytes, { headers: { "x-path": encodeURIComponent(p) } }) : writeFile(p, bytes),
  );
}

/**
 * Pick a local folder for a folder download. iOS can't write into a folder
 * picked in Files, so there it's always Documents/Downloads (shown in Files).
 */
export async function pickDownloadDir(): Promise<string | null> {
  if (await isIos()) return iosDownloadsDir();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dest = await open({ directory: true });
  return !dest || Array.isArray(dest) ? null : dest;
}
