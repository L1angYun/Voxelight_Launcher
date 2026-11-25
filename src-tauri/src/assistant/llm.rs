//! BYO-API LLM client supporting OpenAI-compatible Chat Completions and Anthropic Messages,
//! with launcher proxy integration, strict URL validation, tool-call looping, and explicit
//! confirmation pauses under Controlled permission mode.

use super::{
    is_loopback_url,
    tools::{self, PermissionTier, ToolContext, ToolSpec, ToolTier},
    validate_base_url, ASSISTANT_API_KEY_REQUIRED, ASSISTANT_EMPTY_MESSAGE,
    ASSISTANT_INVALID_BASE_URL, ASSISTANT_MODEL_REQUIRED, ASSISTANT_PROVIDER_ERROR,
};
use crate::models::Config;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOOL_ROUNDS: usize = 5;
const MAX_HISTORY_MESSAGES: usize = 40;
const MAX_MESSAGE_CHARS: usize = 16_000;
const SYSTEM_PROMPT: &str = "You are the built-in assistant inside Voxelight Launcher (a Minecraft: Java Edition launcher). \
Use the available launcher tools whenever you need real data about instances, installed versions, mods, resource packs, logs, \
crash diagnostics, memory, downloads, running games, or managed servers. Reply concisely in the user's language. \
Never invent file paths, mod names, error logs, or account credentials.";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolTraceItem {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub tier: String,
    pub status: String,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedToolResult {
    pub id: String,
    pub name: String,
    pub output_json: String,
    pub is_error: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingContinuation {
    pub provider: String,
    pub provider_messages: Vec<Value>,
    pub completed_results: Vec<CompletedToolResult>,
    pub pending_calls: Vec<PendingToolCall>,
    pub round: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTurnRequest {
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub approved_call_ids: Vec<String>,
    #[serde(default)]
    pub denied_call_ids: Vec<String>,
    #[serde(default)]
    pub pending_continuation: Option<PendingContinuation>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTurnResponse {
    pub reply: String,
    pub traces: Vec<ToolTraceItem>,
    pub pending_approvals: Vec<PendingToolCall>,
    pub continuation: Option<PendingContinuation>,
    pub model: String,
    pub provider: String,
}

#[derive(Clone, Debug)]
pub(crate) struct RawToolCall {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: Value,
}

#[derive(Clone, Debug)]
pub(crate) struct ProviderTurn {
    pub(crate) text: String,
    pub(crate) tool_calls: Vec<RawToolCall>,
    pub(crate) assistant_message: Value,
}

pub fn effective_base_url(provider: &str, configured: &str) -> String {
    let trimmed = configured.trim();
    if !trimmed.is_empty() {
        return trimmed.to_owned();
    }
    if provider == "anthropic" {
        DEFAULT_ANTHROPIC_BASE_URL.to_owned()
    } else {
        DEFAULT_OPENAI_BASE_URL.to_owned()
    }
}

pub fn resolve_endpoint_url(provider: &str, base: &str) -> Result<reqwest::Url, String> {
    let base_url = validate_base_url(base).map_err(|_| ASSISTANT_INVALID_BASE_URL.to_owned())?;
    let trimmed = base_url.as_str().trim_end_matches('/');
    let full = if provider == "anthropic" {
        if trimmed.ends_with("/v1/messages") {
            trimmed.to_owned()
        } else if trimmed.ends_with("/v1") {
            format!("{trimmed}/messages")
        } else {
            format!("{trimmed}/v1/messages")
        }
    } else if trimmed.ends_with("/chat/completions") {
        trimmed.to_owned()
    } else {
        format!("{trimmed}/chat/completions")
    };
    reqwest::Url::parse(&full).map_err(|_| ASSISTANT_INVALID_BASE_URL.to_owned())
}

fn build_http_client(
    data_dir: &std::path::Path,
    config: &Config,
) -> Result<reqwest::Client, String> {
    // Never follow HTTP redirects for LLM API calls so API keys are never sent to another host.
    let builder = reqwest::Client::builder()
        .user_agent(concat!("VoxelightLauncher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none());
    crate::network::for_config_builder(data_dir, config, builder)?
        .build()
        .map_err(|_| ASSISTANT_PROVIDER_ERROR.to_owned())
}

fn sanitize_error(text: &str, api_key: Option<&str>) -> String {
    let mut cleaned = crate::processes::redact(text);
    if let Some(key) = api_key.filter(|value| value.len() >= 6) {
        cleaned = cleaned.replace(key, "[redacted]");
    }
    let chars: Vec<char> = cleaned.chars().collect();
    if chars.len() > 240 {
        let head: String = chars[..240].iter().collect();
        format!("{head}…")
    } else {
        cleaned
    }
}

pub(crate) fn build_openai_payload(
    model: &str,
    messages: &[Value],
    specs: &[ToolSpec],
) -> Value {
    let mut all_messages = Vec::with_capacity(messages.len() + 1);
    all_messages.push(json!({ "role": "system", "content": SYSTEM_PROMPT }));
    all_messages.extend(messages.iter().cloned());

    let mut body = json!({
        "model": model,
        "messages": all_messages,
    });
    if !specs.is_empty() {
        let tools_json: Vec<Value> = specs
            .iter()
            .map(|spec| {
                json!({
                    "type": "function",
                    "function": {
                        "name": spec.name,
                        "description": spec.description,
                        "parameters": spec.input_schema,
                    }
                })
            })
            .collect();
        body["tools"] = Value::Array(tools_json);
    }
    body
}

pub(crate) fn parse_openai_response(body: &Value) -> Result<ProviderTurn, String> {
    let message = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .ok_or_else(|| "Missing choices[0].message in OpenAI-compatible response".to_owned())?;

    let text = match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };

    let mut tool_calls = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
        for (index, call) in calls.iter().enumerate() {
            let id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("call_{index}"));
            let function = call.get("function").unwrap_or(&Value::Null);
            let Some(name) = function.get("name").and_then(Value::as_str) else {
                continue;
            };
            let arguments = match function.get("arguments") {
                Some(Value::String(raw)) => {
                    serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({}))
                }
                Some(Value::Object(map)) => Value::Object(map.clone()),
                _ => json!({}),
            };
            tool_calls.push(RawToolCall {
                id,
                name: name.to_owned(),
                arguments,
            });
        }
    }

    let mut assistant_message = json!({
        "role": "assistant",
        "content": if text.is_empty() && !tool_calls.is_empty() { Value::Null } else { Value::String(text.clone()) },
    });
    if let Some(raw_calls) = message.get("tool_calls").filter(|v| v.is_array()) {
        assistant_message["tool_calls"] = raw_calls.clone();
    }

    Ok(ProviderTurn {
        text,
        tool_calls,
        assistant_message,
    })
}

pub(crate) fn build_anthropic_payload(
    model: &str,
    messages: &[Value],
    specs: &[ToolSpec],
) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": 2048,
        "system": SYSTEM_PROMPT,
        "messages": messages,
    });
    if !specs.is_empty() {
        let tools_json: Vec<Value> = specs
            .iter()
            .map(|spec| {
                json!({
                    "name": spec.name,
                    "description": spec.description,
                    "input_schema": spec.input_schema,
                })
            })
            .collect();
        body["tools"] = Value::Array(tools_json);
    }
    body
}

