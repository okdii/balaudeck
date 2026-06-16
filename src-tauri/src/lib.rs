mod db;
mod profiles;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ssh::SshState::default())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_open_shell,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_close,
            db::db_query,
            profiles::profiles_load,
            profiles::ssh_profile_save,
            profiles::ssh_profile_delete,
            profiles::db_profile_save,
            profiles::db_profile_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
