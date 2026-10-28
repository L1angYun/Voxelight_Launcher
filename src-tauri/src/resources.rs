//! Modrinth installation and resource management share the launcher's game directory rules.
use crate::{
    errors::{expected, AppResult},
    models::{
        Persisted, ResourceDependency, ResourceProject, ResourceProjectDetails, ResourceVersion,
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
    versions: Vec<String>,
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
        .user_agent("VoxelightLauncher/0.5.0 (Tauri desktop)")
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

fn modrinth_details(project: Project, versions: Vec<Version>) -> ResourceProjectDetails {
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
            versions: project.versions,
            external_url: project.external_url,
        },
        versions: versions
            .into_iter()
            .map(|version| ResourceVersion {
                id: version.id,
                name: version.name,
                version_number: version.version_number,
                date_published: version.date_published,
                game_versions: version.game_versions,
                loaders: version.loaders,
                compatible: true,
            })
            .collect(),
        dependencies,
    }
}

#[tauri::command]
pub async fn get_modrinth_project_details(
    state: tauri::State<'_, Arc<LauncherState>>,
    project_id: String,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
) -> AppResult<ResourceProjectDetails> {
    let kind = if resource_type == "modpack" {
        ResourceKind::Mod
    } else {
        ResourceKind::parse(&resource_type).map_err(expected)?
    };
    identifier(&project_id).map_err(expected)?;
    let target =
        resource_target(&state, &version_id, instance_id.as_deref(), kind).map_err(expected)?;
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
    let versions = project_versions(
        &api,
        &project.id,
        &target.minecraft,
        target.loader.as_deref(),
    )
    .await
    .map_err(expected)?;
    Ok(modrinth_details(project, versions))
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

/// A failed download leaves no partially installed JAR/ZIP and never overwrites a different user file.
async fn download_verified(
    state: &LauncherState,
    file: &ResourceFile,
    directory: &Path,
    kind: ResourceKind,
) -> Result<PathBuf, String> {
    download_verified_with_client(state, file, directory, kind, client(true)?).await
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

async fn download_verified_with_client(
    state: &LauncherState,
    file: &ResourceFile,
    directory: &Path,
    kind: ResourceKind,
    client: reqwest::Client,
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
    reject_links(directory)?;
    fs::create_dir_all(directory).map_err(|_| "无法创建资源目录，请检查目录权限")?;
    reject_links(directory)?;
    let target = safe_join(directory, &file.filename)?;
    if target.exists() {
        if target.is_file()
            && fs::metadata(&target).map_err(|_| "无法读取已有文件")?.len() == file.size
            && file_sha512(&target)? == expected
        {
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

struct ResourceTarget {
    directory: PathBuf,
    minecraft: String,
    loader: Option<String>,
}

fn resource_target(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
    kind: ResourceKind,
) -> Result<ResourceTarget, String> {
    let data = state.snapshot()?;
    let directory = resource_directory(&data, version_id, instance_id, kind)?;
    let root = Path::new(&data.config.game_directory);
    reject_links(root)?;
    let (minecraft, detected_loader) = version_context(root, version_id)?;
    let loader = if kind == ResourceKind::Mod {
        Some(detected_loader.ok_or("当前是原版 Minecraft，无法加载模组。请先安装 Fabric、Forge、NeoForge 或 Quilt，并选择对应加载器版本。")?)
    } else {
        None
    };
    Ok(ResourceTarget {
        directory,
        minecraft,
        loader,
    })
}

pub(crate) fn resource_game_context(
    state: &LauncherState,
    version_id: &str,
    instance_id: Option<&str>,
    kind: ResourceKind,
) -> Result<(String, Option<String>), String> {
    let target = resource_target(state, version_id, instance_id, kind)?;
    Ok((target.minecraft, target.loader))
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
    state: tauri::State<'_, Arc<LauncherState>>,
    project_id: String,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
) -> Result<ResourceInstall, String> {
    let kind = ResourceKind::parse(&resource_type)?;
    identifier(&project_id)?;
    let _operation = state.operation.lock().await;
    if let Some(id) = instance_id.as_deref() {
        state.games.require_instance_stopped(id)?;
    }
    let task = state
        .control
        .begin("resource", &project_id, "安装 Modrinth 资源及必需前置");
    let result = async {
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
        let version = versions.into_iter().next().ok_or_else(|| {
            format!(
                "没有适用于 Minecraft {}{} 的兼容版本",
                target.minecraft,
                target
                    .loader
                    .as_deref()
                    .map(|loader| format!(" / {loader}"))
                    .unwrap_or_default()
            )
        })?;
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
        )
        .await
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

#[tauri::command]
pub async fn check_resource_updates(
    state: tauri::State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
) -> Result<Vec<resource_transactions::ResourceUpdate>, String> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    let task = state
        .control
        .begin("resource-check", &version_id, "检查 Modrinth 资源更新");
    let result = async {
        let target = resource_target(&state, &version_id, instance_id.as_deref(), kind)?;
        resource_transactions::updates(
            &state,
            &target.directory,
            &target.minecraft,
            target.loader.as_deref(),
            kind,
        )
        .await
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
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
) -> Result<ResourceInstall, String> {
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    if let Some(id) = instance_id.as_deref() {
        state.games.require_instance_stopped(id)?;
    }
    let task = state
        .control
        .begin("resource-update", &file_name, "更新资源及必需前置");
    let result = async {
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
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
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
        let downloaded = tauri::async_runtime::block_on(download_verified_with_client(
            &state,
            &file,
            &directory,
            ResourceKind::Mod,
            client,
        ))
        .unwrap();
        assert_eq!(server.join().unwrap(), 3);
        assert_eq!(fs::read(downloaded).unwrap(), b"abcdef");
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
                versions: vec!["1.21.1".into()],
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
        );
        assert_eq!(details.project.downloads, 100);
        assert!(details.versions.iter().all(|version| version.compatible));
        assert_eq!(details.dependencies[0].kind, "required");
        assert_eq!(details.dependencies[1].kind, "unknown");
    }
}
