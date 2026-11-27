//! Approval rules for Lumen tool calls: which calls always ask, how many writes may run
//! without a click, the readable details shown on an approval card, and the process-wide
//! record of issued approvals that a continuation must match before anything runs.

use super::tools::ToolContext;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Issued approvals expire after this long; an older approval must be asked for again.
pub(crate) const APPROVAL_TTL: Duration = Duration::from_secs(30 * 60);
/// Upper bound on remembered approvals; the oldest entry is dropped first.
pub(crate) const MAX_ISSUED_APPROVALS: usize = 128;
/// Controlled tools that may run without an approval in one user turn (Full access).
pub(crate) const MAX_UNAPPROVED_WRITES: usize = 3;
/// All lookups for one set of pending calls finish within this long; later ones are unresolved.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(4);
/// Pending calls described at the same time (an install makes up to two lookups).
pub(crate) const DESCRIBE_CONCURRENCY: usize = 4;
const MAX_LOOKUP_BYTES: usize = 256 * 1024;
const MAX_DETAIL_CHARS: usize = 200;
/// Server addresses are shown whole up to the longest address the launcher accepts.
const MAX_ADDRESS_CHARS: usize = 300;
/// Failed tasks a retry card lists one by one; the count above them covers the rest.
const MAX_RETRY_DETAILS: usize = 12;

/// Tools that ask in Lumen even in Full access. `launch_instance` joins this list when it
/// carries a server address (see [`always_asks`]). A retry of failed downloads can install
/// mods, modpacks and loaders again.
const ALWAYS_ASK_TOOLS: [&str; 5] = [
    "install_modrinth_resource",
    "change_instance_loader",
    "start_managed_server",
    "save_multiplayer_server",
    "retry_failed_downloads",
];

/// Why a call waits for the user.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalReason {
    /// Controlled mode asks before every write.
    Controlled,
    /// A high-risk tool that always asks.
    AlwaysAsk,
    /// The per-turn limit of writes without an approval was reached.
    Limit,
}

/// The one rule for high-risk calls in Lumen.
pub(crate) fn always_asks(name: &str, arguments: &Value) -> bool {
    if ALWAYS_ASK_TOOLS.contains(&name) {
        return true;
    }
    name == "launch_instance"
        && match arguments.get("serverAddress") {
            None | Some(Value::Null) => false,
            Some(Value::String(address)) => !address.trim().is_empty(),
            Some(_) => true,
        }
}

/// Decides whether a Controlled call must wait for the user.
pub(crate) fn approval_reason(
    permission: super::tools::PermissionTier,
    name: &str,
    arguments: &Value,
    unapproved_writes: usize,
) -> Option<ApprovalReason> {
    use super::tools::PermissionTier;
    match permission {
        // Read-only never runs a write; the tool layer reports it as blocked.
        PermissionTier::ReadOnly => None,
        PermissionTier::Controlled => Some(ApprovalReason::Controlled),
        PermissionTier::FullAccess if always_asks(name, arguments) => Some(ApprovalReason::AlwaysAsk),
        PermissionTier::FullAccess if unapproved_writes >= MAX_UNAPPROVED_WRITES => {
            Some(ApprovalReason::Limit)
        }
        PermissionTier::FullAccess => None,
    }
}

fn canonical_number(number: &serde_json::Number) -> String {
    // The renderer may round-trip 1.0 as 1; both name the same argument.
    if let Some(value) = number.as_f64() {
        if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
            return format!("{}", value as i64);
        }
    }
    number.to_string()
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&canonical_number(number)),
        Value::String(text) => out.push_str(&Value::String(text.clone()).to_string()),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(&map[key], out);
            }
            out.push('}');
        }
    }
}

