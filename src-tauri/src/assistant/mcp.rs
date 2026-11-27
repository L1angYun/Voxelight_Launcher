//! Localhost-only MCP (Model Context Protocol) Streamable HTTP / JSON-RPC 2.0 server.
//! Off by default; binds strictly to 127.0.0.1 with an ephemeral per-session Bearer token,
//! Host/Origin validation against DNS-rebinding & CSRF, and permission-tier tool filtering.

use super::tools::{self, McpSession, PermissionTier, ToolContext, ToolExecError, ToolTier};
use crate::storage::LauncherState;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, PoisonError,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

const PROTOCOL_VERSION: &str = "2024-11-05";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_CONCURRENT_CONNECTIONS: usize = 4;
const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
/// How long a tools/call waits for its tool before answering without its result.
const TOOL_CALL_DEADLINE: Duration = Duration::from_secs(120);
/// Tool runs that may outlive their call: a write holds a slot from its start to its end, and
/// a read takes one when it passes the deadline. Writes beyond this are refused as busy.
pub(crate) const MAX_TOOL_SLOTS: usize = 4;

pub(crate) const MCP_NOT_RUNNING: &str = "MCP 服务尚未启动";
/// Prefix of the MCP server's own failures (locks, socket setup, threads).
pub(crate) const MCP_FAILED: &str = "MCP 服务内部错误：";
const BIND_FAILED_PREFIX: &str = "无法在 127.0.0.1:";
const BIND_FAILED_INFIX: &str = " 启动 MCP 服务：";

/// The message for a port the MCP server cannot bind: in use, or reserved by Windows.
pub(crate) fn bind_failed(port: u16, error: &std::io::Error) -> String {
    format!("{BIND_FAILED_PREFIX}{port}{BIND_FAILED_INFIX}{error}")
}

/// The port named by a `bind_failed` message.
pub(crate) fn unavailable_port(detail: &str) -> Option<u16> {
    let (port, _) = detail
        .strip_prefix(BIND_FAILED_PREFIX)?
        .split_once(BIND_FAILED_INFIX)?;
    port.parse().ok()
}

fn internal_failure(what: impl std::fmt::Display) -> String {
    format!("{MCP_FAILED}{what}")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub running: bool,
    pub port: u16,
    pub url: Option<String>,
    pub token_masked: Option<String>,
}

/// The bearer token a run accepts and the session the calls it lets in run under. A token
/// rotation replaces both at once, so a call let in with the old token keeps the old session,
/// which may no longer write.
struct Credentials {
    token: String,
    session: McpSession,
}

struct RunningMcp {
    port: u16,
    credentials: Arc<Mutex<Credentials>>,
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    state: Arc<LauncherState>,
}

impl RunningMcp {
    fn session(&self) -> McpSession {
        self.credentials
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .session
            .clone()
    }

    fn halt(self) {
        self.shutdown.store(true, Ordering::Release);
        // Tasks its calls queued in the download list do not start once the server is gone.
        self.session().cancel_queued(&self.state.control);
        if let Some(handle) = self.handle {
            let _ = handle.join();
        }
    }
}

pub struct McpService {
    inner: Mutex<Option<RunningMcp>>,
    /// Changes whenever a server starts or stops or its token is rotated. Calls keep the value
    /// they were let in under and may write only while it is unchanged.
    generation: Arc<AtomicU64>,
    /// MAX_TOOL_SLOTS slots, shared by every run of the server.
    tool_slots: Arc<Semaphore>,
    tool_deadline: Duration,
    /// How long start() waits, holding the service lock, before it records a new server.
    #[cfg(test)]
    start_pause: Duration,
    /// How long every read tool waits before it runs.
    #[cfg(test)]
    read_pause: Duration,
}

impl Default for McpService {
    fn default() -> Self {
        Self::with_tool_deadline(TOOL_CALL_DEADLINE)
    }
}

impl Drop for McpService {
    fn drop(&mut self) {
        self.stop();
    }
}

/// What every connection of one server run shares. Each call runs with the session it was let
/// in under, not with one fixed for the run.
struct CallContext {
    ctx: ToolContext,
    credentials: Arc<Mutex<Credentials>>,
    runtime: tokio::runtime::Handle,
    deadline: Duration,
    tool_slots: Arc<Semaphore>,
    #[cfg(test)]
    read_pause: Duration,
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
    /// A service whose tools/call stops waiting for its tool once `tool_deadline` passes.
    pub(crate) fn with_tool_deadline(tool_deadline: Duration) -> Self {
        Self {
            inner: Mutex::new(None),
            generation: Arc::new(AtomicU64::new(0)),
            tool_slots: Arc::new(Semaphore::new(MAX_TOOL_SLOTS)),
            tool_deadline,
            #[cfg(test)]
            start_pause: Duration::ZERO,
            #[cfg(test)]
            read_pause: Duration::ZERO,
        }
    }

