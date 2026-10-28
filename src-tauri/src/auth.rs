//! Native authentication; only safe account/profile DTOs cross IPC.
//! Protocol sources: Microsoft Learn device-code and Xbox website sign-in documentation;
//! authlib-injector's Yggdrasil server/launcher specifications. No borrowed application IDs.
pub use crate::auth_dto::*;
use crate::secrets::{SecretBackend, SecretStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const DEVICE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBOX_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_API: &str = "https://api.minecraftservices.com";
const SCOPE: &str = "XboxLive.signin offline_access";
const CLIENT_HELP: &str = "请先在设置中填写你自己合法注册的 Microsoft 应用 Client ID，并为个人 Microsoft 账号开启公共客户端/设备代码流；Minecraft/Xbox 服务可能还要求应用准入。不能使用其它启动器的 Client ID。";

enum RequestBody {
    Empty,
    Json(Value),
    Form(Vec<(String, String)>),
    Bytes(Vec<u8>, String),
}
struct AuthRequest {
    method: &'static str,
    url: String,
    body: RequestBody,
    bearer: Option<String>,
}
impl AuthRequest {
    fn json(method: &'static str, url: impl Into<String>, value: Value) -> Self {
        Self {
            method,
            url: url.into(),
            body: RequestBody::Json(value),
            bearer: None,
        }
    }
    fn form(url: &str, fields: &[(&str, &str)]) -> Self {
        Self {
            method: "POST",
            url: url.into(),
            body: RequestBody::Form(
                fields
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            ),
            bearer: None,
        }
    }
    fn api(method: &'static str, path: &str, token: &str) -> Self {
        Self {
            method,
            url: format!("{MC_API}{path}"),
            body: RequestBody::Empty,
            bearer: Some(token.into()),
        }
    }
}
struct AuthResponse {
    status: u16,
    body: Value,
}
trait AuthTransport: Send + Sync {
    fn send(
        &self,
        request: AuthRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AuthResponse, String>> + Send + '_>>;
}
struct HttpTransport {
    client: reqwest::Client,
}
impl AuthTransport for HttpTransport {
    fn send(
        &self,
        request: AuthRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AuthResponse, String>> + Send + '_>> {
        Box::pin(async move {
            validate_https(&request.url)?;
            let method = reqwest::Method::from_bytes(request.method.as_bytes())
                .map_err(|_| "无效的认证请求方法")?;
            let mut builder = self
                .client
                .request(method, &request.url)
                .header("Accept", "application/json");
            if let Some(token) = request.bearer {
                builder = builder.bearer_auth(token);
            }
            builder = match request.body {
                RequestBody::Empty => builder,
                RequestBody::Json(value) => builder.json(&value),
                RequestBody::Form(fields) => builder.form(&fields),
                RequestBody::Bytes(bytes, content_type) => {
                    builder.header("Content-Type", content_type).body(bytes)
                }
            };
            let mut response = builder.send().await.map_err(|error| {
                if error.is_timeout() {
                    "认证请求超时，请检查网络后重试".to_string()
                } else {
                    "认证网络请求失败，请检查网络、代理和 HTTPS 证书后重试".to_string()
                }
            })?;
            let status = response.status().as_u16();
            // Do not follow redirects: a password, refresh token or bearer token must never be forwarded to another origin.
            if (300..400).contains(&status) {
                return Err(
                    "认证服务发生重定向；为保护凭据已拒绝，请填写服务的最终 HTTPS API 地址".into(),
                );
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "认证响应读取失败")?
            {
                if bytes.len() + chunk.len() > 1024 * 1024 {
                    return Err("认证响应过大".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let body = if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).map_err(|_| "认证服务返回了无效 JSON")?
            };
            Ok(AuthResponse { status, body })
        })
    }
}

#[derive(Clone, Deserialize, Serialize)]
struct CredentialRecord {
    account_id: String,
    account_type: String,
    username: String,
    uuid: String,
    expires_at: Option<i64>,
    access_token: String,
    refresh_token: Option<String>,
    microsoft_client_id: Option<String>,
    xuid: Option<String>,
    authlib_server: Option<String>,
    client_token: Option<String>,
}
#[derive(Clone)]
struct MicrosoftToken {
    access_token: String,
    refresh_token: String,
    expires_at: Instant,
}
#[derive(Clone)]
struct DeviceSession {
    client_id: String,
    device_code: String,
    deadline: Instant,
    next_poll: Instant,
    interval: u64,
    in_flight: bool,
    cancelled: Arc<AtomicBool>,
    token: Option<MicrosoftToken>,
}
#[derive(Clone)]
struct AuthlibSession {
    server: String,
    access_token: String,
    client_token: String,
    profiles: Vec<AuthlibProfile>,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    in_flight: bool,
}

pub struct AuthService {
    transport: Arc<dyn AuthTransport>,
    secrets: Arc<dyn SecretBackend>,
    devices: Mutex<HashMap<String, DeviceSession>>,
    authlib_sessions: Mutex<HashMap<String, AuthlibSession>>,
    refresh_lock: tokio::sync::Mutex<()>,
    secret_mutation_lock: Mutex<()>,
}

impl AuthService {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .user_agent("VoxelightLauncher/0.5.0 (native authentication)")
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(35))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "无法初始化认证网络客户端")?;
        Ok(Self::with_backends(
            Arc::new(HttpTransport { client }),
            Arc::new(SecretStore::new(data_dir)),
        ))
    }
    fn with_backends(transport: Arc<dyn AuthTransport>, secrets: Arc<dyn SecretBackend>) -> Self {
        Self {
            transport,
            secrets,
            devices: Mutex::new(HashMap::new()),
            authlib_sessions: Mutex::new(HashMap::new()),
            refresh_lock: tokio::sync::Mutex::new(()),
            secret_mutation_lock: Mutex::new(()),
        }
    }

    pub async fn begin_microsoft(&self, client_id: &str) -> Result<DeviceLogin, String> {
        let client_id = client_id.trim();
        if uuid::Uuid::parse_str(client_id).is_err() {
            return Err(CLIENT_HELP.into());
        }
        let response = self
            .transport
            .send(AuthRequest::form(
                DEVICE_URL,
                &[("client_id", client_id), ("scope", SCOPE)],
            ))
            .await?;
        if response.status != 200 {
            return Err(oauth_error(&response.body));
        }
        let device_code = string_field(&response.body, "device_code")?;
        let user_code = string_field(&response.body, "user_code")?;
        let verification_uri = string_field(&response.body, "verification_uri")?;
        let parsed = validate_https(&verification_uri)?;
        if !matches!(
            parsed.host_str(),
            Some(
                "microsoft.com"
                    | "www.microsoft.com"
                    | "login.microsoftonline.com"
                    | "login.live.com"
            )
        ) {
            return Err("Microsoft 验证页面地址异常".into());
        }
        let expires_in = response.body["expires_in"]
            .as_u64()
            .filter(|v| *v > 0 && *v <= 86400)
            .ok_or("设备代码有效期无效")?;
        let interval = response.body["interval"]
            .as_u64()
            .unwrap_or(5)
            .clamp(1, 300);
        let session_id = uuid::Uuid::new_v4().to_string();
        let now = Instant::now();
        let mut sessions = self.devices.lock().map_err(|_| "认证会话锁异常")?;
        sessions.retain(|_, session| session.deadline > now);
        if sessions.len() >= 8 {
            return Err("登录会话过多，请取消旧会话后重试".into());
        }
        sessions.insert(
            session_id.clone(),
            DeviceSession {
                client_id: client_id.into(),
                device_code,
                deadline: now + Duration::from_secs(expires_in),
                next_poll: now + Duration::from_secs(interval),
                interval,
                in_flight: false,
                cancelled: Arc::new(AtomicBool::new(false)),
                token: None,
            },
        );
        Ok(DeviceLogin {
            session_id,
            user_code,
            verification_uri,
            expires_in,
            interval,
            message: response.body["message"]
                .as_str()
                .unwrap_or("请在 Microsoft 页面输入设备代码并授权")
                .into(),
        })
    }

    pub fn cancel_login(&self, session_id: &str) -> Result<(), String> {
        if let Some(session) = self
            .devices
            .lock()
            .map_err(|_| "认证会话锁异常")?
            .remove(session_id)
        {
            session.cancelled.store(true, Ordering::SeqCst);
        }
        if let Some(session) = self
            .authlib_sessions
            .lock()
            .map_err(|_| "认证会话锁异常")?
            .remove(session_id)
        {
            session.cancelled.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    pub async fn poll_microsoft(&self, session_id: &str) -> Result<DevicePoll, String> {
        let session = {
            let mut sessions = self.devices.lock().map_err(|_| "认证会话锁异常")?;
            let session = sessions
                .get_mut(session_id)
                .ok_or("登录会话已取消或不存在，请重新开始登录")?;
            let now = Instant::now();
            let deadline = session
                .token
                .as_ref()
                .map(|token| token.expires_at)
                .unwrap_or(session.deadline);
            if now >= deadline {
                sessions.remove(session_id);
                return Err("设备代码或临时授权已过期，请重新开始登录".into());
            }
            if session.in_flight || now < session.next_poll {
                return Ok(waiting(
                    "pending",
                    session
                        .next_poll
                        .saturating_duration_since(now)
                        .as_secs()
                        .saturating_add(1),
                ));
            }
            session.in_flight = true;
            session.next_poll = now + Duration::from_secs(session.interval);
            session.clone()
        };
        let result = self.poll_device_inner(session_id, &session).await;
        if let Ok(mut sessions) = self.devices.lock() {
            if let Some(pending) = sessions.get_mut(session_id) {
                pending.in_flight = false;
            }
        }
        result
    }

    async fn poll_device_inner(
        &self,
        session_id: &str,
        session: &DeviceSession,
    ) -> Result<DevicePoll, String> {
        let token = if let Some(token) = &session.token {
            token.clone()
        } else {
            let response = self
                .transport
                .send(AuthRequest::form(
                    TOKEN_URL,
                    &[
                        ("client_id", &session.client_id),
                        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                        ("device_code", &session.device_code),
                    ],
                ))
                .await?;
            if session.cancelled.load(Ordering::SeqCst) {
                return Err("登录已取消".into());
            }
            if response.status != 200 {
                match response.body["error"].as_str().unwrap_or("") {
                    "authorization_pending" => return Ok(waiting("pending", session.interval)),
                    "slow_down" => {
                        let interval = session.interval.saturating_add(5).min(300);
                        if let Some(current) = self
                            .devices
                            .lock()
                            .map_err(|_| "认证会话锁异常")?
                            .get_mut(session_id)
                        {
                            current.interval = interval;
                            current.next_poll = Instant::now() + Duration::from_secs(interval);
                        }
                        return Ok(waiting("slowDown", interval));
                    }
                    "authorization_declined"
                    | "access_denied"
                    | "expired_token"
                    | "bad_verification_code" => {
                        self.cancel_login(session_id)?;
                        return Err(oauth_error(&response.body));
                    }
                    _ => return Err(oauth_error(&response.body)),
                }
            }
            let token = parse_microsoft_token(&response.body, None)?;
            // A consumed device code cannot be reused if a later Xbox/Minecraft request encounters a transient failure.
            if let Some(current) = self
                .devices
                .lock()
                .map_err(|_| "认证会话锁异常")?
                .get_mut(session_id)
            {
                current.token = Some(token.clone());
            }
            token
        };
        let (record, profile) = self.exchange_microsoft(&session.client_id, token).await?;
        // Serialize cancellation with the final save, so closing a pending login cannot create credentials afterwards.
        let mut sessions = self.devices.lock().map_err(|_| "认证会话锁异常")?;
        if session.cancelled.load(Ordering::SeqCst) || !sessions.contains_key(session_id) {
            return Err("登录已取消，请重试".into());
        }
        self.save_record(&record)?;
        sessions.remove(session_id);
        Ok(DevicePoll {
            status: "complete".into(),
            retry_after_seconds: 0,
            account: Some(account_dto(&record, &profile)),
        })
    }

    async fn exchange_microsoft(
        &self,
        client_id: &str,
        token: MicrosoftToken,
    ) -> Result<(CredentialRecord, PlayerProfile), String> {
        let xbox = self.transport.send(AuthRequest::json("POST",XBOX_URL,json!({"Properties":{"AuthMethod":"RPS","SiteName":"user.auth.xboxlive.com","RpsTicket":format!("d={}",token.access_token)},"RelyingParty":"http://auth.xboxlive.com","TokenType":"JWT"}))).await?;
        if xbox.status != 200 {
            return Err("Xbox Live 认证失败，请确认账号已建立 Xbox 档案，且此应用有合法的 Xbox/Minecraft 访问权限".into());
        }
        let xbox_token = string_field(&xbox.body, "Token")?;
        let xsts = self.transport.send(AuthRequest::json("POST",XSTS_URL,json!({"Properties":{"SandboxId":"RETAIL","UserTokens":[xbox_token]},"RelyingParty":"rp://api.minecraftservices.com/","TokenType":"JWT"}))).await?;
        if xsts.status != 200 {
            return Err(xsts_error(&xsts.body));
        }
        // UHS is token-specific. Use the hash in THIS XSTS response, never a cached or Xbox user-token hash.
        let uhs = xsts
            .body
            .pointer("/DisplayClaims/xui/0/uhs")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or("XSTS 响应缺少用户身份哈希")?;
        let xuid = xsts
            .body
            .pointer("/DisplayClaims/xui/0/xid")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let xsts_token = string_field(&xsts.body, "Token")?;
        let minecraft = self
            .transport
            .send(AuthRequest::json(
                "POST",
                format!("{MC_API}/authentication/login_with_xbox"),
                json!({"identityToken":format!("XBL3.0 x={uhs};{xsts_token}")}),
            ))
            .await?;
        if minecraft.status != 200 {
            return Err("Minecraft 令牌交换失败，请检查应用的 Minecraft 服务准入与账号权限".into());
        }
        let access_token = string_field(&minecraft.body, "access_token")?;
        let lifetime = minecraft.body["expires_in"]
            .as_i64()
            .filter(|v| *v > 0 && *v <= 604800)
            .ok_or("Minecraft 令牌有效期无效")?;
        let entitlement = self
            .transport
            .send(AuthRequest::api(
                "GET",
                "/entitlements/mcstore",
                &access_token,
            ))
            .await?;
        if entitlement.status != 200 {
            return Err("无法验证 Minecraft Java 所有权，请重新授权后重试".into());
        }
        let owned = entitlement.body["items"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item["name"].as_str(),
                    Some("product_minecraft" | "game_minecraft")
                )
            })
        });
        if !owned {
            return Err(
                "此账号没有可验证的 Minecraft Java 所有权，请检查购买记录或有效的 Game Pass 权限"
                    .into(),
            );
        }
        let profile = self.minecraft_profile(&access_token).await?;
        let record = CredentialRecord {
            account_id: format!("microsoft-{}", profile.id),
            account_type: "microsoft".into(),
            username: profile.name.clone(),
            uuid: profile.id.clone(),
            expires_at: Some(chrono::Utc::now().timestamp() + lifetime),
            access_token,
            refresh_token: Some(token.refresh_token),
            microsoft_client_id: Some(client_id.into()),
            xuid,
            authlib_server: None,
            client_token: None,
        };
        Ok((record, profile))
    }

    async fn minecraft_profile(&self, token: &str) -> Result<PlayerProfile, String> {
        let response = self
            .transport
            .send(AuthRequest::api("GET", "/minecraft/profile", token))
            .await?;
        if response.status == 404 {
            return Err("该账号尚未建立 Minecraft Java 角色，请先在官方完成角色创建".into());
        }
        if response.status != 200 {
            return Err("无法获取 Minecraft 角色，请刷新登录后重试".into());
        }
        let mut profile: PlayerProfile =
            serde_json::from_value(response.body).map_err(|_| "Minecraft 角色响应无效")?;
        profile.id = normalize_uuid(&profile.id)?;
        if profile.name.is_empty() {
            return Err("Minecraft 角色名称为空".into());
        }
        sanitize_textures(&mut profile);
        Ok(profile)
    }

    pub async fn login_authlib(
        &self,
        server: &str,
        username: &str,
        password: &str,
        profile_id: Option<&str>,
    ) -> Result<AuthlibLogin, String> {
        let server = normalize_authlib_server(server)?;
        if username.trim().is_empty() || password.is_empty() {
            return Err("请输入第三方认证服务的用户名和密码".into());
        }
        if username.len() > 1024 || password.len() > 16384 {
            return Err("认证输入过长".into());
        }
        let client_token = uuid::Uuid::new_v4().to_string();
        let response = self.transport.send(AuthRequest::json("POST",format!("{server}authserver/authenticate"),json!({"agent":{"name":"Minecraft","version":1},"username":username.trim(),"password":password,"clientToken":client_token,"requestUser":true}))).await?;
        if response.status != 200 {
            return Err(authlib_error(response.status));
        }
        check_client_token(&response.body, &client_token)?;
        let access_token = string_field(&response.body, "accessToken")?;
        let selected = response
            .body
            .get("selectedProfile")
            .filter(|v| !v.is_null())
            .map(parse_authlib_profile)
            .transpose()?;
        let profiles = response.body["availableProfiles"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(parse_authlib_profile)
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
        if let Some(selected) = selected {
            if profile_id
                .is_some_and(|id| normalize_uuid(id).ok().as_deref() != Some(selected.id.as_str()))
            {
                return Err("服务已绑定另一角色，请重新登录并选择正确的角色".into());
            }
            let account = self
                .finish_authlib(&server, access_token, client_token, selected)
                .await?;
            return Ok(AuthlibLogin {
                status: "complete".into(),
                session_id: None,
                profiles,
                account: Some(account),
            });
        }
        if profiles.is_empty() {
            return Err("该第三方账号没有可用角色，请先到认证服务创建角色".into());
        }
        let chosen = if let Some(id) = profile_id {
            let id = normalize_uuid(id)?;
            Some(
                profiles
                    .iter()
                    .find(|p| p.id == id)
                    .cloned()
                    .ok_or("所选角色不属于该账号")?,
            )
        } else if profiles.len() == 1 {
            Some(profiles[0].clone())
        } else {
            None
        };
        if let Some(chosen) = chosen {
            let account = self
                .bind_authlib(&server, &access_token, &client_token, &chosen)
                .await?;
            return Ok(AuthlibLogin {
                status: "complete".into(),
                session_id: None,
                profiles,
                account: Some(account),
            });
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let mut sessions = self.authlib_sessions.lock().map_err(|_| "认证会话锁异常")?;
        sessions.retain(|_, session| session.deadline > Instant::now());
        if sessions.len() >= 8 {
            return Err("角色选择会话过多，请取消旧会话".into());
        }
        sessions.insert(
            session_id.clone(),
            AuthlibSession {
                server,
                access_token,
                client_token,
                profiles: profiles.clone(),
                deadline: Instant::now() + Duration::from_secs(600),
                cancelled: Arc::new(AtomicBool::new(false)),
                in_flight: false,
            },
        );
        Ok(AuthlibLogin {
            status: "selectProfile".into(),
            session_id: Some(session_id),
            profiles,
            account: None,
        })
    }

    pub async fn select_authlib_profile(
        &self,
        session_id: &str,
        profile_id: &str,
    ) -> Result<AuthenticatedAccount, String> {
        let profile_id = normalize_uuid(profile_id)?;
        let session = {
            let mut sessions = self.authlib_sessions.lock().map_err(|_| "认证会话锁异常")?;
            let pending = sessions
                .get_mut(session_id)
                .ok_or("角色选择已取消或过期，请重新登录")?;
            if pending.deadline <= Instant::now() {
                sessions.remove(session_id);
                return Err("角色选择已过期，请重新登录".into());
            }
            if pending.in_flight {
                return Err("正在确认角色，请勿重复提交".into());
            }
            if !pending.profiles.iter().any(|p| p.id == profile_id) {
                return Err("所选角色不属于此账号".into());
            }
            pending.in_flight = true;
            pending.clone()
        };
        let profile = session
            .profiles
            .iter()
            .find(|p| p.id == profile_id)
            .ok_or("所选角色不属于此账号")?;
        let result = self
            .authlib_selected_record(
                &session.server,
                &session.access_token,
                &session.client_token,
                profile,
            )
            .await;
        match result {
            Ok((record, profile)) => {
                let mut sessions = self.authlib_sessions.lock().map_err(|_| "认证会话锁异常")?;
                if session.cancelled.load(Ordering::SeqCst) || !sessions.contains_key(session_id) {
                    return Err("角色选择已取消".into());
                }
                self.save_record(&record)?;
                sessions.remove(session_id);
                Ok(account_dto(&record, &profile))
            }
            Err(error) => {
                if let Some(pending) = self
                    .authlib_sessions
                    .lock()
                    .map_err(|_| "认证会话锁异常")?
                    .get_mut(session_id)
                {
                    pending.in_flight = false;
                }
                Err(error)
            }
        }
    }

    async fn bind_authlib(
        &self,
        server: &str,
        access_token: &str,
        client_token: &str,
        profile: &AuthlibProfile,
    ) -> Result<AuthenticatedAccount, String> {
        let (record, profile) = self
            .authlib_selected_record(server, access_token, client_token, profile)
            .await?;
        self.save_record(&record)?;
        Ok(account_dto(&record, &profile))
    }

    async fn authlib_selected_record(
        &self,
        server: &str,
        access_token: &str,
        client_token: &str,
        profile: &AuthlibProfile,
    ) -> Result<(CredentialRecord, PlayerProfile), String> {
        let response = self.transport.send(AuthRequest::json("POST",format!("{server}authserver/refresh"),json!({"accessToken":access_token,"clientToken":client_token,"selectedProfile":profile,"requestUser":true}))).await?;
        if response.status != 200 {
            return Err(authlib_error(response.status));
        }
        check_client_token(&response.body, client_token)?;
        let selected = parse_authlib_profile(&response.body["selectedProfile"])?;
        if selected.id != profile.id {
            return Err("认证服务返回了不同角色，已停止登录".into());
        }
        self.authlib_record(
            server,
            string_field(&response.body, "accessToken")?,
            client_token.into(),
            selected,
        )
        .await
    }

    async fn finish_authlib(
        &self,
        server: &str,
        access_token: String,
        client_token: String,
        selected: AuthlibProfile,
    ) -> Result<AuthenticatedAccount, String> {
        let (record, profile) = self
            .authlib_record(server, access_token, client_token, selected)
            .await?;
        self.save_record(&record)?;
        Ok(account_dto(&record, &profile))
    }

    async fn authlib_record(
        &self,
        server: &str,
        access_token: String,
        client_token: String,
        selected: AuthlibProfile,
    ) -> Result<(CredentialRecord, PlayerProfile), String> {
        use sha2::{Digest, Sha256};
        let record = CredentialRecord {
            account_id: format!(
                "authlib-{:x}",
                Sha256::digest(format!("{server}|{}", selected.id).as_bytes())
            ),
            account_type: "authlib".into(),
            username: selected.name,
            uuid: selected.id,
            expires_at: None,
            access_token,
            refresh_token: None,
            microsoft_client_id: None,
            xuid: None,
            authlib_server: Some(server.into()),
            client_token: Some(client_token),
        };
        // Texture availability is optional. An authenticated account must remain usable when its texture server is unavailable.
        let profile = self
            .authlib_profile(&record)
            .await
            .unwrap_or_else(|_| PlayerProfile {
                id: record.uuid.clone(),
                name: record.username.clone(),
                ..Default::default()
            });
        Ok((record, profile))
    }

    pub async fn refresh_account(&self, account_id: &str) -> Result<AuthenticatedAccount, String> {
        let _guard = self.refresh_lock.lock().await;
        let record = self.refresh_record(self.load_record(account_id)?).await?;
        let profile = if record.account_type == "authlib" {
            self.authlib_profile(&record)
                .await
                .unwrap_or_else(|_| PlayerProfile {
                    id: record.uuid.clone(),
                    name: record.username.clone(),
                    ..Default::default()
                })
        } else {
            self.profile_for(&record).await?
        };
        Ok(account_dto(&record, &profile))
    }

    pub async fn game_credentials(&self, account_id: &str) -> Result<GameCredentials, String> {
        let _guard = self.refresh_lock.lock().await;
        let mut record = self.load_record(account_id)?;
        if record.account_type == "microsoft" {
            if record.expires_at.unwrap_or(0) <= chrono::Utc::now().timestamp() + 120 {
                record = self.refresh_record(record).await?;
            } else {
                // A still-dated token can have been revoked. Confirm with the official profile endpoint before launch.
                let response = self
                    .transport
                    .send(AuthRequest::api(
                        "GET",
                        "/minecraft/profile",
                        &record.access_token,
                    ))
                    .await?;
                if response.status == 401 || response.status == 403 {
                    record = self.refresh_record(record).await?;
                } else if response.status != 200 {
                    return Err("无法验证账号会话，请检查网络或重新登录".into());
                } else {
                    let profile: PlayerProfile = serde_json::from_value(response.body)
                        .map_err(|_| "角色会话响应格式无效")?;
                    if normalize_uuid(&profile.id)? != record.uuid {
                        return Err("当前会话的角色与所选账号不一致，请重新登录".into());
                    }
                    if !profile.name.is_empty() && profile.name != record.username {
                        record.username = profile.name;
                    }
                }
            }
        } else if record.account_type == "authlib" {
            let response = self
                .transport
                .send(AuthRequest::json(
                    "POST",
                    format!(
                        "{}authserver/validate",
                        record.authlib_server.as_deref().ok_or("认证服务缺失")?
                    ),
                    json!({"accessToken":record.access_token,"clientToken":record.client_token}),
                ))
                .await?;
            if response.status == 401 || response.status == 403 {
                record = self.refresh_record(record).await?;
            } else if response.status != 200 && response.status != 204 {
                return Err("无法验证第三方会话，请检查网络后重新登录".into());
            }
        } else {
            return Err("凭据类型无效".into());
        }
        Ok(GameCredentials {
            access_token: record.access_token,
            username: record.username,
            uuid: record.uuid,
            account_type: record.account_type,
            xuid: record.xuid,
            client_id: record.microsoft_client_id,
            authlib_server: record.authlib_server,
            expires_at: record.expires_at.unwrap_or(0),
        })
    }

    async fn refresh_record(&self, record: CredentialRecord) -> Result<CredentialRecord, String> {
        let mut next = if record.account_type == "microsoft" {
            let client_id = record.microsoft_client_id.as_deref().ok_or(CLIENT_HELP)?;
            let old_refresh = record
                .refresh_token
                .as_deref()
                .ok_or("没有刷新令牌，请重新登录")?;
            let response = self
                .transport
                .send(AuthRequest::form(
                    TOKEN_URL,
                    &[
                        ("client_id", client_id),
                        ("grant_type", "refresh_token"),
                        ("refresh_token", old_refresh),
                        ("scope", SCOPE),
                    ],
                ))
                .await?;
            if response.status != 200 {
                return Err(oauth_error(&response.body));
            }
            let (next, _) = self
                .exchange_microsoft(
                    client_id,
                    parse_microsoft_token(&response.body, Some(old_refresh))?,
                )
                .await?;
            next
        } else if record.account_type == "authlib" {
            let server = record.authlib_server.as_deref().ok_or("认证服务缺失")?;
            let client_token = record
                .client_token
                .as_deref()
                .ok_or("第三方会话缺少 clientToken，请重新登录")?;
            let response = self.transport.send(AuthRequest::json("POST",format!("{server}authserver/refresh"),json!({"accessToken":record.access_token,"clientToken":client_token,"requestUser":true}))).await?;
            if response.status != 200 {
                return Err(authlib_error(response.status));
            }
            check_client_token(&response.body, client_token)?;
            let selected = parse_authlib_profile(&response.body["selectedProfile"])?;
            if selected.id != record.uuid {
                return Err("刷新后的第三方角色与原账号不一致，请重新登录".into());
            }
            let mut next = record.clone();
            next.access_token = string_field(&response.body, "accessToken")?;
            next.username = selected.name;
            next
        } else {
            return Err("此账号不支持刷新".into());
        };
        if next.uuid != record.uuid {
            return Err("刷新后的账号身份与原账号不一致，已拒绝替换".into());
        }
        next.account_id = record.account_id;
        // A concurrent logout/new login must not be undone by this earlier network refresh.
        let _mutation = self
            .secret_mutation_lock
            .lock()
            .map_err(|_| "凭据更新锁异常")?;
        let current = self.load_record(&next.account_id)?;
        if current.access_token != record.access_token {
            return Ok(current);
        }
        self.save_record_unlocked(&next)?;
        Ok(next)
    }

    pub async fn get_profile(&self, account_id: &str) -> Result<PlayerProfile, String> {
        self.game_credentials(account_id).await?;
        self.profile_for(&self.load_record(account_id)?).await
    }
    /// Safe metadata refresh after an appearance change; avoids an unnecessary forced OAuth refresh.
    pub async fn account_info(&self, account_id: &str) -> Result<AuthenticatedAccount, String> {
        let profile = self.get_profile(account_id).await?;
        Ok(account_dto(&self.load_record(account_id)?, &profile))
    }
    async fn profile_for(&self, record: &CredentialRecord) -> Result<PlayerProfile, String> {
        if record.account_type == "microsoft" {
            self.minecraft_profile(&record.access_token).await
        } else {
            self.authlib_profile(record).await
        }
    }
    async fn authlib_profile(&self, record: &CredentialRecord) -> Result<PlayerProfile, String> {
        let server = record
            .authlib_server
            .as_deref()
            .ok_or("第三方服务地址缺失")?;
        let response = self
            .transport
            .send(AuthRequest {
                method: "GET",
                url: format!(
                    "{server}sessionserver/session/minecraft/profile/{}",
                    record.uuid
                ),
                body: RequestBody::Empty,
                bearer: None,
            })
            .await?;
        if response.status != 200 {
            return Err("无法获取第三方角色皮肤".into());
        }
        parse_texture_profile(&response.body, &record.uuid, &record.username)
    }

    pub async fn upload_skin(
        &self,
        account_id: &str,
        png: &[u8],
        model: &str,
    ) -> Result<PlayerProfile, String> {
        validate_skin_png(png, model)?;
        let credentials = self.game_credentials(account_id).await?;
        if credentials.account_type != "microsoft" {
            return Err(
                "此上传入口只适用于 Microsoft 正版账号；第三方皮肤请到对应认证服务管理".into(),
            );
        }
        let boundary = format!("VoxelightLauncher{}", uuid::Uuid::new_v4().simple());
        let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"variant\"\r\n\r\n{model}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"skin.png\"\r\nContent-Type: image/png\r\n\r\n").into_bytes();
        body.extend_from_slice(png);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let response = self
            .transport
            .send(AuthRequest {
                method: "POST",
                url: format!("{MC_API}/minecraft/profile/skins"),
                body: RequestBody::Bytes(body, format!("multipart/form-data; boundary={boundary}")),
                bearer: Some(credentials.access_token),
            })
            .await?;
        if response.status != 200 && response.status != 204 {
            return Err("正版皮肤上传失败，请确认 PNG、模型与账号权限后重试".into());
        }
        self.profile_for(&self.load_record(account_id)?).await
    }
    pub async fn reset_skin(&self, account_id: &str) -> Result<PlayerProfile, String> {
        self.change_profile(
            account_id,
            "DELETE",
            "/minecraft/profile/skins/active",
            None,
        )
        .await
    }
    pub async fn select_cape(
        &self,
        account_id: &str,
        cape_id: Option<&str>,
    ) -> Result<PlayerProfile, String> {
        let path = "/minecraft/profile/capes/active";
        let value = if let Some(id) = cape_id {
            normalize_uuid(id)?;
            Some(json!({"capeId":id}))
        } else {
            None
        };
        self.change_profile(
            account_id,
            if value.is_some() { "PUT" } else { "DELETE" },
            path,
            value,
        )
        .await
    }
    async fn change_profile(
        &self,
        account_id: &str,
        method: &'static str,
        path: &str,
        body: Option<Value>,
    ) -> Result<PlayerProfile, String> {
        let credentials = self.game_credentials(account_id).await?;
        if credentials.account_type != "microsoft" {
            return Err("此操作只适用于 Microsoft 正版账号".into());
        }
        let mut request = AuthRequest::api(method, path, &credentials.access_token);
        if let Some(body) = body {
            request.body = RequestBody::Json(body);
        }
        let response = self.transport.send(request).await?;
        if response.status != 200 && response.status != 204 {
            return Err("皮肤或披风操作失败，请确认该账号拥有对应内容并重新授权".into());
        }
        self.profile_for(&self.load_record(account_id)?).await
    }

    pub fn remove_credentials(&self, account_id: &str) -> Result<(), String> {
        let _guard = self
            .secret_mutation_lock
            .lock()
            .map_err(|_| "凭据更新锁异常")?;
        self.secrets.remove(&format!("account:{account_id}"))
    }
    fn save_record(&self, record: &CredentialRecord) -> Result<(), String> {
        let _guard = self
            .secret_mutation_lock
            .lock()
            .map_err(|_| "凭据更新锁异常")?;
        self.save_record_unlocked(record)
    }
    fn save_record_unlocked(&self, record: &CredentialRecord) -> Result<(), String> {
        self.secrets.set(
            &format!("account:{}", record.account_id),
            &serde_json::to_string(record).map_err(|_| "无法编码账号凭据")?,
        )
    }
    fn load_record(&self, account_id: &str) -> Result<CredentialRecord, String> {
        let encoded = self
            .secrets
            .get(&format!("account:{account_id}"))?
            .ok_or("没有此账号的系统加密凭据，请重新登录")?;
        let record: CredentialRecord =
            serde_json::from_str(&encoded).map_err(|_| "加密凭据损坏，请重新登录")?;
        if record.account_id != account_id {
            return Err("账号凭据标识不匹配".into());
        }
        Ok(record)
    }
}

