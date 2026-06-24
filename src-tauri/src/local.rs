//! Local shell terminal via a PTY. Desktop only — mobile platforms cannot
//! spawn arbitrary processes, so there the commands return an error.

#[cfg(desktop)]
mod imp {
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

    /// Spawn the user's login shell in a PTY and stream output via
    /// `local://data/<id>` events. Returns the session id.
    #[tauri::command]
    pub fn local_open(
        app: AppHandle,
        state: State<'_, LocalState>,
        cols: u16,
        rows: u16,
        shell: Option<String>,
    ) -> Result<String, String> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;

        let shell = shell
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/sh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        // Run it as a login shell so it sources the system + user profile
        // (/etc/zprofile -> path_helper, ~/.zprofile, ~/.zshrc). A GUI app
        // launched from Finder inherits only the minimal launchd PATH, so a
        // non-login shell can't find Homebrew / /usr/local/bin tools like VS
        // Code's `code`. -l is understood by zsh, bash, fish and sh.
        cmd.arg("-l");
        cmd.env("TERM", "xterm-256color");
        if let Ok(home) = std::env::var("HOME") {
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
    use tauri::State;

    #[derive(Default)]
    pub struct LocalState;

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
