// SPDX-License-Identifier: GPL-3.0-only
//! Installation path validation without writing files into the user's target folder.
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Safety margin added on top of the expected installed size (32 MiB).
const SPACE_MARGIN_BYTES: u64 = 32 * 1024 * 1024;
const MIN_REQUIRED_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathValidation {
    pub valid: bool,
    pub normalized_path: String,
    pub error_code: Option<String>,
    pub available_bytes: Option<u64>,
    pub required_bytes: u64,
}

impl PathValidation {
    fn invalid(normalized_path: String, code: &str, available_bytes: Option<u64>, required_bytes: u64) -> Self {
        Self {
            valid: false,
            normalized_path,
            error_code: Some(code.to_owned()),
            available_bytes,
            required_bytes,
        }
    }

    fn ok(normalized_path: String, available_bytes: Option<u64>, required_bytes: u64) -> Self {
        Self {
            valid: true,
            normalized_path,
            error_code: None,
            available_bytes,
            required_bytes,
        }
    }
}

pub fn required_disk_bytes(expected_install_bytes: u64) -> u64 {
    expected_install_bytes
        .saturating_add(SPACE_MARGIN_BYTES)
        .max(MIN_REQUIRED_BYTES)
}

/// System probes used for path validation; tests supply fakes without touching real drives.
pub trait PathProbe {
    fn protected_roots(&self) -> Vec<String>;
    /// Folders every local user can write to; installs must not live there.
    fn shared_writable_roots(&self) -> Vec<String>;
    fn exists(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
    fn is_file(&self, path: &Path) -> bool;
    fn is_reparse_point(&self, path: &Path) -> bool;
    /// Resolves an existing folder to its canonical path (Windows
    /// `GetFinalPathNameByHandleW`). Used to catch 8.3 aliases and other
    /// spellings of a protected folder before comparing.
    fn real_path(&self, path: &Path) -> Option<PathBuf>;
    fn is_dir_writable(&self, dir: &Path) -> bool;
    fn free_disk_bytes(&self, dir: &Path) -> Option<u64>;
}

pub struct SystemPathProbe;

#[cfg(windows)]
mod win_fs {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    const FILE_READ_ONLY_VOLUME: u32 = 0x0008_0000;
    const OWNER_SECURITY_INFORMATION: u32 = 0x0000_0001;
    const GROUP_SECURITY_INFORMATION: u32 = 0x0000_0002;
    const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    const FILE_ADD_FILE: u32 = 0x0002;
    const FILE_ADD_SUBDIRECTORY: u32 = 0x0004;
    const STANDARD_RIGHTS_REQUIRED: u32 = 0x000F_0000;
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const FILE_GENERIC_READ: u32 = 0x0012_0089;
    const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
    const FILE_GENERIC_EXECUTE: u32 = 0x0012_00A0;
    const FILE_ALL_ACCESS: u32 = STANDARD_RIGHTS_REQUIRED | SYNCHRONIZE | 0x1FF;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const ERROR_NOT_SUPPORTED: u32 = 50;
    const ERROR_INVALID_FUNCTION: u32 = 1;
    const TOKEN_IMPERSONATE: u32 = 0x0004;
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_DUPLICATE: u32 = 0x0002;
    const SECURITY_IMPERSONATION: i32 = 2;

    #[repr(C)]
    struct GenericMapping {
        generic_read: u32,
        generic_write: u32,
        generic_execute: u32,
        generic_all: u32,
    }

