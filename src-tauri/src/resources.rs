//! Modrinth installation and resource management share the launcher's game directory rules.
use crate::{
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
    fn new(app: Option<&AppHandle>, version_id: &str) -> Self {
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
        let event = serde_json::json!({
            "operation": "resource", "versionId": self.version_id, "stage": stage,
            "completed": completed, "total": total, "bytesCompleted": bytes_completed,
            "bytesTotal": bytes_total, "message": message,
        });
        state.control.record(&event);
        if let Some(app) = &self.app {
            let _ = app.emit("launcher://progress", &event);
            let _ = app.emit("launcher://tasks", state.control.list());
        }
    }

    fn stage(&self, state: &LauncherState, stage: &str, message: &str) {
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

fn linked(metadata: &fs::Metadata) -> bool {
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

fn client(download: bool) -> Result<reqwest::Client, String> {
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
    reqwest::Client::builder()
        .user_agent(concat!(
            "VoxelightLauncher/",
            env!("CARGO_PKG_VERSION"),
            " (Tauri desktop)"
        ))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(if download { 600 } else { 60 }))
        .redirect(redirects)
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
        .map_err(|_| "无法连接 Modrinth，请检查网络后重试")?;
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
    let api = client(false).map_err(expected)?;
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

fn detect_loader(json: &Value) -> Option<&'static str> {
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

fn enabled_mod_hashes(directory: &Path) -> Result<HashSet<String>, String> {
    if !directory.exists() {
        return Ok(HashSet::new());
    }
    let mut hashes = HashSet::new();
    for entry in fs::read_dir(directory).map_err(|_| "无法读取本地模组目录")? {
        let entry = entry.map_err(|_| "无法读取本地模组文件")?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| "无法读取模组文件信息")?;
        if !metadata.is_file() || linked(&metadata) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if ResourceKind::Mod.accepts(&name) {
            hashes.insert(file_sha512(&entry.path())?);
        }
    }
    Ok(hashes)
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
            let mut output = tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp)
                .await
                .map_err(|_| "无法创建资源临时文件")?;
            let response = client.get(url.clone()).send().await.map_err(|_| {
                DownloadAttemptError::Retry("下载 Modrinth 资源失败，请重试".into())
            })?;
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
            while let Some(chunk) = stream.next().await {
                state.control.checkpoint().await?;
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
                output
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
            output.flush().await.map_err(|_| "写入资源文件失败")?;
            output.sync_all().await.map_err(|_| "无法保存资源文件")?;
            drop(output);
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
            tokio::fs::rename(&temp, &checked)
                .await
                .map_err(|_| "无法将已校验资源移入目标目录")?;
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
            Err(DownloadAttemptError::Fatal(error)) => {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(error);
            }
            Err(DownloadAttemptError::Retry(error)) => {
                let _ = tokio::fs::remove_file(&temp).await;
                state.control.checkpoint().await?;
                last_error = error;
                if attempt < 2 {
                    tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
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
    let root = Path::new(&data.config.game_directory);
    reject_links(root)?;
    let (minecraft, detected_loader) = context_for_version(root, version_id)?;
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
    let (game_version, loader) =
        context_for_version(Path::new(&data.config.game_directory), version_id)?;
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

fn same_directory(a: &Path, b: &Path) -> bool {
    let a = a.canonicalize().unwrap_or_else(|_| a.to_owned());
    let b = b.canonicalize().unwrap_or_else(|_| b.to_owned());
    #[cfg(windows)]
    {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
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
    let directory = crate::minecraft::game_directory(&data.config, version_id, instance).ok();
    running.iter().any(|game| {
        (instance_id.is_some() && game.instance_id.as_deref() == instance_id)
            || directory
                .as_ref()
                .is_some_and(|directory| same_directory(directory, Path::new(&game.game_directory)))
    })
}

pub(crate) fn require_resource_stopped(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
) -> AppResult<()> {
    if target_running(
        &state.snapshot()?,
        version_id,
        instance_id,
        &state.games.snapshot()?,
    ) {
        return Err(AppError::new("instance.running")
            .with_detail("此目标的游戏仍在运行，请先退出游戏再安装资源。"));
    }
    Ok(())
}

fn target_candidates(
    state: &LauncherState,
) -> AppResult<Vec<crate::resource_targets::TargetCandidate>> {
    let data = state.snapshot()?;
    let running = state.games.snapshot()?;
    let root = Path::new(&data.config.game_directory);
    let mut candidates = Vec::new();
    for instance in &data.instances {
        let context = version_context(root, &instance.version_id).ok();
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
    for version in crate::minecraft::scan_versions(&data.config) {
        let context = version_context(root, &version.id).ok();
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
) -> AppResult<crate::resource_targets::ResourceTargetPlan> {
    require_modrinth(&source)?;
    let kind = ResourceKind::parse(&resource_type)?;
    identifier(&project_id)?;
    let api = client(false)?;
    let project: Project = api_json(&api, &format!("project/{project_id}"), &[]).await?;
    if project.project_type != kind.project_type() {
        return Err(expected("资源项目类型与所选分类不一致，已拒绝安装"));
    }
    let versions = all_project_versions(&api, &project.id).await?;
    let metadata: Vec<_> = versions.iter().map(version_lite).collect();
    let manifest = crate::minecraft::manifest(&state)
        .await
        .map_err(|error| AppError::new("resource.manifestUnavailable").with_detail(error))?;
    let manifest = manifest["versions"]
        .as_array()
        .ok_or_else(|| {
            AppError::new("resource.manifestUnavailable").with_detail("官方 Minecraft 版本列表为空")
        })?
        .iter()
        .filter_map(|version| {
            Some((
                version["id"].as_str()?.to_owned(),
                version["type"].as_str()?.to_owned(),
            ))
        })
        .collect::<Vec<_>>();
    Ok(crate::resource_targets::build_plan(
        &project.id,
        &project.title,
        &project.project_type,
        kind,
        &target_candidates(&state)?,
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

fn finish_resource_task(
    app: Option<&AppHandle>,
    state: &LauncherState,
    task: &str,
    error: Option<&AppError>,
) {
    state.control.finish(
        task,
        error.map(|error| error.detail.as_deref().unwrap_or(&error.code)),
    );
    if let Some(app) = app {
        let _ = app.emit("launcher://tasks", state.control.list());
    }
}

async fn create_resource_instance_then_install<F, Fut>(
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
    game_version: String,
    loader: String,
    loader_version: Option<String>,
    name: String,
) -> AppResult<ResourceInstanceResult> {
    require_modrinth(&source)?;
    let kind = ResourceKind::parse(&resource_type)?;
    identifier(&project_id)?;
    validate_id(&game_version)?;
    validate_id(&loader)?;
    if !["fabric", "quilt", "forge", "neoforge"].contains(&loader.as_str())
        && !(loader == "vanilla" && kind != ResourceKind::Mod)
    {
        return Err(no_compatible_version(&game_version, Some(&loader)));
    }
    if let Some(version) = loader_version
        .as_deref()
        .filter(|version| !version.is_empty())
    {
        validate_id(version)?;
    }
    let name = crate::commands::validate_instance_name(&name)?;
    let _operation = state.operation.lock().await;
    let task = state.control.begin(
        "resource",
        &project_id,
        &format!("创建 {loader} {game_version} 实例并安装资源"),
    );
    let progress = ResourceProgress::new(Some(&app), &game_version);
    progress.stage(&state, "resource-preflight", "检查资源及必需前置");
    let result: AppResult<ResourceInstanceResult> = async {
        state.control.checkpoint().await?;
        let api = client(false)?;
        let project: Project = api_json(&api, &format!("project/{project_id}"), &[]).await?;
        if project.project_type != kind.project_type() {
            return Err(expected("资源项目类型与所选分类不一致，已拒绝安装"));
        }
        let resource_loader = (kind == ResourceKind::Mod).then_some(loader.as_str());
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
    }
    .await;
    finish_resource_task(Some(&app), &state, &task, result.as_ref().err());
    result
}

fn history_target(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
    kind: ResourceKind,
) -> Result<PathBuf, String> {
    resource_directory(&state.snapshot()?, version_id, instance_id, kind)
}

#[tauri::command]
pub async fn install_resource(
    app: AppHandle,
    state: tauri::State<'_, Arc<LauncherState>>,
    project_id: String,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
) -> AppResult<ResourceInstall> {
    let kind = ResourceKind::parse(&resource_type)?;
    identifier(&project_id)?;
    let _operation = state.operation.lock().await;
    require_resource_stopped(&state, &version_id, instance_id.as_deref())?;
    let task = state
        .control
        .begin("resource", &project_id, "安装 Modrinth 资源及必需前置");
    let progress = ResourceProgress::new(Some(&app), &version_id);
    progress.stage(&state, "resource-plan", "检查资源安装位置");
    let result: AppResult<ResourceInstall> = async {
        state.control.checkpoint().await?;
        let target = resource_target(&state, &version_id, instance_id.as_deref(), kind)?;
        let api = client(false)?;
        let project: Project = api_json(&api, &format!("project/{project_id}"), &[]).await?;
        if project.project_type != kind.project_type() {
            return Err("资源项目类型与所选分类不一致，已拒绝安装".into());
        }
        let versions = project_versions(
            &api,
            &project.id,
            &target.minecraft,
            target.loader.as_deref(),
        )
        .await?;
        let metadata: Vec<_> = versions.iter().map(version_lite).collect();
        let chosen = crate::resource_targets::validate_request(
            &metadata,
            kind,
            target.loader.as_deref().unwrap_or("vanilla"),
            &target.minecraft,
        )?;
        let version = versions
            .iter()
            .find(|version| version.id == chosen.id)
            .cloned()
            .ok_or_else(|| no_compatible_version(&target.minecraft, target.loader.as_deref()))?;
        if version.project_id != project.id {
            return Err("Modrinth 版本与项目标识不一致".into());
        }
        resource_transactions::install(
            state.inner(),
            &target.directory,
            &target.minecraft,
            target.loader.as_deref(),
            &project.title,
            version,
            kind,
            true,
            Some(&progress),
        )
        .await
        .map_err(expected)
    }
    .await;
    if result.is_ok() {
        progress.emit(&state, "complete", 1, 1, 0, 0, "资源安装完成");
    }
    finish_resource_task(Some(&app), &state, &task, result.as_ref().err());
    result
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
        .begin("resource-check", &version_id, "检查 Modrinth 资源更新");
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
        .begin("resource-update", &file_name, "更新资源及必需前置");
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
) -> Result<resource_transactions::RollbackResult, String> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    if let Some(id) = instance_id.as_deref() {
        state.games.require_instance_stopped(id)?;
    }
    let directory = history_target(&state, &version_id, instance_id.as_deref(), kind)?;
    resource_transactions::rollback(&directory, &update_id)
}

fn local_resource(path: PathBuf, kind: ResourceKind) -> Result<Option<LocalResource>, String> {
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
    Ok(Some(LocalResource {
        name: original.to_owned(),
        file_name,
        path: path.to_string_lossy().into_owned(),
        enabled,
        size: metadata.len(),
    }))
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
    if !directory.exists() {
        return Ok(Vec::new());
    }
    reject_links(&directory)?;
    let mut result = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|_| "无法读取资源目录，请检查访问权限")?
    {
        let entry = entry.map_err(|_| "读取资源目录失败")?;
        if let Some(resource) = local_resource(entry.path(), kind)? {
            result.push(resource);
        }
    }
    result.sort_by_key(|resource| resource.file_name.to_ascii_lowercase());
    Ok(result)
}

#[tauri::command]
pub async fn toggle_resource(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    file_name: String,
) -> Result<LocalResource, String> {
    let kind = ResourceKind::parse(&resource_type)?;
    validate_id(&file_name)?;
    let _operation = state.operation.lock().await;
    let directory = resource_directory(
        &state.snapshot()?,
        &version_id,
        instance_id.as_deref(),
        kind,
    )?;
    reject_links(&directory)?;
    let source = safe_join(&directory, &file_name)?;
    let resource = local_resource(source.clone(), kind)?.ok_or("请选择有效的资源文件")?;
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
    local_resource(target, kind)?.ok_or_else(|| "资源状态无法读取".into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let state = Arc::new(LauncherState {
            data: std::sync::Mutex::new(Persisted {
                config: crate::models::Config {
                    game_directory: root.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                ..Default::default()
            }),
            data_dir: root.clone(),
            client: crate::storage::test_client(),
            operation: tokio::sync::Mutex::new(()),
            control: Default::default(),
            games: Default::default(),
        });
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
        let task = state.control.begin("resource", "project", "创建并安装");
        state.control.cancel(Some(&task));
        let result = tauri::async_runtime::block_on(create_resource_instance_then_install(
            &state,
            "Example".into(),
            "fabric-test".into(),
            |_| async { panic!("cancelled install must not start") },
        ));
        let error = result.err().unwrap();
        assert_eq!(error.code, "download.cancelled");
        finish_resource_task(None, &state, &task, Some(&error));
        assert!(state.snapshot().unwrap().instances.is_empty());
        assert!(!root.join("instances").exists());
        let jobs = state.control.list();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, "cancelled");
        assert_eq!(jobs[0].kind, "resource");
        cleanup_fixture(root);
    }

    #[test]
    fn cancellation_after_creation_keeps_instance_and_finishes_cancelled() {
        let (root, state) = resource_fixture();
        let task = state.control.begin("resource", "project", "创建并安装");
        let install_state = state.clone();
        let install_task = task.clone();
        let result = tauri::async_runtime::block_on(create_resource_instance_then_install(
            &state,
            "Example".into(),
            "fabric-test".into(),
            move |_| async move {
                install_state.control.cancel(Some(&install_task));
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
        finish_resource_task(None, &state, &task, Some(&error));
        assert_eq!(state.control.list().len(), 1);
        assert_eq!(state.control.list()[0].status, "cancelled");
        cleanup_fixture(root);
    }

    #[test]
    fn resource_failure_keeps_created_instance_and_retry_identity() {
        let (root, state) = resource_fixture();
        let task = state.control.begin("resource", "project", "创建并安装");
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
        finish_resource_task(None, &state, &task, Some(&error));
        assert_eq!(state.control.list()[0].status, "failed");
        cleanup_fixture(root);
    }

    #[test]
    fn resource_progress_records_stages_and_bytes_in_the_same_task() {
        let (root, state) = resource_fixture();
        let task = state.control.begin("resource", "project", "创建并安装");
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
        finish_resource_task(None, &state, &task, None);
        assert_eq!(state.control.list().len(), 1);
        assert_eq!(state.control.list()[0].status, "completed");
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
        assert!(candidates
            .iter()
            .any(|candidate| candidate.kind == "version" && candidate.version_id == "fabric-test"));
        let error = resource_target(&state, "not-installed", None, ResourceKind::ResourcePack)
            .err()
            .unwrap();
        assert_eq!(error.code, "resource.versionMissing");
        assert_eq!(error.params["versionId"], "not-installed");
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
            pid: 7,
            version_id: "fabric-test".into(),
            instance_id: None,
            game_directory: directory.to_string_lossy().into_owned(),
            started_at: "now".into(),
        }];
        assert!(target_running(&data, "fabric-test", None, &games));
        assert!(!target_running(&data, "1.21.1", None, &games));
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
            &state.client,
            version,
            "1.21.1",
            Some("fabric"),
            ResourceKind::Mod,
        ))
        .unwrap_err();
        assert!(error.contains("必需前置没有可核验"));
        assert!(state.snapshot().unwrap().instances.is_empty());
        assert!(!root.join("instances").exists());
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
        let state = LauncherState {
            data: std::sync::Mutex::new(Persisted {
                config: crate::models::Config {
                    game_directory: root.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                ..Default::default()
            }),
            data_dir: root.clone(),
            client: crate::storage::test_client(),
            operation: tokio::sync::Mutex::new(()),
            control: Default::default(),
            games: Default::default(),
        };
        let error = resource_target(&state, "1.21.1", None, ResourceKind::Mod)
            .err()
            .unwrap();
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["code"], "resource.loaderRequired");
        assert_eq!(value["params"]["versionId"], "1.21.1");
        assert!(root.starts_with(parent));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_modrinth_downloads_retry_with_a_clean_temporary_file() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut served = 0;
            while served < 3 {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let mut request = [0; 2048];
                        let _ = std::io::Read::read(&mut stream, &mut request);
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
                            "download retry timed out after {served} requests"
                        );
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("local download fixture failed: {error}"),
                }
            }
            served
        });
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/resource-tests");
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        let directory = root.join("mods");
        let state = Arc::new(LauncherState {
            data: std::sync::Mutex::new(Persisted::default()),
            data_dir: root.join("data"),
            client: crate::storage::test_client(),
            operation: tokio::sync::Mutex::new(()),
            control: Default::default(),
            games: Default::default(),
        });
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
        let task = state.control.begin("resource", "example", "下载资源");
        let progress = ResourceProgress::new(None, "1.21.1");
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
        assert!(root.starts_with(&parent));
        fs::remove_dir_all(root).unwrap();
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
