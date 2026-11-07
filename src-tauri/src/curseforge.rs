//! CurseForge integration uses only the user's own encrypted service key.
//! API contract: https://docs.curseforge.com/rest-api/
use crate::{
    errors::{expected, AppResult},
    models::{ResourceDependency, ResourceProject, ResourceProjectDetails, ResourceVersion},
    resources::{ResourceInstall, ResourceKind},
    storage::{safe_join, validate_id, LauncherState},
};
use futures_util::StreamExt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::State;
use tokio::io::AsyncWriteExt;

const API: &str = "https://api.curseforge.com/v1";
const MAX_METADATA: usize = 16 * 1024 * 1024;
const MAX_FILE: u64 = 1024 * 1024 * 1024;

#[derive(Deserialize)]
struct Response<T> {
    data: T,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: u64,
    game_id: u64,
    name: String,
    slug: String,
    #[serde(default)]
    summary: String,
    class_id: Option<u64>,
    #[serde(default)]
    download_count: f64,
    #[serde(default)]
    authors: Vec<Author>,
    logo: Option<Logo>,
    #[serde(default)]
    latest_files_indexes: Vec<FileIndex>,
    #[serde(default)]
    latest_files: Vec<CfFile>,
    allow_mod_distribution: Option<bool>,
    #[serde(default)]
    links: Links,
}

fn curseforge_details(
    project: Project,
    files: Vec<CfFile>,
    resource_type: &str,
    minecraft: &str,
) -> ResourceProjectDetails {
    let mut dependencies = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let versions = files
        .into_iter()
        .filter(|file| file.is_available)
        .take(30)
        .map(|file| {
            for dependency in &file.dependencies {
                let kind = match dependency.relation_type {
                    1 => "embedded",
                    2 => "optional",
                    3 => "required",
                    5 => "incompatible",
                    _ => "unknown",
                };
                if seen.insert((dependency.mod_id, kind)) {
                    dependencies.push(ResourceDependency {
                        project_id: dependency.mod_id.to_string(),
                        kind: kind.into(),
                        name: None,
                    });
                }
            }
            let compatible =
                !minecraft.is_empty() && file.game_versions.iter().any(|game| game == minecraft);
            let loaders = file
                .game_versions
                .iter()
                .filter_map(|tag| match tag.to_ascii_lowercase().as_str() {
                    "fabric" => Some("fabric".into()),
                    "quilt" => Some("quilt".into()),
                    "forge" => Some("forge".into()),
                    "neoforge" => Some("neoforge".into()),
                    _ => None,
                })
                .collect();
            ResourceVersion {
                id: file.id.to_string(),
                name: file.file_name.clone(),
                version_number: file.file_name,
                date_published: file.file_date,
                game_versions: file.game_versions,
                loaders,
                compatible,
            }
        })
        .collect();
    ResourceProjectDetails {
        project: ResourceProject {
            project_id: project.id.to_string(),
            slug: project.slug,
            title: project.name,
            description: project.summary,
            icon_url: project.logo.map(|logo| logo.url),
            downloads: project.download_count as u64,
            author: project
                .authors
                .into_iter()
                .map(|author| author.name)
                .collect::<Vec<_>>()
                .join(", "),
            project_type: resource_type.into(),
            versions: project
                .latest_files_indexes
                .into_iter()
                .map(|index| index.game_version)
                .chain(
                    project
                        .latest_files
                        .into_iter()
                        .flat_map(|file| file.game_versions),
                )
                .collect(),
            external_url: project.links.website_url,
        },
        versions,
        dependencies,
    }
}

