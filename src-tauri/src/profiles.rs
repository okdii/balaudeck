//! Connection profiles (SSH + DB) persisted as JSON in the app data dir,
//! with secrets stored separately in the OS keychain via `keyring`.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "com.okdii.balaudeck";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    Password,
    Key,
}

impl Default for SshAuth {
    fn default() -> Self {
        SshAuth::Password
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// "ssh" or "db" — which sidebar section the folder belongs to.
    pub kind: String,
    /// Parent folder id for nesting; None = top level of the section.
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SshProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    /// Optional jump host: another SSH profile to reach this host through.
    #[serde(default)]
    pub jump_profile_id: Option<String>,
    /// Inline (manual) jump host, used when `jump_profile_id` is empty.
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_user: Option<String>,
    #[serde(default)]
    pub jump_auth: Option<SshAuth>,
    /// "nested" = run `ssh` on the jump host to reach the target (for bastions
    /// that disable TCP forwarding); None/other = port-forward (ProxyJump).
    #[serde(default)]
    pub jump_mode: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    /// Start the shell inside `tmux new-session -A` so the session survives
    /// drops and a reconnect re-attaches the same shell.
    #[serde(default)]
    pub tmux: bool,
    /// tmux session name (sanitized server-side); blank = a per-host default.
    #[serde(default)]
    pub tmux_session: Option<String>,
    /// Add `-v` to the nested-jump ssh command for verbose diagnostics.
    #[serde(default)]
    pub verbose: bool,
    /// A command sent once the shell is ready (e.g. `sudo su -`). Any matching
    /// escalation password lives in the keychain slot "escalate_password" and is
    /// auto-sent when the shell prompts for it.
    #[serde(default)]
    pub after_login: Option<String>,
}

/// Default DB engine for profiles saved before multi-engine support (and for any
/// entry missing the field) — keeps every existing profiles.json loading as MySQL.
pub fn default_engine() -> String {
    "mysql".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DbProfile {
    pub id: String,
    pub name: String,
    /// "mysql" | "mariadb" | "postgres" | "mssql" | "sqlite" | "mongodb" | "redis" | "s3".
    #[serde(default = "default_engine")]
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub database: Option<String>,
    /// SQLite database file path (engine == "sqlite"); host/port/user are unused then.
    #[serde(default)]
    pub file: Option<String>,
    /// S3-only: signing region; blank/None means "us-east-1".
    #[serde(default)]
    pub region: Option<String>,
    /// S3-only: path-style addressing (default true — MinIO/RustFS/IP endpoints).
    #[serde(default)]
    pub path_style: Option<bool>,
    /// S3-only: connect over HTTPS instead of plain HTTP (default false).
    #[serde(default)]
    pub tls: Option<bool>,
    /// When set, connect through this SSH profile's tunnel.
    #[serde(default)]
    pub via_ssh_profile_id: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
}

/// A saved SFTP connection. Shares the SSH credential model; secrets live in the
/// keychain under the "ssh" kind so the shared SSH connect path resolves them.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SftpProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    #[serde(default)]
    pub jump_profile_id: Option<String>,
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_user: Option<String>,
    #[serde(default)]
    pub jump_auth: Option<SshAuth>,
    #[serde(default)]
    pub folder_id: Option<String>,
    /// Optional command to run instead of requesting the standard `sftp`
    /// subsystem (e.g. `sudo /usr/lib/openssh/sftp-server`) so the server side
    /// runs elevated. Empty/None = standard subsystem.
    #[serde(default)]
    pub sftp_command: Option<String>,
}

/// A saved SSH tunnel: SSH credentials plus the remote target to forward.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TunnelProfile {
    pub id: String,
    pub name: String,
    /// When set, forward through this saved SSH host instead of the inline
    /// host/user/auth below (which are then just a cached copy for display).
    #[serde(default)]
    pub ssh_profile_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    #[serde(default)]
    pub jump_profile_id: Option<String>,
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_user: Option<String>,
    #[serde(default)]
    pub jump_auth: Option<SshAuth>,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub local_port: Option<u16>,
    /// Forwarding mode: "local" (-L, default) | "dynamic" (-D SOCKS) |
    /// "remote" (-R). Optional so profiles saved before modes existed load
    /// unchanged (the frontend treats None as "local").
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ProfileStore {
    #[serde(default)]
    pub ssh: Vec<SshProfile>,
    #[serde(default)]
    pub db: Vec<DbProfile>,
    #[serde(default)]
    pub sftp: Vec<SftpProfile>,
    #[serde(default)]
    pub tunnel: Vec<TunnelProfile>,
    #[serde(default)]
    pub folders: Vec<Folder>,
    #[serde(default)]
    pub queries: Vec<SavedQuery>,
    #[serde(default)]
    pub notes: Vec<Note>,
}

/// A saved SQL snippet, scoped to a DB profile + database.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub db_profile_id: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
}

/// A free-form Markdown note shown in the sidebar.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    /// Epoch milliseconds of the last edit; used to sort most-recent first.
    #[serde(default)]
    pub updated_at: i64,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
    Ok(dir.join("profiles.json"))
}

fn read_store(app: &AppHandle) -> Result<ProfileStore, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(ProfileStore::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read profiles: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse profiles: {e}"))
}

