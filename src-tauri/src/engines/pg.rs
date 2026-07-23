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

    // cargo test --lib engines::pg::tests::schema_smoke -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn schema_smoke() {
        let p = params(Some("demo"));
        for sql in [
            "DROP TABLE IF EXISTS sc_child",
            "DROP TABLE IF EXISTS sc_parent",
            "CREATE TABLE sc_parent(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name varchar(100))",
            "CREATE TABLE sc_child(id int PRIMARY KEY, parent_id bigint, \
               note varchar(255) NOT NULL DEFAULT 'x', \
               CONSTRAINT fk_p FOREIGN KEY (parent_id) REFERENCES sc_parent(id) ON DELETE CASCADE)",
            "CREATE INDEX idx_note ON sc_child(note)",
        ] {
            query(&p, sql, None).await.expect(sql);
        }
        let s = table_schema(&p, "demo", "sc_child").await.expect("schema");
        println!("CHILD COLS: {:?}", s.columns.iter().map(|c| (&c.name, &c.data_type, &c.length, c.pk, c.nullable)).collect::<Vec<_>>());
        let note = s.columns.iter().find(|c| c.name == "note").expect("note col");
        assert_eq!(note.length, "255");
        assert!(!note.nullable);
        assert!(note.default.contains('x'));
        assert!(s.columns.iter().find(|c| c.name == "id").unwrap().pk);
        assert_eq!(s.foreign_keys.len(), 1);
        assert_eq!(s.foreign_keys[0].ref_table, "sc_parent");
        assert_eq!(s.foreign_keys[0].on_delete, "CASCADE");
        assert!(s.indexes.iter().any(|i| i.name == "idx_note" && i.columns == vec!["note".to_string()]));

        let sp = table_schema(&p, "demo", "sc_parent").await.expect("schema");
        let pid = sp.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(pid.pk && pid.auto_increment, "parent id should be identity PK");
    }

    // cargo test --lib engines::pg::tests::user_mgmt_smoke -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn user_mgmt_smoke() {
        let p = params(Some("demo"));
        // Clean slate: drop the table first so its grants don't block DROP ROLE.
        let _ = query(&p, "DROP TABLE IF EXISTS um_t", None).await;
        let _ = exec_user_sql(&p, &["DROP ROLE IF EXISTS bdk_role".into()]).await;
        query(&p, "CREATE TABLE um_t(id int)", None).await.expect("create table");
        exec_user_sql(&p, &[
            "CREATE ROLE bdk_role WITH LOGIN CREATEDB CONNECTION LIMIT 5 PASSWORD 'pw'".into(),
            "GRANT SELECT, INSERT ON TABLE um_t TO bdk_role".into(),
        ]).await.expect("create + grant");

        let users = list_users(&p).await.expect("list");
        assert!(users.iter().any(|u| u.name == "bdk_role" && !u.is_role), "bdk_role listed as login user");

        let d = user_detail(&p, "bdk_role", "").await.expect("detail");
        assert!(d.attributes.can_create_db, "createdb");
        assert!(d.attributes.can_login, "login");
        assert_eq!(d.attributes.max_user_connections, 5, "connection limit");
        println!("PG GRANTS: {:?}", d.grants);
        assert!(d.grants.iter().any(|g| g.contains("um_t") && g.contains("SELECT")), "table grant present");

        // Rollback on a bad statement (pg role DDL is transactional).
        let bad = exec_user_sql(&p, &[
            "ALTER ROLE bdk_role WITH NOCREATEDB".into(),
            "ALTER ROLE bdk_role WITH BOGUS".into(),
        ]).await;
        assert!(bad.is_err(), "bad statement errors");
        let d2 = user_detail(&p, "bdk_role", "").await.expect("detail2");
        assert!(d2.attributes.can_create_db, "createdb still set (whole batch rolled back)");

        let _ = query(&p, "DROP TABLE um_t", None).await;
        exec_user_sql(&p, &["DROP ROLE bdk_role".into()]).await.expect("drop");
        let after = list_users(&p).await.expect("list2");
        assert!(!after.iter().any(|u| u.name == "bdk_role"), "dropped");
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

