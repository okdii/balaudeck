// Dialect-aware DDL generation for the visual table designer.
//
// One DesignerState (columns / FKs / indexes, each with an `original` snapshot)
// becomes a list of statements to run in ONE transaction, per engine. Generation
// lives in the frontend so the designer can show a live SQL preview; the actual
// run goes through the backend `db_exec_ddl` command (which wraps the list in a
// transaction — and, for SQLite, toggles foreign_keys off around a table
// rebuild). MySQL/MariaDB keep their original single-`ALTER` shape; PostgreSQL,
// SQL Server, and SQLite each get native dialect output.

export type SqlEngine = "mysql" | "mariadb" | "postgres" | "mssql" | "sqlite";

export interface DesignColumn {
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  def: string;
  pk: boolean;
  ai: boolean;
  orig?: string;
}
export interface ForeignKey {
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
  onUpdate: string;
  orig?: string;
}
export interface TableIndex {
  name: string;
  columns: string;
  unique: boolean;
  orig?: string;
}
export interface DesignerState {
  db: string;
  table: string;
  isNew: boolean;
  columns: DesignColumn[];
  original: DesignColumn[];
  fks: ForeignKey[];
  originalFks: ForeignKey[];
  indexes: TableIndex[];
  originalIndexes: TableIndex[];
}

function eng(engine: string): SqlEngine {
  switch (engine) {
    case "mariadb":
      return "mariadb";
    case "postgres":
      return "postgres";
    case "mssql":
      return "mssql";
    case "sqlite":
      return "sqlite";
    default:
      return "mysql";
  }
}
export function isMysqlFamily(engine: string): boolean {
  const e = eng(engine);
  return e === "mysql" || e === "mariadb";
}

/** Quote an identifier for `engine`: `` `x` `` (MySQL), `"x"` (pg/sqlite),
 *  `[x]` (MSSQL), with the dialect's own escaping. */
