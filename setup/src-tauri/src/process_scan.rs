// SPDX-License-Identifier: GPL-3.0-only
//! Process scan used before the interactive install starts.
//!
//! Silent NSIS mode force-closes a running launcher (`CheckIfAppIsRunning` in
//! the installer template). The interactive Setup UI must ask first, so it
//! checks for `<target>\voxelight-launcher.exe` and refuses with a localized
//! "close Voxelight and retry" error instead of letting NSIS kill the app.
use crate::registry::MAIN_BINARY_NAME;
use std::path::{Path, PathBuf};

pub trait ProcessList {
    fn running_images(&self) -> Vec<PathBuf>;
}

/// Normalizes a process image path for comparison.
///
/// QueryFullProcessImageNameW may return a path with a `\\?\` prefix while the
/// user-selected folder does not (or vice versa), and Windows paths compare
/// case-insensitively.
pub fn normalize_process_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let without_prefix = if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_owned()
    } else {
        text.into_owned()
    };
    without_prefix
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

pub fn target_launcher_path(target_dir: &Path) -> PathBuf {
    target_dir.join(MAIN_BINARY_NAME)
}

pub fn same_executable(left: &Path, right: &Path) -> bool {
    normalize_process_path(left) == normalize_process_path(right)
}

/// Returns true when any running process image is the launcher in `target_dir`.
pub fn any_launcher_running(images: &[PathBuf], target_dir: &Path) -> bool {
    let target = target_launcher_path(target_dir);
    let target_lexical = target.clone();
    let target_real = std::fs::canonicalize(&target).unwrap_or(target);
    images.iter().any(|image| {
        let image_real = std::fs::canonicalize(image).unwrap_or_else(|_| image.clone());
        same_executable(&image_real, &target_real) || same_executable(image, &target_lexical)
    })
}

#[cfg(windows)]
pub struct SystemProcessList;

#[cfg(windows)]
mod win {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const INVALID_HANDLE_VALUE: isize = -1;
    const ERROR_NO_MORE_FILES: u32 = 18;
    const MAX_PATH: usize = 260;

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_module_id: u32,
        cnt_threads: u32,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; MAX_PATH],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> isize;
        fn Process32FirstW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snapshot: isize, entry: *mut ProcessEntry32W) -> i32;
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> isize;
        fn QueryFullProcessImageNameW(
            process: isize,
            flags: u32,
            exe_name: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(handle: isize) -> i32;
        fn GetLastError() -> u32;
    }

    pub fn running_images() -> Vec<PathBuf> {
        let mut images = Vec::new();
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return images;
        }
        let mut entry: ProcessEntry32W = unsafe { std::mem::zeroed() };
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
        while ok != 0 {
            if let Some(path) = process_image(entry.th32_process_id) {
                images.push(path);
            }
            ok = unsafe { Process32NextW(snapshot, &mut entry) };
            if ok == 0 && unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
                break;
            }
        }
        unsafe { CloseHandle(snapshot) };
        images
    }

    fn process_image(process_id: u32) -> Option<PathBuf> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if process == 0 || process == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut buffer = [0u16; 1024];
        let mut length = buffer.len() as u32;
        let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
        unsafe { CloseHandle(process) };
        if ok == 0 || length == 0 || length as usize > buffer.len() {
            return None;
        }
        Some(PathBuf::from(OsString::from_wide(&buffer[..length as usize])))
    }
}

#[cfg(windows)]
impl ProcessList for SystemProcessList {
    fn running_images(&self) -> Vec<PathBuf> {
        win::running_images()
    }
}

#[cfg(not(windows))]
pub struct SystemProcessList;

#[cfg(not(windows))]
impl ProcessList for SystemProcessList {
    fn running_images(&self) -> Vec<PathBuf> {
        Vec::new()
    }
}

pub fn launcher_is_running(target_dir: &Path) -> bool {
    any_launcher_running(&SystemProcessList.running_images(), target_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn images(paths: &[&str]) -> Vec<PathBuf> {
        paths.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn detects_the_launcher_in_the_target_folder_case_insensitively() {
        let target = Path::new(r"D:\Games\Voxelight Launcher");
        assert!(any_launcher_running(
            &images(&[r"d:\games\VOXELIGHT LAUNCHER\VOXELIGHT-LAUNCHER.EXE"]),
            target,
        ));
        assert!(any_launcher_running(
            &images(&[r"\\?\D:\Games\Voxelight Launcher\voxelight-launcher.exe"]),
            target,
        ));
        assert!(any_launcher_running(
            &images(&[r"D:/Games/Voxelight Launcher/voxelight-launcher.exe"]),
            target,
        ));
    }

    #[test]
    fn ignores_another_installation_and_other_executables() {
        let target = Path::new(r"D:\Games\Voxelight Launcher");
        assert!(!any_launcher_running(
            &images(&[
                r"D:\Games\Voxelight Launcher Old\voxelight-launcher.exe",
                r"D:\Games\Voxelight Launcher\setup.exe",
                r"C:\Windows\explorer.exe",
            ]),
            target,
        ));
        assert!(!any_launcher_running(&[], target));
    }

    #[cfg(windows)]
    #[test]
    fn system_process_list_reports_the_current_test_executable() {
        let current = std::env::current_exe().expect("current exe");
        let images = SystemProcessList.running_images();
        assert!(
            images.iter().any(|image| same_executable(image, &current)),
            "the process scan did not report the current executable {}",
            current.display()
        );
    }

    #[test]
    fn normalizes_extended_and_unc_prefixes() {
        assert_eq!(
            normalize_process_path(Path::new(r"\\?\C:\Program Files\Voxelight\voxelight-launcher.exe")),
            r"c:\program files\voxelight\voxelight-launcher.exe"
        );
        assert_eq!(
            normalize_process_path(Path::new(r"\\?\UNC\server\share\voxelight-launcher.exe")),
            r"\\server\share\voxelight-launcher.exe"
        );
        assert_eq!(
            normalize_process_path(Path::new(r"C:\Games\Voxelight Launcher\")),
            r"c:\games\voxelight launcher"
        );
    }
}
