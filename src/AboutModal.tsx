import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import licenseText from "../LICENSE?raw";
import { Icon } from "./Icon";

const LINKS = [
  { label: "App Store", href: "https://apps.apple.com/my/app/balaudeck/id6782116564" },
  { label: "Google Play", href: "https://play.google.com/store/apps/details?id=com.okdii.balaudeck" },
  { label: "GitHub", href: "https://github.com/okdii/balaudeck" },
];

/** In-app About dialog: app identity, version (from the Tauri config), and the
 *  MIT license text (imported straight from the repo LICENSE — one source). */
export function AboutModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-head">
          <svg className="about-logo" width="46" height="46" viewBox="0 0 24 24" aria-hidden="true">
            <rect width="24" height="24" rx="6" fill="#20242a" />
            <path
              d="M7 8 L12 12 L7 16"
              fill="none"
              stroke="#5fbf57"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <rect x="13" y="13.4" width="5.6" height="2.4" rx="1.2" fill="#4ba4e3" />
          </svg>
          <div className="about-id">
            <div className="about-name">BalauDeck</div>
            <div className="about-version">{version ? `Version ${version}` : " "}</div>
          </div>
          <button className="icon about-close" title="Close" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <p className="about-tagline">
          All-in-one SSH · SFTP · Tunnel · MySQL/MariaDB client. Built with Tauri 2.
        </p>

        <div className="about-links">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              onClick={(e) => {
                e.preventDefault();
                openUrl(l.href).catch(() => {});
              }}
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="about-license-label">License — MIT</div>
        <pre className="about-license">{licenseText}</pre>

        <div className="form-row end">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
