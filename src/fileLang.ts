import { LanguageDescription } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { languages } from "@codemirror/language-data";

/**
 * Syntax highlighting for a file opened in the SFTP/S3 preview, picked from
 * its name. @codemirror/language-data covers ~140 languages by extension or
 * filename (Dockerfile, nginx*.conf, …) and loads each grammar lazily, so only
 * the language actually opened is fetched. Server dotfiles that carry no
 * extension get a fallback mapping.
 */
const FALLBACK: [RegExp, string][] = [
  [/^\.(bash|zsh)?(rc|_profile|_login|_logout|_aliases|env)$|^\.profile$|^\.zshenv$/i, "Shell"],
  [/^\.env(\..+)?$|\.env$/i, "Properties files"],
  [/^(crontab|authorized_keys|known_hosts)$/i, "Shell"],
  [/^(\.gitconfig|\.editorconfig|php\.ini|my\.cnf)$|\.(cnf|ini|conf)$/i, "Properties files"],
  [/^(\.htaccess|httpd\.conf|apache2\.conf)$/i, "Nginx"],
  [/^Caddyfile$|^Makefile$/i, "Shell"],
];

function baseName(name: string): string {
  const i = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  return i >= 0 ? name.slice(i + 1) : name;
}

export function describeLanguage(name: string): LanguageDescription | null {
  const base = baseName(name);
  const hit = LanguageDescription.matchFilename(languages, base);
  if (hit) return hit;
  for (const [re, lang] of FALLBACK) {
    if (re.test(base)) return LanguageDescription.matchLanguageName(languages, lang, false);
  }
  return null;
}

/** Resolves to the language extension for `name`, or null for plain text. */
export async function loadLanguage(name: string): Promise<{ label: string; ext: Extension } | null> {
  const d = describeLanguage(name);
  if (!d) return null;
  try {
    const support = await d.load();
    return { label: d.name, ext: support };
  } catch {
    return null;
  }
}
