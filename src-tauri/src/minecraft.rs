use crate::{
    models::*,
    storage::{process_path_text, safe_join, to_process_path, trusted_url, validate_id, LauncherState},
};
use futures_util::{stream, StreamExt, TryStreamExt};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
pub(crate) use crate::process_output::next_process_line;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};

pub const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const VERSION_PROFILE_BYTES: u64 = 8 * 1024 * 1024;
const VERSION_PROFILE_TOO_LARGE: &str = "版本元数据大小超过 8 MiB";

pub fn game_directory(
    config: &Config,
    version_id: &str,
    instance: Option<&Instance>,
) -> Result<PathBuf, String> {
    validate_id(version_id)?;
    let configured = Path::new(&config.game_directory);
    if let Some(instance) = instance {
        if instance.version_id != version_id {
            return Err("实例绑定版本与请求不一致".into());
        }
        let path = crate::storage::to_process_path(Path::new(&instance.game_directory))?;
        crate::instances::validate_absolute_syntax(&path)?;
        let configured = crate::storage::to_process_path(configured)?;
        if configured.is_absolute() {
            if let Some(relative) = crate::processes::directory_tail(&path, &configured) {
                let root = crate::processes::configured_game_root(&configured)?;
                return crate::instances::checked_absolute(&root.join(relative));
            }
        }
        // A registered instance from a previously configured root remains
        // usable. The path comes from the record, never from the renderer.
        let identity = crate::processes::canonical_game_directory(&path)?;
        return crate::storage::to_process_path(&identity);
    }
    let root = crate::processes::configured_game_root(configured)?;
    if config.version_isolation {
        crate::instances::checked_absolute(&safe_join(&root, &format!("versions/{version_id}"))?)
    } else {
        Ok(root)
    }
}

fn java_path_variables(game_dir: &Path, assets: &Path, game_assets: &Path, natives: &Path, libraries: &Path) -> Result<Vec<(String, String)>, String> {
    [
        ("game_directory", game_dir),
        ("assets_root", assets),
        ("game_assets", game_assets),
        ("natives_directory", natives),
        ("library_directory", libraries),
    ].into_iter().map(|(key, path)| Ok((key.into(), process_path_text(path)?))).collect()
}

fn javaagent_argument(injector: &Path, server: &str) -> Result<String, String> {
    Ok(format!("-javaagent:{}={server}", process_path_text(injector)?))
}