    #[repr(C)]
    struct PrivilegeSet {
        privilege_count: u32,
        control: u32,
        privilege: [u32; 3],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            file_name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *mut core::ffi::c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: isize,
        ) -> isize;
        fn GetFinalPathNameByHandleW(
            file: isize,
            file_path: *mut u16,
            file_path_length: u32,
            flags: u32,
        ) -> u32;
        fn GetDiskFreeSpaceExW(
            directory_name: *const u16,
            free_bytes_available_to_caller: *mut u64,
            total_number_of_bytes: *mut u64,
            total_number_of_free_bytes: *mut u64,
        ) -> i32;
        fn GetVolumeInformationW(
            root_path_name: *const u16,
            volume_name_buffer: *mut u16,
            volume_name_size: u32,
            volume_serial_number: *mut u32,
            maximum_component_length: *mut u32,
            file_system_flags: *mut u32,
            file_system_name_buffer: *mut u16,
            file_system_name_size: u32,
        ) -> i32;
        fn GetCurrentProcess() -> isize;
        fn CloseHandle(handle: isize) -> i32;
        fn GetLastError() -> u32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn GetFileSecurityW(
            file_name: *const u16,
            requested_information: u32,
            security_descriptor: *mut u8,
            length: u32,
            length_needed: *mut u32,
        ) -> i32;
        fn OpenProcessToken(
            process_handle: isize,
            desired_access: u32,
            token_handle: *mut isize,
        ) -> i32;
        fn DuplicateToken(
            existing_token: isize,
            impersonation_level: i32,
            duplicate_token: *mut isize,
        ) -> i32;
        fn MapGenericMask(access_mask: *mut u32, generic_mapping: *const GenericMapping);
        fn AccessCheck(
            security_descriptor: *const u8,
            client_token: isize,
            desired_access: u32,
            generic_mapping: *const GenericMapping,
            privilege_set: *mut PrivilegeSet,
            privilege_set_length: *mut u32,
            granted_access: *mut u32,
            access_status: *mut i32,
        ) -> i32;
    }

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    const FILE_SHARE_DELETE: u32 = 0x0000_0004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const INVALID_HANDLE_VALUE: isize = -1;
    const FILE_NAME_NORMALIZED: u32 = 0x0;
    const VOLUME_NAME_DOS: u32 = 0x0;

    /// Resolves an existing path to its final (real) path using
    /// `GetFinalPathNameByHandleW`. Returns `None` when the path cannot be
    /// opened (for example a folder the user may not traverse).
    pub fn real_path(path: &Path) -> Option<std::path::PathBuf> {
        use std::os::windows::ffi::OsStringExt;

        let w = wide(path.as_os_str());
        let handle = unsafe {
            CreateFileW(
                w.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                0,
            )
        };
        if handle == INVALID_HANDLE_VALUE || handle == 0 {
            return None;
        }
        let mut buffer = vec![0u16; 512];
        loop {
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    handle,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            };
            if length == 0 {
                unsafe { CloseHandle(handle) };
                return None;
            }
            if length as usize >= buffer.len() {
                buffer.resize(length as usize + 1, 0);
                continue;
            }
            unsafe { CloseHandle(handle) };
            buffer.truncate(length as usize);
            let raw = std::ffi::OsString::from_wide(&buffer);
            let text = raw.to_string_lossy();
            let normalized = text.strip_prefix(r"\\?\").unwrap_or(&text);
            return Some(std::path::PathBuf::from(normalized));
        }
    }

