//! Curated launcher tools exposed to Lumen (the built-in assistant) and the local MCP server.
//! Every tool operates strictly through existing validated launcher state and helpers:
//! never arbitrary shell commands, never arbitrary filesystem paths, never stored secrets,
//! and never destructive file/world/account/instance deletions.

use crate::{
    downloads::DownloadControl,
    processes::GameRegistry,
    server_manager::ServerRegistry,
    storage::LauncherState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, PoisonError,
    },
    task::{Context, Poll, Wake, Waker},
};

/// Returned when an action that refuses to wait finds the operation lock taken.
const OPERATION_BUSY: &str = "已有安装或启动准备任务运行，请等待完成";

/// Declared from the least access to the most, so tiers compare by how much they allow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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
    /// Set for calls that arrive through the MCP server.
    pub mcp_session: Option<McpSession>,
}

/// The MCP server run a call was accepted under. Its writes are refused once that run has
/// stopped, been replaced by a restart, or had its token rotated.
#[derive(Clone, Debug)]
pub struct McpSession {
    generation: u64,
    current: Arc<AtomicU64>,
    shutdown: Arc<AtomicBool>,
    /// Download-list tasks this run's calls queued, cancelled by `cancel_queued`.
    queued: Arc<Mutex<Vec<String>>>,
}

impl McpSession {
    pub(crate) fn new(generation: u64, current: Arc<AtomicU64>, shutdown: Arc<AtomicBool>) -> Self {
        Self {
            generation,
            current,
            shutdown,
            queued: Arc::default(),
        }
    }

    /// The server is still running and has not been stopped or restarted since the call arrived.
    pub(crate) fn is_current(&self) -> bool {
        !self.shutdown.load(Ordering::Acquire)
            && self.current.load(Ordering::Acquire) == self.generation
    }

    /// Remembers a task a call queued in the download list, so that `cancel_queued` cancels it
    /// while it still waits for its turn. When this run has already ended, the task is cancelled
    /// here instead.
    pub(crate) fn track_queued(&self, control: &DownloadControl, id: &str) {
        {
            let mut queued = self.queued.lock().unwrap_or_else(PoisonError::into_inner);
            let waiting = queued_tasks(control);
            queued.retain(|known| waiting.contains(known));
            queued.push(id.to_owned());
        }
        // A stop marks the run ended before it takes the list, so a task added after that
        // finds the run ended here.
        if !self.is_current() {
            cancel_if_queued(control, id);
        }
    }

    /// Cancels every task this run's calls queued that has not started yet. The server calls
    /// this once the run has ended.
    pub(crate) fn cancel_queued(&self, control: &DownloadControl) {
        let tracked = std::mem::take(&mut *self.queued.lock().unwrap_or_else(PoisonError::into_inner));
        for id in tracked {
            cancel_if_queued(control, &id);
        }
    }
}

/// Ids of the download-list tasks still waiting for their turn.
fn queued_tasks(control: &DownloadControl) -> HashSet<String> {
    control
        .list()
        .into_iter()
        .filter(|job| job.status == "queued")
        .map(|job| job.id)
        .collect()
}

fn is_queued(control: &DownloadControl, id: &str) -> bool {
    control
        .list()
        .iter()
        .any(|job| job.id == id && job.status == "queued")
}