fn write_store(app: &AppHandle, store: &ProfileStore) -> Result<(), String> {
    let path = store_path(app)?;
    let raw = serde_json::to_string_pretty(store).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("write profiles: {e}"))
}

// ---- Keychain helpers -------------------------------------------------------

fn keychain_account(kind: &str, id: &str, slot: &str) -> String {
    format!("{kind}:{id}:{slot}")
}

/// Store a secret by its full keychain account string, or delete when None.
fn set_secret_raw(account: &str, value: Option<&str>) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| format!("keychain: {e}"))?;
        match value {
            Some(v) if !v.is_empty() => {
                entry.set_password(v).map_err(|e| format!("keychain set: {e}"))
            }
            _ => match entry.delete_credential() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(format!("keychain delete: {e}")),
            },
        }
    }
    #[cfg(target_os = "android")]
    {
        android_secrets::set(account, value.filter(|v| !v.is_empty()))
    }
}

/// Read a secret by its full keychain account string.
fn get_secret_raw(account: &str) -> Result<Option<String>, String> {
    #[cfg(not(target_os = "android"))]
    {
        let entry =
            keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|e| format!("keychain: {e}"))?;
        match entry.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keychain get: {e}")),
        }
    }
    #[cfg(target_os = "android")]
    {
        android_secrets::get(account)
    }
}

/// Store a secret, or delete it when `value` is None.
pub fn set_secret(kind: &str, id: &str, slot: &str, value: Option<&str>) -> Result<(), String> {
    set_secret_raw(&keychain_account(kind, id, slot), value)
}

#[allow(dead_code)] // used by connect-by-profile in Fasa 2/5
pub fn get_secret(kind: &str, id: &str, slot: &str) -> Result<Option<String>, String> {
    get_secret_raw(&keychain_account(kind, id, slot))
}

/// Android has no `keyring` backend, so secrets live in a file in the app's
/// private data dir — encrypted with AES-256-GCM under a hardware-backed key
/// held in the Android Keystore (the key is non-extractable, so the file is
/// unreadable even on a rooted device). The Keystore work is done by the
/// `SecretCrypto` Kotlin helper, reached over JNI. Initialized at startup with
/// the data-dir path (see lib.rs setup).
#[cfg(target_os = "android")]
mod android_secrets {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    static DIR: OnceLock<PathBuf> = OnceLock::new();
    static LOCK: Mutex<()> = Mutex::new(());
    /// JavaVM captured at library-load time in [`JNI_OnLoad`]. Needed to reach
    /// the `SecretCrypto` Kotlin helper from any thread.
    static JVM: OnceLock<jni::JavaVM> = OnceLock::new();
    /// `SecretCrypto` class, resolved + cached in [`JNI_OnLoad`]. A natively-
    /// attached thread's `FindClass` uses the system class loader and can't see
    /// app classes, so we must resolve it here (app class-loader context) and
    /// keep a global ref.
    static CRYPTO_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();

    /// Header on the encrypted store. Legacy plaintext `secrets.json` files lack
    /// it and are migrated to the encrypted store on first read.
    const MAGIC: &[u8] = b"BDK1";

    /// Called by the JVM when our native library is loaded (`System.loadLibrary`).
    /// tao/wry don't define this, so it's ours to capture the VM and resolve the
    /// `SecretCrypto` class against the app class loader. The Android Keystore +
    /// Cipher APIs need no Context, so the VM + class are enough.
    #[no_mangle]
    pub extern "system" fn JNI_OnLoad(
        vm: *mut jni::sys::JavaVM,
        _reserved: *mut std::ffi::c_void,
    ) -> jni::sys::jint {
        if let Ok(vm) = unsafe { jni::JavaVM::from_raw(vm) } {
            if let Ok(mut env) = vm.get_env() {
                if let Ok(class) = env.find_class("com/okdii/balaudeck/SecretCrypto") {
                    if let Ok(g) = env.new_global_ref(class) {
                        let _ = CRYPTO_CLASS.set(g);
                    }
                }
            }
            let _ = JVM.set(vm);
        }
        jni::sys::JNI_VERSION_1_6
    }

    pub fn set_dir(dir: PathBuf) {
        let _ = DIR.set(dir);
    }
    fn dir() -> PathBuf {
        DIR.get().cloned().unwrap_or_else(std::env::temp_dir)
    }
    fn enc_path() -> PathBuf {
        dir().join("secrets.bin")
    }
    fn legacy_path() -> PathBuf {
        dir().join("secrets.json")
    }

