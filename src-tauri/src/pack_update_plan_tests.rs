use super::*;

type Files = BTreeMap<String, (String, Provided)>;

/// A download whose hashes and size differ per tag.
fn download(tag: &str) -> Provided {
    Provided::Download {
        sha1: format!("sha1-{tag}"),
        sha512: format!("sha512-{tag}"),
        size: 10 + tag.len() as u64,
    }
}

/// An override whose hash and size differ per tag.
fn over(tag: &str) -> Provided {
    Provided::Override {
        sha256: format!("sha256-{tag}"),
        size: 100 + tag.len() as u64,
    }
}

/// Disk hashes that match `provided`; the unused hashes are constants that no
/// builder produces.
fn on_disk_for(provided: &Provided) -> OnDisk {
    match provided {
        Provided::Download { sha1, sha512, size } => OnDisk {
            sha1: sha1.clone(),
            sha512: sha512.clone(),
            sha256: "unused".to_owned(),
            size: *size,
        },
        Provided::Override { sha256, size } => OnDisk {
            sha1: "unused".to_owned(),
            sha512: "unused".to_owned(),
            sha256: sha256.clone(),
            size: *size,
        },
    }
}

/// Disk bytes that match nothing, standing for a user edit.
fn foreign() -> OnDisk {
    OnDisk {
        sha1: "foreign".to_owned(),
        sha512: "foreign".to_owned(),
        sha256: "foreign".to_owned(),
        size: 7,
    }
}

fn files(entries: &[(&str, Provided)]) -> Files {
    entries
        .iter()
        .map(|(path, provided)| (path.to_lowercase(), ((*path).to_owned(), provided.clone())))
        .collect()
}

fn disk(entries: &[(&str, Option<OnDisk>, Option<OnDisk>)]) -> BTreeMap<String, DiskPath> {
    entries
        .iter()
        .map(|(path, enabled, disabled)| {
            (
                path.to_lowercase(),
                DiskPath { enabled: enabled.clone(), disabled: disabled.clone() },
            )
        })
        .collect()
}

fn run(baseline: &Files, upstream: &Files, disk: &BTreeMap<String, DiskPath>) -> Plan {
    plan(&PlanInput { baseline, upstream, disk })
}

fn step(path: &str, action: Action, disabled: bool) -> Step {
    Step { path: path.to_owned(), action, disabled }
}

fn conflict(path: &str, reason: ConflictReason, upstream: Step) -> Conflict {
    Conflict { path: path.to_owned(), reason, upstream }
}

#[test]
fn both_present_1a_enabled_matches_upstream_is_unchanged() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", Some(on_disk_for(&download("new"))), None)]);
    assert_eq!(run(&baseline, &upstream, &disk), Plan { unchanged: 1, ..Plan::default() });
}

#[test]
fn both_present_1b_disabled_matches_upstream_is_unchanged() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", None, Some(on_disk_for(&download("new"))))]);
    assert_eq!(run(&baseline, &upstream, &disk), Plan { unchanged: 1, ..Plan::default() });
}

#[test]
fn both_present_1c_enabled_matches_baseline_is_replaced() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", Some(on_disk_for(&download("old"))), None)]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            steps: vec![step("mods/x.jar", Action::Replace, false)],
            ..Plan::default()
        }
    );
}

#[test]
fn both_present_1d_disabled_matches_baseline_is_replaced_disabled() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", None, Some(on_disk_for(&download("old"))))]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            steps: vec![step("mods/x.jar", Action::Replace, true)],
            ..Plan::default()
        }
    );
}

#[test]
fn both_present_1e_nothing_on_disk_is_user_deleted() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            conflicts: vec![conflict(
                "mods/x.jar",
                ConflictReason::UserDeleted,
                step("mods/x.jar", Action::Add, false),
            )],
            ..Plan::default()
        }
    );
}

#[test]
fn both_present_1f_modified_enabled_is_user_modified() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", Some(foreign()), None)]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            conflicts: vec![conflict(
                "mods/x.jar",
                ConflictReason::UserModified,
                step("mods/x.jar", Action::Replace, false),
            )],
            ..Plan::default()
        }
    );
}

