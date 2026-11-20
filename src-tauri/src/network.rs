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
/// when that proxy is https:// (ruling C7-1): Java cannot inherit a TLS proxy.
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
