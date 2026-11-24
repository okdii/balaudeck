//! Shared transfer-job plumbing for the S3/SFTP file transfers: the
//! `transfer://progress` event a transfer command streams when given a job id,
//! plus the cancel registry the transfer loops poll between chunks/parts.
//! Cancellation is cooperative and NOT an error: a cancelled loop cleans up
//! its partial output, emits a single "cancelled" terminal event, and
//! returns Ok.

use std::collections::HashSet;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::Emitter;

/// Emit a "running" progress event after at least this many new bytes.
pub(crate) const PROGRESS_STEP: u64 = 256 * 1024;

/// Ids the UI asked to cancel; transfer loops poll this between chunks/parts.
static CANCELLED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Ids of transfers currently running. A cancel is only honored while the job
/// is in here, so a cancel click that races a just-finished job can't strand an
/// id in CANCELLED (which clear() would then never remove).
static ACTIVE: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Register a live transfer, before its loop starts polling `is_cancelled`, so
/// a genuine cancel is honored and a late one (after finish) is ignored.
pub fn register(id: &str) {
    ACTIVE.lock().unwrap().insert(id.to_string());
}

pub fn cancel(id: &str) {
    CANCELLED.lock().unwrap().insert(id.to_string());
}

pub fn is_cancelled(id: &str) -> bool {
    CANCELLED.lock().unwrap().contains(id)
}

pub fn clear(id: &str) {
    CANCELLED.lock().unwrap().remove(id);
    ACTIVE.lock().unwrap().remove(id);
}

/// Flag a running transfer for cancellation (called from the transfer UI). A
/// no-op once the job has finished (no longer ACTIVE), so a cancel racing a
/// just-finished transfer can't leak an id into CANCELLED.
#[tauri::command]
pub fn transfer_cancel(id: String) -> Result<(), String> {
    if ACTIVE.lock().unwrap().contains(&id) {
        cancel(&id);
    }
    Ok(())
}

/// Payload of every `transfer://progress` event — one shape for all transfer
/// kinds so the frontend parses a single contract.
#[derive(Serialize, Clone)]
struct TransferProgress<'a> {
    id: &'a str,
    name: &'a str,
    done: u64,
    total: Option<u64>,
    /// "running" | "done" | "error" | "cancelled".
    state: &'a str,
    error: Option<&'a str>,
}

/// Emit one `transfer://progress` event. All call sites go through here so the
/// payload shape can't drift between transfer kinds.
pub(crate) fn emit_progress(
    app: &tauri::AppHandle,
    id: &str,
    name: &str,
    done: u64,
    total: Option<u64>,
    state: &str,
    error: Option<&str>,
) {
    let _ = app.emit(
        "transfer://progress",
        TransferProgress { id, name, done, total, state, error },
    );
}

/// Map a transfer body's outcome to its single terminal event and clear the
/// cancel flag: Ok(true) → "done", Ok(false) → "cancelled" (still Ok to the
/// caller — cancellation is not an error), Err → "error". Without a job id
/// the result just passes through untouched.
pub(crate) fn finish(
    app: &tauri::AppHandle,
    job_id: Option<&str>,
    name: &str,
    done: u64,
    total: Option<u64>,
    res: Result<bool, String>,
) -> Result<(), String> {
    let Some(id) = job_id else {
        return res.map(|_| ());
    };
    match &res {
        Ok(true) => emit_progress(app, id, name, done, total, "done", None),
        Ok(false) => emit_progress(app, id, name, done, total, "cancelled", None),
        Err(e) => emit_progress(app, id, name, done, total, "error", Some(e)),
    }
    clear(id);
    res.map(|_| ())
}

/// Running byte counter for one transfer job: registers it, throttles
/// `running` events to PROGRESS_STEP, and ends it with one terminal event.
/// Without a job id every call is a cheap no-op (plain blocking command).
pub(crate) struct Progress<'a> {
    /// None only in tests (no app to emit to).
    app: Option<&'a tauri::AppHandle>,
    job: Option<&'a str>,
    name: &'a str,
    pub done: u64,
    pub total: Option<u64>,
    last: u64,
}

impl<'a> Progress<'a> {
    pub fn new(app: &'a tauri::AppHandle, job: Option<&'a str>, name: &'a str) -> Self {
        Self { app: Some(app), job, name, done: 0, total: None, last: 0 }
    }

    /// A counter with no app/job: nothing is emitted, never cancelled.
    #[cfg(test)]
    pub fn detached(name: &'a str) -> Self {
        Self { app: None, job: None, name, done: 0, total: None, last: 0 }
    }

    /// Register the job and emit its first event (call once the total is known).
    pub fn start(&self) {
        if let (Some(app), Some(j)) = (self.app, self.job) {
            register(j);
            emit_progress(app, j, self.name, self.done, self.total, "running", None);
        }
    }

    pub fn add(&mut self, n: u64) {
        self.done += n;
        if let (Some(app), Some(j)) = (self.app, self.job) {
            if self.done - self.last >= PROGRESS_STEP {
                self.last = self.done;
                emit_progress(app, j, self.name, self.done, self.total, "running", None);
            }
        }
    }

    pub fn cancelled(&self) -> bool {
        self.job.is_some_and(is_cancelled)
    }

    pub fn finish(self, res: Result<bool, String>) -> Result<(), String> {
        match self.app {
            Some(app) => finish(app, self.job, self.name, self.done, self.total, res),
            None => res.map(|_| ()),
        }
    }
}
