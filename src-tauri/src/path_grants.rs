use crate::{errors::{AppError, AppResult}, instances::checked_absolute};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, fs, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogButtons};
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PathUse {
    GameDirectory, Java, InstanceIcon, Skin, Background, PresetRead, PresetWrite,
    LocalResources, Datapack, WorldRead, WorldWrite, PackRead, PackWrite, InstanceArchive, Diagnostics,
    ServerJar, ServerFolder, OptifineInstaller,
}

impl PathUse {
    fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::GameDirectory | Self::ServerFolder => &[],
            #[cfg(windows)] Self::Java => &["exe"],
            #[cfg(not(windows))] Self::Java => &[],
            Self::InstanceIcon => &["png", "jpg", "jpeg", "webp", "ico"],
            Self::Skin => &["png"],
            Self::Background => &["png", "jpg", "jpeg", "webp"],
            Self::PresetRead | Self::PresetWrite => &["json"],
            Self::LocalResources => &["jar", "zip"],
            Self::Datapack | Self::WorldRead | Self::WorldWrite | Self::InstanceArchive => &["zip"],
            Self::PackRead => &["mrpack", "zip"],
            Self::PackWrite => &["mrpack"],
            Self::Diagnostics => &["txt"],
            Self::ServerJar | Self::OptifineInstaller => &["jar"],
        }
    }

    fn writes(self) -> bool {
        matches!(self, Self::PresetWrite | Self::WorldWrite | Self::PackWrite | Self::InstanceArchive | Self::Diagnostics)
    }

    fn game_directory(path: &Path) -> Result<PathBuf, String> {
        crate::processes::configured_game_root(path)
    }

    fn title(self) -> &'static str {
        match self {
            Self::GameDirectory => "选择游戏数据目录 / Choose game data directory",
            Self::Java => "选择 Java 可执行文件 / Choose Java executable",
            Self::InstanceIcon => "选择实例图标 / Choose instance icon",
            Self::Skin => "选择 Minecraft 皮肤 / Choose Minecraft skin",
            Self::Background => "选择启动器背景 / Choose launcher background",
            Self::PresetRead => "导入设置预设 / Import settings preset",
            Self::PresetWrite => "导出设置预设 / Export settings preset",
            Self::LocalResources => "导入本地资源 / Import local resources",
            Self::Datapack => "导入数据包 / Import data packs",
            Self::WorldRead => "导入世界 / Import world",
            Self::WorldWrite => "备份世界 / Back up world",
            Self::PackRead => "导入整合包 / Import modpack",
            Self::PackWrite => "导出共享整合包 / Export shared modpack",
            Self::InstanceArchive => "导出个人实例备份 / Export personal instance backup",
            Self::Diagnostics => "导出诊断报告 / Export diagnostic report",
            Self::ServerJar => "选择服务端 JAR / Choose server JAR",
            Self::ServerFolder => "选择服务端文件夹 / Choose server folder",
            Self::OptifineInstaller => "选择 OptiFine 安装器 JAR / Choose OptiFine installer JAR",
        }
    }

    fn resolve(self, value: &Path) -> Result<PathBuf, String> {
        if self == Self::GameDirectory { return Self::game_directory(value); }
        let path = checked_absolute(value)?;
        let allowed = self.extensions();
        if !allowed.is_empty() && !path.extension().and_then(|ext| ext.to_str())
            .is_some_and(|ext| allowed.iter().any(|candidate| ext.eq_ignore_ascii_case(candidate))) {
            return Err("原生选择的文件类型与操作不匹配".into());
        }
        if self.writes() {
            // Keep the selected, literal file name. Publication independently
            // refuses replacement via no-clobber open/rename.
            let parent = path.parent().ok_or("导出路径不能没有父目录")?;
            let name = path.file_name().ok_or("导出路径不能没有文件名")?;
            return Ok(parent.canonicalize().map_err(|e| e.to_string())?.join(name));
        }
        let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
        // A server folder is the one choice that is a directory.
        if if self == Self::ServerFolder { !metadata.is_dir() } else { !metadata.is_file() } {
            return Err("所选路径类型与操作不匹配".into());
        }
        path.canonicalize().map_err(|e| e.to_string())
    }
}

type GrantKey = (PathUse, PathBuf, String);

/// An OS-drop grant: when it expires and which drop of its window it came
/// from (a dialog peeking at it moves it to the window's latest drop).
#[derive(Clone, Copy)]
struct DropGrant {
    expiry: Instant,
    serial: u64,
}

/// Native picker grants and OS-drop grants live in separate, bounded pools.
/// A drop needs no native dialog approval, so an unconsumed drop must never
/// use up the room a later native picker needs (and vice versa).
#[derive(Default)]
struct GrantTable {
    native: HashMap<GrantKey, Instant>,
    dropped: HashMap<GrantKey, DropGrant>,
    /// The number of each window's latest drop.
    drops: HashMap<String, u64>,
}

#[derive(Default)]
pub struct PathGrants(Mutex<GrantTable>);

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFiles {
    pub mods: Vec<String>,
    pub zips: Vec<String>,
    pub modpacks: Vec<String>,
    pub skins: Vec<String>,
    pub unsupported: usize,
}