    /// Invoke the hardware-backed `SecretCrypto` Kotlin helper over JNI.
    /// `method` is "encrypt" or "decrypt"; both take and return a `byte[]`.
    fn keystore(method: &str, input: &[u8]) -> Result<Vec<u8>, String> {
        use jni::objects::{JByteArray, JObject, JValue};
        let vm = JVM.get().ok_or("jni vm not initialized")?;
        let class = CRYPTO_CLASS.get().ok_or("SecretCrypto class not found")?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("jni attach: {e}"))?;
        let arg = env
            .byte_array_from_slice(input)
            .map_err(|e| format!("jni arg: {e}"))?;
        let arg_obj = unsafe { JObject::from_raw(arg.into_raw()) };
        let res = env.call_static_method(class, method, "([B)[B", &[JValue::Object(&arg_obj)]);
        // Clear any pending Java exception (e.g. a Cipher failure) so it can't
        // abort the next JNI call made on this thread.
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        let out_obj = res
            .map_err(|e| format!("jni {method}: {e}"))?
            .l()
            .map_err(|e| format!("jni ret: {e}"))?;
        let out = unsafe { JByteArray::from_raw(out_obj.into_raw()) };
        env.convert_byte_array(out)
            .map_err(|e| format!("jni bytes: {e}"))
    }

    fn load() -> BTreeMap<String, String> {
        // Preferred path: the encrypted store.
        if let Ok(raw) = std::fs::read(enc_path()) {
            if raw.len() > MAGIC.len() && &raw[..MAGIC.len()] == MAGIC {
                // Undecryptable (e.g. Keystore key invalidated/reset) → start
                // empty rather than crash; the user re-enters credentials.
                return keystore("decrypt", &raw[MAGIC.len()..])
                    .ok()
                    .and_then(|p| serde_json::from_slice(&p).ok())
                    .unwrap_or_default();
            }
        }
        // Legacy plaintext store: migrate into the encrypted store, then delete
        // the plaintext copy. If encryption fails, keep plaintext so nothing is
        // lost — migration is retried on the next write.
        if let Ok(bytes) = std::fs::read(legacy_path()) {
            if let Ok(map) = serde_json::from_slice::<BTreeMap<String, String>>(&bytes) {
                if save(&map).is_ok() {
                    let _ = std::fs::remove_file(legacy_path());
                }
                return map;
            }
        }
        BTreeMap::new()
    }

    fn save(map: &BTreeMap<String, String>) -> Result<(), String> {
        let json = serde_json::to_vec(map).map_err(|e| e.to_string())?;
        let enc = keystore("encrypt", &json)?;
        let p = enc_path();
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let mut out = Vec::with_capacity(MAGIC.len() + enc.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&enc);
        std::fs::write(&p, out).map_err(|e| format!("write secrets: {e}"))
    }

    pub fn set(account: &str, value: Option<&str>) -> Result<(), String> {
        let _g = LOCK.lock().unwrap();
        let mut map = load();
        match value {
            Some(v) => {
                map.insert(account.to_string(), v.to_string());
            }
            None => {
                map.remove(account);
            }
        }
        save(&map)
    }
    pub fn get(account: &str) -> Result<Option<String>, String> {
        let _g = LOCK.lock().unwrap();
        Ok(load().get(account).cloned())
    }
}

/// Point the Android secret store at the app data dir. No-op elsewhere.
#[cfg(target_os = "android")]
pub fn init_secret_store(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = fs::create_dir_all(&dir);
        android_secrets::set_dir(dir);
    }
}
#[cfg(not(target_os = "android"))]
pub fn init_secret_store(_app: &AppHandle) {}

fn delete_all_secrets(kind: &str, id: &str, slots: &[&str]) {
    for slot in slots {
        let _ = set_secret(kind, id, slot, None);
    }
}

/// Synthetic keychain owner for a profile's inline (manual) jump-host secrets,
/// kept separate from the profile's own credentials.
fn jump_owner(id: &str) -> String {
    format!("{id}~jump")
}

/// Write the password/key/passphrase trio under (kind, owner). Each `Some`
/// value is stored (an empty string clears it); `None` leaves it untouched.
fn store_secrets(
    kind: &str,
    owner: &str,
    password: Option<String>,
    key: Option<String>,
    passphrase: Option<String>,
) -> Result<(), String> {
    if let Some(p) = password {
        set_secret(kind, owner, "password", Some(&p))?;
    }
    if let Some(k) = key {
        set_secret(kind, owner, "key", Some(&k))?;
    }
    if let Some(pp) = passphrase {
        set_secret(kind, owner, "passphrase", Some(&pp))?;
    }
    Ok(())
}

// ---- Commands ---------------------------------------------------------------

#[tauri::command]
pub fn profiles_load(app: AppHandle) -> Result<ProfileStore, String> {
    read_store(&app)
}

/// Whether a non-empty secret is stored for (kind, id, slot). Lets the UI show a
/// "saved" hint for a never-prefilled field without exposing the value itself.
#[tauri::command]
pub fn secret_exists(kind: String, id: String, slot: String) -> bool {
    matches!(get_secret(&kind, &id, &slot), Ok(Some(v)) if !v.is_empty())
}

/// Read a local text file (used to import a private key file picked via dialog).
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read file: {e}"))
}

/// Upsert an SSH profile. `password`/`key`/`passphrase` are optional secrets:
/// `Some("")` clears, `None` leaves an existing secret untouched.
#[tauri::command]
pub fn ssh_profile_save(
    app: AppHandle,
    mut profile: SshProfile,
    password: Option<String>,
    key: Option<String>,
    passphrase: Option<String>,
    jump_password: Option<String>,
    jump_key: Option<String>,
    jump_passphrase: Option<String>,
    escalate_password: Option<String>,
) -> Result<SshProfile, String> {
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    let mut store = read_store(&app)?;
    if let Some(existing) = store.ssh.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile.clone();
    } else {
        store.ssh.push(profile.clone());
    }
    write_store(&app, &store)?;

    store_secrets("ssh", &profile.id, password, key, passphrase)?;
    store_secrets(
        "ssh",
        &jump_owner(&profile.id),
        jump_password,
        jump_key,
        jump_passphrase,
    )?;
    // Escalation password (after-login `sudo su -` etc.): Some("") clears, None
    // leaves any saved one untouched — same convention as the credential trio.
    if let Some(ep) = escalate_password {
        set_secret("ssh", &profile.id, "escalate_password", Some(&ep))?;
    }
    Ok(profile)
}

