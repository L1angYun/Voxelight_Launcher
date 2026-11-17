use crate::{errors::{AppError, AppResult}, instances::checked_absolute};
use serde::Deserialize;
use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath, MessageDialogButtons};
use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PathUse {
    GameDirectory, Java, InstanceIcon, Skin, Background, PresetRead, PresetWrite,
    LocalResources, WorldRead, WorldWrite, PackRead, PackWrite, InstanceArchive, Diagnostics,
}

impl PathUse {
    fn extensions(self) -> &'static [&'static str] {
        match self {
            Self::GameDirectory => &[],
            #[cfg(windows)] Self::Java => &["exe"],
            #[cfg(not(windows))] Self::Java => &[],
            Self::InstanceIcon => &["png", "jpg", "jpeg", "webp", "ico"],
            Self::Skin => &["png"],
            Self::Background => &["png", "jpg", "jpeg", "webp"],
            Self::PresetRead | Self::PresetWrite => &["json"],
            Self::LocalResources => &["jar", "zip"],
            Self::WorldRead | Self::WorldWrite | Self::InstanceArchive => &["zip"],
            Self::PackRead => &["mrpack", "zip"],
            Self::PackWrite => &["mrpack"],
            Self::Diagnostics => &["txt"],
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
            Self::WorldRead => "导入世界 / Import world",
            Self::WorldWrite => "备份世界 / Back up world",
            Self::PackRead => "导入整合包 / Import modpack",
            Self::PackWrite => "导出共享整合包 / Export shared modpack",
            Self::InstanceArchive => "导出个人实例备份 / Export personal instance backup",
            Self::Diagnostics => "导出诊断报告 / Export diagnostic report",
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
        if !metadata.is_file() {
            return Err("所选路径类型与操作不匹配".into());
        }
        path.canonicalize().map_err(|e| e.to_string())
    }
}

#[derive(Default)]
pub struct PathGrants(Mutex<HashMap<(PathUse, PathBuf, String), Instant>>);

const LIFE: Duration = Duration::from_secs(300);
const MAX_GRANTS: usize = 128;

impl PathGrants {
    fn insert_all(&self, purpose: PathUse, paths: &[PathBuf], window: &str, now: Instant) -> AppResult<()> {
        if paths.len() > 100 { return Err(AppError::new("storage.pathAuthorizationRequired")); }
        let mut grants = self.0.lock().map_err(|_| AppError::new("storage.pathAuthorizationRequired"))?;
        grants.retain(|_, expiry| *expiry > now);
        if grants.len() + paths.len() > MAX_GRANTS {
            return Err(AppError::new("storage.pathAuthorizationRequired"));
        }
        for path in paths { grants.insert((purpose, path.clone(), window.into()), now + LIFE); }
        Ok(())
    }

    fn consume_all(&self, purpose: PathUse, values: &[&str], window: &str, now: Instant) -> AppResult<Vec<PathBuf>> {
        if values.is_empty() || values.len() > 100 { return Err(AppError::new("storage.pathAuthorizationRequired")); }
        let mut grants = self.0.lock().map_err(|_| AppError::new("storage.pathAuthorizationRequired"))?;
        grants.retain(|_, expiry| *expiry > now);
        let mut keys = Vec::with_capacity(values.len());
        for value in values {
            // Check the exact display value against previously selected names
            // before touching a renderer-supplied path on disk.
            let key = grants.keys().find(|(use_, path, label)| *use_ == purpose
                && label == window && crate::storage::display_profile_path(path) == *value)
                .ok_or_else(|| AppError::new("storage.pathAuthorizationRequired"))?;
            if keys.contains(key) { return Err(AppError::new("storage.pathAuthorizationRequired")); }
            keys.push(key.clone());
        }
        for key in &keys { grants.remove(key); }
        drop(grants);
        keys.into_iter().zip(values).map(|((_, path, _), value)| {
            let current = purpose.resolve(Path::new(value))?;
            if current != path { return Err(AppError::new("storage.pathAuthorizationRequired")); }
            Ok(current)
        }).collect()
    }

    pub(crate) fn consume(&self, purpose: PathUse, value: &str, window: &WebviewWindow) -> AppResult<PathBuf> {
        let paths = self.consume_all(purpose, &[value], window.label(), Instant::now())?;
        Ok(paths.into_iter().next().expect("single approved path"))
    }

    pub(crate) fn consume_resources(&self, values: &[String], window: &WebviewWindow) -> AppResult<Vec<PathBuf>> {
        let paths = values.iter().map(String::as_str).collect::<Vec<_>>();
        self.consume_all(PathUse::LocalResources, &paths, window.label(), Instant::now())
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
    approved.game_directory == current.game_directory && approved.java_path == current.java_path
        && approved.custom_background == current.custom_background
}

pub(crate) async fn authorize_changed_config_paths(
    window: &WebviewWindow, grants: &PathGrants, previous: &crate::models::Config, next: &mut crate::models::Config,
) -> AppResult<()> {
    if next.game_directory.trim() != previous.game_directory {
        let result = grants.choose_or_confirm(PathUse::GameDirectory, next.game_directory.trim(), window, true).await?;
        next.game_directory = crate::storage::display_profile_path(&result);
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
    if purpose == PathUse::LocalResources {
        dialog.pick_files(move |paths| { let _ = tx.send(paths); });
    } else {
        let receive = move |path: Option<FilePath>| { let _ = tx.send(path.map(|path| vec![path])); };
        if purpose.writes() { dialog.save_file(receive); }
        else if purpose == PathUse::GameDirectory { dialog.pick_folder(receive); }
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
}