const LIFE: Duration = Duration::from_secs(300);
const MAX_GRANTS: usize = 256;
/// A window keeps the grants of its latest drops only. A dialog still holding
/// an earlier drop (a dropped modpack waiting for its name, a previewed skin)
/// survives a few unrelated drops, and repeated drops cannot pile up.
const RECENT_DROPS: u64 = 8;
/// Every drop grant together. One drop mints at most 101 (100 files plus a
/// second PackRead grant for a single ZIP), so a window's recent drops always
/// fit; only several busy windows at once can overflow it.
const MAX_DROP_GRANTS: usize = 1024;

impl GrantTable {
    fn prune(&mut self, now: Instant) {
        self.native.retain(|_, expiry| *expiry > now);
        self.dropped.retain(|_, grant| grant.expiry > now);
    }

    fn matching<'a>(
        mut entries: impl Iterator<Item = (&'a GrantKey, Instant)>,
        purpose: PathUse,
        value: &str,
        window: &str,
        now: Instant,
    ) -> Option<&'a GrantKey> {
        entries.find(|((use_, path, label), expiry)| {
            *use_ == purpose
                && label == window
                && *expiry > now
                && crate::storage::display_profile_path(path) == value
        }).map(|(key, _)| key)
    }

    fn native_matching(&self, purpose: PathUse, value: &str, window: &str, now: Instant) -> Option<&GrantKey> {
        Self::matching(self.native.iter().map(|(key, expiry)| (key, *expiry)), purpose, value, window, now)
    }

    fn dropped_matching(&self, purpose: PathUse, value: &str, window: &str, now: Instant) -> Option<&GrantKey> {
        Self::matching(self.dropped.iter().map(|(key, grant)| (key, grant.expiry)), purpose, value, window, now)
    }
}

impl PathGrants {
    fn insert_all(&self, purpose: PathUse, paths: &[PathBuf], window: &str, now: Instant) -> AppResult<()> {
        if paths.len() > 100 { return Err(AppError::new("storage.pathAuthorizationRequired")); }
        let mut grants = self.0.lock().map_err(|_| AppError::new("storage.pathAuthorizationRequired"))?;
        grants.prune(now);
        // Only native choices count against the native limit.
        if grants.native.len() + paths.len() > MAX_GRANTS {
            return Err(AppError::new("storage.pathAuthorizationRequired"));
        }
        for path in paths { grants.native.insert((purpose, path.clone(), window.into()), now + LIFE); }
        Ok(())
    }

    /// Starts a new OS drop in `window` and returns its number. The grants of
    /// the window's drops before the latest `RECENT_DROPS` are released, even
    /// when this drop has nothing usable.
    fn begin_drop(&self, window: &str) -> u64 {
        let Ok(mut grants) = self.0.lock() else { return 0 };
        let serial = grants.drops.get(window).map_or(1, |latest| latest + 1);
        grants.drops.insert(window.into(), serial);
        grants.dropped.retain(|(_, _, label), grant| label != window || grant.serial + RECENT_DROPS > serial);
        serial
    }

    fn insert_dropped_all(&self, purpose: PathUse, paths: &[PathBuf], window: &str, serial: u64, now: Instant) -> AppResult<()> {
        if paths.is_empty() { return Ok(()); }
        let mut grants = self.0.lock().map_err(|_| AppError::new("storage.pathAuthorizationRequired"))?;
        grants.prune(now);
        let keys = paths.iter().map(|path| (purpose, path.clone(), window.to_owned())).collect::<Vec<_>>();
        let added = keys.iter().filter(|key| !grants.dropped.contains_key(*key)).count();
        if grants.dropped.len() + added > MAX_DROP_GRANTS {
            return Err(AppError::new("storage.pathAuthorizationRequired"));
        }
        for key in keys { grants.dropped.insert(key, DropGrant { expiry: now + LIFE, serial }); }
        Ok(())
    }

    fn consume_all(&self, purpose: PathUse, values: &[&str], window: &str, now: Instant) -> AppResult<Vec<PathBuf>> {
        if values.is_empty() || values.len() > 100 { return Err(AppError::new("storage.pathAuthorizationRequired")); }
        let mut grants = self.0.lock().map_err(|_| AppError::new("storage.pathAuthorizationRequired"))?;
        grants.prune(now);
        let mut keys = Vec::with_capacity(values.len());
        for value in values {
            // Check the exact display value against previously selected names
            // before touching a renderer-supplied path on disk.
            let key = grants.native_matching(purpose, value, window, now)
                .or_else(|| grants.dropped_matching(purpose, value, window, now))
                .ok_or_else(|| AppError::new("storage.pathAuthorizationRequired"))?
                .clone();
            if keys.contains(&key) { return Err(AppError::new("storage.pathAuthorizationRequired")); }
            keys.push(key);
        }
        for key in &keys {
            grants.native.remove(key);
            grants.dropped.remove(key);
        }
        drop(grants);
        keys.into_iter().zip(values).map(|((_, path, _), value)| {
            let current = purpose.resolve(Path::new(value))?;
            if current != path { return Err(AppError::new("storage.pathAuthorizationRequired")); }
            Ok(current)
        }).collect()
    }

