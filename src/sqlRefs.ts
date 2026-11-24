/**
 * Table names a SQL text refers to (FROM / JOIN / UPDATE / INTO / TABLE,
 * including comma lists after FROM), unquoted and without a db/schema prefix,
 * in first-seen order. Comments and string literals are ignored. Used to fetch
 * just the columns the editor's autocomplete needs.
 */
export function referencedTables(sql: string): string[] {
  const text = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
  const ident = String.raw`(?:` + "`[^`]+`" + String.raw`|"[^"]+"|\[[^\]]+\]|[\w$]+)`;
  const qualified = `${ident}(?:\\s*\\.\\s*${ident})*`;
  const rx = new RegExp(
    String.raw`\b(from|join|update|into|table)\s+(` + qualified + String.raw`(?:\s+(?:as\s+)?[\w$]+)?(?:\s*,\s*` + qualified + String.raw`(?:\s+(?:as\s+)?[\w$]+)?)*)`,
    "gi",
  );
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    const list = m[1].toLowerCase() === "from" ? m[2].split(",") : [m[2]];
    for (const item of list) {
      const first = item.trim().match(new RegExp("^" + qualified))?.[0];
      if (!first) continue;
      const parts = first.split(/\s*\.\s*/);
      const name = parts[parts.length - 1].replace(/^[`"[]|[`"\]]$/g, "");
      if (!name || /^(select|lateral|only)$/i.test(name) || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
