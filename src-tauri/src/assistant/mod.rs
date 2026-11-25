//! Built-in BYO-API assistant and opt-in localhost-only MCP server.

pub(crate) mod llm;
pub(crate) mod mcp;
pub(crate) mod tools;

use crate::{
    errors::{expected, AppResult},
    models::Config,
    processes::GameRegistry,
    server_manager::ServerRegistry,
    storage::LauncherState,
};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

pub use mcp::{McpService, McpStatus};

pub(crate) const ASSISTANT_SECRET_KEY: &str = "assistant_api_key";
pub(crate) const ASSISTANT_API_KEY_REQUIRED: &str = "请先在「设置 → 助手与 MCP」中保存你的 AI API Key";
pub(crate) const ASSISTANT_MODEL_REQUIRED: &str = "请先在「设置 → 助手与 MCP」中填写模型名称";
pub(crate) const ASSISTANT_INVALID_BASE_URL: &str = "助手 API 地址必须为 HTTPS 网址，或本机回环 HTTP（127.0.0.1 / localhost）";
pub(crate) const ASSISTANT_PROVIDER_ERROR: &str = "AI 服务请求失败";
pub(crate) const ASSISTANT_EMPTY_MESSAGE: &str = "请输入消息内容";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantStatus {
    pub api_key_configured: bool,
    pub provider: String,
    pub base_url: String,
    pub effective_base_url: String,
    pub model: String,
    pub permission: String,
    pub proactive: bool,
    pub loopback_endpoint: bool,
    pub ready: bool,
    pub mcp: McpStatus,
    pub tools: Vec<tools::ToolSummary>,
}

pub(crate) fn is_loopback_url(url: &reqwest::Url) -> bool {
    matches!(
        url.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    )
}

pub(crate) fn validate_base_url(raw: &str) -> Result<reqwest::Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 512 || trimmed.chars().any(char::is_control) {
        return Err(ASSISTANT_INVALID_BASE_URL.into());
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| ASSISTANT_INVALID_BASE_URL.to_owned())?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.host_str().is_none()
    {
        return Err(ASSISTANT_INVALID_BASE_URL.into());
    }
    let valid_scheme = match parsed.scheme() {
        "https" => true,
        "http" => is_loopback_url(&parsed),
        _ => false,
    };
    if !valid_scheme {
        return Err(ASSISTANT_INVALID_BASE_URL.into());
    }
    Ok(parsed)
}

pub(crate) fn validate_config(config: &Config) -> Result<(), String> {
    if !matches!(config.assistant_provider.as_str(), "openai" | "anthropic") {
        return Err("助手服务提供商无效".into());
    }
    if !matches!(
        config.assistant_permission.as_str(),
        "readOnly" | "controlled" | "fullAccess"
    ) {
        return Err("助手权限级别无效".into());
    }
    if config.assistant_mcp_port < 1024 {
        return Err("MCP 端口需要在 1024–65535 之间".into());
    }
    if config.assistant_model.chars().count() > 200
        || config.assistant_model.chars().any(char::is_control)
    {
        return Err("模型名称无效".into());
    }
    if !config.assistant_base_url.is_empty() {
        validate_base_url(&config.assistant_base_url)?;
    }
    Ok(())
}

fn build_status(state: &LauncherState, mcp: &McpService) -> Result<AssistantStatus, String> {
    let config = state.snapshot()?.config;
    let api_key_configured =
        crate::secrets::load_service_secret(&state.data_dir, ASSISTANT_SECRET_KEY)?
            .is_some_and(|value| !value.trim().is_empty());
    let provider = if config.assistant_provider == "anthropic" {
        "anthropic".to_owned()
    } else {
        "openai".to_owned()
    };
    let effective = llm::effective_base_url(&provider, &config.assistant_base_url);
    let loopback_endpoint = validate_base_url(&effective)
        .map(|url| is_loopback_url(&url))
        .unwrap_or(false);
    let ready = !config.assistant_model.trim().is_empty()
        && (api_key_configured || loopback_endpoint);
    Ok(AssistantStatus {
        api_key_configured,
        provider,
        base_url: config.assistant_base_url,
        effective_base_url: effective,
        model: config.assistant_model,
        permission: tools::PermissionTier::parse(&config.assistant_permission)
            .as_str()
            .to_owned(),
        proactive: config.assistant_proactive,
        loopback_endpoint,
        ready,
        mcp: mcp.status(config.assistant_mcp_port),
        tools: tools::summaries(),
    })
}

