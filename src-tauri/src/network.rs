//! Proxy policy shared by launcher requests and child-process argument construction.
use std::error::Error as _;
use std::net::{Ipv4Addr, Ipv6Addr};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    InvalidMode,
    InvalidScheme,
    InvalidHost,
    InvalidPort,
    InvalidGameMode,
    InvalidCredentials,
    SaveEndpointFirst,
    TlsInheritance,
    Authentication,
    Connection,
    Tls,
    Timeout,
}

impl From<Error> for crate::errors::AppError {
    fn from(error: Error) -> Self {
        Self::new(error.code())
    }
}

impl Error {
    pub(crate) fn is_code(code: &str) -> bool {
        [
            Self::InvalidMode,
            Self::InvalidScheme,
            Self::InvalidHost,
            Self::InvalidPort,
            Self::InvalidGameMode,
            Self::InvalidCredentials,
            Self::SaveEndpointFirst,
            Self::TlsInheritance,
            Self::Authentication,
            Self::Connection,
            Self::Tls,
            Self::Timeout,
        ]
        .iter()
        .any(|error| error.code() == code)
    }

    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::InvalidMode => "proxy.invalidMode",
            Self::InvalidScheme => "proxy.invalidScheme",
            Self::InvalidHost => "proxy.invalidHost",
            Self::InvalidPort => "proxy.invalidPort",
            Self::InvalidGameMode => "proxy.invalidGameMode",
            Self::InvalidCredentials => "proxy.invalidCredentials",
            Self::SaveEndpointFirst => "proxy.saveEndpointFirst",
            Self::TlsInheritance => "proxy.tlsInheritance",
            Self::Authentication => "proxy.authentication",
            Self::Connection => "proxy.connection",
            Self::Tls => "proxy.tls",
            Self::Timeout => "proxy.timeout",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Endpoint {
    scheme: String,
    host: String,
    port: u16,
}

impl Endpoint {
    fn parse(scheme: &str, host: &str, port: u16) -> Result<Self, Error> {
        if !matches!(scheme, "http" | "https") {
            return Err(Error::InvalidScheme);
        }
        if port == 0 {
            return Err(Error::InvalidPort);
        }
        let host = if let Some(ip) = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
        {
            ip.parse::<Ipv6Addr>()
                .map_err(|_| Error::InvalidHost)?
                .to_string()
        } else if let Ok(ip) = host.parse::<Ipv4Addr>() {
            ip.to_string()
        } else {
            // URL parsers accept shorthand and legacy numeric IPv4. Require either a
            // canonical IP or a hostname that the parser treats as a domain.
            let bare = host.strip_suffix('.').unwrap_or(host);
            let valid = !bare.is_empty()
                && host.len() <= 253
                && bare.split('.').all(|label| {
                    !label.is_empty()
                        && label.len() <= 63
                        && label
                            .as_bytes()
                            .first()
                            .is_some_and(u8::is_ascii_alphanumeric)
                        && label
                            .as_bytes()
                            .last()
                            .is_some_and(u8::is_ascii_alphanumeric)
                        && label
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
                });
            if !valid {
                return Err(Error::InvalidHost);
            }
            let lower = host.to_ascii_lowercase();
            let candidate = reqwest::Url::parse(&format!("{scheme}://{lower}:{port}"))
                .map_err(|_| Error::InvalidHost)?;
            if candidate.domain() != Some(lower.as_str()) {
                return Err(Error::InvalidHost);
            }
            lower
        };
        Ok(Self {
            scheme: scheme.into(),
            host,
            port,
        })
    }

    pub(crate) fn url(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{}://{}:{}", self.scheme, host, self.port)
    }

    pub(crate) fn credential_key(&self) -> String {
        format!("download-proxy-credentials:{}", self.url())
    }

    fn java_args(&self) -> Result<Vec<String>, Error> {
        if self.scheme == "https" {
            return Err(Error::TlsInheritance);
        }
        Ok(vec![
            format!("-Dhttp.proxyHost={}", self.host),
            format!("-Dhttp.proxyPort={}", self.port),
            format!("-Dhttps.proxyHost={}", self.host),
            format!("-Dhttps.proxyPort={}", self.port),
            "-Dhttp.nonProxyHosts=localhost|127.*|[::1]".into(),
        ])
    }
}

// Deliberately no Debug output for credentials, including proxy client construction errors.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct Credentials {
    username: String,
    password: String,
}

