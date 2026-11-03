use crate::{
    models::*,
    storage::{safe_join, trusted_url, validate_id, LauncherState},
};
use futures_util::{stream, StreamExt, TryStreamExt};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

pub fn game_directory(
    config: &Config,
    version_id: &str,
    instance: Option<&Instance>,
) -> Result<PathBuf, String> {
    validate_id(version_id)?;
    if let Some(instance) = instance {
        if instance.version_id != version_id {
            return Err("实例绑定版本与请求不一致".into());
        }
        let path = PathBuf::from(&instance.game_directory);
        if !path.is_absolute() {
            return Err("实例目录必须是绝对路径".into());
        }
        return Ok(path);
    }
    let root = PathBuf::from(&config.game_directory);
    if !root.is_absolute() {
        return Err("游戏目录必须是绝对路径".into());
    }
    if config.version_isolation {
        safe_join(&root, &format!("versions/{version_id}"))
    } else {
        Ok(root)
    }
}

pub fn log(app: &AppHandle, state: &LauncherState, level: &str, message: impl Into<String>) {
    let event = LogEvent {
        level: level.into(),
        message: crate::processes::redact(&message.into()),
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    let directory = state.data_dir.join("logs");
    if fs::create_dir_all(&directory).is_ok() {
        if let Ok(mut file) = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join(format!(
                "launcher-{}.log",
                chrono::Utc::now().format("%Y-%m-%d")
            )))
        {
            let _ = writeln!(
                file,
                "{} [{}] {}",
                event.timestamp, event.level, event.message
            );
        }
    }
    let _ = app.emit("launcher://log", event);
}

pub(crate) async fn next_process_line<R>(reader: &mut R) -> Result<Option<String>, String>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    if reader
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|e| e.to_string())?
        == 0
    {
        return Ok(None);
    }
    let mut line = String::from_utf8_lossy(&bytes).into_owned();
    if line.ends_with('\n') {
        line.pop();
        if line.ends_with('\r') {
            line.pop();
        }
    }
    Ok(Some(line))
}

pub fn progress(
    app: &AppHandle,
    version: &str,
    stage: &str,
    completed: usize,
    total: usize,
    bytes_completed: u64,
    bytes_total: u64,
    message: impl Into<String>,
) {
    let _ = app.emit(
        "launcher://progress",
        ProgressEvent {
            operation: "install".into(),
            stage: stage.into(),
            completed,
            total,
            bytes_completed,
            bytes_total,
            message: message.into(),
            version_id: version.into(),
        },
    );
}

const BMCLAPI_HOST: &str = "bmclapi2.bangbang93.com";
const BMCLAPI_ORIGIN: &str = "https://bmclapi2.bangbang93.com";

#[derive(Clone, Debug, Eq, PartialEq)]
struct UrlCandidate {
    url: String,
    mirror: bool,
}

fn mapped_bmclapi_url(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "下载地址格式错误")?;
    if parsed.scheme() != "https"
        || parsed.port_or_known_default() != Some(443)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("镜像映射只接受无凭证的 HTTPS/443 地址".into());
    }
    let host = parsed.host_str().ok_or("下载地址缺少主机")?;
    let path = match host {
        "piston-meta.mojang.com"
        | "piston-data.mojang.com"
        | "launchermeta.mojang.com"
        | "launcher.mojang.com" => parsed.path().to_owned(),
        "resources.download.minecraft.net" => {
            let segments: Vec<_> = parsed.path_segments().ok_or("资源地址路径无效")?.collect();
            let [prefix, hash] = segments.as_slice() else {
                return Err("资源地址必须符合 /{prefix}/{hash}".into());
            };
            if prefix.len() != 2
                || !prefix.bytes().all(|byte| byte.is_ascii_hexdigit())
                || !valid_sha1(hash)
                || !hash[..2].eq_ignore_ascii_case(prefix)
            {
                return Err("资源地址哈希或前缀无效".into());
            }
            format!("/assets/{prefix}/{hash}")
        }
        "libraries.minecraft.net" => {
            if parsed.path() == "/" || parsed.path().is_empty() {
                return Err("依赖库地址缺少路径".into());
            }
            format!("/libraries{}", parsed.path())
        }
        _ => return Err("此主机没有受支持的 BMCLAPI 映射".into()),
    };
    let query = parsed
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let mapped = format!("{BMCLAPI_ORIGIN}{path}{query}");
    trusted_url(&mapped)?;
    Ok(mapped)
}

fn download_url_candidates(url: &str, source: &str) -> Result<Vec<UrlCandidate>, String> {
    trusted_url(url)?;
    if !["official", "auto", "bmclapi"].contains(&source) {
        return Err("下载源无效".into());
    }
    let parsed = reqwest::Url::parse(url).map_err(|_| "下载地址格式错误")?;
    if parsed.host_str() == Some(BMCLAPI_HOST) {
        return Err("下载定义必须保留原始官方 URL，不能直接替换为镜像 URL".into());
    }
    let official = UrlCandidate {
        url: url.to_owned(),
        mirror: false,
    };
    if source == "official" {
        return Ok(vec![official]);
    }
    let supports_mirror = matches!(
        parsed.host_str(),
        Some(
            "piston-meta.mojang.com"
                | "piston-data.mojang.com"
                | "launchermeta.mojang.com"
                | "launcher.mojang.com"
                | "resources.download.minecraft.net"
                | "libraries.minecraft.net"
        )
    );
    if !supports_mirror {
        return Ok(vec![official]);
    }
    let mirror = UrlCandidate {
        url: mapped_bmclapi_url(url)?,
        mirror: true,
    };
    Ok(if source == "auto" {
        vec![official, mirror]
    } else {
        vec![mirror, official]
    })
}

fn identity_url(url: &str) -> String {
    url.to_owned()
}

