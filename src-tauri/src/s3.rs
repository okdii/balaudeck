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
    BucketLocationConstraint, CompletedMultipartUpload, CompletedPart, CreateBucketConfiguration,
    Delete, MetadataDirective, ObjectIdentifier, Tag, Tagging,
};
use aws_sdk_s3::Client;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::db::DbConnectParams;
use crate::transfers;

/// In-panel preview cap: text is truncated here, larger images are refused.
/// Shared with the SFTP preview so both browsers behave identically.
pub(crate) const PREVIEW_CAP: i64 = 512 * 1024;

/// PDF preview cap: PDFs render client-side with pdf.js, so allow more than
/// the text/image cap before refusing as too-large.
pub(crate) const PDF_PREVIEW_CAP: i64 = 8 * 1024 * 1024;

/// Uploads above this size switch from a single PUT to multipart, which lifts
/// the 5 GB single-request cap and gives per-part progress + cancel points.
const MULTIPART_THRESHOLD: u64 = 16 * 1024 * 1024;

/// Default multipart part size (S3 requires ≥ 5 MiB for every part but the
/// last). Grown per-upload for very large files so the part count stays within
/// S3's 10,000-part limit — see `upload_file`.
const PART_SIZE: usize = 8 * 1024 * 1024;

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

pub(crate) fn client(p: &DbConnectParams) -> Client {
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
    // Tunnel sessions mint a new local endpoint each launch; coarse-reset so
    // dead pools (and their credential copies) can't accumulate forever.
    if map.len() >= 16 {
        map.clear();
    }
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
    /// Text content, or a `blob:<id>` reference to image/PDF bytes (fetched
    /// with `preview_blob_take`); empty for binary/too-large.
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

/// Upload a local file, streamed from disk: a single PUT for small files,
/// multipart above the threshold (no more 5 GB single-request cap). With a
/// `job_id`, streams `transfer://progress` events and honors transfer_cancel.
#[tauri::command]
pub async fn s3_upload(
    app: AppHandle,
    params: DbConnectParams,
    bucket: String,
    key: String,
    local_path: String,
    job_id: Option<String>,
) -> Result<(), String> {
    let name = key.rsplit('/').next().unwrap_or(&key).to_string();
    upload_file(&app, &params, &bucket, &key, &local_path, job_id.as_deref(), &name).await
}

/// Shared upload body — also reused by the DB-dump-to-S3 flow, hence the plain
/// connect params plus an optional job id and a display name for the events.
/// Cancel aborts the multipart upload server-side and is not an error.
pub(crate) async fn upload_file(
    app: &AppHandle,
    params: &DbConnectParams,
    bucket: &str,
    key: &str,
    local_path: &str,
    job_id: Option<&str>,
    name: &str,
) -> Result<(), String> {
    let c = client(params);
    let mut prog = transfers::Progress::new(app, job_id, name);
    // Ok(true) = uploaded, Ok(false) = cancelled mid-transfer.
    let res: Result<bool, String> = async {
        let size = tokio::fs::metadata(local_path)
            .await
            .map_err(|e| format!("open {local_path} failed: {e}"))?
            .len();
        prog.total = Some(size);
        prog.start();
        // Store a real Content-Type (preview classifies images by it), else
        // everything lands as application/octet-stream.
        let content_type = mime_guess::from_path(local_path).first_or_octet_stream().to_string();
        let mut file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| format!("open {local_path} failed: {e}"))?;
        put_reader(&c, bucket, key, &mut file, size, &content_type, &mut prog).await
    }
    .await;
    prog.finish(res)
}

