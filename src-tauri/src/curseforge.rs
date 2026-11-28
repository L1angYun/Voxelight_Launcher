//! CurseForge integration uses only the user's own encrypted service key.
//! API contract: https://docs.curseforge.com/rest-api/
use crate::{
    errors::{discover_error, discover_failure, expected, AppResult, DiscoverSource},
    models::{ResourceDependency, ResourceProject, ResourceProjectDetails, ResourceVersion},
    resources::{
        resource_transactions::{
            self, DependencySource, InstallEntry, InstallSource, RequiredResolution, StagedFile,
        },
        Dependency as PlanDependency, FileHashes, ResourceFile, ResourceInstall, ResourceKind,
        Version,
    },
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
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::State;
use tokio::io::AsyncWriteExt;

#[path = "curseforge_fingerprint.rs"]
pub(crate) mod fingerprint;

type ResourceUpdate = crate::resources::resource_transactions::ResourceUpdate;

const API: &str = "https://api.curseforge.com/v1";
const MAX_METADATA: usize = 16 * 1024 * 1024;
const MAX_FILE: u64 = 1024 * 1024 * 1024;

#[derive(Deserialize)]
struct Response<T> {
    data: T,
    #[serde(default)]
    pagination: Option<Pagination>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pagination {
    #[serde(default)]
    total_count: u64,
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

fn curseforge_version(file: &CfFile, minecraft: &str) -> ResourceVersion {
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
        version_number: file.file_name.clone(),
        date_published: file.file_date.clone(),
        game_versions: file.game_versions.clone(),
        loaders,
        compatible,
    }
}

/// A mod version also has to declare the target instance's loader.
fn apply_loader_compatibility(
    versions: &mut [ResourceVersion],
    target: Option<&crate::resources::ResourceContext>,
    resource_type: &str,
) {
    if resource_type == "mod" {
        for version in versions {
            version.compatible &= target
                .and_then(|target| target.loader.as_deref())
                .is_some_and(|loader| version.loaders.iter().any(|tag| tag == loader));
        }
    }
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
        .take(crate::resources::PROJECT_VERSION_PAGE)
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
            curseforge_version(&file, minecraft)
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

struct CurseforgeSource {
    id: u64,
    target: Option<crate::resources::ResourceContext>,
    key: String,
    client: reqwest::Client,
    /// The game version and loader used to filter the files endpoint.
    game: String,
    loader: Option<String>,
}

async fn curseforge_source(
    state: &LauncherState,
    project: &str,
    version_id: Option<&str>,
    instance_id: Option<&str>,
    resource_type: &str,
) -> AppResult<CurseforgeSource> {
    let kind = if resource_type == "modpack" {
        ResourceKind::Mod
    } else {
        ResourceKind::parse(resource_type)
            .map_err(|error| expected(crate::resources::invalid_request(error)))?
    };
    let id = project_id(project).map_err(|error| expected(crate::resources::invalid_request(error)))?;
    let target = version_id
        .filter(|version| !version.is_empty())
        .and_then(|version| crate::resources::resource_context(state, version, instance_id).ok());
    let key = service_key(state).map_err(expected)?;
    let client = api_client(state).map_err(expected)?;
    let filter = target.as_ref().filter(|target| {
        resource_type != "modpack" && (kind != ResourceKind::Mod || target.loader.is_some())
    });
    let game = filter
        .map(|target| target.game_version.clone())
        .unwrap_or_default();
    let loader = filter
        .and_then(|target| target.loader.clone())
        .filter(|_| kind == ResourceKind::Mod);
    Ok(CurseforgeSource {
        id,
        target,
        key,
        client,
        game,
        loader,
    })
}

pub(crate) async fn curseforge_details_for_state(
    state: &LauncherState,
    project_id: String,
    version_id: Option<String>,
    instance_id: Option<String>,
    resource_type: String,
) -> AppResult<crate::resources::ProjectDetailsPage> {
    let refused = |error| discover_error(DiscoverSource::CurseForge, error);
    let source = curseforge_source(
        state,
        &project_id,
        version_id.as_deref(),
        instance_id.as_deref(),
        &resource_type,
    )
    .await
    .map_err(refused)?;
    let project: Response<Project> = api(
        &source.client,
        &source.key,
        &format!("mods/{}", source.id),
        &[],
    )
    .await
    .map_err(|error| refused(expected(error)))?;
    let (files, raw_total) = files_page_with_total(
        &source.client,
        &source.key,
        source.id,
        &source.game,
        source.loader.as_deref(),
        0,
        50,
    )
    .await
    .map_err(|error| refused(expected(error)))?;
    let available = files.iter().filter(|file| file.is_available).count();
    let has_more_versions = available > crate::resources::PROJECT_VERSION_PAGE
        || (files.len() == 50 && raw_total.is_none_or(|total| total > 50));
    let minecraft = source
        .target
        .as_ref()
        .map(|target| target.game_version.as_str())
        .unwrap_or("");
    let mut details = curseforge_details(project.data, files, &resource_type, minecraft);
    apply_loader_compatibility(&mut details.versions, source.target.as_ref(), &resource_type);
    Ok(crate::resources::ProjectDetailsPage {
        details,
        has_more_versions,
    })
}

fn version_scan_exhausted(
    fetched: usize,
    raw_index: u64,
    raw_total: Option<u64>,
    needed: usize,
    mapped: usize,
) -> bool {
    mapped > needed
        || fetched < 50
        || raw_total.is_some_and(|total| raw_index >= total)
        || raw_index >= 500
}

pub(crate) async fn curseforge_versions_page(
    state: &LauncherState,
    project_id: String,
    version_id: Option<String>,
    instance_id: Option<String>,
    resource_type: String,
    offset: Option<u32>,
) -> AppResult<crate::resources::ResourceVersionPage> {
    let refused = |error| discover_error(DiscoverSource::CurseForge, error);
    let offset = crate::resources::version_offset(offset).map_err(refused)?;
    let source = curseforge_source(
        state,
        &project_id,
        version_id.as_deref(),
        instance_id.as_deref(),
        &resource_type,
    )
    .await
    .map_err(refused)?;
    let needed = offset + crate::resources::PROJECT_VERSION_PAGE;
    let mut mapped: Vec<ResourceVersion> = Vec::new();
    let mut raw_index = 0_u64;
    let mut raw_total = None;
    loop {
        let (files, total) = files_page_with_total(
            &source.client,
            &source.key,
            source.id,
            &source.game,
            source.loader.as_deref(),
            raw_index as usize,
            50,
        )
        .await
        .map_err(|error| refused(expected(error)))?;
        if total.is_some() {
            raw_total = total;
        }
        let fetched = files.len();
        let minecraft = source
            .target
            .as_ref()
            .map(|target| target.game_version.as_str())
            .unwrap_or("");
        mapped.extend(
            files
                .into_iter()
                .filter(|file| file.is_available)
                .map(|file| curseforge_version(&file, minecraft)),
        );
        raw_index += fetched as u64;
        if version_scan_exhausted(fetched, raw_index, raw_total, needed, mapped.len()) {
            break;
        }
    }
    let total = mapped.len();
    let mut versions: Vec<ResourceVersion> = mapped
        .into_iter()
        .skip(offset)
        .take(crate::resources::PROJECT_VERSION_PAGE)
        .collect();
    apply_loader_compatibility(&mut versions, source.target.as_ref(), &resource_type);
    let next = offset + versions.len();
    Ok(crate::resources::ResourceVersionPage {
        has_more: next < total && next <= crate::resources::MAX_PROJECT_VERSION_OFFSET,
        versions,
    })
}

#[tauri::command]
pub async fn get_curseforge_project_details(
    state: State<'_, Arc<LauncherState>>,
    project_id: String,
    version_id: Option<String>,
    instance_id: Option<String>,
    resource_type: String,
) -> AppResult<crate::resources::ProjectDetailsPage> {
    curseforge_details_for_state(&state, project_id, version_id, instance_id, resource_type).await
}

#[tauri::command]
pub async fn get_curseforge_project_versions(
    state: State<'_, Arc<LauncherState>>,
    project_id: String,
    version_id: Option<String>,
    instance_id: Option<String>,
    resource_type: String,
    offset: Option<u32>,
) -> AppResult<crate::resources::ResourceVersionPage> {
    curseforge_versions_page(
        &state,
        project_id,
        version_id,
        instance_id,
        resource_type,
        offset,
    )
    .await
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
    /// 1 release, 2 beta, 3 alpha.
    #[serde(default)]
    release_type: u32,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    file_fingerprint: u64,
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
/// One Discover page. `next_offset` counts the projects CurseForge returned,
/// including any the launcher left out, so paging stays aligned with its index.
#[derive(Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchProject>,
    #[serde(rename = "totalHits", skip_serializing_if = "Option::is_none")]
    pub total_hits: Option<u64>,
    #[serde(rename = "nextOffset")]
    pub next_offset: u32,
}

pub(crate) fn project_id(value: &str) -> Result<u64, String> {
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
fn kind_for_class(class: u64) -> Option<ResourceKind> {
    match class {
        6 => Some(ResourceKind::Mod),
        12 => Some(ResourceKind::ResourcePack),
        6552 => Some(ResourceKind::Shader),
        _ => None,
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
    crate::curseforge_key::effective_cf_key(&state.data_dir, None)?
        .ok_or_else(|| "请先在设置中保存你自己申请的 CurseForge API Key；不会使用其它启动器的 Key。".into())
}
fn api_client(state: &LauncherState) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .user_agent(concat!(
            "VoxelightLauncher/",
            env!("CARGO_PKG_VERSION"),
            " (Tauri desktop)"
        ))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none());
    crate::network::for_state_builder(state, builder)?
        .build()
        .map_err(|_| "无法创建 CurseForge API 客户端".into())
}
/// The CurseForge API base.
fn curseforge_api() -> String {
    #[cfg(test)]
    if let Some(endpoints) = crate::resources::test_endpoints() {
        return endpoints.curseforge_api;
    }
    API.to_owned()
}

/// CurseForge asks for modest request rates: this process sends at most one
/// request every 250 ms, retries a failed request at most 3 times (honouring
/// Retry-After), and keeps answers (projects, files, searches, lookups) for
/// 5 minutes. The key is a header and never part of a cache key.
static PACER: crate::request_pacing::Pacer = crate::request_pacing::Pacer::new(Duration::from_millis(250));
const MAX_RETRIES: u32 = 3;

fn answer_cache() -> &'static crate::request_pacing::TtlCache<Vec<u8>> {
    static CACHE: OnceLock<crate::request_pacing::TtlCache<Vec<u8>>> = OnceLock::new();
    CACHE.get_or_init(|| crate::request_pacing::TtlCache::new(Duration::from_secs(5 * 60), 512))
}

async fn api<T: DeserializeOwned>(
    client: &reqwest::Client,
    key: &str,
    path: &str,
    query: &[(String, String)],
) -> Result<T, String> {
    send_json(client, key, reqwest::Method::GET, path, query, None).await
}

async fn api_post<T: DeserializeOwned>(
    client: &reqwest::Client,
    key: &str,
    path: &str,
    body: &serde_json::Value,
) -> Result<T, String> {
    send_json(client, key, reqwest::Method::POST, path, &[], Some(body)).await
}

/// Runs requests for the task that owns the current operation, so a cancel
/// drops them at once, with their pacing and retry waits. Only for code that
/// runs inside that task (installs, updates, the update check): searches and
/// project details are not tasks and must not stop with someone else's.
pub(crate) async fn in_task<T>(
    state: &LauncherState,
    requests: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    state.control.during_cancellable_io(requests).await?
}

/// The answer to a 404: a project or file CurseForge no longer has.
pub(crate) const NOT_FOUND: &str = "CurseForge 项目或文件不存在";
pub(crate) const CF_UNREACHABLE: &str = "CurseForge 连接失败，请检查网络后重试";
pub(crate) const CF_READ_FAILED: &str = "读取 CurseForge 数据失败";
pub(crate) const CF_REFUSED: &str = "CurseForge 拒绝访问，请检查你自己的 API Key、账号权限或该资源的第三方分发授权";
pub(crate) const CF_RATE_LIMITED: &str = "CurseForge 请求过于频繁，请稍后重试";
/// Followed by the status and a closing parenthesis.
pub(crate) const CF_HTTP_FAILED: &str = "CurseForge 请求失败（HTTP ";

/// One attempt's outcome: the body of a success, a retryable failure (with any
/// Retry-After value), or a final failure.
enum Attempt {
    Done(Vec<u8>),
    Retry(Option<String>, String),
    Fail(String),
}

async fn send_json<T: DeserializeOwned>(
    client: &reqwest::Client,
    key: &str,
    method: reqwest::Method,
    path: &str,
    query: &[(String, String)],
    body: Option<&serde_json::Value>,
) -> Result<T, String> {
    let base = curseforge_api();
    let body = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(|_| "CurseForge 请求内容无效")?;
    let cache_key = format!(
        "{base}\u{1f}{}",
        crate::request_pacing::cache_key(method.as_str(), path, query, body.as_deref())
    );
    if let Some(bytes) = answer_cache().get(&cache_key, Instant::now()) {
        return serde_json::from_slice(&bytes).map_err(|_| "CurseForge 数据格式无法解析".into());
    }
    let header = crate::curseforge_key::sensitive_cf_header(key)?;
    let mut attempt = 0;
    let bytes = loop {
        let wait = PACER.reserve(Instant::now());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        let mut request = client
            .request(method.clone(), format!("{base}/{path}"))
            .query(query)
            .header("x-api-key", header.clone());
        if let Some(body) = &body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.clone());
        }
        let outcome = match request.send().await {
            Ok(response) => read_answer(response).await,
            Err(_) => Attempt::Retry(None, CF_UNREACHABLE.into()),
        };
        match outcome {
            Attempt::Done(bytes) => break bytes,
            Attempt::Fail(error) => return Err(error),
            Attempt::Retry(retry_after, error) => {
                attempt += 1;
                match crate::request_pacing::retry_delay(
                    retry_after.as_deref(),
                    attempt,
                    MAX_RETRIES,
                    Duration::from_millis(500),
                    Duration::from_secs(10),
                    chrono::Utc::now(),
                ) {
                    Some(delay) => tokio::time::sleep(delay).await,
                    None => return Err(error),
                }
            }
        }
    };
    let value = serde_json::from_slice(&bytes).map_err(|_| "CurseForge 数据格式无法解析".to_string())?;
    answer_cache().insert(cache_key, bytes, Instant::now());
    Ok(value)
}

