use crate::{
    client_id::builtin_client_id,
    errors::{expected, AppResult},
    minecraft,
    models::*,
    storage::{offline_uuid, safe_join, valid_username, validate_id, LauncherState},
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

type Shared<'a> = State<'a, Arc<LauncherState>>;

/// Visible instances of the active game folder. Legacy managed records have no
/// game folder and stay visible everywhere, as before.
pub(crate) fn active_folder_instances(data: &Persisted) -> Vec<Instance> {
    crate::instances::visible_instances(data)
        .into_iter()
        .filter(|instance| {
            instance.game_folder.is_empty()
                || crate::models::same_game_folder_path(
                    &instance.game_folder,
                    &data.config.game_directory,
                )
        })
        .collect()
}

#[tauri::command]
pub async fn bootstrap(state: Shared<'_>) -> Result<Value, String> {
    bootstrap_inner(state.inner()).await
}

pub(crate) async fn bootstrap_inner(state: &Arc<LauncherState>) -> Result<Value, String> {
    // Every version folder is an instance. One scan per configured folder
    // supplies both the instance records and the installed-version list. All
    // of it walks or deletes folders, so it runs on the blocking pool, never on
    // an async worker.
    let scan_state = state.clone();
    let report = tokio::task::spawn_blocking(move || {
        // Bootstrap runs on every reload. Disposable staging is swept once,
        // and only while no import, copy, restore or install owns the
        // operation lock.
        crate::modpacks::cleanup_stale_pack_staging_at_startup(&scan_state);
        crate::instances::recover_pending_conversions(&scan_state);
        crate::instances::sync_version_instances_reporting(&scan_state)
    })
    .await
    .map_err(|error| format!("扫描实例文件夹失败：{error}"))?;
    let installed_versions = match report {
        Ok(report) => report.active_versions,
        Err(error) => {
            // A broken profile must not stop the launcher from starting: the
            // error is logged and the stored instance records stay usable.
            eprintln!("[voxelight/instances] scan failed: {error}");
            let line = format!(
                "{} [error] 扫描实例文件夹失败：{error}\n",
                chrono::Utc::now().to_rfc3339()
            );
            let _ = crate::process_output::append_log(&state.data_dir.join("logs"), &line);
            Vec::new()
        }
    };
    let data = state.snapshot()?;
    // One list for the active game folder. Records from other folders stay in
    // state.json and reappear when the user switches back.
    let instances = active_folder_instances(&data);
    Ok(json!({
        "config": data.config, "accounts": data.accounts,
        "instances": instances,
        "installedVersions": installed_versions,
        "capabilities": bootstrap_capabilities(builtin_client_id()),
        "storage":state.storage_status(),
    }))
}

fn bootstrap_capabilities(builtin: Option<&str>) -> Value {    let note = if builtin.is_some() {
        "离线账号用于离线游戏和支持离线角色的服务器"
    } else {
        "Microsoft 设备授权需先配置本项目合法的 Client ID；离线账号用于离线游戏和支持离线角色的服务器"
    };
    json!({
            "vanillaInstall": true, "vanillaLaunch": true, "offlineAccounts": true,
            "microsoftLogin": true, "authlibLogin": true, "modLoaders": true,
            "microsoftBuiltinClientId": builtin.is_some(),
            "bedrock": false,
            "notes": [note],
    })
}

#[tauri::command]
pub fn get_config(state: Shared<'_>) -> Result<Config, String> {
    Ok(state.snapshot()?.config)
}

fn validate_default_skin(skin: &str) -> Result<(), String> {
    if ["steve", "alex"].contains(&skin) {
        Ok(())
    } else {
        Err("默认角色仅支持 steve 或 alex".into())
    }
}

/// Records that the first-run tour was finished or skipped. It changes only
/// that flag, so it is never refused while an install holds the operation
/// lock, and a whole-config save cannot undo it.
pub(crate) fn set_tour_completed_inner(state: &LauncherState, completed: bool) -> Result<Config, String> {
    state.update(|data| {
        data.config.tour_completed = completed;
        Ok(data.config.clone())
    })
}

#[tauri::command]
pub fn set_tour_completed(state: Shared<'_>, completed: bool) -> AppResult<Config> {
    set_tour_completed_inner(&state, completed).map_err(expected)
}

#[tauri::command]
pub async fn save_config(
    window: tauri::WebviewWindow,
    grants: State<'_, crate::path_grants::PathGrants>,
    state: Shared<'_>, mut config: Config, preserve_appearance: Option<bool>,
) -> AppResult<Config> {
    let previous = state.snapshot()?.config;
    let preserve_appearance = preserve_appearance.unwrap_or(false);
    if preserve_appearance {
        // Scoped nonvisual writes ignore the incoming visual snapshot, so
        // an unrelated background change does not trigger a path prompt.
        keep_saved_appearance(&mut config, &previous);
    }
    crate::path_grants::authorize_changed_config_paths(
        &window,
        &grants,
        &previous,
        &mut config,
        &state.data_dir,
    )
    .await?;
    reject_inherited_tls(&config, &state.snapshot()?.instances)?;
    save_approved_config_with_scope(&state, config, Some(&previous), preserve_appearance).map_err(expected)
}

/// Names the instances that would inherit an https:// proxy.
fn reject_inherited_tls(config: &Config, instances: &[crate::models::Instance]) -> AppResult<()> {
    let names = crate::network::instances_blocking_tls(config, instances)?;
    if names.is_empty() {
        return Ok(());
    }
    Err(crate::errors::AppError::new("proxy.tlsInheritanceInstances").with_param("instances", names.join("、")))
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppearancePatch {
    theme: Option<String>,
    language: Option<String>,
    effects: Option<String>,
    world_scene: Option<String>,
    world_material: Option<String>,
    accent_source: Option<String>,
    accent_color: Option<String>,
    sound_enabled: Option<bool>,
    default_skin: Option<String>,
    ambient_light_enabled: Option<bool>,
    ambient_light_intensity: Option<u8>,
    background_blur: Option<u8>,
    background_dim: Option<u8>,
    background_drift: Option<bool>,
}

impl AppearancePatch {
    fn is_empty(&self) -> bool {
        self.theme.is_none()
            && self.language.is_none()
            && self.effects.is_none()
            && self.world_scene.is_none()
            && self.world_material.is_none()
            && self.accent_source.is_none()
            && self.accent_color.is_none()
            && self.sound_enabled.is_none()
            && self.default_skin.is_none()
            && self.ambient_light_enabled.is_none()
            && self.ambient_light_intensity.is_none()
            && self.background_blur.is_none()
            && self.background_dim.is_none()
            && self.background_drift.is_none()
    }

    fn apply(&self, config: &mut Config) {
        if let Some(value) = self.theme.as_ref() {
            config.theme.clone_from(value);
        }
        if let Some(value) = self.language.as_ref() {
            config.language.clone_from(value);
        }
        if let Some(value) = self.effects.as_ref() {
            config.effects.clone_from(value);
        }
        if let Some(value) = self.world_scene.as_ref() {
            config.world_scene.clone_from(value);
        }
        if let Some(value) = self.world_material.as_ref() {
            config.world_material.clone_from(value);
        }
        if let Some(value) = self.accent_source.as_ref() {
            config.accent_source.clone_from(value);
        }
        if let Some(value) = self.accent_color.as_ref() {
            config.accent_color.clone_from(value);
        }
        if let Some(value) = self.sound_enabled {
            config.sound_enabled = value;
        }
        if let Some(value) = self.default_skin.as_ref() {
            config.default_skin.clone_from(value);
        }
        if let Some(value) = self.ambient_light_enabled {
            config.ambient_light_enabled = value;
        }
        if let Some(value) = self.ambient_light_intensity {
            config.ambient_light_intensity = value;
        }
        if let Some(value) = self.background_blur {
            config.background_blur = value;
        }
        if let Some(value) = self.background_dim {
            config.background_dim = value;
        }
        if let Some(value) = self.background_drift {
            config.background_drift = value;
        }
    }

    fn validate(&self) -> Result<(), String> {
        // Reuse the existing validator, but validate only patch values. A
        // hand-edited legacy field must not block an unrelated appearance save.
        let mut values = Config::default();
        self.apply(&mut values);
        validate_visual_preferences(&values)?;
        if !["horizon", "massif"].contains(&values.world_scene.as_str()) {
            return Err("不支持的世界场景".into());
        }
        if !["lattice", "solid"].contains(&values.world_material.as_str()) {
            return Err("不支持的世界材质".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub fn save_appearance_config(state: Shared<'_>, patch: AppearancePatch) -> AppResult<Config> {
    save_appearance_config_inner(&state, patch).map_err(expected)
}

fn save_appearance_config_inner(
    state: &LauncherState,
    patch: AppearancePatch,
) -> Result<Config, String> {
    if patch.is_empty() {
        return Ok(state.snapshot()?.config);
    }
    patch.validate()?;
    // Apply only named appearance fields to the latest persisted configuration.
    // Network/launch operations may hold their own lock while this small write
    // proceeds. No game files, credential fields, or download limits change.
    state.update(|data| {
        patch.apply(&mut data.config);
        Ok(data.config.clone())
    })
}

#[cfg(test)]
pub(crate) fn save_config_inner(state: &LauncherState, config: Config) -> Result<Config, String> {
    save_approved_config(state, config, None)
}

pub(crate) fn save_approved_config(state: &LauncherState, config: Config, approved_against: Option<&Config>) -> Result<Config, String> {
    save_approved_config_with_scope(state, config, approved_against, false)
}

fn keep_saved_appearance(config: &mut Config, saved: &Config) {
    config.theme.clone_from(&saved.theme);
    config.language.clone_from(&saved.language);
    config.effects.clone_from(&saved.effects);
    config.world_scene.clone_from(&saved.world_scene);
    config.world_material.clone_from(&saved.world_material);
    config.accent_source.clone_from(&saved.accent_source);
    config.accent_color.clone_from(&saved.accent_color);
    config.sound_enabled = saved.sound_enabled;
    config.custom_background.clone_from(&saved.custom_background);
    config.default_skin.clone_from(&saved.default_skin);
    config.ambient_light_enabled = saved.ambient_light_enabled;
    config.ambient_light_intensity = saved.ambient_light_intensity;
    config.background_blur = saved.background_blur;
    config.background_dim = saved.background_dim;
    config.background_drift = saved.background_drift;
}

fn save_approved_config_with_scope(state: &LauncherState, mut config: Config, approved_against: Option<&Config>, preserve_appearance: bool) -> Result<Config, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成后修改配置")?;
    config.game_directory = config.game_directory.trim().to_owned();
    for folder in &mut config.game_folders {
        folder.path = folder.path.trim().to_owned();
        folder.label = folder.label.trim().to_owned();
    }
    config.normalize_game_folders();
    // Nested folders and the launcher data directory can never be game roots.
    // A profile that already had one can still save unrelated settings; the
    // rule is enforced whenever the folder list changes.
    let folder_list_changed = {
        let previous = match approved_against {
            Some(previous) => previous.clone(),
            None => state.snapshot()?.config,
        };
        crate::path_grants::game_folder_roots_changed(
            &previous.game_folder_roots(),
            &config.game_folder_roots(),
        )
    };
    if folder_list_changed {
        crate::path_grants::validate_game_folder_layout(
            &config.game_folder_roots(),
            &state.data_dir,
        )
        .map_err(|error| error.detail.unwrap_or(error.code))?;
    }
    config.java_path = config.java_path.trim().to_owned();
    config.proxy_host = config.proxy_host.trim().to_owned();
    crate::network::Settings::validate_save(&config)
        .map_err(|error| error.code().to_owned())?;
    if !preserve_appearance {
        validate_visual_preferences(&config)?;
    }
    if !Path::new(&config.game_directory).is_absolute() {
        return Err("游戏目录必须是绝对路径".into());
    }
    if config.game_directory.contains('\0') || config.java_path.contains('\0') {
        return Err("路径包含非法字符".into());
    }
    for folder in &config.game_folders {
        if folder.path.is_empty()
            || !Path::new(&folder.path).is_absolute()
            || folder.path.contains('\0')
        {
            return Err("游戏目录必须是绝对路径".into());
        }
        if folder.label.chars().count() > 60 || folder.label.chars().any(char::is_control) {
            return Err("游戏目录名称需要为 1–60 个可显示字符".into());
        }
    }
    crate::memory::validate_mode(&config.memory_mode)?;
    crate::memory::validate_min(&config.memory_mode, config.min_memory_mb, config.max_memory_mb)?;
    if !(512..=65536).contains(&config.max_memory_mb) {
        return Err("最大内存需要在 512–65536 MB 之间".into());
    }
    if !(1..=16).contains(&config.download_concurrency) {
        return Err("下载并发需要在 1–16 之间".into());
    }
    if config.jvm_arguments.len() > 8192 || config.jvm_arguments.contains(['\0', '\r', '\n']) {
        return Err("JVM 参数过长或包含非法字符".into());
    }
    shell_words::split(&config.jvm_arguments).map_err(|e| format!("JVM 参数引号不匹配：{e}"))?;
    if !config.microsoft_client_id.trim().is_empty()
        && uuid::Uuid::parse_str(config.microsoft_client_id.trim()).is_err()
    {
        return Err("Microsoft Client ID 应为应用注册获得的 UUID".into());
    }
    if config.download_limit_kib > 1024 * 1024
        || !(320..=16384).contains(&config.screen_width)
        || !(240..=16384).contains(&config.screen_height)
    {
        return Err("限速或窗口尺寸超出范围".into());
    }
    if !["official", "auto", "bmclapi"].contains(&config.download_source.as_str()) {
        return Err("下载源无效".into());
    }
    config.assistant_base_url = config.assistant_base_url.trim().to_owned();
    config.assistant_model = config.assistant_model.trim().to_owned();
    crate::assistant::validate_config(&config)?;
    let saved = state.update(|data| {
        if let Some(approved) = approved_against {
            let approval_current = if preserve_appearance {
                approved.game_directory == data.config.game_directory
                    && approved.game_folders == data.config.game_folders
                    && approved.java_path == data.config.java_path
            } else {
                crate::path_grants::approved_config_is_current(approved, &data.config)
            };
            if !approval_current {
                return Err(crate::errors::STORAGE_STATE_CHANGED.into());
            }
        }
        if preserve_appearance {
            // An appearance save can interleave after the native path dialog.
            keep_saved_appearance(&mut config, &data.config);
        }
        // Only set_launcher_update_preferences changes these: it waits for a
        // running update download and clears a check made with another source or channel.
        config.check_for_updates = data.config.check_for_updates;
        config.update_source.clone_from(&data.config.update_source);
        config.update_channel.clone_from(&data.config.update_channel);
        // Only set_tour_completed changes this: a Settings page opened before
        // the tour ended, or an imported preset, must not bring it back.
        config.tour_completed = data.config.tour_completed;
        let previous = approved_against.unwrap_or(&data.config);
        if previous.jvm_arguments != data.config.jvm_arguments && config.jvm_arguments == previous.jvm_arguments {
            return Err(crate::errors::STORAGE_STATE_CHANGED.into());
        }
        crate::memory::validate_changed_heap_arguments(&previous.jvm_arguments, &config.jvm_arguments)?;
        // Re-checked under the state lock: an instance may have changed since the command looked.
        if !crate::network::instances_blocking_tls(&config, &data.instances)
            .map_err(|error| error.code().to_owned())?
            .is_empty()
        {
            return Err(crate::network::Error::TlsInheritance.code().to_owned());
        }
        crate::network::forget_abandoned_credentials(&state.data_dir, &data.config, &config)
            .map_err(|error| error.code().to_owned())?;
        data.config = config.clone();
        Ok(config)
    })?;
    // Game-setting saves own operation; publish rate only from durable state.
    state.control.set_limit(saved.download_limit_kib);
    state.control.set_concurrency(saved.download_concurrency);
    Ok(saved)
}

fn validate_visual_preferences(config: &Config) -> Result<(), String> {
    validate_default_skin(&config.default_skin)?;
    if !["dark", "light", "system"].contains(&config.theme.as_str()) {
        return Err("不支持的主题".into());
    }

    if !config.accent_color.starts_with('#')
        || config.accent_color.len() != 7
        || !config.accent_color[1..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err("强调色需要为 #RRGGBB".into());
    }
    if !["lite", "full"].contains(&config.effects.as_str()) {
        return Err("特效级别仅支持精简或完全".into());
    }
    if !["voxelight", "system", "custom"].contains(&config.accent_source.as_str()) {
        return Err("强调色来源无效".into());
    }
    if ![
        "system", "zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "ru-RU", "es-ES",
    ]
    .contains(&config.language.as_str())
    {
        return Err("暂不支持所选界面语言".into());
    }
    if config.ambient_light_intensity > 100 {
        return Err("环境光强度需要在 0–100 之间".into());
    }
    if config.background_blur > 24 {
        return Err("背景模糊需要在 0–24 之间".into());
    }
    if config.background_dim > 80 {
        return Err("背景压暗需要在 0–80 之间".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn list_versions(state: Shared<'_>) -> Result<Value, String> {
    minecraft::list_versions(&state).await
}

#[tauri::command]
pub async fn scan_versions(state: Shared<'_>) -> Result<Vec<InstalledVersion>, String> {
    let scan_state = state.inner().clone();
    let report = tokio::task::spawn_blocking(move || {
        crate::instances::sync_version_instances_reporting(&scan_state)
    })
    .await
    .map_err(|error| format!("扫描实例文件夹失败：{error}"))??;
    Ok(report.active_versions)
}

/// Switch the active game folder. The renderer may only select a folder that is
/// already configured, so this never turns a typed path into a trusted root.
#[tauri::command]
pub fn set_active_game_folder(state: Shared<'_>, path: String) -> AppResult<Config> {
    set_active_game_folder_inner(&state, &path).map_err(expected)
}

pub(crate) fn set_active_game_folder_inner(
    state: &LauncherState,
    path: &str,
) -> Result<Config, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err(crate::errors::GAME_FOLDER_NOT_FOUND.into());
    }
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成后切换游戏目录")?;
    let saved = state.update(|data| {
        data.config.normalize_game_folders();
        if !data
            .config
            .game_folders
            .iter()
            .any(|folder| crate::models::same_game_folder_path(&folder.path, path))
        {
            return Err(crate::errors::GAME_FOLDER_NOT_FOUND.to_string());
        }
        data.config.game_directory = path.to_owned();
        data.config.normalize_game_folders();
        Ok(data.config.clone())
    })?;
    Ok(saved)
}

/// Open one configured game folder without making it the active folder.
#[tauri::command]
pub fn open_game_folder(app: AppHandle, state: Shared<'_>, path: String) -> AppResult<()> {
    let directory = game_folder_to_open(&state.snapshot()?.config, &path).map_err(expected)?;
    app.opener()
        .open_path(crate::storage::display_profile_path(&directory), None::<&str>)
        .map_err(|error| {
            eprintln!("[voxelight/game-folders] could not open {}: {error}", directory.display());
            expected(format!(
                "{}{}",
                crate::errors::GAME_FOLDER_UNAVAILABLE_PREFIX,
                crate::errors::GAME_FOLDER_OPEN_FAILED
            ))
        })
}

/// The configured folder `path` names, ready to open. A failure carries a
/// reason code the interface translates, never system text.
fn game_folder_to_open(config: &Config, path: &str) -> Result<PathBuf, String> {
    if !config
        .game_folders
        .iter()
        .any(|folder| crate::models::same_game_folder_path(&folder.path, path))
    {
        return Err(crate::errors::GAME_FOLDER_NOT_FOUND.into());
    }
    crate::processes::configured_game_root(Path::new(path)).map_err(|error| {
        eprintln!("[voxelight/game-folders] unusable folder {path}: {error}");
        format!(
            "{}{}",
            crate::errors::GAME_FOLDER_UNAVAILABLE_PREFIX,
            crate::errors::GAME_FOLDER_INVALID_PATH
        )
    })
}

#[tauri::command]
pub async fn detect_java(state: Shared<'_>) -> Result<Vec<JavaRuntime>, String> {
    Ok(minecraft::detect_java(&state.snapshot()?.config, &state.data_dir).await)
}

fn installed_loader(config: &Config, version_id: &str) -> (String, String) {
    let Ok(root) = crate::processes::configured_game_root(Path::new(&config.game_directory)) else {
        return ("vanilla".into(), String::new());
    };
    let loader = crate::resources::version_context(&root, version_id)
        .ok()
        .and_then(|(_, loader)| loader)
        .unwrap_or_else(|| "vanilla".into());
    let version = safe_join(
        &root,
        &format!("versions/{version_id}/{version_id}.json"),
    )
    .ok()
    .and_then(|path| std::fs::read(path).ok())
    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    .map(|metadata| {
        metadata["launcherMetadata"]["loaderVersion"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    })
    .unwrap_or_default();
    (loader, version)
}

#[tauri::command]
pub fn create_instance(
    state: Shared<'_>,
    name: String,
    version_id: String,
) -> Result<Instance, String> {
    create_instance_inner(&state, name, version_id)
}

/// The assistant and MCP create entry point. It promotes an installed version
/// profile into `versions/<name>/` exactly like the window's create flow.
pub(crate) fn create_instance_inner(
    state: &LauncherState,
    name: String,
    version_id: String,
) -> Result<Instance, String> {
    let name = validate_instance_name(&name)?;
    create_instance_from_version_inner(state, Some(name), version_id)
}

/// `create_instance_inner` for a caller that already holds the operation lock
/// (the Lumen and MCP tool queues for it before checking its permission
/// again). The lock is not reentrant, so taking it here would always fail.
pub(crate) fn create_instance_locked(
    state: &LauncherState,
    name: String,
    version_id: String,
) -> Result<Instance, String> {
    let name = validate_instance_name(&name)?;
    create_instance_from_version_impl(state, Some(name), version_id, None)
}

pub(crate) fn validate_instance_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("实例名需要为 1–80 个可显示字符".into());
    }
    Ok(name)
}

/// A version folder name is also a Windows directory name. Reserved device
/// names, separators, trailing dots/spaces and over-long names are refused.
pub(crate) fn validate_version_folder_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err(crate::errors::INSTANCE_FOLDER_NAME_INVALID.into());
    }
    validate_id(name).map_err(|_| crate::errors::INSTANCE_FOLDER_NAME_INVALID.to_owned())?;
    Ok(name.to_owned())
}

/// Shared by every path that creates a `versions/<folder>`: a named instance
/// with an official id and a different base stops the launch resolver's chain.
pub(crate) fn official_version_name(
    state: &LauncherState,
    config: &Config,
    name: &str,
) -> bool {
    minecraft::cached_official_version_ids(state, &config.download_source).contains(name)
}

/// Copy, conversion and imports may not create a folder whose name is an
/// official Minecraft version. The create paths keep their narrower rule so a
/// vanilla install may still use the id the installer is creating.
pub(crate) fn require_non_official_folder_name(
    state: &LauncherState,
    config: &Config,
    name: &str,
) -> Result<(), String> {
    if official_version_name(state, config, name) {
        Err(crate::errors::INSTANCE_OFFICIAL_NAME.into())
    } else {
        Ok(())
    }
}

pub(crate) fn folder_name_taken(root: &Path, name: &str) -> bool {
    let Ok(versions) = safe_join(root, "versions") else {
        return true;
    };
    let Ok(entries) = std::fs::read_dir(versions) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(name)
    })
}

fn default_loader_label(loader: &str) -> &'static str {
    match loader {
        "fabric" => "Fabric",
        "quilt" => "Quilt",
        "forge" => "Forge",
        "neoforge" => "NeoForge",
        "optifine" => "OptiFine",
        _ => "",
    }
}

pub(crate) fn default_instance_name(
    root: &Path,
    game_version: &str,
    loader: &str,
) -> String {
    let label = default_loader_label(loader);
    let base = if label.is_empty() {
        game_version.to_owned()
    } else {
        format!("{game_version}-{label}")
    };
    if !folder_name_taken(root, &base) {
        return base;
    }
    for suffix in 2..=999 {
        let candidate = format!("{base}-{suffix}");
        if !folder_name_taken(root, &candidate) {
            return candidate;
        }
    }
    format!("{base}-{}", uuid::Uuid::new_v4())
}

/// The profile value for a standard instance folder: a child of the official
/// vanilla version, as PCL and HMCL write. Loader metadata (libraries, main
/// class, arguments) is copied from the installed loader profile.
pub(crate) fn instance_profile_value(
    root: &Path,
    name: &str,
    game_version: &str,
    installed_id: &str,
    loader: &str,
) -> Result<Value, String> {
    let mut profile = if loader == "vanilla" || installed_id == game_version {
        json!({ "id": name, "inheritsFrom": game_version })
    } else {
        let path = safe_join(root, &format!("versions/{installed_id}/{installed_id}.json"))?;
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("无法读取加载器配置：{error}"))?;
        serde_json::from_slice(&bytes).map_err(|error| format!("加载器配置无效：{error}"))?
    };
    if let Some(object) = profile.as_object_mut() {
        object.insert("id".into(), json!(name));
        object.insert("inheritsFrom".into(), json!(game_version));
        object.remove("jar");
    }
    Ok(profile)
}

/// Write `versions/<name>/<name>.json` under `directory`. `root` is the game
/// folder used for the ownership key, which may differ while a pack is staged.
pub(crate) fn write_instance_profile_at(
    state: &LauncherState,
    root: &Path,
    directory: &Path,
    name: &str,
    game_version: &str,
    installed_id: &str,
    loader: &str,
) -> Result<(), String> {
    let profile = instance_profile_value(root, name, game_version, installed_id, loader)?;
    let path = safe_join(directory, &format!("{name}.json"))?;
    let bytes = serde_json::to_vec_pretty(&profile).map_err(|error| error.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("无法写入实例版本配置：{error}"))?;
    use std::io::Write;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("无法写入实例版本配置：{error}"))?;
    drop(file);
    let ownership_path = safe_join(&safe_join(root, &format!("versions/{name}"))?, &format!("{name}.json"))?;
    crate::instances::remember_owned_profile(state, &ownership_path, &bytes)?;
    Ok(())
}

/// Write the profile that makes `<root>/versions/<name>/` a launchable child of
/// the official vanilla version, as PCL and HMCL do. The folder and file are
/// created exclusively and the file's hash is recorded so later launches can
/// trust it.
pub(crate) fn write_instance_profile(    state: &LauncherState,
    root: &Path,
    name: &str,
    game_version: &str,
    installed_id: &str,
    loader: &str,
) -> Result<(), String> {
    let directory = safe_join(root, &format!("versions/{name}"))?;
    std::fs::create_dir(&directory)
        .map_err(|error| format!("无法创建实例文件夹（同名文件夹已存在？）：{error}"))?;
    write_instance_profile_at(
        state,
        root,
        &directory,
        name,
        game_version,
        installed_id,
        loader,
    )
}

