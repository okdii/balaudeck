//! SQL Server (MSSQL) driver via `tiberius` over a tokio TCP stream. tiberius
//! returns typed `ColumnData`, so a small decoder renders each cell to a display
//! string for the generic grid (dates/xml fall back to Debug for now).

use crate::db::{DbConnectParams, QueryResult, Routine, SchemaObjects};
use tiberius::{AuthMethod, Client, ColumnData, Config};
use tokio::net::TcpStream;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type SqlClient = Client<Compat<TcpStream>>;

async fn connect(p: &DbConnectParams, dbname: Option<&str>) -> Result<SqlClient, String> {
    let mut config = Config::new();
    config.host(&p.host);
    config.port(p.port);
    config.authentication(AuthMethod::sql_server(&p.user, crate::db::resolve_password(p)));
    // Dev servers usually present a self-signed cert; accept it (rustls, no
    // native TLS). Encryption is still negotiated.
    config.trust_cert();
    let db = dbname
        .map(|s| s.to_string())
        .or_else(|| p.database.clone().filter(|s| !s.is_empty()));
    if let Some(db) = db {
        config.database(db);
    }

    let tcp = TcpStream::connect(config.get_addr())
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    tcp.set_nodelay(true).ok();
    Client::connect(config, tcp.compat_write())
        .await
        .map_err(|e| format!("connect failed: {e}"))
}

fn cell_to_string(d: ColumnData<'_>) -> Option<String> {
    match d {
        ColumnData::U8(v) => v.map(|x| x.to_string()),
        ColumnData::I16(v) => v.map(|x| x.to_string()),
        ColumnData::I32(v) => v.map(|x| x.to_string()),
        ColumnData::I64(v) => v.map(|x| x.to_string()),
        ColumnData::F32(v) => v.map(|x| x.to_string()),
        ColumnData::F64(v) => v.map(|x| x.to_string()),
        ColumnData::Bit(v) => v.map(|x| if x { "1".into() } else { "0".into() }),
        ColumnData::String(v) => v.map(|c| c.into_owned()),
        ColumnData::Guid(v) => v.map(|g| g.to_string()),
        ColumnData::Numeric(v) => v.map(|n| n.to_string()),
        ColumnData::Binary(v) => v.map(|b| format!("<{} bytes>", b.len())),
        // Dates/time/xml: readable-enough Debug for v1.
        other => Some(format!("{other:?}")),
    }
}

async fn rows_of(client: &mut SqlClient, sql: &str) -> Result<Vec<tiberius::Row>, String> {
    client
        .simple_query(sql)
        .await
        .map_err(|e| format!("query failed: {e}"))?
        .into_first_result()
        .await
        .map_err(|e| format!("fetch failed: {e}"))
}

pub async fn query(
    p: &DbConnectParams,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let started = std::time::Instant::now();
    let mut client = connect(p, None).await?;
    let rows = rows_of(&mut client, sql).await?;

    let mut columns: Vec<String> = Vec::new();
    let mut out: Vec<Vec<Option<String>>> = Vec::new();
    let cap = max_rows.unwrap_or(usize::MAX);
    let mut truncated = false;
    for (idx, row) in rows.into_iter().enumerate() {
        if idx == 0 {
            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
        }
        if out.len() >= cap {
            truncated = true;
            break;
        }
        out.push(row.into_iter().map(cell_to_string).collect());
    }

    Ok(QueryResult {
        binary_cols: vec![false; columns.len()],
        columns,
        rows: out,
        rows_affected: 0,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
    })
}

pub async fn list_databases(p: &DbConnectParams) -> Result<Vec<String>, String> {
    let mut client = connect(p, None).await?;
    let rows = rows_of(
        &mut client,
        "SELECT name FROM sys.databases WHERE database_id > 4 OR name IN ('master') ORDER BY name",
    )
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
        .collect())
}

pub async fn schema_objects(
    p: &DbConnectParams,
    database: &str,
) -> Result<SchemaObjects, String> {
    let mut client = connect(p, Some(database)).await?;

    let tables = rows_of(&mut client, "SELECT name FROM sys.tables ORDER BY name")
        .await?
        .into_iter()
        .filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
        .collect();
    let views = rows_of(&mut client, "SELECT name FROM sys.views ORDER BY name")
        .await?
        .into_iter()
        .filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
        .collect();
    let routines = rows_of(
        &mut client,
        "SELECT name, type_desc FROM sys.objects WHERE type IN ('P','FN','TF','IF') ORDER BY name",
    )
    .await?
    .into_iter()
    .filter_map(|r| {
        r.get::<&str, _>(0).map(|name| Routine {
            name: name.to_string(),
            kind: r.get::<&str, _>(1).unwrap_or("PROCEDURE").to_string(),
        })
    })
    .collect();

    Ok(SchemaObjects {
        tables,
        views,
        routines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(db: Option<&str>) -> DbConnectParams {
        DbConnectParams {
            engine: "mssql".into(),
            host: "127.0.0.1".into(),
            port: 51433,
            user: "sa".into(),
            password: Some("Demo_pass123".into()),
            database: db.map(|s| s.to_string()),
            file: None,
            profile_id: None,
        }
    }

    // cargo test --lib engines::mssql -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn mssql_smoke() {
        let p = params(Some("demo"));
        let dbs = list_databases(&p).await.expect("list_databases");
        println!("DATABASES: {dbs:?}");
        assert!(dbs.iter().any(|d| d == "demo"));

        let objs = schema_objects(&p, "demo").await.expect("schema_objects");
        println!("TABLES: {:?}  VIEWS: {:?}", objs.tables, objs.views);
        assert!(objs.tables.iter().any(|t| t == "widgets"));

        let q = query(&p, "SELECT * FROM widgets ORDER BY id", Some(200))
            .await
            .expect("query");
        println!("COLUMNS: {:?}", q.columns);
        for row in &q.rows {
            println!("ROW: {row:?}");
        }
        assert_eq!(q.rows.len(), 3);
    }
}