#[tauri::command]
pub async fn get_curseforge_project_details(
    state: State<'_, Arc<LauncherState>>,
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
    let id = crate::curseforge::project_id(&project_id).map_err(expected)?;
    let target = version_id
        .as_deref()
        .filter(|version| !version.is_empty())
        .and_then(|version| {
            crate::resources::resource_context(&state, version, instance_id.as_deref()).ok()
        });
    let key = service_key(&state).map_err(expected)?;
    let client = api_client().map_err(expected)?;
    let project: Response<Project> = api(&client, &key, &format!("mods/{id}"), &[])
        .await
        .map_err(expected)?;
    let filter = target.as_ref().filter(|target| {
        resource_type != "modpack" && (kind != ResourceKind::Mod || target.loader.is_some())
    });
    let game = filter
        .map(|target| target.game_version.as_str())
        .unwrap_or("");
    let loader = filter
        .and_then(|target| target.loader.as_deref())
        .filter(|_| kind == ResourceKind::Mod);
    let files = files_page(&client, &key, id, game, loader, 0)
        .await
        .map_err(expected)?;
    let mut details = curseforge_details(
        project.data,
        files,
        &resource_type,
        target
            .as_ref()
            .map(|target| target.game_version.as_str())
            .unwrap_or(""),
    );
    if resource_type == "mod" {
        for version in &mut details.versions {
            version.compatible &= target
                .as_ref()
                .and_then(|target| target.loader.as_deref())
                .is_some_and(|loader| version.loaders.iter().any(|tag| tag == loader));
        }
    }
    Ok(details)
}
#[derive(Clone, Deserialize)]
struct Author {
    name: String,
}
#[derive(Clone, Deserialize)]
struct Logo {
    url: String,
}
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Links {
    website_url: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileIndex {
    game_version: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfFile {
    id: u64,
    mod_id: u64,
    #[serde(default)]
    game_id: u64,
    is_available: bool,
    file_name: String,
    file_length: u64,
    download_url: Option<String>,
    hashes: Vec<CfHash>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    dependencies: Vec<Dependency>,
    #[serde(default)]
    file_date: String,
    #[serde(default)]
    is_server_pack: bool,
}
#[derive(Clone, Deserialize)]
struct CfHash {
    value: String,
    algo: u32,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Dependency {
    mod_id: u64,
    relation_type: u32,
}

#[derive(Serialize)]
pub struct SearchProject {
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: f64,
    pub author: String,
    pub project_type: String,
    pub versions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_url: Option<String>,
}
#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchProject>,
}

fn project_id(value: &str) -> Result<u64, String> {
    if value.is_empty() || value.len() > 10 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("CurseForge 项目标识须为正整数".into());
    }
    let id = value
        .parse::<u32>()
        .map_err(|_| "CurseForge 项目标识超出范围")?;
    if id == 0 {
        return Err("CurseForge 项目标识须大于零".into());
    }
    Ok(u64::from(id))
}
fn class_id(kind: &str) -> Result<u64, String> {
    match kind {
        "mod" => Ok(6),
        "resourcepack" => Ok(12),
        "shader" => Ok(6552),
        "modpack" => Ok(4471),
        _ => Err("不支持的 CurseForge 资源类型".into()),
    }
}
fn loader_code(loader: &str) -> Result<u32, String> {
    match loader.to_ascii_lowercase().as_str() {
        "" | "vanilla" | "any" => Ok(0),
        "forge" => Ok(1),
        "fabric" => Ok(4),
        "quilt" => Ok(5),
        "neoforge" => Ok(6),
        _ => Err("不支持此 CurseForge 加载器筛选".into()),
    }
}
fn service_key(state: &LauncherState) -> Result<String, String> {
    let key = crate::secrets::load_service_secret(&state.data_dir, "curseforge-api-key")?
        .filter(|v| !v.trim().is_empty())
        .ok_or("请先在设置中保存你自己申请的 CurseForge API Key；不会使用其它启动器的 Key。")?;
    if key.len() > 2048 || key.chars().any(char::is_control) {
        return Err("加密保存的 CurseForge API Key 格式无效，请重新设置".into());
    }
    Ok(key)
}
fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!(
            "VoxelightLauncher/",
            env!("CARGO_PKG_VERSION"),
            " (Tauri desktop)"
        ))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法创建 CurseForge API 客户端".into())
}
async fn api<T: DeserializeOwned>(
    client: &reqwest::Client,
    key: &str,
    path: &str,
    query: &[(String, String)],
) -> Result<T, String> {
    let response = client
        .get(format!("{API}/{path}"))
        .query(query)
        .header("x-api-key", key)
        .send()
        .await
        .map_err(|_| "CurseForge 连接失败，请检查网络后重试")?;
    match response.status().as_u16() {
        401 | 403 => {
            return Err(
                "CurseForge 拒绝访问，请检查你自己的 API Key、账号权限或该资源的第三方分发授权"
                    .into(),
            )
        }
        404 => return Err("CurseForge 项目或文件不存在".into()),
        429 => return Err("CurseForge 请求过于频繁，请稍后重试".into()),
        _ => {}
    }
    if !response.status().is_success() {
        return Err(format!(
            "CurseForge 请求失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_METADATA as u64)
    {
        return Err("CurseForge 元数据过大".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "读取 CurseForge 数据失败")?;
        if bytes.len().saturating_add(chunk.len()) > MAX_METADATA {
            return Err("CurseForge 元数据超过限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "CurseForge 数据格式无法解析".into())
}
fn download_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "CurseForge 下载地址无效")?;
    let hosts = [
        "mediafilez.forgecdn.net",
        "edge.forgecdn.net",
        "media.forgecdn.net",
    ];
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !hosts.contains(&url.host_str().unwrap_or(""))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("下载地址不是允许的 CurseForge 官方 CDN HTTPS 地址".into());
    }
    Ok(url)
}
fn distribution_error(project: &Project, file: &CfFile) -> String {
    let page = project
        .links
        .website_url
        .as_deref()
        .and_then(|value| {
            let url = reqwest::Url::parse(value).ok()?;
            (url.scheme() == "https"
                && ["curseforge.com", "www.curseforge.com"].contains(&url.host_str().unwrap_or("")))
            .then_some(value)
        })
        .unwrap_or("https://www.curseforge.com/minecraft");
    format!("「{}」文件 {} 禁止第三方分发或未提供可用下载地址。请在项目页面手动下载授权文件并放入目标资源目录：{}。启动器不会拼接下载地址绕过限制。", project.name, file.id, page)
}
fn compatible(file: &CfFile, minecraft: &str, loader: Option<&str>) -> bool {
    file.is_available
        && !file.is_server_pack
        && (file.game_id == 0 || file.game_id == 432)
        && file.game_versions.iter().any(|v| v == minecraft)
        && loader.is_none_or(|kind| {
            file.game_versions
                .iter()
                .any(|v| v.eq_ignore_ascii_case(kind))
        })
}
fn expected_hashes(file: &CfFile) -> Result<Vec<(u32, String)>, String> {
    let mut values = Vec::new();
    for hash in &file.hashes {
        let length = match hash.algo {
            1 => 40,
            2 => 32,
            _ => continue,
        };
        if hash.value.len() != length || !hash.value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("CurseForge 文件校验值格式无效".into());
        }
        values.push((hash.algo, hash.value.to_ascii_lowercase()));
    }
    if values.is_empty() {
        return Err("CurseForge 文件未提供 SHA-1 或 MD5，无法校验安装".into());
    }
    Ok(values)
}
fn file_hashes(path: &Path) -> Result<(String, String, u64), String> {
    let mut file = fs::File::open(path).map_err(|_| "无法读取本地资源文件")?;
    let mut sha1 = Sha1::new();
    let mut md5 = md5::Context::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| "读取本地资源失败")?;
        if count == 0 {
            break;
        }
        size += count as u64;
        sha1.update(&buffer[..count]);
        md5.consume(&buffer[..count]);
    }
    Ok((
        format!("{:x}", sha1.finalize()),
        format!("{:x}", md5.compute()),
        size,
    ))
}
fn matches(values: &(String, String, u64), size: u64, expected: &[(u32, String)]) -> bool {
    values.2 == size
        && expected
            .iter()
            .all(|(algo, hash)| hash == if *algo == 1 { &values.0 } else { &values.1 })
}
async fn files_page(
    client: &reqwest::Client,
    key: &str,
    project: u64,
    minecraft: &str,
    loader: Option<&str>,
    offset: usize,
) -> Result<Vec<CfFile>, String> {
    let mut query = vec![
        ("pageSize".into(), "50".into()),
        ("index".into(), offset.to_string()),
    ];
    if !minecraft.is_empty() {
        query.push(("gameVersion".into(), minecraft.into()));
    }
    if let Some(loader) = loader {
        query.push(("modLoaderType".into(), loader_code(loader)?.to_string()));
    }
    let result: Response<Vec<CfFile>> =
        api(client, key, &format!("mods/{project}/files"), &query).await?;
    if result.data.iter().any(|file| file.mod_id != project) {
        return Err("CurseForge 文件列表项目身份不一致".into());
    }
    Ok(result.data)
}