pub(crate) fn parse_anthropic_response(body: &Value) -> Result<ProviderTurn, String> {
    let content = body
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing content array in Anthropic response".to_owned())?;

    let mut text_parts = Vec::new();
    let mut tool_calls = Vec::new();
    for (index, block) in content.iter().enumerate() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    if !t.is_empty() {
                        text_parts.push(t.to_owned());
                    }
                }
            }
            Some("tool_use") => {
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("toolu_{index}"));
                if let Some(name) = block.get("name").and_then(Value::as_str) {
                    let arguments = block.get("input").cloned().unwrap_or_else(|| json!({}));
                    tool_calls.push(RawToolCall {
                        id,
                        name: name.to_owned(),
                        arguments,
                    });
                }
            }
            _ => {}
        }
    }

    Ok(ProviderTurn {
        text: text_parts.join("\n"),
        tool_calls,
        assistant_message: json!({
            "role": "assistant",
            "content": content,
        }),
    })
}

fn append_tool_results(
    provider: &str,
    provider_messages: &mut Vec<Value>,
    results: &[CompletedToolResult],
) {
    if provider == "anthropic" {
        let blocks: Vec<Value> = results
            .iter()
            .map(|item| {
                let mut block = json!({
                    "type": "tool_result",
                    "tool_use_id": item.id,
                    "content": item.output_json,
                });
                if item.is_error {
                    block["is_error"] = Value::Bool(true);
                }
                block
            })
            .collect();
        provider_messages.push(json!({
            "role": "user",
            "content": blocks,
        }));
    } else {
        for item in results {
            provider_messages.push(json!({
                "role": "tool",
                "tool_call_id": item.id,
                "content": item.output_json,
            }));
        }
    }
}

fn summarize_output(value: &Value) -> String {
    let text = serde_json::to_string(value).unwrap_or_else(|_| "{}".into());
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > 160 {
        let head: String = chars[..160].iter().collect();
        format!("{head}…")
    } else {
        text
    }
}

