// Desktop idle lock. After N idle minutes (Settings → Security) an opaque
// screen covers the app; sessions keep running underneath (the app stays
// mounted). Unlock with the OS (Touch ID / login password on macOS) or the
// BalauDeck PIN. Mobile uses the biometric LockGate instead.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon, Spinner } from "./Icon";
import { getSettings, subscribeSettings } from "./settings";

const isMobile =
  /iPhone|iPad|Android/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const LOCK_EVENT = "balaudeck:lock-now";

/** Lock right away (command palette). Only works when the idle lock is set up. */
export function lockNow() {
  window.dispatchEvent(new Event(LOCK_EVENT));
}

export const idleLockApi = {
  osAvailable: () => invoke<boolean>("applock_os_available").catch(() => false),
  osUnlock: (reason: string) => invoke<boolean>("applock_os_unlock", { reason }),
  pinExists: () => invoke<boolean>("applock_pin_exists").catch(() => false),
  pinSet: (pin: string | null) => invoke<void>("applock_pin_set", { pin }),
  pinVerify: (pin: string) => invoke<boolean>("applock_pin_verify", { pin }),
};

export function IdleLock({ children }: { children: React.ReactNode }) {
  const [minutes, setMinutes] = useState(getSettings().idleLockMinutes);
  useEffect(() => subscribeSettings(() => setMinutes(getSettings().idleLockMinutes)), []);
  const [locked, setLocked] = useState(false);
  const [osOk, setOsOk] = useState(false);
  const [hasPin, setHasPin] = useState(false);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const last = useRef(Date.now());
  const lockedRef = useRef(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const enabled = !isMobile && minutes > 0;

  useEffect(() => {
    if (isMobile) return;
    idleLockApi.osAvailable().then(setOsOk);
    idleLockApi.pinExists().then(setHasPin);
  }, [minutes, locked]);

  const unlockOs = useCallback(async () => {
    setErr("");
    setBusy(true);
    try {
      if (await idleLockApi.osUnlock("unlock BalauDeck")) {
        lockedRef.current = false;
        setLocked(false);
        last.current = Date.now();
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const lock = useCallback(() => {
    if (lockedRef.current) return;
    lockedRef.current = true;
    setPin("");
    setErr("");
    setLocked(true);
    // Keystrokes must not reach a focused terminal behind the screen.
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, []);

  // Activity tracking + the idle check.
  useEffect(() => {
    if (!enabled) return;
    const bump = () => {
      if (!lockedRef.current) last.current = Date.now();
    };
    const evs = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    evs.forEach((e) => window.addEventListener(e, bump, { capture: true, passive: true }));
    last.current = Date.now();
    const t = window.setInterval(() => {
      if (Date.now() - last.current >= minutes * 60_000) lock();
    }, 5000);
    const onLockNow = () => lock();
    window.addEventListener(LOCK_EVENT, onLockNow);
    return () => {
      evs.forEach((e) => window.removeEventListener(e, bump, { capture: true }));
      window.clearInterval(t);
      window.removeEventListener(LOCK_EVENT, onLockNow);
    };
  }, [enabled, minutes, lock]);

  // While locked: swallow keys aimed anywhere but the lock screen.
  useEffect(() => {
    if (!locked) return;
    const trap = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".idle-lock")) return;
      e.stopPropagation();
      e.preventDefault();
      pinRef.current?.focus();
    };
    window.addEventListener("keydown", trap, true);
    return () => window.removeEventListener("keydown", trap, true);
  }, [locked]);

  async function submitPin() {
    if (!pin || busy) return;
    setBusy(true);
    setErr("");
    try {
      if (await idleLockApi.pinVerify(pin)) {
        lockedRef.current = false;
        setLocked(false);
        last.current = Date.now();
      } else {
        setErr("Wrong PIN.");
        setPin("");
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {children}
      {locked && (
        <div className="lock-screen idle-lock">
          <div className="lock-card">
            <div className="lock-icon">
              <Icon name="lock" size={40} />
            </div>
            <h2>BalauDeck locked</h2>
            <p>Your sessions, exports and transfers are still running.</p>
            {hasPin && (
              <form
                className="idle-lock-pin"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitPin();
                }}
              >
                <input
                  ref={pinRef}
                  type="password"
                  autoFocus
                  placeholder="PIN"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  autoComplete="off"
                />
                <button type="submit" disabled={!pin || busy}>
                  {busy ? <Spinner size={13} /> : "Unlock"}
                </button>
              </form>
            )}
            {osOk && (
              <button className={hasPin ? "ghost idle-lock-os" : "idle-lock-os"} onClick={unlockOs} disabled={busy}>
                Use Touch ID or password
              </button>
            )}
            {!osOk && !hasPin && (
              <button
                onClick={() => {
                  lockedRef.current = false;
                  setLocked(false);
                }}
              >
                Unlock
              </button>
            )}
            {err && <pre className="error">{err}</pre>}
          </div>
        </div>
      )}
    </>
  );
}
