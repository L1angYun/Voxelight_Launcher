//! Updating a managed Modrinth or CurseForge modpack in place (U1153 b–d,
//! U1152). The installed
//! version's lock is the baseline; the plan compares it with the disk and the
//! new version (`pack_update_plan`), and the apply builds a changed copy of
//! the instance and swaps it in the way a backup restore does, with an
//! automatic backup first and a durable intent for recovery.
use super::*;
use sha2::Sha256;
use crate::pack_update_plan::{self as planner, Action, DiskPath, OnDisk, Plan, Provided, Step};

const LOCK: &str = ".launcher-pack.json";
const MAX_LOCK_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) const UNMANAGED: &str = "此实例不是由启动器在线安装的整合包，无法更新";
pub(crate) const PLAN_CHANGED: &str = "查看更新计划后实例文件发生了变化，请重新查看计划";
pub(crate) const NOT_NEWER: &str = "所选版本不比当前版本新，整合包更新不会降级";
pub(crate) const VERSION_MISMATCH: &str = "所选版本不属于这个整合包";
pub(crate) const DEPENDENCY_DRIFT: &str = "实例的 Minecraft 版本或加载器与整合包记录不一致，无法生成更新计划";
pub(crate) const CONFLICT_CHOICE_INVALID: &str = "冲突选择包含计划之外的文件";
pub(crate) const STAGE_MISMATCH: &str = "更新副本与计划不一致，原实例未改变";
pub(crate) const SHARED_ROOT: &str = "共享游戏根目录或启动器目录中的实例不能原地更新整合包";
pub(crate) const LOCK_INVALID: &str = "新版本的文件记录无法写成有效的锁文件，原实例未改变";
pub(crate) const MANUAL_DOWNLOAD_REQUIRED: &str = "更新需要的部分文件不允许启动器下载，请先手动放入，原实例未改变";
/// The new version's pack ZIP itself may not be downloaded by the launcher; a
/// hand-downloaded ZIP is no update, so the plan refuses instead of listing it.
pub(crate) const PACK_NOT_DOWNLOADABLE: &str = "CurseForge 不允许启动器下载这个整合包版本，无法在线更新到它，原实例未改变";

