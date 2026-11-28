// SPDX-License-Identifier: GPL-3.0-only
//! Embedded NSIS payload verification, exclusive temp extraction, execution, and cleanup.
use crate::args::apply_nsis_args;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

include!(concat!(env!("OUT_DIR"), "/embedded_payload.rs"));

const CHUNK_BYTES: usize = 256 * 1024;
const PAYLOAD_FILE_NAME: &str = "voxelight-nsis-payload.exe";
const TEMP_DIR_PREFIX: &str = "voxelight-setup-";

/// Exit code when Setup cannot start or verify its embedded installer.
///
/// This is deliberately not `1`: NSIS uses `1` for "the user cancelled" and
/// callers such as the self-updater would otherwise report a cancellation.
/// `2` is reserved here for a failure before the NSIS payload could run.
pub const PAYLOAD_START_FAILURE_EXIT_CODE: i32 = 2;

/// Setup must stay quiet when NSIS was invoked silently with `/S`.
pub fn should_show_startup_error(args: &[OsString], raw_args: Option<&str>) -> bool {
    let silent = args
        .iter()
        .any(|arg| arg.to_string_lossy().eq_ignore_ascii_case("/S"))
        || raw_args.is_some_and(|raw| {
            raw.split_whitespace()
                .any(|token| token.eq_ignore_ascii_case("/S"))
        });
    !silent
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayloadError {
    HashMismatch,
    TempRootUnsafe(String),
    ExtractFailed(String),
    SpawnFailed(String),
}

impl PayloadError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::HashMismatch => "hashMismatch",
            Self::TempRootUnsafe(_) | Self::ExtractFailed(_) => "extractFailed",
            Self::SpawnFailed(_) => "spawnFailed",
        }
    }

    pub fn detail(&self) -> String {
        match self {
            Self::HashMismatch => "Embedded installer payload failed SHA-256 verification.".to_owned(),
            Self::TempRootUnsafe(detail)
            | Self::ExtractFailed(detail)
            | Self::SpawnFailed(detail) => detail.clone(),
        }
    }
}

impl std::fmt::Display for PayloadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.detail())
    }
}

/// Computes lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Constant-time comparison of raw digest bytes against a 64-character lowercase hex string.
pub fn digest_equals(actual: &[u8], expected_hex: &str) -> bool {
    if actual.len() != 32 || expected_hex.len() != 64 {
        return false;
    }
    let actual_hex: String = actual.iter().map(|byte| format!("{byte:02x}")).collect();
    actual_hex
        .bytes()
        .zip(expected_hex.as_bytes().iter().map(|b| b.to_ascii_lowercase()))
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

pub fn ordinary_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return false;
            }
        }
        metadata.is_dir() && !metadata.file_type().is_symlink()
    })
}

pub fn ordinary_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
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

/// Creates a new, uniquely named directory directly under `base_temp` using exclusive `create_dir`.
///
/// Only the newly created extraction folder is inspected. `%TEMP%` itself may
/// legitimately sit below a redirected profile folder (roaming profiles,
/// folder redirection, a junction chosen by the user); refusing that would
/// break Setup for those users without improving the security of the folder we
/// just created exclusively.
pub fn create_exclusive_temp_dir(base_temp: &Path, prefix: &str) -> Result<PathBuf, PayloadError> {
    for _ in 0..8 {
        let name = format!("{prefix}{}", uuid::Uuid::new_v4().simple());
        let candidate = base_temp.join(name);
        match fs::create_dir(&candidate) {
            Ok(()) => {
                if !ordinary_directory(&candidate) {
                    let _ = fs::remove_dir(&candidate);
                    return Err(PayloadError::TempRootUnsafe(format!(
                        "Created extraction directory is not an ordinary folder: {}",
                        candidate.display()
                    )));
                }
                return Ok(candidate);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(PayloadError::ExtractFailed(format!(
                    "Could not create extraction directory: {error}"
                )));
            }
        }
    }
    Err(PayloadError::ExtractFailed(
        "Could not allocate an exclusive extraction directory.".to_owned(),
    ))
}

fn open_read_deny_write(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ: allow the OS loader to execute the payload while denying writers.
        options.share_mode(0x1);
    }
    options.open(path)
}

fn verify_open_file(file: &mut File, expected_len: u64, expected_sha256: &str) -> Result<(), PayloadError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| PayloadError::ExtractFailed(format!("Could not seek payload: {error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| PayloadError::ExtractFailed(format!("Could not read payload: {error}")))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        hasher.update(&buffer[..read]);
    }
    if total != expected_len || !digest_equals(&hasher.finalize(), expected_sha256) {
        return Err(PayloadError::HashMismatch);
    }
    Ok(())
}