#[tauri::command]
pub fn ssh_profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.ssh.retain(|p| p.id != id);
    write_store(&app, &store)?;
    delete_all_secrets("ssh", &id, &["password", "key", "passphrase", "escalate_password"]);
    delete_all_secrets("ssh", &jump_owner(&id), &["password", "key", "passphrase"]);
    Ok(())
}

#[tauri::command]
pub fn db_profile_save(
    app: AppHandle,
    mut profile: DbProfile,
    password: Option<String>,
) -> Result<DbProfile, String> {
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    let mut store = read_store(&app)?;
    if let Some(existing) = store.db.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile.clone();
    } else {
        store.db.push(profile.clone());
    }
    write_store(&app, &store)?;

    if let Some(p) = password {
        set_secret("db", &profile.id, "password", Some(&p))?;
    }
    Ok(profile)
}

#[tauri::command]
pub fn db_profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.db.retain(|p| p.id != id);
    write_store(&app, &store)?;
    delete_all_secrets("db", &id, &["password"]);
    Ok(())
}

/// Upsert an SFTP profile. Secrets are stored under the "ssh" keychain kind so
/// the shared SSH connect path (`resolve_secret`) finds them via `profile_id`.
#[tauri::command]
pub fn sftp_profile_save(
    app: AppHandle,
    mut profile: SftpProfile,
    password: Option<String>,
    key: Option<String>,
    passphrase: Option<String>,
    jump_password: Option<String>,
    jump_key: Option<String>,
    jump_passphrase: Option<String>,
    // When set and no inline secret is given, copy credentials from this SSH
    // profile's keychain entry, so an SFTP profile based on a saved SSH host
    // works without re-entering the password/key.
    copy_secret_from: Option<String>,
    // Optional sudo password for an elevated `sftp_command` (stored in the
    // keychain; None leaves any existing value untouched).
    sudo_password: Option<String>,
) -> Result<SftpProfile, String> {
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    let mut store = read_store(&app)?;
    if let Some(existing) = store.sftp.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile.clone();
    } else {
        store.sftp.push(profile.clone());
    }
    write_store(&app, &store)?;

    let has_inline = password.is_some() || key.is_some() || passphrase.is_some();
    store_secrets("ssh", &profile.id, password, key, passphrase)?;
    if let Some(sp) = &sudo_password {
        if !sp.is_empty() {
            set_secret("ssh", &profile.id, "sudo_password", Some(sp))?;
        }
    }
    store_secrets(
        "ssh",
        &jump_owner(&profile.id),
        jump_password,
        jump_key,
        jump_passphrase,
    )?;
    if let Some(src) = copy_secret_from {
        if !has_inline && src != profile.id {
            for slot in ["password", "key", "passphrase"] {
                if let Ok(Some(v)) = get_secret("ssh", &src, slot) {
                    let _ = set_secret("ssh", &profile.id, slot, Some(&v));
                }
            }
        }
    }
    Ok(profile)
}

#[tauri::command]
pub fn sftp_profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.sftp.retain(|p| p.id != id);
    write_store(&app, &store)?;
    delete_all_secrets("ssh", &id, &["password", "key", "passphrase", "sudo_password"]);
    delete_all_secrets("ssh", &jump_owner(&id), &["password", "key", "passphrase"]);
    Ok(())
}

/// Upsert a tunnel profile. Like SFTP, secrets live under the "ssh" keychain kind.
#[tauri::command]
pub fn tunnel_profile_save(
    app: AppHandle,
    mut profile: TunnelProfile,
    password: Option<String>,
    key: Option<String>,
    passphrase: Option<String>,
    jump_password: Option<String>,
    jump_key: Option<String>,
    jump_passphrase: Option<String>,
) -> Result<TunnelProfile, String> {
    if profile.id.is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }
    let mut store = read_store(&app)?;
    if let Some(existing) = store.tunnel.iter_mut().find(|p| p.id == profile.id) {
        *existing = profile.clone();
    } else {
        store.tunnel.push(profile.clone());
    }
    write_store(&app, &store)?;

    store_secrets("ssh", &profile.id, password, key, passphrase)?;
    store_secrets(
        "ssh",
        &jump_owner(&profile.id),
        jump_password,
        jump_key,
        jump_passphrase,
    )?;
    Ok(profile)
}

#[tauri::command]
pub fn tunnel_profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.tunnel.retain(|p| p.id != id);
    write_store(&app, &store)?;
    delete_all_secrets("ssh", &id, &["password", "key", "passphrase"]);
    delete_all_secrets("ssh", &jump_owner(&id), &["password", "key", "passphrase"]);
    Ok(())
}

// ---- Folders ----------------------------------------------------------------

#[tauri::command]
pub fn folder_create(app: AppHandle, name: String, kind: String) -> Result<Folder, String> {
    let folder = Folder {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        kind,
        parent_id: None,
    };
    let mut store = read_store(&app)?;
    store.folders.push(folder.clone());
    write_store(&app, &store)?;
    Ok(folder)
}

