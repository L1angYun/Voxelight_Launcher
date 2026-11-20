//! C4c: the update helper, the install gate and the staging sweep.
use super::helper::{self, inputs_from, installer_file_name, run, staging_name, validate_staging, Deps, Inputs, Outcome};
use super::install::{self, busy_reason, Activity};
use super::process::{Identity, Liveness};
use super::sweep::sweep;
use super::*;
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const BYTES: &[u8] = b"installer for the hand-off";

fn sha(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

/// A fake updates root with one staged installer.
struct Stage {
    root: crate::instances::StagingDirectory,
    directory: PathBuf,
    installer: PathBuf,
}

impl Stage {
    fn new() -> Self {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/update-handoff-tests").join(uuid::Uuid::new_v4().simple().to_string()),
        )
        .unwrap();
        let directory = root.path().join(uuid::Uuid::new_v4().simple().to_string());
        std::fs::create_dir(&directory).unwrap();
        let installer = directory.join(installer_name((0, 7, 0)));
        std::fs::write(&installer, BYTES).unwrap();
        Self { root, directory, installer }
    }
    fn inputs(&self) -> Inputs {
        Inputs {
            parent: Identity { pid: 4242, created: 99 },
            installer: self.installer.clone(),
            size: BYTES.len() as u64,
            sha256: sha(BYTES),
            relaunch: PathBuf::from("C:/Program/voxelight-launcher.exe"),
            error_text: "update failed".into(),
            logs_text: "logs:".into(),
            profile: vec![("VOXELIGHT_LAUNCHER_DATA_DIR".into(), "D:/profile".into())],
        }
    }
    fn names(&self) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(&self.directory)
            .map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }
}

/// Records every call; behaviour is set per test.
type Env = Vec<(std::ffi::OsString, std::ffi::OsString)>;

struct FakeDeps {
    alive: bool,
    exits: bool,
    exit_code: Result<i32, Option<i32>>,
    others: Result<bool, String>,
    calls: RefCell<Vec<String>>,
    installer_args: RefCell<Vec<String>>,
    installer_env: RefCell<Option<Env>>,
    relaunch_env: RefCell<Option<Env>>,
    message: RefCell<String>,
    /// Runs while "waiting for the parent", for example to tamper with the file.
    during_wait: Option<Box<dyn Fn()>>,
    /// Runs when READY is reported.
    during_ready: Option<Box<dyn Fn()>>,
}

impl FakeDeps {
    fn working() -> Self {
        Self {
            alive: true,
            exits: true,
            exit_code: Ok(0),
            others: Ok(false),
            calls: RefCell::default(),
            installer_args: RefCell::default(),
            installer_env: RefCell::default(),
            relaunch_env: RefCell::default(),
            message: RefCell::default(),
            during_wait: None,
            during_ready: None,
        }
    }
    fn called(&self, name: &str) -> bool {
        self.calls.borrow().iter().any(|call| call == name)
    }
}

impl Deps for FakeDeps {
    fn own(&self) -> Option<Identity> {
        Some(Identity { pid: 7, created: 8 })
    }
    fn parent_alive(&self, _: Identity) -> bool {
        self.alive
    }
    fn wait_parent(&self, _: Identity, _: Duration) -> bool {
        self.calls.borrow_mut().push("wait".into());
        if let Some(during) = &self.during_wait {
            during();
        }
        self.exits
    }
    fn others_running(&self, _: &Path) -> Result<bool, String> {
        self.others.clone()
    }
    fn user_environment(&self) -> Option<Env> {
        Some(vec![
            ("Path".into(), "C:/Windows;C:/Users/me/bin".into()),
            ("JAVA_HOME".into(), "C:/Java".into()),
            ("VOXELIGHT_UPD_SHA256".into(), "leaked".into()),
        ])
    }
    fn run_installer(&self, _: &Path, args: &[&str], environment: Option<&[(std::ffi::OsString, std::ffi::OsString)]>) -> Result<i32, Option<i32>> {
        self.calls.borrow_mut().push("installer".into());
        *self.installer_args.borrow_mut() = args.iter().map(|arg| arg.to_string()).collect();
        *self.installer_env.borrow_mut() = environment.map(<[_]>::to_vec);
        self.exit_code
    }
    fn ready(&self) {
        self.calls.borrow_mut().push("ready".into());
        if let Some(during) = &self.during_ready {
            during();
        }
    }
    fn not_ready(&self) {
        self.calls.borrow_mut().push("not_ready".into());
    }
    fn show_error(&self, message: &str) {
        self.calls.borrow_mut().push("error".into());
        *self.message.borrow_mut() = message.to_owned();
    }
    fn relaunch(&self, _: &Path, environment: Option<&[(std::ffi::OsString, std::ffi::OsString)]>) {
        self.calls.borrow_mut().push("relaunch".into());
        *self.relaunch_env.borrow_mut() = environment.map(<[_]>::to_vec);
    }
}

