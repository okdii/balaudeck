/**
 * Input broadcast ("synchronize panes"): terminals the user ticks are grouped,
 * and a keystroke typed in any group member is written to EVERY member — like
 * tmux's synchronize-panes / iTerm's broadcast input.
 *
 * Each terminal pane registers a writer (how to send bytes to its backend). The
 * sync set holds the ticked pane ids. `broadcastInput` fans a pane's typed data
 * out to the whole set when that pane is a member.
 */

type Writer = (data: string) => void;

const writers = new Map<string, Writer>();
const synced = new Set<string>();
const subs = new Set<() => void>();

function emit() {
  subs.forEach((f) => f());
}

/** A terminal pane registers how to write to its backend; returns an unregister
 * fn that also drops it from the sync set (so closing a pane cleans up). */
export function registerPaneWriter(id: string, write: Writer): () => void {
  writers.set(id, write);
  return () => {
    writers.delete(id);
    if (synced.delete(id)) emit();
  };
}

export function isSyncOn(id: string): boolean {
  return synced.has(id);
}

export function syncCount(): number {
  return synced.size;
}

export function toggleSync(id: string): void {
  if (!synced.delete(id)) synced.add(id);
  emit();
}

export function clearSync(): void {
  if (synced.size) {
    synced.clear();
    emit();
  }
}

/**
 * Called by a pane on typed input. When the pane is in the sync set, the data is
 * written to every synced pane (including this one) and this returns true — the
 * caller must NOT also write it itself. Otherwise returns false (write normally).
 */
export function broadcastInput(fromId: string, data: string): boolean {
  if (!synced.has(fromId)) return false;
  for (const id of synced) writers.get(id)?.(data);
  return true;
}

/** Subscribe to sync-set changes (for UI re-render). Returns an unsubscribe fn. */
export function subscribeSync(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}
