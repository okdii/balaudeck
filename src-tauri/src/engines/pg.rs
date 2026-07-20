//! PostgreSQL driver via `tokio-postgres`. Uses the simple-query protocol so
//! every column value comes back as its text representation — no per-type
//! decoding needed for a generic display grid. Connections are made per call
//! (no pool yet); fine for v1 and identical behaviour over a tunnel (the
//! frontend redirects to 127.0.0.1:<local_port>).

use crate::db::{DbConnectParams, QueryResult, Routine, SchemaObjects};
use tokio_postgres::{Config, NoTls, SimpleQueryMessage};

#[cfg(test)]
mod tests {
    use super::*;

    fn params(db: Option<&str>) -> DbConnectParams {
        DbConnectParams {
            engine: "postgres".into(),
            host: "127.0.0.1".into(),
            port: 55432,
            user: "postgres".into(),
            password: Some("demopass".into()),
            database: db.map(|s| s.to_string()),
            file: None,
            profile_id: None,
            region: None,
            path_style: None,
            tls: None,
        }
    }

    // Run against the balaudeck-demo-pg container:
    //   cargo test --lib engines::pg -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn pg_smoke() {
        let p = params(Some("demo"));
        let dbs = list_databases(&p).await.expect("list_databases");
        println!("DATABASES: {dbs:?}");
        assert!(dbs.iter().any(|d| d == "demo"));

        let objs = schema_objects(&p, "demo").await.expect("schema_objects");
        println!("TABLES: {:?}  VIEWS: {:?}", objs.tables, objs.views);
        assert!(objs.tables.iter().any(|t| t == "widgets"));
        assert!(objs.views.iter().any(|v| v == "cheap"));

        let q = query(&p, "SELECT * FROM widgets ORDER BY id", Some(200))
            .await
            .expect("query");
        println!("COLUMNS: {:?}", q.columns);
        for row in &q.rows {
            println!("ROW: {row:?}");
        }
        assert_eq!(q.columns, vec!["id", "name", "qty", "price"]);
        assert_eq!(q.rows.len(), 3);
        assert_eq!(q.rows[0][1].as_deref(), Some("bolt"));

        // Editing: primary key + a parameterized UPDATE.
        let pk = primary_key(&p, "demo", "widgets").await.expect("primary_key");
        println!("PK: {pk:?}");
        assert_eq!(pk, vec!["id"]);
        let stmts = vec![crate::db::ExecStatement {
            sql: "UPDATE \"widgets\" SET \"qty\" = ? WHERE \"id\" = ?".into(),
            values: vec![Some("999".into()), Some("1".into())],
        }];
        let aff = exec_batch(&p, &stmts).await.expect("exec_batch");
        assert_eq!(aff, vec![1]);
        let after = query(&p, "SELECT qty FROM widgets WHERE id = 1", Some(1))
            .await
            .expect("verify");
        assert_eq!(after.rows[0][0].as_deref(), Some("999"));
    }

    // Seeds its own parent/child tables, then verifies FK introspection.
    //   cargo test --lib engines::pg::tests::fk_smoke -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn fk_smoke() {
        let p = params(Some("demo"));
        for sql in [
            "DROP TABLE IF EXISTS fk_book",
            "DROP TABLE IF EXISTS fk_author",
            "CREATE TABLE fk_author(id INT PRIMARY KEY, name TEXT)",
            "CREATE TABLE fk_book(id INT PRIMARY KEY, author_id INT REFERENCES fk_author(id), title TEXT)",
            "INSERT INTO fk_author(id, name) VALUES (1, 'ada')",
            "INSERT INTO fk_book(id, author_id, title) VALUES (1, 1, 'algorithms')",
        ] {
            query(&p, sql, None).await.expect(sql);
        }
        let fks = foreign_keys(&p, "demo", "fk_book").await.expect("foreign_keys");
        println!("FKS: {:?}", fks.iter().map(|f| (&f.column, &f.ref_table, &f.ref_column)).collect::<Vec<_>>());
        assert_eq!(fks.len(), 1);
        assert_eq!(fks[0].column, "author_id");
        assert_eq!(fks[0].ref_table, "fk_author");
        assert_eq!(fks[0].ref_column, "id");
        // Parent has no outgoing FK.
        let none = foreign_keys(&p, "demo", "fk_author").await.expect("foreign_keys");
        assert!(none.is_empty());

        // Source detection: a plain single-table SELECT is editable...
        let editable = query(&p, "SELECT * FROM fk_book ORDER BY id", None)
            .await
            .expect("query");
        assert_eq!(editable.source_db.as_deref(), Some("demo"));
        assert_eq!(editable.source_table.as_deref(), Some("fk_book"));
        // ...but a join is not.
        let joined = query(
            &p,
            "SELECT fk_book.id FROM fk_book JOIN fk_author ON fk_book.author_id = fk_author.id",
            None,
        )
        .await
        .expect("query");
        assert_eq!(joined.source_table, None);
    }
}

