mod db;
mod gdrive;
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
    let builder = builder
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_deep_link::init());

    builder
        .manage(ssh::SshState::default())
        .manage(sftp::SftpState::default())
        .manage(tunnel::TunnelState::default())
        .manage(local::LocalState::default())
        .manage(gdrive::GdriveState::default())
        .setup(|app| {
            profiles::init_secret_store(app.handle());
            // On mobile, the Google OAuth redirect returns via a custom URL
            // scheme; finish the exchange in gdrive when the app is opened by it.
            #[cfg(mobile)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let handle = handle.clone();
                    let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                    tauri::async_runtime::spawn(async move {
                        for url in urls {
                            gdrive::handle_deep_link(&handle, &url).await;
                        }
                    });
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_open_shell,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_exec,
            ssh::ssh_close,
            db::db_query,
            db::db_exec_batch,
            db::db_disconnect,
            db::db_dump,
            db::db_job_control,
            db::db_import_file,
            db::db_schema_objects,
            profiles::profiles_load,
            profiles::read_text_file,
            profiles::ssh_profile_save,
            profiles::ssh_profile_delete,
            profiles::db_profile_save,
            profiles::db_profile_delete,
            profiles::sftp_profile_save,
            profiles::sftp_profile_delete,
            profiles::tunnel_profile_save,
            profiles::tunnel_profile_delete,
            profiles::folder_create,
            profiles::folder_rename,
            profiles::folder_delete,
            profiles::folder_move,
            profiles::profile_set_folder,
            profiles::query_save,
            profiles::query_delete,
            profiles::note_save,
            profiles::note_delete,
            profiles::connections_export,
            profiles::connections_import,
            profiles::write_text_file,
            profiles::local_listdir,
            profiles::current_platform,
            sftp::sftp_connect,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_chmod,
            sftp::sftp_remove,
            sftp::sftp_close,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_list,
            local::local_open,
            local::local_write,
            local::local_resize,
            local::local_close,
            gdrive::gdrive_auth_status,
            gdrive::gdrive_auth_start,
            gdrive::gdrive_auth_disconnect,
            gdrive::gdrive_set_auto_sync,
            gdrive::gdrive_sync_push,
            gdrive::gdrive_sync_pull,
            gdrive::gdrive_auto_push,
            gdrive::gdrive_auto_pull,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
