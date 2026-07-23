// Dialect-aware SQL generation + grant parsing for the Users panel — the
// user-management analog of ddl.ts. The backend introspects accounts and returns
// raw grant strings; this module parses them into an editable privilege matrix,
// generates CREATE/ALTER/DROP USER + GRANT/REVOKE per dialect, and diffs the
// edited state down to the minimal set of statements. MySQL/MariaDB are complete
// here; PostgreSQL and SQL Server branches are filled in later increments.

import { quoteIdent, isMysqlFamily } from "./ddl";
import type { UserDetail } from "./types";

export interface UserModel {
  name: string;
  host: string; // MySQL account host; default "%". Unused for pg/mssql.
  isRole: boolean;
  authPlugin: string;
  password: string; // write-only; "" = leave unchanged on ALTER
  requireSsl: string; // "", "SSL", "X509"
  maxQueriesPerHour: number;
  maxConnectionsPerHour: number;
  maxUpdatesPerHour: number;
  maxUserConnections: number;
  accountLocked: boolean;
  passwordExpired: boolean;
  // pg role attributes (ignored for MySQL):
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  canLogin: boolean;
  validUntil: string | null;
  roles: string[];
  /** Diff snapshot; undefined = a brand-new account (emit CREATE). */
  orig?: { name: string; host: string };
}

export type PrivScope =
  | { kind: "global" }
  | { kind: "database"; db: string }
  | { kind: "table"; db: string; table: string };

export interface MatrixEntry {
  scope: PrivScope;
  privs: Set<string>;
  grantOption: boolean;
}
/** keyed by scopeKey(scope). */
export type PrivilegeMatrix = Record<string, MatrixEntry>;

export function scopeKey(s: PrivScope): string {
  if (s.kind === "global") return "*";
  if (s.kind === "database") return `db:${s.db}`;
  return `tbl:${s.db}.${s.table}`;
}

// ---- Privilege vocabularies --------------------------------------------------

const MYSQL_GLOBAL = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "RELOAD", "SHUTDOWN",
  "PROCESS", "FILE", "REFERENCES", "INDEX", "ALTER", "SHOW DATABASES", "SUPER",
  "CREATE TEMPORARY TABLES", "LOCK TABLES", "EXECUTE", "REPLICATION SLAVE",
  "REPLICATION CLIENT", "CREATE VIEW", "SHOW VIEW", "CREATE ROUTINE",
  "ALTER ROUTINE", "CREATE USER", "EVENT", "TRIGGER", "CREATE TABLESPACE",
  "GRANT OPTION",
];
const MYSQL_DB = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "REFERENCES", "INDEX",
  "ALTER", "CREATE TEMPORARY TABLES", "LOCK TABLES", "CREATE VIEW", "SHOW VIEW",
  "CREATE ROUTINE", "ALTER ROUTINE", "EXECUTE", "EVENT", "TRIGGER", "GRANT OPTION",
];
const MYSQL_TABLE = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "REFERENCES", "INDEX",
  "ALTER", "CREATE VIEW", "SHOW VIEW", "TRIGGER", "GRANT OPTION",
];
// PostgreSQL: role attributes live in the General tab, so there is no global
// object-privilege grid. Database/table object privileges below.
const PG_DB = ["CREATE", "CONNECT", "TEMPORARY"];
const PG_TABLE = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
// SQL Server object permissions (dbo schema assumed in v1).
const MSSQL_TABLE = ["SELECT", "INSERT", "UPDATE", "DELETE", "EXECUTE", "REFERENCES", "ALTER", "VIEW DEFINITION", "CONTROL"];

export function globalPrivs(engine: string): string[] {
  return isMysqlFamily(engine) ? MYSQL_GLOBAL : [];
}
export function dbPrivs(engine: string): string[] {
  if (isMysqlFamily(engine)) return MYSQL_DB;
  if (engine === "postgres") return PG_DB;
  return [];
}
export function tablePrivs(engine: string): string[] {
  if (isMysqlFamily(engine)) return MYSQL_TABLE;
  if (engine === "postgres") return PG_TABLE;
  if (engine === "mssql") return MSSQL_TABLE;
  return [];
}
function privsForScope(engine: string, scope: PrivScope): string[] {
  if (scope.kind === "global") return globalPrivs(engine);
  if (scope.kind === "database") return dbPrivs(engine);
  return tablePrivs(engine);
}

// ---- Quoting -----------------------------------------------------------------

