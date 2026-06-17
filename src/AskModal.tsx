import { useState } from "react";

export interface AskOptions {
  title: string;
  label?: string;
  /** When provided (even ""), a text input is shown and its value is returned. */
  initial?: string;
  confirmText?: string;
  danger?: boolean;
  run: (value: string) => void;
}

/** In-app replacement for window.prompt/confirm (which are no-ops in the Tauri webview). */
export function AskModal({ ask, onClose }: { ask: AskOptions; onClose: () => void }) {
  const [v, setV] = useState(ask.initial ?? "");
  const hasInput = ask.initial !== undefined;
  const confirm = () => {
    ask.run(v);
    onClose();
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
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirm();
              if (e.key === "Escape") onClose();
            }}
          />
        )}
        <div className="form-row end">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className={ask.danger ? "danger-btn" : ""} onClick={confirm}>
            {ask.confirmText ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