    pub fn free_disk_bytes(dir: &Path) -> Option<u64> {
        let w = wide(dir.as_os_str());
        let mut available = 0u64;
        let mut total = 0u64;
        let mut free = 0u64;
        let ok = unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut available, &mut total, &mut free) };
        if ok != 0 {
            Some(available)
        } else {
            None
        }
    }

    fn is_read_only_volume(dir: &Path) -> bool {
        let text = dir.to_string_lossy();
        let Some(drive) = text.get(0..2) else {
            return false;
        };
        let root = format!("{drive}\\");
        let w = wide(OsStr::new(&root));
        let mut flags = 0u32;
        let ok = unsafe {
            GetVolumeInformationW(
                w.as_ptr(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut flags,
                std::ptr::null_mut(),
                0,
            )
        };
        ok != 0 && (flags & FILE_READ_ONLY_VOLUME) != 0
    }

    /// Checks directory write permission using Windows security descriptors (`AccessCheck`)
    /// without creating any probe file on disk.
    pub fn is_dir_writable(dir: &Path) -> bool {
        if is_read_only_volume(dir) {
            return false;
        }
        let w = wide(dir.as_os_str());
        let info = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
        let mut needed = 0u32;
        let first = unsafe { GetFileSecurityW(w.as_ptr(), info, std::ptr::null_mut(), 0, &mut needed) };
        if first == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_NOT_SUPPORTED || err == ERROR_INVALID_FUNCTION {
                // Non-ACL filesystem (e.g. FAT32/exFAT) and volume is not read-only.
                return true;
            }
            if err != ERROR_INSUFFICIENT_BUFFER || needed == 0 {
                return false;
            }
        }
        let mut sd = vec![0u8; needed as usize];
        let second = unsafe { GetFileSecurityW(w.as_ptr(), info, sd.as_mut_ptr(), needed, &mut needed) };
        if second == 0 {
            return false;
        }

        let mut process_token = 0isize;
        let opened = unsafe {
            OpenProcessToken(
                GetCurrentProcess(),
                TOKEN_IMPERSONATE | TOKEN_QUERY | TOKEN_DUPLICATE,
                &mut process_token,
            )
        };
        if opened == 0 {
            return false;
        }
        let mut imp_token = 0isize;
        let dup = unsafe { DuplicateToken(process_token, SECURITY_IMPERSONATION, &mut imp_token) };
        unsafe { CloseHandle(process_token) };
        if dup == 0 {
            return false;
        }

        let mapping = GenericMapping {
            generic_read: FILE_GENERIC_READ,
            generic_write: FILE_GENERIC_WRITE,
            generic_execute: FILE_GENERIC_EXECUTE,
            generic_all: FILE_ALL_ACCESS,
        };
        let mut desired = FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY;
        unsafe { MapGenericMask(&mut desired, &mapping) };
        let mut priv_set = PrivilegeSet {
            privilege_count: 0,
            control: 0,
            privilege: [0; 3],
        };
        let mut priv_len = std::mem::size_of::<PrivilegeSet>() as u32;
        let mut granted = 0u32;
        let mut status = 0i32;
        let checked = unsafe {
            AccessCheck(
                sd.as_ptr(),
                imp_token,
                desired,
                &mapping,
                &mut priv_set,
                &mut priv_len,
                &mut granted,
                &mut status,
            )
        };
        unsafe { CloseHandle(imp_token) };
        checked != 0 && status != 0
    }
}

impl PathProbe for SystemPathProbe {
    fn protected_roots(&self) -> Vec<String> {
        let mut roots = Vec::new();
        for key in ["SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Ok(value) = std::env::var(key) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    roots.push(trimmed.to_owned());
                }
            }
        }
        for fallback in [r"C:\Windows", r"C:\Program Files", r"C:\Program Files (x86)"] {
            roots.push(fallback.to_owned());
        }
        roots
    }

    fn shared_writable_roots(&self) -> Vec<String> {
        let mut roots = Vec::new();
        for key in ["ProgramData", "PUBLIC"] {
            if let Ok(value) = std::env::var(key) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    roots.push(trimmed.to_owned());
                }
            }
        }
        for fallback in [r"C:\ProgramData", r"C:\Users\Public"] {
            roots.push(fallback.to_owned());
        }
        roots
    }

    fn exists(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok()
    }

    fn is_dir(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
    }

    fn is_file(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
    }

    fn is_reparse_point(&self, path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok_and(|meta| {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return true;
                }
            }
            meta.file_type().is_symlink()
        })
    }

    fn real_path(&self, path: &Path) -> Option<PathBuf> {
        #[cfg(windows)]
        {
            win_fs::real_path(path)
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            None
        }
    }

    fn is_dir_writable(&self, dir: &Path) -> bool {
        #[cfg(windows)]
        {
            win_fs::is_dir_writable(dir)
        }
        #[cfg(not(windows))]
        {
            std::fs::metadata(dir).is_ok_and(|meta| !meta.permissions().readonly())
        }
    }

    fn free_disk_bytes(&self, dir: &Path) -> Option<u64> {
        #[cfg(windows)]
        {
            win_fs::free_disk_bytes(dir)
        }
        #[cfg(not(windows))]
        {
            let _ = dir;
            None
        }
    }
}