#[tauri::command]
pub fn folder_rename(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    if let Some(f) = store.folders.iter_mut().find(|f| f.id == id) {
        f.name = name;
    }
    write_store(&app, &store)
}

/// Delete a folder; its child folders and profiles move up to its parent.
#[tauri::command]
pub fn folder_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    let parent = store
        .folders
        .iter()
        .find(|f| f.id == id)
        .and_then(|f| f.parent_id.clone());
    store.folders.retain(|f| f.id != id);
    for f in store.folders.iter_mut() {
        if f.parent_id.as_deref() == Some(id.as_str()) {
            f.parent_id = parent.clone();
        }
    }
    for p in store.ssh.iter_mut() {
        if p.folder_id.as_deref() == Some(id.as_str()) {
            p.folder_id = parent.clone();
        }
    }
    for p in store.db.iter_mut() {
        if p.folder_id.as_deref() == Some(id.as_str()) {
            p.folder_id = parent.clone();
        }
    }
    for p in store.sftp.iter_mut() {
        if p.folder_id.as_deref() == Some(id.as_str()) {
            p.folder_id = parent.clone();
        }
    }
    for p in store.tunnel.iter_mut() {
        if p.folder_id.as_deref() == Some(id.as_str()) {
            p.folder_id = parent.clone();
        }
    }
    write_store(&app, &store)
}

/// Re-parent and/or reorder a folder. `parent_id` sets nesting (None = root);
/// `before_id` positions it just before that sibling (None = end of the group).
/// Rejects making a folder a child of itself or one of its descendants.
#[tauri::command]
pub fn folder_move(
    app: AppHandle,
    id: String,
    parent_id: Option<String>,
    before_id: Option<String>,
) -> Result<(), String> {
    let mut store = read_store(&app)?;

    // Cycle guard: parent must not be the folder itself or a descendant.
    if let Some(ref pid) = parent_id {
        if *pid == id {
            return Err("cannot nest a folder inside itself".into());
        }
        let mut cur = Some(pid.clone());
        while let Some(c) = cur {
            if c == id {
                return Err("cannot nest a folder inside its own descendant".into());
            }
            cur = store
                .folders
                .iter()
                .find(|f| f.id == c)
                .and_then(|f| f.parent_id.clone());
        }
    }

    let pos = match store.folders.iter().position(|f| f.id == id) {
        Some(p) => p,
        None => return Ok(()),
    };
    let mut folder = store.folders.remove(pos);
    folder.parent_id = parent_id;

    let insert_at = match before_id
        .as_ref()
        .and_then(|b| store.folders.iter().position(|f| &f.id == b))
    {
        Some(i) => i,
        None => store.folders.len(),
    };
    store.folders.insert(insert_at, folder);
    write_store(&app, &store)
}

/// Move a profile into a folder (or to root with `folder_id = None`).
#[tauri::command]
pub fn profile_set_folder(
    app: AppHandle,
    kind: String,
    id: String,
    folder_id: Option<String>,
) -> Result<(), String> {
    let mut store = read_store(&app)?;
    match kind.as_str() {
        "ssh" => {
            if let Some(p) = store.ssh.iter_mut().find(|p| p.id == id) {
                p.folder_id = folder_id;
            }
        }
        "sftp" => {
            if let Some(p) = store.sftp.iter_mut().find(|p| p.id == id) {
                p.folder_id = folder_id;
            }
        }
        "tunnel" => {
            if let Some(p) = store.tunnel.iter_mut().find(|p| p.id == id) {
                p.folder_id = folder_id;
            }
        }
        _ => {
            if let Some(p) = store.db.iter_mut().find(|p| p.id == id) {
                p.folder_id = folder_id;
            }
        }
    }
    write_store(&app, &store)
}

#[tauri::command]
pub fn query_save(app: AppHandle, mut query: SavedQuery) -> Result<SavedQuery, String> {
    if query.id.is_empty() {
        query.id = uuid::Uuid::new_v4().to_string();
    }
    let mut store = read_store(&app)?;
    if let Some(existing) = store.queries.iter_mut().find(|q| q.id == query.id) {
        *existing = query.clone();
    } else {
        store.queries.push(query.clone());
    }
    write_store(&app, &store)?;
    Ok(query)
}

#[tauri::command]
pub fn query_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.queries.retain(|q| q.id != id);
    write_store(&app, &store)?;
    Ok(())
}

#[tauri::command]
pub fn note_save(app: AppHandle, mut note: Note) -> Result<Note, String> {
    if note.id.is_empty() {
        note.id = uuid::Uuid::new_v4().to_string();
    }
    let mut store = read_store(&app)?;
    if let Some(existing) = store.notes.iter_mut().find(|n| n.id == note.id) {
        *existing = note.clone();
    } else {
        store.notes.push(note.clone());
    }
    write_store(&app, &store)?;
    Ok(note)
}

#[tauri::command]
pub fn note_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.notes.retain(|n| n.id != id);
    write_store(&app, &store)?;
    Ok(())
}

