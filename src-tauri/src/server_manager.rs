//! Independently installed vanilla servers. This registry never controls arbitrary PIDs or the game registry.
use crate::{
    errors::{expected, AppResult},
    minecraft,
    storage::{safe_join, validate_id, LauncherState},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::mpsc,
};

const EULA_URL: &str = "https://www.minecraft.net/en-us/eula";
const LOG_LIMIT: u64 = 5 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServerSettings {
    pub port: u16,
    pub max_players: u32,
    pub online_mode: bool,
    pub whitelist: bool,
    pub motd: String,
    pub difficulty: String,
    pub gamemode: String,
    pub view_distance: u32,
    pub max_memory_mb: u32,
    pub bind_address: String,
}
impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            port: 25565,
            max_players: 20,
            online_mode: true,
            whitelist: false,
            motd: "A Minecraft Server".into(),
            difficulty: "normal".into(),
            gamemode: "survival".into(),
            view_distance: 10,
            max_memory_mb: 2048,
            bind_address: String::new(),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateServerRequest {
    pub name: String,
    pub version_id: String,
    #[serde(default)]
    pub settings: ServerSettings,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerDefinition {
    id: String,
    name: String,
    version_id: String,
    created_at: String,
    settings: ServerSettings,
    #[serde(default)]
    eula_accepted: bool,
    #[serde(default)]
    eula_accepted_at: Option<String>,
    #[serde(default)]
    jar_sha1: Option<String>,
    #[serde(default)]
    java_major: Option<u32>,
    #[serde(default)]
    install_error: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedServerInfo {
    pub id: String,
    pub name: String,
    pub version_id: String,
    pub created_at: String,
    pub directory: String,
    pub settings: ServerSettings,
    pub eula_accepted: bool,
    pub eula_url: String,
    pub installed: bool,
    pub java_major: Option<u32>,
    pub status: String,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerLog {
    pub server_id: String,
    pub timestamp: String,
    pub stream: String,
    pub message: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStateEvent {
    pub server_id: String,
    pub status: String,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
}
struct OwnedServer {
    pid: u32,
    alive: AtomicBool,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    kill: mpsc::Sender<()>,
    status: Mutex<String>,
    exit_code: Mutex<Option<i32>>,
}
#[derive(Default)]
pub struct ServerRegistry {
    processes: Mutex<HashMap<String, Arc<OwnedServer>>>,
    logs: Mutex<HashMap<String, VecDeque<ServerLog>>>,
    operation: tokio::sync::Mutex<()>,
}
impl ServerRegistry {
    fn process(&self, id: &str) -> Result<Option<Arc<OwnedServer>>, String> {
        Ok(self
            .processes
            .lock()
            .map_err(|_| "服务端进程锁异常")?
            .get(id)
            .cloned())
    }
    fn running(&self, id: &str) -> bool {
        self.process(id)
            .ok()
            .flatten()
            .is_some_and(|entry| entry.alive.load(Ordering::SeqCst))
    }
    fn require_stopped(&self, id: &str) -> Result<(), String> {
        if self.running(id) {
            Err("请先停止此服务端再修改设置".into())
        } else {
            Ok(())
        }
    }
    fn emit_state(&self, id: &str, app: &Option<AppHandle>) {
        if let Ok(Some(entry)) = self.process(id) {
            let event = ServerStateEvent {
                server_id: id.into(),
                status: entry
                    .status
                    .lock()
                    .map(|s| s.clone())
                    .unwrap_or_else(|_| "error".into()),
                pid: entry.alive.load(Ordering::SeqCst).then_some(entry.pid),
                exit_code: entry.exit_code.lock().ok().and_then(|code| *code),
            };
            if let Some(app) = app {
                let _ = app.emit("launcher://server-state", event);
            }
        }
    }
    fn log(&self, id: &str, dir: &Path, stream: &str, text: &str, app: &Option<AppHandle>) {
        let event = ServerLog {
            server_id: id.into(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            stream: stream.into(),
            message: redact_console(text),
        };
        if let Ok(mut logs) = self.logs.lock() {
            let ring = logs.entry(id.into()).or_default();
            ring.push_back(event.clone());
            while ring.len() > 500 {
                ring.pop_front();
            }
        }
        if let Ok(path) = safe_join(dir, "launcher-console.jsonl") {
            let result = (|| -> Result<(), String> {
                if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > LOG_LIMIT) {
                    let previous = safe_join(dir, "launcher-console.previous.jsonl")?;
                    fs::rename(&path, previous).map_err(|_| "无法轮换服务端日志")?;
                }
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                    .map_err(|_| "无法保存服务端日志")?;
                let encoded = serde_json::to_string(&event).map_err(|_| "日志编码失败")?;
                writeln!(file, "{encoded}").map_err(|_| "无法写入服务端日志")?;
                Ok(())
            })();
            let _ = result;
        }
        if let Some(app) = app {
            let _ = app.emit("launcher://server-log", &event);
        }
    }
    fn spawn_owned(
        self: &Arc<Self>,
        id: String,
        dir: PathBuf,
        mut command: Command,
        app: Option<AppHandle>,
    ) -> Result<ServerStateEvent, String> {
        if self.running(&id) {
            return Err("此服务端已经运行".into());
        }
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动服务端 Java：{error}"))?;
        let pid = child.id().ok_or("无法获取服务端进程 ID")?;
        let stdin = child.stdin.take().ok_or("无法打开服务端控制台输入")?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let (kill, receiver) = mpsc::channel(1);
        let entry = Arc::new(OwnedServer {
            pid,
            alive: AtomicBool::new(true),
            stdin: tokio::sync::Mutex::new(Some(stdin)),
            kill,
            status: Mutex::new("starting".into()),
            exit_code: Mutex::new(None),
        });
        self.processes
            .lock()
            .map_err(|_| "服务端进程锁异常")?
            .insert(id.clone(), entry.clone());
        self.log(
            &id,
            &dir,
            "launcher",
            &format!("服务端进程已启动，PID {pid}"),
            &app,
        );
        self.emit_state(&id, &app);
        if let Some(stdout) = stdout {
            let registry = self.clone();
            let id = id.clone();
            let dir = dir.clone();
            let app = app.clone();
            tokio::spawn(async move {
                registry.pump(stdout, id, dir, "stdout", app).await;
            });
        }
        if let Some(stderr) = stderr {
            let registry = self.clone();
            let id = id.clone();
            let dir = dir.clone();
            let app = app.clone();
            tokio::spawn(async move {
                registry.pump(stderr, id, dir, "stderr", app).await;
            });
        }
        let registry = self.clone();
        let monitor_id = id.clone();
        tokio::spawn(async move {
            registry
                .monitor(child, receiver, entry, monitor_id, dir, app)
                .await;
        });
        Ok(ServerStateEvent {
            server_id: id,
            status: "starting".into(),
            pid: Some(pid),
            exit_code: None,
        })
    }
    async fn pump<R: AsyncRead + Unpin>(
        &self,
        mut read: R,
        id: String,
        dir: PathBuf,
        stream: &str,
        app: Option<AppHandle>,
    ) {
        let mut chunk = [0u8; 4096];
        let mut line = Vec::new();
        let mut truncated = false;
        loop {
            match read.read(&mut chunk).await {
                Ok(0) => break,
                Ok(size) => {
                    for byte in &chunk[..size] {
                        if *byte == b'\n' {
                            let mut text = String::from_utf8_lossy(&line)
                                .trim_end_matches('\r')
                                .to_string();
                            if truncated {
                                text.push_str(" …[日志行已截断]");
                            }
                            self.process_line(&id, &dir, stream, &text, &app);
                            line.clear();
                            truncated = false;
                        } else if line.len() < 16384 {
                            line.push(*byte);
                        } else {
                            truncated = true;
                        }
                    }
                }
                Err(_) => {
                    self.log(&id, &dir, "launcher", "服务端控制台读取结束", &app);
                    break;
                }
            }
        }
        if !line.is_empty() {
            self.process_line(&id, &dir, stream, &String::from_utf8_lossy(&line), &app);
        }
    }
    fn process_line(
        &self,
        id: &str,
        dir: &Path,
        stream: &str,
        text: &str,
        app: &Option<AppHandle>,
    ) {
        self.log(id, dir, stream, text, app);
        if text.contains("Done (") && text.contains("For help") {
            if let Ok(Some(entry)) = self.process(id) {
                if entry.alive.load(Ordering::SeqCst) {
                    if let Ok(mut status) = entry.status.lock() {
                        if *status == "starting" {
                            *status = "running".into();
                        }
                    }
                    self.emit_state(id, app);
                }
            }
        }
    }
    async fn monitor(
        &self,
        mut child: Child,
        mut receiver: mpsc::Receiver<()>,
        entry: Arc<OwnedServer>,
        id: String,
        dir: PathBuf,
        app: Option<AppHandle>,
    ) {
        let result = loop {
            if receiver.try_recv().is_ok() {
                if let Err(error) = child.start_kill() {
                    self.log(
                        &id,
                        &dir,
                        "launcher",
                        &format!("强制停止请求失败：{error}"),
                        &app,
                    );
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(error) => break Err(error),
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        entry.alive.store(false, Ordering::SeqCst);
        *entry.stdin.lock().await = None;
        let (code, status, message) = match result {
            Ok(exit) => (
                exit.code(),
                if exit.success() { "stopped" } else { "error" },
                format!("服务端已退出，退出码 {:?}", exit.code()),
            ),
            Err(error) => (None, "error", format!("无法读取服务端退出状态：{error}")),
        };
        if let Ok(mut state) = entry.status.lock() {
            *state = status.into();
        }
        if let Ok(mut value) = entry.exit_code.lock() {
            *value = code;
        }
        self.log(&id, &dir, "launcher", &message, &app);
        self.emit_state(&id, &app);
    }
    async fn write_command(&self, id: &str, command: &str) -> Result<(), String> {
        let command = validate_console_command(command)?;
        let entry = self
            .process(id)?
            .filter(|entry| entry.alive.load(Ordering::SeqCst))
            .ok_or("此服务端未由当前启动器运行，无法发送命令")?;
        let mut stdin = entry.stdin.lock().await;
        let stdin = stdin.as_mut().ok_or("服务端控制台已关闭")?;
        stdin
            .write_all(format!("{command}\n").as_bytes())
            .await
            .map_err(|_| "无法写入服务端控制台")?;
        stdin
            .flush()
            .await
            .map_err(|_| "服务端控制台刷新失败".to_owned())
    }
    async fn stop(&self, id: &str, force: bool, app: &Option<AppHandle>) -> Result<(), String> {
        let entry = self
            .process(id)?
            .filter(|entry| entry.alive.load(Ordering::SeqCst))
            .ok_or("只能停止当前启动器启动且仍在运行的服务端")?;
        if force {
            entry
                .kill
                .try_send(())
                .map_err(|_| "强制停止请求正在处理中")?;
        } else {
            self.write_command(id, "stop").await?;
        }
        if let Ok(mut status) = entry.status.lock() {
            *status = "stopping".into();
        }
        self.emit_state(id, app);
        Ok(())
    }
}

fn servers_root(state: &LauncherState) -> Result<PathBuf, String> {
    safe_join(&state.data_dir, "servers")
}
fn server_directory(state: &LauncherState, id: &str) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("服务端标识无效".into());
    }
    safe_join(&servers_root(state)?, id)
}
fn load_definition(dir: &Path) -> Result<ServerDefinition, String> {
    let path = safe_join(dir, "server.json")?;
    let metadata = fs::metadata(&path).map_err(|_| "服务端不存在")?;
    if metadata.len() > 128 * 1024 {
        return Err("服务端配置过大".into());
    }
    let definition: ServerDefinition =
        serde_json::from_slice(&fs::read(path).map_err(|_| "无法读取服务端配置")?)
            .map_err(|_| "服务端配置格式无效")?;
    if dir.file_name().and_then(|value| value.to_str()) != Some(definition.id.as_str()) {
        return Err("服务端目录与标识不匹配".into());
    }
    validate_id(&definition.version_id)?;
    validate_settings(&definition.settings)?;
    Ok(definition)
}
fn save_definition(dir: &Path, definition: &ServerDefinition) -> Result<(), String> {
    atomic_write(
        dir,
        "server.json",
        &serde_json::to_vec_pretty(definition).map_err(|_| "服务端配置编码失败")?,
    )
}
fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    let path = safe_join(dir, name)?;
    let temp = safe_join(dir, &format!(".{}.tmp", uuid::Uuid::new_v4()))?;
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "无法创建服务端配置文件")?;
        file.write_all(bytes).map_err(|_| "无法写入服务端配置")?;
        file.sync_all().map_err(|_| "无法同步服务端配置")?;
        drop(file);
        fs::rename(&temp, path).map_err(|_| "无法替换服务端配置".into())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
fn validate_settings(settings: &ServerSettings) -> Result<(), String> {
    if settings.port == 0
        || !(1..=10000).contains(&settings.max_players)
        || !(2..=32).contains(&settings.view_distance)
        || !(512..=65536).contains(&settings.max_memory_mb)
    {
        return Err("端口、人数、视距或内存设置超出允许范围".into());
    }
    if !["peaceful", "easy", "normal", "hard"].contains(&settings.difficulty.as_str())
        || !["survival", "creative", "adventure", "spectator"].contains(&settings.gamemode.as_str())
    {
        return Err("难度或游戏模式无效".into());
    }
    if settings.motd.chars().count() > 256 || settings.motd.chars().any(char::is_control) {
        return Err("MOTD 最多 256 个字符，不能包含换行或控制字符".into());
    }
    if !settings.bind_address.is_empty()
        && settings.bind_address.parse::<std::net::IpAddr>().is_err()
    {
        return Err("监听地址必须留空或填写有效的 IP 地址".into());
    }
    Ok(())
}
fn properties(dir: &Path) -> Result<String, String> {
    let path = safe_join(dir, "server.properties")?;
    match fs::read(&path) {
        Ok(bytes) => {
            if bytes.len() > 1024 * 1024 {
                return Err("server.properties 过大".into());
            }
            String::from_utf8(bytes).map_err(|_| "server.properties 不是有效 UTF-8 文本".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(_) => Err("无法读取 server.properties".into()),
    }
}
fn property_pair(line: &str) -> Option<(&str, &str)> {
    let trimmed = line.trim_start();
    if trimmed.starts_with(['#', '!']) || trimmed.is_empty() {
        return None;
    }
    let index = trimmed.find(['=', ':'])?;
    Some((trimmed[..index].trim(), trimmed[index + 1..].trim_start()))
}
fn java_escape(value: &str) -> String {
    let mut output = String::new();
    for unit in value.encode_utf16() {
        match unit {
            92 => output.push_str("\\\\"),
            10 => output.push_str("\\n"),
            13 => output.push_str("\\r"),
            9 => output.push_str("\\t"),
            32 => output.push_str("\\ "),
            33..=126 => output.push(char::from_u32(unit as u32).unwrap()),
            _ => output.push_str(&format!("\\u{unit:04x}")),
        }
    }
    output
}
fn java_unescape(value: &str) -> Result<String, String> {
    let mut output = Vec::new();
    let mut chars = value.chars();
    while let Some(value) = chars.next() {
        if value != '\\' {
            let mut encoded = [0; 2];
            output.extend_from_slice(value.encode_utf16(&mut encoded));
            continue;
        }
        match chars.next() {
            Some('u') => {
                let digits: String = chars.by_ref().take(4).collect();
                if digits.len() != 4 {
                    return Err("Java 属性转义不完整".into());
                }
                output.push(u16::from_str_radix(&digits, 16).map_err(|_| "Java 属性转义无效")?);
            }
            Some('n') => output.push(10),
            Some('r') => output.push(13),
            Some('t') => output.push(9),
            Some(c) => {
                let mut encoded = [0; 2];
                output.extend_from_slice(c.encode_utf16(&mut encoded));
            }
            None => return Err("Java 属性转义不完整".into()),
        }
    }
    String::from_utf16(&output).map_err(|_| "Java 属性 Unicode 无效".into())
}
fn settings_from_properties(text: &str, base: &ServerSettings) -> Result<ServerSettings, String> {
    let map: BTreeMap<_, _> = text.lines().filter_map(property_pair).collect();
    let mut result = base.clone();
    macro_rules! number {
        ($key:literal,$field:ident) => {
            if let Some(value) = map.get($key) {
                result.$field = value
                    .parse()
                    .map_err(|_| format!("{} 数字格式无效", $key))?;
            }
        };
    }
    macro_rules! boolean {
        ($key:literal,$field:ident) => {
            if let Some(value) = map.get($key) {
                result.$field = match *value {
                    "true" => true,
                    "false" => false,
                    _ => return Err(format!("{} 必须是 true 或 false", $key)),
                };
            }
        };
    }
    number!("server-port", port);
    number!("max-players", max_players);
    number!("view-distance", view_distance);
    boolean!("online-mode", online_mode);
    boolean!("white-list", whitelist);
    if let Some(value) = map.get("motd") {
        result.motd = java_unescape(value)?;
    }
    if let Some(value) = map.get("difficulty") {
        result.difficulty = match value.trim() {
            "0" => "peaceful",
            "1" => "easy",
            "2" => "normal",
            "3" => "hard",
            other => other,
        }
        .into();
    }
    if let Some(value) = map.get("gamemode") {
        result.gamemode = match value.trim() {
            "0" => "survival",
            "1" => "creative",
            "2" => "adventure",
            "3" => "spectator",
            other => other,
        }
        .into();
    }
    if let Some(value) = map.get("server-ip") {
        result.bind_address = value.trim().into();
    }
    validate_settings(&result)?;
    Ok(result)
}
fn update_properties(text: &str, settings: &ServerSettings) -> String {
    let mut values: BTreeMap<&str, String> = BTreeMap::from([
        ("server-port", settings.port.to_string()),
        ("max-players", settings.max_players.to_string()),
        ("online-mode", settings.online_mode.to_string()),
        ("white-list", settings.whitelist.to_string()),
        ("motd", java_escape(&settings.motd)),
        ("difficulty", settings.difficulty.clone()),
        ("gamemode", settings.gamemode.clone()),
        ("view-distance", settings.view_distance.to_string()),
        ("server-ip", settings.bind_address.clone()),
    ]);
    let mut updated = Vec::new();
    let keys: Vec<&str> = values.keys().copied().collect();
    for line in text.lines() {
        if let Some((key, _)) = property_pair(line) {
            if keys.contains(&key) {
                if let Some(value) = values.remove(key) {
                    updated.push(format!("{key}={value}"));
                }
                continue;
            }
        }
        updated.push(line.into());
    }
    for (key, value) in values {
        updated.push(format!("{key}={value}"));
    }
    format!("{}\n", updated.join("\n"))
}
fn eula_file_accepted(dir: &Path) -> bool {
    safe_join(dir, "eula.txt")
        .ok()
        .and_then(|path| {
            if fs::metadata(&path).ok()?.len() > 16384 {
                return None;
            }
            fs::read_to_string(path).ok()
        })
        .is_some_and(|text| {
            text.lines()
                .filter_map(property_pair)
                .filter(|(key, _)| *key == "eula")
                .last()
                .is_some_and(|(_, value)| value.trim() == "true")
        })
}
fn require_eula(definition: &ServerDefinition, dir: &Path) -> Result<(), String> {
    if !definition.eula_accepted || !eula_file_accepted(dir) {
        Err("请先阅读 Minecraft EULA 并在界面勾选同意，才能启动服务端".into())
    } else {
        Ok(())
    }
}
fn server_info(
    state: &LauncherState,
    registry: &ServerRegistry,
    definition: ServerDefinition,
) -> Result<ManagedServerInfo, String> {
    let dir = server_directory(state, &definition.id)?;
    let mut error = definition.install_error.clone();
    let settings = match properties(&dir)
        .and_then(|text| settings_from_properties(&text, &definition.settings))
    {
        Ok(settings) => settings,
        Err(problem) => {
            error = Some(problem);
            definition.settings.clone()
        }
    };
    let process = registry.process(&definition.id)?;
    let status = process
        .as_ref()
        .and_then(|entry| entry.status.lock().ok().map(|status| status.clone()))
        .unwrap_or_else(|| {
            if error.is_some() {
                "error".into()
            } else {
                "stopped".into()
            }
        });
    Ok(ManagedServerInfo {
        id: definition.id.clone(),
        name: definition.name,
        version_id: definition.version_id,
        created_at: definition.created_at,
        directory: dir.to_string_lossy().into_owned(),
        settings,
        eula_accepted: definition.eula_accepted && eula_file_accepted(&dir),
        eula_url: EULA_URL.into(),
        installed: definition.jar_sha1.is_some() && safe_join(&dir, "server.jar")?.is_file(),
        java_major: definition.java_major,
        status,
        pid: process
            .as_ref()
            .filter(|entry| entry.alive.load(Ordering::SeqCst))
            .map(|entry| entry.pid),
        exit_code: process
            .as_ref()
            .and_then(|entry| entry.exit_code.lock().ok().and_then(|code| *code)),
        error,
    })
}
async fn install_jar(
    state: &LauncherState,
    app: &AppHandle,
    definition: &mut ServerDefinition,
    dir: &Path,
) -> Result<Value, String> {
    let metadata =
        minecraft::official_metadata(state, &definition.version_id, &safe_join(dir, "metadata")?)
            .await?;
    if metadata["downloads"]["server"].is_null() {
        return Err("此官方版本没有可下载的 Java 服务端 JAR，请选择另一个版本".into());
    }
    let download =
        minecraft::download_from(&metadata["downloads"]["server"], dir, Some("server.jar"))?;
    minecraft::progress(
        app,
        &definition.version_id,
        "server-jar",
        0,
        1,
        0,
        download.size.unwrap_or(0),
        "下载并校验官方服务端 JAR",
    );
    minecraft::ensure_download_with_source_and_control(
        &state.client,
        &download,
        &state.snapshot()?.config.download_source,
        Some(&state.control),
    )
    .await?;
    definition.jar_sha1 = Some(download.sha1);
    definition.java_major = Some(
        metadata["javaVersion"]["majorVersion"]
            .as_u64()
            .unwrap_or(8) as u32,
    );
    definition.install_error = None;
    save_definition(dir, definition)?;
    Ok(metadata)
}

#[tauri::command]
pub fn list_managed_servers(
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<ServerRegistry>>,
) -> Result<Vec<ManagedServerInfo>, String> {
    let root = servers_root(&state)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(&root)
        .map_err(|_| "无法读取服务端列表")?
        .flatten()
    {
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if uuid::Uuid::parse_str(&id).is_err() {
            continue;
        }
        let dir = server_directory(&state, &id)?;
        if !dir.is_dir() {
            continue;
        }
        if let Ok(definition) = load_definition(&dir) {
            result.push(server_info(&state, &registry, definition)?);
        }
    }
    result.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(result)
}
#[tauri::command]
pub async fn create_managed_server(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<ServerRegistry>>,
    request: CreateServerRequest,
) -> Result<ManagedServerInfo, String> {
    let _guard = registry
        .operation
        .try_lock()
        .map_err(|_| "已有服务端管理操作正在进行")?;
    let _download = state
        .operation
        .try_lock()
        .map_err(|_| "已有下载或启动准备任务运行")?;
    if request.name.trim().is_empty()
        || request.name.chars().count() > 80
        || request.name.chars().any(char::is_control)
    {
        return Err("服务端名称须为 1–80 个字符且不含控制字符".into());
    }
    validate_id(&request.version_id)?;
    validate_settings(&request.settings)?;
    let id = uuid::Uuid::new_v4().to_string();
    let dir = server_directory(&state, &id)?;
    fs::create_dir_all(&dir).map_err(|_| "无法创建独立服务端目录")?;
    let mut definition = ServerDefinition {
        id,
        name: request.name.trim().into(),
        version_id: request.version_id,
        created_at: chrono::Utc::now().to_rfc3339(),
        settings: request.settings,
        eula_accepted: false,
        eula_accepted_at: None,
        jar_sha1: None,
        java_major: None,
        install_error: None,
    };
    save_definition(&dir, &definition)?;
    atomic_write(
        &dir,
        "server.properties",
        update_properties("", &definition.settings).as_bytes(),
    )?;
    atomic_write(
        &dir,
        "eula.txt",
        b"# Accept the Minecraft EULA explicitly in the launcher before starting.\neula=false\n",
    )?;
    let task = state.control.begin(
        "server-install",
        &definition.version_id,
        &format!("安装服务端 {}", definition.name),
    );
    let result = install_jar(&state, &app, &mut definition, &dir).await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    if let Err(error) = result {
        definition.install_error = Some(error.clone());
        save_definition(&dir, &definition)?;
        return Err(error);
    }
    server_info(&state, &registry, definition)
}
#[tauri::command]
pub async fn update_managed_server(
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<ServerRegistry>>,
    server_id: String,
    settings: ServerSettings,
) -> Result<ManagedServerInfo, String> {
    let _guard = registry
        .operation
        .try_lock()
        .map_err(|_| "已有服务端操作正在进行")?;
    registry.require_stopped(&server_id)?;
    validate_settings(&settings)?;
    let dir = server_directory(&state, &server_id)?;
    let mut definition = load_definition(&dir)?;
    atomic_write(
        &dir,
        "server.properties",
        update_properties(&properties(&dir)?, &settings).as_bytes(),
    )?;
    definition.settings = settings;
    save_definition(&dir, &definition)?;
    server_info(&state, &registry, definition)
}
#[tauri::command]
pub async fn set_managed_server_eula(
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<ServerRegistry>>,
    server_id: String,
    accepted: bool,
) -> Result<ManagedServerInfo, String> {
    let _guard = registry
        .operation
        .try_lock()
        .map_err(|_| "已有服务端操作正在进行")?;
    registry.require_stopped(&server_id)?;
    let dir = server_directory(&state, &server_id)?;
    let mut definition = load_definition(&dir)?;
    definition.eula_accepted = accepted;
    definition.eula_accepted_at = accepted.then(|| chrono::Utc::now().to_rfc3339());
    atomic_write(
        &dir,
        "eula.txt",
        format!("# Minecraft EULA: {EULA_URL}\neula={accepted}\n").as_bytes(),
    )?;
    save_definition(&dir, &definition)?;
    server_info(&state, &registry, definition)
}
async fn start_managed_server_inner(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<ServerRegistry>>,
    server_id: String,
) -> Result<ServerStateEvent, String> {
    let _guard = registry
        .operation
        .try_lock()
        .map_err(|_| "已有服务端操作正在进行")?;
    registry.require_stopped(&server_id)?;
    let dir = server_directory(&state, &server_id)?;
    let mut definition = load_definition(&dir)?;
    require_eula(&definition, &dir)?;
    let settings = settings_from_properties(&properties(&dir)?, &definition.settings)?;
    if registry
        .processes
        .lock()
        .map_err(|_| "服务端进程锁异常")?
        .iter()
        .any(|(id, entry)| {
            id != &server_id
                && entry.alive.load(Ordering::SeqCst)
                && server_directory(&state, id)
                    .and_then(|dir| load_definition(&dir))
                    .is_ok_and(|other| other.settings.port == settings.port)
        })
    {
        return Err("另一个由启动器管理的服务端已使用此端口，请先更换端口".into());
    }
    let _download = state
        .operation
        .try_lock()
        .map_err(|_| "已有下载或启动准备任务运行")?;
    let task = state.control.begin(
        "server-start",
        &definition.version_id,
        &format!("准备服务端 {}", definition.name),
    );
    let prepared = async {
        let metadata = install_jar(&state, &app, &mut definition, &dir).await?;
        let config = state.snapshot()?.config;
        let runtime = minecraft::select_or_install_java(&state, &app, &config, &metadata).await?;
        Ok::<_, String>(runtime)
    }
    .await;
    state
        .control
        .finish(&task, prepared.as_ref().err().map(String::as_str));
    let runtime = prepared?;
    let temp = crate::storage::runtime_temp_directory(&dir)?;
    let mut command = Command::new(runtime.path);
    command.arg(format!("-Djava.io.tmpdir={}", temp.display()));
    command.current_dir(&dir).args([
        "-Xms512M",
        &format!("-Xmx{}M", settings.max_memory_mb),
        "-jar",
        "server.jar",
        "nogui",
    ]);
    registry
        .inner()
        .spawn_owned(server_id, dir, command, Some(app))
}

#[tauri::command]
pub async fn start_managed_server(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<ServerRegistry>>,
    server_id: String,
) -> AppResult<ServerStateEvent> {
    start_managed_server_inner(app, state, registry, server_id)
        .await
        .map_err(expected)
}

#[tauri::command]
pub async fn stop_managed_server(
    app: AppHandle,
    registry: State<'_, Arc<ServerRegistry>>,
    server_id: String,
    force: bool,
) -> Result<(), String> {
    registry.stop(&server_id, force, &Some(app)).await
}
#[tauri::command]
pub async fn send_managed_server_command(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<ServerRegistry>>,
    server_id: String,
    command: String,
) -> Result<(), String> {
    let dir = server_directory(&state, &server_id)?;
    let command = validate_console_command(&command)?;
    registry.write_command(&server_id, &command).await?;
    registry.log(
        &server_id,
        &dir,
        "command",
        &format!("> {command}"),
        &Some(app),
    );
    Ok(())
}
#[tauri::command]
pub fn read_managed_server_logs(
    state: State<'_, Arc<LauncherState>>,
    registry: State<'_, Arc<ServerRegistry>>,
    server_id: String,
    limit: Option<usize>,
) -> Result<Vec<ServerLog>, String> {
    let dir = server_directory(&state, &server_id)?;
    load_definition(&dir)?;
    let limit = limit.unwrap_or(200).clamp(1, 500);
    if let Some(logs) = registry
        .logs
        .lock()
        .map_err(|_| "日志锁异常")?
        .get(&server_id)
    {
        return Ok(logs
            .iter()
            .skip(logs.len().saturating_sub(limit))
            .cloned()
            .collect());
    }
    let path = safe_join(&dir, "launcher-console.jsonl")?;
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("无法读取服务端日志".into()),
    };
    let length = file.metadata().map_err(|_| "无法读取日志大小")?.len();
    let offset = length.saturating_sub(512 * 1024);
    file.seek(std::io::SeekFrom::Start(offset))
        .map_err(|_| "无法定位日志")?;
    let mut bytes = Vec::new();
    file.take(512 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取日志")?;
    let mut logs: Vec<ServerLog> = String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str::<ServerLog>(line).ok())
        .filter(|log| log.server_id == server_id)
        .collect();
    for log in &mut logs {
        log.message = redact_console(&log.message);
    }
    if logs.len() > limit {
        logs.drain(..logs.len() - limit);
    }
    Ok(logs)
}
fn validate_console_command(command: &str) -> Result<String, String> {
    if command.chars().any(char::is_control) {
        return Err("控制台命令不能包含换行或控制字符".into());
    }
    let command = command.trim().trim_start_matches('/');
    if command.is_empty() || command.len() > 2048 {
        return Err("控制台命令须为单行且不超过 2048 字节".into());
    }
    Ok(command.into())
}
fn redact_console(text: &str) -> String {
    static BEARER: OnceLock<regex::Regex> = OnceLock::new();
    let pattern=BEARER.get_or_init(||regex::Regex::new(r"(?i)(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+|(?i)(bearer\s+)[A-Za-z0-9._~+/-]+=*").expect("constant token pattern"));
    let safe = pattern.replace_all(text, "${1}${2}[已隐藏]");
    let safe = crate::processes::redact(&safe);
    safe.chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .take(8192)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn definition() -> ServerDefinition {
        ServerDefinition {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Fixture only".into(),
            version_id: "1.21.4".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            settings: ServerSettings::default(),
            eula_accepted: false,
            eula_accepted_at: None,
            jar_sha1: None,
            java_major: None,
            install_error: None,
        }
    }
    fn fixture_directory() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/server-manager-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn cleanup(dir: &Path) {
        for name in [
            "server.json",
            "server.properties",
            "eula.txt",
            "launcher-console.jsonl",
            "launcher-console.previous.jsonl",
        ] {
            let path = dir.join(name);
            if path.exists() {
                fs::remove_file(path).unwrap();
            }
        }
        fs::remove_dir(dir).unwrap();
    }
    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Runtime::new().unwrap().block_on(future)
    }
    async fn wait_for(mut predicate: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while !predicate() {
            assert!(
                std::time::Instant::now() < deadline,
                "fixture process timed out"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[test]
    fn installation_does_not_accept_eula_and_start_guard_refuses_missing_consent() {
        let dir = fixture_directory();
        let mut value = definition();
        assert!(require_eula(&value, &dir).unwrap_err().contains("EULA"));
        atomic_write(&dir, "eula.txt", b"eula=false\n").unwrap();
        assert!(require_eula(&value, &dir).is_err());
        value.eula_accepted = true;
        // A stale UI/config marker alone must never bypass the actual eula=false file.
        assert!(require_eula(&value, &dir).is_err());
        assert_eq!(
            fs::read_to_string(dir.join("eula.txt")).unwrap(),
            "eula=false\n"
        );
        cleanup(&dir);
    }
    #[test]
    fn properties_preserve_unknown_keys_and_roundtrip_unicode_without_duplicate_overrides() {
        let mut settings = ServerSettings::default();
        settings.port = 25570;
        settings.max_players = 32;
        settings.whitelist = true;
        settings.motd = " 你好，世界 🌍 ".into();
        let updated=update_properties("# Existing configuration\nserver-port=25565\nserver-port=1234\nspawn-protection=7\nenable-rcon=false\n",&settings);
        assert!(updated.contains("spawn-protection=7"));
        assert!(updated.contains("enable-rcon=false"));
        assert!(updated.contains("# Existing configuration"));
        assert_eq!(updated.matches("server-port=").count(), 1);
        let parsed = settings_from_properties(&updated, &ServerSettings::default()).unwrap();
        assert_eq!(parsed.port, 25570);
        assert_eq!(parsed.max_players, 32);
        assert!(parsed.whitelist);
        assert_eq!(parsed.motd, settings.motd);
        let old =
            settings_from_properties("difficulty=3\ngamemode=1\n", &ServerSettings::default())
                .unwrap();
        assert_eq!(old.difficulty, "hard");
        assert_eq!(old.gamemode, "creative");
    }
    #[test]
    fn properties_commands_and_log_output_enforce_boundaries() {
        let mut settings = ServerSettings::default();
        settings.port = 0;
        assert!(validate_settings(&settings).is_err());
        settings.port = 25565;
        settings.motd = "hello\nserver-port=1".into();
        assert!(validate_settings(&settings).is_err());
        for command in ["stop\nsay injected", "stop\r", "\0stop", ""] {
            assert!(validate_console_command(command).is_err());
        }
        assert_eq!(
            validate_console_command(" /whitelist add TestPlayer ").unwrap(),
            "whitelist add TestPlayer"
        );
        let safe=redact_console("Authorization: Bearer private-bearer-token accessToken=private-access password=private-password");
        for secret in ["private-bearer-token", "private-access", "private-password"] {
            assert!(!safe.contains(secret));
        }
    }
    #[test]
    fn server_definition_cannot_point_at_another_server_directory() {
        let dir = fixture_directory();
        let value = definition();
        save_definition(&dir, &value).unwrap();
        assert!(load_definition(&dir).unwrap_err().contains("标识"));
        cleanup(&dir);
    }
    #[test]
    fn stopping_unknown_processes_is_rejected() {
        run(async {
            let registry = ServerRegistry::default();
            assert!(registry
                .stop("arbitrary-process", true, &None)
                .await
                .is_err());
            assert!(registry
                .write_command("arbitrary-process", "stop")
                .await
                .is_err());
        });
    }

    #[cfg(windows)]
    #[test]
    fn owned_fixture_process_supports_console_and_graceful_stop_without_accepting_eula() {
        run(async {
            let dir = fixture_directory();
            let registry = Arc::new(ServerRegistry::default());
            let id = uuid::Uuid::new_v4().to_string();
            let mut command = Command::new("powershell.exe");
            command.args(["-NoLogo","-NoProfile","-NonInteractive","-Command",r#"[Console]::WriteLine('Done (fixture)! For help'); while (($line = [Console]::ReadLine()) -ne $null) { if ($line -eq 'stop') { [Console]::WriteLine('SAVED_AND_STOPPED'); break }; [Console]::WriteLine('RECEIVED:' + $line) }"#]);
            registry
                .spawn_owned(id.clone(), dir.clone(), command, None)
                .unwrap();
            wait_for(|| {
                registry
                    .process(&id)
                    .unwrap()
                    .unwrap()
                    .status
                    .lock()
                    .unwrap()
                    .as_str()
                    == "running"
            })
            .await;
            registry.write_command(&id, "list").await.unwrap();
            wait_for(|| {
                registry.logs.lock().unwrap().get(&id).is_some_and(|logs| {
                    logs.iter()
                        .any(|line| line.message.contains("RECEIVED:list"))
                })
            })
            .await;
            registry.stop(&id, false, &None).await.unwrap();
            wait_for(|| {
                !registry.running(&id)
                    && registry.logs.lock().unwrap().get(&id).is_some_and(|logs| {
                        logs.iter()
                            .any(|line| line.message.contains("SAVED_AND_STOPPED"))
                            && logs
                                .iter()
                                .any(|line| line.message.contains("服务端已退出"))
                    })
            })
            .await;
            assert!(!dir.join("eula.txt").exists());
            assert_eq!(
                *registry
                    .process(&id)
                    .unwrap()
                    .unwrap()
                    .exit_code
                    .lock()
                    .unwrap(),
                Some(0)
            );
            cleanup(&dir);
        });
    }
    #[cfg(windows)]
    #[test]
    fn forced_stop_targets_only_the_fixture_child_owned_by_this_registry() {
        run(async {
            let dir = fixture_directory();
            let registry = Arc::new(ServerRegistry::default());
            let id = uuid::Uuid::new_v4().to_string();
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::WriteLine('FIXTURE_READY'); Start-Sleep -Seconds 60",
            ]);
            registry
                .spawn_owned(id.clone(), dir.clone(), command, None)
                .unwrap();
            wait_for(|| {
                registry.logs.lock().unwrap().get(&id).is_some_and(|logs| {
                    logs.iter()
                        .any(|line| line.message.contains("FIXTURE_READY"))
                })
            })
            .await;
            registry.stop(&id, true, &None).await.unwrap();
            wait_for(|| {
                !registry.running(&id)
                    && registry.logs.lock().unwrap().get(&id).is_some_and(|logs| {
                        logs.iter()
                            .any(|line| line.message.contains("服务端已退出"))
                    })
            })
            .await;
            assert!(!dir.join("eula.txt").exists());
            assert!(registry.stop("not-owned", true, &None).await.is_err());
            cleanup(&dir);
        });
    }
}