#[cfg(test)]
type Hook = Box<dyn FnOnce() + Send>;
#[cfg(test)]
static HOOKS: std::sync::Mutex<Vec<(PathBuf, &'static str, Hook)>> = std::sync::Mutex::new(Vec::new());

/// A test's hook for this instance directory at a named point of an update:
/// `stage` before the copy, `backup` after the automatic backup, `commit`
/// before the swap. Nothing outside tests.
pub(crate) fn at(directory: &Path, point: &'static str) {
    #[cfg(test)]
    {
        let hook = {
            let mut hooks = HOOKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            hooks
                .iter()
                .position(|(path, name, _)| path == directory && *name == point)
                .map(|found| hooks.remove(found).2)
        };
        if let Some(hook) = hook {
            hook();
        }
    }
    #[cfg(not(test))]
    let _ = (directory, point);
}

/// Runs `hook` once when an update of `directory` reaches `point`.
#[cfg(test)]
pub(crate) fn hook(directory: &Path, point: &'static str, hook: impl FnOnce() + Send + 'static) {
    HOOKS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push((directory.to_owned(), point, Box::new(hook)));
}

// ---- The lock ------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackLock {
    format_version: u32,
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
    #[serde(default)]
    source: Option<Value>,
    #[serde(default)]
    files: Vec<LockFile>,
    #[serde(default)]
    overrides: Vec<FileRecord>,
    /// Locks written before updates existed have no field: optional files
    /// were left out unless the user asked, so `false`.
    #[serde(default)]
    include_optional: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockFile {
    path: String,
    sha1: String,
    /// Every Modrinth file has one; a CurseForge file may.
    #[serde(default)]
    sha512: Option<String>,
    size: u64,
    /// A CurseForge file's project and file.
    #[serde(default)]
    project_id: Option<u64>,
    #[serde(default)]
    file_id: Option<u64>,
}

/// A lock that names its project and version on Modrinth or CurseForge,
/// checked like any other input from disk.
struct ManagedPack {
    origin: PackOrigin,
    /// The origin's ids as text (CurseForge ids in decimal).
    project_id: String,
    version_id: String,
    version_number: String,
    dependencies: BTreeMap<String, String>,
    include_optional: bool,
    /// Lowercase path → (path, what the installed version provided).
    baseline: BTreeMap<String, (String, Provided)>,
    /// The lock's bytes, part of the plan's fingerprint.
    sha256: String,
}

enum Management {
    /// `noLock`, `legacyLock` (format 1), `noSource` (imported from a file, or
    /// a source this launcher does not update) or `invalidLock`.
    Unmanaged(&'static str),
    Managed(Box<ManagedPack>),
}

fn read_lock(directory: &Path) -> Management {
    let Ok(path) = safe_join(directory, LOCK) else { return Management::Unmanaged("invalidLock") };
    let mut file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Management::Unmanaged("noLock"),
        Err(_) => return Management::Unmanaged("invalidLock"),
    };
    let mut bytes = Vec::new();
    if file.metadata().map_or(true, |stat| !stat.is_file())
        || (&mut file).take(MAX_LOCK_BYTES + 1).read_to_end(&mut bytes).is_err()
        || bytes.len() as u64 > MAX_LOCK_BYTES
    {
        return Management::Unmanaged("invalidLock");
    }
    let Ok(lock) = serde_json::from_slice::<PackLock>(crate::storage::json_body(&bytes)) else {
        return Management::Unmanaged("invalidLock");
    };
    match lock.format_version {
        1 => return Management::Unmanaged("legacyLock"),
        2 => {}
        _ => return Management::Unmanaged("invalidLock"),
    }
    let Some(source) = lock.source.clone() else { return Management::Unmanaged("noSource") };
    // A platform this launcher does not update is no source; a known one that
    // does not read is a broken lock.
    if !matches!(source.get("kind").and_then(Value::as_str), Some("modrinth" | "curseforge")) {
        return Management::Unmanaged("noSource");
    }
    let Ok(origin) = serde_json::from_value::<PackOrigin>(source) else {
        return Management::Unmanaged("invalidLock");
    };
    match managed(lock, origin, &bytes) {
        Ok(pack) => Management::Managed(Box::new(pack)),
        Err(_) => Management::Unmanaged("invalidLock"),
    }
}

/// Every value from the lock is checked before it is used: ids, paths,
/// hashes, sizes and counts.
fn managed(lock: PackLock, origin: PackOrigin, bytes: &[u8]) -> Result<ManagedPack, String> {
    let (project_id, version_id, version_number) = match &origin {
        PackOrigin::Modrinth { project_id, version_id, version_number } => {
            identifier(project_id)?;
            identifier(version_id)?;
            (project_id.clone(), version_id.clone(), version_number.clone())
        }
        PackOrigin::Curseforge { project_id, file_id, version_number } => {
            curseforge_id(*project_id)?;
            curseforge_id(*file_id)?;
            (project_id.to_string(), file_id.to_string(), version_number.clone())
        }
    };
    if version_number.len() > 256 {
        return Err("整合包版本号过长".into());
    }
    dependencies(&lock.dependencies)?;
    if lock.files.len() > 20_000 || lock.overrides.len() > 100_000 {
        return Err("整合包锁文件条目过多".into());
    }
    let mut baseline = BTreeMap::new();
    for file in lock.files {
        archive_relative(&file.path)?;
        let invalid = || "整合包锁文件的文件记录无效".to_string();
        if !valid_hash(&file.sha1, 40) || file.size == 0 || file.size > MAX_ARCHIVE_BYTES {
            return Err(invalid());
        }
        if file.sha512.as_deref().is_some_and(|sha512| !valid_hash(sha512, 128)) {
            return Err(invalid());
        }
        let sha1 = file.sha1.to_ascii_lowercase();
        let provided = match &origin {
            PackOrigin::Modrinth { .. } => {
                let sha512 = file.sha512.as_deref().ok_or_else(invalid)?.to_ascii_lowercase();
                Provided::Download { sha1, sha512, size: file.size }
            }
            // CurseForge describes a file by SHA-1 and size (and its ids).
            PackOrigin::Curseforge { .. } => {
                file.project_id.map(curseforge_id).ok_or_else(invalid)??;
                file.file_id.map(curseforge_id).ok_or_else(invalid)??;
                Provided::Sha1Download { sha1, size: file.size }
            }
        };
        if baseline.insert(file.path.to_lowercase(), (file.path, provided)).is_some() {
            return Err("整合包锁文件路径重复".into());
        }
    }
    for record in lock.overrides {
        archive_relative(&record.relative)?;
        if !valid_hash(&record.sha256, 64) || record.size > MAX_ARCHIVE_BYTES {
            return Err("整合包锁文件的覆盖记录无效".into());
        }
        let provided = Provided::Override { sha256: record.sha256.to_ascii_lowercase(), size: record.size };
        if baseline.insert(record.relative.to_lowercase(), (record.relative, provided)).is_some() {
            return Err("整合包锁文件路径重复".into());
        }
    }
    Ok(ManagedPack {
        origin,
        project_id,
        version_id,
        version_number,
        dependencies: lock.dependencies,
        include_optional: lock.include_optional,
        baseline,
        sha256: format!("{:x}", Sha256::digest(bytes)),
    })
}

/// A CurseForge project or file id: 1..=u32::MAX, as the API uses.
fn curseforge_id(id: u64) -> Result<u64, String> {
    if id == 0 || id > u64::from(u32::MAX) {
        return Err("CurseForge 标识超出范围".into());
    }
    Ok(id)
}

fn instance_directory(state: &LauncherState, instance: &Instance) -> Result<PathBuf, String> {
    let config = state.snapshot()?.config;
    let directory = crate::minecraft::game_directory(&config, &instance.version_id, Some(instance))?;
    checked_absolute(&directory)
}

// ---- Check ---------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PackVersionRef {
    pub version_id: String,
    pub version_number: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackUpdateCheck {
    pub managed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<PackVersionRef>,
    pub newer: Vec<ModpackVersion>,
    pub current_missing: bool,
    /// Whether the installed version included optional files.
    pub include_optional: bool,
}

/// The pack's versions newer than `current`, newest first; all of them when
/// `current` is no longer listed (the bool). A version of another project
/// is refused.
fn newer_versions(current: &str, project: &str, mut versions: Vec<ApiVersion>) -> Result<(Vec<ModpackVersion>, bool), String> {
    if versions.iter().any(|version| version.project_id != project) {
        return Err(VERSION_MISMATCH.into());
    }
    versions.sort_by(|a, b| published(b).cmp(&published(a)).then_with(|| b.date_published.cmp(&a.date_published)));
    let installed = versions.iter().find(|version| version.id == current).map(published);
    let newer = versions
        .iter()
        .filter(|version| version.id != current && installed.as_ref().is_none_or(|installed| published(version) > *installed))
        .map(modpack_version)
        .collect::<Result<_, String>>()?;
    Ok((newer, installed.is_none()))
}

/// When a version was published; an unparsable date sorts first.
fn published(version: &ApiVersion) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(&version.date_published).ok()
}

fn modpack_version(version: &ApiVersion) -> Result<ModpackVersion, String> {
    Ok(ModpackVersion {
        id: version.id.clone(),
        name: version.name.clone(),
        version_number: version.version_number.clone(),
        game_versions: version.game_versions.clone(),
        loaders: version.loaders.clone(),
        date_published: version.date_published.clone(),
        size: primary(version)?.size,
    })
}

#[tauri::command]
pub async fn check_modpack_update(state: State<'_, Arc<LauncherState>>, instance_id: String) -> crate::errors::AppResult<ModpackUpdateCheck> {
    Ok(check(&state, &instance_id).await?)
}