async fn read_answer(response: reqwest::Response) -> Attempt {
    let status = response.status().as_u16();
    match status {
        407 => {
            return Attempt::Fail(crate::network::Error::Authentication.code().into())
        }
        401 | 403 => {
            return Attempt::Fail(
                CF_REFUSED.into(),
            )
        }
        404 => return Attempt::Fail(NOT_FOUND.into()),
        429 | 500..=599 => {
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let error = if status == 429 {
                CF_RATE_LIMITED.to_string()
            } else {
                format!("{CF_HTTP_FAILED}{status}）")
            };
            return Attempt::Retry(retry_after, error);
        }
        _ if !response.status().is_success() => {
            return Attempt::Fail(format!("{CF_HTTP_FAILED}{status}）"))
        }
        _ => {}
    }
    if response.content_length().is_some_and(|n| n > MAX_METADATA as u64) {
        return Attempt::Fail("CurseForge 元数据过大".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return Attempt::Retry(None, CF_READ_FAILED.into());
        };
        if bytes.len().saturating_add(chunk.len()) > MAX_METADATA {
            return Attempt::Fail("CurseForge 元数据超过限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Attempt::Done(bytes)
}
fn download_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "CurseForge 下载地址无效")?;
    let hosts = [
        "mediafilez.forgecdn.net",
        "edge.forgecdn.net",
        "media.forgecdn.net",
    ];
    // Tests serve the CDN over plain HTTP on a loopback port (TestEndpoints).
    let test_http = cfg!(test) && url.scheme() == "http" && url.port().is_some();
    if (url.scheme() != "https" && !test_http)
        || (!test_http && url.port_or_known_default() != Some(443))
        || !hosts.contains(&url.host_str().unwrap_or(""))
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("下载地址不是允许的 CurseForge 官方 CDN HTTPS 地址".into());
    }
    Ok(url)
}
/// Whether `value` is a trusted HTTPS link on `www.curseforge.com` (default
/// port, no credentials).
fn trusted_curseforge_page(value: &str) -> bool {
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("www.curseforge.com")
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
    })
}
/// The project's CurseForge page: its own API link when that is HTTPS on
/// `www.curseforge.com` without credentials, otherwise the page for its id.
fn project_page(project: &Project) -> String {
    project
        .links
        .website_url
        .as_deref()
        .filter(|value| trusted_curseforge_page(value))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("https://www.curseforge.com/projects/{}", project.id))
}
/// Starts the refusal of a CurseForge file the launcher must not download:
/// the file id follows, then a line break and the explanation.
pub(crate) const MANUAL_DOWNLOAD: &str = "CurseForge 文件需要手动下载：";
/// Single restricted-file predicate shared by dependency resolution, pinned
/// validation, downloads, installs and update checks: third-party distribution
/// disabled, missing/empty download URL, or URL outside the official CDN hosts.
fn is_restricted_file(project: &Project, file: &CfFile) -> bool {
    manual_reason(project, file).is_some()
}
fn distribution_error(project: &Project, file: &CfFile) -> String {
    let page = project_page(project);
    format!("{MANUAL_DOWNLOAD}{}\n「{}」文件 {} 禁止第三方分发或未提供可用下载地址。请在项目页面手动下载授权文件并放入目标资源目录：{}。启动器不会拼接下载地址绕过限制。", file.id, project.name, file.id, page)
}

/// A required dependency cannot be fetched by the launcher. The JSON part is
/// split off by `errors::expected` into `resource.dependencyManualDownload`.
pub(crate) const DEPENDENCY_MANUAL_DOWNLOAD: &str = "CurseForge 必需前置需要手动下载：";
fn dependency_manual_error(project: &Project, file: &CfFile, kind: ResourceKind) -> String {
    let page = project_page(project);
    let folder = kind.folder();
    format!(
        "{DEPENDENCY_MANUAL_DOWNLOAD}「{}」文件 {}（{}）禁止第三方分发或未提供可用下载地址。请从 {} 手动下载并放入实例的 {} 目录。\t{}",
        project.name,
        file.file_name,
        file.id,
        page,
        folder,
        serde_json::json!({
            "name": project.name,
            "file": file.file_name,
            "url": page,
            "folder": folder,
        })
    )
}

/// A cross-category required dependency (e.g. a mod needed by a resource pack
/// or shader) is not enabled in its own folder and must be installed first.
pub(crate) const DEPENDENCY_INSTALL_FIRST: &str = "需要先安装跨分类必需前置：";
fn dependency_install_first_error(project: &Project, dep_kind: Option<ResourceKind>) -> String {
    let folder = dep_kind.map(ResourceKind::folder).unwrap_or("");
    format!(
        "{DEPENDENCY_INSTALL_FIRST}「{}」属于其他资源分类，请先在实例中安装此依赖，再重试；当前资源尚未写入。\t{}",
        project.name,
        serde_json::json!({
            "name": project.name,
            "folder": folder,
        })
    )
}

fn dependency_unavailable_error(name: &str, reason: &str) -> String {
    format!(
        "{}{name}\t{reason}",
        crate::errors::RESOURCE_DEPENDENCY_UNAVAILABLE_PREFIX
    )
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
async fn files_page_with_total(
    client: &reqwest::Client,
    key: &str,
    project: u64,
    minecraft: &str,
    loader: Option<&str>,
    offset: usize,
    page_size: u32,
) -> Result<(Vec<CfFile>, Option<u64>), String> {
    let mut query = vec![
        ("pageSize".into(), page_size.to_string()),
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
    Ok((result.data, result.pagination.map(|page| page.total_count)))
}

async fn files_page(
    client: &reqwest::Client,
    key: &str,
    project: u64,
    minecraft: &str,
    loader: Option<&str>,
    offset: usize,
) -> Result<Vec<CfFile>, String> {
    Ok(files_page_with_total(client, key, project, minecraft, loader, offset, 50)
        .await?
        .0)
}

/// The loader tags a CurseForge file declares.
fn loader_tags(file: &CfFile) -> Vec<String> {
    let mut loaders: Vec<_> = file
        .game_versions
        .iter()
        .filter_map(|tag| {
            let tag = tag.to_ascii_lowercase();
            matches!(
                tag.as_str(),
                "fabric" | "quilt" | "forge" | "neoforge" | "iris" | "optifine" | "vanilla"
            )
            .then_some(tag)
        })
        .collect();
    loaders.dedup();
    loaders
}

/// A CurseForge file in the shape the shared dependency planner and resource
/// transaction expect. Downloading still uses the original `CfFile` (SHA-1,
/// MD5, file id and the exact download URL).
fn plan_version(file: &CfFile) -> Version {
    Version {
        id: file.id.to_string(),
        project_id: file.mod_id.to_string(),
        version_type: match file.release_type {
            1 => "release",
            2 => "beta",
            3 => "alpha",
            _ => "unknown",
        }
        .into(),
        name: version_label(file),
        version_number: file.file_name.clone(),
        date_published: file.file_date.clone(),
        game_versions: file.game_versions.clone(),
        loaders: loader_tags(file),
        dependencies: file
            .dependencies
            .iter()
            .map(|dependency| PlanDependency {
                dependency_type: match dependency.relation_type {
                    3 => "required",
                    5 => "incompatible",
                    2 => "optional",
                    // Embedded library, tool and include are not installable
                    // dependencies; unknown relation types are treated the same
                    // way so they never block a normal install.
                    _ => "embedded",
                }
                .into(),
                project_id: Some(dependency.mod_id.to_string()),
                version_id: None,
                file_name: None,
            })
            .collect(),
        environment: String::new(),
        files: vec![ResourceFile {
            filename: file.file_name.clone(),
            url: file.download_url.clone().unwrap_or_default(),
            primary: true,
            size: file.file_length,
            hashes: FileHashes {
                sha512: String::new(),
            },
        }],
    }
}

/// CurseForge dependency lookup for the shared planner. Project and file
/// answers are cached for the duration of one install, so every project is
/// requested at most once. `installed` holds the enabled local files the
/// fingerprint service identified in the target folder (project id → sorted
/// `(file name, file)` entries). `other_installed` lazily caches scans of
/// sibling class folders (e.g. `mods/` when installing a resource pack or
/// shader) for check-only cross-category dependencies.
struct CurseforgeDependencySource<'a> {
    state: &'a LauncherState,
    client: &'a reqwest::Client,
    key: &'a str,
    minecraft: &'a str,
    loader: Option<&'a str>,
    detected_loader: Option<&'a str>,
    game_dir: Option<&'a Path>,
    kind: ResourceKind,
    resource_type: &'a str,
    installed: HashMap<u64, Vec<(String, CfFile)>>,
    other_installed: Mutex<HashMap<u64, HashMap<u64, Vec<(String, CfFile)>>>>,
    projects: Mutex<HashMap<u64, Project>>,
    files: Mutex<HashMap<u64, CfFile>>,
}

impl CurseforgeDependencySource<'_> {
    fn remember(&self, project: Project, file: CfFile) {
        if let Ok(mut projects) = self.projects.lock() {
            projects.insert(project.id, project);
        }
        if let Ok(mut files) = self.files.lock() {
            files.insert(file.id, file);
        }
    }

    fn file(&self, id: &str) -> Option<CfFile> {
        let id = id.parse::<u64>().ok()?;
        if let Some(file) = self.files.lock().ok()?.get(&id).cloned() {
            return Some(file);
        }
        self.installed
            .values()
            .flatten()
            .find(|(_, file)| file.id == id)
            .map(|(_, file)| file.clone())
    }

    async fn project(&self, id: u64) -> Result<Project, String> {
        if let Some(project) = self.projects.lock().ok().and_then(|projects| projects.get(&id).cloned()) {
            return Ok(project);
        }
        self.state.control.checkpoint().await?;
        let answer: Response<Project> = in_task(
            self.state,
            api(self.client, self.key, &format!("mods/{id}"), &[]),
        )
        .await?;
        if answer.data.id != id || answer.data.game_id != 432 {
            let label = if answer.data.name.trim().is_empty() {
                id.to_string()
            } else {
                answer.data.name
            };
            return Err(dependency_unavailable_error(
                &label,
                "CurseForge 必需前置的项目身份或游戏不一致",
            ));
        }
        if let Ok(mut projects) = self.projects.lock() {
            projects.insert(id, answer.data.clone());
        }
        Ok(answer.data)
    }

    /// Cross-category and unknown-class (`class_id: None`) dependencies are
    /// check-only: never install them into a folder whose kind does not match.
    /// Check the folder matching the dependency's class under `game_dir`,
    /// counting enabled files only.
    async fn check_cross_category(&self, project: &Project) -> Result<(), String> {
        let dep_class = project.class_id.unwrap_or(0);
        let Some(dep_kind) = kind_for_class(dep_class) else {
            return Err(dependency_install_first_error(project, None));
        };
        let Some(game_dir) = self.game_dir else {
            return Err(dependency_install_first_error(project, Some(dep_kind)));
        };
        let dep_loader = (dep_kind == ResourceKind::Mod)
            .then_some(self.detected_loader)
            .flatten();
        if dep_kind == ResourceKind::Mod && dep_loader.is_none() {
            return Err(dependency_install_first_error(project, Some(dep_kind)));
        }
        let cached = self
            .other_installed
            .lock()
            .ok()
            .and_then(|map| map.get(&dep_class).cloned());
        let found = match cached {
            Some(found) => found,
            None => {
                let dep_dir = safe_join(game_dir, dep_kind.folder())?;
                let scanned = if dep_dir.exists() {
                    installed_dependencies(self.state, self.client, self.key, &dep_dir, dep_kind, None)
                        .await?
                } else {
                    HashMap::new()
                };
                if let Ok(mut map) = self.other_installed.lock() {
                    map.insert(dep_class, scanned.clone());
                }
                scanned
            }
        };
        let present = found.get(&project.id).is_some_and(|files| {
            files
                .iter()
                .any(|(_, file)| compatible(file, self.minecraft, dep_loader))
        });
        if present {
            Ok(())
        } else {
            Err(dependency_install_first_error(project, Some(dep_kind)))
        }
    }

    /// Newest compatible release first, then the newest beta, and only then
    /// another release type (an alpha or a file whose type is unset).
    async fn selected_file(&self, project: &Project) -> Result<CfFile, String> {
        let loader = (self.kind == ResourceKind::Mod)
            .then_some(self.loader)
            .flatten();
        let mut release: Option<CfFile> = None;
        let mut beta: Option<CfFile> = None;
        let mut other: Option<CfFile> = None;
        for page in 0..10 {
            self.state.control.checkpoint().await?;
            let files = in_task(
                self.state,
                files_page(self.client, self.key, project.id, self.minecraft, loader, page * 50),
            )
            .await?;
            let short = files.len() < 50;
            for file in files {
                if !compatible(&file, self.minecraft, loader) {
                    continue;
                }
                let is_newer =
                    |best: &Option<CfFile>| best.as_ref().is_none_or(|best| newer(&file, best));
                match file.release_type {
                    1 if is_newer(&release) => release = Some(file),
                    2 if is_newer(&beta) => beta = Some(file),
                    _ if is_newer(&other) => other = Some(file),
                    _ => {}
                }
            }
            // Pages are newest first: the first release found is the newest.
            if release.is_some() || short {
                break;
            }
        }
        let file = release.or(beta).or(other).ok_or_else(|| {
            dependency_unavailable_error(
                &project.name,
                &format!(
                    "CurseForge 必需前置「{}」没有适用于当前游戏版本和加载器的文件",
                    project.name
                ),
            )
        })?;
        validate_id(&file.file_name)
            .map_err(|reason| dependency_unavailable_error(&project.name, &reason))?;
        if !self.kind.accepts(&file.file_name) {
            return Err(dependency_unavailable_error(
                &project.name,
                "CurseForge 必需前置文件类型与资源分类不匹配",
            ));
        }
        if file.file_length == 0 || file.file_length > MAX_FILE {
            return Err(dependency_unavailable_error(
                &project.name,
                "CurseForge 必需前置文件大小无效或超过 1 GiB",
            ));
        }
        if is_restricted_file(project, &file) {
            return Err(dependency_manual_error(project, &file, self.kind));
        }
        expected_hashes(&file)
            .map_err(|reason| dependency_unavailable_error(&project.name, &reason))?;
        if let Ok(mut files) = self.files.lock() {
            files.insert(file.id, file.clone());
        }
        Ok(file)
    }
}

