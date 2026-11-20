//! Launcher self-update (U0998 / U0932 / U0936), following the HSRUnlocker
//! design: release metadata from GitHub (API first, static update.json when
//! rate limited) and the Gitee mirror, checked at the same time in Auto mode.
//! Every request is made here in Rust, through the user's proxy, with no
//! automatic redirects. See docs/superpowers/plans/2026-11-17-voxelight-self-update.md.
pub(crate) mod checker;
pub(crate) mod manifest;
pub(crate) mod sources;

use crate::errors::AppResult;
use crate::storage::LauncherState;
use futures_util::{FutureExt, StreamExt};
use manifest::{display_version, parse_version, Release, Version};
use serde::Serialize;
use sources::{Request, Response, Transport};
use std::sync::Arc;

pub(crate) const GITHUB_REPO: &str = "/L1angYun/Voxelight_Launcher";
pub(crate) const GITEE_REPO: &str = "/liangyun_Liu/Voxelight_Launcher";
pub(crate) const API_LATEST: &str = "https://api.github.com/repos/L1angYun/Voxelight_Launcher/releases/latest";
pub(crate) const MANIFEST_LATEST: &str =
    "https://github.com/L1angYun/Voxelight_Launcher/releases/latest/download/update.json";
pub(crate) const GITEE_RELEASES: &str =
    "https://gitee.com/api/v5/repos/liangyun_Liu/Voxelight_Launcher/releases?direction=desc&per_page=100";
pub(crate) const MAX_METADATA_BYTES: usize = 256 * 1024;
pub(crate) const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const MAX_NOTES_CHARS: usize = 12_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Source {
    #[serde(rename = "github")]
    GitHub,
    Gitee,
}

impl Source {
    pub(crate) fn root(self) -> &'static str {
        match self {
            Self::GitHub => "https://github.com/L1angYun/Voxelight_Launcher",
            Self::Gitee => "https://gitee.com/liangyun_Liu/Voxelight_Launcher",
        }
    }
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::Gitee => "Gitee",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Preference {
    Auto,
    GitHub,
    Gitee,
}

impl Preference {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "github" => Some(Self::GitHub),
            "gitee" => Some(Self::Gitee),
            _ => None,
        }
    }
}

/// The fixed, space-free installer asset name used on both release pages.
pub(crate) fn installer_name(version: Version) -> String {
    format!("VoxelightLauncher-{}-x64-setup.exe", display_version(version))
}

pub(crate) fn current_version() -> Version {
    parse_version(env!("CARGO_PKG_VERSION")).expect("the crate version is a stable three-part version")
}

/// The GitHub REST version HSR pins and tested its parser against.
pub(crate) const GITHUB_API_VERSION: &str = "2026-03-10";
const STREAM_ERROR: &str = "更新数据传输中断";

/// HSR `MetadataRequest`: the API gets its media type and version; other
/// metadata asks for JSON.
pub(crate) fn request_headers(api: bool) -> &'static [(&'static str, &'static str)] {
    if api {
        &[("Accept", "application/vnd.github+json"), ("X-GitHub-Api-Version", GITHUB_API_VERSION)]
    } else {
        &[("Accept", "application/json")]
    }
}

/// reqwest's error text names the URL, which can carry a signed CDN query;
/// report a fixed message (or the proxy authentication code) instead.
pub(crate) fn transport_error(error: &reqwest::Error) -> String {
    crate::network::proxy_auth_code(error).unwrap_or_else(|| "无法连接更新服务器".into())
}

/// The production transport: HTTPS only, no redirects (every hop is checked
/// by `sources`), the user's proxy, no cookies or credentials, fixed UA.
struct HttpTransport(reqwest::Client);

impl HttpTransport {
    fn new(state: &LauncherState) -> Result<Self, String> {
        let builder = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!("VoxelightLauncher/", env!("CARGO_PKG_VERSION"), " (updater)"));
        crate::network::for_state_builder(state, builder)?
            .build()
            .map(Self)
            .map_err(|_| "无法建立更新网络客户端".into())
    }
}

impl Transport for HttpTransport {
    fn send(&self, request: Request) -> futures_util::future::BoxFuture<'_, Result<Response, String>> {
        async move {
            let mut builder = self.0.get(&request.url);
            for (name, value) in request_headers(request.api) {
                builder = builder.header(*name, *value);
            }
            let response = builder.send().await.map_err(|error| transport_error(&error))?;
            let header = |name: &str| {
                response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned)
            };
            Ok(Response {
                status: response.status().as_u16(),
                location: header("location"),
                retry_after: header("retry-after"),
                rate_remaining: header("x-ratelimit-remaining"),
                rate_reset: header("x-ratelimit-reset"),
                content_length: response.content_length(),
                body: response
                    .bytes_stream()
                    .map(|chunk| chunk.map(|bytes| bytes.to_vec()).map_err(|_| STREAM_ERROR.to_owned()))
                    .boxed(),
            })
        }
        .boxed()
    }
}

/// Per-session update state (managed by Tauri).
#[derive(Default)]
pub(crate) struct UpdateService {
    rate_limit: checker::RateLimit,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateView {
    current_version: String,
    latest_version: String,
    /// "newer", "current" or "stale" (a source is behind a version seen before).
    status: &'static str,
    source: Source,
    release_url: String,
    notes: Option<String>,
    installer_size: Option<u64>,
}

fn view(release: &Release, offer: checker::Offer) -> UpdateView {
    UpdateView {
        current_version: display_version(current_version()),
        latest_version: display_version(release.version),
        status: match offer {
            checker::Offer::Newer => "newer",
            checker::Offer::Current => "current",
            checker::Offer::Stale => "stale",
        },
        source: release.source,
        release_url: release.release_url(),
        notes: release.notes.clone(),
        installer_size: release.package.as_ref().map(|package| package.size),
    }
}

/// Checks, records the highest version seen (an additive root field, kept
/// by older builds through RetainedFields) and returns the offer.
pub(crate) async fn check_with(
    state: &LauncherState,
    service: &UpdateService,
    transport: &dyn Transport,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<UpdateView, String> {
    let config = state.snapshot()?.config;
    let preference = Preference::parse(&config.update_source).ok_or("更新来源无效")?;
    let release = checker::check(transport, preference, &service.rate_limit, now).await?;
    let seen = state.snapshot()?.update_highest_seen.as_deref().and_then(parse_version);
    let offer = checker::classify(&release, current_version(), seen);
    if offer != checker::Offer::Stale && seen.is_none_or(|seen| release.version > seen) {
        let highest = display_version(release.version);
        state.update(|data| {
            data.update_highest_seen = Some(highest.clone());
            Ok(())
        })?;
    }
    Ok(view(&release, offer))
}

#[tauri::command]
pub(crate) async fn check_launcher_update(
    state: tauri::State<'_, Arc<LauncherState>>,
    service: tauri::State<'_, Arc<UpdateService>>,
) -> AppResult<UpdateView> {
    let transport = HttpTransport::new(&state)?;
    check_with(&state, &service, &transport, chrono::Utc::now()).await.map_err(crate::errors::expected)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