#[test]
fn hand_off_values_are_validated() {
    let stage = Stage::new();
    let inputs = stage.inputs();
    let values = |overrides: &[(&str, &str)]| {
        let mut values: HashMap<String, String> = [
            (helper::env::PARENT_PID, inputs.parent.pid.to_string()),
            (helper::env::PARENT_CREATED, inputs.parent.created.to_string()),
            (helper::env::INSTALLER, inputs.installer.display().to_string()),
            (helper::env::SIZE, inputs.size.to_string()),
            (helper::env::SHA256, inputs.sha256.clone()),
            (helper::env::RELAUNCH, inputs.relaunch.display().to_string()),
            (helper::env::ERROR, inputs.error_text.clone()),
            (helper::env::LOGS, inputs.logs_text.clone()),
            (helper::env::DATA_DIR, "D:/profile".to_owned()),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value))
        .collect();
        for (name, value) in overrides {
            values.insert(name.to_string(), value.to_string());
        }
        move |name: &str| values.get(name).cloned().filter(|value| value != "<missing>")
    };
    assert_eq!(inputs_from(values(&[])).unwrap(), inputs);
    for bad in [
        (helper::env::PARENT_PID, "0"),
        (helper::env::PARENT_PID, "-4"),
        (helper::env::PARENT_PID, "4294967296"),
        (helper::env::PARENT_CREATED, "0"),
        (helper::env::SIZE, "0"),
        (helper::env::SIZE, &(MAX_INSTALLER_BYTES + 1).to_string()),
        (helper::env::SHA256, &sha(BYTES)[1..]),
        (helper::env::SHA256, &"g".repeat(64)),
        (helper::env::ERROR, ""),
        (helper::env::LOGS, &"x".repeat(4097)),
        (helper::env::INSTALLER, "<missing>"),
    ] {
        assert!(inputs_from(values(&[bad])).is_err(), "{bad:?}");
    }
}

use std::collections::HashMap;

#[test]
fn staging_identity_is_exact() {
    assert!(installer_file_name("VoxelightLauncher-0.7.0-x64-setup.exe"));
    for bad in ["VoxelightLauncher-v0.7.0-x64-setup.exe", "VoxelightLauncher-0.7-x64-setup.exe", "other.exe", "VoxelightLauncher-0.7.0-x64-setup.exe.bat"] {
        assert!(!installer_file_name(bad), "{bad}");
    }
    assert!(staging_name(&"a".repeat(32)));
    for bad in ["A".repeat(32), "a".repeat(31), format!("{}-", "a".repeat(31)), "g".repeat(32)] {
        assert!(!staging_name(&bad), "{bad}");
    }
    let stage = Stage::new();
    assert_eq!(validate_staging(&stage.installer, stage.root.path()), Ok(()));
    assert!(validate_staging(&stage.installer, &stage.root.path().join("elsewhere")).is_err(), "another root");
    let renamed = stage.directory.join("other.exe");
    std::fs::write(&renamed, BYTES).unwrap();
    assert!(validate_staging(&renamed, stage.root.path()).is_err(), "another file name");
    let bad_dir = stage.root.path().join("not-a-guid");
    std::fs::create_dir(&bad_dir).unwrap();
    std::fs::write(bad_dir.join(installer_name((0, 7, 0))), BYTES).unwrap();
    assert!(validate_staging(&bad_dir.join(installer_name((0, 7, 0))), stage.root.path()).is_err(), "a non-guid folder");
    assert!(validate_staging(&stage.directory.join(installer_name((0, 8, 0))), stage.root.path()).is_err(), "a missing file");
}

