import { updaterEnabled } from "./updater";

/**
 * Store-distributed builds (Mac App Store / iOS App Store / Google Play) compile
 * the self-updater out, so they can't self-update — but we can look up the
 * store's latest version and light up the top-bar "Update" pill, which opens the
 * store. Gated on `!updaterEnabled`, which is exactly the store builds; a macOS
 * direct-download build keeps its own self-updater instead.
 */
export const storeUpdateEnabled = !updaterEnabled;

/** Platforms that have a store to point at. */
export const STORE_PLATFORMS = ["ios", "macos", "android"];

export interface StoreUpdate {
  version: string;
  url: string;
}

/** True when version `a` is strictly newer than `b` (dot-separated numerics). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Throttle the store lookup so it doesn't run on every launch.
const THROTTLE_MS = 6 * 60 * 60 * 1000; // 6 hours
const KEY = "balaudeck.storeCheck";

export function storeCheckDue(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(KEY) || 0) > THROTTLE_MS;
  } catch {
    return true;
  }
}

export function markStoreChecked(): void {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* private mode / quota — just check again next launch */
  }
}

/** How often a long-running session re-asks the store (also on resume). */
export const RECHECK_MS = THROTTLE_MS;

// The last newer version the store reported. Kept so a launch inside the
// throttle window still shows it — otherwise the notice vanished for 6 hours
// after the launch that found it.
const LATEST_KEY = "balaudeck.storeLatest";

export function cachedStoreUpdate(): StoreUpdate | null {
  try {
    const v = JSON.parse(localStorage.getItem(LATEST_KEY) || "null");
    return v && typeof v.version === "string" && typeof v.url === "string" ? v : null;
  } catch {
    return null;
  }
}

export function cacheStoreUpdate(u: StoreUpdate | null): void {
  try {
    if (u) localStorage.setItem(LATEST_KEY, JSON.stringify(u));
    else localStorage.removeItem(LATEST_KEY);
  } catch {
    /* ignore */
  }
}

// "Later" on the update notice hides it for that version only; a newer
// release brings it back.
const DISMISS_KEY = "balaudeck.updateDismissed";

export function updateDismissed(version: string): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === version;
  } catch {
    return false;
  }
}

export function dismissUpdate(version: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    /* ignore */
  }
}
