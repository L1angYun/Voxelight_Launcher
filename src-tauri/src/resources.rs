//! Modrinth installation and resource management share the launcher's game directory rules.
use crate::{
    downloads::{ResourceRequest, ResourceSource, ResourceTarget as ReservedTarget, CANCELLED},
    errors::{expected, AppError, AppResult},
    models::{
        Instance, Persisted, ResourceDependency, ResourceProject, ResourceProjectDetails,
        ResourceVersion,
    },
    storage::{safe_join, validate_id, LauncherState},
};
use futures_util::StreamExt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha512};
use std::{
    collections::HashSet,
    fs,
    future::Future,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

#[path = "resource_transactions.rs"]
pub(crate) mod resource_transactions;

const API: &str = "https://api.modrinth.com/v2";
const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESOURCE_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ResourceKind {
    Mod,
    ResourcePack,
    Shader,
}

impl ResourceKind {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "mod" => Ok(Self::Mod),
            "resourcepack" => Ok(Self::ResourcePack),
            "shader" => Ok(Self::Shader),
            "modpack" => Err("整合包需要解析清单、依赖及覆盖文件，当前不能直接安装。请使用专门的整合包导入流程。".into()),
            _ => Err("不支持的资源类型".into()),
        }
    }

    fn folder(self) -> &'static str {
        match self {
            Self::Mod => "mods",
            Self::ResourcePack => "resourcepacks",
            Self::Shader => "shaderpacks",
        }
    }

    fn project_type(self) -> &'static str {
        match self {
            Self::Mod => "mod",
            Self::ResourcePack => "resourcepack",
            Self::Shader => "shader",
        }
    }

    fn extension(self) -> &'static str {
        if self == Self::Mod {
            ".jar"
        } else {
            ".zip"
        }
    }

    pub(crate) fn accepts(self, name: &str) -> bool {
        name.to_ascii_lowercase().ends_with(self.extension())
    }
}

#[derive(Deserialize)]
struct Project {
    id: String,
    title: String,
    project_type: String,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    downloads: Option<u64>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    external_url: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Version {
    id: String,
    #[serde(default)]
    version_type: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version_number: String,
    #[serde(default)]
    project_id: String,
    #[serde(default)]
    date_published: String,
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
    #[serde(default)]
    dependencies: Vec<Dependency>,
    #[serde(default)]
    environment: String,
    files: Vec<ResourceFile>,
}

#[derive(Clone, Deserialize)]
struct Dependency {
    dependency_type: String,
    project_id: Option<String>,
    version_id: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
}

#[derive(Clone, Deserialize)]
struct ResourceFile {
    filename: String,
    url: String,
    primary: bool,
    size: u64,
    hashes: FileHashes,
}

#[derive(Clone, Deserialize)]
struct FileHashes {
    sha512: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInstall {
    pub name: String,
    pub file_name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResourcesResult {
    pub deleted: Vec<String>,
}

/// Resource transfers use the same progress/task channel as the loader phase.
pub(super) struct ResourceProgress {
    app: Option<AppHandle>,
    version_id: String,
}

impl ResourceProgress {
    pub(crate) fn new(app: Option<&AppHandle>, version_id: &str) -> Self {
        Self {
            app: app.cloned(),
            version_id: version_id.into(),
        }
    }

    fn emit(
        &self,
        state: &LauncherState,
        stage: &str,
        completed: usize,
        total: usize,
        bytes_completed: u64,
        bytes_total: u64,
        message: &str,
    ) {
        let event = crate::models::ProgressEvent {
            task_id: String::new(),
            operation: String::new(),
            version_id: self.version_id.clone(),
            stage: stage.into(),
            completed,
            total,
            bytes_completed,
            bytes_total,
            message: message.into(),
        };
        if let (Some(event), Some(app)) = (state.control.record_progress(event), &self.app) {
            let _ = app.emit("launcher://progress", event);
        }
    }

    pub(crate) fn stage(&self, state: &LauncherState, stage: &str, message: &str) {
        self.emit(state, stage, 0, 0, 0, 0, message);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalResource {
    pub name: String,
    pub file_name: String,
    pub path: String,
    pub enabled: bool,
    pub size: u64,
    /// Modification time in ms, so a file replaced under the same name gets a new revision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) metadata: Option<crate::mod_metadata::ModMetadata>,
}

/// Uses the same version/instance selection as JVM launching.
pub(crate) fn resource_directory(
    data: &Persisted,
    version_id: &str,
    instance_id: Option<&str>,
    kind: ResourceKind,
) -> Result<PathBuf, String> {
    validate_id(version_id)?;
    let instance = match instance_id {
        Some(id) => {
            let instance = data
                .instances
                .iter()
                .find(|item| item.id == id)
                .ok_or("目标实例不存在，请重新选择实例")?;
            if instance.version_id != version_id {
                return Err("所选实例和 Minecraft 版本不一致，请重新选择".into());
            }
            Some(instance)
        }
        None => None,
    };
    let game_directory = crate::minecraft::game_directory(&data.config, version_id, instance)?;
    reject_links(&game_directory)?;
    safe_join(&game_directory, kind.folder())
}

/// Reject reparse points as well as ordinary links, including a linked game root.
fn reject_links(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("游戏目录必须为绝对路径".into());
    }
    for component in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(component) {
            if linked(&metadata) {
                return Err("资源目录包含符号链接或目录联接，拒绝访问外部目标".into());
            }
        }
    }
    Ok(())
}

pub(crate) fn linked(metadata: &fs::Metadata) -> bool {
    let is_link = metadata.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return is_link || metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    is_link
}

fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Modrinth 项目标识无效".into());
    }
    Ok(())
}

fn cdn_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Modrinth 下载地址无效")?;
    let test_http = cfg!(test) && url.scheme() == "http" && url.port().is_some();
    if (url.scheme() != "https" && !test_http)
        || url.host_str() != Some("cdn.modrinth.com")
        || (!test_http && url.port_or_known_default() != Some(443))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("只允许从 Modrinth 官方 CDN 的 HTTPS 地址下载资源".into());
    }
    Ok(url)
}

/// Test-only service addresses for this thread: the API bases, and the address
/// the CDN host names resolve to. Production uses the constants and HTTPS checks.
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct TestEndpoints {
    pub(crate) modrinth_api: String,
    pub(crate) curseforge_api: String,
    pub(crate) cdn: std::net::SocketAddr,
    /// The version the Minecraft and loader step would produce; tests of the
    /// create path use it instead of installing a game.
    pub(crate) prepared_version: Option<String>,
}

#[cfg(test)]
thread_local! {
    pub(crate) static TEST_ENDPOINTS: std::cell::RefCell<Option<TestEndpoints>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn test_endpoints() -> Option<TestEndpoints> {
    TEST_ENDPOINTS.with(|endpoints| endpoints.borrow().clone())
}

/// A test's stand-in for the Minecraft and loader install (never in a release build).
pub(crate) fn prepared_version() -> Option<String> {
    #[cfg(test)]
    return test_endpoints().and_then(|endpoints| endpoints.prepared_version);
    #[cfg(not(test))]
    None
}

/// The Modrinth API base.
pub(super) fn modrinth_api() -> String {
    #[cfg(test)]
    if let Some(endpoints) = test_endpoints() {
        return endpoints.modrinth_api;
    }
    API.to_owned()
}

pub(super) fn client(state: &LauncherState, download: bool) -> Result<reqwest::Client, String> {
    let redirects = if download {
        reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("重定向过多")
            } else if cdn_url(attempt.url().as_str()).is_ok() {
                attempt.follow()
            } else {
                attempt.error("下载地址跳转到非 Modrinth CDN")
            }
        })
    } else {
        reqwest::redirect::Policy::none()
    };
    let builder = reqwest::Client::builder()
        .user_agent(concat!(
            "VoxelightLauncher/",
            env!("CARGO_PKG_VERSION"),
            " (Tauri desktop)"
        ))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(if download { 600 } else { 60 }))
        .redirect(redirects);
    #[cfg(test)]
    let builder = match test_endpoints() {
        Some(endpoints) => builder.resolve("cdn.modrinth.com", endpoints.cdn),
        None => builder,
    };
    crate::network::for_state_builder(state, builder)?
        .build()
        .map_err(|_| "无法建立 Modrinth 网络客户端".into())
}

async fn api_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    endpoint: &str,
    query: &[(String, String)],
) -> Result<T, String> {
    let response = client
        .get(format!("{}/{endpoint}", modrinth_api()))
        .query(query)
        .send()
        .await
        .map_err(|error| crate::network::proxy_auth_code(&error)
            .unwrap_or_else(|| "无法连接 Modrinth，请检查网络后重试".into()))?;
    if response.status() == reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED {
        return Err(crate::network::Error::Authentication.code().into());
    }
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("Modrinth 请求过于频繁，请稍后重试".into());
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("Modrinth 项目或版本不存在".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "Modrinth 请求失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_METADATA_BYTES as u64)
    {
        return Err("Modrinth 元数据过大，已停止处理".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "读取 Modrinth 响应失败，请重试")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_METADATA_BYTES {
            return Err("Modrinth 元数据超过处理限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Modrinth 返回的资源信息无法解析".into())
}

fn primary_file(version: &Version) -> Result<&ResourceFile, String> {
    version
        .files
        .iter()
        .find(|file| file.primary)
        .or_else(|| version.files.first())
        .ok_or_else(|| "该 Modrinth 版本没有可下载文件".into())
}

fn compatible(version: &Version, minecraft: &str, loader: Option<&str>) -> bool {
    version.game_versions.iter().any(|v| v == minecraft)
        && loader.is_none_or(|loader| version.loaders.iter().any(|v| v == loader))
}

async fn project_versions(
    client: &reqwest::Client,
    project_id: &str,
    minecraft: &str,
    loader: Option<&str>,
) -> Result<Vec<Version>, String> {
    identifier(project_id)?;
    let mut query = vec![
        (
            "game_versions".into(),
            serde_json::json!([minecraft]).to_string(),
        ),
        ("include_changelog".into(), "false".into()),
    ];
    if let Some(loader) = loader {
        query.push(("loaders".into(), serde_json::json!([loader]).to_string()));
    }
    let mut versions: Vec<Version> =
        api_json(client, &format!("project/{project_id}/version"), &query).await?;
    versions.retain(|version| compatible(version, minecraft, loader));
    versions.sort_by(|a, b| b.date_published.cmp(&a.date_published));
    Ok(versions)
}

fn modrinth_details(
    project: Project,
    versions: Vec<Version>,
    context: Option<&ResourceContext>,
) -> ResourceProjectDetails {
    let mut dependencies = Vec::new();
    let mut seen = HashSet::new();
    for version in &versions {
        for dependency in &version.dependencies {
            let Some(project_id) = dependency.project_id.clone() else {
                continue;
            };
            if project_id.is_empty() {
                continue;
            }
            let kind = match dependency.dependency_type.as_str() {
                "required" => "required",
                "optional" => "optional",
                "incompatible" => "incompatible",
                "embedded" => "embedded",
                _ => "unknown",
            };
            if seen.insert((project_id.clone(), kind.to_string())) {
                dependencies.push(ResourceDependency {
                    project_id,
                    kind: kind.into(),
                    name: dependency.file_name.clone(),
                });
            }
        }
    }
    let mut game_versions = Vec::new();
    for version in &versions {
        for game in &version.game_versions {
            if !game_versions.contains(game) {
                game_versions.push(game.clone());
            }
        }
    }
    let needs_loader = project.project_type == "mod";
    ResourceProjectDetails {
        project: ResourceProject {
            project_id: project.id,
            slug: project.slug.unwrap_or_default(),
            title: project.title,
            description: project.description.unwrap_or_default(),
            icon_url: project.icon_url,
            downloads: project.downloads.unwrap_or(0),
            author: project.author.unwrap_or_default(),
            project_type: project.project_type,
            versions: game_versions,
            external_url: project.external_url,
        },
        versions: versions
            .into_iter()
            .map(|version| {
                let matches = context.is_some_and(|target| {
                    (!needs_loader || target.loader.is_some())
                        && compatible(
                            &version,
                            &target.game_version,
                            target.loader.as_deref().filter(|_| needs_loader),
                        )
                });
                ResourceVersion {
                    id: version.id,
                    name: version.name,
                    version_number: version.version_number,
                    date_published: version.date_published,
                    game_versions: version.game_versions,
                    loaders: version.loaders,
                    compatible: matches,
                }
            })
            .collect(),
        dependencies,
    }
}

#[tauri::command]
pub async fn get_modrinth_project_details(
    state: tauri::State<'_, Arc<LauncherState>>,
    project_id: String,
    version_id: Option<String>,
    instance_id: Option<String>,
    resource_type: String,
) -> AppResult<ResourceProjectDetails> {
    let kind = if resource_type == "modpack" {
        ResourceKind::Mod
    } else {
        ResourceKind::parse(&resource_type).map_err(expected)?
    };
    identifier(&project_id).map_err(expected)?;
    let context = version_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| resource_context(&state, id, instance_id.as_deref()).ok());
    let api = client(&state, false).map_err(expected)?;
    let project: Project = api_json(&api, &format!("project/{project_id}"), &[])
        .await
        .map_err(expected)?;
    let expected_type = if resource_type == "modpack" {
        "modpack"
    } else {
        kind.project_type()
    };
    if project.project_type != expected_type {
        return Err(expected("资源项目类型与所选分类不一致，已拒绝安装"));
    }
    let filter = context.as_ref().filter(|target| {
        resource_type != "modpack" && (kind != ResourceKind::Mod || target.loader.is_some())
    });
    let mut versions = if let Some(target) = filter {
        project_versions(
            &api,
            &project.id,
            &target.game_version,
            target
                .loader
                .as_deref()
                .filter(|_| kind == ResourceKind::Mod),
        )
        .await?
    } else {
        all_project_versions(&api, &project.id).await?
    };
    versions.truncate(30);
    Ok(modrinth_details(project, versions, context.as_ref()))
}

async fn all_project_versions(
    api: &reqwest::Client,
    project_id: &str,
) -> Result<Vec<Version>, String> {
    identifier(project_id)?;
    let mut versions: Vec<Version> = api_json(
        api,
        &format!("project/{project_id}/version"),
        &[("include_changelog".into(), "false".into())],
    )
    .await?;
    if versions
        .iter()
        .any(|version| version.project_id != project_id)
    {
        return Err("Modrinth 版本与项目标识不一致".into());
    }
    versions.sort_by(|a, b| b.date_published.cmp(&a.date_published));
    Ok(versions)
}

/// Resolve an inherited loader version to its vanilla Minecraft version.
pub(crate) fn version_context(
    root: &Path,
    selected: &str,
) -> Result<(String, Option<String>), String> {
    let mut current = selected.to_owned();
    let mut visited = HashSet::new();
    let mut loader = None;
    for _ in 0..16 {
        validate_id(&current)?;
        if !visited.insert(current.clone()) {
            return Err("Minecraft 版本继承关系存在循环".into());
        }
        let path = safe_join(root, &format!("versions/{current}/{current}.json"))?;
        let metadata =
            fs::metadata(&path).map_err(|_| "请先安装目标 Minecraft 版本，再安装资源")?;
        if metadata.len() > MAX_METADATA_BYTES as u64 {
            return Err("Minecraft 版本元数据过大".into());
        }
        let json: Value =
            serde_json::from_slice(&fs::read(&path).map_err(|_| "无法读取 Minecraft 版本信息")?)
                .map_err(|_| "Minecraft 版本 JSON 无效")?;
        if loader.is_none() {
            loader = detect_loader(&json).map(str::to_owned);
        }
        match json.get("inheritsFrom").and_then(Value::as_str) {
            Some(parent) => current = parent.to_owned(),
            None => return Ok((current, loader)),
        }
    }
    Err("Minecraft 版本继承层级过深".into())
}

pub(crate) fn detect_loader(json: &Value) -> Option<&'static str> {
    match json["launcherMetadata"]["loader"].as_str() {
        Some("fabric") => return Some("fabric"),
        Some("quilt") => return Some("quilt"),
        Some("forge") => return Some("forge"),
        Some("neoforge") => return Some("neoforge"),
        Some("optifine") => return Some("optifine"),
        _ => {}
    }
    let names = json
        .get("libraries")
        .and_then(Value::as_array)
        .map(|libraries| {
            libraries
                .iter()
                .filter_map(|v| v.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ")
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    let main = json
        .get("mainClass")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if names.contains("net.neoforged:")
        || names.contains("net.neoforged.fancymodloader:")
        || main.contains("neoforged")
    {
        Some("neoforge")
    } else if names.contains("org.quiltmc:quilt-loader:") || main.contains("quiltmc.loader") {
        Some("quilt")
    } else if names.contains("net.fabricmc:fabric-loader:") || main.contains("fabricmc.loader") {
        Some("fabric")
    } else if names.contains("net.minecraftforge:") || main.contains("minecraftforge") {
        Some("forge")
    } else if names.contains("optifine:optifine:") {
        Some("optifine")
    } else {
        None
    }
}

fn file_sha512(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "无法读取本地资源文件")?;
    let mut hash = Sha512::new();
    let mut bytes = [0_u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut bytes)
            .map_err(|_| "计算本地资源校验值失败")?;
        if count == 0 {
            break;
        }
        hash.update(&bytes[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Count enabled JARs without following links, hashing, or reading their contents.
pub(crate) fn count_enabled_mods(directory: &Path) -> Result<usize, String> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err("无法读取本地模组目录".into()),
    };
    if !metadata.is_dir() || linked(&metadata) {
        return Err("本地模组目录必须是非链接目录".into());
    }
    let mut count = 0;
    for entry in fs::read_dir(directory).map_err(|_| "无法读取本地模组目录")? {
        let entry = entry.map_err(|_| "无法读取本地模组文件")?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| "无法读取模组文件信息")?;
        if metadata.is_file() && !linked(&metadata)
            && ResourceKind::Mod.accepts(&entry.file_name().to_string_lossy())
        {
            count += 1;
        }
    }
    Ok(count)
}

enum DownloadAttemptError {
    Retry(String),
    Fatal(String),
}

impl From<String> for DownloadAttemptError {
    fn from(message: String) -> Self {
        Self::Fatal(message)
    }
}

impl From<&str> for DownloadAttemptError {
    fn from(message: &str) -> Self {
        Self::Fatal(message.into())
    }
}

/// The parts folder for downloads into `directory`: the one of the configured
/// game root or the launcher data directory that holds it (both are cleaned at
/// startup), so a part is never inside a staged copy and outlives a failed or
/// cancelled install. None when the folder is elsewhere: those files download
/// in one go, as before.
pub(crate) fn resource_parts(state: &LauncherState, directory: &Path) -> Option<crate::parts::PartStore> {
    let data = state.snapshot().ok()?;
    let game_root = crate::processes::configured_game_root(Path::new(&data.config.game_directory)).ok();
    let root = game_root
        .into_iter()
        .chain(std::iter::once(state.data_dir.clone()))
        .find(|root| root.is_absolute() && crate::processes::directory_tail(directory, root).is_some())?;
    let folder = root.join(".launcher-temp").join("parts");
    if root != state.data_dir {
        // Cleaned at startup even after the game directory setting changes.
        crate::parts::remember(&state.data_dir, &folder);
    }
    Some(crate::parts::PartStore::new(folder))
}

/// The message for a failed part transfer: the launcher's own wording for an
/// HTTP status and for what the HTTP library reports in English (a dropped
/// connection, a broken body); the launcher's own messages stay as they are.
pub(crate) fn transfer_message(error: String, source: &str) -> String {
    if let Some(rest) = error.strip_prefix("下载失败（HTTP ") {
        return format!("{source} 资源下载失败（HTTP {rest}");
    }
    if error.is_ascii() {
        return format!("{source} 资源下载失败，请检查网络和磁盘空间后重试");
    }
    error
}

/// Whether a part transfer failed with an answer no retry changes: a 4xx
/// status (`crate::parts::classify` words it), except timeouts and rate limits.
fn refused(error: &str) -> bool {
    error
        .strip_prefix("下载失败（HTTP ")
        .and_then(|rest| rest.strip_suffix('）'))
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| (400..500).contains(&code) && code != 408 && code != 429)
}

/// Tries without progress allowed for one resource file; a try that continued
/// its part is free, up to this many tries in all.
const RESOURCE_FAILURES: u32 = 3;
const RESOURCE_TRIES: u32 = 12;

/// Downloads `file` through its resumable part and moves it into `directory`
/// without replacing anything there. Ok(None): no part could be opened (held
/// by another download, or an unusable parts folder), and the caller
/// downloads in one go.
#[allow(clippy::too_many_arguments)]
async fn download_resumable(
    state: &LauncherState,
    file: &ResourceFile,
    url: &reqwest::Url,
    directory: &Path,
    expected: &str,
    parts: &crate::parts::Reuse,
    key: &crate::parts::PartKey,
    client: &reqwest::Client,
    progress: Option<&ResourceProgress>,
) -> Result<Option<PathBuf>, String> {
    // A part that cannot be opened (held by another download, or a parts
    // folder that cannot be used) means the one-go download, as before.
    let open = || parts.store().open(key, file.size).ok().flatten();
    let Some(part) = open() else { return Ok(None) };
    let mut slot = Some(part);
    let control = &state.control;
    let untrusted = std::sync::atomic::AtomicBool::new(false);
    let (mut tries, mut failures) = (0, 0);
    let mut last = String::new();
    loop {
        tries += 1;
        state.control.checkpoint().await?;
        if slot.is_none() {
            // A part thrown away for a mismatched range starts again from zero;
            // if it cannot be had now, the tries so far are the answer.
            let Some(part) = open() else { return Err(transfer_message(last, "Modrinth")) };
            slot = Some(part);
        }
        let before = slot.as_ref().map(crate::parts::ResumablePart::mark);
        let mut hash = Sha512::new();
        // Progress follows the bytes in place (segments land out of order),
        // not the in-order hash.
        let report = |done: u64| {
            if let Some(progress) = progress {
                progress.emit(state, "resource-download", 0, 1, done, file.size, &format!("下载 {}", file.filename));
            }
        };
        let reporting = crate::parts::Reporting { hooks: &control, report: &report };
        let transferred = crate::parts::transfer(
            client.get(url.clone()),
            url,
            &mut slot,
            file.size,
            &reporting,
            &|response| {
                cdn_url(response.url().as_str())
                    .map(|_| ())
                    .inspect_err(|_| untrusted.store(true, std::sync::atomic::Ordering::SeqCst))
            },
            &mut |bytes| hash.update(bytes),
        )
        .await;
        let error = match transferred {
            Ok(()) => {
                let part = slot.take().ok_or("资源下载分片不可用")?;
                if format!("{:x}", hash.finalize()) == expected {
                    reject_links(directory)?;
                    state.control.checkpoint().await?;
                    let checked = safe_join(directory, &file.filename)?;
                    crate::parts::publish_new_off_task(part, &checked)
                        .await
                        .map_err(|_| "下载期间出现同名文件或无法移入目标目录，已保留原文件，请重新检查资源目录")?;
                    // Back to its part if the stage is not committed.
                    parts.add(key, file.size, &checked);
                    if let Some(progress) = progress {
                        progress.emit(state, "resource-download", 1, 1, file.size, file.size, &format!("已校验 {}", file.filename));
                    }
                    return Ok(Some(checked));
                }
                part.discard();
                "资源 SHA-512 或大小校验失败，未安装该文件".to_string()
            }
            Err(error) => error,
        };
        // A cancel ends here; anything else may be tried again.
        state.control.checkpoint().await?;
        if error == crate::parts::OVERRUN {
            // Bytes from an answer longer than the file are not continued.
            if let Some(part) = slot.take() {
                part.discard();
            }
        }
        let after = slot.as_ref().map(crate::parts::ResumablePart::mark);
        if !crate::parts::progressed(before.as_ref(), after.as_ref()) {
            failures += 1;
        }
        // No retry changes these answers, as before C9: they end the download.
        let settled = refused(&error)
            || error == crate::parts::SIZE_MISMATCH
            || error == crate::parts::OVERRUN
            || untrusted.load(std::sync::atomic::Ordering::SeqCst);
        if settled || failures >= RESOURCE_FAILURES || tries >= RESOURCE_TRIES {
            return Err(transfer_message(error, "Modrinth"));
        }
        last = error;
        state
            .control
            .during_cancellable_io(tokio::time::sleep(Duration::from_millis(500 * u64::from(failures.max(1)))))
            .await?;
    }
}

async fn download_verified_progress(
    state: &LauncherState,
    file: &ResourceFile,
    directory: &Path,
    parts: Option<&crate::parts::Reuse>,
    kind: ResourceKind,
    client: reqwest::Client,
    progress: Option<&ResourceProgress>,
) -> Result<PathBuf, String> {
    validate_id(&file.filename)?;
    if !kind.accepts(&file.filename) {
        return Err(format!(
            "资源主文件格式不正确，预期 {} 文件",
            kind.extension()
        ));
    }
    let expected = file.hashes.sha512.to_ascii_lowercase();
    if expected.len() != 128 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("该资源缺少有效的 SHA-512 校验值，已拒绝下载".into());
    }
    if file.size == 0 || file.size > MAX_RESOURCE_BYTES {
        return Err("资源大小无效或超过 1 GiB，请从项目页面手动下载".into());
    }
    let url = cdn_url(&file.url)?;
    if let Some(progress) = progress {
        progress.emit(
            state,
            "resource-download",
            0,
            1,
            0,
            file.size,
            &format!("下载 {}", file.filename),
        );
    }
    reject_links(directory)?;
    fs::create_dir_all(directory).map_err(|_| "无法创建资源目录，请检查目录权限")?;
    reject_links(directory)?;
    let target = safe_join(directory, &file.filename)?;
    if target.exists() {
        if target.is_file()
            && fs::metadata(&target).map_err(|_| "无法读取已有文件")?.len() == file.size
            && file_sha512(&target)? == expected
        {
            if let Some(progress) = progress {
                progress.emit(
                    state,
                    "resource-download",
                    1,
                    1,
                    file.size,
                    file.size,
                    &format!("复用已校验文件 {}", file.filename),
                );
            }
            return Ok(target);
        }
        return Err(format!(
            "已存在不同内容的同名文件 {}。为保留现有内容，请先备份或重命名该文件。",
            file.filename
        ));
    }
    // 1 MiB or more: through a part outside the staged copy, so a failed or
    // cancelled install leaves it for the next one (U0266).
    let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &expected, file.size)
        .filter(|_| file.size >= crate::parts::RESUME_MIN);
    if let (Some(parts), Some(key)) = (parts, key.as_ref()) {
        if let Some(path) = download_resumable(state, file, &url, directory, &expected, parts, key, &client, progress).await? {
            return Ok(path);
        }
    }
    let mut last_error = "下载 Modrinth 资源失败，请重试".to_owned();
    for attempt in 0..3 {
        state.control.checkpoint().await?;
        let temp = safe_join(
            directory,
            &format!(".launcher-resource-{}.part", uuid::Uuid::new_v4()),
        )?;
        let result: Result<PathBuf, DownloadAttemptError> = async {
            let mut part = crate::download_io::DownloadPart::create(temp)
                .map_err(|_| "无法创建资源临时文件")?;
            let _connection = state.control.connection().await?;
            let response = state.control.during_cancellable_io(client.get(url.clone()).send())
                .await?
                .map_err(|_| DownloadAttemptError::Retry("下载 Modrinth 资源失败，请重试".into()))?;
            if !response.status().is_success() {
                let error = format!("资源下载失败（HTTP {}）", response.status().as_u16());
                return Err(if response.status().is_server_error() {
                    DownloadAttemptError::Retry(error)
                } else {
                    DownloadAttemptError::Fatal(error)
                });
            }
            cdn_url(response.url().as_str())?;
            if response
                .content_length()
                .is_some_and(|n| n > MAX_RESOURCE_BYTES || n != file.size)
            {
                return Err(DownloadAttemptError::Fatal(
                    "服务器返回的资源大小与项目元数据不一致".into(),
                ));
            }
            let mut hash = Sha512::new();
            let mut size = 0_u64;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = state.control.during_cancellable_io(stream.next()).await? {
                let chunk = chunk
                    .map_err(|_| DownloadAttemptError::Retry("资源传输中断，请重新安装".into()))?;
                state.control.throttle(chunk.len()).await?;
                size = size.saturating_add(chunk.len() as u64);
                if size > file.size || size > MAX_RESOURCE_BYTES {
                    return Err(DownloadAttemptError::Fatal(
                        "下载内容超过声明大小，已停止安装".into(),
                    ));
                }
                hash.update(&chunk);
                part.file()
                    .write_all(&chunk)
                    .await
                    .map_err(|_| "资源写入失败，请检查磁盘空间")?;
                if let Some(progress) = progress {
                    progress.emit(
                        state,
                        "resource-download",
                        0,
                        1,
                        size,
                        file.size,
                        &format!("下载 {}", file.filename),
                    );
                }
            }
            part.file().flush().await.map_err(|_| "写入资源文件失败")?;
            part.file().sync_all().await.map_err(|_| "无法保存资源文件")?;
            if size != file.size || format!("{:x}", hash.finalize()) != expected {
                return Err(DownloadAttemptError::Retry(
                    "资源 SHA-512 或大小校验失败，未安装该文件".into(),
                ));
            }
            reject_links(directory)?;
            state.control.checkpoint().await?;
            let checked = safe_join(directory, &file.filename)?;
            if checked.exists() {
                return Err(DownloadAttemptError::Fatal(
                    "下载期间出现同名文件，已保留原文件，请重新检查资源目录".into(),
                ));
            }
            part.publish_new(&checked).map_err(|_| "无法将已校验资源移入目标目录")?;
            if let Some(progress) = progress {
                progress.emit(
                    state,
                    "resource-download",
                    1,
                    1,
                    size,
                    file.size,
                    &format!("已校验 {}", file.filename),
                );
            }
            Ok(checked)
        }
        .await;
        match result {
            Ok(path) => return Ok(path),
            Err(DownloadAttemptError::Fatal(error)) => return Err(error),
            Err(DownloadAttemptError::Retry(error)) => {
                state.control.checkpoint().await?;
                last_error = error;
                if attempt < 2 {
                    state.control.during_cancellable_io(
                        tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))),
                    ).await?;
                }
            }
        }
    }
    Err(last_error)
}

pub(crate) struct ResourceTarget {
    pub(crate) directory: PathBuf,
    pub(crate) minecraft: String,
    pub(crate) loader: Option<String>,
}

pub(crate) fn resource_target(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
    kind: ResourceKind,
) -> AppResult<ResourceTarget> {
    let data = state.snapshot()?;
    let directory = resource_directory(&data, version_id, instance_id, kind)?;
    let root = crate::processes::configured_game_root(Path::new(&data.config.game_directory))?;
    let (minecraft, detected_loader) = context_for_version(&root, version_id)?;
    let loader = if kind == ResourceKind::Mod {
        Some(detected_loader.ok_or_else(|| {
            AppError::new("resource.loaderRequired")
                .with_param("versionId", version_id)
                .with_detail("当前是原版 Minecraft，无法加载模组。请创建或选择带加载器的实例。")
        })?)
    } else {
        None
    };
    Ok(ResourceTarget {
        directory,
        minecraft,
        loader,
    })
}

