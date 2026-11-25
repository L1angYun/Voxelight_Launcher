#![recursion_limit = "512"]
mod appearance;
mod assistant;
mod auth;
mod auth_commands;
mod auth_dto;
mod client_id;
mod commands;
mod content;
mod curseforge;
mod curseforge_key;
mod download_io;
mod downloads;
mod errors;
mod game_process;
mod instances;
mod integrity;
mod loaders;
mod minecraft;
mod memory;
mod models;
mod mod_metadata;
mod modpacks;
mod network;
mod network_check;
mod pack_update_plan;
mod parts;
mod path_grants;
mod platform;
mod request_pacing;
mod process_output;
mod processes;
mod resource_targets;
mod resources;
mod secrets;
mod server_manager;
mod servers;
mod source_select;
mod storage;
mod updates;

use std::{fs, path::Path};
use tauri::{Emitter, Manager};

fn show_startup_error(message: &str) {
    eprintln!("[voxelight/fatal] {message}");
    #[cfg(windows)]
    {
        use windows::{
            core::HSTRING,
            Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK},
        };
        let text = HSTRING::from(message);
        let caption = HSTRING::from("Voxelight Launcher");
        unsafe {
            MessageBoxW(None, &text, &caption, MB_OK | MB_ICONERROR);
        }
    }
}

fn fail_startup(message: String) -> ! {
    show_startup_error(&message);
    std::process::exit(1);
}

