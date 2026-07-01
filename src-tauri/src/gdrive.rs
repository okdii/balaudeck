//! Google Drive sync of the encrypted connection bundle (desktop only for now).
//!
//! This reuses the exact same passphrase-encrypted `BDK1` bundle that the manual
//! export/import already produces (see `profiles::connections_export` /
//! `connections_import`). The bundle stays end-to-end encrypted: only the opaque
//! ciphertext is uploaded, so Google (and anyone with access to the Drive file)
//! never sees a plaintext password or key. The sync passphrase never leaves the
//! device — it's cached in the OS keychain so auto-sync can run unattended.
//!
//! OAuth is PKCE either way, but the redirect differs by platform:
//!   * Desktop: "installed app" loopback — open the system browser, listen on an
//!     ephemeral `127.0.0.1` port, exchange the code (with client secret).
//!   * iOS: a custom URL scheme (the reversed client id) — open Safari, and the
//!     redirect comes back via `tauri-plugin-deep-link` into `handle_deep_link`,
//!     which finishes the exchange (public client, no secret) and emits an event.
//! Android is stubbed for now (its deep-link wiring is a later phase).

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

/// Status surfaced to the Google Drive tab in the Sync modal.
#[derive(Serialize, Default)]
pub struct GdriveStatus {
    /// The build was compiled with a real OAuth client id (not the placeholder).
    pub configured: bool,
    /// A refresh token is present in the keychain.
    pub connected: bool,
    /// The signed-in Google account email, if known.
    pub email: Option<String>,
    /// Auto-sync (debounced push + throttled pull) is enabled.
    pub auto_sync: bool,
    /// A sync passphrase is cached, so unattended auto-sync can run.
    pub has_passphrase: bool,
    /// Epoch-ms of the last successful push (0 = never).
    pub last_push_ms: i64,
    /// Epoch-ms of the last successful pull (0 = never).
    pub last_pull_ms: i64,
}

/// In-memory access-token cache (access tokens are short-lived; never persisted),
/// a lock that serializes sync ops, and (iOS) the in-flight OAuth PKCE state that
/// bridges `auth_start` and the deep-link callback. All fields exist on desktop +
/// iOS; on Android `GdriveState` is an empty marker (the `imp` module is cfg'd out).
#[derive(Default)]
pub struct GdriveState {
    #[cfg(not(target_os = "android"))]
    inner: std::sync::Mutex<TokenCache>,
    /// Serializes push/pull so a concurrent auto + manual op can't interleave —
    /// this makes the auto-sync throttle's check-then-act atomic.
    #[cfg(not(target_os = "android"))]
    op_lock: tokio::sync::Mutex<()>,
    /// iOS deep-link OAuth: PKCE verifier + CSRF state + redirect held between
    /// `auth_start` (opens Safari) and the redirect coming back via the URL scheme.
    #[cfg(target_os = "ios")]
    pending: std::sync::Mutex<Option<imp::PendingAuth>>,
}

#[cfg(not(target_os = "android"))]
#[derive(Default)]
struct TokenCache {
    access_token: Option<String>,
    expires_at_ms: i64,
}

#[allow(dead_code)] // used on desktop + iOS, not Android
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- Tauri commands (thin; real work lives in the desktop module) -----------

#[tauri::command]
pub fn gdrive_auth_status(app: AppHandle) -> Result<GdriveStatus, String> {
    #[cfg(not(target_os = "android"))]
    {
        imp::status(&app)
    }
    #[cfg(target_os = "android")]
    {
        let _ = app;
        Ok(GdriveStatus::default())
    }
}

#[tauri::command]
pub async fn gdrive_auth_start(
    app: AppHandle,
    state: tauri::State<'_, GdriveState>,
) -> Result<GdriveStatus, String> {
    #[cfg(not(target_os = "android"))]
    {
        imp::auth_start(&app, state.inner()).await
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        Err("Google Drive sync isn't available on Android yet.".into())
    }
}

#[tauri::command]
pub async fn gdrive_auth_disconnect(
    app: AppHandle,
    state: tauri::State<'_, GdriveState>,
) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        imp::disconnect(&app, state.inner()).await
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        Err("Google Drive sync isn't available on Android yet.".into())
    }
}

#[tauri::command]
pub fn gdrive_set_auto_sync(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        imp::set_auto_sync(&app, enabled)
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, enabled);
        Err("Google Drive sync isn't available on Android yet.".into())
    }
}

