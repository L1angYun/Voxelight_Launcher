//! Loader APIs are consumed from their publishers. No installer source is bundled.
use crate::{
    minecraft::{self, Download},
    path_grants::{PathGrants, PathUse},
    storage::{safe_join, validate_id, LauncherState},
};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};
use tokio::io::BufReader;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderVersion {
    pub id: String,
    pub stable: bool,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderInstallResult {
    pub version_id: String,
    pub loader: String,
    pub loader_version: String,
}

fn loader_name(loader: &str) -> Result<&str, String> {
    match loader {
        "fabric" | "quilt" | "forge" | "neoforge" | "optifine" => Ok(loader),
        _ => Err("不支持的加载器；请选择 Fabric、Quilt、Forge、NeoForge 或 OptiFine".into()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OptifineJarInfo {
    pub mc_version: String,
    pub edition: String,
    pub launchwrapper_entry: Option<String>,
    pub launchwrapper_version: Option<String>,
}

fn parse_optifine_filename(file_name: &str) -> Option<(String, String)> {
    let stem = file_name.strip_suffix(".jar").or_else(|| file_name.strip_suffix(".JAR"))?;
    let rest = stem
        .strip_prefix("preview_OptiFine_")
        .or_else(|| stem.strip_prefix("OptiFine_"))?;
    let (mc, edition) = rest.split_once('_')?;
    if mc.is_empty() || edition.is_empty() || validate_id(mc).is_err() || validate_id(edition).is_err() {
        return None;
    }
    Some((mc.to_owned(), edition.to_owned()))
}

pub(crate) fn parse_optifine_installer_jar(path: &Path) -> Result<OptifineJarInfo, String> {
    let meta = fs::metadata(path).map_err(|_| "无法读取 OptiFine 安装器 JAR")?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 256 * 1024 * 1024 {
        return Err("OptiFine 安装器 JAR 大小无效或超过 256 MiB".into());
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("OptiFine 文件名无效")?;
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(|_| "无法打开 OptiFine JAR")?)
        .map_err(|_| "所选文件不是有效的 OptiFine JAR")?;
    let has_patcher = zip.by_name("optifine/Patcher.class").is_ok();
    let has_tweaker = zip.by_name("optifine/OptiFineTweaker.class").is_ok();
    if !has_patcher || !has_tweaker {
        return Err("所选 JAR 不是有效的 OptiFine 安装器（缺少 Patcher/OptiFineTweaker）".into());
    }
    let mut launchwrapper_entry = None;
    let mut launchwrapper_version = None;
    for i in 0..zip.len() {
        let Ok(entry) = zip.by_index(i) else { continue };
        let Ok(name) = entry.name() else { continue };
        if let Some(rest) = name.strip_prefix("launchwrapper-of-").and_then(|s| s.strip_suffix(".jar")) {
            if !rest.is_empty() && validate_id(rest).is_ok() {
                launchwrapper_version = Some(rest.to_owned());
                launchwrapper_entry = Some(name.into_owned());
                break;
            }
        }
    }
    let (mc_version, edition) = parse_optifine_filename(file_name)
        .ok_or("无法从文件名识别 OptiFine 对应的 Minecraft 版本（应类似 OptiFine_1.20.4_HD_U_I7.jar）")?;
    Ok(OptifineJarInfo {
        mc_version,
        edition,
        launchwrapper_entry,
        launchwrapper_version,
    })
}

pub(crate) fn build_optifine_profile(
    base: &Value,
    mc_version: &str,
    edition: &str,
    launchwrapper_version: Option<&str>,
) -> Value {
    let id = format!("{mc_version}-OptiFine_{edition}");
    let version_type = base["type"].as_str().unwrap_or("release");
    let mut libraries = vec![json!({
        "name": format!("optifine:OptiFine:{mc_version}_{edition}")
    })];
    if let Some(lw) = launchwrapper_version {
        libraries.push(json!({
            "name": format!("optifine:launchwrapper-of:{lw}")
        }));
    } else {
        libraries.push(json!({
            "name": "net.minecraft:launchwrapper:1.12",
            "url": "https://libraries.minecraft.net/"
        }));
    }
    let mut profile = json!({
        "id": id,
        "inheritsFrom": mc_version,
        "type": version_type,
        "mainClass": "net.minecraft.launchwrapper.Launch",
        "libraries": libraries,
        "launcherMetadata": {
            "loader": "optifine",
            "loaderVersion": edition,
            "officialVanillaBase": mc_version
        }
    });
    if base.get("arguments").is_some() {
        profile["arguments"] = json!({
            "game": ["--tweakClass", "optifine.OptiFineTweaker"]
        });
    } else {
        let base_args = base["minecraftArguments"].as_str().unwrap_or("");
        profile["minecraftArguments"] = json!(format!("{base_args} --tweakClass optifine.OptiFineTweaker").trim().to_owned());
    }
    profile
}

fn optifine_bmclapi_versions(bytes: &[u8]) -> Result<Vec<(String, String, LoaderVersion)>, String> {
    let value = minecraft::parse_json(bytes)?;
    let list = value.as_array().ok_or("OptiFine 版本列表格式无效")?;
    let mut out = Vec::new();
    for item in list {
        let Some(kind) = item["type"].as_str() else { continue };
        let Some(patch) = item["patch"].as_str() else { continue };
        let id = format!("{kind}_{patch}");
        if validate_id(kind).is_err() || validate_id(patch).is_err() || validate_id(&id).is_err() {
            continue;
        }
        let stable = !patch.to_ascii_lowercase().contains("pre");
        out.push((
            kind.to_owned(),
            patch.to_owned(),
            LoaderVersion {
                id,
                stable,
                recommended: false,
            },
        ));
    }
    Ok(out)
}

fn version_numbers(version: &str) -> Vec<u64> {
    version
        .split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

fn neo_prefix(game_version: &str) -> String {
    let value = game_version.strip_prefix("1.").unwrap_or(game_version);
    if value.contains('.') {
        format!("{value}.")
    } else {
        format!("{value}.0.")
    }
}

fn maven_versions(bytes: &[u8], prefix: &str, strip: bool) -> Result<Vec<LoaderVersion>, String> {
    let xml = std::str::from_utf8(bytes).map_err(|_| "Maven 元数据编码无效")?;
    let pattern = regex::Regex::new(r"<version>([^<]+)</version>").map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    let mut parsed = false;
    for capture in pattern.captures_iter(xml) {
        parsed = true;
        let coordinate = capture[1].trim();
        if let Some(rest) = coordinate.strip_prefix(prefix) {
            let id = if strip { rest } else { coordinate };
            validate_id(id)?;
            results.push(LoaderVersion {id:id.into(),stable:!id.contains("beta") && !id.contains("alpha"),recommended:false});
        }
    }
    if !parsed {
        return Err("Maven 元数据缺少版本列表".into());
    }
    Ok(results)
}

async fn loader_versions_fallback<F>(
    primary: impl std::future::Future<Output = Result<Vec<LoaderVersion>, String>>,
    fallback: impl FnOnce() -> F,
) -> Result<Vec<LoaderVersion>, String>
where F: std::future::Future<Output = Result<Vec<LoaderVersion>, String>>,
{
    let first = primary.await;
    if first.as_ref().is_ok_and(|versions| !versions.is_empty()) {
        return first;
    }
    match (first, fallback().await) {
        (_, Ok(versions)) => Ok(versions),
        (Ok(empty), Err(_)) => Ok(empty),
        (Err(first), Err(second)) => Err(format!("NeoForge 版本列表获取失败：{first}；{second}")),
    }
}

pub async fn loader_versions(
    state: &LauncherState,
    loader: &str,
    game_version: &str,
) -> Result<Vec<LoaderVersion>, String> {
    loader_name(loader)?;
    validate_id(game_version)?;
    // A list request; the install path cancels it through controlled_loader_fetch.
    let source = crate::source_select::passive_download_source(state, &state.snapshot()?.config.download_source).await?;
    let mut result;
    match loader {
        "fabric" | "quilt" => {
            let base = if loader == "fabric" {
                "https://meta.fabricmc.net/v2"
            } else {
                "https://meta.quiltmc.org/v3"
            };
            result = minecraft::fetch_loader_versions(
                state,
                &format!("{base}/versions/loader/{game_version}"),
                16 * 1024 * 1024,
                &source,
                |bytes| {
                    let metadata = minecraft::parse_json(bytes)?;
                    let mut versions = Vec::new();
                    for item in metadata.as_array().ok_or("加载器版本列表无效")? {
                        let Some(id) = item["loader"]["version"].as_str() else { continue; };
                        validate_id(id)?;
                        let stable = item["loader"]["stable"].as_bool().unwrap_or(!id.contains("beta") && !id.contains("alpha"));
                        versions.push(LoaderVersion {id:id.into(), stable, recommended:false});
                    }
                    Ok(versions)
                },
            ).await?;
        }
        "forge" => {
            result = minecraft::fetch_loader_versions(
                state,
                "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
                16 * 1024 * 1024,
                &source,
                |xml| maven_versions(xml, &format!("{game_version}-"), true),
            ).await?;
            let promotions = minecraft::fetch_bytes(
                state.client()?,
                "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
                2 * 1024 * 1024,
            )
            .await
            .ok()
            .and_then(|b| minecraft::parse_json(&b).ok());
            if let Some(recommended) = promotions
                .as_ref()
                .and_then(|p| p["promos"][format!("{game_version}-recommended")].as_str())
            {
                for version in &mut result {
                    version.recommended = version.id == recommended;
                }
            }
        }
        "neoforge" => {
            if game_version == "1.20.1" {
                result = minecraft::fetch_loader_versions(
                    state,
                    "https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml",
                    16 * 1024 * 1024,
                    &source,
                    |xml| maven_versions(xml, "1.20.1-", true),
                ).await?;
            } else {
                let official = || async {
                    let bytes = minecraft::fetch_bytes(
                        state.client()?,
                        "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
                        8 * 1024 * 1024,
                    ).await?;
                    let metadata = minecraft::parse_json(&bytes)?;
                    let prefix = neo_prefix(game_version);
                    let mut versions = Vec::new();
                    for id in metadata["versions"].as_array().ok_or("NeoForge Maven 版本列表无效")?
                        .iter().filter_map(Value::as_str).filter(|id| id.starts_with(&prefix))
                    {
                        validate_id(id)?;
                        versions.push(LoaderVersion { id: id.into(), stable: !id.contains("beta") && !id.contains("alpha"), recommended: false });
                    }
                    Ok(versions)
                };
                let xml = || async {
                    minecraft::fetch_loader_versions(
                        state,
                        "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
                        16 * 1024 * 1024,
                        &source,
                        |xml| maven_versions(xml, &neo_prefix(game_version), false),
                    ).await
                };
                result = match source.as_str() {
                    "bmclapi" => loader_versions_fallback(xml(), official).await?,
                    "auto" => loader_versions_fallback(official(), xml).await?,
                    _ => official().await?,
                };
            }
        }
        "optifine" => {
            if source == "official" {
                result = Vec::new();
            } else {
                let url = format!("https://bmclapi2.bangbang93.com/optifine/{game_version}");
                let bytes = minecraft::fetch_bytes(state.client()?, &url, 4 * 1024 * 1024).await?;
                result = optifine_bmclapi_versions(&bytes)?
                    .into_iter()
                    .map(|(_, _, version)| version)
                    .collect();
            }
        }
        _ => unreachable!(),
    }
    let mut seen = HashSet::new();
    result.retain(|version| seen.insert(version.id.clone()));
    result.sort_by(|a, b| {
        version_numbers(&b.id)
            .cmp(&version_numbers(&a.id))
            .then(a.id.cmp(&b.id))
    });
    if !result.iter().any(|version| version.recommended) {
        if let Some(version) = result.iter_mut().find(|version| version.stable) {
            version.recommended = true;
        }
    }
    result.truncate(200);
    Ok(result)
}

#[tauri::command]
pub async fn list_loader_versions(
    state: State<'_, Arc<LauncherState>>,
    loader: String,
    game_version: String,
) -> Result<Vec<LoaderVersion>, String> {
    loader_versions(&state, &loader, &game_version).await
}

/// Resolves publisher checksums and saves them into the installed child profile, so
/// subsequent offline launches can verify libraries without fetching sidecars again.
async fn prepare_profile(
    state: &LauncherState,
    app: &AppHandle,
    profile: &mut Value,
    root: &Path,
) -> Result<(), String> {
    let id = profile["id"]
        .as_str()
        .ok_or("加载器配置缺少 ID")?
        .to_owned();
    let libraries = safe_join(root, "libraries")?;
    let values = profile["libraries"]
        .as_array_mut()
        .ok_or("加载器配置缺少依赖库数组")?;
    let total = values.len();
    let source = crate::source_select::effective_download_source(state, &state.snapshot()?.config.download_source).await?;
    for (index, library) in values.iter_mut().enumerate() {
        state.control.checkpoint().await?;
        if !minecraft::rules_allow(library.get("rules")) {
            continue;
        }
        if let Some(download) = minecraft::library_download(state, library, &libraries).await? {
            minecraft::ensure_loader_download(state, &download, &source, Some(&state.control))
                .await?;
            let relative = download
                .path
                .strip_prefix(&libraries)
                .map_err(|_| "加载器依赖路径越界")?
                .to_string_lossy()
                .replace('\\', "/");
            let size = fs::metadata(&download.path)
                .map_err(|e| e.to_string())?
                .len();
            library["downloads"]["artifact"] =
                json!({"path":relative,"url":download.url,"sha1":download.sha1,"size":size});
        }
        minecraft::progress(
            app,
            state,
            &id,
            "loader-libraries",
            index + 1,
            total,
            0,
            0,
            format!("验证加载器依赖 {}/{}", index + 1, total),
        );
    }
    Ok(())
}

fn write_profile(root: &Path, profile: &Value) -> Result<String, String> {
    let id = profile["id"].as_str().ok_or("加载器版本 ID 缺失")?;
    validate_id(id)?;
    let destination = safe_join(root, &format!("versions/{id}/{id}.json"))?;
    fs::create_dir_all(destination.parent().ok_or("版本路径无效")?).map_err(|e| e.to_string())?;
    if destination.is_file() {
        let backup = destination.with_extension(format!("json.backup-{}", uuid::Uuid::new_v4()));
        fs::copy(&destination, backup).map_err(|e| format!("备份现有加载器配置失败：{e}"))?;
    }
    let temporary = destination.with_extension(format!("json-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(profile).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, destination).map_err(|e| e.to_string())?;
    Ok(id.into())
}

fn validate_profile(profile: &Value, game_version: &str) -> Result<(), String> {
    validate_id(profile["id"].as_str().ok_or("加载器 profile 缺少 ID")?)?;
    if profile["inheritsFrom"].as_str() != Some(game_version) {
        return Err("加载器 profile 的原版依赖与所选版本不一致".into());
    }
    let main_class = profile["mainClass"]
        .as_str()
        .ok_or("加载器 profile 缺少主类")?;
    if main_class.is_empty()
        || main_class
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || "._$".contains(c)))
    {
        return Err("加载器主类格式无效".into());
    }
    if !profile["libraries"].is_array() {
        return Err("加载器未提供依赖列表".into());
    }
    Ok(())
}

async fn lightweight_loader(
    state: &LauncherState,
    app: &AppHandle,
    loader: &str,
    game_version: &str,
    version: &str,
    root: &Path,
) -> Result<String, String> {
    let base = if loader == "fabric" {
        "https://meta.fabricmc.net/v2"
    } else {
        "https://meta.quiltmc.org/v3"
    };
    let url = format!("{base}/versions/loader/{game_version}/{version}/profile/json");
    let bytes = controlled_loader_fetch(&state.control, minecraft::fetch_bytes(state.client()?, &url, 8 * 1024 * 1024)).await?;
    let mut profile = minecraft::parse_json(&bytes)?;
    validate_profile(&profile, game_version)?;
    let class = profile["mainClass"].as_str().unwrap_or_default();
    let expected = if loader == "fabric" {
        "net.fabricmc."
    } else {
        "org.quiltmc."
    };
    if !class.starts_with(expected) {
        return Err("加载器官方 API 返回了非预期启动入口".into());
    }
    prepare_profile(state, app, &mut profile, root).await?;
    profile["launcherMetadata"] = json!({"source":url,"loader":loader,"loaderVersion":version,"officialVanillaBase":game_version});
    write_profile(root, &profile)
}

fn read_zip_json(path: &Path, name: &str) -> Result<Value, String> {
    let input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(input).map_err(|e| e.to_string())?;
    let mut entry = archive
        .by_name(name.trim_start_matches('/'))
        .map_err(|e| format!("安装器缺少 {name}：{e}"))?;
    if entry.size() > 8 * 1024 * 1024 {
        return Err("安装器元数据超出大小限制".into());
    }
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    minecraft::parse_json(&bytes)
}

fn installer_cache_path(root: &Path, file: &str, digest: &str, source: &str) -> Result<PathBuf, String> {
    if !minecraft::valid_sha1(digest) {
        return Err("官方安装器校验值无效，请切换到官方源重试".into());
    }
    let lane = match source {
        "official" => "official",
        "auto" | "bmclapi" => "verified-mirror",
        _ => return Err("下载源无效".into()),
    };
    safe_join(root, &format!("installers/cache/{lane}/{digest}/{file}"))
}

async fn controlled_loader_fetch<T>(
    control: &crate::downloads::DownloadControl,
    request: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    control.checkpoint().await?;
    crate::download_io::cancellable(Some(control), request).await?
}

async fn installer_jar(
    state: &LauncherState,
    loader: &str,
    game_version: &str,
    version: &str,
) -> Result<PathBuf, String> {
    let (coordinate, name, base) = if loader == "forge" {
        (
            format!("{game_version}-{version}"),
            "forge",
            "https://maven.minecraftforge.net/net/minecraftforge/forge",
        )
    } else if game_version == "1.20.1" {
        (
            format!("{game_version}-{version}"),
            "forge",
            "https://maven.neoforged.net/releases/net/neoforged/forge",
        )
    } else {
        (
            version.into(),
            "neoforge",
            "https://maven.neoforged.net/releases/net/neoforged/neoforge",
        )
    };
    let file = format!("{name}-{coordinate}-installer.jar");
    let url = format!("{base}/{coordinate}/{file}");
    let checksum = controlled_loader_fetch(&state.control, minecraft::fetch_official_installer_sha1(state.client()?, &url)).await?;
    let source = crate::source_select::effective_download_source(state, &state.snapshot()?.config.download_source).await?;
    let download = Download {
        path: installer_cache_path(&state.data_dir, &file, &checksum, &source)?,
        url,
        sha1: checksum,
        size: None,
    };
    minecraft::ensure_loader_download(state, &download, &source, Some(&state.control)).await?;
    Ok(download.path)
}

async fn read_process_output<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    state: &LauncherState,
    app: &AppHandle,
    loader: &str,
    level: &str,
) -> Result<(), String> {
    let mut lines = BufReader::new(reader);
    while let Some(line) = minecraft::next_process_line(&mut lines).await? {
        minecraft::log(app, state, level, format!("[{loader} installer] {line}"));
    }
    Ok(())
}

fn installer_command(java: &Path, jar: &Path, stage: &Path, temp: &Path, proxy: &crate::network::Settings) -> Result<tokio::process::Command, String> {
    use crate::storage::{process_path_text, to_process_path};
    let proxy_args = proxy.installer_args().map_err(|error| error.code().to_owned())?;
    let mut command = tokio::process::Command::new(to_process_path(java)?);
    command
        .arg(format!("-Djava.io.tmpdir={}", process_path_text(temp)?))
        .arg("-Dfile.encoding=UTF-8")
        .arg("-Djava.awt.headless=true")
        .args(proxy_args)
        .arg("-Dsun.stdout.encoding=UTF-8")
        .arg("-Dsun.stderr.encoding=UTF-8")
        .arg("-jar")
        .arg(to_process_path(jar)?)
        .arg("--installClient")
        .arg(to_process_path(stage)?)
        .current_dir(to_process_path(stage)?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    Ok(command)
}

async fn run_installer(
    state: &LauncherState,
    app: &AppHandle,
    java: &Path,
    jar: &Path,
    stage: &Path,
    loader: &str,
) -> Result<(), String> {
    state.control.checkpoint().await?;
    let temp = crate::storage::runtime_temp_directory(stage)?;
    let proxy = crate::network::Settings::from_config(&state.snapshot()?.config).map_err(|error| error.code().to_owned())?;
    let mut command = installer_command(java, jar, stage, &temp, &proxy)?;
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 {loader} 官方安装器失败：{e}"))?;
    let stdout = child.stdout.take().ok_or("无法读取安装器输出")?;
    let stderr = child.stderr.take().ok_or("无法读取安装器错误输出")?;
    let wait = async {
        let deadline = Instant::now() + Duration::from_secs(15 * 60);
        loop {
            if let Err(error) = state.control.checkpoint().await {
                let _ = child.kill().await;
                return Err(error);
            }
            if Instant::now() > deadline {
                let _ = child.kill().await;
                return Err("加载器安装器运行超过 15 分钟，已终止；详见启动器日志".into());
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!(
                        "{loader} 安装器失败，退出码 {:?}；详见启动器日志",
                        status.code()
                    ))
                };
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    futures_util::future::try_join3(
        wait,
        read_process_output(stdout, state, app, loader, "info"),
        read_process_output(stderr, state, app, loader, "warn"),
    )
    .await?;
    Ok(())
}

/// Only libraries under the new, launcher-owned stage can be committed. Saves,
/// options, profiles and unrelated files from the real game directory are untouched.
fn commit_staged_libraries(stage: &Path, root: &Path) -> Result<(), String> {
    let source_root = safe_join(stage, "libraries")?;
    if !source_root.is_dir() {
        return Err("官方安装器未产出依赖库目录".into());
    }
    let destination_root = safe_join(root, "libraries")?;
    let mut queue = VecDeque::from([String::new()]);
    let mut total = 0u64;
    let mut count = 0usize;
    while let Some(relative) = queue.pop_front() {
        let directory = if relative.is_empty() {
            source_root.clone()
        } else {
            safe_join(&source_root, &relative)?
        };
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            validate_id(&name)?;
            let relative = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let source = safe_join(&source_root, &relative)?;
            let metadata = fs::symlink_metadata(&source).map_err(|e| e.to_string())?;
            if metadata.is_dir() {
                queue.push_back(relative);
                continue;
            }
            if !metadata.is_file() {
                return Err("安装器产物包含非普通文件".into());
            }
            total = total
                .checked_add(metadata.len())
                .ok_or("安装器产物大小溢出")?;
            count += 1;
            if total > 4 * 1024 * 1024 * 1024 || count > 50_000 {
                return Err("安装器产物超出大小或数量限制".into());
            }
            let destination = safe_join(&destination_root, &relative)?;
            if destination.is_file()
                && fs::metadata(&destination).map_err(|e| e.to_string())?.len() == metadata.len()
            {
                fn digest(path: &Path) -> Result<Vec<u8>, String> {
                    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
                    let mut hasher = Sha256::new();
                    let mut buffer = [0; 128 * 1024];
                    loop {
                        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
                        if n == 0 {
                            break;
                        }
                        hasher.update(&buffer[..n]);
                    }
                    Ok(hasher.finalize().to_vec())
                }
                if digest(&source)? == digest(&destination)? {
                    continue;
                }
            }
            fs::create_dir_all(destination.parent().ok_or("依赖路径无效")?)
                .map_err(|e| e.to_string())?;
            let temporary =
                destination.with_extension(format!("launcher-{}.tmp", uuid::Uuid::new_v4()));
            fs::copy(source, &temporary).map_err(|e| e.to_string())?;
            fs::rename(temporary, destination).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The checked artifacts to prefetch, plus how many declared a remote URL that
/// the allowlist rejects. Those are left to the installer, as before C8, but
/// the caller logs that they were skipped.
fn installer_seed_downloads(stage: &Path, profile: &Value) -> Result<(Vec<Download>, usize), String> {
    let libraries_root = safe_join(stage, "libraries")?;
    let Some(libraries) = profile["libraries"].as_array() else {
        return Ok((Vec::new(), 0));
    };
    let mut files = Vec::new();
    let mut untrusted = 0;
    for library in libraries {
        let artifact = &library["downloads"]["artifact"];
        let url = artifact["url"].as_str().filter(|url| !url.is_empty());
        if url.is_some_and(|url| crate::storage::trusted_url(url).is_err()) {
            untrusted += 1;
            continue;
        }
        if artifact["sha1"].as_str().is_some_and(minecraft::valid_sha1)
            && artifact["path"].as_str().is_some()
            && url.is_some()
            && artifact["size"].as_u64().is_some()
        {
            files.push(minecraft::download_from(artifact, &libraries_root, None)?);
        }
    }
    Ok((files, untrusted))
}

async fn preseed_installer_libraries(state: &LauncherState, stage: &Path, profile: &Value) -> Result<(), String> {
    let source = crate::source_select::effective_download_source(state, &state.snapshot()?.config.download_source).await?;
    if source != "official" {
        // Check every explicit artifact path before downloading any of them.
        let (files, untrusted) = installer_seed_downloads(stage, profile)?;
        if untrusted > 0 {
            minecraft::record_loader_warning(&state.data_dir, &format!(
                "{untrusted} installer libraries declare a download address outside the allowlist; the installer fetches them itself"
            ));
        }
        for file in files {
            state.control.checkpoint().await?;
            minecraft::ensure_loader_download(state, &file, &source, Some(&state.control)).await?;
        }
    }
    Ok(())
}

async fn heavyweight_loader(
    state: &LauncherState,
    app: &AppHandle,
    loader: &str,
    game_version: &str,
    version: &str,
    root: &Path,
    base: &Value,
) -> Result<String, String> {
    let jar = installer_jar(state, loader, game_version, version).await?;
    let installer = read_zip_json(&jar, "install_profile.json")?;
    if installer["minecraft"].as_str() != Some(game_version) {
        return Err("官方安装器的 Minecraft 依赖与请求版本不一致".into());
    }
    let json_name = installer["json"].as_str().unwrap_or("version.json");
    let expected_profile = read_zip_json(&jar, json_name)?;
    validate_profile(&expected_profile, game_version)?;
    let expected_id = expected_profile["id"]
        .as_str()
        .ok_or("官方安装器缺少版本 ID")?;
    let stage = crate::instances::StagingDirectory::create(safe_join(
        &state.data_dir,
        &format!("installers/staging/{loader}-{}", uuid::Uuid::new_v4()),
    )?)?;
    let stage = stage.path();
    let base_json = safe_join(
        stage,
        &format!("versions/{game_version}/{game_version}.json"),
    )?;
    fs::create_dir_all(base_json.parent().ok_or("暂存路径无效")?).map_err(|e| e.to_string())?;
    fs::copy(
        safe_join(
            root,
            &format!("versions/{game_version}/{game_version}.json"),
        )?,
        &base_json,
    )
    .map_err(|e| e.to_string())?;
    fs::copy(
        safe_join(root, &format!("versions/{game_version}/{game_version}.jar"))?,
        safe_join(
            stage,
            &format!("versions/{game_version}/{game_version}.jar"),
        )?,
    )
    .map_err(|e| e.to_string())?;
    fs::write(stage.join("launcher_profiles.json"), b"{\"profiles\":{}}")
        .map_err(|e| e.to_string())?;
    let java =
        minecraft::select_or_install_java(state, app, &state.snapshot()?.config, base).await?;
    minecraft::log(
        app,
        state,
        "info",
        format!(
            "在独立暂存目录运行 {loader} 官方安装器：{}",
            stage.display()
        ),
    );
    minecraft::progress(
        app,
        state,
        expected_id,
        "loader-installer",
        0,
        1,
        0,
        0,
        "运行官方安装器及其客户端后处理",
    );
    preseed_installer_libraries(state, stage, &installer).await?;
    run_installer(state, app, Path::new(&java.path), &jar, stage, loader).await?;
    let output = safe_join(
        stage,
        &format!("versions/{expected_id}/{expected_id}.json"),
    )?;
    let mut profile = minecraft::parse_json(
        &fs::read(output).map_err(|e| format!("安装器未产出预期客户端配置：{e}"))?,
    )?;
    validate_profile(&profile, game_version)?;
    if profile["id"].as_str() != Some(expected_id) {
        return Err("安装器生成了非预期版本 ID".into());
    }
    commit_staged_libraries(stage, root)?;
    // This also verifies the generated patched/client jars with the checksums
    // carried by the publisher's version.json. A zero exit code alone is insufficient.
    prepare_profile(state, app, &mut profile, root).await?;
    profile["launcherMetadata"] = json!({"loader":loader,"loaderVersion":version,"officialVanillaBase":game_version,"installer":jar.file_name().unwrap_or_default().to_string_lossy()});
    write_profile(root, &profile)
}

async fn install_optifine_from_jar(
    state: &LauncherState,
    app: &AppHandle,
    jar_path: &Path,
    info: &OptifineJarInfo,
    root: &Path,
    base: &Value,
) -> Result<String, String> {
    let stage = crate::instances::StagingDirectory::create(safe_join(
        &state.data_dir,
        &format!("installers/staging/optifine-{}", uuid::Uuid::new_v4()),
    )?)?;
    let stage_path = stage.path();
    let vanilla_jar = safe_join(
        root,
        &format!("versions/{}/{}.jar", info.mc_version, info.mc_version),
    )?;
    if !vanilla_jar.is_file() {
        return Err("缺少对应 Minecraft 版本的客户端 JAR".into());
    }
    let output_jar = safe_join(
        stage_path,
        &format!(
            "libraries/optifine/OptiFine/{0}_{1}/OptiFine-{0}_{1}.jar",
            info.mc_version, info.edition
        ),
    )?;
    fs::create_dir_all(output_jar.parent().ok_or("OptiFine 暂存路径无效")?)
        .map_err(|e| e.to_string())?;

    if let (Some(entry_name), Some(lw_version)) =
        (&info.launchwrapper_entry, &info.launchwrapper_version)
    {
        let lw_dest = safe_join(
            stage_path,
            &format!("libraries/optifine/launchwrapper-of/{lw_version}/launchwrapper-of-{lw_version}.jar"),
        )?;
        fs::create_dir_all(lw_dest.parent().ok_or("launchwrapper 路径无效")?)
            .map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(fs::File::open(jar_path).map_err(|e| e.to_string())?)
            .map_err(|_| "无法读取 OptiFine 安装器压缩包")?;
        let mut entry = archive
            .by_name(entry_name)
            .map_err(|_| "OptiFine 安装器缺少 launchwrapper")?;
        if entry.size() > 16 * 1024 * 1024 {
            return Err("OptiFine 内置 launchwrapper 文件过大".into());
        }
        let mut out = fs::File::create(&lw_dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut (&mut entry).take(16 * 1024 * 1024 + 1), &mut out)
            .map_err(|e| e.to_string())?;
    }

    let java =
        minecraft::select_or_install_java(state, app, &state.snapshot()?.config, base).await?;
    let temp = crate::storage::runtime_temp_directory(stage_path)?;
    let mut command = tokio::process::Command::new(crate::storage::to_process_path(Path::new(&java.path))?);
    command
        .current_dir(crate::storage::to_process_path(stage_path)?)
        .arg(format!("-Djava.io.tmpdir={}", crate::storage::process_path_text(&temp)?))
        .arg("-cp")
        .arg(crate::storage::process_path_text(jar_path)?)
        .arg("optifine.Patcher")
        .arg(crate::storage::process_path_text(&vanilla_jar)?)
        .arg(crate::storage::process_path_text(jar_path)?)
        .arg(crate::storage::process_path_text(&output_jar)?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);

    minecraft::progress(
        app,
        state,
        &format!("{}-OptiFine_{}", info.mc_version, info.edition),
        "loader-installer",
        0,
        1,
        0,
        0,
        "生成 OptiFine 补丁客户端库",
    );
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 OptiFine Patcher：{e}"))?;
    let stdout = child.stdout.take().ok_or("无法读取 OptiFine Patcher 输出")?;
    let stderr = child.stderr.take().ok_or("无法读取 OptiFine Patcher 错误输出")?;
    let wait = async {
        let deadline = Instant::now() + Duration::from_secs(5 * 60);
        loop {
            if let Err(error) = state.control.checkpoint().await {
                let _ = child.kill().await;
                return Err(error);
            }
            if Instant::now() > deadline {
                let _ = child.kill().await;
                return Err("OptiFine Patcher 运行超时，已终止".into());
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(format!("OptiFine Patcher 失败，退出码 {:?}", status.code()))
                };
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    };
    futures_util::future::try_join3(
        wait,
        read_process_output(stdout, state, app, "optifine", "info"),
        read_process_output(stderr, state, app, "optifine", "warn"),
    )
    .await?;

    if !output_jar.is_file() || fs::metadata(&output_jar).map_err(|e| e.to_string())?.len() == 0 {
        return Err("OptiFine Patcher 未产出有效的库文件".into());
    }
    let mut profile = build_optifine_profile(
        base,
        &info.mc_version,
        &info.edition,
        info.launchwrapper_version.as_deref(),
    );
    validate_profile(&profile, &info.mc_version)?;
    commit_staged_libraries(stage_path, root)?;
    prepare_profile(state, app, &mut profile, root).await?;
    write_profile(root, &profile)
}

async fn optifine_online_loader(
    state: &LauncherState,
    app: &AppHandle,
    game_version: &str,
    version: &str,
    root: &Path,
    base: &Value,
) -> Result<String, String> {
    let source = crate::source_select::effective_download_source(state, &state.snapshot()?.config.download_source).await?;
    if source == "official" {
        return Err("仅官方源模式下无法在线下载 OptiFine；请切换为自动/BMCLAPI 下载源，或导入本地 OptiFine 安装器 JAR".into());
    }
    let list_url = format!("https://bmclapi2.bangbang93.com/optifine/{game_version}");
    let bytes = controlled_loader_fetch(&state.control, minecraft::fetch_bytes(state.client()?, &list_url, 4 * 1024 * 1024)).await?;
    let (kind, patch, _) = optifine_bmclapi_versions(&bytes)?
        .into_iter()
        .find(|(_, _, item)| item.id == version)
        .ok_or("所选 OptiFine 版本不在对应游戏版本的列表中")?;
    let download_url = format!("https://bmclapi2.bangbang93.com/optifine/{game_version}/{kind}/{patch}");
    let file_name = format!("OptiFine_{game_version}_{kind}_{patch}.jar");
    validate_id(&file_name)?;
    let cache_dir = safe_join(&state.data_dir, "installers/optifine")?;
    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let target = safe_join(&cache_dir, &file_name)?;
    let response = controlled_loader_fetch(
        &state.control,
        async {
            let resp = state
                .client()?
                .get(&download_url)
                .timeout(Duration::from_secs(120))
                .send()
                .await
                .map_err(|e| format!("下载 OptiFine 安装器失败：{e}"))?;
            if !resp.status().is_success() {
                return Err(format!("下载 OptiFine 安装器失败（HTTP {}）", resp.status().as_u16()));
            }
            let data = resp.bytes().await.map_err(|e| format!("读取 OptiFine 安装器失败：{e}"))?;
            if data.is_empty() || data.len() > 256 * 1024 * 1024 {
                return Err("下载的 OptiFine 安装器大小无效".into());
            }
            Ok::<_, String>(data)
        },
    )
    .await?;
    let tmp = target.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, &response).map_err(|e| e.to_string())?;
    let info = match parse_optifine_installer_jar(&tmp) {
        Ok(info) => info,
        Err(err) => {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }
    };
    if info.mc_version != game_version {
        let _ = fs::remove_file(&tmp);
        return Err("下载的 OptiFine 安装器与目标 Minecraft 版本不一致".into());
    }
    fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    install_optifine_from_jar(state, app, &target, &info, root, base).await
}

#[tauri::command]
pub async fn install_optifine_installer(
    app: AppHandle,
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    path: String,
    expected_game_version: Option<String>,
    instance_id: Option<String>,
) -> crate::errors::AppResult<LoaderInstallResult> {
    let source = grants.consume(PathUse::OptifineInstaller, &path, &window)?;
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| crate::errors::expected("已有安装或启动准备任务运行"))?;
    if let Some(ref id) = instance_id {
        crate::instances::require_no_pending_restore(&state, id)?;
        let current = crate::instances::instance(&state.snapshot()?, id)
            .map_err(crate::errors::expected)?;
        crate::resources::require_target_stopped(&state, &current.version_id, Some(id))?;
    }
    let root = minecraft::require_install_root_stopped(&state, &state.snapshot()?.config)
        .map_err(crate::errors::expected)?;
    let info = parse_optifine_installer_jar(&source).map_err(crate::errors::expected)?;
    if let Some(expected) = expected_game_version.as_deref().filter(|s| !s.is_empty()) {
        if expected != info.mc_version {
            return Err(crate::errors::expected(format!(
                "所选 OptiFine 安装器适用于 Minecraft {}，与当前所选版本 {} 不匹配",
                info.mc_version, expected
            )));
        }
    }
    let task = state
        .control
        .begin_with_display(
            "loader",
            &info.mc_version,
            &format!("安装 OptiFine {}", info.edition),
            &format!("OptiFine {}", info.edition),
        )
        .map_err(crate::errors::expected)?;
    let result = async {
        let (_, base) = minecraft::install(&state, &app, &info.mc_version).await?;
        let version_id = install_optifine_from_jar(&state, &app, &source, &info, &root, &base).await?;
        if let Some(ref id) = instance_id {
            crate::instances::apply_instance_loader_update(
                &state,
                id,
                &version_id,
                "optifine",
                &info.edition,
            )?;
        }
        Ok::<_, String>(LoaderInstallResult {
            version_id,
            loader: "optifine".into(),
            loader_version: info.edition.clone(),
        })
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    if let Err(error) = &result {
        minecraft::log(&app, &state, "error", error);
    }
    result.map_err(crate::errors::expected)
}

/// Callers already holding state.operation (e.g. modpack installation) use this.
pub async fn install_loader_inner(
    state: &LauncherState,
    app: &AppHandle,
    loader: &str,
    game_version: &str,
    loader_version: &str,
) -> Result<LoaderInstallResult, String> {
    install_loader_resolving(state, app, loader, game_version, loader_version, &|_| {}).await
}

/// `resolved` hears the exact loader version before anything is installed,
/// so a task that asked for "latest" can record what it chose (U0256).
async fn install_loader_resolving(
    state: &LauncherState,
    app: &AppHandle,
    loader: &str,
    game_version: &str,
    loader_version: &str,
    resolved: &(dyn Fn(&str) + Sync),
) -> Result<LoaderInstallResult, String> {
    loader_name(loader)?;
    validate_id(game_version)?;
    if matches!(loader, "forge" | "neoforge") {
        crate::network::Settings::from_config(&state.snapshot()?.config)
            .and_then(|proxy| proxy.installer_args())
            .map_err(|error| error.code().to_owned())?;
    }
    // Cancellation must interrupt a stalled list request and stop any fallback.
    let choices = controlled_loader_fetch(&state.control, loader_versions(state, loader, game_version)).await?;
    let version = if loader_version.is_empty() || loader_version == "latest" {
        choices
            .iter()
            .find(|v| v.recommended)
            .or_else(|| choices.first())
            .ok_or("此游戏版本没有可安装的加载器版本")?
            .id
            .clone()
    } else {
        validate_id(loader_version)?;
        if !choices.iter().any(|v| v.id == loader_version) {
            return Err("所选加载器版本不在对应游戏版本的官方列表中".into());
        }
        loader_version.to_owned()
    };
    resolved(&version);
    state.control.checkpoint().await?;
    let root = minecraft::require_install_root_stopped(state, &state.snapshot()?.config)?;
    let (_, base) = minecraft::install(state, app, game_version).await?;
    let id = if matches!(loader, "fabric" | "quilt") {
        lightweight_loader(state, app, loader, game_version, &version, &root).await?
    } else if loader == "optifine" {
        optifine_online_loader(state, app, game_version, &version, &root, &base).await?
    } else {
        heavyweight_loader(state, app, loader, game_version, &version, &root, &base).await?
    };
    minecraft::log(
        app,
        state,
        "info",
        format!("{loader} {version} 安装完成：{id}；依赖已下载并校验"),
    );
    minecraft::progress(
        app,
        state,
        &id,
        "complete",
        1,
        1,
        0,
        0,
        format!("{loader} 安装完成"),
    );
    Ok(LoaderInstallResult {
        version_id: id,
        loader: loader.into(),
        loader_version: version,
    })
}

#[tauri::command]
pub async fn install_loader(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    loader: String,
    game_version: String,
    loader_version: String,
) -> crate::errors::AppResult<LoaderInstallResult> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行")?;
    let task = state.control.begin_recorded(
        "loader",
        &game_version,
        &format!("安装 {loader}"),
        None,
        loader_retry(&loader, &game_version, &loader_version),
    )?;
    let result = install_loader_recorded(&state, &app, &task, &loader, &game_version, &loader_version).await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    if let Err(error) = &result {
        minecraft::log(&app, &state, "error", error);
    }
    result.map_err(crate::errors::expected)
}

fn loader_retry(loader: &str, game_version: &str, loader_version: &str) -> crate::downloads::RetryRequest {
    crate::downloads::RetryRequest::Loader {
        loader: loader.into(),
        game_version: game_version.into(),
        loader_version: loader_version.into(),
    }
}

/// Installs a loader for task `task`, recording the version it resolved.
async fn install_loader_recorded(
    state: &LauncherState,
    app: &AppHandle,
    task: &str,
    loader: &str,
    game_version: &str,
    loader_version: &str,
) -> Result<LoaderInstallResult, String> {
    let record = |version: &str| state.control.set_retry(task, Some(loader_retry(loader, game_version, version)));
    install_loader_resolving(state, app, loader, game_version, loader_version, &record).await
}

/// A loader install retried from the Downloads page: queued behind the
/// operation lock, then the same install as the interactive one.
pub(crate) async fn run_queued_loader(
    app: AppHandle,
    state: Arc<LauncherState>,
    task: String,
    loader: String,
    game_version: String,
    loader_version: String,
) {
    let result = state
        .control
        .run_queued(&state.operation, &task, || {
            install_loader_recorded(&state, &app, &task, &loader, &game_version, &loader_version)
        })
        .await;
    if let Some(Err(error)) = result {
        minecraft::log(&app, &state, "error", error);
    }
}

pub(crate) async fn authlib_injector(state: &LauncherState) -> Result<PathBuf, String> {
    let api = "https://authlib-injector.yushi.moe/artifact/latest.json";
    let metadata = minecraft::parse_json(
        &controlled_loader_fetch(&state.control, minecraft::fetch_bytes(state.client()?, api, 1024 * 1024)).await?,
    )?;
    let version = metadata["version"]
        .as_str()
        .ok_or("authlib-injector 缺少版本")?;
    validate_id(version)?;
    let url = metadata["download_url"]
        .as_str()
        .ok_or("authlib-injector 缺少下载地址")?;
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("authlib-injector.yushi.moe") {
        return Err("authlib-injector 官方下载地址发生变化，已拒绝未知来源".into());
    }
    let expected = metadata["checksums"]["sha256"]
        .as_str()
        .ok_or("authlib-injector 缺少 SHA256")?;
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("authlib-injector SHA256 格式错误".into());
    }
    let destination = safe_join(
        &state.data_dir,
        &format!("authlib-injector/authlib-injector-{version}.jar"),
    )?;
    if let Ok(bytes) = tokio::fs::read(&destination).await {
        if format!("{:x}", Sha256::digest(&bytes)) == expected.to_ascii_lowercase() {
            return Ok(destination);
        }
    }
    state.control.checkpoint().await?;
    let source = crate::source_select::effective_download_source(state, &state.snapshot()?.config.download_source).await?;
    let expected = expected.to_ascii_lowercase();
    let (bytes, ()) = controlled_loader_fetch(&state.control, minecraft::fetch_loader_artifact_bytes(state, url, 16 * 1024 * 1024, &source, |bytes| {
        if format!("{:x}", Sha256::digest(bytes)) == expected {
            Ok(())
        } else {
            Err("authlib-injector SHA256 校验失败".into())
        }
    })).await?;
    state.control.checkpoint().await?;
    state.control.throttle(bytes.len()).await?;
    fs::create_dir_all(destination.parent().ok_or("injector路径无效")?)
        .map_err(|e| e.to_string())?;
    let temp = destination.with_extension(format!("jar-{}.tmp", uuid::Uuid::new_v4()));
    tokio::fs::write(&temp, bytes)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(temp, &destination)
        .await
        .map_err(|e| e.to_string())?;
    Ok(destination)
}

#[cfg(test)]
mod tests {
    #[test]
    fn u0259_prefers_publisher_versions_after_empty_or_failed_primary() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let publisher = || async { Ok(vec![super::LoaderVersion { id: "21.1.2".into(), stable: true, recommended: false }]) };
            let result = super::loader_versions_fallback(async { Ok(Vec::new()) }, publisher).await.unwrap();
            assert_eq!(result[0].id, "21.1.2");
            let result = super::loader_versions_fallback(async { Err("XML unavailable".into()) }, publisher).await.unwrap();
            assert_eq!(result[0].id, "21.1.2");
            let result = super::loader_versions_fallback(async { Ok(Vec::new()) }, || async { Err("Publisher unavailable".into()) }).await.unwrap();
            assert!(result.is_empty());
            assert_eq!(super::loader_versions_fallback(publisher(), || async { panic!("nonempty result must suppress fallback") }).await.unwrap()[0].id, "21.1.2");
        });
    }

    #[test]
    fn u0259_controlled_metadata_io_stops_pending_request_on_cancel() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let control = crate::downloads::DownloadControl::default();
            let job = control.begin("install", "fixture", "Fixture").unwrap();
            let (started, ready) = tokio::sync::oneshot::channel();
            let (result, ()) = futures_util::future::join(
                tokio::time::timeout(std::time::Duration::from_secs(2), super::controlled_loader_fetch(&control, async {
                    started.send(()).unwrap();
                    std::future::pending::<Result<(), String>>().await
                })),
                async { ready.await.unwrap(); control.cancel(&job); },
            ).await;
            assert!(result.expect("cancellation should wake stalled network I/O").is_err());
        });
    }

    #[test]
    fn u0259_preseed_plan_keeps_checked_artifacts_under_stage_and_skips_missing_checksums() {
        let dir = std::env::temp_dir().join(format!("voxelight-preseed-plan-{}", uuid::Uuid::new_v4()));
        let digest = "0123456789abcdef0123456789abcdef01234567";
        let profile = serde_json::json!({"libraries":[
            {"downloads":{"artifact":{"path":"net/test/a.jar","url":"https://maven.minecraftforge.net/net/test/a.jar","sha1":digest,"size":17}}},
            {"downloads":{"artifact":{"path":"net/test/b.jar","url":"https://maven.neoforged.net/releases/net/test/b.jar","sha1":digest,"size":18}}},
            {"downloads":{"artifact":{"path":"net/test/unverified.jar","url":"https://maven.minecraftforge.net/net/test/unverified.jar","size":19}}},
            {"name":"no-artifact"}
        ]});
        let (result, untrusted) = super::installer_seed_downloads(&dir, &profile).unwrap();
        assert_eq!(untrusted, 0);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].path, dir.join("libraries/net/test/a.jar"));
        assert_eq!(result[1].path, dir.join("libraries/net/test/b.jar"));
        assert_eq!(result[0].sha1, digest);
        assert_eq!(result[1].size, Some(18));
    }

    #[test]
    fn c8_preseed_plan_counts_untrusted_urls_and_rejects_traversal() {
        let dir = std::env::temp_dir().join(format!("voxelight-preseed-plan-{}", uuid::Uuid::new_v4()));
        let digest = "0123456789abcdef0123456789abcdef01234567";
        let profile = serde_json::json!({"libraries":[
            {"downloads":{"artifact":{"path":"net/test/a.jar","url":"https://maven.minecraftforge.net/net/test/a.jar","sha1":digest,"size":17}}},
            {"downloads":{"artifact":{"path":"net/test/c.jar","url":"https://untrusted.example.invalid/c.jar","sha1":digest,"size":17}}},
            {"downloads":{"artifact":{"path":"net/test/nosize.jar","url":"https://maven.minecraftforge.net/net/test/nosize.jar","sha1":digest}}},
            {"downloads":{"artifact":{"path":"net/test/badhash.jar","url":"https://maven.minecraftforge.net/net/test/badhash.jar","sha1":"xyz","size":1}}},
            {"downloads":{"artifact":{"path":"net/test/embedded.jar","url":"","sha1":digest,"size":1}}}
        ]});
        let (files, untrusted) = super::installer_seed_downloads(&dir, &profile).unwrap();
        assert_eq!(untrusted, 1, "only a declared remote URL outside the allowlist counts");
        assert_eq!(files.len(), 1, "missing size, bad hash and embedded artifacts are not prefetched");
        let traversal = serde_json::json!({"libraries":[
            {"downloads":{"artifact":{"path":"../../escape.jar","url":"https://maven.minecraftforge.net/net/test/a.jar","sha1":digest,"size":17}}}
        ]});
        assert!(super::installer_seed_downloads(&dir, &traversal).is_err());
    }

    #[test]
    fn c8_a_cached_installer_is_never_used_without_this_runs_official_checksum() {
        let source = crate::storage::executable_source(include_str!("loaders.rs"));
        let (_, body) = source.split_once("async fn installer_jar(").unwrap();
        let (body, _) = body.split_once("\n}").unwrap();
        let checksum = body.find("minecraft::fetch_official_installer_sha1(").unwrap();
        let cache = body.find("installer_cache_path(&state.data_dir, &file, &checksum, &source)?").unwrap();
        let download = body.find("minecraft::ensure_loader_download(state, &download, &source").unwrap();
        assert!(checksum < cache && cache < download);
        // No early return on an existing cache file: the download helper hashes
        // the cached bytes against the official digest before reusing them.
        assert!(!body[..download].contains(".exists()") && !body[..download].contains("return Ok("));
        let root = std::env::temp_dir();
        let file = "forge-1.20.1-47.2.0-installer.jar";
        let a = super::installer_cache_path(&root, file, "0123456789abcdef0123456789abcdef01234567", "bmclapi").unwrap();
        let b = super::installer_cache_path(&root, file, "1123456789abcdef0123456789abcdef01234567", "bmclapi").unwrap();
        assert_ne!(a, b, "a changed official digest selects a new cache entry");
    }

    #[test]
    fn c8_install_time_loader_requests_are_cancellable() {
        let source = crate::storage::executable_source(include_str!("loaders.rs"));
        for call in [
            "controlled_loader_fetch(&state.control, loader_versions(state, loader, game_version)).await?",
            "controlled_loader_fetch(&state.control, minecraft::fetch_bytes(state.client()?, &url, 8 * 1024 * 1024)).await?",
        ] {
            assert!(source.contains(call), "{call}");
        }
        let (production, _) = source.split_once("#[cfg(test)]").unwrap();
        assert!(!production.contains("let choices = loader_versions("), "the bare list request is gone");
    }

    #[test]
    fn c8_a_failed_prefetch_stops_before_the_installer_runs() {
        // The installer would fetch unverified files itself, so the prefetch
        // error must propagate before run_installer is reached.
        let source = crate::storage::executable_source(include_str!("loaders.rs"));
        let (_, body) = source.split_once("async fn heavyweight_loader(").unwrap();
        let prefetch = body.find("preseed_installer_libraries(state, stage, &installer).await?;").unwrap();
        let install = body.find("run_installer(").unwrap();
        assert!(prefetch < install);
    }

    #[test]
    fn installer_cache_keeps_official_digest_and_source_lane() {
        let root = std::env::temp_dir();
        let digest = "0123456789abcdef0123456789abcdef01234567";
        let file = "forge-1.20.1-47.2.0-installer.jar";
        let official = super::installer_cache_path(&root, file, digest, "official").unwrap();
        let mirrored = super::installer_cache_path(&root, file, digest, "bmclapi").unwrap();
        assert_ne!(official, mirrored);
        assert_eq!(official.parent().unwrap().file_name().unwrap(), digest);
        assert_eq!(mirrored.parent().unwrap().file_name().unwrap(), digest);
        assert!(super::installer_cache_path(&root, file, "bad", "bmclapi").is_err());
        assert!(super::installer_cache_path(&root, file, digest, "unknown").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn r4_forge_installer_passes_ordinary_java_jar_stage_and_temp_paths() {
        let command = super::installer_command(
            std::path::Path::new(r"\\?\C:\Java\bin\java.exe"),
            std::path::Path::new(r"\\?\D:\Launcher Profile\cache\installer.jar"),
            std::path::Path::new(r"\\?\D:\Launcher Profile\forge stage"),
            std::path::Path::new(r"\\?\D:\Launcher Profile\forge stage\runtime-temp"),
            &crate::network::Settings::System,
        ).unwrap();
        let command = command.as_std();
        assert_eq!(command.get_program(), r"C:\Java\bin\java.exe");
        assert_eq!(command.get_current_dir().unwrap(), std::path::Path::new(r"D:\Launcher Profile\forge stage"));
        let args = command.get_args().map(|value| value.to_string_lossy()).collect::<Vec<_>>();
        assert!(args.contains(&"-Djava.io.tmpdir=D:\\Launcher Profile\\forge stage\\runtime-temp".into()));
        assert!(args.windows(2).any(|pair| pair == ["-jar", r"D:\Launcher Profile\cache\installer.jar"]));
        assert!(args.windows(2).any(|pair| pair == ["--installClient", r"D:\Launcher Profile\forge stage"]));
        assert!(args.iter().all(|value| !value.contains(r"\\?\")));
    }

    use super::*;
    #[test]
    fn c7_installer_command_rejects_tls_and_keeps_http_credentials_out_of_jvm() {
        use crate::network::Settings;
        let java = Path::new(r"C:\Sandbox\java.exe");
        let jar = Path::new(r"C:\Sandbox\installer.jar");
        let stage = Path::new(r"C:\Sandbox\stage");
        let temp = stage.join("temp");
        let tls = Settings::parse("custom", "https", "proxy.example.invalid", 8443).unwrap();
        let result = installer_command(java, jar, stage, &temp, &tls);
        assert_eq!(result.unwrap_err(), "proxy.tlsInheritance");
        let system = installer_command(java, jar, stage, &temp, &Settings::System).unwrap();
        let system_args: Vec<_> = system.as_std().get_args().collect();
        assert!(system_args.iter().any(|arg| *arg == "-Djava.net.useSystemProxies=true"));
        let disabled = installer_command(java, jar, stage, &temp, &Settings::None).unwrap();
        assert!(!disabled.as_std().get_args().any(|arg| arg.to_string_lossy().contains("Prox")));
        let http = Settings::parse("custom", "http", "proxy.example.invalid", 8080).unwrap();
        let command = installer_command(java, jar, stage, &temp, &http).unwrap();
        let args: Vec<_> = command.as_std().get_args().map(|arg| arg.to_string_lossy()).collect();
        let proxy_args: Vec<_> = args.iter().filter(|arg| arg.to_ascii_lowercase().contains("proxy")).map(|arg| arg.as_ref()).collect();
        assert_eq!(proxy_args, [
            "-Dhttp.proxyHost=proxy.example.invalid", "-Dhttp.proxyPort=8080",
            "-Dhttps.proxyHost=proxy.example.invalid", "-Dhttps.proxyPort=8080",
            "-Dhttp.nonProxyHosts=localhost|127.*|[::1]",
        ]);
    }
    #[test]
    fn neoforge_versions_are_scoped_to_minecraft_minor() {
        assert_eq!(neo_prefix("1.21.1"), "21.1.");
        assert_eq!(neo_prefix("1.21"), "21.0.");
        assert_eq!(neo_prefix("26.1"), "26.1.");
        assert!(!"21.11.1".starts_with(&neo_prefix("1.21.1")));
    }
    #[test]
    fn loader_profiles_must_inherit_the_requested_official_base() {
        let profile = json!({"id":"fabric-test","inheritsFrom":"1.21.1","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[]});
        assert!(validate_profile(&profile, "1.21.1").is_ok());
        assert!(validate_profile(&profile, "1.20.1").is_err());
        assert!(loader_name("../../untrusted").is_err());
    }

    #[test]
    fn u0256_loader_tasks_record_their_request_and_the_version_they_resolved() {
        let source = crate::storage::executable_source(include_str!("loaders.rs"));
        let body = |name: &str| {
            let (_, rest) = source.split_once(name).unwrap();
            rest.split_once("\n}").unwrap().0.to_owned()
        };
        // Interactive: fail-fast lock, a recorded task, the recording install.
        let interactive = body("pub async fn install_loader(");
        let lock = interactive.find(".try_lock()").unwrap();
        let begin = interactive.find("state.control.begin_recorded(").unwrap();
        assert!(lock < begin && begin < interactive.find("install_loader_recorded(").unwrap());
        // Retried: queued behind the operation lock, the same recording install.
        let queued = body("pub(crate) async fn run_queued_loader(");
        assert!(queued.find(".run_queued(&state.operation, &task,").unwrap() < queued.find("install_loader_recorded(").unwrap());
        // The resolved version replaces "latest" in the task's payload.
        let recorded = body("async fn install_loader_recorded(");
        assert!(recorded.contains("state.control.set_retry(task, Some(loader_retry(loader, game_version, version)))"));
        assert!(recorded.contains("install_loader_resolving(state, app, loader, game_version, loader_version, &record)"));
    }

    #[test]
    fn u7_optifine_installer_jar_inspection_and_profile_generation() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/loader-tests")
            .join(format!("optifine-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        let jar_path = root.join("OptiFine_1.20.4_HD_U_I7.jar");
        {
            use std::io::Write;
            let mut zip = zip::ZipWriter::new(fs::File::create(&jar_path).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("optifine/Patcher.class", opts).unwrap();
            zip.write_all(b"class").unwrap();
            zip.start_file("optifine/OptiFineTweaker.class", opts).unwrap();
            zip.write_all(b"class").unwrap();
            zip.start_file("launchwrapper-of-2.3.jar", opts).unwrap();
            zip.write_all(b"lw").unwrap();
            zip.finish().unwrap();
        }
        let info = parse_optifine_installer_jar(&jar_path).unwrap();
        assert_eq!(info.mc_version, "1.20.4");
        assert_eq!(info.edition, "HD_U_I7");
        assert_eq!(info.launchwrapper_version.as_deref(), Some("2.3"));

        let modern_base = json!({"id":"1.20.4","type":"release","arguments":{"game":[]}});
        let modern = build_optifine_profile(&modern_base, &info.mc_version, &info.edition, info.launchwrapper_version.as_deref());
        assert_eq!(modern["id"], "1.20.4-OptiFine_HD_U_I7");
        assert_eq!(modern["inheritsFrom"], "1.20.4");
        assert_eq!(modern["mainClass"], "net.minecraft.launchwrapper.Launch");
        assert_eq!(modern["launcherMetadata"]["loader"], "optifine");
        assert!(validate_profile(&modern, "1.20.4").is_ok());

        let legacy_base = json!({"id":"1.12.2","type":"release","minecraftArguments":"--username ${auth_player_name}"});
        let legacy = build_optifine_profile(&legacy_base, "1.12.2", "HD_U_G5", None);
        assert!(legacy["minecraftArguments"].as_str().unwrap().ends_with("--tweakClass optifine.OptiFineTweaker"));
        assert!(validate_profile(&legacy, "1.12.2").is_ok());

        // Non-OptiFine JAR is refused.
        let fake = root.join("OptiFine_1.20.4_HD_U_I7_fake.jar");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&fake).unwrap());
            zip.start_file("META-INF/MANIFEST.MF", zip::write::SimpleFileOptions::default()).unwrap();
            zip.finish().unwrap();
        }
        assert!(parse_optifine_installer_jar(&fake).is_err());

        // BMCLAPI OptiFine JSON parser handles release and preview builds.
        let parsed = optifine_bmclapi_versions(br#"[{"type":"HD_U","patch":"I7"},{"type":"HD_U","patch":"I8_pre2"}]"#).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].2.id, "HD_U_I7");
        assert!(parsed[0].2.stable);
        assert_eq!(parsed[1].2.id, "HD_U_I8_pre2");
        assert!(!parsed[1].2.stable);

        fs::remove_dir_all(&root).unwrap();
    }
}
