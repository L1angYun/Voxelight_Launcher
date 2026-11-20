//! Install on exit (HSR `PrepareInstallAsync`): only when the launcher is
//! idle, hand the verified installer to a helper copy of this executable,
//! wait for its READY, then exit while still holding the operation lock.
use super::download::StagedUpdate;
use super::helper::{self, env};
use super::process::{self, Identity};
use std::path::{Path, PathBuf};
use std::time::Duration;

const HANDSHAKE: Duration = Duration::from_secs(30);

/// Everything that must be quiet before the launcher may exit for an update.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Activity {
    pub(crate) games: usize,
    pub(crate) servers: bool,
    pub(crate) tasks: bool,
    pub(crate) update_download: bool,
}

/// The reason install must wait, as an error code the UI translates.
pub(crate) fn busy_reason(activity: Activity) -> Option<&'static str> {
    if activity.games > 0 {
        Some("update.gameRunning")
    } else if activity.servers {
        Some("update.serverRunning")
    } else if activity.tasks {
        Some("update.tasksRunning")
    } else if activity.update_download {
        Some("update.downloading")
    } else {
        None
    }
}

/// Copies this executable into the staging directory without replacing
/// anything; the installer's Restart Manager would kill a helper that runs
/// from `$INSTDIR`.
pub(crate) fn copy_helper(executable: &Path, staged: &StagedUpdate) -> Result<PathBuf, String> {
    let target = staged.directory.join(helper::HELPER_EXE);
    let mut source = std::fs::File::open(executable).map_err(|_| "无法读取启动器程序")?;
    let mut copy = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|_| "无法准备更新交接程序")?;
    let copied = std::io::copy(&mut source, &mut copy).and_then(|_| copy.sync_all());
    if copied.is_err() {
        drop(copy);
        let _ = std::fs::remove_file(&target);
        return Err("无法准备更新交接程序".into());
    }
    Ok(target)
}

/// The helper command: fixed argument, a cleared environment with only the
/// system basics, and the hand-off values in fixed variables.
pub(crate) fn helper_command(
    helper_exe: &Path,
    staged: &StagedUpdate,
    parent: Identity,
    relaunch: &Path,
    error_text: &str,
    logs_text: &str,
) -> std::process::Command {
    let mut command = std::process::Command::new(helper_exe);
    command.arg(helper::ARGUMENT);
    apply_helper_environment(&mut command, staged, parent, relaunch, error_text, logs_text);
    command
}

/// The helper's environment and stdio, on any command (a test runs a probe).
pub(crate) fn apply_helper_environment(
    command: &mut std::process::Command,
    staged: &StagedUpdate,
    parent: Identity,
    relaunch: &Path,
    error_text: &str,
    logs_text: &str,
) {
    command.env_clear();
    let system_root = std::env::var_os("SystemRoot").map(PathBuf::from);
    if let Some(root) = &system_root {
        command.env("SystemRoot", root).env("PATH", format!("{};{}", root.join("System32").display(), root.display()));
        command.current_dir(root.join("System32"));
    }
    for name in ["LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    // A session-only profile override survives the update relaunch.
    for (from, to) in [("VOXELIGHT_LAUNCHER_DATA_DIR", env::DATA_DIR), ("VOXELIGHT_LAUNCHER_GAME_DIR", env::GAME_DIR)] {
        if let Some(value) = std::env::var_os(from).filter(|value| !value.is_empty()) {
            command.env(to, value);
        }
    }
    command
        .env(env::PARENT_PID, parent.pid.to_string())
        .env(env::PARENT_CREATED, parent.created.to_string())
        .env(env::INSTALLER, &staged.installer)
        .env(env::SIZE, staged.package.size.to_string())
        .env(env::SHA256, &staged.package.sha256)
        .env(env::RELAUNCH, relaunch)
        .env(env::ERROR, error_text)
        .env(env::LOGS, logs_text)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
}

/// Starts the helper and waits up to 30 s for its READY line. Any other
/// answer, an exit or the deadline stops (and reaps) the helper.
pub(crate) async fn hand_off(command: std::process::Command) -> Result<(), String> {
    use tokio::io::AsyncBufReadExt;
    let mut child = tokio::process::Command::from(command)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "无法启动更新交接程序")?;
    let stdout = child.stdout.take().ok_or("无法启动更新交接程序")?;
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let answer = tokio::time::timeout(HANDSHAKE, lines.next_line()).await;
    match answer {
        Ok(Ok(Some(line))) if line.trim() == "READY" => {
            // The helper outlives this process: do not kill it on drop.
            std::mem::forget(child);
            Ok(())
        }
        _ => {
            let _ = child.kill().await;
            Err("更新交接程序未能确认安装包，已取消更新".into())
        }
    }
}

pub(crate) fn current_identity() -> Result<Identity, String> {
    process::current().ok_or_else(|| "无法确认启动器进程身份".into())
}
