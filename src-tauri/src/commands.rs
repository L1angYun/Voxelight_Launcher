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
pub fn bootstrap(state: Shared<'_>) -> Result<Value, String> {
    let data = state.snapshot()?;
    Ok(json!({
        "config": data.config, "accounts": data.accounts, "instances": data.instances,
        "installedVersions": minecraft::scan_versions(&data.config),
        "capabilities": bootstrap_capabilities(builtin_client_id()),
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

#[tauri::command]
pub fn save_config(state: Shared<'_>, config: Config) -> AppResult<Config> {
    save_config_inner(&state, config).map_err(expected)
}

pub(crate) fn save_config_inner(
    state: &LauncherState,
    mut config: Config,
) -> Result<Config, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成后修改配置")?;
    config.game_directory = config.game_directory.trim().to_owned();
    config.java_path = config.java_path.trim().to_owned();
    validate_default_skin(&config.default_skin)?;
    validate_visual_preferences(&config)?;
    if !Path::new(&config.game_directory).is_absolute() {
        return Err("游戏目录必须是绝对路径".into());
    }
    if config.game_directory.contains('\0') || config.java_path.contains('\0') {
        return Err("路径包含非法字符".into());
    }
    if !(512..=65536).contains(&config.max_memory_mb) {
        return Err("最大内存需要在 512–65536 MB 之间".into());
    }
    if !(1..=16).contains(&config.download_concurrency) {
        return Err("下载并发需要在 1–16 之间".into());
    }
    if !["dark", "light", "system"].contains(&config.theme.as_str()) {
        return Err("不支持的主题".into());
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
    if !config.accent_color.starts_with('#')
        || config.accent_color.len() != 7
        || !config.accent_color[1..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err("强调色需要为 #RRGGBB".into());
    }
    state.control.set_limit(config.download_limit_kib);
    state.update(|data| {
        data.config = config.clone();
        Ok(config)
    })
}

fn validate_visual_preferences(config: &Config) -> Result<(), String> {
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
pub fn scan_versions(state: Shared<'_>) -> Result<Vec<InstalledVersion>, String> {
    Ok(minecraft::scan_versions(&state.snapshot()?.config))
}

#[tauri::command]
pub async fn detect_java(state: Shared<'_>) -> Result<Vec<JavaRuntime>, String> {
    Ok(minecraft::detect_java(&state.snapshot()?.config).await)
}

fn installed_loader(config: &Config, version_id: &str) -> (String, String) {
    let loader = crate::resources::version_context(Path::new(&config.game_directory), version_id)
        .ok()
        .and_then(|(_, loader)| loader)
        .unwrap_or_else(|| "vanilla".into());
    let version = safe_join(
        Path::new(&config.game_directory),
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
    let name = name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("实例名需要为 1–80 个可显示字符".into());
    }
    validate_id(&version_id)?;
    let config = state.snapshot()?.config;
    let (loader, loader_version) = installed_loader(&config, &version_id);
    let id = uuid::Uuid::new_v4().to_string();
    let directory = safe_join(
        Path::new(&config.game_directory),
        &format!("instances/{id}"),
    )?;
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
) -> Result<Vec<Account>, String> {
    if state
        .snapshot()?
        .accounts
        .iter()
        .any(|a| a.id == account_id && a.account_type != "offline")
    {
        auth.remove_credentials(&account_id)?;
    }
    state.update(|data| {
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
    })
}

#[tauri::command]
pub async fn install_version(
    app: AppHandle,
    state: Shared<'_>,
    version_id: String,
) -> Result<InstallResult, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行，请等待完成")?;
    let task = state
        .control
        .begin("install", &version_id, &format!("Minecraft {version_id}"));
    let result = minecraft::install(&state, &app, &version_id).await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    match result {
        Ok((result, _)) => Ok(result),
        Err(error) => {
            minecraft::log(&app, &state, "error", &error);
            minecraft::progress(&app, &version_id, "error", 0, 0, 0, 0, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn launch_game(
    app: AppHandle,
    state: Shared<'_>,
    version_id: String,
    instance_id: Option<String>,
    account_id: Option<String>,
    server_address: Option<String>,
) -> AppResult<LaunchResult> {
    let state = state.inner().clone();
    match minecraft::launch(
        state.clone(),
        app.clone(),
        version_id.clone(),
        instance_id,
        account_id,
        server_address,
    )
    .await
    {
        Ok(result) => Ok(result),
        Err(error) => {
            minecraft::log(&app, &state, "error", &error);
            minecraft::progress(&app, &version_id, "error", 0, 0, 0, 0, &error);
            Err(expected(error))
        }
    }
}

#[tauri::command]
pub fn open_folder(
    app: AppHandle,
    state: Shared<'_>,
    kind: String,
    version_id: Option<String>,
) -> Result<(), String> {
    let config = state.snapshot()?.config;
    let root = PathBuf::from(config.game_directory);
    let directory = match kind.as_str() {
        "game" => root,
        "logs" => state.data_dir.join("logs"),
        "instances" => safe_join(&root, "instances")?,
        "version" => {
            let id = version_id.ok_or("未指定版本")?;
            validate_id(&id)?;
            safe_join(&root, &format!("versions/{id}"))?
        }
        _ => return Err("不支持的文件夹类型".into()),
    };
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(directory.to_string_lossy().as_ref(), None::<&str>)
        .map_err(|e| e.to_string())
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
        let state = LauncherState {
            data: std::sync::Mutex::new(Persisted {
                instances: vec![Instance {
                    id: "instance".into(),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            data_dir: directory.clone(),
            client: crate::storage::test_client(),
            operation: tokio::sync::Mutex::new(()),
            control: Default::default(),
            games: Default::default(),
        };
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
