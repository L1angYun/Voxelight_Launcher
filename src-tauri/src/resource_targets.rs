//! Resource target planning over metadata collected by the command layer.

use crate::errors::{AppError, AppResult};
use crate::resources::ResourceKind;
use serde::Serialize;
use std::collections::HashSet;

const MOD_LOADERS: [&str; 4] = ["fabric", "neoforge", "forge", "quilt"];

#[derive(Clone, Debug)]
pub(crate) struct VersionLite {
    pub id: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub version_type: String,
    pub date_published: String,
}

#[derive(Clone, Debug)]
pub(crate) struct TargetCandidate {
    pub kind: String,
    pub instance_id: Option<String>,
    pub version_id: String,
    pub name: String,
    pub game_version: Option<String>,
    pub loader: Option<String>,
    pub last_played: Option<String>,
    pub running: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetRow {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub version_id: String,
    pub name: String,
    pub game_version: String,
    pub loader: Option<String>,
    pub compatible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_version_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoaderMatrix {
    pub loader: String,
    pub game_versions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NewInstanceSuggestion {
    pub loader: String,
    pub game_version: String,
    pub name: String,
    pub matrix: Vec<LoaderMatrix>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResourceTargetPlan {
    pub project_id: String,
    pub title: String,
    pub project_type: String,
    pub targets: Vec<TargetRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<NewInstanceSuggestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
    pub manifest_unavailable: bool,
}

pub(crate) fn build_plan(
    project_id: &str,
    title: &str,
    project_type: &str,
    kind: ResourceKind,
    candidates: &[TargetCandidate],
    versions: &[VersionLite],
    manifest: &[(String, String)],
) -> ResourceTargetPlan {
    let targets = rows(candidates, versions, kind);
    let suggestion = suggest(versions, manifest, kind, title);
    let manifest_unavailable = manifest.is_empty();
    let unsupported_reason = if versions.is_empty() {
        Some("noVersions")
    } else if kind == ResourceKind::Mod
        && !versions.iter().any(|version| {
            version
                .loaders
                .iter()
                .any(|loader| MOD_LOADERS.contains(&loader.as_str()))
        })
    {
        let loaders: Vec<_> = versions
            .iter()
            .flat_map(|version| &version.loaders)
            .collect();
        Some(
            if !loaders.is_empty() && loaders.iter().all(|loader| loader.as_str() == "datapack") {
                "datapack"
            } else {
                "noSupportedLoader"
            },
        )
    } else if !targets.iter().any(|row| row.compatible) && suggestion.is_none() {
        Some(if manifest_unavailable {
            "manifestUnavailable"
        } else {
            "noReleaseVersions"
        })
    } else {
        None
    };
    ResourceTargetPlan {
        project_id: project_id.into(),
        title: title.into(),
        project_type: project_type.into(),
        targets,
        suggestion,
        unsupported_reason: unsupported_reason.map(str::to_string),
        manifest_unavailable,
    }
}

pub(crate) fn rows(
    candidates: &[TargetCandidate],
    versions: &[VersionLite],
    kind: ResourceKind,
) -> Vec<TargetRow> {
    let mut planned: Vec<_> = candidates
        .iter()
        .map(|candidate| {
            let game = candidate
                .game_version
                .as_deref()
                .filter(|game| !game.is_empty());
            let loader = candidate
                .loader
                .as_deref()
                .filter(|loader| !loader.is_empty());
            let reason = if candidate.running {
                Some("running")
            } else if game.is_none() {
                Some("metadataMissing")
            } else if kind == ResourceKind::Mod && loader.is_none_or(|loader| loader == "vanilla") {
                Some("vanilla")
            } else if !versions.iter().any(|version| {
                version
                    .game_versions
                    .iter()
                    .any(|version_game| Some(version_game.as_str()) == game)
            }) {
                Some("gameVersionMismatch")
            } else if kind == ResourceKind::Mod
                && (!loader.is_some_and(|loader| MOD_LOADERS.contains(&loader))
                    || select_version(versions, kind, loader, game.unwrap()).is_none())
            {
                Some("loaderMismatch")
            } else {
                None
            };
            let selected = if reason.is_none() {
                select_version(versions, kind, loader, game.unwrap())
            } else {
                None
            };
            (
                TargetRow {
                    kind: candidate.kind.clone(),
                    instance_id: candidate.instance_id.clone(),
                    version_id: candidate.version_id.clone(),
                    name: candidate.name.clone(),
                    game_version: game.unwrap_or_default().into(),
                    loader: loader.map(str::to_string),
                    compatible: selected.is_some(),
                    reason: reason.map(str::to_string),
                    resource_version_id: selected.map(|version| version.id.clone()),
                },
                candidate.last_played.as_deref(),
            )
        })
        .collect();
    planned.sort_by(|(left, left_played), (right, right_played)| {
        right
            .compatible
            .cmp(&left.compatible)
            .then_with(|| right_played.cmp(left_played))
    });
    planned.into_iter().map(|(row, _)| row).collect()
}

pub(crate) fn suggest(
    versions: &[VersionLite],
    manifest: &[(String, String)],
    kind: ResourceKind,
    title: &str,
) -> Option<NewInstanceSuggestion> {
    let loaders: &[&str] = match kind {
        ResourceKind::Mod => &MOD_LOADERS,
        ResourceKind::ResourcePack => &["vanilla"],
        // Shader runtimes are a separate installation; this selects a useful
        // game profile while the UI explains that Iris may still be needed.
        ResourceKind::Shader => &["fabric"],
    };
    let matrix: Vec<_> = loaders
        .iter()
        .filter_map(|loader| {
            let games = ordered_games(
                versions.iter().filter(|version| {
                    kind != ResourceKind::Mod || version.loaders.iter().any(|value| value == loader)
                }),
                manifest,
            );
            (!games.is_empty()).then(|| LoaderMatrix {
                loader: (*loader).into(),
                game_versions: games,
            })
        })
        .collect();
    let preferred = matrix.first()?;
    let release_games = ordered_games(
        versions.iter().filter(|version| {
            version.version_type == "release"
                && (kind != ResourceKind::Mod || version.loaders.contains(&preferred.loader))
        }),
        manifest,
    );
    let game_version = release_games
        .first()
        .unwrap_or(&preferred.game_versions[0])
        .clone();
    Some(NewInstanceSuggestion {
        loader: preferred.loader.clone(),
        game_version,
        name: title.trim().chars().take(80).collect(),
        matrix,
    })
}

pub(crate) fn validate_request<'a>(
    versions: &'a [VersionLite],
    kind: ResourceKind,
    loader: &str,
    game: &str,
) -> AppResult<&'a VersionLite> {
    let allowed_loader =
        MOD_LOADERS.contains(&loader) || (kind != ResourceKind::Mod && loader == "vanilla");
    allowed_loader
        .then(|| select_version(versions, kind, Some(loader), game))
        .flatten()
        .ok_or_else(|| {
            AppError::new("resource.noCompatibleVersion")
                .with_param("gameVersion", game)
                .with_param("loader", loader)
        })
}

fn select_version<'a>(
    versions: &'a [VersionLite],
    kind: ResourceKind,
    loader: Option<&str>,
    game: &str,
) -> Option<&'a VersionLite> {
    versions
        .iter()
        .filter(|version| {
            version.game_versions.iter().any(|value| value == game)
                && (kind != ResourceKind::Mod
                    || loader
                        .is_some_and(|loader| version.loaders.iter().any(|value| value == loader)))
        })
        .max_by(|left, right| {
            (left.version_type == "release")
                .cmp(&(right.version_type == "release"))
                .then_with(|| left.date_published.cmp(&right.date_published))
        })
}

