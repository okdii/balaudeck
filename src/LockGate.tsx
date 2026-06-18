import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon";

type LockState = "checking" | "locked" | "unlocked" | "unavailable";

/**
 * Biometric app lock. On mobile (Face ID / Touch ID available) the app is
 * locked on launch and whenever it returns from the background. On desktop or
 * when biometrics are unavailable, it renders children directly.
 */
export function LockGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<LockState>("checking");
  const [error, setError] = useState("");

  const tryUnlock = useCallback(async () => {
    setError("");
    try {
      const { authenticate } = await import("@tauri-apps/plugin-biometric");
      await authenticate("Unlock BalauDeck", { allowDeviceCredential: true });
      setState("unlocked");
    } catch (e) {
      setState("locked");
      setError(String(e));
    }
  }, []);

  useEffect(() => {
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
      if (document.visibilityState === "hidden") {
        // Lock when backgrounded (but don't clobber the initial "checking").
        setState((s) => (s === "unlocked" ? "locked" : s));
      } else if (document.visibilityState === "visible") {
        // Returning to the foreground while locked → prompt Face ID again.
        setState((s) => {
          if (s === "locked") tryUnlock();
          return s;
        });
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
