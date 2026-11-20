//! Trusted update endpoints and the manual redirect walk (ported from
//! HSRUnlocker `UpdateSources.cs`): every hop is HTTPS on 443 with no
//! userinfo or fragment, stays on an allowlisted host and path, and the
//! chain has at most five redirects.
use super::manifest::parse_version;
use super::{Source, GITEE_REPO, GITHUB_REPO};
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;

const MAX_REDIRECTS: usize = 5;

#[derive(Clone, Debug)]
pub(crate) struct Request {
    pub(crate) url: String,
    /// Sends the GitHub API headers (Accept and API version).
    pub(crate) api: bool,
}

pub(crate) struct Response {
    pub(crate) status: u16,
    pub(crate) location: Option<String>,
    pub(crate) retry_after: Option<String>,
    pub(crate) rate_remaining: Option<String>,
    pub(crate) rate_reset: Option<String>,
    pub(crate) content_length: Option<u64>,
    pub(crate) body: BoxStream<'static, Result<Vec<u8>, FetchError>>,
}

/// The network seam. The production transport never follows redirects, so
/// every hop passes through `validate_location`.
pub(crate) trait Transport: Send + Sync {
    fn send(&self, request: Request) -> BoxFuture<'_, Result<Response, String>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Location {
    Release,
    Attachment,
    Cdn,
}

pub(crate) fn file_url(source: Source, tag: &str, file_name: &str) -> String {
    format!("{}/releases/download/{tag}/{file_name}", source.root())
}

fn https_443(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn numeric(segment: &str) -> bool {
    !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit())
}

/// `/attach_files/<id>/download/<name>` on gitee.com, or `/attach_file/<id>/<name>` on foruda.
fn attachment_path(path: &str, prefix: &str, file_name: &str, download_segment: bool) -> bool {
    let Some(rest) = path.strip_prefix(prefix) else { return false };
    let parts: Vec<&str> = rest.split('/').collect();
    let expected = if download_segment { 3 } else { 2 };
    parts.len() == expected
        && numeric(parts[0])
        && (!download_segment || parts[1] == "download")
        && (parts[expected - 1] == file_name
            || (!download_segment && parts[expected - 1] == file_name.to_ascii_lowercase()))
}

pub(crate) fn validate_location(
    url: &str,
    file_name: &str,
    source: Source,
    expected_tag: Option<&str>,
) -> Result<Location, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "更新地址无效")?;
    if !https_443(&parsed) {
        return Err("更新地址不是受信任的 HTTPS 端点".into());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let path = parsed.path();
    let gitee = source == Source::Gitee;
    if !gitee && host == "release-assets.githubusercontent.com" {
        return Ok(Location::Cdn);
    }
    if gitee && host == "foruda.gitee.com" && attachment_path(path, "/attach_file/", file_name, false) {
        return Ok(Location::Cdn);
    }
    let (repo_host, repository) = if gitee { ("gitee.com", GITEE_REPO) } else { ("github.com", GITHUB_REPO) };
    if host == repo_host && parsed.query().is_none() {
        if !gitee
            && expected_tag.is_none()
            && file_name == "update.json"
            && path == format!("{repository}/releases/latest/download/update.json")
        {
            return Ok(Location::Release);
        }
        if let Some(rest) = path.strip_prefix(&format!("{repository}/releases/download/")) {
            let parts: Vec<&str> = rest.split('/').collect();
            if parts.len() == 2
                && parts[1] == file_name
                && parse_version(parts[0]).is_some()
                && expected_tag.is_none_or(|tag| tag == parts[0])
            {
                return Ok(Location::Release);
            }
        }
        if gitee && attachment_path(path, &format!("{repository}/attach_files/"), file_name, true) {
            return Ok(Location::Attachment);
        }
    }
    Err("更新地址不在受信任的仓库端点内".into())
}

/// The redirect transitions allowed after the first hop: GitHub goes from the
/// release URL to its CDN; Gitee goes Release → attach_files → foruda.
fn transition_allowed(source: Source, hop: usize, previous: Location, next: Location) -> bool {
    match (hop, source) {
        (0, _) => next == Location::Release,
        (_, Source::GitHub) => matches!((previous, next), (Location::Release, Location::Cdn)),
        (_, Source::Gitee) => matches!(
            (previous, next),
            (Location::Release, Location::Attachment) | (Location::Attachment, Location::Cdn)
        ),
    }
}

fn redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// Why a fetch failed: the network (another source may help) or an
/// untrusted location or redirect (another source must not be tried).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum FetchError {
    Transport(String),
    Invalid(String),
}

impl From<FetchError> for String {
    fn from(error: FetchError) -> Self {
        match error {
            FetchError::Transport(message) | FetchError::Invalid(message) => message,
        }
    }
}

/// Fetches `url` (a release file URL) and follows only trusted redirects.
/// Errors never contain a URL, so a signed CDN query cannot leak.
pub(crate) async fn get_file(
    transport: &dyn Transport,
    url: &str,
    file_name: &str,
    source: Source,
    expected_tag: Option<&str>,
) -> Result<Response, FetchError> {
    let invalid = |message: &str| FetchError::Invalid(message.to_owned());
    let mut current = url.to_owned();
    let mut previous = Location::Release;
    for hop in 0..=MAX_REDIRECTS {
        let location = validate_location(&current, file_name, source, expected_tag).map_err(FetchError::Invalid)?;
        if !transition_allowed(source, hop, previous, location) {
            return Err(invalid("更新跳转顺序不受信任"));
        }
        previous = location;
        let response = transport.send(Request { url: current.clone(), api: false }).await.map_err(FetchError::Transport)?;
        if !redirect(response.status) {
            if !(200..300).contains(&response.status) {
                return Err(FetchError::Transport(format!("更新服务器返回错误（HTTP {}）", response.status)));
            }
            return Ok(response);
        }
        let next = response.location.as_deref().ok_or_else(|| invalid("更新跳转缺少目标"))?;
        let base = reqwest::Url::parse(&current).map_err(|_| invalid("更新地址无效"))?;
        current = base.join(next).map_err(|_| invalid("更新跳转目标无效"))?.to_string();
    }
    Err(invalid("更新跳转次数过多"))
}

/// `releases/latest/download/update.json` and its tag-bound redirect chain.
/// Returns the tag the chain resolved to, if one was observed.
pub(crate) fn manifest_location_tag(url: &str) -> Result<Option<String>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "更新地址无效")?;
    if !https_443(&parsed) {
        return Err("更新地址不是受信任的 HTTPS 端点".into());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "release-assets.githubusercontent.com" {
        return Ok(None);
    }
    if host == "github.com" && parsed.query().is_none() {
        let path = parsed.path();
        if path == format!("{GITHUB_REPO}/releases/latest/download/update.json") {
            return Ok(None);
        }
        if let Some(tag) = path
            .strip_prefix(&format!("{GITHUB_REPO}/releases/download/"))
            .and_then(|rest| rest.strip_suffix("/update.json"))
            .filter(|tag| parse_version(tag).is_some())
        {
            return Ok(Some(tag.to_owned()));
        }
    }
    Err("更新信息地址不在受信任的仓库端点内".into())
}

pub(crate) async fn read_body(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;
    if response.content_length.is_some_and(|length| length > limit as u64) {
        return Err("更新信息超过大小限制".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.body.next().await {
        let chunk = chunk?;
        if body.len() + chunk.len() > limit {
            return Err("更新信息超过大小限制".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