impl Credentials {
    pub(crate) fn new(username: String, password: String) -> Result<Self, Error> {
        if username.is_empty()
            || username.contains(':')
            || username.chars().count() > 255
            || password.chars().count() > 255
            || username
                .chars()
                .chain(password.chars())
                .any(char::is_control)
        {
            return Err(Error::InvalidCredentials);
        }
        Ok(Self { username, password })
    }

    fn proxy_authorization(&self) -> Result<reqwest::header::HeaderValue, Error> {
        use base64::Engine as _;

        let value = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", self.username, self.password));
        let mut header = reqwest::header::HeaderValue::from_str(&format!("Basic {value}"))
            .map_err(|_| Error::InvalidCredentials)?;
        header.set_sensitive(true);
        Ok(header)
    }
}

#[derive(Clone)]
pub(crate) enum Settings {
    System,
    None,
    Custom(Endpoint),
}

fn system_args() -> Vec<String> {
    vec!["-Djava.net.useSystemProxies=true".into()]
}

impl Settings {
    pub(crate) fn validate_save(config: &crate::models::Config) -> Result<(), Error> {
        let settings = Self::from_config(config)?;
        // Draft custom fields persist for when the mode is switched back. Never store URL userinfo there.
        if !matches!(config.proxy_scheme.as_str(), "http" | "https") {
            return Err(Error::InvalidScheme);
        }
        if settings.endpoint().is_none() && !config.proxy_host.is_empty() {
            Endpoint::parse(
                &config.proxy_scheme,
                &config.proxy_host,
                config.proxy_port.max(1),
            )?;
        }
        settings.validate_game_save(&config.game_proxy_mode)
    }

    pub(crate) fn from_config(config: &crate::models::Config) -> Result<Self, Error> {
        Self::parse(
            &config.proxy_mode,
            &config.proxy_scheme,
            &config.proxy_host,
            config.proxy_port,
        )
    }

    pub(crate) fn parse(mode: &str, scheme: &str, host: &str, port: u16) -> Result<Self, Error> {
        match mode {
            "system" => Ok(Self::System),
            "none" => Ok(Self::None),
            "custom" => Endpoint::parse(scheme, host, port).map(Self::Custom),
            _ => Err(Error::InvalidMode),
        }
    }

    pub(crate) fn endpoint(&self) -> Option<&Endpoint> {
        match self {
            Self::Custom(endpoint) => Some(endpoint),
            _ => None,
        }
    }

    pub(crate) fn validate_game_save(&self, game_mode: &str) -> Result<(), Error> {
        match game_mode {
            "off" | "system" => Ok(()),
            "launcher"
                if self
                    .endpoint()
                    .is_some_and(|endpoint| endpoint.scheme == "https") =>
            {
                Err(Error::TlsInheritance)
            }
            "launcher" => Ok(()),
            _ => Err(Error::InvalidGameMode),
        }
    }

    pub(crate) fn game_args(
        &self,
        game_mode: &str,
        custom: &[String],
    ) -> Result<Vec<String>, Error> {
        // The TLS check must not be bypassed through the ordinary custom-argument precedence.
        self.validate_game_save(game_mode)?;
        if custom.iter().any(|arg| {
            [
                "-Dhttp.proxy",
                "-Dhttps.proxy",
                "-DsocksProxy",
                "-Djava.net.useSystemProxies",
            ]
            .iter()
            .any(|prefix| arg.starts_with(prefix))
        }) {
            return Ok(Vec::new());
        }
        match game_mode {
            "off" => Ok(Vec::new()),
            "system" => Ok(system_args()),
            "launcher" => self.installer_args(),
            _ => Err(Error::InvalidGameMode),
        }
    }

    pub(crate) fn installer_args(&self) -> Result<Vec<String>, Error> {
        match self {
            Self::System => Ok(system_args()),
            Self::None => Ok(Vec::new()),
            Self::Custom(endpoint) => endpoint.java_args(),
        }
    }

    pub(crate) fn apply(
        &self,
        builder: reqwest::ClientBuilder,
        credentials: Option<&Credentials>,
    ) -> Result<reqwest::ClientBuilder, Error> {
        match self {
            Self::System => Ok(builder),
            Self::None => Ok(builder.no_proxy()),
            Self::Custom(endpoint) => {
                let mut proxy = reqwest::Proxy::all(endpoint.url())
                    .map_err(|_| Error::InvalidHost)?
                    .no_proxy(reqwest::NoProxy::from_string("localhost,127.0.0.1,::1"));
                if let Some(credentials) = credentials {
                    // For a fixed proxy, reqwest's basic_auth stores userinfo in its URL.
                    // Keep the endpoint URL credential-free; only set a sensitive proxy header.
                    proxy = proxy.custom_http_auth(credentials.proxy_authorization()?);
                }
                Ok(builder.no_proxy().proxy(proxy))
            }
        }
    }
}

