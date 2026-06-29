//! SSH port forwarding, three modes:
//!   - "local"   (`-L`): a local TCP listener whose connections are forwarded
//!     over SSH to a fixed `remote_host:remote_port` via direct-tcpip.
//!   - "dynamic" (`-D`): a local SOCKS5 proxy; each request picks its own target,
//!     forwarded the same way (reuses direct-tcpip).
//!   - "remote"  (`-R`): asks the SSH server to listen on a port; connections it
//!     receives are relayed back here to a local target.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{timeout, Duration};
use uuid::Uuid;

use crate::ssh::SshAuthKind;

struct Tunnel {
    local_port: u16,
    remote_host: String,
    remote_port: u16,
    mode: String,
    shutdown: Option<oneshot::Sender<()>>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        // Signal the accept loop to break and drop its TcpListener, deterministically
        // freeing the local port; abort() alone left the listener bound on some runs.
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
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
    /// "local" (default) | "dynamic" | "remote".
    #[serde(default)]
    pub mode: Option<String>,
    /// local:   the target reachable from the SSH server.
    /// dynamic: ignored (target is chosen per SOCKS request).
    /// remote:  the local target host on THIS machine (default 127.0.0.1).
    #[serde(default)]
    pub remote_host: String,
    /// local:   target port on the SSH server side.
    /// remote:  the port to open on the SSH SERVER (0 = server picks).
    #[serde(default)]
    pub remote_port: u16,
    /// local/dynamic: the local port to listen on (0 = auto).
    /// remote:        the local target PORT on this machine.
    #[serde(default)]
    pub local_port: u16,
}

#[derive(Serialize, Clone)]
pub struct TunnelInfo {
    pub id: String,
    /// local/dynamic: the local listen port. remote: the server bind port.
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub mode: String,
}

