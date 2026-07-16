import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { api } from "./api";
import { updaterEnabled } from "./updater";
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
  isDesktop,
}: {
  onClose: () => void;
  privacy: boolean;
  onPrivacyChange: (v: boolean) => void;
  /** Gates the desktop-only "Updates" section (self-updater builds only). */
  isDesktop: boolean;
}) {
  const [s, setS] = useState<Settings>(getSettings());
  // Shells actually installed here, for the Local terminal picker (desktop).
  const [shells, setShells] = useState<{ path: string; label: string }[]>([]);
  const update = (patch: Partial<Settings>) => {
    setSettings(patch);
    setS(getSettings());
  };

  useEffect(() => {
    if (isDesktop) api.listShells().then(setShells).catch(() => {});
  }, [isDesktop]);

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

        {/* Security -------------------------------------------------------- */}
        <div className="settings-label">Security</div>
        <div className="fontsize-row">
          <button
            className={"pill-toggle" + (s.appLock ? " on" : "")}
            onClick={() => update({ appLock: !s.appLock })}
          >
            Biometric app lock · {s.appLock ? "On" : "Off"}
          </button>
        </div>
        <p className="settings-hint">
          Require Face ID / fingerprint / device PIN to open the app on mobile. Off
          by default; desktop is unaffected. Takes effect on next launch.
        </p>

        {/* Local terminal (desktop only — mobile has no local shell) -------- */}
        {isDesktop && (
          <>
            <div className="settings-label">Local terminal</div>
            <select
              value={s.localShell}
              onChange={(e) => update({ localShell: e.target.value })}
              aria-label="Shell for new Local terminals"
            >
              <option value="">Auto (system default)</option>
              {shells.map((sh) => (
                <option key={sh.path} value={sh.path}>
                  {sh.label}
                </option>
              ))}
            </select>
            <p className="settings-hint">
              Which shell new Local terminals open. Auto uses your login shell
              ($SHELL) on macOS/Linux and PowerShell on Windows. Only shells
              found on this machine are listed; already-open terminals keep the
              shell they started with.
            </p>
          </>
        )}

        {/* Updates (desktop direct-download builds only) ------------------- */}
        {updaterEnabled && isDesktop && (
          <>
            <div className="settings-label">Updates</div>
            <div className="fontsize-row">
              <button
                className={"pill-toggle" + (s.autoUpdate ? " on" : "")}
                onClick={() => update({ autoUpdate: !s.autoUpdate })}
              >
                Check for updates on launch · {s.autoUpdate ? "On" : "Off"}
              </button>
            </div>
            <p className="settings-hint">
              On launch, quietly check GitHub for a newer release and show an
              “Update” button in the top bar. It never installs on its own — you
              choose when to download. You can always check manually in About.
            </p>
          </>
        )}

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
