use serde::{Deserialize, Serialize};

pub const CURRENT_SCHEMA_VERSION: u32 = 2;

/// Windows' own default system accent. Voxelight has no brand accent: this is
/// the stored default and the fallback when the native system accent cannot be
/// read, so the two cannot drift apart.
pub const DEFAULT_ACCENT_COLOR: &str = "#0078d4";

/// The retired Voxelight brand green. It is only recognised by the accent
/// migration; it is never a default, a fallback, or a preset.
const LEGACY_BRAND_ACCENT_COLOR: &str = "#b4f17a";

fn legacy_memory_mode() -> String {
    "manual".into()
}

/// One game folder the launcher may read. `game_directory` mirrors the path of
/// the active entry so the rest of the code keeps one authoritative root.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct GameFolder {
    pub path: String,
    pub label: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub game_directory: String,
    /// Every game folder the user added, in display order. The active entry's
    /// path always equals `game_directory` after normalization.
    #[serde(default)]
    pub game_folders: Vec<GameFolder>,
    pub java_path: String,
    pub max_memory_mb: u32,
    #[serde(default = "legacy_memory_mode")]
    pub memory_mode: String,
    pub min_memory_mb: Option<u32>,
    pub jvm_arguments: String,
    pub version_isolation: bool,
    pub theme: String,
    pub download_concurrency: usize,
    pub microsoft_client_id: String,
    pub download_limit_kib: u64,
    pub download_source: String,
    pub proxy_mode: String,
    pub proxy_scheme: String,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub game_proxy_mode: String,
    pub screen_width: u32,
    pub screen_height: u32,
    pub language: String,
    pub accent_color: String,
    pub effects: String,
    pub world_scene: String,
    pub world_material: String,
    pub accent_source: String,
    pub sound_enabled: bool,
    pub custom_background: Option<String>,
    pub ambient_light_enabled: bool,
    pub ambient_light_intensity: u8,
    pub background_blur: u8,
    pub background_dim: u8,
    pub background_drift: bool,
    pub java_auto_download: bool,
    /// Check for launcher updates in the background after start (HSR default: on).
    pub check_for_updates: bool,
    /// "auto" (GitHub and Gitee at once), "github" or "gitee".
    pub update_source: String,
    /// "stable" (official releases only) or "beta" (includes alpha/beta/rc pre-releases).
    pub update_channel: String,
    pub default_skin: String,
    /// The first-run tour was finished or skipped; older profiles have not seen it.
    pub tour_completed: bool,
    /// Built-in assistant provider: "openai" (OpenAI-compatible) or "anthropic".
    pub assistant_provider: String,
    /// Optional custom API base URL (HTTPS, or loopback HTTP for local models).
    pub assistant_base_url: String,
    /// Model identifier sent to the user's configured AI provider.
    pub assistant_model: String,
    /// Permission level for assistant and MCP tools: "readOnly", "controlled", or "fullAccess".
    pub assistant_permission: String,
    /// Localhost TCP port for the opt-in MCP server (127.0.0.1 only).
    pub assistant_mcp_port: u16,
    /// Proactively wake Lumen on crashes and failures (only applies once Lumen is configured).
    pub assistant_proactive: bool,
}

impl Default for Config {
    fn default() -> Self {
        let game_directory = std::env::var("VOXELIGHT_LAUNCHER_GAME_DIR")
            .or_else(|_| std::env::var("MINECRAFT_LAUNCHER_GAME_DIR"))
            .unwrap_or_else(|_| {
                dirs::config_dir()
                    .unwrap_or_else(|| ".".into())
                    .join(".minecraft")
                    .to_string_lossy()
                    .into()
            });
        Self {
            game_folders: vec![GameFolder {
                path: game_directory.clone(),
                label: String::new(),
                active: true,
            }],
            game_directory,
            java_path: String::new(),
            max_memory_mb: 4096,
            memory_mode: "auto".into(),
            min_memory_mb: None,
            jvm_arguments: "-XX:+UseG1GC".into(),
            version_isolation: true,
            theme: "system".into(),
            download_concurrency: 8,
            microsoft_client_id: String::new(),
            download_limit_kib: 0,
            download_source: "official".into(),
            proxy_mode: "system".into(),
            proxy_scheme: "http".into(),
            proxy_host: String::new(),
            proxy_port: 0,
            game_proxy_mode: "system".into(),
            screen_width: 1280,
            screen_height: 720,
            language: "system".into(),
            accent_color: DEFAULT_ACCENT_COLOR.into(),
            effects: "full".into(),
            world_scene: "horizon".into(),
            world_material: "lattice".into(),
            accent_source: "system".into(),
            sound_enabled: false,
            custom_background: None,
            ambient_light_enabled: true,
            ambient_light_intensity: 60,
            background_blur: 8,
            background_dim: 35,
            background_drift: false,
            java_auto_download: true,
            check_for_updates: true,
            update_source: "auto".into(),
            update_channel: "stable".into(),
            default_skin: "steve".into(),
            tour_completed: false,
            assistant_provider: "openai".into(),
            assistant_base_url: String::new(),
            assistant_model: String::new(),
            assistant_permission: "readOnly".into(),
            assistant_mcp_port: 25590,
            assistant_proactive: true,
        }
    }
}

