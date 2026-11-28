// SPDX-License-Identifier: GPL-3.0-only
//! Existing Voxelight Launcher installation detection and SemVer comparison.
use serde::Serialize;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

pub const PRODUCT_NAME: &str = "Voxelight Launcher";
pub const MAIN_BINARY_NAME: &str = "voxelight-launcher.exe";
pub const UNINSTALL_SUBKEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Voxelight Launcher";
pub const REMEMBERED_SUBKEY: &str = r"Software\voxelight\Voxelight Launcher";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PreIdent {
    Numeric(u64),
    Alpha(String),
}

impl Ord for PreIdent {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Numeric(a), Self::Numeric(b)) => a.cmp(b),
            // SemVer 2.0.0: numeric identifiers always have lower precedence than non-numeric.
            (Self::Numeric(_), Self::Alpha(_)) => Ordering::Less,
            (Self::Alpha(_), Self::Numeric(_)) => Ordering::Greater,
            (Self::Alpha(a), Self::Alpha(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for PreIdent {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Vec<PreIdent>,
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                // Stable release > any pre-release of the same core version.
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => self.pre.cmp(&other.pre),
            })
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Parses a SemVer string (`v?MAJOR.MINOR.PATCH[-prerelease][+build]`).
pub fn parse_semver(input: &str) -> Option<SemVer> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return None;
    }
    let without_v = trimmed.strip_prefix('v').unwrap_or(trimmed);
    let without_build = without_v.split('+').next()?;
    let (core, pre_part) = match without_build.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (without_build, None),
    };

    let mut parts = core.split('.');
    let mut parse_num = || -> Option<u64> {
        let token = parts.next()?;
        if token.is_empty()
            || !token.bytes().all(|byte| byte.is_ascii_digit())
            || (token.len() > 1 && token.starts_with('0'))
        {
            return None;
        }
        token.parse().ok()
    };
    let major = parse_num()?;
    let minor = parse_num()?;
    let patch = parse_num()?;
    if parts.next().is_some() {
        return None;
    }

    let mut pre = Vec::new();
    if let Some(pre_str) = pre_part {
        if pre_str.is_empty() {
            return None;
        }
        for ident in pre_str.split('.') {
            if ident.is_empty()
                || !ident
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return None;
            }
            if ident.bytes().all(|byte| byte.is_ascii_digit()) {
                if ident.len() > 1 && ident.starts_with('0') {
                    return None;
                }
                pre.push(PreIdent::Numeric(ident.parse().ok()?));
            } else {
                pre.push(PreIdent::Alpha(ident.to_owned()));
            }
        }
    }

    Some(SemVer {
        major,
        minor,
        patch,
        pre,
    })
}