#[test]
fn both_present_1f_modified_disabled_only_is_user_modified_disabled() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", None, Some(foreign()))]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            conflicts: vec![conflict(
                "mods/x.jar",
                ConflictReason::UserModified,
                step("mods/x.jar", Action::Replace, true),
            )],
            ..Plan::default()
        }
    );
}

#[test]
fn both_present_looks_at_enabled_before_disabled() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    // The enabled file matches the baseline, so 1c wins even though the disabled
    // sibling already matches upstream; the sibling is left alone.
    let disk = disk(&[(
        "mods/x.jar",
        Some(on_disk_for(&download("old"))),
        Some(on_disk_for(&download("new"))),
    )]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            steps: vec![step("mods/x.jar", Action::Replace, false)],
            ..Plan::default()
        }
    );
}

#[test]
fn baseline_only_2a_enabled_matches_baseline_is_removed() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[]);
    let disk = disk(&[("mods/x.jar", Some(on_disk_for(&download("old"))), None)]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            steps: vec![step("mods/x.jar", Action::Remove, false)],
            ..Plan::default()
        }
    );
}

#[test]
fn baseline_only_2b_disabled_matches_baseline_is_removed_and_dropped() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[]);
    let disk = disk(&[("mods/x.jar", None, Some(on_disk_for(&download("old"))))]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            steps: vec![step("mods/x.jar", Action::Remove, true)],
            dropped_intents: vec!["mods/x.jar".to_owned()],
            ..Plan::default()
        }
    );
}

#[test]
fn baseline_only_2c_nothing_on_disk_is_only_a_dropped_intent() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[]);
    let disk = disk(&[]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan { dropped_intents: vec!["mods/x.jar".to_owned()], ..Plan::default() }
    );
}

#[test]
fn baseline_only_2d_modified_enabled_is_user_modified_removed_upstream() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[]);
    let disk = disk(&[("mods/x.jar", Some(foreign()), None)]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            conflicts: vec![conflict(
                "mods/x.jar",
                ConflictReason::UserModifiedRemovedUpstream,
                step("mods/x.jar", Action::Remove, false),
            )],
            ..Plan::default()
        }
    );
}

#[test]
fn baseline_only_2d_modified_disabled_only_is_user_modified_removed_upstream_disabled() {
    let baseline = files(&[("mods/x.jar", download("old"))]);
    let upstream = files(&[]);
    let disk = disk(&[("mods/x.jar", None, Some(foreign()))]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            conflicts: vec![conflict(
                "mods/x.jar",
                ConflictReason::UserModifiedRemovedUpstream,
                step("mods/x.jar", Action::Remove, true),
            )],
            ..Plan::default()
        }
    );
}

#[test]
fn upstream_only_3a_nothing_on_disk_is_added() {
    let baseline = files(&[]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            steps: vec![step("mods/x.jar", Action::Add, false)],
            ..Plan::default()
        }
    );
}

#[test]
fn upstream_only_3b_enabled_matches_upstream_is_unchanged() {
    let baseline = files(&[]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", Some(on_disk_for(&download("new"))), None)]);
    assert_eq!(run(&baseline, &upstream, &disk), Plan { unchanged: 1, ..Plan::default() });
}

#[test]
fn upstream_only_3c_disabled_matches_upstream_is_unchanged() {
    let baseline = files(&[]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", None, Some(on_disk_for(&download("new"))))]);
    assert_eq!(run(&baseline, &upstream, &disk), Plan { unchanged: 1, ..Plan::default() });
}

#[test]
fn upstream_only_3d_modified_enabled_is_user_added() {
    let baseline = files(&[]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", Some(foreign()), None)]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            conflicts: vec![conflict(
                "mods/x.jar",
                ConflictReason::UserAdded,
                step("mods/x.jar", Action::Replace, false),
            )],
            ..Plan::default()
        }
    );
}

#[test]
fn upstream_only_3d_modified_disabled_only_is_user_added_disabled() {
    let baseline = files(&[]);
    let upstream = files(&[("mods/x.jar", download("new"))]);
    let disk = disk(&[("mods/x.jar", None, Some(foreign()))]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            conflicts: vec![conflict(
                "mods/x.jar",
                ConflictReason::UserAdded,
                step("mods/x.jar", Action::Replace, true),
            )],
            ..Plan::default()
        }
    );
}

