// Privacy-pattern masking for the xterm terminal. React's maskText() can't reach
// the terminal (xterm owns that DOM). xterm uses the DOM renderer here (only
// addon-fit is loaded), so the visible text is real glyph spans inside
// .xterm-rows. We watch that subtree and wrap pattern matches in the same
// .pv-pattern blur span used elsewhere. xterm rewrites rows on every update, so a
// debounced MutationObserver re-applies (disconnecting while it edits so it never
// observes its own writes).

import type { Terminal } from "@xterm/xterm";
import { getSettings, subscribeSettings } from "./settings";
import { privacyRegex } from "./privacy";

export function attachTerminalMask(term: Terminal, host: HTMLElement): () => void {
  let timer: number | undefined;
  let observer: MutationObserver | null = null;

  const rowsEl = () => host.querySelector(".xterm-rows") as HTMLElement | null;

  const unwrap = (root: HTMLElement) => {
    root.querySelectorAll("span.pv-pattern").forEach((el) => {
      const p = el.parentNode;
      if (p) p.replaceChild(document.createTextNode(el.textContent || ""), el);
    });
    root.normalize();
  };

  const wrapNode = (t: Text, re: RegExp) => {
    const text = t.data;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      any = true;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement("span");
      span.className = "pv-pattern";
      span.textContent = m[0];
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (!any) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    t.parentNode?.replaceChild(frag, t);
  };

  const reconnect = () => {
    const rows = rowsEl();
    if (rows && observer) {
      observer.observe(rows, { childList: true, subtree: true, characterData: true });
    }
  };

  const apply = () => {
    const rows = rowsEl();
    if (!rows) return;
    const re = getSettings().privacyOn ? privacyRegex() : null;
    observer?.disconnect();
    try {
      unwrap(rows);
      if (re) {
        const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
        const targets: Text[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const t = node as Text;
          re.lastIndex = 0;
          if (t.data && re.test(t.data)) targets.push(t);
        }
        for (const t of targets) wrapNode(t, re);
      }
    } catch {
      /* xterm mid-update; the next tick retries */
    }
    reconnect();
  };

  const schedule = () => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      apply();
    }, 80);
  };

  observer = new MutationObserver(schedule);
  const onRender = term.onRender(schedule);
  const unsub = subscribeSettings(schedule);
  schedule();

  return () => {
    if (timer) window.clearTimeout(timer);
    observer?.disconnect();
    observer = null;
    onRender.dispose();
    unsub();
    const rows = rowsEl();
    if (rows) unwrap(rows);
  };
}
