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

#[tauri::command]
pub async fn bootstrap(state: Shared<'_>) -> Result<Value, String> {
    let data = state.snapshot()?;
    let scan_config = data.config.clone();
    let installed_versions = tokio::task::spawn_blocking(move || minecraft::scan_versions(&scan_config))
        .await
        .map_err(|error| format!("扫描本地版本失败：{error}"))?;
    Ok(json!({
        "config": data.config, "accounts": data.accounts, "instances": data.instances,
        "installedVersions": installed_versions,
        "capabilities": bootstrap_capabilities(builtin_client_id()),
        "storage":state.storage_status(),
    }))
}

fn bootstrap_capabilities(builtin: Option<&str>) -> Value {
    let note = if builtin.is_some() {
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
    crate::path_grants::authorize_changed_config_paths(&window, &grants, &previous, &mut config).await?;
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
}

fn save_approved_config_with_scope(state: &LauncherState, mut config: Config, approved_against: Option<&Config>, preserve_appearance: bool) -> Result<Config, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成后修改配置")?;
    config.game_directory = config.game_directory.trim().to_owned();
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
                approved.game_directory == data.config.game_directory && approved.java_path == data.config.java_path
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
        // running update download and clears a check made with another source.
        config.check_for_updates = data.config.check_for_updates;
        config.update_source.clone_from(&data.config.update_source);
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
    if !["system", "zh-CN", "en-US"].contains(&config.language.as_str()) {
        return Err("暂不支持所选界面语言".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn list_versions(state: Shared<'_>) -> Result<Value, String> {
    minecraft::list_versions(&state).await
}

#[tauri::command]
pub async fn scan_versions(state: Shared<'_>) -> Result<Vec<InstalledVersion>, String> {
    let config = state.snapshot()?.config;
    tokio::task::spawn_blocking(move || minecraft::scan_versions(&config))
        .await
        .map_err(|error| format!("扫描本地版本失败：{error}"))
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

pub(crate) fn create_instance_inner(
    state: &LauncherState,
    name: String,
    version_id: String,
) -> Result<Instance, String> {
    let name = validate_instance_name(&name)?;
    validate_id(&version_id)?;
    let config = state.snapshot()?.config;
    let (loader, loader_version) = installed_loader(&config, &version_id);
    let id = uuid::Uuid::new_v4().to_string();
    let root = crate::processes::configured_game_root(Path::new(&config.game_directory))?;
    let directory = crate::instances::checked_absolute(&safe_join(&root, &format!("instances/{id}"))?)?;
    std::fs::create_dir_all(&directory).map_err(|e| format!("创建实例目录失败：{e}"))?;
    let instance = Instance {
        id,
        name,
        version_id,
        game_directory: directory.to_string_lossy().into_owned(),
        created_at: chrono::Utc::now().to_rfc3339(),
        last_played: None,
        category: "normal".into(),
        loader,
        loader_version,
        ..Default::default()
    };
    state.update(|data| {
        data.instances.push(instance.clone());
        Ok(instance)
    })
}

pub(crate) fn validate_instance_name(name: &str) -> Result<String, String> {
    let name = name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("实例名需要为 1–80 个可显示字符".into());
    }
    Ok(name)
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
        if !data.instances.iter().any(|i| i.id == instance_id) {
            return Err("实例不存在".into());
        }
        data.instances.retain(|i| i.id != instance_id);
        // Removing a registration never deletes saves, mods or any instance directory.
        Ok(data.instances.clone())
    })
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
    if !state.games.snapshot()?.is_empty() {
        return Err("有游戏正在运行，请先退出游戏后再还原初始状态。".into());
    }
    if servers.any_running() {
        return Err("有托管服务端正在运行，请先停止服务端后再还原初始状态。".into());
    }
    let snapshot = state.snapshot()?;
    let shared_for_clear = state.clone();
    let old_game_dir = snapshot.config.game_directory.clone();
    tokio::task::spawn_blocking(move || {
        let game_root = crate::processes::configured_game_root(Path::new(&old_game_dir)).ok();
        let stores = crate::parts::startup_stores(&shared_for_clear.data_dir, game_root.as_deref());
        shared_for_clear.control.clear_all_history(&stores)
    })
    .await
    .map_err(|error| error.to_string())??;

    mcp.stop();
    let account_ids: Vec<String> = snapshot
        .accounts
        .iter()
        .map(|account| account.id.clone())
        .collect();
    auth.clear_all_credentials(&account_ids)?;
    crate::secrets::save_service_secret(&state.data_dir, "curseforge", "")?;
    crate::secrets::save_service_secret(
        &state.data_dir,
        crate::assistant::ASSISTANT_SECRET_KEY,
        "",
    )?;
    let _ = crate::network::forget_current_credentials(&state.data_dir, &snapshot.config);

    let fresh = Config::default();
    let saved = state.update(|data| {
        data.config = fresh.clone();
        data.accounts.clear();
        data.instances.clear();
        data.pending_credential_removals.clear();
        data.update_highest_seen = None;
        Ok(data.config.clone())
    })?;
    state.control.set_limit(saved.download_limit_kib);
    state.control.set_concurrency(saved.download_concurrency);
    Ok(saved)
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
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成")?;
    let task = state.control.begin_recorded(
        "install",
        &version_id,
        &format!("Minecraft {version_id}"),
        None,
        crate::downloads::RetryRequest::Install { version_id: version_id.clone() },
    )?;
    let result = minecraft::install(&state, &app, &version_id).await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    match result {
        Ok((result, _)) => Ok(result),
        Err(error) => {
            minecraft::log(&app, &state, "error", &error);
                Err(expected(error))
        }
    }
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
            directory.clone(),
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
        assert_eq!(instance.version_id, "fabric-test");
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
}