#[tauri::command]
pub async fn search_curseforge(
    state: State<'_, Arc<LauncherState>>,
    query: String,
    resource_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    offset: Option<u32>,
) -> Result<SearchResult, String> {
    if query.len() > 500 || query.chars().any(char::is_control) {
        return Err("搜索内容过长或包含无效字符".into());
    }
    let class = class_id(&resource_type)?;
    let offset = offset.unwrap_or(0);
    if offset > 9976 {
        return Err("搜索分页超过 CurseForge 的 10000 项限制".into());
    }
    let key = service_key(&state)?;
    let client = api_client()?;
    let mut filters = vec![
        ("gameId".into(), "432".into()),
        ("classId".into(), class.to_string()),
        ("searchFilter".into(), query),
        ("pageSize".into(), "24".into()),
        ("index".into(), offset.to_string()),
        ("sortField".into(), "6".into()),
        ("sortOrder".into(), "desc".into()),
    ];
    if let Some(game) = game_version.filter(|v| !v.is_empty()) {
        validate_id(&game)?;
        filters.push(("gameVersion".into(), game));
    }
    if let Some(loader) = loader.filter(|v| !v.is_empty()) {
        let code = loader_code(&loader)?;
        if code != 0 {
            filters.push(("modLoaderType".into(), code.to_string()));
        }
    }
    let result: Response<Vec<Project>> = api(&client, &key, "mods/search", &filters).await?;
    let hits = result
        .data
        .into_iter()
        .filter(|p| p.game_id == 432 && p.class_id == Some(class))
        .map(|project| {
            let mut versions: Vec<String> = project
                .latest_files_indexes
                .into_iter()
                .map(|v| v.game_version)
                .chain(
                    project
                        .latest_files
                        .into_iter()
                        .flat_map(|v| v.game_versions),
                )
                .collect();
            versions.sort();
            versions.dedup();
            let external_url = project.links.website_url.filter(|value| {
                reqwest::Url::parse(value).is_ok_and(|url| {
                    url.scheme() == "https"
                        && ["www.curseforge.com", "curseforge.com"]
                            .contains(&url.host_str().unwrap_or(""))
                        && url.username().is_empty()
                        && url.password().is_none()
                })
            });
            SearchProject {
                project_id: project.id.to_string(),
                slug: project.slug,
                title: project.name,
                description: project.summary,
                icon_url: project.logo.map(|logo| logo.url),
                downloads: project.download_count,
                author: project
                    .authors
                    .into_iter()
                    .map(|a| a.name)
                    .collect::<Vec<_>>()
                    .join(", "),
                project_type: resource_type.clone(),
                versions,
                external_url,
            }
        })
        .collect();
    Ok(SearchResult { hits })
}