    /// The chosen path, without using the choice up: an inspection before the
    /// action that consumes it. Looking renews the choice for another LIFE, so
    /// time spent filling in the rest of a form does not expire it.
    fn peek_at(&self, purpose: PathUse, value: &str, window: &str, now: Instant) -> AppResult<PathBuf> {
        let mut grants = self.0.lock().map_err(|_| AppError::new("storage.pathAuthorizationRequired"))?;
        // Do not prune here: a look at a later time must not erase a choice
        // that is still valid for the caller's current time (tests use
        // simulated clocks; production clocks only move forward).
        // Search native first, then drop grants; a path approved both ways is
        // renewed in the native pool.
        if let Some(key) = grants.native_matching(purpose, value, window, now).cloned() {
            grants.native.insert(key.clone(), now + LIFE);
            let path = key.1;
            drop(grants);
            let current = purpose.resolve(Path::new(value))?;
            if current != path { return Err(AppError::new("storage.pathAuthorizationRequired")); }
            return Ok(current);
        }
        if let Some(key) = grants.dropped_matching(purpose, value, window, now).cloned() {
            // A dialog is using it: it counts as part of the latest drop.
            let serial = grants.drops.get(window).copied().unwrap_or(0);
            grants.dropped.insert(key.clone(), DropGrant { expiry: now + LIFE, serial });
            let path = key.1;
            drop(grants);
            let current = purpose.resolve(Path::new(value))?;
            if current != path { return Err(AppError::new("storage.pathAuthorizationRequired")); }
            return Ok(current);
        }
        Err(AppError::new("storage.pathAuthorizationRequired"))
    }

    pub(crate) fn peek(&self, purpose: PathUse, value: &str, window: &WebviewWindow) -> AppResult<PathBuf> {
        self.peek_at(purpose, value, window.label(), Instant::now())
    }

    /// Gives back a choice that an action used up but did not complete, so the
    /// user can try again without choosing it again.
    pub(crate) fn restore(&self, purpose: PathUse, path: PathBuf, window: &WebviewWindow) {
        let _ = self.insert_all(purpose, &[path], window.label(), Instant::now());
    }

    pub(crate) fn consume(&self, purpose: PathUse, value: &str, window: &WebviewWindow) -> AppResult<PathBuf> {
        let paths = self.consume_all(purpose, &[value], window.label(), Instant::now())?;
        Ok(paths.into_iter().next().expect("single approved path"))
    }

    pub(crate) fn consume_resources(&self, values: &[String], window: &WebviewWindow) -> AppResult<Vec<PathBuf>> {
        let paths = values.iter().map(String::as_str).collect::<Vec<_>>();
        self.consume_all(PathUse::LocalResources, &paths, window.label(), Instant::now())
    }

    pub(crate) fn consume_datapacks(&self, values: &[String], window: &WebviewWindow) -> AppResult<Vec<PathBuf>> {
        let paths = values.iter().map(String::as_str).collect::<Vec<_>>();
        self.consume_all(PathUse::Datapack, &paths, window.label(), Instant::now())
    }

    fn grant_dropped_at(&self, paths: &[PathBuf], window: &str, now: Instant) -> DroppedFiles {
        let mut payload = DroppedFiles::default();
        let serial = self.begin_drop(window);
        let mut mods = Vec::new();
        let mut zips = Vec::new();
        let mut modpacks = Vec::new();
        let mut skins = Vec::new();
        let mut seen = HashSet::new();
        for (index, raw) in paths.iter().enumerate() {
            if index >= 100 {
                payload.unsupported += 1;
                continue;
            }
            let Some(ext) = raw.extension().and_then(|value| value.to_str()) else {
                payload.unsupported += 1;
                continue;
            };
            if ext.eq_ignore_ascii_case("jar") {
                match PathUse::LocalResources.resolve(raw) {
                    Ok(resolved) if seen.insert((PathUse::LocalResources, resolved.clone())) => mods.push(resolved),
                    Ok(_) => {}
                    Err(_) => payload.unsupported += 1,
                }
            } else if ext.eq_ignore_ascii_case("mrpack") {
                match PathUse::PackRead.resolve(raw) {
                    Ok(resolved) if seen.insert((PathUse::PackRead, resolved.clone())) => modpacks.push(resolved),
                    Ok(_) => {}
                    Err(_) => payload.unsupported += 1,
                }
            } else if ext.eq_ignore_ascii_case("zip") {
                match PathUse::LocalResources.resolve(raw) {
                    Ok(resolved) if seen.insert((PathUse::LocalResources, resolved.clone())) => zips.push(resolved),
                    Ok(_) => {}
                    Err(_) => payload.unsupported += 1,
                }
            } else if ext.eq_ignore_ascii_case("png") {
                match PathUse::Skin.resolve(raw) {
                    Ok(resolved) if seen.insert((PathUse::Skin, resolved.clone())) => skins.push(resolved),
                    Ok(_) => {}
                    Err(_) => payload.unsupported += 1,
                }
            } else {
                payload.unsupported += 1;
            }
        }
        let grant_list = |purpose: PathUse, items: &[PathBuf], unsupported: &mut usize| -> Vec<String> {
            if items.is_empty() { return Vec::new(); }
            if self.insert_dropped_all(purpose, items, window, serial, now).is_err() {
                // Overflow is reported as unsupported instead of silently
                // dropping files while claiming they were granted.
                *unsupported += items.len();
                return Vec::new();
            }
            items.iter().map(|path| crate::storage::display_profile_path(path)).collect()
        };
        let mut resource_items = Vec::with_capacity(mods.len() + zips.len());
        resource_items.extend(mods.iter().cloned());
        resource_items.extend(zips.iter().cloned());
        if !resource_items.is_empty() {
            if self.insert_dropped_all(PathUse::LocalResources, &resource_items, window, serial, now).is_ok() {
                payload.mods = mods.iter().map(|path| crate::storage::display_profile_path(path)).collect();
                payload.zips = zips.iter().map(|path| crate::storage::display_profile_path(path)).collect();
                // A single dropped .zip may be a CurseForge modpack dropped on Home/Library.
                if zips.len() == 1 {
                    let _ = self.insert_dropped_all(PathUse::PackRead, &zips, window, serial, now);
                }
            } else {
                payload.unsupported += resource_items.len();
            }
        }
        payload.modpacks = grant_list(PathUse::PackRead, &modpacks, &mut payload.unsupported);
        payload.skins = grant_list(PathUse::Skin, &skins, &mut payload.unsupported);
        payload
    }

