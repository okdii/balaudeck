//! MySQL/MariaDB client built on mysql_async.
//! Spike-quality for Fasa 0; grows into the full Fasa 5 implementation.

use mysql_async::prelude::*;
use mysql_async::{Opts, OptsBuilder, Row, Value};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct DbConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    #[serde(default)]
    pub database: Option<String>,
}

#[derive(Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub rows_affected: u64,
    pub elapsed_ms: u128,
}

fn build_opts(p: &DbConnectParams) -> Opts {
    let builder = OptsBuilder::default()
        .ip_or_hostname(p.host.clone())
        .tcp_port(p.port)
        .user(Some(p.user.clone()))
        .pass(Some(p.password.clone()))
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
pub async fn db_query(params: DbConnectParams, sql: String) -> Result<QueryResult, String> {
    let started = std::time::Instant::now();
    let pool = mysql_async::Pool::new(build_opts(&params));
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

    let collected: Vec<Row> = result
        .collect()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;

    let rows_affected = conn.affected_rows();
    let rows: Vec<Vec<Option<String>>> = collected.iter().map(row_to_strings).collect();

    drop(conn);
    let _ = pool.disconnect().await;

    Ok(QueryResult {
        columns,
        rows,
        rows_affected,
        elapsed_ms: started.elapsed().as_millis(),
    })
}
