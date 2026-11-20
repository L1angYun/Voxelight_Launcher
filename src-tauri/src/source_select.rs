//! U0272: order the download sources for "auto" by measured reachability.
//!
//! The probe sends one request to the official version manifest and one to its
//! fixed BMCLAPI mapping, at the same time, through the session client (so the
//! proxy and redirect policy are those of every metadata request). Ranking only
//! decides the order of the candidates `download_url_candidates` already
//! returns; it never adds a host. The verdict lives for the session and is
//! never persisted or written back into the configuration.
use crate::downloads::DownloadControl;
use crate::storage::LauncherState;
use serde::Serialize;
use std::sync::Arc;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// An inconclusive verdict (both probes failed) is retried after this long.
const INCONCLUSIVE_RETRY: Duration = Duration::from_secs(60);
/// The mirror goes first only if the official source failed or was slower
/// than twice the mirror plus this margin. Provisional until real data exists.
const MARGIN: Duration = Duration::from_millis(150);
/// Once the official probe has answered, a mirror that has not answered yet is
/// already slower and cannot change the order; wait only this long for its
/// latency, so a dead mirror never holds up the first version list.
const MIRROR_GRACE: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Verdict {
    pub(crate) mirror_first: bool,
    pub(crate) official_ms: Option<u64>,
    pub(crate) mirror_ms: Option<u64>,
    pub(crate) conclusive: bool,
    at: Instant,
}

fn millis(value: Duration) -> u64 {
    value.as_millis().min(u128::from(u64::MAX)) as u64
}

/// `None` means the probe failed (error, timeout or a non-2xx status).
pub(crate) fn rank(official: Option<Duration>, mirror: Option<Duration>, at: Instant) -> Verdict {
    let mirror_first = match (official, mirror) {
        (None, Some(_)) => true,
        (Some(official), Some(mirror)) => official > mirror * 2 + MARGIN,
        _ => false,
    };
    Verdict {
        mirror_first,
        official_ms: official.map(millis),
        mirror_ms: mirror.map(millis),
        conclusive: official.is_some() || mirror.is_some(),
        at,
    }
}

/// The two fixed probe targets; never taken from a manifest, the config or the UI.
pub(crate) fn probe_targets() -> Result<[String; 2], String> {
    let official = crate::minecraft::MANIFEST_URL.to_owned();
    let mirror = crate::minecraft::mapped_bmclapi_url(&official)?;
    crate::storage::trusted_url(&official)?;
    crate::storage::trusted_url(&mirror)?;
    Ok([official, mirror])
}

