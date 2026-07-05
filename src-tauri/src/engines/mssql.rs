//! SQL Server (MSSQL) driver via `tiberius`. Implemented as a proper increment
//! after PostgreSQL + SQLite (tiberius returns typed values that need per-type
//! decoding for a generic grid). Stubbed with a clear message until then.

use crate::db::{DbConnectParams, QueryResult, SchemaObjects};

const NOT_READY: &str = "SQL Server support is being added — not available yet in this build.";

pub async fn query(
    _p: &DbConnectParams,
    _sql: &str,
    _max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    Err(NOT_READY.into())
}

pub async fn list_databases(_p: &DbConnectParams) -> Result<Vec<String>, String> {
    Err(NOT_READY.into())
}

pub async fn schema_objects(
    _p: &DbConnectParams,
    _database: &str,
) -> Result<SchemaObjects, String> {
    Err(NOT_READY.into())
}