// CONNECT 407 is not an HTTP response exposed by reqwest 0.12.28. It is a
// private hyper-util tunnel source; classify but never return/display that text.
/// Names of instances whose own game proxy mode inherits the launcher proxy,
/// when that proxy is https://, because Java cannot inherit a TLS proxy.
pub(crate) fn instances_blocking_tls(
    config: &crate::models::Config,
    instances: &[crate::models::Instance],
) -> Result<Vec<String>, Error> {
    let settings = Settings::from_config(config)?;
    if !settings.endpoint().is_some_and(|endpoint| endpoint.scheme == "https") {
        return Ok(Vec::new());
    }
    Ok(instances
        .iter()
        .filter(|instance| instance.game_proxy_mode.as_deref() == Some("launcher"))
        .map(|instance| instance.name.clone())
        .collect())
}

/// Removes URL userinfo from a stored proxy host. The host part is kept, so a
/// custom proxy stays custom (and fails closed if what is left is invalid)
/// instead of silently becoming a direct connection. Returns whether it changed.
pub(crate) fn strip_host_userinfo(config: &mut crate::models::Config) -> bool {
    let Some((_, host)) = config.proxy_host.rsplit_once('@') else {
        return false;
    };
    let host = host.to_owned();
    config.proxy_host = host;
    true
}

/// The saved proxy address, whatever the mode; credentials are keyed by it.
fn draft_endpoint(config: &crate::models::Config) -> Option<Endpoint> {
    Endpoint::parse(&config.proxy_scheme, config.proxy_host.trim(), config.proxy_port).ok()
}

/// Deletes the credentials of a proxy address that a save abandons. Switching
/// only the mode (for example Off and back) keeps the address and its record.
pub(crate) fn forget_abandoned_credentials(
    data_dir: &std::path::Path,
    previous: &crate::models::Config,
    next: &crate::models::Config,
) -> Result<(), Error> {
    let Some(old) = draft_endpoint(previous) else {
        return Ok(());
    };
    if draft_endpoint(next).as_ref() == Some(&old) {
        return Ok(());
    }
    crate::secrets::save_service_secret(data_dir, &old.credential_key(), "")
        .map_err(|_| Error::InvalidCredentials)
}

pub(crate) fn forget_current_credentials(
    data_dir: &std::path::Path,
    config: &crate::models::Config,
) -> Result<(), Error> {
    let Some(endpoint) = draft_endpoint(config) else {
        return Ok(());
    };
    crate::secrets::save_service_secret(data_dir, &endpoint.credential_key(), "")
        .map_err(|_| Error::InvalidCredentials)
}

/// `proxy.authentication` when a request failed because the proxy wants
/// credentials (an expired password, say); other failures keep their message.
pub(crate) fn proxy_auth_code(error: &reqwest::Error) -> Option<String> {
    (classify(error) == Error::Authentication).then(|| Error::Authentication.code().to_owned())
}

pub(crate) fn classify(error: &reqwest::Error) -> Error {
    if error.is_timeout() {
        return Error::Timeout;
    }
    if error.status() == Some(reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED) {
        return Error::Authentication;
    }
    let mut current = error.source();
    let mut tls = false;
    while let Some(source) = current {
        let message = source.to_string().to_ascii_lowercase();
        if message.contains("proxy authorization required")
            || message.contains("proxy authentication required")
        {
            return Error::Authentication;
        }
        tls |= ["tls", "ssl", "certificate", "invalid peer"]
            .iter()
            .any(|part| message.contains(part));
        current = source.source();
    }
    if tls {
        Error::Tls
    } else {
        Error::Connection
    }
}

fn get_credentials(
    data_dir: &std::path::Path,
    endpoint: &Endpoint,
) -> Result<Option<Credentials>, Error> {
    crate::secrets::load_service_secret(data_dir, &endpoint.credential_key())
        .map_err(|_| Error::InvalidCredentials)?
        .map(|value| {
            let CredentialFields { username, password } =
                serde_json::from_str(&value).map_err(|_| Error::InvalidCredentials)?;
            Credentials::new(username, password)
        })
        .transpose()
}

