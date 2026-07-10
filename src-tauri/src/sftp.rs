//! SFTP browser: directory listing, navigation, transfers, and basic file ops.
//! Each session opens its own authenticated SSH connection (Fasa 3).

use std::collections::HashMap;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::ssh::{JumpHost, SshAuthKind};
use crate::transfers;

/// Transfer chunk size. russh-sftp clamps each wire request to the server's
/// negotiated limit itself, so a bigger buffer is safe and cuts round-trips.
const CHUNK: usize = 64 * 1024;

/// A live SFTP session plus the SSH connection keeping its transport alive.
struct SftpConn {
    _conn: crate::ssh::SshConn,
    sftp: SftpSession,
}

#[derive(Default)]
pub struct SftpState {
    conns: Mutex<HashMap<String, Arc<SftpConn>>>,
}

#[derive(Deserialize)]
pub struct SftpConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuthKind,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub jump: Option<JumpHost>,
    /// Run this command for the SFTP channel instead of the standard subsystem
    /// (e.g. `sudo /usr/lib/openssh/sftp-server`). Empty/None = subsystem.
    #[serde(default)]
    pub sftp_command: Option<String>,
}

#[derive(Serialize)]
pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: u64,
    pub permissions: u32,
}

#[tauri::command]
pub async fn sftp_connect(
    app: AppHandle,
    state: State<'_, SftpState>,
    params: SftpConnectParams,
) -> Result<String, String> {
    let conn = crate::ssh::connect_authenticated(
        &app,
        &params.host,
        params.port,
        &params.user,
        &params.auth,
        &params.password,
        &params.key,
        &params.passphrase,
        &params.profile_id,
        params.jump.as_ref(),
    )
    .await?;

    // Optional sudo password (from the profile's keychain entry) to elevate the
    // sftp-server via `sudo -S` without requiring passwordless sudo.
    let sudo_password = params
        .profile_id
        .as_ref()
        .and_then(|id| crate::profiles::get_secret("ssh", id, "sudo_password").ok().flatten())
        .filter(|p| !p.is_empty());

    let channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("open channel failed: {e}"))?;
    // Either run a custom command (e.g. `sudo /usr/lib/openssh/sftp-server` to
    // browse elevated) or request the standard sftp subsystem.
    let mut feed_password: Option<String> = None;
    match params
        .sftp_command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        Some(cmd) => {
            // When a sudo password is supplied for a `sudo …` command, make sudo
            // read it from stdin (-S, empty prompt) and feed it before the SFTP
            // protocol; sudo consumes the password line, sftp-server gets the rest.
            let is_sudo = cmd == "sudo" || cmd.starts_with("sudo ");
            let run = match &sudo_password {
                Some(pw) if is_sudo => {
                    feed_password = Some(pw.clone());
                    if cmd.contains(" -S") {
                        cmd.to_string()
                    } else {
                        cmd.replacen("sudo", "sudo -S -p ''", 1)
                    }
                }
                _ => cmd.to_string(),
            };
            channel
                .exec(true, run.as_bytes())
                .await
                .map_err(|e| format!("start sftp server failed: {e}"))?;
        }
        None => channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("request sftp failed: {e}"))?,
    }
    let elevated = params
        .sftp_command
        .as_deref()
        .map(str::trim)
        .is_some_and(|c| !c.is_empty());
    let mut stream = channel.into_stream();
    if let Some(pw) = feed_password {
        stream
            .write_all(format!("{pw}\n").as_bytes())
            .await
            .map_err(|e| format!("sudo auth failed: {e}"))?;
        stream
            .flush()
            .await
            .map_err(|e| format!("sudo auth failed: {e}"))?;
    }
    // If the sftp-server never starts (e.g. sudo is silently waiting for a
    // password, sudoers requires a tty, or the path is wrong) the handshake
    // would hang forever — bound it and explain the likely cause.
    let sftp = match timeout(Duration::from_secs(15), SftpSession::new(stream)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return Err(format!("sftp init failed: {e}")),
        Err(_) if elevated => {
            return Err(
                "timed out starting the SFTP server. The sudo command didn't produce an SFTP \
                 stream — usually because sudo is waiting for a password (set the profile's Sudo \
                 password, or configure NOPASSWD), sudoers requires a tty for it, or the \
                 sftp-server path is wrong. Tip: open an SSH session to this host and run the \
                 exact command to see sudo's error."
                    .to_string(),
            )
        }
        Err(_) => return Err("timed out initializing the SFTP session".to_string()),
    };

    let id = Uuid::new_v4().to_string();
    state.conns.lock().await.insert(
        id.clone(),
        Arc::new(SftpConn {
            _conn: conn,
            sftp,
        }),
    );
    Ok(id)
}

