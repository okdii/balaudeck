import { useEffect, useState } from "react";
import { api } from "./api";
import { dismissTransfer, getTransfers, subscribeTransfers, type TransferItem } from "./transfers";
import { Icon } from "./Icon";
import { maskText } from "./privacy";
import { subscribeSettings } from "./settings";

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Right-hand cell: percentage when the total is known, transferred bytes
 *  while it isn't, and the outcome word once the transfer is over. */
function stat(t: TransferItem): string {
  if (t.state === "done") return "done";
  if (t.state === "error") return "failed";
  if (t.state === "cancelled") return "cancelled";
  return t.total ? `${Math.min(100, Math.floor((t.done / t.total) * 100))}%` : fmtSize(t.done);
}

/** Compact queue of background S3/SFTP transfers — renders nothing until a
 *  job-id transfer starts. Rows fold `transfer://progress` events (via the
 *  transfers store); ✕ cancels a running row (cooperative — the backend
 *  cleans up its partial output) and dismisses a finished one. */
export function TransferList() {
  const [, setRev] = useState(0);
  useEffect(() => subscribeTransfers(() => setRev((n) => n + 1)), []);
  // Names render through maskText, so re-render when privacy settings change.
  useEffect(() => subscribeSettings(() => setRev((n) => n + 1)), []);

  const transfers = getTransfers();
  if (transfers.length === 0) return null;

  return (
    <div className="transfer-list">
      {transfers.map((t) => {
        const running = t.state === "running";
        const pct = t.total ? Math.min(100, (t.done / t.total) * 100) : null;
        return (
          <div
            key={t.id}
            className={`transfer-item is-${t.state}`}
            title={t.error ?? undefined}
          >
            <span className="transfer-name">{maskText(t.name)}</span>
            {/* Unknown total while running → a sliding "indeterminate" segment. */}
            <span className={"transfer-bar" + (running && pct === null ? " indet" : "")}>
              <span
                style={{ width: pct !== null ? `${pct}%` : running ? "40%" : "100%" }}
              />
            </span>
            <span className="transfer-stat">{stat(t)}</span>
            <button
              className="icon"
              title={running ? "Cancel" : "Dismiss"}
              onClick={() =>
                running ? void api.transferCancel(t.id).catch(() => {}) : dismissTransfer(t.id)
              }
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
