use super::*;
use crate::parts::range_server::{RangeServer, Scripted};

fn hex1(bytes: &[u8]) -> String {
    format!("{:x}", Sha1::digest(bytes))
}
fn hex512(bytes: &[u8]) -> String {
    format!("{:x}", Sha512::digest(bytes))
}
fn hex256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// A launcher with one instance, `test`, under `<root>/game/instances/test`,
/// on vanilla 1.20.1, and the Modrinth API pointed at a local server.
struct Fixture {
    _root: crate::instances::StagingDirectory,
    state: Arc<LauncherState>,
    live: PathBuf,
    data: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = crate::instances::StagingDirectory::create(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("target/pack-update-tests").join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let game = root.path().join("game");
        let versions = game.join("versions/1.20.1");
        fs::create_dir_all(&versions).unwrap();
        fs::write(versions.join("1.20.1.json"), br#"{"id":"1.20.1"}"#).unwrap();
        let live = game.join("instances/test");
        fs::create_dir_all(&live).unwrap();
        let data = root.path().join("data");
        fs::create_dir_all(&data).unwrap();
        let instance = Instance {
            id: "test".into(),
            name: "Fixture".into(),
            version_id: "1.20.1".into(),
            game_directory: live.to_string_lossy().into_owned(),
            ..Instance::default()
        };
        let state = Arc::new(LauncherState::test_fixture(
            data.clone(),
            crate::models::Persisted {
                config: crate::models::Config {
                    game_directory: game.to_string_lossy().into_owned(),
                    proxy_mode: "none".into(),
                    ..Default::default()
                },
                instances: vec![instance],
                ..Default::default()
            },
            reqwest::Client::builder().no_proxy().build().unwrap(),
        ));
        Self { _root: root, state, live, data }
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        let path = self.live.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// Puts verified bytes where `fetch_verified` finds them, so nothing is downloaded.
    fn cache(&self, bytes: &[u8]) {
        let cache = self.data.join("pack-cache");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join(format!("{}.bin", hex512(bytes))), bytes).unwrap();
    }

    fn backups(&self) -> Vec<String> {
        let folder = self.data.join("instance-backups/test");
        let mut names: Vec<_> = fs::read_dir(folder)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn siblings(&self) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(self.live.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

/// Points the Modrinth API at `server` for this thread.
struct Api;

impl Api {
    fn at(server: &RangeServer) -> Self {
        crate::resources::TEST_ENDPOINTS.with(|endpoints| {
            *endpoints.borrow_mut() = Some(crate::resources::TestEndpoints {
                modrinth_api: format!("http://{}", server.address),
                curseforge_api: String::new(),
                cdn: server.address.parse().unwrap(),
                prepared_version: None,
            })
        });
        Api
    }
}

impl Drop for Api {
    fn drop(&mut self) {
        crate::resources::TEST_ENDPOINTS.with(|endpoints| *endpoints.borrow_mut() = None);
    }
}

fn json_reply(value: Value) -> Scripted {
    Scripted::ok(value.to_string().as_bytes(), "\"j\"")
}

fn index_file(path: &str, bytes: &[u8]) -> Value {
    json!({
        "path": path,
        "hashes": {"sha1": hex1(bytes), "sha512": hex512(bytes)},
        "downloads": [format!("https://cdn.modrinth.com/data/fixture/{}", path.rsplit('/').next().unwrap())],
        "fileSize": bytes.len(),
    })
}

/// A .mrpack with these index files and override entries (full entry names).
fn mrpack(version: &str, files: &[(&str, &[u8])], overrides: &[(&str, &[u8])]) -> Vec<u8> {
    let files = files.iter().map(|(path, bytes)| index_file(path, bytes)).collect();
    mrpack_from(version, files, overrides, json!({"minecraft": "1.20.1"}))
}

fn mrpack_from(version: &str, files: Vec<Value>, overrides: &[(&str, &[u8])], dependencies: Value) -> Vec<u8> {
    let index = json!({
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": version,
        "name": "Fixture Pack",
        "files": files,
        "dependencies": dependencies,
    });
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("modrinth.index.json", SimpleFileOptions::default()).unwrap();
    zip.write_all(index.to_string().as_bytes()).unwrap();
    for (name, bytes) in overrides {
        zip.start_file(*name, SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn version_reply(id: &str, number: &str, date: &str, archive: &[u8]) -> Scripted {
    json_reply(json!({
        "id": id,
        "project_id": "fixturepack",
        "name": number,
        "version_number": number,
        "game_versions": ["1.20.1"],
        "loaders": ["minecraft"],
        "date_published": date,
        "files": [{
            "url": format!("https://cdn.modrinth.com/data/fixturepack/versions/{id}/pack.mrpack"),
            "filename": "pack.mrpack",
            "primary": true,
            "size": archive.len(),
            "hashes": {"sha1": hex1(archive), "sha512": hex512(archive)},
        }],
    }))
}

fn lock(files: &[(&str, &[u8])], overrides: &[(&str, &[u8])]) -> Value {
    json!({
        "formatVersion": 2,
        "name": "Fixture Pack",
        "dependencies": {"minecraft": "1.20.1"},
        "files": files.iter().map(|(path, bytes)| json!({"path": path, "sha1": hex1(bytes), "sha512": hex512(bytes), "size": bytes.len()})).collect::<Vec<_>>(),
        "overrides": overrides.iter().map(|(path, bytes)| json!({"relative": path, "size": bytes.len(), "sha256": hex256(bytes)})).collect::<Vec<_>>(),
        "source": {"kind": "modrinth", "projectId": "fixturepack", "versionId": "oldver", "versionNumber": "1.0"},
    })
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
}

#[test]
fn c10_the_lock_says_whether_and_how_an_instance_is_managed() {
    let fixture = Fixture::new();
    let reason = |value: Option<Vec<u8>>| {
        let path = fixture.live.join(LOCK);
        let _ = fs::remove_file(&path);
        if let Some(bytes) = value {
            fs::write(&path, bytes).unwrap();
        }
        match read_lock(&fixture.live) {
            Management::Unmanaged(reason) => reason,
            Management::Managed(_) => "managed",
        }
    };
    let valid = lock(&[("mods/a.jar", b"a")], &[("config/x.toml", b"x")]);
    let bytes = |value: &Value| value.to_string().into_bytes();
    assert_eq!(reason(None), "noLock");
    assert_eq!(reason(Some(br#"{"formatVersion":1,"name":"Old","dependencies":{"minecraft":"1.20.1"}}"#.to_vec())), "legacyLock");
    let mut unsourced = valid.clone();
    unsourced.as_object_mut().unwrap().remove("source");
    assert_eq!(reason(Some(bytes(&unsourced))), "noSource");
    let mut other = valid.clone();
    other["source"] = json!({"kind": "ftb", "projectId": 1});
    assert_eq!(reason(Some(bytes(&other))), "noSource", "a platform this launcher does not update");
    let mut curse = valid.clone();
    curse["source"] = json!({"kind": "curseforge", "projectId": 1});
    assert_eq!(reason(Some(bytes(&curse))), "invalidLock", "a CurseForge source without its file and version");
    assert_eq!(reason(Some(bytes(&valid))), "managed");
    let mut bom = b"\xEF\xBB\xBF".to_vec();
    bom.extend(bytes(&valid));
    assert_eq!(reason(Some(bom)), "managed", "a byte-order mark is accepted");
    for (label, change) in [
        ("a path out of the instance", json!({"files": [{"path": "../x.jar", "sha1": hex1(b"a"), "sha512": hex512(b"a"), "size": 1}]})),
        ("a short sha1", json!({"files": [{"path": "mods/a.jar", "sha1": "abc", "sha512": hex512(b"a"), "size": 1}]})),
        ("an empty file", json!({"files": [{"path": "mods/a.jar", "sha1": hex1(b""), "sha512": hex512(b""), "size": 0}]})),
        ("a bad override hash", json!({"overrides": [{"relative": "config/x.toml", "size": 1, "sha256": "zz"}]})),
        ("a path listed twice", json!({"overrides": [{"relative": "MODS/A.jar", "size": 1, "sha256": hex256(b"a")}]})),
        ("a bad project id", json!({"source": {"kind": "modrinth", "projectId": "bad id!", "versionId": "oldver", "versionNumber": "1.0"}})),
        ("an unknown loader", json!({"dependencies": {"minecraft": "1.20.1", "rift": "1"}})),
        ("a later format", json!({"formatVersion": 3})),
    ] {
        let mut broken = valid.clone();
        for (key, value) in change.as_object().unwrap() {
            broken[key] = value.clone();
        }
        assert_eq!(reason(Some(bytes(&broken))), "invalidLock", "{label}");
    }
    let mut huge = bytes(&valid);
    huge.resize(MAX_LOCK_BYTES as usize + 1, b' ');
    assert_eq!(reason(Some(huge)), "invalidLock", "a lock over the size limit");
    // A lock written before updates existed included no optional files.
    fs::write(fixture.live.join(LOCK), bytes(&valid)).unwrap();
    let Management::Managed(pack) = read_lock(&fixture.live) else { panic!("managed") };
    assert!(!pack.include_optional);
    assert_eq!((pack.project_id.as_str(), pack.version_id.as_str(), pack.version_number.as_str()), ("fixturepack", "oldver", "1.0"));
    assert_eq!(pack.baseline.len(), 2);
    let mut optional = valid.clone();
    optional["includeOptional"] = json!(true);
    fs::write(fixture.live.join(LOCK), bytes(&optional)).unwrap();
    let Management::Managed(pack) = read_lock(&fixture.live) else { panic!("managed") };
    assert!(pack.include_optional);
}

#[test]
fn c10_only_newer_versions_of_the_same_pack_are_offered() {
    let archive = mrpack("v", &[], &[]);
    let parse = |reply: Scripted| -> ApiVersion { serde_json::from_slice(&reply.body).unwrap() };
    let versions = || {
        vec![
            parse(version_reply("v1", "1.0", "2026-01-01T00:00:00Z", &archive)),
            parse(version_reply("v3", "3.0", "2026-03-01T00:00:00Z", &archive)),
            parse(version_reply("v2", "2.0", "2026-02-01T00:00:00.500Z", &archive)),
            parse(version_reply("v0", "0.9", "2025-12-01T00:00:00Z", &archive)),
        ]
    };
    let (newer, missing) = newer_versions("v1", "fixturepack", versions()).unwrap();
    assert_eq!(newer.iter().map(|version| version.id.as_str()).collect::<Vec<_>>(), ["v3", "v2"]);
    assert!(!missing);
    let (newer, missing) = newer_versions("v3", "fixturepack", versions()).unwrap();
    assert!(newer.is_empty() && !missing, "the newest installed has nothing newer");
    let (newer, missing) = newer_versions("gone", "fixturepack", versions()).unwrap();
    assert_eq!(newer.len(), 4, "an installed version no longer listed: all are offered");
    assert!(missing);
    let mut foreign = versions();
    foreign[0].project_id = "another".into();
    assert_eq!(newer_versions("v1", "fixturepack", foreign).err().unwrap(), VERSION_MISMATCH);
}

/// The installed version 1.0 and its files, with the user's changes, and a
/// new version 2.0 served by a local API.
struct Scenario {
    fixture: Fixture,
    archive: Vec<u8>,
}

const A1: &[u8] = b"mod a version one";
const A2: &[u8] = b"mod a version two";
const B1: &[u8] = b"mod b version one";
const B2: &[u8] = b"mod b version two";
const C1: &[u8] = b"mod c, dropped in two";
const D1: &[u8] = b"mod d, new in two";
const X1: &[u8] = b"config from version one";
const X2: &[u8] = b"config from version two";
const MINE: &[u8] = b"config the user edited";
const O1: &[u8] = b"options one";
const O2: &[u8] = b"options two";

impl Scenario {
    fn new() -> Self {
        let fixture = Fixture::new();
        fixture.write("mods/a.jar", A1);
        fixture.write("mods/b.jar.disabled", B1);
        fixture.write("mods/c.jar", C1);
        fixture.write("mods/user.jar", b"a mod the user added");
        fixture.write("config/x.toml", MINE);
        fixture.write("options.txt", O1);
        fixture.write("saves/world/level.dat", b"the user's world");
        let installed = lock(&[("mods/a.jar", A1), ("mods/b.jar", B1), ("mods/c.jar", C1)], &[("config/x.toml", X1), ("options.txt", O1)]);
        fs::write(fixture.live.join(LOCK), installed.to_string()).unwrap();
        let archive = mrpack(
            "2.0",
            &[("mods/a.jar", A2), ("mods/b.jar", B2), ("mods/d.jar", D1)],
            &[("overrides/config/x.toml", X2), ("overrides/options.txt", b"options from the first layer"), ("client-overrides/options.txt", O2), ("overrides/saves/world/level.dat", b"a pack world")],
        );
        for bytes in [A2, B2, D1, archive.as_slice()] {
            fixture.cache(bytes);
        }
        Self { fixture, archive }
    }

    /// The API answers for one plan: the new version, then the installed one.
    fn replies(&self) -> Vec<Scripted> {
        vec![
            version_reply("newver", "2.0", "2026-02-01T00:00:00Z", &self.archive),
            version_reply("oldver", "1.0", "2026-01-01T00:00:00Z", &self.archive),
        ]
    }

    fn plan(&self, runtime: &tokio::runtime::Runtime, include_optional: Option<bool>) -> Result<PackUpdatePlan, String> {
        runtime.block_on(prepare(&self.fixture.state, "test", "newver", include_optional)).map(|prepared| prepared.summary())
    }

    fn apply(&self, runtime: &tokio::runtime::Runtime, plan: &PackUpdatePlan, choices: &[ConflictChoice]) -> crate::errors::AppResult<PackUpdateResult> {
        runtime.block_on(apply_inner(None, &self.fixture.state, "test", "newver", plan.include_optional, &plan.fingerprint, choices))
    }

    fn read(&self, relative: &str) -> Vec<u8> {
        fs::read(self.fixture.live.join(relative)).unwrap()
    }
}

#[test]
fn c10_an_update_keeps_the_users_changes_and_records_the_new_baseline() {
    let scenario = Scenario::new();
    let fixture = &scenario.fixture;
    let mut replies = scenario.replies();
    replies.extend(scenario.replies());
    const X3: &[u8] = b"config from version three";
    let third = mrpack(
        "3.0",
        &[("mods/a.jar", A2), ("mods/b.jar", B2), ("mods/d.jar", D1)],
        &[("overrides/config/x.toml", X3), ("client-overrides/options.txt", O2)],
    );
    fixture.cache(&third);
    replies.push(version_reply("v3", "3.0", "2026-03-01T00:00:00Z", &third));
    replies.push(version_reply("newver", "2.0", "2026-02-01T00:00:00Z", &scenario.archive));
    let api = RangeServer::new(replies);
    let _api = Api::at(&api);
    let runtime = runtime();
    let before_backups = fixture.backups().len();
    let plan = scenario.plan(&runtime, None).unwrap();
    assert_eq!((plan.from.version_id.as_str(), plan.to.version_id.as_str()), ("oldver", "newver"));
    assert_eq!((plan.add, plan.replace, plan.remove, plan.unchanged), (1, 3, 1, 0), "d added; a, b (disabled) and options replaced; c removed");
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].path, "config/x.toml");
    assert_eq!(plan.conflicts[0].reason, planner::ConflictReason::UserModified);
    assert_eq!(plan.skipped, ["saves/world/level.dat"]);
    assert!(plan.dropped_intents.is_empty());
    assert!(plan.dependency_change.is_none());
    assert_eq!(plan.download_bytes, (A2.len() + B2.len() + D1.len()) as u64);
    assert!(!plan.include_optional);
    assert_eq!(fixture.backups().len(), before_backups, "planning changes nothing");

    let choices = [ConflictChoice { path: "config/x.toml".into(), use_upstream: false }];
    let result = scenario.apply(&runtime, &plan, &choices).unwrap();
    assert_eq!(result.instance.id, "test");
    assert_eq!(scenario.read("mods/a.jar"), A2);
    assert_eq!(scenario.read("mods/b.jar.disabled"), B2, "a disabled mod stays disabled");
    assert!(!fixture.live.join("mods/b.jar").exists());
    assert!(!fixture.live.join("mods/c.jar").exists());
    assert_eq!(scenario.read("mods/d.jar"), D1);
    assert_eq!(scenario.read("config/x.toml"), MINE, "the user's edit is kept");
    assert_eq!(scenario.read("options.txt"), O2, "the later override layer wins");
    assert_eq!(scenario.read("mods/user.jar"), b"a mod the user added");
    assert_eq!(scenario.read("saves/world/level.dat"), b"the user's world");
    // The new baseline is what version 2.0 provides, so the kept edit stays a user change.
    let written: Value = serde_json::from_slice(&scenario.read(LOCK)).unwrap();
    assert_eq!(written["source"]["versionId"], "newver");
    assert_eq!(written["includeOptional"], false);
    let files: Vec<_> = written["files"].as_array().unwrap().iter().map(|file| file["path"].as_str().unwrap().to_owned()).collect();
    assert_eq!(files, ["mods/a.jar", "mods/b.jar", "mods/d.jar"]);
    let x = written["overrides"].as_array().unwrap().iter().find(|record| record["relative"] == "config/x.toml").unwrap();
    assert_eq!(x["sha256"], hex256(X2));
    // One automatic backup (of version 1.0 as the user had it), nothing else left.
    let backups = fixture.backups();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert!(backups[0].ends_with(".zip"));
    assert_eq!(fixture.siblings(), ["test"], "no stage or previous directory is left");
    let downloads = fixture.data.join("pack-downloads");
    assert!(fs::read_dir(&downloads).map_or(true, |mut entries| entries.next().is_none()), "the downloaded archive is removed");
    assert_eq!(api.count(), 4);
    assert!(
        written["overrides"].as_array().unwrap().iter().all(|record| !record["relative"].as_str().unwrap().starts_with("saves/")),
        "a skipped path is not recorded"
    );
    let Management::Managed(pack) = read_lock(&fixture.live) else { panic!("the new lock is managed") };
    assert_eq!((pack.version_id.as_str(), pack.version_number.as_str()), ("newver", "2.0"));

    // The next plan from this baseline: the kept edit is still the user's.
    let next = runtime.block_on(prepare(&fixture.state, "test", "v3", None)).unwrap().summary();
    assert_eq!(next.conflicts.len(), 1);
    assert_eq!((next.conflicts[0].path.as_str(), next.conflicts[0].reason), ("config/x.toml", planner::ConflictReason::UserModified));
    assert_eq!((next.add, next.replace, next.remove), (0, 0, 0));
    assert_eq!(api.count(), 6);
}

#[test]
fn c10_choosing_the_new_version_for_a_conflict_writes_it() {
    let scenario = Scenario::new();
    let mut replies = scenario.replies();
    replies.extend(scenario.replies());
    let api = RangeServer::new(replies);
    let _api = Api::at(&api);
    let runtime = runtime();
    let plan = scenario.plan(&runtime, None).unwrap();
    let choices = [ConflictChoice { path: "CONFIG/x.toml".into(), use_upstream: true }];
    scenario.apply(&runtime, &plan, &choices).unwrap();
    assert_eq!(scenario.read("config/x.toml"), X2);
}

#[test]
fn c10_an_update_refuses_a_plan_that_no_longer_holds_and_changes_nothing() {
    let scenario = Scenario::new();
    let fixture = &scenario.fixture;
    let mut replies = scenario.replies();
    for _ in 0..3 {
        replies.extend(scenario.replies());
    }
    let api = RangeServer::new(replies);
    let _api = Api::at(&api);
    let runtime = runtime();
    let plan = scenario.plan(&runtime, None).unwrap();
    let live = crate::instances::collect_files(&fixture.live).unwrap();

    // A choice for a path that is not a conflict.
    let error = scenario.apply(&runtime, &plan, &[ConflictChoice { path: "mods/a.jar".into(), use_upstream: true }]).err().unwrap();
    assert_eq!(error.code, "modpack.conflictChoiceInvalid");
    // The same conflict twice.
    let twice = [
        ConflictChoice { path: "config/x.toml".into(), use_upstream: false },
        ConflictChoice { path: "config/x.toml".into(), use_upstream: true },
    ];
    assert_eq!(scenario.apply(&runtime, &plan, &twice).err().unwrap().code, "modpack.conflictChoiceInvalid");
    // A planned file changed after the plan.
    fixture.write("mods/a.jar", b"changed after the plan");
    let error = scenario.apply(&runtime, &plan, &[]).err().unwrap();
    assert_eq!(error.code, "modpack.planChanged");
    let mut after_edit = live.clone();
    let edited = after_edit.iter_mut().find(|record| record.relative == "mods/a.jar").unwrap();
    edited.size = b"changed after the plan".len() as u64;
    edited.sha256 = hex256(b"changed after the plan");
    assert_eq!(crate::instances::collect_files(&fixture.live).unwrap(), after_edit, "nothing else changed");
    assert!(fixture.backups().is_empty(), "no backup was made");
    assert_eq!(fixture.siblings(), ["test"]);
}

#[test]
fn c10_a_plan_is_refused_for_an_unmanaged_instance_a_foreign_or_older_version_and_a_drifted_loader() {
    let runtime = runtime();
    // Unmanaged: refused before any request.
    let fixture = Fixture::new();
    let api = RangeServer::new(Vec::new());
    let _api = Api::at(&api);
    let error = runtime.block_on(prepare(&fixture.state, "test", "newver", None)).err().unwrap();
    assert_eq!(error, UNMANAGED);
    assert_eq!(api.count(), 0);
    drop(_api);

    // A version of another project, and an older version.
    let scenario = Scenario::new();
    let mut foreign: Value = serde_json::from_slice(&scenario.replies()[0].body).unwrap();
    foreign["project_id"] = json!("another");
    let api = RangeServer::new(vec![
        json_reply(foreign),
        version_reply("newver", "0.5", "2025-01-01T00:00:00Z", &scenario.archive),
        version_reply("oldver", "1.0", "2026-01-01T00:00:00Z", &scenario.archive),
    ]);
    let _api = Api::at(&api);
    assert_eq!(scenario.plan(&runtime, None).err().unwrap(), VERSION_MISMATCH);
    assert_eq!(scenario.plan(&runtime, None).err().unwrap(), NOT_NEWER);
    drop(_api);

    // The instance no longer follows the lock's Minecraft version.
    let mut drifted: Value = serde_json::from_slice(&fs::read(scenario.fixture.live.join(LOCK)).unwrap()).unwrap();
    drifted["dependencies"] = json!({"minecraft": "1.21.1"});
    fs::write(scenario.fixture.live.join(LOCK), drifted.to_string()).unwrap();
    let api = RangeServer::new(Vec::new());
    let _api = Api::at(&api);
    assert_eq!(scenario.plan(&runtime, None).err().unwrap(), DEPENDENCY_DRIFT);
    assert_eq!(api.count(), 0);
}

#[test]
fn c10_the_check_reports_an_unmanaged_instance_without_asking_modrinth_and_lists_newer_versions() {
    let runtime = runtime();
    let fixture = Fixture::new();
    fs::write(fixture.live.join(LOCK), br#"{"formatVersion":1,"name":"Old","dependencies":{"minecraft":"1.20.1"}}"#).unwrap();
    let api = RangeServer::new(Vec::new());
    let _api = Api::at(&api);
    let result = runtime.block_on(check(&fixture.state, "test")).unwrap();
    assert!(!result.managed);
    assert_eq!(result.reason, Some("legacyLock"));
    assert!(result.current.is_none() && result.newer.is_empty() && !result.include_optional);
    assert_eq!(api.count(), 0);
    drop(_api);

    // A managed pack installed with optional files: the versions after it.
    let mut managed = lock(&[("mods/a.jar", b"a")], &[]);
    managed["includeOptional"] = json!(true);
    fs::write(fixture.live.join(LOCK), managed.to_string()).unwrap();
    let archive = mrpack("v", &[], &[]);
    let body = |reply: Scripted| -> Value { serde_json::from_slice(&reply.body).unwrap() };
    let versions = json!([
        body(version_reply("oldver", "1.0", "2026-01-01T00:00:00Z", &archive)),
        body(version_reply("newver", "2.0", "2026-02-01T00:00:00Z", &archive)),
        body(version_reply("older", "0.9", "2025-12-01T00:00:00Z", &archive)),
    ]);
    let api = RangeServer::new(vec![
        json_reply(json!({"id": "fixturepack", "title": "Fixture Pack", "project_type": "modpack"})),
        json_reply(versions),
    ]);
    let _api = Api::at(&api);
    let result = runtime.block_on(check(&fixture.state, "test")).unwrap();
    assert!(result.managed && result.reason.is_none());
    assert!(result.include_optional, "the lock's optional choice");
    assert!(!result.current_missing);
    let current = result.current.unwrap();
    assert_eq!((current.version_id.as_str(), current.version_number.as_str()), ("oldver", "1.0"));
    assert_eq!(result.newer.iter().map(|version| version.id.as_str()).collect::<Vec<_>>(), ["newver"]);
    assert_eq!(api.count(), 2);
}

#[test]
fn c10_an_installed_version_modrinth_no_longer_has_allows_any_version_but_a_failed_lookup_stops_the_plan() {
    let scenario = Scenario::new();
    let runtime = runtime();
    let older = version_reply("newver", "0.5", "2025-01-01T00:00:00Z", &scenario.archive);
    let mut foreign: Value = serde_json::from_slice(&scenario.replies()[1].body).unwrap();
    foreign["project_id"] = json!("another");
    let api = RangeServer::new(vec![
        scenario.replies().remove(0),
        Scripted::status(404),
        older,
        Scripted::status(410),
        scenario.replies().remove(0),
        Scripted::status(503),
        scenario.replies().remove(0),
        json_reply(foreign),
    ]);
    let _api = Api::at(&api);
    assert!(scenario.plan(&runtime, None).is_ok(), "an installed version that is gone: the plan is made");
    assert!(scenario.plan(&runtime, None).is_ok(), "and an older version is not refused (the check says so)");
    let error = scenario.plan(&runtime, None).err().unwrap();
    assert_eq!(crate::errors::expected(error).code, "modpack.platformUnavailable", "any other failure stops the plan");
    assert_eq!(scenario.plan(&runtime, None).err().unwrap(), VERSION_MISMATCH, "an installed version of another project");
    assert_eq!(api.count(), 8);
}

#[test]
fn c10_a_change_made_after_the_plan_was_checked_is_not_overwritten() {
    for (point, path) in [("stage", "mods/a.jar"), ("commit", "mods/user.jar")] {
        let scenario = Scenario::new();
        let fixture = &scenario.fixture;
        let mut replies = scenario.replies();
        replies.extend(scenario.replies());
        let api = RangeServer::new(replies);
        let _api = Api::at(&api);
        let runtime = runtime();
        let plan = scenario.plan(&runtime, None).unwrap();
        let live = fixture.live.clone();
        hook(&fixture.live, point, move || fs::write(live.join(path), b"edited while the update ran").unwrap());
        let error = scenario.apply(&runtime, &plan, &[]).err().unwrap();
        assert_eq!(error.code, "modpack.planChanged", "{point}: {error:?}");
        assert_eq!(scenario.read(path), b"edited while the update ran", "{point}");
        if point == "commit" {
            assert_eq!(scenario.read("mods/a.jar"), A1, "{point}: the planned change was not swapped in");
        }
        assert_eq!(fixture.siblings(), ["test"], "{point}: no copy is left");
        let folder = fixture.data.join("instance-backups/test");
        assert!(!folder.join("restore-in-progress.json").exists(), "{point}: no intent");
    }
}

#[test]
fn c10_every_kind_of_step_and_optional_files_are_applied() {
    const E1: &[u8] = b"mod e, disabled, dropped in two";
    const F1: &[u8] = b"mod f, a download in one";
    const F2: &[u8] = b"mod f, an override in two";
    const G1: &[u8] = b"mod g version one";
    const G2: &[u8] = b"mod g version two";
    const OPT: &[u8] = b"an optional mod";
    let fixture = Fixture::new();
    fixture.write("mods/e.jar.disabled", E1);
    fixture.write("mods/f.jar", F1);
    // The user deleted mods/g.jar.
    let installed = lock(&[("mods/e.jar", E1), ("mods/f.jar", F1), ("mods/g.jar", G1)], &[]);
    fs::write(fixture.live.join(LOCK), installed.to_string()).unwrap();
    let mut optional = index_file("mods/opt.jar", OPT);
    optional["env"] = json!({"client": "optional", "server": "optional"});
    let archive = mrpack_from(
        "2.0",
        vec![index_file("mods/g.jar", G2), optional],
        &[("overrides/mods/f.jar", F2)],
        json!({"minecraft": "1.20.1"}),
    );
    for bytes in [G2, OPT, archive.as_slice()] {
        fixture.cache(bytes);
    }
    let replies = || {
        vec![
            version_reply("newver", "2.0", "2026-02-01T00:00:00Z", &archive),
            version_reply("oldver", "1.0", "2026-01-01T00:00:00Z", &archive),
        ]
    };
    let mut script = replies();
    script.extend(replies());
    let api = RangeServer::new(script);
    let _api = Api::at(&api);
    let runtime = runtime();
    let plan = runtime.block_on(prepare(&fixture.state, "test", "newver", Some(true))).unwrap().summary();
    assert!(plan.include_optional);
    assert_eq!((plan.add, plan.replace, plan.remove), (1, 1, 1), "opt added; f replaced; the disabled e removed");
    assert_eq!(plan.dropped_intents, ["mods/e.jar"]);
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!((plan.conflicts[0].path.as_str(), plan.conflicts[0].reason), ("mods/g.jar", planner::ConflictReason::UserDeleted));
    let choices = [ConflictChoice { path: "mods/g.jar".into(), use_upstream: true }];
    runtime
        .block_on(apply_inner(None, &fixture.state, "test", "newver", plan.include_optional, &plan.fingerprint, &choices))
        .unwrap();
    let read = |relative: &str| fs::read(fixture.live.join(relative)).unwrap();
    assert!(!fixture.live.join("mods/e.jar.disabled").exists() && !fixture.live.join("mods/e.jar").exists());
    assert_eq!(read("mods/f.jar"), F2, "a download that became an override");
    assert_eq!(read("mods/g.jar"), G2, "the deleted file, restored by choice");
    assert_eq!(read("mods/opt.jar"), OPT, "the optional file");
    let written: Value = serde_json::from_slice(&read(LOCK)).unwrap();
    assert_eq!(written["includeOptional"], true);
    let Management::Managed(pack) = read_lock(&fixture.live) else { panic!("the new lock is managed") };
    assert!(pack.include_optional);
    assert_eq!(pack.baseline.len(), 3, "g and opt downloads, f override");
}

#[test]
fn c10_a_new_loader_is_planned_and_an_update_that_cannot_install_it_changes_nothing() {
    let fixture = Fixture::new();
    fixture.write("mods/a.jar", A1);
    fs::write(fixture.live.join(LOCK), lock(&[("mods/a.jar", A1)], &[]).to_string()).unwrap();
    let archive = mrpack_from(
        "2.0",
        vec![index_file("mods/a.jar", A2)],
        &[],
        json!({"minecraft": "1.20.1", "fabric-loader": "0.16.0"}),
    );
    for bytes in [A2, archive.as_slice()] {
        fixture.cache(bytes);
    }
    let replies = || {
        vec![
            version_reply("newver", "2.0", "2026-02-01T00:00:00Z", &archive),
            version_reply("oldver", "1.0", "2026-01-01T00:00:00Z", &archive),
        ]
    };
    let mut script = replies();
    script.extend(replies());
    let api = RangeServer::new(script);
    let _api = Api::at(&api);
    let runtime = runtime();
    let before = crate::instances::collect_files(&fixture.live).unwrap();
    let plan = runtime.block_on(prepare(&fixture.state, "test", "newver", None)).unwrap().summary();
    let change = plan.dependency_change.as_ref().expect("the loader change is planned");
    assert_eq!(change.from, BTreeMap::from([("minecraft".to_owned(), "1.20.1".to_owned())]));
    assert_eq!(change.to.get("fabric-loader").map(String::as_str), Some("0.16.0"));
    // Without a window the loader cannot be installed: the update stops before the swap.
    let error = runtime
        .block_on(apply_inner(None, &fixture.state, "test", "newver", plan.include_optional, &plan.fingerprint, &[]))
        .err()
        .unwrap();
    assert!(error.detail.as_deref().is_some_and(|detail| detail.contains("安装新加载器")), "{error:?}");
    assert_eq!(crate::instances::collect_files(&fixture.live).unwrap(), before, "nothing changed");
    assert_eq!(fixture.siblings(), ["test"]);
    let registered = crate::instances::instance(&fixture.state.snapshot().unwrap(), "test").unwrap();
    assert_eq!((registered.version_id.as_str(), registered.loader.as_str()), ("1.20.1", ""));
}

#[test]
fn c10_the_copy_must_hold_what_the_plan_saw() {
    let file = |bytes: &[u8]| OnDisk { sha1: hex1(bytes), sha512: hex512(bytes), sha256: hex256(bytes), size: bytes.len() as u64 };
    let folder = OnDisk { sha1: String::new(), sha512: String::new(), sha256: String::new(), size: u64::MAX };
    let record = |relative: &str, bytes: &[u8]| FileRecord { relative: relative.into(), size: bytes.len() as u64, sha256: hex256(bytes) };
    let seen = |enabled: Option<OnDisk>, disabled: Option<OnDisk>| BTreeMap::from([("mods/a.jar".to_owned(), DiskPath { enabled, disabled })]);
    assert!(require_copy_matches(&seen(None, None), &[]).is_ok());
    assert!(require_copy_matches(&seen(Some(file(b"one")), None), &[record("Mods/A.jar", b"one")]).is_ok(), "names without case");
    assert!(require_copy_matches(&seen(None, Some(file(b"one"))), &[record("mods/a.jar.disabled", b"one")]).is_ok());
    assert!(require_copy_matches(&seen(Some(folder.clone()), None), &[record("mods/a.jar/inner", b"x")]).is_ok(), "a folder is not a file");
    for (label, disk, copied) in [
        ("changed bytes", seen(Some(file(b"one")), None), vec![record("mods/a.jar", b"two")]),
        ("removed", seen(Some(file(b"one")), None), vec![]),
        ("added", seen(None, None), vec![record("mods/a.jar", b"new")]),
        ("disabled since", seen(Some(file(b"one")), None), vec![record("mods/a.jar.disabled", b"one")]),
        ("a folder became a file", seen(Some(folder), None), vec![record("mods/a.jar", b"x")]),
    ] {
        assert_eq!(require_copy_matches(&disk, &copied).err().as_deref(), Some(PLAN_CHANGED), "{label}");
    }
}

#[test]
fn c10_the_update_runs_its_guards_before_it_writes() {
    let source = crate::storage::executable_source(include_str!("pack_update.rs"));
    let flat: String = source.split_whitespace().collect::<Vec<_>>().join(" ");
    let body = |marker: &str| -> String {
        let (_, rest) = flat.split_once(marker).unwrap_or_else(|| panic!("{marker}"));
        rest.split_once(" fn ").map_or(rest, |(body, _)| body).to_owned()
    };
    let command = body("pub async fn apply_modpack_update(");
    let lock = command.find("let _operation = state.operation.lock().await;").unwrap();
    let task = command.find("state.control.begin_with_display(\"modpack-update\"").unwrap();
    let inner = command.find("apply_inner(").unwrap();
    assert!(lock < task && task < inner);
    let apply = body("async fn apply_inner(");
    let order = [
        "instances::pack_update_target(state, &current)?",
        "require_no_resource_transaction(&live)?",
        "prepare(state, instance_id, new_version_id, Some(include_optional)).await?",
        "if prepared.fingerprint != fingerprint",
        "chosen_steps(&prepared.plan, choices)?",
        "require_downloadable(&prepared, &steps)?",
        "at(&live, \"stage\")",
        "instances::stage_pack_update(",
        "require_copy_matches(&prepared.disk, &stage.files)?",
        "fs::remove_file(&target)",
        "write_update_lock(stage.path(), &prepared)?",
        "instances::commit_pack_update(",
    ];
    let positions: Vec<_> = order.iter().map(|marker| apply.find(marker).unwrap_or_else(|| panic!("{marker}"))).collect();
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{order:?} at {positions:?}");
    // A plan is a task of its own, under the operation lock.
    let plan = body("pub async fn plan_modpack_update(");
    let lock = plan.find("let _operation = state.operation.lock().await;").unwrap();
    let task = plan.find("state.control.begin_with_display(\"modpack-update-plan\"").unwrap();
    let prepare = plan.find("prepare(state.inner()").unwrap();
    let finish = plan.find("state.control.finish(&task").unwrap();
    assert!(lock < task && task < prepare && prepare < finish);
}

#[test]
fn c10_an_update_waits_for_an_interrupted_content_change() {
    let scenario = Scenario::new();
    let fixture = &scenario.fixture;
    let api = RangeServer::new(scenario.replies());
    let _api = Api::at(&api);
    let runtime = runtime();
    let plan = scenario.plan(&runtime, None).unwrap();
    // A mods change stopped between parking the old folder and publishing
    // the new one: mods is missing, its journal can still recover it.
    let id = uuid::Uuid::new_v4().to_string();
    let transaction = fixture.live.join(".launcher-resource-history/mods").join(&id);
    fs::create_dir_all(&transaction).unwrap();
    fs::rename(fixture.live.join("mods"), transaction.join("before")).unwrap();
    let journal = json!({
        "id": id,
        "name": "Mods",
        "createdAt": "2026-11-22T00:00:00Z",
        "status": "committing",
        "directory": fixture.live.join("mods").to_string_lossy(),
        "projects": [],
        "beforeExists": true,
        "before": crate::instances::collect_files(&transaction.join("before")).unwrap(),
        "after": [],
    });
    fs::write(transaction.join("journal.json"), journal.to_string()).unwrap();
    let before = crate::instances::collect_files(&fixture.live).unwrap();
    assert_eq!(scenario.plan(&runtime, None).err().unwrap(), crate::errors::RESOURCE_RECOVERY_REQUIRED, "no plan");
    let error = scenario.apply(&runtime, &plan, &[]).err().unwrap();
    assert_eq!(error.code, "resource.recoveryRequired", "{error:?}");
    assert_eq!(api.count(), 2, "neither asks Modrinth again");
    assert!(fixture.backups().is_empty(), "no backup was made");
    assert_eq!(fixture.siblings(), ["test"]);
    assert_eq!(crate::instances::collect_files(&fixture.live).unwrap(), before, "nothing changed");
}

#[test]
fn c10_optional_files_a_plan_would_remove_are_named() {
    const OPT: &[u8] = b"an optional mod the user installed";
    let fixture = Fixture::new();
    fixture.write("mods/a.jar", A1);
    fixture.write("mods/opt.jar", OPT);
    // A lock written before the optional choice was recorded.
    fs::write(fixture.live.join(LOCK), lock(&[("mods/a.jar", A1), ("mods/opt.jar", OPT)], &[]).to_string()).unwrap();
    let mut optional = index_file("mods/opt.jar", OPT);
    optional["env"] = json!({"client": "optional", "server": "optional"});
    let archive = mrpack_from("2.0", vec![index_file("mods/a.jar", A2), optional], &[], json!({"minecraft": "1.20.1"}));
    for bytes in [A2, archive.as_slice()] {
        fixture.cache(bytes);
    }
    let replies = || {
        vec![
            version_reply("newver", "2.0", "2026-02-01T00:00:00Z", &archive),
            version_reply("oldver", "1.0", "2026-01-01T00:00:00Z", &archive),
        ]
    };
    let mut script = replies();
    script.extend(replies());
    let api = RangeServer::new(script);
    let _api = Api::at(&api);
    let runtime = runtime();
    let plan = runtime.block_on(prepare(&fixture.state, "test", "newver", None)).unwrap().summary();
    assert!(!plan.include_optional, "an unrecorded choice reads as not included");
    assert_eq!(plan.optional_removed, ["mods/opt.jar"]);
    assert_eq!(plan.remove, 1);
    let plan = runtime.block_on(prepare(&fixture.state, "test", "newver", Some(true))).unwrap().summary();
    assert!(plan.optional_removed.is_empty());
    assert_eq!((plan.remove, plan.unchanged), (0, 1), "included, the optional file stays");
}

#[test]
fn c10_a_version_with_a_file_no_lock_can_hold_is_not_planned() {
    let fixture = Fixture::new();
    fixture.write("config/empty.txt", b"");
    fs::write(fixture.live.join(LOCK), lock(&[], &[("config/empty.txt", b"")]).to_string()).unwrap();
    let archive = mrpack_from("2.0", vec![index_file("config/empty.txt", b"")], &[], json!({"minecraft": "1.20.1"}));
    fixture.cache(&archive);
    let api = RangeServer::new(vec![
        version_reply("newver", "2.0", "2026-02-01T00:00:00Z", &archive),
        version_reply("oldver", "1.0", "2026-01-01T00:00:00Z", &archive),
    ]);
    let _api = Api::at(&api);
    let runtime = runtime();
    let error = runtime.block_on(prepare(&fixture.state, "test", "newver", None)).err().unwrap();
    assert!(error.contains("大小无效"), "{error}");
}

#[test]
fn c10_a_managed_name_too_long_for_a_disabled_copy_is_still_planned() {
    let long = format!("mods/{}.jar", "a".repeat(151));
    let fixture = Fixture::new();
    fixture.write(&long, b"a long name");
    fs::write(fixture.live.join(LOCK), lock(&[], &[(long.as_str(), b"a long name")]).to_string()).unwrap();
    let entry = format!("overrides/{long}");
    let archive = mrpack_from("2.0", Vec::new(), &[(entry.as_str(), b"a long name")], json!({"minecraft": "1.20.1"}));
    fixture.cache(&archive);
    let api = RangeServer::new(vec![
        version_reply("newver", "2.0", "2026-02-01T00:00:00Z", &archive),
        version_reply("oldver", "1.0", "2026-01-01T00:00:00Z", &archive),
    ]);
    let _api = Api::at(&api);
    let runtime = runtime();
    let plan = runtime.block_on(prepare(&fixture.state, "test", "newver", None)).unwrap().summary();
    assert_eq!(plan.unchanged, 1);
}

// ---- C12: a managed CurseForge modpack ------------------------------------

/// Points the CurseForge API at `server` for this thread.
struct CfApi;

impl CfApi {
    fn at(fixture: &Fixture, server: &RangeServer) -> Self {
        // A synthetic key of the right shape, assembled here.
        let key = ["$", "2a", "$", "10", "$"].join("") + &"b".repeat(53);
        crate::secrets::save_service_secret(&fixture.data, "curseforge-api-key", &key).unwrap();
        crate::resources::TEST_ENDPOINTS.with(|endpoints| {
            *endpoints.borrow_mut() = Some(crate::resources::TestEndpoints {
                modrinth_api: String::new(),
                curseforge_api: format!("http://{}", server.address),
                cdn: "127.0.0.1:1".parse().unwrap(),
                prepared_version: None,
            })
        });
        CfApi
    }
}

impl Drop for CfApi {
    fn drop(&mut self) {
        crate::resources::TEST_ENDPOINTS.with(|endpoints| *endpoints.borrow_mut() = None);
    }
}

const PACK: u64 = 100;
const INSTALLED: u64 = 1000;
const NEW: u64 = 2000;

impl Fixture {
    /// Verified bytes where `fetch_verified` finds a SHA-1-only download.
    fn cache_sha1(&self, bytes: &[u8]) {
        let cache = self.data.join("pack-cache");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join(format!("{}.bin", hex1(bytes))), bytes).unwrap();
    }
}

fn cf_file(project: u64, id: u64, name: &str, bytes: &[u8], date: &str, release_type: u32) -> Value {
    json!({
        "id": id, "modId": project, "gameId": 432, "isAvailable": true,
        "fileName": name, "fileLength": bytes.len(),
        "downloadUrl": format!("https://edge.forgecdn.net/files/{id}/{name}"),
        "hashes": [{"algo": 1, "value": hex1(bytes)}],
        "gameVersions": ["1.20.1"], "dependencies": [],
        "fileDate": date, "releaseType": release_type, "displayName": format!("Pack {id}"),
    })
}

fn cf_project(id: u64, class_id: u64, distributable: bool) -> Value {
    json!({
        "id": id, "gameId": 432, "name": format!("Project {id}"), "slug": format!("project-{id}"),
        "summary": "", "classId": class_id, "allowModDistribution": distributable,
        "links": {"websiteUrl": format!("https://www.curseforge.com/minecraft/mc-mods/project-{id}")},
    })
}

fn cf_reply(value: Value) -> Scripted {
    json_reply(json!({ "data": value }))
}

/// A CurseForge pack ZIP: manifest entries (projectID, fileID, required) and override files.
fn cf_pack(entries: &[(u64, u64, bool)], overrides: &[(&str, &[u8])]) -> Vec<u8> {
    let manifest = json!({
        "manifestType": "minecraftModpack", "manifestVersion": 1, "name": "Fixture CF Pack",
        "minecraft": {"version": "1.20.1", "modLoaders": []},
        "files": entries.iter().map(|(project, file, required)| json!({"projectID": project, "fileID": file, "required": required})).collect::<Vec<_>>(),
        "overrides": "overrides",
    });
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("manifest.json", SimpleFileOptions::default()).unwrap();
    zip.write_all(manifest.to_string().as_bytes()).unwrap();
    for (name, bytes) in overrides {
        zip.start_file(format!("overrides/{name}"), SimpleFileOptions::default()).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// The lock an online CurseForge install of the installed version wrote.
fn cf_lock(files: &[(&str, &[u8], u64, u64)], overrides: &[(&str, &[u8])]) -> Value {
    json!({
        "formatVersion": 2,
        "name": "Fixture CF Pack",
        "dependencies": {"minecraft": "1.20.1"},
        "files": files.iter().map(|(path, bytes, project, file)| json!({"path": path, "sha1": hex1(bytes), "sha512": hex512(bytes), "size": bytes.len(), "projectId": project, "fileId": file})).collect::<Vec<_>>(),
        "overrides": overrides.iter().map(|(path, bytes)| json!({"relative": path, "size": bytes.len(), "sha256": hex256(bytes)})).collect::<Vec<_>>(),
        "source": {"kind": "curseforge", "projectId": PACK, "fileId": INSTALLED, "versionNumber": "Pack 1000"},
    })
}

const OPT: &[u8] = b"an optional mod, installed before";

/// Version 1000 installed (a, b disabled, c, opt; config/x.toml edited by
/// the user), version 2000 on a local CurseForge API.
struct CfScenario {
    fixture: Fixture,
    pack: Vec<u8>,
}

impl CfScenario {
    fn new() -> Self {
        let fixture = Fixture::new();
        fixture.write("mods/a.jar", A1);
        fixture.write("mods/b.jar.disabled", B1);
        fixture.write("mods/c.jar", C1);
        fixture.write("mods/opt.jar", OPT);
        fixture.write("config/x.toml", MINE);
        fixture.write("saves/world/level.dat", b"the user's world");
        let installed = cf_lock(
            &[("mods/a.jar", A1, 11, 111), ("mods/b.jar", B1, 12, 121), ("mods/c.jar", C1, 13, 131), ("mods/opt.jar", OPT, 15, 151)],
            &[("config/x.toml", X1)],
        );
        fs::write(fixture.live.join(LOCK), installed.to_string()).unwrap();
        let pack = cf_pack(&[(11, 112, true), (12, 122, true), (14, 141, true), (15, 151, false)], &[("config/x.toml", X2)]);
        for bytes in [A2, B2, D1, pack.as_slice()] {
            fixture.cache_sha1(bytes);
        }
        Self { fixture, pack }
    }

    /// The five answers of one plan, with these projects' files restricted;
    /// the apply's plan reuses them from the cache.
    fn replies(&self, restricted: &[u64]) -> Vec<Scripted> {
        let free = |project: u64| !restricted.contains(&project);
        vec![
            cf_reply(cf_project(PACK, 4471, true)),
            cf_reply(cf_file(PACK, NEW, "pack-2000.zip", &self.pack, "2026-02-01T00:00:00Z", 1)),
            cf_reply(cf_file(PACK, INSTALLED, "pack-1000.zip", b"the installed pack", "2026-01-01T00:00:00Z", 1)),
            cf_reply(json!([
                cf_file(11, 112, "a.jar", A2, "2026-02-01T00:00:00Z", 1),
                cf_file(12, 122, "b.jar", B2, "2026-02-01T00:00:00Z", 1),
                cf_file(14, 141, "d.jar", D1, "2026-02-01T00:00:00Z", 1),
                cf_file(15, 151, "opt.jar", OPT, "2026-01-01T00:00:00Z", 1),
            ])),
            cf_reply(json!([cf_project(11, 6, free(11)), cf_project(12, 6, free(12)), cf_project(14, 6, free(14)), cf_project(15, 6, free(15))])),
        ]
    }

    fn plan(&self, runtime: &tokio::runtime::Runtime) -> Result<PackUpdatePlan, String> {
        runtime.block_on(prepare(&self.fixture.state, "test", &NEW.to_string(), None)).map(|prepared| prepared.summary())
    }

    fn apply(&self, runtime: &tokio::runtime::Runtime, plan: &PackUpdatePlan, choices: &[ConflictChoice]) -> crate::errors::AppResult<PackUpdateResult> {
        runtime.block_on(apply_inner(None, &self.fixture.state, "test", &NEW.to_string(), plan.include_optional, &plan.fingerprint, choices))
    }

    fn read(&self, relative: &str) -> Vec<u8> {
        fs::read(self.fixture.live.join(relative)).unwrap()
    }
}

#[test]
fn c12_a_curseforge_lock_is_managed_with_its_file_ids() {
    let fixture = Fixture::new();
    let reason = |value: &Value| {
        fs::write(fixture.live.join(LOCK), value.to_string()).unwrap();
        match read_lock(&fixture.live) {
            Management::Unmanaged(reason) => reason,
            Management::Managed(_) => "managed",
        }
    };
    let valid = cf_lock(&[("mods/a.jar", A1, 11, 111)], &[("config/x.toml", X1)]);
    assert_eq!(reason(&valid), "managed");
    let Management::Managed(pack) = read_lock(&fixture.live) else { unreachable!() };
    assert_eq!((pack.project_id.as_str(), pack.version_id.as_str(), pack.version_number.as_str()), ("100", "1000", "Pack 1000"));
    assert!(matches!(pack.baseline.get("mods/a.jar"), Some((_, Provided::Sha1Download { .. }))));
    let mut no_sha512 = valid.clone();
    no_sha512["files"][0].as_object_mut().unwrap().remove("sha512");
    assert_eq!(reason(&no_sha512), "managed", "a CurseForge file needs no SHA-512");
    for (label, field) in [("no fileId", "fileId"), ("no projectId", "projectId"), ("no sha1", "sha1")] {
        let mut broken = valid.clone();
        broken["files"][0].as_object_mut().unwrap().remove(field);
        assert_eq!(reason(&broken), "invalidLock", "{label}");
    }
    let mut zero = valid.clone();
    zero["source"]["fileId"] = json!(0);
    assert_eq!(reason(&zero), "invalidLock", "an id out of range");
    // A Modrinth lock still needs its SHA-512.
    let mut modrinth = lock(&[("mods/a.jar", A1)], &[]);
    modrinth["files"][0].as_object_mut().unwrap().remove("sha512");
    assert_eq!(reason(&modrinth), "invalidLock");
}

#[test]
fn c12_a_curseforge_update_keeps_user_changes_and_records_ids() {
    let scenario = CfScenario::new();
    let fixture = &scenario.fixture;
    let api = RangeServer::new(scenario.replies(&[]));
    let _api = CfApi::at(fixture, &api);
    let runtime = runtime();
    let plan = scenario.plan(&runtime).unwrap();
    assert_eq!((plan.from.version_id.as_str(), plan.to.version_id.as_str(), plan.to.version_number.as_str()), ("1000", "2000", "Pack 2000"));
    assert_eq!((plan.add, plan.replace, plan.remove), (1, 2, 2), "d added; a and b (disabled) replaced; c and opt removed");
    assert_eq!(plan.optional_removed, ["mods/opt.jar"], "an optional file the new version leaves out");
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!((plan.conflicts[0].path.as_str(), plan.conflicts[0].reason), ("config/x.toml", planner::ConflictReason::UserModified));
    assert!(plan.manual.is_empty());
    assert_eq!(plan.download_bytes, (A2.len() + B2.len() + D1.len()) as u64);
    assert_eq!(api.count(), 5);
    assert_eq!(api.header(3, ":path").as_deref(), Some("/mods/files"));
    assert!(api.header(0, "x-api-key").is_some_and(|key| !key.is_empty()), "the saved key is sent");

    scenario.apply(&runtime, &plan, &[]).unwrap();
    assert_eq!(api.count(), 5, "the apply's plan is answered from the cache");
    assert_eq!(scenario.read("mods/a.jar"), A2);
    assert_eq!(scenario.read("mods/b.jar.disabled"), B2, "a disabled mod stays disabled");
    assert_eq!(scenario.read("mods/d.jar"), D1);
    assert!(!fixture.live.join("mods/c.jar").exists() && !fixture.live.join("mods/opt.jar").exists());
    assert_eq!(scenario.read("config/x.toml"), MINE, "the user's edit is kept");
    assert_eq!(scenario.read("saves/world/level.dat"), b"the user's world");
    let written: Value = serde_json::from_slice(&scenario.read(LOCK)).unwrap();
    assert_eq!(written["source"], json!({"kind": "curseforge", "projectId": PACK, "fileId": NEW, "versionNumber": "Pack 2000"}));
    let files = written["files"].as_array().unwrap();
    assert_eq!(files.iter().map(|file| file["path"].as_str().unwrap()).collect::<Vec<_>>(), ["mods/a.jar", "mods/b.jar", "mods/d.jar"]);
    let a = &files[0];
    assert_eq!((a["projectId"].clone(), a["fileId"].clone(), a["sha1"].clone()), (json!(11), json!(112), json!(hex1(A2))));
    assert!(a.get("sha512").is_none(), "CurseForge gives no SHA-512");
    let x = written["overrides"].as_array().unwrap().iter().find(|record| record["relative"] == "config/x.toml").unwrap();
    assert_eq!(x["sha256"], hex256(X2), "the new baseline is what the new version provides");
    let Management::Managed(pack) = read_lock(&fixture.live) else { panic!("the new lock is managed") };
    assert_eq!(pack.version_id, "2000");
    assert_eq!(fixture.siblings(), ["test"]);
}

#[test]
fn c12_a_file_the_launcher_may_not_download_blocks_only_the_steps_that_write_it() {
    let scenario = CfScenario::new();
    let fixture = &scenario.fixture;
    let api = RangeServer::new(scenario.replies(&[14]));
    let _api = CfApi::at(fixture, &api);
    let runtime = runtime();
    let plan = scenario.plan(&runtime).unwrap();
    assert_eq!(
        plan.manual,
        [ManualDownload {
            path: "mods/d.jar".into(),
            target: "mods/d.jar".into(),
            project_url: "https://www.curseforge.com/minecraft/mc-mods/project-14".into(),
            conflict: false
        }]
    );
    let before = crate::instances::collect_files(&fixture.live).unwrap();
    let error = scenario.apply(&runtime, &plan, &[]).err().unwrap();
    assert_eq!(error.code, "modpack.manualDownloadRequired", "{error:?}");
    assert_eq!(crate::instances::collect_files(&fixture.live).unwrap(), before, "nothing changed");
    assert!(fixture.backups().is_empty(), "refused before the backup");
    // The user puts the file in place: the next plan finds it unchanged.
    fixture.write("mods/d.jar", D1);
    let plan = scenario.plan(&runtime).unwrap();
    assert!(plan.manual.is_empty());
    assert_eq!(plan.add, 0);
    scenario.apply(&runtime, &plan, &[]).unwrap();
    assert_eq!(scenario.read("mods/a.jar"), A2);
    assert_eq!(scenario.read("mods/d.jar"), D1);
    assert_eq!(api.count(), 5, "every plan after the first is answered from the cache");
}

#[test]
fn c12_a_restricted_file_is_named_where_the_update_writes_it() {
    // b is disabled, so its new version goes to b.jar.disabled; opt (also
    // restricted) is optional and left out, so it blocks nothing.
    let scenario = CfScenario::new();
    let fixture = &scenario.fixture;
    let api = RangeServer::new(scenario.replies(&[12, 15]));
    let _api = CfApi::at(fixture, &api);
    let runtime = runtime();
    let plan = scenario.plan(&runtime).unwrap();
    assert_eq!(plan.optional_removed, ["mods/opt.jar"]);
    assert_eq!(
        plan.manual,
        [ManualDownload {
            path: "mods/b.jar".into(),
            target: "mods/b.jar.disabled".into(),
            project_url: "https://www.curseforge.com/minecraft/mc-mods/project-12".into(),
            conflict: false
        }]
    );
    assert_eq!(scenario.apply(&runtime, &plan, &[]).err().unwrap().code, "modpack.manualDownloadRequired");
    assert_eq!(scenario.read("mods/b.jar.disabled"), B1, "nothing changed");
    // The user puts the new b where the list says.
    fixture.write("mods/b.jar.disabled", B2);
    let plan = scenario.plan(&runtime).unwrap();
    assert!(plan.manual.is_empty());
    scenario.apply(&runtime, &plan, &[]).unwrap();
    assert_eq!(scenario.read("mods/b.jar.disabled"), B2, "b stays disabled");
    assert!(!fixture.live.join("mods/b.jar").exists());
    assert!(!fixture.live.join("mods/opt.jar").exists());
    assert_eq!(scenario.read("mods/d.jar"), D1);
    assert_eq!(api.count(), 5);
}

#[test]
fn c12_a_restricted_new_version_of_a_conflict_blocks_only_when_chosen() {
    let scenario = CfScenario::new();
    let fixture = &scenario.fixture;
    fixture.write("mods/a.jar", b"the user's own build of a");
    let api = RangeServer::new(scenario.replies(&[11]));
    let _api = CfApi::at(fixture, &api);
    let runtime = runtime();
    let plan = scenario.plan(&runtime).unwrap();
    assert!(plan.conflicts.iter().any(|conflict| conflict.path == "mods/a.jar"), "the user's a conflicts with the new a");
    assert_eq!(
        plan.manual,
        [ManualDownload {
            path: "mods/a.jar".into(),
            target: "mods/a.jar".into(),
            project_url: "https://www.curseforge.com/minecraft/mc-mods/project-11".into(),
            conflict: true
        }]
    );
    let before = crate::instances::collect_files(&fixture.live).unwrap();
    let error = scenario
        .apply(&runtime, &plan, &[ConflictChoice { path: "mods/a.jar".into(), use_upstream: true }])
        .err()
        .unwrap();
    assert_eq!(error.code, "modpack.manualDownloadRequired", "{error:?}");
    assert_eq!(crate::instances::collect_files(&fixture.live).unwrap(), before, "nothing changed");
    assert!(fixture.backups().is_empty(), "refused before the backup");
    // Keeping the user's a needs nothing the launcher may not download.
    scenario.apply(&runtime, &plan, &[]).unwrap();
    assert_eq!(scenario.read("mods/a.jar"), b"the user's own build of a");
    assert_eq!(scenario.read("mods/d.jar"), D1);
}

#[test]
fn c12_a_curseforge_plan_refuses_the_installed_an_older_and_a_non_release_file() {
    let runtime = runtime();
    // The installed file itself: refused before any request.
    let scenario = CfScenario::new();
    let api = RangeServer::new(Vec::new());
    let _api = CfApi::at(&scenario.fixture, &api);
    let error = runtime.block_on(prepare(&scenario.fixture.state, "test", &INSTALLED.to_string(), None)).err().unwrap();
    assert_eq!(error, NOT_NEWER);
    assert_eq!(api.count(), 0);
    drop(_api);
    // An older file of the pack.
    let api = RangeServer::new(vec![
        cf_reply(cf_project(PACK, 4471, true)),
        cf_reply(cf_file(PACK, NEW, "pack-2000.zip", &scenario.pack, "2025-12-01T00:00:00Z", 1)),
        cf_reply(cf_file(PACK, INSTALLED, "pack-1000.zip", b"the installed pack", "2026-01-01T00:00:00Z", 1)),
    ]);
    let _api = CfApi::at(&scenario.fixture, &api);
    assert_eq!(scenario.plan(&runtime).err().unwrap(), NOT_NEWER);
    assert_eq!(api.count(), 3);
    drop(_api);
    // A beta.
    let api = RangeServer::new(vec![
        cf_reply(cf_project(PACK, 4471, true)),
        cf_reply(cf_file(PACK, NEW, "pack-2000.zip", &scenario.pack, "2026-02-01T00:00:00Z", 2)),
    ]);
    let _api = CfApi::at(&scenario.fixture, &api);
    let error = scenario.plan(&runtime).err().unwrap();
    assert_eq!(crate::errors::expected(error).code, "modpack.versionMismatch");
    drop(_api);
    // CurseForge no longer has the installed file: any release is allowed.
    let mut replies = scenario.replies(&[]);
    replies[2] = Scripted::status(404);
    let api = RangeServer::new(replies);
    let _api = CfApi::at(&scenario.fixture, &api);
    assert!(scenario.plan(&runtime).is_ok());
}

#[test]
fn c12_a_plan_names_the_curseforge_refusals_it_cannot_get_past() {
    let runtime = runtime();
    let scenario = CfScenario::new();
    // The installed file's lookup is refused: the platform's code, not a generic one.
    let mut replies = scenario.replies(&[]);
    replies.truncate(2);
    replies.push(Scripted::status(403));
    let api = RangeServer::new(replies);
    let _api = CfApi::at(&scenario.fixture, &api);
    let error = scenario.plan(&runtime).err().unwrap();
    assert_eq!(crate::errors::expected(error).code, "modpack.platformUnavailable");
    assert_eq!(api.count(), 3);
    drop(_api);
    // CurseForge may not let the launcher download the new pack itself: no
    // hand-download list, since a downloaded ZIP is no update.
    let scenario = CfScenario::new();
    let api = RangeServer::new(vec![cf_reply(cf_project(PACK, 4471, false)), cf_reply(cf_file(PACK, NEW, "pack-2000.zip", &scenario.pack, "2026-02-01T00:00:00Z", 1))]);
    let _api = CfApi::at(&scenario.fixture, &api);
    let before = crate::instances::collect_files(&scenario.fixture.live).unwrap();
    let error = scenario.plan(&runtime).err().unwrap();
    assert_eq!(error, PACK_NOT_DOWNLOADABLE);
    assert_eq!(crate::errors::expected(error).code, "modpack.packNotDownloadable");
    assert_eq!(api.count(), 2, "refused before any download");
    assert_eq!(crate::instances::collect_files(&scenario.fixture.live).unwrap(), before);
}

#[test]
fn c12_the_check_offers_newer_releases_of_a_curseforge_pack() {
    let scenario = CfScenario::new();
    let runtime = runtime();
    let page = json!([
        cf_file(PACK, 2001, "pack-2001.zip", b"beta", "2026-03-01T00:00:00Z", 2),
        cf_file(PACK, NEW, "pack-2000.zip", &scenario.pack, "2026-02-01T00:00:00Z", 1),
        cf_file(PACK, INSTALLED, "pack-1000.zip", b"the installed pack", "2026-01-01T00:00:00Z", 1),
    ]);
    let api = RangeServer::new(vec![cf_reply(cf_project(PACK, 4471, true)), cf_reply(page)]);
    let _api = CfApi::at(&scenario.fixture, &api);
    let result = runtime.block_on(check(&scenario.fixture.state, "test")).unwrap();
    assert!(result.managed);
    let current = result.current.unwrap();
    assert_eq!((current.version_id.as_str(), current.version_number.as_str()), ("1000", "Pack 1000"));
    assert_eq!(result.newer.iter().map(|version| version.id.as_str()).collect::<Vec<_>>(), ["2000"], "releases only");
    assert!(!result.current_missing);
}
