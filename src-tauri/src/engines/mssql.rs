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

    // A single-table SELECT stays editable (see pg::query). Needs a concrete
    // database for the follow-up pk lookup, so only when one is set.
    let (source_db, source_table) =
        match (columns.is_empty(), p.database.clone().filter(|s| !s.is_empty())) {
            (false, Some(db)) => match super::single_table_source(sql) {
                Some(t) => (Some(db), Some(t)),
                None => (None, None),
            },
            _ => (None, None),
        };

    Ok(QueryResult {
        binary_cols: vec![false; columns.len()],
        columns,
        rows: out,
        rows_affected: 0,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
        source_db,
        source_table,
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

pub async fn primary_key(
    p: &DbConnectParams,
    database: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let mut client = connect(p, Some(database)).await?;
    let esc = table.replace('\'', "''");
    let sql = format!(
        "SELECT c.name FROM sys.indexes i \
         JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id \
         JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id \
         WHERE i.is_primary_key=1 AND i.object_id=OBJECT_ID('{esc}') ORDER BY ic.key_ordinal"
    );
    let rows = rows_of(&mut client, &sql).await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
        .collect())
}

pub async fn foreign_keys(
    p: &DbConnectParams,
    database: &str,
    table: &str,
) -> Result<Vec<crate::db::ForeignKeyRef>, String> {
    let mut client = connect(p, Some(database)).await?;
    let esc = table.replace('\'', "''");
    let sql = format!(
        "SELECT pc.name AS column_name, rt.name AS ref_table, rc.name AS ref_column \
         FROM sys.foreign_key_columns fkc \
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
         JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id \
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE fkc.parent_object_id = OBJECT_ID('{esc}') \
         ORDER BY fkc.constraint_object_id, fkc.constraint_column_id"
    );
    let rows = rows_of(&mut client, &sql).await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let column = r.get::<&str, _>(0).unwrap_or("");
            let ref_table = r.get::<&str, _>(1).unwrap_or("");
            let ref_column = r.get::<&str, _>(2).unwrap_or("");
            if column.is_empty() || ref_table.is_empty() || ref_column.is_empty() {
                None
            } else {
                Some(crate::db::ForeignKeyRef {
                    column: column.to_string(),
                    ref_table: ref_table.to_string(),
                    ref_column: ref_column.to_string(),
                })
            }
        })
        .collect())
}

/// Run a plain statement (transaction control) as a batch, not via sp_executesql
/// (which would flag BEGIN/COMMIT as a TRANCOUNT mismatch).
async fn run_batch(client: &mut SqlClient, sql: &str) -> Result<(), String> {
    client
        .simple_query(sql)
        .await
        .map_err(|e| e.to_string())?
        .into_results()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn table_schema(
    p: &DbConnectParams,
    database: &str,
    table: &str,
) -> Result<crate::db::TableSchema, String> {
    use crate::db::{ColumnInfo, FkInfo, TableSchema};
    let mut client = connect(p, Some(database)).await?;
    let esc = table.replace('\'', "''");

    let col_sql = format!(
        "SELECT c.name, t.name AS type_name, \
                CASE WHEN t.name IN ('varchar','nvarchar','char','nchar','varbinary','binary') \
                     THEN CASE WHEN c.max_length = -1 THEN 'max' \
                               WHEN t.name IN ('nvarchar','nchar') THEN CAST(c.max_length/2 AS varchar) \
                               ELSE CAST(c.max_length AS varchar) END \
                     WHEN t.name IN ('decimal','numeric') THEN CAST(c.precision AS varchar)+','+CAST(c.scale AS varchar) \
                     ELSE '' END AS len, \
                c.is_nullable, ISNULL(dc.definition, ''), c.is_identity, \
                CASE WHEN pk.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk \
         FROM sys.columns c \
         JOIN sys.types t ON t.user_type_id = c.user_type_id \
         LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id \
         LEFT JOIN ( \
           SELECT ic.column_id FROM sys.indexes i \
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
           WHERE i.is_primary_key = 1 AND i.object_id = OBJECT_ID('{esc}') \
         ) pk ON pk.column_id = c.column_id \
         WHERE c.object_id = OBJECT_ID('{esc}') ORDER BY c.column_id"
    );
    let mut columns = Vec::new();
    for r in rows_of(&mut client, &col_sql).await? {
        let len: String = r.get::<&str, _>(2).unwrap_or("").to_string();
        // Strip a wrapping ('...') / (...) that SQL Server puts around defaults.
        let mut default = r.get::<&str, _>(4).unwrap_or("").to_string();
        while default.starts_with('(') && default.ends_with(')') {
            default = default[1..default.len() - 1].to_string();
        }
        columns.push(ColumnInfo {
            name: r.get::<&str, _>(0).unwrap_or("").to_string(),
            data_type: r.get::<&str, _>(1).unwrap_or("").to_string(),
            length: if len == "max" { String::new() } else { len },
            nullable: r.get::<bool, _>(3).unwrap_or(true),
            default,
            pk: r.get::<i32, _>(6).unwrap_or(0) == 1,
            auto_increment: r.get::<bool, _>(5).unwrap_or(false),
        });
    }

    let fk_sql = format!(
        "SELECT fk.name, pc.name, rt.name, rc.name, fk.delete_referential_action_desc, \
                fk.update_referential_action_desc \
         FROM sys.foreign_keys fk \
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
         JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id \
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
         WHERE fk.parent_object_id = OBJECT_ID('{esc}') ORDER BY fk.name, fkc.constraint_column_id"
    );
    let mut foreign_keys = Vec::new();
    for r in rows_of(&mut client, &fk_sql).await? {
        let deld = r.get::<&str, _>(4).unwrap_or("").replace('_', " ");
        let upd = r.get::<&str, _>(5).unwrap_or("").replace('_', " ");
        foreign_keys.push(FkInfo {
            name: r.get::<&str, _>(0).unwrap_or("").to_string(),
            column: r.get::<&str, _>(1).unwrap_or("").to_string(),
            ref_table: r.get::<&str, _>(2).unwrap_or("").to_string(),
            ref_column: r.get::<&str, _>(3).unwrap_or("").to_string(),
            on_delete: if deld.eq_ignore_ascii_case("NO ACTION") { String::new() } else { deld },
            on_update: if upd.eq_ignore_ascii_case("NO ACTION") { String::new() } else { upd },
        });
    }

    let idx_sql = format!(
        "SELECT i.name, c.name, i.is_unique \
         FROM sys.indexes i \
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         WHERE i.object_id = OBJECT_ID('{esc}') AND i.is_primary_key = 0 AND i.type > 0 \
         ORDER BY i.name, ic.key_ordinal"
    );
    let mut idx_rows: Vec<(String, String, bool)> = Vec::new();
    for r in rows_of(&mut client, &idx_sql).await? {
        idx_rows.push((
            r.get::<&str, _>(0).unwrap_or("").to_string(),
            r.get::<&str, _>(1).unwrap_or("").to_string(),
            r.get::<bool, _>(2).unwrap_or(false),
        ));
    }

    Ok(TableSchema {
        columns,
        foreign_keys,
        indexes: crate::db::group_indexes(idx_rows),
    })
}

