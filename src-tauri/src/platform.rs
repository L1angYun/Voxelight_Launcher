use serde::Serialize;
use std::cell::RefCell;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAppearance {
    pub accent_color: String,
    pub animations_enabled: bool,
    pub advanced_effects_enabled: bool,
    pub locale: String,
}

impl Default for SystemAppearance {
    fn default() -> Self {
        Self {
            accent_color: "#b4f17a".into(),
            animations_enabled: true,
            advanced_effects_enabled: true,
            locale: "en-US".into(),
        }
    }
}

fn resolve_system_locale(locale: &str) -> String {
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

fn color_to_hex(red: u8, green: u8, blue: u8) -> String {
    format!("#{red:02x}{green:02x}{blue:02x}")
}

#[cfg(windows)]
fn current_system_appearance() -> SystemAppearance {
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
fn current_system_appearance() -> SystemAppearance {
    SystemAppearance::default()
}

#[cfg(windows)]
pub(crate) fn system_prefers_light() -> bool {
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
pub(crate) fn system_prefers_light() -> bool {
    false
}

fn resolve_initial_window_background(theme: &str, system_light: bool) -> tauri::webview::Color {
    let light = match theme {
        "light" => true,
        "dark" => false,
        _ => system_light,
    };
    if light {
        tauri::webview::Color(0xf3, 0xf1, 0xeb, 0xff)
    } else {
        tauri::webview::Color(0x14, 0x15, 0x16, 0xff)
    }
}

pub(crate) fn initial_window_background(theme: &str) -> tauri::webview::Color {
    resolve_initial_window_background(theme, system_prefers_light())
}

#[tauri::command]
pub fn get_system_appearance() -> SystemAppearance {
    current_system_appearance()
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
    // UISettings and its delegates are COM objects, not Send/Sync. Keep the
    // single application-lifetime watcher on the main thread instead of
    // moving it into Tauri's shared managed state.
    static PLATFORM_APPEARANCE_WATCHER: RefCell<Option<PlatformAppearanceWatcher>> =
        RefCell::new(None);
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
            let _ = color_app.emit("launcher://system-appearance", current_system_appearance());
            Ok(())
        });
    let animations_app = app.clone();
    let animations_handler: TypedEventHandler<
        UISettings,
        UISettingsAnimationsEnabledChangedEventArgs,
    > = TypedEventHandler::new(move |_, _| {
        let _ = animations_app.emit("launcher://system-appearance", current_system_appearance());
        Ok(())
    });
    let effects_app = app.clone();
    let effects_handler: TypedEventHandler<UISettings, IInspectable> =
        TypedEventHandler::new(move |_, _| {
            let _ = effects_app.emit("launcher://system-appearance", current_system_appearance());
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
    PLATFORM_APPEARANCE_WATCHER.with(|slot| {
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
    fn system_locale_falls_back_to_supported_languages() {
        assert_eq!(resolve_system_locale("zh-Hans"), "zh-CN");
        assert_eq!(resolve_system_locale("zh-CN"), "zh-CN");
        assert_eq!(resolve_system_locale("zh-SG"), "zh-CN");
        assert_eq!(resolve_system_locale("zh-Hant"), "zh-TW");
        assert_eq!(resolve_system_locale("zh-TW"), "zh-TW");
        assert_eq!(resolve_system_locale("zh-HK"), "zh-TW");
        assert_eq!(resolve_system_locale("ja-JP"), "ja-JP");
        assert_eq!(resolve_system_locale("ko-KR"), "ko-KR");
        assert_eq!(resolve_system_locale("ru-RU"), "ru-RU");
        assert_eq!(resolve_system_locale("es-MX"), "es-ES");
        assert_eq!(resolve_system_locale("de-DE"), "en-US");
    }

    #[test]
    fn accent_channels_form_a_standard_hex_color() {
        assert_eq!(color_to_hex(0x11, 0x22, 0x33), "#112233");
        assert_eq!(color_to_hex(0x00, 0xff, 0x80), "#00ff80");
    }

    #[test]
    fn current_system_appearance_returns_supported_values() {
        let appearance = current_system_appearance();
        println!("{appearance:?}");
        assert!(appearance.accent_color.starts_with('#'));
        assert_eq!(appearance.accent_color.len(), 7);
        assert!(["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "ru-RU", "es-ES"]
            .contains(&appearance.locale.as_str()));
    }

    #[test]
    fn initial_window_background_follows_system_or_explicit_theme() {
        let light = tauri::webview::Color(0xf3, 0xf1, 0xeb, 0xff);
        let dark = tauri::webview::Color(0x14, 0x15, 0x16, 0xff);
        assert_eq!(resolve_initial_window_background("system", true), light);
        assert_eq!(resolve_initial_window_background("system", false), dark);
        assert_eq!(resolve_initial_window_background("light", false), light);
        assert_eq!(resolve_initial_window_background("dark", true), dark);
    }
}