/// Upload whatever `reader` yields as `key` — a local file, or an SFTP file
/// streamed straight through (bridge.rs). `size` picks single PUT vs multipart.
/// Progress and cancel go through `prog` (its job is NOT finished here, so a
/// folder copy can run many of these under one job). Ok(false) = cancelled;
/// every failure or cancel aborts a multipart upload server-side.
pub(crate) async fn put_reader<R: tokio::io::AsyncRead + Unpin>(
    c: &Client,
    bucket: &str,
    key: &str,
    reader: &mut R,
    size: u64,
    content_type: &str,
    prog: &mut transfers::Progress<'_>,
) -> Result<bool, String> {
    if size <= MULTIPART_THRESHOLD {
        // Small object: one PUT, no mid-request progress to report.
        if prog.cancelled() {
            return Ok(false);
        }
        let mut buf = Vec::with_capacity(size as usize);
        reader.read_to_end(&mut buf).await.map_err(|e| format!("read failed: {e}"))?;
        let n = buf.len() as u64;
        c.put_object()
            .bucket(bucket)
            .key(key)
            .content_type(content_type)
            .body(ByteStream::from(buf))
            .send()
            .await
            .map_err(|e| format!("upload failed: {}", DisplayErrorContext(&e)))?;
        prog.add(n);
        return Ok(true);
    }

    // Multipart: stream in fixed-size parts, reporting progress and checking
    // for cancel between parts. S3 allows at most 10,000 parts, so a fixed
    // 8 MiB part caps uploads at ~80 GB; grow the part size for very large
    // objects (an 800 GB file → ~80 MiB parts, ~5 TiB ceiling overall).
    const MAX_PARTS: u64 = 10_000;
    const MIB: u64 = 1024 * 1024;
    // ceil(size / 10000) rounded up to a whole MiB, floored at the 8 MiB default.
    let part_size: usize =
        (size.div_ceil(MAX_PARTS).div_ceil(MIB) * MIB).max(PART_SIZE as u64) as usize;
    let upload_id = c
        .create_multipart_upload()
        .bucket(bucket)
        .key(key)
        .content_type(content_type)
        .send()
        .await
        .map_err(|e| format!("upload failed: {}", DisplayErrorContext(&e)))?
        .upload_id()
        .map(String::from)
        .ok_or_else(|| "upload failed: no upload id returned".to_string())?;
    let mut parts: Vec<CompletedPart> = Vec::new();
    let mut part_number: i32 = 1;
    loop {
        if prog.cancelled() {
            abort_multipart(c, bucket, key, &upload_id).await;
            return Ok(false);
        }
        // Fill a whole part; read() may return short counts mid-stream.
        let mut buf = vec![0u8; part_size];
        let mut filled = 0usize;
        while filled < part_size {
            match reader.read(&mut buf[filled..]).await {
                Ok(0) => break,
                Ok(n) => filled += n,
                Err(e) => {
                    abort_multipart(c, bucket, key, &upload_id).await;
                    return Err(format!("read failed: {e}"));
                }
            }
        }
        if filled == 0 {
            break;
        }
        buf.truncate(filled);
        let part = match c
            .upload_part()
            .bucket(bucket)
            .key(key)
            .upload_id(&upload_id)
            .part_number(part_number)
            .body(ByteStream::from(buf))
            .send()
            .await
        {
            Ok(p) => p,
            Err(e) => {
                abort_multipart(c, bucket, key, &upload_id).await;
                return Err(format!("upload failed: {}", DisplayErrorContext(&e)));
            }
        };
        parts.push(
            CompletedPart::builder()
                .part_number(part_number)
                .set_e_tag(part.e_tag().map(String::from))
                .build(),
        );
        part_number += 1;
        prog.add(filled as u64);
    }
    if let Err(e) = c
        .complete_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(&upload_id)
        .multipart_upload(CompletedMultipartUpload::builder().set_parts(Some(parts)).build())
        .send()
        .await
    {
        abort_multipart(c, bucket, key, &upload_id).await;
        return Err(format!("upload failed: {}", DisplayErrorContext(&e)));
    }
    Ok(true)
}

/// Best-effort abort so a failed or cancelled multipart upload doesn't leave
/// orphaned parts on the server.
async fn abort_multipart(c: &Client, bucket: &str, key: &str, upload_id: &str) {
    let _ = c
        .abort_multipart_upload()
        .bucket(bucket)
        .key(key)
        .upload_id(upload_id)
        .send()
        .await;
}

/// Download an object to a local file, streamed chunk by chunk. With a
/// `job_id`, HEADs first so the progress total is known up front, streams
/// `transfer://progress` events, and honors transfer_cancel (removing the
/// partial local file — cancel is not an error).
#[tauri::command]
pub async fn s3_download(
    app: AppHandle,
    params: DbConnectParams,
    bucket: String,
    key: String,
    local_path: String,
    job_id: Option<String>,
) -> Result<(), String> {
    let c = client(&params);
    let job = job_id.as_deref();
    let name = key.rsplit('/').next().unwrap_or(&key).to_string();
    let mut done: u64 = 0;
    let mut total: Option<u64> = None;
    // Ok(true) = downloaded, Ok(false) = cancelled mid-stream.
    let res: Result<bool, String> = async {
        if job.is_some() {
            total = c
                .head_object()
                .bucket(&bucket)
                .key(&key)
                .send()
                .await
                .map_err(|e| format!("download failed: {}", DisplayErrorContext(&e)))?
                .content_length()
                .map(|n| n.max(0) as u64);
        }
        if let Some(job) = job {
            transfers::register(job);
            transfers::emit_progress(&app, job, &name, 0, total, "running", None);
        }
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
        let mut last_emit: u64 = 0;
        while let Some(chunk) = out
            .body
            .try_next()
            .await
            .map_err(|e| format!("download read failed: {e}"))?
        {
            if job.is_some_and(transfers::is_cancelled) {
                // Drop the handle before removing the partial file (Windows
                // won't delete an open file).
                drop(file);
                let _ = tokio::fs::remove_file(&local_path).await;
                return Ok(false);
            }
            file.write_all(&chunk).await.map_err(|e| format!("write failed: {e}"))?;
            done += chunk.len() as u64;
            if let Some(job) = job {
                if done - last_emit >= transfers::PROGRESS_STEP {
                    last_emit = done;
                    transfers::emit_progress(&app, job, &name, done, total, "running", None);
                }
            }
        }
        file.flush().await.map_err(|e| format!("write failed: {e}"))?;
        Ok(true)
    }
    .await;
    // A failed (non-cancelled) download leaves a truncated file at the user's
    // chosen path, easily mistaken for a complete one. The file handle is owned
    // inside the async block and already dropped by now, so best-effort remove
    // the partial file — mirroring the cancel-path cleanup — before reporting.
    if res.is_err() {
        let _ = tokio::fs::remove_file(&local_path).await;
    }
    transfers::finish(&app, job, &name, done, total, res)
}