#[test]
fn a_successful_install_runs_exactly_the_update_switches_and_cleans_up() {
    let stage = Stage::new();
    let deps = FakeDeps::working();
    assert_eq!(run(&stage.inputs(), stage.root.path(), &deps), Outcome::Installed);
    assert_eq!(*deps.calls.borrow(), ["ready", "wait", "installer"]);
    assert_eq!(*deps.installer_args.borrow(), ["/P", "/UPDATE", "/R"]);
    assert!(!stage.directory.exists(), "installer, owner marker and folder are gone: {:?}", stage.names());
    let deps = FakeDeps { exit_code: Ok(3010), ..FakeDeps::working() };
    let stage = Stage::new();
    assert_eq!(run(&stage.inputs(), stage.root.path(), &deps), Outcome::Installed, "3010 means reboot required");
}

#[test]
fn an_installer_failure_keeps_the_log_reports_it_and_starts_the_old_launcher() {
    let stage = Stage::new();
    let deps = FakeDeps { exit_code: Ok(2), ..FakeDeps::working() };
    assert_eq!(run(&stage.inputs(), stage.root.path(), &deps), Outcome::Failed);
    assert_eq!(*deps.calls.borrow(), ["ready", "wait", "installer", "error", "relaunch"]);
    assert_eq!(stage.names(), ["helper.log"], "only the failure log is kept");
    let log = std::fs::read_to_string(stage.directory.join("helper.log")).unwrap();
    assert!(log.contains("stage=installer-exit") && log.contains("installer_exit_code=2"), "{log}");
    let message = deps.message.borrow().clone();
    assert!(message.starts_with("update failed\n\nlogs:\n") && message.contains("helper.log"), "{message}");
}

#[test]
fn nothing_is_installed_while_the_parent_keeps_running() {
    let stage = Stage::new();
    let deps = FakeDeps { exits: false, ..FakeDeps::working() };
    assert_eq!(run(&stage.inputs(), stage.root.path(), &deps), Outcome::Failed);
    assert!(!deps.called("installer"));
    assert!(!deps.called("relaunch"), "the old launcher is still running");
    assert!(deps.called("error"));
}

#[test]
fn a_bad_installer_or_a_changed_parent_is_refused_before_ready() {
    let stage = Stage::new();
    let mut inputs = stage.inputs();
    inputs.sha256 = sha(b"other");
    let deps = FakeDeps::working();
    assert_eq!(run(&inputs, stage.root.path(), &deps), Outcome::Refused);
    assert_eq!(*deps.calls.borrow(), ["not_ready"]);
    assert!(stage.installer.exists(), "a refused hand-off leaves the staged files to the parent");

    let deps = FakeDeps { alive: false, ..FakeDeps::working() };
    assert_eq!(run(&stage.inputs(), stage.root.path(), &deps), Outcome::Refused);
    assert_eq!(*deps.calls.borrow(), ["not_ready"]);

    let mut outside = stage.inputs();
    outside.installer = stage.root.path().join(installer_name((0, 7, 0)));
    std::fs::write(&outside.installer, BYTES).unwrap();
    assert_eq!(run(&outside, stage.root.path(), &FakeDeps::working()), Outcome::Refused);
}

#[test]
fn the_helper_records_its_own_identity_before_ready() {
    let stage = Stage::new();
    let directory = stage.directory.clone();
    let seen = std::rc::Rc::new(RefCell::new(None));
    let record = seen.clone();
    let deps = FakeDeps {
        exits: false,
        // Read at the moment READY is reported, not later.
        during_ready: Some(Box::new(move || {
            *record.borrow_mut() = std::fs::read(directory.join("owner.json")).ok();
        })),
        ..FakeDeps::working()
    };
    run(&stage.inputs(), stage.root.path(), &deps);
    let owner: Identity = serde_json::from_slice(&seen.borrow().clone().expect("owner.json exists when READY is reported")).unwrap();
    assert_eq!(owner, Identity { pid: 7, created: 8 });
}