/** How the engine references an account/principal in a statement. */
export function quoteUserRef(engine: string, name: string, host: string): string {
  if (isMysqlFamily(engine)) {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "''");
    return `'${esc(name)}'@'${esc(host || "%")}'`;
  }
  return quoteIdent(engine, name);
}
/** A string literal for the engine (passwords, ciphers). */
function quoteStr(engine: string, s: string): string {
  const q = s.replace(/'/g, "''");
  return engine === "mssql" ? `N'${q}'` : `'${q}'`;
}

/** How the engine renders a privilege scope on the ON clause. */
function scopeSql(engine: string, scope: PrivScope): string {
  if (engine === "postgres") {
    if (scope.kind === "global") return "";
    if (scope.kind === "database") return `DATABASE ${quoteIdent(engine, scope.db)}`;
    return `TABLE ${quoteIdent(engine, scope.table)}`; // search_path resolves the schema
  }
  if (engine === "mssql") {
    // v1 assumes the dbo schema for object grants.
    return scope.kind === "table" ? `[dbo].${quoteIdent(engine, scope.table)}` : "";
  }
  if (scope.kind === "global") return "*.*";
  if (scope.kind === "database") return `${quoteIdent(engine, scope.db)}.*`;
  return `${quoteIdent(engine, scope.db)}.${quoteIdent(engine, scope.table)}`;
}

// ---- Grant parsing (raw SHOW GRANTS -> matrix) -------------------------------

/** Split on commas that are NOT inside parentheses (column lists). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Strip one layer of backtick / double-quote / bracket quoting. */
function unquoteIdent(s: string): string {
  s = s.trim();
  if (s.length >= 2 && s[0] === "`" && s.endsWith("`")) return s.slice(1, -1).replace(/``/g, "`");
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) return s.slice(1, -1).replace(/""/g, '"');
  if (s.length >= 2 && s[0] === "[" && s.endsWith("]")) return s.slice(1, -1).replace(/]]/g, "]");
  return s;
}

/** Split `a.b` on the top-level dot, respecting backtick OR double-quote
 *  quoting; returns raw (still-quoted) parts. */
function splitQualified(s: string): [string, string] {
  s = s.trim();
  let inq = false;
  let close = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inq && (ch === "`" || ch === '"')) {
      inq = true;
      close = ch;
    } else if (!inq && ch === "[") {
      inq = true;
      close = "]";
    } else if (inq && ch === close) {
      inq = false;
    } else if (ch === "." && !inq) {
      return [s.slice(0, i), s.slice(i + 1)];
    }
  }
  return [s, ""];
}

function parseScopeMysql(s: string): PrivScope | null {
  s = s.trim();
  if (s === "*.*" || s === "*") return { kind: "global" };
  const [dbRaw, objRaw] = splitQualified(s);
  if (!objRaw) return null;
  const db = unquoteIdent(dbRaw);
  if (objRaw.trim() === "*") return { kind: "database", db };
  return { kind: "table", db, table: unquoteIdent(objRaw) };
}

/** Parse the account name out of a `` `name`@`host` `` token (role grants). */
function acctName(token: string): string {
  const at = token.indexOf("@");
  const namePart = at >= 0 ? token.slice(0, at) : token;
  return unquoteIdent(namePart);
}

/**
 * Parse raw grant statements into a privilege matrix + role memberships.
 * Column-qualified privileges (`SELECT (col)`) are intentionally NOT folded into
 * the matrix, so editing table-level privileges never silently touches an
 * existing column grant.
 */
