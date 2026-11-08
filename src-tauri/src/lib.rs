#![recursion_limit = "512"]
mod appearance;
mod auth;
mod auth_commands;
mod auth_dto;
mod client_id;
mod commands;
mod content;
mod curseforge;
mod downloads;
mod errors;
mod instances;
mod integrity;
mod loaders;
mod minecraft;
mod models;
mod modpacks;
mod platform;
mod processes;
mod resource_targets;
mod resources;
mod secrets;
mod server_manager;
mod servers;
mod storage;

use std::{fs, path::Path};
use tauri::{Emitter, Listener, Manager};

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

pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = match storage::LauncherState::load() {
                Ok(state) => state,
                Err(error) => fail_startup(integrity::data_directory_failure(&error.to_string())),
            };
            let webview_data = state.data_dir.join("webview");
            let auth = match auth::AuthService::new(state.data_dir.clone()) {
                Ok(auth) => std::sync::Arc::new(auth),
                Err(error) => fail_startup(format!(
                    "无法初始化认证服务。\n\n{error}"
                )),
            };
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
                builder
                    .build()
                    .map(|_| ())
                    .map_err(|error| format!("创建主窗口失败：{error}"))
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
            resources::resolve_resource_targets,
            resources::create_instance_for_resource,
            resources::get_resource_context,
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
        .run(tauri::generate_context!());
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
