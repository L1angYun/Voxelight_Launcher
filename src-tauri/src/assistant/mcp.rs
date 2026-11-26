//! Localhost-only MCP (Model Context Protocol) Streamable HTTP / JSON-RPC 2.0 server.
//! Off by default; binds strictly to 127.0.0.1 with an ephemeral per-session Bearer token,
//! Host/Origin validation against DNS-rebinding & CSRF, and permission-tier tool filtering.

use super::tools::{self, PermissionTier, ToolContext, ToolExecError};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use uuid::Uuid;

const PROTOCOL_VERSION: &str = "2024-11-05";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_CONCURRENT_CONNECTIONS: usize = 4;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub url: Option<String>,
    pub token_masked: Option<String>,
}

struct RunningMcp {
    port: u16,
    token: Arc<Mutex<String>>,
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct McpService {
    inner: Mutex<Option<RunningMcp>>,
}

impl Drop for McpService {
    fn drop(&mut self) {
        self.stop();
    }
}

fn generate_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn mask_token(token: &str) -> String {
    if token.len() <= 6 {
        return "••••••".into();
    }
    let tail = &token[token.len() - 6..];
    format!("••••••••{tail}")
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&a, &b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn is_allowed_host(host: &str) -> bool {
    let trimmed = host.trim().to_ascii_lowercase();
    if trimmed == "127.0.0.1" || trimmed == "localhost" || trimmed == "[::1]" {
        return true;
    }
    if let Some(port) = trimmed.strip_prefix("127.0.0.1:") {
        return port.parse::<u16>().is_ok();
    }
    if let Some(port) = trimmed.strip_prefix("localhost:") {
        return port.parse::<u16>().is_ok();
    }
    if let Some(port) = trimmed.strip_prefix("[::1]:") {
        return port.parse::<u16>().is_ok();
    }
    false
}

fn is_allowed_origin(origin: &str) -> bool {
    let trimmed = origin.trim();
    if trimmed.is_empty() {
        return true;
    }
    let Ok(parsed) = reqwest::Url::parse(trimmed) else {
        return false;
    };
    match parsed.scheme() {
        "http" => matches!(
            parsed.host_str(),
            Some("127.0.0.1" | "localhost" | "[::1]" | "::1" | "tauri.localhost")
        ),
        "tauri" => parsed.host_str() == Some("localhost"),
        _ => false,
    }
}

impl McpService {
    pub fn start(
        &self,
        mut ctx: ToolContext,
        port: u16,
        runtime: tokio::runtime::Handle,
    ) -> Result<McpStatus, String> {
        let existing = {
            let mut guard = self.inner.lock().map_err(|_| "MCP 服务锁异常")?;
            guard.take()
        };
        if let Some(existing) = existing {
            existing.shutdown.store(true, Ordering::Release);
            if let Some(handle) = existing.handle {
                let _ = handle.join();
            }
        }
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = TcpListener::bind(addr)
            .map_err(|error| format!("无法在 127.0.0.1:{port} 启动 MCP 服务：{error}"))?;
        let bound_port = listener
            .local_addr()
            .map_err(|error| format!("无法读取 MCP 监听端口：{error}"))?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("无法配置 MCP 监听套接字：{error}"))?;
        ctx.mcp_port = Some(bound_port);

        let token = Arc::new(Mutex::new(generate_token()));
        let shutdown = Arc::new(AtomicBool::new(false));
        let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
        let thread_token = token.clone();
        let thread_shutdown = shutdown.clone();

        let handle = thread::Builder::new()
            .name("voxelight-mcp".into())
            .spawn(move || {
                while !thread_shutdown.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((mut stream, _peer)) => {
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                            let Ok(permit) = permits.clone().try_acquire_owned() else {
                                write_http_response(
                                    &mut stream,
                                    503,
                                    "Service Unavailable",
                                    Some(b"{\"error\":\"too_many_requests\"}"),
                                    None,
                                );
                                continue;
                            };
                            let conn_ctx = ctx.clone();
                            let conn_token = thread_token.clone();
                            let conn_runtime = runtime.clone();
                            runtime.spawn_blocking(move || {
                                let _permit = permit;
                                handle_connection(stream, &conn_ctx, &conn_token, &conn_runtime);
                            });
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(25));
                        }
                        Err(_) => {
                            thread::sleep(Duration::from_millis(50));
                        }
                    }
                }
            })
            .map_err(|error| format!("无法创建 MCP 服务线程：{error}"))?;

        let masked = token
            .lock()
            .map(|value| mask_token(&value))
            .unwrap_or_else(|_| "••••••".into());
        let replaced = {
            let mut guard = self.inner.lock().map_err(|_| "MCP 服务锁异常")?;
            guard.replace(RunningMcp {
                port: bound_port,
                token,
                shutdown,
                handle: Some(handle),
            })
        };
        if let Some(stale) = replaced {
            stale.shutdown.store(true, Ordering::Release);
            if let Some(handle) = stale.handle {
                let _ = handle.join();
            }
        }
        Ok(McpStatus {
            running: true,
            port: bound_port,
            url: Some(format!("http://127.0.0.1:{bound_port}/mcp")),
            token_masked: Some(masked),
        })
    }

    pub fn stop(&self) -> McpStatus {
        let existing = {
            let mut guard = match self.inner.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.take()
        };
        if let Some(existing) = existing {
            existing.shutdown.store(true, Ordering::Release);
            if let Some(handle) = existing.handle {
                let _ = handle.join();
            }
        }
        McpStatus {
            running: false,
            port: 0,
            url: None,
            token_masked: None,
        }
    }

    pub fn rotate_token(&self) -> Result<McpStatus, String> {
        let guard = self.inner.lock().map_err(|_| "MCP 服务锁异常")?;
        let Some(running) = guard.as_ref() else {
            return Err("MCP 服务尚未启动".into());
        };
        let next = generate_token();
        let masked = mask_token(&next);
        *running.token.lock().map_err(|_| "MCP 令牌锁异常")? = next;
        Ok(McpStatus {
            running: true,
            port: running.port,
            url: Some(format!("http://127.0.0.1:{}/mcp", running.port)),
            token_masked: Some(masked),
        })
    }

    pub fn status(&self, default_port: u16) -> McpStatus {
        let guard = match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        match guard.as_ref() {
            Some(running) => {
                let masked = running
                    .token
                    .lock()
                    .map(|value| mask_token(&value))
                    .ok();
                McpStatus {
                    running: true,
                    port: running.port,
                    url: Some(format!("http://127.0.0.1:{}/mcp", running.port)),
                    token_masked: masked,
                }
            }
            None => McpStatus {
                running: false,
                port: default_port,
                url: None,
                token_masked: None,
            },
        }
    }

    pub fn token(&self) -> Option<String> {
        let guard = self.inner.lock().ok()?;
        let running = guard.as_ref()?;
        running.token.lock().ok().map(|value| value.clone())
    }
}

fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: Option<&[u8]>,
    extra_header: Option<&str>,
) {
    let payload = body.unwrap_or(&[]);
    let mut header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n",
        payload.len()
    );
    if let Some(extra) = extra_header {
        header.push_str(extra);
        header.push_str("\r\n");
    }
    header.push_str("\r\n");
    let _ = stream.write_all(header.as_bytes());
    if !payload.is_empty() {
        let _ = stream.write_all(payload);
    }
    let _ = stream.flush();
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn handle_connection(
    mut stream: TcpStream,
    ctx: &ToolContext,
    token_store: &Arc<Mutex<String>>,
    runtime: &tokio::runtime::Handle,
) {
    let deadline = Instant::now() + REQUEST_DEADLINE;
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        if let Some(pos) = find_header_end(&buffer) {
            break pos;
        }
        if Instant::now() >= deadline {
            write_http_response(
                &mut stream,
                408,
                "Request Timeout",
                Some(b"{\"error\":\"request_timeout\"}"),
                None,
            );
            return;
        }
        if buffer.len() >= MAX_HEADER_BYTES {
            write_http_response(
                &mut stream,
                431,
                "Request Header Fields Too Large",
                Some(b"{\"error\":\"headers_too_large\"}"),
                None,
            );
            return;
        }
        match stream.read(&mut chunk) {
            Ok(0) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
            Err(_) => return,
        }
    };

    let Ok(head_text) = std::str::from_utf8(&buffer[..header_end]) else {
        write_http_response(
            &mut stream,
            400,
            "Bad Request",
            Some(b"{\"error\":\"invalid_headers\"}"),
            None,
        );
        return;
    };
    let mut lines = head_text.split("\r\n");
    let Some(request_line) = lines.next() else {
        write_http_response(&mut stream, 400, "Bad Request", None, None);
        return;
    };
    let mut parts = request_line.split_whitespace();
    let (Some(method), Some(path)) = (parts.next(), parts.next()) else {
        write_http_response(&mut stream, 400, "Bad Request", None, None);
        return;
    };

    let mut content_length: Option<usize> = None;
    let mut authorization: Option<String> = None;
    let mut host_seen = false;
    let mut transfer_encoding = false;

    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.is_empty() || name.bytes().any(|b| b.is_ascii_whitespace()) {
            write_http_response(&mut stream, 400, "Bad Request", None, None);
            return;
        }
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            let Ok(parsed) = value.parse::<usize>() else {
                write_http_response(&mut stream, 400, "Bad Request", None, None);
                return;
            };
            if content_length.is_some_and(|existing| existing != parsed) {
                write_http_response(&mut stream, 400, "Bad Request", None, None);
                return;
            }
            content_length = Some(parsed);
        } else if name.eq_ignore_ascii_case("authorization") {
            authorization = Some(value.to_owned());
        } else if name.eq_ignore_ascii_case("host") {
            if host_seen || !is_allowed_host(value) {
                write_http_response(
                    &mut stream,
                    403,
                    "Forbidden",
                    Some(b"{\"error\":\"forbidden_host\"}"),
                    None,
                );
                return;
            }
            host_seen = true;
        } else if name.eq_ignore_ascii_case("origin") {
            if !is_allowed_origin(value) {
                write_http_response(
                    &mut stream,
                    403,
                    "Forbidden",
                    Some(b"{\"error\":\"forbidden_origin\"}"),
                    None,
                );
                return;
            }
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            transfer_encoding = true;
        }
    }
    if !host_seen {
        write_http_response(
            &mut stream,
            400,
            "Bad Request",
            Some(b"{\"error\":\"missing_host\"}"),
            None,
        );
        return;
    }
    let content_length = content_length.unwrap_or(0);

    if path != "/mcp" && path != "/" {
        write_http_response(
            &mut stream,
            404,
            "Not Found",
            Some(b"{\"error\":\"not_found\"}"),
            None,
        );
        return;
    }
    if method != "POST" {
        write_http_response(
            &mut stream,
            405,
            "Method Not Allowed",
            Some(b"{\"error\":\"method_not_allowed\"}"),
            Some("Allow: POST"),
        );
        return;
    }

    let expected_token = token_store
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    let supplied_token = authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer ")))
        .unwrap_or("");
    if expected_token.is_empty()
        || !constant_time_eq(supplied_token.as_bytes(), expected_token.as_bytes())
    {
        write_http_response(
            &mut stream,
            401,
            "Unauthorized",
            Some(b"{\"error\":\"unauthorized\"}"),
            Some("WWW-Authenticate: Bearer"),
        );
        return;
    }

    if transfer_encoding || content_length > MAX_BODY_BYTES {
        write_http_response(
            &mut stream,
            413,
            "Payload Too Large",
            Some(b"{\"error\":\"payload_too_large\"}"),
            None,
        );
        return;
    }

    let body_start = header_end + 4;
    let mut body = Vec::with_capacity(content_length);
    if buffer.len() > body_start {
        let take = (buffer.len() - body_start).min(content_length);
        body.extend_from_slice(&buffer[body_start..body_start + take]);
    }
    while body.len() < content_length {
        if Instant::now() >= deadline {
            write_http_response(
                &mut stream,
                408,
                "Request Timeout",
                Some(b"{\"error\":\"request_timeout\"}"),
                None,
            );
            return;
        }
        let remaining = content_length - body.len();
        let to_read = remaining.min(chunk.len());
        match stream.read(&mut chunk[..to_read]) {
            Ok(0) => {
                write_http_response(&mut stream, 400, "Bad Request", None, None);
                return;
            }
            Ok(n) => body.extend_from_slice(&chunk[..n]),
            Err(_) => return,
        }
    }

    let response = dispatch_jsonrpc(&body, ctx, runtime);
    match response {
        Some(payload) => {
            let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec());
            write_http_response(&mut stream, 200, "OK", Some(&bytes), None);
        }
        None => {
            write_http_response(&mut stream, 202, "Accepted", None, None);
        }
    }
}