#[test]
fn changed_override_and_download_became_override_are_replaced() {
    let baseline = files(&[
        ("config/a.toml", over("old")),
        ("mods/b.jar", download("old")),
    ]);
    let upstream = files(&[
        ("config/a.toml", over("new")),
        ("mods/b.jar", over("new")),
    ]);
    let disk = disk(&[
        ("config/a.toml", Some(on_disk_for(&over("old"))), None),
        ("mods/b.jar", Some(on_disk_for(&download("old"))), None),
    ]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            steps: vec![
                step("config/a.toml", Action::Replace, false),
                step("mods/b.jar", Action::Replace, false),
            ],
            ..Plan::default()
        }
    );
}

#[test]
fn steps_use_the_spelling_of_the_version_they_come_from() {
    let baseline = files(&[
        ("mods/Added.jar", download("added")),
        ("mods/Removed.jar", download("removed")),
        ("mods/Replaced.jar", download("replaced")),
    ]);
    let upstream = files(&[
        ("mods/ADDED.jar", download("added-new")),
        ("mods/New.jar", download("new")),
        ("mods/REPLACED.jar", download("replaced-new")),
    ]);
    let disk = disk(&[
        ("mods/removed.jar", Some(on_disk_for(&download("removed"))), None),
        ("mods/replaced.jar", Some(on_disk_for(&download("replaced"))), None),
    ]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            steps: vec![
                step("mods/New.jar", Action::Add, false),
                step("mods/Removed.jar", Action::Remove, false),
                step("mods/REPLACED.jar", Action::Replace, false),
            ],
            conflicts: vec![conflict(
                "mods/ADDED.jar",
                ConflictReason::UserDeleted,
                step("mods/ADDED.jar", Action::Add, false),
            )],
            ..Plan::default()
        }
    );
}

#[test]
fn matching_compares_hex_without_case() {
    let baseline = files(&[
        ("config/a.toml", over("old")),
        ("mods/b.jar", download("old")),
    ]);
    let upstream = files(&[
        ("config/a.toml", over("new")),
        ("mods/b.jar", download("new")),
    ]);
    let mut download_disk = on_disk_for(&download("new"));
    download_disk.sha1.make_ascii_uppercase();
    download_disk.sha512.make_ascii_uppercase();
    let mut override_disk = on_disk_for(&over("new"));
    override_disk.sha256.make_ascii_uppercase();
    let disk = disk(&[
        ("config/a.toml", Some(override_disk), None),
        ("mods/b.jar", Some(download_disk), None),
    ]);
    assert_eq!(run(&baseline, &upstream, &disk), Plan { unchanged: 2, ..Plan::default() });
}

#[test]
fn a_size_difference_alone_breaks_a_match() {
    let baseline = files(&[
        ("config/a.toml", over("old")),
        ("mods/b.jar", download("old")),
    ]);
    let upstream = files(&[
        ("config/a.toml", over("new")),
        ("mods/b.jar", download("new")),
    ]);
    let mut override_disk = on_disk_for(&over("new"));
    override_disk.size += 1;
    let mut download_disk = on_disk_for(&download("new"));
    download_disk.size += 1;
    let disk = disk(&[
        ("config/a.toml", Some(override_disk), None),
        ("mods/b.jar", Some(download_disk), None),
    ]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            conflicts: vec![
                conflict(
                    "config/a.toml",
                    ConflictReason::UserModified,
                    step("config/a.toml", Action::Replace, false),
                ),
                conflict(
                    "mods/b.jar",
                    ConflictReason::UserModified,
                    step("mods/b.jar", Action::Replace, false),
                ),
            ],
            ..Plan::default()
        }
    );
}

