//! Loader APIs are consumed from their publishers. No installer source is bundled.
use crate::{
    minecraft::{self, Download},
    path_grants::{PathGrants, PathUse},
    storage::{safe_join, validate_id, LauncherState},
};
use serde::Serialize;
use serde_json::{json, Value};
use sha1::Sha1;
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
    /// The backup taken before an OptiFine import switched an instance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_id: Option<String>,
}

fn loader_name(loader: &str) -> Result<&str, String> {
    match loader {
        "fabric" | "quilt" | "forge" | "neoforge" | "optifine" => Ok(loader),
        _ => Err("不支持的加载器；请选择 Fabric、Quilt、Forge、NeoForge 或 OptiFine".into()),
    }
}

// Distinct details keep diagnostics useful while errors.rs gives each class a
// translatable code. The version-mismatch detail carries both versions for the
// renderer, so its format is part of that mapping.
pub(crate) const OPTIFINE_READ_FAILED: &str = "无法读取 OptiFine 安装器 JAR";
pub(crate) const OPTIFINE_SIZE_INVALID: &str = "OptiFine 安装器 JAR 大小无效或超过 256 MiB";
pub(crate) const OPTIFINE_NAME_INVALID: &str = "OptiFine 文件名无效";
pub(crate) const OPTIFINE_OPEN_FAILED: &str = "无法打开 OptiFine JAR";
pub(crate) const OPTIFINE_NOT_JAR: &str = "所选文件不是有效的 OptiFine JAR";
pub(crate) const OPTIFINE_INVALID: &str = "所选 JAR 不是有效的 OptiFine 安装器（缺少 Patcher/OptiFineTweaker）";
pub(crate) const OPTIFINE_FILENAME_INVALID: &str = "无法从文件名识别 OptiFine 对应的 Minecraft 版本（应类似 OptiFine_1.20.4_HD_U_I7.jar）";
pub(crate) const OPTIFINE_CHANGED: &str = "所选 OptiFine 安装器在检查后发生变化，请重新选择文件";
pub(crate) const OPTIFINE_VERSION_MISMATCH_PREFIX: &str = "所选 OptiFine 安装器适用于 Minecraft ";
pub(crate) const OPTIFINE_VERSION_MISMATCH_INFIX: &str = "，与目标版本 ";
pub(crate) const OPTIFINE_VERSION_MISMATCH_SUFFIX: &str = " 不匹配";

pub(crate) fn optifine_version_mismatch(installer: &str, expected: &str) -> String {
    format!(
        "{OPTIFINE_VERSION_MISMATCH_PREFIX}{installer}{OPTIFINE_VERSION_MISMATCH_INFIX}{expected}{OPTIFINE_VERSION_MISMATCH_SUFFIX}"
    )
}

/// OptiFine is published only on optifine.net, which offers no checksum, and
/// the one download source the launcher could use (BMCLAPI) has no hash from
/// OptiFine either. Its installer is code the launcher runs, so it is never
/// downloaded: the user imports the JAR they got from optifine.net instead.
pub(crate) const OPTIFINE_ONLINE_UNAVAILABLE: &str = "OptiFine 无法在线安装：其下载没有可校验的官方校验值。请从 optifine.net 下载安装器，再导入本地 JAR";

