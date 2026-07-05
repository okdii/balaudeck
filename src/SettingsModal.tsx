import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import {
  ACCENTS,
  PRIVACY_SECTIONS,
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
export function SettingsModal({
  onClose,
  privacy,
  onPrivacyChange,
}: {
  onClose: () => void;
  privacy: boolean;
  onPrivacyChange: (v: boolean) => void;
}) {
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
        <div className="seg solid" role="group" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={s.theme === t.id ? "on" : ""}
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

        {/* Privacy --------------------------------------------------------- */}
        <div className="settings-label">Privacy</div>
        <div className="fontsize-row">
          <button
            className={"pill-toggle" + (privacy ? " on" : "")}
            onClick={() => onPrivacyChange(!privacy)}
          >
            Blur sensitive info · {privacy ? "On" : "Off"}
          </button>
        </div>
        <p className="settings-hint">
          Blurs sensitive info for screen-sharing. Toggle with ⌘/Ctrl+⇧+. or the eye
          in the top bar; hover any blurred item to reveal it. Visual only — not
          encryption.
        </p>
        <div className="privacy-opts">
          {PRIVACY_SECTIONS.map((sec) => (
            <label key={sec.id} className="privacy-opt check-row" title={sec.hint}>
              <input
                type="checkbox"
                checked={s.privacy[sec.id]}
                onChange={() =>
                  update({ privacy: { ...s.privacy, [sec.id]: !s.privacy[sec.id] } })
                }
              />
              <span className="privacy-opt-label">{sec.label}</span>
              <span className="privacy-opt-hint">{sec.hint}</span>
            </label>
          ))}
        </div>
        <div className="settings-label">Blur text patterns</div>
        <textarea
          className="privacy-patterns"
          rows={2}
          spellCheck={false}
          placeholder="*.*.*.*"
          value={s.privacyPatterns.join("\n")}
          onChange={(e) => update({ privacyPatterns: e.target.value.split("\n") })}
        />
        <p className="settings-hint">
          One glob per line. <code>*</code> matches a word/number segment — e.g.{" "}
          <code>*.*.*.*</code> blurs IP addresses. Matches blur wherever they appear
          as a label, even in shown sections.
        </p>

        {/* Terminal -------------------------------------------------------- */}
        <div className="settings-label">
          Terminal font size <small>{auto ? `Auto · ${resolveFontSize(s)}px` : `${s.termFontSize}px`}</small>
        </div>
        <div className="fontsize-row">
          <button
            className={"pill-toggle" + (auto ? " on" : "")}
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
