// Content-based privacy masking. Complements the section blur: user-defined glob
// patterns (e.g. `*.*.*.*` for IPs) blur their matching text wherever it appears
// as a label, even in sections that are otherwise shown. Applied in React render
// (no DOM surgery), so it never fights React's reconciliation.

import type { ReactNode } from "react";
import { getSettings } from "./settings";

// Compiled regex is cached until the pattern list changes.
let cacheKey = "";
let cacheRe: RegExp | null = null;

/** One glob → a regex source. Every character is literal except `*`, which
 *  matches a run of letters/digits/hyphens (a single "segment"). */
function globToSource(glob: string): string {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(/\\\*/g, "[A-Za-z0-9-]+");
}

/** True when privacy is on and some pattern matches `text` — used to decide
 *  whether an editable field should show a masked read-view instead. */
export function hasPrivacyMatch(text: string): boolean {
  if (!getSettings().privacyOn || !text) return false;
  const re = privacyRegex();
  if (!re) return false;
  re.lastIndex = 0;
  return re.test(text);
}

/** Combined case-insensitive regex for all non-empty patterns, or null. */
export function privacyRegex(): RegExp | null {
  const pats = getSettings()
    .privacyPatterns.map((p) => p.trim())
    .filter(Boolean);
  const key = pats.join("\n");
  if (key === cacheKey) return cacheRe;
  cacheKey = key;
  try {
    cacheRe = pats.length ? new RegExp(pats.map(globToSource).join("|"), "gi") : null;
  } catch {
    cacheRe = null; // A malformed pattern just disables matching.
  }
  return cacheRe;
}

/** Wrap substrings matching any active privacy pattern in a blur span. Returns
 *  the text unchanged when privacy is off or no pattern matches — so only the
 *  matched text (e.g. the IP) blurs while the rest of the label stays readable.
 *  Hover a match to reveal it. */
export function maskText(text: string): ReactNode {
  const s = getSettings();
  if (!s.privacyOn || !text) return text;
  const re = privacyRegex();
  if (!re) return text;
  re.lastIndex = 0;

  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span className="pv-pattern" key={key++}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // guard against zero-width loops
  }
  if (!out.length) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