fn local_enabled_hashes(game_dir: &Path) -> Result<HashMap<u64, HashSet<String>>, String> {
    let mut output = HashMap::new();
    for (class, folder, extension) in [
        (6, "mods", ".jar"),
        (12, "resourcepacks", ".zip"),
        (6552, "shaderpacks", ".zip"),
    ] {
        let directory = safe_join(game_dir, folder)?;
        let mut known = HashSet::new();
        if directory.exists() {
            for entry in fs::read_dir(&directory).map_err(|_| "无法读取本地依赖目录")? {
                let path = entry.map_err(|_| "读取本地依赖失败")?.path();
                let metadata = fs::symlink_metadata(&path).map_err(|_| "读取依赖信息失败")?;
                if !metadata.is_file() {
                    continue;
                }
                let mut linked = metadata.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    linked |= metadata.file_attributes() & 0x400 != 0;
                }
                if linked
                    || !path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .is_some_and(|s| s.to_ascii_lowercase().ends_with(extension))
                {
                    continue;
                }
                let (a, b, _) = file_hashes(&path)?;
                known.insert(format!("1:{a}"));
                known.insert(format!("2:{b}"));
            }
        }
        output.insert(class, known);
    }
    Ok(output)
}

async fn check_dependencies(
    state: &LauncherState,
    client: &reqwest::Client,
    key: &str,
    selected: &CfFile,
    game_dir: &Path,
    minecraft: &str,
    loader: Option<&str>,
) -> Result<(), String> {
    if !selected
        .dependencies
        .iter()
        .any(|d| d.relation_type == 3 || d.relation_type == 5)
    {
        return Ok(());
    }
    let directory = game_dir.to_owned();
    let installed = tokio::task::spawn_blocking(move || local_enabled_hashes(&directory))
        .await
        .map_err(|_| "读取依赖时出现异常")??;
    let mut pending: VecDeque<Dependency> = selected.dependencies.clone().into();
    let mut visited = HashSet::new();
    let mut missing = Vec::new();
    while let Some(dependency) = pending.pop_front() {
        state.control.checkpoint().await?;
        if ![3, 5].contains(&dependency.relation_type)
            || !visited.insert((dependency.mod_id, dependency.relation_type))
        {
            continue;
        }
        if visited.len() > 64 {
            return Err("CurseForge 依赖关系超过安全处理上限，请手动检查".into());
        }
        if dependency.mod_id == selected.mod_id && dependency.relation_type == 3 {
            return Err("CurseForge 依赖关系回指当前项目，拒绝循环依赖".into());
        }
        let project: Response<Project> =
            api(client, key, &format!("mods/{}", dependency.mod_id), &[]).await?;
        let class = project.data.class_id.unwrap_or(0);
        let known = installed.get(&class);
        let dependency_loader = (class == 6).then_some(loader).flatten();
        let mut found = None;
        if known.is_some_and(|hashes| !hashes.is_empty()) {
            for offset in (0..500).step_by(50) {
                state.control.checkpoint().await?;
                let files = files_page(
                    client,
                    key,
                    dependency.mod_id,
                    minecraft,
                    dependency_loader,
                    offset,
                )
                .await?;
                let short = files.len() < 50;
                for file in files {
                    if !compatible(&file, minecraft, dependency_loader) {
                        continue;
                    }
                    let expected = expected_hashes(&file)?;
                    let best = expected
                        .iter()
                        .find(|v| v.0 == 1)
                        .or_else(|| expected.first())
                        .ok_or("依赖文件缺少校验")?;
                    if known
                        .is_some_and(|hashes| hashes.contains(&format!("{}:{}", best.0, best.1)))
                    {
                        found = Some(file);
                        break;
                    }
                }
                if found.is_some() || short {
                    break;
                }
                if offset == 450 {
                    return Err(format!(
                        "「{}」兼容文件过多，无法完整核对；请先安装其最新兼容版本再重试",
                        project.data.name
                    ));
                }
            }
        }
        if dependency.relation_type == 5 {
            if found.is_some() {
                return Err(format!(
                    "已启用不兼容的依赖「{}」，请先停用再安装",
                    project.data.name
                ));
            }
        } else if let Some(file) = found {
            pending.extend(file.dependencies);
        } else {
            missing.push(format!(
                "{}（项目 {}）",
                project.data.name, dependency.mod_id
            ));
        }
    }
    if !missing.is_empty() {
        missing.sort();
        missing.dedup();
        return Err(format!(
            "缺少、未启用或版本不兼容的必需依赖：{}。请先安装这些依赖；当前资源尚未写入。",
            missing.join("、")
        ));
    }
    Ok(())
}

