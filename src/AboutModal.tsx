import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import licenseText from "../LICENSE?raw";
import { Icon } from "./Icon";
import { api } from "./api";
import { check, relaunch, updaterEnabled, DESKTOP_PLATFORMS, type Update } from "./updater";

/** Self-update flow state for the About dialog. */
type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; received: number; total: number }
  | { kind: "installing" }
  | { kind: "error"; message: string };

const LINKS = [
  { label: "App Store", href: "https://apps.apple.com/my/app/balaudeck/id6782116564" },
  { label: "Google Play", href: "https://play.google.com/store/apps/details?id=com.okdii.balaudeck" },
  { label: "GitHub", href: "https://github.com/okdii/balaudeck" },
  { label: "♥ Sponsor", href: "https://github.com/sponsors/okdii", sponsor: true },
];

/** In-app About dialog: app identity, version (from the Tauri config), and the
 *  MIT license text (imported straight from the repo LICENSE — one source). */
export function AboutModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [upd, setUpd] = useState<UpdatePhase>({ kind: "idle" });
  const pending = useRef<Update | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
    // The self-updater only applies to desktop direct-download builds.
    if (updaterEnabled) {
      api.currentPlatform().then((p) => setIsDesktop(DESKTOP_PLATFORMS.includes(p))).catch(() => {});
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const showUpdater = updaterEnabled && isDesktop;

  async function checkForUpdate() {
    setUpd({ kind: "checking" });
    try {
      const update = await check();
      if (update) {
        pending.current = update;
        setUpd({ kind: "available", version: update.version, notes: update.body ?? "" });
      } else {
        setUpd({ kind: "none" });
      }
    } catch (e) {
      setUpd({ kind: "error", message: String(e) });
    }
  }

  async function installUpdate() {
    const update = pending.current;
    if (!update) return;
    let total = 0;
    let received = 0;
    setUpd({ kind: "downloading", received: 0, total: 0 });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
          setUpd({ kind: "downloading", received: 0, total });
        } else if (ev.event === "Progress") {
          received += ev.data.chunkLength;
          setUpd({ kind: "downloading", received, total });
        } else if (ev.event === "Finished") {
          setUpd({ kind: "installing" });
        }
      });
      // The new version is staged; relaunch into it.
      await relaunch();
    } catch (e) {
      setUpd({ kind: "error", message: String(e) });
    }
  }

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
            <div className="about-version">
              {version ? `Version ${version}` : " "}
              <span className="about-build"> · build {__BUILD_HASH__}</span>
            </div>
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
              className={"sponsor" in l && l.sponsor ? "about-sponsor" : undefined}
              onClick={(e) => {
                e.preventDefault();
                openUrl(l.href).catch(() => {});
              }}
            >
              {l.label}
            </a>
          ))}
        </div>

        {showUpdater && (
          <div className="about-update">
            {(upd.kind === "idle" || upd.kind === "none" || upd.kind === "error") && (
              <button className="ghost sm" onClick={checkForUpdate}>
                <Icon name="refresh" size={13} /> Check for updates
              </button>
            )}
            {upd.kind === "checking" && <span className="about-update-note">Checking…</span>}
            {upd.kind === "none" && <span className="about-update-note ok">You're up to date.</span>}
            {upd.kind === "error" && <span className="about-update-note err">{upd.message}</span>}
            {upd.kind === "available" && (
              <div className="about-update-avail">
                <span className="about-update-note">
                  Version {upd.version} is available.
                </span>
                <button className="sm" onClick={installUpdate}>
                  <Icon name="download" size={13} /> Download &amp; install
                </button>
              </div>
            )}
            {upd.kind === "downloading" && (
              <div className="about-update-prog">
                <div className="pbar">
                  <div
                    className="pfill"
                    style={{ width: `${upd.total ? Math.min(100, (upd.received / upd.total) * 100) : 5}%` }}
                  />
                </div>
                <span className="about-update-note">
                  Downloading{upd.total ? ` ${Math.round((upd.received / upd.total) * 100)}%` : "…"}
                </span>
              </div>
            )}
            {upd.kind === "installing" && (
              <span className="about-update-note">Installing — the app will restart…</span>
            )}
          </div>
        )}

        <div className="about-license-label">License — MIT</div>
        <pre className="about-license">{licenseText}</pre>

        <div className="form-row end">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