/// Keep a version-folder instance's own profile in sync after a loader switch.
/// The new loader files stay shared under `versions/<installed>/`; the named
/// profile copy inherits the vanilla base and the new loader metadata, so the
/// instance folder remains launchable as a standard instance. Returns the
/// instance's effective version id (its folder name).
pub(crate) fn rewrite_version_folder_profile(
    state: &LauncherState,
    instance: &Instance,
    installed_id: &str,
    loader: &str,
) -> Result<String, String> {
    let folder = instance.version_id.clone();
    validate_version_folder_name(&folder)?;
    let config = state.snapshot()?.config;
    let root = crate::processes::configured_game_root(Path::new(&instance.game_folder))
        .or_else(|_| crate::processes::configured_game_root(Path::new(&config.game_directory)))?;
    let directory = safe_join(&root, &format!("versions/{folder}"))?;
    let profile = version_folder_profile_value(state, &root, &folder, installed_id, loader)?;
    let path = safe_join(&directory, &format!("{folder}.json"))?;
    let existing = std::fs::read(&path).map_err(|error| format!("无法读取实例版本配置：{error}"))?;
    let current: Value = serde_json::from_slice(&existing)
        .map_err(|error| format!("实例版本配置无效：{error}"))?;
    if current["id"].as_str() != Some(folder.as_str()) {
        return Err("实例版本配置的 ID 与其文件夹不一致，已保留原文件".into());
    }
    write_version_folder_profile_at(state, &root, &directory, &folder, &profile)?;
    Ok(folder)
}

/// Rewrite a version folder's profile inside a staging copy. No backup is
/// written there: the copied folder either publishes with this profile in the
/// expected file list or the whole stage is discarded.
pub(crate) fn rewrite_version_folder_profile_at(
    state: &LauncherState,
    instance: &Instance,
    directory: &Path,
    installed_id: &str,
    loader: &str,
) -> Result<String, String> {
    let folder = instance.version_id.clone();
    validate_version_folder_name(&folder)?;
    let config = state.snapshot()?.config;
    let root = crate::processes::configured_game_root(Path::new(&instance.game_folder))
        .or_else(|_| crate::processes::configured_game_root(Path::new(&config.game_directory)))?;
    let profile = version_folder_profile_value(state, &root, &folder, installed_id, loader)?;
    write_version_folder_profile_at(state, &root, directory, &folder, &profile)?;
    Ok(folder)
}

fn version_folder_profile_value(
    state: &LauncherState,
    root: &Path,
    folder: &str,
    installed_id: &str,
    loader: &str,
) -> Result<Value, String> {
    let base = crate::resources::version_context(root, installed_id)
        .map(|(base, _)| base)
        .unwrap_or_else(|_| installed_id.to_owned());
    require_own_version_profile(state, root, folder, &base)?;
    instance_profile_value(root, folder, &base, installed_id, loader)
}

/// A loader switch rewrites `versions/<folder>/<folder>.json` in place, which
/// is only safe for an instance's own profile. It is refused for an official
/// version id (the vanilla profile every instance of that version inherits), a
/// profile whose base is the folder itself (a complete standalone profile; the
/// rewrite would make it inherit from itself) and a folder that other version
/// folders or managed instances inherit from. It is also refused for a loader
/// installer's own folder (see `loader_installer_folder`).
pub(crate) fn require_own_version_profile(
    state: &LauncherState,
    root: &Path,
    folder: &str,
    base: &str,
) -> Result<(), String> {
    let data = state.snapshot()?;
    if base.eq_ignore_ascii_case(folder)
        || official_version_name(state, &data.config, folder)
        || !dependant_names(&data, root, folder)?.is_empty()
    {
        return Err(crate::errors::INSTANCE_LOADER_SWITCH_SHARED.into());
    }
    if loader_installer_folder(&data, root, folder) {
        return Err(crate::errors::INSTANCE_LOADER_SWITCH_INSTALLER_FOLDER.into());
    }
    Ok(())
}

/// Whether `versions/<folder>/` is the output of a loader installer, such as
/// `fabric-loader-0.16.9-1.21.1` installed from Downloads. The next install of
/// that loader, which every create or import with it runs, rewrites
/// `<folder>.json` without a backup, so a loader switched in place there would
/// silently launch the old loader again. Such a folder is named the way the
/// Fabric, Quilt, Forge, NeoForge and OptiFine installers name what they
/// install; a profile Voxelight's own installer wrote also counts when the
/// folder name carries its loader version and Voxelight did not write it as
/// an instance's own profile.
pub(crate) fn loader_installer_folder(data: &Persisted, root: &Path, folder: &str) -> bool {
    if installer_shaped_folder_name(folder) {
        return true;
    }
    let Ok(path) = safe_join(root, &format!("versions/{folder}/{folder}.json")) else {
        return false;
    };
    let Some(profile) = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return false;
    };
    let metadata = &profile["launcherMetadata"];
    let loader_version = metadata["loaderVersion"].as_str().unwrap_or_default().to_ascii_lowercase();
    metadata["officialVanillaBase"].is_string()
        && !loader_version.is_empty()
        && folder.to_ascii_lowercase().contains(&loader_version)
        && !crate::instances::profile_is_owned(data, &path)
}

/// The version ids the loader installers write: `fabric-loader-<loader>-<mc>`,
/// `quilt-loader-<loader>-<mc>`, `neoforge-21.1.77`, `<mc>-forge-47.2.0` (also
/// the older `1.7.10-Forge10.13.4.1614-1.7.10`) and `<mc>-OptiFine_HD_U_J1`.
/// A default instance name such as `1.21.1-Forge`, `1.21.1-Forge-2` or
/// `1.21.1-OptiFine` carries no loader version and does not match. Those ids
/// are made of version strings only, so a name with a space, such as the
/// default copy name `fabric-loader-0.16.9-1.21.1 Copy`, is never one of them.
fn installer_shaped_folder_name(folder: &str) -> bool {
    if !folder
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "._+-".contains(character))
    {
        return false;
    }
    let name = folder.to_ascii_lowercase();
    let starts_with_digit = |text: &str| text.starts_with(|character: char| character.is_ascii_digit());
    if name.starts_with("fabric-loader-") || name.starts_with("quilt-loader-") {
        return true;
    }
    if name.strip_prefix("neoforge-").is_some_and(starts_with_digit) {
        return true;
    }
    let Some((minecraft, rest)) = name.split_once('-') else {
        return false;
    };
    if !starts_with_digit(minecraft) {
        return false;
    }
    if let Some(edition) = rest.strip_prefix("optifine_") {
        return !edition.is_empty();
    }
    rest.strip_prefix("neoforge")
        .or_else(|| rest.strip_prefix("forge"))
        .map(|version| version.strip_prefix('-').unwrap_or(version))
        .is_some_and(|version| starts_with_digit(version) && version.contains('.'))
}

/// The same refusal for a version-folder instance before its loader switch
/// takes a backup or installs anything. `base` is the Minecraft version the
/// instance resolves to now.
pub(crate) fn require_switchable_instance(
    state: &LauncherState,
    instance: &Instance,
    base: &str,
) -> Result<(), String> {
    if !instance.is_version_folder() {
        return Ok(());
    }
    let config = state.snapshot()?.config;
    let root = crate::processes::configured_game_root(Path::new(&instance.game_folder))
        .or_else(|_| crate::processes::configured_game_root(Path::new(&config.game_directory)))?;
    require_own_version_profile(state, &root, &instance.version_id, base)
}

/// Write one profile into a live or staged version folder with a same-volume
/// replace. The old profile is never left beside it as a stray `.backup-*`.
/// Ownership is recorded for the live `<root>/versions/<folder>/<folder>.json`
/// where the profile is published, never for the staging copy's path.
fn write_version_folder_profile_at(
    state: &LauncherState,
    root: &Path,
    directory: &Path,
    folder: &str,
    profile: &Value,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(profile).map_err(|error| error.to_string())?;
    let path = safe_join(directory, &format!("{folder}.json"))?;
    let temporary = safe_join(directory, &format!(".{folder}.json-{}.tmp", uuid::Uuid::new_v4()))?;
    std::fs::write(&temporary, &bytes).map_err(|error| format!("无法写入实例版本配置：{error}"))?;
    if let Err(error) = std::fs::rename(&temporary, &path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("无法更新实例版本配置：{error}"));
    }
    let published = safe_join(&safe_join(root, &format!("versions/{folder}"))?, &format!("{folder}.json"))?;
    crate::instances::remember_owned_profile(state, &published, &bytes)?;
    Ok(())
}

/// Turn a pack or instance display name into a safe, unique version folder name.
pub(crate) fn unique_version_folder_name(root: &Path, desired: &str, fallback: &str) -> String {
    let mut cleaned: String = desired
        .trim()
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '-'
            } else {
                character
            }
        })
        .take(56)
        .collect();
    while cleaned.ends_with(['.', ' ']) {
        cleaned.pop();
    }
    if cleaned.is_empty() || validate_id(&cleaned).is_err() {
        cleaned = fallback.trim().to_owned();
    }
    if cleaned.is_empty() {
        cleaned = "instance".into();
    }
    if !folder_name_taken(root, &cleaned) {
        return cleaned;
    }
    for suffix in 2..=999 {
        let candidate = format!("{cleaned}-{suffix}");
        if !folder_name_taken(root, &candidate) {
            return candidate;
        }
    }
    format!("{cleaned}-{}", uuid::Uuid::new_v4())
}

#[tauri::command]
pub async fn suggest_instance_name(
    state: Shared<'_>,
    game_version: String,
    loader: String,
) -> AppResult<String> {
    validate_id(&game_version).map_err(expected)?;
    let config = state.snapshot()?.config;
    let root = crate::processes::configured_game_root(Path::new(&config.game_directory))
        .map_err(expected)?;
    Ok(default_instance_name(&root, &game_version, &loader))
}

/// Create and install a new instance in `versions/<name>/` with isolation on.
#[tauri::command]
pub async fn create_game_instance(
    app: AppHandle,
    state: Shared<'_>,
    name: Option<String>,
    game_version: String,
    loader: String,
    loader_version: String,
) -> AppResult<Instance> {
    create_game_instance_inner(&app, &state, name, game_version, loader, loader_version)
        .await
        .map_err(expected)
}

pub(crate) async fn create_game_instance_inner(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    name: Option<String>,
    game_version: String,
    loader: String,
    loader_version: String,
) -> Result<Instance, String> {
    let install_state = state.clone();
    let install_version = game_version.clone();
    let install_loader = loader.clone();
    let install = async move {
        let (_, base) = minecraft::install(&install_state, app, &install_version).await?;
        let base_id = base["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .unwrap_or(&install_version)
            .to_owned();
        if install_loader == "vanilla" {
            Ok::<_, String>((base_id, install_version.clone(), String::new()))
        } else {
            let installed = crate::loaders::install_loader_inner(
                &install_state,
                app,
                &install_loader,
                &install_version,
                &loader_version,
            )
            .await?;
            Ok((base_id, installed.version_id, installed.loader_version))
        }
    };
    create_game_instance_with(state, name, game_version, loader, install).await
}

/// The downloads-history kind of a create. It has no retry runner.
pub(crate) const CREATE_INSTANCE_TASK_KIND: &str = "instance-create";

/// What `versions/` held before an install, and which version folders were
/// visible instances. A create, import or loader switch hides the loader
/// folder its install produced behind the named instance it publishes, but
/// only a folder that install created: an existing one may be the user's own
/// visible instance or another instance's parent.
#[derive(Default)]
pub(crate) struct LoaderParents {
    known: bool,
    folders: std::collections::HashSet<String>,
    visible: std::collections::HashSet<String>,
}

impl LoaderParents {
    /// Taken before the install starts. An unreadable folder or state hides
    /// nothing afterwards.
    pub(crate) fn before_install(state: &LauncherState, root: &Path, game_folder: &str) -> Self {
        let Ok(data) = state.snapshot() else {
            return Self::default();
        };
        let folders = match safe_join(root, "versions").map(std::fs::read_dir) {
            Ok(Ok(entries)) => entries
                .flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_ascii_lowercase))
                .collect(),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            _ => return Self::default(),
        };
        let visible = data
            .instances
            .iter()
            .filter(|instance| {
                instance.is_version_folder()
                    && !instance.hidden
                    && instance.folder_missing_since.is_none()
                    && same_game_folder_path(&instance.game_folder, game_folder)
            })
            .map(|instance| instance.version_id.to_ascii_lowercase())
            .collect();
        Self { known: true, folders, visible }
    }

    /// `before_install` for the active game folder, where every install goes.
    pub(crate) fn before_active_install(state: &LauncherState) -> Self {
        let Ok(config) = state.snapshot().map(|data| data.config) else {
            return Self::default();
        };
        match crate::processes::configured_game_root(Path::new(&config.game_directory)) {
            Ok(root) => Self::before_install(state, &root, &config.game_directory),
            Err(_) => Self::default(),
        }
    }

    /// The `derivedFrom` of the instance in `versions/<folder>/` whose install
    /// produced `installed_id`: that id when the install created the folder.
    pub(crate) fn derived_from(&self, installed_id: &str, folder: &str) -> Option<String> {
        let lower = installed_id.to_ascii_lowercase();
        (self.known
            && !installed_id.is_empty()
            && !installed_id.eq_ignore_ascii_case(folder)
            && !self.folders.contains(&lower)
            && !self.visible.contains(&lower))
        .then(|| installed_id.to_owned())
    }
}

/// Create a standard instance folder around an install step. Kept separate so
/// a behavioural test can supply the install instead of downloading a game.
pub(crate) async fn create_game_instance_with<F>(
    state: &Arc<LauncherState>,
    name: Option<String>,
    game_version: String,
    loader: String,
    install: F,
) -> Result<Instance, String>
where
    F: std::future::Future<Output = Result<(String, String, String), String>>,
{
    validate_id(&game_version)?;
    if !matches!(loader.as_str(), "vanilla" | "fabric" | "quilt" | "forge" | "neoforge") {
        return Err(crate::errors::INSTANCE_CREATE_UNSUPPORTED_LOADER.into());
    }
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成".to_owned())?;
    let config = state.snapshot()?.config;
    let root = minecraft::require_install_root_stopped(state, &config)?;
    let name = match name.filter(|name| !name.trim().is_empty()) {
        Some(name) => validate_version_folder_name(&name)?,
        None => default_instance_name(&root, &game_version, &loader),
    };
    // The install creates versions/<game_version> for vanilla, but only when it
    // does not exist yet. Typing that id while the folder exists must not
    // reinstall over a user's shared instance and silently isolate it.
    let registers_vanilla_folder = loader == "vanilla" && name == game_version;
    if loader != "vanilla" && name == game_version {
        return Err(crate::errors::INSTANCE_FOLDER_NAME_TAKEN.into());
    }
    if name != game_version && official_version_name(state, &config, &name) {
        return Err(crate::errors::INSTANCE_OFFICIAL_NAME.into());
    }
    if folder_name_taken(&root, &name) {
        return Err(crate::errors::INSTANCE_FOLDER_NAME_TAKEN.into());
    }
    let parents = LoaderParents::before_install(state, &root, &config.game_directory);
    // Not an "install" task: a retry of that kind (also an old row without a
    // payload) reinstalls only the vanilla version and creates no instance.
    // A failed create is started again from the create dialog.
    let task = state.control.begin_with_display(
        CREATE_INSTANCE_TASK_KIND,
        &game_version,
        &format!("创建实例 {name}"),
        &name,
    )?;
    let result = async {
        let (base_id, installed_id, detected_loader_version) = install.await?;
        // The install caches the official manifest; check the name again now
        // that the complete id list is available offline.
        if name != game_version && official_version_name(state, &config, &name) {
            return Err(crate::errors::INSTANCE_OFFICIAL_NAME.into());
        }
        if !registers_vanilla_folder {
            write_instance_profile(state, &root, &name, &base_id, &installed_id, &loader)?;
        }
        let (detected_loader, detected_version) = if loader == "vanilla" {
            ("vanilla".to_owned(), String::new())
        } else {
            (loader.clone(), detected_loader_version)
        };
        let directory = safe_join(&root, &format!("versions/{name}"))?;
        if !safe_join(&directory, &format!("{name}.json"))?.is_file() {
            return Err("实例版本配置缺失，未登记实例".into());
        }
        // The intermediate loader profile stays on disk for launching. Hide it
        // only when this call created it; an existing folder may be the user's
        // own visible instance (for example the vanilla base of a named create).
        let derived_from = parents.derived_from(&installed_id, &name);
        state.update(|data| {
            if let Some(existing) = data.instances.iter_mut().find(|instance| {
                instance.is_version_folder()
                    && instance.version_id == name
                    && crate::models::same_game_folder_path(
                        &instance.game_folder,
                        &config.game_directory,
                    )
            }) {
                existing.hidden = false;
                existing.folder_missing_since = None;
                existing.game_directory = crate::storage::display_profile_path(&directory);
                existing.isolated = true;
                existing.loader = detected_loader;
                existing.loader_version = detected_version;
                existing.derived_from = derived_from;
                existing.issue = None;
                return Ok(existing.clone());
            }
            let id = crate::instances::version_instance_id(&config.game_directory, &name);
            // A stale record with the same identity belongs to a folder that
            // once used this name; replace it instead of duplicating the id.
            data.instances.retain(|instance| instance.id != id);
            let instance = Instance {
                id,
                name: name.clone(),
                version_id: name.clone(),
                game_directory: crate::storage::display_profile_path(&directory),
                created_at: chrono::Utc::now().to_rfc3339(),
                last_played: None,
                category: "normal".into(),
                loader: detected_loader,
                loader_version: detected_version,
                kind: "version".into(),
                game_folder: config.game_directory.clone(),
                isolated: true,
                hidden: false,
                folder_missing_since: None,
                issue: None,
                derived_from,
                ..Default::default()
            };
            data.instances.push(instance.clone());
            Ok(instance)
        })
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    if let Err(error) = &result {
        let line = format!(
            "{} [error] 创建实例失败：{error}\n",
            chrono::Utc::now().to_rfc3339()
        );
        let _ = crate::process_output::append_log(&state.data_dir.join("logs"), &line);
    }
    result
}

/// Promote an already installed profile (for example an imported OptiFine
/// installer) into a standard named instance folder.
#[tauri::command]
pub fn create_instance_from_version(
    state: Shared<'_>,
    name: Option<String>,
    version_id: String,
) -> AppResult<Instance> {
    create_instance_from_version_inner(&state, name, version_id).map_err(expected)
}

pub(crate) fn create_instance_from_version_inner(
    state: &LauncherState,
    name: Option<String>,
    version_id: String,
) -> Result<Instance, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成".to_owned())?;
    create_instance_from_version_impl(state, name, version_id, None)
}

/// The same creation for callers that already hold the operation lock (the
/// resource create path queues for it before installing). `derived_from` is
/// the loader folder the caller's own install created for this instance (see
/// `LoaderParents`); promoting a profile that was already there passes `None`.
pub(crate) fn create_instance_from_version_impl(
    state: &LauncherState,
    name: Option<String>,
    version_id: String,
    derived_from: Option<String>,
) -> Result<Instance, String> {
    validate_id(&version_id)?;
    let config = state.snapshot()?.config;
    let root = crate::processes::configured_game_root(Path::new(&config.game_directory))?;
    // Creating a new folder from an installed profile only reads the shared
    // versions/ tree. Other instances may keep running; only an operation on
    // the same folder needs its game stopped.
    let (base, loader) = crate::resources::version_context(&root, &version_id)?;
    let loader = loader.unwrap_or_else(|| "vanilla".into());
    let (_, loader_version) = installed_loader(&config, &version_id);
    let name = match name.filter(|name| !name.trim().is_empty()) {
        Some(name) => validate_version_folder_name(&name)?,
        None => default_instance_name(&root, &base, &loader),
    };
    if name != base {
        require_non_official_folder_name(state, &config, &name)?;
    }
    if folder_name_taken(&root, &name) {
        return Err(crate::errors::INSTANCE_FOLDER_NAME_TAKEN.into());
    }
    write_instance_profile(state, &root, &name, &base, &version_id, &loader)?;
    let directory = crate::storage::display_profile_path(
        &safe_join(&root, &format!("versions/{name}"))?,
    );
    let instance = Instance {
        id: crate::instances::version_instance_id(&config.game_directory, &name),
        name: name.clone(),
        version_id: name.clone(),
        game_directory: directory,
        created_at: chrono::Utc::now().to_rfc3339(),
        last_played: None,
        category: "normal".into(),
        loader,
        loader_version,
        kind: "version".into(),
        game_folder: config.game_directory.clone(),
        isolated: true,
        hidden: false,
        folder_missing_since: None,
        issue: None,
        derived_from: derived_from.filter(|parent| !parent.eq_ignore_ascii_case(&name)),
        ..Default::default()
    };
    crate::instances::register_version_instance(state, instance)
}

/// PCL's "copy version": copy the version folder to a new folder, rename the
/// JSON id, and register it as an isolated instance.
#[tauri::command]
pub async fn copy_instance(
    state: Shared<'_>,
    instance_id: String,
    name: Option<String>,
) -> AppResult<Instance> {
    copy_instance_inner(&state, &instance_id, name.as_deref())
        .await
        .map_err(expected)
}

pub(crate) async fn copy_instance_inner(
    state: &Arc<LauncherState>,
    instance_id: &str,
    name: Option<&str>,
) -> Result<Instance, String> {
    let _guard = state.operation.lock().await;
    let data = state.snapshot()?;
    let source = data
        .instances
        .iter()
        .find(|item| item.id == instance_id)
        .cloned()
        .ok_or_else(|| "实例不存在，请刷新实例列表".to_owned())?;
    if !source.is_version_folder() {
        let clone_name = match name.filter(|name| !name.trim().is_empty()) {
            Some(name) => name.to_owned(),
            None => format!("{} Copy", source.name),
        };
        drop(_guard);
        return crate::instances::clone_instance_for_state(state, instance_id.to_owned(), clone_name)
            .await;
    }
    let root = crate::processes::configured_game_root(Path::new(&source.game_folder))
        .or_else(|_| crate::processes::configured_game_root(Path::new(&data.config.game_directory)))?;
    let name = match name.filter(|name| !name.trim().is_empty()) {
        Some(name) => validate_version_folder_name(name)?,
        None => unique_version_folder_name(&root, &format!("{} Copy", source.name), &source.version_id),
    };
    require_non_official_folder_name(state, &data.config, &name)?;
    if folder_name_taken(&root, &name) {
        return Err(crate::errors::INSTANCE_FOLDER_NAME_TAKEN.into());
    }
    state.games.require_instance_stopped(instance_id)?;
    let source_dir = crate::instances::checked_absolute(&safe_join(
        &root,
        &format!("versions/{}", source.version_id),
    )?)?;
    state
        .games
        .require_directory_stopped(&source_dir, Some(instance_id), false)?;
    let destination = safe_join(&root, &format!("versions/{name}"))?;
    if destination.exists() {
        return Err("实例文件夹名已存在，请换一个名称".into());
    }
    // File copying and profile rewriting are blocking work; keep them off the
    // async runtime. Everything happens in an owned staging directory and is
    // published with a single rename, so a failure never leaves a half copy.
    let copy_state = state.clone();
    let copy_source = source.clone();
    let copy_name = name.clone();
    let staging_root = root.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        copy_version_folder(&copy_state, &copy_source, &staging_root, &copy_name)
    })
    .await
    .map_err(|error| format!("复制实例任务异常：{error}"))??;
    let profile_path = destination.join(format!("{name}.json"));
    let owned_key = crate::instances::owned_profile_key(&profile_path);
    let profile_hash = crate::instances::sha256_bytes(&prepared.profile);
    let directory = crate::storage::display_profile_path(&destination);
    let source_for_record = source.clone();
    let name_for_record = name.clone();
    let registered = state.update(|data| {
        let id = crate::instances::version_instance_id(&source_for_record.game_folder, &name_for_record);
        // A stale record for a folder that vanished keeps this id for its
        // 30-day grace period. Replace it instead of storing a duplicate id.
        data.instances.retain(|instance| instance.id != id);
        data.owned_profiles.insert(owned_key.clone(), profile_hash.clone());
        let instance = Instance {
            id,
            name: name_for_record.clone(),
            version_id: name_for_record.clone(),
            game_directory: directory.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            last_played: None,
            category: source_for_record.category.clone(),
            icon_path: source_for_record.icon_path.clone(),
            notes: source_for_record.notes.clone(),
            max_memory_mb: source_for_record.max_memory_mb,
            memory_mode: source_for_record.memory_mode.clone(),
            min_memory_mb: source_for_record.min_memory_mb,
            java_path: source_for_record.java_path.clone(),
            jvm_arguments: source_for_record.jvm_arguments.clone(),
            game_proxy_mode: source_for_record.game_proxy_mode.clone(),
            screen_width: source_for_record.screen_width,
            screen_height: source_for_record.screen_height,
            total_play_time: 0,
            loader: source_for_record.loader.clone(),
            loader_version: source_for_record.loader_version.clone(),
            kind: "version".into(),
            game_folder: source_for_record.game_folder.clone(),
            isolated: true,
            hidden: false,
            folder_missing_since: None,
            issue: None,
            derived_from: None,
        };
        data.instances.push(instance.clone());
        Ok(instance)
    });
    match registered {
        Ok(instance) => Ok(instance),
        Err(error) => {
            // The record is the only reason the copy exists; never leave an
            // unregistered folder behind.
            let _ = std::fs::remove_dir_all(&destination);
            Err(format!("复制实例登记失败，已清理复制文件夹：{error}"))
        }
    }
}

#[cfg(test)]
static COPY_STAGE_HOOK: std::sync::Mutex<Option<(String, Box<dyn FnMut(&Path) + Send>)>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
pub(crate) fn set_copy_stage_hook(
    name: &str,
    hook: Option<Box<dyn FnMut(&Path) + Send>>,
) {
    *COPY_STAGE_HOOK.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) =
        hook.map(|hook| (name.to_owned(), hook));
}

struct CopiedVersionFolder {
    profile: Vec<u8>,
}

