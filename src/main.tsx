import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LockGate } from "./LockGate";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LockGate>
      <App />
    </LockGate>
  </React.StrictMode>,
);
