use crate::path_grants::{PathGrants, PathUse};
use crate::{
    errors::{expected, AppResult},
    models::Config,
    storage::LauncherState,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs, io::Write, path::Path, sync::Arc};
use tauri::State;
fn image(path: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("背景图片需要本地绝对路径".into());
    }
    let metadata = fs::metadata(path).map_err(|e| format!("无法读取背景：{e}"))?;
    if !metadata.is_file() || metadata.len() > 12 * 1024 * 1024 {
        return Err("请选择不超过 12 MB 的背景图片".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if bytes.len() < 24 {
            return Err("PNG 图片不完整".into());
        }
        let w = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| "PNG尺寸错误")?);
        let h = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| "PNG尺寸错误")?);
        if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 40_000_000 {
            return Err("背景图片尺寸过大".into());
        }
        "image/png"
    } else if bytes.starts_with(&[255, 216, 255]) {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        return Err("背景只支持 PNG、JPEG 或 WebP 图片".into());
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
fn get_launcher_background_inner(state: &LauncherState) -> Result<Option<String>, String> {
    state
        .snapshot()?
        .config
        .custom_background
        .map(|path| image(Path::new(&path)))
        .transpose()
}
/// Reads and encodes the image off the main thread: the home page asks for it
/// at every start, and an image can be several megabytes.
#[tauri::command]
pub async fn get_launcher_background(state: State<'_, Arc<LauncherState>>) -> AppResult<Option<String>> {
    let shared = state.inner().clone();
    tokio::task::spawn_blocking(move || get_launcher_background_inner(&shared))
        .await
        .unwrap_or_else(|error| Err(error.to_string()))
        .map_err(expected)
}

fn set_launcher_background_inner(
    state: State<'_, Arc<LauncherState>>,
    path: Option<String>,
) -> Result<Config, String> {
    if let Some(path) = &path {
        image(Path::new(path))?;
    }
    state.update(|data| {
        data.config.custom_background = path;
        Ok(data.config.clone())
    })
}
#[tauri::command]
pub fn set_launcher_background(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    path: Option<String>,
) -> AppResult<Config> {
    let path = path.map(|value| grants.consume(PathUse::Background, &value, &window)).transpose()?
        .map(|value| value.to_string_lossy().into_owned());
    set_launcher_background_inner(state, path).map_err(expected)
}

pub(crate) fn export_launcher_config_inner(
    state: &LauncherState,
    path: String,
) -> Result<String, String> {
    let target = Path::new(&path);
    if !target.is_absolute()
        || target
            .extension()
            .is_none_or(|ext| !ext.eq_ignore_ascii_case("json"))
    {
        return Err("请选择绝对路径的 JSON 配置文件".into());
    }
    let bytes = serde_json::to_vec_pretty(
        &serde_json::json!({"formatVersion":1,"config":state.snapshot()?.config}),
    )
    .map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| format!("无法创建预设文件（不会覆盖已有文件）：{e}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(path)
}
#[tauri::command]
pub fn export_launcher_config(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    path: String,
) -> AppResult<String> {
    let path = grants.consume(PathUse::PresetWrite, &path, &window)?.to_string_lossy().into_owned();
    export_launcher_config_inner(state.inner(), path).map_err(expected)
}

fn read_config_preset(path: &str) -> Result<Config, String> {
    let target = Path::new(&path);
    if !target.is_absolute() {
        return Err("请选择本地配置文件".into());
    }
    if fs::metadata(target).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("配置文件过大".into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(target).map_err(|e| e.to_string())?)
            .map_err(|e| format!("预设 JSON 无效：{e}"))?;
    if value["formatVersion"].as_u64() != Some(1) {
        return Err("请选择本启动器导出的配置预设".into());
    }
    let migrated = crate::storage::migrate_state_json(serde_json::json!({
        "config": value["config"].clone(),
    }))?;
    let config: Config =
        serde_json::from_value(migrated["config"].clone()).map_err(|e| e.to_string())?;
    Ok(config)
}

/// Older presets can carry heap flags in the custom JVM arguments, which the
/// memory fields now own. Drop them so the preset still imports; the values
/// are not migrated and the save checks still run.
#[cfg(test)]
fn strip_heap_arguments(config: &mut Config) -> Result<bool, String> {
    let arguments = shell_words::split(&config.jvm_arguments).map_err(|_| "JVM 参数引号不匹配")?;
    let kept: Vec<_> = arguments.iter().filter(|arg| !crate::memory::is_memory_argument(arg)).collect();
    if kept.len() == arguments.len() {
        return Ok(false);
    }
    config.jvm_arguments = shell_words::join(kept);
    Ok(true)
}

fn assistant_permission_rank(value: &str) -> u8 {
    match value {
        "fullAccess" => 2,
        "controlled" => 1,
        _ => 0,
    }
}

/// Preserves security-sensitive fields when importing an untrusted preset file.
fn sanitize_imported_preset(previous: &Config, config: &mut Config) {
    if config.custom_background != previous.custom_background {
        // A preset can restore visual preferences, but a reference to an
        // external image is not a native file grant. Keep the selected image.
        config.custom_background = previous.custom_background.clone();
    }
    // An imported preset must never inject JVM agent/code-execution flags, hijack proxy
    // or Microsoft Client ID settings, redirect Lumen's DPAPI-stored API key to another
    // endpoint, silently enable proactive crash auto-send, or elevate permissions.
    config.jvm_arguments = previous.jvm_arguments.clone();
    config.proxy_mode = previous.proxy_mode.clone();
    config.proxy_scheme = previous.proxy_scheme.clone();
    config.proxy_host = previous.proxy_host.clone();
    config.proxy_port = previous.proxy_port;
    config.game_proxy_mode = previous.game_proxy_mode.clone();
    config.microsoft_client_id = previous.microsoft_client_id.clone();
    config.assistant_provider = previous.assistant_provider.clone();
    config.assistant_base_url = previous.assistant_base_url.clone();
    if assistant_permission_rank(&config.assistant_permission)
        > assistant_permission_rank(&previous.assistant_permission)
    {
        config.assistant_permission = previous.assistant_permission.clone();
    }
    if config.assistant_proactive && !previous.assistant_proactive {
        config.assistant_proactive = false;
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedPreset {
    config: Config,
    heap_arguments_removed: bool,
}

#[cfg(test)]
fn import_launcher_config_inner(state: &LauncherState, path: String) -> Result<ImportedPreset, String> {
    let mut config = read_config_preset(&path)?;
    let heap_arguments_removed = strip_heap_arguments(&mut config)?;
    let config = crate::commands::save_config_inner(state, config)?;
    Ok(ImportedPreset { config, heap_arguments_removed })
}

#[tauri::command]
pub async fn import_launcher_config(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    path: String,
) -> AppResult<ImportedPreset> {
    let path = grants.consume(PathUse::PresetRead, &path, &window)?.to_string_lossy().into_owned();
    let previous = state.snapshot()?.config;
    let mut config = read_config_preset(&path)?;
    sanitize_imported_preset(&previous, &mut config);
    crate::path_grants::authorize_changed_config_paths(&window, &grants, &previous, &mut config).await?;
    let config = crate::commands::save_approved_config(&state, config, Some(&previous)).map_err(expected)?;
    Ok(ImportedPreset { config, heap_arguments_removed: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Persisted;

    #[test]
    fn u1_the_home_background_is_read_off_the_main_thread() {
        let source = crate::storage::executable_source(include_str!("appearance.rs"));
        let body = source.split_once("pub async fn get_launcher_background(").expect("an async command").1;
        let body = body.split_once("\n}").unwrap().0;
        assert!(body.contains("tokio::task::spawn_blocking(move || get_launcher_background_inner(&shared))"), "{body}");
    }

    #[test]
    fn legacy_lumen_preset_migrates_to_steve_and_preserves_other_settings() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/appearance-tests")
            .join(uuid::Uuid::new_v4().to_string());
        let data = root.join("data");
        let game = root.join("game");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&game).unwrap();
        let state =
            LauncherState::test_fixture(data, Persisted::default(), crate::storage::test_client());
        let mut config = serde_json::to_value(Config {
            game_directory: game.to_string_lossy().into_owned(),
            max_memory_mb: 8192,
            effects: "lite".into(),
            ..Config::default()
        })
        .unwrap();
        config["defaultSkin"] = serde_json::Value::String("lumen".into());
        let preset = root.join("legacy-preset.json");
        fs::write(
            &preset,
            serde_json::to_vec_pretty(&serde_json::json!({
                "formatVersion": 1,
                "config": config,
            }))
            .unwrap(),
        )
        .unwrap();

        let imported =
            import_launcher_config_inner(&state, preset.to_string_lossy().into_owned()).unwrap();
        assert!(!imported.heap_arguments_removed);
        let imported = imported.config;
        assert_eq!(imported.default_skin, "steve");
        assert_eq!(imported.max_memory_mb, 8192);
        assert_eq!(imported.effects, "lite");
        assert_eq!(imported.game_directory, game.to_string_lossy());
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn c5_preset_with_heap_flags_imports_without_them() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/appearance-tests")
            .join(uuid::Uuid::new_v4().to_string());
        let data = root.join("data");
        let game = root.join("game");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&game).unwrap();
        let state =
            LauncherState::test_fixture(data, Persisted::default(), crate::storage::test_client());
        let preset = root.join("heap-preset.json");
        let config = Config {
            game_directory: game.to_string_lossy().into_owned(),
            jvm_arguments: "-Xmx6G -XX:+UseG1GC -Xms2G '-Dname=a b' -XX:MaxHeapSize=4g".into(),
            ..Config::default()
        };
        fs::write(&preset, serde_json::to_vec(&serde_json::json!({"formatVersion": 1, "config": config})).unwrap()).unwrap();
        let imported = import_launcher_config_inner(&state, preset.to_string_lossy().into_owned()).unwrap();
        assert!(imported.heap_arguments_removed);
        let kept = shell_words::split(&imported.config.jvm_arguments).unwrap();
        assert_eq!(kept, ["-XX:+UseG1GC", "-Dname=a b"]);
        assert_eq!(state.snapshot().unwrap().config.jvm_arguments, imported.config.jvm_arguments);
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn u7_imported_preset_preserves_security_sensitive_fields() {
        let previous = Config {
            jvm_arguments: "-XX:+UseG1GC".into(),
            proxy_mode: "system".into(),
            proxy_scheme: "http".into(),
            proxy_host: "corp.example.invalid".into(),
            proxy_port: 8080,
            game_proxy_mode: "off".into(),
            microsoft_client_id: "synthetic-client-prev".into(),
            assistant_provider: "openai".into(),
            assistant_base_url: "https://api.openai.com/v1".into(),
            assistant_permission: "readOnly".into(),
            assistant_proactive: false,
            ..Config::default()
        };
        let mut incoming = Config {
            theme: "dark".into(),
            jvm_arguments: "-javaagent:C:/evil.jar".into(),
            proxy_mode: "custom".into(),
            proxy_scheme: "socks5".into(),
            proxy_host: "attacker.example.invalid".into(),
            proxy_port: 1080,
            game_proxy_mode: "launcher".into(),
            microsoft_client_id: "synthetic-client-incoming".into(),
            assistant_provider: "anthropic".into(),
            assistant_base_url: "https://evil.example.invalid/v1".into(),
            assistant_permission: "controlled".into(),
            assistant_proactive: true,
            ..Config::default()
        };
        sanitize_imported_preset(&previous, &mut incoming);
        assert_eq!(incoming.theme, "dark");
        assert_eq!(incoming.jvm_arguments, previous.jvm_arguments);
        assert_eq!(incoming.proxy_mode, previous.proxy_mode);
        assert_eq!(incoming.proxy_host, previous.proxy_host);
        assert_eq!(incoming.proxy_port, previous.proxy_port);
        assert_eq!(incoming.game_proxy_mode, previous.game_proxy_mode);
        assert_eq!(incoming.microsoft_client_id, previous.microsoft_client_id);
        assert_eq!(incoming.assistant_provider, previous.assistant_provider);
        assert_eq!(incoming.assistant_base_url, previous.assistant_base_url);
        assert_eq!(incoming.assistant_permission, "readOnly");
        assert!(!incoming.assistant_proactive);

        // Downgrading assistant_permission remains permitted.
        let mut higher = previous.clone();
        higher.assistant_permission = "fullAccess".into();
        let mut downgrade = Config {
            assistant_permission: "readOnly".into(),
            ..Config::default()
        };
        sanitize_imported_preset(&higher, &mut downgrade);
        assert_eq!(downgrade.assistant_permission, "readOnly");
    }
}
