//! SSH client: connect (password / public-key) + interactive shell (PTY)
//! streamed to the frontend, with TOFU host-key verification.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use russh::client;
use russh::keys::{ssh_key, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::profiles;

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

/// Captures the server's host-key fingerprint during the handshake so we can
/// run TOFU verification *before* sending any credentials.
pub(crate) struct ClientHandler {
    captured_fingerprint: Arc<StdMutex<Option<String>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();
        *self.captured_fingerprint.lock().unwrap() = Some(fp);
        Ok(true)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthKind {
    Password,
    Key,
}

impl Default for SshAuthKind {
    fn default() -> Self {
        SshAuthKind::Password
    }
}

/// A jump host (ProxyJump): we connect to it first, then open a direct-tcpip
/// channel to the real target and run a second SSH session over that channel.
#[derive(Deserialize)]
pub struct JumpHost {
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
    /// Keychain lookup for the jump host's own secrets.
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Run `ssh` on the jump to reach the target (the jump's own ssh + config do
    /// the routing) instead of a direct-tcpip forward — for bastions that block
    /// TCP forwarding or only reach the target via their ssh config.
    #[serde(default)]
    pub nested: bool,
}

/// A live SSH connection. When reached through a jump host, the jump
/// connection is owned here so its transport stays alive for our lifetime.
pub(crate) struct SshConn {
    pub handle: client::Handle<ClientHandler>,
    _jump: Option<Box<SshConn>>,
}

#[derive(Deserialize)]
pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuthKind,
    /// Inline password (takes precedence over keychain).
    #[serde(default)]
    pub password: Option<String>,
    /// Inline private key (PEM/OpenSSH) for public-key auth.
    #[serde(default)]
    pub key: Option<String>,
    /// Inline passphrase protecting the private key.
    #[serde(default)]
    pub passphrase: Option<String>,
    /// When set, missing secrets are pulled from the keychain for this profile.
    #[serde(default)]
    pub profile_id: Option<String>,
    /// Optional jump host to reach this target through.
    #[serde(default)]
    pub jump: Option<JumpHost>,
    /// Run the shell inside `tmux new-session -A` for persistence across drops.
    #[serde(default)]
    pub tmux: bool,
    #[serde(default)]
    pub tmux_session: Option<String>,
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

/// Keep only shell-safe chars for a tmux session name (it is interpolated into
/// a shell command), capped in length; fall back to a default when empty.
fn tmux_session_name(requested: &Option<String>) -> String {
    let cleaned: String = requested
        .as_deref()
        .unwrap_or("")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "balaudeck".to_string()
    } else {
        cleaned
    }
}

/// Single-quote a value for safe interpolation into a shell command.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Build the command to run on the jump host for a nested SSH: run the jump's
/// own `ssh` to the target (its ssh config / agent / further hops do the
/// routing). The target's host key is TOFU-accepted on the jump's known_hosts.
fn nested_ssh_command(params: &SshConnectParams) -> String {
    let target = format!("{}@{}", sh_quote(&params.user), sh_quote(&params.host));
    // -o ConnectTimeout avoids a long hang on an unreachable target.
    let mut cmd = format!(
        "exec ssh -tt -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -p {} {target}",
        params.port
    );
    if params.tmux {
        // The session name is sanitized to [A-Za-z0-9_-] so it needs no quoting,
        // and the whole remote command (single-quoted below) contains no single
        // quotes — so the interpolation is shell-safe.
        let name = tmux_session_name(&params.tmux_session);
        let remote = format!(
            "command -v tmux >/dev/null 2>&1 && exec tmux new-session -A -s {name} || exec \"$SHELL\" -l"
        );
        cmd += &format!(" {}", sh_quote(&remote));
    }
    cmd
}

fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    Ok(dir.join("known_hosts.json"))
}

fn load_known_hosts(path: &PathBuf) -> HashMap<String, String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Resolve a secret: inline value wins, otherwise fall back to the keychain.
fn resolve_secret(inline: &Option<String>, profile_id: &Option<String>, slot: &str) -> Option<String> {
    if let Some(v) = inline {
        if !v.is_empty() {
            return Some(v.clone());
        }
    }
    if let Some(id) = profile_id {
        if let Ok(Some(v)) = profiles::get_secret("ssh", id, slot) {
            return Some(v);
        }
    }
    None
}

/// Connect, run TOFU host-key verification, and authenticate. Shared by the
/// shell (Fasa 2) and SFTP (Fasa 3) entry points.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn connect_authenticated(
    app: &AppHandle,
    host: &str,
    port: u16,
    user: &str,
    auth: &SshAuthKind,
    password: &Option<String>,
    key: &Option<String>,
    passphrase: &Option<String>,
    profile_id: &Option<String>,
    jump: Option<&JumpHost>,
) -> Result<SshConn, String> {
    let mut config = client::Config::default();
    // Send keepalives so a silently-dropped link (Wi-Fi change, sleep/wake, NAT
    // or firewall idle-timeout) is detected within ~45s instead of the terminal
    // hanging forever, and so idle connections aren't reaped mid-session.
    // Detection time ≈ interval × (keepalive_max + 1) = 15 × 3 = 45s.
    config.keepalive_interval = Some(std::time::Duration::from_secs(15));
    config.keepalive_max = 2;
    let config = Arc::new(config);
    let captured_fingerprint = Arc::new(StdMutex::new(None));
    let handler = ClientHandler {
        captured_fingerprint: captured_fingerprint.clone(),
    };

    // Either dial the target directly, or first connect the jump host and
    // tunnel a direct-tcpip channel to the target to run SSH over.
    let (mut handle, jump_conn): (client::Handle<ClientHandler>, Option<Box<SshConn>>) = match jump {
        None => {
            let h = client::connect(config, (host, port), handler)
                .await
                .map_err(|e| format!("connect to {host}:{port} failed: {e}"))?;
            (h, None)
        }
        Some(j) => {
            let jconn = Box::pin(connect_authenticated(
                app, &j.host, j.port, &j.user, &j.auth, &j.password, &j.key, &j.passphrase,
                &j.profile_id, None,
            ))
            .await
            .map_err(|e| format!("jump host {}@{}: {e}", j.user, j.host))?;
            let channel = jconn
                .handle
                .channel_open_direct_tcpip(host.to_string(), port as u32, "127.0.0.1".to_string(), 0)
                .await
                .map_err(|e| format!("jump forward to {host}:{port} failed: {e}"))?;
            let h = client::connect_stream(config, channel.into_stream(), handler)
                .await
                .map_err(|e| format!("connect via jump failed: {e}"))?;
            (h, Some(Box::new(jconn)))
        }
    };

    // ---- TOFU host-key verification (before sending credentials) ----
    let host_key = format!("{host}:{port}");
    let fingerprint = captured_fingerprint
        .lock()
        .unwrap()
        .clone()
        .ok_or("server did not present a host key")?;
    let kh_path = known_hosts_path(app)?;
    let mut known = load_known_hosts(&kh_path);
    match known.get(&host_key) {
        Some(stored) if stored != &fingerprint => {
            return Err(format!(
                "host key mismatch for {host_key}\n  known:  {stored}\n  actual: {fingerprint}\nRefusing to connect. Remove the host from known_hosts if this change is expected."
            ));
        }
        Some(_) => {}
        None => {
            known.insert(host_key, fingerprint);
            if let Ok(raw) = serde_json::to_string_pretty(&known) {
                let _ = fs::write(&kh_path, raw);
            }
        }
    }

    // ---- Authenticate ----
    let authed = match auth {
        SshAuthKind::Password => {
            let password =
                resolve_secret(password, profile_id, "password").ok_or("no password provided")?;
            handle
                .authenticate_password(user, &password)
                .await
                .map_err(|e| format!("auth error: {e}"))?
        }
        SshAuthKind::Key => {
            let pem = resolve_secret(key, profile_id, "key").ok_or("no private key provided")?;
            let passphrase = resolve_secret(passphrase, profile_id, "passphrase");
            let parsed = Arc::new(
                russh::keys::decode_secret_key(&pem, passphrase.as_deref())
                    .map_err(|e| format!("invalid private key: {e}"))?,
            );
            if matches!(parsed.algorithm(), ssh_key::Algorithm::Rsa { .. }) {
                // RSA: modern servers (OpenSSH 8.2+) reject ssh-rsa (SHA-1). Prefer
                // the server's advertised rsa-sha2 choice (server-sig-algs); if it
                // doesn't advertise, probe sha2-512 -> sha2-256 -> ssh-rsa so every
                // server generation is covered. The signature hash is independent
                // of the key encoding — PKCS#1 / PKCS#8 / OpenSSH all decode above.
                let candidates: Vec<Option<ssh_key::HashAlg>> =
                    match handle.best_supported_rsa_hash().await {
                        Ok(Some(h)) => vec![h],
                        _ => vec![
                            Some(ssh_key::HashAlg::Sha512),
                            Some(ssh_key::HashAlg::Sha256),
                            None,
                        ],
                    };
                let mut result = None;
                for h in candidates {
                    let r = handle
                        .authenticate_publickey(user, PrivateKeyWithHashAlg::new(parsed.clone(), h))
                        .await
                        .map_err(|e| format!("auth error: {e}"))?;
                    let ok = r.success();
                    result = Some(r);
                    if ok {
                        break;
                    }
                }
                result.expect("rsa auth attempted at least once")
            } else {
                // ed25519 / ecdsa: single signature algorithm, hash_alg ignored.
                handle
                    .authenticate_publickey(user, PrivateKeyWithHashAlg::new(parsed, None))
                    .await
                    .map_err(|e| format!("auth error: {e}"))?
            }
        }
    };
    if !authed.success() {
        return Err("authentication failed".into());
    }
    Ok(SshConn {
        handle,
        _jump: jump_conn,
    })
}