fn is_reserved_device_name(component: &str) -> bool {
    let stem = component.split('.').next().unwrap_or(component);
    let upper = stem.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// Parses and lexically normalizes a Windows drive-qualified path (`X:\a\b`).
/// Returns `Err(error_code)` when syntax is invalid or non-absolute.
fn parse_windows_drive_path(raw: &str) -> Result<(String, Vec<String>), &'static str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("path.empty");
    }
    if trimmed.chars().any(|ch| ch.is_control() || matches!(ch, '"' | '<' | '>' | '|' | '?' | '*')) {
        return Err("path.invalidChars");
    }
    let normalized = trimmed.replace('/', "\\");
    if normalized.starts_with(r"\\") {
        return Err("path.notAbsolute");
    }
    let bytes = normalized.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
    {
        return Err("path.notAbsolute");
    }
    let drive = format!("{}:\\", (bytes[0] as char).to_ascii_uppercase());
    let rest = &normalized[3..];
    let mut stack: Vec<String> = Vec::new();
    for segment in rest.split('\\') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            if stack.pop().is_none() {
                return Err("path.invalidChars");
            }
            continue;
        }
        if segment.contains(':')
            || segment.ends_with('.')
            || segment.ends_with(' ')
            || is_reserved_device_name(segment)
        {
            return Err("path.invalidChars");
        }
        stack.push(segment.to_owned());
    }
    let full = if stack.is_empty() {
        drive.clone()
    } else {
        format!("{drive}{}", stack.join("\\"))
    };
    Ok((full, stack))
}

fn normalize_root_for_compare(raw: &str) -> Option<String> {
    let (full, _) = parse_windows_drive_path(raw).ok()?;
    Some(full.trim_end_matches('\\').to_ascii_lowercase())
}

fn is_under_root(normalized_path: &str, roots: &[String]) -> bool {
    let target = normalized_path.trim_end_matches('\\').to_ascii_lowercase();
    for root in roots {
        let Some(root_norm) = normalize_root_for_compare(root) else {
            continue;
        };
        if target == root_norm {
            return true;
        }
        if let Some(rest) = target.strip_prefix(&root_norm) {
            if rest.starts_with('\\') {
                return true;
            }
        }
    }
    false
}

fn is_drive_root(normalized_path: &str) -> bool {
    let trimmed = normalized_path.trim_end_matches('\\');
    let bytes = trimmed.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn forbidden_lexical(
    normalized_path: &str,
    protected_roots: &[String],
    shared_roots: &[String],
) -> Option<&'static str> {
    if is_drive_root(normalized_path) || is_under_root(normalized_path, protected_roots) {
        return Some("path.protectedLocation");
    }
    if is_under_root(normalized_path, shared_roots) {
        return Some("path.sharedLocation");
    }
    None
}

/// Resolves the deepest existing folder to its real path before comparing, so
/// an 8.3 alias (`C:\PROGRA~1`) or another spelling of a protected folder is
/// rejected. The not-yet-created remainder is appended to the real path first;
/// the existing folder may itself be a drive root, which is a valid parent.
fn forbidden_real(
    target: &Path,
    existing: &Path,
    probe: &dyn PathProbe,
    protected_roots: &[String],
    shared_roots: &[String],
) -> Option<&'static str> {
    let real = probe.real_path(existing)?;
    let intended = target
        .strip_prefix(existing)
        .map(|remainder| real.join(remainder))
        .unwrap_or(real);
    forbidden_lexical(&intended.to_string_lossy(), protected_roots, shared_roots)
}

