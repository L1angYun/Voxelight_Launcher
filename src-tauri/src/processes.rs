use crate::path_grants::{PathGrants, PathUse};
use crate::{
    errors::{expected, AppResult},
    game_process::{StopHandle, StopResult, StopStatus},
    models::{Config, LogEvent},
    storage::{safe_join, LauncherState},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{self, Write},
    io::{Read, Seek},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, RwLock},
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningGame {
    pub game_id: String,
    pub pid: u32,
    pub version_id: String,
    pub instance_id: Option<String>,
    pub game_directory: String,
    pub started_at: String,
    /// The configured root whose libraries/ and versions/ the game reads.
    /// Internal only: installs into that root must wait for the game to exit.
    #[serde(skip)]
    pub library_root: String,
}
struct TrackedGame {
    info: RunningGame,
    clock: Instant,
    owner: Option<Arc<StopHandle>>,
}
#[derive(Default)]
pub struct GameRegistry {
    games: Mutex<HashMap<String, TrackedGame>>,
}
/// Normalize a validated game root even if the final version/instance directory
/// has not been created. Canonicalize the nearest existing ordinary ancestor.
pub(crate) fn canonical_game_directory(path: &Path) -> Result<PathBuf, String> {
    let checked = crate::instances::checked_absolute(path)?;
    canonical_existing_ancestor(&checked)
}

/// Only the configured root may follow junctions/symlinks. Descendants selected
/// by IDs or archive paths still go through checked_absolute / safe_join.
pub(crate) fn configured_game_root(path: &Path) -> Result<PathBuf, String> {
    crate::instances::validate_absolute_syntax(path)?;
    crate::storage::to_process_path(path)?;
    crate::instances::checked_absolute(&crate::storage::to_process_path(&canonical_existing_ancestor(path)?)?)
}

/// Inputs are absolute and expressed using the same prefix syntax. On Windows
/// the filesystem's canonical spelling takes precedence; fold ordinary ASCII
/// path case when comparing alternate persisted spellings.
pub(crate) fn directory_tail<'a>(child: &'a Path, parent: &Path) -> Option<&'a Path> {
    let mut child = child.components();
    for parent in parent.components() {
        let part = child.next()?;
        #[cfg(windows)]
        let equal = part.as_os_str().eq_ignore_ascii_case(parent.as_os_str());
        #[cfg(not(windows))]
        let equal = part == parent;
        if !equal { return None; }
    }
    Some(child.as_path())
}

fn canonical_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let mut current = path;
    let mut missing = Vec::new();
    loop {
        match std::fs::metadata(current) {
            Ok(metadata) if metadata.is_dir() => {
                let mut identity = current.canonicalize().map_err(|e| format!("无法解析游戏目录：{e}"))?;
                for name in missing.into_iter().rev() {
                    identity.push(name);
                }
                return Ok(identity);
            }
            Ok(_) => return Err("游戏目录不是目录".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // A dangling link is not a missing directory that we may create.
                if std::fs::symlink_metadata(current).is_ok() {
                    return Err(format!("无法解析游戏目录：{error}"));
                }
                missing.push(current.file_name().ok_or("游戏目录无效")?);
                current = current.parent().ok_or("游戏目录无效")?;
            }
            Err(error) => return Err(format!("无法访问游戏目录：{error}")),
        }
    }
}

pub(crate) fn same_canonical_directory(path: &Path, active: &Path) -> bool {
    // RunningGame stores an ordinary path for display. Convert it back to
    // the identity form when comparing a process with an operation target.
    let active = active.canonicalize().unwrap_or_else(|_| active.to_path_buf());
    #[cfg(windows)]
    { path.to_string_lossy().eq_ignore_ascii_case(&active.to_string_lossy()) }
    #[cfg(not(windows))]
    { path == active }
}

impl GameRegistry {
    fn stop_handle(&self, game_id: &str) -> Result<Arc<StopHandle>, String> {
        self.games
            .lock()
            .map_err(|_| "游戏进程锁异常，为保护实例文件，已拒绝此操作")?
            .get(game_id)
            .and_then(|game| game.owner.clone())
            .ok_or_else(|| "只能结束由本启动器启动、且仍在运行的游戏进程".into())
    }

    pub(crate) fn snapshot(&self) -> Result<Vec<RunningGame>, String> {
        self.games
            .lock()
            .map(|games| games.values().map(|game| game.info.clone()).collect())
            .map_err(|_| "游戏进程锁异常，为保护实例文件，已拒绝此操作".to_owned())
    }
    fn list(&self) -> Vec<RunningGame> {
        self.games
            .lock()
            .map(|games| games.values().map(|game| game.info.clone()).collect())
            .unwrap_or_default()
    }
    #[cfg(test)]
    pub(crate) fn fixture_running_directory(&self, directory: &Path, instance_id: Option<&str>) {
        let game_id = "fixture-canonical-game".to_owned();
        self.games.lock().unwrap().insert(game_id.clone(), TrackedGame {
            clock: Instant::now(),
            owner: None,
            info: RunningGame { game_id, pid: 12, version_id: "first-test-version".into(), instance_id: instance_id.map(str::to_owned),
                // Store the spelling as given, like register(): the comparator
                // must resolve aliases itself rather than rely on this fixture.
                game_directory: directory.display().to_string(), started_at: String::new(),
                library_root: String::new() },
        });
    }

    #[cfg(test)]
    pub(crate) fn fixture_running_root(&self, library_root: &Path) {
        // Same recording path as register(), so the test covers what launch stores.
        self.track(
            "fixture-library-root-game",
            13,
            "fixture-version",
            None,
            &library_root.join("versions/fixture-version"),
            library_root,
            None,
        );
    }

    /// Installs replace library files and write versions/<id> profiles in the
    /// configured root. A running JVM holds those files open (on Windows a
    /// replacement fails partway), so refuse while any game launched from the
    /// same root runs. Launching another instance is still allowed.
    pub(crate) fn require_root_stopped(&self, root: &Path) -> Result<(), String> {
        let root = canonical_game_directory(root)?;
        let games = self.snapshot()?;
        if games.iter().any(|game| {
            !game.library_root.is_empty()
                && same_canonical_directory(&root, Path::new(&game.library_root))
        }) {
            return Err(crate::errors::INSTALL_GAME_RUNNING.into());
        }
        Ok(())
    }

    pub(crate) fn require_directory_stopped(
        &self,
        directory: &Path,
        instance_id: Option<&str>,
        launch: bool,
    ) -> Result<PathBuf, String> {
        let directory = canonical_game_directory(directory)?;
        let games = self.snapshot()?;
        if games.iter().any(|game| {
            (instance_id.is_some() && game.instance_id.as_deref() == instance_id)
                || same_canonical_directory(&directory, Path::new(&game.game_directory))
        }) {
            return Err(if launch {
                "此实例已在运行，请勿重复启动".into()
            } else {
                "此实例的游戏仍在运行。请先正常退出游戏，再备份、克隆、导出或恢复实例。".into()
            });
        }
        Ok(directory)
    }

    fn require_instance_stopped_with_error(
        &self,
        instance_id: &str,
        running_error: &str,
    ) -> Result<(), String> {
        let games = self
            .games
            .lock()
            .map_err(|_| "游戏进程锁异常，为保护实例文件，已拒绝此操作".to_owned())?;
        if games
            .values()
            .any(|game| game.info.instance_id.as_deref() == Some(instance_id))
        {
            Err(running_error.into())
        } else {
            Ok(())
        }
    }
    pub fn require_instance_stopped(&self, instance_id: &str) -> Result<(), String> {
        self.require_instance_stopped_with_error(
            instance_id,
            "此实例的游戏仍在运行。请先正常退出游戏，再备份、克隆、导出或恢复实例。",
        )
    }
    #[cfg(test)]
    fn require_instance_launch_stopped(&self, instance_id: &str) -> Result<(), String> {
        self.require_instance_stopped_with_error(instance_id, "此实例已在运行，请勿重复启动")
    }
}
pub fn register(
    app: &AppHandle,
    game_id: &str,
    pid: u32,
    version: &str,
    instance_id: Option<String>,
    directory: &Path,
    library_root: &Path,
    owner: StopHandle,
) {
    if let Some(registry) = app.try_state::<Arc<GameRegistry>>() {
        registry.track(game_id, pid, version, instance_id, directory, library_root, Some(Arc::new(owner)));
        let _ = app.emit("launcher://games", registry.list());
    }
}

