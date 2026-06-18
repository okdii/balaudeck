//! MySQL/MariaDB client built on mysql_async.
//! Spike-quality for Fasa 0; grows into the full Fasa 5 implementation.

use futures_util::StreamExt;
use mysql_async::prelude::*;
use mysql_async::{Opts, OptsBuilder, Pool, Row, Value};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;

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
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    /// When set, a missing password is pulled from the keychain for this profile.
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub rows_affected: u64,
    pub elapsed_ms: u128,
    /// True when more rows were available but the fetch stopped at `max_rows`.
    pub truncated: bool,
}

fn resolve_password(p: &DbConnectParams) -> String {
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
        .prefer_socket(false);
    Opts::from(builder)
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

    let columns: Vec<String> = result
        .columns()
        .map(|cols| cols.iter().map(|c| c.name_str().into_owned()).collect())
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
        rows,
        rows_affected,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
    })
}

/// Close and drop the cached pool for a connection (called on disconnect).
#[tauri::command]
pub async fn db_disconnect(params: DbConnectParams) -> Result<(), String> {
    let key = pool_key(&params);
    let pool = POOLS.lock().unwrap().remove(&key);
    if let Some(pool) = pool {
        let _ = pool.disconnect().await;
    }
    Ok(())
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

/// Dump a whole database (or one table) to a `.sql` file: schema + INSERTs.
/// Streams progress over `on_progress`; obeys pause/cancel via `export_id`.
/// Returns the number of data rows written.
#[tauri::command]
pub async fn db_dump(
    params: DbConnectParams,
    database: String,
    table: Option<String>,
    path: String,
    export_id: String,
    on_progress: Channel<DumpProgress>,
) -> Result<usize, String> {
    use std::io::Write;

    let ctl = Arc::new(JobCtl {
        cancelled: AtomicBool::new(false),
        paused: AtomicBool::new(false),
    });
    JOBS.lock().unwrap().insert(export_id.clone(), ctl.clone());
    let _guard = CtlGuard(export_id);

    let pool = get_pool(&params);
    let mut conn = pool
        .get_conn()
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    let tables: Vec<String> = if let Some(t) = table {
        vec![t]
    } else {
        let rows: Vec<Row> = conn
            .query_iter(format!("SHOW TABLES FROM `{database}`"))
            .await
            .map_err(|e| format!("list tables failed: {e}"))?
            .collect()
            .await
            .map_err(|e| format!("list tables failed: {e}"))?;
        rows.iter()
            .filter_map(|r| r.as_ref(0).and_then(value_to_string))
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

    let mut count = 0usize;
    for (ti, t) in tables.iter().enumerate() {
        if ctl.cancelled.load(Ordering::Relaxed) {
            on_progress
                .send(DumpProgress::Cancelled { tables: ti, rows: count as u64 })
                .ok();
            return Ok(count);
        }

        // Approximate row count for the progress bar (instant, from metadata).
        let est: u64 = conn
            .query_first::<u64, _>(format!(
                "SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA='{}' AND TABLE_NAME='{}'",
                database.replace('\'', "''"),
                t.replace('\'', "''")
            ))
            .await
            .ok()
            .flatten()
            .unwrap_or(0);

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
            let _ = writeln!(w, "DROP TABLE IF EXISTS `{t}`;");
            let _ = writeln!(w, "{create};\n");
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
    on_progress
        .send(DumpProgress::Done { tables: total_tables, rows: count as u64 })
        .ok();
    Ok(count)
}

#[derive(Serialize)]
pub struct ImportResult {
    pub executed: usize,
    pub error: Option<String>,
}

/// Progress messages streamed to the UI during an import.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportProgress {
    Start { total: usize },
    Progress { executed: usize, total: usize },
    Done { executed: usize },
    Cancelled { executed: usize },
    Failed { executed: usize, error: String },
}

/// Read a `.sql` file and run its statements on one connection, into an
/// optional target database. Streams progress and obeys pause/cancel.
#[tauri::command]
pub async fn db_import_file(
    params: DbConnectParams,
    path: String,
    database: Option<String>,
    import_id: String,
    on_progress: Channel<ImportProgress>,
) -> Result<ImportResult, String> {
    let sql = std::fs::read_to_string(&path).map_err(|e| format!("read file failed: {e}"))?;
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

    let mut executed = 0usize;
    for stmt in &stmts {
        while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
        if ctl.cancelled.load(Ordering::Relaxed) {
            on_progress.send(ImportProgress::Cancelled { executed }).ok();
            return Ok(ImportResult { executed, error: None });
        }
        if let Err(e) = conn.query_drop(stmt).await {
            let msg = format!("statement {}: {e}", executed + 1);
            on_progress
                .send(ImportProgress::Failed { executed, error: msg.clone() })
                .ok();
            return Ok(ImportResult { executed, error: Some(msg) });
        }
        executed += 1;
        if executed == 1 || executed % 20 == 0 || executed == total {
            on_progress
                .send(ImportProgress::Progress { executed, total })
                .ok();
        }
    }
    drop(conn);
    on_progress.send(ImportProgress::Done { executed }).ok();
    Ok(ImportResult { executed, error: None })
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
            host: "127.0.0.1".into(),
            port: 3306,
            user: "root".into(),
            password: Some("12345".into()),
            database: None,
            profile_id: None,
        };
        let r = db_query(params, "SHOW DATABASES;".into(), None).await.unwrap();
        assert!(!r.rows.is_empty(), "expected at least one database");
        assert_eq!(r.columns.len(), 1);
    }
}