/// An extracted payload inside an exclusive private temp directory, held open
/// with writers denied until cleanup. Always cleans up on drop.
pub struct ExtractedPayload {
    dir: PathBuf,
    exe_path: PathBuf,
    locked: Option<File>,
    cleaned: bool,
}

impl ExtractedPayload {
    pub fn extract_verified(
        base_temp: &Path,
        payload_bytes: &[u8],
        expected_sha256: &str,
        mut on_progress: impl FnMut(u64, u64),
    ) -> Result<Self, PayloadError> {
        if payload_bytes.is_empty() || !digest_equals(&Sha256::digest(payload_bytes), expected_sha256) {
            return Err(PayloadError::HashMismatch);
        }

        let dir = create_exclusive_temp_dir(base_temp, TEMP_DIR_PREFIX)?;
        let exe_path = dir.join(PAYLOAD_FILE_NAME);
        let mut guard = Self {
            dir,
            exe_path,
            locked: None,
            cleaned: false,
        };

        let mut writer = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&guard.exe_path)
            .map_err(|error| PayloadError::ExtractFailed(format!("Could not create payload file: {error}")))?;

        let total = payload_bytes.len() as u64;
        let mut written = 0u64;
        for chunk in payload_bytes.chunks(CHUNK_BYTES) {
            writer
                .write_all(chunk)
                .map_err(|error| PayloadError::ExtractFailed(format!("Could not write payload: {error}")))?;
            written += chunk.len() as u64;
            on_progress(written, total);
        }
        writer
            .sync_all()
            .map_err(|error| PayloadError::ExtractFailed(format!("Could not flush payload: {error}")))?;
        drop(writer);

        if !ordinary_file(&guard.exe_path) {
            return Err(PayloadError::ExtractFailed(
                "Extracted payload is not an ordinary file.".to_owned(),
            ));
        }

        let mut locked = open_read_deny_write(&guard.exe_path).map_err(|error| {
            PayloadError::ExtractFailed(format!("Could not lock extracted payload: {error}"))
        })?;
        verify_open_file(&mut locked, total, expected_sha256)?;
        guard.locked = Some(locked);
        Ok(guard)
    }

    pub fn path(&self) -> &Path {
        &self.exe_path
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Re-verifies the locked payload file right before execution.
    pub fn reverify(&mut self, expected_len: u64, expected_sha256: &str) -> Result<(), PayloadError> {
        let file = self.locked.as_mut().ok_or(PayloadError::HashMismatch)?;
        verify_open_file(file, expected_len, expected_sha256)
    }

    pub fn cleanup(mut self) {
        self.cleanup_inner();
    }

    fn cleanup_inner(&mut self) {
        if self.cleaned {
            return;
        }
        self.cleaned = true;
        self.locked = None;
        // Inspect only the folder this run created. Ancestors may be redirected
        // for legitimate reasons, and refusing to clean would leave the payload
        // behind. If the created folder itself was swapped for a link, leave it
        // alone rather than deleting through it.
        if !ordinary_directory(&self.dir) {
            return;
        }
        for attempt in 0..10 {
            let _ = fs::remove_file(&self.exe_path);
            if fs::remove_dir(&self.dir).is_ok() || !self.dir.exists() {
                return;
            }
            if attempt < 9 {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let _ = fs::remove_dir_all(&self.dir);
    }
}

impl Drop for ExtractedPayload {
    fn drop(&mut self) {
        self.cleanup_inner();
    }
}

/// Abstraction over running the extracted payload so unit tests use fakes
/// and never execute a real installer.
pub trait PayloadRunner {
    /// Runs the payload. `raw_args` is the untouched command line after Setup's
    /// program name; when present it is forwarded as one raw argument so NSIS
    /// sees the exact original spacing.
    fn run(
        &self,
        executable: &Path,
        args: &[OsString],
        raw_args: Option<&str>,
    ) -> Result<i32, String>;
}

pub struct SystemPayloadRunner;

impl PayloadRunner for SystemPayloadRunner {
    fn run(
        &self,
        executable: &Path,
        args: &[OsString],
        raw_args: Option<&str>,
    ) -> Result<i32, String> {
        let mut command = Command::new(executable);
        if let Some(raw) = raw_args {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.raw_arg(raw);
            }
            #[cfg(not(windows))]
            {
                command.arg(raw);
            }
        } else {
            apply_nsis_args(&mut command, args);
        }
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            let system32 = PathBuf::from(system_root).join("System32");
            if system32.is_dir() {
                command.current_dir(system32);
            }
        }
        let status = command
            .status()
            .map_err(|error| format!("Could not run installer payload: {error}"))?;
        Ok(status.code().unwrap_or(1))
    }
}