/// An unmanaged instance is reported without asking Modrinth.
async fn check(state: &LauncherState, instance_id: &str) -> Result<ModpackUpdateCheck, String> {
    let instance = instances::instance(&state.snapshot()?, instance_id)?;
    let directory = instance_directory(state, &instance)?;
    let pack = match read_lock(&directory) {
        Management::Unmanaged(reason) => {
            return Ok(ModpackUpdateCheck {
                managed: false,
                reason: Some(reason),
                current: None,
                newer: Vec::new(),
                current_missing: false,
                include_optional: false,
            })
        }
        Management::Managed(pack) => pack,
    };
    let (newer, current_missing) = match &pack.origin {
        PackOrigin::Modrinth { .. } => {
            let versions = fetch_pack_versions(state, &pack.project_id).await?;
            newer_versions(&pack.version_id, &pack.project_id, versions)?
        }
        PackOrigin::Curseforge { project_id, file_id, .. } => curseforge_pack_versions(state, *project_id, Some(*file_id)).await?,
    };
    Ok(ModpackUpdateCheck {
        managed: true,
        reason: None,
        current: Some(PackVersionRef { version_id: pack.version_id, version_number: pack.version_number }),
        newer,
        current_missing,
        include_optional: pack.include_optional,
    })
}

// ---- Plan ----------------------------------------------------------------

/// Where a file of the new version comes from.
enum Source {
    Download(PackFile),
    /// A file of a CurseForge manifest; no url when the launcher may not
    /// download it (the author disallows third-party distribution).
    Curseforge { project_id: u64, file_id: u64, url: Option<String>, sha1: String, size: u64, page: String },
    /// An entry of the archive (the last override layer that has the path).
    Override { entry: String },
}

/// What the new version provides, from its platform.
struct Upstream {
    archive: PathBuf,
    removed: RemoveOnDrop,
    archive_sha512: String,
    to: PackVersionRef,
    origin: PackOrigin,
    name: String,
    dependencies: BTreeMap<String, String>,
    /// Lowercase paths the new version provides as optional files left out.
    optional_paths: HashSet<String>,
    files: BTreeMap<String, (String, Provided)>,
    sources: BTreeMap<String, Source>,
}

