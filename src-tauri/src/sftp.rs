//! SFTP browser: directory listing, navigation, transfers, and basic file ops.
//! Each session opens its own authenticated SSH connection (Fasa 3).

use std::collections::HashMap;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::ssh::{JumpHost, SshAuthKind};

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

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, SftpState>,
    id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let c = conn(&state, &id).await?;
    // Stream so a large remote file isn't buffered entirely in memory.
    let mut remote = c
        .sftp
        .open(&remote_path)
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    let mut local = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| format!("write local failed: {e}"))?;
    tokio::io::copy(&mut remote, &mut local)
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    local
        .flush()
        .await
        .map_err(|e| format!("write local failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, SftpState>,
    id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let c = conn(&state, &id).await?;
    let mut local = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("read local failed: {e}"))?;
    // Use create() (CREATE | TRUNCATE | WRITE); the crate's write() only opens
    // with WRITE, so uploading a not-yet-existing remote file fails NoSuchFile.
    // Stream so a large local file isn't buffered entirely in memory.
    let mut remote = c
        .sftp
        .create(&remote_path)
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    tokio::io::copy(&mut local, &mut remote)
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    remote
        .shutdown()
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    Ok(())
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