/// Validates a user-entered installation path against all per-user rules.
pub fn validate_install_path(
    raw_path: &str,
    expected_install_bytes: u64,
    probe: &dyn PathProbe,
) -> PathValidation {
    let required = required_disk_bytes(expected_install_bytes);
    let (normalized, segments) = match parse_windows_drive_path(raw_path) {
        Ok(parsed) => parsed,
        Err(code) => {
            return PathValidation::invalid(raw_path.trim().to_owned(), code, None, required);
        }
    };
    if segments.is_empty() {
        return PathValidation::invalid(normalized, "path.driveRoot", None, required);
    }

    let protected = probe.protected_roots();
    let shared = probe.shared_writable_roots();
    if let Some(code) = forbidden_lexical(&normalized, &protected, &shared) {
        return PathValidation::invalid(normalized, code, None, required);
    }

    let path = PathBuf::from(&normalized);
    // Check every existing ancestor (including target) for reparse points.
    let mut deepest_existing: Option<PathBuf> = None;
    for ancestor in path.ancestors() {
        if probe.exists(ancestor) {
            if probe.is_reparse_point(ancestor) {
                return PathValidation::invalid(normalized, "path.reparsePoint", None, required);
            }
            if deepest_existing.is_none() {
                deepest_existing = Some(ancestor.to_path_buf());
            }
        }
    }

    let Some(existing) = deepest_existing else {
        return PathValidation::invalid(normalized, "path.driveMissing", None, required);
    };

    if let Some(code) = forbidden_real(&path, &existing, probe, &protected, &shared) {
        return PathValidation::invalid(normalized, code, None, required);
    }

    if probe.exists(&path) && probe.is_file(&path) {
        return PathValidation::invalid(normalized, "path.isFile", None, required);
    }
    if !probe.is_dir(&existing) {
        return PathValidation::invalid(normalized, "path.isFile", None, required);
    }

    let available = probe.free_disk_bytes(&existing);

    if !probe.is_dir_writable(&existing) {
        return PathValidation::invalid(normalized, "path.notWritable", available, required);
    }

    if let Some(free) = available {
        if free < required {
            return PathValidation::invalid(normalized, "path.insufficientSpace", Some(free), required);
        }
    }

    PathValidation::ok(normalized, available, required)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    struct FakeProbe {
        dirs: HashSet<String>,
        files: HashSet<String>,
        reparses: HashSet<String>,
        real_paths: HashMap<String, String>,
        shared_roots: Vec<String>,
        writable: bool,
        free_bytes: Option<u64>,
    }

    impl FakeProbe {
        fn standard() -> Self {
            let mut dirs = HashSet::new();
            for path in [
                r"c:\",
                r"c:\users",
                r"c:\users\user",
                r"c:\users\user\appdata",
                r"c:\users\user\appdata\local",
                r"c:\windows",
                r"c:\program files",
                r"c:\program files (x86)",
                r"d:\",
                r"d:\games",
            ] {
                dirs.insert(path.to_owned());
            }
            Self {
                dirs,
                files: HashSet::new(),
                reparses: HashSet::new(),
                real_paths: HashMap::new(),
                shared_roots: vec![r"C:\ProgramData".into(), r"C:\Users\Public".into()],
                writable: true,
                free_bytes: Some(10 * 1024 * 1024 * 1024),
            }
        }

        fn key(path: &Path) -> String {
            path.to_string_lossy().replace('/', "\\").to_ascii_lowercase()
        }
    }

    impl PathProbe for FakeProbe {
        fn protected_roots(&self) -> Vec<String> {
            vec![
                r"C:\Windows".into(),
                r"C:\Program Files".into(),
                r"C:\Program Files (x86)".into(),
            ]
        }
        fn shared_writable_roots(&self) -> Vec<String> {
            self.shared_roots.clone()
        }
        fn exists(&self, path: &Path) -> bool {
            let k = Self::key(path);
            self.dirs.contains(&k) || self.files.contains(&k)
        }
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.contains(&Self::key(path))
        }
        fn is_file(&self, path: &Path) -> bool {
            self.files.contains(&Self::key(path))
        }
        fn is_reparse_point(&self, path: &Path) -> bool {
            self.reparses.contains(&Self::key(path))
        }
        fn real_path(&self, path: &Path) -> Option<PathBuf> {
            let k = Self::key(path);
            if let Some(real) = self.real_paths.get(&k) {
                return Some(PathBuf::from(real));
            }
            self.exists(path).then(|| path.to_path_buf())
        }
        fn is_dir_writable(&self, _dir: &Path) -> bool {
            self.writable
        }
        fn free_disk_bytes(&self, _dir: &Path) -> Option<u64> {
            self.free_bytes
        }
    }

    #[test]
    fn accepts_valid_per_user_and_custom_drive_paths() {
        let probe = FakeProbe::standard();
        let res = validate_install_path(
            r"C:\Users\User\AppData\Local\Voxelight Launcher",
            36 * 1024 * 1024,
            &probe,
        );
        assert!(res.valid, "{res:?}");
        assert_eq!(res.error_code, None);

        let custom = validate_install_path(r"d:/Games/Voxelight", 36 * 1024 * 1024, &probe);
        assert!(custom.valid, "{custom:?}");
        assert_eq!(custom.normalized_path, r"D:\Games\Voxelight");
    }

    #[test]
    fn rejects_relative_unc_drive_root_and_invalid_syntax() {
        let probe = FakeProbe::standard();
        for (input, expected) in [
            ("", "path.empty"),
            ("   ", "path.empty"),
            ("Voxelight", "path.notAbsolute"),
            (r"\Voxelight", "path.notAbsolute"),
            (r"\\server\share\Voxelight", "path.notAbsolute"),
            (r"C:\", "path.driveRoot"),
            (r#"C:\Users\User\Bad"Dir"#, "path.invalidChars"),
            (r"C:\Users\User\CON\Voxelight", "path.invalidChars"),
            (r"C:\Users\User\Trailing. ", "path.invalidChars"),
        ] {
            let res = validate_install_path(input, 36 * 1024 * 1024, &probe);
            assert!(!res.valid, "should reject {input:?}");
            assert_eq!(res.error_code.as_deref(), Some(expected), "input={input:?}");
        }
    }

    #[test]
    fn rejects_windows_and_program_files_and_traversal_into_them() {
        let probe = FakeProbe::standard();
        for input in [
            r"C:\Windows\Voxelight",
            r"c:\windows",
            r"C:\Program Files\Voxelight Launcher",
            r"C:\Program Files (x86)\Voxelight Launcher",
            r"C:\Users\User\..\..\Windows\Voxelight",
        ] {
            let res = validate_install_path(input, 36 * 1024 * 1024, &probe);
            assert!(!res.valid, "should reject {input}");
            assert_eq!(res.error_code.as_deref(), Some("path.protectedLocation"), "input={input}");
        }
        // Sibling folder sharing only a prefix is allowed.
        let sibling = validate_install_path(r"C:\Program Files Custom\Voxelight", 36 * 1024 * 1024, &probe);
        assert!(sibling.valid, "{sibling:?}");
    }

    #[test]
    fn rejects_shared_writable_roots_and_drive_roots() {
        let mut probe = FakeProbe::standard();
        probe.dirs.insert(r"c:\programdata".into());
        probe.dirs.insert(r"c:\users\public".into());
        for input in [
            r"C:\ProgramData",
            r"C:\ProgramData\Voxelight Launcher",
            r"c:\programdata\Voxelight",
            r"C:\Users\Public",
            r"C:\Users\Public\Voxelight Launcher",
            r"D:\",
        ] {
            let res = validate_install_path(input, 36 * 1024 * 1024, &probe);
            assert!(!res.valid, "should reject shared root {input}");
            let expected = if input == r"D:\" {
                "path.driveRoot"
            } else {
                "path.sharedLocation"
            };
            assert_eq!(res.error_code.as_deref(), Some(expected), "input={input}");
        }
    }

    #[test]
    fn resolves_the_deepest_existing_folder_to_its_real_path_before_comparing() {
        let mut probe = FakeProbe::standard();
        probe.dirs.insert(r"c:\progra~1".into());
        probe
            .real_paths
            .insert(r"c:\progra~1".into(), r"C:\Program Files".into());
        // The 8.3 alias is not textually under C:\Program Files.
        for input in [r"C:\PROGRA~1", r"C:\PROGRA~1\Voxelight Launcher"] {
            let res = validate_install_path(input, 36 * 1024 * 1024, &probe);
            assert!(!res.valid, "should reject aliased protected folder {input}");
            assert_eq!(
                res.error_code.as_deref(),
                Some("path.protectedLocation"),
                "input={input}"
            );
        }

        // A real path that resolves under a shared writable root is rejected too.
        let mut shared = FakeProbe::standard();
        shared.dirs.insert(r"c:\data".into());
        shared
            .real_paths
            .insert(r"c:\data".into(), r"C:\Users\Public".into());
        let res = validate_install_path(r"C:\Data\Voxelight", 36 * 1024 * 1024, &shared);
        assert!(!res.valid, "{res:?}");
        assert_eq!(res.error_code.as_deref(), Some("path.sharedLocation"));

        // The same file under an ordinary folder stays valid; resolving the
        // parent must not treat the drive root as the install target.
        let mut ordinary = FakeProbe::standard();
        ordinary.dirs.insert(r"c:\program files custom".into());
        ordinary.real_paths.insert(
            r"c:\program files custom".into(),
            r"C:\Program Files Custom".into(),
        );
        let res = validate_install_path(
            r"C:\Program Files Custom\Voxelight Launcher",
            36 * 1024 * 1024,
            &ordinary,
        );
        assert!(res.valid, "{res:?}");
    }

    #[cfg(windows)]
    #[test]
    fn system_probe_resolves_a_junction_to_its_final_path() {
        let base = std::env::temp_dir().join(format!(
            "voxelight-setup-realpath-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("mklink should run");
        assert!(status.success(), "could not create test junction");

        let probe = SystemPathProbe;
        let resolved = probe.real_path(&link).expect("junction must resolve");
        let canonical_real = std::fs::canonicalize(&real).unwrap();
        assert!(
            resolved
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(
                    &canonical_real
                        .to_string_lossy()
                        .trim_start_matches(r"\\?\")
                        .to_ascii_lowercase()
                ),
            "resolved {} should end with {}",
            resolved.display(),
            canonical_real.display()
        );

        std::fs::remove_dir(&link).unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn rejects_unwritable_low_space_missing_drive_file_and_reparse_point() {
        let mut unwritable = FakeProbe::standard();
        unwritable.writable = false;
        assert_eq!(
            validate_install_path(r"D:\Games\Voxelight", 36 * 1024 * 1024, &unwritable)
                .error_code
                .as_deref(),
            Some("path.notWritable")
        );

        let mut low_space = FakeProbe::standard();
        low_space.free_bytes = Some(10 * 1024 * 1024);
        assert_eq!(
            validate_install_path(r"D:\Games\Voxelight", 36 * 1024 * 1024, &low_space)
                .error_code
                .as_deref(),
            Some("path.insufficientSpace")
        );

        let probe = FakeProbe::standard();
        assert_eq!(
            validate_install_path(r"Z:\Missing\Voxelight", 36 * 1024 * 1024, &probe)
                .error_code
                .as_deref(),
            Some("path.driveMissing")
        );

        let mut file_conflict = FakeProbe::standard();
        file_conflict.files.insert(r"d:\games\voxelight".into());
        assert_eq!(
            validate_install_path(r"D:\Games\Voxelight", 36 * 1024 * 1024, &file_conflict)
                .error_code
                .as_deref(),
            Some("path.isFile")
        );

        let mut symlinked = FakeProbe::standard();
        symlinked.reparses.insert(r"d:\games".into());
        assert_eq!(
            validate_install_path(r"D:\Games\Voxelight", 36 * 1024 * 1024, &symlinked)
                .error_code
                .as_deref(),
            Some("path.reparsePoint")
        );
    }
}
