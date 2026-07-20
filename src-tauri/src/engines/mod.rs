//! Multi-engine dispatch for the SQL engines that are NOT MySQL/MariaDB
//! (PostgreSQL, SQL Server, SQLite). MySQL stays in `db.rs` on `mysql_async`;
//! each relevant command there checks `params.engine` and delegates here.
//!
//! Scope for these engines: connect, list databases, browse schema objects, run
//! SQL queries, introspect primary + foreign keys, and inline row-editing
//! (`exec_batch`). Each is implemented natively per dialect below.

use crate::db::{DbConnectParams, ExecStatement, ForeignKeyRef, QueryResult, SchemaObjects};

pub mod pg;
pub mod sqlite;
pub mod mssql;

/// Engines handled by this module (everything except mysql/mariadb).
pub fn handles(engine: &str) -> bool {
    matches!(engine, "postgres" | "mssql" | "sqlite")
}

pub async fn query(
    p: &DbConnectParams,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    match p.engine.as_str() {
        "postgres" => pg::query(p, sql, max_rows).await,
        "sqlite" => sqlite::query(p, sql, max_rows).await,
        "mssql" => mssql::query(p, sql, max_rows).await,
        e => Err(format!("unsupported database engine: {e}")),
    }
}

pub async fn list_databases(p: &DbConnectParams) -> Result<Vec<String>, String> {
    match p.engine.as_str() {
        "postgres" => pg::list_databases(p).await,
        "sqlite" => sqlite::list_databases(p).await,
        "mssql" => mssql::list_databases(p).await,
        e => Err(format!("unsupported database engine: {e}")),
    }
}

pub async fn schema_objects(
    p: &DbConnectParams,
    database: &str,
) -> Result<SchemaObjects, String> {
    match p.engine.as_str() {
        "postgres" => pg::schema_objects(p, database).await,
        "sqlite" => sqlite::schema_objects(p, database).await,
        "mssql" => mssql::schema_objects(p, database).await,
        e => Err(format!("unsupported database engine: {e}")),
    }
}

pub async fn primary_key(
    p: &DbConnectParams,
    database: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    match p.engine.as_str() {
        "postgres" => pg::primary_key(p, database, table).await,
        "sqlite" => sqlite::primary_key(p, table).await,
        "mssql" => mssql::primary_key(p, database, table).await,
        e => Err(format!("unsupported database engine: {e}")),
    }
}

pub async fn foreign_keys(
    p: &DbConnectParams,
    database: &str,
    table: &str,
) -> Result<Vec<ForeignKeyRef>, String> {
    match p.engine.as_str() {
        "postgres" => pg::foreign_keys(p, database, table).await,
        "sqlite" => sqlite::foreign_keys(p, table).await,
        "mssql" => mssql::foreign_keys(p, database, table).await,
        e => Err(format!("unsupported database engine: {e}")),
    }
}

pub async fn exec_batch(
    p: &DbConnectParams,
    statements: &[ExecStatement],
) -> Result<Vec<u64>, String> {
    match p.engine.as_str() {
        "postgres" => pg::exec_batch(p, statements).await,
        "sqlite" => sqlite::exec_batch(p, statements).await,
        "mssql" => mssql::exec_batch(p, statements).await,
        e => Err(format!("unsupported database engine: {e}")),
    }
}

// ---- Editable-query detection (source table of a hand-written SELECT) --------
//
// MySQL learns a result's base table from driver column metadata (org_table +
// name==org_name per column). pg/mssql/sqlite expose no such per-column origin
// over the text/simple protocols, so we detect the base table by PARSING the
// SQL — but only for the unambiguous single-table shape, biased hard toward
// "not editable". A false negative just means a hand-typed query isn't editable;
// a false positive would arm a pk-based UPDATE against the wrong rows, so every
// uncertainty returns None.

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// Unquoted identifier or keyword (original case preserved).
    Word(String),
    /// Quoted identifier: "x" / [x] / `x` (inner text).
    Quoted(String),
    Star,
    Dot,
    Comma,
    Open,
    Close,
    /// A string/number literal — content irrelevant, never a plain column.
    Literal,
    /// Any other punctuation/operator (`+`, `=`, `;`, ...).
    Other(char),
}

