//! `voxelight-launcher.exe --update-helper` (HSR `UpdateInstallHelper`,
//! here the launcher binary itself rather than a PowerShell script). It runs
//! from a copy in the staging directory, so the installer's Restart Manager
//! check on `$INSTDIR` does not kill it. Every value arrives in fixed
//! environment variables; nothing is read from the command line.
//!
//! Before READY: validate the staging identity, open the installer
//! deny-write and hash it, and check the parent by PID and creation time.
//! After READY: wait for the parent to exit, hash again, run the installer
//! with exactly `/P /UPDATE /R`, then clean up. A failure writes helper.log,
//! shows the error with the log path and starts the old launcher again.
use super::process::{self, Identity};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) const ARGUMENT: &str = "--update-helper";
pub(crate) const INSTALLER_ARGS: [&str; 3] = ["/P", "/UPDATE", "/R"];
pub(crate) const HELPER_EXE: &str = "update-helper.exe";
pub(crate) const OWNER: &str = "owner.json";
pub(crate) const LOG: &str = "helper.log";
const PARENT_DEADLINE: Duration = Duration::from_secs(300);

pub(crate) mod env {
    pub(crate) const PARENT_PID: &str = "VOXELIGHT_UPD_PARENT_PID";
    pub(crate) const PARENT_CREATED: &str = "VOXELIGHT_UPD_PARENT_CREATED";
    pub(crate) const INSTALLER: &str = "VOXELIGHT_UPD_INSTALLER";
    pub(crate) const SIZE: &str = "VOXELIGHT_UPD_SIZE";
    pub(crate) const SHA256: &str = "VOXELIGHT_UPD_SHA256";
    pub(crate) const RELAUNCH: &str = "VOXELIGHT_UPD_RELAUNCH";
    pub(crate) const ERROR: &str = "VOXELIGHT_UPD_ERROR";
    pub(crate) const LOGS: &str = "VOXELIGHT_UPD_LOGS";
    /// The launcher's session-only profile overrides, restored on the relaunch.
    pub(crate) const DATA_DIR: &str = "VOXELIGHT_UPD_DATA_DIR";
    pub(crate) const GAME_DIR: &str = "VOXELIGHT_UPD_GAME_DIR";
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Inputs {
    pub(crate) parent: Identity,
    pub(crate) installer: PathBuf,
    pub(crate) size: u64,
    pub(crate) sha256: String,
    pub(crate) relaunch: PathBuf,
    pub(crate) error_text: String,
    pub(crate) logs_text: String,
    /// (launcher variable, value) pairs to restore for the installer and relaunch.
    pub(crate) profile: Vec<(String, String)>,
}

fn number(text: Option<String>) -> Option<u64> {
    let text = text?;
    (!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())).then(|| text.parse().ok()).flatten()
}

/// Reads and checks the hand-off values (HSR: positive PID and start time,
/// size 1..=512 MiB, a 64-hex digest).
pub(crate) fn inputs_from(get: impl Fn(&str) -> Option<String>) -> Result<Inputs, String> {
    let pid = number(get(env::PARENT_PID)).and_then(|pid| u32::try_from(pid).ok()).filter(|pid| *pid > 0);
    let created = number(get(env::PARENT_CREATED)).filter(|created| *created > 0);
    let size = number(get(env::SIZE)).filter(|size| (1..=super::MAX_INSTALLER_BYTES).contains(size));
    let sha256 = get(env::SHA256).filter(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let text = |name| get(name).filter(|value: &String| !value.is_empty() && value.chars().count() <= 4096);
    match (pid, created, size, sha256, get(env::INSTALLER), get(env::RELAUNCH), text(env::ERROR), text(env::LOGS)) {
        (Some(pid), Some(created), Some(size), Some(sha256), Some(installer), Some(relaunch), Some(error_text), Some(logs_text)) => {
            Ok(Inputs {
                parent: Identity { pid, created },
                installer: PathBuf::from(installer),
                size,
                sha256: sha256.to_ascii_lowercase(),
                relaunch: PathBuf::from(relaunch),
                error_text,
                logs_text,
                profile: [(env::DATA_DIR, "VOXELIGHT_LAUNCHER_DATA_DIR"), (env::GAME_DIR, "VOXELIGHT_LAUNCHER_GAME_DIR")]
                    .into_iter()
                    .filter_map(|(from, to)| get(from).filter(|value| !value.is_empty()).map(|value| (to.to_owned(), value)))
                    .collect(),
            })
        }
        _ => Err("更新交接参数无效".into()),
    }
}

/// `VoxelightLauncher-<x.y.z>-x64-setup.exe`.
pub(crate) fn installer_file_name(name: &str) -> bool {
    name.strip_prefix("VoxelightLauncher-")
        .and_then(|rest| rest.strip_suffix("-x64-setup.exe"))
        .and_then(super::manifest::parse_version)
        .is_some_and(|version| super::installer_name(version) == name)
}

/// A staging directory name: 32 lowercase hex digits.
pub(crate) fn staging_name(name: &str) -> bool {
    name.len() == 32 && name.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// The installer must be `<root>/<guid32>/<installer name>`, reached through
/// ordinary directories only, and not itself a link.
pub(crate) fn validate_staging(installer: &Path, root: &Path) -> Result<(), String> {
    let bad = || "更新暂存位置无效".to_owned();
    let directory = installer.parent().ok_or_else(bad)?;
    let name = installer.file_name().and_then(|name| name.to_str()).ok_or_else(bad)?;
    let folder = directory.file_name().and_then(|name| name.to_str()).ok_or_else(bad)?;
    if !installer_file_name(name) || !staging_name(folder) || !directory.parent().is_some_and(|parent| same_path(parent, root)) {
        return Err(bad());
    }
    if !super::download::checked_ancestors(directory) {
        return Err(bad());
    }
    let metadata = std::fs::symlink_metadata(installer).map_err(|_| bad())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(bad());
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(bad());
    }
    Ok(())
}

fn hash_matches(file: &mut std::fs::File, size: u64, sha256: &str) -> bool {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Seek, SeekFrom};
    if file.seek(SeekFrom::Start(0)).is_err() {
        return false;
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                total += count as u64;
                hash.update(&buffer[..count]);
            }
            Err(_) => return false,
        }
    }
    total == size && super::download::digest_equals(&hash.finalize(), sha256)
}