impl GameRegistry {
    /// The one place a launched game is recorded (register and test fixtures).
    #[allow(clippy::too_many_arguments)]
    fn track(
        &self,
        game_id: &str,
        pid: u32,
        version: &str,
        instance_id: Option<String>,
        directory: &Path,
        library_root: &Path,
        owner: Option<Arc<StopHandle>>,
    ) {
        if let Ok(mut games) = self.games.lock() {
            games.insert(
                game_id.into(),
                TrackedGame {
                    info: RunningGame {
                        game_id: game_id.into(),
                        pid,
                        version_id: version.into(),
                        instance_id,
                        game_directory: directory.to_string_lossy().into_owned(),
                        started_at: chrono::Utc::now().to_rfc3339(),
                        library_root: library_root.to_string_lossy().into_owned(),
                    },
                    clock: Instant::now(),
                    owner,
                },
            );
        }
    }
}
pub fn unregister(app: &AppHandle, state: &LauncherState, game_id: &str, code: Option<i32>) {
    let Some(registry) = app.try_state::<Arc<GameRegistry>>() else {
        return;
    };
    let tracked = registry
        .games
        .lock()
        .ok()
        .and_then(|mut games| games.remove(game_id));
    if let Some(game) = tracked {
        if let Some(id) = game.info.instance_id {
            let seconds = game.clock.elapsed().as_secs();
            let _ = state.update(|data| {
                if let Some(instance) = data.instances.iter_mut().find(|i| i.id == id) {
                    instance.total_play_time = instance.total_play_time.saturating_add(seconds);
                }
                Ok(())
            });
        }
        let _ = app.emit(
            "launcher://log",
            LogEvent {
                level: if code == Some(0) { "info" } else { "warn" }.into(),
                message: format!("游戏进程 {} 已结束，退出码 {code:?}", game.info.pid),
                timestamp: chrono::Utc::now().to_rfc3339(),
            },
        );
    }
    let _ = app.emit("launcher://games", registry.list());
}
#[tauri::command]
pub fn list_running_games(registry: State<'_, Arc<GameRegistry>>) -> Vec<RunningGame> {
    registry.list()
}
const SUPPORTED_REPORT_LOCALES: [&str; 7] = [
    "zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "ru-RU", "es-ES",
];

fn interface_locale(config: &Config) -> &'static str {
    report_locale(&config.language, || crate::platform::get_system_appearance().locale)
}

fn interface_is_zh(config: &Config) -> bool {
    matches!(interface_locale(config), "zh-CN" | "zh-TW")
}

/// Mirrors the frontend's resolveLocale: only "system" follows the OS, and an
/// unknown value falls back to English like the interface does.
fn report_locale(language: &str, system_locale: impl FnOnce() -> String) -> &'static str {
    let resolved = if language == "system" {
        system_locale()
    } else {
        language.to_owned()
    };
    SUPPORTED_REPORT_LOCALES
        .iter()
        .copied()
        .find(|candidate| *candidate == resolved.as_str())
        .unwrap_or("en-US")
}

#[cfg(test)]
fn report_is_zh(language: &str, system_locale: impl FnOnce() -> String) -> bool {
    report_locale(language, system_locale) == "zh-CN"
}

pub(crate) async fn stop_game_graceful(
    registry: &GameRegistry,
    game_id: &str,
) -> Result<StopResult, String> {
    let owner = registry.stop_handle(game_id)?;
    let _single_request = owner
        .authorization
        .try_lock()
        .map_err(|_| "正在处理此游戏的结束请求")?;
    let status = owner.request(false).await?;
    Ok(StopResult { status })
}

#[tauri::command]
pub async fn stop_game(
    webview: tauri::WebviewWindow,
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<GameRegistry>>,
    game_id: String,
    force: Option<bool>,
) -> AppResult<StopResult> {
    let owner = registry.stop_handle(&game_id)?;
    let _single_request = owner
        .authorization
        .try_lock()
        .map_err(|_| "正在处理此游戏的结束请求")?;
    let status = if force.unwrap_or(false) {
        let settings = state.snapshot()?.config;
        let zh = interface_is_zh(&settings);
        confirm_and_force(&owner, || confirm_force_stop(&webview, zh)).await?
    } else {
        owner.request(false).await?
    };
    Ok(StopResult { status })
}

async fn confirm_and_force<F: std::future::Future<Output = bool>>(
    owner: &StopHandle,
    confirm: impl FnOnce() -> F,
) -> Result<StopStatus, String> {
    if let Some(status) = owner.completion_status() {
        return status;
    }
    if !owner
        .force_required
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(StopStatus::ForceRequired);
    }
    if !confirm().await {
        return Ok(StopStatus::Declined);
    }
    owner.request(true).await
}

async fn confirm_force_stop(webview: &tauri::WebviewWindow, zh: bool) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let (title, body, force, cancel) = if zh {
        (
            "强制结束 Minecraft？",
            "游戏未能正常退出。请优先回到游戏保存并退出。强制结束可能丢失尚未保存的进度。",
            "强制结束",
            "返回游戏",
        )
    } else {
        (
            "Force quit Minecraft?",
            "The game did not close normally. Save and quit in Minecraft if possible. Forcing it to close can lose unsaved progress.",
            "Force quit",
            "Return to game",
        )
    };
    let (response, wait) = tokio::sync::oneshot::channel();
    webview
        .dialog()
        .message(body)
        .title(title)
        .parent(webview)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            force.into(),
            cancel.into(),
        ))
        .show(move |confirmed| {
            let _ = response.send(confirmed);
        });
    wait.await.unwrap_or(false)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum DiagnosisKind {
    Memory,
    Java,
    Mods,
    Graphics,
    Directory,
    Unknown,
    Empty,
}

impl DiagnosisKind {
    fn locale_key(self) -> &'static str {
        match self {
            Self::Memory => "memory",
            Self::Java => "java",
            Self::Mods => "mods",
            Self::Graphics => "graphics",
            Self::Directory => "directory",
            Self::Unknown => "unknown",
            Self::Empty => "empty",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    kind: DiagnosisKind,
    pub log_path: Option<String>,
    pub excerpt: String,
}

fn classify(text: &str) -> DiagnosisKind {
    if text.is_empty() {
        return DiagnosisKind::Empty;
    }
    let lower = text.to_ascii_lowercase();
    if lower.contains("outofmemoryerror") || lower.contains("could not reserve enough space") {
        DiagnosisKind::Memory
    } else if lower.contains("unsupportedclassversionerror") || lower.contains("class file version")
    {
        DiagnosisKind::Java
    } else if lower.contains("modresolutionexception")
        || lower.contains("missing mandatory dependencies")
        || lower.contains("incompatible mods")
    {
        DiagnosisKind::Mods
    } else if lower.contains("glfw error") || lower.contains("opengl") && lower.contains("failed") {
        DiagnosisKind::Graphics
    } else if lower.contains("accessexception")
        || lower.contains("access is denied")
        || lower.contains("accessdeniedexception")
    {
        DiagnosisKind::Directory
    } else {
        DiagnosisKind::Unknown
    }
}
const REGISTERED_SECRET_LIMIT: usize = 64;
const MIN_REGISTERED_SECRET_LEN: usize = 16;
const REDACTED_MARKER: &str = "<redacted>";

/// Short values and the offline placeholder are not credentials.
fn is_registrable_secret(value: &str) -> bool {
    value.len() >= MIN_REGISTERED_SECRET_LEN && value != "0"
}

/// Credentials that [`redact`] masks by value, least recently registered first.
#[derive(Default)]
struct SecretRegistry {
    values: Vec<String>,
}

impl SecretRegistry {
    /// The registry is bounded so a long-running process cannot grow it without
    /// limit. A value registered again becomes the newest, and the oldest one
    /// is dropped first, so the credentials of the latest launch always stay.
    fn insert(&mut self, value: &str) {
        let value = value.trim();
        if !is_registrable_secret(value) {
            return;
        }
        if let Some(index) = self.values.iter().position(|secret| secret == value) {
            let existing = self.values.remove(index);
            self.values.push(existing);
            return;
        }
        if self.values.len() >= REGISTERED_SECRET_LIMIT {
            self.values.remove(0);
        }
        self.values.push(value.to_owned());
    }

    /// The access token a launch passes to the game, and the
    /// `token:<token>:<uuid>` session string that 1.7 and 1.8 clients log. An
    /// offline launch has no credential, so nothing is registered for it.
    fn insert_launch_credentials(&mut self, access_token: &str, player_uuid: &str) {
        if !is_registrable_secret(access_token.trim()) {
            return;
        }
        self.insert(access_token);
        self.insert(&format!("token:{access_token}:{player_uuid}"));
    }

    /// Longest value first, so a session string is not left as a partially
    /// replaced token.
    fn mask(&self, text: &str) -> String {
        let mut secrets: Vec<&str> = self.values.iter().map(String::as_str).collect();
        secrets.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
        let mut text = text.to_owned();
        for secret in secrets {
            if text.contains(secret) {
                text = text.replace(secret, REDACTED_MARKER);
            }
        }
        text
    }
}

fn secret_registry() -> &'static RwLock<SecretRegistry> {
    static SECRETS: OnceLock<RwLock<SecretRegistry>> = OnceLock::new();
    SECRETS.get_or_init(|| RwLock::new(SecretRegistry::default()))
}

/// Remember the credentials of a launch before the game can print them, so
/// [`redact`] masks them even when a log line contains a bare value without a
/// key or a recognizable token shape.
pub fn register_launch_credentials(access_token: &str, player_uuid: &str) {
    secret_registry()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert_launch_credentials(access_token, player_uuid);
}

/// Remember another credential the launcher holds (for example the Lumen API key
/// while it is in use), so anything that echoes it back is masked by value.
pub fn register_secret(value: &str) {
    secret_registry()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(value);
}

