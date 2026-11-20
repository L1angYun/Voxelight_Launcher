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
    sync::{Arc, Mutex},
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
                game_directory: directory.display().to_string(), started_at: String::new() },
        });
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
    owner: StopHandle,
) {
    if let Some(registry) = app.try_state::<Arc<GameRegistry>>() {
        if let Ok(mut games) = registry.games.lock() {
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
                    },
                    clock: Instant::now(),
                    owner: Some(Arc::new(owner)),
                },
            );
        }
        let _ = app.emit("launcher://games", registry.list());
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
fn interface_is_zh(config: &Config) -> bool {
    report_is_zh(&config.language, || crate::platform::get_system_appearance().locale)
}

/// Mirrors the frontend's resolveLocale: only "system" follows the OS, and an
/// unknown value falls back to English like the interface does.
fn report_is_zh(language: &str, system_locale: impl FnOnce() -> String) -> bool {
    match language {
        "zh-CN" => true,
        "system" => system_locale() == "zh-CN",
        _ => false,
    }
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
    static SECRET: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)((?:access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret|password|x-api-key)[\s"':=]+)([^\s,;"']+)"#)
            .expect("constant regex")
    });
    static CLIENT_ID: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)(--clientId[\s,'\"=]+|clientid=)([^\s,;\"'\]]+)"#)
            .expect("constant regex")
    });
    let text = URL_USERINFO.replace_all(text, "${1}[已隐藏]@");
    let text = PROXY_AUTH.replace_all(&text, "${1}[已隐藏]");
    let text = BEARER.replace_all(&text, "${1}[已隐藏]");
    let text = SECRET.replace_all(&text, "${1}[已隐藏]");
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

fn diagnose_instance_inner(
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
        file.seek(std::io::SeekFrom::Start(size.saturating_sub(256 * 1024)))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(256 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        String::from_utf8_lossy(&bytes).into_owned()
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
    Ok(render_diagnostic_report(
        diagnosis.kind,
        interface_is_zh(&state.snapshot()?.config),
        version_id,
        instance_id,
        &diagnosis.excerpt,
        generated_at,
    ))
}
fn diagnostic_locale(zh: bool) -> &'static serde_json::Value {
    static REPORT_LOCALES: std::sync::LazyLock<[serde_json::Value; 2]> = std::sync::LazyLock::new(|| {
        [
            include_str!("../../src/i18n/locales/zh-CN/library.json"),
            include_str!("../../src/i18n/locales/en-US/library.json"),
        ].map(|raw| serde_json::from_str(raw).expect("bundled library locale is valid JSON"))
    });
    &REPORT_LOCALES[usize::from(!zh)]
}

fn diagnostic_translation(zh: bool, keys: &[&str]) -> Option<&'static str> {
    fn lookup(zh: bool, keys: &[&str]) -> Option<&'static str> {
        keys.iter().try_fold(diagnostic_locale(zh), |value, key| value.get(key))?.as_str()
    }
    lookup(zh, keys).or_else(|| lookup(true, keys))
}

fn render_diagnostic_report(
    kind: DiagnosisKind,
    zh: bool,
    version_id: &str,
    instance_id: Option<&str>,
    excerpt: &str,
    now: &str,
) -> String {
    let label = |key| diagnostic_translation(zh, &["diagnosticReport", key])
        .expect("required diagnostic report label");
    let diagnosis = |key| diagnostic_translation(zh, &["diagnosis", kind.locale_key(), key]);
    let separator = if zh { "：" } else { ": " };
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
        for zh in [true, false] {
            let locale = super::diagnostic_locale(zh);
            let translated = |value: &serde_json::Value| value.as_str().is_some_and(|s| !s.trim().is_empty());
            for key in ["title", "time", "version", "instance", "noInstance", "conclusion",
                        "reason", "suggestions", "excerpt"] {
                assert!(translated(&locale["diagnosticReport"][key]), "{zh}/{key}");
            }
            for (kind, key) in DIAGNOSIS_REPORTS {
                assert_eq!(kind.locale_key(), key);
                for field in ["title", "reason", "firstSuggestion"] {
                    assert!(translated(&locale["diagnosis"][key][field]), "{zh}/{key}/{field}");
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
