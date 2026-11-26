//! Direct SFTP ⇄ S3 copies: bytes stream from one side to the other through
//! this process — no temp file, no round trip through the user's disk.
//!
//! A folder is ONE transfer job (one row in the transfer list): the tree is
//! walked first so the byte total is known, then each file is streamed in
//! turn. Symlinks on the SFTP side are skipped (as in sftp_download_dir).
//! Cancel stops between chunks/parts; files already copied stay.

use aws_sdk_s3::error::DisplayErrorContext;
use aws_sdk_s3::Client;
use russh_sftp::client::SftpSession;
use tauri::{AppHandle, State};
use tokio::io::AsyncWriteExt;

use crate::db::DbConnectParams;
use crate::s3;
use crate::sftp::{self, join_remote, SftpState};
use crate::transfers::Progress;

fn base_name(p: &str) -> String {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

/// `prefix` + `rel`, with exactly one "/" between (prefix "" = bucket root).
fn s3_key(prefix: &str, rel: &str) -> String {
    let p = prefix.trim_start_matches('/');
    if p.is_empty() {
        rel.to_string()
    } else if p.ends_with('/') {
        format!("{p}{rel}")
    } else {
        format!("{p}/{rel}")
    }
}

/// Copy a file or folder from an open SFTP session into `bucket` under
/// `prefix` (a folder lands as `<prefix>/<name>/…`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bridge_sftp_to_s3(
    app: AppHandle,
    state: State<'_, SftpState>,
    id: String,
    remote_path: String,
    is_dir: bool,
    params: DbConnectParams,
    bucket: String,
    prefix: String,
    job_id: Option<String>,
) -> Result<(), String> {
    let conn = sftp::conn(&state, &id).await?;
    let c = s3::client(&params);
    let name = base_name(&remote_path);
    let mut prog = Progress::new(&app, job_id.as_deref(), &name);
    let res = sftp_to_s3(&conn.sftp, &c, &remote_path, is_dir, &bucket, &prefix, &name, &mut prog).await;
    prog.finish(res)
}

