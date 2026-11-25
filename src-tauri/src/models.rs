use serde::{Deserialize, Serialize};

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

fn legacy_memory_mode() -> String {
    "manual".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub game_directory: String,
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
    pub java_auto_download: bool,
    /// Check for launcher updates in the background after start (HSR default: on).
    pub check_for_updates: bool,
    /// "auto" (GitHub and Gitee at once), "github" or "gitee".
    pub update_source: String,
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
        Self {
            game_directory: std::env::var("VOXELIGHT_LAUNCHER_GAME_DIR")
                .or_else(|_| std::env::var("MINECRAFT_LAUNCHER_GAME_DIR"))
                .unwrap_or_else(|_| {
                    dirs::config_dir()
                        .unwrap_or_else(|| ".".into())
                        .join(".minecraft")
                        .to_string_lossy()
                        .into()
                }),
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
            accent_color: "#b4f17a".into(),
            effects: "full".into(),
            world_scene: "horizon".into(),
            world_material: "lattice".into(),
            accent_source: "system".into(),
            sound_enabled: false,
            custom_background: None,
            java_auto_download: true,
            check_for_updates: true,
            update_source: "auto".into(),
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Persisted {
    pub schema_version: u32,
    pub config: Config,
    pub accounts: Vec<Account>,
    #[serde(skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub pending_credential_removals: std::collections::BTreeSet<String>,
    pub instances: Vec<Instance>,
    /// The highest launcher version any update source has reported, so a
    /// source frozen on an older release is noticed (never offered).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_highest_seen: Option<String>,
}

impl Default for Persisted {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            config: Config::default(),
            accounts: Vec::new(),
            pending_credential_removals: Default::default(),
            instances: Vec::new(),
            update_highest_seen: None,
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
        assert_eq!(config.language, "system");
        assert_eq!(config.proxy_mode, "system");
        assert_eq!(config.game_proxy_mode, "system");
        assert!(!config.sound_enabled);
    }
}