/// SHA-256 over the tool name and its arguments with sorted keys.
pub(crate) fn call_digest(name: &str, arguments: &Value) -> String {
    let mut canonical = String::new();
    write_canonical(arguments, &mut canonical);
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    hasher.update([0u8]);
    hasher.update(canonical.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Turn state recorded with each issued approval, so a continuation cannot loosen it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TurnBinding {
    pub wake: bool,
    pub unapproved_writes: usize,
    pub round: usize,
}

struct IssuedApproval {
    digest: String,
    issued_at: Instant,
    binding: TurnBinding,
}

#[derive(Default)]
pub(crate) struct ApprovalRegistry {
    entries: Mutex<HashMap<String, IssuedApproval>>,
}

impl ApprovalRegistry {
    pub(crate) fn issue(&self, call_id: &str, name: &str, arguments: &Value, binding: TurnBinding) {
        self.issue_at(Instant::now(), call_id, name, arguments, binding);
    }

    fn issue_at(
        &self,
        now: Instant,
        call_id: &str,
        name: &str,
        arguments: &Value,
        binding: TurnBinding,
    ) {
        let mut entries = self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.retain(|_, entry| now.saturating_duration_since(entry.issued_at) < APPROVAL_TTL);
        while entries.len() >= MAX_ISSUED_APPROVALS && !entries.contains_key(call_id) {
            let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.issued_at)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            entries.remove(&oldest);
        }
        entries.insert(
            call_id.to_owned(),
            IssuedApproval {
                digest: call_digest(name, arguments),
                issued_at: now,
                binding,
            },
        );
    }

    /// Removes the approval for `call_id`. Returns its turn state only when it was issued
    /// for exactly this tool and these arguments and has not expired.
    pub(crate) fn consume(&self, call_id: &str, name: &str, arguments: &Value) -> Option<TurnBinding> {
        self.consume_at(Instant::now(), call_id, name, arguments)
    }

    fn consume_at(
        &self,
        now: Instant,
        call_id: &str,
        name: &str,
        arguments: &Value,
    ) -> Option<TurnBinding> {
        let issued = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(call_id)?;
        (now.saturating_duration_since(issued.issued_at) < APPROVAL_TTL
            && issued.digest == call_digest(name, arguments))
        .then_some(issued.binding)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

/// The process-wide record of approvals Lumen has asked for.
pub(crate) fn issued() -> &'static ApprovalRegistry {
    static REGISTRY: OnceLock<ApprovalRegistry> = OnceLock::new();
    REGISTRY.get_or_init(ApprovalRegistry::default)
}

/// One readable fact about a pending call; `field` selects a translated label.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDetail {
    pub field: String,
    pub value: String,
    #[serde(default)]
    pub unresolved: bool,
}

/// Replaces control and direction characters. A value longer than `limit` keeps its start
/// and its end (where a host name's domain and port are); the flag says it was shortened.
fn clean(text: &str, limit: usize) -> (String, bool) {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    let count = trimmed.chars().count();
    if count <= limit {
        return (trimmed.to_owned(), false);
    }
    let tail_len = limit / 2;
    let head: String = trimmed.chars().take(limit - tail_len).collect();
    let tail: String = trimmed.chars().skip(count - tail_len).collect();
    (format!("{head}…{tail}"), true)
}

fn arg_text(arguments: &Value, key: &str) -> Option<String> {
    match arguments.get(key)? {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
        Value::String(_) | Value::Null => None,
        other => Some(other.to_string()),
    }
}

/// Like `arg_text`, but an empty string stays: for notes and a category it clears the value.
fn arg_value(arguments: &Value, key: &str) -> Option<String> {
    match arguments.get(key)? {
        Value::String(text) => Some(text.trim().to_owned()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn modrinth_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// One Modrinth client and one deadline shared by every lookup for a set of pending calls.
struct Lookups<'a> {
    ctx: &'a ToolContext,
    client: OnceLock<Option<reqwest::Client>>,
    deadline: tokio::time::Instant,
}

impl<'a> Lookups<'a> {
    fn new(ctx: &'a ToolContext) -> Self {
        Self {
            ctx,
            client: OnceLock::new(),
            deadline: tokio::time::Instant::now() + LOOKUP_TIMEOUT,
        }
    }

    fn client(&self) -> Option<reqwest::Client> {
        self.client
            .get_or_init(|| crate::resources::client(&self.ctx.state, false).ok())
            .clone()
    }
}

async fn modrinth_lookup(lookups: &Lookups<'_>, endpoint: String) -> Option<Value> {
    let client = lookups.client()?;
    let url = format!("{}/{endpoint}", crate::resources::modrinth_api());
    let request = async move {
        let mut response = client.get(url).send().await.ok()?;
        if !response.status().is_success()
            || response
                .content_length()
                .is_some_and(|len| len > MAX_LOOKUP_BYTES as u64)
        {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len().saturating_add(chunk.len()) > MAX_LOOKUP_BYTES {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice::<Value>(&bytes).ok()
    };
    tokio::time::timeout_at(lookups.deadline, request)
        .await
        .ok()
        .flatten()
}

struct Details {
    items: Vec<ApprovalDetail>,
}

impl Details {
    /// A value that had to be shortened is marked unresolved, so the card warns about it.
    fn push(&mut self, field: &str, value: impl AsRef<str>, unresolved: bool) {
        let limit = if field == "serverAddress" {
            MAX_ADDRESS_CHARS
        } else {
            MAX_DETAIL_CHARS
        };
        let (value, shortened) = clean(value.as_ref(), limit);
        self.items.push(ApprovalDetail {
            field: field.to_owned(),
            value,
            unresolved: unresolved || shortened,
        });
    }
}

fn describe_instance(ctx: &ToolContext, details: &mut Details, instance_id: &str) {
    let found = ctx
        .state
        .snapshot()
        .ok()
        .and_then(|data| data.instances.into_iter().find(|item| item.id == instance_id));
    match found {
        Some(instance) => {
            let mut value = format!("{} · {}", instance.name, instance.version_id);
            let loader = instance.loader.trim();
            if !loader.is_empty() && loader != "vanilla" {
                value.push_str(" · ");
                value.push_str(loader);
                if !instance.loader_version.trim().is_empty() {
                    value.push(' ');
                    value.push_str(instance.loader_version.trim());
                }
            }
            details.push("instance", value, false);
        }
        None => details.push("instance", instance_id, true),
    }
}

async fn describe_modrinth(lookups: &Lookups<'_>, details: &mut Details, arguments: &Value) {
    let project_id = arg_text(arguments, "projectId").unwrap_or_default();
    let version_id = arg_text(arguments, "resourceVersionId");
    let project_lookup = async {
        if modrinth_id(&project_id) {
            modrinth_lookup(lookups, format!("project/{project_id}")).await
        } else {
            None
        }
    };
    let version_lookup = async {
        match version_id.as_deref() {
            Some(id) if modrinth_id(id) => modrinth_lookup(lookups, format!("version/{id}")).await,
            _ => None,
        }
    };
    let (project, version) = futures_util::future::join(project_lookup, version_lookup).await;

    let project_key = project
        .as_ref()
        .and_then(|value| value.get("id").and_then(Value::as_str))
        .map(str::to_owned);
    match project.as_ref().and_then(|value| value.get("title").and_then(Value::as_str)) {
        Some(title) => {
            let slug = project
                .as_ref()
                .and_then(|value| value.get("slug").and_then(Value::as_str))
                .filter(|slug| !slug.is_empty());
            let value = match slug {
                Some(slug) => format!("{title} ({slug})"),
                None => title.to_owned(),
            };
            details.push("project", value, false);
        }
        None => details.push("project", &project_id, true),
    }
    if let Some(kind) = arg_text(arguments, "resourceType") {
        details.push("resourceType", kind, false);
    }
    if let Some(requested) = version_id {
        match version.as_ref() {
            Some(found) => {
                let name = found.get("name").and_then(Value::as_str).unwrap_or_default();
                let number = found
                    .get("version_number")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let value = match (name.is_empty(), number.is_empty()) {
                    (false, false) if name != number => format!("{name} ({number})"),
                    (false, _) => name.to_owned(),
                    (true, false) => number.to_owned(),
                    (true, true) => requested.clone(),
                };
                let owner = found.get("project_id").and_then(Value::as_str);
                let matches = owner.is_some()
                    && project_key.is_some()
                    && owner == project_key.as_deref();
                details.push("resourceVersion", value, !matches);
            }
            None => details.push("resourceVersion", requested, true),
        }
    }
}

async fn describe_managed_server(ctx: &ToolContext, details: &mut Details, server_id: &str) {
    let state = ctx.state.clone();
    let servers = ctx.servers.clone();
    let listed = tokio::task::spawn_blocking(move || {
        crate::server_manager::list_managed_servers_inner(&state, &servers)
    })
    .await
    .ok()
    .and_then(Result::ok)
    .unwrap_or_default();
    match listed.into_iter().find(|server| server.id == server_id) {
        Some(server) => details.push(
            "managedServer",
            format!("{} · {}", server.name, server.version_id),
            false,
        ),
        None => details.push("managedServer", server_id, true),
    }
}

fn describe_game(ctx: &ToolContext, details: &mut Details, game_id: &str) {
    let running = ctx.games.snapshot().unwrap_or_default();
    match running.into_iter().find(|game| game.game_id == game_id) {
        Some(game) => {
            let label = game
                .instance_id
                .as_deref()
                .and_then(|id| {
                    ctx.state
                        .snapshot()
                        .ok()?
                        .instances
                        .into_iter()
                        .find(|item| item.id == id)
                        .map(|item| item.name)
                })
                .unwrap_or_else(|| game.version_id.clone());
            details.push("game", format!("{label} · PID {}", game.pid), false);
        }
        None => details.push("game", game_id, true),
    }
}

/// Every setting an update_instance_settings call changes, in the order the tool lists them.
fn describe_instance_settings(details: &mut Details, arguments: &Value) {
    for (key, field) in [("name", "name"), ("category", "category"), ("notes", "notes")] {
        if let Some(value) = arg_value(arguments, key) {
            details.push(field, value, false);
        }
    }
    if let Some(mode) = arg_text(arguments, "memoryMode") {
        details.push("memoryMode", mode, false);
    }
    for (key, field) in [("maxMemoryMb", "maxMemory"), ("minMemoryMb", "minMemory")] {
        if let Some(memory) = arg_text(arguments, key) {
            details.push(field, format!("{memory} MB"), false);
        }
    }
    for key in [
        "clearMinMemory",
        "screenWidth",
        "screenHeight",
        "gameProxyMode",
        "resetRuntime",
    ] {
        if let Some(value) = arg_text(arguments, key) {
            details.push(key, value, false);
        }
    }
}

/// The failed tasks a retry would queue again, read from the download list: how many, then
/// the kind, label and target of each.
fn describe_retries(ctx: &ToolContext, details: &mut Details) {
    let retried: Vec<_> = ctx
        .state
        .control
        .list()
        .into_iter()
        .filter(|job| job.status == "failed" && job.retryable)
        .collect();
    details.push("retryCount", retried.len().to_string(), false);
    for job in retried.iter().take(MAX_RETRY_DETAILS) {
        let target = job
            .display_target
            .as_deref()
            .map(str::trim)
            .filter(|target| !target.is_empty())
            .unwrap_or(job.target.trim());
        let value = if target.is_empty() || job.label.contains(target) {
            format!("{} · {}", job.kind, job.label)
        } else {
            format!("{} · {} · {target}", job.kind, job.label)
        };
        details.push("retryTask", value, false);
    }
    if retried.len() > MAX_RETRY_DETAILS {
        details.push("retryTask", format!("+{}", retried.len() - MAX_RETRY_DETAILS), false);
    }
}

/// Resolves the IDs in each pending call into readable details for its approval card, a
/// few calls at a time with one Modrinth client and one deadline for all of them. The flag
/// is true when any ID could not be confirmed.
pub(crate) async fn describe_all(
    ctx: &ToolContext,
    calls: Vec<(String, Value)>,
) -> Vec<(Vec<ApprovalDetail>, bool)> {
    let lookups = Lookups::new(ctx);
    let lookups = &lookups;
    futures_util::stream::iter(calls)
        .map(|(name, arguments)| async move { describe(lookups, &name, &arguments).await })
        .buffered(DESCRIBE_CONCURRENCY)
        .collect()
        .await
}

async fn describe(
    lookups: &Lookups<'_>,
    name: &str,
    arguments: &Value,
) -> (Vec<ApprovalDetail>, bool) {
    let ctx = lookups.ctx;
    let mut details = Details { items: Vec::new() };
    if let Some(instance_id) = arg_text(arguments, "instanceId") {
        describe_instance(ctx, &mut details, &instance_id);
    }
    match name {
        "install_modrinth_resource" => describe_modrinth(lookups, &mut details, arguments).await,
        "change_instance_loader" => {
            if let Some(loader) = arg_text(arguments, "loader") {
                let value = match arg_text(arguments, "loaderVersion") {
                    Some(version) => format!("{loader} {version}"),
                    None => loader,
                };
                details.push("loader", value, false);
            }
        }
        "launch_instance" => {
            if let Some(address) = arg_text(arguments, "serverAddress") {
                details.push("serverAddress", address, false);
            }
        }
        "save_multiplayer_server" => {
            if let Some(server) = arg_text(arguments, "name") {
                details.push("serverName", server, false);
            }
            if let Some(address) = arg_text(arguments, "address") {
                details.push("serverAddress", address, false);
            }
        }
        "start_managed_server" | "stop_managed_server" => {
            if let Some(server_id) = arg_text(arguments, "serverId") {
                describe_managed_server(ctx, &mut details, &server_id).await;
            }
        }
        "stop_running_game" => {
            if let Some(game_id) = arg_text(arguments, "gameId") {
                describe_game(ctx, &mut details, &game_id);
            }
        }
        "install_minecraft_version" | "create_instance" => {
            if let Some(name) = arg_text(arguments, "name") {
                details.push("name", name, false);
            }
            if let Some(version) = arg_text(arguments, "versionId") {
                details.push("gameVersion", version, false);
            }
        }
        "update_instance_settings" => describe_instance_settings(&mut details, arguments),
        "retry_failed_downloads" => describe_retries(ctx, &mut details),
        _ => {
            for (key, field) in [
                ("name", "name"),
                ("notes", "notes"),
                ("category", "category"),
                ("resourceType", "resourceType"),
                ("worldFolder", "worldFolder"),
                ("fileName", "fileName"),
            ] {
                let value = if matches!(key, "notes" | "category") {
                    arg_value(arguments, key)
                } else {
                    arg_text(arguments, key)
                };
                if let Some(value) = value {
                    details.push(field, value, false);
                }
            }
        }
    }
    let unresolved = details.items.iter().any(|item| item.unresolved);
    (details.items, unresolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::tools::PermissionTier;
    use serde_json::json;

    #[test]
    fn high_risk_tools_always_ask_and_launch_asks_only_with_a_server() {
        for name in ALWAYS_ASK_TOOLS {
            assert!(always_asks(name, &json!({})), "{name}");
        }
        assert!(always_asks("launch_instance", &json!({ "instanceId": "a", "serverAddress": "evil.example:25565" })));
        assert!(always_asks("launch_instance", &json!({ "instanceId": "a", "serverAddress": 25565 })));
        assert!(!always_asks("launch_instance", &json!({ "instanceId": "a" })));
        assert!(!always_asks("launch_instance", &json!({ "instanceId": "a", "serverAddress": "  " })));
        assert!(!always_asks("launch_instance", &json!({ "instanceId": "a", "serverAddress": null })));
        assert!(!always_asks("update_instance_notes", &json!({ "instanceId": "a" })));
    }

    #[test]
    fn full_access_asks_for_high_risk_and_after_the_write_limit() {
        let notes = json!({ "instanceId": "a", "notes": "x" });
        assert_eq!(approval_reason(PermissionTier::ReadOnly, "update_instance_notes", &notes, 0), None);
        assert_eq!(
            approval_reason(PermissionTier::Controlled, "update_instance_notes", &notes, 0),
            Some(ApprovalReason::Controlled)
        );
        assert_eq!(approval_reason(PermissionTier::FullAccess, "update_instance_notes", &notes, 0), None);
        assert_eq!(
            approval_reason(PermissionTier::FullAccess, "update_instance_notes", &notes, MAX_UNAPPROVED_WRITES),
            Some(ApprovalReason::Limit)
        );
        assert_eq!(
            approval_reason(PermissionTier::FullAccess, "change_instance_loader", &json!({}), 0),
            Some(ApprovalReason::AlwaysAsk)
        );
    }

    #[test]
    fn a_retry_of_failed_downloads_always_asks_in_full_access() {
        // A retry can install mods, modpacks and loaders again.
        assert!(always_asks("retry_failed_downloads", &json!({})));
        assert_eq!(
            approval_reason(PermissionTier::FullAccess, "retry_failed_downloads", &json!({}), 0),
            Some(ApprovalReason::AlwaysAsk)
        );
    }

    #[test]
    fn digest_ignores_key_order_and_integral_float_form_but_not_values() {
        let a = call_digest("t", &json!({ "b": 1, "a": { "y": [1, 2], "x": "v" } }));
        let b = call_digest("t", &json!({ "a": { "x": "v", "y": [1.0, 2] }, "b": 1.0 }));
        assert_eq!(a, b);
        assert_ne!(a, call_digest("t", &json!({ "b": 2, "a": { "y": [1, 2], "x": "v" } })));
        assert_ne!(a, call_digest("u", &json!({ "b": 1, "a": { "y": [1, 2], "x": "v" } })));
        assert_ne!(call_digest("t", &json!({ "a": "1" })), call_digest("t", &json!({ "a": 1 })));
    }

    #[test]
    fn issued_approvals_are_consumed_once_bound_to_arguments_and_expire() {
        let registry = ApprovalRegistry::default();
        let args = json!({ "instanceId": "a", "notes": "x" });
        let binding = TurnBinding { wake: false, unapproved_writes: 2, round: 1 };
        let start = Instant::now();
        registry.issue_at(start, "c1", "update_instance_notes", &args, binding);
        assert_eq!(registry.consume_at(start, "c1", "update_instance_notes", &args), Some(binding));
        assert_eq!(registry.consume_at(start, "c1", "update_instance_notes", &args), None);

        registry.issue_at(start, "c2", "update_instance_notes", &args, binding);
        assert_eq!(
            registry.consume_at(start, "c2", "update_instance_notes", &json!({ "instanceId": "b", "notes": "x" })),
            None
        );
        assert_eq!(registry.consume_at(start, "c2", "update_instance_notes", &args), None);

        registry.issue_at(start, "c3", "update_instance_notes", &args, binding);
        assert_eq!(registry.consume_at(start, "c3", "backup_instance", &args), None);

        registry.issue_at(start, "c4", "update_instance_notes", &args, binding);
        assert_eq!(
            registry.consume_at(start + APPROVAL_TTL, "c4", "update_instance_notes", &args),
            None
        );
        assert_eq!(registry.consume_at(start, "unknown", "update_instance_notes", &args), None);
    }

    #[test]
    fn issued_approvals_stay_bounded_and_drop_the_oldest_and_expired_first() {
        let registry = ApprovalRegistry::default();
        let args = json!({});
        let start = Instant::now();
        for index in 0..MAX_ISSUED_APPROVALS + 5 {
            registry.issue_at(
                start + Duration::from_millis(index as u64),
                &format!("c{index}"),
                "backup_instance",
                &args,
                TurnBinding::default(),
            );
        }
        assert_eq!(registry.len(), MAX_ISSUED_APPROVALS);
        let late = start + Duration::from_millis(1000);
        assert_eq!(registry.consume_at(late, "c0", "backup_instance", &args), None);
        assert!(registry
            .consume_at(late, &format!("c{}", MAX_ISSUED_APPROVALS + 4), "backup_instance", &args)
            .is_some());

        registry.issue_at(start + APPROVAL_TTL + Duration::from_secs(1), "fresh", "backup_instance", &args, TurnBinding::default());
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn detail_values_drop_control_and_direction_characters_and_stay_short() {
        assert_eq!(clean("Sodium\u{202E}evil\n", MAX_DETAIL_CHARS), ("Sodium evil".to_owned(), false));
        let long = format!("start-{}-end", "x".repeat(MAX_DETAIL_CHARS + 50));
        let (value, shortened) = clean(&long, MAX_DETAIL_CHARS);
        assert!(shortened);
        assert_eq!(value.chars().count(), MAX_DETAIL_CHARS + 1);
        assert!(value.starts_with("start-x"));
        assert!(value.ends_with("x-end"));
        assert!(value.contains('…'));
    }

    #[test]
    fn a_shortened_detail_is_marked_unresolved_and_addresses_fit_whole() {
        let mut details = Details { items: Vec::new() };
        details.push("notes", "n".repeat(MAX_DETAIL_CHARS + 1), false);
        details.push("notes", "short", false);
        let address = format!("{}.evil.example:25565", "a".repeat(MAX_ADDRESS_CHARS - 30));
        details.push("serverAddress", &address, false);
        assert!(details.items[0].unresolved);
        assert!(!details.items[1].unresolved);
        assert_eq!(details.items[2].value, address);
        assert!(!details.items[2].unresolved);
    }
}