/// Copy `versions/<source.version_id>/` into a staging folder, rewrite its
/// profile so the copy keeps the real Minecraft version, then publish it at
/// `versions/<name>/`.
fn copy_version_folder(
    state: &LauncherState,
    source: &Instance,
    root: &Path,
    name: &str,
) -> Result<CopiedVersionFolder, String> {
    let source_dir = crate::instances::checked_absolute(&safe_join(
        root,
        &format!("versions/{}", source.version_id),
    )?)?;
    let files = crate::instances::collect_instance_files_controlled(&source_dir, None)?;
    let staging_parent = safe_join(root, ".voxelight-staging")?;
    let staging = safe_join(&staging_parent, &format!(".copy-{}", uuid::Uuid::new_v4()))?;
    let mut staging = crate::instances::StagingDirectory::create(staging)?;
    crate::instances::copy_into_owned_directory(&source_dir, staging.path(), &files)?;
    let profile_path = staging.path().join(format!("{}.json", source.version_id));
    let bytes = std::fs::read(&profile_path)
        .map_err(|error| format!("复制的实例缺少版本配置：{error}"))?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("版本配置无效：{error}"))?;
    // An official vanilla folder becomes the PCL-style child of that folder,
    // so the copy keeps its Minecraft version. A complete merged loader
    // profile from another launcher is copied as-is instead: adding
    // inheritsFrom would make the launch resolver concatenate the game
    // arguments and pass --username & co. twice. Anything else inherits the
    // real base found from its own fields.
    let config = state.snapshot()?.config;
    let base = if vanilla_terminal_profile(state, &config, &value, &source.version_id) {
        Some(source.version_id.clone())
    } else if complete_instance_profile(&value) {
        None
    } else {
        Some(copy_profile_base(root, source, name, &value)?)
    };
    let profile =
        Value::Object(copy_profile_metadata(&value, name, base.as_deref(), &source.version_id));
    let output = serde_json::to_vec_pretty(&profile).map_err(|error| error.to_string())?;
    std::fs::write(staging.path().join(format!("{name}.json")), &output)
        .map_err(|error| format!("无法写入复制实例的版本配置：{error}"))?;
    std::fs::remove_file(&profile_path)
        .map_err(|error| format!("无法整理复制实例的版本配置：{error}"))?;
    let jar = staging.path().join(format!("{}.jar", source.version_id));
    if jar.is_file() {
        std::fs::rename(&jar, staging.path().join(format!("{name}.jar")))
            .map_err(|error| format!("无法整理复制实例的客户端文件：{error}"))?;
    }
    // A stale profile backup must not become part of a new copy.
    if let Ok(entries) = std::fs::read_dir(staging.path()) {
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if file.contains(".json.backup-") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let mut expected: Vec<crate::instances::FileRecord> = files
        .iter()
        .filter(|record| {
            !record.relative.eq_ignore_ascii_case(&format!("{}.json", source.version_id))
                && !record.relative.eq_ignore_ascii_case(&format!("{}.jar", source.version_id))
                && !record.relative.to_ascii_lowercase().contains(".json.backup-")
        })
        .cloned()
        .collect();
    expected.push(crate::instances::FileRecord {
        relative: format!("{name}.json"),
        size: output.len() as u64,
        sha256: crate::instances::sha256_bytes(&output),
    });
    if staging.path().join(format!("{name}.jar")).is_file() {
        expected.push(crate::instances::FileRecord {
            relative: format!("{name}.jar"),
            size: files
                .iter()
                .find(|record| record.relative.eq_ignore_ascii_case(&format!("{}.jar", source.version_id)))
                .map_or(0, |record| record.size),
            sha256: files
                .iter()
                .find(|record| record.relative.eq_ignore_ascii_case(&format!("{}.jar", source.version_id)))
                .map_or_else(String::new, |record| record.sha256.clone()),
        });
    }
    #[cfg(test)]
    {
        let mut hook = COPY_STAGE_HOOK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some((expected, mut run)) = hook.take() {
            if expected == name {
                run(staging.path());
            } else {
                *COPY_STAGE_HOOK
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    Some((expected, run));
            }
        }
    }
    crate::instances::verify_staged_files(staging.path(), &expected)?;
    // The copy is always an isolated instance, even when the source shared the
    // root: give it the empty folders isolation expects.
    std::fs::create_dir_all(staging.path().join("saves"))
        .map_err(|error| format!("无法创建复制实例的存档目录：{error}"))?;
    std::fs::create_dir_all(staging.path().join("mods"))
        .map_err(|error| format!("无法创建复制实例的模组目录：{error}"))?;
    let destination = safe_join(root, &format!("versions/{name}"))?;
    if destination.exists() {
        return Err("实例文件夹名已存在，请换一个名称".into());
    }
    staging
        .publish(&destination)
        .map_err(|error| format!("无法提交复制实例文件夹：{error}"))?;
    Ok(CopiedVersionFolder { profile: output })
}

/// An official vanilla folder: a terminal profile without a loader whose main
/// class is the vanilla client's, or whose folder is an official version id.
/// A copy of it inherits it, exactly like a PCL or HMCL child, instead of
/// becoming a standalone profile named after the copy.
fn vanilla_terminal_profile(
    state: &LauncherState,
    config: &Config,
    profile: &Value,
    source_id: &str,
) -> bool {
    if profile.get("inheritsFrom").is_some() || crate::resources::detect_loader(profile).is_some() {
        return false;
    }
    matches!(
        profile["mainClass"].as_str(),
        Some("net.minecraft.client.main.Main" | "net.minecraft.client.Minecraft")
    ) || official_version_name(state, config, source_id)
}

/// A merged standalone profile has everything a launch needs. Inheriting from
/// its old id would make merge_metadata concatenate the complete argument list
/// onto itself.
fn complete_instance_profile(profile: &Value) -> bool {
    let has_arguments = profile["arguments"]["game"]
        .as_array()
        .is_some_and(|arguments| !arguments.is_empty())
        || profile["minecraftArguments"]
            .as_str()
            .is_some_and(|arguments| !arguments.trim().is_empty());
    profile["mainClass"].as_str().is_some_and(|value| !value.trim().is_empty())
        && profile.get("inheritsFrom").is_none()
        && profile.get("libraries").and_then(Value::as_array).is_some()
        && has_arguments
}

/// The real Minecraft version of the copied profile. A merged or vanilla
/// standalone profile has no `inheritsFrom`; writing one keeps the chain and
/// makes the copy launch as the same game version instead of its folder name.
fn copy_profile_base(
    root: &Path,
    source: &Instance,
    name: &str,
    profile: &Value,
) -> Result<String, String> {
    let installed = |candidate: &str| {
        validate_id(candidate).is_ok()
            && candidate != name
            && !candidate.eq_ignore_ascii_case(&source.version_id)
            && safe_join(root, &format!("versions/{candidate}/{candidate}.json"))
                .is_ok_and(|path| path.is_file())
    };
    for key in ["inheritsFrom", "jar"] {
        if let Some(base) = profile[key].as_str().filter(|base| installed(base)) {
            return Ok(base.to_owned());
        }
    }
    if let Some(base) = profile["launcherMetadata"]["officialVanillaBase"]
        .as_str()
        .filter(|base| installed(base))
    {
        return Ok(base.to_owned());
    }
    if let Some(id) = profile["id"].as_str().filter(|id| installed(id)) {
        return Ok(id.to_owned());
    }
    // A merged profile id such as "fabric-loader-0.16.9-1.21.1" or
    // "1.21.1-forge-52.0.0" still names its vanilla version.
    let mut candidates: Vec<String> = std::fs::read_dir(safe_join(root, "versions")?)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
                .filter(|candidate| installed(candidate))
                .collect()
        })
        .unwrap_or_default();
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.len()));
    for candidate in candidates {
        let names = [
            source.version_id.as_str(),
            profile["id"].as_str().unwrap_or_default(),
        ];
        let named = names.iter().any(|id| id.eq_ignore_ascii_case(&candidate));
        let prefixed = names.iter().any(|id| {
            id.starts_with(&format!("{candidate}-")) || id.ends_with(&format!("-{candidate}"))
        });
        if named || prefixed {
            return Ok(candidate);
        }
    }
    Err(crate::instances::BASE_VERSION_UNKNOWN.into())
}

/// Rewrite the profile id and, when the source is incomplete, make the copy
/// inherit its base. A complete standalone profile is copied verbatim except
/// for its id and a jar that pointed at the source folder.
fn copy_profile_metadata(
    profile: &Value,
    name: &str,
    base: Option<&str>,
    source_id: &str,
) -> serde_json::Map<String, Value> {
    if base.is_none() && complete_instance_profile(profile) {
        let mut object = profile.as_object().cloned().unwrap_or_default();
        object.insert("id".into(), json!(name));
        if object
            .get("jar")
            .and_then(Value::as_str)
            .is_some_and(|jar| jar.eq_ignore_ascii_case(source_id))
        {
            object.insert("jar".into(), json!(name));
        }
        return object;
    }
    let loader = crate::resources::detect_loader(profile);
    let mut object = if loader.is_some() || profile.get("inheritsFrom").is_some() {
        profile.as_object().cloned().unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    object.insert("id".into(), json!(name));
    if let Some(base) = base {
        object.insert("inheritsFrom".into(), json!(base));
    }
    // The inherited base supplies the client download and jar.
    object.remove("jar");
    object
}

/// Names shown in the delete confirmation before the user commits. Reading is
/// read-only and never touches a folder.
#[tauri::command]
pub async fn list_instance_dependants(
    state: Shared<'_>,
    instance_id: String,
) -> AppResult<Vec<String>> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || list_instance_dependants_inner(&state, &instance_id))
        .await
        .map_err(|error| expected(format!("检查实例依赖任务异常：{error}")))?
        .map_err(expected)
}

pub(crate) fn list_instance_dependants_inner(
    state: &LauncherState,
    instance_id: &str,
) -> Result<Vec<String>, String> {
    let data = state.snapshot()?;
    let instance = data
        .instances
        .iter()
        .find(|item| item.id == instance_id)
        .ok_or_else(|| "实例不存在，请刷新实例列表".to_owned())?;
    if !instance.is_version_folder() {
        return Ok(Vec::new());
    }
    let root = crate::processes::configured_game_root(Path::new(&instance.game_folder))?;
    dependant_names(&data, &root, &instance.version_id)
}

#[tauri::command]
pub fn list_hidden_instances(state: Shared<'_>) -> AppResult<Vec<Instance>> {
    let data = state.snapshot()?;
    Ok(data
        .instances
        .iter()
        .filter(|instance| instance.hidden && instance.folder_missing_since.is_none())
        .filter(|instance| {
            instance.game_folder.is_empty()
                || crate::models::same_game_folder_path(
                    &instance.game_folder,
                    &data.config.game_directory,
                )
        })
        .cloned()
        .collect())
}

#[tauri::command]
pub fn restore_instance(state: Shared<'_>, instance_id: String) -> AppResult<Instance> {
    crate::instances::restore_instance_inner(&state, &instance_id).map_err(expected)
}

#[tauri::command]
pub fn remove_instance(state: Shared<'_>, instance_id: String) -> AppResult<Vec<Instance>> {
    remove_instance_inner(&state, &instance_id).map_err(expected)
}

fn remove_instance_inner(
    state: &LauncherState,
    instance_id: &str,
) -> Result<Vec<Instance>, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成后移除实例")?;
    state.games.require_instance_stopped(instance_id)?;
    state.update(|data| {
        let target = data
            .instances
            .iter_mut()
            .find(|i| i.id == instance_id)
            .ok_or("实例不存在")?;
        if target.is_version_folder() {
            // Hiding a version-folder instance never touches its files. A new
            // scan keeps the record, so its settings survive.
            target.hidden = true;
            return Ok(data.instances.clone());
        }
        data.instances.retain(|i| i.id != instance_id);
        // Removing a managed registration never deletes saves, mods or any directory.
        Ok(data.instances.clone())
    })
}

/// Whether an instance has its own game directory. Records written before the
/// version-folder model are launcher-managed and therefore isolated.
pub(crate) fn instance_is_isolated(instance: &Instance) -> bool {
    !instance.is_version_folder() || instance.isolated
}

pub(crate) fn require_isolated_instance(instance: &Instance) -> Result<(), String> {
    if instance_is_isolated(instance) {
        Ok(())
    } else {
        Err(crate::errors::INSTANCE_SHARED_ROOT.into())
    }
}

#[tauri::command]
pub async fn delete_instance(
    window: tauri::WebviewWindow,
    state: Shared<'_>,
    instance_id: String,
    confirmed: bool,
    permanent: Option<bool>,
) -> AppResult<Vec<Instance>> {
    let state = state.inner().clone();
    let id = instance_id.clone();
    let permanent = permanent.unwrap_or(false);
    let owner = recycle_owner(&window);
    tokio::task::spawn_blocking(move || {
        delete_instance_with_owner(&state, &id, confirmed, permanent, owner)
    })
        .await
        .map_err(|error| expected(format!("实例删除任务异常：{error}")))?
        .map_err(expected)
}

/// Every instance that would stop launching if `folder_name` were deleted.
/// `None` is a version folder with no record; legacy managed records are
/// matched by their `versionId` exactly like a profile dependency.
fn dependant_records(
    data: &Persisted,
    root: &Path,
    folder_name: &str,
) -> Result<Vec<(String, Option<Instance>, String)>, String> {
    let root_identity = crate::instances::normalized_folder_identity(&root.to_string_lossy());
    let mut dependants = Vec::new();
    for folder in crate::instances::version_dependants(root, folder_name)? {
        let record = data
            .instances
            .iter()
            .find(|instance| {
                instance.is_version_folder()
                    && instance.version_id.eq_ignore_ascii_case(&folder)
                    && crate::instances::normalized_folder_identity(&instance.game_folder)
                        == root_identity
            })
            .cloned();
        dependants.push((
            record.as_ref().map_or_else(|| folder.clone(), |value| value.name.clone()),
            record,
            folder,
        ));
    }
    for instance in &data.instances {
        if instance.is_version_folder()
            || !instance.version_id.eq_ignore_ascii_case(folder_name)
            || (!instance.game_folder.trim().is_empty()
                && crate::instances::normalized_folder_identity(&instance.game_folder) != root_identity)
            || dependants
                .iter()
                .any(|(_, record, _)| record.as_ref().is_some_and(|value| value.id == instance.id))
        {
            continue;
        }
        dependants.push((
            instance.name.clone(),
            Some(instance.clone()),
            instance.version_id.clone(),
        ));
    }
    Ok(dependants)
}

/// Names of the instances that would stop launching if `folder_name` were
/// deleted, using their display names where a record exists.
fn dependant_names(data: &Persisted, root: &Path, folder_name: &str) -> Result<Vec<String>, String> {
    Ok(dependant_records(data, root, folder_name)?
        .into_iter()
        .map(|(name, _, _)| name)
        .collect())
}