impl DependencySource for CurseforgeDependencySource<'_> {
    async fn resolve_required(&self, project: &str) -> Result<RequiredResolution, String> {
        let id = project_id(project)?;
        let project = self.project(id).await?;
        let expected_class = class_id(self.resource_type)?;
        if project.class_id != Some(expected_class) {
            self.check_cross_category(&project).await?;
            return Ok(RequiredResolution::SatisfiedExternal);
        }
        let file = self.selected_file(&project).await?;
        Ok(RequiredResolution::Versions(vec![plan_version(&file)]))
    }

    async fn pinned_version(
        &self,
        _project: Option<&str>,
        _version: &str,
    ) -> Result<Version, String> {
        // CurseForge dependencies name a project, never a pinned file.
        Err("CurseForge 必需前置不支持固定文件版本".into())
    }

    fn installed(&self, project: &str) -> Vec<Version> {
        let Ok(id) = project_id(project) else {
            return Vec::new();
        };
        self.installed
            .get(&id)
            .map(|files| files.iter().map(|(_, file)| plan_version(file)).collect())
            .unwrap_or_default()
    }

    async fn project_label(&self, project: &str) -> String {
        let Ok(id) = project_id(project) else {
            return project.to_owned();
        };
        let local_name = self
            .installed
            .get(&id)
            .and_then(|files| files.first())
            .map(|(name, _)| name.clone());
        let project_name = if let Some(cached) = self
            .projects
            .lock()
            .ok()
            .and_then(|projects| projects.get(&id).map(|project| project.name.clone()))
        {
            Some(cached)
        } else {
            self.project(id).await.ok().map(|project| project.name)
        };
        match (project_name, local_name) {
            (Some(name), Some(file)) => format!("{name} ({file})"),
            (Some(name), None) => name,
            (None, Some(file)) => file,
            (None, None) => project.to_owned(),
        }
    }
}

/// Groups identified local files by project id in deterministic order:
/// preferring `preferred` `(mod_id, file_id)` first, then sorted by filename
/// and file id.
fn group_installed(
    identified: HashMap<String, (u64, CfFile)>,
    preferred: Option<(u64, u64)>,
) -> HashMap<u64, Vec<(String, CfFile)>> {
    let mut entries: Vec<(String, CfFile)> = identified
        .into_iter()
        .map(|(name, (_, file))| (name, file))
        .collect();
    entries.sort_by(|(left_name, left_file), (right_name, right_file)| {
        let left_pref = preferred == Some((left_file.mod_id, left_file.id));
        let right_pref = preferred == Some((right_file.mod_id, right_file.id));
        right_pref
            .cmp(&left_pref)
            .then_with(|| left_name.cmp(right_name))
            .then_with(|| left_file.id.cmp(&right_file.id))
    });
    let mut found: HashMap<u64, Vec<(String, CfFile)>> = HashMap::new();
    for (name, file) in entries {
        found.entry(file.mod_id).or_default().push((name, file));
    }
    found
}

/// The enabled local files CurseForge identifies, keyed by project id, in
/// deterministic order: preferring `preferred` `(mod_id, file_id)` first, then
/// sorted by filename and file id. Disabled `.disabled` files are excluded.
async fn installed_dependencies(
    state: &LauncherState,
    client: &reqwest::Client,
    key: &str,
    directory: &Path,
    kind: ResourceKind,
    preferred: Option<(u64, u64)>,
) -> Result<HashMap<u64, Vec<(String, CfFile)>>, String> {
    let mut names = candidate_names(directory, kind, &HashSet::new());
    names.retain(|(_, enabled)| *enabled);
    if names.is_empty() {
        return Ok(HashMap::new());
    }
    let locals = local_files(state, directory, names).await?;
    if locals.is_empty() {
        return Ok(HashMap::new());
    }
    let identified = in_task(state, identify(client, key, &locals)).await?;
    Ok(group_installed(identified, preferred))
}

/// Validates a Discover search and builds its `mods/search` parameters, with
/// the class the hits must belong to. Building it sends nothing.
pub(crate) fn curseforge_search_query(
    query: String,
    resource_type: &str,
    game_version: Option<String>,
    loader: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
    sort: Option<&str>,
) -> Result<(u64, crate::resources::SearchQuery), String> {
    use crate::resources::invalid_request;
    if query.len() > 500 || query.chars().any(char::is_control) {
        return Err(invalid_request("搜索内容过长或包含无效字符"));
    }
    let class = class_id(resource_type).map_err(invalid_request)?;
    let limit = crate::resources::search_limit(limit)?;
    let offset = crate::resources::search_offset(offset, limit)?;
    let (sort_field, sort_order) = crate::resources::curseforge_sort(sort)?;
    let mut params = vec![
        ("gameId".into(), "432".into()),
        ("classId".into(), class.to_string()),
        ("searchFilter".into(), query),
        ("pageSize".into(), limit.to_string()),
        ("index".into(), offset.to_string()),
        ("sortField".into(), sort_field.to_string()),
        ("sortOrder".into(), sort_order.into()),
    ];
    if let Some(game) = game_version.filter(|v| !v.is_empty()) {
        validate_id(&game).map_err(invalid_request)?;
        params.push(("gameVersion".into(), game));
    }
    if let Some(loader) = loader.filter(|v| !v.is_empty()) {
        let code = loader_code(&loader).map_err(invalid_request)?;
        if code != 0 {
            params.push(("modLoaderType".into(), code.to_string()));
        }
    }
    Ok((
        class,
        crate::resources::SearchQuery {
            params,
            offset,
            limit,
        },
    ))
}

pub(crate) async fn search_curseforge_inner(
    state: &LauncherState,
    query: String,
    resource_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
    sort: Option<String>,
) -> Result<SearchResult, String> {
    let (class, request) = curseforge_search_query(
        query,
        &resource_type,
        game_version,
        loader,
        offset,
        limit,
        sort.as_deref(),
    )?;
    let key = service_key(state)?;
    let client = api_client(state)?;
    let result: Response<Vec<Project>> = api(&client, &key, "mods/search", &request.params).await?;
    let total_hits = result.pagination.map(|page| page.total_count);
    let next_offset =
        crate::resources::next_search_offset(request.offset, request.limit, result.data.len());
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
    Ok(SearchResult {
        hits,
        total_hits,
        next_offset,
    })
}

/// What the Discover command runs: the page, or a failure with a Discover code.
pub(crate) async fn search_curseforge_for_discover(
    state: &LauncherState,
    query: String,
    resource_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
    sort: Option<String>,
) -> AppResult<SearchResult> {
    search_curseforge_inner(
        state,
        query,
        resource_type,
        game_version,
        loader,
        offset,
        limit,
        sort,
    )
    .await
    .map_err(|error| discover_failure(DiscoverSource::CurseForge, error))
}