export function parseGrants(
  engine: string,
  raw: string[],
  contextDb = "",
): { matrix: PrivilegeMatrix; roles: string[] } {
  const matrix: PrivilegeMatrix = {};
  const roles: string[] = [];

  if (engine === "postgres") {
    // Backend emits canonical GRANT strings: `GRANT p ON DATABASE "d" TO "u"` and
    // `GRANT p ON TABLE "s"."t" TO "u" [WITH GRANT OPTION]`. Role memberships come
    // via detail.roles, so role grants aren't parsed here.
    for (let line of raw) {
      line = line.trim();
      if (!/^GRANT\s/i.test(line)) continue;
      const grantOption = /\sWITH\s+GRANT\s+OPTION\s*$/i.test(line);
      line = line.replace(/\sWITH\s+GRANT\s+OPTION\s*$/i, "").trim();
      const onM = line.match(/\sON\s/i);
      if (!onM || onM.index === undefined) continue;
      const privPart = line.slice(5, onM.index).trim();
      const rest = line.slice(onM.index + 4).trim();
      const toM = rest.match(/\sTO\s/i);
      const scopeStr = (toM && toM.index !== undefined ? rest.slice(0, toM.index) : rest).trim();
      let scope: PrivScope | null = null;
      const dbM = scopeStr.match(/^DATABASE\s+(.+)$/i);
      const tblM = scopeStr.match(/^TABLE\s+(.+)$/i);
      if (dbM) scope = { kind: "database", db: unquoteIdent(dbM[1]) };
      else if (tblM) {
        const [, objRaw] = splitQualified(tblM[1]);
        scope = { kind: "table", db: contextDb, table: unquoteIdent(objRaw || tblM[1]) };
      }
      if (!scope) continue;
      const key = scopeKey(scope);
      const entry = matrix[key] ?? (matrix[key] = { scope, privs: new Set<string>(), grantOption: false });
      for (const rp of splitTopLevel(privPart)) {
        const p = rp.trim().toUpperCase();
        if (p && p !== "USAGE") entry.privs.add(p);
      }
      if (grantOption) entry.grantOption = true;
    }
    for (const k of Object.keys(matrix)) {
      if (matrix[k].privs.size === 0 && !matrix[k].grantOption) delete matrix[k];
    }
    return { matrix, roles };
  }

  if (engine === "mssql") {
    // Backend emits `GRANT p ON [schema].[obj] TO [user] [WITH GRANT OPTION]`.
    for (let line of raw) {
      line = line.trim();
      if (!/^GRANT\s/i.test(line)) continue;
      const grantOption = /\sWITH\s+GRANT\s+OPTION\s*$/i.test(line);
      line = line.replace(/\sWITH\s+GRANT\s+OPTION\s*$/i, "").trim();
      const onM = line.match(/\sON\s/i);
      if (!onM || onM.index === undefined) continue;
      const privPart = line.slice(5, onM.index).trim();
      const rest = line.slice(onM.index + 4).trim();
      const toM = rest.match(/\sTO\s/i);
      const scopeStr = (toM && toM.index !== undefined ? rest.slice(0, toM.index) : rest).trim();
      const [, objRaw] = splitQualified(scopeStr);
      const scope: PrivScope = { kind: "table", db: contextDb, table: unquoteIdent(objRaw || scopeStr) };
      const key = scopeKey(scope);
      const entry = matrix[key] ?? (matrix[key] = { scope, privs: new Set<string>(), grantOption: false });
      for (const rp of splitTopLevel(privPart)) {
        const p = rp.trim().toUpperCase();
        if (p && p !== "CONNECT") entry.privs.add(p);
      }
      if (grantOption) entry.grantOption = true;
    }
    return { matrix, roles };
  }

  if (!isMysqlFamily(engine)) return { matrix, roles };

  for (let line of raw) {
    line = line.trim();
    if (!/^GRANT\s/i.test(line)) continue;
    // WITH GRANT OPTION always trails, but IDENTIFIED BY / REQUIRE can sit before
    // it (MariaDB SHOW GRANTS), so test for it BEFORE the greedy IDENTIFIED strip.
    const grantOption = /\sWITH\s+GRANT\s+OPTION\s*$/i.test(line);
    line = line
      .replace(/\sWITH\s+GRANT\s+OPTION\s*$/i, "")
      .replace(/\s+IDENTIFIED\s+BY.*$/i, "")
      .replace(/\s+REQUIRE\s+.*$/i, "")
      .trim();

    const onMatch = line.match(/\sON\s/i);
    if (!onMatch || onMatch.index === undefined) {
      // role grant: GRANT `r`@`%`[, ...] TO `u`@`h`
      const m = line.match(/^GRANT\s+(.*?)\s+TO\s+/i);
      if (m) {
        for (const tok of splitTopLevel(m[1])) {
          const n = acctName(tok);
          if (n && n.toUpperCase() !== "USAGE") roles.push(n);
        }
      }
      continue;
    }
    const privPart = line.slice(5, onMatch.index).trim();
    let rest = line.slice(onMatch.index + 4).trim();
    const toMatch = rest.match(/\sTO\s/i);
    let scopeStr = toMatch && toMatch.index !== undefined ? rest.slice(0, toMatch.index).trim() : rest;
    scopeStr = scopeStr.replace(/^(TABLE|FUNCTION|PROCEDURE)\s+/i, "").trim();
    const scope = parseScopeMysql(scopeStr);
    if (!scope) continue;

    const key = scopeKey(scope);
    const entry = matrix[key] ?? (matrix[key] = { scope, privs: new Set<string>(), grantOption: false });
    for (const rawPriv of splitTopLevel(privPart)) {
      const p = rawPriv.trim().toUpperCase();
      if (!p || p === "USAGE" || p.includes("(")) continue; // skip column-qualified
      if (p === "ALL" || p === "ALL PRIVILEGES") {
        for (const gp of privsForScope(engine, scope)) if (gp !== "GRANT OPTION") entry.privs.add(gp);
        continue;
      }
      entry.privs.add(p);
    }
    if (grantOption) entry.grantOption = true;
  }
  // Drop scopes that carried only USAGE (a sentinel with no real privilege).
  for (const k of Object.keys(matrix)) {
    if (matrix[k].privs.size === 0 && !matrix[k].grantOption) delete matrix[k];
  }
  return { matrix, roles };
}