    pub(crate) fn grant_dropped(&self, paths: &[PathBuf], window: &str) -> DroppedFiles {
        self.grant_dropped_at(paths, window, Instant::now())
    }

    pub(crate) async fn choose_or_confirm(
        &self, purpose: PathUse, path: &str, window: &WebviewWindow, may_confirm_typed: bool,
    ) -> AppResult<PathBuf> {
        if let Ok(chosen) = self.consume(purpose, path, window) { return Ok(chosen); }
        if !may_confirm_typed { return Err(AppError::new("storage.pathAuthorizationRequired")); }
        // A typed directory or executable remains usable only after a native
        // prompt of the exact canonical path and purpose. The forged IPC path
        // itself is not treated as approval and nothing opens automatically.
        let path = purpose.resolve(Path::new(path))?;
        let display = crate::storage::display_profile_path(&path);
        let (tx, rx) = oneshot::channel();
        window.dialog().message(format!("{}\n\n{}", purpose.title(), display))
            .title("Voxelight Launcher").parent(window).buttons(MessageDialogButtons::OkCancel)
            .show(move |accepted| { let _ = tx.send(accepted); });
        if !rx.await.unwrap_or(false) { return Err(AppError::new("storage.pathAuthorizationRequired")); }
        let validated = purpose.resolve(Path::new(&display))?;
        if validated != path { return Err(AppError::new("storage.pathAuthorizationRequired")); }
        Ok(validated)
    }
}

pub(crate) fn approved_config_is_current(approved: &crate::models::Config, current: &crate::models::Config) -> bool {
    approved.game_directory == current.game_directory
        && approved.game_folders == current.game_folders
        && approved.java_path == current.java_path
        && approved.custom_background == current.custom_background
}

/// Lexical containment that matches how Windows compares two configured
/// spellings: separators and case do not matter.
fn path_within(child: &Path, parent: &Path) -> bool {
    let parts = |path: &Path| {
        path.components()
            .map(|part| part.as_os_str().to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>()
    };
    let child = parts(child);
    let parent = parts(parent);
    !parent.is_empty() && child.len() >= parent.len() && child[..parent.len()] == parent[..]
}

/// Whether the configured folder list changed, so unrelated settings saves of
/// an older profile are not refused by a rule added later.
pub(crate) fn game_folder_roots_changed(previous: &[String], next: &[String]) -> bool {
    let normalize = |roots: &[String]| {
        let mut values: Vec<String> = roots
            .iter()
            .map(|root| {
                root.trim()
                    .replace('\\', "/")
                    .trim_end_matches('/')
                    .to_ascii_lowercase()
            })
            .filter(|root| !root.is_empty())
            .collect();
        values.sort();
        values
    };
    normalize(previous) != normalize(next)
}

/// Refuse nested game folders and any overlap with the launcher's own data
/// directory. Both would let a scan or a delete reach the other tree.
pub(crate) fn validate_game_folder_layout(
    roots: &[String],
    data_dir: &Path,
) -> AppResult<()> {
    let candidates: Vec<&Path> = roots
        .iter()
        .map(|root| Path::new(root.trim()))
        .filter(|root| !root.as_os_str().is_empty())
        .collect();
    for (index, root) in candidates.iter().enumerate() {
        if path_within(root, data_dir) || path_within(data_dir, root) {
            return Err(crate::errors::AppError::new(
                crate::errors::GAME_FOLDER_DATA_DIRECTORY,
            )
            .with_param("folder", root.display().to_string()));
        }
        for (other_index, other) in candidates.iter().enumerate() {
            if index == other_index {
                continue;
            }
            if path_within(root, other) {
                let mut error =
                    crate::errors::AppError::new(crate::errors::GAME_FOLDER_NESTED);
                error.params.insert(
                    "folder".into(),
                    serde_json::Value::String(root.display().to_string()),
                );
                error.params.insert(
                    "outer".into(),
                    serde_json::Value::String(other.display().to_string()),
                );
                return Err(error);
            }
        }
    }
    Ok(())
}

/// A game folder holds `versions/`, is empty, or carries the usual launcher
/// markers. A random non-empty folder would be scanned and written by mistake.
pub(crate) fn validate_game_folder_candidate(root: &Path) -> AppResult<()> {
    let has_versions = root.join("versions").is_dir();
    let looks_like_game_folder = [
        "libraries",
        "assets",
        "saves",
        "mods",
        "logs",
        "launcher_profiles.json",
        "hmclversion.cfg",
    ]
    .iter()
    .any(|name| root.join(name).exists());
    let empty = std::fs::read_dir(root)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false);
    if !has_versions && !looks_like_game_folder && !empty {
        return Err(crate::errors::AppError::new(
            crate::errors::GAME_FOLDER_UNSUPPORTED,
        )
        .with_param("folder", root.display().to_string()));
    }
    Ok(())
}

