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
  return `'${d.replace(/'/g, "''")}'`;
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

// ---- DROP TABLE / CREATE DATABASE -------------------------------------------

export function buildDropTable(engine: string, db: string, table: string): string {
  return `DROP TABLE ${qualified(engine, db, table)}`;
}

/** `CREATE DATABASE`. SQLite has no such concept (one file per database). */
export function buildCreateDatabase(engine: string, name: string): string | null {
  if (eng(engine) === "sqlite") return null;
  return `CREATE DATABASE ${quoteIdent(engine, name)}`;
}