/// The refusal every online install path gives OptiFine, before anything is
/// fetched, written or started.
pub(crate) fn refuse_online_optifine(loader: &str) -> Result<(), String> {
    if loader.trim().eq_ignore_ascii_case("optifine") {
        Err(OPTIFINE_ONLINE_UNAVAILABLE.into())
    } else {
        Ok(())
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
    parse_optifine_installer_jar_named(path, None)
}

/// A staged copy of an installer is first written under a temporary name. The
/// caller passes the name the copy will have, so the Minecraft version and
/// edition come from that name, not from the temporary path.
fn parse_optifine_installer_jar_named(
    path: &Path,
    intended_name: Option<&str>,
) -> Result<OptifineJarInfo, String> {
    let meta = fs::metadata(path).map_err(|_| OPTIFINE_READ_FAILED)?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 256 * 1024 * 1024 {
        return Err(OPTIFINE_SIZE_INVALID.into());
    }
    let file_name = intended_name
        .or_else(|| path.file_name().and_then(|n| n.to_str()))
        .ok_or(OPTIFINE_NAME_INVALID)?;
    let mut zip = zip::ZipArchive::new(fs::File::open(path).map_err(|_| OPTIFINE_OPEN_FAILED)?)
        .map_err(|_| OPTIFINE_NOT_JAR)?;
    let has_patcher = zip.by_name("optifine/Patcher.class").is_ok();
    let has_tweaker = zip.by_name("optifine/OptiFineTweaker.class").is_ok();
    if !has_patcher || !has_tweaker {
        return Err(OPTIFINE_INVALID.into());
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
    let (mc_version, edition) = parse_optifine_filename(file_name).ok_or(OPTIFINE_FILENAME_INVALID)?;
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

/// OptiFine build ids carry their ordering in the build letter, not only in
/// the digits: `HD_U_G5` is newer than `HD_U_F9`, and `..._preN` is a preview
/// of the same build. Digits alone would rank `C7` above `G5`.
fn optifine_version_key(id: &str) -> Option<(u8, u64, bool, u32)> {
    let lower = id.to_ascii_lowercase();
    let (base, preview) = match lower.rsplit_once("_pre") {
        Some((base, digits)) if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => {
            (base, digits.parse::<u32>().ok()?)
        }
        _ => (lower.as_str(), 0),
    };
    let mut newest = None;
    for segment in base.split('_') {
        let Some(index) = segment.find(|c: char| c.is_ascii_digit()) else {
            continue;
        };
        let (letters, digits) = segment.split_at(index);
        if letters.is_empty()
            || !letters.bytes().all(|b| b.is_ascii_lowercase())
            || digits.is_empty()
            || !digits.bytes().all(|b| b.is_ascii_digit())
        {
            continue;
        }
        let Ok(number) = digits.parse::<u64>() else {
            continue;
        };
        let letter = letters.as_bytes()[letters.len() - 1] - b'a';
        newest = Some((letter, number));
    }
    let (letter, number) = newest?;
    let stable = preview == 0 && !id.to_ascii_lowercase().contains("_pre");
    Some((letter, number, stable, preview))
}

fn order_loader_versions(loader: &str, result: &mut Vec<LoaderVersion>) {
    result.sort_by(|a, b| {
        if loader == "optifine" {
            optifine_version_key(&b.id)
                .cmp(&optifine_version_key(&a.id))
                .then(a.id.cmp(&b.id))
        } else {
            version_numbers(&b.id)
                .cmp(&version_numbers(&a.id))
                .then(a.id.cmp(&b.id))
        }
    });
    if !result.iter().any(|version| version.recommended) {
        if let Some(version) = result.iter_mut().find(|version| version.stable) {
            version.recommended = true;
        }
    }
    result.truncate(200);
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
    order_loader_versions(loader, &mut result);
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
/// `libraries` is the library root the artifacts are verified in; a staged OptiFine
/// install prepares them in its stage and commits them only after this succeeds.
/// `progress` hears (profile id, verified, total) after each library.
async fn prepare_profile(
    state: &LauncherState,
    profile: &mut Value,
    libraries: &Path,
    progress: &LibraryProgress<'_>,
) -> Result<(), String> {
    let id = profile["id"]
        .as_str()
        .ok_or("加载器配置缺少 ID")?
        .to_owned();
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
        progress(&id, index + 1, total);
    }
    Ok(())
}

type LibraryProgress<'a> = dyn Fn(&str, usize, usize) + Send + Sync + 'a;

/// Reports library verification as the install's progress in the window.
fn library_progress<'a>(
    app: &'a AppHandle,
    state: &'a LauncherState,
) -> impl Fn(&str, usize, usize) + Send + Sync + 'a {
    move |id, done, total| {
        minecraft::progress(
            app,
            state,
            id,
            "loader-libraries",
            done,
            total,
            0,
            0,
            format!("验证加载器依赖 {done}/{total}"),
        )
    }
}

/// Publish a loader profile at `versions/<id>/<id>.json`. A profile it
/// replaces (possibly another launcher's) is kept in the launcher's data
/// folder, never as a `.json.backup-*` beside the live profile.
fn write_profile(state: &LauncherState, root: &Path, profile: &Value) -> Result<String, String> {
    let id = profile["id"].as_str().ok_or("加载器版本 ID 缺失")?;
    validate_id(id)?;
    let destination = safe_join(root, &format!("versions/{id}/{id}.json"))?;
    fs::create_dir_all(destination.parent().ok_or("版本路径无效")?).map_err(|e| e.to_string())?;
    if destination.is_file() {
        crate::commands::keep_profile_backup(
            &state.data_dir,
            id,
            &uuid::Uuid::new_v4().to_string(),
            &destination,
        )
        .map_err(|e| format!("备份现有加载器配置失败：{e}"))?;
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
    prepare_profile(state, &mut profile, &safe_join(root, "libraries")?, &library_progress(app, state)).await?;
    profile["launcherMetadata"] = json!({"source":url,"loader":loader,"loaderVersion":version,"officialVanillaBase":game_version});
    write_profile(state, root, &profile)
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

/// Writes the exact SHA-1-verified vanilla profile bytes into the installer
/// staging directory. The installer reads this file later, so it must never be
/// a second read of a path whose contents were only checked earlier.
pub(crate) async fn stage_verified_base_profile(
    state: &LauncherState,
    root: &Path,
    game_version: &str,
    base_json: &Path,
) -> Result<(), String> {
    fs::create_dir_all(base_json.parent().ok_or("暂存路径无效")?).map_err(|e| e.to_string())?;
    let base_bytes = minecraft::verified_profile_bytes(state, root, game_version).await?;
    fs::write(base_json, &base_bytes).map_err(|e| e.to_string())
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
    stage_verified_base_profile(state, root, game_version, &base_json).await?;
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
    prepare_profile(state, &mut profile, &safe_join(root, "libraries")?, &library_progress(app, state)).await?;
    profile["launcherMetadata"] = json!({"loader":loader,"loaderVersion":version,"officialVanillaBase":game_version,"installer":jar.file_name().unwrap_or_default().to_string_lossy()});
    write_profile(state, root, &profile)
}

fn sha1_file(path: &Path) -> Result<String, String> {
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha1::new();
    let mut buffer = [0; 128 * 1024];
    loop {
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// A library produced by the loader installer itself. An empty URL is the
/// generated-file marker: prepare_profile verifies the existing SHA-1 and size
/// and must not try to fetch a sidecar or file for it.
fn generated_artifact(path: &Path, libraries: &Path) -> Result<Value, String> {
    let relative = path
        .strip_prefix(libraries)
        .map_err(|_| "加载器生成文件不在暂存依赖目录中")?
        .to_string_lossy()
        .replace('\\', "/");
    if relative.is_empty() {
        return Err("加载器生成文件路径无效".into());
    }
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size == 0 {
        return Err("加载器生成文件为空".into());
    }
    Ok(json!({
        "path": relative,
        "sha1": sha1_file(path)?,
        "size": size,
        "url": ""
    }))
}

fn attach_optifine_artifacts(
    profile: &mut Value,
    libraries: &Path,
    optifine_jar: &Path,
    launchwrapper_jar: Option<&Path>,
) -> Result<(), String> {
    let optifine = generated_artifact(optifine_jar, libraries)?;
    let launchwrapper = launchwrapper_jar
        .map(|path| generated_artifact(path, libraries))
        .transpose()?;
    let entries = profile["libraries"]
        .as_array_mut()
        .ok_or("OptiFine 配置缺少依赖库数组")?;
    let mut patched = false;
    let mut wrapper = false;
    for library in entries {
        let name = library["name"].as_str().unwrap_or_default();
        if name.starts_with("optifine:OptiFine:") {
            library["downloads"] = json!({"artifact": optifine.clone()});
            patched = true;
        } else if name.starts_with("optifine:launchwrapper-of:") {
            if let Some(artifact) = &launchwrapper {
                library["downloads"] = json!({"artifact": artifact.clone()});
                wrapper = true;
            }
        }
    }
    if !patched {
        return Err("OptiFine 配置缺少补丁库".into());
    }
    if launchwrapper_jar.is_some() && !wrapper {
        return Err("OptiFine 配置缺少 launchwrapper 库".into());
    }
    Ok(())
}

/// Where the Patcher writes the patched client library inside a stage.
fn optifine_library_path(stage: &Path, info: &OptifineJarInfo) -> Result<PathBuf, String> {
    safe_join(
        stage,
        &format!(
            "libraries/optifine/OptiFine/{0}_{1}/OptiFine-{0}_{1}.jar",
            info.mc_version, info.edition
        ),
    )
}

/// Where the launchwrapper bundled in the installer is extracted inside a stage.
fn launchwrapper_library_path(stage: &Path, version: &str) -> Result<PathBuf, String> {
    safe_join(
        stage,
        &format!("libraries/optifine/launchwrapper-of/{version}/launchwrapper-of-{version}.jar"),
    )
}

/// Runs OptiFine's own Patcher and writes the profile. Only the local import
/// calls it: OptiFine is never downloaded (OPTIFINE_ONLINE_UNAVAILABLE).
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
    // The Patcher runs, and the launchwrapper comes from, the copy inspected
    // here: the picked file itself could change after it was checked.
    let (installer, staged) = stage_optifine_installer(
        &safe_join(stage_path, "installer")?,
        &format!("OptiFine_{}_{}.jar", info.mc_version, info.edition),
        jar_path,
    )?;
    if staged != *info {
        return Err(OPTIFINE_CHANGED.into());
    }
    let vanilla_jar = safe_join(
        root,
        &format!("versions/{}/{}.jar", info.mc_version, info.mc_version),
    )?;
    if !vanilla_jar.is_file() {
        return Err("缺少对应 Minecraft 版本的客户端 JAR".into());
    }
    let output_jar = optifine_library_path(stage_path, info)?;
    fs::create_dir_all(output_jar.parent().ok_or("OptiFine 暂存路径无效")?)
        .map_err(|e| e.to_string())?;

    if let (Some(entry_name), Some(lw_version)) =
        (&info.launchwrapper_entry, &info.launchwrapper_version)
    {
        let lw_dest = launchwrapper_library_path(stage_path, lw_version)?;
        fs::create_dir_all(lw_dest.parent().ok_or("launchwrapper 路径无效")?)
            .map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(fs::File::open(&installer).map_err(|e| e.to_string())?)
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
        .arg(crate::storage::process_path_text(&installer)?)
        .arg("optifine.Patcher")
        .arg(crate::storage::process_path_text(&vanilla_jar)?)
        .arg(crate::storage::process_path_text(&installer)?)
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

    finish_optifine_install(state, stage_path, root, base, info, &library_progress(app, state)).await
}

/// Everything after the Patcher. The generated libraries are verified in the
/// stage, and they reach the game directory only once the whole profile is
/// ready: a failure here leaves `root` as it was.
async fn finish_optifine_install(
    state: &LauncherState,
    stage: &Path,
    root: &Path,
    base: &Value,
    info: &OptifineJarInfo,
    progress: &LibraryProgress<'_>,
) -> Result<String, String> {
    let output_jar = optifine_library_path(stage, info)?;
    if !output_jar.is_file() || fs::metadata(&output_jar).map_err(|e| e.to_string())?.len() == 0 {
        return Err("OptiFine Patcher 未产出有效的库文件".into());
    }
    let launchwrapper_jar = info
        .launchwrapper_version
        .as_deref()
        .map(|version| launchwrapper_library_path(stage, version))
        .transpose()?;
    let stage_libraries = safe_join(stage, "libraries")?;
    let mut profile = build_optifine_profile(
        base,
        &info.mc_version,
        &info.edition,
        info.launchwrapper_version.as_deref(),
    );
    attach_optifine_artifacts(
        &mut profile,
        &stage_libraries,
        &output_jar,
        launchwrapper_jar.as_deref(),
    )?;
    validate_profile(&profile, &info.mc_version)?;
    prepare_profile(state, &mut profile, &stage_libraries, progress).await?;
    commit_staged_libraries(stage, root)?;
    write_profile(state, root, &profile)
}

/// Copies an OptiFine installer into `directory` as `file_name` and inspects
/// the copy under that name, not its temporary one: the Minecraft version and
/// edition are read from the file name, and a name such as `.tmp-<uuid>`
/// would fail every parse. The temporary name keeps the `.jar` suffix too.
fn stage_optifine_installer(
    directory: &Path,
    file_name: &str,
    source: &Path,
) -> Result<(PathBuf, OptifineJarInfo), String> {
    let size = fs::metadata(source).map_err(|_| OPTIFINE_READ_FAILED)?.len();
    if size == 0 || size > 256 * 1024 * 1024 {
        return Err(OPTIFINE_SIZE_INVALID.into());
    }
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let target = safe_join(directory, file_name)?;
    let temporary = safe_join(
        directory,
        &format!(".{}.{file_name}", uuid::Uuid::new_v4()),
    )?;
    let result = (|| {
        fs::copy(source, &temporary).map_err(|_| OPTIFINE_READ_FAILED)?;
        let info = parse_optifine_installer_jar_named(&temporary, Some(file_name))?;
        if target.is_file() {
            fs::remove_file(&target).map_err(|e| e.to_string())?;
        }
        fs::rename(&temporary, &target).map_err(|e| e.to_string())?;
        Ok((target.clone(), info))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// The Minecraft version of an OptiFine import is the one its JAR names. An
/// existing instance must already be on that version, whatever the window
/// sent; a new version only has to match the version the user picked, if any.
fn check_optifine_target(
    state: &LauncherState,
    current: Option<&crate::models::Instance>,
    info: &OptifineJarInfo,
    expected_game_version: Option<&str>,
) -> Result<(), String> {
    let target = match current {
        Some(current) => crate::instances::resolve_instance_game_version(state, current)?,
        None => match expected_game_version.map(str::trim).filter(|value| !value.is_empty()) {
            Some(version) => version.to_owned(),
            None => return Ok(()),
        },
    };
    if target != info.mc_version {
        return Err(optifine_version_mismatch(&info.mc_version, &target));
    }
    // Importing into an instance switches its loader: refused before the task
    // starts when the instance's profile is shared, like any other switch.
    if let Some(current) = current {
        crate::commands::require_switchable_instance(state, current, &target)?;
    }
    Ok(())
}

/// `skip_backup` is the window's second, explicit choice after the backup
/// before switching an instance to OptiFine was refused.
#[tauri::command]
pub async fn install_optifine_installer(
    app: AppHandle,
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    path: String,
    expected_game_version: Option<String>,
    instance_id: Option<String>,
    skip_backup: Option<bool>,
) -> crate::errors::AppResult<LoaderInstallResult> {
    let source = grants.consume(PathUse::OptifineInstaller, &path, &window)?;
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| crate::errors::expected("已有安装或启动准备任务运行"))?;
    let mut current_instance = None;
    if let Some(ref id) = instance_id {
        crate::instances::require_no_pending_restore(&state, id)?;
        let current = crate::instances::instance(&state.snapshot()?, id)
            .map_err(crate::errors::expected)?;
        crate::resources::require_target_stopped(&state, &current.version_id, Some(id))?;
        current_instance = Some(current);
    }
    let root = minecraft::require_install_root_stopped(&state, &state.snapshot()?.config)
        .map_err(crate::errors::expected)?;
    let info = parse_optifine_installer_jar(&source).map_err(crate::errors::expected)?;
    check_optifine_target(
        &state,
        current_instance.as_ref(),
        &info,
        expected_game_version.as_deref(),
    )
    .map_err(crate::errors::expected)?;
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
        let install = async {
            let (_, base) = minecraft::install(&state, &app, &info.mc_version).await?;
            install_optifine_from_jar(&state, &app, &source, &info, &root, &base).await
        };
        let Some(current) = current_instance.as_ref() else {
            return install.await.map(|version_id| LoaderInstallResult {
                version_id,
                loader: "optifine".into(),
                loader_version: info.edition.clone(),
                backup_id: None,
            });
        };
        // Switching an instance takes its backup before the install starts,
        // so a refused backup costs nothing.
        let change = crate::instances::run_loader_switch(
            state.inner(),
            current,
            crate::instances::LoaderSwitchBackup::from_window(skip_backup),
            "optifine",
            &info.edition,
            async { install.await.map(|id| (id, "optifine".to_owned(), info.edition.clone())) },
        )
        .await?;
        if let Some(backup_id) = &change.backup_id {
            minecraft::log(
                &app,
                &state,
                "info",
                format!("已为实例 {} 创建加载器切换前备份 {backup_id}", change.instance.id),
            );
        }
        Ok::<_, String>(LoaderInstallResult {
            version_id: change.instance.version_id,
            loader: "optifine".into(),
            loader_version: info.edition.clone(),
            backup_id: change.backup_id,
        })
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    if let Err(error) = &result {
        // A refused backup gives the choice back, so the window can offer to
        // switch without a backup without asking for the file again.
        if error.starts_with(crate::instances::LOADER_BACKUP_FAILED_PREFIX) {
            grants.restore(PathUse::OptifineInstaller, source.clone(), &window);
        }
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
    let version = resolve_loader_install(state, loader, game_version, loader_version).await?;
    resolved(&version);
    state.control.checkpoint().await?;
    let root = minecraft::require_install_root_stopped(state, &state.snapshot()?.config)?;
    let (_, base) = minecraft::install(state, app, game_version).await?;
    let id = match loader {
        "fabric" | "quilt" => lightweight_loader(state, app, loader, game_version, &version, &root).await?,
        "forge" | "neoforge" => heavyweight_loader(state, app, loader, game_version, &version, &root, &base).await?,
        _ => return Err(OPTIFINE_ONLINE_UNAVAILABLE.into()),
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
        backup_id: None,
    })
}

/// Settles which build a loader install uses, before anything is downloaded
/// or run. OptiFine is refused first: it is never installed online.
async fn resolve_loader_install(
    state: &LauncherState,
    loader: &str,
    game_version: &str,
    loader_version: &str,
) -> Result<String, String> {
    loader_name(loader)?;
    validate_id(game_version)?;
    refuse_online_optifine(loader)?;
    if matches!(loader, "forge" | "neoforge") {
        crate::network::Settings::from_config(&state.snapshot()?.config)
            .and_then(|proxy| proxy.installer_args())
            .map_err(|error| error.code().to_owned())?;
    }
    // Cancellation must interrupt a stalled list request and stop any fallback.
    let choices = controlled_loader_fetch(&state.control, loader_versions(state, loader, game_version)).await?;
    if loader_version.is_empty() || loader_version == "latest" {
        Ok(choices
            .iter()
            .find(|v| v.recommended)
            .or_else(|| choices.first())
            .ok_or("此游戏版本没有可安装的加载器版本")?
            .id
            .clone())
    } else {
        validate_id(loader_version)?;
        if !choices.iter().any(|v| v.id == loader_version) {
            return Err("所选加载器版本不在对应游戏版本的官方列表中".into());
        }
        Ok(loader_version.to_owned())
    }
}

#[tauri::command]
pub async fn install_loader(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    loader: String,
    game_version: String,
    loader_version: String,
) -> crate::errors::AppResult<LoaderInstallResult> {
    refuse_online_optifine(&loader).map_err(crate::errors::expected)?;
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

    fn optifine_installer_bytes() -> Vec<u8> {
        use std::io::Write;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("optifine/Patcher.class", options).unwrap();
            zip.write_all(b"class").unwrap();
            zip.start_file("optifine/OptiFineTweaker.class", options).unwrap();
            zip.write_all(b"class").unwrap();
            zip.start_file("launchwrapper-of-2.3.jar", options).unwrap();
            zip.write_all(b"lw").unwrap();
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

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

    #[test]
    fn u7_optifine_generated_libraries_carry_verified_artifacts() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/loader-tests")
            .join(format!("optifine-artifacts-{}", uuid::Uuid::new_v4()));
        let libraries = root.join("libraries");
        let patched = libraries.join("optifine/OptiFine/1.20.4_HD_U_I7/OptiFine-1.20.4_HD_U_I7.jar");
        let wrapper = libraries.join("optifine/launchwrapper-of/2.3/launchwrapper-of-2.3.jar");
        fs::create_dir_all(patched.parent().unwrap()).unwrap();
        fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
        fs::write(&patched, b"patched").unwrap();
        fs::write(&wrapper, b"wrapper").unwrap();

        let base = json!({"id":"1.20.4","type":"release","arguments":{"game":[]}});
        let mut profile = build_optifine_profile(&base, "1.20.4", "HD_U_I7", Some("2.3"));
        attach_optifine_artifacts(&mut profile, &libraries, &patched, Some(&wrapper)).unwrap();
        assert!(validate_profile(&profile, "1.20.4").is_ok());

        let entries = profile["libraries"].as_array().unwrap();
        let patched_artifact = &entries[0]["downloads"]["artifact"];
        assert_eq!(
            patched_artifact["path"],
            "optifine/OptiFine/1.20.4_HD_U_I7/OptiFine-1.20.4_HD_U_I7.jar"
        );
        assert_eq!(patched_artifact["url"], "");
        assert_eq!(patched_artifact["size"], 7);
        assert_eq!(
            patched_artifact["sha1"],
            format!("{:x}", Sha1::digest(b"patched"))
        );
        // prepare_profile treats this as a generated file: the path and hash
        // already verify it, so nothing is fetched for the empty URL.
        let download = minecraft::download_from(patched_artifact, &libraries, None).unwrap();
        assert_eq!(download.path, patched);
        assert_eq!(download.url, "");
        assert_eq!(download.sha1, patched_artifact["sha1"].as_str().unwrap());

        let wrapper_artifact = &entries[1]["downloads"]["artifact"];
        assert_eq!(
            wrapper_artifact["path"],
            "optifine/launchwrapper-of/2.3/launchwrapper-of-2.3.jar"
        );
        assert_eq!(wrapper_artifact["url"], "");
        assert_eq!(wrapper_artifact["size"], 7);
        assert_eq!(
            wrapper_artifact["sha1"],
            format!("{:x}", Sha1::digest(b"wrapper"))
        );

        // Without a bundled launchwrapper, the legacy Maven library keeps its
        // normal URL and must not receive a generated artifact.
        let mut legacy = build_optifine_profile(&base, "1.20.4", "HD_U_I7", None);
        attach_optifine_artifacts(&mut legacy, &libraries, &patched, None).unwrap();
        assert!(legacy["libraries"][1]["downloads"].is_null());
        assert_eq!(legacy["libraries"][1]["url"], "https://libraries.minecraft.net/");

        fs::remove_dir_all(&root).unwrap();
    }

    /// A loader-test state: its game directory is the fixture's, the download
    /// source is fixed (no reachability probe), and every request goes to
    /// `client`.
    fn loader_state(root: &Path, client: reqwest::Client) -> LauncherState {
        loader_state_with_source(root, client, "official")
    }

    fn loader_state_with_source(root: &Path, client: reqwest::Client, source: &str) -> LauncherState {
        LauncherState::test_fixture(
            root.join("data"),
            crate::models::Persisted {
                config: crate::models::Config {
                    game_directory: root.join("game").to_string_lossy().into_owned(),
                    download_source: source.into(),
                    ..Default::default()
                },
                ..Default::default()
            },
            client,
        )
    }

    /// A client whose every request goes to a local listener that only counts
    /// and closes connections: a test sees whether anything was fetched, and
    /// nothing reaches the network.
    fn counting_client() -> (reqwest::Client, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let connections = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = connections.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                drop(stream);
            }
        });
        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).unwrap())
            .build()
            .unwrap();
        (client, connections)
    }

    fn test_root(prefix: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/loader-tests")
            .join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("game")).unwrap();
        root
    }

    #[test]
    fn fb_review_installer_base_profile_is_staged_from_verified_bytes() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let root = test_root("verified-base-stage");
            fs::create_dir_all(root.join("data")).unwrap();
            let game = root.join("game");
            let official = br#"{"id":"1.21.1","type":"release","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#;
            let tampered = br#"{"id":"1.21.1","type":"custom","mainClass":"net.minecraft.client.main.Main","libraries":[],"_otherLauncher":"pcl2"}"#;
            let local = game.join("versions/1.21.1/1.21.1.json");
            fs::create_dir_all(local.parent().unwrap()).unwrap();
            fs::write(&local, tampered).unwrap();
            let manifest = json!({
                "latest": {"release": "1.21.1", "snapshot": "1.21.1"},
                "versions": [{
                    "id": "1.21.1",
                    "type": "release",
                    "url": "https://piston-meta.mojang.com/v1/packages/1.21.1.json",
                    "sha1": format!("{:x}", Sha1::digest(official)),
                }]
            });
            fs::write(
                root.join("data/version-manifest-mojang.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
            let cache = root.join("data/verified-profiles/versions/1.21.1/1.21.1.json");
            fs::create_dir_all(cache.parent().unwrap()).unwrap();
            fs::write(&cache, official).unwrap();

            let (client, connections) = counting_client();
            let state = loader_state(&root, client);
            let staged = root.join("stage/versions/1.21.1/1.21.1.json");
            stage_verified_base_profile(&state, &game, "1.21.1", &staged)
                .await
                .unwrap();
            assert_eq!(
                fs::read(&staged).unwrap(),
                official,
                "the installer stage receives the exact verified bytes"
            );
            assert_eq!(fs::read(&local).unwrap(), tampered);
            assert_eq!(
                connections.load(std::sync::atomic::Ordering::SeqCst),
                0,
                "the locally cached manifests verify the bytes without a network request"
            );

            // Without a verified copy the helper fails instead of falling back
            // to copying the unverified .minecraft JSON.
            fs::remove_file(&cache).unwrap();
            let second = root.join("stage2/versions/1.21.1/1.21.1.json");
            let error = stage_verified_base_profile(&state, &game, "1.21.1", &second)
                .await
                .unwrap_err();
            assert!(error.contains("缺少已校验"), "{error}");
            assert!(!second.exists());
            assert_eq!(fs::read(&local).unwrap(), tampered);

            drop(state);
            fs::remove_dir_all(&root).unwrap();
        });
    }

    #[test]
    fn u7_generated_optifine_artifact_verifies_without_a_download() {
        let root = test_root("optifine-generated");
        let libraries = root.join("libraries");
        let jar = libraries.join("optifine/OptiFine/1.20.4_HD_U_I7/OptiFine-1.20.4_HD_U_I7.jar");
        fs::create_dir_all(jar.parent().unwrap()).unwrap();
        fs::write(&jar, b"patched").unwrap();
        let artifact = generated_artifact(&jar, &libraries).unwrap();
        let download = minecraft::download_from(&artifact, &libraries, None).unwrap();
        let (client, connections) = counting_client();
        let state = loader_state(&root, client);
        let downloaded = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(minecraft::ensure_loader_download(
                &state,
                &download,
                "official",
                None,
            ))
            .unwrap();
        assert!(
            !downloaded,
            "the existing generated file is verified without a fetch"
        );
        assert_eq!(connections.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(download.url, "");
        assert_eq!(download.path, jar);
        drop(state);
        fs::remove_dir_all(&root).unwrap();
    }

    fn patched_info(launchwrapper: Option<&str>) -> OptifineJarInfo {
        OptifineJarInfo {
            mc_version: "1.20.4".into(),
            edition: "HD_U_I7".into(),
            launchwrapper_entry: launchwrapper.map(|version| format!("launchwrapper-of-{version}.jar")),
            launchwrapper_version: launchwrapper.map(str::to_owned),
        }
    }

    /// What the Patcher leaves in a stage: the patched client library and,
    /// when the installer bundles one, the extracted launchwrapper.
    fn fake_patcher_output(stage: &Path, info: &OptifineJarInfo) {
        let patched = optifine_library_path(stage, info).unwrap();
        fs::create_dir_all(patched.parent().unwrap()).unwrap();
        fs::write(&patched, b"patched").unwrap();
        if let Some(version) = &info.launchwrapper_version {
            let wrapper = launchwrapper_library_path(stage, version).unwrap();
            fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
            fs::write(&wrapper, b"wrapper").unwrap();
        }
    }

    #[test]
    fn u7_optifine_install_commits_verified_generated_libraries_and_its_profile() {
        let root = test_root("optifine-finish");
        let (stage, game) = (root.join("stage"), root.join("game"));
        let info = patched_info(Some("2.3"));
        fake_patcher_output(&stage, &info);
        let (client, connections) = counting_client();
        let state = loader_state(&root, client);
        let base = json!({"id":"1.20.4","type":"release","arguments":{"game":[]}});
        let verified = std::sync::Mutex::new(Vec::new());
        let progress = |id: &str, done: usize, total: usize| {
            verified.lock().unwrap().push((id.to_owned(), done, total));
        };

        let id = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(finish_optifine_install(&state, &stage, &game, &base, &info, &progress))
            .unwrap();
        assert_eq!(id, "1.20.4-OptiFine_HD_U_I7");
        assert_eq!(connections.load(std::sync::atomic::Ordering::SeqCst), 0, "nothing is fetched");
        assert_eq!(verified.lock().unwrap().last().cloned(), Some((id.clone(), 2, 2)));

        // The generated files are in the game's libraries, and the written
        // profile carries their hashes as generated (URL-less) artifacts.
        let patched_path = "optifine/OptiFine/1.20.4_HD_U_I7/OptiFine-1.20.4_HD_U_I7.jar";
        let wrapper_path = "optifine/launchwrapper-of/2.3/launchwrapper-of-2.3.jar";
        assert_eq!(fs::read(game.join("libraries").join(patched_path)).unwrap(), b"patched");
        assert_eq!(fs::read(game.join("libraries").join(wrapper_path)).unwrap(), b"wrapper");
        let profile: Value = serde_json::from_slice(
            &fs::read(game.join(format!("versions/{id}/{id}.json"))).unwrap(),
        )
        .unwrap();
        for (index, path, bytes) in [(0, patched_path, &b"patched"[..]), (1, wrapper_path, &b"wrapper"[..])] {
            let artifact = &profile["libraries"][index]["downloads"]["artifact"];
            assert_eq!(artifact["path"], path);
            assert_eq!(artifact["url"], "");
            assert_eq!(artifact["size"], bytes.len());
            assert_eq!(artifact["sha1"], format!("{:x}", Sha1::digest(bytes)));
        }
        drop(state);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn u7_a_failed_optifine_preparation_leaves_the_game_directory_untouched() {
        let root = test_root("optifine-finish-failed");
        let (stage, game) = (root.join("stage"), root.join("game"));
        // Without a bundled launchwrapper the profile needs Mojang's, whose
        // checksum must be fetched; the counting client refuses every request.
        let info = patched_info(None);
        fake_patcher_output(&stage, &info);
        let (client, connections) = counting_client();
        let state = loader_state(&root, client);
        let base = json!({"id":"1.20.4","type":"release","arguments":{"game":[]}});
        let error = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(finish_optifine_install(&state, &stage, &game, &base, &info, &|_, _, _| {}))
            .unwrap_err();
        assert!(!error.is_empty());
        assert!(connections.load(std::sync::atomic::Ordering::SeqCst) > 0, "preparation was reached");
        assert!(!game.join("libraries").exists(), "no generated library reached the game directory");
        assert!(!game.join("versions").exists(), "no profile was written");
        assert!(optifine_library_path(&stage, &info).unwrap().is_file(), "the stage still holds it");

        // A Patcher that produced nothing is refused before anything else.
        fs::remove_file(optifine_library_path(&stage, &info).unwrap()).unwrap();
        let error = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(finish_optifine_install(&state, &stage, &game, &base, &info, &|_, _, _| {}))
            .unwrap_err();
        assert_eq!(error, "OptiFine Patcher 未产出有效的库文件");
        drop(state);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn u7_staged_optifine_installer_keeps_its_jar_suffix() {
        let root = test_root("optifine-staged");
        let picked = root.join("downloads/OptiFine_1.20.4_HD_U_I7.jar");
        fs::create_dir_all(picked.parent().unwrap()).unwrap();
        fs::write(&picked, optifine_installer_bytes()).unwrap();
        let staged_dir = root.join("stage/installer");
        let file_name = "OptiFine_1.20.4_HD_U_I7.jar";

        let (target, info) = stage_optifine_installer(&staged_dir, file_name, &picked).unwrap();
        assert_eq!(target.file_name().unwrap(), file_name);
        assert_eq!(info, parse_optifine_installer_jar(&picked).unwrap(), "the copy is what was inspected");
        assert_eq!(info.mc_version, "1.20.4");
        assert_eq!(info.edition, "HD_U_I7");
        assert_eq!(fs::read(&target).unwrap(), fs::read(&picked).unwrap());
        assert_eq!(
            fs::read_dir(&staged_dir).unwrap().count(),
            1,
            "the .jar-suffixed temporary file is gone after the rename"
        );

        // Staging again replaces the copy rather than failing on it.
        let (again, _) = stage_optifine_installer(&staged_dir, file_name, &picked).unwrap();
        assert_eq!(again, target);
        assert_eq!(fs::read_dir(&staged_dir).unwrap().count(), 1);

        // A file that is not an OptiFine installer leaves no temporary file.
        let other = root.join("downloads/OptiFine_1.20.4_HD_U_I8.jar");
        {
            let mut zip = zip::ZipWriter::new(fs::File::create(&other).unwrap());
            zip.start_file("META-INF/MANIFEST.MF", zip::write::SimpleFileOptions::default()).unwrap();
            zip.finish().unwrap();
        }
        let error = stage_optifine_installer(&staged_dir, "OptiFine_1.20.4_HD_U_I8.jar", &other).unwrap_err();
        assert_eq!(error, OPTIFINE_INVALID);
        assert_eq!(fs::read_dir(&staged_dir).unwrap().count(), 1);

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn u7_online_optifine_is_refused_before_anything_is_fetched_or_run() {
        let root = test_root("optifine-online");
        let (client, connections) = counting_client();
        // BMCLAPI is the source the OptiFine list and installer came from, so
        // without the refusal this state would fetch.
        let state = loader_state_with_source(&root, client, "bmclapi");
        let runtime = tokio::runtime::Runtime::new().unwrap();
        for version in ["", "latest", "HD_U_I7"] {
            let error = runtime
                .block_on(resolve_loader_install(&state, "optifine", "1.20.4", version))
                .unwrap_err();
            assert_eq!(crate::errors::expected(error).code, "loader.optifineOnlineUnavailable");
        }
        assert_eq!(
            connections.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "not even the version list was requested"
        );
        // The same client does reach the listener for a loader that is
        // installed online, so the zero above means nothing was fetched.
        let _ = runtime.block_on(resolve_loader_install(&state, "fabric", "1.20.4", "latest"));
        assert!(connections.load(std::sync::atomic::Ordering::SeqCst) > 0);

        // Only the local import runs the Patcher; no online install calls it,
        // and every online install resolves (and refuses) before installing.
        let source = crate::storage::executable_source(include_str!("loaders.rs"));
        let (production, _) = source.split_once("#[cfg(test)]").unwrap();
        let body = |name: &str| {
            let (_, rest) = production.split_once(name).expect(name);
            rest.split_once("\n}").expect(name).0.to_owned()
        };
        assert_eq!(
            production.matches("install_optifine_from_jar(").count(),
            2,
            "its definition and the import's call"
        );
        assert!(body("pub async fn install_optifine_installer(").contains("install_optifine_from_jar("));
        assert_eq!(production.matches("\"optifine.Patcher\"").count(), 1);
        assert!(body("async fn install_optifine_from_jar(").contains(".arg(\"optifine.Patcher\")"));
        let online = body("async fn install_loader_resolving(");
        let resolve = online.find("resolve_loader_install(").unwrap();
        assert!(resolve < online.find("minecraft::install(").unwrap());
        // Only the publishers' loaders are dispatched to an installer; the
        // version-list step already refused OptiFine, and any other name ends
        // in the same refusal rather than reaching an installer.
        let dispatch = &online[online.find("let id = match loader {").unwrap()..];
        assert!(dispatch.contains("\"fabric\" | \"quilt\" => lightweight_loader("));
        assert!(dispatch.contains("\"forge\" | \"neoforge\" => heavyweight_loader("));
        assert!(dispatch.contains("_ => return Err(OPTIFINE_ONLINE_UNAVAILABLE.into()),"));
        assert!(!dispatch.contains("optifine"));
        let command = body("pub async fn install_loader(");
        let refused = command.find("refuse_online_optifine(&loader)").unwrap();
        assert!(refused < command.find("state.control.begin_recorded(").unwrap(), "no task is created");
        drop(state);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn u7_optifine_import_into_an_instance_uses_the_jar_version_not_the_window() {
        let root = test_root("optifine-target");
        let (client, _) = counting_client();
        let state = loader_state(&root, client);
        let instance = crate::models::Instance {
            id: "survival".into(),
            version_id: "1.20.1".into(),
            game_directory: root.join("game/instances/survival").to_string_lossy().into_owned(),
            ..Default::default()
        };
        let newer = OptifineJarInfo {
            mc_version: "1.21.4".into(),
            edition: "HD_U_J3".into(),
            launchwrapper_entry: None,
            launchwrapper_version: None,
        };
        // Whatever the window sends, the instance's own base version decides.
        for sent in [None, Some(""), Some("1.21.4")] {
            let error = check_optifine_target(&state, Some(&instance), &newer, sent).unwrap_err();
            let error = crate::errors::expected(error);
            assert_eq!(error.code, "loader.optifineVersionMismatch", "{sent:?}");
            assert_eq!(error.params["installer"], "1.21.4");
            assert_eq!(error.params["expected"], "1.20.1");
        }
        let matching = OptifineJarInfo { mc_version: "1.20.1".into(), ..newer.clone() };
        assert!(check_optifine_target(&state, Some(&instance), &matching, Some("1.21.4")).is_ok());
        // An instance whose base version cannot be resolved is refused.
        let unknown = crate::models::Instance {
            version_id: "fabric-loader-0.16.9-1.20.1".into(),
            loader: "fabric".into(),
            ..instance.clone()
        };
        let error = check_optifine_target(&state, Some(&unknown), &matching, Some("1.20.1")).unwrap_err();
        assert_eq!(crate::errors::expected(error).code, "instance.baseVersionUnknown");
        // A new version checks the version picked in the dialog, if any.
        assert!(check_optifine_target(&state, None, &newer, None).is_ok());
        assert!(check_optifine_target(&state, None, &newer, Some("1.21.4")).is_ok());
        assert!(check_optifine_target(&state, None, &newer, Some("1.20.1")).is_err());

        let source = crate::storage::executable_source(include_str!("loaders.rs"));
        let (_, import) = source.split_once("pub async fn install_optifine_installer(").unwrap();
        let (import, _) = import.split_once("\n}").unwrap();
        assert!(import.find("check_optifine_target(").unwrap() < import.find("begin_with_display(").unwrap());
        // A refused backup hands the picked file back, so the window can
        // retry without a backup without asking for the file again.
        let refused = import
            .find("if error.starts_with(crate::instances::LOADER_BACKUP_FAILED_PREFIX) {")
            .unwrap();
        assert!(import[refused..].trim_start_matches(|c| c != '\n').trim_start()
            .starts_with("grants.restore(PathUse::OptifineInstaller, source.clone(), &window);"));
        drop(state);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_loader_installers_own_folder_is_never_switched_in_place() {
        const FABRIC: &str = "fabric-loader-0.16.9-1.21.1";
        const FORGE: &str = "1.21.1-forge-52.0.10";
        const OPTIFINE: &str = "1.20.4-OptiFine_HD_U_I7";
        const UNUSUAL: &str = "forge-1.21.1-52.0.10";
        let root = test_root("installer-folder");
        let game = root.join("game");
        let write = |id: &str, profile: &Value| {
            let directory = game.join("versions").join(id);
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join(format!("{id}.json")), serde_json::to_vec_pretty(profile).unwrap()).unwrap();
        };
        let profile_path = |id: &str| game.join(format!("versions/{id}/{id}.json"));
        for version in ["1.21.1", "1.20.4", "1.7.10"] {
            write(version, &json!({
                "id": version, "type": "release", "mainClass": "net.minecraft.client.main.Main", "libraries": []
            }));
        }
        let mut config = crate::models::Config {
            game_directory: game.to_string_lossy().into_owned(),
            download_source: "official".into(),
            ..Default::default()
        };
        config.normalize_game_folders();
        let (client, connections) = counting_client();
        let state = Arc::new(LauncherState::test_fixture(
            root.join("data"),
            crate::models::Persisted { config, ..Default::default() },
            client,
        ));
        let listed = |id: &str| json!({
            "id": id, "type": "release",
            "url": format!("https://piston-meta.mojang.com/v1/packages/{}/{id}.json", "a".repeat(40)),
            "sha1": "a".repeat(40)
        });
        fs::write(
            state.data_dir.join("version-manifest-mojang.json"),
            serde_json::to_vec(&json!({
                "latest": { "release": "1.21.1", "snapshot": "1.21.1" },
                "versions": [listed("1.21.1"), listed("1.20.4"), listed("1.7.10")]
            }))
            .unwrap(),
        )
        .unwrap();

        // Fabric installed from Downloads: the profile its installer writes,
        // with the user's Fabric mods and world in that same folder.
        let fabric = json!({
            "id": FABRIC, "inheritsFrom": "1.21.1", "type": "release",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
            "arguments": { "game": [], "jvm": ["-DFabricMcEmu= net.minecraft.client.main.Main "] },
            "libraries": [{ "name": "net.fabricmc:fabric-loader:0.16.9", "url": "https://maven.fabricmc.net/" }],
            "launcherMetadata": {
                "source": "https://meta.fabricmc.net/v2/versions/loader/1.21.1/0.16.9/profile/json",
                "loader": "fabric", "loaderVersion": "0.16.9", "officialVanillaBase": "1.21.1"
            }
        });
        assert_eq!(write_profile(&state, &game, &fabric).unwrap(), FABRIC);
        let fabric_folder = game.join("versions").join(FABRIC);
        fs::create_dir_all(fabric_folder.join("mods")).unwrap();
        fs::write(fabric_folder.join("mods/sodium.jar"), b"fabric mod").unwrap();
        fs::create_dir_all(fabric_folder.join("saves/World")).unwrap();
        fs::write(fabric_folder.join("saves/World/level.dat"), b"world").unwrap();
        // OptiFine imported as a new version, through the real finishing step.
        let stage = root.join("stage");
        let info = patched_info(Some("2.3"));
        fake_patcher_output(&stage, &info);
        let base = json!({ "id": "1.20.4", "type": "release", "arguments": { "game": [] } });
        let optifine = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(finish_optifine_install(&state, &stage, &game, &base, &info, &|_: &str, _: usize, _: usize| {}))
            .unwrap();
        assert_eq!(optifine, OPTIFINE);
        // Folders other launchers' installers made, with their usual ids.
        for (id, parent, main_class) in [
            (FORGE, "1.21.1", "net.minecraftforge.bootstrap.ForgeBootstrap"),
            ("neoforge-21.1.77", "1.21.1", "cpw.mods.bootstraplauncher.BootstrapLauncher"),
            ("quilt-loader-0.27.1-1.21.1", "1.21.1", "org.quiltmc.loader.impl.launch.knot.KnotClient"),
            ("1.7.10-Forge10.13.4.1614-1.7.10", "1.7.10", "net.minecraft.launchwrapper.Launch"),
        ] {
            write(id, &json!({ "id": id, "inheritsFrom": parent, "mainClass": main_class, "libraries": [] }));
        }
        // A Forge build Voxelight installed whose installer chose another id
        // shape: its own metadata and its loader version in the name give it away.
        write_profile(&state, &game, &json!({
            "id": UNUSUAL, "inheritsFrom": "1.21.1",
            "mainClass": "net.minecraftforge.bootstrap.ForgeBootstrap", "libraries": [],
            "launcherMetadata": {
                "loader": "forge", "loaderVersion": "52.0.10", "officialVanillaBase": "1.21.1",
                "installer": "forge-1.21.1-52.0.10-installer.jar"
            }
        }))
        .unwrap();
        // Instances Voxelight created with its default names, and a pack whose
        // profile is a renamed copy of the installer's (its hash not recorded).
        for (name, installed, loader) in [("1.21.1-Fabric", FABRIC, "fabric"), ("1.21.1-Forge-2", FORGE, "forge")] {
            crate::commands::write_instance_profile(&state, &game, name, "1.21.1", installed, loader).unwrap();
        }
        let mut pack = fabric.clone();
        pack["id"] = json!("Pack");
        write("Pack", &pack);

        // The scan lists every folder as its own isolated instance.
        crate::instances::sync_version_instances(&state).unwrap();
        let record = |version: &str| {
            state
                .snapshot()
                .unwrap()
                .instances
                .into_iter()
                .find(|record| record.is_version_folder() && record.version_id == version)
                .unwrap()
        };
        let loader_folder = record(FABRIC);
        assert!(loader_folder.isolated && !loader_folder.hidden);
        assert_eq!((loader_folder.loader.as_str(), loader_folder.loader_version.as_str()), ("fabric", "0.16.9"));

        let refused = [
            FABRIC,
            OPTIFINE,
            FORGE,
            "neoforge-21.1.77",
            "quilt-loader-0.27.1-1.21.1",
            "1.7.10-Forge10.13.4.1614-1.7.10",
            UNUSUAL,
        ];
        let profiles = || refused.map(|id| fs::read(profile_path(id)).unwrap());
        let before = profiles();
        let records = serde_json::to_value(state.snapshot().unwrap().instances).unwrap();
        for folder in refused {
            let current = record(folder);
            // The window, Lumen and MCP plan the switch before any backup or install.
            let error = crate::instances::plan_loader_switch(&state, &current.id, "forge", None).err().unwrap();
            assert_eq!(error.code, "instance.loaderSwitchInstallerFolder", "{folder}");
            // The rewrite after the install, also used by pack updates.
            let (installed, loader) = if folder == FORGE { (FABRIC, "fabric") } else { (FORGE, "forge") };
            let error = crate::commands::rewrite_version_folder_profile(&state, &current, installed, loader).unwrap_err();
            assert_eq!(crate::errors::expected(error).code, "instance.loaderSwitchInstallerFolder", "{folder}");
        }
        // An OptiFine import into the folder is a switch as well.
        for (folder, mc_version) in [(FABRIC, "1.21.1"), (OPTIFINE, "1.20.4")] {
            let jar = OptifineJarInfo { mc_version: mc_version.into(), edition: "HD_U_J1".into(), ..info.clone() };
            let error = check_optifine_target(&state, Some(&record(folder)), &jar, None).unwrap_err();
            assert_eq!(crate::errors::expected(error).code, "instance.loaderSwitchInstallerFolder", "{folder}");
        }
        assert_eq!(profiles(), before, "no installer profile was rewritten");
        assert_eq!(serde_json::to_value(state.snapshot().unwrap().instances).unwrap(), records);
        assert!(!state.data_dir.join("instance-backups").exists(), "no backup was taken");
        for folder in refused {
            let names: Vec<String> = fs::read_dir(game.join("versions").join(folder))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            assert!(names.iter().all(|name| !name.contains(".backup-") && !name.ends_with(".tmp")), "{folder}: {names:?}");
        }

        // Instances named by Voxelight or a pack still switch.
        for folder in ["1.21.1-Fabric", "1.21.1-Forge-2", "Pack"] {
            assert!(crate::instances::plan_loader_switch(&state, &record(folder).id, "forge", None).is_ok(), "{folder}");
        }
        // The way out the message names, as the window runs it: Copy instance
        // sends no name, so the copy gets the default `<name> Copy`, and the
        // loader is switched on that copy.
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let copy = runtime
            .block_on(crate::commands::copy_instance_inner(&state, &loader_folder.id, None))
            .unwrap();
        let copy_name = format!("{FABRIC} Copy");
        assert_eq!(copy.version_id, copy_name);
        assert!(crate::instances::plan_loader_switch(&state, &copy.id, "forge", None).is_ok());
        assert_eq!(crate::commands::rewrite_version_folder_profile(&state, &copy, FORGE, "forge").unwrap(), copy_name);
        let copied = game.join("versions").join(&copy_name);
        assert_eq!(fs::read(copied.join("mods/sodium.jar")).unwrap(), b"fabric mod");
        assert_eq!(fs::read(copied.join("saves/World/level.dat")).unwrap(), b"world");
        // The same holds for the other installers' folders and a second copy.
        for (folder, target) in [(FORGE, "fabric"), (OPTIFINE, "forge"), (FABRIC, "quilt")] {
            let copy = runtime
                .block_on(crate::commands::copy_instance_inner(&state, &record(folder).id, None))
                .unwrap();
            assert!(copy.version_id.starts_with(&format!("{folder} Copy")), "{}", copy.version_id);
            assert!(crate::instances::plan_loader_switch(&state, &copy.id, target, None).is_ok(), "{}", copy.version_id);
        }
        // Installing that Fabric again rewrites only the installer's folder.
        write_profile(&state, &game, &fabric).unwrap();
        let switched: Value = serde_json::from_slice(&fs::read(copied.join(format!("{copy_name}.json"))).unwrap()).unwrap();
        assert_eq!(switched["id"], copy_name.as_str());
        assert_eq!(switched["inheritsFrom"], "1.21.1");
        assert_eq!(switched["mainClass"], "net.minecraftforge.bootstrap.ForgeBootstrap");
        assert_eq!(connections.load(std::sync::atomic::Ordering::SeqCst), 0, "nothing was fetched");
        drop(runtime);
        drop(state);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn u7_optifine_versions_sort_by_build_letter_not_digits_alone() {
        let version = |id: &str, stable: bool| LoaderVersion {
            id: id.into(),
            stable,
            recommended: false,
        };
        let mut versions = ["HD_U_C7", "HD_U_F5", "HD_U_G5", "HD_U_H9", "HD_U_I2"]
            .map(|id| version(id, true))
            .to_vec();
        order_loader_versions("optifine", &mut versions);
        assert_eq!(
            versions.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["HD_U_I2", "HD_U_H9", "HD_U_G5", "HD_U_F5", "HD_U_C7"]
        );
        assert!(versions[0].recommended, "the newest stable build is recommended");
        assert!(versions[1..].iter().all(|item| !item.recommended));

        // A preview of a newer build sorts above the previous stable build but
        // is never the recommended default.
        let mut previews = [
            version("HD_U_G5", true),
            version("HD_U_G6_pre1", false),
            version("HD_U_G5_pre1", false),
        ]
        .to_vec();
        order_loader_versions("optifine", &mut previews);
        assert_eq!(
            previews.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["HD_U_G6_pre1", "HD_U_G5", "HD_U_G5_pre1"]
        );
        assert_eq!(
            previews.iter().find(|item| item.recommended).map(|item| item.id.as_str()),
            Some("HD_U_G5")
        );
    }

    #[test]
    fn l2_a_replaced_loader_profile_is_kept_in_the_data_folder_not_in_versions() {
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/instance-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let state = loader_state(holder.path(), crate::storage::test_client());
        let root = holder.path().join("game");
        let id = "fabric-loader-0.16-1.21.1";
        let folder = root.join("versions").join(id);
        fs::create_dir_all(&folder).unwrap();
        // Another launcher's profile under the same loader id.
        let theirs = br#"{"id":"fabric-loader-0.16-1.21.1","note":"written by PCL"}"#;
        fs::write(folder.join(format!("{id}.json")), theirs).unwrap();
        let profile = json!({
            "id": id, "inheritsFrom": "1.21.1",
            "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient", "libraries": []
        });
        assert_eq!(write_profile(&state, &root, &profile).unwrap(), id);
        assert_eq!(write_profile(&state, &root, &profile).unwrap(), id, "a reinstall");
        let live: Value = serde_json::from_slice(&fs::read(folder.join(format!("{id}.json"))).unwrap()).unwrap();
        assert_eq!(live, profile);
        let beside: Vec<String> = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(beside, [format!("{id}.json")], "nothing but the profile stays in versions/");
        let kept: Vec<Vec<u8>> = fs::read_dir(state.data_dir.join(crate::commands::PROFILE_BACKUP_FOLDER))
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                assert!(path.file_name().unwrap().to_string_lossy().starts_with(id));
                fs::read(path).unwrap()
            })
            .collect();
        assert_eq!(kept.len(), 2, "each replaced profile is kept once");
        assert!(kept.iter().any(|bytes| bytes.as_slice() == theirs), "the other launcher's profile survives");
    }
}
