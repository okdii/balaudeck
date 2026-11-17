// Schema compare: what DDL makes a TARGET database's tables look like the
// SOURCE's. Built on the designer machinery in ddl.ts — the target table is
// loaded as the "original" designer state, the source's columns/FKs/indexes
// become the "edited" state (matched to the target by name), and the dialect
// ALTER builder emits the difference. Same engine family on both sides.

import {
  buildAlter,
  buildCreate,
  buildDropTable,
  designerFromSchema,
  type DesignerState,
  type ForeignKey,
  type TableIndex,
  type TableSchemaInfo,
} from "./ddl";

export type DiffKind = "create" | "alter" | "drop" | "same";

export interface TableDiff {
  table: string;
  kind: DiffKind;
  statements: string[];
  /** Short human summary: "+2 columns, ~1 column, -1 index". */
  summary: string;
}

const norm = (s: string) => s.trim().toLowerCase();
const idxCols = (x: TableIndex) => x.columns.replace(/\s/g, "").toLowerCase();

/** Pick, for each source item, the target item it corresponds to (each target
 *  item used once): first by name, then by `alt` key (same columns/refs). */
function matchUp<T extends { name: string; orig?: string }>(
  src: T[],
  tgt: T[],
  alt: (x: T) => string,
): (T | undefined)[] {
  const used = new Set<number>();
  const out: (T | undefined)[] = src.map(() => undefined);
  src.forEach((s, i) => {
    if (!s.name.trim()) return;
    const j = tgt.findIndex((t, k) => !used.has(k) && t.name.trim() && norm(t.name) === norm(s.name));
    if (j >= 0) {
      used.add(j);
      out[i] = tgt[j];
    }
  });
  src.forEach((s, i) => {
    if (out[i]) return;
    const j = tgt.findIndex((t, k) => !used.has(k) && alt(t) === alt(s));
    if (j >= 0) {
      used.add(j);
      out[i] = tgt[j];
    }
  });
  return out;
}

/** The designer state "target → source" for a table present on both sides. */
export function diffState(
  db: string,
  table: string,
  source: TableSchemaInfo,
  target: TableSchemaInfo,
): DesignerState {
  const t = designerFromSchema(db, table, target);
  const s = designerFromSchema(db, table, source);

  const byName = new Map(t.original.map((c) => [norm(c.name), c]));
  const columns = s.columns.map((c) => ({ ...c, orig: byName.get(norm(c.name))?.orig }));

  const fkAlt = (f: ForeignKey) => `${norm(f.column)}>${norm(f.refTable)}.${norm(f.refColumn)}`;
  const fkMatch = matchUp(s.fks, t.originalFks, fkAlt);
  // Keep the target's constraint name when matched by shape, so an FK whose
  // only difference is an auto-generated name isn't dropped and re-added.
  const fks = s.fks.map((f, i) => {
    const o = fkMatch[i];
    return o ? { ...f, name: o.name, orig: o.orig } : { ...f, orig: undefined };
  });

  const ixAlt = (x: TableIndex) => `${x.unique ? "u" : "i"}:${idxCols(x)}`;
  const ixMatch = matchUp(s.indexes, t.originalIndexes, ixAlt);
  const indexes = s.indexes.map((x, i) => {
    const o = ixMatch[i];
    if (!o) return { ...x, orig: undefined };
    // Same columns + uniqueness under another name: treat as the same index.
    return ixAlt(o) === ixAlt(x) ? { ...o } : { ...x, orig: o.orig };
  });

  return { ...t, columns, fks, indexes };
}

function plural(n: number, w: string) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

function summarize(d: DesignerState): string {
  const parts: string[] = [];
  const live = new Set(d.columns.map((c) => c.orig).filter(Boolean));
  const added = d.columns.filter((c) => !c.orig).length;
  const dropped = d.original.filter((o) => !live.has(o.orig)).length;
  const byOrig = new Map(d.original.map((c) => [c.orig, c]));
  const changed = d.columns.filter((c) => {
    const o = c.orig ? byOrig.get(c.orig) : undefined;
    return (
      o &&
      (o.type !== c.type || o.length !== c.length || o.nullable !== c.nullable || o.def !== c.def || o.ai !== c.ai || o.pk !== c.pk)
    );
  }).length;
  if (added) parts.push(`+${plural(added, "column")}`);
  if (changed) parts.push(`~${plural(changed, "column")}`);
  if (dropped) parts.push(`−${plural(dropped, "column")}`);
  const liveFk = new Set(d.fks.map((f) => f.orig).filter(Boolean));
  const fkAdd = d.fks.filter((f) => !f.orig).length;
  const fkDrop = d.originalFks.filter((o) => !liveFk.has(o.orig)).length;
  if (fkAdd || fkDrop) parts.push(`FK +${fkAdd}/−${fkDrop}`);
  const liveIx = new Set(d.indexes.map((x) => x.orig).filter(Boolean));
  const ixAdd = d.indexes.filter((x) => !x.orig).length;
  const ixDrop = d.originalIndexes.filter((o) => !liveIx.has(o.orig)).length;
  if (ixAdd || ixDrop) parts.push(`index +${ixAdd}/−${ixDrop}`);
  return parts.join(", ") || "definition changes";
}

export function diffTable(
  engine: string,
  db: string,
  table: string,
  source: TableSchemaInfo | null,
  target: TableSchemaInfo | null,
): TableDiff {
  if (source && !target) {
    const d = designerFromSchema(db, table, source);
    return {
      table,
      kind: "create",
      statements: buildCreate(engine, { ...d, isNew: true }),
      summary: `new table, ${plural(d.columns.length, "column")}`,
    };
  }
  if (!source && target) {
    return { table, kind: "drop", statements: [buildDropTable(engine, db, table)], summary: "only in target" };
  }
  if (!source || !target) return { table, kind: "same", statements: [], summary: "" };
  const d = diffState(db, table, source, target);
  const statements = buildAlter(engine, d);
  if (!statements.length) return { table, kind: "same", statements: [], summary: "identical" };
  return { table, kind: "alter", statements, summary: summarize(d) };
}

/** Order the chosen diffs so they apply cleanly: new tables first (parents
 *  before the tables whose FKs point at them), then alters, then drops. */
export function orderDiffs(diffs: TableDiff[], sourceSchemas: Map<string, TableSchemaInfo>): TableDiff[] {
  const creates = diffs.filter((d) => d.kind === "create");
  const names = new Set(creates.map((d) => d.table));
  const done = new Set<string>();
  const ordered: TableDiff[] = [];
  const visit = (d: TableDiff, stack: Set<string>) => {
    if (done.has(d.table) || stack.has(d.table)) return;
    stack.add(d.table);
    for (const fk of sourceSchemas.get(d.table)?.foreignKeys ?? []) {
      const parent = creates.find((c) => c.table === fk.refTable);
      if (parent && names.has(fk.refTable) && parent !== d) visit(parent, stack);
    }
    stack.delete(d.table);
    done.add(d.table);
    ordered.push(d);
  };
  creates.forEach((d) => visit(d, new Set()));
  return [...ordered, ...diffs.filter((d) => d.kind === "alter"), ...diffs.filter((d) => d.kind === "drop")];
}

export function diffScript(diffs: TableDiff[]): string {
  return diffs
    .flatMap((d) => [`-- ${d.table}: ${d.kind === "create" ? "create" : d.kind === "drop" ? "drop" : d.summary}`, ...d.statements.map((s) => s.replace(/;\s*$/, "") + ";")])
    .join("\n");
}
