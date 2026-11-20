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
        .get(format!("{API}/{endpoint}"))
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

async fn download_verified_progress(
    state: &LauncherState,
    file: &ResourceFile,
    directory: &Path,
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
            part.publish(&checked).map_err(|_| "无法将已校验资源移入目标目录")?;
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

fn context_for_version(root: &Path, version_id: &str) -> AppResult<(String, Option<String>)> {
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
pub fn get_resource_context(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> AppResult<ResourceContext> {
    resource_context(&state, &version_id, instance_id.as_deref())
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

pub(crate) fn require_resource_stopped(
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

fn validate_resource_request(request: &ResourceRequest) -> AppResult<()> {
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

pub(crate) async fn create_resource_instance_then_install<F, Fut>(
    state: &LauncherState,
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
    if source == "curseforge" && resource_version_id.is_none() {
        let file_id = file_id.ok_or_else(|| expected("请选择要安装的 CurseForge 文件"))?;
        return crate::curseforge::create_with_pinned_file(state.inner(), &app, &task_id, &project_id, &resource_type, file_id, &game_version, &loader, loader_version.as_deref(), &name).await;
    }
    require_modrinth(&source)?;
    if file_id.is_some() { return Err(expected("资源文件标识无效")); }
    let request = ResourceRequest {
        source: ResourceSource::Modrinth, project_id: project_id.clone(), resource_type: resource_type.clone(),
        target: ReservedTarget::Create { game_version: game_version.clone(), loader: loader.clone(),
            loader_version: loader_version.clone(), name: name.clone(), file_id: None, resource_version_id: resource_version_id.clone() },
    };
    with_reserved_resource_task(&state, &task_id, request, async {
        let kind = ResourceKind::parse(&resource_type)?;
        let name = crate::commands::validate_instance_name(&name)?;
        let progress = ResourceProgress::new(Some(&app), &game_version);
        progress.stage(&state, "resource-preflight", "检查资源及必需前置");
        let api = client(&state, false)?;
        let project: Project = api_json(&api, &format!("project/{project_id}"), &[]).await?;
        if project.project_type != kind.project_type() {
            return Err(expected("资源项目类型与所选分类不一致，已拒绝安装"));
        }
        let resource_loader = (kind == ResourceKind::Mod).then_some(loader.as_str());
        let selected = if let Some(id) = resource_version_id.as_deref() {
            let selected = fetch_pinned_modrinth_version(&api, id, &project.id, kind).await?;
            crate::resource_targets::validate_pinned_creation_pair(
                &version_lite(&selected), kind, &loader, &game_version,
            )?;
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
            selected
        };
        resource_transactions::preflight(
            &state,
            &api,
            selected.clone(),
            &game_version,
            resource_loader,
            kind,
        )
        .await?;
        state.control.checkpoint().await?;
        progress.stage(&state, "resource-loader", "安装 Minecraft 及加载器");
        let version_id = if loader == "vanilla" {
            crate::minecraft::install(&state, &app, &game_version).await?;
            game_version.clone()
        } else {
            crate::loaders::install_loader_inner(
                &state,
                &app,
                &loader,
                &game_version,
                loader_version.as_deref().unwrap_or("latest"),
            )
            .await?
            .version_id
        };
        progress.stage(&state, "resource-create", "创建实例");
        let install_state = state.inner().clone();
        let install_app = app.clone();
        create_resource_instance_then_install(
            &state,
            name.clone(),
            version_id.clone(),
            move |instance| async move {
                require_resource_stopped(&install_state, &version_id, Some(&instance.id))?;
                let target =
                    resource_target(&install_state, &version_id, Some(&instance.id), kind)?;
                let resource_progress = ResourceProgress::new(Some(&install_app), &version_id);
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
        source: ResourceSource::Modrinth, project_id: project_id.clone(), resource_type: resource_type.clone(),
        target: ReservedTarget::Existing { version_id: version_id.clone(), instance_id: instance_id.clone(), file_id: None, resource_version_id: resource_version_id.clone(), },
    };
    with_reserved_resource_task(&state, &task_id, request, async {
        let kind = ResourceKind::parse(&resource_type)?;
        require_resource_stopped(&state, &version_id, instance_id.as_deref())?;
        let progress = ResourceProgress::new(Some(&app), &version_id);
        progress.stage(&state, "resource-plan", "检查资源安装位置");
        let target = resource_target(&state, &version_id, instance_id.as_deref(), kind)?;
        let api = client(&state, false)?;
        let project: Project = api_json(&api, &format!("project/{project_id}"), &[]).await?;
        if project.project_type != kind.project_type() {
            return Err("资源项目类型与所选分类不一致，已拒绝安装".into());
        }
        let version = select_modrinth_install_version(
            &api, &project.id, kind, &target.minecraft, target.loader.as_deref(), resource_version_id.as_deref(),
        ).await?;
        let result = resource_transactions::install(
            state.inner(),
            &target.directory,
            &target.minecraft,
            target.loader.as_deref(),
            &project.title,
            version,
            kind,
            true,
            Some(&progress),
        ).await?;
        progress.emit(&state, "complete", 1, 1, 0, 0, "资源安装完成");
        Ok(result)
    }).await
}

#[tauri::command]
pub async fn check_resource_updates(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
) -> AppResult<Vec<resource_transactions::ResourceUpdate>> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    let task = state
        .control
        .begin("resource-check", &version_id, "检查 Modrinth 资源更新")?;
    let result: AppResult<Vec<resource_transactions::ResourceUpdate>> = async {
        let target = resource_target(&state, &version_id, instance_id.as_deref(), kind)?;
        resource_transactions::updates(
            &state,
            &target.directory,
            &target.minecraft,
            target.loader.as_deref(),
            kind,
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
pub async fn update_resource(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    file_name: String,
    new_version_id: String,
) -> AppResult<ResourceInstall> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    require_resource_stopped(&state, &version_id, instance_id.as_deref())?;
    let task = state
        .control
        .begin("resource-update", &file_name, "更新资源及必需前置")?;
    let result: AppResult<ResourceInstall> = async {
        let target = resource_target(&state, &version_id, instance_id.as_deref(), kind)?;
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
        // Enabling or disabling is a write to the game directory (2026-11-20 ruling C3-2).
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
        ordered(&section(mr, "pub async fn create_instance_for_resource("), &[
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
            "state.control.checkpoint().await", "create_instance_inner(",
            "state.control.checkpoint().await", "install(instance.clone()).await",
        ]);
    }


    #[test]
    fn a4_resource_writers_take_the_operation_lock_and_check_running_before_the_writer() {
        let modrinth = include_str!("resources.rs");
        let curseforge = include_str!("curseforge.rs");
        // Extend this table in C6 if installing an exact version adds a separate writer.
        const LOCK: &str = "let _operation = state.operation.lock().await;";
        for (source, command, lock, writer) in [
            (modrinth, "install_resource", "with_reserved_resource_task(", "resource_transactions::install("),
            (modrinth, "update_resource", LOCK, "resource_transactions::update_one("),
            (modrinth, "rollback_resource_update", LOCK, "resource_transactions::rollback("),
            (modrinth, "toggle_resource", LOCK, "fs::rename(&source, &target)"),
            (curseforge, "install_curseforge_resource", "with_reserved_resource_task(", "let key = service_key("),
        ] {
            let (_, body) = source.split_once(&format!("pub async fn {command}(")).unwrap();
            let (body, _) = body.split_once("\n}").unwrap();
            let body = &crate::storage::executable_source(body);
            let lock = body.find(lock).expect(command);
            let guard = body
                .find("require_resource_stopped(&state, &version_id, instance_id.as_deref())?;")
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
        let (_, body) = include_str!("resources.rs").split_once("pub async fn install_resource(").unwrap();
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
                &state, &file, &directory, ResourceKind::Mod, client, None,
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
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
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
