//! Connection profiles (SSH + DB) persisted as JSON in the app data dir,
//! with secrets stored separately in the OS keychain via `keyring`.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const KEYCHAIN_SERVICE: &str = "com.okdii.termdb";

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
pub struct SshProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DbProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub database: Option<String>,
    /// When set, connect through this SSH profile's tunnel.
    #[serde(default)]
    pub via_ssh_profile_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ProfileStore {
    #[serde(default)]
    pub ssh: Vec<SshProfile>,
    #[serde(default)]
    pub db: Vec<DbProfile>,
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

/// Store a secret, or delete it when `value` is None.
pub fn set_secret(kind: &str, id: &str, slot: &str, value: Option<&str>) -> Result<(), String> {
    let account = keychain_account(kind, id, slot);
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, &account).map_err(|e| format!("keychain: {e}"))?;
    match value {
        Some(v) if !v.is_empty() => entry.set_password(v).map_err(|e| format!("keychain set: {e}")),
        _ => match entry.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain delete: {e}")),
        },
    }
}

#[allow(dead_code)] // used by connect-by-profile in Fasa 2/5
pub fn get_secret(kind: &str, id: &str, slot: &str) -> Result<Option<String>, String> {
    let account = keychain_account(kind, id, slot);
    let entry =
        keyring::Entry::new(KEYCHAIN_SERVICE, &account).map_err(|e| format!("keychain: {e}"))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain get: {e}")),
    }
}

fn delete_all_secrets(kind: &str, id: &str, slots: &[&str]) {
    for slot in slots {
        let _ = set_secret(kind, id, slot, None);
    }
}

// ---- Commands ---------------------------------------------------------------

#[tauri::command]
pub fn profiles_load(app: AppHandle) -> Result<ProfileStore, String> {
    read_store(&app)
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

    if let Some(p) = password {
        set_secret("ssh", &profile.id, "password", Some(&p))?;
    }
    if let Some(k) = key {
        set_secret("ssh", &profile.id, "key", Some(&k))?;
    }
    if let Some(pp) = passphrase {
        set_secret("ssh", &profile.id, "passphrase", Some(&pp))?;
    }
    Ok(profile)
}

#[tauri::command]
pub fn ssh_profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.ssh.retain(|p| p.id != id);
    write_store(&app, &store)?;
    delete_all_secrets("ssh", &id, &["password", "key", "passphrase"]);
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
