use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MARKER: &str = "owner.json";
const MAX_MARKER_BYTES: u64 = 256;
const MAX_VERSION_ENTRIES: usize = 512;
const MAX_INSTANCE_RECORDS: usize = 512;
const MAX_RUN_ENTRIES_PER_ROOT: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
struct Owner {
    pid: u32,
    created: u64,
}

impl Owner {
    fn valid(self) -> bool {
        self.pid != 0 && self.created != 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Liveness {
    Alive,
    Stale,
    Unknown,
}

fn ordinary(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.file_type().is_symlink()
}

fn ordinary_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir() && ordinary(&metadata))
}

fn checked_directory(path: &Path) -> bool {
    crate::instances::validate_absolute_syntax(path).is_ok()
        && path.ancestors().all(ordinary_directory)
}

fn read_owner(run: &Path) -> Option<Owner> {
    let marker = run.join(MARKER);
    let metadata = fs::symlink_metadata(&marker).ok()?;
    if !metadata.is_file() || !ordinary(&metadata) || metadata.len() > MAX_MARKER_BYTES {
        return None;
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT: never follow a marker replaced by a link
        // after the first metadata check.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(marker).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || !ordinary(&metadata) || metadata.len() > MAX_MARKER_BYTES {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_MARKER_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_MARKER_BYTES {
        return None;
    }
    let owner: Owner = serde_json::from_slice(&bytes).ok()?;
    owner.valid().then_some(owner)
}

fn write_owner(run: &Path, owner: Owner) -> io::Result<()> {
    if !owner.valid() || !checked_directory(run) {
        return Err(io::Error::other(
            "invalid launch scratch owner or directory",
        ));
    }
    let bytes = serde_json::to_vec(&owner).map_err(io::Error::other)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(run.join(MARKER))?;
    file.write_all(&bytes)?;
    file.sync_all()
}

#[cfg(windows)]
pub(super) fn mark_child(run: &Path, child: &tokio::process::Child, pid: u32) -> io::Result<()> {
    // Do not publish a foreign PID onto a share that can look local to its host.
    if !win32::local_fixed_drive(run) {
        return Ok(());
    }
    let handle = child
        .raw_handle()
        .ok_or_else(|| io::Error::other("Java process handle is unavailable"))?;
    // The handle is borrowed from Child; its lifetime covers this synchronous query.
    let created = win32::creation_time(windows::Win32::Foundation::HANDLE(handle))?;
    write_owner(run, Owner { pid, created })
}

fn run_name(path: &Path) -> bool {
    named_uuid(path, "run-")
}

fn named_uuid(path: &Path, prefix: &str) -> bool {
    let Some(suffix) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix(prefix))
    else {
        return false;
    };
    Uuid::parse_str(suffix).is_ok_and(|id| id.hyphenated().to_string() == suffix)
}

fn quarantine_name(path: &Path) -> bool {
    named_uuid(path, ".stale-")
}

fn root_candidates(mut entries: impl Iterator<Item = PathBuf>) -> impl Iterator<Item = PathBuf> {
    let (mut runs, mut quarantines) = (0, 0);
    std::iter::from_fn(move || {
        if runs == MAX_RUN_ENTRIES_PER_ROOT && quarantines == MAX_RUN_ENTRIES_PER_ROOT {
            return None;
        }
        entries.find(|path| {
            let count = if run_name(path) {
                &mut runs
            } else if quarantine_name(path) {
                &mut quarantines
            } else {
                return false;
            };
            if *count == MAX_RUN_ENTRIES_PER_ROOT {
                return false;
            }
            *count += 1;
            true
        })
    })
}

fn sweep_root(game: &Path, probe: impl Fn(Owner) -> Liveness) {
    let root = game.join(".launcher-temp");
    if !checked_directory(&root) {
        return;
    }
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for candidate in root_candidates(entries.flatten().map(|entry| entry.path())) {
        if !checked_directory(&candidate) {
            continue;
        }
        if quarantine_name(&candidate) {
            retry_retired_run(&candidate, &probe);
            continue;
        }
        let Some(owner) = read_owner(&candidate) else {
            // In particular, a different profile may be between spawn and
            // recording ownership. Never infer ownership from the name or age.
            continue;
        };
        if probe(owner) == Liveness::Stale {
            retire_run(&root, &candidate, owner);
        }
    }
}

