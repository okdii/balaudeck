//! Saving files on iOS.
//!
//! iOS has no "give me a writable path" save panel: the dialog plugin's `save`
//! runs UIDocumentPicker in *export* mode, which copies an existing file from
//! the app's Documents folder to wherever the user picks (On My iPad, iCloud
//! Drive, …) and hands back a URL we cannot write to — writing to it is what
//! failed with "write local failed: No such file or directory".
//!
//! So on iOS the UI writes the file into Documents first (`export_stage` gives
//! the exact path the plugin exports: Documents/<file name>), then calls `save`
//! to let the user copy it out, then `export_cleanup`. Folder downloads go to
//! Documents/Downloads, which the Files app shows under "BalauDeck"
//! (UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace).

use std::fs;
use std::path::PathBuf;

use tauri::ipc::{InvokeBody, Request};

/// The app's Documents folder (the dialog plugin exports from here).
fn documents() -> Result<PathBuf, String> {
    #[cfg(target_os = "ios")]
    {
        let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
        Ok(PathBuf::from(home).join("Documents"))
    }
    #[cfg(not(target_os = "ios"))]
    {
        Ok(std::env::temp_dir().join("balaudeck-export"))
    }
}

/// A bare file name: no separators, no `..`, not empty.
fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." || n.contains('/') || n.contains('\\') || n.contains('\0') {
        return Err(format!("invalid file name: {name}"));
    }
    Ok(n.to_string())
}

/// Only files directly inside Documents may be written/removed through here.
fn checked(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let docs = documents()?;
    if p.parent() != Some(docs.as_path()) {
        return Err("not a staged export file".into());
    }
    clean_name(&p.file_name().and_then(|s| s.to_str()).unwrap_or_default().to_string())?;
    Ok(p)
}

/// Path to write a file to before exporting it: Documents/<name>, emptied.
#[tauri::command]
pub fn export_stage(name: String) -> Result<String, String> {
    let docs = documents()?;
    fs::create_dir_all(&docs).map_err(|e| format!("create folder: {e}"))?;
    let p = docs.join(clean_name(&name)?);
    if p.is_dir() {
        return Err(format!("a folder named {name} is in the way"));
    }
    let _ = fs::remove_file(&p);
    Ok(p.to_string_lossy().into_owned())
}

/// Write raw bytes (body) to a staged path (header `x-path`, URI-encoded).
#[tauri::command]
pub fn export_write(request: Request<'_>) -> Result<(), String> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing header x-path")?;
    let path = checked(&crate::staging::percent_decode_pub(raw)?)?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected a binary body".into());
    };
    fs::write(&path, data).map_err(|e| format!("write file: {e}"))
}

/// Remove a staged file once it has been exported (or the export was cancelled).
#[tauri::command]
pub fn export_cleanup(path: String) -> Result<(), String> {
    let p = checked(&path)?;
    if p.is_file() {
        fs::remove_file(&p).map_err(|e| format!("remove: {e}"))?;
    }
    Ok(())
}

/// Where folder downloads land on iOS: Documents/Downloads (visible in Files).
#[tauri::command]
pub fn export_downloads_dir() -> Result<String, String> {
    let d = documents()?.join("Downloads");
    fs::create_dir_all(&d).map_err(|e| format!("create folder: {e}"))?;
    Ok(d.to_string_lossy().into_owned())
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn stage_and_guard() {
        let p = export_stage("report.csv".into()).unwrap();
        fs::write(&p, "x").unwrap();
        assert!(checked(&p).is_ok());
        assert!(export_stage("../evil".into()).is_err());
        assert!(export_stage("a/b".into()).is_err());
        assert!(checked("/etc/passwd").is_err());
        let docs = documents().unwrap();
        assert!(checked(&docs.join("sub").join("x").to_string_lossy()).is_err());
        export_cleanup(p.clone()).unwrap();
        assert!(!Path::new(&p).exists());
    }
}