/// Extracts the payload to a private exclusive temp dir, checks its SHA-256,
/// executes it via `runner` with exact `args`, cleans up, and returns its exit code.
pub fn run_payload_passthrough(
    base_temp: &Path,
    payload_bytes: &[u8],
    expected_sha256: &str,
    args: &[OsString],
    raw_args: Option<&str>,
    runner: &dyn PayloadRunner,
) -> Result<i32, PayloadError> {
    let mut extracted = ExtractedPayload::extract_verified(
        base_temp,
        payload_bytes,
        expected_sha256,
        |_, _| {},
    )?;
    extracted.reverify(payload_bytes.len() as u64, expected_sha256)?;
    let result = runner
        .run(extracted.path(), args, raw_args)
        .map_err(PayloadError::SpawnFailed);
    extracted.cleanup();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeRunner {
        exit_code: Result<i32, String>,
        seen_args: RefCell<Vec<OsString>>,
        seen_raw: RefCell<Option<String>>,
        seen_path: RefCell<Option<PathBuf>>,
        seen_file_existed: RefCell<bool>,
    }

    impl FakeRunner {
        fn returning(exit_code: Result<i32, String>) -> Self {
            Self {
                exit_code,
                seen_args: RefCell::new(Vec::new()),
                seen_raw: RefCell::new(None),
                seen_path: RefCell::new(None),
                seen_file_existed: RefCell::new(false),
            }
        }
    }

    impl PayloadRunner for FakeRunner {
        fn run(
            &self,
            executable: &Path,
            args: &[OsString],
            raw_args: Option<&str>,
        ) -> Result<i32, String> {
            *self.seen_path.borrow_mut() = Some(executable.to_path_buf());
            *self.seen_file_existed.borrow_mut() = executable.is_file();
            *self.seen_args.borrow_mut() = args.to_vec();
            *self.seen_raw.borrow_mut() = raw_args.map(str::to_owned);
            self.exit_code.clone()
        }
    }

    fn fresh_temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "voxelight-setup-unit-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn passthrough_forwards_exact_arguments_exit_code_and_cleans_up() {
        let root = fresh_temp_root("passthrough");
        let payload = b"MZ synthetic nsis installer payload bytes";
        let hash = sha256_hex(payload);
        let args = vec![
            OsString::from("/P"),
            OsString::from("/UPDATE"),
            OsString::from("/R"),
        ];
        let runner = FakeRunner::returning(Ok(3010));

        let code = run_payload_passthrough(&root, payload, &hash, &args, None, &runner).unwrap();
        assert_eq!(code, 3010);
        assert_eq!(*runner.seen_args.borrow(), args);
        assert!(*runner.seen_file_existed.borrow());

        let ran_path = runner.seen_path.borrow().clone().unwrap();
        assert!(ran_path.starts_with(&root));
        assert!(!ran_path.exists(), "payload file must be removed after exit");
        assert!(
            !ran_path.parent().unwrap().exists(),
            "exclusive temp dir must be removed after exit"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn passthrough_forwards_the_raw_command_line_tail_verbatim() {
        let root = fresh_temp_root("raw");
        let payload = b"MZ raw passthrough payload";
        let hash = sha256_hex(payload);
        let raw = r#"/P /UPDATE /R /D=C:\Users\User\My  Folder  "#;
        let runner = FakeRunner::returning(Ok(3010));

        let code = run_payload_passthrough(&root, payload, &hash, &[], Some(raw), &runner).unwrap();
        assert_eq!(code, 3010);
        assert_eq!(runner.seen_raw.borrow().as_deref(), Some(raw));
        assert!(
            runner.seen_args.borrow().is_empty(),
            "raw forwarding must not rebuild an argument list"
        );
        assert!(*runner.seen_file_existed.borrow());
        assert!(fs::read_dir(&root).unwrap().next().is_none());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn raw_passthrough_keeps_a_quoted_dir_override_intact() {
        let root = fresh_temp_root("raw-quoted-dir");
        let payload = b"MZ raw quoted dir payload";
        let hash = sha256_hex(payload);
        let raw = r#"/S "/D=C:\Users\User\My Folder""#;
        let runner = FakeRunner::returning(Ok(0));

        let code = run_payload_passthrough(&root, payload, &hash, &[], Some(raw), &runner).unwrap();
        assert_eq!(code, 0);
        assert_eq!(runner.seen_raw.borrow().as_deref(), Some(raw));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn startup_errors_stay_silent_for_slash_s_and_use_a_non_cancel_exit_code() {
        assert!(!should_show_startup_error(&[OsString::from("/S")], None));
        assert!(!should_show_startup_error(&[OsString::from("/s")], None));
        assert!(!should_show_startup_error(&[], Some("/P /UPDATE /S")));
        assert!(!should_show_startup_error(&[OsString::from("/S")], Some("/S")));
        assert!(should_show_startup_error(&[], None));
        assert!(should_show_startup_error(&[OsString::from("/P")], None));
        assert_ne!(
            PAYLOAD_START_FAILURE_EXIT_CODE, 1,
            "1 is NSIS's user-cancelled code"
        );
        assert_eq!(PAYLOAD_START_FAILURE_EXIT_CODE, 2);
    }

    #[cfg(windows)]
    fn make_junction(target: &Path, link: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("mklink should run");
        assert!(status.success(), "could not create junction {}", link.display());
    }

    #[cfg(windows)]
    #[test]
    fn extraction_allows_a_redirected_temp_root_and_only_checks_the_new_folder() {
        let real = fresh_temp_root("redirect-real");
        let parent = real.parent().unwrap().to_path_buf();
        let link = parent.join(format!(
            "voxelight-setup-link-{}",
            uuid::Uuid::new_v4().simple()
        ));
        make_junction(&real, &link);
        let base = link.join("nested-temp");
        fs::create_dir_all(&base).unwrap();

        let payload = b"MZ redirected temp root payload";
        let hash = sha256_hex(payload);
        let extracted = ExtractedPayload::extract_verified(&base, payload, &hash, |_, _| {})
            .expect("a redirected %TEMP% above the new exclusive folder must be accepted");
        let dir = extracted.dir().to_path_buf();
        assert!(dir.starts_with(&base));
        extracted.cleanup();
        assert!(!dir.exists(), "the new extraction folder must be removed");

        fs::remove_dir(&link).unwrap();
        fs::remove_dir_all(&real).unwrap();
    }

    #[test]
    fn passthrough_preserves_nonzero_exit_code_and_cleans_up_on_spawn_error() {
        let root = fresh_temp_root("errors");
        let payload = b"MZ synthetic payload";
        let hash = sha256_hex(payload);
        let args = vec![OsString::from("/S"), OsString::from("/NS")];

        let runner_fail = FakeRunner::returning(Ok(2));
        let code = run_payload_passthrough(&root, payload, &hash, &args, None, &runner_fail).unwrap();
        assert_eq!(code, 2);
        assert!(!runner_fail.seen_path.borrow().as_ref().unwrap().exists());

        let runner_err = FakeRunner::returning(Err("synthetic spawn failure".into()));
        let err = run_payload_passthrough(&root, payload, &hash, &args, None, &runner_err).unwrap_err();
        assert_eq!(err.code(), "spawnFailed");
        assert!(
            fs::read_dir(&root).unwrap().next().is_none(),
            "temp root must be empty after spawn failure"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_payload_hash_mismatch_before_extraction_or_execution() {
        let root = fresh_temp_root("hash");
        let payload = b"MZ synthetic payload";
        let wrong_hash = "0".repeat(64);
        let runner = FakeRunner::returning(Ok(0));

        let err = run_payload_passthrough(&root, payload, &wrong_hash, &[], None, &runner).unwrap_err();
        assert_eq!(err, PayloadError::HashMismatch);
        assert!(runner.seen_path.borrow().is_none(), "runner must not be invoked on hash mismatch");
        assert!(
            fs::read_dir(&root).unwrap().next().is_none(),
            "nothing should be left in temp root on hash mismatch"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn exclusive_extraction_creates_unique_dirs_and_cleans_on_drop() {
        let root = fresh_temp_root("exclusive");
        let payload = b"MZ exclusive test bytes";
        let hash = sha256_hex(payload);
        let mut progress_calls = Vec::new();
        let extracted_a =
            ExtractedPayload::extract_verified(&root, payload, &hash, |done, total| {
                progress_calls.push((done, total));
            })
            .unwrap();
        let extracted_b =
            ExtractedPayload::extract_verified(&root, payload, &hash, |_, _| {}).unwrap();

        assert_ne!(extracted_a.dir(), extracted_b.dir());
        assert!(extracted_a.path().is_file());
        assert!(extracted_b.path().is_file());
        assert_eq!(progress_calls.last().copied(), Some((payload.len() as u64, payload.len() as u64)));

        let dir_a = extracted_a.dir().to_path_buf();
        let dir_b = extracted_b.dir().to_path_buf();
        drop(extracted_a);
        assert!(!dir_a.exists());
        assert!(dir_b.exists());
        extracted_b.cleanup();
        assert!(!dir_b.exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn embedded_compile_time_payload_matches_its_compiled_hash() {
        assert!(!PAYLOAD_BYTES.is_empty());
        assert_eq!(PAYLOAD_SHA256.len(), 64);
        assert!(digest_equals(&Sha256::digest(PAYLOAD_BYTES), PAYLOAD_SHA256));
    }
}
