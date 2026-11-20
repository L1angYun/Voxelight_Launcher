//! Launcher self-update (U0998 / U0932 / U0936), following the HSRUnlocker
//! design: release metadata from GitHub (API first, static update.json when
//! rate limited) and the Gitee mirror, checked at the same time in Auto mode.
//! Every request is made here in Rust, through the user's proxy, with no
//! automatic redirects. See docs/superpowers/plans/2026-11-17-voxelight-self-update.md.
pub(crate) mod checker;
pub(crate) mod download;
pub(crate) mod helper;
pub(crate) mod install;
pub(crate) mod manifest;
pub(crate) mod process;
pub(crate) mod sources;
pub(crate) mod sweep;

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
pub(crate) const RESPONSE_ENDED: &str = "安装包在声明的长度之前结束";

/// A body error: a connection that ends before its declared length is an
/// integrity failure (HSR `IsProtocolLengthFailure`), any other error is a
/// transport failure that another source may get past.
pub(crate) fn stream_error(error: &(dyn std::error::Error + 'static)) -> sources::FetchError {
    let mut cause = Some(error);
    while let Some(current) = cause {
        if current
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::UnexpectedEof)
        {
            return sources::FetchError::Invalid(RESPONSE_ENDED.into());
        }
        cause = current.source();
    }
    sources::FetchError::Transport(STREAM_ERROR.into())
}

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
                    .map(|chunk| chunk.map(|bytes| bytes.to_vec()).map_err(|error| stream_error(&error)))
                    .boxed(),
            })
        }
        .boxed()
    }
}

/// Per-session update state (managed by Tauri). The renderer never supplies
/// a URL, hash or path: the download uses the package of the last check.
#[derive(Default)]
pub(crate) struct UpdateService {
    rate_limit: checker::RateLimit,
    /// The offered package and the source preference its check used (HSR
    /// binds the preference into the package).
    offered: std::sync::Mutex<Option<(manifest::Package, Preference)>>,
    staged: tokio::sync::Mutex<Option<download::StagedUpdate>>,
    /// IDLE, RUNNING or CANCELLING: one atomic, so a cancel can never land
    /// after a finished download cleared it.
    download_state: std::sync::atomic::AtomicU8,
}

const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const CANCELLING: u8 = 2;
/// The install hand-off owns the service: no download may start.
const INSTALLING: u8 = 3;

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
    if let Ok(mut offered) = service.offered.lock() {
        *offered = match (offer, release.package.clone()) {
            (checker::Offer::Newer, Some(package)) => Some((package, preference)),
            _ => None,
        };
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

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StagedView {
    version: String,
    file_name: String,
    size: u64,
}

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    downloaded: u64,
    total: u64,
}

/// Returns the download state to IDLE however the download ends.
struct Downloading<'a>(&'a UpdateService);

impl Drop for Downloading<'_> {
    fn drop(&mut self) {
        self.0.download_state.store(IDLE, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The same installer bytes and name, wherever they were fetched from: in
/// Auto either source may answer a later check first.
fn same_installer(a: &manifest::Package, b: &manifest::Package) -> bool {
    a.version == b.version && a.file_name == b.file_name && a.size == b.size && a.sha256 == b.sha256
}

/// Downloads and verifies the offered package (the renderer supplies
/// nothing). A second call while one runs is refused; an already staged
/// package for the same version is reused.
pub(crate) async fn download_with(
    state: &LauncherState,
    service: &UpdateService,
    transport: &dyn Transport,
    root: &std::path::Path,
    progress: &(dyn Fn(u64, u64) + Sync),
) -> Result<StagedView, String> {
    use std::sync::atomic::Ordering;
    if service.download_state.compare_exchange(IDLE, RUNNING, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("更新已在下载中".into());
    }
    let _downloading = Downloading(service);
    let (package, checked_with) = service
        .offered
        .lock()
        .map_err(|_| "更新状态异常")?
        .clone()
        .ok_or("没有可下载的更新，请先检查更新")?;
    // A source change after the check needs a new check (HSR clears the
    // result), so an excluded host is never contacted.
    let preference = Preference::parse(&state.snapshot()?.config.update_source).ok_or("更新来源无效")?;
    if preference != checked_with {
        return Err("更新来源已更改，请重新检查更新".into());
    }
    let view = StagedView {
        version: display_version(package.version),
        file_name: package.file_name.clone(),
        size: package.size,
    };
    let mut staged = service.staged.lock().await;
    if staged.as_ref().is_some_and(|current| same_installer(&current.package, &package)) {
        return Ok(view);
    }
    *staged = None;
    let cancelled = || service.download_state.load(Ordering::SeqCst) == CANCELLING;
    *staged = Some(download::download(transport, &package, preference, root, progress, &cancelled).await?);
    Ok(view)
}

#[tauri::command]
pub(crate) async fn download_launcher_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<LauncherState>>,
    service: tauri::State<'_, Arc<UpdateService>>,
) -> AppResult<StagedView> {
    use tauri::Emitter;
    let transport = HttpTransport::new(&state)?;
    let root = download::updates_root()?;
    let last = std::sync::atomic::AtomicU64::new(u64::MAX);
    let progress = |downloaded: u64, total: u64| {
        // At most one event per percent.
        let percent = downloaded.saturating_mul(100) / total.max(1);
        if last.swap(percent, std::sync::atomic::Ordering::Relaxed) != percent {
            let _ = app.emit("launcher://update-progress", ProgressEvent { downloaded, total });
        }
    };
    download_with(&state, &service, &transport, &root, &progress).await.map_err(crate::errors::expected)
}

/// Asks a running update download to stop; it removes its own files.
#[tauri::command]
pub(crate) fn cancel_launcher_update(service: tauri::State<'_, Arc<UpdateService>>) {
    request_cancel(&service);
}

/// Only a running download can be cancelled; IDLE stays IDLE, so a late
/// cancel can never stop the next download.
pub(crate) fn request_cancel(service: &UpdateService) {
    use std::sync::atomic::Ordering;
    let _ = service.download_state.compare_exchange(RUNNING, CANCELLING, Ordering::SeqCst, Ordering::SeqCst);
}

/// What is running right now, for the install gate.
pub(crate) fn activity(
    state: &LauncherState,
    service: &UpdateService,
    servers: &crate::server_manager::ServerRegistry,
) -> Result<install::Activity, String> {
    Ok(install::Activity {
        games: state.games.snapshot()?.len(),
        servers: servers.any_running(),
        tasks: !state.control.is_idle(),
        update_download: service.download_state.load(std::sync::atomic::Ordering::SeqCst) != IDLE,
    })
}

/// Everything the install holds until the process exits: the operation and
/// server locks and the INSTALLING download state. Dropping it (any refusal
/// after the gate) gives all of them back.
pub(crate) struct InstallGate<'a> {
    _operation: tokio::sync::MutexGuard<'a, ()>,
    _servers: tokio::sync::MutexGuard<'a, ()>,
    service: &'a UpdateService,
}

