mod db;
mod profiles;
mod sftp;
mod ssh;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ssh::SshState::default())
        .manage(sftp::SftpState::default())
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
            sftp::sftp_connect,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
