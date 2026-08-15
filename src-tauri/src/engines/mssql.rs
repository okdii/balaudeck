//! SQL Server (MSSQL) driver via `tiberius` over a tokio TCP stream. tiberius
//! returns typed `ColumnData`, so a small decoder renders each cell to a display
//! string for the generic grid (dates/xml fall back to Debug for now).

use crate::db::{
    DbConnectParams, DumpProgress, ImportProgress, ImportResult, InsertBudget, JobCtl, QueryResult,
    Routine, SchemaObjects, TableSel,
};
use crate::engines::ImportReader;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
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

/// Streaming import (see `crate::engines::import_stream`). Atomic mode wraps the
/// whole file in `BEGIN TRANSACTION` … `COMMIT` with `SET XACT_ABORT ON` so any
/// error dooms and rolls back the transaction; non-atomic runs each statement in
/// autocommit so `continue_on_error` isolates a failure.
#[allow(clippy::too_many_arguments)]
pub async fn import_stream(
    p: &DbConnectParams,
    database: &str,
    mut reader: ImportReader,
    ctl: &Arc<JobCtl>,
    continue_on_error: bool,
    autocommit_off: bool,
    on_progress: &Channel<ImportProgress>,
    total_bytes: u64,
) -> Result<ImportResult, String> {
    let mut client = connect(p, Some(database)).await?;
    let atomic = autocommit_off && !continue_on_error;
    let mut executed = 0usize;
    let mut failed = 0usize;
    let mut last_report = 0usize;
    const BATCH_BYTES: usize = 1 << 20;

    if atomic {
        run_batch(&mut client, "SET XACT_ABORT ON").await?;
        run_batch(&mut client, "BEGIN TRANSACTION").await?;
        let mut batch: Vec<String> = Vec::new();
        let mut eof = false;
        while !eof {
            while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            if ctl.cancelled.load(Ordering::Relaxed) {
                let _ = run_batch(&mut client, "ROLLBACK TRANSACTION").await;
                on_progress.send(ImportProgress::Cancelled { executed, failed }).ok();
                return Ok(ImportResult { executed, failed, error: None });
            }
            batch.clear();
            let mut bytes = 0usize;
            while bytes < BATCH_BYTES {
                match reader.next() {
                    None => {
                        eof = true;
                        break;
                    }
                    Some(Err(e)) => {
                        let _ = run_batch(&mut client, "ROLLBACK TRANSACTION").await;
                        let msg = format!("read file failed: {e}");
                        on_progress.send(ImportProgress::Failed { executed, error: msg.clone() }).ok();
                        return Ok(ImportResult { executed, failed, error: Some(msg) });
                    }
                    Some(Ok(s)) => {
                        bytes += s.len();
                        batch.push(s);
                    }
                }
            }
            if batch.is_empty() {
                break;
            }
            let n = batch.len();
            if let Err(e) = run_batch(&mut client, &batch.join(";\n")).await {
                let msg = format!("statement ~{}: {e}", executed + 1);
                let _ = run_batch(&mut client, "ROLLBACK TRANSACTION").await;
                on_progress.send(ImportProgress::Failed { executed, error: msg.clone() }).ok();
                return Ok(ImportResult { executed, failed, error: Some(msg) });
            }
            executed += n;
            if eof || executed - last_report >= 20 {
                last_report = executed;
                on_progress
                    .send(ImportProgress::Progress { executed, failed, bytes: reader.bytes_read(), total_bytes })
                    .ok();
            }
        }
        run_batch(&mut client, "COMMIT TRANSACTION")
            .await
            .map_err(|e| format!("commit failed: {e}"))?;
    } else {
        loop {
            while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(120)).await;
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
            match run_batch(&mut client, &stmt).await {
                Ok(()) => executed += 1,
                Err(e) => {
                    if continue_on_error {
                        failed += 1;
                        on_progress
                            .send(ImportProgress::StmtError { index: executed + failed, error: e })
                            .ok();
                    } else {
                        let msg = format!("statement {}: {e}", executed + failed + 1);
                        on_progress.send(ImportProgress::Failed { executed, error: msg.clone() }).ok();
                        return Ok(ImportResult { executed, failed, error: Some(msg) });
                    }
                }
            }
            if (executed + failed) - last_report >= 20 {
                last_report = executed + failed;
                on_progress
                    .send(ImportProgress::Progress { executed, failed, bytes: reader.bytes_read(), total_bytes })
                    .ok();
            }
        }
    }

    on_progress.send(ImportProgress::Done { executed, failed }).ok();
    Ok(ImportResult { executed, failed, error: None })
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