/** Build an editable model + privilege snapshot from backend detail. `contextDb`
 *  is the connected database, used to scope pg table grants. */
export function userFromDetail(
  engine: string,
  d: UserDetail,
  contextDb = "",
): { model: UserModel; matrix: PrivilegeMatrix } {
  const { matrix, roles } = parseGrants(engine, d.grants, contextDb);
  const a = d.attributes;
  const model: UserModel = {
    name: d.name,
    host: d.host || "%",
    isRole: false,
    authPlugin: a.authPlugin,
    password: "",
    requireSsl: a.requireSsl && a.requireSsl !== "" && a.requireSsl.toUpperCase() !== "NONE" ? a.requireSsl.toUpperCase() : "",
    maxQueriesPerHour: a.maxQueriesPerHour,
    maxConnectionsPerHour: a.maxConnectionsPerHour,
    maxUpdatesPerHour: a.maxUpdatesPerHour,
    maxUserConnections: a.maxUserConnections,
    accountLocked: a.accountLocked,
    passwordExpired: a.passwordExpired,
    isSuperuser: a.isSuperuser,
    canCreateDb: a.canCreateDb,
    canCreateRole: a.canCreateRole,
    canLogin: a.canLogin,
    validUntil: a.validUntil,
    roles: [...new Set([...(d.roles ?? []), ...roles])],
    orig: { name: d.name, host: d.host || "%" },
  };
  return { model, matrix };
}

export function blankUserModel(): UserModel {
  return {
    name: "", host: "%", isRole: false, authPlugin: "", password: "", requireSsl: "",
    maxQueriesPerHour: 0, maxConnectionsPerHour: 0, maxUpdatesPerHour: 0, maxUserConnections: 0,
    accountLocked: false, passwordExpired: false, isSuperuser: false, canCreateDb: false,
    canCreateRole: false, canLogin: true, validUntil: null, roles: [], orig: undefined,
  };
}

export function cloneMatrix(m: PrivilegeMatrix): PrivilegeMatrix {
  const out: PrivilegeMatrix = {};
  for (const [k, e] of Object.entries(m)) {
    out[k] = { scope: e.scope, privs: new Set(e.privs), grantOption: e.grantOption };
  }
  return out;
}

// ---- SQL generation (MySQL/MariaDB) -----------------------------------------

function sslClause(requireSsl: string): string {
  if (requireSsl === "SSL") return "SSL";
  if (requireSsl === "X509") return "X509";
  return "";
}
function resourceClause(u: UserModel): string {
  const parts: string[] = [];
  if (u.maxQueriesPerHour > 0) parts.push(`MAX_QUERIES_PER_HOUR ${u.maxQueriesPerHour}`);
  if (u.maxUpdatesPerHour > 0) parts.push(`MAX_UPDATES_PER_HOUR ${u.maxUpdatesPerHour}`);
  if (u.maxConnectionsPerHour > 0) parts.push(`MAX_CONNECTIONS_PER_HOUR ${u.maxConnectionsPerHour}`);
  if (u.maxUserConnections > 0) parts.push(`MAX_USER_CONNECTIONS ${u.maxUserConnections}`);
  return parts.join(" ");
}