async fn conn(state: &State<'_, SftpState>, id: &str) -> Result<Arc<SftpConn>, String> {
    state
        .conns
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| "sftp session not found".to_string())
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, SftpState>, id: String) -> Result<String, String> {
    let c = conn(&state, &id).await?;
    c.sftp
        .canonicalize(".")
        .await
        .map_err(|e| format!("canonicalize failed: {e}"))
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SftpState>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let c = conn(&state, &id).await?;
    let dir = c
        .sftp
        .read_dir(&path)
        .await
        .map_err(|e| format!("read_dir failed: {e}"))?;

    let mut entries: Vec<SftpEntry> = Vec::new();
    for e in dir {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = e.metadata();
        let mut is_dir = meta.is_dir();
        // A symlink's own metadata reports "symlink"; follow it (stat) so links
        // to directories are still navigable in the browser.
        if e.file_type().is_symlink() {
            let full = if path.ends_with('/') {
                format!("{path}{name}")
            } else {
                format!("{path}/{name}")
            };
            if let Ok(target) = c.sftp.metadata(full).await {
                is_dir = target.is_dir();
            }
        }
        entries.push(SftpEntry {
            name,
            is_dir,
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.unwrap_or(0) as u64,
            permissions: meta.permissions.unwrap_or(0),
        });
    }
    entries.sort_by(|a, b| (b.is_dir, a.name.to_lowercase()).cmp(&(a.is_dir, b.name.to_lowercase())));
    Ok(entries)
}