pub async fn table_schema(
    p: &DbConnectParams,
    database: &str,
    table: &str,
) -> Result<crate::db::TableSchema, String> {
    use crate::db::{ColumnInfo, FkInfo, TableSchema};
    let client = connect(p, Some(database)).await?;
    let esc = table.replace('\'', "''");

    // Columns, with PK membership and identity/serial detection.
    let col_sql = format!(
        "SELECT c.column_name, c.data_type, \
                COALESCE(c.character_maximum_length::text, \
                  CASE WHEN c.data_type IN ('numeric','decimal') AND c.numeric_precision IS NOT NULL \
                    THEN c.numeric_precision || ',' || COALESCE(c.numeric_scale, 0) ELSE '' END, '') AS len, \
                c.is_nullable, COALESCE(c.column_default, ''), \
                CASE WHEN c.is_identity = 'YES' OR c.column_default LIKE 'nextval(%' THEN 't' ELSE 'f' END AS ai, \
                CASE WHEN pk.column_name IS NOT NULL THEN 't' ELSE 'f' END AS is_pk \
         FROM information_schema.columns c \
         LEFT JOIN ( \
           SELECT kcu.column_name FROM information_schema.table_constraints tc \
           JOIN information_schema.key_column_usage kcu \
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema \
           WHERE tc.table_name = '{esc}' AND tc.constraint_type = 'PRIMARY KEY' \
             AND tc.table_schema = ANY(current_schemas(true)) \
         ) pk ON pk.column_name = c.column_name \
         WHERE c.table_name = '{esc}' AND c.table_schema = ANY(current_schemas(true)) \
         ORDER BY c.ordinal_position"
    );
    let mut columns = Vec::new();
    for m in client
        .simple_query(&col_sql)
        .await
        .map_err(|e| format!("columns failed: {e}"))?
    {
        if let SimpleQueryMessage::Row(r) = m {
            let default = r.get(4).unwrap_or("").to_string();
            // A serial/identity default is implementation noise in the designer.
            let default = if r.get(5) == Some("t") { String::new() } else { default };
            columns.push(ColumnInfo {
                name: r.get(0).unwrap_or("").to_string(),
                data_type: r.get(1).unwrap_or("").to_string(),
                length: r.get(2).unwrap_or("").to_string(),
                nullable: r.get(3).unwrap_or("") == "YES",
                default,
                pk: r.get(6) == Some("t"),
                auto_increment: r.get(5) == Some("t"),
            });
        }
    }

    // Foreign keys with referential actions.
    let fk_sql = format!(
        "SELECT tc.constraint_name, kcu.column_name, ccu.table_name, ccu.column_name, \
                rc.delete_rule, rc.update_rule \
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
         ORDER BY tc.constraint_name, kcu.ordinal_position"
    );
    let mut foreign_keys = Vec::new();
    for m in client
        .simple_query(&fk_sql)
        .await
        .map_err(|e| format!("foreign keys failed: {e}"))?
    {
        if let SimpleQueryMessage::Row(r) = m {
            foreign_keys.push(FkInfo {
                name: r.get(0).unwrap_or("").to_string(),
                column: r.get(1).unwrap_or("").to_string(),
                ref_table: r.get(2).unwrap_or("").to_string(),
                ref_column: r.get(3).unwrap_or("").to_string(),
                on_delete: r.get(4).unwrap_or("").to_string(),
                on_update: r.get(5).unwrap_or("").to_string(),
            });
        }
    }

    // Non-primary indexes, ordered by their position in the index key.
    let idx_sql = format!(
        "SELECT i.relname, a.attname, ix.indisunique \
         FROM pg_class t \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         WHERE t.relname = '{esc}' AND NOT ix.indisprimary \
           AND t.relnamespace = ANY(current_schemas(true)::regnamespace[]) \
         ORDER BY i.relname, array_position(ix.indkey, a.attnum)"
    );
    let mut idx_rows: Vec<(String, String, bool)> = Vec::new();
    for m in client
        .simple_query(&idx_sql)
        .await
        .map_err(|e| format!("indexes failed: {e}"))?
    {
        if let SimpleQueryMessage::Row(r) = m {
            idx_rows.push((
                r.get(0).unwrap_or("").to_string(),
                r.get(1).unwrap_or("").to_string(),
                r.get(2) == Some("t"),
            ));
        }
    }

    Ok(TableSchema {
        columns,
        foreign_keys,
        indexes: crate::db::group_indexes(idx_rows),
    })
}