export function quoteIdent(engine: string, name: string): string {
  const e = eng(engine);
  const n = name.trim();
  if (e === "mysql" || e === "mariadb") {
    return "`" + n.replace(/`/g, "``") + "`";
  }
  if (e === "mssql") {
    return "[" + n.replace(/]/g, "]]") + "]";
  }
  // postgres, sqlite
  return '"' + n.replace(/"/g, '""') + '"';
}

/** How the active engine references a table in SQL. MySQL/MariaDB and SQL Server
 *  qualify as `db`.`table`; PostgreSQL resolves via search_path and SQLite is a
 *  single-file database, so both use the bare table name. Mirrors the browse
 *  logic in DbPanel.tableSelectSql — for Postgres `db.table` would be read as
 *  SCHEMA.table (a different, usually non-existent object). */
export function qualified(engine: string, db: string, table: string): string {
  const e = eng(engine);
  if (e === "postgres" || e === "sqlite") return quoteIdent(engine, table);
  return `${quoteIdent(engine, db)}.${quoteIdent(engine, table)}`;
}

/** Map a designer type (MySQL-flavoured, e.g. "BIGINT UNSIGNED" + length) to the
 *  target dialect's column type. UNSIGNED and MySQL-only widths are folded to the
 *  nearest native type; length is kept only where the dialect uses it. */
export function mapType(engine: string, type: string, length: string): string {
  const e = eng(engine);
  const raw = type.trim().toUpperCase();
  const base = raw.split(/\s+/)[0] ?? raw;
  const len = length.trim();
  const withLen = (t: string) => (len ? `${t}(${len})` : t);
  if (e === "mysql" || e === "mariadb") {
    // Recombine base + length, placing (len) right after the base keyword so
    // attributes like UNSIGNED stay trailing (mirrors the old typeSql()).
    if (!len) return type.trim();
    const sp = type.trim().indexOf(" ");
    return sp === -1
      ? `${type.trim()}(${len})`
      : `${type.trim().slice(0, sp)}(${len})${type.trim().slice(sp)}`;
  }

  if (e === "postgres") {
    switch (base) {
      case "INT":
      case "INTEGER":
        return "integer";
      case "BIGINT":
        return "bigint";
      case "TINYINT":
      case "SMALLINT":
        return "smallint";
      case "VARCHAR":
        return withLen("varchar");
      case "CHAR":
        return withLen("char");
      case "TEXT":
      case "MEDIUMTEXT":
      case "LONGTEXT":
      case "ENUM":
        return "text";
      case "DATETIME":
      case "TIMESTAMP":
        return "timestamp";
      case "DATE":
        return "date";
      case "TIME":
        return "time";
      case "DECIMAL":
      case "NUMERIC":
        return withLen("numeric");
      case "DOUBLE":
        return "double precision";
      case "FLOAT":
        return "real";
      case "BOOLEAN":
      case "BOOL":
        return "boolean";
      case "JSON":
        return "jsonb";
      case "BLOB":
        return "bytea";
      default:
        return len ? withLen(base.toLowerCase()) : base.toLowerCase();
    }
  }

  if (e === "mssql") {
    switch (base) {
      case "INT":
      case "INTEGER":
        return "int";
      case "BIGINT":
        return "bigint";
      case "TINYINT":
        return "tinyint";
      case "SMALLINT":
        return "smallint";
      case "VARCHAR":
        return withLen("nvarchar");
      case "CHAR":
        return withLen("nchar");
      case "TEXT":
      case "MEDIUMTEXT":
      case "LONGTEXT":
      case "JSON":
        return "nvarchar(max)";
      case "ENUM":
        return "nvarchar(255)";
      case "DATETIME":
      case "TIMESTAMP":
        return "datetime2";
      case "DATE":
        return "date";
      case "TIME":
        return "time";
      case "DECIMAL":
      case "NUMERIC":
        return withLen("decimal");
      case "DOUBLE":
        return "float";
      case "FLOAT":
        return "real";
      case "BOOLEAN":
      case "BOOL":
        return "bit";
      case "BLOB":
        return "varbinary(max)";
      default:
        return len ? withLen(base.toLowerCase()) : base.toLowerCase();
    }
  }

  // sqlite — type affinity, no lengths.
  switch (base) {
    case "INT":
    case "INTEGER":
    case "BIGINT":
    case "TINYINT":
    case "SMALLINT":
    case "BOOLEAN":
    case "BOOL":
      return "INTEGER";
    case "DECIMAL":
    case "NUMERIC":
      return "NUMERIC";
    case "DOUBLE":
    case "FLOAT":
      return "REAL";
    case "BLOB":
      return "BLOB";
    default:
      return "TEXT"; // varchar/char/text/date/time/datetime/json/enum
  }
}

/** Render a column default as a SQL literal for `engine`. Bare NULL / numbers and
 *  CURRENT_TIMESTAMP pass through (mapped to the dialect's now()); everything
 *  else is a quoted string. */
export function quoteDefault(engine: string, def: string): string {
  const d = def.trim();
  if (d === "") return "";
  const up = d.toUpperCase();
  if (up === "CURRENT_TIMESTAMP" || up === "NOW()") {
    if (eng(engine) === "mssql") return "GETDATE()";
    return "CURRENT_TIMESTAMP";
  }
  if (up === "NULL" || /^-?\d+(\.\d+)?$/.test(d)) return d;
  if (eng(engine) === "postgres" && (up === "TRUE" || up === "FALSE")) return up;
  // A bare function call default (GETDATE(), uuid_generate_v4(), ...) is an
  // expression, not a string literal — emit it unquoted.
  if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(d)) return d;
  return `'${d.replace(/'/g, "''")}'`;
}

// ---- Reverse mapping: an existing table's native schema -> DesignerState -----

