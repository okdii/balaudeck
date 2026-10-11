import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Write text to the system clipboard. Goes through the Tauri clipboard plugin
 * first: navigator.clipboard is missing or rejects in the iOS WKWebView (and
 * needs a user gesture elsewhere), while the plugin works on every platform.
 * Falls back to the web API (e.g. plain-browser dev). Rejects if both fail.
 */
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch (e) {
    if (!navigator.clipboard?.writeText) throw e;
    await navigator.clipboard.writeText(text);
  }
}