/// The launcher window as the owner of any dialog the shell still shows while
/// recycling (a folder too large for the bin). An owned dialog opens in front
/// of the launcher instead of somewhere behind it while the delete holds the
/// operation lock.
fn recycle_owner(window: &tauri::WebviewWindow) -> Option<isize> {
    #[cfg(windows)]
    {
        window.hwnd().ok().map(|hwnd| hwnd.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

/// The delete without a window to own a shell dialog; tests use it.
#[cfg(test)]
pub(crate) fn delete_instance_inner(
    state: &LauncherState,
    instance_id: &str,
    confirmed: bool,
    permanent: bool,
) -> Result<Vec<Instance>, String> {
    delete_instance_with_owner(state, instance_id, confirmed, permanent, None)
}

/// Delete an instance's record, and its folder through the Recycle Bin or,
/// when `permanent`, for good. `owner` is the launcher window that owns any
/// dialog the shell still shows.
pub(crate) fn delete_instance_with_owner(
    state: &LauncherState,
    instance_id: &str,
    confirmed: bool,
    permanent: bool,
    owner: Option<isize>,
) -> Result<Vec<Instance>, String> {
    if !confirmed {
        return Err(crate::errors::INSTANCE_DELETE_CONFIRM_REQUIRED.into());
    }
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成后删除实例")?;
    let data = state.snapshot()?;
    let instance = data
        .instances
        .iter()
        .find(|item| item.id == instance_id)
        .cloned()
        .ok_or_else(|| crate::errors::INSTANCE_FOLDER_UNSAFE.to_string())?;
    let config = data.config.clone();
    let root = crate::processes::configured_game_root(Path::new(&config.game_directory))?;
    let root_identity = crate::processes::canonical_game_directory(&root)?;
    let profile_identity = crate::processes::canonical_game_directory(&state.data_dir)?;
    state.games.require_instance_stopped(instance_id)?;
    let directory = if instance.is_version_folder() {
        // Only the version folder itself is deleted: never the root's saves,
        // libraries or assets.
        let owning_root = crate::processes::configured_game_root(Path::new(&instance.game_folder))?;
        let directory = crate::instances::checked_absolute(&safe_join(
            &owning_root,
            &format!("versions/{}", instance.version_id),
        )?)?;
        // Deleting a folder that other instances inherit from breaks their
        // launches. A running dependant is a running game, even when it shares
        // the root game directory.
        let dependants = dependant_records(&data, &owning_root, &instance.version_id)?;
        if !dependants.is_empty() {
            for (_, record, folder) in &dependants {
                if let Some(record) = record {
                    state.games.require_directory_stopped(
                        &stored_path(&record.game_directory)?,
                        Some(&record.id),
                        false,
                    )?;
                } else {
                    // A profile-only dependant has no record; its version
                    // folder is the launch directory.
                    state.games.require_directory_stopped(
                        &safe_join(&owning_root, &format!("versions/{folder}"))?,
                        None,
                        false,
                    )?;
                }
            }
            return Err(format!(
                "{}{}",
                crate::errors::INSTANCE_DELETE_DEPENDANTS_PREFIX,
                dependants
                    .into_iter()
                    .map(|(name, _, _)| name)
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
        state
            .games
            .require_directory_stopped(&directory, Some(instance_id), false)?;
        directory
    } else {
        let directory = crate::instances::checked_absolute(Path::new(&instance.game_directory))?;
        let identity = crate::processes::canonical_game_directory(&directory)?;
        let instances_dir = crate::processes::canonical_game_directory(
            &safe_join(&root, "instances").map_err(|error| format!("{error}"))?,
        )?;
        let relative = crate::processes::directory_tail(&identity, &instances_dir)
            .ok_or_else(|| crate::errors::INSTANCE_FOLDER_UNSAFE.to_string())?;
        let mut components = relative.components();
        let one_component = matches!(components.next(), Some(std::path::Component::Normal(_)))
            && components.next().is_none();
        if !one_component
            || identity == root_identity
            || identity == profile_identity
            || crate::processes::directory_tail(&identity, &root_identity)
                .is_some_and(|tail| {
                    let first = tail
                        .components()
                        .next()
                        .map(|part| part.as_os_str().to_string_lossy().to_ascii_lowercase())
                        .unwrap_or_default();
                    matches!(first.as_str(), "libraries" | "assets" | "versions")
                })
        {
            return Err(crate::errors::INSTANCE_FOLDER_UNSAFE.into());
        }
        state
            .games
            .require_directory_stopped(&directory, Some(instance_id), false)?;
        directory
    };
    if !directory.is_dir() {
        return Err(crate::errors::INSTANCE_FOLDER_UNSAFE.into());
    }
    if permanent {
        std::fs::remove_dir_all(&directory)
            .map_err(|error| format!("无法删除实例文件夹：{error}"))?;
    } else {
        recycle_path(&directory, owner).map_err(|error| {
            if error.starts_with(crate::errors::INSTANCE_RECYCLE_UNAVAILABLE_PREFIX)
                || error.starts_with(crate::errors::INSTANCE_RECYCLE_FAILED_PREFIX)
            {
                error
            } else {
                format!("{}{error}", crate::errors::INSTANCE_RECYCLE_FAILED_PREFIX)
            }
        })?;
    }
    state.update(|data| {
        let deleted_parent = instance.derived_from.clone();
        data.instances.retain(|item| item.id != instance_id);
        // The parent this named instance hid becomes a normal version again
        // once its last visible child is gone. Follow the deleted record's own
        // `derivedFrom`; the reverse direction would never find it.
        let Some(parent) = deleted_parent else {
            return Ok(data.instances.clone());
        };
        let still_derived = data.instances.iter().any(|other| {
            !other.hidden
                && other.derived_from.as_deref() == Some(parent.as_str())
                && crate::models::same_game_folder_path(&other.game_folder, &instance.game_folder)
        });
        if !still_derived {
            if let Some(record) = data.instances.iter_mut().find(|other| {
                other.is_version_folder()
                    && other.version_id.eq_ignore_ascii_case(&parent)
                    && crate::models::same_game_folder_path(
                        &other.game_folder,
                        &instance.game_folder,
                    )
            }) {
                record.hidden = false;
                record.derived_from = None;
            }
        }
        Ok(data.instances.clone())
    })
}

/// A stored display path is absolute; validate it the same way before using it
/// in a running-game check.
fn stored_path(value: &str) -> Result<PathBuf, String> {
    crate::instances::checked_absolute(Path::new(value))
}

#[cfg(test)]
type RecycleHook = Box<dyn FnMut(&Path, Option<isize>) -> Result<(), String>>;

#[cfg(test)]
thread_local! {
    static RECYCLE_HOOK: std::cell::RefCell<Option<RecycleHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_recycle_hook(hook: Option<RecycleHook>) {
    RECYCLE_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
thread_local! {
    static RECYCLE_SUPPORT_HOOK: std::cell::RefCell<Option<Box<dyn FnMut(&Path) -> Result<(), String>>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_recycle_support_hook(
    hook: Option<Box<dyn FnMut(&Path) -> Result<(), String>>>,
) {
    RECYCLE_SUPPORT_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

// A test can report a drive type, so the real support check runs for a
// removable or network drive the test machine does not have.
#[cfg(test)]
thread_local! {
    static DRIVE_TYPE_HOOK: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_drive_type_hook(kind: Option<u32>) {
    DRIVE_TYPE_HOOK.with(|slot| slot.set(kind));
}

/// Stable reasons a Recycle Bin delete is refused or failed. They travel as
/// codes and the interface translates them; no reason text is built here.
pub(crate) const RECYCLE_NETWORK_SHARE: &str = "networkShare";
pub(crate) const RECYCLE_NO_BIN: &str = "noRecycleBin";
pub(crate) const RECYCLE_UNKNOWN_DRIVE: &str = "unknownDrive";
pub(crate) const RECYCLE_PATH_TOO_LONG: &str = "pathTooLong";
pub(crate) const RECYCLE_UNSUPPORTED_PATH: &str = "unsupportedPath";
#[cfg(any(not(windows), target_pointer_width = "32"))]
pub(crate) const RECYCLE_UNSUPPORTED_SYSTEM: &str = "unsupportedSystem";
pub(crate) const RECYCLE_SHELL_ERROR: &str = "shellError";
pub(crate) const RECYCLE_ABORTED: &str = "aborted";

#[cfg(windows)]
const DRIVE_NO_ROOT_DIR: u32 = 1;
#[cfg(windows)]
const DRIVE_REMOVABLE: u32 = 2;
#[cfg(windows)]
const DRIVE_FIXED: u32 = 3;
#[cfg(windows)]
const DRIVE_REMOTE: u32 = 4;

/// Only a fixed local drive has a Recycle Bin the shell moves folders into.
/// Removable media, optical drives and RAM disks have none: the shell would
/// ask whether to delete permanently, from a dialog shown while the delete
/// holds the operation lock. Refuse those before any delete instead.
#[cfg(windows)]
fn recycle_drive_verdict(kind: u32) -> Result<(), &'static str> {
    match kind {
        DRIVE_FIXED => Ok(()),
        DRIVE_REMOTE => Err(RECYCLE_NETWORK_SHARE),
        DRIVE_REMOVABLE => Err(RECYCLE_NO_BIN),
        0 | DRIVE_NO_ROOT_DIR => Err(RECYCLE_UNKNOWN_DRIVE),
        _ => Err(RECYCLE_NO_BIN),
    }
}

fn recycle_supported(path: &Path) -> Result<(), String> {
    #[cfg(test)]
    {
        let hook = RECYCLE_SUPPORT_HOOK.with(|slot| slot.borrow_mut().take());
        if let Some(mut hook) = hook {
            let result = hook(path);
            RECYCLE_SUPPORT_HOOK.with(|slot| *slot.borrow_mut() = Some(hook));
            return result;
        }
    }
    #[cfg(all(windows, target_pointer_width = "32"))]
    {
        let _ = path;
        return Err(RECYCLE_UNSUPPORTED_SYSTEM.into());
    }
    #[cfg(all(windows, not(target_pointer_width = "32")))]
    {
        #[link(name = "Kernel32")]
        unsafe extern "system" {
            fn GetDriveTypeW(root: *const u16) -> u32;
        }
        let text = path.to_string_lossy();
        if text.starts_with(r"\\") && !text.starts_with(r"\\?\") {
            return Err(RECYCLE_NETWORK_SHARE.into());
        }
        let root = match path.components().next() {
            Some(std::path::Component::Prefix(prefix)) => match prefix.kind() {
                std::path::Prefix::Disk(letter) => {
                    format!("{}:\\", char::from(letter))
                }
                std::path::Prefix::VerbatimDisk(letter) => {
                    format!("{}:\\", char::from(letter))
                }
                std::path::Prefix::UNC(_, _) | std::path::Prefix::VerbatimUNC(_, _) => {
                    return Err(RECYCLE_NETWORK_SHARE.into())
                }
                _ => return Err(RECYCLE_UNKNOWN_DRIVE.into()),
            },
            _ => return Err(RECYCLE_UNKNOWN_DRIVE.into()),
        };
        #[cfg(test)]
        if let Some(kind) = DRIVE_TYPE_HOOK.with(std::cell::Cell::get) {
            return recycle_drive_verdict(kind).map_err(str::to_owned);
        }
        let mut wide: Vec<u16> = root.encode_utf16().collect();
        wide.push(0);
        let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
        recycle_drive_verdict(kind).map_err(str::to_owned)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(RECYCLE_UNSUPPORTED_SYSTEM.into())
    }
}

/// The path handed to the shell: a plain DOS path, double-NUL terminated.
/// `SHFileOperationW` parses `pFrom` through the shell namespace, which does
/// not understand `\\?\` paths (send2trash and the trash crate strip the
/// prefix for the same reason), and it never takes a path of `MAX_PATH` or
/// more. A path the shell cannot take is refused with a reason code before
/// anything is deleted, so the interface offers the confirmed permanent delete.
#[cfg(windows)]
fn recycle_shell_path(path: &Path) -> Result<Vec<u16>, &'static str> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Component, Prefix};
    const MAX_PATH: usize = 260;
    // Both spellings go through to_process_path, which refuses names the
    // shell's plain-path parsing would read as a different file (trailing dots
    // or spaces, device names, "." and "..") instead of rewriting them.
    let verbatim = match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(_) => {
                let units: Vec<u16> = r"\\?\"
                    .encode_utf16()
                    .chain(path.as_os_str().encode_wide().map(|unit| {
                        if unit == u16::from(b'/') {
                            u16::from(b'\\')
                        } else {
                            unit
                        }
                    }))
                    .collect();
                PathBuf::from(std::ffi::OsString::from_wide(&units))
            }
            Prefix::VerbatimDisk(_) => path.to_path_buf(),
            Prefix::UNC(..) | Prefix::VerbatimUNC(..) => return Err(RECYCLE_NETWORK_SHARE),
            _ => return Err(RECYCLE_UNSUPPORTED_PATH),
        },
        _ => return Err(RECYCLE_UNSUPPORTED_PATH),
    };
    let plain = crate::storage::to_process_path(&verbatim).map_err(|_| RECYCLE_UNSUPPORTED_PATH)?;
    let disk = matches!(
        plain.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
    );
    if !disk
        || !plain.has_root()
        || plain
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(RECYCLE_UNSUPPORTED_PATH);
    }
    let mut wide: Vec<u16> = plain
        .as_os_str()
        .encode_wide()
        .map(|unit| if unit == u16::from(b'/') { u16::from(b'\\') } else { unit })
        .collect();
    while wide.len() > 3 && wide.last() == Some(&u16::from(b'\\')) {
        wide.pop();
    }
    if wide.contains(&0) {
        return Err(RECYCLE_UNSUPPORTED_PATH);
    }
    // MAX_PATH includes the terminating NUL.
    if wide.len() >= MAX_PATH {
        return Err(RECYCLE_PATH_TOO_LONG);
    }
    // SHFileOperation expects a list; keep the double NUL even for one path.
    wide.extend([0, 0]);
    Ok(wide)
}

#[cfg(all(windows, not(target_pointer_width = "32")))]
fn recycle_flags() -> u16 {
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_NOERRORUI: u16 = 0x0400;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_WANTNUKEWARNING: u16 = 0x4000;
    // WANTNUKEWARNING asks before anything is destroyed instead of recycled;
    // NOERRORUI keeps error dialogs from blocking the delete thread.
    FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_ALLOWUNDO | FOF_WANTNUKEWARNING
}

/// Move a directory to the Windows Recycle Bin. Paths that cannot be recycled
/// are refused with a coded reason before any delete; the interface then offers
/// the separately confirmed permanent delete. `owner` is the launcher window
/// that owns any dialog the shell still shows.
fn recycle_path(path: &Path, owner: Option<isize>) -> Result<(), String> {
    #[cfg(test)]
    {
        let hook = RECYCLE_HOOK.with(|slot| slot.borrow_mut().take());
        if let Some(mut hook) = hook {
            let result = hook(path, owner);
            RECYCLE_HOOK.with(|slot| *slot.borrow_mut() = Some(hook));
            return result;
        }
    }
    let unavailable =
        |reason: &str| format!("{}{reason}", crate::errors::INSTANCE_RECYCLE_UNAVAILABLE_PREFIX);
    recycle_supported(path).map_err(|reason| unavailable(&reason))?;
    #[cfg(all(windows, not(target_pointer_width = "32")))]
    {
        #[repr(C)]
        #[allow(non_snake_case)]
        struct ShFileOpStructW {
            hwnd: *mut std::ffi::c_void,
            wFunc: u32,
            pFrom: *const u16,
            pTo: *const u16,
            fFlags: u16,
            fAnyOperationsAborted: i32,
            hNameMappings: *mut std::ffi::c_void,
            lpszProgressTitle: *const u16,
        }
        #[link(name = "Shell32")]
        unsafe extern "system" {
            fn SHFileOperationW(operation: *mut ShFileOpStructW) -> i32;
        }
        const FO_DELETE: u32 = 3;
        let from = recycle_shell_path(path).map_err(unavailable)?;
        let mut operation = ShFileOpStructW {
            hwnd: owner.map_or(std::ptr::null_mut(), |hwnd| hwnd as *mut std::ffi::c_void),
            wFunc: FO_DELETE,
            pFrom: from.as_ptr(),
            pTo: std::ptr::null(),
            fFlags: recycle_flags(),
            fAnyOperationsAborted: 0,
            hNameMappings: std::ptr::null_mut(),
            lpszProgressTitle: std::ptr::null(),
        };
        // The source list is live and double-null terminated for the call.
        let result = unsafe { SHFileOperationW(&mut operation) };
        let failed =
            |reason: String| format!("{}{reason}", crate::errors::INSTANCE_RECYCLE_FAILED_PREFIX);
        if result != 0 {
            return Err(failed(format!("{RECYCLE_SHELL_ERROR}:0x{result:X}")));
        }
        if operation.fAnyOperationsAborted != 0 {
            return Err(failed(RECYCLE_ABORTED.to_owned()));
        }
        Ok(())
    }
    #[cfg(any(not(windows), target_pointer_width = "32"))]
    {
        let _ = owner;
        Err(unavailable(RECYCLE_UNSUPPORTED_SYSTEM))
    }
}

/// Flip one version-folder instance between shared and own game directory.
/// Nothing is moved: turning isolation on starts with empty `saves/` and
/// `mods/`, optionally copying the shared worlds after the user confirmed it.
#[tauri::command]
pub async fn set_instance_isolation(
    state: Shared<'_>,
    instance_id: String,
    isolated: bool,
    copy_worlds: Option<bool>,
) -> AppResult<Instance> {
    let state = state.inner().clone();
    let copy_worlds = copy_worlds.unwrap_or(false);
    tokio::task::spawn_blocking(move || {
        set_instance_isolation_inner(&state, &instance_id, isolated, copy_worlds)
    })
    .await
    .map_err(|error| expected(format!("修改实例隔离任务异常：{error}")))?
    .map_err(expected)
}

pub(crate) fn set_instance_isolation_inner(
    state: &LauncherState,
    instance_id: &str,
    isolated: bool,
    copy_worlds: bool,
) -> Result<Instance, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成后修改实例隔离")?;
    // An unfinished restore or pack update names this game directory; a
    // switch would make its recovery refuse the instance for good.
    crate::instances::require_no_pending_restore(state, instance_id)?;
    let data = state.snapshot()?;
    let current = data
        .instances
        .iter()
        .find(|item| item.id == instance_id)
        .cloned()
        .ok_or_else(|| "实例不存在，请刷新实例列表".to_owned())?;
    if !current.is_version_folder() {
        return Err("只有版本文件夹实例可以切换游戏目录".into());
    }
    let config = data.config.clone();
    let root = crate::processes::configured_game_root(Path::new(&current.game_folder))
        .or_else(|_| crate::processes::configured_game_root(Path::new(&config.game_directory)))?;
    let version_dir = crate::instances::checked_absolute(&safe_join(
        &root,
        &format!("versions/{}", current.version_id),
    )?)?;
    let current_directory = crate::minecraft::game_directory(&config, &current.version_id, Some(&current))?;
    state
        .games
        .require_directory_stopped(&current_directory, Some(instance_id), false)?;
    if copy_worlds && !isolated {
        return Err("只有切换到独立游戏目录时才能复制世界".into());
    }
    if isolated {
        state
            .games
            .require_directory_stopped(&version_dir, Some(instance_id), false)?;
        std::fs::create_dir_all(version_dir.join("saves"))
            .map_err(|error| format!("无法创建实例存档目录：{error}"))?;
        std::fs::create_dir_all(version_dir.join("mods"))
            .map_err(|error| format!("无法创建实例模组目录：{error}"))?;
        if copy_worlds {
            copy_shared_worlds(&root, &version_dir)?;
        }
    }
    let directory = if isolated { version_dir } else { root };
    state.update(|data| {
        let record = data
            .instances
            .iter_mut()
            .find(|item| item.id == instance_id)
            .ok_or_else(|| "实例不存在，请刷新实例列表".to_owned())?;
        record.isolated = isolated;
        record.game_directory = crate::storage::display_profile_path(&directory);
        Ok(record.clone())
    })
}

/// Copy the shared `saves` world folders into a version folder. Each world is
/// copied to a temporary name and renamed only when complete, so a full disk or
/// a cancelled copy never leaves a half world that a retry would skip.
fn copy_shared_worlds(root: &Path, version_dir: &Path) -> Result<(), String> {
    let shared = crate::instances::checked_absolute(&safe_join(root, "saves")?)?;
    if !shared.is_dir() {
        return Ok(());
    }
    let target = crate::instances::checked_absolute(&safe_join(version_dir, "saves")?)?;
    let mut copied = 0;
    for entry in std::fs::read_dir(&shared).map_err(|error| format!("无法读取共享存档：{error}"))? {
        if copied >= 2000 {
            return Err("共享存档数量超过 2000，已停止复制".into());
        }
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let destination = target.join(&name);
        if destination.exists() {
            continue;
        }
        copy_world_atomically(&path, &target, &name)?;
        copied += 1;
    }
    Ok(())
}

/// A crashed isolation world copy can leave a half-written directory. At the
/// next start remove only `.voxelight-world-*` folders inside that version
/// instance's own `saves`, never the shared root's saves or another folder.
pub(crate) fn cleanup_stale_world_copies(state: &LauncherState) {
    let Ok(config) = state.snapshot().map(|data| data.config) else {
        return;
    };
    for folder in config.game_folder_roots() {
        let Ok(root) = crate::processes::configured_game_root(Path::new(&folder)) else {
            continue;
        };
        let Ok(versions) = safe_join(&root, "versions") else {
            continue;
        };
        let Ok(entries) = std::fs::read_dir(&versions) else {
            continue;
        };
        for version in entries.flatten() {
            let Ok(metadata) = std::fs::symlink_metadata(version.path()) else {
                continue;
            };
            if !metadata.is_dir() {
                continue;
            }
            let name = version.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if validate_id(name).is_err() {
                continue;
            }
            let Ok(saves) = safe_join(&version.path(), "saves") else {
                continue;
            };
            let Ok(copies) = std::fs::read_dir(&saves) else {
                continue;
            };
            for entry in copies.flatten() {
                let file_name = entry.file_name().to_string_lossy().into_owned();
                if !file_name.starts_with(".voxelight-world-") {
                    continue;
                }
                if std::fs::symlink_metadata(entry.path())
                    .is_ok_and(|metadata| metadata.is_dir())
                {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }
}

/// Folder in the launcher data directory that keeps version profiles a loader
/// install replaced. A copy never stays beside the live profile in
/// `versions/`, where other launchers list it.
pub(crate) const PROFILE_BACKUP_FOLDER: &str = "profile-backups";

/// Keep a copy of `source`, the profile of version `id`, in the data folder as
/// `profile-backups/<id>-<token>.json`. The replaced profile may be the only
/// copy of another launcher's file, so it is kept, not deleted.
pub(crate) fn keep_profile_backup(
    data_dir: &Path,
    id: &str,
    token: &str,
    source: &Path,
) -> Result<PathBuf, String> {
    validate_id(id)?;
    let folder = crate::instances::checked_absolute(&data_dir.join(PROFILE_BACKUP_FOLDER))?;
    std::fs::create_dir_all(&folder).map_err(|error| format!("无法创建版本配置备份目录：{error}"))?;
    let target = safe_join(&folder, &format!("{id}-{token}.json"))?;
    std::fs::copy(source, &target).map_err(|error| format!("无法备份版本配置：{error}"))?;
    Ok(target)
}

/// Older versions wrote `<name>.json.backup-<uuid>` beside the live profile
/// whenever a loader install replaced it. Such a copy can be the only one left
/// of a PCL/HMCL profile, so the guarded startup sweep moves it into the data
/// folder's profile backups instead of deleting it; no version folder keeps a
/// stray backup.
pub(crate) fn cleanup_stale_profile_backups(state: &LauncherState) {
    let Ok(config) = state.snapshot().map(|data| data.config) else {
        return;
    };
    for folder in config.game_folder_roots() {
        let Ok(root) = crate::processes::configured_game_root(Path::new(&folder)) else {
            continue;
        };
        let Ok(versions) = safe_join(&root, "versions") else {
            continue;
        };
        let Ok(entries) = std::fs::read_dir(&versions) else {
            continue;
        };
        for version in entries.flatten() {
            let Ok(metadata) = std::fs::symlink_metadata(version.path()) else {
                continue;
            };
            if !metadata.is_dir() || validate_id(&version.file_name().to_string_lossy()).is_err() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(version.path()) else {
                continue;
            };
            for file in files.flatten() {
                let name = file.file_name().to_string_lossy().into_owned();
                let Some((profile, token)) = name.split_once(".json.backup-") else {
                    continue;
                };
                if uuid::Uuid::parse_str(token).is_ok()
                    && std::fs::symlink_metadata(file.path())
                        .is_ok_and(|metadata| metadata.is_file())
                    && keep_profile_backup(&state.data_dir, profile, token, &file.path()).is_ok()
                {
                    let _ = std::fs::remove_file(file.path());
                }
            }
        }
    }
}

/// Copy one world into `target` under `name`. The copy is built under a
/// temporary name and renamed only when complete, so a failure never leaves a
/// half world that a later retry would treat as already copied.
fn copy_world_atomically(source: &Path, target: &Path, name: &std::ffi::OsStr) -> Result<(), String> {
    let temporary = target.join(format!(".voxelight-world-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let files = crate::instances::collect_files(source)?;
        crate::instances::copy_snapshot(source, &temporary, &files)?;
        std::fs::rename(&temporary, target.join(name))
            .map_err(|error| format!("无法提交存档 {}：{error}", name.to_string_lossy()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    result
}

#[tauri::command]
pub fn add_offline_account(state: Shared<'_>, username: String) -> Result<Vec<Account>, String> {
    let username = username.trim().to_owned();
    if !valid_username(&username) {
        return Err("玩家名需为 3–16 位英文字母、数字或下划线".into());
    }
    state.update(|data| {
        if data.accounts.iter().any(|a| a.username == username) {
            return Err("此离线账号已存在".into());
        }
        data.accounts.push(Account {
            id: uuid::Uuid::new_v4().to_string(),
            uuid: offline_uuid(&username),
            username,
            account_type: "offline".into(),
            is_selected: data.accounts.is_empty(),
            ..Default::default()
        });
        Ok(data.accounts.clone())
    })
}

#[tauri::command]
pub fn select_account(state: Shared<'_>, account_id: String) -> Result<Vec<Account>, String> {
    state.update(|data| {
        if !data.accounts.iter().any(|a| a.id == account_id) {
            return Err("账号不存在".into());
        }
        for account in &mut data.accounts {
            account.is_selected = account.id == account_id;
        }
        Ok(data.accounts.clone())
    })
}

#[tauri::command]
pub fn remove_account(
    state: Shared<'_>,
    auth: State<'_, Arc<crate::auth::AuthService>>,
    account_id: String,
) -> AppResult<Vec<Account>> {
    remove_account_inner(&state, &auth, account_id).map_err(expected)
}

pub(crate) fn remove_account_inner(
    state: &LauncherState,
    auth: &crate::auth::AuthService,
    account_id: String,
) -> Result<Vec<Account>, String> {
    let snapshot = state.snapshot()?;
    let account = snapshot
        .accounts
        .iter()
        .find(|account| account.id == account_id);
    if account.is_none() && !snapshot.pending_credential_removals.contains(&account_id) {
        return Err("账号不存在".into());
    }
    if account.is_some_and(|account| account.account_type == "offline") {
        return state.update(|data| detach_account(data, &account_id));
    }
    auth.remove_account_transaction(
        &account_id,
        || {
            state.update(|data| {
                let remaining = if data.accounts.iter().any(|account| account.id == account_id) {
                    detach_account(data, &account_id)?
                } else if data.pending_credential_removals.contains(&account_id) {
                    // Explicit retry of a previously committed removal.
                    data.accounts.clone()
                } else {
                    return Err("账号不存在".into());
                };
                data.pending_credential_removals.insert(account_id.clone());
                Ok(remaining)
            })
        },
        || {
            state.update(|data| {
                data.pending_credential_removals.remove(&account_id);
                Ok(())
            })
        },
    )
}

fn detach_account(data: &mut Persisted, account_id: &str) -> Result<Vec<Account>, String> {
    if !data.accounts.iter().any(|a| a.id == account_id) {
        return Err("账号不存在".into());
    }
    data.accounts.retain(|a| a.id != account_id);
    if !data.accounts.iter().any(|a| a.is_selected) {
        if let Some(account) = data.accounts.first_mut() {
            account.is_selected = true;
        }
    }
    Ok(data.accounts.clone())
}

pub(crate) async fn install_version_for_state(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    version_id: String,
) -> Result<InstallResult, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成".to_owned())?;
    let task = state.control.begin_recorded(
        "install",
        &version_id,
        &format!("Minecraft {version_id}"),
        None,
        crate::downloads::RetryRequest::Install { version_id: version_id.clone() },
    )?;
    let result = minecraft::install(state, app, &version_id).await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    match result {
        Ok((result, _)) => Ok(result),
        Err(error) => {
            minecraft::log(app, state, "error", &error);
            Err(error)
        }
    }
}

pub(crate) async fn launch_instance_for_state(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    instance_id: &str,
    server_address: Option<String>,
) -> Result<LaunchResult, String> {
    let snapshot = state.snapshot()?;
    let instance = snapshot
        .instances
        .iter()
        .find(|item| item.id == instance_id)
        .cloned()
        .ok_or_else(|| "实例不存在，请刷新实例列表".to_owned())?;
    let account = snapshot
        .accounts
        .iter()
        .find(|item| item.is_selected)
        .or_else(|| snapshot.accounts.first())
        .cloned()
        .ok_or_else(|| "请先在角色页面添加并选择一个玩家账号".to_owned())?;
    let task_id = state
        .control
        .reserve_launch(&instance.version_id, Some(instance.id.clone()))?;
    match minecraft::launch(
        state.clone(),
        app.clone(),
        task_id.clone(),
        instance.version_id,
        Some(instance.id),
        Some(account.id),
        server_address,
    )
    .await
    {
        Ok(result) => Ok(result),
        Err(error) => {
            state.control.cancel(&task_id);
            minecraft::log(app, state, "error", &error);
            Err(error)
        }
    }
}

/// Restores all launcher preferences, registrations, encrypted secrets, and task history
/// back to factory defaults (including re-enabling the first-run welcome OOBE).
/// Never deletes the Minecraft game directory, worlds, saves, mods, backups, or server files.
pub(crate) async fn reset_launcher_state_inner(
    state: &Arc<LauncherState>,
    auth: &crate::auth::AuthService,
    servers: &crate::server_manager::ServerRegistry,
    mcp: &crate::assistant::McpService,
) -> Result<Config, String> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成后修改配置".to_owned())?;
    let _server_hold = servers
        .try_hold()
        .ok_or_else(|| crate::errors::RESET_SERVER_RUNNING.to_owned())?;
    if !state.games.snapshot()?.is_empty() {
        return Err(crate::errors::RESET_GAME_RUNNING.into());
    }
    if servers.any_running() {
        return Err(crate::errors::RESET_SERVER_RUNNING.into());
    }
    let snapshot = state.snapshot()?;
    let shared_for_clear = state.clone();
    let old_game_dir = snapshot.config.game_directory.clone();
    let cleared = tokio::task::spawn_blocking(move || {
        let game_root = crate::processes::configured_game_root(Path::new(&old_game_dir)).ok();
        let stores = crate::parts::startup_stores(&shared_for_clear.data_dir, game_root.as_deref());
        shared_for_clear.control.clear_all_history(&stores)
    })
    .await
    .map_err(|error| error.to_string())?;
    // `clear_all_history` refuses on paused tasks too. The generic download
    // message is not shown by the reset dialog, so name the actual condition.
    if matches!(&cleared, Err(error) if error == crate::downloads::BUSY) {
        return Err(crate::errors::RESET_DOWNLOADS_ACTIVE.into());
    }
    cleared?;

    mcp.stop();

    // Everything runs under the credential lock that a login commit takes, so
    // the accounts read here are exactly the ones the commit clears.
    //
    // 1. Every secret that is not an account token (the CurseForge and Lumen
    //    keys, proxy credentials of any endpoint, leftovers) is erased before
    //    the commit. A file that cannot be deleted aborts the reset with the
    //    old state intact, so a retry still sees everything it has to erase.
    // 2. The commit clears the accounts and queues every account id in
    //    `pending_credential_removals` in the same durable revision.
    // 3. The tokens are deleted after the commit. One that cannot be deleted,
    //    or a crash at this point, leaves only queued ids, which startup
    //    recovery finishes. Nothing else can be left behind.
    let fresh = Config::default();
    let data_dir = state.data_dir.clone();
    let mut committed = None;
    let result = auth.reset_all_credentials(|| {
        let live = state.snapshot()?;
        let mut account_ids: std::collections::BTreeSet<String> =
            live.accounts.iter().map(|account| account.id.clone()).collect();
        account_ids.extend(live.pending_credential_removals.iter().cloned());
        erase_secrets_except_account_tokens(&data_dir, &account_ids)?;
        let pending = account_ids.clone();
        let saved = state.update(|data| {
            data.config = fresh.clone();
            data.accounts.clear();
            data.instances.clear();
            data.pending_credential_removals = pending;
            data.update_highest_seen = None;
            data.update_highest_seen_beta = None;
            Ok(data.config.clone())
        })?;
        committed = Some(saved.clone());
        Ok((saved, account_ids))
    });
    let Some(saved) = committed else {
        return result;
    };
    state.control.set_limit(saved.download_limit_kib);
    state.control.set_concurrency(saved.download_concurrency);
    // Clears the queued ids once their tokens are gone, and retries a token
    // the transaction could not delete.
    let recovered = auth.recover_credential_removals(state);
    if result.is_err() && recovered.is_err() {
        return Err(format!(
            "{}：无法删除账号凭据",
            crate::errors::RESET_CREDENTIALS_PENDING
        ));
    }
    // Only an empty folder is removed: a login that commits after the lock was
    // released keeps its token.
    let _ = std::fs::remove_dir(data_dir.join("secrets"));
    Ok(saved)
}

/// Erases every file in the secrets folder except the tokens of
/// `account_ids`, which the reset deletes after its commit. Every file is
/// tried; a file that cannot be deleted fails the reset before it commits.
fn erase_secrets_except_account_tokens(
    data_dir: &Path,
    account_ids: &std::collections::BTreeSet<String>,
) -> Result<(), String> {
    let locked = |what: &str| format!("{}：{what}", crate::errors::RESET_SECRETS_LOCKED);
    let tokens: std::collections::HashSet<std::ffi::OsString> = account_ids
        .iter()
        .map(|id| crate::secrets::file_name(&format!("account:{id}")).into())
        .collect();
    let entries = match std::fs::read_dir(data_dir.join("secrets")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(locked("无法读取加密凭据目录")),
    };
    let mut failed = false;
    for entry in entries {
        let Ok(entry) = entry else {
            failed = true;
            continue;
        };
        if tokens.contains(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        let removed = match entry.file_type() {
            Ok(kind) if kind.is_dir() => std::fs::remove_dir_all(&path),
            Ok(kind) if kind.is_symlink() => {
                std::fs::remove_file(&path).or_else(|_| std::fs::remove_dir(&path))
            }
            _ => std::fs::remove_file(&path),
        };
        failed |= removed.is_err_and(|error| error.kind() != std::io::ErrorKind::NotFound);
    }
    if failed {
        return Err(locked("部分加密凭据文件无法删除"));
    }
    Ok(())
}

#[tauri::command]
pub async fn reset_launcher_state(
    state: Shared<'_>,
    auth: State<'_, Arc<crate::auth::AuthService>>,
    servers: State<'_, Arc<crate::server_manager::ServerRegistry>>,
    mcp: State<'_, Arc<crate::assistant::McpService>>,
) -> AppResult<Config> {
    reset_launcher_state_inner(&state, &auth, &servers, &mcp)
        .await
        .map_err(expected)
}

#[tauri::command]
pub async fn install_version(
    app: AppHandle,
    state: Shared<'_>,
    version_id: String,
) -> AppResult<InstallResult> {
    install_version_for_state(&app, &state, version_id)
        .await
        .map_err(expected)
}

#[tauri::command]
pub async fn launch_game(
    app: AppHandle,
    state: Shared<'_>,
    task_id: String,
    version_id: String,
    instance_id: Option<String>,
    account_id: Option<String>,
    server_address: Option<String>,
) -> AppResult<LaunchResult> {
    let state = state.inner().clone();
    match minecraft::launch(
        state.clone(),
        app.clone(),
        task_id,
        version_id,
        instance_id,
        account_id,
        server_address,
    )
    .await
    {
        Ok(result) => Ok(result),
        Err(error) => {
            minecraft::log(&app, &state, "error", &error);
                Err(expected(error))
        }
    }
}

fn registered_folder(
    state: &LauncherState, kind: &str, version_id: Option<&str>, instance_id: Option<&str>,
) -> Result<PathBuf, String> {
    if kind == "logs" {
        return crate::instances::checked_absolute(&safe_join(&state.data_dir, "logs")?);
    }
    let data = state.snapshot()?;
    if kind == "instance" {
        let id = instance_id.ok_or("未指定实例")?;
        validate_id(id)?;
        let value = crate::instances::instance(&data, id)?;
        return minecraft::game_directory(&data.config, &value.version_id, Some(&value));
    }
    let root = crate::processes::configured_game_root(Path::new(&data.config.game_directory))?;
    let directory = match kind {
        "game" => root,
        "instances" => safe_join(&root, "instances")?,
        "version" => {
            let id = version_id.ok_or("未指定版本")?;
            validate_id(id)?;
            safe_join(&root, &format!("versions/{id}"))?
        }
        _ => return Err("不支持的文件夹类型".into()),
    };
    crate::instances::checked_absolute(&directory)
}

#[tauri::command]
pub fn open_folder(
    app: AppHandle,
    state: Shared<'_>,
    kind: String,
    version_id: Option<String>,
    instance_id: Option<String>,
) -> AppResult<()> {
    let folder_error = |detail: String| crate::errors::AppError::new("storage.folderUnavailable").with_detail(detail);
    let directory = registered_folder(&state, &kind, version_id.as_deref(), instance_id.as_deref()).map_err(folder_error)?;
    // Looking up a stale registered instance should not create its directory.
    if kind != "instance" {
        std::fs::create_dir_all(&directory).map_err(|error| folder_error(error.to_string()))?;
    }
    if !directory.is_dir() { return Err(folder_error("实例目录不存在".into())); }
    app.opener().open_path(crate::storage::display_profile_path(&directory), None::<&str>)
        .map_err(|error| folder_error(error.to_string()))
}

#[tauri::command]
pub async fn start_microsoft_login(
    state: Shared<'_>,
    auth: State<'_, Arc<crate::auth::AuthService>>,
) -> Result<crate::auth::DeviceLogin, String> {
    let client_id =
        crate::auth_commands::effective_client_id(&state.snapshot()?.config, builtin_client_id());
    auth.begin_microsoft(&client_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c5_logs_folder_does_not_depend_on_unavailable_game_directory() {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/command-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let not_a_directory = root.path().join("unavailable-game-root");
        std::fs::write(&not_a_directory, b"not a directory").unwrap();
        let state = LauncherState::test_fixture(
            root.path().to_owned(),
            Persisted {
                config: Config {
                    game_directory: not_a_directory.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                ..Default::default()
            },
            crate::storage::test_client(),
        );
        assert!(registered_folder(&state, "game", None, None).is_err());
        assert_eq!(
            registered_folder(&state, "logs", None, None).unwrap(),
            root.path().join("logs")
        );
    }

    #[test]
    fn r4_open_folder_and_launch_use_the_same_registered_external_instance() {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/command-tests")
                .join(uuid::Uuid::new_v4().to_string())
        ).unwrap();
        let configured = root.path().join("current-root");
        let external = root.path().join("previous-root/instance");
        std::fs::create_dir_all(&configured).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        let config = Config { game_directory: configured.display().to_string(), ..Default::default() };
        let instance = Instance {
            id: "old-instance".into(), version_id: "1.20.1".into(),
            game_directory: external.display().to_string(), ..Default::default()
        };
        let state = LauncherState::test_fixture(
            root.path().to_owned(),
            Persisted { config: config.clone(), instances: vec![instance.clone()], ..Default::default() },
            crate::storage::test_client()
        );
        let launch = minecraft::game_directory(&config, &instance.version_id, Some(&instance)).unwrap();
        assert_eq!(registered_folder(&state, "instance", None, Some(&instance.id)).unwrap(), launch);
        assert!(registered_folder(&state, "instance", None, Some("unknown")).is_err());
    }

    #[test]
    fn bootstrap_capabilities_expose_only_builtin_presence() {
        let builtin = bootstrap_capabilities(Some("11111111-1111-1111-1111-111111111111"));
        assert_eq!(builtin["microsoftBuiltinClientId"], true);
        assert!(!serde_json::to_string(&builtin)
            .unwrap()
            .contains("11111111-1111-1111-1111-111111111111"));
        let public = bootstrap_capabilities(None);
        assert_eq!(public["microsoftBuiltinClientId"], false);
        assert!(public["notes"][0].as_str().unwrap().contains("需先配置"));
    }

    #[test]
    fn configuration_and_instance_removal_reject_busy_launch_preparation() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/command-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&directory).unwrap();
        let state = LauncherState::test_fixture(
            directory.join("data"),
            Persisted {
                instances: vec![Instance {
                    id: "instance".into(),
                    ..Default::default()
                }],
                ..Default::default()
            },
            crate::storage::test_client(),
        );
        let guard = state.operation.try_lock().unwrap();
        let mut config = state.snapshot().unwrap().config;
        config.game_directory = directory.join("new-game").to_string_lossy().into_owned();
        assert!(save_config_inner(&state, config.clone())
            .unwrap_err()
            .contains("等待"));
        assert!(remove_instance_inner(&state, "instance").is_err());
        assert_ne!(
            state.snapshot().unwrap().config.game_directory,
            config.game_directory
        );
        assert_eq!(state.snapshot().unwrap().instances.len(), 1);
        drop(guard);
        save_config_inner(&state, config.clone()).unwrap();
        assert_eq!(
            state.snapshot().unwrap().config.game_directory,
            config.game_directory
        );
        assert!(remove_instance_inner(&state, "instance")
            .unwrap()
            .is_empty());
        drop(state);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn visual_preferences_are_validated() {
        let mut config = Config::default();
        config.effects = "automatic".into();
        assert!(validate_visual_preferences(&config).is_err());
        config.effects = "full".into();
        config.accent_source = "invalid".into();
        assert!(validate_visual_preferences(&config).is_err());
        config.accent_source = "voxelight".into();
        config.language = "fr-FR".into();
        assert!(validate_visual_preferences(&config).is_err());
        config.language = "en-US".into();
        assert!(validate_visual_preferences(&config).is_ok());
    }

    #[test]
    fn create_instance_inner_validates_name_and_records_loader() {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/command-tests");
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        for (id, metadata) in [
            (
                "fabric-test",
                json!({"inheritsFrom":"1.21.1","launcherMetadata":{"loader":"fabric","loaderVersion":"0.16.9"}}),
            ),
            ("1.21.1", json!({"id":"1.21.1"})),
        ] {
            let directory = root.join("versions").join(id);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join(format!("{id}.json")), metadata.to_string()).unwrap();
        }
        let state = LauncherState::test_fixture(
            root.clone(),
            Persisted {
                config: Config {
                    game_directory: root.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                ..Default::default()
            },
            crate::storage::test_client(),
        );
        for name in [
            String::new(),
            " ".into(),
            "x".repeat(81),
            "bad\u{0}name".into(),
        ] {
            assert!(create_instance_inner(&state, name, "fabric-test".into()).is_err());
        }
        assert!(state.snapshot().unwrap().instances.is_empty());
        let instance =
            create_instance_inner(&state, "  Fabric API  ".into(), "fabric-test".into()).unwrap();
        assert_eq!(instance.name, "Fabric API");
        assert_eq!(instance.category, "normal");
        assert_eq!(instance.loader, "fabric");
        assert_eq!(instance.loader_version, "0.16.9");
        assert_eq!(instance.version_id, "Fabric API");
        assert_eq!(instance.kind, "version");
        assert!(root.join("versions/Fabric API/Fabric API.json").is_file());
        let profile: Value = serde_json::from_slice(
            &std::fs::read(root.join("versions/Fabric API/Fabric API.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(profile["id"], "Fabric API");
        assert_eq!(profile["inheritsFrom"], "1.21.1");
        assert_eq!(state.snapshot().unwrap().instances.len(), 1);
        assert!(root.starts_with(parent));
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_instances_record_the_actual_loader_and_version() {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/command-tests");
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        for (id, metadata) in [
            (
                "fabric-test",
                json!({"inheritsFrom":"1.20.1","libraries":[{"name":"net.fabricmc:fabric-loader:0.20.1"}],"launcherMetadata":{"loader":"fabric","loaderVersion":"0.20.1"}}),
            ),
            (
                "1.20.1",
                json!({"mainClass":"net.minecraft.client.main.Main"}),
            ),
        ] {
            let directory = root.join("versions").join(id);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join(format!("{id}.json")), metadata.to_string()).unwrap();
        }
        let config = Config {
            game_directory: root.to_string_lossy().into_owned(),
            ..Config::default()
        };
        assert_eq!(
            installed_loader(&config, "fabric-test"),
            ("fabric".into(), "0.20.1".into())
        );
        assert_eq!(
            installed_loader(&config, "not-installed"),
            ("vanilla".into(), String::new())
        );
        assert!(
            root.starts_with(&parent) && root.file_name().unwrap().to_string_lossy().len() == 36
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn default_skin_validation_accepts_only_steve_and_alex() {
        for skin in ["steve", "alex"] {
            assert!(validate_default_skin(skin).is_ok(), "{skin}");
        }
        for skin in ["lumen", "", "Lumen", "mhf", " steve", "unknown"] {
            let error = validate_default_skin(skin).unwrap_err();
            assert!(!error.contains("lumen") && error.contains("steve") && error.contains("alex"));
        }
    }

    fn reset_fixture() -> (crate::instances::StagingDirectory, LauncherState) {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/command-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let game = root.path().join("game");
        std::fs::create_dir_all(game.join("mods")).unwrap();
        std::fs::write(game.join("mods/sodium.jar"), b"keep").unwrap();
        let state = LauncherState::test_fixture(
            root.path().join("profile"),
            Persisted {
                config: Config {
                    game_directory: game.display().to_string(),
                    ..Default::default()
                },
                ..Default::default()
            },
            crate::storage::test_client(),
        );
        (root, state)
    }

    /// A launcher for reset tests whose game directory is inside the fixture.
    /// Fields drop in order, so `root` is last: the state still holds the
    /// profile lock, and the directory cannot be removed until it is gone.
    struct ResetFixture {
        state: Arc<LauncherState>,
        auth: crate::auth::AuthService,
        servers: crate::server_manager::ServerRegistry,
        mcp: crate::assistant::McpService,
        root: crate::instances::StagingDirectory,
    }

    impl ResetFixture {
        fn new() -> Self {
            let (root, state) = reset_fixture();
            let auth = crate::auth::AuthService::new(
                state.data_dir.clone(),
                &state.snapshot().unwrap().config,
            );
            Self {
                state: Arc::new(state),
                auth,
                servers: Default::default(),
                mcp: Default::default(),
                root,
            }
        }

        /// Runs a reset only while the configured game directory is inside the
        /// fixture, because a reset clears that directory's part folder. A
        /// reset that commits `Config::default()` points the config at the
        /// real default game directory, so the config is sent back to the
        /// fixture before anything else in the test can use it.
        async fn reset(&self) -> Result<Config, String> {
            let game = self.state.snapshot().unwrap().config.game_directory;
            assert!(
                Path::new(&game).starts_with(self.root.path()),
                "a reset test must not reach a game directory outside its fixture: {game}"
            );
            let result =
                reset_launcher_state_inner(&self.state, &self.auth, &self.servers, &self.mcp)
                    .await;
            let after = self.state.snapshot().unwrap().config.game_directory;
            if !Path::new(&after).starts_with(self.root.path()) {
                self.state
                    .update(|data| {
                        data.config.game_directory = game.clone();
                        Ok(())
                    })
                    .unwrap();
            }
            result
        }

        fn secret_path(&self, key: &str) -> std::path::PathBuf {
            self.state
                .data_dir
                .join("secrets")
                .join(crate::secrets::file_name(key))
        }

        fn persisted(&self) -> Persisted {
            serde_json::from_slice(&std::fs::read(self.state.data_dir.join("state.json")).unwrap())
                .unwrap()
        }
    }

    fn config_json(config: &Config) -> serde_json::Value {
        serde_json::to_value(config).unwrap()
    }

    #[test]
    fn reset_tests_never_run_against_a_game_directory_outside_the_fixture() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let fixture = ResetFixture::new();
        let outside = std::env::temp_dir().join("voxelight-reset-guard-never-created");
        fixture
            .state
            .update(|data| {
                data.config.game_directory = outside.display().to_string();
                Ok(())
            })
            .unwrap();
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            rt.block_on(fixture.reset())
        }));
        assert!(refused.is_err(), "the guard refuses before the reset runs");
        assert_eq!(
            fixture.state.snapshot().unwrap().config.game_directory,
            outside.display().to_string(),
            "the refused reset changed nothing"
        );
        assert!(!outside.exists());
    }

    #[test]
    fn reset_fixture_removes_its_directory_when_a_test_ends() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let fixture = ResetFixture::new();
        let directory = fixture.root.path().to_path_buf();
        assert!(fixture.state.data_dir.join("launcher-profile.lock").is_file());
        rt.block_on(fixture.reset()).unwrap();
        drop(fixture);
        assert!(!directory.exists(), "{} is left behind", directory.display());
    }

    #[test]
    fn reset_points_a_committed_default_config_back_at_the_fixture() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let fixture = ResetFixture::new();
            let before = fixture.state.snapshot().unwrap().config.game_directory;
            let saved = fixture.reset().await.unwrap();
            assert_eq!(saved.game_directory, Config::default().game_directory);
            assert_eq!(fixture.state.snapshot().unwrap().config.game_directory, before);
            // A second reset is therefore still confined to the fixture.
            fixture.reset().await.unwrap();
        });
    }

    #[test]
    fn reset_refuses_a_running_game_and_changes_nothing() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let fixture = ResetFixture::new();
            let state = &fixture.state;
            let game = Path::new(&state.snapshot().unwrap().config.game_directory).to_path_buf();
            state.games.fixture_running_directory(&game, None);
            let before = state.snapshot().unwrap();
            let error = fixture.reset().await.unwrap_err();
            assert_eq!(crate::errors::expected(error).code, "reset.gameRunning");
            let after = state.snapshot().unwrap();
            assert_eq!(
                config_json(&before.config),
                config_json(&after.config),
                "a refused reset must not change the config"
            );
            assert_eq!(after.accounts.len(), before.accounts.len());
            assert!(std::fs::read(
                Path::new(&after.config.game_directory).join("mods/sodium.jar")
            )
            .is_ok());
        });
    }

    #[test]
    fn reset_refuses_while_an_install_or_launch_holds_the_operation_lock() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let fixture = ResetFixture::new();
            let state = &fixture.state;
            let before = state.snapshot().unwrap();
            let operation = state.operation.try_lock().unwrap();
            let error = fixture.reset().await.unwrap_err();
            assert_eq!(crate::errors::expected(error).code, "config.busy");
            let after = state.snapshot().unwrap();
            assert_eq!(
                config_json(&before.config),
                config_json(&after.config),
                "a refused reset must not change the config"
            );
            assert_eq!(after.instances.len(), before.instances.len());
            drop(operation);
        });
    }

    #[test]
    fn reset_refuses_running_queued_and_paused_downloads_by_name() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        for status in ["running", "queued", "paused"] {
            rt.block_on(async {
                let fixture = ResetFixture::new();
                let state = &fixture.state;
                let id = if status == "queued" {
                    state
                        .control
                        .enqueue("install", "1.20.1", "Minecraft 1.20.1")
                        .unwrap()
                } else {
                    let id = state
                        .control
                        .begin("install", "1.20.1", "Minecraft 1.20.1")
                        .unwrap();
                    if status == "paused" {
                        state.control.set_paused(&id, true);
                    }
                    id
                };
                assert_eq!(
                    state
                        .control
                        .list()
                        .iter()
                        .find(|job| job.id == id)
                        .map(|job| job.status.as_str()),
                    Some(status)
                );
                let before = state.snapshot().unwrap();
                let error = fixture.reset().await.unwrap_err();
                assert_eq!(
                    crate::errors::expected(error).code,
                    "reset.downloadsActive",
                    "{status}"
                );
                let after = state.snapshot().unwrap();
                assert_eq!(
                    config_json(&before.config),
                    config_json(&after.config),
                    "a refused reset must not change the config ({status})"
                );
                assert_eq!(state.control.list().len(), 1, "the task history stays ({status})");
            });
        }
    }

    #[test]
    fn clear_all_history_refuses_running_queued_and_paused_jobs() {
        for status in ["running", "queued", "paused"] {
            let (_root, state) = reset_fixture();
            let id = if status == "queued" {
                state
                    .control
                    .enqueue("install", "1.20.1", "Minecraft 1.20.1")
                    .unwrap()
            } else {
                let id = state
                    .control
                    .begin("install", "1.20.1", "Minecraft 1.20.1")
                    .unwrap();
                if status == "paused" {
                    state.control.set_paused(&id, true);
                }
                id
            };
            let error = state.control.clear_all_history(&[]).unwrap_err();
            assert_eq!(crate::errors::expected(error).code, "download.busy", "{status}");
            assert_eq!(state.control.list().len(), 1, "nothing is cleared ({status})");
            assert_eq!(
                state
                    .control
                    .list()
                    .iter()
                    .find(|job| job.id == id)
                    .map(|job| job.status.as_str()),
                Some(status)
            );
        }
    }

    fn fixture_part_key() -> crate::parts::PartKey {
        crate::parts::PartKey::new(crate::parts::Algo::Sha1, &format!("{:040x}", 7), 11).unwrap()
    }

    fn write_part_triple(folder: &Path) -> crate::parts::PartKey {
        let key = fixture_part_key();
        std::fs::write(key.file(folder, "part"), vec![0x5a; 11]).unwrap();
        std::fs::write(key.file(folder, "json"), b"{}").unwrap();
        std::fs::write(key.file(folder, "lock"), b"").unwrap();
        key
    }

    #[test]
    fn clear_all_history_removes_only_exact_part_names_and_keeps_game_files() {
        let (root, state) = reset_fixture();
        let parts = state.data_dir.join(".launcher-temp").join("parts");
        std::fs::create_dir_all(&parts).unwrap();
        let stem = format!("sha1-{:040x}-11", 7);
        let key = write_part_triple(&parts);
        std::fs::write(parts.join("notes.part"), b"keep").unwrap();
        std::fs::write(parts.join(format!("{stem}.txt")), b"keep").unwrap();
        let store = crate::parts::PartStore::new(parts.clone());
        let cleared = state.control.clear_all_history(std::slice::from_ref(&store)).unwrap();
        assert_eq!(cleared.bytes, 11);
        for extension in ["part", "json", "lock"] {
            assert!(!key.file(&parts, extension).exists(), "{extension} removed");
        }
        assert!(parts.join("notes.part").is_file(), "a foreign .part name stays");
        assert!(
            parts.join(format!("{stem}.txt")).is_file(),
            "only the exact part extensions are touched"
        );
        assert!(
            root.path().join("game/mods/sodium.jar").is_file(),
            "game files are never touched"
        );
    }

    #[cfg(windows)]
    #[test]
    fn clear_all_history_does_not_follow_a_junctioned_parts_folder() {
        let (root, state) = reset_fixture();
        let outside = root.path().join("outside-parts");
        std::fs::create_dir_all(&outside).unwrap();
        // A complete, unlocked part: only the link check keeps it, since the
        // sweep would delete exactly this group in an ordinary folder.
        let key = write_part_triple(&outside);
        std::fs::create_dir_all(state.data_dir.join(".launcher-temp")).unwrap();
        let link = state.data_dir.join(".launcher-temp").join("parts");
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', r"\"))
            .arg(outside.to_string_lossy().replace('/', r"\"))
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(key.file(&link, "part").is_file(), "the junction reaches the part");
        let stores = crate::parts::startup_stores(
            &state.data_dir,
            crate::processes::configured_game_root(Path::new(
                &state.snapshot().unwrap().config.game_directory,
            ))
            .ok()
            .as_deref(),
        );
        let cleared = state.control.clear_all_history(&stores).unwrap();
        let _ = std::fs::remove_dir(&link);
        assert_eq!(cleared.bytes, 0);
        for extension in ["part", "json", "lock"] {
            assert!(
                key.file(&outside, extension).is_file(),
                "the {extension} file behind the junction stays"
            );
        }
        assert_eq!(std::fs::read(key.file(&outside, "part")).unwrap(), vec![0x5a; 11]);
        assert!(root.path().join("game/mods/sodium.jar").is_file());
    }

    const PROXY_KEY: &str = "download-proxy-credentials:http://proxy.example.invalid:8080";
    const OLD_PROXY_KEY: &str = "download-proxy-credentials:http://old.example.invalid:3128";

    /// Saves every kind of secret a launcher keeps: a custom proxy endpoint
    /// with credentials, an orphaned record of an earlier endpoint, the
    /// CurseForge and Lumen keys, a leftover temporary file and a signed-in
    /// account. Returns the account's session generation.
    fn save_every_secret(fixture: &ResetFixture) -> crate::auth::AccountGeneration {
        let state = &fixture.state;
        state
            .update(|data| {
                data.config.proxy_mode = "custom".into();
                data.config.proxy_scheme = "http".into();
                data.config.proxy_host = "proxy.example.invalid".into();
                data.config.proxy_port = 8080;
                Ok(())
            })
            .unwrap();
        for (key, value) in [
            (PROXY_KEY, "{\"username\":\"u\",\"password\":\"p\"}"),
            (OLD_PROXY_KEY, "{\"username\":\"old\",\"password\":\"old\"}"),
            (crate::curseforge_key::CURSEFORGE_SECRET_KEY, "cf-fixture-key"),
            (crate::assistant::ASSISTANT_SECRET_KEY, "sk-fixture-key"),
        ] {
            crate::secrets::save_service_secret(&state.data_dir, key, value).unwrap();
        }
        std::fs::write(
            state.data_dir.join("secrets").join(format!("{}.tmp", uuid::Uuid::new_v4())),
            b"partial",
        )
        .unwrap();
        fixture.auth.sign_in_fixture(state, "microsoft-reset-a").unwrap()
    }

    fn service_secret_keys() -> [String; 4] {
        [
            format!("service:{PROXY_KEY}"),
            format!("service:{OLD_PROXY_KEY}"),
            format!("service:{}", crate::curseforge_key::CURSEFORGE_SECRET_KEY),
            format!("service:{}", crate::assistant::ASSISTANT_SECRET_KEY),
        ]
    }

    #[cfg(windows)]
    #[test]
    fn reset_erases_every_saved_secret_and_ends_old_sessions() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let fixture = ResetFixture::new();
            let generation = save_every_secret(&fixture);
            let second = fixture
                .auth
                .sign_in_fixture(&fixture.state, "microsoft-reset-b")
                .unwrap();
            let saved = fixture.reset().await.unwrap();
            assert_eq!(saved.proxy_mode, "system");
            let store = crate::secrets::SecretStore::new(fixture.state.data_dir.clone());
            for key in service_secret_keys() {
                assert_eq!(store.get(&key).unwrap(), None, "{key} is erased");
            }
            for id in ["microsoft-reset-a", "microsoft-reset-b"] {
                assert_eq!(store.get(&format!("account:{id}")).unwrap(), None, "{id} token");
            }
            assert!(
                !fixture.state.data_dir.join("secrets").exists(),
                "no secret file of any kind is left"
            );
            let after = fixture.state.snapshot().unwrap();
            assert!(after.accounts.is_empty());
            assert!(
                after.pending_credential_removals.is_empty(),
                "the cleanup markers are cleared once the tokens are gone"
            );
            assert!(fixture.persisted().pending_credential_removals.is_empty());
            for (id, generation) in [("microsoft-reset-a", &generation), ("microsoft-reset-b", &second)] {
                assert_eq!(
                    fixture
                        .auth
                        .update_current_account(id, generation, || Ok(()))
                        .unwrap_err(),
                    crate::errors::ACCOUNT_SESSION_CHANGED,
                    "work started before the reset cannot write {id}'s token back"
                );
            }
        });
    }

    #[cfg(windows)]
    fn lock_file(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn reset_stops_before_its_commit_when_a_saved_key_cannot_be_erased() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let fixture = ResetFixture::new();
            let generation = save_every_secret(&fixture);
            let before = fixture.state.snapshot().unwrap();
            let curseforge = fixture.secret_path(&format!(
                "service:{}",
                crate::curseforge_key::CURSEFORGE_SECRET_KEY
            ));
            let locked = lock_file(&curseforge);
            let error = fixture.reset().await.unwrap_err();
            assert_eq!(
                crate::errors::expected(error).code,
                "reset.secretsLocked",
                "a key that survives must not be reported as erased"
            );
            let after = fixture.state.snapshot().unwrap();
            assert_eq!(
                config_json(&before.config),
                config_json(&after.config),
                "nothing is committed, so a retry still knows the old proxy endpoint"
            );
            assert_eq!(after.accounts.len(), 1, "the account stays listed");
            assert!(fixture.persisted().pending_credential_removals.is_empty());
            fixture
                .auth
                .update_current_account("microsoft-reset-a", &generation, || Ok(()))
                .expect("the account's session is untouched");
            assert!(
                fixture.secret_path("account:microsoft-reset-a").is_file(),
                "account tokens are only deleted after the commit"
            );
            assert!(curseforge.is_file(), "the locked key is still there");
            // Secret files are visited in name order, so check keys on both
            // sides of the locked one: erasing must not stop at the first failure.
            for key in service_secret_keys() {
                if fixture.secret_path(&key) != curseforge {
                    assert!(!fixture.secret_path(&key).exists(), "every other key was still tried: {key}");
                }
            }
            drop(locked);
            fixture.reset().await.unwrap();
            assert!(!fixture.state.data_dir.join("secrets").exists(), "a retry finishes");
        });
    }

    #[cfg(windows)]
    #[test]
    fn a_token_left_by_a_failed_reset_is_finished_by_startup_recovery() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let fixture = ResetFixture::new();
            let generation = save_every_secret(&fixture);
            let token = fixture.secret_path("account:microsoft-reset-a");
            let locked = lock_file(&token);
            let error = fixture.reset().await.unwrap_err();
            assert_eq!(crate::errors::expected(error).code, "reset.credentialsPending");
            let after = fixture.state.snapshot().unwrap();
            assert_eq!(after.config.proxy_mode, "system", "the reset itself committed");
            assert!(after.accounts.is_empty());
            let persisted = fixture.persisted();
            assert!(
                persisted.pending_credential_removals.contains("microsoft-reset-a"),
                "the token's id survives a crash in the durable revision"
            );
            assert!(persisted.accounts.is_empty());
            for key in service_secret_keys() {
                assert!(!fixture.secret_path(&key).exists(), "{key} went before the commit");
            }
            assert!(
                fixture
                    .auth
                    .update_current_account("microsoft-reset-a", &generation, || Ok(()))
                    .is_err(),
                "the old session cannot use the token that is still on disk"
            );
            assert!(token.is_file());
            drop(locked);

            let restarted = crate::auth::AuthService::new(
                fixture.state.data_dir.clone(),
                &fixture.state.snapshot().unwrap().config,
            );
            restarted.recover_credential_removals(&fixture.state).unwrap();
            assert!(!token.exists(), "startup recovery deletes the leftover token");
            assert!(fixture.state.snapshot().unwrap().pending_credential_removals.is_empty());
            assert!(fixture.persisted().pending_credential_removals.is_empty());
        });
    }
}