fn cancel_if_queued(control: &DownloadControl, id: &str) {
    if is_queued(control, id) {
        control.cancel(id);
    }
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
            description: "List available mod loader versions (fabric, quilt, forge, neoforge) for a Minecraft game version. OptiFine is not listed: the launcher never downloads it, and the user can only import its installer JAR in the launcher window.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "loader": { "type": "string", "enum": ["fabric", "quilt", "forge", "neoforge"] },
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
            description: "Change the mod loader of an existing stopped instance (vanilla, fabric, quilt, forge, neoforge). When the loader or its version changes, the launcher first makes an automatic backup of the instance; only the two newest automatic loader-switch backups of an instance are kept, and older ones are deleted. Worlds, configs and mod files stay in the instance folder, but mods built for another loader may stop working, and worlds opened with a different loader can permanently lose blocks, items, entities and inventories added by mods. OptiFine cannot be installed this way: the user imports its installer JAR in the launcher window.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": { "type": "string" },
                    "loader": { "type": "string", "enum": ["vanilla", "fabric", "quilt", "forge", "neoforge"] },
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
            description: "Queue retries for all retryable failed download tasks (game, loader, modpack, mod and resource installs).",
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

/// Why a Controlled tool may not run at `permission`, if it may not.
fn controlled_refusal(
    name: &str,
    permission: PermissionTier,
    explicitly_approved: bool,
) -> Option<String> {
    match permission {
        PermissionTier::ReadOnly => Some(format!(
            "Tool '{name}' modifies launcher state and is blocked in Read-only mode."
        )),
        PermissionTier::Controlled if !explicitly_approved => Some(format!(
            "Tool '{name}' requires explicit user approval in Controlled mode."
        )),
        PermissionTier::Controlled | PermissionTier::FullAccess => None,
    }
}

/// What a call was admitted under: its caller's permission tier at the time and whether the
/// call counts as approved.
#[derive(Clone, Copy, Debug)]
pub(super) struct Admission {
    pub(super) permission: PermissionTier,
    pub(super) explicitly_approved: bool,
}

/// Checks again, once a write has been admitted and before it changes anything, that it is
/// still allowed: the permission is read from the saved settings and may not be lower than the
/// tier the call was admitted under (a write let in by Full access is not approved by anyone,
/// so it does not run under Controlled), and a call that came through MCP also needs its server
/// to be running with no stop or restart since the call arrived.
fn recheck_write(
    ctx: &ToolContext,
    name: &str,
    admitted: Admission,
) -> Result<(), ToolExecError> {
    if ctx
        .mcp_session
        .as_ref()
        .is_some_and(|session| !session.is_current())
    {
        return Err(ToolExecError::PermissionDenied(format!(
            "Tool '{name}' was not run because the MCP server it was called through has been stopped or restarted, or its token was rotated."
        )));
    }
    let live = ctx
        .state
        .snapshot()
        .map(|data| PermissionTier::parse(&data.config.assistant_permission))
        .unwrap_or(PermissionTier::ReadOnly);
    if live < admitted.permission
        || controlled_refusal(name, live, admitted.explicitly_approved).is_some()
    {
        return Err(ToolExecError::PermissionDenied(format!(
            "Tool '{name}' was not run because the assistant permission is now {}.",
            live.as_str()
        )));
    }
    Ok(())
}

/// Remembers that it was woken and passes the wake-up on to the task waiting for it.
#[derive(Default)]
struct WakeSignal {
    state: std::sync::Mutex<(bool, Option<Waker>)>,
}

impl WakeSignal {
    /// True once woken; until then `waker` is woken in its place.
    fn woken_or_register(&self, waker: &Waker) -> bool {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if !state.0 {
            state.1 = Some(waker.clone());
        }
        state.0
    }
}

impl Wake for WakeSignal {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        let waiting = {
            let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            state.0 = true;
            state.1.take()
        };
        if let Some(waker) = waiting {
            waker.wake();
        }
    }
}

fn poll_with<F: Future + ?Sized>(future: Pin<&mut F>, waker: &Waker) -> Poll<F::Output> {
    future.poll(&mut Context::from_waker(waker))
}