async fn download(
    state: &LauncherState,
    project: &Project,
    file: &CfFile,
    directory: &Path,
    kind: ResourceKind,
) -> Result<PathBuf, String> {
    validate_id(&file.file_name)?;
    if !kind.accepts(&file.file_name) {
        return Err("CurseForge 文件类型与资源分类不匹配".into());
    }
    if project.allow_mod_distribution == Some(false)
        || file
            .download_url
            .as_deref()
            .is_none_or(|url| url.is_empty())
    {
        return Err(distribution_error(project, file));
    }
    let expected = expected_hashes(file)?;
    if file.file_length == 0 || file.file_length > MAX_FILE {
        return Err("CurseForge 文件大小无效或超过 1 GiB".into());
    }
    let url = download_url(file.download_url.as_deref().ok_or("资源缺少下载地址")?)?;
    crate::instances::checked_absolute(directory)?;
    fs::create_dir_all(directory).map_err(|_| "无法创建资源目录")?;
    let target = safe_join(directory, &file.file_name)?;
    if target.exists() {
        if target.is_file() && matches(&file_hashes(&target)?, file.file_length, &expected) {
            return Ok(target);
        }
        return Err(format!(
            "已存在内容不同的同名文件 {}，已保留原文件，请先备份或重命名",
            file.file_name
        ));
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "VoxelightLauncher/",
            env!("CARGO_PKG_VERSION"),
            " (Tauri desktop)"
        ))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("重定向过多")
            } else if download_url(attempt.url().as_str()).is_ok() {
                attempt.follow()
            } else {
                attempt.error("重定向到非 CurseForge CDN")
            }
        }))
        .build()
        .map_err(|_| "无法创建资源下载客户端")?;
    let temporary = safe_join(
        directory,
        &format!(".curseforge-{}.part", uuid::Uuid::new_v4()),
    )?;
    let result = async {
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|_| "CurseForge 下载连接失败")?;
        if !response.status().is_success() {
            return Err(format!(
                "CurseForge 资源下载失败（HTTP {}）",
                response.status().as_u16()
            ));
        }
        download_url(response.url().as_str())?;
        if response
            .content_length()
            .is_some_and(|size| size != file.file_length)
        {
            return Err("下载大小与 CurseForge 声明不一致".into());
        }
        let mut output = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await
            .map_err(|_| "无法创建临时资源文件")?;
        let mut sha1 = Sha1::new();
        let mut md5 = md5::Context::new();
        let mut count = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            state.control.checkpoint().await?;
            let chunk = chunk.map_err(|_| "CurseForge 文件传输中断")?;
            state.control.throttle(chunk.len()).await?;
            count = count.saturating_add(chunk.len() as u64);
            if count > file.file_length {
                return Err("下载内容超过声明大小".into());
            }
            sha1.update(&chunk);
            md5.consume(&chunk);
            output
                .write_all(&chunk)
                .await
                .map_err(|_| "资源写入失败，请检查磁盘空间")?;
        }
        output.sync_all().await.map_err(|_| "无法保存资源文件")?;
        drop(output);
        let values = (
            format!("{:x}", sha1.finalize()),
            format!("{:x}", md5.compute()),
            count,
        );
        if !matches(&values, file.file_length, &expected) {
            return Err("CurseForge SHA-1 / MD5 或大小校验失败，文件未安装".into());
        }
        state.control.checkpoint().await?;
        crate::instances::checked_absolute(directory)?;
        let target = safe_join(directory, &file.file_name)?;
        if target.exists() {
            return Err("下载期间出现同名文件，现有文件未覆盖".into());
        }
        tokio::fs::rename(&temporary, &target)
            .await
            .map_err(|_| "无法提交已校验资源")?;
        Ok(target)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[tauri::command]
