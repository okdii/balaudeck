// Per-connection query history, kept in localStorage as a small ring buffer so
// recently-run SQL can be searched and re-run. Keyed by host:port:user so each
// server keeps its own list.

export interface QHistEntry {
  sql: string;
  ts: number;
  ok: boolean;
}

const PREFIX = "balaudeck.qhist.";
const CAP = 200;

const storeKey = (connKey: string) => PREFIX + connKey;

export function loadHistory(connKey: string): QHistEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(connKey)) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Prepend an executed statement (newest first). Consecutive duplicates collapse
 *  into one entry (timestamp refreshed) so re-running the same query doesn't spam
 *  the list. Returns the trimmed list. */
export function pushHistory(connKey: string, sql: string, ok: boolean): QHistEntry[] {
  const s = sql.trim();
  if (!s) return loadHistory(connKey);
  const list = loadHistory(connKey);
  if (list[0]?.sql === s) list[0] = { sql: s, ts: Date.now(), ok };
  else list.unshift({ sql: s, ts: Date.now(), ok });
  const trimmed = list.slice(0, CAP);
  try {
    localStorage.setItem(storeKey(connKey), JSON.stringify(trimmed));
  } catch {
    /* quota / private mode — history is best-effort */
  }
  return trimmed;
}

export function clearHistory(connKey: string): void {
  try {
    localStorage.removeItem(storeKey(connKey));
  } catch {
    /* ignore */
  }
}
