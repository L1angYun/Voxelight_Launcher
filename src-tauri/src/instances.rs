//! Reversible instance metadata changes, cloning, personal backups and restoration.
use crate::{
    models::{Instance, Persisted},
    storage::{safe_join, validate_id, LauncherState},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::State;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MAX_TREE_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MAX_TREE_FILES: usize = 100_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct FileRecord {
    pub relative: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceBackup {
    pub id: String,
    pub instance_id: String,
    pub version_id: String,
    pub created_at: String,
    pub path: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format_version: u32,
    instance: Instance,
    created_at: String,
    files: Vec<FileRecord>,
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
}

pub(crate) fn sync_checkpoint(state: &LauncherState) -> Result<(), String> {
    tokio::runtime::Handle::current().block_on(state.control.checkpoint())
}

/// Validate absolute user paths and reject links/junctions without following their targets.
pub(crate) fn checked_absolute(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("文件或目录必须使用绝对路径".into());
    }
    for part in path.components() {
        if matches!(
            part,
            std::path::Component::ParentDir | std::path::Component::CurDir
        ) {
            return Err("路径不能包含 . 或 ..".into());
        }
    }
    for part in path.ancestors() {
        if let Ok(metadata) = fs::symlink_metadata(part) {
            let mut link = metadata.file_type().is_symlink();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                link |= metadata.file_attributes() & 0x400 != 0;
            }
            if link {
                return Err("拒绝通过符号链接或目录联接访问实例文件".into());
            }
        }
    }
    Ok(path.to_owned())
}

pub(crate) fn instance(data: &Persisted, id: &str) -> Result<Instance, String> {
    data.instances
        .iter()
        .find(|value| value.id == id)
        .cloned()
        .ok_or_else(|| "实例不存在，请刷新实例列表".into())
}

