use crate::models::*;
use serde_json::Value;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

fn select_data_directory(
    dedicated: Option<PathBuf>,
    legacy: Option<PathBuf>,
    local: Option<PathBuf>,
) -> Result<PathBuf, String> {
    dedicated
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| legacy.filter(|path| !path.as_os_str().is_empty()))
        .or_else(|| local.map(|path| path.join("dev.voxelight.launcher")))
        .ok_or_else(|| "无法定位用户数据目录".into())
}

fn select_game_directory(dedicated: Option<String>, legacy: Option<String>) -> Option<String> {
    dedicated
        .filter(|path| !path.trim().is_empty())
        .or_else(|| legacy.filter(|path| !path.trim().is_empty()))
}

pub(crate) fn data_directory() -> Result<PathBuf, String> {
    select_data_directory(
        std::env::var_os("VOXELIGHT_LAUNCHER_DATA_DIR").map(PathBuf::from),
        std::env::var_os("MINECRAFT_LAUNCHER_DATA_DIR").map(PathBuf::from),
        dirs::data_local_dir(),
    )
}

fn select_fallback_data_directory(local: Option<PathBuf>) -> Result<PathBuf, String> {
    local
        .map(|path| path.join("dev.voxelight.launcher-fallback"))
        .ok_or_else(|| "无法定位用户数据回退目录".into())
}

fn fallback_data_directory() -> Result<PathBuf, String> {
    select_fallback_data_directory(dirs::data_local_dir())
}

fn startup_error(message: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::other(message))
}

pub(crate) fn migrate_state_json(mut value: Value) -> Result<Value, String> {
    let version = value
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if version > CURRENT_SCHEMA_VERSION as u64 {
        return Err("配置来自更新版本的 Voxelight，请先升级启动器".into());
    }
    let root = value
        .as_object_mut()
        .ok_or_else(|| "配置根节点必须是对象".to_string())?;
    {
        let config = root
            .entry("config")
            .or_insert_with(|| Value::Object(Default::default()))
            .as_object_mut()
            .ok_or_else(|| "config 必须是对象".to_string())?;
        config
            .entry("effects")
            .or_insert_with(|| Value::String("full".into()));
        if !config.contains_key("accentSource") {
            let branded = config
                .get("accentColor")
                .and_then(Value::as_str)
                .is_some_and(|color| color.eq_ignore_ascii_case("#b4f17a"));
            config.insert(
                "accentSource".into(),
                Value::String(if branded { "system" } else { "custom" }.into()),
            );
        }
        config
            .entry("language")
            .or_insert_with(|| Value::String("system".into()));
        config
            .entry("soundEnabled")
            .or_insert_with(|| Value::Bool(false));
        if config.get("defaultSkin").and_then(Value::as_str) == Some("lumen") {
            config.insert("defaultSkin".into(), Value::String("steve".into()));
        }
    }
    root.insert(
        "schemaVersion".into(),
        Value::from(CURRENT_SCHEMA_VERSION as u64),
    );
    Ok(value)
}

pub struct LauncherState {
    pub data: Mutex<Persisted>,
    pub data_dir: PathBuf,
    pub client: reqwest::Client,
    pub operation: tokio::sync::Mutex<()>,
    pub control: crate::downloads::DownloadControl,
    pub games: Arc<crate::processes::GameRegistry>,
}

impl LauncherState {
    pub fn load() -> Result<Self, Box<dyn std::error::Error>> {
        Self::load_with_fallback(data_directory(), fallback_data_directory)
    }

    fn load_with_fallback<F>(
        primary_directory: Result<PathBuf, String>,
        fallback_directory: F,
    ) -> Result<Self, Box<dyn std::error::Error>>
    where
        F: FnOnce() -> Result<PathBuf, String>,
    {
        let primary_error = match primary_directory {
            Ok(directory) => {
                eprintln!(
                    "[voxelight/storage] loading primary state from {}",
                    directory.display()
                );
                match Self::load_from(directory.clone()) {
                    Ok(state) => return Ok(state),
                    Err(error) => {
                        eprintln!(
                            "[voxelight/storage] primary state at {} failed: {error}",
                            directory.display()
                        );
                        error
                    }
                }
            }
            Err(error) => {
                eprintln!("[voxelight/storage] primary data directory unavailable: {error}");
                startup_error(error)
            }
        };

        let fallback_directory = fallback_directory().map_err(startup_error)?;
        eprintln!(
            "[voxelight/storage] falling back to {}",
            fallback_directory.display()
        );
        Self::load_from(fallback_directory.clone()).map_err(|fallback_error| {
            startup_error(format!(
                "启动器数据目录不可用。primary: {primary_error}; fallback {}: {fallback_error}",
                fallback_directory.display()
            ))
        })
    }