/// Minimal SOCKS5 server handshake: negotiate no-auth, read one CONNECT request,
/// and return the requested target host:port. (No auth, CONNECT only — enough to
/// act as an `ssh -D` dynamic proxy.)
async fn socks5_handshake(sock: &mut TcpStream) -> Result<(String, u16), String> {
    let mut head = [0u8; 2];
    sock.read_exact(&mut head).await.map_err(|e| format!("socks greeting: {e}"))?;
    if head[0] != 0x05 {
        return Err("not a SOCKS5 client".into());
    }
    let mut methods = vec![0u8; head[1] as usize];
    sock.read_exact(&mut methods).await.map_err(|e| format!("socks methods: {e}"))?;
    // Select "no authentication required".
    sock.write_all(&[0x05, 0x00]).await.map_err(|e| format!("socks select: {e}"))?;

    let mut req = [0u8; 4]; // VER, CMD, RSV, ATYP
    sock.read_exact(&mut req).await.map_err(|e| format!("socks request: {e}"))?;
    if req[0] != 0x05 {
        return Err("bad SOCKS5 request".into());
    }
    if req[1] != 0x01 {
        let _ = sock.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await; // cmd not supported
        return Err("socks: only CONNECT is supported".into());
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            sock.read_exact(&mut a).await.map_err(|e| format!("socks v4: {e}"))?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        0x04 => {
            let mut a = [0u8; 16];
            sock.read_exact(&mut a).await.map_err(|e| format!("socks v6: {e}"))?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        0x03 => {
            let mut l = [0u8; 1];
            sock.read_exact(&mut l).await.map_err(|e| format!("socks domain len: {e}"))?;
            let mut d = vec![0u8; l[0] as usize];
            sock.read_exact(&mut d).await.map_err(|e| format!("socks domain: {e}"))?;
            String::from_utf8_lossy(&d).into_owned()
        }
        _ => {
            let _ = sock.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await; // atyp not supported
            return Err("socks: unsupported address type".into());
        }
    };
    let mut p = [0u8; 2];
    sock.read_exact(&mut p).await.map_err(|e| format!("socks port: {e}"))?;
    Ok((host, u16::from_be_bytes(p)))
}

const SOCKS_OK: [u8; 10] = [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
const SOCKS_FAIL: [u8; 10] = [0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0];

/// Start a tunnel and return its info. Reused internally by the DB client.
pub(crate) async fn start_tunnel(
    app: &AppHandle,
    state: &TunnelState,
    params: TunnelStartParams,
) -> Result<TunnelInfo, String> {
    let mode = params.mode.clone().unwrap_or_else(|| "local".into());

    // ---- Remote forward (-R): server listens, connections relay back here ----
    if mode == "remote" {
        let (fwd_tx, mut fwd_rx) = mpsc::unbounded_channel();
        let conn = match timeout(
            Duration::from_secs(30),
            crate::ssh::connect_authenticated_forwarding(
                app, &params.host, params.port, &params.user, &params.auth, &params.password,
                &params.key, &params.passphrase, &params.profile_id, params.jump.as_ref(), fwd_tx,
            ),
        )
        .await
        {
            Ok(res) => res?,
            Err(_) => return Err("connection timed out — the SSH host (or jump server) is unreachable".into()),
        };
        let handle = Arc::new(conn);

        let bind_port = params.remote_port;
        let target_host = if params.remote_host.trim().is_empty() {
            "127.0.0.1".to_string()
        } else {
            params.remote_host.clone()
        };
        let target_port = params.local_port;
        if target_port == 0 {
            return Err("set a Local target port (the service on this machine to expose)".into());
        }
        // Ask the server to listen (loopback on the server side; 0 = server picks a port).
        let assigned = handle
            .handle
            .tcpip_forward("127.0.0.1", bind_port as u32)
            .await
            .map_err(|e| format!("remote-forward request rejected by the server: {e}. The SSH server may have AllowTcpForwarding disabled."))?
            as u16;

        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        let th = target_host.clone();
        let task = tauri::async_runtime::spawn(async move {
            let _keep_alive = handle.clone();
            loop {
                let channel = tokio::select! {
                    _ = &mut shutdown_rx => break,
                    ch = fwd_rx.recv() => match ch { Some(c) => c, None => break },
                };
                let th = th.clone();
                tauri::async_runtime::spawn(async move {
                    let mut local = match TcpStream::connect((th.as_str(), target_port)).await {
                        Ok(s) => s,
                        Err(_) => return,
                    };
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut local, &mut stream).await;
                });
            }
        });

        let id = Uuid::new_v4().to_string();
        let info = TunnelInfo {
            id: id.clone(),
            local_port: assigned,
            remote_host: target_host.clone(),
            remote_port: target_port,
            mode: mode.clone(),
        };
        state.tunnels.lock().await.insert(
            id,
            Tunnel { local_port: assigned, remote_host: target_host, remote_port: target_port, mode, shutdown: Some(shutdown_tx), task },
        );
        return Ok(info);
    }

    // ---- Local (-L) and Dynamic SOCKS (-D): a local listener ----
    let conn = match timeout(
        Duration::from_secs(30),
        crate::ssh::connect_authenticated(
            app, &params.host, params.port, &params.user, &params.auth, &params.password,
            &params.key, &params.passphrase, &params.profile_id, params.jump.as_ref(),
        ),
    )
    .await
    {
        Ok(res) => res?,
        Err(_) => return Err("connection timed out — the SSH host (or jump server) is unreachable or not responding".into()),
    };
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
    let local_port = listener.local_addr().map_err(|e| format!("local addr: {e}"))?.port();

    let dynamic = mode == "dynamic";
    let remote_host = params.remote_host.clone();
    let remote_port = params.remote_port;
    let fwd_host = remote_host.clone();

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let task = tauri::async_runtime::spawn(async move {
        let _keep_alive = handle.clone();
        loop {
            let (mut socket, peer) = tokio::select! {
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => match accepted {
                    Ok(v) => v,
                    Err(_) => break,
                },
            };
            let handle = handle.clone();
            let fwd_host = fwd_host.clone();
            tauri::async_runtime::spawn(async move {
                if dynamic {
                    let (dest_host, dest_port) = match socks5_handshake(&mut socket).await {
                        Ok(v) => v,
                        Err(_) => return,
                    };
                    let channel = match handle
                        .handle
                        .channel_open_direct_tcpip(dest_host, dest_port as u32, peer.ip().to_string(), peer.port() as u32)
                        .await
                    {
                        Ok(c) => {
                            let _ = socket.write_all(&SOCKS_OK).await;
                            c
                        }
                        Err(_) => {
                            let _ = socket.write_all(&SOCKS_FAIL).await;
                            return;
                        }
                    };
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                } else {
                    let channel = match handle
                        .handle
                        .channel_open_direct_tcpip(fwd_host, remote_port as u32, peer.ip().to_string(), peer.port() as u32)
                        .await
                    {
                        Ok(c) => c,
                        Err(_) => return,
                    };
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                }
            });
        }
        drop(listener);
    });

    // Dynamic has no fixed remote target — leave it blank for display.
    let (disp_host, disp_port) = if dynamic { (String::new(), 0u16) } else { (remote_host, remote_port) };
    let id = Uuid::new_v4().to_string();
    let info = TunnelInfo {
        id: id.clone(),
        local_port,
        remote_host: disp_host.clone(),
        remote_port: disp_port,
        mode: mode.clone(),
    };
    state.tunnels.lock().await.insert(
        id,
        Tunnel { local_port, remote_host: disp_host, remote_port: disp_port, mode, shutdown: Some(shutdown_tx), task },
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
            mode: t.mode.clone(),
        })
        .collect())
}
