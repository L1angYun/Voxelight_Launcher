// SPDX-License-Identifier: GPL-3.0-only
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::OsString;
use voxelight_setup_lib::webview2::{decide_startup_action, StartupAction};

#[cfg(windows)]
const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetDefaultDllDirectories(directory_flags: u32) -> i32;
}

fn fall_back_to_nsis(error: &str) -> ! {
    eprintln!("[voxelight-setup] {error}; falling back to the NSIS UI");
    let code = voxelight_setup_lib::run_embedded_payload(&[]);
    std::process::exit(code);
}

fn main() {
    // Must be the very first operation in the process, before any code that
    // could load a DLL. Setup is often started from Downloads, where a planted
    // non-KnownDLL (dwmapi.dll, WINHTTP.dll, ...) could otherwise win the
    // default search order. This restricts every subsequent load to System32,
    // complementing the /DEPENDENTLOADFLAG:0x800 and /DELAYLOAD link flags.
    #[cfg(windows)]
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32);
    }

    // Retain the release-tooling marker in the executable even when LTO and
    // symbol stripping would otherwise discard an unused constant.
    std::hint::black_box(voxelight_setup_lib::SETUP_BINARY_MARKER);

    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match decide_startup_action(&args, &voxelight_setup_lib::webview2::SystemWebView2Probe) {
        StartupAction::Passthrough(_) => {
            // Forward the untouched command line after the program name so
            // repeated spaces in an unquoted /D= path survive.
            let raw = voxelight_setup_lib::args::system_raw_command_line_tail();
            let code = match raw {
                Some(raw) => voxelight_setup_lib::run_embedded_payload_raw(&raw, &args),
                None => voxelight_setup_lib::run_embedded_payload(&args),
            };
            std::process::exit(code);
        }
        StartupAction::WebView2Fallback => {
            // WebView2 is absent: run the NSIS payload with its normal UI so it bootstraps WebView2.
            let code = voxelight_setup_lib::run_embedded_payload(&[]);
            std::process::exit(code);
        }
        StartupAction::LaunchUi => {
            match voxelight_setup_lib::run_ui() {
                Ok(voxelight_setup_lib::UiOutcome::Closed) => {}
                Ok(voxelight_setup_lib::UiOutcome::ClassicInstaller) => {
                    // The user asked for the NSIS pages (for example to move an
                    // existing installation whose folder Setup cannot use).
                    let code = voxelight_setup_lib::run_embedded_payload(&[]);
                    std::process::exit(code);
                }
                Ok(voxelight_setup_lib::UiOutcome::WindowFailed(error)) => {
                    fall_back_to_nsis(&format!("UI window creation failed ({error})"));
                }
                Err(error) => {
                    fall_back_to_nsis(&format!("UI initialization failed ({error})"));
                }
            }
        }
    }
}