/// Raw registry snapshot for existing install detection (testable without touching Windows registry).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExistingInstallRecord {
    pub uninstall_present: bool,
    pub install_location: Option<String>,
    pub display_version: Option<String>,
    pub remembered_dir: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InstallRelation {
    Fresh,
    #[serde(rename_all = "camelCase")]
    Update {
        installed_version: String,
        target_version: String,
    },
    #[serde(rename_all = "camelCase")]
    Reinstall {
        version: String,
    },
    #[serde(rename_all = "camelCase")]
    DowngradeBlocked {
        installed_version: String,
        target_version: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedInstall {
    pub relation: InstallRelation,
    pub install_dir: String,
    pub is_existing: bool,
    /// True only while `install_dir` still holds the installed launcher. Setup
    /// then keeps that folder: its silent NSIS run skips the reinstall page, so
    /// installing elsewhere would leave the old copy behind. False for a fresh
    /// install and for a registered folder whose launcher is gone (a deleted
    /// folder or a disconnected drive), where the user may choose a folder.
    pub path_locked: bool,
}

fn clean_registry_path(raw: Option<&str>) -> Option<PathBuf> {
    let trimmed = raw?.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

/// Computes default install location `%LOCALAPPDATA%\Voxelight Launcher`.
pub fn default_install_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\User\AppData\Local"))
        .join(PRODUCT_NAME)
}

/// Resolves whether an existing installation is present, whether this run is a
/// fresh install, update, reinstall, or blocked downgrade, and which directory
/// to keep.
///
/// Mirrors `installer.nsi`:
/// - `InstallLocation` in Uninstall key is stored quoted (`"$INSTDIR"`).
/// - The remembered folder under `Software\voxelight\Voxelight Launcher` is only
///   used when it still contains `voxelight-launcher.exe`.
/// - Downgrading from a newer installed SemVer is refused (`allowDowngrades: false`).
pub fn resolve_existing_install(
    record: &ExistingInstallRecord,
    default_dir: &Path,
    installer_version: &str,
    exe_exists: impl Fn(&Path) -> bool,
) -> DetectedInstall {
    let uninstall_dir = clean_registry_path(record.install_location.as_deref());
    let remembered_dir = clean_registry_path(record.remembered_dir.as_deref())
        .filter(|dir| exe_exists(&dir.join(MAIN_BINARY_NAME)));

    let has_existing = record.uninstall_present || remembered_dir.is_some();
    if !has_existing {
        return DetectedInstall {
            relation: InstallRelation::Fresh,
            install_dir: default_dir.to_string_lossy().into_owned(),
            is_existing: false,
            path_locked: false,
        };
    }

    // `remembered_dir` is only kept when it still holds the launcher, so only
    // the first two arms point at a live installation.
    let (kept_dir, path_locked) = match (&uninstall_dir, &remembered_dir) {
        (Some(uninst), _) if exe_exists(&uninst.join(MAIN_BINARY_NAME)) => (uninst.clone(), true),
        (_, Some(rem)) => (rem.clone(), true),
        (Some(uninst), None) => (uninst.clone(), false),
        (None, None) => (default_dir.to_path_buf(), false),
    };

    let installed_str = record
        .display_version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let relation = match (installed_str.and_then(parse_semver), parse_semver(installer_version)) {
        (Some(installed), Some(target)) => match target.cmp(&installed) {
            Ordering::Greater => InstallRelation::Update {
                installed_version: installed_str.unwrap_or_default().to_owned(),
                target_version: installer_version.to_owned(),
            },
            Ordering::Equal => InstallRelation::Reinstall {
                version: installer_version.to_owned(),
            },
            Ordering::Less => InstallRelation::DowngradeBlocked {
                installed_version: installed_str.unwrap_or_default().to_owned(),
                target_version: installer_version.to_owned(),
            },
        },
        _ => InstallRelation::Reinstall {
            version: installer_version.to_owned(),
        },
    };

    DetectedInstall {
        relation,
        install_dir: kept_dir.to_string_lossy().into_owned(),
        is_existing: true,
        path_locked,
    }
}

#[cfg(windows)]
pub fn read_system_install_record() -> ExistingInstallRecord {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WOW64_64KEY};
    let hkcu = winreg::RegKey::predef(HKEY_CURRENT_USER);
    let mut record = ExistingInstallRecord::default();

    if let Ok(key) = hkcu
        .open_subkey_with_flags(UNINSTALL_SUBKEY, KEY_READ | KEY_WOW64_64KEY)
        .or_else(|_| hkcu.open_subkey_with_flags(UNINSTALL_SUBKEY, KEY_READ))
    {
        let install_location: Option<String> = key.get_value("InstallLocation").ok();
        let display_version: Option<String> = key.get_value("DisplayVersion").ok();
        let uninstall_string: Option<String> = key.get_value("UninstallString").ok();
        let default_value: Option<String> = key.get_value("").ok();
        record.uninstall_present = uninstall_string.as_deref().is_some_and(|v| !v.trim().is_empty())
            || display_version.as_deref().is_some_and(|v| !v.trim().is_empty())
            || install_location.as_deref().is_some_and(|v| !v.trim().is_empty())
            || default_value.as_deref().is_some_and(|v| !v.trim().is_empty());
        record.install_location = install_location;
        record.display_version = display_version;
    }

    if let Ok(key) = hkcu
        .open_subkey_with_flags(REMEMBERED_SUBKEY, KEY_READ | KEY_WOW64_64KEY)
        .or_else(|_| hkcu.open_subkey_with_flags(REMEMBERED_SUBKEY, KEY_READ))
    {
        record.remembered_dir = key.get_value::<String, _>("").ok();
    }

    record
}

#[cfg(not(windows))]
pub fn read_system_install_record() -> ExistingInstallRecord {
    ExistingInstallRecord::default()
}

pub fn detect_existing_install(installer_version: &str) -> DetectedInstall {
    let record = read_system_install_record();
    let default_dir = default_install_dir();
    resolve_existing_install(&record, &default_dir, installer_version, |exe| exe.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_ordering_matches_prerelease_and_stable_rules() {
        assert!(parse_semver("0.7.0").unwrap() > parse_semver("0.7.0-beta.2").unwrap());
        assert!(parse_semver("0.7.0-beta.2").unwrap() > parse_semver("0.7.0-beta.1").unwrap());
        assert!(parse_semver("0.7.0-rc.1").unwrap() > parse_semver("0.7.0-beta.9").unwrap());
        assert!(parse_semver("0.7.0-beta.10").unwrap() > parse_semver("0.7.0-beta.2").unwrap());
        assert!(parse_semver("1.0.0").unwrap() > parse_semver("0.9.9").unwrap());
        assert_eq!(parse_semver("0.7.0-beta.2"), parse_semver("v0.7.0-beta.2"));
        assert!(parse_semver("not-semver").is_none());
        assert!(parse_semver("01.2.3").is_none());
    }

    #[test]
    fn fresh_install_uses_default_dir_and_ignores_stale_remembered_folder() {
        let default_dir = Path::new(r"C:\Users\User\AppData\Local\Voxelight Launcher");
        let stale = ExistingInstallRecord {
            uninstall_present: false,
            install_location: None,
            display_version: None,
            remembered_dir: Some(r"C:\Temp\DeletedFolder".into()),
        };
        let detected = resolve_existing_install(&stale, default_dir, "0.7.0", |_| false);
        assert_eq!(detected.relation, InstallRelation::Fresh);
        assert_eq!(detected.install_dir, default_dir.to_string_lossy());
        assert!(!detected.is_existing);
        assert!(!detected.path_locked);
    }

    #[test]
    fn update_from_older_version_strips_quotes_and_keeps_folder() {
        let default_dir = Path::new(r"C:\Users\User\AppData\Local\Voxelight Launcher");
        let custom_dir = r"D:\Games\Voxelight Launcher";
        let record = ExistingInstallRecord {
            uninstall_present: true,
            install_location: Some(format!("\"{custom_dir}\"")),
            display_version: Some("0.7.0-beta.1".into()),
            remembered_dir: Some(custom_dir.into()),
        };
        let detected = resolve_existing_install(&record, default_dir, "0.7.0-beta.2", |path| {
            path == Path::new(custom_dir).join(MAIN_BINARY_NAME)
        });
        assert_eq!(
            detected.relation,
            InstallRelation::Update {
                installed_version: "0.7.0-beta.1".into(),
                target_version: "0.7.0-beta.2".into(),
            }
        );
        assert_eq!(detected.install_dir, custom_dir);
        assert!(detected.is_existing);
        assert!(detected.path_locked, "a live installation keeps its folder");
    }

    #[test]
    fn registered_folder_without_the_launcher_is_suggested_but_not_forced() {
        // Installed by the beta.2 NSIS page onto an external drive that is gone.
        let default_dir = Path::new(r"C:\Users\User\AppData\Local\Voxelight Launcher");
        let missing_dir = r"E:\Voxelight Launcher";
        let record = ExistingInstallRecord {
            uninstall_present: true,
            install_location: Some(format!("\"{missing_dir}\"")),
            display_version: Some("0.7.0-beta.2".into()),
            remembered_dir: Some(missing_dir.into()),
        };
        let detected = resolve_existing_install(&record, default_dir, "0.7.0-beta.3", |_| false);
        assert_eq!(
            detected.relation,
            InstallRelation::Update {
                installed_version: "0.7.0-beta.2".into(),
                target_version: "0.7.0-beta.3".into(),
            },
            "the relation, and with it the downgrade guard, is kept"
        );
        assert_eq!(detected.install_dir, missing_dir);
        assert!(detected.is_existing);
        assert!(!detected.path_locked, "the user must be able to choose another folder");

        let no_location = ExistingInstallRecord {
            install_location: None,
            remembered_dir: None,
            ..record
        };
        let detected = resolve_existing_install(&no_location, default_dir, "0.7.0-beta.3", |_| false);
        assert_eq!(detected.install_dir, default_dir.to_string_lossy());
        assert!(detected.is_existing);
        assert!(!detected.path_locked);
    }

    #[test]
    fn only_a_folder_that_still_holds_the_launcher_is_locked() {
        let default_dir = Path::new(r"C:\Users\User\AppData\Local\Voxelight Launcher");
        let registered = r"C:\ProgramData\Voxelight Launcher";
        let record = ExistingInstallRecord {
            uninstall_present: true,
            install_location: Some(format!("\"{registered}\"")),
            display_version: Some("0.7.0-beta.2".into()),
            remembered_dir: None,
        };
        let live = resolve_existing_install(&record, default_dir, "0.7.0-beta.3", |path| {
            path == Path::new(registered).join(MAIN_BINARY_NAME)
        });
        assert_eq!(live.install_dir, registered);
        assert!(live.path_locked);

        let gone = resolve_existing_install(&record, default_dir, "0.7.0-beta.3", |_| false);
        assert_eq!(gone.install_dir, registered);
        assert!(!gone.path_locked);
    }

    #[test]
    fn same_version_is_reinstall() {
        let default_dir = Path::new(r"C:\Users\User\AppData\Local\Voxelight Launcher");
        let record = ExistingInstallRecord {
            uninstall_present: true,
            install_location: Some(r"C:\Users\User\AppData\Local\Voxelight Launcher".into()),
            display_version: Some("0.7.0-beta.2".into()),
            remembered_dir: None,
        };
        let detected = resolve_existing_install(&record, default_dir, "0.7.0-beta.2", |_| true);
        assert_eq!(
            detected.relation,
            InstallRelation::Reinstall {
                version: "0.7.0-beta.2".into(),
            }
        );
        assert!(detected.is_existing);
    }

    #[test]
    fn newer_installed_version_refuses_downgrade() {
        let default_dir = Path::new(r"C:\Users\User\AppData\Local\Voxelight Launcher");
        let record = ExistingInstallRecord {
            uninstall_present: true,
            install_location: Some(r"C:\Users\User\AppData\Local\Voxelight Launcher".into()),
            display_version: Some("0.7.0".into()),
            remembered_dir: None,
        };
        let detected = resolve_existing_install(&record, default_dir, "0.7.0-beta.2", |_| true);
        assert_eq!(
            detected.relation,
            InstallRelation::DowngradeBlocked {
                installed_version: "0.7.0".into(),
                target_version: "0.7.0-beta.2".into(),
            }
        );
        assert!(detected.is_existing);
    }

    #[test]
    fn remembered_folder_with_executable_is_kept_when_uninstall_location_missing() {
        let default_dir = Path::new(r"C:\Users\User\AppData\Local\Voxelight Launcher");
        let remembered = r"D:\Voxelight";
        let record = ExistingInstallRecord {
            uninstall_present: false,
            install_location: None,
            display_version: None,
            remembered_dir: Some(remembered.into()),
        };
        let detected = resolve_existing_install(&record, default_dir, "0.7.0", |path| {
            path == Path::new(remembered).join(MAIN_BINARY_NAME)
        });
        assert_eq!(
            detected.relation,
            InstallRelation::Reinstall {
                version: "0.7.0".into(),
            }
        );
        assert_eq!(detected.install_dir, remembered);
        assert!(detected.is_existing);
        assert!(detected.path_locked);
    }
}
