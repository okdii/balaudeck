//! MySQL/MariaDB client built on mysql_async.
//! Spike-quality for Fasa 0; grows into the full Fasa 5 implementation.

use futures_util::StreamExt;
use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{Column, Conn, Opts, OptsBuilder, Pool, Row, TxOpts, Value};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::AppHandle;

/// Cache of live connection pools, keyed by host/port/user/db, so queries on
/// the same connection reuse an open pool instead of reconnecting each time.
static POOLS: Lazy<Mutex<HashMap<String, Pool>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn pool_key(p: &DbConnectParams) -> String {
    format!("{}|{}|{}|{}", p.host, p.port, p.user, p.database.as_deref().unwrap_or(""))
}

fn get_pool(p: &DbConnectParams) -> Pool {
    let key = pool_key(p);
    let mut map = POOLS.lock().unwrap();
    if let Some(pool) = map.get(&key) {
        return pool.clone();
    }
    let pool = Pool::new(build_opts(p));
    map.insert(key, pool.clone());
    pool
}

/// Open manual-transaction sessions: a pooled connection pinned across several
/// user statements (BEGIN … COMMIT/ROLLBACK), keyed by a client-supplied id.
/// The inner tokio Mutex serializes statements on the one pinned connection.
static TX_SESSIONS: Lazy<Mutex<HashMap<String, Arc<tokio::sync::Mutex<Conn>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Pause/cancel flags for a running export, looked up by export id.
struct JobCtl {
    cancelled: AtomicBool,
    paused: AtomicBool,
}
static JOBS: Lazy<Mutex<HashMap<String, Arc<JobCtl>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Removes the export's control entry when the dump finishes (any exit path).
struct CtlGuard(String);
impl Drop for CtlGuard {
    fn drop(&mut self) {
        JOBS.lock().unwrap().remove(&self.0);
    }
}

/// Progress messages streamed to the UI over a channel during a dump.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DumpProgress {
    Start { tables: usize },
    Table { name: String, index: usize, total: usize, rows: u64 },
    Rows { written: u64, total: u64 },
    TableDone { name: String, rows: u64 },
    Done { tables: usize, rows: u64 },
    Cancelled { tables: usize, rows: u64 },
}

/// Flip a job's pause/cancel flags (called from the export/import dialog).
#[tauri::command]
pub fn db_job_control(job_id: String, action: String) -> Result<(), String> {
    if let Some(ctl) = JOBS.lock().unwrap().get(&job_id) {
        match action.as_str() {
            "cancel" => ctl.cancelled.store(true, Ordering::Relaxed),
            "pause" => ctl.paused.store(true, Ordering::Relaxed),
            "resume" => ctl.paused.store(false, Ordering::Relaxed),
            _ => {}
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct DbConnectParams {
    /// Which engine to dispatch to. Defaults to "mysql" so pre-multi-engine
    /// frontend calls (and the existing MySQL path) keep working unchanged.
    #[serde(default = "crate::profiles::default_engine")]
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    /// SQLite database file path (engine == "sqlite").
    #[serde(default)]
    pub file: Option<String>,
    /// When set, a missing password is pulled from the keychain for this profile.
    #[serde(default)]
    pub profile_id: Option<String>,
    /// S3-only: signing region; blank/None means "us-east-1".
    #[serde(default)]
    pub region: Option<String>,
    /// S3-only: path-style addressing (default true — MinIO/RustFS/IP endpoints).
    #[serde(default)]
    pub path_style: Option<bool>,
    /// S3-only: connect over HTTPS instead of plain HTTP (default false).
    #[serde(default)]
    pub tls: Option<bool>,
}

#[derive(Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    /// Per-column flag: true for binary columns the grid must not edit as text.
    pub binary_cols: Vec<bool>,
    pub rows: Vec<Vec<Option<String>>>,
    pub rows_affected: u64,
    pub elapsed_ms: u128,
    /// True when more rows were available but the fetch stopped at `max_rows`.
    pub truncated: bool,
    /// When every column is a plain, unaliased column of ONE base table, these
    /// name that table so the grid can be edited even for a hand-written SELECT.
    /// None for joins, computed/aliased columns, or non-MySQL engines.
    pub source_db: Option<String>,
    pub source_table: Option<String>,
}

pub(crate) fn resolve_password(p: &DbConnectParams) -> String {
    if let Some(pw) = &p.password {
        if !pw.is_empty() {
            return pw.clone();
        }
    }
    if let Some(id) = &p.profile_id {
        if let Ok(Some(pw)) = crate::profiles::get_secret("db", id, "password") {
            return pw;
        }
    }
    String::new()
}

fn build_opts(p: &DbConnectParams) -> Opts {
    let builder = OptsBuilder::default()
        .ip_or_hostname(p.host.clone())
        .tcp_port(p.port)
        .user(Some(p.user.clone()))
        .pass(Some(resolve_password(p)))
        .db_name(p.database.clone())
        // Most local/dev MySQL/MariaDB servers don't offer TLS; let it negotiate.
        .prefer_socket(false)
        // Report MATCHED (not just changed) rows from affected_rows(), so the data
        // editor can tell "row not found" (0) from "matched, value unchanged" (1).
        .client_found_rows(true);
    Opts::from(builder)
}

/// Whether a column holds binary data (BINARY/VARBINARY/BLOB/BIT/GEOMETRY), which
/// can't be safely round-tripped as a UTF-8 string in the grid editor.
fn col_is_binary(col: &Column) -> bool {
    match col.column_type() {
        ColumnType::MYSQL_TYPE_TINY_BLOB
        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
        | ColumnType::MYSQL_TYPE_LONG_BLOB
        | ColumnType::MYSQL_TYPE_BLOB
        | ColumnType::MYSQL_TYPE_VAR_STRING
        | ColumnType::MYSQL_TYPE_STRING
        | ColumnType::MYSQL_TYPE_VARCHAR => col.character_set() == 63, // 63 = binary collation
        ColumnType::MYSQL_TYPE_BIT | ColumnType::MYSQL_TYPE_GEOMETRY => true,
        _ => false,
    }
}

/// Render a MySQL value as a display string (NULL -> None).
fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::NULL => None,
        Value::Bytes(b) => Some(String::from_utf8_lossy(b).into_owned()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::Double(d) => Some(d.to_string()),
        Value::Date(y, mo, d, h, mi, s, us) => Some(format!(
            "{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{us:06}"
        )),
        Value::Time(neg, days, h, mi, s, us) => {
            let sign = if *neg { "-" } else { "" };
            Some(format!("{sign}{days}d {h:02}:{mi:02}:{s:02}.{us:06}"))
        }
    }
}

fn row_to_strings(row: &Row) -> Vec<Option<String>> {
    (0..row.len())
        .map(|i| row.as_ref(i).and_then(value_to_string))
        .collect()
}

/// Connect, run a single SQL statement, and return columns + rows.
/// Verifies the mysql_async path against the docker stack (Fasa 0 spike).
#[tauri::command]
pub async fn db_query(
    params: DbConnectParams,
    sql: String,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    if crate::engines::handles(&params.engine) {
        return crate::engines::query(&params, &sql, max_rows).await;
    }
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let out = run_query_on_conn(&mut conn, sql, max_rows).await;
    // Return the connection to the pool (do not disconnect — the pool is reused).
    drop(conn);
    out
}

/// Run one SQL statement on a specific (MySQL) connection and materialize its
/// result grid. Shared by the pooled one-shot `db_query` and the pinned
/// manual-transaction path, so both get identical column/row/source handling.
async fn run_query_on_conn(
    conn: &mut Conn,
    sql: String,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let started = std::time::Instant::now();
    let mut result = conn
        .query_iter(sql)
        .await
        .map_err(|e| format!("query failed: {e}"))?;

    let cols = result.columns();
    let columns: Vec<String> = cols
        .as_ref()
        .map(|cs| cs.iter().map(|c| c.name_str().into_owned()).collect())
        .unwrap_or_default();
    let binary_cols: Vec<bool> = cols
        .as_ref()
        .map(|cs| cs.iter().map(col_is_binary).collect())
        .unwrap_or_default();

    // Editable-source detection: only when EVERY column is a plain, unaliased
    // column of one base table (no joins, no computed/aliased columns) — that
    // guarantees `columns` are the real column names in order, so the grid's
    // pk-based UPDATE/DELETE/INSERT target exactly that table.
    let source: Option<(String, String)> = cols.as_ref().and_then(|cs| {
        if cs.is_empty() {
            return None;
        }
        // (schema, org_table, query_alias). The alias (`table_str`) must also be
        // single: a self-join `FROM t e JOIN t m` gives both columns org_table=t
        // but different aliases e/m, and mixing their columns must NOT be treated
        // as one editable table (a pk UPDATE would hit the wrong row).
        let mut src: Option<(String, String, String)> = None;
        for c in cs.iter() {
            let ot = c.org_table_str();
            if ot.is_empty() || c.name_str() != c.org_name_str() {
                return None; // computed, or the displayed name differs from the real column
            }
            let sch = c.schema_str().into_owned();
            if sch.is_empty() {
                return None;
            }
            let t = ot.into_owned();
            let alias = c.table_str().into_owned();
            match &src {
                Some((d, tt, a)) if *d != sch || *tt != t || *a != alias => return None,
                None => src = Some((sch, t, alias)),
                _ => {}
            }
        }
        src.map(|(sch, t, _)| (sch, t))
    });
    let (source_db, source_table) = match source {
        Some((d, t)) => (Some(d), Some(t)),
        None => (None, None),
    };

    // Stream rows and stop once `max_rows` is reached, so a huge result set
    // never has to be fully buffered, serialized over IPC, or rendered.
    let cap = max_rows.unwrap_or(usize::MAX);
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated = false;
    if let Some(mut stream) = result
        .stream::<Row>()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?
    {
        while let Some(row) = stream.next().await {
            let row = row.map_err(|e| format!("fetch failed: {e}"))?;
            if rows.len() >= cap {
                truncated = true;
                break;
            }
            rows.push(row_to_strings(&row));
        }
    }
    drop(result);

    let rows_affected = conn.affected_rows();

    Ok(QueryResult {
        columns,
        binary_cols,
        rows,
        rows_affected,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
        source_db,
        source_table,
    })
}

/// Begin a manual transaction: pin a pooled connection and run START
/// TRANSACTION on it. The client supplies `session_id` (a UUID) to address the
/// follow-up exec/commit/rollback calls. MySQL/MariaDB only — other engines
/// route through `crate::engines`, which manages its own connections.
#[tauri::command]
pub async fn db_tx_begin(params: DbConnectParams, session_id: String) -> Result<(), String> {
    if crate::engines::handles(&params.engine) {
        return Err("Manual transactions are available for MySQL/MariaDB connections only.".into());
    }
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    conn.query_drop("START TRANSACTION")
        .await
        .map_err(|e| format!("begin failed: {e}"))?;
    TX_SESSIONS
        .lock()
        .unwrap()
        .insert(session_id, Arc::new(tokio::sync::Mutex::new(conn)));
    Ok(())
}

/// Run one statement inside an open manual transaction, on its pinned conn.
#[tauri::command]
pub async fn db_tx_exec(
    session_id: String,
    sql: String,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let sess = TX_SESSIONS
        .lock()
        .unwrap()
        .get(&session_id)
        .cloned()
        .ok_or_else(|| "no open transaction (it may have been committed or rolled back)".to_string())?;
    let mut conn = sess.lock().await;
    run_query_on_conn(&mut conn, sql, max_rows).await
}

/// Commit an open manual transaction and return its connection to the pool.
#[tauri::command]
pub async fn db_tx_commit(session_id: String) -> Result<(), String> {
    finish_tx(session_id, "COMMIT").await
}

/// Roll back an open manual transaction and return its connection to the pool.
#[tauri::command]
pub async fn db_tx_rollback(session_id: String) -> Result<(), String> {
    finish_tx(session_id, "ROLLBACK").await
}

/// Shared COMMIT/ROLLBACK: remove the session first (so no new statement can
/// join it), then run the verb on the pinned conn. Dropping the guard and the
/// Arc afterwards returns the connection to the pool.
async fn finish_tx(session_id: String, verb: &str) -> Result<(), String> {
    let sess = TX_SESSIONS
        .lock()
        .unwrap()
        .remove(&session_id)
        .ok_or_else(|| "no open transaction to finish".to_string())?;
    let mut conn = sess.lock().await;
    conn.query_drop(verb)
        .await
        .map_err(|e| format!("{} failed: {e}", verb.to_lowercase()))?;
    Ok(())
}

#[derive(Deserialize)]
pub struct ExecStatement {
    pub sql: String,
    pub values: Vec<Option<String>>,
}

/// Apply a batch of single-row edits atomically. All statements run inside one
/// transaction on one connection; each must match exactly one row (CLIENT_FOUND_ROWS
/// makes affected_rows = matched rows), otherwise the whole batch is rolled back and
/// nothing is saved. All data is bound as positional parameters — never interpolated
/// into the SQL — so cell contents can't inject SQL. Returns matched-rows per statement.
#[tauri::command]
pub async fn db_exec_batch(
    params: DbConnectParams,
    statements: Vec<ExecStatement>,
) -> Result<Vec<u64>, String> {
    if crate::engines::handles(&params.engine) {
        return crate::engines::exec_batch(&params, &statements).await;
    }
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let mut tx = conn
        .start_transaction(TxOpts::default())
        .await
        .map_err(|e| format!("begin failed: {e}"))?;

    let mut affected = Vec::with_capacity(statements.len());
    for (i, st) in statements.iter().enumerate() {
        let bind: Vec<Value> = st
            .values
            .iter()
            .map(|o| match o {
                Some(s) => Value::Bytes(s.clone().into_bytes()),
                None => Value::NULL,
            })
            .collect();
        match tx.exec_iter(st.sql.as_str(), bind).await {
            Ok(res) => {
                let a = res.affected_rows();
                if let Err(e) = res.drop_result().await {
                    let _ = tx.rollback().await;
                    return Err(format!("statement {} failed: {e}", i + 1));
                }
                if a != 1 {
                    let _ = tx.rollback().await;
                    return Err(format!(
                        "row {} matched {} rows (expected exactly 1) — nothing was saved",
                        i + 1,
                        a
                    ));
                }
                affected.push(a);
            }
            Err(e) => {
                let _ = tx.rollback().await;
                return Err(format!("statement {} failed: {e}", i + 1));
            }
        }
    }
    tx.commit().await.map_err(|e| format!("commit failed: {e}"))?;
    drop(conn);
    Ok(affected)
}

#[derive(Serialize)]
pub struct Routine {
    pub name: String,
    pub kind: String,
}

#[derive(Serialize)]
pub struct SchemaObjects {
    pub tables: Vec<String>,
    pub views: Vec<String>,
    pub routines: Vec<Routine>,
}

/// One column as introspected from an existing table, in the shape the designer
/// needs. `data_type` is the dialect's native type name (the frontend reverse-
/// maps it to a canonical designer type); `length` is "n" or "p,s" or "".
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub length: String,
    pub nullable: bool,
    pub default: String,
    pub pk: bool,
    pub auto_increment: bool,
}

