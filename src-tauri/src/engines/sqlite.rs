//! SQLite driver via `rusqlite` (bundled amalgamation). The DB is a local file
//! (`params.file`); host/port/user are unused. rusqlite is blocking, so every
//! call runs on a `spawn_blocking` thread to keep the async command signatures
//! uniform.

use crate::db::{DbConnectParams, QueryResult, SchemaObjects};
use rusqlite::types::Value;
use rusqlite::Connection;

#[cfg(test)]
mod tests {
    use super::*;

    fn params(path: &str) -> DbConnectParams {
        DbConnectParams {
            engine: "sqlite".into(),
            host: String::new(),
            port: 0,
            user: String::new(),
            password: None,
            database: None,
            file: Some(path.into()),
            profile_id: None,
            region: None,
            path_style: None,
            tls: None,
        }
    }

    // cargo test --lib engines::sqlite -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn sqlite_smoke() {
        let path = format!("{}/balaudeck-demo.sqlite", std::env::temp_dir().display());
        let _ = std::fs::remove_file(&path);
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE gadgets(id INTEGER PRIMARY KEY, name TEXT, qty INT);\
                 INSERT INTO gadgets(name,qty) VALUES ('alpha',5),('beta',9);\
                 CREATE VIEW few AS SELECT * FROM gadgets WHERE qty < 8;",
            )
            .unwrap();
        }
        let p = params(&path);

        let objs = schema_objects(&p, "main").await.expect("schema_objects");
        println!("TABLES: {:?}  VIEWS: {:?}", objs.tables, objs.views);
        assert!(objs.tables.iter().any(|t| t == "gadgets"));
        assert!(objs.views.iter().any(|v| v == "few"));

        let q = query(&p, "SELECT * FROM gadgets ORDER BY id", Some(200))
            .await
            .expect("query");
        println!("COLUMNS: {:?}", q.columns);
        for r in &q.rows {
            println!("ROW: {r:?}");
        }
        assert_eq!(q.columns, vec!["id", "name", "qty"]);
        assert_eq!(q.rows.len(), 2);
        assert_eq!(q.rows[1][1].as_deref(), Some("beta"));

        // Editing: primary key + a parameterized UPDATE.
        let pk = primary_key(&p, "gadgets").await.expect("primary_key");
        println!("PK: {pk:?}");
        assert_eq!(pk, vec!["id"]);
        let stmts = vec![crate::db::ExecStatement {
            sql: "UPDATE \"gadgets\" SET \"qty\" = ? WHERE \"id\" = ?".into(),
            values: vec![Some("42".into()), Some("2".into())],
        }];
        let aff = exec_batch(&p, &stmts).await.expect("exec_batch");
        assert_eq!(aff, vec![1]);
        let after = query(&p, "SELECT qty FROM gadgets WHERE id = 2", Some(1))
            .await
            .expect("verify");
        assert_eq!(after.rows[0][0].as_deref(), Some("42"));
    }
}

fn file_path(p: &DbConnectParams) -> Result<String, String> {
    match &p.file {
        Some(f) if !f.is_empty() => Ok(f.clone()),
        _ => Err("No SQLite database file is set for this connection.".into()),
    }
}