fn waiting(status: &str, seconds: u64) -> DevicePoll {
    DevicePoll {
        status: status.into(),
        retry_after_seconds: seconds.max(1),
        account: None,
    }
}
fn string_field(value: &Value, field: &str) -> Result<String, String> {
    value[field]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("认证响应缺少必要字段 {field}"))
}
fn validate_https(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "认证服务网址无效")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("认证服务必须使用不含用户名、密码或片段的 HTTPS 网址".into());
    }
    Ok(url)
}
pub fn normalize_authlib_server(value: &str) -> Result<String, String> {
    let mut url = validate_https(value.trim())?;
    if url.query().is_some() {
        return Err("请填写第三方认证 API 根地址，不要包含查询参数".into());
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url.to_string())
}
fn normalize_uuid(id: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(id)
        .map(|id| id.simple().to_string())
        .map_err(|_| "角色 UUID 格式无效".into())
}
fn parse_microsoft_token(
    value: &Value,
    previous_refresh: Option<&str>,
) -> Result<MicrosoftToken, String> {
    let lifetime = value["expires_in"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 86400)
        .ok_or("Microsoft 授权有效期无效")?;
    Ok(MicrosoftToken {
        access_token: string_field(value, "access_token")?,
        refresh_token: value["refresh_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or(previous_refresh)
            .ok_or("Microsoft 没有颁发刷新令牌，请重新授权 offline_access 权限")?
            .into(),
        expires_at: Instant::now() + Duration::from_secs(lifetime),
    })
}
fn oauth_error(value: &Value) -> String {
    match value["error"].as_str().unwrap_or("") {
        "authorization_declined" | "access_denied" => "用户拒绝了授权，登录已结束".into(),
        "expired_token" | "bad_verification_code" => "设备代码已过期或无效，请重新开始登录".into(),
        "invalid_grant" | "interaction_required" => {
            "登录授权已失效或需要重新确认，请重新登录".into()
        }
        "invalid_client" | "unauthorized_client" | "invalid_scope" => CLIENT_HELP.into(),
        _ => "Microsoft 授权失败，请检查应用配置与网络后重试".into(),
    }
}
fn xsts_error(value: &Value) -> String {
    match value["XErr"].as_u64() {
        Some(2148916233) => {
            "此 Microsoft 账号尚未建立 Xbox 档案，请先访问 Xbox 官网完成创建".into()
        }
        Some(2148916235) => "该地区的 Xbox Live 服务不可用".into(),
        Some(2148916236 | 2148916237) => {
            "Xbox 要求完成年龄或成人身份验证，请到 Xbox 官网处理".into()
        }
        Some(2148916238) => "此儿童账号需要加入 Microsoft 家庭并获得监护人许可".into(),
        _ => "Xbox XSTS 授权失败，请检查账号限制和应用准入".into(),
    }
}
fn authlib_error(status: u16) -> String {
    match status {
        401 | 403 => "第三方认证失败，用户名、密码或会话可能无效，请重新登录".into(),
        429 => "第三方服务请求过于频繁，请稍后重试".into(),
        _ => format!("第三方认证服务请求失败（HTTP {status}），请检查 API 根地址或稍后重试"),
    }
}
fn parse_authlib_profile(value: &Value) -> Result<AuthlibProfile, String> {
    let name = string_field(value, "name")?;
    if name.len() > 128 || name.chars().any(char::is_control) {
        return Err("第三方角色名称无效".into());
    }
    Ok(AuthlibProfile {
        id: normalize_uuid(&string_field(value, "id")?)?,
        name,
    })
}
fn check_client_token(value: &Value, expected: &str) -> Result<(), String> {
    if value["clientToken"].as_str() != Some(expected) {
        return Err("第三方服务返回的 clientToken 与请求不匹配，已拒绝登录".into());
    }
    Ok(())
}
fn account_dto(record: &CredentialRecord, profile: &PlayerProfile) -> AuthenticatedAccount {
    let active = profile
        .skins
        .iter()
        .find(|skin| skin.state.eq_ignore_ascii_case("ACTIVE"))
        .or(profile.skins.first());
    AuthenticatedAccount {
        id: record.account_id.clone(),
        username: if profile.name.is_empty() {
            record.username.clone()
        } else {
            profile.name.clone()
        },
        uuid: record.uuid.clone(),
        account_type: record.account_type.clone(),
        expires_at: record.expires_at,
        skin_url: active.map(|skin| skin.url.clone()),
        skin_model: active.map(|skin| {
            if skin
                .variant
                .as_deref()
                .is_some_and(|v| v.eq_ignore_ascii_case("slim"))
            {
                "slim".into()
            } else {
                "classic".into()
            }
        }),
        authlib_server: record.authlib_server.clone(),
    }
}
fn sanitize_textures(profile: &mut PlayerProfile) {
    profile.skins.retain_mut(|skin| {
        skin.url = upgrade_texture_url(&skin.url);
        validate_https(&skin.url).is_ok()
    });
    profile.capes.retain_mut(|cape| {
        cape.url = upgrade_texture_url(&cape.url);
        validate_https(&cape.url).is_ok()
    });
}
fn upgrade_texture_url(url: &str) -> String {
    if url.starts_with("http://textures.minecraft.net/") {
        format!("https://{}", &url[7..])
    } else {
        url.into()
    }
}
fn parse_texture_profile(value: &Value, uuid: &str, name: &str) -> Result<PlayerProfile, String> {
    let id = normalize_uuid(&string_field(value, "id")?)?;
    if id != uuid {
        return Err("第三方皮肤响应中的角色身份不匹配".into());
    }
    let mut profile = PlayerProfile {
        id,
        name: value["name"].as_str().unwrap_or(name).into(),
        ..Default::default()
    };
    if let Some(property) = value["properties"].as_array().and_then(|items| {
        items
            .iter()
            .find(|p| p["name"].as_str() == Some("textures"))
    }) {
        let decoded = decode_base64(&string_field(property, "value")?)?;
        let textures: Value =
            serde_json::from_slice(&decoded).map_err(|_| "第三方皮肤属性 JSON 无效")?;
        if let Some(url) = textures
            .pointer("/textures/SKIN/url")
            .and_then(Value::as_str)
        {
            profile.skins.push(ProfileSkin {
                id: String::new(),
                state: "ACTIVE".into(),
                url: url.into(),
                variant: textures
                    .pointer("/textures/SKIN/metadata/model")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            });
        }
        if let Some(url) = textures
            .pointer("/textures/CAPE/url")
            .and_then(Value::as_str)
        {
            profile.capes.push(ProfileCape {
                id: String::new(),
                state: "ACTIVE".into(),
                url: url.into(),
                alias: None,
            });
        }
    }
    sanitize_textures(&mut profile);
    Ok(profile)
}
fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    if value.len() > 512 * 1024 || value.len() % 4 == 1 {
        return Err("皮肤属性编码无效".into());
    }
    let mut output = Vec::with_capacity(value.len() * 3 / 4);
    let mut bits = 0u32;
    let mut count = 0;
    let mut padding = false;
    for byte in value.bytes() {
        if byte == b'=' {
            padding = true;
            continue;
        }
        if padding {
            return Err("皮肤属性 Base64 填充无效".into());
        }
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("皮肤属性 Base64 无效".into()),
        };
        bits = (bits << 6) | digit as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            output.push((bits >> count) as u8);
        }
    }
    Ok(output)
}
fn validate_skin_png(png: &[u8], model: &str) -> Result<(), String> {
    if !matches!(model, "classic" | "slim") {
        return Err("皮肤模型必须是 classic 或 slim".into());
    }
    if png.len() < 33
        || png.len() > 1024 * 1024
        || &png[..8] != b"\x89PNG\r\n\x1a\n"
        || &png[12..16] != b"IHDR"
    {
        return Err("请选择有效且不超过 1 MB 的 PNG 皮肤".into());
    }
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    if width != 64 || !matches!(height, 32 | 64) {
        return Err("正版皮肤上传要求 64×64 或 64×32 PNG（高清贴图仅供本地预览）".into());
    }
    if height == 32 && model == "slim" {
        return Err("64×32 旧版皮肤仅支持 classic 模型".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    type Step = Box<dyn FnOnce(AuthRequest) -> Result<AuthResponse, String> + Send>;
    #[derive(Default)]
    struct MemorySecrets {
        entries: Mutex<HashMap<String, String>>,
    }
    impl SecretBackend for MemorySecrets {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.entries.lock().unwrap().get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), String> {
            self.entries
                .lock()
                .unwrap()
                .insert(key.into(), value.into());
            Ok(())
        }
        fn remove(&self, key: &str) -> Result<(), String> {
            self.entries.lock().unwrap().remove(key);
            Ok(())
        }
    }
    struct MockTransport {
        steps: Mutex<VecDeque<Step>>,
        calls: Mutex<Vec<String>>,
    }
    impl MockTransport {
        fn new(steps: Vec<Step>) -> Arc<Self> {
            Arc::new(Self {
                steps: Mutex::new(steps.into()),
                calls: Mutex::new(Vec::new()),
            })
        }
        fn done(&self) {
            assert!(
                self.steps.lock().unwrap().is_empty(),
                "protocol did not consume all expected responses"
            );
        }
    }
    impl AuthTransport for MockTransport {
        fn send(
            &self,
            request: AuthRequest,
        ) -> Pin<Box<dyn Future<Output = Result<AuthResponse, String>> + Send + '_>> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(request.url.clone());
                let step = self
                    .steps
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("unexpected authentication request");
                step(request)
            })
        }
    }
    fn reply(url: &str, status: u16, body: Value) -> Step {
        let url = url.to_owned();
        Box::new(move |request| {
            assert_eq!(request.url, url);
            Ok(AuthResponse { status, body })
        })
    }
    fn json_request(request: &AuthRequest) -> &Value {
        let RequestBody::Json(body) = &request.body else {
            panic!("expected JSON body")
        };
        body
    }
    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Runtime::new().unwrap().block_on(future)
    }
    fn service(steps: Vec<Step>) -> (AuthService, Arc<MockTransport>, Arc<MemorySecrets>) {
        let transport = MockTransport::new(steps);
        let secrets = Arc::new(MemorySecrets::default());
        (
            AuthService::with_backends(transport.clone(), secrets.clone()),
            transport,
            secrets,
        )
    }
    fn device_step() -> Step {
        reply(
            DEVICE_URL,
            200,
            json!({"device_code":"test-device-secret","user_code":"TEST-CODE","verification_uri":"https://microsoft.com/devicelogin","expires_in":900,"interval":5}),
        )
    }
    fn token_step() -> Step {
        reply(
            TOKEN_URL,
            200,
            json!({"access_token":"test-msa-token","refresh_token":"test-refresh-token","expires_in":3600}),
        )
    }
    const PROFILE_ID: &str = "069a79f444e94726a5befca90e38aaf5";
    const SECOND_ID: &str = "853c80ef3c3749fdaa49938b674adae6";
    fn profile_body() -> Value {
        json!({"id":PROFILE_ID,"name":"TestPlayer","skins":[{"id":"skin","state":"ACTIVE","url":"https://textures.minecraft.net/texture/test","variant":"SLIM"}],"capes":[]})
    }
    fn exchange_steps() -> Vec<Step> {
        vec![
            Box::new(|request| {
                assert_eq!(request.url, XBOX_URL);
                assert_eq!(
                    json_request(&request)["Properties"]["RpsTicket"],
                    "d=test-msa-token"
                );
                assert!(request.bearer.is_none());
                Ok(AuthResponse {
                    status: 200,
                    body: json!({"Token":"test-xbox-user-token","DisplayClaims":{"xui":[{"uhs":"WRONG-OLD-HASH"}]}}),
                })
            }),
            reply(
                XSTS_URL,
                200,
                json!({"Token":"test-xsts-token","DisplayClaims":{"xui":[{"uhs":"XSTS-HASH","xid":"123456789"}]}}),
            ),
            Box::new(|request| {
                assert_eq!(
                    request.url,
                    format!("{MC_API}/authentication/login_with_xbox")
                );
                assert_eq!(
                    json_request(&request)["identityToken"],
                    "XBL3.0 x=XSTS-HASH;test-xsts-token"
                );
                Ok(AuthResponse {
                    status: 200,
                    body: json!({"access_token":"test-minecraft-token","expires_in":86400}),
                })
            }),
            Box::new(|request| {
                assert_eq!(request.url, format!("{MC_API}/entitlements/mcstore"));
                assert_eq!(request.bearer.as_deref(), Some("test-minecraft-token"));
                Ok(AuthResponse {
                    status: 200,
                    body: json!({"items":[{"name":"game_minecraft"}]}),
                })
            }),
            reply(&format!("{MC_API}/minecraft/profile"), 200, profile_body()),
        ]
    }
    fn due(service: &AuthService, id: &str) {
        service
            .devices
            .lock()
            .unwrap()
            .get_mut(id)
            .unwrap()
            .next_poll = Instant::now() - Duration::from_secs(1);
    }
    fn ms_record() -> CredentialRecord {
        CredentialRecord {
            account_id: format!("microsoft-{PROFILE_ID}"),
            account_type: "microsoft".into(),
            username: "TestPlayer".into(),
            uuid: PROFILE_ID.into(),
            expires_at: Some(chrono::Utc::now().timestamp() - 1),
            access_token: "old-minecraft-token".into(),
            refresh_token: Some("old-refresh-token".into()),
            microsoft_client_id: Some(uuid::Uuid::new_v4().to_string()),
            xuid: None,
            authlib_server: None,
            client_token: None,
        }
    }
    fn auth_record() -> CredentialRecord {
        CredentialRecord {
            account_id: "authlib-test-account".into(),
            account_type: "authlib".into(),
            username: "TestPlayer".into(),
            uuid: PROFILE_ID.into(),
            expires_at: None,
            access_token: "old-authlib-token".into(),
            refresh_token: None,
            microsoft_client_id: None,
            xuid: None,
            authlib_server: Some("https://auth.example.invalid/api/".into()),
            client_token: Some("test-client-token".into()),
        }
    }

    #[test]
    fn no_application_id_never_contacts_oauth() {
        run(async {
            let (service, transport, _) = service(vec![]);
            let error = service.begin_microsoft("").await.err().unwrap();
            assert!(error.contains("Client ID"));
            assert!(transport.calls.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn device_poll_respects_pending_interval_and_slow_down() {
        run(async {
            let (service, transport, _) = service(vec![
                device_step(),
                reply(TOKEN_URL, 400, json!({"error":"authorization_pending"})),
                reply(TOKEN_URL, 400, json!({"error":"slow_down"})),
            ]);
            let login = service
                .begin_microsoft(&uuid::Uuid::new_v4().to_string())
                .await
                .unwrap();
            assert_eq!(
                service
                    .poll_microsoft(&login.session_id)
                    .await
                    .unwrap()
                    .status,
                "pending"
            );
            assert_eq!(transport.calls.lock().unwrap().len(), 1);
            due(&service, &login.session_id);
            assert_eq!(
                service
                    .poll_microsoft(&login.session_id)
                    .await
                    .unwrap()
                    .retry_after_seconds,
                5
            );
            assert_eq!(
                service
                    .poll_microsoft(&login.session_id)
                    .await
                    .unwrap()
                    .status,
                "pending"
            );
            assert_eq!(transport.calls.lock().unwrap().len(), 2);
            due(&service, &login.session_id);
            let slow = service.poll_microsoft(&login.session_id).await.unwrap();
            assert_eq!(slow.status, "slowDown");
            assert_eq!(slow.retry_after_seconds, 10);
            transport.done();
        });
    }

    #[test]
    fn successful_chain_uses_xsts_hash_and_returns_no_tokens() {
        run(async {
            let mut steps = vec![device_step(), token_step()];
            steps.extend(exchange_steps());
            let (service, transport, secrets) = service(steps);
            let login = service
                .begin_microsoft(&uuid::Uuid::new_v4().to_string())
                .await
                .unwrap();
            due(&service, &login.session_id);
            let result = service.poll_microsoft(&login.session_id).await.unwrap();
            assert_eq!(result.status, "complete");
            let account = result.account.unwrap();
            assert_eq!(account.uuid, PROFILE_ID);
            assert_eq!(account.skin_model.as_deref(), Some("slim"));
            let safe = serde_json::to_string(&account).unwrap();
            for secret in [
                "test-refresh-token",
                "test-minecraft-token",
                "test-xsts-token",
                "test-device-secret",
            ] {
                assert!(!safe.contains(secret));
            }
            assert_eq!(secrets.entries.lock().unwrap().len(), 1);
            assert!(service.devices.lock().unwrap().is_empty());
            transport.done();
        });
    }

    #[test]
    fn expired_declined_and_cancelled_codes_do_not_create_credentials() {
        run(async {
            let (service, transport, secrets) = service(vec![
                device_step(),
                device_step(),
                reply(TOKEN_URL, 400, json!({"error":"authorization_declined"})),
                device_step(),
            ]);
            let client = uuid::Uuid::new_v4().to_string();
            let expired = service.begin_microsoft(&client).await.unwrap();
            service
                .devices
                .lock()
                .unwrap()
                .get_mut(&expired.session_id)
                .unwrap()
                .deadline = Instant::now() - Duration::from_secs(1);
            assert!(service
                .poll_microsoft(&expired.session_id)
                .await
                .err()
                .unwrap()
                .contains("过期"));
            let declined = service.begin_microsoft(&client).await.unwrap();
            due(&service, &declined.session_id);
            assert!(service
                .poll_microsoft(&declined.session_id)
                .await
                .err()
                .unwrap()
                .contains("拒绝"));
            let cancelled = service.begin_microsoft(&client).await.unwrap();
            service.cancel_login(&cancelled.session_id).unwrap();
            assert!(service.poll_microsoft(&cancelled.session_id).await.is_err());
            assert!(secrets.entries.lock().unwrap().is_empty());
            transport.done();
        });
    }

    #[test]
    fn downstream_network_retry_reuses_already_consumed_device_token() {
        run(async {
            let mut steps = vec![
                device_step(),
                token_step(),
                Box::new(|request: AuthRequest| {
                    assert_eq!(request.url, XBOX_URL);
                    Err("mock temporary network failure".into())
                }) as Step,
            ];
            steps.extend(exchange_steps());
            let (service, transport, _) = service(steps);
            let login = service
                .begin_microsoft(&uuid::Uuid::new_v4().to_string())
                .await
                .unwrap();
            due(&service, &login.session_id);
            assert!(service.poll_microsoft(&login.session_id).await.is_err());
            due(&service, &login.session_id);
            // The device-code deadline no longer invalidates an OAuth token already obtained in time.
            service
                .devices
                .lock()
                .unwrap()
                .get_mut(&login.session_id)
                .unwrap()
                .deadline = Instant::now() - Duration::from_secs(1);
            assert_eq!(
                service
                    .poll_microsoft(&login.session_id)
                    .await
                    .unwrap()
                    .status,
                "complete"
            );
            assert_eq!(
                transport
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|url| url.as_str() == TOKEN_URL)
                    .count(),
                1
            );
            transport.done();
        });
    }

    #[test]
    fn no_ownership_never_saves_an_authenticated_account() {
        run(async {
            let mut steps = vec![device_step(), token_step()];
            let mut exchange = exchange_steps();
            exchange.truncate(3);
            steps.extend(exchange);
            steps.push(reply(
                &format!("{MC_API}/entitlements/mcstore"),
                200,
                json!({"items":[]}),
            ));
            let (service, transport, secrets) = service(steps);
            let login = service
                .begin_microsoft(&uuid::Uuid::new_v4().to_string())
                .await
                .unwrap();
            due(&service, &login.session_id);
            assert!(service
                .poll_microsoft(&login.session_id)
                .await
                .err()
                .unwrap()
                .contains("所有权"));
            assert!(secrets.entries.lock().unwrap().is_empty());
            transport.done();
        });
    }

    #[test]
    fn refresh_rotates_refresh_token_and_keeps_account_identity() {
        run(async {
            let first: Step = Box::new(|request| {
                assert_eq!(request.url, TOKEN_URL);
                let RequestBody::Form(form) = request.body else {
                    panic!("expected form")
                };
                assert!(form.contains(&("grant_type".into(), "refresh_token".into())));
                assert!(form.contains(&("refresh_token".into(), "old-refresh-token".into())));
                Ok(AuthResponse {
                    status: 200,
                    body: json!({"access_token":"test-msa-token","refresh_token":"rotated-refresh-token","expires_in":3600}),
                })
            });
            let mut steps = vec![first];
            steps.extend(exchange_steps());
            let (service, transport, _) = service(steps);
            let original = ms_record();
            service.save_record(&original).unwrap();
            let game = service
                .game_credentials(&original.account_id)
                .await
                .unwrap();
            assert_eq!(game.access_token, "test-minecraft-token");
            assert_eq!(game.xuid.as_deref(), Some("123456789"));
            let saved = service.load_record(&original.account_id).unwrap();
            assert_eq!(
                saved.refresh_token.as_deref(),
                Some("rotated-refresh-token")
            );
            assert_eq!(saved.uuid, original.uuid);
            transport.done();
        });
    }

    #[test]
    fn launch_rejects_profile_identity_mismatch() {
        run(async {
            let (service, transport, _) = service(vec![reply(
                &format!("{MC_API}/minecraft/profile"),
                200,
                json!({"id":SECOND_ID,"name":"DifferentPlayer"}),
            )]);
            let mut record = ms_record();
            record.expires_at = Some(chrono::Utc::now().timestamp() + 3600);
            service.save_record(&record).unwrap();
            assert!(service
                .game_credentials(&record.account_id)
                .await
                .err()
                .unwrap()
                .contains("不一致"));
            transport.done();
        });
    }

    #[test]
    fn cancelling_during_final_profile_response_prevents_credential_save() {
        run(async {
            let owner = Arc::new(Mutex::new(None::<std::sync::Weak<AuthService>>));
            let session_id = Arc::new(Mutex::new(String::new()));
            let final_owner = owner.clone();
            let final_session = session_id.clone();
            let last: Step = Box::new(move |request| {
                assert_eq!(request.url, format!("{MC_API}/minecraft/profile"));
                let service = final_owner
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .upgrade()
                    .unwrap();
                service
                    .cancel_login(&final_session.lock().unwrap())
                    .unwrap();
                Ok(AuthResponse {
                    status: 200,
                    body: profile_body(),
                })
            });
            let mut steps = vec![device_step(), token_step()];
            let mut exchange = exchange_steps();
            exchange.pop();
            steps.extend(exchange);
            steps.push(last);
            let transport = MockTransport::new(steps);
            let secrets = Arc::new(MemorySecrets::default());
            let service = Arc::new(AuthService::with_backends(
                transport.clone(),
                secrets.clone(),
            ));
            *owner.lock().unwrap() = Some(Arc::downgrade(&service));
            let login = service
                .begin_microsoft(&uuid::Uuid::new_v4().to_string())
                .await
                .unwrap();
            *session_id.lock().unwrap() = login.session_id.clone();
            due(&service, &login.session_id);
            assert!(service
                .poll_microsoft(&login.session_id)
                .await
                .err()
                .unwrap()
                .contains("取消"));
            assert!(secrets.entries.lock().unwrap().is_empty());
            transport.done();
        });
    }

    #[test]
    fn logout_during_refresh_cannot_resurrect_deleted_credentials() {
        run(async {
            let owner = Arc::new(Mutex::new(None::<std::sync::Weak<AuthService>>));
            let final_owner = owner.clone();
            let original = ms_record();
            let id = original.account_id.clone();
            let token: Step = Box::new(move |request| {
                assert_eq!(request.url, TOKEN_URL);
                final_owner
                    .lock()
                    .unwrap()
                    .as_ref()
                    .unwrap()
                    .upgrade()
                    .unwrap()
                    .remove_credentials(&id)
                    .unwrap();
                Ok(AuthResponse {
                    status: 200,
                    body: json!({"access_token":"test-msa-token","refresh_token":"rotated-refresh-token","expires_in":3600}),
                })
            });
            let mut steps = vec![token];
            steps.extend(exchange_steps());
            let transport = MockTransport::new(steps);
            let secrets = Arc::new(MemorySecrets::default());
            let service = Arc::new(AuthService::with_backends(
                transport.clone(),
                secrets.clone(),
            ));
            *owner.lock().unwrap() = Some(Arc::downgrade(&service));
            service.save_record(&original).unwrap();
            assert!(service
                .game_credentials(&original.account_id)
                .await
                .is_err());
            assert!(secrets.entries.lock().unwrap().is_empty());
            transport.done();
        });
    }

    #[test]
    fn authlib_multiple_profiles_require_binding_selected_profile() {
        run(async {
            let authenticate: Step = Box::new(|request| {
                assert_eq!(
                    request.url,
                    "https://auth.example.invalid/api/authserver/authenticate"
                );
                let body = json_request(&request);
                assert_eq!(body["password"], "test-password");
                Ok(AuthResponse {
                    status: 200,
                    body: json!({"accessToken":"unbound-token","clientToken":body["clientToken"],"availableProfiles":[{"id":PROFILE_ID,"name":"First"},{"id":SECOND_ID,"name":"Second"}]}),
                })
            });
            let bind: Step = Box::new(|request| {
                assert_eq!(
                    request.url,
                    "https://auth.example.invalid/api/authserver/refresh"
                );
                let body = json_request(&request);
                assert_eq!(body["selectedProfile"]["id"], SECOND_ID);
                Ok(AuthResponse {
                    status: 200,
                    body: json!({"accessToken":"bound-token","clientToken":body["clientToken"],"selectedProfile":{"id":SECOND_ID,"name":"Second"}}),
                })
            });
            let profile=reply(&format!("https://auth.example.invalid/api/sessionserver/session/minecraft/profile/{SECOND_ID}"),200,json!({"id":SECOND_ID,"name":"Second","properties":[]}));
            let (service, transport, secrets) = service(vec![authenticate, bind, profile]);
            let pending = service
                .login_authlib(
                    "https://auth.example.invalid/api",
                    "test@example.invalid",
                    "test-password",
                    None,
                )
                .await
                .unwrap();
            assert_eq!(pending.status, "selectProfile");
            assert_eq!(pending.profiles.len(), 2);
            assert!(secrets.entries.lock().unwrap().is_empty());
            let account = service
                .select_authlib_profile(pending.session_id.as_deref().unwrap(), SECOND_ID)
                .await
                .unwrap();
            assert_eq!(account.uuid, SECOND_ID);
            assert_eq!(
                account.authlib_server.as_deref(),
                Some("https://auth.example.invalid/api/")
            );
            assert_eq!(
                service.load_record(&account.id).unwrap().access_token,
                "bound-token"
            );
            transport.done();
        });
    }

    #[test]
    fn authlib_rejects_client_token_mismatch_without_persisting_password() {
        run(async {
            let (service, transport, secrets) = service(vec![reply(
                "https://auth.example.invalid/authserver/authenticate",
                200,
                json!({"accessToken":"untrusted-token","clientToken":"wrong-client-token","selectedProfile":{"id":PROFILE_ID,"name":"TestPlayer"}}),
            )]);
            assert!(service
                .login_authlib(
                    "https://auth.example.invalid/",
                    "test-user",
                    "test-password",
                    None
                )
                .await
                .err()
                .unwrap()
                .contains("clientToken"));
            assert!(secrets.entries.lock().unwrap().is_empty());
            transport.done();
        });
    }

    #[test]
    fn authlib_validates_before_launch_and_refreshes_only_invalid_tokens() {
        run(async {
            let validate: Step = Box::new(|request| {
                assert_eq!(
                    request.url,
                    "https://auth.example.invalid/api/authserver/validate"
                );
                assert!(request.bearer.is_none());
                Ok(AuthResponse {
                    status: 403,
                    body: json!({"error":"ForbiddenOperationException"}),
                })
            });
            let refresh: Step = Box::new(|request| {
                assert_eq!(
                    request.url,
                    "https://auth.example.invalid/api/authserver/refresh"
                );
                assert!(json_request(&request).get("selectedProfile").is_none());
                Ok(AuthResponse {
                    status: 200,
                    body: json!({"accessToken":"new-authlib-token","clientToken":"test-client-token","selectedProfile":{"id":PROFILE_ID,"name":"TestPlayer"}}),
                })
            });
            let (service, transport, _) = service(vec![validate, refresh]);
            let record = auth_record();
            service.save_record(&record).unwrap();
            let game = service.game_credentials(&record.account_id).await.unwrap();
            assert_eq!(game.access_token, "new-authlib-token");
            assert_eq!(
                game.authlib_server.as_deref(),
                Some("https://auth.example.invalid/api/")
            );
            transport.done();
        });
    }

    #[test]
    fn authlib_refresh_cannot_change_the_selected_character() {
        run(async {
            let (service, transport, _) = service(vec![reply(
                "https://auth.example.invalid/api/authserver/refresh",
                200,
                json!({"accessToken":"unexpected-token","clientToken":"test-client-token","selectedProfile":{"id":SECOND_ID,"name":"Other"}}),
            )]);
            let record = auth_record();
            service.save_record(&record).unwrap();
            assert!(service
                .refresh_account(&record.account_id)
                .await
                .err()
                .unwrap()
                .contains("不一致"));
            assert_eq!(
                service
                    .load_record(&record.account_id)
                    .unwrap()
                    .access_token,
                "old-authlib-token"
            );
            transport.done();
        });
    }

    #[test]
    fn custom_https_api_roots_keep_paths_and_reject_credential_urls() {
        assert_eq!(
            normalize_authlib_server("https://auth.example.invalid:8443/custom/api").unwrap(),
            "https://auth.example.invalid:8443/custom/api/"
        );
        for url in [
            "http://example.invalid/",
            "https://user:password@example.invalid/",
            "https://example.invalid/?token=test",
            "https://example.invalid/#part",
        ] {
            assert!(normalize_authlib_server(url).is_err());
        }
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert!(decode_base64("%%%=").is_err());
    }

    #[test]
    fn authlib_texture_property_uses_uppercase_skin_and_cape_keys() {
        let encoded="eyJ0ZXh0dXJlcyI6eyJTS0lOIjp7InVybCI6Imh0dHA6Ly90ZXh0dXJlcy5taW5lY3JhZnQubmV0L3RleHR1cmUvdGVzdCIsIm1ldGFkYXRhIjp7Im1vZGVsIjoic2xpbSJ9fSwiQ0FQRSI6eyJ1cmwiOiJodHRwczovL3RleHR1cmVzLm1pbmVjcmFmdC5uZXQvdGV4dHVyZS9jYXBlIn19fQ==";
        let profile=parse_texture_profile(&json!({"id":PROFILE_ID,"name":"TestPlayer","properties":[{"name":"textures","value":encoded}]}),PROFILE_ID,"TestPlayer").unwrap();
        assert_eq!(
            profile.skins[0].url,
            "https://textures.minecraft.net/texture/test"
        );
        assert_eq!(profile.skins[0].variant.as_deref(), Some("slim"));
        assert_eq!(profile.capes.len(), 1);
    }

    #[test]
    fn upload_requires_official_dimensions_and_model() {
        let png = include_bytes!("../../tests/fixtures/skin64.png");
        assert!(validate_skin_png(png, "classic").is_ok());
        assert!(validate_skin_png(b"not-png", "classic").is_err());
        assert!(validate_skin_png(png, "unknown").is_err());
        let mut legacy = png.to_vec();
        legacy[20..24].copy_from_slice(&32u32.to_be_bytes());
        assert!(validate_skin_png(&legacy, "slim").is_err());
    }
}