#[test]
fn user_folders_launcher_files_and_short_names_are_left_alone() {
    let paths = [
        "saves/world/level.dat",
        "logs/latest.log",
        "crash-reports/x.txt",
        "screenshots/a.png",
        ".launcher-temp/x",
        ".launcher-resource-history/mods/x",
        ".launcher-pack.json",
        "mods/MODS~1.JAR",
    ];
    let no_files = Files::new();
    for path in paths {
        let baseline = files(&[(path, download("old"))]);
        let upstream = files(&[(path, download("new"))]);
        let matching_baseline = disk(&[(path, Some(on_disk_for(&download("old"))), None)]);
        let nothing = disk(&[]);
        let cases = [
            // Baseline only with matching bytes would be a Remove if not skipped.
            (&baseline, &no_files, &matching_baseline),
            (&no_files, &upstream, &nothing),
            (&baseline, &upstream, &nothing),
        ];
        for (baseline, upstream, disk) in cases {
            let planned = run(baseline, upstream, disk);
            assert!(planned.steps.is_empty(), "{path}: steps {:?}", planned.steps);
            assert!(planned.conflicts.is_empty(), "{path}: conflicts {:?}", planned.conflicts);
            assert_eq!(planned.unchanged, 0, "{path}");
            assert_eq!(planned.skipped, vec![path.to_owned()], "{path}");
        }
    }
}

#[test]
fn skipped_paths_keep_the_upstream_spelling() {
    let baseline = files(&[("saves/World/Level.dat", download("old"))]);
    let upstream = files(&[("saves/world/LEVEL.DAT", download("new"))]);
    let planned = run(&baseline, &upstream, &disk(&[]));
    assert_eq!(planned.skipped, vec!["saves/world/LEVEL.DAT".to_owned()]);
    assert!(planned.steps.is_empty());
    assert!(planned.conflicts.is_empty());
}

#[test]
fn a_path_missing_from_disk_behaves_as_nothing_on_disk() {
    let other = disk(&[("mods/elsewhere.jar", Some(foreign()), None)]);

    let baseline = files(&[("mods/both.jar", download("old"))]);
    let upstream = files(&[("mods/both.jar", download("new"))]);
    assert_eq!(
        run(&baseline, &upstream, &other),
        Plan {
            conflicts: vec![conflict(
                "mods/both.jar",
                ConflictReason::UserDeleted,
                step("mods/both.jar", Action::Add, false),
            )],
            ..Plan::default()
        }
    );

    let baseline = files(&[("mods/old.jar", download("old"))]);
    let no_files = Files::new();
    assert_eq!(
        run(&baseline, &no_files, &other),
        Plan { dropped_intents: vec!["mods/old.jar".to_owned()], ..Plan::default() }
    );

    let upstream = files(&[("mods/new.jar", download("new"))]);
    assert_eq!(
        run(&no_files, &upstream, &other),
        Plan {
            steps: vec![step("mods/new.jar", Action::Add, false)],
            ..Plan::default()
        }
    );
}

#[test]
fn a_mixed_plan_is_ordered_by_lowercase_key() {
    let baseline = files(&[
        ("mods/Alpha.jar", download("alpha")),
        ("mods/beta.jar", download("beta")),
        ("config/gamma.toml", download("gamma")),
        ("mods/epsilon.jar", download("epsilon")),
        ("mods/aaa.jar", download("aaa")),
        ("mods/removed-intent.jar", download("intent")),
        ("saves/keep.dat", download("saves")),
        ("logs/x.log", download("logs")),
    ]);
    let upstream = files(&[
        ("mods/alpha.jar", download("alpha-new")),
        ("mods/Delta.jar", download("delta")),
        ("config/gamma.toml", download("gamma-new")),
        ("mods/epsilon.jar", download("epsilon-new")),
        ("mods/aaa.jar", download("aaa-new")),
        ("mods/zeta.jar", over("zeta")),
        ("saves/keep.dat", download("saves-new")),
        ("logs/x.log", download("logs-new")),
    ]);
    let disk = disk(&[
        ("mods/alpha.jar", Some(on_disk_for(&download("alpha"))), None),
        ("mods/beta.jar", Some(on_disk_for(&download("beta"))), None),
        ("config/gamma.toml", Some(foreign()), None),
        ("mods/aaa.jar", Some(on_disk_for(&download("aaa-new"))), None),
        ("mods/removed-intent.jar", None, Some(on_disk_for(&download("intent")))),
        ("mods/zeta.jar", Some(foreign()), None),
        ("saves/keep.dat", Some(foreign()), None),
        ("logs/x.log", None, Some(foreign())),
    ]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            steps: vec![
                step("mods/alpha.jar", Action::Replace, false),
                step("mods/beta.jar", Action::Remove, false),
                step("mods/Delta.jar", Action::Add, false),
                step("mods/removed-intent.jar", Action::Remove, true),
            ],
            conflicts: vec![
                conflict(
                    "config/gamma.toml",
                    ConflictReason::UserModified,
                    step("config/gamma.toml", Action::Replace, false),
                ),
                conflict(
                    "mods/epsilon.jar",
                    ConflictReason::UserDeleted,
                    step("mods/epsilon.jar", Action::Add, false),
                ),
                conflict(
                    "mods/zeta.jar",
                    ConflictReason::UserAdded,
                    step("mods/zeta.jar", Action::Replace, false),
                ),
            ],
            unchanged: 1,
            kept: Vec::new(),
            dropped_intents: vec!["mods/removed-intent.jar".to_owned()],
            skipped: vec!["logs/x.log".to_owned(), "saves/keep.dat".to_owned()],
        }
    );
}