fn resolve_request_url(
    url: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<String, String> {
    let resolved = resolver(url);
    #[cfg(not(test))]
    if resolved != url {
        return Err("生产环境禁止覆盖已校验的下载地址".into());
    }
    Ok(resolved)
}

async fn fetch_bytes_once(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<Vec<u8>, String> {
    trusted_url(url)?;
    let request_url = resolve_request_url(url, resolver)?;
    let response = client
        .get(request_url)
        .send()
        .await
        .map_err(|e| format!("元数据请求失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("下载服务返回错误：{e}"))?;
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("元数据超出大小限制".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if bytes.len() + chunk.len() > limit {
            return Err("元数据超出大小限制".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) async fn fetch_bytes(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let candidates = download_url_candidates(url, "official")?;
    fetch_bytes_once(client, &candidates[0].url, limit, &identity_url).await
}

/// BMCLAPI is a transport mirror, not an independent Mojang endorsement. In particular,
/// hashes supplied by a mirrored manifest inherit that manifest's trust chain.
async fn fetch_bytes_candidates_resolved<T>(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    source: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
    validate: impl Fn(&[u8]) -> Result<T, String>,
) -> Result<(Vec<u8>, T, UrlCandidate), String> {
    let candidates = download_url_candidates(url, source)?;
    let mut errors = Vec::new();
    for candidate in candidates {
        match fetch_bytes_once(client, &candidate.url, limit, resolver).await {
            Ok(bytes) => match validate(&bytes) {
                Ok(value) => return Ok((bytes, value, candidate)),
                Err(error) => errors.push(format!("{}：{error}", candidate.url)),
            },
            Err(error) => errors.push(format!("{}：{error}", candidate.url)),
        }
    }
    Err(format!("元数据候选均失败：{}", errors.join("；")))
}

pub(crate) async fn fetch_bytes_candidates<T>(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    source: &str,
    validate: impl Fn(&[u8]) -> Result<T, String>,
) -> Result<(Vec<u8>, T), String> {
    fetch_bytes_candidates_resolved(client, url, limit, source, &identity_url, validate)
        .await
        .map(|(bytes, value, _)| (bytes, value))
}

pub(crate) fn parse_json(bytes: &[u8]) -> Result<Value, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("版本元数据无效：{e}"))
}

fn validate_manifest(value: &Value) -> Result<(), String> {
    if value["latest"]["release"].as_str().is_none()
        || value["latest"]["snapshot"].as_str().is_none()
    {
        return Err("官方版本清单缺少最新版本信息".into());
    }
    let versions = value["versions"].as_array().ok_or("官方版本清单格式无效")?;
    for version in versions {
        let id = version["id"].as_str().ok_or("版本 entry 缺少 ID")?;
        validate_id(id)?;
        let url = version["url"].as_str().ok_or("版本 entry 缺少 URL")?;
        trusted_url(url)?;
        let parsed = reqwest::Url::parse(url).map_err(|_| "版本元数据 URL 无效")?;
        if !matches!(
            parsed.host_str(),
            Some(
                "piston-meta.mojang.com"
                    | "piston-data.mojang.com"
                    | "launchermeta.mojang.com"
                    | "launcher.mojang.com"
            )
        ) {
            return Err("版本 entry 必须保留原始 Mojang 官方 URL".into());
        }
        if !version["sha1"].as_str().is_some_and(valid_sha1) {
            return Err("版本 entry 缺少有效 SHA-1".into());
        }
    }
    Ok(())
}

fn manifest_cache_file(mirror: bool) -> &'static str {
    if mirror {
        "version-manifest-bmclapi.json"
    } else {
        "version-manifest-mojang.json"
    }
}

async fn cache_manifest(state: &LauncherState, bytes: &[u8], mirror: bool) {
    let cache = state.data_dir.join(manifest_cache_file(mirror));
    let temp = state
        .data_dir
        .join(format!("manifest-{}.tmp", uuid::Uuid::new_v4()));
    if tokio::fs::write(&temp, bytes).await.is_ok() {
        if tokio::fs::rename(&temp, cache).await.is_err() {
            let _ = tokio::fs::remove_file(temp).await;
        }
    }
}

async fn read_cached_manifests(state: &LauncherState, source: &str) -> Result<Vec<Value>, String> {
    let mut files = download_url_candidates(MANIFEST_URL, source)?
        .into_iter()
        .map(|candidate| manifest_cache_file(candidate.mirror))
        .collect::<Vec<_>>();
    if source != "official" {
        // Legacy caches have unknown origin and cannot establish an official hash chain.
        files.push("official-version-manifest.json");
    }
    let mut manifests = Vec::new();
    for file in files {
        let Ok(bytes) = tokio::fs::read(state.data_dir.join(file)).await else {
            continue;
        };
        let Ok(value) = parse_json(&bytes) else {
            continue;
        };
        if validate_manifest(&value).is_ok() {
            manifests.push(value);
        }
    }
    Ok(manifests)
}

async fn manifest_with_resolver(
    state: &LauncherState,
    source: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<Value, String> {
    match fetch_bytes_candidates_resolved(
        &state.client,
        MANIFEST_URL,
        16 * 1024 * 1024,
        source,
        resolver,
        |bytes| {
            let value = parse_json(bytes)?;
            validate_manifest(&value)?;
            Ok(value)
        },
    )
    .await
    {
        Ok((bytes, value, candidate)) => {
            cache_manifest(state, &bytes, candidate.mirror).await;
            Ok(value)
        }
        Err(error) => read_cached_manifests(state, source)
            .await?
            .into_iter()
            .next()
            .ok_or(error),
    }
}

pub async fn manifest(state: &LauncherState) -> Result<Value, String> {
    let source = state.snapshot()?.config.download_source;
    manifest_with_resolver(state, &source, &identity_url).await
}

pub async fn list_versions(state: &LauncherState) -> Result<Value, String> {
    let data = manifest(state).await?;
    let versions: Vec<Value> = data["versions"]
        .as_array()
        .ok_or("官方版本列表为空")?
        .iter()
        .map(|v| {
            json!({
                "id": v["id"], "type": v["type"], "releaseTime": v["releaseTime"], "url": v["url"]
            })
        })
        .collect();
    Ok(
        json!({ "latestRelease": data["latest"]["release"], "latestSnapshot": data["latest"]["snapshot"], "versions": versions }),
    )
}

pub fn scan_versions(config: &Config) -> Vec<InstalledVersion> {
    let root = Path::new(&config.game_directory);
    let Ok(versions) = safe_join(root, "versions") else {
        return vec![];
    };
    let Ok(entries) = fs::read_dir(versions) else {
        return vec![];
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if validate_id(&id).is_err() {
            continue;
        }
        let Ok(path) = safe_join(root, &format!("versions/{id}/{id}.json")) else {
            continue;
        };
        if !path.is_file() {
            continue;
        }
        let resolved = resolve_local_metadata(root, &id);
        let (metadata, has_client, reason) = match resolved {
            Ok(metadata) => {
                let client_id = metadata["_launcherClientId"].as_str().unwrap_or(&id);
                let installed = safe_join(root, &format!("versions/{client_id}/{client_id}.jar"))
                    .is_ok_and(|p| p.is_file());
                let reason = if !valid_main_class(&metadata) {
                    Some("版本主类格式无效".into())
                } else if !installed {
                    Some("继承的原版客户端尚未安装完成；请安装或修复版本".into())
                } else {
                    None
                };
                (metadata, installed, reason)
            }
            Err(error) => (json!({}), false, Some(error)),
        };
        result.push(InstalledVersion {
            id,
            version_type: metadata["type"].as_str().unwrap_or("custom").into(),
            installed: has_client,
            launchable: reason.is_none(),
            reason,
            java_major: metadata["javaVersion"]["majorVersion"]
                .as_u64()
                .map(|v| v as u32),
        });
    }
    result.sort_by(|a, b| b.id.cmp(&a.id));
    result
}

fn supported_main_class(metadata: &Value) -> bool {
    matches!(
        metadata["mainClass"].as_str(),
        Some("net.minecraft.client.main.Main" | "net.minecraft.client.Minecraft")
    )
}

fn valid_main_class(metadata: &Value) -> bool {
    metadata["mainClass"].as_str().is_some_and(|name| {
        !name.is_empty()
            && name.len() < 256
            && name.split('.').all(|part| {
                !part.is_empty()
                    && part
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
            })
    })
}

fn library_key(library: &Value) -> String {
    let name = library["name"].as_str().unwrap_or_default();
    let (coordinate, extension) = name.split_once('@').unwrap_or((name, "jar"));
    let parts: Vec<_> = coordinate.split(':').collect();
    if parts.len() >= 3 {
        format!(
            "{}:{}:{}@{}",
            parts[0],
            parts[1],
            parts.get(3).copied().unwrap_or(""),
            extension
        )
    } else {
        name.into()
    }
}

/// Merge parent -> child while retaining Mojang's client download definition.
/// Child libraries override the same group/artifact/classifier independent of version.
pub(crate) fn merge_metadata(parent: &Value, child: &Value) -> Result<Value, String> {
    let mut merged = parent
        .as_object()
        .ok_or("父版本元数据不是 JSON 对象")?
        .clone();
    let child_object = child.as_object().ok_or("子版本元数据不是 JSON 对象")?;
    for (key, value) in child_object {
        if !matches!(
            key.as_str(),
            "inheritsFrom"
                | "libraries"
                | "arguments"
                | "downloads"
                | "_launcherClientId"
                | "_launcherBaseId"
        ) {
            merged.insert(key.clone(), value.clone());
        }
    }
    let mut libraries: Vec<Value> = child["libraries"].as_array().cloned().unwrap_or_default();
    let overrides: HashSet<_> = libraries.iter().map(library_key).collect();
    libraries.extend(
        parent["libraries"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|library| !overrides.contains(&library_key(library)))
            .cloned(),
    );
    merged.insert("libraries".into(), Value::Array(libraries));
    let mut arguments = parent["arguments"].as_object().cloned().unwrap_or_default();
    if let Some(child_arguments) = child["arguments"].as_object() {
        for (kind, values) in child_arguments {
            let mut inherited = arguments
                .get(kind)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            inherited.extend(
                values
                    .as_array()
                    .ok_or("继承启动参数必须为数组")?
                    .iter()
                    .cloned(),
            );
            arguments.insert(kind.clone(), Value::Array(inherited));
        }
    }
    if !arguments.is_empty() {
        merged.insert("arguments".into(), Value::Object(arguments));
    }
    // Some Forge generations retain minecraftArguments although their vanilla
    // parent already has arguments.game. In that case the child is the complete
    // game-argument list; choosing the parent's array drops Forge's tweak/FML flags.
    if let Some(legacy) = child.get("minecraftArguments").and_then(Value::as_str) {
        merged.insert("_launcherLegacyGameArguments".into(), legacy.into());
    }
    merged.remove("inheritsFrom");
    Ok(Value::Object(merged))
}

fn merge_chain(mut chain: Vec<Value>) -> Result<Value, String> {
    let base = chain.pop().ok_or("版本继承链为空")?;
    let base_id = base["id"].as_str().ok_or("原版元数据缺少 ID")?.to_owned();
    let mut metadata = base;
    for child in chain.into_iter().rev() {
        metadata = merge_metadata(&metadata, &child)?;
    }
    metadata["_launcherBaseId"] = base_id.clone().into();
    metadata["_launcherClientId"] = base_id.into();
    Ok(metadata)
}

pub(crate) fn resolve_local_metadata(root: &Path, id: &str) -> Result<Value, String> {
    let mut chain = Vec::new();
    let mut visited = HashSet::new();
    let mut current = id.to_owned();
    loop {
        validate_id(&current)?;
        if chain.len() >= 16 || !visited.insert(current.clone()) {
            return Err("版本继承循环或超过 16 层".into());
        }
        let path = safe_join(root, &format!("versions/{current}/{current}.json"))?;
        let metadata = parse_json(
            &fs::read(&path).map_err(|_| format!("缺少继承版本 {current}，请先安装原版"))?,
        )?;
        if metadata["id"].as_str() != Some(current.as_str()) {
            return Err(format!("版本目录与元数据 ID 不匹配：{current}"));
        }
        let parent = metadata["inheritsFrom"]
            .as_str()
            .or_else(|| metadata["jar"].as_str().filter(|jar| *jar != current))
            .map(str::to_owned);
        if parent.is_none() && !supported_main_class(&metadata) {
            return Err("独立第三方版本缺少可验证的原版继承关系".into());
        }
        chain.push(metadata);
        if let Some(parent) = parent {
            current = parent;
        } else {
            break;
        }
    }
    merge_chain(chain)
}

pub(crate) async fn resolve_metadata(
    state: &LauncherState,
    id: &str,
    root: &Path,
) -> Result<Value, String> {
    let source = state.snapshot()?.config.download_source;
    resolve_metadata_with_source(state, id, root, &source).await
}

async fn resolve_metadata_with_source(
    state: &LauncherState,
    id: &str,
    root: &Path,
    source: &str,
) -> Result<Value, String> {
    let mut chain = Vec::new();
    let mut visited = HashSet::new();
    let mut current = id.to_owned();
    loop {
        validate_id(&current)?;
        if chain.len() >= 16 || !visited.insert(current.clone()) {
            return Err("版本继承循环或超过 16 层".into());
        }
        let path = safe_join(root, &format!("versions/{current}/{current}.json"))?;
        let local = tokio::fs::read(&path)
            .await
            .ok()
            .map(|bytes| parse_json(&bytes))
            .transpose()?;
        let parent = local
            .as_ref()
            .and_then(|metadata| {
                metadata["inheritsFrom"]
                    .as_str()
                    .or_else(|| metadata["jar"].as_str().filter(|jar| *jar != current))
            })
            .map(str::to_owned);
        if let Some(parent) = parent {
            let metadata = local.ok_or("继承元数据丢失")?;
            if metadata["id"].as_str() != Some(current.as_str())
                || (metadata.get("mainClass").is_some() && !valid_main_class(&metadata))
            {
                return Err("第三方版本 ID 或主类格式无效".into());
            }
            chain.push(metadata);
            current = parent;
        } else {
            // A mod loader's JSON is custom metadata; only this terminal parent is
            // fetched/checked against the vanilla manifest and its entry SHA-1.
            chain.push(official_metadata_with_source(state, &current, root, source).await?);
            break;
        }
    }
    merge_chain(chain)
}

pub fn rules_allow(rules: Option<&Value>) -> bool {
    let Some(rules) = rules.and_then(Value::as_array) else {
        return true;
    };
    if rules.is_empty() {
        return true;
    }
    let mut allow = false;
    for rule in rules {
        let os = &rule["os"];
        if let Some(name) = os["name"].as_str() {
            if name != "windows" {
                continue;
            }
        }
        if let Some(arch) = os["arch"].as_str() {
            if !matches!(arch, "x86_64" | "amd64" | "x64") {
                continue;
            }
        }
        if let Some(pattern) = os["version"].as_str() {
            if !regex::Regex::new(pattern).is_ok_and(|re| re.is_match("10.0")) {
                continue;
            }
        }
        if let Some(features) = rule["features"].as_object() {
            // Demo, quick-play and custom-resolution features are deliberately disabled.
            if features
                .values()
                .any(|wanted| wanted.as_bool() != Some(false))
            {
                continue;
            }
        }
        allow = rule["action"].as_str() == Some("allow");
    }
    allow
}

#[derive(Clone, Debug)]
pub(crate) struct Download {
    pub path: PathBuf,
    pub url: String,
    pub sha1: String,
    pub size: Option<u64>,
}

pub(crate) fn valid_sha1(hash: &str) -> bool {
    hash.len() == 40 && hash.bytes().all(|v| v.is_ascii_hexdigit())
}

pub(crate) fn download_from(
    value: &Value,
    root: &Path,
    default_path: Option<&str>,
) -> Result<Download, String> {
    let path = value["path"]
        .as_str()
        .or(default_path)
        .ok_or("下载资源缺少路径")?;
    let url = value["url"].as_str().ok_or("下载资源缺少 URL")?.to_owned();
    if !url.is_empty() {
        trusted_url(&url)?;
    }
    let sha1 = value["sha1"]
        .as_str()
        .ok_or("下载资源缺少 SHA-1，已拒绝未校验资源")?
        .to_ascii_lowercase();
    if !valid_sha1(&sha1) {
        return Err("下载资源 SHA-1 格式无效".into());
    }
    Ok(Download {
        path: safe_join(root, path)?,
        url,
        sha1,
        size: value["size"].as_u64(),
    })
}

async fn file_valid(file: &Download) -> Result<bool, String> {
    let metadata = match tokio::fs::symlink_metadata(&file.path).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("下载目标必须是普通文件".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("拒绝通过目录联接访问下载目标".into());
        }
    }
    if file.size.is_some_and(|size| size != metadata.len()) {
        return Ok(false);
    }
    let mut input = tokio::fs::File::open(&file.path)
        .await
        .map_err(|e| e.to_string())?;
    let mut hash = Sha1::new();
    let mut buffer = vec![0u8; 128 * 1024];
    loop {
        let n = input.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()) == file.sha1)
}

fn validate_mirror_file_redirect(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "重定向地址格式错误")?;
    if parsed.scheme() != "https"
        || parsed.port_or_known_default() != Some(443)
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("镜像文件重定向必须使用无凭证、无片段的 HTTPS/443 地址".into());
    }
    Ok(())
}

fn mirror_download_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("VoxelightLauncher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(180))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if validate_mirror_file_redirect(attempt.url().as_str()).is_ok() {
                attempt.follow()
            } else {
                attempt.error("unsafe mirror file redirect")
            }
        }))
        .build()
        .map_err(|e| format!("无法创建镜像文件下载客户端：{e}"))?;
    Ok(CLIENT.get_or_init(|| client))
}