/// Runs a write whose launcher action asks for the operation lock (`lock().await`) before it
/// awaits anything else, and checks the write again at the moment the lock is handed to it.
///
/// The action is first polled while this call holds the lock, so it checks its arguments and
/// then queues for the lock with a waker of its own. Nothing else wakes an action waiting there:
/// the waker fires when the lock is handed to the action. From then on the lock belongs to the
/// action, which has not written anything until it is polled again, so the check runs under the
/// action's own lock and no other holder can run between the check and the write. A failed
/// check drops the action, which passes the lock on to the next waiter.
async fn run_waiting_write<T>(
    ctx: &ToolContext,
    name: &str,
    admitted: Admission,
    action: impl Future<Output = Result<T, ToolExecError>>,
) -> Result<T, ToolExecError> {
    // Unconstrained, so no cooperative budget can stop the first poll short of the lock.
    let mut action = std::pin::pin!(tokio::task::unconstrained(action));
    let handed = Arc::new(WakeSignal::default());
    {
        let _held = ctx.state.operation.lock().await;
        if let Poll::Ready(result) = poll_with(action.as_mut(), &Waker::from(handed.clone())) {
            // Refused before it asked for the lock, so nothing was written.
            return result;
        }
    }
    std::future::poll_fn(|cx| {
        if handed.woken_or_register(cx.waker()) {
            Poll::Ready(())
        } else {
            Poll::Pending
        }
    })
    .await;
    recheck_write(ctx, name, admitted)?;
    action.await
}

/// Runs a write whose launcher action takes the operation lock with `try_lock` and refuses to
/// wait. The check runs under the lock, and the action takes the lock again in the same poll,
/// right after it is released; a holder that took it in between makes the action refuse.
async fn run_try_lock_write<T, F, Fut>(
    ctx: &ToolContext,
    name: &str,
    admitted: Admission,
    action: F,
) -> Result<T, ToolExecError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, ToolExecError>>,
{
    {
        let _operation = ctx
            .state
            .operation
            .try_lock()
            .map_err(|_| ToolExecError::Failed(OPERATION_BUSY.into()))?;
        recheck_write(ctx, name, admitted)?;
    }
    action().await
}

/// The tasks of `kind` and `target` in the download list that are not in `before`.
fn new_tasks(control: &DownloadControl, before: &HashSet<String>, kind: &str, target: &str) -> Vec<String> {
    control
        .list()
        .into_iter()
        .filter(|job| !before.contains(&job.id) && job.kind == kind && job.target == target)
        .map(|job| job.id)
        .collect()
}

