//! SQLite driver via `rusqlite` (bundled amalgamation). The DB is a local file
//! (`params.file`); host/port/user are unused. rusqlite is blocking, so every
//! call runs on a `spawn_blocking` thread to keep the async command signatures
//! uniform.

use crate::db::{
    DbConnectParams, DumpProgress, ImportProgress, ImportResult, InsertBudget, JobCtl, QueryResult,
    SchemaObjects, TableSel,
};
use crate::engines::ImportReader;
use rusqlite::types::Value;
use rusqlite::Connection;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;

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
        let aff = exec_batch(&p, &stmts, true).await.expect("exec_batch");
        assert_eq!(aff, vec![1]);
        let after = query(&p, "SELECT qty FROM gadgets WHERE id = 2", Some(1))
            .await
            .expect("verify");
        assert_eq!(after.rows[0][0].as_deref(), Some("42"));
    }

    // cargo test --lib engines::sqlite::tests::fk_smoke -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn fk_smoke() {
        let path = format!("{}/balaudeck-fk.sqlite", std::env::temp_dir().display());
        let _ = std::fs::remove_file(&path);
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE fk_author(id INTEGER PRIMARY KEY, name TEXT);\
                 CREATE TABLE fk_book(id INTEGER PRIMARY KEY, \
                     author_id INTEGER REFERENCES fk_author(id), \
                     editor_id INTEGER REFERENCES fk_author, \
                     title TEXT);",
            )
            .unwrap();
        }
        let p = params(&path);
        let fks = foreign_keys(&p, "fk_book").await.expect("foreign_keys");
        let mut got: Vec<(String, String, String)> = fks
            .into_iter()
            .map(|f| (f.column, f.ref_table, f.ref_column))
            .collect();
        got.sort();
        println!("FKS: {got:?}");
        // Explicit ref column + implicit-PK ref column (editor_id -> fk_author.id).
        assert_eq!(
            got,
            vec![
                ("author_id".into(), "fk_author".into(), "id".into()),
                ("editor_id".into(), "fk_author".into(), "id".into()),
            ]
        );
        assert!(foreign_keys(&p, "fk_author").await.expect("fk").is_empty());

        // Source detection: plain single-table SELECT editable; join is not.
        let editable = query(&p, "SELECT * FROM fk_book", None).await.expect("query");
        assert_eq!(editable.source_table.as_deref(), Some("fk_book"));
        assert!(editable.source_db.is_some());
        let joined = query(
            &p,
            "SELECT fk_book.id FROM fk_book JOIN fk_author ON fk_book.author_id = fk_author.id",
            None,
        )
        .await
        .expect("query");
        assert_eq!(joined.source_table, None);
        let _ = std::fs::remove_file(&path);
    }

    // cargo test --lib engines::sqlite::tests::schema_smoke -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn schema_smoke() {
        let path = format!("{}/balaudeck-schema.sqlite", std::env::temp_dir().display());
        let _ = std::fs::remove_file(&path);
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE sc_parent(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);\
                 CREATE TABLE sc_child(\
                   id INTEGER PRIMARY KEY AUTOINCREMENT, \
                   parent_id INTEGER, \
                   note VARCHAR(255) NOT NULL DEFAULT 'x', \
                   FOREIGN KEY (parent_id) REFERENCES sc_parent(id) ON DELETE CASCADE);\
                 CREATE INDEX idx_note ON sc_child(note);\
                 CREATE UNIQUE INDEX idx_uc ON sc_child(parent_id, note);",
            )
            .unwrap();
        }
        let p = params(&path);
        let s = table_schema(&p, "sc_child").await.expect("schema");
        println!("COLS: {:?}", s.columns.iter().map(|c| (&c.name, &c.data_type, &c.length, c.pk, c.auto_increment, c.nullable)).collect::<Vec<_>>());
        println!("IDX: {:?}", s.indexes.iter().map(|i| (&i.name, &i.columns, i.unique)).collect::<Vec<_>>());
        let id = s.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id.pk && id.auto_increment);
        let note = s.columns.iter().find(|c| c.name == "note").unwrap();
        assert_eq!(note.data_type.to_uppercase(), "VARCHAR");
        assert_eq!(note.length, "255");
        assert!(!note.nullable);
        assert!(note.default.contains('x'));
        assert_eq!(s.foreign_keys.len(), 1);
        assert_eq!(s.foreign_keys[0].ref_table, "sc_parent");
        assert_eq!(s.foreign_keys[0].ref_column, "id");
        assert_eq!(s.foreign_keys[0].on_delete, "CASCADE");
        assert!(s.indexes.iter().any(|i| i.name == "idx_note" && !i.unique));
        assert!(s.indexes.iter().any(|i| i.name == "idx_uc" && i.unique && i.columns.len() == 2));
        let _ = std::fs::remove_file(&path);
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
                source_db: None,
                source_table: None,
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

        // A single-table SELECT stays editable (see pg::query). SQLite has one
        // database per file; use the file name as the db label (matches
        // `list_databases`); `primary_key` ignores it anyway.
        let (source_db, source_table) = if columns.is_empty() {
            (None, None)
        } else {
            match super::single_table_source(&sql) {
                Some(t) => (
                    Some(path.rsplit('/').next().unwrap_or("database").to_string()),
                    Some(t),
                ),
                None => (None, None),
            }
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

pub async fn foreign_keys(
    p: &DbConnectParams,
    table: &str,
) -> Result<Vec<crate::db::ForeignKeyRef>, String> {
    let path = file_path(p)?;
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let q = format!("PRAGMA foreign_key_list(\"{}\")", table.replace('"', "\"\""));
        let mut stmt = conn.prepare(&q).map_err(|e| format!("pragma failed: {e}"))?;
        let mut rows = stmt.query([]).map_err(|e| format!("pragma failed: {e}"))?;
        // columns: id, seq, table(2), from(3), to(4), on_update, on_delete, match
        let mut out: Vec<(i64, i64, crate::db::ForeignKeyRef)> = Vec::new();
        while let Some(row) = rows.next().map_err(|e| format!("read failed: {e}"))? {
            let id: i64 = row.get(0).map_err(|e| format!("read failed: {e}"))?;
            let seq: i64 = row.get(1).map_err(|e| format!("read failed: {e}"))?;
            let ref_table: String = row.get(2).map_err(|e| format!("read failed: {e}"))?;
            let column: String = row.get(3).map_err(|e| format!("read failed: {e}"))?;
            // `to` is NULL when the FK references the parent's PK implicitly.
            let ref_column: Option<String> =
                row.get(4).map_err(|e| format!("read failed: {e}"))?;
            if column.is_empty() || ref_table.is_empty() {
                continue;
            }
            let ref_column = match ref_column {
                Some(c) if !c.is_empty() => c,
                _ => match implicit_pk(&conn, &ref_table) {
                    Some(pk) => pk,
                    None => continue,
                },
            };
            out.push((
                id,
                seq,
                crate::db::ForeignKeyRef {
                    column,
                    ref_table,
                    ref_column,
                },
            ));
        }
        out.sort_by_key(|(id, seq, _)| (*id, *seq));
        Ok(out.into_iter().map(|(_, _, fk)| fk).collect())
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// Best-effort single-column primary key of `table` — used when a FK references
/// a parent table's PK implicitly (`to` is NULL in `foreign_key_list`).
fn implicit_pk(conn: &Connection, table: &str) -> Option<String> {
    let q = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
    let mut stmt = conn.prepare(&q).ok()?;
    let mut rows = stmt.query([]).ok()?;
    while let Ok(Some(row)) = rows.next() {
        let name: String = row.get(1).ok()?;
        let pk: i64 = row.get(5).ok()?;
        if pk == 1 {
            return Some(name);
        }
    }
    None
}

pub async fn table_schema(
    p: &DbConnectParams,
    table: &str,
) -> Result<crate::db::TableSchema, String> {
    use crate::db::{ColumnInfo, FkInfo, TableSchema};
    let path = file_path(p)?;
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let esc = table.replace('"', "\"\"");

        // Columns.
        let mut raw: Vec<(String, String, bool, String, i64)> = Vec::new();
        {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info(\"{esc}\")"))
                .map_err(|e| format!("pragma failed: {e}"))?;
            let mut rows = stmt.query([]).map_err(|e| format!("pragma failed: {e}"))?;
            while let Some(row) = rows.next().map_err(|e| format!("read failed: {e}"))? {
                // cid, name(1), type(2), notnull(3), dflt_value(4), pk(5)
                let name: String = row.get(1).map_err(|e| format!("read failed: {e}"))?;
                let ty: String = row.get(2).map_err(|e| format!("read failed: {e}"))?;
                let notnull: i64 = row.get(3).map_err(|e| format!("read failed: {e}"))?;
                let dflt: Option<String> = row.get(4).map_err(|e| format!("read failed: {e}"))?;
                let pk: i64 = row.get(5).map_err(|e| format!("read failed: {e}"))?;
                raw.push((name, ty, notnull == 0, dflt.unwrap_or_default(), pk));
            }
        }
        let pk_count = raw.iter().filter(|(_, _, _, _, pk)| *pk > 0).count();
        let columns: Vec<ColumnInfo> = raw
            .iter()
            .map(|(name, ty, nullable, dflt, pk)| {
                // A lone INTEGER PRIMARY KEY is SQLite's auto-increment rowid alias.
                let ai = *pk == 1 && pk_count == 1 && ty.to_uppercase().contains("INT");
                // Split "VARCHAR(255)" / "DECIMAL(10,2)" into type + length.
                let (data_type, length) = match (ty.find('('), ty.find(')')) {
                    (Some(a), Some(b)) if b > a + 1 => {
                        (ty[..a].trim().to_string(), ty[a + 1..b].to_string())
                    }
                    _ => (ty.clone(), String::new()),
                };
                ColumnInfo {
                    name: name.clone(),
                    data_type,
                    length,
                    nullable: *nullable,
                    default: dflt.clone(),
                    pk: *pk > 0,
                    auto_increment: ai,
                }
            })
            .collect();

        // Foreign keys (grouped by id => one FK).
        let mut foreign_keys: Vec<FkInfo> = Vec::new();
        {
            let mut stmt = conn
                .prepare(&format!("PRAGMA foreign_key_list(\"{esc}\")"))
                .map_err(|e| format!("pragma failed: {e}"))?;
            let mut rows = stmt.query([]).map_err(|e| format!("pragma failed: {e}"))?;
            while let Some(row) = rows.next().map_err(|e| format!("read failed: {e}"))? {
                // id, seq, table(2), from(3), to(4), on_update(5), on_delete(6)
                let ref_table: String = row.get(2).map_err(|e| format!("read failed: {e}"))?;
                let column: String = row.get(3).map_err(|e| format!("read failed: {e}"))?;
                let to: Option<String> = row.get(4).map_err(|e| format!("read failed: {e}"))?;
                let on_update: String = row.get(5).unwrap_or_default();
                let on_delete: String = row.get(6).unwrap_or_default();
                let ref_column = match to {
                    Some(c) if !c.is_empty() => c,
                    _ => implicit_pk(&conn, &ref_table).unwrap_or_default(),
                };
                foreign_keys.push(FkInfo {
                    name: String::new(), // SQLite FKs are unnamed
                    column,
                    ref_table,
                    ref_column,
                    on_delete: norm_action(&on_delete),
                    on_update: norm_action(&on_update),
                });
            }
        }

        // Non-primary, non-autoindex indexes.
        let mut idx_rows: Vec<(String, String, bool)> = Vec::new();
        let mut index_meta: Vec<(String, bool)> = Vec::new();
        {
            let mut stmt = conn
                .prepare(&format!("PRAGMA index_list(\"{esc}\")"))
                .map_err(|e| format!("pragma failed: {e}"))?;
            let mut rows = stmt.query([]).map_err(|e| format!("pragma failed: {e}"))?;
            while let Some(row) = rows.next().map_err(|e| format!("read failed: {e}"))? {
                // seq, name(1), unique(2), origin(3: c/u/pk), partial
                let name: String = row.get(1).map_err(|e| format!("read failed: {e}"))?;
                let unique: i64 = row.get(2).map_err(|e| format!("read failed: {e}"))?;
                let origin: String = row.get(3).unwrap_or_default();
                if origin == "pk" {
                    continue; // PK is modelled on the columns, not as an index
                }
                index_meta.push((name, unique == 1));
            }
        }
        for (name, unique) in &index_meta {
            let mut stmt = conn
                .prepare(&format!("PRAGMA index_info(\"{}\")", name.replace('"', "\"\"")))
                .map_err(|e| format!("pragma failed: {e}"))?;
            let mut rows = stmt.query([]).map_err(|e| format!("pragma failed: {e}"))?;
            while let Some(row) = rows.next().map_err(|e| format!("read failed: {e}"))? {
                // seqno, cid, name(2)
                let col: Option<String> = row.get(2).map_err(|e| format!("read failed: {e}"))?;
                if let Some(col) = col {
                    idx_rows.push((name.clone(), col, *unique));
                }
            }
        }

        Ok(TableSchema {
            columns,
            foreign_keys,
            indexes: crate::db::group_indexes(idx_rows),
        })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// Normalise a SQLite FK action ("NO ACTION" => "" so the designer treats it as
/// the default and doesn't emit a redundant clause).
fn norm_action(a: &str) -> String {
    if a.eq_ignore_ascii_case("NO ACTION") || a.is_empty() {
        String::new()
    } else {
        a.to_string()
    }
}

const NO_USERS: &str = "SQLite databases have no user accounts to manage.";

pub async fn list_users(_p: &DbConnectParams) -> Result<Vec<crate::db::DbUser>, String> {
    Err(NO_USERS.into())
}
pub async fn user_detail(
    _p: &DbConnectParams,
    _user: &str,
    _host: &str,
) -> Result<crate::db::UserDetail, String> {
    Err(NO_USERS.into())
}
pub async fn exec_user_sql(_p: &DbConnectParams, _statements: &[String]) -> Result<(), String> {
    Err(NO_USERS.into())
}

/// Streaming import (see `crate::engines::import_stream`). The whole loop runs in
/// one `spawn_blocking` holding the rusqlite connection: atomic mode inside a
/// transaction (`PRAGMA foreign_keys=OFF` around it, restored after), non-atomic
/// in autocommit so `continue_on_error` isolates failures. Pulls statements from
/// the moved `reader`, so memory stays bounded.
#[allow(clippy::too_many_arguments)]
pub async fn import_stream(
    p: &DbConnectParams,
    reader: ImportReader,
    ctl: &Arc<JobCtl>,
    continue_on_error: bool,
    autocommit_off: bool,
    on_progress: &Channel<ImportProgress>,
    total_bytes: u64,
) -> Result<ImportResult, String> {
    let path = file_path(p)?;
    let ctl = ctl.clone();
    let on_progress = on_progress.clone();
    tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let atomic = autocommit_off && !continue_on_error;
        let mut conn = Connection::open(&path).map_err(|e| format!("open failed: {e}"))?;
        let mut executed = 0usize;
        let mut failed = 0usize;
        let mut last_report = 0usize;

        if atomic {
            conn.execute_batch("PRAGMA foreign_keys=OFF")
                .map_err(|e| format!("pragma failed: {e}"))?;
            let tx = conn.transaction().map_err(|e| format!("begin failed: {e}"))?;
            loop {
                while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(120));
                }
                if ctl.cancelled.load(Ordering::Relaxed) {
                    drop(tx); // rollback
                    conn.execute_batch("PRAGMA foreign_keys=ON").ok();
                    on_progress.send(ImportProgress::Cancelled { executed, failed }).ok();
                    return Ok(ImportResult { executed, failed, error: None });
                }
                let stmt = match reader.next() {
                    None => break,
                    Some(Err(e)) => {
                        drop(tx);
                        conn.execute_batch("PRAGMA foreign_keys=ON").ok();
                        let msg = format!("read file failed: {e}");
                        on_progress.send(ImportProgress::Failed { executed, error: msg.clone() }).ok();
                        return Ok(ImportResult { executed, failed, error: Some(msg) });
                    }
                    Some(Ok(s)) => s,
                };
                if let Err(e) = tx.execute_batch(&stmt) {
                    let msg = format!("statement {}: {e}", executed + 1);
                    drop(tx);
                    conn.execute_batch("PRAGMA foreign_keys=ON").ok();
                    on_progress.send(ImportProgress::Failed { executed, error: msg.clone() }).ok();
                    return Ok(ImportResult { executed, failed, error: Some(msg) });
                }
                executed += 1;
                if executed - last_report >= 50 {
                    last_report = executed;
                    on_progress
                        .send(ImportProgress::Progress { executed, failed, bytes: reader.bytes_read(), total_bytes })
                        .ok();
                }
            }
            tx.commit().map_err(|e| format!("commit failed: {e}"))?;
            conn.execute_batch("PRAGMA foreign_keys=ON").ok();
        } else {
            loop {
                while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(120));
                }
                if ctl.cancelled.load(Ordering::Relaxed) {
                    on_progress.send(ImportProgress::Cancelled { executed, failed }).ok();
                    return Ok(ImportResult { executed, failed, error: None });
                }
                let stmt = match reader.next() {
                    None => break,
                    Some(Err(e)) => {
                        let msg = format!("read file failed: {e}");
                        on_progress.send(ImportProgress::Failed { executed, error: msg.clone() }).ok();
                        return Ok(ImportResult { executed, failed, error: Some(msg) });
                    }
                    Some(Ok(s)) => s,
                };
                match conn.execute_batch(&stmt) {
                    Ok(()) => executed += 1,
                    Err(e) => {
                        if continue_on_error {
                            failed += 1;
                            on_progress
                                .send(ImportProgress::StmtError { index: executed + failed, error: format!("{e}") })
                                .ok();
                        } else {
                            let msg = format!("statement {}: {e}", executed + failed + 1);
                            on_progress.send(ImportProgress::Failed { executed, error: msg.clone() }).ok();
                            return Ok(ImportResult { executed, failed, error: Some(msg) });
                        }
                    }
                }
                if (executed + failed) - last_report >= 50 {
                    last_report = executed + failed;
                    on_progress
                        .send(ImportProgress::Progress { executed, failed, bytes: reader.bytes_read(), total_bytes })
                        .ok();
                }
            }
        }

        on_progress.send(ImportProgress::Done { executed, failed }).ok();
        Ok(ImportResult { executed, failed, error: None })
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