    fn load_from(data_dir: PathBuf) -> Result<Self, Box<dyn std::error::Error>> {
        fs::create_dir_all(&data_dir)?;
        let file = data_dir.join("state.json");
        let mut data: Persisted = match fs::read(&file) {
            Ok(bytes) => {
                let raw = serde_json::from_slice(&bytes)?;
                serde_json::from_value(migrate_state_json(raw)?)?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Persisted::default(),
            Err(error) => return Err(error.into()),
        };
        if let Some(directory) = select_game_directory(
            std::env::var("VOXELIGHT_LAUNCHER_GAME_DIR").ok(),
            std::env::var("MINECRAFT_LAUNCHER_GAME_DIR").ok(),
        ) {
            data.config.game_directory = directory;
        }
        let client = reqwest::Client::builder()
            .user_agent("VoxelightLauncher/0.5.0")
            .connect_timeout(std::time::Duration::from_secs(20))
            .timeout(std::time::Duration::from_secs(180))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    attempt.error("too many redirects")
                } else if attempt.previous().first().is_some_and(|original| {
                    trusted_client_redirect(attempt.url().as_str(), original.as_str()).is_ok()
                }) {
                    attempt.follow()
                } else {
                    attempt.error("untrusted download redirect")
                }
            }))
            .build()?;
        let control = crate::downloads::DownloadControl::load(
            data_dir.clone(),
            data.config.download_limit_kib,
        )?;
        let state = Self {
            data: Mutex::new(data),
            data_dir,
            client,
            operation: tokio::sync::Mutex::new(()),
            control,
            games: Default::default(),
        };
        state.save()?;
        Ok(state)
    }

    pub fn snapshot(&self) -> Result<Persisted, String> {
        self.data
            .lock()
            .map(|data| data.clone())
            .map_err(|_| "配置锁异常".into())
    }

    pub fn save(&self) -> Result<(), String> {
        let data = self.data.lock().map_err(|_| "配置锁异常")?;
        self.write(&data)
    }

    pub fn update<T>(
        &self,
        action: impl FnOnce(&mut Persisted) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut data = self.data.lock().map_err(|_| "配置锁异常")?;
        let mut next = data.clone();
        let result = action(&mut next)?;
        self.write(&next)?;
        *data = next;
        Ok(result)
    }

    fn write(&self, data: &Persisted) -> Result<(), String> {
        let temp = self
            .data_dir
            .join(format!("state-{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        fs::rename(temp, self.data_dir.join("state.json")).map_err(|e| format!("保存配置失败：{e}"))
    }
}

pub fn valid_username(name: &str) -> bool {
    (3..=16).contains(&name.len()) && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

pub fn offline_uuid(username: &str) -> String {
    let mut bytes = md5::compute(format!("OfflinePlayer:{username}")).0;
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).simple().to_string()
}

pub fn validate_id(id: &str) -> Result<(), String> {
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if id.is_empty()
        || id.len() > 160
        || id == "."
        || id == ".."
        || id.ends_with(['.', ' '])
        || id
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || reserved.contains(
            &id.split('.')
                .next()
                .unwrap_or("")
                .to_ascii_uppercase()
                .as_str(),
        )
    {
        return Err("无效的版本或目录标识".into());
    }
    Ok(())
}

pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains('\\') || relative.contains(':') || relative.is_empty() {
        return Err("资源路径不安全".into());
    }
    let path = Path::new(relative);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("资源路径越界".into());
    }
    let mut target = root.to_path_buf();
    for component in path.components() {
        let Component::Normal(value) = component else {
            return Err("资源路径越界".into());
        };
        validate_id(&value.to_string_lossy())?;
        target.push(value);
        if let Ok(metadata) = fs::symlink_metadata(&target) {
            let mut is_link = metadata.file_type().is_symlink();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                is_link |= metadata.file_attributes() & 0x400 != 0;
            }
            if is_link {
                return Err("拒绝通过符号链接或目录联接写入资源".into());
            }
        }
    }
    Ok(target)
}

pub fn runtime_temp_directory(root: &Path) -> Result<PathBuf, String> {
    let directory = safe_join(root, ".launcher-temp")?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建 Java 临时目录 {}：{error}", directory.display()))?;
    Ok(directory)
}

