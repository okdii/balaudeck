//! S3-compatible object storage (AWS S3, MinIO, RustFS, …). Separate command
//! set consumed by the frontend S3Panel. Reuses the DB profile plumbing:
//! access key = `user`, secret key = the profile's keychain password slot,
//! endpoint = `{http|https}://host:port` (path-style by default so MinIO/
//! RustFS/IP endpoints work without wildcard DNS).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::time::Duration;

use aws_sdk_s3::config::timeout::TimeoutConfig;
use aws_sdk_s3::config::{
    BehaviorVersion, Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation,
};
use aws_sdk_s3::error::DisplayErrorContext;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{
    BucketLocationConstraint, CreateBucketConfiguration, Delete, ObjectIdentifier,
};
use aws_sdk_s3::Client;
use once_cell::sync::Lazy;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use crate::db::DbConnectParams;

/// In-panel preview cap: text is truncated here, larger images are refused.
const PREVIEW_CAP: i64 = 512 * 1024;

/// PDF preview cap: PDFs render client-side with pdf.js, so allow more than
/// the text/image cap before refusing as too-large.
const PDF_PREVIEW_CAP: i64 = 8 * 1024 * 1024;

/// Cache of built S3 clients, keyed by endpoint + credentials, so repeated
/// commands on the same profile reuse the client's connection pool instead of
/// re-resolving config each time (same idea as db.rs POOLS).
static CLIENTS: Lazy<Mutex<HashMap<String, Client>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn region_of(p: &DbConnectParams) -> String {
    match p.region.as_deref().map(str::trim) {
        Some(r) if !r.is_empty() => r.to_string(),
        _ => "us-east-1".to_string(),
    }
}

fn client(p: &DbConnectParams) -> Client {
    let secret = crate::db::resolve_password(p);
    let region = region_of(p);
    let path_style = p.path_style.unwrap_or(true);
    let scheme = if p.tls.unwrap_or(false) { "https" } else { "http" };
    let endpoint = format!("{scheme}://{}:{}", p.host, p.port);
    // Never put the secret itself in the cache key; a std hash is enough to
    // tell credential changes apart.
    let mut hasher = DefaultHasher::new();
    secret.hash(&mut hasher);
    let key = format!("{endpoint}|{region}|{path_style}|{}|{:x}", p.user, hasher.finish());
    let mut map = CLIENTS.lock().unwrap();
    if let Some(c) = map.get(&key) {
        return c.clone();
    }
    let conf = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(region))
        .endpoint_url(endpoint)
        .credentials_provider(Credentials::new(p.user.clone(), secret, None, None, "balaudeck"))
        .force_path_style(path_style)
        // The 2025 SDK default of always sending/validating CRC checksums
        // breaks MinIO/RustFS; only do so where the S3 API requires it.
        .request_checksum_calculation(RequestChecksumCalculation::WhenRequired)
        .response_checksum_validation(ResponseChecksumValidation::WhenRequired)
        .timeout_config(TimeoutConfig::builder().connect_timeout(Duration::from_secs(10)).build())
        .build();
    let c = Client::from_conf(conf);
    map.insert(key, c.clone());
    c
}

#[derive(Serialize)]
pub struct S3Bucket {
    pub name: String,
    /// Creation time as epoch millis, when the server reports one.
    pub created: Option<i64>,
}

#[derive(Serialize)]
pub struct S3Entry {
    /// Full object key (folders carry their common prefix, ending in "/").
    pub key: String,
    /// Display name: the last path segment.
    pub name: String,
    pub is_dir: bool,
    pub size: i64,
    /// Last-modified as epoch millis (None for folders).
    pub modified: Option<i64>,
}

#[derive(Serialize)]
pub struct S3Listing {
    pub entries: Vec<S3Entry>,
    /// Continuation token when the listing has more pages ("Load more…").
    pub next_token: Option<String>,
}

#[derive(Serialize)]
pub struct S3Preview {
    /// "text" | "image" | "pdf" | "binary" | "too-large".
    pub kind: String,
    /// Text content, or base64 image/PDF data; empty for binary/too-large.
    pub content: String,
    pub content_type: String,
    pub size: i64,
    /// True when text content was cut at the preview cap.
    pub truncated: bool,
}

/// List all buckets visible to the credentials.
#[tauri::command]
pub async fn s3_list_buckets(params: DbConnectParams) -> Result<Vec<S3Bucket>, String> {
    let c = client(&params);
    let out = c
        .list_buckets()
        .send()
        .await
        .map_err(|e| format!("list buckets failed: {}", DisplayErrorContext(&e)))?;
    let mut buckets: Vec<S3Bucket> = out
        .buckets()
        .iter()
        .map(|b| S3Bucket {
            name: b.name().unwrap_or_default().to_string(),
            created: b.creation_date().and_then(|d| d.to_millis().ok()),
        })
        .collect();
    buckets.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(buckets)
}