export function buildCreateUser(engine: string, u: UserModel): string[] {
  if (engine === "mssql") {
    const id = quoteIdent(engine, u.name);
    const login = u.password
      ? `CREATE LOGIN ${id} WITH PASSWORD = ${quoteStr(engine, u.password)}`
      : `CREATE LOGIN ${id} FROM WINDOWS`;
    return [login, `CREATE USER ${id} FOR LOGIN ${id}`];
  }
  if (engine === "postgres") {
    const id = quoteIdent(engine, u.name);
    let s = `CREATE ROLE ${id} WITH ${u.canLogin ? "LOGIN" : "NOLOGIN"}`;
    s += u.isSuperuser ? " SUPERUSER" : " NOSUPERUSER";
    s += u.canCreateDb ? " CREATEDB" : " NOCREATEDB";
    s += u.canCreateRole ? " CREATEROLE" : " NOCREATEROLE";
    if (u.maxUserConnections > 0) s += ` CONNECTION LIMIT ${u.maxUserConnections}`;
    if (u.password) s += ` PASSWORD ${quoteStr(engine, u.password)}`;
    if (u.validUntil) s += ` VALID UNTIL ${quoteStr(engine, u.validUntil)}`;
    return [s];
  }
  const acct = quoteUserRef(engine, u.name, u.host);
  let s = `CREATE USER ${acct}`;
  if (u.password) s += ` IDENTIFIED BY ${quoteStr(engine, u.password)}`;
  const req = sslClause(u.requireSsl);
  if (req) s += ` REQUIRE ${req}`;
  const res = resourceClause(u);
  if (res) s += ` WITH ${res}`;
  if (u.passwordExpired) s += " PASSWORD EXPIRE";
  if (u.accountLocked) s += " ACCOUNT LOCK";
  return [s];
}

/** ALTER statements for only the attributes that changed from `before`. */
export function buildAlterUser(engine: string, u: UserModel, before: UserModel): string[] {
  const stmts: string[] = [];
  const orig = before.orig ?? { name: before.name, host: before.host };

  if (engine === "mssql") {
    const id = quoteIdent(engine, u.name);
    if (u.name !== orig.name) stmts.push(`ALTER LOGIN ${quoteIdent(engine, orig.name)} WITH NAME = ${id}`);
    if (u.password) stmts.push(`ALTER LOGIN ${id} WITH PASSWORD = ${quoteStr(engine, u.password)}`);
    if (u.accountLocked !== before.accountLocked) stmts.push(`ALTER LOGIN ${id} ${u.accountLocked ? "DISABLE" : "ENABLE"}`);
    return stmts;
  }

  if (engine === "postgres") {
    const id = quoteIdent(engine, u.name);
    if (u.name !== orig.name) stmts.push(`ALTER ROLE ${quoteIdent(engine, orig.name)} RENAME TO ${id}`);
    const opts: string[] = [];
    if (u.canLogin !== before.canLogin) opts.push(u.canLogin ? "LOGIN" : "NOLOGIN");
    if (u.isSuperuser !== before.isSuperuser) opts.push(u.isSuperuser ? "SUPERUSER" : "NOSUPERUSER");
    if (u.canCreateDb !== before.canCreateDb) opts.push(u.canCreateDb ? "CREATEDB" : "NOCREATEDB");
    if (u.canCreateRole !== before.canCreateRole) opts.push(u.canCreateRole ? "CREATEROLE" : "NOCREATEROLE");
    if (u.maxUserConnections !== before.maxUserConnections) opts.push(`CONNECTION LIMIT ${u.maxUserConnections || -1}`);
    if (opts.length) stmts.push(`ALTER ROLE ${id} WITH ${opts.join(" ")}`);
    if (u.password) stmts.push(`ALTER ROLE ${id} WITH PASSWORD ${quoteStr(engine, u.password)}`);
    if (u.validUntil && u.validUntil !== before.validUntil) stmts.push(`ALTER ROLE ${id} VALID UNTIL ${quoteStr(engine, u.validUntil)}`);
    return stmts;
  }

  // MySQL/MariaDB
  const oldAcct = quoteUserRef(engine, orig.name, orig.host);
  if (u.name !== orig.name || u.host !== orig.host) {
    stmts.push(`RENAME USER ${oldAcct} TO ${quoteUserRef(engine, u.name, u.host)}`);
  }
  const acct = quoteUserRef(engine, u.name, u.host);
  if (u.password) stmts.push(`ALTER USER ${acct} IDENTIFIED BY ${quoteStr(engine, u.password)}`);
  if (u.requireSsl !== before.requireSsl) {
    stmts.push(`ALTER USER ${acct} REQUIRE ${sslClause(u.requireSsl) || "NONE"}`);
  }
  const limitsChanged =
    u.maxQueriesPerHour !== before.maxQueriesPerHour ||
    u.maxUpdatesPerHour !== before.maxUpdatesPerHour ||
    u.maxConnectionsPerHour !== before.maxConnectionsPerHour ||
    u.maxUserConnections !== before.maxUserConnections;
  if (limitsChanged) {
    stmts.push(`ALTER USER ${acct} WITH ${resourceClause(u) || "MAX_USER_CONNECTIONS 0"}`);
  }
  if (u.accountLocked !== before.accountLocked) {
    stmts.push(`ALTER USER ${acct} ACCOUNT ${u.accountLocked ? "LOCK" : "UNLOCK"}`);
  }
  if (u.passwordExpired && !before.passwordExpired) stmts.push(`ALTER USER ${acct} PASSWORD EXPIRE`);
  return stmts;
}

