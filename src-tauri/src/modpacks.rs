//! Standards-based Modrinth and CurseForge pack import/export into new instances.
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
#[cfg(test)]
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
fn client(download: bool) -> Result<reqwest::Client, String> {
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
    reqwest::Client::builder()
        .user_agent(concat!(
            "VoxelightLauncher/",
            env!("CARGO_PKG_VERSION"),
            " (Tauri desktop)"
        ))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(if download { 900 } else { 60 }))
        .redirect(policy)
        .build()
        .map_err(|_| "无法创建整合包网络客户端".into())
}
async fn json_response<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T, String> {
    let response = request
        .send()
        .await
        .map_err(|_| "整合包平台连接失败，请检查网络")?;
    if !response.status().is_success() {
        return Err(format!(
            "整合包平台请求失败（HTTP {}）；CurseForge 请求请检查自己的 API Key 和分发权限",
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
        let chunk = chunk.map_err(|_| "整合包元数据传输失败")?;
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

async fn fetch_verified(
    state: &LauncherState,
    urls: &[String],
    target: &Path,
    size: u64,
    expected: &BTreeMap<String, String>,
) -> Result<bool, String> {
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
    if cache.is_file() && matches(&hashes(&cache)?) {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if target.exists() {
            return Err("整合包文件目标已存在".into());
        }
        fs::copy(&cache, target).map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let network = client(true)?;
    let mut last_error = "整合包没有受支持的下载地址".to_owned();
    for url in urls.iter().take(8) {
        state.control.checkpoint().await?;
        let parsed = match allowed_download(url) {
            Ok(value) => value,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        let temporary = safe_join(
            &cache_root,
            &format!(".pack-download-{}.part", uuid::Uuid::new_v4()),
        )?;
        let result: Result<(), String> = async {
            let response = network
                .get(parsed)
                .send()
                .await
                .map_err(|_| "整合包文件下载失败")?;
            if !response.status().is_success() {
                return Err(format!(
                    "整合包文件下载失败（HTTP {}）",
                    response.status().as_u16()
                ));
            }
            allowed_download(response.url().as_str())?;
            if response.content_length().is_some_and(|n| n != size) {
                return Err("整合包文件声明大小不一致".into());
            }
            let mut output = tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .await
                .map_err(|e| e.to_string())?;
            let mut stream = response.bytes_stream();
            let mut a = Sha1::new();
            let mut b = Sha512::new();
            let mut count = 0u64;
            while let Some(chunk) = stream.next().await {
                state.control.checkpoint().await?;
                let chunk = chunk.map_err(|_| "整合包文件传输中断")?;
                state.control.throttle(chunk.len()).await?;
                count = count.saturating_add(chunk.len() as u64);
                if count > size {
                    return Err("整合包文件超过声明大小".into());
                }
                a.update(&chunk);
                b.update(&chunk);
                output.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
            output.sync_all().await.map_err(|e| e.to_string())?;
            drop(output);
            if !matches(&(
                format!("{:x}", a.finalize()),
                format!("{:x}", b.finalize()),
                count,
            )) {
                return Err("整合包文件哈希或大小校验失败".into());
            }
            checked_absolute(&cache)?;
            fs::rename(&temporary, &cache).map_err(|e| e.to_string())?;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                if target.exists() {
                    return Err("整合包目标文件已存在，拒绝覆盖".into());
                }
                fs::copy(&cache, target).map_err(|e| e.to_string())?;
                return Ok(true);
            }
            Err(error) => {
                last_error = error;
                let _ = fs::remove_file(&temporary);
                state.control.checkpoint().await?;
            }
        }
    }
    Err(last_error)
}

/// Validate all ZIP member paths, case collisions, symlinks and total expanded size before extraction.
fn inspect_zip(archive: &Path) -> Result<(), String> {
    inspect_zip_limits(archive, MAX_ZIP_BYTES, MAX_ZIP_BYTES, MAX_ZIP_BYTES)
}
fn inspect_zip_limits(
    archive: &Path,
    archive_limit: u64,
    total_limit: u64,
    file_limit: u64,
) -> Result<(), String> {
    checked_absolute(archive)?;
    if fs::metadata(archive).map_err(|e| e.to_string())?.len() > archive_limit {
        return Err("压缩包大小超过此导入类型的限制".into());
    }
    let mut zip = ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|_| "文件不是有效 ZIP 压缩包")?;
    if zip.len() > 100_000 {
        return Err("ZIP 文件数量超过限制".into());
    }
    let mut total = 0u64;
    let mut seen = HashSet::new();
    for n in 0..zip.len() {
        let file = zip.by_index(n).map_err(|e| e.to_string())?;
        let name = file.name().trim_end_matches('/');
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
        if file.size() > 1024 * 1024
            && file.compressed_size() > 0
            && file.size() / file.compressed_size() > 1000
        {
            return Err("ZIP 压缩比例异常，拒绝解压".into());
        }
    }
    Ok(())
}
fn archive_relative(value: &str) -> Result<(), String> {
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

pub(crate) fn extract_zip_layer(
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
    inspect_zip(archive)?;
    checked_absolute(destination)?;
    let mut zip = ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for n in 0..zip.len() {
        if let Some(state) = state {
            tokio::runtime::Handle::current().block_on(state.control.checkpoint())?;
        }
        let mut entry = zip.by_index(n).map_err(|e| e.to_string())?;
        let name = entry.name().to_owned();
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

async fn mrpack_into(
    state: &Arc<LauncherState>,
    archive: &Path,
    stage: &Path,
    optional: bool,
) -> Result<(PackIndex, usize, usize, Vec<String>), String> {
    let index: PackIndex = zip_json(archive, "modrinth.index.json")?;
    if index.format_version != 1 || index.game != "minecraft" {
        return Err("不支持此 Modrinth 整合包格式或游戏".into());
    }
    dependencies(&index.dependencies)?;
    if index.files.len() > 20_000 {
        return Err("整合包文件数量超过限制".into());
    }
    let mut total = 0u64;
    let mut paths = HashSet::new();
    let mut downloaded = 0;
    let mut skipped = 0;
    for file in &index.files {
        state.control.checkpoint().await?;
        archive_relative(&file.path)?;
        let target = safe_join(stage, &file.path)?;
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
        total = total.checked_add(file.file_size).ok_or("整合包大小溢出")?;
        if total > MAX_PACK_BYTES {
            return Err("整合包下载总大小超过 8 GiB".into());
        }
        if fetch_verified(
            state,
            &file.downloads,
            &target,
            file.file_size,
            &file.hashes,
        )
        .await?
        {
            downloaded += 1;
        }
    }
    for prefix in ["overrides/", "client-overrides/"] {
        let arc = state.clone();
        let archive = archive.to_owned();
        let stage = stage.to_owned();
        let prefix = prefix.to_owned();
        tokio::task::spawn_blocking(move || {
            extract_zip_controlled(&archive, &stage, &prefix, &[], Some(&arc))
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    let mut warnings = Vec::new();
    if skipped > 0 {
        warnings.push(format!("按选择跳过 {skipped} 个可选客户端文件"));
    }
    Ok((index, downloaded, skipped, warnings))
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
) -> Result<(PackIndex, usize, usize, Vec<String>), String> {
    let manifest: CurseManifest = zip_json(archive, "manifest.json")?;
    if manifest.manifest_type != "minecraftModpack" || manifest.manifest_version != 1 {
        return Err("不支持此 CurseForge 清单格式".into());
    }
    let key = match key.filter(|k| !k.is_empty()) {
        Some(value) => Some(value),
        None => crate::secrets::load_service_secret(&state.data_dir, "curseforge-api-key")?,
    }
    .ok_or(
        "CurseForge 导入需要你自己申请的 API Key，请先在设置中保存。不会使用其它启动器的 Key。",
    )?;
    if key.len() > 2048 || key.chars().any(char::is_control) {
        return Err("CurseForge API Key 格式无效".into());
    }
    if manifest.files.len() > 20_000 {
        return Err("CurseForge 整合包文件数量超过限制".into());
    }
    let api = client(false)?;
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
            .header("x-api-key", &key),
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
            .header("x-api-key", &key),
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
        if fetch_verified(
            state,
            &[url],
            &safe_join(stage, &relative)?,
            file.data.file_length,
            &expected,
        )
        .await?
        {
            downloaded += 1;
        }
    }
    let prefix = manifest.overrides.trim_end_matches('/');
    safe_join(stage, prefix)?;
    let arc = state.clone();
    let archive = archive.to_owned();
    let stage = stage.to_owned();
    let prefix = format!("{prefix}/");
    tokio::task::spawn_blocking(move || {
        extract_zip_controlled(&archive, &stage, &prefix, &[], Some(&arc))
    })
    .await
    .map_err(|e| e.to_string())??;
    let warnings = if skipped > 0 {
        vec![format!("按选择跳过 {skipped} 个可选文件")]
    } else {
        Vec::new()
    };
    Ok((
        PackIndex {
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
    ))
}

async fn import_inner(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    archive: &Path,
    name: Option<String>,
    key: Option<String>,
    optional: bool,
) -> Result<PackImportResult, String> {
    inspect_zip(archive)?;
    if !has_entry(archive, "launcher-backup.json")? {
        inspect_zip_limits(
            archive,
            MAX_ARCHIVE_BYTES,
            MAX_PACK_BYTES,
            MAX_ARCHIVE_BYTES,
        )?;
    }
    let root = instances::instance_root(state)?;
    let token = uuid::Uuid::new_v4().to_string();
    let stage = safe_join(&root, &format!(".pack-staging-{token}"))?;
    let final_dir = safe_join(&root, &token)?;
    if stage.exists() || final_dir.exists() {
        return Err("整合包暂存目标已存在".into());
    }
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let (index, downloaded, skipped, warnings) = if has_entry(archive, "modrinth.index.json")? {
        mrpack_into(state, archive, &stage, optional).await?
    } else if has_entry(archive, "manifest.json")? {
        curse_into(state, archive, &stage, key, optional).await?
    } else if has_entry(archive, "launcher-backup.json")? {
        return import_personal_backup(app, state, archive, &stage, &final_dir, name).await;
    } else {
        return Err("无法识别整合包。支持 .mrpack、CurseForge manifest.zip 和本启动器带清单的个人备份 ZIP；普通未知 ZIP 不会盲目覆盖游戏目录。".into());
    };
    if instances::collect_files(&stage)?
        .iter()
        .map(|f| f.size)
        .sum::<u64>()
        > MAX_PACK_BYTES
    {
        return Err("整合包下载与覆盖文件合计超过 8 GiB".into());
    }
    let (version_id, loader, loader_version) =
        install_dependencies(state, app, &index.dependencies).await?;
    state.control.checkpoint().await?;
    fs::write(
        safe_join(&stage, ".launcher-pack.json")?,
        serde_json::to_vec_pretty(
            &json!({"formatVersion":1,"name":index.name,"dependencies":index.dependencies}),
        )
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let instance = instances::build_instance(
        name.as_deref().unwrap_or(&index.name),
        &version_id,
        &final_dir,
        &loader,
        &loader_version,
    )?;
    if final_dir.exists() {
        return Err("新实例目录已存在，导入数据仍保留在暂存目录".into());
    }
    fs::rename(&stage, &final_dir).map_err(|e| format!("无法提交整合包，暂存目录保留：{e}"))?;
    let instance = instances::register(state, instance).map_err(|e| {
        format!(
            "整合包文件已完整保留在 {}，登记失败：{e}",
            final_dir.display()
        )
    })?;
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
    stage: &Path,
    final_dir: &Path,
    name: Option<String>,
) -> Result<PackImportResult, String> {
    let metadata: Value = zip_json(archive, "launcher-backup.json")?;
    if metadata["formatVersion"] != 1 {
        return Err("不支持此个人备份格式".into());
    }
    let old: Instance =
        serde_json::from_value(metadata["instance"].clone()).map_err(|_| "个人备份缺少实例信息")?;
    let files: Vec<FileRecord> = serde_json::from_value(metadata["files"].clone())
        .map_err(|_| "个人备份缺少文件校验清单")?;
    let arc = state.clone();
    let path = archive.to_owned();
    let destination = stage.to_owned();
    tokio::task::spawn_blocking(move || {
        extract_zip_controlled(
            &path,
            &destination,
            "",
            &["launcher-backup.json"],
            Some(&arc),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    if instances::collect_files(stage)? != files {
        return Err("个人备份内容校验失败，现有实例未改变".into());
    }
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
    fs::rename(stage, final_dir).map_err(|e| e.to_string())?;
    let instance = instances::register(state, instance)?;
    Ok(PackImportResult {
        instance,
        downloaded: 0,
        skipped_optional: 0,
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub async fn list_modpack_versions(project_id: String) -> Result<Vec<ModpackVersion>, String> {
    identifier(&project_id)?;
    let api = client(false)?;
    let project: ApiProject = json_response(api.get(format!("{API}/project/{project_id}"))).await?;
    if project.project_type != "modpack" {
        return Err("所选项目不是整合包".into());
    }
    let mut versions: Vec<ApiVersion> = json_response(
        api.get(format!("{API}/project/{}/version", project.id))
            .query(&[("include_changelog", "false")]),
    )
    .await?;
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
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    path: String,
    name: Option<String>,
    curseforge_api_key: Option<String>,
    include_optional: Option<bool>,
) -> Result<PackImportResult, String> {
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
    let task = state.control.begin("modpack", &path, "导入整合包");
    let result = import_inner(
        &app,
        state.inner(),
        &archive,
        name,
        curseforge_api_key,
        include_optional.unwrap_or(false),
    )
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}
#[tauri::command]
pub async fn install_modrinth_modpack(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    project_id: String,
    modpack_version_id: String,
    name: Option<String>,
    include_optional: Option<bool>,
) -> Result<PackImportResult, String> {
    identifier(&project_id)?;
    identifier(&modpack_version_id)?;
    let _operation = state.operation.lock().await;
    let task = state
        .control
        .begin("modpack", &project_id, "安装 Modrinth 整合包");
    let result = async {
        let api = client(false)?;
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
            return Err("所选版本不是标准 .mrpack 文件".into());
        }
        let directory = checked_absolute(&state.data_dir.join("pack-downloads"))?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let archive = safe_join(&directory, &format!("{}.mrpack", uuid::Uuid::new_v4()))?;
        fetch_verified(
            &state,
            &[file.url.clone()],
            &archive,
            file.size,
            &file.hashes,
        )
        .await?;
        import_inner(
            &app,
            state.inner(),
            &archive,
            name.or(Some(project.title)),
            None,
            include_optional.unwrap_or(false),
        )
        .await
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

pub(crate) fn instance_dependencies(
    state: &LauncherState,
    instance: &Instance,
) -> Result<BTreeMap<String, String>, String> {
    let local = Path::new(&instance.game_directory).join(".launcher-pack.json");
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
    let config = state.snapshot()?.config;
    let root = Path::new(&config.game_directory);
    let mut current = instance.version_id.clone();
    let mut visited = HashSet::new();
    let mut loader = None;
    for _ in 0..16 {
        if !visited.insert(current.clone()) {
            return Err("版本继承关系循环".into());
        }
        let path = safe_join(root, &format!("versions/{current}/{current}.json"))?;
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

#[tauri::command]
pub async fn export_modrinth_modpack(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    output_path: String,
    name: Option<String>,
    include_configs: Option<bool>,
    include_resource_packs: Option<bool>,
    include_shader_packs: Option<bool>,
    include_saves: Option<bool>,
    include_owned_assets: Option<bool>,
) -> Result<PackExportResult, String> {
    let _operation = state.operation.lock().await;
    let task = state
        .control
        .begin("export", &instance_id, "导出 Modrinth 整合包");
    let result=async{
        let instance=instances::instance(&state.snapshot()?,&instance_id)?;
        let root=checked_absolute(Path::new(&instance.game_directory))?;let output=checked_absolute(Path::new(&output_path))?;
        if output.extension().and_then(|s|s.to_str()).is_none_or(|s|!s.eq_ignore_ascii_case("mrpack")){return Err("整合包导出路径须以 .mrpack 结尾".into());}
        if output.exists()||output.starts_with(&root){return Err("导出目标已存在或位于实例内部，请另选文件名和目录".into());}
        let files=instances::collect_files(&root)?;let mut selected=Vec::new();let mut warnings=Vec::new();
        for record in &files{
            let relative=&record.relative;
            if is_mod(relative)||relative.starts_with("resourcepacks/")&&include_resource_packs.unwrap_or(false)||relative.starts_with("shaderpacks/")&&include_shader_packs.unwrap_or(false){selected.push(record.clone());}
        }
        let mut hash_to_record=HashMap::<String,Vec<(FileRecord,String)>>::new();
        for record in &selected{
            state.control.checkpoint().await?;let(a,b,size)=hashes(&safe_join(&root,&record.relative)?)?;
            if size!=record.size{return Err("导出期间资源文件发生变化".into());}
            hash_to_record.entry(b).or_default().push((record.clone(),a));
        }
        let api=client(false)?;let all_hashes:Vec<String>=hash_to_record.keys().cloned().collect();let mut mappings=HashMap::<String,ApiVersion>::new();
        for chunk in all_hashes.chunks(100){
            state.control.checkpoint().await?;
            let result:HashMap<String,ApiVersion>=json_response(api.post(format!("{API}/version_files")).json(&json!({"algorithm":"sha512","hashes":chunk}))).await?;
            mappings.extend(result);
        }
        let mut index_files=Vec::new();let mut raw_files=Vec::new();let mut unmapped=Vec::new();
        for(hash,records)in hash_to_record{
            let mapped=mappings.get(&hash).and_then(|version|version.files.iter().find(|file|file.hashes.get("sha512").is_some_and(|v|v.eq_ignore_ascii_case(&hash))));
            for(record,sha1)in records{
                if let Some(file)=mapped{
                    allowed_download(&file.url)?;
                    index_files.push(PackFile{path:record.relative.clone(),hashes:BTreeMap::from([("sha1".into(),sha1),("sha512".into(),hash.clone())]),downloads:vec![file.url.clone()],file_size:record.size,env:None});
                }else if is_mod(&record.relative)||!include_owned_assets.unwrap_or(false){unmapped.push(record.relative);}
                else{raw_files.push(record);}
            }
        }
        if !unmapped.is_empty(){return Err(format!("以下文件无法映射到可下载的 Modrinth 版本，未直接重新分发原文件：{}。模组请使用个人备份迁移；自有资源需明确选择“有权分享额外资源”。",unmapped.iter().take(12).cloned().collect::<Vec<_>>().join("、")));}
        for record in &files{
            let include=(include_configs.unwrap_or(true)&&["config/","defaultconfigs/","kubejs/","scripts/"].iter().any(|prefix|record.relative.starts_with(prefix)))
                ||include_saves.unwrap_or(false)&&record.relative.starts_with("saves/");
            if include{if credential_path(&record.relative){warnings.push(format!("已排除可能包含凭据的配置 {}",record.relative));}else{raw_files.push(record.clone());}}
        }
        raw_files.sort_by(|a,b|a.relative.cmp(&b.relative));raw_files.dedup_by(|a,b|a.relative==b.relative);
        if raw_files.iter().any(|file|without_disabled(&file.relative).to_ascii_lowercase().ends_with(".jar")) {
            return Err("配置或存档目录包含未经 Modrinth 映射的 JAR。为避免擅自重新分发，不能放进 overrides；请改用个人备份。".into());
        }
        index_files.sort_by(|a,b|a.path.cmp(&b.path));
        let index=PackIndex{format_version:1,game:"minecraft".into(),version_id:uuid::Uuid::new_v4().to_string(),name:name.unwrap_or_else(||instance.name.clone()),
            summary:Some("Exported by VoxelightLauncher; mods are download references, never bundled without permission.".into()),files:index_files,dependencies:instance_dependencies(&state,&instance)?};
        let parent=output.parent().ok_or("导出目录无效")?;checked_absolute(parent)?;fs::create_dir_all(parent).map_err(|e|e.to_string())?;
        let temporary=safe_join(parent,&format!(".mrpack-export-{}.part",uuid::Uuid::new_v4()))?;
        let write_result:Result<(),String>=async {
            let file=fs::OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|e|e.to_string())?;
            let mut zip=ZipWriter::new(file);let options=SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).unix_permissions(0o644);
            zip.start_file("modrinth.index.json",options).map_err(|e|e.to_string())?;zip.write_all(&serde_json::to_vec_pretty(&index).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
            for record in &raw_files{
                state.control.checkpoint().await?;
                zip.start_file(format!("overrides/{}",record.relative),options).map_err(|e|e.to_string())?;
                std::io::copy(&mut fs::File::open(safe_join(&root,&record.relative)?).map_err(|e|e.to_string())?,&mut zip).map_err(|e|e.to_string())?;
            }
            zip.finish().map_err(|e|e.to_string())?.sync_all().map_err(|e|e.to_string())?;
            if instances::collect_files(&root)?!=files{return Err("导出期间实例发生变化，请关闭游戏后重试".into());}
            if output.exists(){return Err("导出期间出现同名文件，现有文件未覆盖".into());}
            fs::rename(&temporary,&output).map_err(|e|e.to_string())
        }.await;
        if write_result.is_err(){let _=fs::remove_file(&temporary);}write_result?;
        Ok(PackExportResult{path:output.to_string_lossy().into_owned(),download_files:index.files.len(),override_files:raw_files.len(),warnings})
    }.await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
