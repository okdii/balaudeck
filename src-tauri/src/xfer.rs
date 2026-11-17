//! Cross-engine Data Transfer (e.g. MySQL → PostgreSQL, SQLite → SQL Server).
//!
//! The frontend owns the schema side: it introspects each source table, maps it
//! to the target dialect with the same DDL generator the table designer uses,
//! and hands us the target `CREATE` statements plus "post" statements (foreign
//! keys, identity/sequence resets) to run after the data. This module copies the
//! rows: it pages through the source with a SELECT that normalises awkward types
//! to portable text (booleans → 0/1, binary → hex, timestamps → ISO text), and
//! writes multi-row INSERTs with literals in the target's own dialect.

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Deserialize;
use tauri::ipc::Channel;

use crate::db::{q_ident, DbConnectParams, DumpProgress, ImportProgress, ImportResult, JobCtl, QueryResult};

/// Portable value class of a column (from the frontend's canonical type).
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Int,
    Num,
    Bool,
    Text,
    Blob,
    Datetime,
    Date,
    Time,
}

#[derive(Deserialize, Clone, Debug)]
pub struct XCol {
    pub name: String,
    pub kind: Kind,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct XTable {
    pub table: String,
    /// Target-dialect statements creating the table (empty = keep existing).
    #[serde(default)]
    pub create: Vec<String>,
    pub data: bool,
    pub columns: Vec<XCol>,
    /// Columns to page by (the primary key); falls back to the first column.
    #[serde(default)]
    pub order_by: Vec<String>,
    /// SQL Server target: the table has an IDENTITY column, so explicit ids need
    /// `SET IDENTITY_INSERT … ON` around each batch.
    #[serde(default)]
    pub identity: bool,
}

const PAGE: usize = 2000;
const BATCH_ROWS: usize = 500; // SQL Server caps VALUES at 1000 rows; SQLite's compound limit is 500
const BATCH_BYTES: usize = 2 * 1024 * 1024;

fn mysqlish(e: &str) -> bool {
    e == "mysql" || e == "mariadb"
}

async fn run(p: &DbConnectParams, sql: &str) -> Result<QueryResult, String> {
    if crate::engines::handles(&p.engine) {
        crate::engines::query(p, sql, None).await
    } else {
        crate::db::db_query(p.clone(), sql.to_string(), None).await
    }
}

async fn exec_ddl(p: &DbConnectParams, db: &str, stmts: &[String]) -> Result<(), String> {
    crate::db::db_exec_ddl(p.clone(), db.to_string(), stmts.to_vec()).await
}

/// How a table is named in SQL on `engine`: MySQL qualifies with the database;
/// the others are connected to the database already.
fn table_ref(engine: &str, db: &str, table: &str) -> String {
    if mysqlish(engine) {
        format!("{}.{}", q_ident(engine, db), q_ident(engine, table))
    } else {
        q_ident(engine, table)
    }
}

/// The SELECT expression reading column `c` as portable text.
pub(crate) fn read_expr(engine: &str, c: &XCol) -> String {
    let q = q_ident(engine, &c.name);
    match (engine, c.kind) {
        (e, Kind::Blob) if mysqlish(e) => format!("HEX({q})"),
        (e, Kind::Datetime | Kind::Date | Kind::Time) if mysqlish(e) => format!("CAST({q} AS CHAR)"),
        ("postgres", Kind::Bool) => format!("CASE WHEN {q} THEN '1' WHEN NOT {q} THEN '0' END"),
        ("postgres", Kind::Blob) => format!("encode({q}, 'hex')"),
        ("postgres", Kind::Datetime) => format!("to_char({q}, 'YYYY-MM-DD HH24:MI:SS.US')"),
        ("postgres", _) => format!("{q}::text"),
        ("mssql", Kind::Blob) => format!("CONVERT(varchar(max), {q}, 2)"),
        ("mssql", Kind::Bool) => format!("CAST({q} AS int)"),
        ("mssql", Kind::Datetime) => format!("CONVERT(varchar(27), {q}, 121)"),
        ("mssql", Kind::Date) => format!("CONVERT(varchar(10), {q}, 23)"),
        ("mssql", Kind::Time) => format!("CONVERT(varchar(8), {q}, 108)"),
        ("mssql", Kind::Text) => format!("CAST({q} AS nvarchar(max))"),
        ("sqlite", Kind::Blob) => format!("hex({q})"),
        _ => q,
    }
}

fn page_sql(engine: &str, db: &str, t: &XTable, offset: usize) -> String {
    let cols = t.columns.iter().map(|c| read_expr(engine, c)).collect::<Vec<_>>().join(", ");
    let order: Vec<&String> = if t.order_by.is_empty() {
        t.columns.first().map(|c| vec![&c.name]).unwrap_or_default()
    } else {
        t.order_by.iter().collect()
    };
    let order = order.iter().map(|c| q_ident(engine, c)).collect::<Vec<_>>().join(", ");
    let from = table_ref(engine, db, &t.table);
    if engine == "mssql" {
        let order = if order.is_empty() { "(SELECT NULL)".to_string() } else { order };
        format!("SELECT {cols} FROM {from} ORDER BY {order} OFFSET {offset} ROWS FETCH NEXT {PAGE} ROWS ONLY")
    } else if order.is_empty() {
        format!("SELECT {cols} FROM {from} LIMIT {PAGE} OFFSET {offset}")
    } else {
        format!("SELECT {cols} FROM {from} ORDER BY {order} LIMIT {PAGE} OFFSET {offset}")
    }
}

fn is_number(s: &str) -> bool {
    let s = s.trim();
    let b = s.strip_prefix('-').unwrap_or(s);
    !b.is_empty()
        && b.chars().all(|c| c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')
        && b.chars().next().is_some_and(|c| c.is_ascii_digit())
        && s.parse::<f64>().is_ok()
}

/// One value as a literal in the TARGET dialect.
pub(crate) fn literal(engine: &str, kind: Kind, v: &Option<String>) -> String {
    let Some(s) = v else { return "NULL".into() };
    match kind {
        Kind::Blob => {
            let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
            return match engine {
                "postgres" => format!("decode('{hex}', 'hex')"),
                "mssql" => format!("0x{hex}"),
                _ => format!("X'{hex}'"),
            };
        }
        // MySQL "zero" dates aren't valid anywhere else.
        Kind::Datetime | Kind::Date if s.starts_with("0000-00-00") => return "NULL".into(),
        Kind::Bool => {
            let b = match s.trim().to_ascii_lowercase().as_str() {
                "1" | "t" | "true" | "y" | "yes" | "on" => "1",
                "0" | "f" | "false" | "n" | "no" | "off" => "0",
                _ => "",
            };
            if !b.is_empty() {
                return if engine == "postgres" { format!("'{b}'") } else { b.into() };
            }
        }
        Kind::Int | Kind::Num if is_number(s) => return s.trim().to_string(),
        _ => {}
    }
    let mut body = s.replace('\'', "''");
    if mysqlish(engine) {
        body = body.replace('\\', "\\\\");
    }
    if engine == "mssql" {
        format!("N'{body}'")
    } else {
        format!("'{body}'")
    }
}

fn insert_head(engine: &str, db: &str, t: &XTable) -> String {
    let cols = t.columns.iter().map(|c| q_ident(engine, &c.name)).collect::<Vec<_>>().join(", ");
    format!("INSERT INTO {} ({cols}) VALUES ", table_ref(engine, db, &t.table))
}

fn wrap_batch(engine: &str, db: &str, t: &XTable, sql: String) -> String {
    if engine == "mssql" && t.identity {
        let tr = table_ref(engine, db, &t.table);
        format!("SET IDENTITY_INSERT {tr} ON; {sql}; SET IDENTITY_INSERT {tr} OFF")
    } else {
        sql
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn db_transfer_cross(
    source: DbConnectParams,
    source_db: String,
    target: DbConnectParams,
    target_db: String,
    tables: Vec<XTable>,
    post: Vec<String>,
    total_rows: u64,
    continue_on_error: bool,
    transfer_id: String,
    on_dump: Channel<DumpProgress>,
    on_import: Channel<ImportProgress>,
) -> Result<ImportResult, String> {
    let (ctl, _guard) = crate::db::register_job(&transfer_id);
    let mut src = source.clone();
    src.database = Some(source_db.clone());
    let mut tgt = target.clone();
    tgt.database = Some(target_db.clone());
    transfer(&src, &source_db, &tgt, &target_db, &tables, &post, total_rows, continue_on_error, &ctl, &on_dump, &on_import)
        .await
}

#[allow(clippy::too_many_arguments)]
async fn transfer(
    src: &DbConnectParams,
    source_db: &str,
    tgt: &DbConnectParams,
    target_db: &str,
    tables: &[XTable],
    post: &[String],
    total_rows: u64,
    continue_on_error: bool,
    ctl: &JobCtl,
    on_dump: &Channel<DumpProgress>,
    on_import: &Channel<ImportProgress>,
) -> Result<ImportResult, String> {
    let se = src.engine.as_str();
    let te = tgt.engine.as_str();
    let mut rows_done: u64 = 0;
    let mut executed: usize = 0;
    let mut failed: usize = 0;
    on_import.send(ImportProgress::Start { total_bytes: total_rows }).ok();

    // A statement failed: either note it and go on, or stop the whole job.
    macro_rules! fail {
        ($msg:expr) => {{
            let msg: String = $msg;
            if continue_on_error {
                failed += 1;
                on_import.send(ImportProgress::StmtError { index: executed, error: msg }).ok();
            } else {
                on_import.send(ImportProgress::Failed { executed, error: msg.clone() }).ok();
                return Ok(ImportResult { executed, failed, error: Some(msg) });
            }
        }};
    }
    macro_rules! cancelled {
        () => {{
            while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            if ctl.cancelled.load(Ordering::Relaxed) {
                on_import.send(ImportProgress::Cancelled { executed, failed }).ok();
                return Ok(ImportResult { executed, failed, error: None });
            }
        }};
    }

    // 1. Structure: every table first, so FKs added later find their parents.
    for t in tables.iter().filter(|t| !t.create.is_empty()) {
        cancelled!();
        match exec_ddl(tgt, target_db, &t.create).await {
            Ok(()) => executed += t.create.len(),
            Err(e) => fail!(format!("create {}: {e}", t.table)),
        }
    }

    // 2. Data.
    let with_data: Vec<&XTable> = tables.iter().filter(|t| t.data && !t.columns.is_empty()).collect();
    for (ti, t) in with_data.iter().enumerate() {
        on_dump
            .send(DumpProgress::Table { name: t.table.clone(), index: ti + 1, total: with_data.len(), rows: 0 })
            .ok();
        let head = insert_head(te, target_db, t);
        let mut offset = 0usize;
        'pages: loop {
            cancelled!();
            let page = match run(src, &page_sql(se, source_db, t, offset)).await {
                Ok(r) => r,
                Err(e) => {
                    fail!(format!("read {}: {e}", t.table));
                    break 'pages;
                }
            };
            let n = page.rows.len();
            let mut buf = String::new();
            let mut in_buf = 0usize;
            for (ri, row) in page.rows.iter().enumerate() {
                if in_buf > 0 {
                    buf.push(',');
                }
                buf.push('(');
                for (ci, c) in t.columns.iter().enumerate() {
                    if ci > 0 {
                        buf.push_str(", ");
                    }
                    buf.push_str(&literal(te, c.kind, row.get(ci).unwrap_or(&None)));
                }
                buf.push(')');
                in_buf += 1;
                if in_buf >= BATCH_ROWS || buf.len() >= BATCH_BYTES || ri + 1 == n {
                    let sql = wrap_batch(te, target_db, t, format!("{head}{buf}"));
                    match run(tgt, &sql).await {
                        Ok(_) => {
                            executed += 1;
                            rows_done += in_buf as u64;
                        }
                        Err(e) => fail!(format!("insert into {}: {e}", t.table)),
                    }
                    buf.clear();
                    in_buf = 0;
                    on_import
                        .send(ImportProgress::Progress {
                            executed,
                            failed,
                            bytes: rows_done,
                            total_bytes: total_rows.max(rows_done),
                        })
                        .ok();
                }
            }
            if n < PAGE {
                break;
            }
            offset += n;
        }
    }

    // 3. Foreign keys, sequence/identity resets.
    for stmt in post {
        cancelled!();
        match exec_ddl(tgt, target_db, std::slice::from_ref(stmt)).await {
            Ok(()) => executed += 1,
            Err(e) => fail!(format!("{e}\n  in: {}", stmt.lines().next().unwrap_or(""))),
        }
    }

    on_import.send(ImportProgress::Done { executed, failed }).ok();
    Ok(ImportResult { executed, failed, error: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_per_dialect() {
        let s = Some("it's a \\ path".to_string());
        assert_eq!(literal("mysql", Kind::Text, &s), "'it''s a \\\\ path'");
        assert_eq!(literal("postgres", Kind::Text, &s), "'it''s a \\ path'");
        assert_eq!(literal("mssql", Kind::Text, &s), "N'it''s a \\ path'");
        assert_eq!(literal("postgres", Kind::Bool, &Some("1".into())), "'1'");
        assert_eq!(literal("mysql", Kind::Bool, &Some("t".into())), "1");
        assert_eq!(literal("postgres", Kind::Blob, &Some("CAFE".into())), "decode('CAFE', 'hex')");
        assert_eq!(literal("mssql", Kind::Blob, &Some("cafe".into())), "0xcafe");
        assert_eq!(literal("sqlite", Kind::Blob, &Some("".into())), "X''");
        assert_eq!(literal("postgres", Kind::Datetime, &Some("0000-00-00 00:00:00".into())), "NULL");
        assert_eq!(literal("postgres", Kind::Int, &Some("42".into())), "42");
        assert_eq!(literal("postgres", Kind::Int, &Some("4x".into())), "'4x'");
        assert_eq!(literal("mysql", Kind::Num, &None), "NULL");
    }

    #[test]
    fn paging_sql() {
        let t = XTable {
            table: "t".into(),
            create: vec![],
            data: true,
            columns: vec![XCol { name: "id".into(), kind: Kind::Int }, XCol { name: "b".into(), kind: Kind::Blob }],
            order_by: vec!["id".into()],
            identity: false,
        };
        assert_eq!(page_sql("mysql", "d", &t, 0), "SELECT `id`, HEX(`b`) FROM `d`.`t` ORDER BY `id` LIMIT 2000 OFFSET 0");
        assert_eq!(
            page_sql("mssql", "d", &t, 4000),
            "SELECT [id], CONVERT(varchar(max), [b], 2) FROM [t] ORDER BY [id] OFFSET 4000 ROWS FETCH NEXT 2000 ROWS ONLY"
        );
        assert_eq!(page_sql("postgres", "d", &t, 0), "SELECT \"id\"::text, encode(\"b\", 'hex') FROM \"t\" ORDER BY \"id\" LIMIT 2000 OFFSET 0");
    }

    // End-to-end harness against real servers (see crossTransfer e2e notes):
    //   XFER_SRC='{"engine":..}' XFER_SRC_DB=.. XFER_TABLES=a,b XFER_OUT=schemas.json
    //   cargo test xfer_dump_schemas -- --ignored
    fn env_params(k: &str) -> DbConnectParams {
        serde_json::from_str(&std::env::var(k).expect(k)).expect("params json")
    }

    #[tokio::test]
    #[ignore]
    async fn xfer_dump_schemas() {
        let src = env_params("XFER_SRC");
        let db = std::env::var("XFER_SRC_DB").unwrap();
        let mut out = serde_json::Map::new();
        for t in std::env::var("XFER_TABLES").unwrap().split(',') {
            let s = crate::db::db_table_schema(src.clone(), db.clone(), t.to_string()).await.unwrap();
            out.insert(t.to_string(), serde_json::to_value(s).unwrap());
        }
        std::fs::write(std::env::var("XFER_OUT").unwrap(), serde_json::to_string_pretty(&out).unwrap()).unwrap();
    }

    //   XFER_SRC.. XFER_TGT='{..}' XFER_TGT_DB=.. XFER_PLAN=plan.json
    #[tokio::test]
    #[ignore]
    async fn xfer_run_plan() {
        #[derive(Deserialize)]
        struct Plan {
            tables: Vec<XTable>,
            post: Vec<String>,
        }
        let mut src = env_params("XFER_SRC");
        let sdb = std::env::var("XFER_SRC_DB").unwrap();
        src.database = Some(sdb.clone());
        let mut tgt = env_params("XFER_TGT");
        let tdb = std::env::var("XFER_TGT_DB").unwrap();
        tgt.database = Some(tdb.clone());
        let plan: Plan = serde_json::from_str(&std::fs::read_to_string(std::env::var("XFER_PLAN").unwrap()).unwrap()).unwrap();
        let ctl = JobCtl { cancelled: Default::default(), paused: Default::default() };
        let dch: Channel<DumpProgress> = Channel::new(|_| Ok(()));
        let ich: Channel<ImportProgress> = Channel::new(|b| {
            if let tauri::ipc::InvokeResponseBody::Json(j) = b {
                if j.contains("error") {
                    eprintln!("{j}");
                }
            }
            Ok(())
        });
        let r = transfer(&src, &sdb, &tgt, &tdb, &plan.tables, &plan.post, 0, true, &ctl, &dch, &ich).await.unwrap();
        eprintln!("executed={} failed={} error={:?}", r.executed, r.failed, r.error);
        assert_eq!(r.failed, 0);
    }
}