pub(crate) fn context_for_version(root: &Path, version_id: &str) -> AppResult<(String, Option<String>)> {
    version_context(root, version_id).map_err(|error| {
        if error == "请先安装目标 Minecraft 版本，再安装资源" {
            AppError::new("resource.versionMissing")
                .with_param("versionId", version_id)
                .with_detail(error)
        } else {
            expected(error)
        }
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceContext {
    pub game_version: String,
    pub loader: Option<String>,
}

#[tauri::command]
pub async fn get_resource_context(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> AppResult<ResourceContext> {
    // Discover asks once per instance; reading version profiles stays off the main thread.
    let shared = state.inner().clone();
    tokio::task::spawn_blocking(move || resource_context(&shared, &version_id, instance_id.as_deref()))
        .await
        .unwrap_or_else(|error| Err(crate::errors::expected(error.to_string())))
}

pub(crate) fn resource_context(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
) -> AppResult<ResourceContext> {
    let data = state.snapshot()?;
    resource_directory(&data, version_id, instance_id, ResourceKind::Mod)?;
    let root = crate::processes::configured_game_root(Path::new(&data.config.game_directory))?;
    let (game_version, loader) = context_for_version(&root, version_id)?;
    Ok(ResourceContext {
        game_version,
        loader,
    })
}

pub(crate) fn no_compatible_version(game: &str, loader: Option<&str>) -> AppError {
    AppError::new("resource.noCompatibleVersion")
        .with_param("gameVersion", game)
        .with_param("loader", loader.unwrap_or("vanilla"))
        .with_detail(format!(
            "没有适用于 Minecraft {game} / {} 的兼容版本",
            loader.unwrap_or("vanilla")
        ))
}

fn version_lite(version: &Version) -> crate::resource_targets::VersionLite {
    crate::resource_targets::VersionLite {
        id: version.id.clone(),
        game_versions: version.game_versions.clone(),
        loaders: version.loaders.clone(),
        version_type: version.version_type.clone(),
        date_published: version.date_published.clone(),
    }
}

fn target_running(
    data: &Persisted,
    version_id: &str,
    instance_id: Option<&str>,
    running: &[crate::processes::RunningGame],
) -> bool {
    let instance =
        instance_id.and_then(|id| data.instances.iter().find(|instance| instance.id == id));
    let directory = crate::minecraft::game_directory(&data.config, version_id, instance)
        .and_then(|path| crate::processes::canonical_game_directory(&path)).ok();
    running.iter().any(|game| {
        (instance_id.is_some() && game.instance_id.as_deref() == instance_id)
            || directory
                .as_ref()
                .is_some_and(|directory| crate::processes::same_canonical_directory(directory, Path::new(&game.game_directory)))
    })
}

/// Every resource writer's guard: the target's game is stopped and no restore
/// or pack update of the instance is unfinished.
pub(crate) fn require_resource_stopped(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
) -> AppResult<()> {
    require_target_stopped(state, version_id, instance_id)?;
    if let Some(id) = instance_id {
        crate::instances::require_no_pending_restore(state, id)?;
    }
    Ok(())
}

/// Only the running-game part of `require_resource_stopped`.
pub(crate) fn require_target_stopped(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
) -> AppResult<()> {
    let data = state.snapshot()?;
    let instance = instance_id.map(|id| data.instances.iter().find(|value| value.id == id)
        .ok_or("实例不存在")).transpose().map_err(|error| crate::errors::expected(error))?;
    let directory = crate::minecraft::game_directory(&data.config, version_id, instance)?;
    state.games.require_directory_stopped(&directory, instance_id, false)?;
    Ok(())
}

pub(crate) fn target_candidates(
    state: &LauncherState,
) -> AppResult<Vec<crate::resource_targets::TargetCandidate>> {
    let data = state.snapshot()?;
    let running = state.games.snapshot()?;
    let root = crate::processes::configured_game_root(Path::new(&data.config.game_directory)).ok();
    let mut candidates = Vec::new();
    for instance in &data.instances {
        let context = root.as_deref().and_then(|root| version_context(root, &instance.version_id).ok());
        candidates.push(crate::resource_targets::TargetCandidate {
            kind: "instance".into(),
            instance_id: Some(instance.id.clone()),
            version_id: instance.version_id.clone(),
            name: instance.name.clone(),
            game_version: context.as_ref().map(|context| context.0.clone()),
            loader: context.and_then(|context| context.1),
            last_played: instance.last_played.clone(),
            running: target_running(&data, &instance.version_id, Some(&instance.id), &running),
        });
    }
    let instance_versions: HashSet<_> = data
        .instances
        .iter()
        .map(|instance| instance.version_id.as_str())
        .collect();
    for version in crate::minecraft::scan_versions(&data.config) {
        if instance_versions.contains(version.id.as_str()) {
            continue;
        }
        let context = root.as_deref().and_then(|root| version_context(root, &version.id).ok());
        candidates.push(crate::resource_targets::TargetCandidate {
            kind: "version".into(),
            instance_id: None,
            version_id: version.id.clone(),
            name: version.id.clone(),
            game_version: context.as_ref().map(|context| context.0.clone()),
            loader: context.and_then(|context| context.1),
            last_played: None,
            running: target_running(&data, &version.id, None, &running),
        });
    }
    Ok(candidates)
}

fn require_modrinth(source: &str) -> AppResult<()> {
    if source == "modrinth" {
        Ok(())
    } else {
        Err(AppError::new("resource.sourceUnsupported")
            .with_detail("此来源暂不支持自动规划安装位置，请先创建带加载器的实例。"))
    }
}

#[tauri::command]
pub async fn resolve_resource_targets(
    state: tauri::State<'_, Arc<LauncherState>>,
    source: String,
    project_id: String,
    resource_type: String,
    resource_version_id: Option<String>,
    file_id: Option<u64>,
) -> AppResult<crate::resource_targets::ResourceTargetPlan> {
    if source == "curseforge" && resource_version_id.is_none() {
        let file_id = file_id.ok_or_else(|| expected("请选择要安装的 CurseForge 文件"))?;
        return crate::curseforge::resolve_pinned_targets(&state, &project_id, &resource_type, file_id).await;
    }
    require_modrinth(&source)?;
    if file_id.is_some() { return Err(expected("资源文件标识无效")); }
    let kind = ResourceKind::parse(&resource_type)?;
    identifier(&project_id)?;
    if let Some(id) = resource_version_id.as_deref() { identifier(id)?; }
    let api = client(&state, false)?;
    let project: Project = api_json(&api, &format!("project/{project_id}"), &[]).await?;
    if project.project_type != kind.project_type() {
        return Err(expected("资源项目类型与所选分类不一致，已拒绝安装"));
    }
    if let Some(id) = resource_version_id.as_deref() {
        let version = fetch_pinned_modrinth_version(&api, id, &project.id, kind).await?;
        return resolve_plan(&state, &project, std::slice::from_ref(&version), kind, true, crate::minecraft::manifest(&state)).await;
    }
    let versions = all_project_versions(&api, &project.id).await?;
    resolve_resource_targets_inner(
        &state,
        &project,
        &versions,
        kind,
        crate::minecraft::manifest(&state),
    )
    .await
}

async fn resolve_resource_targets_inner(
    state: &LauncherState,
    project: &Project,
    versions: &[Version],
    kind: ResourceKind,
    manifest: impl std::future::Future<Output = Result<Value, String>>,
) -> AppResult<crate::resource_targets::ResourceTargetPlan> {
    resolve_plan(state, project, versions, kind, false, manifest).await
}

pub(crate) fn manifest_releases(manifest: Result<Value, String>) -> Vec<(String, String)> {
    let manifest = manifest.ok();
    manifest
        .as_ref()
        .and_then(|manifest| manifest["versions"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|version| {
            Some((
                version["id"].as_str()?.to_owned(),
                version["type"].as_str()?.to_owned(),
            ))
        })
        .collect::<Vec<_>>()
}

async fn resolve_plan(
    state: &LauncherState,
    project: &Project,
    versions: &[Version],
    kind: ResourceKind,
    pinned: bool,
    manifest: impl std::future::Future<Output = Result<Value, String>>,
) -> AppResult<crate::resource_targets::ResourceTargetPlan> {
    let metadata: Vec<_> = versions.iter().map(version_lite).collect();
    // A release manifest is needed to suggest a new profile, not to install
    // into a target whose local game/loader metadata is already compatible.
    let manifest = manifest_releases(manifest.await);
    let targets = target_candidates(state)?;
    if pinned {
        let [version] = metadata.as_slice() else {
            return Err(expected("Modrinth 项目或版本不存在"));
        };
        return Ok(crate::resource_targets::build_pinned_plan(
            &project.id, &project.title, &project.project_type, kind, &targets, version, &manifest,
        ));
    }
    Ok(crate::resource_targets::build_plan(
        &project.id,
        &project.title,
        &project.project_type,
        kind,
        &targets,
        &metadata,
        &manifest,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInstanceResult {
    pub instance: Instance,
    pub install: ResourceInstall,
}

fn after_create_error(error: AppError, instance: Option<&Instance>) -> AppError {
    match instance {
        None => error,
        Some(instance) => AppError::new("resource.installAfterCreate")
            .with_param("instanceId", instance.id.clone())
            .with_param("instanceName", instance.name.clone())
            .with_param("versionId", instance.version_id.clone())
            .with_param("causeCode", error.code.clone())
            .with_detail(error.detail.unwrap_or(error.code)),
    }
}

fn finish_resource_task(state: &LauncherState, task: &str, error: Option<&AppError>) {
    state.control.finish(task, error.map(|error| error.detail.as_deref().unwrap_or(&error.code)));
}

#[tauri::command]
pub async fn reserve_resource_task(
    state: tauri::State<'_, Arc<LauncherState>>,
    request: ResourceRequest,
) -> AppResult<String> {
    validate_resource_request(&request)?;
    Ok(state.control.reserve_resource(request)?)
}

pub(crate) fn validate_resource_request(request: &ResourceRequest) -> AppResult<()> {
    let kind = ResourceKind::parse(&request.resource_type)?;
    match request.source {
        ResourceSource::Modrinth => identifier(&request.project_id)?,
        ResourceSource::Curseforge => { crate::curseforge::project_id(&request.project_id)?; }
    }
    match &request.target {
        ReservedTarget::Existing { version_id, instance_id, file_id, resource_version_id } => {
            validate_id(version_id)?;
            if let Some(instance_id) = instance_id { validate_id(instance_id)?; }
            if let Some(pinned) = resource_version_id {
                if request.source != ResourceSource::Modrinth || file_id.is_some() {
                    return Err("资源文件标识无效".into());
                }
                identifier(pinned)?;
            }
            if let Some(file) = file_id {
                if request.source != ResourceSource::Curseforge || !(1..=u64::from(u32::MAX)).contains(file) {
                    return Err("资源文件标识无效".into());
                }
            }
        }
        ReservedTarget::Create { game_version, loader, loader_version, name, resource_version_id, file_id } => {
            match request.source {
                ResourceSource::Modrinth if file_id.is_none() => {
                    if let Some(id) = resource_version_id { identifier(id)?; }
                }
                ResourceSource::Curseforge if resource_version_id.is_none() && file_id.is_some_and(|id| (1..=u64::from(u32::MAX)).contains(&id)) => {}
                _ => return Err("资源文件标识无效".into()),
            }
            validate_id(game_version)?;
            validate_id(loader)?;
            if !["fabric", "quilt", "forge", "neoforge"].contains(&loader.as_str())
                && !(loader == "vanilla" && kind != ResourceKind::Mod)
            {
                return Err(no_compatible_version(game_version, Some(loader)));
            }
            if let Some(version) = loader_version.as_deref().filter(|version| !version.is_empty()) {
                validate_id(version)?;
            }
            crate::commands::validate_instance_name(name)?;
        }
    }
    Ok(())
}

pub(crate) async fn with_reserved_resource_task<T>(
    state: &LauncherState,
    id: &str,
    request: ResourceRequest,
    task: impl Future<Output = AppResult<T>>,
) -> AppResult<T> {
    state.control.claim_resource(id, request)?;
    let _operation = state.control.wait_for_turn(&state.operation, id).await?;
    if !state.control.activate(id) {
        return Err(CANCELLED.into());
    }
    let result = async {
        state.control.checkpoint().await?;
        task.await
    }.await;
    finish_resource_task(state, id, result.as_ref().err());
    result
}

/// A Create request as an install into the instance it made (other requests unchanged).
fn into_instance(request: ResourceRequest, instance: &Instance) -> ResourceRequest {
    match request.target {
        ReservedTarget::Create { file_id, resource_version_id, .. } => ResourceRequest {
            target: ReservedTarget::Existing {
                version_id: instance.version_id.clone(),
                instance_id: Some(instance.id.clone()),
                file_id,
                resource_version_id,
            },
            ..request
        },
        target => ResourceRequest { target, ..request },
    }
}

/// The file a request for the latest one resolved to.
pub(crate) enum Pin<'a> {
    Modrinth(&'a str),
    Curseforge(u64),
}

/// Records the file this run chose, so a retry of a request for the latest
/// file installs the same one.
pub(crate) fn pin_retry(state: &LauncherState, task: &str, request: &ResourceRequest, pin: Pin<'_>) {
    let mut request = request.clone();
    let (ReservedTarget::Existing { file_id, resource_version_id, .. } | ReservedTarget::Create { file_id, resource_version_id, .. }) =
        &mut request.target;
    match pin {
        Pin::Modrinth(id) => *resource_version_id = Some(id.to_owned()),
        Pin::Curseforge(id) => *file_id = Some(id),
    }
    state.control.set_retry(task, Some(crate::downloads::RetryRequest::Resource { request }));
}

/// What a resource install produced.
pub(crate) enum ResourceOutcome {
    Installed(ResourceInstall),
    Created(ResourceInstanceResult),
}

impl ResourceOutcome {
    pub(crate) fn installed(self) -> AppResult<ResourceInstall> {
        match self {
            Self::Installed(install) => Ok(install),
            Self::Created(_) => Err("资源安装结果与请求不一致".into()),
        }
    }

    pub(crate) fn created(self) -> AppResult<ResourceInstanceResult> {
        match self {
            Self::Created(result) => Ok(result),
            Self::Installed(_) => Err("资源安装结果与请求不一致".into()),
        }
    }
}

/// The one path every resource install takes, from the four commands and from
/// a retry: the reserved request alone decides the source and the target.
pub(crate) async fn run_resource_request(
    state: &Arc<LauncherState>,
    app: Option<&AppHandle>,
    task: &str,
    request: ResourceRequest,
) -> AppResult<ResourceOutcome> {
    validate_resource_request(&request)?;
    let existing = matches!(request.target, ReservedTarget::Existing { .. });
    Ok(match (request.source, existing) {
        (ResourceSource::Modrinth, true) => ResourceOutcome::Installed(install_modrinth(state, app, task, request).await?),
        (ResourceSource::Curseforge, true) => {
            ResourceOutcome::Installed(crate::curseforge::install_curseforge(state, task, request).await?)
        }
        (ResourceSource::Modrinth, false) => ResourceOutcome::Created(create_with_modrinth(state, app, task, request).await?),
        (ResourceSource::Curseforge, false) => {
            ResourceOutcome::Created(crate::curseforge::create_with_pinned_file(state, app, task, request).await?)
        }
    })
}

/// A resource install retried from the Downloads page: the same path as the
/// first attempt, through the same reservation, claim and operation lock.
pub(crate) async fn run_queued_resource(app: AppHandle, state: Arc<LauncherState>, task: String, request: ResourceRequest) {
    if let Err(error) = run_resource_request(&state, Some(&app), &task, request).await {
        let message = error.detail.clone().unwrap_or_else(|| error.code.clone());
        // A payload refused before the claim still ends its task (no-op otherwise).
        state.control.finish(&task, Some(&message));
        crate::minecraft::log(&app, &state, "error", message);
    }
}

pub(crate) async fn create_resource_instance_then_install<F, Fut>(
    state: &LauncherState,
    task: &str,
    name: String,
    version_id: String,
    install: F,
) -> AppResult<ResourceInstanceResult>
where
    F: FnOnce(Instance) -> Fut,
    Fut: std::future::Future<Output = AppResult<ResourceInstall>>,
{
    // This is the registration boundary: a cancelled loader never leaves an instance.
    state.control.checkpoint().await?;
    let instance = crate::commands::create_instance_inner(state, name, version_id)?;
    // From here a retry, also one after a crash, installs into this instance
    // instead of creating a second one. The journal is saved at once.
    if let Some(crate::downloads::RetryRequest::Resource { request }) = state.control.retry_of(task) {
        let request = into_instance(request, &instance);
        state.control.set_retry(task, Some(crate::downloads::RetryRequest::Resource { request }));
    }
    let result = async {
        state.control.checkpoint().await?;
        install(instance.clone()).await
    }
    .await;
    let install = result.map_err(|error| after_create_error(error, Some(&instance)))?;
    Ok(ResourceInstanceResult { instance, install })
}

#[tauri::command]
pub async fn create_instance_for_resource(
    app: AppHandle,
    state: tauri::State<'_, Arc<LauncherState>>,
    source: String,
    project_id: String,
    resource_type: String,
    resource_version_id: Option<String>,
    file_id: Option<u64>,
    game_version: String,
    loader: String,
    loader_version: Option<String>,
    name: String,
    task_id: String,
) -> AppResult<ResourceInstanceResult> {
    let request = if source == "curseforge" && resource_version_id.is_none() {
        let file_id = file_id.ok_or_else(|| expected("请选择要安装的 CurseForge 文件"))?;
        ResourceRequest {
            source: ResourceSource::Curseforge, project_id, resource_type,
            target: ReservedTarget::Create { game_version, loader, loader_version, name, file_id: Some(file_id), resource_version_id: None },
        }
    } else {
        require_modrinth(&source)?;
        if file_id.is_some() { return Err(expected("资源文件标识无效")); }
        ResourceRequest {
            source: ResourceSource::Modrinth, project_id, resource_type,
            target: ReservedTarget::Create { game_version, loader, loader_version, name, file_id: None, resource_version_id },
        }
    };
    run_resource_request(state.inner(), Some(&app), &task_id, request).await?.created()
}

async fn create_with_modrinth(
    state: &Arc<LauncherState>,
    app: Option<&AppHandle>,
    task: &str,
    request: ResourceRequest,
) -> AppResult<ResourceInstanceResult> {
    let ReservedTarget::Create { game_version, loader, loader_version, name, resource_version_id, .. } = request.target.clone() else {
        return Err("资源文件标识无效".into());
    };
    let (project_id, resource_type, retry) = (request.project_id.clone(), request.resource_type.clone(), request.clone());
    with_reserved_resource_task(state, task, request, async {
        let kind = ResourceKind::parse(&resource_type)?;
        let name = crate::commands::validate_instance_name(&name)?;
        let progress = ResourceProgress::new(app, &game_version);
        progress.stage(state, "resource-preflight", "检查资源及必需前置");
        let api = client(state, false)?;
        let project: Project = api_json(&api, &format!("project/{project_id}"), &[]).await?;
        if project.project_type != kind.project_type() {
            return Err(expected("资源项目类型与所选分类不一致，已拒绝安装"));
        }
        let resource_loader = (kind == ResourceKind::Mod).then_some(loader.as_str());
        let selected = if let Some(id) = resource_version_id.as_deref() {
            let selected = fetch_pinned_modrinth_version(&api, id, &project.id, kind).await?;
            let lite = version_lite(&selected);
            // A "latest" Create of a shader or resource pack accepts any allowed
            // loader for its game version; its pinned retry accepts that version too.
            if kind == ResourceKind::Mod
                || crate::resource_targets::validate_request(std::slice::from_ref(&lite), kind, &loader, &game_version).is_err()
            {
                crate::resource_targets::validate_pinned_creation_pair(&lite, kind, &loader, &game_version)?;
            }
            selected
        } else {
            let versions = project_versions(&api, &project.id, &game_version, resource_loader).await?;
            let metadata: Vec<_> = versions.iter().map(version_lite).collect();
            let chosen =
                crate::resource_targets::validate_request(&metadata, kind, &loader, &game_version)?;
            let selected = versions
                .iter()
                .find(|version| version.id == chosen.id)
                .cloned()
                .ok_or_else(|| no_compatible_version(&game_version, resource_loader))?;
            if selected.project_id != project.id {
                return Err(expected("Modrinth 版本与项目标识不一致"));
            }
            pin_retry(state, task, &retry, Pin::Modrinth(&selected.id));
            selected
        };
        resource_transactions::preflight(
            state,
            &api,
            selected.clone(),
            &game_version,
            resource_loader,
            kind,
        )
        .await?;
        state.control.checkpoint().await?;
        progress.stage(state, "resource-loader", "安装 Minecraft 及加载器");
        let version_id = match prepared_version() {
            Some(version_id) => version_id,
            None => {
                let app = app.ok_or_else(|| AppError::from("创建实例需要启动器窗口"))?;
                if loader == "vanilla" {
                    crate::minecraft::install(state, app, &game_version).await?;
                    game_version.clone()
                } else {
                    crate::loaders::install_loader_inner(
                        state,
                        app,
                        &loader,
                        &game_version,
                        loader_version.as_deref().unwrap_or("latest"),
                    )
                    .await?
                    .version_id
                }
            }
        };
        progress.stage(state, "resource-create", "创建实例");
        let install_state = state.clone();
        let install_app = app.cloned();
        create_resource_instance_then_install(
            state,
            task,
            name.clone(),
            version_id.clone(),
            move |instance| async move {
                require_resource_stopped(&install_state, &version_id, Some(&instance.id))?;
                let target =
                    resource_target(&install_state, &version_id, Some(&instance.id), kind)?;
                let resource_progress = ResourceProgress::new(install_app.as_ref(), &version_id);
                let install = resource_transactions::install(
                    &install_state,
                    &target.directory,
                    &target.minecraft,
                    target.loader.as_deref(),
                    &project.title,
                    selected,
                    kind,
                    true,
                    Some(&resource_progress),
                )
                .await?;
                resource_progress.emit(
                    &install_state,
                    "complete",
                    1,
                    1,
                    0,
                    0,
                    "实例及资源安装完成",
                );
                Ok(install)
            },
        )
        .await
    }).await
}

fn history_target(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
    kind: ResourceKind,
) -> Result<PathBuf, String> {
    resource_directory(&state.snapshot()?, version_id, instance_id, kind)
}


async fn fetch_pinned_modrinth_version(
    api: &reqwest::Client,
    id: &str,
    project_id: &str,
    kind: ResourceKind,
) -> AppResult<Version> {
    identifier(id)?;
    let version = api_json(api, &format!("version/{id}"), &[]).await?;
    validate_pinned_file(&version, id, project_id, kind)?;
    Ok(version)
}

fn validate_pinned_file(version: &Version, requested: &str, project_id: &str, kind: ResourceKind) -> AppResult<()> {
    if version.project_id != project_id || version.id != requested {
        return Err("Modrinth 版本与项目标识不一致".into());
    }
    if !kind.accepts(&primary_file(version)?.filename) {
        return Err("资源文件扩展名与目标分类不一致".into());
    }
    Ok(())
}

fn validate_pinned_version(
    version: Version,
    requested: &str,
    project_id: &str,
    kind: ResourceKind,
    minecraft: &str,
    loader: Option<&str>,
) -> AppResult<Version> {
    validate_pinned_file(&version, requested, project_id, kind)?;
    if !compatible(&version, minecraft, loader) || kind == ResourceKind::Mod && loader.is_none() {
        return Err(no_compatible_version(minecraft, loader));
    }
    crate::resource_targets::validate_request(&[version_lite(&version)], kind, loader.unwrap_or("vanilla"), minecraft)?;
    Ok(version)
}

async fn select_modrinth_install_version(
    api: &reqwest::Client,
    project_id: &str,
    kind: ResourceKind,
    minecraft: &str,
    loader: Option<&str>,
    resource_version_id: Option<&str>,
) -> AppResult<Version> {
    if let Some(id) = resource_version_id {
        let version = fetch_pinned_modrinth_version(api, id, project_id, kind).await?;
        return validate_pinned_version(version, id, project_id, kind, minecraft, loader);
    }
    let versions = project_versions(api, project_id, minecraft, loader).await?;
    let metadata: Vec<_> = versions.iter().map(version_lite).collect();
    let chosen = crate::resource_targets::validate_request(
        &metadata, kind, loader.unwrap_or("vanilla"), minecraft,
    )?;
    let version = versions.into_iter().find(|version| version.id == chosen.id)
        .ok_or_else(|| no_compatible_version(minecraft, loader))?;
    if version.project_id != project_id {
        return Err("Modrinth 版本与项目标识不一致".into());
    }
    Ok(version)
}

#[tauri::command]
pub async fn install_resource(
    app: AppHandle,
    state: tauri::State<'_, Arc<LauncherState>>,
    project_id: String,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    resource_version_id: Option<String>,
    task_id: String,
) -> AppResult<ResourceInstall> {
    let request = ResourceRequest {
        source: ResourceSource::Modrinth, project_id, resource_type,
        target: ReservedTarget::Existing { version_id, instance_id, file_id: None, resource_version_id },
    };
    run_resource_request(state.inner(), Some(&app), &task_id, request).await?.installed()
}

async fn install_modrinth(
    state: &Arc<LauncherState>,
    app: Option<&AppHandle>,
    task: &str,
    request: ResourceRequest,
) -> AppResult<ResourceInstall> {
    let ReservedTarget::Existing { version_id, instance_id, resource_version_id, .. } = request.target.clone() else {
        return Err("资源文件标识无效".into());
    };
    let (project_id, resource_type, retry) = (request.project_id.clone(), request.resource_type.clone(), request.clone());
    with_reserved_resource_task(state, task, request, async {
        let kind = ResourceKind::parse(&resource_type)?;
        require_resource_stopped(state, &version_id, instance_id.as_deref())?;
        let progress = ResourceProgress::new(app, &version_id);
        progress.stage(state, "resource-plan", "检查资源安装位置");
        let target = resource_target(state, &version_id, instance_id.as_deref(), kind)?;
        let api = client(state, false)?;
        let project: Project = api_json(&api, &format!("project/{project_id}"), &[]).await?;
        if project.project_type != kind.project_type() {
            return Err("资源项目类型与所选分类不一致，已拒绝安装".into());
        }
        let version = select_modrinth_install_version(
            &api, &project.id, kind, &target.minecraft, target.loader.as_deref(), resource_version_id.as_deref(),
        ).await?;
        if resource_version_id.is_none() {
            pin_retry(state, task, &retry, Pin::Modrinth(&version.id));
        }
        let result = resource_transactions::install(
            state,
            &target.directory,
            &target.minecraft,
            target.loader.as_deref(),
            &project.title,
            version,
            kind,
            true,
            Some(&progress),
        ).await?;
        progress.emit(state, "complete", 1, 1, 0, 0, "资源安装完成");
        Ok(result)
    }).await
}

/// The update rows of one resource folder, from Modrinth and CurseForge.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUpdateCheck {
    pub updates: Vec<resource_transactions::ResourceUpdate>,
    /// No CurseForge key is configured, so CurseForge files were not checked.
    pub curseforge_skipped: bool,
    /// CurseForge could not be checked; the Modrinth rows are still complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub curseforge_error: Option<String>,
}

/// A CurseForge failure keeps the Modrinth rows (reported beside them); a
/// cancel still ends the whole check.
fn curseforge_part(
    result: Result<(Vec<resource_transactions::ResourceUpdate>, bool), String>,
) -> AppResult<(Vec<resource_transactions::ResourceUpdate>, bool, Option<String>)> {
    match result {
        Ok((rows, skipped)) => Ok((rows, skipped, None)),
        Err(error) if error == CANCELLED => Err(expected(error)),
        Err(error) => Ok((Vec::new(), false, Some(error))),
    }
}

#[tauri::command]
pub async fn check_resource_updates(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
) -> AppResult<ResourceUpdateCheck> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    let task = state
        .control
        .begin("resource-check", &version_id, "检查资源更新")?;
    let result: AppResult<ResourceUpdateCheck> = async {
        let target = resource_target(&state, &version_id, instance_id.as_deref(), kind)?;
        let (mut updates, identified) = resource_transactions::updates(
            &state,
            &target.directory,
            &target.minecraft,
            target.loader.as_deref(),
            kind,
        )
        .await
        .map_err(expected)?;
        // Modrinth wins: a file it identified never gets a CurseForge row.
        let curseforge = crate::curseforge::curseforge_updates(
            &state,
            &target.directory,
            &target.minecraft,
            target.loader.as_deref(),
            kind,
            &resource_type,
            &identified,
        )
        .await;
        // A cancel is never reported as a finished check, whatever CurseForge answered.
        state.control.checkpoint().await.map_err(expected)?;
        let (curseforge, curseforge_skipped, curseforge_error) = curseforge_part(curseforge)?;
        updates.extend(curseforge);
        Ok(ResourceUpdateCheck { updates, curseforge_skipped, curseforge_error })
    }
    .await;
    state.control.finish(
        &task,
        result
            .as_ref()
            .err()
            .map(|error| error.detail.as_deref().unwrap_or(&error.code)),
    );
    result
}

#[tauri::command]
pub async fn update_resource(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    file_name: String,
    new_version_id: String,
    source: Option<String>,
    new_file_id: Option<u64>,
) -> AppResult<ResourceInstall> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    require_resource_stopped(&state, &version_id, instance_id.as_deref())?;
    let task = state
        .control
        .begin("resource-update", &file_name, "更新资源及必需前置")?;
    let result: AppResult<ResourceInstall> = async {
        let target = resource_target(&state, &version_id, instance_id.as_deref(), kind)?;
        match source.as_deref() {
            None | Some("modrinth") => {}
            Some("curseforge") => {
                let new_file_id = new_file_id.ok_or_else(|| expected("CurseForge 文件标识无效"))?;
                let detected = resource_context(&state, &version_id, instance_id.as_deref())?.loader;
                return crate::curseforge::update_one(
                    state.inner(),
                    &target.directory,
                    &target.minecraft,
                    target.loader.as_deref(),
                    detected.as_deref(),
                    kind,
                    &resource_type,
                    &file_name,
                    new_file_id,
                )
                .await;
            }
            Some(_) => return Err(expected("资源来源无效")),
        }
        resource_transactions::update_one(
            state.inner(),
            &target.directory,
            &target.minecraft,
            target.loader.as_deref(),
            kind,
            &file_name,
            &new_version_id,
        )
        .await
        .map_err(expected)
    }
    .await;
    state.control.finish(
        &task,
        result
            .as_ref()
            .err()
            .map(|error| error.detail.as_deref().unwrap_or(&error.code)),
    );
    result
}

#[tauri::command]
pub async fn list_resource_update_history(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
) -> Result<Vec<resource_transactions::ResourceHistory>, String> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    let directory = history_target(&state, &version_id, instance_id.as_deref(), kind)?;
    resource_transactions::history(&directory)
}

#[tauri::command]
pub async fn rollback_resource_update(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    update_id: String,
) -> AppResult<resource_transactions::RollbackResult> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    require_resource_stopped(&state, &version_id, instance_id.as_deref())?;
    let directory = history_target(&state, &version_id, instance_id.as_deref(), kind)?;
    resource_transactions::rollback(&directory, &update_id).map_err(expected)
}

fn recover_resource_update_inner(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
    kind: ResourceKind,
    update_id: &str,
    running: &[crate::processes::RunningGame],
) -> AppResult<resource_transactions::RollbackResult> {
    let data = state.snapshot()?;
    let directory = resource_directory(&data, version_id, instance_id, kind)?;
    if target_running(&data, version_id, instance_id, running) {
        return Err(AppError::new(crate::errors::RESOURCE_RECOVERY_RUNNING)
            .with_detail("此目标的游戏仍在运行，请先退出游戏再恢复资源。"));
    }
    if let Some(id) = instance_id {
        crate::instances::require_no_pending_restore(state, id)?;
    }
    resource_transactions::recover_one(&directory, update_id)
}

#[tauri::command]
pub async fn recover_resource_update(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    update_id: String,
) -> AppResult<resource_transactions::RollbackResult> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    let running = state.games.snapshot()?;
    recover_resource_update_inner(
        &state,
        &version_id,
        instance_id.as_deref(),
        kind,
        &update_id,
        &running,
    )
}

fn local_resource(path: PathBuf, kind: ResourceKind) -> Result<Option<LocalResource>, String> {
    let Some((mut resource, metadata)) = local_resource_without_metadata(path, kind)? else {
        return Ok(None);
    };
    resource.metadata = matches!(kind, ResourceKind::Mod)
        .then(|| crate::mod_metadata::cached_metadata(Path::new(&resource.path), &metadata)).flatten();
    Ok(Some(resource))
}

/// File-state checks only; never opens the archive.
fn local_resource_without_metadata(
    path: PathBuf,
    kind: ResourceKind,
) -> Result<Option<(LocalResource, fs::Metadata)>, String> {
    let metadata = fs::symlink_metadata(&path).map_err(|_| "无法读取资源文件信息")?;
    if !metadata.is_file() || linked(&metadata) {
        return Ok(None);
    }
    let Some(file_name) = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
    else {
        return Ok(None);
    };
    let enabled = !file_name.to_ascii_lowercase().ends_with(".disabled");
    let original = if enabled {
        file_name.as_str()
    } else {
        &file_name[..file_name.len() - 9]
    };
    if !kind.accepts(original) || validate_id(&file_name).is_err() {
        return Ok(None);
    }
    Ok(Some((LocalResource {
        name: original.to_owned(),
        file_name,
        path: path.to_string_lossy().into_owned(),
        enabled,
        size: metadata.len(),
        modified_ms: metadata.modified().ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|time| time.as_millis() as u64),
        metadata: None,
    }, metadata)))
}

#[tauri::command]
pub async fn list_local_resources(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
) -> AppResult<Vec<LocalResource>> {
    list_local_resources_inner(state, version_id, instance_id, resource_type)
        .await
        .map_err(expected)
}

async fn list_local_resources_inner(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
) -> Result<Vec<LocalResource>, String> {
    let kind = ResourceKind::parse(&resource_type)?;
    let directory = resource_directory(
        &state.snapshot()?,
        &version_id,
        instance_id.as_deref(),
        kind,
    )?;
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || list_local_resources_blocking(&state, &directory, kind))
        .await.map_err(|_| "资源目录读取任务意外中止")?
}

