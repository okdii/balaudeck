import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import {
  ACCENTS,
  TERM_SCHEMES,
  getSettings,
  resolveFontSize,
  setSettings,
  type Accent,
  type Settings,
  type TermScheme,
  type ThemeMode,
} from "./settings";

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** In-app Settings: appearance (theme + accent) and terminal look (font size +
 *  colour scheme). Every change is applied live and persisted per device. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings>(getSettings());
  const update = (patch: Partial<Settings>) => {
    setSettings(patch);
    setS(getSettings());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const auto = !(s.termFontSize >= 10 && s.termFontSize <= 20);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <h3>Settings</h3>
          <button className="icon settings-close" title="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        {/* Appearance ------------------------------------------------------ */}
        <div className="settings-label">Theme</div>
        <div className="seg" role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={"seg-btn" + (s.theme === t.id ? " active" : "")}
              onClick={() => update({ theme: t.id })}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-label">Accent</div>
        <div className="swatch-row" role="group" aria-label="Accent colour">
          {ACCENTS.map((a: { id: Accent; label: string; swatch: string }) => (
            <button
              key={a.id}
              className={"swatch" + (s.accent === a.id ? " active" : "")}
              title={a.label}
              aria-label={a.label}
              style={{ background: a.swatch }}
              onClick={() => update({ accent: a.id })}
            />
          ))}
        </div>

        {/* Terminal -------------------------------------------------------- */}
        <div className="settings-label">
          Terminal font size <small>{auto ? `Auto · ${resolveFontSize(s)}px` : `${s.termFontSize}px`}</small>
        </div>
        <div className="fontsize-row">
          <button
            className={"seg-btn wide" + (auto ? " active" : "")}
            onClick={() => update({ termFontSize: 0 })}
          >
            Auto
          </button>
          <input
            type="range"
            min={10}
            max={20}
            step={1}
            value={auto ? resolveFontSize(s) : s.termFontSize}
            onChange={(e) => update({ termFontSize: Number(e.target.value) })}
          />
        </div>

        <div className="settings-label">Terminal colour scheme</div>
        <div className="scheme-grid" role="group" aria-label="Terminal colour scheme">
          {TERM_SCHEMES.map((sc: { id: TermScheme; label: string; theme: Record<string, string> }) => (
            <button
              key={sc.id}
              className={"scheme-card" + (s.termScheme === sc.id ? " active" : "")}
              onClick={() => update({ termScheme: sc.id })}
            >
              <span
                className="scheme-preview"
                style={{ background: sc.theme.background }}
              >
                {["green", "yellow", "blue", "magenta", "cyan"].map((k) => (
                  <i key={k} style={{ background: sc.theme[k] }} />
                ))}
              </span>
              <span className="scheme-name">{sc.label}</span>
            </button>
          ))}
        </div>

        <div className="form-row end">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