    pub fn start(
        &self,
        mut ctx: ToolContext,
        port: u16,
        runtime: tokio::runtime::Handle,
    ) -> Result<McpStatus, String> {
        // Held until the new server is recorded, so a concurrent stop() waits for the whole
        // start instead of running between replacing the old server and recording the new one.
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| internal_failure("服务锁异常"))?;
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(existing) = guard.take() {
            existing.halt();
        }
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = TcpListener::bind(addr).map_err(|error| bind_failed(port, &error))?;
        let bound_port = listener
            .local_addr()
            .map_err(|error| internal_failure(format_args!("无法读取监听端口（{error}）")))?
            .port();
        listener
            .set_nonblocking(true)
            .map_err(|error| internal_failure(format_args!("无法配置监听套接字（{error}）")))?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let credentials = Arc::new(Mutex::new(Credentials {
            token: generate_token(),
            session: McpSession::new(generation, self.generation.clone(), shutdown.clone()),
        }));
        ctx.mcp_port = Some(bound_port);
        ctx.mcp_session = None;
        let state = ctx.state.clone();
        let calls = Arc::new(CallContext {
            ctx,
            credentials: credentials.clone(),
            runtime,
            deadline: self.tool_deadline,
            tool_slots: self.tool_slots.clone(),
            #[cfg(test)]
            read_pause: self.read_pause,
        });
        let thread_shutdown = shutdown.clone();
        let handle = thread::Builder::new()
            .name("voxelight-mcp".into())
            .spawn(move || accept_loop(listener, calls, thread_shutdown))
            .map_err(|error| internal_failure(format_args!("无法创建服务线程（{error}）")))?;

        let masked = credentials
            .lock()
            .map(|value| mask_token(&value.token))
            .unwrap_or_else(|_| "••••••".into());
        #[cfg(test)]
        thread::sleep(self.start_pause);
        *guard = Some(RunningMcp {
            port: bound_port,
            credentials,
            shutdown,
            handle: Some(handle),
            state,
        });
        Ok(McpStatus {
            running: true,
            port: bound_port,
            url: Some(format!("http://127.0.0.1:{bound_port}/mcp")),
            token_masked: Some(masked),
        })
    }

    pub fn stop(&self) -> McpStatus {
        let mut guard = match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        // Calls accepted before this point may no longer write, including those still waiting.
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(existing) = guard.take() {
            existing.halt();
        }
        drop(guard);
        McpStatus {
            running: false,
            port: 0,
            url: None,
            token_masked: None,
        }
    }

    /// Replaces the token and revokes what the old one let in: calls accepted with it may no
    /// longer write, including those still waiting, and the tasks they queued are cancelled.
    /// The server keeps running on the same port.
    pub fn rotate_token(&self) -> Result<McpStatus, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| internal_failure("服务锁异常"))?;
        let Some(running) = guard.as_ref() else {
            return Err(MCP_NOT_RUNNING.into());
        };
        let next = generate_token();
        let masked = mask_token(&next);
        let revoked = {
            let mut credentials = running
                .credentials
                .lock()
                .map_err(|_| internal_failure("令牌锁异常"))?;
            let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
            let session =
                McpSession::new(generation, self.generation.clone(), running.shutdown.clone());
            credentials.token = next;
            std::mem::replace(&mut credentials.session, session)
        };
        revoked.cancel_queued(&running.state.control);
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
                    .credentials
                    .lock()
                    .map(|value| mask_token(&value.token))
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
        running.credentials.lock().ok().map(|value| value.token.clone())
    }

    /// Tool slots taken by writes and by reads that passed their deadline.
    #[cfg(test)]
    pub(crate) fn tool_slots_in_use(&self) -> usize {
        MAX_TOOL_SLOTS - self.tool_slots.available_permits()
    }

    /// The session the running server gives its calls.
    #[cfg(test)]
    pub(crate) fn session(&self) -> Option<McpSession> {
        let guard = self.inner.lock().ok()?;
        Some(guard.as_ref()?.session())
    }

    #[cfg(test)]
    pub(crate) fn pause_starts(&mut self, pause: Duration) {
        self.start_pause = pause;
    }

    #[cfg(test)]
    pub(crate) fn pause_reads(&mut self, pause: Duration) {
        self.read_pause = pause;
    }
}

