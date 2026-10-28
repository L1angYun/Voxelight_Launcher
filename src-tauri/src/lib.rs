#![recursion_limit = "512"]
mod appearance;
mod auth;
mod auth_commands;
mod auth_dto;
mod commands;
mod content;
mod curseforge;
mod downloads;
mod errors;
mod instances;
mod loaders;
mod minecraft;
mod models;
mod modpacks;
mod platform;
mod processes;
mod resources;
mod secrets;
mod server_manager;
mod servers;
mod storage;

use tauri::{Emitter, Listener, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = storage::LauncherState::load()?;
            let webview_data = state.data_dir.join("webview");
            let auth = std::sync::Arc::new(auth::AuthService::new(state.data_dir.clone())?);
            let state = std::sync::Arc::new(state);
            let progress_state = state.clone();
            let progress_app = app.handle().clone();
            app.listen("launcher://progress", move |event| {
                if let Ok(progress) = serde_json::from_str(event.payload()) {
                    progress_state.control.record(&progress);
                    let _ = progress_app.emit("launcher://tasks", progress_state.control.list());
                }
            });
            app.manage(state.games.clone());
            app.manage(std::sync::Arc::new(
                server_manager::ServerRegistry::default(),
            ));
            app.manage(state);
            app.manage(auth);
            // Keep WebView2's writable profile beside this installation's state,
            // including during isolated tests or portable data-directory overrides.
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(webview_data)
                .build()?;
            platform::start_system_appearance_watcher(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::get_config,
            commands::save_config,
            commands::list_versions,
            commands::scan_versions,
            commands::detect_java,
            commands::create_instance,
            commands::remove_instance,
            commands::add_offline_account,
            commands::select_account,
            commands::remove_account,
            commands::install_version,
            commands::launch_game,
            commands::open_folder,
            commands::start_microsoft_login,
            resources::install_resource,
            resources::get_modrinth_project_details,
            curseforge::get_curseforge_project_details,
            resources::list_local_resources,
            resources::toggle_resource,
            resources::check_resource_updates,
            resources::update_resource,
            resources::list_resource_update_history,
            resources::rollback_resource_update,
            auth_commands::begin_microsoft_login,
            auth_commands::poll_microsoft_login,
            auth_commands::cancel_auth_login,
            auth_commands::login_authlib,
            auth_commands::select_authlib_profile,
            auth_commands::refresh_account,
            auth_commands::get_player_profile,
            auth_commands::upload_account_skin,
            auth_commands::reset_account_skin,
            auth_commands::select_account_cape,
            auth_commands::set_service_secret,
            auth_commands::get_service_status,
            loaders::list_loader_versions,
            loaders::install_loader,
            downloads::list_download_tasks,
            downloads::set_download_paused,
            downloads::cancel_download_task,
            downloads::queue_install,
            downloads::retry_download_task,
            instances::update_instance,
            instances::clone_instance,
            instances::backup_instance,
            instances::list_instance_backups,
            instances::restore_instance_backup,
            instances::export_instance_zip,
            modpacks::list_modpack_versions,
            modpacks::import_modpack,
            modpacks::install_modrinth_modpack,
            modpacks::export_modrinth_modpack,
            processes::list_running_games,
            processes::stop_game,
            processes::diagnose_instance,
            processes::export_diagnostics,
            servers::list_servers,
            servers::save_server,
            servers::remove_server,
            servers::ping_server,
            servers::discover_lan,
            server_manager::list_managed_servers,
            server_manager::create_managed_server,
            server_manager::update_managed_server,
            server_manager::set_managed_server_eula,
            server_manager::start_managed_server,
            server_manager::stop_managed_server,
            server_manager::send_managed_server_command,
            server_manager::read_managed_server_logs,
            minecraft::install_java,
            content::get_default_skin,
            content::list_worlds,
            content::backup_world,
            content::import_world,
            content::list_screenshots,
            content::read_screenshot,
            content::import_local_resources,
            curseforge::search_curseforge,
            curseforge::install_curseforge_resource,
            appearance::get_launcher_background,
            appearance::set_launcher_background,
            appearance::export_launcher_config,
            appearance::import_launcher_config,
            platform::get_system_appearance,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Voxelight Launcher");
}
