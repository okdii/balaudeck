// Background transfer queue (S3/SFTP up/downloads). A tiny module store +
// subscribe (mirrors settings.ts): the backend streams `transfer://progress`
// events for any transfer command started with a job id, this folds them into
// a map, and TransferList re-renders through subscribe. Every event carries
// the full item state, so folding is a plain upsert.

import { listen } from "@tauri-apps/api/event";

export type TransferState = "running" | "done" | "error" | "cancelled";

/** One transfer job — the exact `transfer://progress` payload shape. */
export interface TransferItem {
  id: string;
  name: string;
  /** Bytes moved so far. */
  done: number;
  /** Total bytes, when known up front (null until e.g. a HEAD resolves). */
  total: number | null;
  state: TransferState;
  error: string | null;
}

/** Finished items retained beyond this are dropped oldest-first, so the list
 *  can't grow without bound in a long session. */
const MAX_FINISHED = 20;

/** `seq` orders the snapshot: assigned once at first sight of an id. */
type Rec = TransferItem & { seq: number };

const items = new Map<string, Rec>();
let seq = 0;
const subs = new Set<() => void>();

function notify() {
  subs.forEach((f) => f());
}

/** Fresh job id for a transfer command — also the cancel/event key. */
export function newJobId(): string {
  return crypto.randomUUID();
}

/** Snapshot for rendering: running transfers first (oldest first, so rows
 *  don't jump while several run), then finished ones newest-first. */
export function getTransfers(): TransferItem[] {
  const all = [...items.values()];
  const running = all.filter((t) => t.state === "running").sort((a, b) => a.seq - b.seq);
  const finished = all.filter((t) => t.state !== "running").sort((a, b) => b.seq - a.seq);
  return [...running, ...finished];
}

export function subscribeTransfers(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** Drop one finished item (the ✕ on a done/error/cancelled row). Running
 *  items stay — they are cancelled through the backend, not dismissed. */
export function dismissTransfer(id: string): void {
  const t = items.get(id);
  if (t && t.state !== "running") {
    items.delete(id);
    notify();
  }
}

/** Drop every finished item at once. */
export function clearFinished(): void {
  let changed = false;
  for (const [id, t] of items) {
    if (t.state !== "running") {
      items.delete(id);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Enforce MAX_FINISHED after a terminal event, oldest finished first. */
function trim() {
  const finished = [...items.values()].filter((t) => t.state !== "running");
  if (finished.length <= MAX_FINISHED) return;
  finished.sort((a, b) => a.seq - b.seq);
  for (const t of finished.slice(0, finished.length - MAX_FINISHED)) items.delete(t.id);
}

// One app-wide listener, started at module load (first import wins; the
// listen promise is fire-and-forget — events before it resolves are only
// possible for transfers started before any UI existed to start them).
if (typeof window !== "undefined") {
  void listen<TransferItem>("transfer://progress", (ev) => {
    const p = ev.payload;
    const prev = items.get(p.id);
    items.set(p.id, { ...p, seq: prev ? prev.seq : ++seq });
    if (p.state !== "running") trim();
    notify();
  });
}