fn accept_loop(listener: TcpListener, calls: Arc<CallContext>, shutdown: Arc<AtomicBool>) {
    let permits = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));
    while !shutdown.load(Ordering::Acquire) {
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
                let conn = calls.clone();
                calls.runtime.spawn_blocking(move || {
                    let _permit = permit;
                    handle_connection(stream, &conn);
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

fn handle_connection(mut stream: TcpStream, calls: &CallContext) {
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

    // The token and the session are read together, so a call let in with a token that is
    // being rotated runs under the session that rotation revokes.
    let credentials = calls
        .credentials
        .lock()
        .ok()
        .map(|value| (value.token.clone(), value.session.clone()));
    let supplied_token = authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer ")))
        .unwrap_or("");
    let Some((_, session)) = credentials.filter(|(expected, _)| {
        !expected.is_empty() && constant_time_eq(supplied_token.as_bytes(), expected.as_bytes())
    }) else {
        write_http_response(
            &mut stream,
            401,
            "Unauthorized",
            Some(b"{\"error\":\"unauthorized\"}"),
            Some("WWW-Authenticate: Bearer"),
        );
        return;
    };

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

    let response = dispatch_jsonrpc(&body, calls, &session);
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

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

fn still_running_text(name: &str) -> String {
    let value = json!({
        "status": "running",
        "tool": name,
        "message": "The action is still running in Voxelight Launcher and will finish on its own; it was not cancelled. Check its progress with list_download_tasks (installs, downloads, backups and clones) or list_running_games (launched games).",
    });
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
}

fn busy_text() -> String {
    format!(
        "Voxelight Launcher is still running {MAX_TOOL_SLOTS} actions started from MCP, so this one was not started. Wait for one to finish (check list_download_tasks or list_running_games) and try again."
    )
}

const READ_TOOK_TOO_LONG: &str =
    "Reading this took too long, so its result was not kept. Try again in a moment.";

enum CallOutcome {
    Finished(Result<Value, ToolExecError>),
    /// A write passed the deadline and keeps running in the launcher.
    StillRunning,
    /// A read passed the deadline; it ends on its own and its result is dropped.
    TookTooLong,
    /// Every slot is held by writes that still run, so this write was not started.
    Busy,
}

/// Runs a tool as a task of its own and waits for it up to the deadline. The task is never
/// cancelled: a call that passes the deadline is answered without the result, and the task
/// ends on its own while it holds a tool slot. A write takes its slot before it starts, or is
/// refused as busy; a read takes one at the deadline, and keeps its call waiting while there
/// is none.
fn run_tool_call(
    calls: &CallContext,
    session: &McpSession,
    name: &str,
    arguments: Value,
    permission: PermissionTier,
) -> CallOutcome {
    let writes = permission == PermissionTier::FullAccess
        && tools::find_tool(name).is_some_and(|spec| spec.tier == ToolTier::Controlled);
    let slot: Arc<Mutex<Option<OwnedSemaphorePermit>>> = Arc::default();
    if writes {
        let Ok(permit) = calls.tool_slots.clone().try_acquire_owned() else {
            return CallOutcome::Busy;
        };
        *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(permit);
    }
    let task_slot = slot.clone();
    let mut ctx = calls.ctx.clone();
    ctx.mcp_session = Some(session.clone());
    let tool = name.to_owned();
    #[cfg(test)]
    let read_pause = if writes { Duration::ZERO } else { calls.read_pause };
    let mut task = calls.runtime.spawn(async move {
        // Whatever slot this run holds is given back when it ends, after its call has gone.
        let _slot = task_slot;
        #[cfg(test)]
        tokio::time::sleep(read_pause).await;
        tools::execute_tool(&ctx, &tool, &arguments, permission, false).await
    });
    loop {
        match calls
            .runtime
            .block_on(tokio::time::timeout(calls.deadline, &mut task))
        {
            Ok(Ok(outcome)) => return CallOutcome::Finished(outcome),
            Ok(Err(_)) => {
                return CallOutcome::Finished(Err(ToolExecError::Failed(
                    "The launcher action stopped unexpectedly.".into(),
                )))
            }
            Err(_) if task.is_finished() => {}
            Err(_) if writes => return CallOutcome::StillRunning,
            Err(_) => {
                if let Ok(permit) = calls.tool_slots.clone().try_acquire_owned() {
                    *slot.lock().unwrap_or_else(PoisonError::into_inner) = Some(permit);
                    return CallOutcome::TookTooLong;
                }
            }
        }
    }
}

fn dispatch_jsonrpc(body: &[u8], calls: &CallContext, session: &McpSession) -> Option<Value> {
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

    // Writes read the permission again once they are admitted to run (tools::recheck_write).
    let permission = calls
        .ctx
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
            match run_tool_call(calls, session, name, arguments, permission) {
                CallOutcome::Finished(Ok(value)) => {
                    let text = serde_json::to_string_pretty(&value)
                        .unwrap_or_else(|_| value.to_string());
                    tool_text(&text, false)
                }
                CallOutcome::Finished(Err(ToolExecError::PermissionDenied(msg))) => {
                    return Some(jsonrpc_error(id, -32003, &msg));
                }
                CallOutcome::Finished(Err(ToolExecError::UnknownTool(msg))) => {
                    return Some(jsonrpc_error(id, -32602, &msg));
                }
                CallOutcome::Finished(Err(ToolExecError::Failed(msg))) => tool_text(&msg, true),
                CallOutcome::StillRunning => tool_text(&still_running_text(name), false),
                CallOutcome::TookTooLong => tool_text(READ_TOOK_TOO_LONG, true),
                CallOutcome::Busy => tool_text(&busy_text(), true),
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