#[tauri::command]
pub fn get_assistant_status(
    state: State<'_, Arc<LauncherState>>,
    mcp: State<'_, Arc<McpService>>,
) -> AppResult<AssistantStatus> {
    build_status(&state, &mcp).map_err(expected)
}

#[tauri::command]
pub fn set_assistant_api_key(
    state: State<'_, Arc<LauncherState>>,
    secret: String,
) -> AppResult<bool> {
    let trimmed = secret.trim();
    if trimmed.len() > 4096 || trimmed.chars().any(char::is_control) {
        return Err(expected("API Key 格式无效"));
    }
    crate::secrets::save_service_secret(&state.data_dir, ASSISTANT_SECRET_KEY, trimmed)
        .map_err(expected)?;
    Ok(!trimmed.is_empty())
}

#[tauri::command]
pub async fn assistant_chat(
    app: tauri::AppHandle,
    state: State<'_, Arc<LauncherState>>,
    games: State<'_, Arc<GameRegistry>>,
    servers: State<'_, Arc<ServerRegistry>>,
    request: llm::AssistantTurnRequest,
) -> AppResult<llm::AssistantTurnResponse> {
    let ctx = tools::ToolContext {
        state: state.inner().clone(),
        games: games.inner().clone(),
        servers: servers.inner().clone(),
        app: Some(app),
    };
    llm::run_turn(&ctx, request).await.map_err(expected)
}

#[tauri::command]
pub async fn start_mcp_server(
    app: tauri::AppHandle,
    state: State<'_, Arc<LauncherState>>,
    games: State<'_, Arc<GameRegistry>>,
    servers: State<'_, Arc<ServerRegistry>>,
    mcp: State<'_, Arc<McpService>>,
    port: Option<u16>,
) -> AppResult<McpStatus> {
    let config_port = state.snapshot().map_err(expected)?.config.assistant_mcp_port;
    let target_port = port.unwrap_or(config_port);
    if target_port < 1024 {
        return Err(expected("MCP 端口需要在 1024–65535 之间"));
    }
    let ctx = tools::ToolContext {
        state: state.inner().clone(),
        games: games.inner().clone(),
        servers: servers.inner().clone(),
        app: Some(app),
    };
    mcp.start(ctx, target_port, tokio::runtime::Handle::current())
        .map_err(expected)
}

#[tauri::command]
pub fn stop_mcp_server(
    state: State<'_, Arc<LauncherState>>,
    mcp: State<'_, Arc<McpService>>,
) -> AppResult<McpStatus> {
    mcp.stop();
    let default_port = state.snapshot().map_err(expected)?.config.assistant_mcp_port;
    Ok(mcp.status(default_port))
}

#[tauri::command]
pub fn rotate_mcp_token(mcp: State<'_, Arc<McpService>>) -> AppResult<McpStatus> {
    mcp.rotate_token().map_err(expected)
}