fn sole_captured_run(quarantine: &Path) -> Option<PathBuf> {
    if !checked_directory(quarantine) {
        return None;
    }
    let mut entries = fs::read_dir(quarantine).ok()?;
    let run = entries.next()?.ok()?.path();
    (entries.next().is_none() && run_name(&run) && checked_directory(&run)).then_some(run)
}

fn retry_retired_run(quarantine: &Path, probe: &impl Fn(Owner) -> Liveness) {
    let Some(run) = sole_captured_run(quarantine) else {
        return;
    };
    let Some(owner) = read_owner(&run) else {
        return;
    };
    if probe(owner) == Liveness::Stale
        && sole_captured_run(quarantine).as_deref() == Some(run.as_path())
        && read_owner(&run) == Some(owner)
    {
        remove_captured_run(&run);
        let _ = fs::remove_dir(quarantine);
    }
}

fn remove_captured_run(run: &Path) {
    // std on Windows does not follow links during recursive removal. Keep
    // the original deletion boundary: only the captured child, not its parent.
    if fs::remove_dir_all(run).is_err() {
        eprintln!("[voxelight/scratch] unable to remove retired launch scratch");
    }
}

fn retire_run(root: &Path, run: &Path, owner: Owner) {
    // Reserve a private name to capture only one candidate; multiple launchers
    // may independently sweep a common game directory.
    if !checked_directory(run) || read_owner(run) != Some(owner) {
        return;
    }
    let Some(name) = run.file_name() else {
        return;
    };
    let quarantine = root.join(format!(".stale-{}", Uuid::new_v4()));
    if fs::create_dir(&quarantine).is_err() {
        return;
    }
    let captured = quarantine.join(name);
    if !checked_directory(run)
        || !checked_directory(&quarantine)
        || read_owner(run) != Some(owner)
        || crate::instances::rename_owned_directory(run, &captured).is_err()
    {
        let _ = fs::remove_dir(&quarantine);
        return;
    }
    if checked_directory(&captured) && read_owner(&captured) == Some(owner) {
        remove_captured_run(&captured);
    } else if checked_directory(root) && checked_directory(&quarantine) {
        // A changed candidate is not ours. Preserve it even if restoring the
        // original name fails (which can happen if another process reused it).
        let _ = crate::instances::rename_owned_directory(&captured, run);
    }
    let _ = fs::remove_dir(quarantine);
}

fn sweep_candidates(data: &crate::models::Persisted, mut inspect: impl FnMut(&Path)) {
    let config = &data.config;
    let mut seen = HashSet::new();
    let mut visit = |path: PathBuf| {
        if checked_directory(&path) && seen.insert(path.clone()) {
            inspect(&path);
        }
    };
    if let Ok(root) = crate::processes::configured_game_root(Path::new(&config.game_directory)) {
        // Sweep old shared scratch even if isolation is now enabled.
        visit(root.clone());
        // Only configured isolation entitles startup to inspect version roots.
        let versions = root.join("versions");
        if config.version_isolation && checked_directory(&versions) {
            if let Ok(entries) = fs::read_dir(versions) {
                for entry in entries.take(MAX_VERSION_ENTRIES).flatten() {
                    let name = entry.file_name();
                    if name
                        .to_str()
                        .is_some_and(|name| crate::storage::validate_id(name).is_ok())
                    {
                        visit(entry.path());
                    }
                }
            }
        }
    }
    // Registered instances can be outside the currently configured root.
    // Resolve each with the same validation as the game launch path.
    for instance in data.instances.iter().take(MAX_INSTANCE_RECORDS) {
        if let Ok(path) =
            crate::minecraft::game_directory(config, &instance.version_id, Some(instance))
        {
            visit(path);
        }
    }
}

#[cfg(windows)]
pub(in crate::process_output) fn sweep_on_startup(data: &crate::models::Persisted) {
    sweep_candidates(data, |game| {
        if win32::local_fixed_drive(game) {
            sweep_root(game, win32::liveness);
        }
    });
}

