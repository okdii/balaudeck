mod ai;
mod db;
mod engines;
mod gdrive;
mod local;
mod mongo;
mod rediskv;
mod profiles;
mod s3;
mod sftp;
mod ssh;
mod storeupdate;
mod transfers;
mod tunnel;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Write the system clipboard from terminal output (OSC 52) and from the
        // terminal's copy shortcut. A plugin (Rust-side) write works without a
        // user gesture — which navigator.clipboard can't guarantee — and works
        // on iOS/Android too.
        .plugin(tauri_plugin_clipboard_manager::init());

    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_deep_link::init());

    // Desktop self-updater (direct .dmg/.msi builds). The Mac App Store / Play
    // Store disallow self-updating, so the frontend never invokes it in store
    // builds (gated by BALAUDECK_STORE_BUILD at bundle time).
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

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
            ssh::ssh_write_secret,
            ssh::ssh_resize,
            ssh::ssh_exec,
            ssh::ssh_close,
            db::db_query,
            db::db_exec_batch,
            db::db_tx_begin,
            db::db_tx_exec,
            db::db_tx_commit,
            db::db_tx_rollback,
            db::db_disconnect,
            db::db_list_databases,
            db::db_primary_key,
            db::db_foreign_keys,
            db::db_exec_ddl,
            db::db_table_schema,
            db::db_list_users,
            db::db_user_detail,
            db::db_exec_user_sql,
            db::db_dump,
            db::db_job_control,
            db::db_import_file,
            db::db_schema_objects,
            ai::ai_complete,
            ai::ai_key_save,
            ai::ai_key_exists,
            ai::ai_ollama_models,
            mongo::mongo_databases,
            mongo::mongo_collections,
            mongo::mongo_find,
            mongo::mongo_count,
            mongo::mongo_insert,
            mongo::mongo_delete,
            mongo::mongo_replace,
            rediskv::redis_scan,
            rediskv::redis_get,
            rediskv::redis_command,
            rediskv::redis_info,
            rediskv::redis_set,
            rediskv::redis_del,
            rediskv::redis_expire,
            s3::s3_list_buckets,
            s3::s3_create_bucket,
            s3::s3_delete_bucket,
            s3::s3_list_objects,
            s3::s3_upload,
            s3::s3_download,
            s3::s3_delete_object,
            s3::s3_delete_prefix,
            s3::s3_create_folder,
            s3::s3_preview,
            s3::s3_copy_object,
            s3::s3_copy_prefix,
            profiles::profiles_load,
            profiles::read_text_file,
            profiles::secret_exists,
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
            profiles::profile_duplicate,
            profiles::query_save,
            profiles::query_delete,
            profiles::note_save,
            profiles::note_delete,
            profiles::connections_export,
            profiles::connections_import,
            profiles::write_text_file,
            profiles::local_listdir,
            profiles::current_platform,
            storeupdate::store_latest_version,
            sftp::sftp_connect,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_download_dir,
            sftp::sftp_preview,
            sftp::sftp_upload,
            sftp::sftp_upload_dir,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_chmod,
            sftp::sftp_remove,
            sftp::sftp_close,
            transfers::transfer_cancel,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_list,
            local::local_open,
            local::list_shells,
            local::local_write,
            local::local_resize,
            local::local_close,
            local::local_exec,
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
