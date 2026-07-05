//! MongoDB support (document store — not SQL). Separate command set consumed by
//! the frontend MongoPanel. Reuses the DB profile plumbing + the transparent SSH
//! tunnel (the frontend redirects to 127.0.0.1:<local_port>). Connects per call.

use crate::db::DbConnectParams;
use futures_util::stream::StreamExt;
use mongodb::bson::{doc, Document};
use mongodb::options::{ClientOptions, Credential, ServerAddress};
use mongodb::Client;

async fn client(p: &DbConnectParams) -> Result<Client, String> {
    let secret = crate::db::resolve_password(p);
    // The secret may be a full connection URI or just a password.
    if secret.starts_with("mongodb://") || secret.starts_with("mongodb+srv://") {
        let opts = ClientOptions::parse(&secret)
            .await
            .map_err(|e| format!("connect failed: {e}"))?;
        return Client::with_options(opts).map_err(|e| format!("connect failed: {e}"));
    }
    let mut opts = ClientOptions::default();
    opts.hosts = vec![ServerAddress::Tcp {
        host: p.host.clone(),
        port: Some(p.port),
    }];
    if !p.user.is_empty() {
        let source = p
            .database
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "admin".into());
        opts.credential = Some(
            Credential::builder()
                .username(Some(p.user.clone()))
                .password(Some(secret))
                .source(Some(source))
                .build(),
        );
    }
    opts.connect_timeout = Some(std::time::Duration::from_secs(15));
    opts.server_selection_timeout = Some(std::time::Duration::from_secs(15));
    Client::with_options(opts).map_err(|e| format!("connect failed: {e}"))
}

fn parse_filter(filter: &str) -> Result<Document, String> {
    if filter.trim().is_empty() {
        return Ok(doc! {});
    }
    serde_json::from_str::<Document>(filter).map_err(|e| format!("bad filter JSON: {e}"))
}

#[tauri::command]
pub async fn mongo_databases(params: DbConnectParams) -> Result<Vec<String>, String> {
    let c = client(&params).await?;
    c.list_database_names()
        .await
        .map_err(|e| format!("list databases failed: {e}"))
}

#[tauri::command]
pub async fn mongo_collections(
    params: DbConnectParams,
    database: String,
) -> Result<Vec<String>, String> {
    let c = client(&params).await?;
    c.database(&database)
        .list_collection_names()
        .await
        .map_err(|e| format!("list collections failed: {e}"))
}

/// Run a find and return documents as pretty JSON strings.
#[tauri::command]
pub async fn mongo_find(
    params: DbConnectParams,
    database: String,
    collection: String,
    filter: String,
    limit: Option<i64>,
) -> Result<Vec<String>, String> {
    let c = client(&params).await?;
    let coll = c.database(&database).collection::<Document>(&collection);
    let mut cursor = coll
        .find(parse_filter(&filter)?)
        .limit(limit.unwrap_or(200))
        .await
        .map_err(|e| format!("find failed: {e}"))?;
    let mut out = Vec::new();
    while let Some(r) = cursor.next().await {
        let d = r.map_err(|e| format!("fetch failed: {e}"))?;
        out.push(serde_json::to_string_pretty(&d).unwrap_or_default());
    }
    Ok(out)
}

#[tauri::command]
pub async fn mongo_count(
    params: DbConnectParams,
    database: String,
    collection: String,
    filter: String,
) -> Result<u64, String> {
    let c = client(&params).await?;
    c.database(&database)
        .collection::<Document>(&collection)
        .count_documents(parse_filter(&filter)?)
        .await
        .map_err(|e| format!("count failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(db: Option<&str>) -> DbConnectParams {
        DbConnectParams {
            engine: "mongodb".into(),
            host: "127.0.0.1".into(),
            port: 57017,
            user: String::new(),
            password: None,
            database: db.map(|s| s.to_string()),
            file: None,
            profile_id: None,
        }
    }

    // cargo test --lib mongo -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn mongo_smoke() {
        let p = params(None);
        let dbs = mongo_databases(p).await.expect("databases");
        println!("DATABASES: {dbs:?}");
        assert!(dbs.iter().any(|d| d == "demo"));

        let cols = mongo_collections(params(None), "demo".into())
            .await
            .expect("collections");
        println!("COLLECTIONS: {cols:?}");
        assert!(cols.iter().any(|c| c == "widgets"));

        let docs = mongo_find(params(None), "demo".into(), "widgets".into(), String::new(), Some(50))
            .await
            .expect("find");
        println!("DOC COUNT: {}", docs.len());
        for d in &docs {
            println!("DOC: {d}");
        }
        assert_eq!(docs.len(), 3);
    }
}
