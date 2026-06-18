//! SFTP browser: directory listing, navigation, transfers, and basic file ops.
//! Each session opens its own authenticated SSH connection (Fasa 3).

use std::collections::HashMap;
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
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

    let channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("open channel failed: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("request sftp failed: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("sftp init failed: {e}"))?;

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

    let mut entries: Vec<SftpEntry> = dir
        .map(|e| {
            let meta = e.metadata();
            SftpEntry {
                name: e.file_name(),
                is_dir: meta.is_dir(),
                size: meta.size.unwrap_or(0),
                mtime: meta.mtime.unwrap_or(0) as u64,
                permissions: meta.permissions.unwrap_or(0),
            }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect();
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
    let data = c
        .sftp
        .read(&remote_path)
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    std::fs::write(&local_path, data).map_err(|e| format!("write local failed: {e}"))
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, SftpState>,
    id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let c = conn(&state, &id).await?;
    let data = std::fs::read(&local_path).map_err(|e| format!("read local failed: {e}"))?;
    // Use create() (CREATE | TRUNCATE | WRITE); the crate's write() only opens
    // with WRITE, so uploading a not-yet-existing remote file fails NoSuchFile.
    let mut file = c
        .sftp
        .create(&remote_path)
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    file.write_all(&data)
        .await
        .map_err(|e| format!("upload failed: {e}"))?;
    file.shutdown()
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
