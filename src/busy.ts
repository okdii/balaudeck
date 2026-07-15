/**
 * Keep a busy / loading state visible for at least `ms`, even when the work it
 * wraps finishes almost instantly.
 *
 * Most of our actions (an in-memory connections export, a quick keystore read,
 * a plugin-fs write) complete in well under a frame. Without a floor the
 * spinner mounts and unmounts before the WebView paints it, so on mobile the
 * button just looks stagnant — the user gets no feedback that anything ran.
 * Awaiting this before clearing the busy flag guarantees the loader is actually
 * perceptible. The delay also applies on error, so a failed action still shows
 * it was working before the message appears.
 */
export async function withMinVisible<T>(work: Promise<T> | T, ms = 450): Promise<T> {
  const start = Date.now();
  try {
    return await work;
  } finally {
    await holdMinVisible(start, ms);
  }
}

/**
 * Wait until at least `ms` have elapsed since `start` (a `Date.now()` stamp
 * taken when the busy flag was set). For handlers with several branches where
 * wrapping each awaited call would be noisy: stamp once, run the work, then
 * `await holdMinVisible(start)` right before clearing busy.
 */
export async function holdMinVisible(start: number, ms = 450): Promise<void> {
  const remaining = ms - (Date.now() - start);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}