#[test]
fn a_user_change_to_a_file_the_new_version_leaves_alone_is_kept_without_a_conflict() {
    // The installed and the new version provide the same bytes; the user edited
    // one file, disabled-and-edited another and deleted a third.
    let same = download("same");
    let baseline = files(&[("config/a.toml", over("cfg")), ("mods/b.jar", same.clone()), ("mods/c.jar", same.clone())]);
    let upstream = baseline.clone();
    let disk = disk(&[
        ("config/a.toml", Some(foreign()), None),
        ("mods/b.jar", None, Some(foreign())),
    ]);
    assert_eq!(
        run(&baseline, &upstream, &disk),
        Plan {
            kept: vec!["config/a.toml".into(), "mods/b.jar".into(), "mods/c.jar".into()],
            ..Plan::default()
        }
    );
    // When the new version does change the file, the edit is a conflict again.
    let changed = files(&[("config/a.toml", over("cfg2")), ("mods/b.jar", same.clone()), ("mods/c.jar", same)]);
    let plan = run(&baseline, &changed, &disk);
    assert_eq!(plan.kept, ["mods/b.jar", "mods/c.jar"]);
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].reason, ConflictReason::UserModified);
}

#[test]
fn a_disabled_name_a_version_provides_belongs_to_that_path() {
    // The user disabled mods/e.jar; the new version ships it as
    // mods/e.jar.disabled itself. The one file on disk is that path's.
    let bytes = download("e");
    let shipped = files(&[("mods/e.jar.disabled", bytes.clone())]);
    let disk = disk(&[
        ("mods/e.jar", None, Some(on_disk_for(&bytes))),
        ("mods/e.jar.disabled", Some(on_disk_for(&bytes)), None),
    ]);
    assert_eq!(
        run(&files(&[("mods/e.jar", bytes.clone())]), &shipped, &disk),
        Plan { unchanged: 1, dropped_intents: vec!["mods/e.jar".into()], ..Plan::default() },
        "the shipped file is not removed as mods/e.jar's disabled copy"
    );
    // The other way round: the new version enables a mod it shipped disabled.
    assert_eq!(
        run(&shipped, &files(&[("mods/e.jar", bytes)]), &disk),
        Plan {
            steps: vec![step("mods/e.jar", Action::Add, false), step("mods/e.jar.disabled", Action::Remove, false)],
            ..Plan::default()
        }
    );
}

#[test]
fn a_hash_difference_alone_breaks_a_match() {
    // Same size and the other hash: a file is the version's only if every
    // recorded hash agrees.
    let baseline = files(&[("mods/b.jar", download("old"))]);
    let upstream = files(&[("mods/b.jar", download("new"))]);
    for (label, change) in [("sha512", 0), ("sha1", 1)] {
        let mut disk_file = on_disk_for(&download("new"));
        if change == 0 {
            disk_file.sha512 = "different".into();
        } else {
            disk_file.sha1 = "different".into();
        }
        let plan = run(&baseline, &upstream, &disk(&[("mods/b.jar", Some(disk_file), None)]));
        assert_eq!(plan.unchanged, 0, "{label}");
        assert_eq!(plan.conflicts.len(), 1, "{label}");
        assert_eq!(plan.conflicts[0].reason, ConflictReason::UserModified, "{label}");
    }
}
