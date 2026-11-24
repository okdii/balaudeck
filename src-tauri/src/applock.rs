//! Desktop idle lock: unlock with the OS (Touch ID / login password on macOS)
//! or a BalauDeck PIN. The PIN is stored only as an Argon2id hash, in the OS
//! keychain like every other secret.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

use crate::profiles::{get_secret, set_secret};

const KIND: &str = "applock";
const ID: &str = "desktop";
const SLOT: &str = "pin_hash";

#[tauri::command]
pub fn applock_pin_set(pin: Option<String>) -> Result<(), String> {
    match pin.filter(|p| !p.is_empty()) {
        None => set_secret(KIND, ID, SLOT, None),
        Some(p) => {
            if p.chars().count() < 4 {
                return Err("use at least 4 characters".into());
            }
            let salt = SaltString::generate(&mut OsRng);
            let hash = Argon2::default()
                .hash_password(p.as_bytes(), &salt)
                .map_err(|e| e.to_string())?
                .to_string();
            set_secret(KIND, ID, SLOT, Some(&hash))
        }
    }
}

#[tauri::command]
pub fn applock_pin_exists() -> bool {
    matches!(get_secret(KIND, ID, SLOT), Ok(Some(h)) if !h.is_empty())
}

#[tauri::command]
pub async fn applock_pin_verify(pin: String) -> Result<bool, String> {
    let Some(stored) = get_secret(KIND, ID, SLOT)? else { return Ok(false) };
    // Argon2 is deliberately slow — keep it off the async runtime threads.
    tokio::task::spawn_blocking(move || {
        PasswordHash::new(&stored)
            .map(|h| Argon2::default().verify_password(pin.as_bytes(), &h).is_ok())
            .unwrap_or(false)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Whether the OS can verify the user here (macOS: Touch ID or login password).
#[tauri::command]
pub fn applock_os_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2_local_authentication::{LAContext, LAPolicy};
        unsafe { LAContext::new().canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication).is_ok() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Ask the OS to verify the user. Ok(true) = verified, Ok(false) = cancelled
/// or failed.
#[tauri::command]
pub async fn applock_os_unlock(reason: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        use std::sync::Mutex;

        use block2::RcBlock;
        use objc2::runtime::Bool;
        use objc2_foundation::{NSError, NSString};
        use objc2_local_authentication::{LAContext, LAPolicy};

        // LAContext isn't Send: run the whole evaluation on a blocking thread
        // and wait there for the reply (it arrives on a framework queue).
        let ok = tokio::task::spawn_blocking(move || {
            let (tx, rx) = std::sync::mpsc::channel::<bool>();
            let tx = Mutex::new(Some(tx));
            let block = RcBlock::new(move |ok: Bool, _err: *mut NSError| {
                if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                    let _ = tx.send(ok.as_bool());
                }
            });
            let ctx = unsafe { LAContext::new() };
            let reason = NSString::from_str(if reason.is_empty() { "unlock BalauDeck" } else { &reason });
            unsafe {
                ctx.evaluatePolicy_localizedReason_reply(LAPolicy::DeviceOwnerAuthentication, &reason, &block);
            }
            // Keep the context alive until the reply, or the prompt is cancelled.
            let ok = rx.recv().unwrap_or(false);
            drop(ctx);
            ok
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(ok)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = reason;
        Err("OS unlock isn't available on this platform — use the PIN".into())
    }
}