#[tauri::command]
pub fn get_mcp_token(mcp: State<'_, Arc<McpService>>) -> AppResult<Option<String>> {
    Ok(mcp.token())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Account, Instance, Persisted};
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpStream;

    fn fixture_context() -> (tools::ToolContext, crate::instances::StagingDirectory) {
        let root = crate::instances::StagingDirectory::create(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/assistant-tests")
                .join(uuid::Uuid::new_v4().to_string()),
        )
        .unwrap();
        let data = root.path().join("data");
        let game = root.path().join("game");
        let inst_dir = game.join("instances/inst-1");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(inst_dir.join("mods")).unwrap();
        std::fs::create_dir_all(inst_dir.join("logs")).unwrap();
        std::fs::write(inst_dir.join("mods/sodium.jar"), b"synthetic-jar").unwrap();
        std::fs::write(
            inst_dir.join("logs/latest.log"),
            "[12:00:00] [main/INFO]: Starting game\n[12:00:01] [main/ERROR]: Authorization: Bearer super-secret-token\n",
        )
        .unwrap();

        let mut persisted = Persisted::default();
        persisted.config.game_directory = game.to_string_lossy().into_owned();
        persisted.config.assistant_permission = "readOnly".into();
        persisted.accounts.push(Account {
            id: "acc-1".into(),
            username: "SyntheticPlayer".into(),
            uuid: "11111111111111111111111111111111".into(),
            account_type: "microsoft".into(),
            is_selected: true,
            ..Default::default()
        });
        persisted.instances.push(Instance {
            id: "inst-1".into(),
            name: "Fabric Test".into(),
            version_id: "1.21.1".into(),
            game_directory: inst_dir.to_string_lossy().into_owned(),
            loader: "fabric".into(),
            loader_version: "0.16.5".into(),
            category: "survival".into(),
            notes: "Initial note".into(),
            ..Default::default()
        });
        let state = Arc::new(LauncherState::test_fixture(
            data,
            persisted,
            crate::storage::test_client(),
        ));
        let games = state.games.clone();
        let servers = Arc::new(ServerRegistry::default());
        (
            tools::ToolContext {
                state,
                games,
                servers,
                app: None,
            },
            root,
        )
    }

    #[test]
    fn u6_base_url_validation_allows_https_and_loopback_only() {
        assert!(validate_base_url("https://api.openai.com/v1").is_ok());
        assert!(validate_base_url("https://api.anthropic.com").is_ok());
        assert!(validate_base_url("http://127.0.0.1:11434/v1").is_ok());
        assert!(validate_base_url("http://localhost:1234/v1").is_ok());
        assert!(validate_base_url("http://[::1]:8080/v1").is_ok());
        assert!(validate_base_url("http://example.com/v1").is_err());
        assert!(validate_base_url("https://user:pass@api.openai.com/v1").is_err());
        assert!(validate_base_url("https://api.openai.com/v1?key=1").is_err());
        assert!(validate_base_url("file:///C:/Windows").is_err());
    }

    #[test]
    fn u6_openai_and_anthropic_payload_and_response_parsing() {
        let specs = tools::catalog_for_assistant(tools::PermissionTier::ReadOnly);
        let openai_req = llm::build_openai_payload(
            "gpt-4o-mini",
            &[json!({ "role": "user", "content": "List instances" })],
            &specs,
        );
        assert_eq!(openai_req["model"], "gpt-4o-mini");
        assert!(openai_req["tools"].as_array().unwrap().len() >= 10);

        let openai_resp = llm::parse_openai_response(&json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "list_instances",
                            "arguments": "{}"
                        }
                    }]
                }
            }]
        }))
        .unwrap();
        assert_eq!(openai_resp.tool_calls.len(), 1);
        assert_eq!(openai_resp.tool_calls[0].name, "list_instances");

        let anth_req = llm::build_anthropic_payload(
            "claude-sonnet-4-20250514",
            &[json!({ "role": "user", "content": "Check logs" })],
            &specs,
        );
        assert_eq!(anth_req["model"], "claude-sonnet-4-20250514");
        assert!(anth_req["tools"].as_array().unwrap()[0].get("input_schema").is_some());

        let anth_resp = llm::parse_anthropic_response(&json!({
            "content": [
                { "type": "text", "text": "Checking now." },
                { "type": "tool_use", "id": "toolu_1", "name": "read_instance_log", "input": { "instanceId": "inst-1" } }
            ]
        }))
        .unwrap();
        assert_eq!(anth_resp.text, "Checking now.");
        assert_eq!(anth_resp.tool_calls.len(), 1);
        assert_eq!(anth_resp.tool_calls[0].name, "read_instance_log");
    }

    #[test]
    fn u6_tools_enforce_permission_tiers_and_redact_logs() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
        let (ctx, _root) = fixture_context();

        let instances = tools::execute_tool(
            &ctx,
            "list_instances",
            &json!({}),
            tools::PermissionTier::ReadOnly,
            false,
        )
        .await
        .unwrap();
        assert_eq!(instances["count"], 1);
        assert_eq!(instances["instances"][0]["name"], "Fabric Test");

        // Accounts output must never leak tokens or secrets.
        let accounts = tools::execute_tool(
            &ctx,
            "list_accounts",
            &json!({}),
            tools::PermissionTier::ReadOnly,
            false,
        )
        .await
        .unwrap();
        assert_eq!(accounts["accounts"][0]["username"], "SyntheticPlayer");
        assert!(accounts["accounts"][0].get("accessToken").is_none());

        // Logs must redact Authorization Bearer tokens.
        let log = tools::execute_tool(
            &ctx,
            "read_instance_log",
            &json!({ "instanceId": "inst-1", "maxLines": 10 }),
            tools::PermissionTier::ReadOnly,
            false,
        )
        .await
        .unwrap();
        let serialized = log.to_string();
        assert!(!serialized.contains("super-secret-token"));
        assert!(serialized.contains("Starting game"));

        // Controlled write tool is blocked in ReadOnly and unapproved Controlled mode.
        assert!(matches!(
            tools::execute_tool(
                &ctx,
                "update_instance_notes",
                &json!({ "instanceId": "inst-1", "notes": "Updated" }),
                tools::PermissionTier::ReadOnly,
                false,
            )
            .await,
            Err(tools::ToolExecError::PermissionDenied(_))
        ));
        assert!(matches!(
            tools::execute_tool(
                &ctx,
                "update_instance_notes",
                &json!({ "instanceId": "inst-1", "notes": "Updated" }),
                tools::PermissionTier::Controlled,
                false,
            )
            .await,
            Err(tools::ToolExecError::PermissionDenied(_))
        ));

        // Approved Controlled call succeeds and updates instance notes.
        let updated = tools::execute_tool(
            &ctx,
            "update_instance_notes",
            &json!({ "instanceId": "inst-1", "notes": "Verified note", "category": "modded" }),
            tools::PermissionTier::Controlled,
            true,
        )
        .await
        .unwrap();
        assert_eq!(updated["notes"], "Verified note");
        assert_eq!(updated["category"], "modded");

        // Toggle local mod works in FullAccess mode.
        let toggled = tools::execute_tool(
            &ctx,
            "toggle_instance_resource",
            &json!({ "instanceId": "inst-1", "resourceType": "mod", "fileName": "sodium.jar" }),
            tools::PermissionTier::FullAccess,
            false,
        )
        .await
        .unwrap();
        assert_eq!(toggled["enabled"], false);
        assert_eq!(toggled["fileName"], "sodium.jar.disabled");
        });
    }

    fn raw_http_post(
        port: u16,
        path: &str,
        extra_headers: &str,
        body: &str,
    ) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra_headers}\r\n{body}",
            body.len()
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).unwrap();
        let status = resp
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok())
            .unwrap_or(0);
        let body = resp
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_owned())
            .unwrap_or_default();
        (status, body)
    }

    #[test]
    fn u6_mcp_server_auth_origin_and_jsonrpc_roundtrip() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
        let (ctx, _root) = fixture_context();
        let service = McpService::default();
        let started = service
            .start(ctx.clone(), 0, tokio::runtime::Handle::current())
            .unwrap();
        assert!(started.running);
        assert!(started.port > 0);
        let token = service.token().unwrap();

        // Missing token -> 401
        let (status, _) = raw_http_post(
            started.port,
            "/mcp",
            "",
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
        );
        assert_eq!(status, 401);

        // Cross-origin request -> 403
        let (status, _) = raw_http_post(
            started.port,
            "/mcp",
            &format!("Origin: https://evil.example\r\nAuthorization: Bearer {token}\r\n"),
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
        );
        assert_eq!(status, 403);

        // Valid initialize -> 200
        let auth = format!("Authorization: Bearer {token}\r\n");
        let (status, body) = raw_http_post(
            started.port,
            "/mcp",
            &auth,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        );
        assert_eq!(status, 200);
        let init: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], "voxelight-lumen");

        // tools/list in readOnly exposes read-only tools only
        let (status, body) = raw_http_post(
            started.port,
            "/mcp",
            &auth,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        );
        assert_eq!(status, 200);
        let listed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let names: Vec<&str> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["name"].as_str())
            .collect();
        assert!(names.contains(&"list_instances"));
        assert!(!names.contains(&"update_instance_notes"));

        // tools/call list_instances succeeds
        let (status, body) = raw_http_post(
            started.port,
            "/mcp",
            &auth,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_instances","arguments":{}}}"#,
        );
        assert_eq!(status, 200);
        let called: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(called["result"]["isError"], false);
        assert!(called["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Fabric Test"));

        // tools/call write tool in readOnly mode returns JSON-RPC -32003
        let (status, body) = raw_http_post(
            started.port,
            "/mcp",
            &auth,
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"update_instance_notes","arguments":{"instanceId":"inst-1","notes":"x"}}}"#,
        );
        assert_eq!(status, 200);
        let denied: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(denied["error"]["code"], -32003);

        // Rotating token immediately invalidates old token
        let rotated = service.rotate_token().unwrap();
        assert!(rotated.running);
        let (status, _) = raw_http_post(
            started.port,
            "/mcp",
            &auth,
            r#"{"jsonrpc":"2.0","id":5,"method":"ping"}"#,
        );
        assert_eq!(status, 401);

        let stopped = service.stop();
        assert!(!stopped.running);
        });
    }

    #[test]
    fn u6_config_defaults_and_old_profiles_remain_compatible() {
        let config = Config::default();
        assert_eq!(config.assistant_provider, "openai");
        assert_eq!(config.assistant_permission, "readOnly");
        assert_eq!(config.assistant_mcp_port, 25590);

        let mut old = serde_json::to_value(&config).unwrap();
        for key in [
            "assistantProvider",
            "assistantBaseUrl",
            "assistantModel",
            "assistantPermission",
            "assistantMcpPort",
        ] {
            old.as_object_mut().unwrap().remove(key);
        }
        let decoded: Config = serde_json::from_value(old).unwrap();
        assert_eq!(decoded.assistant_provider, "openai");
        assert_eq!(decoded.assistant_permission, "readOnly");
        assert_eq!(decoded.assistant_mcp_port, 25590);
        assert!(decoded.assistant_proactive);
    }

    #[test]
    fn u7_lumen_expanded_tools_and_factory_reset_preserve_game_files() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (ctx, _root) = fixture_context();
            assert_eq!(tools::catalog().len(), 39);
            assert!(tools::catalog().iter().any(|t| t.name == "detect_local_proxies"));

            // get_launcher_config exposes safe config without leaking secrets
            crate::secrets::save_service_secret(&ctx.state.data_dir, ASSISTANT_SECRET_KEY, "sk-lumen-secret")
                .unwrap();
            crate::secrets::save_service_secret(&ctx.state.data_dir, "curseforge", "cf-secret")
                .unwrap();
            let cfg = tools::execute_tool(
                &ctx,
                "get_launcher_config",
                &json!({}),
                tools::PermissionTier::ReadOnly,
                false,
            )
            .await
            .unwrap();
            assert!(!cfg.to_string().contains("sk-lumen-secret"));
            assert!(!cfg.to_string().contains("cf-secret"));
            assert_eq!(cfg["assistantPermission"], "readOnly");

            // save_multiplayer_server + list_multiplayer_servers roundtrip
            let saved = tools::execute_tool(
                &ctx,
                "save_multiplayer_server",
                &json!({ "instanceId": "inst-1", "name": "Voxel SMP", "address": "play.example.org:25565" }),
                tools::PermissionTier::Controlled,
                true,
            )
            .await
            .unwrap();
            assert_eq!(saved["count"], 1);
            let listed = tools::execute_tool(
                &ctx,
                "list_multiplayer_servers",
                &json!({ "instanceId": "inst-1" }),
                tools::PermissionTier::ReadOnly,
                false,
            )
            .await
            .unwrap();
            assert_eq!(listed["count"], 1);
            assert_eq!(listed["servers"][0]["name"], "Voxel SMP");

            // update_instance_settings updates memory/window cleanly
            let updated = tools::execute_tool(
                &ctx,
                "update_instance_settings",
                &json!({ "instanceId": "inst-1", "screenWidth": 1600, "screenHeight": 900, "notes": "Lumen tuned" }),
                tools::PermissionTier::Controlled,
                true,
            )
            .await
            .unwrap();
            assert_eq!(updated["screenWidth"], 1600);
            assert_eq!(updated["notes"], "Lumen tuned");

            // Factory reset refuses while a managed server is running
            let auth = crate::auth::AuthService::new(
                ctx.state.data_dir.clone(),
                &ctx.state.snapshot().unwrap().config,
            );
            let mcp = McpService::default();
            let started_mcp = mcp
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap();
            assert!(started_mcp.running);
            ctx.servers.fixture_alive("srv-live");
            assert!(crate::commands::reset_launcher_state_inner(&ctx.state, &auth, &ctx.servers, &mcp)
                .await
                .is_err());

            // With no running servers/games, factory reset restores defaults, clears secrets & stops MCP,
            // while preserving instance game files on disk.
            let clean_servers = ServerRegistry::default();
            let inst_mod = std::path::PathBuf::from(
                &ctx.state.snapshot().unwrap().instances[0].game_directory,
            )
            .join("mods/sodium.jar");
            assert!(inst_mod.is_file());

            let reset_cfg = crate::commands::reset_launcher_state_inner(
                &ctx.state,
                &auth,
                &clean_servers,
                &mcp,
            )
            .await
            .unwrap();
            assert!(!reset_cfg.tour_completed);
            assert_eq!(reset_cfg.theme, "system");
            assert_eq!(reset_cfg.game_proxy_mode, "system");
            assert_eq!(reset_cfg.assistant_model, "");
            assert!(!mcp.status(25590).running);
            let snap = ctx.state.snapshot().unwrap();
            assert!(snap.accounts.is_empty());
            assert!(snap.instances.is_empty());
            assert!(crate::secrets::load_service_secret(&ctx.state.data_dir, ASSISTANT_SECRET_KEY)
                .unwrap()
                .is_none());
            assert!(crate::secrets::load_service_secret(&ctx.state.data_dir, "curseforge")
                .unwrap()
                .is_none());
            assert!(inst_mod.is_file(), "game files on disk must never be deleted");
        });
    }
}