#[tauri::command]
pub async fn search_curseforge(
    state: State<'_, Arc<LauncherState>>,
    query: String,
    resource_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
    sort: Option<String>,
) -> AppResult<SearchResult> {
    search_curseforge_for_discover(
        &state,
        query,
        resource_type,
        game_version,
        loader,
        offset,
        limit,
        sort,
    )
    .await
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
            in_task(state, api(client, key, &format!("mods/{}", dependency.mod_id), &[])).await?;
        let class = project.data.class_id.unwrap_or(0);
        let known = installed.get(&class);
        let dependency_loader = (class == 6).then_some(loader).flatten();
        let mut found = None;
        if known.is_some_and(|hashes| !hashes.is_empty()) {
            for offset in (0..500).step_by(50) {
                state.control.checkpoint().await?;
                let files = in_task(
                    state,
                    files_page(client, key, dependency.mod_id, minecraft, dependency_loader, offset),
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

#[allow(clippy::too_many_arguments)]
async fn download(
    state: &LauncherState,
    project: &Project,
    file: &CfFile,
    directory: &Path,
    kind: ResourceKind,
    duplicates: Duplicates<'_>,
    reuse: Option<&crate::parts::Reuse>,
    progress: Option<&crate::resources::ResourceProgress>,
) -> Result<StagedFile, String> {
    validate_id(&file.file_name)?;
    if !kind.accepts(&file.file_name) {
        return Err("CurseForge 文件类型与资源分类不匹配".into());
    }
    if is_restricted_file(project, file) {
        return Err(distribution_error(project, file));
    }
    let expected = expected_hashes(file)?;
    if file.file_length == 0 || file.file_length > MAX_FILE {
        return Err("CurseForge 文件大小无效或超过 1 GiB".into());
    }
    let url = download_url(file.download_url.as_deref().ok_or("资源缺少下载地址")?)?;
    if let Some(progress) = progress {
        progress.emit(
            state,
            "resource-download",
            0,
            1,
            0,
            file.file_length,
            &format!("下载 {}", file.file_name),
        );
    }
    crate::instances::checked_absolute(directory)?;
    fs::create_dir_all(directory).map_err(|_| "无法创建资源目录")?;
    let target = safe_join(directory, &file.file_name)?;
    let staged = kind == ResourceKind::Mod && matches!(duplicates, Duplicates::SetAside(_));
    if target.exists() {
        if target.is_file() && matches(&file_hashes(&target)?, file.file_length, &expected) {
            if let Duplicates::SetAside(aside) = duplicates {
                if kind == ResourceKind::Mod {
                    set_aside_duplicate_mods(&target, directory, &target, aside)?;
                    // The selected file itself must still be there (its name may
                    // differ in case only); otherwise nothing is committed.
                    if !target.is_file() {
                        return Err("选定文件已不在暂存目录中，原目录未改变".into());
                    }
                }
            }
            if let Some(progress) = progress {
                progress.emit(
                    state,
                    "resource-download",
                    1,
                    1,
                    file.file_length,
                    file.file_length,
                    &format!("复用已校验文件 {}", file.file_name),
                );
            }
            return Ok(StagedFile {
                path: target,
                written: false,
            });
        }
        // In a staged replace a same-named enabled copy of this mod is set aside
        // below; any other same-named file is still refused there.
        if !staged {
            return Err(format!(
            "已存在内容不同的同名文件 {}，已保留原文件，请先备份或重命名",
            file.file_name
        ));
        }
    }
    let builder = reqwest::Client::builder()
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
        }));
    #[cfg(test)]
    let builder = match crate::resources::test_endpoints() {
        Some(endpoints) => ["mediafilez.forgecdn.net", "edge.forgecdn.net", "media.forgecdn.net"]
            .into_iter()
            .fold(builder, |builder, host| builder.resolve(host, endpoints.cdn)),
        None => builder,
    };
    let client = crate::network::for_state_builder(state, builder)?
        .build()
        .map_err(|_| "无法创建资源下载客户端")?;
    let temporary = safe_join(
        directory,
        &format!(".curseforge-{}.part", uuid::Uuid::new_v4()),
    )?;
    let result = async {
        if !download_part(state, &client, &url, file, &expected, reuse, &temporary, progress).await? {
            let _connection = state.control.connection().await?;
            // Downloads run inside a task: a cancel drops a stalled connection at once.
            let response = state
                .control
                .during_cancellable_io(client.get(url).send())
                .await?
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
            while let Some(chunk) = state.control.during_cancellable_io(stream.next()).await? {
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
                if let Some(progress) = progress {
                    progress.emit(
                        state,
                        "resource-download",
                        0,
                        1,
                        count,
                        file.file_length,
                        &format!("下载 {}", file.file_name),
                    );
                }
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
        }
        state.control.checkpoint().await?;
        crate::instances::checked_absolute(directory)?;
        let target = safe_join(directory, &file.file_name)?;
        if kind == ResourceKind::Mod {
            match duplicates {
                // A staged copy: other enabled copies (a same-named one included) move aside, journaled.
                Duplicates::SetAside(aside) => set_aside_duplicate_mods(&temporary, directory, &temporary, aside)?,
                Duplicates::Refuse => refuse_duplicate_mod(&temporary, directory, &target)?,
                Duplicates::Keep => {}
            }
        }
        if target.exists() {
            return Err("下载期间出现同名文件，现有文件未覆盖".into());
        }
        // H08: publish without replacing a file that appeared meanwhile.
        crate::instances::publish_archive_file(&temporary, &target)
            .map_err(|_| "无法提交已校验资源：目标文件已存在或无法写入，现有文件未覆盖")?;
        if let Some(reuse) = reuse {
            reuse.moved(&temporary, &target);
        }
        if let Some(progress) = progress {
            progress.emit(
                state,
                "resource-download",
                1,
                1,
                file.file_length,
                file.file_length,
                &format!("已校验 {}", file.file_name),
            );
        }
        Ok(StagedFile {
            path: target,
            written: true,
        })
    }
    .await;
    if result.is_err() {
        // A verified file goes back to its part before the leftovers go.
        if let Some(reuse) = reuse {
            reuse.restore();
        }
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

/// Brings `file` into `temporary` through its resumable part (1 MiB or more,
/// with a SHA-1). The part lives beside the game folder, outside any staged
/// copy, so a failed or cancelled install leaves it for the next one. False
/// when there is no part (a small file, no SHA-1, a folder elsewhere, a part
/// held by another download, or an unusable parts folder): the caller
/// downloads in one go.
#[allow(clippy::too_many_arguments)]
async fn download_part(
    state: &LauncherState,
    client: &reqwest::Client,
    url: &reqwest::Url,
    file: &CfFile,
    expected: &[(u32, String)],
    reuse: Option<&crate::parts::Reuse>,
    temporary: &Path,
    progress: Option<&crate::resources::ResourceProgress>,
) -> Result<bool, String> {
    let key = expected
        .iter()
        .find(|(algo, _)| *algo == 1)
        .and_then(|(_, hex)| crate::parts::PartKey::new(crate::parts::Algo::Sha1, hex, file.file_length))
        .filter(|_| file.file_length >= crate::parts::RESUME_MIN);
    let (Some(key), Some(reuse)) = (key, reuse) else { return Ok(false) };
    // Held by another download, or a parts folder that cannot be used.
    let Some(part) = reuse.store().open(&key, file.file_length).ok().flatten() else {
        return Ok(false);
    };
    let mut slot = Some(part);
    let mut sha1 = Sha1::new();
    let mut md5 = md5::Context::new();
    let control = &state.control;
    let report = |done: u64| {
        if let Some(progress) = progress {
            progress.emit(
                state,
                "resource-download",
                0,
                1,
                done,
                file.file_length,
                &format!("下载 {}", file.file_name),
            );
        }
    };
    let reporting = crate::parts::Reporting {
        hooks: &control,
        report: &report,
    };
    let transferred = crate::parts::transfer(
        client.get(url.clone()),
        url,
        &mut slot,
        file.file_length,
        &reporting,
        &|response| download_url(response.url().as_str()).map(|_| ()),
        &mut |bytes| {
            sha1.update(bytes);
            md5.consume(bytes);
        },
    )
    .await;
    if let Err(error) = transferred {
        if error == crate::parts::OVERRUN {
            // Bytes from an answer longer than the file are not continued.
            if let Some(part) = slot.take() {
                part.discard();
            }
        }
        return Err(crate::resources::transfer_message(error, "CurseForge"));
    }
    let part = slot.take().ok_or("资源下载分片不可用")?;
    let values = (format!("{:x}", sha1.finalize()), format!("{:x}", md5.compute()), file.file_length);
    if !matches(&values, file.file_length, expected) {
        part.discard();
        return Err("CurseForge SHA-1 / MD5 或大小校验失败，文件未安装".into());
    }
    crate::parts::publish_new_off_task(part, temporary)
        .await
        .map_err(|_| "无法移入已校验的资源文件，原目录未改变")?;
    // Back to its part if the install does not complete.
    reuse.add(&key, file.file_length, temporary);
    Ok(true)
}

/// Moves a downloaded file to its `.disabled` name in the stage without
/// replacing anything there; the stage's list of verified downloads follows.
fn publish_disabled(downloaded: &Path, next: &Path, file_name: &str, reuse: Option<&crate::parts::Reuse>) -> Result<PathBuf, String> {
    let disabled = safe_join(next, &format!("{file_name}.disabled"))?;
    crate::instances::publish_archive_file(downloaded, &disabled)
        .map_err(|_| "已存在同名的停用文件，原目录未改变".to_string())?;
    if let Some(reuse) = reuse {
        reuse.moved(downloaded, &disabled);
    }
    Ok(disabled)
}

/// What a download does about other enabled copies of the same mod.
#[derive(Clone, Copy)]
enum Duplicates<'a> {
    /// A new instance: refuse to add a second enabled copy. Kept for the
    /// download-level tests; installs now stage every copy through SetAside.
    #[allow(dead_code)]
    Refuse,
    /// A staged copy: move them into this folder (journaled, can be rolled back).
    SetAside(&'a Path),
    /// A disabled file is being updated: enabled copies are not touched.
    Keep,
}

/// In a staged copy, moves every enabled jar other than `keep` declaring the
/// mod ID of `downloaded` into `aside`, so the replacement is journaled and can
/// be rolled back. Disabled copies and jars without a readable ID stay.
fn set_aside_duplicate_mods(downloaded: &Path, directory: &Path, keep: &Path, aside: &Path) -> Result<(), String> {
    let Some(mod_id) = crate::mod_metadata::declared_mod_id(downloaded) else {
        return Ok(());
    };
    for name in crate::mod_metadata::enabled_jars_with_mod_id(directory, &mod_id, keep) {
        let destination = safe_join(aside, &name)?;
        if destination.exists() {
            return Err("暂存的替换目录中已有同名文件，原目录未改变".into());
        }
        fs::rename(safe_join(directory, &name)?, destination).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Never leaves two enabled copies of one mod. A JAR
/// whose mod ID cannot be read keeps the previous behaviour.
fn refuse_duplicate_mod(downloaded: &Path, directory: &Path, target: &Path) -> Result<(), String> {
    let Some(mod_id) = crate::mod_metadata::declared_mod_id(downloaded) else {
        return Ok(());
    };
    match crate::mod_metadata::enabled_jar_with_mod_id(directory, &mod_id, target) {
        Some(existing) => Err(format!(
            "已启用的 {existing} 声明了同一个模组（{mod_id}），新版本未安装。请先停用或删除它，再安装这个版本"
        )),
        None => Ok(()),
    }
}

use crate::resource_targets::{ManualDownload, ManualReason, ResourceTargetPlan, TargetCandidate, VersionLite};

async fn fetch_pinned_file(
    client: &reqwest::Client,
    key: &str,
    project_id: &str,
    resource_type: &str,
    file_id: u64,
) -> AppResult<(Project, CfFile)> {
    let id = self::project_id(project_id)?;
    if !(1..=u64::from(u32::MAX)).contains(&file_id) {
        return Err("CurseForge 文件标识无效".into());
    }
    let project: Response<Project> = api(client, key, &format!("mods/{id}"), &[]).await?;
    if project.data.id != id || project.data.game_id != 432 || project.data.class_id != Some(class_id(resource_type)?) {
        return Err("CurseForge 项目身份、游戏或分类不一致".into());
    }
    let file: Response<CfFile> = api(client, key, &format!("mods/{id}/files/{file_id}"), &[]).await?;
    Ok((project.data, file.data))
}

async fn get_pinned_file(
    client: &reqwest::Client,
    key: &str,
    project_id: &str,
    resource_type: &str,
    file_id: u64,
    kind: ResourceKind,
) -> AppResult<(Project, CfFile)> {
    let (project, file) = fetch_pinned_file(client, key, project_id, resource_type, file_id).await?;
    validate_pinned_file(&project, &file, file_id, kind)?;
    Ok((project, file))
}

/// Planning only needs the file's identity and compatibility. A manual-only
/// file is not an error at this point: the picker explains it and the install
/// command still refuses it.
async fn get_pinned_file_for_plan(
    client: &reqwest::Client,
    key: &str,
    project_id: &str,
    resource_type: &str,
    file_id: u64,
    kind: ResourceKind,
) -> AppResult<(Project, CfFile)> {
    let (project, file) = fetch_pinned_file(client, key, project_id, resource_type, file_id).await?;
    // A file the launcher may download must still pass every install check.
    if manual_reason(&project, &file).is_some() {
        validate_pinned_file_metadata(&project, &file, file_id, kind)?;
    } else {
        validate_pinned_file(&project, &file, file_id, kind)?;
    }
    Ok((project, file))
}

fn validate_pinned_file_metadata(project: &Project, file: &CfFile, file_id: u64, kind: ResourceKind) -> Result<(), String> {
    if file.id != file_id || file.mod_id != project.id {
        return Err("CurseForge 文件不属于所选项目".into());
    }
    if !file.is_available || file.is_server_pack || (file.game_id != 0 && file.game_id != 432) {
        return Err("CurseForge 文件不可用于 Minecraft 客户端".into());
    }
    validate_id(&file.file_name)?;
    if !kind.accepts(&file.file_name) {
        return Err("CurseForge 文件类型与资源分类不匹配".into());
    }
    if file.file_length == 0 || file.file_length > MAX_FILE {
        return Err("CurseForge 文件大小无效或超过 1 GiB".into());
    }
    Ok(())
}

fn validate_pinned_file(project: &Project, file: &CfFile, file_id: u64, kind: ResourceKind) -> Result<(), String> {
    validate_pinned_file_metadata(project, file, file_id, kind)?;
    if is_restricted_file(project, file) {
        return Err(distribution_error(project, file));
    }
    expected_hashes(file)?;
    Ok(())
}

/// The install refuses every file the plan marks manual-only, with the stable
/// prefix the picker uses to show the manual-download section.
fn manual_install_refusal(project: &Project, file: &CfFile) -> Option<String> {
    manual_reason(project, file).map(|_| distribution_error(project, file))
}

/// Why the launcher must not download `file`, if it must not, in the order
/// the install checks refuse it.
fn manual_reason(project: &Project, file: &CfFile) -> Option<ManualReason> {
    if project.allow_mod_distribution == Some(false) {
        return Some(ManualReason::DistributionForbidden);
    }
    match file.download_url.as_deref().filter(|url| !url.is_empty()) {
        None => Some(ManualReason::NoDownloadUrl),
        Some(url) if download_url(url).is_err() => Some(ManualReason::UntrustedUrl),
        Some(_) => None,
    }
}

/// The file's CurseForge page. It is built only from the project's own
/// `https://www.curseforge.com/minecraft/{section}/{slug}` link and the file
/// id, both inside the opener's scope; any other link gives the project page.
fn file_page(project: &Project, file: &CfFile) -> String {
    project
        .links
        .website_url
        .as_deref()
        .and_then(|value| reqwest::Url::parse(value).ok())
        .filter(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("www.curseforge.com")
                && url.port().is_none()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
        .and_then(|url| {
            let segments: Vec<String> = url.path_segments()?.filter(|part| !part.is_empty()).map(str::to_owned).collect();
            match segments.as_slice() {
                [game, section, slug]
                    if game == "minecraft"
                        && ["mc-mods", "shaders", "texture-packs"].contains(&section.as_str())
                        && slug.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
                {
                    Some(format!("https://www.curseforge.com/minecraft/{section}/{slug}/files/{}", file.id))
                }
                _ => None,
            }
        })
        .unwrap_or_else(|| format!("https://www.curseforge.com/projects/{}", project.id))
}

fn manual_download(project: &Project, file: &CfFile) -> Option<ManualDownload> {
    manual_reason(project, file).map(|reason| ManualDownload {
        reason,
        url: file_page(project, file),
        display_name: version_label(file),
        file_name: file.file_name.clone(),
    })
}

fn pinned_metadata(file: &CfFile, kind: ResourceKind) -> VersionLite {
    let mut loaders = loader_tags(file);
    // A CurseForge resource-pack ZIP with no loader/renderer tags uses the
    // vanilla resource-pack format. Do not apply that inference to mods/shaders.
    if kind == ResourceKind::ResourcePack && loaders.is_empty() {
        loaders.push("vanilla".into());
    }
    VersionLite { id: file.id.to_string(), game_versions: file.game_versions.clone(), loaders,
        version_type: "release".into(), date_published: file.file_date.clone() }
}

fn pinned_target_plan(
    project_id: &str,
    resource_type: &str,
    kind: ResourceKind,
    project: &Project,
    file: &CfFile,
    targets: &[TargetCandidate],
    manifest: &[(String, String)],
) -> ResourceTargetPlan {
    let mut plan = crate::resource_targets::build_pinned_plan(
        project_id, &project.name, resource_type, kind, targets, &pinned_metadata(file, kind), manifest,
    );
    plan.mark_manual_download(manual_download(project, file));
    plan
}

pub(crate) async fn resolve_pinned_targets(
    state: &LauncherState,
    project_id: &str,
    resource_type: &str,
    file_id: u64,
) -> AppResult<ResourceTargetPlan> {
    ResourceKind::parse(resource_type)?;
    let key = service_key(state)?;
    let client = api_client(state)?;
    pinned_targets(state, &client, &key, project_id, resource_type, file_id, crate::minecraft::manifest(state)).await
}

/// The plan for one CurseForge file. A file the launcher must not download
/// is planned with its manual-download details rather than refused.
async fn pinned_targets(
    state: &LauncherState,
    client: &reqwest::Client,
    key: &str,
    project_id: &str,
    resource_type: &str,
    file_id: u64,
    manifest: impl std::future::Future<Output = Result<serde_json::Value, String>>,
) -> AppResult<ResourceTargetPlan> {
    let kind = ResourceKind::parse(resource_type)?;
    let (project, file) = get_pinned_file_for_plan(client, key, project_id, resource_type, file_id, kind).await?;
    let manifest = crate::resources::manifest_releases(manifest.await);
    let targets = crate::resources::target_candidates(state)?;
    Ok(pinned_target_plan(project_id, resource_type, kind, &project, &file, &targets, &manifest))
}

pub(crate) async fn create_with_pinned_file(
    state: &Arc<LauncherState>,
    app: Option<&tauri::AppHandle>,
    task_id: &str,
    request: crate::downloads::ResourceRequest,
) -> AppResult<crate::resources::ResourceInstanceResult> {
    use crate::downloads::ResourceTarget;
    use crate::resources::{create_resource_instance_then_install, require_resource_stopped, resource_target,
        with_reserved_resource_task, ResourceProgress};
    let ResourceTarget::Create { game_version, loader, loader_version, name, file_id: Some(file_id), .. } = request.target.clone() else {
        return Err("请选择要安装的 CurseForge 文件".into());
    };
    let (project_id, resource_type) = (request.project_id.clone(), request.resource_type.clone());
    let (game_version, loader, loader_version, name) = (game_version.as_str(), loader.as_str(), loader_version.as_deref(), name.as_str());
    let (project_id, resource_type) = (project_id.as_str(), resource_type.as_str());
    with_reserved_resource_task(state, task_id, request.clone(), async {
        let kind = ResourceKind::parse(resource_type)?;
        let name = crate::commands::validate_instance_name(name)?;
        let progress = ResourceProgress::new(app, game_version);
        progress.stage(state, "resource-preflight", "检查资源及必需前置");
        let key = service_key(state)?;
        let client = api_client(state)?;
        let (project, file) = state.control
            .during_cancellable_io(get_pinned_file(&client, &key, project_id, resource_type, file_id, kind))
            .await??;
        crate::resource_targets::validate_pinned_creation_pair(&pinned_metadata(&file, kind), kind, loader, game_version)?;
        // A blank instance has nothing installed yet, so this preflight only
        // resolves the dependency graph. It still refuses restricted, missing
        // cross-category, or unavailable required dependencies before the
        // loader or the instance is created.
        prepare_install(
            state,
            &client,
            &key,
            &project,
            &file,
            None,
            game_version,
            (kind == ResourceKind::Mod).then_some(loader),
            (loader != "vanilla").then_some(loader),
            kind,
            resource_type,
        )
        .await?;
        state.control.checkpoint().await?;
        progress.stage(state, "resource-loader", "安装 Minecraft 及加载器");
        let parents = crate::commands::LoaderParents::before_active_install(state);
        let version_id = match crate::resources::prepared_version() {
            Some(version_id) => version_id,
            None => {
                let app = app.ok_or_else(|| crate::errors::AppError::from("创建实例需要启动器窗口"))?;
                if loader == "vanilla" {
                    crate::minecraft::install(state, app, game_version).await?;
                    game_version.to_owned()
                } else {
                    crate::loaders::install_loader_inner(state, app, loader, game_version, loader_version.unwrap_or("latest")).await?.version_id
                }
            }
        };
        progress.stage(state, "resource-create", "创建实例");
        let derived_from = parents.derived_from(&version_id, &name);
        create_resource_instance_then_install(state, task_id, name, version_id.clone(), derived_from, move |instance| async move {
            let version_id = instance.version_id.clone();
            require_resource_stopped(state, &version_id, Some(&instance.id))?;
            let target = resource_target(state, &version_id, Some(&instance.id), kind)?;
            crate::resources::resource_transactions::require_no_pending(&target.directory)?;
            progress.stage(state, "resource-plan", "检查资源及必需前置");
            // The instance may share a game root with other files: scan it now
            // so an already-installed dependency is kept instead of downloaded.
            let prepared = prepare_install(
                state,
                &client,
                &key,
                &project,
                &file,
                Some(&target.directory),
                &target.minecraft,
                target.loader.as_deref(),
                target.detected_loader.as_deref(),
                kind,
                resource_type,
            )
            .await?;
            let installed = install_prepared(
                state,
                &target.directory,
                &project.name,
                kind,
                &progress,
                prepared,
            )
            .await?;
            progress.stage(state, "complete", "实例及资源安装完成");
            Ok(installed)
        }).await
    }).await
}


/// The dependency-resolved files of one CurseForge install. A `None` project
/// belongs to a dependency that is already installed and only kept.
struct PreparedInstall {
    entries: Vec<InstallEntry<(Option<Project>, CfFile)>>,
    projects: Vec<String>,
    root_destination: String,
    root_mod_id: u64,
}

impl PreparedInstall {
    /// True when every non-root dependency is already kept and needs no work.
    fn all_dependencies_kept(&self) -> bool {
        self.entries.iter().all(|entry| {
            entry.source.1.mod_id == self.root_mod_id
                || (entry.keep.is_some() && entry.remove.is_empty())
        })
    }
}

/// Resolves the required dependency graph and builds the staged transaction's
/// entries. `local_directory` is `None` for the preflight before a new
/// instance exists: nothing is installed then, so nothing can be skipped.
#[allow(clippy::too_many_arguments)]
async fn prepare_install(
    state: &LauncherState,
    client: &reqwest::Client,
    key: &str,
    project: &Project,
    file: &CfFile,
    local_directory: Option<&Path>,
    minecraft: &str,
    loader: Option<&str>,
    detected_loader: Option<&str>,
    kind: ResourceKind,
    resource_type: &str,
) -> Result<PreparedInstall, String> {
    // Only a file that declares required or incompatible dependencies needs
    // the local fingerprint scan. A file without dependencies keeps the
    // previous request count.
    let needs_local_identity = file
        .dependencies
        .iter()
        .any(|dependency| dependency.relation_type == 3 || dependency.relation_type == 5);
    let installed = if needs_local_identity {
        match local_directory {
            Some(directory) => {
                installed_dependencies(
                    state,
                    client,
                    key,
                    directory,
                    kind,
                    Some((file.mod_id, file.id)),
                )
                .await?
            }
            None => HashMap::new(),
        }
    } else {
        HashMap::new()
    };
    let source = CurseforgeDependencySource {
        state,
        client,
        key,
        minecraft,
        loader,
        detected_loader,
        game_dir: local_directory.and_then(Path::parent),
        kind,
        resource_type,
        installed,
        other_installed: Mutex::new(HashMap::new()),
        projects: Mutex::new(HashMap::new()),
        files: Mutex::new(HashMap::new()),
    };
    let root_file_id = file.id;
    let root_mod_id = project.id;
    source.remember(project.clone(), file.clone());
    let nodes = resource_transactions::resolve_dependency_plan(
        state,
        &source,
        plan_version(file),
        true,
        minecraft,
        loader,
        kind,
    )
    .await?;
    let mut entries = Vec::new();
    let mut projects = Vec::new();
    let mut root_destination = None;
    for node in &nodes {
        let dependency_file = source
            .file(&node.version.id)
            .ok_or("CurseForge 安装计划缺少文件")?;
        validate_id(&dependency_file.file_name)?;
        if !kind.accepts(&dependency_file.file_name) {
            return Err("CurseForge 安装计划包含错误的文件类型".into());
        }
        // Never mark the root file as keep: it always goes through download()
        // with Duplicates::SetAside so other enabled copies of the same mod
        // are moved aside inside the journaled stage.
        let keep = if dependency_file.id == root_file_id || dependency_file.mod_id == root_mod_id {
            None
        } else {
            source
                .installed
                .get(&dependency_file.mod_id)
                .and_then(|files| {
                    files
                        .iter()
                        .find(|(_, local)| local.id == dependency_file.id)
                })
                .map(|(name, _)| name.clone())
        };
        // A dependency already installed under this exact file is kept and
        // needs no project lookup; its kept entry is never downloaded.
        let dependency_project = if keep.is_none() {
            Some(source.project(dependency_file.mod_id).await?)
        } else {
            None
        };
        let destination = keep
            .clone()
            .unwrap_or_else(|| dependency_file.file_name.clone());
        if dependency_file.id == root_file_id {
            root_destination = Some(destination.clone());
        }
        projects.push(format!("cf:{}", dependency_file.mod_id));
        entries.push(InstallEntry {
            source: (dependency_project, dependency_file),
            destination,
            keep,
            remove: Vec::new(),
        });
    }
    Ok(PreparedInstall {
        entries,
        projects,
        root_destination: root_destination.ok_or("缺少根资源计划")?,
        root_mod_id,
    })
}

/// Commits a [`PreparedInstall`] in one staged transaction.
async fn install_prepared(
    state: &Arc<LauncherState>,
    directory: &Path,
    name: &str,
    kind: ResourceKind,
    progress: &crate::resources::ResourceProgress,
    prepared: PreparedInstall,
) -> Result<ResourceInstall, String> {
    let PreparedInstall {
        entries,
        projects,
        root_destination,
        ..
    } = prepared;
    // Parts live beside the game folder, not in next/: they outlive a failed stage.
    let parts = crate::resources::resource_parts(state, directory).map(crate::parts::Reuse::new);
    let reuse = parts.as_ref();
    let install_state = state.clone();
    let progress_ref = progress;
    let fetch = move |(dependency_project, dependency_file): (Option<Project>, CfFile), next: PathBuf, aside: PathBuf| {
        let state = install_state.clone();
        async move {
            let project = dependency_project.ok_or("已安装的必需前置不应再次下载")?;
            download(
                &state,
                &project,
                &dependency_file,
                &next,
                kind,
                Duplicates::SetAside(&aside),
                reuse,
                Some(progress_ref),
            )
            .await
        }
    };
    resource_transactions::install_entries(
        state,
        directory,
        name,
        InstallSource::Curseforge,
        root_destination,
        projects,
        entries,
        kind,
        Some(progress),
        reuse,
        fetch,
    )
    .await
}

#[tauri::command]
pub async fn install_curseforge_resource(
    app: tauri::AppHandle,
    state: State<'_, Arc<LauncherState>>,
    project_id: String,
    version_id: String,
    instance_id: Option<String>,
    resource_type: String,
    file_id: Option<u64>,
    task_id: String,
) -> AppResult<ResourceInstall> {
    use crate::downloads::{ResourceRequest, ResourceSource, ResourceTarget};
    let request = ResourceRequest {
        source: ResourceSource::Curseforge, project_id, resource_type,
        target: ResourceTarget::Existing { version_id, instance_id, file_id, resource_version_id: None },
    };
    crate::resources::run_resource_request(state.inner(), Some(&app), &task_id, request)
        .await?
        .installed()
}

pub(crate) async fn install_curseforge(
    state: &Arc<LauncherState>,
    app: Option<&tauri::AppHandle>,
    task_id: &str,
    request: crate::downloads::ResourceRequest,
) -> AppResult<ResourceInstall> {
    use crate::downloads::ResourceTarget;
    let ResourceTarget::Existing { version_id, instance_id, file_id, .. } = request.target.clone() else {
        return Err("资源文件标识无效".into());
    };
    let (project_id, resource_type, retry) = (request.project_id.clone(), request.resource_type.clone(), request.clone());
    crate::resources::with_reserved_resource_task(state, task_id, request, async {
        let id = self::project_id(&project_id)?;
        let kind = ResourceKind::parse(&resource_type)?;
        crate::resources::require_resource_stopped(state, &version_id, instance_id.as_deref())?;
        let target =
            crate::resources::resource_target(state, &version_id, instance_id.as_deref(), kind)?;
        crate::resources::resource_transactions::require_no_pending(&target.directory)?;
        let progress = crate::resources::ResourceProgress::new(app, &version_id);
        progress.stage(state, "resource-plan", "检查资源及必需前置");
        let key = service_key(state)?;
        let client = api_client(state)?;
        let directory = target.directory;
        let minecraft = target.minecraft;
        let loader = target.loader;
        let detected_loader = target.detected_loader;
        let project: Response<Project> = in_task(state, api(&client, &key, &format!("mods/{id}"), &[])).await?;
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
                in_task(state, api(&client, &key, &format!("mods/{id}/files/{file_id}"), &[])).await?;
            if response.data.id != file_id || response.data.mod_id != id {
                return Err("CurseForge 文件不属于所选项目".into());
            }
            response.data
        } else {
            let mut files = in_task(state, files_page(&client, &key, id, &minecraft, loader.as_deref(), 0)).await?;
            files.retain(|file| compatible(file, &minecraft, loader.as_deref()));
            files.sort_by(|a, b| b.file_date.cmp(&a.file_date));
            let file = files
                .into_iter()
                .next()
                .ok_or_else(|| crate::resources::no_compatible_version(&minecraft, loader.as_deref()))?;
            crate::resources::pin_retry(state, task_id, &retry, crate::resources::Pin::Curseforge(file.id));
            file
        };
        if !compatible(&file, &minecraft, loader.as_deref()) {
            return Err(crate::resources::no_compatible_version(&minecraft, loader.as_deref()));
        }
        if let Some(refusal) = manual_install_refusal(&project.data, &file) {
            return Err(refusal.into());
        }
        let exact_root = installed_already(&directory, &file)?
            && !other_enabled_copies(&directory, &file, kind)?;
        let needs_dependencies = file
            .dependencies
            .iter()
            .any(|dependency| dependency.relation_type == 3 || dependency.relation_type == 5);
        // Only a dependency-free exact file short-circuits before planning; a
        // present root with required/incompatible dependencies still resolves
        // them so missing dependencies are installed in one transaction.
        if exact_root && !needs_dependencies {
            return Ok(ResourceInstall {
                name: project.data.name,
                path: directory.join(&file.file_name).to_string_lossy().into_owned(),
                file_name: file.file_name,
                warning: Some("资源已是选定版本。".into()),
                update_id: None,
                dependency_count: 0,
                changed_count: 0,
                already_installed: true,
            });
        }
        let prepared = prepare_install(
            state,
            &client,
            &key,
            &project.data,
            &file,
            Some(&directory),
            &minecraft,
            loader.as_deref(),
            detected_loader.as_deref(),
            kind,
            &resource_type,
        )
        .await?;
        if exact_root && prepared.all_dependencies_kept() {
            return Ok(ResourceInstall {
                name: project.data.name,
                path: directory
                    .join(&prepared.root_destination)
                    .to_string_lossy()
                    .into_owned(),
                file_name: prepared.root_destination,
                warning: Some("资源及其必需前置已是选定版本。".into()),
                update_id: None,
                dependency_count: prepared.entries.len().saturating_sub(1),
                changed_count: 0,
                already_installed: true,
            });
        }
        let installed = install_prepared(
            state,
            &directory,
            &project.data.name,
            kind,
            &progress,
            prepared,
        )
        .await?;
        progress.emit(state, "complete", 1, 1, 0, 0, "资源安装完成");
        Ok(installed)
    }).await
}

/// Whether another enabled jar in `directory` declares the same mod as the
/// file of this name already there.
fn other_enabled_copies(directory: &Path, file: &CfFile, kind: ResourceKind) -> Result<bool, String> {
    if kind != ResourceKind::Mod {
        return Ok(false);
    }
    let target = safe_join(directory, &file.file_name)?;
    Ok(crate::mod_metadata::declared_mod_id(&target)
        .is_some_and(|mod_id| !crate::mod_metadata::enabled_jars_with_mod_id(directory, &mod_id, &target).is_empty()))
}

/// Whether the exact file is already in `directory` (same name, size and hashes).
fn installed_already(directory: &Path, file: &CfFile) -> Result<bool, String> {
    let target = safe_join(directory, &file.file_name)?;
    Ok(target.is_file() && matches(&file_hashes(&target)?, file.file_length, &expected_hashes(file)?))
}

/// Installs `file` into `directory` through a journaled staged copy that can be
/// rolled back. The file being updated (`current`) and every other enabled copy
/// of the same mod move aside; disabled copies and unknown jars stay. With
/// `enabled: false` the new file is installed disabled.
async fn replace_with_file(
    state: &Arc<LauncherState>,
    directory: &Path,
    kind: ResourceKind,
    project: &Project,
    file: &CfFile,
    current: Option<&str>,
    enabled: bool,
) -> Result<ResourceInstall, String> {
    validate_id(&file.file_name)?;
    crate::resources::resource_transactions::require_no_pending(directory)?;
    let installed_name = if enabled { file.file_name.clone() } else { format!("{}.disabled", file.file_name) };
    let projects = vec![format!("cf:{}", project.id)];
    // Parts live beside the game folder, not in next/: they outlive a failed stage.
    let parts = crate::resources::resource_parts(state, directory).map(crate::parts::Reuse::new);
    let reuse = parts.as_ref();
    let (id, (written, replaced)) = crate::resources::resource_transactions::stage_commit(
        state,
        directory,
        &project.name,
        projects,
        None,
        reuse,
        |next, aside| async move {
            if let Some(current) = current {
                let from = safe_join(&next, current)?;
                if !from.is_file() {
                    return Err("待更新资源不存在".to_string());
                }
                fs::rename(&from, safe_join(&aside, current)?).map_err(|e| e.to_string())?;
            }
            if !enabled && safe_join(&next, &file.file_name)?.exists() {
                return Err(format!("已存在同名文件 {}，停用的副本未更新，原目录未改变", file.file_name));
            }
            let duplicates = if enabled { Duplicates::SetAside(&aside) } else { Duplicates::Keep };
            let downloaded = download(state, project, file, &next, kind, duplicates, reuse, None).await?;
            if !enabled {
                publish_disabled(&downloaded.path, &next, &file.file_name, reuse)?;
            }
            let mut replaced: Vec<String> = fs::read_dir(&aside)
                .map_err(|e| e.to_string())?
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            replaced.sort();
            Ok((downloaded.written || !enabled, replaced))
        },
    )
    .await?;
    let mut notices = Vec::new();
    if !replaced.is_empty() {
        notices.push(format!("已替换 {}，可在更新历史中回滚", replaced.join("、")));
    }
    if kind == ResourceKind::Shader {
        notices.push("光影文件已安装；游戏内仍需 Iris、OptiFine 或兼容加载器才能启用。".into());
    }
    Ok(ResourceInstall {
        name: project.name.clone(),
        path: directory.join(&installed_name).to_string_lossy().into_owned(),
        file_name: installed_name,
        warning: (!notices.is_empty()).then(|| notices.join("；")),
        update_id: Some(id),
        dependency_count: 0,
        changed_count: usize::from(written),
        already_installed: false,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintAnswer {
    #[serde(default)]
    exact_matches: Vec<FingerprintMatch>,
}
#[derive(Deserialize)]
struct FingerprintMatch {
    id: u64,
    file: CfFile,
}

/// A local file's fingerprint and what verifies a match for it.
struct LocalFile {
    name: String,
    enabled: bool,
    fingerprint: u32,
    sha1: String,
    size: u64,
}

/// The resource files in `directory` (enabled or `.disabled`) of this kind,
/// except those in `skip`, with whether each is enabled.
fn candidate_names(directory: &Path, kind: ResourceKind, skip: &HashSet<String>) -> Vec<(String, bool)> {
    let Ok(entries) = fs::read_dir(directory) else { return Vec::new() };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if skip.contains(&name) {
            continue;
        }
        let (base, enabled) = match name.strip_suffix(".disabled") {
            Some(base) => (base, false),
            None => (name.as_str(), true),
        };
        if kind.accepts(base) {
            names.push((name.clone(), enabled));
        }
    }
    names.sort();
    names
}

/// Fingerprints and hashes the named files, one blocking task each, with a
/// cancel and pause check between files. Names that are not plain names,
/// links, folders, unreadable files and files over 1 GiB are skipped.
async fn local_files(state: &LauncherState, directory: &Path, names: Vec<(String, bool)>) -> Result<Vec<LocalFile>, String> {
    let mut files = Vec::new();
    for (name, enabled) in names {
        state.control.checkpoint().await?;
        let Ok(path) = safe_join(directory, &name) else { continue };
        let file = tokio::task::spawn_blocking(move || {
            let stat = fs::symlink_metadata(&path).ok()?;
            if !stat.is_file() || crate::resources::linked(&stat) || stat.len() > MAX_FILE {
                return None;
            }
            let fingerprint = fingerprint::fingerprint_file(&path, MAX_FILE).ok()?;
            let (sha1, _, size) = file_hashes(&path).ok()?;
            Some(LocalFile { name, enabled, fingerprint, sha1, size })
        })
        .await
        .map_err(|e| e.to_string())?;
        files.extend(file);
    }
    Ok(files)
}

/// Which local files CurseForge knows, by name. A 32-bit fingerprint can
/// collide, so a match counts only when the mod, the game, the size and the
/// SHA-1 all agree with the local file.
async fn identify(client: &reqwest::Client, key: &str, files: &[LocalFile]) -> Result<HashMap<String, (u64, CfFile)>, String> {
    let mut wanted: Vec<u32> = files.iter().map(|file| file.fingerprint).collect();
    wanted.sort_unstable();
    wanted.dedup();
    let mut found: HashMap<String, (u64, CfFile)> = HashMap::new();
    let mut ambiguous = HashSet::new();
    for chunk in wanted.chunks(100) {
        let answer: Response<FingerprintAnswer> =
            api_post(client, key, "fingerprints/432", &serde_json::json!({ "fingerprints": chunk })).await?;
        for matched in answer.data.exact_matches {
            let file = matched.file;
            if file.mod_id != matched.id || !(file.game_id == 0 || file.game_id == 432) {
                continue;
            }
            let Ok(expected) = expected_hashes(&file) else { continue };
            let Some(sha1) = expected.iter().find(|(algo, _)| *algo == 1).map(|(_, value)| value.as_str()) else {
                continue;
            };
            for local in files.iter().filter(|local| u64::from(local.fingerprint) == file.file_fingerprint) {
                if local.size == file.file_length && local.sha1.eq_ignore_ascii_case(sha1) {
                    if found.get(&local.name).is_some_and(|(other, _)| *other != matched.id) {
                        ambiguous.insert(local.name.clone());
                    }
                    found.insert(local.name.clone(), (matched.id, file.clone()));
                }
            }
        }
    }
    // The same bytes listed under two mods identify neither.
    found.retain(|name, _| !ambiguous.contains(name));
    Ok(found)
}

/// The projects with these ids, fetched 100 per request. A project
/// CurseForge does not return (removed, or another game's) is left out.
async fn projects(state: &LauncherState, client: &reqwest::Client, key: &str, ids: &[u64]) -> Result<HashMap<u64, Project>, String> {
    let mut ids = ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let mut found = HashMap::new();
    for chunk in ids.chunks(100) {
        state.control.checkpoint().await?;
        let answer: Response<Vec<Project>> =
            match in_task(state, api_post(client, key, "mods", &serde_json::json!({ "modIds": chunk }))).await {
                Ok(answer) => answer,
                Err(error) if error == NOT_FOUND => continue,
                Err(error) => return Err(error),
            };
        for project in answer.data {
            if chunk.contains(&project.id) {
                found.insert(project.id, project);
            }
        }
    }
    Ok(found)
}

/// A CurseForge API client with the user's key (explicit, else saved, else built in).
pub(crate) struct CfSession {
    client: reqwest::Client,
    key: String,
}

impl CfSession {
    /// No key: the same error text `service_key` returns (it maps to
    /// `auth.serviceKeyMissing`).
    pub(crate) fn new(state: &LauncherState, explicit: Option<&str>) -> Result<Self, String> {
        let key = crate::curseforge_key::effective_cf_key(&state.data_dir, explicit)?
            .ok_or_else(|| "请先在设置中保存你自己申请的 CurseForge API Key；不会使用其它启动器的 Key。".to_string())?;
        Ok(Self { client: api_client(state)?, key })
    }
}

/// What a modpack lock and its update pipeline need from a CurseForge project.
pub(crate) struct PackProject {
    pub(crate) id: u64,
    pub(crate) class_id: Option<u64>,
    pub(crate) name: String,
    /// `project_page()`: an https curseforge.com page.
    pub(crate) page: String,
    /// `allow_mod_distribution != Some(false)`.
    pub(crate) distributable: bool,
}

impl PackProject {
    fn from_project(project: Project) -> Self {
        Self {
            id: project.id,
            class_id: project.class_id,
            page: project_page(&project),
            name: project.name,
            distributable: project.allow_mod_distribution != Some(false),
        }
    }
}

/// What a modpack lock and its update pipeline need from a CurseForge file.
pub(crate) struct PackFile {
    pub(crate) id: u64,
    pub(crate) project_id: u64,
    pub(crate) file_name: String,
    /// `version_label()`: display name, else file name.
    pub(crate) label: String,
    pub(crate) file_date: String,
    pub(crate) size: u64,
    /// The algo-1 hash when it is 40 hex digits, lowercased.
    pub(crate) sha1: Option<String>,
    pub(crate) game_versions: Vec<String>,
    pub(crate) available: bool,
    /// `release_type == 1 && is_available && !is_server_pack`.
    pub(crate) release: bool,
    /// `download_url` when non-empty and accepted by `download_url()` (the
    /// forgecdn hosts).
    pub(crate) url: Option<String>,
    raw: CfFile,
}

impl PackFile {
    fn from_file(file: CfFile) -> Self {
        let sha1 = file.hashes.iter().find_map(|hash| {
            (hash.algo == 1 && hash.value.len() == 40 && hash.value.bytes().all(|b| b.is_ascii_hexdigit()))
                .then(|| hash.value.to_ascii_lowercase())
        });
        let url = file
            .download_url
            .as_deref()
            .filter(|value| !value.is_empty())
            .filter(|value| download_url(value).is_ok())
            .map(str::to_owned);
        Self {
            id: file.id,
            project_id: file.mod_id,
            file_name: file.file_name.clone(),
            label: version_label(&file),
            file_date: file.file_date.clone(),
            size: file.file_length,
            sha1,
            game_versions: file.game_versions.clone(),
            available: file.is_available,
            release: file.release_type == 1 && file.is_available && !file.is_server_pack,
            url,
            raw: file,
        }
    }
}

/// `newer(&a.raw, &b.raw)`.
pub(crate) fn pack_newer(a: &PackFile, b: &PackFile) -> bool {
    newer(&a.raw, &b.raw)
}

/// GET `mods/{id}`: the id must match and the game must be Minecraft (432).
pub(crate) async fn pack_project(session: &CfSession, id: u64) -> Result<PackProject, String> {
    let answer: Response<Project> = api(&session.client, &session.key, &format!("mods/{id}"), &[]).await?;
    if answer.data.id != id || answer.data.game_id != 432 {
        return Err("CurseForge 项目身份或游戏不一致".into());
    }
    Ok(PackProject::from_project(answer.data))
}

/// GET `mods/{project}/files/{file}`: id and modId must match.
pub(crate) async fn pack_file(session: &CfSession, project: u64, file: u64) -> Result<PackFile, String> {
    let answer: Response<CfFile> = api(&session.client, &session.key, &format!("mods/{project}/files/{file}"), &[]).await?;
    if answer.data.id != file || answer.data.mod_id != project {
        return Err("CurseForge 文件不属于所选项目".into());
    }
    Ok(PackFile::from_file(answer.data))
}

/// `files_page(.., "", None, offset)`: one page (50) of a project's files,
/// newest first.
pub(crate) async fn pack_files_page(session: &CfSession, project: u64, offset: usize) -> Result<Vec<PackFile>, String> {
    let files = files_page(&session.client, &session.key, project, "", None, offset).await?;
    Ok(files.into_iter().map(PackFile::from_file).collect())
}

/// POST `mods/files` `{"fileIds": [...]}` 100 ids per request (a checkpoint
/// and `in_task` around each, like `projects`), then `projects(...)` for their
/// modIds. Files or projects CurseForge does not return are left out.
pub(crate) async fn manifest_files(
    state: &LauncherState,
    session: &CfSession,
    file_ids: &[u64],
) -> Result<(HashMap<u64, PackFile>, HashMap<u64, PackProject>), String> {
    let mut ids = file_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    let mut files = HashMap::new();
    for chunk in ids.chunks(100) {
        state.control.checkpoint().await?;
        let answer: Response<Vec<CfFile>> = match in_task(
            state,
            api_post(&session.client, &session.key, "mods/files", &serde_json::json!({ "fileIds": chunk })),
        )
        .await
        {
            Ok(answer) => answer,
            Err(error) if error == NOT_FOUND => continue,
            Err(error) => return Err(error),
        };
        for file in answer.data {
            if chunk.contains(&file.id) {
                files.insert(file.id, PackFile::from_file(file));
            }
        }
    }
    let project_ids: Vec<u64> = files.values().map(|file| file.project_id).collect();
    let projects = projects(state, &session.client, &session.key, &project_ids).await?;
    Ok((
        files,
        projects
            .into_iter()
            .filter(|(_, project)| project.game_id == 432)
            .map(|(id, project)| (id, PackProject::from_project(project)))
            .collect(),
    ))
}

/// Whether `candidate` is newer than `current`: by file time (parsed when
/// both parse, which orders fractional seconds correctly), then by id.
fn newer(candidate: &CfFile, current: &CfFile) -> bool {
    let time = |file: &CfFile| chrono::DateTime::parse_from_rfc3339(&file.file_date).ok();
    match (time(candidate), time(current)) {
        (Some(a), Some(b)) if a != b => a > b,
        (Some(_), Some(_)) => candidate.id > current.id,
        _ => (candidate.file_date.as_str(), candidate.id) > (current.file_date.as_str(), current.id),
    }
}

/// The newest compatible release newer than `current`. The file list comes
/// newest first; pages are read until one holds the current file, runs short
/// or yields a release, at most 10 pages of 50.
async fn newest_release(
    state: &LauncherState,
    client: &reqwest::Client,
    key: &str,
    mod_id: u64,
    minecraft: &str,
    loader: Option<&str>,
    current: &CfFile,
) -> Result<Option<CfFile>, String> {
    let mut best: Option<CfFile> = None;
    for page in 0..10 {
        state.control.checkpoint().await?;
        let files = in_task(state, files_page(client, key, mod_id, minecraft, loader, page * 50)).await?;
        let last = files.len() < 50 || files.iter().any(|file| file.id == current.id);
        for file in files {
            let eligible = file.release_type == 1
                && file.is_available
                && !file.is_server_pack
                && compatible(&file, minecraft, loader)
                && newer(&file, current);
            if eligible && best.as_ref().is_none_or(|best| newer(&file, best)) {
                best = Some(file);
            }
        }
        if last || best.is_some() {
            break;
        }
    }
    Ok(best)
}

fn version_label(file: &CfFile) -> String {
    if file.display_name.trim().is_empty() { file.file_name.clone() } else { file.display_name.clone() }
}

/// Update rows for the CurseForge files in `directory` that Modrinth did not
/// identify (`skip`). Without a CurseForge key nothing is checked and the
/// second value is true. Only release files are offered (no beta or alpha
/// fallback); a file whose author forbids third-party downloads becomes a
/// manual-download row.
pub(crate) async fn curseforge_updates(
    state: &LauncherState,
    directory: &Path,
    minecraft: &str,
    loader: Option<&str>,
    kind: ResourceKind,
    resource_type: &str,
    skip: &HashSet<String>,
) -> Result<(Vec<ResourceUpdate>, bool), String> {
    let Some(key) = crate::curseforge_key::effective_cf_key(&state.data_dir, None)? else {
        return Ok((Vec::new(), true));
    };
    let names = candidate_names(directory, kind, skip);
    if names.is_empty() {
        return Ok((Vec::new(), false));
    }
    let class = class_id(resource_type)?;
    let client = api_client(state)?;
    let locals = local_files(state, directory, names).await?;
    state.control.checkpoint().await?;
    let identified = in_task(state, identify(&client, &key, &locals)).await?;
    let ids: Vec<u64> = identified.values().map(|(id, _)| *id).collect();
    let projects = projects(state, &client, &key, &ids).await?;
    let mut names: Vec<_> = identified.keys().cloned().collect();
    names.sort();
    let mut rows = Vec::new();
    for name in names {
        state.control.checkpoint().await?;
        let (mod_id, current) = &identified[&name];
        // A project CurseForge no longer returns is skipped, not an error.
        let Some(project) = projects.get(mod_id) else { continue };
        if project.game_id != 432 || project.class_id != Some(class) {
            continue;
        }
        let newest = match newest_release(state, &client, &key, *mod_id, minecraft, loader, current).await {
            Ok(Some(newest)) => newest,
            Ok(None) => continue,
            // Its file list is gone: skip it; any other failure ends the check.
            Err(error) if error == NOT_FOUND => continue,
            Err(error) => return Err(error),
        };
        // No usable download (forbidden, missing or not the official CDN): the
        // user downloads it from the project page.
        let manual_only = is_restricted_file(project, &newest);
        rows.push(ResourceUpdate {
            file_name: name.clone(),
            name: project.name.clone(),
            current_version: version_label(current),
            new_version: version_label(&newest),
            project_id: mod_id.to_string(),
            new_version_id: newest.id.to_string(),
            enabled: locals.iter().any(|local| local.name == name && local.enabled),
            source: "curseforge".into(),
            new_file_id: Some(newest.id),
            manual_only,
            project_url: manual_only.then(|| project_page(project)),
        });
    }
    Ok((rows, false))
}

/// Updates one identified CurseForge file to `new_file_id` through the
/// journaled replace; a disabled file stays disabled. The current file must
/// still be the one CurseForge identifies; the new one must belong to the same
/// mod, pass the same checks as a pinned install and fit the instance.
pub(crate) async fn update_one(
    state: &Arc<LauncherState>,
    directory: &Path,
    minecraft: &str,
    loader: Option<&str>,
    detected: Option<&str>,
    kind: ResourceKind,
    resource_type: &str,
    file_name: &str,
    new_file_id: u64,
) -> AppResult<ResourceInstall> {
    validate_id(file_name)?;
    if !(1..=u64::from(u32::MAX)).contains(&new_file_id) {
        return Err("CurseForge 文件标识无效".into());
    }
    crate::resources::resource_transactions::require_no_pending(directory)?;
    if !safe_join(directory, file_name)?.is_file() {
        return Err("待更新资源不存在".into());
    }
    let key = service_key(state)?;
    let client = api_client(state)?;
    let enabled = !file_name.ends_with(".disabled");
    let locals = local_files(state, directory, vec![(file_name.to_owned(), enabled)]).await?;
    let identified = in_task(state, identify(&client, &key, &locals)).await?;
    let (mod_id, current) = identified
        .get(file_name)
        .cloned()
        .ok_or("无法确认此文件的 CurseForge 身份，未知资源不会被自动替换")?;
    let (project, file) = state.control
        .during_cancellable_io(get_pinned_file(&client, &key, &mod_id.to_string(), resource_type, new_file_id, kind))
        .await??;
    if file.id == current.id {
        return Err("资源已是选定版本".into());
    }
    if !newer(&file, &current) {
        return Err("所选 CurseForge 文件早于当前文件，更新不会降级".into());
    }
    if !compatible(&file, minecraft, loader) {
        return Err(crate::resources::no_compatible_version(minecraft, loader));
    }
    let game_dir = directory.parent().ok_or("目标游戏目录无效")?;
    check_dependencies(state, &client, &key, &file, game_dir, minecraft, detected).await?;
    Ok(replace_with_file(state, directory, kind, &project, &file, Some(file_name), enabled).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c9_folder() -> crate::instances::StagingDirectory {
        crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/cf-duplicate-tests").join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap()
    }

    /// A jar of more than 1 MiB declaring `mod_id`.
    fn c9_jar(mod_id: &str, version: &str) -> Vec<u8> {
        use std::io::Write;
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("fabric.mod.json", stored).unwrap();
        zip.write_all(format!(r#"{{"id":"{mod_id}","version":"{version}"}}"#).as_bytes()).unwrap();
        zip.start_file("data.bin", stored).unwrap();
        zip.write_all(&(0..1_200_000).map(|index| (index * 29 % 251) as u8).collect::<Vec<_>>()).unwrap();
        zip.finish().unwrap().into_inner()
    }

    fn c9_key(bytes: &[u8]) -> crate::parts::PartKey {
        crate::parts::PartKey::new(crate::parts::Algo::Sha1, &format!("{:x}", Sha1::digest(bytes)), bytes.len() as u64).unwrap()
    }

    #[test]
    fn c9_a_disabled_update_keeps_its_verified_download_listed() {
        let folder = c9_folder();
        let next = folder.path().join("next");
        fs::create_dir(&next).unwrap();
        let bytes = c9_jar("example", "new");
        let store = crate::parts::PartStore::new(folder.path().join("parts"));
        for taken in [false, true] {
            let reuse = crate::parts::Reuse::new(store.clone());
            let downloaded = next.join("new.jar");
            fs::write(&downloaded, &bytes).unwrap();
            reuse.add(&c9_key(&bytes), bytes.len() as u64, &downloaded);
            if taken {
                fs::write(next.join("new.jar.disabled"), b"another file").unwrap();
                assert!(publish_disabled(&downloaded, &next, "new.jar", Some(&reuse)).is_err());
                assert_eq!(fs::read(next.join("new.jar.disabled")).unwrap(), b"another file");
            } else {
                assert_eq!(publish_disabled(&downloaded, &next, "new.jar", Some(&reuse)).unwrap(), next.join("new.jar.disabled"));
            }
            // Wherever the file is now, a stage that is thrown away hands it back.
            reuse.restore();
            assert!(!downloaded.exists() && (taken || !next.join("new.jar.disabled").exists()), "taken={taken}");
            let part = store.open(&c9_key(&bytes), bytes.len() as u64).unwrap().unwrap();
            assert!(part.complete(), "taken={taken}");
            part.discard();
            let _ = fs::remove_file(next.join("new.jar.disabled"));
        }
    }

    #[test]
    fn c9_a_download_refused_after_its_part_hands_the_verified_file_back() {
        let folder = c9_folder();
        let state = LauncherState::test_fixture(folder.path().join("data"), crate::models::Persisted::default(), crate::storage::test_client());
        state
            .update(|persisted| {
                persisted.config.proxy_mode = "none".into();
                Ok(())
            })
            .unwrap();
        let bytes = c9_jar("example", "new");
        let cdn = crate::parts::range_server::RangeServer::new(vec![crate::parts::range_server::Scripted::ok(&bytes, "\"r\"")]);
        crate::resources::TEST_ENDPOINTS.with(|endpoints| {
            *endpoints.borrow_mut() = Some(crate::resources::TestEndpoints {
                modrinth_api: String::new(),
                curseforge_api: String::new(),
                cdn: cdn.address.parse().unwrap(),
                prepared_version: None,
            })
        });
        let port = cdn.address.rsplit(':').next().unwrap();
        let file: CfFile = serde_json::from_value(serde_json::json!({
            "id": 20001, "modId": 456, "gameId": 432, "isAvailable": true, "fileName": "new.jar",
            "fileLength": bytes.len(), "downloadUrl": format!("http://edge.forgecdn.net:{port}/files/new.jar"),
            "hashes": [{"algo": 1, "value": format!("{:x}", Sha1::digest(&bytes))}, {"algo": 2, "value": format!("{:x}", md5::compute(&bytes))}],
            "gameVersions": ["1.21.1", "Fabric"], "dependencies": [], "fileDate": "2026-01-02T00:00:00Z"
        }))
        .unwrap();
        let project: Project = serde_json::from_value(serde_json::json!({
            "id": 456, "gameId": 432, "name": "Fixture", "slug": "fixture", "summary": "Fixture",
            "classId": 6, "downloadCount": 0.0, "authors": [], "allowModDistribution": true
        }))
        .unwrap();
        // A new instance already holding an enabled copy of the mod: the
        // download is refused after its part was checked.
        let mods = folder.path().join("mods");
        fs::create_dir(&mods).unwrap();
        fs::write(mods.join("other.jar"), c9_jar("example", "other")).unwrap();
        let store = crate::parts::PartStore::new(folder.path().join("parts"));
        let reuse = crate::parts::Reuse::new(store.clone());
        let result = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(download(
            &state,
            &project,
            &file,
            &mods,
            ResourceKind::Mod,
            Duplicates::Refuse,
            Some(&reuse),
            None,
        ));
        crate::resources::TEST_ENDPOINTS.with(|endpoints| *endpoints.borrow_mut() = None);
        let Err(error) = result else { panic!("the duplicate must be refused") };
        assert!(error.contains("other.jar"), "{error}");
        let names: Vec<_> = fs::read_dir(&mods).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| !crate::parts::scanner_copy(name)).collect();
        assert_eq!(names, ["other.jar"], "nothing is left in the folder");
        assert_eq!(cdn.count(), 1);
        let part = store.open(&c9_key(&bytes), bytes.len() as u64).unwrap().unwrap();
        assert!(part.complete(), "the verified bytes went back to their part");
    }

    #[test]
    fn c6_a_second_enabled_copy_of_the_same_mod_is_refused() {
        use std::io::Write;
        let fixture = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/cf-duplicate-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let jar = |path: &Path, id: &str| {
            let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
            zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(format!(r#"{{"id":"{id}","version":"1"}}"#).as_bytes()).unwrap();
            zip.finish().unwrap();
        };
        let mods = fixture.path().join("mods");
        fs::create_dir(&mods).unwrap();
        jar(&mods.join("example-2.jar"), "example");
        let downloaded = mods.join(".curseforge-fixture.part");
        jar(&downloaded, "example");
        let target = mods.join("example-1.jar");
        let error = refuse_duplicate_mod(&downloaded, &mods, &target).unwrap_err();
        assert!(error.contains("example-2.jar") && error.contains("example"), "{error}");
        assert!(mods.join("example-2.jar").exists(), "the existing file stays");

        jar(&downloaded, "other");
        assert!(refuse_duplicate_mod(&downloaded, &mods, &target).is_ok());
        fs::rename(mods.join("example-2.jar"), mods.join("example-2.jar.disabled")).unwrap();
        jar(&downloaded, "example");
        assert!(refuse_duplicate_mod(&downloaded, &mods, &target).is_ok(), "a disabled copy is not a duplicate");
        fs::write(&downloaded, b"not a jar").unwrap();
        assert!(refuse_duplicate_mod(&downloaded, &mods, &target).is_ok(), "unknown mod IDs keep the old behaviour");
    }

    #[test]
    fn c6_cf_publish_never_replaces_a_file_that_appeared() {
        let fixture = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/cf-duplicate-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let source = fixture.path().join("new.part");
        let target = fixture.path().join("example.jar");
        fs::write(&source, b"verified").unwrap();
        fs::write(&target, b"user bytes").unwrap();
        assert!(crate::instances::publish_archive_file(&source, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"user bytes");
    }

    fn example() -> CfFile {
        serde_json::from_value(serde_json::json!({
            "id":123,"modId":456,"gameId":432,"isAvailable":true,
            "fileName":"example.jar","fileLength":3,"downloadUrl":"https://mediafilez.forgecdn.net/files/example.jar",
            "hashes":[{"algo":1,"value":"a9993e364706816aba3e25717850c26c9cd0d89d"},{"algo":2,"value":"900150983cd24fb0d6963f7d28e17f72"}],
            "gameVersions":["1.21.1","Fabric"],"dependencies":[{"modId":789,"relationType":3}]
        })).unwrap()
    }

    fn u27_project(allow: Option<bool>, website: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "id":456,"gameId":432,"name":"Fixture","slug":"fixture","summary":"Fixture",
            "classId":6,"downloadCount":0.0,"authors":[],"allowModDistribution":allow,
            "links":{"websiteUrl":website}
        })
    }

    fn u27_file(url: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "id":123,"modId":456,"gameId":432,"isAvailable":true,
            "fileName":"fixture-1.0.jar","displayName":"Fixture 1.0","fileLength":3,"downloadUrl":url,
            "hashes":[{"algo":1,"value":"a9993e364706816aba3e25717850c26c9cd0d89d"},{"algo":2,"value":"900150983cd24fb0d6963f7d28e17f72"}],
            "gameVersions":["1.21.1","Fabric"],"dependencies":[]
        })
    }

    const U27_CDN: &str = "https://mediafilez.forgecdn.net/files/fixture-1.0.jar";
    const U27_PAGE: &str = "https://www.curseforge.com/minecraft/mc-mods/fixture";

    /// A launcher whose only game folder is a fixture with a Fabric 1.21.1
    /// profile and a vanilla 1.21.1 profile.
    fn u27_state() -> (crate::instances::StagingDirectory, LauncherState) {
        let folder = c9_folder();
        let game = folder.path().join("game");
        for (id, metadata) in [
            ("fabric-test", serde_json::json!({"inheritsFrom":"1.21.1","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.9"}],"launcherMetadata":{"loaderVersion":"0.16.9"}})),
            ("1.21.1", serde_json::json!({"id":"1.21.1"})),
        ] {
            let directory = game.join("versions").join(id);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join(format!("{id}.json")), metadata.to_string()).unwrap();
        }
        let state = LauncherState::test_fixture(
            folder.path().join("data"),
            crate::models::Persisted {
                config: crate::models::Config {
                    game_directory: game.to_string_lossy().into_owned(),
                    proxy_mode: "none".into(),
                    ..Default::default()
                },
                ..Default::default()
            },
            crate::storage::test_client(),
        );
        (folder, state)
    }

    /// Plans file 123 of project 456 against a loopback CurseForge API that
    /// answers with `project` and then `file`; returns the paths it was asked for.
    fn u27_plan(state: &LauncherState, project: serde_json::Value, file: serde_json::Value) -> (AppResult<ResourceTargetPlan>, Vec<String>) {
        use crate::parts::range_server::{RangeServer, Scripted};
        let answer = |data: serde_json::Value| Scripted::ok(serde_json::json!({ "data": data }).to_string().as_bytes(), "\"j\"");
        let api = RangeServer::new(vec![answer(project), answer(file)]);
        crate::resources::TEST_ENDPOINTS.with(|endpoints| {
            *endpoints.borrow_mut() = Some(crate::resources::TestEndpoints {
                modrinth_api: String::new(),
                curseforge_api: format!("http://{}", api.address),
                cdn: api.address.parse().unwrap(),
                prepared_version: None,
            })
        });
        let client = api_client(state).unwrap();
        let plan = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(pinned_targets(
            state,
            &client,
            "fixture-key",
            "456",
            "mod",
            123,
            async { Err::<serde_json::Value, String>("offline".into()) },
        ));
        crate::resources::TEST_ENDPOINTS.with(|endpoints| *endpoints.borrow_mut() = None);
        let paths = (0..api.count()).filter_map(|index| api.header(index, ":path")).collect();
        (plan, paths)
    }

    #[test]
    fn u27_pinned_plan_fetch_plans_a_manual_only_file_that_the_install_still_refuses() {
        let (_folder, state) = u27_state();
        let (plan, paths) = u27_plan(&state, u27_project(Some(true), Some(U27_PAGE)), u27_file(None));
        let plan = plan.unwrap();
        assert_eq!(paths, ["/mods/456", "/mods/456/files/123"]);
        assert!(plan.manual_only);
        let download = plan.manual_download.as_ref().unwrap();
        assert_eq!(download.reason, ManualReason::NoDownloadUrl);
        assert_eq!(download.url, "https://www.curseforge.com/minecraft/mc-mods/fixture/files/123");
        assert_eq!(download.display_name, "Fixture 1.0");
        assert_eq!(download.file_name, "fixture-1.0.jar");
        let fabric = plan.targets.iter().find(|row| row.version_id == "fabric-test").unwrap();
        assert!(fabric.compatible, "the targets are still planned for the file");
        // The install keeps refusing the same file, with a stable code that
        // names it so the picker can be shown for it.
        let project: Project = serde_json::from_value(u27_project(Some(true), Some(U27_PAGE))).unwrap();
        let file: CfFile = serde_json::from_value(u27_file(None)).unwrap();
        let refusal = crate::errors::expected(validate_pinned_file(&project, &file, 123, ResourceKind::Mod).unwrap_err());
        assert_eq!(refusal.code, "resource.manualDownload");
        assert_eq!(refusal.params["fileId"], "123");

        for (allow, url, reason) in [
            (Some(false), Some(U27_CDN), ManualReason::DistributionForbidden),
            (None, Some("https://downloads.example.test/fixture-1.0.jar"), ManualReason::UntrustedUrl),
        ] {
            let (plan, _) = u27_plan(&state, u27_project(allow, Some(U27_PAGE)), u27_file(url));
            let plan = plan.unwrap();
            assert!(plan.manual_only, "{reason:?}");
            assert_eq!(plan.manual_download.unwrap().reason, reason);
            // The install without a chosen file refuses the same files with the
            // code that opens the manual section, never a generic error.
            let project: Project = serde_json::from_value(u27_project(allow, Some(U27_PAGE))).unwrap();
            let file: CfFile = serde_json::from_value(u27_file(url)).unwrap();
            let refusal = crate::errors::expected(manual_install_refusal(&project, &file).expect("refused"));
            assert_eq!(refusal.code, "resource.manualDownload", "{reason:?}");
        }
        let project: Project = serde_json::from_value(u27_project(Some(true), Some(U27_PAGE))).unwrap();
        let file: CfFile = serde_json::from_value(u27_file(Some(U27_CDN))).unwrap();
        assert!(manual_install_refusal(&project, &file).is_none(), "a downloadable file installs");

        let (plan, _) = u27_plan(&state, u27_project(Some(true), Some(U27_PAGE)), u27_file(Some(U27_CDN)));
        let plan = plan.unwrap();
        assert!(!plan.manual_only && plan.manual_download.is_none(), "a downloadable file is planned as before");

        // Planning still refuses what the install would refuse for other reasons.
        let mut bad_hash = u27_file(Some(U27_CDN));
        bad_hash["hashes"] = serde_json::json!([{"algo":1,"value":"not-a-sha1"}]);
        let (plan, _) = u27_plan(&state, u27_project(Some(true), Some(U27_PAGE)), bad_hash);
        assert!(plan.unwrap_err().detail.unwrap_or_default().contains("校验值"));
        let mut wrong_type = u27_file(None);
        wrong_type["fileName"] = "fixture-1.0.zip".into();
        let (plan, _) = u27_plan(&state, u27_project(Some(true), Some(U27_PAGE)), wrong_type);
        assert!(plan.unwrap_err().detail.unwrap_or_default().contains("文件类型"), "a manual-only file is still checked");
    }

    #[test]
    fn u27_manual_reasons_follow_the_install_checks() {
        let check = |allow: Option<bool>, url: Option<&str>| {
            let project: Project = serde_json::from_value(u27_project(allow, None)).unwrap();
            let file: CfFile = serde_json::from_value(u27_file(url)).unwrap();
            manual_reason(&project, &file)
        };
        assert_eq!(check(Some(false), Some(U27_CDN)), Some(ManualReason::DistributionForbidden));
        assert_eq!(check(Some(false), None), Some(ManualReason::DistributionForbidden));
        assert_eq!(check(Some(true), None), Some(ManualReason::NoDownloadUrl));
        assert_eq!(check(None, Some("")), Some(ManualReason::NoDownloadUrl));
        assert_eq!(check(None, Some("http://mediafilez.forgecdn.net/files/fixture-1.0.jar")), Some(ManualReason::UntrustedUrl));
        assert_eq!(check(None, Some("https://forgecdn.net.example.test/fixture-1.0.jar")), Some(ManualReason::UntrustedUrl));
        assert_eq!(check(Some(true), Some(U27_CDN)), None);
        assert_eq!(check(None, Some(U27_CDN)), None);
    }

    #[test]
    fn u27_manual_file_links_name_the_file_and_stay_inside_the_opener_scope() {
        let capabilities: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let scope: Vec<String> = capabilities["permissions"].as_array().unwrap().iter()
            .find(|entry| entry["identifier"] == "opener:allow-open-url").unwrap()["allow"]
            .as_array().unwrap().iter().filter_map(|entry| entry["url"].as_str().map(str::to_owned)).collect();
        // The opener's glob patterns let a trailing `*` match `/` as well.
        let allowed = |url: &str| scope.iter().any(|pattern| pattern.strip_suffix('*').map_or(pattern == url, |prefix| url.starts_with(prefix)));
        let file: CfFile = serde_json::from_value(u27_file(None)).unwrap();
        let project_page = "https://www.curseforge.com/projects/456";
        for (website, expected) in [
            (Some(U27_PAGE), "https://www.curseforge.com/minecraft/mc-mods/fixture/files/123"),
            (Some("https://www.curseforge.com/minecraft/shaders/fixture-shader/"), "https://www.curseforge.com/minecraft/shaders/fixture-shader/files/123"),
            (Some("https://www.curseforge.com/minecraft/texture-packs/fixture_pack"), "https://www.curseforge.com/minecraft/texture-packs/fixture_pack/files/123"),
            (None, project_page),
            (Some("not a link"), project_page),
            (Some("http://www.curseforge.com/minecraft/mc-mods/fixture"), project_page),
            (Some("https://curseforge.com/minecraft/mc-mods/fixture"), project_page),
            (Some("https://www.curseforge.com.example.test/minecraft/mc-mods/fixture"), project_page),
            (Some("https://user@www.curseforge.com/minecraft/mc-mods/fixture"), project_page),
            (Some("https://www.curseforge.com:8443/minecraft/mc-mods/fixture"), project_page),
            (Some("https://www.curseforge.com/minecraft/mc-mods/fixture?page=2"), project_page),
            (Some("https://www.curseforge.com/minecraft/mc-mods/fixture#files"), project_page),
            (Some("https://www.curseforge.com/minecraft/mc-mods/fixture/files/999"), project_page),
            (Some("https://www.curseforge.com/minecraft/modpacks/fixture"), project_page),
            (Some("https://www.curseforge.com/minecraft/mc-mods/fix%2Fture"), project_page),
        ] {
            let project: Project = serde_json::from_value(u27_project(Some(false), website)).unwrap();
            let url = file_page(&project, &file);
            assert_eq!(url, expected, "{website:?}");
            assert!(allowed(&url), "{url} is outside the opener scope");
        }
    }

    #[test]
    fn u1264_curseforge_creation_uses_only_exact_eligible_file_metadata() {
        let mut project: Project = serde_json::from_value(serde_json::json!({
            "id":456,"gameId":432,"name":"Fixture","slug":"fixture","summary":"Fixture",
            "classId":6,"downloadCount":0.0,"authors":[],"allowModDistribution":true
        })).unwrap();
        let mut file = example();
        let kind = ResourceKind::Mod;
        validate_pinned_file(&project, &file, 123, kind).unwrap();
        assert!(validate_pinned_file(&project, &file, 124, kind).is_err());
        assert!(validate_pinned_file(&project, &file, 123, ResourceKind::Shader).is_err());
        let metadata = pinned_metadata(&file, kind);
        crate::resource_targets::validate_pinned_creation_pair(&metadata, kind, "fabric", "1.21.1").unwrap();
        assert!(crate::resource_targets::validate_pinned_creation_pair(&metadata, kind, "quilt", "1.21.1").is_err());
        assert!(crate::resource_targets::validate_pinned_creation_pair(&metadata, kind, "fabric", "1.21.2").is_err());
        project.allow_mod_distribution = Some(false);
        assert!(validate_pinned_file(&project, &file, 123, kind).is_err());
        project.allow_mod_distribution = Some(true);
        file.file_name = "../outside.jar".into();
        assert!(validate_pinned_file(&project, &file, 123, kind).is_err());
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
            release_type: 1,
            display_name: String::new(),
            file_fingerprint: 0,
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

    #[test]
    fn project_page_only_allows_https_www_curseforge_links() {
        let make = |link: Option<&str>| Project {
            id: 789,
            game_id: 432,
            name: "Dependency".into(),
            slug: "dependency".into(),
            summary: String::new(),
            class_id: Some(6),
            download_count: 0.0,
            authors: vec![],
            logo: None,
            latest_files_indexes: vec![],
            latest_files: vec![],
            allow_mod_distribution: Some(true),
            links: Links {
                website_url: link.map(str::to_owned),
            },
        };
        let fallback = "https://www.curseforge.com/projects/789";
        assert_eq!(
            project_page(&make(Some("https://www.curseforge.com/minecraft/mc-mods/dep"))),
            "https://www.curseforge.com/minecraft/mc-mods/dep"
        );
        for untrusted in [
            None,
            Some("http://www.curseforge.com/minecraft/mc-mods/dep"),
            Some("https://curseforge.com/minecraft/mc-mods/dep"),
            Some("https://www.curseforge.com:8443/minecraft/mc-mods/dep"),
            Some("https://user@www.curseforge.com/minecraft/mc-mods/dep"),
            Some("https://evil.example/minecraft/mc-mods/dep"),
        ] {
            assert_eq!(project_page(&make(untrusted)), fallback, "{untrusted:?}");
        }
    }

    #[test]
    fn restricted_file_rule_and_pinned_plan_with_dependencies() {
        let mut project: Project = serde_json::from_value(serde_json::json!({
            "id": 456, "gameId": 432, "name": "Fixture", "slug": "fixture", "summary": "Fixture",
            "classId": 6, "downloadCount": 0.0, "authors": [], "allowModDistribution": true
        }))
        .unwrap();
        let mut file = example();
        assert!(!is_restricted_file(&project, &file));
        project.allow_mod_distribution = Some(false);
        assert!(is_restricted_file(&project, &file));
        project.allow_mod_distribution = Some(true);
        file.download_url = None;
        assert!(is_restricted_file(&project, &file));
        file.download_url = Some("https://evil.example/a.jar".into());
        assert!(is_restricted_file(&project, &file));
        file.download_url = Some("https://mediafilez.forgecdn.net/files/example.jar".into());
        assert!(!is_restricted_file(&project, &file));

        // A pinned CurseForge file that declares required dependencies still
        // offers new-instance creation (never gated by the removed can_create_pinned).
        assert_eq!(file.dependencies[0].relation_type, 3);
        let manifest = vec![("1.21.1".into(), "release".into())];
        let plan = pinned_target_plan(
            "456",
            "mod",
            ResourceKind::Mod,
            &project,
            &file,
            &[],
            &manifest,
        );
        assert!(plan.suggestion.is_some(), "{plan:?}");
        assert!(plan.unsupported_reason.is_none(), "{plan:?}");
        assert!(!plan.manual_only && plan.manual_download.is_none(), "{plan:?}");

        // A restricted pinned root file that also declares required dependencies
        // still produces d13's manual-only plan with its details and targets.
        let (_folder, state) = u27_state();
        let mut restricted_with_deps = u27_file(None);
        restricted_with_deps["dependencies"] = serde_json::json!([{"modId": 789, "relationType": 3}]);
        let (manual_plan, _) = u27_plan(
            &state,
            u27_project(Some(false), Some(U27_PAGE)),
            restricted_with_deps,
        );
        let manual_plan = manual_plan.unwrap();
        assert!(manual_plan.manual_only, "{manual_plan:?}");
        assert!(manual_plan.unsupported_reason.is_none(), "{manual_plan:?}");
        let download = manual_plan.manual_download.as_ref().unwrap();
        assert_eq!(download.reason, ManualReason::DistributionForbidden);
        assert_eq!(download.url, "https://www.curseforge.com/minecraft/mc-mods/fixture/files/123");
        assert_eq!(download.file_name, "fixture-1.0.jar");
        assert!(
            manual_plan.targets.iter().any(|row| row.version_id == "fabric-test" && row.compatible),
            "compatible targets stay planned for the manual-only folder hint"
        );
    }

    #[test]
    fn installed_dependencies_grouping_is_deterministic_and_prefers_resolved_file_id() {
        let mut a = example();
        a.id = 100;
        a.file_name = "a-old.jar".into();
        let mut b = example();
        b.id = 200;
        b.file_name = "z-selected.jar".into();
        let mut c = example();
        c.id = 150;
        c.file_name = "m-mid.jar".into();

        // Without preference: sorted alphabetically by filename.
        let mut identified = HashMap::new();
        identified.insert("z-selected.jar".into(), (456, b.clone()));
        identified.insert("a-old.jar".into(), (456, a.clone()));
        identified.insert("m-mid.jar".into(), (456, c.clone()));
        let plain = group_installed(identified.clone(), None);
        let names: Vec<_> = plain[&456].iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["a-old.jar", "m-mid.jar", "z-selected.jar"]);

        // Preferring file id 200 puts z-selected.jar first, then remaining sorted.
        let preferred = group_installed(identified, Some((456, 200)));
        let names: Vec<_> = preferred[&456].iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["z-selected.jar", "a-old.jar", "m-mid.jar"]);
    }
}
