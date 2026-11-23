//! The three-way plan for updating a managed Modrinth modpack (U1153c): what
//! the installed version provided (its lock), what is on disk now and what
//! the new version provides. Pure: no I/O, no clock.
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// A file a pack version provides: downloaded from its index (sha1 and
/// sha512) or extracted from its overrides (sha256). Hashes are lowercase hex.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Provided {
    Download { sha1: String, sha512: String, size: u64 },
    /// A CurseForge download: the API gives only SHA-1 (and MD5) and size.
    Sha1Download { sha1: String, size: u64 },
    Override { sha256: String, size: u64 },
}

/// The hashes of a file on disk, lowercase hex.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OnDisk {
    pub sha1: String,
    pub sha512: String,
    pub sha256: String,
    pub size: u64,
}

/// What is on disk at a pack path: the file itself and its `.disabled` sibling.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DiskPath {
    pub enabled: Option<OnDisk>,
    pub disabled: Option<OnDisk>,
}

/// The three views, keyed by the lowercase path; the values keep the path as
/// spelled by the lock or the new version.
pub(crate) struct PlanInput<'a> {
    pub baseline: &'a BTreeMap<String, (String, Provided)>,
    pub upstream: &'a BTreeMap<String, (String, Provided)>,
    /// Every baseline and upstream key; a missing key means nothing is there.
    pub disk: &'a BTreeMap<String, DiskPath>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    /// Write the new file; nothing is at its path.
    Add,
    /// Remove what is at the path, then write the new file there.
    Replace,
    /// Remove what is at the path.
    Remove,
}

/// One change to the instance. With `disabled` the change applies to
/// `<path>.disabled`, and a written file is written under that name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Step {
    pub path: String,
    pub action: Action,
    pub disabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConflictReason {
    /// The user changed a file the new version also changes.
    UserModified,
    /// The user deleted a file the new version still provides.
    UserDeleted,
    /// The new version adds a file where the user already has another one.
    UserAdded,
    /// The user changed a file the new version no longer provides.
    UserModifiedRemovedUpstream,
}

/// A path where the user's change and the new version disagree. The default
/// is to keep the user's file; `upstream` is the step taken when they pick
/// the new version instead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conflict {
    pub path: String,
    pub reason: ConflictReason,
    pub upstream: Step,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    /// Sorted by lowercase path.
    pub steps: Vec<Step>,
    /// Sorted by lowercase path.
    pub conflicts: Vec<Conflict>,
    /// Paths already as the new version wants them.
    pub unchanged: usize,
    /// Files the user changed, disabled differently or deleted that the new
    /// version leaves as the installed one had them: kept without asking.
    pub kept: Vec<String>,
    /// Files the new version no longer provides that the user had disabled
    /// or deleted: that choice does not carry over to a renamed successor.
    pub dropped_intents: Vec<String>,
    /// Paths left alone on purpose (user data folders, launcher files, and
    /// 8.3-shaped names), sorted.
    pub skipped: Vec<String>,
}

/// Whether the bytes on disk are the ones a version provides. Hex is compared
/// without case because the sources do not agree on normalization.
fn matches(on_disk: &OnDisk, provided: &Provided) -> bool {
    match provided {
        Provided::Download { sha1, sha512, size } => {
            on_disk.size == *size
                && on_disk.sha1.eq_ignore_ascii_case(sha1)
                && on_disk.sha512.eq_ignore_ascii_case(sha512)
        }
        Provided::Sha1Download { sha1, size } => {
            on_disk.size == *size && on_disk.sha1.eq_ignore_ascii_case(sha1)
        }
        Provided::Override { sha256, size } => {
            on_disk.size == *size && on_disk.sha256.eq_ignore_ascii_case(sha256)
        }
    }
}

/// A step at a path spelled by whichever version the step comes from.
fn step_at(path: &str, action: Action, disabled: bool) -> Step {
    Step { path: path.to_owned(), action, disabled }
}

/// Paths the update never manages: user data folders, launcher state, and
/// 8.3-shaped names that may alias another file.
pub(crate) fn left_alone(path: &str) -> bool {
    const ROOTS: [&str; 6] = [
        "saves",
        "screenshots",
        "logs",
        "crash-reports",
        ".launcher-temp",
        ".launcher-resource-history",
    ];
    let root = path.split('/').next().unwrap_or(path);
    ROOTS.contains(&root)
        || path == ".launcher-pack.json"
        || crate::modpacks::short_name_shaped(path)
}

