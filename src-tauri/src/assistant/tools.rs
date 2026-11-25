//! Curated launcher tools exposed to the built-in assistant and the local MCP server.
//! Every tool operates strictly through existing validated launcher state and helpers:
//! never arbitrary shell commands, never arbitrary filesystem paths, never stored secrets.

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
        ToolSpec {
            name: "list_instances",
            description: "List all configured Minecraft instances in Voxelight Launcher (name, version, loader, category, play time, notes).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_installed_versions",
            description: "List installed Minecraft version directories detected in the configured game directory.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_accounts",
            description: "List configured player accounts (username, account type, and active selection; never tokens or credentials).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "get_memory_overview",
            description: "Read system physical RAM, available RAM, effective allocation mode, and recommended memory (MB) globally or for a specific instance.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": {
                        "type": "string",
                        "description": "Optional registered instance ID to inspect mod-aware recommended memory."
                    }
                },
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_download_tasks",
            description: "List active and recent download or installation tasks with status and progress.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_running_games",
            description: "List Minecraft game processes currently running and managed by Voxelight Launcher.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_instance_resources",
            description: "List local mods, resource packs, or shader packs installed inside a registered instance.",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": {
                        "type": "string",
                        "description": "Registered instance ID from list_instances."
                    },
                    "resourceType": {
                        "type": "string",
                        "enum": ["mod", "resourcepack", "shader"],
                        "description": "Type of local resource to list."
                    }
                },
                "required": ["instanceId", "resourceType"],
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
                    "instanceId": {
                        "type": "string",
                        "description": "Registered instance ID from list_instances."
                    },
                    "maxLines": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 200,
                        "description": "Maximum number of trailing log entries to return (default 80, max 200)."
                    }
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
                "properties": {
                    "instanceId": {
                        "type": "string",
                        "description": "Registered instance ID from list_instances."
                    }
                },
                "required": ["instanceId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "list_managed_servers",
            description: "List managed local Minecraft servers (name, version, software, port, EULA status, running status).",
            tier: ToolTier::ReadOnly,
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "toggle_instance_resource",
            description: "Enable or disable a specific mod, resource pack, or shader pack file in a registered stopped instance.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "instanceId": {
                        "type": "string",
                        "description": "Registered instance ID from list_instances."
                    },
                    "resourceType": {
                        "type": "string",
                        "enum": ["mod", "resourcepack", "shader"]
                    },
                    "fileName": {
                        "type": "string",
                        "description": "Exact file name from list_instance_resources."
                    }
                },
                "required": ["instanceId", "resourceType", "fileName"],
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
                    "name": {
                        "type": "string",
                        "description": "Display name for the new instance (1-80 characters)."
                    },
                    "versionId": {
                        "type": "string",
                        "description": "Installed version ID from list_installed_versions."
                    }
                },
                "required": ["name", "versionId"],
                "additionalProperties": false
            }),
        },
        ToolSpec {
            name: "stop_running_game",
            description: "Request a graceful stop of a Minecraft process currently managed by Voxelight Launcher.",
            tier: ToolTier::Controlled,
            input_schema: json!({
                "type": "object",
                "properties": {
                    "gameId": {
                        "type": "string",
                        "description": "Running gameId from list_running_games."
                    }
                },
                "required": ["gameId"],
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
                    "instanceId": {
                        "type": "string",
                        "description": "Registered instance ID from list_instances."
                    },
                    "notes": {
                        "type": "string",
                        "description": "Updated notes text (up to 4000 characters)."
                    },
                    "category": {
                        "type": "string",
                        "description": "Updated category label (up to 64 characters)."
                    }
                },
                "required": ["instanceId"],
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

/// Tools offered to the built-in LLM according to the active permission tier.
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
/// Under Read-only or Controlled mode, MCP exposes read-only tools only so external clients
/// cannot perform unapproved writes without an interactive confirmation dialog.
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
            let lines = &log.lines[start..];
            Ok(json!({
                "instanceId": instance_id,
                "hasLog": log.path.is_some(),
                "totalLines": total,
                "returnedLines": lines.len(),
                "truncated": log.truncated || start > 0,
                "lines": lines,
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
            let created = crate::commands::create_instance_inner(&ctx.state, name, version_id)
                .map_err(ToolExecError::Failed)?;
            serde_json::to_value(created)
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
        _ => Err(ToolExecError::UnknownTool(format!("Unknown tool '{name}'."))),
    }
}