async fn probe_one(
    client: &reqwest::Client,
    url: &str,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Option<Duration> {
    let request = crate::minecraft::resolve_request_url(url, resolver).ok()?;
    let started = Instant::now();
    // Latency to the response headers; the body is dropped unread.
    let response = client.get(request).timeout(PROBE_TIMEOUT).send().await.ok()?;
    response.status().is_success().then(|| started.elapsed())
}

async fn probe(
    state: &LauncherState,
    control: Option<&DownloadControl>,
    resolver: &(dyn Fn(&str) -> String + Sync),
) -> Result<(Option<Duration>, Option<Duration>), String> {
    let [official, mirror] = probe_targets()?;
    // Without a session client nothing can be measured: inconclusive, not an
    // error, so callers keep their own offline fallbacks.
    let Ok(client) = state.client() else {
        return Ok((None, None));
    };
    let official = std::pin::pin!(probe_one(client, &official, resolver));
    let mirror = std::pin::pin!(probe_one(client, &mirror, resolver));
    crate::download_io::cancellable(control, async move {
        match futures_util::future::select(official, mirror).await {
            futures_util::future::Either::Left((Some(official), mirror)) => {
                let mirror = tokio::time::timeout(MIRROR_GRACE, mirror).await.ok().flatten();
                (Some(official), mirror)
            }
            futures_util::future::Either::Left((None, mirror)) => (None, mirror.await),
            futures_util::future::Either::Right((mirror, official)) => (official.await, mirror),
        }
    })
    .await
}

/// The source a task-owned operation (an install, a launch) should use.
/// "official" and "bmclapi" are returned unchanged and never probe. "auto"
/// becomes "bmclapi" (mirror first) when the session verdict says so, and
/// otherwise stays "auto" (official first). Both map to the same
/// verified-mirror installer cache lane, and "official" never becomes a
/// mirror-capable value. Waiting and probing follow the active task's Cancel.
pub(crate) async fn effective_download_source(state: &LauncherState, configured: &str) -> Result<String, String> {
    effective_with(state, configured, Some(&state.control), &crate::minecraft::identity_url, Instant::now).await
}

/// The same for a passive caller with no task of its own (the version list,
/// loader lists, the default-skin preview): its probe is not tied to whatever
/// task happens to be active.
pub(crate) async fn passive_download_source(state: &LauncherState, configured: &str) -> Result<String, String> {
    effective_with(state, configured, None, &crate::minecraft::identity_url, Instant::now).await
}

/// A copy of `config` whose download source is the effective one, for a task
/// that passes the config down. Computed once per operation so a single
/// install never changes order midway. The copy is never saved.
pub(crate) async fn with_effective_source(
    state: &LauncherState,
    config: &crate::models::Config,
) -> Result<crate::models::Config, String> {
    let mut effective = config.clone();
    effective.download_source = effective_download_source(state, &config.download_source).await?;
    Ok(effective)
}

/// `control` is `Some` for a task-owned caller. Such a caller never re-probes
/// an expired inconclusive verdict: offline, a launch must not wait 4 s every
/// time. It keeps official first (which still falls back per file) and leaves
/// the retry to the next passive caller.
pub(crate) async fn effective_with(
    state: &LauncherState,
    configured: &str,
    control: Option<&DownloadControl>,
    resolver: &(dyn Fn(&str) -> String + Sync),
    now: impl Fn() -> Instant,
) -> Result<String, String> {
    if configured != "auto" {
        return Ok(configured.to_owned());
    }
    // Held across the probe so concurrent callers share one probe pair; a task
    // waiting here behind another caller's probe still honours Cancel.
    let mut cached = crate::download_io::cancellable(control, state.source_verdict.lock()).await?;
    let reusable = cached
        .as_ref()
        .filter(|verdict| {
            verdict.conclusive
                || control.is_some()
                || now().duration_since(verdict.at) < INCONCLUSIVE_RETRY
        })
        .cloned();
    let verdict = match reusable {
        Some(verdict) => verdict,
        None => {
            let (official, mirror) = probe(state, control, resolver).await?;
            let verdict = rank(official, mirror, now());
            record_decision(&state.data_dir, &decision_text(&verdict));
            *cached = Some(verdict.clone());
            verdict
        }
    };
    Ok(if verdict.mirror_first { "bmclapi" } else { "auto" }.into())
}

fn record_decision(data_dir: &std::path::Path, message: &str) {
    let record = format!("{} [info] {message}\n", chrono::Utc::now().to_rfc3339());
    if crate::process_output::append_log(&data_dir.join("logs"), &record).is_err() {
        eprintln!("{message}");
    }
}

/// Fixed text for the log: rounded latencies only, never a host or URL.
fn decision_text(verdict: &Verdict) -> String {
    let latency = |value: Option<u64>| value.map_or("未响应".to_owned(), |ms| format!("{ms} ms"));
    format!(
        "下载源自动选择：{}（官方 {}，镜像 {}）",
        if verdict.mirror_first { "镜像优先" } else { "官方优先" },
        latency(verdict.official_ms),
        latency(verdict.mirror_ms),
    )
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerdictView {
    preferred: &'static str,
    official_ms: Option<u64>,
    mirror_ms: Option<u64>,
    conclusive: bool,
}

fn view(verdict: &Verdict) -> VerdictView {
    VerdictView {
        preferred: if verdict.mirror_first { "mirror" } else { "official" },
        official_ms: verdict.official_ms,
        mirror_ms: verdict.mirror_ms,
        conclusive: verdict.conclusive,
    }
}

/// The current session verdict, if "auto" has been resolved yet. Read-only:
/// it never starts a probe.
#[tauri::command]
pub(crate) async fn get_download_source_verdict(
    state: tauri::State<'_, Arc<LauncherState>>,
) -> crate::errors::AppResult<Option<VerdictView>> {
    Ok(state.source_verdict.lock().await.as_ref().map(view))
}

#[cfg(test)]
#[path = "source_select-tests.rs"]
mod tests;
