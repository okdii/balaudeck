import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { getSettings } from "./settings";

type LockState = "checking" | "locked" | "unlocked" | "unavailable";

// How long the app may sit in the background before it re-locks. Short
// interruptions (the biometric dialog itself, a file picker, the keyboard, a
// quick app switch to copy a password) return within this window and do NOT
// re-prompt — only a genuine absence does.
const GRACE_MS = 60_000;

/**
 * Biometric app lock. On mobile (Face ID / Touch ID / device credential) the
 * app locks on launch and after being backgrounded past a grace period. On
 * desktop or when biometrics are unavailable it renders children directly.
 *
 * Android's system WebView fires visibilitychange very eagerly — the auth
 * dialog, file pickers and the soft keyboard all toggle it — so we (a) ignore
 * visibility changes while our own auth dialog is up, and (b) only re-prompt
 * after a real absence. Without this the user is asked to authenticate
 * constantly (and the prompt can loop).
 */
export function LockGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LockState>("checking");
  const [error, setError] = useState("");

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // True while the system biometric dialog is showing, so the visibility flap
  // it causes doesn't re-trigger another prompt.
  const authInProgress = useRef(false);
  const hiddenAt = useRef<number | null>(null);

  const tryUnlock = useCallback(async () => {
    if (authInProgress.current) return;
    authInProgress.current = true;
    setError("");
    try {
      const { authenticate } = await import("@tauri-apps/plugin-biometric");
      await authenticate("Unlock BalauDeck", { allowDeviceCredential: true });
      setState("unlocked");
    } catch (e) {
      setState("locked");
      setError(String(e));
    } finally {
      // Clear a beat later so the dialog's own hide→show as it dismisses
      // doesn't immediately fire another prompt.
      setTimeout(() => {
        authInProgress.current = false;
      }, 800);
    }
  }, []);

  useEffect(() => {
    // App-lock honours a user setting (default on). When off — or when the
    // biometric prompt can't be used — the app opens directly instead of
    // trapping the user on the lock screen.
    if (!getSettings().appLock) {
      setState("unavailable");
      return;
    }
    (async () => {
      try {
        const { checkStatus } = await import("@tauri-apps/plugin-biometric");
        const status = await checkStatus();
        if (status.isAvailable) {
          setState("locked");
          tryUnlock();
        } else {
          setState("unavailable");
        }
      } catch {
        // Plugin not present (desktop) — no lock.
        setState("unavailable");
      }
    })();
  }, [tryUnlock]);

  useEffect(() => {
    function onVisibility() {
      // Ignore flaps the biometric dialog itself causes.
      if (authInProgress.current) return;

      if (document.visibilityState === "hidden") {
        if (stateRef.current === "unlocked") {
          hiddenAt.current = Date.now();
          setState("locked"); // blank the app in the recents/app-switcher
        }
      } else if (document.visibilityState === "visible") {
        if (stateRef.current !== "locked") return;
        const away = hiddenAt.current ? Date.now() - hiddenAt.current : Infinity;
        hiddenAt.current = null;
        if (away < GRACE_MS) {
          setState("unlocked"); // brief interruption — no re-auth
        } else {
          tryUnlock();
        }
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [tryUnlock]);

  const showLock = state === "checking" || state === "locked";

  // Keep children mounted across lock/unlock so the app's open sessions, tabs,
  // and panes survive — the lock screen is an opaque overlay, not a replacement.
  return (
    <>
      {state !== "checking" && children}
      {showLock && (
        <div className="lock-screen">
          <div className="lock-card">
            <div className="lock-icon">
              <Icon name="lock" size={40} />
            </div>
            <h2>BalauDeck locked</h2>
            <p>Authenticate to access your connections.</p>
            <button onClick={tryUnlock}>Unlock</button>
            {error && <pre className="error">{error}</pre>}
          </div>
        </div>
      )}
    </>
  );
}