#[cfg(test)]
mod scoped_settings_save_tests {
    use super::*;
    use std::fs;

    #[test]
    fn u1_the_tour_flag_is_saved_on_its_own_even_during_an_install_and_a_config_save_keeps_it() {
        let (_root, state) = owned_profile();
        state.save().unwrap();
        let held = state.operation.try_lock().unwrap();
        assert!(set_tour_completed_inner(&state, true).unwrap().tour_completed, "not refused while an install runs");
        drop(held);
        // A Settings page loaded before the tour ended still says false.
        let mut stale = state.snapshot().unwrap().config;
        stale.tour_completed = false;
        assert!(save_config_inner(&state, stale).unwrap().tour_completed);
        assert!(state.snapshot().unwrap().config.tour_completed);
        assert!(!set_tour_completed_inner(&state, false).unwrap().tour_completed, "the flag can be cleared on purpose");
    }

    #[test]
    fn changing_the_game_folder_list_to_a_nested_or_data_folder_is_refused() {
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/command-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let data = holder.path().join("data");
        let game = holder.path().join("game");
        std::fs::create_dir_all(game.join("versions")).unwrap();
        let mut config = Config {
            game_directory: game.to_string_lossy().into_owned(),
            ..Config::default()
        };
        config.normalize_game_folders();
        let state = LauncherState::test_fixture(
            data.clone(),
            Persisted { config: config.clone(), ..Default::default() },
            crate::storage::test_client(),
        );
        for (candidate, code) in [
            (data.join("game"), "gameFolder.dataDirectory"),
            (game.join("nested"), "gameFolder.nested"),
        ] {
            let mut next = config.clone();
            next.game_folders.push(crate::models::GameFolder {
                path: candidate.to_string_lossy().into_owned(),
                label: String::new(),
                active: false,
            });
            next.game_directory = candidate.to_string_lossy().into_owned();
            let error = crate::errors::expected(save_config_inner(&state, next).unwrap_err());
            assert_eq!(error.code, code, "{}", candidate.display());
        }
        assert_eq!(
            state.snapshot().unwrap().config.game_directory,
            game.to_string_lossy().as_ref(),
            "nothing invalid was saved"
        );
    }

    #[test]
    fn config_save_rejects_java_inheritance_from_a_tls_proxy() {
        let (root, state) = owned_profile();
        state.save().unwrap();
        let state_file = root.path().join("state.json");
        let before = fs::read(&state_file).unwrap();
        let mut candidate = serde_json::to_value(state.snapshot().unwrap().config).unwrap();
        for (field, value) in [
            ("proxyMode", serde_json::json!("custom")),
            ("proxyScheme", serde_json::json!("https")),
            ("proxyHost", serde_json::json!("proxy.example.invalid")),
            ("proxyPort", serde_json::json!(8443)),
            ("gameProxyMode", serde_json::json!("launcher")),
        ] {
            candidate[field] = value;
        }
        let rejected = save_config_inner(&state, serde_json::from_value(candidate.clone()).unwrap()).unwrap_err();
        assert_eq!(crate::errors::expected(rejected).code, "proxy.tlsInheritance");
        assert_eq!(fs::read(&state_file).unwrap(), before);
        candidate["gameProxyMode"] = serde_json::json!("off");
        let saved = save_config_inner(&state, serde_json::from_value(candidate).unwrap()).unwrap();
        let saved = serde_json::to_value(saved).unwrap();
        assert_eq!(saved["proxyScheme"], "https");
        assert_eq!(saved["gameProxyMode"], "off");
        let saved_bytes = fs::read(&state_file).unwrap();
        let mut inactive = saved;
        inactive["proxyMode"] = serde_json::json!("none");
        inactive["proxyHost"] = serde_json::json!("fixture-user:fixture-password@proxy.example.invalid");
        let rejected = save_config_inner(&state, serde_json::from_value(inactive).unwrap()).unwrap_err();
        assert_eq!(crate::errors::expected(rejected).code, "proxy.invalidHost");
        assert_eq!(fs::read(&state_file).unwrap(), saved_bytes);
    }

