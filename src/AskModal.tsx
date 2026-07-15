import { useState } from "react";
import { Spinner } from "./Icon";

export interface AskOptions {
  title: string;
  label?: string;
  /** When provided (even ""), a text input is shown and its value is returned. */
  initial?: string;
  confirmText?: string;
  danger?: boolean;
  /** Return false or an error message to keep the modal open (the typed value
   *  survives so it can be corrected); void/true closes as before. */
  run: (value: string) => void | boolean | string | Promise<void | boolean | string>;
}

/** In-app replacement for window.prompt/confirm (which are no-ops in the Tauri webview). */
export function AskModal({ ask, onClose }: { ask: AskOptions; onClose: () => void }) {
  const [v, setV] = useState(ask.initial ?? "");
  const [err, setErr] = useState("");
  const [pending, setPending] = useState(false);
  const hasInput = ask.initial !== undefined;
  const confirm = async () => {
    if (pending) return;
    setPending(true);
    try {
      const res = await ask.run(v);
      if (res === false || typeof res === "string") {
        setErr(typeof res === "string" && res ? res : "Invalid value.");
        return;
      }
      onClose();
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ask" onClick={(e) => e.stopPropagation()}>
        <h3>{ask.title}</h3>
        {ask.label && <p className="ask-label">{ask.label}</p>}
        {hasInput && (
          <input
            autoFocus
            value={v}
            onChange={(e) => {
              setV(e.target.value);
              setErr("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirm();
              if (e.key === "Escape") onClose();
            }}
          />
        )}
        {err && (
          <p className="ask-label error-text" style={{ color: "var(--err-text)" }}>
            {err}
          </p>
        )}
        <div className="form-row end">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className={ask.danger ? "danger-btn" : ""} onClick={confirm} disabled={pending}>
            {pending && <Spinner size={13} />} {ask.confirmText ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