/// Download a remote file, streamed chunk by chunk. With a `job_id`, stats
/// first so the progress total is known up front, streams
/// `transfer://progress` events, and honors transfer_cancel (removing the
/// partial local file — cancel is not an error).
#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SftpState>,
    id: String,
    remote_path: String,
    local_path: String,
    job_id: Option<String>,
) -> Result<(), String> {
    let c = conn(&state, &id).await?;
    let job = job_id.as_deref();
    let name = remote_path.rsplit('/').next().unwrap_or(&remote_path).to_string();
    let mut done: u64 = 0;
    let mut total: Option<u64> = None;
    // Ok(true) = downloaded, Ok(false) = cancelled mid-stream.
    let res: Result<bool, String> = async {
        if job.is_some() {
            total = c
                .sftp
                .metadata(&remote_path)
                .await
                .map_err(|e| format!("download failed: {e}"))?
                .size;
        }
        if let Some(job) = job {
            transfers::register(job);
            transfers::emit_progress(&app, job, &name, 0, total, "running", None);
        }
        // Stream so a large remote file isn't buffered entirely in memory.
        let mut remote = c
            .sftp
            .open(&remote_path)
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        let mut local = tokio::fs::File::create(&local_path)
            .await
            .map_err(|e| format!("write local failed: {e}"))?;
        let mut buf = vec![0u8; CHUNK];
        let mut last_emit: u64 = 0;
        loop {
            if job.is_some_and(transfers::is_cancelled) {
                // Drop the handle before removing the partial file (Windows
                // won't delete an open file).
                drop(local);
                let _ = tokio::fs::remove_file(&local_path).await;
                return Ok(false);
            }
            let n = remote
                .read(&mut buf)
                .await
                .map_err(|e| format!("download failed: {e}"))?;
            if n == 0 {
                break;
            }
            local
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("write local failed: {e}"))?;
            done += n as u64;
            if let Some(job) = job {
                if done - last_emit >= transfers::PROGRESS_STEP {
                    last_emit = done;
                    transfers::emit_progress(&app, job, &name, done, total, "running", None);
                }
            }
        }
        local.flush().await.map_err(|e| format!("write local failed: {e}"))?;
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

/// SFTP has no server-supplied content type, so infer one from the filename,
/// falling back to `application/octet-stream`. Mirrors what an S3 server would
/// have reported in `s3_preview`.
fn guess_content_type(remote_path: &str) -> String {
    mime_guess::from_path(remote_path)
        .first_raw()
        .unwrap_or("application/octet-stream")
        .to_string()
}

/// How a preview's bytes should be presented, decided before the read so we
/// know whether to read the whole file (pdf/image) or just a bounded window.
enum PreviewKind {
    Pdf,
    Image,
    TooLarge,
    /// Text-or-binary, decided by sniffing the bytes.
    Generic,
}

/// Turn the already-read `bytes` into an [`S3Preview`], applying the same
/// text/binary sniff as `s3_preview` for the generic case. Pure (no I/O) so it
/// is unit-testable; the caller does the SFTP reads and picks the `kind`.
fn build_preview(
    content_type: String,
    size: i64,
    kind: PreviewKind,
    bytes: &[u8],
) -> crate::s3::S3Preview {
    use crate::s3::{S3Preview, PREVIEW_CAP};
    use base64::Engine;
    match kind {
        PreviewKind::Pdf => S3Preview {
            kind: "pdf".into(),
            content: base64::engine::general_purpose::STANDARD.encode(bytes),
            content_type: "application/pdf".into(),
            size,
            truncated: false,
        },
        PreviewKind::Image => S3Preview {
            kind: "image".into(),
            content: base64::engine::general_purpose::STANDARD.encode(bytes),
            content_type,
            size,
            truncated: false,
        },
        PreviewKind::TooLarge => S3Preview {
            kind: "too-large".into(),
            content: String::new(),
            content_type,
            size,
            truncated: false,
        },
        PreviewKind::Generic => {
            let ct = content_type.to_ascii_lowercase();
            let texty = ct.starts_with("text/")
                || ["json", "xml", "yaml", "javascript", "x-sh"].iter().any(|t| ct.contains(t));
            // A multibyte char split at the read boundary shows up as an
            // incomplete trailing sequence (error_len() None); trim it before
            // the validity check so a large UTF-8 file isn't misread as binary.
            let sniff = match std::str::from_utf8(bytes) {
                Err(e) if size > PREVIEW_CAP && e.error_len().is_none() => &bytes[..e.valid_up_to()],
                _ => bytes,
            };
            if texty || (!bytes.contains(&0) && std::str::from_utf8(sniff).is_ok()) {
                S3Preview {
                    kind: "text".into(),
                    content: String::from_utf8_lossy(bytes).into_owned(),
                    content_type,
                    size,
                    truncated: size > PREVIEW_CAP,
                }
            } else {
                S3Preview {
                    kind: "binary".into(),
                    content: String::new(),
                    content_type,
                    size,
                    truncated: false,
                }
            }
        }
    }
}

/// In-panel preview of a remote file, sharing the S3 browser's `S3Preview`
/// shape so both file panels render identically. The content type is inferred
/// from the filename (SFTP servers don't report one). Empty files short-circuit
/// to empty text; PDFs (≤ [`crate::s3::PDF_PREVIEW_CAP`]) and images
/// (≤ [`crate::s3::PREVIEW_CAP`]) are read whole and base64-encoded; otherwise
/// at most `PREVIEW_CAP` bytes are read and classified text-or-binary exactly
/// like `s3_preview`. Bigger media fall through to "too-large" and the UI
/// offers Download instead.
#[tauri::command]
pub async fn sftp_preview(
    state: State<'_, SftpState>,
    id: String,
    remote_path: String,
) -> Result<crate::s3::S3Preview, String> {
    use crate::s3::{S3Preview, PDF_PREVIEW_CAP, PREVIEW_CAP};

    let c = conn(&state, &id).await?;
    let size = c
        .sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| format!("preview failed: {e}"))?
        .size
        .unwrap_or(0) as i64;
    let content_type = guess_content_type(&remote_path);

    // Empty files: nothing to read, and must short-circuit before the pdf/image
    // branches (pdf.js chokes on an empty buffer).
    if size == 0 {
        return Ok(S3Preview {
            kind: "text".into(),
            content: String::new(),
            content_type,
            size,
            truncated: false,
        });
    }

    let is_pdf =
        content_type == "application/pdf" || remote_path.to_ascii_lowercase().ends_with(".pdf");
    let is_image = content_type.starts_with("image/");
    // PDFs render client-side in pdf.js, hence the larger cap.
    let cap = if is_pdf { PDF_PREVIEW_CAP } else { PREVIEW_CAP };
    if (is_pdf || is_image) && size > cap {
        return Ok(build_preview(content_type, size, PreviewKind::TooLarge, &[]));
    }

    // Read at most `read_cap` bytes: the whole file for pdf/image (already
    // capped above), otherwise a bounded window for the text sniff.
    let read_cap = if is_pdf || is_image { cap } else { PREVIEW_CAP } as usize;
    let mut remote = c
        .sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("preview failed: {e}"))?;
    let mut bytes: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    while bytes.len() < read_cap {
        let n = remote
            .read(&mut buf)
            .await
            .map_err(|e| format!("preview read failed: {e}"))?;
        if n == 0 {
            break;
        }
        let take = n.min(read_cap - bytes.len());
        bytes.extend_from_slice(&buf[..take]);
    }

    let kind = if is_pdf {
        PreviewKind::Pdf
    } else if is_image {
        PreviewKind::Image
    } else {
        PreviewKind::Generic
    };
    Ok(build_preview(content_type, size, kind, &bytes))
}