/** The backend `db_table_schema` shape (camelCase to match ColumnInfo etc.). */
export interface TableSchemaInfo {
  columns: {
    name: string;
    dataType: string;
    length: string;
    nullable: boolean;
    default: string;
    pk: boolean;
    autoIncrement: boolean;
  }[];
  foreignKeys: {
    name: string;
    column: string;
    refTable: string;
    refColumn: string;
    onDelete: string;
    onUpdate: string;
  }[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
}

/** Map a dialect's native column type back to the designer's canonical type
 *  vocabulary (COMMON_TYPES), so an edited column re-generates sane DDL and the
 *  change-diff is stable. Unknown types pass through uppercased. */
export function parseNativeType(dataType: string, length: string): { type: string; length: string } {
  const raw = (dataType || "").trim().toLowerCase();
  const len = (length || "").trim();
  const T = (type: string, keepLen = false) => ({ type, length: keepLen ? len : "" });
  switch (raw) {
    case "int":
    case "int4":
    case "integer":
      return T("INT");
    case "int8":
    case "bigint":
      return T("BIGINT");
    case "int2":
    case "smallint":
      return T("SMALLINT");
    case "tinyint":
      return T("TINYINT");
    case "character varying":
    case "varchar":
    case "nvarchar":
      return T("VARCHAR", true);
    case "character":
    case "char":
    case "nchar":
    case "bpchar":
      return T("CHAR", true);
    case "text":
    case "ntext":
    case "mediumtext":
    case "longtext":
    case "clob":
      return T("TEXT");
    case "numeric":
    case "decimal":
    case "money":
      return T("DECIMAL", true);
    case "double precision":
    case "double":
    case "float8":
    case "float":
      return T("DOUBLE");
    case "real":
    case "float4":
      return T("FLOAT");
    case "boolean":
    case "bool":
    case "bit":
      return T("BOOLEAN");
    case "json":
    case "jsonb":
      return T("JSON");
    case "bytea":
    case "blob":
    case "varbinary":
    case "binary":
    case "image":
      return T("BLOB");
    case "date":
      return T("DATE");
    case "time":
    case "time without time zone":
      return T("TIME");
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "timestamp":
    case "timestamp without time zone":
    case "timestamp with time zone":
    case "timestamptz":
      return T("DATETIME");
    default:
      return { type: dataType.trim().toUpperCase(), length: len };
  }
}

/** Strip a dialect default down to the value the designer edits: drop pg `::type`
 *  casts and one layer of wrapping quotes; keep numbers, NULL, and expressions. */
export function normalizeDefault(raw: string): string {
  let d = (raw || "").trim();
  if (!d) return "";
  d = d.replace(/::[A-Za-z0-9_ ."\[\]]+$/, "").trim();
  const up = d.toUpperCase();
  if (
    up === "NULL" ||
    up === "CURRENT_TIMESTAMP" ||
    up === "TRUE" ||
    up === "FALSE" ||
    /^-?\d+(\.\d+)?$/.test(d) ||
    /^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(d)
  ) {
    return d;
  }
  if (d.length >= 2 && d.startsWith("'") && d.endsWith("'")) {
    d = d.slice(1, -1).replace(/''/g, "'");
  }
  return d;
}

/** Build a designer state for an existing table from its introspected schema.
 *  FK `orig` uses the constraint name where available (pg/mssql), else a stable
 *  synthetic key (SQLite FKs are unnamed) so the change-diff doesn't see every
 *  FK as new. */
export function designerFromSchema(
  db: string,
  table: string,
  schema: TableSchemaInfo,
): DesignerState {
  const columns: DesignColumn[] = schema.columns.map((c) => {
    const { type, length } = parseNativeType(c.dataType, c.length);
    return {
      name: c.name,
      type,
      length,
      nullable: c.nullable,
      def: normalizeDefault(c.default),
      pk: c.pk,
      ai: c.autoIncrement,
      orig: c.name,
    };
  });
  const fks: ForeignKey[] = schema.foreignKeys.map((f) => ({
    name: f.name,
    column: f.column,
    refTable: f.refTable,
    refColumn: f.refColumn,
    onDelete: f.onDelete,
    onUpdate: f.onUpdate,
    orig: f.name || `${f.column}:${f.refTable}:${f.refColumn}`,
  }));
  const indexes: TableIndex[] = schema.indexes.map((x) => ({
    name: x.name,
    columns: x.columns.join(", "),
    unique: x.unique,
    orig: x.name,
  }));
  return {
    db,
    table,
    isNew: false,
    columns,
    original: columns.map((c) => ({ ...c })),
    fks,
    originalFks: fks.map((f) => ({ ...f })),
    indexes,
    originalIndexes: indexes.map((x) => ({ ...x })),
  };
}

/** True when this column is SQLite's special single-column auto-increment PK
 *  (`INTEGER PRIMARY KEY AUTOINCREMENT`), which must be written inline and
 *  excludes a table-level PRIMARY KEY clause. */
function sqliteRowidPk(engine: string, d: DesignerState, c: DesignColumn): boolean {
  if (eng(engine) !== "sqlite" || !c.ai || !c.pk) return false;
  return d.columns.filter((x) => x.pk && x.name.trim()).length === 1;
}

/** A single column definition line (no leading comma). */
export function columnDef(engine: string, d: DesignerState, c: DesignColumn): string {
  const e = eng(engine);
  const id = quoteIdent(engine, c.name);
  if (sqliteRowidPk(engine, d, c)) {
    // rowid alias: type MUST be INTEGER, PK + AUTOINCREMENT inline.
    return `${id} INTEGER PRIMARY KEY AUTOINCREMENT`;
  }
  let s = `${id} ${mapType(engine, c.type, c.length)}`;
  if (e === "postgres" && c.ai) {
    s += " GENERATED BY DEFAULT AS IDENTITY";
  } else if (e === "mssql" && c.ai) {
    s += " IDENTITY(1,1)";
  }
  s += c.nullable ? " NULL" : " NOT NULL";
  if (c.def.trim() !== "") {
    const dv = quoteDefault(engine, c.def);
    if (dv) s += ` DEFAULT ${dv}`;
  }
  if ((e === "mysql" || e === "mariadb") && c.ai) {
    s += " AUTO_INCREMENT";
  }
  return s;
}

export function fkValid(f: ForeignKey): boolean {
  return !!(f.column.trim() && f.refTable.trim() && f.refColumn.trim());
}

/** `[CONSTRAINT name] FOREIGN KEY (col) REFERENCES reftable (refcol) [ON ...]`.
 *  Standard SQL — the same across all four dialects. */
export function fkClause(engine: string, f: ForeignKey): string {
  let s = f.name.trim() ? `CONSTRAINT ${quoteIdent(engine, f.name)} ` : "";
  s += `FOREIGN KEY (${quoteIdent(engine, f.column)}) REFERENCES ${quoteIdent(
    engine,
    f.refTable,
  )} (${quoteIdent(engine, f.refColumn)})`;
  if (f.onDelete) s += ` ON DELETE ${f.onDelete}`;
  if (f.onUpdate) s += ` ON UPDATE ${f.onUpdate}`;
  return s;
}

export function idxColList(engine: string, x: TableIndex): string {
  return x.columns
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => quoteIdent(engine, c))
    .join(", ");
}
export function idxValid(x: TableIndex): boolean {
  return !!idxColList("mysql", x);
}

/** A default index name when the designer left it blank (pg/mssql/sqlite need a
 *  name on `CREATE INDEX`; MySQL can omit it in inline `KEY`). */
function idxName(table: string, x: TableIndex, i: number): string {
  const n = x.name.trim();
  if (n) return n;
  const cols = x.columns
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .join("_");
  return `idx_${table}_${cols || i}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/** A standalone `CREATE [UNIQUE] INDEX` statement (pg/mssql/sqlite). */
export function createIndexStmt(engine: string, db: string, table: string, x: TableIndex, i: number): string {
  const unique = x.unique ? "UNIQUE " : "";
  const name = quoteIdent(engine, idxName(table, x, i));
  return `CREATE ${unique}INDEX ${name} ON ${qualified(engine, db, table)} (${idxColList(engine, x)})`;
}

// ---- CREATE TABLE ------------------------------------------------------------

/** Statements to create the designed table. MySQL emits inline `KEY` indexes in
 *  one statement; pg/mssql/sqlite emit the table then separate `CREATE INDEX`s. */
export function buildCreate(engine: string, d: DesignerState): string[] {
  const e = eng(engine);
  const cols = d.columns.filter((c) => c.name.trim());
  const lines = cols.map((c) => columnDef(engine, d, c));

  // Table-level PK, unless SQLite already wrote it inline on the rowid column.
  const inlinePk = cols.some((c) => sqliteRowidPk(engine, d, c));
  if (!inlinePk) {
    const pk = cols.filter((c) => c.pk).map((c) => quoteIdent(engine, c.name));
    if (pk.length) lines.push(`PRIMARY KEY (${pk.join(", ")})`);
  }

  for (const f of d.fks.filter(fkValid)) lines.push(fkClause(engine, f));

  const validIdx = d.indexes.filter(idxValid);
  if (e === "mysql" || e === "mariadb") {
    for (const x of validIdx) {
      const nm = x.name.trim() ? `${quoteIdent(engine, x.name)} ` : "";
      lines.push(`${x.unique ? "UNIQUE " : ""}KEY ${nm}(${idxColList(engine, x)})`);
    }
  }

  const table = qualified(engine, d.db, d.table.trim());
  const stmts = [`CREATE TABLE ${table} (\n  ${lines.join(",\n  ")}\n)`];

  if (e !== "mysql" && e !== "mariadb") {
    validIdx.forEach((x, i) => stmts.push(createIndexStmt(engine, d.db, d.table.trim(), x, i)));
  }
  return stmts;
}

// ---- ALTER TABLE (edit an existing table) -----------------------------------

function colChanged(o: DesignColumn, c: DesignColumn): boolean {
  return (
    o.name !== c.name ||
    o.type !== c.type ||
    o.length !== c.length ||
    o.nullable !== c.nullable ||
    o.def !== c.def ||
    o.ai !== c.ai
  );
}
export function fkChanged(f: ForeignKey, o?: ForeignKey): boolean {
  return (
    !o ||
    f.column !== o.column ||
    f.refTable !== o.refTable ||
    f.refColumn !== o.refColumn ||
    f.onDelete !== o.onDelete ||
    f.onUpdate !== o.onUpdate
  );
}
export function idxChanged(x: TableIndex, o?: TableIndex): boolean {
  const norm = (s: string) => s.replace(/\s/g, "");
  return !o || norm(x.columns) !== norm(o.columns) || x.unique !== o.unique || x.name !== o.name;
}

/** Statements to apply the designer's edits to an existing table. pg/mssql emit
 *  per-attribute ALTERs; SQLite rebuilds the table (the only portable way to
 *  change a column type, nullability, PK, or drop a column on old SQLite). */
export function buildAlter(engine: string, d: DesignerState): string[] {
  const e = eng(engine);
  if (e === "sqlite") return buildAlterSqlite(engine, d);
  if (e === "mssql") return buildAlterMssql(engine, d);
  return buildAlterPg(engine, d); // postgres
}

function buildAlterPg(engine: string, d: DesignerState): string[] {
  const qi = (n: string) => quoteIdent(engine, n);
  const t = qualified(engine, d.db, d.table);
  const s: string[] = [];

  const liveOrigs = new Set(d.columns.filter((c) => c.orig).map((c) => c.orig));
  for (const o of d.original) {
    if (o.orig && !liveOrigs.has(o.orig)) s.push(`ALTER TABLE ${t} DROP COLUMN ${qi(o.orig)}`);
  }
  for (const c of d.columns) {
    if (!c.name.trim()) continue;
    if (!c.orig) {
      s.push(`ALTER TABLE ${t} ADD COLUMN ${columnDef(engine, d, c)}`);
      continue;
    }
    const o = d.original.find((x) => x.orig === c.orig);
    if (!o || !colChanged(o, c)) continue;
    if (o.name !== c.name) s.push(`ALTER TABLE ${t} RENAME COLUMN ${qi(c.orig)} TO ${qi(c.name)}`);
    const col = qi(c.name);
    if (o.type !== c.type || o.length !== c.length) {
      const ty = mapType(engine, c.type, c.length);
      s.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${ty} USING ${col}::${ty}`);
    }
    if (o.nullable !== c.nullable) {
      s.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${c.nullable ? "DROP" : "SET"} NOT NULL`);
    }
    if (o.def !== c.def) {
      const dv = quoteDefault(engine, c.def);
      s.push(dv ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${dv}` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`);
    }
  }

  const newPk = d.columns.filter((c) => c.pk).map((c) => qi(c.name)).join(", ");
  const oldPk = d.original.filter((c) => c.pk).map((c) => qi(c.name)).join(", ");
  if (newPk !== oldPk) {
    if (oldPk) s.push(`ALTER TABLE ${t} DROP CONSTRAINT IF EXISTS ${qi(d.table + "_pkey")}`);
    if (newPk) s.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${newPk})`);
  }

  const liveFk = new Set(d.fks.filter((f) => f.orig).map((f) => f.orig));
  for (const o of d.originalFks) {
    if (o.orig && !liveFk.has(o.orig)) s.push(`ALTER TABLE ${t} DROP CONSTRAINT ${qi(o.orig)}`);
  }
  for (const f of d.fks) {
    if (!fkValid(f)) continue;
    if (!f.orig) s.push(`ALTER TABLE ${t} ADD ${fkClause(engine, f)}`);
    else if (fkChanged(f, d.originalFks.find((x) => x.orig === f.orig))) {
      s.push(`ALTER TABLE ${t} DROP CONSTRAINT ${qi(f.orig)}`);
      s.push(`ALTER TABLE ${t} ADD ${fkClause(engine, f)}`);
    }
  }

  const liveIdx = new Set(d.indexes.filter((x) => x.orig).map((x) => x.orig));
  for (const o of d.originalIndexes) {
    if (o.orig && !liveIdx.has(o.orig)) s.push(`DROP INDEX ${qi(o.orig)}`);
  }
  d.indexes.forEach((x, i) => {
    if (!idxValid(x)) return;
    if (!x.orig) s.push(createIndexStmt(engine, d.db, d.table, x, i));
    else if (idxChanged(x, d.originalIndexes.find((o) => o.orig === x.orig))) {
      s.push(`DROP INDEX ${qi(x.orig)}`);
      s.push(createIndexStmt(engine, d.db, d.table, x, i));
    }
  });
  return s;
}