/// The local path for an object's key relative to a downloaded folder, or
/// None when nothing safe is left. Keys are free-form text: "a/../../x",
/// "/etc/x" or "C:\x" must not escape the chosen folder, so "", "." and ".."
/// segments are dropped and Windows-reserved characters replaced.
pub(crate) fn safe_rel_path(rel: &str) -> Option<std::path::PathBuf> {
    let mut out = std::path::PathBuf::new();
    for seg in rel.split(['/', '\\']) {
        if seg.is_empty() || seg == "." || seg == ".." {
            continue;
        }
        let clean: String = seg
            .chars()
            .map(|c| if matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
            .collect();
        out.push(clean);
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Download everything under `prefix` (a "folder") into `local_dir/<name>/…`,
/// keeping the key hierarchy. One transfer job for the whole folder: the
/// listing is walked first so the byte total is known, then each object is
/// streamed in turn. Empty folder markers become empty dirs. Cancel stops
/// between chunks; files already downloaded stay, the partial one is removed.
/// Returns the number of files downloaded.
#[tauri::command]
pub async fn s3_download_prefix(
    app: AppHandle,
    params: DbConnectParams,
    bucket: String,
    prefix: String,
    local_dir: String,
    job_id: Option<String>,
) -> Result<u64, String> {
    let c = client(&params);
    let prefix = folder_prefix(&prefix);
    let name = {
        let n = prefix.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        let n = safe_rel_path(n).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        if n.is_empty() { bucket.clone() } else { n }
    };
    let root = std::path::PathBuf::from(&local_dir).join(&name);
    let mut prog = transfers::Progress::new(&app, job_id.as_deref(), &name);
    let mut count: u64 = 0;
    let res = download_prefix_into(&c, &bucket, &prefix, &root, &mut prog, &mut count).await;
    prog.finish(res).map(|_| count)
}

/// The body of s3_download_prefix (Ok(false) = cancelled); `count` is the
/// number of files fully written.
async fn download_prefix_into(
    c: &Client,
    bucket: &str,
    prefix: &str,
    root: &std::path::Path,
    prog: &mut transfers::Progress<'_>,
    count: &mut u64,
) -> Result<bool, String> {
    let mut dirs: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    let mut files: Vec<(String, std::path::PathBuf, u64)> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_objects_v2()
            .bucket(bucket)
            .prefix(prefix)
            .set_continuation_token(token.take())
            .send()
            .await
            .map_err(|e| format!("list objects failed: {}", DisplayErrorContext(&e)))?;
        for o in page.contents() {
            let Some(k) = o.key() else { continue };
            let Some(rel) = safe_rel_path(&k[prefix.len()..]) else { continue };
            let path = root.join(&rel);
            if k.ends_with('/') {
                dirs.push(path); // an (empty) folder marker
            } else {
                if let Some(parent) = path.parent() {
                    dirs.push(parent.to_path_buf());
                }
                files.push((k.to_string(), path, o.size().unwrap_or(0).max(0) as u64));
            }
        }
        token = page.next_continuation_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    // "a" and "a/" can both exist in S3; a file can't also be a dir locally.
    let dir_set: std::collections::HashSet<_> = dirs.iter().cloned().collect();
    files.retain(|f| !dir_set.contains(&f.1));
    prog.total = Some(files.iter().map(|f| f.2).sum());
    prog.start();
    dirs.sort();
    dirs.dedup();
    for d in &dirs {
        tokio::fs::create_dir_all(d)
            .await
            .map_err(|e| format!("create {} failed: {e}", d.display()))?;
    }
    for (k, path, _) in &files {
        if prog.cancelled() {
            return Ok(false);
        }
        let mut out = c
            .get_object()
            .bucket(bucket)
            .key(k)
            .send()
            .await
            .map_err(|e| format!("download {k} failed: {}", DisplayErrorContext(&e)))?;
        let mut file = tokio::fs::File::create(path)
            .await
            .map_err(|e| format!("create {} failed: {e}", path.display()))?;
        let copied: Result<bool, String> = async {
            while let Some(chunk) =
                out.body.try_next().await.map_err(|e| format!("download {k} failed: {e}"))?
            {
                if prog.cancelled() {
                    return Ok(false);
                }
                file.write_all(&chunk).await.map_err(|e| format!("write failed: {e}"))?;
                prog.add(chunk.len() as u64);
            }
            file.flush().await.map_err(|e| format!("write failed: {e}"))?;
            Ok(true)
        }
        .await;
        if !matches!(copied, Ok(true)) {
            // Don't leave a truncated file that looks complete.
            drop(file);
            let _ = tokio::fs::remove_file(path).await;
            return copied;
        }
        *count += 1;
    }
    Ok(true)
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

/// Build CopyObject's `x-amz-copy-source` value: "bucket/key" with the key
/// percent-encoded. The SDK passes this string through verbatim, so encoding
/// is on us: RFC 3986 unreserved bytes and "/" (path separators must stay
/// literal) pass through, everything else — spaces, "+", "?", non-ASCII — is
/// %XX-encoded per UTF-8 byte. Bucket names are DNS-safe, no encoding needed.
fn copy_source(bucket: &str, key: &str) -> String {
    let mut out = format!("{bucket}/");
    for b in key.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Server-side copy of one object; with `delete_source` this is a move (S3
/// has no native rename — rename = copy to the new key, then delete).
#[tauri::command]
pub async fn s3_copy_object(
    params: DbConnectParams,
    bucket: String,
    key: String,
    dest_bucket: String,
    dest_key: String,
    delete_source: bool,
) -> Result<(), String> {
    if bucket == dest_bucket && key == dest_key {
        return Err("source and destination are the same".into());
    }
    let c = client(&params);
    c.copy_object()
        .copy_source(copy_source(&bucket, &key))
        .bucket(&dest_bucket)
        .key(&dest_key)
        .send()
        .await
        .map_err(|e| format!("copy failed: {}", DisplayErrorContext(&e)))?;
    if delete_source {
        c.delete_object()
            .bucket(&bucket)
            .key(&key)
            .send()
            .await
            .map_err(|e| format!("copied; delete source failed: {}", DisplayErrorContext(&e)))?;
    }
    Ok(())
}

/// Normalize a folder prefix to end in "/" ("" stays "": the bucket root).
fn folder_prefix(p: &str) -> String {
    let p = p.trim_end_matches('/');
    if p.is_empty() {
        String::new()
    } else {
        format!("{p}/")
    }
}

/// Recursively copy everything under `prefix` into `dest_prefix` (paginated
/// flat listing + per-key server-side copy); with `delete_source` this is a
/// folder move, removing the sources in DeleteObjects batches of ≤1000 like
/// `s3_delete_prefix`. Returns how many objects were copied.
#[tauri::command]
pub async fn s3_copy_prefix(
    params: DbConnectParams,
    bucket: String,
    prefix: String,
    dest_bucket: String,
    dest_prefix: String,
    delete_source: bool,
) -> Result<u64, String> {
    let prefix = folder_prefix(&prefix);
    let dest_prefix = folder_prefix(&dest_prefix);
    if bucket == dest_bucket {
        if prefix == dest_prefix {
            return Err("source and destination are the same".into());
        }
        // The listing is live while we copy into it: copying a folder into
        // itself would keep finding its own copies and recurse forever.
        if dest_prefix.starts_with(&prefix) {
            return Err("cannot copy a folder into itself".into());
        }
    }
    let c = client(&params);
    let mut copied: u64 = 0;
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
            let k = match obj.key() {
                Some(k) => k,
                None => continue,
            };
            // The folder marker (key == prefix) maps to the dest marker, so
            // empty folders survive the copy too.
            let rest = k.strip_prefix(&prefix).unwrap_or(k);
            c.copy_object()
                .copy_source(copy_source(&bucket, k))
                .bucket(&dest_bucket)
                .key(format!("{dest_prefix}{rest}"))
                .send()
                .await
                .map_err(|e| format!("copy {k} failed: {}", DisplayErrorContext(&e)))?;
            copied += 1;
            if delete_source {
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
        }
        token = out.next_continuation_token().map(String::from);
        if token.is_none() {
            break;
        }
    }
    Ok(copied)
}

/// Save edited text back as the object's new body (the preview's Edit → Save),
/// keeping the content type the preview reported.
#[tauri::command]
pub async fn s3_put_text(
    params: DbConnectParams,
    bucket: String,
    key: String,
    content: String,
    content_type: Option<String>,
) -> Result<(), String> {
    let c = client(&params);
    let mut req = c
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .body(ByteStream::from(content.into_bytes()));
    if let Some(ct) = content_type.filter(|s| !s.is_empty()) {
        req = req.content_type(ct);
    }
    req.send()
        .await
        .map(|_| ())
        .map_err(|e| format!("save failed: {}", DisplayErrorContext(&e)))
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
/// or a ".pdf" key) ≤ its cap → full GET, bytes via the blob store for pdf.js; image ≤ cap →
/// full GET via the blob store; text-ish (by content type, or a UTF-8 sniff of the
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

    // Empty objects (folder markers, failed uploads): nothing to fetch (a
    // ranged GET of zero bytes is an error), and they must short-circuit
    // before the pdf/image branches — pdf.js chokes on an empty buffer.
    if size == 0 {
        return Ok(S3Preview {
            kind: "text".into(),
            content: String::new(),
            content_type,
            size,
            truncated: false,
        });
    }

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
        return Ok(S3Preview {
            kind: "pdf".into(),
            content: crate::blobs::stash(bytes.to_vec()),
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
        return Ok(S3Preview {
            kind: "image".into(),
            content: crate::blobs::stash(bytes.to_vec()),
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
    // When the ranged GET cut the body at the cap, a multibyte char split at
    // the boundary shows up as an incomplete trailing sequence (error_len()
    // None, at most 3 bytes) — trim it before the validity check so a large
    // UTF-8 file doesn't misclassify as binary.
    let sniff = match std::str::from_utf8(&bytes) {
        Err(e) if size > PREVIEW_CAP && e.error_len().is_none() => &bytes[..e.valid_up_to()],
        _ => &bytes[..],
    };
    if texty || (!bytes.contains(&0) && std::str::from_utf8(sniff).is_ok()) {
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

// ---- Object metadata + tags --------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Serialize)]
pub struct S3ObjectInfo {
    pub size: i64,
    pub modified: Option<i64>,
    pub etag: String,
    pub storage_class: String,
    pub version_id: String,
    /// The editable system headers.
    pub content_type: String,
    pub cache_control: String,
    pub content_disposition: String,
    pub content_encoding: String,
    /// User metadata (`x-amz-meta-*`), sorted by key.
    pub metadata: Vec<KeyValue>,
    pub tags: Vec<KeyValue>,
    /// Set when the server refused GetObjectTagging (e.g. a gateway without
    /// tagging support); the rest of the info is still valid.
    pub tags_error: Option<String>,
}

/// HEAD + GetObjectTagging for the object info panel.
#[tauri::command]
pub async fn s3_object_info(
    params: DbConnectParams,
    bucket: String,
    key: String,
) -> Result<S3ObjectInfo, String> {
    let c = client(&params);
    let head = c
        .head_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("head failed: {}", DisplayErrorContext(&e)))?;
    let mut metadata: Vec<KeyValue> = head
        .metadata()
        .map(|m| m.iter().map(|(k, v)| KeyValue { key: k.clone(), value: v.clone() }).collect())
        .unwrap_or_default();
    metadata.sort_by(|a, b| a.key.cmp(&b.key));
    let (tags, tags_error) = match c.get_object_tagging().bucket(&bucket).key(&key).send().await {
        Ok(t) => (
            t.tag_set()
                .iter()
                .map(|t| KeyValue { key: t.key().to_string(), value: t.value().to_string() })
                .collect(),
            None,
        ),
        Err(e) => (Vec::new(), Some(format!("{}", DisplayErrorContext(&e)))),
    };
    Ok(S3ObjectInfo {
        size: head.content_length().unwrap_or(0),
        modified: head.last_modified().and_then(|d| d.to_millis().ok()),
        etag: head.e_tag().unwrap_or_default().trim_matches('"').to_string(),
        storage_class: head.storage_class().map(|s| s.as_str().to_string()).unwrap_or_default(),
        version_id: head.version_id().unwrap_or_default().to_string(),
        content_type: head.content_type().unwrap_or_default().to_string(),
        cache_control: head.cache_control().unwrap_or_default().to_string(),
        content_disposition: head.content_disposition().unwrap_or_default().to_string(),
        content_encoding: head.content_encoding().unwrap_or_default().to_string(),
        metadata,
        tags,
        tags_error,
    })
}

/// Tag rules S3 enforces, checked here so the user gets a readable message
/// instead of a signed-request error: ≤10 tags, key 1–128, value ≤256, unique.
fn check_tags(tags: &[KeyValue]) -> Result<(), String> {
    if tags.len() > 10 {
        return Err("An object can have at most 10 tags.".into());
    }
    let mut seen = std::collections::HashSet::new();
    for t in tags {
        let k = t.key.trim();
        if k.is_empty() {
            return Err("Tag keys can't be empty.".into());
        }
        if k.chars().count() > 128 {
            return Err(format!("Tag key \"{k}\" is longer than 128 characters."));
        }
        if t.value.chars().count() > 256 {
            return Err(format!("The value of tag \"{k}\" is longer than 256 characters."));
        }
        if !seen.insert(k.to_string()) {
            return Err(format!("Tag key \"{k}\" is used twice."));
        }
    }
    Ok(())
}

/// Replace the object's tag set (an empty list removes all tags).
#[tauri::command]
pub async fn s3_set_tags(
    params: DbConnectParams,
    bucket: String,
    key: String,
    tags: Vec<KeyValue>,
) -> Result<(), String> {
    check_tags(&tags)?;
    let c = client(&params);
    if tags.is_empty() {
        return c
            .delete_object_tagging()
            .bucket(&bucket)
            .key(&key)
            .send()
            .await
            .map(|_| ())
            .map_err(|e| format!("remove tags failed: {}", DisplayErrorContext(&e)));
    }
    let set = tags
        .iter()
        .map(|t| Tag::builder().key(t.key.trim()).value(&t.value).build())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("tags: {e}"))?;
    let tagging = Tagging::builder().set_tag_set(Some(set)).build().map_err(|e| format!("tags: {e}"))?;
    c.put_object_tagging()
        .bucket(&bucket)
        .key(&key)
        .tagging(tagging)
        .send()
        .await
        .map(|_| ())
        .map_err(|e| format!("save tags failed: {}", DisplayErrorContext(&e)))
}

/// User-metadata keys travel as HTTP header names (`x-amz-meta-<key>`).
fn check_meta_key(k: &str) -> Result<(), String> {
    if k.is_empty() {
        return Err("Metadata keys can't be empty.".into());
    }
    if !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err(format!("Metadata key \"{k}\" may only use letters, digits, - _ and ."));
    }
    Ok(())
}

/// Rewrite the object's headers + user metadata. S3 can't edit metadata in
/// place, so this is CopyObject onto itself with REPLACE (tags are kept —
/// the tagging directive defaults to COPY). Objects over 5 GB can't be copied
/// in one request and fail with the server's message.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn s3_set_metadata(
    params: DbConnectParams,
    bucket: String,
    key: String,
    content_type: String,
    cache_control: String,
    content_disposition: String,
    content_encoding: String,
    metadata: Vec<KeyValue>,
) -> Result<(), String> {
    let mut meta = HashMap::new();
    for m in &metadata {
        let k = m.key.trim().to_ascii_lowercase();
        check_meta_key(&k)?;
        if meta.insert(k.clone(), m.value.clone()).is_some() {
            return Err(format!("Metadata key \"{k}\" is used twice."));
        }
    }
    let opt = |s: String| Some(s.trim().to_string()).filter(|s| !s.is_empty());
    let c = client(&params);
    c.copy_object()
        .bucket(&bucket)
        .key(&key)
        .copy_source(copy_source(&bucket, &key))
        .metadata_directive(MetadataDirective::Replace)
        .set_metadata(Some(meta))
        .set_content_type(opt(content_type))
        .set_cache_control(opt(cache_control))
        .set_content_disposition(opt(content_disposition))
        .set_content_encoding(opt(content_encoding))
        .send()
        .await
        .map(|_| ())
        .map_err(|e| format!("save metadata failed: {}", DisplayErrorContext(&e)))
}

/// Whole object as UTF-8 text (connection backups), refusing anything over
/// `max_bytes` so a wrong pick can't pull a huge file into memory.
#[tauri::command]
pub async fn s3_get_text(
    params: DbConnectParams,
    bucket: String,
    key: String,
    max_bytes: Option<i64>,
) -> Result<String, String> {
    let cap = max_bytes.unwrap_or(32 * 1024 * 1024);
    let c = client(&params);
    let out = c
        .get_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("read failed: {}", DisplayErrorContext(&e)))?;
    if out.content_length().unwrap_or(0) > cap {
        return Err(format!("{key} is larger than {} MB.", cap / 1024 / 1024));
    }
    let bytes = out
        .body
        .collect()
        .await
        .map_err(|e| format!("read failed: {e}"))?
        .into_bytes();
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("{key} is not a text file."))
}

/// Keys directly under `prefix` (no folders), newest first — the backup list.
#[tauri::command]
pub async fn s3_list_files(
    params: DbConnectParams,
    bucket: String,
    prefix: String,
) -> Result<Vec<S3Entry>, String> {
    let c = client(&params);
    let mut out: Vec<S3Entry> = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let page = c
            .list_objects_v2()
            .bucket(&bucket)
            .prefix(&prefix)
            .delimiter("/")
            .set_continuation_token(token.take())
            .send()
            .await
            .map_err(|e| format!("list objects failed: {}", DisplayErrorContext(&e)))?;
        for o in page.contents() {
            let Some(k) = o.key() else { continue };
            if k.ends_with('/') {
                continue;
            }
            out.push(S3Entry {
                key: k.to_string(),
                name: k.rsplit('/').next().unwrap_or(k).to_string(),
                is_dir: false,
                size: o.size().unwrap_or(0),
                modified: o.last_modified().and_then(|d| d.to_millis().ok()),
            });
        }
        token = page.next_continuation_token().map(String::from);
        if token.is_none() || out.len() >= 5000 {
            break;
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.key.cmp(&a.key)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn safe_rel_path_stays_inside() {
        use super::safe_rel_path;
        use std::path::PathBuf;
        assert_eq!(safe_rel_path("a/b.txt"), Some(PathBuf::from("a").join("b.txt")));
        assert_eq!(safe_rel_path("../../etc/passwd"), Some(PathBuf::from("etc").join("passwd")));
        assert_eq!(safe_rel_path("/abs//x/./y"), Some(PathBuf::from("abs").join("x").join("y")));
        assert_eq!(safe_rel_path("C:\\win\\x?.txt"), Some(PathBuf::from("C_").join("win").join("x_.txt")));
        assert_eq!(safe_rel_path(""), None);
        assert_eq!(safe_rel_path("../"), None);
    }

    use super::{check_meta_key, check_tags, KeyValue};

    fn kv(k: &str, v: &str) -> KeyValue {
        KeyValue { key: k.into(), value: v.into() }
    }

    #[test]
    fn tag_rules() {
        assert!(check_tags(&[kv("env", "prod"), kv("team", "")]).is_ok());
        assert!(check_tags(&[kv("", "x")]).is_err());
        assert!(check_tags(&[kv("a", "1"), kv("a", "2")]).is_err());
        assert!(check_tags(&(0..11).map(|i| kv(&i.to_string(), "")).collect::<Vec<_>>()).is_err());
        assert!(check_tags(&[kv(&"k".repeat(129), "")]).is_err());
        assert!(check_tags(&[kv("k", &"v".repeat(257))]).is_err());
    }

    #[test]
    fn meta_key_rules() {
        assert!(check_meta_key("owner-id_2.x").is_ok());
        assert!(check_meta_key("has space").is_err());
        assert!(check_meta_key("").is_err());
    }

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
            tls: None, ssl_mode: None, ssl_ca: None, tls_host: None, ssl_cert: None, ssl_key: None,
        }
    }

    // cargo test --lib s3 -- --ignored --nocapture
    // Needs a local MinIO: docker run -d -p 9000:9000 \
    //   -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
    //   minio/minio server /data
    /// BD_S3_TEST="host:port:key:secret" overrides the default MinIO.
    fn live_params() -> DbConnectParams {
        let mut p = params();
        if let Ok(v) = std::env::var("BD_S3_TEST") {
            let f: Vec<&str> = v.splitn(4, ':').collect();
            p.host = f[0].into();
            p.port = f[1].parse().unwrap();
            p.user = f[2].into();
            p.password = Some(f[3].into());
        }
        p
    }

    #[tokio::test]
    #[ignore]
    async fn s3_download_prefix_live() {
        let bucket = "balaudeck-dlprefix";
        let p = live_params();
        s3_delete_prefix(p.clone(), bucket.into(), String::new()).await.ok();
        s3_delete_bucket(p.clone(), bucket.into()).await.ok();
        s3_create_bucket(p.clone(), bucket.into()).await.expect("create bucket");
        let c = client(&p);
        for (k, body) in [
            ("site/index.html", "<h1>hi</h1>"),
            ("site/css/app.css", "body{}"),
            ("site/img/deep/x.bin", "0123456789"),
            ("site/a/we:ird?.txt", "nope"),
            ("other/skip.txt", "not in prefix"),
        ] {
            c.put_object().bucket(bucket).key(k).body(ByteStream::from_static(body.as_bytes())).send().await.expect(k);
        }
        s3_create_folder(p.clone(), bucket.into(), "site/empty".into()).await.expect("folder");
        let tmp = std::env::temp_dir().join(format!("bd-dlprefix-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let root = tmp.join("site");
        let mut prog = transfers::Progress::detached("site");
        let mut n = 0;
        let ok = download_prefix_into(&c, bucket, "site/", &root, &mut prog, &mut n).await.expect("download");
        assert!(ok);
        assert_eq!(n, 4);
        assert_eq!(prog.total, Some(11 + 6 + 10 + 4));
        assert_eq!(prog.done, 31);
        assert_eq!(std::fs::read_to_string(root.join("index.html")).unwrap(), "<h1>hi</h1>");
        assert_eq!(std::fs::read_to_string(root.join("img/deep/x.bin")).unwrap(), "0123456789");
        assert!(root.join("empty").is_dir());
        // Characters Windows can't store are replaced (".." is covered by
        // safe_rel_path_stays_inside — MinIO refuses such keys outright).
        assert!(root.join("a/we_ird_.txt").is_file());
        assert!(!root.join("skip.txt").exists());
        let _ = std::fs::remove_dir_all(&tmp);
        s3_delete_prefix(p.clone(), bucket.into(), String::new()).await.ok();
        s3_delete_bucket(p, bucket.into()).await.ok();
    }

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
        // (s3_upload/s3_download now take an injected AppHandle for progress
        // events, which a plain test can't construct — exercise the same
        // single-PUT/GET paths through the raw client instead.)
        let dir = std::env::temp_dir();
        let up = dir.join("balaudeck-s3-up.txt");
        std::fs::write(&up, "hello object storage").expect("write tmp");
        let c = client(&params());
        c.put_object()
            .bucket(bucket)
            .key("docs/hello.txt")
            .content_type(mime_guess::from_path(&up).first_or_octet_stream().as_ref())
            .body(ByteStream::from_path(&up).await.expect("open tmp"))
            .send()
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
        let bytes = c
            .get_object()
            .bucket(bucket)
            .key("docs/hello.txt")
            .send()
            .await
            .expect("download")
            .body
            .collect()
            .await
            .expect("download read")
            .into_bytes();
        std::fs::write(&down, &bytes).expect("write back");
        assert_eq!(std::fs::read_to_string(&down).expect("read back"), "hello object storage");

        // Rename = copy to the new key in the same prefix + delete the source.
        s3_copy_object(
            params(),
            bucket.into(),
            "docs/hello.txt".into(),
            bucket.into(),
            "docs/hi.txt".into(),
            true,
        )
        .await
        .expect("rename");
        let docs = s3_list_objects(params(), bucket.into(), "docs/".into(), None)
            .await
            .expect("list docs after rename");
        assert!(docs.entries.iter().any(|e| e.key == "docs/hi.txt" && !e.is_dir));
        assert!(!docs.entries.iter().any(|e| e.key == "docs/hello.txt"));
        // Copying an object onto itself is refused.
        let same = s3_copy_object(
            params(),
            bucket.into(),
            "docs/hi.txt".into(),
            bucket.into(),
            "docs/hi.txt".into(),
            false,
        )
        .await;
        assert!(same.is_err());

        // Folder move: docs/ -> archive/ (prefixes given without the trailing
        // "/" to exercise normalization), then the source folder is gone.
        let n = s3_copy_prefix(
            params(),
            bucket.into(),
            "docs".into(),
            bucket.into(),
            "archive".into(),
            true,
        )
        .await
        .expect("move folder");
        assert_eq!(n, 1); // docs/hi.txt
        let root = s3_list_objects(params(), bucket.into(), String::new(), None)
            .await
            .expect("list root after move");
        assert!(root.entries.iter().any(|e| e.key == "archive/" && e.is_dir));
        assert!(!root.entries.iter().any(|e| e.key == "docs/"));
        let arch = s3_list_objects(params(), bucket.into(), "archive/".into(), None)
            .await
            .expect("list archive");
        assert!(arch.entries.iter().any(|e| e.key == "archive/hi.txt" && !e.is_dir));
        // Copying a folder into itself is refused.
        let nested = s3_copy_prefix(
            params(),
            bucket.into(),
            "archive".into(),
            bucket.into(),
            "archive/sub".into(),
            false,
        )
        .await;
        assert!(nested.is_err());

        // Recursive delete reports the count, then the emptied bucket goes away.
        let n = s3_delete_prefix(params(), bucket.into(), String::new())
            .await
            .expect("delete prefix");
        println!("DELETED: {n}");
        assert_eq!(n, 2); // archive/hi.txt + the empty/ folder marker
        s3_delete_bucket(params(), bucket.into()).await.expect("delete bucket");
    }
}
