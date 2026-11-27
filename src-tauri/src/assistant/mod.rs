//! Built-in BYO-API assistant and opt-in localhost-only MCP server.

pub(crate) mod approval;
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
pub(crate) const ASSISTANT_API_KEY_REQUIRED: &str = "请先在「设置 → Lumen 与 MCP」中保存你的 AI API Key";
pub(crate) const ASSISTANT_MODEL_REQUIRED: &str = "请先在「设置 → Lumen 与 MCP」中填写模型名称";
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
    mcp: State<'_, Arc<McpService>>,
    request: llm::AssistantTurnRequest,
) -> AppResult<llm::AssistantTurnResponse> {
    let mcp_status = mcp.status(0);
    let ctx = tools::ToolContext {
        state: state.inner().clone(),
        games: games.inner().clone(),
        servers: servers.inner().clone(),
        app: Some(app),
        mcp_port: mcp_status.running.then_some(mcp_status.port),
        mcp_session: None,
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
        mcp_port: Some(target_port),
        mcp_session: None,
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

    /// The staging directory comes first, so `let (_root, ctx)` drops the
    /// context, and with it the profile lock, before the directory is removed.
    fn fixture_context() -> (crate::instances::StagingDirectory, tools::ToolContext) {
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
            root,
            tools::ToolContext {
                state,
                games,
                servers,
                app: None,
                mcp_port: None,
                mcp_session: None,
            },
        )
    }

    #[test]
    fn fixture_directory_is_removed_when_a_test_ends() {
        let directory = {
            let (root, ctx) = fixture_context();
            assert_eq!(ctx.state.snapshot().unwrap().instances.len(), 1);
            assert!(root.path().join("data/launcher-profile.lock").is_file());
            root.path().to_path_buf()
        };
        assert!(!directory.exists(), "{} is left behind", directory.display());
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
        let (_root, ctx) = fixture_context();

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

        // Approved Controlled call succeeds and updates instance notes. Writes read the saved
        // permission again before they run, so the settings grant the tier passed here.
        set_permission(&ctx, "controlled");
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
        set_permission(&ctx, "fullAccess");
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
        let (_root, ctx) = fixture_context();
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
            let (_root, ctx) = fixture_context();
            assert_eq!(tools::catalog().len(), 39);
            assert!(tools::catalog().iter().any(|t| t.name == "detect_local_proxies"));

            // get_launcher_config exposes safe config without leaking secrets
            crate::secrets::save_service_secret(&ctx.state.data_dir, ASSISTANT_SECRET_KEY, "sk-lumen-secret")
                .unwrap();
            crate::secrets::save_service_secret(
                &ctx.state.data_dir,
                crate::curseforge_key::CURSEFORGE_SECRET_KEY,
                "cf-secret",
            )
            .unwrap();
            let secret_store = crate::secrets::SecretStore::new(ctx.state.data_dir.clone());
            secret_store
                .set("account:pending-acc-99", "orphaned-token")
                .unwrap();
            ctx.state
                .update(|data| {
                    data.pending_credential_removals.insert("pending-acc-99".into());
                    Ok(())
                })
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
            set_permission(&ctx, "controlled");
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
            assert!(crate::secrets::load_service_secret(
                &ctx.state.data_dir,
                crate::curseforge_key::CURSEFORGE_SECRET_KEY
            )
            .unwrap()
            .is_none());
            assert!(secret_store
                .get("account:pending-acc-99")
                .unwrap()
                .is_none());
            assert!(inst_mod.is_file(), "game files on disk must never be deleted");
        });
    }

    #[test]
    fn u7_mcp_stop_never_deadlocks_while_operation_lock_is_held_and_bare_bearer_redacts() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            ctx.state
                .update(|data| {
                    data.config.assistant_permission = "fullAccess".into();
                    Ok(())
                })
                .unwrap();
            let mcp = Arc::new(McpService::default());
            let started = mcp
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap();
            let token = mcp.token().unwrap();

            // Hold state.operation (simulating reset_launcher_state_inner) while an MCP write tool
            // tries to acquire state.operation, then verify mcp.stop() returns promptly without deadlock.
            let op_guard = ctx.state.operation.lock().await;
            let port = started.port;
            let auth = format!("Authorization: Bearer {token}\r\n");
            let client_task = std::thread::spawn(move || {
                let _ = raw_http_post(
                    port,
                    "/mcp",
                    &auth,
                    r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_instance_notes","arguments":{"instanceId":"inst-1","notes":"race"}}}"#,
                );
            });
            std::thread::sleep(std::time::Duration::from_millis(60));
            // Missing Host header must be rejected with 400 Bad Request (DNS-rebinding defense).
            let mut no_host_stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let req = format!(
                "POST /mcp HTTP/1.1\r\nContent-Length: 2\r\nAuthorization: Bearer {token}\r\n\r\n{{}}"
            );
            no_host_stream.write_all(req.as_bytes()).unwrap();
            let mut no_host_resp = String::new();
            no_host_stream.read_to_string(&mut no_host_resp).unwrap();
            assert!(no_host_resp.starts_with("HTTP/1.1 400 "), "{no_host_resp}");

            let stop_start = std::time::Instant::now();
            let stopped = mcp.stop();
            assert!(!stopped.running);
            assert!(
                stop_start.elapsed() < std::time::Duration::from_secs(2),
                "mcp.stop() must not wait on in-flight tool holding/waiting on state.operation"
            );
            drop(op_guard);
            let _ = client_task.join();

            // Bare Bearer tokens (both bare and quoted) must be redacted.
            let redacted = crate::processes::redact("token leaked: Bearer eyJhbGciOiJIUzI1NiJ9.secret");
            assert!(!redacted.contains("eyJhbGciOiJIUzI1NiJ9.secret"));
            let quoted_redacted = crate::processes::redact(r#"token leaked: Bearer "quoted-secret-token""#);
            assert!(!quoted_redacted.contains("quoted-secret-token"));
        });
    }

    fn raw_http(port: u16, request: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(20)))
            .unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        let mut chunk = [0u8; 4096];
        // The server closes right after answering; a reset after the answer still keeps it.
        while let Ok(n) = stream.read(&mut chunk) {
            if n == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..n]);
        }
        let resp = String::from_utf8_lossy(&raw).into_owned();
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

    fn tool_call(name: &str, arguments: serde_json::Value) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": name, "arguments": arguments },
        })
        .to_string()
    }

    fn mcp_call(port: u16, token: &str, body: &str) -> serde_json::Value {
        let (status, text) = raw_http_post(
            port,
            "/mcp",
            &format!("Authorization: Bearer {token}\r\n"),
            body,
        );
        assert_eq!(status, 200, "{text}");
        serde_json::from_str(&text).unwrap()
    }

    fn listed_tools(port: u16, token: &str) -> Vec<String> {
        let listed = mcp_call(
            port,
            token,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        );
        listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|item| item["name"].as_str().map(str::to_owned))
            .collect()
    }

    fn result_text(response: &serde_json::Value) -> String {
        response["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    fn notes(ctx: &tools::ToolContext) -> String {
        ctx.state.snapshot().unwrap().instances[0].notes.clone()
    }

    fn set_permission(ctx: &tools::ToolContext, permission: &str) {
        ctx.state
            .update(|data| {
                data.config.assistant_permission = permission.into();
                Ok(())
            })
            .unwrap();
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let started = std::time::Instant::now();
        while !done() {
            assert!(
                started.elapsed() < std::time::Duration::from_secs(10),
                "timed out waiting for {what}"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    fn install_fixture_version(ctx: &tools::ToolContext) {
        let game = std::path::PathBuf::from(&ctx.state.snapshot().unwrap().config.game_directory);
        let version = game.join("versions/1.21.1");
        std::fs::create_dir_all(&version).unwrap();
        std::fs::write(
            version.join("1.21.1.json"),
            r#"{"id":"1.21.1","type":"release","mainClass":"net.minecraft.client.main.Main"}"#,
        )
        .unwrap();
        std::fs::write(version.join("1.21.1.jar"), b"synthetic-client").unwrap();
    }

    fn file_tree(root: &std::path::Path) -> Vec<String> {
        let mut found = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                found.push(path.strip_prefix(root).unwrap().to_string_lossy().into_owned());
                if path.is_dir() {
                    pending.push(path);
                }
            }
        }
        found.sort();
        found
    }

    #[test]
    fn mcp_rejects_foreign_hosts_null_origins_and_oversized_or_chunked_bodies() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            let service = McpService::default();
            let port = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap()
                .port;
            let token = service.token().unwrap();
            let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
            let request = |headers: &str, body: &str| {
                format!(
                    "POST /mcp HTTP/1.1\r\n{headers}Authorization: Bearer {token}\r\nContent-Type: application/json\r\n\r\n{body}"
                )
            };

            let (status, body) = raw_http(
                port,
                &request(
                    &format!("Host: attacker.example:25590\r\nContent-Length: {}\r\n", ping.len()),
                    ping,
                ),
            );
            assert_eq!(status, 403, "{body}");
            assert!(body.contains("forbidden_host"), "{body}");

            let (status, body) = raw_http(
                port,
                &request(
                    &format!(
                        "Host: 127.0.0.1:{port}\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n",
                        ping.len()
                    ),
                    ping,
                ),
            );
            assert_eq!(status, 403, "a second Host header is refused: {body}");
            assert!(body.contains("forbidden_host"), "{body}");

            let (status, body) = raw_http(
                port,
                &request(
                    &format!("Host: 127.0.0.1:{port}\r\nOrigin: null\r\nContent-Length: {}\r\n", ping.len()),
                    ping,
                ),
            );
            assert_eq!(status, 403, "{body}");
            assert!(body.contains("forbidden_origin"), "{body}");

            // Only the headers are sent, so the server refuses before any body arrives.
            let (status, body) = raw_http(
                port,
                &request(
                    &format!("Host: 127.0.0.1:{port}\r\nContent-Length: {}\r\n", 1024 * 1024 + 1),
                    "",
                ),
            );
            assert_eq!(status, 413, "{body}");
            assert!(body.contains("payload_too_large"), "{body}");

            let (status, body) = raw_http(
                port,
                &request(&format!("Host: 127.0.0.1:{port}\r\nTransfer-Encoding: chunked\r\n"), ""),
            );
            assert_eq!(status, 413, "{body}");
            assert!(body.contains("payload_too_large"), "{body}");

            // The same request with an allowed Host still works.
            let (status, body) = raw_http(
                port,
                &request(
                    &format!("Host: localhost:{port}\r\nContent-Length: {}\r\n", ping.len()),
                    ping,
                ),
            );
            assert_eq!(status, 200, "{body}");
            service.stop();
        });
    }

    #[test]
    fn mcp_offers_write_tools_only_with_full_access() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            let service = McpService::default();
            let port = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap()
                .port;
            let token = service.token().unwrap();
            let write = tool_call(
                "update_instance_notes",
                json!({ "instanceId": "inst-1", "notes": "From MCP" }),
            );

            set_permission(&ctx, "controlled");
            let names = listed_tools(port, &token);
            assert!(names.iter().any(|name| name == "list_instances"));
            assert!(!names.iter().any(|name| name == "update_instance_notes"));
            let denied = mcp_call(port, &token, &write);
            assert_eq!(denied["error"]["code"], -32003, "{denied}");
            assert_eq!(notes(&ctx), "Initial note");

            set_permission(&ctx, "fullAccess");
            let names = listed_tools(port, &token);
            assert!(names.iter().any(|name| name == "update_instance_notes"));
            let ran = mcp_call(port, &token, &write);
            assert_eq!(ran["result"]["isError"], false, "{ran}");
            assert!(result_text(&ran).contains("From MCP"));
            assert_eq!(notes(&ctx), "From MCP");
            service.stop();
        });
    }

    #[test]
    fn mcp_call_past_its_deadline_reports_still_running_and_the_action_finishes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let service = McpService::with_tool_deadline(std::time::Duration::from_millis(150));
            let port = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap()
                .port;
            let token = service.token().unwrap();

            // The held operation lock keeps the write waiting past the deadline.
            let operation = ctx.state.operation.lock().await;
            let pending = mcp_call(
                port,
                &token,
                &tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "slow" })),
            );
            assert_eq!(pending["result"]["isError"], false, "{pending}");
            let text = result_text(&pending);
            assert!(text.contains("still running"), "{text}");
            assert!(text.contains("list_download_tasks"), "{text}");
            assert!(text.contains("list_running_games"), "{text}");
            assert_eq!(notes(&ctx), "Initial note");
            assert_eq!(service.tool_slots_in_use(), 1);

            drop(operation);
            wait_until("the detached write", || notes(&ctx) == "slow");
            wait_until("the detached slot", || service.tool_slots_in_use() == 0);

            let listed = mcp_call(port, &token, &tool_call("list_instances", json!({})));
            assert!(result_text(&listed).contains("slow"), "{listed}");
            let later = mcp_call(
                port,
                &token,
                &tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "after" })),
            );
            assert_eq!(later["result"]["isError"], false, "{later}");
            assert_eq!(notes(&ctx), "after");
            service.stop();
        });
    }

    #[test]
    fn mcp_detached_actions_are_bounded() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let mut service = McpService::with_tool_deadline(std::time::Duration::from_millis(100));
            service.pause_reads(std::time::Duration::from_millis(300));
            let port = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap()
                .port;
            let token = service.token().unwrap();
            let note = |text: &str| {
                tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": text }))
            };

            let operation = ctx.state.operation.lock().await;
            for index in 1..=mcp::MAX_TOOL_SLOTS {
                let pending = mcp_call(port, &token, &note(&format!("n{index}")));
                assert!(result_text(&pending).contains("still running"), "{pending}");
            }
            assert_eq!(service.tool_slots_in_use(), mcp::MAX_TOOL_SLOTS);

            let refused = mcp_call(port, &token, &note("one too many"));
            assert_eq!(refused["result"]["isError"], true, "{refused}");
            assert!(result_text(&refused).contains("was not started"), "{refused}");
            // Reading the launcher state still works while the limit is reached: a read that
            // passes the deadline with no slot free keeps its call waiting for the result.
            let listed = mcp_call(port, &token, &tool_call("list_download_tasks", json!({})));
            assert_eq!(listed["result"]["isError"], false, "{listed}");
            assert!(result_text(&listed).contains("tasks"), "{listed}");
            assert_eq!(service.tool_slots_in_use(), mcp::MAX_TOOL_SLOTS);

            drop(operation);
            wait_until("the detached writes", || service.tool_slots_in_use() == 0);
            assert_eq!(notes(&ctx), format!("n{}", mcp::MAX_TOOL_SLOTS));
            let later = mcp_call(port, &token, &note("after the limit"));
            assert_eq!(later["result"]["isError"], false, "{later}");
            assert_eq!(notes(&ctx), "after the limit");
            service.stop();
        });
    }

    #[test]
    fn mcp_read_past_its_deadline_is_answered_without_its_result_and_frees_its_slot() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let mut service = McpService::with_tool_deadline(std::time::Duration::from_millis(100));
            service.pause_reads(std::time::Duration::from_millis(400));
            let port = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap()
                .port;
            let token = service.token().unwrap();

            let slow = mcp_call(port, &token, &tool_call("list_instances", json!({})));
            assert_eq!(slow["result"]["isError"], true, "{slow}");
            assert!(result_text(&slow).contains("took too long"), "{slow}");
            assert_eq!(service.tool_slots_in_use(), 1, "the read keeps a slot until it ends");
            wait_until("the slow read", || service.tool_slots_in_use() == 0);

            let write = mcp_call(
                port,
                &token,
                &tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "after" })),
            );
            assert_eq!(write["result"]["isError"], false, "{write}");
            assert_eq!(notes(&ctx), "after");
            service.stop();
        });
    }

    #[test]
    fn mcp_writes_waiting_for_the_operation_lock_write_nothing_after_stop_or_restart() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            install_fixture_version(&ctx);
            set_permission(&ctx, "fullAccess");
            let service = McpService::with_tool_deadline(std::time::Duration::from_millis(150));
            let port = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap()
                .port;
            let token = service.token().unwrap();

            // A "still running" answer shows each call is in flight, waiting for the lock.
            let operation = ctx.state.operation.lock().await;
            for call in [
                tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "late" })),
                tool_call("create_instance", json!({ "name": "Late", "versionId": "1.21.1" })),
            ] {
                let pending = mcp_call(port, &token, &call);
                assert!(result_text(&pending).contains("still running"), "{pending}");
            }
            service.stop();
            drop(operation);
            // The waiting calls get the lock first; once this returns they have checked again.
            drop(ctx.state.operation.lock().await);
            wait_until("the stopped calls", || service.tool_slots_in_use() == 0);
            let snapshot = ctx.state.snapshot().unwrap();
            assert_eq!(snapshot.instances.len(), 1, "no instance is created after stop");
            assert_eq!(snapshot.instances[0].notes, "Initial note");

            // A restart also ends the calls of the server it replaces.
            let port = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap()
                .port;
            let token = service.token().unwrap();
            let operation = ctx.state.operation.lock().await;
            let pending = mcp_call(
                port,
                &token,
                &tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "replaced" })),
            );
            assert!(result_text(&pending).contains("still running"), "{pending}");
            let restarted = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap();
            drop(operation);
            drop(ctx.state.operation.lock().await);
            wait_until("the replaced call", || service.tool_slots_in_use() == 0);
            assert_eq!(notes(&ctx), "Initial note");

            // Calls through the new server still write.
            let fresh = mcp_call(
                restarted.port,
                &service.token().unwrap(),
                &tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "fresh" })),
            );
            assert_eq!(fresh["result"]["isError"], false, "{fresh}");
            assert_eq!(notes(&ctx), "fresh");
            service.stop();
        });
    }

    #[test]
    fn mcp_write_waiting_for_the_operation_lock_reads_the_permission_again() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let service = McpService::with_tool_deadline(std::time::Duration::from_millis(150));
            let port = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap()
                .port;
            let token = service.token().unwrap();

            let operation = ctx.state.operation.lock().await;
            let pending = mcp_call(
                port,
                &token,
                &tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "downgraded" })),
            );
            assert!(result_text(&pending).contains("still running"), "{pending}");
            set_permission(&ctx, "controlled");
            drop(operation);
            drop(ctx.state.operation.lock().await);
            wait_until("the refused call", || service.tool_slots_in_use() == 0);
            assert_eq!(notes(&ctx), "Initial note");
            service.stop();
        });
    }

    #[test]
    fn lumen_write_waiting_for_the_operation_lock_reads_the_permission_again() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "controlled");
            let operation = ctx.state.operation.lock().await;
            let task_ctx = ctx.clone();
            let call = tokio::spawn(async move {
                tools::execute_tool(
                    &task_ctx,
                    "update_instance_notes",
                    &json!({ "instanceId": "inst-1", "notes": "approved earlier" }),
                    tools::PermissionTier::Controlled,
                    true,
                )
                .await
            });
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            set_permission(&ctx, "readOnly");
            drop(operation);
            let outcome = call.await.unwrap();
            assert!(
                matches!(&outcome, Err(tools::ToolExecError::PermissionDenied(message)) if message.contains("readOnly")),
                "{outcome:?}"
            );
            assert_eq!(notes(&ctx), "Initial note");
        });
    }

    #[test]
    fn lumen_full_access_write_does_not_run_after_a_switch_to_controlled() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let operation = ctx.state.operation.lock().await;
            let task_ctx = ctx.clone();
            // Lumen runs Full access writes on its own; nobody approved this one.
            let call = tokio::spawn(async move {
                tools::execute_tool(
                    &task_ctx,
                    "update_instance_notes",
                    &json!({ "instanceId": "inst-1", "notes": "unapproved" }),
                    tools::PermissionTier::FullAccess,
                    true,
                )
                .await
            });
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            set_permission(&ctx, "controlled");
            drop(operation);
            let outcome = call.await.unwrap();
            assert!(
                matches!(&outcome, Err(tools::ToolExecError::PermissionDenied(message)) if message.contains("controlled")),
                "{outcome:?}"
            );
            assert_eq!(notes(&ctx), "Initial note");

            // A write the user approved in Controlled mode still runs there.
            let approved = tools::execute_tool(
                &ctx,
                "update_instance_notes",
                &json!({ "instanceId": "inst-1", "notes": "approved" }),
                tools::PermissionTier::Controlled,
                true,
            )
            .await;
            assert!(approved.is_ok(), "{approved:?}");
            assert_eq!(notes(&ctx), "approved");
        });
    }

    #[test]
    fn waiting_write_hands_the_operation_lock_straight_to_its_action() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "controlled");
            let operation = ctx.state.operation.lock().await;
            let task_ctx = ctx.clone();
            let call = tokio::spawn(async move {
                tools::execute_tool(
                    &task_ctx,
                    "update_instance_notes",
                    &json!({ "instanceId": "inst-1", "notes": "handed over" }),
                    tools::PermissionTier::Controlled,
                    true,
                )
                .await
            });
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            drop(operation);
            // A try_lock caller such as factory reset never finds the lock free between the
            // check and the write.
            let started = std::time::Instant::now();
            loop {
                if let Ok(free) = ctx.state.operation.try_lock() {
                    drop(free);
                    assert_eq!(notes(&ctx), "handed over", "the lock was free before the write");
                    break;
                }
                assert!(started.elapsed() < std::time::Duration::from_secs(10));
                std::hint::spin_loop();
            }
            assert!(call.await.unwrap().is_ok());
        });
    }

    #[test]
    fn waiting_write_checks_again_after_an_earlier_waiter_takes_its_turn_first() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let generation = Arc::new(std::sync::atomic::AtomicU64::new(1));
            let mut call_ctx = ctx.clone();
            call_ctx.mcp_session = Some(tools::McpSession::new(
                1,
                generation.clone(),
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            ));
            let operation = ctx.state.operation.lock().await;
            let call = tokio::spawn(async move {
                tools::execute_tool(
                    &call_ctx,
                    "update_instance_notes",
                    &json!({ "instanceId": "inst-1", "notes": "late" }),
                    tools::PermissionTier::FullAccess,
                    false,
                )
                .await
            });
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            // A launcher action that queues behind the write, and so ahead of the write's own
            // request for the lock. The MCP server stops while it has its turn.
            let state = ctx.state.clone();
            let stopping = generation.clone();
            let earlier = tokio::spawn(async move {
                let _turn = state.operation.lock().await;
                stopping.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            });
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            drop(operation);
            let outcome = call.await.unwrap();
            earlier.await.unwrap();
            assert!(
                matches!(&outcome, Err(tools::ToolExecError::PermissionDenied(message)) if message.contains("stopped or restarted")),
                "{outcome:?}"
            );
            assert_eq!(notes(&ctx), "Initial note");
        });
    }

    const FULL_ACCESS: tools::Admission = tools::Admission {
        permission: tools::PermissionTier::FullAccess,
        explicitly_approved: false,
    };

    /// The launcher's queued launch, as launch_instance runs it, with a notes change in place of
    /// starting the game.
    async fn queued_launch(state: &Arc<LauncherState>, notes: &str) -> Result<(), tools::ToolExecError> {
        let task = state
            .control
            .reserve_launch("1.21.1", Some("inst-1".into()))
            .map_err(tools::ToolExecError::Failed)?;
        let outcome = crate::minecraft::with_launch_preparation(state, &task, "1.21.1", Some("inst-1"), |_| async {
            state.update(|data| {
                data.instances[0].notes = notes.into();
                Ok(())
            })
        })
        .await;
        if outcome.is_err() {
            state.control.cancel(&task);
        }
        outcome.map_err(tools::ToolExecError::Failed)
    }

    fn queued_jar(state: &LauncherState) -> std::path::PathBuf {
        std::path::PathBuf::from(&state.snapshot().unwrap().instances[0].game_directory).join("mods/queued.jar")
    }

    /// The launcher's queued resource install, as install_modrinth_resource runs it, with a
    /// local file in place of the download.
    async fn queued_resource_install(state: &Arc<LauncherState>) -> Result<(), tools::ToolExecError> {
        let request = crate::downloads::ResourceRequest {
            source: crate::downloads::ResourceSource::Modrinth,
            project_id: "AANobbMI".into(),
            resource_type: "mod".into(),
            target: crate::downloads::ResourceTarget::Existing {
                version_id: "1.21.1".into(),
                instance_id: Some("inst-1".into()),
                file_id: None,
                resource_version_id: None,
            },
        };
        let task = state
            .control
            .reserve_resource(request.clone())
            .map_err(tools::ToolExecError::Failed)?;
        let jar = queued_jar(state);
        let outcome = crate::resources::with_reserved_resource_task(state, &task, request, async {
            std::fs::write(&jar, b"queued").map_err(|error| crate::errors::AppError::from(error.to_string()))
        })
        .await;
        if outcome.is_err() {
            state.control.cancel(&task);
        }
        outcome.map_err(|error| tools::ToolExecError::Failed(error.detail.unwrap_or(error.code)))
    }

    fn task_statuses(ctx: &tools::ToolContext) -> Vec<(String, String)> {
        ctx.state
            .control
            .list()
            .into_iter()
            .map(|job| (job.kind, job.status))
            .collect()
    }

    fn queued_count(ctx: &tools::ToolContext) -> usize {
        task_statuses(ctx).iter().filter(|(_, status)| status == "queued").count()
    }

    fn stale_session_refusal(outcome: &Result<(), tools::ToolExecError>) -> bool {
        matches!(outcome, Err(tools::ToolExecError::PermissionDenied(message)) if message.contains("stopped or restarted"))
    }

    #[test]
    fn mcp_stop_cancels_queued_launch_and_resource_writes_waiting_for_their_turn() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let service = McpService::default();
            service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap();
            let mut call_ctx = ctx.clone();
            call_ctx.mcp_session = service.session();

            // The user's own install holds the lock, so both calls wait in the download list.
            let operation = ctx.state.operation.lock().await;
            let launch_ctx = call_ctx.clone();
            let launch = tokio::spawn(async move {
                tools::run_queued_write(&launch_ctx, "launch_instance", FULL_ACCESS, "launch", "1.21.1", queued_launch(&launch_ctx.state, "launched")).await
            });
            let resource_ctx = call_ctx.clone();
            let resource = tokio::spawn(async move {
                tools::run_queued_write(&resource_ctx, "install_modrinth_resource", FULL_ACCESS, "resource", "AANobbMI", queued_resource_install(&resource_ctx.state)).await
            });
            wait_until("both tasks to queue", || queued_count(&ctx) == 2);

            // The stop itself cancels them, while the lock is still held.
            service.stop();
            let mut statuses = task_statuses(&ctx);
            statuses.sort();
            assert_eq!(
                statuses,
                [("launch".to_owned(), "cancelled".to_owned()), ("resource".to_owned(), "cancelled".to_owned())]
            );
            drop(operation);
            let launched = launch.await.unwrap();
            let installed = resource.await.unwrap();
            assert!(stale_session_refusal(&launched), "{launched:?}");
            assert!(stale_session_refusal(&installed), "{installed:?}");
            assert_eq!(notes(&ctx), "Initial note");
            assert!(!queued_jar(&ctx.state).exists());
            assert!(ctx.state.control.is_idle());
        });
    }

    #[test]
    fn queued_writes_check_again_when_their_turn_comes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let generation = Arc::new(std::sync::atomic::AtomicU64::new(1));
            let session = |current| {
                tools::McpSession::new(
                    current,
                    generation.clone(),
                    Arc::new(std::sync::atomic::AtomicBool::new(false)),
                )
            };

            // With nothing changed, the queued launch runs once its turn comes.
            let mut call_ctx = ctx.clone();
            call_ctx.mcp_session = Some(session(1));
            let operation = ctx.state.operation.lock().await;
            let task_ctx = call_ctx.clone();
            let launch = tokio::spawn(async move {
                tools::run_queued_write(&task_ctx, "launch_instance", FULL_ACCESS, "launch", "1.21.1", queued_launch(&task_ctx.state, "launched")).await
            });
            wait_until("the launch to queue", || queued_count(&ctx) == 1);
            drop(operation);
            let launched = launch.await.unwrap();
            assert!(launched.is_ok(), "{launched:?}");
            assert_eq!(notes(&ctx), "launched");

            // The server moves on while the launch waits, and nothing cancels the task.
            let operation = ctx.state.operation.lock().await;
            let task_ctx = call_ctx.clone();
            let launch = tokio::spawn(async move {
                tools::run_queued_write(&task_ctx, "launch_instance", FULL_ACCESS, "launch", "1.21.1", queued_launch(&task_ctx.state, "late launch")).await
            });
            wait_until("the second launch to queue", || queued_count(&ctx) == 1);
            generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            drop(operation);
            let launched = launch.await.unwrap();
            assert!(stale_session_refusal(&launched), "{launched:?}");
            assert_eq!(notes(&ctx), "launched");

            // A Lumen install waiting when the permission drops.
            let operation = ctx.state.operation.lock().await;
            let task_ctx = ctx.clone();
            let resource = tokio::spawn(async move {
                tools::run_queued_write(
                    &task_ctx,
                    "install_modrinth_resource",
                    tools::Admission {
                        permission: tools::PermissionTier::FullAccess,
                        explicitly_approved: true,
                    },
                    "resource",
                    "AANobbMI",
                    queued_resource_install(&task_ctx.state),
                )
                .await
            });
            wait_until("the install to queue", || queued_count(&ctx) == 1);
            set_permission(&ctx, "controlled");
            drop(operation);
            let installed = resource.await.unwrap();
            assert!(
                matches!(&installed, Err(tools::ToolExecError::PermissionDenied(message)) if message.contains("controlled")),
                "{installed:?}"
            );
            assert!(!queued_jar(&ctx.state).exists());
            let statuses = task_statuses(&ctx);
            assert_eq!(statuses.iter().filter(|(_, status)| status == "cancelled").count(), 2, "{statuses:?}");
            assert!(ctx.state.control.is_idle());
        });
    }

    #[test]
    fn mcp_stop_cancels_the_tasks_its_calls_left_waiting() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            let service = McpService::default();
            service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap();
            let session = service.session().unwrap();
            let control = &ctx.state.control;

            // A retry queued by an MCP call runs later as its own task, behind the lock.
            let operation = ctx.state.operation.lock().await;
            let id = control.enqueue("install", "1.20.1", "Minecraft 1.20.1").unwrap();
            let state = ctx.state.clone();
            let task = id.clone();
            let retry = tokio::spawn(async move {
                state
                    .control
                    .run_queued(&state.operation, &task, || async {
                        state.update(|data| {
                            data.instances[0].notes = "retried".into();
                            Ok(())
                        })
                    })
                    .await
            });
            session.track_queued(control, &id);
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            service.stop();
            assert_eq!(task_statuses(&ctx), [("install".to_owned(), "cancelled".to_owned())]);
            drop(operation);
            assert!(retry.await.unwrap().is_none());
            assert_eq!(notes(&ctx), "Initial note");

            // One tracked after the server stopped is cancelled at once.
            let late = control.enqueue("install", "1.20.2", "Minecraft 1.20.2").unwrap();
            session.track_queued(control, &late);
            assert!(task_statuses(&ctx).iter().all(|(_, status)| status == "cancelled"));
            assert!(control.is_idle());

            // retry_failed_downloads hands every task it queued to its session.
            let tools_source = include_str!("tools.rs");
            let retry_branch = &tools_source[tools_source.find("\"retry_failed_downloads\" => {").unwrap()..];
            let retry_branch = &retry_branch[..retry_branch.find("\"clear_unfinished_downloads\" => {").unwrap()];
            assert!(retry_branch.contains("for id in &result.ids"));
            assert!(retry_branch.contains("session.track_queued(&ctx.state.control, id);"));
        });
    }

    #[test]
    fn launcher_actions_behind_waiting_writes_ask_for_the_lock_before_anything_else() {
        let actions = [
            (include_str!("../instances.rs"), "pub(crate) async fn update_instance_notes_inner("),
            (include_str!("../instances.rs"), "pub(crate) async fn update_instance_safe_settings("),
            (include_str!("../instances.rs"), "pub(crate) async fn clone_instance_for_state("),
            (include_str!("../instances.rs"), "pub(crate) async fn backup_instance_for_state("),
            (include_str!("../resources.rs"), "pub(crate) async fn toggle_resource_for_state("),
            (include_str!("../content.rs"), "pub(crate) async fn toggle_world_datapack_for_state("),
            (include_str!("../servers.rs"), "pub(crate) async fn save_server_for_state("),
        ];
        assert_eq!(
            include_str!("tools.rs").matches("run_waiting_write(ctx").count(),
            actions.len(),
            "every action run through run_waiting_write is listed here"
        );
        for (source, signature) in actions {
            let body = &source[source.find(signature).expect(signature)..];
            let first_await = body.find(".await").expect(signature);
            assert!(
                body[..first_await].ends_with("state.operation.lock()"),
                "{signature} must ask for the operation lock before it awaits anything else"
            );
        }
    }

    #[test]
    fn mcp_stop_waits_for_a_start_in_progress() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (_root, ctx) = fixture_context();
        let mut service = McpService::default();
        service.pause_starts(std::time::Duration::from_millis(400));
        let service = Arc::new(service);
        let starting = service.clone();
        let handle = rt.handle().clone();
        let start = std::thread::spawn(move || starting.start(ctx, 0, handle).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(100));
        let stopped = service.stop();
        assert!(!stopped.running);
        let started = start.join().unwrap();
        assert!(
            !service.status(0).running,
            "a stop made while the server was starting ends that server"
        );
        assert!(service.token().is_none());
        assert!(TcpStream::connect(("127.0.0.1", started.port)).is_err());
    }

    #[test]
    fn every_controlled_tool_checks_again_before_it_writes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (root, ctx) = fixture_context();
            install_fixture_version(&ctx);
            let calls = [
                ("toggle_instance_resource", json!({ "instanceId": "inst-1", "resourceType": "mod", "fileName": "sodium.jar" })),
                ("toggle_world_datapack", json!({ "instanceId": "inst-1", "worldFolder": "world", "fileName": "pack.zip" })),
                ("create_instance", json!({ "name": "Second", "versionId": "1.21.1" })),
                ("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "changed" })),
                ("update_instance_settings", json!({ "instanceId": "inst-1", "notes": "changed" })),
                ("backup_instance", json!({ "instanceId": "inst-1" })),
                ("clone_instance", json!({ "instanceId": "inst-1", "name": "Copy" })),
                ("change_instance_loader", json!({ "instanceId": "inst-1", "loader": "vanilla" })),
                ("install_minecraft_version", json!({ "versionId": "1.21.1" })),
                ("install_modrinth_resource", json!({ "instanceId": "inst-1", "projectId": "AANobbMI", "resourceType": "mod" })),
                ("launch_instance", json!({ "instanceId": "inst-1" })),
                ("stop_running_game", json!({ "gameId": "game-1" })),
                ("retry_failed_downloads", json!({})),
                ("clear_unfinished_downloads", json!({})),
                ("save_multiplayer_server", json!({ "instanceId": "inst-1", "name": "Voxel SMP", "address": "play.example.org" })),
                ("start_managed_server", json!({ "serverId": "srv-1" })),
                ("stop_managed_server", json!({ "serverId": "srv-1" })),
            ];
            let mut covered: Vec<&str> = calls.iter().map(|(name, _)| *name).collect();
            let mut controlled: Vec<&str> = tools::catalog()
                .iter()
                .filter(|spec| spec.tier == tools::ToolTier::Controlled)
                .map(|spec| spec.name)
                .collect();
            covered.sort_unstable();
            controlled.sort_unstable();
            assert_eq!(covered, controlled, "every Controlled tool is listed here");

            let game = root.path().join("game");
            let state_before = serde_json::to_value(ctx.state.snapshot().unwrap()).unwrap();
            let files_before = file_tree(&game);
            let tasks_before = serde_json::to_value(ctx.state.control.snapshot()).unwrap();

            // A call from an MCP server that has since stopped or restarted.
            set_permission(&ctx, "fullAccess");
            let mut stale = ctx.clone();
            stale.mcp_session = Some(tools::McpSession::new(
                1,
                Arc::new(std::sync::atomic::AtomicU64::new(2)),
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            ));
            for (name, arguments) in &calls {
                let outcome = tools::execute_tool(
                    &stale,
                    name,
                    arguments,
                    tools::PermissionTier::FullAccess,
                    false,
                )
                .await;
                assert!(
                    matches!(&outcome, Err(tools::ToolExecError::PermissionDenied(message)) if message.contains("stopped or restarted")),
                    "{name}: {outcome:?}"
                );
            }

            // A call whose caller still holds a permission the settings no longer grant.
            set_permission(&ctx, "readOnly");
            for (name, arguments) in &calls {
                let outcome = tools::execute_tool(
                    &ctx,
                    name,
                    arguments,
                    tools::PermissionTier::FullAccess,
                    true,
                )
                .await;
                assert!(
                    matches!(&outcome, Err(tools::ToolExecError::PermissionDenied(message)) if message.contains("readOnly")),
                    "{name}: {outcome:?}"
                );
            }

            let mut state_after = serde_json::to_value(ctx.state.snapshot().unwrap()).unwrap();
            state_after["config"]["assistantPermission"] = state_before["config"]["assistantPermission"].clone();
            assert_eq!(state_after, state_before);
            assert_eq!(file_tree(&game), files_before);
            assert_eq!(serde_json::to_value(ctx.state.control.snapshot()).unwrap(), tasks_before);
        });
    }

    #[test]
    fn mcp_session_ends_with_a_stop_flag_or_a_new_generation() {
        let generation = Arc::new(std::sync::atomic::AtomicU64::new(3));
        let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = tools::McpSession::new(3, generation.clone(), shutdown.clone());
        assert!(session.is_current());
        shutdown.store(true, std::sync::atomic::Ordering::Release);
        assert!(!session.is_current());
        shutdown.store(false, std::sync::atomic::Ordering::Release);
        generation.store(4, std::sync::atomic::Ordering::Release);
        assert!(!session.is_current());
    }

    #[test]
    fn mcp_start_on_a_taken_port_and_rotate_while_stopped_have_their_own_codes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = taken.local_addr().unwrap().port();
            let service = McpService::default();
            let failed = service
                .start(ctx, port, tokio::runtime::Handle::current())
                .unwrap_err();
            let mapped = expected(failed);
            assert_eq!(mapped.code, "assistant.mcpPortUnavailable");
            assert_eq!(mapped.params["port"], port);
            assert!(!service.status(port).running);

            let rotated = service.rotate_token().unwrap_err();
            assert_eq!(expected(rotated).code, "assistant.mcpNotRunning");
        });
    }

    #[test]
    fn mcp_token_rotation_ends_the_writes_let_in_with_the_old_token() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let service = McpService::with_tool_deadline(std::time::Duration::from_millis(150));
            let port = service
                .start(ctx.clone(), 0, tokio::runtime::Handle::current())
                .unwrap()
                .port;
            let old_token = service.token().unwrap();

            // The user's own install holds the lock: a notes write let in with the old token
            // waits for it, and a launch from the same run waits in the download list.
            let operation = ctx.state.operation.lock().await;
            let pending = mcp_call(
                port,
                &old_token,
                &tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "after rotation" })),
            );
            assert!(result_text(&pending).contains("still running"), "{pending}");
            let mut call_ctx = ctx.clone();
            call_ctx.mcp_session = service.session();
            let launch_ctx = call_ctx.clone();
            let launch = tokio::spawn(async move {
                tools::run_queued_write(&launch_ctx, "launch_instance", FULL_ACCESS, "launch", "1.21.1", queued_launch(&launch_ctx.state, "launched")).await
            });
            wait_until("the launch to queue", || queued_count(&ctx) == 1);

            let rotated = service.rotate_token().unwrap();
            assert!(rotated.running);
            assert_eq!(rotated.port, port);
            assert_eq!(task_statuses(&ctx), [("launch".to_owned(), "cancelled".to_owned())]);
            drop(operation);
            drop(ctx.state.operation.lock().await);
            wait_until("the revoked write", || service.tool_slots_in_use() == 0);
            let launched = launch.await.unwrap();
            assert!(stale_session_refusal(&launched), "{launched:?}");
            assert_eq!(notes(&ctx), "Initial note");
            assert!(ctx.state.control.is_idle());

            // The server keeps running, and a call with the new token writes.
            let fresh = mcp_call(
                port,
                &service.token().unwrap(),
                &tool_call("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "new token" })),
            );
            assert_eq!(fresh["result"]["isError"], false, "{fresh}");
            assert_eq!(notes(&ctx), "new token");
            service.stop();
        });
    }

    #[test]
    fn queued_write_that_cannot_tell_its_task_apart_is_refused() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let generation = Arc::new(std::sync::atomic::AtomicU64::new(1));
            let mut call_ctx = ctx.clone();
            call_ctx.mcp_session = Some(tools::McpSession::new(
                1,
                generation.clone(),
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            ));
            let operation = ctx.state.operation.lock().await;
            let task_ctx = call_ctx.clone();
            let launch = tokio::spawn(async move {
                let state = task_ctx.state.clone();
                tools::run_queued_write(&task_ctx, "launch_instance", FULL_ACCESS, "launch", "1.21.1", async move {
                    // Another launch task for the same version appears at the same moment.
                    state
                        .control
                        .enqueue("launch", "1.21.1", "Minecraft 1.21.1")
                        .map_err(tools::ToolExecError::Failed)?;
                    queued_launch(&state, "launched").await
                })
                .await
            });
            wait_until("both launch tasks", || task_statuses(&ctx).len() == 2);
            // The server stops while the launch would wait for its turn.
            generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            drop(operation);
            let launched = launch.await.unwrap();
            assert!(
                matches!(&launched, Err(tools::ToolExecError::PermissionDenied(message)) if message.contains("could not be told apart")),
                "{launched:?}"
            );
            assert_eq!(notes(&ctx), "Initial note");
            assert_eq!(queued_count(&ctx), 0);
        });
    }

    #[test]
    fn a_lumen_write_that_cannot_tell_its_task_apart_cancels_nothing() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let operation = ctx.state.operation.lock().await;
            let task_ctx = ctx.clone();
            let launch = tokio::spawn(async move {
                let state = task_ctx.state.clone();
                tools::run_queued_write(&task_ctx, "launch_instance", FULL_ACCESS, "launch", "1.21.1", async move {
                    state
                        .control
                        .enqueue("launch", "1.21.1", "Minecraft 1.21.1")
                        .map_err(tools::ToolExecError::Failed)?;
                    queued_launch(&state, "launched").await
                })
                .await
            });
            wait_until("both launch tasks", || task_statuses(&ctx).len() == 2);
            drop(operation);
            let launched = launch.await.unwrap();
            assert!(launched.is_ok(), "{launched:?}");
            assert_eq!(notes(&ctx), "launched");
            assert!(
                !task_statuses(&ctx).iter().any(|(_, status)| status == "cancelled"),
                "a Lumen call never cancels another task"
            );
        });
    }

    #[test]
    fn a_write_whose_own_task_already_ran_reports_its_real_error() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            set_permission(&ctx, "fullAccess");
            let mut call_ctx = ctx.clone();
            call_ctx.mcp_session = Some(tools::McpSession::new(
                1,
                Arc::new(std::sync::atomic::AtomicU64::new(1)),
                Arc::new(std::sync::atomic::AtomicBool::new(false)),
            ));
            let state = call_ctx.state.clone();
            let result = tools::run_queued_write(&call_ctx, "launch_instance", FULL_ACCESS, "launch", "1.21.1", async move {
                let task = state
                    .control
                    .reserve_launch("1.21.1", Some("inst-1".into()))
                    .map_err(tools::ToolExecError::Failed)?;
                let inner = state.clone();
                let outcome: Result<(), String> =
                    crate::minecraft::with_launch_preparation(&state, &task, "1.21.1", Some("inst-1"), |_| async move {
                        // Its own task is running when another launch of the same version appears.
                        inner.control.enqueue("launch", "1.21.1", "Minecraft 1.21.1")?;
                        tokio::task::yield_now().await;
                        Err("real launch failure".to_owned())
                    })
                    .await;
                outcome.map_err(tools::ToolExecError::Failed)
            })
            .await;
            assert!(
                matches!(&result, Err(tools::ToolExecError::Failed(message)) if message == "real launch failure"),
                "{result:?}"
            );
        });
    }

    #[test]
    fn approval_cards_show_every_instance_setting_and_the_tasks_a_retry_queues() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            let control = &ctx.state.control;
            let install = control.enqueue("install", "1.20.1", "Minecraft 1.20.1").unwrap();
            control.finish(&install, Some("download failed"));
            let loader = control
                .enqueue_recorded(
                    "loader",
                    "1.20.1",
                    "Install forge",
                    crate::downloads::RetryRequest::Loader {
                        loader: "forge".into(),
                        game_version: "1.20.1".into(),
                        loader_version: "47.2.0".into(),
                    },
                )
                .unwrap();
            control.finish(&loader, Some("installer failed"));
            // A failed task with nothing to run again is not retried.
            let backup = control.enqueue("backup", "inst-1", "Back up instance").unwrap();
            control.finish(&backup, Some("disk full"));

            let described = approval::describe_all(
                &ctx,
                vec![
                    ("retry_failed_downloads".into(), json!({})),
                    (
                        "update_instance_settings".into(),
                        json!({
                            "instanceId": "inst-1",
                            "notes": "",
                            "memoryMode": "manual",
                            "maxMemoryMb": 4096,
                            "minMemoryMb": 1024,
                            "clearMinMemory": false,
                            "screenWidth": 1600,
                            "screenHeight": 900,
                            "gameProxyMode": "off",
                            "resetRuntime": true,
                        }),
                    ),
                ],
            )
            .await;
            let fields = |index: usize| -> Vec<(String, String)> {
                described[index]
                    .0
                    .iter()
                    .map(|detail| (detail.field.clone(), detail.value.clone()))
                    .collect()
            };

            let retry = fields(0);
            assert_eq!(retry[0], ("retryCount".to_owned(), "2".to_owned()));
            let mut tasks: Vec<&str> = retry[1..]
                .iter()
                .map(|(field, value)| {
                    assert_eq!(field, "retryTask");
                    value.as_str()
                })
                .collect();
            tasks.sort_unstable();
            assert_eq!(tasks, ["install · Minecraft 1.20.1", "loader · Install forge · 1.20.1"]);
            assert!(!described[0].1);

            let settings: Vec<(String, String)> = fields(1);
            let expected_settings = [
                ("instance", "Fabric Test · 1.21.1 · fabric 0.16.5"),
                ("notes", ""),
                ("memoryMode", "manual"),
                ("maxMemory", "4096 MB"),
                ("minMemory", "1024 MB"),
                ("clearMinMemory", "false"),
                ("screenWidth", "1600"),
                ("screenHeight", "900"),
                ("gameProxyMode", "off"),
                ("resetRuntime", "true"),
            ]
            .map(|(field, value)| (field.to_owned(), value.to_owned()));
            assert_eq!(settings, expected_settings);
            assert!(!described[1].1);
        });
    }

    #[test]
    fn write_tool_results_leave_out_the_java_path_and_jvm_arguments() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            ctx.state
                .update(|data| {
                    let instance = &mut data.instances[0];
                    instance.jvm_arguments = Some("-Dhttp.proxyUser=me -Dhttp.proxyPassword=hunter2".into());
                    instance.java_path = Some("custom-runtime/bin/java".into());
                    Ok(())
                })
                .unwrap();
            set_permission(&ctx, "fullAccess");
            let mut results = Vec::new();
            for (name, arguments) in [
                ("update_instance_notes", json!({ "instanceId": "inst-1", "notes": "proxy password=hunter2" })),
                ("update_instance_settings", json!({ "instanceId": "inst-1", "screenWidth": 1280 })),
                ("clone_instance", json!({ "instanceId": "inst-1", "name": "Copy" })),
                ("list_instances", json!({})),
            ] {
                let value = tools::execute_tool(&ctx, name, &arguments, tools::PermissionTier::FullAccess, false)
                    .await
                    .unwrap_or_else(|error| panic!("{name}: {error:?}"));
                results.push((name, value));
            }
            // The loader switch needs the launcher window, so its result is built from the
            // instance directly; the masking of the notes is left to execute_tool.
            let mut switched_instance = ctx.state.snapshot().unwrap().instances[0].clone();
            switched_instance.notes = "Switched".into();
            let change = crate::instances::InstanceLoaderChange {
                instance: switched_instance,
                backup_id: Some("backup-1".into()),
            };
            let switched = tools::loader_change_summary(&change);
            assert_eq!(switched["backupId"], "backup-1");
            results.push(("change_instance_loader", switched));

            for (name, value) in &results {
                let text = value.to_string();
                for hidden in ["hunter2", "proxyUser", "custom-runtime", "jvmArguments", "javaPath", "gameDirectory"] {
                    assert!(!text.contains(hidden), "{name} sent {hidden}: {text}");
                }
            }
            assert_eq!(results[0].1["customJvmArguments"], true);
            assert_eq!(results[0].1["customJavaPath"], true);
            assert_eq!(results[1].1["screenWidth"], 1280);
            assert_eq!(results[2].1["name"], "Copy");
            assert_eq!(results[3].1["instances"][0]["customJvmArguments"], true);
        });
    }

    /// A loopback OpenAI-compatible provider that answers each request with the next reply,
    /// then with a plain text answer.
    fn canned_provider(replies: Vec<serde_json::Value>) -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut replies = replies.into_iter();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(20)));
                let mut request = Vec::new();
                let mut chunk = [0u8; 16 * 1024];
                let complete = loop {
                    let Ok(read) = stream.read(&mut chunk) else { break false };
                    if read == 0 {
                        break false;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
                        continue;
                    };
                    let length = String::from_utf8_lossy(&request[..end])
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break true;
                    }
                };
                if !complete {
                    continue;
                }
                let reply = replies
                    .next()
                    .unwrap_or_else(|| json!({ "choices": [{ "message": { "role": "assistant", "content": "Done." } }] }))
                    .to_string();
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                );
            }
        });
        port
    }

    #[test]
    fn no_assistant_tool_offers_online_optifine_and_lumen_never_asks_to_approve_it() {
        for spec in tools::catalog() {
            assert!(
                !spec.input_schema.to_string().to_ascii_lowercase().contains("optifine"),
                "{} offers OptiFine",
                spec.name
            );
        }
        let switch = tools::find_tool("change_instance_loader").unwrap();
        assert!(!switch.description.contains("preserving its worlds"), "{}", switch.description);
        assert!(switch.description.contains("automatic backup"), "{}", switch.description);
        assert!(switch.description.contains("older ones are deleted"), "{}", switch.description);
        assert!(switch.description.contains("permanently lose"), "{}", switch.description);
        assert_eq!(
            tools::refusal_before_approval("change_instance_loader", &json!({ "instanceId": "inst-1", "loader": " OptiFine " })).as_deref(),
            Some(crate::loaders::OPTIFINE_ONLINE_UNAVAILABLE)
        );
        assert!(tools::refusal_before_approval("change_instance_loader", &json!({ "instanceId": "inst-1", "loader": "fabric" })).is_none());

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let (_root, ctx) = fixture_context();
            // The official source lists no OptiFine builds instead of refusing.
            ctx.state
                .update(|data| {
                    data.config.download_source = "official".into();
                    Ok(())
                })
                .unwrap();
            let listed = tools::execute_tool(
                &ctx,
                "list_loader_versions",
                &json!({ "loader": "optifine", "gameVersion": "1.21.1" }),
                tools::PermissionTier::ReadOnly,
                false,
            )
            .await;
            assert!(
                matches!(&listed, Err(tools::ToolExecError::Failed(message)) if message == crate::loaders::OPTIFINE_ONLINE_UNAVAILABLE),
                "{listed:?}"
            );

            // Lumen in Full access refuses the switch at once instead of asking for approval.
            let call_id = format!("optifine-{}", uuid::Uuid::new_v4().simple());
            let port = canned_provider(vec![json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": "change_instance_loader",
                                "arguments": json!({ "instanceId": "inst-1", "loader": "optifine", "loaderVersion": "HD_U_I7" }).to_string(),
                            }
                        }]
                    }
                }]
            })]);
            ctx.state
                .update(|data| {
                    data.config.proxy_mode = "none".into();
                    data.config.assistant_provider = "openai".into();
                    data.config.assistant_base_url = format!("http://127.0.0.1:{port}/v1");
                    data.config.assistant_model = "test-model".into();
                    data.config.assistant_permission = "fullAccess".into();
                    Ok(())
                })
                .unwrap();
            let response = llm::run_turn(
                &ctx,
                llm::AssistantTurnRequest {
                    messages: vec![llm::ChatMessage {
                        role: "user".into(),
                        content: "Add OptiFine to my instance".into(),
                    }],
                    approved_call_ids: Vec::new(),
                    denied_call_ids: Vec::new(),
                    pending_continuation: None,
                    wake: false,
                },
            )
            .await
            .unwrap();
            assert!(response.pending_approvals.is_empty(), "{:?}", response.pending_approvals);
            let trace = response.traces.iter().find(|trace| trace.id == call_id).unwrap();
            assert_eq!(trace.status, "error");
            assert_eq!(trace.summary, crate::loaders::OPTIFINE_ONLINE_UNAVAILABLE);
            assert_eq!(ctx.state.snapshot().unwrap().instances[0].loader, "fabric");
        });
    }
}