#[allow(clippy::too_many_arguments)]
async fn sftp_to_s3(
    sftp: &SftpSession,
    c: &Client,
    remote_path: &str,
    is_dir: bool,
    bucket: &str,
    prefix: &str,
    name: &str,
    prog: &mut Progress<'_>,
) -> Result<bool, String> {
    {
        // (remote path, object key, size)
        let mut files: Vec<(String, String, u64)> = Vec::new();
        if is_dir {
            let root = remote_path.trim_end_matches('/').to_string();
            let mut stack = vec![(root, s3_key(prefix, name))];
            while let Some((rdir, kdir)) = stack.pop() {
                let listing = sftp
                    .read_dir(&rdir)
                    .await
                    .map_err(|e| format!("read_dir {rdir} failed: {e}"))?;
                for e in listing {
                    let n = e.file_name();
                    if n == "." || n == ".." || e.file_type().is_symlink() {
                        continue;
                    }
                    let r = sftp::join_remote(&rdir, &n);
                    let k = format!("{kdir}/{n}");
                    let meta = e.metadata();
                    if meta.is_dir() {
                        stack.push((r, k));
                    } else {
                        files.push((r, k, meta.size.unwrap_or(0)));
                    }
                }
            }
        } else {
            let size = sftp
                .metadata(remote_path)
                .await
                .map_err(|e| format!("stat {remote_path} failed: {e}"))?
                .size
                .unwrap_or(0);
            files.push((remote_path.to_string(), s3_key(prefix, name), size));
        }
        prog.total = Some(files.iter().map(|f| f.2).sum());
        prog.start();
        for (rpath, key, size) in &files {
            if prog.cancelled() {
                return Ok(false);
            }
            let mut f = sftp
                .open(rpath)
                .await
                .map_err(|e| format!("open {rpath} failed: {e}"))?;
            let ct = mime_guess::from_path(rpath).first_or_octet_stream().to_string();
            let ok = s3::put_reader(c, bucket, key, &mut f, *size, &ct, prog).await;
            // Close now (awaited) — Drop only fires a best-effort close, and a
            // big folder would otherwise hit the server's open-handle limit.
            let _ = f.shutdown().await;
            if !ok? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// Copy an object, or everything under a prefix (key ending in "/"), from S3
/// into `remote_dir` on an open SFTP session (a prefix lands as
/// `<remote_dir>/<name>/…`, sub-folders created as needed).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn bridge_s3_to_sftp(
    app: AppHandle,
    state: State<'_, SftpState>,
    params: DbConnectParams,
    bucket: String,
    key: String,
    id: String,
    remote_dir: String,
    job_id: Option<String>,
) -> Result<(), String> {
    let conn = sftp::conn(&state, &id).await?;
    let c = s3::client(&params);
    let name = base_name(&key);
    let mut prog = Progress::new(&app, job_id.as_deref(), &name);
    let res = s3_to_sftp(&c, &bucket, &key, &conn.sftp, &remote_dir, &name, &mut prog).await;
    prog.finish(res)
}

async fn s3_to_sftp(
    c: &Client,
    bucket: &str,
    key: &str,
    sftp: &SftpSession,
    remote_dir: &str,
    name: &str,
    prog: &mut Progress<'_>,
) -> Result<bool, String> {
    {
        // (object key, remote path, size)
        let mut files: Vec<(String, String, u64)> = Vec::new();
        let mut dirs: Vec<String> = Vec::new();
        if key.ends_with('/') {
            let root = join_remote(remote_dir.trim_end_matches('/'), name);
            dirs.push(root.clone());
            let mut token: Option<String> = None;
            loop {
                let page = c
                    .list_objects_v2()
                    .bucket(bucket)
                    .prefix(key)
                    .set_continuation_token(token.take())
                    .send()
                    .await
                    .map_err(|e| format!("list objects failed: {}", DisplayErrorContext(&e)))?;
                for o in page.contents() {
                    let Some(k) = o.key() else { continue };
                    let rel = &k[key.len()..];
                    if rel.is_empty() {
                        continue; // the folder marker itself
                    }
                    // Every parent of this key becomes a remote dir.
                    let segs: Vec<&str> = rel.split('/').collect();
                    let mut d = root.clone();
                    for s in &segs[..segs.len() - 1] {
                        if s.is_empty() {
                            continue;
                        }
                        d = join_remote(&d, s);
                        dirs.push(d.clone());
                    }
                    if rel.ends_with('/') {
                        continue; // an (empty) folder marker — dir created above
                    }
                    let local = segs.iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("/");
                    files.push((k.to_string(), join_remote(&root, &local), o.size().unwrap_or(0).max(0) as u64));
                }
                token = page.next_continuation_token().map(String::from);
                if token.is_none() {
                    break;
                }
            }
        } else {
            let size = c
                .head_object()
                .bucket(bucket)
                .key(key)
                .send()
                .await
                .map_err(|e| format!("head failed: {}", DisplayErrorContext(&e)))?
                .content_length()
                .unwrap_or(0)
                .max(0) as u64;
            files.push((key.to_string(), join_remote(remote_dir.trim_end_matches('/'), name), size));
        }
        prog.total = Some(files.iter().map(|f| f.2).sum());
        prog.start();
        // Parents first; SFTP mkdir isn't recursive and errors on an existing
        // dir, which is fine to ignore.
        dirs.sort_by_key(|d| d.matches('/').count());
        dirs.dedup();
        for d in &dirs {
            let _ = sftp.create_dir(d).await;
        }
        for (k, rpath, _) in &files {
            if prog.cancelled() {
                return Ok(false);
            }
            let mut out = c
                .get_object()
                .bucket(bucket)
                .key(k)
                .send()
                .await
                .map_err(|e| format!("read {k} failed: {}", DisplayErrorContext(&e)))?;
            let mut f = sftp
                .create(rpath)
                .await
                .map_err(|e| format!("create {rpath} failed: {e}"))?;
            let copied: Result<bool, String> = async {
                while let Some(chunk) =
                    out.body.try_next().await.map_err(|e| format!("read {k} failed: {e}"))?
                {
                    if prog.cancelled() {
                        return Ok(false);
                    }
                    f.write_all(&chunk).await.map_err(|e| format!("write {rpath} failed: {e}"))?;
                    prog.add(chunk.len() as u64);
                }
                Ok(true)
            }
            .await;
            let closed = f.shutdown().await;
            match copied {
                Ok(true) => closed.map_err(|e| format!("write {rpath} failed: {e}"))?,
                other => {
                    // Don't leave a truncated file that looks complete.
                    let _ = sftp.remove_file(rpath).await;
                    return other;
                }
            }
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::{base_name, s3_key};

    #[test]
    fn key_joining() {
        assert_eq!(s3_key("", "a.txt"), "a.txt");
        assert_eq!(s3_key("logs/", "a.txt"), "logs/a.txt");
        assert_eq!(s3_key("logs", "a.txt"), "logs/a.txt");
        assert_eq!(base_name("/var/log/"), "log");
        assert_eq!(base_name("backups/2026/"), "2026");
        assert_eq!(base_name("a/b.txt"), "b.txt");
    }

    /// Live: BD_BRIDGE_TEST="sftphost:port:user:pass|s3host:port:access:secret"
    /// (throwaway linuxserver/openssh-server + MinIO). Round-trips a small
    /// file, a multipart-sized file and a folder tree both ways, plus tags
    /// and metadata on the copied object.
    #[tokio::test]
    #[ignore]
    async fn bridge_live() {
        use super::*;
        use crate::transfers::Progress;
        let spec = std::env::var("BD_BRIDGE_TEST").unwrap();
        let (sp, s3p) = spec.split_once('|').unwrap();
        let p: Vec<&str> = sp.splitn(4, ':').collect();
        let q: Vec<&str> = s3p.splitn(4, ':').collect();

        struct H;
        impl russh::client::Handler for H {
            type Error = russh::Error;
            async fn check_server_key(&mut self, _k: &russh::keys::ssh_key::PublicKey) -> Result<bool, Self::Error> {
                Ok(true)
            }
        }
        let mut h = russh::client::connect(std::sync::Arc::new(Default::default()), (p[0], p[1].parse::<u16>().unwrap()), H)
            .await
            .unwrap();
        assert!(h.authenticate_password(p[2], p[3]).await.unwrap().success());
        let ch = h.channel_open_session().await.unwrap();
        ch.request_subsystem(true, "sftp").await.unwrap();
        let sftp = SftpSession::new(ch.into_stream()).await.unwrap();
        let home = sftp.canonicalize(".").await.unwrap();

        let params = DbConnectParams {
            engine: "s3".into(),
            host: q[0].into(),
            port: q[1].parse().unwrap(),
            user: q[2].into(),
            password: Some(q[3].into()),
            database: None,
            file: None,
            profile_id: None,
            region: None,
            path_style: Some(true),
            tls: Some(false), ssl_mode: None, ssl_ca: None, tls_host: None, ssl_cert: None, ssl_key: None,
        };
        let c = s3::client(&params);
        let bucket = "bdbridge";
        let _ = c.create_bucket().bucket(bucket).send().await;

        // Source tree on SFTP: src/a.txt, src/sub/big.bin (20 MB → multipart), src/sub/deep/c.json
        let src = format!("{home}/src");
        for d in [src.clone(), format!("{src}/sub"), format!("{src}/sub/deep")] {
            let _ = sftp.create_dir(d).await;
        }
        let big: Vec<u8> = (0..20 * 1024 * 1024u32).map(|i| (i % 251) as u8).collect();
        for (path, data) in [
            (format!("{src}/a.txt"), b"hello bridge\n".to_vec()),
            (format!("{src}/sub/big.bin"), big.clone()),
            (format!("{src}/sub/deep/c.json"), br#"{"ok":true}"#.to_vec()),
        ] {
            let mut f = sftp.create(path).await.unwrap();
            f.write_all(&data).await.unwrap();
            f.shutdown().await.unwrap();
        }

        // SFTP → S3: one file, then the folder.
        let mut prog = Progress::detached("a.txt");
        assert!(sftp_to_s3(&sftp, &c, &format!("{src}/a.txt"), false, bucket, "one/", "a.txt", &mut prog).await.unwrap());
        assert_eq!(prog.done, 13);
        let mut prog = Progress::detached("src");
        assert!(sftp_to_s3(&sftp, &c, &src, true, bucket, "tree", "src", &mut prog).await.unwrap());
        assert_eq!(prog.total, Some(13 + big.len() as u64 + 11));
        assert_eq!(prog.done, prog.total.unwrap());
        let mut keys: Vec<String> = c
            .list_objects_v2()
            .bucket(bucket)
            .send()
            .await
            .unwrap()
            .contents()
            .iter()
            .filter_map(|o| o.key().map(String::from))
            .collect();
        keys.sort();
        assert_eq!(keys, ["one/a.txt", "tree/src/a.txt", "tree/src/sub/big.bin", "tree/src/sub/deep/c.json"]);
        let got = c.get_object().bucket(bucket).key("tree/src/sub/big.bin").send().await.unwrap();
        assert_eq!(got.content_type(), Some("application/octet-stream"));
        let body = got.body.collect().await.unwrap().into_bytes();
        assert!(body.as_ref() == big.as_slice(), "multipart bytes intact");
        let ct = c.head_object().bucket(bucket).key("tree/src/sub/deep/c.json").send().await.unwrap();
        assert_eq!(ct.content_type(), Some("application/json"));

        // S3 → SFTP: the prefix into a fresh dir, then one object.
        let dst = format!("{home}/dst");
        let _ = sftp.create_dir(dst.clone()).await;
        let mut prog = Progress::detached("src");
        assert!(s3_to_sftp(&c, bucket, "tree/src/", &sftp, &dst, "src", &mut prog).await.unwrap());
        let back = {
            let mut f = sftp.open(format!("{dst}/src/sub/big.bin")).await.unwrap();
            let mut v = Vec::new();
            tokio::io::AsyncReadExt::read_to_end(&mut f, &mut v).await.unwrap();
            v
        };
        assert!(back == big, "round-trip bytes intact");
        assert!(sftp.metadata(format!("{dst}/src/sub/deep/c.json")).await.is_ok());
        let mut prog = Progress::detached("a.txt");
        assert!(s3_to_sftp(&c, bucket, "one/a.txt", &sftp, &dst, "a.txt", &mut prog).await.unwrap());
        assert_eq!(sftp.metadata(format!("{dst}/a.txt")).await.unwrap().size, Some(13));

        // Tags + metadata on one object.
        let kv = |k: &str, v: &str| s3::KeyValue { key: k.into(), value: v.into() };
        s3::s3_set_tags(params.clone(), bucket.into(), "one/a.txt".into(), vec![kv("env", "prod"), kv("team", "ops")])
            .await
            .unwrap();
        s3::s3_set_metadata(
            params.clone(),
            bucket.into(),
            "one/a.txt".into(),
            "text/plain; charset=utf-8".into(),
            "max-age=60".into(),
            "".into(),
            "".into(),
            vec![kv("Owner", "napi")],
        )
        .await
        .unwrap();
        let info = s3::s3_object_info(params.clone(), bucket.into(), "one/a.txt".into()).await.unwrap();
        assert_eq!(info.content_type, "text/plain; charset=utf-8");
        assert_eq!(info.cache_control, "max-age=60");
        assert_eq!(info.metadata, vec![kv("owner", "napi")]);
        assert_eq!(info.tags.len(), 2, "tags survive the metadata rewrite");
        s3::s3_set_tags(params.clone(), bucket.into(), "one/a.txt".into(), vec![]).await.unwrap();
        let info = s3::s3_object_info(params.clone(), bucket.into(), "one/a.txt".into()).await.unwrap();
        assert!(info.tags.is_empty());

        // Backup helpers.
        let txt = s3::s3_get_text(params.clone(), bucket.into(), "one/a.txt".into(), None).await.unwrap();
        assert_eq!(txt, "hello bridge\n");
        let files = s3::s3_list_files(params.clone(), bucket.into(), "one/".into()).await.unwrap();
        assert_eq!(files.len(), 1);
    }
}