function buildAlterMssql(engine: string, d: DesignerState): string[] {
  const qi = (n: string) => quoteIdent(engine, n);
  const t = qualified(engine, d.db, d.table);
  const s: string[] = [];

  const liveOrigs = new Set(d.columns.filter((c) => c.orig).map((c) => c.orig));
  for (const o of d.original) {
    if (o.orig && !liveOrigs.has(o.orig)) s.push(`ALTER TABLE ${t} DROP COLUMN ${qi(o.orig)}`);
  }
  for (const c of d.columns) {
    if (!c.name.trim()) continue;
    if (!c.orig) {
      s.push(`ALTER TABLE ${t} ADD ${columnDef(engine, d, c)}`);
      continue;
    }
    const o = d.original.find((x) => x.orig === c.orig);
    if (!o || !colChanged(o, c)) continue;
    // sp_rename first, so later statements use the new name.
    if (o.name !== c.name) s.push(`EXEC sp_rename '${d.table}.${c.orig}', '${c.name}', 'COLUMN'`);
    if (o.type !== c.type || o.length !== c.length || o.nullable !== c.nullable) {
      s.push(`ALTER TABLE ${t} ALTER COLUMN ${qi(c.name)} ${mapType(engine, c.type, c.length)} ${c.nullable ? "NULL" : "NOT NULL"}`);
    }
    if (o.def !== c.def) {
      const dv = quoteDefault(engine, c.def);
      if (dv) s.push(`ALTER TABLE ${t} ADD DEFAULT ${dv} FOR ${qi(c.name)}`);
    }
  }

  const newPk = d.columns.filter((c) => c.pk).map((c) => qi(c.name)).join(", ");
  const oldPk = d.original.filter((c) => c.pk).map((c) => qi(c.name)).join(", ");
  if (newPk !== oldPk && newPk) s.push(`ALTER TABLE ${t} ADD PRIMARY KEY (${newPk})`);

  const liveFk = new Set(d.fks.filter((f) => f.orig).map((f) => f.orig));
  for (const o of d.originalFks) {
    if (o.orig && !liveFk.has(o.orig)) s.push(`ALTER TABLE ${t} DROP CONSTRAINT ${qi(o.orig)}`);
  }
  for (const f of d.fks) {
    if (!fkValid(f)) continue;
    if (!f.orig) s.push(`ALTER TABLE ${t} ADD ${fkClause(engine, f)}`);
    else if (fkChanged(f, d.originalFks.find((x) => x.orig === f.orig))) {
      s.push(`ALTER TABLE ${t} DROP CONSTRAINT ${qi(f.orig)}`);
      s.push(`ALTER TABLE ${t} ADD ${fkClause(engine, f)}`);
    }
  }

  const liveIdx = new Set(d.indexes.filter((x) => x.orig).map((x) => x.orig));
  for (const o of d.originalIndexes) {
    if (o.orig && !liveIdx.has(o.orig)) s.push(`DROP INDEX ${qi(o.orig)} ON ${t}`);
  }
  d.indexes.forEach((x, i) => {
    if (!idxValid(x)) return;
    if (!x.orig) s.push(createIndexStmt(engine, d.db, d.table, x, i));
    else if (idxChanged(x, d.originalIndexes.find((o) => o.orig === x.orig))) {
      s.push(`DROP INDEX ${qi(x.orig)} ON ${t}`);
      s.push(createIndexStmt(engine, d.db, d.table, x, i));
    }
  });
  return s;
}

