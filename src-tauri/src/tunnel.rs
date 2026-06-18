//! SSH local port forwarding: a local TCP listener whose connections are
//! forwarded over the SSH transport to a remote host:port via direct-tcpip.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::ssh::SshAuthKind;

struct Tunnel {
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub struct TunnelState {
    tunnels: Mutex<HashMap<String, Tunnel>>,
}

#[derive(Deserialize)]
pub struct TunnelStartParams {
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
    pub jump: Option<crate::ssh::JumpHost>,
    pub remote_host: String,
    pub remote_port: u16,
    /// 0 (or omitted) picks an ephemeral local port.
    #[serde(default)]
    pub local_port: u16,
}

#[derive(Serialize, Clone)]
pub struct TunnelInfo {
    pub id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

/// Start a tunnel and return its info (including the chosen local port).
/// Reused internally by the DB client when connecting through SSH.
pub(crate) async fn start_tunnel(
    app: &AppHandle,
    state: &TunnelState,
    params: TunnelStartParams,
) -> Result<TunnelInfo, String> {
    let conn = crate::ssh::connect_authenticated(
        app,
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
    let handle = Arc::new(conn);

    let listener = TcpListener::bind(("127.0.0.1", params.local_port))
        .await
        .map_err(|e| {
            if params.local_port != 0 {
                format!(
                    "couldn't bind local port {}: {e}. Another app is using it (often a local database — e.g. MySQL/MariaDB on 3306). Set Local port to 0 for an automatic free port, or choose a different one.",
                    params.local_port
                )
            } else {
                format!("couldn't bind a local port: {e}")
            }
        })?;
    let local_port = listener
        .local_addr()
        .map_err(|e| format!("local addr: {e}"))?
        .port();

    let remote_host = params.remote_host.clone();
    let remote_port = params.remote_port;
    let fwd_host = remote_host.clone();

    let task = tauri::async_runtime::spawn(async move {
        let _keep_alive = handle.clone();
        loop {
            let (mut socket, peer) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let handle = handle.clone();
            let fwd_host = fwd_host.clone();
            tauri::async_runtime::spawn(async move {
                let channel = match handle
                    .handle
                    .channel_open_direct_tcpip(
                        fwd_host,
                        remote_port as u32,
                        peer.ip().to_string(),
                        peer.port() as u32,
                    )
                    .await
                {
                    Ok(c) => c,
                    Err(_) => return,
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });

    let id = Uuid::new_v4().to_string();
    let info = TunnelInfo {
        id: id.clone(),
        local_port,
        remote_host: remote_host.clone(),
        remote_port,
    };
    state.tunnels.lock().await.insert(
        id,
        Tunnel {
            local_port,
            remote_host,
            remote_port,
            task,
        },
    );
    Ok(info)
}

#[tauri::command]
pub async fn tunnel_start(
    app: AppHandle,
    state: State<'_, TunnelState>,
    params: TunnelStartParams,
) -> Result<TunnelInfo, String> {
    start_tunnel(&app, &state, params).await
}

#[tauri::command]
pub async fn tunnel_stop(state: State<'_, TunnelState>, id: String) -> Result<(), String> {
    state.tunnels.lock().await.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn tunnel_list(state: State<'_, TunnelState>) -> Result<Vec<TunnelInfo>, String> {
    Ok(state
        .tunnels
        .lock()
        .await
        .iter()
        .map(|(id, t)| TunnelInfo {
            id: id.clone(),
            local_port: t.local_port,
            remote_host: t.remote_host.clone(),
            remote_port: t.remote_port,
        })
        .collect())
}