pub(crate) fn instance_root(state: &LauncherState) -> Result<PathBuf, String> {
    let config = state.snapshot()?.config;
    let root = checked_absolute(Path::new(&config.game_directory))?;
    let instances = safe_join(&root, "instances")?;
    fs::create_dir_all(&instances).map_err(|e| format!("无法创建实例目录：{e}"))?;
    checked_absolute(&instances)
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("无法读取实例文件：{e}"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("读取实例文件失败：{e}"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Snapshot a fixed list before creating staging directories; never follow directory links.
pub(crate) fn collect_files(root: &Path) -> Result<Vec<FileRecord>, String> {
    collect_files_controlled(root, None)
}

fn collect_files_controlled(
    root: &Path,
    control: Option<&LauncherState>,
) -> Result<Vec<FileRecord>, String> {
    checked_absolute(root)?;
    if !root.is_dir() {
        return Err("实例目录不存在".into());
    }
    fn visit(
        root: &Path,
        dir: &Path,
        files: &mut Vec<FileRecord>,
        total: &mut u64,
        control: Option<&LauncherState>,
    ) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(|e| format!("无法读取实例目录：{e}"))? {
            if let Some(state) = control {
                sync_checkpoint(state)?;
            }
            let path = entry.map_err(|e| e.to_string())?.path();
            checked_absolute(&path)?;
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if metadata.is_dir() {
                visit(root, &path, files, total, control)?;
            } else if metadata.is_file() {
                if files.len() >= MAX_TREE_FILES {
                    return Err("实例文件超过 100000 个，请先整理后重试".into());
                }
                *total = total.checked_add(metadata.len()).ok_or("实例大小溢出")?;
                if *total > MAX_TREE_BYTES {
                    return Err("实例超过 32 GiB，请使用系统备份工具处理".into());
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "实例文件路径越界")?
                    .components()
                    .map(|p| p.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                safe_join(root, &relative)?;
                files.push(FileRecord {
                    relative,
                    size: metadata.len(),
                    sha256: sha256(&path)?,
                });
            } else {
                return Err("实例包含不支持的特殊文件".into());
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    visit(root, root, &mut files, &mut 0, control)?;
    files.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(files)
}

pub(crate) fn copy_snapshot(
    source: &Path,
    destination: &Path,
    files: &[FileRecord],
) -> Result<(), String> {
    copy_snapshot_controlled(source, destination, files, None)
}

fn copy_snapshot_controlled(
    source: &Path,
    destination: &Path,
    files: &[FileRecord],
    control: Option<&LauncherState>,
) -> Result<(), String> {
    checked_absolute(source)?;
    checked_absolute(destination)?;
    if destination.exists() {
        return Err("暂存目录已经存在，已停止以保护现有文件".into());
    }
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    for record in files {
        if let Some(state) = control {
            sync_checkpoint(state)?;
        }
        let from = safe_join(source, &record.relative)?;
        let to = safe_join(destination, &record.relative)?;
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&from, &to).map_err(|e| format!("复制实例文件失败：{e}"))?;
        if fs::metadata(&to).map_err(|e| e.to_string())?.len() != record.size
            || sha256(&to)? != record.sha256
        {
            return Err("实例副本校验失败，原实例未改变".into());
        }
    }
    // A running game changing a world/configuration causes a safe failure.
    if collect_files_controlled(source, control)? != files {
        return Err("复制期间实例文件发生变化，请关闭游戏后重试。原实例未改变。".into());
    }
    Ok(())
}

pub(crate) fn build_instance(
    name: &str,
    version_id: &str,
    directory: &Path,
    loader: &str,
    loader_version: &str,
) -> Result<Instance, String> {
    validate_name(name)?;
    validate_id(version_id)?;
    serde_json::from_value(json!({
        "id": uuid::Uuid::new_v4().to_string(), "name": name.trim(),
        "versionId": version_id, "gameDirectory": directory.to_string_lossy(),
        "createdAt": chrono::Utc::now().to_rfc3339(), "lastPlayed": null,
        "category":"整合包", "iconPath":null, "notes":"",
        "loader":loader, "loaderVersion":loader_version, "totalPlayTime":0
    }))
    .map_err(|e| e.to_string())
}

pub(crate) fn register(state: &LauncherState, value: Instance) -> Result<Instance, String> {
    state.update(|data| {
        if data
            .instances
            .iter()
            .any(|item| item.id == value.id || item.game_directory == value.game_directory)
        {
            return Err("实例已经登记，已保留其目录".into());
        }
        data.instances.push(value.clone());
        Ok(value)
    })
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("实例名称须为 1 至 80 个可见字符".into());
    }
    Ok(())
}

fn replace_metadata(value: &mut Instance, changes: &[(String, Value)]) -> Result<(), String> {
    let mut json = serde_json::to_value(&*value).map_err(|e| e.to_string())?;
    let object = json.as_object_mut().ok_or("实例信息无效")?;
    for (key, value) in changes {
        object.insert(key.clone(), value.clone());
    }
    *value = serde_json::from_value(json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_instance(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    name: Option<String>,
    category: Option<String>,
    notes: Option<String>,
    icon_path: Option<String>,
    max_memory_mb: Option<u32>,
    java_path: Option<String>,
    jvm_arguments: Option<String>,
    screen_width: Option<u32>,
    screen_height: Option<u32>,
    reset_runtime: Option<bool>,
) -> Result<Instance, String> {
    let _operation = state.operation.lock().await;
    instance(&state.snapshot()?, &instance_id)?;
    let mut changes = Vec::new();
    if reset_runtime.unwrap_or(false) {
        for field in [
            "maxMemoryMb",
            "javaPath",
            "jvmArguments",
            "screenWidth",
            "screenHeight",
        ] {
            changes.push((field.into(), Value::Null));
        }
    }
    if let Some(memory) = max_memory_mb {
        if !(512..=65536).contains(&memory) {
            return Err("实例内存需要在 512–65536 MB 之间".into());
        }
        changes.push(("maxMemoryMb".into(), json!(memory)));
    }
    if let Some(java) = java_path {
        let java = java.trim();
        if java.is_empty() {
            changes.push(("javaPath".into(), Value::Null));
        } else {
            let path = checked_absolute(Path::new(java))?;
            if !path.is_file() {
                return Err("所选 Java 可执行文件不存在".into());
            }
            changes.push(("javaPath".into(), json!(java)));
        }
    }
    if let Some(args) = jvm_arguments {
        if args.len() > 8192 || args.contains(['\0', '\r', '\n']) {
            return Err("JVM 参数过长或包含非法字符".into());
        }
        shell_words::split(&args).map_err(|_| "JVM 参数引号不匹配")?;
        changes.push((
            "jvmArguments".into(),
            if args.trim().is_empty() {
                Value::Null
            } else {
                json!(args)
            },
        ));
    }
    for (field, value, minimum) in [
        ("screenWidth", screen_width, 320),
        ("screenHeight", screen_height, 240),
    ] {
        if let Some(value) = value {
            if !(minimum..=16384).contains(&value) {
                return Err("实例窗口尺寸超出范围".into());
            }
            changes.push((field.into(), json!(value)));
        }
    }
    if let Some(name) = name {
        validate_name(&name)?;
        changes.push(("name".into(), json!(name.trim())));
    }
    if let Some(category) = category {
        if category.chars().count() > 64 || category.chars().any(char::is_control) {
            return Err("分类须少于 64 个可见字符".into());
        }
        changes.push(("category".into(), json!(category.trim())));
    }
    if let Some(notes) = notes {
        if notes.chars().count() > 4000 {
            return Err("备注不能超过 4000 个字符".into());
        }
        changes.push(("notes".into(), json!(notes)));
    }
    if let Some(icon) = icon_path {
        let value = if icon.trim().is_empty() {
            Value::Null
        } else {
            let source = checked_absolute(Path::new(&icon))?;
            let extension = source
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !["png", "jpg", "jpeg", "webp", "ico"].contains(&extension.as_str())
                || !source.is_file()
                || fs::metadata(&source).map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024
            {
                return Err("图标须为不超过 2 MiB 的 PNG、JPEG、WebP 或 ICO 文件".into());
            }
            let root = checked_absolute(&state.data_dir.join("instance-icons"))?;
            fs::create_dir_all(&root).map_err(|e| e.to_string())?;
            let target = safe_join(&root, &format!("{}.{}", uuid::Uuid::new_v4(), extension))?;
            fs::copy(source, &target).map_err(|e| format!("保存实例图标失败：{e}"))?;
            json!(target.to_string_lossy())
        };
        changes.push(("iconPath".into(), value));
    }
    state.update(|data| {
        let value = data
            .instances
            .iter_mut()
            .find(|i| i.id == instance_id)
            .ok_or("实例不存在")?;
        replace_metadata(value, &changes)?;
        Ok(value.clone())
    })
}

#[tauri::command]
pub async fn clone_instance(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    name: String,
) -> Result<Instance, String> {
    validate_name(&name)?;
    let _operation = state.operation.lock().await;
    let task = state.control.begin("clone", &instance_id, &name);
    let arc = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || clone_inner(&arc, &instance_id, &name))
        .await
        .unwrap_or_else(|e| Err(format!("克隆任务异常：{e}")));
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

fn clone_inner(state: &LauncherState, instance_id: &str, name: &str) -> Result<Instance, String> {
    state.games.require_instance_stopped(instance_id)?;
    let old = instance(&state.snapshot()?, &instance_id)?;
    let source = checked_absolute(Path::new(&old.game_directory))?;
    let root = instance_root(&state)?;
    let token = uuid::Uuid::new_v4().to_string();
    let staging = safe_join(&root, &format!(".clone-{token}"))?;
    let destination = safe_join(&root, &token)?;
    if root.starts_with(&source) {
        return Err(
            "共享游戏根目录不能直接作为独立实例克隆，请先导出个人备份。独立实例可正常克隆。".into(),
        );
    }
    let files = collect_files_controlled(&source, Some(state))?;
    copy_snapshot_controlled(&source, &staging, &files, Some(state))?;
    sync_checkpoint(state)?;
    if destination.exists() {
        return Err("克隆目标已存在，原实例和暂存副本均已保留".into());
    }
    fs::rename(&staging, &destination).map_err(|e| format!("提交克隆失败，暂存副本已保留：{e}"))?;
    let mut value = old;
    replace_metadata(
        &mut value,
        &[
            ("id".into(), json!(token)),
            ("name".into(), json!(name.trim())),
            ("gameDirectory".into(), json!(destination.to_string_lossy())),
            ("createdAt".into(), json!(chrono::Utc::now().to_rfc3339())),
            ("lastPlayed".into(), Value::Null),
            ("totalPlayTime".into(), json!(0)),
        ],
    )?;
    register(&state, value)
}

pub(crate) fn write_archive(
    source: &Path,
    output: &Path,
    files: &[FileRecord],
    manifest_name: &str,
    manifest: &[u8],
) -> Result<(), String> {
    write_archive_controlled(source, output, files, manifest_name, manifest, None)
}

fn write_archive_controlled(
    source: &Path,
    output: &Path,
    files: &[FileRecord],
    manifest_name: &str,
    manifest: &[u8],
    control: Option<&LauncherState>,
) -> Result<(), String> {
    let output = checked_absolute(output)?;
    if output.exists() {
        return Err("导出文件已经存在，请另选文件名，现有文件未覆盖".into());
    }
    let parent = output.parent().ok_or("导出目录无效")?;
    checked_absolute(parent)?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = safe_join(
        parent,
        &format!(".launcher-export-{}.part", uuid::Uuid::new_v4()),
    )?;
    let result = (|| {
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        zip.start_file(manifest_name, options)
            .map_err(|e| e.to_string())?;
        zip.write_all(manifest).map_err(|e| e.to_string())?;
        for record in files {
            if let Some(state) = control {
                sync_checkpoint(state)?;
            }
            if record.relative == manifest_name {
                return Err("实例包含与备份清单冲突的文件名，无法导出".into());
            }
            let path = safe_join(source, &record.relative)?;
            zip.start_file(&record.relative, options)
                .map_err(|e| e.to_string())?;
            let mut source_file = fs::File::open(path).map_err(|e| e.to_string())?;
            std::io::copy(&mut source_file, &mut zip).map_err(|e| e.to_string())?;
        }
        zip.finish()
            .map_err(|e| e.to_string())?
            .sync_all()
            .map_err(|e| e.to_string())?;
        if collect_files_controlled(source, control)? != files {
            return Err("备份期间实例文件发生变化，请关闭游戏后重试".into());
        }
        if output.exists() {
            return Err("导出期间出现同名文件，已保留该文件".into());
        }
        fs::rename(&temp, &output).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn read_backup(path: &Path) -> Result<BackupManifest, String> {
    checked_absolute(path)?;
    let mut zip = ZipArchive::new(fs::File::open(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut entry = zip
        .by_name("launcher-backup.json")
        .map_err(|_| "不是本启动器创建的实例备份")?;
    if entry.size() > 16 * 1024 * 1024 {
        return Err("备份清单过大".into());
    }
    let mut bytes = Vec::new();
    (&mut entry)
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("备份清单解压后过大".into());
    }
    let manifest: BackupManifest = serde_json::from_slice(&bytes).map_err(|_| "备份清单无效")?;
    if manifest.format_version != 1 {
        return Err("不支持此备份格式版本".into());
    }
    Ok(manifest)
}

pub(crate) fn backup_inner(
    state: &LauncherState,
    value: &Instance,
) -> Result<InstanceBackup, String> {
    state.games.require_instance_stopped(&value.id)?;
    let source = checked_absolute(Path::new(&value.game_directory))?;
    let files = collect_files_controlled(&source, Some(state))?;
    validate_id(&value.id)?;
    let root = checked_absolute(&state.data_dir.join("instance-backups"))?;
    let folder = safe_join(&root, &value.id)?;
    if folder.starts_with(&source) {
        return Err("备份目录不能位于被备份的实例内部".into());
    }
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let path = safe_join(&folder, &format!("{id}.zip"))?;
    let created = chrono::Utc::now().to_rfc3339();
    let metadata = BackupManifest {
        format_version: 1,
        instance: value.clone(),
        created_at: created.clone(),
        files: files.clone(),
        dependencies: crate::modpacks::instance_dependencies(state, value).unwrap_or_default(),
    };
    write_archive_controlled(
        &source,
        &path,
        &files,
        "launcher-backup.json",
        &serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?,
        Some(state),
    )?;
    Ok(InstanceBackup {
        id,
        instance_id: value.id.clone(),
        version_id: value.version_id.clone(),
        created_at: created,
        size: fs::metadata(&path).map_err(|e| e.to_string())?.len(),
        path: path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub async fn backup_instance(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
) -> Result<InstanceBackup, String> {
    let _operation = state.operation.lock().await;
    let value = instance(&state.snapshot()?, &instance_id)?;
    let task = state.control.begin("backup", &instance_id, &value.name);
    let arc = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || backup_inner(&arc, &value))
        .await
        .unwrap_or_else(|e| Err(format!("备份任务异常：{e}")));
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

#[tauri::command]
pub fn list_instance_backups(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
) -> Result<Vec<InstanceBackup>, String> {
    instance(&state.snapshot()?, &instance_id)?;
    validate_id(&instance_id)?;
    let root = checked_absolute(&state.data_dir.join("instance-backups"))?;
    let folder = safe_join(&root, &instance_id)?;
    if !folder.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for item in fs::read_dir(&folder).map_err(|e| e.to_string())? {
        let path = item.map_err(|e| e.to_string())?.path();
        checked_absolute(&path)?;
        if path.extension().and_then(|s| s.to_str()) != Some("zip") || !path.is_file() {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let metadata = read_backup(&path)?;
        if metadata.instance.id != instance_id {
            return Err("备份归属校验失败".into());
        }
        result.push(InstanceBackup {
            id: id.into(),
            instance_id: instance_id.clone(),
            version_id: metadata.instance.version_id,
            created_at: metadata.created_at,
            size: fs::metadata(&path).map_err(|e| e.to_string())?.len(),
            path: path.to_string_lossy().into_owned(),
        });
    }
    result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub instance: Instance,
    pub previous_backup: Option<InstanceBackup>,
    pub previous_directory: Option<String>,
}

#[tauri::command]
pub async fn restore_instance_backup(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    backup_id: String,
) -> Result<RestoreResult, String> {
    let _operation = state.operation.lock().await;
    let task = state.control.begin("restore", &instance_id, "恢复实例备份");
    let arc = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || restore_inner(&arc, &instance_id, &backup_id))
        .await
        .unwrap_or_else(|e| Err(format!("恢复任务异常：{e}")));
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

fn restore_inner(
    state: &LauncherState,
    instance_id: &str,
    backup_id: &str,
) -> Result<RestoreResult, String> {
    state.games.require_instance_stopped(instance_id)?;
    let current = instance(&state.snapshot()?, &instance_id)?;
    uuid::Uuid::parse_str(&backup_id).map_err(|_| "备份标识无效")?;
    validate_id(&instance_id)?;
    let archive = safe_join(
        &state.data_dir.join("instance-backups"),
        &format!("{instance_id}/{backup_id}.zip"),
    )?;
    let metadata = read_backup(&archive)?;
    if metadata.instance.id != instance_id {
        return Err("所选备份不属于此实例".into());
    }
    let directory = checked_absolute(Path::new(&current.game_directory))?;
    let configured = PathBuf::from(state.snapshot()?.config.game_directory);
    if directory == configured
        || state.data_dir.starts_with(&directory)
        || Path::new(env!("CARGO_MANIFEST_DIR")).starts_with(&directory)
    {
        return Err("共享游戏根目录或启动器目录不能原地恢复。请将备份导入为新的独立实例。".into());
    }
    let parent = directory.parent().ok_or("实例目录无效")?;
    let token = uuid::Uuid::new_v4().to_string();
    let staging = safe_join(parent, &format!(".restore-{token}"))?;
    let previous = safe_join(parent, &format!(".before-restore-{token}"))?;
    if staging.exists() || previous.exists() {
        return Err("恢复暂存目录已存在".into());
    }
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    crate::modpacks::extract_zip_controlled(
        &archive,
        &staging,
        "",
        &["launcher-backup.json"],
        Some(state),
    )?;
    if collect_files_controlled(&staging, Some(state))? != metadata.files {
        return Err("备份内容与 SHA-256 清单不一致，当前实例未改变".into());
    }
    let previous_backup = if directory.exists() {
        Some(backup_inner(&state, &current)?)
    } else {
        None
    };
    sync_checkpoint(state)?;
    validate_id(&metadata.instance.version_id)?;
    if directory.exists() {
        fs::rename(&directory, &previous)
            .map_err(|e| format!("无法保留恢复前目录，请关闭游戏后重试：{e}"))?;
    }
    if let Err(error) = fs::rename(&staging, &directory) {
        if previous.exists() {
            let _ = fs::rename(&previous, &directory);
        }
        return Err(format!("提交恢复失败，原目录和暂存副本已保留：{error}"));
    }
    let mut restored = metadata.instance;
    replace_metadata(
        &mut restored,
        &[("gameDirectory".into(), json!(directory.to_string_lossy()))],
    )?;
    if let Err(error) = state.update(|data| {
        let value = data
            .instances
            .iter_mut()
            .find(|v| v.id == instance_id)
            .ok_or("实例已被移除")?;
        *value = restored.clone();
        Ok(())
    }) {
        let failed = safe_join(parent, &format!(".restored-unregistered-{token}"))?;
        let _ = fs::rename(&directory, &failed);
        if previous.exists() {
            let _ = fs::rename(&previous, &directory);
        }
        return Err(format!(
            "恢复登记失败，原目录已尝试回滚，副本均保留：{error}"
        ));
    }
    Ok(RestoreResult {
        instance: restored,
        previous_backup,
        previous_directory: previous
            .exists()
            .then(|| previous.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn export_instance_zip(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    output_path: String,
) -> Result<String, String> {
    let _operation = state.operation.lock().await;
    let task = state
        .control
        .begin("backup", &instance_id, "导出个人实例备份");
    let arc = state.inner().clone();
    let result =
        tokio::task::spawn_blocking(move || export_zip_inner(&arc, &instance_id, &output_path))
            .await
            .unwrap_or_else(|e| Err(format!("导出任务异常：{e}")));
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

fn export_zip_inner(
    state: &LauncherState,
    instance_id: &str,
    output_path: &str,
) -> Result<String, String> {
    state.games.require_instance_stopped(instance_id)?;
    let value = instance(&state.snapshot()?, &instance_id)?;
    let output = checked_absolute(Path::new(&output_path))?;
    if output
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| !s.eq_ignore_ascii_case("zip"))
    {
        return Err("个人备份导出路径必须以 .zip 结尾".into());
    }
    let source = checked_absolute(Path::new(&value.game_directory))?;
    if output.starts_with(&source) {
        return Err("备份文件不能写入正在备份的实例目录".into());
    }
    let files = collect_files_controlled(&source, Some(state))?;
    let dependencies = crate::modpacks::instance_dependencies(state, &value).unwrap_or_default();
    let manifest = BackupManifest {
        format_version: 1,
        instance: value,
        created_at: chrono::Utc::now().to_rfc3339(),
        files: files.clone(),
        dependencies,
    };
    write_archive_controlled(
        &source,
        &output,
        &files,
        "launcher-backup.json",
        &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
        Some(state),
    )?;
    Ok(output.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_is_verified_and_existing_destination_is_preserved() {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/instance-tests");
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        let source = root.join("original");
        let copy = root.join("clone");
        fs::create_dir_all(source.join("saves/world")).unwrap();
        fs::write(source.join("saves/world/level.dat"), b"user world").unwrap();
        let records = collect_files(&source).unwrap();
        copy_snapshot(&source, &copy, &records).unwrap();
        assert_eq!(collect_files(&copy).unwrap(), records);
        assert!(copy_snapshot(&source, &copy, &records).is_err());
        assert_eq!(
            fs::read(copy.join("saves/world/level.dat")).unwrap(),
            b"user world"
        );
        assert!(
            root.is_absolute()
                && root.starts_with(&parent)
                && root.file_name().unwrap().to_string_lossy().len() == 36
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_output_never_overwrites_existing_user_file() {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/instance-tests");
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let output = root.join("my-backup.zip");
        fs::write(&output, b"original backup").unwrap();
        assert!(write_archive(&root, &output, &[], "launcher-backup.json", b"{}").is_err());
        assert_eq!(fs::read(&output).unwrap(), b"original backup");
        assert!(
            root.is_absolute()
                && root.starts_with(&parent)
                && root.file_name().unwrap().to_string_lossy().len() == 36
        );
        fs::remove_dir_all(root).unwrap();
    }
}
