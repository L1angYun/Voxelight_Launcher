//! Standards-based Modrinth and CurseForge pack import/export into new instances.
use crate::path_grants::{PathGrants, PathUse};
use crate::{
    instances::{self, checked_absolute, FileRecord},
    models::Instance,
    storage::{safe_join, validate_id, LauncherState},
};
use futures_util::StreamExt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use sha2::{Digest, Sha512};
use std::path::PathBuf;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, State};
use tokio::io::AsyncWriteExt;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

#[path = "pack_update.rs"]
pub(crate) mod pack_update;

const MAX_PACK_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_ZIP_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_METADATA: usize = 16 * 1024 * 1024;
const API: &str = "https://api.modrinth.com/v2";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackIndex {
    format_version: u32,
    game: String,
    version_id: String,
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    files: Vec<PackFile>,
    dependencies: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackFile {
    path: String,
    hashes: BTreeMap<String, String>,
    downloads: Vec<String>,
    file_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    env: Option<BTreeMap<String, String>>,
}
#[derive(Clone, Deserialize)]
struct ApiVersion {
    id: String,
    project_id: String,
    name: String,
    version_number: String,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
    date_published: String,
    files: Vec<ApiFile>,
}
#[derive(Clone, Deserialize)]
struct ApiFile {
    url: String,
    filename: String,
    primary: bool,
    size: u64,
    hashes: BTreeMap<String, String>,
}
#[derive(Deserialize)]
struct ApiProject {
    id: String,
    title: String,
    project_type: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackVersion {
    pub id: String,
    pub name: String,
    pub version_number: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub date_published: String,
    pub size: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackImportResult {
    pub instance: Instance,
    pub downloaded: usize,
    pub skipped_optional: usize,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackExportResult {
    pub path: String,
    pub download_files: usize,
    pub override_files: usize,
    pub warnings: Vec<String>,
}

fn identifier(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("整合包项目或版本标识无效".into());
    }
    Ok(())
}
fn allowed_download(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "整合包下载地址无效")?;
    let allowed = [
        "cdn.modrinth.com",
        "github.com",
        "raw.githubusercontent.com",
        "gitlab.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "github-releases.githubusercontent.com",
        "mediafilez.forgecdn.net",
        "edge.forgecdn.net",
        "media.forgecdn.net",
    ];
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || !allowed.contains(&url.host_str().unwrap_or(""))
    {
        return Err("整合包文件下载地址不在受信任 HTTPS 来源列表中".into());
    }
    Ok(url)
}
fn client(state: &LauncherState, download: bool) -> Result<reqwest::Client, String> {
    let policy = if download {
        reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() >= 5 {
                a.error("下载重定向过多")
            } else if allowed_download(a.url().as_str()).is_ok() {
                a.follow()
            } else {
                a.error("下载跳转到不受信任来源")
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
        .timeout(Duration::from_secs(if download { 900 } else { 60 }))
        .redirect(policy);
    crate::network::for_state_builder(state, builder)?
        .build()
        .map_err(|_| "无法创建整合包网络客户端".into())
}
pub(crate) const PLATFORM_UNREACHABLE: &str = "整合包平台连接失败，请检查网络";
pub(crate) const NOT_MRPACK: &str = "所选版本不是标准 .mrpack 文件";
/// Followed by the status and a hint.
pub(crate) const PLATFORM_REFUSED: &str = "整合包平台请求失败（HTTP ";
pub(crate) const PLATFORM_INTERRUPTED: &str = "整合包元数据传输失败";

async fn json_response<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T, String> {
    let response = request.send().await.map_err(|_| PLATFORM_UNREACHABLE)?;
    json_body(response).await
}

/// Like `json_response`, with something the platform no longer has (404 or
/// 410) as `None`; every other failure is still an error.
async fn json_response_or_missing<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<Option<T>, String> {
    let response = request.send().await.map_err(|_| PLATFORM_UNREACHABLE)?;
    if matches!(response.status().as_u16(), 404 | 410) {
        return Ok(None);
    }
    json_body(response).await.map(Some)
}

async fn json_body<T: DeserializeOwned>(response: reqwest::Response) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(format!(
            "{PLATFORM_REFUSED}{}）；CurseForge 请求请检查自己的 API Key 和分发权限",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_METADATA as u64)
    {
        return Err("整合包元数据过大".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| PLATFORM_INTERRUPTED)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_METADATA {
            return Err("整合包元数据超过限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "整合包平台返回的数据格式无效".into())
}
fn primary(version: &ApiVersion) -> Result<&ApiFile, String> {
    version
        .files
        .iter()
        .find(|f| f.primary)
        .or_else(|| version.files.first())
        .ok_or_else(|| "整合包版本没有下载文件".into())
}
fn valid_hash(value: &str, size: usize) -> bool {
    value.len() == size && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn hashes(path: &Path) -> Result<(String, String, u64), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut a = Sha1::new();
    let mut b = Sha512::new();
    let mut size = 0;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        size += n as u64;
        a.update(&buffer[..n]);
        b.update(&buffer[..n]);
    }
    Ok((
        format!("{:x}", a.finalize()),
        format!("{:x}", b.finalize()),
        size,
    ))
}

/// A path segment shaped like a Windows 8.3 short name (`~` then a digit).
/// Such a path may later resolve to another file through the alias, so the
/// lock never treats it as a managed download; matching too much only makes
/// the file an override, which is the safe side.
pub(crate) fn short_name_shaped(path: &str) -> bool {
    path.split('/').any(|part| {
        part.split('~')
            .skip(1)
            .any(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
    })
}

struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Earlier versions kept every downloaded `<uuid>.mrpack`. Remove such files
/// once they are older than `min_age`; a younger one may still be importing in
/// another launcher that shares this data directory.
fn sweep_pack_downloads(directory: &Path, min_age: std::time::Duration) {
    let Ok(entries) = fs::read_dir(directory) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        // A downloaded archive, or the copy stage_copy was making when the launcher stopped.
        let Some(id) = name.to_str().and_then(|name| {
            name.strip_suffix(".mrpack")
                .or_else(|| name.strip_prefix(".pack-stage-").and_then(|rest| rest.strip_suffix(".part")))
        }) else {
            continue;
        };
        if !uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.hyphenated().to_string() == id) {
            continue;
        }
        let Ok(stat) = fs::symlink_metadata(entry.path()) else { continue };
        let old = stat
            .modified()
            .ok()
            .and_then(|time| time.elapsed().ok())
            .is_some_and(|age| age >= min_age);
        if stat.is_file() && old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// The receipt is taken from the copy in the stage, so neither a stale cache
/// entry nor a change between hashing and copying can produce a false receipt.
fn staged_receipt(
    target: &Path,
    downloaded: bool,
    matches: impl Fn(&(String, String, u64)) -> bool,
) -> Result<VerifiedPackFile, String> {
    let checked = (|| {
        let (sha1, sha512, size) = hashes(target)?;
        let sha256 = instances::sha256(target)?;
        Ok::<_, String>(((sha1, sha512, size), sha256))
    })();
    match checked {
        Ok((values, sha256)) if matches(&values) => {
            let mut receipt = VerifiedPackFile::receipt(downloaded, values);
            receipt.sha256 = sha256;
            Ok(receipt)
        }
        other => {
            let _ = fs::remove_file(target);
            Err(other.err().unwrap_or_else(|| "整合包文件复制后校验失败".into()))
        }
    }
}

struct VerifiedPackFile {
    downloaded: bool,
    sha1: String,
    sha512: String,
    sha256: String,
    size: u64,
}

impl VerifiedPackFile {
    fn receipt(downloaded: bool, (sha1, sha512, size): (String, String, u64)) -> Self {
        Self { downloaded, sha1, sha512, sha256: String::new(), size }
    }

    fn lock_entry(self, path: String) -> LockedPackFile {
        LockedPackFile { path, sha1: self.sha1, sha512: self.sha512, size: self.size, sha256: self.sha256 }
    }
}

async fn fetch_verified(
    state: &LauncherState,
    urls: &[String],
    target: &Path,
    size: u64,
    expected: &BTreeMap<String, String>,
) -> Result<VerifiedPackFile, String> {
    if size == 0 || size > MAX_ARCHIVE_BYTES {
        return Err("单个整合包文件大小无效或超过 2 GiB".into());
    }
    let sha512 = expected.get("sha512");
    let sha1 = expected.get("sha1");
    if sha512.is_none() && sha1.is_none() {
        return Err("文件没有可核验的 SHA-512 或 SHA-1，拒绝安装".into());
    }
    if sha512.is_some_and(|v| !valid_hash(v, 128)) || sha1.is_some_and(|v| !valid_hash(v, 40)) {
        return Err("文件校验值格式无效".into());
    }
    let matches = |values: &(String, String, u64)| {
        values.2 == size
            && sha1.is_none_or(|v| v.eq_ignore_ascii_case(&values.0))
            && sha512.is_none_or(|v| v.eq_ignore_ascii_case(&values.1))
    };
    let cache_root = checked_absolute(&state.data_dir.join("pack-cache"))?;
    fs::create_dir_all(&cache_root).map_err(|e| e.to_string())?;
    let cache_key = sha512
        .or(sha1)
        .ok_or("文件缺少校验值")?
        .to_ascii_lowercase();
    let cache = safe_join(&cache_root, &format!("{cache_key}.bin"))?;
    let cached = if cache.is_file() { Some(hashes(&cache)?) } else { None };
    if cached.filter(&matches).is_some() {
        return stage_copy(&cache, target, false, &matches).await;
    }
    let network = client(&state, true)?;
    // Parts of 1 MiB or more continue across attempts, cancels and restarts
    // (U0266); a part held by another download falls back to a part of our own.
    let parts = crate::parts::PartStore::new(cache_root.join(".parts"));
    let key = if size >= crate::parts::RESUME_MIN {
        match (sha512, sha1) {
            (Some(hex), _) => crate::parts::PartKey::new(crate::parts::Algo::Sha512, hex, size),
            (None, Some(hex)) => crate::parts::PartKey::new(crate::parts::Algo::Sha1, hex, size),
            (None, None) => None,
        }
    } else {
        None
    };
    let mut allowed = Vec::new();
    let mut rejected = None;
    for url in urls.iter().take(8) {
        match allowed_download(url) {
            Ok(url) => allowed.push(url),
            Err(error) => rejected = Some(error),
        }
    }
    let download = PackFileDownload { network: &network, parts: &parts, key: key.as_ref(), cache_root: &cache_root, cache: &cache, size };
    download.into_cache(&allowed, &state.control, &trusted_response, &matches, rejected).await?;
    stage_copy(&cache, target, true, &matches).await
}

/// Every try of one modpack file at one URL, including tries that continued its part.
const MAX_PACK_FILE_TRIES: usize = 12;

/// One modpack file on its way into the content-addressed cache.
struct PackFileDownload<'a> {
    network: &'a reqwest::Client,
    parts: &'a crate::parts::PartStore,
    key: Option<&'a crate::parts::PartKey>,
    cache_root: &'a Path,
    cache: &'a Path,
    size: u64,
}

impl PackFileDownload<'_> {
    /// Brings the verified file into the cache from `urls`. As for game files:
    /// a try that continued the part is free, a stall and a discarded part get
    /// one more try at the same URL, tries per URL are capped, and bytes an
    /// earlier URL wrote are not thrown away for another origin.
    async fn into_cache(
        &self,
        urls: &[reqwest::Url],
        control: &crate::downloads::DownloadControl,
        check: &ResponseCheck,
        matches: &(dyn Fn(&(String, String, u64)) -> bool + Sync),
        rejected: Option<String>,
    ) -> Result<(), String> {
        let mut slot = None;
        let mut last_error = rejected.unwrap_or_else(|| "整合包没有受支持的下载地址".to_owned());
        let mut written_here = false;
        for url in urls {
            let origin = crate::parts::origin(url);
            let (mut tries, mut refetched, mut restalled) = (0, false, false);
            loop {
                tries += 1;
                control.checkpoint().await?;
                if slot.is_none() {
                    slot = self.key.and_then(|key| self.parts.open(key, self.size).ok().flatten());
                }
                let protect = written_here && slot.as_ref().is_some_and(|part| part.holds_bytes_from_another(&origin));
                let before = slot.as_ref().map(crate::parts::ResumablePart::mark);
                let result = if slot.is_some() && !protect {
                    match fetch_part(self.network, url, &mut slot, self.size, control, check).await {
                        Ok(values) => self.publish_part(&mut slot, &values, matches).await,
                        Err(error) => Err(error),
                    }
                } else {
                    let whole = fetch_whole(self.network, url, self.cache_root, self.cache, self.size, control, check, &|values: &(String, String, u64)| matches(values)).await;
                    if whole.is_ok() && protect {
                        if let Some(part) = slot.take() {
                            part.discard();
                        }
                    }
                    whole.map(|_| ())
                };
                let error = match result {
                    Ok(()) => return Ok(()),
                    Err(error) => error,
                };
                let after = slot.as_ref().map(crate::parts::ResumablePart::mark);
                let progressed = crate::parts::progressed(before.as_ref(), after.as_ref());
                written_here = slot.is_some() && (written_here || crate::parts::wrote(before.as_ref(), after.as_ref()));
                let discarded = before.is_some() && slot.is_none();
                let stalled = error == crate::parts::STALLED;
                let again = progressed || (discarded && !refetched) || (stalled && !restalled);
                refetched |= discarded;
                restalled |= stalled;
                last_error = error;
                control.checkpoint().await?;
                if !again || tries >= MAX_PACK_FILE_TRIES {
                    break;
                }
                control.during_cancellable_io(tokio::time::sleep(std::time::Duration::from_millis(500))).await?;
            }
        }
        Err(last_error)
    }

    /// Checks the whole part and moves it into the cache; a part that fails is discarded.
    async fn publish_part(
        &self,
        slot: &mut Option<crate::parts::ResumablePart>,
        values: &(String, String, u64),
        matches: &(dyn Fn(&(String, String, u64)) -> bool + Sync),
    ) -> Result<(), String> {
        let part = slot.take().ok_or("下载分片不可用")?;
        if !matches(values) {
            part.discard();
            return Err("整合包文件哈希或大小校验失败".into());
        }
        checked_absolute(self.cache)?;
        crate::parts::publish_off_task(part, self.cache).await.map_err(|e| e.to_string())
    }
}

/// The modpack client's transfers use the task's cancel, pause, throttle and stall limit.
impl crate::parts::Hooks for &crate::downloads::DownloadControl {
    async fn cancellable<F: std::future::Future>(&self, future: F) -> Result<F::Output, String> {
        self.during_cancellable_io(future).await
    }
    async fn checkpoint(&self) -> Result<(), String> {
        crate::downloads::DownloadControl::checkpoint(self).await
    }
    async fn throttle(&self, bytes: usize) -> Result<(), String> {
        crate::downloads::DownloadControl::throttle(self, bytes).await
    }
    fn stall_limit(&self) -> std::time::Duration {
        crate::downloads::DownloadControl::stall_limit(self)
    }
    fn connections(&self) -> Option<&crate::downloads::Connections> {
        Some(crate::downloads::DownloadControl::connections(self))
    }
}

/// Where a response came from after redirects; tests pass a local server.
type ResponseCheck = dyn Fn(&reqwest::Response) -> Result<(), String> + Sync;

fn trusted_response(response: &reqwest::Response) -> Result<(), String> {
    allowed_download(response.url().as_str()).map(|_| ())
}

/// One attempt through the resumable part; returns the hashes of the whole part.
async fn fetch_part(
    network: &reqwest::Client,
    url: &reqwest::Url,
    slot: &mut Option<crate::parts::ResumablePart>,
    size: u64,
    control: &crate::downloads::DownloadControl,
    check: &ResponseCheck,
) -> Result<(String, String, u64), String> {
    let mut a = Sha1::new();
    let mut b = Sha512::new();
    crate::parts::transfer(network.get(url.clone()), url, slot, size, &control, check, &mut |bytes| {
        a.update(bytes);
        b.update(bytes);
    })
    .await?;
    Ok((format!("{:x}", a.finalize()), format!("{:x}", b.finalize()), size))
}

/// One attempt in one go (small files, or a part held elsewhere). The part is
/// owned before the first await and removed however the attempt ends.
async fn fetch_whole(
    network: &reqwest::Client,
    url: &reqwest::Url,
    cache_root: &Path,
    cache: &Path,
    size: u64,
    control: &crate::downloads::DownloadControl,
    check: &ResponseCheck,
    matches: &impl Fn(&(String, String, u64)) -> bool,
) -> Result<(String, String, u64), String> {
    use crate::parts::within_stall;
    let request = network.get(url.clone()).timeout(crate::parts::TRANSFER_TIMEOUT);
    let _connection = crate::parts::connection(&control).await?;
    let response = within_stall(&control, request.send()).await?.map_err(|_| "整合包文件下载失败")?;
    if !response.status().is_success() {
        return Err(format!("整合包文件下载失败（HTTP {}）", response.status().as_u16()));
    }
    check(&response)?;
    if response.content_length().is_some_and(|n| n != size) {
        return Err("整合包文件声明大小不一致".into());
    }
    let mut part = crate::download_io::DownloadPart::create(safe_join(
        cache_root,
        &format!(".pack-download-{}.part", uuid::Uuid::new_v4()),
    )?)
    .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut a = Sha1::new();
    let mut b = Sha512::new();
    let mut count = 0u64;
    while let Some(chunk) = within_stall(&control, stream.next()).await? {
        control.checkpoint().await?;
        let chunk = chunk.map_err(|_| "整合包文件传输中断")?;
        control.throttle(chunk.len()).await?;
        count = count.saturating_add(chunk.len() as u64);
        if count > size {
            return Err("整合包文件超过声明大小".into());
        }
        a.update(&chunk);
        b.update(&chunk);
        part.file().write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    part.file().sync_all().await.map_err(|e| e.to_string())?;
    let values = (format!("{:x}", a.finalize()), format!("{:x}", b.finalize()), count);
    if !matches(&values) {
        return Err("整合包文件哈希或大小校验失败".into());
    }
    checked_absolute(cache)?;
    part.publish(cache).map_err(|e| e.to_string())?;
    Ok(values)
}

/// Copies a verified cache file into the stage without replacing anything
/// there (H08): through a part beside the target, then a no-replace move.
async fn stage_copy(
    cache: &Path,
    target: &Path,
    downloaded: bool,
    matches: &impl Fn(&(String, String, u64)) -> bool,
) -> Result<VerifiedPackFile, String> {
    let parent = target.parent().ok_or("整合包文件目标缺少父目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut part = crate::download_io::DownloadPart::create(parent.join(format!(".pack-stage-{}.part", uuid::Uuid::new_v4())))
        .map_err(|e| e.to_string())?;
    let mut input = tokio::fs::File::open(cache).await.map_err(|e| e.to_string())?;
    tokio::io::copy(&mut input, part.file()).await.map_err(|e| e.to_string())?;
    part.file().sync_all().await.map_err(|e| e.to_string())?;
    part.publish_new(target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "整合包目标文件已存在，拒绝覆盖".to_owned()
        } else {
            error.to_string()
        }
    })?;
    staged_receipt(target, downloaded, matches)
}

/// Validate all ZIP member paths, case collisions, symlinks and total expanded size before extraction.
#[cfg(test)]
fn inspect_zip(archive: &Path) -> Result<(), String> {
    inspect_zip_limits(archive, MAX_ZIP_BYTES, MAX_ZIP_BYTES, MAX_ZIP_BYTES)
}
#[cfg(test)]
fn inspect_zip_limits(
    archive: &Path,
    archive_limit: u64,
    total_limit: u64,
    file_limit: u64,
) -> Result<(), String> {
    inspect_zip_limits_controlled(archive, archive_limit, total_limit, file_limit, None)
}

fn inspect_zip_limits_controlled(
    archive: &Path,
    archive_limit: u64,
    total_limit: u64,
    file_limit: u64,
    state: Option<&LauncherState>,
) -> Result<(), String> {
    checked_absolute(archive)?;
    if fs::metadata(archive).map_err(|e| e.to_string())?.len() > archive_limit {
        return Err("压缩包大小超过此导入类型的限制".into());
    }
    let mut zip = ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|_| "文件不是有效 ZIP 压缩包")?;
    inspect_zip_reader(&mut zip, total_limit, file_limit, state)
}

pub(crate) fn inspect_zip_reader<R: std::io::Read + std::io::Seek>(
    zip: &mut ZipArchive<R>, total_limit: u64, file_limit: u64, state: Option<&LauncherState>,
) -> Result<(), String> {
    if zip.len() > MAX_ZIP_ENTRIES {
        return Err("ZIP 文件数量超过限制".into());
    }
    let mut total = 0u64;
    let mut seen = HashSet::new();
    for n in 0..zip.len() {
        if let Some(state) = state { instances::sync_checkpoint(state)?; }
        let file = zip.by_index(n).map_err(|e| e.to_string())?;
        let entry_name = file.name().map_err(|e| e.to_string())?;
        let name = entry_name.trim_end_matches('/');
        if name.is_empty() {
            continue;
        }
        archive_relative(name)?;
        safe_join(Path::new("archive-validation-root"), name)?;
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("ZIP 包含符号链接，已拒绝导入".into());
        }
        if !seen.insert(name.to_lowercase()) {
            return Err("ZIP 包含重复或大小写冲突的路径".into());
        }
        total = total.checked_add(file.size()).ok_or("ZIP 大小溢出")?;
        if total > total_limit || file.size() > file_limit {
            return Err("ZIP 解压大小超过限制".into());
        }
        if suspicious_ratio(file.size(), file.compressed_size()) {
            return Err("ZIP 压缩比例异常，拒绝解压".into());
        }
    }
    Ok(())
}

const MAX_ZIP_ENTRIES: usize = 100_000;

/// Entries above 1 MiB that expand more than 1000:1 (integer ratio) are refused.
fn suspicious_ratio(size: u64, compressed: u64) -> bool {
    size > 1024 * 1024 && compressed > 0 && size / compressed > 1000
}
pub(crate) fn archive_relative(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("压缩包或清单包含不规范的相对路径".into());
    }
    for part in value.split('/') {
        validate_id(part)?;
    }
    Ok(())
}

#[cfg(test)]
fn extract_zip_layer(
    archive: &Path,
    destination: &Path,
    prefix: &str,
    skip: &[&str],
) -> Result<(), String> {
    extract_zip_controlled(archive, destination, prefix, skip, None)
}
pub(crate) fn extract_zip_controlled(
    archive: &Path,
    destination: &Path,
    prefix: &str,
    skip: &[&str],
    state: Option<&LauncherState>,
) -> Result<(), String> {
    extract_zip_tracking(archive, destination, prefix, skip, state, None)
}

fn extract_zip_tracking(
    archive: &Path,
    destination: &Path,
    prefix: &str,
    skip: &[&str],
    state: Option<&LauncherState>,
    mut written_paths: Option<&mut HashSet<String>>,
) -> Result<(), String> {
    inspect_zip_limits_controlled(archive, MAX_ZIP_BYTES, MAX_ZIP_BYTES, MAX_ZIP_BYTES, state)?;
    checked_absolute(destination)?;
    let mut zip = ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for n in 0..zip.len() {
        if let Some(state) = state {
            tokio::runtime::Handle::current().block_on(state.control.checkpoint())?;
        }
        let mut entry = zip.by_index(n).map_err(|e| e.to_string())?;
        let name = entry.name().map_err(|e| e.to_string())?.into_owned();
        let Some(relative) = name.strip_prefix(prefix) else {
            continue;
        };
        let relative = relative.trim_end_matches('/');
        if relative.is_empty() || skip.contains(&relative) {
            continue;
        }
        let path = safe_join(destination, relative)?;
        if entry.is_dir() {
            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let expected = entry.size();
        let actual = std::io::copy(&mut (&mut entry).take(expected + 1), &mut output)
            .map_err(|_| "ZIP 文件读取或 CRC 校验失败")?;
        if actual != expected {
            return Err("ZIP 条目大小不一致".into());
        }
        if let Some(paths) = written_paths.as_deref_mut() {
            paths.insert(relative.to_lowercase());
        }
    }
    Ok(())
}
fn zip_json<T: DeserializeOwned>(archive: &Path, name: &str) -> Result<T, String> {
    let mut zip = ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut file = zip
        .by_name(name)
        .map_err(|_| format!("压缩包缺少 {name}"))?;
    if file.size() > MAX_METADATA as u64 {
        return Err("整合包清单过大".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_METADATA as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_METADATA {
        return Err("整合包清单解压后超过限制".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("整合包清单格式错误：{e}"))
}
fn has_entry(path: &Path, name: &str) -> Result<bool, String> {
    let mut zip = ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let found = zip.by_name(name).is_ok();
    Ok(found)
}

fn dependencies(
    values: &BTreeMap<String, String>,
) -> Result<(String, Option<(String, String)>), String> {
    let minecraft = values
        .get("minecraft")
        .ok_or("整合包没有声明 Minecraft 版本")?
        .clone();
    validate_id(&minecraft)?;
    let mut loader = None;
    for (key, value) in values {
        if key == "minecraft" {
            continue;
        }
        let kind = match key.as_str() {
            "fabric-loader" => "fabric",
            "quilt-loader" => "quilt",
            "forge" => "forge",
            "neoforge" => "neoforge",
            _ => return Err(format!("整合包要求尚不支持的依赖 {key}")),
        };
        if loader.is_some() {
            return Err("同一整合包声明了多个不兼容的加载器".into());
        }
        validate_id(value)?;
        loader = Some((kind.into(), value.clone()));
    }
    Ok((minecraft, loader))
}
async fn install_dependencies(
    state: &LauncherState,
    app: &AppHandle,
    values: &BTreeMap<String, String>,
) -> Result<(String, String, String), String> {
    let (minecraft, loader) = dependencies(values)?;
    state.control.checkpoint().await?;
    if let Some((kind, version)) = loader {
        let result =
            crate::loaders::install_loader_inner(state, app, &kind, &minecraft, &version).await?;
        Ok((result.version_id, kind, version))
    } else {
        crate::minecraft::install(state, app, &minecraft).await?;
        Ok((minecraft, "vanilla".into(), String::new()))
    }
}

/// The files of `index` this client installs, checked: the format and game,
/// the dependencies, at most 20 000 files, safe paths without duplicates, a
/// valid client environment, sha1 and sha512 on every installed file and at
/// most 8 GiB in all. The second value counts optional files left out.
fn pack_selection(index: &PackIndex, optional: bool) -> Result<(Vec<&PackFile>, usize), String> {
    if index.format_version != 1 || index.game != "minecraft" {
        return Err("不支持此 Modrinth 整合包格式或游戏".into());
    }
    dependencies(&index.dependencies)?;
    if index.files.len() > 20_000 {
        return Err("整合包文件数量超过限制".into());
    }
    let mut total = 0u64;
    let mut paths = HashSet::new();
    let mut skipped = 0;
    let mut selected = Vec::new();
    for file in &index.files {
        archive_relative(&file.path)?;
        if !paths.insert(file.path.to_lowercase()) {
            return Err("整合包清单包含重复目标路径".into());
        }
        let client_env = file
            .env
            .as_ref()
            .and_then(|env| env.get("client"))
            .map(String::as_str)
            .unwrap_or("required");
        match client_env {
            "unsupported" => continue,
            "optional" if !optional => {
                skipped += 1;
                continue;
            }
            "required" | "optional" => {}
            _ => return Err("整合包客户端环境声明无效".into()),
        }
        for (name, length) in [("sha1", 40), ("sha512", 128)] {
            if file
                .hashes
                .get(name)
                .is_none_or(|hash| !valid_hash(hash, length))
            {
                return Err(format!("文件 {} 缺少有效 {name} 校验", file.path));
            }
        }
        // As the download would: refused here, so a plan never records a
        // file no lock can hold.
        if file.file_size == 0 || file.file_size > MAX_ARCHIVE_BYTES {
            return Err("单个整合包文件大小无效或超过 2 GiB".into());
        }
        total = total.checked_add(file.file_size).ok_or("整合包大小溢出")?;
        if total > MAX_PACK_BYTES {
            return Err("整合包下载总大小超过 8 GiB".into());
        }
        selected.push(file);
    }
    Ok((selected, skipped))
}

async fn mrpack_into(
    state: &Arc<LauncherState>,
    archive: &Path,
    stage: &Path,
    optional: bool,
) -> Result<StagedPack, String> {
    let index: PackIndex = zip_json(archive, "modrinth.index.json")?;
    let (selected, skipped) = pack_selection(&index, optional)?;
    let mut downloaded = 0;
    let mut files = Vec::new();
    for file in selected {
        state.control.checkpoint().await?;
        let target = safe_join(stage, &file.path)?;
        let materialized = fetch_verified(
            state,
            &file.downloads,
            &target,
            file.file_size,
            &file.hashes,
        )
        .await?;
        if materialized.downloaded {
            downloaded += 1;
        }
        files.push(materialized.lock_entry(file.path.clone()));
    }
    let override_paths = extract_pack_overrides(state, archive, stage,
        vec!["overrides/".into(), "client-overrides/".into()]).await?;
    let mut warnings = Vec::new();
    if skipped > 0 {
        warnings.push(format!("按选择跳过 {skipped} 个可选客户端文件"));
    }
    Ok(StagedPack { index, downloaded, skipped, warnings, files, override_paths })
}

async fn extract_pack_overrides(
    state: &Arc<LauncherState>,
    archive: &Path,
    stage: &Path,
    prefixes: Vec<String>,
) -> Result<HashSet<String>, String> {
    let state = state.clone();
    let archive = archive.to_owned();
    let stage = stage.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut paths = HashSet::new();
        for prefix in prefixes {
            extract_zip_tracking(&archive, &stage, &prefix, &[], Some(&state), Some(&mut paths))?;
        }
        Ok(paths)
    }).await.map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurseManifest {
    manifest_type: String,
    manifest_version: u32,
    name: String,
    minecraft: CurseMinecraft,
    files: Vec<CurseEntry>,
    overrides: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurseMinecraft {
    version: String,
    mod_loaders: Vec<CurseLoader>,
}
#[derive(Deserialize)]
struct CurseLoader {
    id: String,
    #[serde(default)]
    primary: bool,
}
#[derive(Deserialize)]
struct CurseEntry {
    #[serde(rename = "projectID")]
    project_id: u64,
    #[serde(rename = "fileID")]
    file_id: u64,
    #[serde(default = "default_true")]
    required: bool,
}
fn default_true() -> bool {
    true
}
#[derive(Deserialize)]
struct CfResponse<T> {
    data: T,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfFile {
    id: u64,
    mod_id: u64,
    file_name: String,
    file_length: u64,
    download_url: Option<String>,
    hashes: Vec<CfHash>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default = "default_true")]
    is_available: bool,
}
#[derive(Deserialize)]
struct CfHash {
    value: String,
    algo: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfProject {
    class_id: Option<u64>,
}
async fn curse_into(
    state: &Arc<LauncherState>,
    archive: &Path,
    stage: &Path,
    key: Option<String>,
    optional: bool,
) -> Result<StagedPack, String> {
    let manifest: CurseManifest = zip_json(archive, "manifest.json")?;
    if manifest.manifest_type != "minecraftModpack" || manifest.manifest_version != 1 {
        return Err("不支持此 CurseForge 清单格式".into());
    }
    let key = crate::curseforge_key::effective_cf_key(&state.data_dir, key.as_deref())?
        .ok_or("CurseForge 导入需要你自己申请的 API Key，请先在设置中保存。不会使用其它启动器的 Key。")?;
    if manifest.files.len() > 20_000 {
        return Err("CurseForge 整合包文件数量超过限制".into());
    }
    let key = crate::curseforge_key::sensitive_cf_header(&key)?;
    let api = client(&state, false)?;
    let mut deps = BTreeMap::from([("minecraft".into(), manifest.minecraft.version.clone())]);
    let loaders = manifest.minecraft.mod_loaders;
    if loaders.len() > 1 {
        return Err("CurseForge 整合包包含多个加载器，请手动选择并转换格式".into());
    }
    if let Some(loader) = loaders.first() {
        let _is_primary = loader.primary;
        let (kind, version) = loader
            .id
            .split_once('-')
            .ok_or("CurseForge 加载器标识无效")?;
        let key = match kind {
            "fabric" => "fabric-loader",
            "quilt" => "quilt-loader",
            "forge" => "forge",
            "neoforge" => "neoforge",
            _ => return Err(format!("不支持此 CurseForge 加载器 {kind}")),
        };
        deps.insert(key.into(), version.into());
    }
    dependencies(&deps)?;
    let mut total = 0u64;
    let mut downloaded = 0;
    let mut skipped = 0;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for item in manifest.files {
        state.control.checkpoint().await?;
        if !item.required && !optional {
            skipped += 1;
            continue;
        }
        let file: CfResponse<CfFile> = json_response(
            api.get(format!(
                "https://api.curseforge.com/v1/mods/{}/files/{}",
                item.project_id, item.file_id
            ))
            .header("x-api-key", key.clone()),
        )
        .await?;
        if file.data.id != item.file_id
            || file.data.mod_id != item.project_id
            || !file.data.is_available
        {
            return Err("CurseForge 文件身份或可用状态校验失败".into());
        }
        if !file.data.game_versions.is_empty()
            && !file
                .data
                .game_versions
                .contains(&manifest.minecraft.version)
        {
            return Err(format!(
                "CurseForge 文件 {} 与 Minecraft 版本不兼容",
                file.data.file_name
            ));
        }
        let Some(url) = file.data.download_url else {
            return Err(format!("项目 {} 文件 {} 禁止第三方分发或无公开下载地址。请在 https://www.curseforge.com/minecraft/search?search={} 手动取得授权文件后再导入；未创建成功实例。",item.project_id,item.file_id,item.project_id));
        };
        let project: CfResponse<CfProject> = json_response(
            api.get(format!(
                "https://api.curseforge.com/v1/mods/{}",
                item.project_id
            ))
            .header("x-api-key", key.clone()),
        )
        .await?;
        let folder = match project.data.class_id {
            Some(6) => "mods",
            Some(12) => "resourcepacks",
            Some(6552) => "shaderpacks",
            _ => return Err("CurseForge 清单包含不支持的文件类别".into()),
        };
        validate_id(&file.data.file_name)?;
        let relative = format!("{folder}/{}", file.data.file_name);
        if !seen.insert(relative.to_lowercase()) {
            return Err("CurseForge 清单文件名冲突".into());
        }
        let hash = file
            .data
            .hashes
            .into_iter()
            .find(|h| h.algo == 1)
            .ok_or("CurseForge 文件没有 SHA-1，无法校验")?;
        let expected = BTreeMap::from([("sha1".into(), hash.value)]);
        total = total
            .checked_add(file.data.file_length)
            .ok_or("整合包大小溢出")?;
        if total > MAX_PACK_BYTES {
            return Err("整合包总大小超过 8 GiB".into());
        }
        let target = safe_join(stage, &relative)?;
        let materialized = fetch_verified(
            state,
            &[url],
            &target,
            file.data.file_length,
            &expected,
        )
        .await?;
        if materialized.downloaded {
            downloaded += 1;
        }
        // Alongside CurseForge's expected SHA-1, record SHA-512 computed during verification.
        files.push(materialized.lock_entry(relative));
    }
    let prefix = manifest.overrides.trim_end_matches('/');
    safe_join(stage, prefix)?;
    let override_paths = extract_pack_overrides(state, archive, stage, vec![format!("{prefix}/")]).await?;
    let warnings = if skipped > 0 {
        vec![format!("按选择跳过 {skipped} 个可选文件")]
    } else {
        Vec::new()
    };
    Ok(StagedPack {
        index: PackIndex {
            format_version: 1,
            game: "minecraft".into(),
            version_id: "curseforge-import".into(),
            name: manifest.name,
            summary: None,
            files: Vec::new(),
            dependencies: deps,
        },
        downloaded,
        skipped,
        warnings,
        files,
        override_paths,
    })
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum PackOrigin {
    Modrinth {
        project_id: String,
        version_id: String,
        version_number: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockedPackFile {
    path: String,
    sha1: String,
    sha512: String,
    size: u64,
    /// Used only to match the staged inventory; not part of the lock format.
    #[serde(skip)]
    sha256: String,
}

struct StagedPack {
    index: PackIndex,
    downloaded: usize,
    skipped: usize,
    warnings: Vec<String>,
    files: Vec<LockedPackFile>,
    override_paths: HashSet<String>,
}

fn write_import_lock(
    stage: &Path,
    staged: &StagedPack,
    origin: Option<&PackOrigin>,
    inventory: &[FileRecord],
    include_optional: bool,
) -> Result<(), String> {
    const LOCK: &str = ".launcher-pack.json";
    let mut paths = HashSet::new();
    for record in inventory {
        let key = record.relative.to_lowercase();
        if key == LOCK || !paths.insert(key) {
            return Err("整合包的文件路径与锁文件冲突或大小写重复".into());
        }
    }
    // Classify by what the stage actually holds. A downloaded file stays managed
    // only if the stage still has exactly its verified bytes at that path; an
    // override layer, an alias spelling or any other change makes it an override.
    let receipts: HashMap<String, &LockedPackFile> = staged
        .files
        .iter()
        .map(|file| (file.path.to_lowercase(), file))
        .collect();
    let mut files = Vec::new();
    let mut overrides = Vec::new();
    for record in inventory {
        let key = record.relative.to_lowercase();
        let managed = receipts.get(&key).filter(|file| {
            !staged.override_paths.contains(&key)
                && !short_name_shaped(&key)
                && file.size == record.size
                && file.sha256.eq_ignore_ascii_case(&record.sha256)
        });
        match managed {
            Some(file) => files.push(*file),
            None => overrides.push(record),
        }
    }
    files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let mut payload = json!({
        "formatVersion": 2,
        "name": staged.index.name,
        "dependencies": staged.index.dependencies,
        "files": files,
        "overrides": overrides,
        "includeOptional": include_optional,
    });
    if let Some(origin) = origin {
        payload["source"] = serde_json::to_value(origin).map_err(|e| e.to_string())?;
    }
    fs::OpenOptions::new().write(true).create_new(true)
        .open(safe_join(stage, LOCK)?).map_err(|e| e.to_string())?
        .write_all(&serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

async fn import_inner(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    archive: &Path,
    name: Option<String>,
    key: Option<String>,
    optional: bool,
    origin: Option<PackOrigin>,
) -> Result<PackImportResult, String> {
    // Every import ends with a version or loader install into the configured
    // root (H06); refuse before staging and downloading instead of at the end.
    crate::minecraft::require_install_root_stopped(state, &state.snapshot()?.config)?;
    let source = archive.to_owned();
    let inspect_state = state.clone();
    let (personal, modrinth, curse) = tokio::task::spawn_blocking(move || {
        instances::sync_checkpoint(&inspect_state)?;
        inspect_zip_limits_controlled(&source, MAX_ZIP_BYTES, MAX_ZIP_BYTES, MAX_ZIP_BYTES, Some(&inspect_state))?;
        let personal = has_entry(&source, "launcher-backup.json")?;
        if !personal {
            inspect_zip_limits_controlled(&source, MAX_ARCHIVE_BYTES, MAX_PACK_BYTES, MAX_ARCHIVE_BYTES, Some(&inspect_state))?;
        }
        instances::sync_checkpoint(&inspect_state)?;
        Ok::<_, String>((
            personal,
            has_entry(&source, "modrinth.index.json")?,
            has_entry(&source, "manifest.json")?,
        ))
    }).await.map_err(|error| error.to_string())??;
    let root = instances::instance_root(state)?;
    let token = uuid::Uuid::new_v4().to_string();
    let stage_name = safe_join(&root, &format!(".pack-staging-{token}"))?;
    let final_dir = safe_join(&root, &token)?;
    if final_dir.exists() {
        return Err("整合包目标已存在".into());
    }
    // An online Modrinth install names its project and version; only a real
    // Modrinth index may carry that baseline, so no other format is tried.
    if origin.is_some() && !modrinth {
        return Err("Modrinth 整合包缺少 modrinth.index.json，已停止导入".into());
    }
    let mut owned_stage = instances::StagingDirectory::create(stage_name)?;
    let stage = owned_stage.path();
    let staged = if modrinth {
        mrpack_into(state, archive, stage, optional).await?
    } else if curse {
        curse_into(state, archive, stage, key, optional).await?
    } else if personal {
        return import_personal_backup(app, state, archive, &mut owned_stage, &final_dir, name).await;
    } else {
        return Err("无法识别整合包。支持 .mrpack、CurseForge manifest.zip 和本启动器带清单的个人备份 ZIP；普通未知 ZIP 不会盲目覆盖游戏目录。".into());
    };
    let inventory_state = state.clone();
    let inventory_stage = stage.to_owned();
    let inventory = tokio::task::spawn_blocking(move || {
        instances::collect_files_controlled(&inventory_stage, Some(&inventory_state))
    }).await.map_err(|error| error.to_string())??;
    let expanded = inventory.iter().map(|f| f.size).sum::<u64>();
    let index = &staged.index;
    if expanded > MAX_PACK_BYTES {
        return Err("整合包下载与覆盖文件合计超过 8 GiB".into());
    }
    let (version_id, loader, loader_version) =
        install_dependencies(state, app, &index.dependencies).await?;
    state.control.checkpoint().await?;
    write_import_lock(stage, &staged, origin.as_ref().filter(|_| modrinth), &inventory, optional)?;
    let instance = instances::build_instance(
        name.as_deref().unwrap_or(&index.name),
        &version_id,
        &final_dir,
        &loader,
        &loader_version,
    )?;
    let StagedPack { downloaded, skipped, warnings, .. } = staged;
    // Cancelling while the lock is written must still leave only the disposable stage.
    state.control.checkpoint().await?;
    if let Err(error) = owned_stage.publish(&final_dir) {
        return Err(format!("{PACK_STAGE_KEPT} {}：{error}", owned_stage.path().display()));
    }
    let instance = instances::register(state, instance)
        .map_err(|e| format!("{PACK_FILES_KEPT} {}，登记失败：{e}", final_dir.display()))?;
    Ok(PackImportResult {
        instance,
        downloaded,
        skipped_optional: skipped,
        warnings,
    })
}
async fn import_personal_backup(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    archive: &Path,
    owned_stage: &mut instances::StagingDirectory,
    final_dir: &Path,
    name: Option<String>,
) -> Result<PackImportResult, String> {
    let stage = owned_stage.path();
    let arc = state.clone();
    let path = archive.to_owned();
    let destination = stage.to_owned();
    let metadata: Value = tokio::task::spawn_blocking(move || {
        let metadata: Value = zip_json(&path, "launcher-backup.json")?;
        if metadata["formatVersion"] != 1 {
            return Err("不支持此个人备份格式".into());
        }
        let files: Vec<FileRecord> = serde_json::from_value(metadata["files"].clone())
            .map_err(|_| "个人备份缺少文件校验清单")?;
        extract_zip_controlled(&path, &destination, "", &["launcher-backup.json"], Some(&arc))?;
        if instances::collect_files_controlled(&destination, Some(&arc))? != files {
            return Err("个人备份内容校验失败，现有实例未改变".into());
        }
        Ok::<_, String>(metadata)
    }).await.map_err(|error| error.to_string())??;
    let old: Instance =
        serde_json::from_value(metadata["instance"].clone()).map_err(|_| "个人备份缺少实例信息")?;
    let old_value = serde_json::to_value(&old).map_err(|e| e.to_string())?;
    let deps=serde_json::from_value::<BTreeMap<String,String>>(metadata["dependencies"].clone()).ok().filter(|v|!v.is_empty())
        .or_else(|| {
            let loader=old_value["loader"].as_str().unwrap_or("vanilla");
            if loader.is_empty()||loader=="vanilla" {Some(BTreeMap::from([("minecraft".into(),old.version_id.clone())]))}else{None}
        }).ok_or("此旧个人备份缺少加载器依赖元数据，无法保证正确安装。请先在原启动器重新导出带依赖的新备份。")?;
    let (version_id, loader, loader_version) = install_dependencies(state, app, &deps).await?;
    let instance = instances::build_instance(
        name.as_deref().unwrap_or(&old.name),
        &version_id,
        final_dir,
        &loader,
        &loader_version,
    )?;
    state.control.checkpoint().await?;
    if let Err(error) = owned_stage.publish(final_dir) {
        return Err(format!(
            "无法提交个人备份，完整暂存目录保留在 {}：{error}",
            owned_stage.path().display()
        ));
    }
    let instance = instances::register(state, instance).map_err(|error| {
        format!("个人备份已完整保留在 {}，登记失败：{error}", final_dir.display())
    })?;
    Ok(PackImportResult {
        instance,
        downloaded: 0,
        skipped_optional: 0,
        warnings: Vec::new(),
    })
}

/// The Modrinth API base; tests point it at a local server.
fn modrinth_api() -> String {
    #[cfg(test)]
    if let Some(endpoints) = crate::resources::test_endpoints() {
        return endpoints.modrinth_api;
    }
    API.to_owned()
}

/// The versions of a Modrinth modpack project (it must be a modpack).
async fn fetch_pack_versions(state: &LauncherState, project_id: &str) -> Result<Vec<ApiVersion>, String> {
    identifier(project_id)?;
    let api = client(state, false)?;
    let base = modrinth_api();
    let project: ApiProject = json_response(api.get(format!("{base}/project/{project_id}"))).await?;
    if project.project_type != "modpack" {
        return Err("所选项目不是整合包".into());
    }
    json_response(
        api.get(format!("{base}/project/{}/version", project.id))
            .query(&[("include_changelog", "false")]),
    )
    .await
}

#[tauri::command]
pub async fn list_modpack_versions(state: State<'_, Arc<LauncherState>>, project_id: String) -> Result<Vec<ModpackVersion>, String> {
    let mut versions = fetch_pack_versions(&state, &project_id).await?;
    versions.sort_by(|a, b| b.date_published.cmp(&a.date_published));
    versions
        .into_iter()
        .map(|v| {
            let size = primary(&v)?.size;
            Ok(ModpackVersion {
                id: v.id,
                name: v.name,
                version_number: v.version_number,
                game_versions: v.game_versions,
                loaders: v.loaders,
                date_published: v.date_published,
                size,
            })
        })
        .collect()
}
#[tauri::command]
pub async fn import_modpack(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    path: String,
    name: Option<String>,
    curseforge_api_key: Option<String>,
    include_optional: Option<bool>,
) -> crate::errors::AppResult<PackImportResult> {
    let path = grants.consume(PathUse::PackRead, &path, &window)?.to_string_lossy().into_owned();
    let archive = checked_absolute(Path::new(&path))?;
    if !archive.is_file()
        || archive
            .extension()
            .and_then(|s| s.to_str())
            .is_none_or(|s| !["zip", "mrpack"].contains(&s.to_ascii_lowercase().as_str()))
    {
        return Err("请选择 .mrpack 或 .zip 文件".into());
    }
    let _operation = state.operation.lock().await;
    let task = state.control.begin("modpack", &path, "导入整合包")?;
    let result = import_inner(
        &app,
        state.inner(),
        &archive,
        name,
        curseforge_api_key,
        include_optional.unwrap_or(false),
        None,
    )
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result.map_err(crate::errors::expected)
}
#[tauri::command]
pub async fn install_modrinth_modpack(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    project_id: String,
    modpack_version_id: String,
    name: Option<String>,
    include_optional: Option<bool>,
) -> crate::errors::AppResult<PackImportResult> {
    identifier(&project_id)?;
    identifier(&modpack_version_id)?;
    let _operation = state.operation.lock().await;
    let display = name.as_deref().map(str::trim).filter(|name| !name.is_empty());
    let retry = crate::downloads::RetryRequest::ModrinthModpack {
        project_id: project_id.clone(),
        modpack_version_id: modpack_version_id.clone(),
        name: name.clone(),
        include_optional: include_optional.unwrap_or(false),
    };
    let task = state.control.begin_recorded("modpack", &project_id, "安装 Modrinth 整合包", display, retry)?;
    let result = install_modrinth_modpack_body(&app, &state, &project_id, &modpack_version_id, name, include_optional.unwrap_or(false)).await;
    forget_retry_when_kept(&state, &task, &result);
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result.map_err(crate::errors::expected)
}

/// A Modrinth modpack install retried from the Downloads page: queued behind
/// the operation lock, then the same install as the interactive one.
pub(crate) async fn run_queued_modpack(
    app: AppHandle,
    state: Arc<LauncherState>,
    task: String,
    project_id: String,
    modpack_version_id: String,
    name: Option<String>,
    include_optional: bool,
) {
    let result = state
        .control
        .run_queued(&state.operation, &task, || async {
            let result = install_modrinth_modpack_body(&app, &state, &project_id, &modpack_version_id, name, include_optional).await;
            forget_retry_when_kept(&state, &task, &result);
            result
        })
        .await;
    if let Some(Err(error)) = result {
        crate::minecraft::log(&app, &state, "error", error);
    }
}

/// A failure after the pack was staged or published keeps those files; a
/// second run would make another copy, so such a task is not offered again.
fn forget_retry_when_kept<T>(state: &LauncherState, task: &str, result: &Result<T, String>) {
    if result.as_ref().err().is_some_and(|error| error.starts_with(PACK_STAGE_KEPT) || error.starts_with(PACK_FILES_KEPT)) {
        state.control.set_retry(task, None);
    }
}

pub(crate) const PACK_STAGE_KEPT: &str = "无法提交整合包，完整暂存目录保留在";
pub(crate) const PACK_FILES_KEPT: &str = "整合包文件已完整保留在";

async fn install_modrinth_modpack_body(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    project_id: &str,
    modpack_version_id: &str,
    name: Option<String>,
    include_optional: bool,
) -> Result<PackImportResult, String> {
    async {
        // A retried install reads these from the journal on disk, so both
        // callers pass this check before any request is built from them.
        identifier(project_id)?;
        identifier(modpack_version_id)?;
        // The operation lock is held from here to the dependency install, so
        // refusing now is final and saves downloading a pack that cannot install.
        crate::minecraft::require_install_root_stopped(&state, &state.snapshot()?.config)?;
        let api = client(&state, false)?;
        let project: ApiProject =
            json_response(api.get(format!("{API}/project/{project_id}"))).await?;
        if project.project_type != "modpack" {
            return Err("所选项目不是整合包".into());
        }
        let version: ApiVersion =
            json_response(api.get(format!("{API}/version/{modpack_version_id}"))).await?;
        if version.project_id != project.id {
            return Err("整合包版本不属于所选项目".into());
        }
        let file = primary(&version)?;
        if !file.filename.to_ascii_lowercase().ends_with(".mrpack") {
            return Err(NOT_MRPACK.into());
        }
        let directory = checked_absolute(&state.data_dir.join("pack-downloads"))?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        sweep_pack_downloads(&directory, std::time::Duration::from_secs(24 * 60 * 60));
        let archive = safe_join(&directory, &format!("{}.mrpack", uuid::Uuid::new_v4()))?;
        // The verified bytes stay in pack-cache; this copy only feeds the import.
        let _downloaded = RemoveOnDrop(archive.clone());
        fetch_verified(
            &state,
            &[file.url.clone()],
            &archive,
            file.size,
            &file.hashes,
        )
        .await?;
        import_inner(
            app,
            state,
            &archive,
            name.or(Some(project.title)),
            None,
            include_optional,
            Some(PackOrigin::Modrinth {
                project_id: project.id,
                version_id: version.id,
                version_number: version.version_number,
            }),
        )
        .await
    }
    .await
}

pub(crate) fn instance_dependencies(
    state: &LauncherState,
    instance: &Instance,
) -> Result<BTreeMap<String, String>, String> {
    let config = state.snapshot()?.config;
    let directory = crate::minecraft::game_directory(&config, &instance.version_id, Some(instance))?;
    let local = directory.join(".launcher-pack.json");
    if local.is_file() {
        checked_absolute(&local)?;
        let value: Value = serde_json::from_slice(&fs::read(local).map_err(|e| e.to_string())?)
            .map_err(|_| "实例整合包元数据无效")?;
        if let Ok(deps) =
            serde_json::from_value::<BTreeMap<String, String>>(value["dependencies"].clone())
        {
            dependencies(&deps)?;
            return Ok(deps);
        }
    }
    let root = crate::processes::configured_game_root(Path::new(&config.game_directory))?;
    let mut current = instance.version_id.clone();
    let mut visited = HashSet::new();
    let mut loader = None;
    for _ in 0..16 {
        if !visited.insert(current.clone()) {
            return Err("版本继承关系循环".into());
        }
        let path = safe_join(&root, &format!("versions/{current}/{current}.json"))?;
        let value: Value = serde_json::from_slice(
            &fs::read(path).map_err(|_| "缺少版本元数据，无法生成准确的整合包依赖")?,
        )
        .map_err(|_| "版本元数据无效")?;
        if loader.is_none() {
            if let Some(libraries) = value["libraries"].as_array() {
                for library in libraries {
                    let Some(name) = library["name"].as_str() else {
                        continue;
                    };
                    for (prefix, key) in [
                        ("net.fabricmc:fabric-loader:", "fabric-loader"),
                        ("org.quiltmc:quilt-loader:", "quilt-loader"),
                        ("net.neoforged:neoforge:", "neoforge"),
                        ("net.minecraftforge:forge:", "forge"),
                    ] {
                        if let Some(version) = name.strip_prefix(prefix) {
                            loader = Some((
                                key.to_owned(),
                                version.split(':').next().unwrap_or(version).to_owned(),
                            ));
                        }
                    }
                }
            }
        }
        match value["inheritsFrom"].as_str() {
            Some(parent) => {
                validate_id(parent)?;
                current = parent.into();
            }
            None => {
                let mut deps = BTreeMap::from([("minecraft".into(), current.clone())]);
                if let Some((key, mut version)) = loader {
                    if key == "forge" {
                        version = version
                            .strip_prefix(&format!("{current}-"))
                            .unwrap_or(&version)
                            .to_owned();
                    }
                    deps.insert(key, version);
                }
                dependencies(&deps)?;
                return Ok(deps);
            }
        }
    }
    Err("版本继承关系过深".into())
}
fn credential_path(relative: &str) -> bool {
    relative.split('/').any(|part| {
        let part = part.to_ascii_lowercase();
        [
            "account",
            "token",
            "secret",
            "password",
            "credential",
            "auth",
            "cookie",
            "session",
        ]
        .iter()
        .any(|word| part.contains(word))
    })
}
fn include_shared_config(record: &FileRecord, include_configs: Option<bool>) -> bool {
    include_configs.unwrap_or(false) && ["config/", "defaultconfigs/", "kubejs/", "scripts/"].iter().any(|prefix| record.relative.starts_with(prefix))
}

fn without_disabled(value: &str) -> &str {
    if value.to_ascii_lowercase().ends_with(".disabled") {
        &value[..value.len() - 9]
    } else {
        value
    }
}
fn is_mod(relative: &str) -> bool {
    relative.starts_with("mods/")
        && without_disabled(relative)
            .to_ascii_lowercase()
            .ends_with(".jar")
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedExportOptions {
    include_configs: bool,
    include_resource_packs: bool,
    include_shader_packs: bool,
    include_saves: bool,
    include_owned_assets: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExcludedExportFile {
    path: String,
    reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedExportPreview {
    download_references: Vec<String>,
    bundled_files: Vec<String>,
    excluded_files: Vec<ExcludedExportFile>,
    fingerprint: String,
}

struct SharedExportPlan {
    preview: SharedExportPreview,
    files: Vec<FileRecord>,
    index_files: Vec<PackFile>,
    raw_files: Vec<FileRecord>,
}

fn shareable_extra(record: &FileRecord, options: SharedExportOptions) -> Result<bool, &'static str> {
    let name = &record.relative;
    if credential_path(name) { return Err("credentialName"); }
    let allow = include_shared_config(record, Some(options.include_configs))
        || options.include_saves && name.starts_with("saves/");
    if allow && without_disabled(name).to_ascii_lowercase().ends_with(".jar") {
        return Err("unmappedJar");
    }
    Ok(allow)
}

async fn build_shared_export_plan(
    state: &LauncherState,
    instance: &Instance,
    root: &Path,
    options: SharedExportOptions,
) -> Result<SharedExportPlan, String> {
    let root_for_scan = root.to_path_buf();
    let files = tokio::task::spawn_blocking(move || {
        instances::collect_instance_files_controlled(&root_for_scan, None)
    })
        .await.map_err(|error| error.to_string())??;
    let mut hash_matches = HashMap::<String, Vec<(FileRecord, String)>>::new();
    let mut excluded_files = Vec::new();
    let mut raw_files = Vec::new();
    for record in &files {
        let path = &record.relative;
        if credential_path(path) {
            excluded_files.push(ExcludedExportFile { path: path.clone(), reason: "credentialName" });
        } else if is_mod(path)
            || options.include_resource_packs && path.starts_with("resourcepacks/")
            || options.include_shader_packs && path.starts_with("shaderpacks/") {
            state.control.checkpoint().await?;
            let file = safe_join(root, path)?;
            let (sha1, sha512, size) = tokio::task::spawn_blocking(move || hashes(&file))
                .await.map_err(|error| error.to_string())??;
            if size != record.size { return Err("导出期间资源文件发生变化".into()); }
            hash_matches.entry(sha512).or_default().push((record.clone(), sha1));
        } else {
            match shareable_extra(record, options) {
                Ok(true) => raw_files.push(record.clone()),
                Ok(false) => excluded_files.push(ExcludedExportFile { path: path.clone(), reason: "notSelected" }),
                Err(reason) => excluded_files.push(ExcludedExportFile { path: path.clone(), reason }),
            }
        }
    }
    let api = client(&state, false)?;
    let hashes: Vec<_> = hash_matches.keys().cloned().collect();
    let mut mappings = HashMap::<String, ApiVersion>::new();
    for chunk in hashes.chunks(100) {
        state.control.checkpoint().await?;
        let result: HashMap<String, ApiVersion> = json_response(api.post(format!("{API}/version_files"))
            .json(&json!({"algorithm":"sha512","hashes":chunk}))).await?;
        mappings.extend(result);
    }
    let mut index_files = Vec::new();
    for (hash, records) in hash_matches {
        let mapped = mappings.get(&hash).and_then(|version| version.files.iter()
            .find(|file| file.hashes.get("sha512").is_some_and(|value| value.eq_ignore_ascii_case(&hash))));
        for (record, sha1) in records {
            if let Some(file) = mapped {
                allowed_download(&file.url)?;
                index_files.push(PackFile { path: record.relative, hashes: BTreeMap::from([("sha1".into(), sha1), ("sha512".into(), hash.clone())]),
                    downloads: vec![file.url.clone()], file_size: record.size, env: None });
            } else if !is_mod(&record.relative) && options.include_owned_assets {
                raw_files.push(record);
            } else {
                excluded_files.push(ExcludedExportFile { path: record.relative, reason: "unmapped" });
            }
        }
    }
    index_files.sort_by(|a, b| a.path.cmp(&b.path));
    raw_files.sort_by(|a, b| a.relative.cmp(&b.relative));
    excluded_files.sort_by(|a, b| a.path.cmp(&b.path));
    // The confirmation covers export inventory hashes, actual reference URLs
    // and content choices; a change between approval and export must be shown again.
    let fingerprint = format!("{:x}", sha2::Sha256::digest(serde_json::to_vec(&(
        &instance.id, &instance.version_id, options, &files, &index_files, &raw_files, &excluded_files,
    )).map_err(|error| error.to_string())?));
    let preview = SharedExportPreview {
        download_references: index_files.iter().map(|file| file.path.clone()).collect(),
        bundled_files: std::iter::once("modrinth.index.json".to_owned()).chain(raw_files.iter()
            .map(|file| format!("overrides/{}", file.relative))).collect(),
        excluded_files, fingerprint,
    };
    Ok(SharedExportPlan { preview, files, index_files, raw_files })
}

#[tauri::command]
pub async fn plan_modrinth_export(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    options: SharedExportOptions,
) -> Result<SharedExportPreview, String> {
    let _operation = state.operation.lock().await;
    let data = state.snapshot()?;
    let instance = instances::instance(&data, &instance_id)?;
    let directory = crate::minecraft::game_directory(&data.config, &instance.version_id, Some(&instance))?;
    let root = state.games.require_directory_stopped(&directory, Some(&instance_id), false)?;
    let task = state.control.begin_with_display("export", &instance_id, "检查共享整合包清单", &instance.name)?;
    let result = build_shared_export_plan(&state, &instance, &root, options).await;
    state.control.finish(&task, result.as_ref().err().map(String::as_str));
    Ok(result?.preview)
}

#[tauri::command]
pub async fn export_modrinth_modpack(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    output_path: String,
    name: Option<String>,
    options: SharedExportOptions,
    confirmed_fingerprint: String,
) -> crate::errors::AppResult<PackExportResult> {
    let output = grants.consume(PathUse::PackWrite, &output_path, &window)?;
    let _operation = state.operation.lock().await;
    let instance = instances::instance(&state.snapshot()?, &instance_id)?;
    let task = state.control.begin_with_display(
        "export",
        &instance_id,
        "导出 Modrinth 整合包",
        &instance.name,
    )?;
    let result = export_confirmed_shared_pack(
        &state,
        &instance,
        &output,
        name,
        options,
        &confirmed_fingerprint,
    )
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result.map_err(crate::errors::expected)
}

async fn export_confirmed_shared_pack(
    state: &LauncherState,
    instance: &Instance,
    output: &Path,
    name: Option<String>,
    options: SharedExportOptions,
    confirmed_fingerprint: &str,
) -> Result<PackExportResult, String> {
    let config = state.snapshot()?.config;
    let directory = crate::minecraft::game_directory(&config, &instance.version_id, Some(instance))?;
    let root = state.games.require_directory_stopped(&directory, Some(&instance.id), false)?;
    let output = checked_absolute(output)?;
    if output
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| !s.eq_ignore_ascii_case("mrpack"))
    {
        return Err("整合包导出路径须以 .mrpack 结尾".into());
    }
    if output.exists() || output.starts_with(&root) {
        return Err("导出目标已存在或位于实例内部，请另选文件名和目录".into());
    }
    let plan = build_shared_export_plan(state, instance, &root, options).await?;
    if plan.preview.fingerprint != confirmed_fingerprint {
        return Err("instance.exportPreviewChanged".into());
    }
    let SharedExportPlan {
        preview,
        files,
        index_files,
        raw_files,
    } = plan;
    let warnings = preview
        .excluded_files
        .iter()
        .filter(|file| file.reason != "notSelected")
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();
    let index=PackIndex{format_version:1,game:"minecraft".into(),version_id:uuid::Uuid::new_v4().to_string(),name:name.unwrap_or_else(||instance.name.clone()),
            summary:Some("Exported by VoxelightLauncher; mods are download references, never bundled without permission.".into()),files:index_files,dependencies:instance_dependencies(state,instance)?};
    let parent = output.parent().ok_or("导出目录无效")?;
    checked_absolute(parent)?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = safe_join(
        parent,
        &format!(".mrpack-export-{}.part", uuid::Uuid::new_v4()),
    )?;
    let write_result: Result<(), String> = async {
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        zip.start_file("modrinth.index.json", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&serde_json::to_vec_pretty(&index).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        for record in &raw_files {
            state.control.checkpoint().await?;
            zip.start_file(
                format!("overrides/{}", record.relative),
                options.large_file(record.size >= u32::MAX as u64),
            )
            .map_err(|e| e.to_string())?;
            std::io::copy(
                &mut fs::File::open(safe_join(&root, &record.relative)?)
                    .map_err(|e| e.to_string())?,
                &mut zip,
            )
            .map_err(|e| e.to_string())?;
        }
        zip.finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        let verify_root = root.clone();
        let latest = tokio::task::spawn_blocking(move || {
            instances::collect_instance_files_controlled(&verify_root, None)
        })
            .await
            .map_err(|error| error.to_string())??;
        if latest != files {
            return Err("导出期间实例发生变化，请关闭游戏后重试".into());
        }
        if output.exists() {
            return Err("导出期间出现同名文件，现有文件未覆盖".into());
        }
        instances::publish_archive_file(&temporary, &output).map_err(|e| e.to_string())
    }
    .await;
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result?;
    Ok(PackExportResult {
        path: output.to_string_lossy().into_owned(),
        download_files: index.files.len(),
        override_files: raw_files.len(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_in_memory(build: impl FnOnce(&mut ZipWriter<std::io::Cursor<Vec<u8>>>)) -> ZipArchive<std::io::Cursor<Vec<u8>>> {
        let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        build(&mut zip);
        let bytes = zip.finish().unwrap().into_inner();
        ZipArchive::new(std::io::Cursor::new(bytes)).unwrap()
    }

    #[test]
    fn c6_zip_entry_cap_is_inclusive_at_the_limit() {
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let archive = |count: usize| {
            zip_in_memory(|zip| {
                for n in 0..count {
                    zip.start_file(format!("f{n}"), stored).unwrap();
                }
            })
        };
        let mut at_limit = archive(MAX_ZIP_ENTRIES);
        assert_eq!(inspect_zip_reader(&mut at_limit, u64::MAX, u64::MAX, None), Ok(()));
        let mut over = archive(MAX_ZIP_ENTRIES + 1);
        assert_eq!(
            inspect_zip_reader(&mut over, u64::MAX, u64::MAX, None),
            Err("ZIP 文件数量超过限制".into())
        );
    }

    #[test]
    fn c6_compression_ratio_boundaries() {
        const MIB: u64 = 1024 * 1024;
        assert!(!suspicious_ratio(MIB, 1), "1 MiB itself is never checked");
        assert!(!suspicious_ratio(MIB + 1000, (MIB + 1000) / 1000), "exactly 1000:1 is allowed");
        assert!(suspicious_ratio(1001 * 2 * MIB, 2 * MIB), "1001:1 is refused");
        assert!(!suspicious_ratio(16 * MIB, 0), "a zero compressed size is not a ratio");

        let zeros = vec![0u8; 16 * MIB as usize];
        let entry = |method| {
            zip_in_memory(|zip| {
                zip.start_file("zeros.bin", SimpleFileOptions::default().compression_method(method))
                    .unwrap();
                std::io::Write::write_all(zip, &zeros).unwrap();
            })
        };
        let mut deflated = entry(CompressionMethod::Deflated);
        {
            let file = deflated.by_index(0).unwrap();
            assert!(
                file.size() / file.compressed_size() > 1000,
                "fixture precondition: deflated zeros exceed 1000:1"
            );
        }
        assert_eq!(
            inspect_zip_reader(&mut deflated, u64::MAX, u64::MAX, None),
            Err("ZIP 压缩比例异常，拒绝解压".into())
        );
        let mut stored = entry(CompressionMethod::Stored);
        assert_eq!(inspect_zip_reader(&mut stored, u64::MAX, u64::MAX, None), Ok(()));
    }

    #[test]
    fn c6_import_requires_a_modrinth_index_for_online_installs_and_checks_cancel_before_publish() {
        let source = crate::storage::executable_source(include_str!("modpacks.rs"));
        let (_, body) = source.split_once("async fn import_inner(").unwrap();
        let (body, _) = body.split_once("\n}").unwrap();
        let origin = body.find("if origin.is_some() && !modrinth {").unwrap();
        let stage = body.find("instances::StagingDirectory::create(stage_name)?").unwrap();
        assert!(origin < stage, "a non-Modrinth archive with a Modrinth origin stops before staging");
        let lock = body.find("write_import_lock(").unwrap();
        let publish = body.find("owned_stage.publish(&final_dir)").unwrap();
        let checkpoint = body[lock..publish].rfind("state.control.checkpoint().await?;").map(|at| lock + at);
        assert!(checkpoint.is_some_and(|at| at > lock), "cancellation is checked after the lock and before publishing");
    }

    fn shared_export_fixture(root: &Path) -> (LauncherState, Instance) {
        let profile = root.join("profile");
        let game = root.join("game");
        fs::create_dir(&profile).unwrap();
        fs::create_dir(&game).unwrap();
        for (name, content) in [
            (
                ".launcher-pack.json",
                r#"{"dependencies":{"minecraft":"1.21.1"}}"#,
            ),
            ("config/ordinary.toml", "volume=20"),
            ("config/account-token.json", "inert test fixture"),
            ("saves/Example/level.dat", "test save"),
        ] {
            let path = game.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        let instance = Instance {
            id: "shared-test".into(),
            name: "Shared test".into(),
            version_id: "1.21.1".into(),
            game_directory: game.to_string_lossy().into_owned(),
            ..Instance::default()
        };
        let state = LauncherState::test_fixture(
            profile,
            crate::models::Persisted {
                config: crate::models::Config {
                    game_directory: root.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                instances: vec![instance.clone()],
                ..Default::default()
            },
            crate::storage::test_client(),
        );
        (state, instance)
    }

    #[test]
    fn a3_shared_pack_omits_scratch_from_preview_fingerprint_and_archive() {
        let fixture = instances::StagingDirectory::create(test_root()).unwrap();
        let (state, instance) = shared_export_fixture(fixture.path());
        let root = Path::new(&instance.game_directory);
        let scratch = root.join(".launcher-temp/run-c6792868-d4ed-42d8-a6fc-4251c8726903");
        fs::create_dir_all(&scratch).unwrap();
        fs::write(scratch.join("launcher.args"), b"runtime before approval").unwrap();
        fs::create_dir_all(root.join("config/.launcher-temp")).unwrap();
        fs::write(root.join("config/.launcher-temp/preserved.toml"), b"volume=10").unwrap();
        let output = fixture.path().join("scoped.mrpack");
        let options = SharedExportOptions {
            include_configs: true,
            ..Default::default()
        };

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let approved = build_shared_export_plan(&state, &instance, root, options)
                    .await
                    .unwrap()
                    .preview;
                assert!(approved
                    .excluded_files
                    .iter()
                    .all(|file| !file.path.starts_with(".launcher-temp/")));
                assert_eq!(
                    approved.bundled_files,
                    [
                        "modrinth.index.json",
                        "overrides/config/.launcher-temp/preserved.toml",
                        "overrides/config/ordinary.toml",
                    ]
                );
                fs::write(scratch.join("launcher.args"), b"runtime after approval").unwrap();
                let result = export_confirmed_shared_pack(
                    &state,
                    &instance,
                    &output,
                    None,
                    options,
                    &approved.fingerprint,
                )
                .await
                .unwrap();
                assert_eq!(result.override_files, 2);
                let mut zip = ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
                let mut entries = (0..zip.len())
                    .map(|i| zip.by_index(i).unwrap().name().unwrap().to_string())
                    .collect::<Vec<_>>();
                entries.sort_unstable();
                assert_eq!(entries, approved.bundled_files);
            });
    }

    #[test]
    fn a4_same_root_blocks_shared_export_before_any_archive_is_created() {
        let fixture = crate::storage::SameRootFixture::new();
        fs::write(
            fixture.game.join(".launcher-pack.json"),
            r#"{"dependencies":{"minecraft":"1.21.1"}}"#,
        )
        .unwrap();
        let output_parent = fixture.root().join("export");
        let output = output_parent.join("shared.mrpack");
        let options = SharedExportOptions::default();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let approved = build_shared_export_plan(
                    &fixture.state,
                    &fixture.instance,
                    &fixture.game,
                    options,
                )
                .await
                .unwrap();
                fixture.mark_running();
                let error = export_confirmed_shared_pack(
                    &fixture.state,
                    &fixture.instance,
                    &output,
                    None,
                    options,
                    &approved.preview.fingerprint,
                )
                .await
                .err()
                .expect("the same game directory must block export");
                assert_eq!(crate::errors::expected(error).code, "instance.running");
                assert!(!output_parent.exists(), "no final or temporary archive");
            });
    }

    #[test]
    fn h11_shared_export_plan_lists_actual_default_and_opt_in_files() {
        let fixture = instances::StagingDirectory::create(test_root()).unwrap();
        let (state, instance) = shared_export_fixture(fixture.path());
        let root = Path::new(&instance.game_directory);
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let plan =
                build_shared_export_plan(&state, &instance, root, SharedExportOptions::default())
                    .await
                    .unwrap();
            assert_eq!(plan.preview.bundled_files, ["modrinth.index.json"]);
            assert!(plan.preview.download_references.is_empty());
            assert_eq!(
                plan.preview
                    .excluded_files
                    .iter()
                    .map(|file| (file.path.as_str(), file.reason))
                    .collect::<Vec<_>>(),
                [
                    (".launcher-pack.json", "notSelected"),
                    ("config/account-token.json", "credentialName"),
                    ("config/ordinary.toml", "notSelected"),
                    ("saves/Example/level.dat", "notSelected"),
                ]
            );

            let with_configs = build_shared_export_plan(
                &state,
                &instance,
                root,
                SharedExportOptions {
                    include_configs: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(
                with_configs.preview.bundled_files,
                ["modrinth.index.json", "overrides/config/ordinary.toml"]
            );
            assert!(with_configs
                .preview
                .excluded_files
                .iter()
                .any(|file| file.path == "config/account-token.json"
                    && file.reason == "credentialName"));
            assert_ne!(with_configs.preview.fingerprint, plan.preview.fingerprint);
        });
    }

    #[test]
    fn h11_shared_export_rejects_stale_fingerprint_then_writes_reconfirmed_content() {
        let fixture = instances::StagingDirectory::create(test_root()).unwrap();
        let (state, instance) = shared_export_fixture(fixture.path());
        let root = Path::new(&instance.game_directory);
        let output = fixture.path().canonicalize().unwrap().join("shared.mrpack");
        let options = SharedExportOptions {
            include_configs: true,
            ..Default::default()
        };
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let approved = build_shared_export_plan(&state, &instance, root, options)
                .await
                .unwrap()
                .preview;
            // The file contents change without any change in path or length.
            fs::write(root.join("config/ordinary.toml"), "volume=21").unwrap();
            let failure = export_confirmed_shared_pack(
                &state,
                &instance,
                &output,
                None,
                options,
                &approved.fingerprint,
            )
            .await
            .err()
            .expect("a stale confirmation must reject the export");
            assert_eq!(failure, "instance.exportPreviewChanged");
            assert!(!output.exists());
            assert!(fs::read_dir(fixture.path()).unwrap().all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".mrpack-export-")
            }));

            let refreshed = build_shared_export_plan(&state, &instance, root, options)
                .await
                .unwrap()
                .preview;
            assert_ne!(refreshed.fingerprint, approved.fingerprint);
            let result = export_confirmed_shared_pack(
                &state,
                &instance,
                &output,
                None,
                options,
                &refreshed.fingerprint,
            )
            .await
            .unwrap();
            assert_eq!(result.download_files, 0);
            assert_eq!(result.override_files, 1);
            let mut zip = ZipArchive::new(fs::File::open(output).unwrap()).unwrap();
            assert_eq!(zip.len(), 2);
            let mut index = String::new();
            zip.by_name("modrinth.index.json")
                .unwrap()
                .read_to_string(&mut index)
                .unwrap();
            let index: Value = serde_json::from_str(&index).unwrap();
            assert_eq!(index["dependencies"]["minecraft"], "1.21.1");
            let mut contents = String::new();
            zip.by_name("overrides/config/ordinary.toml")
                .unwrap()
                .read_to_string(&mut contents)
                .unwrap();
            assert_eq!(contents, "volume=21");
        });
    }

    #[test]
    fn local_v1_pack_lock_remains_readable() {
        let root = test_root();
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        let owned = instances::StagingDirectory::create(root).unwrap();
        let (state, instance) = shared_export_fixture(owned.path());
        fs::write(
            Path::new(&instance.game_directory).join(".launcher-pack.json"),
            r#"{"formatVersion":1,"name":"Legacy pack","dependencies":{"minecraft":"1.21.1","fabric-loader":"0.16.10"}}"#,
        )
        .unwrap();
        assert_eq!(
            instance_dependencies(&state, &instance).unwrap(),
            BTreeMap::from([
                ("minecraft".into(), "1.21.1".into()),
                ("fabric-loader".into(), "0.16.10".into()),
            ]),
        );
    }

    #[test]
    fn import_lock_v2_records_verified_files_final_overrides_and_online_provenance() {
        tauri::async_runtime::block_on(async {
            let root = test_root();
            fs::create_dir_all(root.parent().unwrap()).unwrap();
            let owned = instances::StagingDirectory::create(root).unwrap();
            let root = owned.path();
            let (state, _) = shared_export_fixture(root);
            let state = Arc::new(state);
            let cache = state.data_dir.join("pack-cache");
            fs::create_dir(&cache).unwrap();
            let mut entries = Vec::new();
            for (path, client, contents) in [
                ("mods/required.jar", "required", &b"required bytes"[..]),
                ("mods/optional.jar", "optional", &b"optional bytes"[..]),
                ("mods/unsupported.jar", "unsupported", &b"server-only bytes"[..]),
                ("config/replaced.toml", "required", &b"remote config"[..]),
            ] {
                let sha1 = format!("{:x}", Sha1::digest(contents));
                let sha512 = format!("{:x}", Sha512::digest(contents));
                if client != "unsupported" {
                    fs::write(cache.join(format!("{sha512}.bin")), contents).unwrap();
                }
                entries.push(json!({"path": path, "hashes": {"sha1": sha1, "sha512": sha512},
                    "downloads": [], "fileSize": contents.len(), "env": {"client": client}}));
            }
            let archive = root.join("test.mrpack");
            let mut zip = ZipWriter::new(fs::File::create(&archive).unwrap());
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
            zip.start_file("modrinth.index.json", options).unwrap();
            zip.write_all(&serde_json::to_vec(&json!({"formatVersion": 1, "game": "minecraft",
                "versionId": "local-index-version", "name": "Fixture pack", "files": entries,
                "dependencies": {"minecraft": "1.21.1"}})).unwrap()).unwrap();
            for (path, bytes) in [
                ("overrides/config/replaced.toml", &b"shared config"[..]),
                ("client-overrides/config/replaced.toml", &b"client config"[..]),
                ("overrides/config/shared.toml", &b"shared only"[..]),
            ] {
                zip.start_file(path, options).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
            let origin = PackOrigin::Modrinth {
                project_id: "test-project".into(),
                version_id: "test-version".into(),
                version_number: "2.0.0".into(),
            };
            for (include_optional, origin) in [(false, Some(&origin)), (true, None)] {
                let stage = root.join(if include_optional { "local" } else { "online" });
                fs::create_dir(&stage).unwrap();
                let staged = mrpack_into(&state, &archive, &stage, include_optional).await.unwrap();
                let inventory = instances::collect_files_controlled(&stage, None).unwrap();
                write_import_lock(&stage, &staged, origin, &inventory, include_optional).unwrap();
                let lock: Value = serde_json::from_slice(&fs::read(stage.join(".launcher-pack.json")).unwrap()).unwrap();
                assert_eq!(lock["formatVersion"], 2);
                assert_eq!(lock["name"], "Fixture pack");
                assert_eq!(lock["dependencies"], json!({"minecraft": "1.21.1"}));
                if origin.is_some() {
                    assert_eq!(lock["source"], json!({"kind": "modrinth", "projectId": "test-project",
                        "versionId": "test-version", "versionNumber": "2.0.0"}));
                } else {
                    assert!(lock.get("source").is_none());
                }
                let mut expected = Vec::new();
                for &i in if include_optional { &[1usize, 0][..] } else { &[0usize][..] } {
                    let entry = &entries[i];
                    expected.push(json!({"path": entry["path"], "sha1": entry["hashes"]["sha1"],
                        "sha512": entry["hashes"]["sha512"], "size": entry["fileSize"]}));
                }
                assert_eq!(lock["files"], json!(expected));
                let mut overrides = lock["overrides"].as_array().unwrap().clone();
                overrides.sort_by(|a,b| a["relative"].as_str().cmp(&b["relative"].as_str()));
                assert_eq!(overrides, vec![
                    json!({"relative": "config/replaced.toml", "sha256": format!("{:x}", sha2::Sha256::digest(b"client config")), "size": 13}),
                    json!({"relative": "config/shared.toml", "sha256": format!("{:x}", sha2::Sha256::digest(b"shared only")), "size": 11}),
                ]);
            }
        });
    }

    #[test]
    fn c1_lock_keeps_only_downloads_whose_staged_bytes_still_match() {
        let root = test_root();
        fs::create_dir_all(root.join("mods")).unwrap();
        fs::create_dir_all(root.join("config")).unwrap();
        let write = |relative: &str, bytes: &[u8]| fs::write(root.join(relative), bytes).unwrap();
        write("mods/kept.jar", b"kept bytes");
        // Same name and size as a receipt, different bytes: for example an override
        // written through another spelling of the path, or a later change in the stage.
        write("mods/changed.jar", b"changed bytes");
        // Same name, different size.
        write("mods/resized.jar", b"resized");
        // Matching bytes, but an override layer wrote this path.
        write("config/same.toml", b"same bytes");
        // Matching bytes under a name shaped like an 8.3 alias.
        write("mods/ABCDEF~1.JAR", b"short name");
        let receipt = |path: &str, bytes: &[u8]| LockedPackFile {
            path: path.into(),
            sha1: format!("{:x}", Sha1::digest(bytes)),
            sha512: format!("{:x}", Sha512::digest(bytes)),
            size: bytes.len() as u64,
            sha256: format!("{:x}", sha2::Sha256::digest(bytes)),
        };
        let staged = StagedPack {
            index: PackIndex {
                format_version: 1,
                game: "minecraft".into(),
                version_id: "fixture".into(),
                name: "Fixture".into(),
                summary: None,
                files: Vec::new(),
                dependencies: BTreeMap::from([("minecraft".into(), "1.21.1".into())]),
            },
            downloaded: 2,
            skipped: 0,
            warnings: Vec::new(),
            files: vec![
                receipt("mods/kept.jar", b"kept bytes"),
                receipt("mods/changed.jar", b"CHANGED BYTES"),
                receipt("mods/resized.jar", b"resized and longer"),
                receipt("config/same.toml", b"same bytes"),
                receipt("mods/ABCDEF~1.JAR", b"short name"),
            ],
            override_paths: HashSet::from(["config/same.toml".to_string()]),
        };
        let inventory = instances::collect_files_controlled(&root, None).unwrap();
        write_import_lock(&root, &staged, None, &inventory, false).unwrap();
        let lock: Value =
            serde_json::from_slice(&fs::read(root.join(".launcher-pack.json")).unwrap()).unwrap();
        cleanup(&root);
        let files: Vec<_> = lock["files"].as_array().unwrap().iter().map(|f| f["path"].clone()).collect();
        assert_eq!(files, vec![json!("mods/kept.jar")]);
        assert!(lock["files"][0].get("sha256").is_none(), "the lock format is unchanged");
        let mut overrides = lock["overrides"].as_array().unwrap().clone();
        overrides.sort_by(|a, b| a["relative"].as_str().cmp(&b["relative"].as_str()));
        let entry = |relative: &str, bytes: &[u8]| {
            json!({"relative": relative, "size": bytes.len(),
                "sha256": format!("{:x}", sha2::Sha256::digest(bytes))})
        };
        assert_eq!(
            overrides,
            vec![
                entry("config/same.toml", b"same bytes"),
                entry("mods/ABCDEF~1.JAR", b"short name"),
                entry("mods/changed.jar", b"changed bytes"),
                entry("mods/resized.jar", b"resized"),
            ]
        );
    }

    #[test]
    fn c1_short_name_shapes() {
        for path in ["mods/ABCDEF~1.JAR", "PROGRA~2/x.jar", "a~10", "mods/x~1y.jar"] {
            assert!(short_name_shaped(path), "{path}");
        }
        for path in ["mods/a~b.jar", "mods/name~.jar", "mods/plain-1.jar", "~"] {
            assert!(!short_name_shaped(path), "{path}");
        }
    }

    #[test]
    fn c2_imports_refuse_before_staging_while_a_game_from_the_root_runs() {
        let source = crate::storage::executable_source(include_str!("modpacks.rs"));
        let body = |name: &str| {
            let (_, rest) = source.split_once(name).unwrap();
            rest.split_once("\n}").unwrap().0.to_owned()
        };
        let import = body("async fn import_inner(");
        let guard = import.find("crate::minecraft::require_install_root_stopped(state, &state.snapshot()?.config)?;").unwrap();
        assert!(guard < import.find("inspect_zip_limits_controlled(").unwrap());
        assert!(guard < import.find("instances::StagingDirectory::create(stage_name)?").unwrap());
        // The command takes the operation lock, then runs the shared body; a
        // retried install reaches the same body behind the lock (run_queued).
        let online = body("pub async fn install_modrinth_modpack(");
        assert!(online.find("state.operation.lock().await").unwrap() < online.find("install_modrinth_modpack_body(").unwrap());
        assert!(online.trim_end().ends_with("result.map_err(crate::errors::expected)"), "the code reaches the UI");
        let queued = body("pub(crate) async fn run_queued_modpack(");
        assert!(queued.find(".run_queued(&state.operation, &task,").unwrap() < queued.find("install_modrinth_modpack_body(").unwrap());
        // Both paths clear the retry of a failure that kept files, and a failed
        // retry reaches the log as a failed loader retry does.
        let forget = "forget_retry_when_kept(&state, &task, &result);";
        assert!(online.find("install_modrinth_modpack_body(").unwrap() < online.find(forget).unwrap());
        assert!(online.find(forget).unwrap() < online.find(".finish(&task,").unwrap());
        assert!(queued.find("install_modrinth_modpack_body(").unwrap() < queued.find(forget).unwrap());
        let logged = queued.find("if let Some(Err(error)) = result {").unwrap();
        assert!(queued[logged..].contains("crate::minecraft::log(&app, &state, \"error\", error);"));
        let shared = body("async fn install_modrinth_modpack_body(");
        let guard = shared.find("crate::minecraft::require_install_root_stopped(&state, &state.snapshot()?.config)?;").unwrap();
        // The journal's ids are checked before the guard and before any URL uses them.
        let ids = [shared.find("identifier(project_id)?;").unwrap(), shared.find("identifier(modpack_version_id)?;").unwrap()];
        assert!(ids.iter().all(|&index| index < guard && index < shared.find("format!(\"{API}/").unwrap()));
        assert!(guard < shared.find("fetch_verified(").unwrap());
        let loaders = crate::storage::executable_source(include_str!("loaders.rs"));
        let (_, loader) = loaders.split_once("pub async fn install_loader(").unwrap();
        let (loader, _) = loader.split_once("\n}").unwrap();
        assert!(loader.trim_end().ends_with("result.map_err(crate::errors::expected)"), "the code reaches the UI");
    }

    #[test]
    fn c1_online_install_sweeps_guards_and_verifies_the_staged_copy() {
        let source = crate::storage::executable_source(include_str!("modpacks.rs"));
        let (_, body) = source.split_once("async fn install_modrinth_modpack_body(").unwrap();
        let (body, _) = body.split_once("\n}").unwrap();
        let sweep = body.find("sweep_pack_downloads(&directory,").unwrap();
        let guard = body.find("let _downloaded = RemoveOnDrop(archive.clone());").unwrap();
        let fetch = body.find("fetch_verified(").unwrap();
        let import = body.find("import_inner(").unwrap();
        assert!(sweep < guard && guard < fetch && fetch < import);
        let (_, fetch) = source.split_once("async fn fetch_verified(").unwrap();
        let (fetch, _) = fetch.split_once("\n}").unwrap();
        // Both the cache hit and the download stage through stage_copy, which
        // ends by verifying the staged copy.
        assert_eq!(fetch.matches("stage_copy(&cache, target, ").count(), 2);
        assert!(fetch.contains("stage_copy(&cache, target, false, &matches)") && fetch.contains("stage_copy(&cache, target, true, &matches)"));
        assert!(!fetch.contains("staged_receipt("), "the receipt comes from stage_copy");
        let (_, stage) = source.split_once("async fn stage_copy(").unwrap();
        let (stage, _) = stage.split_once("\n}").unwrap();
        assert!(stage.trim_end().ends_with("staged_receipt(target, downloaded, matches)"));
        assert_eq!(stage.matches("staged_receipt(").count(), 1);
        assert!(!stage.contains("VerifiedPackFile::receipt("), "stage_copy takes its receipt only from the staged copy");
        assert!(stage.contains("part.publish_new(target)"), "the stage never replaces a file");
        assert!(!fetch.contains("VerifiedPackFile::receipt("));
    }

    #[test]
    fn c1_pack_download_sweep_and_guard_remove_only_launcher_archives() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let ours = root.join(format!("{}.mrpack", uuid::Uuid::new_v4()));
        let user = root.join("my-pack.mrpack");
        let other = root.join(format!("{}.zip", uuid::Uuid::new_v4()));
        // The copy stage_copy was making when the launcher stopped, and a look-alike.
        let stage = root.join(format!(".pack-stage-{}.part", uuid::Uuid::new_v4()));
        let foreign = root.join(".pack-stage-notauuid.part");
        for path in [&ours, &user, &other, &stage, &foreign] {
            fs::write(path, b"archive").unwrap();
        }
        sweep_pack_downloads(&root, std::time::Duration::from_secs(24 * 60 * 60));
        let young_kept = ours.is_file() && stage.is_file();
        sweep_pack_downloads(&root, std::time::Duration::ZERO);
        let guarded = root.join("guarded.mrpack");
        fs::write(&guarded, b"archive").unwrap();
        drop(RemoveOnDrop(guarded.clone()));
        let kept = [young_kept, ours.exists(), stage.exists(), user.is_file(), other.is_file(), foreign.is_file(), guarded.exists()];
        cleanup(&root);
        assert_eq!(kept, [true, false, false, true, true, true, false]);
    }

    #[test]
    fn c1_staged_receipt_rejects_and_removes_a_copy_that_does_not_match() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let target = root.join("file.jar");
        fs::write(&target, b"tampered").unwrap();
        let error = staged_receipt(&target, false, |values| values.2 == 8 && values.0 == "0".repeat(40));
        let removed = !target.exists();
        fs::write(&target, b"expected").unwrap();
        let sha1 = format!("{:x}", Sha1::digest(b"expected"));
        let receipt = staged_receipt(&target, true, |values| values.0 == sha1).unwrap();
        cleanup(&root);
        assert!(error.is_err() && removed);
        assert!(receipt.downloaded);
        assert_eq!(receipt.sha256, format!("{:x}", sha2::Sha256::digest(b"expected")));
    }

    fn test_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/modpack-tests")
            .join(uuid::Uuid::new_v4().to_string())
    }
    fn cleanup(path: &Path) {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/modpack-tests");
        assert!(
            path.is_absolute()
                && path.starts_with(parent)
                && path.file_name().unwrap().to_string_lossy().len() == 36
        );
        fs::remove_dir_all(path).unwrap();
    }
    fn archive(path: &Path, name: &str, mode: Option<u32>) {
        let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
        let mut options =
            SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        if let Some(mode) = mode {
            options = options.unix_permissions(mode);
        }
        zip.start_file(name, options).unwrap();
        zip.write_all(b"file").unwrap();
        zip.finish().unwrap();
    }
    #[test]
    fn zip_traversal_and_windows_device_names_are_rejected_before_writes() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        for name in [
            "../escape.txt",
            "overrides/../../escape.txt",
            "C:/escape.txt",
            "overrides/CON.txt",
            "overrides/dir\\escape.txt",
        ] {
            let zip = root.join("bad.zip");
            archive(&zip, name, None);
            assert!(inspect_zip(&zip).is_err(), "{name}");
        }
        assert!(!root.parent().unwrap().join("escape.txt").exists());
        cleanup(&root);
    }
    #[test]
    fn reserved_windows_destination_declines_entire_pack_before_touching_staging() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let pack = root.join("pack.zip");
        let stage = root.join("stage");
        fs::create_dir(&stage).unwrap();
        fs::write(stage.join("existing.txt"), b"preserved").unwrap();
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let mut zip = ZipWriter::new(fs::File::create(&pack).unwrap());
        for member in ["overrides/ordinary.txt", "overrides/AUX.txt"] {
            zip.start_file(member, options).unwrap();
            zip.write_all(b"inert fixture").unwrap();
        }
        zip.finish().unwrap();
        assert!(extract_zip_layer(&pack, &stage, "overrides/", &[]).is_err());
        let files = fs::read_dir(&stage).unwrap().map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(files, [std::ffi::OsString::from("existing.txt")]);
        assert_eq!(fs::read(stage.join("existing.txt")).unwrap(), b"preserved");
        cleanup(&root);
    }
    #[test]
    fn client_overrides_take_precedence_in_a_new_staging_directory() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("pack.zip");
        let mut zip = ZipWriter::new(fs::File::create(&path).unwrap());
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in [
            ("overrides/config/settings.txt", "common"),
            ("client-overrides/config/settings.txt", "client"),
            ("server-overrides/config/settings.txt", "server"),
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(bytes.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
        let stage = root.join("new");
        fs::create_dir_all(&stage).unwrap();
        extract_zip_layer(&path, &stage, "overrides/", &[]).unwrap();
        extract_zip_layer(&path, &stage, "client-overrides/", &[]).unwrap();
        assert_eq!(
            fs::read_to_string(stage.join("config/settings.txt")).unwrap(),
            "client"
        );
        cleanup(&root);
    }
    #[test]
    fn unsupported_and_multiple_loaders_never_silently_fall_back_to_vanilla() {
        assert!(dependencies(&BTreeMap::from([
            ("minecraft".into(), "1.21.1".into()),
            ("unknown-loader".into(), "1".into())
        ]))
        .is_err());
        assert!(dependencies(&BTreeMap::from([
            ("minecraft".into(), "1.21.1".into()),
            ("fabric-loader".into(), "0.16".into()),
            ("forge".into(), "52".into())
        ]))
        .is_err());
        assert!(allowed_download("https://cdn.modrinth.com.evil.example/file.jar").is_err());
    }
    #[test]
    fn official_index_uses_version_id_and_rejects_alias_only_metadata() {
        let index = PackIndex {
            format_version: 1,
            game: "minecraft".into(),
            version_id: "release-1".into(),
            name: "Pack".into(),
            summary: None,
            files: Vec::new(),
            dependencies: BTreeMap::from([("minecraft".into(), "1.21.1".into())]),
        };
        let mut value = serde_json::to_value(index).unwrap();
        assert_eq!(value["versionId"], "release-1");
        assert!(value.get("versionNumber").is_none());
        value.as_object_mut().unwrap().remove("versionId");
        value["versionNumber"] = json!("release-1");
        assert!(serde_json::from_value::<PackIndex>(value).is_err());
    }
    #[test]
    fn symbolic_links_and_case_collisions_are_rejected() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let path = root.join("links.zip");
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let mut zip = ZipWriter::new(fs::File::create(&path).unwrap());
        zip.add_symlink("overrides/link", "../../external", options)
            .unwrap();
        zip.finish().unwrap();
        assert!(inspect_zip(&path).unwrap_err().contains("符号链接"));
        let mut zip = ZipWriter::new(fs::File::create(&path).unwrap());
        for name in ["overrides/Config/a.txt", "overrides/config/a.txt"] {
            zip.start_file(name, options).unwrap();
            zip.write_all(b"data").unwrap();
        }
        zip.finish().unwrap();
        assert!(inspect_zip(&path).is_err());
        cleanup(&root);
    }

    use crate::parts::range_server::{RangeServer, Scripted};

    const MIB: usize = 1024 * 1024;

    fn u0266_bytes(size: usize) -> Vec<u8> {
        (0..size).map(|index| (index * 17 % 253) as u8).collect()
    }

    fn local(server: &RangeServer) -> reqwest::Url {
        reqwest::Url::parse(&format!("http://{}/pack/file.jar", server.address)).unwrap()
    }

    fn any_response(_: &reqwest::Response) -> Result<(), String> {
        Ok(())
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Runtime::new().unwrap().block_on(future)
    }

    #[test]
    fn u0266_a_modpack_file_resumes_its_part_and_hashes_every_byte() {
        let root = test_root();
        let bytes = u0266_bytes(2 * MIB + 7);
        let size = bytes.len() as u64;
        let sha512 = format!("{:x}", Sha512::digest(&bytes));
        let store = crate::parts::PartStore::new(root.join("pack-cache").join(".parts"));
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &sha512, size).unwrap();
        let network = crate::storage::test_client();
        let control = crate::downloads::DownloadControl::default();
        let _task = control.begin("install", "fixture", "Fixture").unwrap();
        // The first attempt is cut after 1 MiB; the second asks for the rest from the same origin.
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"p2\"").cut(MIB), Scripted::partial(&bytes, MIB, "\"p2\"")]);
        let url = local(&server);
        let mut slot = store.open(&key, size).unwrap();
        assert!(block_on(fetch_part(&network, &url, &mut slot, size, &control, &any_response)).is_err());
        let values = block_on(fetch_part(&network, &url, &mut slot, size, &control, &any_response)).unwrap();
        assert_eq!(server.header(1, "range").as_deref(), Some(format!("bytes={MIB}-").as_str()));
        assert_eq!(values, (format!("{:x}", Sha1::digest(&bytes)), sha512, size));
        assert_eq!(server.sent.load(std::sync::atomic::Ordering::SeqCst), bytes.len(), "every byte sent once");
        let cache = root.join("pack-cache").join("file.bin");
        slot.take().unwrap().publish_replace(&cache).unwrap();
        assert_eq!(fs::read(&cache).unwrap(), bytes);
        drop(control);
        cleanup(&root);
    }

    #[test]
    fn u0266_cancelling_a_modpack_download_that_waits_for_headers_is_prompt() {
        let root = test_root();
        let cache_root = root.join("pack-cache");
        fs::create_dir_all(&cache_root).unwrap();
        let network = crate::storage::test_client();
        let observations = block_on(async {
            let mut observations = Vec::new();
            for resumable in [false, true] {
                let control = crate::downloads::DownloadControl::default();
                let task = control.begin("install", "fixture", "Fixture").unwrap();
                let server = RangeServer::new(vec![Scripted::silent()]);
                let url = local(&server);
                let size = 3 * MIB as u64;
                let store = crate::parts::PartStore::new(cache_root.join(".parts"));
                let key = crate::parts::PartKey::new(crate::parts::Algo::Sha1, &"a".repeat(40), size).unwrap();
                let mut slot = if resumable { store.open(&key, size).unwrap() } else { None };
                let cache = cache_root.join("file.bin");
                let fetch = async {
                    if resumable {
                        fetch_part(&network, &url, &mut slot, size, &control, &any_response).await.map(|_| ())
                    } else {
                        fetch_whole(&network, &url, &cache_root, &cache, size, &control, &any_response, &|_| true).await.map(|_| ())
                    }
                };
                tokio::pin!(fetch);
                let cancel = async {
                    tokio::time::timeout(Duration::from_secs(5), async {
                        while server.count() == 0 {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                    })
                    .await
                    .unwrap();
                    control.cancel(&task);
                };
                use futures_util::future::{select, Either};
                if let Either::Left((result, _)) = select(fetch.as_mut(), Box::pin(cancel)).await {
                    panic!("the stalled request finished: {result:?}");
                }
                let result = tokio::time::timeout(Duration::from_millis(500), &mut fetch).await;
                let prompt = result.is_ok_and(|result| result.is_err_and(|error| error.contains("任务已取消")));
                observations.push((resumable, prompt));
            }
            observations
        });
        // No part can exist yet while headers are awaited; the mid-body test checks leaks.
        assert_eq!(observations, [(false, true), (true, true)]);
        cleanup(&root);
    }

    #[test]
    fn u0266_staging_a_cached_file_never_replaces_one_that_appeared() {
        let root = test_root();
        fs::create_dir_all(root.join("stage")).unwrap();
        let cache = root.join("cache.bin");
        let bytes = b"cached modpack file";
        fs::write(&cache, bytes).unwrap();
        let sizes = (format!("{:x}", Sha1::digest(bytes)), format!("{:x}", Sha512::digest(bytes)), bytes.len() as u64);
        let matches = |values: &(String, String, u64)| *values == sizes;
        let target = root.join("stage").join("mods").join("a.jar");
        let receipt = block_on(stage_copy(&cache, &target, true, &matches)).unwrap();
        assert_eq!((receipt.size, receipt.downloaded), (bytes.len() as u64, true));
        assert_eq!(fs::read(&target).unwrap(), bytes);
        fs::write(&target, b"user file").unwrap();
        let error = block_on(stage_copy(&cache, &target, false, &matches)).err().unwrap();
        assert!(error.contains("已存在"), "{error}");
        assert_eq!(fs::read(&target).unwrap(), b"user file");
        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap()).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(leftovers.len(), 1, "no stage part is left beside the target: {leftovers:?}");
        cleanup(&root);
    }
    #[test]
    fn u0266_cancelling_a_modpack_download_mid_body_leaves_no_part_in_the_cache_and_keeps_the_resumable_one() {
        let root = test_root();
        let cache_root = root.join("pack-cache");
        fs::create_dir_all(&cache_root).unwrap();
        let bytes = u0266_bytes(3 * MIB);
        let size = bytes.len() as u64;
        let sha1 = format!("{:x}", Sha1::digest(&bytes));
        let network = crate::storage::test_client();
        let store = crate::parts::PartStore::new(cache_root.join(".parts"));
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha1, &sha1, size).unwrap();
        let observations = block_on(async {
            let mut observations = Vec::new();
            // (resumable, cancelled: else the future is dropped, as a failing sibling does)
            for (resumable, cancels) in [(false, true), (true, true), (false, false)] {
                let control = crate::downloads::DownloadControl::default();
                let task = control.begin("install", "fixture", "Fixture").unwrap();
                let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"p\"").stall(MIB)]);
                let url = local(&server);
                let mut slot = if resumable { store.open(&key, size).unwrap() } else { None };
                let cache = cache_root.join("file.bin");
                // Read the size from the file: a directory listing on Windows reports
                // a stale size for a file that is still open for writing.
                let written = |dir: &Path, suffix: &str| {
                    fs::read_dir(dir).map(|entries| entries.flatten().filter(|entry| entry.file_name().to_string_lossy().ends_with(suffix)).map(|entry| fs::metadata(entry.path()).map_or(0, |meta| meta.len())).max().unwrap_or(0)).unwrap_or(0)
                };
                let prompt = {
                let fetch = async {
                    if resumable {
                        fetch_part(&network, &url, &mut slot, size, &control, &any_response).await.map(|_| ())
                    } else {
                        fetch_whole(&network, &url, &cache_root, &cache, size, &control, &any_response, &|_| true).await.map(|_| ())
                    }
                };
                tokio::pin!(fetch);
                let cancel = async {
                    let (dir, suffix) = if resumable { (cache_root.join(".parts"), ".part") } else { (cache_root.clone(), ".part") };
                    tokio::time::timeout(Duration::from_secs(5), async {
                        while written(&dir, suffix) < MIB as u64 {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                    })
                    .await
                    .unwrap();
                    if cancels {
                        control.cancel(&task);
                    }
                };
                use futures_util::future::{select, Either};
                if let Either::Left((result, _)) = select(fetch.as_mut(), Box::pin(cancel)).await {
                    panic!("the stalled body finished: {result:?}");
                }
                if !cancels {
                    // Dropped here, mid-body, without a cancel.
                    true
                } else {
                    let result = tokio::time::timeout(Duration::from_millis(500), &mut fetch).await;
                    result.is_ok_and(|result| result.is_err_and(|error| error.contains("任务已取消")))
                }
                };
                drop(slot);
                let leaked = fs::read_dir(&cache_root).unwrap().flatten().any(|entry| entry.file_name().to_string_lossy().starts_with(".pack-download-"));
                observations.push((resumable, prompt, leaked));
            }
            observations
        });
        assert_eq!(observations, [(false, true, false), (true, true, false), (false, true, false)]);
        // The resumable attempt kept its bytes and their record for next time.
        let mut slot = store.open(&key, size).unwrap();
        assert_eq!(slot.as_ref().unwrap().done(), MIB as u64);
        slot.take().unwrap().discard();
        cleanup(&root);
    }

    fn pack_download<'a>(network: &'a reqwest::Client, store: &'a crate::parts::PartStore, key: &'a crate::parts::PartKey, root: &'a Path, cache: &'a Path, size: u64) -> PackFileDownload<'a> {
        PackFileDownload { network, parts: store, key: Some(key), cache_root: root, cache, size }
    }

    #[test]
    fn u0266_a_modpack_file_continues_at_the_same_url_after_an_interruption_or_a_bad_part() {
        let root = test_root();
        let cache_root = root.join("pack-cache");
        fs::create_dir_all(&cache_root).unwrap();
        let bytes = u0266_bytes(3 * MIB);
        let size = bytes.len() as u64;
        let sha1 = format!("{:x}", Sha1::digest(&bytes));
        let sha512 = format!("{:x}", Sha512::digest(&bytes));
        let matches = |values: &(String, String, u64)| values.0 == sha1 && values.1 == sha512 && values.2 == size;
        let network = crate::storage::test_client();
        let store = crate::parts::PartStore::new(cache_root.join(".parts"));
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &sha512, size).unwrap();
        let cache = cache_root.join("file.bin");
        let control = crate::downloads::DownloadControl::default();
        let _task = control.begin("install", "fixture", "Fixture").unwrap();

        // (a) Cut after 1 MiB: the same URL continues with a Range request.
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"").cut(MIB), Scripted::partial(&bytes, MIB, "\"v1\"")]);
        let download = pack_download(&network, &store, &key, &cache_root, &cache, size);
        block_on(download.into_cache(&[local(&server)], &control, &any_response, &matches, None)).unwrap();
        assert_eq!(server.count(), 2);
        assert_eq!(server.header(1, "range").as_deref(), Some(format!("bytes={MIB}-").as_str()));
        assert_eq!(fs::read(&cache).unwrap(), bytes);
        fs::remove_file(&cache).unwrap();

        // (b) A complete part with one wrong byte: discarded, then one fetch from zero.
        let mut part = store.open(&key, size).unwrap().unwrap();
        part.restart(crate::parts::Validator::default()).unwrap();
        let mut damaged = bytes.clone();
        damaged[7] ^= 1;
        part.append(&damaged).unwrap();
        drop(part);
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"")]);
        block_on(download.into_cache(&[local(&server)], &control, &any_response, &matches, None)).unwrap();
        assert_eq!(server.count(), 1);
        assert_eq!(server.header(0, "range"), None);
        assert_eq!(fs::read(&cache).unwrap(), bytes);
        fs::remove_file(&cache).unwrap();

        // (c) A stall: one more try at the same URL continues the part.
        control.set_stall_limit(Duration::from_secs(2));
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"").stall(MIB), Scripted::partial(&bytes, MIB, "\"v1\"")]);
        block_on(download.into_cache(&[local(&server)], &control, &any_response, &matches, None)).unwrap();
        assert_eq!(server.header(1, "range").as_deref(), Some(format!("bytes={MIB}-").as_str()));
        assert_eq!(fs::read(&cache).unwrap(), bytes);
        drop(control);
        cleanup(&root);
    }

    struct PackFixture {
        root: PathBuf,
        cache_root: PathBuf,
        cache: PathBuf,
        bytes: Vec<u8>,
        sha512: String,
        network: reqwest::Client,
        store: crate::parts::PartStore,
        key: crate::parts::PartKey,
        control: crate::downloads::DownloadControl,
    }

    impl PackFixture {
        fn new(size: usize) -> Self {
            let root = test_root();
            let cache_root = root.join("pack-cache");
            fs::create_dir_all(&cache_root).unwrap();
            let bytes = u0266_bytes(size);
            let sha512 = format!("{:x}", Sha512::digest(&bytes));
            let store = crate::parts::PartStore::new(cache_root.join(".parts"));
            let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &sha512, size as u64).unwrap();
            let control = crate::downloads::DownloadControl::default();
            control.begin("install", "fixture", "Fixture").unwrap();
            let cache = cache_root.join("file.bin");
            Self { root, cache_root, cache, bytes, sha512, network: crate::storage::test_client(), store, key, control }
        }

        fn run(&self, urls: &[reqwest::Url]) -> Result<(), String> {
            let download = pack_download(&self.network, &self.store, &self.key, &self.cache_root, &self.cache, self.bytes.len() as u64);
            let matches = |values: &(String, String, u64)| values.1 == self.sha512;
            block_on(download.into_cache(urls, &self.control, &any_response, &matches, None))
        }

        fn record(&self) -> Value {
            let name = format!("sha512-{}-{}.json", self.sha512, self.bytes.len());
            serde_json::from_slice(&fs::read(self.cache_root.join(".parts").join(name)).unwrap()).unwrap()
        }
    }

    impl Drop for PackFixture {
        fn drop(&mut self) {
            cleanup(&self.root);
        }
    }

    #[test]
    fn u0266_a_modpack_file_gets_one_more_try_after_a_stall_without_bytes() {
        let fixture = PackFixture::new(2 * MIB);
        fixture.control.set_stall_limit(Duration::from_millis(700));
        // Headers that never come, twice in a row: one more try, not two.
        let server = RangeServer::new(vec![Scripted::silent(), Scripted::silent(), Scripted::ok(&fixture.bytes, "\"v1\"")]);
        assert_eq!(fixture.run(&[local(&server)]).unwrap_err(), crate::parts::STALLED);
        assert_eq!(server.count(), 2);
        drop(server);
        // One stall, then an answer: the second try brings the file.
        let server = RangeServer::new(vec![Scripted::silent(), Scripted::ok(&fixture.bytes, "\"v1\"")]);
        fixture.run(&[local(&server)]).unwrap();
        assert_eq!(server.count(), 2);
        assert_eq!(fs::read(&fixture.cache).unwrap(), fixture.bytes);
    }

    #[test]
    fn u0266_a_second_modpack_url_never_throws_away_bytes_the_first_one_added() {
        let fixture = PackFixture::new(2 * MIB);
        let bytes = &fixture.bytes;
        let first = RangeServer::new(vec![Scripted::ok(bytes, "\"a\"").cut(MIB), Scripted::status(503)]);
        let second = RangeServer::new(vec![Scripted::ok(bytes, "\"b\"").cut(MIB / 2)]);
        assert!(fixture.run(&[local(&first), local(&second)]).is_err());
        assert_eq!(first.count(), 2);
        assert_eq!(first.header(1, "range").as_deref(), Some(format!("bytes={MIB}-").as_str()));
        assert_eq!(second.header(0, "range"), None);
        let record = fixture.record();
        assert_eq!(record["done"], MIB as u64, "the second origin fetched in one go and left the part alone");
        assert_eq!(record["validator"]["origin"], format!("http://{}", first.address));
    }

    #[test]
    fn u0266_a_modpack_file_stops_at_the_try_cap_even_while_each_try_adds_bytes() {
        let fixture = PackFixture::new(64);
        // Every try adds one byte, then the body breaks off: only the cap ends this.
        let mut script = vec![Scripted::ok(&fixture.bytes, "\"v1\"").cut(1)];
        script.extend((1..20).map(|from| Scripted::partial(&fixture.bytes, from, "\"v1\"").cut(1)));
        let server = RangeServer::new(script);
        assert!(fixture.run(&[local(&server)]).is_err());
        assert_eq!(server.count(), MAX_PACK_FILE_TRIES);
        assert_eq!(fixture.record()["done"], MAX_PACK_FILE_TRIES as u64);
    }

    #[test]
    fn u0266_a_modpack_file_gives_up_on_a_url_after_its_tries() {
        let root = test_root();
        let cache_root = root.join("pack-cache");
        fs::create_dir_all(&cache_root).unwrap();
        let bytes = u0266_bytes(2 * MIB);
        let size = bytes.len() as u64;
        let sha512 = format!("{:x}", Sha512::digest(&bytes));
        let matches = |values: &(String, String, u64)| values.1 == sha512;
        let network = crate::storage::test_client();
        let store = crate::parts::PartStore::new(cache_root.join(".parts"));
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha512, &sha512, size).unwrap();
        let cache = cache_root.join("file.bin");
        let control = crate::downloads::DownloadControl::default();
        let _task = control.begin("install", "fixture", "Fixture").unwrap();
        // Every answer is a whole-file 200 cut early: no try continues the part.
        let server = RangeServer::new((0..6).map(|_| Scripted::ok(&bytes, "\"v1\"").cut(MIB)).collect());
        let download = pack_download(&network, &store, &key, &cache_root, &cache, size);
        let result = block_on(download.into_cache(&[local(&server)], &control, &any_response, &matches, None));
        assert!(result.is_err());
        // The first try started an empty part (free); the second restarted it: not progress.
        assert_eq!(server.count(), 2);
        assert!(!cache.exists());
        drop(control);
        cleanup(&root);
    }

    #[test]
    fn u0256_a_modpack_failure_that_kept_files_is_not_offered_again() {
        let root = test_root();
        let state = LauncherState::test_fixture(root.join("profile"), Default::default(), crate::storage::test_client());
        let request = crate::downloads::RetryRequest::ModrinthModpack {
            project_id: "pack".into(),
            modpack_version_id: "v1".into(),
            name: None,
            include_optional: false,
        };
        let cases = [
            (format!("{PACK_STAGE_KEPT} C:\\stage：denied"), false),
            (format!("{PACK_FILES_KEPT} C:\\pack，登记失败：busy"), false),
            ("整合包文件下载失败（HTTP 503）".to_owned(), true),
        ];
        for (error, retryable) in cases {
            let task = state.control.begin_recorded("modpack", "pack", "安装 Modrinth 整合包", None, request.clone()).unwrap();
            let result: Result<(), String> = Err(error.clone());
            forget_retry_when_kept(&state, &task, &result);
            state.control.finish(&task, Some(&error));
            let row = state.control.list().into_iter().find(|job| job.id == task).unwrap();
            assert_eq!(row.retryable, retryable, "{error}");
        }
        // The real messages start with these constants.
        let source = crate::storage::executable_source(include_str!("modpacks.rs"));
        assert!(source.contains("format!(\"{PACK_STAGE_KEPT} {}：{error}\", owned_stage.path().display())"));
        assert!(source.contains("format!(\"{PACK_FILES_KEPT} {}，登记失败：{e}\", final_dir.display())"));
        drop(state);
        cleanup(&root);
    }
}
