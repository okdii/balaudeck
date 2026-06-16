//! SSH client: connect + interactive shell (PTY) streamed to the frontend.
//! Spike-quality for Fasa 0; grows into the full Fasa 2 implementation.

use std::collections::HashMap;
use std::sync::Arc;

use russh::client;
use russh::keys::ssh_key;
use russh::ChannelMsg;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

/// Outgoing commands sent to a live shell session's driver task.
enum SshCmd {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

/// Live SSH shell sessions, keyed by an opaque id handed to the frontend.
#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<SshCmd>>>,
}

/// TOFU host-key acceptance — replaced by real known-hosts verification in Fasa 2.
struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

#[derive(Deserialize)]
pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    #[serde(default = "default_cols")]
    pub cols: u32,
    #[serde(default = "default_rows")]
    pub rows: u32,
}

fn default_cols() -> u32 {
    80
}
fn default_rows() -> u32 {
    24
}

/// Open an SSH connection, request a PTY + shell, and stream output to the
/// frontend via `ssh://data/<id>` events. Returns the session id.
#[tauri::command]
pub async fn ssh_open_shell(
    app: AppHandle,
    state: State<'_, SshState>,
    params: SshConnectParams,
) -> Result<String, String> {
    let config = Arc::new(client::Config::default());

    let mut handle = client::connect(config, (params.host.as_str(), params.port), ClientHandler)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    let authed = handle
        .authenticate_password(&params.user, &params.password)
        .await
        .map_err(|e| format!("auth error: {e}"))?;
    if !authed.success() {
        return Err("authentication failed".into());
    }

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("open session failed: {e}"))?;
    channel
        .request_pty(false, "xterm-256color", params.cols, params.rows, 0, 0, &[])
        .await
        .map_err(|e| format!("request pty failed: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("request shell failed: {e}"))?;

    let id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<SshCmd>();
    state.sessions.lock().await.insert(id.clone(), tx);

    let data_event = format!("ssh://data/{id}");
    let close_event = format!("ssh://close/{id}");
    let app_for_task = app.clone();

    // Keep `handle` alive for the duration of the session.
    tauri::async_runtime::spawn(async move {
        let _keep_alive = handle;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let _ = app_for_task.emit(&data_event, data.to_vec());
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = app_for_task.emit(&data_event, data.to_vec());
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(SshCmd::Data(d)) => {
                        let _ = channel.data(&d[..]).await;
                    }
                    Some(SshCmd::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    Some(SshCmd::Close) | None => {
                        let _ = channel.eof().await;
                        break;
                    }
                },
            }
        }
        let _ = app_for_task.emit(&close_event, ());
    });

    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, SshState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let tx = sessions.get(&id).ok_or("session not found")?;
    tx.send(SshCmd::Data(data.into_bytes()))
        .map_err(|_| "session closed".to_string())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, SshState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    if let Some(tx) = sessions.get(&id) {
        let _ = tx.send(SshCmd::Resize { cols, rows });
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_close(state: State<'_, SshState>, id: String) -> Result<(), String> {
    if let Some(tx) = state.sessions.lock().await.remove(&id) {
        let _ = tx.send(SshCmd::Close);
    }
    Ok(())
}