pub fn trusted_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "下载地址格式错误")?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https"
        || parsed.port_or_known_default() != Some(443)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !(["mojang.com", "minecraft.net", "minecraftservices.com"]
            .iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
            || [
                "meta.fabricmc.net",
                "maven.fabricmc.net",
                "meta.quiltmc.org",
                "maven.quiltmc.org",
                "files.minecraftforge.net",
                "maven.minecraftforge.net",
                "maven.neoforged.net",
                "authlib-injector.yushi.moe",
            ]
            .contains(&host)
            || host == "bmclapi2.bangbang93.com")
    {
        return Err("拒绝不受信任的 HTTPS 下载地址".into());
    }
    Ok(())
}

fn trusted_client_redirect(url: &str, original: &str) -> Result<(), String> {
    trusted_url(url)?;
    let target = reqwest::Url::parse(url).map_err(|_| "下载地址格式错误")?;
    let original = reqwest::Url::parse(original).map_err(|_| "下载地址格式错误")?;
    if target.host_str() == Some("bmclapi2.bangbang93.com")
        && original.host_str() != Some("bmclapi2.bangbang93.com")
    {
        return Err("官方请求不得重定向到镜像".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn test_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("test HTTP client without proxy")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voxelight_data_directory_prefers_dedicated_override_and_never_uses_old_product_folder() {
        let local = PathBuf::from(r"C:\Users\Test\AppData\Local");
        let dedicated = PathBuf::from(r"D:\VoxelightData");
        let legacy = PathBuf::from(r"D:\LegacyData");
        assert_eq!(
            select_data_directory(
                Some(dedicated.clone()),
                Some(legacy.clone()),
                Some(local.clone())
            )
            .unwrap(),
            dedicated
        );
        assert_eq!(
            select_data_directory(None, Some(legacy.clone()), Some(local.clone())).unwrap(),
            legacy
        );
        assert_eq!(
            select_data_directory(None, None, Some(local.clone())).unwrap(),
            local.join("dev.voxelight.launcher")
        );
        assert!(select_data_directory(None, None, None).is_err());
    }

    #[test]
    fn voxelight_storage_fallback_has_an_independent_product_directory() {
        let local = PathBuf::from(r"C:\Users\Test\AppData\Local");
        assert_eq!(
            select_fallback_data_directory(Some(local.clone())).unwrap(),
            local.join("dev.voxelight.launcher-fallback")
        );
        assert!(select_fallback_data_directory(None).is_err());
    }

    #[test]
    fn voxelight_game_directory_prefers_dedicated_override() {
        assert_eq!(
            select_game_directory(
                Some("D:/VoxelightGame".into()),
                Some("D:/LegacyGame".into())
            )
            .as_deref(),
            Some("D:/VoxelightGame")
        );
        assert_eq!(
            select_game_directory(None, Some("D:/LegacyGame".into())).as_deref(),
            Some("D:/LegacyGame")
        );
        assert_eq!(select_game_directory(None, None), None);
    }

    #[test]
    fn java_offline_uuid_matches_name_uuid_from_bytes() {
        assert_eq!(offline_uuid("Notch"), "b50ad385829d3141a2167e7d7539ba7f");
    }
    #[test]
    fn paths_and_hosts_reject_traversal_and_windows_devices() {
        let root = Path::new("sandbox");
        for path in [
            "../escape",
            "/absolute",
            "C:/escape",
            "foo\\bar",
            "CON",
            "sub/NUL.txt",
            "foo/../bar",
        ] {
            assert!(safe_join(root, path).is_err(), "{path}");
        }
        assert!(safe_join(root, "libraries/org/lwjgl/3.3.3/test.jar").is_ok());
        assert!(trusted_url("https://libraries.minecraft.net/a.jar").is_ok());
        assert!(trusted_url("https://minecraft.net.evil.example/a.jar").is_err());
        assert!(trusted_url("http://libraries.minecraft.net/a.jar").is_err());
    }

    #[test]
    fn bmclapi_trust_is_limited_to_the_exact_mirror_host() {
        assert!(
            trusted_url("https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json").is_ok()
        );
        assert!(trusted_url("https://bangbang93.com/mc/game/version_manifest_v2.json").is_err());
        assert!(trusted_url(
            "https://evil.bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json"
        )
        .is_err());
        assert!(trusted_url(
            "https://bmclapi2.bangbang93.com.evil.example/mc/game/version_manifest_v2.json"
        )
        .is_err());
        assert!(
            trusted_url("http://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json").is_err()
        );
        assert!(trusted_url(
            "https://user@bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json"
        )
        .is_err());
        assert!(trusted_url(
            "https://bmclapi2.bangbang93.com:444/mc/game/version_manifest_v2.json"
        )
        .is_err());
    }

    #[test]
    fn official_clients_cannot_be_redirected_to_the_mirror() {
        let official = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
        let mirror = "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json";
        assert!(trusted_client_redirect(official, official).is_ok());
        assert!(trusted_client_redirect(mirror, official).is_err());
        assert!(trusted_client_redirect(mirror, mirror).is_ok());
        assert!(trusted_client_redirect(official, mirror).is_ok());
        assert!(trusted_client_redirect("https://evil.example/file", official).is_err());
    }

    #[test]
    fn atomic_state_replace_preserves_existing_target_on_windows() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/core-tests")
            .join(format!("state-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let state = LauncherState {
            data: Mutex::new(Persisted::default()),
            data_dir: directory.clone(),
            client: test_client(),
            operation: tokio::sync::Mutex::new(()),
            control: Default::default(),
            games: Default::default(),
        };
        state.save().unwrap();
        state
            .update(|data| {
                data.config.max_memory_mb = 8192;
                Ok(())
            })
            .unwrap();
        let saved: Persisted =
            serde_json::from_slice(&fs::read(directory.join("state.json")).unwrap()).unwrap();
        assert_eq!(saved.config.max_memory_mb, 8192);
        assert_eq!(state.snapshot().unwrap().config.max_memory_mb, 8192);
        let failed: Result<(), String> = state.update(|data| {
            data.config.max_memory_mb = 512;
            Err("cancelled transaction".into())
        });
        assert!(failed.is_err());
        assert_eq!(state.snapshot().unwrap().config.max_memory_mb, 8192);
        fs::remove_file(directory.join("state.json")).unwrap();
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn unavailable_primary_storage_falls_back_without_panicking() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/core-tests")
            .join(format!("storage-fallback-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let primary = root.join("primary-is-a-file");
        fs::write(&primary, b"not a directory").unwrap();
        let fallback = root.join("fallback");

        let state =
            LauncherState::load_with_fallback(Ok(primary), || Ok(fallback.clone())).unwrap();
        assert_eq!(state.data_dir, fallback);
        assert!(fallback.join("state.json").exists());

        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn visual_config_migration_preserves_existing_data_and_defaults() {
        let mut old = serde_json::to_value(Persisted {
            accounts: vec![Account {
                id: "account".into(),
                ..Default::default()
            }],
            instances: vec![Instance {
                id: "instance".into(),
                ..Default::default()
            }],
            ..Default::default()
        })
        .unwrap();
        old.as_object_mut()
            .unwrap()
            .insert("futureRootSetting".into(), serde_json::json!(true));
        let config = old
            .get_mut("config")
            .and_then(Value::as_object_mut)
            .unwrap();
        config.insert("accentColor".into(), Value::String("#112233".into()));
        for field in ["effects", "accentSource", "language", "soundEnabled"] {
            config.remove(field);
        }
        config.insert("futureVisualSetting".into(), serde_json::json!("kept"));

        let migrated = migrate_state_json(old).unwrap();
        let decoded: Persisted = serde_json::from_value(migrated).unwrap();
        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.config.effects, "full");
        assert_eq!(decoded.config.accent_source, "custom");
        assert_eq!(decoded.config.language, "system");
        assert!(!decoded.config.sound_enabled);
        assert_eq!(decoded.accounts[0].id, "account");
        assert_eq!(decoded.instances[0].id, "instance");

        let mut branded = serde_json::to_value(Persisted::default()).unwrap();
        branded
            .get_mut("config")
            .and_then(Value::as_object_mut)
            .unwrap()
            .remove("accentSource");
        let branded: Persisted =
            serde_json::from_value(migrate_state_json(branded).unwrap()).unwrap();
        assert_eq!(branded.config.accent_source, "system");
    }

    #[test]
    fn legacy_lumen_config_migrates_to_steve_without_losing_user_data() {
        let mut old = serde_json::to_value(Persisted {
            accounts: vec![Account {
                id: "account".into(),
                ..Default::default()
            }],
            instances: vec![Instance {
                id: "instance".into(),
                ..Default::default()
            }],
            ..Default::default()
        })
        .unwrap();
        old["config"]["defaultSkin"] = Value::String("lumen".into());

        let migrated = migrate_state_json(old).unwrap();
        let decoded: Persisted = serde_json::from_value(migrated).unwrap();
        assert_eq!(decoded.config.default_skin, "steve");
        assert_eq!(decoded.accounts[0].id, "account");
        assert_eq!(decoded.instances[0].id, "instance");
    }
}
