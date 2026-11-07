use crate::{
    errors::{expected, AppResult},
    models::LogEvent,
    storage::{safe_join, LauncherState},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Seek},
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningGame {
    pub pid: u32,
    pub version_id: String,
    pub instance_id: Option<String>,
    pub game_directory: String,
    pub started_at: String,
}
struct TrackedGame {
    info: RunningGame,
    clock: Instant,
}
#[derive(Default)]
pub struct GameRegistry {
    games: Mutex<HashMap<u32, TrackedGame>>,
}
impl GameRegistry {
    fn list(&self) -> Vec<RunningGame> {
        self.games
            .lock()
            .map(|games| games.values().map(|game| game.info.clone()).collect())
            .unwrap_or_default()
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
    pub fn require_instance_launch_stopped(&self, instance_id: &str) -> Result<(), String> {
        self.require_instance_stopped_with_error(instance_id, "此实例已在运行，请勿重复启动")
    }
}
pub fn register(
    app: &AppHandle,
    pid: u32,
    version: &str,
    instance_id: Option<String>,
    directory: &Path,
) {
    if let Some(registry) = app.try_state::<Arc<GameRegistry>>() {
        if let Ok(mut games) = registry.games.lock() {
            games.insert(
                pid,
                TrackedGame {
                    info: RunningGame {
                        pid,
                        version_id: version.into(),
                        instance_id,
                        game_directory: directory.to_string_lossy().into_owned(),
                        started_at: chrono::Utc::now().to_rfc3339(),
                    },
                    clock: Instant::now(),
                },
            );
        }
        let _ = app.emit("launcher://games", registry.list());
    }
}
pub fn unregister(app: &AppHandle, state: &LauncherState, pid: u32, code: Option<i32>) {
    if let Some(registry) = app.try_state::<Arc<GameRegistry>>() {
        let tracked = registry
            .games
            .lock()
            .ok()
            .and_then(|mut games| games.remove(&pid));
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
        }
        let _ = app.emit("launcher://games", registry.list());
        let _ = app.emit(
            "launcher://log",
            LogEvent {
                level: if code == Some(0) { "info" } else { "warn" }.into(),
                message: format!("游戏进程 {pid} 已结束，退出码 {code:?}"),
                timestamp: chrono::Utc::now().to_rfc3339(),
            },
        );
    }
}
#[tauri::command]
pub fn list_running_games(registry: State<'_, Arc<GameRegistry>>) -> Vec<RunningGame> {
    registry.list()
}
#[tauri::command]
pub async fn stop_game(registry: State<'_, Arc<GameRegistry>>, pid: u32) -> Result<(), String> {
    if !registry.list().iter().any(|game| game.pid == pid) {
        return Err("只能结束由本启动器启动、且仍在运行的游戏进程".into());
    }
    #[cfg(windows)]
    let output = {
        let mut command = tokio::process::Command::new("taskkill.exe");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command.creation_flags(0x08000000);
        command.output().await.map_err(|e| e.to_string())?
    };
    #[cfg(not(windows))]
    let output = tokio::process::Command::new("kill")
        .args(["-TERM", "--", &pid.to_string()])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "结束进程失败：{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    pub title: String,
    pub reason: String,
    pub suggestions: Vec<String>,
    pub log_path: Option<String>,
    pub excerpt: String,
}
fn classify(text: &str) -> (String, String, Vec<String>) {
    let lower = text.to_ascii_lowercase();
    let (t, r, s) = if lower.contains("outofmemoryerror")
        || lower.contains("could not reserve enough space")
    {
        (
            "内存不足",
            "JVM 无法分配需要的内存",
            vec![
                "调整实例最大内存并关闭占用较高的程序",
                "使用 64 位 Java，避免分配超过物理内存的额度",
            ],
        )
    } else if lower.contains("unsupportedclassversionerror") || lower.contains("class file version")
    {
        (
            "Java 版本不匹配",
            "当前 Java 无法读取游戏或模组的字节码",
            vec![
                "使用自动检测选择适合此游戏版本的 Java",
                "检查整合包和模组要求的 Java 主版本",
            ],
        )
    } else if lower.contains("modresolutionexception")
        || lower.contains("missing mandatory dependencies")
        || lower.contains("incompatible mods")
    {
        (
            "模组依赖或版本冲突",
            "加载器报告缺少依赖或不兼容模组",
            vec![
                "在本地资源列表检查模组与 Minecraft、加载器的版本",
                "安装必需前置，或先禁用最近添加的模组再重试",
            ],
        )
    } else if lower.contains("glfw error") || lower.contains("opengl") && lower.contains("failed") {
        (
            "图形初始化失败",
            "游戏无法创建所需的图形上下文",
            vec![
                "更新显卡驱动并检查 OpenGL 支持",
                "笔记本可尝试为 Java 选择独立显卡",
            ],
        )
    } else if lower.contains("accessexception")
        || lower.contains("access is denied")
        || lower.contains("accessdeniedexception")
    {
        (
            "游戏目录访问失败",
            "文件权限或占用导致访问失败",
            vec![
                "选择当前用户可写的游戏目录",
                "关闭使用同一实例目录的其它游戏进程",
            ],
        )
    } else {
        (
            "需要进一步检查日志",
            "暂未匹配到明确的常见故障，保留原始错误供排查",
            vec![
                "查看日志尾部的 Caused by 和 ERROR",
                "可先备份实例，再禁用最近添加的资源重试",
            ],
        )
    };
    (
        t.into(),
        r.into(),
        s.into_iter().map(str::to_owned).collect(),
    )
}
pub fn redact(text: &str) -> String {
    let bearer = regex::Regex::new(r#"(?i)(authorization[\s"':=]+)(?:bearer\s+)?([^\s,;"']+)"#)
        .expect("constant regex");
    let text = bearer.replace_all(text, "${1}[已隐藏]");
    let pattern=regex::Regex::new(r#"(?i)((?:access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret|password|x-api-key)[\s"':=]+)([^\s,;"']+)"#).expect("constant regex");
    let text = pattern.replace_all(&text, "${1}[已隐藏]");
    let client_id = regex::Regex::new(r#"(?i)(--clientId[\s,'\"=]+|clientid=)([^\s,;\"'\]]+)"#)
        .expect("constant regex");
    client_id.replace_all(&text, "${1}[已隐藏]").into_owned()
}
#[tauri::command]
pub fn diagnose_instance(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> AppResult<Diagnosis> {
    diagnose_instance_inner(state, version_id, instance_id).map_err(expected)
}

fn diagnose_instance_inner(
    state: State<'_, Arc<LauncherState>>,
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
    let (title, reason, suggestions) = if text.is_empty() {
        (
            "还没有日志".into(),
            "此游戏环境尚未发现日志或崩溃报告".into(),
            vec!["启动一次游戏后，可在这里查看检查结果".into()],
        )
    } else {
        classify(&text)
    };
    let excerpt = redact(&text);
    Ok(Diagnosis {
        title,
        reason,
        suggestions,
        log_path: path.map(|p| p.to_string_lossy().into_owned()),
        excerpt,
    })
}
#[tauri::command]
pub fn export_diagnostics(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    output_path: String,
) -> Result<String, String> {
    let diagnosis =
        diagnose_instance_inner(state.clone(), version_id.clone(), instance_id.clone())?;
    let destination = Path::new(&output_path);
    if !destination.is_absolute() || destination.extension().is_none_or(|e| e != "txt") {
        return Err("请选择绝对路径的 .txt 诊断报告文件".into());
    }
    if destination.exists() {
        return Err("报告文件已存在，请选择新文件名以保留原文件".into());
    }
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
        diagnosis.title,
        diagnosis.reason,
        diagnosis.suggestions.join("\n"),
        diagnosis.excerpt
    );
    std::fs::write(destination, report).map_err(|e| e.to_string())?;
    Ok(output_path)
}
#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(classify("java.lang.OutOfMemoryError: Java heap space")
            .0
            .contains("内存"));
        assert!(classify("UnsupportedClassVersionError").0.contains("Java"));
        assert!(classify("ModResolutionException").0.contains("模组"));
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
            42,
            TrackedGame {
                info: RunningGame {
                    pid: 42,
                    version_id: "fabric-test".into(),
                    instance_id: Some("running-instance".into()),
                    game_directory: "D:/fixture".into(),
                    started_at: chrono::Utc::now().to_rfc3339(),
                },
                clock: Instant::now(),
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
            42,
            TrackedGame {
                info: RunningGame {
                    pid: 42,
                    version_id: "same-version".into(),
                    instance_id: Some("running-instance".into()),
                    game_directory: "D:/fixture".into(),
                    started_at: chrono::Utc::now().to_rfc3339(),
                },
                clock: Instant::now(),
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
