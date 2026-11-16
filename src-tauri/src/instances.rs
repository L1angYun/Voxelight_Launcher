//! Reversible instance metadata changes, cloning, personal backups and restoration.
use crate::{
    errors::{AppError, AppResult},
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
use uuid::Uuid;
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

// Planned insertion in instances.rs, after checked_absolute.
// Use only with verified absolute siblings, within an operation lock.
#[cfg(windows)]
pub(crate) fn rename_owned_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Component, Prefix};
    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileW(source: *const u16, target: *const u16) -> i32;
    }
    // Windows extended-length paths preserve the existing long-path behavior.
    fn wide(path: &Path) -> std::io::Result<Vec<u16>> {
        let path_wire = path.as_os_str().encode_wide();
        let mut path = match path.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::Verbatim(_) | Prefix::VerbatimUNC(..) | Prefix::VerbatimDisk(_) => {
                    path_wire.collect::<Vec<_>>()
                }
                Prefix::UNC(..) => r"\\?\UNC\"
                    .encode_utf16()
                    .chain(path_wire.skip(2))
                    .collect(),
                Prefix::Disk(_) => r"\\?\".encode_utf16().chain(path_wire).collect(),
                _ => return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput)),
            },
            _ => return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput)),
        };
        if path.contains(&0) {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
        }
        path.push(0);
        Ok(path)
    }
    // Canonicalizing the already verified parent also converts slash spelling
    // consistently and handles UNC before accessing its leaf.
    fn native(path: &Path) -> std::io::Result<Vec<u16>> {
        let invalid = std::io::ErrorKind::InvalidInput;
        let parent = path.parent().ok_or(invalid)?;
        let name = path.file_name().ok_or(invalid)?;
        wide(&parent.canonicalize()?.join(name))
    }
    let (source, target) = (native(source)?, native(target)?);
    // Both arguments are live, terminated UTF-16 strings; MoveFileW neither
    // changes them nor replaces an occupied directory.
    if unsafe { MoveFileW(source.as_ptr(), target.as_ptr()) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn rename_owned_directory(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::{
        ffi::{c_char, c_int, c_uint, CString},
        os::unix::ffi::OsStrExt,
    };
    #[cfg(target_os = "linux")]
    unsafe extern "C" {
        fn renameat2(
            from_fd: c_int,
            from: *const c_char,
            to_fd: c_int,
            to: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }
    #[cfg(target_os = "macos")]
    unsafe extern "C" {
        fn renamex_np(from: *const c_char, to: *const c_char, flags: c_uint) -> c_int;
    }
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let target = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| std::io::ErrorKind::InvalidInput)?;
    // Absolute, checked strings; the platform primitive refuses an already
    // occupied target. No replace-based fallback on unsupported filesystems.
    #[cfg(target_os = "linux")]
    let result = unsafe { renameat2(-100, source.as_ptr(), -100, target.as_ptr(), 1) };
    #[cfg(target_os = "macos")]
    let result = unsafe { renamex_np(source.as_ptr(), target.as_ptr(), 4) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(crate) fn rename_owned_directory(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

// Own only a directory we created exclusively. Recursive removal on Drop skips
// a replaced root link and never guesses ownership of old leftover directories.
pub(crate) struct StagingDirectory(PathBuf, bool);

impl StagingDirectory {
    pub(crate) fn create(path: PathBuf) -> Result<Self, String> {
        checked_absolute(&path)?;
        let parent = path.parent().ok_or("暂存目录无效")?;
        fs::create_dir_all(parent).map_err(|e| format!("无法创建暂存父目录：{e}"))?;
        fs::create_dir(&path).map_err(|e| format!("无法创建独立暂存目录：{e}"))?;
        Ok(Self(path, true))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn preserve(&mut self) {
        self.1 = false;
    }

    /// Publishing does not imply that this guard still owns the old name. If
    /// the final move fails, preserve the finished recovery copy at that name.
    pub(crate) fn publish(&mut self, target: &Path) -> std::io::Result<()> {
        self.preserve();
        rename_owned_directory(self.path(), target)
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        if self.1 && checked_absolute(&self.0).is_ok() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
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
    copy_into_snapshot(source, destination, files, control)
}

fn copy_into_snapshot(
    source: &Path,
    destination: &Path,
    files: &[FileRecord],
    control: Option<&LauncherState>,
) -> Result<(), String> {
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
    let mut staging = StagingDirectory::create(staging)?;
    copy_into_snapshot(&source, staging.path(), &files, Some(state))?;
    sync_checkpoint(state)?;
    if let Err(error) = staging.publish(&destination) {
        return Err(format!(
            "提交克隆失败，完整暂存副本保留在 {}：{error}",
            staging.path().display()
        ));
    }
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
    register(&state, value).map_err(|error| {
        format!(
            "克隆文件已完整保留在 {}，登记失败：{error}",
            destination.display()
        )
    })
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

fn backup_file_options(size: u64) -> SimpleFileOptions {
    let large = size >= 4_000_000_000;
    SimpleFileOptions::default()
        .compression_method(if large {
            CompressionMethod::Stored
        } else {
            CompressionMethod::Deflated
        })
        .large_file(large)
        .unix_permissions(0o644)
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
        zip.start_file(manifest_name, backup_file_options(manifest.len() as u64))
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
            zip.start_file(&record.relative, backup_file_options(record.size))
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

// Planned replacement for instance backup listing / restoration in instances.rs.
// Application calls remain local to this module and only explicit restore /
// recover commands acquire the write lock; listing does not perform recovery.
#[derive(Clone, Copy, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum BackupWarningReason {
    Invalid,
    WrongInstance,
    Unreadable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupWarning {
    file_name: String,
    reason: BackupWarningReason,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupHistory {
    backups: Vec<InstanceBackup>,
    warnings: Vec<BackupWarning>,
    recovery: Option<RecoveryPaths>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryPaths {
    current_directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    restored_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_backup_id: Option<String>,
}

impl RecoveryPaths {
    fn current(current: &Path) -> Self {
        Self {
            current_directory: current.to_string_lossy().into_owned(),
            previous_directory: None,
            restored_directory: None,
            previous_backup_id: None,
        }
    }

    fn error(self, code: &str, detail: impl Into<String>) -> AppError {
        let mut error = AppError::new(code)
            .with_param("currentDirectory", self.current_directory)
            .with_detail(detail);
        if let Some(path) = self.previous_directory {
            error = error.with_param("previousDirectory", path);
        }
        if let Some(path) = self.restored_directory {
            error = error.with_param("restoredDirectory", path);
        }
        if let Some(id) = self.previous_backup_id {
            error = error.with_param("previousBackupId", id);
        }
        error
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreIntent {
    token: Uuid,
    before: Instance,
    after: Instance,
    original: Option<RestoreIdentity>,
    selected: RestoreIdentity,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreIdentity {
    id: Uuid,
    manifest_sha256: String,
}

const RESTORE_INTENT: &str = "restore-in-progress.json";
const MAX_RESTORE_INTENT_BYTES: u64 = 2 * 1024 * 1024;

struct RestorePaths {
    live: PathBuf,
    stage: PathBuf,
    previous: PathBuf,
}

impl RestorePaths {
    fn new(live: &Path, token: Uuid) -> Result<Self, String> {
        checked_absolute(live)?;
        let parent = live.parent().ok_or("实例目录无效")?;
        Ok(Self {
            live: live.to_owned(),
            stage: safe_join(parent, &format!(".restore-{token}"))?,
            previous: safe_join(parent, &format!(".before-restore-{token}"))?,
        })
    }

    fn locations(&self, intent: &RestoreIntent) -> RecoveryPaths {
        let mut locations = RecoveryPaths::current(&self.live);
        locations.restored_directory = self
            .stage
            .is_dir()
            .then(|| self.stage.to_string_lossy().into_owned());
        locations.previous_directory = self
            .previous
            .is_dir()
            .then(|| self.previous.to_string_lossy().into_owned());
        locations.previous_backup_id = intent.original.as_ref().map(|backup| backup.id.to_string());
        locations
    }
}

fn directory_present(path: &Path) -> Result<bool, String> {
    checked_absolute(path)?;
    match fs::symlink_metadata(path) {
        Ok(stat) if stat.is_dir() => Ok(true),
        Ok(_) => Err("恢复路径不是普通目录".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法检查恢复路径：{error}")),
    }
}

fn backup_folder(state: &LauncherState, instance_id: &str) -> Result<PathBuf, String> {
    validate_id(instance_id)?;
    let root = checked_absolute(&state.data_dir.join("instance-backups"))?;
    safe_join(&root, instance_id)
}

fn backup_history(folder: &Path, instance_id: &str) -> Result<BackupHistory, String> {
    let mut history = BackupHistory {
        backups: Vec::new(),
        warnings: Vec::new(),
        recovery: None,
    };
    if !directory_present(folder)? {
        return Ok(history);
    }
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.extension().and_then(|s| s.to_str()) != Some("zip") || Uuid::parse_str(id).is_err()
        {
            continue;
        }
        let (archive, length) = match checked_absolute(&path)
            .and_then(|_| fs::metadata(&path).map_err(|e| e.to_string()))
        {
            Ok(stat) if stat.is_file() => match read_backup(&path) {
                Ok(archive) => (archive, stat.len()),
                Err(_) => {
                    history.warnings.push(BackupWarning {
                        file_name: entry.file_name().to_string_lossy().into_owned(),
                        reason: BackupWarningReason::Invalid,
                    });
                    continue;
                }
            },
            _ => {
                history.warnings.push(BackupWarning {
                    file_name: entry.file_name().to_string_lossy().into_owned(),
                    reason: BackupWarningReason::Unreadable,
                });
                continue;
            }
        };
        if archive.instance.id != instance_id {
            history.warnings.push(BackupWarning {
                file_name: entry.file_name().to_string_lossy().into_owned(),
                reason: BackupWarningReason::WrongInstance,
            });
            continue;
        }
        history
            .backups
            .push(backup_entry(&path, id, length, &archive));
    }
    history.backups.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    history
        .warnings
        .sort_by(|a, b| a.file_name.cmp(&b.file_name));
    Ok(history)
}

fn backup_entry(path: &Path, id: &str, length: u64, archive: &BackupManifest) -> InstanceBackup {
    InstanceBackup {
        id: id.into(),
        instance_id: archive.instance.id.clone(),
        version_id: archive.instance.version_id.clone(),
        created_at: archive.created_at.clone(),
        path: path.to_string_lossy().into_owned(),
        size: length,
    }
}

#[tauri::command]
pub fn list_instance_backups(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
) -> AppResult<BackupHistory> {
    let current = instance(&state.snapshot()?, &instance_id)?;
    let folder = backup_folder(&state, &instance_id)?;
    let mut history = backup_history(&folder, &instance_id)?;
    let live = Path::new(&current.game_directory);
    history.recovery = match read_intent(&folder) {
        Ok(Some(intent)) => Some(intent_paths(&intent, &current).map_or_else(
            |_| RecoveryPaths::current(live),
            |paths| paths.locations(&intent),
        )),
        Err(_) => Some(RecoveryPaths::current(live)),
        Ok(None) => None,
    };
    Ok(history)
}

fn intent_paths(intent: &RestoreIntent, current: &Instance) -> Result<RestorePaths, String> {
    if intent.before.game_directory != current.game_directory
        || intent.after.game_directory != current.game_directory
        || intent.before.id != current.id
        || intent.after.id != current.id
        || intent
            .original
            .as_ref()
            .is_some_and(|before| before.id == intent.selected.id)
    {
        return Err("恢复记录与当前实例不一致".into());
    }
    RestorePaths::new(Path::new(&current.game_directory), intent.token)
}

fn read_intent(folder: &Path) -> Result<Option<RestoreIntent>, String> {
    let path = safe_join(folder, RESTORE_INTENT)?;
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取恢复记录：{error}")),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("恢复记录路径无效".into());
    }
    let mut bytes = vec![];
    (&mut file)
        .take(MAX_RESTORE_INTENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_RESTORE_INTENT_BYTES {
        return Err("恢复记录过大".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|e| format!("恢复记录无效：{e}"))
}

fn write_intent(folder: &Path, intent: &RestoreIntent) -> Result<(), String> {
    let output = safe_join(folder, RESTORE_INTENT)?;
    let temporary = safe_join(folder, &format!(".restore-intent-{}.part", Uuid::new_v4()))?;
    let bytes = serde_json::to_vec_pretty(intent).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    let written = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    // Same-volume rename which fails on existing target, also when another
    // process was active before the future profile lock. The helper supports
    // regular files in the same parent as well as directory moves.
    let result = written.and_then(|()| rename_owned_directory(&temporary, &output));
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result.map_err(|e| format!("无法保存恢复记录：{e}"))
}

fn selected_archive(folder: &Path, id: Uuid) -> Result<(PathBuf, BackupManifest), String> {
    let path = safe_join(folder, &format!("{id}.zip"))?;
    let archive = read_backup(&path)?;
    Ok((path, archive))
}

fn identify_archive(id: Uuid, archive: &BackupManifest) -> Result<RestoreIdentity, String> {
    let bytes = serde_json::to_vec(archive).map_err(|e| e.to_string())?;
    Ok(RestoreIdentity {
        id,
        manifest_sha256: format!("{:x}", Sha256::digest(bytes)),
    })
}

fn verify_archive(
    folder: &Path,
    saved: &RestoreIdentity,
    expected_id: &str,
) -> Result<(PathBuf, BackupManifest), String> {
    let (path, archive) = selected_archive(folder, saved.id)?;
    if archive.instance.id != expected_id
        || saved.manifest_sha256 != identify_archive(saved.id, &archive)?.manifest_sha256
    {
        return Err("恢复记录对应的备份已改变".into());
    }
    Ok((path, archive))
}

fn same_instance(a: &Instance, b: &Instance) -> Result<bool, String> {
    Ok(serde_json::to_value(a).map_err(|e| e.to_string())?
        == serde_json::to_value(b).map_err(|e| e.to_string())?)
}

fn replace_registered_instance(
    state: &LauncherState,
    expected: &Instance,
    replacement: &Instance,
) -> Result<(), String> {
    state.update(|data| {
        let value = data
            .instances
            .iter_mut()
            .find(|entry| entry.id == expected.id)
            .ok_or("实例已被移除")?;
        if !same_instance(value, expected)? {
            return Err("当前实例信息已改变".into());
        }
        *value = replacement.clone();
        Ok(())
    })
}

fn restore_target(state: &LauncherState, current: &Instance) -> AppResult<PathBuf> {
    crate::resources::require_resource_stopped(state, &current.version_id, Some(&current.id))?;
    let directory = checked_absolute(Path::new(&current.game_directory))?;
    let configured = PathBuf::from(state.snapshot()?.config.game_directory);
    let normalized = directory
        .canonicalize()
        .unwrap_or_else(|_| directory.clone());
    // Named archive metadata may reference another folder. The only target is
    // the currently registered independent instance, not a shared game root.
    if directory == configured
        || normalized == configured.canonicalize().unwrap_or(configured)
        || state.data_dir.starts_with(&directory)
        || Path::new(env!("CARGO_MANIFEST_DIR")).starts_with(&directory)
    {
        return Err("共享游戏根目录或启动器目录不能原地恢复。请将备份导入为新的独立实例。".into());
    }
    Ok(directory)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub instance: Instance,
    pub previous_backup: Option<InstanceBackup>,
    pub previous_directory: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverRestoreResult {
    pub instance: Instance,
    pub previous_backup: Option<InstanceBackup>,
    pub preserved_directory: Option<String>,
}

#[tauri::command]
pub async fn restore_instance_backup(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    backup_id: String,
) -> AppResult<RestoreResult> {
    let _operation = state.operation.lock().await;
    let task = state.control.begin("restore", &instance_id, "恢复实例备份");
    let arc = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || restore_inner(&arc, &instance_id, &backup_id))
        .await
        .unwrap_or_else(|e| Err(AppError::internal(format!("恢复任务异常：{e}"))));
    state
        .control
        .finish(&task, result.as_ref().err().map(backup_task_error));
    result
}

fn backup_task_error(error: &AppError) -> &str {
    error.detail.as_deref().unwrap_or(&error.code)
}

#[tauri::command]
pub async fn recover_instance_restore(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
) -> AppResult<RecoverRestoreResult> {
    let _operation = state.operation.lock().await;
    let task = state
        .control
        .begin("restore", &instance_id, "恢复中断的实例备份");
    let arc = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || {
        let current = instance(&arc.snapshot()?, &instance_id)?;
        let directory = restore_target(&arc, &current)?;
        let folder = backup_folder(&arc, &instance_id)?;
        let intent = read_intent(&folder)
            .map_err(|err| {
                RecoveryPaths::current(&directory).error("backup.restoreRecoveryRequired", err)
            })?
            .ok_or_else(|| AppError::new("backup.restoreRecoveryMissing"))?;
        let paths = intent_paths(&intent, &current).map_err(|err| {
            RecoveryPaths::current(&directory).error("backup.restoreRecoveryRequired", err)
        })?;
        recover_with_state(&arc, &folder, &intent, &paths, &current).map_err(|err| {
            paths
                .locations(&intent)
                .error("backup.restoreRecoveryRequired", err)
        })
    })
    .await
    .unwrap_or_else(|e| Err(AppError::internal(format!("恢复任务异常：{e}"))));
    state
        .control
        .finish(&task, result.as_ref().err().map(backup_task_error));
    result
}

fn recover_with_state(
    state: &LauncherState,
    folder: &Path,
    intent: &RestoreIntent,
    paths: &RestorePaths,
    current: &Instance,
) -> Result<RecoverRestoreResult, String> {
    let already_before = same_instance(current, &intent.before)?;
    if !already_before && !same_instance(current, &intent.after)? {
        return Err("实例已改变，已保留恢复副本".into());
    }

    // A pending recovery should validate against the pinned archive inventory
    // without selecting another user's game or accepting an unrelated snapshot.
    let original = intent
        .original
        .as_ref()
        .map(|backup| verify_archive(folder, backup, &current.id))
        .transpose()?;
    let (_, selected) = verify_archive(folder, &intent.selected, &current.id)?;
    recover_layout(
        paths,
        original.as_ref().map(|(_, backup)| backup.files.as_slice()),
        &selected.files,
    )?;
    if !already_before {
        replace_registered_instance(state, current, &intent.before)?;
    }
    let previous_backup = original
        .map(|(path, archive)| {
            fs::metadata(&path).map(|stat| {
                backup_entry(
                    &path,
                    &intent.original.as_ref().unwrap().id.to_string(),
                    stat.len(),
                    &archive,
                )
            })
        })
        .transpose()
        .map_err(|e| e.to_string())?;
    clear_intent(folder)?;
    Ok(RecoverRestoreResult {
        instance: intent.before.clone(),
        previous_backup,
        preserved_directory: paths
            .stage
            .is_dir()
            .then(|| paths.stage.to_string_lossy().into_owned()),
    })
}

fn clear_intent(folder: &Path) -> Result<(), String> {
    fs::remove_file(safe_join(folder, RESTORE_INTENT)?)
        .map_err(|e| format!("无法清除恢复记录：{e}"))
}

/// Recover only known layouts and never replace an unrelated or modified live
/// directory. Compare both stage presence and file inventories; old and new
/// may be byte-identical and an empty folder is not equivalent to no folder.
fn recover_layout(
    paths: &RestorePaths,
    original: Option<&[FileRecord]>,
    selected: &[FileRecord],
) -> Result<(), String> {
    let (has_live, has_previous, has_stage) = (
        directory_present(&paths.live)?,
        directory_present(&paths.previous)?,
        directory_present(&paths.stage)?,
    );
    if has_stage && collect_files(&paths.stage)? != selected {
        return Err("暂存恢复目录已改变，已保留所有文件".into());
    }
    if has_previous {
        let original = original.ok_or("恢复前没有活动目录，发现非预期副本")?;
        if collect_files(&paths.previous)? != original {
            return Err("恢复前目录校验失败，已保留所有文件".into());
        }
        if has_live {
            if has_stage || collect_files(&paths.live)? != selected {
                return Err("活动目录不符合本次恢复记录，未覆盖".into());
            }
            rename_owned_directory(&paths.live, &paths.stage)
                .map_err(|e| format!("无法保留已发布的备份副本：{e}"))?;
        }
        // If interrupted after parking the selected live, a later recover sees
        // active missing with a verified previous and can resume just this move.
        return rename_owned_directory(&paths.previous, &paths.live)
            .map_err(|e| format!("无法复位恢复前目录：{e}"));
    }
    if let Some(original) = original {
        if !has_live || collect_files(&paths.live)? != original {
            return Err("恢复前目录不存在或与备份不符，未覆盖活动目录".into());
        }
    } else if has_live {
        if has_stage || collect_files(&paths.live)? != selected {
            return Err("活动目录不符合本次恢复记录，未覆盖".into());
        }
        rename_owned_directory(&paths.live, &paths.stage)
            .map_err(|e| format!("无法保留已发布的备份副本：{e}"))?;
    }
    Ok(())
}

fn restore_inner(
    state: &LauncherState,
    instance_id: &str,
    backup_id: &str,
) -> AppResult<RestoreResult> {
    let current = instance(&state.snapshot()?, instance_id)?;
    let directory = restore_target(state, &current)?;
    let folder = backup_folder(state, instance_id)?;
    match read_intent(&folder) {
        Ok(None) => (),
        Ok(Some(pending)) => {
            let locations = intent_paths(&pending, &current).map_or_else(
                |_| RecoveryPaths::current(&directory),
                |paths| paths.locations(&pending),
            );
            return Err(locations.error(
                "backup.restoreRecoveryRequired",
                "此实例有未完成的恢复，请先显式恢复",
            ));
        }
        Err(error) => {
            return Err(
                RecoveryPaths::current(&directory).error("backup.restoreRecoveryRequired", error)
            )
        }
    }

    let selected_id = Uuid::parse_str(backup_id).map_err(|_| AppError::new("backup.notFound"))?;
    if selected_id.to_string() != backup_id {
        return Err(AppError::new("backup.notFound"));
    }
    let (archive, metadata) = selected_archive(&folder, selected_id)
        .map_err(|e| AppError::new("backup.invalid").with_detail(e))?;
    if metadata.instance.id != instance_id {
        return Err(AppError::new("backup.notFound"));
    }
    let mut restored = metadata.instance.clone();
    validate_id(&restored.version_id)?;
    restored.game_directory = current.game_directory.clone();
    let token = Uuid::new_v4();
    let paths = RestorePaths::new(&directory, token)?;
    let mut staging = StagingDirectory::create(paths.stage.clone())?;
    if directory_present(&paths.previous)? {
        return Err("恢复副本目录已存在".into());
    }
    crate::modpacks::extract_zip_controlled(
        &archive,
        staging.path(),
        "",
        &["launcher-backup.json"],
        Some(state),
    )?;
    if collect_files_controlled(staging.path(), Some(state))? != metadata.files {
        return Err(AppError::new("backup.invalid"));
    }

    let (previous_backup, original) = if directory_present(&paths.live)? {
        let backup = backup_inner(state, &current)?;
        let id = Uuid::parse_str(&backup.id).map_err(|_| "恢复前备份标识无效")?;
        let original = identify_archive(id, &read_backup(Path::new(&backup.path))?)?;
        (Some(backup), Some(original))
    } else {
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        (None, None)
    };
    sync_checkpoint(state)?;
    let intent = RestoreIntent {
        token,
        before: current.clone(),
        after: restored.clone(),
        original,
        selected: identify_archive(selected_id, &metadata)?,
    };
    write_intent(&folder, &intent)?;
    staging.preserve(); // durable material now belongs to the recovery intent

    let publish = (|| -> Result<(), String> {
        if intent.original.is_some() {
            rename_owned_directory(&paths.live, &paths.previous).map_err(|e| e.to_string())?;
        }
        rename_owned_directory(&paths.stage, &paths.live).map_err(|e| e.to_string())?;
        replace_registered_instance(state, &current, &restored)
    })();
    if let Err(error) = publish {
        let on_disk = state
            .snapshot()
            .and_then(|data| instance(&data, instance_id));
        match on_disk
            .and_then(|on_disk| recover_with_state(state, &folder, &intent, &paths, &on_disk))
        {
            Ok(_) => {
                return Err(paths
                    .locations(&intent)
                    .error("backup.restoreRolledBack", error))
            }
            Err(recovery) => {
                return Err(paths.locations(&intent).error(
                    "backup.restoreRecoveryRequired",
                    format!("{error}; {recovery}"),
                ))
            }
        }
    }
    if let Err(error) = clear_intent(&folder) {
        return Err(paths
            .locations(&intent)
            .error("backup.restoreRecoveryRequired", error));
    }
    Ok(RestoreResult {
        instance: restored,
        previous_backup,
        previous_directory: paths.locations(&intent).previous_directory,
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

#[cfg(test)]
mod backup_recovery_tests {
    use super::*;
    use std::io::Cursor;

    fn fixture_folder(prefix: &str) -> StagingDirectory {
        StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/instance-tests")
                .join(format!("{prefix}-{}", Uuid::new_v4())),
        )
        .unwrap()
    }

    fn backup_manifest(id: &str, path: &Path, records: Vec<FileRecord>) -> BackupManifest {
        BackupManifest {
            format_version: 1,
            instance: Instance {
                id: id.into(),
                game_directory: path.to_string_lossy().into_owned(),
                version_id: "1.20.1".into(),
                ..Instance::default()
            },
            created_at: "2026-11-16T12:01:00Z".into(),
            files: records,
            dependencies: BTreeMap::new(),
        }
    }

    fn write_backup_manifest(folder: &Path, id: Uuid, manifest: &BackupManifest) {
        let file = fs::File::create(folder.join(format!("{id}.zip"))).unwrap();
        let mut zip = ZipWriter::new(file);
        zip.start_file("launcher-backup.json", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(manifest).unwrap())
            .unwrap();
        zip.finish().unwrap();
    }

    fn fixture_state(root: &Path, instance: &Instance) -> LauncherState {
        let data_dir = root.join("launcher-data");
        fs::create_dir_all(&data_dir).unwrap();
        LauncherState::test_fixture(
            data_dir,
            Persisted {
                config: crate::models::Config {
                    game_directory: root.join("game").to_string_lossy().into_owned(),
                    ..Default::default()
                },
                instances: vec![instance.clone()],
                ..Default::default()
            },
            reqwest::Client::builder().no_proxy().build().unwrap(),
        )
    }

    #[test]
    fn malformed_and_misattributed_backups_keep_the_valid_history_accessible() {
        let folder = fixture_folder("history");
        let good = Uuid::new_v4();
        let other = Uuid::new_v4();
        let broken = Uuid::new_v4();
        write_backup_manifest(
            folder.path(),
            good,
            &backup_manifest("test", folder.path(), vec![]),
        );
        write_backup_manifest(
            folder.path(),
            other,
            &backup_manifest("other", folder.path(), vec![]),
        );
        let broken_path = folder.path().join(format!("{broken}.zip"));
        fs::write(&broken_path, b"owned malformed archive").unwrap();
        let history = backup_history(folder.path(), "test").unwrap();
        assert_eq!(
            history
                .backups
                .into_iter()
                .map(|row| row.id)
                .collect::<Vec<_>>(),
            [good.to_string()]
        );
        let warnings: BTreeMap<_, _> = history
            .warnings
            .into_iter()
            .map(|warning| (warning.file_name, warning.reason))
            .collect();
        assert_eq!(
            warnings.get(&format!("{broken}.zip")),
            Some(&BackupWarningReason::Invalid)
        );
        assert_eq!(
            warnings.get(&format!("{other}.zip")),
            Some(&BackupWarningReason::WrongInstance)
        );
        assert_eq!(fs::read(&broken_path).unwrap(), b"owned malformed archive");
    }

    #[test]
    fn staging_owns_only_its_exclusive_directory_and_can_preserve_verified_copies() {
        let root = fixture_folder("staging");
        let existing = root.path().join("existing");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("data"), b"independent").unwrap();
        assert!(StagingDirectory::create(existing.clone()).is_err());
        assert_eq!(fs::read(existing.join("data")).unwrap(), b"independent");
        let failed = root.path().join("failed");
        {
            let stage = StagingDirectory::create(failed.clone()).unwrap();
            fs::write(stage.path().join("data"), b"partial").unwrap();
        }
        assert!(!failed.exists());
        let recovery_copy = root.path().join("complete");
        {
            let mut stage = StagingDirectory::create(recovery_copy.clone()).unwrap();
            fs::write(stage.path().join("data"), b"complete").unwrap();
            stage.preserve();
        }
        assert_eq!(fs::read(recovery_copy.join("data")).unwrap(), b"complete");
        let published_from = root.path().join("old-stage-name");
        let published_to = root.path().join("published");
        {
            let mut stage = StagingDirectory::create(published_from.clone()).unwrap();
            fs::write(stage.path().join("data"), b"published").unwrap();
            stage.publish(&published_to).unwrap();
            fs::create_dir(&published_from).unwrap();
            fs::write(published_from.join("data"), b"new owner").unwrap();
        }
        assert_eq!(fs::read(published_from.join("data")).unwrap(), b"new owner");
        assert_eq!(fs::read(published_to.join("data")).unwrap(), b"published");
    }

    #[test]
    fn recovery_move_never_replaces_even_an_empty_occupied_target() {
        let root = fixture_folder("publish");
        let source = root.path().join("source");
        let target = root.path().join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(source.join("fixture"), b"source").unwrap();
        assert!(rename_owned_directory(&source, &target).is_err());
        assert!(target.is_dir() && fs::read_dir(&target).unwrap().next().is_none());
        assert!(source.join("fixture").is_file());
        fs::remove_dir(&target).unwrap();
        rename_owned_directory(&source, &target).unwrap();
        assert!(!source.exists() && target.join("fixture").is_file());
    }

    #[test]
    fn backed_up_large_entries_emit_zip64_local_headers_with_readable_stored_data() {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file("large", backup_file_options(4 * 1024 * 1024 * 1024))
            .unwrap();
        zip.write_all(b"finite stand-in for large payload").unwrap();
        zip.start_file("small", backup_file_options(32)).unwrap();
        zip.write_all(b"small payload").unwrap();
        let cursor = zip.finish().unwrap();
        let header = cursor.get_ref();
        assert_eq!(&header[0..4], b"PK\x03\x04");
        assert_eq!(&header[18..26], &[0xff; 8]);
        let mut zip = ZipArchive::new(cursor).unwrap();
        let mut entry = zip.by_name("large").unwrap();
        assert_eq!(entry.compression(), CompressionMethod::Stored);
        let mut actual = String::new();
        entry.read_to_string(&mut actual).unwrap();
        assert_eq!(actual, "finite stand-in for large payload");
        drop(entry);
        assert_eq!(
            zip.by_name("small").unwrap().compression(),
            CompressionMethod::Deflated
        );
    }

    fn place(path: &Path, data: &[u8]) -> Vec<FileRecord> {
        fs::create_dir(path).unwrap();
        fs::write(path.join("fixture"), data).unwrap();
        collect_files(path).unwrap()
    }

    #[test]
    fn interrupted_restores_continue_from_each_known_directory_layout() {
        let old = b"prior instance files";
        let new = b"selected archive files";
        for step in [
            "beforeMove",
            "oldMoved",
            "newPublished",
            "newParked",
            "oldReapplied",
        ] {
            let root = fixture_folder("restore");
            let paths = RestorePaths::new(&root.path().join("live"), Uuid::new_v4()).unwrap();
            let old_files = place(
                if matches!(step, "beforeMove" | "oldReapplied") {
                    &paths.live
                } else {
                    &paths.previous
                },
                old,
            );
            let new_files = place(
                if step == "newPublished" {
                    &paths.live
                } else {
                    &paths.stage
                },
                new,
            );
            recover_layout(&paths, Some(&old_files), &new_files).unwrap();
            recover_layout(&paths, Some(&old_files), &new_files).unwrap();
            assert_eq!(fs::read(paths.live.join("fixture")).unwrap(), old);
            assert_eq!(fs::read(paths.stage.join("fixture")).unwrap(), new);
            assert!(!paths.previous.exists());
        }
    }

    #[test]
    fn interrupted_restore_refuses_changed_live_or_mismatched_previous_before_moving() {
        let root = fixture_folder("restore-conflict");
        let paths = RestorePaths::new(&root.path().join("live"), Uuid::new_v4()).unwrap();
        let old_files = place(&paths.previous, b"original");
        let new_files = place(&paths.stage, b"restored");
        let external_files = place(&paths.live, b"independently created");
        assert!(recover_layout(&paths, Some(&old_files), &new_files).is_err());
        assert_eq!(collect_files(&paths.live).unwrap(), external_files);
        assert_eq!(collect_files(&paths.previous).unwrap(), old_files);
        rename_owned_directory(&paths.live, &root.path().join("outside-the-restore")).unwrap();
        rename_owned_directory(&paths.stage, &paths.live).unwrap();
        fs::write(paths.previous.join("fixture"), b"changed original").unwrap();
        assert!(recover_layout(&paths, Some(&old_files), &new_files).is_err());
        assert_eq!(collect_files(&paths.live).unwrap(), new_files);
        assert_eq!(
            fs::read(paths.previous.join("fixture")).unwrap(),
            b"changed original"
        );
        assert!(!paths.stage.exists());
    }

    #[test]
    fn interrupted_restore_of_a_missing_instance_preserves_true_absence() {
        let root = fixture_folder("restore-absence");
        let paths = RestorePaths::new(&root.path().join("live"), Uuid::new_v4()).unwrap();
        let selected = place(&paths.live, b"just published");
        recover_layout(&paths, None, &selected).unwrap();
        recover_layout(&paths, None, &selected).unwrap();
        assert!(!paths.live.exists());
        assert_eq!(collect_files(&paths.stage).unwrap(), selected);
        fs::create_dir(&paths.live).unwrap();
        assert!(recover_layout(&paths, None, &selected).is_err());
        assert!(paths.live.is_dir());
    }

    #[test]
    fn interrupted_restore_intent_is_not_overwritten_and_keeps_recovery_paths() {
        let root = fixture_folder("restore-marker");
        let live = root.path().join("live");
        let token = Uuid::new_v4();
        let paths = RestorePaths::new(&live, token).unwrap();
        let original = place(&paths.previous, b"prior");
        let selected = place(&paths.stage, b"selected");
        let before = backup_manifest("test", &live, original);
        let after = backup_manifest("test", &live, selected);
        let first = RestoreIntent {
            token,
            before: before.instance.clone(),
            after: after.instance.clone(),
            original: Some(identify_archive(Uuid::new_v4(), &before).unwrap()),
            selected: identify_archive(Uuid::new_v4(), &after).unwrap(),
        };
        write_intent(root.path(), &first).unwrap();
        let reopened = read_intent(root.path()).unwrap().unwrap();
        let second = RestoreIntent {
            token: Uuid::new_v4(),
            ..reopened
        };
        assert!(write_intent(root.path(), &second).is_err());
        let reopened = read_intent(root.path()).unwrap().unwrap();
        assert_eq!(reopened.token, token);
        let paths = intent_paths(&reopened, &first.before).unwrap();
        let error = paths.locations(&reopened).error(
            "backup.restoreRecoveryRequired",
            "detail goes to diagnostics",
        );
        assert_eq!(
            error.params["currentDirectory"],
            live.to_string_lossy().into_owned()
        );
        assert_eq!(
            error.params["previousDirectory"],
            paths.previous.to_string_lossy().into_owned()
        );
        assert_eq!(
            error.params["restoredDirectory"],
            paths.stage.to_string_lossy().into_owned()
        );
        assert_eq!(
            error.params["previousBackupId"],
            first.original.unwrap().id.to_string()
        );
    }

    #[test]
    fn full_restore_has_previous_backup_and_original_directory() {
        let root = fixture_folder("verified-restore");
        let live = root.path().join("game").join("instances").join("test");
        fs::create_dir_all(live.parent().unwrap()).unwrap();
        let before = place(&live, b"prior bytes");
        let before = backup_manifest("test", &live, before);
        let state = fixture_state(root.path(), &before.instance);
        fs::write(live.join("fixture"), b"remaining current bytes").unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
        let (result, state) = runtime.block_on(async {
            tokio::task::spawn_blocking(move || {
                let backup = backup_inner(&state, &before.instance).unwrap();
                fs::write(live.join("fixture"), b"user edits after backup").unwrap();
                let result = restore_inner(&state, &before.instance.id, &backup.id).unwrap();
                assert_eq!(
                    fs::read(live.join("fixture")).unwrap(),
                    b"remaining current bytes"
                );
                (result, state)
            })
            .await
            .unwrap()
        });
        let preserve = PathBuf::from(result.previous_directory.unwrap());
        assert_eq!(
            fs::read(preserve.join("fixture")).unwrap(),
            b"user edits after backup"
        );
        assert!(Path::new(&result.previous_backup.unwrap().path).is_file());
        assert!(read_intent(&backup_folder(&state, "test").unwrap())
            .unwrap()
            .is_none());
    }

    #[test]
    fn explicit_recovery_after_published_restore_recovers_registration_and_preserves_selected_copy()
    {
        let root = fixture_folder("explicit-recovery");
        let live = root.path().join("game").join("instances").join("test");
        fs::create_dir_all(live.parent().unwrap()).unwrap();
        let token = Uuid::new_v4();
        let paths = RestorePaths::new(&live, token).unwrap();
        let before = backup_manifest("test", &live, place(&paths.previous, b"original files"));
        let mut after = backup_manifest(
            "test",
            &live,
            place(&paths.live, b"selected restored files"),
        );
        after.instance.name = "selected archive title".into();
        let state = fixture_state(root.path(), &after.instance);
        let folder = backup_folder(&state, "test").unwrap();
        fs::create_dir_all(&folder).unwrap();
        let original = Uuid::new_v4();
        let selected = Uuid::new_v4();
        write_backup_manifest(&folder, original, &before);
        write_backup_manifest(&folder, selected, &after);
        let intent = RestoreIntent {
            token,
            before: before.instance.clone(),
            after: after.instance.clone(),
            original: Some(identify_archive(original, &before).unwrap()),
            selected: identify_archive(selected, &after).unwrap(),
        };
        write_intent(&folder, &intent).unwrap();
        let read_only_history = backup_history(&folder, "test").unwrap();
        assert_eq!(read_only_history.backups.len(), 2);
        assert_eq!(collect_files(&paths.live).unwrap(), after.files);
        let intent = read_intent(&folder).unwrap().unwrap();
        let result = recover_with_state(&state, &folder, &intent, &paths, &after.instance).unwrap();
        assert!(same_instance(&result.instance, &before.instance).unwrap());
        assert!(same_instance(&state.snapshot().unwrap().instances[0], &before.instance).unwrap());
        assert_eq!(result.previous_backup.unwrap().id, original.to_string());
        assert_eq!(result.preserved_directory.as_deref(), paths.stage.to_str());
        assert_eq!(collect_files(&paths.live).unwrap(), before.files);
        assert_eq!(collect_files(&paths.stage).unwrap(), after.files);
        assert!(read_intent(&folder).unwrap().is_none());
    }
}
