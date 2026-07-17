//! Local shell terminal via a PTY. Desktop only — mobile platforms cannot
//! spawn arbitrary processes, so there the commands return an error.

/// A shell the user can pick for new Local terminals (Settings → Local
/// terminal). Only shells that actually exist on this machine are offered, so
/// the picker can never hand `local_open` a path that fails to spawn.
#[derive(serde::Serialize)]
pub struct ShellOption {
    /// Passed straight back to `local_open` as `shell`.
    pub path: String,
    /// Friendly name shown in the picker.
    pub label: String,
}

#[cfg(desktop)]
mod imp {
    use super::ShellOption;
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::sync::Mutex;

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use tauri::{AppHandle, Emitter, State};
    use uuid::Uuid;

    struct Session {
        master: Box<dyn portable_pty::MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
    }

    #[derive(Default)]
    pub struct LocalState {
        sessions: Mutex<HashMap<String, Session>>,
    }

    /// The shell to launch when the caller didn't name one.
    ///
    /// Unix has `$SHELL` (and `/bin/sh` as a guaranteed fallback). Windows has
    /// NEITHER — no `$SHELL`, no `/bin/sh` — so spawning the Unix default there
    /// just fails. Pick the best shell Windows actually has: PowerShell 7 if
    /// installed, else Windows PowerShell (present since Win7), else cmd.exe
    /// (COMSPEC always points at it).
    #[cfg(windows)]
    fn default_shell() -> String {
        for exe in ["pwsh.exe", "powershell.exe"] {
            if find_in_path(exe).is_some() {
                return exe.to_string();
            }
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }

    #[cfg(windows)]
    fn find_in_path(exe: &str) -> Option<std::path::PathBuf> {
        let paths = std::env::var_os("PATH")?;
        std::env::split_paths(&paths)
            .map(|dir| dir.join(exe))
            .find(|p| p.is_file())
    }

    #[cfg(not(windows))]
    fn default_shell() -> String {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }

    /// Shells installed on this machine, for the Settings picker. Reports only
    /// what exists (deduped), so a choice can never be a broken path.
    #[tauri::command]
    pub fn list_shells() -> Vec<ShellOption> {
        let mut out = detect_shells();
        let mut seen = std::collections::HashSet::new();
        out.retain(|s| seen.insert(s.path.clone()));
        out
    }

    #[cfg(windows)]
    fn detect_shells() -> Vec<ShellOption> {
        let mut out: Vec<ShellOption> = Vec::new();
        for (exe, label) in [("pwsh.exe", "PowerShell 7"), ("powershell.exe", "Windows PowerShell")] {
            if let Some(p) = find_in_path(exe) {
                out.push(ShellOption { path: p.display().to_string(), label: label.into() });
            }
        }
        if let Ok(c) = std::env::var("COMSPEC") {
            if std::path::Path::new(&c).is_file() {
                out.push(ShellOption { path: c, label: "Command Prompt".into() });
            }
        }
        // Git Bash from its install dir. A bare bash.exe on PATH is often the
        // WSL shim instead, which we list separately below.
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(pf) = std::env::var(var) {
                let p = std::path::Path::new(&pf).join("Git").join("bin").join("bash.exe");
                if p.is_file() {
                    out.push(ShellOption { path: p.display().to_string(), label: "Git Bash".into() });
                    break;
                }
            }
        }
        if let Some(p) = find_in_path("wsl.exe") {
            out.push(ShellOption { path: p.display().to_string(), label: "WSL".into() });
        }
        out
    }