pub fn redact(text: &str) -> String {
    use std::sync::LazyLock;
    static PROXY_AUTH: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)(\bproxy-authorization[\s"':=]+)(?:(?:basic|bearer|negotiate)\s+)?[^\s,;"']+"#)
            .expect("constant regex")
    });
    static URL_USERINFO: LazyLock<regex::Regex> = LazyLock::new(|| {
        // All of the authority before its last '@' is userinfo; RFC 3986 allows
        // sub-delimiters such as , ; ' there, so they must not end the match.
        regex::Regex::new(r#"(?i)(\bhttps?://)[^/?#\s"]*@"#)
            .expect("constant regex")
    });
    static BEARER: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)(authorization[\s"':=]+)(?:bearer\s+)?([^\s,;"']+)"#)
            .expect("constant regex")
    });
    static BARE_BEARER: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)(\bbearer\s+)["']?([^\s,;"']+)["']?"#)
            .expect("constant regex")
    });
    static TOKEN_ARGUMENT: LazyLock<regex::Regex> = LazyLock::new(|| {
        // Vanilla passes --accessToken as a separate argument; legacy loaders
        // also print --session or comma-separated forms.
        regex::Regex::new(r#"(?i)(--(?:access[_-]?token|session)[\s,'\"=]+)([^\s,;\"'\]]+)"#)
            .expect("constant regex")
    });
    static SESSION_ID: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\(Session ID is [^)]*\)").expect("constant regex")
    });
    static TOKEN_SESSION: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\btoken:[^:\s]+:[0-9a-fA-F-]{32,36}").expect("constant regex")
    });
    static API_KEY: LazyLock<regex::Regex> = LazyLock::new(|| {
        // OpenAI-style keys (OpenAI, DeepSeek, Anthropic `sk-ant-`), including the partly
        // masked form a provider echoes back in an authentication error.
        regex::Regex::new(r"\bsk-[A-Za-z0-9_*-]{8,}").expect("constant regex")
    });
    static JWT: LazyLock<regex::Regex> = LazyLock::new(|| {
        // The payload and signature alone (header cut off) still rebuild a
        // token, because the header of a services token is a known constant.
        regex::Regex::new(r"\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,}){1,2}")
            .expect("constant regex")
    });
    static SECRET: LazyLock<regex::Regex> = LazyLock::new(|| {
        // A comma is accepted only for token keys so ordinary prose such as
        // "authorization, ..." is not mistaken for a credential.
        regex::Regex::new(r#"(?i)((?:(?:access[_-]?token|refresh[_-]?token)[\s"':=,]+|(?:authorization|client[_-]?secret|password|x-api-key)[\s"':=]+))([^\s,;"']+)"#)
            .expect("constant regex")
    });
    static CLIENT_ID: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)(--clientId[\s,'\"=]+|clientid=)([^\s,;\"'\]]+)"#)
            .expect("constant regex")
    });
    let text = secret_registry()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .mask(text);
    let text = URL_USERINFO.replace_all(&text, "${1}[已隐藏]@");
    let text = PROXY_AUTH.replace_all(&text, "${1}[已隐藏]");
    let text = BEARER.replace_all(&text, "${1}[已隐藏]");
    let text = BARE_BEARER.replace_all(&text, "${1}[已隐藏]");
    let text = TOKEN_ARGUMENT.replace_all(&text, "${1}<redacted>");
    let text = SESSION_ID.replace_all(&text, "(Session ID is <redacted>)");
    let text = TOKEN_SESSION.replace_all(&text, "token:<redacted>");
    let text = API_KEY.replace_all(&text, "sk-<redacted>");
    let text = JWT.replace_all(&text, "<redacted>");
    // An exact marker left by the rules above is already masked; anything else
    // after a key, including a value that contains or starts with '<', is not.
    let text = SECRET.replace_all(&text, |captures: &regex::Captures| {
        if &captures[2] == REDACTED_MARKER {
            captures[0].to_owned()
        } else {
            format!("{}[已隐藏]", &captures[1])
        }
    });
    CLIENT_ID.replace_all(&text, "${1}[已隐藏]").into_owned()
}
#[tauri::command]
pub fn diagnose_instance(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> AppResult<Diagnosis> {
    diagnose_instance_inner(state.inner().as_ref(), version_id, instance_id).map_err(expected)
}

pub(crate) fn diagnose_instance_inner(
    state: &LauncherState,
    version_id: String,
    instance_id: Option<String>,
) -> Result<Diagnosis, String> {
    let data = state.snapshot()?;
    let instance = instance_id
        .as_ref()
        .and_then(|id| data.instances.iter().find(|i| &i.id == id));
    if instance_id.is_some() && instance.is_none() {
        return Err("实例不存在".into());
    }
    let root = crate::minecraft::game_directory(&data.config, &version_id, instance)?;
    let crashes = safe_join(&root, "crash-reports")?;
    let mut candidates = Vec::new();
    if let Ok(entries) = std::fs::read_dir(crashes) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "txt")
                && entry.file_type().is_ok_and(|t| t.is_file())
            {
                candidates.push(path);
            }
        }
    }
    candidates.sort_by_key(|path| std::fs::metadata(path).and_then(|m| m.modified()).ok());
    let path = candidates.pop().or_else(|| {
        safe_join(&root, "logs/latest.log")
            .ok()
            .filter(|path| path.is_file())
    });
    let text = if let Some(path) = &path {
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        read_tail_lines(&mut file, size, DIAGNOSTIC_TAIL_BYTES).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let excerpt = redact(&text);
    Ok(Diagnosis {
        kind: classify(&text),
        log_path: path.map(|p| p.to_string_lossy().into_owned()),
        excerpt,
    })
}
const DIAGNOSTIC_TAIL_BYTES: u64 = 256 * 1024;