/// Runs a write whose launcher action reserves a task of `kind` and `target` in the download
/// list and waits there for its turn (`wait_for_turn`) before it starts. The action is never
/// dropped, so its task always ends in the list.
///
/// While the task waits, a stop or restart of the MCP server the call came through, or a
/// rotation of its token, cancels it (`McpSession::track_queued`). The write is also checked
/// again every time the action wakes while its task is queued, and so at the moment its turn
/// comes: the lock is then already handed to the action, which has not started, so no other
/// holder can run between the check and the start. A failed check cancels the task, and the
/// action ends without writing.
///
/// When another task of the same kind and target appeared at the same moment, the call cannot
/// tell which one is its own, so it cannot track or check it. For a call that came through MCP
/// (which a stop, restart or token rotation must be able to reach), every such task still
/// waiting is then cancelled, and the call is refused if its own task was among them. A Lumen
/// call runs on untracked: its permission cannot be lowered while it holds the operation lock.
pub(super) async fn run_queued_write<T>(
    ctx: &ToolContext,
    name: &str,
    admitted: Admission,
    kind: &str,
    target: &str,
    action: impl Future<Output = Result<T, ToolExecError>>,
) -> Result<T, ToolExecError> {
    recheck_write(ctx, name, admitted)?;
    let control = &ctx.state.control;
    let before: HashSet<String> = control.list().into_iter().map(|job| job.id).collect();
    let mut action = std::pin::pin!(tokio::task::unconstrained(action));
    let mut task: Option<String> = None;
    let mut refused: Option<ToolExecError> = None;
    let mut unidentified: Option<ToolExecError> = None;
    // Set once the candidates have been looked at, whether or not one of them was told apart.
    let mut settled = false;
    let mut waited = false;
    let result = std::future::poll_fn(|cx| {
        if refused.is_none() {
            if let Some(id) = task.as_deref().filter(|id| is_queued(control, id)) {
                if let Err(error) = recheck_write(ctx, name, admitted) {
                    control.cancel(id);
                    refused = Some(error);
                }
            }
        }
        let polled = action.as_mut().poll(cx);
        if polled.is_pending() {
            if !settled {
                let candidates = new_tasks(control, &before, kind, target);
                settled = !candidates.is_empty();
                match candidates.as_slice() {
                    [] => {}
                    [id] => {
                        task = Some(id.clone());
                        if is_queued(control, id) {
                            if let Some(session) = &ctx.mcp_session {
                                session.track_queued(control, id);
                            }
                            // The server may have stopped before the task was tracked.
                            if let Err(error) = recheck_write(ctx, name, admitted) {
                                cancel_if_queued(control, id);
                                refused = Some(error);
                            }
                        }
                    }
                    several if ctx.mcp_session.is_some() => {
                        // None of them still waiting means its own task has already started.
                        let mut cancelled = false;
                        for id in several {
                            if is_queued(control, id) {
                                control.cancel(id);
                                cancelled = true;
                            }
                        }
                        if cancelled {
                            unidentified = Some(ToolExecError::PermissionDenied(format!(
                                "Tool '{name}' was not run because another task of the same kind started at the same moment, so its own task could not be told apart and checked. Try again."
                            )));
                        }
                    }
                    _ => {}
                }
            }
            waited = task.as_deref().is_some_and(|id| is_queued(control, id));
        }
        polled
    })
    .await;
    if let Some(error) = refused {
        return Err(error);
    }
    if let Some(error) = unidentified {
        // Only a cancellation means its own task was among those cancelled; any other result,
        // success or a real failure, comes from a task that had already started.
        return match result {
            Err(failure) if failure.message().starts_with(crate::downloads::CANCELLED) => Err(error),
            other => other,
        };
    }
    // Cancelled while it waited, by a stop of the server or from the download list.
    let cancelled_waiting = waited
        && result.is_err()
        && task.as_deref().is_some_and(|id| {
            control
                .list()
                .iter()
                .any(|job| job.id == id && job.status == "cancelled")
        });
    if cancelled_waiting {
        recheck_write(ctx, name, admitted)?;
    }
    result
}

/// Why a call is refused from its arguments alone, before anyone is asked to approve it.
pub(crate) fn refusal_before_approval(name: &str, arguments: &Value) -> Option<String> {
    match name {
        "change_instance_loader" | "list_loader_versions" => arguments
            .get("loader")
            .and_then(Value::as_str)
            .and_then(|loader| crate::loaders::refuse_online_optifine(loader).err()),
        _ => None,
    }
}

/// What a tool result says about an instance. The Java path and the JVM arguments (which can
/// hold proxy credentials), the icon and the folder stay out; only whether a custom Java path
/// or JVM arguments are set is told.
fn instance_summary(item: &crate::models::Instance) -> Value {
    let set = |value: &Option<String>| value.as_deref().is_some_and(|text| !text.trim().is_empty());
    json!({
        "id": item.id,
        "name": item.name,
        "versionId": item.version_id,
        "loader": item.loader,
        "loaderVersion": item.loader_version,
        "category": item.category,
        "createdAt": item.created_at,
        "lastPlayed": item.last_played,
        "totalPlayTimeSeconds": item.total_play_time,
        "notes": item.notes,
        "memoryMode": item.memory_mode,
        "maxMemoryMb": item.max_memory_mb,
        "minMemoryMb": item.min_memory_mb,
        "screenWidth": item.screen_width,
        "screenHeight": item.screen_height,
        "gameProxyMode": item.game_proxy_mode,
        "customJavaPath": set(&item.java_path),
        "customJvmArguments": set(&item.jvm_arguments),
    })
}

/// A loader switch result: the instance as `instance_summary` tells it, and the backup taken.
pub(super) fn loader_change_summary(change: &crate::instances::InstanceLoaderChange) -> Value {
    let mut value = instance_summary(&change.instance);
    value["backupId"] = json!(change.backup_id);
    value
}

