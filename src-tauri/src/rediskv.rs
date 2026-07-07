//! Redis support (key-value — not SQL). Separate command set consumed by the
//! frontend RedisPanel. Non-TLS `redis://` connections (local / tunnelled) need
//! no crypto provider. Reuses the DB profile plumbing; `database` is the numeric
//! db index.

use crate::db::DbConnectParams;
use serde::Serialize;

async fn conn(p: &DbConnectParams) -> Result<redis::aio::MultiplexedConnection, String> {
    let pass = crate::db::resolve_password(p);
    let db = match p.database.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => s,
        _ => "0",
    };
    let url = if pass.is_empty() {
        format!("redis://{}:{}/{}", p.host, p.port, db)
    } else {
        format!("redis://:{}@{}:{}/{}", pass, p.host, p.port, db)
    };
    let client = redis::Client::open(url).map_err(|e| format!("connect failed: {e}"))?;
    client
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| format!("connect failed: {e}"))
}

#[derive(Serialize)]
pub struct RedisKey {
    pub name: String,
    pub kind: String,
    pub ttl: i64,
}

#[derive(Serialize)]
pub struct RedisScan {
    pub cursor: u64,
    pub keys: Vec<RedisKey>,
}

/// Incremental SCAN with a MATCH pattern; each key carries its type + TTL.
#[tauri::command]
pub async fn redis_scan(
    params: DbConnectParams,
    pattern: String,
    cursor: u64,
    count: Option<u64>,
) -> Result<RedisScan, String> {
    let mut c = conn(&params).await?;
    let pat = if pattern.trim().is_empty() {
        "*".to_string()
    } else {
        pattern
    };
    let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
        .arg(cursor)
        .arg("MATCH")
        .arg(&pat)
        .arg("COUNT")
        .arg(count.unwrap_or(200))
        .query_async(&mut c)
        .await
        .map_err(|e| format!("scan failed: {e}"))?;
    let mut out = Vec::with_capacity(keys.len());
    for k in keys {
        let kind: String = redis::cmd("TYPE")
            .arg(&k)
            .query_async(&mut c)
            .await
            .unwrap_or_else(|_| "unknown".into());
        let ttl: i64 = redis::cmd("TTL").arg(&k).query_async(&mut c).await.unwrap_or(-1);
        out.push(RedisKey {
            name: k,
            kind,
            ttl,
        });
    }
    Ok(RedisScan { cursor: next, keys: out })
}

#[derive(Serialize)]
pub struct RedisValue {
    pub kind: String,
    /// String value, or a JSON representation for list/set/hash/zset.
    pub value: String,
}

/// Fetch a key's value, decoded per its type.
#[tauri::command]
pub async fn redis_get(params: DbConnectParams, key: String) -> Result<RedisValue, String> {
    let mut c = conn(&params).await?;
    let kind: String = redis::cmd("TYPE")
        .arg(&key)
        .query_async(&mut c)
        .await
        .map_err(|e| format!("type failed: {e}"))?;
    let value = match kind.as_str() {
        "string" => redis::cmd("GET")
            .arg(&key)
            .query_async::<Option<String>>(&mut c)
            .await
            .map_err(|e| format!("get failed: {e}"))?
            .unwrap_or_default(),
        "list" => {
            let v: Vec<String> = redis::cmd("LRANGE")
                .arg(&key)
                .arg(0)
                .arg(-1)
                .query_async(&mut c)
                .await
                .map_err(|e| format!("lrange failed: {e}"))?;
            serde_json::to_string_pretty(&v).unwrap_or_default()
        }
        "set" => {
            let v: Vec<String> = redis::cmd("SMEMBERS")
                .arg(&key)
                .query_async(&mut c)
                .await
                .map_err(|e| format!("smembers failed: {e}"))?;
            serde_json::to_string_pretty(&v).unwrap_or_default()
        }
        "hash" => {
            let v: std::collections::BTreeMap<String, String> = redis::cmd("HGETALL")
                .arg(&key)
                .query_async(&mut c)
                .await
                .map_err(|e| format!("hgetall failed: {e}"))?;
            serde_json::to_string_pretty(&v).unwrap_or_default()
        }
        "zset" => {
            let v: Vec<(String, f64)> = redis::cmd("ZRANGE")
                .arg(&key)
                .arg(0)
                .arg(-1)
                .arg("WITHSCORES")
                .query_async(&mut c)
                .await
                .map_err(|e| format!("zrange failed: {e}"))?;
            serde_json::to_string_pretty(&v).unwrap_or_default()
        }
        other => format!("(unsupported type: {other})"),
    };
    Ok(RedisValue { kind, value })
}