// ---- Encrypted backup bundle (cross-device export/import) -------------------
//
// All profiles + their keychain secrets are serialized into one JSON blob,
// encrypted with AES-256-GCM under a key derived from a user passphrase via
// Argon2id, and base64-armored into a portable text string. This decouples
// sync from the per-device keychain: move the text (AirDrop / Universal
// Clipboard / Files) to another device and import it there.

const BUNDLE_MAGIC: &[u8; 4] = b"BDK1";

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| format!("derive key: {e}"))?;
    Ok(key)
}

fn encrypt_bundle(passphrase: &str, plaintext: &[u8]) -> Result<String, String> {
    use aes_gcm::aead::{Aead, Payload};
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut salt).map_err(|e| format!("rng: {e}"))?;
    getrandom::getrandom(&mut nonce).map_err(|e| format!("rng: {e}"))?;
    let key = derive_key(passphrase, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "cipher init".to_string())?;
    // The header (magic + salt + nonce) is bound as associated data so any
    // tampering with it is rejected by the AEAD tag, not silently accepted.
    let mut out = Vec::with_capacity(BUNDLE_MAGIC.len() + salt.len() + nonce.len() + plaintext.len());
    out.extend_from_slice(BUNDLE_MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &out,
            },
        )
        .map_err(|_| "encrypt failed".to_string())?;
    out.extend_from_slice(&ct);
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        out,
    ))
}

fn decrypt_bundle(passphrase: &str, armored: &str) -> Result<Vec<u8>, String> {
    use aes_gcm::aead::{Aead, Payload};
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    let raw = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        armored.trim(),
    )
    .map_err(|_| "corrupt backup (not valid base64)".to_string())?;
    let head = BUNDLE_MAGIC.len() + 16 + 12;
    if raw.len() < head || &raw[..BUNDLE_MAGIC.len()] != BUNDLE_MAGIC {
        return Err("not a valid BalauDeck backup file".into());
    }
    let salt = &raw[BUNDLE_MAGIC.len()..BUNDLE_MAGIC.len() + 16];
    let nonce = &raw[BUNDLE_MAGIC.len() + 16..head];
    let ct = &raw[head..];
    let key = derive_key(passphrase, salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| "cipher init".to_string())?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: &raw[..head],
            },
        )
        .map_err(|_| "wrong passphrase or corrupt data".to_string())
}

/// Every keychain account that could hold a secret for the current profiles.
fn secret_accounts(store: &ProfileStore) -> Vec<String> {
    let cred = ["password", "key", "passphrase"];
    let mut a = Vec::new();
    for p in &store.ssh {
        for s in cred {
            a.push(keychain_account("ssh", &p.id, s));
        }
        a.push(keychain_account("ssh", &p.id, "escalate_password"));
        for s in cred {
            a.push(keychain_account("ssh", &jump_owner(&p.id), s));
        }
    }
    for p in &store.db {
        a.push(keychain_account("db", &p.id, "password"));
    }
    for p in &store.sftp {
        for s in cred {
            a.push(keychain_account("ssh", &p.id, s));
        }
        a.push(keychain_account("ssh", &p.id, "sudo_password"));
        for s in cred {
            a.push(keychain_account("ssh", &jump_owner(&p.id), s));
        }
    }
    for p in &store.tunnel {
        for s in cred {
            a.push(keychain_account("ssh", &p.id, s));
        }
        for s in cred {
            a.push(keychain_account("ssh", &jump_owner(&p.id), s));
        }
    }
    a.sort();
    a.dedup();
    a
}

#[derive(Serialize, Deserialize)]
struct Bundle {
    version: u32,
    store: ProfileStore,
    #[serde(default)]
    secrets: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize, Default)]
pub struct ImportSummary {
    pub ssh: usize,
    pub db: usize,
    pub sftp: usize,
    pub tunnel: usize,
    pub folders: usize,
    pub queries: usize,
    pub notes: usize,
    pub secrets: usize,
}

/// Merge `src` into `dst` by id (incoming wins; unseen ids are appended).
fn upsert<T, F: Fn(&T) -> &str>(dst: &mut Vec<T>, src: Vec<T>, id_of: F) -> usize {
    let mut n = 0;
    for item in src {
        let id = id_of(&item).to_string();
        if let Some(slot) = dst.iter_mut().find(|x| id_of(x) == id.as_str()) {
            *slot = item;
        } else {
            dst.push(item);
        }
        n += 1;
    }
    n
}

fn clear_if_absent(opt: &mut Option<String>, set: &std::collections::HashSet<String>) {
    if opt.as_deref().map_or(false, |v| !set.contains(v)) {
        *opt = None;
    }
}

/// Break any folder parent cycles by clearing the parent at the point a cycle
/// is detected (import bypasses `folder_move`'s cycle guard, so a malformed or
/// cross-device-merged bundle could introduce one).
fn break_folder_cycles(store: &mut ProfileStore) {
    use std::collections::{HashMap, HashSet};
    let idx: HashMap<String, usize> = store
        .folders
        .iter()
        .enumerate()
        .map(|(i, f)| (f.id.clone(), i))
        .collect();
    for start in 0..store.folders.len() {
        let mut seen: HashSet<usize> = HashSet::new();
        let mut cur = start;
        loop {
            if !seen.insert(cur) {
                store.folders[cur].parent_id = None; // edge on the cycle
                break;
            }
            match store.folders[cur].parent_id.clone() {
                Some(pid) => match idx.get(&pid) {
                    Some(&p) => cur = p,
                    None => break,
                },
                None => break,
            }
        }
    }
}