fn open_locked(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x1); // readers only, so the installer can still run
    }
    options.open(path)
}

/// What the helper needs from the system; tests replace all of it.
pub(crate) trait Deps {
    /// This helper's own identity, recorded for the startup sweep.
    fn own(&self) -> Option<Identity>;
    /// Whether the parent is still the same running process.
    fn parent_alive(&self, parent: Identity) -> bool;
    /// Waits for the parent to exit; true once it has.
    fn wait_parent(&self, parent: Identity, timeout: Duration) -> bool;
    /// Whether any process still uses the installed launcher; the installer's
    /// Restart Manager would force-close it (fails closed).
    fn others_running(&self, launcher: &Path) -> Result<bool, String>;
    /// The user's own fresh environment, for the programs started for them.
    fn user_environment(&self) -> Option<Vec<(OsString, OsString)>>;
    /// Runs the installer (working directory System32); its exit code, or
    /// the OS error code when it could not start.
    fn run_installer(
        &self,
        installer: &Path,
        args: &[&str],
        environment: Option<&[(OsString, OsString)]>,
    ) -> Result<i32, Option<i32>>;
    fn ready(&self);
    fn not_ready(&self);
    fn show_error(&self, message: &str);
    fn relaunch(&self, launcher: &Path, environment: Option<&[(OsString, OsString)]>);
}

/// The environment for the installer and the relaunched launcher: the
/// user's fresh one plus the session's profile overrides, never the helper's
/// cleared one or its hand-off values.
pub(crate) fn child_environment(
    user: Option<Vec<(OsString, OsString)>>,
    profile: &[(String, String)],
) -> Option<Vec<(OsString, OsString)>> {
    let mut pairs: Vec<(OsString, OsString)> = user?
        .into_iter()
        .filter(|(key, _)| !key.to_string_lossy().to_ascii_uppercase().starts_with("VOXELIGHT_UPD_"))
        .collect();
    pairs.extend(profile.iter().map(|(key, value)| (OsString::from(key), OsString::from(value))));
    Some(pairs)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    /// Refused before READY; the parent keeps running.
    Refused,
    Installed,
    Failed,
}

fn write_log(directory: &Path, stage: &str, exit_code: Option<i32>, os_error: Option<i32>) -> Option<PathBuf> {
    let path = directory.join(LOG);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).ok()?;
    let text = |value: Option<i32>| value.map_or("none".to_owned(), |value| value.to_string());
    let record = format!(
        "utc={}\r\nstage={stage}\r\ninstaller_exit_code={}\r\nwin32_error={}\r\n",
        chrono::Utc::now().to_rfc3339(),
        text(exit_code),
        text(os_error)
    );
    file.write_all(record.as_bytes()).ok()?;
    file.sync_all().ok()?;
    Some(path)
}

/// Removes the files this hand-off owns. The running helper copy cannot
/// delete itself; the next startup sweep removes it with the directory.
fn clean(directory: &Path, installer: &Path, keep_log: bool) {
    if !super::download::checked_ancestors(directory) {
        return;
    }
    for path in [installer.to_owned(), directory.join("download.bin"), directory.join(OWNER)] {
        let _ = std::fs::remove_file(path);
    }
    if !keep_log {
        let _ = std::fs::remove_file(directory.join(LOG));
    }
    let _ = std::fs::remove_dir(directory);
}

