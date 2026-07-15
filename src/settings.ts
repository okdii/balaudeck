// App-wide user settings — theme, accent, and terminal look. Persisted per
// device in localStorage (like the other `balaudeck.*` prefs). A tiny store +
// subscribe (mirrors broadcast.ts) so live terminals and the app chrome react
// without a restart.

export type ThemeMode = "system" | "light" | "dark";
export type Accent = "teal" | "blue" | "purple" | "green" | "orange" | "pink";
export type TermScheme =
  | "default"
  | "solarized"
  | "dracula"
  | "nord"
  | "onelight"
  | "monokai";

/** Which on-screen sections privacy mode blurs. Both the master on/off
 *  (`privacyOn`) and which sections to hide persist across restarts. */
export interface PrivacySections {
  folders: boolean;
  names: boolean;
  endpoints: boolean;
  data: boolean;
}

export const PRIVACY_SECTIONS: { id: keyof PrivacySections; label: string; hint: string }[] = [
  { id: "folders", label: "Folder names", hint: "Group names in the sidebar" },
  { id: "names", label: "Connection names", hint: "Connection labels, tab + pane titles, note titles" },
  { id: "endpoints", label: "Host, IP & user", hint: "user@host:port and live session endpoints" },
  { id: "data", label: "Data & content", hint: "Terminal, files, query results, keys/values, notes" },
];

export interface Settings {
  theme: ThemeMode;
  accent: Accent;
  /** 0 = Auto (responsive default); otherwise a fixed px size in [10, 20]. */
  termFontSize: number;
  termScheme: TermScheme;
  /** Privacy-mode master toggle. Persisted so it survives a restart. */
  privacyOn: boolean;
  privacy: PrivacySections;
  /** Glob patterns whose matching text is blurred anywhere it appears as a label
   *  (independent of the section toggles). `*` matches one word/number segment,
   *  e.g. `*.*.*.*` blurs IPv4 addresses. */
  privacyPatterns: string[];
  /** Require a biometric / device-credential unlock on mobile launch. Opt-in
   *  (off by default) so a device whose biometric prompt misbehaves can never
   *  trap the user on the lock screen. Desktop ignores this. */
  appLock: boolean;
  /** Desktop direct-download builds only: silently check GitHub for a newer
   *  release on launch and surface an "Update" pill (never auto-installs — the
   *  user clicks to download). On by default; store builds ignore this. */
  autoUpdate: boolean;
}

const KEY = "balaudeck.settings";

const DEFAULTS: Settings = {
  theme: "system",
  accent: "teal",
  termFontSize: 0,
  termScheme: "default",
  privacyOn: false,
  privacy: { folders: true, names: true, endpoints: true, data: true },
  privacyPatterns: [],
  appLock: false,
  autoUpdate: true,
};

export const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: "teal", label: "Teal", swatch: "#14a596" },
  { id: "blue", label: "Blue", swatch: "#2f6fed" },
  { id: "purple", label: "Purple", swatch: "#9333ea" },
  { id: "green", label: "Green", swatch: "#16a34a" },
  { id: "orange", label: "Orange", swatch: "#ef8a45" },
  { id: "pink", label: "Pink", swatch: "#db2777" },
];

/** xterm ITheme presets. Kept loose (string map) to avoid coupling to xterm's
 *  type; the panels pass this straight to `new Terminal({ theme })`. */
type TermTheme = Record<string, string>;