/// Read at most `max_bytes` from the end of a file of `size` bytes. When that
/// window starts in the middle of a line, the fragment is dropped: it is not a
/// whole log record, and a credential cut at the window edge would no longer
/// match any redaction rule.
fn read_tail_lines(file: &mut std::fs::File, size: u64, max_bytes: u64) -> io::Result<String> {
    let tail_bytes = size.min(max_bytes);
    let start = size - tail_bytes;
    let mut partial_first_line = false;
    if start > 0 {
        // The tail starts in the middle of a line only when the byte before it
        // is not a newline. At an exact line boundary the first line is whole.
        let mut previous = [0u8; 1];
        file.seek(std::io::SeekFrom::Start(start - 1))?;
        file.read_exact(&mut previous)?;
        partial_first_line = previous[0] != b'\n';
    }
    file.seek(std::io::SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity(tail_bytes as usize);
    file.take(tail_bytes).read_to_end(&mut bytes)?;
    if partial_first_line {
        match bytes.iter().position(|&byte| byte == b'\n') {
            Some(end) => {
                bytes.drain(..=end);
            }
            None => bytes.clear(),
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

const GAME_LOG_TAIL_BYTES: u64 = 2 * 1024 * 1024;
const GAME_LOG_MAX_LINES: usize = 5000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GameLogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLogLine {
    pub time: Option<String>,
    pub thread: Option<String>,
    pub level: GameLogLevel,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLog {
    pub path: Option<String>,
    pub lines: Vec<GameLogLine>,
    pub truncated: bool,
}

/// Split one log record header from its message. A continuation line (a stack
/// frame, `Caused by:`, or a bare `...`) has no header and is appended to the
/// previous record, so its level and timestamp stay those of the record.
fn game_log_record(line: &str) -> Option<(Option<String>, Option<String>, GameLogLevel, &str)> {
    let rest = line.strip_prefix('[')?;
    let (time, rest) = rest.split_once(']')?;
    let rest = rest.trim_start().strip_prefix('[')?;
    let (thread_level, message) = rest.split_once(']')?;
    let (thread, level) = thread_level.rsplit_once('/')?;
    let level = match level.trim().to_ascii_uppercase().as_str() {
        "ERROR" | "FATAL" => GameLogLevel::Error,
        "WARN" | "WARNING" => GameLogLevel::Warn,
        "INFO" => GameLogLevel::Info,
        "DEBUG" | "TRACE" => GameLogLevel::Debug,
        _ => GameLogLevel::Other,
    };
    let message = message.strip_prefix(':').unwrap_or(message).trim_start();
    Some((
        (!time.trim().is_empty()).then(|| time.trim().to_owned()),
        (!thread.trim().is_empty()).then(|| thread.trim().to_owned()),
        level,
        message,
    ))
}

fn parse_game_log<'a>(lines: impl IntoIterator<Item = &'a str>) -> Vec<GameLogLine> {
    let mut records: Vec<GameLogLine> = Vec::new();
    for line in lines {
        if let Some((time, thread, level, message)) = game_log_record(line) {
            records.push(GameLogLine {
                time,
                thread,
                level,
                message: message.to_owned(),
            });
        } else if let Some(previous) = records.last_mut() {
            previous.message.push('\n');
            previous.message.push_str(line);
        } else if !line.is_empty() {
            records.push(GameLogLine {
                time: None,
                thread: None,
                level: GameLogLevel::Other,
                message: line.to_owned(),
            });
        }
    }
    for record in &mut records {
        record.message = redact(&record.message);
    }
    records
}

fn read_game_log_file(root: &Path) -> Result<GameLog, String> {
    let path = safe_join(root, "logs/latest.log")?;
    let size = match std::fs::symlink_metadata(&path) {
        Ok(metadata) if crate::resources::linked(&metadata) => {
            return Err("日志路径包含符号链接或目录联接，拒绝读取外部目标".into());
        }
        Ok(metadata) if metadata.is_file() => metadata.len(),
        Ok(_) => {
            return Ok(GameLog { path: None, lines: Vec::new(), truncated: false });
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(GameLog { path: None, lines: Vec::new(), truncated: false });
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut file = std::fs::File::open(&path).map_err(|error| error.to_string())?;
    // A partial first line is not a log record and must not become a synthetic
    // first entry.
    let text = read_tail_lines(&mut file, size, GAME_LOG_TAIL_BYTES)
        .map_err(|error| error.to_string())?;
    let mut lines: Vec<&str> = text.lines().collect();
    let mut truncated = size > GAME_LOG_TAIL_BYTES;
    if lines.len() > GAME_LOG_MAX_LINES {
        let extra = lines.len() - GAME_LOG_MAX_LINES;
        lines.drain(..extra);
        truncated = true;
    }
    Ok(GameLog {
        path: Some(path.to_string_lossy().into_owned()),
        lines: parse_game_log(lines),
        truncated,
    })
}

pub(crate) fn read_game_log_inner(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
) -> Result<GameLog, String> {
    // Resolve the directory with the same rules as diagnose_instance: a
    // registered instance controls its own directory, otherwise the version
    // directory (or the configured root) is used.
    let data = state.snapshot()?;
    let instance = instance_id.and_then(|id| data.instances.iter().find(|i| &i.id == id));
    if instance_id.is_some() && instance.is_none() {
        return Err("实例不存在".into());
    }
    let root = crate::minecraft::game_directory(&data.config, version_id, instance)?;
    read_game_log_file(&root)
}

#[tauri::command]
pub async fn read_game_log(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> AppResult<GameLog> {
    let state = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        read_game_log_inner(state.as_ref(), &version_id, instance_id.as_deref())
    })
    .await
    .map_err(|error| expected(error.to_string()))?;
    result.map_err(expected)
}

#[tauri::command]
pub fn export_diagnostics(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    output_path: String,
) -> crate::errors::AppResult<String> {
    let output_path = grants.consume(PathUse::Diagnostics, &output_path, &window)?.to_string_lossy().into_owned();
    let report = diagnostic_export_text(state.inner().as_ref(), &version_id, instance_id.as_deref(),
        &chrono::Utc::now().to_rfc3339())?;
    write_diagnostics_file(Path::new(&output_path), report.as_bytes())?;
    Ok(output_path)
}

/// The exported report text, in the interface language, from a redacted excerpt.
fn diagnostic_export_text(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
    generated_at: &str,
) -> Result<String, String> {
    let diagnosis = diagnose_instance_inner(state, version_id.to_owned(), instance_id.map(str::to_owned))?;
    Ok(render_diagnostic_report_for_locale(
        diagnosis.kind,
        interface_locale(&state.snapshot()?.config),
        version_id,
        instance_id,
        &diagnosis.excerpt,
        generated_at,
    ))
}
fn diagnostic_locale_by_code(locale: &str) -> &'static serde_json::Value {
    static REPORT_LOCALES: std::sync::LazyLock<[serde_json::Value; 7]> = std::sync::LazyLock::new(|| {
        [
            include_str!("../../src/i18n/locales/zh-CN/library.json"),
            include_str!("../../src/i18n/locales/zh-TW/library.json"),
            include_str!("../../src/i18n/locales/en-US/library.json"),
            include_str!("../../src/i18n/locales/ja-JP/library.json"),
            include_str!("../../src/i18n/locales/ko-KR/library.json"),
            include_str!("../../src/i18n/locales/ru-RU/library.json"),
            include_str!("../../src/i18n/locales/es-ES/library.json"),
        ]
        .map(|raw| serde_json::from_str(raw).expect("bundled library locale is valid JSON"))
    });
    let index = SUPPORTED_REPORT_LOCALES
        .iter()
        .position(|candidate| *candidate == locale)
        .unwrap_or(2);
    &REPORT_LOCALES[index]
}

fn diagnostic_translation_for_locale(locale: &str, keys: &[&str]) -> Option<&'static str> {
    fn lookup(locale: &str, keys: &[&str]) -> Option<&'static str> {
        keys.iter()
            .try_fold(diagnostic_locale_by_code(locale), |value, key| value.get(key))?
            .as_str()
    }
    lookup(locale, keys).or_else(|| lookup("en-US", keys))
}

#[cfg(test)]
fn render_diagnostic_report(
    kind: DiagnosisKind,
    zh: bool,
    version_id: &str,
    instance_id: Option<&str>,
    excerpt: &str,
    now: &str,
) -> String {
    render_diagnostic_report_for_locale(
        kind,
        if zh { "zh-CN" } else { "en-US" },
        version_id,
        instance_id,
        excerpt,
        now,
    )
}

fn render_diagnostic_report_for_locale(
    kind: DiagnosisKind,
    locale: &str,
    version_id: &str,
    instance_id: Option<&str>,
    excerpt: &str,
    now: &str,
) -> String {
    let label = |key| {
        diagnostic_translation_for_locale(locale, &["diagnosticReport", key])
            .expect("required diagnostic report label")
    };
    let diagnosis = |key| diagnostic_translation_for_locale(locale, &["diagnosis", kind.locale_key(), key]);
    let separator = if matches!(locale, "zh-CN" | "zh-TW" | "ja-JP") {
        "："
    } else {
        ": "
    };
    let title = diagnosis("title").expect("required diagnosis title");
    let reason = diagnosis("reason").expect("required diagnosis reason");
    let mut suggestions = diagnosis("firstSuggestion").expect("required diagnosis suggestion").to_owned();
    if let Some(second) = diagnosis("secondSuggestion") {
        suggestions.push('\n');
        suggestions.push_str(second);
    }
    let instance = instance_id.unwrap_or_else(|| label("noInstance"));
    format!(
        "Voxelight Launcher {} {}\n{}{separator}{now}\n{}{separator}{version_id}\n{}{separator}{instance}\n{}{separator}{title}\n{}{separator}{reason}\n{}{}\n{suggestions}\n\n{}{}\n{excerpt}\n",
        env!("CARGO_PKG_VERSION"),
        label("title"),
        label("time"),
        label("version"),
        label("instance"),
        label("conclusion"),
        label("reason"),
        label("suggestions"),
        separator.trim_end(),
        label("excerpt"),
        separator.trim_end(),
    )
}

fn write_diagnostics_file(destination: &Path, report: &[u8]) -> Result<(), String> {
    if !destination.is_absolute()
        || !destination.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("txt"))
    {
        return Err("请选择绝对路径的 .txt 诊断报告文件".into());
    }
    let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(destination)
        .map_err(|error| if error.kind() == io::ErrorKind::AlreadyExists {
            "报告文件已存在，请选择新文件名以保留原文件".to_owned()
        } else { error.to_string() })?;
    file.write_all(report).and_then(|()| file.sync_all()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    const DIAGNOSIS_REPORTS: [(super::DiagnosisKind, &str); 7] = [
        (super::DiagnosisKind::Memory, "memory"),
        (super::DiagnosisKind::Java, "java"),
        (super::DiagnosisKind::Mods, "mods"),
        (super::DiagnosisKind::Graphics, "graphics"),
        (super::DiagnosisKind::Directory, "directory"),
        (super::DiagnosisKind::Unknown, "unknown"),
        (super::DiagnosisKind::Empty, "empty"),
    ];

    #[test]
    fn diagnostic_report_preserves_legacy_chinese_wording_for_every_kind() {
        let snapshots: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/diagnostic-report-zh-legacy.json"
        )).unwrap();
        for (kind, key) in DIAGNOSIS_REPORTS {
            let expected = snapshots[key].as_str().unwrap()
                .replace("{PACKAGE_VERSION}", env!("CARGO_PKG_VERSION"));
            let report = super::render_diagnostic_report(
                kind, true, "fixture-version", Some("fixture-instance"), "fixture-excerpt", "fixture-time",
            );
            assert_eq!(report.replace("实例：fixture-instance\n", "实例：Some(\"fixture-instance\")\n"), expected, "{key}");
        }
    }

    #[test]
    fn diagnostic_report_locale_keys_cover_every_kind_without_relying_on_fallback() {
        for code in super::SUPPORTED_REPORT_LOCALES {
            let locale = super::diagnostic_locale_by_code(code);
            let translated = |value: &serde_json::Value| value.as_str().is_some_and(|s| !s.trim().is_empty());
            for key in ["title", "time", "version", "instance", "noInstance", "conclusion",
                        "reason", "suggestions", "excerpt"] {
                assert!(translated(&locale["diagnosticReport"][key]), "{code}/{key}");
            }
            for (kind, key) in DIAGNOSIS_REPORTS {
                assert_eq!(kind.locale_key(), key);
                for field in ["title", "reason", "firstSuggestion"] {
                    assert!(translated(&locale["diagnosis"][key][field]), "{code}/{key}/{field}");
                }
                assert_eq!(translated(&locale["diagnosis"][key]["secondSuggestion"]), key != "empty");
            }
        }
    }

    #[test]
    fn diagnostic_report_english_includes_plain_instance_and_keeps_excerpt_redacted() {
        let excerpt = super::redact("access_token=fixture-credential");
        let report = super::render_diagnostic_report(
            super::DiagnosisKind::Memory, false, "1.21.1", Some("fixture-instance"), &excerpt, "fixture-time",
        );
        assert!(report.contains("Diagnostic report"), "{report}");
        assert!(report.contains("Time: fixture-time\nGame version: 1.21.1\nInstance: fixture-instance\n"));
        assert!(report.contains("Conclusion: Out of memory\n"));
        assert!(report.contains("access_token=[已隐藏]"));
        assert!(!report.contains("fixture-credential"));
    }

    #[test]
    fn diagnostic_report_missing_instance_has_a_localized_label() {
        for (zh, label) in [(true, "实例：无实例"), (false, "Instance: No instance")] {
            let report = super::render_diagnostic_report(
                super::DiagnosisKind::Empty, zh, "fixture-version", None, "", "fixture-time",
            );
            assert!(report.lines().any(|line| line == label), "{report}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn r4_configured_junction_resolves_before_validation_of_instance_children() {
        struct Junction(std::path::PathBuf);
        impl Drop for Junction {
            fn drop(&mut self) { let _ = std::fs::remove_dir(&self.0); }
        }
        let owned = crate::instances::StagingDirectory::create(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/game-path-tests")
                .join(uuid::Uuid::new_v4().to_string())
        ).unwrap();
        let physical = owned.path().join("physical");
        let alias = owned.path().join("alias");
        std::fs::create_dir(&physical).unwrap();
        let junction = |alias: &std::path::Path, target: &std::path::Path| {
            let output = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(alias.to_string_lossy().replace('/', r"\"))
                .arg(target.to_string_lossy().replace('/', r"\")).output().unwrap();
            assert!(output.status.success(), "{output:?}");
            Junction(alias.to_owned())
        };
        let _root_junction = junction(&alias, &physical);
        let root = alias.join("games");
        let config = crate::models::Config {
            game_directory: root.display().to_string(), version_isolation: true, ..Default::default()
        };
        let version = crate::minecraft::game_directory(&config, "1.20.1", None).unwrap();
        assert_eq!(version, physical.join("games/versions/1.20.1"));
        let game = root.join("instances/game");
        let instance = crate::models::Instance {
            id: "game".into(), game_directory: game.display().to_string(),
            version_id: "1.20.1".into(), ..Default::default()
        };
        let resolved = crate::minecraft::game_directory(&config, "1.20.1", Some(&instance)).unwrap();
        assert_eq!(resolved, physical.join("games/instances/game"));
        std::fs::create_dir_all(resolved.parent().unwrap()).unwrap();
        let _child_junction = junction(&resolved, &physical);
        assert!(crate::minecraft::game_directory(&config, "1.20.1", Some(&instance)).is_err(),
            "links below the approved root must remain forbidden");
    }
    use super::*;

    struct GameLogFixture {
        root: PathBuf,
        state: LauncherState,
        game: PathBuf,
    }

    impl GameLogFixture {
        fn new(contents: Option<&[u8]>) -> Self {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/game-log-tests")
                .join(uuid::Uuid::new_v4().to_string());
            let data = root.join("data");
            let game = root.join("game");
            std::fs::create_dir_all(&data).unwrap();
            std::fs::create_dir_all(game.join("logs")).unwrap();
            if let Some(contents) = contents {
                std::fs::write(game.join("logs/latest.log"), contents).unwrap();
            }
            let state = LauncherState::test_fixture(
                data,
                crate::models::Persisted::default(),
                crate::storage::test_client(),
            );
            state.update(|profile| {
                profile.config.game_directory = game.display().to_string();
                profile.config.version_isolation = false;
                Ok(())
            }).unwrap();
            Self { root, state, game }
        }

        fn read(&self) -> Result<GameLog, String> {
            read_game_log_inner(&self.state, "1.21.1", None)
        }

        fn cleanup(self) {
            drop(self.state);
            let _ = std::fs::remove_dir_all(self.root);
        }
    }

    #[test]
    fn game_log_parses_vanilla_loader_and_dated_record_shapes() {
        let fixture = GameLogFixture::new(Some(concat!(
            "[12:34:56] [Server thread/INFO]: Starting minecraft server version 1.21.1\n",
            "[12:34:56] [main/WARN] (Mod) risky option\n",
            "[23Nov2026 12:34:56.789] [Render thread/ERROR] [com.example.Mod/]: boom\n",
        ).as_bytes()));
        let log = fixture.read().unwrap();
        let path = log.path.as_deref().expect("existing log path");
        assert!(path.replace('\\', "/").ends_with("/logs/latest.log"), "{path}");
        assert!(Path::new(path).is_file(), "{path}");
        assert!(!log.truncated);
        assert_eq!(log.lines.len(), 3, "{:?}", log.lines);
        assert_eq!(log.lines[0].time.as_deref(), Some("12:34:56"));
        assert_eq!(log.lines[0].thread.as_deref(), Some("Server thread"));
        assert_eq!(log.lines[0].level, GameLogLevel::Info);
        assert_eq!(log.lines[0].message, "Starting minecraft server version 1.21.1");
        assert_eq!(log.lines[1].thread.as_deref(), Some("main"));
        assert_eq!(log.lines[1].level, GameLogLevel::Warn);
        assert_eq!(log.lines[1].message, "(Mod) risky option");
        assert_eq!(log.lines[2].time.as_deref(), Some("23Nov2026 12:34:56.789"));
        assert_eq!(log.lines[2].level, GameLogLevel::Error);
        assert_eq!(log.lines[2].message, "[com.example.Mod/]: boom");
        fixture.cleanup();
    }

    #[test]
    fn game_log_continuations_keep_the_previous_record_and_level() {
        let fixture = GameLogFixture::new(Some(concat!(
            "[12:34:56] [main/ERROR]: java.lang.RuntimeException: boom\n",
            "\tat net.minecraft.Foo.bar(Foo.java:1)\n",
            "Caused by: java.lang.IllegalStateException: bad\n",
            "[12:34:56] [main/INFO]: recovered\n",
        ).as_bytes()));
        let log = fixture.read().unwrap();
        assert_eq!(log.lines.len(), 2, "{:?}", log.lines);
        assert_eq!(log.lines[0].level, GameLogLevel::Error);
        assert_eq!(
            log.lines[0].message,
            "java.lang.RuntimeException: boom\n\tat net.minecraft.Foo.bar(Foo.java:1)\nCaused by: java.lang.IllegalStateException: bad",
        );
        assert_eq!(log.lines[1].message, "recovered");
        fixture.cleanup();
    }

    #[test]
    fn game_log_maps_fatal_to_error_and_trace_to_debug() {
        let fixture = GameLogFixture::new(Some(concat!(
            "[12:34:56] [main/FATAL]: fatal failure\n",
            "[12:34:56] [main/TRACE]: detailed trace\n",
            "[12:34:56] [main/DEBUG]: debug detail\n",
            "[12:34:56] [main/INFO]: ordinary\n",
        ).as_bytes()));
        let levels: Vec<_> = fixture.read().unwrap().lines.into_iter().map(|line| line.level).collect();
        assert_eq!(
            levels,
            [GameLogLevel::Error, GameLogLevel::Debug, GameLogLevel::Debug, GameLogLevel::Info],
        );
        fixture.cleanup();
    }

    #[test]
    fn game_log_redacts_credentials_in_every_message() {
        let fixture = GameLogFixture::new(Some(concat!(
            "[12:34:56] [main/INFO]: connecting access_token=fixture-secret-token now\n",
            "[12:34:56] [main/INFO]: open https://fixture-user:fixture-pass@example.invalid/path\n",
        ).as_bytes()));
        let log = fixture.read().unwrap();
        assert!(!log.lines[0].message.contains("fixture-secret-token"), "{:?}", log.lines);
        assert!(log.lines[0].message.contains("[已隐藏]"), "{:?}", log.lines);
        assert!(!log.lines[1].message.contains("fixture-user"), "{:?}", log.lines);
        assert!(!log.lines[1].message.contains("fixture-pass"), "{:?}", log.lines);
        assert!(log.lines[1].message.contains("example.invalid/path"), "{:?}", log.lines);
        fixture.cleanup();
    }

    #[test]
    fn game_log_reads_only_the_last_two_mebibytes() {
        let mut content = String::new();
        while content.len() <= 2 * 1024 * 1024 {
            content.push_str("[12:34:56] [main/INFO]: filler line for the tail limit\n");
        }
        content.push_str("[12:34:56] [main/INFO]: tail marker\n");
        let fixture = GameLogFixture::new(Some(content.as_bytes()));
        let log = fixture.read().unwrap();
        assert!(log.truncated);
        assert_eq!(log.lines.last().map(|line| line.message.as_str()), Some("tail marker"));
        assert!(log.lines.len() <= GAME_LOG_MAX_LINES);
        fixture.cleanup();
    }

    #[test]
    fn game_log_keeps_at_most_the_last_five_thousand_lines() {
        let mut content = String::new();
        for index in 1..=GAME_LOG_MAX_LINES + 1 {
            content.push_str(&format!("[12:34:56] [main/INFO]: line {index}\n"));
        }
        let fixture = GameLogFixture::new(Some(content.as_bytes()));
        let log = fixture.read().unwrap();
        assert!(log.truncated);
        assert_eq!(log.lines.len(), GAME_LOG_MAX_LINES);
        assert_eq!(log.lines.first().map(|line| line.message.as_str()), Some("line 2"));
        assert_eq!(log.lines.last().map(|line| line.message.as_str()), Some("line 5001"));
        fixture.cleanup();
    }

    #[test]
    fn game_log_missing_file_has_no_path_and_no_lines() {
        let fixture = GameLogFixture::new(None);
        let log = fixture.read().unwrap();
        assert_eq!(log.path, None);
        assert!(log.lines.is_empty());
        assert!(!log.truncated);
        fixture.cleanup();
    }

    #[cfg(windows)]
    #[test]
    fn game_log_refuses_a_junction_at_logs() {
        let fixture = GameLogFixture::new(None);
        let target = fixture.root.join("junction-target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(
            target.join("latest.log"),
            "[12:34:56] [main/INFO]: should not be reachable\n",
        ).unwrap();
        std::fs::remove_dir(fixture.game.join("logs")).unwrap();
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(fixture.game.join("logs").to_string_lossy().replace('/', r"\"))
            .arg(target.to_string_lossy().replace('/', r"\"))
            .output().unwrap();
        assert!(output.status.success(), "{output:?}");
        let error = fixture.read().unwrap_err();
        assert!(error.contains("符号链接") || error.contains("目录联接"), "{error}");
        std::fs::remove_dir(fixture.game.join("logs")).unwrap();
        fixture.cleanup();
    }

    #[test]
    fn diagnostics_report_accepts_mixed_case_txt_and_leaves_other_extensions_unwritten() {
        let fixture = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/diagnostic-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let not_txt = fixture.path().join("report.txt.bak");
        assert_eq!(
            write_diagnostics_file(&not_txt, b"not a report"),
            Err("请选择绝对路径的 .txt 诊断报告文件".into()),
        );
        assert!(!not_txt.exists());
        let report = fixture.path().join("Report.TxT");
        write_diagnostics_file(&report, b"diagnostics").unwrap();
        assert_eq!(std::fs::read(report).unwrap(), b"diagnostics");
    }

    #[test]
    fn diagnostics_create_new_preserves_an_existing_file() {
        let fixture = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/diagnostic-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let report = fixture.path().join("Existing.TXT");
        std::fs::write(&report, b"previous report").unwrap();
        assert_eq!(
            write_diagnostics_file(&report, b"replacement"),
            Err("报告文件已存在，请选择新文件名以保留原文件".into()),
        );
        assert_eq!(std::fs::read(&report).unwrap(), b"previous report");
    }

    const STOP_FIXTURE_DIR: &str = "VOXELIGHT_M09_OWNED_TEST_DIR";

    #[test]
    fn game_stop_child_fixture() {
        let Some(directory) = std::env::var_os(STOP_FIXTURE_DIR) else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        std::fs::write(directory.join("ready"), b"owned fixture").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while !directory.join("exit").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        std::fs::write(directory.join("saved"), b"normal exit").unwrap();
    }

    #[test]
    fn m09_stop_does_not_force_a_headless_owned_child_without_explicit_consent() {
        use std::{fs, time::Duration};
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/process-tests")
                .join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(&directory).unwrap();
            let child = spawn_stop_fixture(&directory);
            tokio::time::timeout(Duration::from_secs(2), async {
                while !directory.join("ready").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let pid = child.id().unwrap();
            let (actor, handle) = crate::game_process::GameProcess::new(child);
            let mut wait = tokio::spawn(actor.wait());
            let registry = GameRegistry::default();
            // Stale and live identities deliberately share a displayed PID in
            // this in-memory fixture. Only the exact owned identity can resolve.
            registry.games.lock().unwrap().insert(
                "owned".into(),
                TrackedGame {
                    info: RunningGame {
                        game_id: "owned".into(),
                        pid,
                        version_id: "owned-fixture".into(),
                        instance_id: None,
                        game_directory: directory.to_string_lossy().into_owned(),
                        started_at: chrono::Utc::now().to_rfc3339(),
                        library_root: String::new(),
                    },
                    clock: Instant::now(),
                    owner: Some(Arc::new(handle)),
                },
            );
            assert!(registry.stop_handle("stale").is_err());
            let owner = registry.stop_handle("owned").unwrap();
            assert_eq!(
                confirm_and_force(&owner, || async {
                    panic!("no prompt before graceful stop")
                })
                .await
                .unwrap(),
                StopStatus::ForceRequired
            );
            assert_eq!(
                owner.request(true).await.unwrap(),
                StopStatus::ForceRequired
            );
            assert_eq!(
                owner.request(false).await.unwrap(),
                StopStatus::ForceRequired
            );
            assert_eq!(
                confirm_and_force(&owner, || async { false }).await.unwrap(),
                StopStatus::Declined
            );
            assert!(tokio::time::timeout(Duration::from_millis(80), &mut wait)
                .await
                .is_err());
            assert!(!directory.join("saved").exists());
            fs::write(directory.join("exit"), b"exit").unwrap();
            assert!(wait.await.unwrap().unwrap().success());
            assert_eq!(fs::read(directory.join("saved")).unwrap(), b"normal exit");
            assert_eq!(
                confirm_and_force(&owner, || async { true }).await.unwrap(),
                StopStatus::Stopped
            );
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn m09_confirmed_force_reaps_only_its_own_child() {
        use std::{fs, time::Duration};
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let first = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/process-tests")
                .join(uuid::Uuid::new_v4().to_string());
            let other = first.join("other");
            fs::create_dir_all(&other).unwrap();
            let (actor, owner) = crate::game_process::GameProcess::new(spawn_stop_fixture(&first));
            let mut unrelated = spawn_stop_fixture(&other);
            let wait = tokio::spawn(actor.wait());
            tokio::time::timeout(Duration::from_secs(2), async {
                while !first.join("ready").exists() || !other.join("ready").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(
                owner.request(false).await.unwrap(),
                StopStatus::ForceRequired
            );
            assert_eq!(
                confirm_and_force(&owner, || async { true }).await.unwrap(),
                StopStatus::Stopped
            );
            assert!(!wait.await.unwrap().unwrap().success());
            assert!(unrelated.try_wait().unwrap().is_none());
            fs::write(other.join("exit"), b"exit").unwrap();
            assert!(unrelated.wait().await.unwrap().success());
            assert!(!first.join("saved").exists());
            assert!(other.join("saved").exists());
            fs::remove_dir_all(first).unwrap();
        });
    }

    fn spawn_stop_fixture(directory: &Path) -> tokio::process::Child {
        use std::process::Stdio;
        tokio::process::Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("processes::tests::game_stop_child_fixture")
            .env(STOP_FIXTURE_DIR, directory)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    #[test]
    fn diagnostic_ipc_publishes_a_stable_kind_and_preserves_the_log_excerpt() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/diagnostic-tests").join(uuid::Uuid::new_v4().to_string());
        let data = root.join("data");
        let game = root.join("game");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(game.join("logs")).unwrap();
        let sample = "Synthetic Java fixture: java.lang.OutOfMemoryError";
        std::fs::write(game.join("logs/latest.log"), sample).unwrap();
        let state = LauncherState::test_fixture(
            data, crate::models::Persisted::default(), crate::storage::test_client(),
        );
        state.update(|profile| {
            profile.config.game_directory = game.display().to_string();
            profile.config.version_isolation = false;
            Ok(())
        }).unwrap();
        let diagnosis = diagnose_instance_inner(&state, "1.21.1".into(), None).unwrap();
        let payload = serde_json::to_value(diagnosis).unwrap();
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(payload["kind"], "memory");
        assert_eq!(payload["excerpt"], sample);
        assert!(payload.get("title").is_none(), "native diagnostics should not send locale-specific titles");
    }

    #[test]
    fn c3_report_language_follows_the_interface_rule() {
        let never = || -> String { panic!("only the system preference reads the OS locale") };
        assert!(report_is_zh("zh-CN", never));
        assert!(!report_is_zh("en-US", never));
        assert!(!report_is_zh("fr-FR", never), "unknown values fall back to English like the UI");
        assert!(report_is_zh("system", || "zh-CN".into()));
        assert!(!report_is_zh("system", || "en-US".into()));
    }

    #[test]
    fn c3_exported_report_uses_the_interface_language_and_redacts_the_log() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/diagnostic-tests").join(uuid::Uuid::new_v4().to_string());
        let data = root.join("data");
        let game = root.join("game");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(game.join("logs")).unwrap();
        let secret = "fixture-export-token";
        std::fs::write(game.join("logs/latest.log"),
            format!("access_token={secret}\nSynthetic Java fixture: java.lang.OutOfMemoryError")).unwrap();
        let state = LauncherState::test_fixture(
            data, crate::models::Persisted::default(), crate::storage::test_client(),
        );
        let report = |language: &str| {
            state.update(|profile| {
                profile.config.game_directory = game.display().to_string();
                profile.config.version_isolation = false;
                profile.config.language = language.into();
                Ok(())
            }).unwrap();
            diagnostic_export_text(&state, "1.21.1", None, "2026-11-20T00:00:00Z").unwrap()
        };
        let zh = report("zh-CN");
        let en = report("en-US");
        drop(state);
        std::fs::remove_dir_all(root).unwrap();
        assert!(zh.contains("诊断报告") && !zh.contains("Diagnostic report"), "{zh}");
        assert!(en.contains("Diagnostic report") && !en.contains("诊断报告"), "{en}");
        assert!(!zh.contains(secret) && !en.contains(secret), "the exported excerpt must be redacted");
    }

    #[test]
    fn c7_userinfo_with_sub_delimiters_is_fully_redacted() {
        for (user, pass) in [("fixture,user", "fixture-pass"), ("fixture-user", "pa;ss"), ("o'user", "p,a;s's")] {
            let clean = redact(&format!("proxy at http://{user}:{pass}@proxy.example.invalid:8080/x done"));
            assert!(!clean.contains(user) && !clean.contains(pass), "{clean}");
            assert!(clean.contains("proxy.example.invalid:8080/x"), "{clean}");
        }
    }

    #[test]
    fn diagnostics_redact_proxy_authorization_and_url_userinfo() {
        let encoded = "fixture-basic-auth-bytes";
        let userinfo = "fixture-proxy-user:fixture-proxy-pass";
        let clean = redact(&format!("Proxy-Authorization: Basic {encoded} https://{userinfo}@proxy.example.invalid/path"));
        assert!(!clean.contains(encoded));
        assert!(!clean.contains(userinfo));
        assert!(clean.contains("proxy.example.invalid"));
    }

    #[test]
    fn diagnostics_redact_client_id_arguments_and_assignments() {
        const ID: &str = "11111111-1111-1111-1111-111111111111";
        for input in [
            format!("--clientId, {ID}"),
            format!("--clientId {ID}"),
            format!("--clientId={ID}"),
            format!("clientid={ID}"),
            format!("--CLIENTID, '{ID}']"),
        ] {
            let masked = redact(&input);
            assert!(!masked.contains(ID));
            assert!(masked.contains("[已隐藏]"));
        }
    }

    #[test]
    fn diagnostics_identify_jvm_and_mod_failures_and_redact_credentials() {
        assert_eq!(
            classify("java.lang.OutOfMemoryError: Java heap space"),
            DiagnosisKind::Memory
        );
        assert_eq!(
            classify("UnsupportedClassVersionError"),
            DiagnosisKind::Java
        );
        assert_eq!(classify("ModResolutionException"), DiagnosisKind::Mods);
        assert_eq!(classify("GLFW error"), DiagnosisKind::Graphics);
        assert_eq!(classify("AccessDeniedException"), DiagnosisKind::Directory);
        assert_eq!(classify("Unclassified fixture"), DiagnosisKind::Unknown);
        assert_eq!(classify(""), DiagnosisKind::Empty);
        let value = redact("access_token=secret123 Authorization: Bearer123 password=private");
        assert!(
            !value.contains("secret123")
                && !value.contains("Bearer123")
                && !value.contains("private")
        );
    }

    const VANILLA_SESSION_TOKEN: &str = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlLXVzZXIiLCJ4dWlkIjoiMDEyMyJ9.Zml4dHVyZS1zaWduYXR1cmU";
    const VANILLA_SESSION_UUID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn redact_masks_vanilla_session_id_log_lines() {
        let line = format!(
            "[12:00:00] [Client thread/INFO]: (Session ID is token:{VANILLA_SESSION_TOKEN}:{VANILLA_SESSION_UUID})"
        );
        let clean = redact(&line);
        assert!(!clean.contains(VANILLA_SESSION_TOKEN), "{clean}");
        assert!(!clean.contains("eyJhbGciOiJIUzI1NiJ9"), "{clean}");
        assert!(clean.contains("(Session ID is <redacted>)"), "{clean}");
        assert!(clean.contains("[12:00:00] [Client thread/INFO]:"), "{clean}");
    }

    #[test]
    fn redact_masks_token_session_strings_and_standalone_jwts() {
        let session = redact(&format!(
            "joined token:{VANILLA_SESSION_TOKEN}:{VANILLA_SESSION_UUID}"
        ));
        assert_eq!(session, "joined token:<redacted>");
        let jwt = redact(&format!("payload {VANILLA_SESSION_TOKEN} received"));
        assert_eq!(jwt, "payload <redacted> received");
    }

    #[test]
    fn redact_masks_a_jwt_whose_header_was_cut_off() {
        let (_, payload_and_signature) = VANILLA_SESSION_TOKEN.split_once('.').unwrap();
        let fragment = format!("ImFsZyI6IkhTMjU2In0.{payload_and_signature}:{VANILLA_SESSION_UUID})");
        assert_eq!(
            redact(&fragment),
            format!("ImFsZyI6IkhTMjU2In0.<redacted>:{VANILLA_SESSION_UUID})"),
        );
    }

    #[test]
    fn redact_masks_access_token_and_session_launch_arguments() {
        // An authlib-injector token can be a bare hex string, which only the
        // argument rule recognizes.
        let token = uuid::Uuid::new_v4().simple().to_string();
        for (input, expected) in [
            (format!("--accessToken, {token}"), "--accessToken, <redacted>"),
            (format!("--accessToken {token}"), "--accessToken <redacted>"),
            (format!("--accessToken={token}"), "--accessToken=<redacted>"),
            (format!("--session {token}"), "--session <redacted>"),
            (format!("--session, {token}"), "--session, <redacted>"),
            (format!("--session={token}"), "--session=<redacted>"),
            (
                format!("[--username, Steve, --accessToken, {token}, --version, 1.8.9]"),
                "[--username, Steve, --accessToken, <redacted>, --version, 1.8.9]",
            ),
        ] {
            assert_eq!(redact(&input), expected, "{input}");
        }
    }

    #[test]
    fn redact_fully_masks_values_that_contain_or_start_with_an_angle_bracket() {
        for (input, expected) in [
            (
                "jdbc:mysql://db/mc?user=mc&password=ab<cdefgh",
                "jdbc:mysql://db/mc?user=mc&password=[已隐藏]",
            ),
            ("password=<hunter2>", "password=[已隐藏]"),
            ("x-api-key: <k3y>", "x-api-key: [已隐藏]"),
            (r#"client_secret="x<yz123""#, r#"client_secret="[已隐藏]""#),
            ("-Dhttp.proxyPassword=p<ss", "-Dhttp.proxyPassword=[已隐藏]"),
        ] {
            assert_eq!(redact(input), expected, "{input}");
        }
        // Only the exact marker left by the earlier rules is kept as it is.
        assert_eq!(redact("access_token=<redacted>"), "access_token=<redacted>");
        assert_eq!(redact("access_token=<redacted>tail"), "access_token=[已隐藏]");
    }

    #[test]
    fn redact_masks_comma_separated_token_assignments() {
        for input in [
            "access_token, fixture-access-value",
            "refresh_token, fixture-refresh-value",
        ] {
            let clean = redact(input);
            assert!(!clean.contains("fixture-"), "{clean}");
            assert!(clean.contains("[已隐藏]"), "{clean}");
        }
        assert_eq!(redact("authorization, of course"), "authorization, of course");
    }

    #[test]
    fn registered_launch_credentials_are_masked_without_a_key() {
        let token = format!("fixture-registered-token-{}", uuid::Uuid::new_v4().simple());
        let session = format!("token:{token}:{VANILLA_SESSION_UUID}");
        register_launch_credentials(&token, VANILLA_SESSION_UUID);
        assert_eq!(redact(&format!("random text {token} more")), "random text <redacted> more");
        assert_eq!(redact(&format!("random text {session} more")), "random text <redacted> more");

        let unregistered = format!("fixture-unregistered-token-{}", uuid::Uuid::new_v4());
        assert_eq!(
            redact(&format!("random text {unregistered} more")),
            format!("random text {unregistered} more"),
        );
    }

    #[test]
    fn secret_registry_ignores_short_values_and_offline_launches() {
        let mut registry = SecretRegistry::default();
        registry.insert("short-secret");
        registry.insert("0");
        registry.insert_launch_credentials("0", VANILLA_SESSION_UUID);
        assert!(registry.values.is_empty(), "{:?}", registry.values);
        assert_eq!(
            registry.mask("random text short-secret and 0 more"),
            "random text short-secret and 0 more",
        );
    }

    #[test]
    fn secret_registry_is_bounded_and_drops_the_oldest_value_first() {
        let mut registry = SecretRegistry::default();
        let fill: Vec<String> = (0..REGISTERED_SECRET_LIMIT)
            .map(|index| format!("fixture-bounded-secret-{index:04}"))
            .collect();
        for value in &fill {
            registry.insert(value);
        }
        assert_eq!(registry.values, fill);

        // A launch registers its token and then the session string; both must
        // survive in a full registry.
        let token = "fixture-bounded-launch-token";
        let session = format!("token:{token}:{VANILLA_SESSION_UUID}");
        registry.insert_launch_credentials(token, VANILLA_SESSION_UUID);
        assert_eq!(registry.values.len(), REGISTERED_SECRET_LIMIT, "the registry must stay bounded");
        assert_eq!(
            registry.values[REGISTERED_SECRET_LIMIT - 2..].to_vec(),
            vec![token.to_owned(), session.clone()],
        );
        assert_eq!(registry.values[0], fill[2], "the two oldest values are dropped");
        assert_eq!(registry.mask(&format!("{token} {session}")), "<redacted> <redacted>");
        assert_eq!(registry.mask(&fill[1]), fill[1]);

        // A value registered again becomes the newest and outlives older ones.
        registry.insert(&fill[2]);
        registry.insert("fixture-bounded-secret-next");
        assert!(registry.values.contains(&fill[2]), "{:?}", registry.values);
        assert!(!registry.values.contains(&fill[3]), "{:?}", registry.values);
    }

    #[test]
    fn launch_registers_its_credentials_before_passing_them_to_the_game() {
        let source = crate::storage::executable_source(include_str!("minecraft.rs"));
        let (_, launch) = source.split_once("async fn launch_prepared(").unwrap();
        let (launch, _) = launch.split_once("\n}").unwrap();
        let registered = launch
            .find("crate::processes::register_launch_credentials(access_token, player_uuid);")
            .expect("launch registers the token it passes to the game");
        assert!(registered < launch.find("(\"auth_access_token\", access_token)").unwrap());
        assert!(registered < launch.find("(\"auth_session\", access_token)").unwrap());
    }

    #[test]
    fn tail_reading_drops_only_a_partial_first_line() {
        let fixture = GameLogFixture::new(Some(b"first line\nsecond line\nthird"));
        let path = fixture.game.join("logs/latest.log");
        let read = |max_bytes: usize| {
            let mut file = std::fs::File::open(&path).unwrap();
            let size = file.metadata().unwrap().len();
            read_tail_lines(&mut file, size, max_bytes as u64).unwrap()
        };
        assert_eq!(read(1024), "first line\nsecond line\nthird");
        assert_eq!(
            read("second line\nthird".len()),
            "second line\nthird",
            "a window that starts at a line keeps that line",
        );
        assert_eq!(read("cond line\nthird".len()), "third");
        assert_eq!(read("hird".len()), "");
        fixture.cleanup();
    }

    #[test]
    fn diagnostic_excerpt_starts_at_a_line_so_a_cut_session_line_leaks_nothing() {
        let (_, payload_and_signature) = VANILLA_SESSION_TOKEN.split_once('.').unwrap();
        let (payload, signature) = payload_and_signature.split_once('.').unwrap();
        // An authlib-injector token is a bare hex string and is not in the
        // registry after a launcher restart.
        let hex_token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let prefix = "[12:00:00] [Client thread/INFO]: (Session ID is ";
        let filler = "[12:00:01] [Client thread/INFO]: filler line for the diagnostic window\n";
        for (token, window_start, secrets) in [
            // The window starts inside "token:".
            (hex_token.as_str(), prefix.len() + "tok".len(), vec![hex_token.as_str()]),
            // The window starts inside the JWT header.
            (
                VANILLA_SESSION_TOKEN,
                prefix.len() + "token:eyJhb".len(),
                vec![VANILLA_SESSION_TOKEN, payload, signature],
            ),
        ] {
            let total = window_start + DIAGNOSTIC_TAIL_BYTES as usize;
            let mut content = format!("{prefix}token:{token}:{VANILLA_SESSION_UUID})\n");
            while content.len() + filler.len() < total {
                content.push_str(filler);
            }
            content.push_str(&"x".repeat(total - content.len() - 1));
            content.push('\n');
            assert_eq!(content.len(), total);

            let fixture = GameLogFixture::new(Some(content.as_bytes()));
            let diagnosis = diagnose_instance_inner(&fixture.state, "1.21.1".into(), None).unwrap();
            fixture.cleanup();
            let head: String = diagnosis.excerpt.chars().take(120).collect();
            for secret in secrets {
                assert!(!diagnosis.excerpt.contains(secret), "{head}");
            }
            assert!(diagnosis.excerpt.starts_with(filler), "{head}");
        }
    }

    #[test]
    fn game_log_and_diagnostics_redact_vanilla_session_lines() {
        let line = format!(
            "[12:00:00] [Client thread/INFO]: (Session ID is token:{VANILLA_SESSION_TOKEN}:{VANILLA_SESSION_UUID})"
        );
        let records = parse_game_log([line.as_str()]);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].message, "(Session ID is <redacted>)");

        let fixture = GameLogFixture::new(Some(format!("{line}\n").as_bytes()));
        let log = fixture.read().unwrap();
        assert_eq!(log.lines.len(), 1);
        assert!(!log.lines[0].message.contains(VANILLA_SESSION_TOKEN), "{:?}", log.lines);
        assert!(log.lines[0].message.contains("(Session ID is <redacted>)"), "{:?}", log.lines);
        let diagnosis = diagnose_instance_inner(&fixture.state, "1.21.1".into(), None).unwrap();
        assert!(!diagnosis.excerpt.contains(VANILLA_SESSION_TOKEN), "{}", diagnosis.excerpt);
        assert!(diagnosis.excerpt.contains("(Session ID is <redacted>)"), "{}", diagnosis.excerpt);
        fixture.cleanup();
    }

    #[test]
    fn a_registered_service_key_is_masked_in_any_shape() {
        let key = format!("svc-{}", uuid::Uuid::new_v4().simple());
        register_secret(&key);
        assert_eq!(redact(&format!("echo {key}!")), "echo <redacted>!");
    }

    #[test]
    fn redact_masks_provider_api_keys_and_their_echoed_fragments() {
        let echoed = "Incorrect API key provided: sk-dd7cb***********************537f. You can find your API key at https://platform.example.invalid/api-keys.";
        let clean = redact(echoed);
        assert!(!clean.contains("dd7cb") && !clean.contains("537f"), "{clean}");
        assert!(clean.contains("sk-<redacted>"), "{clean}");
        for key in ["sk-proj-AbCdEfGh12345678", "sk-ant-api03-ZyXwVu98765432", "sk-0123456789abcdef0123"] {
            assert_eq!(redact(&format!("key {key} end")), "key sk-<redacted> end", "{key}");
        }
        assert_eq!(redact("task-runner started"), "task-runner started");
        assert_eq!(redact("Desk-lamp model"), "Desk-lamp model");
    }

    #[test]
    fn redaction_leaves_ordinary_log_lines_unchanged() {
        for line in [
            "Loading tokens from mod list",
            "UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5",
            "Pack hash: q2V4YW1wbGUtcmVzb3VyY2UtcGFjay1oYXNo==",
            "[main/INFO]: Setting user: Steve",
            "Texture property eyJ0aW1lc3RhbXAiOjE2NzAwMDAwMDB9. Loaded.",
            "at com.example.config.KeyJsonSerializer.deserialize(KeyJsonSerializer.java:42)",
            "net.example.HockeyJerseyRenderer.renderModel(HockeyJerseyRenderer.java:7)",
        ] {
            assert_eq!(redact(line), line, "{line}");
        }
        // Keep the new token rules active while checking that they do not consume
        // the ordinary text above.
        assert_eq!(
            redact(&format!(
                "(Session ID is token:{VANILLA_SESSION_TOKEN}:{VANILLA_SESSION_UUID})"
            )),
            "(Session ID is <redacted>)",
        );
    }

    #[test]
    fn running_instance_guard_is_scoped_to_the_selected_instance() {
        let registry = GameRegistry::default();
        registry.games.lock().unwrap().insert(
            "owned-fixture".into(),
            TrackedGame {
                info: RunningGame {
                    game_id: "owned-fixture".into(),
                    pid: 42,
                    version_id: "fabric-test".into(),
                    instance_id: Some("running-instance".into()),
                    game_directory: "D:/fixture".into(),
                    started_at: chrono::Utc::now().to_rfc3339(),
                    library_root: String::new(),
                },
                clock: Instant::now(),
                owner: None,
            },
        );
        assert!(registry
            .require_instance_stopped("running-instance")
            .is_err());
        assert!(registry.require_instance_stopped("other-instance").is_ok());
    }

    #[test]
    fn launch_guard_reports_duplicate_launch_but_preserves_registry_failures() {
        let registry = GameRegistry::default();
        registry.games.lock().unwrap().insert(
            "owned-fixture".into(),
            TrackedGame {
                info: RunningGame {
                    game_id: "owned-fixture".into(),
                    pid: 42,
                    version_id: "same-version".into(),
                    instance_id: Some("running-instance".into()),
                    game_directory: "D:/fixture".into(),
                    started_at: chrono::Utc::now().to_rfc3339(),
                    library_root: String::new(),
                },
                clock: Instant::now(),
                owner: None,
            },
        );
        assert_eq!(
            registry
                .require_instance_launch_stopped("running-instance")
                .unwrap_err(),
            "此实例已在运行，请勿重复启动"
        );
        assert!(registry
            .require_instance_launch_stopped("other-instance")
            .is_ok());
        registry.games.lock().unwrap().clear();
        assert!(registry
            .require_instance_launch_stopped("running-instance")
            .is_ok());

        let poisoned = GameRegistry::default();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = poisoned.games.lock().unwrap();
            panic!("simulated registry failure");
        }));
        assert_eq!(
            poisoned
                .require_instance_launch_stopped("any-instance")
                .unwrap_err(),
            "游戏进程锁异常，为保护实例文件，已拒绝此操作"
        );
    }

    #[test]
    fn a_failed_process_registry_cannot_accidentally_allow_file_operations() {
        let registry = GameRegistry::default();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = registry.games.lock().unwrap();
            panic!("simulated registry failure");
        }));
        assert!(registry.require_instance_stopped("any-instance").is_err());
    }
}