// User management is implemented in a later increment; stubbed for now so the
// dispatch compiles.
pub async fn list_users(_p: &DbConnectParams) -> Result<Vec<crate::db::DbUser>, String> {
    Err("SQL Server user management is not implemented yet.".into())
}
pub async fn user_detail(
    _p: &DbConnectParams,
    _user: &str,
    _host: &str,
) -> Result<crate::db::UserDetail, String> {
    Err("SQL Server user management is not implemented yet.".into())
}
pub async fn exec_user_sql(_p: &DbConnectParams, _statements: &[String]) -> Result<(), String> {
    Err("SQL Server user management is not implemented yet.".into())
}

pub async fn exec_ddl(
    p: &DbConnectParams,
    database: &str,
    statements: &[String],
) -> Result<(), String> {
    let mut client = connect(p, Some(database)).await?;
    run_batch(&mut client, "BEGIN TRANSACTION")
        .await
        .map_err(|e| format!("begin failed: {e}"))?;
    for (i, sql) in statements.iter().enumerate() {
        if let Err(e) = run_batch(&mut client, sql).await {
            run_batch(&mut client, "ROLLBACK TRANSACTION").await.ok();
            return Err(format!("statement {} failed: {e}", i + 1));
        }
    }
    run_batch(&mut client, "COMMIT TRANSACTION")
        .await
        .map_err(|e| format!("commit failed: {e}"))
}

pub async fn exec_batch(
    p: &DbConnectParams,
    statements: &[crate::db::ExecStatement],
) -> Result<Vec<u64>, String> {
    let mut client = connect(p, None).await?;
    run_batch(&mut client, "BEGIN TRANSACTION")
        .await
        .map_err(|e| format!("begin failed: {e}"))?;
    let mut affected = Vec::with_capacity(statements.len());
    for (i, st) in statements.iter().enumerate() {
        let sql = super::inline_sql(&st.sql, &st.values);
        match client.execute(sql, &[]).await {
            Ok(res) => {
                let n: u64 = res.rows_affected().iter().sum();
                if n != 1 {
                    run_batch(&mut client, "ROLLBACK TRANSACTION").await.ok();
                    return Err(format!(
                        "row {} matched {n} rows (expected exactly 1) — nothing was saved",
                        i + 1
                    ));
                }
                affected.push(n);
            }
            Err(e) => {
                run_batch(&mut client, "ROLLBACK TRANSACTION").await.ok();
                return Err(format!("statement {} failed: {e}", i + 1));
            }
        }
    }
    run_batch(&mut client, "COMMIT TRANSACTION")
        .await
        .map_err(|e| format!("commit failed: {e}"))?;
    Ok(affected)
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
            region: None,
            path_style: None,
            tls: None,
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

        let pk = primary_key(&p, "demo", "widgets").await.expect("primary_key");
        println!("PK: {pk:?}");
        assert_eq!(pk, vec!["id"]);
        let stmts = vec![crate::db::ExecStatement {
            sql: "UPDATE [widgets] SET [qty] = ? WHERE [id] = ?".into(),
            values: vec![Some("777".into()), Some("1".into())],
        }];
        let aff = exec_batch(&p, &stmts).await.expect("exec_batch");
        assert_eq!(aff, vec![1]);
        let after = query(&p, "SELECT qty FROM widgets WHERE id = 1", Some(1))
            .await
            .expect("verify");
        assert_eq!(after.rows[0][0].as_deref(), Some("777"));
    }
}
