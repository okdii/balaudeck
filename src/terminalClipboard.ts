import type { Terminal } from "@xterm/xterm";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Bridge terminal copy to the system clipboard, so text selected in the shell —
 * including a tmux copy-mode / mouse selection over SSH — lands on the device
 * clipboard like any native terminal.
 *
 * Two paths:
 *  1. OSC 52 — tmux (with `set -s set-clipboard on`, which we enable on attach)
 *     and many CLI tools emit `ESC ] 52 ; c ; <base64> BEL` to set the clipboard.
 *     xterm.js ignores it by default (a remote shouldn't silently read/write your
 *     clipboard), so we register a handler that WRITES on request but refuses
 *     READ requests (`52;c;?`) — the remote never gets our clipboard back.
 *  2. A copy shortcut — Cmd-C (macOS) / Ctrl-Shift-C (elsewhere) copies the
 *     current selection. Plain Ctrl-C is left alone so it still sends SIGINT.
 *
 * We write via the Tauri clipboard plugin rather than navigator.clipboard: the
 * OSC path fires from network output with no user gesture (which the web API
 * can reject), and the plugin also works in the iOS/Android webview.
 */
export function attachTerminalClipboard(term: Terminal): () => void {
  const copy = (text: string) => {
    if (text) writeText(text).catch(() => {});
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

  const keyHandler = (e: KeyboardEvent): boolean => {
    if (e.type !== "keydown" || e.key.toLowerCase() !== "c") return true;
    const macCopy = e.metaKey && !e.ctrlKey && !e.altKey;
    const otherCopy = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey;
    if ((macCopy || otherCopy) && term.hasSelection()) {
      copy(term.getSelection());
      return false; // don't also send the keystroke to the shell
    }
    return true;
  };
  term.attachCustomKeyEventHandler(keyHandler);

  return () => {
    disposeOsc.dispose();
    // xterm has no "detach" for the custom key handler; a no-op reinstates default.
    term.attachCustomKeyEventHandler(() => true);
  };
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