/// Open an SSH connection, request a PTY + shell, and stream output to the
/// frontend via `ssh://data/<id>` events. Returns the session id.
#[tauri::command]
pub async fn ssh_open_shell(
    app: AppHandle,
    state: State<'_, SshState>,
    params: SshConnectParams,
) -> Result<String, String> {
    // Nested jump: connect to the jump host itself and run `ssh` to the target
    // there (no direct-tcpip). Otherwise connect to the target directly,
    // optionally through a direct-tcpip jump (ProxyJump).
    let nested = params.jump.as_ref().map(|j| j.nested).unwrap_or(false);
    let conn = if let (true, Some(j)) = (nested, params.jump.as_ref()) {
        connect_authenticated(
            &app, &j.host, j.port, &j.user, &j.auth, &j.password, &j.key, &j.passphrase,
            &j.profile_id, None,
        )
        .await?
    } else {
        connect_authenticated(
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
        .await?
    };

    let mut channel = conn
        .handle
        .channel_open_session()
        .await
        .map_err(|e| format!("open session failed: {e}"))?;
    channel
        .request_pty(false, "xterm-256color", params.cols, params.rows, 0, 0, &[])
        .await
        .map_err(|e| format!("request pty failed: {e}"))?;
    if nested {
        // Run the jump's own ssh to the target; its config/agent does the routing.
        channel
            .exec(true, nested_ssh_command(&params).as_bytes())
            .await
            .map_err(|e| format!("start nested ssh failed: {e}"))?;
    } else if params.tmux {
        // Attach-or-create a named tmux session so the shell survives drops and
        // a reconnect re-attaches it; fall back to the login shell if tmux is
        // not installed on the server. The name is sanitized above, so the
        // single-quoted interpolation is injection-safe.
        let name = tmux_session_name(&params.tmux_session);
        let cmd = format!(
            "command -v tmux >/dev/null 2>&1 && exec tmux new-session -A -s '{name}' || exec \"$SHELL\" -l"
        );
        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|e| format!("start tmux failed: {e}"))?;
    } else {
        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("request shell failed: {e}"))?;
    }

    let id = Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<SshCmd>();
    state.sessions.lock().await.insert(id.clone(), tx);

    let data_event = format!("ssh://data/{id}");
    let close_event = format!("ssh://close/{id}");
    let app_for_task = app.clone();

    // In nested mode the inner `ssh` runs on the jump and prompts for the
    // target's password on the PTY. If the profile has a saved password, feed it
    // once when the prompt appears so the user doesn't type it every time.
    let mut pending_pw: Option<Vec<u8>> = if nested && matches!(params.auth, SshAuthKind::Password) {
        resolve_secret(&params.password, &params.profile_id, "password").map(|p| {
            let mut b = p.into_bytes();
            b.push(b'\n');
            b
        })
    } else {
        None
    };

    tauri::async_runtime::spawn(async move {
        let _keep_alive = conn;
        // Did the session end on purpose (the remote shell exited, or the user
        // closed it) vs was it lost (network drop / keepalive failure)? The
        // frontend uses this to show "closed" vs "lost" and to auto-reconnect.
        let mut clean = false;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let _ = app_for_task.emit(&data_event, data.to_vec());
                        // Auto-answer the nested ssh's target password prompt once.
                        if pending_pw.is_some()
                            && String::from_utf8_lossy(&data).to_lowercase().contains("password:")
                        {
                            if let Some(pw) = pending_pw.take() {
                                let _ = channel.data(&pw[..]).await;
                            }
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = app_for_task.emit(&data_event, data.to_vec());
                    }
                    Some(ChannelMsg::ExitStatus { .. }) => {
                        clean = true; // remote shell exited normally
                    }
                    // ExitSignal = the remote process was killed by a signal;
                    // leave it as a loss so auto-reconnect can bring a shell back.
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
                        clean = true; // user asked to disconnect
                        let _ = channel.eof().await;
                        break;
                    }
                },
            }
        }
        let reason = if clean { "exit" } else { "lost" };
        let _ = app_for_task.emit(&close_event, reason);
    });

    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(state: State<'_, SshState>, id: String, data: String) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::tmux_session_name;

    #[test]
    fn tmux_name_is_shell_safe() {
        // Plain names pass through.
        assert_eq!(tmux_session_name(&Some("work".into())), "work");
        assert_eq!(tmux_session_name(&Some("my-sess_1".into())), "my-sess_1");
        // Shell metacharacters (quotes, ;, spaces, /, #, $, backticks) are
        // stripped so the single-quoted interpolation can't be escaped.
        assert_eq!(tmux_session_name(&Some("a'; rm -rf / #".into())), "arm-rf");
        assert_eq!(tmux_session_name(&Some("$(whoami)`id`".into())), "whoamiid");
        // Empty / none / all-invalid fall back to the default.
        assert_eq!(tmux_session_name(&None), "balaudeck");
        assert_eq!(tmux_session_name(&Some("   ".into())), "balaudeck");
        assert_eq!(tmux_session_name(&Some("!@#".into())), "balaudeck");
    }
}