fn format_value(v: &redis::Value) -> String {
    match v {
        redis::Value::Nil => "(nil)".into(),
        redis::Value::Int(i) => i.to_string(),
        redis::Value::BulkString(b) => String::from_utf8_lossy(b).into_owned(),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::Okay => "OK".into(),
        redis::Value::Array(a) | redis::Value::Set(a) => {
            a.iter().map(format_value).collect::<Vec<_>>().join("\n")
        }
        other => format!("{other:?}"),
    }
}

/// Run an arbitrary Redis command (the console).
#[tauri::command]
pub async fn redis_command(
    params: DbConnectParams,
    argv: Vec<String>,
) -> Result<String, String> {
    if argv.is_empty() {
        return Err("empty command".into());
    }
    let mut c = conn(&params).await?;
    let mut cmd = redis::cmd(&argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    let val: redis::Value = cmd
        .query_async(&mut c)
        .await
        .map_err(|e| format!("command failed: {e}"))?;
    Ok(format_value(&val))
}

/// Set a string key's value.
#[tauri::command]
pub async fn redis_set(params: DbConnectParams, key: String, value: String) -> Result<(), String> {
    let mut c = conn(&params).await?;
    redis::cmd("SET")
        .arg(&key)
        .arg(&value)
        .query_async::<()>(&mut c)
        .await
        .map_err(|e| format!("set failed: {e}"))
}

/// Delete a key; returns how many were removed.
#[tauri::command]
pub async fn redis_del(params: DbConnectParams, key: String) -> Result<i64, String> {
    let mut c = conn(&params).await?;
    redis::cmd("DEL")
        .arg(&key)
        .query_async(&mut c)
        .await
        .map_err(|e| format!("del failed: {e}"))
}

/// Set (seconds >= 0) or clear (negative) a key's TTL.
#[tauri::command]
pub async fn redis_expire(params: DbConnectParams, key: String, seconds: i64) -> Result<(), String> {
    let mut c = conn(&params).await?;
    let cmd = if seconds < 0 {
        redis::cmd("PERSIST").arg(&key).clone()
    } else {
        redis::cmd("EXPIRE").arg(&key).arg(seconds).clone()
    };
    cmd.query_async::<i64>(&mut c)
        .await
        .map(|_| ())
        .map_err(|e| format!("expire failed: {e}"))
}

#[tauri::command]
pub async fn redis_info(params: DbConnectParams) -> Result<String, String> {
    let mut c = conn(&params).await?;
    redis::cmd("INFO")
        .query_async(&mut c)
        .await
        .map_err(|e| format!("info failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> DbConnectParams {
        DbConnectParams {
            engine: "redis".into(),
            host: "127.0.0.1".into(),
            port: 56379,
            user: String::new(),
            password: None,
            database: Some("0".into()),
            file: None,
            profile_id: None,
            region: None,
            path_style: None,
            tls: None,
        }
    }

    // cargo test --lib redis -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn redis_smoke() {
        redis_command(params(), vec!["FLUSHDB".into()]).await.ok();
        redis_command(params(), vec!["SET".into(), "greeting".into(), "hello".into()])
            .await
            .expect("set");
        redis_command(
            params(),
            vec!["RPUSH".into(), "colors".into(), "red".into(), "green".into()],
        )
        .await
        .expect("rpush");

        let scan = redis_scan(params(), "*".into(), 0, Some(100)).await.expect("scan");
        println!("KEYS: {:?}", scan.keys.iter().map(|k| (&k.name, &k.kind)).collect::<Vec<_>>());
        assert!(scan.keys.iter().any(|k| k.name == "greeting" && k.kind == "string"));
        assert!(scan.keys.iter().any(|k| k.name == "colors" && k.kind == "list"));

        let v = redis_get(params(), "greeting".into()).await.expect("get");
        println!("greeting => {} ({})", v.value, v.kind);
        assert_eq!(v.value, "hello");

        let lv = redis_get(params(), "colors".into()).await.expect("get list");
        println!("colors => {}", lv.value);
        assert!(lv.value.contains("red"));

        // Set + delete a key.
        redis_set(params(), "temp".into(), "42".into()).await.expect("set");
        let tv = redis_get(params(), "temp".into()).await.expect("get temp");
        assert_eq!(tv.value, "42");
        let d = redis_del(params(), "temp".into()).await.expect("del");
        assert_eq!(d, 1);
    }
}