    fn owned_profile() -> (crate::instances::StagingDirectory, LauncherState) {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/command-tests")
                .join(format!("settings-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let config = Config {
            game_directory: root
                .path()
                .join("isolated-game")
                .to_string_lossy()
                .into_owned(),
            download_limit_kib: 128,
            max_memory_mb: 16384,
            ..Config::default()
        };
        let state = LauncherState::test_fixture(
            root.path().to_path_buf(),
            Persisted {
                config,
                ..Persisted::default()
            },
            crate::storage::test_client(),
        );
        state.control.set_limit(128);
        (root, state)
    }

    #[test]
    fn appearance_patch_saves_while_launch_is_preparing_and_keeps_runtime_fields() {
        let (root, state) = owned_profile();
        let lock = state.operation.try_lock().unwrap();
        let patch = serde_json::from_value(json!({
            "theme": "dark", "language": "en-US", "defaultSkin": "alex"
        }))
        .unwrap();
        let saved = save_appearance_config_inner(&state, patch).unwrap();
        assert_eq!(
            (
                saved.theme.as_str(),
                saved.language.as_str(),
                saved.default_skin.as_str()
            ),
            ("dark", "en-US", "alex")
        );
        assert_eq!(
            (
                saved.max_memory_mb,
                saved.download_limit_kib,
                state.control.limit_for_test()
            ),
            (16384, 128, 128)
        );
        let persisted: Persisted =
            serde_json::from_slice(&fs::read(root.path().join("state.json")).unwrap()).unwrap();
        assert_eq!(persisted.config.language, "en-US");
        assert_eq!(persisted.config.max_memory_mb, 16384);
        let mut next = saved;
        next.max_memory_mb = 4096;
        assert!(save_config_inner(&state, next).is_err());
        drop(lock);
    }

    #[test]
    fn appearance_patch_does_not_revalidate_or_overwrite_unrelated_legacy_fields() {
        let (_root, state) = owned_profile();
        state
            .update(|data| {
                data.config.world_scene = "legacy-setting".into();
                data.config.accent_color = "legacy-color".into();
                Ok(())
            })
            .unwrap();
        let patch = serde_json::from_value(json!({"language":"en-US"})).unwrap();
        let saved = save_appearance_config_inner(&state, patch).unwrap();
        assert_eq!(saved.world_scene, "legacy-setting");
        assert_eq!(saved.accent_color, "legacy-color");
        assert_eq!(saved.language, "en-US");
    }

    fn custom_proxy(config: &mut Config, scheme: &str, host: &str) {
        config.proxy_mode = "custom".into();
        config.proxy_scheme = scheme.into();
        config.proxy_host = host.into();
        config.proxy_port = 8080;
    }

    #[test]
    fn c7_switching_to_https_is_refused_while_an_instance_inherits_the_proxy() {
        let (_root, state) = owned_profile();
        state.update(|data| {
            custom_proxy(&mut data.config, "http", "proxy.example.invalid");
            data.instances.push(crate::models::Instance {
                id: "inherits".into(), name: "Inheriting pack".into(),
                game_proxy_mode: Some("launcher".into()), ..Default::default()
            });
            Ok(())
        }).unwrap();
        let current = state.snapshot().unwrap().config;
        let mut tls = current.clone();
        custom_proxy(&mut tls, "https", "proxy.example.invalid");
        let before = serde_json::to_value(&state.snapshot().unwrap().config).unwrap();
        assert_eq!(save_approved_config(&state, tls.clone(), Some(&current)).unwrap_err(), "proxy.tlsInheritance");
        assert_eq!(serde_json::to_value(&state.snapshot().unwrap().config).unwrap(), before);
        let named = reject_inherited_tls(&tls, &state.snapshot().unwrap().instances).unwrap_err();
        assert_eq!(named.code, "proxy.tlsInheritanceInstances");
        assert_eq!(named.params["instances"], "Inheriting pack");
        // Without inheriting instances the https:// proxy saves for the launcher itself.
        state.update(|data| { data.instances.clear(); Ok(()) }).unwrap();
        assert_eq!(save_approved_config(&state, tls, Some(&current)).unwrap().proxy_scheme, "https");
    }

    #[test]
    fn c7_abandoning_a_proxy_address_deletes_its_credentials() {
        let (_root, state) = owned_profile();
        let key = |host: &str| format!("download-proxy-credentials:http://{host}:8080");
        let stored = |host: &str| crate::secrets::load_service_secret(&state.data_dir, &key(host)).unwrap().is_some();
        let mut a = state.snapshot().unwrap().config;
        custom_proxy(&mut a, "http", "a.example.invalid");
        let saved = save_approved_config(&state, a.clone(), None).unwrap();
        crate::secrets::save_service_secret(&state.data_dir, &key("a.example.invalid"), "{\"username\":\"u\",\"password\":\"p\"}").unwrap();
        // Off keeps the address as a draft, so the credentials stay.
        let mut off = saved.clone();
        off.proxy_mode = "none".into();
        let saved = save_approved_config(&state, off, Some(&saved)).unwrap();
        assert!(stored("a.example.invalid"));
        let mut b = saved.clone();
        custom_proxy(&mut b, "http", "b.example.invalid");
        save_approved_config(&state, b, Some(&saved)).unwrap();
        assert!(!stored("a.example.invalid"), "A's credentials must not survive the switch to B");
    }

    #[test]
    fn c5_u0880_config_saves_reject_new_heap_flags_and_bad_minimums_without_writing() {
        let (_root, state) = owned_profile();
        state.update(|data| {
            data.config.jvm_arguments = "-Xmx2G".into();
            data.config.memory_mode = "manual".into();
            Ok(())
        }).unwrap();
        let legacy = state.snapshot().unwrap().config;
        // A legacy heap flag never blocks an unrelated save.
        let mut unrelated = legacy.clone();
        unrelated.download_limit_kib = 256;
        assert_eq!(save_approved_config(&state, unrelated, Some(&legacy)).unwrap().download_limit_kib, 256);
        let current = state.snapshot().unwrap().config;
        let rejected = |candidate: Config, approved: &Config| {
            let before = state.snapshot().unwrap().config;
            let error = save_approved_config(&state, candidate, Some(approved)).unwrap_err();
            let after = state.snapshot().unwrap().config;
            assert_eq!(serde_json::to_value(&before).unwrap(), serde_json::to_value(&after).unwrap(), "{error}");
            error
        };
        for arguments in ["-Xmx2G -XX:+UseZGC", "-Xms1G", "-XX:MaxHeapSize=1g"] {
            let mut changed = current.clone();
            changed.jvm_arguments = arguments.into();
            let error = rejected(changed, &current);
            assert_eq!(crate::errors::expected(error).code, "config.heapArguments", "{arguments}");
        }
        let mut too_small = current.clone();
        too_small.max_memory_mb = 2048;
        too_small.min_memory_mb = Some(4096);
        assert_eq!(crate::errors::expected(rejected(too_small, &current)).code, "config.minMemoryAboveMax");
        // A stale JVM snapshot cannot silently restore old arguments.
        state.update(|data| { data.config.jvm_arguments = "-XX:+UseG1GC".into(); Ok(()) }).unwrap();
        assert_eq!(rejected(current.clone(), &current), crate::errors::STORAGE_STATE_CHANGED);
    }

    #[test]
    fn r4_nonvisual_save_keeps_the_latest_independently_saved_appearance() {
        let (_root, state) = owned_profile();
        let previous = state.snapshot().unwrap().config;
        let mut pending = previous.clone();
        pending.max_memory_mb = 4096;
        let patch = serde_json::from_value(json!({"theme":"light", "defaultSkin":"alex"})).unwrap();
        save_appearance_config_inner(&state, patch).unwrap();
        let saved = save_approved_config_with_scope(&state, pending.clone(), Some(&previous), true).unwrap();
        assert_eq!((saved.theme.as_str(), saved.default_skin.as_str(), saved.max_memory_mb), ("light", "alex", 4096));

        let after = state.snapshot().unwrap().config;
        state.update(|data| {
            data.config.custom_background = Some("synthetic-background.png".into());
            Ok(())
        }).unwrap();
        pending.max_memory_mb = 2048;
        let saved = save_approved_config_with_scope(&state, pending.clone(), Some(&after), true).unwrap();
        assert_eq!(saved.custom_background.as_deref(), Some("synthetic-background.png"));
        assert_eq!(saved.max_memory_mb, 2048);
        state.update(|data| {
            data.config.game_directory = std::env::current_dir().unwrap().join("another-game").display().to_string();
            Ok(())
        }).unwrap();
        assert!(save_approved_config_with_scope(&state, pending, Some(&after), true).is_err());
    }

    #[test]
    fn noop_or_invalid_patch_does_not_write_and_rejects_nonvisual_fields() {
        let (root, state) = owned_profile();
        let file = root.path().join("state.json");
        assert!(serde_json::from_value::<AppearancePatch>(
            json!({"theme":"light","maxMemoryMb":4096})
        )
        .is_err());
        assert!(
            serde_json::from_value::<AppearancePatch>(json!({"customBackground":null})).is_err()
        );
        assert!(save_appearance_config_inner(&state, AppearancePatch::default()).is_ok());
        assert!(!file.exists());
        for patch in [
            json!({"theme":"future"}),
            json!({"language":"xx-XX"}),
            json!({"accentColor":"bad"}),
            json!({"effects":"future"}),
            json!({"worldScene":"future"}),
            json!({"worldMaterial":"future"}),
            json!({"defaultSkin":"future"}),
        ] {
            assert!(
                save_appearance_config_inner(&state, serde_json::from_value(patch).unwrap())
                    .is_err()
            );
        }
        assert!(!file.exists());
        assert_eq!(state.snapshot().unwrap().config.theme, "system");
    }

    #[test]
    fn an_installed_profile_promotes_to_a_named_instance_folder() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "fabric-loader-0.16.9-1.21.1", false, json!({
            "id": "fabric-loader-0.16.9-1.21.1", "inheritsFrom": "1.21.1",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "launcherMetadata": { "loader": "fabric", "loaderVersion": "0.16.9" },
            "libraries": [{ "name": "net.fabricmc:fabric-loader:0.16.9" }]
        }));
        let instance = create_instance_from_version_inner(
            &state,
            Some("My Fabric World".into()),
            "fabric-loader-0.16.9-1.21.1".into(),
        )
        .unwrap();
        assert_eq!(instance.kind, "version");
        assert_eq!(instance.version_id, "My Fabric World");
        assert!(instance.isolated);
        assert_eq!(instance.loader, "fabric");
        assert_eq!(instance.loader_version, "0.16.9");
        assert_eq!(state.snapshot().unwrap().instances.len(), 1);
        let profile: Value = serde_json::from_slice(
            &std::fs::read(root.join("versions/My Fabric World/My Fabric World.json")).unwrap(),
        ).unwrap();
        assert_eq!(profile["id"], "My Fabric World");
        assert_eq!(profile["inheritsFrom"], "1.21.1");
        assert_eq!(profile["libraries"][0]["name"], "net.fabricmc:fabric-loader:0.16.9");
        assert!(crate::instances::profile_is_owned(
            &state.snapshot().unwrap(),
            &root.join("versions/My Fabric World/My Fabric World.json")
        ));
        assert_eq!(
            crate::errors::expected(
                create_instance_from_version_inner(
                    &state,
                    Some("My Fabric World".into()),
                    "fabric-loader-0.16.9-1.21.1".into(),
                )
                .unwrap_err()
            )
            .code,
            "instance.folderNameTaken"
        );
    }

    #[test]
    fn the_default_vanilla_name_registers_the_installed_version_folder() {
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/command-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let root = holder.path().join("game");
        std::fs::create_dir_all(&root).unwrap();
        let config = Config {
            game_directory: root.to_string_lossy().into_owned(),
            ..Config::default()
        };
        let state = std::sync::Arc::new(LauncherState::test_fixture(
            holder.path().join("data"),
            Persisted { config, ..Default::default() },
            crate::storage::test_client(),
        ));
        let game = root.clone();
        let install = async move {
            // What minecraft::install does for a version that was not installed.
            write_test_version(&game, "1.21.1", true, json!({
                "id": "1.21.1", "type": "release",
                "mainClass": "net.minecraft.client.main.Main"
            }));
            Ok::<_, String>(("1.21.1".into(), "1.21.1".into(), String::new()))
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let instance = runtime
            .block_on(create_game_instance_with(
                &state,
                None,
                "1.21.1".into(),
                "vanilla".into(),
                install,
            ))
            .expect("the default name must not fail after the download");
        assert_eq!(instance.version_id, "1.21.1");
        assert_eq!(instance.kind, "version");
        assert_eq!(instance.loader, "vanilla");
        assert!(!root.join("versions/1.21.1-2").exists(), "no duplicate folder");
        assert!(root.join("versions/1.21.1/1.21.1.json").is_file());
        let profile: Value =
            serde_json::from_slice(&std::fs::read(root.join("versions/1.21.1/1.21.1.json")).unwrap())
                .unwrap();
        assert_eq!(profile["id"], "1.21.1", "the official profile is not rewritten");
        assert_eq!(state.snapshot().unwrap().instances.len(), 1);
    }

    #[test]
    fn a_failed_create_is_not_offered_as_a_vanilla_install_retry() {
        let (_holder, root, state) = version_fixture();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let error = runtime
            .block_on(create_game_instance_with(
                &state,
                Some("Survival".into()),
                "1.21.1".into(),
                "fabric".into(),
                async { Err::<(String, String, String), String>("Fabric 加载器下载失败".into()) },
            ))
            .unwrap_err();
        assert_eq!(error, "Fabric 加载器下载失败");
        let jobs = state.control.list();
        assert_eq!(jobs.len(), 1);
        let row = &jobs[0];
        assert_eq!((row.kind.as_str(), row.status.as_str()), ("instance-create", "failed"));
        assert_eq!(row.label, "创建实例 Survival");
        assert!(row.retry.is_none(), "no retry payload is recorded");
        assert!(!row.retryable, "the history offers no retry");
        let refused = state.control.queue_retry(&row.id).unwrap_err();
        assert_eq!(expected(refused).code, "download.retryUnsupported");
        assert_eq!(state.control.list().len(), 1, "nothing was queued");
        assert!(!root.join("versions/Survival").exists());
        assert!(state.snapshot().unwrap().instances.is_empty());
    }

    #[test]
    fn a_name_that_is_another_official_version_is_refused_before_installing() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/command-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let root = holder.path().join("game");
        std::fs::create_dir_all(&root).unwrap();
        let config = Config {
            game_directory: root.to_string_lossy().into_owned(),
            ..Config::default()
        };
        let state = std::sync::Arc::new(LauncherState::test_fixture(
            holder.path().join("data"),
            Persisted { config, ..Default::default() },
            crate::storage::test_client(),
        ));
        let sha1 = "a".repeat(40);
        let manifest = json!({
            "latest": { "release": "1.21.1", "snapshot": "1.21.1" },
            "versions": [
                { "id": "1.21.1", "type": "release", "url": "https://piston-meta.mojang.com/v1/packages/a/1.21.1.json", "sha1": sha1 },
                { "id": "1.20.1", "type": "release", "url": "https://piston-meta.mojang.com/v1/packages/b/1.20.1.json", "sha1": "b".repeat(40) }
            ]
        });
        std::fs::write(
            state.data_dir.join("version-manifest-mojang.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let installed = std::sync::Arc::new(AtomicBool::new(false));
        let flag = installed.clone();
        let install = async move {
            flag.store(true, Ordering::SeqCst);
            Ok::<_, String>(("1.21.1".into(), "1.21.1".into(), String::new()))
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let error = runtime
            .block_on(create_game_instance_with(
                &state,
                Some("1.20.1".into()),
                "1.21.1".into(),
                "vanilla".into(),
                install,
            ))
            .unwrap_err();
        assert_eq!(
            crate::errors::expected(error).code,
            "instance.officialVersionName"
        );
        assert!(!installed.load(Ordering::SeqCst), "nothing was downloaded");
        assert!(state.snapshot().unwrap().instances.is_empty());
    }


    #[test]
    fn failed_config_persistence_never_publishes_download_limit() {
        let (root, state) = owned_profile();
        let file = root.path().join("state.json");
        fs::create_dir(&file).unwrap(); // A non-file fails the current-state check before writing or renaming.
        let mut draft = state.snapshot().unwrap().config;
        draft.download_limit_kib = 1024;
        draft.download_concurrency = 3;
        assert!(save_config_inner(&state, draft.clone()).is_err());
        assert_eq!(state.snapshot().unwrap().config.download_limit_kib, 128);
        assert_eq!(state.control.limit_for_test(), 128);
        assert_eq!(state.control.connections().limit(), 8, "the connection limit follows only a saved setting");
        fs::remove_dir(&file).unwrap();
        save_config_inner(&state, draft).unwrap();
        let saved: Persisted = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_eq!(saved.config.download_limit_kib, 1024);
        assert_eq!(state.control.limit_for_test(), 1024);
        assert_eq!(state.control.connections().limit(), 3, "a saved concurrency limits the connections at once");
    }

    /// A temporary game folder with an installed vanilla base.
    fn version_fixture() -> (crate::instances::StagingDirectory, PathBuf, std::sync::Arc<LauncherState>) {
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/version-model-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let root = holder.path().join("game");
        std::fs::create_dir_all(&root).unwrap();
        write_test_version(&root, "1.21.1", true, json!({
            "id": "1.21.1", "type": "release", "mainClass": "net.minecraft.client.main.Main"
        }));
        let mut config = Config {
            game_directory: root.to_string_lossy().into_owned(),
            ..Config::default()
        };
        config.normalize_game_folders();
        let state = LauncherState::test_fixture(
            holder.path().join("data"),
            Persisted { config, ..Default::default() },
            crate::storage::test_client(),
        );
        (holder, root, std::sync::Arc::new(state))
    }

    fn write_test_version(root: &Path, id: &str, jar: bool, metadata: Value) {
        let directory = root.join("versions").join(id);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(format!("{id}.json")), metadata.to_string()).unwrap();
        if jar {
            std::fs::write(directory.join(format!("{id}.jar")), b"client jar").unwrap();
        }
    }

    #[test]
    fn every_launchable_version_folder_is_scanned_as_an_instance_once() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "1.21.1-fabric", false, json!({
            "id": "1.21.1-fabric", "inheritsFrom": "1.21.1",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "launcherMetadata": { "loader": "fabric", "loaderVersion": "0.16.9" }
        }));
        write_test_version(&root, "not-installed", false, json!({
            "id": "not-installed", "mainClass": "net.minecraft.client.main.Main"
        }));
        crate::instances::sync_version_instances(&state).unwrap();
        let snapshot = state.snapshot().unwrap();
        let mut ids: Vec<_> = snapshot
            .instances
            .iter()
            .map(|instance| instance.version_id.clone())
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["1.21.1", "1.21.1-fabric", "not-installed"]);
        let unlaunchable = snapshot
            .instances
            .iter()
            .find(|instance| instance.version_id == "not-installed")
            .unwrap();
        assert!(unlaunchable.issue.is_some(), "the reason is kept");
        assert!(snapshot.instances.iter().all(|instance| {
            instance.kind == "version"
                && instance.game_folder == snapshot.config.game_directory
                && instance.isolated
                && !instance.hidden
        }));
        let fabric = snapshot
            .instances
            .iter()
            .find(|instance| instance.version_id == "1.21.1-fabric")
            .unwrap();
        assert_eq!((fabric.loader.as_str(), fabric.loader_version.as_str()), ("fabric", "0.16.9"));
        let before: Vec<_> = snapshot
            .instances
            .iter()
            .map(|instance| (instance.id.clone(), instance.game_directory.clone()))
            .collect();
        crate::instances::sync_version_instances(&state).unwrap();
        let after: Vec<_> = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .map(|instance| (instance.id.clone(), instance.game_directory.clone()))
            .collect();
        assert_eq!(before, after, "a second scan does not duplicate or move instances");
    }

    #[test]
    fn isolation_is_decided_from_real_game_data_and_never_changes() {
        let (_holder, root, state) = version_fixture();
        std::fs::create_dir_all(root.join("saves/World")).unwrap();
        std::fs::write(root.join("saves/World/level.dat"), b"level").unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let shared = state
            .snapshot()
            .unwrap()
            .instances
            .into_iter()
            .find(|instance| instance.version_id == "1.21.1")
            .unwrap();
        assert!(!shared.isolated, "root game data keeps the classic shared layout");
        assert_eq!(
            PathBuf::from(&shared.game_directory),
            crate::processes::configured_game_root(&root).unwrap()
        );

        // A version folder with its own data is isolated, even with the global
        // flag off and even when the root also has data.
        std::fs::create_dir_all(root.join("versions/1.21.1/mods")).unwrap();
        std::fs::write(root.join("versions/1.21.1/mods/a.jar"), b"mod").unwrap();
        let _holder2 = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/version-model-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let root2 = _holder2.path().join("game");
        std::fs::create_dir_all(&root2).unwrap();
        write_test_version(&root2, "1.20.1", true, json!({
            "id": "1.20.1", "mainClass": "net.minecraft.client.main.Main"
        }));
        std::fs::create_dir_all(root2.join("versions/1.20.1/saves")).unwrap();
        let mut config = Config { game_directory: root2.to_string_lossy().into_owned(), version_isolation: false, ..Default::default() };
        config.normalize_game_folders();
        let state2 = LauncherState::test_fixture(
            _holder2.path().join("data"),
            Persisted { config, ..Default::default() },
            crate::storage::test_client(),
        );
        crate::instances::sync_version_instances(&state2).unwrap();
        let isolated = state2.snapshot().unwrap().instances.into_iter().next().unwrap();
        assert!(isolated.isolated);
        assert_eq!(isolated.version_id, "1.20.1");

        // The stored decision survives later changes to folders and the global flag.
        state.update(|data| {
            data.config.version_isolation = false;
            Ok(())
        }).unwrap();
        std::fs::create_dir_all(root.join("versions/1.21.1/saves")).unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let stable = state.snapshot().unwrap().instances;
        let shared = stable.iter().find(|instance| instance.version_id == "1.21.1").unwrap();
        assert!(!shared.isolated, "a shared instance is never silently isolated");
    }

    #[test]
    fn hidden_instances_and_missing_folders_leave_the_list_but_keep_settings() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "1.20.1", true, json!({
            "id": "1.20.1", "mainClass": "net.minecraft.client.main.Main"
        }));
        crate::instances::sync_version_instances(&state).unwrap();
        let target = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "1.20.1")
            .unwrap()
            .id
            .clone();
        remove_instance_inner(&state, &target).unwrap();
        assert!(
            !crate::instances::visible_instances(&state.snapshot().unwrap())
                .iter()
                .any(|instance| instance.id == target),
            "a removed version-folder instance is hidden"
        );
        assert!(root.join("versions/1.20.1").exists(), "removal never deletes files");
        crate::instances::sync_version_instances(&state).unwrap();
        assert!(state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .any(|instance| instance.id == target && instance.hidden));

        // A folder that disappears leaves the visible list at the next scan and
        // is purged only after the 30-day grace.
        std::fs::remove_dir_all(root.join("versions/1.20.1")).unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let missing = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.id == target)
            .cloned()
            .unwrap();
        assert!(missing.folder_missing_since.is_some());
        assert!(!crate::instances::visible_instances(&state.snapshot().unwrap())
            .iter()
            .any(|instance| instance.id == target));
        state.update(|data| {
            let record = data.instances.iter_mut().find(|instance| instance.id == target).unwrap();
            record.folder_missing_since = Some(
                (chrono::Utc::now() - chrono::Duration::days(31)).to_rfc3339(),
            );
            Ok(())
        }).unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        assert!(!state.snapshot().unwrap().instances.iter().any(|instance| instance.id == target));
    }

    #[test]
    fn instance_profiles_are_named_children_with_recorded_ownership() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "fabric-loader-0.16.9-1.21.1", false, json!({
            "id": "fabric-loader-0.16.9-1.21.1", "inheritsFrom": "1.21.1",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries": [{ "name": "net.fabricmc:fabric-loader:0.16.9" }]
        }));
        write_instance_profile(&state, &root, "1.21.1-Survival", "1.21.1", "1.21.1", "vanilla").unwrap();
        let profile: Value = serde_json::from_slice(
            &std::fs::read(root.join("versions/1.21.1-Survival/1.21.1-Survival.json")).unwrap(),
        ).unwrap();
        assert_eq!(profile["id"], "1.21.1-Survival");
        assert_eq!(profile["inheritsFrom"], "1.21.1");
        let path = root.join("versions/1.21.1-Survival/1.21.1-Survival.json");
        assert!(crate::instances::profile_is_owned(&state.snapshot().unwrap(), &path));
        assert!(write_instance_profile(&state, &root, "1.21.1-Survival", "1.21.1", "1.21.1", "vanilla").is_err());

        write_instance_profile(
            &state,
            &root,
            "Fabric Pack",
            "1.21.1",
            "fabric-loader-0.16.9-1.21.1",
            "fabric",
        ).unwrap();
        let profile: Value = serde_json::from_slice(
            &std::fs::read(root.join("versions/Fabric Pack/Fabric Pack.json")).unwrap(),
        ).unwrap();
        assert_eq!(profile["id"], "Fabric Pack");
        assert_eq!(profile["inheritsFrom"], "1.21.1");
        assert!(profile.get("jar").is_none());
        assert_eq!(profile["libraries"][0]["name"], "net.fabricmc:fabric-loader:0.16.9");
        assert!(crate::instances::profile_is_owned(
            &state.snapshot().unwrap(),
            &root.join("versions/Fabric Pack/Fabric Pack.json")
        ));
    }

    #[test]
    fn copying_a_version_folder_renames_its_profile_and_checks_names() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "1.20.1", true, json!({
            "id": "1.20.1", "mainClass": "net.minecraft.client.main.Main",
            "libraries": [],
            "arguments": { "game": ["--username", "${auth_player_name}"] }
        }));
        crate::instances::sync_version_instances(&state).unwrap();
        let source = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "1.20.1")
            .unwrap()
            .id
            .clone();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let copied = runtime
            .block_on(copy_instance_inner(&state, &source, Some("1.20.1 Copy")))
            .unwrap();
        assert_eq!(copied.version_id, "1.20.1 Copy");
        assert_eq!(copied.kind, "version");
        let profile: Value = serde_json::from_slice(
            &std::fs::read(root.join("versions/1.20.1 Copy/1.20.1 Copy.json")).unwrap(),
        ).unwrap();
        assert_eq!(profile["id"], "1.20.1 Copy");
        assert!(root.join("versions/1.20.1 Copy/1.20.1 Copy.jar").is_file());
        for name in ["../escape", "CON", "bad:name"] {
            let error = runtime
                .block_on(copy_instance_inner(&state, &source, Some(name)))
                .unwrap_err();
            assert_eq!(
                crate::errors::expected(error).code,
                "instance.folderNameInvalid",
                "{name}"
            );
        }
        let taken = runtime
            .block_on(copy_instance_inner(&state, &source, Some("1.21.1")))
            .unwrap_err();
        assert_eq!(crate::errors::expected(taken).code, "instance.folderNameTaken");
    }

    #[test]
    fn shared_root_instances_refuse_loader_switches_and_backups() {
        let (_holder, root, state) = version_fixture();
        let mut config = state.snapshot().unwrap().config;
        config.version_isolation = false;
        let id = "shared-version".to_owned();
        let instance = Instance {
            id: id.clone(),
            name: "Shared".into(),
            version_id: "1.21.1".into(),
            game_directory: root.to_string_lossy().into_owned(),
            kind: "version".into(),
            game_folder: config.game_directory.clone(),
            isolated: false,
            ..Default::default()
        };
        state.update(|data| {
            data.config = config;
            data.instances.push(instance);
            Ok(())
        }).unwrap();
        let error = match crate::instances::plan_loader_switch(&state, &id, "vanilla", None) {
            Ok(_) => panic!("a shared-root loader switch must be refused"),
            Err(error) => error,
        };
        assert_eq!(error.code, "instance.sharedRootRequired");
        let snapshot = state.snapshot().unwrap();
        let error = crate::instances::backup_inner(&state, &snapshot.instances[0]).unwrap_err();
        assert_eq!(crate::errors::expected(error).code, "instance.sharedRootRequired");
        assert!(crate::instances::visible_instances(&state.snapshot().unwrap())
            .iter()
            .any(|instance| instance.id == id));
    }

    #[test]
    fn deleting_a_version_instance_removes_only_its_version_folder() {
        let (_holder, root, state) = version_fixture();
        std::fs::create_dir_all(root.join("libraries/net/example")).unwrap();
        std::fs::write(root.join("libraries/net/example/a.jar"), b"library").unwrap();
        std::fs::create_dir_all(root.join("saves/World")).unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let id = state.snapshot().unwrap().instances[0].id.clone();
        let error = delete_instance_inner(&state, &id, false, true).unwrap_err();
        assert_eq!(crate::errors::expected(error).code, "instance.deleteConfirmRequired");
        delete_instance_inner(&state, &id, true, true).unwrap();
        assert!(!root.join("versions/1.21.1").exists());
        assert!(root.join("libraries/net/example/a.jar").is_file(), "libraries are shared");
        assert!(root.join("saves/World").is_dir(), "root saves are never deleted");
        assert!(state.snapshot().unwrap().instances.is_empty());
    }

    #[test]
    fn isolation_world_copy_is_complete_or_absent() {
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/command-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let root = holder.path().join("game");
        let version = root.join("versions/Survival");
        std::fs::create_dir_all(root.join("saves/World")).unwrap();
        std::fs::write(root.join("saves/World/level.dat"), b"level").unwrap();
        std::fs::write(root.join("saves/World/region.mca"), b"region").unwrap();
        std::fs::create_dir_all(&version).unwrap();
        copy_shared_worlds(&root, &version).unwrap();
        assert_eq!(
            std::fs::read(version.join("saves/World/level.dat")).unwrap(),
            b"level"
        );
        assert_eq!(
            std::fs::read(version.join("saves/World/region.mca")).unwrap(),
            b"region"
        );
        let leftovers: Vec<_> = std::fs::read_dir(version.join("saves"))
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".voxelight-world-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        // A copy that cannot be published removes its temporary directory and
        // never creates the final name.
        let target = holder.path().join("target-saves");
        std::fs::create_dir_all(target.join("Occupied")).unwrap();
        std::fs::write(target.join("Occupied/keep.txt"), b"existing world").unwrap();
        let error =
            copy_world_atomically(&root.join("saves/World"), &target, std::ffi::OsStr::new("Occupied"))
                .unwrap_err();
        assert!(error.contains("无法提交存档"), "{error}");
        let leftovers: Vec<_> = std::fs::read_dir(&target)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".voxelight-world-"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        assert_eq!(
            std::fs::read(target.join("Occupied/keep.txt")).unwrap(),
            b"existing world",
            "the occupied name is untouched"
        );
    }

    #[test]
    fn the_isolation_switch_waits_for_an_unfinished_restore_or_pack_update() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "Survival", false, json!({ "id": "Survival", "inheritsFrom": "1.21.1" }));
        let folder = root.join("versions/Survival");
        let game_folder = state.snapshot().unwrap().config.game_directory;
        let record = crate::instances::register_version_instance(
            &state,
            crate::instances::build_version_instance("Survival", "Survival", &folder, &game_folder, "vanilla", "")
                .unwrap(),
        )
        .unwrap();
        // A pack update of this instance stopped after it wrote its record.
        let backups = state.data_dir.join("instance-backups").join(&record.id);
        std::fs::create_dir_all(&backups).unwrap();
        let intent = backups.join("restore-in-progress.json");
        std::fs::write(
            &intent,
            serde_json::to_vec_pretty(&json!({
                "token": uuid::Uuid::new_v4(), "kind": "packUpdate",
                "before": record, "after": record, "original": null,
                "selected": { "id": uuid::Uuid::new_v4(), "manifestSha256": "0".repeat(64) }
            }))
            .unwrap(),
        )
        .unwrap();
        let before = serde_json::to_value(state.snapshot().unwrap().instances).unwrap();
        for (isolated, copy_worlds) in [(false, false), (true, true)] {
            let error = set_instance_isolation_inner(&state, &record.id, isolated, copy_worlds).unwrap_err();
            assert_eq!(expected(error).code, "instance.restorePending", "{isolated}");
        }
        assert_eq!(serde_json::to_value(state.snapshot().unwrap().instances).unwrap(), before);
        assert!(!folder.join("saves").exists() && !folder.join("mods").exists(), "nothing was prepared");
        // Its recovery still finds the game directory the record names.
        assert!(crate::instances::require_no_pending_restore(&state, &record.id).is_err());
        // Once nothing is pending the switch works again.
        std::fs::remove_file(&intent).unwrap();
        let shared = set_instance_isolation_inner(&state, &record.id, false, false).unwrap();
        assert!(!shared.isolated);
    }


    #[test]
    fn deleting_a_version_folder_refuses_instances_that_inherit_from_it() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "1.21.1-child", false, json!({
            "id": "1.21.1-child", "inheritsFrom": "1.21.1",
            "mainClass": "net.minecraft.client.main.Main"
        }));
        crate::instances::sync_version_instances(&state).unwrap();
        let snapshot = state.snapshot().unwrap();
        let base = snapshot
            .instances
            .iter()
            .find(|instance| instance.version_id == "1.21.1")
            .unwrap()
            .clone();
        let child = snapshot
            .instances
            .iter()
            .find(|instance| instance.version_id == "1.21.1-child")
            .unwrap()
            .clone();
        let listed = list_instance_dependants_inner(&state, &base.id).unwrap();
        assert_eq!(listed, vec!["1.21.1-child"], "the confirmation lists the child");
        let error = crate::errors::expected(
            delete_instance_inner(&state, &base.id, true, true).unwrap_err(),
        );
        assert_eq!(error.code, "instance.deleteDependants");
        assert_eq!(error.params["instances"], "1.21.1-child");
        assert!(root.join("versions/1.21.1/1.21.1.json").is_file(), "base kept");
        assert!(root.join("versions/1.21.1-child/1.21.1-child.json").is_file());

        // A running dependant is a running game, even when it shares the root.
        state
            .games
            .fixture_running_directory(Path::new(&child.game_directory), Some(&child.id));
        let running = crate::errors::expected(
            delete_instance_inner(&state, &base.id, true, true).unwrap_err(),
        );
        assert_eq!(running.code, "instance.running");
        assert!(root.join("versions/1.21.1").is_dir());
    }

    #[test]
    fn deleting_a_version_folder_uses_the_recycle_bin_by_default() {
        use std::sync::{Arc, Mutex};
        let (_holder, root, state) = version_fixture();
        crate::instances::sync_version_instances(&state).unwrap();
        let id = state.snapshot().unwrap().instances[0].id.clone();
        let seen = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
        let recorded = seen.clone();
        set_recycle_hook(Some(Box::new(move |path: &Path, _owner: Option<isize>| {
            recorded.lock().unwrap().push(path.to_path_buf());
            Ok(())
        })));
        delete_instance_inner(&state, &id, true, false).unwrap();
        assert_eq!(
            seen.lock().unwrap().as_slice(),
            [root.join("versions/1.21.1")],
            "the default delete moves the folder to the recycle bin"
        );
        assert!(root.join("versions/1.21.1").is_dir(), "the test hook did not delete");
        assert!(state.snapshot().unwrap().instances.is_empty());

        // A recycle failure keeps the files and the record, and is coded.
        crate::instances::sync_version_instances(&state).unwrap();
        let id = state.snapshot().unwrap().instances[0].id.clone();
        set_recycle_hook(Some(Box::new(|_: &Path, _: Option<isize>| Err("disk full".into()))));
        let error = crate::errors::expected(
            delete_instance_inner(&state, &id, true, false).unwrap_err(),
        );
        assert_eq!(error.code, "instance.recycleFailed");
        assert!(root.join("versions/1.21.1").is_dir());
        assert_eq!(state.snapshot().unwrap().instances.len(), 1);
        set_recycle_hook(None);
    }

    fn ambient_test_profile() -> (crate::instances::StagingDirectory, LauncherState) {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/command-tests")
                .join(format!("ambient-{}", uuid::Uuid::new_v4())),
        )
        .unwrap();
        let config = Config {
            game_directory: root
                .path()
                .join("isolated-game")
                .to_string_lossy()
                .into_owned(),
            max_memory_mb: 16384,
            ..Config::default()
        };
        let state = LauncherState::test_fixture(
            root.path().to_path_buf(),
            Persisted {
                config,
                ..Persisted::default()
            },
            crate::storage::test_client(),
        );
        (root, state)
    }

    #[test]
    fn appearance_patch_accepts_ambient_and_background_boundary_values_and_saves_them() {
        let (root, state) = ambient_test_profile();
        let file = root.path().join("state.json");

        let min_patch = serde_json::from_value(json!({
            "ambientLightEnabled": false,
            "ambientLightIntensity": 0,
            "backgroundBlur": 0,
            "backgroundDim": 0,
            "backgroundDrift": true,
        }))
        .unwrap();
        let saved_min = save_appearance_config_inner(&state, min_patch).unwrap();
        assert!(!saved_min.ambient_light_enabled);
        assert_eq!(saved_min.ambient_light_intensity, 0);
        assert_eq!(saved_min.background_blur, 0);
        assert_eq!(saved_min.background_dim, 0);
        assert!(saved_min.background_drift);

        let persisted_min: Persisted =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert!(!persisted_min.config.ambient_light_enabled);
        assert_eq!(persisted_min.config.ambient_light_intensity, 0);
        assert_eq!(persisted_min.config.background_blur, 0);
        assert_eq!(persisted_min.config.background_dim, 0);
        assert!(persisted_min.config.background_drift);

        let max_patch = serde_json::from_value(json!({
            "ambientLightEnabled": true,
            "ambientLightIntensity": 100,
            "backgroundBlur": 24,
            "backgroundDim": 80,
            "backgroundDrift": false,
        }))
        .unwrap();
        let saved_max = save_appearance_config_inner(&state, max_patch).unwrap();
        assert!(saved_max.ambient_light_enabled);
        assert_eq!(saved_max.ambient_light_intensity, 100);
        assert_eq!(saved_max.background_blur, 24);
        assert_eq!(saved_max.background_dim, 80);
        assert!(!saved_max.background_drift);

        let persisted_max: Persisted =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert!(persisted_max.config.ambient_light_enabled);
        assert_eq!(persisted_max.config.ambient_light_intensity, 100);
        assert_eq!(persisted_max.config.background_blur, 24);
        assert_eq!(persisted_max.config.background_dim, 80);
        assert!(!persisted_max.config.background_drift);
    }

    #[test]
    fn appearance_patch_rejects_out_of_range_ambient_and_background_values_without_writing() {
        let (root, state) = ambient_test_profile();
        let file = root.path().join("state.json");
        for patch in [
            json!({"ambientLightIntensity": 101}),
            json!({"backgroundBlur": 25}),
            json!({"backgroundDim": 81}),
        ] {
            assert!(
                save_appearance_config_inner(&state, serde_json::from_value(patch).unwrap())
                    .is_err()
            );
        }
        assert!(!file.exists());
        let current = state.snapshot().unwrap().config;
        assert_eq!(current.ambient_light_intensity, 60);
        assert_eq!(current.background_blur, 8);
        assert_eq!(current.background_dim, 35);
    }

    #[test]
    fn preserve_appearance_keeps_saved_ambient_and_background_settings_on_nonvisual_save() {
        let (_root, state) = ambient_test_profile();
        let previous = state.snapshot().unwrap().config;
        let mut pending = previous.clone();
        pending.max_memory_mb = 4096;
        pending.ambient_light_enabled = true;
        pending.ambient_light_intensity = 60;
        pending.background_blur = 8;
        pending.background_dim = 35;
        pending.background_drift = false;

        let patch = serde_json::from_value(json!({
            "ambientLightEnabled": false,
            "ambientLightIntensity": 25,
            "backgroundBlur": 18,
            "backgroundDim": 60,
            "backgroundDrift": true,
        }))
        .unwrap();
        save_appearance_config_inner(&state, patch).unwrap();

        let saved =
            save_approved_config_with_scope(&state, pending, Some(&previous), true).unwrap();
        assert_eq!(saved.max_memory_mb, 4096);
        assert!(!saved.ambient_light_enabled);
        assert_eq!(saved.ambient_light_intensity, 25);
        assert_eq!(saved.background_blur, 18);
        assert_eq!(saved.background_dim, 60);
        assert!(saved.background_drift);
    }

    #[test]
    fn a_stale_record_does_not_duplicate_a_copied_instance_id() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "1.21.1-copy-me", false, json!({
            "id": "1.21.1-copy-me", "inheritsFrom": "1.21.1",
            "mainClass": "net.minecraft.client.main.Main"
        }));
        crate::instances::sync_version_instances(&state).unwrap();
        let source = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "1.21.1-copy-me")
            .unwrap()
            .clone();
        let name = "Copied World";
        let id = crate::instances::version_instance_id(&source.game_folder, name);
        state
            .update(|data| {
                data.instances.push(Instance {
                    id: id.clone(),
                    name: "Stale".into(),
                    version_id: name.into(),
                    kind: "version".into(),
                    game_folder: source.game_folder.clone(),
                    folder_missing_since: Some("2026-01-01T00:00:00Z".into()),
                    ..Default::default()
                });
                Ok(())
            })
            .unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let copied = runtime
            .block_on(copy_instance_inner(&state, &source.id, Some(name)))
            .unwrap();
        assert_eq!(copied.version_id, name);
        let matching: Vec<_> = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .filter(|instance| instance.id == id)
            .cloned()
            .collect();
        assert_eq!(matching.len(), 1, "one record for one folder");
        assert_eq!(matching[0].folder_missing_since, None);
        assert!(root.join("versions/Copied World/Copied World.json").is_file());
    }

    #[test]
    fn m1_copying_an_official_vanilla_folder_makes_a_child_of_it() {
        let (_holder, root, state) = version_fixture();
        // A complete official profile, exactly as the vanilla installer
        // writes it. Its copy is the PCL-style child of the vanilla folder, so
        // it keeps the Minecraft version and inherits each argument once.
        write_test_version(&root, "1.21.1", true, json!({
            "id": "1.21.1", "type": "release", "mainClass": "net.minecraft.client.main.Main",
            "libraries": [],
            "arguments": { "game": ["--username", "${auth_player_name}"] }
        }));
        crate::instances::sync_version_instances(&state).unwrap();
        let source = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "1.21.1")
            .unwrap()
            .clone();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let copied = runtime
            .block_on(copy_instance_inner(&state, &source.id, Some("Survival")))
            .unwrap();
        let profile: Value = serde_json::from_slice(
            &std::fs::read(root.join("versions/Survival/Survival.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(profile, json!({ "id": "Survival", "inheritsFrom": "1.21.1" }));
        // Discover, loader switches and exports all read the game version
        // through this chain; it must be the vanilla id, not the folder name.
        assert_eq!(
            crate::resources::version_context(&root, "Survival").unwrap(),
            ("1.21.1".to_owned(), None)
        );
        assert_eq!(
            crate::instances::resolve_instance_game_version(&state, &copied).unwrap(),
            "1.21.1"
        );
        let merged = crate::minecraft::resolve_local_metadata(&root, "Survival").unwrap();
        assert_eq!(
            merged["arguments"]["game"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|value| *value == "--username")
                .count(),
            1,
            "each game argument once"
        );
        assert_eq!(merged["_launcherClientId"], "1.21.1");
        // The scan lists the copy as a launchable instance of its own.
        crate::instances::sync_version_instances(&state).unwrap();
        let listed = state
            .snapshot()
            .unwrap()
            .instances
            .into_iter()
            .find(|instance| instance.version_id == "Survival")
            .unwrap();
        assert_eq!(listed.issue, None);

        // A renamed vanilla folder (another launcher's custom name) is still a
        // vanilla terminal profile by its main class, and its copy inherits it.
        write_test_version(&root, "My Vanilla", true, json!({
            "id": "My Vanilla", "mainClass": "net.minecraft.client.main.Main",
            "libraries": [], "arguments": { "game": ["--username", "${auth_player_name}"] }
        }));
        crate::instances::sync_version_instances(&state).unwrap();
        let custom = state
            .snapshot()
            .unwrap()
            .instances
            .into_iter()
            .find(|instance| instance.version_id == "My Vanilla")
            .unwrap();
        runtime
            .block_on(copy_instance_inner(&state, &custom.id, Some("My Vanilla Copy")))
            .unwrap();
        let profile: Value = serde_json::from_slice(
            &std::fs::read(root.join("versions/My Vanilla Copy/My Vanilla Copy.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(profile["inheritsFrom"], "My Vanilla");
    }

    #[test]
    fn a_failed_copy_never_leaves_a_half_version_folder() {
        let (_holder, root, state) = version_fixture();
        // A folder whose profile is missing cannot be rewritten; the copy is
        // rejected and the published destination must not remain.
        let source_dir = root.join("versions/Broken Source");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::write(
            source_dir.join("Broken Source.json"),
            json!({ "id": "Broken Source", "inheritsFrom": "1.21.1" }).to_string(),
        )
        .unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let source = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "Broken Source")
            .unwrap()
            .clone();
        std::fs::remove_file(source_dir.join("Broken Source.json")).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let error = runtime
            .block_on(copy_instance_inner(&state, &source.id, Some("Broken Copy")))
            .unwrap_err();
        assert!(error.contains("版本配置"), "{error}");
        assert!(!root.join("versions/Broken Copy").exists());
    }

    #[test]
    fn bootstrap_scans_each_configured_folder_once() {
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/version-model-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let first = holder.path().join("first");
        let second = holder.path().join("second");
        for root in [&first, &second] {
            write_test_version(root, "1.21.1", true, json!({ "id": "1.21.1" }));
        }
        let mut config = Config {
            game_directory: first.to_string_lossy().into_owned(),
            game_folders: vec![
                crate::models::GameFolder { path: first.to_string_lossy().into_owned(), label: String::new(), active: true },
                crate::models::GameFolder { path: second.to_string_lossy().into_owned(), label: String::new(), active: false },
            ],
            ..Config::default()
        };
        config.normalize_game_folders();
        let state = std::sync::Arc::new(LauncherState::test_fixture(
            holder.path().join("data"),
            Persisted { config, ..Default::default() },
            crate::storage::test_client(),
        ));
        crate::minecraft::SCAN_PATHS.lock().unwrap().clear();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let value = runtime.block_on(bootstrap_inner(&state)).unwrap();
        let scanned = crate::minecraft::SCAN_PATHS.lock().unwrap().clone();
        let count = |path: &Path| {
            scanned
                .iter()
                .filter(|root| {
                    crate::instances::normalized_folder_identity(&root.to_string_lossy())
                        == crate::instances::normalized_folder_identity(&path.to_string_lossy())
                })
                .count()
        };
        assert_eq!(count(&first), 1, "the active folder is scanned once: {scanned:?}");
        assert_eq!(count(&second), 1, "the other folder is scanned once");
        let versions = value["installedVersions"].as_array().unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0]["id"], "1.21.1");
    }

    #[test]
    fn bootstrap_logs_a_scan_failure_and_still_starts() {
        let (_holder, root, state) = version_fixture();
        // A directory where state.json belongs makes the scan's save fail.
        let state_file = state.data_dir.join("state.json");
        std::fs::create_dir_all(&state_file).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let value = runtime
            .block_on(bootstrap_inner(&state))
            .expect("a broken scan must not block startup");
        assert_eq!(value["config"]["gameDirectory"], root.to_string_lossy().as_ref());
        assert!(value["instances"].is_array());
        let logs = std::fs::read_dir(state.data_dir.join("logs"))
            .unwrap()
            .flatten()
            .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
            .collect::<String>();
        assert!(logs.contains("扫描实例文件夹失败"), "{logs}");
    }

    #[test]
    fn a_folder_that_exists_but_cannot_launch_is_not_missing() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "orphan", false, json!({
            "id": "orphan", "inheritsFrom": "not-installed",
            "mainClass": "net.minecraft.client.main.Main"
        }));
        crate::instances::sync_version_instances(&state).unwrap();
        let record = state
            .snapshot()
            .unwrap()
            .instances
            .into_iter()
            .find(|instance| instance.version_id == "orphan")
            .expect("the folder with its own json is listed");
        assert!(record.issue.is_some(), "an unlaunchable folder carries its reason");
        assert_eq!(record.folder_missing_since, None);
        crate::instances::sync_version_instances(&state).unwrap();
        assert!(state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .any(|instance| instance.version_id == "orphan" && instance.folder_missing_since.is_none()));
        // Only a removed `<name>.json` makes the folder missing.
        std::fs::remove_file(root.join("versions/orphan/orphan.json")).unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let missing = state
            .snapshot()
            .unwrap()
            .instances
            .into_iter()
            .find(|instance| instance.version_id == "orphan")
            .unwrap();
        assert!(missing.folder_missing_since.is_some());
        assert!(root.join("versions/orphan").is_dir(), "the folder itself is kept");
    }

    #[test]
    fn a_loader_parent_folder_is_hidden_but_restorable() {
        let (_holder, root, state) = version_fixture();
        let install_root = root.clone();
        let install = async move {
            // This loader folder is created by the same create call, so it is
            // the one case where the parent may be hidden behind the instance.
            write_test_version(&install_root, "fabric-loader-0.16.9-1.21.1", false, json!({
                "id": "fabric-loader-0.16.9-1.21.1", "inheritsFrom": "1.21.1",
                "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
                "launcherMetadata": { "loader": "fabric", "loaderVersion": "0.16.9" },
                "libraries": [{ "name": "net.fabricmc:fabric-loader:0.16.9" }]
            }));
            Ok::<_, String>((
                "1.21.1".into(),
                "fabric-loader-0.16.9-1.21.1".into(),
                "0.16.9".into(),
            ))
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let named = runtime
            .block_on(create_game_instance_with(
                &state,
                Some("Survival".into()),
                "1.21.1".into(),
                "fabric".into(),
                install,
            ))
            .unwrap();
        assert_eq!(named.derived_from.as_deref(), Some("fabric-loader-0.16.9-1.21.1"));
        crate::instances::sync_version_instances(&state).unwrap();
        let parent = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "fabric-loader-0.16.9-1.21.1")
            .unwrap()
            .clone();
        let visible = active_folder_instances(&state.snapshot().unwrap());
        assert!(visible.iter().any(|instance| instance.id == named.id));
        assert!(
            !visible.iter().any(|instance| instance.id == parent.id),
            "the loader profile created by this call is hidden"
        );
        assert!(root.join("versions/fabric-loader-0.16.9-1.21.1").is_dir(), "kept on disk");
        let restored = crate::instances::restore_instance_inner(&state, &parent.id).unwrap();
        assert!(!restored.hidden);
        assert_eq!(restored.derived_from, None);
        crate::instances::sync_version_instances(&state).unwrap();
        assert!(active_folder_instances(&state.snapshot().unwrap())
            .iter()
            .any(|instance| instance.id == parent.id));
        assert_eq!(
            state
                .snapshot()
                .unwrap()
                .instances
                .iter()
                .find(|instance| instance.id == named.id)
                .unwrap()
                .derived_from,
            None,
            "restoring the parent detaches the child so the next scan keeps it visible"
        );
    }

    #[test]
    fn instance_ids_are_stable_across_path_spellings_and_old_records_keep_theirs() {
        assert_eq!(
            crate::instances::version_instance_id("C:\\Games\\.minecraft\\", "1.21.1"),
            crate::instances::version_instance_id("c:/games/.minecraft", "1.21.1")
        );
        let (_holder, root, state) = version_fixture();
        state
            .update(|data| {
                data.instances.push(Instance {
                    id: "vx-old-spelling".into(),
                    name: "Old".into(),
                    version_id: "1.21.1".into(),
                    game_directory: root.join("versions/1.21.1").to_string_lossy().into_owned(),
                    kind: "version".into(),
                    game_folder: root.to_string_lossy().into_owned(),
                    isolated: true,
                    ..Default::default()
                });
                Ok(())
            })
            .unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let record = state
            .snapshot()
            .unwrap()
            .instances
            .into_iter()
            .find(|instance| instance.version_id == "1.21.1")
            .unwrap();
        assert_eq!(record.id, "vx-old-spelling", "existing ids never change under a scan");
    }

    #[test]
    fn a_second_version_scan_does_not_rewrite_state_json() {
        let (_holder, _root, state) = version_fixture();
        crate::instances::sync_version_instances(&state).unwrap();
        let file = state.data_dir.join("state.json");
        let first = std::fs::read(&file).unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        assert_eq!(
            std::fs::read(&file).unwrap(),
            first,
            "an unchanged scan must not bump writeGeneration"
        );
    }

    #[test]
    fn several_game_folders_are_scanned_and_only_the_active_one_is_listed() {
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/version-model-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let first_root = holder.path().join("first");
        let second_root = holder.path().join("second");
        for root in [&first_root, &second_root] {
            std::fs::create_dir_all(root).unwrap();
            write_test_version(root, "1.21.1", true, json!({
                "id": "1.21.1", "type": "release", "mainClass": "net.minecraft.client.main.Main"
            }));
        }
        let mut config = Config {
            game_directory: first_root.to_string_lossy().into_owned(),
            game_folders: vec![
                crate::models::GameFolder { path: first_root.to_string_lossy().into_owned(), label: "A".into(), active: true },
                crate::models::GameFolder { path: second_root.to_string_lossy().into_owned(), label: "B".into(), active: false },
            ],
            ..Config::default()
        };
        config.normalize_game_folders();
        let state = LauncherState::test_fixture(
            holder.path().join("data"),
            Persisted { config, ..Default::default() },
            crate::storage::test_client(),
        );
        crate::instances::sync_version_instances(&state).unwrap();
        let first_text = first_root.to_string_lossy().into_owned();
        let second_text = second_root.to_string_lossy().into_owned();
        let snapshot = state.snapshot().unwrap();
        assert_eq!(snapshot.instances.len(), 2);
        assert!(snapshot.instances.iter().any(|instance| instance.game_folder == first_text));
        assert!(snapshot.instances.iter().any(|instance| instance.game_folder == second_text));
        let active = active_folder_instances(&snapshot);
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].game_folder, first_text);
        set_active_game_folder_inner(&state, &second_text).unwrap();
        let active = active_folder_instances(&state.snapshot().unwrap());
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].game_folder, second_text);
    }

    #[test]
    fn the_active_game_folder_refuses_a_path_that_is_not_configured() {
        let (_holder, root, state) = version_fixture();
        let other = root.parent().unwrap().join("other-game");
        std::fs::create_dir_all(&other).unwrap();
        state.update(|data| {
            data.config.game_folders.push(crate::models::GameFolder {
                path: other.to_string_lossy().into_owned(),
                label: "Other".into(),
                active: false,
            });
            Ok(())
        }).unwrap();
        let saved = set_active_game_folder_inner(&state, &other.to_string_lossy()).unwrap();
        assert_eq!(
            crate::processes::configured_game_root(Path::new(&saved.game_directory)).unwrap(),
            crate::processes::configured_game_root(&other).unwrap()
        );
        let other_text = other.to_string_lossy().into_owned();
        assert!(saved.game_folders.iter().any(|folder| folder.active && folder.path == other_text));
        let error = set_active_game_folder_inner(&state, "E:/not-configured").unwrap_err();
        assert_eq!(crate::errors::expected(error).code, "gameFolder.notFound");
    }

    #[test]
    fn n4_a_vanilla_named_create_does_not_hide_the_users_existing_instance() {
        let (_holder, root, state) = version_fixture();
        crate::instances::sync_version_instances(&state).unwrap();
        let before = state.snapshot().unwrap();
        let base = before
            .instances
            .iter()
            .find(|instance| instance.version_id == "1.21.1")
            .unwrap()
            .clone();
        let base_isolated = base.isolated;
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let install = async { Ok::<_, String>(("1.21.1".into(), "1.21.1".into(), String::new())) };
        let named = runtime
            .block_on(create_game_instance_with(
                &state,
                Some("Survival".into()),
                "1.21.1".into(),
                "vanilla".into(),
                install,
            ))
            .unwrap();
        assert_eq!(named.derived_from, None, "the pre-existing base is not hidden");
        crate::instances::sync_version_instances(&state).unwrap();
        let visible = active_folder_instances(&state.snapshot().unwrap());
        assert!(visible.iter().any(|instance| instance.id == base.id), "the user's 1.21.1 stays visible");
        assert!(visible.iter().any(|instance| instance.id == named.id));

        // Typing the existing official folder name is refused before install
        // and never rewrites the shared record to isolated.
        let installed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = installed.clone();
        let install = async move {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, String>(("1.21.1".into(), "1.21.1".into(), String::new()))
        };
        let error = runtime
            .block_on(create_game_instance_with(
                &state,
                Some("1.21.1".into()),
                "1.21.1".into(),
                "vanilla".into(),
                install,
            ))
            .unwrap_err();
        assert_eq!(crate::errors::expected(error).code, "instance.folderNameTaken");
        assert!(!installed.load(std::sync::atomic::Ordering::SeqCst), "nothing was installed");
        let after = state.snapshot().unwrap();
        let base_after = after.instances.iter().find(|instance| instance.id == base.id).unwrap();
        assert_eq!(base_after.isolated, base_isolated, "the existing instance was not silently re-isolated");
        assert!(root.join("versions/1.21.1").is_dir());
    }

    #[test]
    fn n4_deleting_a_named_instance_reveals_the_loader_parent_it_hid() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "fabric-loader-0.16.9-1.21.1", false, json!({
            "id": "fabric-loader-0.16.9-1.21.1", "inheritsFrom": "1.21.1",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "launcherMetadata": { "loader": "fabric", "loaderVersion": "0.16.9" },
            "libraries": [{ "name": "net.fabricmc:fabric-loader:0.16.9" }]
        }));
        crate::instances::sync_version_instances(&state).unwrap();
        let parent = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "fabric-loader-0.16.9-1.21.1")
            .unwrap()
            .clone();
        // Promoting an already existing profile does not create its parent and
        // therefore must not hide it.
        let promoted = create_instance_from_version_inner(
            &state,
            Some("Survival".into()),
            "fabric-loader-0.16.9-1.21.1".into(),
        )
        .unwrap();
        assert_eq!(promoted.derived_from, None);
        crate::instances::sync_version_instances(&state).unwrap();
        assert!(active_folder_instances(&state.snapshot().unwrap())
            .iter()
            .any(|instance| instance.id == parent.id), "the existing loader folder stays visible");

        // A loader installed by a new create call is created by that call and
        // may be hidden behind the named instance.
        let install_root = root.clone();
        let install = async move {
            write_test_version(&install_root, "fabric-loader-0.18.0-1.21.1", false, json!({
                "id": "fabric-loader-0.18.0-1.21.1", "inheritsFrom": "1.21.1",
                "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
                "launcherMetadata": { "loader": "fabric", "loaderVersion": "0.18.0" },
                "libraries": [{ "name": "net.fabricmc:fabric-loader:0.18.0" }]
            }));
            assert!(install_root
                .join("versions/fabric-loader-0.18.0-1.21.1/fabric-loader-0.18.0-1.21.1.json")
                .is_file());
            Ok::<_, String>((
                "1.21.1".into(),
                "fabric-loader-0.18.0-1.21.1".into(),
                "0.18.0".into(),
            ))
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let child = runtime
            .block_on(create_game_instance_with(
                &state,
                Some("New Survival".into()),
                "1.21.1".into(),
                "fabric".into(),
                install,
            ))
            .unwrap();
        assert_eq!(child.derived_from.as_deref(), Some("fabric-loader-0.18.0-1.21.1"));
        crate::instances::sync_version_instances(&state).unwrap();
        assert!(!active_folder_instances(&state.snapshot().unwrap())
            .iter()
            .any(|instance| instance.version_id == "fabric-loader-0.18.0-1.21.1"));
        delete_instance_inner(&state, &child.id, true, true).unwrap();
        let after = state.snapshot().unwrap();
        assert!(crate::instances::visible_instances(&after).iter().any(|instance| {
            instance.version_id == "fabric-loader-0.18.0-1.21.1" && !instance.hidden
        }), "deleting the child reveals its parent");
    }

    #[test]
    fn n7_copying_a_complete_merged_profile_keeps_each_argument_once() {
        let (_holder, root, state) = version_fixture();
        let source_dir = root.join("versions/Merged");
        std::fs::create_dir_all(&source_dir).unwrap();
        let merged = json!({
            "id": "Merged", "jar": "Merged",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries": [{ "name": "net.fabricmc:fabric-loader:0.16.9" }],
            "arguments": { "game": [
                "--username", "${auth_player_name}",
                "--uuid", "${auth_uuid}",
                "--accessToken", "${auth_access_token}"
            ]}
        });
        std::fs::write(source_dir.join("Merged.json"), merged.to_string()).unwrap();
        std::fs::write(source_dir.join("Merged.jar"), b"merged client").unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let source = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "Merged")
            .unwrap()
            .clone();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let copied = runtime
            .block_on(copy_instance_inner(&state, &source.id, Some("Merged Copy")))
            .unwrap();
        let profile: Value = serde_json::from_slice(
            &std::fs::read(root.join("versions/Merged Copy/Merged Copy.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(profile["id"], "Merged Copy");
        assert_eq!(profile["jar"], "Merged Copy", "the copied jar is renamed");
        assert!(profile.get("inheritsFrom").is_none(), "a complete profile is not made to inherit");
        let arguments: Vec<_> = profile["arguments"]["game"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(arguments.iter().filter(|value| **value == "--username").count(), 1);
        assert_eq!(arguments.iter().filter(|value| **value == "--accessToken").count(), 1);
        assert_eq!(copied.version_id, "Merged Copy");

        // The source folder can never become the copy's base through jar or id.
        let source_instance = Instance {
            version_id: "Merged".into(),
            ..Instance::default()
        };
        assert_eq!(
            copy_profile_base(&root, &source_instance, "Merged Copy", &merged).unwrap_err(),
            crate::instances::BASE_VERSION_UNKNOWN
        );
    }

    #[test]
    fn n9_copy_refuses_an_official_name() {
        let (_holder, root, state) = version_fixture();
        let source_dir = root.join("versions/Copy Source");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::write(source_dir.join("Copy Source.json"), json!({
            "id": "Copy Source", "inheritsFrom": "1.21.1",
            "mainClass": "net.minecraft.client.main.Main", "libraries": []
        }).to_string()).unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let source = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "Copy Source")
            .unwrap()
            .clone();
        let manifest = json!({
            "latest": { "release": "1.19.4", "snapshot": "1.19.4" },
            "versions": [{
                "id": "1.19.4", "type": "release",
                "url": "https://piston-meta.mojang.com/v1/packages/a/1.19.4.json",
                "sha1": "a".repeat(40)
            }]
        });
        std::fs::write(state.data_dir.join("version-manifest-mojang.json"), manifest.to_string()).unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let error = runtime
            .block_on(copy_instance_inner(&state, &source.id, Some("1.19.4")))
            .unwrap_err();
        assert_eq!(crate::errors::expected(error).code, "instance.officialVersionName");
        assert!(!root.join("versions/1.19.4").exists());
    }

    #[test]
    fn n8_a_failed_copy_stage_is_never_published() {
        let (_holder, root, state) = version_fixture();
        let source_dir = root.join("versions/Source");
        std::fs::create_dir_all(source_dir.join("mods")).unwrap();
        std::fs::write(source_dir.join("Source.json"), json!({
            "id": "Source", "inheritsFrom": "1.21.1",
            "mainClass": "net.minecraft.client.main.Main", "libraries": []
        }).to_string()).unwrap();
        std::fs::write(source_dir.join("mods/a.jar"), b"a mod").unwrap();
        crate::instances::sync_version_instances(&state).unwrap();
        let source = state
            .snapshot()
            .unwrap()
            .instances
            .iter()
            .find(|instance| instance.version_id == "Source")
            .unwrap()
            .clone();
        set_copy_stage_hook(
            "Incomplete Copy",
            Some(Box::new(|stage: &Path| {
                let _ = std::fs::remove_dir_all(stage.join("mods"));
            })),
        );
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let error = runtime
            .block_on(copy_instance_inner(&state, &source.id, Some("Incomplete Copy")))
            .unwrap_err();
        assert!(error.contains("缺少文件"), "{error}");
        assert!(!root.join("versions/Incomplete Copy").exists(), "nothing was published");
        set_copy_stage_hook("Incomplete Copy", None);
    }

    #[test]
    fn n3_a_path_without_a_recycle_bin_is_refused_before_deleting() {
        use std::sync::{Arc, Mutex};
        let (_holder, root, state) = version_fixture();
        crate::instances::sync_version_instances(&state).unwrap();
        let id = state.snapshot().unwrap().instances[0].id.clone();
        let seen = Arc::new(Mutex::new(false));
        let recorded = seen.clone();
        set_recycle_support_hook(Some(Box::new(move |_path: &Path| {
            *recorded.lock().unwrap() = true;
            Err(RECYCLE_NETWORK_SHARE.into())
        })));
        let error = crate::errors::expected(
            delete_instance_inner(&state, &id, true, false).unwrap_err(),
        );
        assert_eq!(error.code, "instance.recycleUnavailable");
        assert_eq!(error.params["reason"], RECYCLE_NETWORK_SHARE);
        assert!(*seen.lock().unwrap());
        assert!(root.join("versions/1.21.1").is_dir());
        assert_eq!(state.snapshot().unwrap().instances.len(), 1);
        set_recycle_support_hook(None);
        set_recycle_hook(None);
    }

    #[test]
    fn n3_recycle_flags_include_the_warning_and_error_ui_and_long_paths_are_extended() {
        #[cfg(all(windows, not(target_pointer_width = "32")))]
        {
            let flags = recycle_flags();
            assert_eq!(flags & 0x4000, 0x4000, "FOF_WANTNUKEWARNING");
            assert_eq!(flags & 0x0400, 0x0400, "FOF_NOERRORUI");
            assert_eq!(flags & 0x0040, 0x0040, "FOF_ALLOWUNDO");
        }
    }

    #[cfg(windows)]
    fn shell_text(wide: &[u16]) -> String {
        assert_eq!(&wide[wide.len() - 2..], [0, 0], "the list is double-NUL terminated");
        String::from_utf16(&wide[..wide.len() - 2]).unwrap()
    }

    #[test]
    #[cfg(windows)]
    fn h1_the_shell_gets_a_plain_path_and_never_a_verbatim_or_too_long_one() {
        // A verbatim path (what canonicalize returns) loses its prefix: the
        // shell namespace cannot parse `\\?\`.
        let verbatim = recycle_shell_path(Path::new(r"\\?\C:\Games\.minecraft\versions\Pack")).unwrap();
        assert_eq!(shell_text(&verbatim), r"C:\Games\.minecraft\versions\Pack");
        // A plain path is passed unchanged, with forward slashes and a
        // trailing separator normalized.
        let plain = recycle_shell_path(Path::new(r"D:\mc\versions\1.21.1")).unwrap();
        assert_eq!(shell_text(&plain), r"D:\mc\versions\1.21.1");
        let slashes = recycle_shell_path(Path::new("D:/mc/versions/Pack/")).unwrap();
        assert_eq!(shell_text(&slashes), r"D:\mc\versions\Pack");
        // MAX_PATH counts the NUL: 259 characters fit, 260 do not.
        let fits = format!(r"C:\{}", "a".repeat(256));
        assert_eq!(fits.len(), 259);
        assert_eq!(shell_text(&recycle_shell_path(Path::new(&fits)).unwrap()), fits);
        let long = format!(r"C:\{}", "a".repeat(257));
        assert_eq!(recycle_shell_path(Path::new(&long)), Err(RECYCLE_PATH_TOO_LONG));
        let long_verbatim = format!(r"\\?\C:\{}", "b".repeat(300));
        assert_eq!(recycle_shell_path(Path::new(&long_verbatim)), Err(RECYCLE_PATH_TOO_LONG));
        // Shares and names a plain path would misread are refused, never
        // rewritten into another file.
        assert_eq!(
            recycle_shell_path(Path::new(r"\\server\share\versions\Pack")),
            Err(RECYCLE_NETWORK_SHARE)
        );
        assert_eq!(
            recycle_shell_path(Path::new(r"\\?\UNC\server\share\versions\Pack")),
            Err(RECYCLE_NETWORK_SHARE)
        );
        assert_eq!(
            recycle_shell_path(Path::new(r"\\?\C:\Games\versions\Pack.")),
            Err(RECYCLE_UNSUPPORTED_PATH)
        );
        // The same names in a plain spelling: the shell would silently drop
        // the dot or resolve the parent and recycle another folder.
        for misread in [
            r"C:\Games\versions\Pack.",
            r"C:\Games\versions\Pack ",
            r"C:\Games\..\versions\Pack",
            r"C:\Games\versions\CON",
        ] {
            assert_eq!(recycle_shell_path(Path::new(misread)), Err(RECYCLE_UNSUPPORTED_PATH), "{misread}");
        }
        assert_eq!(recycle_shell_path(Path::new(r"versions\Pack")), Err(RECYCLE_UNSUPPORTED_PATH));
    }

    #[test]
    #[cfg(windows)]
    fn h1_a_version_folder_too_long_for_the_shell_is_refused_and_kept() {
        // The real delete flow, without any recycle stub: the drive check
        // runs against the real fixed drive, and the path check refuses the
        // folder before the shell is called.
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/version-model-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let root = holder.path().join("g".repeat(200));
        std::fs::create_dir_all(&root).unwrap();
        write_test_version(&root, "1.21.1", true, json!({
            "id": "1.21.1", "type": "release", "mainClass": "net.minecraft.client.main.Main"
        }));
        let mut config = Config {
            game_directory: root.to_string_lossy().into_owned(),
            ..Config::default()
        };
        config.normalize_game_folders();
        let state = LauncherState::test_fixture(
            holder.path().join("data"),
            Persisted { config, ..Default::default() },
            crate::storage::test_client(),
        );
        crate::instances::sync_version_instances(&state).unwrap();
        let id = state.snapshot().unwrap().instances[0].id.clone();
        let error = crate::errors::expected(
            delete_instance_inner(&state, &id, true, false).unwrap_err(),
        );
        assert_eq!(error.code, "instance.recycleUnavailable");
        assert_eq!(error.params["reason"], RECYCLE_PATH_TOO_LONG);
        assert!(root.join("versions/1.21.1/1.21.1.json").is_file(), "nothing was deleted");
        assert_eq!(state.snapshot().unwrap().instances.len(), 1, "the record stays");
        // The separately confirmed permanent delete still works for it.
        delete_instance_inner(&state, &id, true, true).unwrap();
        assert!(!root.join("versions/1.21.1").exists());
    }

    #[test]
    #[cfg(all(windows, not(target_pointer_width = "32")))]
    fn l4_a_removable_drive_is_refused_before_the_shell_could_ask() {
        // The real support check with a reported drive type: removable media
        // have no Recycle Bin, so nothing reaches the shell or its dialog.
        let (_holder, root, state) = version_fixture();
        crate::instances::sync_version_instances(&state).unwrap();
        let id = state.snapshot().unwrap().instances[0].id.clone();
        for (kind, reason) in [
            (DRIVE_REMOVABLE, RECYCLE_NO_BIN),
            (DRIVE_REMOTE, RECYCLE_NETWORK_SHARE),
            (5, RECYCLE_NO_BIN),
            (0, RECYCLE_UNKNOWN_DRIVE),
        ] {
            set_drive_type_hook(Some(kind));
            let error = crate::errors::expected(
                delete_instance_inner(&state, &id, true, false).unwrap_err(),
            );
            set_drive_type_hook(None);
            assert_eq!(error.code, "instance.recycleUnavailable", "drive type {kind}");
            assert_eq!(error.params["reason"], reason, "drive type {kind}");
            assert!(root.join("versions/1.21.1").is_dir());
        }
        assert_eq!(recycle_drive_verdict(DRIVE_FIXED), Ok(()));
        assert_eq!(state.snapshot().unwrap().instances.len(), 1);
    }

    #[test]
    fn l4_the_launcher_window_owns_the_recycle_call() {
        use std::sync::{Arc, Mutex};
        let (_holder, _root, state) = version_fixture();
        crate::instances::sync_version_instances(&state).unwrap();
        let id = state.snapshot().unwrap().instances[0].id.clone();
        let seen = Arc::new(Mutex::new(None));
        let recorded = seen.clone();
        set_recycle_hook(Some(Box::new(move |_path: &Path, owner: Option<isize>| {
            *recorded.lock().unwrap() = Some(owner);
            Ok(())
        })));
        delete_instance_with_owner(&state, &id, true, false, Some(0x1234)).unwrap();
        set_recycle_hook(None);
        assert_eq!(*seen.lock().unwrap(), Some(Some(0x1234)), "the window handle reaches the shell call");
    }

    #[test]
    fn l6_an_unusable_game_folder_is_reported_with_a_reason_code() {
        let (_holder, root, state) = version_fixture();
        let mut config = state.snapshot().unwrap().config;
        // A hand-edited list can hold a path the launcher cannot use.
        config.game_folders.push(GameFolder {
            path: r"relative\.minecraft".into(),
            label: String::new(),
            active: false,
        });
        let error = expected(game_folder_to_open(&config, r"relative\.minecraft").unwrap_err());
        assert_eq!(error.code, "gameFolder.unavailable");
        assert_eq!(error.params["reason"], crate::errors::GAME_FOLDER_INVALID_PATH);
        assert_eq!(
            expected(game_folder_to_open(&config, r"D:\Unlisted").unwrap_err()).code,
            "gameFolder.notFound"
        );
        let opened = game_folder_to_open(&config, &root.to_string_lossy()).unwrap();
        assert!(opened.is_dir());
    }

    #[test]
    fn l6_recycle_failures_carry_reason_codes_not_text() {
        use std::sync::{Arc, Mutex};
        let (_holder, root, state) = version_fixture();
        crate::instances::sync_version_instances(&state).unwrap();
        let id = state.snapshot().unwrap().instances[0].id.clone();
        // A shell failure keeps its numeric code as a parameter.
        let calls = Arc::new(Mutex::new(0));
        let counted = calls.clone();
        set_recycle_hook(Some(Box::new(move |_: &Path, _: Option<isize>| {
            *counted.lock().unwrap() += 1;
            Err(format!(
                "{}{RECYCLE_SHELL_ERROR}:0x7C",
                crate::errors::INSTANCE_RECYCLE_FAILED_PREFIX
            ))
        })));
        let error = crate::errors::expected(
            delete_instance_inner(&state, &id, true, false).unwrap_err(),
        );
        set_recycle_hook(None);
        assert_eq!(*calls.lock().unwrap(), 1);
        assert_eq!(error.code, "instance.recycleFailed");
        assert_eq!(error.params["reason"], RECYCLE_SHELL_ERROR);
        assert_eq!(error.params["code"], "0x7C");
        assert!(root.join("versions/1.21.1").is_dir());
        // A refusal reason is a code, never a sentence in one language.
        set_drive_type_hook(Some(DRIVE_REMOVABLE));
        let refused = crate::errors::expected(
            delete_instance_inner(&state, &id, true, false).unwrap_err(),
        );
        set_drive_type_hook(None);
        let reason = refused.params["reason"].as_str().unwrap().to_owned();
        assert!(reason.chars().all(|c| c.is_ascii_alphanumeric()), "{reason}");
    }

    /// Sends one real, tiny temporary folder to this machine's Recycle Bin
    /// through the shell. Run it by hand: it leaves the probe folder in the
    /// Recycle Bin. `VOXELIGHT_RECYCLE_PROBE_DIR` picks the (fixed-drive)
    /// folder it is created in when the system temp folder is not writable.
    #[test]
    #[ignore = "moves a real temporary folder to the Recycle Bin"]
    #[cfg(all(windows, not(target_pointer_width = "32")))]
    fn h1_recycle_probe_moves_a_real_folder_to_the_recycle_bin() {
        let parent = std::env::var_os("VOXELIGHT_RECYCLE_PROBE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let probe = parent.join(format!("voxelight-recycle-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(probe.join("saves")).unwrap();
        std::fs::write(probe.join("probe.txt"), b"voxelight recycle probe").unwrap();
        // Hand the shell the canonical, verbatim spelling on purpose: the
        // path conversion must strip it for the call to succeed.
        let verbatim = probe.canonicalize().unwrap();
        assert!(verbatim.to_string_lossy().starts_with(r"\\?\"), "{}", verbatim.display());
        recycle_path(&verbatim, None).unwrap();
        assert!(!probe.exists(), "the probe folder left its location");
        eprintln!("recycled {}", probe.display());
    }

    #[test]
    fn n10_legacy_managed_instances_count_as_folder_dependants_and_running_games() {
        let (_holder, root, state) = version_fixture();
        crate::instances::sync_version_instances(&state).unwrap();
        let base = state.snapshot().unwrap().instances[0].clone();
        let managed_dir = root.join("instances/legacy");
        state
            .update(|data| {
                data.instances.push(Instance {
                    id: "legacy".into(),
                    name: "Legacy Pack".into(),
                    version_id: "1.21.1".into(),
                    game_directory: managed_dir.to_string_lossy().into_owned(),
                    kind: "managed".into(),
                    loader: "vanilla".into(),
                    ..Default::default()
                });
                Ok(())
            })
            .unwrap();
        assert_eq!(
            list_instance_dependants_inner(&state, &base.id).unwrap(),
            ["Legacy Pack"]
        );
        let error = crate::errors::expected(
            delete_instance_inner(&state, &base.id, true, true).unwrap_err(),
        );
        assert_eq!(error.code, "instance.deleteDependants");
        assert_eq!(error.params["instances"], "Legacy Pack");
        assert!(root.join("versions/1.21.1").is_dir());

        state
            .games
            .fixture_running_directory(&managed_dir, Some("legacy"));
        let running = crate::errors::expected(
            delete_instance_inner(&state, &base.id, true, true).unwrap_err(),
        );
        assert_eq!(running.code, "instance.running");
    }

    #[test]
    fn low_world_copy_leftovers_are_cleaned_only_inside_their_version_folder() {
        let (_holder, root, state) = version_fixture();
        let own = root.join("versions/1.21.1/saves/.voxelight-world-crashed");
        let shared = root.join("saves/.voxelight-world-shared");
        let unrelated = root.join("versions/1.21.1/.voxelight-world-kept");
        for path in [&own, &shared, &unrelated] {
            std::fs::create_dir_all(path).unwrap();
        }
        let profile_backup = root.join("versions/1.21.1/1.21.1.json.backup-00000000-0000-4000-8000-000000000000");
        let not_ours = root.join("versions/1.21.1/notes.json.backup-user");
        std::fs::write(&profile_backup, b"old profile copy").unwrap();
        std::fs::write(&not_ours, b"user file").unwrap();
        let _guard = state.operation.try_lock().unwrap();
        cleanup_stale_world_copies(&state);
        cleanup_stale_profile_backups(&state);
        assert!(!own.exists(), "the interrupted own-folder copy is removed");
        assert!(shared.exists(), "the shared root is never touched");
        assert!(unrelated.exists(), "only the saves folder is a world-copy target");
        assert!(!profile_backup.exists(), "a launcher profile backup never stays in versions/");
        assert!(not_ours.exists(), "an unrecognized file is not ours to remove");
        // L2: it may be the only copy of an overwritten profile, so it moved
        // to the data folder instead of being deleted.
        let kept = state
            .data_dir
            .join(PROFILE_BACKUP_FOLDER)
            .join("1.21.1-00000000-0000-4000-8000-000000000000.json");
        assert_eq!(std::fs::read(kept).unwrap(), b"old profile copy");
    }

    #[test]
    fn low_creating_a_folder_from_an_installed_profile_allows_other_running_games() {
        let (_holder, root, state) = version_fixture();
        write_test_version(&root, "1.20.1", true, json!({
            "id": "1.20.1", "mainClass": "net.minecraft.client.main.Main"
        }));
        state
            .games
            .fixture_running_directory(&root, Some("another-instance"));
        let created = create_instance_inner(
            &state,
            "New From Running Root".into(),
            "1.20.1".into(),
        )
        .unwrap();
        assert_eq!(created.version_id, "New From Running Root");
        assert!(root.join("versions/New From Running Root/New From Running Root.json").is_file());
    }
}