/// Upload a local file, streamed chunk by chunk. With a `job_id`, streams
/// `transfer://progress` events (total = the local file's size) and honors
/// transfer_cancel (best-effort removal of the partial remote file — cancel
/// is not an error).
#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SftpState>,
    id: String,
    local_path: String,
    remote_path: String,
    job_id: Option<String>,
) -> Result<(), String> {
    let c = conn(&state, &id).await?;
    let job = job_id.as_deref();
    let name = remote_path.rsplit('/').next().unwrap_or(&remote_path).to_string();
    let mut done: u64 = 0;
    let mut total: Option<u64> = None;
    // Ok(true) = uploaded, Ok(false) = cancelled mid-stream.
    let res: Result<bool, String> = async {
        let mut local = tokio::fs::File::open(&local_path)
            .await
            .map_err(|e| format!("read local failed: {e}"))?;
        if job.is_some() {
            total = Some(
                local
                    .metadata()
                    .await
                    .map_err(|e| format!("read local failed: {e}"))?
                    .len(),
            );
        }
        if let Some(job) = job {
            transfers::register(job);
            transfers::emit_progress(&app, job, &name, 0, total, "running", None);
        }
        // Use create() (CREATE | TRUNCATE | WRITE); the crate's write() only opens
        // with WRITE, so uploading a not-yet-existing remote file fails NoSuchFile.
        // Stream so a large local file isn't buffered entirely in memory.
        let mut remote = c
            .sftp
            .create(&remote_path)
            .await
            .map_err(|e| format!("upload failed: {e}"))?;
        let mut buf = vec![0u8; CHUNK];
        let mut last_emit: u64 = 0;
        loop {
            if job.is_some_and(transfers::is_cancelled) {
                // Close the handle, then best-effort remove the partial remote
                // file so a cancelled upload doesn't leave a truncated ghost.
                let _ = remote.shutdown().await;
                let _ = c.sftp.remove_file(&remote_path).await;
                return Ok(false);
            }
            let n = local
                .read(&mut buf)
                .await
                .map_err(|e| format!("read local failed: {e}"))?;
            if n == 0 {
                break;
            }
            remote
                .write_all(&buf[..n])
                .await
                .map_err(|e| format!("upload failed: {e}"))?;
            done += n as u64;
            if let Some(job) = job {
                if done - last_emit >= transfers::PROGRESS_STEP {
                    last_emit = done;
                    transfers::emit_progress(&app, job, &name, done, total, "running", None);
                }
            }
        }
        remote.shutdown().await.map_err(|e| format!("upload failed: {e}"))?;
        Ok(true)
    }
    .await;
    transfers::finish(&app, job, &name, done, total, res)
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, SftpState>, id: String, path: String) -> Result<(), String> {
    let c = conn(&state, &id).await?;
    c.sftp
        .create_dir(&path)
        .await
        .map_err(|e| format!("mkdir failed: {e}"))
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SftpState>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let c = conn(&state, &id).await?;
    c.sftp
        .rename(&from, &to)
        .await
        .map_err(|e| format!("rename failed: {e}"))
}

/// Change a file/directory's permission bits (chmod). `mode` is the octal
/// permission value (low 12 bits used: rwx for owner/group/other + special).
#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, SftpState>,
    id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let c = conn(&state, &id).await?;
    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
    attrs.permissions = Some(mode & 0o7777);
    c.sftp
        .set_metadata(&path, attrs)
        .await
        .map_err(|e| format!("chmod failed: {e}"))
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SftpState>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let c = conn(&state, &id).await?;
    if is_dir {
        c.sftp.remove_dir(&path).await
    } else {
        c.sftp.remove_file(&path).await
    }
    .map_err(|e| format!("remove failed: {e}"))
}

