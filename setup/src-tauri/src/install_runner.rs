// SPDX-License-Identifier: GPL-3.0-only
//! Interactive installation execution: extract -> silent NSIS install (with byte-based estimate) -> verify.
use crate::args::{apply_nsis_args, build_silent_install_args};
use crate::path_check::{validate_install_path, SystemPathProbe};
use crate::payload::{
    ordinary_file, ExtractedPayload, EXPECTED_INSTALL_BYTES, PAYLOAD_BYTES, PAYLOAD_SHA256,
};
use crate::registry::{detect_existing_install, DetectedInstall, InstallRelation, MAIN_BINARY_NAME};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub install_dir: String,
    pub create_shortcuts: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub phase: String,
    pub completed: u64,
    pub total: u64,
    pub indeterminate: bool,
    pub bytes_written: u64,
    pub expected_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallFailure {
    pub code: String,
    pub phase: String,
    pub exit_code: Option<i32>,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub install_dir: String,
    pub executable_path: String,
}

#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_meta: &fs::Metadata) -> bool {
    false
}

/// Sums regular file sizes under `dir` (bounded depth to stay fast and safe).
/// When `modified_after` is provided, only files modified at or after that time are counted.
pub fn measure_directory_bytes(dir: &Path, modified_after: Option<SystemTime>) -> u64 {
    fn walk(path: &Path, depth: u8, modified_after: Option<SystemTime>, acc: &mut u64) {
        if depth > 12 {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() || is_reparse_point(&meta) {
                // A junction or symbolic link can point outside the install
                // folder; the byte estimate must only count files NSIS writes
                // inside it.
                continue;
            }
            if meta.is_dir() {
                walk(&entry.path(), depth + 1, modified_after, acc);
            } else if meta.is_file() {
                if let Some(since) = modified_after {
                    let touched = meta.modified().is_ok_and(|mtime| mtime >= since);
                    if !touched {
                        continue;
                    }
                }
                *acc = acc.saturating_add(meta.len());
            }
        }
    }
    let mut total = 0u64;
    walk(dir, 0, modified_after, &mut total);
    total
}

/// Refuses the silent NSIS run while the installed launcher is still running.
///
/// The NSIS template's `CheckIfAppIsRunning` force-closes the app in silent
/// mode. The interactive UI must ask the user first (the launcher may be
/// mid-download or mid-game), so this is a normal retryable error instead.
pub fn ensure_launcher_closed(
    target_dir: &Path,
    running: bool,
) -> Result<(), InstallFailure> {
    if !running {
        return Ok(());
    }
    Err(InstallFailure {
        code: "launcherRunning".into(),
        phase: "preflight".into(),
        exit_code: None,
        detail: format!(
            "Voxelight Launcher is running from {}. Close it and try again.",
            target_dir.display()
        ),
    })
}

/// Maps an NSIS or Windows exit code to a stable localization key.
pub fn exit_code_error_key(exit_code: i32) -> &'static str {
    match exit_code {
        1 => "nsisExit1",
        2 => "nsisExit2",
        5 => "nsisExit5",
        112 => "nsisExit112",
        1223 => "nsisExit1223",
        1602 => "nsisExit1602",
        1618 => "nsisExit1618",
        _ => "nsisExitOther",
    }
}

/// Maps the three real phases onto a unified 0..=1000 progress scale so the
/// lattice progress bar advances smoothly across extract, install, and verify.
pub fn compute_install_progress(
    bytes_written: u64,
    expected_bytes: u64,
    is_overwrite: bool,
) -> InstallProgress {
    let expected = expected_bytes.max(1);
    if is_overwrite && bytes_written == 0 {
        return InstallProgress {
            phase: "install".into(),
            completed: 0,
            total: 0,
            indeterminate: true,
            bytes_written: 0,
            expected_bytes: expected,
        };
    }
    let clamped = bytes_written.min(expected);
    // Extract occupies 0..150, install occupies 150..920, verify occupies 920..1000.
    let install_span = 770u64;
    let scaled = 150 + ((clamped.saturating_mul(install_span)) / expected).min(install_span - 10);
    InstallProgress {
        phase: "install".into(),
        completed: scaled,
        total: 1000,
        indeterminate: false,
        bytes_written,
        expected_bytes: expected,
    }
}