impl Drop for InstallGate<'_> {
    fn drop(&mut self) {
        self.service.download_state.store(IDLE, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The H06 gate for the install: refuses while anything runs here, and
/// while any other process (a launcher with another profile) uses the
/// installed executable, which the installer would force-close. Checks
/// that cannot be completed refuse too.
pub(crate) fn hold_idle<'a>(
    state: &'a LauncherState,
    service: &'a UpdateService,
    servers: &'a crate::server_manager::ServerRegistry,
    executable: &std::path::Path,
    me: process::Identity,
    others: impl Fn(&std::path::Path, Option<process::Identity>) -> Result<bool, String>,
) -> AppResult<InstallGate<'a>> {
    use crate::errors::AppError;
    use std::sync::atomic::Ordering;
    let operation = state.operation.try_lock().map_err(|_| AppError::new("update.tasksRunning"))?;
    let server_lock = servers.try_hold().ok_or_else(|| AppError::new("update.serverRunning"))?;
    if let Some(code) = install::busy_reason(activity(state, service, servers)?) {
        return Err(AppError::new(code));
    }
    service
        .download_state
        .compare_exchange(IDLE, INSTALLING, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| AppError::new("update.downloading"))?;
    let gate = InstallGate { _operation: operation, _servers: server_lock, service };
    match others(executable, Some(me)) {
        Ok(false) => Ok(gate),
        Ok(true) => Err(AppError::new("update.otherInstance")),
        Err(detail) => Err(AppError::new("update.otherInstanceUnknown").with_detail(detail)),
    }
}

/// Installs the staged update on exit. Refused unless the launcher is idle:
/// no game, no managed server, no download or launch task, no update
/// download. The operation and server locks are taken here and never
/// released, so nothing can start between the check and the exit.
/// `error_text` and `logs_text` are the helper's localized failure texts.
#[tauri::command]
pub(crate) async fn install_launcher_update_and_exit(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<LauncherState>>,
    service: tauri::State<'_, Arc<UpdateService>>,
    servers: tauri::State<'_, Arc<crate::server_manager::ServerRegistry>>,
    error_text: String,
    logs_text: String,
) -> AppResult<()> {
    use crate::errors::AppError;
    let bounded = |text: String| -> AppResult<String> {
        (!text.trim().is_empty() && text.chars().count() <= 4096)
            .then_some(text)
            .ok_or_else(|| AppError::new("update.invalidText"))
    };
    let (error_text, logs_text) = (bounded(error_text)?, bounded(logs_text)?);
    let executable = std::env::current_exe().map_err(|_| AppError::new("update.handOffFailed"))?;
    let parent = install::current_identity()?;
    let gate = hold_idle(&state, &service, &servers, &executable, parent, process::other_users)?;
    let mut slot = service.staged.lock().await;
    let mut staged = slot.take().ok_or_else(|| AppError::new("update.notStaged"))?;
    // A failed re-check drops the staged update, which removes its files.
    staged.verify()?;
    let helper_exe = install::copy_helper(&executable, &staged)?;
    let command = install::helper_command(&helper_exe, &staged, parent, &executable, &error_text, &logs_text);
    if let Err(error) = install::hand_off(command).await {
        let _ = std::fs::remove_file(&helper_exe);
        *slot = Some(staged);
        return Err(AppError::new("update.handOffFailed").with_detail(error));
    }
    staged.hand_off();
    state.control.unbind_events();
    // Keep the locks and the INSTALLING state for the rest of this process's life.
    std::mem::forget(gate);
    app.exit(0);
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

#[cfg(test)]
#[path = "handoff-tests.rs"]
mod handoff_tests;