fn list_local_resources_blocking(
    state: &LauncherState, directory: &Path, kind: ResourceKind,
) -> Result<Vec<LocalResource>, String> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    reject_links(directory)?;
    let mut result = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|_| "无法读取资源目录，请检查访问权限")?
    {
        crate::instances::sync_checkpoint(state)?;
        let entry = entry.map_err(|_| "读取资源目录失败")?;
        if let Some(resource) = local_resource(entry.path(), kind)? {
            result.push(resource);
        }
    }
    result.sort_by_key(|resource| resource.file_name.to_ascii_lowercase());
    Ok(result)
}

#[tauri::command]
pub async fn read_local_mod_icon(
    state: tauri::State<'_, Arc<LauncherState>>, version_id: String, instance_id: Option<String>, file_name: String,
) -> AppResult<Option<String>> {
    let data = state.snapshot()?;
    tokio::task::spawn_blocking(move || read_local_mod_icon_blocking(&data, &version_id, instance_id.as_deref(), &file_name))
        .await.map_err(|_| expected("模组图标读取任务意外中止"))?.map_err(expected)
}

fn read_local_mod_icon_blocking(
    data: &Persisted, version_id: &str, instance_id: Option<&str>, file_name: &str,
) -> Result<Option<String>, String> {
    validate_id(file_name)?;
    let original = if file_name.to_ascii_lowercase().ends_with(".disabled") {
        &file_name[..file_name.len() - ".disabled".len()]
    } else { file_name };
    if !ResourceKind::Mod.accepts(original) { return Ok(None); }
    let directory = resource_directory(data, version_id, instance_id, ResourceKind::Mod)?;
    reject_links(&directory)?;
    let path = safe_join(&directory, file_name)?;
    Ok(crate::mod_metadata::read_icon(&path))
}

#[tauri::command]
pub async fn toggle_resource(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    file_name: String,
) -> AppResult<LocalResource> {
    let kind = ResourceKind::parse(&resource_type)?;
    validate_id(&file_name)?;
    let target = {
        let _operation = state.operation.lock().await;
        // Enabling or disabling is a write to the game directory.
        require_resource_stopped(&state, &version_id, instance_id.as_deref())?;
        let directory = resource_directory(
            &state.snapshot()?,
            &version_id,
            instance_id.as_deref(),
            kind,
        )?;
        resource_transactions::require_no_pending(&directory)?;
        reject_links(&directory)?;
        let source = safe_join(&directory, &file_name)?;
        let (resource, _) = local_resource_without_metadata(source.clone(), kind)?.ok_or("请选择有效的资源文件")?;
        let target_name = if resource.enabled {
            format!("{file_name}.disabled")
        } else {
            file_name[..file_name.len() - 9].to_owned()
        };
        validate_id(&target_name)?;
        let target = safe_join(&directory, &target_name)?;
        if target.exists() {
            return Err("目标文件名已存在，已保留两个文件。请先手动处理重名文件。".into());
        }
        fs::rename(&source, &target).map_err(|_| "切换资源状态失败，请检查文件是否被游戏占用")?;
        target
    };
    // Metadata may open the archive; do that off the async worker and outside the lock.
    tokio::task::spawn_blocking(move || local_resource(target, kind))
        .await
        .map_err(|_| expected("资源状态无法读取"))??
        .ok_or_else(|| expected("资源状态无法读取"))
}

/// Reject an empty or unbounded batch and fold case-insensitive duplicates
/// before the writer takes the operation lock.
fn delete_file_names(file_names: Vec<String>) -> Result<Vec<String>, String> {
    if file_names.is_empty() {
        return Err("请选择要删除的资源文件".into());
    }
    if file_names.len() > 500 {
        return Err("一次最多删除 500 个资源文件".into());
    }
    let mut seen = HashSet::new();
    let mut names = Vec::with_capacity(file_names.len());
    for name in file_names {
        validate_id(&name)?;
        if seen.insert(name.to_ascii_lowercase()) {
            names.push(name);
        }
    }
    Ok(names)
}

#[tauri::command]
pub async fn delete_local_resources(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    file_names: Vec<String>,
) -> AppResult<DeleteResourcesResult> {
    let kind = ResourceKind::parse(&resource_type)?;
    delete_local_resources_inner(&state, version_id, instance_id, kind, file_names).await
}

