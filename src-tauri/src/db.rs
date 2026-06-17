//! MySQL/MariaDB client built on mysql_async.
//! Spike-quality for Fasa 0; grows into the full Fasa 5 implementation.

use futures_util::StreamExt;
use mysql_async::prelude::*;
use mysql_async::{Opts, OptsBuilder, Row, Value};
use serde::{Deserialize, Serialize};

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

    drop(conn);
    let _ = pool.disconnect().await;

    Ok(QueryResult {
        columns,
        rows,
        rows_affected,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
    })
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
