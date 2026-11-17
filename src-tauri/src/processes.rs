use crate::path_grants::{PathGrants, PathUse};
use crate::{
    errors::{expected, AppResult},
    game_process::{StopHandle, StopResult, StopStatus},
    models::LogEvent,
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
    let mut current = checked.as_path();
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
                missing.push(current.file_name().ok_or("游戏目录无效")?);
                current = current.parent().ok_or("游戏目录无效")?;
            }
            Err(error) => return Err(format!("无法访问游戏目录：{error}")),
        }
    }
}

pub(crate) fn same_canonical_directory(path: &Path, active: &Path) -> bool {
    // Registered process paths are canonical. Normalize an existing alternate
    // spelling as well to handle older tests and legacy active paths.
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
                game_directory: directory.canonicalize().unwrap().display().to_string(), started_at: String::new() },
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
        let zh = match settings.language.as_str() {
            "zh-CN" => true,
            "en-US" => false,
            _ => crate::platform::get_system_appearance().locale == "zh-CN",
        };
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
    // Retain the existing plain-text report format. The UI translates the stable kind itself.
    fn report_text(self) -> (&'static str, &'static str, &'static [&'static str]) {
        match self {
            Self::Memory => (
                "内存不足",
                "JVM 无法分配需要的内存",
                &[
                    "调整实例最大内存并关闭占用较高的程序",
                    "使用 64 位 Java，避免分配超过物理内存的额度",
                ],
            ),
            Self::Java => (
                "Java 版本不匹配",
                "当前 Java 无法读取游戏或模组的字节码",
                &[
                    "使用自动检测选择适合此游戏版本的 Java",
                    "检查整合包和模组要求的 Java 主版本",
                ],
            ),
            Self::Mods => (
                "模组依赖或版本冲突",
                "加载器报告缺少依赖或不兼容模组",
                &[
                    "在本地资源列表检查模组与 Minecraft、加载器的版本",
                    "安装必需前置，或先禁用最近添加的模组再重试",
                ],
            ),
            Self::Graphics => (
                "图形初始化失败",
                "游戏无法创建所需的图形上下文",
                &[
                    "更新显卡驱动并检查 OpenGL 支持",
                    "笔记本可尝试为 Java 选择独立显卡",
                ],
            ),
            Self::Directory => (
                "游戏目录访问失败",
                "文件权限或占用导致访问失败",
                &[
                    "选择当前用户可写的游戏目录",
                    "关闭使用同一实例目录的其它游戏进程",
                ],
            ),
            Self::Unknown => (
                "需要进一步检查日志",
                "暂未匹配到明确的常见故障，保留原始错误供排查",
                &[
                    "查看日志尾部的 Caused by 和 ERROR",
                    "可先备份实例，再禁用最近添加的资源重试",
                ],
            ),
            Self::Empty => (
                "还没有日志",
                "此游戏环境尚未发现日志或崩溃报告",
                &["启动一次游戏后，可在这里查看检查结果"],
            ),
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
    let text = BEARER.replace_all(text, "${1}[已隐藏]");
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
    let diagnosis =
        diagnose_instance_inner(state.inner().as_ref(), version_id.clone(), instance_id.clone())?;
    let destination = Path::new(&output_path);
    if !destination.is_absolute() || destination.extension().is_none_or(|e| e != "txt") {
        return Err("请选择绝对路径的 .txt 诊断报告文件".into());
    }
    if destination.exists() {
        return Err("报告文件已存在，请选择新文件名以保留原文件".into());
    }
    let (title, reason, suggestions) = diagnosis.kind.report_text();
    let report = format!(
        concat!(
            "Voxelight Launcher ",
            env!("CARGO_PKG_VERSION"),
            " 诊断报告\n",
            "时间：{}\n游戏版本：{}\n实例：{:?}\n结论：{}\n原因：{}\n建议：\n{}\n\n",
            "日志节选（已过滤常见凭证字段）：\n{}\n"
        ),
        chrono::Utc::now().to_rfc3339(),
        version_id,
        instance_id,
        title,
        reason,
        suggestions.join("\n"),
        diagnosis.excerpt
    );
    write_diagnostics_file(destination, report.as_bytes())?;
    Ok(output_path)
}
fn write_diagnostics_file(destination: &Path, report: &[u8]) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new().create_new(true).write(true).open(destination)
        .map_err(|error| if error.kind() == io::ErrorKind::AlreadyExists {
            "报告文件已存在，请选择新文件名以保留原文件".to_owned()
        } else { error.to_string() })?;
    file.write_all(report).and_then(|()| file.sync_all()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