/// The plan for moving from `baseline` to `upstream` given `disk`.
pub(crate) fn plan(input: &PlanInput) -> Plan {
    let mut plan = Plan::default();
    let keys: BTreeSet<&str> = input
        .baseline
        .keys()
        .chain(input.upstream.keys())
        .map(String::as_str)
        .collect();
    for key in keys {
        let baseline = input.baseline.get(key);
        let upstream = input.upstream.get(key);
        let path = upstream
            .or(baseline)
            .map(|(path, _)| path.as_str())
            .expect("a union key belongs to one of the maps");
        if left_alone(key) {
            plan.skipped.push(path.to_owned());
            continue;
        }
        let disk = input.disk.get(key);
        let enabled = disk.and_then(|entry| entry.enabled.as_ref());
        // `<path>.disabled` that a version provides itself belongs to that
        // path: it is not this path's disabled copy.
        let sibling = format!("{key}.disabled");
        let aliased = input.baseline.contains_key(&sibling) || input.upstream.contains_key(&sibling);
        let disabled = disk.and_then(|entry| entry.disabled.as_ref()).filter(|_| !aliased);
        match (baseline, upstream) {
            (Some((_, baseline_file)), Some((upstream_path, upstream_file))) => {
                if enabled.is_some_and(|file| matches(file, upstream_file)) {
                    plan.unchanged += 1;
                } else if enabled.is_none()
                    && disabled.is_some_and(|file| matches(file, upstream_file))
                {
                    plan.unchanged += 1;
                } else if enabled.is_some_and(|file| matches(file, baseline_file)) {
                    plan.steps.push(step_at(upstream_path, Action::Replace, false));
                } else if enabled.is_none()
                    && disabled.is_some_and(|file| matches(file, baseline_file))
                {
                    plan.steps.push(step_at(upstream_path, Action::Replace, true));
                } else if baseline_file == upstream_file {
                    // The new version does not touch it: the user's change stands.
                    plan.kept.push(upstream_path.clone());
                } else if enabled.is_none() && disabled.is_none() {
                    plan.conflicts.push(Conflict {
                        path: upstream_path.clone(),
                        reason: ConflictReason::UserDeleted,
                        upstream: step_at(upstream_path, Action::Add, false),
                    });
                } else {
                    plan.conflicts.push(Conflict {
                        path: upstream_path.clone(),
                        reason: ConflictReason::UserModified,
                        upstream: step_at(upstream_path, Action::Replace, enabled.is_none()),
                    });
                }
            }
            (Some((baseline_path, baseline_file)), None) => {
                if enabled.is_some_and(|file| matches(file, baseline_file)) {
                    plan.steps.push(step_at(baseline_path, Action::Remove, false));
                } else if enabled.is_none()
                    && disabled.is_some_and(|file| matches(file, baseline_file))
                {
                    plan.dropped_intents.push(baseline_path.clone());
                    plan.steps.push(step_at(baseline_path, Action::Remove, true));
                } else if enabled.is_none() && disabled.is_none() {
                    plan.dropped_intents.push(baseline_path.clone());
                } else {
                    plan.conflicts.push(Conflict {
                        path: baseline_path.clone(),
                        reason: ConflictReason::UserModifiedRemovedUpstream,
                        upstream: step_at(baseline_path, Action::Remove, enabled.is_none()),
                    });
                }
            }
            (None, Some((upstream_path, upstream_file))) => {
                if enabled.is_none() && disabled.is_none() {
                    plan.steps.push(step_at(upstream_path, Action::Add, false));
                } else if enabled.is_some_and(|file| matches(file, upstream_file)) {
                    plan.unchanged += 1;
                } else if enabled.is_none()
                    && disabled.is_some_and(|file| matches(file, upstream_file))
                {
                    plan.unchanged += 1;
                } else {
                    plan.conflicts.push(Conflict {
                        path: upstream_path.clone(),
                        reason: ConflictReason::UserAdded,
                        upstream: step_at(upstream_path, Action::Replace, enabled.is_none()),
                    });
                }
            }
            // The key came from one of the two maps above.
            (None, None) => {}
        }
    }
    plan
}

#[cfg(test)]
#[path = "pack_update_plan_tests.rs"]
mod tests;
