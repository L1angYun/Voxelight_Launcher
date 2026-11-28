// SPDX-License-Identifier: GPL-3.0-only
pub mod args;
pub mod install_runner;
pub mod path_check;
pub mod payload;
pub mod platform;
pub mod process_scan;
pub mod registry;
pub mod webview2;
pub mod webview_profile;

use install_runner::{InstallFailure, InstallOutcome, InstallRequest};
use path_check::{validate_install_path as check_path, PathValidation, SystemPathProbe};
use payload::{
    ordinary_file, run_payload_passthrough, should_show_startup_error, SystemPayloadRunner,
    EXPECTED_INSTALL_BYTES, PAYLOAD_BYTES, PAYLOAD_SHA256, PAYLOAD_START_FAILURE_EXIT_CODE,
};
use platform::{
    current_system_appearance, initial_window_background, is_process_elevated, launch_available,
    SystemAppearance,
};
use registry::{detect_existing_install, DetectedInstall};
use serde::Serialize;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};
use tauri_plugin_dialog::DialogExt;

pub const LAUNCHER_VERSION: &str = env!("VOXELIGHT_LAUNCHER_VERSION");

/// Compiled-in proof that this executable is Voxelight Setup rather than the
/// raw NSIS payload. `scripts/release-metadata.mjs` refuses to publish a file
/// without this marker. Keep the two strings in sync.
pub const SETUP_BINARY_MARKER: &str = "VOXELIGHT_SETUP_HOST_V1";
const GPL3_LICENSE_TEXT: &str = include_str!("../../../LICENSE");

#[derive(Default)]
struct SetupState {
    installing: AtomicBool,
    /// Set by `open_classic_installer`; `run_ui` then hands over to the NSIS UI.
    classic_installer: AtomicBool,
    installed_exe: Mutex<Option<PathBuf>>,
    webview_temp_dir: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupBootstrap {
    pub version: String,
    pub appearance: SystemAppearance,
    pub detected: DetectedInstall,
    pub validation: PathValidation,
    pub expected_install_bytes: u64,
    /// False when Setup is elevated and therefore cannot start the launcher
    /// with the user's normal token.
    pub launch_available: bool,
}

#[tauri::command]
fn get_setup_state() -> SetupBootstrap {
    let appearance = current_system_appearance();
    let detected = detect_existing_install(LAUNCHER_VERSION);
    let validation = check_path(
        &detected.install_dir,
        EXPECTED_INSTALL_BYTES,
        &SystemPathProbe,
    );
    SetupBootstrap {
        version: LAUNCHER_VERSION.to_owned(),
        appearance,
        detected,
        validation,
        expected_install_bytes: EXPECTED_INSTALL_BYTES,
        launch_available: launch_available(is_process_elevated()),
    }
}

#[tauri::command]
fn get_license_text() -> String {
    GPL3_LICENSE_TEXT.to_owned()
}

#[tauri::command]
fn validate_install_path(path: String) -> PathValidation {
    check_path(&path, EXPECTED_INSTALL_BYTES, &SystemPathProbe)
}

#[tauri::command]
async fn pick_install_directory(
    app: tauri::AppHandle,
    current_dir: Option<String>,
) -> Result<Option<String>, String> {
    let initial = current_dir
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .and_then(|path| {
            path.ancestors()
                .find(|ancestor| ancestor.is_dir())
                .map(PathBuf::from)
        });

    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(dir) = initial {
            dialog = dialog.set_directory(dir);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|error| error.to_string())?;

    let Some(file_path) = picked else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|error| format!("Could not resolve selected folder: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn start_install(
    app: tauri::AppHandle,
    state: State<'_, Arc<SetupState>>,
    request: InstallRequest,
) -> Result<InstallOutcome, InstallFailure> {
    if state
        .installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(InstallFailure {
            code: "alreadyInstalling".into(),
            phase: "extract".into(),
            exit_code: None,
            detail: "An installation is already running.".into(),
        });
    }

    let shared = state.inner().clone();
    let emit_handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        install_runner::run_interactive_install(&request, LAUNCHER_VERSION, |progress| {
            let _ = emit_handle.emit("setup://install-progress", progress);
        })
    })
    .await
    .unwrap_or_else(|error| {
        Err(InstallFailure {
            code: "spawnFailed".into(),
            phase: "install".into(),
            exit_code: None,
            detail: format!("Installer worker panicked: {error}"),
        })
    });

    shared.installing.store(false, Ordering::SeqCst);
    if let Ok(ref outcome) = result {
        if let Ok(mut guard) = shared.installed_exe.lock() {
            *guard = Some(PathBuf::from(&outcome.executable_path));
        }
    }
    result
}