#[tauri::command]
pub async fn sftp_close(state: State<'_, SftpState>, id: String) -> Result<(), String> {
    state.conns.lock().await.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::s3::PREVIEW_CAP;

    #[test]
    fn content_type_inferred_from_extension() {
        // SFTP has no server content type; these drive the pdf/image/text routing.
        assert_eq!(guess_content_type("/home/demo/note.txt"), "text/plain");
        assert_eq!(guess_content_type("/home/demo/data.json"), "application/json");
        assert_eq!(guess_content_type("/x/pixel.png"), "image/png");
        assert_eq!(guess_content_type("/x/doc.pdf"), "application/pdf");
        // Unknown/extensionless → octet-stream, so it falls to the byte sniff.
        assert_eq!(guess_content_type("/x/blob.bin"), "application/octet-stream");
        assert_eq!(guess_content_type("/x/README"), "application/octet-stream");
    }

    #[test]
    fn utf8_text_classifies_as_text() {
        let body = "hello café ☕ 日本語\n{\"n\":42}".as_bytes();
        let p = build_preview(
            "text/plain".into(),
            body.len() as i64,
            PreviewKind::Generic,
            body,
        );
        assert_eq!(p.kind, "text");
        assert!(!p.truncated);
        assert!(p.content.contains("日本語"));
    }

    #[test]
    fn json_content_type_is_texty_even_without_sniff() {
        // application/json isn't text/*, but the texty allowlist must catch it.
        let body = br#"{"ok":true}"#;
        let p = build_preview("application/json".into(), body.len() as i64, PreviewKind::Generic, body);
        assert_eq!(p.kind, "text");
    }

    #[test]
    fn bytes_with_nul_classify_as_binary() {
        let body = &[0x89, 0x00, 0x01, 0xFF, 0x42];
        let p = build_preview(
            "application/octet-stream".into(),
            body.len() as i64,
            PreviewKind::Generic,
            body,
        );
        assert_eq!(p.kind, "binary");
        assert!(p.content.is_empty());
    }

    #[test]
    fn invalid_utf8_without_nul_is_binary() {
        // No NUL byte, but not valid UTF-8 → binary (not misread as text).
        let body = &[0xFF, 0xFE, 0xFD, 0xFC];
        let p = build_preview(
            "application/octet-stream".into(),
            body.len() as i64,
            PreviewKind::Generic,
            body,
        );
        assert_eq!(p.kind, "binary");
    }

    #[test]
    fn text_truncated_flag_set_past_cap() {
        // size beyond the cap marks the preview truncated even though the read
        // buffer is small in this unit test.
        let body = b"partial text content";
        let p = build_preview(
            "text/plain".into(),
            PREVIEW_CAP + 1,
            PreviewKind::Generic,
            body,
        );
        assert_eq!(p.kind, "text");
        assert!(p.truncated);
    }

    #[test]
    fn split_multibyte_at_cap_stays_text() {
        // A capped read can slice a multibyte char; the straddle-trim must keep
        // it classified as text rather than binary.
        let mut body = b"data ".to_vec();
        body.extend_from_slice(&"☕".as_bytes()[..2]); // first 2 of 3 bytes
        let p = build_preview(
            "text/plain".into(),
            PREVIEW_CAP + 100,
            PreviewKind::Generic,
            &body,
        );
        assert_eq!(p.kind, "text");
    }

    #[test]
    fn too_large_media_reports_download_hint() {
        let p = build_preview("image/png".into(), PREVIEW_CAP * 4, PreviewKind::TooLarge, &[]);
        assert_eq!(p.kind, "too-large");
        assert!(p.content.is_empty());
    }

    #[test]
    fn pdf_and_image_are_base64_encoded() {
        let body = &[0x25, 0x50, 0x44, 0x46]; // "%PDF"
        let pdf = build_preview("application/octet-stream".into(), 4, PreviewKind::Pdf, body);
        assert_eq!(pdf.kind, "pdf");
        assert_eq!(pdf.content_type, "application/pdf");
        assert_eq!(pdf.content, "JVBERg==");

        let img = build_preview("image/png".into(), 4, PreviewKind::Image, body);
        assert_eq!(img.kind, "image");
        assert_eq!(img.content_type, "image/png");
        assert!(!img.content.is_empty());
    }
}