pub async fn query(
    p: &DbConnectParams,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let path = file_path(p)?;
    let sql = sql.to_string();
    tokio::task::spawn_blocking(move || {
        let started = std::time::Instant::now();
        let conn = Connection::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("query failed: {e}"))?;
        let ncol = stmt.column_count();

        // No result columns => a DML/DDL statement; run it and report changes.
        if ncol == 0 {
            drop(stmt);
            let n = conn
                .execute(&sql, [])
                .map_err(|e| format!("exec failed: {e}"))?;
            return Ok(QueryResult {
                columns: vec![],
                binary_cols: vec![],
                rows: vec![],
                rows_affected: n as u64,
                elapsed_ms: started.elapsed().as_millis(),
                truncated: false,
            });
        }

        let columns: Vec<String> = (0..ncol)
            .map(|i| stmt.column_name(i).unwrap_or("").to_string())
            .collect();
        let cap = max_rows.unwrap_or(usize::MAX);
        let mut out: Vec<Vec<Option<String>>> = Vec::new();
        let mut truncated = false;
        let mut rows = stmt.query([]).map_err(|e| format!("query failed: {e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("fetch failed: {e}"))? {
            if out.len() >= cap {
                truncated = true;
                break;
            }
            let mut r = Vec::with_capacity(ncol);
            for i in 0..ncol {
                let v: Value = row.get(i).map_err(|e| format!("read failed: {e}"))?;
                r.push(match v {
                    Value::Null => None,
                    Value::Integer(n) => Some(n.to_string()),
                    Value::Real(f) => Some(f.to_string()),
                    Value::Text(s) => Some(s),
                    Value::Blob(b) => Some(format!("<{} bytes>", b.len())),
                });
            }
            out.push(r);
        }

        Ok(QueryResult {
            binary_cols: vec![false; columns.len()],
            columns,
            rows: out,
            rows_affected: 0,
            elapsed_ms: started.elapsed().as_millis(),
            truncated,
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

pub async fn list_databases(p: &DbConnectParams) -> Result<Vec<String>, String> {
    // A SQLite file is a single database; surface its file name.
    let path = file_path(p)?;
    let name = path.rsplit('/').next().unwrap_or("database").to_string();
    Ok(vec![name])
}

pub async fn schema_objects(
    p: &DbConnectParams,
    _database: &str,
) -> Result<SchemaObjects, String> {
    let path = file_path(p)?;
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let mut tables = Vec::new();
        let mut views = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT name, type FROM sqlite_master \
                 WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .map_err(|e| format!("list objects failed: {e}"))?;
        let mut rows = stmt.query([]).map_err(|e| format!("list objects failed: {e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("fetch failed: {e}"))? {
            let name: String = row.get(0).map_err(|e| format!("read failed: {e}"))?;
            let kind: String = row.get(1).map_err(|e| format!("read failed: {e}"))?;
            if kind == "view" {
                views.push(name);
            } else {
                tables.push(name);
            }
        }
        Ok(SchemaObjects {
            tables,
            views,
            routines: vec![], // SQLite has no stored routines
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

pub async fn primary_key(p: &DbConnectParams, table: &str) -> Result<Vec<String>, String> {
    let path = file_path(p)?;
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let q = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
        let mut stmt = conn.prepare(&q).map_err(|e| format!("pragma failed: {e}"))?;
        let mut rows = stmt.query([]).map_err(|e| format!("pragma failed: {e}"))?;
        let mut pks: Vec<(i64, String)> = Vec::new();
        while let Some(row) = rows.next().map_err(|e| format!("read failed: {e}"))? {
            // columns: cid, name(1), type, notnull, dflt_value, pk(5)
            let name: String = row.get(1).map_err(|e| format!("read failed: {e}"))?;
            let pk: i64 = row.get(5).map_err(|e| format!("read failed: {e}"))?;
            if pk > 0 {
                pks.push((pk, name));
            }
        }
        pks.sort_by_key(|(o, _)| *o);
        Ok(pks.into_iter().map(|(_, n)| n).collect())
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

pub async fn exec_batch(
    p: &DbConnectParams,
    statements: &[crate::db::ExecStatement],
) -> Result<Vec<u64>, String> {
    let path = file_path(p)?;
    let stmts: Vec<(String, Vec<Option<String>>)> = statements
        .iter()
        .map(|s| (s.sql.clone(), s.values.clone()))
        .collect();
    tokio::task::spawn_blocking(move || {
        let mut conn = Connection::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let tx = conn.transaction().map_err(|e| format!("begin failed: {e}"))?;
        let mut affected = Vec::with_capacity(stmts.len());
        for (i, (sql, vals)) in stmts.into_iter().enumerate() {
            let n = tx
                .execute(&sql, rusqlite::params_from_iter(vals))
                .map_err(|e| format!("statement {} failed: {e}", i + 1))?;
            if n != 1 {
                return Err(format!(
                    "row {} matched {n} rows (expected exactly 1) — nothing was saved",
                    i + 1
                ));
            }
            affected.push(n as u64);
        }
        tx.commit().map_err(|e| format!("commit failed: {e}"))?;
        Ok(affected)
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}