#[tauri::command]
pub async fn gdrive_sync_push(
    app: AppHandle,
    state: tauri::State<'_, GdriveState>,
    passphrase: String,
) -> Result<i64, String> {
    #[cfg(not(target_os = "android"))]
    {
        imp::sync_push(&app, state.inner(), &passphrase).await
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, state, passphrase);
        Err("Google Drive sync isn't available on Android yet.".into())
    }
}

#[tauri::command]
pub async fn gdrive_sync_pull(
    app: AppHandle,
    state: tauri::State<'_, GdriveState>,
    passphrase: String,
) -> Result<crate::profiles::ImportSummary, String> {
    #[cfg(not(target_os = "android"))]
    {
        imp::sync_pull(&app, state.inner(), &passphrase).await
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, state, passphrase);
        Err("Google Drive sync isn't available on Android yet.".into())
    }
}

/// Unattended push using the cached passphrase. No-ops (Ok(None)) when auto-sync
/// is off, not connected, or no passphrase is cached. Returns the push time.
#[tauri::command]
pub async fn gdrive_auto_push(
    app: AppHandle,
    state: tauri::State<'_, GdriveState>,
) -> Result<Option<i64>, String> {
    #[cfg(not(target_os = "android"))]
    {
        imp::auto_push(&app, state.inner()).await
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        Ok(None)
    }
}

/// Unattended pull (throttled) using the cached passphrase. Returns the import
/// summary when a pull actually ran, else Ok(None). Best-effort: soft failures
/// (offline, no remote file yet) return Ok(None) rather than surfacing an error.
#[tauri::command]
pub async fn gdrive_auto_pull(
    app: AppHandle,
    state: tauri::State<'_, GdriveState>,
) -> Result<Option<crate::profiles::ImportSummary>, String> {
    #[cfg(not(target_os = "android"))]
    {
        imp::auto_pull(&app, state.inner()).await
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, state);
        Ok(None)
    }
}

/// Entry point for the deep-link handler wired in `lib.rs`. On iOS this finishes
/// the Google OAuth redirect (`com.googleusercontent.apps.…://…?code=…`) and
/// emits a `gdrive://auth` event to the UI. A no-op on other platforms (where it
/// is not wired, hence unused).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub async fn handle_deep_link(app: &AppHandle, url: &str) {
    #[cfg(target_os = "ios")]
    {
        let _ = imp::complete_deep_link(app, url).await;
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, url);
    }
}

