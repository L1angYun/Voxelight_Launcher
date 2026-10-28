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
fn get_launcher_background_inner(
    state: State<'_, Arc<LauncherState>>,
) -> Result<Option<String>, String> {
    state
        .snapshot()?
        .config
        .custom_background
        .map(|path| image(Path::new(&path)))
        .transpose()
}
#[tauri::command]
pub fn get_launcher_background(state: State<'_, Arc<LauncherState>>) -> AppResult<Option<String>> {
    get_launcher_background_inner(state).map_err(expected)
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
    state: State<'_, Arc<LauncherState>>,
    path: Option<String>,
) -> AppResult<Config> {
    set_launcher_background_inner(state, path).map_err(expected)
}

fn export_launcher_config_inner(
    state: State<'_, Arc<LauncherState>>,
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
    state: State<'_, Arc<LauncherState>>,
    path: String,
) -> AppResult<String> {
    export_launcher_config_inner(state, path).map_err(expected)
}

fn import_launcher_config_inner(state: &LauncherState, path: String) -> Result<Config, String> {
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
    crate::commands::save_config_inner(&state, config)
}

#[tauri::command]
pub fn import_launcher_config(
    state: State<'_, Arc<LauncherState>>,
    path: String,
) -> AppResult<Config> {
    import_launcher_config_inner(state.inner(), path).map_err(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Persisted;

    #[test]
    fn legacy_lumen_preset_migrates_to_steve_and_preserves_other_settings() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/appearance-tests")
            .join(uuid::Uuid::new_v4().to_string());
        let data = root.join("data");
        let game = root.join("game");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&game).unwrap();
        let state = LauncherState {
            data: std::sync::Mutex::new(Persisted::default()),
            data_dir: data,
            client: crate::storage::test_client(),
            operation: tokio::sync::Mutex::new(()),
            control: Default::default(),
            games: Default::default(),
        };
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
        assert_eq!(imported.default_skin, "steve");
        assert_eq!(imported.max_memory_mb, 8192);
        assert_eq!(imported.effects, "lite");
        assert_eq!(imported.game_directory, game.to_string_lossy());
        fs::remove_dir_all(root).unwrap();
    }
}