/// Everything a plan was made from, so the apply can redo it and compare.
struct Prepared {
    pack: ManagedPack,
    instance: Instance,
    archive: PathBuf,
    _archive_removed: RemoveOnDrop,
    /// The new version.
    to: PackVersionRef,
    origin: PackOrigin,
    name: String,
    dependencies: BTreeMap<String, String>,
    optional_paths: HashSet<String>,
    upstream: BTreeMap<String, (String, Provided)>,
    sources: BTreeMap<String, Source>,
    /// What the plan saw on disk; the copy must still hold it.
    disk: BTreeMap<String, DiskPath>,
    plan: Plan,
    include_optional: bool,
    fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanConflict {
    pub path: String,
    pub reason: planner::ConflictReason,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyChange {
    pub from: BTreeMap<String, String>,
    pub to: BTreeMap<String, String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdatePlan {
    pub from: PackVersionRef,
    pub to: PackVersionRef,
    pub add: usize,
    pub replace: usize,
    pub remove: usize,
    pub unchanged: usize,
    pub kept: Vec<String>,
    /// Removed because the new version marks them optional and optional
    /// files are not included.
    pub optional_removed: Vec<String>,
    pub conflicts: Vec<PlanConflict>,
    pub dropped_intents: Vec<String>,
    pub skipped: Vec<String>,
    pub dependency_change: Option<DependencyChange>,
    pub download_bytes: u64,
    pub include_optional: bool,
    /// Files the new version needs that the launcher may not download.
    pub manual: Vec<ManualDownload>,
    pub fingerprint: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManualDownload {
    /// The plan path (a conflict's choice key).
    pub path: String,
    /// Where to put the downloaded file: `<path>.disabled` keeps a disabled mod disabled.
    pub target: String,
    pub project_url: String,
    /// The new version of a conflict: needed only if it is chosen.
    pub conflict: bool,
}

impl Prepared {
    /// The plan's removals that the new version would provide as optional
    /// files: a lock written before the choice was recorded reads as "not
    /// included", so its optional files would go unless the user ticks it.
    fn optional_removed(&self) -> Vec<String> {
        if self.include_optional {
            return Vec::new();
        }
        self.plan
            .steps
            .iter()
            .filter(|step| step.action == Action::Remove && self.optional_paths.contains(&step.path.to_lowercase()))
            .map(|step| step.path.clone())
            .collect()
    }

    /// The project page of a step's file when the launcher may not download it.
    /// A removal never has one: the planner removes only paths the new version
    /// does not provide, and every source is a path it provides.
    fn manual_page(&self, step: &Step) -> Option<&str> {
        match self.sources.get(&step.path.to_lowercase()) {
            Some(Source::Curseforge { url: None, page, .. }) => Some(page),
            _ => None,
        }
    }

    /// Every file the plan (or a conflict's new version) needs that the
    /// launcher may not download.
    fn manual(&self) -> Vec<ManualDownload> {
        let entry = |step: &Step, conflict: bool| {
            self.manual_page(step).map(|page| ManualDownload {
                path: step.path.clone(),
                target: step_name(step),
                project_url: page.to_owned(),
                conflict,
            })
        };
        let planned = self.plan.steps.iter().filter_map(|step| entry(step, false));
        let chosen = self.plan.conflicts.iter().filter_map(|conflict| entry(&conflict.upstream, true));
        planned.chain(chosen).collect()
    }

    fn summary(&self) -> PackUpdatePlan {
        let count = |action| self.plan.steps.iter().filter(|step| step.action == action).count();
        let download_bytes = self
            .plan
            .steps
            .iter()
            .filter(|step| step.action != Action::Remove)
            .filter_map(|step| match self.upstream.get(&step.path.to_lowercase()) {
                Some((_, Provided::Download { size, .. } | Provided::Sha1Download { size, .. })) => Some(*size),
                _ => None,
            })
            .sum();
        PackUpdatePlan {
            from: PackVersionRef { version_id: self.pack.version_id.clone(), version_number: self.pack.version_number.clone() },
            to: self.to.clone(),
            add: count(Action::Add),
            replace: count(Action::Replace),
            remove: count(Action::Remove),
            unchanged: self.plan.unchanged,
            kept: self.plan.kept.clone(),
            optional_removed: self.optional_removed(),
            conflicts: self.plan.conflicts.iter().map(|conflict| PlanConflict { path: conflict.path.clone(), reason: conflict.reason }).collect(),
            dropped_intents: self.plan.dropped_intents.clone(),
            skipped: self.plan.skipped.clone(),
            dependency_change: (self.pack.dependencies != self.dependencies)
                .then(|| DependencyChange { from: self.pack.dependencies.clone(), to: self.dependencies.clone() }),
            download_bytes,
            include_optional: self.include_optional,
            manual: self.manual(),
            fingerprint: self.fingerprint.clone(),
        }
    }
}

/// The lock's dependencies must still describe the instance: an update
/// planned from a baseline the instance no longer follows could not be right.
fn require_dependencies_match(state: &LauncherState, instance: &Instance, recorded: &BTreeMap<String, String>) -> Result<(), String> {
    let (minecraft, loader) = dependencies(recorded)?;
    let root = crate::processes::configured_game_root(Path::new(&state.snapshot()?.config.game_directory))?;
    let (installed, _) = crate::resources::version_context(&root, &instance.version_id).map_err(|_| DEPENDENCY_DRIFT.to_string())?;
    let loader_matches = match &loader {
        None => instance.loader.is_empty() || instance.loader == "vanilla",
        Some((kind, version)) => instance.loader == *kind && instance.loader_version == *version,
    };
    if installed != minecraft || !loader_matches {
        return Err(DEPENDENCY_DRIFT.into());
    }
    Ok(())
}

/// What the new version provides after the optional filter: downloads from
/// its index, then the override layers (the later layer wins a path).
fn upstream_view(archive: &Path, index: &PackIndex, optional: bool) -> Result<(BTreeMap<String, (String, Provided)>, BTreeMap<String, Source>), String> {
    let (selected, _) = pack_selection(index, optional)?;
    let mut upstream = BTreeMap::new();
    let mut sources = BTreeMap::new();
    for file in selected {
        let key = file.path.to_lowercase();
        let provided = Provided::Download {
            sha1: file.hashes["sha1"].to_ascii_lowercase(),
            sha512: file.hashes["sha512"].to_ascii_lowercase(),
            size: file.file_size,
        };
        upstream.insert(key.clone(), (file.path.clone(), provided));
        sources.insert(key, Source::Download(file.clone()));
    }
    override_layers(archive, &["overrides/".to_owned(), "client-overrides/".to_owned()], &mut upstream, &mut sources)?;
    Ok((upstream, sources))
}

/// The archive's override layers in order (a later layer wins a path), over
/// what the version's downloads provide.
fn override_layers(
    archive: &Path,
    prefixes: &[String],
    upstream: &mut BTreeMap<String, (String, Provided)>,
    sources: &mut BTreeMap<String, Source>,
) -> Result<(), String> {
    let mut zip = ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    for prefix in prefixes {
        for n in 0..zip.len() {
            let mut entry = zip.by_index(n).map_err(|e| e.to_string())?;
            let name = entry.name().map_err(|e| e.to_string())?.into_owned();
            let Some(relative) = name.strip_prefix(prefix.as_str()).map(|relative| relative.trim_end_matches('/')) else { continue };
            if relative.is_empty() || entry.is_dir() {
                continue;
            }
            archive_relative(relative)?;
            let mut hash = Sha256::new();
            let size = std::io::copy(&mut (&mut entry).take(MAX_ARCHIVE_BYTES + 1), &mut HashWriter(&mut hash))
                .map_err(|_| "ZIP 文件读取或 CRC 校验失败")?;
            if size != entry.size() {
                return Err("ZIP 条目大小不一致".into());
            }
            let key = relative.to_lowercase();
            upstream.insert(key.clone(), (relative.to_owned(), Provided::Override { sha256: format!("{:x}", hash.finalize()), size }));
            sources.insert(key, Source::Override { entry: name });
        }
    }
    Ok(())
}

struct HashWriter<'a>(&'a mut Sha256);

impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// The hashes of what is at `path`: a regular file; anything else (a
/// folder, a link) is something the plan must not touch, so it matches no
/// version and makes the path a conflict.
fn on_disk(path: &Path) -> Result<Option<OnDisk>, String> {
    let stat = match fs::symlink_metadata(path) {
        Ok(stat) => stat,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !stat.is_file() || crate::resources::linked(&stat) {
        return Ok(Some(OnDisk { sha1: String::new(), sha512: String::new(), sha256: String::new(), size: u64::MAX }));
    }
    let (sha1, sha512, size) = hashes(path)?;
    Ok(Some(OnDisk { sha1, sha512, sha256: instances::sha256(path)?, size }))
}

fn disk_view(
    state: &LauncherState,
    directory: &Path,
    baseline: &BTreeMap<String, (String, Provided)>,
    upstream: &BTreeMap<String, (String, Provided)>,
) -> Result<BTreeMap<String, DiskPath>, String> {
    let mut disk = BTreeMap::new();
    for (key, (path, _)) in baseline.iter().chain(upstream.iter()) {
        if disk.contains_key(key) || planner::left_alone(key) {
            continue;
        }
        instances::sync_checkpoint(state)?;
        let enabled = on_disk(&safe_join(directory, path)?)?;
        // The path itself is valid, so only a name too long for the launcher
        // to have written can be refused: nothing is there.
        let disabled = match safe_join(directory, &format!("{path}.disabled")) {
            Ok(sibling) => on_disk(&sibling)?,
            Err(_) => None,
        };
        disk.insert(key.clone(), DiskPath { enabled, disabled });
    }
    Ok(disk)
}

fn fingerprint(prepared: &Prepared, disk: &BTreeMap<String, DiskPath>, archive_sha512: &str) -> Result<String, String> {
    let disk: Vec<_> = disk
        .iter()
        .map(|(key, entry)| {
            let side = |file: &Option<OnDisk>| file.as_ref().map(|file| (file.sha256.clone(), file.size));
            (key.clone(), side(&entry.enabled), side(&entry.disabled))
        })
        .collect();
    let input = json!({
        "instance": prepared.instance,
        "lock": prepared.pack.sha256,
        "archive": archive_sha512,
        "includeOptional": prepared.include_optional,
        "disk": disk,
        "plan": prepared.plan,
    });
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(&input).map_err(|e| e.to_string())?)))
}

/// Everything about an update that can be known without changing anything.
async fn prepare(state: &Arc<LauncherState>, instance_id: &str, new_version_id: &str, include_optional: Option<bool>) -> Result<Prepared, String> {
    identifier(new_version_id)?;
    let instance = instances::instance(&state.snapshot()?, instance_id)?;
    let directory = instance_directory(state, &instance)?;
    require_no_resource_transaction(&directory)?;
    let pack = match read_lock(&directory) {
        Management::Managed(pack) => *pack,
        Management::Unmanaged(_) => return Err(UNMANAGED.into()),
    };
    require_dependencies_match(state, &instance, &pack.dependencies)?;
    let include_optional = include_optional.unwrap_or(pack.include_optional);
    let upstream = match &pack.origin {
        PackOrigin::Modrinth { .. } => modrinth_upstream(state, &pack, new_version_id, include_optional).await?,
        PackOrigin::Curseforge { project_id, file_id, .. } => {
            curseforge_upstream(state, *project_id, *file_id, new_version_id, include_optional).await?
        }
    };
    let blocking = (state.clone(), directory.clone(), pack.baseline.clone(), upstream.files.clone());
    let disk = tokio::task::spawn_blocking(move || {
        let (state, directory, baseline, files) = blocking;
        disk_view(&state, &directory, &baseline, &files)
    })
    .await
    .map_err(|error| error.to_string())??;
    let plan = planner::plan(&planner::PlanInput { baseline: &pack.baseline, upstream: &upstream.files, disk: &disk });
    let Upstream { archive, removed, archive_sha512, to, origin, name, dependencies, optional_paths, files, sources } = upstream;
    let mut prepared = Prepared {
        pack,
        instance,
        archive,
        _archive_removed: removed,
        to,
        origin,
        name,
        dependencies,
        optional_paths,
        upstream: files,
        sources,
        disk,
        plan,
        include_optional,
        fingerprint: String::new(),
    };
    prepared.fingerprint = fingerprint(&prepared, &prepared.disk, &archive_sha512)?;
    Ok(prepared)
}

/// The new version from Modrinth: its index and override layers.
async fn modrinth_upstream(state: &Arc<LauncherState>, pack: &ManagedPack, new_version_id: &str, include_optional: bool) -> Result<Upstream, String> {
    let api = client(state, false)?;
    let base = modrinth_api();
    let version: ApiVersion = json_response(api.get(format!("{base}/version/{new_version_id}"))).await?;
    if version.project_id != pack.project_id || version.id != new_version_id {
        return Err(VERSION_MISMATCH.into());
    }
    if version.id == pack.version_id {
        return Err(NOT_NEWER.into());
    }
    if version.version_number.len() > 256 {
        return Err("整合包版本号过长".into());
    }
    // An installed version Modrinth no longer has (404 or 410) cannot be
    // compared, so any other version of the pack is allowed (the check says
    // so); any other failure stops the plan.
    let installed = json_response_or_missing::<ApiVersion>(api.get(format!("{base}/version/{}", pack.version_id))).await?;
    if let Some(installed) = installed {
        if installed.project_id != pack.project_id {
            return Err(VERSION_MISMATCH.into());
        }
        if published(&version) <= published(&installed) {
            return Err(NOT_NEWER.into());
        }
    }
    let file = primary(&version)?;
    if !file.filename.to_ascii_lowercase().ends_with(".mrpack") {
        return Err(NOT_MRPACK.into());
    }
    let downloads = checked_absolute(&state.data_dir.join("pack-downloads"))?;
    fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    sweep_pack_downloads(&downloads, std::time::Duration::from_secs(24 * 60 * 60));
    let archive = safe_join(&downloads, &format!("{}.mrpack", uuid::Uuid::new_v4()))?;
    let removed = RemoveOnDrop(archive.clone());
    let received = fetch_verified(state, &[file.url.clone()], &archive, file.size, &file.hashes).await?;
    let blocking = (state.clone(), archive.clone());
    let (index, files, sources) = tokio::task::spawn_blocking(move || {
        let (state, archive) = blocking;
        inspect_zip_limits_controlled(&archive, MAX_ARCHIVE_BYTES, MAX_PACK_BYTES, MAX_ARCHIVE_BYTES, Some(&state))?;
        let index: PackIndex = zip_json(&archive, "modrinth.index.json")?;
        let (files, sources) = upstream_view(&archive, &index, include_optional)?;
        Ok::<_, String>((index, files, sources))
    })
    .await
    .map_err(|error| error.to_string())??;
    let optional_paths = index
        .files
        .iter()
        .filter(|file| file.env.as_ref().and_then(|env| env.get("client")).is_some_and(|value| value == "optional"))
        .map(|file| file.path.to_lowercase())
        .collect();
    Ok(Upstream {
        archive,
        removed,
        archive_sha512: received.sha512,
        to: PackVersionRef { version_id: version.id.clone(), version_number: version.version_number.clone() },
        origin: PackOrigin::Modrinth {
            project_id: pack.project_id.clone(),
            version_id: version.id.clone(),
            version_number: version.version_number.clone(),
        },
        name: index.name,
        dependencies: index.dependencies,
        optional_paths,
        files,
        sources,
    })
}

/// The new version from CurseForge: a release file of the same modpack,
/// newer than the installed one (any release when CurseForge no longer has
/// the installed file), its manifest resolved through the API, and its
/// override layer. Every request belongs to the task.
async fn curseforge_upstream(
    state: &Arc<LauncherState>,
    project_id: u64,
    installed: u64,
    new_version_id: &str,
    include_optional: bool,
) -> Result<Upstream, String> {
    let new = new_version_id.parse::<u64>().ok().filter(|id| curseforge_id(*id).is_ok()).ok_or(VERSION_MISMATCH)?;
    if new == installed {
        return Err(NOT_NEWER.into());
    }
    let session = crate::curseforge::CfSession::new(state, None)?;
    let (_, file, url) = curseforge_pack_file(state, &session, project_id, new).await.map_err(|error| {
        if error.starts_with(MANUAL_DOWNLOAD) {
            PACK_NOT_DOWNLOADABLE.to_owned()
        } else {
            error
        }
    })?;
    let current = match crate::curseforge::in_task(state, crate::curseforge::pack_file(&session, project_id, installed)).await {
        Ok(current) => Some(current),
        Err(error) if error == crate::curseforge::NOT_FOUND => None,
        Err(error) => return Err(cf_platform(error)),
    };
    if current.as_ref().is_some_and(|current| !crate::curseforge::pack_newer(&file, current)) {
        return Err(NOT_NEWER.into());
    }
    let sha1 = file.sha1.clone().ok_or(VERSION_MISMATCH)?;
    let downloads = checked_absolute(&state.data_dir.join("pack-downloads"))?;
    fs::create_dir_all(&downloads).map_err(|e| e.to_string())?;
    sweep_pack_downloads(&downloads, std::time::Duration::from_secs(24 * 60 * 60));
    let archive = safe_join(&downloads, &format!("{}.zip", uuid::Uuid::new_v4()))?;
    let removed = RemoveOnDrop(archive.clone());
    let received = fetch_verified(state, &[url], &archive, file.size, &BTreeMap::from([("sha1".to_owned(), sha1)])).await?;
    let blocking = (state.clone(), archive.clone());
    let manifest = tokio::task::spawn_blocking(move || {
        let (state, archive) = blocking;
        inspect_zip_limits_controlled(&archive, MAX_ARCHIVE_BYTES, MAX_PACK_BYTES, MAX_ARCHIVE_BYTES, Some(&state))?;
        let manifest: CurseManifest = zip_json(&archive, "manifest.json")?;
        if manifest.manifest_type != "minecraftModpack" || manifest.manifest_version != 1 {
            return Err("不支持此 CurseForge 清单格式".to_owned());
        }
        Ok(manifest)
    })
    .await
    .map_err(|error| error.to_string())??;
    let dependencies = curse_dependencies(&manifest.minecraft)?;
    // On this task: the API calls and their test endpoints belong to it.
    let (resolved, optional_paths) = resolve_manifest(state, &session, &manifest, include_optional).await?;
    let mut files = BTreeMap::new();
    let mut sources = BTreeMap::new();
    for entry in resolved {
        let key = entry.path.to_lowercase();
        files.insert(key.clone(), (entry.path.clone(), Provided::Sha1Download { sha1: entry.sha1.clone(), size: entry.size }));
        sources.insert(
            key,
            Source::Curseforge {
                project_id: entry.project_id,
                file_id: entry.file_id,
                url: entry.download,
                sha1: entry.sha1,
                size: entry.size,
                page: entry.page,
            },
        );
    }
    let prefix = manifest.overrides.trim_end_matches('/').to_owned();
    let layer = (archive.clone(), prefix, files, sources);
    let (files, sources) = tokio::task::spawn_blocking(move || {
        let (archive, prefix, mut files, mut sources) = layer;
        if !prefix.is_empty() {
            archive_relative(&prefix)?;
            override_layers(&archive, &[format!("{prefix}/")], &mut files, &mut sources)?;
        }
        Ok::<_, String>((files, sources))
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(Upstream {
        archive,
        removed,
        archive_sha512: received.sha512,
        to: PackVersionRef { version_id: new.to_string(), version_number: file.label.clone() },
        origin: PackOrigin::Curseforge { project_id, file_id: new, version_number: file.label },
        name: manifest.name,
        dependencies,
        optional_paths,
        files,
        sources,
    })
}

#[tauri::command]
pub async fn plan_modpack_update(
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    new_version_id: String,
    include_optional: Option<bool>,
) -> crate::errors::AppResult<PackUpdatePlan> {
    // A plan downloads the new version: a task of its own, which the user can
    // pause or cancel and no other task's cancel reaches.
    let _operation = state.operation.lock().await;
    let label = instances::instance(&state.snapshot()?, &instance_id)?.name;
    let task = state.control.begin_with_display("modpack-update-plan", &instance_id, "查看整合包更新计划", &label)?;
    let result = prepare(state.inner(), &instance_id, &new_version_id, include_optional).await.map(|prepared| prepared.summary());
    state.control.finish(&task, result.as_ref().err().map(String::as_str));
    Ok(result?)
}

/// No resource transaction of the instance waits for recovery: an
/// interrupted one can leave a content folder parked beside its journal (so
/// missing), which a plan would read as the user's deletions.
fn require_no_resource_transaction(directory: &Path) -> Result<(), String> {
    for folder in ["mods", "resourcepacks", "shaderpacks"] {
        crate::resources::resource_transactions::require_no_pending(&safe_join(directory, folder)?)?;
    }
    Ok(())
}

/// Each path the plan looked at holds in the copy what it held when the plan
/// was made, the file and its `.disabled` sibling: a change made in between
/// would otherwise be overwritten, or kept, without being planned.
fn require_copy_matches(disk: &BTreeMap<String, DiskPath>, copied: &[FileRecord]) -> Result<(), String> {
    let copied: BTreeMap<String, &FileRecord> = copied.iter().map(|record| (record.relative.to_lowercase(), record)).collect();
    for (key, entry) in disk {
        for (name, seen) in [(key.clone(), &entry.enabled), (format!("{key}.disabled"), &entry.disabled)] {
            let same = match (seen, copied.get(&name)) {
                (None, None) => true,
                // A folder or link (no hashes): not a file of the copy.
                (Some(file), None) => file.size == u64::MAX,
                (Some(file), Some(record)) => {
                    file.size != u64::MAX && file.size == record.size && file.sha256.eq_ignore_ascii_case(&record.sha256)
                }
                (None, Some(_)) => false,
            };
            if !same {
                return Err(PLAN_CHANGED.into());
            }
        }
    }
    Ok(())
}

// ---- Apply ---------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictChoice {
    pub path: String,
    pub use_upstream: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdateResult {
    pub instance: Instance,
    pub previous_backup: instances::InstanceBackup,
    /// The old directory, kept when it changed while the update ran.
    pub previous_directory: Option<String>,
}

/// No step writes a file the launcher may not download: the user puts it in
/// place first, and the next plan finds it unchanged.
fn require_downloadable(prepared: &Prepared, steps: &[Step]) -> Result<(), String> {
    if steps.iter().any(|step| prepared.manual_page(step).is_some()) {
        return Err(MANUAL_DOWNLOAD_REQUIRED.into());
    }
    Ok(())
}

/// The steps to take: the plan's, plus the new version for each conflict the
/// user chose it for. A choice must name a conflict of this plan.
fn chosen_steps(plan: &Plan, choices: &[ConflictChoice]) -> Result<Vec<Step>, String> {
    let mut steps = plan.steps.clone();
    let mut seen = HashSet::new();
    for choice in choices {
        let key = choice.path.to_lowercase();
        let conflict = plan
            .conflicts
            .iter()
            .find(|conflict| conflict.path.to_lowercase() == key)
            .ok_or(CONFLICT_CHOICE_INVALID)?;
        if !seen.insert(key) {
            return Err(CONFLICT_CHOICE_INVALID.into());
        }
        if choice.use_upstream {
            steps.push(conflict.upstream.clone());
        }
    }
    Ok(steps)
}

fn step_name(step: &Step) -> String {
    if step.disabled { format!("{}.disabled", step.path) } else { step.path.clone() }
}

/// Writes one archive entry to a new file, checking its size and hash; the
/// file appears under its name only once it is complete and verified.
fn extract_entry(archive: &Path, entry: &str, target: &Path, expected_sha256: &str, expected_size: u64) -> Result<(), String> {
    let mut zip = ZipArchive::new(fs::File::open(archive).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut entry = zip.by_name(entry).map_err(|_| "整合包缺少计划中的覆盖文件")?;
    let parent = target.parent().ok_or("覆盖文件目标缺少父目录")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".pack-update-{}.part", uuid::Uuid::new_v4()));
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
    let _removed = RemoveOnDrop(temporary.clone());
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 128 * 1024];
    let mut size = 0u64;
    loop {
        let count = entry.read(&mut buffer).map_err(|_| "ZIP 文件读取或 CRC 校验失败")?;
        if count == 0 {
            break;
        }
        size += count as u64;
        if size > expected_size {
            return Err("覆盖文件大小与计划不一致".into());
        }
        hash.update(&buffer[..count]);
        output.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
    }
    if size != expected_size || format!("{:x}", hash.finalize()) != expected_sha256 {
        return Err("覆盖文件内容与计划不一致".into());
    }
    output.sync_all().map_err(|e| e.to_string())?;
    drop(output);
    crate::instances::publish_archive_file(&temporary, target).map_err(|_| STAGE_MISMATCH.to_string())
}

/// The new version's lock: what it provides, whatever the disk now holds, so
/// a file the user kept stays a user change for the next update.
fn write_update_lock(
    stage: &Path,
    prepared: &Prepared,
) -> Result<FileRecord, String> {
    let mut files = Vec::new();
    let mut overrides = Vec::new();
    for (key, (path, provided)) in &prepared.upstream {
        if planner::left_alone(key) {
            continue;
        }
        match provided {
            Provided::Download { sha1, sha512, size } => files.push(json!({"path": path, "sha1": sha1, "sha512": sha512, "size": size})),
            Provided::Sha1Download { sha1, size } => {
                let Some(Source::Curseforge { project_id, file_id, .. }) = prepared.sources.get(key) else {
                    return Err(LOCK_INVALID.into());
                };
                files.push(json!({"path": path, "sha1": sha1, "size": size, "projectId": project_id, "fileId": file_id}));
            }
            Provided::Override { sha256, size } => overrides.push(FileRecord { relative: path.clone(), size: *size, sha256: sha256.clone() }),
        }
    }
    let origin = prepared.origin.clone();
    let payload = json!({
        "formatVersion": 2,
        "name": prepared.name,
        "dependencies": prepared.dependencies,
        "files": files,
        "overrides": overrides,
        "source": origin,
        "includeOptional": prepared.include_optional,
    });
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?;
    // Read back by the reader's rules: a lock it refuses would leave the
    // instance unmanaged after a successful update.
    let reread = serde_json::from_slice::<PackLock>(&bytes).map_err(|_| LOCK_INVALID)?;
    if bytes.len() as u64 > MAX_LOCK_BYTES
        || managed(reread, origin, &bytes).is_err()
    {
        return Err(LOCK_INVALID.into());
    }
    let path = safe_join(stage, LOCK)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .and_then(|mut file| file.write_all(&bytes).and_then(|()| file.sync_all()))
        .map_err(|e| e.to_string())?;
    Ok(FileRecord { relative: LOCK.into(), size: bytes.len() as u64, sha256: format!("{:x}", Sha256::digest(&bytes)) })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn apply_modpack_update(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    instance_id: String,
    new_version_id: String,
    include_optional: bool,
    fingerprint: String,
    choices: Vec<ConflictChoice>,
) -> crate::errors::AppResult<PackUpdateResult> {
    let _operation = state.operation.lock().await;
    let label = instances::instance(&state.snapshot()?, &instance_id)?.name;
    let task = state.control.begin_with_display("modpack-update", &instance_id, "更新整合包", &label)?;
    let result = apply_inner(Some(&app), state.inner(), &instance_id, &new_version_id, include_optional, &fingerprint, &choices).await;
    state.control.finish(&task, result.as_ref().err().map(|error| error.detail.as_deref().unwrap_or(&error.code)));
    result
}

/// The whole update, in the order its guards need: the same-root check and
/// no unfinished restore, no pending resource transaction, the plan
/// unchanged, then the backup, the changed copy and the swap.
async fn apply_inner(
    app: Option<&AppHandle>,
    state: &Arc<LauncherState>,
    instance_id: &str,
    new_version_id: &str,
    include_optional: bool,
    fingerprint: &str,
    choices: &[ConflictChoice],
) -> crate::errors::AppResult<PackUpdateResult> {
    let current = instances::instance(&state.snapshot()?, instance_id)?;
    let live = instances::pack_update_target(state, &current)?;
    require_no_resource_transaction(&live)?;
    let prepared = prepare(state, instance_id, new_version_id, Some(include_optional)).await?;
    if prepared.fingerprint != fingerprint || prepared.instance.id != current.id {
        return Err(PLAN_CHANGED.into());
    }
    let steps = chosen_steps(&prepared.plan, choices)?;
    require_downloadable(&prepared, &steps)?;
    let dependency_change = prepared.pack.dependencies != prepared.dependencies;
    if dependency_change {
        // The new loader or version is installed into the configured root.
        crate::minecraft::require_install_root_stopped(state, &state.snapshot()?.config)?;
    }
    at(&live, "stage");
    let staged_state = state.clone();
    let staged_current = current.clone();
    let stage = tokio::task::spawn_blocking(move || instances::stage_pack_update(&staged_state, &staged_current))
        .await
        .map_err(|error| crate::errors::AppError::internal(error.to_string()))??;
    require_copy_matches(&prepared.disk, &stage.files)?;
    let mut expected: BTreeMap<String, FileRecord> =
        stage.files.iter().map(|record| (record.relative.to_lowercase(), record.clone())).collect();
    for step in &steps {
        state.control.checkpoint().await?;
        let name = step_name(step);
        let target = safe_join(stage.path(), &name)?;
        if matches!(step.action, Action::Remove | Action::Replace) {
            if !target.is_file() {
                return Err(STAGE_MISMATCH.into());
            }
            fs::remove_file(&target).map_err(|e| e.to_string())?;
            expected.remove(&name.to_lowercase());
        }
        if step.action == Action::Remove {
            continue;
        }
        let key = step.path.to_lowercase();
        let record = match prepared.sources.get(&key) {
            Some(Source::Download(file)) => {
                let received = fetch_verified(state, &file.downloads, &target, file.file_size, &file.hashes).await?;
                FileRecord { relative: name.clone(), size: received.size, sha256: received.sha256 }
            }
            Some(Source::Curseforge { url: Some(url), sha1, size, .. }) => {
                let expected = BTreeMap::from([("sha1".to_owned(), sha1.clone())]);
                let received = fetch_verified(state, std::slice::from_ref(url), &target, *size, &expected).await?;
                FileRecord { relative: name.clone(), size: received.size, sha256: received.sha256 }
            }
            Some(Source::Curseforge { url: None, .. }) => return Err(MANUAL_DOWNLOAD_REQUIRED.into()),
            Some(Source::Override { entry }) => {
                let Some((_, Provided::Override { sha256, size })) = prepared.upstream.get(&key) else {
                    return Err(STAGE_MISMATCH.into());
                };
                let (archive, entry, target_path, hash, length) =
                    (prepared.archive.clone(), entry.clone(), target.clone(), sha256.clone(), *size);
                tokio::task::spawn_blocking(move || extract_entry(&archive, &entry, &target_path, &hash, length))
                    .await
                    .map_err(|error| error.to_string())??;
                FileRecord { relative: name.clone(), size: *size, sha256: sha256.clone() }
            }
            None => return Err(STAGE_MISMATCH.into()),
        };
        if expected.insert(name.to_lowercase(), record).is_some() {
            return Err(STAGE_MISMATCH.into());
        }
    }
    let mut after = current.clone();
    if dependency_change {
        let app = app.ok_or("安装新加载器需要启动器窗口")?;
        let (version_id, loader, loader_version) = install_dependencies(state, app, &prepared.dependencies).await?;
        after.version_id = version_id;
        after.loader = loader;
        after.loader_version = loader_version;
    }
    state.control.checkpoint().await?;
    let lock = safe_join(stage.path(), LOCK)?;
    if lock.is_file() {
        fs::remove_file(&lock).map_err(|e| e.to_string())?;
    }
    expected.remove(LOCK);
    let lock_record = write_update_lock(stage.path(), &prepared)?;
    expected.insert(LOCK.into(), lock_record);
    let mut expected: Vec<FileRecord> = expected.into_values().collect();
    expected.sort_by(|a, b| a.relative.cmp(&b.relative));
    // Names are compared without case: a step writes the new version's
    // spelling, and an existing folder keeps its own.
    at(&live, "commit");
    let committed_state = state.clone();
    let committed_current = current.clone();
    let done = tokio::task::spawn_blocking(move || {
        instances::commit_pack_update(&committed_state, stage, &committed_current, &after, &expected)
    })
    .await
    .map_err(|error| crate::errors::AppError::internal(error.to_string()))??;
    drop(prepared);
    Ok(PackUpdateResult { instance: done.instance, previous_backup: done.previous_backup, previous_directory: done.previous_directory })
}

#[cfg(test)]
#[path = "pack_update_tests.rs"]
mod tests;
