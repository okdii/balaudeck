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
    #[serde(default)]
    pub folder_id: Option<String>,
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
    pub folder_id: Option<String>,
}

/// A saved SSH tunnel: SSH credentials plus the remote target to forward.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TunnelProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub auth: SshAuth,
    pub remote_host: String,
    pub remote_port: u16,
    #[serde(default)]
    pub local_port: Option<u16>,
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

/// Upsert an SFTP profile. Secrets are stored under the "ssh" keychain kind so
/// the shared SSH connect path (`resolve_secret`) finds them via `profile_id`.
#[tauri::command]
pub fn sftp_profile_save(
    app: AppHandle,
    mut profile: SftpProfile,
    password: Option<String>,
    key: Option<String>,
    passphrase: Option<String>,
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
pub fn sftp_profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.sftp.retain(|p| p.id != id);
    write_store(&app, &store)?;
    delete_all_secrets("ssh", &id, &["password", "key", "passphrase"]);
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
pub fn tunnel_profile_delete(app: AppHandle, id: String) -> Result<(), String> {
    let mut store = read_store(&app)?;
    store.tunnel.retain(|p| p.id != id);
    write_store(&app, &store)?;
    delete_all_secrets("ssh", &id, &["password", "key", "passphrase"]);
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