/// Every path is validated before any file is removed, so a refused batch
/// leaves all of its valid files in place.
async fn delete_local_resources_inner(
    state: &LauncherState,
    version_id: String,
    instance_id: Option<String>,
    kind: ResourceKind,
    file_names: Vec<String>,
) -> AppResult<DeleteResourcesResult> {
    let file_names = delete_file_names(file_names)?;
    let _operation = state.operation.lock().await;
    require_resource_stopped(state, &version_id, instance_id.as_deref())?;
    let directory = resource_directory(
        &state.snapshot()?,
        &version_id,
        instance_id.as_deref(),
        kind,
    )?;
    resource_transactions::require_no_pending(&directory)?;
    reject_links(&directory)?;
    tokio::task::spawn_blocking(move || {
        let mut paths = Vec::with_capacity(file_names.len());
        for file_name in &file_names {
            let path = safe_join(&directory, file_name)?;
            reject_links(&path)?;
            if local_resource_without_metadata(path.clone(), kind)?.is_none() {
                return Err(format!("请选择有效的资源文件：{file_name}"));
            }
            paths.push(path);
        }
        let mut deleted = Vec::with_capacity(paths.len());
        for (file_name, path) in file_names.into_iter().zip(paths) {
            fs::remove_file(&path).map_err(|_| format!("无法删除资源文件：{file_name}"))?;
            deleted.push(file_name);
        }
        Ok(DeleteResourcesResult { deleted })
    })
    .await
    .map_err(|_| expected("资源删除任务意外中止"))?
    .map_err(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c5_count_enabled_mods_counts_only_enabled_top_level_jar_files() {
        let fixture = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/mod-count-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let mods = fixture.path().join("mods");
        assert_eq!(count_enabled_mods(&mods), Ok(0), "a missing folder means no mods");
        fs::create_dir_all(mods.join("sub")).unwrap();
        fs::create_dir(mods.join("e.jar")).unwrap();
        for name in ["a.jar", "B.JAR", "c.jar.disabled", "d.zip", "sub/x.jar"] {
            fs::write(mods.join(name), b"jar").unwrap();
        }
        assert_eq!(count_enabled_mods(&mods), Ok(2));
        let file = fixture.path().join("not-a-folder");
        fs::write(&file, b"").unwrap();
        assert!(count_enabled_mods(&file).is_err());
        #[cfg(windows)]
        {
            let alias = fixture.path().join("linked-mods");
            let output = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(alias.to_string_lossy().replace('/', r"\"))
                .arg(mods.to_string_lossy().replace('/', r"\"))
                .output().unwrap();
            assert!(output.status.success(), "{output:?}");
            let counted = count_enabled_mods(&alias);
            let _ = fs::remove_dir(&alias);
            assert!(counted.is_err(), "a linked mods folder must not be followed");
        }
    }

    #[test]
    fn a4_same_root_blocks_reserved_mod_install_before_writing_in_the_target() {
        let fixture = crate::storage::SameRootFixture::new();
        let instance = &fixture.instance;
        let directory =
            resource_directory(&fixture.state.snapshot().unwrap(), &instance.version_id, Some(&instance.id), ResourceKind::Mod)
                .unwrap();
        assert!(!directory.exists());
        require_resource_stopped(&fixture.state, &instance.version_id, Some(&instance.id)).unwrap();
        fixture.mark_running();
        let request = ResourceRequest {
            source: ResourceSource::Modrinth,
            project_id: "fixture-project".into(),
            resource_type: "mod".into(),
            target: ReservedTarget::Existing {
                version_id: instance.version_id.clone(),
                instance_id: Some(instance.id.clone()),
                file_id: None, resource_version_id: None,
            },
        };
        let task_id = fixture.state.control.reserve_resource(request.clone()).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let result = with_reserved_resource_task(&fixture.state, &task_id, request, async {
                    require_resource_stopped(&fixture.state, &instance.version_id, Some(&instance.id))?;
                    // A fixture side effect represents the download/writer after preflight.
                    fs::create_dir_all(&directory).unwrap();
                    fs::write(directory.join("fixture.jar"), b"test resource").unwrap();
                    Ok(())
                })
                .await;
                assert_eq!(result.unwrap_err().code, "instance.running");
            });
        assert!(!directory.exists(), "no installer artifact or staging directory");
    }

    #[test]
    fn a4_pinned_create_writers_keep_reservation_preflight_and_same_root_order() {
        fn section(source: &str, marker: &str) -> String {
            let (_, tail) = source.split_once(marker).unwrap_or_else(|| panic!("missing {marker}"));
            crate::storage::executable_source(tail.split_once("\n}").unwrap_or_else(|| panic!("unterminated {marker}")).0)
        }
        fn ordered(body: &str, markers: &[&str]) {
            let mut remaining = body;
            for marker in markers {
                let (_, next) = remaining.split_once(marker).unwrap_or_else(|| panic!("missing or out of order: {marker}"));
                remaining = next;
            }
        }
        let mr = include_str!("resources.rs");
        let cf = include_str!("curseforge.rs");
        ordered(&section(mr, "pub(crate) async fn with_reserved_resource_task<"), &[
            "claim_resource(id, request)", "wait_for_turn(&state.operation, id).await", "task.await",
        ]);
        ordered(&section(mr, "async fn create_with_modrinth("), &[
            "with_reserved_resource_task(", "let api = client(", "fetch_pinned_modrinth_version(",
            "validate_pinned_creation_pair(", "resource_transactions::preflight(", "install_loader_inner(",
            "create_resource_instance_then_install(", "require_resource_stopped(", "resource_target(",
            "resource_transactions::install(",
        ]);
        ordered(&section(cf, "pub(crate) async fn create_with_pinned_file("), &[
            "with_reserved_resource_task(", "let key = service_key(", "get_pinned_file(",
            "validate_pinned_creation_pair(", "can_create_pinned(", "install_loader_inner(",
            "create_resource_instance_then_install(", "require_resource_stopped(", "resource_target(",
            "resource_transactions::require_no_pending(", "let path = download(",
        ]);
        ordered(&section(mr, "async fn create_resource_instance_then_install<"), &[
            "state.control.checkpoint().await", "create_instance_inner(", "into_instance(request, &instance)",
            "state.control.set_retry(task,", "state.control.checkpoint().await", "install(instance.clone()).await",
        ]);
    }


    #[test]
    fn a4_resource_writers_take_the_operation_lock_and_check_running_before_the_writer() {
        let modrinth = include_str!("resources.rs");
        let curseforge = include_str!("curseforge.rs");
        // Extend this table in C6 if installing an exact version adds a separate writer.
        const LOCK: &str = "let _operation = state.operation.lock().await;";
        // Installs into an existing instance run in the bodies that the one
        // request path dispatches to (run_resource_request).
        for (source, command, lock, writer) in [
            (modrinth, "async fn install_modrinth(", "with_reserved_resource_task(", "resource_transactions::install("),
            (modrinth, "pub async fn update_resource(", LOCK, "resource_transactions::update_one("),
            (modrinth, "pub async fn update_resource(", LOCK, "crate::curseforge::update_one("),
            (modrinth, "pub async fn rollback_resource_update(", LOCK, "resource_transactions::rollback("),
            (modrinth, "pub async fn toggle_resource(", LOCK, "fs::rename(&source, &target)"),
            (modrinth, "async fn delete_local_resources_inner(", LOCK, "fs::remove_file("),
            (curseforge, "pub(crate) async fn install_curseforge(", "with_reserved_resource_task(", "let key = service_key("),
        ] {
            let (_, body) = source.split_once(command).unwrap();
            let (body, _) = body.split_once("\n}").unwrap();
            let body = &crate::storage::executable_source(body);
            let lock = body.find(lock).expect(command);
            let guard = body
                .find("require_resource_stopped(")
                .and_then(|at| body[at..].find(", &version_id, instance_id.as_deref())?;").map(|end| (at, end)))
                .filter(|(_, end)| *end < 40)
                .map(|(at, _)| at)
                .expect(command);
            let write_or_network = body.find(writer).expect(command);
            assert!(lock < guard && guard < write_or_network, "{command}");
        }
        let (_, wrapper) = modrinth.split_once("pub(crate) async fn with_reserved_resource_task<").unwrap();
        let (wrapper, _) = wrapper.split_once("\n}").unwrap();
        let wrapper = &crate::storage::executable_source(wrapper);
        let turn = wrapper.find("let _operation = state.control.wait_for_turn(&state.operation, id).await?;").unwrap();
        // The named binding keeps the turn held until the task finishes.
        assert!(turn < wrapper.find("task.await").unwrap());
    }

    fn u2_delete_fixture(kind: ResourceKind) -> (crate::storage::SameRootFixture, PathBuf) {
        let fixture = crate::storage::SameRootFixture::new();
        let directory = resource_directory(
            &fixture.state.snapshot().unwrap(),
            &fixture.instance.version_id,
            Some(&fixture.instance.id),
            kind,
        )
        .unwrap();
        fs::create_dir_all(&directory).unwrap();
        (fixture, directory)
    }

    fn u2_delete_names(
        fixture: &crate::storage::SameRootFixture,
        kind: ResourceKind,
        file_names: Vec<String>,
    ) -> AppResult<DeleteResourcesResult> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(delete_local_resources_inner(
                &fixture.state,
                fixture.instance.version_id.clone(),
                Some(fixture.instance.id.clone()),
                kind,
                file_names,
            ))
    }

    fn u2_delete(
        fixture: &crate::storage::SameRootFixture,
        kind: ResourceKind,
        names: &[&str],
    ) -> AppResult<DeleteResourcesResult> {
        u2_delete_names(fixture, kind, names.iter().map(|name| (*name).to_owned()).collect())
    }

    #[cfg(windows)]
    fn u2_delete_directory_link(link: &Path, target: &Path) {
        // mklink is a command-line tool, so give it ordinary paths rather than
        // the verbatim form canonicalization produces.
        let link = crate::storage::to_process_path(link).unwrap();
        let target = crate::storage::to_process_path(target).unwrap();
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', r"\"))
            .arg(target.to_string_lossy().replace('/', r"\"))
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
    }

    #[cfg(unix)]
    fn u2_delete_directory_link(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[cfg(windows)]
    fn u2_remove_directory_link(link: &Path) {
        fs::remove_dir(link).unwrap();
    }

    #[cfg(unix)]
    fn u2_remove_directory_link(link: &Path) {
        fs::remove_file(link).unwrap();
    }

    fn u2_pending_resource_transaction(directory: &Path) {
        let id = uuid::Uuid::new_v4().to_string();
        let folder = directory
            .parent()
            .unwrap()
            .join(".launcher-resource-history")
            .join(directory.file_name().unwrap())
            .join(&id);
        fs::create_dir_all(&folder).unwrap();
        let journal = serde_json::json!({
            "id": id,
            "name": "Fixture transaction",
            "createdAt": "2026-01-01T00:00:00Z",
            "status": "staged",
            "directory": directory.to_string_lossy(),
            "projects": [],
            "beforeExists": false,
            "before": [],
            "after": [],
        });
        fs::write(folder.join("journal.json"), journal.to_string()).unwrap();
    }

    #[test]
    fn u2_delete_removes_enabled_and_disabled_files_for_every_resource_kind() {
        let expected = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
        for (kind, names) in [
            (ResourceKind::Mod, ["alpha.jar", "beta.jar.disabled", "keep.jar"]),
            (ResourceKind::ResourcePack, ["alpha.zip", "beta.zip.disabled", "keep.zip"]),
            (ResourceKind::Shader, ["alpha.zip", "beta.zip.disabled", "keep.zip"]),
        ] {
            let (fixture, directory) = u2_delete_fixture(kind);
            for name in names {
                fs::write(directory.join(name), b"fixture").unwrap();
            }
            let result = u2_delete(&fixture, kind, &names[..2]).unwrap();
            assert_eq!(result.deleted, expected(&names[..2]));
            for name in &names[..2] {
                assert!(!directory.join(name).exists(), "{name} was deleted");
            }
            assert!(directory.join(names[2]).exists(), "an unselected file is kept");
        }
    }

    #[test]
    fn u2_delete_refuses_a_running_instance_or_same_root_game_without_deleting_any_file() {
        let (fixture, directory) = u2_delete_fixture(ResourceKind::Mod);
        fs::write(directory.join("alpha.jar"), b"fixture").unwrap();
        fixture.mark_running();
        let error = u2_delete(&fixture, ResourceKind::Mod, &["alpha.jar"]).unwrap_err();
        assert_eq!(error.code, "instance.running");
        assert!(directory.join("alpha.jar").exists());
    }

    #[test]
    fn u2_delete_refuses_a_pending_resource_transaction_without_deleting_any_file() {
        let (fixture, directory) = u2_delete_fixture(ResourceKind::Mod);
        fs::write(directory.join("alpha.jar"), b"fixture").unwrap();
        u2_pending_resource_transaction(&directory);
        let error = u2_delete(&fixture, ResourceKind::Mod, &["alpha.jar"]).unwrap_err();
        assert_eq!(error.code, "resource.recoveryRequired");
        assert!(directory.join("alpha.jar").exists());
    }

    #[test]
    fn u2_delete_refuses_linked_directory_or_file_without_deleting_any_file() {
        // The resource directory itself may not be a link.
        let (fixture, directory) = u2_delete_fixture(ResourceKind::Mod);
        let real = fixture.root().join("real-mods");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("keep.jar"), b"fixture").unwrap();
        fs::remove_dir(&directory).unwrap();
        u2_delete_directory_link(&directory, &real);
        assert!(u2_delete(&fixture, ResourceKind::Mod, &["keep.jar"]).is_err());
        assert!(real.join("keep.jar").exists());
        u2_remove_directory_link(&directory);

        // A linked member fails preflight before the valid files in the same
        // batch are removed.
        let (fixture, directory) = u2_delete_fixture(ResourceKind::Mod);
        fs::write(directory.join("alpha.jar"), b"fixture").unwrap();
        let outside = fixture.root().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("outside.jar"), b"fixture").unwrap();
        let linked_file = directory.join("linked.jar");
        u2_delete_directory_link(&linked_file, &outside);
        assert!(u2_delete(&fixture, ResourceKind::Mod, &["alpha.jar", "linked.jar"]).is_err());
        assert!(directory.join("alpha.jar").exists());
        assert!(outside.join("outside.jar").exists());
        u2_remove_directory_link(&linked_file);
    }

    #[test]
    fn u2_delete_refuses_traversal_non_resource_or_missing_files_without_partial_deletion() {
        let (fixture, directory) = u2_delete_fixture(ResourceKind::Mod);
        fs::write(directory.join("alpha.jar"), b"fixture").unwrap();
        fs::write(directory.join("notes.txt"), b"fixture").unwrap();
        fs::create_dir(directory.join("folder.jar")).unwrap();
        for names in [
            vec!["alpha.jar", "../outside.jar"],
            vec!["alpha.jar", "notes.txt"],
            vec!["alpha.jar", "missing.jar"],
            vec!["alpha.jar", "folder.jar"],
        ] {
            assert!(u2_delete(&fixture, ResourceKind::Mod, &names).is_err());
            assert!(directory.join("alpha.jar").exists(), "{names:?}");
            assert!(directory.join("notes.txt").exists(), "{names:?}");
            assert!(directory.join("folder.jar").is_dir(), "{names:?}");
        }
    }

    #[test]
    fn u2_delete_deduplicates_case_insensitively_and_rejects_empty_or_oversized_batches() {
        let (fixture, directory) = u2_delete_fixture(ResourceKind::Mod);
        fs::write(directory.join("Alpha.jar"), b"fixture").unwrap();
        fs::write(directory.join("Beta.jar"), b"fixture").unwrap();
        let result = u2_delete(
            &fixture,
            ResourceKind::Mod,
            &["Alpha.jar", "Beta.jar", "Alpha.jar", "alpha.JAR"],
        )
        .unwrap();
        assert_eq!(result.deleted, vec!["Alpha.jar".to_owned(), "Beta.jar".to_owned()]);
        assert!(!directory.join("Alpha.jar").exists());
        assert!(!directory.join("Beta.jar").exists());

        let empty = u2_delete(&fixture, ResourceKind::Mod, &[]).unwrap_err();
        assert!(empty.detail.unwrap_or_default().contains("选择"));
        let too_many: Vec<String> = (0..501).map(|index| format!("{index}.jar")).collect();
        let oversized = u2_delete_names(&fixture, ResourceKind::Mod, too_many).unwrap_err();
        assert!(oversized.detail.unwrap_or_default().contains("500"));
    }

    #[test]
    fn u1264_curseforge_create_reservation_requires_the_exact_pinned_file() {
        let request = |file: Option<u64>| {
            let mut payload = serde_json::json!({
                "source": "curseforge", "projectId": "90210", "resourceType": "mod",
                "target": { "mode": "create", "gameVersion": "1.20.1", "loader": "quilt", "name": "Fixture" },
            });
            if let Some(file) = file { payload["target"]["fileId"] = file.into(); }
            serde_json::from_value::<ResourceRequest>(payload).expect("Create must retain the exact CurseForge file")
        };
        let old = request(Some(8675309));
        validate_resource_request(&old).unwrap();
        assert!(validate_resource_request(&request(None)).is_err());
        assert!(validate_resource_request(&request(Some(0))).is_err());
        assert!(validate_resource_request(&request(Some(u64::from(u32::MAX) + 1))).is_err());
        let control = crate::downloads::DownloadControl::default();
        let id = control.reserve_resource(old.clone()).unwrap();
        assert!(control.claim_resource(&id, request(None)).is_err());
        assert!(control.claim_resource(&id, request(Some(8675310))).is_err());
        control.claim_resource(&id, old.clone()).unwrap();
        assert!(control.claim_resource(&id, old).is_err());
    }

    #[test]
    fn u1264_create_reservation_requires_the_exact_pinned_file() {
        let request = |pin: Option<&str>| {
            let mut payload = serde_json::json!({
                "source": "modrinth", "projectId": "fixture-project", "resourceType": "mod",
                "target": { "mode": "create", "gameVersion": "1.20.1", "loader": "quilt", "name": "Fixture" },
            });
            if let Some(pin) = pin {
                payload["target"]["resourceVersionId"] = serde_json::json!(pin);
            }
            serde_json::from_value::<ResourceRequest>(payload)
                .expect("Create must deserialize the selected historical version into the task identity")
        };
        let control = crate::downloads::DownloadControl::default();
        let old = request(Some("older-release"));
        validate_resource_request(&old).unwrap();
        let id = control.reserve_resource(old.clone()).unwrap();
        assert!(control.claim_resource(&id, request(None)).is_err());
        assert!(control.claim_resource(&id, request(Some("newer-release"))).is_err());
        control.claim_resource(&id, old.clone()).unwrap();
        assert!(control.claim_resource(&id, old).is_err());
    }

    #[test]
    fn u1264_reserved_modrinth_version_is_part_of_the_single_use_claim() {
        let request = |pin: Option<&str>| {
            let mut value = serde_json::json!({
                "source":"modrinth", "projectId":"fixture-project", "resourceType":"mod",
                "target":{"mode":"existing", "versionId":"1.21.1", "instanceId":"fixture-instance"}
            });
            if let Some(pin) = pin {
                value["target"]["resourceVersionId"] = serde_json::json!(pin);
            }
            serde_json::from_value::<ResourceRequest>(value)
                .expect("resource version is explicit in the reservation contract")
        };

        let control = crate::downloads::DownloadControl::default();
        let pinned = request(Some("older-release"));
        let reservation = control.reserve_resource(pinned.clone()).unwrap();
        assert!(control.claim_resource(&reservation, request(None)).is_err());
        assert!(control.claim_resource(&reservation, request(Some("newer-release"))).is_err());
        control.claim_resource(&reservation, pinned.clone()).unwrap();
        assert!(control.claim_resource(&reservation, pinned).is_err());
    }


    #[test]
    fn u1264_reservation_validates_the_pinned_identity_by_source() {
        let request = |source, file_id, pin| {
            serde_json::from_value::<ResourceRequest>(serde_json::json!({
                "source": source, "projectId": if source == "modrinth" {"example"} else {"123"},
                "resourceType":"mod",
                "target":{"mode":"existing", "versionId":"1.21.1",
                    "fileId":file_id, "resourceVersionId":pin}
            }))
            .unwrap()
        };
        for args in [
            ("modrinth", Some(2_u64), None),
            ("curseforge", None, Some("historic")),
            ("modrinth", Some(2), Some("historic")),
            ("modrinth", None, Some("malformed/id")),
            ("curseforge", Some(u64::from(u32::MAX) + 1), None),
        ] {
            assert!(validate_resource_request(&request(args.0, args.1, args.2)).is_err());
        }
        for args in [
            ("modrinth", None, Some("historic")),
            ("curseforge", Some(2), None),
            ("modrinth", None, None),
            ("curseforge", None, None),
        ] {
            validate_resource_request(&request(args.0, args.1, args.2)).unwrap();
        }
    }

    fn pinned_fixture(id: &str, project: &str, game: &str, loader: &str, file: &str) -> Version {
        serde_json::from_value(serde_json::json!({
            "id": id, "project_id": project, "game_versions": [game], "loaders": [loader],
            "version_type": "release",
            "files": [{"filename": file, "url": "https://cdn.modrinth.com/fixture",
                "primary": true, "size": 1, "hashes": {"sha512": "0".repeat(128)}}]
        })).unwrap()
    }

    #[test]
    fn u1264_pinned_validator_rejects_project_response_identity_loader_game_and_file_mismatches() {
        let check = |version| validate_pinned_version(
            version, "older", "project", ResourceKind::Mod, "1.21.1", Some("fabric"),
        );
        let wrong_project = check(pinned_fixture("older", "different", "1.21.1", "fabric", "a.jar"))
            .err().unwrap();
        assert_eq!(wrong_project.detail.as_deref(), Some("Modrinth 版本与项目标识不一致"));
        let wrong_response = check(pinned_fixture("different", "project", "1.21.1", "fabric", "a.jar"))
            .err().unwrap();
        assert_eq!(wrong_response.detail.as_deref(), Some("Modrinth 版本与项目标识不一致"));
        for (game, loader) in [("1.20.1", "fabric"), ("1.21.1", "forge")] {
            let error = check(pinned_fixture("older", "project", game, loader, "a.jar"))
                .err().unwrap();
            assert_eq!(error.code, "resource.noCompatibleVersion");
        }
        assert!(check(pinned_fixture("older", "project", "1.21.1", "fabric", "a.zip")).is_err());
        assert_eq!(check(pinned_fixture("older", "project", "1.21.1", "fabric", "a.jar")).unwrap().id, "older");
    }

    #[test]
    fn u1264_pinned_plan_exposes_only_targets_compatible_with_the_requested_version() {
        let (root, state) = resource_fixture();
        let project = serde_json::from_value(serde_json::json!({
            "id":"fixture-project", "title":"Fixture resource", "project_type":"mod"
        })).unwrap();
        let versions = [
            pinned_fixture("older", "fixture-project", "1.20.1", "fabric", "old.jar"),
            pinned_fixture("newer", "fixture-project", "1.21.1", "fabric", "new.jar"),
        ];
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let target = |pin: Option<&str>| {
            let selected = if pin == Some("older") { &versions[..1] } else { versions.as_slice() };
            rt.block_on(resolve_plan(
                &state, &project, selected, ResourceKind::Mod, pin.is_some(),
                std::future::ready(Ok(serde_json::json!({"versions": [
                    {"id": "1.21.1", "type":"release"}, {"id":"1.20.1", "type":"release"}
                ]}))),
            )).unwrap()
        };
        let all = target(None);
        assert!(all.targets.iter().any(|row| row.compatible && row.resource_version_id.as_deref() == Some("newer")));
        let old = target(Some("older"));
        assert!(!old.targets.iter().any(|row| row.compatible));
        assert_eq!(old.suggestion.unwrap().game_version, "1.20.1");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn u1264_pinned_install_uses_the_same_reserved_h06_and_journal_boundaries() {
        let (_, body) = include_str!("resources.rs").split_once("async fn install_modrinth(").unwrap();
        let (body, _) = body.split_once("\n}").unwrap();
        let reserve = body.find("with_reserved_resource_task(").unwrap();
        let h06 = body.find("require_resource_stopped(").unwrap();
        let validate = body.find("select_modrinth_install_version(").unwrap();
        let write = body.find("resource_transactions::install(").unwrap();
        assert!(reserve < h06 && h06 < validate && validate < write);
    }

    #[test]
    fn discover_cancel_queued_own_task_without_touching_another_same_project() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (root, state) = resource_fixture();
            let guard = state.operation.lock().await;
            let request = |instance_id: &str| ResourceRequest {
                source: ResourceSource::Modrinth,
                project_id: "same-project".into(),
                resource_type: "mod".into(),
                target: ReservedTarget::Existing {
                    version_id: "fabric-test".into(),
                    instance_id: Some(instance_id.into()),
                    file_id: None, resource_version_id: None,
                },
            };
            let existing = state.control.reserve_resource(request("running-instance")).unwrap();
            assert!(state.control.activate(&existing));
            let own = state.control.reserve_resource(request("waiting-instance")).unwrap();
            assert!(state.control.claim_resource(&own, request("running-instance")).is_err());
            {
                let started = with_reserved_resource_task(&state, &own, request("waiting-instance"), async {
                    panic!("the cancelled request must not start");
                    #[allow(unreachable_code)]
                    Ok::<(), AppError>(())
                });
                tokio::pin!(started);
                assert!(futures_util::poll!(&mut started).is_pending(), "install must wait on the operation lock");
                assert!(state.control.claim_resource(&own, request("waiting-instance")).is_err(), "a claim is single-use");
                state.control.cancel(&own);
                let error = tokio::time::timeout(Duration::from_secs(1), started).await.unwrap().unwrap_err();
                assert_eq!(error.code, "download.cancelled");
            }
            assert_eq!(state.control.list().iter().find(|row| row.id == existing).unwrap().status, "running");
            assert_eq!(state.control.list().iter().find(|row| row.id == own).unwrap().status, "cancelled");
            state.control.finish(&existing, None);
            drop(guard);
            drop(state);
            cleanup_fixture(root);
        });
    }

    fn resource_fixture() -> (PathBuf, Arc<LauncherState>) {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/resource-tests")
            .join(uuid::Uuid::new_v4().to_string());
        for (id, metadata) in [
            (
                "fabric-test",
                serde_json::json!({"inheritsFrom":"1.21.1","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.9"}],"launcherMetadata":{"loaderVersion":"0.16.9"}}),
            ),
            ("1.21.1", serde_json::json!({"id":"1.21.1"})),
        ] {
            let directory = root.join("versions").join(id);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join(format!("{id}.json")), metadata.to_string()).unwrap();
        }
        let state = Arc::new(LauncherState::test_fixture(
            root.clone(),
            Persisted {
                config: crate::models::Config {
                    game_directory: root.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                ..Default::default()
            },
            crate::storage::test_client(),
        ));
        (root, state)
    }

    fn cleanup_fixture(root: PathBuf) {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-tests");
        assert!(
            root.is_absolute()
                && root.starts_with(parent)
                && root.file_name().unwrap().to_string_lossy().len() == 36
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_loader_registers_no_instance_and_finishes_cancelled() {
        let (root, state) = resource_fixture();
        let task = state.control.begin("resource", "project", "创建并安装").unwrap();
        state.control.cancel(&task);
        let result = tauri::async_runtime::block_on(create_resource_instance_then_install(
            &state,
            &task,
            "Example".into(),
            "fabric-test".into(),
            |_| async { panic!("cancelled install must not start") },
        ));
        let error = result.err().unwrap();
        assert_eq!(error.code, "download.cancelled");
        finish_resource_task(&state, &task, Some(&error));
        assert!(state.snapshot().unwrap().instances.is_empty());
        assert!(!root.join("instances").exists());
        let jobs = state.control.list();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, "cancelled");
        assert_eq!(jobs[0].kind, "resource");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn cancellation_after_creation_keeps_instance_and_finishes_cancelled() {
        let (root, state) = resource_fixture();
        let task = state.control.begin("resource", "project", "创建并安装").unwrap();
        let install_state = state.clone();
        let install_task = task.clone();
        let result = tauri::async_runtime::block_on(create_resource_instance_then_install(
            &state,
            &task,
            "Example".into(),
            "fabric-test".into(),
            move |_| async move {
                install_state.control.cancel(&install_task);
                install_state.control.checkpoint().await?;
                panic!("cancelled resource install must stop")
            },
        ));
        let error = result.err().unwrap();
        assert_eq!(error.code, "resource.installAfterCreate");
        assert_eq!(error.params["causeCode"], "download.cancelled");
        let instances = state.snapshot().unwrap().instances;
        assert_eq!(instances.len(), 1);
        assert_eq!(error.params["instanceId"], instances[0].id);
        assert_eq!(error.params["instanceName"], "Example");
        assert_eq!(error.params["versionId"], "fabric-test");
        assert!(Path::new(&instances[0].game_directory).is_dir());
        finish_resource_task(&state, &task, Some(&error));
        assert_eq!(state.control.list().len(), 1);
        assert_eq!(state.control.list()[0].status, "cancelled");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn resource_failure_keeps_created_instance_and_retry_identity() {
        let (root, state) = resource_fixture();
        let task = state.control.begin("resource", "project", "创建并安装").unwrap();
        let result = tauri::async_runtime::block_on(create_resource_instance_then_install(
            &state,
            &task,
            "Example".into(),
            "fabric-test".into(),
            |_| async { Err(expected("磁盘写入失败")) },
        ));
        let error = result.err().unwrap();
        assert_eq!(error.code, "resource.installAfterCreate");
        assert_eq!(error.detail.as_deref(), Some("磁盘写入失败"));
        assert_eq!(state.snapshot().unwrap().instances.len(), 1);
        assert_eq!(
            error.params["instanceId"],
            state.snapshot().unwrap().instances[0].id
        );
        finish_resource_task(&state, &task, Some(&error));
        assert_eq!(state.control.list()[0].status, "failed");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn resource_progress_records_stages_and_bytes_in_the_same_task() {
        let (root, state) = resource_fixture();
        let task = state.control.begin("resource", "project", "创建并安装").unwrap();
        let progress = ResourceProgress::new(None, "fabric-test");
        progress.stage(&state, "resource-loader", "安装加载器");
        progress.emit(
            &state,
            "resource-download",
            0,
            1,
            12,
            24,
            "下载 example.jar",
        );
        let job = &state.control.list()[0];
        assert_eq!(job.id, task);
        assert_eq!(job.kind, "resource");
        assert_eq!(job.stage, "resource-download");
        assert_eq!((job.bytes_completed, job.bytes_total), (12, 24));
        progress.emit(&state, "complete", 1, 1, 24, 24, "资源安装完成");
        finish_resource_task(&state, &task, None);
        assert_eq!(state.control.list().len(), 1);
        assert_eq!(state.control.list()[0].status, "completed");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn planner_candidates_resolve_inherited_metadata_and_version_directories() {
        let (root, state) = resource_fixture();
        let instance =
            crate::commands::create_instance_inner(&state, "Imported".into(), "fabric-test".into())
                .unwrap();
        state
            .update(|data| {
                data.instances[0].loader.clear();
                Ok(())
            })
            .unwrap();
        let context = resource_context(&state, "fabric-test", Some(&instance.id)).unwrap();
        assert_eq!(context.game_version, "1.21.1");
        assert_eq!(context.loader.as_deref(), Some("fabric"));
        let candidates = target_candidates(&state).unwrap();
        let candidate = candidates
            .iter()
            .find(|candidate| candidate.instance_id.as_deref() == Some(&instance.id))
            .unwrap();
        assert_eq!(candidate.game_version.as_deref(), Some("1.21.1"));
        assert_eq!(candidate.loader.as_deref(), Some("fabric"));
        assert!(!candidates
            .iter()
            .any(|candidate| candidate.kind == "version" && candidate.version_id == "fabric-test"));
        assert!(candidates
            .iter()
            .any(|candidate| candidate.kind == "version" && candidate.version_id == "1.21.1"));
        let error = resource_target(&state, "not-installed", None, ResourceKind::ResourcePack)
            .err()
            .unwrap();
        assert_eq!(error.code, "resource.versionMissing");
        assert_eq!(error.params["versionId"], "not-installed");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn planner_keeps_each_instance_but_omits_its_shared_version_directory() {
        let (root, state) = resource_fixture();
        for name in ["First", "Second"] {
            crate::commands::create_instance_inner(&state, name.into(), "fabric-test".into())
                .unwrap();
        }
        let candidates = target_candidates(&state).unwrap();
        assert_eq!(candidates.len(), 3);
        assert_eq!(
            candidates
                .iter()
                .filter(|row| row.kind == "instance")
                .count(),
            2
        );
        assert_eq!(
            candidates
                .iter()
                .filter(|row| row.kind == "version")
                .map(|row| row.version_id.as_str())
                .collect::<Vec<_>>(),
            ["1.21.1"]
        );
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn resolve_targets_keeps_compatible_rows_when_the_manifest_fetch_fails() {
        let (root, state) = resource_fixture();
        let instance = crate::commands::create_instance_inner(
            &state,
            "Existing Fabric".into(),
            "fabric-test".into(),
        )
        .unwrap();
        let project: Project = serde_json::from_value(serde_json::json!({
            "id": "fixture-project", "title": "Fixture", "project_type": "mod"
        }))
        .unwrap();
        let versions: Vec<Version> = serde_json::from_value(serde_json::json!([{
            "id": "fixture-version", "project_id": "fixture-project", "game_versions": ["1.21.1"],
            "loaders": ["fabric"], "version_type": "release", "files": []
        }]))
        .unwrap();
        for manifest in [
            Err("offline fixture".to_string()),
            Ok(serde_json::json!({"versions": "invalid fixture"})),
        ] {
            let plan = tauri::async_runtime::block_on(resolve_resource_targets_inner(
                &state,
                &project,
                &versions,
                ResourceKind::Mod,
                std::future::ready(manifest),
            ))
            .expect("missing official metadata must not block an already compatible target");
            assert!(plan.suggestion.is_none());
            assert!(plan.unsupported_reason.is_none());
            assert_eq!(
                plan.targets
                    .iter()
                    .filter(|row| row.compatible)
                    .map(|row| (
                        row.instance_id.as_deref(),
                        row.resource_version_id.as_deref()
                    ))
                    .collect::<Vec<_>>(),
                [(Some(instance.id.as_str()), Some("fixture-version"))]
            );
            assert_eq!(
                serde_json::to_value(plan).unwrap()["manifestUnavailable"],
                true
            );
        }
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn resolve_targets_explains_a_missing_manifest_without_compatible_rows() {
        let (root, state) = resource_fixture();
        let project: Project = serde_json::from_value(serde_json::json!({
            "id": "fixture-project", "title": "Fixture", "project_type": "mod"
        }))
        .unwrap();
        let versions: Vec<Version> = serde_json::from_value(serde_json::json!([{
            "id": "snapshot-version", "game_versions": ["26.1-snapshot-1"],
            "loaders": ["fabric"], "version_type": "release", "files": []
        }]))
        .unwrap();
        let plan = tauri::async_runtime::block_on(resolve_resource_targets_inner(
            &state,
            &project,
            &versions,
            ResourceKind::Mod,
            std::future::ready(Err("offline fixture".into())),
        ))
        .unwrap();
        assert!(plan.targets.iter().all(|row| !row.compatible));
        assert!(plan.suggestion.is_none());
        assert_eq!(
            plan.unsupported_reason.as_deref(),
            Some("manifestUnavailable")
        );
        assert_eq!(
            serde_json::to_value(plan).unwrap()["manifestUnavailable"],
            true
        );
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn explicit_recovery_refuses_a_running_version_directory_without_moving_files() {
        let (root, state) = resource_fixture();
        let data = state.snapshot().unwrap();
        let game_directory =
            crate::minecraft::game_directory(&data.config, "fabric-test", None).unwrap();
        let directory = resource_directory(&data, "fabric-test", None, ResourceKind::Mod).unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("mod.jar"), b"original").unwrap();
        let before = crate::instances::collect_files(&directory).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let transaction = game_directory
            .join(".launcher-resource-history")
            .join("mods")
            .join(&id);
        fs::create_dir_all(&transaction).unwrap();
        fs::rename(&directory, transaction.join("before")).unwrap();
        fs::create_dir_all(transaction.join("next")).unwrap();
        fs::write(transaction.join("next/mod.jar"), b"new").unwrap();
        let after = crate::instances::collect_files(&transaction.join("next")).unwrap();
        fs::write(
            transaction.join("journal.json"),
            serde_json::to_vec(&serde_json::json!({
                "id": id, "name": "Recovery fixture", "createdAt": "2026-11-16T00:00:00Z",
                "directory": directory, "projects": [], "status": "committing",
                "beforeExists": true, "before": before, "after": after,
            }))
            .unwrap(),
        )
        .unwrap();
        let games = [crate::processes::RunningGame {
            game_id: "fixture-game".into(),
            pid: 7,
            version_id: "another-view".into(),
            instance_id: None,
            game_directory: game_directory.to_string_lossy().into_owned(),
            started_at: "now".into(),
            library_root: String::new(),
        }];
        let error = recover_resource_update_inner(
            &state,
            "fabric-test",
            None,
            ResourceKind::Mod,
            &id,
            &games,
        )
        .err()
        .unwrap();
        assert_eq!(error.code, "resource.recoveryRunning");
        assert!(!directory.exists());
        assert_eq!(
            fs::read(transaction.join("before/mod.jar")).unwrap(),
            b"original"
        );
        assert_eq!(fs::read(transaction.join("next/mod.jar")).unwrap(), b"new");

        let result =
            recover_resource_update_inner(&state, "fabric-test", None, ResourceKind::Mod, &id, &[])
                .unwrap();
        assert_eq!(result.status, "recovered");
        assert_eq!(fs::read(directory.join("mod.jar")).unwrap(), b"original");
        assert_eq!(fs::read(transaction.join("next/mod.jar")).unwrap(), b"new");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn running_version_directory_protects_shared_game_files() {
        let (root, state) = resource_fixture();
        let mut data = state.snapshot().unwrap();
        data.config.version_isolation = true;
        let directory =
            crate::minecraft::game_directory(&data.config, "fabric-test", None).unwrap();
        let games = vec![crate::processes::RunningGame {
            game_id: "fixture-game".into(),
            pid: 7,
            version_id: "fabric-test".into(),
            instance_id: None,
            game_directory: directory.to_string_lossy().into_owned(),
            started_at: "now".into(),
            library_root: String::new(),
        }];
        assert!(target_running(&data, "fabric-test", None, &games));
        assert!(!target_running(&data, "1.21.1", None, &games));
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn dependency_preflight_rejects_unverifiable_required_dependency_before_creation() {
        let (root, state) = resource_fixture();
        let version: Version = serde_json::from_value(serde_json::json!({
            "id":"example-version", "project_id":"example", "game_versions":["1.21.1"], "loaders":["fabric"],
            "dependencies":[{"dependency_type":"required"}],
            "files":[{"filename":"example.jar","url":"https://cdn.modrinth.com/example.jar","primary":true,"size":3,"hashes":{"sha512":"a".repeat(128)}}]
        })).unwrap();
        let error = tauri::async_runtime::block_on(resource_transactions::preflight(
            &state,
            state.client().unwrap(),
            version,
            "1.21.1",
            Some("fabric"),
            ResourceKind::Mod,
        ))
        .unwrap_err();
        assert!(error.contains("必需前置没有可核验"));
        assert!(state.snapshot().unwrap().instances.is_empty());
        assert!(!root.join("instances").exists());
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn project_details_without_target_or_with_vanilla_keep_browsable_versions() {
        for context in [
            None,
            Some(ResourceContext {
                game_version: "1.21.1".into(),
                loader: None,
            }),
        ] {
            let project: Project = serde_json::from_value(serde_json::json!({
                "id":"example", "title":"Example", "project_type":"mod", "versions":["version-id-not-game"]
            })).unwrap();
            let versions: Vec<Version> = serde_json::from_value(serde_json::json!([{
                "id":"version-id-not-game", "project_id":"example", "game_versions":["1.21.1"], "loaders":["fabric"], "files":[]
            }])).unwrap();
            let details = modrinth_details(project, versions, context.as_ref());
            assert_eq!(details.versions.len(), 1);
            assert!(!details.versions[0].compatible);
            assert_eq!(details.project.versions, ["1.21.1"]);
        }
    }

    #[test]
    fn vanilla_mod_target_returns_structured_loader_required() {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-tests");
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        let version = root.join("versions/1.21.1");
        fs::create_dir_all(&version).unwrap();
        fs::write(version.join("1.21.1.json"), r#"{"id":"1.21.1"}"#).unwrap();
        let state = LauncherState::test_fixture(
            root.clone(),
            Persisted {
                config: crate::models::Config {
                    game_directory: root.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                ..Default::default()
            },
            crate::storage::test_client(),
        );
        let error = resource_target(&state, "1.21.1", None, ResourceKind::Mod)
            .err()
            .unwrap();
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "resource.loaderRequired");
        assert_eq!(value["params"]["versionId"], "1.21.1");
        assert!(root.starts_with(parent));
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_modrinth_downloads_retry_with_a_clean_temporary_file() {
        run_interrupted_download_case(None);
    }

    #[test]
    fn m04_cancelling_stalled_modrinth_headers_releases_the_owned_part() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/resource-tests")
                .join(uuid::Uuid::new_v4().to_string());
            let directory = root.join("mods");
            let state = LauncherState::test_fixture(
                root.join("data"),
                Persisted::default(),
                crate::storage::test_client(),
            );
            let client = reqwest::Client::builder().no_proxy()
                .resolve("cdn.modrinth.com", address)
                .timeout(Duration::from_secs(3)).build().unwrap();
            let file = ResourceFile {
                filename: "fixture.jar".into(),
                url: format!("http://cdn.modrinth.com:{}/fixture.jar", address.port()),
                primary: true,
                size: 3,
                hashes: FileHashes { sha512: format!("{:x}", Sha512::digest(b"abc")) },
            };
            let (seen, requested) = tokio::sync::oneshot::channel();
            let (release, released) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                configure_download_fixture_stream(&stream).unwrap();
                assert!(read_download_fixture_request(&mut stream).unwrap().starts_with(b"GET /fixture.jar"));
                seen.send(()).unwrap();
                released.recv_timeout(Duration::from_secs(5)).unwrap();
            });
            let task = state.control.begin("resource", "example", "Fixture").unwrap();
            let mut download = Box::pin(download_verified_progress(
                &state, &file, &directory, None, ResourceKind::Mod, client, None,
            ));
            let cancel = async {
                tokio::time::timeout(Duration::from_secs(2), requested).await.unwrap().unwrap();
                state.control.cancel(&task);
            };
            use futures_util::future::{select, Either};
            match select(download.as_mut(), Box::pin(cancel)).await {
                Either::Left((result, _)) => panic!("transfer completed before cancellation: {result:?}"),
                Either::Right(((), _)) => {}
            };
            let result = tokio::time::timeout(Duration::from_millis(500), &mut download).await;
            let timed_out = result.is_err();
            let promptly_cancelled = result.is_ok_and(|result| result.is_err_and(|error| error.contains("任务已取消")));
            let part_left = fs::read_dir(&directory).unwrap().flatten().any(|entry| {
                entry.path().extension().is_some_and(|extension| extension == "part")
            });
            release.send(()).unwrap();
            server.join().unwrap();
            if timed_out {
                let _ = download.as_mut().await;
            }
            let installed = directory.join(&file.filename).exists();
            eprintln!("M04_MODRINTH promptly_cancelled={promptly_cancelled} part_left={part_left} installed={installed}");
            drop(download);
            drop(state);
            fs::remove_dir_all(root).unwrap();
            assert!(promptly_cancelled);
            assert!(!part_left && !installed);
        });
    }

    #[test]
    fn interrupted_modrinth_downloads_have_independent_parallel_fixtures() {
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let workers: Vec<_> = (0..3)
            .map(|_| {
                let barrier = barrier.clone();
                std::thread::spawn(move || run_interrupted_download_case(Some(barrier)))
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .map(|result| result.0)
                .collect::<HashSet<_>>()
                .len(),
            3
        );
        assert_eq!(
            results
                .iter()
                .map(|result| &result.1)
                .collect::<HashSet<_>>()
                .len(),
            3
        );
    }

    fn run_interrupted_download_case(start: Option<Arc<std::sync::Barrier>>) -> (u16, PathBuf) {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-tests");
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        let directory = root.join("mods");
        let state = Arc::new(LauncherState::test_fixture(
            root.join("data"),
            Persisted::default(),
            crate::storage::test_client(),
        ));
        let client = reqwest::Client::builder()
            .no_proxy()
            .resolve("cdn.modrinth.com", address)
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let file = ResourceFile {
            filename: "retry.jar".into(),
            url: format!("http://cdn.modrinth.com:{}/retry.jar", address.port()),
            primary: true,
            size: 6,
            hashes: FileHashes {
                sha512: format!("{:x}", Sha512::digest(b"abcdef")),
            },
        };
        let task = state.control.begin("resource", "example", "下载资源").unwrap();
        let progress = ResourceProgress::new(None, "1.21.1");
        if let Some(barrier) = start {
            barrier.wait();
        }
        // Start the unchanged serving deadline after state/client construction;
        // preparing independent clients under Cargo load is not HTTP work.
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(60);
            let mut served = 0;
            while served < 3 {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        configure_download_fixture_stream(&stream).unwrap();
                        let request = match read_download_fixture_request(&mut stream) {
                            Ok(request) => request,
                            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                                continue
                            }
                            Err(error) => panic!("local request headers failed: {error}"),
                        };
                        assert!(request.starts_with(b"GET /retry.jar HTTP/1.1\r\n"));
                        let response = if served < 2 {
                            "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nab"
                        } else {
                            "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef"
                        };
                        std::io::Write::write_all(&mut stream, response.as_bytes()).unwrap();
                        served += 1;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "download retry timed out after {served} complete requests"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("local download fixture failed: {error}"),
                }
            }
            served
        });
        let downloaded = tauri::async_runtime::block_on(download_verified_progress(
            &state,
            &file,
            &directory,
            None,
            ResourceKind::Mod,
            client,
            Some(&progress),
        ))
        .unwrap();
        assert_eq!(server.join().unwrap(), 3);
        assert_eq!(fs::read(downloaded).unwrap(), b"abcdef");
        let job = &state.control.list()[0];
        assert_eq!(job.id, task);
        assert_eq!(job.stage, "resource-download");
        assert_eq!((job.bytes_completed, job.bytes_total), (6, 6));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        drop(state);
        cleanup_fixture(root.clone());
        (address.port(), root)
    }

    fn configure_download_fixture_stream(stream: &std::net::TcpStream) -> std::io::Result<()> {
        // Winsock inherits the listener's nonblocking mode. A read timeout
        // alone does not restore the blocking HTTP-header reads used here.
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))
    }

    #[test]
    fn download_fixture_accepted_stream_waits_for_delayed_headers() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut accepted, _) = listener.accept().unwrap();
        configure_download_fixture_stream(&accepted).unwrap();
        let (release, start) = std::sync::mpsc::channel();
        let writer = std::thread::spawn(move || {
            start.recv_timeout(Duration::from_secs(3)).unwrap();
            std::thread::sleep(Duration::from_millis(100));
            std::io::Write::write_all(
                &mut client,
                b"GET /retry.jar HTTP/1.1\r\nHost: cdn.modrinth.com\r\n\r\n",
            )
            .unwrap();
        });
        let begin = std::time::Instant::now();
        release.send(()).unwrap();
        let request = read_download_fixture_request(&mut accepted);
        let elapsed = begin.elapsed();
        writer.join().unwrap();
        assert_eq!(
            request.expect("an accepted stream must wait for a request within its read timeout"),
            b"GET /retry.jar HTTP/1.1\r\nHost: cdn.modrinth.com\r\n\r\n"
        );
        assert!(elapsed >= Duration::from_millis(100));
    }

    fn read_download_fixture_request(reader: &mut impl std::io::Read) -> std::io::Result<Vec<u8>> {
        let mut request = Vec::new();
        let mut bytes = [0; 2048];
        loop {
            let count = reader.read(&mut bytes)?;
            if count == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "incomplete HTTP request",
                ));
            }
            if request.len() + count > 8192 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "fixture request headers too large",
                ));
            }
            request.extend_from_slice(&bytes[..count]);
            if request.windows(4).any(|part| part == b"\r\n\r\n") {
                return Ok(request);
            }
        }
    }

    #[test]
    fn download_fixture_request_waits_for_fragmented_http_headers() {
        let mut request = std::io::Cursor::new(b"GET /retry.jar HTTP/1.1\r\n".as_slice()).chain(
            std::io::Cursor::new(b"Host: cdn.modrinth.com\r\n\r\n".as_slice()),
        );
        assert_eq!(
            read_download_fixture_request(&mut request).unwrap(),
            b"GET /retry.jar HTTP/1.1\r\nHost: cdn.modrinth.com\r\n\r\n"
        );
    }

    #[test]
    fn download_fixture_request_rejects_eof_before_the_header_terminator() {
        let mut request =
            std::io::Cursor::new(b"GET /retry.jar HTTP/1.1\r\nHost: partial".as_slice());
        assert_eq!(
            read_download_fixture_request(&mut request)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::UnexpectedEof
        );
    }

    #[test]
    fn resource_types_and_download_hosts_reject_unsafe_targets() {
        assert!(ResourceKind::parse("modpack").is_err());
        for url in [
            "http://cdn.modrinth.com/file.jar",
            "https://cdn.modrinth.com.evil.example/file.jar",
            "https://cdn.modrinth.com:444/file.jar",
            "https://user@cdn.modrinth.com/file.jar",
            "file:///C:/example.jar",
        ] {
            assert!(cdn_url(url).is_err(), "{url}");
        }
        assert!(cdn_url("https://cdn.modrinth.com/data/test/versions/test/file.jar").is_ok());
        for value in ["../escape", "project/id", "foo?query=1", "foo%2fbar"] {
            assert!(identifier(value).is_err());
        }
    }

    #[test]
    fn neoforge_metadata_and_maven_coordinates_are_not_misidentified() {
        assert_eq!(
            detect_loader(&serde_json::json!({
                "libraries": [{"name": "net.neoforged:forge:1.20.1-47.1.106:client"}],
                "launcherMetadata": {"loader": "neoforge"}
            })),
            Some("neoforge")
        );
        assert_eq!(
            detect_loader(&serde_json::json!({
                "libraries": [{"name": "net.neoforged.fancymodloader:loader:4.0.45"}]
            })),
            Some("neoforge")
        );
        assert_eq!(
            detect_loader(&serde_json::json!({
                "libraries": [{"name": "net.minecraftforge:fmlcore:1.20.1-47.4.28"}]
            })),
            Some("forge")
        );
    }

    #[test]
    fn inherited_fabric_versions_resolve_the_vanilla_target_and_reject_cycles() {
        let test_parent = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("resource-tests");
        let root = test_parent.join(format!("launcher-resource-test-{}", uuid::Uuid::new_v4()));
        for (id, json) in [
            (
                "fabric-test",
                serde_json::json!({"inheritsFrom":"1.21.1","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.0"}]}),
            ),
            (
                "1.21.1",
                serde_json::json!({"id":"1.21.1","mainClass":"net.minecraft.client.main.Main"}),
            ),
        ] {
            let dir = root.join("versions").join(id);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(format!("{id}.json")), json.to_string()).unwrap();
        }
        assert_eq!(
            version_context(&root, "fabric-test").unwrap(),
            ("1.21.1".into(), Some("fabric".into()))
        );
        fs::write(
            root.join("versions/1.21.1/1.21.1.json"),
            r#"{"inheritsFrom":"fabric-test"}"#,
        )
        .unwrap();
        assert!(version_context(&root, "fabric-test")
            .unwrap_err()
            .contains("循环"));
        // The unique absolute test directory is verified before recursive cleanup.
        assert!(
            root.is_absolute()
                && root.starts_with(&test_parent)
                && root
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("launcher-resource-test-")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn modrinth_details_preserve_real_fields_and_unknown_dependency_types() {
        let details = modrinth_details(
            Project {
                id: "sodium".into(),
                title: "Sodium".into(),
                project_type: "mod".into(),
                slug: Some("sodium".into()),
                description: Some("Rendering".into()),
                icon_url: Some("icon.png".into()),
                downloads: Some(100),
                author: Some("Author".into()),
                external_url: None,
            },
            vec![Version {
                id: "v1".into(),
                version_type: "release".into(),
                name: "1.0".into(),
                version_number: "1.0".into(),
                project_id: "sodium".into(),
                date_published: "2026-01-01".into(),
                game_versions: vec!["1.21.1".into()],
                loaders: vec!["fabric".into()],
                dependencies: vec![
                    Dependency {
                        dependency_type: "required".into(),
                        project_id: Some("dep".into()),
                        version_id: None,
                        file_name: Some("dep.jar".into()),
                    },
                    Dependency {
                        dependency_type: "other".into(),
                        project_id: Some("unknown-dep".into()),
                        version_id: None,
                        file_name: None,
                    },
                ],
                environment: String::new(),
                files: vec![],
            }],
            Some(&ResourceContext {
                game_version: "1.21.1".into(),
                loader: Some("fabric".into()),
            }),
        );
        assert_eq!(details.project.downloads, 100);
        assert_eq!(details.project.versions, ["1.21.1"]);
        assert!(details.versions.iter().all(|version| version.compatible));
        assert_eq!(details.dependencies[0].kind, "required");
        assert_eq!(details.dependencies[1].kind, "unknown");
    }

    // ---- C7: one request path, test endpoints and resource retry -------------

    use crate::parts::range_server::{RangeServer, Scripted};

    /// Points this thread's Modrinth and CurseForge clients at loopback servers,
    /// with no proxy (a system proxy on the test machine cannot reach them).
    struct Endpoints;

    impl Endpoints {
        fn set(state: &LauncherState, api: &RangeServer, cdn: &RangeServer) -> Self {
            state.update(|persisted| {
                persisted.config.proxy_mode = "none".into();
                Ok(())
            }).unwrap();
            TEST_ENDPOINTS.with(|endpoints| {
                *endpoints.borrow_mut() = Some(TestEndpoints {
                    modrinth_api: format!("http://{}", api.address),
                    curseforge_api: format!("http://{}", api.address),
                    cdn: cdn.address.parse().unwrap(),
                    prepared_version: None,
                })
            });
            Endpoints
        }

        /// Stands in for the Minecraft and loader install of a create request.
        fn preparing(self, version_id: &str) -> Self {
            TEST_ENDPOINTS.with(|endpoints| {
                if let Some(endpoints) = endpoints.borrow_mut().as_mut() {
                    endpoints.prepared_version = Some(version_id.into());
                }
            });
            self
        }
    }

    impl Drop for Endpoints {
        fn drop(&mut self) {
            TEST_ENDPOINTS.with(|endpoints| *endpoints.borrow_mut() = None);
        }
    }

    fn port(server: &RangeServer) -> &str {
        server.address.rsplit(':').next().unwrap()
    }

    fn json(value: serde_json::Value) -> Scripted {
        Scripted::ok(value.to_string().as_bytes(), "\"j\"")
    }

    fn modrinth_project() -> Scripted {
        json(serde_json::json!({"id": "fixture-project", "title": "Fixture", "project_type": "mod"}))
    }

    fn modrinth_version(id: &str, day: u32, cdn: &RangeServer, bytes: &[u8]) -> serde_json::Value {
        serde_json::json!({
            "id": id, "project_id": "fixture-project", "game_versions": ["1.21.1"], "loaders": ["fabric"],
            "version_type": "release", "date_published": format!("2026-01-{day:02}T00:00:00Z"),
            "files": [{"filename": format!("{id}.jar"), "url": format!("http://cdn.modrinth.com:{}/data/{id}.jar", port(cdn)),
                "primary": true, "size": bytes.len(), "hashes": {"sha512": format!("{:x}", sha2::Sha512::digest(bytes))}}],
            "dependencies": []
        })
    }

    fn modrinth_request(pin: Option<&str>) -> ResourceRequest {
        ResourceRequest {
            source: ResourceSource::Modrinth,
            project_id: "fixture-project".into(),
            resource_type: "mod".into(),
            target: ReservedTarget::Existing {
                version_id: "fabric-test".into(), instance_id: None, file_id: None, resource_version_id: pin.map(str::to_owned),
            },
        }
    }

    fn mods(state: &LauncherState) -> PathBuf {
        resource_target(state, "fabric-test", None, ResourceKind::Mod).unwrap().directory
    }

    fn task_row(state: &LauncherState, id: &str) -> crate::downloads::DownloadJob {
        state.control.list().into_iter().find(|job| job.id == id).unwrap()
    }

    fn journals(state: &LauncherState) -> Vec<String> {
        let history = mods(state).parent().unwrap().join(".launcher-resource-history").join("mods");
        let mut found = Vec::new();
        for entry in fs::read_dir(history).into_iter().flatten().flatten() {
            if let Ok(text) = fs::read_to_string(entry.path().join("journal.json")) {
                found.push(text);
            }
        }
        found
    }

    fn run(state: &Arc<LauncherState>, task: &str, request: ResourceRequest) -> AppResult<ResourceOutcome> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(run_resource_request(state, None, task, request))
    }

    #[test]
    fn c6_2_the_reserved_modrinth_version_is_the_file_written() {
        let (root, state) = resource_fixture();
        let (older, newer) = (b"older mod".as_slice(), b"newer mod".as_slice());
        let cdn = RangeServer::new(vec![Scripted::ok(older, "\"o\"")]);
        // The pinned version is fetched by id; the newer one is never asked for.
        let api = RangeServer::new(vec![modrinth_project(), json(modrinth_version("older", 1, &cdn, older))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let request = modrinth_request(Some("older"));
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let installed = run(&state, &task, request).unwrap().installed().unwrap();
        assert_eq!(installed.file_name, "older.jar");
        assert_eq!(fs::read(mods(&state).join("older.jar")).unwrap(), older);
        assert!(!mods(&state).join("newer.jar").exists());
        assert_eq!(api.header(0, ":path").as_deref(), Some("/project/fixture-project"));
        assert_eq!(api.header(1, ":path").as_deref(), Some("/version/older"));
        assert_eq!((cdn.count(), cdn.header(0, ":path").as_deref()), (1, Some("/data/older.jar")));
        let journals = journals(&state);
        assert_eq!(journals.len(), 1);
        assert!(journals[0].contains("older.jar") && !journals[0].contains("newer"), "{}", journals[0]);
        assert_eq!(task_row(&state, &task).status, "completed");
        let _ = newer;
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c6_2_a_version_response_for_another_id_writes_nothing() {
        let (root, state) = resource_fixture();
        let bytes = b"newer mod".as_slice();
        let cdn = RangeServer::new(vec![Scripted::ok(bytes, "\"n\"")]);
        // Asked for "older", the service answers with "newer".
        let api = RangeServer::new(vec![modrinth_project(), json(modrinth_version("newer", 2, &cdn, bytes))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let request = modrinth_request(Some("older"));
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let error = run(&state, &task, request).err().unwrap();
        assert_eq!(error.detail.as_deref(), Some("Modrinth 版本与项目标识不一致"));
        assert_eq!(cdn.count(), 0);
        assert!(!mods(&state).exists(), "no resource file");
        assert!(journals(&state).is_empty(), "no transaction");
        assert_eq!(task_row(&state, &task).status, "failed");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c6_2_the_reserved_curseforge_file_is_the_file_written() {
        let (root, state) = resource_fixture();
        // A synthetic key of the right shape, assembled here.
        let key = ["$", "2a", "$", "10", "$"].join("") + &"a".repeat(53);
        crate::secrets::save_service_secret(&state.data_dir, "curseforge-api-key", &key).unwrap();
        let bytes = b"pinned curseforge mod".as_slice();
        let cdn = RangeServer::new(vec![Scripted::ok(bytes, "\"c\"")]);
        let file = serde_json::json!({"data": {
            "id": 123, "modId": 456, "gameId": 432, "isAvailable": true, "fileName": "pinned.jar",
            "fileLength": bytes.len(), "downloadUrl": format!("http://edge.forgecdn.net:{}/files/pinned.jar", port(&cdn)),
            "hashes": [{"algo": 1, "value": format!("{:x}", sha1::Sha1::digest(bytes))}, {"algo": 2, "value": format!("{:x}", md5::compute(bytes))}],
            "gameVersions": ["1.21.1", "Fabric"], "dependencies": []
        }});
        let project = serde_json::json!({"data": {
            "id": 456, "gameId": 432, "name": "Fixture", "slug": "fixture", "summary": "Fixture",
            "classId": 6, "downloadCount": 0.0, "authors": [], "allowModDistribution": true
        }});
        let api = RangeServer::new(vec![json(project), json(file)]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let request = ResourceRequest {
            source: ResourceSource::Curseforge,
            project_id: "456".into(),
            resource_type: "mod".into(),
            target: ReservedTarget::Existing { version_id: "fabric-test".into(), instance_id: None, file_id: Some(123), resource_version_id: None },
        };
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let installed = run(&state, &task, request).unwrap().installed().unwrap();
        assert_eq!(installed.file_name, "pinned.jar");
        assert_eq!(fs::read(mods(&state).join("pinned.jar")).unwrap(), bytes);
        assert_eq!(api.header(0, ":path").as_deref(), Some("/mods/456"));
        assert_eq!(api.header(1, ":path").as_deref(), Some("/mods/456/files/123"));
        assert!(api.header(1, "x-api-key").is_some_and(|value| value == key), "the saved key is sent");
        assert_eq!((cdn.count(), cdn.header(0, ":path").as_deref()), (1, Some("/files/pinned.jar")));
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn u0256_a_resource_retry_installs_the_version_the_first_run_chose() {
        let (root, state) = resource_fixture();
        let (older, newer) = (b"older mod".as_slice(), b"newer mod".as_slice());
        // First run: "latest" resolves to "newer", then the CDN refuses the file.
        let cdn = RangeServer::new(vec![Scripted::status(404)]);
        let api = RangeServer::new(vec![
            modrinth_project(),
            json(serde_json::json!([modrinth_version("older", 1, &cdn, older), modrinth_version("newer", 2, &cdn, newer)])),
        ]);
        let endpoints = Endpoints::set(&state, &api, &cdn);
        let request = modrinth_request(None);
        let task = state.control.reserve_resource(request.clone()).unwrap();
        assert!(run(&state, &task, request).is_err());
        assert!(api.header(1, ":path").unwrap().starts_with("/project/fixture-project/version"));
        let row = task_row(&state, &task);
        assert_eq!((row.status.as_str(), row.retryable), ("failed", true));
        let pinned = modrinth_request(Some("newer"));
        assert_eq!(row.retry_request(), Some(crate::downloads::RetryRequest::Resource { request: pinned.clone() }));
        drop((endpoints, api, cdn));

        // The retry is a reserved task claimed with that exact request, and asks for "newer" by id.
        let (retried, planned) = state.control.queue_retry(&task).unwrap();
        assert_eq!(planned, crate::downloads::RetryRequest::Resource { request: pinned.clone() });
        let cdn = RangeServer::new(vec![Scripted::ok(newer, "\"n\"")]);
        let api = RangeServer::new(vec![modrinth_project(), json(modrinth_version("newer", 2, &cdn, newer))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        assert!(run(&state, &retried, modrinth_request(None)).is_err(), "the claim needs the identical request");
        let installed = run(&state, &retried, pinned).unwrap().installed().unwrap();
        assert_eq!(installed.file_name, "newer.jar");
        assert_eq!(api.header(1, ":path").as_deref(), Some("/version/newer"));
        assert_eq!(fs::read(mods(&state).join("newer.jar")).unwrap(), newer);
        let row = task_row(&state, &retried);
        assert_eq!((row.status.as_str(), row.retried_from.as_deref()), ("completed", Some(task.as_str())));
        assert!(!task_row(&state, &task).retryable, "the first row is not retried twice");
        drop(state);
        cleanup_fixture(root);
    }

    fn create_request(source: ResourceSource, kind: &str, file_id: Option<u64>, pin: Option<&str>) -> ResourceRequest {
        ResourceRequest {
            source,
            project_id: if source == ResourceSource::Curseforge { "456".into() } else { "fixture-project".into() },
            resource_type: kind.into(),
            target: ReservedTarget::Create {
                game_version: "1.21.1".into(), loader: "fabric".into(), loader_version: None,
                name: "Fixture".into(), file_id, resource_version_id: pin.map(str::to_owned),
            },
        }
    }

    fn save_curseforge_key(state: &LauncherState) -> String {
        // A synthetic key of the right shape, assembled here.
        let key = ["$", "2a", "$", "10", "$"].join("") + &"a".repeat(53);
        crate::secrets::save_service_secret(&state.data_dir, "curseforge-api-key", &key).unwrap();
        key
    }

    fn curseforge_project() -> Scripted {
        json(serde_json::json!({"data": {
            "id": 456, "gameId": 432, "name": "Fixture", "slug": "fixture", "summary": "Fixture",
            "classId": 6, "downloadCount": 0.0, "authors": [], "allowModDistribution": true
        }}))
    }

    fn curseforge_file(id: u64, name: &str, day: u32, cdn: &RangeServer, bytes: &[u8]) -> serde_json::Value {
        serde_json::json!({
            "id": id, "modId": 456, "gameId": 432, "isAvailable": true, "fileName": name,
            "fileLength": bytes.len(), "downloadUrl": format!("http://edge.forgecdn.net:{}/files/{name}", port(cdn)),
            "hashes": [{"algo": 1, "value": format!("{:x}", sha1::Sha1::digest(bytes))}, {"algo": 2, "value": format!("{:x}", md5::compute(bytes))}],
            "gameVersions": ["1.21.1", "Fabric"], "dependencies": [], "fileDate": format!("2026-01-{day:02}T00:00:00Z")
        })
    }

    fn instance_mods(state: &LauncherState, instance_id: &str) -> PathBuf {
        resource_target(state, "fabric-test", Some(instance_id), ResourceKind::Mod).unwrap().directory
    }

    #[test]
    fn c6_2_a_modrinth_create_writes_the_reserved_version_into_its_new_instance() {
        let (root, state) = resource_fixture();
        let older = b"older mod".as_slice();
        let cdn = RangeServer::new(vec![Scripted::ok(older, "\"o\"")]);
        let api = RangeServer::new(vec![modrinth_project(), json(modrinth_version("older", 1, &cdn, older))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn).preparing("fabric-test");
        let request = create_request(ResourceSource::Modrinth, "mod", None, Some("older"));
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let created = run(&state, &task, request).unwrap().created().unwrap();
        assert_eq!(fs::read(instance_mods(&state, &created.instance.id).join("older.jar")).unwrap(), older);
        assert_eq!(api.header(0, ":path").as_deref(), Some("/project/fixture-project"));
        assert_eq!(api.header(1, ":path").as_deref(), Some("/version/older"));
        assert_eq!((cdn.count(), cdn.header(0, ":path").as_deref()), (1, Some("/data/older.jar")));
        assert_eq!(state.snapshot().unwrap().instances.len(), 1);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c6_2_a_curseforge_create_writes_the_reserved_file_and_refuses_another() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let bytes = b"pinned curseforge mod".as_slice();
        let cdn = RangeServer::new(vec![Scripted::ok(bytes, "\"c\"")]);
        let api = RangeServer::new(vec![curseforge_project(), json(serde_json::json!({"data": curseforge_file(123, "pinned.jar", 1, &cdn, bytes)}))]);
        let endpoints = Endpoints::set(&state, &api, &cdn).preparing("fabric-test");
        let request = create_request(ResourceSource::Curseforge, "mod", Some(123), None);
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let created = run(&state, &task, request.clone()).unwrap().created().unwrap();
        assert_eq!(fs::read(instance_mods(&state, &created.instance.id).join("pinned.jar")).unwrap(), bytes);
        assert_eq!(api.header(0, ":path").as_deref(), Some("/mods/456"));
        assert_eq!(api.header(1, ":path").as_deref(), Some("/mods/456/files/123"));
        assert_eq!(cdn.count(), 1);
        drop((endpoints, api, cdn));

        // Asked for file 123, the service answers with file 124: no instance, no download.
        let cdn = RangeServer::new(vec![Scripted::ok(bytes, "\"c\"")]);
        let api = RangeServer::new(vec![curseforge_project(), json(serde_json::json!({"data": curseforge_file(124, "other.jar", 1, &cdn, bytes)}))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn).preparing("fabric-test");
        let task = state.control.reserve_resource(request.clone()).unwrap();
        assert!(run(&state, &task, request).is_err());
        assert_eq!((cdn.count(), state.snapshot().unwrap().instances.len()), (0, 1));
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c6_2_a_curseforge_file_response_for_another_id_writes_nothing() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let bytes = b"other curseforge mod".as_slice();
        let cdn = RangeServer::new(vec![Scripted::ok(bytes, "\"o\"")]);
        // Asked for file 123, the service answers with file 124.
        let api = RangeServer::new(vec![curseforge_project(), json(serde_json::json!({"data": curseforge_file(124, "other.jar", 1, &cdn, bytes)}))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let request = ResourceRequest {
            target: ReservedTarget::Existing { version_id: "fabric-test".into(), instance_id: None, file_id: Some(123), resource_version_id: None },
            ..create_request(ResourceSource::Curseforge, "mod", None, None)
        };
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let error = run(&state, &task, request).err().unwrap();
        assert_eq!(error.detail.as_deref(), Some("CurseForge 文件不属于所选项目"));
        assert_eq!(cdn.count(), 0);
        assert!(!mods(&state).exists());
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn u0256_a_curseforge_retry_installs_the_file_the_first_run_chose() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let (newer, older) = (b"newer curseforge mod".as_slice(), b"older curseforge mod".as_slice());
        let cdn = RangeServer::new(vec![Scripted::status(404)]);
        let api = RangeServer::new(vec![
            curseforge_project(),
            json(serde_json::json!({"data": [curseforge_file(5000, "older.jar", 1, &cdn, older), curseforge_file(5001, "newer.jar", 2, &cdn, newer)]})),
        ]);
        let endpoints = Endpoints::set(&state, &api, &cdn);
        let latest = ResourceRequest {
            target: ReservedTarget::Existing { version_id: "fabric-test".into(), instance_id: None, file_id: None, resource_version_id: None },
            ..create_request(ResourceSource::Curseforge, "mod", None, None)
        };
        let task = state.control.reserve_resource(latest.clone()).unwrap();
        assert!(run(&state, &task, latest.clone()).is_err());
        assert!(api.header(1, ":path").unwrap().starts_with("/mods/456/files?"));
        let pinned = ResourceRequest {
            target: ReservedTarget::Existing { version_id: "fabric-test".into(), instance_id: None, file_id: Some(5001), resource_version_id: None },
            ..latest
        };
        let row = task_row(&state, &task);
        assert_eq!((row.retryable, row.retry_request()), (true, Some(crate::downloads::RetryRequest::Resource { request: pinned.clone() })));
        drop((endpoints, api, cdn));

        let (retried, _) = state.control.queue_retry(&task).unwrap();
        let cdn = RangeServer::new(vec![Scripted::ok(newer, "\"n\"")]);
        let api = RangeServer::new(vec![curseforge_project(), json(serde_json::json!({"data": curseforge_file(5001, "newer.jar", 2, &cdn, newer)}))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        run(&state, &retried, pinned).unwrap();
        assert_eq!(api.header(1, ":path").as_deref(), Some("/mods/456/files/5001"));
        assert_eq!(fs::read(mods(&state).join("newer.jar")).unwrap(), newer);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn u0256_a_create_whose_instance_exists_is_retried_into_it_even_after_a_crash() {
        let (root, state) = resource_fixture();
        let (older, newer) = (b"older mod".as_slice(), b"newer mod".as_slice());
        // "latest" resolves to "newer"; the instance is made; then the download fails.
        let cdn = RangeServer::new(vec![Scripted::status(404)]);
        let api = RangeServer::new(vec![
            modrinth_project(),
            json(serde_json::json!([modrinth_version("older", 1, &cdn, older), modrinth_version("newer", 2, &cdn, newer)])),
        ]);
        let endpoints = Endpoints::set(&state, &api, &cdn).preparing("fabric-test");
        let create = create_request(ResourceSource::Modrinth, "mod", None, None);
        let task = state.control.reserve_resource(create.clone()).unwrap();
        let error = run(&state, &task, create.clone()).err().unwrap();
        assert_eq!(error.code, "resource.installAfterCreate");
        let instances = state.snapshot().unwrap().instances;
        assert_eq!(instances.len(), 1);
        let existing = ResourceRequest {
            target: ReservedTarget::Existing {
                version_id: "fabric-test".into(), instance_id: Some(instances[0].id.clone()), file_id: None, resource_version_id: Some("newer".into()),
            },
            ..create
        };
        // Recorded when the instance was made, before the install, and saved at
        // once (u0256_a_replaced_payload_is_saved_at_once), so a crash keeps it too.
        let row = task_row(&state, &task);
        assert_eq!(row.retry_request(), Some(crate::downloads::RetryRequest::Resource { request: existing.clone() }));
        assert!(row.retryable);
        drop((endpoints, api, cdn));

        let (retried, planned) = state.control.queue_retry(&task).unwrap();
        assert_eq!(planned, crate::downloads::RetryRequest::Resource { request: existing.clone() });
        let cdn = RangeServer::new(vec![Scripted::ok(newer, "\"n\"")]);
        let api = RangeServer::new(vec![modrinth_project(), json(modrinth_version("newer", 2, &cdn, newer))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        run(&state, &retried, existing).unwrap().installed().unwrap();
        assert_eq!(fs::read(instance_mods(&state, &instances[0].id).join("newer.jar")).unwrap(), newer);
        assert_eq!(state.snapshot().unwrap().instances.len(), 1, "no second instance");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn u0256_a_create_that_fails_before_its_instance_stays_a_pinned_create() {
        let (root, state) = resource_fixture();
        let (older, newer) = (b"older mod".as_slice(), b"newer mod".as_slice());
        let cdn = RangeServer::new(vec![]);
        let api = RangeServer::new(vec![
            modrinth_project(),
            json(serde_json::json!([modrinth_version("older", 1, &cdn, older), modrinth_version("newer", 2, &cdn, newer)])),
        ]);
        // No stand-in for the loader step and no window: it fails before the instance.
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let create = create_request(ResourceSource::Modrinth, "mod", None, None);
        let task = state.control.reserve_resource(create.clone()).unwrap();
        assert!(run(&state, &task, create.clone()).is_err());
        assert!(state.snapshot().unwrap().instances.is_empty());
        let row = task_row(&state, &task);
        let pinned = create_request(ResourceSource::Modrinth, "mod", None, Some("newer"));
        assert_eq!((row.retryable, row.retry_request()), (true, Some(crate::downloads::RetryRequest::Resource { request: pinned })));
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn u0256_a_pinned_shader_create_accepts_the_version_a_latest_run_chose() {
        let (root, state) = resource_fixture();
        let bytes = b"shader pack".as_slice();
        let cdn = RangeServer::new(vec![Scripted::ok(bytes, "\"s\"")]);
        // The newest 1.21.1 version declares only OptiFine; a "latest" Fabric create accepts it.
        let mut version = modrinth_version("optifine-only", 1, &cdn, bytes);
        version["loaders"] = serde_json::json!(["optifine"]);
        version["files"][0]["filename"] = "optifine-only.zip".into();
        version["files"][0]["url"] = format!("http://cdn.modrinth.com:{}/data/optifine-only.zip", port(&cdn)).into();
        let project = json(serde_json::json!({"id": "fixture-project", "title": "Fixture", "project_type": "shader"}));
        let api = RangeServer::new(vec![project, json(version)]);
        let _endpoints = Endpoints::set(&state, &api, &cdn).preparing("fabric-test");
        let request = create_request(ResourceSource::Modrinth, "shader", None, Some("optifine-only"));
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let created = run(&state, &task, request).unwrap().created().unwrap();
        let shaders = resource_target(&state, "fabric-test", Some(&created.instance.id), ResourceKind::Shader).unwrap().directory;
        assert_eq!(fs::read(shaders.join("optifine-only.zip")).unwrap(), bytes);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c7_every_resource_install_takes_the_one_request_path() {
        let resources = crate::storage::executable_source(include_str!("resources.rs"));
        let curseforge = crate::storage::executable_source(include_str!("curseforge.rs"));
        let downloads = crate::storage::executable_source(include_str!("downloads.rs"));
        let body = |source: &str, marker: &str| -> String {
            source.split_once(marker).unwrap_or_else(|| panic!("{marker}")).1.split_once("\n}").unwrap().0.to_owned()
        };
        for (source, command) in [
            (&resources, "pub async fn install_resource("),
            (&resources, "pub async fn create_instance_for_resource("),
            (&curseforge, "pub async fn install_curseforge_resource("),
        ] {
            let body = body(source, command);
            assert!(body.contains("run_resource_request("), "{command}");
            assert!(!body.contains("with_reserved_resource_task("), "{command} installs only through the request path");
        }
        let run = body(&resources, "pub(crate) async fn run_resource_request(");
        let flat: String = run.split_whitespace().collect::<Vec<_>>().join(" ");
        for arm in [
            "(ResourceSource::Modrinth, true) => ResourceOutcome::Installed(install_modrinth(",
            "(ResourceSource::Curseforge, true) => { ResourceOutcome::Installed(crate::curseforge::install_curseforge(",
            "(ResourceSource::Modrinth, false) => ResourceOutcome::Created(create_with_modrinth(",
            "(ResourceSource::Curseforge, false) => { ResourceOutcome::Created(crate::curseforge::create_with_pinned_file(",
        ] {
            assert!(flat.contains(arm), "{arm}");
        }
        let validated = run.find("validate_resource_request(&request)?;").unwrap();
        for arm in ["install_modrinth(", "crate::curseforge::install_curseforge(", "create_with_modrinth(", "crate::curseforge::create_with_pinned_file("] {
            assert!(validated < run.find(arm).unwrap_or_else(|| panic!("{arm}")), "{arm}");
        }
        for (source, marker) in [
            (&resources, "async fn install_modrinth("),
            (&resources, "async fn create_with_modrinth("),
            (&curseforge, "pub(crate) async fn install_curseforge("),
            (&curseforge, "pub(crate) async fn create_with_pinned_file("),
        ] {
            assert!(body(source, marker).contains("with_reserved_resource_task("), "{marker}");
        }
        assert!(body(&downloads, "fn spawn_retry(").contains("crate::resources::run_queued_resource(app, state, id, request)"));
        let queued = body(&resources, "pub(crate) async fn run_queued_resource(");
        assert!(queued.find("run_resource_request(&state, Some(&app), &task, request)").unwrap() < queued.find("state.control.finish(&task").unwrap());
    }

    // ---- C8: CurseForge replacement, updates, retries and caching ------------

    fn c8_jar_bytes(mod_id: &str) -> Vec<u8> {
        c8_jar(mod_id, "1")
    }

    /// A jar declaring `mod_id`; each `version` gives different bytes.
    fn c8_jar(mod_id: &str, version: &str) -> Vec<u8> {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file(
            "fabric.mod.json",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(format!(r#"{{"id":"{mod_id}","version":"{version}"}}"#).as_bytes())
            .unwrap();
        zip.finish().unwrap().into_inner()
    }

    fn c8_snapshot(directory: &Path) -> Vec<(String, Vec<u8>)> {
        let mut files: Vec<_> = fs::read_dir(directory)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.path().is_file())
            .map(|entry| {
                (
                    entry.file_name().to_string_lossy().into_owned(),
                    fs::read(entry.path()).unwrap(),
                )
            })
            .collect();
        files.sort_by(|left, right| left.0.cmp(&right.0));
        files
    }

    fn c8_fingerprint_of(file: serde_json::Value, bytes: &[u8]) -> serde_json::Value {
        let mut file = file;
        file["fileFingerprint"] =
            crate::curseforge::fingerprint::fingerprint_bytes(bytes).into();
        file
    }

    fn c8_fingerprint_answer(file: serde_json::Value) -> Scripted {
        json(serde_json::json!({
            "data": {"exactMatches": [{"id": 456, "file": file}]}
        }))
    }

    /// A project answer (`{"data": {...}}`) as the batch lookup (POST mods) lists it.
    fn c8_listed(project: serde_json::Value) -> Scripted {
        json(serde_json::json!({"data": [project["data"].clone()]}))
    }

    /// The fixture project as the batch lookup lists it.
    fn c8_project_list() -> Scripted {
        c8_listed(serde_json::json!({"data": {
            "id": 456, "gameId": 432, "name": "Fixture", "slug": "fixture", "summary": "Fixture",
            "classId": 6, "downloadCount": 0.0, "authors": [], "allowModDistribution": true
        }}))
    }

    fn c8_runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn c8_expect_error<T, E>(result: Result<T, E>, context: &str) -> E {
        match result {
            Ok(_) => panic!("{context} unexpectedly succeeded"),
            Err(error) => error,
        }
    }

    #[test]
    fn c8_installing_another_version_replaces_the_enabled_copy_in_one_journaled_commit() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        // Every copy has its own bytes, so a skipped download, a renamed old copy
        // or a rewritten disabled copy shows up below.
        let enabled_bytes = c8_jar("example", "2");
        let third_bytes = c8_jar("example", "3");
        let disabled_bytes = c8_jar("example", "0");
        let unknown_bytes = b"not a jar".to_vec();
        let other_bytes = c8_jar_bytes("other");
        fs::write(directory.join("example-2.jar"), &enabled_bytes).unwrap();
        fs::write(directory.join("example-3.jar"), &third_bytes).unwrap();
        fs::write(directory.join("example-0.jar.disabled"), &disabled_bytes).unwrap();
        fs::write(directory.join("unknown.jar"), &unknown_bytes).unwrap();
        fs::write(directory.join("other.jar"), &other_bytes).unwrap();

        let new_bytes = c8_jar("example", "1");
        let cdn = RangeServer::new(vec![Scripted::ok(&new_bytes, "\"e\"")]);
        let file_id = 1001_u64;
        let file = curseforge_file(file_id, "example-1.jar", 2, &cdn, &new_bytes);
        let api = RangeServer::new(vec![
            curseforge_project(),
            json(serde_json::json!({"data": file})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let request = ResourceRequest {
            source: ResourceSource::Curseforge,
            project_id: "456".into(),
            resource_type: "mod".into(),
            target: ReservedTarget::Existing {
                version_id: "fabric-test".into(),
                instance_id: None,
                file_id: Some(file_id),
                resource_version_id: None,
            },
        };
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let installed = run(&state, &task, request).unwrap().installed().unwrap();
        let update_id = installed
            .update_id
            .clone()
            .expect("the replacement is journaled");
        assert_eq!(installed.file_name, "example-1.jar");
        assert!(
            installed
                .warning
                .as_deref()
                .is_some_and(|warning| warning.contains("example-2.jar") && warning.contains("example-3.jar")),
            "{:?}",
            installed.warning
        );
        assert_eq!(fs::read(directory.join("example-1.jar")).unwrap(), new_bytes);
        assert_eq!(cdn.count(), 1, "the new file is downloaded");
        assert!(!directory.join("example-2.jar").exists());
        assert!(!directory.join("example-3.jar").exists());
        assert_eq!(
            fs::read(directory.join("example-0.jar.disabled")).unwrap(),
            disabled_bytes
        );
        assert_eq!(fs::read(directory.join("unknown.jar")).unwrap(), unknown_bytes);
        assert_eq!(fs::read(directory.join("other.jar")).unwrap(), other_bytes);
        let journals = journals(&state);
        assert_eq!(journals.len(), 1, "{journals:?}");
        let journal: serde_json::Value = serde_json::from_str(&journals[0]).unwrap();
        assert_eq!(journal["projects"], serde_json::json!(["cf:456"]));

        let rolled_back = resource_transactions::rollback(&directory, &update_id).unwrap();
        assert_eq!(rolled_back.status, "rolledBack");
        assert_eq!(
            fs::read(directory.join("example-2.jar")).unwrap(),
            enabled_bytes,
            "rollback restores the replaced file byte for byte"
        );
        assert_eq!(
            fs::read(directory.join("example-3.jar")).unwrap(),
            third_bytes,
            "rollback restores the second enabled copy too"
        );
        assert!(!directory.join("example-1.jar").exists());
        assert_eq!(
            fs::read(directory.join("example-0.jar.disabled")).unwrap(),
            disabled_bytes
        );
        assert_eq!(fs::read(directory.join("unknown.jar")).unwrap(), unknown_bytes);
        assert_eq!(fs::read(directory.join("other.jar")).unwrap(), other_bytes);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_update_check_offers_the_newest_release_and_skips_modrinth_files() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"local curseforge update fixture".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(
            curseforge_file(1000, "a.jar", 1, &cdn, bytes),
            bytes,
        );
        let mut current_page = c8_fingerprint_of(
            curseforge_file(1000, "a.jar", 1, &cdn, bytes),
            bytes,
        );
        current_page["releaseType"] = serde_json::json!(1);
        let mut newest = curseforge_file(1001, "a-1001.jar", 2, &cdn, b"new release".as_slice());
        newest["releaseType"] = serde_json::json!(1);
        let mut beta = curseforge_file(1002, "a-1002.jar", 3, &cdn, b"new beta".as_slice());
        beta["releaseType"] = serde_json::json!(2);
        let api = RangeServer::new(vec![
            c8_fingerprint_answer(current),
            c8_project_list(),
            json(serde_json::json!({"data": [current_page, newest, beta]})),
        ]);
        let endpoints = Endpoints::set(&state, &api, &cdn);
        let runtime = c8_runtime();
        let (rows, skipped) = runtime
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(!skipped);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "curseforge");
        assert_eq!(rows[0].new_file_id, Some(1001));
        assert!(!rows[0].manual_only);
        assert!(rows[0].enabled);
        assert_eq!(api.count(), 3);
        assert_eq!(api.header(1, ":path").as_deref(), Some("/mods"), "projects are looked up in one batch");

        let skip: HashSet<String> = ["a.jar".to_owned()].into_iter().collect();
        let (rows, skipped) = runtime
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &skip,
            ))
            .unwrap();
        assert!(rows.is_empty());
        assert!(!skipped);
        assert_eq!(api.count(), 3, "a skipped file is never fingerprinted");

        if crate::curseforge_key::builtin_cf_key().is_none() {
            crate::secrets::save_service_secret(&state.data_dir, "curseforge-api-key", "").unwrap();
            let (rows, skipped) = runtime
                .block_on(crate::curseforge::curseforge_updates(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    &HashSet::new(),
                ))
                .unwrap();
            assert!(rows.is_empty());
            assert!(skipped);
            assert_eq!(api.count(), 3, "without a key nothing is requested");
        }
        drop(endpoints);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_fingerprint_match_with_the_wrong_size_or_sha1_is_not_an_identity() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"fingerprint identity fixture".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let identity =
            c8_fingerprint_of(curseforge_file(1000, "a.jar", 1, &cdn, bytes), bytes);
        let runtime = c8_runtime();
        for (label, matched) in [
            ("wrong size", {
                let mut file = identity.clone();
                file["fileLength"] = serde_json::json!(bytes.len() + 1);
                file
            }),
            ("wrong sha1", {
                let mut file = identity.clone();
                file["hashes"][0]["value"] = serde_json::json!("0".repeat(40));
                file
            }),
            ("another mod", {
                let mut file = identity.clone();
                file["modId"] = serde_json::json!(789);
                file
            }),
            ("another game", {
                let mut file = identity.clone();
                file["gameId"] = serde_json::json!(1);
                file
            }),
        ] {
            let api = RangeServer::new(vec![c8_fingerprint_answer(matched)]);
            let endpoints = Endpoints::set(&state, &api, &cdn);
            let (rows, skipped) = runtime
                .block_on(crate::curseforge::curseforge_updates(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    &HashSet::new(),
                ))
                .unwrap();
            assert!(rows.is_empty(), "{label}");
            assert!(!skipped);
            assert_eq!(
                api.header(0, ":path").as_deref(),
                Some("/fingerprints/432"),
                "{label}: the game's fingerprint endpoint"
            );
            assert_eq!(
                api.count(),
                1,
                "{label}: an unverified match must not be looked up"
            );
            drop(endpoints);
        }
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_file_the_author_keeps_on_curseforge_is_a_manual_update() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let old_bytes = b"old manual download".as_slice();
        fs::write(directory.join("old.jar"), old_bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(
            curseforge_file(1000, "old.jar", 1, &cdn, old_bytes),
            old_bytes,
        );
        let mut newest = curseforge_file(
            1001,
            "new.jar",
            2,
            &cdn,
            b"new manual download".as_slice(),
        );
        newest["releaseType"] = serde_json::json!(1);
        let project_page = "https://www.curseforge.com/minecraft/mc-mods/fixture";
        let project = serde_json::json!({"data": {
            "id": 456, "gameId": 432, "name": "Fixture", "slug": "fixture", "summary": "Fixture",
            "classId": 6, "downloadCount": 0.0, "authors": [], "allowModDistribution": false,
            "links": {"websiteUrl": project_page}
        }});
        let runtime = c8_runtime();
        let run_updates = |project: serde_json::Value, files: Vec<serde_json::Value>| {
            let api = RangeServer::new(vec![
                c8_fingerprint_answer(current.clone()),
                c8_listed(project),
                json(serde_json::json!({"data": files})),
            ]);
            let endpoints = Endpoints::set(&state, &api, &cdn);
            let (rows, skipped) = runtime
                .block_on(crate::curseforge::curseforge_updates(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    &HashSet::new(),
                ))
                .unwrap();
            assert!(!skipped);
            drop(endpoints);
            rows
        };

        let rows = run_updates(project.clone(), vec![current.clone(), newest.clone()]);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].manual_only);
        assert_eq!(rows[0].project_url.as_deref(), Some(project_page));
        assert_eq!(rows[0].new_file_id, Some(1001));

        let mut allowed = project.clone();
        allowed["data"]["allowModDistribution"] = serde_json::json!(true);
        let mut without_url = newest.clone();
        without_url.as_object_mut().unwrap().remove("downloadUrl");
        let rows = run_updates(allowed, vec![current.clone(), without_url]);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].manual_only);
        assert_eq!(rows[0].project_url.as_deref(), Some(project_page));

        let api = RangeServer::new(vec![
            c8_fingerprint_answer(current.clone()),
            json(project.clone()),
            json(serde_json::json!({"data": newest})),
        ]);
        let endpoints = Endpoints::set(&state, &api, &cdn);
        let before = c8_snapshot(&directory);
        let error = c8_expect_error(
            runtime.block_on(crate::curseforge::update_one(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                "old.jar",
                1001,
            )),
            "an update the author keeps manual",
        );
        assert!(
            error
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("禁止第三方分发")),
            "{error:?}"
        );
        assert_eq!(c8_snapshot(&directory), before);
        assert!(journals(&state).is_empty());
        drop(endpoints);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_update_keeps_a_disabled_file_disabled_and_a_foreign_file_changes_nothing() {
        {
            let (root, state) = resource_fixture();
            save_curseforge_key(&state);
            let directory = mods(&state);
            fs::create_dir_all(&directory).unwrap();
            let old_bytes = b"old disabled file".as_slice();
            fs::write(directory.join("old.jar.disabled"), old_bytes).unwrap();
            let new_bytes = b"new file for a disabled slot".as_slice();
            let cdn = RangeServer::new(vec![Scripted::ok(new_bytes, "\"n\"")]);
            let current = c8_fingerprint_of(
                curseforge_file(1000, "old.jar", 1, &cdn, old_bytes),
                old_bytes,
            );
            let new_file = curseforge_file(1001, "new.jar", 2, &cdn, new_bytes);
            let api = RangeServer::new(vec![
                c8_fingerprint_answer(current.clone()),
                curseforge_project(),
                json(serde_json::json!({"data": new_file})),
            ]);
            let endpoints = Endpoints::set(&state, &api, &cdn);
            let runtime = c8_runtime();
            let installed = runtime
                .block_on(crate::curseforge::update_one(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    "old.jar.disabled",
                    1001,
                ))
                .unwrap();
            assert_eq!(installed.file_name, "new.jar.disabled");
            assert!(installed.update_id.is_some());
            assert!(!directory.join("old.jar.disabled").exists());
            assert_eq!(
                fs::read(directory.join("new.jar.disabled")).unwrap(),
                new_bytes
            );
            assert_eq!(journals(&state).len(), 1);
            drop(endpoints);
            drop(state);
            cleanup_fixture(root);
        }

        {
            let (root, state) = resource_fixture();
            save_curseforge_key(&state);
            let directory = mods(&state);
            fs::create_dir_all(&directory).unwrap();
            let old_bytes = b"foreign update current".as_slice();
            fs::write(directory.join("old.jar"), old_bytes).unwrap();
            let cdn = RangeServer::new(Vec::new());
            let current = c8_fingerprint_of(
                curseforge_file(1000, "old.jar", 1, &cdn, old_bytes),
                old_bytes,
            );
            let mut foreign =
                curseforge_file(1001, "new.jar", 2, &cdn, b"foreign new file".as_slice());
            foreign["modId"] = serde_json::json!(789);
            let api = RangeServer::new(vec![
                c8_fingerprint_answer(current),
                curseforge_project(),
                json(serde_json::json!({"data": foreign})),
            ]);
            let endpoints = Endpoints::set(&state, &api, &cdn);
            let before = c8_snapshot(&directory);
            let runtime = c8_runtime();
            let error = c8_expect_error(
                runtime.block_on(crate::curseforge::update_one(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    "old.jar",
                    1001,
                )),
                "an update with a file from another mod",
            );
            assert!(
                error
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("文件不属于所选项目")),
                "{error:?}"
            );
            assert_eq!(c8_snapshot(&directory), before);
            assert!(journals(&state).is_empty());
            drop(endpoints);
            drop(state);
            cleanup_fixture(root);
        }

        {
            let (root, state) = resource_fixture();
            save_curseforge_key(&state);
            let directory = mods(&state);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("foreign.jar"), b"nobody can identify this").unwrap();
            let cdn = RangeServer::new(Vec::new());
            let api = RangeServer::new(vec![json(serde_json::json!({
                "data": {"exactMatches": []}
            }))]);
            let endpoints = Endpoints::set(&state, &api, &cdn);
            let before = c8_snapshot(&directory);
            let runtime = c8_runtime();
            let error = c8_expect_error(
                runtime.block_on(crate::curseforge::update_one(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    "foreign.jar",
                    1001,
                )),
                "an update of an unidentified file",
            );
            assert!(
                error
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("无法确认此文件的 CurseForge 身份")),
                "{error:?}"
            );
            assert_eq!(api.count(), 1);
            assert_eq!(c8_snapshot(&directory), before);
            assert!(journals(&state).is_empty());
            drop(endpoints);
            drop(state);
            cleanup_fixture(root);
        }
    }

    #[test]
    fn c8_requests_retry_after_429_and_answers_are_cached() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"retry and cache fixture".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(
            curseforge_file(1000, "a.jar", 1, &cdn, bytes),
            bytes,
        );
        let mut current_page = current.clone();
        current_page["releaseType"] = serde_json::json!(1);
        let mut newest = curseforge_file(
            1001,
            "new.jar",
            2,
            &cdn,
            b"new retried file".as_slice(),
        );
        newest["releaseType"] = serde_json::json!(1);
        let api = RangeServer::new(vec![
            Scripted::status(429).with_headers(vec![("Retry-After", "0".into())]),
            c8_fingerprint_answer(current),
            c8_project_list(),
            json(serde_json::json!({"data": [current_page, newest]})),
        ]);
        let endpoints = Endpoints::set(&state, &api, &cdn);
        let runtime = c8_runtime();
        let (rows, skipped) = runtime
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(!skipped);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].new_file_id, Some(1001));
        assert_eq!(
            api.count(),
            4,
            "one retried fingerprint request and the three answers"
        );

        let (rows, _) = runtime
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].new_file_id, Some(1001));
        assert_eq!(
            api.count(),
            4,
            "the same requests are served from the answer cache"
        );
        drop(endpoints);

        let api = RangeServer::new(vec![
            Scripted::status(401),
            Scripted::status(401),
            Scripted::status(401),
            Scripted::status(401),
        ]);
        let endpoints = Endpoints::set(&state, &api, &cdn);
        let error = c8_expect_error(
            runtime.block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            )),
            "a 401 answer",
        );
        assert!(error.contains("拒绝访问"), "{error}");
        assert_eq!(api.count(), 1, "401 is final and is not retried");
        drop(endpoints);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_staged_replace_sets_aside_the_same_mod_but_refuses_another() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let old_bytes = {
            use std::io::Write;
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            zip.start_file(
                "fabric.mod.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(br#"{"id":"example","version":"old"}"#).unwrap();
            zip.finish().unwrap().into_inner()
        };
        fs::write(directory.join("example.jar"), &old_bytes).unwrap();
        let new_bytes = c8_jar_bytes("example");
        // One answer for this install, one for the refused second attempt below.
        let cdn = RangeServer::new(vec![
            Scripted::ok(&new_bytes, "\"e\""),
            Scripted::ok(&new_bytes, "\"e\""),
        ]);
        let file = curseforge_file(1001, "example.jar", 2, &cdn, &new_bytes);
        let api = RangeServer::new(vec![
            curseforge_project(),
            json(serde_json::json!({"data": file.clone()})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let request = ResourceRequest {
            source: ResourceSource::Curseforge,
            project_id: "456".into(),
            resource_type: "mod".into(),
            target: ReservedTarget::Existing {
                version_id: "fabric-test".into(),
                instance_id: None,
                file_id: Some(1001),
                resource_version_id: None,
            },
        };
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let installed = run(&state, &task, request.clone())
            .unwrap()
            .installed()
            .unwrap();
        let update_id = installed
            .update_id
            .clone()
            .expect("the replaced file is journaled");
        assert_eq!(installed.file_name, "example.jar");
        assert!(
            installed
                .warning
                .as_deref()
                .is_some_and(|warning| warning.contains("example.jar")),
            "{:?}",
            installed.warning
        );
        assert_eq!(fs::read(directory.join("example.jar")).unwrap(), new_bytes);
        let found = journals(&state);
        assert_eq!(found.len(), 1, "{found:?}");
        let journal: serde_json::Value = serde_json::from_str(&found[0]).unwrap();
        let history = directory
            .parent()
            .unwrap()
            .join(".launcher-resource-history")
            .join("mods");
        let transaction = history.join(journal["id"].as_str().unwrap());
        assert_eq!(
            fs::read(transaction.join("staged-replaced").join("example.jar")).unwrap(),
            old_bytes,
            "the previous copy is in the journal"
        );
        let rolled_back = resource_transactions::rollback(&directory, &update_id).unwrap();
        assert_eq!(rolled_back.status, "rolledBack");
        assert_eq!(
            fs::read(directory.join("example.jar")).unwrap(),
            old_bytes,
            "rollback restores the old bytes byte for byte"
        );
        drop(_endpoints);

        // A same-named JAR declaring another mod is not a duplicate of the file
        // being installed, so it is still refused and the live folder is unchanged.
        let other_bytes = c8_jar_bytes("other");
        fs::write(directory.join("example.jar"), &other_bytes).unwrap();
        let before = c8_snapshot(&directory);
        let api = RangeServer::new(vec![
            curseforge_project(),
            json(serde_json::json!({"data": file})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let error = c8_expect_error(
            run(&state, &task, request),
            "a same-named jar of another mod",
        );
        assert!(
            error
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("同名文件")),
            "{error:?}"
        );
        assert_eq!(c8_snapshot(&directory), before, "the refused install changes nothing");
        assert_eq!(journals(&state).len(), 1, "the refused install makes no journal");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_an_exact_file_with_another_enabled_copy_is_journaled_and_rolls_back() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = c8_jar_bytes("example");
        let copy_bytes = {
            use std::io::Write;
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            zip.start_file(
                "fabric.mod.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(br#"{"id":"example","version":"copy"}"#).unwrap();
            zip.finish().unwrap().into_inner()
        };
        fs::write(directory.join("example-1.jar"), &bytes).unwrap();
        fs::write(directory.join("example-2.jar"), &copy_bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let file_id = 2001_u64;
        let file = curseforge_file(file_id, "example-1.jar", 2, &cdn, &bytes);
        let api = RangeServer::new(vec![
            curseforge_project(),
            json(serde_json::json!({"data": file.clone()})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let request = ResourceRequest {
            source: ResourceSource::Curseforge,
            project_id: "456".into(),
            resource_type: "mod".into(),
            target: ReservedTarget::Existing {
                version_id: "fabric-test".into(),
                instance_id: None,
                file_id: Some(file_id),
                resource_version_id: None,
            },
        };
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let installed = run(&state, &task, request.clone())
            .unwrap()
            .installed()
            .unwrap();
        let update_id = installed
            .update_id
            .clone()
            .expect("another enabled copy makes this a journaled replace");
        assert_eq!(installed.file_name, "example-1.jar");
        assert!(
            installed
                .warning
                .as_deref()
                .is_some_and(|warning| warning.contains("example-2.jar")),
            "{:?}",
            installed.warning
        );
        assert_eq!(fs::read(directory.join("example-1.jar")).unwrap(), bytes);
        assert!(!directory.join("example-2.jar").exists());
        assert_eq!(journals(&state).len(), 1);
        let rolled_back = resource_transactions::rollback(&directory, &update_id).unwrap();
        assert_eq!(rolled_back.status, "rolledBack");
        assert_eq!(
            fs::read(directory.join("example-2.jar")).unwrap(),
            copy_bytes,
            "rollback restores the enabled copy that was set aside"
        );
        drop(_endpoints);

        // With no other enabled copy the same install is an already-selected
        // version: no journal and no directory change.
        fs::remove_file(directory.join("example-2.jar")).unwrap();
        let before = c8_snapshot(&directory);
        let api = RangeServer::new(vec![
            curseforge_project(),
            json(serde_json::json!({"data": file})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let installed = run(&state, &task, request).unwrap().installed().unwrap();
        assert_eq!(installed.file_name, "example-1.jar");
        assert!(installed.update_id.is_none(), "the exact version alone is already installed");
        assert_eq!(installed.warning.as_deref(), Some("资源已是选定版本。"));
        assert_eq!(c8_snapshot(&directory), before);
        assert_eq!(journals(&state).len(), 1, "no second journal is made");
        assert_eq!(cdn.count(), 0, "the exact file needs no download");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_disabled_update_leaves_enabled_copies_and_refuses_a_new_name() {
        {
            let (root, state) = resource_fixture();
            save_curseforge_key(&state);
            let directory = mods(&state);
            fs::create_dir_all(&directory).unwrap();
            let old_bytes = c8_jar("example", "old");
            let duplicate_bytes = c8_jar("example", "9");
            let new_bytes = c8_jar("example", "new");
            fs::write(directory.join("old.jar.disabled"), &old_bytes).unwrap();
            fs::write(directory.join("example-9.jar"), &duplicate_bytes).unwrap();
            let cdn = RangeServer::new(vec![Scripted::ok(&new_bytes, "\"n\"")]);
            let current = c8_fingerprint_of(
                curseforge_file(3000, "old.jar", 1, &cdn, &old_bytes),
                &old_bytes,
            );
            let new_file = curseforge_file(3001, "new.jar", 2, &cdn, &new_bytes);
            let api = RangeServer::new(vec![
                c8_fingerprint_answer(current),
                curseforge_project(),
                json(serde_json::json!({"data": new_file})),
            ]);
            let _endpoints = Endpoints::set(&state, &api, &cdn);
            let runtime = c8_runtime();
            let installed = runtime
                .block_on(crate::curseforge::update_one(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    "old.jar.disabled",
                    3001,
                ))
                .unwrap();
            assert_eq!(installed.file_name, "new.jar.disabled");
            assert!(installed.update_id.is_some());
            assert!(!directory.join("old.jar.disabled").exists());
            assert_eq!(
                fs::read(directory.join("new.jar.disabled")).unwrap(),
                new_bytes
            );
            assert_eq!(
                fs::read(directory.join("example-9.jar")).unwrap(),
                duplicate_bytes,
                "the enabled copy is untouched"
            );
            assert!(
                directory.join("example-9.jar").exists(),
                "the enabled copy stays enabled"
            );
            assert_eq!(journals(&state).len(), 1);
            drop(state);
            cleanup_fixture(root);
        }

        {
            let (root, state) = resource_fixture();
            save_curseforge_key(&state);
            let directory = mods(&state);
            fs::create_dir_all(&directory).unwrap();
            let old_bytes = c8_jar("example", "old");
            let blocked_bytes = c8_jar("example", "blocked");
            let new_bytes = c8_jar("example", "new");
            fs::write(directory.join("old.jar.disabled"), &old_bytes).unwrap();
            fs::write(directory.join("new.jar"), &blocked_bytes).unwrap();
            let cdn = RangeServer::new(Vec::new());
            let current = c8_fingerprint_of(
                curseforge_file(3100, "old.jar", 1, &cdn, &old_bytes),
                &old_bytes,
            );
            let new_file = curseforge_file(3101, "new.jar", 2, &cdn, &new_bytes);
            let api = RangeServer::new(vec![
                c8_fingerprint_answer(current),
                curseforge_project(),
                json(serde_json::json!({"data": new_file})),
            ]);
            let _endpoints = Endpoints::set(&state, &api, &cdn);
            let before = c8_snapshot(&directory);
            let runtime = c8_runtime();
            let error = c8_expect_error(
                runtime.block_on(crate::curseforge::update_one(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    "old.jar.disabled",
                    3101,
                )),
                "a disabled update whose new name already exists",
            );
            assert!(
                error
                    .detail
                    .as_deref()
                    .is_some_and(|detail| detail.contains("同名文件")),
                "{error:?}"
            );
            assert_eq!(c8_snapshot(&directory), before);
            assert!(
                journals(&state).is_empty(),
                "the refused update leaves no journal"
            );
            drop(state);
            cleanup_fixture(root);
        }
    }

    #[test]
    fn c8_an_older_file_is_not_an_update_and_never_downgrades() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"current later file".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(
            curseforge_file(4000, "a.jar", 20, &cdn, bytes),
            bytes,
        );
        let mut current_page = curseforge_file(4000, "a.jar", 20, &cdn, bytes);
        current_page["releaseType"] = serde_json::json!(1);
        let mut older = curseforge_file(4001, "older.jar", 10, &cdn, b"older release".as_slice());
        older["releaseType"] = serde_json::json!(1);
        let api = RangeServer::new(vec![
            c8_fingerprint_answer(current),
            c8_project_list(),
            json(serde_json::json!({"data": [current_page, older.clone()]})),
            curseforge_project(),
            json(serde_json::json!({"data": older})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let runtime = c8_runtime();
        let (rows, skipped) = runtime
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(!skipped);
        assert!(rows.is_empty(), "an older release is not an update");
        let before = c8_snapshot(&directory);
        let error = c8_expect_error(
            runtime.block_on(crate::curseforge::update_one(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                "a.jar",
                4001,
            )),
            "an update to an older file",
        );
        assert!(
            error
                .detail
                .as_deref()
                .is_some_and(|detail| detail.contains("更新不会降级")),
            "{error:?}"
        );
        assert_eq!(c8_snapshot(&directory), before);
        assert!(journals(&state).is_empty());
        assert_eq!(api.count(), 5);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_no_beta_or_alpha_fallback_for_a_release() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"release only current".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(
            curseforge_file(5000, "a.jar", 1, &cdn, bytes),
            bytes,
        );
        let mut current_page = curseforge_file(5000, "a.jar", 1, &cdn, bytes);
        current_page["releaseType"] = serde_json::json!(1);
        let mut beta = curseforge_file(5001, "beta.jar", 2, &cdn, b"newer beta".as_slice());
        beta["releaseType"] = serde_json::json!(2);
        let mut alpha = curseforge_file(5002, "alpha.jar", 3, &cdn, b"newer alpha".as_slice());
        alpha["releaseType"] = serde_json::json!(3);
        let api = RangeServer::new(vec![
            c8_fingerprint_answer(current),
            c8_project_list(),
            json(serde_json::json!({"data": [current_page, beta, alpha]})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let (rows, skipped) = c8_runtime()
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(!skipped);
        assert!(rows.is_empty(), "a newer beta or alpha is not offered as an update");
        assert_eq!(api.count(), 3);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_curseforge_failure_keeps_modrinth_rows_but_a_cancel_stops_the_check() {
        let row = || resource_transactions::ResourceUpdate {
            file_name: "a.jar".into(),
            name: "Fixture".into(),
            current_version: "1".into(),
            new_version: "2".into(),
            project_id: "456".into(),
            new_version_id: "2".into(),
            enabled: true,
            source: "modrinth".into(),
            new_file_id: None,
            manual_only: false,
            project_url: None,
        };
        let (rows, skipped, error) = curseforge_part(Ok((vec![row()], true))).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(skipped);
        assert!(error.is_none());

        let error = c8_expect_error(
            curseforge_part(Err(CANCELLED.into())),
            "a cancelled update check",
        );
        assert_eq!(error.code, "download.cancelled");

        let (rows, skipped, error) = curseforge_part(Err("CurseForge 请求失败（HTTP 500）".into())).unwrap();
        assert!(rows.is_empty());
        assert!(!skipped);
        assert_eq!(error.as_deref(), Some("CurseForge 请求失败（HTTP 500）"));
    }

    #[test]
    fn c8_a_file_verified_under_two_mods_is_not_an_identity() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"ambiguous local file".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let first = c8_fingerprint_of(curseforge_file(6000, "a.jar", 1, &cdn, bytes), bytes);
        let mut second = c8_fingerprint_of(curseforge_file(6001, "a.jar", 1, &cdn, bytes), bytes);
        second["modId"] = serde_json::json!(789);
        let api = RangeServer::new(vec![json(serde_json::json!({
            "data": {"exactMatches": [
                {"id": 456, "file": first},
                {"id": 789, "file": second},
            ]}
        }))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let (rows, skipped) = c8_runtime()
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(!skipped);
        assert!(rows.is_empty(), "the same bytes under two mods identify neither");
        assert_eq!(api.count(), 1, "an ambiguous identity makes no project request");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_bad_folder_entries_do_not_stop_the_update_check() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = root.join("m");
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"identified among bad entries".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        fs::create_dir(directory.join("x.jar")).unwrap();
        let bad_name = format!("{}.jar", "z".repeat(157));
        assert!(validate_id(&bad_name).is_err());
        fs::write(directory.join(&bad_name), b"invalid name").unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(curseforge_file(7000, "a.jar", 1, &cdn, bytes), bytes);
        let mut newer = curseforge_file(7001, "a-new.jar", 2, &cdn, b"new release".as_slice());
        newer["releaseType"] = serde_json::json!(1);
        let api = RangeServer::new(vec![
            c8_fingerprint_answer(current),
            c8_project_list(),
            json(serde_json::json!({
                "data": [curseforge_file(7000, "a.jar", 1, &cdn, bytes), newer]
            })),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let (rows, skipped) = c8_runtime()
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(!skipped);
        assert_eq!(rows.len(), 1, "the readable identified file is still checked");
        assert_eq!(rows[0].file_name, "a.jar");
        assert_eq!(rows[0].new_file_id, Some(7001));
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_the_project_page_rejects_missing_insecure_and_credentialed_links() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"project page fixture".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(curseforge_file(8000, "a.jar", 1, &cdn, bytes), bytes);
        let current_page = curseforge_file(8000, "a.jar", 1, &cdn, bytes);
        let mut newest = curseforge_file(8001, "a-new.jar", 2, &cdn, b"new release".as_slice());
        newest["releaseType"] = serde_json::json!(1);
        newest.as_object_mut().unwrap().remove("downloadUrl");
        let project = |link: Option<&str>| {
            let mut project = serde_json::json!({"data": {
                "id": 456, "gameId": 432, "name": "Fixture", "slug": "fixture", "summary": "Fixture",
                "classId": 6, "downloadCount": 0.0, "authors": [], "allowModDistribution": true
            }});
            if let Some(link) = link {
                project["data"]["links"] = serde_json::json!({"websiteUrl": link});
            }
            project
        };
        let fallback = "https://www.curseforge.com/projects/456";
        let runtime = c8_runtime();
        for (label, link, expected) in [
            ("missing", None, fallback),
            ("http", Some("http://www.curseforge.com/minecraft/mc-mods/x"), fallback),
            (
                "userinfo",
                Some("https://user@www.curseforge.com/minecraft/mc-mods/x"),
                fallback,
            ),
            (
                "valid",
                Some("https://www.curseforge.com/minecraft/mc-mods/x"),
                "https://www.curseforge.com/minecraft/mc-mods/x",
            ),
        ] {
            let api = RangeServer::new(vec![
                c8_fingerprint_answer(current.clone()),
                c8_listed(project(link)),
                json(serde_json::json!({"data": [current_page.clone(), newest.clone()]})),
            ]);
            let endpoints = Endpoints::set(&state, &api, &cdn);
            let (rows, skipped) = runtime
                .block_on(crate::curseforge::curseforge_updates(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    &HashSet::new(),
                ))
                .unwrap();
            assert!(!skipped, "{label}");
            assert_eq!(rows.len(), 1, "{label}");
            assert!(rows[0].manual_only, "{label}");
            assert_eq!(rows[0].project_url.as_deref(), Some(expected), "{label}");
            drop(endpoints);
        }
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_release_on_a_later_file_page_is_offered() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"paged update fixture".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(curseforge_file(9000, "a.jar", 1, &cdn, bytes), bytes);
        let current_page = curseforge_file(9000, "a.jar", 1, &cdn, bytes);
        let betas: Vec<_> = (0..50_u64)
            .map(|index| {
                let mut beta = curseforge_file(
                    9100 + index,
                    &format!("beta-{index}.jar"),
                    10,
                    &cdn,
                    b"beta release".as_slice(),
                );
                beta["releaseType"] = serde_json::json!(2);
                beta
            })
            .collect();
        let mut release = curseforge_file(9200, "release.jar", 2, &cdn, b"release file".as_slice());
        release["releaseType"] = serde_json::json!(1);
        let api = RangeServer::new(vec![
            c8_fingerprint_answer(current),
            c8_project_list(),
            json(serde_json::json!({"data": betas})),
            json(serde_json::json!({"data": [release, current_page]})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let (rows, skipped) = c8_runtime()
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(!skipped);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].new_file_id, Some(9200));
        assert!(
            api.header(2, ":path")
                .as_deref()
                .is_some_and(|path| path.contains("index=0")),
            "{:?}",
            api.header(2, ":path")
        );
        assert!(
            api.header(3, ":path")
                .as_deref()
                .is_some_and(|path| path.contains("index=50")),
            "{:?}",
            api.header(3, ":path")
        );
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_retry_classes_and_retry_after_on_5xx() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("a.jar"), b"retry fixture").unwrap();
        let cdn = RangeServer::new(Vec::new());
        let runtime = c8_runtime();
        let run_check = |api: &RangeServer| {
            let _endpoints = Endpoints::set(&state, api, &cdn);
            runtime.block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
        };

        for (status, label) in [(403_u16, "拒绝访问"), (404, "不存在")] {
            let api = RangeServer::new(vec![Scripted::status(status)]);
            let error = c8_expect_error(run_check(&api), "a final CurseForge error");
            assert!(error.contains(label), "{status}: {error}");
            assert_eq!(api.count(), 1, "HTTP {status} is not retried");
        }

        let api = RangeServer::new((0..4).map(|_| Scripted::status(503)).collect());
        let error = c8_expect_error(run_check(&api), "four 503 answers");
        assert!(error.contains("HTTP 503"), "{error}");
        assert_eq!(api.count(), 4, "the first request and three retries");

        let api = RangeServer::new(vec![
            Scripted::status(503).with_headers(vec![("Retry-After", "5".into())]),
            json(serde_json::json!({"data": {"exactMatches": []}})),
        ]);
        // Five seconds: without Retry-After the wait is 500 ms, and the pacer
        // shared with the other tests cannot add three and a half seconds.
        let started = std::time::Instant::now();
        let (rows, skipped) = run_check(&api).unwrap();
        assert!(rows.is_empty());
        assert!(!skipped);
        assert!(
            started.elapsed() >= Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(api.count(), 2);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_uncached_requests_are_paced() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let first_bytes = b"paced first".as_slice();
        let second_bytes = b"paced second".as_slice();
        fs::write(directory.join("a.jar"), first_bytes).unwrap();
        fs::write(directory.join("b.jar"), second_bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let first = c8_fingerprint_of(
            curseforge_file(10000, "a.jar", 1, &cdn, first_bytes),
            first_bytes,
        );
        let mut second = c8_fingerprint_of(
            curseforge_file(10001, "b.jar", 1, &cdn, second_bytes),
            second_bytes,
        );
        second["modId"] = serde_json::json!(789);
        let current_page = curseforge_file(10000, "a.jar", 1, &cdn, first_bytes);
        let projects = serde_json::json!({"data": [
            {"id": 456, "gameId": 432, "name": "Fixture", "slug": "fixture", "summary": "Fixture",
                "classId": 6, "downloadCount": 0.0, "authors": []},
            {"id": 789, "gameId": 432, "name": "Other", "slug": "other", "summary": "Other",
                "classId": 6, "downloadCount": 0.0, "authors": []},
        ]});
        // Fingerprints, the project batch, then one file page per mod.
        let api = RangeServer::new(vec![
            json(serde_json::json!({"data": {"exactMatches": [
                {"id": 456, "file": first},
                {"id": 789, "file": second},
            ]}})),
            json(projects),
            json(serde_json::json!({"data": [current_page]})),
            json(serde_json::json!({"data": []})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let started = std::time::Instant::now();
        let (rows, skipped) = c8_runtime()
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        let elapsed = started.elapsed();
        assert!(!skipped);
        assert!(rows.is_empty());
        assert_eq!(api.count(), 4, "four uncached requests");
        assert!(
            elapsed >= Duration::from_millis(750),
            "four requests must be paced over at least 750 ms: {elapsed:?}"
        );
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_modrinth_identified_files_are_skipped_by_curseforge() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"modrinth identified local file".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let version = modrinth_version("identified", 1, &cdn, bytes);
        let hash = format!("{:x}", sha2::Sha512::digest(bytes));
        let mut by_hash = serde_json::Map::new();
        by_hash.insert(hash, version.clone());
        let api = RangeServer::new(vec![
            json(serde_json::Value::Object(by_hash)),
            json(serde_json::json!([version])),
        ]);
        let endpoints = Endpoints::set(&state, &api, &cdn);
        let runtime = c8_runtime();
        let (rows, identified) = runtime
            .block_on(resource_transactions::updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
            ))
            .unwrap();
        assert!(rows.is_empty());
        assert_eq!(
            identified,
            ["a.jar".to_owned()].into_iter().collect::<HashSet<_>>()
        );
        assert_eq!(
            api.header(0, ":path").as_deref(),
            Some("/version_files"),
            "Modrinth identifies the local SHA-512"
        );
        assert_eq!(api.count(), 2);
        drop(endpoints);

        let curseforge = RangeServer::new(vec![Scripted::status(403)]);
        let _endpoints = Endpoints::set(&state, &curseforge, &cdn);
        let (rows, skipped) = runtime
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &identified,
            ))
            .unwrap();
        assert!(rows.is_empty());
        assert!(!skipped);
        assert_eq!(
            curseforge.count(),
            0,
            "a file Modrinth identified is never sent to CurseForge"
        );
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_cancel_drops_a_stalled_curseforge_request_at_once() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"stalled request fixture".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(curseforge_file(11000, "a.jar", 1, &cdn, bytes), bytes);
        let runtime = c8_runtime();
        // The check stalls at each of its requests in turn: (answers, requests seen).
        for (label, script, stalled_at) in [
            ("the fingerprint request", vec![Scripted::silent()], 1),
            (
                "a retry wait",
                vec![
                    Scripted::status(503).with_headers(vec![("Retry-After", "10".into())]),
                    Scripted::silent(),
                ],
                1,
            ),
            ("the project batch", vec![c8_fingerprint_answer(current.clone()), Scripted::silent()], 2),
            (
                "a file page",
                vec![c8_fingerprint_answer(current.clone()), c8_project_list(), Scripted::silent()],
                3,
            ),
        ] {
            let api = RangeServer::new(script);
            let endpoints = Endpoints::set(&state, &api, &cdn);
            let task = state.control.begin("resource-check", "fabric-test", "检查资源更新").unwrap();
            let skip = HashSet::new();
            // Timed from the cancel: other tests share the process-wide pacer.
            let (result, cancelled) = runtime.block_on(async {
                let check = crate::curseforge::curseforge_updates(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    &skip,
                );
                let cancel = async {
                    // A build that stops before the stall fails below instead of hanging here
                    // (the pacer is shared with every other test, so reaching it can be slow).
                    let deadline = std::time::Instant::now() + Duration::from_secs(60);
                    while api.count() < stalled_at && std::time::Instant::now() < deadline {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    state.control.cancel(&task);
                    std::time::Instant::now()
                };
                futures_util::future::join(check, cancel).await
            });
            let elapsed = cancelled.elapsed();
            assert_eq!(result.map(|_| ()).unwrap_err(), CANCELLED, "{label}");
            assert!(elapsed < Duration::from_secs(2), "{label}: the cancel waited {elapsed:?}");
            assert_eq!(api.count(), stalled_at, "{label}: nothing is sent after the cancel");
            state.control.finish(&task, Some(CANCELLED));
            drop(endpoints);
        }

        // Updating one file stalls at the project request, then at the download.
        let stalled_cdn = RangeServer::new(vec![Scripted::silent()]);
        let new_file = curseforge_file(11001, "a-new.jar", 2, &stalled_cdn, b"stalled new file".as_slice());
        for (label, script, cdn) in [
            ("the project request", vec![c8_fingerprint_answer(current.clone()), Scripted::silent()], &cdn),
            (
                "the file download",
                vec![
                    c8_fingerprint_answer(current.clone()),
                    curseforge_project(),
                    json(serde_json::json!({"data": new_file})),
                ],
                &stalled_cdn,
            ),
        ] {
            let api = RangeServer::new(script);
            let endpoints = Endpoints::set(&state, &api, cdn);
            let before = c8_snapshot(&directory);
            let task = state.control.begin("resource-update", "a.jar", "更新资源及必需前置").unwrap();
            let (result, cancelled) = runtime.block_on(async {
                let update = crate::curseforge::update_one(
                    &state,
                    &directory,
                    "1.21.1",
                    Some("fabric"),
                    Some("fabric"),
                    ResourceKind::Mod,
                    "mod",
                    "a.jar",
                    11001,
                );
                let cancel = async {
                    let deadline = std::time::Instant::now() + Duration::from_secs(60);
                    while (api.count() < 2 || (std::ptr::eq(cdn, &stalled_cdn) && cdn.count() == 0))
                        && std::time::Instant::now() < deadline
                    {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    state.control.cancel(&task);
                    std::time::Instant::now()
                };
                futures_util::future::join(update, cancel).await
            });
            let error = c8_expect_error(result, label);
            assert_eq!(error.code, "download.cancelled", "{label}: {error:?}");
            assert!(cancelled.elapsed() < Duration::from_secs(2), "{label}: {:?}", cancelled.elapsed());
            assert_eq!(c8_snapshot(&directory), before, "{label}");
            assert!(journals(&state).is_empty(), "{label}");
            state.control.finish(&task, Some(CANCELLED));
            drop(endpoints);
        }
        assert_eq!(stalled_cdn.count(), 1, "the download was reached once");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_retry_waits_until_an_http_date_retry_after() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("a.jar"), b"dated retry fixture").unwrap();
        let cdn = RangeServer::new(Vec::new());
        // Timed from before the date is made; the date is more than four whole
        // seconds ahead once its seconds are cut off. Without the date the wait
        // is 500 ms, and the shared pacer cannot add three and a half seconds.
        let started = std::time::Instant::now();
        let date = (chrono::Utc::now() + chrono::Duration::seconds(5))
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        let api = RangeServer::new(vec![
            Scripted::status(503).with_headers(vec![("Retry-After", date.clone())]),
            json(serde_json::json!({"data": {"exactMatches": []}})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let (rows, skipped) = c8_runtime()
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(rows.is_empty() && !skipped);
        assert_eq!(api.count(), 2);
        assert!(
            started.elapsed() >= Duration::from_secs(4),
            "Retry-After {date} was not honoured: {:?}",
            started.elapsed()
        );
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_removed_project_or_file_list_skips_only_that_file() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let local = |name: &str, mod_id: u64, file_id: u64| {
            let bytes = format!("{name} removed project fixture").into_bytes();
            fs::write(directory.join(name), &bytes).unwrap();
            let mut file = c8_fingerprint_of(curseforge_file(file_id, name, 1, &cdn, &bytes), &bytes);
            file["modId"] = serde_json::json!(mod_id);
            file
        };
        // a.jar: its file list is gone (404); b.jar: CurseForge no longer returns
        // its project; c.jar: a normal update.
        let a = local("a.jar", 456, 12000);
        let b = local("b.jar", 789, 12100);
        let c = local("c.jar", 321, 12200);
        let fingerprints = json(serde_json::json!({"data": {"exactMatches": [
            {"id": 456, "file": a}, {"id": 789, "file": b}, {"id": 321, "file": c},
        ]}}));
        let project = |id: u64| serde_json::json!({
            "id": id, "gameId": 432, "name": format!("Fixture {id}"), "slug": "fixture", "summary": "Fixture",
            "classId": 6, "downloadCount": 0.0, "authors": [], "allowModDistribution": true
        });
        let mut release = curseforge_file(12201, "c-new.jar", 2, &cdn, b"c release".as_slice());
        release["modId"] = serde_json::json!(321);
        release["releaseType"] = serde_json::json!(1);
        let api = RangeServer::new(vec![
            fingerprints,
            json(serde_json::json!({"data": [project(456), project(321)]})),
            Scripted::status(404),
            json(serde_json::json!({"data": [release]})),
        ]);
        let endpoints = Endpoints::set(&state, &api, &cdn);
        let runtime = c8_runtime();
        let (rows, skipped) = runtime
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(!skipped);
        assert_eq!(rows.len(), 1, "only c.jar has an update");
        assert_eq!(rows[0].file_name, "c.jar");
        assert_eq!(rows[0].new_file_id, Some(12201));
        assert_eq!(api.header(1, ":path").as_deref(), Some("/mods"), "one batch for all three projects");
        assert!(api.header(2, ":path").is_some_and(|path| path.starts_with("/mods/456/files")));
        assert!(api.header(3, ":path").is_some_and(|path| path.starts_with("/mods/321/files")));
        assert_eq!(api.count(), 4, "no request for the project CurseForge did not return");
        drop(endpoints);

        // A service failure is not one file's problem: the CurseForge part fails.
        fs::remove_file(directory.join("b.jar")).unwrap();
        fs::remove_file(directory.join("c.jar")).unwrap();
        let a = local("a.jar", 456, 12000);
        let mut answers = vec![
            json(serde_json::json!({"data": {"exactMatches": [{"id": 456, "file": a}]}})),
            json(serde_json::json!({"data": [project(456)]})),
        ];
        answers.extend((0..4).map(|_| Scripted::status(500)));
        let api = RangeServer::new(answers);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let error = c8_expect_error(
            runtime.block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            )),
            "a file list that keeps failing",
        );
        assert!(error.contains("HTTP 500"), "{error}");
        assert_eq!(api.count(), 6);
        drop(_endpoints);

        // A 404 for the whole project batch skips those projects, it does not end the check.
        let a = local("a.jar", 456, 12000);
        let api = RangeServer::new(vec![
            json(serde_json::json!({"data": {"exactMatches": [{"id": 456, "file": a}]}})),
            Scripted::status(404),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let (rows, skipped) = runtime
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert!(rows.is_empty() && !skipped);
        assert_eq!(api.header(1, ":path").as_deref(), Some("/mods"));
        assert_eq!(api.count(), 2);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_a_download_address_off_the_cdn_makes_a_manual_row() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = b"off cdn fixture".as_slice();
        fs::write(directory.join("a.jar"), bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let current = c8_fingerprint_of(curseforge_file(13000, "a.jar", 1, &cdn, bytes), bytes);
        let mut newest = curseforge_file(13001, "a-new.jar", 2, &cdn, b"off cdn release".as_slice());
        newest["releaseType"] = serde_json::json!(1);
        newest["downloadUrl"] = serde_json::json!("https://files.example.invalid/a-new.jar");
        let api = RangeServer::new(vec![
            c8_fingerprint_answer(current.clone()),
            c8_project_list(),
            json(serde_json::json!({"data": [current, newest]})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let (rows, _) = c8_runtime()
            .block_on(crate::curseforge::curseforge_updates(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                &HashSet::new(),
            ))
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].manual_only, "a download the launcher would refuse is offered as a manual download");
        assert_eq!(rows[0].project_url.as_deref(), Some("https://www.curseforge.com/projects/456"));
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_updating_a_file_that_is_gone_asks_nothing() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let api = RangeServer::new(Vec::new());
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let error = c8_expect_error(
            c8_runtime().block_on(crate::curseforge::update_one(
                &state,
                &directory,
                "1.21.1",
                Some("fabric"),
                Some("fabric"),
                ResourceKind::Mod,
                "mod",
                "gone.jar",
                14001,
            )),
            "an update of a file that was moved away",
        );
        assert!(error.detail.as_deref().is_some_and(|detail| detail.contains("待更新资源不存在")), "{error:?}");
        assert_eq!(api.count(), 0);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c8_reselecting_the_installed_file_does_not_check_its_dependencies() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = c8_jar("example", "1");
        fs::write(directory.join("example-1.jar"), &bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let mut file = curseforge_file(15001, "example-1.jar", 2, &cdn, &bytes);
        file["dependencies"] = serde_json::json!([{"modId": 999, "relationType": 3}]);
        let api = RangeServer::new(vec![curseforge_project(), json(serde_json::json!({"data": file}))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let request = ResourceRequest {
            source: ResourceSource::Curseforge,
            project_id: "456".into(),
            resource_type: "mod".into(),
            target: ReservedTarget::Existing {
                version_id: "fabric-test".into(),
                instance_id: None,
                file_id: Some(15001),
                resource_version_id: None,
            },
        };
        let task = state.control.reserve_resource(request.clone()).unwrap();
        let installed = run(&state, &task, request).unwrap().installed().unwrap();
        assert!(installed.update_id.is_none());
        assert_eq!(installed.warning.as_deref(), Some("资源已是选定版本。"));
        assert_eq!(api.count(), 2, "the dependency of a file already there is not looked up");
        assert_eq!(fs::read(directory.join("example-1.jar")).unwrap(), bytes);
        drop(state);
        cleanup_fixture(root);
    }

    /// Windows and macOS folders ignore case: `New.jar` is the selected `new.jar`.
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn c8_a_file_whose_name_differs_only_in_case_is_the_selected_file() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let bytes = c8_jar("example", "1");
        fs::write(directory.join("New.jar"), &bytes).unwrap();
        let cdn = RangeServer::new(Vec::new());
        let file = curseforge_file(16001, "new.jar", 2, &cdn, &bytes);
        let request = ResourceRequest {
            source: ResourceSource::Curseforge,
            project_id: "456".into(),
            resource_type: "mod".into(),
            target: ReservedTarget::Existing {
                version_id: "fabric-test".into(),
                instance_id: None,
                file_id: Some(16001),
                resource_version_id: None,
            },
        };
        let install = |file: &serde_json::Value| {
            let api = RangeServer::new(vec![curseforge_project(), json(serde_json::json!({"data": file}))]);
            let _endpoints = Endpoints::set(&state, &api, &cdn);
            let task = state.control.reserve_resource(request.clone()).unwrap();
            run(&state, &task, request.clone()).unwrap().installed().unwrap()
        };
        let installed = install(&file);
        assert!(installed.update_id.is_none(), "{:?}", installed.warning);
        assert_eq!(installed.warning.as_deref(), Some("资源已是选定版本。"));
        assert_eq!(fs::read(directory.join("New.jar")).unwrap(), bytes);
        assert!(journals(&state).is_empty());

        // With another enabled copy, only that copy moves aside; New.jar stays.
        let copy = c8_jar("example", "2");
        fs::write(directory.join("example-2.jar"), &copy).unwrap();
        let installed = install(&file);
        assert!(installed.update_id.is_some());
        let names: Vec<_> = c8_snapshot(&directory).into_iter().map(|(name, _)| name).collect();
        assert_eq!(names, ["New.jar"], "the selected file stays and the copy is set aside");
        assert_eq!(fs::read(directory.join("New.jar")).unwrap(), bytes);
        assert_eq!(cdn.count(), 0);
        drop(state);
        cleanup_fixture(root);
    }

    // ---- C9: resource parts outside the staged copy ----------------------------

    const C9_MIB: usize = 1024 * 1024;

    /// A jar of more than 2 MiB declaring `mod_id` (stored, so it stays that
    /// large), so its download goes through a resumable part.
    fn c9_big_jar(mod_id: &str, version: &str) -> Vec<u8> {
        use std::io::Write;
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("fabric.mod.json", stored).unwrap();
        zip.write_all(format!(r#"{{"id":"{mod_id}","version":"{version}"}}"#).as_bytes()).unwrap();
        zip.start_file("data.bin", stored).unwrap();
        zip.write_all(&(0..2 * C9_MIB + 7).map(|index| (index * 31 % 251) as u8).collect::<Vec<_>>()).unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn c9_only_a_refusing_answer_ends_a_resource_download_at_once() {
        let failure = |status| match crate::parts::classify(status, None, 0, 10) {
            crate::parts::Reply::Fail(message) => message,
            other => panic!("{status}: {other:?}"),
        };
        for status in [400, 403, 404, 410] {
            assert!(refused(&failure(status)), "{status}");
        }
        for status in [408, 429, 500, 503] {
            assert!(!refused(&failure(status)), "{status}");
        }
        assert!(!refused(crate::parts::STALLED) && !refused(crate::parts::RANGE_MISMATCH));
    }

    /// Downloads a Modrinth file of more than 1 MiB from `cdn` into a fresh
    /// folder with its own parts folder (`parts`), as an install does.
    fn c9_download(
        root: &Path,
        label: &str,
        bytes: &[u8],
        cdn: &RangeServer,
        reuse: Option<&crate::parts::Reuse>,
    ) -> (Result<PathBuf, String>, PathBuf) {
        let state = LauncherState::test_fixture(root.join(format!("data-{label}")), Persisted::default(), crate::storage::test_client());
        let directory = root.join(format!("next-{label}"));
        let address: std::net::SocketAddr = cdn.address.parse().unwrap();
        let client = reqwest::Client::builder().no_proxy().resolve("cdn.modrinth.com", address).build().unwrap();
        let file = ResourceFile {
            filename: "big.jar".into(),
            url: c9_url(cdn),
            primary: true,
            size: bytes.len() as u64,
            hashes: FileHashes { sha512: format!("{:x}", Sha512::digest(bytes)) },
        };
        let result = c8_runtime().block_on(download_verified_progress(&state, &file, &directory, reuse, ResourceKind::Mod, client, None));
        (result, directory)
    }

    fn c9_url(cdn: &RangeServer) -> String {
        format!("http://cdn.modrinth.com:{}/data/big.jar", port(cdn))
    }

    fn c9_bytes() -> Vec<u8> {
        (0..2 * C9_MIB + 7).map(|index| (index * 7 % 251) as u8).collect()
    }

    #[test]
    fn c9_a_large_modrinth_file_retries_only_what_a_retry_can_change() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-tests").join(uuid::Uuid::new_v4().to_string());
        let bytes = c9_bytes();
        let store = |label: &str| crate::parts::PartStore::new(root.join(format!("parts-{label}")));
        let empty = |label: &str| c9_tree(&root.join(format!("parts-{label}"))).is_empty();

        // A 404 ends at once.
        let cdn = RangeServer::new(vec![Scripted::status(404), Scripted::ranged(&bytes, "\"a\"")]);
        let (result, _) = c9_download(&root, "404", &bytes, &cdn, Some(&crate::parts::Reuse::new(store("404"))));
        assert_eq!(result.unwrap_err(), "Modrinth 资源下载失败（HTTP 404）");
        assert_eq!(cdn.count(), 1);

        // A 5xx is tried three times.
        let cdn = RangeServer::new(vec![Scripted::status(503), Scripted::status(503), Scripted::status(503), Scripted::ranged(&bytes, "\"b\"")]);
        let (result, _) = c9_download(&root, "503", &bytes, &cdn, Some(&crate::parts::Reuse::new(store("503"))));
        assert_eq!(result.unwrap_err(), "Modrinth 资源下载失败（HTTP 503）");
        assert_eq!(cdn.count(), 3);

        // Tries that continue the part are free: four cuts, then the rest.
        let cut = 300 * 1024;
        let mut script = vec![Scripted::ok(&bytes, "\"c\"").cut(cut)];
        script.extend((0..3).map(|_| Scripted::ranged(&bytes, "\"c\"").cut(cut)));
        script.push(Scripted::ranged(&bytes, "\"c\""));
        let cdn = RangeServer::new(script);
        let (result, directory) = c9_download(&root, "cuts", &bytes, &cdn, Some(&crate::parts::Reuse::new(store("cuts"))));
        assert_eq!(fs::read(result.unwrap()).unwrap(), bytes);
        assert_eq!(cdn.count(), 5);
        assert_eq!(cdn.header(4, "range").as_deref(), Some(format!("bytes={}-", 4 * cut).as_str()));
        assert_eq!(c9_tree(&directory), ["big.jar"]);
        assert!(empty("cuts"));
        // Had the stage failed, the verified file goes back to its part, complete.
        let reuse = crate::parts::Reuse::new(store("kept"));
        let cdn = RangeServer::new(vec![Scripted::ok(&bytes, "\"k\"")]);
        let (result, directory) = c9_download(&root, "kept", &bytes, &cdn, Some(&reuse));
        assert!(result.is_ok());
        reuse.restore();
        assert!(c9_tree(&directory).is_empty(), "{:?}", c9_tree(&directory));
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &format!("{:x}", Sha512::digest(&bytes)), bytes.len() as u64).unwrap();
        assert!(store("kept").open(&key, bytes.len() as u64).unwrap().unwrap().complete());

        // A declared size that disagrees with the metadata ends at once.
        let cdn = RangeServer::new(vec![Scripted::ok(&bytes[..bytes.len() - 1], "\"d\""), Scripted::ranged(&bytes, "\"d\"")]);
        let (result, _) = c9_download(&root, "size", &bytes, &cdn, Some(&crate::parts::Reuse::new(store("size"))));
        assert_eq!(result.unwrap_err(), crate::parts::SIZE_MISMATCH);
        assert_eq!(cdn.count(), 1);

        // So does a body longer than the file, and its bytes are not kept.
        let longer = [bytes.as_slice(), b"extra"].concat();
        let cdn = RangeServer::new(vec![Scripted::ok(&longer, "\"e\"").without_length(), Scripted::ranged(&bytes, "\"e\"")]);
        let (result, directory) = c9_download(&root, "overrun", &bytes, &cdn, Some(&crate::parts::Reuse::new(store("overrun"))));
        assert_eq!(result.unwrap_err(), crate::parts::OVERRUN);
        assert_eq!(cdn.count(), 1);
        assert!(empty("overrun"), "{:?}", c9_tree(&root.join("parts-overrun")));
        assert!(c9_tree(&directory).is_empty());

        // A connection the library reports in English gets the launcher's wording.
        let gone = RangeServer::new(Vec::new());
        let (result, _) = c9_download(&root, "gone", &bytes, &gone, Some(&crate::parts::Reuse::new(store("gone"))));
        let error = result.unwrap_err();
        assert!(!error.is_ascii() && error.starts_with("Modrinth "), "{error}");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn c9_the_parts_folder_of_a_game_root_is_found_from_the_live_folder_and_remembered() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-tests").join(uuid::Uuid::new_v4().to_string());
        let game = root.join("game");
        fs::create_dir_all(game.join("versions/fabric-test/mods")).unwrap();
        let state = LauncherState::test_fixture(
            root.join("data"),
            Persisted {
                config: crate::models::Config { game_directory: game.to_string_lossy().into_owned(), ..Default::default() },
                ..Default::default()
            },
            crate::storage::test_client(),
        );
        let tail = |path: &Path| path.components().rev().take(3).map(|part| part.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>();
        let store = resource_parts(&state, &game.join("versions/fabric-test/mods")).expect("inside the game root");
        assert_eq!(tail(store.root()), ["parts", ".launcher-temp", "game"]);
        // Cleaned at startup even when the game root is set elsewhere later.
        let swept: Vec<_> = crate::parts::startup_stores(&state.data_dir, None).iter().map(|store| store.root().to_path_buf()).collect();
        assert!(swept.contains(&store.root().to_path_buf()), "{swept:?}");
        // The data directory's own folder is swept anyway and is not recorded.
        let inside = resource_parts(&state, &root.join("data").join("mods")).expect("inside the data directory");
        assert_eq!(inside.root(), root.join("data").join(".launcher-temp").join("parts"));
        assert_eq!(crate::parts::startup_stores(&state.data_dir, None).len(), 3);
        let record = fs::read_to_string(root.join("data").join(".launcher-temp").join("part-folders.json")).unwrap();
        assert_eq!(serde_json::from_str::<Vec<PathBuf>>(&record).unwrap(), [store.root().to_path_buf()]);
        // Elsewhere: no part, the one-go download.
        assert!(resource_parts(&state, &root.join("elsewhere").join("mods")).is_none());
        drop(state);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn c9_a_part_that_cannot_be_had_again_ends_the_download_with_its_tries() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-tests").join(uuid::Uuid::new_v4().to_string());
        let bytes = c9_bytes();
        let size = bytes.len() as u64;
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &format!("{:x}", Sha512::digest(&bytes)), size).unwrap();
        let store = crate::parts::PartStore::new(root.join("parts"));
        // Bytes of the right length that fail the hash, as often as asked.
        let wrong: Vec<u8> = bytes.iter().map(|byte| byte ^ 0x5A).collect();
        let cdn = RangeServer::new((0..4).map(|_| Scripted::ok(&wrong, "\"g\"")).collect());
        // Once the first try threw its part away, another download takes it.
        let (taken, release) = (std::sync::mpsc::channel(), std::sync::mpsc::channel::<()>());
        let (taken_tx, taken_rx) = taken;
        let (release_tx, release_rx) = release;
        let other = {
            let (store, key, sent) = (store.clone(), key.clone(), cdn.sent.clone());
            std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + Duration::from_secs(60);
                while sent.load(std::sync::atomic::Ordering::SeqCst) < size as usize && std::time::Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(1));
                }
                while std::time::Instant::now() < deadline {
                    if let Ok(Some(part)) = store.open(&key, size) {
                        taken_tx.send(()).unwrap();
                        let _ = release_rx.recv_timeout(Duration::from_secs(60));
                        drop(part);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
            })
        };
        let (result, directory) = c9_download(&root, "taken", &bytes, &cdn, Some(&crate::parts::Reuse::new(store.clone())));
        assert!(taken_rx.recv_timeout(Duration::from_secs(1)).is_ok(), "the other download took the part");
        release_tx.send(()).unwrap();
        other.join().unwrap();
        assert_eq!(result.unwrap_err(), "资源 SHA-512 或大小校验失败，未安装该文件");
        assert_eq!(cdn.count(), 1, "no fresh round of tries after the part was taken");
        assert!(c9_tree(&directory).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn c9_a_resumed_part_that_fails_the_hash_is_thrown_away_and_downloaded_again() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-tests").join(uuid::Uuid::new_v4().to_string());
        let bytes = c9_bytes();
        let store = crate::parts::PartStore::new(root.join("parts"));
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &format!("{:x}", Sha512::digest(&bytes)), bytes.len() as u64).unwrap();
        let cdn = RangeServer::new(vec![Scripted::ranged(&bytes, "\"w\""), Scripted::ranged(&bytes, "\"w\"")]);
        // A part from this origin whose first MiB is wrong.
        let mut part = store.open(&key, bytes.len() as u64).unwrap().unwrap();
        let origin = crate::parts::origin(&reqwest::Url::parse(&c9_url(&cdn)).unwrap());
        part.restart(crate::parts::Validator { origin, etag: Some("\"w\"".into()), last_modified: None }).unwrap();
        part.append(&vec![0xAA; C9_MIB]).unwrap();
        part.sync().unwrap();
        drop(part);
        let (result, directory) = c9_download(&root, "wrong", &bytes, &cdn, Some(&crate::parts::Reuse::new(store.clone())));
        assert_eq!(fs::read(result.unwrap()).unwrap(), bytes);
        assert_eq!(cdn.header(0, "range").as_deref(), Some(format!("bytes={C9_MIB}-").as_str()), "the kept bytes were tried");
        assert_eq!(cdn.header(1, "range"), None, "then the whole file");
        assert_eq!(c9_tree(&directory), ["big.jar"]);
        assert!(c9_tree(&root.join("parts")).is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn c9_a_part_that_cannot_be_used_means_the_one_go_download() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-tests").join(uuid::Uuid::new_v4().to_string());
        let bytes = c9_bytes();
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &format!("{:x}", Sha512::digest(&bytes)), bytes.len() as u64).unwrap();
        // Held by another download: that part is left alone.
        let store = crate::parts::PartStore::new(root.join("parts"));
        let mut held = store.open(&key, bytes.len() as u64).unwrap().unwrap();
        held.restart(crate::parts::Validator { origin: "http://other.example".into(), etag: None, last_modified: None }).unwrap();
        held.append(&bytes[..1000]).unwrap();
        held.sync().unwrap();
        let cdn = RangeServer::new(vec![Scripted::ok(&bytes, "\"h\"")]);
        let (result, directory) = c9_download(&root, "held", &bytes, &cdn, Some(&crate::parts::Reuse::new(store.clone())));
        assert_eq!(fs::read(result.unwrap()).unwrap(), bytes);
        assert_eq!(cdn.header(0, "range"), None);
        assert_eq!(c9_tree(&directory), ["big.jar"], "nothing but the file in the folder");
        drop(held);
        let kept = store.open(&key, bytes.len() as u64).unwrap().unwrap();
        assert_eq!(kept.done(), 1000, "the other download's part is left as it was");
        drop(kept);
        // A parts folder that cannot be created.
        fs::write(root.join("blocker"), b"a file where the folder would be").unwrap();
        let blocked = crate::parts::PartStore::new(root.join("blocker").join("parts"));
        let cdn = RangeServer::new(vec![Scripted::ok(&bytes, "\"b\"")]);
        let (result, directory) = c9_download(&root, "blocked", &bytes, &cdn, Some(&crate::parts::Reuse::new(blocked)));
        assert_eq!(fs::read(result.unwrap()).unwrap(), bytes);
        assert_eq!(c9_tree(&directory), ["big.jar"]);
        // Another file already under that name is refused before any download.
        let directory = root.join("next-taken");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("big.jar"), b"user bytes").unwrap();
        let cdn = RangeServer::new(vec![Scripted::ok(&bytes, "\"t\"")]);
        let (result, _) = c9_download(&root, "taken", &bytes, &cdn, Some(&crate::parts::Reuse::new(store)));
        assert!(result.is_err());
        assert_eq!(cdn.count(), 0);
        assert_eq!(fs::read(directory.join("big.jar")).unwrap(), b"user bytes");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn c9_a_curseforge_update_that_fails_after_its_download_keeps_the_verified_file() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let old_bytes = c8_jar("example", "old");
        fs::write(directory.join("old.jar.disabled"), &old_bytes).unwrap();
        // The disabled name the update needs is taken by another file.
        fs::write(directory.join("new.jar.disabled"), b"another file").unwrap();
        let new_bytes = c9_big_jar("example", "new");
        let size = new_bytes.len() as u64;
        let cdn = RangeServer::new(vec![Scripted::ok(&new_bytes, "\"s\"")]);
        let current = c8_fingerprint_of(curseforge_file(19000, "old.jar", 1, &cdn, &old_bytes), &old_bytes);
        let new_file = curseforge_file(19001, "new.jar", 2, &cdn, &new_bytes);
        let api = RangeServer::new(vec![c8_fingerprint_answer(current), curseforge_project(), json(serde_json::json!({"data": new_file}))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let before = c8_snapshot(&directory);
        let update = || {
            crate::curseforge::update_one(
                &state, &directory, "1.21.1", Some("fabric"), Some("fabric"), ResourceKind::Mod, "mod", "old.jar.disabled", 19001,
            )
        };
        let error = c8_expect_error(c8_runtime().block_on(update()), "an update whose disabled name is taken");
        assert!(error.detail.as_deref().is_some_and(|detail| detail.contains("已存在同名的停用文件")), "{error:?}");
        assert_eq!(c8_snapshot(&directory), before);
        assert!(journals(&state).is_empty());
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha1, &format!("{:x}", sha1::Sha1::digest(&new_bytes)), size).unwrap();
        assert!(
            crate::parts::PartStore::new(c9_parts(&root)).open(&key, size).unwrap().unwrap().complete(),
            "the verified file went back to its part"
        );
        fs::remove_file(directory.join("new.jar.disabled")).unwrap();
        let installed = c8_runtime().block_on(update()).unwrap();
        assert_eq!(installed.file_name, "new.jar.disabled");
        assert_eq!(fs::read(directory.join("new.jar.disabled")).unwrap(), new_bytes);
        assert_eq!(cdn.count(), 1, "the file was downloaded once");
        assert!(c9_tree(&c9_parts(&root)).is_empty(), "{:?}", c9_tree(&c9_parts(&root)));
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c9_a_cancel_after_the_downloads_hands_them_back_to_their_parts() {
        let (root, state) = resource_fixture();
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("kept.jar"), b"live file").unwrap();
        let bytes = c9_bytes();
        let size = bytes.len() as u64;
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &format!("{:x}", Sha512::digest(&bytes)), size).unwrap();
        let reuse = crate::parts::Reuse::new(crate::parts::PartStore::new(c9_parts(&root)));
        let task = state.control.begin("resource", "fixture", "Fixture").unwrap();
        let (reused, shared, verified, part_key, cancelled) = (&reuse, &state, &bytes, &key, &task);
        // The downloads are in place, then the install is cancelled at the
        // check before the journal.
        let result = c8_runtime().block_on(resource_transactions::stage_commit(
            &state,
            &directory,
            "Fixture",
            Vec::new(),
            None,
            Some(&reuse),
            |next, _| async move {
                let file = next.join("big.jar");
                fs::write(&file, verified).map_err(|e| e.to_string())?;
                reused.add(part_key, size, &file);
                shared.control.cancel(cancelled);
                Ok(())
            },
        ));
        assert_eq!(result.unwrap_err(), CANCELLED);
        state.control.finish(&task, Some(CANCELLED));
        assert_eq!(c9_tree(&directory), ["kept.jar"], "the live folder is unchanged");
        assert!(journals(&state).is_empty());
        let history = directory.parent().unwrap().join(".launcher-resource-history");
        assert!(c9_tree(&history).is_empty(), "{:?}", c9_tree(&history));
        let mut part = crate::parts::PartStore::new(c9_parts(&root)).open(&key, size).unwrap().unwrap();
        assert!(part.complete(), "the verified file is a complete part");
        let mut kept = Vec::new();
        part.hash_prefix(|chunk| kept.extend_from_slice(chunk)).unwrap();
        assert_eq!(kept, bytes);
        drop(part);
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c9_a_curseforge_update_downloads_in_one_go_when_the_parts_folder_cannot_be_used() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let old_bytes = c8_jar("example", "old");
        fs::write(directory.join("old.jar"), &old_bytes).unwrap();
        // A file where the parts folder would be.
        fs::write(root.join(".launcher-temp"), b"not a folder").unwrap();
        let new_bytes = c9_big_jar("example", "new");
        let cdn = RangeServer::new(vec![Scripted::ok(&new_bytes, "\"f\"")]);
        let current = c8_fingerprint_of(curseforge_file(21000, "old.jar", 1, &cdn, &old_bytes), &old_bytes);
        let new_file = curseforge_file(21001, "new.jar", 2, &cdn, &new_bytes);
        let api = RangeServer::new(vec![c8_fingerprint_answer(current), curseforge_project(), json(serde_json::json!({"data": new_file}))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let installed = c8_runtime()
            .block_on(crate::curseforge::update_one(
                &state, &directory, "1.21.1", Some("fabric"), Some("fabric"), ResourceKind::Mod, "mod", "old.jar", 21001,
            ))
            .unwrap();
        assert_eq!(installed.file_name, "new.jar");
        assert_eq!(fs::read(directory.join("new.jar")).unwrap(), new_bytes);
        assert!(!directory.join("old.jar").exists());
        assert_eq!((cdn.count(), cdn.header(0, "range")), (1, None));
        assert_eq!(fs::read(root.join(".launcher-temp")).unwrap(), b"not a folder");
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c9_a_resumed_curseforge_part_that_fails_the_hash_is_thrown_away() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let old_bytes = c8_jar("example", "old");
        fs::write(directory.join("old.jar"), &old_bytes).unwrap();
        let new_bytes = c9_big_jar("example", "new");
        let size = new_bytes.len() as u64;
        let cdn = RangeServer::new(vec![Scripted::ranged(&new_bytes, "\"x\""), Scripted::ranged(&new_bytes, "\"x\"")]);
        let current = c8_fingerprint_of(curseforge_file(18000, "old.jar", 1, &cdn, &old_bytes), &old_bytes);
        let new_file = curseforge_file(18001, "new.jar", 2, &cdn, &new_bytes);
        let api = RangeServer::new(vec![c8_fingerprint_answer(current), curseforge_project(), json(serde_json::json!({"data": new_file}))]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha1, &format!("{:x}", sha1::Sha1::digest(&new_bytes)), size).unwrap();
        let store = crate::parts::PartStore::new(c9_parts(&root));
        let mut part = store.open(&key, size).unwrap().unwrap();
        let origin = crate::parts::origin(&reqwest::Url::parse(new_file["downloadUrl"].as_str().unwrap()).unwrap());
        part.restart(crate::parts::Validator { origin, etag: Some("\"x\"".into()), last_modified: None }).unwrap();
        part.append(&vec![0x55; C9_MIB]).unwrap();
        part.sync().unwrap();
        drop(part);
        let before = c8_snapshot(&directory);
        let update = || {
            crate::curseforge::update_one(
                &state, &directory, "1.21.1", Some("fabric"), Some("fabric"), ResourceKind::Mod, "mod", "old.jar", 18001,
            )
        };
        let error = c8_expect_error(c8_runtime().block_on(update()), "a resumed part with wrong bytes");
        assert!(error.detail.as_deref().is_some_and(|detail| detail.contains("SHA-1")), "{error:?}");
        assert_eq!(cdn.header(0, "range").as_deref(), Some(format!("bytes={C9_MIB}-").as_str()));
        assert_eq!(c8_snapshot(&directory), before);
        assert!(journals(&state).is_empty());
        assert!(c9_tree(&c9_parts(&root)).is_empty(), "the bad part is gone: {:?}", c9_tree(&c9_parts(&root)));
        let installed = c8_runtime().block_on(update()).unwrap();
        assert_eq!(cdn.header(1, "range"), None, "the next update downloads the whole file");
        assert_eq!(fs::read(directory.join(&installed.file_name)).unwrap(), new_bytes);
        drop(state);
        cleanup_fixture(root);
    }

    /// The launcher's parts folder for this fixture's game root.
    fn c9_parts(root: &Path) -> PathBuf {
        root.join(".launcher-temp").join("parts")
    }

    /// How many bytes the part for `key` (`<algo>-<hex>-<size>`) recorded.
    fn c9_recorded(root: &Path, key: &str) -> u64 {
        let text = fs::read_to_string(c9_parts(root).join(format!("{key}.json"))).expect("the part keeps its record");
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["done"].as_u64().unwrap()
    }

    /// Every file under `path`, relative, with `/` separators.
    fn c9_tree(path: &Path) -> Vec<String> {
        let mut found = Vec::new();
        let mut pending = vec![path.to_path_buf()];
        while let Some(folder) = pending.pop() {
            for entry in fs::read_dir(&folder).into_iter().flatten().flatten() {
                let entry_path = entry.path();
                if entry_path.is_dir() {
                    pending.push(entry_path);
                } else if !crate::parts::scanner_copy(&entry.file_name().to_string_lossy()) {
                    found.push(entry_path.strip_prefix(path).unwrap().to_string_lossy().replace('\\', "/"));
                }
            }
        }
        found.sort();
        found
    }

    /// Runs `work` and cancels `task` once the CDN has sent `bytes` bytes.
    fn c9_cancel_after<T>(state: &LauncherState, task: &str, cdn: &RangeServer, bytes: usize, work: impl std::future::Future<Output = T>) -> T {
        c8_runtime().block_on(async {
            let cancel = async {
                let deadline = std::time::Instant::now() + Duration::from_secs(60);
                while cdn.sent.load(std::sync::atomic::Ordering::SeqCst) < bytes && std::time::Instant::now() < deadline {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                // Let the launcher read what was sent before the cancel.
                tokio::time::sleep(Duration::from_millis(300)).await;
                state.control.cancel(task);
            };
            futures_util::future::join(work, cancel).await.0
        })
    }

    #[test]
    fn c9_a_cancelled_modrinth_install_keeps_its_part_outside_the_stage_and_the_next_install_resumes() {
        let (root, state) = resource_fixture();
        let bytes: Vec<u8> = (0..2 * C9_MIB + 7).map(|index| (index * 13 % 251) as u8).collect();
        let key = format!("sha512-{:x}-{}", sha2::Sha512::digest(&bytes), bytes.len());
        // The first answer stops after 1 MiB; the second follows the request's Range.
        let cdn = RangeServer::new(vec![Scripted::ok(&bytes, "\"r1\"").stall(C9_MIB), Scripted::ranged(&bytes, "\"r1\"")]);
        let version = modrinth_version("resumed", 1, &cdn, &bytes);
        let api = RangeServer::new(vec![
            modrinth_project(),
            json(version.clone()),
            modrinth_project(),
            json(version),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let request = modrinth_request(Some("resumed"));
        let history = mods(&state).parent().unwrap().join(".launcher-resource-history");

        let task = state.control.reserve_resource(request.clone()).unwrap();
        let error = c9_cancel_after(&state, &task, &cdn, C9_MIB, run_resource_request(&state, None, &task, request.clone()))
            .err()
            .expect("the install was cancelled");
        assert_eq!(error.code, "download.cancelled", "{error:?}");
        assert!(!mods(&state).join("resumed.jar").exists());
        assert!(journals(&state).is_empty());
        assert!(c9_tree(&history).is_empty(), "no staged copy is left: {:?}", c9_tree(&history));
        let done = c9_recorded(&root, &key);
        assert!(done > 0 && done <= C9_MIB as u64, "{done}");

        let task = state.control.reserve_resource(request.clone()).unwrap();
        let installed = run(&state, &task, request).unwrap().installed().unwrap();
        assert_eq!(installed.file_name, "resumed.jar");
        assert_eq!(fs::read(mods(&state).join("resumed.jar")).unwrap(), bytes);
        assert_eq!(cdn.header(1, "range").as_deref(), Some(format!("bytes={done}-").as_str()), "the second install resumes");
        assert_eq!(cdn.header(1, "if-range").as_deref(), Some("\"r1\""), "only if the file is unchanged");
        assert_eq!(
            cdn.sent.load(std::sync::atomic::Ordering::SeqCst),
            C9_MIB + bytes.len() - done as usize,
            "only the missing bytes are sent again"
        );
        let journals = journals(&state);
        assert_eq!(journals.len(), 1);
        assert!(!journals[0].contains(".part") && !journals[0].contains(".json"), "{}", journals[0]);
        assert!(c9_tree(&c9_parts(&root)).is_empty(), "the published part leaves nothing behind: {:?}", c9_tree(&c9_parts(&root)));
        drop(state);
        cleanup_fixture(root);
    }

    #[test]
    fn c9_a_cancelled_curseforge_update_keeps_its_part_and_the_next_update_resumes() {
        let (root, state) = resource_fixture();
        save_curseforge_key(&state);
        let directory = mods(&state);
        fs::create_dir_all(&directory).unwrap();
        let old_bytes = c8_jar("example", "old");
        let copy_bytes = c8_jar("example", "2");
        fs::write(directory.join("old.jar"), &old_bytes).unwrap();
        fs::write(directory.join("example-2.jar"), &copy_bytes).unwrap();
        let new_bytes = c9_big_jar("example", "new");
        let key = format!("sha1-{:x}-{}", sha1::Sha1::digest(&new_bytes), new_bytes.len());
        let cdn = RangeServer::new(vec![Scripted::ok(&new_bytes, "\"c1\"").stall(C9_MIB), Scripted::ranged(&new_bytes, "\"c1\"")]);
        let current = c8_fingerprint_of(curseforge_file(17000, "old.jar", 1, &cdn, &old_bytes), &old_bytes);
        let new_file = curseforge_file(17001, "new.jar", 2, &cdn, &new_bytes);
        // The second update is answered from the 5-minute answer cache.
        let api = RangeServer::new(vec![
            c8_fingerprint_answer(current),
            curseforge_project(),
            json(serde_json::json!({"data": new_file})),
        ]);
        let _endpoints = Endpoints::set(&state, &api, &cdn);
        let before = c8_snapshot(&directory);
        let update = || {
            crate::curseforge::update_one(
                &state, &directory, "1.21.1", Some("fabric"), Some("fabric"), ResourceKind::Mod, "mod", "old.jar", 17001,
            )
        };

        let task = state.control.begin("resource-update", "old.jar", "更新资源及必需前置").unwrap();
        let error = c8_expect_error(c9_cancel_after(&state, &task, &cdn, C9_MIB, update()), "a cancelled update");
        state.control.finish(&task, Some(CANCELLED));
        assert_eq!(error.code, "download.cancelled", "{error:?}");
        assert_eq!(c8_snapshot(&directory), before, "the folder is unchanged");
        assert!(journals(&state).is_empty());
        let done = c9_recorded(&root, &key);
        assert!(done > 0 && done <= C9_MIB as u64, "{done}");

        let task = state.control.begin("resource-update", "old.jar", "更新资源及必需前置").unwrap();
        let installed = c8_runtime().block_on(update()).unwrap();
        state.control.finish(&task, None);
        assert_eq!(installed.file_name, "new.jar");
        assert_eq!(cdn.header(1, "range").as_deref(), Some(format!("bytes={done}-").as_str()), "the second update resumes");
        assert_eq!(cdn.header(1, "if-range").as_deref(), Some("\"c1\""), "only if the file is unchanged");
        assert_eq!(cdn.sent.load(std::sync::atomic::Ordering::SeqCst), C9_MIB + new_bytes.len() - done as usize);
        // The resumed file still goes through the duplicate rules: the other copy is set aside.
        let names: Vec<_> = c8_snapshot(&directory).into_iter().map(|(name, _)| name).collect();
        assert_eq!(names, ["new.jar"]);
        assert_eq!(fs::read(directory.join("new.jar")).unwrap(), new_bytes);
        assert!(installed.warning.as_deref().is_some_and(|warning| warning.contains("example-2.jar")), "{:?}", installed.warning);
        assert_eq!(journals(&state).len(), 1);
        assert!(c9_tree(&c9_parts(&root)).is_empty(), "{:?}", c9_tree(&c9_parts(&root)));
        let rolled_back = resource_transactions::rollback(&directory, installed.update_id.as_deref().unwrap()).unwrap();
        assert_eq!(rolled_back.status, "rolledBack");
        assert_eq!(c8_snapshot(&directory), before, "rollback restores both old files");
        drop(state);
        cleanup_fixture(root);
    }
}

#[cfg(test)]
mod c9_wiring {
    /// A staged resource file is moved in without replacing anything, and the
    /// part comes from outside the staged copy.
    #[test]
    fn c9_resource_parts_live_outside_the_stage_and_publish_without_replacing() {
        let resources = crate::storage::executable_source(include_str!("resources.rs"));
        let curseforge = crate::storage::executable_source(include_str!("curseforge.rs"));
        let transactions = crate::storage::executable_source(include_str!("resource_transactions.rs"));
        let body = |source: &str, marker: &str| -> String {
            let text = source.split_once(marker).unwrap_or_else(|| panic!("{marker}")).1.split_once("\n}").unwrap().0;
            text.chars().filter(|c| !c.is_whitespace()).collect()
        };
        let modrinth = body(&resources, "async fn download_verified_progress(");
        assert!(!modrinth.contains("part.publish(&"), "a Modrinth file never replaces what is in the stage");
        assert!(modrinth.contains("download_resumable(state,file,&url,directory,&expected,parts,key,&client,progress)"));
        assert!(body(&resources, "async fn download_resumable(").contains("crate::parts::publish_new_off_task("));
        let install = body(&transactions, "pub(super) async fn install(");
        assert!(install.contains("resource_parts(state,directory)"), "the parts folder is found from the live folder, not next/");
        let download = body(&curseforge, "async fn download(");
        assert!(download.contains("if!download_part(state,&client,&url,file,&expected,reuse,&temporary).await?{"));
        let part = body(&curseforge, "async fn download_part(");
        assert!(part.contains("crate::parts::publish_new_off_task(part,temporary)"), "the part never replaces a file");
        let replace = body(&curseforge, "async fn replace_with_file(");
        assert!(replace.contains("crate::resources::resource_parts(state,directory)"), "found from the live folder, not next/");
    }
}

#[cfg(test)]
mod c8_wiring {
    #[test]
    fn c8_curseforge_installs_and_updates_go_through_the_journaled_replace() {
        let resources = crate::storage::executable_source(include_str!("resources.rs"));
        let curseforge = crate::storage::executable_source(include_str!("curseforge.rs"));
        let body = |source: &str, marker: &str| -> String {
            source.split_once(marker).unwrap_or_else(|| panic!("{marker}")).1.split_once("
}").unwrap().0.to_owned()
        };
        // The update check runs CurseForge after Modrinth, skipping what Modrinth identified.
        let check = body(&resources, "pub async fn check_resource_updates(");
        let modrinth = check.find("resource_transactions::updates(").unwrap();
        let curse = check.find("crate::curseforge::curseforge_updates(").unwrap();
        assert!(modrinth < curse && check[curse..].contains("&identified,"));
        assert!(check.contains("curseforge_part("), "a CurseForge failure keeps the Modrinth rows");
        // A cancel is checked after CurseForge answered, before its failure becomes a notice.
        let guard = check.find("state.control.checkpoint().await.map_err(expected)?").unwrap();
        assert!(curse < guard && guard < check.find("curseforge_part(curseforge)").unwrap());
        // Installing into an instance and updating both use the staged, journaled replace.
        let install = body(&curseforge, "pub(crate) async fn install_curseforge(");
        assert!(install.contains("replace_with_file(state, &directory, kind, &project.data, &file, None, true)"));
        assert!(!install.contains("download(state"), "no direct write into the live folder");
        let update = body(&curseforge, "pub(crate) async fn update_one(");
        assert!(update.find("identify(&client, &key, &locals)").unwrap() < update.find("get_pinned_file(").unwrap());
        assert!(update.trim_end().ends_with("Ok(replace_with_file(state, directory, kind, &project, &file, Some(file_name), enabled).await?)"));
        let replace = body(&curseforge, "async fn replace_with_file(");
        assert!(replace.find("require_no_pending(directory)").unwrap() < replace.find("stage_commit(").unwrap());
        assert!(replace.contains("download(state, project, file, &next, kind, duplicates, reuse)"), "writes only into the staged copy");
        assert!(replace.contains("if enabled { Duplicates::SetAside(&aside) } else { Duplicates::Keep }"), "a disabled update leaves enabled copies alone");
    }

    /// Every CurseForge request made inside a task is raced against its cancel
    /// (requests outside a task, such as searches, must not be).
    #[test]
    fn c8_every_curseforge_request_in_a_task_can_be_cancelled() {
        let curseforge = crate::storage::executable_source(include_str!("curseforge.rs"));
        let body = |marker: &str| -> String {
            let text = curseforge.split_once(marker).unwrap_or_else(|| panic!("{marker}")).1.split_once("\n}").unwrap().0;
            text.chars().filter(|c| !c.is_whitespace()).collect()
        };
        for marker in [
            "async fn check_dependencies(",
            "pub(crate) async fn install_curseforge(",
            "pub(crate) async fn create_with_pinned_file(",
            "async fn projects(",
            "async fn newest_release(",
            "pub(crate) async fn curseforge_updates(",
            "pub(crate) async fn update_one(",
        ] {
            let text = body(marker);
            let mut calls = 0;
            for call in ["api(", "api_post(", "files_page(", "identify(", "get_pinned_file("] {
                for (at, _) in text.match_indices(call) {
                    if text[..at].chars().last().is_some_and(|c| c.is_alphanumeric() || c == '_') {
                        continue;
                    }
                    calls += 1;
                    assert!(
                        text[..at].ends_with("in_task(state,") || text[..at].ends_with("during_cancellable_io("),
                        "{marker} calls {call} outside in_task"
                    );
                }
            }
            assert!(calls > 0, "{marker} makes CurseForge requests");
        }
        let download = body("async fn download(");
        assert!(download.contains("during_cancellable_io(client.get(url).send())"));
        assert!(download.contains("whileletSome(chunk)=state.control.during_cancellable_io(stream.next()).await?"));
        // Searches and details are not tasks.
        for marker in ["pub async fn search_curseforge(", "pub async fn get_curseforge_project_details("] {
            assert!(!body(marker).contains("in_task("), "{marker}");
        }
    }
}

#[cfg(test)]
mod local_metadata_regression {
    use super::*;
    use std::io::Write;
    fn with_jar(entries: &[(&str, &[u8])], verify: impl FnOnce(&Path, serde_json::Value)) {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/core-tests")
            .join(format!("vx-mod-metadata-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(folder.join("mods")).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(folder.clone());
        let path = folder.join("mods/fixture.jar");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (name, contents) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(contents).unwrap();
        }
        zip.finish().unwrap();
        let file = local_resource(path.clone(), ResourceKind::Mod).unwrap().unwrap();
        verify(&path, serde_json::to_value(file).unwrap());
    }

    #[test]
    fn local_mod_metadata_exposes_fabric_name_version_authors_and_safe_icon_reference() {
        with_jar(&[("fabric.mod.json", br#"{"id":"visible","name":"Visible Name","version":"3.1","authors":["Alice",{"name":"Bob"}],"icon":{"16":"assets/16.png","32":"assets/32.png"},"depends":{"minecraft":"*","fixture-api":">=1"}}"#)], |_, value| {
            assert_eq!(value["metadata"]["name"], "Visible Name");
            assert_eq!(value["metadata"]["version"], "3.1");
            assert_eq!(value["metadata"]["authors"], serde_json::json!(["Alice", "Bob"]));
            assert_eq!(value["metadata"]["dependencies"].as_array().unwrap().len(), 1);
            assert_eq!(value["metadata"]["dependencies"][0]["id"], "fixture-api");
            assert_eq!(value["metadata"]["hasIcon"], true);
            assert!(value["metadata"].get("icon").is_none());
        });
    }

    #[cfg(windows)]
    #[test]
    fn c6_metadata_is_retried_after_a_locked_jar_is_released() {
        use std::os::windows::fs::OpenOptionsExt;
        with_jar(&[("fabric.mod.json", br#"{"id":"locked","name":"Locked"}"#)], |path, _| {
            // A fresh copy so the earlier listing has not cached it.
            let copy = path.with_file_name("locked-copy.jar");
            fs::copy(path, &copy).unwrap();
            let stat = fs::symlink_metadata(&copy).unwrap();
            let lock = fs::OpenOptions::new().read(true).share_mode(0).open(&copy).unwrap();
            assert!(crate::mod_metadata::cached_metadata(&copy, &stat).is_none());
            drop(lock);
            let unchanged = fs::symlink_metadata(&copy).unwrap();
            assert_eq!((unchanged.len(), unchanged.modified().unwrap()), (stat.len(), stat.modified().unwrap()));
            assert!(crate::mod_metadata::cached_metadata(&copy, &unchanged).is_some(),
                "a released JAR must be read again");
        });
    }

    #[test]
    fn local_mod_metadata_supports_quilt_and_both_legacy_shapes() {
        with_jar(&[("quilt.mod.json", br#"{"quilt_loader":{"id":"quilt-demo","version":"4","metadata":{"name":"Quilt Demo","contributors":{"Ana":"Owner"}},"depends":["fixture-a",{"id":"fixture-b","versions":["1","2"],"optional":true}]}}"#)], |_, value| {
            assert_eq!(value["metadata"]["loader"], "quilt");
            assert_eq!(value["metadata"]["name"], "Quilt Demo");
            assert_eq!(value["metadata"]["dependencies"][1]["kind"], "optional");
        });
        for json in [r#"[{"modid":"demo","name":"Legacy"}]"#, r#"{"modListVersion":2,"modList":[{"modid":"demo","name":"Legacy"}]}"#] {
            with_jar(&[("mcmod.info", json.as_bytes())], |_, value| {
                assert_eq!(value["metadata"]["loader"], "legacyForge");
                assert_eq!(value["metadata"]["name"], "Legacy");
            });
        }
    }

    #[test]
    fn c6_jar_version_placeholder_reads_only_the_main_manifest_section() {
        let forge = b"[[mods]]\nmodId='demo'\nversion='${file.jarVersion}'\n";
        let manifest = b"Manifest-Version: 1.0\r\nimplementation-version: 4.\r\n 2\r\n\r\nName: inner/\r\nImplementation-Version: 9\r\n";
        with_jar(&[("META-INF/mods.toml", forge), ("META-INF/MANIFEST.MF", manifest)], |_, value| {
            assert_eq!(value["metadata"]["version"], "4.2");
        });
        let entry_only = b"Manifest-Version: 1.0\r\n\r\nName: inner/\r\nImplementation-Version: 9\r\n";
        with_jar(&[("META-INF/mods.toml", forge), ("META-INF/MANIFEST.MF", entry_only)], |_, value| {
            assert_ne!(value["metadata"]["version"], "9", "an entry section's version is not the mod version");
        });
    }

    #[test]
    fn local_mod_metadata_reads_forge_and_neoforge_toml_without_a_dependency() {
        let forge = ["[[mods]]", "modId='demo'", "version='${file.jarVersion}'", "displayName = 'Demo'", "description='''First", "Second'''", "authors=[\"Ana, Jr.\", 'Bob#',] # comment", "[[mods]]", "modId='other'", "[[dependencies.demo]]", "modId='fixture-a'", "mandatory=true", "versionRange='[1,2)'", "[[dependencies.demo]]", "modId='fixture-b'", "mandatory=false"].join("\n");
        let manifest = b"Manifest-Version: 1.0\r\nImplementation-Version: 3.5\r\n";
        with_jar(&[("META-INF/mods.toml", forge.as_bytes()), ("META-INF/MANIFEST.MF", manifest)], |_, value| {
            let meta = &value["metadata"];
            assert_eq!(meta["version"], "3.5");
            assert_eq!(meta["description"], "First\nSecond");
            assert_eq!(meta["authors"], serde_json::json!(["Ana, Jr.", "Bob#"]));
            assert_eq!(meta["additionalMods"], 1);
            assert_eq!(meta["dependencies"][0]["kind"], "required");
            assert_eq!(meta["dependencies"][1]["kind"], "optional");
        });
        let neo = b"[[mods]]\nmodId='demo'\n[[dependencies.demo]]\nmodId='fixture-a'\ntype='required'\n";
        with_jar(&[("META-INF/neoforge.mods.toml", neo)], |_, value| {
            assert_eq!(value["metadata"]["loader"], "neoforge");
            assert_eq!(value["metadata"]["dependencies"][0]["kind"], "required");
        });
    }

    #[test]
    fn local_mod_metadata_keeps_file_rows_when_metadata_is_unusable() {
        let oversized = vec![b' '; 256 * 1024 + 1];
        for bytes in [b"incomplete json".as_slice(), oversized.as_slice()] {
            with_jar(&[("fabric.mod.json", bytes)], |_, value| {
                assert_eq!(value["name"], "fixture.jar");
                assert!(value.get("metadata").is_none());
            });
        }
        with_jar(&[("fabric.mod.json", br#"{"id":"demo","icon":"../x.png"}"#)], |_, value| {
            assert_eq!(value["metadata"]["hasIcon"], false);
        });
    }

    #[test]
    fn local_mod_icon_uses_only_the_selected_game_root_and_a_safe_jar_basename() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW9sAAAAASUVORK5CYII=";
        let image = STANDARD.decode(png).unwrap();
        with_jar(&[("fabric.mod.json", br#"{"id":"demo","icon":"assets/icon.png"}"#), ("assets/icon.png", &image)], |path, value| {
            let parent = path.parent().unwrap();
            let mut data = Persisted::default();
            data.config.game_directory = parent.parent().unwrap().to_string_lossy().into_owned();
            data.config.version_isolation = false;
            assert!(value["metadata"].get("icon").is_none());
            let read = |name| read_local_mod_icon_blocking(&data, "1.21.1", None, name);
            let expected_png = format!("data:image/png;base64,{png}");
            assert_eq!(read("fixture.jar").unwrap().as_deref(), Some(expected_png.as_str()));
            assert!(read("fixture.zip").unwrap().is_none());
            assert!(read("missing.jar").unwrap().is_none());
            assert!(read("../fixture.jar").is_err());
            assert!(read("C:\\fixture.jar").is_err());
            assert!(read("fixture.jar:stream").is_err());
            assert!(read_local_mod_icon_blocking(&data, "1.21.1", Some("unknown"), "fixture.jar").is_err());
            let disabled = parent.join("fixture.jar.disabled");
            fs::copy(path, &disabled).unwrap();
            assert_eq!(read("fixture.jar.disabled").unwrap().as_deref(), Some(expected_png.as_str()));
            let outside = parent.parent().unwrap().join("outside.jar");
            fs::copy(path, &outside).unwrap();
            let linked = parent.join("linked.jar");
            #[cfg(unix)]
            let made_link = std::os::unix::fs::symlink(&outside, &linked);
            #[cfg(windows)]
            let made_link = std::os::windows::fs::symlink_file(&outside, &linked);
            #[cfg(any(unix, windows))]
            if made_link.is_ok() {
                assert!(read("linked.jar").is_err());
            }
        });
    }

    #[test]
    fn local_mod_icon_keeps_archive_limits_and_requires_a_bounded_png_header() {
        let metadata = br#"{"id":"demo","icon":"icon.png"}"#;
        let oversized_bytes = vec![0; 512 * 1024 + 1];
        let mut oversized_dimension = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        oversized_dimension.extend(1025_u32.to_be_bytes());
        oversized_dimension.extend(1_u32.to_be_bytes());
        for bad in [b"not a PNG".as_slice(), oversized_bytes.as_slice(), oversized_dimension.as_slice()] {
            with_jar(&[("fabric.mod.json", metadata), ("icon.png", bad)], |path, value| {
                assert_eq!(value["metadata"]["modId"], "demo");
                assert!(crate::mod_metadata::read_icon(path).is_none());
            });
        }
        with_jar(&[("fabric.mod.json", metadata), ("icon.png", b"not a PNG"), ("../outside.txt", b"outside")], |path, value| {
            assert_eq!(value["name"], "fixture.jar");
            assert!(value.get("metadata").is_none());
            assert!(crate::mod_metadata::read_icon(path).is_none());
        });
    }

    fn padded(bytes: &[u8], fill: u8, length: usize) -> Vec<u8> {
        let mut value = bytes.to_vec();
        value.resize(length, fill);
        value
    }

    #[test]
    fn c6_metadata_limit_is_isolated_with_valid_json() {
        let limit = 256 * 1024;
        let at_limit = padded(br#"{"id":"demo"}"#, b' ', limit);
        with_jar(&[("fabric.mod.json", &at_limit)], |_, value| {
            assert_eq!(value["metadata"]["modId"], "demo", "valid JSON of exactly 256 KiB is read");
        });
        let over = padded(br#"{"id":"demo"}"#, b' ', limit + 1);
        with_jar(&[("fabric.mod.json", &over)], |_, value| {
            assert_eq!(value["name"], "fixture.jar");
            assert!(value.get("metadata").is_none(), "one byte over the limit is not read");
        });
    }

    #[test]
    fn c6_icon_limit_is_isolated_with_valid_png() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let png = STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW9sAAAAASUVORK5CYII=")
            .unwrap();
        let metadata = br#"{"id":"demo","icon":"icon.png"}"#;
        let limit = 512 * 1024;
        let at_limit = padded(&png, 0, limit);
        with_jar(&[("fabric.mod.json", metadata), ("icon.png", &at_limit)], |path, _| {
            assert!(crate::mod_metadata::read_icon(path).is_some(), "a valid PNG of exactly 512 KiB is read");
        });
        let over = padded(&png, 0, limit + 1);
        with_jar(&[("fabric.mod.json", metadata), ("icon.png", &over)], |path, value| {
            assert_eq!(value["metadata"]["modId"], "demo");
            assert!(crate::mod_metadata::read_icon(path).is_none(), "one byte over the limit is not read");
        });
    }

    #[test]
    fn c6_corrupt_jar_is_still_listed_without_metadata() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/core-tests")
            .join(format!("vx-corrupt-jar-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        let path = folder.join("broken.jar");
        fs::write(&path, b"this is not a zip archive").unwrap();
        let listed = local_resource(path.clone(), ResourceKind::Mod);
        let _ = fs::remove_dir_all(&folder);
        let value = serde_json::to_value(listed.unwrap().unwrap()).unwrap();
        assert_eq!(value["name"], "broken.jar");
        assert!(value.get("metadata").is_none());
    }
}
