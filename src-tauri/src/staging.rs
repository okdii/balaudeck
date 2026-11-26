//! Staging area for drag-and-drop uploads.
//!
//! Files dropped onto the webview arrive as browser `File` objects with no
//! filesystem path (`dragDropEnabled` is off so HTML5 drag-and-drop keeps
//! working for tabs/panes on every platform, and mobile never has paths). The
//! UI streams their bytes here in chunks, mirroring any dropped folder tree,
//! then hands the staged paths to the regular SFTP/S3 upload commands — so
//! drops get the same transfer queue, progress and cancel as picker uploads.
//! The staged copy is deleted once those uploads settle.

use std::fs::{self, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use tauri::ipc::{InvokeBody, Request};
use uuid::Uuid;

fn staging_root() -> PathBuf {
    std::env::temp_dir().join("balaudeck-drop")
}

/// Accept only a directory we created under the staging root.
fn checked_dir(dir: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(dir);
    let root = staging_root();
    if p.parent() != Some(root.as_path()) {
        return Err("not a staging directory".into());
    }
    Ok(p)
}

/// A relative path from the drop (folder/sub/file.txt) — no absolute paths, no
/// `..`, no drive prefixes — so nothing can be written outside the stage dir.
fn checked_rel(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let p = Path::new(&rel);
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            _ => return Err(format!("invalid path in drop: {rel}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("empty path in drop".into());
    }
    Ok(out)
}

/// Minimal %XX decoding for the UTF-8 relative path carried in a header
/// (headers are ASCII; the UI percent-encodes with encodeURIComponent).
pub(crate) fn percent_decode_pub(s: &str) -> Result<String, String> {
    percent_decode(s)
}

fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|_| "bad escape")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "bad escape")?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "path is not UTF-8".to_string())
}

/// Create a fresh, empty stage directory and return its path.
#[tauri::command]
pub fn stage_new() -> Result<String, String> {
    let dir = staging_root().join(Uuid::new_v4().to_string());
    fs::create_dir_all(&dir).map_err(|e| format!("create staging dir: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Write one chunk. Raw binary body; headers: `x-dir` (from `stage_new`),
/// `x-rel` (percent-encoded relative path), `x-offset` (byte offset). Offset 0
/// creates/truncates the file, so an empty file is a single empty chunk.
#[tauri::command]
pub fn stage_write(request: Request<'_>) -> Result<(), String> {
    let h = request.headers();
    let get = |k: &str| -> Result<String, String> {
        h.get(k)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("missing header {k}"))
    };
    let dir = checked_dir(&get("x-dir")?)?;
    let rel = checked_rel(&percent_decode(&get("x-rel")?)?)?;
    let offset: u64 = get("x-offset")?.parse().map_err(|_| "bad offset")?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected a binary body".into());
    };
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create folder: {e}"))?;
    }
    let mut f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&path)
        .map_err(|e| format!("open staged file: {e}"))?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| format!("seek: {e}"))?;
    f.write_all(data).map_err(|e| format!("write staged file: {e}"))?;
    Ok(())
}

/// Create an (empty) folder inside the stage dir — keeps empty dropped
/// folders in the uploaded tree.
#[tauri::command]
pub fn stage_mkdir(dir: String, rel: String) -> Result<(), String> {
    let path = checked_dir(&dir)?.join(checked_rel(&rel)?);
    fs::create_dir_all(path).map_err(|e| format!("create folder: {e}"))
}

/// Delete a stage directory (after its uploads have settled).
#[tauri::command]
pub fn stage_cleanup(dir: String) -> Result<(), String> {
    let p = checked_dir(&dir)?;
    if p.exists() {
        fs::remove_dir_all(&p).map_err(|e| format!("remove staging dir: {e}"))?;
    }
    Ok(())
}

/// Remove stage dirs left behind by a crash or quit mid-upload. Called once
/// at startup; best-effort.
pub fn sweep_stale() {
    let _ = fs::remove_dir_all(staging_root());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_paths_cannot_escape() {
        assert!(checked_rel("a/b.txt").is_ok());
        assert!(checked_rel("../x").is_err());
        assert!(checked_rel("/etc/passwd").is_err());
        assert!(checked_rel("a/../../x").is_err());
        assert!(checked_rel("").is_err());
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%20b%2Fc").unwrap(), "a b/c");
        assert_eq!(percent_decode("%E2%9C%93").unwrap(), "✓");
        assert_eq!(percent_decode("plain").unwrap(), "plain");
    }
}
