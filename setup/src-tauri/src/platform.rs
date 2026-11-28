// SPDX-License-Identifier: GPL-3.0-only
//! Windows system theme, accent color, motion/effects flags, and UI locale detection.
use serde::Serialize;
use std::cell::RefCell;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAppearance {
    pub theme: String,
    pub accent_color: String,
    pub animations_enabled: bool,
    pub advanced_effects_enabled: bool,
    pub locale: String,
}

impl Default for SystemAppearance {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            accent_color: "#0078d4".into(),
            animations_enabled: true,
            advanced_effects_enabled: true,
            locale: "en-US".into(),
        }
    }
}

pub fn resolve_system_locale(locale: &str) -> String {
    let normalized = locale.trim().to_ascii_lowercase().replace('_', "-");
    if matches!(
        normalized.as_str(),
        "zh-hant" | "zh-tw" | "zh-hk" | "zh-mo"
    ) || normalized.starts_with("zh-hant-")
    {
        "zh-TW".into()
    } else if matches!(normalized.as_str(), "zh" | "zh-hans" | "zh-cn" | "zh-sg")
        || normalized.starts_with("zh-hans-")
    {
        "zh-CN".into()
    } else if normalized == "ja" || normalized.starts_with("ja-") {
        "ja-JP".into()
    } else if normalized == "ko" || normalized.starts_with("ko-") {
        "ko-KR".into()
    } else if normalized == "ru" || normalized.starts_with("ru-") {
        "ru-RU".into()
    } else if normalized == "es" || normalized.starts_with("es-") {
        "es-ES".into()
    } else {
        "en-US".into()
    }
}

/// Whether Setup may offer to launch the freshly installed launcher.
///
/// The launcher must run with the user's normal (Medium integrity) token. A
/// process started by an elevated Setup inherits Setup's token, so Setup does
/// not offer "Launch" when it is elevated; the user can open Voxelight from the
/// Start menu instead. Mirrors NSIS `RunAsUser`, which cannot be reused from
/// Rust without the NSIS plugin runtime.
pub fn launch_available(elevated: bool) -> bool {
    !elevated
}

#[cfg(windows)]
pub fn is_process_elevated() -> bool {
    use std::ffi::c_void;
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_ELEVATION: u32 = 20;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn CloseHandle(handle: isize) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn OpenProcessToken(process: isize, desired_access: u32, token: *mut isize) -> i32;
        fn GetTokenInformation(
            token: isize,
            information_class: u32,
            information: *mut c_void,
            information_length: u32,
            return_length: *mut u32,
        ) -> i32;
    }

    let mut token = 0isize;
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    let mut elevated = 0u32;
    let mut returned = 0u32;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TOKEN_ELEVATION,
            (&mut elevated as *mut u32).cast::<c_void>(),
            std::mem::size_of::<u32>() as u32,
            &mut returned,
        )
    };
    unsafe { CloseHandle(token) };
    ok != 0 && elevated != 0
}

#[cfg(not(windows))]
pub fn is_process_elevated() -> bool {
    false
}

fn color_to_hex(red: u8, green: u8, blue: u8) -> String {
    format!("#{red:02x}{green:02x}{blue:02x}")
}

#[cfg(windows)]
pub fn system_prefers_light() -> bool {
    use windows::UI::ViewManagement::{UIColorType, UISettings};
    let Ok(settings) = UISettings::new() else {
        return false;
    };
    let Ok(bg) = settings.GetColorValue(UIColorType::Background) else {
        return false;
    };
    u16::from(bg.R) + u16::from(bg.G) + u16::from(bg.B) > 382
}

#[cfg(not(windows))]
pub fn system_prefers_light() -> bool {
    false
}

#[cfg(windows)]
pub fn current_system_appearance() -> SystemAppearance {
    use windows::{
        System::UserProfile::GlobalizationPreferences,
        UI::ViewManagement::{UIColorType, UISettings},
    };

    let mut result = SystemAppearance::default();
    if let Ok(languages) = GlobalizationPreferences::Languages() {
        if let Ok(locale) = languages.GetAt(0) {
            result.locale = resolve_system_locale(&locale.to_string_lossy());
        }
    }
    let Ok(settings) = UISettings::new() else {
        return result;
    };
    if let Ok(bg) = settings.GetColorValue(UIColorType::Background) {
        result.theme = if u16::from(bg.R) + u16::from(bg.G) + u16::from(bg.B) > 382 {
            "light".into()
        } else {
            "dark".into()
        };
    }
    if let Ok(color) = settings.GetColorValue(UIColorType::Accent) {
        result.accent_color = color_to_hex(color.R, color.G, color.B);
    }
    if let Ok(enabled) = settings.AnimationsEnabled() {
        result.animations_enabled = enabled;
    }
    if let Ok(enabled) = settings.AdvancedEffectsEnabled() {
        result.advanced_effects_enabled = enabled;
    }
    result
}