    #[cfg(not(windows))]
    fn detect_shells() -> Vec<ShellOption> {
        // /etc/shells is the canonical list of login shells on macOS + Linux;
        // fall back to the usual suspects if it's missing.
        let listed = std::fs::read_to_string("/etc/shells").unwrap_or_default();
        let mut paths: Vec<String> = listed
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with('/'))
            .map(str::to_string)
            .collect();
        if paths.is_empty() {
            paths = ["/bin/zsh", "/bin/bash", "/bin/sh"].iter().map(|s| s.to_string()).collect();
        }
        paths
            .into_iter()
            .filter(|p| std::path::Path::new(p).is_file())
            .map(|p| {
                let label = std::path::Path::new(&p)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| p.clone());
                ShellOption { path: p, label }
            })
            .collect()
    }

    /// Spawn the user's shell in a PTY and stream output via
    /// `local://data/<id>` events. Returns the session id.
    #[tauri::command]
    pub fn local_open(
        app: AppHandle,
        state: State<'_, LocalState>,
        cols: u16,
        rows: u16,
        shell: Option<String>,
    ) -> Result<String, String> {
        // The Mac App Store build is sandboxed and simply cannot open a PTY.
        // Apple's profile (/System/Library/Sandbox/Profiles/application.sb)
        // allows /dev/ptmx — the master — but gates the slave behind an
        // extension the app can't get:
        //     (allow file-read* file-write*
        //            (require-all (regex "^/dev/ttys[0-9]*")
        //                         (extension "com.apple.sandbox.pty")))
        // Only a PTY broker such as Terminal.app issues that extension, and no
        // entitlement grants it, so openpty() fails with EPERM. The UI hides
        // local terminals in store builds; this catches the paths that bypass it
        // (a restored layout, a synced session) with something better than a
        // bare "Operation not permitted (os error 1)".
        if option_env!("BALAUDECK_STORE_BUILD") == Some("1") {
            return Err("Local terminals aren't available in the App Store build — \
                        macOS sandboxing blocks apps from opening a terminal device. \
                        SSH connections work normally; for local shells use the direct \
                        download from github.com/okdii/balaudeck."
                .into());
        }
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        let shell = shell.filter(|s| !s.is_empty()).unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(shell.as_str());
        #[cfg(not(windows))]
        {
            // Run it as a login shell so it sources the system + user profile
            // (/etc/zprofile -> path_helper, ~/.zprofile, ~/.zshrc). A GUI app
            // launched from Finder inherits only the minimal launchd PATH, so a
            // non-login shell can't find Homebrew / /usr/local/bin tools like VS
            // Code's `code`. -l is understood by zsh, bash, fish and sh.
            cmd.arg("-l");
        }
        #[cfg(windows)]
        {
            // Windows has no login-shell concept and cmd.exe / PowerShell both
            // reject `-l`. Drop PowerShell's banner; Git Bash, on the other
            // hand, is a real Unix shell and needs -l to source ~/.bash_profile.
            let lower = shell.to_ascii_lowercase();
            if lower.contains("pwsh") || lower.contains("powershell") {
                cmd.arg("-NoLogo");
            } else if lower.contains("bash") {
                cmd.arg("-l");
            }
        }
        cmd.env("TERM", "xterm-256color");
        // Start in the user's home: USERPROFILE on Windows, HOME on Unix.
        if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
            cmd.cwd(home);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let id = Uuid::new_v4().to_string();
        let data_event = format!("local://data/{id}");
        let close_event = format!("local://close/{id}");
        let app2 = app.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = app2.emit(&data_event, buf[..n].to_vec());
                    }
                }
            }
            let _ = app2.emit(&close_event, ());
        });

        state
            .sessions
            .lock()
            .unwrap()
            .insert(id.clone(), Session { master: pair.master, writer, child });
        Ok(id)
    }

    #[tauri::command]
    pub fn local_write(state: State<'_, LocalState>, id: String, data: String) -> Result<(), String> {
        let mut map = state.sessions.lock().unwrap();
        let s = map.get_mut(&id).ok_or("session not found")?;
        s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        let _ = s.writer.flush();
        Ok(())
    }

    #[tauri::command]
    pub fn local_resize(
        state: State<'_, LocalState>,
        id: String,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        if let Some(s) = state.sessions.lock().unwrap().get(&id) {
            let _ = s
                .master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
        Ok(())
    }

    #[tauri::command]
    pub fn local_close(state: State<'_, LocalState>, id: String) -> Result<(), String> {
        if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
            let _ = s.child.kill();
        }
        Ok(())
    }
}

#[cfg(not(desktop))]
mod imp {
    use super::ShellOption;
    use tauri::State;

    #[derive(Default)]
    pub struct LocalState;

    /// Mobile has no local shell, so the picker gets an empty list.
    #[tauri::command]
    pub fn list_shells() -> Vec<ShellOption> {
        Vec::new()
    }

    #[tauri::command]
    pub fn local_open(
        _state: State<'_, LocalState>,
        _cols: u16,
        _rows: u16,
        _shell: Option<String>,
    ) -> Result<String, String> {
        Err("local terminal is only available on desktop".into())
    }

    #[tauri::command]
    pub fn local_write(_state: State<'_, LocalState>, _id: String, _data: String) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub fn local_resize(
        _state: State<'_, LocalState>,
        _id: String,
        _cols: u16,
        _rows: u16,
    ) -> Result<(), String> {
        Ok(())
    }

    #[tauri::command]
    pub fn local_close(_state: State<'_, LocalState>, _id: String) -> Result<(), String> {
        Ok(())
    }
}

pub use imp::*;
