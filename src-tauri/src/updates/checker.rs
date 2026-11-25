//! The update check (ported from HSRUnlocker `UpdateChecker.cs`): GitHub API
//! first with a tag-bound update.json fallback when rate limited, the Gitee
//! release list, and in Auto mode both at once with a one-second window for
//! the second answer. Same version with different installer bytes is an error.
use super::manifest::{parse_release, pick_gitee_release, strict_json, Release, Version};
use super::sources::{file_url, get_file, manifest_location_tag, read_body, Request, Response, Transport};
use super::{Preference, Source, API_LATEST, GITEE_RELEASES, MANIFEST_LATEST, MAX_METADATA_BYTES};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use std::sync::Mutex;
use std::time::Duration;

const GITHUB_DEADLINE: Duration = Duration::from_secs(5);
const GITEE_DEADLINE: Duration = Duration::from_secs(8);
const SECOND_ANSWER_WINDOW: Duration = Duration::from_secs(1);

/// The API quota is exhausted until this time; until then the GitHub side
/// reads the static update.json instead.
#[derive(Default)]
pub(crate) struct RateLimit(Mutex<Option<DateTime<Utc>>>);

impl RateLimit {
    /// The cooldown deadline, if it is still in the future.
    pub(crate) fn until(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        self.0.lock().ok().and_then(|value| *value).filter(|until| *until > now)
    }
    fn set(&self, until: DateTime<Utc>) {
        if let Ok(mut value) = self.0.lock() {
            *value = Some(until);
        }
    }
}

/// HSR `ReadRateLimit`. Retry-After is unsigned delta-seconds capped at a
/// day before any arithmetic, or an HTTP date; anything else is ignored, so
/// no header value can overflow (a panic would abort the release build).
pub(crate) fn rate_limited_until(response: &Response, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let exhausted = response.rate_remaining.as_deref().map(str::trim) == Some("0");
    if response.status != 429 && (response.status != 403 || (!exhausted && response.retry_after.is_none())) {
        return None;
    }
    let day = ChronoDuration::hours(24);
    let mut retry = response.retry_after.as_deref().map(str::trim).and_then(|value| {
        match value.parse::<u32>() {
            Ok(seconds) => Some(now + ChronoDuration::seconds(i64::from(seconds).min(86_400))),
            Err(_) => DateTime::parse_from_rfc2822(value).ok().map(|date| date.with_timezone(&Utc)),
        }
    });
    if let Some(reset) = response
        .rate_reset
        .as_deref()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds, 0))
    {
        retry = Some(retry.map_or(reset, |current| current.max(reset)));
    }
    Some(retry.unwrap_or(now + ChronoDuration::minutes(1)).clamp(now + ChronoDuration::seconds(1), now + day))
}

async fn json_of(response: Response) -> Result<serde_json::Value, String> {
    strict_json(&read_body(response, MAX_METADATA_BYTES).await?)
}

/// The start of the quota diagnosis, so the renderer can name it (update.rateLimited).
pub(crate) const QUOTA_EXHAUSTED: &str = "GitHub API 调用次数已用完";
/// The end of a source's deadline message (update.timedOut).
pub(crate) const TIMED_OUT: &str = "更新检查超时";

async fn read_github(transport: &dyn Transport, limit: &RateLimit, now: DateTime<Utc>) -> Result<Release, String> {
    let until = match limit.until(now) {
        Some(until) => until,
        None => {
            let response = transport.send(Request { url: API_LATEST.into(), api: true }).await?;
            match rate_limited_until(&response, now) {
                Some(until) => {
                    limit.set(until);
                    until
                }
                None => {
                    if !(200..300).contains(&response.status) {
                        return Err(format!("GitHub 更新检查失败（HTTP {}）", response.status));
                    }
                    return parse_release(&json_of(response).await?, Source::GitHub, None);
                }
            }
        }
    };
    // As in HSR, a failed fallback still reports the quota diagnosis and when it ends.
    read_github_fallback(transport).await.map_err(|error| {
        let local = until.with_timezone(&chrono::Local).format("%H:%M");
        format!("{QUOTA_EXHAUSTED}（{local} 后恢复），改读更新信息也失败：{error}")
    })
}

/// The static manifest, with the tag bound across the whole redirect chain.
async fn read_github_fallback(transport: &dyn Transport) -> Result<Release, String> {
    let mut url = MANIFEST_LATEST.to_owned();
    let mut expected: Option<String> = None;
    for _ in 0..=5 {
        if let Some(tag) = manifest_location_tag(&url)? {
            if expected.as_ref().is_some_and(|current| *current != tag) {
                return Err("更新信息跳转改变了发布标签".into());
            }
            expected = Some(tag);
        }
        let response = transport.send(Request { url: url.clone(), api: false }).await?;
        if matches!(response.status, 301 | 302 | 303 | 307 | 308) {
            let next = response.location.as_deref().ok_or("更新跳转缺少目标")?;
            let base = reqwest::Url::parse(&url).map_err(|_| "更新地址无效")?;
            url = base.join(next).map_err(|_| "更新跳转目标无效")?.to_string();
            continue;
        }
        if !(200..300).contains(&response.status) {
            return Err(format!("GitHub 更新信息读取失败（HTTP {}）", response.status));
        }
        return parse_release(&json_of(response).await?, Source::GitHub, expected.as_deref());
    }
    Err("更新跳转次数过多".into())
}

