use crate::{
    errors::{expected, AppResult},
    instances, minecraft,
    storage::{safe_join, validate_id, LauncherState},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, State};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MAX_WORLD_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MAX_WORLD_FILES: usize = 100_000;
const MAX_NBT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct World {
    pub folder_name: String,
    pub name: String,
    pub last_played: Option<i64>,
    pub game_mode: Option<String>,
    pub hardcore: bool,
    pub version_name: Option<String>,
    pub data_version: Option<i32>,
    pub size_bytes: u64,
    pub icon_data_url: Option<String>,
    pub error: Option<String>,
    pub warning: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldBackup {
    pub path: String,
    pub files: usize,
    pub size_bytes: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub file_name: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotData {
    pub file_name: String,
    pub data_url: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedResource {
    pub file_name: String,
    pub path: String,
    pub size_bytes: u64,
}

fn game_root(
    state: &LauncherState,
    version: &str,
    instance_id: Option<&str>,
) -> Result<PathBuf, String> {
    let data = state.snapshot()?;
    let instance = instance_id
        .map(|id| {
            data.instances
                .iter()
                .find(|instance| instance.id == id)
                .ok_or("实例不存在")
        })
        .transpose()?;
    instances::checked_absolute(&minecraft::game_directory(&data.config, version, instance)?)
}

#[derive(Deserialize)]
struct LevelRoot {
    #[serde(rename = "Data")]
    data: LevelData,
}
#[derive(Deserialize, Default)]
#[serde(default)]
struct LevelData {
    #[serde(rename = "LevelName")]
    name: String,
    #[serde(rename = "LastPlayed")]
    last_played: Option<i64>,
    #[serde(rename = "GameType")]
    game_type: Option<i32>,
    hardcore: Option<i8>,
    #[serde(rename = "Version")]
    version: Option<LevelVersion>,
    #[serde(rename = "DataVersion")]
    data_version: Option<i32>,
}
#[derive(Deserialize)]
struct LevelVersion {
    #[serde(rename = "Name")]
    name: Option<String>,
}

fn read_level(path: &Path) -> Result<LevelData, String> {
    instances::checked_absolute(path)?;
    let compressed = fs::metadata(path).map_err(|e| e.to_string())?.len();
    if compressed > MAX_NBT_BYTES as u64 {
        return Err("level.dat 超出 16 MiB 限制".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let data = if bytes.starts_with(&[31, 139]) {
        let mut output = Vec::new();
        flate2::read::GzDecoder::new(&bytes[..])
            .take(MAX_NBT_BYTES as u64 + 1)
            .read_to_end(&mut output)
            .map_err(|e| format!("level.dat 解压失败：{e}"))?;
        if output.len() > MAX_NBT_BYTES {
            return Err("level.dat 解压超出 16 MiB 限制".into());
        }
        output
    } else {
        bytes
    };
    let level: LevelRoot =
        fastnbt::from_bytes(&data).map_err(|e| format!("level.dat NBT 无效：{e}"))?;
    Ok(level.data)
}

fn png_data(path: &Path, limit: u64) -> Result<String, String> {
    instances::checked_absolute(path)?;
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("PNG 图片超出大小限制".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return Err("图片不是有效 PNG".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| "PNG 宽度无效")?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| "PNG 高度无效")?);
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || u64::from(width) * u64::from(height) > 64 * 1024 * 1024
    {
        return Err("PNG 像素尺寸超出预览限制".into());
    }
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

const MAX_SKIN_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultSkin {
    pub id: String,
    pub name: String,
    pub data_url: Option<String>,
    pub model: String,
    pub source_version: Option<String>,
    pub source_url: Option<String>,
    pub description: String,
    pub local_path: Option<String>,
}

const STEVE_SKIN_PATHS: &[&str] = &[
    "assets/minecraft/textures/entity/player/wide/steve.png",
    "assets/minecraft/textures/entity/steve.png",
];
const ALEX_SKIN_PATHS: &[&str] = &[
    "assets/minecraft/textures/entity/player/slim/alex.png",
    "assets/minecraft/textures/entity/alex.png",
];

fn read_client_skin(path: &Path, entry_paths: &[&str], name: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| format!("打开官方客户端失败：{e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("官方客户端 JAR 无法读取：{e}"))?;
    for candidate in entry_paths {
        let mut entry = match archive.by_name(candidate) {
            Ok(entry) => entry,
            Err(zip::result::ZipError::FileNotFound) => continue,
            Err(error) => return Err(format!("读取 {name} 角色纹理失败：{error}")),
        };
        if entry.size() > MAX_SKIN_BYTES {
            return Err(format!("{name} 角色纹理超出 1 MiB 限制"));
        }
        let mut bytes = Vec::new();
        entry
            .by_ref()
            .take(MAX_SKIN_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取 {name} 角色纹理失败：{e}"))?;
        if bytes.len() as u64 > MAX_SKIN_BYTES {
            return Err(format!("{name} 角色纹理解压后超出 1 MiB 限制"));
        }
        if bytes.len() < 24
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
            || bytes[8..12] != 13u32.to_be_bytes()
            || &bytes[12..16] != b"IHDR"
        {
            return Err(format!("{name} 角色纹理不是有效 PNG"));
        }
        let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| "PNG 宽度无效")?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| "PNG 高度无效")?);
        if width != 64 || height != 64 {
            return Err(format!(
                "{name} 角色纹理必须为 64x64 PNG，实际为 {width}x{height}"
            ));
        }
        return Ok(bytes);
    }
    Err(format!("官方客户端缺少 {name} 角色纹理"))
}

async fn load_default_skin(
    state: &LauncherState,
    skin: &str,
    version_id: Option<&str>,
) -> Result<DefaultSkin, String> {
    let (name, model, entry_paths) = match skin {
        "steve" => ("Steve", "classic", STEVE_SKIN_PATHS),
        "alex" => ("Alex", "slim", ALEX_SKIN_PATHS),
        _ => return Err("默认角色仅支持 steve 或 alex".into()),
    };
    let _guard = state.operation.lock().await;
    let task = state
        .control
        .begin("default-skin", skin, &format!("读取 {name} 角色纹理"));
    let result: Result<DefaultSkin, String> = async {
        let config = state.snapshot()?.config;
        let root = PathBuf::from(config.game_directory);
        if !root.is_absolute() {
            return Err("游戏目录必须是绝对路径，无法定位官方客户端".into());
        }
        let selected_version = match version_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => id.to_owned(),
            None => {
                let manifest = minecraft::manifest(state)
                    .await
                    .map_err(|e| format!("获取官方版本清单失败：{e}"))?;
                manifest["latest"]["release"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("官方版本清单缺少 latest.release")?
                    .to_owned()
            }
        };
        let metadata = minecraft::resolve_metadata(state, &selected_version, &root)
            .await
            .map_err(|e| format!("解析角色来源版本 {selected_version} 失败：{e}"))?;
        let base_id = metadata["_launcherBaseId"]
            .as_str()
            .or_else(|| metadata["_launcherClientId"].as_str())
            .unwrap_or(&selected_version);
        let client_id = metadata["_launcherClientId"].as_str().unwrap_or(base_id);
        validate_id(base_id)?;
        validate_id(client_id)?;
        let source_version = base_id.to_owned();
        let client = minecraft::download_from(
            &metadata["downloads"]["client"],
            &root,
            Some(&format!("versions/{client_id}/{client_id}.jar")),
        )
        .map_err(|e| format!("官方客户端下载信息无效：{e}"))?;
        if client.url.is_empty() || client.size.unwrap_or(0) == 0 {
            return Err("官方客户端下载必须提供 URL 和有效文件大小".into());
        }
        minecraft::ensure_download_with_control(&state.client, &client, Some(&state.control))
            .await
            .map_err(|e| format!("获取并校验官方客户端失败：{e}"))?;
        let source_url = client.url.clone();
        let client_path = client.path.clone();
        let bytes =
            tokio::task::spawn_blocking(move || read_client_skin(&client_path, entry_paths, name))
                .await
                .map_err(|e| format!("读取官方客户端任务失败：{e}"))??;
        Ok(DefaultSkin {
            id: skin.into(),
            name: name.into(),
            data_url: Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes))),
            model: model.into(),
            source_version: Some(source_version),
            source_url: Some(source_url),
            description: "仅在主动选择后，从 SHA-1 和大小已校验的官方客户端中读取。".into(),
            local_path: None,
        })
    }
    .await;
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

#[tauri::command]
pub async fn get_default_skin(
    state: State<'_, Arc<LauncherState>>,
    skin: String,
    version_id: Option<String>,
) -> Result<DefaultSkin, String> {
    load_default_skin(&state, &skin, version_id.as_deref()).await
}

fn tree_size(root: &Path) -> Result<u64, String> {
    let mut queue = VecDeque::from([root.to_owned()]);
    let mut count = 0usize;
    let mut total = 0u64;
    while let Some(directory) = queue.pop_front() {
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = instances::checked_absolute(&entry.path())?;
            let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
            count += 1;
            if count > MAX_WORLD_FILES {
                return Err("存档超过 100000 个文件或目录".into());
            }
            if metadata.is_dir() {
                queue.push_back(entry.path());
            } else if metadata.is_file() {
                total = total.checked_add(metadata.len()).ok_or("存档大小溢出")?;
            } else {
                return Err("存档包含特殊文件".into());
            }
            if total > MAX_WORLD_BYTES {
                return Err("存档超过 32 GiB".into());
            }
        }
    }
    Ok(total)
}

fn world_info(saves: &Path, folder: &str) -> Result<World, String> {
    validate_id(folder)?;
    let root = safe_join(saves, folder)?;
    if !root.is_dir() {
        return Err("存档目录不存在".into());
    }
    let mut world = World {
        folder_name: folder.into(),
        name: folder.into(),
        last_played: None,
        game_mode: None,
        hardcore: false,
        version_name: None,
        data_version: None,
        size_bytes: 0,
        icon_data_url: None,
        error: None,
        warning: None,
    };
    match read_level(&safe_join(&root, "level.dat")?) {
        Ok(data) => {
            if !data.name.is_empty() {
                world.name = data.name;
            }
            world.last_played = data.last_played;
            world.game_mode = data.game_type.map(|kind| {
                match kind {
                    0 => "生存",
                    1 => "创造",
                    2 => "冒险",
                    3 => "旁观",
                    _ => "未知",
                }
                .into()
            });
            world.hardcore = data.hardcore == Some(1);
            world.version_name = data.version.and_then(|v| v.name);
            world.data_version = data.data_version;
        }
        Err(error) => world.error = Some(error),
    }
    match tree_size(&root) {
        Ok(size) => world.size_bytes = size,
        Err(error) => {
            world.warning = Some(error);
        }
    }
    world.icon_data_url = png_data(&safe_join(&root, "icon.png")?, 512 * 1024).ok();
    Ok(world)
}

#[tauri::command]
pub async fn list_worlds(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> AppResult<Vec<World>> {
    list_worlds_inner(state, version_id, instance_id)
        .await
        .map_err(expected)
}

async fn list_worlds_inner(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> Result<Vec<World>, String> {
    let root = game_root(&state, &version_id, instance_id.as_deref())?;
    tokio::task::spawn_blocking(move || {
        let saves = safe_join(&root, "saves")?;
        if !saves.exists() {
            return Ok(Vec::new());
        }
        let mut result = Vec::new();
        for entry in fs::read_dir(&saves).map_err(|e| e.to_string())?.take(2000) {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".world-import-")
                || !entry.file_type().map_err(|e| e.to_string())?.is_dir()
            {
                continue;
            }
            let path = safe_join(&saves, &name)?;
            if !safe_join(&path, "level.dat")?.is_file() {
                continue;
            }
            result.push(world_info(&saves, &name)?);
        }
        result.sort_by(|a, b| b.last_played.cmp(&a.last_played).then(a.name.cmp(&b.name)));
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn hash(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 128 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn backup_world_inner(
    state: &LauncherState,
    root: &Path,
    folder: &str,
    output: &Path,
) -> Result<WorldBackup, String> {
    validate_id(folder)?;
    let world = safe_join(&safe_join(root, "saves")?, folder)?;
    if !safe_join(&world, "level.dat")?.is_file() {
        return Err("世界目录缺少 level.dat".into());
    }
    let output = instances::checked_absolute(output)?;
    if output.starts_with(&world) {
        return Err("备份文件不能写入正在备份的世界目录".into());
    }
    if output.exists() {
        return Err("目标文件已存在，原文件未覆盖".into());
    }
    if !output
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("世界备份需要保存为 .zip".into());
    }
    let files = instances::collect_files(&world)?;
    let total = files.iter().map(|file| file.size).sum();
    let parent = output.parent().ok_or("备份目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = safe_join(
        parent,
        &format!(".world-backup-{}.part", uuid::Uuid::new_v4()),
    )?;
    let result = (|| {
        let mut archive = ZipWriter::new(
            fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|e| e.to_string())?,
        );
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644)
            .large_file(true);
        for file in &files {
            instances::sync_checkpoint(state)?;
            archive
                .start_file(format!("{folder}/{}", file.relative), options)
                .map_err(|e| e.to_string())?;
            std::io::copy(
                &mut fs::File::open(safe_join(&world, &file.relative)?)
                    .map_err(|e| e.to_string())?,
                &mut archive,
            )
            .map_err(|e| e.to_string())?;
        }
        archive
            .start_file("launcher-world-backup.json", options)
            .map_err(|e| e.to_string())?;
        archive.write_all(&serde_json::to_vec_pretty(&json!({"formatVersion":1,"worldFolder":folder,"createdAt":chrono::Utc::now().to_rfc3339(),"files":files})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        archive
            .finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        if instances::collect_files(&world)? != files {
            return Err("备份期间世界发生变化，请退出游戏后重试；原世界未改变".into());
        }
        if output.exists() {
            return Err("备份期间出现同名目标文件，未覆盖".into());
        }
        match fs::rename(&temporary, &output) {
            Ok(()) => {}
            Err(error) => {
                let mut target = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&output)
                    .map_err(|_| {
                        format!(
                            "无法提交备份：{error}；已保留暂存文件 {}",
                            temporary.display()
                        )
                    })?;
                std::io::copy(
                    &mut fs::File::open(&temporary).map_err(|e| e.to_string())?,
                    &mut target,
                )
                .map_err(|e| e.to_string())?;
                target.sync_all().map_err(|e| e.to_string())?;
                drop(target);
                if hash(&temporary)? != hash(&output)? {
                    return Err("备份提交校验失败，原世界未改变，暂存备份仍保留".into());
                }
                let _ = fs::remove_file(&temporary);
            }
        }
        Ok(WorldBackup {
            path: output.to_string_lossy().into_owned(),
            files: files.len(),
            size_bytes: total,
        })
    })();
    // Never remove a selected output or source world on any error; even partial
    // temporary backups remain available for diagnosis/recovery.
    result
}

#[tauri::command]
pub async fn backup_world(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    world_folder: String,
    output_path: String,
) -> Result<WorldBackup, String> {
    let _guard = state.operation.lock().await;
    let root = game_root(&state, &version_id, instance_id.as_deref())?;
    let task = state
        .control
        .begin("world-backup", &world_folder, "备份世界");
    let shared = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        backup_world_inner(&shared, &root, &world_folder, Path::new(&output_path))
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()));
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    if let Ok(backup) = &result {
        minecraft::log(
            &app,
            &state,
            "info",
            format!("世界备份已保存：{}", backup.path),
        );
    }
    result
}

fn inspect_world_archive(path: &Path) -> Result<String, String> {
    instances::checked_absolute(path)?;
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > MAX_WORLD_BYTES {
        return Err("世界 ZIP 超过 32 GiB".into());
    }
    let mut archive = ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if archive.len() > MAX_WORLD_FILES {
        return Err("ZIP 条目超过 100000 个".into());
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    let mut candidates = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let name = entry.name().trim_end_matches('/');
        if name.is_empty() {
            continue;
        }
        safe_join(Path::new("validation-root"), name)?;
        if !names.insert(name.to_ascii_lowercase()) {
            return Err("ZIP 包含重复或仅大小写不同的路径".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("世界 ZIP 不允许符号链接".into());
        }
        total = total.checked_add(entry.size()).ok_or("世界 ZIP 大小溢出")?;
        if total > MAX_WORLD_BYTES {
            return Err("世界 ZIP 解压超过 32 GiB".into());
        }
        if !entry.is_dir() && (name == "level.dat" || name.ends_with("/level.dat")) {
            candidates.push(name.trim_end_matches("level.dat").to_owned());
        }
    }
    candidates.sort_by_key(|prefix| prefix.matches('/').count());
    let prefix = candidates
        .first()
        .ok_or("ZIP 中未找到 Java 版 level.dat，不是可导入的世界")?
        .clone();
    if candidates
        .iter()
        .skip(1)
        .any(|candidate| candidate.matches('/').count() == prefix.matches('/').count())
    {
        return Err("ZIP 包含多个世界，请分别导入单个世界".into());
    }
    Ok(prefix)
}

fn import_world_inner(
    state: &LauncherState,
    root: &Path,
    path: &Path,
    name: Option<String>,
) -> Result<World, String> {
    let prefix = inspect_world_archive(path)?;
    let saves = safe_join(root, "saves")?;
    fs::create_dir_all(&saves).map_err(|e| e.to_string())?;
    let mut folder = name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            prefix
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
        })
        .or_else(|| {
            path.file_stem()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "导入的世界".into());
    validate_id(&folder)?;
    if safe_join(&saves, &folder)?.exists() {
        if name.as_deref().is_some_and(|name| !name.trim().is_empty()) {
            return Err("同名世界已存在，请使用新的世界目录名".into());
        }
        folder = format!(
            "{folder}-import-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
    }
    let destination = safe_join(&saves, &folder)?;
    let stage = safe_join(&saves, &format!(".world-import-{}", uuid::Uuid::new_v4()))?;
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for index in 0..archive.len() {
        instances::sync_checkpoint(state)?;
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(relative) = entry.name().strip_prefix(&prefix).map(str::to_owned) else {
            continue;
        };
        if relative.is_empty() || entry.is_dir() {
            continue;
        }
        let target = safe_join(&stage, &relative)?;
        fs::create_dir_all(target.parent().ok_or("ZIP 路径无效")?).map_err(|e| e.to_string())?;
        let expected = entry.size();
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)
            .map_err(|e| e.to_string())?;
        let copied = std::io::copy(&mut entry.by_ref().take(expected + 1), &mut output)
            .map_err(|e| e.to_string())?;
        if copied != expected {
            return Err("世界 ZIP 解压长度与清单不符，暂存副本保留，原世界未改变".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
    }
    read_level(&safe_join(&stage, "level.dat")?)?;
    if destination.exists() {
        return Err("导入期间出现同名世界，未覆盖；暂存副本保留".into());
    }
    let mut warning = None;
    if let Err(error) = fs::rename(&stage, &destination) {
        let files = instances::collect_files(&stage)?;
        instances::copy_snapshot(&stage, &destination, &files).map_err(|copy_error| {
            format!(
                "世界目录提交失败（{error}），校验复制也失败（{copy_error}）；暂存副本保留于 {}",
                stage.display()
            )
        })?;
        // The verified fallback succeeds even when Windows disallows renaming a
        // newly created directory. Preserve its source instead of changing ACLs.
        warning = Some(format!(
            "Windows 拒绝目录改名，已用校验复制导入；恢复用暂存副本保留于 {}",
            stage.display()
        ));
    }
    let mut world = world_info(&saves, &folder)?;
    world.warning = warning.or(world.warning);
    Ok(world)
}

#[tauri::command]
pub async fn import_world(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    path: String,
    name: Option<String>,
) -> Result<World, String> {
    let _guard = state.operation.lock().await;
    let root = game_root(&state, &version_id, instance_id.as_deref())?;
    let path = instances::checked_absolute(Path::new(&path))?;
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("请选择 Java 世界 .zip 文件".into());
    }
    let task = state.control.begin("world-import", &version_id, "导入世界");
    let shared = state.inner().clone();
    let result =
        tokio::task::spawn_blocking(move || import_world_inner(&shared, &root, &path, name))
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

#[tauri::command]
pub async fn list_screenshots(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> Result<Vec<Screenshot>, String> {
    let root = safe_join(
        &game_root(&state, &version_id, instance_id.as_deref())?,
        "screenshots",
    )?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.take(5000) {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.to_ascii_lowercase().ends_with(".png") {
            continue;
        }
        let path = safe_join(&root, &file_name)?;
        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        if metadata.is_file() {
            result.push(Screenshot {
                file_name,
                size_bytes: metadata.len(),
                modified_at: metadata
                    .modified()
                    .ok()
                    .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339()),
            });
        }
    }
    result.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    result.truncate(200);
    Ok(result)
}

#[tauri::command]
pub async fn read_screenshot(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    file_name: String,
) -> Result<ScreenshotData, String> {
    validate_id(&file_name)?;
    if !file_name.to_ascii_lowercase().ends_with(".png") {
        return Err("只能预览 screenshots 目录中的 PNG".into());
    }
    let path = safe_join(
        &game_root(&state, &version_id, instance_id.as_deref())?,
        &format!("screenshots/{file_name}"),
    )?;
    tokio::task::spawn_blocking(move || {
        Ok(ScreenshotData {
            file_name,
            data_url: png_data(&path, 20 * 1024 * 1024)?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_local_resources(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
    paths: Vec<String>,
    resource_type: String,
) -> Result<Vec<ImportedResource>, String> {
    let (folder, extension) = match resource_type.as_str() {
        "mod" => ("mods", "jar"),
        "resourcepack" => ("resourcepacks", "zip"),
        "shader" => ("shaderpacks", "zip"),
        _ => return Err("不支持的本地资源类型".into()),
    };
    if paths.is_empty() || paths.len() > 100 {
        return Err("一次请选择 1–100 个资源文件".into());
    }
    let _guard = state.operation.lock().await;
    let root = game_root(&state, &version_id, instance_id.as_deref())?;
    let task = state
        .control
        .begin("local-resource-import", &version_id, "导入本地资源");
    let shared = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        let directory = safe_join(&root, folder)?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let mut plan = Vec::new();
        let mut names = HashSet::new();
        for path in paths {
            let source = instances::checked_absolute(Path::new(&path))?;
            let metadata = fs::metadata(&source).map_err(|e| e.to_string())?;
            if !metadata.is_file() || metadata.len() > 2 * 1024 * 1024 * 1024 {
                return Err("本地资源必须为不超过 2 GiB 的普通文件".into());
            }
            if !source
                .extension()
                .is_some_and(|value| value.eq_ignore_ascii_case(extension))
            {
                return Err(format!("该分类只接受 .{extension} 文件"));
            }
            let name = source
                .file_name()
                .ok_or("文件名无效")?
                .to_string_lossy()
                .into_owned();
            validate_id(&name)?;
            if !names.insert(name.to_ascii_lowercase()) {
                return Err("所选文件包含重复名称".into());
            }
            let destination = safe_join(&directory, &name)?;
            if destination.exists() {
                return Err(format!("{name} 已存在，未覆盖现有资源"));
            }
            ZipArchive::new(fs::File::open(&source).map_err(|e| e.to_string())?)
                .map_err(|_| format!("{name} 不是有效的 JAR/ZIP"))?;
            plan.push((source, destination, name, metadata.len()));
        }
        let mut result = Vec::new();
        for (source, destination, file_name, size_bytes) in plan {
            instances::sync_checkpoint(&shared)?;
            let expected = hash(&source)?;
            let temporary =
                directory.join(format!(".resource-import-{}.part", uuid::Uuid::new_v4()));
            fs::copy(&source, &temporary).map_err(|e| e.to_string())?;
            if hash(&temporary)? != expected || hash(&source)? != expected {
                return Err("复制期间源资源发生变化，现有资源未覆盖".into());
            }
            if destination.exists() {
                return Err("复制期间出现同名资源，现有文件未覆盖".into());
            }
            // create_new ensures a concurrent app cannot turn this copy into an overwrite.
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&destination)
                .map_err(|e| e.to_string())?;
            std::io::copy(
                &mut fs::File::open(&temporary).map_err(|e| e.to_string())?,
                &mut output,
            )
            .map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
            drop(output);
            if hash(&destination)? != expected {
                return Err("本地资源副本校验失败，源文件未改变".into());
            }
            let _ = fs::remove_file(temporary);
            result.push(ImportedResource {
                file_name,
                path: destination.to_string_lossy().into_owned(),
                size_bytes,
            });
        }
        Ok(result)
    })
    .await
    .unwrap_or_else(|error| Err(error.to_string()));
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/content-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn gzip_world_metadata_is_read_without_changing_original() {
        let root = root();
        let path = root.join("level.dat");
        let data = std::collections::HashMap::from([(
            "Data".to_string(),
            fastnbt::Value::Compound(std::collections::HashMap::from([
                (
                    "LevelName".into(),
                    fastnbt::Value::String("测试世界".into()),
                ),
                ("LastPlayed".into(), fastnbt::Value::Long(1234)),
                ("hardcore".into(), fastnbt::Value::Byte(1)),
                ("GameType".into(), fastnbt::Value::Int(0)),
            ])),
        )]);
        let nbt = fastnbt::to_bytes(&data).unwrap();
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&nbt).unwrap();
        let bytes = encoder.finish().unwrap();
        fs::write(&path, &bytes).unwrap();
        let level = read_level(&path).unwrap();
        assert_eq!(level.name, "测试世界");
        assert_eq!(level.hardcore, Some(1));
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    #[test]
    fn world_zip_traversal_is_rejected_before_any_extraction() {
        let root = root();
        for name in [
            "../level.dat",
            "world/../../level.dat",
            "C:/level.dat",
            "world/CON.txt",
        ] {
            let path = root.join("bad.zip");
            let mut zip = ZipWriter::new(fs::File::create(&path).unwrap());
            zip.start_file(name, SimpleFileOptions::default()).unwrap();
            zip.write_all(b"nbt").unwrap();
            zip.finish().unwrap();
            assert!(inspect_world_archive(&path).is_err(), "{name}");
        }
    }
    #[test]
    fn png_previews_reject_non_png_and_excessive_dimensions() {
        let root = root();
        let path = root.join("image.png");
        fs::write(&path, b"not a PNG").unwrap();
        assert!(png_data(&path, 1024).is_err());
        let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        bytes.extend(20000u32.to_be_bytes());
        bytes.extend(20000u32.to_be_bytes());
        fs::write(&path, bytes).unwrap();
        assert!(png_data(&path, 1024).is_err());
    }
    #[test]
    fn gzip_world_metadata_rejects_expansion_over_limit() {
        let root = root();
        let path = root.join("level.dat");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&vec![0u8; MAX_NBT_BYTES + 1]).unwrap();
        fs::write(&path, encoder.finish().unwrap()).unwrap();
        assert!(read_level(&path).err().unwrap().contains("解压超出"));
    }
    #[test]
    fn world_backup_and_import_roundtrip_never_replace_original_world() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let root = root();
            let game = root.join("game");
            let data = root.join("data");
            fs::create_dir_all(&data).unwrap();
            let world = game.join("saves/Original");
            fs::create_dir_all(&world).unwrap();
            let nbt = fastnbt::to_bytes(&std::collections::HashMap::from([(
                "Data".to_string(),
                fastnbt::Value::Compound(std::collections::HashMap::from([(
                    "LevelName".into(),
                    fastnbt::Value::String("Roundtrip world".into()),
                )])),
            )]))
            .unwrap();
            fs::write(world.join("level.dat"), &nbt).unwrap();
            fs::write(world.join("fixture.txt"), b"world bytes").unwrap();
            let state = Arc::new(LauncherState {
                data: std::sync::Mutex::new(crate::models::Persisted::default()),
                data_dir: data,
                client: crate::storage::test_client(),
                operation: tokio::sync::Mutex::new(()),
                control: Default::default(),
                games: Default::default(),
            });
            let copy = state.clone();
            let game_copy = game.clone();
            let output = root.join("world.zip");
            let output_copy = output.clone();
            let backup = tokio::task::spawn_blocking(move || {
                backup_world_inner(&copy, &game_copy, "Original", &output_copy)
            })
            .await
            .unwrap()
            .unwrap();
            assert_eq!(backup.files, 2);
            let copy = state.clone();
            let game_copy = game.clone();
            let imported = tokio::task::spawn_blocking(move || {
                import_world_inner(&copy, &game_copy, &output, Some("Imported".into()))
            })
            .await
            .unwrap()
            .unwrap();
            assert_eq!(imported.name, "Roundtrip world");
            assert_eq!(fs::read(world.join("level.dat")).unwrap(), nbt);
            assert_eq!(
                fs::read(game.join("saves/Imported/fixture.txt")).unwrap(),
                b"world bytes"
            );
        });
    }

    const FIXTURE_PNG: &[u8] = include_bytes!("../../tests/fixtures/skin64.png");
    const STEVE_ENTRY: &str = "assets/minecraft/textures/entity/player/wide/steve.png";
    const ALEX_ENTRY: &str = "assets/minecraft/textures/entity/player/slim/alex.png";

    struct SkinFixture {
        state: Arc<LauncherState>,
        client_url: String,
        jar_path: PathBuf,
        jar_bytes: Vec<u8>,
    }

    fn skin_fixture(steve: Option<&[u8]>, alex: Option<&[u8]>) -> SkinFixture {
        use sha1::{Digest as _, Sha1};

        let root = root();
        let game = root.join("game");
        let data = root.join("data");
        let version_directory = game.join("versions/1.20.1");
        fs::create_dir_all(&version_directory).unwrap();
        fs::create_dir_all(&data).unwrap();

        let jar_path = version_directory.join("1.20.1.jar");
        let mut jar = ZipWriter::new(fs::File::create(&jar_path).unwrap());
        for (name, bytes) in [(STEVE_ENTRY, steve), (ALEX_ENTRY, alex)] {
            if let Some(bytes) = bytes {
                jar.start_file(name, SimpleFileOptions::default()).unwrap();
                jar.write_all(bytes).unwrap();
            }
        }
        jar.finish().unwrap();
        let jar_bytes = fs::read(&jar_path).unwrap();
        let jar_sha1 = format!("{:x}", Sha1::digest(&jar_bytes));
        let client_url = format!("https://piston-data.mojang.com/v1/objects/{jar_sha1}/client.jar");
        let metadata = json!({
            "id": "1.20.1",
            "type": "release",
            "mainClass": "net.minecraft.client.main.Main",
            "libraries": [],
            "downloads": {
                "client": {
                    "url": client_url,
                    "sha1": jar_sha1,
                    "size": jar_bytes.len()
                }
            }
        });
        let metadata_bytes = serde_json::to_vec_pretty(&metadata).unwrap();
        fs::write(version_directory.join("1.20.1.json"), &metadata_bytes).unwrap();

        let loader_directory = game.join("versions/fixture-loader");
        fs::create_dir_all(&loader_directory).unwrap();
        fs::write(
            loader_directory.join("fixture-loader.json"),
            serde_json::to_vec_pretty(&json!({
                "id": "fixture-loader",
                "inheritsFrom": "1.20.1",
                "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
                "libraries": [],
                "downloads": {"client": {"sha1": "untrusted-override"}}
            }))
            .unwrap(),
        )
        .unwrap();

        let metadata_sha1 = format!("{:x}", Sha1::digest(&metadata_bytes));
        let manifest = json!({
            "latest": {"release": "1.20.1", "snapshot": "1.20.1"},
            "versions": [{
                "id": "1.20.1",
                "type": "release",
                "url": format!("https://piston-meta.mojang.com/v1/packages/{metadata_sha1}/1.20.1.json"),
                "time": "2023-06-08T12:00:00+00:00",
                "releaseTime": "2023-06-12T12:00:00+00:00",
                "sha1": metadata_sha1,
                "complianceLevel": 1
            }]
        });
        fs::write(
            data.join("version-manifest-mojang.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();

        let state = Arc::new(LauncherState {
            data: std::sync::Mutex::new(crate::models::Persisted {
                config: crate::models::Config {
                    game_directory: game.to_string_lossy().into_owned(),
                    ..Default::default()
                },
                ..Default::default()
            }),
            data_dir: data,
            client: reqwest::Client::builder()
                .no_proxy()
                .proxy(reqwest::Proxy::all("http://127.0.0.1:9").unwrap())
                .timeout(std::time::Duration::from_millis(250))
                .build()
                .unwrap(),
            operation: tokio::sync::Mutex::new(()),
            control: Default::default(),
            games: Default::default(),
        });
        SkinFixture {
            state,
            client_url,
            jar_path,
            jar_bytes,
        }
    }

    fn assert_64x64_data_url(data_url: &str) {
        let encoded = data_url.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = STANDARD.decode(encoded).unwrap();
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(&bytes[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 64);
        assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 64);
    }

    #[test]
    fn offline_client_skins_support_inheritance_latest_release_and_camel_case_dto() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let fixture = skin_fixture(Some(FIXTURE_PNG), Some(FIXTURE_PNG));
            let steve = load_default_skin(&fixture.state, "steve", Some("fixture-loader"))
                .await
                .unwrap();
            assert_eq!(steve.id, "steve");
            assert_eq!(steve.name, "Steve");
            assert_eq!(steve.model, "classic");
            assert_eq!(steve.source_version.as_deref(), Some("1.20.1"));
            assert_eq!(
                steve.source_url.as_deref(),
                Some(fixture.client_url.as_str())
            );
            assert!(steve.local_path.is_none());
            assert_64x64_data_url(steve.data_url.as_deref().unwrap());

            let alex = load_default_skin(&fixture.state, "alex", None)
                .await
                .unwrap();
            assert_eq!(alex.id, "alex");
            assert_eq!(alex.name, "Alex");
            assert_eq!(alex.model, "slim");
            assert_eq!(alex.source_version.as_deref(), Some("1.20.1"));
            assert_64x64_data_url(alex.data_url.as_deref().unwrap());
            let dto = serde_json::to_value(&alex).unwrap();
            for key in [
                "id",
                "name",
                "dataUrl",
                "model",
                "sourceVersion",
                "sourceUrl",
            ] {
                assert!(dto.get(key).is_some(), "missing {key}");
            }
            assert!(dto.get("data_url").is_none());
            assert_eq!(fs::read(&fixture.jar_path).unwrap(), fixture.jar_bytes);
        });
    }

    #[test]
    fn client_skins_support_legacy_fallback_paths() {
        for (paths, entry_path, name) in [
            (
                STEVE_SKIN_PATHS,
                "assets/minecraft/textures/entity/steve.png",
                "Steve",
            ),
            (
                ALEX_SKIN_PATHS,
                "assets/minecraft/textures/entity/alex.png",
                "Alex",
            ),
        ] {
            let path = root().join("legacy-client.jar");
            let mut jar = ZipWriter::new(fs::File::create(&path).unwrap());
            jar.start_file(entry_path, SimpleFileOptions::default())
                .unwrap();
            jar.write_all(FIXTURE_PNG).unwrap();
            jar.finish().unwrap();
            assert_eq!(read_client_skin(&path, paths, name).unwrap(), FIXTURE_PNG);
        }
    }

    #[test]
    fn client_skins_reject_missing_entries_for_each_character() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            for (skin, steve, alex) in [
                ("steve", None, Some(FIXTURE_PNG)),
                ("alex", Some(FIXTURE_PNG), None),
            ] {
                let fixture = skin_fixture(steve, alex);
                let error = load_default_skin(&fixture.state, skin, Some("1.20.1"))
                    .await
                    .unwrap_err();
                assert!(error.contains("缺少") && error.contains("纹理"), "{error}");
            }
        });
    }

    #[test]
    fn client_skins_reject_oversized_invalid_and_non_64x64_pngs() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let oversized = vec![0u8; 1024 * 1024 + 1];
            let mut wrong_dimensions = FIXTURE_PNG.to_vec();
            wrong_dimensions[16..20].copy_from_slice(&128u32.to_be_bytes());
            wrong_dimensions[20..24].copy_from_slice(&128u32.to_be_bytes());
            for (bytes, expected) in [
                (oversized.as_slice(), "超出"),
                (b"not a PNG".as_slice(), "PNG"),
                (wrong_dimensions.as_slice(), "64x64"),
            ] {
                let fixture = skin_fixture(Some(bytes), Some(FIXTURE_PNG));
                let error = load_default_skin(&fixture.state, "steve", Some("1.20.1"))
                    .await
                    .unwrap_err();
                assert!(error.contains(expected), "{error}");
            }
        });
    }

    #[test]
    fn cached_client_skins_run_after_cancellation_and_finish_each_request() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let fixture = skin_fixture(Some(FIXTURE_PNG), Some(FIXTURE_PNG));
            let cancelled = fixture
                .state
                .control
                .begin("install", "cancelled", "Cancelled");
            fixture.state.control.cancel(Some(&cancelled));
            assert!(fixture.state.control.checkpoint().await.is_err());
            fixture.state.control.finish(&cancelled, Some("cancelled"));

            for skin in ["steve", "alex", "steve"] {
                let result = load_default_skin(&fixture.state, skin, Some("1.20.1"))
                    .await
                    .unwrap();
                assert_64x64_data_url(result.data_url.as_deref().unwrap());
            }
            let error = load_default_skin(&fixture.state, "steve", Some("../invalid"))
                .await
                .unwrap_err();
            assert!(error.contains("无效"), "{error}");
            let jobs = fixture.state.control.list();
            assert_eq!(jobs.len(), 5);
            assert_eq!(jobs[0].status, "cancelled");
            assert!(jobs[1..4].iter().all(|job| job.status == "completed"));
            assert_eq!(jobs[4].status, "failed");
            assert!(fixture.state.operation.try_lock().is_ok());
        });
    }

    #[test]
    fn client_skin_waits_for_operation_without_clearing_active_cancellation() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let fixture = skin_fixture(Some(FIXTURE_PNG), Some(FIXTURE_PNG));
            let guard = fixture.state.operation.lock().await;
            let active = fixture.state.control.begin("install", "active", "Active");
            fixture.state.control.cancel(Some(&active));
            let request = load_default_skin(&fixture.state, "steve", Some("1.20.1"));
            tokio::pin!(request);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(30), &mut request)
                    .await
                    .is_err()
            );
            assert!(fixture.state.control.checkpoint().await.is_err());
            assert_eq!(fixture.state.control.list().len(), 1);
            fixture.state.control.finish(&active, Some("cancelled"));
            drop(guard);
            request.await.unwrap();
            assert_eq!(fixture.state.control.list()[1].status, "completed");
        });
    }

    #[test]
    fn default_skin_rejects_unknown_ids() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let fixture = skin_fixture(Some(FIXTURE_PNG), Some(FIXTURE_PNG));
            for id in ["mhf", "lumen"] {
                let error = load_default_skin(&fixture.state, id, None)
                    .await
                    .unwrap_err();
                assert!(
                    !error.contains("lumen") && error.contains("steve") && error.contains("alex")
                );
            }
        });
    }
}
