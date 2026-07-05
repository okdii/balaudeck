//! Multi-engine dispatch for the SQL engines that are NOT MySQL/MariaDB
//! (PostgreSQL, SQL Server, SQLite). MySQL stays in `db.rs` on `mysql_async`;
//! each relevant command there checks `params.engine` and delegates here.
//!
//! v1 scope for these engines: connect, list databases, browse schema objects,
//! and run SQL queries (read + display). Inline row-editing (`exec_batch`) and
//! dump/import remain MySQL-only for now and return a clear error here.

use crate::db::{DbConnectParams, ExecStatement, QueryResult, SchemaObjects};

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
        "postgres" => pg::primary_key(p, table).await,
        "sqlite" => sqlite::primary_key(p, table).await,
        "mssql" => mssql::primary_key(p, database, table).await,
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