/// Tokenise SQL into `(token, paren_depth)` pairs, skipping comments. Depth is
/// the parenthesis nesting the token sits at (0 = top level).
fn tokenize(sql: &str) -> Vec<(Tok, usize)> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0;
    let mut depth: usize = 0;
    let mut out: Vec<(Tok, usize)> = Vec::new();
    while i < n {
        let c = b[i] as char;
        if c.is_ascii_whitespace() {
            i += 1;
        } else if c == '-' && i + 1 < n && b[i + 1] == b'-' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
        } else if c == '/' && i + 1 < n && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
        } else if c == '\'' {
            i += 1;
            while i < n {
                if b[i] == b'\'' {
                    if i + 1 < n && b[i + 1] == b'\'' {
                        i += 2; // escaped ''
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            out.push((Tok::Literal, depth));
        } else if c == '"' || c == '`' {
            let q = b[i];
            i += 1;
            let start = i;
            let mut inner = String::new();
            while i < n {
                if b[i] == q {
                    if i + 1 < n && b[i + 1] == q {
                        inner.push(q as char);
                        i += 2; // escaped quote
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    inner.push(b[i] as char);
                    i += 1;
                }
            }
            let _ = start;
            out.push((Tok::Quoted(inner), depth));
        } else if c == '[' {
            // MSSQL bracket-quoted identifier.
            i += 1;
            let mut inner = String::new();
            while i < n && b[i] != b']' {
                inner.push(b[i] as char);
                i += 1;
            }
            i += 1; // closing ]
            out.push((Tok::Quoted(inner), depth));
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < n {
                let ch = b[i] as char;
                if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' {
                    i += 1;
                } else {
                    break;
                }
            }
            out.push((Tok::Word(sql[start..i].to_string()), depth));
        } else if c.is_ascii_digit() {
            while i < n {
                let ch = b[i] as char;
                if ch.is_ascii_alphanumeric() || ch == '.' {
                    i += 1;
                } else {
                    break;
                }
            }
            out.push((Tok::Literal, depth));
        } else if c == '*' {
            out.push((Tok::Star, depth));
            i += 1;
        } else if c == '.' {
            out.push((Tok::Dot, depth));
            i += 1;
        } else if c == ',' {
            out.push((Tok::Comma, depth));
            i += 1;
        } else if c == '(' {
            out.push((Tok::Open, depth));
            depth += 1;
            i += 1;
        } else if c == ')' {
            depth = depth.saturating_sub(1);
            out.push((Tok::Close, depth));
            i += 1;
        } else {
            out.push((Tok::Other(c), depth));
            i += 1;
        }
    }
    out
}

fn word_eq(t: &Tok, kw: &str) -> bool {
    matches!(t, Tok::Word(w) if w.eq_ignore_ascii_case(kw))
}

/// If `sql` is a plain `SELECT` from exactly ONE unqualified base table with a
/// projection of `*` or bare column names (no joins, unions, grouping, DISTINCT,
/// subqueries, functions, expressions, or aliases), return that table's name.
/// Otherwise `None` (the result grid stays read-only). Deliberately strict.
pub fn single_table_source(sql: &str) -> Option<String> {
    let toks = tokenize(sql);
    if toks.is_empty() {
        return None;
    }
    // Must begin with a top-level SELECT (no leading CTE / parenthesised query).
    if !word_eq(&toks[0].0, "select") {
        return None;
    }
    // Reject anything that unmistakably breaks the 1:1 row mapping, anywhere at
    // the top level (subquery contents live at depth > 0 and are ignored here).
    const BLOCK: &[&str] = &[
        "join", "union", "except", "intersect", "group", "having", "distinct",
        "window", "over", "with",
    ];
    for (t, d) in &toks {
        if *d == 0 {
            if let Tok::Word(w) = t {
                if BLOCK.iter().any(|k| w.eq_ignore_ascii_case(k)) {
                    return None;
                }
            }
        }
    }
    // A single trailing `;` is fine; anything after it means multiple statements.
    if let Some(pos) = toks.iter().position(|(t, _)| matches!(t, Tok::Other(';'))) {
        if pos != toks.len() - 1 {
            return None;
        }
    }
    // Exactly one top-level FROM.
    let from_positions: Vec<usize> = toks
        .iter()
        .enumerate()
        .filter(|(_, (t, d))| *d == 0 && word_eq(t, "from"))
        .map(|(i, _)| i)
        .collect();
    if from_positions.len() != 1 {
        return None;
    }
    let from_idx = from_positions[0];

    // ---- Projection: tokens between SELECT and FROM ----
    let proj = &toks[1..from_idx];
    if proj.is_empty() {
        return None;
    }
    if !(proj.len() == 1 && proj[0].0 == Tok::Star) {
        // Grammar: ident (Dot ident)*  (Comma ident (Dot ident)*)*
        // `expect_ident` toggles between wanting an identifier and wanting a
        // separator (Dot continues a qualified name, Comma starts the next).
        let mut expect_ident = true;
        for (t, _) in proj {
            match t {
                Tok::Word(w) if expect_ident => {
                    // A keyword where a column name belongs => an expression.
                    if is_reserved_projection_word(w) {
                        return None;
                    }
                    expect_ident = false;
                }
                Tok::Quoted(_) if expect_ident => expect_ident = false,
                Tok::Dot if !expect_ident => expect_ident = true,
                Tok::Comma if !expect_ident => expect_ident = true,
                // Star, Open, Close, Literal, Other, or two idents in a row
                // (an implicit alias like `id name`) => not a plain column list.
                _ => return None,
            }
        }
        if expect_ident {
            return None; // trailing comma/dot
        }
    }

    // ---- Table reference: from after FROM up to a clause keyword / end ----
    const STOP: &[&str] = &[
        "where", "order", "limit", "offset", "fetch", "for", "group", "having",
        "union", "except", "intersect", "window",
    ];
    let mut tref: Vec<&Tok> = Vec::new();
    for (t, d) in &toks[from_idx + 1..] {
        if *d == 0 {
            if let Tok::Word(w) = t {
                if STOP.iter().any(|k| w.eq_ignore_ascii_case(k)) {
                    break;
                }
            }
            if matches!(t, Tok::Other(';')) {
                break;
            }
        }
        tref.push(t);
    }
    // table [AS] [alias] — no dot (qualified), comma (multi-table), or paren.
    let name = match tref.as_slice() {
        [Tok::Word(w)] | [Tok::Word(w), Tok::Word(_)] if !is_reserved_projection_word(w) => {
            w.clone()
        }
        [Tok::Word(w), a, Tok::Word(_)]
            if word_eq(a, "as") && !is_reserved_projection_word(w) =>
        {
            w.clone()
        }
        [Tok::Quoted(w)] | [Tok::Quoted(w), Tok::Word(_)] => w.clone(),
        [Tok::Quoted(w), a, Tok::Word(_)] if word_eq(a, "as") => w.clone(),
        _ => return None,
    };
    if name.is_empty() {
        return None;
    }
    Some(name)
}

/// Keywords that must never appear where a plain column identifier is expected —
/// their presence means the projection is an expression, not a bare column list.
fn is_reserved_projection_word(w: &str) -> bool {
    const KW: &[&str] = &[
        "distinct", "all", "as", "case", "when", "then", "else", "end", "cast",
        "null", "not", "and", "or", "select", "from",
    ];
    KW.iter().any(|k| w.eq_ignore_ascii_case(k))
}

/// Replace each `?` placeholder with an escaped SQL literal (standard `''`
/// escaping + `NULL`). The frontend's generated row-edit UPDATEs use `?` only as
/// value placeholders (identifiers are quoted separately), so a plain scan is
/// safe. Used by the non-MySQL engines, whose drivers either can't bind text to
/// a typed column (pg/mssql) or where inlining is simplest (sqlite affinity).
pub fn inline_sql(sql: &str, values: &[Option<String>]) -> String {
    let mut out = String::with_capacity(sql.len() + values.len() * 8);
    let mut vi = 0;
    for ch in sql.chars() {
        if ch == '?' {
            match values.get(vi) {
                Some(Some(s)) => {
                    out.push('\'');
                    out.push_str(&s.replace('\'', "''"));
                    out.push('\'');
                }
                Some(None) => out.push_str("NULL"),
                None => out.push('?'),
            }
            vi += 1;
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod source_tests {
    use super::single_table_source as sts;

    #[test]
    fn detects_simple_selects() {
        assert_eq!(sts("SELECT * FROM widgets"), Some("widgets".into()));
        assert_eq!(sts("select * from widgets;"), Some("widgets".into()));
        assert_eq!(
            sts("SELECT id, name, qty FROM widgets WHERE qty > 1 ORDER BY id LIMIT 50"),
            Some("widgets".into())
        );
        assert_eq!(sts("SELECT * FROM widgets w"), Some("widgets".into()));
        assert_eq!(sts("SELECT * FROM widgets AS w"), Some("widgets".into()));
        // Quoted identifiers (pg/sqlite " ", mssql [ ], mysql ` `).
        assert_eq!(sts("SELECT * FROM \"My Table\""), Some("My Table".into()));
        assert_eq!(sts("SELECT * FROM [My Table]"), Some("My Table".into()));
        assert_eq!(sts("SELECT * FROM `widgets`"), Some("widgets".into()));
        // Comments and odd whitespace don't fool it.
        assert_eq!(
            sts("SELECT * /* c */ FROM widgets -- trailing\n"),
            Some("widgets".into())
        );
        assert_eq!(
            sts("SELECT id FROM widgets WHERE name = 'from a join b'"),
            Some("widgets".into())
        );
    }

    #[test]
    fn rejects_non_editable_shapes() {
        // Joins / multiple tables.
        assert_eq!(sts("SELECT * FROM a JOIN b ON a.id=b.id"), None);
        assert_eq!(sts("SELECT * FROM a, b"), None);
        assert_eq!(sts("SELECT * FROM a NATURAL JOIN b"), None);
        // Set operations.
        assert_eq!(sts("SELECT * FROM a UNION SELECT * FROM b"), None);
        // Aggregation / distinct / grouping.
        assert_eq!(sts("SELECT DISTINCT name FROM a"), None);
        assert_eq!(sts("SELECT count(*) FROM a"), None);
        assert_eq!(sts("SELECT name FROM a GROUP BY name"), None);
        assert_eq!(sts("SELECT name FROM a WHERE x=1 GROUP BY name"), None);
        assert_eq!(sts("SELECT name FROM a WHERE x=1 HAVING count(*)>1"), None);
        // Expressions / computed / aliased columns.
        assert_eq!(sts("SELECT a + b FROM t"), None);
        assert_eq!(sts("SELECT id AS x FROM t"), None);
        assert_eq!(sts("SELECT id name FROM t"), None); // implicit alias
        assert_eq!(sts("SELECT 1 FROM t"), None);
        assert_eq!(sts("SELECT lower(name) FROM t"), None);
        // Subqueries / CTEs.
        assert_eq!(sts("SELECT * FROM (SELECT * FROM t) x"), None);
        assert_eq!(sts("WITH c AS (SELECT 1) SELECT * FROM c"), None);
        // Qualified table names (schema/db ambiguity) — deliberately read-only.
        assert_eq!(sts("SELECT * FROM public.widgets"), None);
        assert_eq!(sts("SELECT * FROM db.dbo.widgets"), None);
        // Not a SELECT / multi-statement / empty.
        assert_eq!(sts("UPDATE t SET x=1"), None);
        assert_eq!(sts("SELECT * FROM a; DROP TABLE a"), None);
        assert_eq!(sts("SELECT 1"), None); // no FROM
        assert_eq!(sts(""), None);
    }
}