fn ordered_games<'a>(
    versions: impl Iterator<Item = &'a VersionLite>,
    manifest: &[(String, String)],
) -> Vec<String> {
    let supported: HashSet<_> = versions
        .flat_map(|version| version.game_versions.iter().map(String::as_str))
        .collect();
    // Without an authoritative Mojang order there is no default to suggest.
    // Existing target compatibility is independent of this creation matrix.
    let mut seen = HashSet::new();
    manifest
        .iter()
        .filter(|(id, kind)| {
            kind == "release" && supported.contains(id.as_str()) && seen.insert(id.as_str())
        })
        .map(|(id, _)| id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(id: &str, loaders: &[&str], games: &[&str]) -> VersionLite {
        VersionLite {
            id: id.into(),
            game_versions: games.iter().map(|value| (*value).into()).collect(),
            loaders: loaders.iter().map(|value| (*value).into()).collect(),
            version_type: "release".into(),
            date_published: "2026-11-08T00:00:00Z".into(),
        }
    }

    fn manifest() -> Vec<(String, String)> {
        [
            ("26.1-snapshot-1", "snapshot"),
            ("1.21.10", "release"),
            ("1.21.9", "release"),
            ("1.21.1", "release"),
            ("1.20.1", "release"),
        ]
        .into_iter()
        .map(|(id, kind)| (id.into(), kind.into()))
        .collect()
    }

    fn candidate(id: &str, game: Option<&str>, loader: Option<&str>) -> TargetCandidate {
        TargetCandidate {
            kind: "instance".into(),
            instance_id: Some(id.into()),
            version_id: format!("{id}-profile"),
            name: id.into(),
            game_version: game.map(str::to_string),
            loader: loader.map(str::to_string),
            last_played: None,
            running: false,
        }
    }

    #[test]
    fn suggest_prefers_fabric_and_latest_manifest_release() {
        let versions = vec![
            version(
                "111",
                &["fabric"],
                &["1.21.9", "1.21.10", "1.20.1", "26.1-snapshot-1"],
            ),
            version("222", &["neoforge"], &["1.21.10"]),
        ];
        let suggestion = suggest(&versions, &manifest(), ResourceKind::Mod, "Fabric API").unwrap();
        assert_eq!(suggestion.loader, "fabric");
        assert_eq!(suggestion.game_version, "1.21.10");
        assert_eq!(suggestion.name, "Fabric API");
        assert_eq!(
            suggestion
                .matrix
                .iter()
                .map(|row| row.loader.as_str())
                .collect::<Vec<_>>(),
            ["fabric", "neoforge"]
        );
        assert_eq!(
            suggestion.matrix[0].game_versions,
            ["1.21.10", "1.21.9", "1.20.1"]
        );
    }

    #[test]
    fn suggest_falls_back_neoforge_then_forge_then_quilt() {
        for (loaders, expected) in [
            (vec!["quilt", "forge", "neoforge"], "neoforge"),
            (vec!["quilt", "forge"], "forge"),
            (vec!["quilt"], "quilt"),
        ] {
            let versions = vec![version("111", &loaders, &["1.21.1"])];
            assert_eq!(
                suggest(&versions, &manifest(), ResourceKind::Mod, "Mod")
                    .unwrap()
                    .loader,
                expected
            );
        }
    }

    #[test]
    fn plan_reports_datapack_plugin_and_empty_projects() {
        for (versions, reason) in [
            (vec![version("111", &["datapack"], &["1.21.1"])], "datapack"),
            (
                vec![version("222", &["paper", "bukkit"], &["1.21.1"])],
                "noSupportedLoader",
            ),
            (vec![], "noVersions"),
        ] {
            let plan = build_plan(
                "111",
                "Project",
                "mod",
                ResourceKind::Mod,
                &[],
                &versions,
                &manifest(),
            );
            assert!(plan.suggestion.is_none());
            assert_eq!(plan.unsupported_reason.as_deref(), Some(reason));
        }
    }

    #[test]
    fn suggest_resourcepack_uses_vanilla() {
        let versions = vec![version("111", &["minecraft"], &["1.21.9", "1.21.10"])];
        let suggestion =
            suggest(&versions, &manifest(), ResourceKind::ResourcePack, "Pack").unwrap();
        assert_eq!(suggestion.loader, "vanilla");
        assert_eq!(suggestion.game_version, "1.21.10");
        assert_eq!(suggestion.matrix[0].loader, "vanilla");
    }

    #[test]
    fn shader_suggestion_uses_fabric_without_requiring_an_iris_mod_version() {
        let versions = vec![version("111", &["iris", "optifine"], &["1.21.1"])];
        let suggestion = suggest(&versions, &manifest(), ResourceKind::Shader, "Shader").unwrap();
        assert_eq!(suggestion.loader, "fabric");
        assert_eq!(suggestion.game_version, "1.21.1");
        assert_eq!(
            validate_request(&versions, ResourceKind::Shader, "vanilla", "1.21.1")
                .unwrap()
                .id,
            "111"
        );
    }

    #[test]
    fn rows_use_resolved_context_and_include_version_directories() {
        let versions = vec![version("111", &["fabric"], &["1.21.1"])];
        let inherited = candidate("Inherited Fabric", Some("1.21.1"), Some("fabric"));
        let vanilla = candidate("Vanilla", Some("1.21.1"), None);
        let mut directory = candidate("Fabric Directory", Some("1.21.1"), Some("fabric"));
        directory.kind = "version".into();
        directory.instance_id = None;
        let rows = rows(
            &[inherited, vanilla, directory],
            &versions,
            ResourceKind::Mod,
        );
        let inherited = rows
            .iter()
            .find(|row| row.name == "Inherited Fabric")
            .unwrap();
        assert!(inherited.compatible);
        assert_eq!(inherited.game_version, "1.21.1");
        assert_eq!(inherited.resource_version_id.as_deref(), Some("111"));
        let vanilla = rows.iter().find(|row| row.name == "Vanilla").unwrap();
        assert!(!vanilla.compatible);
        assert_eq!(vanilla.reason.as_deref(), Some("vanilla"));
        assert!(rows
            .iter()
            .any(|row| row.kind == "version" && row.instance_id.is_none() && row.compatible));
    }

    #[test]
    fn rows_mark_game_loader_running_and_missing_metadata() {
        let versions = vec![version("111", &["fabric"], &["1.21.1"])];
        let game = candidate("Game", Some("1.20.1"), Some("fabric"));
        let loader = candidate("Loader", Some("1.21.1"), Some("forge"));
        let missing = candidate("Missing", None, None);
        let mut running = candidate("Running", Some("1.21.1"), Some("fabric"));
        running.running = true;
        let rows = rows(
            &[game, loader, missing, running],
            &versions,
            ResourceKind::Mod,
        );
        for (name, reason) in [
            ("Game", "gameVersionMismatch"),
            ("Loader", "loaderMismatch"),
            ("Missing", "metadataMissing"),
            ("Running", "running"),
        ] {
            let row = rows.iter().find(|row| row.name == name).unwrap();
            assert!(!row.compatible);
            assert_eq!(row.reason.as_deref(), Some(reason));
            assert!(row.resource_version_id.is_none());
        }
    }

    #[test]
    fn rows_order_compatible_targets_before_incompatible_then_recent_first() {
        let versions = vec![version("111", &["fabric"], &["1.21.1"])];
        let mut recent = candidate("Recent", Some("1.21.1"), Some("fabric"));
        recent.last_played = Some("2026-11-08T12:00:00Z".into());
        let mut old = candidate("Old", Some("1.21.1"), Some("fabric"));
        old.last_played = Some("2026-10-01T12:00:00Z".into());
        let vanilla = candidate("Vanilla", Some("1.21.1"), None);
        assert_eq!(
            rows(&[vanilla, old, recent], &versions, ResourceKind::Mod)
                .iter()
                .map(|row| row.name.as_str())
                .collect::<Vec<_>>(),
            ["Recent", "Old", "Vanilla"]
        );
    }

    #[test]
    fn validate_request_rejects_pairs_outside_matrix() {
        let versions = vec![version("111", &["fabric"], &["1.21.1"])];
        for (loader, game) in [
            ("fabric", "1.19.2"),
            ("forge", "1.21.1"),
            ("vanilla", "1.21.1"),
            ("paper", "1.21.1"),
        ] {
            let error = validate_request(&versions, ResourceKind::Mod, loader, game).unwrap_err();
            assert_eq!(error.code, "resource.noCompatibleVersion");
            assert_eq!(error.params["gameVersion"], game);
            assert_eq!(error.params["loader"], loader);
        }
    }

    #[test]
    fn validation_and_rows_prefer_release_mod_versions_before_newer_beta() {
        let mut beta = version("222", &["fabric"], &["1.21.1"]);
        beta.version_type = "beta".into();
        let mut release = version("111", &["fabric"], &["1.21.1"]);
        release.date_published = "2026-10-01T00:00:00Z".into();
        let versions = vec![beta, release];
        assert_eq!(
            validate_request(&versions, ResourceKind::Mod, "fabric", "1.21.1")
                .unwrap()
                .id,
            "111"
        );
        let rows = rows(
            &[candidate("Fabric", Some("1.21.1"), Some("fabric"))],
            &versions,
            ResourceKind::Mod,
        );
        assert_eq!(rows[0].resource_version_id.as_deref(), Some("111"));
    }

    #[test]
    fn suggestion_prefers_games_with_release_mod_files_and_keeps_full_matrix() {
        let mut beta = version("222", &["fabric"], &["1.21.10"]);
        beta.version_type = "beta".into();
        let release = version("111", &["fabric"], &["1.21.9"]);
        let suggestion = suggest(&[beta, release], &manifest(), ResourceKind::Mod, "Mod").unwrap();
        assert_eq!(suggestion.game_version, "1.21.9");
        assert_eq!(suggestion.matrix[0].game_versions, ["1.21.10", "1.21.9"]);
    }

    #[test]
    fn suggestion_only_uses_games_present_in_a_nonempty_mojang_manifest() {
        let versions = vec![version("111", &["fabric"], &["99.99", "26.1-snapshot-1"])];
        assert!(suggest(&versions, &manifest(), ResourceKind::Mod, "Mod").is_none());
    }

    #[test]
    fn plan_explains_no_release_games_without_blocking_a_compatible_snapshot_target() {
        let versions = vec![version("111", &["fabric"], &["26.1-snapshot-1"])];
        let plan = build_plan(
            "111",
            "Snapshot Mod",
            "mod",
            ResourceKind::Mod,
            &[],
            &versions,
            &manifest(),
        );
        assert!(plan.targets.is_empty());
        assert!(plan.suggestion.is_none());
        assert_eq!(
            plan.unsupported_reason.as_deref(),
            Some("noReleaseVersions")
        );

        let compatible = build_plan(
            "111",
            "Snapshot Mod",
            "mod",
            ResourceKind::Mod,
            &[candidate(
                "Existing Snapshot",
                Some("26.1-snapshot-1"),
                Some("fabric"),
            )],
            &versions,
            &manifest(),
        );
        assert!(compatible.targets[0].compatible);
        assert!(compatible.suggestion.is_none());
        assert!(compatible.unsupported_reason.is_none());
    }

    #[test]
    fn validation_chooses_newest_release_and_falls_back_to_beta() {
        let mut older = version("111", &["fabric"], &["1.21.1"]);
        older.date_published = "2026-10-01T00:00:00Z".into();
        let newer = version("222", &["fabric"], &["1.21.1"]);
        assert_eq!(
            validate_request(&[older, newer], ResourceKind::Mod, "fabric", "1.21.1")
                .unwrap()
                .id,
            "222"
        );
        let mut beta = version("111", &["fabric"], &["1.21.1"]);
        beta.version_type = "beta".into();
        assert_eq!(
            validate_request(&[beta], ResourceKind::Mod, "fabric", "1.21.1")
                .unwrap()
                .id,
            "111"
        );
    }

    #[test]
    fn resourcepack_rows_support_vanilla_and_loader_profiles_by_game() {
        let versions = vec![version("111", &["minecraft"], &["1.21.1"])];
        let rows = rows(
            &[
                candidate("Vanilla", Some("1.21.1"), None),
                candidate("Fabric", Some("1.21.1"), Some("fabric")),
            ],
            &versions,
            ResourceKind::ResourcePack,
        );
        assert!(rows.iter().all(|row| row.compatible));
    }

    #[test]
    fn suggestion_names_are_trimmed_and_truncated_by_characters() {
        let versions = vec![version("111", &["fabric"], &["1.21.1"])];
        let title = format!("  {}  ", "模".repeat(90));
        let suggestion = suggest(&versions, &manifest(), ResourceKind::Mod, &title).unwrap();
        assert_eq!(suggestion.name, "模".repeat(80));
    }

    #[test]
    fn missing_manifest_never_synthesizes_a_suggestion_and_preserves_compatible_rows() {
        let versions = vec![version(
            "111",
            &["fabric"],
            &["1.21.9", "1.21.10", "26.1-snapshot-1", "26.1"],
        )];
        for kind in [
            ResourceKind::Mod,
            ResourceKind::ResourcePack,
            ResourceKind::Shader,
        ] {
            let plan = build_plan(
                "111",
                "Project",
                "mod",
                kind,
                &[candidate("Existing", Some("1.21.10"), Some("fabric"))],
                &versions,
                &[],
            );
            assert!(
                plan.suggestion.is_none(),
                "a default requires Mojang release ordering: {kind:?}"
            );
            assert!(plan.unsupported_reason.is_none());
            assert!(plan.targets[0].compatible);
            assert_eq!(plan.targets[0].resource_version_id.as_deref(), Some("111"));
        }
    }

    #[test]
    fn plan_serializes_the_picker_contract_in_camel_case() {
        let versions = vec![version("111", &["fabric"], &["1.21.1"])];
        let plan = build_plan(
            "111",
            "Mod",
            "mod",
            ResourceKind::Mod,
            &[candidate("Fabric", Some("1.21.1"), Some("fabric"))],
            &versions,
            &manifest(),
        );
        let value = serde_json::to_value(plan).unwrap();
        assert_eq!(value["projectId"], "111");
        assert_eq!(value["projectType"], "mod");
        assert_eq!(value["manifestUnavailable"], false);
        assert_eq!(value["targets"][0]["instanceId"], "Fabric");
        assert_eq!(value["targets"][0]["resourceVersionId"], "111");
        assert_eq!(value["suggestion"]["gameVersion"], "1.21.1");
        assert_eq!(
            value["suggestion"]["matrix"][0]["gameVersions"][0],
            "1.21.1"
        );
        assert!(value.get("unsupportedReason").is_none());
        assert!(value["targets"][0].get("reason").is_none());
    }
}
