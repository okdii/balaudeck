import ReactDOM from "react-dom/client";
import App from "./App";
import { LockGate } from "./LockGate";

// No StrictMode: panes hold imperative terminal/PTY/SSH sessions, and the dev
// double-mount would spawn/teardown those resources twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <LockGate>
    <App />
  </LockGate>,
);