async fn download_once(
    client: &reqwest::Client,
    file: &Download,
    url: &str,
    control: Option<&crate::downloads::DownloadControl>,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<(), String> {
    trusted_url(url)?;
    let request_url = resolve_request_url(url, resolver)?;
    let parent = file.path.parent().ok_or("下载路径缺少父目录")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".launcher-{}.part", uuid::Uuid::new_v4()));
    let result = async {
        let response = client
            .get(request_url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        if file
            .size
            .zip(response.content_length())
            .is_some_and(|(expected, actual)| expected != actual)
        {
            return Err("下载大小与版本元数据不一致".to_owned());
        }
        let mut output = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .await
            .map_err(|e| e.to_string())?;
        let mut chunks = response.bytes_stream();
        let mut hash = Sha1::new();
        let mut size = 0u64;
        while let Some(chunk) = chunks.next().await {
            if let Some(control) = control {
                control.checkpoint().await?;
            }
            let chunk = chunk.map_err(|e| e.to_string())?;
            size += chunk.len() as u64;
            if size > file.size.unwrap_or(2 * 1024 * 1024 * 1024) {
                return Err("下载文件超出预期大小".into());
            }
            hash.update(&chunk);
            output.write_all(&chunk).await.map_err(|e| e.to_string())?;
            if let Some(control) = control {
                control.throttle(chunk.len()).await?;
            }
        }
        output.flush().await.map_err(|e| e.to_string())?;
        output.sync_all().await.map_err(|e| e.to_string())?;
        drop(output);
        if file.size.is_some_and(|expected| expected != size)
            || format!("{:x}", hash.finalize()) != file.sha1
        {
            return Err("SHA-1 或文件大小校验失败".into());
        }
        tokio::fs::rename(&temp, &file.path)
            .await
            .map_err(|e| format!("保存已校验文件失败：{e}"))?;
        Ok(())
    }
    .await;
    // Only the random temporary file owned by this download is removed.
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

pub(crate) async fn ensure_download(
    client: &reqwest::Client,
    file: &Download,
) -> Result<bool, String> {
    ensure_download_with_control(client, file, None).await
}

pub(crate) async fn ensure_download_with_control(
    client: &reqwest::Client,
    file: &Download,
    control: Option<&crate::downloads::DownloadControl>,
) -> Result<bool, String> {
    ensure_download_with_source_and_control(client, file, "official", control).await
}

/// Uses the original metadata SHA-1 for every candidate. Mirrored files and their
/// checksums remain in the mirror's trust chain; this is not independent official signing.
pub(crate) async fn ensure_download_with_source_and_control(
    client: &reqwest::Client,
    file: &Download,
    source: &str,
    control: Option<&crate::downloads::DownloadControl>,
) -> Result<bool, String> {
    ensure_download_with_source_and_control_resolved(client, file, source, control, &identity_url)
        .await
}

async fn ensure_download_with_source_and_control_resolved(
    client: &reqwest::Client,
    file: &Download,
    source: &str,
    control: Option<&crate::downloads::DownloadControl>,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<bool, String> {
    if let Some(control) = control {
        control.checkpoint().await?;
    }
    if file_valid(file).await? {
        return Ok(false);
    }
    if file.url.is_empty() {
        return Err(format!(
            "缺少安装器后处理生成的文件：{}；请重新安装对应加载器",
            file.path.display()
        ));
    }
    let candidates = download_url_candidates(&file.url, source)?;
    if candidates.iter().any(|candidate| candidate.mirror) && !valid_sha1(&file.sha1) {
        return Err("镜像文件必须具有固定且有效的预期 SHA-1".into());
    }
    let mirror_client = if candidates.iter().any(|candidate| candidate.mirror) {
        Some(mirror_download_client()?)
    } else {
        None
    };
    let attempts = if candidates.len() == 1 { 3 } else { 1 };
    let mut errors = Vec::new();
    for candidate in candidates {
        let candidate_client = if candidate.mirror {
            mirror_client.unwrap_or(client)
        } else {
            client
        };
        for attempt in 0..attempts {
            if let Some(control) = control {
                control.checkpoint().await?;
            }
            match download_once(candidate_client, file, &candidate.url, control, resolver).await {
                Ok(()) => return Ok(true),
                Err(error) => errors.push(format!("{}：{error}", candidate.url)),
            }
            if attempt + 1 < attempts {
                tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
            }
        }
    }
    Err(format!(
        "资源下载失败（{}）：{}",
        file.path.file_name().unwrap_or_default().to_string_lossy(),
        errors.join("；")
    ))
}

async fn ensure_json_download_with_source_and_control(
    client: &reqwest::Client,
    file: &Download,
    source: &str,
    control: Option<&crate::downloads::DownloadControl>,
    validate: impl Fn(&Value) -> Result<(), String>,
) -> Result<(Value, bool), String> {
    ensure_json_download_with_source_and_control_resolved(
        client,
        file,
        source,
        control,
        &identity_url,
        validate,
    )
    .await
}

async fn ensure_json_download_with_source_and_control_resolved(
    client: &reqwest::Client,
    file: &Download,
    source: &str,
    control: Option<&crate::downloads::DownloadControl>,
    resolver: &(dyn Fn(&str) -> String + Sync),
    validate: impl Fn(&Value) -> Result<(), String>,
) -> Result<(Value, bool), String> {
    const JSON_LIMIT: u64 = 64 * 1024 * 1024;
    let limit = file.size.unwrap_or(JSON_LIMIT);
    if limit > JSON_LIMIT {
        return Err("JSON 元数据超出大小限制".into());
    }
    let parse = |bytes: &[u8]| {
        if file
            .size
            .is_some_and(|expected| expected != bytes.len() as u64)
            || format!("{:x}", Sha1::digest(bytes)) != file.sha1
        {
            return Err("SHA-1 或文件大小校验失败".into());
        }
        let value = parse_json(bytes)?;
        validate(&value)?;
        Ok(value)
    };
    if file_valid(file).await? {
        let bytes = tokio::fs::read(&file.path)
            .await
            .map_err(|e| e.to_string())?;
        if let Ok(value) = parse(&bytes) {
            return Ok((value, false));
        }
    }
    if file.url.is_empty() {
        return Err(format!(
            "缺少安装器后处理生成的文件：{}；请重新安装对应加载器",
            file.path.display()
        ));
    }
    if let Some(control) = control {
        control.checkpoint().await?;
    }
    // JSON metadata never uses the dynamic-host mirror file redirect client.
    let (bytes, value, _) =
        fetch_bytes_candidates_resolved(client, &file.url, limit as usize, source, resolver, parse)
            .await?;
    if let Some(control) = control {
        control.throttle(bytes.len()).await?;
    }
    let parent = file.path.parent().ok_or("下载路径缺少父目录")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".launcher-{}.part", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&temp, &file.path)
        .await
        .map_err(|e| format!("保存已校验 JSON 元数据失败：{e}"))?;
    Ok((value, true))
}

pub(crate) fn maven_path(name: &str) -> Result<String, String> {
    let (coordinate, extension) = name.split_once('@').unwrap_or((name, "jar"));
    let parts: Vec<_> = coordinate.split(':').collect();
    if !(3..=4).contains(&parts.len()) {
        return Err("无效的 Maven 库坐标".into());
    }
    for part in &parts {
        validate_id(part)?;
    }
    validate_id(extension)?;
    let classifier = parts.get(3).map(|s| format!("-{s}")).unwrap_or_default();
    Ok(format!(
        "{}/{}/{}/{}-{}{classifier}.{extension}",
        parts[0].replace('.', "/"),
        parts[1],
        parts[2],
        parts[1],
        parts[2]
    ))
}

pub(crate) async fn library_download(
    state: &LauncherState,
    library: &Value,
    root: &Path,
) -> Result<Option<Download>, String> {
    library_download_with_source(state, library, root, "official").await
}

async fn library_download_with_source(
    state: &LauncherState,
    library: &Value,
    root: &Path,
    source: &str,
) -> Result<Option<Download>, String> {
    if let Some(artifact) = library["downloads"].get("artifact") {
        if artifact["sha1"].as_str().is_some_and(valid_sha1) {
            return Ok(Some(download_from(artifact, root, None)?));
        }
    }
    // Older versions use Maven coordinates and a publisher sidecar checksum.
    if library.get("natives").is_some() {
        return Ok(None);
    }
    let name = library["name"].as_str().ok_or("依赖库缺少名称")?;
    let path = library["downloads"]["artifact"]["path"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or(maven_path(name)?);
    let base = library["url"]
        .as_str()
        .unwrap_or("https://libraries.minecraft.net/");
    let url = library["downloads"]["artifact"]["url"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{}/{path}", base.trim_end_matches('/')));
    let hash = if let Some(hash) = library["sha1"].as_str().filter(|hash| valid_sha1(hash)) {
        hash.to_ascii_lowercase()
    } else {
        let (_, hash) = fetch_bytes_candidates(
            &state.client,
            &format!("{url}.sha1"),
            1024,
            source,
            |bytes| {
                let checksum = std::str::from_utf8(bytes)
                    .map_err(|_| "依赖校验值无效")?
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !valid_sha1(&checksum) {
                    return Err("旧版依赖缺少有效校验值".into());
                }
                Ok(checksum)
            },
        )
        .await?;
        hash
    };
    Ok(Some(Download {
        path: safe_join(root, &path)?,
        url,
        sha1: hash,
        size: library["size"].as_u64().filter(|n| *n > 0),
    }))
}

fn native_download(library: &Value, root: &Path) -> Result<Option<Download>, String> {
    let Some(native) = library["natives"]["windows"].as_str() else {
        return Ok(None);
    };
    let name = native.replace("${arch}", "64");
    let entry = &library["downloads"]["classifiers"][&name];
    if entry.is_null() {
        return Err(format!("缺少 Windows x64 原生依赖：{name}"));
    }
    Ok(Some(download_from(entry, root, None)?))
}

fn manifest_version<'a>(manifest: &'a Value, id: &str) -> Result<&'a Value, String> {
    manifest["versions"]
        .as_array()
        .and_then(|versions| versions.iter().find(|v| v["id"].as_str() == Some(id)))
        .ok_or("此版本不在 Mojang 官方原版清单中；第三方安装器暂未迁移".into())
}

fn parse_official_metadata(bytes: &[u8], id: &str, expected: &str) -> Result<Value, String> {
    if !valid_sha1(expected)
        || format!("{:x}", Sha1::digest(bytes)) != expected.to_ascii_lowercase()
    {
        return Err("版本元数据 SHA-1 校验失败".into());
    }
    let metadata = parse_json(bytes)?;
    if metadata["id"].as_str() != Some(id)
        || metadata.get("inheritsFrom").is_some()
        || !supported_main_class(&metadata)
    {
        return Err("当前 Rust 核心只支持官方 Java 原版版本".into());
    }
    Ok(metadata)
}

/// A mirrored manifest is not independent official endorsement: both its entry hashes and
/// the files checked against them share the mirror's chain of trust.
pub(crate) async fn official_metadata(
    state: &LauncherState,
    id: &str,
    root: &Path,
) -> Result<Value, String> {
    let source = state.snapshot()?.config.download_source;
    official_metadata_with_source(state, id, root, &source).await
}

async fn official_metadata_with_source(
    state: &LauncherState,
    id: &str,
    root: &Path,
    source: &str,
) -> Result<Value, String> {
    official_metadata_with_resolver(state, id, root, source, &identity_url).await
}

async fn official_metadata_with_resolver(
    state: &LauncherState,
    id: &str,
    root: &Path,
    source: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<Value, String> {
    validate_id(id)?;
    let local_path = safe_join(root, &format!("versions/{id}/{id}.json"))?;
    // Offline checksums must come from a manifest origin allowed by the current source.
    let cached_manifests = read_cached_manifests(state, source).await?;
    if let Ok(local_bytes) = tokio::fs::read(&local_path).await {
        for cached in cached_manifests {
            if let Ok(version) = manifest_version(&cached, id) {
                if let Ok(metadata) = parse_official_metadata(
                    &local_bytes,
                    id,
                    version["sha1"].as_str().unwrap_or(""),
                ) {
                    return Ok(metadata);
                }
            }
        }
    }
    let candidates = download_url_candidates(MANIFEST_URL, source)?;
    let mut errors = Vec::new();
    for candidate in candidates {
        let manifest_bytes =
            match fetch_bytes_once(&state.client, &candidate.url, 16 * 1024 * 1024, resolver).await
            {
                Ok(bytes) => bytes,
                Err(error) => {
                    errors.push(format!("{}：{error}", candidate.url));
                    continue;
                }
            };
        let manifest = match parse_json(&manifest_bytes).and_then(|value| {
            validate_manifest(&value)?;
            Ok(value)
        }) {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("{}：{error}", candidate.url));
                continue;
            }
        };
        cache_manifest(state, &manifest_bytes, candidate.mirror).await;
        let version = match manifest_version(&manifest, id) {
            Ok(version) => version,
            Err(error) => {
                errors.push(format!("{}：{error}", candidate.url));
                continue;
            }
        };
        let url = version["url"]
            .as_str()
            .ok_or("版本元数据 URL 缺失")?
            .to_owned();
        let expected = version["sha1"]
            .as_str()
            .ok_or("官方版本清单缺少 SHA-1")?
            .to_owned();
        if let Ok(local_bytes) = tokio::fs::read(&local_path).await {
            if let Ok(metadata) = parse_official_metadata(&local_bytes, id, &expected) {
                return Ok(metadata);
            }
        }
        match fetch_bytes_candidates_resolved(
            &state.client,
            &url,
            8 * 1024 * 1024,
            source,
            resolver,
            |bytes| parse_official_metadata(bytes, id, &expected),
        )
        .await
        {
            Ok((bytes, metadata, _)) => {
                tokio::fs::create_dir_all(local_path.parent().ok_or("版本目录无效")?)
                    .await
                    .map_err(|e| e.to_string())?;
                // Never replace an existing third-party manifest under an official version name.
                if let Ok(existing) = tokio::fs::read(&local_path).await {
                    if existing != bytes {
                        let backup = local_path.with_extension(format!(
                            "json.backup-{}",
                            chrono::Utc::now().timestamp_millis()
                        ));
                        tokio::fs::copy(&local_path, backup)
                            .await
                            .map_err(|e| format!("备份已有版本元数据失败：{e}"))?;
                    }
                }
                let temp = local_path.with_extension(format!("json-{}.tmp", uuid::Uuid::new_v4()));
                tokio::fs::write(&temp, bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                tokio::fs::rename(temp, &local_path)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(metadata);
            }
            Err(error) => errors.push(format!("{} 的版本链：{error}", candidate.url)),
        }
    }
    Err(format!("原版元数据候选均失败：{}", errors.join("；")))
}

pub async fn install(
    state: &LauncherState,
    app: &AppHandle,
    id: &str,
) -> Result<(InstallResult, Value), String> {
    let config = state.snapshot()?.config;
    install_with_config(state, app, id, &config).await
}

async fn install_with_config(
    state: &LauncherState,
    app: &AppHandle,
    id: &str,
    config: &Config,
) -> Result<(InstallResult, Value), String> {
    validate_id(id)?;
    let root = Path::new(&config.game_directory);
    if !root.is_absolute() {
        return Err("游戏目录必须是绝对路径".into());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    state.control.checkpoint().await?;
    progress(
        app,
        id,
        "metadata",
        0,
        0,
        0,
        0,
        "解析版本继承链并校验 Mojang 原版元数据",
    );
    log(
        app,
        state,
        "info",
        format!("准备安装/修复 {id}；原版及加载器资源分别验证来源与 SHA-1"),
    );
    let mut metadata =
        resolve_metadata_with_source(state, id, root, &config.download_source).await?;
    let client_id = metadata["_launcherClientId"]
        .as_str()
        .unwrap_or(id)
        .to_owned();
    let mut files = BTreeMap::<PathBuf, Download>::new();
    let client = download_from(
        &metadata["downloads"]["client"],
        root,
        Some(&format!("versions/{client_id}/{client_id}.jar")),
    )?;
    files.insert(client.path.clone(), client);
    let libraries = safe_join(root, "libraries")?;
    for library in metadata["libraries"]
        .as_array()
        .ok_or("版本未提供依赖库列表")?
    {
        state.control.checkpoint().await?;
        if !rules_allow(library.get("rules")) {
            continue;
        }
        if let Some(file) =
            library_download_with_source(state, library, &libraries, &config.download_source)
                .await?
        {
            files.insert(file.path.clone(), file);
        }
        if let Some(file) = native_download(library, &libraries)? {
            files.insert(file.path.clone(), file);
        }
    }
    if !metadata["assetIndex"].is_null() {
        let asset_id = metadata["assetIndex"]["id"]
            .as_str()
            .ok_or("资源索引缺少 ID")?;
        validate_id(asset_id)?;
        let index = download_from(
            &metadata["assetIndex"],
            root,
            Some(&format!("assets/indexes/{asset_id}.json")),
        )?;
        let (assets, _) = ensure_json_download_with_source_and_control(
            &state.client,
            &index,
            &config.download_source,
            Some(&state.control),
            |value| {
                let objects = value["objects"].as_object().ok_or("资源索引无效")?;
                for object in objects.values() {
                    if !object["hash"].as_str().is_some_and(valid_sha1) {
                        return Err("资源哈希无效".into());
                    }
                }
                Ok(())
            },
        )
        .await?;
        for (_, object) in assets["objects"].as_object().ok_or("资源索引无效")? {
            let hash = object["hash"]
                .as_str()
                .ok_or("资源缺少 SHA-1")?
                .to_ascii_lowercase();
            if !valid_sha1(&hash) {
                return Err("资源哈希无效".into());
            }
            let prefix = &hash[..2];
            let file = Download {
                path: safe_join(root, &format!("assets/objects/{prefix}/{hash}"))?,
                url: format!("https://resources.download.minecraft.net/{prefix}/{hash}"),
                sha1: hash,
                size: object["size"].as_u64(),
            };
            files.insert(file.path.clone(), file);
        }
    }
    let files: Vec<_> = files.into_values().collect();
    let total = files.len();
    let total_bytes: u64 = files.iter().filter_map(|f| f.size).sum();
    let completed = AtomicUsize::new(0);
    let downloaded = AtomicUsize::new(0);
    let completed_bytes = AtomicU64::new(0);
    progress(
        app,
        id,
        "download",
        0,
        total,
        0,
        total_bytes,
        format!("检查并下载 {total} 个文件"),
    );
    let download_source = config.download_source.as_str();
    stream::iter(files.into_iter().map(|file| {
        let completed = &completed;
        let downloaded = &downloaded;
        let completed_bytes = &completed_bytes;
        async move {
            let was_downloaded = ensure_download_with_source_and_control(
                &state.client,
                &file,
                download_source,
                Some(&state.control),
            )
            .await?;
            if was_downloaded {
                downloaded.fetch_add(1, Ordering::Relaxed);
            }
            let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
            let bytes = completed_bytes.fetch_add(file.size.unwrap_or(0), Ordering::Relaxed)
                + file.size.unwrap_or(0);
            if done == 1 || done % 10 == 0 || done == total {
                progress(
                    app,
                    id,
                    "download",
                    done,
                    total,
                    bytes,
                    total_bytes,
                    format!("已校验 {done}/{total} 个文件"),
                );
            }
            Ok::<_, String>(())
        }
    }))
    .buffer_unordered(config.download_concurrency.clamp(1, 16))
    .try_collect::<Vec<_>>()
    .await?;
    if client_id != id {
        // Keep the verified official base JAR under the selected inherited version's
        // name as well: Forge's ignoreList/version_name contract uses this basename.
        let source = safe_join(root, &format!("versions/{client_id}/{client_id}.jar"))?;
        let destination = safe_join(root, &format!("versions/{id}/{id}.jar"))?;
        let alias = Download {
            path: destination.clone(),
            url: String::new(),
            sha1: metadata["downloads"]["client"]["sha1"]
                .as_str()
                .ok_or("原版 SHA-1 缺失")?
                .into(),
            size: metadata["downloads"]["client"]["size"].as_u64(),
        };
        if !file_valid(&alias).await? {
            let temporary = destination.with_extension(format!("jar-{}.tmp", uuid::Uuid::new_v4()));
            tokio::fs::create_dir_all(destination.parent().ok_or("版本目录无效")?)
                .await
                .map_err(|e| e.to_string())?;
            tokio::fs::copy(source, &temporary)
                .await
                .map_err(|e| e.to_string())?;
            tokio::fs::rename(temporary, destination)
                .await
                .map_err(|e| e.to_string())?;
        }
        metadata["_launcherClientId"] = id.into();
    }
    let count = downloaded.load(Ordering::Relaxed);
    progress(
        app,
        id,
        "complete",
        total,
        total,
        total_bytes,
        total_bytes,
        "安装完成，全部资源校验通过",
    );
    log(
        app,
        state,
        "info",
        format!("{id} 安装完成：下载 {count}，复用 {} 个文件", total - count),
    );
    Ok((
        InstallResult {
            version_id: id.into(),
            downloaded: count,
            reused: total - count,
        },
        metadata,
    ))
}

fn java_major(version: &str) -> Option<u32> {
    let mut parts = version.split(['.', '-', '_', '+']);
    let first = parts.next()?.parse().ok()?;
    if first == 1 {
        parts.next()?.parse().ok()
    } else {
        Some(first)
    }
}

async fn inspect_java(path: PathBuf) -> Option<JavaRuntime> {
    let mut command = tokio::process::Command::new(&path);
    command
        .arg("-version")
        .kill_on_drop(true)
        .stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(7), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let regex = regex::Regex::new(r#"(?:java|openjdk) version "([^"]+)""#).ok()?;
    let version = regex.captures(&text)?.get(1)?.as_str().to_owned();
    let major = java_major(&version)?;
    Some(JavaRuntime {
        path: path.to_string_lossy().into_owned(),
        version,
        major,
    })
}

fn find_java(directory: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth == 0 || output.len() > 80 {
        return;
    }
    if let Ok(entries) = fs::read_dir(directory) {
        for entry in entries.flatten().take(100) {
            let path = entry.path();
            if entry.file_name() == "java.exe" {
                output.push(path);
            } else if entry
                .file_type()
                .is_ok_and(|t| t.is_dir() && !t.is_symlink())
            {
                find_java(&path, depth - 1, output);
            }
        }
    }
}

pub async fn detect_java(config: &Config) -> Vec<JavaRuntime> {
    let mut candidates = Vec::new();
    if !config.java_path.trim().is_empty() {
        candidates.push(PathBuf::from(&config.java_path));
    }
    if let Some(home) = std::env::var_os("JAVA_HOME") {
        candidates.push(PathBuf::from(home).join("bin/java.exe"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            candidates.push(directory.join("java.exe"));
        }
    }
    for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(key) {
            for directory in [
                "Java",
                "Eclipse Adoptium",
                "Microsoft",
                "Zulu",
                "BellSoft",
                "Programs/Eclipse Adoptium",
            ] {
                find_java(&PathBuf::from(&base).join(directory), 4, &mut candidates);
            }
        }
    }
    find_java(
        &Path::new(&config.game_directory).join("runtime"),
        7,
        &mut candidates,
    );
    if let Ok(data_dir) = crate::storage::data_directory() {
        find_java(&data_dir.join("runtimes"), 5, &mut candidates);
    }
    let mut unique = HashSet::new();
    candidates.retain(|p| p.is_file() && unique.insert(p.to_string_lossy().to_ascii_lowercase()));
    let mut runtimes: Vec<_> = stream::iter(candidates.into_iter().map(inspect_java))
        .buffer_unordered(4)
        .filter_map(|runtime| async { runtime })
        .collect()
        .await;
    runtimes.sort_by(|a, b| b.major.cmp(&a.major).then(a.path.cmp(&b.path)));
    runtimes
}

pub(crate) async fn select_java(config: &Config, metadata: &Value) -> Result<JavaRuntime, String> {
    let required = metadata["javaVersion"]["majorVersion"]
        .as_u64()
        .unwrap_or(8) as u32;
    let runtimes = detect_java(config).await;
    if !config.java_path.trim().is_empty() {
        let runtime = runtimes
            .iter()
            .find(|runtime| runtime.path.eq_ignore_ascii_case(&config.java_path))
            .ok_or("设置中的 Java 路径无效或无法运行；请重新扫描 Java")?;
        if runtime.major < required {
            return Err(format!(
                "此版本最低需要 Java {required}，当前选择 Java {}。请在设置中选择较新的运行时",
                runtime.major
            ));
        }
        return Ok(runtime.clone());
    }
    runtimes
        .iter()
        .find(|runtime| runtime.major == required)
        .cloned()
        .or_else(|| {
            runtimes
                .into_iter()
                .filter(|runtime| runtime.major > required)
                .min_by_key(|runtime| runtime.major)
        })
        .ok_or_else(|| {
            format!("未找到 Java {required} 或更高版本；请安装 64 位 Java 并在设置中选择")
        })
}

const JAVA_RUNTIME_INDEX:&str="https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

async fn install_official_java(
    state: &LauncherState,
    app: &AppHandle,
    metadata: &Value,
    config: &Config,
) -> Result<JavaRuntime, String> {
    let required = metadata["javaVersion"]["majorVersion"]
        .as_u64()
        .unwrap_or(8) as u32;
    let component = metadata["javaVersion"]["component"]
        .as_str()
        .or_else(|| match required {
            8 => Some("jre-legacy"),
            16 => Some("java-runtime-alpha"),
            17 => Some("java-runtime-gamma"),
            21 => Some("java-runtime-delta"),
            25 => Some("java-runtime-epsilon"),
            _ => None,
        })
        .ok_or("Mojang 未提供此 Java 主版本的运行时组件")?;
    validate_id(component)?;
    state.control.checkpoint().await?;
    let (_, index) = fetch_bytes_candidates(
        &state.client,
        JAVA_RUNTIME_INDEX,
        4 * 1024 * 1024,
        &config.download_source,
        |bytes| {
            let index = parse_json(bytes)?;
            let runtime = index["windows-x64"][component]
                .as_array()
                .and_then(|entries| entries.first())
                .ok_or("Mojang 未提供该组件的 Windows x64 运行时")?;
            let vendor_version = runtime["version"]["name"]
                .as_str()
                .ok_or("Java运行时版本信息缺失")?;
            validate_id(vendor_version)?;
            let manifest = &runtime["manifest"];
            if !manifest["sha1"].as_str().is_some_and(valid_sha1) {
                return Err("Java运行时清单缺少有效 SHA-1".into());
            }
            trusted_url(manifest["url"].as_str().ok_or("Java运行时清单缺少 URL")?)?;
            Ok(index)
        },
    )
    .await?;
    let runtime = index["windows-x64"][component]
        .as_array()
        .and_then(|entries| entries.first())
        .ok_or("Mojang 未提供该组件的 Windows x64 运行时")?;
    let vendor_version = runtime["version"]["name"]
        .as_str()
        .ok_or("Java运行时版本信息缺失")?;
    validate_id(vendor_version)?;
    let root = safe_join(
        &state.data_dir,
        &format!("runtimes/{component}/{vendor_version}"),
    )?;
    let manifest_download =
        download_from(&runtime["manifest"], &root, Some("runtime-manifest.json"))?;
    let (runtime_manifest, _) = ensure_json_download_with_source_and_control(
        &state.client,
        &manifest_download,
        &config.download_source,
        Some(&state.control),
        |value| {
            let files = value["files"].as_object().ok_or("Java运行时文件清单无效")?;
            for (path, entry) in files {
                match entry["type"].as_str() {
                    Some("directory") => {
                        safe_join(&root, path)?;
                    }
                    Some("file") => {
                        download_from(&entry["downloads"]["raw"], &root, Some(path))?;
                    }
                    Some("link") => {
                        return Err(
                            "Windows运行时清单包含符号链接，当前安装器拒绝不安全的链接条目".into(),
                        )
                    }
                    _ => return Err("Java运行时清单包含未知文件类型".into()),
                }
            }
            Ok(())
        },
    )
    .await?;
    let mut files = Vec::new();
    for (path, entry) in runtime_manifest["files"]
        .as_object()
        .ok_or("Java运行时文件清单无效")?
    {
        state.control.checkpoint().await?;
        match entry["type"].as_str() {
            Some("directory") => {
                tokio::fs::create_dir_all(safe_join(&root, path)?)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Some("file") => files.push(download_from(
                &entry["downloads"]["raw"],
                &root,
                Some(path),
            )?),
            Some("link") => {
                return Err("Windows运行时清单包含符号链接，当前安装器拒绝不安全的链接条目".into())
            }
            _ => return Err("Java运行时清单包含未知文件类型".into()),
        }
    }
    let total = files.len();
    if total > 20_000 {
        return Err("Java运行时文件数量超出限制".into());
    }
    let total_bytes = files.iter().filter_map(|file| file.size).sum::<u64>();
    if total_bytes > 2 * 1024 * 1024 * 1024 {
        return Err("Java运行时总体积超出限制".into());
    }
    let done = AtomicUsize::new(0);
    let bytes = AtomicU64::new(0);
    let version_id = metadata["id"].as_str().unwrap_or(component);
    log(app,state,"info",format!("安装Mojang Windows x64 Java {required} ({vendor_version})，共{total}个文件，逐文件SHA-1校验"));
    progress(
        app,
        version_id,
        "java-runtime",
        0,
        total,
        0,
        total_bytes,
        format!("下载官方Java {required}"),
    );
    let download_source = config.download_source.as_str();
    stream::iter(files.into_iter().map(|file| {
        let done = &done;
        let bytes = &bytes;
        async move {
            ensure_download_with_source_and_control(
                &state.client,
                &file,
                download_source,
                Some(&state.control),
            )
            .await?;
            let completed = done.fetch_add(1, Ordering::Relaxed) + 1;
            let completed_bytes =
                bytes.fetch_add(file.size.unwrap_or(0), Ordering::Relaxed) + file.size.unwrap_or(0);
            if completed == 1 || completed % 10 == 0 || completed == total {
                progress(
                    app,
                    version_id,
                    "java-runtime",
                    completed,
                    total,
                    completed_bytes,
                    total_bytes,
                    format!("官方Java已校验{completed}/{total}个文件"),
                );
            }
            Ok::<_, String>(())
        }
    }))
    .buffer_unordered(config.download_concurrency.clamp(1, 16))
    .try_collect::<Vec<_>>()
    .await?;
    let java_path = safe_join(&root, "bin/java.exe")?;
    let java = inspect_java(java_path)
        .await
        .ok_or("官方Java文件校验通过，但java -version无法运行；请检查系统兼容性和文件权限")?;
    if java.major != required {
        return Err(format!(
            "官方Java实际主版本{}与游戏要求{required}不一致",
            java.major
        ));
    }
    log(
        app,
        state,
        "info",
        format!("官方Java {} 已安装并通过实际运行检测", java.version),
    );
    Ok(java)
}

pub(crate) async fn select_or_install_java(
    state: &LauncherState,
    app: &AppHandle,
    config: &Config,
    metadata: &Value,
) -> Result<JavaRuntime, String> {
    let selected = select_java(config, metadata).await;
    if !config.java_path.trim().is_empty() || !config.java_auto_download {
        return selected;
    }
    let required = metadata["javaVersion"]["majorVersion"]
        .as_u64()
        .unwrap_or(8) as u32;
    if let Ok(java) = &selected {
        if java.major == required {
            return selected;
        }
    }
    install_official_java(state, app, metadata, config).await
}

#[tauri::command]
pub async fn install_java(
    app: AppHandle,
    state: tauri::State<'_, Arc<LauncherState>>,
    game_version: String,
) -> Result<JavaRuntime, String> {
    validate_id(&game_version)?;
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行")?;
    let task = state
        .control
        .begin("java", &game_version, "安装Mojang官方Java");
    let result = async {
        let config = state.snapshot()?.config;
        let metadata =
            resolve_metadata(&state, &game_version, Path::new(&config.game_directory)).await?;
        install_official_java(&state, &app, &metadata, &config).await
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

fn extract_natives(metadata: &Value, root: &Path, natives: &Path) -> Result<(), String> {
    fs::create_dir_all(natives).map_err(|e| e.to_string())?;
    let libraries = safe_join(root, "libraries")?;
    let mut expanded = 0u64;
    for library in metadata["libraries"].as_array().ok_or("依赖列表无效")? {
        if !rules_allow(library.get("rules")) {
            continue;
        }
        let Some(file) = native_download(library, &libraries)? else {
            continue;
        };
        let input = fs::File::open(file.path).map_err(|e| e.to_string())?;
        let mut archive =
            zip::ZipArchive::new(input).map_err(|e| format!("原生依赖 ZIP 无效：{e}"))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            if entry.is_dir() || name.starts_with("META-INF/") {
                continue;
            }
            if library["extract"]["exclude"]
                .as_array()
                .is_some_and(|excludes| {
                    excludes
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|prefix| name.starts_with(prefix))
                })
            {
                continue;
            }
            // A native jar cannot create links, overwrite anything outside this fresh directory,
            // or expand to an unreasonable size.
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("原生依赖包含不允许的符号链接".into());
            }
            expanded = expanded
                .checked_add(entry.size())
                .ok_or("ZIP 解压大小溢出")?;
            if expanded > 512 * 1024 * 1024 || entry.size() > 128 * 1024 * 1024 {
                return Err("原生依赖解压超出大小限制".into());
            }
            let path = safe_join(natives, &name)?;
            fs::create_dir_all(path.parent().ok_or("解压路径无效")?).map_err(|e| e.to_string())?;
            let mut output = fs::File::create(path).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn expand(text: &str, variables: &HashMap<String, String>) -> Result<String, String> {
    let mut result = text.to_owned();
    for (key, value) in variables {
        result = result.replace(&format!("${{{key}}}"), value);
    }
    if result.contains("${") {
        return Err(format!("此版本的启动参数包含尚未支持的变量：{text}"));
    }
    Ok(result)
}

fn read_arguments(
    values: &Value,
    variables: &HashMap<String, String>,
) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for argument in values.as_array().ok_or("启动参数列表无效")? {
        if let Some(text) = argument.as_str() {
            result.push(expand(text, variables)?);
        } else if rules_allow(argument.get("rules")) {
            match &argument["value"] {
                Value::String(text) => result.push(expand(text, variables)?),
                Value::Array(values) => {
                    for text in values {
                        result.push(expand(text.as_str().ok_or("启动参数类型无效")?, variables)?);
                    }
                }
                _ => return Err("条件启动参数无效".into()),
            }
        }
    }
    Ok(result)
}

fn build_classpath(metadata: &Value, root: &Path, id: &str) -> Result<String, String> {
    let libraries = safe_join(root, "libraries")?;
    let mut paths = Vec::new();
    for library in metadata["libraries"].as_array().ok_or("依赖列表无效")? {
        if !rules_allow(library.get("rules")) {
            continue;
        }
        let path = if let Some(path) = library["downloads"]["artifact"]["path"].as_str() {
            Some(safe_join(&libraries, path)?)
        } else if library.get("natives").is_none() {
            Some(safe_join(
                &libraries,
                &maven_path(library["name"].as_str().ok_or("库名称缺失")?)?,
            )?)
        } else {
            None
        };
        if let Some(path) = path {
            if !path.is_file() {
                return Err(format!("依赖库缺失：{}", path.display()));
            }
            paths.push(path);
        }
    }
    let client_id = metadata["_launcherClientId"].as_str().unwrap_or(id);
    paths.push(safe_join(
        root,
        &format!("versions/{client_id}/{client_id}.jar"),
    )?);
    Ok(paths
        .iter()
        .map(|p| p.to_string_lossy())
        .collect::<Vec<_>>()
        .join(";"))
}

fn materialize_legacy_assets(
    metadata: &Value,
    root: &Path,
    game_dir: &Path,
) -> Result<PathBuf, String> {
    let Some(id) = metadata["assetIndex"]["id"].as_str() else {
        return safe_join(root, "assets");
    };
    validate_id(id)?;
    let index = parse_json(
        &fs::read(safe_join(root, &format!("assets/indexes/{id}.json"))?)
            .map_err(|e| e.to_string())?,
    )?;
    let virtual_assets = index["virtual"].as_bool().unwrap_or(false);
    let map_resources = index["map_to_resources"].as_bool().unwrap_or(false);
    let directory = safe_join(root, &format!("assets/virtual/{id}"))?;
    if virtual_assets || map_resources {
        for (name, object) in index["objects"].as_object().ok_or("资源索引无效")? {
            let hash = object["hash"]
                .as_str()
                .filter(|s| valid_sha1(s))
                .ok_or("资源哈希无效")?;
            let source = safe_join(root, &format!("assets/objects/{}/{hash}", &hash[..2]))?;
            let targets: Vec<PathBuf> = [
                if virtual_assets {
                    Some(safe_join(&directory, name)?)
                } else {
                    None
                },
                if map_resources {
                    Some(safe_join(&safe_join(game_dir, "resources")?, name)?)
                } else {
                    None
                },
            ]
            .into_iter()
            .flatten()
            .collect();
            for target in targets {
                fs::create_dir_all(target.parent().ok_or("资源路径无效")?)
                    .map_err(|e| e.to_string())?;
                // Resources are immutable content-addressed files; copy only missing entries.
                if !target.exists() {
                    fs::copy(&source, &target).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(if virtual_assets {
        directory
    } else {
        safe_join(root, "assets")?
    })
}

fn server_parts(address: &str) -> Result<(String, u16), String> {
    if address.is_empty()
        || address.len() > 255
        || address
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "/\\?#@\"'".contains(c))
    {
        return Err("服务器地址格式无效".into());
    }
    if let Ok(socket) = address.parse::<std::net::SocketAddr>() {
        if socket.port() == 0 {
            return Err("服务器端口无效".into());
        }
        return Ok((socket.ip().to_string(), socket.port()));
    }
    if let Ok(ip) = address.parse::<std::net::IpAddr>() {
        return Ok((ip.to_string(), 25565));
    }
    let (host, port) = if let Some((host, port)) = address.rsplit_once(':') {
        (host, port.parse::<u16>().map_err(|_| "服务器端口无效")?)
    } else {
        (address, 25565)
    };
    if host.is_empty()
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        || port == 0
    {
        return Err("服务器地址或端口无效".into());
    }
    Ok((host.into(), port))
}

fn append_direct_connect(
    arguments: &mut Vec<String>,
    metadata: &Value,
    address: &str,
) -> Result<(), String> {
    let (host, port) = server_parts(address)?;
    let quick_play = metadata["arguments"]["game"]
        .as_array()
        .is_some_and(|values| {
            values.iter().any(|v| {
                v["rules"].as_array().is_some_and(|rules| {
                    rules.iter().any(|rule| {
                        rule["features"]["is_quick_play_multiplayer"].as_bool() == Some(true)
                    })
                })
            })
        });
    if quick_play {
        let endpoint = if host.contains(':') {
            format!("[{host}]:{port}")
        } else {
            format!("{host}:{port}")
        };
        arguments.extend(["--quickPlayMultiplayer".into(), endpoint]);
    } else {
        arguments.extend(["--server".into(), host, "--port".into(), port.to_string()]);
    }
    Ok(())
}

async fn with_launch_preparation<T, F>(
    state: &LauncherState,
    id: &str,
    instance_id: Option<&str>,
    prepare: impl FnOnce(Persisted) -> F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    validate_id(id)?;
    let _guard = state.operation.lock().await;
    let snapshot = state.snapshot()?;
    if let Some(instance_id) = instance_id {
        let instance = snapshot
            .instances
            .iter()
            .find(|instance| instance.id == instance_id)
            .ok_or("实例不存在")?;
        game_directory(&snapshot.config, id, Some(instance))?;
        state.games.require_instance_launch_stopped(instance_id)?;
    }
    let task = state
        .control
        .begin("launch", id, &format!("启动 Minecraft {id}"));
    let result = prepare(snapshot).await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

pub async fn launch(
    state: Arc<LauncherState>,
    app: AppHandle,
    id: String,
    instance_id: Option<String>,
    account_id: Option<String>,
    server_address: Option<String>,
) -> Result<LaunchResult, String> {
    let shared = state.clone();
    let target = id.clone();
    let requested_instance = instance_id.clone();
    with_launch_preparation(
        &state,
        &target,
        requested_instance.as_deref(),
        move |snapshot| {
            launch_prepared(
                shared,
                app,
                id,
                instance_id,
                account_id,
                server_address,
                snapshot,
            )
        },
    )
    .await
}

async fn launch_prepared(
    state: Arc<LauncherState>,
    app: AppHandle,
    id: String,
    instance_id: Option<String>,
    account_id: Option<String>,
    server_address: Option<String>,
    snapshot: Persisted,
) -> Result<LaunchResult, String> {
    let account = snapshot
        .accounts
        .iter()
        .find(|account| {
            account_id
                .as_ref()
                .map(|id| id == &account.id)
                .unwrap_or(account.is_selected)
        })
        .ok_or("请先添加并选择一个账号")?
        .clone();
    if let Some(address) = server_address.as_deref() {
        server_parts(address)?;
    }
    let root = PathBuf::from(&snapshot.config.game_directory);
    let instance = if let Some(instance_id) = instance_id.as_ref() {
        let instance = snapshot
            .instances
            .iter()
            .find(|i| &i.id == instance_id)
            .ok_or("实例不存在")?;
        Some(instance)
    } else {
        None
    };
    let mut config = snapshot.config.clone();
    if let Some(instance) = instance {
        if let Some(memory) = instance.max_memory_mb {
            config.max_memory_mb = memory;
        }
        if let Some(java) = instance.java_path.as_ref() {
            config.java_path = java.clone();
        }
        if let Some(jvm) = instance.jvm_arguments.as_ref() {
            config.jvm_arguments = jvm.clone();
        }
        if let Some(width) = instance.screen_width {
            config.screen_width = width;
        }
        if let Some(height) = instance.screen_height {
            config.screen_height = height;
        }
    }
    let game_dir = game_directory(&snapshot.config, &id, instance)?;
    let (_, metadata) = install_with_config(&state, &app, &id, &snapshot.config).await?;
    let java = select_or_install_java(&state, &app, &config, &metadata).await?;
    let recommended = metadata["javaVersion"]["majorVersion"]
        .as_u64()
        .unwrap_or(8) as u32;
    if java.major > recommended {
        log(&app, &state, "warn", format!("此游戏版本建议 Java {recommended}，正在使用 Java {}；若旧版依赖报错，请改用匹配的运行时", java.major));
    }
    fs::create_dir_all(&game_dir).map_err(|e| e.to_string())?;
    let natives = safe_join(
        &root,
        &format!("versions/{id}/natives/run-{}", uuid::Uuid::new_v4()),
    )?;
    extract_natives(&metadata, &root, &natives)?;
    let game_assets = materialize_legacy_assets(&metadata, &root, &game_dir)?;
    let classpath = build_classpath(&metadata, &root, &id)?;
    let assets = safe_join(&root, "assets")?;
    let libraries = safe_join(&root, "libraries")?;
    // Refresh after dependency downloads, immediately before constructing game arguments.
    let credentials = if account.account_type != "offline" {
        let auth = app
            .try_state::<Arc<crate::auth::AuthService>>()
            .ok_or("认证服务未初始化")?;
        Some(auth.game_credentials(&account.id).await?)
    } else {
        None
    };
    let username = credentials
        .as_ref()
        .map(|c| c.username.as_str())
        .unwrap_or(&account.username);
    let player_uuid = credentials
        .as_ref()
        .map(|c| c.uuid.as_str())
        .unwrap_or(&account.uuid);
    let access_token = credentials
        .as_ref()
        .map(|c| c.access_token.as_str())
        .unwrap_or("0");
    let client_id = credentials
        .as_ref()
        .and_then(|c| c.client_id.as_deref())
        .unwrap_or("");
    let xuid = credentials
        .as_ref()
        .and_then(|c| c.xuid.as_deref())
        .unwrap_or("");
    let variables: HashMap<String, String> = [
        ("auth_player_name", username),
        ("auth_uuid", player_uuid),
        ("auth_access_token", access_token),
        ("auth_session", access_token),
        (
            "user_type",
            if credentials.is_some() {
                "mojang"
            } else {
                "legacy"
            },
        ),
        ("version_name", id.as_str()),
        (
            "version_type",
            metadata["type"].as_str().unwrap_or("release"),
        ),
        (
            "assets_index_name",
            metadata["assetIndex"]["id"].as_str().unwrap_or("legacy"),
        ),
        ("user_properties", "{}"),
        ("clientid", client_id),
        ("auth_xuid", xuid),
        ("launcher_name", "VoxelightLauncher"),
        ("launcher_version", env!("CARGO_PKG_VERSION")),
        ("classpath_separator", ";"),
        ("classpath", classpath.as_str()),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .chain([
        (
            "game_directory".into(),
            game_dir.to_string_lossy().into_owned(),
        ),
        ("assets_root".into(), assets.to_string_lossy().into_owned()),
        (
            "game_assets".into(),
            game_assets.to_string_lossy().into_owned(),
        ),
        (
            "natives_directory".into(),
            natives.to_string_lossy().into_owned(),
        ),
        (
            "library_directory".into(),
            libraries.to_string_lossy().into_owned(),
        ),
    ])
    .collect();
    let mut arguments = vec![
        format!("-Xmx{}M", config.max_memory_mb.clamp(512, 65536)),
        "-Dfile.encoding=UTF-8".into(),
    ];
    let custom = shell_words::split(&config.jvm_arguments)
        .map_err(|e| format!("自定义 JVM 参数引号不匹配：{e}"))?;
    for argument in &custom {
        if argument.starts_with("-Xmx") || argument.starts_with("-Xms") {
            continue;
        }
        if !argument.starts_with('-')
            || matches!(
                argument.as_str(),
                "-jar"
                    | "-cp"
                    | "-classpath"
                    | "--class-path"
                    | "--module-path"
                    | "-p"
                    | "--module"
                    | "-m"
            )
            || argument.starts_with('@')
        {
            return Err("自定义 JVM 参数不能覆盖主类、classpath 或响应文件".into());
        }
        arguments.push(argument.clone());
    }
    if !custom
        .iter()
        .any(|argument| argument.starts_with("-Djava.io.tmpdir="))
    {
        arguments.push(format!(
            "-Djava.io.tmpdir={}",
            crate::storage::runtime_temp_directory(&game_dir)?.display()
        ));
    }
    if let Some(values) = metadata["arguments"].get("jvm") {
        arguments.extend(read_arguments(values, &variables)?);
    } else {
        arguments.extend([
            format!("-Djava.library.path={}", natives.display()),
            "-cp".into(),
            classpath,
        ]);
    }
    // Log4j config is part of official metadata and must be verified before passing to Java.
    if let Some(file) = metadata["logging"]["client"].get("file") {
        let file_id = file["id"].as_str().ok_or("日志配置缺少文件名")?;
        validate_id(file_id)?;
        let download = download_from(file, &root, Some(&format!("assets/log_configs/{file_id}")))?;
        ensure_download_with_source_and_control(
            &state.client,
            &download,
            &config.download_source,
            Some(&state.control),
        )
        .await?;
        let template = metadata["logging"]["client"]["argument"]
            .as_str()
            .ok_or("日志配置参数缺失")?;
        arguments.push(template.replace("${path}", &download.path.to_string_lossy()));
    }
    if let Some(server) = credentials
        .as_ref()
        .and_then(|c| c.authlib_server.as_deref())
    {
        let injector = crate::loaders::authlib_injector(&state).await?;
        arguments.push(format!("-javaagent:{}={server}", injector.display()));
        arguments.push("-Dauthlibinjector.side=client".into());
    }
    let jvm_argument_count = arguments.len();
    arguments.push(metadata["mainClass"].as_str().ok_or("启动主类缺失")?.into());
    if let Some(legacy) = metadata["_launcherLegacyGameArguments"].as_str() {
        for argument in shell_words::split(legacy).map_err(|e| e.to_string())? {
            arguments.push(expand(&argument, &variables)?);
        }
    } else if let Some(values) = metadata["arguments"].get("game") {
        arguments.extend(read_arguments(values, &variables)?);
    } else {
        let legacy = metadata["minecraftArguments"]
            .as_str()
            .ok_or("版本不含游戏启动参数")?;
        for argument in shell_words::split(legacy).map_err(|e| e.to_string())? {
            arguments.push(expand(&argument, &variables)?);
        }
    }
    arguments.extend([
        "--width".into(),
        config.screen_width.clamp(320, 16384).to_string(),
        "--height".into(),
        config.screen_height.clamp(240, 16384).to_string(),
    ]);
    if let Some(address) = server_address.as_deref() {
        append_direct_connect(&mut arguments, &metadata, address)?;
    }
    let mut command = tokio::process::Command::new(&java.path);
    if java.major >= 9 {
        // Java's response file avoids Windows' 32 KiB process command-line limit.
        let argument_file = safe_join(
            &root,
            &format!("versions/{id}/.launcher-{}.args", uuid::Uuid::new_v4()),
        )?;
        let content = arguments[..jvm_argument_count]
            .iter()
            .map(|arg| format!("\"{}\"", arg.replace('\\', "\\\\").replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&argument_file, content).map_err(|e| format!("写入 Java 参数文件失败：{e}"))?;
        command.arg(format!("@{}", argument_file.display()));
        command.args(&arguments[jvm_argument_count..]);
    } else {
        command.args(&arguments);
    }
    command
        .current_dir(&game_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    state.control.checkpoint().await?;
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 Java 失败：{e}"))?;
    let pid = child.id().ok_or("Java 进程未提供 PID")?;
    crate::processes::register(&app, pid, &id, instance_id.clone(), &game_dir);
    log(
        &app,
        &state,
        "info",
        format!(
            "已启动 {id}，Java {}，PID {pid}，游戏目录 {}",
            java.version,
            game_dir.display()
        ),
    );
    if let Some(instance_id) = instance_id {
        if let Err(error) = state.update(|data| {
            if let Some(instance) = data.instances.iter_mut().find(|i| i.id == instance_id) {
                instance.last_played = Some(chrono::Utc::now().to_rfc3339());
            }
            Ok(())
        }) {
            log(
                &app,
                &state,
                "warn",
                format!("游戏已启动，但最近游玩时间保存失败：{error}"),
            );
        }
    }
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        let state = state.clone();
        let sensitive = access_token.to_owned();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout);
            while let Ok(Some(line)) = next_process_line(&mut lines).await {
                let line = if sensitive.len() > 8 {
                    line.replace(&sensitive, "[已隐藏]")
                } else {
                    line
                };
                log(&app, &state, "game", line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        let state = state.clone();
        let sensitive = access_token.to_owned();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr);
            while let Ok(Some(line)) = next_process_line(&mut lines).await {
                let line = if sensitive.len() > 8 {
                    line.replace(&sensitive, "[已隐藏]")
                } else {
                    line
                };
                log(&app, &state, "warn", line);
            }
        });
    }
    let app_for_exit = app.clone();
    let state_for_exit = state.clone();
    tauri::async_runtime::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                crate::processes::unregister(&app_for_exit, &state_for_exit, pid, status.code());
                log(
                    &app_for_exit,
                    &state_for_exit,
                    if status.success() { "info" } else { "error" },
                    format!("Minecraft PID {pid} 已退出，退出码 {:?}", status.code()),
                );
                let _ = app_for_exit.emit(
                    "launcher://game-exit",
                    json!({"pid":pid,"code":status.code()}),
                );
            }
            Err(error) => log(
                &app_for_exit,
                &state_for_exit,
                "error",
                format!("无法读取游戏退出状态：{error}"),
            ),
        }
    });
    Ok(LaunchResult {
        pid,
        version_id: id,
        game_directory: game_dir.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestServer {
        address: String,
        requests: Arc<std::sync::Mutex<Vec<String>>>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn new(routes: &[(&str, u16, &[u8])]) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap().to_string();
            listener.set_nonblocking(true).unwrap();
            let routes = Arc::new(std::sync::Mutex::new(
                routes
                    .iter()
                    .map(|(path, status, body)| ((*path).to_owned(), (*status, body.to_vec())))
                    .collect::<HashMap<_, _>>(),
            ));
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let thread = {
                let routes = routes.clone();
                let requests = requests.clone();
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        match listener.accept() {
                            Ok((mut stream, _)) => {
                                stream.set_nonblocking(false).unwrap();
                                stream
                                    .set_read_timeout(Some(Duration::from_secs(2)))
                                    .unwrap();
                                let mut request = Vec::new();
                                let mut buffer = [0u8; 2048];
                                while request.len() < 16 * 1024
                                    && !request.windows(4).any(|bytes| bytes == b"\r\n\r\n")
                                {
                                    match std::io::Read::read(&mut stream, &mut buffer) {
                                        Ok(0) | Err(_) => break,
                                        Ok(count) => request.extend_from_slice(&buffer[..count]),
                                    }
                                }
                                let request = String::from_utf8_lossy(&request);
                                let target = request
                                    .lines()
                                    .next()
                                    .and_then(|line| line.split_whitespace().nth(1))
                                    .unwrap_or("/")
                                    .to_owned();
                                requests.lock().unwrap().push(target.clone());
                                let (status, body) = routes
                                    .lock()
                                    .unwrap()
                                    .get(&target)
                                    .cloned()
                                    .unwrap_or((404, b"not found".to_vec()));
                                let reason = if status == 200 { "OK" } else { "Error" };
                                let header = format!(
                                    "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                );
                                std::io::Write::write_all(&mut stream, header.as_bytes()).unwrap();
                                std::io::Write::write_all(&mut stream, &body).unwrap();
                                std::io::Write::flush(&mut stream).unwrap();
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(2));
                            }
                            Err(_) => break,
                        }
                    }
                })
            };
            Self {
                address,
                requests,
                stop,
                thread: Some(thread),
            }
        }

        fn resolve(address: &str, url: &str) -> String {
            let parsed = reqwest::Url::parse(url).unwrap();
            let query = parsed
                .query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default();
            format!(
                "http://{address}/{}{}{query}",
                parsed.host_str().unwrap(),
                parsed.path()
            )
        }

        fn resolver(&self) -> impl Fn(&str) -> String + '_ {
            |url| Self::resolve(&self.address, url)
        }

        fn requests(&self) -> Vec<String> {
            self.requests.lock().unwrap().clone()
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }

    fn source_test_state(directory: &Path) -> LauncherState {
        fs::create_dir_all(directory).unwrap();
        LauncherState {
            data: std::sync::Mutex::new(Persisted {
                config: Config {
                    game_directory: directory.join("game").to_string_lossy().into_owned(),
                    ..Config::default()
                },
                ..Persisted::default()
            }),
            data_dir: directory.to_path_buf(),
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            operation: tokio::sync::Mutex::new(()),
            control: Default::default(),
            games: Default::default(),
        }
    }

    fn source_test_directory(label: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/core-tests")
            .join(format!("{label}-{}", uuid::Uuid::new_v4()))
    }

    fn manifest_fixture(versions: Vec<Value>) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "latest": {"release": "source-test", "snapshot": "source-test"},
            "versions": versions,
        }))
        .unwrap()
    }

    #[test]
    fn launch_preparation_restarts_after_cancellation_and_finishes_failures() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("launch-task");
            let state = source_test_state(&directory);
            let root = PathBuf::from(state.snapshot().unwrap().config.game_directory);
            let version = root.join("versions/source-test");
            fs::create_dir_all(&version).unwrap();
            let client = b"verified cached client";
            let metadata = serde_json::to_vec(&json!({
                "id": "source-test", "mainClass": "net.minecraft.client.main.Main", "libraries": [],
                "downloads": {"client": {
                    "url": "https://piston-data.mojang.com/v1/objects/fixture/client.jar",
                    "sha1": format!("{:x}", Sha1::digest(client)), "size": client.len(),
                }}
            })).unwrap();
            fs::write(version.join("source-test.json"), &metadata).unwrap();
            fs::write(version.join("source-test.jar"), client).unwrap();
            cache_manifest(&state, &manifest_fixture(vec![json!({
                "id": "source-test", "url": "https://piston-meta.mojang.com/v1/packages/source-test.json",
                "sha1": format!("{:x}", Sha1::digest(&metadata)),
            })]), false).await;
            let cancelled = state.control.begin("install", "old", "Old");
            state.control.cancel(Some(&cancelled));
            state.control.finish(&cancelled, Some("cancelled"));
            for fail in [false, true, false] {
                let shared = &state;
                let result = with_launch_preparation(&state, "source-test", None, |snapshot| async move {
                    shared.control.checkpoint().await?;
                    let root = Path::new(&snapshot.config.game_directory);
                    let metadata = resolve_metadata_with_source(shared, "source-test", root, &snapshot.config.download_source).await?;
                    let download = download_from(&metadata["downloads"]["client"], root,
                        Some("versions/source-test/source-test.jar"))?;
                    assert!(!ensure_download_with_source_and_control(&shared.client, &download,
                        &snapshot.config.download_source, Some(&shared.control)).await?);
                    assert!(build_classpath(&metadata, root, "source-test")?.contains("source-test.jar"));
                    if fail { Err("preparation failed".to_owned()) } else { Ok(()) }
                }).await;
                assert_eq!(result.is_err(), fail);
                assert!(state.operation.try_lock().is_ok());
            }
            let jobs = state.control.list();
            assert_eq!(jobs.iter().map(|job| job.status.as_str()).collect::<Vec<_>>(),
                ["cancelled", "completed", "failed", "completed"]);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn waiting_launch_uses_latest_snapshot_and_rejects_removed_instances() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("launch-snapshot");
            let state = source_test_state(&directory);
            state.data.lock().unwrap().instances.push(Instance {
                id: "instance".into(),
                version_id: "source-test".into(),
                ..Default::default()
            });
            let guard = state.operation.lock().await;
            let request =
                with_launch_preparation(&state, "source-test", None, |snapshot| async move {
                    Ok(snapshot.config.game_directory)
                });
            tokio::pin!(request);
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut request)
                    .await
                    .is_err()
            );
            let new_root = directory.join("new-game").to_string_lossy().into_owned();
            state.data.lock().unwrap().config.game_directory = new_root.clone();
            drop(guard);
            assert_eq!(request.await.unwrap(), new_root);

            let guard = state.operation.lock().await;
            let request =
                with_launch_preparation(&state, "source-test", Some("instance"), |_| async {
                    Ok(())
                });
            tokio::pin!(request);
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut request)
                    .await
                    .is_err()
            );
            state.data.lock().unwrap().instances.clear();
            drop(guard);
            assert!(request.await.unwrap_err().contains("实例不存在"));
            assert_eq!(state.control.list().len(), 1);
            assert!(state.operation.try_lock().is_ok());
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn bmclapi_mapping_uses_exact_hosts_paths_and_queries() {
        for host in [
            "piston-meta.mojang.com",
            "piston-data.mojang.com",
            "launchermeta.mojang.com",
            "launcher.mojang.com",
        ] {
            assert_eq!(
                mapped_bmclapi_url(&format!("https://{host}/v1/packages/item.json?x=1&y=two"))
                    .unwrap(),
                "https://bmclapi2.bangbang93.com/v1/packages/item.json?x=1&y=two"
            );
        }
        let hash = "0123456789abcdef0123456789abcdef01234567";
        assert_eq!(
            mapped_bmclapi_url(&format!(
                "https://resources.download.minecraft.net/01/{hash}"
            ))
            .unwrap(),
            format!("https://bmclapi2.bangbang93.com/assets/01/{hash}")
        );
        assert_eq!(
            mapped_bmclapi_url(
                "https://libraries.minecraft.net/com/example/library/1.0/library-1.0.jar"
            )
            .unwrap(),
            "https://bmclapi2.bangbang93.com/libraries/com/example/library/1.0/library-1.0.jar"
        );
    }

    #[test]
    fn bmclapi_mapping_rejects_unsafe_or_unsupported_urls() {
        for url in [
            "not a url",
            "http://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
            "https://piston-meta.mojang.com:444/mc/game/version_manifest_v2.json",
            "https://user:p%40ss@piston-meta.mojang.com/mc/game/version_manifest_v2.json",
            "https://piston-meta.mojang.com.evil.example/mc/game/version_manifest_v2.json",
            "https://maven.fabricmc.net/example/library.jar",
            "https://resources.download.minecraft.net/not-an-object",
            "https://resources.download.minecraft.net/01/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "https://libraries.minecraft.net/",
        ] {
            assert!(mapped_bmclapi_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn download_candidates_follow_source_order_without_inventing_maven_mirrors() {
        let official = "https://piston-data.mojang.com/v1/objects/hash/client.jar";
        let mirror = "https://bmclapi2.bangbang93.com/v1/objects/hash/client.jar";
        let urls = |source| {
            download_url_candidates(official, source)
                .unwrap()
                .into_iter()
                .map(|candidate| candidate.url)
                .collect::<Vec<_>>()
        };
        assert_eq!(urls("official"), vec![official]);
        assert_eq!(urls("auto"), vec![official, mirror]);
        assert_eq!(urls("bmclapi"), vec![mirror, official]);
        assert!(download_url_candidates(official, "unknown").is_err());
        assert!(download_url_candidates(mirror, "official").is_err());

        let maven = "https://maven.fabricmc.net/example/library.jar";
        for source in ["official", "auto", "bmclapi"] {
            let candidates = download_url_candidates(maven, source).unwrap();
            assert_eq!(candidates.len(), 1);
            assert_eq!(candidates[0].url, maven);
            assert!(!candidates[0].mirror);
        }
    }

    #[test]
    fn mirror_file_redirects_require_https_443_and_no_credentials() {
        assert!(validate_mirror_file_redirect("https://bmclapi2.bangbang93.com/file").is_ok());
        assert!(validate_mirror_file_redirect("https://cdn.example/file").is_ok());
        for url in [
            "http://cdn.example/file",
            "https://cdn.example:444/file",
            "https://user@cdn.example/file",
            "https://cdn.example/file#fragment",
        ] {
            assert!(validate_mirror_file_redirect(url).is_err(), "{url}");
        }
    }

    #[test]
    fn manifest_schema_preserves_official_entry_urls() {
        let official = parse_json(&manifest_fixture(vec![json!({
            "id": "source-test",
            "url": "https://piston-meta.mojang.com/v1/packages/source-test.json",
            "sha1": "0123456789abcdef0123456789abcdef01234567",
        })]))
        .unwrap();
        assert!(validate_manifest(&official).is_ok());
        let mirrored = parse_json(&manifest_fixture(vec![json!({
            "id": "source-test",
            "url": "https://bmclapi2.bangbang93.com/v1/packages/source-test.json",
            "sha1": "0123456789abcdef0123456789abcdef01234567",
        })]))
        .unwrap();
        assert!(validate_manifest(&mirrored).is_err());
    }

    #[test]
    fn official_source_rebuilds_a_mirror_cache_chain_then_works_offline() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("source-switch");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let official = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","libraries":[],"type":"release"}"#;
            let mirror = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","libraries":[],"type":"snapshot"}"#;
            let manifest = |bytes: &[u8]| manifest_fixture(vec![json!({
                "id": "source-test", "url": "https://piston-meta.mojang.com/v1/packages/source-test.json",
                "sha1": format!("{:x}", Sha1::digest(bytes)),
            })]);
            let mirror_manifest = manifest(mirror);
            let server = TestServer::new(&[
                ("/bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json", 200, &mirror_manifest),
                ("/bmclapi2.bangbang93.com/v1/packages/source-test.json", 200, mirror),
            ]);
            official_metadata_with_resolver(&state, "source-test", &root, "bmclapi", &server.resolver()).await.unwrap();
            let address = server.address.clone();
            drop(server);
            let offline = |url: &str| TestServer::resolve(&address, url);
            for source in ["auto", "bmclapi"] {
                assert_eq!(official_metadata_with_resolver(&state, "source-test", &root, source, &offline)
                    .await.unwrap()["type"], "snapshot");
            }
            assert!(official_metadata_with_resolver(&state, "source-test", &root, "official", &offline).await.is_err());
            assert!(manifest_with_resolver(&state, "official", &offline).await.is_err());
            let official_manifest = manifest(official);
            let server = TestServer::new(&[
                ("/piston-meta.mojang.com/mc/game/version_manifest_v2.json", 200, &official_manifest),
                ("/piston-meta.mojang.com/v1/packages/source-test.json", 200, official),
            ]);
            assert_eq!(official_metadata_with_resolver(&state, "source-test", &root, "official", &server.resolver())
                .await.unwrap()["type"], "release");
            assert_eq!(server.requests().len(), 2);
            let address = server.address.clone();
            drop(server);
            let offline = |url: &str| TestServer::resolve(&address, url);
            assert_eq!(official_metadata_with_resolver(&state, "source-test", &root, "official", &offline)
                .await.unwrap()["type"], "release");
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn legacy_manifest_cache_has_unknown_origin_and_requires_official_revalidation() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("legacy-cache");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let metadata = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#;
            let manifest = manifest_fixture(vec![json!({
                "id": "source-test", "url": "https://piston-meta.mojang.com/v1/packages/source-test.json",
                "sha1": format!("{:x}", Sha1::digest(metadata)),
            })]);
            fs::create_dir_all(root.join("versions/source-test")).unwrap();
            fs::write(root.join("versions/source-test/source-test.json"), metadata).unwrap();
            fs::write(state.data_dir.join("official-version-manifest.json"), manifest).unwrap();
            let server = TestServer::new(&[]);
            let address = server.address.clone();
            drop(server);
            let offline = |url: &str| TestServer::resolve(&address, url);
            for source in ["auto", "bmclapi"] {
                official_metadata_with_resolver(&state, "source-test", &root, source, &offline).await.unwrap();
                manifest_with_resolver(&state, source, &offline).await.unwrap();
            }
            assert!(official_metadata_with_resolver(&state, "source-test", &root, "official", &offline).await.is_err());
            assert!(manifest_with_resolver(&state, "official", &offline).await.is_err());
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn manifest_bad_json_falls_back_and_valid_cache_works_offline() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("manifest-cache");
            let state = source_test_state(&directory);
            let metadata_url = "https://piston-meta.mojang.com/v1/packages/source-test.json";
            let manifest = manifest_fixture(vec![json!({
                "id": "source-test",
                "url": metadata_url,
                "sha1": "0123456789abcdef0123456789abcdef01234567",
            })]);
            let server = TestServer::new(&[
                (
                    "/piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                    200,
                    b"{not json",
                ),
                (
                    "/bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
                    200,
                    &manifest,
                ),
            ]);
            let resolver = server.resolver();
            let value = manifest_with_resolver(&state, "auto", &resolver)
                .await
                .unwrap();
            assert_eq!(value["versions"][0]["url"], metadata_url);
            assert_eq!(
                server.requests(),
                vec![
                    "/piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                    "/bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
                ]
            );
            assert_eq!(
                fs::read(state.data_dir.join("version-manifest-bmclapi.json")).unwrap(),
                manifest
            );
            let address = server.address.clone();
            drop(resolver);
            drop(server);
            let offline_resolver = |url: &str| TestServer::resolve(&address, url);
            let cached = manifest_with_resolver(&state, "auto", &offline_resolver)
                .await
                .unwrap();
            assert_eq!(cached["versions"][0]["url"], metadata_url);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn official_metadata_hash_failure_falls_back_without_changing_expected_hash() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("metadata-hash");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let metadata = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#;
            let metadata_url = "https://piston-meta.mojang.com/v1/packages/source-test.json";
            let manifest = manifest_fixture(vec![json!({
                "id": "source-test",
                "url": metadata_url,
                "sha1": format!("{:x}", Sha1::digest(metadata)),
            })]);
            let server = TestServer::new(&[
                (
                    "/piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                    200,
                    &manifest,
                ),
                (
                    "/piston-meta.mojang.com/v1/packages/source-test.json",
                    200,
                    br#"{"id":"wrong","mainClass":"net.minecraft.client.main.Main"}"#,
                ),
                (
                    "/bmclapi2.bangbang93.com/v1/packages/source-test.json",
                    200,
                    metadata,
                ),
            ]);
            let resolver = server.resolver();
            let resolved = official_metadata_with_resolver(
                &state,
                "source-test",
                &root,
                "auto",
                &resolver,
            )
            .await
            .unwrap();
            assert_eq!(resolved["id"], "source-test");
            assert_eq!(
                server.requests(),
                vec![
                    "/piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                    "/piston-meta.mojang.com/v1/packages/source-test.json",
                    "/bmclapi2.bangbang93.com/v1/packages/source-test.json",
                ]
            );
            assert_eq!(
                fs::read(root.join("versions/source-test/source-test.json")).unwrap(),
                metadata
            );
            drop(resolver);
            drop(server);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn official_metadata_missing_version_uses_next_manifest_candidate() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("metadata-missing");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let metadata = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#;
            let metadata_url = "https://piston-meta.mojang.com/v1/packages/source-test.json";
            let present = manifest_fixture(vec![json!({
                "id": "source-test",
                "url": metadata_url,
                "sha1": format!("{:x}", Sha1::digest(metadata)),
            })]);
            let missing = manifest_fixture(vec![]);
            let server = TestServer::new(&[
                (
                    "/piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                    200,
                    &missing,
                ),
                (
                    "/bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
                    200,
                    &present,
                ),
                (
                    "/piston-meta.mojang.com/v1/packages/source-test.json",
                    200,
                    metadata,
                ),
            ]);
            let resolver = server.resolver();
            official_metadata_with_resolver(&state, "source-test", &root, "auto", &resolver)
                .await
                .unwrap();
            assert_eq!(
                server.requests(),
                vec![
                    "/piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                    "/bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
                    "/piston-meta.mojang.com/v1/packages/source-test.json",
                ]
            );
            drop(resolver);
            drop(server);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn metadata_candidates_never_borrow_a_hash_from_another_manifest_chain() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("metadata-chain");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let metadata = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#;
            let metadata_url = "https://piston-meta.mojang.com/v1/packages/source-test.json";
            let wrong = manifest_fixture(vec![json!({
                "id": "source-test",
                "url": metadata_url,
                "sha1": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            })]);
            let correct = manifest_fixture(vec![json!({
                "id": "source-test",
                "url": metadata_url,
                "sha1": format!("{:x}", Sha1::digest(metadata)),
            })]);
            let server = TestServer::new(&[
                (
                    "/piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                    200,
                    &wrong,
                ),
                (
                    "/bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
                    200,
                    &correct,
                ),
                (
                    "/piston-meta.mojang.com/v1/packages/source-test.json",
                    200,
                    metadata,
                ),
                (
                    "/bmclapi2.bangbang93.com/v1/packages/source-test.json",
                    200,
                    metadata,
                ),
            ]);
            let resolver = server.resolver();
            official_metadata_with_resolver(&state, "source-test", &root, "auto", &resolver)
                .await
                .unwrap();
            assert_eq!(
                server.requests(),
                vec![
                    "/piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                    "/piston-meta.mojang.com/v1/packages/source-test.json",
                    "/bmclapi2.bangbang93.com/v1/packages/source-test.json",
                    "/bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
                    "/piston-meta.mojang.com/v1/packages/source-test.json",
                ]
            );
            drop(resolver);
            drop(server);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn file_candidates_verify_before_commit_and_reuse_valid_cache() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("file-cache");
            fs::create_dir_all(&directory).unwrap();
            let state = source_test_state(&directory.join("data"));
            let good = b"right!";
            let wrong = b"wrong!";
            let server = TestServer::new(&[
                ("/libraries.minecraft.net/fixtures/client.jar", 200, wrong),
                (
                    "/bmclapi2.bangbang93.com/libraries/fixtures/client.jar",
                    200,
                    good,
                ),
                ("/libraries.minecraft.net/fixtures/rejected.jar", 200, wrong),
                (
                    "/bmclapi2.bangbang93.com/libraries/fixtures/rejected.jar",
                    200,
                    wrong,
                ),
            ]);
            let resolver = server.resolver();
            let file = Download {
                path: directory.join("client.jar"),
                url: "https://libraries.minecraft.net/fixtures/client.jar".into(),
                sha1: format!("{:x}", Sha1::digest(good)),
                size: Some(6),
            };
            assert!(ensure_download_with_source_and_control_resolved(
                &state.client,
                &file,
                "auto",
                None,
                &resolver,
            )
            .await
            .unwrap());
            assert_eq!(fs::read(&file.path).unwrap(), good);
            assert!(!ensure_download_with_source_and_control_resolved(
                &state.client,
                &file,
                "auto",
                None,
                &resolver,
            )
            .await
            .unwrap());
            assert_eq!(server.requests().len(), 2);

            let rejected = Download {
                path: directory.join("rejected.jar"),
                url: "https://libraries.minecraft.net/fixtures/rejected.jar".into(),
                sha1: file.sha1.clone(),
                size: Some(6),
            };
            fs::write(&rejected.path, b"old!!!").unwrap();
            assert!(ensure_download_with_source_and_control_resolved(
                &state.client,
                &rejected,
                "bmclapi",
                None,
                &resolver,
            )
            .await
            .is_err());
            assert_eq!(fs::read(&rejected.path).unwrap(), b"old!!!");
            assert_eq!(
                server.requests(),
                vec![
                    "/libraries.minecraft.net/fixtures/client.jar",
                    "/bmclapi2.bangbang93.com/libraries/fixtures/client.jar",
                    "/bmclapi2.bangbang93.com/libraries/fixtures/rejected.jar",
                    "/libraries.minecraft.net/fixtures/rejected.jar",
                ]
            );
            let unhashed = Download {
                path: directory.join("unhashed.jar"),
                sha1: "invalid".into(),
                ..rejected
            };
            assert!(ensure_download_with_source_and_control_resolved(
                &state.client,
                &unhashed,
                "bmclapi",
                None,
                &resolver,
            )
            .await
            .is_err());
            assert_eq!(server.requests().len(), 4);
            drop(resolver);
            drop(server);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn mojang_rules_follow_last_matching_action_and_feature_flags() {
        assert!(rules_allow(None));
        assert!(!rules_allow(Some(
            &json!([{ "action":"allow", "os":{"name":"linux"} }])
        )));
        assert!(rules_allow(Some(
            &json!([{ "action":"allow" }, {"action":"disallow", "os":{"name":"osx"}}])
        )));
        assert!(!rules_allow(Some(
            &json!([{ "action":"allow", "features":{"is_demo_user":true} }])
        )));
        assert!(rules_allow(Some(
            &json!([{ "action":"allow", "features":{"is_demo_user":false} }])
        )));
    }
    #[test]
    fn maven_coordinates_and_java_versions_are_parsed() {
        assert_eq!(
            maven_path("org.lwjgl:lwjgl:3.3.3:natives-windows").unwrap(),
            "org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar"
        );
        assert_eq!(java_major("1.8.0_451"), Some(8));
        assert_eq!(java_major("21.0.8+9-LTS"), Some(21));
        assert!(maven_path("../../bad:name:1.0").is_err());
    }
    #[test]
    fn arguments_preserve_spaces_as_single_process_argument() {
        let vars = HashMap::from([(
            "game_directory".into(),
            "C:\\Games\\Minecraft Worlds".into(),
        )]);
        let args = read_arguments(&json!(["--gameDir", "${game_directory}"]), &vars).unwrap();
        assert_eq!(args, vec!["--gameDir", "C:\\Games\\Minecraft Worlds"]);
        assert!(read_arguments(&json!(["${unknown}"]), &vars).is_err());
    }

    #[test]
    fn child_loader_libraries_override_versions_but_preserve_native_classifiers_and_base_client() {
        let parent = json!({"id":"1.21.1","mainClass":"net.minecraft.client.main.Main","libraries":[{"name":"org.ow2.asm:asm:9.2"},{"name":"org.lwjgl:lwjgl:3.3.3:natives-windows"}],"downloads":{"client":{"sha1":"official"}},"arguments":{"game":["--username","${auth_player_name}"],"jvm":["-cp","${classpath}"]}});
        let child = json!({"id":"fabric-test","inheritsFrom":"1.21.1","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":"org.ow2.asm:asm:9.10.1"}],"downloads":{"client":{"sha1":"untrusted-override"}},"arguments":{"jvm":["-Dloader=true"],"game":["--extra"]}});
        let merged = merge_metadata(&parent, &child).unwrap();
        assert_eq!(merged["downloads"]["client"]["sha1"], "official");
        assert_eq!(
            merged["mainClass"],
            "net.fabricmc.loader.impl.launch.knot.KnotClient"
        );
        assert_eq!(merged["libraries"].as_array().unwrap().len(), 2);
        assert_eq!(merged["libraries"][0]["name"], "org.ow2.asm:asm:9.10.1");
        assert_eq!(
            merged["libraries"][1]["name"],
            "org.lwjgl:lwjgl:3.3.3:natives-windows"
        );
        assert_eq!(merged["arguments"]["jvm"].as_array().unwrap().len(), 3);
        assert_eq!(merged["arguments"]["game"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn legacy_forge_game_arguments_override_modern_parent_without_dropping_parent_jvm_arguments() {
        let parent = json!({"id":"base","arguments":{"game":["--username","${auth_player_name}"],"jvm":["-cp","${classpath}"]},"libraries":[]});
        let child = json!({"id":"forge-old","minecraftArguments":"--username ${auth_player_name} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker","libraries":[]});
        let merged = merge_metadata(&parent, &child).unwrap();
        assert!(merged["_launcherLegacyGameArguments"]
            .as_str()
            .unwrap()
            .contains("FMLTweaker"));
        assert_eq!(merged["arguments"]["jvm"], parent["arguments"]["jvm"]);
    }

    #[test]
    fn recursive_inheritance_rejects_cycles_and_uses_official_base_jar() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/core-tests")
            .join(format!("inheritance-{}", uuid::Uuid::new_v4()));
        for (id, value) in [
            (
                "base",
                json!({"id":"base","mainClass":"net.minecraft.client.main.Main","libraries":[]}),
            ),
            (
                "loader",
                json!({"id":"loader","inheritsFrom":"base","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[]}),
            ),
            (
                "custom",
                json!({"id":"custom","inheritsFrom":"loader","libraries":[]}),
            ),
        ] {
            let path = safe_join(&root, &format!("versions/{id}/{id}.json")).unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        let resolved = resolve_local_metadata(&root, "custom").unwrap();
        assert_eq!(resolved["_launcherClientId"], "base");
        assert_eq!(
            resolved["mainClass"],
            "net.fabricmc.loader.impl.launch.knot.KnotClient"
        );
        let path = safe_join(&root, "versions/base/base.json").unwrap();
        fs::write(path, br#"{"id":"base","inheritsFrom":"custom"}"#).unwrap();
        assert!(resolve_local_metadata(&root, "custom")
            .unwrap_err()
            .contains("循环"));
    }

    #[test]
    fn direct_connect_uses_quickplay_when_available_and_keeps_process_arguments_separate() {
        let mut args = Vec::new();
        append_direct_connect(&mut args, &json!({}), "play.example.com:25566").unwrap();
        assert_eq!(
            args,
            vec!["--server", "play.example.com", "--port", "25566"]
        );
        let metadata = json!({"arguments":{"game":[{"rules":[{"features":{"is_quick_play_multiplayer":true}}],"value":["--quickPlayMultiplayer","${quickPlayMultiplayer}"]}]}});
        let mut args = Vec::new();
        append_direct_connect(&mut args, &metadata, "[::1]:25565").unwrap();
        assert_eq!(args, vec!["--quickPlayMultiplayer", "[::1]:25565"]);
        for bad in [
            "host:0",
            "host\n--token",
            "--server",
            "https://host",
            "host:99999",
        ] {
            assert!(server_parts(bad).is_err());
        }
    }

    #[test]
    fn resource_validation_detects_same_length_corruption() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/core-tests")
                .join(format!("integrity-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&directory).unwrap();
            let path = directory.join("fixture.bin");
            fs::write(&path, b"trusted payload").unwrap();
            let file = Download {
                path: path.clone(),
                url: "https://libraries.minecraft.net/fixture.bin".into(),
                sha1: format!("{:x}", Sha1::digest(b"trusted payload")),
                size: Some(15),
            };
            assert!(file_valid(&file).await.unwrap());
            fs::write(&path, b"changed payload").unwrap();
            assert!(!file_valid(&file).await.unwrap());
            fs::remove_file(path).unwrap();
            fs::remove_dir(directory).unwrap();
        });
    }

    #[test]
    fn explicit_instances_and_version_isolation_use_different_game_directories() {
        let base = std::env::temp_dir().join("launcher-isolation-test");
        let mut config = Config {
            game_directory: base.to_string_lossy().into_owned(),
            ..Config::default()
        };
        assert_eq!(
            game_directory(&config, "1.21.1", None).unwrap(),
            base.join("versions/1.21.1")
        );
        config.version_isolation = false;
        assert_eq!(game_directory(&config, "1.21.1", None).unwrap(), base);
        let instance = Instance {
            id: "id".into(),
            name: "test".into(),
            version_id: "1.21.1".into(),
            game_directory: base.join("instances/test").to_string_lossy().into_owned(),
            ..Instance::default()
        };
        assert_eq!(
            game_directory(&config, "1.21.1", Some(&instance)).unwrap(),
            base.join("instances/test")
        );
        assert!(game_directory(&config, "1.20.1", Some(&instance)).is_err());
    }

    #[test]
    fn non_utf8_process_output_does_not_abort_log_collection() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let bytes = b"normal\r\ninvalid-\xff-log\nlast";
            let mut reader = BufReader::new(&bytes[..]);
            assert_eq!(
                next_process_line(&mut reader).await.unwrap().as_deref(),
                Some("normal")
            );
            assert_eq!(
                next_process_line(&mut reader).await.unwrap().as_deref(),
                Some("invalid-\u{fffd}-log")
            );
            assert_eq!(
                next_process_line(&mut reader).await.unwrap().as_deref(),
                Some("last")
            );
            assert_eq!(next_process_line(&mut reader).await.unwrap(), None);
        });
    }

    #[test]
    #[ignore = "Downloads official metadata and a client JAR; run explicitly for network smoke testing"]
    fn official_metadata_schema_and_real_download_smoke() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/core-tests")
                .join(format!("network-smoke-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&directory).unwrap();
            let state = LauncherState {
                data: std::sync::Mutex::new(Persisted {
                    config: Config {
                        game_directory: directory.join("game").to_string_lossy().into_owned(),
                        ..Config::default()
                    },
                    ..Persisted::default()
                }),
                data_dir: directory.clone(),
                client: reqwest::Client::builder()
                    .timeout(Duration::from_secs(180))
                    .build()
                    .unwrap(),
                operation: tokio::sync::Mutex::new(()),
                control: Default::default(),
                games: Default::default(),
            };
            let list = manifest(&state).await.unwrap();
            let latest = list["latest"]["release"].as_str().unwrap();
            let root = directory.join("game");
            let metadata = official_metadata(&state, latest, &root).await.unwrap();
            let libraries = safe_join(&root, "libraries").unwrap();
            for library in metadata["libraries"].as_array().unwrap() {
                if !rules_allow(library.get("rules")) {
                    continue;
                }
                let _ = library_download(&state, library, &libraries).await.unwrap();
                let _ = native_download(library, &libraries).unwrap();
            }
            let file = download_from(
                &metadata["downloads"]["client"],
                &root,
                Some(&format!("versions/{latest}/{latest}.jar")),
            )
            .unwrap();
            assert!(ensure_download(&state.client, &file).await.unwrap());
            assert!(file_valid(&file).await.unwrap());
            assert!(
                !ensure_download(&state.client, &file).await.unwrap(),
                "verified existing file should be reused"
            );
            eprintln!(
                "Network smoke verified Mojang {latest} metadata and {} bytes client SHA-1 at {}",
                fs::metadata(file.path).unwrap().len(),
                directory.display()
            );
        });
    }
}