async fn send_provider_request(
    client: &reqwest::Client,
    provider: &str,
    url: &reqwest::Url,
    api_key: Option<&str>,
    model: &str,
    provider_messages: &[Value],
    specs: &[ToolSpec],
) -> Result<ProviderTurn, String> {
    let payload = if provider == "anthropic" {
        build_anthropic_payload(model, provider_messages, specs)
    } else {
        build_openai_payload(model, provider_messages, specs)
    };

    let mut request = client.post(url.clone()).json(&payload);
    if provider == "anthropic" {
        request = request.header("anthropic-version", ANTHROPIC_VERSION);
        if let Some(key) = api_key.filter(|k| !k.is_empty()) {
            request = request.header("x-api-key", key);
        }
    } else if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("{ASSISTANT_PROVIDER_ERROR}: {}", sanitize_error(&error.to_string(), api_key)))?;
    let status = response.status();
    let raw_body = response
        .text()
        .await
        .map_err(|error| format!("{ASSISTANT_PROVIDER_ERROR}: {}", sanitize_error(&error.to_string(), api_key)))?;

    if !status.is_success() {
        let preview = sanitize_error(&raw_body, api_key);
        return Err(format!(
            "{ASSISTANT_PROVIDER_ERROR}: HTTP {} — {preview}",
            status.as_u16()
        ));
    }

    let parsed: Value = serde_json::from_str(&raw_body)
        .map_err(|error| format!("{ASSISTANT_PROVIDER_ERROR}: invalid JSON ({error})"))?;
    if provider == "anthropic" {
        parse_anthropic_response(&parsed)
    } else {
        parse_openai_response(&parsed)
    }
    .map_err(|detail| format!("{ASSISTANT_PROVIDER_ERROR}: {detail}"))
}

fn validate_chat_history(messages: &[ChatMessage]) -> Result<Vec<Value>, String> {
    if messages.is_empty() {
        return Err(ASSISTANT_EMPTY_MESSAGE.to_owned());
    }
    let slice = if messages.len() > MAX_HISTORY_MESSAGES {
        &messages[messages.len() - MAX_HISTORY_MESSAGES..]
    } else {
        messages
    };
    let mut converted = Vec::with_capacity(slice.len());
    for message in slice {
        let role = match message.role.as_str() {
            "user" => "user",
            "assistant" => "assistant",
            _ => continue,
        };
        let trimmed = message.content.trim();
        if trimmed.is_empty() {
            continue;
        }
        let content: String = trimmed.chars().take(MAX_MESSAGE_CHARS).collect();
        converted.push(json!({ "role": role, "content": content }));
    }
    if converted.is_empty() {
        return Err(ASSISTANT_EMPTY_MESSAGE.to_owned());
    }
    Ok(converted)
}

