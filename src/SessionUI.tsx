import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export interface Preset {
  id: string;
  label: string;
}

/** Centered connection launcher: pick a saved preset or expand a manual form. */
export function ConnectLauncher({
  icon,
  title,
  presets,
  presetLabel = "Choose a saved host…",
  selectedId,
  onSelect,
  onConnect,
  connecting,
  manualOpen,
  onToggleManual,
  error,
  overlay,
  children,
}: {
  icon: IconName;
  title: string;
  presets: Preset[];
  presetLabel?: string;
  selectedId: string;
  onSelect: (id: string) => void;
  onConnect: () => void;
  connecting: boolean;
  manualOpen: boolean;
  onToggleManual: () => void;
  error?: string;
  overlay?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={"launcher" + (overlay ? " over-terminal" : "")}>
      <div className="launcher-card">
        <div className="launcher-head">
          <Icon name={icon} size={22} />
          <h3>{title}</h3>
        </div>

        {presets.length > 0 && (
          <div className="launcher-presets">
            <select value={selectedId} onChange={(e) => onSelect(e.target.value)}>
              <option value="">{presetLabel}</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <button onClick={onConnect} disabled={!selectedId || connecting}>
              <Icon name="play" size={14} /> {connecting ? "Connecting…" : "Connect"}
            </button>
          </div>
        )}

        <button className="launcher-toggle" onClick={onToggleManual}>
          <Icon name={manualOpen ? "chevronDown" : "chevronRight"} size={14} />
          Manual connection
        </button>

        {manualOpen && <div className="launcher-manual">{children}</div>}

        {error && <pre className="error">{error}</pre>}
      </div>
    </div>
  );
}

/** Slim bar shown while a session is connected: status + disconnect. */
export function SessionBar({ label, onDisconnect }: { label: string; onDisconnect: () => void }) {
  return (
    <div className="session-bar">
      <span className="status">
        <span className="dot ok" />
        <span className="session-host">{label}</span>
      </span>
      <button className="btn-disconnect" onClick={onDisconnect}>
        <Icon name="power" size={14} /> Disconnect
      </button>
    </div>
  );
}
