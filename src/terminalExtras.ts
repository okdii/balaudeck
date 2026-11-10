import type { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getSettings, setSettings, resolveFontSize } from "./settings";

/** Turn http(s) URLs in the output into clickable links that open in the
 *  system browser (never in-app). */
export function attachWebLinks(term: Terminal): void {
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      if (/^https?:\/\//i.test(uri)) openUrl(uri).catch(() => {});
    }),
  );
}

/** Load the search addon and hand it back so a search bar can drive it. */
export function attachSearch(term: Terminal): SearchAddon {
  const addon = new SearchAddon();
  term.loadAddon(addon);
  return addon;
}

/** Decoration colours for search matches (xterm wants hex, not CSS vars). */
export const SEARCH_DECORATIONS = {
  matchBackground: "#4b5a2f",
  matchOverviewRuler: "#b9cb6a",
  activeMatchBackground: "#1bb3a3",
  activeMatchColorOverviewRuler: "#1bb3a3",
};

/** Bump the terminal font one step (delta +1/-1) or reset to Auto (delta 0).
 *  Writes the shared setting, so every open terminal re-fits live. */
export function zoomTermFont(delta: number): void {
  if (delta === 0) {
    setSettings({ termFontSize: 0 });
    return;
  }
  const base = getSettings().termFontSize || resolveFontSize();
  const next = Math.max(10, Math.min(28, base + (delta > 0 ? 1 : -1)));
  setSettings({ termFontSize: next });
}

/** Key handler for zoom / clear / find, composed into the terminal's single
 *  custom-key handler. Returns false when it consumed the key, else undefined.
 *  Platform-neutral: ⌘ combos (metaKey) for macOS, Ctrl+Shift for the rest. */
export function makeExtrasKey(opts: {
  term: Terminal;
  openSearch: () => void;
}): (ev: KeyboardEvent) => boolean | undefined {
  return (ev) => {
    if (ev.type !== "keydown" || ev.altKey) return undefined;
    const mod = ev.metaKey || ev.ctrlKey;
    if (!mod) return undefined;
    const k = ev.key;
    // Zoom: (⌘ or Ctrl) +/=/-/0 — never shift.
    if (!ev.shiftKey) {
      if (k === "=" || k === "+") {
        ev.preventDefault();
        zoomTermFont(1);
        return false;
      }
      if (k === "-" || k === "_") {
        ev.preventDefault();
        zoomTermFont(-1);
        return false;
      }
      if (k === "0") {
        ev.preventDefault();
        zoomTermFont(0);
        return false;
      }
    }
    const macMod = ev.metaKey && !ev.ctrlKey && !ev.shiftKey;
    const otherMod = ev.ctrlKey && ev.shiftKey && !ev.metaKey;
    // Find: ⌘F / Ctrl+Shift+F.
    if ((k === "f" || k === "F") && (macMod || otherMod)) {
      ev.preventDefault();
      opts.openSearch();
      return false;
    }
    // Clear scrollback: ⌘K / Ctrl+Shift+K (plain Ctrl+L still clears the screen).
    if ((k === "k" || k === "K") && (macMod || otherMod)) {
      ev.preventDefault();
      opts.term.clear();
      return false;
    }
    return undefined;
  };
}