export const TERM_SCHEMES: { id: TermScheme; label: string; theme: TermTheme }[] = [
  {
    id: "default",
    label: "Default (dark)",
    theme: {
      background: "#0b0f12", foreground: "#d7dee2", cursor: "#14a596", cursorAccent: "#0b0f12",
      selectionBackground: "#264b47",
      black: "#0b0f12", red: "#ef6f6a", green: "#57c7a3", yellow: "#e0a32e", blue: "#5aa9e6",
      magenta: "#c589e8", cyan: "#4ec9b0", white: "#d7dee2",
      brightBlack: "#5f6b73", brightRed: "#ff8b86", brightGreen: "#7ddcbc", brightYellow: "#f0c65a",
      brightBlue: "#82c0ff", brightMagenta: "#d6a6f0", brightCyan: "#79e0cd", brightWhite: "#ffffff",
    },
  },
  {
    id: "solarized",
    label: "Solarized Dark",
    theme: {
      background: "#002b36", foreground: "#839496", cursor: "#93a1a1", cursorAccent: "#002b36",
      selectionBackground: "#073642",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2",
      magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#586e75", brightRed: "#cb4b16", brightGreen: "#586e75", brightYellow: "#657b83",
      brightBlue: "#839496", brightMagenta: "#6c71c4", brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  {
    id: "dracula",
    label: "Dracula",
    theme: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9",
      magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
      brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    label: "Nord",
    theme: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1",
      magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  {
    id: "monokai",
    label: "Monokai",
    theme: {
      background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0", cursorAccent: "#272822",
      selectionBackground: "#49483e",
      black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75", blue: "#66d9ef",
      magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
      brightBlack: "#75715e", brightRed: "#f92672", brightGreen: "#a6e22e", brightYellow: "#f4bf75",
      brightBlue: "#66d9ef", brightMagenta: "#ae81ff", brightCyan: "#a1efe4", brightWhite: "#f9f8f5",
    },
  },
  {
    id: "onelight",
    label: "One Light",
    theme: {
      background: "#fafafa", foreground: "#383a42", cursor: "#526fff", cursorAccent: "#fafafa",
      selectionBackground: "#e5e5e6",
      black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401", blue: "#4078f2",
      magenta: "#a626a4", cyan: "#0184bc", white: "#a0a1a7",
      brightBlack: "#4f525d", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b",
      brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
];

function load(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || "{}");
    return {
      ...DEFAULTS,
      ...stored,
      // Deep-merge nested prefs so a new sub-key still gets its default.
      privacy: { ...DEFAULTS.privacy, ...(stored.privacy || {}) },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let current: Settings = load();
const subs = new Set<() => void>();

function notify() {
  subs.forEach((f) => f());
}

export function getSettings(): Settings {
  return current;
}

export function setSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode / quota — settings still apply for this session */
  }
  applyAppTheme();
  notify();
}

export function subscribeSettings(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}

const prefersDark = () =>
  typeof window !== "undefined" &&
  !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;

/** Resolved dark/light after applying the "system" preference. */
export function isDark(s: Settings = current): boolean {
  return s.theme === "dark" || (s.theme === "system" && prefersDark());
}

/** Reflect theme + accent onto <html> so the CSS ([data-theme]/[data-accent])
 *  takes over. Called at startup and on every change. */
export function applyAppTheme(s: Settings = current): void {
  const root = document.documentElement;
  root.dataset.theme = isDark(s) ? "dark" : "light";
  root.dataset.accent = s.accent;
  // Privacy master + which sections are armed. Applied here (at load + on every
  // change) so a persisted "on" blurs before first paint — no unblurred flash.
  root.dataset.privacy = s.privacyOn ? "on" : "off";
  root.dataset.pvFolders = s.privacy.folders ? "on" : "off";
  root.dataset.pvNames = s.privacy.names ? "on" : "off";
  root.dataset.pvEndpoints = s.privacy.endpoints ? "on" : "off";
  root.dataset.pvData = s.privacy.data ? "on" : "off";
  // Publish the active terminal scheme's background so the padding around the
  // xterm grid matches it instead of showing a hardcoded black frame.
  const bg = termTheme(s).background;
  if (bg) root.style.setProperty("--term-bg", bg);
}

/** Terminal font size after resolving Auto to the responsive default. */
export function resolveFontSize(s: Settings = current): number {
  if (s.termFontSize >= 10 && s.termFontSize <= 20) return s.termFontSize;
  return window.matchMedia("(max-width: 430px)").matches ? 11 : 14;
}

export function termTheme(s: Settings = current): TermTheme {
  return (TERM_SCHEMES.find((x) => x.id === s.termScheme) ?? TERM_SCHEMES[0]).theme;
}

// Follow the OS when the user picked "system".
if (typeof window !== "undefined") {
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => {
      if (current.theme === "system") {
        applyAppTheme();
        notify();
      }
    });
  // Apply once at module load (imported early from main.tsx) to avoid a flash.
  applyAppTheme();
}
