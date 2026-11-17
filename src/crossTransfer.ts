// Cross-engine Data Transfer plan (e.g. MySQL → PostgreSQL). The backend
// (`db_transfer_cross`) only moves rows; everything dialect-specific about the
// SCHEMA is decided here, with the same DDL generator the table designer uses:
// each source table is introspected, folded to portable types, and re-created
// in the target dialect. Foreign keys are added after the data (so load order
// doesn't matter), then identity sequences are moved past the copied ids.

import { api, type DbConnParams } from "./api";
import {
  buildCreate,
  designerFromSchema,
  fkClause,
  qualified,
  quoteIdent,
  type DesignColumn,
  type DesignerState,
  type TableSchemaInfo,
} from "./ddl";

export type XKind = "int" | "num" | "bool" | "text" | "blob" | "datetime" | "date" | "time";

export interface XTable {
  table: string;
  create: string[];
  data: boolean;
  columns: { name: string; kind: XKind }[];
  orderBy: string[];
  identity: boolean;
}

export interface CrossPlan {
  tables: XTable[];
  post: string[];
  /** Notes about lossy conversions, shown before the run. */
  notes: string[];
}

const isMy = (e: string) => e === "mysql" || e === "mariadb";

/** Fold any native type the designer vocabulary doesn't know to a portable one. */
function portable(type: string, length: string): { type: string; length: string } {
  const t = type.trim().toUpperCase();
  const base = t.split(/[\s(]/)[0];
  const same = { type: base, length };
  switch (base) {
    case "INT":
    case "BIGINT":
    case "SMALLINT":
    case "TINYINT":
    case "VARCHAR":
    case "CHAR":
    case "TEXT":
    case "DECIMAL":
    case "DOUBLE":
    case "FLOAT":
    case "BOOLEAN":
    case "JSON":
    case "BLOB":
    case "DATE":
    case "TIME":
    case "DATETIME":
      return same;
    case "MEDIUMINT":
    case "INTEGER":
    case "SERIAL":
      return { type: "INT", length: "" };
    case "BIGSERIAL":
      return { type: "BIGINT", length: "" };
    case "SMALLSERIAL":
    case "YEAR":
      return { type: "SMALLINT", length: "" };
    case "NUMERIC":
    case "MONEY":
    case "SMALLMONEY":
      return { type: "DECIMAL", length };
    case "REAL":
      return { type: "FLOAT", length: "" };
    case "TINYTEXT":
    case "MEDIUMTEXT":
    case "LONGTEXT":
    case "NTEXT":
    case "CLOB":
    case "XML":
      return { type: "TEXT", length: "" };
    case "TINYBLOB":
    case "MEDIUMBLOB":
    case "LONGBLOB":
    case "BINARY":
    case "VARBINARY":
    case "BYTEA":
    case "IMAGE":
      return { type: "BLOB", length: "" };
    case "ENUM":
    case "SET":
      return { type: "VARCHAR", length: "255" };
    case "UUID":
    case "UNIQUEIDENTIFIER":
      return { type: "VARCHAR", length: "36" };
    case "TIMESTAMP":
    case "TIMESTAMPTZ":
    case "DATETIME2":
    case "DATETIMEOFFSET":
    case "SMALLDATETIME":
      return { type: "DATETIME", length: "" };
    case "JSONB":
      return { type: "JSON", length: "" };
    default:
      return { type: "TEXT", length: "" };
  }
}

export function kindOf(type: string): XKind {
  switch (type) {
    case "INT":
    case "BIGINT":
    case "SMALLINT":
    case "TINYINT":
      return "int";
    case "DECIMAL":
    case "DOUBLE":
    case "FLOAT":
      return "num";
    case "BOOLEAN":
      return "bool";
    case "BLOB":
      return "blob";
    case "DATETIME":
      return "datetime";
    case "DATE":
      return "date";
    case "TIME":
      return "time";
    default:
      return "text";
  }
}

/** Keep only defaults every dialect understands (literals, NULL, now). */
function portableDefault(target: string, c: DesignColumn): string {
  const d = c.def.trim();
  if (!d) return "";
  const up = d.toUpperCase();
  if (up === "NULL") return "";
  if (up === "CURRENT_TIMESTAMP" || up === "NOW()" || up === "GETDATE()" || up === "CURRENT_TIMESTAMP()") {
    return c.type === "DATETIME" ? "CURRENT_TIMESTAMP" : "";
  }
  if (c.type === "BOOLEAN") {
    const on = ["1", "TRUE", "T", "B'1'"].includes(up);
    const off = ["0", "FALSE", "F", "B'0'"].includes(up);
    if (!on && !off) return "";
    return target === "postgres" ? (on ? "TRUE" : "FALSE") : on ? "1" : "0";
  }
  if (d.includes("(") || d.startsWith("0000-00-00")) return ""; // nextval(), uuid(), expressions
  if ((c.type === "INT" || c.type === "BIGINT" || c.type === "SMALLINT" || c.type === "TINYINT" || c.type === "DECIMAL") && !/^-?\d+(\.\d+)?$/.test(d)) {
    return "";
  }
  return d;
}

/** Adapt one table's designer state so it is valid DDL in `target`. */
function adapt(target: string, d: DesignerState, notes: string[]) {
  const keyed = new Set<string>();
  for (const c of d.columns) if (c.pk) keyed.add(c.name);
  for (const x of d.indexes) x.columns.split(",").forEach((n) => keyed.add(n.trim()));
  for (const f of d.fks) keyed.add(f.column);

  d.columns = d.columns.map((c0) => {
    const c = { ...c0, ...portable(c0.type, c0.length) };
    const strict = isMy(target) || target === "mssql";
    if (strict && (c.type === "VARCHAR" || c.type === "CHAR") && !c.length) {
      if (c.type === "CHAR") c.length = "1";
      else if (keyed.has(c.name)) c.length = "255";
      else c.type = "TEXT";
    }
    // MySQL/SQL Server can't index unbounded text.
    if (strict && (c.type === "TEXT" || c.type === "JSON") && keyed.has(c.name)) {
      c.type = "VARCHAR";
      c.length = "255";
      notes.push(`${d.table}.${c.name}: indexed text column created as VARCHAR(255).`);
    }
    if (strict && c.type === "DECIMAL" && !c.length) c.length = "38,10";
    if (target === "postgres" && c.type === "TINYINT" && c.length === "1") c.type = "SMALLINT";
    c.def = portableDefault(target, c);
    return c;
  });
  // Index names are per-table in MySQL/SQL Server but per-schema in pg/SQLite.
  if (target === "postgres" || target === "sqlite") {
    d.indexes = d.indexes.map((x) =>
      x.name && !x.name.toLowerCase().includes(d.table.toLowerCase()) ? { ...x, name: `${d.table}_${x.name}` } : x,
    );
  }
  if (target === "mssql") {
    d.fks = d.fks.map((f) => ({
      ...f,
      onDelete: f.onDelete.toUpperCase() === "RESTRICT" ? "NO ACTION" : f.onDelete,
      onUpdate: f.onUpdate.toUpperCase() === "RESTRICT" ? "NO ACTION" : f.onUpdate,
    }));
  }
}

function dropIfExists(target: string, db: string, table: string): string {
  const t = qualified(target, db, table);
  return target === "postgres" ? `DROP TABLE IF EXISTS ${t} CASCADE` : `DROP TABLE IF EXISTS ${t}`;
}

/** Parents before children (by FK), so SQLite's inline FKs load cleanly. */
function topo(names: string[], schemas: Map<string, TableSchemaInfo>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const set = new Set(names);
  const visit = (n: string, stack: Set<string>) => {
    if (seen.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const f of schemas.get(n)?.foreignKeys ?? []) if (set.has(f.refTable) && f.refTable !== n) visit(f.refTable, stack);
    stack.delete(n);
    seen.add(n);
    out.push(n);
  };
  names.forEach((n) => visit(n, new Set()));
  return out;
}

export async function buildCrossPlan(
  source: DbConnParams,
  sourceDb: string,
  target: string,
  targetDb: string,
  selection: { table: string; structure: boolean; data: boolean }[],
  onProgress?: (done: number, total: number) => void,
): Promise<CrossPlan> {
  const schemas = new Map<string, TableSchemaInfo>();
  let done = 0;
  for (const s of selection) {
    schemas.set(s.table, await api.dbTableSchema(source, sourceDb, s.table));
    onProgress?.(++done, selection.length);
  }
  return planFromSchemas(target, targetDb, selection, schemas);
}

/** The plan from already-introspected source schemas (pure; unit-testable). */
export function planFromSchemas(
  target: string,
  targetDb: string,
  selection: { table: string; structure: boolean; data: boolean }[],
  schemas: Map<string, TableSchemaInfo>,
): CrossPlan {
  const notes: string[] = [];
  const tables: XTable[] = [];
  const post: string[] = [];
  const pre: string[] = isMy(target) ? ["SET FOREIGN_KEY_CHECKS = 0"] : [];

  for (const name of topo(selection.map((s) => s.table), schemas)) {
    const sel = selection.find((s) => s.table === name)!;
    const d = designerFromSchema(targetDb, name, schemas.get(name)!);
    adapt(target, d, notes);
    const fks = d.fks;
    const create = sel.structure
      ? [...pre, dropIfExists(target, targetDb, name), ...buildCreate(target, { ...d, isNew: true, fks: target === "sqlite" ? fks : [] })]
      : [];
    if (sel.structure && target !== "sqlite") {
      for (const f of fks) post.push(`ALTER TABLE ${qualified(target, targetDb, name)} ADD ${fkClause(target, f)}`);
    }
    const ai = d.columns.find((c) => c.ai);
    if (sel.data && ai && target === "postgres") {
      const t = quoteIdent(target, name);
      const c = quoteIdent(target, ai.name);
      post.push(
        `SELECT setval(pg_get_serial_sequence('${t.replace(/'/g, "''")}', '${ai.name.replace(/'/g, "''")}'), COALESCE((SELECT MAX(${c}) FROM ${t}), 0) + 1, false)`,
      );
    }
    tables.push({
      table: name,
      create,
      data: sel.data,
      columns: d.columns.map((c) => ({ name: c.name, kind: kindOf(c.type) })),
      orderBy: d.columns.filter((c) => c.pk).map((c) => c.name),
      identity: target === "mssql" && !!ai,
    });
  }
  return { tables, post, notes };
}