#[cfg(not(target_os = "android"))]
mod imp {
    use super::{now_ms, GdriveState, GdriveStatus, TokenCache};
    use crate::profiles;
    use serde::{Deserialize, Serialize};
    use std::path::PathBuf;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};
    // Loopback OAuth is desktop-only; iOS uses the deep-link path instead.
    #[cfg(not(target_os = "ios"))]
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[cfg(not(target_os = "ios"))]
    use tokio::net::TcpListener;

    // ---- OAuth client configuration -----------------------------------------
    //
    // The client id + secret are NOT hard-coded — this repo is public, and a
    // committed GOCSPX secret would be flagged by secret scanning and auto-
    // disabled by Google. They are resolved at runtime, in order:
    //   1. env vars BALAUDECK_GOOGLE_CLIENT_ID / BALAUDECK_GOOGLE_CLIENT_SECRET
    //   2. {app_data_dir}/gdrive_client.json  →  {"client_id","client_secret"}
    // Create your own Google "Desktop app" OAuth client (enable the Drive API;
    // consent-screen scopes drive.file/openid/email are non-sensitive, so no
    // verification is needed). For a desktop/installed app the secret isn't
    // truly confidential — the flow is hardened by PKCE + the loopback redirect
    // — but keeping it out of the repo avoids automated secret-scan takedowns.
    /// A resolved OAuth client. Desktop uses a "Desktop app" client (id + secret);
    /// iOS uses an "iOS" client (public — id only, hardened by PKCE).
    struct OauthClient {
        id: String,
        secret: Option<String>,
    }

    fn oauth_client(app: &AppHandle) -> Option<OauthClient> {
        #[derive(Deserialize, Default)]
        #[allow(dead_code)] // fields read per-platform
        struct FileClient {
            #[serde(default)]
            client_id: String,
            #[serde(default)]
            client_secret: String,
            #[serde(default)]
            ios_client_id: String,
        }
        let file: FileClient = app
            .path()
            .app_data_dir()
            .ok()
            .and_then(|d| std::fs::read_to_string(d.join("gdrive_client.json")).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        #[cfg(target_os = "ios")]
        {
            let id = std::env::var("BALAUDECK_GOOGLE_IOS_CLIENT_ID")
                .ok()
                .filter(|s| !s.is_empty())
                .or_else(|| (!file.ios_client_id.is_empty()).then(|| file.ios_client_id.clone()))?;
            Some(OauthClient { id, secret: None })
        }
        #[cfg(not(target_os = "ios"))]
        {
            if let (Ok(id), Ok(secret)) = (
                std::env::var("BALAUDECK_GOOGLE_CLIENT_ID"),
                std::env::var("BALAUDECK_GOOGLE_CLIENT_SECRET"),
            ) {
                if !id.is_empty() && !secret.is_empty() {
                    return Some(OauthClient { id, secret: Some(secret) });
                }
            }
            (!file.client_id.is_empty() && !file.client_secret.is_empty()).then(|| OauthClient {
                id: file.client_id.clone(),
                secret: Some(file.client_secret.clone()),
            })
        }
    }

    /// Build the token-endpoint form, adding `client_secret` only when present
    /// (iOS public clients have none).
    fn token_form<'a>(
        oauth: &'a OauthClient,
        extra: Vec<(&'a str, &'a str)>,
    ) -> Vec<(&'a str, &'a str)> {
        let mut form = vec![("client_id", oauth.id.as_str())];
        if let Some(s) = &oauth.secret {
            form.push(("client_secret", s.as_str()));
        }
        form.extend(extra);
        form
    }

    /// `drive.file` = only files this app creates; `openid`+`email` just to show
    /// which account is connected. All three are non-sensitive.
    const SCOPES: &str = "openid email https://www.googleapis.com/auth/drive.file";
    const FOLDER_NAME: &str = "BalauDeck";
    const FILE_NAME: &str = "connections.bdk";
    const DRIVE_FOLDER_MIME: &str = "application/vnd.google-apps.folder";

    const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
    const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
    const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
    const USERINFO_ENDPOINT: &str = "https://openidconnect.googleapis.com/v1/userinfo";
    const DRIVE_FILES: &str = "https://www.googleapis.com/drive/v3/files";
    const DRIVE_UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";

    /// Keychain slots (account = "gdrive:oauth:refresh_token" etc.).
    const KIND: &str = "gdrive";
    const REFRESH_ID: &str = "oauth";
    const REFRESH_SLOT: &str = "refresh_token";
    const PASS_ID: &str = "sync";
    const PASS_SLOT: &str = "passphrase";

    const PULL_THROTTLE_MS: i64 = 5 * 60 * 1000;

    fn configured(app: &AppHandle) -> bool {
        oauth_client(app).is_some()
    }

    // ---- Sync metadata (non-sensitive, plaintext in the app data dir) --------

    #[derive(Serialize, Deserialize, Default)]
    struct SyncMeta {
        #[serde(default)]
        email: Option<String>,
        #[serde(default)]
        auto_sync: bool,
        #[serde(default)]
        last_push_ms: i64,
        #[serde(default)]
        last_pull_ms: i64,
    }

    fn meta_path(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("no app data dir: {e}"))?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
        Ok(dir.join("gdrive_sync.json"))
    }

    fn read_meta(app: &AppHandle) -> SyncMeta {
        meta_path(app)
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write_meta(app: &AppHandle, meta: &SyncMeta) -> Result<(), String> {
        let path = meta_path(app)?;
        let raw = serde_json::to_string_pretty(meta).map_err(|e| format!("serialize: {e}"))?;
        std::fs::write(&path, raw).map_err(|e| format!("write meta: {e}"))
    }

    fn refresh_token() -> Result<Option<String>, String> {
        profiles::get_secret(KIND, REFRESH_ID, REFRESH_SLOT)
    }

    fn cached_passphrase() -> Result<Option<String>, String> {
        profiles::get_secret(KIND, PASS_ID, PASS_SLOT)
    }

    // ---- Public entry points ------------------------------------------------

    pub fn status(app: &AppHandle) -> Result<GdriveStatus, String> {
        let meta = read_meta(app);
        Ok(GdriveStatus {
            configured: configured(app),
            connected: refresh_token()?.is_some(),
            email: meta.email,
            auto_sync: meta.auto_sync,
            has_passphrase: cached_passphrase()?.is_some(),
            last_push_ms: meta.last_push_ms,
            last_pull_ms: meta.last_pull_ms,
        })
    }

    pub fn set_auto_sync(app: &AppHandle, enabled: bool) -> Result<(), String> {
        let mut meta = read_meta(app);
        meta.auto_sync = enabled;
        write_meta(app, &meta)
    }

    pub async fn auth_start(app: &AppHandle, state: &GdriveState) -> Result<GdriveStatus, String> {
        let oauth = oauth_client(app).ok_or(
            "No Google OAuth client configured. See src-tauri/src/gdrive.rs for setup \
             (a gdrive_client.json in the app data dir, or BALAUDECK_GOOGLE_* env vars).",
        )?;
        #[cfg(not(target_os = "ios"))]
        {
            auth_start_loopback(app, state, &oauth).await
        }
        #[cfg(target_os = "ios")]
        {
            auth_start_deeplink(app, state, &oauth).await
        }
    }

    fn build_auth_url(client_id: &str, redirect: &str, challenge: &str, csrf: &str) -> String {
        format!(
            "{AUTH_ENDPOINT}?client_id={}&redirect_uri={}&response_type=code&scope={}\
             &code_challenge={}&code_challenge_method=S256&state={}\
             &access_type=offline&prompt=consent",
            enc(client_id),
            enc(redirect),
            enc(SCOPES),
            enc(challenge),
            enc(csrf),
        )
    }

    /// Desktop: open the browser, catch the redirect on a loopback port, exchange.
    #[cfg(not(target_os = "ios"))]
    async fn auth_start_loopback(
        app: &AppHandle,
        state: &GdriveState,
        oauth: &OauthClient,
    ) -> Result<GdriveStatus, String> {
        // Loopback listener on an ephemeral port. Google's installed-app flow
        // matches http://127.0.0.1 loopback redirects regardless of port.
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("bind loopback: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("loopback addr: {e}"))?
            .port();
        let redirect = format!("http://127.0.0.1:{port}");

        let verifier = rand_b64url(32);
        let challenge = s256_b64url(&verifier);
        let csrf = rand_b64url(16);
        let auth_url = build_auth_url(&oauth.id, &redirect, &challenge, &csrf);

        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(auth_url, None::<String>)
            .map_err(|e| format!("open browser: {e}"))?;

        let code = wait_for_code(listener, &csrf).await?;

        let client = http_client()?;
        let tokens = exchange_code(&client, &code, &redirect, &verifier, oauth).await?;
        let refresh = tokens
            .refresh_token
            .ok_or("Google did not return a refresh token — try disconnecting the app from your Google account and reconnecting.")?;
        profiles::set_secret(KIND, REFRESH_ID, REFRESH_SLOT, Some(&refresh))?;

        // Cache the fresh access token so the first push/pull skips a refresh.
        store_access(state, &tokens.access_token, tokens.expires_in);

        let email = fetch_email(&client, &tokens.access_token).await.ok();
        let mut meta = read_meta(app);
        meta.email = email;
        write_meta(app, &meta)?;

        status(app)
    }

    /// iOS: open Safari with a custom-scheme (reversed-client-id) redirect; the
    /// code returns later through `complete_deep_link`. Returns immediately.
    #[cfg(target_os = "ios")]
    async fn auth_start_deeplink(
        app: &AppHandle,
        state: &GdriveState,
        oauth: &OauthClient,
    ) -> Result<GdriveStatus, String> {
        let redirect = ios_redirect(&oauth.id);
        let verifier = rand_b64url(32);
        let challenge = s256_b64url(&verifier);
        let csrf = rand_b64url(16);
        let auth_url = build_auth_url(&oauth.id, &redirect, &challenge, &csrf);

        if let Ok(mut p) = state.pending.lock() {
            *p = Some(PendingAuth {
                verifier,
                csrf,
                redirect,
            });
        }

        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(auth_url, None::<String>)
            .map_err(|e| format!("open browser: {e}"))?;

        // Not connected yet — the deep-link callback finishes it and emits
        // `gdrive://auth`, which the Sync UI listens for.
        status(app)
    }

    /// iOS reversed-client-id redirect (Google's convention for iOS clients),
    /// e.g. `com.googleusercontent.apps.<id>:/oauth2redirect`.
    #[cfg(target_os = "ios")]
    fn ios_redirect(client_id: &str) -> String {
        let core = client_id
            .strip_suffix(".apps.googleusercontent.com")
            .unwrap_or(client_id);
        format!("com.googleusercontent.apps.{core}:/oauth2redirect")
    }

    /// iOS PKCE state held between `auth_start` and the deep-link callback.
    #[cfg(target_os = "ios")]
    pub(super) struct PendingAuth {
        verifier: String,
        csrf: String,
        redirect: String,
    }

    /// iOS: finish the OAuth exchange when the redirect returns via the URL
    /// scheme, then emit `gdrive://auth` so the Sync UI can refresh.
    #[cfg(target_os = "ios")]
    pub(super) async fn complete_deep_link(app: &AppHandle, url: &str) -> Result<(), String> {
        use tauri::{Emitter, Manager};

        // Take the pending flow synchronously; if none, this isn't our redirect.
        let pending = {
            let state = app.state::<GdriveState>();
            let taken = state.pending.lock().ok().and_then(|mut p| p.take());
            taken
        };
        let Some(pending) = pending else {
            return Ok(());
        };
        let params = parse_query(url);

        let outcome: Result<Option<String>, String> = async {
            if !params.iter().any(|(k, v)| k == "state" && *v == pending.csrf) {
                return Err("OAuth state mismatch — please try connecting again.".into());
            }
            if let Some((_, e)) = params.iter().find(|(k, _)| k == "error") {
                return Err(format!("Google sign-in failed: {e}"));
            }
            let code = params
                .iter()
                .find(|(k, _)| k == "code")
                .map(|(_, v)| v.clone())
                .ok_or("no authorization code in redirect")?;
            let oauth = oauth_client(app).ok_or("No Google OAuth client configured.")?;
            let client = http_client()?;
            let tokens =
                exchange_code(&client, &code, &pending.redirect, &pending.verifier, &oauth).await?;
            let refresh = tokens.refresh_token.ok_or(
                "Google did not return a refresh token — remove BalauDeck from your Google \
                 account's third-party access and reconnect.",
            )?;
            profiles::set_secret(KIND, REFRESH_ID, REFRESH_SLOT, Some(&refresh))?;
            {
                let state = app.state::<GdriveState>();
                store_access(state.inner(), &tokens.access_token, tokens.expires_in);
            }
            let email = fetch_email(&client, &tokens.access_token).await.ok();
            let mut meta = read_meta(app);
            meta.email = email.clone();
            write_meta(app, &meta)?;
            Ok(email)
        }
        .await;

        #[derive(serde::Serialize, Clone)]
        struct AuthEvent {
            connected: bool,
            email: Option<String>,
            error: Option<String>,
        }
        let payload = match &outcome {
            Ok(email) => AuthEvent {
                connected: true,
                email: email.clone(),
                error: None,
            },
            Err(e) => AuthEvent {
                connected: false,
                email: None,
                error: Some(e.clone()),
            },
        };
        let _ = app.emit("gdrive://auth", payload);
        outcome.map(|_| ())
    }

    pub async fn disconnect(app: &AppHandle, state: &GdriveState) -> Result<(), String> {
        if let Ok(Some(rt)) = refresh_token() {
            // Best-effort revoke; ignore network/HTTP failures.
            if let Ok(client) = http_client() {
                let _ = client
                    .post(REVOKE_ENDPOINT)
                    .form(&[("token", rt.as_str())])
                    .send()
                    .await;
            }
        }
        let _ = profiles::set_secret(KIND, REFRESH_ID, REFRESH_SLOT, None);
        let _ = profiles::set_secret(KIND, PASS_ID, PASS_SLOT, None);
        if let Ok(mut c) = state.inner.lock() {
            *c = TokenCache::default();
        }
        // Wipe metadata (email/timestamps); keep the file absent-equivalent.
        let _ = write_meta(app, &SyncMeta::default());
        Ok(())
    }

    /// Locking wrapper — serializes against other push/pull ops.
    pub async fn sync_push(
        app: &AppHandle,
        state: &GdriveState,
        passphrase: &str,
    ) -> Result<i64, String> {
        let _guard = state.op_lock.lock().await;
        sync_push_inner(app, state, passphrase).await
    }

    async fn sync_push_inner(
        app: &AppHandle,
        state: &GdriveState,
        passphrase: &str,
    ) -> Result<i64, String> {
        let pass = passphrase.trim();
        if pass.is_empty() {
            return Err("passphrase required".into());
        }
        // Reuse the exact encrypted bundle the manual export produces.
        let bundle = profiles::connections_export(app.clone(), pass.to_string())?;

        let client = http_client()?;
        let token = ensure_token(app, state, &client).await?;
        let folder = ensure_folder(&client, &token).await?;
        let file_id = match find_file(&client, &token, &folder).await? {
            Some(id) => id,
            None => create_file(&client, &token, &folder).await?,
        };
        upload_media(&client, &token, &file_id, bundle).await?;

        // Cache the passphrase so auto-sync can run unattended.
        profiles::set_secret(KIND, PASS_ID, PASS_SLOT, Some(pass))?;
        let now = now_ms();
        let mut meta = read_meta(app);
        meta.last_push_ms = now;
        write_meta(app, &meta)?;
        Ok(now)
    }

    /// Locking wrapper — serializes against other push/pull ops.
    pub async fn sync_pull(
        app: &AppHandle,
        state: &GdriveState,
        passphrase: &str,
    ) -> Result<profiles::ImportSummary, String> {
        let _guard = state.op_lock.lock().await;
        sync_pull_inner(app, state, passphrase).await
    }

    async fn sync_pull_inner(
        app: &AppHandle,
        state: &GdriveState,
        passphrase: &str,
    ) -> Result<profiles::ImportSummary, String> {
        let pass = passphrase.trim();
        if pass.is_empty() {
            return Err("passphrase required".into());
        }
        let client = http_client()?;
        let token = ensure_token(app, state, &client).await?;
        let folder = ensure_folder(&client, &token).await?;
        let file_id = find_file(&client, &token, &folder)
            .await?
            .ok_or("No backup found in your Google Drive yet — push from another device (or this one) first.")?;
        let content = download_media(&client, &token, &file_id).await?;

        let summary = profiles::connections_import(app.clone(), pass.to_string(), content)?;
        profiles::set_secret(KIND, PASS_ID, PASS_SLOT, Some(pass))?;
        let mut meta = read_meta(app);
        meta.last_pull_ms = now_ms();
        write_meta(app, &meta)?;
        Ok(summary)
    }

    pub async fn auto_push(app: &AppHandle, state: &GdriveState) -> Result<Option<i64>, String> {
        let _guard = state.op_lock.lock().await;
        if !read_meta(app).auto_sync || refresh_token()?.is_none() {
            return Ok(None);
        }
        let Some(pass) = cached_passphrase()? else {
            return Ok(None);
        };
        Ok(Some(sync_push_inner(app, state, &pass).await?))
    }

    pub async fn auto_pull(
        app: &AppHandle,
        state: &GdriveState,
    ) -> Result<Option<profiles::ImportSummary>, String> {
        // Hold the op lock across the throttle check + pull so two concurrent
        // launches can't both slip past the throttle and pull at once.
        let _guard = state.op_lock.lock().await;
        let meta = read_meta(app);
        if !meta.auto_sync || refresh_token()?.is_none() {
            return Ok(None);
        }
        // Throttle: skip if we pulled within the window.
        if meta.last_pull_ms > 0 && now_ms() - meta.last_pull_ms < PULL_THROTTLE_MS {
            return Ok(None);
        }
        let Some(pass) = cached_passphrase()? else {
            return Ok(None);
        };
        // Best-effort: swallow soft failures (offline, no remote file) so a
        // launch is never blocked or noisy.
        Ok(sync_pull_inner(app, state, &pass).await.ok())
    }

    // ---- OAuth token handling -----------------------------------------------

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        #[serde(default)]
        expires_in: i64,
        #[serde(default)]
        refresh_token: Option<String>,
    }

    fn store_access(state: &GdriveState, token: &str, expires_in: i64) {
        if let Ok(mut c) = state.inner.lock() {
            c.access_token = Some(token.to_string());
            // Refresh a minute early to avoid edge-of-expiry 401s. Saturating +
            // clamped so an absurdly small expires_in can't underflow into a
            // past/negative timestamp (which would wedge the cache as "expired").
            let ttl_ms = expires_in
                .max(0)
                .saturating_mul(1000)
                .saturating_sub(60_000)
                .max(0);
            c.expires_at_ms = now_ms().saturating_add(ttl_ms);
        }
    }

    async fn ensure_token(
        app: &AppHandle,
        state: &GdriveState,
        client: &reqwest::Client,
    ) -> Result<String, String> {
        if let Ok(c) = state.inner.lock() {
            if let Some(t) = &c.access_token {
                if c.expires_at_ms > now_ms() {
                    return Ok(t.clone());
                }
            }
        }
        let oauth = oauth_client(app).ok_or("No Google OAuth client configured.")?;
        let refresh = refresh_token()?.ok_or("Not connected to Google Drive.")?;
        let form = token_form(
            &oauth,
            vec![
                ("refresh_token", refresh.as_str()),
                ("grant_type", "refresh_token"),
            ],
        );
        let resp = client
            .post(TOKEN_ENDPOINT)
            .form(&form)
            .send()
            .await
            .map_err(|e| format!("token refresh: {e}"))?;
        let tokens: TokenResponse = json_ok(resp).await?;
        store_access(state, &tokens.access_token, tokens.expires_in);
        Ok(tokens.access_token)
    }

    async fn exchange_code(
        client: &reqwest::Client,
        code: &str,
        redirect: &str,
        verifier: &str,
        oauth: &OauthClient,
    ) -> Result<TokenResponse, String> {
        let form = token_form(
            oauth,
            vec![
                ("code", code),
                ("code_verifier", verifier),
                ("grant_type", "authorization_code"),
                ("redirect_uri", redirect),
            ],
        );
        let resp = client
            .post(TOKEN_ENDPOINT)
            .form(&form)
            .send()
            .await
            .map_err(|e| format!("token exchange: {e}"))?;
        json_ok(resp).await
    }

    async fn fetch_email(client: &reqwest::Client, access: &str) -> Result<String, String> {
        #[derive(Deserialize)]
        struct UserInfo {
            #[serde(default)]
            email: Option<String>,
        }
        let resp = client
            .get(USERINFO_ENDPOINT)
            .bearer_auth(access)
            .send()
            .await
            .map_err(|e| format!("userinfo: {e}"))?;
        let info: UserInfo = json_ok(resp).await?;
        info.email.ok_or_else(|| "no email in userinfo".into())
    }

    // ---- Drive REST ---------------------------------------------------------

    async fn ensure_folder(client: &reqwest::Client, token: &str) -> Result<String, String> {
        let q = format!(
            "mimeType='{DRIVE_FOLDER_MIME}' and name='{FOLDER_NAME}' and trashed=false"
        );
        if let Some(id) = query_first_id(client, token, &q).await? {
            return Ok(id);
        }
        #[derive(Serialize)]
        struct NewFolder<'a> {
            name: &'a str,
            #[serde(rename = "mimeType")]
            mime_type: &'a str,
        }
        let resp = client
            .post(DRIVE_FILES)
            .bearer_auth(token)
            .json(&NewFolder {
                name: FOLDER_NAME,
                mime_type: DRIVE_FOLDER_MIME,
            })
            .send()
            .await
            .map_err(|e| format!("create folder: {e}"))?;
        let file: DriveFile = json_ok(resp).await?;
        Ok(file.id)
    }

    async fn find_file(
        client: &reqwest::Client,
        token: &str,
        folder_id: &str,
    ) -> Result<Option<String>, String> {
        let q = format!("name='{FILE_NAME}' and '{folder_id}' in parents and trashed=false");
        query_first_id(client, token, &q).await
    }

    async fn create_file(
        client: &reqwest::Client,
        token: &str,
        folder_id: &str,
    ) -> Result<String, String> {
        #[derive(Serialize)]
        struct NewFile<'a> {
            name: &'a str,
            parents: [&'a str; 1],
        }
        let resp = client
            .post(DRIVE_FILES)
            .bearer_auth(token)
            .json(&NewFile {
                name: FILE_NAME,
                parents: [folder_id],
            })
            .send()
            .await
            .map_err(|e| format!("create file: {e}"))?;
        let file: DriveFile = json_ok(resp).await?;
        Ok(file.id)
    }

    async fn upload_media(
        client: &reqwest::Client,
        token: &str,
        file_id: &str,
        body: String,
    ) -> Result<(), String> {
        let url = format!("{DRIVE_UPLOAD}/{file_id}?uploadType=media");
        let resp = client
            .patch(url)
            .bearer_auth(token)
            .header("Content-Type", "text/plain")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("upload: {e}"))?;
        let _: DriveFile = json_ok(resp).await?;
        Ok(())
    }

    async fn download_media(
        client: &reqwest::Client,
        token: &str,
        file_id: &str,
    ) -> Result<String, String> {
        let url = format!("{DRIVE_FILES}/{file_id}?alt=media");
        let resp = client
            .get(url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("download: {e}"))?;
        // Check status before pulling the whole body into memory.
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Google Drive download {status}: {text}"));
        }
        resp.text().await.map_err(|e| format!("download body: {e}"))
    }

    #[derive(Deserialize)]
    struct DriveFile {
        id: String,
    }

    #[derive(Deserialize)]
    struct FileList {
        #[serde(default)]
        files: Vec<DriveFile>,
    }

    async fn query_first_id(
        client: &reqwest::Client,
        token: &str,
        q: &str,
    ) -> Result<Option<String>, String> {
        let resp = client
            .get(DRIVE_FILES)
            .bearer_auth(token)
            .query(&[
                ("q", q),
                ("spaces", "drive"),
                ("fields", "files(id)"),
                ("pageSize", "1"),
            ])
            .send()
            .await
            .map_err(|e| format!("drive query: {e}"))?;
        let list: FileList = json_ok(resp).await?;
        Ok(list.files.into_iter().next().map(|f| f.id))
    }

    // ---- Helpers ------------------------------------------------------------

    fn http_client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("http client: {e}"))
    }

    async fn json_ok<T: serde::de::DeserializeOwned>(resp: reqwest::Response) -> Result<T, String> {
        let status = resp.status();
        let text = resp.text().await.map_err(|e| format!("read body: {e}"))?;
        if !status.is_success() {
            // Translate the common OAuth failure (revoked/expired refresh token)
            // into an actionable message instead of raw API JSON.
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if v.get("error").and_then(|e| e.as_str()) == Some("invalid_grant") {
                    return Err("Your Google session expired or was revoked. Disconnect and reconnect Google Drive in the Sync window.".into());
                }
            }
            return Err(format!("Google API {status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| format!("parse response ({e}): {text}"))
    }

    fn enc(s: &str) -> String {
        urlencoding::encode(s).into_owned()
    }

    fn rand_b64url(len: usize) -> String {
        use base64::Engine;
        let mut buf = vec![0u8; len];
        // getrandom is already a dependency and is used for the bundle nonce.
        let _ = getrandom::getrandom(&mut buf);
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
    }

    fn s256_b64url(input: &str) -> String {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(input.as_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(h.finalize())
    }

    /// Accept loopback connections until one carries the OAuth `code` (verifying
    /// `state`) or an `error`, then reply with a small "you can close this tab"
    /// page. Times out after 5 minutes so a cancelled sign-in can't hang.
    #[cfg(not(target_os = "ios"))]
    async fn wait_for_code(listener: TcpListener, csrf: &str) -> Result<String, String> {
        let deadline = Duration::from_secs(300);
        let accept = async {
            loop {
                let (mut sock, _) = listener
                    .accept()
                    .await
                    .map_err(|e| format!("accept: {e}"))?;

                // Read until we have the full request line (ends at the first
                // CRLF) — the OAuth code/state live in that line's query string,
                // and a single read() could split it across TCP segments.
                let mut buf = Vec::with_capacity(1024);
                let mut tmp = [0u8; 1024];
                loop {
                    match sock.read(&mut tmp).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&tmp[..n]);
                            if buf.windows(2).any(|w| w == b"\r\n") || buf.len() > 8192 {
                                break;
                            }
                        }
                    }
                }
                let head = String::from_utf8_lossy(&buf);
                let target = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("");

                let params = parse_query(target);
                let is_oauth = params.iter().any(|(k, _)| k == "code" || k == "error");
                if !is_oauth {
                    // Ignore stray hits (favicon, etc.) and keep listening.
                    let _ = respond(&mut sock, "Waiting for Google sign-in…").await;
                    continue;
                }

                let ok = params.iter().any(|(k, v)| k == "state" && v == csrf);
                let result = if !ok {
                    Err("OAuth state mismatch — please try connecting again.".to_string())
                } else if let Some((_, err)) = params.iter().find(|(k, _)| k == "error") {
                    Err(format!("Google sign-in failed: {err}"))
                } else if let Some((_, code)) = params.iter().find(|(k, _)| k == "code") {
                    Ok(code.clone())
                } else {
                    Err("no authorization code in redirect".to_string())
                };

                let page = if result.is_ok() {
                    "BalauDeck is connected to Google Drive. You can close this tab and return to the app."
                } else {
                    "BalauDeck sign-in did not complete. You can close this tab and try again in the app."
                };
                let _ = respond(&mut sock, page).await;
                return result;
            }
        };
        match tokio::time::timeout(deadline, accept).await {
            Ok(r) => r,
            Err(_) => Err("Timed out waiting for Google sign-in.".into()),
        }
    }

    #[cfg(not(target_os = "ios"))]
    async fn respond(sock: &mut tokio::net::TcpStream, message: &str) -> std::io::Result<()> {
        let body = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\">\
             <title>BalauDeck</title></head>\
             <body style=\"font-family:-apple-system,system-ui,sans-serif;\
             background:#0b0f12;color:#e6edf3;display:flex;height:100vh;margin:0;\
             align-items:center;justify-content:center;text-align:center\">\
             <div style=\"max-width:28rem;padding:2rem\"><h2>BalauDeck</h2>\
             <p>{message}</p></div></body></html>"
        );
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        sock.write_all(resp.as_bytes()).await?;
        sock.flush().await
    }

    /// Parse `foo?a=b&c=d` (URL-decoded) into (key, value) pairs.
    fn parse_query(target: &str) -> Vec<(String, String)> {
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
        query
            .split('&')
            .filter(|s| !s.is_empty())
            .map(|pair| {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                (
                    urlencoding::decode(k).map(|c| c.into_owned()).unwrap_or_default(),
                    urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default(),
                )
            })
            .collect()
    }
}