async fn connect(
    p: &DbConnectParams,
    dbname: Option<&str>,
) -> Result<tokio_postgres::Client, String> {
    let mut cfg = Config::new();
    cfg.host(&p.host).port(p.port).user(&p.user);
    let pw = crate::db::resolve_password(p);
    if !pw.is_empty() {
        cfg.password(pw);
    }
    let db = dbname
        .map(|s| s.to_string())
        .or_else(|| p.database.clone().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "postgres".into());
    cfg.dbname(&db);
    cfg.connect_timeout(std::time::Duration::from_secs(15));

    let (client, connection) = cfg
        .connect(NoTls)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;
    // Drive the connection in the background; it ends when the client drops.
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}

pub async fn query(
    p: &DbConnectParams,
    sql: &str,
    max_rows: Option<usize>,
) -> Result<QueryResult, String> {
    let started = std::time::Instant::now();
    let client = connect(p, None).await?;
    let msgs = client
        .simple_query(sql)
        .await
        .map_err(|e| format!("query failed: {e}"))?;

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut rows_affected: u64 = 0;
    let cap = max_rows.unwrap_or(usize::MAX);
    let mut truncated = false;

    for m in msgs {
        match m {
            SimpleQueryMessage::Row(r) => {
                if columns.is_empty() {
                    columns = r.columns().iter().map(|c| c.name().to_string()).collect();
                }
                if rows.len() >= cap {
                    truncated = true;
                    continue;
                }
                let row = (0..r.len()).map(|i| r.get(i).map(|s| s.to_string())).collect();
                rows.push(row);
            }
            SimpleQueryMessage::CommandComplete(n) => rows_affected = n,
            _ => {}
        }
    }

    // A single-table SELECT stays editable: name its base table so the grid can
    // arm pk-based editing (the frontend re-checks the pk columns are present).
    let (source_db, source_table) = if columns.is_empty() {
        (None, None)
    } else {
        match super::single_table_source(sql) {
            Some(t) => (
                Some(
                    p.database
                        .clone()
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| "postgres".into()),
                ),
                Some(t),
            ),
            None => (None, None),
        }
    };

    Ok(QueryResult {
        binary_cols: vec![false; columns.len()],
        columns,
        rows,
        rows_affected,
        elapsed_ms: started.elapsed().as_millis(),
        truncated,
        source_db,
        source_table,
    })
}

pub async fn list_databases(p: &DbConnectParams) -> Result<Vec<String>, String> {
    let client = connect(p, None).await?;
    let msgs = client
        .simple_query(
            "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname",
        )
        .await
        .map_err(|e| format!("list databases failed: {e}"))?;
    Ok(msgs
        .into_iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::Row(r) => r.get(0).map(|s| s.to_string()),
            _ => None,
        })
        .collect())
}