fn jsonrpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        }
    })
}

fn dispatch_jsonrpc(
    body: &[u8],
    ctx: &ToolContext,
    runtime: &tokio::runtime::Handle,
) -> Option<Value> {
    let request: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return Some(jsonrpc_error(Value::Null, -32700, "Parse error")),
    };
    let id = request.get("id").cloned();
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return Some(jsonrpc_error(
            id.unwrap_or(Value::Null),
            -32600,
            "Invalid Request",
        ));
    };
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    if method == "notifications/initialized" || id.is_none() {
        return None;
    }
    let id = id.unwrap_or(Value::Null);

    let permission = ctx
        .state
        .snapshot()
        .map(|data| PermissionTier::parse(&data.config.assistant_permission))
        .unwrap_or(PermissionTier::ReadOnly);

    let result = match method {
        "initialize" => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {
                "tools": {
                    "listChanged": false
                }
            },
            "serverInfo": {
                "name": "voxelight-lumen",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }),
        "ping" => json!({}),
        "tools/list" => {
            let list: Vec<Value> = tools::catalog_for_mcp(permission)
                .into_iter()
                .map(|spec| {
                    json!({
                        "name": spec.name,
                        "description": spec.description,
                        "inputSchema": spec.input_schema,
                    })
                })
                .collect();
            json!({ "tools": list })
        }
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(jsonrpc_error(id, -32602, "Missing params.name"));
            };
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let outcome = match runtime.block_on(tokio::time::timeout(
                Duration::from_secs(120),
                tools::execute_tool(ctx, name, &arguments, permission, false),
            )) {
                Ok(res) => res,
                Err(_) => Err(ToolExecError::Failed("Tool execution timed out".into())),
            };
            match outcome {
                Ok(value) => {
                    let text = serde_json::to_string_pretty(&value)
                        .unwrap_or_else(|_| value.to_string());
                    json!({
                        "content": [{ "type": "text", "text": text }],
                        "isError": false,
                    })
                }
                Err(ToolExecError::PermissionDenied(msg)) => {
                    return Some(jsonrpc_error(id, -32003, &msg));
                }
                Err(ToolExecError::UnknownTool(msg)) => {
                    return Some(jsonrpc_error(id, -32602, &msg));
                }
                Err(ToolExecError::Failed(msg)) => json!({
                    "content": [{ "type": "text", "text": msg }],
                    "isError": true,
                }),
            }
        }
        _ => return Some(jsonrpc_error(id, -32601, "Method not found")),
    };

    Some(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
}
