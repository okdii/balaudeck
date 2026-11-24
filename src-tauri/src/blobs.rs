//! Binary previews (PDF / image bytes) handed to the webview as raw IPC bytes
//! instead of base64 inside JSON — ~33% less data and no encode/decode on
//! either side. A preview command stashes the bytes and returns a `blob:<id>`
//! reference in its JSON; the frontend fetches them once with
//! `preview_blob_take`, which arrives as an ArrayBuffer.

use std::collections::VecDeque;
use std::sync::Mutex;

use once_cell::sync::Lazy;

/// Only the last few previews are kept (a preview the UI never fetched — the
/// user clicked away — mustn't pin memory forever).
const KEEP: usize = 6;

static STORE: Lazy<Mutex<VecDeque<(String, Vec<u8>)>>> = Lazy::new(|| Mutex::new(VecDeque::new()));

/// Keep `bytes` for one fetch and return the reference to put in the preview.
pub fn stash(bytes: Vec<u8>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let mut s = STORE.lock().unwrap();
    s.push_back((id.clone(), bytes));
    while s.len() > KEEP {
        s.pop_front();
    }
    format!("blob:{id}")
}

/// Remove and return the stashed bytes for `blob:<id>` (or a bare id).
pub fn take(reference: &str) -> Option<Vec<u8>> {
    let id = reference.strip_prefix("blob:").unwrap_or(reference);
    let mut s = STORE.lock().unwrap();
    let i = s.iter().position(|(k, _)| k == id)?;
    s.remove(i).map(|(_, b)| b)
}

#[tauri::command]
pub fn preview_blob_take(id: String) -> Result<tauri::ipc::Response, String> {
    take(&id)
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| "preview expired — open it again".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stash_take_once_and_evicts_old() {
        let r = stash(b"%PDF".to_vec());
        assert!(r.starts_with("blob:"));
        assert_eq!(take(&r).as_deref(), Some(&b"%PDF"[..]));
        assert!(take(&r).is_none(), "one fetch only");
        let first = stash(vec![1]);
        for _ in 0..KEEP {
            stash(vec![2]);
        }
        assert!(take(&first).is_none(), "oldest evicted");
    }
}