fn quarantine_webview_profile(path: &Path) -> bool {
    if !path.exists() {
        return true;
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let timestamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%3f");
    let backup = parent.join(format!("webview-old-{timestamp}"));
    match fs::rename(path, &backup) {
        Ok(()) => {
            eprintln!(
                "[voxelight/webview] moved locked profile {} to {}",
                path.display(),
                backup.display()
            );
            return true;
        }
        Err(error) => {
            eprintln!(
                "[voxelight/webview] could not move profile {}: {error}; deleting it",
                path.display()
            );
        }
    }
    let removed = if path.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    match removed {
        Ok(()) => {
            eprintln!(
                "[voxelight/webview] deleted locked profile {}",
                path.display()
            );
            true
        }
        Err(error) => {
            eprintln!(
                "[voxelight/webview] could not delete profile {}: {error}",
                path.display()
            );
            false
        }
    }
}

/// `voxelight-launcher.exe --update-helper`: the update hand-off helper.
/// Returns the process exit code; it never opens the profile or a window.
pub fn run_update_helper() -> i32 {
    updates::helper::main()
}

pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = match storage::LauncherState::load() {
                Ok(state) => state,
                Err(error) => {
                    let message = match error.in_use_detail() {
                        Some((path, primary)) => integrity::profile_in_use(path, primary.as_deref()),
                        None => integrity::data_directory_failure(&error.to_string()),
                    };
                    fail_startup(message)
                }
            };
            let webview_data = state.data_dir.join("webview");
            let config = state.snapshot().unwrap_or_else(|error| fail_startup(error)).config;
            let auth = std::sync::Arc::new(auth::AuthService::new(state.data_dir.clone(), &config));
            if let Err(error) = auth.recover_credential_removals(&state) {
                eprintln!("[voxelight/auth] deferred credential cleanup: {error}");
            }
            let state = std::sync::Arc::new(state);
            state.control.bind_events(app.handle().clone());
            app.manage(state.games.clone());
            app.manage(std::sync::Arc::new(
                server_manager::ServerRegistry::default(),
            ));
            app.manage(path_grants::PathGrants::default());
            app.manage(std::sync::Arc::new(assistant::McpService::default()));
            app.manage(std::sync::Arc::new(updates::UpdateService::default()));
            tauri::async_runtime::spawn_blocking(updates::sweep::sweep_on_startup);
            {
                // Parts nobody resumed for a week, then the oldest above 4 GiB (U0266).
                let (data_dir, game_directory) = (state.data_dir.clone(), config.game_directory.clone());
                tauri::async_runtime::spawn_blocking(move || {
                    let game_root = processes::configured_game_root(Path::new(&game_directory)).ok();
                    parts::sweep_on_startup(parts::startup_stores(&data_dir, game_root.as_deref()));
                });
            }
            app.manage(state.clone());
            #[cfg(windows)]
            if let Ok(snapshot) = state.snapshot() {
                tauri::async_runtime::spawn_blocking(move || {
                    process_output::sweep_stale_scratch(&snapshot);
                });
            }
            app.manage(auth);
            let window_config = match app.config().app.windows.first().cloned() {
                Some(config) => config,
                None => fail_startup(
                    "启动器窗口配置缺失。请重新安装 Voxelight Launcher。".into(),
                ),
            };
            let build_window = |profile: Option<&Path>| -> Result<(), String> {
                let builder = tauri::WebviewWindowBuilder::from_config(
                    app,
                    &window_config,
                )
                .map_err(|error| format!("准备主窗口失败：{error}"))?;
                let builder = match profile {
                    Some(path) => builder.data_directory(path.to_path_buf()),
                    None => builder,
                };
                let window = builder
                    .build()
                    .map_err(|error| format!("创建主窗口失败：{error}"))?;
                let handle = app.handle().clone();
                let label = window.label().to_string();
                let target = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::DragDrop(drop_event) = event {
                        match drop_event {
                            tauri::DragDropEvent::Enter { paths, .. } => {
                                let _ = target.emit(
                                    "launcher://file-drag",
                                    serde_json::json!({ "active": true, "count": paths.len() }),
                                );
                            }
                            tauri::DragDropEvent::Leave => {
                                let _ = target.emit(
                                    "launcher://file-drag",
                                    serde_json::json!({ "active": false, "count": 0 }),
                                );
                            }
                            tauri::DragDropEvent::Drop { paths, .. } => {
                                let _ = target.emit(
                                    "launcher://file-drag",
                                    serde_json::json!({ "active": false, "count": 0 }),
                                );
                                let grants = handle.state::<path_grants::PathGrants>();
                                let dropped = grants.grant_dropped(paths, &label);
                                let _ = target.emit("launcher://file-drop", dropped);
                            }
                            _ => {}
                        }
                    }
                });
                Ok(())
            };
            let destroy_partial_window = || {
                if let Some(window) = app.get_webview_window(&window_config.label) {
                    let _ = window.destroy();
                }
            };

            eprintln!(
                "[voxelight/setup] creating WebView2 profile at {}",
                webview_data.display()
            );
            if let Err(first_error) = build_window(Some(&webview_data)) {
                eprintln!(
                    "[voxelight/setup] WebView2 profile attempt failed: {first_error}"
                );
                destroy_partial_window();
                let local_profile_fresh = quarantine_webview_profile(&webview_data);
                let retry_profile = if local_profile_fresh {
                    webview_data.clone()
                } else {
                    webview_data.with_file_name(format!(
                        "webview-recovery-{}",
                        uuid::Uuid::new_v4()
                    ))
                };
                eprintln!(
                    "[voxelight/setup] retrying with fresh local WebView2 profile {}",
                    retry_profile.display()
                );
                if let Err(retry_error) = build_window(Some(&retry_profile)) {
                    eprintln!(
                        "[voxelight/setup] fresh local profile failed: {retry_error}"
                    );
                    destroy_partial_window();
                    eprintln!(
                        "[voxelight/setup] retrying with the default WebView2 profile"
                    );
                    if let Err(default_error) = build_window(None) {
                        destroy_partial_window();
                        fail_startup(format!(
                            "无法创建启动器窗口。\n\n本地配置：{first_error}\n重建配置：{retry_error}\n系统默认配置：{default_error}\n\n请关闭残留的 msedgewebview2.exe 进程，或重启 Windows 后重试。"
                        ));
                    }
                }
            }
            if let Err(error) = platform::start_system_appearance_watcher(app.handle()) {
                eprintln!(
                    "[voxelight/setup] appearance watcher unavailable; continuing without live system appearance updates: {error}"
                );
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            path_grants::choose_launcher_path,
            commands::bootstrap,
            commands::get_config,
            memory::get_memory_overview,
            commands::save_config,
            commands::set_tour_completed,
            commands::save_appearance_config,
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
            resources::resolve_resource_targets,
            resources::create_instance_for_resource,
            resources::get_resource_context,
            resources::get_modrinth_project_details,
            curseforge::get_curseforge_project_details,
            resources::list_local_resources,
            resources::read_local_mod_icon,
            resources::toggle_resource,
            resources::delete_local_resources,
            resources::check_resource_updates,
            resources::update_resource,
            resources::list_resource_update_history,
            resources::rollback_resource_update,
            resources::recover_resource_update,
            auth_commands::begin_microsoft_login,
            auth_commands::poll_microsoft_login,
            auth_commands::cancel_auth_login,
            auth_commands::login_authlib,
            auth_commands::select_authlib_profile,
            auth_commands::refresh_account,
            auth_commands::get_player_profile,
            auth_commands::read_skin_preview,
            auth_commands::upload_account_skin,
            auth_commands::reset_account_skin,
            auth_commands::select_account_cape,
            auth_commands::set_service_secret,
            auth_commands::get_service_status,
            network::test_proxy_connection,
            source_select::get_download_source_verdict,
            updates::check_launcher_update,
            updates::get_launcher_update_state,
            updates::set_launcher_update_preferences,
            updates::download_launcher_update,
            updates::cancel_launcher_update,
            updates::install_launcher_update_and_exit,
            network::set_proxy_credentials,
            loaders::list_loader_versions,
            loaders::install_loader,
            loaders::install_optifine_installer,
            downloads::reserve_launch_task,
            resources::reserve_resource_task,
            downloads::list_download_tasks,
            downloads::set_download_paused,
            downloads::cancel_download_task,
            downloads::queue_install,
            downloads::retry_download_task,
            downloads::retry_failed_downloads,
            downloads::clear_unfinished_downloads,
            instances::update_instance,
            instances::change_instance_loader,
            instances::clone_instance,
            instances::backup_instance,
            instances::list_instance_backups,
            instances::restore_instance_backup,
            instances::recover_instance_restore,
            instances::export_instance_zip,
            modpacks::list_modpack_versions,
            modpacks::list_curseforge_modpack_versions,
            modpacks::pack_update::check_modpack_update,
            modpacks::pack_update::plan_modpack_update,
            modpacks::pack_update::apply_modpack_update,
            modpacks::import_modpack,
            modpacks::install_modrinth_modpack,
            modpacks::install_curseforge_modpack,
            modpacks::plan_modrinth_export,
            modpacks::export_modrinth_modpack,
            processes::list_running_games,
            processes::stop_game,
            processes::diagnose_instance,
            processes::read_game_log,
            processes::export_diagnostics,
            servers::list_servers,
            servers::save_server,
            servers::remove_server,
            servers::ping_server,
            servers::discover_lan,
            network_check::check_network_environment,
            server_manager::list_managed_servers,
            server_manager::create_managed_server,
            server_manager::update_managed_server,
            server_manager::set_managed_server_eula,
            server_manager::start_managed_server,
            server_manager::stop_managed_server,
            server_manager::send_managed_server_command,
            server_manager::read_managed_server_logs,
            server_manager::import::inspect_server_import,
            server_manager::import::import_managed_server,
            minecraft::install_java,
            content::get_default_skin,
            content::list_worlds,
            content::backup_world,
            content::import_world,
            content::list_world_datapacks,
            content::import_world_datapacks,
            content::toggle_world_datapack,
            content::delete_world_datapack,
            content::list_screenshots,
            content::read_screenshot,
            content::import_local_resources,
            curseforge::search_curseforge,
            curseforge::install_curseforge_resource,
            appearance::get_launcher_background,
            appearance::set_launcher_background,
            appearance::export_launcher_config,
            appearance::import_launcher_config,
            assistant::get_assistant_status,
            assistant::set_assistant_api_key,
            assistant::assistant_chat,
            assistant::start_mcp_server,
            assistant::stop_mcp_server,
            assistant::rotate_mcp_token,
            assistant::get_mcp_token,
            platform::get_system_appearance,
        ])
        .build(tauri::generate_context!())
        .map(|app| app.run(|handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(mcp) = handle.try_state::<std::sync::Arc<assistant::McpService>>() {
                    mcp.stop();
                }
                if let Some(state) = handle.try_state::<std::sync::Arc<storage::LauncherState>>() {
                    state.control.unbind_events();
                }
            }
        }));
    if let Err(error) = result {
        fail_startup(format!("Voxelight Launcher 启动失败。\n\n{error}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_profile_is_quarantined_before_retry() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/core-tests")
            .join(format!("webview-recovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let profile = root.join("webview");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("locked"), b"synthetic").unwrap();

        assert!(quarantine_webview_profile(&profile));
        assert!(!profile.exists());
        let backups = fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("webview-old-")
            })
            .count();
        assert_eq!(backups, 1);

        fs::remove_dir_all(root).unwrap();
    }
}
