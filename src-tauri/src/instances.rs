//! Reversible instance metadata changes, cloning, personal backups and restoration.
use crate::path_grants::{PathGrants, PathUse};
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
const MAX_TREE_DEPTH: usize = 64;
/// A copy whose source changed while it was copied, or whose copy does not
/// match what was read; the server import names these for its own users.
pub(crate) const COPY_CHANGED: &str = "复制期间实例文件发生变化，请关闭游戏后重试。原实例未改变。";
pub(crate) const COPY_MISMATCH: &str = "实例副本校验失败，原实例未改变";

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

pub(crate) fn validate_absolute_syntax(path: &Path) -> Result<(), String> {
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
    Ok(())
}

/// Validate absolute user paths and reject links/junctions without following their targets.
pub(crate) fn checked_absolute(path: &Path) -> Result<PathBuf, String> {
    validate_absolute_syntax(path)?;
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
    let root = crate::processes::configured_game_root(Path::new(&config.game_directory))?;
    let instances = safe_join(&root, "instances")?;
    fs::create_dir_all(&instances).map_err(|e| format!("无法创建实例目录：{e}"))?;
    checked_absolute(&instances)
}

pub(crate) fn sha256(path: &Path) -> Result<String, String> {
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum InventoryScope {
    All,
    Instance,
}

fn is_runtime_scratch(path: &Path) -> bool {
    let Some(name) = path.file_name() else {
        return false;
    };
    #[cfg(windows)]
    return name.eq_ignore_ascii_case(std::ffi::OsStr::new(".launcher-temp"));
    #[cfg(not(windows))]
    return name == ".launcher-temp";
}

/// Snapshot a fixed list before creating staging directories; never follow directory links.
pub(crate) fn collect_files(root: &Path) -> Result<Vec<FileRecord>, String> {
    collect_files_controlled(root, None)
}

pub(crate) fn collect_files_controlled(
    root: &Path,
    control: Option<&LauncherState>,
) -> Result<Vec<FileRecord>, String> {
    collect_files_in_scope(root, InventoryScope::All, control)
}

pub(crate) fn collect_instance_files_controlled(
    root: &Path,
    control: Option<&LauncherState>,
) -> Result<Vec<FileRecord>, String> {
    collect_files_in_scope(root, InventoryScope::Instance, control)
}

fn collect_files_in_scope(
    root: &Path,
    scope: InventoryScope,
    control: Option<&LauncherState>,
) -> Result<Vec<FileRecord>, String> {
    checked_absolute(root)?;
    if !root.is_dir() {
        return Err("实例目录不存在".into());
    }
    fn visit(
        root: &Path,
        dir: &Path,
        depth: usize,
        files: &mut Vec<FileRecord>,
        total: &mut u64,
        walked: &mut usize,
        scope: InventoryScope,
        control: Option<&LauncherState>,
    ) -> Result<(), String> {
        if depth > MAX_TREE_DEPTH {
            return Err("实例目录层级超过 64，拒绝继续扫描".into());
        }
        for entry in fs::read_dir(dir).map_err(|e| format!("无法读取实例目录：{e}"))? {
            if let Some(state) = control {
                sync_checkpoint(state)?;
            }
            *walked += 1;
            if *walked > MAX_TREE_FILES * 2 {
                return Err("实例文件和目录超过 200000 项，请先整理后重试".into());
            }
            let path = entry.map_err(|e| e.to_string())?.path();
            checked_absolute(&path)?;
            let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
            if metadata.is_dir() {
                if depth == 0 && scope == InventoryScope::Instance && is_runtime_scratch(&path) {
                    continue;
                }
                visit(root, &path, depth + 1, files, total, walked, scope, control)?;
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
    visit(root, root, 0, &mut files, &mut 0, &mut 0, scope, control)?;
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

pub(crate) fn copy_snapshot_controlled(
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
    copy_into_snapshot(source, destination, files, InventoryScope::All, control)
}

fn copy_into_snapshot(
    source: &Path,
    destination: &Path,
    files: &[FileRecord],
    scope: InventoryScope,
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
            return Err(COPY_MISMATCH.into());
        }
    }
    // A running game changing a world/configuration causes a safe failure.
    if collect_files_in_scope(source, scope, control)? != files {
        return Err(COPY_CHANGED.into());
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

/// The runtime-reset and memory part of an instance update, in apply order.
fn runtime_memory_changes(
    reset_runtime: bool,
    max_memory_mb: Option<u32>,
    memory_mode: Option<String>,
    min_memory_mb: Option<u32>,
    clear_min_memory: bool,
) -> Result<Vec<(String, Value)>, String> {
    let mut changes: Vec<(String, Value)> = Vec::new();
    if reset_runtime {
        for field in [
            "maxMemoryMb",
            "memoryMode",
            "minMemoryMb",
            "javaPath",
            "jvmArguments",
            "screenWidth",
            "screenHeight",
            "gameProxyMode",
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
    if let Some(mode) = memory_mode {
        if mode == "inherit" {
            changes.retain(|(key, _)| key != "maxMemoryMb");
            changes.push(("maxMemoryMb".into(), Value::Null));
            changes.push(("memoryMode".into(), Value::Null));
        } else {
            crate::memory::validate_mode(&mode)?;
            changes.push(("memoryMode".into(), json!(mode)));
        }
    }
    if clear_min_memory || min_memory_mb.is_some() {
        changes.push(("minMemoryMb".into(), json!(min_memory_mb)));
    }
    Ok(changes)
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
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    name: Option<String>,
    category: Option<String>,
    notes: Option<String>,
    icon_path: Option<String>,
    max_memory_mb: Option<u32>,
    memory_mode: Option<String>,
    min_memory_mb: Option<u32>,
    clear_min_memory: Option<bool>,
    java_path: Option<String>,
    jvm_arguments: Option<String>,
    screen_width: Option<u32>,
    screen_height: Option<u32>,
    reset_runtime: Option<bool>,
    game_proxy_mode: Option<String>,
) -> crate::errors::AppResult<Instance> {
    let previous = instance(&state.snapshot()?, &instance_id)?;
    // Checked again under the lock; this one only spares a native dialog.
    require_no_pending_restore(&state, &instance_id)?;
    let java_path = if let Some(path) = java_path.filter(|path| Some(path.as_str()) != previous.java_path.as_deref()) {
        if path.trim().is_empty() { Some(path) }
        else { Some(grants.choose_or_confirm(PathUse::Java, path.trim(), &window, true).await?
            .to_string_lossy().into_owned()) }
    } else { None };
    let icon_path = if let Some(path) = icon_path.filter(|path| Some(path.as_str()) != previous.icon_path.as_deref()) {
        if path.trim().is_empty() { Some(path) }
        else { Some(grants.consume(PathUse::InstanceIcon, &path, &window)?
            .to_string_lossy().into_owned()) }
    } else { None };
    let _operation = state.operation.lock().await;
    require_no_pending_restore(&state, &instance_id)?;
    let current = instance(&state.snapshot()?, &instance_id)?;
    if current.java_path != previous.java_path || current.icon_path != previous.icon_path {
        return Err(crate::errors::STORAGE_STATE_CHANGED.into());
    }
    let mut changes = runtime_memory_changes(
        reset_runtime.unwrap_or(false),
        max_memory_mb,
        memory_mode,
        min_memory_mb,
        clear_min_memory.unwrap_or(false),
    )?;
    if let Some(mode) = game_proxy_mode {
        let value = if mode == "default" {
            Value::Null
        } else {
            let config = state.snapshot()?.config;
            crate::network::Settings::from_config(&config)
                .and_then(|proxy| proxy.validate_game_save(&mode))
                .map_err(crate::errors::AppError::from)?;
            json!(mode)
        };
        changes.push(("gameProxyMode".into(), value));
    }
    let global = state.snapshot()?.config;
    let mut candidate = current.clone();
    replace_metadata(&mut candidate, &changes)?;
    crate::memory::validate_instance_memory(&global, &current, &candidate)?;
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
        crate::memory::validate_changed_heap_arguments(current.jvm_arguments.as_deref().unwrap_or(""), &args)?;
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
    }).map_err(crate::errors::expected)
}

fn normalize_target_loader(loader: &str) -> Result<String, String> {
    let normalized = loader.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "vanilla" | "fabric" | "quilt" | "forge" | "neoforge" | "optifine" => Ok(normalized),
        _ => Err("不支持的加载器；请选择原版、Fabric、Quilt、Forge、NeoForge 或 OptiFine".into()),
    }
}

pub(crate) fn resolve_instance_game_version(
    state: &LauncherState,
    current: &Instance,
) -> Result<String, String> {
    let config = state.snapshot()?.config;
    if let Ok(root) = crate::processes::configured_game_root(Path::new(&config.game_directory)) {
        if let Ok((game_version, _)) = crate::resources::context_for_version(&root, &current.version_id) {
            validate_id(&game_version)?;
            return Ok(game_version);
        }
    }
    let current_loader = current.loader.trim().to_ascii_lowercase();
    if current_loader.is_empty() || current_loader == "vanilla" {
        validate_id(&current.version_id)?;
        return Ok(current.version_id.clone());
    }
    Err("无法确定此实例的基础 Minecraft 版本，请先确认对应版本配置文件存在".into())
}

pub(crate) fn apply_instance_loader_update(
    state: &LauncherState,
    instance_id: &str,
    new_version_id: &str,
    new_loader: &str,
    new_loader_version: &str,
) -> Result<Instance, String> {
    validate_id(new_version_id)?;
    let normalized_loader = normalize_target_loader(new_loader)?;
    if normalized_loader != "vanilla" {
        validate_id(new_loader_version)?;
    }
    let changes = vec![
        ("versionId".into(), json!(new_version_id)),
        ("loader".into(), json!(normalized_loader)),
        (
            "loaderVersion".into(),
            json!(if normalized_loader == "vanilla" { "" } else { new_loader_version }),
        ),
    ];
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
pub async fn change_instance_loader(
    app: tauri::AppHandle,
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    loader: String,
    loader_version: Option<String>,
) -> AppResult<Instance> {
    let target_loader = normalize_target_loader(&loader).map_err(crate::errors::expected)?;
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| crate::errors::expected("已有安装或启动准备任务运行"))?;
    require_no_pending_restore(&state, &instance_id)?;
    let current = instance(&state.snapshot()?, &instance_id).map_err(crate::errors::expected)?;
    crate::resources::require_target_stopped(&state, &current.version_id, Some(&instance_id))?;
    crate::minecraft::require_install_root_stopped(&state, &state.snapshot()?.config)
        .map_err(crate::errors::expected)?;
    let game_version = resolve_instance_game_version(&state, &current).map_err(crate::errors::expected)?;
    let requested_version = loader_version.unwrap_or_default().trim().to_owned();
    if target_loader != "vanilla" && !requested_version.is_empty() && requested_version != "latest" {
        validate_id(&requested_version).map_err(crate::errors::expected)?;
    }

    let task = state
        .control
        .begin_with_display(
            "loader",
            &game_version,
            &format!("更换实例加载器 {}", current.name),
            &current.name,
        )
        .map_err(crate::errors::expected)?;
    let install_result: Result<(String, String, String), String> = if target_loader == "vanilla" {
        crate::minecraft::install(&state, &app, &game_version)
            .await
            .map(|_| (game_version.clone(), "vanilla".to_owned(), String::new()))
    } else {
        crate::loaders::install_loader_inner(
            &state,
            &app,
            &target_loader,
            &game_version,
            &requested_version,
        )
        .await
        .map(|installed| (installed.version_id, installed.loader, installed.loader_version))
    };
    state
        .control
        .finish(&task, install_result.as_ref().err().map(String::as_str));
    let (new_version_id, new_loader, new_loader_version) =
        install_result.map_err(crate::errors::expected)?;
    apply_instance_loader_update(
        &state,
        &instance_id,
        &new_version_id,
        &new_loader,
        &new_loader_version,
    )
    .map_err(crate::errors::expected)
}

#[tauri::command]
pub async fn clone_instance(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    name: String,
) -> Result<Instance, String> {
    validate_name(&name)?;
    let _operation = state.operation.lock().await;
    let task = state.control.begin_with_display("clone", &instance_id, &name, &name)?;
    let arc = state.inner().clone();
    let result = tokio::task::spawn_blocking(move || clone_inner(&arc, &instance_id, &name))
        .await
        .unwrap_or_else(|e| Err(format!("克隆任务异常：{e}")));
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result
}

fn stopped_instance_directory(state: &LauncherState, value: &Instance) -> Result<PathBuf, String> {
    let config = state.snapshot()?.config;
    let directory = crate::minecraft::game_directory(&config, &value.version_id, Some(value))?;
    let identity = state.games.require_directory_stopped(&directory, Some(&value.id), false)?;
    crate::storage::to_process_path(&identity)
}

fn clone_inner(state: &LauncherState, instance_id: &str, name: &str) -> Result<Instance, String> {
    let old = instance(&state.snapshot()?, instance_id)?;
    let source = stopped_instance_directory(state, &old)?;
    let root = instance_root(&state)?;
    let token = uuid::Uuid::new_v4().to_string();
    let staging = safe_join(&root, &format!(".clone-{token}"))?;
    let destination = safe_join(&root, &token)?;
    if crate::processes::directory_tail(&root, &source).is_some() {
        return Err(
            "共享游戏根目录不能直接作为独立实例克隆，请先导出个人备份。独立实例可正常克隆。".into(),
        );
    }
    let files = collect_instance_files_controlled(&source, Some(state))?;
    let mut staging = StagingDirectory::create(staging)?;
    copy_into_snapshot(
        &source,
        staging.path(),
        &files,
        InventoryScope::Instance,
        Some(state),
    )?;
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

/// No replacement even if a file appeared after an earlier path check.
pub(crate) fn publish_archive_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    rename_owned_directory(source, destination)
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
        if collect_instance_files_controlled(source, control)? != files {
            return Err("备份期间实例文件发生变化，请关闭游戏后重试".into());
        }
        if output.exists() {
            return Err("导出期间出现同名文件，已保留该文件".into());
        }
        publish_archive_file(&temp, &output).map_err(|e| e.to_string())
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
    let source = stopped_instance_directory(state, value)?;
    let files = collect_instance_files_controlled(&source, Some(state))?;
    validate_id(&value.id)?;
    let root = checked_absolute(&state.data_dir.join("instance-backups"))?;
    let folder = safe_join(&root, &value.id)?;
    if crate::processes::directory_tail(&folder, &source).is_some() {
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
    let task = state.control.begin_with_display("backup", &instance_id, &value.name, &value.name)?;
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
    /// The operation the pending record belongs to (a backup restore or a
    /// modpack update), when it could be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<RestoreKind>,
}

impl RecoveryPaths {
    fn current(current: &Path) -> Self {
        Self {
            current_directory: current.to_string_lossy().into_owned(),
            previous_directory: None,
            restored_directory: None,
            previous_backup_id: None,
            kind: None,
        }
    }

    fn of(mut self, kind: RestoreKind) -> Self {
        self.kind = Some(kind);
        self
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
        if let Some(kind) = self.kind {
            error = error.with_param("kind", serde_json::to_value(kind).unwrap_or_default());
        }
        error
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreIntent {
    token: Uuid,
    /// Intents written before pack updates existed have no kind: a backup.
    #[serde(default)]
    kind: RestoreKind,
    before: Instance,
    after: Instance,
    original: Option<RestoreIdentity>,
    selected: RestoreIdentity,
}

/// What an intent's stage is: a backup being restored (`selected` is that
/// backup) or a modpack update (`selected` is the file list of the stage,
/// kept beside the intent).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RestoreKind {
    #[default]
    Backup,
    PackUpdate,
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
        locations.of(intent.kind)
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
    let data = state.snapshot()?;
    let current = instance(&data, &instance_id)?;
    let folder = backup_folder(&state, &instance_id)?;
    let mut history = backup_history(&folder, &instance_id)?;
    let resolved = crate::minecraft::game_directory(&data.config, &current.version_id, Some(&current));
    let live = resolved.as_deref().unwrap_or_else(|_| Path::new(&current.game_directory));
    history.recovery = match read_intent(&folder) {
        Ok(Some(intent)) => Some(intent_paths(&intent, &current, live).map_or_else(
            |_| RecoveryPaths::current(live).of(intent.kind),
            |paths| paths.locations(&intent),
        )),
        Err(_) => Some(RecoveryPaths::current(live)),
        Ok(None) => None,
    };
    Ok(history)
}

fn intent_paths(intent: &RestoreIntent, current: &Instance, live: &Path) -> Result<RestorePaths, String> {
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
    RestorePaths::new(live, intent.token)
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

/// The part of a registration its directory's files depend on. Which side of
/// a restore or pack update a registration is on is decided by this alone:
/// the rest (name, notes, launch and play time, settings) may have been
/// changed by the user since.
fn file_identity(value: &Instance) -> [&str; 5] {
    [
        &value.id,
        &value.game_directory,
        &value.version_id,
        &value.loader,
        &value.loader_version,
    ]
}

/// `current` moved from `from` to `to` field by field: a field still as
/// `from` has it takes `to`'s value, one changed since keeps its own.
fn rebase_registration(current: &Instance, from: &Instance, to: &Instance) -> Result<Instance, String> {
    let from = serde_json::to_value(from).map_err(|e| e.to_string())?;
    let to = serde_json::to_value(to).map_err(|e| e.to_string())?;
    let mut value = serde_json::to_value(current).map_err(|e| e.to_string())?;
    let (Some(from), Some(to), Some(fields)) = (from.as_object(), to.as_object(), value.as_object_mut()) else {
        return Err("实例信息无效".into());
    };
    for (key, target) in to {
        if fields.get(key) == from.get(key) {
            fields.insert(key.clone(), target.clone());
        }
    }
    serde_json::from_value(value).map_err(|e| e.to_string())
}

/// Moves the registered instance from `from` to `to` (see
/// `rebase_registration`). Its file identity must be one of theirs; any other
/// belongs to a change this swap does not know.
fn rebase_registered_instance(state: &LauncherState, from: &Instance, to: &Instance) -> Result<Instance, String> {
    state.update(|data| {
        let value = data
            .instances
            .iter_mut()
            .find(|entry| entry.id == from.id)
            .ok_or("实例已被移除")?;
        if file_identity(value) != file_identity(from) && file_identity(value) != file_identity(to) {
            return Err("当前实例信息已改变".into());
        }
        *value = rebase_registration(value, from, to)?;
        Ok(value.clone())
    })
}

fn replace_registered_instance(
    state: &LauncherState,
    expected: &Instance,
    replacement: &Instance,
) -> Result<(), String> {
    rebase_registered_instance(state, expected, replacement).map(|_| ())
}

/// Launching or changing an instance while a restore or pack update of it is
/// unfinished would change what that recovery checks. An unreadable record
/// counts as unfinished.
pub(crate) fn require_no_pending_restore(state: &LauncherState, instance_id: &str) -> Result<(), String> {
    match read_intent(&backup_folder(state, instance_id)?) {
        Ok(None) => Ok(()),
        Ok(Some(_)) | Err(_) => Err(crate::errors::RESTORE_PENDING.into()),
    }
}

fn restore_target(state: &LauncherState, current: &Instance) -> AppResult<PathBuf> {
    // Not `require_resource_stopped`: recovery runs while its record is pending.
    crate::resources::require_target_stopped(state, &current.version_id, Some(&current.id))?;
    let config = state.snapshot()?.config;
    let directory = crate::minecraft::game_directory(&config, &current.version_id, Some(current))?;
    let target = crate::processes::canonical_game_directory(&directory)?;
    let configured = crate::processes::configured_game_root(Path::new(&config.game_directory))?;
    let configured = crate::processes::canonical_game_directory(&configured)?;
    let profile = crate::processes::canonical_game_directory(&state.data_dir)?;
    // A release may run on a machine where the build checkout/drive does not
    // exist. A local checkout still participates in canonical comparisons.
    let source = crate::processes::canonical_game_directory(Path::new(env!("CARGO_MANIFEST_DIR"))).ok();
    let contains = |parent: &Path, child: &Path| crate::processes::directory_tail(child, parent).is_some();
    let overlaps = |a: &Path, b: &Path| contains(a, b) || contains(b, a);
    // Only an independent registered instance can be replaced in place.
    if contains(&target, &configured) || overlaps(&target, &profile) || source.as_deref().is_some_and(|source| contains(&target, source)) {
        return Err(SHARED_ROOT_RESTORE.into());
    }
    Ok(directory)
}

const SHARED_ROOT_RESTORE: &str = "共享游戏根目录或启动器目录不能原地恢复。请将备份导入为新的独立实例。";

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
    let label = instance(&state.snapshot()?, &instance_id)?.name;
    let task = state.control.begin_with_display("restore", &instance_id, "恢复实例备份", &label)?;
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
    let label = instance(&state.snapshot()?, &instance_id)?.name;
    let task = state
        .control
        .begin_with_display("restore", &instance_id, "恢复中断的实例备份", &label)?;
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
        let paths = intent_paths(&intent, &current, &directory).map_err(|err| {
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
    // Only what the files depend on says which side the registration is on;
    // a rename, launch time or play time written since stays the user's.
    let identity = file_identity(current);
    if identity != file_identity(&intent.before) && identity != file_identity(&intent.after) {
        return Err("实例已改变，已保留恢复副本".into());
    }

    // A pending recovery should validate against the pinned archive inventory
    // without selecting another user's game or accepting an unrelated snapshot.
    let original = intent
        .original
        .as_ref()
        .map(|backup| verify_archive(folder, backup, &current.id))
        .transpose()?;
    let selected = selected_files(folder, intent, &current.id)?;
    recover_layout(
        paths,
        original.as_ref().map(|(_, backup)| backup.files.as_slice()),
        &selected,
    )?;
    // Fields still as the swap wrote them go back; nothing to write when the
    // registration never left `before`.
    let instance = if same_instance(&rebase_registration(current, &intent.after, &intent.before)?, current)? {
        current.clone()
    } else {
        rebase_registered_instance(state, &intent.after, &intent.before)?
    };
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
    if intent.kind == RestoreKind::PackUpdate {
        let _ = fs::remove_file(pack_manifest_path(folder, intent.token)?);
    }
    Ok(RecoverRestoreResult {
        instance,
        previous_backup,
        preserved_directory: paths
            .stage
            .is_dir()
            .then(|| paths.stage.to_string_lossy().into_owned()),
    })
}

/// The files the intent's stage must hold: the selected backup's inventory,
/// or the file list a pack update recorded (checked against its hash).
fn selected_files(folder: &Path, intent: &RestoreIntent, instance_id: &str) -> Result<Vec<FileRecord>, String> {
    match intent.kind {
        RestoreKind::Backup => verify_archive(folder, &intent.selected, instance_id).map(|(_, archive)| archive.files),
        RestoreKind::PackUpdate => read_pack_manifest(folder, intent),
    }
}

/// A pack update's stage file list: beside the intent, which stays small
/// however many files a pack has.
fn pack_manifest_path(folder: &Path, token: Uuid) -> Result<PathBuf, String> {
    safe_join(folder, &format!("pack-update-{token}.json"))
}

const MAX_PACK_MANIFEST_BYTES: u64 = 64 * 1024 * 1024;

/// Writes the list without replacing anything and returns its hash.
fn write_pack_manifest(folder: &Path, token: Uuid, files: &[FileRecord]) -> Result<String, String> {
    let output = pack_manifest_path(folder, token)?;
    let temporary = safe_join(folder, &format!(".pack-update-{}.part", Uuid::new_v4()))?;
    let bytes = serde_json::to_vec(files).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    let written = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = written.and_then(|()| rename_owned_directory(&temporary, &output));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| format!("无法保存更新文件清单：{e}"))?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

fn read_pack_manifest(folder: &Path, intent: &RestoreIntent) -> Result<Vec<FileRecord>, String> {
    let path = pack_manifest_path(folder, intent.token)?;
    let mut file = fs::File::open(&path).map_err(|e| format!("无法读取更新文件清单：{e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("更新文件清单路径无效".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_PACK_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_PACK_MANIFEST_BYTES
        || format!("{:x}", Sha256::digest(&bytes)) != intent.selected.manifest_sha256
    {
        return Err("更新文件清单已改变".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("更新文件清单无效：{e}"))
}

fn clear_intent(folder: &Path) -> Result<(), String> {
    fs::remove_file(safe_join(folder, RESTORE_INTENT)?)
        .map_err(|e| format!("无法清除恢复记录：{e}"))
}

fn matches_original_inventory(path: &Path, original: &[FileRecord]) -> Result<bool, String> {
    // Pre-C2 restore journals may include scratch in their automatic backup.
    // Respect those manifests instead of silently ignoring recorded files.
    let contains_legacy_scratch = original.iter().any(|file| {
        let mut components = Path::new(&file.relative).components();
        let first = components.next();
        components.next().is_some()
            && first.is_some_and(|first| is_runtime_scratch(Path::new(first.as_os_str())))
    });
    let actual = if contains_legacy_scratch {
        collect_files(path)?
    } else {
        collect_instance_files_controlled(path, None)?
    };
    Ok(actual == original)
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
        if !matches_original_inventory(&paths.previous, original)? {
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
        if !has_live || !matches_original_inventory(&paths.live, original)? {
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
    restore_inner_using(
        state,
        instance_id,
        backup_id,
        rename_owned_directory,
        replace_registered_instance,
    )
}

fn restore_inner_using(
    state: &LauncherState,
    instance_id: &str,
    backup_id: &str,
    move_dir: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    replace: impl FnOnce(&LauncherState, &Instance, &Instance) -> Result<(), String>,
) -> AppResult<RestoreResult> {
    let current = instance(&state.snapshot()?, instance_id)?;
    let directory = restore_target(state, &current)?;
    let folder = backup_folder(state, instance_id)?;
    match read_intent(&folder) {
        Ok(None) => (),
        Ok(Some(pending)) => {
            let locations = intent_paths(&pending, &current, &directory).map_or_else(
                |_| RecoveryPaths::current(&directory).of(pending.kind),
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
        kind: RestoreKind::Backup,
        before: current.clone(),
        after: restored.clone(),
        original,
        selected: identify_archive(selected_id, &metadata)?,
    };
    write_intent(&folder, &intent)?;
    staging.preserve(); // durable material now belongs to the recovery intent

    swap_instance_directory_using(
        state,
        &folder,
        &intent,
        &paths,
        &current,
        &restored,
        move_dir,
        replace,
    )?;
    Ok(RestoreResult {
        instance: restored,
        previous_backup,
        previous_directory: paths.locations(&intent).previous_directory,
    })
}

/// Publish the staged directory that `intent` records: park the live
/// directory, move the stage into place and update the registration. Any
/// failure rolls back from the durable intent; the intent is cleared only after
/// a complete publish. Restore uses it now; pack updates reuse it with their own
/// `after` registration.
#[allow(clippy::too_many_arguments)]
fn swap_instance_directory_using(
    state: &LauncherState,
    folder: &Path,
    intent: &RestoreIntent,
    paths: &RestorePaths,
    current: &Instance,
    after: &Instance,
    mut move_dir: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    replace: impl FnOnce(&LauncherState, &Instance, &Instance) -> Result<(), String>,
) -> AppResult<()> {
    let publish = (|| -> Result<(), String> {
        if intent.original.is_some() {
            move_dir(&paths.live, &paths.previous).map_err(|e| e.to_string())?;
        }
        move_dir(&paths.stage, &paths.live).map_err(|e| e.to_string())?;
        replace(state, current, after)
    })();
    if let Err(error) = publish {
        let on_disk = state
            .snapshot()
            .and_then(|data| instance(&data, &current.id));
        return Err(
            match on_disk.and_then(|on_disk| recover_with_state(state, folder, intent, paths, &on_disk)) {
                Ok(_) => paths.locations(intent).error("backup.restoreRolledBack", error),
                Err(recovery) => paths.locations(intent).error(
                    "backup.restoreRecoveryRequired",
                    format!("{error}; {recovery}"),
                ),
            },
        );
    }
    clear_intent(folder).map_err(|error| {
        paths
            .locations(intent)
            .error("backup.restoreRecoveryRequired", error)
    })
}

/// A pack update's copy of an instance: beside the live directory, owned by
/// this update until its intent takes it over.
pub(crate) struct PackStage {
    token: Uuid,
    paths: RestorePaths,
    staging: StagingDirectory,
    folder: PathBuf,
    original: RestoreIdentity,
    previous_backup: InstanceBackup,
    /// The live files as copied (instance scope).
    pub(crate) files: Vec<FileRecord>,
}

impl PackStage {
    pub(crate) fn path(&self) -> &Path {
        self.staging.path()
    }
}

pub(crate) struct PackUpdateDone {
    pub(crate) instance: Instance,
    pub(crate) previous_backup: InstanceBackup,
    /// The old directory, kept when it changed while the update ran.
    pub(crate) previous_directory: Option<String>,
}

/// The directory a modpack update may replace: the same rules as a restore
/// (stopped, not a shared root), and no unfinished restore or update.
pub(crate) fn pack_update_target(state: &LauncherState, current: &Instance) -> AppResult<PathBuf> {
    let directory = restore_target(state, current).map_err(|error| {
        if error.detail.as_deref() == Some(SHARED_ROOT_RESTORE) {
            crate::errors::expected(crate::modpacks::pack_update::SHARED_ROOT)
        } else {
            error
        }
    })?;
    let folder = backup_folder(state, &current.id)?;
    match read_intent(&folder) {
        Ok(None) => Ok(directory),
        Ok(Some(pending)) => {
            let locations = intent_paths(&pending, current, &directory).map_or_else(
                |_| RecoveryPaths::current(&directory).of(pending.kind),
                |paths| paths.locations(&pending),
            );
            Err(locations.error("backup.restoreRecoveryRequired", "此实例有未完成的恢复，请先显式恢复"))
        }
        Err(error) => Err(RecoveryPaths::current(&directory).error("backup.restoreRecoveryRequired", error)),
    }
}

/// An automatic backup of the live directory, then a verified copy of it
/// (instance scope) beside it, which the update changes.
pub(crate) fn stage_pack_update(state: &LauncherState, current: &Instance) -> AppResult<PackStage> {
    let directory = pack_update_target(state, current)?;
    let folder = backup_folder(state, &current.id)?;
    // With no intent pending, a file list left by an update whose cleanup
    // failed belongs to nothing.
    sweep_pack_manifests(&folder);
    let token = Uuid::new_v4();
    let paths = RestorePaths::new(&directory, token)?;
    if directory_present(&paths.previous)? || directory_present(&paths.stage)? {
        return Err("更新副本目录已存在".into());
    }
    let previous_backup = backup_inner(state, current)?;
    crate::modpacks::pack_update::at(&directory, "backup");
    let id = Uuid::parse_str(&previous_backup.id).map_err(|_| "更新前备份标识无效")?;
    let backed_up = read_backup(Path::new(&previous_backup.path))?;
    let original = identify_archive(id, &backed_up)?;
    let files = collect_instance_files_controlled(&directory, Some(state))?;
    // The copy is of what the backup holds: recovery restores the backup, and
    // the old directory is removed only while it still matches the copy.
    if files != backed_up.files {
        return Err(crate::modpacks::pack_update::PLAN_CHANGED.into());
    }
    let staging = StagingDirectory::create(paths.stage.clone())?;
    copy_into_snapshot(&directory, staging.path(), &files, InventoryScope::Instance, Some(state))?;
    Ok(PackStage { token, paths, staging, folder, original, previous_backup, files })
}

/// Checks that the changed copy holds exactly `expected`, records the intent,
/// swaps the copy in like a restore (a failure rolls back from the intent),
/// then removes the previous directory: the automatic backup keeps it.
pub(crate) fn commit_pack_update(
    state: &LauncherState,
    stage: PackStage,
    current: &Instance,
    after: &Instance,
    expected: &[FileRecord],
) -> AppResult<PackUpdateDone> {
    commit_pack_update_using(state, stage, current, after, expected, rename_owned_directory, replace_registered_instance)
}

fn commit_pack_update_using(
    state: &LauncherState,
    stage: PackStage,
    current: &Instance,
    after: &Instance,
    expected: &[FileRecord],
    move_dir: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    replace: impl FnOnce(&LauncherState, &Instance, &Instance) -> Result<(), String>,
) -> AppResult<PackUpdateDone> {
    let PackStage { token, paths, mut staging, folder, original, previous_backup, files } = stage;
    let actual = collect_files_controlled(staging.path(), Some(state))?;
    if !same_files(&actual, expected) {
        return Err(crate::modpacks::pack_update::STAGE_MISMATCH.into());
    }
    // The live directory must still be what was copied and backed up: the
    // intent describes it by that backup, and a change made meanwhile would
    // otherwise be parked out of sight.
    if collect_instance_files_controlled(&paths.live, Some(state))? != files {
        return Err(crate::modpacks::pack_update::PLAN_CHANGED.into());
    }
    let manifest_sha256 = write_pack_manifest(&folder, token, &actual)?;
    // The last point a cancel stops the update; the swap below runs to the end
    // or rolls back from the intent.
    let intent = RestoreIntent {
        token,
        kind: RestoreKind::PackUpdate,
        before: current.clone(),
        after: after.clone(),
        original: Some(original),
        selected: RestoreIdentity { id: token, manifest_sha256 },
    };
    let durable = sync_checkpoint(state).and_then(|()| write_intent(&folder, &intent));
    if let Err(error) = durable {
        let _ = fs::remove_file(pack_manifest_path(&folder, token)?);
        return Err(error.into());
    }
    staging.preserve(); // durable material now belongs to the intent
    swap_instance_directory_using(state, &folder, &intent, &paths, current, after, move_dir, replace)?;
    let _ = fs::remove_file(pack_manifest_path(&folder, token)?);
    // The old directory goes only while it still is what the copy was made
    // from (the backup holds that); a change made during the update stays.
    if directory_present(&paths.previous).unwrap_or(false)
        && collect_instance_files_controlled(&paths.previous, None).is_ok_and(|old| old == files)
    {
        let _ = fs::remove_dir_all(&paths.previous);
    }
    let previous_directory = directory_present(&paths.previous)
        .unwrap_or(true)
        .then(|| paths.previous.to_string_lossy().into_owned());
    Ok(PackUpdateDone { instance: after.clone(), previous_backup, previous_directory })
}

/// The same files, names compared without case.
fn same_files(a: &[FileRecord], b: &[FileRecord]) -> bool {
    let keyed = |records: &[FileRecord]| {
        let mut keys: Vec<_> = records
            .iter()
            .map(|record| (record.relative.to_lowercase(), record.size, record.sha256.to_ascii_lowercase()))
            .collect();
        keys.sort();
        keys
    };
    keyed(a) == keyed(b)
}

/// Removes file lists (and their partial writes) of pack updates that have
/// no intent; called only while no intent is pending.
fn sweep_pack_manifests(folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let token = name
            .strip_prefix("pack-update-")
            .and_then(|rest| rest.strip_suffix(".json"))
            .or_else(|| name.strip_prefix(".pack-update-").and_then(|rest| rest.strip_suffix(".part")));
        if token.is_some_and(|token| Uuid::parse_str(token).is_ok())
            && fs::symlink_metadata(entry.path()).is_ok_and(|stat| stat.is_file())
        {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[tauri::command]
pub async fn export_instance_zip(
    window: tauri::WebviewWindow,
    grants: State<'_, PathGrants>,
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    output_path: String,
) -> crate::errors::AppResult<String> {
    let output_path = grants.consume(PathUse::InstanceArchive, &output_path, &window)?.to_string_lossy().into_owned();
    let _operation = state.operation.lock().await;
    let label = instance(&state.snapshot()?, &instance_id)?.name;
    let task = state
        .control
        .begin_with_display("backup", &instance_id, "导出个人实例备份", &label)?;
    let arc = state.inner().clone();
    let result =
        tokio::task::spawn_blocking(move || export_zip_inner(&arc, &instance_id, &output_path))
            .await
            .unwrap_or_else(|e| Err(format!("导出任务异常：{e}")));
    state
        .control
        .finish(&task, result.as_ref().err().map(String::as_str));
    result.map_err(crate::errors::expected)
}

fn export_zip_inner(
    state: &LauncherState,
    instance_id: &str,
    output_path: &str,
) -> Result<String, String> {
    let value = instance(&state.snapshot()?, instance_id)?;
    let source = stopped_instance_directory(state, &value)?;
    let output = checked_absolute(&crate::storage::to_process_path(Path::new(output_path))?)?;
    if output
        .extension()
        .and_then(|s| s.to_str())
        .is_none_or(|s| !s.eq_ignore_ascii_case("zip"))
    {
        return Err("个人备份导出路径必须以 .zip 结尾".into());
    }
    if crate::processes::directory_tail(&output, &source).is_some() {
        return Err("备份文件不能写入正在备份的实例目录".into());
    }
    let files = collect_instance_files_controlled(&source, Some(state))?;
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
    fn c5_instance_memory_changes_validate_modes_inherit_and_reset() {
        let apply = |changes: Vec<(String, Value)>, start: Instance| {
            let mut row = start;
            replace_metadata(&mut row, &changes).unwrap();
            row
        };
        let start = Instance {
            max_memory_mb: Some(6144), memory_mode: Some("manual".into()), min_memory_mb: Some(1024),
            ..Default::default()
        };
        assert!(runtime_memory_changes(false, None, Some("bogus".into()), None, false).is_err());
        assert!(runtime_memory_changes(false, Some(256), None, None, false).is_err());
        let inherit = apply(runtime_memory_changes(false, Some(4096), Some("inherit".into()), None, false).unwrap(), start.clone());
        assert_eq!((inherit.max_memory_mb, inherit.memory_mode.as_deref()), (None, None),
            "inherit must not leave a max that the legacy rule reads as manual");
        let reset = apply(runtime_memory_changes(true, None, None, None, false).unwrap(), start.clone());
        assert_eq!((reset.max_memory_mb, reset.memory_mode.as_deref(), reset.min_memory_mb), (None, None, None));
        let auto = apply(runtime_memory_changes(false, Some(6144), Some("auto".into()), None, false).unwrap(), start.clone());
        assert_eq!((auto.max_memory_mb, auto.memory_mode.as_deref(), auto.min_memory_mb), (Some(6144), Some("auto"), Some(1024)));
        let cleared = apply(runtime_memory_changes(false, None, None, None, true).unwrap(), start.clone());
        assert_eq!(cleared.min_memory_mb, None);
        let set = apply(runtime_memory_changes(false, None, None, Some(2048), false).unwrap(), start);
        assert_eq!(set.min_memory_mb, Some(2048));
    }

    #[test]
    fn m08_file_inventory_declines_deep_empty_directories() {
        let root = StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/instance-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let leaf = (0..65).fold(root.path().to_owned(), |path, _| path.join("d"));
        std::fs::create_dir_all(leaf).unwrap();
        let result = collect_files(root.path());
        assert!(result.unwrap_err().contains("64"));
    }


    #[test]
    fn clone_is_verified_and_existing_destination_is_preserved() {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/instance-tests");
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        let source = root.join("original");
        let copy = root.join("clone");
        fs::create_dir_all(source.join("saves/world")).unwrap();
        fs::write(source.join("saves/world/level.dat"), b"user world").unwrap();
        fs::create_dir(source.join(".launcher-temp")).unwrap();
        fs::write(source.join(".launcher-temp/world-import-data"), b"world import data").unwrap();
        let records = collect_files(&source).unwrap();
        copy_snapshot(&source, &copy, &records).unwrap();
        assert_eq!(
            fs::read(copy.join(".launcher-temp/world-import-data")).unwrap(),
            b"world import data"
        );
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
    fn c5_final_publisher_keeps_destination_created_after_preflight() {
        let fixture = StagingDirectory::create(Path::new(env!("CARGO_MANIFEST_DIR")).join("target/core-tests").join(Uuid::new_v4().to_string())).unwrap();
        let source = fixture.path().join("owned.part");
        let destination = fixture.path().join("saved.zip");
        fs::write(&source, b"new temporary bytes").unwrap();
        assert!(!destination.exists());
        fs::write(&destination, b"user-owned bytes").unwrap();
        let result = publish_archive_file(&source, &destination);
        assert!(result.is_err(), "the final move itself must refuse replacement");
        assert_eq!(fs::read(&destination).unwrap(), b"user-owned bytes");
        assert_eq!(fs::read(&source).unwrap(), b"new temporary bytes");
    }

    #[test]
    fn archive_output_never_overwrites_existing_user_file() {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/instance-tests");
        let root = parent.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let output = root.join("my-backup.zip");
        fs::write(&output, b"original backup").unwrap();
        assert!(
            write_archive_controlled(&root, &output, &[], "launcher-backup.json", b"{}", None)
                .is_err()
        );
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

    fn with_instance_scratch(
        verify: impl FnOnce(&LauncherState, &Instance, &Path) + Send + 'static,
    ) {
        let root = fixture_folder("a3-scratch");
        let source = root.path().join("game/instances/source");
        let scratch = source.join(".launcher-temp/run-c6792868-d4ed-42d8-a6fc-4251c8726903");
        fs::create_dir_all(&scratch).unwrap();
        fs::write(scratch.join("launcher.args"), b"runtime only").unwrap();
        fs::create_dir_all(source.join("config/.launcher-temp")).unwrap();
        fs::write(source.join("config/.launcher-temp/preserved.txt"), b"user config").unwrap();
        fs::create_dir_all(source.join("saves/world")).unwrap();
        fs::write(source.join("saves/world/level.dat"), b"user world").unwrap();
        let instance = backup_manifest("source", &source, vec![]).instance;
        let state = fixture_state(root.path(), &instance);
        let path = root.path().to_owned();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                tokio::task::spawn_blocking(move || verify(&state, &instance, &path))
                    .await
                    .unwrap()
            });
        assert_eq!(fs::read(scratch.join("launcher.args")).unwrap(), b"runtime only");
    }

    fn assert_instance_archive_omits_runtime_scratch(path: &Path) {
        let expected = ["config/.launcher-temp/preserved.txt", "saves/world/level.dat"];
        let manifest = read_backup(path).unwrap();
        let listed = manifest
            .files
            .iter()
            .map(|record| record.relative.as_str())
            .collect::<Vec<_>>();
        assert_eq!(listed, expected, "manifest inventory");
        let mut archive = ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        let mut names = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().unwrap().to_string())
            .collect::<Vec<_>>();
        names.sort_unstable();
        assert_eq!(
            names,
            [expected[0], "launcher-backup.json", expected[1]],
            "ZIP member inventory"
        );
    }

    #[test]
    fn a3_instance_backup_omits_only_top_level_launcher_scratch() {
        with_instance_scratch(|state, instance, _| {
            let archive = backup_inner(state, instance).unwrap();
            assert_instance_archive_omits_runtime_scratch(Path::new(&archive.path));
        });
    }

    #[test]
    fn a3_personal_backup_omits_only_top_level_launcher_scratch() {
        with_instance_scratch(|state, instance, root| {
            let output = root.join("personal.zip");
            export_zip_inner(state, &instance.id, output.to_str().unwrap()).unwrap();
            assert_instance_archive_omits_runtime_scratch(&output);
        });
    }

    #[test]
    fn a3_clone_omits_only_top_level_launcher_scratch() {
        with_instance_scratch(|state, instance, _| {
            let cloned = clone_inner(state, &instance.id, "Cloned instance").unwrap();
            let destination = Path::new(&cloned.game_directory);
            assert!(!destination.join(".launcher-temp").exists());
            assert_eq!(
                fs::read(destination.join("config/.launcher-temp/preserved.txt")).unwrap(),
                b"user config"
            );
            assert_eq!(
                fs::read(destination.join("saves/world/level.dat")).unwrap(),
                b"user world"
            );
        });
    }

    #[test]
    fn c3_restore_target_refuses_a_running_root() {
        let fixture = crate::storage::SameRootFixture::new();
        assert!(restore_target(&fixture.state, &fixture.instance).is_ok());
        fixture.mark_running();
        let error = restore_target(&fixture.state, &fixture.instance).unwrap_err();
        assert_eq!(error.code, "instance.running");
    }

    #[test]
    fn a4_same_root_blocks_instance_backup_personal_export_and_clone() {
        let fixture = crate::storage::SameRootFixture::new();
        let original = fixture.game.join("user-option.txt");
        fs::write(&original, b"user bytes").unwrap();
        fixture.mark_running();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                tokio::task::spawn_blocking(move || {
                    let output_parent = fixture.root().join("export");
                    let output = output_parent.join("personal.zip");
                    let export = export_zip_inner(
                        &fixture.state,
                        &fixture.instance.id,
                        output.to_str().unwrap(),
                    );
                    let backup = backup_inner(&fixture.state, &fixture.instance);
                    let clone = clone_inner(&fixture.state, &fixture.instance.id, "New clone");
                    for (name, error) in [
                        ("personal export", export.err()),
                        ("instance backup", backup.err()),
                        ("clone", clone.err()),
                    ] {
                        let error = error.unwrap_or_else(|| panic!("{name} accepted a running root"));
                        assert_eq!(crate::errors::expected(error).code, "instance.running", "{name}");
                    }
                    assert!(!output_parent.exists());
                    assert!(!fixture.state.data_dir.join("instance-backups").exists());
                    let siblings = fs::read_dir(fixture.game.parent().unwrap()).unwrap().count();
                    assert_eq!(siblings, 1, "no clone directory or temporary copy");
                    assert_eq!(fs::read(original).unwrap(), b"user bytes");
                })
                .await
                .unwrap()
            });
    }

    #[cfg(windows)]
    #[test]
    fn r4_restore_refuses_the_launcher_profile_and_its_subdirectory() {
        let root = fixture_folder("r4-restore-profile");
        let profile = root.path().join("profile");
        fs::create_dir_all(profile.join("internal")).unwrap();
        for target in [profile.clone(), profile.join("internal")] {
            let instance = Instance {
                id: "restore-example".into(), version_id: "1.20.1".into(),
                game_directory: target.display().to_string(), ..Instance::default()
            };
            let state = LauncherState::test_fixture(
                profile.canonicalize().unwrap(),
                Persisted {
                    config: crate::models::Config {
                        game_directory: root.path().join("game").display().to_string(),
                        ..Default::default()
                    },
                    instances: vec![instance.clone()],
                    ..Default::default()
                },
                crate::storage::test_client(),
            );
            let error = restore_target(&state, &instance).unwrap_err();
            assert!(error.detail.as_deref().is_some_and(|detail| detail.contains("不能原地恢复")));
        }
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


    fn assert_restore_uses_backup_scope_and_preserves_runtime_scratch(step: &str) {
        fn with_scratch(root: &Path, contents: &[u8]) -> PathBuf {
            let directory = root
                .join(".launcher-temp")
                .join(format!("run-{}", Uuid::new_v4()));
            fs::create_dir_all(&directory).unwrap();
            fs::write(directory.join("launcher.args"), contents).unwrap();
            directory.strip_prefix(root).unwrap().join("launcher.args")
        }
        let root = fixture_folder("restore-scratch");
        let paths = RestorePaths::new(&root.path().join("live"), Uuid::new_v4()).unwrap();
        let old = if step == "beforeMove" {
            &paths.live
        } else {
            &paths.previous
        };
        place(old, b"live data");
        let old_scratch = with_scratch(old, b"live scratch");
        let original = collect_instance_files_controlled(old, None).unwrap();
        assert_eq!(original.len(), 1);

        // Legacy selected archives can include top-level scratch. Their
        // exact contents must still be verified and parked on rollback.
        let new = if step == "newPublished" {
            &paths.live
        } else {
            &paths.stage
        };
        place(new, b"legacy selected backup");
        let new_scratch = with_scratch(new, b"legacy scratch");
        let selected = collect_files(new).unwrap();
        assert_eq!(selected.len(), 2);
        {
            fs::write(new.join(&new_scratch), b"changed legacy scratch").unwrap();
            assert!(recover_layout(&paths, Some(&original), &selected).is_err());
            assert_eq!(fs::read(old.join(&old_scratch)).unwrap(), b"live scratch");
            assert_eq!(
                fs::read(new.join(&new_scratch)).unwrap(),
                b"changed legacy scratch"
            );
            fs::write(new.join(&new_scratch), b"legacy scratch").unwrap();
        }

        for _ in 0..2 {
            recover_layout(&paths, Some(&original), &selected)
                .unwrap_or_else(|error| panic!("{step}: {error}"));
        }
        assert_eq!(
            fs::read(paths.live.join(old_scratch)).unwrap(),
            b"live scratch"
        );
        assert_eq!(
            fs::read(paths.stage.join(new_scratch)).unwrap(),
            b"legacy scratch"
        );
        assert_eq!(fs::read(paths.live.join("fixture")).unwrap(), b"live data");
        assert!(!paths.previous.exists());
    }

    #[test]
    fn interrupted_restore_recovers_before_move_with_runtime_scratch() {
        assert_restore_uses_backup_scope_and_preserves_runtime_scratch("beforeMove");
    }

    #[test]
    fn interrupted_restore_recovers_moved_original_with_runtime_scratch() {
        assert_restore_uses_backup_scope_and_preserves_runtime_scratch("oldMoved");
    }

    #[test]
    fn interrupted_restore_rolls_back_published_snapshot_with_runtime_scratch() {
        assert_restore_uses_backup_scope_and_preserves_runtime_scratch("newPublished");
    }

    #[test]
    fn interrupted_restore_checks_scratch_if_legacy_original_journal_included_it() {
        let root = fixture_folder("restore-legacy-original");
        let paths = RestorePaths::new(&root.path().join("live"), Uuid::new_v4()).unwrap();
        place(&paths.previous, b"legacy original");
        let scratch = paths.previous.join(".launcher-temp/legacy-file");
        fs::create_dir(scratch.parent().unwrap()).unwrap();
        fs::write(&scratch, b"legacy original scratch").unwrap();
        let original = collect_files(&paths.previous).unwrap();
        let selected = place(&paths.stage, b"selected backup");
        fs::write(&scratch, b"changed legacy original scratch").unwrap();
        assert!(recover_layout(&paths, Some(&original), &selected).is_err());
        assert!(!paths.live.exists());
        fs::write(scratch, b"legacy original scratch").unwrap();
        recover_layout(&paths, Some(&original), &selected).unwrap();
        assert_eq!(collect_files(&paths.live).unwrap(), original);
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
            kind: RestoreKind::Backup,
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
        let paths = intent_paths(&reopened, &first.before, &live).unwrap();
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

    #[derive(Clone, Copy)]
    enum PublishFailure {
        /// The stage move fails after `before` ran on the live path.
        Stage(fn(&Path)),
        /// Both moves succeed, then the registry update fails.
        Registry,
    }

    /// Restore with injected doubles after a real backup. The archived
    /// registration differs from the live one (its name), so a rollback that
    /// kept the archived registration would be visible.
    fn restore_with_failing_publish(
        prefix: &str,
        failure: PublishFailure,
    ) -> (StagingDirectory, LauncherState, Instance, PathBuf, AppError) {
        let root = fixture_folder(prefix);
        let live = root.path().join("game").join("instances").join("test");
        fs::create_dir_all(live.parent().unwrap()).unwrap();
        let before = backup_manifest("test", &live, place(&live, b"selected backup bytes"));
        let scratch = live.join(".launcher-temp/run-0f5d2f8e-5d0c-4b8e-9d55-0d1c5a3f4e21");
        fs::create_dir_all(&scratch).unwrap();
        fs::write(scratch.join("launcher.args"), b"runtime only").unwrap();
        let registered = before.instance.clone();
        let mut archived = before.instance.clone();
        archived.name = "archived title".into();
        let state = fixture_state(root.path(), &registered);
        let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
        let (state, error) = runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let backup = backup_inner(&state, &archived).unwrap();
                fs::write(live.join("fixture"), b"current bytes").unwrap();
                let error = restore_inner_using(
                    &state,
                    "test",
                    &backup.id,
                    |from, to| match failure {
                        PublishFailure::Stage(before) if to.ends_with("test") => {
                            before(to);
                            Err(std::io::Error::other("injected publish failure"))
                        }
                        _ => fs::rename(from, to),
                    },
                    |state, current, after| match failure {
                        PublishFailure::Registry => Err("injected registry failure".into()),
                        PublishFailure::Stage(_) => replace_registered_instance(state, current, after),
                    },
                )
                .err()
                .expect("the injected publish failure is reported");
                (state, error)
            })
            .await
            .unwrap()
        });
        let live = root.path().join("game/instances/test");
        (root, state, registered, live, error)
    }

    fn assert_rolled_back(state: &LauncherState, registered: &Instance, live: &Path, error: &AppError) {
        assert_eq!(error.code, "backup.restoreRolledBack");
        assert_eq!(error.params.get("kind"), Some(&serde_json::json!("backup")));
        assert_eq!(fs::read(live.join("fixture")).unwrap(), b"current bytes");
        assert_eq!(
            fs::read(live.join(".launcher-temp/run-0f5d2f8e-5d0c-4b8e-9d55-0d1c5a3f4e21/launcher.args")).unwrap(),
            b"runtime only"
        );
        let stage = PathBuf::from(error.params["restoredDirectory"].as_str().unwrap());
        assert_eq!(fs::read(stage.join("fixture")).unwrap(), b"selected backup bytes");
        assert!(read_intent(&backup_folder(state, "test").unwrap()).unwrap().is_none());
        let now = state.snapshot().unwrap().instances[0].clone();
        assert!(same_instance(&now, registered).unwrap(), "the live registration is kept");
        assert_eq!(now.name, registered.name);
    }

    #[test]
    fn f1_publish_failure_rolls_back_with_real_journal_and_runtime_scratch() {
        let (_root, state, registered, live, error) =
            restore_with_failing_publish("f1-rollback", PublishFailure::Stage(|_| {}));
        assert_rolled_back(&state, &registered, &live, &error);
    }

    #[test]
    fn f1_registry_failure_after_both_moves_rolls_back() {
        let (_root, state, registered, live, error) =
            restore_with_failing_publish("f1-registry", PublishFailure::Registry);
        assert_rolled_back(&state, &registered, &live, &error);
    }

    #[test]
    fn f1_incomplete_rollback_is_recovered_from_the_journal_later() {
        // The double leaves an unrelated empty directory at the live name, so
        // the automatic rollback must refuse and keep the intent.
        let (_root, state, instance, live, error) = restore_with_failing_publish(
            "f1-recovery",
            PublishFailure::Stage(|live| fs::create_dir(live).unwrap()),
        );
        assert_eq!(error.code, "backup.restoreRecoveryRequired");
        let folder = backup_folder(&state, "test").unwrap();
        let intent = read_intent(&folder).unwrap().expect("the intent is kept for recovery");
        fs::remove_dir(&live).unwrap();
        let paths = intent_paths(&intent, &instance, &live).unwrap();
        recover_with_state(&state, &folder, &intent, &paths, &instance).unwrap();
        assert_eq!(fs::read(live.join("fixture")).unwrap(), b"current bytes");
        assert!(live.join(".launcher-temp").is_dir());
        assert!(read_intent(&folder).unwrap().is_none());
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
            kind: RestoreKind::Backup,
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

    fn c10_setup(prefix: &str) -> (StagingDirectory, PathBuf, Instance, LauncherState) {
        let fixture = fixture_folder(prefix);
        let live = fixture
            .path()
            .join("game")
            .join("instances")
            .join("test");
        fs::create_dir_all(live.join("config")).unwrap();
        fs::create_dir_all(live.join("mods")).unwrap();
        fs::write(live.join("config/old.txt"), b"old config").unwrap();
        fs::write(live.join("mods/a.jar"), b"old jar").unwrap();
        let registered =
            backup_manifest("test", &live, collect_files(&live).unwrap()).instance;
        let state = fixture_state(fixture.path(), &registered);
        (fixture, live, registered, state)
    }

    fn c10_change_stage(stage: &Path) -> Vec<FileRecord> {
        fs::write(stage.join("mods/a.jar"), b"changed jar").unwrap();
        fs::write(stage.join("mods/new.jar"), b"added mod").unwrap();
        fs::remove_file(stage.join("config/old.txt")).unwrap();
        collect_files(stage).unwrap()
    }

    /// The durable part of `commit_pack_update_using`: a changed stage, its
    /// file list, and the pack-update intent, with the stage preserved.
    fn c10_prepare_intent(
        state: &LauncherState,
        current: &Instance,
    ) -> (PackStage, RestoreIntent) {
        let mut after = current.clone();
        after.name = "pending pack update".into();
        c10_prepare_intent_with(state, current, after)
    }

    fn c10_prepare_intent_with(
        state: &LauncherState,
        current: &Instance,
        after: Instance,
    ) -> (PackStage, RestoreIntent) {
        let mut stage = stage_pack_update(state, current).unwrap();
        let expected = c10_change_stage(stage.path());
        let folder = stage.folder.clone();
        let manifest_sha256 = write_pack_manifest(&folder, stage.token, &expected).unwrap();
        let intent = RestoreIntent {
            token: stage.token,
            kind: RestoreKind::PackUpdate,
            before: current.clone(),
            after,
            original: Some(RestoreIdentity {
                id: stage.original.id,
                manifest_sha256: stage.original.manifest_sha256.clone(),
            }),
            selected: RestoreIdentity {
                id: stage.token,
                manifest_sha256,
            },
        };
        write_intent(&folder, &intent).unwrap();
        stage.staging.preserve();
        (stage, intent)
    }

    fn c10_pack_manifests(folder: &Path) -> Vec<String> {
        fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("pack-update-"))
            .collect()
    }

    #[test]
    fn c10_a_pack_update_swaps_in_the_changed_copy_and_keeps_only_the_backup() {
        let (_fixture, live, registered, state) = c10_setup("c10-swap");
        let original = collect_files(&live).unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .build()
            .unwrap();
        let (state, after, expected) = runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let stage = stage_pack_update(&state, &registered).unwrap();
                let expected = c10_change_stage(stage.path());
                let mut after = registered.clone();
                after.name = "updated pack title".into();
                let done =
                    commit_pack_update(&state, stage, &registered, &after, &expected).unwrap();
                assert!(same_instance(&done.instance, &after).unwrap());
                (state, after, expected)
            })
            .await
            .unwrap()
        });
        assert_eq!(collect_files(&live).unwrap(), expected, "live inventory");
        assert!(
            same_instance(&state.snapshot().unwrap().instances[0], &after).unwrap(),
            "the updated registration is live"
        );
        let folder = backup_folder(&state, "test").unwrap();
        assert!(read_intent(&folder).unwrap().is_none(), "no intent");
        assert!(c10_pack_manifests(&folder).is_empty(), "no pack manifest");
        let mut archives = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("zip"))
            .collect::<Vec<_>>();
        archives.sort();
        assert_eq!(archives.len(), 1, "one automatic backup");
        assert_eq!(read_backup(&archives[0]).unwrap().files, original);
        let siblings = fs::read_dir(live.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(
            !siblings.iter().any(|name| {
                name.starts_with(".restore-") || name.starts_with(".before-restore-")
            }),
            "recovery staging directories are removed: {siblings:?}"
        );
    }

    #[test]
    fn c10_the_copy_leaves_out_runtime_scratch() {
        let (_fixture, live, registered, state) = c10_setup("c10-scratch");
        let scratch = live
            .join(".launcher-temp")
            .join(format!("run-{}", Uuid::new_v4()));
        fs::create_dir_all(&scratch).unwrap();
        fs::write(scratch.join("launcher.args"), b"runtime only").unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .build()
            .unwrap();
        runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let stage = stage_pack_update(&state, &registered).unwrap();
                assert!(
                    !stage.path().join(".launcher-temp").exists(),
                    "a top-level scratch directory is not copied"
                );
                let live_inventory =
                    collect_instance_files_controlled(&live, Some(&state)).unwrap();
                assert_eq!(stage.files, live_inventory);
                assert_eq!(stage.files.len(), 2);
                assert_eq!(collect_files(stage.path()).unwrap(), stage.files);
            })
            .await
            .unwrap()
        });
    }

    #[derive(Clone, Copy, Debug)]
    enum PackFailure {
        ParkLive,
        PublishStage,
        Registry,
    }

    #[test]
    fn c10_a_failure_at_each_step_of_the_swap_rolls_back_to_the_old_instance() {
        let cases = [
            (PackFailure::ParkLive, "park"),
            (PackFailure::PublishStage, "publish"),
            (PackFailure::Registry, "registry"),
        ];
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .build()
            .unwrap();
        for (failure, label) in cases {
            let (_fixture, live, registered, state) =
                c10_setup(&format!("c10-failure-{label}"));
            let original = collect_files(&live).unwrap();
            let expected_registration = registered.clone();
            runtime.block_on(async move {
                tokio::task::spawn_blocking(move || {
                    let stage = stage_pack_update(&state, &registered).unwrap();
                    let stage_path = stage.path().to_owned();
                    let expected = c10_change_stage(&stage_path);
                    let mut after = registered.clone();
                    after.name = "failed pack update".into();
                    let error = match commit_pack_update_using(
                        &state,
                        stage,
                        &registered,
                        &after,
                        &expected,
                        |from, to| match failure {
                            PackFailure::ParkLive if from == live.as_path() => {
                                Err(std::io::Error::other("injected park failure"))
                            }
                            PackFailure::PublishStage if from == stage_path.as_path() => {
                                Err(std::io::Error::other("injected publish failure"))
                            }
                            _ => fs::rename(from, to),
                        },
                        |state, current, after| match failure {
                            PackFailure::Registry => Err("injected registry failure".into()),
                            _ => replace_registered_instance(state, current, after),
                        },
                    ) {
                        Ok(_) => panic!("the injected swap failure is reported"),
                        Err(error) => error,
                    };
                    assert_eq!(error.code, "backup.restoreRolledBack", "{label}: {error:?}");
                    assert_eq!(error.params.get("kind"), Some(&serde_json::json!("packUpdate")), "{label}: the record is a pack update");
                    assert_eq!(
                        collect_files(&live).unwrap(),
                        original,
                        "{label}: the original live files are restored"
                    );
                    assert!(
                        same_instance(
                            &state.snapshot().unwrap().instances[0],
                            &expected_registration
                        )
                        .unwrap(),
                        "{label}: the original registration is kept"
                    );
                    let folder = backup_folder(&state, "test").unwrap();
                    assert!(
                        read_intent(&folder).unwrap().is_none(),
                        "{label}: no intent remains"
                    );
                    assert!(
                        c10_pack_manifests(&folder).is_empty(),
                        "{label}: no manifest remains"
                    );
                    assert_eq!(
                        collect_files(&stage_path).unwrap(),
                        expected,
                        "{label}: the changed copy is preserved"
                    );
                    // A later recovery entry point sees nothing to resume.
                    assert!(read_intent(&folder).unwrap().is_none());
                })
                .await
                .unwrap()
            });
        }
    }

    #[test]
    fn c10_an_interrupted_pack_update_is_recovered_from_its_intent_twice_safely() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .build()
            .unwrap();
        for layout in ["intentOnly", "liveParked", "stagePublished", "registrySwitched"] {
            let (_fixture, live, registered, state) =
                c10_setup(&format!("c10-interrupted-{layout}"));
            let original = collect_files(&live).unwrap();
            runtime.block_on(async move {
                tokio::task::spawn_blocking(move || {
                    let (stage, intent) = c10_prepare_intent(&state, &registered);
                    let stage_path = stage.path().to_owned();
                    let previous = stage.paths.previous.clone();
                    let folder = stage.folder.clone();
                    match layout {
                        "intentOnly" => {}
                        "liveParked" => fs::rename(&live, &previous).unwrap(),
                        "stagePublished" => {
                            fs::rename(&live, &previous).unwrap();
                            fs::rename(&stage_path, &live).unwrap();
                        }
                        "registrySwitched" => {
                            fs::rename(&live, &previous).unwrap();
                            fs::rename(&stage_path, &live).unwrap();
                            replace_registered_instance(&state, &registered, &intent.after).unwrap();
                        }
                        _ => unreachable!("unknown interrupted layout"),
                    }
                    let manifest = pack_manifest_path(&folder, intent.token).unwrap();
                    let manifest_bytes = fs::read(&manifest).unwrap();
                    let current = instance(&state.snapshot().unwrap(), "test").unwrap();
                    let recovered =
                        recover_with_state(&state, &folder, &intent, &stage.paths, &current)
                            .unwrap_or_else(|error| panic!("{layout}: {error}"));
                    assert!(same_instance(&recovered.instance, &registered).unwrap());
                    assert!(
                        same_instance(&state.snapshot().unwrap().instances[0], &registered)
                            .unwrap(),
                        "{layout}: the original registration is restored"
                    );
                    assert_eq!(
                        collect_files(&live).unwrap(),
                        original,
                        "{layout}: the original files are live"
                    );
                    assert!(
                        read_intent(&folder).unwrap().is_none(),
                        "{layout}: no intent remains"
                    );
                    assert!(
                        c10_pack_manifests(&folder).is_empty(),
                        "{layout}: no manifest remains"
                    );
                    // Interrupted again before the intent was cleared: a second
                    // recovery from the same intent leaves the same result.
                    write_intent(&folder, &intent).unwrap();
                    fs::write(&manifest, &manifest_bytes).unwrap();
                    let current = instance(&state.snapshot().unwrap(), "test").unwrap();
                    recover_with_state(&state, &folder, &intent, &stage.paths, &current)
                        .unwrap_or_else(|error| panic!("{layout}, second pass: {error}"));
                    assert_eq!(collect_files(&live).unwrap(), original, "{layout}: a second pass keeps the original");
                    assert!(
                        same_instance(&state.snapshot().unwrap().instances[0], &registered).unwrap(),
                        "{layout}: a second pass keeps the original registration"
                    );
                    assert!(read_intent(&folder).unwrap().is_none(), "{layout}: no intent after the second pass");
                    assert!(c10_pack_manifests(&folder).is_empty(), "{layout}: no manifest after the second pass");
                })
                .await
                .unwrap()
            });
        }
    }

    #[test]
    fn c10_a_tampered_file_list_stops_recovery_and_moves_nothing() {
        let (_fixture, live, registered, state) = c10_setup("c10-tampered");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .build()
            .unwrap();
        runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let (stage, intent) = c10_prepare_intent(&state, &registered);
                let folder = stage.folder.clone();
                let manifest = pack_manifest_path(&folder, intent.token).unwrap();
                let mut bytes = fs::read(&manifest).unwrap();
                bytes[0] ^= 0x01;
                fs::write(&manifest, bytes).unwrap();
                let live_before = collect_files(&live).unwrap();
                let stage_before = collect_files(stage.path()).unwrap();
                let current = instance(&state.snapshot().unwrap(), "test").unwrap();
                let error = match recover_with_state(&state, &folder, &intent, &stage.paths, &current)
                {
                    Ok(_) => panic!("a changed file list must stop recovery"),
                    Err(error) => error,
                };
                assert!(error.contains("更新文件清单已改变"), "{error}");
                assert_eq!(collect_files(&live).unwrap(), live_before);
                assert_eq!(collect_files(stage.path()).unwrap(), stage_before);
                assert!(
                    same_instance(&state.snapshot().unwrap().instances[0], &registered).unwrap()
                );
                assert!(
                    read_intent(&folder).unwrap().is_some(),
                    "the intent is kept for a later retry"
                );
            })
            .await
            .unwrap()
        });
    }

    #[test]
    fn c10_an_intent_written_before_pack_updates_reads_as_a_backup_restore() {
        let folder = fixture_folder("c10-legacy-intent");
        let live = folder.path().join("game/instances/test");
        let manifest = backup_manifest("test", &live, vec![]);
        let intent = RestoreIntent {
            token: Uuid::new_v4(),
            kind: RestoreKind::PackUpdate,
            before: manifest.instance.clone(),
            after: manifest.instance.clone(),
            original: Some(RestoreIdentity {
                id: Uuid::new_v4(),
                manifest_sha256: "original backup".into(),
            }),
            selected: RestoreIdentity {
                id: Uuid::new_v4(),
                manifest_sha256: "selected backup".into(),
            },
        };
        let mut value = serde_json::to_value(&intent).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("kind")
            .expect("the kind was serialized");
        fs::write(
            folder.path().join(RESTORE_INTENT),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let read = read_intent(folder.path()).unwrap().unwrap();
        assert_eq!(read.kind, RestoreKind::Backup);
        assert_eq!(read.token, intent.token);
    }

    #[test]
    fn c10_a_copy_that_differs_from_the_plan_is_not_committed() {
        let (_fixture, live, registered, state) = c10_setup("c10-mismatch");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .build()
            .unwrap();
        runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let original = collect_files(&live).unwrap();
                let stage = stage_pack_update(&state, &registered).unwrap();
                let expected = c10_change_stage(stage.path());
                let incomplete = expected[..expected.len() - 1].to_vec();
                let mut after = registered.clone();
                after.name = "unplanned update".into();
                let error =
                    match commit_pack_update(&state, stage, &registered, &after, &incomplete) {
                        Ok(_) => panic!("a copy that differs from the plan is refused"),
                        Err(error) => error,
                    };
                assert!(
                    error
                        .detail
                        .as_deref()
                        .is_some_and(|detail| detail.contains("更新副本与计划不一致")),
                    "{error:?}"
                );
                assert_eq!(collect_files(&live).unwrap(), original);
                assert!(
                    same_instance(&state.snapshot().unwrap().instances[0], &registered).unwrap()
                );
                let folder = backup_folder(&state, "test").unwrap();
                assert!(read_intent(&folder).unwrap().is_none());
                assert!(c10_pack_manifests(&folder).is_empty());
            })
            .await
            .unwrap()
        });
    }

    #[test]
    fn c10_a_change_made_during_the_swap_keeps_the_old_directory() {
        let (_fixture, live, registered, state) = c10_setup("c10-late");
        let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
        let (done, expected) = runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let stage = stage_pack_update(&state, &registered).unwrap();
                let expected = c10_change_stage(stage.path());
                let parked = live.clone();
                let done = commit_pack_update_using(
                    &state,
                    stage,
                    &registered,
                    &registered,
                    &expected,
                    |from, to| {
                        // Written by something else after the last check.
                        if from == parked.as_path() {
                            fs::write(parked.join("config/late.txt"), b"written during the update")?;
                        }
                        fs::rename(from, to)
                    },
                    replace_registered_instance,
                )
                .unwrap();
                (done, expected)
            })
            .await
            .unwrap()
        });
        let kept = PathBuf::from(done.previous_directory.expect("the old directory is kept"));
        assert_eq!(fs::read(kept.join("config/late.txt")).unwrap(), b"written during the update");
        assert_eq!(collect_files(&_fixture.path().join("game/instances/test")).unwrap(), expected);
    }

    #[test]
    fn c10_a_change_made_before_the_swap_stops_the_update() {
        let (_fixture, live, registered, state) = c10_setup("c10-before-swap");
        let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
        runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let stage = stage_pack_update(&state, &registered).unwrap();
                let stage_path = stage.path().to_owned();
                let expected = c10_change_stage(&stage_path);
                // Written by something else while the update ran.
                fs::write(live.join("config/late.txt"), b"written during the update").unwrap();
                let changed = collect_files(&live).unwrap();
                let mut after = registered.clone();
                after.name = "refused pack update".into();
                let error = match commit_pack_update(&state, stage, &registered, &after, &expected) {
                    Ok(_) => panic!("a live directory that changed is not swapped"),
                    Err(error) => error,
                };
                assert_eq!(error.code, "modpack.planChanged", "{error:?}");
                assert_eq!(collect_files(&live).unwrap(), changed, "the live directory is as the user left it");
                assert!(same_instance(&state.snapshot().unwrap().instances[0], &registered).unwrap());
                let folder = backup_folder(&state, "test").unwrap();
                assert!(read_intent(&folder).unwrap().is_none(), "no intent");
                assert!(c10_pack_manifests(&folder).is_empty(), "no file list");
                assert!(!stage_path.exists(), "the copy is removed");
            })
            .await
            .unwrap()
        });
    }

    #[test]
    fn c10_a_change_made_during_the_backup_stops_the_update() {
        let (_fixture, live, registered, state) = c10_setup("c10-during-backup");
        let changed = live.clone();
        crate::modpacks::pack_update::hook(&live, "backup", move || {
            fs::write(changed.join("config/old.txt"), b"edited while the backup was written").unwrap();
        });
        let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
        runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let error = match stage_pack_update(&state, &registered) {
                    Ok(_) => panic!("a copy that differs from the backup is not made"),
                    Err(error) => error,
                };
                assert_eq!(error.code, "modpack.planChanged", "{error:?}");
                assert_eq!(fs::read(live.join("config/old.txt")).unwrap(), b"edited while the backup was written");
                let siblings: Vec<_> = fs::read_dir(live.parent().unwrap())
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect();
                assert_eq!(siblings, ["test"], "no copy is left");
            })
            .await
            .unwrap()
        });
    }

    #[test]
    fn c10_a_name_written_in_another_case_inside_an_existing_folder_is_committed() {
        let (_fixture, live, registered, state) = c10_setup("c10-case");
        let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
        let expected = runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let stage = stage_pack_update(&state, &registered).unwrap();
                // The new version spells the folder `Config`; the copy's folder is `config`.
                fs::write(stage.path().join("Config/new.toml"), b"new setting").unwrap();
                let mut expected = stage.files.clone();
                expected.push(FileRecord {
                    relative: "Config/new.toml".into(),
                    size: b"new setting".len() as u64,
                    sha256: format!("{:x}", Sha256::digest(b"new setting")),
                });
                expected.sort_by(|a, b| a.relative.cmp(&b.relative));
                commit_pack_update(&state, stage, &registered, &registered, &expected).unwrap();
                expected
            })
            .await
            .unwrap()
        });
        assert_eq!(fs::read(live.join("config/new.toml")).unwrap(), b"new setting");
        assert_eq!(collect_files(&live).unwrap().len(), expected.len());
    }

    #[test]
    fn c10_a_file_list_left_by_an_earlier_update_is_cleared() {
        let (_fixture, _live, registered, state) = c10_setup("c10-sweep");
        let folder = backup_folder(&state, "test").unwrap();
        fs::create_dir_all(&folder).unwrap();
        let stale = folder.join(format!("pack-update-{}.json", Uuid::new_v4()));
        let partial = folder.join(format!(".pack-update-{}.part", Uuid::new_v4()));
        let other = folder.join("pack-update-notes.json");
        for path in [&stale, &partial, &other] {
            fs::write(path, b"[]").unwrap();
        }
        let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
        let done = runtime.block_on(async move {
            tokio::task::spawn_blocking(move || {
                let stage = stage_pack_update(&state, &registered).unwrap();
                let expected = collect_files(stage.path()).unwrap();
                commit_pack_update(&state, stage, &registered, &registered, &expected).unwrap()
            })
            .await
            .unwrap()
        });
        assert!(done.previous_directory.is_none(), "an unchanged old directory is removed");
        assert!(!stale.exists() && !partial.exists(), "the leftovers of an earlier update are gone");
        assert!(other.exists(), "a file that is not one of them stays");
    }

    /// A change written to the registration after the crash and before the
    /// recovery: a rename and a launch time, plus play time when given.
    fn edit_after_crash(state: &LauncherState, played: u64) {
        state
            .update(|data| {
                let value = &mut data.instances[0];
                value.name = "renamed after the crash".into();
                value.last_played = Some("2026-11-22T08:00:00Z".into());
                value.total_play_time += played;
                Ok(())
            })
            .unwrap();
    }

    fn version_of(value: &Instance) -> [&str; 3] {
        [&value.version_id, &value.loader, &value.loader_version]
    }

    /// A restore of an archive from another version, interrupted after the
    /// archive's files were published. `switched` says whether the archived
    /// registration was written before the crash.
    fn backup_intent_after_crash(
        prefix: &str,
        switched: bool,
    ) -> (StagingDirectory, LauncherState, RestorePaths, RestoreIntent, BackupManifest, BackupManifest) {
        let root = fixture_folder(prefix);
        let live = root.path().join("game").join("instances").join("test");
        fs::create_dir_all(live.parent().unwrap()).unwrap();
        let token = Uuid::new_v4();
        let paths = RestorePaths::new(&live, token).unwrap();
        let mut before = backup_manifest("test", &live, place(&paths.previous, b"original files"));
        before.instance.name = "title before the restore".into();
        before.instance.notes = "notes before the restore".into();
        before.instance.total_play_time = 600;
        before.instance.last_played = Some("2026-11-01T10:00:00Z".into());
        let mut after = backup_manifest("test", &live, place(&paths.live, b"selected restored files"));
        after.instance.name = "archived title".into();
        after.instance.notes = "archived notes".into();
        after.instance.version_id = "1.19.2".into();
        after.instance.loader = "forge".into();
        after.instance.loader_version = "43.3.0".into();
        after.instance.total_play_time = 120;
        after.instance.last_played = Some("2026-10-01T10:00:00Z".into());
        let registered = if switched { &after.instance } else { &before.instance };
        let state = fixture_state(root.path(), registered);
        let folder = backup_folder(&state, "test").unwrap();
        fs::create_dir_all(&folder).unwrap();
        let (original, selected) = (Uuid::new_v4(), Uuid::new_v4());
        write_backup_manifest(&folder, original, &before);
        write_backup_manifest(&folder, selected, &after);
        let intent = RestoreIntent {
            token,
            kind: RestoreKind::Backup,
            before: before.instance.clone(),
            after: after.instance.clone(),
            original: Some(identify_archive(original, &before).unwrap()),
            selected: identify_archive(selected, &after).unwrap(),
        };
        write_intent(&folder, &intent).unwrap();
        (root, state, paths, intent, before, after)
    }

    #[test]
    fn a_rename_and_launch_time_after_a_crash_survive_backup_recovery() {
        for switched in [false, true] {
            let label = if switched { "registry switched" } else { "registry not switched" };
            let (_root, state, paths, intent, before, after) =
                backup_intent_after_crash("rename-after-crash-backup", switched);
            edit_after_crash(&state, 0);
            let folder = backup_folder(&state, "test").unwrap();
            let current = instance(&state.snapshot().unwrap(), "test").unwrap();
            let paths = intent_paths(&intent, &current, &paths.live).unwrap();
            let recovered = recover_with_state(&state, &folder, &intent, &paths, &current)
                .unwrap_or_else(|error| panic!("{label}: {error}"));
            let registered = state.snapshot().unwrap().instances[0].clone();
            assert!(same_instance(&recovered.instance, &registered).unwrap(), "{label}");
            assert_eq!(registered.name, "renamed after the crash", "{label}: the rename stays");
            assert_eq!(
                registered.last_played.as_deref(),
                Some("2026-11-22T08:00:00Z"),
                "{label}: the launch time stays"
            );
            // What the restore wrote and nobody changed since is undone.
            assert_eq!(version_of(&registered), version_of(&before.instance), "{label}");
            assert_eq!(registered.notes, before.instance.notes, "{label}");
            assert_eq!(registered.total_play_time, before.instance.total_play_time, "{label}");
            assert_eq!(collect_files(&paths.live).unwrap(), before.files, "{label}: original files live");
            assert_eq!(collect_files(&paths.stage).unwrap(), after.files, "{label}: restored copy kept");
            assert!(read_intent(&folder).unwrap().is_none(), "{label}: no intent remains");
            assert!(pack_update_target(&state, &registered).is_ok(), "{label}: nothing refuses any more");
        }
    }

    #[test]
    fn a_rename_and_launch_time_after_a_crash_survive_pack_update_recovery() {
        let runtime = tokio::runtime::Builder::new_multi_thread().build().unwrap();
        for layout in ["intentOnly", "registrySwitched"] {
            let (_fixture, live, registered, state) =
                c10_setup(&format!("rename-after-crash-pack-{layout}"));
            let original = collect_files(&live).unwrap();
            runtime.block_on(async move {
                tokio::task::spawn_blocking(move || {
                    // A pack update writes only what its files depend on.
                    let mut after = registered.clone();
                    after.version_id = "1.20.4".into();
                    after.loader = "fabric".into();
                    after.loader_version = "0.16.9".into();
                    let (stage, intent) = c10_prepare_intent_with(&state, &registered, after);
                    let folder = stage.folder.clone();
                    if layout == "registrySwitched" {
                        fs::rename(&live, &stage.paths.previous).unwrap();
                        fs::rename(stage.path(), &live).unwrap();
                        replace_registered_instance(&state, &registered, &intent.after).unwrap();
                    }
                    edit_after_crash(&state, 90);
                    let current = instance(&state.snapshot().unwrap(), "test").unwrap();
                    let recovered =
                        recover_with_state(&state, &folder, &intent, &stage.paths, &current)
                            .unwrap_or_else(|error| panic!("{layout}: {error}"));
                    let now = state.snapshot().unwrap().instances[0].clone();
                    assert!(same_instance(&recovered.instance, &now).unwrap(), "{layout}");
                    assert_eq!(now.name, "renamed after the crash", "{layout}: the rename stays");
                    assert_eq!(now.last_played.as_deref(), Some("2026-11-22T08:00:00Z"), "{layout}");
                    assert_eq!(now.total_play_time, registered.total_play_time + 90, "{layout}: play time stays");
                    assert_eq!(version_of(&now), version_of(&registered), "{layout}: the old version is back");
                    assert_eq!(collect_files(&live).unwrap(), original, "{layout}: original files live");
                    assert!(read_intent(&folder).unwrap().is_none(), "{layout}: no intent remains");
                    assert!(c10_pack_manifests(&folder).is_empty(), "{layout}: no manifest remains");
                    assert!(pack_update_target(&state, &now).is_ok(), "{layout}: a new update is allowed");
                })
                .await
                .unwrap()
            });
        }
    }

    #[test]
    fn recovery_still_refuses_a_registration_for_other_files() {
        let (_root, state, paths, intent, _before, _after) =
            backup_intent_after_crash("other-files-after-crash", true);
        state
            .update(|data| {
                data.instances[0].version_id = "1.21.1".into();
                Ok(())
            })
            .unwrap();
        let folder = backup_folder(&state, "test").unwrap();
        let current = instance(&state.snapshot().unwrap(), "test").unwrap();
        let live_files = collect_files(&paths.live).unwrap();
        let error = recover_with_state(&state, &folder, &intent, &paths, &current)
            .err()
            .expect("a version that neither side of the swap has is refused");
        assert!(error.contains("实例已改变"), "{error}");
        assert_eq!(collect_files(&paths.live).unwrap(), live_files, "nothing moved");
        assert!(read_intent(&folder).unwrap().is_some(), "the intent is kept");
    }

    #[test]
    fn a_pending_restore_refuses_launch_and_edits_but_not_its_recovery() {
        let (_fixture, _live, registered, state) = c10_setup("pending-refusal");
        require_no_pending_restore(&state, "test").expect("nothing is pending yet");
        let folder = backup_folder(&state, "test").unwrap();
        fs::create_dir_all(&folder).unwrap();
        let intent = RestoreIntent {
            token: Uuid::new_v4(),
            kind: RestoreKind::PackUpdate,
            before: registered.clone(),
            after: registered.clone(),
            original: None,
            selected: RestoreIdentity { id: Uuid::new_v4(), manifest_sha256: "pending".into() },
        };
        write_intent(&folder, &intent).unwrap();
        let code = |error: String| crate::errors::expected(error).code;
        assert_eq!(code(require_no_pending_restore(&state, "test").unwrap_err()), "instance.restorePending");
        // Every resource writer (install, update, rollback, toggle) checks here.
        let content =
            crate::resources::require_resource_stopped(&state, &registered.version_id, Some("test")).unwrap_err();
        assert_eq!(content.code, "instance.restorePending", "content changes");
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let launch = runtime.block_on(async {
            let task = state.control.reserve_launch(&registered.version_id, Some("test".into())).unwrap();
            crate::minecraft::with_launch_preparation(&state, &task, &registered.version_id, Some("test"), |_| async {
                Err::<(), _>("the launch was prepared".to_owned())
            })
            .await
            .unwrap_err()
        });
        assert_eq!(code(launch), "instance.restorePending", "launch");
        assert!(
            same_instance(&state.snapshot().unwrap().instances[0], &registered).unwrap(),
            "no launch time was written"
        );
        // Recovery, and the report that it is needed, are not blocked by it.
        assert!(restore_target(&state, &registered).is_ok(), "recovery can still run");
        assert_eq!(pack_update_target(&state, &registered).unwrap_err().code, "backup.restoreRecoveryRequired");
        // An unreadable record still counts as pending.
        fs::write(folder.join(RESTORE_INTENT), b"not a restore record").unwrap();
        assert_eq!(code(require_no_pending_restore(&state, "test").unwrap_err()), "instance.restorePending");

        // Edits made through a window run the same check after taking the
        // lock and before they write.
        for (source, function, lock, write) in [
            (include_str!("instances.rs"), "pub async fn update_instance(", "let _operation = state.operation.lock().await;", "state.update(|data| {"),
            (include_str!("instances.rs"), "pub async fn change_instance_loader(", "let _operation = state", "apply_instance_loader_update("),
            (include_str!("content.rs"), "pub async fn import_world(", "let _guard = state.operation.lock().await;", "tokio::task::spawn_blocking"),
            (include_str!("content.rs"), "pub async fn import_local_resources(", "let _guard = state.operation.lock().await;", "tokio::task::spawn_blocking"),
            (include_str!("resources.rs"), "fn recover_resource_update_inner(", "let data = state.snapshot()?;", "resource_transactions::recover_one("),
        ] {
            let (_, body) = source.split_once(function).unwrap();
            let (body, _) = body.split_once("\n}").unwrap();
            let body = crate::storage::executable_source(body);
            let lock = body.find(lock).expect(function);
            let guard = lock + body[lock..].find("require_no_pending_restore(").expect(function);
            let write = body.find(write).expect(function);
            assert!(guard < write, "{function}");
        }
    }

    #[test]
    fn u5_change_instance_loader_resolves_base_version_and_preserves_instance_data() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/instance-tests")
            .join(format!("loader-switch-{}", Uuid::new_v4()));
        let game_dir = root.join("game");
        let inst_dir = game_dir.join("instances/survival");
        fs::create_dir_all(game_dir.join("versions/1.21.1")).unwrap();
        fs::create_dir_all(game_dir.join("versions/fabric-loader-0.16.9-1.21.1")).unwrap();
        fs::create_dir_all(inst_dir.join("saves/world")).unwrap();
        fs::write(inst_dir.join("saves/world/level.dat"), b"world").unwrap();
        fs::write(
            game_dir.join("versions/1.21.1/1.21.1.json"),
            r#"{"id":"1.21.1","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#,
        )
        .unwrap();
        fs::write(
            game_dir.join("versions/fabric-loader-0.16.9-1.21.1/fabric-loader-0.16.9-1.21.1.json"),
            r#"{"id":"fabric-loader-0.16.9-1.21.1","inheritsFrom":"1.21.1","launcherMetadata":{"loader":"fabric"},"libraries":[]}"#,
        )
        .unwrap();
        let mut persisted = Persisted::default();
        persisted.config.game_directory = game_dir.to_string_lossy().into_owned();
        let state = LauncherState::test_fixture(root.join("data"), persisted, crate::storage::test_client());
        let mut initial = build_instance("Survival", "fabric-loader-0.16.9-1.21.1", &inst_dir, "fabric", "0.16.9").unwrap();
        initial.notes = "Keep my notes".into();
        initial.max_memory_mb = Some(4096);
        let registered = register(&state, initial).unwrap();

        assert_eq!(resolve_instance_game_version(&state, &registered).unwrap(), "1.21.1");

        let switched = apply_instance_loader_update(
            &state,
            &registered.id,
            "1.21.1-forge-52.0.10",
            "forge",
            "52.0.10",
        )
        .unwrap();
        assert_eq!(switched.version_id, "1.21.1-forge-52.0.10");
        assert_eq!(switched.loader, "forge");
        assert_eq!(switched.loader_version, "52.0.10");
        assert_eq!(switched.notes, "Keep my notes");
        assert_eq!(switched.max_memory_mb, Some(4096));
        assert_eq!(switched.game_directory, registered.game_directory);
        assert!(inst_dir.join("saves/world/level.dat").is_file());

        let vanilla = apply_instance_loader_update(&state, &registered.id, "1.21.1", "vanilla", "").unwrap();
        assert_eq!(vanilla.version_id, "1.21.1");
        assert_eq!(vanilla.loader, "vanilla");
        assert_eq!(vanilla.loader_version, "");
        assert_eq!(resolve_instance_game_version(&state, &vanilla).unwrap(), "1.21.1");

        assert!(apply_instance_loader_update(&state, &registered.id, "1.21.1", "unknown", "1.0").is_err());

        drop(state);
        fs::remove_dir_all(&root).unwrap();
    }
}