pub(crate) async fn authorize_changed_config_paths(
    window: &WebviewWindow, grants: &PathGrants, previous: &crate::models::Config, next: &mut crate::models::Config,
    data_dir: &Path,
) -> AppResult<()> {
    let known = previous.game_folder_roots();
    // The renderer may send a folder list, a legacy single directory, or both.
    // Every path that was not already configured needs a native choice (or an
    // exact typed confirmation), exactly like the old single game directory.
    let candidates = next
        .game_folders
        .iter()
        .map(|folder| folder.path.trim().to_owned())
        .chain(std::iter::once(next.game_directory.trim().to_owned()))
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    let mut authorized: Vec<(String, String)> = Vec::new();
    for path in &candidates {
        if known
            .iter()
            .any(|root| crate::models::same_game_folder_path(root, path))
            || authorized
                .iter()
                .any(|(candidate, _)| crate::models::same_game_folder_path(candidate, path))
        {
            continue;
        }
        let result = grants.choose_or_confirm(PathUse::GameDirectory, path, window, true).await?;
        authorized.push((path.clone(), crate::storage::display_profile_path(&result)));
    }
    // Validate every path this save introduces, including one that only
    // arrived as `gameDirectory` without a matching folder-list entry.
    for (candidate, resolved) in &authorized {
        let root = crate::processes::configured_game_root(std::path::Path::new(resolved))?;
        validate_game_folder_candidate(&root).map_err(|error| {
            error.with_param("folder", candidate.clone())
        })?;
    }
    for folder in &mut next.game_folders {
        let trimmed = folder.path.trim().to_owned();
        if let Some((_, resolved)) = authorized
            .iter()
            .find(|(candidate, _)| crate::models::same_game_folder_path(candidate, &trimmed))
        {
            folder.path.clone_from(resolved);
        } else {
            folder.path = trimmed;
        }
    }
    let directory = next.game_directory.trim().to_owned();
    if let Some((_, resolved)) = authorized
        .iter()
        .find(|(candidate, _)| crate::models::same_game_folder_path(candidate, &directory))
    {
        next.game_directory.clone_from(resolved);
    } else {
        next.game_directory = directory;
    }
    // Nested folders and the launcher data directory are never valid targets.
    // An older profile that already had such a folder can still save other
    // settings; only a change to the folder list has to pass this rule.
    let roots = next.game_folder_roots();
    if game_folder_roots_changed(&previous.game_folder_roots(), &roots) {
        validate_game_folder_layout(&roots, data_dir)?;
    }
    if !next.java_path.trim().is_empty() && next.java_path.trim() != previous.java_path {
        let result = grants.choose_or_confirm(PathUse::Java, next.java_path.trim(), window, true).await?;
        next.java_path = crate::storage::display_profile_path(&result);
    }
    if next.custom_background != previous.custom_background {
        if let Some(path) = &next.custom_background {
            let result = grants.choose_or_confirm(PathUse::Background, path, window, false).await?;
            next.custom_background = Some(crate::storage::display_profile_path(&result));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn choose_launcher_path(
    window: WebviewWindow,
    grants: State<'_, PathGrants>,
    purpose: PathUse,
    suggested_name: Option<String>,
) -> AppResult<Option<Vec<String>>> {
    let mut dialog = window.dialog().file().set_parent(&window).set_title(purpose.title());
    let extensions = purpose.extensions();
    if !extensions.is_empty() { dialog = dialog.add_filter(purpose.title(), extensions); }
    if purpose.writes() {
        if let Some(name) = suggested_name.filter(|name| name.len() <= 180
            && !name.contains(['\\', '/', ':', '\r', '\n', '\0']) && !matches!(name.as_str(), "." | "..")) {
            dialog = dialog.set_file_name(name);
        }
    }
    let (tx, rx) = oneshot::channel();
    if matches!(purpose, PathUse::LocalResources | PathUse::Datapack) {
        dialog.pick_files(move |paths| { let _ = tx.send(paths); });
    } else {
        let receive = move |path: Option<FilePath>| { let _ = tx.send(path.map(|path| vec![path])); };
        if purpose.writes() { dialog.save_file(receive); }
        else if matches!(purpose, PathUse::GameDirectory | PathUse::ServerFolder) { dialog.pick_folder(receive); }
        else { dialog.pick_file(receive); }
    }
    let Some(paths) = rx.await.map_err(|_| AppError::new("storage.pathAuthorizationRequired"))? else { return Ok(None); };
    let canonical = paths.into_iter().map(|path| {
        path.into_path().map_err(|e| e.to_string()).and_then(|path| purpose.resolve(&path))
    }).collect::<Result<Vec<_>,_>>()?;
    grants.insert_all(purpose, &canonical, window.label(), Instant::now())?;
    // storage display notation is cross-platform and no part is interpreted as a command.
    Ok(Some(canonical.iter().map(|path| crate::storage::display_profile_path(path)).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_server_jar_and_folder_grants_take_only_their_kind_and_peeking_keeps_them() {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/core-tests").join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let jar = root.path().join("paper.jar");
        let zip = root.path().join("paper.zip");
        let folder = root.path().join("server");
        fs::write(&jar, b"jar").unwrap();
        fs::write(&zip, b"zip").unwrap();
        fs::create_dir(&folder).unwrap();
        assert!(PathUse::ServerJar.resolve(&jar).is_ok());
        assert!(PathUse::ServerJar.resolve(&zip).is_err());
        assert!(PathUse::ServerJar.resolve(&folder).is_err());
        let chosen = PathUse::ServerFolder.resolve(&folder).unwrap();
        assert!(PathUse::ServerFolder.resolve(&jar).is_err());
        assert!(PathUse::ServerFolder.resolve(&root.path().join("missing")).is_err());

        let table = PathGrants::default();
        let now = Instant::now();
        let display = crate::storage::display_profile_path(&chosen);
        table.insert_all(PathUse::ServerFolder, &[chosen.clone()], "main", now).unwrap();
        // An inspection looks without using the choice up.
        assert_eq!(table.peek_at(PathUse::ServerFolder, &display, "main", now).unwrap(), chosen);
        assert_eq!(table.peek_at(PathUse::ServerFolder, &display, "main", now).unwrap(), chosen);
        assert!(table.peek_at(PathUse::ServerJar, &display, "main", now).is_err());
        assert!(table.peek_at(PathUse::ServerFolder, &display, "other", now).is_err());
        assert!(table.peek_at(PathUse::ServerFolder, &display, "main", now + LIFE).is_err());
        // The import uses it, once.
        assert_eq!(table.consume_all(PathUse::ServerFolder, &[&display], "main", now).unwrap(), vec![chosen.clone()]);
        assert!(table.peek_at(PathUse::ServerFolder, &display, "main", now).is_err());
        // Looking renews it, so a slow form does not lose the choice.
        let renewed = PathGrants::default();
        renewed.insert_all(PathUse::ServerFolder, &[chosen.clone()], "main", now).unwrap();
        let later = now + LIFE - Duration::from_secs(1);
        renewed.peek_at(PathUse::ServerFolder, &display, "main", later).unwrap();
        assert_eq!(renewed.consume_all(PathUse::ServerFolder, &[&display], "main", now + LIFE + Duration::from_secs(1)).unwrap(), vec![chosen]);
    }

    #[test]
    fn c5_native_grants_scope_each_file_to_intent_and_window_and_consume_once() {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let selected = root.path().join("selected.png");
        let other = root.path().join("not-selected.png");
        fs::write(&selected, b"first ordinary fixture").unwrap();
        fs::write(&other, b"other ordinary fixture").unwrap();
        let selected = PathUse::Background.resolve(&selected).unwrap();
        let display = crate::storage::display_profile_path(&selected);
        let other = crate::storage::display_profile_path(&other);
        let table = PathGrants::default();
        let now = Instant::now();
        table.insert_all(PathUse::Background, &[selected.clone()], "main", now).unwrap();
        assert!(table.consume_all(PathUse::Background, &[&other], "main", now).is_err());
        assert!(table.consume_all(PathUse::InstanceIcon, &[&display], "main", now).is_err());
        assert!(table.consume_all(PathUse::Background, &[&display], "other", now).is_err());
        assert_eq!(table.consume_all(PathUse::Background, &[&display], "main", now).unwrap(), vec![selected.clone()]);
        assert!(table.consume_all(PathUse::Background, &[&display], "main", now).is_err());
        table.insert_all(PathUse::Background, &[selected], "main", now).unwrap();
        assert!(table.consume_all(PathUse::Background, &[&display], "main", now + LIFE).is_err());
    }

    #[test]
    fn c5_native_resource_grants_are_consumed_atomically() {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let selected = root.path().join("regular.jar");
        let other = root.path().join("other.jar");
        fs::write(&selected, b"fixture one").unwrap();
        fs::write(&other, b"fixture two").unwrap();
        let selected = PathUse::LocalResources.resolve(&selected).unwrap();
        let display = crate::storage::display_profile_path(&selected);
        let other = crate::storage::display_profile_path(&other);
        let table = PathGrants::default();
        let now = Instant::now();
        table.insert_all(PathUse::LocalResources, &[selected.clone()], "main", now).unwrap();
        assert!(table.consume_all(PathUse::LocalResources, &[&display, &other], "main", now).is_err());
        assert!(table.consume_all(PathUse::LocalResources, &[&display, &display], "main", now).is_err());
        assert_eq!(table.consume_all(PathUse::LocalResources, &[&display], "main", now).unwrap(), vec![selected]);
    }

    #[test]
    fn u2_datapack_grants_accept_only_zip_files_and_consume_atomically() {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let pack = root.path().join("pack.zip");
        let jar = root.path().join("mod.jar");
        let folder = root.path().join("folder");
        fs::write(&pack, b"zip").unwrap();
        fs::write(&jar, b"jar").unwrap();
        fs::create_dir(&folder).unwrap();
        let resolved = PathUse::Datapack.resolve(&pack).unwrap();
        assert!(PathUse::Datapack.resolve(&jar).is_err());
        assert!(PathUse::Datapack.resolve(&folder).is_err());
        let display = crate::storage::display_profile_path(&resolved);
        let table = PathGrants::default();
        let now = Instant::now();
        table.insert_all(PathUse::Datapack, &[resolved.clone()], "main", now).unwrap();
        assert!(table.consume_all(PathUse::LocalResources, &[&display], "main", now).is_err());
        assert_eq!(table.consume_all(PathUse::Datapack, &[&display], "main", now).unwrap(), vec![resolved]);
        assert!(table.consume_all(PathUse::Datapack, &[&display], "main", now).is_err());
    }

    #[test]
    fn u3_dropped_files_mint_scoped_grants_only_for_supported_regular_files() {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap();
        let jar = root.path().join("sodium.jar");
        let zip = root.path().join("pack.zip");
        let mrpack = root.path().join("modpack.mrpack");
        let png = root.path().join("skin.png");
        let txt = root.path().join("readme.txt");
        let dir = root.path().join("folder.zip");
        fs::write(&jar, b"jar").unwrap();
        fs::write(&zip, b"zip").unwrap();
        fs::write(&mrpack, b"mrpack").unwrap();
        fs::write(&png, b"png").unwrap();
        fs::write(&txt, b"txt").unwrap();
        fs::create_dir(&dir).unwrap();

        let table = PathGrants::default();
        let now = Instant::now();
        let dropped = table.grant_dropped_at(&[jar.clone(), zip.clone(), mrpack.clone(), png.clone(), txt, dir], "main", now);
        assert_eq!(dropped.mods.len(), 1);
        assert_eq!(dropped.zips.len(), 1);
        assert_eq!(dropped.modpacks.len(), 1);
        assert_eq!(dropped.skins.len(), 1);
        assert_eq!(dropped.unsupported, 2);

        // Mods & zips are granted for LocalResources; single zip is also granted for PackRead.
        assert!(table.consume_all(PathUse::LocalResources, &[&dropped.mods[0]], "main", now).is_ok());
        assert!(table.consume_all(PathUse::PackRead, &[&dropped.zips[0]], "main", now).is_ok());
        assert!(table.consume_all(PathUse::PackRead, &[&dropped.modpacks[0]], "main", now).is_ok());
        // Skin can be peeked for preview and then consumed for upload.
        assert!(table.peek_at(PathUse::Skin, &dropped.skins[0], "main", now).is_ok());
        assert!(table.consume_all(PathUse::Skin, &[&dropped.skins[0]], "main", now).is_ok());
        // Wrong window or purpose is refused.
        assert!(table.peek_at(PathUse::Skin, &dropped.skins[0], "main", now).is_err());
    }

    fn drop_fixture() -> crate::instances::StagingDirectory {
        crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        ).unwrap()
    }

    fn fixture_file(root: &crate::instances::StagingDirectory, name: &str) -> PathBuf {
        let path = root.path().join(name);
        fs::write(&path, name.as_bytes()).unwrap();
        path
    }

    #[test]
    fn u3_a_later_drop_keeps_the_grants_an_open_dialog_still_uses() {
        let root = drop_fixture();
        let pack = fixture_file(&root, "pack.mrpack");
        let skin = fixture_file(&root, "skin.png");
        let note = fixture_file(&root, "readme.txt");
        let jar = fixture_file(&root, "sodium.jar");
        let folder = root.path().join("folder");
        fs::create_dir(&folder).unwrap();
        let table = PathGrants::default();
        let now = Instant::now();

        // The import dialog keeps the dropped pack; the skin panel previews a skin.
        let packs = table.grant_dropped_at(&[pack], "main", now);
        let skins = table.grant_dropped_at(&[skin], "main", now);
        table.peek_at(PathUse::Skin, &skins.skins[0], "main", now).unwrap();
        // Then the user drops things those dialogs ignore.
        assert_eq!(table.grant_dropped_at(&[note], "main", now).unsupported, 1);
        assert_eq!(table.grant_dropped_at(&[jar], "main", now).mods.len(), 1);
        assert_eq!(table.grant_dropped_at(&[folder], "main", now).unsupported, 1);
        assert!(table.consume_all(PathUse::PackRead, &[&packs.modpacks[0]], "main", now).is_ok());
        assert!(table.consume_all(PathUse::Skin, &[&skins.skins[0]], "main", now).is_ok());
    }

    #[test]
    fn u3_a_window_keeps_only_its_latest_drops_and_a_peek_counts_as_recent() {
        let root = drop_fixture();
        let packs = ["a", "b", "c"].map(|name| fixture_file(&root, &format!("{name}.mrpack")));
        let other = fixture_file(&root, "other.mrpack");
        let note = fixture_file(&root, "readme.txt");
        let table = PathGrants::default();
        let now = Instant::now();
        let unrelated = |count: u64| {
            for _ in 0..count {
                assert_eq!(table.grant_dropped_at(std::slice::from_ref(&note), "main", now).unsupported, 1);
            }
        };

        let first = table.grant_dropped_at(&packs, "main", now).modpacks;
        let elsewhere = table.grant_dropped_at(&[other], "other", now).modpacks;
        unrelated(RECENT_DROPS - 1);
        // The first drop is still one of the window's latest.
        assert!(table.consume_all(PathUse::PackRead, &[&first[0]], "main", now).is_ok());
        // A dialog looking at a grant keeps it with the latest drop.
        table.peek_at(PathUse::PackRead, &first[2], "main", now).unwrap();
        unrelated(1);
        assert!(
            table.consume_all(PathUse::PackRead, &[&first[1]], "main", now).is_err(),
            "a drop older than the latest {RECENT_DROPS} is released"
        );
        unrelated(RECENT_DROPS - 2);
        assert!(table.consume_all(PathUse::PackRead, &[&first[2]], "main", now).is_ok());
        // Another window's drops are its own.
        assert!(table.consume_all(PathUse::PackRead, &[&elsewhere[0]], "other", now).is_ok());
    }

    #[test]
    fn u3_drop_grants_are_bounded_report_overflow_and_never_block_native_grants() {
        let root = drop_fixture();
        let groups = (0..RECENT_DROPS + 3)
            .map(|group| (0..100).map(|n| fixture_file(&root, &format!("g{group}-{n}.jar"))).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let skin = fixture_file(&root, "skin.png");
        let pack = fixture_file(&root, "pack.mrpack");
        let zip = fixture_file(&root, "pack.zip");
        let table = PathGrants::default();
        let now = Instant::now();

        let first = table.grant_dropped_at(&groups[0], "main", now);
        assert_eq!(first.mods.len(), 100);
        // Unconsumed drop grants do not occupy the native picker's 256 slots.
        let native = (0..MAX_GRANTS)
            .map(|n| PathUse::Background.resolve(&fixture_file(&root, &format!("native-{n}.png"))).unwrap())
            .collect::<Vec<_>>();
        for chunk in native.chunks(100) {
            table.insert_all(PathUse::Background, chunk, "main", now).unwrap();
        }

        // Large drops one after another never overflow: older drops are released.
        for group in &groups[1..] {
            let dropped = table.grant_dropped_at(group, "main", now);
            assert_eq!((dropped.mods.len(), dropped.unsupported), (100, 0));
        }
        assert!(table.consume_all(PathUse::LocalResources, &[&first.mods[0]], "main", now).is_err());

        // Several busy windows together can fill the pool: 800 grants for
        // main's latest drops, then 224 more fill it exactly.
        assert_eq!(table.grant_dropped_at(&groups[0], "w1", now).mods.len(), 100);
        assert_eq!(table.grant_dropped_at(&groups[1], "w2", now).mods.len(), 100);
        assert_eq!(table.grant_dropped_at(&groups[2][..24], "w3", now).mods.len(), 24);
        // Every refused file is reported as unsupported, of every kind,
        // instead of empty lists that look handled.
        let overflow = table.grant_dropped_at(&[skin, pack, zip, groups[3][0].clone()], "w4", now);
        assert!(overflow.skins.is_empty() && overflow.modpacks.is_empty());
        assert!(overflow.mods.is_empty() && overflow.zips.is_empty());
        assert_eq!(overflow.unsupported, 4);
        // Native choices still work with the drop pool full.
        let chosen = crate::storage::display_profile_path(&native[0]);
        assert_eq!(table.consume_all(PathUse::Background, &[&chosen], "main", now).unwrap(), vec![native[0].clone()]);
        table.insert_all(PathUse::Background, &native[..1], "main", now).unwrap();
    }
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    #[test]
    fn game_folders_refuse_nesting_and_the_launcher_data_directory() {
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let outer = holder.path().join("outer");
        let inner = outer.join("inner");
        let other = holder.path().join("other");
        let data = holder.path().join("data");
        for path in [&outer, &inner, &other, &data] {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir_all(outer.join("versions")).unwrap();
        let roots = |values: &[&Path]| values.iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>();
        let nested = validate_game_folder_layout(&roots(&[&outer, &inner]), &data).unwrap_err();
        assert_eq!(nested.code, crate::errors::GAME_FOLDER_NESTED);
        assert_eq!(nested.params["outer"], outer.to_string_lossy().as_ref());
        let deeper = validate_game_folder_layout(
            &roots(&[&outer, &data.join("game")]),
            &data,
        )
        .unwrap_err();
        assert_eq!(deeper.code, crate::errors::GAME_FOLDER_DATA_DIRECTORY);
        let same = validate_game_folder_layout(&roots(&[&data]), &data).unwrap_err();
        assert_eq!(same.code, crate::errors::GAME_FOLDER_DATA_DIRECTORY);
        validate_game_folder_layout(&roots(&[&outer, &other]), &data).unwrap();
        validate_game_folder_layout(&roots(&[&holder.path().join("beside-data")]), &data).unwrap();
    }

    #[test]
    fn a_game_folder_candidate_must_hold_versions_be_empty_or_look_like_one() {
        let holder = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/core-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let empty = holder.path().join("empty");
        let with_versions = holder.path().join("with-versions");
        let with_saves = holder.path().join("with-saves");
        let random = holder.path().join("random");
        for path in [&empty, &with_versions, &with_saves, &random] {
            fs::create_dir_all(path).unwrap();
        }
        fs::create_dir_all(with_versions.join("versions")).unwrap();
        fs::create_dir_all(with_saves.join("saves")).unwrap();
        fs::write(random.join("report.docx"), b"not a game").unwrap();
        validate_game_folder_candidate(&empty).unwrap();
        validate_game_folder_candidate(&with_versions).unwrap();
        validate_game_folder_candidate(&with_saves).unwrap();
        let refused = validate_game_folder_candidate(&random).unwrap_err();
        assert_eq!(refused.code, crate::errors::GAME_FOLDER_UNSUPPORTED);
        assert_eq!(refused.params["folder"], random.to_string_lossy().as_ref());
    }
}