#[cfg(all(test, windows))]
#[test]
fn r4_generated_javaagent_game_dir_and_natives_are_not_verbatim() {
    let game = Path::new(r"\\?\D:\Instance Space\game");
    let libs = Path::new(r"\\?\UNC\server\share\libraries");
    let fields: HashMap<_, _> = java_path_variables(
        game, &game.join("assets"), &game.join("legacy-assets"), &game.join("natives"), libs,
    ).unwrap().into_iter().collect();
    let args = read_arguments(&json!(["--gameDir", "${game_directory}", "-Djava.library.path=${natives_directory}"]), &fields).unwrap();
    assert_eq!(args, ["--gameDir", r"D:\Instance Space\game", r"-Djava.library.path=D:\Instance Space\game\natives"]);
    assert_eq!(fields["library_directory"], r"\\server\share\libraries");
    assert!(fields.values().all(|path| !path.contains(r"\\?\")));
    assert_eq!(
        javaagent_argument(Path::new(r"\\?\D:\Launcher Profile\injector.jar"), "https://auth.invalid").unwrap(),
        r"-javaagent:D:\Launcher Profile\injector.jar=https://auth.invalid",
    );
}

pub fn log(app: &AppHandle, state: &LauncherState, level: &str, message: impl Into<String>) {
    let event = LogEvent {
        level: level.into(),
        message: crate::processes::redact(&message.into()),
        timestamp: chrono::Utc::now().to_rfc3339(),
    };
    let directory = state.data_dir.join("logs");
    let _ = crate::process_output::append_log(
        &directory,
        &format!("{} [{}] {}\n", event.timestamp, event.level, event.message),
    );
    let _ = app.emit("launcher://log", event);
}

pub fn progress(
    app: &AppHandle,
    state: &LauncherState,
    version: &str,
    stage: &str,
    completed: usize,
    total: usize,
    bytes_completed: u64,
    bytes_total: u64,
    message: impl Into<String>,
) {
    let event = ProgressEvent {
        task_id: String::new(),
        operation: String::new(),
        stage: stage.into(),
        completed,
        total,
        bytes_completed,
        bytes_total,
        message: message.into(),
        version_id: version.into(),
    };
    if let Some(event) = state.control.record_progress(event) {
        let _ = app.emit("launcher://progress", event);
    }
}

const BMCLAPI_HOST: &str = "bmclapi2.bangbang93.com";
const BMCLAPI_ORIGIN: &str = "https://bmclapi2.bangbang93.com";

#[derive(Clone, Debug, Eq, PartialEq)]
struct UrlCandidate {
    url: String,
    mirror: bool,
}

fn loader_mirror_path(host: &str, path: &str) -> Option<String> {
    if matches!(host, "maven.minecraftforge.net" | "files.minecraftforge.net" | "maven.neoforged.net")
        && path.ends_with("-installer.jar.sha1")
    {
        return None;
    }
    let (prefix, tail) = match host {
        "maven.minecraftforge.net" | "maven.fabricmc.net" => ("/maven", path),
        "files.minecraftforge.net" => ("/maven", path.strip_prefix("/maven")?),
        "maven.neoforged.net" => ("/maven", path.strip_prefix("/releases")?),
        "meta.fabricmc.net" => ("/fabric-meta", path),
        "authlib-injector.yushi.moe" => ("/mirrors/authlib-injector", path),
        _ => return None,
    };
    (tail.starts_with('/') && tail.len() > 1).then(|| format!("{prefix}{tail}"))
}

pub(crate) fn mapped_bmclapi_url(url: &str) -> Result<String, String> {
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
        _ => loader_mirror_path(host, parsed.path())
            .ok_or("此主机或路径没有受支持的 BMCLAPI 映射")?,
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
    if !supports_mirror && loader_mirror_path(parsed.host_str().unwrap_or_default(), parsed.path()).is_none() {
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

pub(crate) fn identity_url(url: &str) -> String {
    url.to_owned()
}

pub(crate) fn resolve_request_url(
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
    fetch_bytes_once_with_origin(client, url, limit, resolver, false).await
}

async fn fetch_bytes_once_with_origin(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    resolver: &(dyn Fn(&str) -> String + Sync),
    same_origin: bool,
) -> Result<Vec<u8>, String> {
    trusted_url(url)?;
    let request_url = reqwest::Url::parse(&resolve_request_url(url, resolver)?)
        .map_err(|_| "下载地址格式错误")?;
    let response = client
        .get(request_url.clone())
        .send()
        .await
        .map_err(|e| format!("元数据请求失败：{e}"))?
        .error_for_status()
        .map_err(|e| format!("下载服务返回错误：{e}"))?;
    if same_origin && (!response.status().is_success() || response.url().origin() != request_url.origin()) {
        return Err("官方安装器校验请求离开发布方源站".into());
    }
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

pub(crate) async fn fetch_official_installer_sha1(
    client: &reqwest::Client,
    installer: &str,
) -> Result<String, String> {
    fetch_official_installer_sha1_resolved(client, installer, &identity_url).await
}

async fn fetch_official_installer_sha1_resolved(
    client: &reqwest::Client,
    installer: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<String, String> {
    let parsed = reqwest::Url::parse(installer).map_err(|_| "安装器地址无效")?;
    trusted_url(installer)?;
    if !matches!(parsed.host_str(), Some("maven.minecraftforge.net" | "maven.neoforged.net"))
        || !parsed.path().ends_with("-installer.jar")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("安装器校验值必须来自加载器的官方发布源".into());
    }
    // Do not route the sidecar through the candidate or mirror download clients.
    // A successful redirect is allowed only if the final origin is the publisher.
    let bytes = fetch_bytes_once_with_origin(client, &format!("{installer}.sha1"), 1024, resolver, true)
        .await
        .map_err(|_| "无法获取官方安装器 SHA-1；请切换到官方源并重试")?;
    let digest = std::str::from_utf8(&bytes).ok().and_then(|value| value.split_whitespace().next());
    digest.filter(|value| valid_sha1(value))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "官方安装器校验值无效；请切换到官方源并重试".into())
}

#[derive(Clone, Copy)]
enum LoaderMirrorStage {
    Metadata,
    Artifact,
}

/// A fixed-text loader warning in the persistent launcher log.
pub(crate) fn record_loader_warning(data_dir: &Path, message: &str) {
    let record = format!("{} [warn] {message}\n", chrono::Utc::now().to_rfc3339());
    if crate::process_output::append_log(&data_dir.join("logs"), &record).is_err() {
        eprintln!("{message}");
    }
}

fn record_loader_mirror_fallback(data_dir: &Path, stage: LoaderMirrorStage) {
    let kind = match stage {
        LoaderMirrorStage::Metadata => "metadata",
        LoaderMirrorStage::Artifact => "artifact",
    };
    // Only fixed strings go to this journal. The error can include a URL or proxy details.
    let message = format!("BMCLAPI loader {kind} rejected or unavailable; trying remaining sources");
    let record = format!("{} [warn] {message}\n", chrono::Utc::now().to_rfc3339());
    if crate::process_output::append_log(&data_dir.join("logs"), &record).is_err() {
        eprintln!("{message}");
    }
}

/// BMCLAPI is a transport mirror, not an independent Mojang endorsement. In particular,
/// hashes supplied by a mirrored manifest inherit that manifest's trust chain.
async fn fetch_bytes_candidates_prefer_resolved<T>(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    source: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
    validate: impl Fn(&[u8]) -> Result<T, String>,
    should_return: impl Fn(&T, &UrlCandidate) -> bool,
    fallback_log: Option<(&Path, LoaderMirrorStage)>,
) -> Result<(Vec<u8>, T, UrlCandidate), String> {
    let candidates = download_url_candidates(url, source)?;
    let loader_mirror = reqwest::Url::parse(url).ok().is_some_and(|url| {
        loader_mirror_path(url.host_str().unwrap_or_default(), url.path()).is_some()
    });
    let mut provisional = None;
    let mut errors = Vec::new();
    for candidate in candidates {
        match fetch_bytes_once(client, &candidate.url, limit, resolver).await {
            Ok(bytes) => match validate(&bytes) {
                Ok(value) if should_return(&value, &candidate) => return Ok((bytes, value, candidate)),
                Ok(value) => { provisional = Some((bytes, value, candidate)); continue; }
                Err(error) => errors.push(format!("{}：{error}", candidate.url)),
            },
            Err(error) => errors.push(format!("{}：{error}", candidate.url)),
        }
        if candidate.mirror && loader_mirror {
            if let Some((data_dir, stage)) = fallback_log {
                record_loader_mirror_fallback(data_dir, stage);
            }
        }
    }
    provisional.ok_or_else(|| format!("元数据候选均失败：{}", errors.join("；")))
}

async fn fetch_bytes_candidates_resolved<T>(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    source: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
    validate: impl Fn(&[u8]) -> Result<T, String>,
) -> Result<(Vec<u8>, T, UrlCandidate), String> {
    fetch_bytes_candidates_prefer_resolved(client, url, limit, source, resolver, validate, |_, _| true, None).await
}

async fn fetch_loader_versions_resolved<T>(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    source: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
    fallback_data_dir: Option<&Path>,
    validate: impl Fn(&[u8]) -> Result<Vec<T>, String>,
) -> Result<(Vec<u8>, Vec<T>, UrlCandidate), String> {
    fetch_bytes_candidates_prefer_resolved(client, url, limit, source, resolver, validate, |versions, candidate| {
        !candidate.mirror || !versions.is_empty()
    }, fallback_data_dir.map(|dir| (dir, LoaderMirrorStage::Metadata))).await
}

pub(crate) async fn fetch_loader_versions<T>(
    state: &LauncherState,
    url: &str,
    limit: usize,
    source: &str,
    validate: impl Fn(&[u8]) -> Result<Vec<T>, String>,
) -> Result<Vec<T>, String> {
    fetch_loader_versions_resolved(state.client()?, url, limit, source, &identity_url, Some(&state.data_dir), validate)
        .await.map(|(_, versions, _)| versions)
}

pub(crate) async fn fetch_loader_artifact_bytes<T>(
    state: &LauncherState,
    url: &str,
    limit: usize,
    source: &str,
    validate: impl Fn(&[u8]) -> Result<T, String>,
) -> Result<(Vec<u8>, T), String> {
    fetch_bytes_candidates_prefer_resolved(
        state.client()?, url, limit, source, &identity_url, validate, |_, _| true,
        Some((&state.data_dir, LoaderMirrorStage::Artifact)),
    ).await.map(|(bytes, value, _)| (bytes, value))
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

async fn read_manifest_cache(state: &LauncherState, file: &str) -> Option<Value> {
    let bytes = tokio::fs::read(state.data_dir.join(file)).await.ok()?;
    let value = parse_json(&bytes).ok()?;
    validate_manifest(&value).ok()?;
    Some(value)
}

async fn profile_ownership_manifests(state: &LauncherState) -> Vec<Value> {
    let mut manifests = Vec::new();
    for file in [manifest_cache_file(false), manifest_cache_file(true)] {
        if let Some(manifest) = read_manifest_cache(state, file).await {
            manifests.push(manifest);
        }
    }
    manifests
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
        if let Some(value) = read_manifest_cache(state, file).await {
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
        state.client()?,
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
    let source = crate::source_select::passive_download_source(state, &state.snapshot()?.config.download_source).await?;
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
    let Ok(root) = crate::processes::configured_game_root(Path::new(&config.game_directory)) else {
        return vec![];
    };
    let root = root.as_path();
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
        let metadata = parse_json(&read_local_profile(&path, &current)?)?;
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

fn read_local_profile(path: &Path, id: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("缺少继承版本 {id}，请先安装原版")
        } else {
            format!("读取版本元数据失败：{error}")
        }
    })?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > VERSION_PROFILE_BYTES {
        return Err(VERSION_PROFILE_TOO_LARGE.into());
    }
    let mut bytes = Vec::new();
    file.take(VERSION_PROFILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > VERSION_PROFILE_BYTES {
        return Err(VERSION_PROFILE_TOO_LARGE.into());
    }
    Ok(bytes)
}

pub(crate) async fn resolve_metadata(
    state: &LauncherState,
    id: &str,
    root: &Path,
) -> Result<Value, String> {
    let source = crate::source_select::effective_download_source(state, &state.snapshot()?.config.download_source).await?;
    resolve_metadata_with_source(state, id, root, &source).await
}

async fn resolve_metadata_with_source(
    state: &LauncherState,
    id: &str,
    root: &Path,
    source: &str,
) -> Result<Value, String> {
    resolve_metadata_resolved(state, id, root, source, &identity_url).await
}

async fn resolve_metadata_resolved(
    state: &LauncherState,
    id: &str,
    root: &Path,
    source: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<Value, String> {
    resolve_metadata_at_roots(state, id, root, None, source, resolver).await
}

async fn resolve_metadata_at_roots(
    state: &LauncherState,
    id: &str,
    root: &Path,
    preview_cache: Option<&Path>,
    source: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
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
        let bytes = read_version_profile(&path).await?;
        let local = match bytes.as_deref().map(parse_json) {
            Some(Ok(metadata)) => Some(metadata),
            Some(Err(_)) if known_loader_profile(state, &current)? => {
                return Err(format!(
                    "{}{current}",
                    crate::errors::LOADER_REINSTALL_PREFIX
                ));
            }
            // A corrupt vanilla profile is classified only against the verified
            // metadata at the terminal owner, and must not be replaced by name alone.
            Some(Err(_)) | None => None,
        };
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
            let leaf = if let Some(cache) = preview_cache {
                official_metadata_at_paths(state, &current, cache, Some(root), source, resolver).await?
            } else {
                official_metadata_with_resolver(state, &current, root, source, resolver).await?
            };
            chain.push(leaf);
            break;
        }
    }
    merge_chain(chain)
}

/// Resolve only the verified base needed for a character preview. Installed
/// profiles can name their parent, but only the launcher-owned cache may be
/// written here; the game tree may simultaneously be in use by an install.
pub(crate) async fn resolve_preview_metadata(
    state: &LauncherState,
    id: Option<&str>,
    installed: &Path,
    cache: &Path,
    source: &str,
) -> Result<(String, Value), String> {
    let initial = match id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => id.to_owned(),
        None => {
            // The passive preview can reuse a valid cached latest pointer.
            // Refresh fetches on cold start, while ordinary version listing
            // retains its existing online refresh policy.
            let manifest = match read_cached_manifests(state, source).await?.into_iter().next() {
                Some(manifest) => manifest,
                None => manifest_with_resolver(state, source, &identity_url).await?,
            };
            manifest["latest"]["release"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("官方版本清单缺少 latest.release")?
                .to_owned()
        }
    };
    let metadata =
        resolve_metadata_at_roots(state, &initial, installed, Some(cache), source, &identity_url)
            .await?;
    let base_id = metadata["_launcherBaseId"].as_str().ok_or("角色预览缺少原版版本 ID")?.to_owned();
    Ok((base_id, metadata))
}


fn known_loader_profile(state: &LauncherState, id: &str) -> Result<bool, String> {
    if state.snapshot()?.instances.iter().any(|instance| {
        instance.version_id == id
            && (!instance.loader_version.is_empty()
                || matches!(
                    instance.loader.as_str(),
                    "fabric" | "quilt" | "forge" | "neoforge"
                ))
    }) {
        return Ok(true);
    }
    let id = id.to_ascii_lowercase();
    Ok(id.starts_with("fabric-loader-")
        || id.starts_with("quilt-loader-")
        || id.contains("-forge-")
        || id.contains("-neoforge-")
        || id.starts_with("forge-")
        || id.starts_with("neoforge-"))
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

pub(crate) fn mirror_download_client(data_dir: &Path, config: &Config) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
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
        }));
    crate::network::for_config_builder(data_dir, config, builder)?
        .build()
        .map_err(|_| "proxy.connection".into())
}

#[derive(Clone, Copy)]
enum DownloadPolicy<'a> {
    Uncapped,
    Foreground(&'a crate::downloads::DownloadControl),
    Preview(&'a crate::downloads::DownloadControl),
}

impl DownloadPolicy<'_> {
    async fn cancellable<F: std::future::Future>(self, future: F) -> Result<F::Output, String> {
        let control = match self {
            Self::Foreground(control) => Some(control),
            _ => None,
        };
        crate::download_io::cancellable(control, future).await
    }

    async fn checkpoint(self) -> Result<(), String> {
        match self {
            Self::Foreground(control) => control.checkpoint().await,
            _ => Ok(()),
        }
    }

    async fn throttle(self, bytes: usize) -> Result<(), String> {
        match self {
            Self::Foreground(control) => control.throttle(bytes).await,
            Self::Preview(control) => control.throttle_preview(bytes).await,
            Self::Uncapped => Ok(()),
        }
    }
}

impl crate::parts::Hooks for DownloadPolicy<'_> {
    async fn cancellable<F: std::future::Future>(&self, future: F) -> Result<F::Output, String> {
        DownloadPolicy::cancellable(*self, future).await
    }
    async fn checkpoint(&self) -> Result<(), String> {
        DownloadPolicy::checkpoint(*self).await
    }
    async fn throttle(&self, bytes: usize) -> Result<(), String> {
        DownloadPolicy::throttle(*self, bytes).await
    }
    fn stall_limit(&self) -> Duration {
        match self {
            Self::Foreground(control) | Self::Preview(control) => control.stall_limit(),
            Self::Uncapped => crate::parts::STALL,
        }
    }
}

async fn download_once(
    client: &reqwest::Client,
    file: &Download,
    url: &str,
    policy: DownloadPolicy<'_>,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<(), String> {
    trusted_url(url)?;
    let request_url = resolve_request_url(url, resolver)?;
    let parent = file.path.parent().ok_or("下载路径缺少父目录")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    // A file transfer fails when it stalls, not when it takes long.
    let request = client.get(request_url).timeout(crate::parts::TRANSFER_TIMEOUT);
    let response = crate::parts::within_stall(&policy, request.send())
        .await?
        // reqwest errors print the request URL; keep it (and any signed query) out of logs.
        .map_err(|error| error.without_url().to_string())?
        .error_for_status()
        .map_err(|error| error.without_url().to_string())?;
    if file
        .size
        .zip(response.content_length())
        .is_some_and(|(expected, actual)| expected != actual)
    {
        return Err("下载大小与版本元数据不一致".into());
    }

    let mut part = crate::download_io::DownloadPart::create(
        parent.join(format!(".launcher-{}.part", uuid::Uuid::new_v4())),
    )
    .map_err(|error| error.to_string())?;
    let mut chunks = response.bytes_stream();
    let mut hash = Sha1::new();
    let mut size = 0u64;
    while let Some(chunk) = crate::parts::within_stall(&policy, chunks.next()).await? {
        policy.checkpoint().await?;
        let chunk = chunk.map_err(|error| error.to_string())?;
        size += chunk.len() as u64;
        if size > file.size.unwrap_or(2 * 1024 * 1024 * 1024) {
            return Err("下载文件超出预期大小".into());
        }
        hash.update(&chunk);
        part.file()
            .write_all(&chunk)
            .await
            .map_err(|error| error.to_string())?;
        policy.throttle(chunk.len()).await?;
    }
    part.file()
        .flush()
        .await
        .map_err(|error| error.to_string())?;
    part.file()
        .sync_all()
        .await
        .map_err(|error| error.to_string())?;
    if file.size.is_some_and(|expected| expected != size)
        || format!("{:x}", hash.finalize()) != file.sha1
    {
        return Err("SHA-1 或文件大小校验失败".into());
    }
    policy.checkpoint().await?;
    part.publish(&file.path)
        .map_err(|error| format!("保存已校验文件失败：{error}"))
}

/// One attempt that continues this file's part (U0266) instead of starting at
/// byte zero. The whole part is checked against the metadata SHA-1 and size
/// before it replaces the target; a part that fails is discarded.
async fn download_resumable(
    client: &reqwest::Client,
    file: &Download,
    url: &str,
    policy: DownloadPolicy<'_>,
    resolver: &(dyn Fn(&str) -> String + Sync),
    slot: &mut Option<crate::parts::ResumablePart>,
) -> Result<(), String> {
    trusted_url(url)?;
    let size = file.size.ok_or("续传需要已知的文件大小")?;
    let requested = reqwest::Url::parse(&resolve_request_url(url, resolver)?).map_err(|_| "下载地址格式错误")?;
    let parent = file.path.parent().ok_or("下载路径缺少父目录")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let mut hash = Sha1::new();
    crate::parts::transfer(client.get(requested.clone()), &requested, slot, size, &policy, &|_| Ok(()), &mut |bytes| hash.update(bytes))
        .await?;
    let part = slot.take().ok_or("下载分片不可用")?;
    if format!("{:x}", hash.finalize()) != file.sha1 {
        part.discard();
        return Err("SHA-1 或文件大小校验失败".into());
    }
    // A cancel here keeps the complete part; the next attempt only checks it.
    policy.checkpoint().await?;
    crate::parts::publish_off_task(part, &file.path)
        .await
        .map_err(|error| format!("保存已校验文件失败：{error}"))
}

/// Where parts for `target` live: under the configured game root or the
/// launcher data directory that holds it, so publishing is a rename on one
/// volume. Other targets keep the one-shot download.
fn part_store_for(state: &LauncherState, file: &Download) -> Option<crate::parts::PartStore> {
    if !file.size.is_some_and(|size| size >= crate::parts::RESUME_MIN) || !valid_sha1(&file.sha1) {
        return None;
    }
    // The canonical root, as the install builds its targets from it.
    let game_root = state
        .snapshot()
        .ok()
        .and_then(|snapshot| crate::processes::configured_game_root(Path::new(&snapshot.config.game_directory)).ok());
    let folder = part_root_for(game_root, &state.data_dir, &file.path)?;
    if folder != state.data_dir.join(".launcher-temp").join("parts") {
        // Cleaned at startup even after the game directory setting changes.
        crate::parts::remember(&state.data_dir, &folder);
    }
    Some(crate::parts::PartStore::new(folder))
}

/// The parts folder for `target`: inside the root (the game root first) that
/// holds it.
fn part_root_for(game_root: Option<PathBuf>, data_dir: &Path, target: &Path) -> Option<PathBuf> {
    game_root
        .into_iter()
        .chain(std::iter::once(data_dir.to_path_buf()))
        .find(|root| !root.as_os_str().is_empty() && root.is_absolute() && target.starts_with(root))
        .map(|root| root.join(".launcher-temp").join("parts"))
}

#[cfg(test)]
pub(crate) async fn ensure_download_with_control(
    client: &reqwest::Client,
    file: &Download,
    control: Option<&crate::downloads::DownloadControl>,
) -> Result<bool, String> {
    ensure_download_with_source_and_control_resolved(client, Ok(None), file, "official", control, &identity_url).await
}

/// Uses the original metadata SHA-1 for every candidate. Mirrored files and their
/// checksums remain in the mirror's trust chain; this is not independent official signing.
pub(crate) async fn ensure_download_with_source_and_control(
    state: &LauncherState,
    file: &Download,
    source: &str,
    control: Option<&crate::downloads::DownloadControl>,
) -> Result<bool, String> {
    let policy = control.map_or(DownloadPolicy::Uncapped, DownloadPolicy::Foreground);
    ensure_download_with_policy(
        state.client()?, state.mirror_client().map(Some), file, source, policy, &identity_url,
        Some(&state.data_dir), false, part_store_for(state, file).as_ref(),
    ).await
}

/// A download that is part of a loader install chain (installer jar, its
/// pre-fetched libraries, loader profile libraries). Every candidate, including
/// Mojang-hosted libraries served by a mirror, uses the allowlisted client and
/// its redirect checks, and a rejected mirror is logged before falling back.
pub(crate) async fn ensure_loader_download(
    state: &LauncherState,
    file: &Download,
    source: &str,
    control: Option<&crate::downloads::DownloadControl>,
) -> Result<bool, String> {
    let policy = control.map_or(DownloadPolicy::Uncapped, DownloadPolicy::Foreground);
    ensure_download_with_policy(
        state.client()?, state.mirror_client().map(Some), file, source, policy, &identity_url,
        Some(&state.data_dir), true, part_store_for(state, file).as_ref(),
    ).await
}

async fn ensure_download_with_source_and_control_resolved(
    client: &reqwest::Client,
    mirror: Result<Option<&reqwest::Client>, String>,
    file: &Download,
    source: &str,
    control: Option<&crate::downloads::DownloadControl>,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<bool, String> {
    let policy = control.map_or(DownloadPolicy::Uncapped, DownloadPolicy::Foreground);
    ensure_download_with_policy(client, mirror, file, source, policy, resolver, None, false, None).await
}

pub(crate) async fn ensure_preview_download(
    client: &reqwest::Client,
    file: &Download,
    control: &crate::downloads::DownloadControl,
) -> Result<bool, String> {
    // As before, default skin bytes are fetched from their verified official
    // client URL, even when official metadata came from an enabled mirror.
    ensure_download_with_policy(client, Ok(None), file, "official", DownloadPolicy::Preview(control), &identity_url, None, false, None).await
}

async fn ensure_download_with_policy(
    client: &reqwest::Client,
    mirror: Result<Option<&reqwest::Client>, String>,
    file: &Download,
    source: &str,
    policy: DownloadPolicy<'_>,
    resolver: &(dyn Fn(&str) -> String + Sync),
    fallback_data_dir: Option<&Path>,
    loader_install: bool,
    parts: Option<&crate::parts::PartStore>,
) -> Result<bool, String> {
    policy.checkpoint().await?;
    if file_valid(file).await? {
        return Ok(false);
    }
    // Files of 1 MiB or more continue their part across attempts, cancels and
    // restarts. Without a part (held by another download, or none applies)
    // the file is fetched in one go as before.
    let key = parts
        .and(file.size.filter(|size| *size >= crate::parts::RESUME_MIN))
        .and_then(|size| crate::parts::PartKey::new(crate::parts::Algo::Sha1, &file.sha1, size));
    let open_part = || -> Option<crate::parts::ResumablePart> {
        let (store, key, size) = (parts?, key.as_ref()?, file.size?);
        store.open(key, size).ok().flatten()
    };
    let mut slot = open_part();
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
    // The caller says whether this is a loader install; the host alone would
    // miss Mojang-hosted libraries that an installer profile also lists.
    let strict_loader = strict_loader_download(loader_install, &file.url);
    let mirror_client = if !strict_loader && candidates.iter().any(|candidate| candidate.mirror) {
        Some(mirror?.ok_or("proxy.connection")?)
    } else {
        None
    };
    let attempts = if candidates.len() == 1 { 3 } else { 1 };
    let mut errors = Vec::new();
    let mut tries = 0;
    // Bytes a candidate added during this download are not thrown away by a
    // later candidate from another origin (that one fetches in one go).
    let mut written_here = false;
    let count = candidates.len();
    for (index, candidate) in candidates.into_iter().enumerate() {
        let candidate_client = if candidate.mirror {
            mirror_client.unwrap_or(client)
        } else {
            client
        };
        let origin = resolve_request_url(&candidate.url, resolver)
            .ok()
            .and_then(|url| reqwest::Url::parse(&url).ok())
            .map(|url| crate::parts::origin(&url))
            .unwrap_or_default();
        // One try stays in reserve for each later candidate, so a source that
        // keeps adding bytes never starves the fallback to the next one.
        let reserve = count - index - 1;
        let mut attempt = 0;
        let mut refetched = false;
        while attempt < attempts && tries + reserve < MAX_DOWNLOAD_TRIES {
            tries += 1;
            policy.checkpoint().await?;
            if slot.is_none() && key.is_some() {
                slot = open_part();
            }
            let protect = written_here && slot.as_ref().is_some_and(|part| part.holds_bytes_from_another(&origin));
            let before = slot.as_ref().map(crate::parts::ResumablePart::mark);
            let result = if slot.is_some() && !protect {
                download_resumable(candidate_client, file, &candidate.url, policy, resolver, &mut slot).await
            } else {
                download_once(candidate_client, file, &candidate.url, policy, resolver).await
            };
            if result.is_ok() && protect {
                // The file is in place; the other source's bytes are not needed.
                if let Some(part) = slot.take() {
                    part.discard();
                }
            }
            // An attempt that continued the part and added bytes does not use up
            // the budget, so a long file finishes over several interrupted
            // attempts. One that started over (a server ignoring Range) does.
            let after = slot.as_ref().map(crate::parts::ResumablePart::mark);
            let progressed = crate::parts::progressed(before.as_ref(), after.as_ref());
            written_here = slot.is_some() && (written_here || crate::parts::wrote(before.as_ref(), after.as_ref()));
            // A discarded part (failed check, wrong range) gets one fetch from
            // zero on the same candidate before the next candidate is tried.
            let discarded = before.is_some() && slot.is_none() && result.is_err();
            if !progressed && !(discarded && !refetched) {
                attempt += 1;
            }
            refetched |= discarded;
            match result {
                Ok(()) => return Ok(true),
                // No full URL: a signed query string must not reach the log.
                Err(error) => errors.push(format!("{}：{error}", candidate_label(&candidate.url, candidate.mirror))),
            }
            policy.checkpoint().await?;
            if attempt < attempts && tries + reserve < MAX_DOWNLOAD_TRIES {
                policy.cancellable(tokio::time::sleep(Duration::from_millis(500 * attempt.max(1) as u64)))
                    .await?;
            }
        }
        // One record per rejected mirror, however many tries it took (the
        // reserve gives every candidate at least one).
        if candidate.mirror && strict_loader {
            if let Some(data_dir) = fallback_data_dir {
                record_loader_mirror_fallback(data_dir, LoaderMirrorStage::Artifact);
            }
        }
    }
    Err(format!(
        "资源下载失败（{}）：{}",
        file.path.file_name().unwrap_or_default().to_string_lossy(),
        errors.join("；")
    ))
}

/// Every attempt of one file, over all candidates, including attempts that
/// added bytes to its part (each later candidate keeps one in reserve).
const MAX_DOWNLOAD_TRIES: usize = 12;

/// Whether a download uses the allowlisted client for mirror candidates and logs
/// a rejected mirror: every loader-install download, plus loader hosts anywhere.
fn strict_loader_download(loader_install: bool, url: &str) -> bool {
    loader_install || reqwest::Url::parse(url).ok().is_some_and(|url| {
        loader_mirror_path(url.host_str().unwrap_or_default(), url.path()).is_some()
    })
}

/// Source label and host only, never path or query.
fn candidate_label(url: &str, mirror: bool) -> String {
    let host = reqwest::Url::parse(url).ok().and_then(|url| url.host_str().map(str::to_owned)).unwrap_or_default();
    format!("{}（{host}）", if mirror { "镜像" } else { "官方源" })
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
    let (bytes, value, _) = crate::download_io::cancellable(
        control,
        fetch_bytes_candidates_resolved(client, &file.url, limit as usize, source, resolver, parse),
    ).await??;
    if let Some(control) = control {
        control.throttle(bytes.len()).await?;
    }
    let parent = file.path.parent().ok_or("下载路径缺少父目录")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|e| e.to_string())?;
    let mut part = crate::download_io::DownloadPart::create(
        parent.join(format!(".launcher-{}.part", uuid::Uuid::new_v4())),
    ).map_err(|e| e.to_string())?;
    part.file().write_all(&bytes).await.map_err(|e| e.to_string())?;
    part.file().flush().await.map_err(|e| e.to_string())?;
    if let Some(control) = control {
        control.checkpoint().await?;
    }
    part.publish(&file.path)
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
            state.client()?,
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
    let source = crate::source_select::effective_download_source(state, &state.snapshot()?.config.download_source).await?;
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
    official_metadata_at_paths(state, id, root, None, source, resolver).await
}

async fn official_metadata_at_paths(
    state: &LauncherState,
    id: &str,
    root: &Path,
    read_only_installed: Option<&Path>,
    source: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<Value, String> {
    validate_id(id)?;
    let relative = format!("versions/{id}/{id}.json");
    let local_path = safe_join(root, &relative)?;
    let installed_path = read_only_installed.map(|root| safe_join(root, &relative)).transpose()?;
    let candidate_metadata = async {
        let mut candidates = Vec::with_capacity(2);
        if let Some(bytes) = read_version_profile(&local_path).await? {
            candidates.push(bytes);
        }
        if let Some(path) = installed_path.as_ref() {
            if let Some(bytes) = read_version_profile(path).await? {
                candidates.push(bytes);
            }
        }
        Ok::<_, String>(candidates)
    }.await?;
    // Offline checksums must come from a manifest origin allowed by the current source.
    let cached_manifests = read_cached_manifests(state, source).await?;
    for local_bytes in &candidate_metadata {
        for cached in &cached_manifests {
            if let Ok(version) = manifest_version(cached, id) {
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
    // Refreshing a manifest may replace the only record of an older verified
    // profile. Preserve that evidence before changing the cache.
    let ownership_manifests = profile_ownership_manifests(state).await;
    let mut errors = Vec::new();
    let mut profile_conflict = None;
    for candidate in candidates {
        let manifest_bytes =
            match fetch_bytes_once(state.client()?, &candidate.url, 16 * 1024 * 1024, resolver).await
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
        for local_bytes in &candidate_metadata {
            if let Ok(metadata) = parse_official_metadata(local_bytes, id, &expected) {
                return Ok(metadata);
            }
        }
        match fetch_bytes_candidates_resolved(
            state.client()?,
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
                match publish_official_profile(id, &local_path, &bytes, &ownership_manifests).await
                {
                    Ok(()) => {}
                    // A valid local profile can match a different permitted
                    // manifest revision. Try that chain before reporting a conflict.
                    Err(error)
                        if error == format!("{}{id}", crate::errors::PROFILE_CONFLICT_PREFIX) =>
                    {
                        profile_conflict = Some(error);
                        continue;
                    }
                    Err(error) => return Err(error),
                }
                return Ok(metadata);
            }
            Err(error) => errors.push(format!("{} 的版本链：{error}", candidate.url)),
        }
    }
    Err(profile_conflict.unwrap_or_else(|| format!("原版元数据候选均失败：{}", errors.join("；"))))
}

async fn read_version_profile(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取版本元数据失败：{error}")),
    };
    let metadata = file.metadata().await.map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > VERSION_PROFILE_BYTES {
        return Err(VERSION_PROFILE_TOO_LARGE.into());
    }
    let mut bytes = Vec::new();
    file.take(VERSION_PROFILE_BYTES + 1)
        .read_to_end(&mut bytes).await
        .map_err(|error| format!("读取版本元数据失败：{error}"))?;
    if bytes.len() as u64 > VERSION_PROFILE_BYTES {
        return Err(VERSION_PROFILE_TOO_LARGE.into());
    }
    Ok(Some(bytes))
}

fn previously_verified_profile(manifests: &[Value], id: &str, previous: &[u8]) -> bool {
    // This identifies a cache that we may safely quarantine on a source switch.
    // It never authenticates new data: the caller has already checked the new
    // bytes against the manifest from the currently allowed source.
    manifests.iter().any(|manifest| {
        manifest_version(manifest, id).is_ok_and(|entry| {
            parse_official_metadata(previous, id, entry["sha1"].as_str().unwrap_or("")).is_ok()
        })
    })
}

fn is_valid_profile_json(bytes: &[u8]) -> bool {
    // Only validate syntax here. Valid custom files may have numbers or
    // nesting that the Value parser cannot represent. They are still user
    // content, not corrupt bytes that we can move aside.
    std::str::from_utf8(bytes).is_ok()
        && serde_json::from_slice::<serde::de::IgnoredAny>(bytes).is_ok()
}

async fn publish_official_profile(
    id: &str,
    path: &Path,
    verified: &[u8],
    ownership_manifests: &[Value],
) -> Result<(), String> {
    let previous = read_version_profile(path).await?;
    if previous.as_deref() == Some(verified) {
        return Ok(());
    }
    // The caller verified both this ID's manifest entry and the response's
    // SHA-1. Broken data keeps its original bytes in quarantine. Valid JSON
    // may be a custom profile, so only an earlier verified copy may move.
    let corrupt = previous.as_deref().is_some_and(|bytes| !is_valid_profile_json(bytes));
    if let Some(previous) = previous.as_deref() {
        if !corrupt && !previously_verified_profile(ownership_manifests, id, previous) {
            return Err(format!("{}{id}", crate::errors::PROFILE_CONFLICT_PREFIX));
        }
    }

    // Reserve our staging/quarantine name exclusively on the same volume.
    // Nothing from the old profile is removed until the replacement is ready.
    let tag = if corrupt { "corrupt" } else { "previous" };
    let transaction = path.with_extension(format!("json.{tag}-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&transaction)
        .await
        .map_err(|error| format!("无法创建版本元数据隔离目录：{error}"))?;
    let staged = transaction.join("verified.json");
    let original = transaction.join("original.json");
    let mut has_original = false;
    let outcome = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)
            .await
            .map_err(|error| error.to_string())?;
        file.write_all(verified)
            .await
            .map_err(|error| error.to_string())?;
        file.sync_all().await.map_err(|error| error.to_string())?;
        drop(file);
        if let Some(previous) = previous.as_deref() {
            let current = read_version_profile(path).await?;
            if current.as_deref() == Some(verified) {
                return Ok(()); // a concurrent resolver already published it
            }
            if current.as_deref().is_some_and(|bytes| bytes != previous) {
                return Err(format!("{}{id}", crate::errors::PROFILE_CONFLICT_PREFIX));
            }
            if current.is_some() {
                // The destination lives in a freshly reserved private directory.
                tokio::fs::rename(path, &original)
                    .await
                    .map_err(|error| error.to_string())?;
                has_original = true;
                if read_version_profile(&original).await?.as_deref() != Some(previous) {
                    return Err(format!("{}{id}", crate::errors::PROFILE_CONFLICT_PREFIX));
                }
            }
        }
        if let Err(error) = move_profile_to_vacant_path(&staged, path).await {
            if read_version_profile(path).await?.as_deref() != Some(verified) {
                return Err(format!("发布版本元数据失败（不会覆盖已存在文件）：{error}"));
            }
        }
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_file(&staged).await;
    if outcome.is_err()
        && has_original
        && move_profile_to_vacant_path(&original, path).await.is_ok()
    {
        has_original = false;
    }
    if !has_original {
        let _ = tokio::fs::remove_dir(&transaction).await;
    }
    outcome.map_err(|error| {
        if has_original {
            if error.starts_with(crate::errors::PROFILE_CONFLICT_PREFIX) {
                format!("{error}\n原有版本元数据保存在 {}", original.display())
            } else {
                format!("{error}；原有版本元数据保存在 {}", original.display())
            }
        } else {
            error
        }
    })
}

#[cfg(windows)]
async fn move_profile_to_vacant_path(from: &Path, to: &Path) -> std::io::Result<()> {
    let from = from.to_path_buf();
    let to = to.to_path_buf();
    tokio::task::spawn_blocking(move || {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn MoveFileW(existing: *const u16, new: *const u16) -> i32;
        }
        let to_parent = to.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
        let to_filename = to.file_name().ok_or(std::io::ErrorKind::InvalidInput)?;
        let from = fs::canonicalize(from)?;
        let to = fs::canonicalize(to_parent)?.join(to_filename);
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        // Both owned buffers are nul terminated and valid throughout the call.
        // MoveFileW without replacement support also works on Windows volumes
        // that do not support hard links (for example a removable drive).
        if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    })
    .await
    .map_err(std::io::Error::other)?
}

#[cfg(not(windows))]
async fn move_profile_to_vacant_path(from: &Path, to: &Path) -> std::io::Result<()> {
    tokio::fs::hard_link(from, to).await?;
    tokio::fs::remove_file(from).await
}

pub async fn install(
    state: &LauncherState,
    app: &AppHandle,
    id: &str,
) -> Result<(InstallResult, Value), String> {
    let config = state.snapshot()?.config;
    require_install_root_stopped(state, &config)?;
    install_with_config(state, app, id, &config).await
}

/// H06 for installs: the configured root, refused while a game launched from
/// it runs. Launch preparation calls install_with_config directly, so starting
/// another instance from the same root stays possible.
pub(crate) fn require_install_root_stopped(state: &LauncherState, config: &Config) -> Result<PathBuf, String> {
    let root = crate::processes::configured_game_root(Path::new(&config.game_directory))?;
    state.games.require_root_stopped(&root)?;
    Ok(root)
}

async fn install_with_config(
    state: &LauncherState,
    app: &AppHandle,
    id: &str,
    config: &Config,
) -> Result<(InstallResult, Value), String> {
    validate_id(id)?;
    let effective = crate::source_select::with_effective_source(state, config).await?;
    let config = &effective;
    let root = crate::processes::configured_game_root(Path::new(&config.game_directory))?;
    let root = root.as_path();
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    state.control.checkpoint().await?;
    progress(
        app,
        state,
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
            state.client()?,
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
        state,
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
                state,
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
                    state,
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
        state,
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

fn parse_java_version_output(text: &str) -> Option<(String, u32, bool)> {
    let regex = regex::Regex::new(r#"(?:java|openjdk) version "([^"]+)""#).ok()?;
    let version = regex.captures(text)?.get(1)?.as_str().to_owned();
    let major = java_major(&version)?;
    // Require a VM descriptor, rather than matching 64-Bit in an unrelated stderr line.
    let is_64bit = text.lines().any(|line| {
        line.contains("64-Bit") && (line.contains(" VM") || line.contains("J9"))
    });
    Some((version, major, is_64bit))
}

async fn inspect_java(path: PathBuf) -> Option<JavaRuntime> {
    let path = to_process_path(&path).ok()?;
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
    let (version, major, is_64bit) = parse_java_version_output(&text)?;
    Some(JavaRuntime {
        path: path.to_string_lossy().into_owned(),
        version,
        major,
        is_64bit,
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

fn java_candidates(config: &Config, data_dir: &Path) -> Vec<PathBuf> {
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
    // Choosing a game-data directory never authorizes arbitrary executables in it.
    find_java(&data_dir.join("runtimes"), 5, &mut candidates);
    let mut unique = HashSet::new();
    candidates.retain(|p| p.is_file() && crate::instances::checked_absolute(p).is_ok()
        && unique.insert(p.to_string_lossy().to_ascii_lowercase()));
    candidates
}

pub async fn detect_java(config: &Config, data_dir: &Path) -> Vec<JavaRuntime> {
    let mut runtimes: Vec<_> = stream::iter(java_candidates(config, data_dir).into_iter().map(inspect_java))
        .buffer_unordered(4)
        .filter_map(|runtime| async { runtime })
        .collect()
        .await;
    runtimes.sort_by(|a, b| b.major.cmp(&a.major).then(a.path.cmp(&b.path)));
    runtimes
}

#[derive(Debug)]
struct JavaConstraint {
    required: u32,
    min: u32,
    hard_max: Option<u32>,
    preferred_max: Option<u32>,
    reason: &'static str,
}

impl JavaConstraint {
    fn allows(&self, major: u32) -> bool {
        major >= self.min && self.hard_max.is_none_or(|max| major <= max)
    }

    fn range(&self) -> String {
        match self.hard_max {
            Some(max) if self.min == max => format!("Java {max}"),
            Some(max) => format!("Java {}–{max}", self.min),
            None => format!("Java {} 或更高版本", self.min),
        }
    }

    fn validate(&self) -> Result<(), JavaMismatch> {
        if let Some(max) = self.hard_max.filter(|max| *max < self.min) {
            return Err(JavaMismatch(format!(
                "{}，但版本元数据要求 Java {}，最高只能使用 Java {max}。请检查游戏版本元数据",
                self.reason, self.min
            )));
        }
        Ok(())
    }
}

#[derive(Debug)]
struct JavaMismatch(String);

impl std::fmt::Display for JavaMismatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn numeric_release(id: &str) -> Option<(u32, u32, u32)> {
    let mut parts = id.split('.');
    fn part(text: &str) -> Option<u32> {
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse().ok()
    }
    let major = part(parts.next()?)?;
    let minor = part(parts.next()?)?;
    let patch = part(parts.next().unwrap_or("0"))?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn java_constraint(metadata: &Value, loader: Option<&str>) -> JavaConstraint {
    let required = metadata["javaVersion"]["majorVersion"]
        .as_u64()
        .and_then(|major| u32::try_from(major).ok())
        .filter(|major| *major != 0)
        .unwrap_or(8);
    let legacy_wrapper = metadata["mainClass"].as_str() == Some("net.minecraft.launchwrapper.Launch")
        && metadata["libraries"].as_array().is_some_and(|libraries| {
            libraries.iter().any(|library| {
                library["name"]
                    .as_str()
                    .and_then(|name| name.strip_prefix("net.minecraft:launchwrapper:"))
                    .and_then(|coordinate| numeric_release(coordinate.split(':').next()?))
                    .is_some_and(|version| version < (1, 13, 0))
            })
        });
    let preferred_max = match loader {
        Some("forge" | "neoforge") => metadata["_launcherBaseId"]
            .as_str()
            .and_then(numeric_release)
            .and_then(|release| match release {
                (1, 7, 10..) | (1, 8..=16, _) => Some(8),
                (1, 17, _) => Some(16),
                (1, 18..=19, _) | (1, 20, 0..=4) => Some(17),
                // Only the 1.x line; 26.x and later declare their own Java.
                (1, 20, 5..) | (1, 21.., _) => Some(21),
                _ => None,
            }),
        _ => None,
    };
    let reason = if legacy_wrapper {
        "使用旧版 LaunchWrapper 的版本"
    } else {
        match (loader, preferred_max) {
            (Some("forge"), Some(_)) => "此版本的 Forge 加载器",
            (Some("neoforge"), Some(_)) => "此版本的 NeoForge 加载器",
            _ => "此游戏版本",
        }
    };
    JavaConstraint {
        required,
        min: required,
        hard_max: legacy_wrapper.then_some(8),
        preferred_max,
        reason,
    }
}

fn pick_java(runtimes: &[JavaRuntime], constraint: &JavaConstraint) -> Result<JavaRuntime, JavaMismatch> {
    constraint.validate()?;
    runtimes
        .iter()
        .filter(|java| constraint.allows(java.major))
        // Soft loader ranges only warn: every allowed runtime is at least `min`,
        // so lowest-major-first already prefers the newest runtime they accept.
        .min_by_key(|java| (
            java.major != constraint.required,
            java.major,
            !java.is_64bit,
            java.path.as_str(),
        ))
        .cloned()
        .ok_or_else(|| {
            let mut found: Vec<_> = runtimes.iter().map(|java| java.major).collect();
            found.sort_unstable();
            found.dedup();
            let found = if found.is_empty() {
                "无".to_owned()
            } else {
                found.iter().map(u32::to_string).collect::<Vec<_>>().join("、")
            };
            JavaMismatch(format!(
                "{}需要 {}；检测到的 Java 主版本：{found}。请在设置中启用“自动准备 Java”，或安装兼容的 64 位 Java",
                constraint.reason,
                constraint.range(),
            ))
        })
}

/// Names which Java path setting a pinned-Java error is about. An instance
/// path overrides the global one, so clearing the global field cannot help.
fn name_java_pin_source(error: String, instance_pin: bool) -> String {
    let (field, invalid) = if instance_pin {
        ("请清空实例设置中的 Java 路径", "实例设置中的 Java 路径无效")
    } else {
        ("请在“设置 › Java”中清空 Java 路径", "“设置 › Java”中的 Java 路径无效")
    };
    error
        .replace("设置中的 Java 路径无效", invalid)
        .replace("请清空 Java 路径", field)
}

fn pick_configured_java(
    runtimes: &[JavaRuntime],
    configured_path: &str,
    constraint: &JavaConstraint,
) -> Result<JavaRuntime, JavaMismatch> {
    if configured_path.trim().is_empty() {
        return pick_java(runtimes, constraint);
    }
    constraint.validate()?;
    let process_path = to_process_path(Path::new(configured_path)).map_err(JavaMismatch)?;
    let runtime = runtimes
        .iter()
        .find(|runtime| runtime.path.eq_ignore_ascii_case(&process_path.to_string_lossy()))
        .ok_or_else(|| JavaMismatch("设置中的 Java 路径无效或无法运行；请重新扫描 Java".into()))?;
    if !constraint.allows(runtime.major) {
        return Err(JavaMismatch(format!(
            "{}需要 {}，当前选择 Java {}。请清空 Java 路径以自动选择，或安装兼容的 Java",
            constraint.reason,
            constraint.range(),
            runtime.major,
        )));
    }
    Ok(runtime.clone())
}

fn java_preference_warning(java: &JavaRuntime, constraint: &JavaConstraint) -> Option<String> {
    let max = constraint.preferred_max.filter(|max| java.major > *max)?;
    if constraint.min > max {
        return Some(format!(
            "{}建议使用不高于 Java {max} 的运行时，但版本元数据至少要求 Java {}，正在使用 Java {}",
            constraint.reason, constraint.min, java.major
        ));
    }
    Some(format!(
        "{}建议使用不高于 Java {max} 的运行时，正在使用 Java {}；如果加载器报错，请改用匹配的 Java",
        constraint.reason, java.major
    ))
}

fn needs_official_install(
    config: &Config,
    selected: &Result<JavaRuntime, JavaMismatch>,
    constraint: &JavaConstraint,
) -> bool {
    config.java_path.trim().is_empty()
        && config.java_auto_download
        && constraint.allows(constraint.required)
        && !selected
            .as_ref()
            .is_ok_and(|java| java.major == constraint.required)
}

async fn select_java(
    config: &Config,
    data_dir: &Path,
    constraint: &JavaConstraint,
) -> Result<JavaRuntime, JavaMismatch> {
    constraint.validate()?;
    let runtimes = detect_java(config, data_dir).await;
    pick_configured_java(&runtimes, &config.java_path, constraint)
}

const JAVA_RUNTIME_INDEX:&str="https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

async fn install_official_java(
    state: &LauncherState,
    app: &AppHandle,
    metadata: &Value,
    config: &Config,
    constraint: &JavaConstraint,
) -> Result<JavaRuntime, String> {
    constraint.validate().map_err(|error| error.to_string())?;
    let effective = crate::source_select::with_effective_source(state, config).await?;
    let config = &effective;
    let required = constraint.required;
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
        state.client()?,
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
        state.client()?,
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
        state,
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
                state,
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
                    state,
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
    if java.major != required || !constraint.allows(java.major) {
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
    // The managed vanilla server and loader installers pass Mojang metadata.
    select_or_install_java_constrained(state, app, config, metadata, None).await
}

async fn select_or_install_java_constrained(
    state: &LauncherState,
    app: &AppHandle,
    config: &Config,
    metadata: &Value,
    loader: Option<&str>,
) -> Result<JavaRuntime, String> {
    let constraint = java_constraint(metadata, loader);
    let selected = select_java(config, &state.data_dir, &constraint).await;
    let java = if needs_official_install(config, &selected, &constraint) {
        install_official_java(state, app, metadata, config, &constraint).await?
    } else {
        selected.map_err(|error| error.to_string())?
    };
    if let Some(warning) = java_preference_warning(&java, &constraint) {
        log(app, state, "warn", warning);
    }
    Ok(java)
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
        .begin("java", &game_version, "安装Mojang官方Java")?;
    let result = async {
        let config = state.snapshot()?.config;
        let root = crate::processes::configured_game_root(Path::new(&config.game_directory))?;
        let metadata = resolve_metadata(&state, &game_version, &root).await?;
        let constraint = java_constraint(&metadata, crate::resources::detect_loader(&metadata));
        install_official_java(&state, &app, &metadata, &config, &constraint).await
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

fn extract_natives(metadata: &Value, root: &Path, natives: &Path) -> Result<(), String> {
    let native_libraries = metadata["libraries"].as_array().ok_or("依赖列表无效")?;
    fs::create_dir_all(natives).map_err(|e| e.to_string())?;
    let libraries = safe_join(root, "libraries")?;
    let mut expanded = 0u64;
    for library in native_libraries {
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
            let name = entry.name().map_err(|e| e.to_string())?.into_owned();
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
    Ok(paths.iter().map(|p| process_path_text(p)).collect::<Result<Vec<_>, _>>()?.join(";"))
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
    task_id: &str,
    id: &str,
    instance_id: Option<&str>,
    prepare: impl FnOnce(Persisted) -> F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    validate_id(id)?;
    state.control.claim_launch(task_id, id, instance_id)?;
    let _guard = state
        .control
        .wait_for_turn(&state.operation, task_id)
        .await?;
    if !state.control.activate(task_id) {
        return Err(crate::downloads::CANCELLED.into());
    }

    let result = async {
        let snapshot = state.snapshot()?;
        let instance = instance_id
            .map(|id| snapshot.instances.iter().find(|value| value.id == id).ok_or("实例不存在"))
            .transpose()?;
        let directory = game_directory(&snapshot.config, id, instance)?;
        state.games.require_directory_stopped(&directory, instance_id, true)?;

        state.control.checkpoint().await?;
        prepare(snapshot).await
    }
    .await;
    state
        .control
        .finish(task_id, result.as_ref().err().map(String::as_str));
    result
}

pub async fn launch(
    state: Arc<LauncherState>,
    app: AppHandle,
    task_id: String,
    id: String,
    instance_id: Option<String>,
    account_id: Option<String>,
    server_address: Option<String>,
) -> Result<LaunchResult, String> {
    let shared = state.clone();
    let target = id.clone();
    let requested_instance = instance_id.clone();
    let requested_task = task_id.clone();
    with_launch_preparation(
        &state,
        &requested_task,
        &target,
        requested_instance.as_deref(),
        move |snapshot| {
            launch_prepared(
                shared,
                app,
                task_id,
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

/// The game's proxy flags: the instance's game proxy mode wins over the global
/// one. Built from the saved settings only; credentials are never passed to Java.
fn launch_proxy_args(config: &Config, instance: Option<&Instance>, custom: &[String]) -> Result<Vec<String>, String> {
    let game_proxy_mode = instance
        .and_then(|value| value.game_proxy_mode.as_deref())
        .unwrap_or(&config.game_proxy_mode);
    crate::network::Settings::from_config(config)
        .and_then(|settings| settings.game_args(game_proxy_mode, custom))
        .map_err(|error| error.code().to_owned())
}

/// The launcher-controlled JVM options that come before the version's own
/// arguments: heap, encoding, managed proxy flags, the user's custom options
/// (never heap, main class, classpath or response files) and the temp folder.
fn launcher_jvm_options(
    memory: Vec<String>,
    managed_proxy_args: Vec<String>,
    custom: &[String],
    java_temp: impl FnOnce() -> Result<String, String>,
) -> Result<Vec<String>, String> {
    let mut arguments = memory;
    arguments.push("-Dfile.encoding=UTF-8".into());
    arguments.extend(managed_proxy_args);
    for argument in custom {
        if crate::memory::is_memory_argument(argument) {
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
        arguments.push(format!("-Djava.io.tmpdir={}", java_temp()?));
    }
    Ok(arguments)
}

/// Java's response file text for the JVM options (one quoted option per line).
fn jvm_response_file(arguments: &[String]) -> String {
    arguments
        .iter()
        .map(|arg| format!("\"{}\"", arg.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn launch_prepared(
    state: Arc<LauncherState>,
    app: AppHandle,
    task_id: String,
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
    let root = crate::processes::configured_game_root(Path::new(&snapshot.config.game_directory))?;
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
        // The heap comes from memory::launch_heap, not config.max_memory_mb.
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
    let custom = shell_words::split(&config.jvm_arguments)
        .map_err(|e| format!("自定义 JVM 参数引号不匹配：{e}"))?;
    let managed_proxy_args = launch_proxy_args(&config, instance, &custom)?;
    let game_dir = game_directory(&snapshot.config, &id, instance)?;
    let (_, metadata) = install_with_config(&state, &app, &id, &snapshot.config).await?;
    let loader = instance
        .map(|instance| instance.loader.as_str())
        .filter(|loader| matches!(*loader, "forge" | "neoforge" | "fabric" | "quilt"))
        .or_else(|| crate::resources::detect_loader(&metadata));
    let instance_pin = instance.is_some_and(|row| row.java_path.as_deref().is_some_and(|path| !path.trim().is_empty()));
    let java = select_or_install_java_constrained(&state, &app, &config, &metadata, loader)
        .await
        .map_err(|error| name_java_pin_source(error, instance_pin))?;
    fs::create_dir_all(&game_dir).map_err(|e| e.to_string())?;
    let mut launch_scratch = crate::process_output::LaunchScratch::create(&game_dir)?;
    let natives = launch_scratch.natives()?;
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
    .chain(java_path_variables(&game_dir, &assets, &game_assets, &natives, &libraries)?)
    .collect();
    let auto = crate::memory::effective_mode(&snapshot.config, instance) == "auto";
    let heap = crate::memory::launch_heap(
        &snapshot.config,
        instance,
        loader,
        if auto { crate::resources::count_enabled_mods(&game_dir.join("mods")) } else { Ok(0) },
        crate::memory::system_memory,
        java.is_64bit,
    );
    for (level, message) in &heap.logs {
        log(&app, &state, level, message);
    }
    let max_memory_mb = heap.max_mb;
    let (memory, clamped_minimum) = crate::memory::memory_arguments(
        max_memory_mb, crate::memory::effective_min(&snapshot.config, instance),
    );
    if clamped_minimum {
        log(&app, &state, "warn", "初始游戏内存已降到本次启动的最大内存");
    }
    if custom.iter().any(|arg| crate::memory::is_memory_argument(arg)) {
        log(&app, &state, "warn", "已忽略旧自定义 JVM 参数中的内存选项，请在内存设置中调整");
    }
    let mut arguments = launcher_jvm_options(memory, managed_proxy_args, &custom, || {
        process_path_text(&launch_scratch.java_temp()?)
    })?;
    if let Some(values) = metadata["arguments"].get("jvm") {
        arguments.extend(read_arguments(values, &variables)?);
    } else {
        arguments.extend([
            format!("-Djava.library.path={}", process_path_text(&natives)?),
            "-cp".into(),
            classpath,
        ]);
    }
    // Log4j config is part of official metadata and must be verified before passing to Java.
    if let Some(file) = metadata["logging"]["client"].get("file") {
        let file_id = file["id"].as_str().ok_or("日志配置缺少文件名")?;
        validate_id(file_id)?;
        let download = download_from(file, &root, Some(&format!("assets/log_configs/{file_id}")))?;
        let source = crate::source_select::effective_download_source(&state, &config.download_source).await?;
        ensure_download_with_source_and_control(&state, &download, &source, Some(&state.control)).await?;
        let template = metadata["logging"]["client"]["argument"]
            .as_str()
            .ok_or("日志配置参数缺失")?;
        arguments.push(template.replace("${path}", &process_path_text(&download.path)?));
    }
    if let Some(server) = credentials
        .as_ref()
        .and_then(|c| c.authlib_server.as_deref())
    {
        let injector = crate::loaders::authlib_injector(&state).await?;
        arguments.push(javaagent_argument(&injector, server)?);
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
    let mut command = tokio::process::Command::new(to_process_path(Path::new(&java.path))?);
    if java.major >= 9 {
        // Java's response file avoids Windows' 32 KiB process command-line limit.
        let argument_file =
            launch_scratch.write_args(&jvm_response_file(&arguments[..jvm_argument_count]))?;
        command.arg(format!("@{}", process_path_text(&argument_file)?));
        command.args(&arguments[jvm_argument_count..]);
    } else {
        command.args(&arguments);
    }
    command
        .current_dir(to_process_path(&game_dir)?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = state.control.start_game(&task_id, || {
        command.spawn().map_err(|e| format!("启动 Java 失败：{e}"))
    }).await?;
    launch_scratch.started();
    let Some(pid) = child.id() else {
        if child.wait().await.is_ok() {
            launch_scratch.finished();
        }
        return Err("Java 进程未提供 PID".into());
    };
    #[cfg(windows)]
    if let Err(error) = launch_scratch.record_owner(&child, pid) {
        // The spawned Java remains usable. A run without a valid marker
        // is deliberately never reclaimed by the startup sweep.
        eprintln!("[voxelight/scratch] unable to record Java ownership: {error}");
    }
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
    if let Some(instance_id) = instance_id.as_ref() {
        if let Err(error) = state.update(|data| {
            if let Some(instance) = data.instances.iter_mut().find(|i| &i.id == instance_id) {
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
    let game_id = uuid::Uuid::new_v4().to_string();
    let (process, owner) = crate::game_process::GameProcess::new(child);
    crate::processes::register(&app, &game_id, pid, &id, instance_id.clone(), &game_dir, &root, owner);
    let app_for_exit = app.clone();
    let state_for_exit = state.clone();
    let id_for_exit = game_id.clone();
    tauri::async_runtime::spawn(async move {
        let status = process.wait().await;
        if status.is_ok() {
            launch_scratch.finished();
        }
        // A failed/dropped wait retains the scratch files: Java may still be live.
        drop(launch_scratch);
        // The actor owns the child until exit, including when force was approved.
        // Remove only this identity; the PID may now be used for another game.
        match status {
            Ok(status) => {
                crate::processes::unregister(&app_for_exit, &state_for_exit, &id_for_exit, status.code());
                log(
                    &app_for_exit,
                    &state_for_exit,
                    if status.success() { "info" } else { "error" },
                    format!("Minecraft PID {pid} 已退出，退出码 {:?}", status.code()),
                );
                let _ = app_for_exit.emit(
                    "launcher://game-exit",
                    json!({"gameId":id_for_exit,"pid":pid,"code":status.code()}),
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
        game_id,
        pid,
        version_id: id,
        game_directory: game_dir.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stalled_m04_response(
        write_headers_and_prefix: bool,
    ) -> (
        String,
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::Sender<()>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let (seen_request, request) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut request = [0u8; 1024];
            assert!(socket.read(&mut request).unwrap() > 0);
            if write_headers_and_prefix {
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\na").unwrap();
            }
            seen_request.send(()).unwrap();
            released.recv_timeout(Duration::from_secs(3)).unwrap();
        });
        (address, request, release, server)
    }

    fn m04_part_exists(path: &Path) -> bool {
        fs::read_dir(path).is_ok_and(|dir| dir.flatten().any(|entry| {
            entry.path().extension().is_some_and(|extension| extension == "part")
        }))
    }

    #[test]
    fn m04_cancellation_interrupts_stalled_headers_and_body() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let mut observations = Vec::new();
            for (label, partial) in [("headers", false), ("body", true)] {
                let directory = source_test_directory(&format!("m04-{label}"));
                let (address, request, release, server) = stalled_m04_response(partial);
                let client = crate::storage::test_client();
                let fixture = Download {
                    path: directory.join("fixture.jar"),
                    url: "https://piston-data.mojang.com/v1/objects/fixture/client.jar".into(),
                    sha1: format!("{:x}", Sha1::digest(b"abc")),
                    size: Some(3),
                };
                let control = crate::downloads::DownloadControl::default();
                let task = control.begin("install", "fixture", "Fixture").unwrap();
                let resolve = |url: &str| TestServer::resolve(&address, url);
                let download = download_once(&client, &fixture, &fixture.url, DownloadPolicy::Foreground(&control), &resolve);
                tokio::pin!(download);
                let cancellation = async {
                    tokio::time::timeout(Duration::from_secs(2), request).await.unwrap().unwrap();
                    if partial {
                        tokio::time::timeout(Duration::from_secs(2), async {
                            while !m04_part_exists(&directory) {
                                tokio::time::sleep(Duration::from_millis(5)).await;
                            }
                        }).await.unwrap();
                    }
                    control.cancel(&task);
                };
                use futures_util::future::{select, Either};
                match select(download.as_mut(), Box::pin(cancellation)).await {
                    Either::Left((result, _)) => panic!("transfer completed before cancellation: {result:?}"),
                    Either::Right(((), _)) => {}
                };
                let result = tokio::time::timeout(Duration::from_millis(250), &mut download).await;
                let timed_out = result.is_err();
                let promptly_cancelled = result.is_ok_and(|result| result.is_err_and(|error| error.contains("任务已取消")));
                let part_left = m04_part_exists(&directory);
                eprintln!("M04_STALL {label} promptly_cancelled={promptly_cancelled} part_left={part_left}");
                release.send(()).unwrap();
                server.join().unwrap();
                // Baseline completes when the peer eventually closes; drain it before cleaning.
                if timed_out {
                    let _ = download.await;
                }
                fs::remove_dir_all(directory).unwrap();
                observations.push((label, promptly_cancelled, part_left));
            }
            assert_eq!(observations, [("headers", true, false), ("body", true, false)]);
        });
    }

    #[test]
    fn m04_cancelling_a_stalled_checked_metadata_fetch_leaves_no_new_profile() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("m04-json");
            let (address, requested, release, server) = stalled_m04_response(false);
            let client = crate::storage::test_client();
            let fixture = Download {
                path: directory.join("metadata.json"),
                url: "https://piston-meta.mojang.com/v1/packages/fixture/metadata.json".into(),
                sha1: format!("{:x}", Sha1::digest(b"{}")),
                size: Some(2),
            };
            let control = crate::downloads::DownloadControl::default();
            let task = control.begin("install", "fixture", "Fixture").unwrap();
            let resolve = |url: &str| TestServer::resolve(&address, url);
            let fetch = ensure_json_download_with_source_and_control_resolved(
                &client, &fixture, "official", Some(&control), &resolve, |_| Ok(()),
            );
            tokio::pin!(fetch);
            let cancel = async {
                tokio::time::timeout(Duration::from_secs(2), requested).await.unwrap().unwrap();
                control.cancel(&task);
            };
            use futures_util::future::{select, Either};
            match select(fetch.as_mut(), Box::pin(cancel)).await {
                Either::Left((result, _)) => panic!("transfer completed before cancellation: {result:?}"),
                Either::Right(((), _)) => {}
            };
            let result = tokio::time::timeout(Duration::from_millis(500), &mut fetch).await;
            let timed_out = result.is_err();
            let promptly_cancelled = result.is_ok_and(|result| result.is_err_and(|error| error.contains("任务已取消")));
            release.send(()).unwrap();
            server.join().unwrap();
            if timed_out {
                let _ = fetch.await;
            }
            let installed = fixture.path.exists();
            eprintln!("M04_JSON promptly_cancelled={promptly_cancelled} installed={installed}");
            assert!(promptly_cancelled);
            assert!(!installed);
        });
    }

    #[test]
    fn m04_fail_fast_drops_its_open_sibling_and_removes_the_part_file() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("m04-sibling");
            let (address, request, release, server) = stalled_m04_response(true);
            let client = crate::storage::test_client();
            let fixture = Download {
                path: directory.join("fixture.jar"),
                url: "https://piston-data.mojang.com/v1/objects/fixture/client.jar".into(),
                sha1: format!("{:x}", Sha1::digest(b"abc")),
                size: Some(3),
            };
            let resolve = |url: &str| TestServer::resolve(&address, url);
            let in_flight = download_once(&client, &fixture, &fixture.url, DownloadPolicy::Uncapped, &resolve);
            let sibling = async {
                tokio::time::timeout(Duration::from_secs(2), request).await.unwrap().unwrap();
                tokio::time::timeout(Duration::from_secs(2), async {
                    while !m04_part_exists(&directory) {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                }).await.unwrap();
                Err::<(), String>("synthetic sibling verification failure".into())
            };
            let result = futures_util::future::try_join(in_flight, sibling).await;
            assert_eq!(result.unwrap_err(), "synthetic sibling verification failure");
            let part_left = m04_part_exists(&directory);
            let installed = fixture.path.exists();
            eprintln!("M04_SIBLING part_left={part_left} installed={installed}");
            release.send(()).unwrap();
            server.join().unwrap();
            fs::remove_dir_all(directory).unwrap();
            assert!(!part_left);
            assert!(!installed);
        });
    }

    #[test]
    fn m07_child_reader_drops_an_oversized_record_without_losing_the_next_line() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let mut source = Vec::from([b'x'; 64 * 1024 + 19]);
            source.extend_from_slice(b"\r\nfollowing valid line\r\n");
            let mut reader = tokio::io::BufReader::with_capacity(13, source.as_slice());
            let first = next_process_line(&mut reader).await.unwrap().unwrap();
            assert!(first.len() < 256 && !first.contains("xxxxxxxx"));
            assert_eq!(next_process_line(&mut reader).await.unwrap().as_deref(), Some("following valid line"));
            assert_eq!(next_process_line(&mut reader).await.unwrap(), None);
        });
    }

    #[test]
    fn m07_unusable_native_metadata_does_not_create_an_extraction_directory() {
        let fixture = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let root = fixture.path();
        let natives = root.join("owned-new-run");
        let failure = extract_natives(&serde_json::json!({}), root, &natives);
        let scratch_exists = natives.exists();
        assert!(failure.is_err());
        assert!(!scratch_exists, "aborted native preparation left an extraction directory");
    }

    #[test]
    fn m07_native_extraction_rejects_links_traversal_and_expansion_before_writing() {
        use std::io::Write;
        use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

        for (case, expected) in [
            ("link", "符号链接"),
            ("relative", "越界"),
            ("declared-size", "解压超出大小限制"),
        ] {
            let fixture = crate::instances::StagingDirectory::create(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("target/core-tests")
                    .join(uuid::Uuid::new_v4().to_string()),
            ).unwrap();
            let root = fixture.path();
            let payload = root.join("libraries/fixture");
            fs::create_dir_all(&payload).unwrap();
            let mut archive = ZipWriter::new(fs::File::create(payload.join("natives.jar")).unwrap());
            let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            match case {
                "link" => archive.add_symlink("native.dll", "other-fixture.dll", options).unwrap(),
                "relative" => {
                    archive.start_file("../owned-outside-marker.dll", options).unwrap();
                    archive.write_all(b"fixture").unwrap();
                }
                "declared-size" => {
                    archive.start_file("native.dll", options).unwrap();
                    let block = vec![0; 1024 * 1024];
                    for _ in 0..128 {
                        archive.write_all(&block).unwrap();
                    }
                    archive.write_all(&[0]).unwrap();
                }
                _ => unreachable!(),
            }
            drop(archive.finish().unwrap());
            let metadata = json!({"libraries":[{
                "natives":{"windows":"test-native"},
                "downloads":{"classifiers":{"test-native":{
                    "url":"https://libraries.minecraft.net/fixture/natives.jar",
                    "path":"fixture/natives.jar",
                    "sha1":"1111111111111111111111111111111111111111",
                    "size":1,
                }}}
            }]});
            let natives = root.join("owned-native-destination");
            let error = extract_natives(&metadata, root, &natives).unwrap_err();
            assert!(error.contains(expected), "{case}: {error}");
            assert_eq!(fs::read_dir(&natives).unwrap().count(), 0, "{case}");
            assert!(!root.join("owned-outside-marker.dll").exists(), "{case}");
        }
    }

    #[test]
    fn m08_scan_rejects_oversized_version_profile_before_parsing_it() {
        let fixture = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let root = fixture.path();
        let profile = root.join("versions/test-release");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("test-release.jar"), []).unwrap();
        let json = profile.join("test-release.json");
        let mut bytes = br#"{"id":"test-release","mainClass":"net.minecraft.client.main.Main"}"#.to_vec();
        bytes.resize(8 * 1024 * 1024 + 1, b' ');
        std::fs::write(&json, &bytes).unwrap();
        let versions = scan_versions(&Config { game_directory: root.to_string_lossy().into_owned(), ..Config::default() });
        assert_eq!(versions.len(), 1);
        assert!(!versions[0].launchable);
        assert!(versions[0].reason.as_deref().unwrap().contains("8 MiB"));
    }


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
                                let location = if status == 302 {
                                    format!("Location: {}\r\n", std::str::from_utf8(&body).unwrap())
                                } else {
                                    String::new()
                                };
                                let header = format!(
                                    "HTTP/1.1 {status} {reason}\r\n{location}Content-Length: {}\r\nConnection: close\r\n\r\n",
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
        LauncherState::test_fixture(
            directory.to_path_buf(),
            Persisted {
                config: Config {
                    game_directory: directory.join("game").to_string_lossy().into_owned(),
                    ..Config::default()
                },
                ..Persisted::default()
            },
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
        )
    }

    fn source_test_directory(label: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/core-tests")
            .join(format!("{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn c7_default_jvm_options_match_the_pre_c7_baseline() {
        let config = Config::default();
        assert_eq!(config.game_proxy_mode, "off");
        let proxy = launch_proxy_args(&config, None, &[]).unwrap();
        assert!(proxy.is_empty(), "the default adds no proxy flags: {proxy:?}");
        let memory = vec!["-Xmx4096M".to_string(), "-Xms1024M".to_string()];
        let options = launcher_jvm_options(memory, proxy, &[], || Ok("T:\\tmp".into())).unwrap();
        assert_eq!(options, ["-Xmx4096M", "-Xms1024M", "-Dfile.encoding=UTF-8", "-Djava.io.tmpdir=T:\\tmp"]);
        assert_eq!(
            jvm_response_file(&options),
            "\"-Xmx4096M\"\n\"-Xms1024M\"\n\"-Dfile.encoding=UTF-8\"\n\"-Djava.io.tmpdir=T:\\\\tmp\""
        );
        assert_eq!(jvm_response_file(&["say \"hi\"".into()]), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn c7_instance_launcher_proxy_mode_reaches_the_response_file() {
        let config = Config {
            proxy_mode: "custom".into(),
            proxy_scheme: "http".into(),
            proxy_host: "proxy.example.invalid".into(),
            proxy_port: 8080,
            game_proxy_mode: "off".into(),
            ..Config::default()
        };
        let launcher = Instance { game_proxy_mode: Some("launcher".into()), ..Instance::default() };
        let expected = crate::network::Settings::from_config(&config).unwrap().installer_args().unwrap();
        assert!(!expected.is_empty());
        assert!(launch_proxy_args(&config, None, &[]).unwrap().is_empty(), "global off stays off");
        let proxy = launch_proxy_args(&config, Some(&launcher), &[]).unwrap();
        assert_eq!(proxy, expected, "the instance mode wins over the global one");
        let custom = vec!["-Dhttp.proxyHost=mine.invalid".to_string()];
        assert!(
            launch_proxy_args(&config, Some(&launcher), &custom).unwrap().is_empty(),
            "a user's own proxy option keeps precedence"
        );
        let options = launcher_jvm_options(vec![], proxy, &["-Dcustom=1".into()], || Ok("T".into())).unwrap();
        let text = jvm_response_file(&options);
        for flag in &expected {
            assert!(text.contains(&format!("\"{flag}\"")), "{flag} reaches the response file");
        }
        assert!(text.find("-Dfile.encoding").unwrap() < text.find(&expected[0]).unwrap());
        assert!(text.find(&expected[expected.len() - 1]).unwrap() < text.find("-Dcustom=1").unwrap());
        assert!(!text.to_ascii_lowercase().contains("password") && !text.contains('@'));
        let https = Config { proxy_scheme: "https".into(), ..config.clone() };
        assert_eq!(
            launch_proxy_args(&https, Some(&launcher), &[]),
            Err(crate::network::Error::TlsInheritance.code().to_owned())
        );
    }

    #[test]
    fn c7_launch_uses_the_extracted_jvm_option_builders() {
        let source = crate::storage::executable_source(include_str!("minecraft.rs"));
        let (_, launch) = source.split_once("async fn launch_prepared(").unwrap();
        let (launch, _) = launch.split_once("\n}").unwrap();
        assert!(launch.contains("let managed_proxy_args = launch_proxy_args(&config, instance, &custom)?;"));
        assert!(launch.contains("let mut arguments = launcher_jvm_options(memory, managed_proxy_args, &custom,"));
        assert!(launch.contains("jvm_response_file(&arguments[..jvm_argument_count])"));
        assert!(!launch.contains("-Dfile.encoding"), "the options are built in one place");
    }

    #[test]
    fn c2_installs_refuse_while_a_game_from_the_same_root_runs() {
        let directory = source_test_directory("c2-install-root");
        let other = directory.join("other-root");
        fs::create_dir_all(&other).unwrap();
        let state = source_test_state(&directory);
        let config = state.snapshot().unwrap().config;
        let root = PathBuf::from(&config.game_directory);
        fs::create_dir_all(&root).unwrap();
        // An instance game from before this field existed has no library root.
        state.games.fixture_running_directory(&root.join("instances/a"), None);
        let before = require_install_root_stopped(&state, &config);
        #[cfg(windows)]
        let alias = PathBuf::from(root.to_string_lossy().to_uppercase());
        #[cfg(not(windows))]
        let alias = root.join(".");
        state.games.fixture_running_root(&alias);
        let during = require_install_root_stopped(&state, &config);
        let mut elsewhere = config.clone();
        elsewhere.game_directory = other.to_string_lossy().into_owned();
        let other_root = require_install_root_stopped(&state, &elsewhere);
        drop(state);
        fs::remove_dir_all(&directory).unwrap();
        assert!(before.is_ok(), "{before:?}");
        assert_eq!(during, Err(crate::errors::INSTALL_GAME_RUNNING.into()));
        assert!(other_root.is_ok(), "another root has its own libraries");
    }

    #[test]
    fn c2_every_install_entry_checks_the_root_but_launch_does_not() {
        let source = crate::storage::executable_source(include_str!("minecraft.rs"));
        let body = |name: &str| {
            let (_, rest) = source.split_once(name).unwrap();
            rest.split_once("\n}").unwrap().0.to_owned()
        };
        let install = body("pub async fn install(\n");
        let checked = install.find("require_install_root_stopped(state, &config)?;").unwrap();
        assert!(checked < install.find("install_with_config(").unwrap());
        let launch = body("async fn launch_prepared(");
        assert!(!launch.contains("require_install_root_stopped"), "a second instance may still launch");
        assert!(launch.contains("&game_dir, &root, owner);"), "launch records its library root");
        let loaders = crate::storage::executable_source(include_str!("loaders.rs"));
        // Every loader install (interactive, retried, and the inner one other
        // installs call) goes through install_loader_resolving.
        let (_, inner) = loaders.split_once("pub async fn install_loader_inner(").unwrap();
        let (inner, _) = inner.split_once("\n}").unwrap();
        assert!(inner.contains("install_loader_resolving(state, app, loader, game_version, loader_version, &|_| {}).await"));
        let (_, loader) = loaders.split_once("async fn install_loader_resolving(").unwrap();
        let (loader, _) = loader.split_once("\n}").unwrap();
        let checked = loader.find("minecraft::require_install_root_stopped(state, &state.snapshot()?.config)?;").unwrap();
        assert!(loader.find("resolved(&version);").unwrap() < checked, "the resolved version is recorded before anything is installed");
        assert!(checked < loader.find("minecraft::install(state, app, game_version)").unwrap());
        assert!(checked < loader.find("lightweight_loader(").unwrap());
    }

    fn manifest_fixture(versions: Vec<Value>) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "latest": {"release": "source-test", "snapshot": "source-test"},
            "versions": versions,
        }))
        .unwrap()
    }

    #[test]
    fn damaged_official_profile_is_quarantined_and_refetched_through_its_inheriting_loader() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("damaged-vanilla-profile");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let canonical = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","type":"release","libraries":[],"arguments":{"game":["--demo"]}}"#;
            let damaged = &canonical[..canonical.len() - 6];
            let vanilla = root.join("versions/source-test/source-test.json");
            fs::create_dir_all(vanilla.parent().unwrap()).unwrap();
            fs::write(&vanilla, damaged).unwrap();
            let loader = root.join("versions/loader-test/loader-test.json");
            fs::create_dir_all(loader.parent().unwrap()).unwrap();
            let loader_bytes = br#"{"id":"loader-test","inheritsFrom":"source-test","mainClass":"net.fabricmc.loader.Main","libraries":[]}"#;
            fs::write(&loader, loader_bytes).unwrap();
            let manifest = manifest_fixture(vec![json!({
                "id": "source-test",
                "url": "https://piston-meta.mojang.com/v1/packages/source-test.json",
                "sha1": format!("{:x}", Sha1::digest(canonical)),
            })]);
            let server = TestServer::new(&[
                ("/piston-meta.mojang.com/mc/game/version_manifest_v2.json", 200, &manifest),
                ("/piston-meta.mojang.com/v1/packages/source-test.json", 200, canonical),
            ]);
            let resolver = server.resolver();
            let result = resolve_metadata_resolved(&state, "loader-test", &root, "official", &resolver).await.unwrap();
            assert_eq!(result["id"], "loader-test");
            assert_eq!(result["_launcherClientId"], "source-test");
            assert_eq!(fs::read(&loader).unwrap(), loader_bytes);
            assert_eq!(fs::read(&vanilla).unwrap(), canonical);
            for _ in 0..2 {
                let backups: Vec<_> = fs::read_dir(vanilla.parent().unwrap()).unwrap().map(|entry| entry.unwrap().path())
                    .filter(|path| path.file_name().unwrap().to_string_lossy().starts_with("source-test.json.corrupt-"))
                    .collect();
                assert_eq!(backups.len(), 1);
                assert_eq!(fs::read(backups[0].join("original.json")).unwrap(), damaged);
                assert!(resolve_metadata_resolved(&state, "loader-test", &root, "official", &resolver).await.is_ok());
            }
            assert_eq!(server.requests().len(), 2, "subsequent repairs use verified local bytes");
            drop(resolver);
            drop(server);
            drop(state);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    fn assert_manifest_listed_damage_is_quarantined(damaged: &[u8]) {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("verification-damaged-profile");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let canonical = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#;
            let path = root.join("versions/source-test/source-test.json");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, damaged).unwrap();
            let manifest = manifest_fixture(vec![json!({
                "id": "source-test",
                "url": "https://piston-meta.mojang.com/v1/packages/source-test.json",
                "sha1": format!("{:x}", Sha1::digest(canonical)),
            })]);
            let server = TestServer::new(&[
                ("/piston-meta.mojang.com/mc/game/version_manifest_v2.json", 200, &manifest),
                ("/piston-meta.mojang.com/v1/packages/source-test.json", 200, canonical),
            ]);
            let resolver = server.resolver();
            let result = official_metadata_with_resolver(&state, "source-test", &root, "official", &resolver).await;
            let installed = fs::read(&path).unwrap();
            let originals: Vec<_> = fs::read_dir(path.parent().unwrap()).unwrap().filter_map(|entry| {
                let entry = entry.unwrap();
                entry.file_name().to_string_lossy().starts_with("source-test.json.corrupt-")
                    .then(|| fs::read(entry.path().join("original.json")).unwrap())
            }).collect();
            let requests = server.requests().len();
            drop(resolver);
            drop(server);
            drop(state);
            fs::remove_dir_all(directory).unwrap();
            assert_eq!(result.unwrap()["id"], "source-test");
            assert_eq!(installed, canonical);
            assert_eq!(originals.as_slice(), [damaged]);
            assert_eq!(requests, 2);
        });
    }

    #[test]
    fn h07_manifest_listed_empty_profile_is_quarantined() {
        assert_manifest_listed_damage_is_quarantined(b"");
    }

    #[test]
    fn h07_manifest_listed_nul_filled_profile_is_quarantined() {
        assert_manifest_listed_damage_is_quarantined(&[0; 4096]);
    }

    #[test]
    fn h07_manifest_listed_non_json_profile_is_quarantined() {
        assert_manifest_listed_damage_is_quarantined(b"unparseable bytes");
    }

    #[test]
    fn h07_manifest_listed_short_truncated_profile_is_quarantined() {
        assert_manifest_listed_damage_is_quarantined(br#"{"id":"source-test","mainClass":"net"#);
    }

    #[test]
    fn official_lookup_keeps_valid_custom_profiles_at_official_id() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("preserve-custom-profile");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let canonical = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","type":"release","libraries":[],"arguments":{"game":["--demo"]}}"#;
            let manifest = manifest_fixture(vec![json!({
                "id": "source-test",
                "url": "https://piston-meta.mojang.com/v1/packages/source-test.json",
                "sha1": format!("{:x}", Sha1::digest(canonical)),
            })]);
            let server = TestServer::new(&[
                ("/piston-meta.mojang.com/mc/game/version_manifest_v2.json", 200, &manifest),
                ("/piston-meta.mojang.com/v1/packages/source-test.json", 200, canonical),
            ]);
            let resolver = server.resolver();
            let path = root.join("versions/source-test/source-test.json");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let deep_valid = format!("{}0{}", "[".repeat(140), "]".repeat(140));
            for custom in [
                &br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","libraries":[],"arguments":{"game":["--custom"]}}"#[..],
                &b"null"[..],
                &b"1e1024"[..],
                deep_valid.as_bytes(),
            ] {
                fs::write(&path, custom).unwrap();
                let error = official_metadata_with_resolver(&state, "source-test", &root, "official", &resolver).await.unwrap_err();
                let localized = crate::errors::expected(error);
                assert_eq!(localized.code, "version.profileConflict");
                assert_eq!(localized.params["id"], "source-test");
                assert_eq!(fs::read(&path).unwrap(), custom);
                assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
            }
            drop(resolver);
            drop(server);
            drop(state);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn malformed_loader_gets_reinstall_guidance_without_fetching_metadata() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("damaged-loader-profile");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let path = root
                .join("versions/fabric-loader-0.7-source-test/fabric-loader-0.7-source-test.json");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let damaged = br#"{"id":"fabric-loader-0.7-source-test","inheritsFrom":"#;
            fs::write(&path, damaged).unwrap();
            let server = TestServer::new(&[]);
            let resolver = server.resolver();
            let error = resolve_metadata_resolved(
                &state,
                "fabric-loader-0.7-source-test",
                &root,
                "official",
                &resolver,
            )
            .await
            .unwrap_err();
            let localized = crate::errors::expected(error);
            assert_eq!(localized.code, "version.loaderReinstall");
            assert_eq!(localized.params["id"], "fabric-loader-0.7-source-test");
            assert_eq!(fs::read(&path).unwrap(), damaged);
            assert!(server.requests().is_empty());
            drop(resolver);
            drop(server);
            drop(state);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn damaged_official_profile_keeps_original_when_the_response_fails_sha1() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("invalid-official-profile-fetch");
            let state = source_test_state(&directory.join("data"));
            let root = directory.join("game");
            let canonical = br#"{"id":"source-test","mainClass":"net.minecraft.client.main.Main","type":"release","libraries":[],"arguments":{"game":["--demo"]}}"#;
            let damaged = &canonical[..canonical.len() - 6];
            let path = root.join("versions/source-test/source-test.json");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, damaged).unwrap();
            let manifest = manifest_fixture(vec![json!({
                "id": "source-test",
                "url": "https://piston-meta.mojang.com/v1/packages/source-test.json",
                "sha1": format!("{:x}", Sha1::digest(canonical)),
            })]);
            let server = TestServer::new(&[
                ("/piston-meta.mojang.com/mc/game/version_manifest_v2.json", 200, &manifest),
                ("/piston-meta.mojang.com/v1/packages/source-test.json", 200, br#"{"id":"wrong"}"#),
            ]);
            let resolver = server.resolver();
            let outcome = resolve_metadata_resolved(&state, "source-test", &root, "official", &resolver).await;
            assert!(outcome.unwrap_err().contains("SHA-1"));
            assert_eq!(fs::read(&path).unwrap(), damaged);
            assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
            assert_eq!(server.requests().len(), 2);
            drop(resolver);
            drop(server);
            drop(state);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn official_profile_publication_will_not_replace_a_new_destination() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("no-clobber-vanilla-profile");
            fs::create_dir_all(&directory).unwrap();
            let staged = directory.join("verified.json");
            let target = directory.join("version.json");
            fs::write(&staged, b"verified staged metadata").unwrap();
            fs::write(&target, b"user profile created before publication").unwrap();
            assert!(move_profile_to_vacant_path(&staged, &target).await.is_err());
            assert_eq!(
                fs::read(&target).unwrap(),
                b"user profile created before publication"
            );
            assert_eq!(fs::read(&staged).unwrap(), b"verified staged metadata");
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn launch_guard_c5_root_alias_rejects_version_directory_of_another_instance() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("c5-canonical-root");
            let state = source_test_state(&directory);
            let snapshot = state.snapshot().unwrap();
            let game = game_directory(&snapshot.config, "same-root", None).unwrap();
            fs::create_dir_all(&game).unwrap();
            state.games.fixture_running_directory(&game, Some("unrelated-instance-id"));
            let prepared = std::sync::atomic::AtomicBool::new(false);
            let task_id = state.control.reserve_launch("same-root", None).unwrap();
            let result = with_launch_preparation(&state, &task_id, "same-root", None, |_| async {
                prepared.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            }).await;
            assert!(result.is_err(), "a second launch must not prepare the active game directory");
            assert!(!prepared.load(std::sync::atomic::Ordering::SeqCst));
            drop(state);
            fs::remove_dir_all(directory).unwrap();
        });
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
            let cancelled = state.control.begin("install", "old", "Old").unwrap();
            state.control.cancel(&cancelled);
            state.control.finish(&cancelled, Some("cancelled"));
            for fail in [false, true, false] {
                let shared = &state;
                let task = state.control.reserve_launch("source-test", None).unwrap();
                let result = with_launch_preparation(&state, &task, "source-test", None, |snapshot| async move {
                    shared.control.checkpoint().await?;
                    let root = Path::new(&snapshot.config.game_directory);
                    let metadata = resolve_metadata_with_source(shared, "source-test", root, &snapshot.config.download_source).await?;
                    let download = download_from(&metadata["downloads"]["client"], root,
                        Some("versions/source-test/source-test.jar"))?;
                    assert!(!ensure_download_with_source_and_control(&shared, &download,
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
            drop(state);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn h02_cancelling_queued_launch_does_not_touch_an_unrelated_install() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("launch-cancel");
            let state = source_test_state(&directory);
            let guard = state.operation.lock().await;
            let install = state
                .control
                .begin("install", "source-test", "Fixture install")
                .unwrap();
            let launch = state.control.reserve_launch("source-test", None).unwrap();
            {
                let request =
                    with_launch_preparation(&state, &launch, "source-test", None, |_| async {
                        Err::<(), _>("cancelled launch unexpectedly prepared".into())
                    });
                tokio::pin!(request);
                assert!(
                    tokio::time::timeout(Duration::from_millis(20), &mut request)
                        .await
                        .is_err()
                );
                state.control.cancel(&launch);
                let error = tokio::time::timeout(Duration::from_secs(2), &mut request)
                    .await
                    .expect("cancel must not wait for the install lock")
                    .unwrap_err();
                assert_eq!(error, crate::downloads::CANCELLED);
            }
            assert!(state.control.checkpoint().await.is_ok());
            assert!(state.operation.try_lock().is_err());
            let jobs = state.control.list();
            assert_eq!(
                (&jobs[0].id, jobs[0].status.as_str()),
                (&install, "running")
            );
            assert_eq!(
                (&jobs[1].id, jobs[1].status.as_str()),
                (&launch, "cancelled")
            );
            state.control.finish(&install, None);
            drop(guard);
            assert!(state
                .control
                .claim_launch(&launch, "source-test", None)
                .is_err());
            drop(state);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn launch_reservation_cannot_be_retargeted_or_replayed() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("launch-reservation");
            let state = source_test_state(&directory);
            let task = state.control.reserve_launch("source-test", None).unwrap();
            for (wrong_version, wrong_instance) in [
                ("other-version", None),
                ("source-test", Some("other-instance")),
            ] {
                let result = with_launch_preparation(
                    &state,
                    &task,
                    wrong_version,
                    wrong_instance,
                    |_| async { Ok(()) },
                )
                .await;
                assert_eq!(result.unwrap_err(), "任务不存在");
            }
            assert_eq!(state.control.list()[0].status, "queued");
            assert!(
                with_launch_preparation(&state, &task, "source-test", None, |_| async { Ok(()) })
                    .await
                    .is_ok()
            );
            assert!(
                with_launch_preparation(&state, &task, "source-test", None, |_| async { Ok(()) })
                    .await
                    .is_err()
            );
            assert_eq!(state.control.list()[0].status, "completed");
            drop(state);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn waiting_launch_uses_latest_snapshot_and_rejects_removed_instances() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = source_test_directory("launch-snapshot");
            let state = source_test_state(&directory);
            state
                .update(|data| {
                    data.instances.push(Instance {
                        id: "instance".into(),
                        version_id: "source-test".into(),
                        ..Default::default()
                    });
                    Ok(())
                })
                .unwrap();
            {
                let guard = state.operation.lock().await;
                let task = state.control.reserve_launch("source-test", None).unwrap();
                let request =
                    with_launch_preparation(&state, &task, "source-test", None, |snapshot| async move {
                        Ok(snapshot.config.game_directory)
                    });
                tokio::pin!(request);
                assert!(
                    tokio::time::timeout(Duration::from_millis(30), &mut request)
                        .await
                        .is_err()
                );
                let new_root = directory.join("new-game").to_string_lossy().into_owned();
                state
                    .update(|data| {
                        data.config.game_directory = new_root.clone();
                        Ok(())
                    })
                    .unwrap();
                drop(guard);
                assert_eq!(request.await.unwrap(), new_root);
            }

            {
                let guard = state.operation.lock().await;
                let task = state.control.reserve_launch("source-test", Some("instance".into())).unwrap();
                let request =
                    with_launch_preparation(&state, &task, "source-test", Some("instance"), |_| async {
                        Ok(())
                    });
                tokio::pin!(request);
                assert!(
                    tokio::time::timeout(Duration::from_millis(30), &mut request)
                        .await
                        .is_err()
                );
                state
                    .update(|data| {
                        data.instances.clear();
                        Ok(())
                    })
                    .unwrap();
                drop(guard);
                assert!(request.await.unwrap_err().contains("实例不存在"));
            }
            assert_eq!(state.control.list().len(), 2);
            assert_eq!(state.control.list()[1].status, "failed");
            assert!(state.operation.try_lock().is_ok());
            drop(state);
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
            "https://maven.quiltmc.org/repository/release/org/quiltmc/example.jar",
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

        let maven = "https://maven.quiltmc.org/repository/release/org/quiltmc/example.jar";
        for source in ["official", "auto", "bmclapi"] {
            let candidates = download_url_candidates(maven, source).unwrap();
            assert_eq!(candidates.len(), 1);
            assert_eq!(candidates[0].url, maven);
            assert!(!candidates[0].mirror);
        }
    }

    #[test]
    fn loader_mirror_mappings_use_exact_paths_and_source_order() {
        for (official, path) in [
            ("https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml", "/maven/net/minecraftforge/forge/maven-metadata.xml"),
            ("https://files.minecraftforge.net/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar", "/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar"),
            ("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml", "/maven/net/neoforged/neoforge/maven-metadata.xml"),
            ("https://maven.fabricmc.net/net/fabricmc/fabric-loader/maven-metadata.xml", "/maven/net/fabricmc/fabric-loader/maven-metadata.xml"),
            ("https://meta.fabricmc.net/v2/versions/loader/1.20.1", "/fabric-meta/v2/versions/loader/1.20.1"),
            ("https://authlib-injector.yushi.moe/artifact/42/authlib-injector.jar", "/mirrors/authlib-injector/artifact/42/authlib-injector.jar"),
        ] {
            let mirror = format!("{BMCLAPI_ORIGIN}{path}");
            assert_eq!(mapped_bmclapi_url(official).unwrap(), mirror);
            let urls = |source| download_url_candidates(official, source).unwrap().into_iter().map(|candidate| candidate.url).collect::<Vec<_>>();
            assert_eq!(urls("official"), vec![official]);
            assert_eq!(urls("auto"), vec![official, mirror.as_str()]);
            assert_eq!(urls("bmclapi"), vec![mirror.as_str(), official]);
        }
        for official in [
            "https://maven.quiltmc.org/repository/release/org/quiltmc/example.jar",
            "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
            "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
        ] {
            assert!(mapped_bmclapi_url(official).is_err());
            assert_eq!(download_url_candidates(official, "bmclapi").unwrap().len(), 1);
        }
    }

    #[test]
    fn u0259_empty_mirror_metadata_falls_back_without_discarding_legitimate_empty_lists() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let official = "https://meta.fabricmc.net/v2/versions/loader/1.20.1";
            let mirror_route = "/bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.20.1";
            let official_route = "/meta.fabricmc.net/v2/versions/loader/1.20.1";
            for (status, response, expected) in [(200, b"[1]".as_slice(), 1), (200, b"[]".as_slice(), 0), (500, b"unavailable".as_slice(), 0)] {
                let server = TestServer::new(&[(mirror_route, 200, b"[]"), (official_route, status, response)]);
                let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
                let (_, actual, candidate) = fetch_loader_versions_resolved(&client, official, 4096, "bmclapi", &server.resolver(), None, |bytes| {
                    serde_json::from_slice::<Vec<u8>>(bytes).map_err(|error| error.to_string())
                }).await.unwrap();
                assert_eq!(actual.len(), expected);
                assert_eq!(candidate.mirror, status != 200);
                assert_eq!(server.requests(), vec![mirror_route, official_route]);
            }
        });
    }

    #[test]
    fn c8_loader_installs_use_the_strict_policy_even_for_mojang_libraries() {
        let mojang = "https://libraries.minecraft.net/com/example/lib/1.0/lib-1.0.jar";
        assert!(strict_loader_download(true, mojang), "a loader install must not use the permissive mirror client");
        assert!(!strict_loader_download(false, mojang), "ordinary game downloads keep their behaviour");
        assert!(strict_loader_download(false, "https://maven.minecraftforge.net/net/minecraftforge/forge/x.jar"));
        assert_eq!(candidate_label("https://maven.example.invalid/a.jar?sig=fixture-secret", true), "镜像（maven.example.invalid）");
        let label = candidate_label("https://libraries.minecraft.net/a.jar?sig=fixture-secret", false);
        assert!(!label.contains("fixture-secret") && !label.contains("a.jar"), "{label}");
    }

    #[test]
    fn c8_matching_digest_with_the_wrong_size_is_rejected() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let body = b"fixture bytes";
            let route = "/maven.minecraftforge.net/net/test/sized.jar";
            let server = TestServer::new(&[(route, 200, body)]);
            let dir = crate::instances::StagingDirectory::create(Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("vx-c8-size-{}", uuid::Uuid::new_v4()))).unwrap();
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            let file = Download {
                path: dir.path().join("sized.jar"),
                sha1: format!("{:x}", Sha1::digest(body)),
                size: Some(body.len() as u64 + 1),
                url: "https://maven.minecraftforge.net/net/test/sized.jar".into(),
            };
            let resolver = server.resolver();
            let result = ensure_download_with_source_and_control_resolved(&client, Ok(None), &file, "official", None, &resolver).await;
            assert!(result.is_err(), "the declared size must be enforced even when the digest matches");
            assert!(!file.path.exists(), "nothing is published");
        });
    }

    #[test]
    fn c8_failed_candidates_never_put_the_url_query_in_the_error() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let server = TestServer::new(&[]);
            let dir = crate::instances::StagingDirectory::create(Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("vx-c8-errors-{}", uuid::Uuid::new_v4()))).unwrap();
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            let file = Download {
                path: dir.path().join("lib.jar"),
                sha1: format!("{:x}", Sha1::digest(b"fixture")),
                size: Some(7),
                url: "https://libraries.minecraft.net/com/example/lib.jar?sig=fixture-secret".into(),
            };
            let resolver = server.resolver();
            let Err(error) = ensure_download_with_source_and_control_resolved(&client, Ok(Some(&client)), &file, "bmclapi", None, &resolver).await else {
                panic!("both candidates return 404");
            };
            assert!(!error.contains("fixture-secret") && !error.contains("sig="), "{error}");
            assert!(error.contains("libraries.minecraft.net"), "{error}");
        });
    }

    #[test]
    fn u0259_refused_mirror_fallback_persists_sanitized_warning() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let official = "https://meta.fabricmc.net/v2/versions/loader/1.20.1";
            let mirror_route = "/bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.20.1";
            let official_route = "/meta.fabricmc.net/v2/versions/loader/1.20.1";
            let server = TestServer::new(&[
                (mirror_route, 403, b"fixture-private-upstream-detail"),
                (official_route, 200, b"[1]"),
            ]);
            let dir = crate::instances::StagingDirectory::create(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("target/core-tests")
                    .join(uuid::Uuid::new_v4().to_string()),
            )
            .unwrap();
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            let (_, versions, candidate) = fetch_loader_versions_resolved(
                &client, official, 4096, "bmclapi", &server.resolver(), Some(dir.path()),
                |bytes| serde_json::from_slice::<Vec<u8>>(bytes).map_err(|error| error.to_string()),
            ).await.unwrap();
            assert_eq!(versions, [1]);
            assert!(!candidate.mirror);
            assert_eq!(server.requests(), vec![mirror_route, official_route]);
            let log = std::fs::read_to_string(dir.path().join("logs/launcher-current.log")).unwrap();
            let lines: Vec<_> = log.lines().collect();
            assert_eq!(lines.len(), 1);
            assert_eq!(lines[0].split_once(" [warn] ").unwrap().1,
                "BMCLAPI loader metadata rejected or unavailable; trying remaining sources");
        });
    }

    #[test]
    fn loader_mirror_rejects_invalid_metadata_and_falls_back_to_publisher() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let official = "https://meta.fabricmc.net/v2/versions/loader/1.20.1";
            let mirror_route = "/bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.20.1";
            let official_route = "/meta.fabricmc.net/v2/versions/loader/1.20.1";
            let expected = br#"[{"loader":{"version":"0.15.11"}}]"#;
            let server = TestServer::new(&[(mirror_route, 200, b"invalid metadata"), (official_route, 200, expected)]);
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            let resolver = server.resolver();
            let (bytes, result, candidate) = fetch_bytes_candidates_resolved(
                &client, official, 4096, "bmclapi", &resolver,
                |bytes| {
                    let json = parse_json(bytes)?;
                    json[0]["loader"]["version"].as_str().map(str::to_owned).ok_or("fixture version missing".into())
                },
            ).await.unwrap();
            assert_eq!(bytes, expected);
            assert_eq!(result, "0.15.11");
            assert!(!candidate.mirror);
            assert_eq!(server.requests(), vec![mirror_route, official_route]);
        });
    }


    #[test]
    fn official_installer_sidecar_is_not_mappable_and_fails_closed() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let official = "https://maven.minecraftforge.net/net/minecraftforge/fixture-installer.jar";
            let sidecar = format!("{official}.sha1");
            let official_sha = "/maven.minecraftforge.net/net/minecraftforge/fixture-installer.jar.sha1";
            let mirror_sha = "/bmclapi2.bangbang93.com/maven/net/minecraftforge/fixture-installer.jar.sha1";
            let valid = format!("{:x}", Sha1::digest(b"fixture installer"));
            for source in ["official", "auto", "bmclapi"] {
                let urls = download_url_candidates(&sidecar, source).unwrap();
                assert_eq!(urls.len(), 1);
                assert_eq!(urls[0].url, sidecar);
                assert!(!urls[0].mirror);
            }
            assert!(mapped_bmclapi_url(&sidecar).is_err());
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            for (status, body, expected) in [(404, b"not available".as_slice(), false), (200, b"invalid digest", false), (200, valid.as_bytes(), true)] {
                let server = TestServer::new(&[(official_sha, status, body), (mirror_sha, 200, valid.as_bytes())]);
                let actual = fetch_official_installer_sha1_resolved(&client, official, &server.resolver()).await;
                if expected {
                    assert_eq!(actual.unwrap(), valid);
                } else {
                    assert!(actual.unwrap_err().contains("切换到官方源"));
                }
                assert_eq!(server.requests(), vec![official_sha]);
            }
        });
    }

    #[test]
    fn loader_mirror_rejects_mismatched_installer_bytes_then_fetches_publisher_jar() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let official = "https://maven.neoforged.net/releases/net/neoforged/fixture-installer.jar";
            let sha_route = "/maven.neoforged.net/releases/net/neoforged/fixture-installer.jar.sha1";
            let official_route = "/maven.neoforged.net/releases/net/neoforged/fixture-installer.jar";
            let mirror_route = "/bmclapi2.bangbang93.com/maven/net/neoforged/fixture-installer.jar";
            let valid = b"unexecutable fixture A";
            let invalid = b"unexecutable fixture B";
            let digest = format!("{:x}", Sha1::digest(valid));
            let server = TestServer::new(&[(sha_route, 200, digest.as_bytes()), (mirror_route, 200, invalid), (official_route, 200, valid)]);
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            let dir = crate::instances::StagingDirectory::create(Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("vx-c8-mirror-{}", uuid::Uuid::new_v4()))).unwrap();
            let resolver = server.resolver();
            let file = Download {
                path: dir.path().join("fixture-installer.jar"),
                sha1: fetch_official_installer_sha1_resolved(&client, official, &resolver).await.unwrap(),
                size: None,
                url: official.into(),
            };
            assert!(ensure_download_with_source_and_control_resolved(&client, Ok(None), &file, "bmclapi", None, &resolver).await.unwrap());
            assert_eq!(fs::read(&file.path).unwrap(), valid);
            assert_eq!(server.requests(), vec![sha_route, mirror_route, official_route]);
        });
    }

    #[test]
    fn official_installer_sidecar_rejects_cross_origin_response() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let official = "https://maven.minecraftforge.net/net/minecraftforge/fixture-installer.jar";
            let official_sha = "/maven.minecraftforge.net/net/minecraftforge/fixture-installer.jar.sha1";
            let digest = format!("{:x}", Sha1::digest(b"fixture installer"));
            let other = TestServer::new(&[("/sidecar", 200, digest.as_bytes())]);
            let location = format!("http://{}/sidecar", other.address);
            let server = TestServer::new(&[(official_sha, 302, location.as_bytes())]);
            let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            let error = fetch_official_installer_sha1_resolved(&client, official, &server.resolver()).await.unwrap_err();
            assert!(error.contains("SHA-1"));
            assert_eq!(server.requests(), vec![official_sha]);
            assert_eq!(other.requests(), vec!["/sidecar"]);
        });
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
            drop(state);
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
            drop(state);
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
            drop(state);
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
            drop(state);
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
            drop(state);
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
            drop(state);
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
                state.client().unwrap(),
                state.mirror_client().map(Some),
                &file,
                "auto",
                None,
                &resolver,
            )
            .await
            .unwrap());
            assert_eq!(fs::read(&file.path).unwrap(), good);
            assert!(!ensure_download_with_source_and_control_resolved(
                state.client().unwrap(),
                state.mirror_client().map(Some),
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
                state.client().unwrap(),
                state.mirror_client().map(Some),
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
                state.client().unwrap(),
                state.mirror_client().map(Some),
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
            drop(state);
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
    fn legacy_wrapper_java(version: &str) -> Value {
        json!({
            "_launcherBaseId": "1.12.2",
            "mainClass": "net.minecraft.launchwrapper.Launch",
            "libraries": [{"name": format!("net.minecraft:launchwrapper:{version}")}],
            "javaVersion": {"majorVersion": 8}
        })
    }

    fn java_fixture(major: u32, is_64bit: bool) -> JavaRuntime {
        JavaRuntime {
            path: format!("C:/java/{major}/{}/bin/java.exe", if is_64bit { "x64" } else { "x86" }),
            major,
            version: major.to_string(),
            is_64bit,
        }
    }

    #[test]
    fn u0826_launchwrapper_forge_1_12_2_caps_at_8() {
        let mut metadata = legacy_wrapper_java("1.12");
        let c = java_constraint(&metadata, Some("forge"));
        assert_eq!(c.hard_max, Some(8));
        assert_eq!(c.min, 8);
        assert_eq!(java_constraint(&metadata, None).hard_max, Some(8));

        for version in ["1.13", "1.13.0", "1.20", "garbage"] {
            assert_eq!(java_constraint(&legacy_wrapper_java(version), Some("forge")).hard_max, None);
        }
        metadata["mainClass"] = json!("net.fabricmc.loader.impl.launch.knot.KnotClient");
        assert_eq!(java_constraint(&metadata, Some("fabric")).hard_max, None);

        metadata = legacy_wrapper_java("1.12");
        metadata["libraries"] = json!([{"name": "example:launchwrapper:1.12"}]);
        assert_eq!(java_constraint(&metadata, Some("forge")).hard_max, None);
        metadata["libraries"] = json!([]);
        assert_eq!(java_constraint(&metadata, Some("forge")).hard_max, None);
    }

    #[test]
    fn u0826_pick_java_rejects_too_new_for_launchwrapper() {
        let c = java_constraint(&legacy_wrapper_java("1.12"), Some("forge"));
        let runtimes = [java_fixture(21, true), java_fixture(17, true), java_fixture(17, false)];
        let error = pick_java(&runtimes, &c).unwrap_err().to_string();
        assert!(error.contains("LaunchWrapper") && error.contains("Java 8"), "{error}");
        assert!(error.contains("17、21") && error.contains("自动准备 Java"), "{error}");
        assert_eq!(pick_java(&[java_fixture(8, false), runtimes[0].clone()], &c).unwrap().major, 8);
    }

    #[test]
    fn u0826_explicit_java_above_hard_max_and_below_minimum_is_error() {
        let explicit = java_fixture(17, true);
        let compatible = java_fixture(8, true);
        let c = java_constraint(&legacy_wrapper_java("1.12"), Some("forge"));
        let error = pick_configured_java(&[compatible, explicit.clone()], &explicit.path, &c)
            .unwrap_err().to_string();
        assert!(error.contains("Java 8") && error.contains("Java 17"), "{error}");
        assert!(error.contains("清空 Java 路径") && error.contains("LaunchWrapper"), "{error}");

        let modern = java_constraint(&json!({"javaVersion":{"majorVersion":21}}), None);
        let error = pick_configured_java(&[explicit.clone()], &explicit.path, &modern)
            .unwrap_err().to_string();
        assert!(error.contains("Java 21") && error.contains("Java 17"), "{error}");
        assert!(pick_configured_java(&[explicit], "C:/missing/java.exe", &c).is_err());
    }

    #[test]
    fn c5_pinned_java_errors_name_the_setting_that_holds_the_pin() {
        let explicit = java_fixture(17, true);
        let c = java_constraint(&legacy_wrapper_java("1.12"), Some("forge"));
        let error = pick_configured_java(&[explicit.clone()], &explicit.path, &c).unwrap_err().to_string();
        assert!(error.contains("使用旧版 LaunchWrapper 的版本需要"), "{error}");
        let instance = name_java_pin_source(error.clone(), true);
        assert!(instance.contains("请清空实例设置中的 Java 路径"), "{instance}");
        let global = name_java_pin_source(error, false);
        assert!(global.contains("“设置 › Java”中清空 Java 路径"), "{global}");
        let missing = pick_configured_java(&[], "C:/missing/java.exe", &c).unwrap_err().to_string();
        assert!(name_java_pin_source(missing, true).starts_with("实例设置中的 Java 路径无效"));
    }

    #[test]
    fn u0826_forge_preference_and_warning_do_not_block_a_pinned_runtime() {
        let metadata = json!({"_launcherBaseId":"1.18.2", "javaVersion":{"majorVersion":17}});
        let c = java_constraint(&metadata, Some("forge"));
        let high = java_fixture(21, true);
        let runtimes = [high.clone(), java_fixture(17, true)];
        assert_eq!(c.preferred_max, Some(17));
        assert_eq!(c.hard_max, None);
        assert_eq!(pick_java(&runtimes, &c).unwrap().major, 17);
        let explicit = pick_configured_java(&runtimes, &high.path, &c).unwrap();
        assert_eq!(explicit.major, 21);
        let warning = java_preference_warning(&explicit, &c).unwrap();
        assert!(warning.contains("Forge") && warning.contains("Java 17") && warning.contains("Java 21"));
        assert!(java_preference_warning(&runtimes[1], &c).is_none());
        assert_eq!(pick_java(&[high], &java_constraint(&metadata, None)).unwrap().major, 21);

        let overridden_min = json!({"_launcherBaseId":"1.18.2", "javaVersion":{"majorVersion":21}});
        let c = java_constraint(&overridden_min, Some("forge"));
        let picked = pick_java(&[java_fixture(21, true)], &c).unwrap();
        let warning = java_preference_warning(&picked, &c).unwrap();
        assert!(warning.contains("Java 17") && warning.contains("元数据至少要求 Java 21"), "{warning}");
    }

    #[test]
    fn u0826_modern_neoforge_fabric_and_vanilla_remain_compatible() {
        let modern = json!({
            "_launcherBaseId":"1.21.1", "javaVersion":{"majorVersion":21},
            "libraries":[{"name":"net.neoforged:neoforge:21.1.42"}]
        });
        let c = java_constraint(&modern, Some("neoforge"));
        assert_eq!(c.preferred_max, Some(21));
        let runtimes = [java_fixture(25, true), java_fixture(21, true)];
        assert_eq!(pick_java(&runtimes, &c).unwrap().major, 21);

        let fabric = json!({"_launcherBaseId":"1.20.1", "javaVersion":{"majorVersion":17}});
        let c = java_constraint(&fabric, Some("fabric"));
        assert_eq!(c.preferred_max, None);
        assert_eq!(pick_java(&[java_fixture(21, true)], &c).unwrap().major, 21);
        assert!(java_preference_warning(&java_fixture(21, true), &c).is_none());

        // Managed-server metadata is official vanilla, and a newer Java stays valid.
        let server = json!({"id":"1.12.2", "javaVersion":{"majorVersion":8}});
        let c = java_constraint(&server, None);
        assert_eq!(c.hard_max, None);
        assert_eq!(c.preferred_max, None);
        assert_eq!(pick_java(&[java_fixture(17, true)], &c).unwrap().major, 17);
    }

    #[test]
    fn u0826_soft_ranges_use_only_base_release_numbers() {
        for (release, expected) in [
            ("1.7.9", None),
            ("1.7.10", Some(8)),
            ("1.8", Some(8)),
            ("1.8.9", Some(8)),
            ("1.12.2", Some(8)),
            ("1.16", Some(8)),
            ("1.16.5", Some(8)),
            ("1.17.1", Some(16)),
            ("1.18", Some(17)),
            ("1.19.2", Some(17)),
            ("1.20", Some(17)),
            ("1.20.1", Some(17)),
            ("1.20.4", Some(17)),
            ("1.20.5", Some(21)),
            ("1.21.1", Some(21)),
            ("1.21.10", Some(21)),
            ("26.1", None),
            ("26.3", None),
            ("24w14a", None),
            ("1.20.5-pre1", None),
            ("1.20.5.1", None),
        ] {
            let metadata = json!({"id":"modded-id", "_launcherBaseId":release});
            assert_eq!(java_constraint(&metadata, Some("forge")).preferred_max, expected, "{release}");
            assert_eq!(java_constraint(&metadata, Some("neoforge")).preferred_max, expected, "{release}");
        }
    }

    #[test]
    fn u0826_java_selection_prefers_required_then_lower_major_and_64bit_at_equal_major() {
        let vanilla = json!({"javaVersion":{"majorVersion":17}});
        let c = java_constraint(&vanilla, None);
        let runtimes = [
            java_fixture(21, false), java_fixture(25, true), java_fixture(7, true),
            java_fixture(21, true), java_fixture(22, true),
        ];
        let picked = pick_java(&runtimes, &c).unwrap();
        assert_eq!(picked.major, 21);
        assert!(picked.is_64bit);
        assert_eq!(pick_java(&[picked, java_fixture(17, false)], &c).unwrap().major, 17);
    }

    #[test]
    fn u0826_auto_download_is_only_for_unpinned_non_exact_compatible_metadata() {
        let mut config = Config { java_auto_download: true, ..Config::default() };
        let c = java_constraint(&legacy_wrapper_java("1.12"), Some("forge"));
        let too_new = [java_fixture(17, true)];
        assert!(needs_official_install(&config, &pick_java(&too_new, &c), &c));
        assert!(!needs_official_install(&config, &Ok(java_fixture(8, true)), &c));
        config.java_path = too_new[0].path.clone();
        assert!(!needs_official_install(&config, &pick_java(&too_new, &c), &c));
        config.java_path.clear();
        config.java_auto_download = false;
        assert!(!needs_official_install(&config, &pick_java(&too_new, &c), &c));

        config.java_auto_download = true;
        let mut invalid = legacy_wrapper_java("1.12");
        invalid["javaVersion"]["majorVersion"] = 17.into();
        let c = java_constraint(&invalid, Some("forge"));
        let selection = pick_java(&too_new, &c);
        let error = selection.as_ref().unwrap_err().to_string();
        assert!(error.contains("LaunchWrapper") && error.contains("17") && error.contains('8'), "{error}");
        assert!(!needs_official_install(&config, &selection, &c));
    }

    #[test]
    fn u0826_java_version_output_records_bitness() {
        let (_, major, is_64bit) = parse_java_version_output(
            "openjdk version \"21.0.8\" 2025-07-15\nOpenJDK 64-Bit Server VM",
        ).unwrap();
        assert_eq!(major, 21);
        assert!(is_64bit);
        let (_, major, is_64bit) = parse_java_version_output(
            "java version \"1.8.0_451\"\nJava HotSpot(TM) Client VM",
        ).unwrap();
        assert_eq!(major, 8);
        assert!(!is_64bit);
        let (_, _, is_64bit) = parse_java_version_output(
            "64-Bit license notice\nopenjdk version \"17.0.12\"\nOpenJDK Client VM",
        ).unwrap();
        assert!(!is_64bit);
        assert!(parse_java_version_output("not a Java VM").is_none());
    }

    #[test]
    fn u0826_java_runtime_serializes_bitness_for_the_settings_ipc() {
        let value = serde_json::to_value(java_fixture(17, true)).unwrap();
        assert_eq!(value["is64bit"], true);
        assert!(value.get("is_64bit").is_none());
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
            let state = LauncherState::test_fixture(
                directory.clone(),
                Persisted {
                    config: Config {
                        game_directory: directory.join("game").to_string_lossy().into_owned(),
                        ..Config::default()
                    },
                    ..Persisted::default()
                },
                reqwest::Client::builder()
                    .timeout(Duration::from_secs(180))
                    .build()
                    .unwrap(),
            );
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
            assert!(ensure_download_with_control(state.client().unwrap(), &file, None)
                .await
                .unwrap());
            assert!(file_valid(&file).await.unwrap());
            assert!(
                !ensure_download_with_control(state.client().unwrap(), &file, None)
                    .await
                    .unwrap(),
                "verified existing file should be reused"
            );
            eprintln!(
                "Network smoke verified Mojang {latest} metadata and {} bytes client SHA-1 at {}",
                fs::metadata(file.path).unwrap().len(),
                directory.display()
            );
        });
    }

    use crate::parts::range_server::{RangeServer, Scripted};

    /// 3 MiB of bytes that differ by position, so a misplaced byte changes the hash.
    fn u0266_bytes(size: usize) -> Vec<u8> {
        (0..size).map(|index| (index * 31 % 251) as u8).collect()
    }

    struct U0266 {
        directory: PathBuf,
        store: crate::parts::PartStore,
        file: Download,
    }

    impl U0266 {
        fn new(label: &str, bytes: &[u8]) -> Self {
            let directory = source_test_directory(&format!("u0266-{label}"));
            fs::create_dir_all(directory.join("game")).unwrap();
            Self {
                store: crate::parts::PartStore::new(directory.join(".launcher-temp").join("parts")),
                file: Download {
                    path: directory.join("game").join("client.jar"),
                    url: "https://piston-data.mojang.com/v1/objects/fixture/client.jar".into(),
                    sha1: format!("{:x}", Sha1::digest(bytes)),
                    size: Some(bytes.len() as u64),
                },
                directory,
            }
        }
        async fn run(&self, server: &RangeServer, policy: DownloadPolicy<'_>) -> Result<bool, String> {
            self.run_from(server, policy, "official").await
        }
        /// With "auto" or "bmclapi" both the official host and the mirror are
        /// candidates; the server sees which one from the path.
        async fn run_from(&self, server: &RangeServer, policy: DownloadPolicy<'_>, source: &str) -> Result<bool, String> {
            let client = crate::storage::test_client();
            let address = server.address.clone();
            let resolve = move |url: &str| TestServer::resolve(&address, url);
            ensure_download_with_policy(&client, Ok(Some(&client)), &self.file, source, policy, &resolve, None, false, Some(&self.store)).await
        }
        fn parts(&self) -> Vec<String> {
            let mut names: Vec<_> = fs::read_dir(self.store.root())
                .map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect())
                .unwrap_or_default();
            names.sort();
            names
        }
        fn target_entries(&self) -> Vec<String> {
            fs::read_dir(self.directory.join("game")).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()
        }
    }

    impl Drop for U0266 {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    const MIB: usize = 1024 * 1024;

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Runtime::new().unwrap().block_on(future)
    }

    #[test]
    fn u0266_an_interrupted_download_resumes_from_its_offset_without_sending_bytes_twice() {
        let bytes = u0266_bytes(3 * MIB);
        let fixture = U0266::new("resume", &bytes);
        let server = RangeServer::new(vec![
            Scripted::ok(&bytes, "\"v1\"").cut(MIB),
            Scripted::partial(&bytes, MIB, "\"v1\""),
        ]);
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).unwrap());
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
        assert_eq!(server.count(), 2);
        assert_eq!(server.header(0, "range"), None);
        assert_eq!(server.header(1, "range").as_deref(), Some("bytes=1048576-"));
        assert_eq!(server.header(1, "if-range").as_deref(), Some("\"v1\""));
        assert_eq!(server.sent.load(Ordering::SeqCst), 3 * MIB, "every byte was sent once");
        assert_eq!(fixture.target_entries(), ["client.jar"], "no part beside the target");
        assert!(fixture.parts().is_empty(), "the published part leaves nothing behind: {:?}", fixture.parts());
    }

    #[test]
    fn u0266_a_server_that_ignores_range_restarts_the_part_cleanly() {
        let bytes = u0266_bytes(2 * MIB);
        let fixture = U0266::new("ignore-range", &bytes);
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"").cut(MIB), Scripted::ok(&bytes, "\"v1\"")]);
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).unwrap());
        assert_eq!(server.header(1, "range").as_deref(), Some("bytes=1048576-"));
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes, "no byte appended twice");
    }

    #[test]
    fn u0266_a_wrong_range_discards_the_part_and_the_next_attempt_starts_over() {
        let bytes = u0266_bytes(2 * MIB);
        let fixture = U0266::new("wrong-range", &bytes);
        let wrong = Scripted::partial(&bytes, 0, "\"v1\"")
            .with_headers(vec![("ETag", "\"v1\"".into()), ("Content-Range", format!("bytes 0-{}/{}", bytes.len() - 1, bytes.len()))]);
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"").cut(MIB), wrong, Scripted::ok(&bytes, "\"v2\"")]);
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).unwrap());
        assert_eq!(server.count(), 3);
        assert_eq!(server.header(1, "range").as_deref(), Some("bytes=1048576-"));
        assert_eq!(server.header(2, "range"), None, "the part was discarded, so the whole file is asked for");
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    #[test]
    fn u0266_a_changed_file_answers_if_range_with_the_whole_file() {
        let old = u0266_bytes(2 * MIB);
        let mut bytes = old.clone();
        bytes[0] ^= 0xff;
        let fixture = U0266::new("if-range", &bytes);
        // The first attempt got half of an older file; the server now has a new tag.
        let server = RangeServer::new(vec![Scripted::ok(&old, "\"old\"").cut(MIB), Scripted::ok(&bytes, "\"new\"")]);
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).unwrap());
        assert_eq!(server.header(1, "if-range").as_deref(), Some("\"old\""));
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    #[test]
    fn u0266_a_corrupted_prefix_fails_the_check_and_one_full_download_follows() {
        let bytes = u0266_bytes(2 * MIB);
        let fixture = U0266::new("corrupt", &bytes);
        let server = RangeServer::new(vec![Scripted::partial(&bytes, MIB, "\"v1\""), Scripted::ok(&bytes, "\"v1\"")]);
        // A part from this server with one damaged byte, as a disk or another program might leave it.
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha1, &fixture.file.sha1, bytes.len() as u64).unwrap();
        let mut part = fixture.store.open(&key, bytes.len() as u64).unwrap().unwrap();
        let origin = crate::parts::Validator { origin: format!("http://{}", server.address), etag: Some("\"v1\"".into()), last_modified: None };
        part.restart(origin).unwrap();
        let mut kept = bytes[..MIB].to_vec();
        kept[10] ^= 1;
        part.append(&kept).unwrap();
        drop(part);
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).unwrap());
        assert_eq!(server.count(), 2);
        assert_eq!(server.header(0, "range").as_deref(), Some("bytes=1048576-"));
        assert_eq!(server.header(1, "range"), None);
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    #[test]
    fn u0266_a_cancelled_download_keeps_its_part_outside_the_target_and_resumes_next_time() {
        let bytes = u0266_bytes(2 * MIB);
        let fixture = U0266::new("cancel", &bytes);
        // One server for both runs: a resume goes back to the same origin.
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"").stall(MIB), Scripted::partial(&bytes, MIB, "\"v1\"")]);
        block_on(async {
            let control = crate::downloads::DownloadControl::default();
            let task = control.begin("install", "fixture", "Fixture").unwrap();
            let download = fixture.run(&server, DownloadPolicy::Foreground(&control));
            tokio::pin!(download);
            let cancel = async {
                let part = fixture.store.root().join(format!("sha1-{}-{}.part", fixture.file.sha1, bytes.len()));
                tokio::time::timeout(Duration::from_secs(5), async {
                    while fs::metadata(&part).map_or(0, |meta| meta.len()) < MIB as u64 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                control.cancel(&task);
            };
            let (result, ()) = futures_util::future::join(download, cancel).await;
            assert!(result.unwrap_err().contains("任务已取消"));
        });
        assert_eq!(fixture.target_entries(), Vec::<String>::new(), "nothing beside the target");
        let parts = fixture.parts();
        assert!(parts.iter().any(|name| name.ends_with(".part")) && parts.iter().any(|name| name.ends_with(".json")), "{parts:?}");
        // A later run (a new task, or after a restart) continues from the recorded offset.
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).unwrap());
        assert_eq!(server.header(1, "range").as_deref(), Some("bytes=1048576-"));
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    #[test]
    fn u0266_a_part_held_elsewhere_falls_back_to_a_whole_download() {
        let bytes = u0266_bytes(MIB + 10);
        let fixture = U0266::new("held", &bytes);
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha1, &fixture.file.sha1, bytes.len() as u64).unwrap();
        let held = fixture.store.open(&key, bytes.len() as u64).unwrap().unwrap();
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"")]);
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).unwrap());
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
        assert_eq!(server.header(0, "range"), None);
        // On disk, not only in memory: the held part and its folder are untouched.
        assert_eq!(fixture.parts(), [format!("sha1-{}-{}.lock", fixture.file.sha1, bytes.len()), format!("sha1-{}-{}.part", fixture.file.sha1, bytes.len())]);
        assert_eq!(fs::metadata(fixture.store.root().join(format!("sha1-{}-{}.part", fixture.file.sha1, bytes.len()))).unwrap().len(), 0);
        assert!(fixture.store.open(&key, bytes.len() as u64).unwrap().is_none(), "still held");
        drop(held);
    }

    #[test]
    fn u0266_small_files_never_create_parts() {
        let bytes = u0266_bytes(MIB - 1);
        let fixture = U0266::new("small", &bytes);
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"").cut(1000), Scripted::ok(&bytes, "\"v1\"")]);
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).unwrap());
        assert_eq!(server.header(1, "range"), None, "a small file is fetched whole again");
        assert!(!fixture.store.root().exists(), "no parts folder for small files");
    }

    #[test]
    fn u0266_a_stalled_transfer_fails_after_the_stall_limit_and_resumes() {
        let bytes = u0266_bytes(2 * MIB);
        let fixture = U0266::new("stall", &bytes);
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"").stall(MIB), Scripted::partial(&bytes, MIB, "\"v1\"")]);
        let control = crate::downloads::DownloadControl::default();
        // Generous enough for a loaded machine, well below the server's 10 s hold.
        control.set_stall_limit(Duration::from_secs(2));
        let _task = control.begin("install", "fixture", "Fixture").unwrap();
        let started = std::time::Instant::now();
        assert!(block_on(fixture.run(&server, DownloadPolicy::Foreground(&control))).unwrap());
        assert!(started.elapsed() < Duration::from_secs(8), "the stall ended the attempt, not the server's release");
        assert_eq!(server.header(1, "range").as_deref(), Some("bytes=1048576-"));
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    #[test]
    fn u0266_attempts_that_add_bytes_do_not_use_up_the_retry_budget() {
        let bytes = u0266_bytes(5 * MIB);
        let fixture = U0266::new("budget", &bytes);
        // Five interrupted attempts, each adding one MiB: more than the three a single source gets.
        let mut script = vec![Scripted::ok(&bytes, "\"v1\"").cut(MIB)];
        for from in 1..5 {
            script.push(Scripted::partial(&bytes, from * MIB, "\"v1\"").cut(if from < 4 { MIB } else { usize::MAX }));
        }
        let server = RangeServer::new(script);
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).unwrap());
        assert_eq!(server.count(), 5);
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    const OFFICIAL_PATH: &str = "/piston-data.mojang.com/";

    #[test]
    fn u0266_a_discarded_part_gets_one_fresh_fetch_from_the_same_source() {
        let bytes = u0266_bytes(2 * MIB);
        let fixture = U0266::new("discard-auto", &bytes);
        // A complete part that fails its check: discarded without a request.
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha1, &fixture.file.sha1, bytes.len() as u64).unwrap();
        let mut part = fixture.store.open(&key, bytes.len() as u64).unwrap().unwrap();
        part.restart(crate::parts::Validator::default()).unwrap();
        let mut damaged = bytes.clone();
        damaged[0] ^= 1;
        part.append(&damaged).unwrap();
        drop(part);
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"")]);
        // "auto": official first, then the mirror, one attempt each.
        assert!(block_on(fixture.run_from(&server, DownloadPolicy::Uncapped, "auto")).unwrap());
        assert_eq!(server.count(), 1);
        assert!(server.header(0, ":path").unwrap().starts_with(OFFICIAL_PATH), "the official source fetched it again from zero");
        assert_eq!(server.header(0, "range"), None);
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    #[test]
    fn u0266_a_source_that_keeps_adding_bytes_leaves_a_try_for_the_fallback() {
        let bytes = u0266_bytes(16 * MIB);
        let fixture = U0266::new("reserve", &bytes);
        // "bmclapi": the mirror first, official as the fallback. The mirror adds one MiB per try.
        let mut script = vec![Scripted::ok(&bytes, "\"v1\"").cut(MIB)];
        for from in 1..11 {
            script.push(Scripted::partial(&bytes, from * MIB, "\"v1\"").cut(MIB));
        }
        script.push(Scripted::partial(&bytes, 11 * MIB, "\"v1\""));
        let server = RangeServer::new(script);
        assert!(block_on(fixture.run_from(&server, DownloadPolicy::Uncapped, "bmclapi")).unwrap());
        assert_eq!(server.count(), 12);
        for index in 0..11 {
            assert!(!server.header(index, ":path").unwrap().starts_with(OFFICIAL_PATH), "try {index} went to the mirror");
        }
        assert!(server.header(11, ":path").unwrap().starts_with(OFFICIAL_PATH), "the last try was kept for official");
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    #[test]
    fn u0266_a_server_that_always_starts_over_uses_up_the_attempts() {
        let bytes = u0266_bytes(5 * MIB);
        let fixture = U0266::new("restarts", &bytes);
        // Every answer is a whole-file 200 cut a little further each time.
        let mut script: Vec<_> = (1..5).map(|mib| Scripted::ok(&bytes, "\"v1\"").cut(mib * MIB)).collect();
        script.push(Scripted::ok(&bytes, "\"v1\""));
        let server = RangeServer::new(script);
        assert!(block_on(fixture.run(&server, DownloadPolicy::Uncapped)).is_err());
        // The first try is free (it started an empty part); the three restarts are charged.
        assert_eq!(server.count(), 4);
        assert!(!fixture.file.path.exists());
    }

    #[test]
    fn u0266_parts_go_under_the_root_that_holds_the_target() {
        let game = Path::new("D:\\Games\\MC");
        let data = Path::new("C:\\Users\\x\\AppData\\Local\\dev.voxelight.launcher");
        let parts = |root: &Path| root.join(".launcher-temp").join("parts");
        assert_eq!(part_root_for(Some(game.to_path_buf()), data, &game.join("libraries").join("a.jar")), Some(parts(game)));
        assert_eq!(part_root_for(Some(game.to_path_buf()), data, &data.join("runtimes").join("java.exe")), Some(parts(data)));
        assert_eq!(part_root_for(None, data, &data.join("runtimes").join("java.exe")), Some(parts(data)));
        assert_eq!(part_root_for(Some(game.to_path_buf()), data, Path::new("E:\\elsewhere\\server.jar")), None);
        assert_eq!(part_root_for(Some(PathBuf::from("relative")), data, Path::new("relative\\a.jar")), None);
    }

    #[test]
    fn u0266_the_launcher_picks_parts_through_the_canonical_game_root() {
        // The configured spelling differs from the canonical one (case); the
        // install builds its targets from the canonical root.
        let directory = source_test_directory("u0266-canonical");
        let game = directory.join("Game");
        fs::create_dir_all(&game).unwrap();
        let spelled = PathBuf::from(game.to_string_lossy().to_ascii_lowercase());
        let canonical = crate::processes::configured_game_root(&game).unwrap();
        let mut data = crate::models::Persisted::default();
        data.config.game_directory = spelled.to_string_lossy().into_owned();
        let state = LauncherState::test_fixture(directory.join("profile"), data, crate::storage::test_client());
        let file = Download {
            path: canonical.join("libraries").join("big.jar"),
            url: "https://libraries.minecraft.net/big.jar".into(),
            sha1: "a".repeat(40),
            size: Some(2 * MIB as u64),
        };
        let store = part_store_for(&state, &file).expect("a large file under the game root resumes");
        assert_eq!(store.root(), canonical.join(".launcher-temp").join("parts"));
        assert!(part_store_for(&state, &Download { size: Some(1000), ..file.clone() }).is_none(), "small files do not");
        drop(state);
        let _ = fs::remove_dir_all(&directory);
    }

    /// Routes the mirror host to one server and every other host to another.
    fn two_servers(official: &RangeServer, mirror: &RangeServer) -> impl Fn(&str) -> String + Sync {
        let (official, mirror) = (official.address.clone(), mirror.address.clone());
        move |url: &str| {
            let host = reqwest::Url::parse(url).unwrap().host_str().unwrap_or_default().to_owned();
            TestServer::resolve(if host == BMCLAPI_HOST { &mirror } else { &official }, url)
        }
    }

    async fn run_routed(fixture: &U0266, resolve: &(dyn Fn(&str) -> String + Sync), source: &str) -> Result<bool, String> {
        let client = crate::storage::test_client();
        ensure_download_with_policy(&client, Ok(Some(&client)), &fixture.file, source, DownloadPolicy::Uncapped, resolve, None, false, Some(&fixture.store)).await
    }

    fn sidecar(fixture: &U0266) -> serde_json::Value {
        let name = format!("sha1-{}-{}.json", fixture.file.sha1, fixture.file.size.unwrap());
        serde_json::from_slice(&fs::read(fixture.store.root().join(name)).unwrap()).unwrap()
    }

    #[test]
    fn u0266_a_later_source_never_throws_away_bytes_an_earlier_source_added() {
        let bytes = u0266_bytes(2 * MIB);
        let fixture = U0266::new("protect", &bytes);
        // "bmclapi": the mirror adds 1 MiB, then fails; official's one try is cut too.
        let mirror = RangeServer::new(vec![Scripted::ok(&bytes, "\"m\"").cut(MIB), Scripted::status(503)]);
        let official = RangeServer::new(vec![Scripted::ok(&bytes, "\"o\"").cut(MIB / 2)]);
        let resolve = two_servers(&official, &mirror);
        assert!(block_on(run_routed(&fixture, &resolve, "bmclapi")).is_err());
        assert_eq!(official.header(0, "range"), None);
        let record = sidecar(&fixture);
        assert_eq!(record["done"], MIB as u64, "official fetched in one go and left the mirror's bytes");
        assert_eq!(record["validator"]["origin"], format!("http://{}", mirror.address));
        // Next run: the mirror continues its own bytes.
        drop((mirror, official));
        let mirror = RangeServer::new(vec![Scripted::partial(&bytes, MIB, "\"m\"")]);
        let official = RangeServer::new(vec![]);
        let resolve = two_servers(&official, &mirror);
        // The new server listens elsewhere: point the kept bytes at it, as the same host would be.
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha1, &fixture.file.sha1, bytes.len() as u64).unwrap();
        let mut part = fixture.store.open(&key, bytes.len() as u64).unwrap().unwrap();
        let mut kept = vec![0u8; 0];
        part.hash_prefix(|piece| kept.extend_from_slice(piece)).unwrap();
        part.restart(crate::parts::Validator { origin: format!("http://{}", mirror.address), etag: Some("\"m\"".into()), last_modified: None }).unwrap();
        part.append(&kept).unwrap();
        drop(part);
        assert!(block_on(run_routed(&fixture, &resolve, "bmclapi")).unwrap());
        assert_eq!(mirror.header(0, "range").as_deref(), Some("bytes=1048576-"));
        assert_eq!(mirror.header(0, "if-range").as_deref(), Some("\"m\""));
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    #[test]
    fn u0266_bytes_left_by_another_source_in_an_earlier_run_still_restart_from_zero() {
        let bytes = u0266_bytes(2 * MIB);
        let fixture = U0266::new("foreign", &bytes);
        let key = crate::parts::PartKey::new(crate::parts::Algo::Sha1, &fixture.file.sha1, bytes.len() as u64).unwrap();
        let mut part = fixture.store.open(&key, bytes.len() as u64).unwrap().unwrap();
        part.restart(crate::parts::Validator { origin: "https://bmclapi2.bangbang93.com".into(), etag: Some("\"v1\"".into()), last_modified: None }).unwrap();
        part.append(&bytes[..MIB]).unwrap();
        drop(part);
        // "auto": official first. Its first try restarts the foreign part (not charged),
        // the second continues its own bytes.
        let server = RangeServer::new(vec![Scripted::ok(&bytes, "\"v1\"").cut(MIB), Scripted::partial(&bytes, MIB, "\"v1\"")]);
        assert!(block_on(fixture.run_from(&server, DownloadPolicy::Uncapped, "auto")).unwrap());
        assert_eq!(server.count(), 2);
        assert!(server.header(0, ":path").unwrap().starts_with(OFFICIAL_PATH));
        assert!(server.header(1, ":path").unwrap().starts_with(OFFICIAL_PATH), "official kept its turn");
        assert_eq!(server.header(0, "range"), None);
        assert_eq!(server.header(1, "range").as_deref(), Some("bytes=1048576-"));
        assert_eq!(fs::read(&fixture.file.path).unwrap(), bytes);
    }

    #[test]
    fn u0266_a_rejected_strict_mirror_is_recorded_once() {
        let source = crate::storage::executable_source(include_str!("minecraft.rs"));
        let (_, body) = source.split_once("async fn ensure_download_with_policy(").unwrap();
        let (body, _) = body.split_once("\n}").unwrap();
        assert_eq!(body.matches("record_loader_mirror_fallback(").count(), 1);
        let record = body.find("record_loader_mirror_fallback(").unwrap();
        let attempts = body.find("while attempt < attempts").unwrap();
        let loop_end = body[attempts..].find("\n        }\n").map(|end| attempts + end).unwrap();
        assert!(record > loop_end, "after the candidate's tries, not inside them");
    }
}

#[cfg(test)]
mod managed_runtime_path_tests {
    use super::*;

    #[test]
    fn java_discovery_sees_the_active_profile_runtime_without_executing_candidate() {
        let fixture = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/core-tests")
                .join(format!("managed-java-{}", uuid::Uuid::new_v4())),
        ).unwrap();
        // Candidate bytes are deliberately not executable; discovery scans
        // filesystem locations independently of running java -version.
        let active = fixture.path().join("active-fallback");
        let game = fixture.path().join("isolated-game");
        let sentinels = [
            active.join("runtimes/java-runtime-gamma/fixture/bin/java.exe"),
            game.join("runtime/fixture/bin/java.exe"),
            fixture.path().join("nominal-primary/runtimes/fixture/bin/java.exe"),
        ];
        for file in &sentinels {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file,b"test path only").unwrap();
        }
        let config = Config { game_directory: game.to_string_lossy().into_owned(), ..Config::default() };
        let found = java_candidates(&config, &active);
        assert!(found.contains(&sentinels[0]));
        assert!(!found.contains(&sentinels[1]), "a game folder is not permission to probe executables");
        assert!(!found.contains(&sentinels[2]));
    }
}
