// SPDX-License-Identifier: GPL-3.0-only
//! Temporary WebView2 user-data profile used by the Setup window.
//!
//! Setup never lets WebView2 fall back to `%LOCALAPPDATA%\dev.voxelight.setup`:
//! the profile must be a private temp folder created before the window exists,
//! and it is removed after the WebView2 processes have exited. Removal is
//! retried because the browser processes can keep profile files open for a
//! short time after the Tauri event loop returns.
use crate::payload::create_exclusive_temp_dir;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const WEBVIEW_PROFILE_PREFIX: &str = "voxelight-setup-webview-";
pub const CLEANUP_ATTEMPTS: u32 = 24;
pub const CLEANUP_DELAY: Duration = Duration::from_millis(250);

/// Creates the exclusive WebView2 profile folder, or returns an error.
///
/// An error must be treated as "the UI cannot start" and fall back to the NSIS
/// UI; returning `None` and letting Tauri choose its default profile directory
/// would leave user data behind in `%LOCALAPPDATA%`.
pub fn create_webview_profile(base_temp: &Path) -> Result<PathBuf, String> {
    create_exclusive_temp_dir(base_temp, WEBVIEW_PROFILE_PREFIX).map_err(|error| {
        format!(
            "Could not create a private WebView2 profile folder in {}: {error}",
            base_temp.display()
        )
    })
}

/// Removes `dir`, retrying while WebView2 still releases its profile files.
///
/// `remove` is injected so tests can exercise the retry path without locking
/// real files. Success means the directory no longer exists.
pub fn cleanup_with_retries(
    dir: &Path,
    attempts: u32,
    delay: Duration,
    mut remove: impl FnMut(&Path) -> io::Result<()>,
) -> bool {
    for attempt in 0..attempts.max(1) {
        match remove(dir) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return true,
            Err(_) => {}
        }
        if !dir.exists() {
            return true;
        }
        if attempt + 1 < attempts {
            std::thread::sleep(delay);
        }
    }
    !dir.exists()
}

/// Production cleanup: retries `remove_dir_all` for up to six seconds.
pub fn cleanup_webview_profile(dir: &Path) -> bool {
    cleanup_with_retries(
        dir,
        CLEANUP_ATTEMPTS,
        CLEANUP_DELAY,
        |dir| std::fs::remove_dir_all(dir),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn fresh_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "voxelight-setup-webview-test-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn creates_an_exclusive_profile_under_the_temp_root() {
        let root = fresh_root("create");
        let profile = create_webview_profile(&root).unwrap();
        assert!(profile.starts_with(&root));
        assert!(profile.is_dir());
        assert!(!profile.to_string_lossy().contains("dev.voxelight.setup"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn refuses_to_invent_a_default_profile_when_the_temp_root_is_unusable() {
        let root = fresh_root("unusable");
        let file = root.join("not-a-folder");
        std::fs::write(&file, b"x").unwrap();
        assert!(create_webview_profile(&file).is_err());
        assert!(!root.join("dev.voxelight.setup").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cleanup_retries_until_webview_releases_the_profile() {
        let root = fresh_root("retry");
        let profile = root.join("profile");
        std::fs::create_dir_all(profile.join("EBWebView")).unwrap();
        std::fs::write(profile.join("EBWebView").join("lock"), b"locked").unwrap();
        let calls = RefCell::new(0u32);
        let removed = cleanup_with_retries(
            &profile,
            5,
            Duration::from_millis(1),
            |dir| {
                *calls.borrow_mut() += 1;
                if *calls.borrow() < 3 {
                    return Err(io::Error::new(io::ErrorKind::Other, "still open"));
                }
                std::fs::remove_dir_all(dir)
            },
        );
        assert!(removed);
        assert_eq!(*calls.borrow(), 3);
        assert!(!profile.exists(), "nothing may be left behind after success");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn cleanup_reports_failure_after_the_retry_budget() {
        let profile = fresh_root("never").join("profile");
        std::fs::create_dir_all(&profile).unwrap();
        let calls = RefCell::new(0u32);
        let removed = cleanup_with_retries(
            &profile,
            3,
            Duration::from_millis(1),
            |_| {
                *calls.borrow_mut() += 1;
                Err(io::Error::new(io::ErrorKind::Other, "still open"))
            },
        );
        assert!(!removed);
        assert_eq!(*calls.borrow(), 3);
        std::fs::remove_dir_all(&profile).unwrap();
    }
}