/// After a merge the store can hold references (folder_id, jump/ssh/db ids,
/// folder parents) whose targets are not present — drop those references so the
/// persisted store is always internally consistent and nothing is orphaned.
fn prune_dangling(store: &mut ProfileStore) {
    use std::collections::HashSet;
    let folder_ids: HashSet<String> = store.folders.iter().map(|f| f.id.clone()).collect();
    let ssh_ids: HashSet<String> = store.ssh.iter().map(|p| p.id.clone()).collect();
    let db_ids: HashSet<String> = store.db.iter().map(|p| p.id.clone()).collect();

    for f in store.folders.iter_mut() {
        clear_if_absent(&mut f.parent_id, &folder_ids);
    }
    for p in store.ssh.iter_mut() {
        clear_if_absent(&mut p.folder_id, &folder_ids);
        clear_if_absent(&mut p.jump_profile_id, &ssh_ids);
    }
    for p in store.db.iter_mut() {
        clear_if_absent(&mut p.folder_id, &folder_ids);
        clear_if_absent(&mut p.via_ssh_profile_id, &ssh_ids);
    }
    for p in store.sftp.iter_mut() {
        clear_if_absent(&mut p.folder_id, &folder_ids);
        clear_if_absent(&mut p.jump_profile_id, &ssh_ids);
    }
    for p in store.tunnel.iter_mut() {
        clear_if_absent(&mut p.folder_id, &folder_ids);
        clear_if_absent(&mut p.jump_profile_id, &ssh_ids);
        clear_if_absent(&mut p.ssh_profile_id, &ssh_ids);
    }
    for q in store.queries.iter_mut() {
        clear_if_absent(&mut q.db_profile_id, &db_ids);
    }
    break_folder_cycles(store);
}

/// OS the app is running on ("macos" | "ios" | "android" | "windows" | "linux").
/// The frontend uses this to show file save/open only where a real filesystem
/// path is writable (desktop); mobile relies on copy/paste instead.
#[tauri::command]
pub fn current_platform() -> &'static str {
    std::env::consts::OS
}

/// Export all profiles + secrets as one encrypted, base64-armored backup string.
#[tauri::command]
pub fn connections_export(app: AppHandle, passphrase: String) -> Result<String, String> {
    let pass = passphrase.trim();
    if pass.is_empty() {
        return Err("passphrase required".into());
    }
    let store = read_store(&app)?;
    let mut secrets = std::collections::BTreeMap::new();
    for account in secret_accounts(&store) {
        if let Ok(Some(v)) = get_secret_raw(&account) {
            secrets.insert(account, v);
        }
    }
    let bundle = Bundle {
        version: 1,
        store,
        secrets,
    };
    let plain = serde_json::to_vec(&bundle).map_err(|e| format!("serialize: {e}"))?;
    encrypt_bundle(pass, &plain)
}

/// Decrypt a backup string and merge its profiles + secrets into this device.
#[tauri::command]
pub fn connections_import(
    app: AppHandle,
    passphrase: String,
    bundle: String,
) -> Result<ImportSummary, String> {
    let plain = decrypt_bundle(passphrase.trim(), &bundle)?;
    let incoming: Bundle = serde_json::from_slice(&plain)
        .map_err(|_| "invalid backup contents after decrypt".to_string())?;
    if incoming.version > 1 {
        return Err("this backup was created by a newer version of BalauDeck".into());
    }
    let mut store = read_store(&app)?;
    let mut sum = ImportSummary::default();
    sum.ssh = upsert(&mut store.ssh, incoming.store.ssh, |p| &p.id);
    sum.db = upsert(&mut store.db, incoming.store.db, |p| &p.id);
    sum.sftp = upsert(&mut store.sftp, incoming.store.sftp, |p| &p.id);
    sum.tunnel = upsert(&mut store.tunnel, incoming.store.tunnel, |p| &p.id);
    sum.folders = upsert(&mut store.folders, incoming.store.folders, |f| &f.id);
    sum.queries = upsert(&mut store.queries, incoming.store.queries, |q| &q.id);
    sum.notes = upsert(&mut store.notes, incoming.store.notes, |n| &n.id);
    prune_dangling(&mut store);
    write_store(&app, &store)?;
    // Count only the secrets that actually landed, so a keychain failure shows
    // up as a smaller number rather than a falsely complete import.
    for (account, value) in incoming.secrets {
        if set_secret_raw(&account, Some(&value)).is_ok() {
            sum.secrets += 1;
        }
    }
    Ok(sum)
}

/// Write a UTF-8 text file (used to save a backup bundle on desktop).
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| format!("write file: {e}"))
}

