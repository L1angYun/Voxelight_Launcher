//! Curated launcher tools exposed to Lumen (the built-in assistant) and the local MCP server.
//! Every tool operates strictly through existing validated launcher state and helpers:
//! never arbitrary shell commands, never arbitrary filesystem paths, never stored secrets,
//! and never destructive file/world/account/instance deletions.

use crate::{
    processes::GameRegistry,
    server_manager::ServerRegistry,
    storage::LauncherState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionTier {
    ReadOnly,
    Controlled,
    FullAccess,
}

impl PermissionTier {
    pub fn parse(value: &str) -> Self {
        match value {
            "controlled" => Self::Controlled,
            "fullAccess" => Self::FullAccess,
            _ => Self::ReadOnly,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "readOnly",
            Self::Controlled => "controlled",
            Self::FullAccess => "fullAccess",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolTier {
    ReadOnly,
    Controlled,
}

impl ToolTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "readOnly",
            Self::Controlled => "controlled",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub tier: ToolTier,
    pub input_schema: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSummary {
    pub name: String,
    pub description: String,
    pub tier: String,
}

#[derive(Clone)]
pub struct ToolContext {
    pub state: Arc<LauncherState>,
    pub games: Arc<GameRegistry>,
    pub servers: Arc<ServerRegistry>,
    pub app: Option<tauri::AppHandle>,
    pub mcp_port: Option<u16>,
}

#[derive(Debug)]
pub enum ToolExecError {
    UnknownTool(String),
    PermissionDenied(String),
    Failed(String),
}

impl ToolExecError {
    pub fn message(&self) -> &str {
        match self {
            Self::UnknownTool(msg) | Self::PermissionDenied(msg) | Self::Failed(msg) => msg,
        }
    }
}

pub fn catalog() -> Vec<ToolSpec> {
    vec![
        // ---- Read-only tools (22) ----
        ToolSpec {
            name: "list_instances",
            description: "List all configured Minecraft instances in Voxelight Launcher (name, version, loader, category, play time, notes, runtime overrides).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "list_installed_versions",
            description: "List installed Minecraft version directories detected in the configured game directory.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "list_accounts",
            description: "List configured player accounts (username, account type, and active selection; never tokens or credentials).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "get_launcher_config",
            description: "Read non-secret launcher settings (game directory, memory mode/limits, download source, proxy modes, appearance preferences, update source).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "get_memory_overview",
            description: "Read system physical RAM, available RAM, effective allocation mode, and recommended memory (MB) globally or for a specific instance.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string", "description": "Optional registered instance ID." }
                },
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "detect_java_runtimes",
            description: "Detect installed Java runtimes available on this machine (path, version, major version, 64-bit flag).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "list_remote_versions",
            description: "Query the official Minecraft version manifest with optional category and search query filters.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "category": { "type": "string", "enum": ["release", "snapshot", "old_beta", "old_alpha"] },
                    "query": { "type": "string", "description": "Optional substring filter on version ID." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 30 }
                },
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_loader_versions",
            description: "List available mod loader versions (fabric, quilt, forge, neoforge, optifine) for a Minecraft game version.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "loader": { "type": "string", "enum": ["fabric", "quilt", "forge", "neoforge", "optifine"] },
                    "gameVersion": { "type": "string", "description": "Base Minecraft version, e.g. 1.21.1." },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 30 }
                },
                "required": ["loader", "gameVersion"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_download_tasks",
            description: "List active and recent download or installation tasks with status, stage, error, and retryability.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "list_running_games",
            description: "List Minecraft game processes currently running and managed by Voxelight Launcher.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "list_instance_resources",
            description: "List local mods, resource packs, or shader packs installed inside a registered instance.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "resourceType": { "type": "string", "enum": ["mod", "resourcepack", "shader"] }
                },
                "required": ["instanceId", "resourceType"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_instance_worlds",
            description: "List saved Minecraft worlds inside a registered instance (folder name, display name, version, game mode, size, last played).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": { "instanceId": { "type": "string" } },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_world_datapacks",
            description: "List data packs inside a specific world of a registered instance.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "worldFolder": { "type": "string", "description": "World folder name from list_instance_worlds." }
                },
                "required": ["instanceId", "worldFolder"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_instance_backups",
            description: "List existing verified backups for a registered instance.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": { "instanceId": { "type": "string" } },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "read_instance_log",
            description: "Read the redacted tail of logs/latest.log for a registered instance.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "maxLines": { "type": "integer", "minimum": 1, "maximum": 200 }
                },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "diagnose_instance",
            description: "Run Voxelight's crash and log classifier on a registered instance and return the redacted excerpt.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": { "instanceId": { "type": "string" } },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "search_modrinth",
            description: "Search Modrinth for mods, resource packs, shaders, or modpacks by query, version, and loader.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "projectType": { "type": "string", "enum": ["mod", "resourcepack", "shader", "modpack"] },
                    "gameVersion": { "type": "string" },
                    "loader": { "type": "string", "enum": ["fabric", "forge", "neoforge", "quilt"] },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
                },
                "required": ["query", "projectType"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_multiplayer_servers",
            description: "List saved multiplayer server bookmarks (servers.dat) for a registered instance.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": { "instanceId": { "type": "string" } },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_managed_servers",
            description: "List managed local Minecraft servers (name, version, software, port, EULA status, running status).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "read_managed_server_logs",
            description: "Read recent redacted console log lines from a managed local server.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                },
                "required": ["serverId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "check_network_environment",
            description: "Run the on-demand STUN multiplayer network check (IPv4/IPv6 reachability, NAT mapping type, CGNAT suspicion, direct-connect advice).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },

        ToolSpec {
            name: "detect_local_proxies",
            description: "Inspect the Windows system proxy, environment proxy variables, and local loopback HTTP proxy listeners (e.g. Clash/v2rayN) without reading credentials.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },

        // ---- Controlled write tools (17) ----
        ToolSpec {
            name: "toggle_instance_resource",
            description: "Enable or disable a specific mod, resource pack, or shader pack file in a registered stopped instance.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "resourceType": { "type": "string", "enum": ["mod", "resourcepack", "shader"] },
                    "fileName": { "type": "string" }
                },
                "required": ["instanceId", "resourceType", "fileName"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "toggle_world_datapack",
            description: "Enable or disable a data pack inside a world of a registered stopped instance.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "worldFolder": { "type": "string" },
                    "fileName": { "type": "string" }
                },
                "required": ["instanceId", "worldFolder", "fileName"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "create_instance",
            description: "Create a new instance using an already-installed Minecraft version ID.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "versionId": { "type": "string" }
                },
                "required": ["name", "versionId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "update_instance_notes",
            description: "Update the notes and/or category metadata of a registered instance.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "notes": { "type": "string" },
                    "category": { "type": "string" }
                },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "update_instance_settings",
            description: "Update safe runtime settings of a registered instance (name, category, notes, memory mode/limits, window size, game proxy mode, or reset overrides).",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "name": { "type": "string" },
                    "category": { "type": "string" },
                    "notes": { "type": "string" },
                    "memoryMode": { "type": "string", "enum": ["inherit", "auto", "manual"] },
                    "maxMemoryMb": { "type": "integer", "minimum": 512, "maximum": 65536 },
                    "minMemoryMb": { "type": "integer", "minimum": 256, "maximum": 65536 },
                    "clearMinMemory": { "type": "boolean" },
                    "screenWidth": { "type": "integer", "minimum": 320, "maximum": 16384 },
                    "screenHeight": { "type": "integer", "minimum": 240, "maximum": 16384 },
                    "gameProxyMode": { "type": "string", "enum": ["default", "system", "off", "launcher"] },
                    "resetRuntime": { "type": "boolean" }
                },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "backup_instance",
            description: "Create a verified backup archive of a registered stopped instance.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": { "instanceId": { "type": "string" } },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "clone_instance",
            description: "Clone a registered stopped instance into a new instance with a new name.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["instanceId", "name"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "change_instance_loader",
            description: "Change the mod loader of an existing stopped instance (vanilla, fabric, quilt, forge, neoforge, optifine) while preserving its worlds and mods.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "loader": { "type": "string", "enum": ["vanilla", "fabric", "quilt", "forge", "neoforge", "optifine"] },
                    "loaderVersion": { "type": "string" }
                },
                "required": ["instanceId", "loader"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "install_minecraft_version",
            description: "Download and install an official Minecraft game version ID into the game directory.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": { "versionId": { "type": "string" } },
                "required": ["versionId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "install_modrinth_resource",
            description: "Install a Modrinth mod, resource pack, or shader pack (plus required dependencies) into a registered stopped instance.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "projectId": { "type": "string" },
                    "resourceType": { "type": "string", "enum": ["mod", "resourcepack", "shader"] },
                    "resourceVersionId": { "type": "string" }
                },
                "required": ["instanceId", "projectId", "resourceType"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "launch_instance",
            description: "Launch a registered Minecraft instance using the currently selected player account, optionally joining a server address.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "serverAddress": { "type": "string" }
                },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "stop_running_game",
            description: "Request a graceful stop of a Minecraft process currently managed by Voxelight Launcher.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": { "gameId": { "type": "string" } },
                "required": ["gameId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "retry_failed_downloads",
            description: "Queue retries for all retryable failed download tasks.",
            tier: ToolTier::Controlled,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "clear_unfinished_downloads",
            description: "Clear failed and cancelled download history entries and unreferenced partial files when idle.",
            tier: ToolTier::Controlled,
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolSpec {
            name: "save_multiplayer_server",
            description: "Add a multiplayer server bookmark to a registered instance's servers.dat.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "name": { "type": "string" },
                    "address": { "type": "string" },
                    "hideAddress": { "type": "boolean" }
                },
                "required": ["instanceId", "name", "address"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "start_managed_server",
            description: "Start a managed local Minecraft server whose EULA has already been accepted.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": { "serverId": { "type": "string" } },
                "required": ["serverId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "stop_managed_server",
            description: "Gracefully stop a running managed local Minecraft server.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": { "serverId": { "type": "string" } },
                "required": ["serverId"],
                "additionalProperties": false
            }),
        },
    ]
}

pub fn find_tool(name: &str) -> Option<ToolSpec> {
    catalog().into_iter().find(|spec| spec.name == name)
}

pub fn summaries() -> Vec<ToolSummary> {
    catalog()
        .into_iter()
        .map(|spec| ToolSummary {
            name: spec.name.to_owned(),
            description: spec.description.to_owned(),
            tier: spec.tier.as_str().to_owned(),
        })
        .collect()
}

/// Tools offered to Lumen according to the active permission tier.
pub fn catalog_for_assistant(permission: PermissionTier) -> Vec<ToolSpec> {
    catalog()
        .into_iter()
        .filter(|spec| match permission {
            PermissionTier::ReadOnly => spec.tier == ToolTier::ReadOnly,
            PermissionTier::Controlled | PermissionTier::FullAccess => true,
        })
        .collect()
}

/// External MCP clients can invoke write tools only when Full access is explicitly enabled.
pub fn catalog_for_mcp(permission: PermissionTier) -> Vec<ToolSpec> {
    catalog()
        .into_iter()
        .filter(|spec| match permission {
            PermissionTier::FullAccess => true,
            PermissionTier::ReadOnly | PermissionTier::Controlled => {
                spec.tier == ToolTier::ReadOnly
            }
        })
        .collect()
}

fn require_string(args: &Value, key: &str) -> Result<String, ToolExecError> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ToolExecError::Failed(format!("Missing required string parameter '{key}'.")))
}