async fn read_gitee(transport: &dyn Transport) -> Result<Release, String> {
    let response = transport.send(Request { url: GITEE_RELEASES.into(), api: false }).await?;
    if !(200..300).contains(&response.status) {
        return Err(format!("Gitee 更新检查失败（HTTP {}）", response.status));
    }
    let (tag, notes) = pick_gitee_release(&json_of(response).await?)?;
    let manifest = get_file(transport, &file_url(Source::Gitee, &tag, "update.json"), "update.json", Source::Gitee, Some(&tag)).await?;
    let mut release = parse_release(&json_of(manifest).await?, Source::Gitee, Some(&tag))?;
    // The mirror's update.json has no body; its release list carries the notes.
    release.notes = release.notes.or(notes);
    Ok(release)
}

async fn read_source(
    transport: &dyn Transport,
    source: Source,
    limit: &RateLimit,
    now: DateTime<Utc>,
) -> Result<Release, String> {
    let (deadline, read) = match source {
        Source::GitHub => (GITHUB_DEADLINE, futures_util::future::Either::Left(read_github(transport, limit, now))),
        Source::Gitee => (GITEE_DEADLINE, futures_util::future::Either::Right(read_gitee(transport))),
    };
    tokio::time::timeout(deadline, read)
        .await
        .unwrap_or_else(|_| Err(format!("{} {TIMED_OUT}", source.label())))
}

/// Picks between the two answers (HSR `Select`): a higher version wins; the
/// same version must have the same installer bytes, or the check fails.
pub(crate) fn select(first: Result<Release, String>, second: Option<Result<Release, String>>) -> Result<Release, String> {
    let (a, b) = match (first, second.and_then(Result::ok)) {
        (Ok(a), Some(b)) => (a, b),
        (Ok(a), None) => return Ok(a),
        (Err(_), Some(b)) => return Ok(b),
        (Err(error), None) => return Err(error),
    };
    if a.version != b.version {
        return Ok(if a.version > b.version { a } else { b });
    }
    match (&a.package, &b.package) {
        (Some(x), Some(y)) if x.size != y.size || x.sha256 != y.sha256 => {
            Err("GitHub 和 Gitee 上同一版本的安装包不一致，已停止更新".into())
        }
        (None, Some(_)) => Ok(b),
        _ => Ok(a),
    }
}

/// Runs the check. In Auto mode both sources start at once; once one
/// answers successfully, the other gets at most one more second.
pub(crate) async fn check(
    transport: &dyn Transport,
    preference: Preference,
    limit: &RateLimit,
    now: DateTime<Utc>,
) -> Result<Release, String> {
    use futures_util::future::{select as race, Either};
    match preference {
        Preference::GitHub => read_source(transport, Source::GitHub, limit, now).await,
        Preference::Gitee => read_source(transport, Source::Gitee, limit, now).await,
        Preference::Auto => {
            let github = std::pin::pin!(read_source(transport, Source::GitHub, limit, now));
            let gitee = std::pin::pin!(read_source(transport, Source::Gitee, limit, now));
            let (first, other) = match race(github, gitee).await {
                Either::Left((first, other)) => (first, Either::Left(other)),
                Either::Right((first, other)) => (first, Either::Right(other)),
            };
            let second = if first.is_ok() {
                tokio::time::timeout(SECOND_ANSWER_WINDOW, other).await.ok()
            } else {
                Some(other.await)
            };
            select(first, second)
        }
    }
}

/// Only a strictly higher version than both the running one and the highest
/// version seen before counts as an update; a lower answer means a source is
/// frozen on an old release.
pub(crate) fn classify(release: &Release, current: Version, highest_seen: Option<Version>) -> Offer {
    classify_for_running(release, current, false, highest_seen)
}

/// Classifies an offered stable release against the running build. Per SemVer
/// 2.0.0, a pre-release build (e.g. `0.7.0-beta.1`) treats the matching stable
/// release (`0.7.0`) as newer while never downgrading to an older release.
pub(crate) fn classify_for_running(
    release: &Release,
    current: Version,
    current_is_prerelease: bool,
    highest_seen: Option<Version>,
) -> Offer {
    if highest_seen.is_some_and(|seen| release.version < seen) {
        Offer::Stale
    } else if release.version > current || (current_is_prerelease && release.version == current) {
        Offer::Newer
    } else {
        Offer::Current
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Offer {
    Newer,
    Current,
    Stale,
}