impl Config {
    /// Migrate accent values written by older launcher versions.
    ///
    /// A system-sourced `accent_color` is only the starting value of the custom
    /// picker, so the retired brand green becomes Windows' default accent. A
    /// user-picked custom colour is never changed. The old "voxelight" source
    /// no longer exists because the brand accent was removed; those profiles
    /// follow the system accent from now on.
    pub fn migrate_legacy_accent(&mut self) {
        if self.accent_source.eq_ignore_ascii_case("voxelight") {
            self.accent_source = "system".into();
        }
        if self.accent_source == "system"
            && self
                .accent_color
                .eq_ignore_ascii_case(LEGACY_BRAND_ACCENT_COLOR)
        {
            self.accent_color = DEFAULT_ACCENT_COLOR.into();
        }
    }

    /// Bring a loaded, hand-edited or renderer-supplied configuration to the
    /// one-entry-per-folder model. The legacy single `gameDirectory` becomes
    /// the first entry, and the active entry always mirrors `gameDirectory`.
    /// Returns whether anything changed so the caller can persist the migration.
    pub fn normalize_game_folders(&mut self) -> bool {
        let original = self.clone();
        let mut folders: Vec<GameFolder> = Vec::new();
        for folder in self.game_folders.drain(..) {
            let path = folder.path.trim().to_owned();
            let label = folder.label.trim().to_owned();
            if path.is_empty()
                || folders
                    .iter()
                    .any(|existing| same_game_folder_path(&existing.path, &path))
            {
                continue;
            }
            folders.push(GameFolder {
                path,
                label,
                active: folder.active,
            });
        }
        let current = self.game_directory.trim().to_owned();
        let mut active = if current.is_empty() {
            folders
                .iter()
                .position(|folder| folder.active)
                .or(if folders.is_empty() { None } else { Some(0) })
        } else {
            folders
                .iter()
                .position(|folder| same_game_folder_path(&folder.path, &current))
        };
        if active.is_none() && !current.is_empty() {
            folders.push(GameFolder {
                path: current.clone(),
                label: String::new(),
                active: false,
            });
            active = Some(folders.len() - 1);
        }
        if let Some(index) = active {
            self.game_directory = folders[index].path.clone();
            for (position, folder) in folders.iter_mut().enumerate() {
                folder.active = position == index;
            }
        } else {
            self.game_directory.clear();
        }
        self.game_folders = folders;
        self != &original
    }

    /// The configured folders, active first, then the remaining ones in saved
    /// order. The legacy `gameDirectory` is included by normalization.
    pub fn game_folder_roots(&self) -> Vec<String> {
        let mut roots = Vec::new();
        if !self.game_directory.trim().is_empty() {
            roots.push(self.game_directory.trim().to_owned());
        }
        for folder in &self.game_folders {
            if !folder.path.trim().is_empty()
                && !roots
                    .iter()
                    .any(|root| same_game_folder_path(root, &folder.path))
            {
                roots.push(folder.path.trim().to_owned());
            }
        }
        roots
    }

    /// A display label for a configured folder: the user's label, otherwise the
    /// folder's own name, never an empty string.
    pub fn game_folder_label(&self, path: &str) -> String {
        if let Some(folder) = self
            .game_folders
            .iter()
            .find(|folder| same_game_folder_path(&folder.path, path))
        {
            if !folder.label.trim().is_empty() {
                return folder.label.trim().to_owned();
            }
        }
        std::path::Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| path.to_owned())
    }
}