/// Closes Setup and runs the embedded NSIS installer with its own pages.
///
/// The way out when an existing installation's folder can no longer be used:
/// Setup keeps that folder (its silent run would leave the old copy behind),
/// while the NSIS reinstall page can remove the old copy and its directory
/// page accepts another folder. `main` runs the payload once the window is gone.
#[tauri::command]
fn open_classic_installer(
    app: tauri::AppHandle,
    state: State<'_, Arc<SetupState>>,
) -> Result<(), InstallFailure> {
    // Claim the install slot for good: no Setup install may start while the
    // event loop shuts down, and none may be running now.
    if state
        .installing
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(InstallFailure {
            code: "alreadyInstalling".into(),
            phase: "preflight".into(),
            exit_code: None,
            detail: "An installation is already running.".into(),
        });
    }
    state.classic_installer.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn launch_installed(state: State<'_, Arc<SetupState>>) -> Result<(), String> {
    if !launch_available(is_process_elevated()) {
        return Err(
            "launchBlockedElevated: Setup is running as administrator, so it cannot start \
             Voxelight Launcher with your normal user rights. Open the launcher from the \
             Start menu instead."
                .to_owned(),
        );
    }
    let exe_path = state
        .installed_exe
        .lock()
        .map_err(|_| "Installer state unavailable".to_owned())?
        .clone()
        .ok_or_else(|| "No installed launcher path recorded.".to_owned())?;

    if !ordinary_file(&exe_path) {
        return Err("Installed launcher executable could not be found.".to_owned());
    }

    let mut command = Command::new(&exe_path);
    if let Some(parent) = exe_path.parent() {
        command.current_dir(parent);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|error| format!("Could not start Voxelight Launcher: {error}"))?;
    Ok(())
}

/// Runs the embedded NSIS payload directly (for NSIS CLI passthrough or WebView2 fallback).
pub fn run_embedded_payload(args: &[OsString]) -> i32 {
    run_embedded_payload_inner(args, None)
}

/// Runs the payload with the untouched command line after Setup's program name.
pub fn run_embedded_payload_raw(raw_args: &str, args: &[OsString]) -> i32 {
    run_embedded_payload_inner(args, Some(raw_args))
}

fn run_embedded_payload_inner(args: &[OsString], raw_args: Option<&str>) -> i32 {
    let base_temp = std::env::temp_dir();
    match run_payload_passthrough(
        &base_temp,
        PAYLOAD_BYTES,
        PAYLOAD_SHA256,
        args,
        raw_args,
        &SystemPayloadRunner,
    ) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("[voxelight-setup] payload failed: {error}");
            if should_show_startup_error(args, raw_args) {
                show_fatal_error(&format!("Voxelight Setup could not start.\n\n{error}"));
            }
            // Never reuse NSIS's 1 ("the user cancelled").
            PAYLOAD_START_FAILURE_EXIT_CODE
        }
    }
}

fn show_fatal_error(message: &str) {
    #[cfg(windows)]
    {
        use windows::{
            core::HSTRING,
            Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK},
        };
        let text = HSTRING::from(message);
        let caption = HSTRING::from("Voxelight Setup");
        unsafe {
            MessageBoxW(None, &text, &caption, MB_OK | MB_ICONERROR);
        }
    }
    #[cfg(not(windows))]
    {
        eprintln!("[voxelight-setup/fatal] {message}");
    }
}

/// Records the first fatal window-initialization error without returning `Err`
/// from Tauri's setup callback: Tauri 2.12.5 turns a setup `Err` into
/// `panic!("Failed to setup app")`, and the release profile is `panic = "abort"`,
/// which would kill Setup before the NSIS fallback could run.
#[derive(Debug, Default)]
struct WindowFailure {
    message: Mutex<Option<String>>,
}

impl WindowFailure {
    fn record(&self, message: String) {
        if let Ok(mut guard) = self.message.lock() {
            if guard.is_none() {
                *guard = Some(message);
            }
        }
    }