#[derive(serde::Deserialize)]
struct CredentialFields {
    username: String,
    password: String,
}

fn configure_builder(
    data_dir: &std::path::Path,
    settings: &Settings,
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::ClientBuilder, Error> {
    let credentials = settings
        .endpoint()
        .map(|value| get_credentials(data_dir, value))
        .transpose()?
        .flatten();
    settings.apply(builder, credentials.as_ref())
}

pub(crate) fn for_config_builder(
    data_dir: &std::path::Path,
    config: &crate::models::Config,
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::ClientBuilder, String> {
    Settings::from_config(config)
        .and_then(|settings| configure_builder(data_dir, &settings, builder))
        .map_err(|error| error.code().to_owned())
}

pub(crate) fn for_state_builder(
    state: &crate::storage::LauncherState,
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::ClientBuilder, String> {
    for_config_builder(&state.data_dir, &state.snapshot()?.config, builder)
}

pub(crate) fn proxy_credentials_configured(
    data_dir: &std::path::Path,
    config: &crate::models::Config,
) -> Result<bool, String> {
    // Report existence without serializing credentials. Corrupt settings should not prevent the repair UI.
    let Ok(settings) = Settings::from_config(config) else {
        return Ok(false);
    };
    settings
        .endpoint()
        .map(|endpoint| {
            get_credentials(data_dir, endpoint)
                .map(|value| value.is_some())
                .map_err(|error| error.code().to_owned())
        })
        .transpose()
        .map(|value| value.unwrap_or(false))
}

type Shared<'a> = tauri::State<'a, std::sync::Arc<crate::storage::LauncherState>>;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxyTestResult {
    latency_ms: u64,
}

#[tauri::command]
pub(crate) async fn test_proxy_connection(
    state: Shared<'_>,
    proxy_mode: String,
    proxy_scheme: String,
    proxy_host: String,
    proxy_port: u16,
) -> crate::errors::AppResult<ProxyTestResult> {
    use std::time::{Duration, Instant};
    let settings = Settings::parse(&proxy_mode, &proxy_scheme, proxy_host.trim(), proxy_port)?;
    let builder = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8));
    let client = configure_builder(&state.data_dir, &settings, builder)?
        .build()
        .map_err(|_| Error::Connection)?;
    // The probe target goes through the same allowlist as every other request.
    crate::storage::trusted_url(crate::minecraft::MANIFEST_URL).map_err(|_| Error::Connection)?;
    let started = Instant::now();
    let response = client
        .head(crate::minecraft::MANIFEST_URL)
        .send()
        .await
        .map_err(|error| classify(&error))?;
    if response.status() == reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED {
        return Err(Error::Authentication.into());
    }
    if !response.status().is_success() {
        return Err(Error::Connection.into());
    }
    Ok(ProxyTestResult {
        latency_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DetectedProxy {
    pub(crate) scheme: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) source: String,
    pub(crate) label: String,
    pub(crate) url: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalProxyReport {
    pub(crate) system_proxy: Option<DetectedProxy>,
    pub(crate) auto_config_url: Option<String>,
    pub(crate) candidates: Vec<DetectedProxy>,
}

const LOCAL_PROXY_PORTS: &[(u16, &str)] = &[
    (7890, "Clash / Mihomo"),
    (7897, "Clash Verge / Mihomo"),
    (7891, "Clash"),
    (10809, "v2rayN"),
    (10808, "v2rayN / Xray"),
    (2081, "sing-box / Nekoray"),
    (20171, "v2rayA"),
    (1081, "Shadowsocks"),
    (1087, "Shadowsocks / Surge"),
    (8118, "Privoxy"),
    (8888, "Local HTTP proxy"),
    (3128, "HTTP proxy"),
];

pub(crate) fn parse_proxy_uri(raw: &str) -> Option<Endpoint> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = reqwest::Url::parse(&candidate).ok()?;
    let scheme = parsed.scheme();
    if !matches!(scheme, "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?;
    let port = parsed.port_or_known_default()?;
    Endpoint::parse(scheme, host, port).ok()
}

pub(crate) fn parse_windows_proxy_server(raw: &str) -> Option<Endpoint> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains('=') {
        return parse_proxy_uri(trimmed);
    }
    let mut https_entry: Option<&str> = None;
    let mut http_entry: Option<&str> = None;
    let mut fallback_entry: Option<&str> = None;
    for part in trimmed.split(';').map(str::trim).filter(|p| !p.is_empty()) {
        if let Some((proto, addr)) = part.split_once('=') {
            match proto.trim().to_ascii_lowercase().as_str() {
                "https" => https_entry = Some(addr.trim()),
                "http" => http_entry = Some(addr.trim()),
                _ => {}
            }
        } else if fallback_entry.is_none() {
            fallback_entry = Some(part);
        }
    }
    for entry in [https_entry, http_entry, fallback_entry].into_iter().flatten() {
        if let Some(endpoint) = parse_proxy_uri(entry) {
            return Some(endpoint);
        }
    }
    None
}

pub(crate) fn sanitize_pac_url(raw: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(raw.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?;
    let mut sanitized = format!("{}://{host}", parsed.scheme());
    if let Some(port) = parsed.port() {
        sanitized.push_str(&format!(":{port}"));
    }
    sanitized.push_str(parsed.path());
    Some(sanitized)
}

fn detected_from_endpoint(endpoint: Endpoint, source: &str, label: &str) -> DetectedProxy {
    let url = endpoint.url();
    DetectedProxy {
        scheme: endpoint.scheme,
        host: endpoint.host,
        port: endpoint.port,
        source: source.into(),
        label: label.into(),
        url,
    }
}

pub(crate) fn detect_env_proxies<F>(getenv: F) -> Vec<DetectedProxy>
where
    F: Fn(&str) -> Option<String>,
{
    let mut found = Vec::new();
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        let Some(raw) = getenv(key) else { continue };
        let Some(endpoint) = parse_proxy_uri(&raw) else { continue };
        let item = detected_from_endpoint(endpoint, "environment", key);
        if !found.iter().any(|existing: &DetectedProxy| existing.url == item.url) {
            found.push(item);
        }
    }
    found
}

#[cfg(windows)]
fn read_windows_system_proxy() -> (Option<DetectedProxy>, Option<String>) {
    use std::ffi::c_void;

    #[repr(C)]
    struct WinHttpCurrentUserIeProxyConfig {
        f_auto_detect: i32,
        lpsz_auto_config_url: *mut u16,
        lpsz_proxy: *mut u16,
        lpsz_proxy_bypass: *mut u16,
    }

    #[link(name = "winhttp")]
    extern "system" {
        fn WinHttpGetIEProxyConfigForCurrentUser(
            p_proxy_config: *mut WinHttpCurrentUserIeProxyConfig,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalFree(hmem: *mut c_void) -> *mut c_void;
    }

    unsafe fn take_pwstr(ptr: *mut u16) -> Option<String> {
        if ptr.is_null() {
            return None;
        }
        let mut len = 0usize;
        while len < 4096 && *ptr.add(len) != 0 {
            len += 1;
        }
        let slice = std::slice::from_raw_parts(ptr, len);
        let text = String::from_utf16_lossy(slice);
        GlobalFree(ptr.cast());
        Some(text)
    }

    let mut cfg = WinHttpCurrentUserIeProxyConfig {
        f_auto_detect: 0,
        lpsz_auto_config_url: std::ptr::null_mut(),
        lpsz_proxy: std::ptr::null_mut(),
        lpsz_proxy_bypass: std::ptr::null_mut(),
    };
    let ok = unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut cfg) };
    if ok == 0 {
        return (None, None);
    }
    let pac_raw = unsafe { take_pwstr(cfg.lpsz_auto_config_url) };
    let proxy_raw = unsafe { take_pwstr(cfg.lpsz_proxy) };
    let _bypass = unsafe { take_pwstr(cfg.lpsz_proxy_bypass) };

    let system_proxy = proxy_raw
        .as_deref()
        .and_then(parse_windows_proxy_server)
        .map(|endpoint| detected_from_endpoint(endpoint, "windowsSystem", "Windows"));
    let auto_config_url = pac_raw.as_deref().and_then(sanitize_pac_url);
    (system_proxy, auto_config_url)
}

#[cfg(not(windows))]
fn read_windows_system_proxy() -> (Option<DetectedProxy>, Option<String>) {
    (None, None)
}

pub(crate) async fn probe_local_http_proxy(port: u16) -> Option<Endpoint> {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    let mut stream = tokio::time::timeout(
        Duration::from_millis(180),
        TcpStream::connect((Ipv4Addr::LOCALHOST, port)),
    )
    .await
    .ok()?
    .ok()?;
    let request = b"HEAD http://127.0.0.1:1/ HTTP/1.1\r\nHost: 127.0.0.1:1\r\nProxy-Connection: close\r\nConnection: close\r\n\r\n";
    tokio::time::timeout(Duration::from_millis(180), stream.write_all(request))
        .await
        .ok()?
        .ok()?;
    let mut buf = [0u8; 64];
    let n = tokio::time::timeout(Duration::from_millis(220), stream.read(&mut buf))
        .await
        .ok()?
        .ok()?;
    if n >= 7 && buf[..7].eq_ignore_ascii_case(b"HTTP/1.") {
        Endpoint::parse("http", "127.0.0.1", port).ok()
    } else {
        None
    }
}

pub(crate) async fn detect_local_proxies_inner(exclude_ports: &[u16]) -> LocalProxyReport {
    let (system_proxy, auto_config_url) =
        tokio::task::spawn_blocking(read_windows_system_proxy)
            .await
            .unwrap_or((None, None));
    let env_proxies = detect_env_proxies(|key| std::env::var(key).ok());

    let mut handles = Vec::new();
    for &(port, label) in LOCAL_PROXY_PORTS {
        if exclude_ports.contains(&port) {
            continue;
        }
        handles.push((
            label,
            tokio::spawn(async move { probe_local_http_proxy(port).await }),
        ));
    }

    let mut candidates = Vec::new();
    if let Some(sys) = &system_proxy {
        candidates.push(sys.clone());
    }
    for env_proxy in env_proxies {
        if !candidates.iter().any(|c| c.url == env_proxy.url) {
            candidates.push(env_proxy);
        }
    }
    for (label, handle) in handles {
        if let Ok(Some(endpoint)) = handle.await {
            let item = detected_from_endpoint(endpoint, "localPort", label);
            if !candidates.iter().any(|c| c.url == item.url) {
                candidates.push(item);
            }
        }
    }

    LocalProxyReport {
        system_proxy,
        auto_config_url,
        candidates,
    }
}

#[tauri::command]
pub(crate) async fn detect_local_proxies(
    mcp: tauri::State<'_, std::sync::Arc<crate::assistant::McpService>>,
) -> crate::errors::AppResult<LocalProxyReport> {
    let mcp_status = mcp.status(0);
    let exclude = if mcp_status.running {
        vec![mcp_status.port]
    } else {
        Vec::new()
    };
    Ok(detect_local_proxies_inner(&exclude).await)
}

#[tauri::command]
pub(crate) fn set_proxy_credentials(
    state: Shared<'_>,
    proxy_mode: String,
    proxy_scheme: String,
    proxy_host: String,
    proxy_port: u16,
    username: String,
    password: String,
) -> crate::errors::AppResult<bool> {
    set_proxy_credentials_inner(&state, &proxy_mode, &proxy_scheme, &proxy_host, proxy_port, username, password)
}

pub(crate) fn set_proxy_credentials_inner(
    state: &crate::storage::LauncherState,
    proxy_mode: &str,
    proxy_scheme: &str,
    proxy_host: &str,
    proxy_port: u16,
    username: String,
    password: String,
) -> crate::errors::AppResult<bool> {
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| crate::errors::AppError::new("config.busy"))?;
    let submitted = Settings::parse(proxy_mode, proxy_scheme, proxy_host.trim(), proxy_port)?;
    let saved = Settings::from_config(&state.snapshot()?.config)?;
    store_endpoint_credentials(&state.data_dir, &submitted, &saved, username, password)
        .map_err(Into::into)
}

fn store_endpoint_credentials(
    data_dir: &std::path::Path,
    submitted: &Settings,
    saved: &Settings,
    username: String,
    password: String,
) -> Result<bool, Error> {
    let endpoint = submitted
        .endpoint()
        .filter(|value| Some(*value) == saved.endpoint())
        .ok_or(Error::SaveEndpointFirst)?;
    let payload = if username.is_empty() && password.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&Credentials::new(username, password)?)
            .map_err(|_| Error::InvalidCredentials)?
    };
    crate::secrets::save_service_secret(data_dir, &endpoint.credential_key(), &payload)
        .map_err(|_| Error::InvalidCredentials)?;
    Ok(!payload.is_empty())
}

#[cfg(test)]
#[path = "network-tests.rs"]
mod tests;