/// One SQL literal for a source cell, faithful to the value's type. Unlike the
/// browse path (which shows `<N bytes>` for blobs), a transfer must carry blob
/// bytes exactly — as an `X'..'` hex literal.
fn sqlite_literal(v: rusqlite::types::ValueRef<'_>) -> String {
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => "NULL".to_string(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(f) if f.is_finite() => format!("{f}"),
        ValueRef::Real(_) => "NULL".to_string(),
        ValueRef::Text(b) => format!("'{}'", String::from_utf8_lossy(b).replace('\'', "''")),
        ValueRef::Blob(b) => {
            let mut h = String::with_capacity(b.len() * 2 + 3);
            h.push_str("X'");
            for byte in b {
                use std::fmt::Write as _;
                let _ = write!(h, "{byte:02x}");
            }
            h.push('\'');
            h
        }
    }
}

/// Fused streaming Data Transfer for SQLite → SQLite: both files are opened in a
/// single blocking task; rows stream from the source cursor straight into
/// batched multi-row INSERTs on the target — no temp dump, bounded memory.
/// Structure comes from the source's `sqlite_master` DDL (table + its indexes).
/// Commits every ~64 MiB so a huge table isn't one transaction.
#[allow(clippy::too_many_arguments)]
pub async fn transfer_streaming(
    source: &DbConnectParams,
    target: &DbConnectParams,
    selection: &[TableSel],
    budget: InsertBudget,
    continue_on_error: bool,
    ctl: &Arc<JobCtl>,
    on_dump: &Channel<DumpProgress>,
    on_import: &Channel<ImportProgress>,
) -> Result<ImportResult, String> {
    const COMMIT_EVERY_BYTES: usize = 64 * 1024 * 1024;
    let plan = crate::engines::transfer_plan(source, "main", selection).await?;
    let src_path = file_path(source)?;
    let dst_path = file_path(target)?;
    let ctl = ctl.clone();
    let on_dump = on_dump.clone();
    let on_import = on_import.clone();

    tokio::task::spawn_blocking(move || -> Result<ImportResult, String> {
        let sconn = Connection::open(&src_path).map_err(|e| format!("source open failed: {e}"))?;
        let tconn = Connection::open(&dst_path).map_err(|e| format!("target open failed: {e}"))?;
        tconn.execute_batch("PRAGMA foreign_keys=OFF").ok();
        let total_tables = plan.len();

        // Row-count estimate for a determinate bar (cheap on a local file).
        let mut est_total: u64 = 0;
        for (t, _s, d) in &plan {
            if *d {
                let sql = format!("SELECT COUNT(*) FROM {}", crate::db::q_ident("sqlite", t));
                if let Ok(n) = sconn.query_row(&sql, [], |r| r.get::<_, i64>(0)) {
                    est_total += n.max(0) as u64;
                }
            }
        }
        on_import.send(ImportProgress::Start { total_bytes: est_total }).ok();

        macro_rules! unwind_target {
            () => {{
                tconn.execute_batch("ROLLBACK").ok();
                tconn.execute_batch("PRAGMA foreign_keys=ON").ok();
            }};
        }

        let mut executed: u64 = 0;
        let mut failed = 0usize;
        let mut since_commit = 0usize;
        let mut last_report: u64 = 0;
        tconn.execute_batch("BEGIN").ok();

        for (ti, (t, want_struct, want_data)) in plan.iter().enumerate() {
            if ctl.cancelled.load(Ordering::Relaxed) {
                unwind_target!();
                on_import.send(ImportProgress::Cancelled { executed: executed as usize, failed }).ok();
                return Ok(ImportResult { executed: executed as usize, failed, error: None });
            }
            on_dump
                .send(DumpProgress::Table { name: t.clone(), index: ti + 1, total: total_tables, rows: 0 })
                .ok();
            let qt = crate::db::q_ident("sqlite", t);

            if *want_struct {
                let mut stmts: Vec<String> = vec![format!("DROP TABLE IF EXISTS {qt}")];
                {
                    let mut s = sconn
                        .prepare("SELECT sql FROM sqlite_master WHERE tbl_name=?1 AND sql IS NOT NULL ORDER BY (type='table') DESC")
                        .map_err(|e| format!("ddl failed for {t}: {e}"))?;
                    let rows = s
                        .query_map([t.as_str()], |r| r.get::<_, String>(0))
                        .map_err(|e| format!("ddl failed for {t}: {e}"))?;
                    for r in rows.flatten() {
                        stmts.push(r);
                    }
                }
                for stmt in stmts {
                    if let Err(e) = tconn.execute_batch(&stmt) {
                        if continue_on_error {
                            failed += 1;
                            on_import.send(ImportProgress::StmtError { index: 0, error: format!("{t}: {e}") }).ok();
                        } else {
                            unwind_target!();
                            let msg = format!("create {t} failed: {e}");
                            on_import.send(ImportProgress::Failed { executed: executed as usize, error: msg.clone() }).ok();
                            return Ok(ImportResult { executed: executed as usize, failed, error: Some(msg) });
                        }
                    }
                }
            }
            if !*want_data {
                continue;
            }

            let mut stmt = sconn
                .prepare(&format!("SELECT * FROM {qt}"))
                .map_err(|e| format!("select failed for {t}: {e}"))?;
            let ncol = stmt.column_count();
            let collist = stmt
                .column_names()
                .iter()
                .map(|c| crate::db::q_ident("sqlite", c))
                .collect::<Vec<_>>()
                .join(", ");
            let head = format!("INSERT INTO {qt} ({collist}) VALUES ");
            let mut rows = stmt.query([]).map_err(|e| format!("read failed for {t}: {e}"))?;
            let mut buf = String::new();
            let mut rows_in = 0usize;
            let mut aborted: Option<String> = None;
            loop {
                while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(120));
                }
                if ctl.cancelled.load(Ordering::Relaxed) {
                    break;
                }
                let row = match rows.next() {
                    Ok(Some(r)) => r,
                    Ok(None) => break,
                    Err(e) => {
                        aborted = Some(format!("read failed for {t}: {e}"));
                        break;
                    }
                };
                if rows_in > 0 {
                    buf.push(',');
                }
                buf.push('(');
                for i in 0..ncol {
                    if i > 0 {
                        buf.push_str(", ");
                    }
                    match row.get_ref(i) {
                        Ok(v) => buf.push_str(&sqlite_literal(v)),
                        Err(_) => buf.push_str("NULL"),
                    }
                }
                buf.push(')');
                rows_in += 1;
                if rows_in >= budget.rows || buf.len() >= budget.bytes {
                    let bytes = buf.len();
                    let sql = format!("{head}{buf}");
                    match tconn.execute_batch(&sql) {
                        Ok(()) => executed += rows_in as u64,
                        Err(e) => {
                            if continue_on_error {
                                failed += 1;
                                on_import.send(ImportProgress::StmtError { index: 0, error: format!("{t}: {e}") }).ok();
                            } else {
                                aborted = Some(format!("insert into {t} failed: {e}"));
                                break;
                            }
                        }
                    }
                    buf.clear();
                    rows_in = 0;
                    since_commit += bytes;
                    if since_commit >= COMMIT_EVERY_BYTES {
                        tconn.execute_batch("COMMIT; BEGIN").ok();
                        since_commit = 0;
                    }
                    if executed - last_report >= 2000 {
                        last_report = executed;
                        on_import
                            .send(ImportProgress::Progress { executed: executed as usize, failed, bytes: executed, total_bytes: est_total.max(executed) })
                            .ok();
                    }
                }
            }
            if aborted.is_none() && rows_in > 0 {
                let sql = format!("{head}{buf}");
                if let Err(e) = tconn.execute_batch(&sql) {
                    if continue_on_error {
                        failed += 1;
                        on_import.send(ImportProgress::StmtError { index: 0, error: format!("{t}: {e}") }).ok();
                    } else {
                        aborted = Some(format!("insert into {t} failed: {e}"));
                    }
                } else {
                    executed += rows_in as u64;
                }
            }
            drop(rows);
            drop(stmt);
            if let Some(msg) = aborted {
                unwind_target!();
                on_import.send(ImportProgress::Failed { executed: executed as usize, error: msg.clone() }).ok();
                return Ok(ImportResult { executed: executed as usize, failed, error: Some(msg) });
            }
            on_import
                .send(ImportProgress::Progress { executed: executed as usize, failed, bytes: executed, total_bytes: est_total.max(executed) })
                .ok();
        }

        tconn.execute_batch("COMMIT").map_err(|e| format!("commit failed: {e}"))?;
        tconn.execute_batch("PRAGMA foreign_keys=ON").ok();
        on_import.send(ImportProgress::Done { executed: executed as usize, failed }).ok();
        Ok(ImportResult { executed: executed as usize, failed, error: None })
    })
    .await
    .map_err(|e| format!("transfer task failed: {e}"))?
}

