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