/// The folder the silent NSIS run installs into. A live installation keeps its
/// folder whatever the UI sent (see `DetectedInstall::path_locked`); otherwise
/// the user's choice is used, so a registered folder whose launcher is gone
/// does not trap the user.
pub fn install_target(existing: &DetectedInstall, requested_dir: &str) -> String {
    if existing.path_locked {
        existing.install_dir.clone()
    } else {
        requested_dir.to_owned()
    }
}

/// The silent NSIS arguments for this run. Only a live installation that keeps
/// its folder is updated in place (`/UPDATE`). NSIS update mode never creates
/// shortcuts, so a stale registration installed into a new folder runs as an
/// ordinary silent install: it creates or retargets the shortcuts as the user
/// chose, and the template's downgrade guard still applies in silent mode.
pub fn silent_install_args(
    existing: &DetectedInstall,
    target_dir: &Path,
    create_shortcuts: bool,
) -> Vec<OsString> {
    let updates_in_place =
        existing.path_locked && matches!(existing.relation, InstallRelation::Update { .. });
    build_silent_install_args(target_dir, updates_in_place, create_shortcuts)
}

/// Runs the complete interactive installation flow synchronously on a blocking worker thread.
pub fn run_interactive_install(
    request: &InstallRequest,
    installer_version: &str,
    mut emit_progress: impl FnMut(InstallProgress),
) -> Result<InstallOutcome, InstallFailure> {
    let existing = detect_existing_install(installer_version);
    if matches!(existing.relation, InstallRelation::DowngradeBlocked { .. }) {
        return Err(InstallFailure {
            code: "downgradeBlocked".into(),
            phase: "extract".into(),
            exit_code: None,
            detail: "A newer version of Voxelight Launcher is already installed.".into(),
        });
    }
    let target_string = install_target(&existing, &request.install_dir);

    let validation = validate_install_path(&target_string, EXPECTED_INSTALL_BYTES, &SystemPathProbe);
    if !validation.valid {
        return Err(InstallFailure {
            code: validation.error_code.unwrap_or_else(|| "pathInvalid".into()),
            phase: "extract".into(),
            exit_code: None,
            detail: format!("Target folder is not valid: {}", validation.normalized_path),
        });
    }
    let target_dir = PathBuf::from(&validation.normalized_path);

    // The NSIS template kills a running launcher in silent mode. Detect it
    // before extracting or running anything so the user can close it and retry.
    ensure_launcher_closed(
        &target_dir,
        crate::process_scan::launcher_is_running(&target_dir),
    )?;

    // Phase 1: Extract & verify SHA-256 of the embedded NSIS payload.
    emit_progress(InstallProgress {
        phase: "extract".into(),
        completed: 0,
        total: 1000,
        indeterminate: false,
        bytes_written: 0,
        expected_bytes: EXPECTED_INSTALL_BYTES,
    });
    let base_temp = std::env::temp_dir();
    let mut extracted = ExtractedPayload::extract_verified(
        &base_temp,
        PAYLOAD_BYTES,
        PAYLOAD_SHA256,
        |written, total| {
            let scaled = if total > 0 {
                (written.saturating_mul(150)) / total
            } else {
                0
            };
            emit_progress(InstallProgress {
                phase: "extract".into(),
                completed: scaled.min(150),
                total: 1000,
                indeterminate: false,
                bytes_written: written,
                expected_bytes: total,
            });
        },
    )
    .map_err(|error| InstallFailure {
        code: error.code().into(),
        phase: "extract".into(),
        exit_code: None,
        detail: error.detail(),
    })?;

    extracted
        .reverify(PAYLOAD_BYTES.len() as u64, PAYLOAD_SHA256)
        .map_err(|error| InstallFailure {
            code: error.code().into(),
            phase: "extract".into(),
            exit_code: None,
            detail: error.detail(),
        })?;

    // Phase 2: Run silent NSIS payload and monitor bytes written under target_dir.
    let had_existing_exe = target_dir.join(MAIN_BINARY_NAME).exists();
    let initial_bytes = measure_directory_bytes(&target_dir, None);
    let started_at = SystemTime::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(SystemTime::now);

    emit_progress(compute_install_progress(
        0,
        EXPECTED_INSTALL_BYTES,
        had_existing_exe,
    ));

    let nsis_args = silent_install_args(&existing, &target_dir, request.create_shortcuts);
    let mut command = Command::new(extracted.path());
    apply_nsis_args(&mut command, &nsis_args);
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        let system32 = PathBuf::from(system_root).join("System32");
        if system32.is_dir() {
            command.current_dir(system32);
        }
    }

    let mut child = command.spawn().map_err(|error| InstallFailure {
        code: "spawnFailed".into(),
        phase: "install".into(),
        exit_code: error.raw_os_error(),
        detail: format!("Could not launch the installer engine: {error}"),
    })?;

    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(1),
            Ok(None) => {
                let written = if had_existing_exe {
                    let touched = measure_directory_bytes(&target_dir, Some(started_at));
                    let delta = measure_directory_bytes(&target_dir, None).saturating_sub(initial_bytes);
                    touched.max(delta)
                } else {
                    measure_directory_bytes(&target_dir, None).saturating_sub(initial_bytes)
                };
                emit_progress(compute_install_progress(
                    written,
                    EXPECTED_INSTALL_BYTES,
                    had_existing_exe,
                ));
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(error) => {
                let _ = child.wait();
                extracted.cleanup();
                return Err(InstallFailure {
                    code: "spawnFailed".into(),
                    phase: "install".into(),
                    exit_code: error.raw_os_error(),
                    detail: format!("Lost contact with the installer process: {error}"),
                });
            }
        }
    };

    extracted.cleanup();

    if exit_code != 0 && exit_code != 3010 {
        return Err(InstallFailure {
            code: exit_code_error_key(exit_code).into(),
            phase: "install".into(),
            exit_code: Some(exit_code),
            detail: format!("NSIS installer exited with code {exit_code}."),
        });
    }

    // Phase 3: Verify installed launcher executable is present and ordinary.
    emit_progress(InstallProgress {
        phase: "verify".into(),
        completed: 940,
        total: 1000,
        indeterminate: false,
        bytes_written: EXPECTED_INSTALL_BYTES,
        expected_bytes: EXPECTED_INSTALL_BYTES,
    });

    let installed_exe = target_dir.join(MAIN_BINARY_NAME);
    if !ordinary_file(&installed_exe) {
        return Err(InstallFailure {
            code: "verifyFailed".into(),
            phase: "verify".into(),
            exit_code: Some(exit_code),
            detail: format!(
                "Expected launcher executable was not found after installation: {}",
                installed_exe.display()
            ),
        });
    }

    emit_progress(InstallProgress {
        phase: "verify".into(),
        completed: 1000,
        total: 1000,
        indeterminate: false,
        bytes_written: EXPECTED_INSTALL_BYTES,
        expected_bytes: EXPECTED_INSTALL_BYTES,
    });

    Ok(InstallOutcome {
        install_dir: validation.normalized_path,
        executable_path: installed_exe.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_known_and_unknown_nsis_exit_codes() {
        assert_eq!(exit_code_error_key(1), "nsisExit1");
        assert_eq!(exit_code_error_key(2), "nsisExit2");
        assert_eq!(exit_code_error_key(5), "nsisExit5");
        assert_eq!(exit_code_error_key(112), "nsisExit112");
        assert_eq!(exit_code_error_key(1223), "nsisExit1223");
        assert_eq!(exit_code_error_key(1602), "nsisExit1602");
        assert_eq!(exit_code_error_key(1618), "nsisExit1618");
        assert_eq!(exit_code_error_key(99), "nsisExitOther");
    }

    #[test]
    fn install_progress_scales_bytes_and_handles_overwrite_scanning() {
        let mid = compute_install_progress(18 * 1024 * 1024, 36 * 1024 * 1024, false);
        assert_eq!(mid.phase, "install");
        assert!(!mid.indeterminate);
        assert!(mid.completed > 150 && mid.completed < 920);
        assert_eq!(mid.total, 1000);

        let overwrite_idle = compute_install_progress(0, 36 * 1024 * 1024, true);
        assert!(overwrite_idle.indeterminate);
        assert_eq!(overwrite_idle.total, 0);
    }

    #[test]
    fn only_a_live_installation_overrides_the_chosen_folder() {
        let update = InstallRelation::Update {
            installed_version: "0.7.0-beta.2".into(),
            target_version: "0.7.0-beta.3".into(),
        };
        let chosen = r"D:\Games\Voxelight Launcher";

        let live = DetectedInstall {
            relation: update.clone(),
            install_dir: r"C:\Users\User\AppData\Local\Voxelight Launcher".into(),
            is_existing: true,
            path_locked: true,
        };
        assert_eq!(install_target(&live, chosen), live.install_dir);

        // The registered folder is on a drive that is gone: the user's choice wins.
        let stale = DetectedInstall {
            relation: update,
            install_dir: r"E:\Voxelight Launcher".into(),
            is_existing: true,
            path_locked: false,
        };
        assert_eq!(install_target(&stale, chosen), chosen);

        let fresh = DetectedInstall {
            relation: InstallRelation::Fresh,
            install_dir: r"C:\Users\User\AppData\Local\Voxelight Launcher".into(),
            is_existing: false,
            path_locked: false,
        };
        assert_eq!(install_target(&fresh, chosen), chosen);
    }

    #[test]
    fn a_relocated_stale_registration_is_not_an_nsis_update() {
        fn args(items: &[&str]) -> Vec<OsString> {
            items.iter().map(OsString::from).collect()
        }
        let update = InstallRelation::Update {
            installed_version: "0.7.0-beta.2".into(),
            target_version: "0.7.0-beta.3".into(),
        };
        let kept = Path::new(r"C:\Users\User\AppData\Local\Voxelight Launcher");
        let chosen = Path::new(r"D:\Games\Voxelight Launcher");

        // A live installation is updated in place and NSIS keeps its shortcuts.
        let live = DetectedInstall {
            relation: update.clone(),
            install_dir: kept.to_string_lossy().into_owned(),
            is_existing: true,
            path_locked: true,
        };
        assert_eq!(
            silent_install_args(&live, kept, true),
            args(&["/S", "/UPDATE", r"/D=C:\Users\User\AppData\Local\Voxelight Launcher"])
        );

        // The registered folder is gone and the user chose another one: NSIS
        // update mode would skip every shortcut, so this runs as a plain silent
        // install that follows the shortcut choice.
        let stale = DetectedInstall {
            relation: update,
            install_dir: r"E:\Voxelight Launcher".into(),
            is_existing: true,
            path_locked: false,
        };
        assert_eq!(
            silent_install_args(&stale, chosen, true),
            args(&["/S", r"/D=D:\Games\Voxelight Launcher"])
        );
        assert_eq!(
            silent_install_args(&stale, chosen, false),
            args(&["/S", "/NS", r"/D=D:\Games\Voxelight Launcher"])
        );

        let reinstall = DetectedInstall {
            relation: InstallRelation::Reinstall {
                version: "0.7.0-beta.3".into(),
            },
            install_dir: kept.to_string_lossy().into_owned(),
            is_existing: true,
            path_locked: true,
        };
        assert_eq!(
            silent_install_args(&reinstall, kept, false),
            args(&["/S", "/NS", r"/D=C:\Users\User\AppData\Local\Voxelight Launcher"])
        );
    }

    #[test]
    fn a_running_launcher_is_a_retryable_preflight_error() {
        let target = Path::new(r"D:\Games\Voxelight Launcher");
        assert!(ensure_launcher_closed(target, false).is_ok());

        let failure = ensure_launcher_closed(target, true).unwrap_err();
        assert_eq!(failure.code, "launcherRunning");
        assert_eq!(failure.phase, "preflight");
        assert_eq!(failure.exit_code, None);
        assert!(failure.detail.contains("voxelight-launcher") || failure.detail.contains("Voxelight"));
    }

    #[test]
    fn measures_nested_directory_bytes() {
        let root = std::env::temp_dir().join(format!(
            "voxelight-setup-measure-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.bin"), vec![1u8; 1024]).unwrap();
        fs::write(root.join("sub/b.bin"), vec![2u8; 2048]).unwrap();
        assert_eq!(measure_directory_bytes(&root, None), 3072);
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn byte_monitor_does_not_follow_junctions_outside_the_install_folder() {
        let root = std::env::temp_dir().join(format!(
            "voxelight-setup-junction-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let install = root.join("install");
        let outside = root.join("outside");
        fs::create_dir_all(&install).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(install.join("inside.bin"), vec![1u8; 1024]).unwrap();
        fs::write(outside.join("outside.bin"), vec![2u8; 2048]).unwrap();
        let link = install.join("link");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("mklink should run");
        assert!(status.success(), "could not create test junction");

        assert_eq!(
            measure_directory_bytes(&install, None),
            1024,
            "only files written inside the install folder may be counted"
        );

        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }
}
