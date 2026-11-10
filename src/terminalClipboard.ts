import type { Terminal } from "@xterm/xterm";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { getSettings } from "./settings";
import { terminalText } from "./TermCopySheet";

/**
 * Terminal copy & paste, following the conventions common terminals use (macOS
 * Terminal/iTerm, Windows Terminal, GNOME) so it feels familiar:
 *
 *  • Copy — ⌘C (macOS) / Ctrl+Shift+C (elsewhere) copies the selection. Plain
 *    Ctrl+C is left alone so it still sends SIGINT.
 *  • Paste — ⌘V (macOS) / Ctrl+Shift+V (elsewhere). Plain Ctrl+V is left for the
 *    shell (literal/verbatim insert). `term.paste` wraps bracketed-paste itself.
 *  • Copy on select — finishing a mouse selection copies it (X11 / iTerm style),
 *    governed by the `copyOnSelect` setting (default on).
 *  • Right-click menu — Copy / Paste / Copy all / Clear / Save, for discoverability.
 *  • OSC 52 — tmux (with `set -s set-clipboard on`) and CLI tools emit
 *    `ESC ] 52 ; c ; <base64> BEL` to set the clipboard; we honour writes but
 *    deny read queries (`52;c;?`) so a remote can never read the clipboard back.
 *
 * Clipboard I/O goes through the Tauri plugin (works in the iOS/Android webview
 * and from non-gesture OSC output, where navigator.clipboard can reject), with a
 * navigator.clipboard fallback. Paste needs `clipboard-manager:allow-read-text`.
 */
/** Returned so the owner can wire these into xterm's single custom-key handler
 *  (autosuggest owns it and chains through `extraKeys`). `onKey` returns false
 *  when it consumed the key, undefined to pass it on. */
export interface TerminalClipboard {
  detach: () => void;
  onKey: (ev: KeyboardEvent) => boolean | undefined;
}

export function attachTerminalClipboard(term: Terminal, host: HTMLElement): TerminalClipboard {
  const copy = (text: string) => {
    if (!text) return;
    writeText(text).catch(() => {
      navigator.clipboard?.writeText(text).catch(() => {});
    });
  };

  const paste = async () => {
    let text = "";
    try {
      text = (await readText()) ?? "";
    } catch {
      try {
        text = (await navigator.clipboard?.readText()) ?? "";
      } catch {
        text = "";
      }
    }
    if (text) term.paste(text); // handles bracketed-paste wrapping itself
  };

  // OSC 52: payload is `<Pc>;<Pd>` (Pc = target selection, Pd = base64 or `?`).
  const disposeOsc = term.parser.registerOscHandler(52, (data) => {
    const semi = data.indexOf(";");
    const payload = semi >= 0 ? data.slice(semi + 1) : data;
    if (payload === "?" || payload === "") return true; // read query — denied
    const text = decodeBase64(payload);
    if (text != null) copy(text);
    return true; // handled either way — never forward OSC 52 onward
  });

  const onKey = (e: KeyboardEvent): boolean | undefined => {
    if (e.type !== "keydown") return undefined;
    const k = e.key.toLowerCase();
    if (k === "c") {
      const macCopy = e.metaKey && !e.ctrlKey && !e.altKey;
      const otherCopy = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
      if ((macCopy || otherCopy) && term.hasSelection()) {
        copy(term.getSelection());
        return false; // consumed — don't also send the keystroke to the shell
      }
      return undefined; // plain Ctrl+C → let it through (SIGINT)
    }
    if (k === "v") {
      const macPaste = e.metaKey && !e.ctrlKey && !e.altKey;
      const otherPaste = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
      if (macPaste || otherPaste) {
        // Stop the browser's own paste event too, or xterm's native paste
        // handler would fire and we'd paste twice.
        e.preventDefault();
        void paste();
        return false; // consumed
      }
      return undefined; // plain Ctrl+V → shell (verbatim insert)
    }
    return undefined;
  };

  // Copy on select: after a left-button drag that leaves a selection, copy it.
  const onMouseUp = (e: MouseEvent) => {
    if (e.button !== 0 || !getSettings().copyOnSelect) return;
    if (term.hasSelection()) copy(term.getSelection());
  };
  host.addEventListener("mouseup", onMouseUp);

  // Right-click context menu (Copy / Paste / Copy all / …). Touch long-press is
  // handled by the touch-select layer, which swallows its contextmenu first.
  let menuEl: HTMLDivElement | null = null;
  const closeMenu = () => {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("scroll", closeMenu, true);
    window.removeEventListener("resize", closeMenu);
  };
  const onDocDown = (e: MouseEvent) => {
    if (menuEl && !menuEl.contains(e.target as Node)) closeMenu();
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    closeMenu();
    const sel = term.hasSelection() ? term.getSelection() : "";
    menuEl = document.createElement("div");
    menuEl.className = "tab-menu tab-menu-fixed term-ctx";
    const item = (label: string, enabled: boolean, run: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.disabled = !enabled;
      b.addEventListener("click", () => {
        run();
        closeMenu();
      });
      menuEl!.appendChild(b);
    };
    item("Copy", !!sel, () => copy(sel));
    item("Paste", true, () => void paste());
    // "Copy all" grabs the whole buffer directly — reliable even under tmux,
    // where a persisted xterm selection (Select all) is wiped by status redraws.
    item("Copy all", true, () => copy(terminalText(term, 1_000_000)));
    const sep = document.createElement("div");
    sep.className = "tab-menu-sep";
    menuEl.appendChild(sep);
    item("Clear scrollback", true, () => term.clear());
    item("Save output…", true, () => void saveOutput(term));
    document.body.appendChild(menuEl);
    const MENU_W = 170;
    menuEl.style.top = `${e.clientY}px`;
    menuEl.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_W - 8))}px`;
    document.addEventListener("mousedown", onDocDown, true);
    document.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
  };
  host.addEventListener("contextmenu", onContextMenu);

  const detach = () => {
    disposeOsc.dispose();
    host.removeEventListener("mouseup", onMouseUp);
    host.removeEventListener("contextmenu", onContextMenu);
    closeMenu();
  };
  return { detach, onKey };
}

/** Save the terminal buffer (scrollback + screen) to a text file the user picks. */
async function saveOutput(term: Terminal): Promise<void> {
  const text = terminalText(term, 1_000_000);
  if (!text) return;
  const path = await save({
    defaultPath: "terminal-output.txt",
    filters: [{ name: "Text", extensions: ["txt", "log"] }],
  });
  if (path) await writeTextFile(path, text).catch(() => {});
}

/** Base64 → UTF-8 text; null on malformed input (never throws into the parser). */
function decodeBase64(b64: string): string | null {
  try {
    const bin = atob(b64.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
