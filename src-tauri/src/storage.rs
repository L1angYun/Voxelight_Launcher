use crate::models::*;
use serde_json::Value;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

fn explicit_data_directory(dedicated: Option<PathBuf>, legacy: Option<PathBuf>) -> Option<PathBuf> {
    dedicated
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| legacy.filter(|path| !path.as_os_str().is_empty()))
}

fn select_data_directory(
    dedicated: Option<PathBuf>,
    legacy: Option<PathBuf>,
    local: Option<PathBuf>,
) -> Result<PathBuf, String> {
    explicit_data_directory(dedicated, legacy)
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
        config
            .entry("worldScene")
            .or_insert_with(|| Value::String("horizon".into()));
        config
            .entry("worldMaterial")
            .or_insert_with(|| Value::String("lattice".into()));
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

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum StorageRecoveryReason {
    Unavailable,
    Corrupt,
    NewerSchema,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageRecovery {
    reason: StorageRecoveryReason,
    primary_directory: Option<String>,
    primary_state_path: Option<String>,
    primary_state_retained: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageStatus {
    active_directory: String,
    recovery: Option<StorageRecovery>,
}

#[derive(Debug)]
pub(crate) enum ProfileLoadError {
    InUse(PathBuf),
    Unavailable(String),
    Corrupt(String),
    NewerSchema(u64),
    Changed,
    FallbackUnavailable {
        primary: Box<Self>,
        directory: PathBuf,
        fallback: Box<Self>,
    },
}

impl ProfileLoadError {
    fn recovery_reason(&self) -> StorageRecoveryReason {
        match self {
            Self::Corrupt(_) => StorageRecoveryReason::Corrupt,
            Self::NewerSchema(_) => StorageRecoveryReason::NewerSchema,
            _ => StorageRecoveryReason::Unavailable,
        }
    }

    pub(crate) fn in_use_detail(&self) -> Option<(&Path, Option<String>)> {
        match self {
            Self::InUse(directory) => Some((directory, None)),
            Self::FallbackUnavailable {
                primary, fallback, ..
            } => fallback
                .in_use_detail()
                .map(|(directory, _)| (directory, Some(primary.to_string()))),
            _ => None,
        }
    }
}

impl std::fmt::Display for ProfileLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InUse(directory) => {
                write!(f, "Profile in use: {}", display_profile_path(directory))
            }
            Self::Unavailable(detail) => f.write_str(detail),
            Self::Corrupt(detail) => write!(f, "配置损坏或不能迁移：{detail}"),
            Self::NewerSchema(version) => write!(
                f,
                "配置来自更新版本的 Voxelight，请先升级启动器（schemaVersion: {version}）"
            ),
            Self::Changed => f.write_str(crate::errors::STORAGE_STATE_CHANGED),
            Self::FallbackUnavailable {
                primary,
                directory,
                fallback,
            } => write!(
                f,
                "启动器数据目录不可用。primary: {primary}; fallback {}: {fallback}",
                directory.display()
            ),
        }
    }
}

impl std::error::Error for ProfileLoadError {}

/// Java and other child processes use ordinary DOS or UNC paths. Keep the
/// canonical form for identity checks, but do not put a verbatim path on a
/// command line or pass it as the child working directory.
pub(crate) fn to_process_path(path: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use std::path::{Component, Prefix};

        if let Some(Component::Prefix(prefix)) = path.components().next() {
            let units = path.as_os_str().encode_wide();
            let ordinary: Vec<u16> = match prefix.kind() {
                Prefix::VerbatimDisk(_) => units.skip(4).collect(),
                Prefix::VerbatimUNC(..) => [b'\\' as u16; 2].into_iter().chain(units.skip(8)).collect(),
                Prefix::Verbatim(_) | Prefix::DeviceNS(_) => {
                    return Err("不能将 Windows 设备路径用作启动器目录或进程参数。".into());
                }
                _ => return Ok(path.to_owned()),
            };
            // Ordinary Windows paths can reinterpret these names. Never
            // silently target a different file when removing verbatim syntax.
            let extended_tail = path.components().skip(1);
            if extended_tail.into_iter().any(|part| match part {
                Component::Normal(name) => {
                    name.encode_wide().last().is_some_and(|c| c == b'.' as u16 || c == b' ' as u16)
                        || name.encode_wide().any(|c| c == b'/' as u16)
                        || Path::new(name).file_stem().and_then(|stem| stem.to_str()).is_some_and(|stem| {
                            let stem = stem.split('.').next().unwrap_or(stem).trim_end();
                            let upper = stem.to_ascii_uppercase();
                            matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
                                || ["COM", "LPT"].iter().any(|prefix| upper.strip_prefix(prefix).is_some_and(
                                    |n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
                                ))
                        })
                }
                Component::CurDir | Component::ParentDir => true,
                _ => false,
            }) {
                return Err("此 Windows 扩展路径无法安全转换为普通路径。".into());
            }
            return Ok(PathBuf::from(OsString::from_wide(&ordinary)));
        }
    }
    Ok(path.to_owned())
}