#[cfg(windows)]
#[test]
fn the_installer_cannot_be_replaced_while_the_helper_waits() {
    let stage = Stage::new();
    let installer = stage.installer.clone();
    let blocked = std::rc::Rc::new(RefCell::new(false));
    let record = blocked.clone();
    let deps = FakeDeps {
        during_wait: Some(Box::new(move || {
            *record.borrow_mut() = std::fs::OpenOptions::new().write(true).open(&installer).is_err();
        })),
        ..FakeDeps::working()
    };
    assert_eq!(run(&stage.inputs(), stage.root.path(), &deps), Outcome::Installed);
    assert!(*blocked.borrow(), "writers are denied between the checks and the install");
}

fn owner_file(directory: &Path, owner: Identity) {
    std::fs::write(directory.join(helper::OWNER), serde_json::to_vec(&owner).unwrap()).unwrap();
}

#[test]
fn the_sweep_removes_only_known_files_of_finished_hand_offs() {
    let stage = Stage::new();
    let root = stage.root.path().to_owned();
    let dead = Identity { pid: 1, created: 1 };
    let alive = Identity { pid: 2, created: 2 };
    let liveness = |who: Identity| match who.pid {
        1 => Liveness::Stale,
        2 => Liveness::Alive,
        _ => Liveness::Unknown,
    };
    // A finished hand-off with a foreign file inside.
    owner_file(&stage.directory, dead);
    std::fs::write(stage.directory.join(helper::HELPER_EXE), b"copy").unwrap();
    std::fs::write(stage.directory.join("user-notes.txt"), b"keep").unwrap();
    // A running helper, an unknown one, an unowned young folder and a foreign folder.
    let folder = |owner: Option<Identity>| {
        let directory = root.join(uuid::Uuid::new_v4().simple().to_string());
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join(installer_name((0, 7, 0))), BYTES).unwrap();
        if let Some(owner) = owner {
            owner_file(&directory, owner);
        }
        directory
    };
    let running = folder(Some(alive));
    let unknown = folder(Some(Identity { pid: 3, created: 3 }));
    let young = folder(None);
    let foreign = root.join("not-ours");
    std::fs::create_dir(&foreign).unwrap();
    std::fs::write(foreign.join(installer_name((0, 7, 0))), BYTES).unwrap();

    sweep(&root, liveness, SystemTime::now());
    assert_eq!(stage.names(), ["user-notes.txt"], "only known names are removed");
    for kept in [&running, &unknown, &young] {
        assert!(kept.join(installer_name((0, 7, 0))).exists(), "{}", kept.display());
    }
    assert!(foreign.join(installer_name((0, 7, 0))).exists());

    // An unowned folder is removed once it is an hour old.
    sweep(&root, liveness, SystemTime::now() + Duration::from_secs(2 * 60 * 60));
    assert!(!young.exists());
    assert!(running.exists() && foreign.exists());
}

#[test]
fn a_failure_log_is_kept_for_a_week() {
    let stage = Stage::new();
    let root = stage.root.path().to_owned();
    owner_file(&stage.directory, Identity { pid: 1, created: 1 });
    std::fs::write(stage.directory.join(helper::LOG), b"stage=installer-exit").unwrap();
    let stale = |_: Identity| Liveness::Stale;
    sweep(&root, stale, SystemTime::now());
    assert_eq!(stage.names(), ["helper.log"]);
    sweep(&root, stale, SystemTime::now() + Duration::from_secs(8 * 24 * 60 * 60));
    assert!(!stage.directory.exists());
}

