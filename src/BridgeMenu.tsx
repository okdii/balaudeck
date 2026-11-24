// Flyout listing the open panes of the other kind that a file/folder can be
// streamed to (see bridge.ts). Fixed-positioned at the clicked button.

import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { maskText } from "./privacy";
import {
  s3Targets,
  sftpTargets,
  subscribeBridge,
  type BridgeTarget,
} from "./bridge";

export function BridgeMenu({
  kind,
  x,
  y,
  title,
  onPick,
  onClose,
}: {
  /** The kind of pane to send TO. */
  kind: "s3" | "sftp";
  x: number;
  y: number;
  title: string;
  onPick: (t: BridgeTarget) => void;
  onClose: () => void;
}) {
  const [, setRev] = useState(0);
  useEffect(() => subscribeBridge(() => setRev((n) => n + 1)), []);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);
  const list: BridgeTarget[] = kind === "s3" ? s3Targets() : sftpTargets();
  // Keep the menu on screen: right-aligned to the button, flipped up near the bottom.
  const flipUp = y > window.innerHeight - 220;
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={onClose} />
      <div
        className="bridge-menu"
        style={{
          left: Math.max(8, x),
          ...(flipUp ? { bottom: window.innerHeight - y + 32 } : { top: y }),
        }}
      >
        <div className="bridge-menu-title">{title}</div>
        {list.length === 0 ? (
          <div className="bridge-menu-empty">
            {kind === "s3"
              ? "Open an S3 connection in another pane and go to the bucket/folder to copy into."
              : "Open an SFTP connection in another pane and go to the folder to copy into."}
          </div>
        ) : (
          list.map((t) => (
            <button
              key={t.paneId}
              className="ghost"
              onClick={() => {
                onClose();
                onPick(t);
              }}
            >
              <Icon name={t.kind === "s3" ? "bucket" : "sftp"} size={13} />
              <span className="bridge-menu-label">{maskText(t.label)}</span>
              <span className="bridge-menu-path">
                {maskText(t.kind === "s3" ? `${t.bucket}/${t.prefix}` : t.dir)}
              </span>
            </button>
          ))
        )}
      </div>
    </>
  );
}