/// List cluster roles. NOLOGIN roles are shown as "roles" (group roles); a role
/// with `rolvaliduntil` in the past is flagged expired. pg has no account lock.
pub async fn list_users(p: &DbConnectParams) -> Result<Vec<crate::db::DbUser>, String> {
    use crate::db::DbUser;
    let client = connect(p, None).await?;
    let sql = "SELECT rolname, \
                 CASE WHEN rolcanlogin THEN 't' ELSE 'f' END, \
                 CASE WHEN rolvaliduntil IS NOT NULL AND rolvaliduntil < now() THEN 't' ELSE 'f' END \
               FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolcanlogin DESC, rolname";
    let msgs = client
        .simple_query(sql)
        .await
        .map_err(|e| format!("list users failed: {e}"))?;
    Ok(msgs
        .into_iter()
        .filter_map(|m| match m {
            SimpleQueryMessage::Row(r) => {
                let name = r.get(0).unwrap_or("").to_string();
                if name.is_empty() {
                    return None;
                }
                let can_login = r.get(1) == Some("t");
                Some(DbUser {
                    name,
                    host: String::new(),
                    is_role: !can_login,
                    locked: false,
                    expired: r.get(2) == Some("t"),
                })
            }
            _ => None,
        })
        .collect())
}

pub async fn user_detail(
    p: &DbConnectParams,
    user: &str,
    _host: &str,
) -> Result<crate::db::UserDetail, String> {
    use crate::db::{UserAttributes, UserDetail};
    let client = connect(p, None).await?;
    let esc = user.replace('\'', "''");

    // Role attributes.
    let a_sql = format!(
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolconnlimit, \
                COALESCE(rolvaliduntil::text, '') FROM pg_roles WHERE rolname = '{esc}'"
    );
    let a_msgs = client
        .simple_query(&a_sql)
        .await
        .map_err(|e| format!("role attributes failed: {e}"))?;
    let arow = a_msgs.into_iter().find_map(|m| match m {
        SimpleQueryMessage::Row(r) => Some(r),
        _ => None,
    });
    let arow = arow.ok_or_else(|| format!("role '{user}' not found"))?;
    let conn_limit: i64 = arow.get(4).and_then(|s| s.parse().ok()).unwrap_or(-1);
    let valid_until = arow.get(5).filter(|s| !s.is_empty()).map(|s| s.to_string());
    let attributes = UserAttributes {
        auth_plugin: String::new(),
        require_ssl: String::new(),
        max_queries_per_hour: 0,
        max_connections_per_hour: 0,
        max_updates_per_hour: 0,
        max_user_connections: if conn_limit < 0 { 0 } else { conn_limit },
        account_locked: false,
        password_expired: false,
        password_lifetime: None,
        is_superuser: arow.get(0) == Some("t"),
        can_create_db: arow.get(1) == Some("t"),
        can_create_role: arow.get(2) == Some("t"),
        can_login: arow.get(3) == Some("t"),
        valid_until,
    };

    let mut grants: Vec<String> = Vec::new();

    // Database-level privileges on the connected database.
    let db_sql = format!(
        "SELECT current_database(), \
                has_database_privilege('{esc}', current_database(), 'CONNECT'), \
                has_database_privilege('{esc}', current_database(), 'CREATE'), \
                has_database_privilege('{esc}', current_database(), 'TEMP')"
    );
    if let Ok(msgs) = client.simple_query(&db_sql).await {
        for m in msgs {
            if let SimpleQueryMessage::Row(r) = m {
                let db = r.get(0).unwrap_or("");
                let mut privs: Vec<&str> = Vec::new();
                if r.get(1) == Some("t") {
                    privs.push("CONNECT");
                }
                if r.get(2) == Some("t") {
                    privs.push("CREATE");
                }
                if r.get(3) == Some("t") {
                    privs.push("TEMPORARY");
                }
                if !privs.is_empty() {
                    grants.push(format!(
                        "GRANT {} ON DATABASE \"{}\" TO \"{}\"",
                        privs.join(", "),
                        db.replace('"', "\"\""),
                        user.replace('"', "\"\"")
                    ));
                }
            }
        }
    }

    // Table-level privileges in the connected database.
    let g_sql = format!(
        "SELECT table_schema, table_name, privilege_type, is_grantable \
         FROM information_schema.role_table_grants \
         WHERE grantee = '{esc}' AND table_schema NOT IN ('pg_catalog','information_schema') \
         ORDER BY table_schema, table_name, privilege_type"
    );
    // (schema, table) -> (privs, grantable)
    let mut tbl: std::collections::HashMap<(String, String), (Vec<String>, bool)> =
        std::collections::HashMap::new();
    let mut order: Vec<(String, String)> = Vec::new();
    if let Ok(msgs) = client.simple_query(&g_sql).await {
        for m in msgs {
            if let SimpleQueryMessage::Row(r) = m {
                let schema = r.get(0).unwrap_or("").to_string();
                let table = r.get(1).unwrap_or("").to_string();
                let priv_ = r.get(2).unwrap_or("").to_string();
                let grantable = r.get(3) == Some("YES");
                if table.is_empty() || priv_.is_empty() {
                    continue;
                }
                let key = (schema, table);
                let e = tbl.entry(key.clone()).or_insert_with(|| {
                    order.push(key.clone());
                    (Vec::new(), false)
                });
                e.0.push(priv_);
                if grantable {
                    e.1 = true;
                }
            }
        }
    }
    for key in order {
        let (privs, grantable) = tbl.remove(&key).unwrap();
        let mut s = format!(
            "GRANT {} ON TABLE \"{}\".\"{}\" TO \"{}\"",
            privs.join(", "),
            key.0.replace('"', "\"\""),
            key.1.replace('"', "\"\""),
            user.replace('"', "\"\"")
        );
        if grantable {
            s.push_str(" WITH GRANT OPTION");
        }
        grants.push(s);
    }

    // Role memberships.
    let r_sql = format!(
        "SELECT g.rolname FROM pg_auth_members m \
         JOIN pg_roles g ON g.oid = m.roleid \
         JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = '{esc}' ORDER BY g.rolname"
    );
    let mut roles: Vec<String> = Vec::new();
    if let Ok(msgs) = client.simple_query(&r_sql).await {
        for m in msgs {
            if let SimpleQueryMessage::Row(r) = m {
                if let Some(n) = r.get(0) {
                    roles.push(n.to_string());
                }
            }
        }
    }

    Ok(UserDetail {
        name: user.to_string(),
        host: String::new(),
        attributes,
        grants,
        roles,
    })
}

/// Run role/GRANT statements in one transaction (pg role + privilege DDL is
/// transactional, so a mid-batch failure rolls the whole thing back).
pub async fn exec_user_sql(p: &DbConnectParams, statements: &[String]) -> Result<(), String> {
    let mut client = connect(p, None).await?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| format!("begin failed: {e}"))?;
    for (i, sql) in statements.iter().enumerate() {
        tx.batch_execute(sql)
            .await
            .map_err(|e| format!("statement {} failed: {e}", i + 1))?;
    }
    tx.commit().await.map_err(|e| format!("commit failed: {e}"))
}

pub async fn exec_ddl(
    p: &DbConnectParams,
    database: &str,
    statements: &[String],
) -> Result<(), String> {
    // Postgres DDL is transactional, so a failed statement rolls the whole thing
    // back. Connect to the BROWSED database (can't cross-DB on one connection).
    let mut client = connect(p, Some(database)).await?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| format!("begin failed: {e}"))?;
    for (i, sql) in statements.iter().enumerate() {
        tx.batch_execute(sql)
            .await
            .map_err(|e| format!("statement {} failed: {e}", i + 1))?;
    }
    tx.commit().await.map_err(|e| format!("commit failed: {e}"))
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