fn optional_string(args: &Value, key: &str) -> Result<Option<String>, ToolExecError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(ToolExecError::Failed(format!("Parameter '{key}' must be a string."))),
    }
}

fn optional_u32(args: &Value, key: &str) -> Result<Option<u32>, ToolExecError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .map(Some)
            .ok_or_else(|| ToolExecError::Failed(format!("Parameter '{key}' must be a positive integer."))),
        _ => Err(ToolExecError::Failed(format!("Parameter '{key}' must be an integer."))),
    }
}

fn optional_bool(args: &Value, key: &str) -> Result<bool, ToolExecError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(ToolExecError::Failed(format!("Parameter '{key}' must be a boolean."))),
    }
}

fn registered_instance(
    state: &LauncherState,
    instance_id: &str,
) -> Result<crate::models::Instance, ToolExecError> {
    let data = state.snapshot().map_err(ToolExecError::Failed)?;
    data.instances
        .into_iter()
        .find(|item| item.id == instance_id)
        .ok_or_else(|| ToolExecError::Failed(format!("Instance '{instance_id}' not found.")))
}

fn require_app(ctx: &ToolContext) -> Result<&tauri::AppHandle, ToolExecError> {
    ctx.app
        .as_ref()
        .ok_or_else(|| ToolExecError::Failed("This action requires the running desktop launcher window.".into()))
}

