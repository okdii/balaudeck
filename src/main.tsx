import ReactDOM from "react-dom/client";
import App from "./App";
import { LockGate } from "./LockGate";
import { IdleLock } from "./IdleLock";
// Applies the saved theme + accent onto <html> at module load, before first
// paint, so there's no light-mode flash when Dark is selected.
import "./settings";

// Suppress the WebView's native "Reload / Inspect Element" context menu so the
// app feels native. Editable fields keep their menu (cut/copy/paste). On touch
// screens a long-press fires contextmenu too, and on Android cancelling it also
// cancels the native text selection — so read-only text meant to be copied (the
// terminal Copy view, code/pre blocks) keeps it there as well.
const touchUi = window.matchMedia("(hover: none) and (pointer: coarse)");
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  const keep = touchUi.matches
    ? 'input, textarea, [contenteditable="true"], .term-copy-text, pre, code'
    : 'input, textarea, [contenteditable="true"]';
  if (!target?.closest(keep)) {
    e.preventDefault();
  }
});

// A file dropped anywhere that isn't an upload drop zone (SFTP/S3 panels)
// would make the WebView navigate to it, replacing the whole app. Swallow
// those; drop zones handle (and stop) their own drops first. In-app drags
// (tabs, panes) don't carry "Files" and are untouched.
const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  // Not over a drop zone (it would have handled it already): show "no drop".
  if (!e.defaultPrevented && e.dataTransfer) e.dataTransfer.dropEffect = "none";
  e.preventDefault();
});
window.addEventListener("drop", (e) => {
  if (hasFiles(e)) e.preventDefault();
});

// No StrictMode: panes hold imperative terminal/PTY/SSH sessions, and the dev
// double-mount would spawn/teardown those resources twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <LockGate>
    <IdleLock>
      <App />
    </IdleLock>
  </LockGate>,
);
