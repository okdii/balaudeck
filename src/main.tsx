import ReactDOM from "react-dom/client";
import App from "./App";
import { LockGate } from "./LockGate";
// Applies the saved theme + accent onto <html> at module load, before first
// paint, so there's no light-mode flash when Dark is selected.
import "./settings";

// Suppress the WebView's native "Reload / Inspect Element" context menu so the
// app feels native. Editable fields keep their menu (cut/copy/paste).
document.addEventListener("contextmenu", (e) => {
  const target = e.target as HTMLElement | null;
  if (!target?.closest('input, textarea, [contenteditable="true"]')) {
    e.preventDefault();
  }
});

// No StrictMode: panes hold imperative terminal/PTY/SSH sessions, and the dev
// double-mount would spawn/teardown those resources twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <LockGate>
    <App />
  </LockGate>,
);