pub async fn run_turn(
    ctx: &ToolContext,
    request: AssistantTurnRequest,
) -> Result<AssistantTurnResponse, String> {
    let config = ctx.state.snapshot()?.config;
    let provider = if config.assistant_provider == "anthropic" {
        "anthropic"
    } else {
        "openai"
    };
    let model = config.assistant_model.trim().to_owned();
    if model.is_empty() {
        return Err(ASSISTANT_MODEL_REQUIRED.to_owned());
    }
    let base = effective_base_url(provider, &config.assistant_base_url);
    let url = resolve_endpoint_url(provider, &base)?;
    let api_key = crate::secrets::load_service_secret(&ctx.state.data_dir, super::ASSISTANT_SECRET_KEY)?
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if api_key.is_none() && !is_loopback_url(&url) {
        return Err(ASSISTANT_API_KEY_REQUIRED.to_owned());
    }

    let permission = PermissionTier::parse(&config.assistant_permission);
    let specs = tools::catalog_for_assistant(permission);
    let client = build_http_client(&ctx.state.data_dir, &config)?;

    let mut traces = Vec::new();
    let mut provider_messages;
    let mut round;

    if let Some(continuation) = request.pending_continuation {
        if continuation.provider != provider {
            return Err("助手提供商配置已变更，请重新发送消息".into());
        }
        provider_messages = continuation.provider_messages;
        round = continuation.round;
        let approved: HashSet<String> = request.approved_call_ids.into_iter().collect();
        let denied: HashSet<String> = request.denied_call_ids.into_iter().collect();
        let mut results = continuation.completed_results;

        for call in continuation.pending_calls {
            let is_approved = approved.contains(&call.id) && !denied.contains(&call.id);
            if is_approved && permission != PermissionTier::ReadOnly {
                match tools::execute_tool(ctx, &call.name, &call.arguments, permission, true).await {
                    Ok(value) => {
                        let output_json =
                            serde_json::to_string(&value).unwrap_or_else(|_| "{}".into());
                        traces.push(ToolTraceItem {
                            id: call.id.clone(),
                            name: call.name.clone(),
                            arguments: call.arguments.clone(),
                            tier: ToolTier::Controlled.as_str().into(),
                            status: "approved".into(),
                            summary: summarize_output(&value),
                        });
                        results.push(CompletedToolResult {
                            id: call.id,
                            name: call.name,
                            output_json,
                            is_error: false,
                        });
                    }
                    Err(error) => {
                        let msg = error.message().to_owned();
                        traces.push(ToolTraceItem {
                            id: call.id.clone(),
                            name: call.name.clone(),
                            arguments: call.arguments.clone(),
                            tier: ToolTier::Controlled.as_str().into(),
                            status: "error".into(),
                            summary: msg.clone(),
                        });
                        results.push(CompletedToolResult {
                            id: call.id,
                            name: call.name,
                            output_json: json!({ "error": msg }).to_string(),
                            is_error: true,
                        });
                    }
                }
            } else {
                let reason = if permission == PermissionTier::ReadOnly {
                    "Action blocked because permission is now Read-only."
                } else {
                    "User denied this action."
                };
                traces.push(ToolTraceItem {
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                    tier: ToolTier::Controlled.as_str().into(),
                    status: if permission == PermissionTier::ReadOnly {
                        "blocked".into()
                    } else {
                        "denied".into()
                    },
                    summary: reason.into(),
                });
                results.push(CompletedToolResult {
                    id: call.id,
                    name: call.name,
                    output_json: json!({ "denied": true, "reason": reason }).to_string(),
                    is_error: true,
                });
            }
        }
        append_tool_results(provider, &mut provider_messages, &results);
        round += 1;
    } else {
        provider_messages = validate_chat_history(&request.messages)?;
        round = 0;
    }

    loop {
        let turn = send_provider_request(
            &client,
            provider,
            &url,
            api_key.as_deref(),
            &model,
            &provider_messages,
            &specs,
        )
        .await?;

        if turn.tool_calls.is_empty() || round >= MAX_TOOL_ROUNDS {
            return Ok(AssistantTurnResponse {
                reply: turn.text,
                traces,
                pending_approvals: Vec::new(),
                continuation: None,
                model,
                provider: provider.to_owned(),
            });
        }

        provider_messages.push(turn.assistant_message);
        let mut completed_results = Vec::new();
        let mut pending_calls = Vec::new();

        for call in turn.tool_calls {
            let spec = tools::find_tool(&call.name);
            let tier = spec.as_ref().map(|item| item.tier).unwrap_or(ToolTier::ReadOnly);

            if tier == ToolTier::Controlled && permission == PermissionTier::Controlled {
                pending_calls.push(PendingToolCall {
                    id: call.id,
                    name: call.name,
                    arguments: call.arguments,
                    description: spec
                        .map(|item| item.description.to_owned())
                        .unwrap_or_default(),
                });
                continue;
            }

            let allow_controlled = permission == PermissionTier::FullAccess;
            match tools::execute_tool(ctx, &call.name, &call.arguments, permission, allow_controlled)
                .await
            {
                Ok(value) => {
                    let output_json =
                        serde_json::to_string(&value).unwrap_or_else(|_| "{}".into());
                    traces.push(ToolTraceItem {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        arguments: call.arguments.clone(),
                        tier: tier.as_str().into(),
                        status: "executed".into(),
                        summary: summarize_output(&value),
                    });
                    completed_results.push(CompletedToolResult {
                        id: call.id,
                        name: call.name,
                        output_json,
                        is_error: false,
                    });
                }
                Err(error) => {
                    let status = match error {
                        tools::ToolExecError::PermissionDenied(_) => "blocked",
                        _ => "error",
                    };
                    let msg = error.message().to_owned();
                    traces.push(ToolTraceItem {
                        id: call.id.clone(),
                        name: call.name.clone(),
                        arguments: call.arguments.clone(),
                        tier: tier.as_str().into(),
                        status: status.into(),
                        summary: msg.clone(),
                    });
                    completed_results.push(CompletedToolResult {
                        id: call.id,
                        name: call.name,
                        output_json: json!({ "error": msg }).to_string(),
                        is_error: true,
                    });
                }
            }
        }

        if !pending_calls.is_empty() {
            return Ok(AssistantTurnResponse {
                reply: turn.text,
                traces,
                pending_approvals: pending_calls.clone(),
                continuation: Some(PendingContinuation {
                    provider: provider.to_owned(),
                    provider_messages,
                    completed_results,
                    pending_calls,
                    round,
                }),
                model,
                provider: provider.to_owned(),
            });
        }

        append_tool_results(provider, &mut provider_messages, &completed_results);
        round += 1;
    }
}