/// One foreign key with its name and referential actions (designer needs both,
/// unlike the lighter `ForeignKeyRef` used for grid click-through).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FkInfo {
    pub name: String,
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
    pub on_delete: String,
    pub on_update: String,
}

/// One non-primary index: its name, ordered columns, and uniqueness.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

/// The full structure of an existing table, engine-aware. Drives the visual
/// designer's "Design" (edit) mode and Show-DDL reconstruction.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    pub columns: Vec<ColumnInfo>,
    pub foreign_keys: Vec<FkInfo>,
    pub indexes: Vec<IndexInfo>,
}

/// A database account/role as listed in the user-management panel. `host` is the
/// MySQL account host (empty for pg roles / mssql principals).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbUser {
    pub name: String,
    pub host: String,
    pub is_role: bool,
    pub locked: bool,
    pub expired: bool,
}

/// Editable attributes of one account. Resource limits + SSL + expiry apply to
/// MySQL; the `is_*`/`can_*`/`valid_until` fields carry pg role attributes in the
/// same struct (0/false/"" when the engine doesn't use them).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAttributes {
    pub auth_plugin: String,
    pub require_ssl: String,
    pub max_queries_per_hour: i64,
    pub max_connections_per_hour: i64,
    pub max_updates_per_hour: i64,
    pub max_user_connections: i64,
    pub account_locked: bool,
    pub password_expired: bool,
    pub password_lifetime: Option<i64>,
    pub is_superuser: bool,
    pub can_create_db: bool,
    pub can_create_role: bool,
    pub can_login: bool,
    pub valid_until: Option<String>,
}

/// One account's full detail. `grants` are RAW grant statements (MySQL: SHOW
/// GRANTS rows verbatim; pg/mssql: reconstructed GRANT strings) which the
/// frontend parses into a privilege matrix — mirroring how the designer parses
/// native column types. `roles` are memberships resolved on the backend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDetail {
    pub name: String,
    pub host: String,
    pub attributes: UserAttributes,
    pub grants: Vec<String>,
    pub roles: Vec<String>,
}

/// Introspect an existing table's columns, foreign keys, and indexes. Non-MySQL
/// engines each read their native catalogs; MySQL/MariaDB use SHOW + I_S.
#[tauri::command]
pub async fn db_table_schema(
    params: DbConnectParams,
    database: String,
    table: String,
) -> Result<TableSchema, String> {
    if crate::engines::handles(&params.engine) {
        return crate::engines::table_schema(&params, &database, &table).await;
    }
    mysql_table_schema(&params, &database, &table).await
}

