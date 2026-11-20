//! Startup cleanup of update staging (the M07 pattern): only `<guid32>`
//! directories under the updates root, only the names an update creates,
//! never through a link, and never while their helper may still run.
use super::helper::{installer_file_name, staging_name, HELPER_EXE, LOG, OWNER};
use super::process::{Identity, Liveness};
use std::path::Path;
use std::time::{Duration, SystemTime};

/// A directory without an owner marker (a download that never reached the
/// hand-off) is removed once it is this old.
const UNOWNED_AGE: Duration = Duration::from_secs(60 * 60);
/// A failure log is kept this long for the user to read.
const LOG_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn age(path: &Path, now: SystemTime) -> Option<Duration> {
    let modified = std::fs::symlink_metadata(path).ok()?.modified().ok()?;
    now.duration_since(modified).ok()
}

fn read_owner(directory: &Path) -> Option<Identity> {
    let path = directory.join(OWNER);
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 256 {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn ordinary_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return false;
            }
        }
        metadata.is_file() && !metadata.file_type().is_symlink()
    })
}

fn remove_known(directory: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(directory) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if !ordinary_file(&path) {
            continue;
        }
        let known = name == HELPER_EXE || name == "download.bin" || name == OWNER || installer_file_name(&name);
        // A non-empty failure log stays for a week; an empty one goes now.
        let log = name == LOG
            && std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() == 0)
            || name == LOG && age(&path, now).is_some_and(|age| age >= LOG_AGE);
        if known || log {
            let _ = std::fs::remove_file(path);
        }
    }
    let _ = std::fs::remove_dir(directory);
}

/// Sweeps `root` with `liveness` deciding whether a helper may still run.
pub(crate) fn sweep(root: &Path, liveness: impl Fn(Identity) -> Liveness, now: SystemTime) {
    if !super::download::checked_ancestors(root) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let directory = entry.path();
        if !staging_name(&name) || !super::download::checked_ancestors(&directory) {
            continue;
        }
        let stale = match read_owner(&directory) {
            Some(owner) => liveness(owner) == Liveness::Stale,
            None => age(&directory, now).is_some_and(|age| age >= UNOWNED_AGE),
        };
        if stale {
            remove_known(&directory, now);
        }
    }
}

/// The production sweep, run once at startup.
pub(crate) fn sweep_on_startup() {
    if let Ok(root) = super::download::updates_root() {
        sweep(&root, super::process::liveness, SystemTime::now());
    }
}