pub(crate) fn process_path_text(path: &Path) -> Result<String, String> {
    to_process_path(path)?.into_os_string().into_string()
        .map_err(|_| "Java 路径无法表示为文本。".into())
}

pub(crate) fn display_profile_path(directory: &Path) -> String {
    to_process_path(directory).as_deref().unwrap_or(directory).display().to_string()
}

fn unavailable(error: impl ToString) -> ProfileLoadError {
    ProfileLoadError::Unavailable(error.to_string())
}

#[derive(Clone, PartialEq, Eq)]
struct StateStamp {
    generation: u64,
    hash: [u8; 32],
}

#[derive(Default)]
struct RetainedFields {
    root: serde_json::Map<String, Value>,
    config: serde_json::Map<String, Value>,
}

impl RetainedFields {
    fn from_state(raw: &Value, decoded: &Persisted) -> serde_json::Result<Self> {
        let known = serde_json::to_value(decoded)?;
        let extras = |source: &Value, known: &Value| {
            source
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(key, _)| key.as_str() != "writeGeneration" && known.get(*key).is_none())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        };
        Ok(Self {
            root: extras(raw, &known),
            config: extras(&raw["config"], &known["config"]),
        })
    }

    // Preserve only additive top-level and configuration fields known at load.
    // Account and instance arrays always follow the successfully edited model.
    fn apply_to(&self, raw: &mut Value) {
        if let Some(root) = raw.as_object_mut() {
            for (key, value) in &self.root {
                root.entry(key.clone()).or_insert_with(|| value.clone());
            }
            if let Some(config) = root.get_mut("config").and_then(Value::as_object_mut) {
                for (key, value) in &self.config {
                    config.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
        }
    }
}

struct ActiveState {
    data: Persisted,
    revision: Option<StateStamp>,
    retained_fields: RetainedFields,
}

const STATE_FILE: &str = "state.json";
pub(crate) const PROFILE_LOCK: &str = "launcher-profile.lock";

fn open_profile_lock(directory: &Path) -> Result<fs::File, ProfileLoadError> {
    fs::create_dir_all(directory).map_err(unavailable)?;
    let path = safe_join(directory, PROFILE_LOCK).map_err(unavailable)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // A second launcher can open it to ask for the lock, but cannot replace the name
        // under a live handle. Do not delete the sidecar when closing the launcher.
        options.share_mode(0x1 | 0x2);
    }
    let file = options.open(path).map_err(unavailable)?;
    if !file.metadata().map_err(unavailable)?.is_file() {
        return Err(unavailable("启动器数据目录的锁不是普通文件"));
    }
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(fs::TryLockError::WouldBlock) => Err(ProfileLoadError::InUse(directory.to_owned())),
        Err(fs::TryLockError::Error(error)) => Err(unavailable(error)),
    }
}

fn state_stamp(raw: &Value, bytes: &[u8]) -> Result<StateStamp, ProfileLoadError> {
    let generation = match raw.get("writeGeneration") {
        Some(value) => value
            .as_u64()
            .ok_or_else(|| ProfileLoadError::Corrupt("writeGeneration 必须是无符号整数".into()))?,
        None => 0, // pre-round-4 JSON
    };
    Ok(StateStamp {
        generation,
        hash: <sha2::Sha256 as sha2::Digest>::digest(bytes).into(),
    })
}

/// Return the JSON body without a single optional byte-order mark at offset zero.
/// Use the original bytes for stamps and other comparisons against the file on disk.
pub(crate) fn json_body(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes)
}