/// MySQL/MariaDB table introspection via `information_schema` (columns + key
/// usage + statistics), matching what the designer previously did frontend-side.
async fn mysql_table_schema(
    params: &DbConnectParams,
    database: &str,
    table: &str,
) -> Result<TableSchema, String> {
    let pool = get_pool(params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let db = database.replace('\'', "''");
    let tb = table.replace('\'', "''");

    let col_rows: Vec<Row> = conn
        .query_iter(format!(
            "SELECT COLUMN_NAME, DATA_TYPE, \
                    COALESCE(CASE WHEN CHARACTER_MAXIMUM_LENGTH IS NOT NULL \
                        THEN CAST(CHARACTER_MAXIMUM_LENGTH AS CHAR) \
                        WHEN NUMERIC_PRECISION IS NOT NULL AND DATA_TYPE IN ('decimal','numeric') \
                        THEN CONCAT(NUMERIC_PRECISION, ',', COALESCE(NUMERIC_SCALE,0)) \
                        ELSE '' END, '') AS len, \
                    IS_NULLABLE, COALESCE(COLUMN_DEFAULT,'') AS dflt, \
                    COLUMN_KEY, EXTRA, COLUMN_TYPE \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA='{db}' AND TABLE_NAME='{tb}' ORDER BY ORDINAL_POSITION"
        ))
        .await
        .map_err(|e| format!("columns failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("columns failed: {e}"))?;
    let mut columns = Vec::new();
    for r in &col_rows {
        let name: String = r.get(0).unwrap_or_default();
        let data_type: String = r.get(1).unwrap_or_default();
        let mut length: String = r.get(2).unwrap_or_default();
        // Unsigned is carried on COLUMN_TYPE (e.g. "bigint(20) unsigned").
        let column_type: String = r.get(7).unwrap_or_default();
        let data_type = if column_type.to_lowercase().contains("unsigned") {
            format!("{data_type} unsigned")
        } else {
            data_type
        };
        if length.is_empty() {
            // Fall back to a length embedded in COLUMN_TYPE, e.g. varchar(255).
            if let (Some(a), Some(b)) = (column_type.find('('), column_type.find(')')) {
                if b > a + 1 {
                    length = column_type[a + 1..b].to_string();
                }
            }
        }
        let nullable = r.get::<String, _>(3).unwrap_or_default().eq_ignore_ascii_case("YES");
        let default: String = r.get(4).unwrap_or_default();
        let key: String = r.get(5).unwrap_or_default();
        let extra: String = r.get(6).unwrap_or_default();
        columns.push(ColumnInfo {
            name,
            data_type,
            length,
            nullable,
            default,
            pk: key.eq_ignore_ascii_case("PRI"),
            auto_increment: extra.to_lowercase().contains("auto_increment"),
        });
    }

    let fk_rows: Vec<Row> = conn
        .query_iter(format!(
            "SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, \
                    k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE \
             FROM information_schema.KEY_COLUMN_USAGE k \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
               ON r.CONSTRAINT_SCHEMA=k.TABLE_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME \
             WHERE k.TABLE_SCHEMA='{db}' AND k.TABLE_NAME='{tb}' \
               AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION"
        ))
        .await
        .map_err(|e| format!("foreign keys failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("foreign keys failed: {e}"))?;
    let foreign_keys = fk_rows
        .iter()
        .map(|r| FkInfo {
            name: r.get(0).unwrap_or_default(),
            column: r.get(1).unwrap_or_default(),
            ref_table: r.get(2).unwrap_or_default(),
            ref_column: r.get(3).unwrap_or_default(),
            on_delete: r.get(4).unwrap_or_default(),
            on_update: r.get(5).unwrap_or_default(),
        })
        .collect();

    let idx_rows: Vec<Row> = conn
        .query_iter(format!(
            "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA='{db}' AND TABLE_NAME='{tb}' AND INDEX_NAME<>'PRIMARY' \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX"
        ))
        .await
        .map_err(|e| format!("indexes failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("indexes failed: {e}"))?;
    let indexes = group_indexes(idx_rows.iter().map(|r| {
        (
            r.get::<String, _>(0).unwrap_or_default(),
            r.get::<String, _>(1).unwrap_or_default(),
            r.get::<i64, _>(2).unwrap_or(1) == 0,
        )
    }));

    Ok(TableSchema {
        columns,
        foreign_keys,
        indexes,
    })
}

/// Fold ordered `(index_name, column, unique)` rows into `IndexInfo`s, preserving
/// first-seen index order and per-index column order. Shared by all engines.
pub(crate) fn group_indexes(
    rows: impl IntoIterator<Item = (String, String, bool)>,
) -> Vec<IndexInfo> {
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, IndexInfo> = std::collections::HashMap::new();
    for (name, col, unique) in rows {
        if name.is_empty() || col.is_empty() {
            continue;
        }
        let e = map.entry(name.clone()).or_insert_with(|| {
            order.push(name.clone());
            IndexInfo {
                name: name.clone(),
                columns: Vec::new(),
                unique,
            }
        });
        e.columns.push(col);
    }
    order
        .into_iter()
        .filter_map(|n| map.remove(&n))
        .collect()
}

// ---- User / privilege management --------------------------------------------

/// True for a MySQL 'Y'/'1' flag (ENUM('Y','N') columns or a boolean expression).
fn um_truthy(v: Option<String>) -> bool {
    matches!(v.as_deref().map(str::trim), Some("Y") | Some("y") | Some("1"))
}

/// Column names present on `mysql.user` (lowercased). The account SELECTs project
/// only columns that exist so they stay valid across MySQL 5.6/5.7/8 + MariaDB
/// (whose `mysql.user` is a view over `mysql.global_priv` with a different set).
async fn mysql_user_columns(conn: &mut mysql_async::Conn) -> std::collections::HashSet<String> {
    let rows: Vec<Row> = match conn
        .query_iter(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA='mysql' AND TABLE_NAME='user'",
        )
        .await
    {
        Ok(mut q) => q.collect().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    rows.iter()
        .filter_map(|r| r.get::<String, _>(0))
        .map(|s| s.to_lowercase())
        .collect()
}

/// List MySQL/MariaDB accounts. Roles are detected via the MariaDB `is_role`
/// column, or (MySQL 8) membership as a grantor in `mysql.role_edges`.
async fn mysql_list_users(params: &DbConnectParams) -> Result<Vec<DbUser>, String> {
    let pool = get_pool(params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let have = mysql_user_columns(&mut conn).await;
    let has = |c: &str| have.contains(c);
    let locked = if has("account_locked") { "account_locked" } else { "'N'" };
    let expired = if has("password_expired") { "password_expired" } else { "'N'" };
    let is_role = if has("is_role") { "is_role" } else { "'N'" };
    let sql = format!(
        "SELECT User, Host, {locked} AS l, {expired} AS e, {is_role} AS r \
         FROM mysql.user ORDER BY User, Host"
    );
    let rows: Vec<Row> = conn
        .query_iter(sql)
        .await
        .map_err(|e| format!("list users failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("list users failed: {e}"))?;

    // MySQL 8: a role appears as a grantor (FROM_*) in mysql.role_edges.
    let mut mysql8_roles: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    if !has("is_role") {
        if let Ok(mut q) = conn
            .query_iter("SELECT DISTINCT FROM_USER, FROM_HOST FROM mysql.role_edges")
            .await
        {
            if let Ok(re) = q.collect::<Row>().await {
                for r in &re {
                    mysql8_roles
                        .insert((r.get(0).unwrap_or_default(), r.get(1).unwrap_or_default()));
                }
            }
        }
    }

    Ok(rows
        .iter()
        .map(|r| {
            let name: String = r.get(0).unwrap_or_default();
            let host: String = r.get(1).unwrap_or_default();
            let is_role = if has("is_role") {
                um_truthy(r.get(4))
            } else {
                mysql8_roles.contains(&(name.clone(), host.clone()))
            };
            DbUser {
                is_role,
                locked: um_truthy(r.get(2)),
                expired: um_truthy(r.get(3)),
                name,
                host,
            }
        })
        .collect())
}

/// One MySQL/MariaDB account's attributes + SHOW GRANTS output.
async fn mysql_user_detail(
    params: &DbConnectParams,
    user: &str,
    host: &str,
) -> Result<UserDetail, String> {
    let pool = get_pool(params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let have = mysql_user_columns(&mut conn).await;
    let col = |c: &str, fallback: &str| {
        if have.contains(c) {
            c.to_string()
        } else {
            fallback.to_string()
        }
    };
    let u = user.replace('\'', "''");
    let h = host.replace('\'', "''");
    let sql = format!(
        "SELECT {plugin} AS plugin, {ssl} AS ssl_type, {mq} AS mq, {mc} AS mc, {mu} AS mu, \
                {muc} AS muc, {locked} AS l, {expired} AS e, {lifetime} AS lt \
         FROM mysql.user WHERE User='{u}' AND Host='{h}'",
        plugin = col("plugin", "''"),
        ssl = col("ssl_type", "''"),
        mq = col("max_questions", "0"),
        mc = col("max_connections", "0"),
        mu = col("max_updates", "0"),
        muc = col("max_user_connections", "0"),
        locked = col("account_locked", "'N'"),
        expired = col("password_expired", "'N'"),
        lifetime = col("password_lifetime", "NULL"),
    );
    let rows: Vec<Row> = conn
        .query_iter(sql)
        .await
        .map_err(|e| format!("user detail failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("user detail failed: {e}"))?;
    let r = rows
        .first()
        .ok_or_else(|| format!("user '{user}'@'{host}' not found"))?;
    let attributes = UserAttributes {
        auth_plugin: r.get(0).unwrap_or_default(),
        require_ssl: r.get(1).unwrap_or_default(),
        max_queries_per_hour: r.get(2).unwrap_or(0),
        max_connections_per_hour: r.get(3).unwrap_or(0),
        max_updates_per_hour: r.get(4).unwrap_or(0),
        max_user_connections: r.get(5).unwrap_or(0),
        account_locked: um_truthy(r.get(6)),
        password_expired: um_truthy(r.get(7)),
        password_lifetime: r.get::<Option<i64>, _>(8).flatten(),
        is_superuser: false,
        can_create_db: false,
        can_create_role: false,
        can_login: true,
        valid_until: None,
    };
    let grant_rows: Vec<Row> = conn
        .query_iter(format!("SHOW GRANTS FOR '{u}'@'{h}'"))
        .await
        .map_err(|e| format!("show grants failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("show grants failed: {e}"))?;
    let grants: Vec<String> = grant_rows
        .iter()
        .filter_map(|r| r.get::<String, _>(0))
        .collect();
    Ok(UserDetail {
        name: user.to_string(),
        host: host.to_string(),
        attributes,
        grants,
        roles: Vec::new(),
    })
}

/// List database accounts/roles, engine-aware. Powers the user-management panel.
#[tauri::command]
pub async fn db_list_users(params: DbConnectParams) -> Result<Vec<DbUser>, String> {
    if crate::engines::handles(&params.engine) {
        return crate::engines::list_users(&params).await;
    }
    mysql_list_users(&params).await
}

/// One account's attributes + grants + role memberships, engine-aware.
#[tauri::command]
pub async fn db_user_detail(
    params: DbConnectParams,
    user: String,
    host: String,
) -> Result<UserDetail, String> {
    if crate::engines::handles(&params.engine) {
        return crate::engines::user_detail(&params, &user, &host).await;
    }
    mysql_user_detail(&params, &user, &host).await
}

/// Run account-management statements (CREATE/ALTER/DROP USER, GRANT/REVOKE),
/// engine-aware. MySQL/MariaDB account DDL each auto-commits and CREATE/DROP USER
/// cannot be rolled back, so the MySQL path runs SEQUENTIALLY with no transaction,
/// stopping on the first error (and reporting which statement failed). pg wraps in
/// a transaction; mssql runs sequentially across master/db scopes.
#[tauri::command]
pub async fn db_exec_user_sql(
    params: DbConnectParams,
    statements: Vec<String>,
) -> Result<(), String> {
    if statements.is_empty() {
        return Ok(());
    }
    if crate::engines::handles(&params.engine) {
        return crate::engines::exec_user_sql(&params, &statements).await;
    }
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    for (i, sql) in statements.iter().enumerate() {
        conn.query_drop(sql)
            .await
            .map_err(|e| format!("statement {} failed: {e}", i + 1))?;
    }
    Ok(())
}

/// List a database's objects, categorized: base tables, views, and routines
/// (stored functions + procedures).
#[tauri::command]
pub async fn db_schema_objects(
    params: DbConnectParams,
    database: String,
) -> Result<SchemaObjects, String> {
    if crate::engines::handles(&params.engine) {
        return crate::engines::schema_objects(&params, &database).await;
    }
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    let mut tables = Vec::new();
    let mut views = Vec::new();
    let trows: Vec<Row> = conn
        .query_iter(format!("SHOW FULL TABLES FROM `{database}`"))
        .await
        .map_err(|e| format!("list tables failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("list tables failed: {e}"))?;
    for r in &trows {
        if let Some(name) = r.as_ref(0).and_then(value_to_string) {
            let kind = r.as_ref(1).and_then(value_to_string).unwrap_or_default();
            if kind.eq_ignore_ascii_case("VIEW") {
                views.push(name);
            } else {
                tables.push(name);
            }
        }
    }

    let mut routines = Vec::new();
    let rrows: Vec<Row> = conn
        .query_iter(format!(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = '{}' ORDER BY ROUTINE_NAME",
            database.replace('\'', "''")
        ))
        .await
        .map_err(|e| format!("list routines failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("list routines failed: {e}"))?;
    for r in &rrows {
        if let Some(name) = r.as_ref(0).and_then(value_to_string) {
            let kind = r
                .as_ref(1)
                .and_then(value_to_string)
                .unwrap_or_else(|| "FUNCTION".into());
            routines.push(Routine { name, kind });
        }
    }

    Ok(SchemaObjects {
        tables,
        views,
        routines,
    })
}

/// Close and drop the cached pool for a connection (called on disconnect).
#[tauri::command]
pub async fn db_disconnect(params: DbConnectParams) -> Result<(), String> {
    // The alt engines connect per-call (no pool to close).
    if crate::engines::handles(&params.engine) {
        return Ok(());
    }
    let key = pool_key(&params);
    let pool = POOLS.lock().unwrap().remove(&key);
    if let Some(pool) = pool {
        let _ = pool.disconnect().await;
    }
    Ok(())
}

/// List the server's databases, engine-aware. Replaces the frontend's hardcoded
/// `SHOW DATABASES` so the schema tree works across engines.
#[tauri::command]
pub async fn db_list_databases(params: DbConnectParams) -> Result<Vec<String>, String> {
    if crate::engines::handles(&params.engine) {
        return crate::engines::list_databases(&params).await;
    }
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let rows: Vec<Row> = conn
        .query_iter("SHOW DATABASES")
        .await
        .map_err(|e| format!("list databases failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("list databases failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| r.as_ref(0).and_then(value_to_string))
        .collect())
}

/// The primary-key columns of a table (ordered), engine-aware. Enables the grid
/// row-editor: no PK => the grid stays read-only.
#[tauri::command]
pub async fn db_primary_key(
    params: DbConnectParams,
    database: String,
    table: String,
) -> Result<Vec<String>, String> {
    if crate::engines::handles(&params.engine) {
        return crate::engines::primary_key(&params, &database, &table).await;
    }
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let db = database.replace('`', "``");
    let tb = table.replace('`', "``");
    let rows: Vec<Row> = conn
        .query_iter(format!("SHOW KEYS FROM `{db}`.`{tb}` WHERE Key_name = 'PRIMARY'"))
        .await
        .map_err(|e| format!("primary key failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("primary key failed: {e}"))?;
    let mut pks: Vec<(i64, String)> = Vec::new();
    for r in &rows {
        let name: Option<String> = r.get("Column_name");
        let seq: Option<i64> = r.get("Seq_in_index");
        if let Some(name) = name {
            pks.push((seq.unwrap_or(0), name));
        }
    }
    pks.sort_by_key(|(s, _)| *s);
    Ok(pks.into_iter().map(|(_, n)| n).collect())
}

/// One outgoing foreign key of a table: which local `column` points at which
/// (`ref_table`, `ref_column`). Serialised camelCase to match the frontend's
/// `FkRef`. Powers grid cell click-through to the referenced row.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyRef {
    pub column: String,
    pub ref_table: String,
    pub ref_column: String,
}

/// Outgoing foreign keys of a table, engine-aware. Non-MySQL engines delegate to
/// their `engines::foreign_keys` (which connects to the browsed database);
/// MySQL/MariaDB read `information_schema.KEY_COLUMN_USAGE` directly. Best-effort:
/// on any engine a missing/failed lookup simply yields no FK links.
#[tauri::command]
pub async fn db_foreign_keys(
    params: DbConnectParams,
    database: String,
    table: String,
) -> Result<Vec<ForeignKeyRef>, String> {
    if crate::engines::handles(&params.engine) {
        return crate::engines::foreign_keys(&params, &database, &table).await;
    }
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    let db = database.replace('\'', "''");
    let tb = table.replace('\'', "''");
    let sql = format!(
        "SELECT k.COLUMN_NAME, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME \
         FROM information_schema.KEY_COLUMN_USAGE k \
         WHERE k.TABLE_SCHEMA = '{db}' AND k.TABLE_NAME = '{tb}' \
           AND k.REFERENCED_TABLE_NAME IS NOT NULL \
         ORDER BY k.ORDINAL_POSITION"
    );
    let rows: Vec<Row> = conn
        .query_iter(sql)
        .await
        .map_err(|e| format!("foreign keys failed: {e}"))?
        .collect()
        .await
        .map_err(|e| format!("foreign keys failed: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let column: Option<String> = r.get(0);
            let ref_table: Option<String> = r.get(1);
            let ref_column: Option<String> = r.get(2);
            match (column, ref_table, ref_column) {
                (Some(column), Some(ref_table), Some(ref_column))
                    if !column.is_empty() && !ref_table.is_empty() && !ref_column.is_empty() =>
                {
                    Some(ForeignKeyRef {
                        column,
                        ref_table,
                        ref_column,
                    })
                }
                _ => None,
            }
        })
        .collect())
}

/// Run a list of DDL statements in one transaction against the browsed database.
/// Powers the visual table designer's Save (CREATE / ALTER / DROP, and SQLite's
/// multi-statement table-rebuild). Non-MySQL engines delegate to
/// `engines::exec_ddl`; MySQL/MariaDB run them on one pooled connection (its DDL
/// auto-commits, so the transaction is best-effort there).
#[tauri::command]
pub async fn db_exec_ddl(
    params: DbConnectParams,
    database: String,
    statements: Vec<String>,
) -> Result<(), String> {
    if statements.is_empty() {
        return Ok(());
    }
    if crate::engines::handles(&params.engine) {
        return crate::engines::exec_ddl(&params, &database, &statements).await;
    }
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    conn.query_drop("START TRANSACTION")
        .await
        .map_err(|e| format!("begin failed: {e}"))?;
    for (i, sql) in statements.iter().enumerate() {
        if let Err(e) = conn.query_drop(sql).await {
            conn.query_drop("ROLLBACK").await.ok();
            return Err(format!("statement {} failed: {e}", i + 1));
        }
    }
    conn.query_drop("COMMIT")
        .await
        .map_err(|e| format!("commit failed: {e}"))
}

/// Render a value as a SQL literal for INSERT statements (with escaping).
fn sql_literal(v: &Value) -> String {
    match v {
        Value::NULL => "NULL".to_string(),
        Value::Int(i) => i.to_string(),
        Value::UInt(u) => u.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Double(d) => d.to_string(),
        Value::Bytes(b) => {
            let s = String::from_utf8_lossy(b);
            let mut out = String::with_capacity(s.len() + 2);
            out.push('\'');
            for ch in s.chars() {
                match ch {
                    '\'' => out.push_str("\\'"),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\0' => out.push_str("\\0"),
                    _ => out.push(ch),
                }
            }
            out.push('\'');
            out
        }
        Value::Date(y, mo, d, h, mi, s, _us) => {
            format!("'{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}'")
        }
        Value::Time(neg, days, h, mi, s, _us) => {
            let sign = if *neg { "-" } else { "" };
            let total_h = (*days) * 24 + *h as u32;
            format!("'{sign}{total_h:02}:{mi:02}:{s:02}'")
        }
    }
}

/// Split a SQL script into statements on `;`, ignoring `;` inside quotes and
/// comments (`-- `, `#`, `/* */`). DELIMITER blocks are not handled.
fn split_statements(sql: &str) -> Vec<String> {
    // Byte scan (delimiters are ASCII; multi-byte UTF-8 bytes are all >= 0x80
    // and never match), slicing whole statements instead of copying per char.
    let b = sql.as_bytes();
    let n = b.len();
    let mut i = 0;
    let mut start = 0;
    let mut out = Vec::new();
    while i < n {
        let c = b[i];
        if (c == b'-' && i + 1 < n && b[i + 1] == b'-') || c == b'#' {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && i + 1 < n && b[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
            continue;
        }
        if c == b'\'' || c == b'"' || c == b'`' {
            let q = c;
            i += 1;
            while i < n {
                if b[i] == b'\\' && i + 1 < n {
                    i += 2;
                    continue;
                }
                if b[i] == q {
                    if i + 1 < n && b[i + 1] == q {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if c == b';' {
            let stmt = sql[start..i].trim();
            if !stmt.is_empty() {
                out.push(stmt.to_string());
            }
            i += 1;
            start = i;
            continue;
        }
        i += 1;
    }
    let stmt = sql[start..n].trim();
    if !stmt.is_empty() {
        out.push(stmt.to_string());
    }
    out
}

/// Optional S3 destination for `db_dump`: the finished dump is uploaded to
/// `bucket`/`key` on this S3 connection instead of staying at the local path.
#[derive(Deserialize)]
pub struct DumpS3Target {
    /// The S3 connection (engine "s3": endpoint, credentials, region, …).
    pub params: DbConnectParams,
    pub bucket: String,
    pub key: String,
    /// When set, the upload streams `transfer://progress` events under this
    /// id and honors `transfer_cancel`.
    #[serde(default)]
    pub transfer_job_id: Option<String>,
}

/// Removes the staged dump file when an S3-targeted dump exits — success or
/// cancel — so aborted runs can't accumulate files in the temp dir. Disarmed
/// on an upload failure so the dump survives at a path we report to the user.
struct TempFileGuard(std::path::PathBuf, bool);
impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if self.1 {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

/// Quote a SQL identifier per the engine's dialect (`` `x` `` MySQL, `"x"`
/// pg/sqlite, `[x]` MSSQL). Backend counterpart of the frontend `quoteIdent`.
fn q_ident(engine: &str, name: &str) -> String {
    match engine {
        "mysql" | "mariadb" => format!("`{}`", name.replace('`', "``")),
        "mssql" => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// Reconstruct a `CREATE TABLE` (+ its `CREATE INDEX`es) for a dump, using the
/// engine's OWN introspected native types verbatim (the dump reloads into the
/// same engine, so no type mapping is needed). Used by the non-MySQL dump path.
fn build_create_native(engine: &str, table: &str, schema: &TableSchema) -> Vec<String> {
    let mut lines: Vec<String> = schema
        .columns
        .iter()
        .map(|c| {
            let ty = if c.length.is_empty() {
                c.data_type.clone()
            } else {
                format!("{}({})", c.data_type, c.length)
            };
            let mut s = format!("{} {}", q_ident(engine, &c.name), ty);
            if c.auto_increment {
                match engine {
                    "postgres" => s.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
                    "mssql" => s.push_str(" IDENTITY(1,1)"),
                    _ => {}
                }
            }
            s.push_str(if c.nullable { " NULL" } else { " NOT NULL" });
            if !c.default.is_empty() {
                s.push_str(&format!(" DEFAULT {}", c.default));
            }
            s
        })
        .collect();

    let pk: Vec<String> = schema
        .columns
        .iter()
        .filter(|c| c.pk)
        .map(|c| q_ident(engine, &c.name))
        .collect();
    if !pk.is_empty() {
        lines.push(format!("PRIMARY KEY ({})", pk.join(", ")));
    }
    for f in &schema.foreign_keys {
        let mut s = String::new();
        if !f.name.is_empty() {
            s.push_str(&format!("CONSTRAINT {} ", q_ident(engine, &f.name)));
        }
        s.push_str(&format!(
            "FOREIGN KEY ({}) REFERENCES {} ({})",
            q_ident(engine, &f.column),
            q_ident(engine, &f.ref_table),
            q_ident(engine, &f.ref_column)
        ));
        if !f.on_delete.is_empty() {
            s.push_str(&format!(" ON DELETE {}", f.on_delete));
        }
        if !f.on_update.is_empty() {
            s.push_str(&format!(" ON UPDATE {}", f.on_update));
        }
        lines.push(s);
    }

    let tbl = q_ident(engine, table);
    let mut stmts = vec![format!("CREATE TABLE {} (\n  {}\n)", tbl, lines.join(",\n  "))];
    for idx in &schema.indexes {
        let cols = idx
            .columns
            .iter()
            .map(|c| q_ident(engine, c))
            .collect::<Vec<_>>()
            .join(", ");
        stmts.push(format!(
            "CREATE {}INDEX {} ON {} ({})",
            if idx.unique { "UNIQUE " } else { "" },
            q_ident(engine, &idx.name),
            tbl,
            cols
        ));
    }
    stmts
}

/// A SQL string literal for dump INSERTs. Every non-NULL value is single-quoted;
/// the target engine coerces the text to the column type on load (works across
/// pg/sqlite/mssql for the common scalar types). Binary/blob columns dump their
/// display placeholder — a known limitation noted in the dump header.
fn dump_literal(v: &Option<String>) -> String {
    match v {
        None => "NULL".to_string(),
        Some(s) => format!("'{}'", s.replace('\'', "''")),
    }
}

/// Native dump for PostgreSQL / SQL Server / SQLite: schema (reconstructed from
/// introspection, or sqlite_master for SQLite) + data INSERTs, honouring
/// pause/cancel and streaming DumpProgress. Writes to `w`; returns rows written.
async fn engine_dump_body(
    params: &DbConnectParams,
    database: &str,
    table: Option<String>,
    w: &mut impl std::io::Write,
    ctl: &Arc<JobCtl>,
    on_progress: &Channel<DumpProgress>,
) -> Result<(usize, usize), String> {
    let engine = params.engine.as_str();

    // Table + view lists (native, per engine).
    let (tables, views): (Vec<String>, Vec<String>) = if let Some(t) = table {
        (vec![t], Vec::new())
    } else {
        let objs = crate::engines::schema_objects(params, database).await?;
        (objs.tables, objs.views)
    };
    let total_tables = tables.len() + views.len();

    let _ = writeln!(w, "-- balaudeck dump of {database} ({engine})");
    let _ = writeln!(w, "-- note: binary/blob values are exported as placeholders");
    match engine {
        "sqlite" => {
            let _ = writeln!(w, "PRAGMA foreign_keys=OFF;\n");
        }
        "postgres" => {
            let _ = writeln!(w, "SET session_replication_role = replica;\n");
        }
        _ => {
            let _ = writeln!(w);
        }
    }
    on_progress
        .send(DumpProgress::Start {
            tables: total_tables,
        })
        .ok();

    let mut count = 0usize;
    let mut ti = 0usize;
    for t in tables.iter() {
        if ctl.cancelled.load(Ordering::Relaxed) {
            on_progress
                .send(DumpProgress::Cancelled {
                    tables: ti,
                    rows: count as u64,
                })
                .ok();
            return Ok((count, total_tables));
        }
        ti += 1;
        on_progress
            .send(DumpProgress::Table {
                name: t.clone(),
                index: ti,
                total: total_tables,
                rows: 0,
            })
            .ok();

        // Schema DDL.
        let _ = writeln!(w, "DROP TABLE IF EXISTS {};", q_ident(engine, t));
        if engine == "sqlite" {
            // SQLite stores the exact CREATE text — dump it (table + its indexes).
            let ddl = crate::engines::query(
                params,
                &format!(
                    "SELECT sql FROM sqlite_master WHERE tbl_name='{}' AND sql IS NOT NULL \
                     ORDER BY (type='table') DESC",
                    t.replace('\'', "''")
                ),
                None,
            )
            .await?;
            for row in &ddl.rows {
                if let Some(Some(sql)) = row.first() {
                    let _ = writeln!(w, "{sql};");
                }
            }
        } else {
            let schema = crate::engines::table_schema(params, database, t).await?;
            for stmt in build_create_native(engine, t, &schema) {
                let _ = writeln!(w, "{stmt};");
            }
        }
        let _ = writeln!(w);

        // Data. One buffered SELECT per table (simple + correct; very large
        // tables trade memory for simplicity here).
        let data = crate::engines::query(params, &format!("SELECT * FROM {}", q_ident(engine, t)), None).await?;
        let collist = data
            .columns
            .iter()
            .map(|c| q_ident(engine, c))
            .collect::<Vec<_>>()
            .join(", ");
        let mut written = 0u64;
        for row in &data.rows {
            while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            if ctl.cancelled.load(Ordering::Relaxed) {
                break;
            }
            let vals = row.iter().map(dump_literal).collect::<Vec<_>>().join(", ");
            writeln!(
                w,
                "INSERT INTO {} ({}) VALUES ({});",
                q_ident(engine, t),
                collist,
                vals
            )
            .map_err(|e| format!("write failed: {e}"))?;
            written += 1;
            count += 1;
            if written % 200 == 0 {
                on_progress
                    .send(DumpProgress::Rows { written, total: 0 })
                    .ok();
            }
        }
        on_progress
            .send(DumpProgress::Rows { written, total: 0 })
            .ok();
        on_progress
            .send(DumpProgress::TableDone {
                name: t.clone(),
                rows: written,
            })
            .ok();
        let _ = writeln!(w);
    }

    // Views: listed in progress only; their definitions aren't reconstructed
    // here (data tables are the dump's focus).
    for v in views.iter() {
        on_progress
            .send(DumpProgress::TableDone {
                name: v.clone(),
                rows: 0,
            })
            .ok();
    }

    match engine {
        "sqlite" => {
            let _ = writeln!(w, "PRAGMA foreign_keys=ON;");
        }
        "postgres" => {
            let _ = writeln!(w, "SET session_replication_role = DEFAULT;");
        }
        _ => {}
    }
    Ok((count, total_tables))
}

/// Dump a whole database (or one table) to a `.sql` file: schema + INSERTs.
/// Streams progress over `on_progress`; obeys pause/cancel via `export_id`.
/// With an `s3` target the dump ignores `path` and stages to a temp file,
/// which is then uploaded to the bucket via the shared multipart helper.
/// Returns the number of data rows written.
#[tauri::command]
pub async fn db_dump(
    app: AppHandle,
    params: DbConnectParams,
    database: String,
    table: Option<String>,
    path: String,
    export_id: String,
    s3: Option<DumpS3Target>,
    on_progress: Channel<DumpProgress>,
) -> Result<usize, String> {
    use std::io::Write;

    let ctl = Arc::new(JobCtl {
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
    });
    JOBS.lock().unwrap().insert(export_id.clone(), ctl.clone());
    let _guard = CtlGuard(export_id);

    // With an S3 target the dump writes to a temp file and uploads after it
    // completes. Staging keeps the dump writer and its DumpProgress events
    // untouched and gives multipart a file of known size up front (streaming
    // rows straight into multipart parts is the future refinement). The
    // guard deletes the temp file on every exit path — it drops after the
    // writer, so the file is already closed when it's removed.
    let (path, mut _tmp_guard) = match &s3 {
        Some(t) => {
            let base = t.key.rsplit('/').next().unwrap_or(&t.key);
            let millis = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let tmp = std::env::temp_dir().join(format!("balaudeck-dump-{millis}-{base}"));
            (tmp.to_string_lossy().into_owned(), Some(TempFileGuard(tmp, true)))
        }
        None => (path, None),
    };

    // Non-MySQL engines dump natively (schema from introspection / sqlite_master
    // + INSERTs), reusing the same staging + S3 upload tail below.
    if crate::engines::handles(&params.engine) {
        let file = std::fs::File::create(&path).map_err(|e| format!("create file failed: {e}"))?;
        let mut w = std::io::BufWriter::new(file);
        let (count, tables) =
            engine_dump_body(&params, &database, table, &mut w, &ctl, &on_progress).await?;
        w.flush().map_err(|e| format!("flush failed: {e}"))?;
        if s3.is_none() {
            on_progress
                .send(DumpProgress::Done { tables, rows: count as u64 })
                .ok();
        } else if let Some(t) = &s3 {
            drop(w);
            let display = t.key.rsplit('/').next().unwrap_or(&t.key).to_string();
            if let Err(e) = crate::s3::upload_file(
                &app,
                &t.params,
                &t.bucket,
                &t.key,
                &path,
                t.transfer_job_id.as_deref(),
                &display,
            )
            .await
            {
                if let Some(g) = _tmp_guard.as_mut() {
                    g.1 = false;
                }
                return Err(format!("{e} — dump left at {path}"));
            }
            on_progress
                .send(DumpProgress::Done { tables, rows: count as u64 })
                .ok();
        }
        return Ok(count);
    }

    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    // (name, is_view) — views are dumped as their definition only, not data.
    let tables: Vec<(String, bool)> = if let Some(t) = table {
        vec![(t, false)]
    } else {
        let rows: Vec<Row> = conn
            .query_iter(format!("SHOW FULL TABLES FROM `{database}`"))
            .await
            .map_err(|e| format!("list tables failed: {e}"))?
            .collect()
            .await
            .map_err(|e| format!("list tables failed: {e}"))?;
        rows.iter()
            .filter_map(|r| {
                let name = r.as_ref(0).and_then(value_to_string)?;
                let kind = r.as_ref(1).and_then(value_to_string).unwrap_or_default();
                Some((name, kind.eq_ignore_ascii_case("VIEW")))
            })
            .collect()
    };

    let file = std::fs::File::create(&path).map_err(|e| format!("create file failed: {e}"))?;
    let mut w = std::io::BufWriter::new(file);
    let _ = writeln!(w, "-- balaudeck dump of `{database}`");
    let _ = writeln!(w, "SET FOREIGN_KEY_CHECKS=0;\n");

    let total_tables = tables.len();
    on_progress
        .send(DumpProgress::Start { tables: total_tables })
        .ok();

    // Fetch all row estimates in ONE metadata query. Per-table queries on a
    // database with hundreds of tables are slow and stall between tables.
    let mut estimates: HashMap<String, u64> = HashMap::new();
    if let Ok(mut meta) = conn
        .query_iter(format!(
            "SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA='{}'",
            database.replace('\'', "''")
        ))
        .await
    {
        if let Ok(rows) = meta.collect::<Row>().await {
            for r in &rows {
                if let Some(name) = r.as_ref(0).and_then(value_to_string) {
                    let n = r
                        .as_ref(1)
                        .and_then(value_to_string)
                        .and_then(|s| s.parse::<u64>().ok())
                        .unwrap_or(0);
                    estimates.insert(name, n);
                }
            }
        }
    }

    let mut count = 0usize;
    for (ti, (t, is_view)) in tables.iter().enumerate() {
        if ctl.cancelled.load(Ordering::Relaxed) {
            on_progress
                .send(DumpProgress::Cancelled { tables: ti, rows: count as u64 })
                .ok();
            return Ok(count);
        }

        let est = estimates.get(t).copied().unwrap_or(0);

        on_progress
            .send(DumpProgress::Table {
                name: t.clone(),
                index: ti + 1,
                total: total_tables,
                rows: est,
            })
            .ok();

        let ddl: Vec<Row> = conn
            .query_iter(format!("SHOW CREATE TABLE `{database}`.`{t}`"))
            .await
            .map_err(|e| format!("ddl failed for {t}: {e}"))?
            .collect()
            .await
            .map_err(|e| format!("ddl failed for {t}: {e}"))?;
        if let Some(create) = ddl.first().and_then(|r| r.as_ref(1)).and_then(value_to_string) {
            let drop_kw = if *is_view { "DROP VIEW IF EXISTS" } else { "DROP TABLE IF EXISTS" };
            let _ = writeln!(w, "{drop_kw} `{t}`;");
            let _ = writeln!(w, "{create};\n");
        }

        // Views have no data to stream — write only the definition.
        if *is_view {
            on_progress
                .send(DumpProgress::TableDone { name: t.clone(), rows: 0 })
                .ok();
            let _ = writeln!(w);
            continue;
        }

        let mut result = conn
            .query_iter(format!("SELECT * FROM `{database}`.`{t}`"))
            .await
            .map_err(|e| format!("select failed for {t}: {e}"))?;
        let mut written = 0u64;
        if let Some(mut stream) = result
            .stream::<Row>()
            .await
            .map_err(|e| format!("read failed for {t}: {e}"))?
        {
            while let Some(row) = stream.next().await {
                while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
                    tokio::time::sleep(Duration::from_millis(120)).await;
                }
                if ctl.cancelled.load(Ordering::Relaxed) {
                    break;
                }
                let row = row.map_err(|e| format!("read failed for {t}: {e}"))?;
                let vals: Vec<String> = (0..row.len())
                    .map(|i| match row.as_ref(i) {
                        Some(v) => sql_literal(v),
                        None => "NULL".to_string(),
                    })
                    .collect();
                writeln!(w, "INSERT INTO `{t}` VALUES ({});", vals.join(", "))
                    .map_err(|e| format!("write failed: {e}"))?;
                written += 1;
                count += 1;
                if written % 200 == 0 {
                    on_progress
                        .send(DumpProgress::Rows { written, total: est })
                        .ok();
                }
            }
        }
        drop(result);

        on_progress
            .send(DumpProgress::Rows { written, total: est })
            .ok();
        on_progress
            .send(DumpProgress::TableDone { name: t.clone(), rows: written })
            .ok();

        if ctl.cancelled.load(Ordering::Relaxed) {
            let _ = writeln!(w, "\nSET FOREIGN_KEY_CHECKS=1;");
            let _ = w.flush();
            on_progress
                .send(DumpProgress::Cancelled { tables: ti + 1, rows: count as u64 })
                .ok();
            return Ok(count);
        }

        let _ = writeln!(w);
    }

    let _ = writeln!(w, "SET FOREIGN_KEY_CHECKS=1;");
    w.flush().map_err(|e| format!("flush failed: {e}"))?;
    drop(conn);

    // For a local target the dump is finished now; send Done. For an S3 target
    // the export isn't complete until the upload lands, so Done is held back
    // until after upload_file succeeds (the frontend keys "Export complete" off
    // Done — sending it early would drop Cancel/Pause mid-upload).
    if s3.is_none() {
        on_progress
            .send(DumpProgress::Done { tables: total_tables, rows: count as u64 })
            .ok();
    }

    // Ship the staged dump to its S3 destination. The upload reports its own
    // progress/cancel under the transfer job id (a cancelled dump never gets
    // here — its early returns skip the upload and the guard cleans up). On an
    // upload failure the guard is disarmed so the staged dump survives, and the
    // error tells the user where it is instead of losing the only copy.
    if let Some(t) = &s3 {
        drop(w);
        let display = t.key.rsplit('/').next().unwrap_or(&t.key).to_string();
        if let Err(e) = crate::s3::upload_file(
            &app,
            &t.params,
            &t.bucket,
            &t.key,
            &path,
            t.transfer_job_id.as_deref(),
            &display,
        )
        .await
        {
            if let Some(g) = _tmp_guard.as_mut() {
                g.1 = false;
            }
            return Err(format!("{e} — dump left at {path}"));
        }
        on_progress
            .send(DumpProgress::Done { tables: total_tables, rows: count as u64 })
            .ok();
    }
    Ok(count)
}

#[derive(Serialize)]
pub struct ImportResult {
    pub executed: usize,
    pub failed: usize,
    pub error: Option<String>,
}

/// Progress messages streamed to the UI during an import.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportProgress {
    Start { total: usize },
    Progress { executed: usize, failed: usize, total: usize },
    /// A skipped statement when running in continue-on-error mode.
    StmtError { index: usize, error: String },
    Done { executed: usize, failed: usize },
    Cancelled { executed: usize, failed: usize },
    /// A fatal error that stopped the import (continue-on-error off).
    Failed { executed: usize, error: String },
}

/// Decode a dump file's bytes into a `String` using the named encoding
/// (`utf-8` default). Legacy MySQL dumps are often latin1/windows-1252 and
/// fail a strict UTF-8 read — `encoding_rs` decodes them, stripping any BOM
/// and mapping invalid bytes to U+FFFD rather than erroring.
fn decode_sql(bytes: &[u8], label: Option<&str>) -> String {
    let enc = label
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .and_then(|l| encoding_rs::Encoding::for_label(l.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    let (cow, _, _) = enc.decode(bytes);
    cow.into_owned()
}

/// Native import for PostgreSQL / SQL Server / SQLite. `autocommit_off` without
/// `continue_on_error` runs the whole file atomically in one transaction (via
/// `exec_ddl`); otherwise each statement runs on its own so failures are
/// isolated, progress streams, and pause/cancel are honoured.
#[allow(clippy::too_many_arguments)]
async fn engine_import_body(
    params: &DbConnectParams,
    database: &str,
    stmts: &[String],
    ctl: &Arc<JobCtl>,
    continue_on_error: bool,
    drop_first: bool,
    autocommit_off: bool,
    on_progress: &Channel<ImportProgress>,
) -> Result<ImportResult, String> {
    let engine = params.engine.as_str();
    let total = stmts.len();

    // Clean slate: drop existing tables in one FK-safe transaction.
    if drop_first && !database.is_empty() {
        let objs = crate::engines::schema_objects(params, database).await?;
        let drops: Vec<String> = objs
            .tables
            .iter()
            .map(|t| match engine {
                "postgres" => format!("DROP TABLE IF EXISTS {} CASCADE", q_ident(engine, t)),
                _ => format!("DROP TABLE IF EXISTS {}", q_ident(engine, t)),
            })
            .collect();
        if !drops.is_empty() {
            crate::engines::exec_ddl(params, database, &drops).await?;
        }
    }

    // Atomic fast path: one transaction for the whole file (no per-statement
    // isolation, so only when we're not skipping errors).
    if autocommit_off && !continue_on_error {
        if ctl.cancelled.load(Ordering::Relaxed) {
            on_progress
                .send(ImportProgress::Cancelled { executed: 0, failed: 0 })
                .ok();
            return Ok(ImportResult { executed: 0, failed: 0, error: None });
        }
        return match crate::engines::exec_ddl(params, database, stmts).await {
            Ok(()) => {
                on_progress
                    .send(ImportProgress::Done { executed: total, failed: 0 })
                    .ok();
                Ok(ImportResult { executed: total, failed: 0, error: None })
            }
            Err(e) => {
                on_progress
                    .send(ImportProgress::Failed { executed: 0, error: e.clone() })
                    .ok();
                Ok(ImportResult { executed: 0, failed: total, error: Some(e) })
            }
        };
    }

    // Per-statement path.
    let mut executed = 0usize;
    let mut failed = 0usize;
    for (idx, sql) in stmts.iter().enumerate() {
        while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        if ctl.cancelled.load(Ordering::Relaxed) {
            on_progress
                .send(ImportProgress::Cancelled { executed, failed })
                .ok();
            return Ok(ImportResult { executed, failed, error: None });
        }
        match crate::engines::query(params, sql, Some(0)).await {
            Ok(_) => executed += 1,
            Err(e) => {
                if continue_on_error {
                    failed += 1;
                    on_progress
                        .send(ImportProgress::StmtError { index: idx + 1, error: e })
                        .ok();
                } else {
                    on_progress
                        .send(ImportProgress::Failed { executed, error: e.clone() })
                        .ok();
                    return Ok(ImportResult { executed, failed, error: Some(e) });
                }
            }
        }
        if (idx + 1) % 50 == 0 {
            on_progress
                .send(ImportProgress::Progress { executed, failed, total })
                .ok();
        }
    }
    on_progress
        .send(ImportProgress::Done { executed, failed })
        .ok();
    Ok(ImportResult { executed, failed, error: None })
}

/// Read a `.sql` file and run its statements on one connection, into an
/// optional target database. Streams progress and obeys pause/cancel.
///
/// Options mirror a typical dump-import dialog:
/// - `continue_on_error`: skip a failing statement instead of aborting.
/// - `drop_first`: wipe every table/view in the target database first.
/// - `autocommit_off`: run the whole import inside one transaction
///   (`SET autocommit=0` … `COMMIT`) — much faster and all-or-nothing.
/// - `multi_query`: send statements in batches per round-trip; on a batch
///   error we fall back to statement-by-statement to isolate the culprit.
/// - `encoding`: charset used to decode the file (`utf-8` when omitted).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_import_file(
    params: DbConnectParams,
    path: String,
    database: Option<String>,
    import_id: String,
    continue_on_error: bool,
    drop_first: bool,
    autocommit_off: bool,
    multi_query: bool,
    encoding: Option<String>,
    on_progress: Channel<ImportProgress>,
) -> Result<ImportResult, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read file failed: {e}"))?;
    let sql = decode_sql(&bytes, encoding.as_deref());
    let stmts = split_statements(&sql);

    let ctl = Arc::new(JobCtl {
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
    });
    JOBS.lock().unwrap().insert(import_id.clone(), ctl.clone());
    let _guard = CtlGuard(import_id);

    let total = stmts.len();
    on_progress.send(ImportProgress::Start { total }).ok();

    // Non-MySQL engines import natively: run each statement through the engine
    // driver (MySQL's multi-statement batching doesn't apply).
    if crate::engines::handles(&params.engine) {
        let mut params = params;
        if let Some(db) = database.as_ref().filter(|d| !d.is_empty()) {
            params.database = Some(db.clone());
        }
        let db = params.database.clone().unwrap_or_default();
        return engine_import_body(
            &params,
            &db,
            &stmts,
            &ctl,
            continue_on_error,
            drop_first,
            autocommit_off,
            &on_progress,
        )
        .await;
    }

    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    if let Some(db) = &database {
        if !db.is_empty() {
            conn.query_drop(format!("USE `{db}`"))
                .await
                .map_err(|e| format!("use database failed: {e}"))?;
        }
    }

    // Optionally wipe the target database first (clean-slate import): drop every
    // existing table/view with FK checks off so drop order doesn't matter. Needs
    // a selected database — with none there's nothing to enumerate.
    if drop_first && database.as_deref().map(|d| !d.is_empty()).unwrap_or(false) {
        let objs: Vec<(String, String)> = conn
            .query("SHOW FULL TABLES")
            .await
            .map_err(|e| format!("list tables (drop first) failed: {e}"))?;
        let _ = conn.query_drop("SET FOREIGN_KEY_CHECKS=0").await;
        for (name, kind) in &objs {
            let sql = if kind.eq_ignore_ascii_case("VIEW") {
                format!("DROP VIEW IF EXISTS `{name}`")
            } else {
                format!("DROP TABLE IF EXISTS `{name}`")
            };
            if let Err(e) = conn.query_drop(&sql).await {
                let _ = conn.query_drop("SET FOREIGN_KEY_CHECKS=1").await;
                return Err(format!("drop `{name}` failed: {e}"));
            }
        }
        let _ = conn.query_drop("SET FOREIGN_KEY_CHECKS=1").await;
    }

    // Wrap the whole import in one transaction when requested: much faster (a
    // single fsync at COMMIT instead of one per statement) and atomic — a fatal
    // error or a cancel rolls everything back. Note MySQL DDL still commits
    // implicitly, so this mainly benefits the data (INSERT) portion.
    if autocommit_off {
        conn.query_drop("SET autocommit=0")
            .await
            .map_err(|e| format!("SET autocommit=0 failed: {e}"))?;
    }

    let mut executed = 0usize;
    let mut failed = 0usize;
    let mut last_report = 0usize;
    // How many statements to send per round-trip when batching is on.
    const BATCH: usize = 200;
    let mut idx = 0usize;

    // Batching sends many statements per round-trip, but MySQL applies a
    // multi-statement query up to the first error and stops — and the driver
    // won't tell us WHICH statement failed. That's fine when a single error
    // aborts the whole import (nothing to resume), but it's incompatible with
    // "continue on error", where we must skip one bad statement and keep the
    // rest. So batch only when continue-on-error is off; otherwise run
    // statement-by-statement so each failure is isolated exactly.
    let mut multi = multi_query && !continue_on_error;
    if multi {
        // Some servers reject multi-statement text queries; probe once and fall
        // back to per-statement rather than aborting a real import on stmt 1.
        if conn.query_drop("SELECT 1; SELECT 2").await.is_err() {
            multi = false;
        }
    }

    // Roll back the open transaction (if any) and restore autocommit. Best-effort.
    async fn unwind(conn: &mut mysql_async::Conn, active: bool) {
        if active {
            let _ = conn.query_drop("ROLLBACK").await;
            let _ = conn.query_drop("SET autocommit=1").await;
        }
    }

    while idx < total {
        // Honour pause, then cancel — rolling back the open transaction.
        while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        if ctl.cancelled.load(Ordering::Relaxed) {
            unwind(&mut conn, autocommit_off).await;
            on_progress
                .send(ImportProgress::Cancelled { executed, failed })
                .ok();
            return Ok(ImportResult { executed, failed, error: None });
        }

        let end = (idx + BATCH).min(total);
        if multi && end - idx > 1 {
            // Fast path: one round-trip for the whole batch. continue_on_error is
            // off here by construction, so any error aborts (and rolls back).
            if let Err(e) = conn.query_drop(stmts[idx..end].join(";\n")).await {
                let msg = format!("statements {}-{}: {e}", idx + 1, end);
                unwind(&mut conn, autocommit_off).await;
                on_progress
                    .send(ImportProgress::Failed { executed, error: msg.clone() })
                    .ok();
                return Ok(ImportResult { executed, failed, error: Some(msg) });
            }
            executed += end - idx;
            idx = end;
        } else {
            // Per-statement path: batching off, continue-on-error on, or the
            // trailing single statement.
            match conn.query_drop(&stmts[idx]).await {
                Ok(()) => executed += 1,
                Err(e) => {
                    if continue_on_error {
                        failed += 1;
                        on_progress
                            .send(ImportProgress::StmtError { index: idx + 1, error: format!("{e}") })
                            .ok();
                    } else {
                        let msg = format!("statement {}: {e}", idx + 1);
                        unwind(&mut conn, autocommit_off).await;
                        on_progress
                            .send(ImportProgress::Failed { executed, error: msg.clone() })
                            .ok();
                        return Ok(ImportResult { executed, failed, error: Some(msg) });
                    }
                }
            }
            idx += 1;
        }

        if idx == total || idx - last_report >= 20 {
            last_report = idx;
            on_progress
                .send(ImportProgress::Progress { executed, failed, total })
                .ok();
        }
    }

    // Commit the transaction. On failure roll back and report like any fatal error.
    if autocommit_off {
        if let Err(e) = conn.query_drop("COMMIT").await {
            let msg = format!("commit failed: {e}");
            unwind(&mut conn, true).await;
            on_progress
                .send(ImportProgress::Failed { executed, error: msg.clone() })
                .ok();
            return Ok(ImportResult { executed, failed, error: Some(msg) });
        }
        let _ = conn.query_drop("SET autocommit=1").await;
    }

    drop(conn);
    on_progress
        .send(ImportProgress::Done { executed, failed })
        .ok();
    Ok(ImportResult { executed, failed, error: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Integration test against the local docker MariaDB. Run with:
    /// `cargo test --ignored show_databases`
    #[tokio::test]
    #[ignore]
    async fn show_databases() {
        let params = DbConnectParams {
            engine: "mysql".into(),
            host: "127.0.0.1".into(),
            port: 3306,
            user: "root".into(),
            password: Some("12345".into()),
            database: None,
            file: None,
            profile_id: None,
            region: None,
            path_style: None,
            tls: None,
        };
        let r = db_query(params, "SHOW DATABASES;".into(), None).await.unwrap();
        assert!(!r.rows.is_empty(), "expected at least one database");
        assert_eq!(r.columns.len(), 1);
    }

    /// Verifies editable-source detection from column metadata against MariaDB.
    /// Run with `cargo test --ignored source_detection`.
    #[tokio::test]
    #[ignore]
    async fn source_detection() {
        fn params(db: Option<&str>) -> DbConnectParams {
            DbConnectParams {
                engine: "mysql".into(), host: "127.0.0.1".into(), port: 3306,
                user: "root".into(), password: Some("12345".into()),
                database: db.map(str::to_string), file: None, profile_id: None,
                region: None, path_style: None, tls: None,
            }
        }
        let db = "bdk_source_test";
        {
            let mut c = get_pool(&params(None)).get_conn().await.unwrap();
            c.query_drop(format!("DROP DATABASE IF EXISTS {db}")).await.unwrap();
            c.query_drop(format!("CREATE DATABASE {db}")).await.unwrap();
            c.query_drop(format!("USE {db}")).await.unwrap();
            c.query_drop("CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20))").await.unwrap();
            c.query_drop("CREATE TABLE u (id INT PRIMARY KEY, t_id INT)").await.unwrap();
            c.query_drop("INSERT INTO t VALUES (1,'a'),(2,'b')").await.unwrap();
            c.query_drop("INSERT INTO u VALUES (10,1)").await.unwrap();
        }
        let q = |sql: &str| db_query(params(Some(db)), sql.to_string(), None);

        // Plain single-table SELECT * -> editable source detected.
        let r = q("SELECT * FROM t").await.unwrap();
        assert_eq!((r.source_db.as_deref(), r.source_table.as_deref()), (Some(db), Some("t")), "SELECT *");

        // Subset of unaliased columns -> still detected.
        let r = q("SELECT name, id FROM t WHERE id > 0 ORDER BY id LIMIT 5").await.unwrap();
        assert_eq!(r.source_table.as_deref(), Some("t"), "subset unaliased");

        // Aliased column -> NOT detected (grid name != real column).
        let r = q("SELECT id, name AS label FROM t").await.unwrap();
        assert_eq!(r.source_table, None, "aliased column");

        // Computed column -> NOT detected.
        let r = q("SELECT id, name, NOW() FROM t").await.unwrap();
        assert_eq!(r.source_table, None, "computed column");

        // Columns spanning two tables -> NOT detected.
        let r = q("SELECT t.name, u.t_id FROM t JOIN u ON u.t_id = t.id").await.unwrap();
        assert_eq!(r.source_table, None, "columns from two tables");

        // Self-join: columns from two ALIASES of the same table -> NOT detected
        // (a pk UPDATE mixing both aliases' columns would corrupt the wrong row).
        let r = q("SELECT a.id, b.name FROM t a JOIN t b ON b.id = a.id").await.unwrap();
        assert_eq!(r.source_table, None, "self-join (two aliases of one table)");

        get_pool(&params(None)).get_conn().await.unwrap()
            .query_drop(format!("DROP DATABASE {db}")).await.unwrap();
    }

    /// MySQL table introspection (designer Design mode) against the local
    /// MariaDB. Run with `cargo test --ignored mysql_table_schema`.
    #[tokio::test]
    #[ignore]
    async fn mysql_table_schema_smoke() {
        fn params(db: Option<&str>) -> DbConnectParams {
            DbConnectParams {
                engine: "mysql".into(), host: "127.0.0.1".into(), port: 3306,
                user: "root".into(), password: Some("12345".into()),
                database: db.map(str::to_string), file: None, profile_id: None,
                region: None, path_style: None, tls: None,
            }
        }
        let db = "bdk_schema_test";
        {
            let mut c = get_pool(&params(None)).get_conn().await.unwrap();
            c.query_drop(format!("DROP DATABASE IF EXISTS {db}")).await.unwrap();
            c.query_drop(format!("CREATE DATABASE {db}")).await.unwrap();
            c.query_drop(format!("USE {db}")).await.unwrap();
            c.query_drop("CREATE TABLE parent (id BIGINT PRIMARY KEY, name VARCHAR(50))").await.unwrap();
            c.query_drop(
                "CREATE TABLE child (\
                   id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, \
                   parent_id BIGINT, \
                   note VARCHAR(120) NOT NULL DEFAULT 'x', \
                   CONSTRAINT fk_parent FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE, \
                   KEY idx_note (note))",
            ).await.unwrap();
        }
        let s = db_table_schema(params(Some(db)), db.into(), "child".into()).await.unwrap();
        let id = s.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id.pk && id.auto_increment, "id should be PK + auto_increment");
        assert!(id.data_type.contains("unsigned"), "unsigned preserved: {}", id.data_type);
        let note = s.columns.iter().find(|c| c.name == "note").unwrap();
        assert_eq!(note.length, "120");
        assert!(!note.nullable);
        assert!(note.default.contains('x'));
        assert_eq!(s.foreign_keys.len(), 1);
        assert_eq!(s.foreign_keys[0].name, "fk_parent");
        assert_eq!(s.foreign_keys[0].ref_table, "parent");
        assert_eq!(s.foreign_keys[0].on_delete, "CASCADE");
        assert!(s.indexes.iter().any(|i| i.name == "idx_note" && i.columns == vec!["note".to_string()]));

        get_pool(&params(None)).get_conn().await.unwrap()
            .query_drop(format!("DROP DATABASE {db}")).await.unwrap();
    }

    /// User-management round-trip against the local MySQL/MariaDB: create an
    /// isolated account with a grant + limit, list it, read its detail, drop it.
    /// `cargo test --ignored mysql_user_mgmt`.
    #[tokio::test]
    #[ignore]
    async fn mysql_user_mgmt_smoke() {
        fn params() -> DbConnectParams {
            DbConnectParams {
                engine: "mysql".into(), host: "127.0.0.1".into(), port: 3306,
                user: "root".into(), password: Some("12345".into()),
                database: None, file: None, profile_id: None,
                region: None, path_style: None, tls: None,
            }
        }
        let _ = db_exec_user_sql(params(), vec!["DROP USER IF EXISTS 'bdk_um'@'%'".into()]).await;
        db_exec_user_sql(params(), vec![
            "CREATE USER 'bdk_um'@'%' IDENTIFIED BY 'sekret'".into(),
            "GRANT SELECT, INSERT ON `mysql`.* TO 'bdk_um'@'%'".into(),
            "GRANT USAGE ON *.* TO 'bdk_um'@'%' WITH MAX_USER_CONNECTIONS 5".into(),
        ]).await.expect("create + grant");

        let users = db_list_users(params()).await.expect("list");
        assert!(users.iter().any(|u| u.name == "bdk_um" && u.host == "%"), "bdk_um listed");

        let detail = db_user_detail(params(), "bdk_um".into(), "%".into()).await.expect("detail");
        println!("GRANTS: {:?}", detail.grants);
        assert_eq!(detail.attributes.max_user_connections, 5, "limit round-trips");
        assert!(detail.grants.iter().any(|g| g.contains("SELECT")), "SELECT grant present");

        db_exec_user_sql(params(), vec!["DROP USER 'bdk_um'@'%'".into()]).await.expect("drop");
        let after = db_list_users(params()).await.expect("list2");
        assert!(!after.iter().any(|u| u.name == "bdk_um"), "bdk_um dropped");

        // Non-transactional contract: a bad middle statement leaves earlier ones applied.
        let _ = db_exec_user_sql(params(), vec!["DROP USER IF EXISTS 'bdk_um2'@'%'".into()]).await;
        let err = db_exec_user_sql(params(), vec![
            "CREATE USER 'bdk_um2'@'%' IDENTIFIED BY 'x'".into(),
            "GRANT BOGUSPRIV ON *.* TO 'bdk_um2'@'%'".into(),
        ]).await;
        assert!(err.is_err(), "bad statement errors");
        assert!(format!("{}", err.unwrap_err()).contains("statement 2"), "reports failing index");
        let after2 = db_list_users(params()).await.expect("list3");
        assert!(after2.iter().any(|u| u.name == "bdk_um2"), "stmt 1 committed despite stmt 2 failing");
        db_exec_user_sql(params(), vec!["DROP USER 'bdk_um2'@'%'".into()]).await.expect("cleanup");
    }

    /// SQLite dump -> import round-trip (self-contained, no server).
    /// `cargo test --ignored sqlite_dump_import`.
    #[tokio::test]
    #[ignore]
    async fn sqlite_dump_import_roundtrip() {
        use tauri::ipc::Channel;
        let src = format!("{}/bdk-dump-src.sqlite", std::env::temp_dir().display());
        let dst = format!("{}/bdk-dump-dst.sqlite", std::env::temp_dir().display());
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
        {
            let c = rusqlite::Connection::open(&src).unwrap();
            c.execute_batch(
                "CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, qty INT);\
                 INSERT INTO t(name,qty) VALUES('a',1),('O''Brien',2),('c',NULL);\
                 CREATE INDEX idx_name ON t(name);",
            )
            .unwrap();
            rusqlite::Connection::open(&dst).unwrap(); // empty destination
        }
        fn p(file: &str) -> DbConnectParams {
            DbConnectParams {
                engine: "sqlite".into(), host: String::new(), port: 0, user: String::new(),
                password: None, database: None, file: Some(file.into()), profile_id: None,
                region: None, path_style: None, tls: None,
            }
        }
        let ctl = Arc::new(JobCtl { cancelled: AtomicBool::new(false), paused: AtomicBool::new(false) });
        let mut buf: Vec<u8> = Vec::new();
        let dch: Channel<DumpProgress> = Channel::new(|_| Ok(()));
        let (rows, tables) = engine_dump_body(&p(&src), "main", None, &mut buf, &ctl, &dch).await.unwrap();
        assert_eq!((rows, tables), (3, 1));
        let dump = String::from_utf8(buf).unwrap();
        println!("--- SQLITE DUMP ---\n{dump}");

        let stmts = split_statements(&dump);
        let ich: Channel<ImportProgress> = Channel::new(|_| Ok(()));
        let res = engine_import_body(&p(&dst), "main", &stmts, &ctl, false, false, false, &ich).await.unwrap();
        assert_eq!(res.failed, 0, "import failed: {:?}", res.error);

        let q = crate::engines::query(&p(&dst), "SELECT id,name,qty FROM t ORDER BY id", None).await.unwrap();
        assert_eq!(q.rows.len(), 3);
        assert_eq!(q.rows[1][1].as_deref(), Some("O'Brien"), "quote round-trip");
        assert_eq!(q.rows[2][2], None, "NULL preserved");
        let idx = crate::engines::query(&p(&dst), "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='t'", None).await.unwrap();
        assert!(idx.rows.iter().any(|r| r[0].as_deref() == Some("idx_name")), "index recreated");
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }

    /// Postgres dump -> import into a fresh database. Needs the balau demo PG on
    /// :55432. `cargo test --ignored pg_dump_import`.
    #[tokio::test]
    #[ignore]
    async fn pg_dump_import_roundtrip() {
        use tauri::ipc::Channel;
        fn p(db: &str) -> DbConnectParams {
            DbConnectParams {
                engine: "postgres".into(), host: "127.0.0.1".into(), port: 55432,
                user: "postgres".into(), password: Some("demopass".into()),
                database: Some(db.into()), file: None, profile_id: None,
                region: None, path_style: None, tls: None,
            }
        }
        // Seed a single source table; recreate a fresh destination database.
        for sql in [
            "DROP TABLE IF EXISTS dt",
            "CREATE TABLE dt(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name text NOT NULL, qty int)",
            "INSERT INTO dt(name,qty) VALUES ('a',1),('O''Brien',2),('c',NULL)",
        ] {
            crate::engines::query(&p("demo"), sql, None).await.expect(sql);
        }
        crate::engines::query(&p("postgres"), "DROP DATABASE IF EXISTS demo_dst", None).await.expect("drop dst");
        crate::engines::query(&p("postgres"), "CREATE DATABASE demo_dst", None).await.expect("create dst");

        let ctl = Arc::new(JobCtl { cancelled: AtomicBool::new(false), paused: AtomicBool::new(false) });
        let mut buf: Vec<u8> = Vec::new();
        let dch: Channel<DumpProgress> = Channel::new(|_| Ok(()));
        let (rows, _) = engine_dump_body(&p("demo"), "demo", Some("dt".into()), &mut buf, &ctl, &dch).await.unwrap();
        assert_eq!(rows, 3);
        let dump = String::from_utf8(buf).unwrap();
        println!("--- PG DUMP ---\n{dump}");

        let stmts = split_statements(&dump);
        let ich: Channel<ImportProgress> = Channel::new(|_| Ok(()));
        let res = engine_import_body(&p("demo_dst"), "demo_dst", &stmts, &ctl, false, false, false, &ich).await.unwrap();
        assert_eq!(res.failed, 0, "import failed: {:?}", res.error);

        let q = crate::engines::query(&p("demo_dst"), "SELECT id,name,qty FROM dt ORDER BY id", None).await.unwrap();
        assert_eq!(q.rows.len(), 3);
        assert_eq!(q.rows[1][1].as_deref(), Some("O'Brien"), "quote round-trip");
        assert_eq!(q.rows[2][2], None, "NULL preserved");
        crate::engines::query(&p("postgres"), "DROP DATABASE demo_dst", None).await.ok();
    }

    /// Manual-transaction lifecycle against the local MariaDB: a row inserted in
    /// an open transaction is invisible to a separate (pooled) connection until
    /// commit, and vanishes on rollback. Run with `cargo test --ignored manual_tx`.
    #[tokio::test]
    #[ignore]
    async fn manual_tx() {
        fn params(db: Option<&str>) -> DbConnectParams {
            DbConnectParams {
                engine: "mysql".into(), host: "127.0.0.1".into(), port: 3306,
                user: "root".into(), password: Some("12345".into()),
                database: db.map(str::to_string), file: None, profile_id: None,
                region: None, path_style: None, tls: None,
            }
        }
        let db = "bdk_tx_test";
        {
            let mut c = get_pool(&params(None)).get_conn().await.unwrap();
            c.query_drop(format!("DROP DATABASE IF EXISTS {db}")).await.unwrap();
            c.query_drop(format!("CREATE DATABASE {db}")).await.unwrap();
            c.query_drop(format!("USE {db}")).await.unwrap();
            c.query_drop("CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(20))").await.unwrap();
        }
        // count() reads via a SEPARATE pooled connection (autocommit), so it only
        // sees committed rows.
        let count = |db: &str| {
            let p = params(Some(db));
            async move {
                let r = db_query(p, "SELECT COUNT(*) FROM t".into(), None).await.unwrap();
                r.rows[0][0].clone().unwrap().parse::<i64>().unwrap()
            }
        };

        // Rollback path: insert inside a tx, unseen outside, gone after rollback.
        db_tx_begin(params(Some(db)), "s-roll".into()).await.unwrap();
        db_tx_exec("s-roll".into(), "INSERT INTO t VALUES (1,'a')".into(), None).await.unwrap();
        assert_eq!(count(db).await, 0, "uncommitted insert must be invisible to other conns");
        db_tx_rollback("s-roll".into()).await.unwrap();
        assert_eq!(count(db).await, 0, "rollback must discard the insert");

        // Commit path: insert inside a tx, then it persists after commit.
        db_tx_begin(params(Some(db)), "s-commit".into()).await.unwrap();
        db_tx_exec("s-commit".into(), "INSERT INTO t VALUES (2,'b')".into(), None).await.unwrap();
        assert_eq!(count(db).await, 0, "still invisible before commit");
        db_tx_commit("s-commit".into()).await.unwrap();
        assert_eq!(count(db).await, 1, "commit must persist the insert");

        // Exec after finish must error (session removed).
        assert!(db_tx_exec("s-commit".into(), "SELECT 1".into(), None).await.is_err());

        get_pool(&params(None)).get_conn().await.unwrap()
            .query_drop(format!("DROP DATABASE {db}")).await.unwrap();
    }

    #[test]
    fn decode_latin1_and_bom() {
        // 0xE9 = é in latin1/windows-1252; would be invalid UTF-8.
        assert_eq!(decode_sql(&[b'c', b'a', b'f', b'\xe9'], Some("windows-1252")), "café");
        assert_eq!(decode_sql(&[b'c', b'a', b'f', b'\xe9'], Some("latin1")), "café");
        // UTF-8 BOM is stripped.
        assert_eq!(decode_sql(&[0xEF, 0xBB, 0xBF, b'h', b'i'], Some("utf-8")), "hi");
        // Empty/None label falls back to UTF-8.
        assert_eq!(decode_sql(b"plain", None), "plain");
    }

    /// Verifies the two behaviours the import loop relies on against the local
    /// MariaDB: (a) mysql_async accepts a `;`-joined multi-statement query_drop
    /// (the batching fast-path), and (b) autocommit=0 + ROLLBACK actually undoes
    /// inserted rows. Run with `cargo test --ignored import_primitives`.
    #[tokio::test]
    #[ignore]
    async fn import_primitives() {
        let params = DbConnectParams {
            engine: "mysql".into(),
            host: "127.0.0.1".into(),
            port: 3306,
            user: "root".into(),
            password: Some("12345".into()),
            database: None,
            file: None,
            profile_id: None,
            region: None,
            path_style: None,
            tls: None,
        };
        let pool = get_pool(&params);
        let mut conn = pool.get_conn().await.unwrap();
        conn.query_drop("DROP DATABASE IF EXISTS balaudeck_import_test").await.unwrap();
        conn.query_drop("CREATE DATABASE balaudeck_import_test").await.unwrap();
        conn.query_drop("USE balaudeck_import_test").await.unwrap();

        // (a) multi-statement batch in ONE query_drop call.
        let batch = "CREATE TABLE t (id INT PRIMARY KEY);\n\
                     INSERT INTO t VALUES (1);\n\
                     INSERT INTO t VALUES (2);\n\
                     INSERT INTO t VALUES (3)";
        conn.query_drop(batch).await.expect("multi-statement query_drop must succeed");
        let n: Option<i64> = conn.query_first("SELECT COUNT(*) FROM t").await.unwrap();
        assert_eq!(n, Some(3), "all 3 batched inserts should have landed");

        // (b) autocommit=0 + ROLLBACK undoes work.
        conn.query_drop("SET autocommit=0").await.unwrap();
        conn.query_drop("INSERT INTO t VALUES (4)").await.unwrap();
        conn.query_drop("ROLLBACK").await.unwrap();
        conn.query_drop("SET autocommit=1").await.unwrap();
        let n: Option<i64> = conn.query_first("SELECT COUNT(*) FROM t").await.unwrap();
        assert_eq!(n, Some(3), "rolled-back insert must not persist");

        conn.query_drop("DROP DATABASE balaudeck_import_test").await.unwrap();
    }

    /// End-to-end exercise of `db_import_file` against the local MariaDB,
    /// covering the clean batched path, the per-statement fallback when a batch
    /// hits a bad statement, and transaction rollback on a fatal error.
    /// Run with `cargo test --ignored import_command_e2e`.
    #[tokio::test]
    #[ignore]
    async fn import_command_e2e() {
        use std::io::Write;
        fn params(db: Option<&str>) -> DbConnectParams {
            DbConnectParams {
                engine: "mysql".into(),
                host: "127.0.0.1".into(),
                port: 3306,
                user: "root".into(),
                password: Some("12345".into()),
                database: db.map(|s| s.to_string()),
                file: None,
                profile_id: None,
                region: None,
                path_style: None,
                tls: None,
            }
        }
        let db = "balaudeck_import_e2e";
        let noop = || Channel::<ImportProgress>::new(|_| Ok(()));
        let write_sql = |name: &str, body: &str| -> String {
            let p = std::env::temp_dir().join(name);
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(body.as_bytes()).unwrap();
            p.to_string_lossy().into_owned()
        };
        async fn count(p: &DbConnectParams) -> i64 {
            let mut c = get_pool(p).get_conn().await.unwrap();
            c.query_first::<i64, _>("SELECT COUNT(*) FROM t").await.unwrap().unwrap()
        }

        // Fresh DB with an empty committed table `t`.
        {
            let mut c = get_pool(&params(None)).get_conn().await.unwrap();
            c.query_drop(format!("DROP DATABASE IF EXISTS {db}")).await.unwrap();
            c.query_drop(format!("CREATE DATABASE {db}")).await.unwrap();
            c.query_drop(format!("USE {db}")).await.unwrap();
            c.query_drop("CREATE TABLE t (id INT PRIMARY KEY)").await.unwrap();
        }
        let p = params(Some(db));

        // (A) clean import of 250 rows spanning two batches, in one transaction.
        let mut body = String::new();
        for i in 1..=250 {
            body.push_str(&format!("INSERT INTO t VALUES ({i});\n"));
        }
        let f = write_sql("bdk_e2e_clean.sql", &body);
        let r = db_import_file(params(Some(db)), f, Some(db.into()), "e2e-a".into(), false, false, true, true, None, noop())
            .await
            .unwrap();
        assert_eq!((r.executed, r.failed, r.error.is_some()), (250, 0, false), "clean batched import");
        assert_eq!(count(&p).await, 250);

        // (B) continue_on_error + a duplicate mid-file: multi_query is coerced off
        // (can't safely skip inside a batch), so it runs per-statement, skips the
        // one dup, and commits the rest of the transaction.
        let mut body = String::new();
        for i in 251..=400 {
            body.push_str(&format!("INSERT INTO t VALUES ({i});\n"));
        }
        body.push_str("INSERT INTO t VALUES (1);\n"); // duplicate of (A)
        for i in 401..=420 {
            body.push_str(&format!("INSERT INTO t VALUES ({i});\n"));
        }
        let f = write_sql("bdk_e2e_dup.sql", &body);
        // continue_on_error=true, autocommit_off=true, multi_query=true.
        let r = db_import_file(params(Some(db)), f, Some(db.into()), "e2e-b".into(), true, false, true, true, None, noop())
            .await
            .unwrap();
        assert_eq!(r.failed, 1, "exactly the duplicate should fail");
        assert_eq!(r.executed, 170, "150 + 20 good inserts");
        assert_eq!(count(&p).await, 420);

        // (C) fatal error, per-statement path, autocommit_off: rows before it roll back.
        let before = count(&p).await;
        let body = "INSERT INTO t VALUES (900);\n\
                    INSERT INTO t VALUES (901);\n\
                    INSERT INTO t VALUES (900);\n\
                    INSERT INTO t VALUES (902);\n";
        let f = write_sql("bdk_e2e_fatal.sql", body);
        // continue_on_error=false, autocommit_off=true, multi_query=false.
        let r = db_import_file(params(Some(db)), f, Some(db.into()), "e2e-c".into(), false, false, true, false, None, noop())
            .await
            .unwrap();
        assert!(r.error.is_some(), "fatal error expected (per-statement)");
        assert_eq!(count(&p).await, before, "transaction rolled back the inserts");

        // (D) fatal error inside a BATCH (multi_query on, continue off): the batch
        // aborts and the whole transaction rolls back — nothing persists.
        let before = count(&p).await;
        let body = "INSERT INTO t VALUES (930);\n\
                    INSERT INTO t VALUES (931);\n\
                    INSERT INTO t VALUES (930);\n\
                    INSERT INTO t VALUES (932);\n";
        let f = write_sql("bdk_e2e_batch_fatal.sql", body);
        // continue_on_error=false, autocommit_off=true, multi_query=true.
        let r = db_import_file(params(Some(db)), f, Some(db.into()), "e2e-d".into(), false, false, true, true, None, noop())
            .await
            .unwrap();
        assert!(r.error.is_some(), "fatal error expected (batched)");
        assert!(r.error.as_deref().unwrap().contains("statements 1-4"), "reports the batch range");
        assert_eq!(count(&p).await, before, "batch abort rolled back the transaction");

        get_pool(&params(None)).get_conn().await.unwrap()
            .query_drop(format!("DROP DATABASE {db}")).await.unwrap();
    }
}