#[test]
fn install_waits_for_games_servers_tasks_and_downloads() {
    assert_eq!(busy_reason(Activity::default()), None);
    assert_eq!(busy_reason(Activity { games: 1, ..Activity::default() }), Some("update.gameRunning"));
    assert_eq!(busy_reason(Activity { servers: true, ..Activity::default() }), Some("update.serverRunning"));
    assert_eq!(busy_reason(Activity { tasks: true, ..Activity::default() }), Some("update.tasksRunning"));
    assert_eq!(busy_reason(Activity { update_download: true, ..Activity::default() }), Some("update.downloading"));

    let stage = Stage::new();
    let state = LauncherState::test_fixture(stage.root.path().join("profile"), Default::default(), crate::storage::test_client());
    let service = UpdateService::default();
    let servers = crate::server_manager::ServerRegistry::default();
    assert_eq!(activity(&state, &service, &servers).unwrap(), Activity::default());
    state.games.fixture_running_root(&stage.root.path().join("game"));
    assert_eq!(activity(&state, &service, &servers).unwrap().games, 1);
    let task = state.control.begin("install", "1.21.1", "fixture").unwrap();
    assert!(activity(&state, &service, &servers).unwrap().tasks);
    state.control.finish(&task, None);
    service.download_state.store(RUNNING, std::sync::atomic::Ordering::SeqCst);
    assert!(activity(&state, &service, &servers).unwrap().update_download);
    assert!(!activity(&state, &service, &servers).unwrap().servers);
    servers.fixture_alive("fixture-server");
    assert!(activity(&state, &service, &servers).unwrap().servers);
    assert!(servers.try_hold().is_some(), "the server lock is free while no operation runs");
    drop(state);
}