#[cfg(windows)]
mod win32 {
    use super::{Liveness, Owner};
    use std::{
        io,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        path::{Component, Path, Prefix},
    };
    use windows::{
        core::HRESULT,
        Win32::{
            Foundation::{ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{
                GetProcessTimes, OpenProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    };

    pub(super) fn local_fixed_drive(game: &Path) -> bool {
        let Some(Component::Prefix(prefix)) = game.components().next() else {
            return false;
        };
        let drive = match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter,
            _ => return false,
        };
        const DRIVE_FIXED: u32 = 3;
        // The existing windows features do not expose this small kernel32 API.
        #[link(name = "Kernel32")]
        unsafe extern "system" {
            fn GetDriveTypeW(root_path: *const u16) -> u32;
        }
        let root = [u16::from(drive), b':' as u16, b'\\' as u16, 0];
        // An UNC or mapped network game's files can belong to a process on
        // another host. A local PID table cannot prove such a process exited.
        unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_FIXED }
    }

    pub(super) fn creation_time(process: HANDLE) -> io::Result<u64> {
        let (mut created, mut exit, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        // The handle is valid for the call and all four structures are writable.
        unsafe { GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user) }
            .map_err(io::Error::other)?;
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    pub(super) fn liveness(owner: Owner) -> Liveness {
        if !owner.valid() {
            return Liveness::Unknown;
        }
        // A nonzero PID missing from the local process table yields
        // ERROR_INVALID_PARAMETER. AccessDenied and all other errors are unknown.
        let process = match unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                false,
                owner.pid,
            )
        } {
            Ok(handle) => handle,
            Err(error) if error.code() == HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) => {
                return Liveness::Stale;
            }
            Err(_) => return Liveness::Unknown,
        };
        // OpenProcess returned a newly owned process handle, closed by OwnedHandle.
        let process = unsafe { OwnedHandle::from_raw_handle(process.0) };
        let handle = HANDLE(process.as_raw_handle());
        match creation_time(handle) {
            Ok(created) if created != 0 && created != owner.created => return Liveness::Stale,
            Ok(created) if created == owner.created => {}
            _ => return Liveness::Unknown,
        }
        match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_OBJECT_0 => Liveness::Stale,
            WAIT_TIMEOUT => Liveness::Alive,
            _ => Liveness::Unknown,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/scratch-owner-tests")
                .join(Uuid::new_v4().to_string());
            fs::create_dir_all(&path).unwrap();
            Self(crate::storage::to_process_path(&path.canonicalize().unwrap()).unwrap())
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn run(game: &Path) -> PathBuf {
        let dir = game
            .join(".launcher-temp")
            .join(format!("run-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("launcher.args"), b"fixture").unwrap();
        dir
    }

    #[test]
    fn a3b_sweep_removes_only_exact_names_with_valid_confirmed_owners() {
        let fixture = Fixture::new();
        let game = &fixture.0;
        let markerless = run(game);
        let mut oversized = br#"{"pid":3,"created":42}"#.to_vec();
        oversized.resize(257, b' ');
        let invalid = [
            br#"{"pid":0,"created":1}"#.as_slice(),
            br#"{"pid":3,"created":0}"#,
            br#"{"pid":3,"created":null}"#,
            br#"{"pid":3}"#,
            br#"{"pid":3,"created":1,"unexpected":true}"#,
            br#"{"pid":3"#,
            &oversized,
        ];
        let malformed: Vec<_> = invalid
            .into_iter()
            .map(|bytes| {
                let path = run(game);
                fs::write(path.join(MARKER), bytes).unwrap();
                path
            })
            .collect();
        let live = run(game);
        write_owner(
            &live,
            Owner {
                pid: 1,
                created: 42,
            },
        )
        .unwrap();
        let unknown = run(game);
        write_owner(
            &unknown,
            Owner {
                pid: 2,
                created: 42,
            },
        )
        .unwrap();
        let dead = run(game);
        write_owner(
            &dead,
            Owner {
                pid: 3,
                created: 42,
            },
        )
        .unwrap();
        let root = game.join(".launcher-temp");
        let other_names = [
            "run-not-a-uuid".to_string(),
            format!("run-{}", Uuid::new_v4().simple()),
            "loader-tmp".into(),
            "server-tmp".into(),
        ];
        let unrelated: Vec<_> = other_names
            .into_iter()
            .map(|name| {
                let path = root.join(name);
                fs::create_dir(&path).unwrap();
                write_owner(
                    &path,
                    Owner {
                        pid: 3,
                        created: 42,
                    },
                )
                .unwrap();
                path
            })
            .collect();
        sweep_root(game, |owner| match owner.pid {
            1 => Liveness::Alive,
            2 => Liveness::Unknown,
            3 => Liveness::Stale,
            other => panic!("inspected an invalid fixture owner: {other}"),
        });
        assert!(!dead.exists());
        for path in [markerless, live, unknown]
            .into_iter()
            .chain(malformed)
            .chain(unrelated)
        {
            assert!(
                path.is_dir(),
                "{} was not owned by a confirmed stale run",
                path.display()
            );
        }
    }


    #[test]
    fn a3b_retries_retired_runs_but_preserves_ambiguous_quarantines() {
        let fixture = Fixture::new();
        let game = &fixture.0;
        let root = game.join(".launcher-temp");
        let capture = |pid: Option<u32>| {
            let live = run(game);
            if let Some(pid) = pid {
                write_owner(&live, Owner { pid, created: 42 }).unwrap();
            }
            let retired = root.join(format!(".stale-{}", Uuid::new_v4()));
            fs::create_dir(&retired).unwrap();
            fs::rename(&live, retired.join(live.file_name().unwrap())).unwrap();
            retired
        };
        let stale = capture(Some(3));
        let live = capture(Some(1));
        let unknown = capture(Some(2));
        let markerless = capture(None);
        let foreign = capture(Some(3));
        fs::write(foreign.join("unrelated.txt"), b"retain").unwrap();
        let empty = root.join(format!(".stale-{}", Uuid::new_v4()));
        fs::create_dir(&empty).unwrap();

        sweep_root(game, |owner| match owner.pid {
            1 => Liveness::Alive,
            2 => Liveness::Unknown,
            3 => Liveness::Stale,
            other => panic!("unexpected owner {other}"),
        });
        assert!(!stale.exists());
        for path in [live, unknown, markerless, foreign, empty] {
            assert!(path.is_dir(), "{} should be retained", path.display());
        }
    }

    #[test]
    fn a3b_root_entry_caps_do_not_count_unrelated_names_or_compete_with_retries() {
        // Vary the iterator directly so the test does not depend on native
        // filesystem directory enumeration order.
        let names = (0..MAX_RUN_ENTRIES_PER_ROOT * 2)
            .map(|i| PathBuf::from(format!("unrelated-{i}")))
            .chain(
                (0..MAX_RUN_ENTRIES_PER_ROOT + 1)
                    .map(|_| PathBuf::from(format!(".stale-{}", Uuid::new_v4()))),
            )
            .chain(
                (0..MAX_RUN_ENTRIES_PER_ROOT + 1)
                    .map(|_| PathBuf::from(format!("run-{}", Uuid::new_v4()))),
            );
        let named: Vec<_> = root_candidates(names).collect();
        assert_eq!(
            named.iter().filter(|entry| run_name(entry)).count(),
            MAX_RUN_ENTRIES_PER_ROOT
        );
        assert_eq!(
            named.iter().filter(|entry| quarantine_name(entry)).count(),
            MAX_RUN_ENTRIES_PER_ROOT
        );
    }

    #[cfg(windows)]
    #[test]
    fn a3b_liveness_detects_exited_child_while_std_child_holds_process_handle() {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;

        // std::process::Child retains its Windows process handle after wait(),
        // until Drop. This reaches the signaled-handle branch of liveness().
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let handle = HANDLE(child.as_raw_handle());
        let owner = Owner {
            pid: child.id(),
            created: win32::creation_time(handle).unwrap(),
        };
        assert!(child.wait().unwrap().success());
        assert_eq!(win32::creation_time(handle).unwrap(), owner.created);
        assert_eq!(win32::liveness(owner), Liveness::Stale);
        drop(child);
    }

    #[test]
    fn a3b_rechecks_owner_after_probe_before_claiming_name() {
        let fixture = Fixture::new();
        let game = &fixture.0;
        let path = run(game);
        write_owner(
            &path,
            Owner {
                pid: 1,
                created: 42,
            },
        )
        .unwrap();
        let replacement = Owner {
            pid: 2,
            created: 43,
        };
        sweep_root(game, |_| {
            fs::remove_file(path.join(MARKER)).unwrap();
            write_owner(&path, replacement).unwrap();
            Liveness::Stale
        });
        assert_eq!(read_owner(&path), Some(replacement));
        assert!(path.join("launcher.args").is_file());
    }

    #[test]
    fn a3b_startup_discovers_shared_isolated_and_registered_roots_only() {
        use crate::models::{Config, Instance, Persisted};

        let fixture = Fixture::new();
        let root = fixture.0.join("shared");
        let version = root.join("versions/1.21.10");
        let previous_instance = fixture.0.join("previous/instances/test");
        let unregistered = root.join("instances/unknown");
        let nested = version.join("nested");
        for game in [&version, &previous_instance, &unregistered, &nested] {
            run(game);
        }
        let mut data = Persisted {
            config: Config {
                game_directory: root.to_string_lossy().into_owned(),
                version_isolation: true,
                ..Config::default()
            },
            instances: vec![Instance {
                version_id: "1.21.10".into(),
                game_directory: previous_instance.to_string_lossy().into_owned(),
                ..Instance::default()
            }],
            ..Persisted::default()
        };
        let mut scanned = Vec::new();
        sweep_candidates(&data, |game| scanned.push(game.to_owned()));
        assert_eq!(
            scanned,
            vec![root.clone(), version, previous_instance.clone()]
        );
        data.config.version_isolation = false;
        scanned.clear();
        sweep_candidates(&data, |game| scanned.push(game.to_owned()));
        assert_eq!(scanned, vec![root, previous_instance]);
    }

    #[cfg(windows)]
    #[test]
    fn a3b_real_win32_creation_time_distinguishes_reused_pid() {
        use windows::Win32::System::Threading::GetCurrentProcess;

        let fixture = Fixture::new();
        assert!(win32::local_fixed_drive(&fixture.0));
        assert!(!win32::local_fixed_drive(Path::new(
            r"\\example.invalid\share\game"
        )));
        let live = run(&fixture.0);
        let reused = run(&fixture.0);
        // GetCurrentProcess returns a pseudo-handle; do not close it.
        let created = win32::creation_time(unsafe { GetCurrentProcess() }).unwrap();
        let owner = Owner {
            pid: std::process::id(),
            created,
        };
        assert!(owner.valid());
        write_owner(&live, owner).unwrap();
        write_owner(
            &reused,
            Owner {
                created: created + 1,
                ..owner
            },
        )
        .unwrap();
        sweep_root(&fixture.0, win32::liveness);
        assert!(live.is_dir());
        assert!(
            !reused.exists(),
            "PID still exists but belongs to a different process instance"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a3b_records_live_child_time_once_and_detects_confirmed_exit() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let fixture = Fixture::new();
                let scratch = super::super::LaunchScratch::create(&fixture.0).unwrap();
                let scratch_path = scratch.java_temp().unwrap().parent().unwrap().to_owned();
                // A child test binary printing its test list is hermetic and exits promptly.
                let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
                    .arg("--list")
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                let pid = child.id().unwrap();
                let created = win32::creation_time(windows::Win32::Foundation::HANDLE(
                    child.raw_handle().unwrap(),
                ))
                .unwrap();
                scratch.record_owner(&child, pid).unwrap();
                assert_eq!(read_owner(&scratch_path), Some(Owner { pid, created }));
                assert_eq!(
                    scratch.record_owner(&child, pid).unwrap_err().kind(),
                    io::ErrorKind::AlreadyExists
                );
                assert!(child.wait().await.unwrap().success());
                assert_eq!(win32::liveness(Owner { pid, created }), Liveness::Stale);
                drop(scratch);
                assert!(!scratch_path.exists());
            });
    }

    #[cfg(windows)]
    #[test]
    fn a3b_sweep_does_not_follow_run_or_temp_junction() {
        struct Junction(PathBuf);
        impl Drop for Junction {
            fn drop(&mut self) {
                let _ = fs::remove_dir(&self.0);
            }
        }
        fn junction(path: PathBuf, target: &Path) -> Junction {
            let output = std::process::Command::new("cmd")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(&path)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            Junction(path)
        }

        let fixture = Fixture::new();
        let outside_game = fixture.0.join("outside");
        let outside_run = run(&outside_game);
        write_owner(
            &outside_run,
            Owner {
                pid: 1,
                created: 42,
            },
        )
        .unwrap();

        let game = fixture.0.join("game");
        let temp = game.join(".launcher-temp");
        fs::create_dir_all(&temp).unwrap();
        let _run_link = junction(temp.join(outside_run.file_name().unwrap()), &outside_run);
        let redirected_game = fixture.0.join("redirected");
        fs::create_dir(&redirected_game).unwrap();
        let _temp_link = junction(
            redirected_game.join(".launcher-temp"),
            &outside_game.join(".launcher-temp"),
        );

        sweep_root(&game, |_| panic!("followed run junction"));
        sweep_root(&redirected_game, |_| {
            panic!("followed .launcher-temp junction")
        });
        assert!(outside_run.join("launcher.args").is_file());
        assert!(outside_run.join(MARKER).is_file());
    }
}