pub async fn schema_objects(
    p: &DbConnectParams,
    database: &str,
) -> Result<SchemaObjects, String> {
    // Postgres can't query objects in another database over one connection, so
    // connect directly to the requested database.
    let client = connect(p, Some(database)).await?;

    let mut tables = Vec::new();
    let mut views = Vec::new();
    let msgs = client
        .simple_query(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_schema NOT IN ('pg_catalog','information_schema') \
             ORDER BY table_name",
        )
        .await
        .map_err(|e| format!("list tables failed: {e}"))?;
    for m in msgs {
        if let SimpleQueryMessage::Row(r) = m {
            if let Some(name) = r.get(0) {
                if r.get(1).unwrap_or("").eq_ignore_ascii_case("VIEW") {
                    views.push(name.to_string());
                } else {
                    tables.push(name.to_string());
                }
            }
        }
    }

    let mut routines = Vec::new();
    let msgs = client
        .simple_query(
            "SELECT routine_name, routine_type FROM information_schema.routines \
             WHERE routine_schema NOT IN ('pg_catalog','information_schema') \
             ORDER BY routine_name",
        )
        .await
        .map_err(|e| format!("list routines failed: {e}"))?;
    for m in msgs {
        if let SimpleQueryMessage::Row(r) = m {
            if let Some(name) = r.get(0) {
                routines.push(Routine {
                    name: name.to_string(),
                    kind: r.get(1).unwrap_or("FUNCTION").to_string(),
                });
            }
        }
    }

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
    // Connect to the BROWSED database (Postgres can't cross-DB on one
    // connection); connecting to the default DB returned an empty PK — and thus
    // a silently read-only grid — whenever you browsed any other database.
    let client = connect(p, Some(database)).await?;
    let esc = table.replace('\'', "''");
    // Restrict to schemas on the search_path so the PK matches the same table the
    // unqualified browse `SELECT * FROM "t"` reads, and same-named tables in other
    // schemas don't merge into a bogus multi-column key.
    let sql = format!(
        "SELECT kcu.column_name FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema \
         WHERE tc.table_name = '{esc}' AND tc.constraint_type = 'PRIMARY KEY' \
           AND tc.table_schema = ANY(current_schemas(true)) \
         ORDER BY kcu.ordinal_position"
    );
    let msgs = client
        .simple_query(&sql)
        .await
        .map_err(|e| format!("primary key failed: {e}"))?;
    Ok(msgs
        .into_iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::Row(r) => r.get(0).map(|s| s.to_string()),
            _ => None,
        })
        .collect())
}

pub async fn foreign_keys(
    p: &DbConnectParams,
    database: &str,
    table: &str,
) -> Result<Vec<crate::db::ForeignKeyRef>, String> {
    // Connect to the BROWSED database (same reasoning as primary_key).
    let client = connect(p, Some(database)).await?;
    let esc = table.replace('\'', "''");
    // Join the constraint chain: referential_constraints ties each FK to the
    // unique/PK constraint it references; key_column_usage gives the local column
    // (ordered), constraint_column_usage gives the referenced table/column.
    // Restricted to search_path schemas so it matches the unqualified browse.
    let sql = format!(
        "SELECT kcu.column_name, ccu.table_name, ccu.column_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema \
         JOIN information_schema.constraint_column_usage ccu \
           ON ccu.constraint_name = rc.unique_constraint_name \
          AND ccu.constraint_schema = rc.unique_constraint_schema \
         WHERE tc.table_name = '{esc}' AND tc.constraint_type = 'FOREIGN KEY' \
           AND tc.table_schema = ANY(current_schemas(true)) \
         ORDER BY kcu.constraint_name, kcu.ordinal_position"
    );
    let msgs = client
        .simple_query(&sql)
        .await
        .map_err(|e| format!("foreign keys failed: {e}"))?;
    Ok(msgs
        .into_iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::Row(r) => {
                match (r.get(0), r.get(1), r.get(2)) {
                    (Some(column), Some(ref_table), Some(ref_column))
                        if !column.is_empty() && !ref_table.is_empty() && !ref_column.is_empty() =>
                    {
                        Some(crate::db::ForeignKeyRef {
                            column: column.to_string(),
                            ref_table: ref_table.to_string(),
                            ref_column: ref_column.to_string(),
                        })
                    }
                    _ => None,
                }
            }
            _ => None,
        })
        .collect())
}

pub async fn exec_batch(
    p: &DbConnectParams,
    statements: &[crate::db::ExecStatement],
) -> Result<Vec<u64>, String> {
    let mut client = connect(p, None).await?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| format!("begin failed: {e}"))?;
    let mut affected = Vec::with_capacity(statements.len());
    for (i, st) in statements.iter().enumerate() {
        let sql = super::inline_sql(&st.sql, &st.values);
        let n = tx
            .execute(&sql, &[])
            .await
            .map_err(|e| format!("statement {} failed: {e}", i + 1))?;
        if n != 1 {
            tx.rollback().await.ok();
            return Err(format!(
                "row {} matched {n} rows (expected exactly 1) — nothing was saved",
                i + 1
            ));
        }
        affected.push(n);
    }
    tx.commit().await.map_err(|e| format!("commit failed: {e}"))?;
    Ok(affected)
}