#[test]
fn the_helper_copy_never_replaces_a_file_and_the_command_carries_only_fixed_values() {
    let stage = Stage::new();
    let package = super::manifest::Package {
        version: (0, 7, 0),
        tag: "v0.7.0".into(),
        file_name: installer_name((0, 7, 0)),
        size: BYTES.len() as u64,
        sha256: sha(BYTES),
        source: Source::GitHub,
    };
    let fake = super::download::StagedUpdate::for_test(stage.directory.clone(), stage.installer.clone(), package);
    let source = stage.root.path().join("launcher.exe");
    std::fs::write(&source, b"launcher binary").unwrap();
    let copy = install::copy_helper(&source, &fake).unwrap();
    assert_eq!(copy.file_name().unwrap(), helper::HELPER_EXE);
    assert_eq!(std::fs::read(&copy).unwrap(), b"launcher binary");
    assert!(install::copy_helper(&source, &fake).is_err(), "an existing helper copy is never replaced");

    let parent = Identity { pid: 11, created: 12 };
    let command = install::helper_command(&copy, &fake, parent, &source, "error text", "logs text");
    let args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
    assert_eq!(args, [helper::ARGUMENT]);
    let envs: HashMap<String, String> = command
        .get_envs()
        .filter_map(|(key, value)| Some((key.to_string_lossy().into_owned(), value?.to_string_lossy().into_owned())))
        .collect();
    assert_eq!(envs[helper::env::PARENT_PID], "11");
    assert_eq!(envs[helper::env::PARENT_CREATED], "12");
    assert_eq!(envs[helper::env::SHA256], sha(BYTES));
    assert_eq!(envs[helper::env::SIZE], BYTES.len().to_string());
    assert_eq!(PathBuf::from(&envs[helper::env::INSTALLER]), stage.installer);
    let allowed = ["SystemRoot", "PATH", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"];
    assert!(
        envs.keys().all(|key| key.starts_with("VOXELIGHT_UPD_") || allowed.iter().any(|name| name.eq_ignore_ascii_case(key))),
        "{envs:?}"
    );
    fake.hand_off();
}

#[cfg(windows)]
#[test]
fn the_hand_off_accepts_only_a_ready_line() {
    let run_cmd = |script: &str| {
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/D", "/C", script]).stdout(std::process::Stdio::piped());
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(install::hand_off(command))
    };
    assert_eq!(run_cmd("echo READY"), Ok(()));
    assert!(run_cmd("echo ERROR").is_err());
    assert!(run_cmd("exit 1").is_err());
}

#[test]
fn another_launcher_from_the_same_folder_stops_the_install() {
    let stage = Stage::new();
    let deps = FakeDeps { others: Ok(true), ..FakeDeps::working() };
    assert_eq!(run(&stage.inputs(), stage.root.path(), &deps), Outcome::Failed);
    assert!(!deps.called("installer"), "the installer would force-close the other launcher");
    assert!(!deps.called("relaunch"), "a launcher is still running");
    let log = std::fs::read_to_string(stage.directory.join("helper.log")).unwrap();
    assert!(log.contains("stage=other-instance\r\n"), "{log}");

    let stage = Stage::new();
    let deps = FakeDeps { others: Err("rm failed".into()), ..FakeDeps::working() };
    assert_eq!(run(&stage.inputs(), stage.root.path(), &deps), Outcome::Failed, "an unconfirmed check fails closed");
    assert!(!deps.called("installer"));
    assert!(deps.called("relaunch"));
}

#[test]
fn a_start_failure_keeps_the_os_error_in_the_log() {
    let stage = Stage::new();
    let deps = FakeDeps { exit_code: Err(Some(1260)), ..FakeDeps::working() };
    assert_eq!(run(&stage.inputs(), stage.root.path(), &deps), Outcome::Failed);
    let log = std::fs::read_to_string(stage.directory.join("helper.log")).unwrap();
    assert!(log.contains("stage=start-installer") && log.contains("win32_error=1260"), "{log}");
}

#[test]
fn the_installer_and_the_relaunch_get_the_users_environment_not_the_helpers() {
    let stage = Stage::new();
    let deps = FakeDeps { exit_code: Ok(1), ..FakeDeps::working() };
    run(&stage.inputs(), stage.root.path(), &deps);
    for (what, environment) in [("installer", deps.installer_env.borrow().clone()), ("relaunch", deps.relaunch_env.borrow().clone())] {
        let environment = environment.unwrap_or_else(|| panic!("{what} got an environment"));
        let get = |name: &str| environment.iter().find(|(key, _)| key == name).map(|(_, value)| value.to_string_lossy().into_owned());
        assert_eq!(get("JAVA_HOME").as_deref(), Some("C:/Java"), "{what}: the user's variables");
        assert_eq!(get("VOXELIGHT_LAUNCHER_DATA_DIR").as_deref(), Some("D:/profile"), "{what}: the profile override");
        assert!(!environment.iter().any(|(key, _)| key.to_string_lossy().starts_with("VOXELIGHT_UPD_")), "{what}: no hand-off values");
    }
    assert_eq!(helper::child_environment(None, &[]), None, "without a user environment the default is kept");
}

#[cfg(windows)]
#[test]
fn the_helper_really_runs_with_only_the_fixed_environment() {
    let stage = Stage::new();
    // A probe batch file prints the environment it receives.
    let probe = stage.root.path().join("probe.cmd");
    std::fs::write(&probe, "@set\r\n").unwrap();
    let package = super::manifest::Package {
        version: (0, 7, 0),
        tag: "v0.7.0".into(),
        file_name: installer_name((0, 7, 0)),
        size: BYTES.len() as u64,
        sha256: sha(BYTES),
        source: Source::GitHub,
    };
    let staged = super::download::StagedUpdate::for_test(stage.directory.clone(), stage.installer.clone(), package);
    let mut command = std::process::Command::new(&probe);
    install::apply_helper_environment(&mut command, &staged, Identity { pid: 1, created: 2 }, &probe, "error", "logs");
    let output = command.output().unwrap();
    staged.hand_off();
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    // cmd.exe adds a few of its own; nothing else of this test process may arrive.
    let cmd_own = ["COMSPEC", "PATHEXT", "PROMPT"];
    let allowed = ["SYSTEMROOT", "PATH", "LOCALAPPDATA", "TEMP", "TMP", "USERPROFILE"];
    let keys: Vec<String> = text.lines().filter_map(|line| line.split_once('=').map(|(key, _)| key.to_ascii_uppercase())).collect();
    assert!(keys.iter().any(|key| key == "VOXELIGHT_UPD_SHA256"), "{text}");
    for key in &keys {
        assert!(
            key.starts_with("VOXELIGHT_UPD_") || allowed.contains(&key.as_str()) || cmd_own.contains(&key.as_str()),
            "unexpected variable {key} in the helper environment"
        );
    }
    assert!(!keys.iter().any(|key| key == "CARGO" || key == "USERNAME"), "inherited variables are cleared");
}

#[test]
fn the_gate_holds_both_locks_and_blocks_downloads_until_exit() {
    let stage = Stage::new();
    let state = LauncherState::test_fixture(stage.root.path().join("profile"), Default::default(), crate::storage::test_client());
    let service = UpdateService::default();
    let servers = crate::server_manager::ServerRegistry::default();
    let exe = stage.root.path().join("voxelight-launcher.exe");
    let me = Identity { pid: 5, created: 6 };
    let code = |result: AppResult<InstallGate>| result.err().map(|error| error.code);
    let alone = |_: &Path, _: Option<Identity>| Ok(false);

    {
        let _busy = state.operation.try_lock().unwrap();
        assert_eq!(code(hold_idle(&state, &service, &servers, &exe, me, alone)).as_deref(), Some("update.tasksRunning"));
    }
    {
        let _starting = servers.try_hold().unwrap();
        assert_eq!(code(hold_idle(&state, &service, &servers, &exe, me, alone)).as_deref(), Some("update.serverRunning"));
    }
    let queued = state.control.begin("install", "1.21.1", "fixture").unwrap();
    assert_eq!(code(hold_idle(&state, &service, &servers, &exe, me, alone)).as_deref(), Some("update.tasksRunning"));
    state.control.finish(&queued, None);

    let other = |_: &Path, except: Option<Identity>| {
        assert_eq!(except, Some(Identity { pid: 5, created: 6 }), "this launcher is the exception");
        Ok(true)
    };
    assert_eq!(code(hold_idle(&state, &service, &servers, &exe, me, other)).as_deref(), Some("update.otherInstance"));
    let unknown = |_: &Path, _: Option<Identity>| Err("rm failed".to_owned());
    assert_eq!(code(hold_idle(&state, &service, &servers, &exe, me, unknown)).as_deref(), Some("update.otherInstanceUnknown"));
    assert_eq!(service.download_state.load(std::sync::atomic::Ordering::SeqCst), IDLE, "a refusal gives the state back");

    let gate = hold_idle(&state, &service, &servers, &exe, me, alone).unwrap();
    assert!(state.operation.try_lock().is_err(), "the operation lock is held");
    assert!(servers.try_hold().is_none(), "the server lock is held");
    let root = stage.root.path().join("updates");
    let blocked = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(download_with(&state, &service, &FakeNever, &root, &|_, _| {}));
    assert_eq!(blocked.err().as_deref(), Some("更新已在下载中"), "no download starts after the gate");
    drop(gate);
    assert!(state.operation.try_lock().is_ok() && servers.try_hold().is_some());
    assert_eq!(service.download_state.load(std::sync::atomic::Ordering::SeqCst), IDLE);
    drop(state);
}

/// A transport that must never be used.
struct FakeNever;

impl super::sources::Transport for FakeNever {
    fn send(&self, request: super::sources::Request) -> futures_util::future::BoxFuture<'_, Result<super::sources::Response, String>> {
        panic!("unexpected request to {}", request.url)
    }
}