/** Does the designer differ from the loaded original at all? Gates the SQLite
 *  rebuild (and lets Save report "no changes"). */
function designerHasChanges(d: DesignerState): boolean {
  const liveOrigs = new Set(d.columns.filter((c) => c.orig).map((c) => c.orig));
  if (d.original.some((o) => o.orig && !liveOrigs.has(o.orig))) return true; // dropped col
  for (const c of d.columns) {
    if (!c.name.trim()) continue;
    if (!c.orig) return true; // added col
    const o = d.original.find((x) => x.orig === c.orig);
    if (!o || colChanged(o, c)) return true;
  }
  const liveFk = new Set(d.fks.filter((f) => f.orig).map((f) => f.orig));
  if (d.originalFks.some((o) => o.orig && !liveFk.has(o.orig))) return true;
  if (d.fks.some((f) => fkValid(f) && (!f.orig || fkChanged(f, d.originalFks.find((x) => x.orig === f.orig))))) return true;
  const liveIdx = new Set(d.indexes.filter((x) => x.orig).map((x) => x.orig));
  if (d.originalIndexes.some((o) => o.orig && !liveIdx.has(o.orig))) return true;
  if (d.indexes.some((x) => idxValid(x) && (!x.orig || idxChanged(x, d.originalIndexes.find((o) => o.orig === x.orig))))) return true;
  return false;
}