pub async fn install_curseforge_resource(
    state: State<'_, Arc<LauncherState>>,
    project_id: String,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    file_id: Option<u64>,
) -> AppResult<ResourceInstall> {
    let id = self::project_id(&project_id)?;
    let kind = ResourceKind::parse(&resource_type)?;
    let _operation = state.operation.lock().await;
    crate::resources::require_resource_stopped(&state, &version_id, instance_id.as_deref())?;
    let task = state
        .control
        .begin("resource", &project_id, "安装 CurseForge 资源");
    let result: AppResult<ResourceInstall> = async {
        state.control.checkpoint().await?;
        let target =
            crate::resources::resource_target(&state, &version_id, instance_id.as_deref(), kind)?;
        let key = service_key(&state)?;
        let client = api_client()?;
        let directory = target.directory;
        let minecraft = target.minecraft;
        let loader = target.loader.as_deref();
        let detected =
            crate::resources::resource_context(&state, &version_id, instance_id.as_deref())?.loader;
        let project: Response<Project> = api(&client, &key, &format!("mods/{id}"), &[]).await?;
        if project.data.id != id
            || project.data.game_id != 432
            || project.data.class_id != Some(class_id(&resource_type)?)
        {
            return Err("CurseForge 项目身份、游戏或分类不一致".into());
        }
        let file = if let Some(file_id) = file_id {
            if file_id == 0 || file_id > u32::MAX as u64 {
                return Err("CurseForge 文件标识无效".into());
            }
            let response: Response<CfFile> =
                api(&client, &key, &format!("mods/{id}/files/{file_id}"), &[]).await?;
            if response.data.id != file_id || response.data.mod_id != id {
                return Err("CurseForge 文件不属于所选项目".into());
            }
            response.data
        } else {
            let mut files = files_page(&client, &key, id, &minecraft, loader, 0).await?;
            files.retain(|file| compatible(file, &minecraft, loader));
            files.sort_by(|a, b| b.file_date.cmp(&a.file_date));
            files
                .into_iter()
                .next()
                .ok_or_else(|| crate::resources::no_compatible_version(&minecraft, loader))?
        };
        if !compatible(&file, &minecraft, loader) {
            return Err(crate::resources::no_compatible_version(&minecraft, loader));
        }
        if project.data.allow_mod_distribution == Some(false)
            || file.download_url.as_deref().is_none_or(|s| s.is_empty())
        {
            return Err(distribution_error(&project.data, &file).into());
        }
        let game_dir = directory.parent().ok_or("目标游戏目录无效")?;
        check_dependencies(
            &state,
            &client,
            &key,
            &file,
            game_dir,
            &minecraft,
            detected.as_deref(),
        )
        .await?;
        let path = download(&state, &project.data, &file, &directory, kind).await?;
        Ok(ResourceInstall {
            name: project.data.name,
            file_name: file.file_name,
            path: path.to_string_lossy().into_owned(),
            warning: (kind == ResourceKind::Shader)
                .then(|| "光影文件已安装；游戏内仍需 Iris、OptiFine 或兼容加载器才能启用。".into()),
            update_id: None,
        })
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

#[cfg(test)]
mod tests {
    use super::*;
    fn example() -> CfFile {
        serde_json::from_value(serde_json::json!({
            "id":123,"modId":456,"gameId":432,"isAvailable":true,
            "fileName":"example.jar","fileLength":3,"downloadUrl":"https://mediafilez.forgecdn.net/files/example.jar",
            "hashes":[{"algo":1,"value":"a9993e364706816aba3e25717850c26c9cd0d89d"},{"algo":2,"value":"900150983cd24fb0d6963f7d28e17f72"}],
            "gameVersions":["1.21.1","Fabric"],"dependencies":[{"modId":789,"relationType":3}]
        })).unwrap()
    }
    #[test]
    fn curseforge_details_without_a_target_keep_available_versions() {
        let project: Project = serde_json::from_value(serde_json::json!({
            "id":456, "gameId":432, "name":"Example", "slug":"example", "classId":6
        }))
        .unwrap();
        let details = curseforge_details(project, vec![example()], "mod", "");
        assert_eq!(details.versions.len(), 1);
        assert!(!details.versions[0].compatible);
        assert_eq!(details.versions[0].loaders, ["fabric"]);
    }
    #[test]
    fn official_file_contract_and_loader_tags_are_checked() {
        let file = example();
        assert!(compatible(&file, "1.21.1", Some("fabric")));
        assert!(!compatible(&file, "1.21.1", Some("forge")));
        assert!(!compatible(&file, "1.20.1", Some("fabric")));
        assert_eq!(file.dependencies[0].relation_type, 3);
        assert_eq!(loader_code("neoforge").unwrap(), 6);
    }
    #[test]
    fn sha1_and_md5_both_must_match_before_commit() {
        let file = example();
        let expected = expected_hashes(&file).unwrap();
        assert!(matches(
            &(
                "a9993e364706816aba3e25717850c26c9cd0d89d".into(),
                "900150983cd24fb0d6963f7d28e17f72".into(),
                3
            ),
            3,
            &expected
        ));
        assert!(!matches(
            &(
                "a9993e364706816aba3e25717850c26c9cd0d89d".into(),
                "00000000000000000000000000000000".into(),
                3
            ),
            3,
            &expected
        ));
    }
    #[test]
    fn cdn_redirects_and_project_ids_reject_external_hosts() {
        assert!(download_url("https://mediafilez.forgecdn.net/files/a.jar").is_ok());
        for url in [
            "http://mediafilez.forgecdn.net/a.jar",
            "https://mediafilez.forgecdn.net.evil.example/a.jar",
            "https://user@edge.forgecdn.net/a.jar",
            "https://edge.forgecdn.net:444/a.jar",
        ] {
            assert!(download_url(url).is_err());
        }
        for id in ["../1", "0", "-1", "4294967296", "1?secret"] {
            assert!(project_id(id).is_err());
        }
    }

    #[test]
    fn curseforge_details_map_official_dependency_relationships() {
        let project = Project {
            id: 42,
            game_id: 432,
            name: "Example".into(),
            slug: "example".into(),
            summary: "Summary".into(),
            class_id: Some(6),
            download_count: 12.0,
            authors: vec![Author {
                name: "Author".into(),
            }],
            logo: None,
            latest_files_indexes: vec![],
            latest_files: vec![],
            allow_mod_distribution: None,
            links: Default::default(),
        };
        let file = CfFile {
            id: 99,
            mod_id: 42,
            game_id: 0,
            is_available: true,
            file_name: "example.jar".into(),
            file_length: 1,
            download_url: None,
            hashes: vec![],
            game_versions: vec!["1.21.1".into()],
            dependencies: vec![
                Dependency {
                    mod_id: 1,
                    relation_type: 1,
                },
                Dependency {
                    mod_id: 2,
                    relation_type: 2,
                },
                Dependency {
                    mod_id: 3,
                    relation_type: 3,
                },
                Dependency {
                    mod_id: 4,
                    relation_type: 4,
                },
                Dependency {
                    mod_id: 5,
                    relation_type: 5,
                },
            ],
            file_date: "2026-01-01".into(),
            is_server_pack: false,
        };
        let details = curseforge_details(project, vec![file], "mod", "1.21.1");
        assert!(details.versions.iter().all(|version| version.compatible));
        let kinds: Vec<_> = details
            .dependencies
            .iter()
            .map(|dependency| dependency.kind.as_str())
            .collect();
        assert_eq!(
            kinds,
            [
                "embedded",
                "optional",
                "required",
                "unknown",
                "incompatible"
            ]
        );
    }
}