pub async fn exec_ddl(p: &DbConnectParams, statements: &[String]) -> Result<(), String> {
    let path = file_path(p)?;
    let stmts: Vec<String> = statements.to_vec();
    tokio::task::spawn_blocking(move || {
        let mut conn = Connection::open(&path).map_err(|e| format!("open failed: {e}"))?;
        // `PRAGMA foreign_keys` is a no-op inside a transaction, so it must be set
        // BEFORE begin. Off during the rebuild so a table swap doesn't trip child
        // FKs mid-flight; restored after commit. The official ALTER-via-rebuild
        // recipe (https://sqlite.org/lang_altertable.html) relies on this.
        conn.execute_batch("PRAGMA foreign_keys=OFF")
            .map_err(|e| format!("pragma failed: {e}"))?;
        let tx = conn.transaction().map_err(|e| format!("begin failed: {e}"))?;
        for (i, sql) in stmts.iter().enumerate() {
            tx.execute_batch(sql)
                .map_err(|e| format!("statement {} failed: {e}", i + 1))?;
        }
        tx.commit().map_err(|e| format!("commit failed: {e}"))?;
        conn.execute_batch("PRAGMA foreign_keys=ON").ok();
        Ok(())
    })
    .await
    .map_err(|e| format!("task failed: {e}"))?
}

pub async fn exec_batch(
    p: &DbConnectParams,
    statements: &[crate::db::ExecStatement],
    require_single: bool,
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
            if require_single && n != 1 {
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
