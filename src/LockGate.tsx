import { useCallback, useEffect, useState } from "react";

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
      await authenticate("Unlock termdb", { allowDeviceCredential: true });
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
      if (document.visibilityState === "hidden" && state === "unlocked") {
        setState("locked");
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [state]);

  if (state === "unlocked" || state === "unavailable") {
    return <>{children}</>;
  }

  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-icon">🔒</div>
        <h2>termdb locked</h2>
        <p>Authenticate to access your connections.</p>
        <button onClick={tryUnlock}>Unlock</button>
        {error && <pre className="error">{error}</pre>}
      </div>
    </div>
  );
}