/// List server logins + roles from sys.server_principals (server scope).
pub async fn list_users(p: &DbConnectParams) -> Result<Vec<crate::db::DbUser>, String> {
    use crate::db::DbUser;
    let mut client = connect(p, Some("master")).await?;
    let rows = rows_of(
        &mut client,
        "SELECT name, type_desc, is_disabled FROM sys.server_principals \
         WHERE type IN ('S','U','G','R') AND name NOT LIKE '##%' ORDER BY name",
    )
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let name = r.get::<&str, _>(0)?.to_string();
            let type_desc = r.get::<&str, _>(1).unwrap_or("");
            Some(DbUser {
                name,
                host: String::new(),
                is_role: type_desc.contains("ROLE"),
                locked: r.get::<bool, _>(2).unwrap_or(false),
                expired: false,
            })
        })
        .collect())
}

pub async fn user_detail(
    p: &DbConnectParams,
    user: &str,
    _host: &str,
) -> Result<crate::db::UserDetail, String> {
    use crate::db::{UserAttributes, UserDetail};
    let db = p
        .database
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "master".into());
    let mut client = connect(p, Some(&db)).await?;
    let esc = user.replace('\'', "''");

    // Login attributes (server scope, readable from any database context).
    let disabled = rows_of(
        &mut client,
        &format!("SELECT is_disabled FROM sys.server_principals WHERE name='{esc}'"),
    )
    .await
    .ok()
    .and_then(|rows| rows.first().and_then(|r| r.get::<bool, _>(0)))
    .unwrap_or(false);
    let attributes = UserAttributes {
        auth_plugin: String::new(),
        require_ssl: String::new(),
        max_queries_per_hour: 0,
        max_connections_per_hour: 0,
        max_updates_per_hour: 0,
        max_user_connections: 0,
        account_locked: disabled,
        password_expired: false,
        password_lifetime: None,
        is_superuser: false,
        can_create_db: false,
        can_create_role: false,
        can_login: !disabled,
        valid_until: None,
    };

    // Object-level GRANTs of the matching database user (state G = grant, W =
    // grant + grant option; DENY is a v1 gap — not folded into the matrix).
    let perm_sql = format!(
        "SELECT p.state, p.permission_name, s.name AS schema_name, o.name AS obj_name \
         FROM sys.database_permissions p \
         LEFT JOIN sys.objects o ON o.object_id = p.major_id \
         LEFT JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE p.grantee_principal_id = DATABASE_PRINCIPAL_ID('{esc}') \
           AND p.state IN ('G','W') AND p.class = 1 \
         ORDER BY s.name, o.name, p.permission_name"
    );
    let mut tbl: std::collections::HashMap<(String, String), (Vec<String>, bool)> =
        std::collections::HashMap::new();
    let mut order: Vec<(String, String)> = Vec::new();
    if let Ok(rows) = rows_of(&mut client, &perm_sql).await {
        for r in rows {
            let state = r.get::<&str, _>(0).unwrap_or("G");
            let perm = r.get::<&str, _>(1).unwrap_or("").to_string();
            let schema = r.get::<&str, _>(2).unwrap_or("dbo").to_string();
            let obj = r.get::<&str, _>(3).unwrap_or("").to_string();
            if obj.is_empty() || perm.is_empty() {
                continue;
            }
            let key = (schema, obj);
            let e = tbl.entry(key.clone()).or_insert_with(|| {
                order.push(key.clone());
                (Vec::new(), false)
            });
            e.0.push(perm);
            if state == "W" {
                e.1 = true;
            }
        }
    }
    let mut grants: Vec<String> = Vec::new();
    for key in order {
        let (privs, grantable) = tbl.remove(&key).unwrap();
        let mut s = format!(
            "GRANT {} ON [{}].[{}] TO [{}]",
            privs.join(", "),
            key.0.replace(']', "]]"),
            key.1.replace(']', "]]"),
            user.replace(']', "]]")
        );
        if grantable {
            s.push_str(" WITH GRANT OPTION");
        }
        grants.push(s);
    }

    // Database role memberships.
    let role_sql = format!(
        "SELECT r.name FROM sys.database_role_members m \
         JOIN sys.database_principals r ON r.principal_id = m.role_principal_id \
         JOIN sys.database_principals u ON u.principal_id = m.member_principal_id \
         WHERE u.name = '{esc}' ORDER BY r.name"
    );
    let roles = rows_of(&mut client, &role_sql)
        .await
        .map(|rows| {
            rows.into_iter()
                .filter_map(|r| r.get::<&str, _>(0).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    Ok(UserDetail {
        name: user.to_string(),
        host: String::new(),
        attributes,
        grants,
        roles,
    })
}

/// Run login/user/permission statements sequentially (they span master + db
/// scope, so a single transaction can't cover them). Stops on the first error.
pub async fn exec_user_sql(p: &DbConnectParams, statements: &[String]) -> Result<(), String> {
    let db = p
        .database
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "master".into());
    let mut client = connect(p, Some(&db)).await?;
    for (i, sql) in statements.iter().enumerate() {
        if let Err(e) = run_batch(&mut client, sql).await {
            return Err(format!("statement {} failed: {e}", i + 1));
        }
    }
    Ok(())
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

/// One T-SQL literal for a source cell. Numbers/bit render bare, binary as
/// `0x..` (faithful), strings/guid as `N'..'`. Date/time and other complex
/// types fall back to the browse rendering quoted as text — the same fidelity
/// limitation the mssql export path has (chrono isn't a direct dependency).
fn mssql_literal(cd: ColumnData<'_>) -> String {
    fn q(s: &str) -> String {
        format!("N'{}'", s.replace('\'', "''"))
    }
    match cd {
        ColumnData::U8(v) => v.map_or_else(|| "NULL".to_string(), |x| x.to_string()),
        ColumnData::I16(v) => v.map_or_else(|| "NULL".to_string(), |x| x.to_string()),
        ColumnData::I32(v) => v.map_or_else(|| "NULL".to_string(), |x| x.to_string()),
        ColumnData::I64(v) => v.map_or_else(|| "NULL".to_string(), |x| x.to_string()),
        ColumnData::F32(v) => v.map_or_else(|| "NULL".to_string(), |x| x.to_string()),
        ColumnData::F64(v) => v.map_or_else(|| "NULL".to_string(), |x| x.to_string()),
        ColumnData::Numeric(v) => v.map_or_else(|| "NULL".to_string(), |n| n.to_string()),
        ColumnData::Bit(v) => {
            v.map_or_else(|| "NULL".to_string(), |x| if x { "1".to_string() } else { "0".to_string() })
        }
        ColumnData::String(v) => v.map_or_else(|| "NULL".to_string(), |c| q(c.as_ref())),
        ColumnData::Guid(v) => v.map_or_else(|| "NULL".to_string(), |g| q(&g.to_string())),
        ColumnData::Binary(v) => v.map_or_else(|| "NULL".to_string(), |b| {
            use std::fmt::Write as _;
            let mut s = String::with_capacity(b.len() * 2 + 2);
            s.push_str("0x");
            for byte in b.iter() {
                let _ = write!(s, "{byte:02x}");
            }
            s
        }),
        other => cell_to_string(other).map_or_else(|| "NULL".to_string(), |s| q(&s)),
    }
}

/// Fused streaming Data Transfer for SQL Server → SQL Server. Rows stream from
/// the source via tiberius `into_row_stream()`; each is packed into batched
/// multi-row INSERTs on the target (≤1000 rows/VALUES, T-SQL's cap), inside a
/// transaction with periodic commits. Constraints are disabled during the load
/// and IDENTITY_INSERT is toggled for tables with an identity column so their
/// explicit key values carry over.
#[allow(clippy::too_many_arguments)]
pub async fn transfer_streaming(
    source: &DbConnectParams,
    source_db: &str,
    target: &DbConnectParams,
    target_db: &str,
    selection: &[TableSel],
    budget: InsertBudget,
    continue_on_error: bool,
    ctl: &Arc<JobCtl>,
    on_dump: &Channel<DumpProgress>,
    on_import: &Channel<ImportProgress>,
) -> Result<ImportResult, String> {
    use futures_util::TryStreamExt;
    const COMMIT_EVERY_BYTES: usize = 128 * 1024 * 1024;

    async fn run(c: &mut SqlClient, sql: &str) -> Result<(), String> {
        c.simple_query(sql)
            .await
            .map_err(|e| format!("{e}"))?
            .into_first_result()
            .await
            .map_err(|e| format!("{e}"))?;
        Ok(())
    }

    let plan = crate::engines::transfer_plan(source, source_db, selection).await?;
    let total_tables = plan.len();
    let mut sclient = connect(source, Some(source_db)).await?;
    let mut tclient = connect(target, Some(target_db)).await?;

    on_import.send(ImportProgress::Start { total_bytes: 0 }).ok();
    run(&mut tclient, "BEGIN TRAN").await.ok();

    let mut executed: u64 = 0;
    let mut failed = 0usize;
    let mut since_commit = 0usize;
    let mut last_report: u64 = 0;

    for (ti, (t, want_struct, want_data)) in plan.iter().enumerate() {
        if ctl.cancelled.load(Ordering::Relaxed) {
            run(&mut tclient, "ROLLBACK TRAN").await.ok();
            on_import.send(ImportProgress::Cancelled { executed: executed as usize, failed }).ok();
            return Ok(ImportResult { executed: executed as usize, failed, error: None });
        }
        on_dump
            .send(DumpProgress::Table { name: t.clone(), index: ti + 1, total: total_tables, rows: 0 })
            .ok();
        let qt = crate::db::q_ident("mssql", t);
        let schema = crate::engines::table_schema(source, source_db, t).await?;
        let has_identity = schema.columns.iter().any(|c| c.auto_increment);

        if *want_struct {
            let mut stmts = vec![format!(
                "IF OBJECT_ID(N'{}', N'U') IS NOT NULL DROP TABLE {qt}",
                t.replace('\'', "''")
            )];
            stmts.extend(crate::db::build_create_native("mssql", t, &schema));
            for stmt in stmts {
                if let Err(e) = run(&mut tclient, &stmt).await {
                    if continue_on_error {
                        failed += 1;
                        on_import.send(ImportProgress::StmtError { index: 0, error: format!("{t}: {e}") }).ok();
                    } else {
                        run(&mut tclient, "ROLLBACK TRAN").await.ok();
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

        // Ease the load: skip constraint checks, and allow explicit identity values.
        run(&mut tclient, &format!("ALTER TABLE {qt} NOCHECK CONSTRAINT ALL")).await.ok();
        if has_identity {
            run(&mut tclient, &format!("SET IDENTITY_INSERT {qt} ON")).await.ok();
        }

        let stream = sclient
            .simple_query(format!("SELECT * FROM {qt}"))
            .await
            .map_err(|e| format!("select failed for {t}: {e}"))?;
        let mut rows = stream.into_row_stream();
        let mut head: Option<String> = None;
        let mut buf = String::new();
        let mut rows_in = 0usize;
        let mut aborted: Option<String> = None;
        loop {
            while ctl.paused.load(Ordering::Relaxed) && !ctl.cancelled.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            if ctl.cancelled.load(Ordering::Relaxed) {
                break;
            }
            let row = match rows.try_next().await {
                Ok(Some(r)) => r,
                Ok(None) => break,
                Err(e) => {
                    aborted = Some(format!("read failed for {t}: {e}"));
                    break;
                }
            };
            if head.is_none() {
                let cols = row
                    .columns()
                    .iter()
                    .map(|c| crate::db::q_ident("mssql", c.name()))
                    .collect::<Vec<_>>()
                    .join(", ");
                head = Some(format!("INSERT INTO {qt} ({cols}) VALUES "));
            }
            let vals = row.into_iter().map(mssql_literal).collect::<Vec<_>>().join(", ");
            if rows_in > 0 {
                buf.push(',');
            }
            buf.push('(');
            buf.push_str(&vals);
            buf.push(')');
            rows_in += 1;
            if rows_in >= budget.rows || buf.len() >= budget.bytes {
                let bytes = buf.len();
                let sql = format!("{}{}", head.as_deref().unwrap_or(""), buf);
                match run(&mut tclient, &sql).await {
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
                    run(&mut tclient, "COMMIT TRAN").await.ok();
                    run(&mut tclient, "BEGIN TRAN").await.ok();
                    since_commit = 0;
                }
                if executed - last_report >= 2000 {
                    last_report = executed;
                    on_import
                        .send(ImportProgress::Progress { executed: executed as usize, failed, bytes: executed, total_bytes: executed })
                        .ok();
                }
            }
        }
        if aborted.is_none() && rows_in > 0 {
            let sql = format!("{}{}", head.as_deref().unwrap_or(""), buf);
            match run(&mut tclient, &sql).await {
                Ok(()) => executed += rows_in as u64,
                Err(e) => {
                    if continue_on_error {
                        failed += 1;
                        on_import.send(ImportProgress::StmtError { index: 0, error: format!("{t}: {e}") }).ok();
                    } else {
                        aborted = Some(format!("insert into {t} failed: {e}"));
                    }
                }
            }
        }
        drop(rows); // release the source borrow
        if has_identity {
            run(&mut tclient, &format!("SET IDENTITY_INSERT {qt} OFF")).await.ok();
        }
        run(&mut tclient, &format!("ALTER TABLE {qt} WITH CHECK CHECK CONSTRAINT ALL")).await.ok();
        if let Some(msg) = aborted {
            run(&mut tclient, "ROLLBACK TRAN").await.ok();
            on_import.send(ImportProgress::Failed { executed: executed as usize, error: msg.clone() }).ok();
            return Ok(ImportResult { executed: executed as usize, failed, error: Some(msg) });
        }
        on_import
            .send(ImportProgress::Progress { executed: executed as usize, failed, bytes: executed, total_bytes: executed })
            .ok();
    }

    run(&mut tclient, "COMMIT TRAN").await.map_err(|e| format!("commit failed: {e}"))?;
    on_import.send(ImportProgress::Done { executed: executed as usize, failed }).ok();
    Ok(ImportResult { executed: executed as usize, failed, error: None })
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