export function buildDropUser(engine: string, u: UserModel): string[] {
  if (engine === "postgres") return [`DROP ROLE ${quoteIdent(engine, u.name)}`];
  if (engine === "mssql") return [`DROP USER ${quoteIdent(engine, u.name)}`, `DROP LOGIN ${quoteIdent(engine, u.name)}`];
  return [`DROP USER ${quoteUserRef(engine, u.name, u.host)}`];
}

export function buildGrant(engine: string, u: UserModel, scope: PrivScope, privs: string[], grantOption: boolean): string {
  const acct = quoteUserRef(engine, u.name, u.host);
  let s = `GRANT ${privs.join(", ")} ON ${scopeSql(engine, scope)} TO ${acct}`;
  if (grantOption) s += " WITH GRANT OPTION";
  return s;
}
export function buildRevoke(engine: string, u: UserModel, scope: PrivScope, privs: string[]): string {
  return `REVOKE ${privs.join(", ")} ON ${scopeSql(engine, scope)} FROM ${quoteUserRef(engine, u.name, u.host)}`;
}

// ---- Diffing -----------------------------------------------------------------

/** Account-level statements: CREATE for a new user, else the ALTER set. */
export function diffUser(engine: string, before: UserModel | null, after: UserModel): string[] {
  const stmts = before?.orig ? buildAlterUser(engine, after, before) : buildCreateUser(engine, after);
  // Role-membership diff.
  const had = new Set(before?.roles ?? []);
  const want = new Set(after.roles);
  const acct = quoteUserRef(engine, after.name, after.host);
  const add = [...want].filter((r) => !had.has(r));
  const drop = [...had].filter((r) => !want.has(r));
  if (engine === "mssql") {
    for (const r of add) stmts.push(`ALTER ROLE ${quoteIdent(engine, r)} ADD MEMBER ${acct}`);
    for (const r of drop) stmts.push(`ALTER ROLE ${quoteIdent(engine, r)} DROP MEMBER ${acct}`);
  } else {
    if (add.length) stmts.push(`GRANT ${add.map((r) => quoteIdent(engine, r)).join(", ")} TO ${acct}`);
    if (drop.length) stmts.push(`REVOKE ${drop.map((r) => quoteIdent(engine, r)).join(", ")} FROM ${acct}`);
  }
  return stmts;
}

/** Minimal GRANT/REVOKE set to move `before` privileges to `after`, per scope. */
export function diffPrivileges(engine: string, u: UserModel, before: PrivilegeMatrix, after: PrivilegeMatrix): string[] {
  const stmts: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const b = before[key];
    const a = after[key];
    const scope = a?.scope ?? b!.scope;
    const cur = b?.privs ?? new Set<string>();
    const want = a?.privs ?? new Set<string>();
    const toGrant = [...want].filter((p) => !cur.has(p));
    const toRevoke = [...cur].filter((p) => !want.has(p));
    const wantGO = a?.grantOption ?? false;
    const hadGO = b?.grantOption ?? false;
    if (toRevoke.length) stmts.push(buildRevoke(engine, u, scope, toRevoke));
    if (toGrant.length || (wantGO && !hadGO)) {
      const privs = toGrant.length ? toGrant : ["USAGE"];
      stmts.push(buildGrant(engine, u, scope, privs, wantGO));
    }
    if (hadGO && !wantGO) {
      stmts.push(`REVOKE GRANT OPTION ON ${scopeSql(engine, scope)} FROM ${quoteUserRef(engine, u.name, u.host)}`);
    }
  }
  return stmts;
}

/** Join generated statements for the SQL-preview pane. */
export function userSql(stmts: string[]): string {
  if (!stmts.length) return "";
  return stmts.map((s) => s.replace(/;\s*$/, "")).join(";\n") + ";";
}