/// One spelling for a game-folder path: separators, case and a trailing slash
/// never make two records describe different folders. This is the only path
/// spelling identity; the scan, conversion and launch resolver all use it.
pub(crate) fn normalized_game_folder_path(folder: &str) -> String {
    folder
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

/// Windows paths are case-insensitive; the rest of the codebase compares ASCII
/// case for alternate spellings of the same directory.
pub(crate) fn same_game_folder_path(left: &str, right: &str) -> bool {
    normalized_game_folder_path(left) == normalized_game_folder_path(right)
}

impl PartialEq for Config {
    fn eq(&self, other: &Self) -> bool {
        // Config carries no floats or maps of note; compare through serde so a
        // newly added preference cannot silently escape change detection.
        serde_json::to_value(self).ok() == serde_json::to_value(other).ok()
    }
}

fn deserialize_config<'de, D>(deserializer: D) -> Result<Config, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let mut config = Config::deserialize(deserializer)?;
    config.migrate_legacy_accent();
    config.normalize_game_folders();
    Ok(config)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Account {
    pub id: String,
    pub username: String,
    pub uuid: String,
    #[serde(rename = "type")]
    pub account_type: String,
    pub is_selected: bool,
    pub expires_at: Option<i64>,
    pub skin_url: Option<String>,
    pub skin_model: Option<String>,
    pub authlib_server: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub version_id: String,
    pub game_directory: String,
    pub created_at: String,
    pub last_played: Option<String>,
    pub category: String,
    pub icon_path: Option<String>,
    pub notes: String,
    pub max_memory_mb: Option<u32>,
    pub memory_mode: Option<String>,
    pub min_memory_mb: Option<u32>,
    pub java_path: Option<String>,
    pub jvm_arguments: Option<String>,
    pub game_proxy_mode: Option<String>,
    pub screen_width: Option<u32>,
    pub screen_height: Option<u32>,
    pub total_play_time: u64,
    pub loader: String,
    pub loader_version: String,
    /// "managed" for a launcher-owned folder, "version" for a folder under
    /// `<game folder>/versions/<name>/`. Empty on records written before the
    /// version-folder model; treated as a managed instance.
    pub kind: String,
    /// The configured game folder a version-folder instance belongs to.
    pub game_folder: String,
    /// The instance has its own game directory instead of sharing the game
    /// folder root. Decided once when the record is created.
    pub isolated: bool,
    /// Removed from the visible list without touching any file.
    pub hidden: bool,
    /// The version folder (or its whole game folder) was missing at the last
    /// scan. Kept for 30 days so it reappears with its settings.
    pub folder_missing_since: Option<String>,
    /// Why the folder exists but cannot be launched right now, as a stable
    /// reason code ("baseMissing", "invalidMainClass", "loaderDamaged",
    /// "metadataInvalid"). A missing profile is `folder_missing_since`, not
    /// this: folders with worlds are never purged just because launching fails.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<String>,
    /// The installed loader profile an instance was published from. Its folder
    /// stays on disk but is hidden from the library unless the user restores it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub derived_from: Option<String>,
}

impl Instance {
    /// A record created by scanning `<game folder>/versions/<name>/`.
    pub fn is_version_folder(&self) -> bool {
        self.kind == "version"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Persisted {
    pub schema_version: u32,
    #[serde(deserialize_with = "deserialize_config")]
    pub config: Config,
    pub accounts: Vec<Account>,
    #[serde(skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub pending_credential_removals: std::collections::BTreeSet<String>,
    pub instances: Vec<Instance>,
    /// SHA-256 of version profiles Voxelight wrote itself, keyed by the
    /// canonical path of the profile file. A matching hash means the launch
    /// path may trust the file as launcher-owned metadata.
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub owned_profiles: std::collections::BTreeMap<String, String>,
    /// The highest stable launcher version any update source has reported, so a
    /// source frozen on an older release is noticed (never offered).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_highest_seen: Option<String>,
    /// The highest launcher version seen on the beta update channel, tracked
    /// separately so switching back to stable never flags a stable release as stale.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_highest_seen_beta: Option<String>,
}

impl Default for Persisted {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            config: Config::default(),
            accounts: Vec::new(),
            pending_credential_removals: Default::default(),
            instances: Vec::new(),
            owned_profiles: Default::default(),
            update_highest_seen: None,
            update_highest_seen_beta: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledVersion {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub installed: bool,
    pub launchable: bool,
    pub reason: Option<String>,
    /// A stable code for `reason`, so the interface can translate it and can
    /// keep showing a folder that exists but cannot launch.
    pub reason_code: Option<String>,
    pub java_major: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRuntime {
    pub path: String,
    pub version: String,
    pub major: u32,
    #[serde(rename = "is64bit")]
    pub is_64bit: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceProject {
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub author: String,
    pub project_type: String,
    pub versions: Vec<String>,
    pub external_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceVersion {
    pub id: String,
    pub name: String,
    pub version_number: String,
    pub date_published: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub compatible: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDependency {
    pub project_id: String,
    pub kind: String,
    pub name: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceProjectDetails {
    pub project: ResourceProject,
    pub versions: Vec<ResourceVersion>,
    pub dependencies: Vec<ResourceDependency>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub level: String,
    pub message: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub task_id: String,
    pub operation: String,
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub bytes_completed: u64,
    pub bytes_total: u64,
    pub message: String,
    pub version_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub version_id: String,
    pub downloaded: usize,
    pub reused: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub game_id: String,
    pub pid: u32,
    pub version_id: String,
    pub game_directory: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_defaults_to_system_for_new_and_missing_preferences() {
        assert_eq!(Config::default().theme, "system");
        let missing: Config = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(missing.theme, "system");
    }

    #[test]
    fn theme_deserialization_preserves_explicit_light_and_dark_preferences() {
        for theme in ["light", "dark"] {
            let config: Config =
                serde_json::from_value(serde_json::json!({ "theme": theme })).unwrap();
            assert_eq!(config.theme, theme);
        }
    }

    #[test]
    fn default_skin_is_steve_and_old_configs_remain_compatible() {
        let config = Config::default();
        assert_eq!(config.default_skin, "steve");
        assert_eq!(
            serde_json::to_value(&config).unwrap()["defaultSkin"],
            "steve"
        );

        let mut old_config = serde_json::to_value(&config).unwrap();
        old_config.as_object_mut().unwrap().remove("defaultSkin");
        let decoded: Config = serde_json::from_value(old_config).unwrap();
        assert_eq!(decoded.default_skin, "steve");
    }

    #[test]
    fn u1_the_first_run_tour_is_remembered_and_older_profiles_have_not_seen_it() {
        let mut config = Config::default();
        assert!(!config.tour_completed);
        let mut old_config = serde_json::to_value(&config).unwrap();
        old_config.as_object_mut().unwrap().remove("tourCompleted");
        assert!(!serde_json::from_value::<Config>(old_config).unwrap().tour_completed);
        config.tour_completed = true;
        let saved = serde_json::to_value(&config).unwrap();
        assert_eq!(saved["tourCompleted"], true);
        assert!(serde_json::from_value::<Config>(saved).unwrap().tour_completed);
    }

    #[test]
    fn visual_preferences_have_consistent_defaults() {
        let config = Config::default();
        assert_eq!(config.theme, "system");
        assert_eq!(config.effects, "full");
        assert_eq!(config.accent_source, "system");
        assert_eq!(config.accent_color, DEFAULT_ACCENT_COLOR);
        assert_eq!(config.accent_color, "#0078d4");
        assert_eq!(config.language, "system");
        assert_eq!(config.proxy_mode, "system");
        assert_eq!(config.game_proxy_mode, "system");
        assert!(!config.sound_enabled);
    }

    #[test]
    fn old_brand_accent_migrates_for_system_source_on_load() {
        let persisted: Persisted = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "config": {
                "accentSource": "system",
                "accentColor": "#b4f17a"
            }
        }))
        .unwrap();
        assert_eq!(persisted.config.accent_source, "system");
        assert_eq!(persisted.config.accent_color, DEFAULT_ACCENT_COLOR);

        // Older files had no source at all; the default source is system, so
        // the old brand green is still only a picker starting value.
        let legacy: Persisted = serde_json::from_value(serde_json::json!({
            "config": { "accentColor": "#B4F17A" }
        }))
        .unwrap();
        assert_eq!(legacy.config.accent_source, "system");
        assert_eq!(legacy.config.accent_color, DEFAULT_ACCENT_COLOR);
    }

    #[test]
    fn the_retired_voxelight_source_follows_the_system_accent() {        let persisted: Persisted = serde_json::from_value(serde_json::json!({
            "config": {
                "accentSource": "voxelight",
                "accentColor": "#b4f17a"
            }
        }))
        .unwrap();
        assert_eq!(persisted.config.accent_source, "system");
        assert_eq!(persisted.config.accent_color, DEFAULT_ACCENT_COLOR);
    }

    #[test]
    fn a_users_saved_custom_green_is_preserved() {
        let persisted: Persisted = serde_json::from_value(serde_json::json!({
            "config": {
                "accentSource": "custom",
                "accentColor": "#b4f17a"
            }
        }))
        .unwrap();
        assert_eq!(persisted.config.accent_source, "custom");
        assert_eq!(persisted.config.accent_color, "#b4f17a");

        let mut config = Config {
            accent_source: "custom".into(),
            accent_color: "#b4f17a".into(),
            ..Default::default()
        };
        config.migrate_legacy_accent();
        assert_eq!(config.accent_color, "#b4f17a");
    }

    #[test]
    fn a_non_brand_system_picker_start_is_not_rewritten() {
        let persisted: Persisted = serde_json::from_value(serde_json::json!({
            "config": {
                "accentSource": "system",
                "accentColor": "#123456"
            }
        }))
        .unwrap();
        assert_eq!(persisted.config.accent_color, "#123456");
    }

    #[test]
    fn ambient_and_background_preferences_default_and_round_trip_via_camelcase() {
        let config = Config::default();
        assert!(config.ambient_light_enabled);
        assert_eq!(config.ambient_light_intensity, 60);
        assert_eq!(config.background_blur, 8);
        assert_eq!(config.background_dim, 35);
        assert!(!config.background_drift);

        let empty: Config = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(empty.ambient_light_enabled);
        assert_eq!(empty.ambient_light_intensity, 60);
        assert_eq!(empty.background_blur, 8);
        assert_eq!(empty.background_dim, 35);
        assert!(!empty.background_drift);

        let mut old_json = serde_json::to_value(&config).unwrap();
        let obj = old_json.as_object_mut().unwrap();
        for key in [
            "ambientLightEnabled",
            "ambientLightIntensity",
            "backgroundBlur",
            "backgroundDim",
            "backgroundDrift",
        ] {
            obj.remove(key);
        }
        let legacy: Config = serde_json::from_value(old_json).unwrap();
        assert!(legacy.ambient_light_enabled);
        assert_eq!(legacy.ambient_light_intensity, 60);
        assert_eq!(legacy.background_blur, 8);
        assert_eq!(legacy.background_dim, 35);
        assert!(!legacy.background_drift);

        let custom: Config = serde_json::from_value(serde_json::json!({
            "ambientLightEnabled": false,
            "ambientLightIntensity": 85,
            "backgroundBlur": 16,
            "backgroundDim": 50,
            "backgroundDrift": true,
        }))
        .unwrap();
        assert!(!custom.ambient_light_enabled);
        assert_eq!(custom.ambient_light_intensity, 85);
        assert_eq!(custom.background_blur, 16);
        assert_eq!(custom.background_dim, 50);
        assert!(custom.background_drift);

        let serialized = serde_json::to_value(&custom).unwrap();
        assert_eq!(serialized["ambientLightEnabled"], false);
        assert_eq!(serialized["ambientLightIntensity"], 85);
        assert_eq!(serialized["backgroundBlur"], 16);
        assert_eq!(serialized["backgroundDim"], 50);
        assert_eq!(serialized["backgroundDrift"], true);
    }

    #[test]
    fn a_legacy_single_game_directory_becomes_the_active_folder() {
        let persisted: Persisted = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "config": { "gameDirectory": "D:/Legacy/.minecraft", "maxMemoryMb": 2048 }
        }))
        .unwrap();
        assert_eq!(persisted.config.game_directory, "D:/Legacy/.minecraft");
        assert_eq!(persisted.config.game_folders.len(), 1);
        assert_eq!(persisted.config.game_folders[0].path, "D:/Legacy/.minecraft");
        assert!(persisted.config.game_folders[0].active);
        assert_eq!(persisted.config.max_memory_mb, 2048, "nothing else is lost");
    }

    #[test]
    fn several_game_folders_keep_exactly_one_active_mirroring_game_directory() {
        let mut config = Config {
            game_directory: "C:/A".into(),
            game_folders: vec![
                GameFolder { path: "C:/A".into(), label: "Vanilla".into(), active: false },
                GameFolder { path: "D:/B".into(), label: "PCL".into(), active: true },
                GameFolder { path: "D:/B".into(), label: "duplicate".into(), active: false },
            ],
            ..Default::default()
        };
        assert!(config.normalize_game_folders());
        assert_eq!(config.game_directory, "C:/A");
        assert_eq!(config.game_folders.len(), 2);
        assert!(config.game_folders[0].active);
        assert!(!config.game_folders[1].active);
        assert_eq!(config.game_folder_roots(), vec!["C:/A", "D:/B"]);
        config.game_directory = "D:/B".into();
        assert!(config.normalize_game_folders());
        assert!(config.game_folders[1].active);
        assert_eq!(config.game_folder_label("D:/B"), "PCL");
        // An unknown path joins the list instead of replacing it.
        config.game_directory = "E:/HMCL".into();
        assert!(config.normalize_game_folders());
        assert_eq!(config.game_folders.len(), 3);
        assert_eq!(config.game_folders[2].path, "E:/HMCL");
        assert!(config.game_folders[2].active);
    }
}
