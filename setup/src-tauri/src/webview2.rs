// SPDX-License-Identifier: GPL-3.0-only
//! WebView2 Runtime registry detection and startup mode decision.
use crate::args::should_passthrough;
use std::ffi::OsString;

/// Official Microsoft Edge WebView2 Runtime Evergreen client GUID (matches `installer.nsi`).
pub const WEBVIEW2_CLIENT_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

pub const HKLM_WOW6432_KEY: &str =
    r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
pub const HKLM_NATIVE_KEY: &str =
    r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
pub const HKCU_KEY: &str =
    r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupAction {
    /// NSIS CLI flags were supplied: run payload silently/verbatim with zero UI.
    Passthrough(Vec<OsString>),
    /// WebView2 Runtime is absent: launch the embedded NSIS payload with its normal UI.
    WebView2Fallback,
    /// WebView2 Runtime is available and no NSIS flags were given: open Voxelight Setup UI.
    LaunchUi,
}

/// Validates a WebView2 `pv` registry string: non-empty and not all zeros (`0.0.0.0`).
pub fn is_valid_webview2_version(value: Option<&str>) -> bool {
    let Some(raw) = value else {
        return false;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "0.0.0.0" {
        return false;
    }
    trimmed
        .split('.')
        .any(|segment| segment.parse::<u64>().is_ok_and(|number| number > 0))
}

pub trait WebView2Probe {
    fn read_hklm_wow6432_pv(&self) -> Option<String>;
    fn read_hklm_native_pv(&self) -> Option<String>;
    fn read_hkcu_pv(&self) -> Option<String>;
}

pub struct SystemWebView2Probe;

#[cfg(windows)]
fn read_reg_pv(root: winreg::HKEY, subkey: &str, flags: u32) -> Option<String> {
    let key = winreg::RegKey::predef(root)
        .open_subkey_with_flags(subkey, flags)
        .ok()?;
    key.get_value::<String, _>("pv").ok()
}

#[cfg(windows)]
impl WebView2Probe for SystemWebView2Probe {
    fn read_hklm_wow6432_pv(&self) -> Option<String> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
        read_reg_pv(HKEY_LOCAL_MACHINE, HKLM_WOW6432_KEY, KEY_READ | KEY_WOW64_64KEY)
    }

    fn read_hklm_native_pv(&self) -> Option<String> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
        read_reg_pv(HKEY_LOCAL_MACHINE, HKLM_NATIVE_KEY, KEY_READ | KEY_WOW64_64KEY)
            .or_else(|| read_reg_pv(HKEY_LOCAL_MACHINE, HKLM_NATIVE_KEY, KEY_READ | KEY_WOW64_32KEY))
    }

    fn read_hkcu_pv(&self) -> Option<String> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        read_reg_pv(HKEY_CURRENT_USER, HKCU_KEY, KEY_READ)
    }
}

#[cfg(not(windows))]
impl WebView2Probe for SystemWebView2Probe {
    fn read_hklm_wow6432_pv(&self) -> Option<String> {
        None
    }
    fn read_hklm_native_pv(&self) -> Option<String> {
        None
    }
    fn read_hkcu_pv(&self) -> Option<String> {
        None
    }
}

/// Returns the installed WebView2 Runtime version string if present in any
/// standard machine or per-user registry location.
pub fn detect_webview2(probe: &dyn WebView2Probe) -> Option<String> {
    for candidate in [
        probe.read_hklm_wow6432_pv(),
        probe.read_hklm_native_pv(),
        probe.read_hkcu_pv(),
    ] {
        if let Some(version) = candidate {
            if is_valid_webview2_version(Some(&version)) {
                return Some(version.trim().to_owned());
            }
        }
    }
    None
}

/// Decides Setup's startup mode BEFORE creating any Tauri window.
pub fn decide_startup_action(args: &[OsString], probe: &dyn WebView2Probe) -> StartupAction {
    if should_passthrough(args) {
        return StartupAction::Passthrough(args.to_vec());
    }
    if detect_webview2(probe).is_some() {
        StartupAction::LaunchUi
    } else {
        StartupAction::WebView2Fallback
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeProbe {
        wow6432: Option<&'static str>,
        native: Option<&'static str>,
        hkcu: Option<&'static str>,
    }

    impl WebView2Probe for FakeProbe {
        fn read_hklm_wow6432_pv(&self) -> Option<String> {
            self.wow6432.map(str::to_owned)
        }
        fn read_hklm_native_pv(&self) -> Option<String> {
            self.native.map(str::to_owned)
        }
        fn read_hkcu_pv(&self) -> Option<String> {
            self.hkcu.map(str::to_owned)
        }
    }

    #[test]
    fn valid_webview2_version_checks_nonzero_segments() {
        assert!(is_valid_webview2_version(Some("130.0.2849.68")));
        assert!(is_valid_webview2_version(Some(" 128.0.0.1 ")));
        assert!(!is_valid_webview2_version(None));
        assert!(!is_valid_webview2_version(Some("")));
        assert!(!is_valid_webview2_version(Some("   ")));
        assert!(!is_valid_webview2_version(Some("0.0.0.0")));
        assert!(!is_valid_webview2_version(Some("0.0")));
        assert!(!is_valid_webview2_version(Some("not-a-version")));
    }

    #[test]
    fn detects_webview2_in_machine_or_user_hives() {
        let hklm = FakeProbe {
            wow6432: Some("131.0.2903.51"),
            native: None,
            hkcu: None,
        };
        assert_eq!(detect_webview2(&hklm).as_deref(), Some("131.0.2903.51"));
        assert_eq!(decide_startup_action(&[], &hklm), StartupAction::LaunchUi);

        let hkcu = FakeProbe {
            wow6432: Some("0.0.0.0"),
            native: None,
            hkcu: Some("129.0.2792.79"),
        };
        assert_eq!(detect_webview2(&hkcu).as_deref(), Some("129.0.2792.79"));
        assert_eq!(decide_startup_action(&[], &hkcu), StartupAction::LaunchUi);
    }

    #[test]
    fn missing_or_stub_webview2_falls_back_to_nsis_ui() {
        let missing = FakeProbe {
            wow6432: None,
            native: None,
            hkcu: None,
        };
        assert_eq!(decide_startup_action(&[], &missing), StartupAction::WebView2Fallback);

        let stub = FakeProbe {
            wow6432: Some("0.0.0.0"),
            native: Some(""),
            hkcu: Some("0.0.0.0"),
        };
        assert_eq!(decide_startup_action(&[], &stub), StartupAction::WebView2Fallback);
    }

    #[test]
    fn nsis_flags_always_take_passthrough_precedence() {
        let args = vec![OsString::from("/P"), OsString::from("/UPDATE"), OsString::from("/R")];
        let present = FakeProbe {
            wow6432: Some("131.0.2903.51"),
            native: None,
            hkcu: None,
        };
        let absent = FakeProbe {
            wow6432: None,
            native: None,
            hkcu: None,
        };
        assert_eq!(decide_startup_action(&args, &present), StartupAction::Passthrough(args.clone()));
        assert_eq!(decide_startup_action(&args, &absent), StartupAction::Passthrough(args));
    }
}