    fn take(&self) -> Option<String> {
        self.message.lock().ok().and_then(|mut guard| guard.take())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum UiOutcome {
    /// The window ran and was closed normally.
    Closed,
    /// The window could not be created (usually a broken WebView2 runtime).
    /// The caller must run the embedded NSIS payload with its normal UI.
    WindowFailed(String),
    /// The user chose the classic installer. The caller must run the embedded
    /// NSIS payload with its normal UI.
    ClassicInstaller,
}

fn ui_outcome(failure: &WindowFailure, classic_requested: bool) -> UiOutcome {
    match failure.take() {
        Some(message) => UiOutcome::WindowFailed(message),
        None if classic_requested => UiOutcome::ClassicInstaller,
        None => UiOutcome::Closed,
    }
}

fn build_setup_window(
    app: &mut tauri::App,
    state: &Arc<SetupState>,
) -> Result<(), String> {
    let window_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "Missing setup window configuration.".to_owned())?;

    // A private profile is mandatory: without it Tauri/WebView2 would fall back
    // to %LOCALAPPDATA%\dev.voxelight.setup and leave user data behind.
    let webview_temp = webview_profile::create_webview_profile(&std::env::temp_dir())?;
    if let Ok(mut guard) = state.webview_temp_dir.lock() {
        *guard = Some(webview_temp.clone());
    }

    let window = tauri::WebviewWindowBuilder::from_config(app, &window_config)
        .map_err(|error| error.to_string())?
        .background_color(initial_window_background())
        .data_directory(webview_temp)
        .build()
        .map_err(|error| error.to_string())?;

    let installing_guard = state.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if installing_guard.installing.load(Ordering::SeqCst) {
                api.prevent_close();
            }
        }
    });

    let _ = platform::start_system_appearance_watcher(app.handle());
    Ok(())
}

/// Launches the Tauri Setup UI.
///
/// A window failure is not returned as `Err` from the setup callback (Tauri
/// would panic). Instead it is recorded, the event loop is asked to exit with
/// `run_return`, and the returned outcome tells `main` to run the NSIS UI.
pub fn run_ui() -> Result<UiOutcome, String> {
    let state = Arc::new(SetupState::default());
    let state_for_setup = state.clone();
    let state_for_exit = state.clone();
    let failure = Arc::new(WindowFailure::default());
    let failure_for_setup = failure.clone();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(move |app| {
            if let Err(error) = build_setup_window(app, &state_for_setup) {
                eprintln!("[voxelight-setup] UI initialization failed: {error}");
                failure_for_setup.record(error);
                // Ask the event loop to stop; run_return then gives control
                // back to main so it can start the NSIS UI fallback.
                app.handle().exit(0);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_setup_state,
            get_license_text,
            validate_install_path,
            pick_install_directory,
            start_install,
            open_classic_installer,
            launch_installed,
        ])
        .build(tauri::generate_context!())
        .map_err(|error| error.to_string())?;

    let _ = app.run_return(|_handle, _event| {});

    if let Ok(mut guard) = state_for_exit.webview_temp_dir.lock() {
        if let Some(dir) = guard.take() {
            if !webview_profile::cleanup_webview_profile(&dir) {
                eprintln!(
                    "[voxelight-setup] could not remove the temporary WebView2 profile: {}",
                    dir.display()
                );
            }
        }
    }

    let classic_requested = state_for_exit.classic_installer.load(Ordering::SeqCst);
    Ok(ui_outcome(&failure, classic_requested))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_failure_requests_the_nsis_fallback() {
        let failure = WindowFailure::default();
        assert_eq!(ui_outcome(&failure, false), UiOutcome::Closed);

        failure.record("WebView2 runtime is corrupt".to_owned());
        assert_eq!(
            ui_outcome(&failure, false),
            UiOutcome::WindowFailed("WebView2 runtime is corrupt".to_owned())
        );
        assert_eq!(
            ui_outcome(&failure, false),
            UiOutcome::Closed,
            "the recorded failure is consumed once"
        );
    }

    #[test]
    fn choosing_the_classic_installer_hands_over_to_nsis() {
        let failure = WindowFailure::default();
        assert_eq!(ui_outcome(&failure, true), UiOutcome::ClassicInstaller);

        failure.record("WebView2 runtime is corrupt".to_owned());
        assert_eq!(
            ui_outcome(&failure, true),
            UiOutcome::WindowFailed("WebView2 runtime is corrupt".to_owned()),
            "a window failure keeps its own fallback message"
        );
    }

    #[test]
    fn only_the_first_window_failure_is_kept() {
        let failure = WindowFailure::default();
        failure.record("first".to_owned());
        failure.record("second".to_owned());
        assert_eq!(
            ui_outcome(&failure, false),
            UiOutcome::WindowFailed("first".to_owned())
        );
    }
}