/// List a local directory for terminal path autosuggestions. `dir` may be
/// absolute, `~`-prefixed, or relative to `cwd` (itself absolute/`~`); a
/// relative dir with no cwd returns empty (we can't know the shell's cwd).
/// Directory entries get a trailing `/` so completions can chain.
#[tauri::command]
pub fn local_listdir(cwd: Option<String>, dir: String) -> Result<Vec<String>, String> {
    fn home() -> PathBuf {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(Into::into)
            .unwrap_or_else(|| PathBuf::from("/"))
    }
    fn expand(p: &str) -> PathBuf {
        if p == "~" {
            home()
        } else if let Some(rest) = p.strip_prefix("~/") {
            home().join(rest)
        } else {
            PathBuf::from(p)
        }
    }
    let base = expand(&dir);
    let path = if base.is_absolute() {
        base
    } else {
        match cwd {
            Some(c) => expand(&c).join(base),
            None => return Ok(Vec::new()),
        }
    };
    let rd = fs::read_dir(&path).map_err(|e| format!("list: {e}"))?;
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let mut name = ent.file_name().to_string_lossy().into_owned();
        if ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            name.push('/');
        }
        out.push(name);
        if out.len() >= 500 {
            break;
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_roundtrip() {
        let plain = br#"{"hello":"world","n":42}"#;
        let armored = encrypt_bundle("correct horse", plain).unwrap();
        // Right passphrase decrypts to the original bytes.
        assert_eq!(decrypt_bundle("correct horse", &armored).unwrap(), plain);
        // Wrong passphrase fails (AEAD tag mismatch), it does not return garbage.
        assert!(decrypt_bundle("battery staple", &armored).is_err());
        // Non-bundle text is rejected.
        assert!(decrypt_bundle("correct horse", "not-a-bundle").is_err());
    }

    #[test]
    fn secret_accounts_cover_and_dedup() {
        let store = ProfileStore {
            ssh: vec![SshProfile {
                id: "s1".into(),
                ..Default::default()
            }],
            sftp: vec![SftpProfile {
                id: "f1".into(),
                ..Default::default()
            }],
            db: vec![DbProfile {
                id: "d1".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let accts = secret_accounts(&store);
        assert!(accts.contains(&"ssh:s1:password".to_string()));
        assert!(accts.contains(&"ssh:s1~jump:key".to_string()));
        assert!(accts.contains(&"ssh:f1:sudo_password".to_string()));
        assert!(accts.contains(&"db:d1:password".to_string()));
        // Sorted + deduped.
        let mut sorted = accts.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(accts, sorted);
    }

    #[test]
    fn upsert_merges_by_id() {
        let mut dst = vec![
            SshProfile {
                id: "a".into(),
                name: "old-a".into(),
                ..Default::default()
            },
            SshProfile {
                id: "b".into(),
                name: "b".into(),
                ..Default::default()
            },
        ];
        let src = vec![
            SshProfile {
                id: "a".into(),
                name: "new-a".into(),
                ..Default::default()
            },
            SshProfile {
                id: "c".into(),
                name: "c".into(),
                ..Default::default()
            },
        ];
        let n = upsert(&mut dst, src, |p| &p.id);
        assert_eq!(n, 2);
        assert_eq!(dst.len(), 3); // a (updated), b (kept), c (added)
        assert_eq!(dst.iter().find(|p| p.id == "a").unwrap().name, "new-a");
    }

    #[test]
    fn tampered_header_is_rejected() {
        // Flipping a bit in the salt/nonce header must fail decryption (the
        // header is bound as AEAD associated data), not be silently accepted.
        let armored = encrypt_bundle("pw", b"payload").unwrap();
        let mut raw = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            &armored,
        )
        .unwrap();
        raw[5] ^= 0x01; // a salt byte (after the 4-byte magic)
        let tampered =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &raw);
        assert!(decrypt_bundle("pw", &tampered).is_err());
    }

    #[test]
    fn prune_clears_dangling_and_breaks_cycles() {
        let mut store = ProfileStore {
            folders: vec![
                Folder { id: "f1".into(), parent_id: Some("f2".into()), ..Default::default() },
                Folder { id: "f2".into(), parent_id: Some("f1".into()), ..Default::default() },
                Folder { id: "f3".into(), parent_id: Some("gone".into()), ..Default::default() },
            ],
            ssh: vec![SshProfile {
                id: "s1".into(),
                folder_id: Some("missing".into()),
                jump_profile_id: Some("s1".into()), // self-ref to an existing id is kept
                ..Default::default()
            }],
            db: vec![DbProfile {
                id: "d1".into(),
                via_ssh_profile_id: Some("nope".into()),
                folder_id: Some("f1".into()), // valid, kept
                ..Default::default()
            }],
            queries: vec![SavedQuery {
                id: "q1".into(),
                db_profile_id: Some("ghost".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        prune_dangling(&mut store);
        // Dangling parent cleared.
        assert_eq!(store.folders.iter().find(|f| f.id == "f3").unwrap().parent_id, None);
        // Cycle f1<->f2 broken (at least one side now has no parent, no panic).
        let f1p = store.folders.iter().find(|f| f.id == "f1").unwrap().parent_id.is_some();
        let f2p = store.folders.iter().find(|f| f.id == "f2").unwrap().parent_id.is_some();
        assert!(!(f1p && f2p), "cycle must be broken");
        // Dangling refs cleared; valid refs kept.
        let s1 = &store.ssh[0];
        assert_eq!(s1.folder_id, None);
        assert_eq!(s1.jump_profile_id.as_deref(), Some("s1"));
        let d1 = &store.db[0];
        assert_eq!(d1.via_ssh_profile_id, None);
        assert_eq!(d1.folder_id.as_deref(), Some("f1"));
        assert_eq!(store.queries[0].db_profile_id, None);
    }
}