pub(crate) fn run(inputs: &Inputs, root: &Path, deps: &dyn Deps) -> Outcome {
    let refuse = || {
        deps.not_ready();
        Outcome::Refused
    };
    if validate_staging(&inputs.installer, root).is_err() {
        return refuse();
    }
    let Some(directory) = inputs.installer.parent().map(Path::to_owned) else {
        return refuse();
    };
    let Ok(mut locked) = open_locked(&inputs.installer) else {
        return refuse();
    };
    if !hash_matches(&mut locked, inputs.size, &inputs.sha256) || !deps.parent_alive(inputs.parent) {
        return refuse();
    }
    if let Some(own) = deps.own() {
        if let Ok(mut file) = std::fs::OpenOptions::new().write(true).create_new(true).open(directory.join(OWNER)) {
            let _ = file.write_all(&serde_json::to_vec(&own).unwrap_or_default());
        }
    }
    deps.ready();
    let environment = child_environment(deps.user_environment(), &inputs.profile);
    // The old launcher is started again only once it has exited and no other
    // copy runs; a second copy would be refused by its profile lock.
    let fail = |stage: &str, code: Option<i32>, os_error: Option<i32>, locked: std::fs::File, relaunch: bool| {
        drop(locked);
        let log = write_log(&directory, stage, code, os_error);
        clean(&directory, &inputs.installer, log.is_some());
        let mut message = inputs.error_text.clone();
        if let Some(log) = log {
            message.push_str(&format!("\n\n{}\n{}", inputs.logs_text, log.display()));
        }
        deps.show_error(&message);
        if relaunch {
            deps.relaunch(&inputs.relaunch, environment.as_deref());
        }
        Outcome::Failed
    };
    if !deps.wait_parent(inputs.parent, PARENT_DEADLINE) {
        return fail("wait-parent", None, None, locked, false);
    }
    // Another launcher (another profile) from the same folder would be
    // force-closed by the installer in passive mode: refuse instead.
    match deps.others_running(&inputs.relaunch) {
        Ok(false) => {}
        Ok(true) => return fail("other-instance", None, None, locked, false),
        Err(_) => return fail("other-instance-check", None, None, locked, true),
    }
    if !hash_matches(&mut locked, inputs.size, &inputs.sha256) {
        return fail("verify-installer", None, None, locked, true);
    }
    let code = match deps.run_installer(&inputs.installer, &INSTALLER_ARGS, environment.as_deref()) {
        Ok(code) => code,
        Err(os_error) => return fail("start-installer", None, os_error, locked, true),
    };
    if code != 0 && code != 3010 {
        return fail("installer-exit", Some(code), None, locked, true);
    }
    drop(locked);
    clean(&directory, &inputs.installer, false);
    Outcome::Installed
}

/// The production dependencies. The parent handle opened by the identity
/// check is kept and waited on, so a reused PID is never waited for.
#[derive(Default)]
pub(crate) struct System {
    parent: std::cell::RefCell<Option<process::Held>>,
}

fn with_environment(command: &mut std::process::Command, environment: Option<&[(OsString, OsString)]>) {
    if let Some(pairs) = environment {
        command.env_clear().envs(pairs.iter().map(|(key, value)| (key, value)));
    }
}

impl Deps for System {
    fn own(&self) -> Option<Identity> {
        process::current()
    }
    fn parent_alive(&self, parent: Identity) -> bool {
        let held = process::open_alive(parent);
        let alive = held.is_some();
        *self.parent.borrow_mut() = held;
        alive
    }
    fn wait_parent(&self, _: Identity, timeout: Duration) -> bool {
        self.parent.borrow().as_ref().is_some_and(|held| process::wait_held(held, timeout))
    }
    fn others_running(&self, launcher: &Path) -> Result<bool, String> {
        process::other_users(launcher, None)
    }
    fn user_environment(&self) -> Option<Vec<(OsString, OsString)>> {
        process::user_environment()
    }
    fn run_installer(
        &self,
        installer: &Path,
        args: &[&str],
        environment: Option<&[(OsString, OsString)]>,
    ) -> Result<i32, Option<i32>> {
        let system = std::env::var_os("SystemRoot").map(|root| PathBuf::from(root).join("System32"));
        let mut command = std::process::Command::new(installer);
        command.args(args);
        with_environment(&mut command, environment);
        if let Some(system) = system {
            command.current_dir(system);
        }
        let status = command.status().map_err(|error| error.raw_os_error())?;
        status.code().ok_or(None)
    }
    fn ready(&self) {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "READY");
        let _ = out.flush();
    }
    fn not_ready(&self) {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "ERROR");
        let _ = out.flush();
    }
    fn show_error(&self, message: &str) {
        process::show_error(message);
    }
    fn relaunch(&self, launcher: &Path, environment: Option<&[(OsString, OsString)]>) {
        let mut command = std::process::Command::new(launcher);
        with_environment(&mut command, environment);
        if let Some(folder) = launcher.parent() {
            command.current_dir(folder);
        }
        // Not the READY pipe to the exited parent.
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let _ = command.spawn();
    }
}

/// The `--update-helper` entry point: returns the process exit code.
pub(crate) fn main() -> i32 {
    let system = System::default();
    let Ok(inputs) = inputs_from(|name| std::env::var(name).ok()) else {
        system.not_ready();
        return 2;
    };
    let Ok(root) = super::download::updates_root() else {
        system.not_ready();
        return 2;
    };
    match run(&inputs, &root, &system) {
        Outcome::Installed => 0,
        Outcome::Refused => 2,
        Outcome::Failed => 1,
    }
}
