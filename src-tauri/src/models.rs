use serde::{Deserialize, Serialize};

pub const CURRENT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub game_directory: String,
    pub java_path: String,
    pub max_memory_mb: u32,
    pub jvm_arguments: String,
    pub version_isolation: bool,
    pub theme: String,
    pub download_concurrency: usize,
    pub microsoft_client_id: String,
    pub download_limit_kib: u64,
    pub download_source: String,
    pub screen_width: u32,
    pub screen_height: u32,
    pub language: String,
    pub accent_color: String,
    pub effects: String,
    pub accent_source: String,
    pub sound_enabled: bool,
    pub custom_background: Option<String>,
    pub java_auto_download: bool,
    pub default_skin: String,
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
            jvm_arguments: "-XX:+UseG1GC".into(),
            version_isolation: true,
            theme: "dark".into(),
            download_concurrency: 8,
            microsoft_client_id: String::new(),
            download_limit_kib: 0,
            download_source: "official".into(),
            screen_width: 1280,
            screen_height: 720,
            language: "system".into(),
            accent_color: "#b4f17a".into(),
            effects: "full".into(),
            accent_source: "system".into(),
            sound_enabled: false,
            custom_background: None,
            java_auto_download: true,
            default_skin: "steve".into(),
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
    pub java_path: Option<String>,
    pub jvm_arguments: Option<String>,
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
    pub instances: Vec<Instance>,
}

impl Default for Persisted {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            config: Config::default(),
            accounts: Vec::new(),
            instances: Vec::new(),
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
    pub pid: u32,
    pub version_id: String,
    pub game_directory: String,
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn visual_preferences_have_consistent_defaults() {
        let config = Config::default();
        assert_eq!(config.effects, "full");
        assert_eq!(config.accent_source, "system");
        assert_eq!(config.language, "system");
        assert!(!config.sound_enabled);
    }
}
