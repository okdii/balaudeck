//! MySQL/MariaDB client built on mysql_async.
//! Spike-quality for Fasa 0; grows into the full Fasa 5 implementation.

use futures_util::StreamExt;
use mysql_async::consts::ColumnType;
use mysql_async::prelude::*;
use mysql_async::{Column, Opts, OptsBuilder, Pool, Row, TxOpts, Value};
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
    let started = std::time::Instant::now();
    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

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

    // Return the connection to the pool (do not disconnect — the pool is reused).
    drop(conn);

    Ok(QueryResult {
        columns,
        binary_cols,
        rows,
        rows_affected,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
    })
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
