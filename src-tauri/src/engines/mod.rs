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

pub async fn exec_batch(
    _p: &DbConnectParams,
    _statements: &[ExecStatement],
) -> Result<Vec<u64>, String> {
    // Inline grid editing is MySQL-only for v1; the frontend disables the editor
    // for other engines, but guard here too.
    Err("Editing rows is only supported for MySQL/MariaDB in this version.".into())
}