/** SQLite can't change a column's type/nullability/PK or drop a column in place,
 *  so the portable recipe (https://sqlite.org/lang_altertable.html) is: build a
 *  new table with the target shape, copy the surviving columns across, drop the
 *  old, rename the new into place, then recreate indexes. exec_ddl runs this with
 *  foreign_keys OFF inside one transaction. */
function buildAlterSqlite(engine: string, d: DesignerState): string[] {
  if (!designerHasChanges(d)) return [];
  const qi = (n: string) => quoteIdent(engine, n);
  const table = d.table.trim();
  const tmp = `${table}__balaudeck_new`;

  // CREATE the new table under a temp name, reusing the create builder.
  const created = buildCreate(engine, { ...d, table: tmp, isNew: true });
  // buildCreate returns [CREATE TABLE, ...CREATE INDEX]; take the table only —
  // indexes are recreated on the final name after the rename.
  const createTable = created[0];

  // Copy columns that existed before (have an orig) into their new names.
  const carried = d.columns.filter((c) => c.orig && c.name.trim());
  const newCols = carried.map((c) => qi(c.name)).join(", ");
  const oldCols = carried.map((c) => qi(c.orig as string)).join(", ");

  const stmts = [
    createTable,
    `INSERT INTO ${qi(tmp)} (${newCols}) SELECT ${oldCols} FROM ${qi(table)}`,
    `DROP TABLE ${qi(table)}`,
    `ALTER TABLE ${qi(tmp)} RENAME TO ${qi(table)}`,
  ];
  d.indexes.filter(idxValid).forEach((x, i) => stmts.push(createIndexStmt(engine, d.db, table, x, i)));
  return stmts;
}

// ---- DROP TABLE / CREATE DATABASE -------------------------------------------

export function buildDropTable(engine: string, db: string, table: string): string {
  return `DROP TABLE ${qualified(engine, db, table)}`;
}

/** `CREATE DATABASE`. SQLite has no such concept (one file per database). */
export function buildCreateDatabase(engine: string, name: string): string | null {
  if (eng(engine) === "sqlite") return null;
  return `CREATE DATABASE ${quoteIdent(engine, name)}`;
}