/// Create a bucket. Regions other than us-east-1 must be sent as an explicit
/// LocationConstraint or S3 rejects the request.
#[tauri::command]
pub async fn s3_create_bucket(params: DbConnectParams, bucket: String) -> Result<(), String> {
    let c = client(&params);
    let region = region_of(&params);
    let mut req = c.create_bucket().bucket(&bucket);
    if region != "us-east-1" {
        req = req.create_bucket_configuration(
            CreateBucketConfiguration::builder()
                .location_constraint(BucketLocationConstraint::from(region.as_str()))
                .build(),
        );
    }
    req.send()
        .await
        .map(|_| ())
        .map_err(|e| format!("create bucket failed: {}", DisplayErrorContext(&e)))
}

/// Delete an (empty) bucket. A BucketNotEmpty error surfaces to the UI, which
/// then offers the empty-and-delete flow via `s3_delete_prefix`.
#[tauri::command]
pub async fn s3_delete_bucket(params: DbConnectParams, bucket: String) -> Result<(), String> {
    let c = client(&params);
    c.delete_bucket()
        .bucket(&bucket)
        .send()
        .await
        .map(|_| ())
        .map_err(|e| format!("delete bucket failed: {}", DisplayErrorContext(&e)))
}

/// One page of a delimiter="/" listing under `prefix`: CommonPrefixes become
/// folders, Contents become files (skipping the zero-byte folder marker whose
/// key equals the prefix itself). Directories sort first.
#[tauri::command]
pub async fn s3_list_objects(
    params: DbConnectParams,
    bucket: String,
    prefix: String,
    token: Option<String>,
) -> Result<S3Listing, String> {
    let c = client(&params);
    let out = c
        .list_objects_v2()
        .bucket(&bucket)
        .prefix(&prefix)
        .delimiter("/")
        .set_continuation_token(token)
        .send()
        .await
        .map_err(|e| format!("list objects failed: {}", DisplayErrorContext(&e)))?;
    let mut entries: Vec<S3Entry> = Vec::new();
    for cp in out.common_prefixes() {
        if let Some(p) = cp.prefix() {
            let name = p.trim_end_matches('/').rsplit('/').next().unwrap_or(p);
            entries.push(S3Entry {
                key: p.to_string(),
                name: name.to_string(),
                is_dir: true,
                size: 0,
                modified: None,
            });
        }
    }
    for obj in out.contents() {
        let k = match obj.key() {
            Some(k) if k != prefix => k,
            _ => continue,
        };
        entries.push(S3Entry {
            key: k.to_string(),
            name: k.rsplit('/').next().unwrap_or(k).to_string(),
            is_dir: false,
            size: obj.size().unwrap_or(0),
            modified: obj.last_modified().and_then(|d| d.to_millis().ok()),
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(S3Listing {
        entries,
        next_token: out.next_continuation_token().map(String::from),
    })
}

/// Upload a local file, streamed from disk (single PUT — objects over the
/// 5 GB single-request cap need multipart, which is post-v1).
#[tauri::command]
pub async fn s3_upload(
    params: DbConnectParams,
    bucket: String,
    key: String,
    local_path: String,
) -> Result<(), String> {
    let c = client(&params);
    let body = ByteStream::from_path(&local_path)
        .await
        .map_err(|e| format!("open {local_path} failed: {e}"))?;
    c.put_object()
        .bucket(&bucket)
        .key(&key)
        .body(body)
        .send()
        .await
        .map(|_| ())
        .map_err(|e| format!("upload failed: {}", DisplayErrorContext(&e)))
}

/// Download an object to a local file, streamed chunk by chunk.
#[tauri::command]
pub async fn s3_download(
    params: DbConnectParams,
    bucket: String,
    key: String,
    local_path: String,
) -> Result<(), String> {
    let c = client(&params);
    let mut out = c
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("download failed: {}", DisplayErrorContext(&e)))?;
    let mut file = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| format!("create {local_path} failed: {e}"))?;
    while let Some(chunk) = out
        .body
        .try_next()
        .await
        .map_err(|e| format!("download read failed: {e}"))?
    {
        file.write_all(&chunk).await.map_err(|e| format!("write failed: {e}"))?;
    }
    file.flush().await.map_err(|e| format!("write failed: {e}"))
}

/// Delete a single object.
#[tauri::command]
pub async fn s3_delete_object(
    params: DbConnectParams,
    bucket: String,
    key: String,
) -> Result<(), String> {
    let c = client(&params);
    c.delete_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map(|_| ())
        .map_err(|e| format!("delete failed: {}", DisplayErrorContext(&e)))
}

/// Recursively delete everything under `prefix` (paginated flat listing +
/// DeleteObjects batches of ≤1000 keys); prefix "" empties the whole bucket.
/// Returns how many objects were removed.
#[tauri::command]
pub async fn s3_delete_prefix(
    params: DbConnectParams,
    bucket: String,
    prefix: String,
) -> Result<u64, String> {
    let c = client(&params);
    let mut deleted: u64 = 0;
    let mut token: Option<String> = None;
    loop {
        let out = c
            .list_objects_v2()
            .bucket(&bucket)
            .prefix(&prefix)
            .set_continuation_token(token.take())
            .send()
            .await
            .map_err(|e| format!("list objects failed: {}", DisplayErrorContext(&e)))?;
        let mut ids: Vec<ObjectIdentifier> = Vec::new();
        for obj in out.contents() {
            if let Some(k) = obj.key() {
                ids.push(
                    ObjectIdentifier::builder()
                        .key(k)
                        .build()
                        .map_err(|e| format!("delete failed: {e}"))?,
                );
            }
        }
        for chunk in ids.chunks(1000) {
            let del = Delete::builder()
                .set_objects(Some(chunk.to_vec()))
                .build()
                .map_err(|e| format!("delete failed: {e}"))?;
            let res = c
                .delete_objects()
                .bucket(&bucket)
                .delete(del)
                .send()
                .await
                .map_err(|e| format!("delete failed: {}", DisplayErrorContext(&e)))?;
            if let Some(err) = res.errors().first() {
                return Err(format!(
                    "delete failed: {} {}",
                    err.code().unwrap_or("error"),
                    err.message().unwrap_or_default()
                ));
            }
            deleted += chunk.len() as u64;
        }
        token = out.next_continuation_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    Ok(deleted)
}

/// Create a "folder": a zero-byte object whose key ends in "/" (the same
/// convention the MinIO console uses; it shows up as a CommonPrefix).
#[tauri::command]
pub async fn s3_create_folder(
    params: DbConnectParams,
    bucket: String,
    prefix: String,
) -> Result<(), String> {
    let c = client(&params);
    let key = format!("{}/", prefix.trim_end_matches('/'));
    c.put_object()
        .bucket(&bucket)
        .key(&key)
        .body(ByteStream::from_static(b""))
        .send()
        .await
        .map(|_| ())
        .map_err(|e| format!("create folder failed: {}", DisplayErrorContext(&e)))
}

/// Small in-panel preview. Heads the object first, then: PDF (by content type
/// or a ".pdf" key) ≤ its cap → full GET as base64 for pdf.js; image ≤ cap →
/// full GET as base64; text-ish (by content type, or a UTF-8 sniff of the
/// first bytes) → ranged GET of at most the cap; anything else →
/// binary/too-large, content stays empty and the UI offers Download instead.
#[tauri::command]
pub async fn s3_preview(
    params: DbConnectParams,
    bucket: String,
    key: String,
) -> Result<S3Preview, String> {
    let c = client(&params);
    let head = c
        .head_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("preview failed: {}", DisplayErrorContext(&e)))?;
    let size = head.content_length().unwrap_or(0);
    let content_type = head.content_type().unwrap_or_default().to_string();

    // Many servers store PDFs as application/octet-stream, so also go by the
    // key's extension. Rendering happens client-side in pdf.js, hence the
    // larger cap and the normalized content type the frontend relies on.
    if content_type == "application/pdf" || key.to_ascii_lowercase().ends_with(".pdf") {
        if size > PDF_PREVIEW_CAP {
            return Ok(S3Preview {
                kind: "too-large".into(),
                content: String::new(),
                content_type,
                size,
                truncated: false,
            });
        }
        let out = c
            .get_object()
            .bucket(&bucket)
            .key(&key)
            .send()
            .await
            .map_err(|e| format!("preview failed: {}", DisplayErrorContext(&e)))?;
        let bytes = out
            .body
            .collect()
            .await
            .map_err(|e| format!("preview read failed: {e}"))?
            .into_bytes();
        use base64::Engine;
        return Ok(S3Preview {
            kind: "pdf".into(),
            content: base64::engine::general_purpose::STANDARD.encode(&bytes),
            content_type: "application/pdf".into(),
            size,
            truncated: false,
        });
    }

    if content_type.starts_with("image/") {
        if size > PREVIEW_CAP {
            return Ok(S3Preview {
                kind: "too-large".into(),
                content: String::new(),
                content_type,
                size,
                truncated: false,
            });
        }
        let out = c
            .get_object()
            .bucket(&bucket)
            .key(&key)
            .send()
            .await
            .map_err(|e| format!("preview failed: {}", DisplayErrorContext(&e)))?;
        let bytes = out
            .body
            .collect()
            .await
            .map_err(|e| format!("preview read failed: {e}"))?
            .into_bytes();
        use base64::Engine;
        return Ok(S3Preview {
            kind: "image".into(),
            content: base64::engine::general_purpose::STANDARD.encode(&bytes),
            content_type,
            size,
            truncated: false,
        });
    }

    // Empty objects: nothing to fetch (a ranged GET of zero bytes is an error).
    if size == 0 {
        return Ok(S3Preview {
            kind: "text".into(),
            content: String::new(),
            content_type,
            size,
            truncated: false,
        });
    }

    let out = c
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .range(format!("bytes=0-{}", PREVIEW_CAP - 1))
        .send()
        .await
        .map_err(|e| format!("preview failed: {}", DisplayErrorContext(&e)))?;
    let bytes = out
        .body
        .collect()
        .await
        .map_err(|e| format!("preview read failed: {e}"))?
        .into_bytes();
    let ct = content_type.to_ascii_lowercase();
    let texty = ct.starts_with("text/")
        || ["json", "xml", "yaml", "javascript", "x-sh"].iter().any(|t| ct.contains(t));
    if texty || (!bytes.contains(&0) && std::str::from_utf8(&bytes).is_ok()) {
        return Ok(S3Preview {
            kind: "text".into(),
            content: String::from_utf8_lossy(&bytes).into_owned(),
            content_type,
            size,
            truncated: size > PREVIEW_CAP,
        });
    }
    Ok(S3Preview {
        kind: "binary".into(),
        content: String::new(),
        content_type,
        size,
        truncated: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> DbConnectParams {
        DbConnectParams {
            engine: "s3".into(),
            host: "127.0.0.1".into(),
            port: 9000,
            user: "minioadmin".into(),
            password: Some("minioadmin".into()),
            database: None,
            file: None,
            profile_id: None,
            region: None,
            path_style: None,
            tls: None,
        }
    }

    // cargo test --lib s3 -- --ignored --nocapture
    // Needs a local MinIO: docker run -d -p 9000:9000 \
    //   -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
    //   minio/minio server /data
    #[tokio::test]
    #[ignore]
    async fn s3_smoke() {
        let bucket = "balaudeck-smoke";
        // Clean slate from any previous run.
        s3_delete_prefix(params(), bucket.into(), String::new()).await.ok();
        s3_delete_bucket(params(), bucket.into()).await.ok();

        s3_create_bucket(params(), bucket.into()).await.expect("create bucket");
        let buckets = s3_list_buckets(params()).await.expect("list buckets");
        assert!(buckets.iter().any(|b| b.name == bucket));

        // Upload a small text file, list it, preview it, download it back.
        let dir = std::env::temp_dir();
        let up = dir.join("balaudeck-s3-up.txt");
        std::fs::write(&up, "hello object storage").expect("write tmp");
        s3_upload(params(), bucket.into(), "docs/hello.txt".into(), up.to_string_lossy().into())
            .await
            .expect("upload");
        s3_create_folder(params(), bucket.into(), "empty".into()).await.expect("create folder");

        let root = s3_list_objects(params(), bucket.into(), String::new(), None)
            .await
            .expect("list root");
        println!(
            "ROOT: {:?}",
            root.entries.iter().map(|e| (&e.key, e.is_dir)).collect::<Vec<_>>()
        );
        assert!(root.entries.iter().any(|e| e.key == "docs/" && e.is_dir));
        assert!(root.entries.iter().any(|e| e.key == "empty/" && e.is_dir));

        let docs = s3_list_objects(params(), bucket.into(), "docs/".into(), None)
            .await
            .expect("list docs");
        assert!(docs.entries.iter().any(|e| e.key == "docs/hello.txt" && !e.is_dir));

        let pv = s3_preview(params(), bucket.into(), "docs/hello.txt".into())
            .await
            .expect("preview");
        println!("PREVIEW: {} => {}", pv.kind, pv.content);
        assert_eq!(pv.kind, "text");
        assert!(pv.content.contains("hello object storage"));

        let down = dir.join("balaudeck-s3-down.txt");
        s3_download(params(), bucket.into(), "docs/hello.txt".into(), down.to_string_lossy().into())
            .await
            .expect("download");
        assert_eq!(std::fs::read_to_string(&down).expect("read back"), "hello object storage");

        // Recursive delete reports the count, then the emptied bucket goes away.
        let n = s3_delete_prefix(params(), bucket.into(), String::new())
            .await
            .expect("delete prefix");
        println!("DELETED: {n}");
        assert_eq!(n, 2); // docs/hello.txt + the empty/ folder marker
        s3_delete_bucket(params(), bucket.into()).await.expect("delete bucket");
    }
}