#[cfg(windows)]
fn junction(alias: &Path, target: &Path) {
    let output = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(alias.to_string_lossy().replace('/', r"\"))
        .arg(target.to_string_lossy().replace('/', r"\"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
}

#[cfg(windows)]
#[test]
fn the_sweep_and_the_helper_never_follow_a_junctioned_staging_folder() {
    let stage = Stage::new();
    let outside = stage.root.path().join("outside");
    std::fs::create_dir(&outside).unwrap();
    owner_file(&outside, Identity { pid: 1, created: 1 });
    std::fs::write(outside.join(installer_name((0, 7, 0))), BYTES).unwrap();
    std::fs::write(outside.join(helper::HELPER_EXE), b"user file").unwrap();
    let alias = stage.root.path().join(uuid::Uuid::new_v4().simple().to_string());
    junction(&alias, &outside);
    sweep(stage.root.path(), |_| Liveness::Stale, SystemTime::now() + Duration::from_secs(30 * 24 * 60 * 60));
    let installer = alias.join(installer_name((0, 7, 0)));
    let refused = validate_staging(&installer, stage.root.path());
    let _ = std::fs::remove_dir(&alias);
    assert!(outside.join(installer_name((0, 7, 0))).exists() && outside.join(helper::HELPER_EXE).exists(), "nothing behind the junction was removed");
    assert!(refused.is_err(), "the helper refuses an installer reached through a junction");
}
