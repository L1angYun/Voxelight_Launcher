//! Loader APIs are consumed from their publishers. No installer source is bundled.
use crate::{
    minecraft::{self, Download},
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
        "fabric" | "quilt" | "forge" | "neoforge" => Ok(loader),
        _ => Err("不支持的加载器；请选择 Fabric、Quilt、Forge 或 NeoForge".into()),
    }
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

pub async fn loader_versions(
    state: &LauncherState,
    loader: &str,
    game_version: &str,
) -> Result<Vec<LoaderVersion>, String> {
    loader_name(loader)?;
    validate_id(game_version)?;
    let mut result = Vec::new();
    match loader {
        "fabric" | "quilt" => {
            let base = if loader == "fabric" {
                "https://meta.fabricmc.net/v2"
            } else {
                "https://meta.quiltmc.org/v3"
            };
            let bytes = minecraft::fetch_bytes(
                &state.client,
                &format!("{base}/versions/loader/{game_version}"),
                16 * 1024 * 1024,
            )
            .await?;
            let metadata = minecraft::parse_json(&bytes)?;
            for item in metadata.as_array().ok_or("加载器版本列表无效")? {
                let Some(id) = item["loader"]["version"].as_str() else {
                    continue;
                };
                validate_id(id)?;
                let stable = item["loader"]["stable"]
                    .as_bool()
                    .unwrap_or(!id.contains("beta") && !id.contains("alpha"));
                result.push(LoaderVersion {
                    id: id.into(),
                    stable,
                    recommended: false,
                });
            }
        }
        "forge" => {
            let xml = minecraft::fetch_bytes(
                &state.client,
                "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
                16 * 1024 * 1024,
            )
            .await?;
            let xml = String::from_utf8(xml).map_err(|_| "Forge Maven 元数据编码无效")?;
            let prefix = format!("{game_version}-");
            for capture in regex::Regex::new(r"<version>([^<]+)</version>")
                .map_err(|e| e.to_string())?
                .captures_iter(&xml)
            {
                let coordinate = capture.get(1).ok_or("Forge版本字段为空")?.as_str();
                if let Some(id) = coordinate.strip_prefix(&prefix) {
                    validate_id(id)?;
                    result.push(LoaderVersion {
                        id: id.into(),
                        stable: !id.contains("beta") && !id.contains("alpha"),
                        recommended: false,
                    });
                }
            }
            let promotions = minecraft::fetch_bytes(
                &state.client,
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
                let xml = minecraft::fetch_bytes(
                    &state.client,
                    "https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml",
                    16 * 1024 * 1024,
                )
                .await?;
                let xml =
                    String::from_utf8(xml).map_err(|_| "NeoForge 旧版 Maven 元数据编码无效")?;
                for capture in regex::Regex::new(r"<version>([^<]+)</version>")
                    .map_err(|e| e.to_string())?
                    .captures_iter(&xml)
                {
                    let coordinate = capture.get(1).ok_or("NeoForge 旧版版本字段为空")?.as_str();
                    if let Some(id) = coordinate.strip_prefix("1.20.1-") {
                        validate_id(id)?;
                        result.push(LoaderVersion {
                            id: id.into(),
                            stable: !id.contains("beta") && !id.contains("alpha"),
                            recommended: false,
                        });
                    }
                }
            } else {
                let bytes = minecraft::fetch_bytes(
                    &state.client,
                    "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
                    8 * 1024 * 1024,
                )
                .await?;
                let metadata = minecraft::parse_json(&bytes)?;
                let prefix = neo_prefix(game_version);
                for id in metadata["versions"]
                    .as_array()
                    .ok_or("NeoForge Maven 版本列表无效")?
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|id| id.starts_with(&prefix))
                {
                    validate_id(id)?;
                    result.push(LoaderVersion {
                        id: id.into(),
                        stable: !id.contains("beta") && !id.contains("alpha"),
                        recommended: false,
                    });
                }
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
    for (index, library) in values.iter_mut().enumerate() {
        state.control.checkpoint().await?;
        if !minecraft::rules_allow(library.get("rules")) {
            continue;
        }
        if let Some(download) = minecraft::library_download(state, library, &libraries).await? {
            minecraft::ensure_download_with_control(&state.client, &download, Some(&state.control))
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
    let bytes = minecraft::fetch_bytes(&state.client, &url, 8 * 1024 * 1024).await?;
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
    let checksum = minecraft::fetch_bytes(&state.client, &format!("{url}.sha1"), 1024).await?;
    let checksum = String::from_utf8(checksum)
        .map_err(|_| "安装器 SHA-1 编码无效")?
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !minecraft::valid_sha1(&checksum) {
        return Err("官方安装器校验值无效".into());
    }
    let download = Download {
        path: safe_join(&state.data_dir, &format!("installers/cache/{file}"))?,
        url,
        sha1: checksum,
        size: None,
    };
    minecraft::ensure_download_with_control(&state.client, &download, Some(&state.control)).await?;
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
    let mut command = tokio::process::Command::new(java);
    command
        .arg(format!("-Djava.io.tmpdir={}", temp.display()))
        .arg("-Dfile.encoding=UTF-8")
        .arg("-Djava.awt.headless=true")
        .arg("-Djava.net.useSystemProxies=true")
        .arg("-Dsun.stdout.encoding=UTF-8")
        .arg("-Dsun.stderr.encoding=UTF-8")
        .arg("-jar")
        .arg(jar)
        .arg("--installClient")
        .arg(stage)
        .current_dir(stage)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
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
                return Err("加载器安装器运行超过 15 分钟，已终止；独立暂存目录保留日志".into());
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
    let stage = safe_join(
        &state.data_dir,
        &format!("installers/staging/{loader}-{}", uuid::Uuid::new_v4()),
    )?;
    let base_json = safe_join(
        &stage,
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
            &stage,
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
        expected_id,
        "loader-installer",
        0,
        1,
        0,
        0,
        "运行官方安装器及其客户端后处理",
    );
    run_installer(state, app, Path::new(&java.path), &jar, &stage, loader).await?;
    let output = safe_join(
        &stage,
        &format!("versions/{expected_id}/{expected_id}.json"),
    )?;
    let mut profile = minecraft::parse_json(
        &fs::read(output).map_err(|e| format!("安装器未产出预期客户端配置：{e}"))?,
    )?;
    validate_profile(&profile, game_version)?;
    if profile["id"].as_str() != Some(expected_id) {
        return Err("安装器生成了非预期版本 ID".into());
    }
    commit_staged_libraries(&stage, root)?;
    // This also verifies the generated patched/client jars with the checksums
    // carried by the publisher's version.json. A zero exit code alone is insufficient.
    prepare_profile(state, app, &mut profile, root).await?;
    profile["launcherMetadata"] = json!({"loader":loader,"loaderVersion":version,"officialVanillaBase":game_version,"installer":jar.file_name().unwrap_or_default().to_string_lossy(),"stagingDirectory":stage.to_string_lossy()});
    write_profile(root, &profile)
}

/// Callers already holding state.operation (e.g. modpack installation) use this.
pub async fn install_loader_inner(
    state: &LauncherState,
    app: &AppHandle,
    loader: &str,
    game_version: &str,
    loader_version: &str,
) -> Result<LoaderInstallResult, String> {
    loader_name(loader)?;
    validate_id(game_version)?;
    let choices = loader_versions(state, loader, game_version).await?;
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
    state.control.checkpoint().await?;
    let root = PathBuf::from(state.snapshot()?.config.game_directory);
    let (_, base) = minecraft::install(state, app, game_version).await?;
    let id = if matches!(loader, "fabric" | "quilt") {
        lightweight_loader(state, app, loader, game_version, &version, &root).await?
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
) -> Result<LoaderInstallResult, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "已有安装或启动准备任务运行")?;
    let task = state
        .control
        .begin("loader", &game_version, &format!("安装 {loader}"));
    let result = install_loader_inner(&state, &app, &loader, &game_version, &loader_version).await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    if let Err(error) = &result {
        minecraft::log(&app, &state, "error", error);
        minecraft::progress(&app, &game_version, "error", 0, 0, 0, 0, error);
    }
    result
}

pub(crate) async fn authlib_injector(state: &LauncherState) -> Result<PathBuf, String> {
    let api = "https://authlib-injector.yushi.moe/artifact/latest.json";
    let metadata =
        minecraft::parse_json(&minecraft::fetch_bytes(&state.client, api, 1024 * 1024).await?)?;
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
    let bytes = minecraft::fetch_bytes(&state.client, url, 16 * 1024 * 1024).await?;
    state.control.throttle(bytes.len()).await?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected.to_ascii_lowercase() {
        return Err("authlib-injector SHA256 校验失败".into());
    }
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
    use super::*;
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
}
