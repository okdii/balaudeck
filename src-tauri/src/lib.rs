mod db;
mod local;
mod profiles;
mod sftp;
mod ssh;
mod tunnel;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_biometric::init());

    builder
        .manage(ssh::SshState::default())
        .manage(sftp::SftpState::default())
        .manage(tunnel::TunnelState::default())
        .manage(local::LocalState::default())
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_open_shell,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_close,
            db::db_query,
            profiles::profiles_load,
            profiles::read_text_file,
            profiles::ssh_profile_save,
            profiles::ssh_profile_delete,
            profiles::db_profile_save,
            profiles::db_profile_delete,
            profiles::folder_create,
            profiles::folder_rename,
            profiles::folder_delete,
            profiles::folder_move,
            profiles::profile_set_folder,
            sftp::sftp_connect,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_close,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_list,
            local::local_open,
            local::local_write,
            local::local_resize,
            local::local_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