pub async fn execute_tool(
    ctx: &ToolContext,
    name: &str,
    arguments: &Value,
    permission: PermissionTier,
    explicitly_approved: bool,
) -> Result<Value, ToolExecError> {
    let spec = find_tool(name)
        .ok_or_else(|| ToolExecError::UnknownTool(format!("Unknown tool '{name}'.")))?;
    if !arguments.is_object() && !arguments.is_null() {
        return Err(ToolExecError::Failed(
            "Tool arguments must be a JSON object.".into(),
        ));
    }
    let args = if arguments.is_null() {
        &json!({})
    } else {
        arguments
    };

    if spec.tier == ToolTier::Controlled {
        match permission {
            PermissionTier::ReadOnly => {
                return Err(ToolExecError::PermissionDenied(format!(
                    "Tool '{name}' modifies launcher state and is blocked in Read-only mode."
                )));
            }
            PermissionTier::Controlled if !explicitly_approved => {
                return Err(ToolExecError::PermissionDenied(format!(
                    "Tool '{name}' requires explicit user approval in Controlled mode."
                )));
            }
            PermissionTier::Controlled | PermissionTier::FullAccess => {}
        }
    }

    match name {
        "list_instances" => {
            let data = ctx.state.snapshot().map_err(ToolExecError::Failed)?;
            let instances: Vec<Value> = data
                .instances
                .iter()
                .map(|item| {
                    json!({
                        "id": item.id,
                        "name": item.name,
                        "versionId": item.version_id,
                        "loader": item.loader,
                        "loaderVersion": item.loader_version,
                        "category": item.category,
                        "lastPlayed": item.last_played,
                        "totalPlayTimeSeconds": item.total_play_time,
                        "notes": item.notes,
                        "memoryMode": item.memory_mode,
                        "maxMemoryMb": item.max_memory_mb,
                        "minMemoryMb": item.min_memory_mb,
                        "gameProxyMode": item.game_proxy_mode,
                    })
                })
                .collect();
            Ok(json!({ "count": instances.len(), "instances": instances }))
        }
        "list_installed_versions" => {
            let config = ctx.state.snapshot().map_err(ToolExecError::Failed)?.config;
            let versions =
                tokio::task::spawn_blocking(move || crate::minecraft::scan_versions(&config))
                    .await
                    .map_err(|error| ToolExecError::Failed(format!("Version scan failed: {error}")))?;
            Ok(json!({ "count": versions.len(), "versions": versions }))
        }
        "list_accounts" => {
            let data = ctx.state.snapshot().map_err(ToolExecError::Failed)?;
            let accounts: Vec<Value> = data
                .accounts
                .iter()
                .map(|account| {
                    json!({
                        "id": account.id,
                        "username": account.username,
                        "type": account.account_type,
                        "isSelected": account.is_selected,
                    })
                })
                .collect();
            Ok(json!({ "count": accounts.len(), "accounts": accounts }))
        }
        "get_launcher_config" => {
            let config = ctx.state.snapshot().map_err(ToolExecError::Failed)?.config;
            Ok(json!({
                "gameDirectory": config.game_directory,
                "memoryMode": config.memory_mode,
                "maxMemoryMb": config.max_memory_mb,
                "minMemoryMb": config.min_memory_mb,
                "versionIsolation": config.version_isolation,
                "downloadSource": config.download_source,
                "downloadConcurrency": config.download_concurrency,
                "downloadLimitKib": config.download_limit_kib,
                "proxyMode": config.proxy_mode,
                "gameProxyMode": config.game_proxy_mode,
                "screenWidth": config.screen_width,
                "screenHeight": config.screen_height,
                "theme": config.theme,
                "language": config.language,
                "effects": config.effects,
                "worldScene": config.world_scene,
                "worldMaterial": config.world_material,
                "accentSource": config.accent_source,
                "javaAutoDownload": config.java_auto_download,
                "checkForUpdates": config.check_for_updates,
                "updateSource": config.update_source,
                "assistantPermission": config.assistant_permission,
            }))
        }
        "get_memory_overview" => {
            let instance_id = optional_string(args, "instanceId")?
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
            let overview = crate::memory::memory_overview_for_state(&ctx.state, instance_id)
                .await
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(overview)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "detect_java_runtimes" => {
            let config = ctx.state.snapshot().map_err(ToolExecError::Failed)?.config;
            let runtimes = crate::minecraft::detect_java(&config, &ctx.state.data_dir).await;
            Ok(json!({ "count": runtimes.len(), "runtimes": runtimes }))
        }
        "list_remote_versions" => {
            let category = optional_string(args, "category")?;
            let query = optional_string(args, "query")?
                .map(|q| q.trim().to_ascii_lowercase())
                .filter(|q| !q.is_empty());
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .clamp(1, 30) as usize;
            let manifest = crate::minecraft::list_versions(&ctx.state)
                .await
                .map_err(ToolExecError::Failed)?;
            let mut filtered: Vec<Value> = manifest["versions"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|item| {
                    let type_ok = category
                        .as_deref()
                        .is_none_or(|cat| item["type"].as_str() == Some(cat));
                    let query_ok = query.as_deref().is_none_or(|q| {
                        item["id"]
                            .as_str()
                            .is_some_and(|id| id.to_ascii_lowercase().contains(q))
                    });
                    type_ok && query_ok
                })
                .take(limit)
                .map(|item| {
                    json!({
                        "id": item["id"],
                        "type": item["type"],
                        "releaseTime": item["releaseTime"],
                    })
                })
                .collect();
            filtered.truncate(limit);
            Ok(json!({
                "latestRelease": manifest["latestRelease"],
                "latestSnapshot": manifest["latestSnapshot"],
                "count": filtered.len(),
                "versions": filtered,
            }))
        }
        "list_loader_versions" => {
            let loader = require_string(args, "loader")?;
            let game_version = require_string(args, "gameVersion")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(15)
                .clamp(1, 30) as usize;
            let mut versions = crate::loaders::loader_versions(&ctx.state, &loader, &game_version)
                .await
                .map_err(ToolExecError::Failed)?;
            versions.truncate(limit);
            Ok(json!({ "loader": loader, "gameVersion": game_version, "count": versions.len(), "versions": versions }))
        }
        "list_download_tasks" => {
            let snapshot = ctx.state.control.snapshot();
            serde_json::to_value(snapshot)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "list_running_games" => {
            let games = ctx.games.snapshot().map_err(ToolExecError::Failed)?;
            Ok(json!({ "count": games.len(), "games": games }))
        }
        "list_instance_resources" => {
            let instance_id = require_string(args, "instanceId")?;
            let resource_type = require_string(args, "resourceType")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let resources = crate::resources::list_local_resources_for_state(
                &ctx.state,
                instance.version_id,
                Some(instance.id),
                resource_type,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            Ok(json!({ "count": resources.len(), "resources": resources }))
        }
        "list_instance_worlds" => {
            let instance_id = require_string(args, "instanceId")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let worlds = crate::content::list_worlds_for_state(
                &ctx.state,
                instance.version_id,
                Some(instance.id),
            )
            .await
            .map_err(ToolExecError::Failed)?;
            let rows: Vec<Value> = worlds
                .iter()
                .map(|w| {
                    json!({
                        "folder": w.folder_name,
                        "name": w.name,
                        "version": w.version_name,
                        "gameMode": w.game_mode,
                        "hardcore": w.hardcore,
                        "lastPlayed": w.last_played,
                        "sizeBytes": w.size_bytes,
                    })
                })
                .collect();
            Ok(json!({ "count": rows.len(), "worlds": rows }))
        }
        "list_world_datapacks" => {
            let instance_id = require_string(args, "instanceId")?;
            let world_folder = require_string(args, "worldFolder")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let packs = crate::content::list_world_datapacks_for_state(
                &ctx.state,
                instance.version_id,
                Some(instance.id),
                world_folder,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            Ok(json!({ "count": packs.len(), "datapacks": packs }))
        }
        "list_instance_backups" => {
            let instance_id = require_string(args, "instanceId")?;
            let state = ctx.state.clone();
            let id = instance_id.clone();
            let history = tokio::task::spawn_blocking(move || {
                crate::instances::list_instance_backups_for_state(&state, &id)
            })
            .await
            .map_err(|error| ToolExecError::Failed(error.to_string()))?
            .map_err(ToolExecError::Failed)?;
            serde_json::to_value(history)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "read_instance_log" => {
            let instance_id = require_string(args, "instanceId")?;
            let max_lines = args
                .get("maxLines")
                .and_then(Value::as_u64)
                .unwrap_or(80)
                .clamp(1, 200) as usize;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let state = ctx.state.clone();
            let version_id = instance.version_id.clone();
            let id = instance.id.clone();
            let log = tokio::task::spawn_blocking(move || {
                crate::processes::read_game_log_inner(&state, &version_id, Some(&id))
            })
            .await
            .map_err(|error| ToolExecError::Failed(format!("Log read failed: {error}")))?
            .map_err(ToolExecError::Failed)?;
            let total = log.lines.len();
            let start = total.saturating_sub(max_lines);
            const MAX_LOG_CHARS: usize = 16_000;
            let mut budget = MAX_LOG_CHARS;
            let mut char_truncated = false;
            let mut selected_rev = Vec::new();
            for line in log.lines[start..].iter().rev() {
                let len = line.message.chars().count();
                if len <= budget {
                    budget -= len;
                    selected_rev.push(line.clone());
                } else {
                    char_truncated = true;
                    if selected_rev.is_empty() && budget > 0 {
                        let mut trimmed = line.clone();
                        let chars: Vec<char> = trimmed.message.chars().collect();
                        trimmed.message = chars[chars.len().saturating_sub(budget)..].iter().collect();
                        selected_rev.push(trimmed);
                    }
                    break;
                }
            }
            selected_rev.reverse();
            Ok(json!({
                "instanceId": instance_id,
                "hasLog": log.path.is_some(),
                "totalLines": total,
                "returnedLines": selected_rev.len(),
                "truncated": log.truncated || start > 0 || char_truncated,
                "lines": selected_rev,
            }))
        }
        "diagnose_instance" => {
            let instance_id = require_string(args, "instanceId")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let state = ctx.state.clone();
            let version_id = instance.version_id.clone();
            let id = instance.id.clone();
            let diagnosis = tokio::task::spawn_blocking(move || {
                crate::processes::diagnose_instance_inner(&state, version_id, Some(id))
            })
            .await
            .map_err(|error| ToolExecError::Failed(format!("Diagnosis failed: {error}")))?
            .map_err(ToolExecError::Failed)?;
            let mut value = serde_json::to_value(&diagnosis)
                .map_err(|error| ToolExecError::Failed(error.to_string()))?;
            if let Some(excerpt) = value.get("excerpt").and_then(Value::as_str) {
                let chars: Vec<char> = excerpt.chars().collect();
                if chars.len() > 8000 {
                    let tail: String = chars[chars.len() - 8000..].iter().collect();
                    value["excerpt"] = Value::String(tail);
                    value["excerptTruncated"] = Value::Bool(true);
                }
            }
            Ok(value)
        }
        "detect_local_proxies" => {
            let exclude: Vec<u16> = ctx.mcp_port.into_iter().collect();
            let report = crate::network::detect_local_proxies_inner(&exclude).await;
            serde_json::to_value(&report).map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "search_modrinth" => {
            let query = require_string(args, "query")?;
            let project_type = require_string(args, "projectType")?;
            let game_version = optional_string(args, "gameVersion")?;
            let loader = optional_string(args, "loader")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(10)
                .clamp(1, 20) as usize;
            crate::resources::search_modrinth_for_state(
                &ctx.state,
                &query,
                &project_type,
                game_version.as_deref(),
                loader.as_deref(),
                limit,
            )
            .await
            .map_err(ToolExecError::Failed)
        }
        "list_multiplayer_servers" => {
            let instance_id = require_string(args, "instanceId")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let state = ctx.state.clone();
            let version_id = instance.version_id.clone();
            let id = instance.id.clone();
            let list = tokio::task::spawn_blocking(move || {
                crate::servers::list_servers_for_state(&state, &version_id, Some(&id))
            })
            .await
            .map_err(|error| ToolExecError::Failed(error.to_string()))?
            .map_err(ToolExecError::Failed)?;
            Ok(json!({ "count": list.len(), "servers": list }))
        }
        "list_managed_servers" => {
            let state = ctx.state.clone();
            let servers = ctx.servers.clone();
            let list = tokio::task::spawn_blocking(move || {
                crate::server_manager::list_managed_servers_inner(&state, &servers)
            })
            .await
            .map_err(|error| ToolExecError::Failed(format!("Server scan failed: {error}")))?
            .map_err(ToolExecError::Failed)?;
            let rows: Vec<Value> = list
                .iter()
                .map(|server| {
                    json!({
                        "id": server.id,
                        "name": server.name,
                        "versionId": server.version_id,
                        "source": server.source,
                        "software": server.software,
                        "status": server.status,
                        "port": server.settings.port,
                        "eulaAccepted": server.eula_accepted,
                        "installed": server.installed,
                        "pid": server.pid,
                        "error": server.error,
                    })
                })
                .collect();
            Ok(json!({ "count": rows.len(), "servers": rows }))
        }
        "read_managed_server_logs" => {
            let server_id = require_string(args, "serverId")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .map(|v| v.clamp(1, 200) as usize);
            let state = ctx.state.clone();
            let servers = ctx.servers.clone();
            let rows = tokio::task::spawn_blocking(move || {
                crate::server_manager::read_managed_server_logs_for_state(
                    &state,
                    &servers,
                    &server_id,
                    limit,
                )
            })
            .await
            .map_err(|error| ToolExecError::Failed(error.to_string()))?
            .map_err(ToolExecError::Failed)?;
            Ok(json!({ "count": rows.len(), "logs": rows }))
        }
        "check_network_environment" => {
            let custom_proxy = ctx
                .state
                .snapshot()
                .map(|data| data.config.proxy_mode == "custom")
                .unwrap_or(false);
            let report = tokio::task::spawn_blocking(move || {
                crate::network_check::run_network_check_blocking(custom_proxy)
            })
            .await
            .map_err(|error| ToolExecError::Failed(error.to_string()))?;
            serde_json::to_value(report)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }

        // ---- Controlled write tools ----
        "toggle_instance_resource" => {
            let instance_id = require_string(args, "instanceId")?;
            let resource_type = require_string(args, "resourceType")?;
            let file_name = require_string(args, "fileName")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let updated = crate::resources::toggle_resource_for_state(
                &ctx.state,
                instance.version_id,
                Some(instance.id),
                resource_type,
                file_name,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            serde_json::to_value(updated)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "toggle_world_datapack" => {
            let instance_id = require_string(args, "instanceId")?;
            let world_folder = require_string(args, "worldFolder")?;
            let file_name = require_string(args, "fileName")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let updated = crate::content::toggle_world_datapack_for_state(
                &ctx.state,
                instance.version_id,
                Some(instance.id),
                world_folder,
                file_name,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            serde_json::to_value(updated)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "create_instance" => {
            let name = require_string(args, "name")?;
            let version_id = require_string(args, "versionId")?;
            let config = ctx.state.snapshot().map_err(ToolExecError::Failed)?.config;
            let version_check = version_id.clone();
            let installed = tokio::task::spawn_blocking(move || {
                crate::minecraft::scan_versions(&config)
                    .into_iter()
                    .any(|item| item.id == version_check && item.installed)
            })
            .await
            .map_err(|error| ToolExecError::Failed(format!("Version scan failed: {error}")))?;
            if !installed {
                return Err(ToolExecError::Failed(format!(
                    "Version '{version_id}' is not installed locally. Install it first before creating an instance."
                )));
            }
            let _operation = ctx.state.operation.lock().await;
            let created = crate::commands::create_instance_inner(&ctx.state, name, version_id)
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(created)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "update_instance_notes" => {
            let instance_id = require_string(args, "instanceId")?;
            let notes = optional_string(args, "notes")?;
            let category = optional_string(args, "category")?;
            let updated = crate::instances::update_instance_notes_inner(
                &ctx.state,
                &instance_id,
                notes,
                category,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            serde_json::to_value(updated)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "update_instance_settings" => {
            let instance_id = require_string(args, "instanceId")?;
            let updated = crate::instances::update_instance_safe_settings(
                &ctx.state,
                &instance_id,
                optional_string(args, "name")?,
                optional_string(args, "category")?,
                optional_string(args, "notes")?,
                optional_string(args, "memoryMode")?,
                optional_u32(args, "maxMemoryMb")?,
                optional_u32(args, "minMemoryMb")?,
                optional_bool(args, "clearMinMemory")?,
                optional_u32(args, "screenWidth")?,
                optional_u32(args, "screenHeight")?,
                optional_string(args, "gameProxyMode")?,
                optional_bool(args, "resetRuntime")?,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            serde_json::to_value(updated)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "backup_instance" => {
            let instance_id = require_string(args, "instanceId")?;
            let backup = crate::instances::backup_instance_for_state(&ctx.state, instance_id)
                .await
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(backup)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "clone_instance" => {
            let instance_id = require_string(args, "instanceId")?;
            let name = require_string(args, "name")?;
            let cloned = crate::instances::clone_instance_for_state(&ctx.state, instance_id, name)
                .await
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(cloned)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "change_instance_loader" => {
            let app = require_app(ctx)?;
            let instance_id = require_string(args, "instanceId")?;
            let loader = require_string(args, "loader")?;
            let loader_version = optional_string(args, "loaderVersion")?;
            let updated = crate::instances::change_instance_loader_for_state(
                app,
                &ctx.state,
                &instance_id,
                &loader,
                loader_version,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            serde_json::to_value(updated)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "install_minecraft_version" => {
            let app = require_app(ctx)?;
            let version_id = require_string(args, "versionId")?;
            let installed = crate::commands::install_version_for_state(app, &ctx.state, version_id)
                .await
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(installed)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "install_modrinth_resource" => {
            let app = require_app(ctx)?;
            let instance_id = require_string(args, "instanceId")?;
            let project_id = require_string(args, "projectId")?;
            let resource_type = require_string(args, "resourceType")?;
            let resource_version_id = optional_string(args, "resourceVersionId")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let installed = crate::resources::install_modrinth_for_state(
                app,
                &ctx.state,
                project_id,
                instance.version_id,
                instance.id,
                resource_type,
                resource_version_id,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            serde_json::to_value(installed)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "launch_instance" => {
            let app = require_app(ctx)?;
            let instance_id = require_string(args, "instanceId")?;
            let server_address = optional_string(args, "serverAddress")?;
            let launched = crate::commands::launch_instance_for_state(
                app,
                &ctx.state,
                &instance_id,
                server_address,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            serde_json::to_value(launched)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "stop_running_game" => {
            let game_id = require_string(args, "gameId")?;
            let result = crate::processes::stop_game_graceful(&ctx.games, &game_id)
                .await
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(result)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "retry_failed_downloads" => {
            let app = require_app(ctx)?.clone();
            let result = crate::downloads::retry_failed_downloads_for_state(app, &ctx.state)
                .await
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(result)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "clear_unfinished_downloads" => {
            let result = crate::downloads::clear_unfinished_downloads_for_state(&ctx.state)
                .await
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(result)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "save_multiplayer_server" => {
            let instance_id = require_string(args, "instanceId")?;
            let name = require_string(args, "name")?;
            let address = require_string(args, "address")?;
            let hide_address = optional_bool(args, "hideAddress")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let servers = crate::servers::save_server_for_state(
                &ctx.state,
                &instance.version_id,
                Some(&instance.id),
                name,
                address,
                hide_address,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            Ok(json!({ "count": servers.len(), "servers": servers }))
        }
        "start_managed_server" => {
            let app = require_app(ctx)?.clone();
            let server_id = require_string(args, "serverId")?;
            let started = crate::server_manager::start_managed_server_for_state(
                app,
                &ctx.state,
                &ctx.servers,
                server_id,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            serde_json::to_value(started)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "stop_managed_server" => {
            let server_id = require_string(args, "serverId")?;
            crate::server_manager::stop_managed_server_for_state(
                ctx.app.clone(),
                &ctx.servers,
                &server_id,
            )
            .await
            .map_err(ToolExecError::Failed)?;
            Ok(json!({ "serverId": server_id, "status": "stopping" }))
        }
        _ => Err(ToolExecError::UnknownTool(format!("Unknown tool '{name}'."))),
    }
}