/// Masks secret-looking text (tokens, passwords, credentials in URLs, registered secrets) in
/// every string of a tool result before it leaves the launcher.
fn redact_strings(value: &mut Value) {
    match value {
        Value::String(text) => *text = crate::processes::redact(text),
        Value::Array(items) => items.iter_mut().for_each(redact_strings),
        Value::Object(map) => map.values_mut().for_each(redact_strings),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Runs a tool for Lumen or an MCP client. Its result and its error text go to the chat
/// provider or the client, so secret-looking text in them is masked.
///
/// The returned future is boxed: the dispatcher's state is large, and every
/// caller that awaits it (the chat loop, MCP, tests) would otherwise keep a
/// copy in its own stack frame. A few such calls in one async block can
/// exhaust a thread's stack before the first tool is even entered.
pub fn execute_tool<'a>(
    ctx: &'a ToolContext,
    name: &'a str,
    arguments: &'a Value,
    permission: PermissionTier,
    explicitly_approved: bool,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Value, ToolExecError>> + Send + 'a>,
> {
    Box::pin(execute_tool_inner(
        ctx,
        name,
        arguments,
        permission,
        explicitly_approved,
    ))
}

async fn execute_tool_inner(
    ctx: &ToolContext,
    name: &str,
    arguments: &Value,
    permission: PermissionTier,
    explicitly_approved: bool,
) -> Result<Value, ToolExecError> {
    match run_tool(ctx, name, arguments, permission, explicitly_approved).await {
        Ok(mut value) => {
            redact_strings(&mut value);
            Ok(value)
        }
        Err(ToolExecError::UnknownTool(message)) => {
            Err(ToolExecError::UnknownTool(crate::processes::redact(&message)))
        }
        Err(ToolExecError::PermissionDenied(message)) => {
            Err(ToolExecError::PermissionDenied(crate::processes::redact(&message)))
        }
        Err(ToolExecError::Failed(message)) => {
            Err(ToolExecError::Failed(crate::processes::redact(&message)))
        }
    }
}

async fn run_tool(
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
        if let Some(reason) = controlled_refusal(name, permission, explicitly_approved) {
            return Err(ToolExecError::PermissionDenied(reason));
        }
    }
    let admitted = Admission {
        permission,
        explicitly_approved,
    };

    match name {
        "list_instances" => {
            let data = ctx.state.snapshot().map_err(ToolExecError::Failed)?;
            let visible = crate::commands::active_folder_instances(&data);
            let instances: Vec<Value> = visible.iter().map(instance_summary).collect();
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
                "updateChannel": config.update_channel,
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
            crate::loaders::refuse_online_optifine(&loader).map_err(ToolExecError::Failed)?;
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
        // Each write calls recheck_write after it is admitted to run and before it changes
        // anything: under the operation lock its launcher action holds (for a queued task, when
        // its turn comes), or right before the action for those that take the lock with
        // try_lock, queue retries or use no lock.
        "toggle_instance_resource" => {
            let instance_id = require_string(args, "instanceId")?;
            let resource_type = require_string(args, "resourceType")?;
            let file_name = require_string(args, "fileName")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let updated = run_waiting_write(ctx, name, admitted, async {
                crate::resources::toggle_resource_for_state(
                    &ctx.state,
                    instance.version_id,
                    Some(instance.id),
                    resource_type,
                    file_name,
                )
                .await
                .map_err(ToolExecError::Failed)
            })
            .await?;
            serde_json::to_value(updated)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "toggle_world_datapack" => {
            let instance_id = require_string(args, "instanceId")?;
            let world_folder = require_string(args, "worldFolder")?;
            let file_name = require_string(args, "fileName")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let updated = run_waiting_write(ctx, name, admitted, async {
                crate::content::toggle_world_datapack_for_state(
                    &ctx.state,
                    instance.version_id,
                    Some(instance.id),
                    world_folder,
                    file_name,
                )
                .await
                .map_err(ToolExecError::Failed)
            })
            .await?;
            serde_json::to_value(updated)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "create_instance" => {
            let instance_name = require_string(args, "name")?;
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
            recheck_write(ctx, name, admitted)?;
            let created =
                crate::commands::create_instance_locked(&ctx.state, instance_name, version_id)
                    .map_err(ToolExecError::Failed)?;
            Ok(instance_summary(&created))
        }
        "update_instance_notes" => {
            let instance_id = require_string(args, "instanceId")?;
            let notes = optional_string(args, "notes")?;
            let category = optional_string(args, "category")?;
            let updated = run_waiting_write(ctx, name, admitted, async {
                crate::instances::update_instance_notes_inner(
                    &ctx.state,
                    &instance_id,
                    notes,
                    category,
                )
                .await
                .map_err(ToolExecError::Failed)
            })
            .await?;
            Ok(instance_summary(&updated))
        }
        "update_instance_settings" => {
            let instance_id = require_string(args, "instanceId")?;
            let new_name = optional_string(args, "name")?;
            let category = optional_string(args, "category")?;
            let notes = optional_string(args, "notes")?;
            let memory_mode = optional_string(args, "memoryMode")?;
            let max_memory_mb = optional_u32(args, "maxMemoryMb")?;
            let min_memory_mb = optional_u32(args, "minMemoryMb")?;
            let clear_min_memory = optional_bool(args, "clearMinMemory")?;
            let screen_width = optional_u32(args, "screenWidth")?;
            let screen_height = optional_u32(args, "screenHeight")?;
            let game_proxy_mode = optional_string(args, "gameProxyMode")?;
            let reset_runtime = optional_bool(args, "resetRuntime")?;
            let updated = run_waiting_write(ctx, name, admitted, async {
                crate::instances::update_instance_safe_settings(
                    &ctx.state,
                    &instance_id,
                    new_name,
                    category,
                    notes,
                    memory_mode,
                    max_memory_mb,
                    min_memory_mb,
                    clear_min_memory,
                    screen_width,
                    screen_height,
                    game_proxy_mode,
                    reset_runtime,
                )
                .await
                .map_err(ToolExecError::Failed)
            })
            .await?;
            Ok(instance_summary(&updated))
        }
        "backup_instance" => {
            let instance_id = require_string(args, "instanceId")?;
            let backup = run_waiting_write(ctx, name, admitted, async {
                crate::instances::backup_instance_for_state(&ctx.state, instance_id)
                    .await
                    .map_err(ToolExecError::Failed)
            })
            .await?;
            serde_json::to_value(backup)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "clone_instance" => {
            let instance_id = require_string(args, "instanceId")?;
            let clone_name = require_string(args, "name")?;
            let cloned = run_waiting_write(ctx, name, admitted, async {
                // A version-folder instance is copied as a version folder; the
                // managed clone below would keep kind "version" in an
                // instances/<uuid> record and be purged by the next scan.
                crate::commands::copy_instance_inner(
                    &ctx.state,
                    &instance_id,
                    Some(&clone_name),
                )
                .await
                .map_err(ToolExecError::Failed)
            })
            .await?;
            Ok(instance_summary(&cloned))
        }
        "change_instance_loader" => {
            let instance_id = require_string(args, "instanceId")?;
            let loader = require_string(args, "loader")?;
            let loader_version = optional_string(args, "loaderVersion")?;
            let updated = run_try_lock_write(ctx, name, admitted, || async {
                let app = require_app(ctx)?;
                crate::instances::change_instance_loader_for_state(
                    app,
                    &ctx.state,
                    &instance_id,
                    &loader,
                    loader_version,
                )
                .await
                .map_err(ToolExecError::Failed)
            })
            .await?;
            Ok(loader_change_summary(&updated))
        }
        "install_minecraft_version" => {
            let version_id = require_string(args, "versionId")?;
            let installed = run_try_lock_write(ctx, name, admitted, || async {
                let app = require_app(ctx)?;
                crate::commands::install_version_for_state(app, &ctx.state, version_id)
                    .await
                    .map_err(ToolExecError::Failed)
            })
            .await?;
            serde_json::to_value(installed)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        // This, launch_instance and retry_failed_downloads queue a task. It waits for its turn
        // in the download list, where it can be seen and cancelled, and factory reset is refused
        // while it waits; a stop or restart of the MCP server cancels it.
        "install_modrinth_resource" => {
            let instance_id = require_string(args, "instanceId")?;
            let project_id = require_string(args, "projectId")?;
            let resource_type = require_string(args, "resourceType")?;
            let resource_version_id = optional_string(args, "resourceVersionId")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let target = project_id.clone();
            let installed = run_queued_write(ctx, name, admitted, "resource", &target, async {
                let app = require_app(ctx)?;
                crate::resources::install_modrinth_for_state(
                    app,
                    &ctx.state,
                    project_id,
                    instance.version_id,
                    instance.id,
                    resource_type,
                    resource_version_id,
                )
                .await
                .map_err(ToolExecError::Failed)
            })
            .await?;
            serde_json::to_value(installed)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "launch_instance" => {
            let instance_id = require_string(args, "instanceId")?;
            let server_address = optional_string(args, "serverAddress")?;
            // The launch task is reserved for the instance's version.
            let target = ctx
                .state
                .snapshot()
                .ok()
                .and_then(|data| {
                    data.instances
                        .into_iter()
                        .find(|item| item.id == instance_id)
                        .map(|item| item.version_id)
                })
                .unwrap_or_default();
            let launched = run_queued_write(ctx, name, admitted, "launch", &target, async {
                let app = require_app(ctx)?;
                crate::commands::launch_instance_for_state(
                    app,
                    &ctx.state,
                    &instance_id,
                    server_address,
                )
                .await
                .map_err(ToolExecError::Failed)
            })
            .await?;
            serde_json::to_value(launched)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "stop_running_game" => {
            let game_id = require_string(args, "gameId")?;
            recheck_write(ctx, name, admitted)?;
            let result = crate::processes::stop_game_graceful(&ctx.games, &game_id)
                .await
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(result)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "retry_failed_downloads" => {
            recheck_write(ctx, name, admitted)?;
            let app = require_app(ctx)?.clone();
            let result = crate::downloads::retry_failed_downloads_for_state(app, &ctx.state)
                .await
                .map_err(ToolExecError::Failed)?;
            // The retries run later, each when its turn comes. The settings cannot change while
            // they wait, since saving them needs the operation lock; a stop or restart of the
            // MCP server cancels those still waiting.
            if let Some(session) = &ctx.mcp_session {
                for id in &result.ids {
                    session.track_queued(&ctx.state.control, id);
                }
            }
            serde_json::to_value(result)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "clear_unfinished_downloads" => {
            recheck_write(ctx, name, admitted)?;
            let result = crate::downloads::clear_unfinished_downloads_for_state(&ctx.state)
                .await
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(result)
                .map_err(|error| ToolExecError::Failed(error.to_string()))
        }
        "save_multiplayer_server" => {
            let instance_id = require_string(args, "instanceId")?;
            let server_name = require_string(args, "name")?;
            let address = require_string(args, "address")?;
            let hide_address = optional_bool(args, "hideAddress")?;
            let instance = registered_instance(&ctx.state, &instance_id)?;
            let servers = run_waiting_write(ctx, name, admitted, async {
                crate::servers::save_server_for_state(
                    &ctx.state,
                    &instance.version_id,
                    Some(&instance.id),
                    server_name,
                    address,
                    hide_address,
                )
                .await
                .map_err(ToolExecError::Failed)
            })
            .await?;
            Ok(json!({ "count": servers.len(), "servers": servers }))
        }
        "start_managed_server" => {
            let server_id = require_string(args, "serverId")?;
            recheck_write(ctx, name, admitted)?;
            let app = require_app(ctx)?.clone();
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
            recheck_write(ctx, name, admitted)?;
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