fn state_contents(directory: &Path) -> Result<Option<(Value, StateStamp)>, ProfileLoadError> {
    let path = safe_join(directory, STATE_FILE).map_err(unavailable)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(unavailable("启动器配置不是普通文件")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(unavailable(error)),
    }
    match fs::read(path) {
        Ok(bytes) => {
            let raw = serde_json::from_slice(json_body(&bytes))
                .map_err(|error| ProfileLoadError::Corrupt(error.to_string()))?;
            let stamp = state_stamp(&raw, &bytes)?;
            Ok(Some((raw, stamp)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(unavailable(error)),
    }
}

pub struct LauncherState {
    active: Mutex<ActiveState>,
    pub data_dir: PathBuf,
    client: Result<reqwest::Client, String>,
    mirror_client: Result<reqwest::Client, String>,
    pub operation: tokio::sync::Mutex<()>,
    pub control: crate::downloads::DownloadControl,
    pub games: Arc<crate::processes::GameRegistry>,
    /// Per-session reachability verdict for the "auto" download source. A leaf
    /// lock: never taken while holding `active`, never persisted.
    pub(crate) source_verdict: tokio::sync::Mutex<Option<crate::source_select::Verdict>>,
    recovery: Option<StorageRecovery>,
    _profile_lock: fs::File,
}

impl LauncherState {
    pub fn load() -> Result<Self, ProfileLoadError> {
        Self::load_selected(
            explicit_data_directory(
                std::env::var_os("VOXELIGHT_LAUNCHER_DATA_DIR").map(PathBuf::from),
                std::env::var_os("MINECRAFT_LAUNCHER_DATA_DIR").map(PathBuf::from),
            ),
            data_directory(),
            fallback_data_directory,
        )
    }

    fn load_selected<F>(
        explicit: Option<PathBuf>,
        primary: Result<PathBuf, String>,
        fallback: F,
    ) -> Result<Self, ProfileLoadError>
    where
        F: FnOnce() -> Result<PathBuf, String>,
    {
        match explicit {
            Some(directory) => Self::load_from(directory),
            None => Self::load_with_fallback(primary, fallback),
        }
    }

    fn load_with_fallback<F>(
        primary_directory: Result<PathBuf, String>,
        fallback_directory: F,
    ) -> Result<Self, ProfileLoadError>
    where
        F: FnOnce() -> Result<PathBuf, String>,
    {
        let (primary, failure) = match primary_directory {
            Ok(directory) => {
                eprintln!(
                    "[voxelight/storage] loading primary state from {}",
                    directory.display()
                );
                match Self::load_from(directory.clone()) {
                    Ok(state) => return Ok(state),
                    Err(error @ (ProfileLoadError::InUse(_) | ProfileLoadError::Changed)) => {
                        return Err(error);
                    }
                    Err(error) => (Some(directory), error),
                }
            }
            Err(error) => (None, unavailable(error)),
        };

        let directory = fallback_directory()
            .map_err(|error| unavailable(format!("primary: {failure}; fallback: {error}")))?;
        if primary.as_ref().is_some_and(|path| path == &directory) {
            return Err(failure);
        }
        let primary_state_path = primary.as_ref().map(|path| path.join(STATE_FILE));
        let retained = primary_state_path.as_ref().is_some_and(|path| {
            fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
        });
        let recovery = StorageRecovery {
            reason: failure.recovery_reason(),
            primary_directory: primary.as_deref().map(display_profile_path),
            primary_state_path: primary_state_path.as_deref().map(display_profile_path),
            primary_state_retained: retained,
        };
        eprintln!(
            "[voxelight/storage] primary failed: {failure}; falling back to {}",
            directory.display()
        );
        let mut state = Self::load_from(directory.clone()).map_err(|error| {
            ProfileLoadError::FallbackUnavailable {
                primary: Box::new(failure),
                directory,
                fallback: Box::new(error),
            }
        })?;
        state.recovery = Some(recovery);
        Ok(state)
    }

    fn load_from(data_dir: PathBuf) -> Result<Self, ProfileLoadError> {
        fs::create_dir_all(&data_dir).map_err(unavailable)?;
        // Alternate spellings must acquire the same lock. Paths derived from
        // this directory are also passed to Java, so keep ordinary spelling.
        let identity = std::fs::canonicalize(data_dir).map_err(unavailable)?;
        let data_dir = to_process_path(&identity).map_err(unavailable)?;
        let profile_lock = open_profile_lock(&identity)?;
        let stored = state_contents(&data_dir)?;
        let (mut data, revision, retained_fields, mut needs_write) = match stored {
            Some((raw, stamp)) => {
                let version = raw
                    .get("schemaVersion")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if version > u64::from(CURRENT_SCHEMA_VERSION) {
                    return Err(ProfileLoadError::NewerSchema(version));
                }
                let migrated =
                    migrate_state_json(raw.clone()).map_err(ProfileLoadError::Corrupt)?;
                let needs_write = raw != migrated || raw.get("writeGeneration").is_none();
                let data: Persisted = serde_json::from_value(migrated.clone())
                    .map_err(|error| ProfileLoadError::Corrupt(error.to_string()))?;
                let retained_fields =
                    RetainedFields::from_state(&migrated, &data).map_err(unavailable)?;
                (data, Some(stamp), retained_fields, needs_write)
            }
            None => (Persisted::default(), None, RetainedFields::default(), true),
        };
        if let Some(directory) = select_game_directory(
            std::env::var("VOXELIGHT_LAUNCHER_GAME_DIR").ok(),
            std::env::var("MINECRAFT_LAUNCHER_GAME_DIR").ok(),
        ) {
            needs_write |= data.config.game_directory != directory;
            data.config.game_directory = directory;
        }
        // A hand-edited or copied profile can carry user:password@ in the proxy
        // host. Drop that before any config snapshot reaches the webview.
        needs_write |= crate::network::strip_host_userinfo(&mut data.config);
        let builder = reqwest::Client::builder()
            .user_agent(concat!("VoxelightLauncher/", env!("CARGO_PKG_VERSION")))
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
            }));
        let client = crate::network::for_config_builder(&data_dir, &data.config, builder)
            .and_then(|builder| builder.build().map_err(|_| "proxy.connection".into()));
        let mirror_client = crate::minecraft::mirror_download_client(&data_dir, &data.config);
        let control = crate::downloads::DownloadControl::load(
            data_dir.clone(),
            data.config.download_limit_kib,
        )
        .map_err(unavailable)?;
        control.set_concurrency(data.config.download_concurrency);
        let mut state = Self::new(data_dir, data, revision, client, mirror_client, control, profile_lock);
        state.active.get_mut().map_err(unavailable)?.retained_fields = retained_fields;
        if needs_write {
            state.save().map_err(|error| {
                if error == crate::errors::STORAGE_STATE_CHANGED {
                    ProfileLoadError::Changed
                } else {
                    unavailable(error)
                }
            })?;
        }
        Ok(state)
    }

    fn new(
        data_dir: PathBuf,
        data: Persisted,
        revision: Option<StateStamp>,
        client: Result<reqwest::Client, String>,
        mirror_client: Result<reqwest::Client, String>,
        control: crate::downloads::DownloadControl,
        profile_lock: fs::File,
    ) -> Self {
        Self {
            active: Mutex::new(ActiveState {
                data,
                revision,
                retained_fields: RetainedFields::default(),
            }),
            data_dir,
            client,
            mirror_client,
            operation: tokio::sync::Mutex::new(()),
            control,
            games: Default::default(),
            source_verdict: tokio::sync::Mutex::new(None),
            recovery: None,
            _profile_lock: profile_lock,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_fixture(
        data_dir: PathBuf,
        data: Persisted,
        client: reqwest::Client,
    ) -> Self {
        let profile_lock = open_profile_lock(&data_dir).unwrap();
        let revision = state_contents(&data_dir).unwrap().map(|(_, stamp)| stamp);
        let mirror_client = crate::minecraft::mirror_download_client(&data_dir, &data.config);
        Self::new(
            data_dir,
            data,
            revision,
            Ok(client),
            mirror_client,
            Default::default(),
            profile_lock,
        )
    }

    pub(crate) fn client(&self) -> Result<&reqwest::Client, String> {
        self.client.as_ref().map_err(Clone::clone)
    }

    pub(crate) fn mirror_client(&self) -> Result<&reqwest::Client, String> {
        self.mirror_client.as_ref().map_err(Clone::clone)
    }

    pub(crate) fn storage_status(&self) -> StorageStatus {
        StorageStatus {
            active_directory: display_profile_path(&self.data_dir),
            recovery: self.recovery.as_ref().map(|status| StorageRecovery {
                reason: status.reason,
                primary_directory: status.primary_directory.clone(),
                primary_state_path: status.primary_state_path.clone(),
                primary_state_retained: status.primary_state_retained,
            }),
        }
    }

    pub fn snapshot(&self) -> Result<Persisted, String> {
        self.active
            .lock()
            .map(|state| state.data.clone())
            .map_err(|_| "配置锁异常".into())
    }

    pub fn save(&self) -> Result<(), String> {
        let mut state = self.active.lock().map_err(|_| "配置锁异常")?;
        state.revision =
            Some(self.write(&state.data, state.revision.as_ref(), &state.retained_fields)?);
        Ok(())
    }

    pub fn update<T>(
        &self,
        action: impl FnOnce(&mut Persisted) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.active.lock().map_err(|_| "配置锁异常")?;
        self.check_current(state.revision.as_ref())?;
        let mut next = state.data.clone();
        let result = action(&mut next)?;
        state.revision =
            Some(self.write(&next, state.revision.as_ref(), &state.retained_fields)?);
        state.data = next;
        Ok(result)
    }

    fn check_current(&self, revision: Option<&StateStamp>) -> Result<(), String> {
        let current = match state_contents(&self.data_dir) {
            Ok(current) => current,
            Err(ProfileLoadError::Corrupt(_) | ProfileLoadError::NewerSchema(_)) => {
                return Err(crate::errors::STORAGE_STATE_CHANGED.into());
            }
            Err(error) => return Err(error.to_string()),
        };
        if current.as_ref().map(|(_, stamp)| stamp) != revision {
            return Err(crate::errors::STORAGE_STATE_CHANGED.into());
        }
        Ok(())
    }

    fn write(
        &self,
        data: &Persisted,
        revision: Option<&StateStamp>,
        retained: &RetainedFields,
    ) -> Result<StateStamp, String> {
        self.check_current(revision)?;
        let generation = revision
            .map_or(0, |stamp| stamp.generation)
            .checked_add(1)
            .ok_or("启动器数据代次已达上限，未保存")?;
        let mut raw = serde_json::to_value(data).map_err(|error| error.to_string())?;
        retained.apply_to(&mut raw);
        raw["writeGeneration"] = Value::from(generation);
        let bytes = serde_json::to_vec_pretty(&raw).map_err(|error| error.to_string())?;
        let stamp = state_stamp(&raw, &bytes).map_err(|error| error.to_string())?;
        let temp = safe_join(
            &self.data_dir,
            &format!("state-{}.tmp", uuid::Uuid::new_v4()),
        )?;
        let file = safe_join(&self.data_dir, STATE_FILE)?;
        let mut pending = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| error.to_string())?;
        use std::io::Write;
        let written = pending.write_all(&bytes).and_then(|_| pending.sync_all());
        drop(pending);
        let result = written
            .map_err(|error| error.to_string())
            .and_then(|_| self.check_current(revision))
            .and_then(|_| {
                fs::rename(&temp, file).map_err(|error| format!("保存配置失败：{error}"))
            });
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result.map(|_| stamp)
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
pub(crate) struct SameRootFixture {
    pub(crate) state: LauncherState,
    pub(crate) instance: crate::models::Instance,
    pub(crate) game: PathBuf,
    // The state (and its profile lock) drops before this owned test directory.
    root: crate::instances::StagingDirectory,
}

#[cfg(test)]
impl SameRootFixture {
    pub(crate) fn new() -> Self {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/same-root-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let profile = root.path().join("profile");
        let game_root = root.path().join("game");
        let game = game_root.join("instances/SameRoot");
        fs::create_dir_all(&game).unwrap();
        fs::create_dir(&profile).unwrap();
        let instance = crate::models::Instance {
            id: "same-root-instance".into(),
            name: "Same-root fixture instance".into(),
            version_id: "1.21.1".into(),
            game_directory: game.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let state = LauncherState::test_fixture(
            profile,
            Persisted {
                config: crate::models::Config {
                    game_directory: game_root.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                instances: vec![instance.clone()],
                ..Default::default()
            },
            test_client(),
        );
        Self { state, instance, game, root }
    }

    pub(crate) fn root(&self) -> &Path {
        self.root.path()
    }

    pub(crate) fn mark_running(&self) {
        #[cfg(windows)]
        let same_directory = self.game.with_file_name("sameroot");
        #[cfg(not(windows))]
        let same_directory = self.game.join(".");
        assert_ne!(
            same_directory.display().to_string(),
            self.game.canonicalize().unwrap().display().to_string(),
            "the fixture must register a different spelling of the same directory",
        );
        self.state
            .games
            .fixture_running_directory(&same_directory, Some("unrelated-running-instance"));
    }
}

/// Function bodies as executable source for order assertions: line comments
/// are dropped, so a commented-out guard no longer satisfies the search.
#[cfg(test)]
pub(crate) fn executable_source(text: &str) -> String {
    text.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
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

    const PROFILE_CHILD_KIND: &str = "VOXELIGHT_H04_TEST_CHILD_KIND";
    const PROFILE_CHILD_ROOT: &str = "VOXELIGHT_H04_TEST_CHILD_ROOT";
    const PROFILE_CHILD_TEST: &str = "storage::tests::profile_storage_child";

    fn profile_process_fixture() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("core-tests")
            .join(format!("profile-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    struct ChildFixture(std::process::Child);
    impl Drop for ChildFixture {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn profile_child(root: &Path, kind: &str) -> ChildFixture {
        use std::process::{Command, Stdio};
        let out = fs::File::create(root.join(format!("{kind}.stdout"))).unwrap();
        let err = fs::File::create(root.join(format!("{kind}.stderr"))).unwrap();
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", PROFILE_CHILD_TEST, "--nocapture"])
            .env(PROFILE_CHILD_KIND, kind)
            .env(PROFILE_CHILD_ROOT, root)
            .env("VOXELIGHT_LAUNCHER_GAME_DIR", root.join("isolated-game"))
            .env_remove("MINECRAFT_LAUNCHER_GAME_DIR")
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .spawn()
            .unwrap();
        ChildFixture(child)
    }

    fn wait_until(mut ready: impl FnMut() -> bool, note: &str) {
        let end = std::time::Instant::now() + std::time::Duration::from_secs(12);
        while !ready() {
            assert!(
                std::time::Instant::now() < end,
                "timeout waiting for {note}"
            );
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }

    fn child_finished(child: &mut ChildFixture) {
        wait_until(
            || child.0.try_wait().unwrap().is_some(),
            "profile test process exit",
        );
        assert!(child.0.wait().unwrap().success());
    }

    /// This test is only active when the parent explicitly launches it for one disposable profile.
    #[test]
    fn profile_storage_child() {
        let Ok(mission) = std::env::var(PROFILE_CHILD_KIND) else {
            return;
        };
        let root = PathBuf::from(std::env::var_os(PROFILE_CHILD_ROOT).unwrap());
        let expected = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("core-tests");
        assert!(root.starts_with(expected));
        assert!(root
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("profile-"));
        let profile = root.join("primary");
        let file = profile.join("state.json");
        match mission.as_str() {
            "hold" => {
                let state = LauncherState::load_from(profile).unwrap();
                fs::write(root.join("holder-ready"), b"ready").unwrap();
                wait_until(|| root.join("hold-release").exists(), "first write release");
                state
                    .update(|row| {
                        row.config.max_memory_mb = 16384;
                        Ok(())
                    })
                    .unwrap();
                fs::write(root.join("holder-written"), b"written").unwrap();
                wait_until(|| root.join("hold-stop").exists(), "holder stop");
            }
            "contender" => {
                let opened =
                    LauncherState::load_with_fallback(Ok(profile), || Ok(root.join("fallback")));
                let report = match opened {
                    Ok(state) => {
                        // Old launcher takes a whole-state snapshot before holder commits.
                        fs::write(root.join("contender-result"), b"opened").unwrap();
                        wait_until(
                            || root.join("contender-release").exists(),
                            "contender release",
                        );
                        state
                            .update(|row| {
                                row.config.language = "en-US".into();
                                Ok(())
                            })
                            .map(|_| "written".to_owned())
                    }
                    Err(error) => Ok(error.to_string()),
                };
                fs::write(root.join("contender-result"), report.unwrap()).unwrap();
            }
            "reload" => {
                let state = LauncherState::load_from(profile).unwrap();
                assert_eq!(state.snapshot().unwrap().config.max_memory_mb, 16384);
                fs::write(root.join("reloaded"), b"yes").unwrap();
            }
            "watch" => {
                let state = LauncherState::load_from(profile).unwrap();
                assert_eq!(state.snapshot().unwrap().config.max_memory_mb, 4096);
                fs::write(root.join("watch-ready"), b"ready").unwrap();
                wait_until(|| root.join("watch-release").exists(), "test state edit");
                let result = state.update(|row| {
                    row.config.language = "en-US".into();
                    Ok(())
                });
                let bridge_result = result
                    .map(|_| "written".to_owned())
                    .unwrap_or_else(|reason| crate::errors::expected(reason).code);
                fs::write(root.join("watch-result"), bridge_result).unwrap();
            }
            "external-later" | "external-legacy" => {
                let mut json: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
                json["config"]["maxMemoryMb"] = Value::from(16384);
                if mission == "external-later" {
                    json["writeGeneration"] =
                        Value::from(json["writeGeneration"].as_u64().unwrap_or(0) + 1);
                }
                // Simulate only a cooperative test editor of the owned fixture. Never use a user profile.
                let temp = profile.join("simulated-editor.tmp");
                fs::write(&temp, serde_json::to_vec_pretty(&json).unwrap()).unwrap();
                fs::rename(temp, file).unwrap();
            }
            _ => panic!("unknown profile test child"),
        }
    }

    #[test]
    fn profile_lock_prevents_a_second_process_resetting_16384_to_4096_or_creating_fallback() {
        let root = profile_process_fixture();
        let file = root.join("primary/state.json");
        let mut holder = profile_child(&root, "hold");
        wait_until(|| root.join("holder-ready").exists(), "holder startup");
        let mut contender = profile_child(&root, "contender");
        wait_until(
            || root.join("contender-result").exists(),
            "contender decision",
        );
        let first_decision = fs::read_to_string(root.join("contender-result")).unwrap();
        fs::write(root.join("hold-release"), b"yes").unwrap();
        wait_until(
            || root.join("holder-written").exists(),
            "holder durable update",
        );
        fs::write(root.join("contender-release"), b"yes").unwrap();
        child_finished(&mut contender);
        let disk: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        fs::write(root.join("hold-stop"), b"yes").unwrap();
        child_finished(&mut holder);
        assert_eq!(
            disk["config"]["maxMemoryMb"], 16384,
            "second process overwrote persisted settings"
        );
        assert!(
            !root.join("fallback").exists(),
            "profile lock wrongly triggered fallback"
        );
        assert!(
            first_decision.contains("Profile in use"),
            "{first_decision}"
        );
        let mut reloaded = profile_child(&root, "reload");
        child_finished(&mut reloaded);
        assert!(root.join("reloaded").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profile_stamp_rejects_newer_revision_and_legacy_same_generation_writes() {
        for mutation in ["external-later", "external-legacy"] {
            let root = profile_process_fixture();
            let mut watcher = profile_child(&root, "watch");
            wait_until(|| root.join("watch-ready").exists(), "stale-writer startup");
            let mut editor = profile_child(&root, mutation);
            child_finished(&mut editor);
            let expected = fs::read(root.join("primary/state.json")).unwrap();
            fs::write(root.join("watch-release"), b"yes").unwrap();
            child_finished(&mut watcher);
            assert_eq!(
                fs::read(root.join("primary/state.json")).unwrap(),
                expected,
                "{mutation}: stale launcher overwrote the other process"
            );
            assert_eq!(
                fs::read_to_string(root.join("watch-result")).unwrap(),
                "storage.stateChanged"
            );
            fs::remove_dir_all(root).unwrap();
        }
    }

    fn bom_state_fixture() -> (crate::instances::StagingDirectory, Vec<u8>, Vec<u8>) {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/core-tests")
            .join(format!("profile-bom-{}", uuid::Uuid::new_v4()));
        let root = crate::instances::StagingDirectory::create(path).unwrap();
        let primary = root.path().join("primary");
        fs::create_dir(&primary).unwrap();
        let mut value = serde_json::to_value(Persisted::default()).unwrap();
        value["writeGeneration"] = Value::from(7);
        let body = serde_json::to_vec(&value).unwrap();
        let with_bom = [b"\xEF\xBB\xBF".as_slice(), &body].concat();
        fs::write(primary.join(STATE_FILE), &with_bom).unwrap();
        (root, body, with_bom)
    }

    #[test]
    fn state_json_with_utf8_bom_loads_as_primary() {
        let (root, _, with_bom) = bom_state_fixture();
        let primary = root.path().join("primary");
        let fallback = root.path().join("fallback");
        let file = primary.join(STATE_FILE);
        let state = LauncherState::load_with_fallback(Ok(primary.clone()), || Ok(fallback.clone()))
            .unwrap();
        assert_eq!(state.data_dir, primary);
        assert!(state.storage_status().recovery.is_none());
        assert!(!fallback.exists());
        assert_eq!(
            fs::read(&file).unwrap(),
            with_bom,
            "loading should not rewrite a BOM"
        );
        state
            .update(|data| {
                data.config.theme = "dark".into();
                Ok(())
            })
            .unwrap();
        let bytes = fs::read(&file).unwrap();
        assert_eq!(bytes[0], b'{');
        let saved: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(saved["config"]["theme"], "dark");
        assert_eq!(saved["writeGeneration"], 8);
    }

    #[test]
    fn the_saved_download_concurrency_limits_connections_from_startup() {
        let (root, _, _) = bom_state_fixture();
        let primary = root.path().join("primary");
        let mut value = serde_json::to_value(Persisted::default()).unwrap();
        value["config"]["downloadConcurrency"] = Value::from(3);
        fs::write(primary.join(STATE_FILE), serde_json::to_vec(&value).unwrap()).unwrap();
        let state = LauncherState::load_from(primary).unwrap();
        assert_eq!(state.snapshot().unwrap().config.download_concurrency, 3);
        assert_eq!(state.control.connections().limit(), 3);
    }

    #[test]
    fn state_json_bom_changes_are_still_raw_byte_conflicts() {
        let (root, body, _) = bom_state_fixture();
        let primary = root.path().join("primary");
        let file = primary.join(STATE_FILE);
        let state = LauncherState::load_from(primary).unwrap();
        fs::write(&file, &body).unwrap();
        let error = state
            .update(|data| {
                data.config.theme = "dark".into();
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error, crate::errors::STORAGE_STATE_CHANGED);
        assert_eq!(fs::read(&file).unwrap(), body);
    }

    #[test]
    fn state_json_bom_does_not_hide_truncation_or_strip_another_bom() {
        let (root, body, _) = bom_state_fixture();
        let primary = root.path().join("primary");
        let file = primary.join(STATE_FILE);
        let bom = b"\xEF\xBB\xBF";
        for prefix in [b"\xEF\xBB\xBF\xEF\xBB\xBF".as_slice(), b" \xEF\xBB\xBF"] {
            fs::write(&file, [prefix, &body].concat()).unwrap();
            assert!(matches!(
                state_contents(&primary),
                Err(ProfileLoadError::Corrupt(_))
            ));
        }
        fs::write(&file, [bom.as_slice(), b"{"].concat()).unwrap();
        assert!(matches!(
            state_contents(&primary),
            Err(ProfileLoadError::Corrupt(_))
        ));
    }

    #[test]
    fn corrupt_and_newer_primary_report_protected_state_and_actual_fallback() {
        for (bytes, reason) in [
            (b"{".as_slice(), "corrupt"),
            (br#"{"schemaVersion":999}"#.as_slice(), "newerSchema"),
        ] {
            let root = profile_process_fixture();
            let primary = root.join("primary");
            let fallback = root.join("fallback");
            fs::create_dir(&primary).unwrap();
            fs::write(primary.join("state.json"), bytes).unwrap();
            let state =
                LauncherState::load_with_fallback(Ok(primary.clone()), || Ok(fallback.clone()))
                    .unwrap();
            let metadata = serde_json::to_value(state.storage_status()).unwrap();
            assert_eq!(metadata["activeDirectory"], fallback.display().to_string());
            assert_eq!(metadata["recovery"]["reason"], reason);
            assert_eq!(
                metadata["recovery"]["primaryDirectory"],
                primary.display().to_string()
            );
            assert_eq!(
                metadata["recovery"]["primaryStatePath"],
                primary.join("state.json").display().to_string()
            );
            assert_eq!(metadata["recovery"]["primaryStateRetained"], true);
            assert_eq!(fs::read(primary.join("state.json")).unwrap(), bytes);
            drop(state);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn default_primary_without_state_uses_its_own_directory_and_alias_is_locked() {
        let root = profile_process_fixture();
        let primary = root.join("primary");
        let initial = LauncherState::load_with_fallback(Ok(primary.clone()), || {
            unreachable!("fresh primary must not fallback")
        })
        .unwrap();
        let alias = primary.join("..").join("primary");
        let second = LauncherState::load_with_fallback(Ok(alias), || {
            unreachable!("locked alias must not fallback")
        });
        assert!(matches!(second, Err(ProfileLoadError::InUse(_))));
        assert_eq!(
            initial.storage_status().active_directory,
            primary.display().to_string()
        );
        drop(initial);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn explicit_corrupt_override_does_not_attempt_normal_fallback() {
        let root = profile_process_fixture();
        let primary = root.join("explicit");
        fs::create_dir(&primary).unwrap();
        fs::write(primary.join("state.json"), b"{").unwrap();
        let result =
            LauncherState::load_selected(Some(primary.clone()), Ok(root.join("normal")), || {
                panic!("explicit profile selection touched the normal fallback")
            });
        assert!(matches!(result, Err(ProfileLoadError::Corrupt(_))));
        assert_eq!(fs::read(primary.join("state.json")).unwrap(), b"{");
        assert!(!root.join("normal").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profile_save_preserves_additive_fields_without_resurrecting_removed_records() {
        let root = profile_process_fixture();
        let primary = root.join("primary");
        fs::create_dir(&primary).unwrap();
        let file = primary.join("state.json");
        fs::write(
            &file,
            br#"{
            "schemaVersion":1, "unrecognizedRootSetting":{"example":true},
            "config":{"unrecognizedConfigSetting":{"kept":true}},
            "accounts":[{"id":"fixture","unrecognizedAccountField":"do not carry removed records"}]
        }"#,
        )
        .unwrap();
        let state = LauncherState::load_from(primary).unwrap();
        state
            .update(|data| {
                data.accounts.clear();
                data.config.theme = "dark".into();
                Ok(())
            })
            .unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_eq!(saved["unrecognizedRootSetting"]["example"], true);
        assert_eq!(saved["config"]["unrecognizedConfigSetting"]["kept"], true);
        assert_eq!(saved["config"]["theme"], "dark");
        assert_eq!(saved["accounts"], serde_json::json!([]));
        assert_eq!(saved["writeGeneration"], 2);
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_state_replace_preserves_existing_target_on_windows() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("core-tests")
            .join(format!("state-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let state =
            LauncherState::test_fixture(directory.clone(), Persisted::default(), test_client());
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
        drop(state);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn r4_profile_uses_ordinary_paths_but_retains_its_lock() {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/core-tests")
                .join(format!("r4-profile-{}", uuid::Uuid::new_v4())),
        ).unwrap();
        let path = root.path().join("profile with spaces");
        fs::create_dir_all(&path).unwrap();
        let identity = path.canonicalize().unwrap();
        let state = LauncherState::load_from(identity.clone()).unwrap();
        assert!(matches!(LauncherState::load_from(path.clone()), Err(ProfileLoadError::InUse(_))));
        assert_eq!(state.data_dir, path);
        assert!(!state.data_dir.join("cache/example.jar").to_string_lossy().starts_with(r"\\?\"));
    }

    #[test]
    fn unavailable_primary_storage_falls_back_without_panicking() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("core-tests")
            .join(format!("storage-fallback-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let primary = root.join("primary-is-a-file");
        fs::write(&primary, b"not a directory").unwrap();
        let fallback = root.join("fallback");

        let state =
            LauncherState::load_with_fallback(Ok(primary), || Ok(fallback.clone())).unwrap();
        assert_eq!(fs::canonicalize(&state.data_dir).unwrap(), fs::canonicalize(&fallback).unwrap());
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
        for field in [
            "effects",
            "accentSource",
            "language",
            "soundEnabled",
            "worldScene",
            "worldMaterial",
        ] {
            config.remove(field);
        }
        config.insert("futureVisualSetting".into(), serde_json::json!("kept"));

        let migrated = migrate_state_json(old).unwrap();
        assert_eq!(migrated["config"]["worldScene"], "horizon");
        assert_eq!(migrated["config"]["worldMaterial"], "lattice");
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
    fn crystal_world_config_choices_survive_migration_and_round_trip() {
        let old = serde_json::json!({
            "config": { "worldScene": "massif", "worldMaterial": "solid" },
            "accounts": [], "instances": []
        });
        let decoded: Persisted = serde_json::from_value(migrate_state_json(old).unwrap()).unwrap();
        let saved = serde_json::to_value(decoded).unwrap();
        assert_eq!(saved["config"]["worldScene"], "massif");
        assert_eq!(saved["config"]["worldMaterial"], "solid");
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