#[cfg(not(windows))]
pub fn current_system_appearance() -> SystemAppearance {
    SystemAppearance::default()
}

pub fn initial_window_background() -> tauri::webview::Color {
    if system_prefers_light() {
        tauri::webview::Color(0xf3, 0xf1, 0xeb, 0xff)
    } else {
        tauri::webview::Color(0x14, 0x15, 0x16, 0xff)
    }
}

#[cfg(windows)]
struct PlatformAppearanceWatcher {
    settings: windows::UI::ViewManagement::UISettings,
    _color_handler: windows::Foundation::TypedEventHandler<
        windows::UI::ViewManagement::UISettings,
        windows::core::IInspectable,
    >,
    _animations_handler: windows::Foundation::TypedEventHandler<
        windows::UI::ViewManagement::UISettings,
        windows::UI::ViewManagement::UISettingsAnimationsEnabledChangedEventArgs,
    >,
    _effects_handler: windows::Foundation::TypedEventHandler<
        windows::UI::ViewManagement::UISettings,
        windows::core::IInspectable,
    >,
    color_token: i64,
    animations_token: i64,
    effects_token: i64,
}

#[cfg(windows)]
thread_local! {
    static SETUP_APPEARANCE_WATCHER: RefCell<Option<PlatformAppearanceWatcher>> =
        const { RefCell::new(None) };
}

#[cfg(windows)]
impl Drop for PlatformAppearanceWatcher {
    fn drop(&mut self) {
        let _ = self.settings.RemoveColorValuesChanged(self.color_token);
        let _ = self
            .settings
            .RemoveAnimationsEnabledChanged(self.animations_token);
        let _ = self
            .settings
            .RemoveAdvancedEffectsEnabledChanged(self.effects_token);
    }
}

#[cfg(windows)]
pub fn start_system_appearance_watcher(app: &AppHandle) -> Result<(), String> {
    use windows::{
        core::IInspectable,
        Foundation::TypedEventHandler,
        UI::ViewManagement::{UISettings, UISettingsAnimationsEnabledChangedEventArgs},
    };

    let settings = UISettings::new().map_err(|error| error.to_string())?;
    let color_app = app.clone();
    let color_handler: TypedEventHandler<UISettings, IInspectable> =
        TypedEventHandler::new(move |_, _| {
            let _ = color_app.emit("setup://system-appearance", current_system_appearance());
            Ok(())
        });
    let animations_app = app.clone();
    let animations_handler: TypedEventHandler<
        UISettings,
        UISettingsAnimationsEnabledChangedEventArgs,
    > = TypedEventHandler::new(move |_, _| {
        let _ = animations_app.emit("setup://system-appearance", current_system_appearance());
        Ok(())
    });
    let effects_app = app.clone();
    let effects_handler: TypedEventHandler<UISettings, IInspectable> =
        TypedEventHandler::new(move |_, _| {
            let _ = effects_app.emit("setup://system-appearance", current_system_appearance());
            Ok(())
        });
    let watcher = PlatformAppearanceWatcher {
        color_token: settings
            .ColorValuesChanged(&color_handler)
            .map_err(|error| error.to_string())?,
        animations_token: settings
            .AnimationsEnabledChanged(&animations_handler)
            .map_err(|error| error.to_string())?,
        effects_token: settings
            .AdvancedEffectsEnabledChanged(&effects_handler)
            .map_err(|error| error.to_string())?,
        settings,
        _color_handler: color_handler,
        _animations_handler: animations_handler,
        _effects_handler: effects_handler,
    };
    SETUP_APPEARANCE_WATCHER.with(|slot| {
        slot.borrow_mut().replace(watcher);
    });
    Ok(())
}

#[cfg(not(windows))]
pub fn start_system_appearance_watcher(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn does_not_offer_launch_from_an_elevated_setup() {
        assert!(launch_available(false));
        assert!(!launch_available(true));
    }

    #[test]
    fn maps_windows_locales_to_the_seven_supported_languages() {
        assert_eq!(resolve_system_locale("en-US"), "en-US");
        assert_eq!(resolve_system_locale("en-GB"), "en-US");
        assert_eq!(resolve_system_locale("zh-CN"), "zh-CN");
        assert_eq!(resolve_system_locale("zh-Hans-SG"), "zh-CN");
        assert_eq!(resolve_system_locale("zh-TW"), "zh-TW");
        assert_eq!(resolve_system_locale("zh-HK"), "zh-TW");
        assert_eq!(resolve_system_locale("ja-JP"), "ja-JP");
        assert_eq!(resolve_system_locale("ko-KR"), "ko-KR");
        assert_eq!(resolve_system_locale("ru-RU"), "ru-RU");
        assert_eq!(resolve_system_locale("es-MX"), "es-ES");
        assert_eq!(resolve_system_locale("fr-FR"), "en-US");
    }
}
