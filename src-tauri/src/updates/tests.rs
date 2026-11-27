use super::checker::{check, check_channel, classify, classify_semver, select, Offer, RateLimit};
use super::manifest::{
    display_version, parse_release, parse_release_for_channel, parse_running_version, parse_semver, parse_version,
    pick_gitee_release, pick_gitee_release_for_channel, pick_github_release, strict_json, Package, PreReleaseStage,
    Release, SemVer,
};
use super::sources::{get_file, manifest_location_tag, validate_location, FetchError, Location, Request, Response, Transport};
use super::*;
use futures_util::future::BoxFuture;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SHA: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Clone)]
struct Reply {
    status: u16,
    location: Option<String>,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
    delay: Duration,
    /// The declared Content-Length: None for the body length, Some(None) for unknown.
    length: Option<Option<u64>>,
    /// A body in parts: (delay before the part in ms, the part). Replaces `body`.
    chunks: Option<Vec<(u64, Result<Vec<u8>, FetchError>)>>,
}

fn ok(body: serde_json::Value) -> Reply {
    Reply { status: 200, location: None, headers: vec![], body: body.to_string().into_bytes(), delay: Duration::ZERO, length: None, chunks: None }
}

fn status(code: u16) -> Reply {
    Reply { status: code, location: None, headers: vec![], body: vec![], delay: Duration::ZERO, length: None, chunks: None }
}

fn moved(to: &str) -> Reply {
    Reply { status: 302, location: Some(to.into()), headers: vec![], body: vec![], delay: Duration::ZERO, length: None, chunks: None }
}

fn delayed(reply: Reply, ms: u64) -> Reply {
    Reply { delay: Duration::from_millis(ms), ..reply }
}

/// Answers only the URLs it was given (each reply once, in order) and panics
/// on any other request, so a test proves exactly which hosts were contacted.
#[derive(Default)]
struct Fake {
    routes: Mutex<HashMap<String, Vec<Reply>>>,
    seen: Mutex<Vec<(String, bool, Instant)>>,
}

impl Fake {
    fn with(routes: Vec<(&str, Reply)>) -> Self {
        let fake = Self::default();
        for (url, reply) in routes {
            fake.routes.lock().unwrap().entry(url.to_owned()).or_default().push(reply);
        }
        fake
    }
    fn urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|(url, ..)| url.clone()).collect()
    }
    fn done(&self) {
        let left: Vec<_> = self.routes.lock().unwrap().iter().filter(|(_, replies)| !replies.is_empty()).map(|(url, _)| url.clone()).collect();
        assert!(left.is_empty(), "unused fake replies: {left:?}");
    }
}

impl Transport for Fake {
    fn send(&self, request: Request) -> BoxFuture<'_, Result<Response, String>> {
        self.seen.lock().unwrap().push((request.url.clone(), request.api, Instant::now()));
        let reply = {
            let mut routes = self.routes.lock().unwrap();
            let replies = routes.get_mut(&request.url).unwrap_or_else(|| panic!("unexpected request to {}", request.url));
            assert!(!replies.is_empty(), "no reply left for {}", request.url);
            replies.remove(0)
        };
        Box::pin(async move {
            if !reply.delay.is_zero() {
                tokio::time::sleep(reply.delay).await;
            }
            let header = |name: &str| reply.headers.iter().find(|(key, _)| *key == name).map(|(_, value)| value.clone());
            Ok(Response {
                status: reply.status,
                location: reply.location.clone(),
                retry_after: header("retry-after"),
                rate_remaining: header("x-ratelimit-remaining"),
                rate_reset: header("x-ratelimit-reset"),
                content_length: reply.length.unwrap_or(Some(reply.body.len() as u64)),
                body: match reply.chunks {
                    None => futures_util::stream::iter(vec![Ok(reply.body)]).boxed(),
                    Some(chunks) => futures_util::stream::iter(chunks)
                        .then(|(ms, part)| async move {
                            tokio::time::sleep(Duration::from_millis(ms)).await;
                            part
                        })
                        .boxed(),
                },
            })
        })
    }
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

fn release_json(tag: &str, sha: &str, size: u64) -> serde_json::Value {
    let version = parse_semver(tag).unwrap();
    json!({"tag_name": tag, "draft": false, "prerelease": version.is_prerelease(), "body": format!("notes {tag}"),
        "assets": [{"name": installer_name_for(version), "size": size, "digest": format!("sha256:{sha}")}]})
}

fn gitee_list(tag: &str) -> serde_json::Value {
    let version = parse_semver(tag).unwrap();
    json!([{"tag_name": tag, "prerelease": version.is_prerelease(), "body": format!("gitee notes {tag}"), "assets": [{"name": "update.json"}]}])
}

fn gitee_manifest_url(tag: &str) -> String {
    format!("https://gitee.com/liangyun_Liu/Voxelight_Launcher/releases/download/{tag}/update.json")
}

#[test]
fn version_parser_accepts_only_stable_three_part_versions() {
    assert_eq!(parse_version("0.7.0"), Some((0, 7, 0)));
    assert_eq!(parse_version("v10.0.12"), Some((10, 0, 12)));
    for bad in ["0.7.0-beta", "01.2.3", "1.2", "1.2.3.4", "", "v", "1..2", " 1.2.3", "1.2.3 ", "V1.2.3", "+1.2.3"] {
        assert_eq!(parse_version(bad), None, "{bad}");
    }
    assert_eq!(parse_version(&format!("1.2.{}", "1".repeat(62))), None, "over 64 characters");
    assert_eq!(parse_version("1.2.99999999999999999999"), None, "overflow");
    assert_eq!(current_version(), parse_running_version(env!("CARGO_PKG_VERSION")).unwrap().0);

    // Pre-release running builds parse cleanly and treat the matching stable release as newer.
    assert_eq!(parse_running_version("0.7.0"), Some(((0, 7, 0), false)));
    assert_eq!(parse_running_version("0.7.0-beta.1"), Some(((0, 7, 0), true)));
    assert_eq!(parse_running_version("1.0.0-rc.2"), Some(((1, 0, 0), true)));
    for bad in ["0.7.0-beta", "0.7.0-beta.0", "0.7.0-dev.1", "0.7.0-alpha.01"] {
        assert_eq!(parse_running_version(bad), None, "{bad}");
    }
    let stable_070 = parse_release(&release_json("v0.7.0", SHA, 10), Source::GitHub, None).unwrap();
    let stable_060 = parse_release(&release_json("v0.6.0", SHA, 10), Source::GitHub, None).unwrap();
    assert_eq!(checker::classify_for_running(&stable_070, (0, 7, 0), true, None), Offer::Newer);
    assert_eq!(checker::classify_for_running(&stable_060, (0, 7, 0), true, None), Offer::Current);
    assert_eq!(checker::classify_for_running(&stable_070, (0, 7, 0), false, None), Offer::Current);
}

#[test]
fn strict_json_rejects_duplicate_keys_excess_depth_and_oversize_bodies() {
    assert!(strict_json(br#"{"a":1,"b":[true,null,"x"]}"#).is_ok());
    assert!(strict_json(br#"{"tag_name":"v1.0.0","tag_name":"v9.9.9"}"#).is_err());
    assert!(strict_json(br#"{"a":{"b":1,"b":2}}"#).is_err());
    let deep = format!("{}1{}", "[".repeat(8), "]".repeat(8));
    assert!(strict_json(deep.as_bytes()).is_ok(), "eight levels are allowed");
    let deeper = format!("{}1{}", "[".repeat(9), "]".repeat(9));
    assert!(strict_json(deeper.as_bytes()).is_err());
    assert!(strict_json(b"{} trailing").is_err());
    let mut big = b"\"".to_vec();
    big.resize(MAX_METADATA_BYTES, b'x');
    big.push(b'"');
    assert!(strict_json(&big).is_err(), "256 KiB + 1");
}

#[test]
fn release_must_be_stable_and_bound_to_the_expected_tag() {
    let good = release_json("v0.7.0", SHA, 10);
    let release = parse_release(&good, Source::GitHub, Some("v0.7.0")).unwrap();
    assert_eq!(release.version, SemVer::stable((0, 7, 0)));
    assert_eq!(release.notes.as_deref(), Some("notes v0.7.0"));
    assert_eq!(release.release_url(), "https://github.com/L1angYun/Voxelight_Launcher/releases/tag/v0.7.0");
    let package = release.package.unwrap();
    assert_eq!((package.file_name.as_str(), package.size, package.sha256.as_str()), ("VoxelightLauncher-0.7.0-x64-setup.exe", 10, SHA));
    for (field, value) in [("draft", json!(true)), ("prerelease", json!(true)), ("draft", json!(null)), ("tag_name", json!(7))] {
        let mut bad = good.clone();
        bad[field] = value;
        assert!(parse_release(&bad, Source::GitHub, None).is_err(), "{field}");
    }
    let mut missing = good.clone();
    missing.as_object_mut().unwrap().remove("draft");
    assert!(parse_release(&missing, Source::GitHub, None).is_err());
    assert!(parse_release(&good, Source::GitHub, Some("v0.6.9")).is_err(), "tag mismatch");
    let notes = "x".repeat(MAX_NOTES_CHARS + 50) + "\u{7}";
    let mut long = good.clone();
    long["body"] = json!(notes);
    assert_eq!(parse_release(&long, Source::GitHub, None).unwrap().notes.unwrap().chars().count(), MAX_NOTES_CHARS);
}

#[test]
fn installer_asset_needs_one_exact_name_a_bounded_size_and_a_sha256_digest() {
    let name = installer_name((0, 7, 0));
    let with = |assets: serde_json::Value| {
        let mut value = release_json("v0.7.0", SHA, 1);
        value["assets"] = assets;
        parse_release(&value, Source::GitHub, None)
    };
    assert!(with(json!([])).unwrap().package.is_none(), "no installer is not an error");
    assert!(with(json!([{"name": "other.exe", "size": 1, "digest": format!("sha256:{SHA}")}])).unwrap().package.is_none());
    for bad in [
        json!([{"name": name, "size": 0, "digest": format!("sha256:{SHA}")}]),
        json!([{"name": name, "size": MAX_INSTALLER_BYTES + 1, "digest": format!("sha256:{SHA}")}]),
        json!([{"name": name, "size": 1, "digest": format!("sha256:{}", &SHA[1..])}]),
        json!([{"name": name, "size": 1, "digest": format!("sha1:{SHA}")}]),
        json!([{"name": name, "size": 1}]),
        json!([{"name": name, "size": 1, "digest": format!("sha256:{SHA}")}, {"name": name, "size": 1, "digest": format!("sha256:{SHA}")}]),
        json!({"name": name}),
    ] {
        assert!(with(bad.clone()).is_err(), "{bad}");
    }
    let upper = with(json!([{"name": name, "size": 1, "digest": format!("sha256:{}", SHA.to_uppercase())}])).unwrap();
    assert_eq!(upper.package.unwrap().sha256, SHA, "digests are compared lowercase");
}

#[test]
fn gitee_list_picks_the_highest_complete_stable_release() {
    let list = json!([
        {"tag_name": "v0.7.0", "prerelease": false, "assets": [{"name": "update.json"}], "body": "seven"},
        {"tag_name": "v0.8.0", "prerelease": false, "assets": []},
        {"tag_name": "v0.9.0", "prerelease": true, "assets": [{"name": "update.json"}]},
        {"tag_name": "nightly", "prerelease": false, "assets": [{"name": "update.json"}]},
        {"tag_name": "v0.7.5", "prerelease": false, "assets": [{"name": "update.json"}], "body": "seven five"}
    ]);
    assert_eq!(pick_gitee_release(&list).unwrap(), ("v0.7.5".into(), Some("seven five".into())));
    let duplicate = json!([
        {"tag_name": "v0.7.0", "prerelease": false, "assets": [{"name": "update.json"}]},
        {"tag_name": "0.7.0", "prerelease": false, "assets": []}
    ]);
    assert!(pick_gitee_release(&duplicate).is_err(), "the same version twice is ambiguous");
    let two = json!([{"tag_name": "v0.7.0", "prerelease": false, "assets": [{"name": "update.json"}, {"name": "update.json"}]}]);
    assert!(pick_gitee_release(&two).is_err());
    assert!(pick_gitee_release(&json!([])).is_err());
    assert!(pick_gitee_release(&json!((0..101).map(|_| json!({})).collect::<Vec<_>>())).is_err());
}

#[test]
fn locations_reject_untrusted_schemes_hosts_paths_and_tags() {
    let file = "VoxelightLauncher-0.7.0-x64-setup.exe";
    let gh = |path: &str| format!("https://github.com/L1angYun/Voxelight_Launcher{path}");
    let release = gh(&format!("/releases/download/v0.7.0/{file}"));
    assert_eq!(validate_location(&release, file, Source::GitHub, Some("v0.7.0")), Ok(Location::Release));
    assert_eq!(validate_location("https://release-assets.githubusercontent.com/x?sig=1", file, Source::GitHub, None), Ok(Location::Cdn));
    for bad in [
        release.replace("https://", "http://"),
        release.replace("github.com", "github.com:444"),
        release.replace("https://", "https://user@"),
        format!("{release}#frag"),
        format!("{release}?x=1"),
        release.replace("L1angYun", "Someone"),
        release.replace("v0.7.0/", "v0.6.9/"),
        gh("/releases/download/v0.7.0/other.exe"),
        gh(&format!("/releases/download/latest/{file}")),
        format!("https://evil.example/L1angYun/Voxelight_Launcher/releases/download/v0.7.0/{file}"),
        "https://foruda.gitee.com/attach_file/1/x".into(),
    ] {
        assert!(validate_location(&bad, file, Source::GitHub, Some("v0.7.0")).is_err(), "{bad}");
    }
    let gitee = format!("https://gitee.com/liangyun_Liu/Voxelight_Launcher/releases/download/v0.7.0/{file}");
    assert_eq!(validate_location(&gitee, file, Source::Gitee, None), Ok(Location::Release));
    let attach = format!("https://gitee.com/liangyun_Liu/Voxelight_Launcher/attach_files/123/download/{file}");
    assert_eq!(validate_location(&attach, file, Source::Gitee, None), Ok(Location::Attachment));
    let cdn = format!("https://foruda.gitee.com/attach_file/42/{}?token=t", file.to_ascii_lowercase());
    assert_eq!(validate_location(&cdn, file, Source::Gitee, None), Ok(Location::Cdn));
    for bad in [
        attach.replace("/123/", "/abc/"),
        attach.replace("/download/", "/raw/"),
        "https://foruda.gitee.com/attach_file/42/other.exe".into(),
        "https://release-assets.githubusercontent.com/x".to_owned(),
    ] {
        assert!(validate_location(&bad, file, Source::Gitee, None).is_err(), "{bad}");
    }
    assert_eq!(validate_location(&gh("/releases/latest/download/update.json"), "update.json", Source::GitHub, None), Ok(Location::Release));
    assert!(validate_location(&gh("/releases/latest/download/update.json"), "update.json", Source::GitHub, Some("v0.7.0")).is_err());
}

#[test]
fn redirect_chains_follow_only_trusted_transitions_and_never_leak_urls() {
    let file = "VoxelightLauncher-0.7.0-x64-setup.exe";
    let start = format!("https://gitee.com/liangyun_Liu/Voxelight_Launcher/releases/download/v0.7.0/{file}");
    let attach = format!("https://gitee.com/liangyun_Liu/Voxelight_Launcher/attach_files/9/download/{file}");
    let cdn = format!("https://foruda.gitee.com/attach_file/9/{file}?signature=SECRET");
    let fake = Fake::with(vec![(&start, moved(&attach)), (&attach, moved(&cdn)), (&cdn, status(200))]);
    assert_eq!(run(get_file(&fake, &start, file, Source::Gitee, Some("v0.7.0"))).unwrap().status, 200);
    fake.done();

    // Gitee must go Release → Attachment → Cdn; skipping the attachment is refused.
    let skip = Fake::with(vec![(&start, moved(&cdn))]);
    assert!(run(get_file(&skip, &start, file, Source::Gitee, None)).is_err());
    // The first hop must be a release URL.
    assert!(run(get_file(&Fake::default(), &cdn, file, Source::Gitee, None)).is_err());

    let gh = format!("https://github.com/L1angYun/Voxelight_Launcher/releases/download/v0.7.0/{file}");
    let asset = "https://release-assets.githubusercontent.com/github-production/1?sig=SECRET".to_owned();
    let error = run(get_file(&Fake::with(vec![(&gh, moved(&asset)), (&asset, status(403))]), &gh, file, Source::GitHub, None))
        .err()
        .unwrap();
    assert_eq!(error, FetchError::Transport("更新服务器返回错误（HTTP 403）".into()), "an HTTP error is a transport failure");
    let error = String::from(error);
    assert!(!error.contains("SECRET") && !error.contains("http"), "{error}");
    // A CDN that redirects again is not a trusted transition.
    let again = Fake::with(vec![(&gh, moved(&asset)), (&asset, moved(&asset))]);
    assert!(run(get_file(&again, &gh, file, Source::GitHub, None)).is_err());
    // A redirect to another repository is refused.
    let other = gh.replace("L1angYun", "Someone");
    assert!(run(get_file(&Fake::with(vec![(&gh, moved(&other))]), &gh, file, Source::GitHub, None)).is_err());
}

#[test]
fn github_fallback_binds_the_tag_across_the_redirect_chain() {
    assert_eq!(manifest_location_tag(MANIFEST_LATEST), Ok(None));
    let tagged = "https://github.com/L1angYun/Voxelight_Launcher/releases/download/v0.7.0/update.json";
    assert_eq!(manifest_location_tag(tagged), Ok(Some("v0.7.0".into())));
    assert!(manifest_location_tag("https://github.com/L1angYun/Voxelight_Launcher/releases/download/nightly/update.json").is_err());
    assert!(manifest_location_tag("https://github.com/Other/Repo/releases/latest/download/update.json").is_err());

    let limited = Reply { headers: vec![("x-ratelimit-remaining", "0".into()), ("x-ratelimit-reset", "4102444800".into())], ..status(403) };
    let cdn = "https://release-assets.githubusercontent.com/m?sig=1";
    let fake = Fake::with(vec![
        (API_LATEST, limited.clone()),
        (MANIFEST_LATEST, moved(tagged)),
        (tagged, moved(cdn)),
        (cdn, ok(release_json("v0.7.0", SHA, 5))),
    ]);
    let limit = RateLimit::default();
    let now = chrono::Utc::now();
    let release = run(check(&fake, Preference::GitHub, &limit, now)).unwrap();
    assert_eq!((release.version, release.source), (SemVer::stable((0, 7, 0)), Source::GitHub));
    fake.done();

    // While the quota is exhausted, later checks skip the API entirely.
    let again = Fake::with(vec![(MANIFEST_LATEST, moved(tagged)), (tagged, moved(cdn)), (cdn, ok(release_json("v0.7.0", SHA, 5)))]);
    run(check(&again, Preference::GitHub, &limit, now)).unwrap();
    assert!(!again.urls().contains(&API_LATEST.to_owned()));

    // A chain that changes the tag midway is refused.
    let swapped = "https://github.com/L1angYun/Voxelight_Launcher/releases/download/v0.6.9/update.json";
    let bad = Fake::with(vec![(API_LATEST, limited.clone()), (MANIFEST_LATEST, moved(tagged)), (tagged, moved(swapped))]);
    assert!(run(check(&bad, Preference::GitHub, &RateLimit::default(), now)).is_err());

    // The body itself must carry the tag observed on the chain.
    let wrong_body = Fake::with(vec![(MANIFEST_LATEST, moved(tagged)), (tagged, moved(cdn)), (cdn, ok(release_json("v0.7.1", SHA, 5)))]);
    let error = run(check(&wrong_body, Preference::GitHub, &limit, now)).err().unwrap();
    assert!(error.ends_with("发布标签与跳转链不一致"), "{error}");
    wrong_body.done();
}

#[test]
fn a_failed_fallback_still_reports_the_exhausted_api_quota() {
    let limited = Reply { headers: vec![("x-ratelimit-remaining", "0".into())], ..status(403) };
    let fake = Fake::with(vec![(API_LATEST, limited), (MANIFEST_LATEST, status(404)), (MANIFEST_LATEST, status(404))]);
    let limit = RateLimit::default();
    let now = chrono::Utc::now();
    for _ in 0..2 {
        let error = run(check(&fake, Preference::GitHub, &limit, now)).err().unwrap();
        assert!(error.starts_with("GitHub API 调用次数已用完"), "{error}");
        assert!(error.contains("HTTP 404"), "the fallback's own cause is kept: {error}");
    }
    assert_eq!(fake.urls().iter().filter(|url| url.as_str() == API_LATEST).count(), 1, "the API is asked once");
    fake.done();
}

#[test]
fn beta_rate_limited_never_reads_the_stable_fallback() {
    let limited = Reply {
        headers: vec![("x-ratelimit-remaining", "0".into()), ("x-ratelimit-reset", "4102444800".into())],
        ..status(403)
    };
    // Only the release list is routed: any read of the stable update.json panics.
    let fake = Fake::with(vec![(API_RELEASES, limited)]);
    let limit = RateLimit::default();
    let now = chrono::Utc::now();
    let error = run(check_channel(&fake, Preference::GitHub, Channel::Beta, &limit, now)).err().unwrap();
    assert!(error.starts_with(checker::QUOTA_EXHAUSTED), "{error}");
    assert!(error.contains("Beta"), "the detail names the channel: {error}");
    assert_eq!(fake.urls(), [API_RELEASES], "the fallback manifest is never requested");
    fake.done();
    let app_error = check_error(error.clone());
    assert_eq!((app_error.code.as_str(), app_error.detail.as_deref()), ("update.rateLimited", Some(error.as_str())));

    // The cooldown set by that answer also fails as rate limited without contacting GitHub.
    let quiet = Fake::default();
    let again = run(check_channel(&quiet, Preference::GitHub, Channel::Beta, &limit, now)).err().unwrap();
    assert!(again.starts_with(checker::QUOTA_EXHAUSTED), "{again}");
    assert!(quiet.urls().is_empty(), "the active cooldown needs no request: {:?}", quiet.urls());
}

#[test]
fn retry_after_never_overflows_and_follows_hsr_bounds() {
    let now = chrono::Utc::now();
    let wait = |retry_after: &str| {
        let response = Response {
            status: 429,
            location: None,
            retry_after: Some(retry_after.to_owned()),
            rate_remaining: None,
            rate_reset: None,
            content_length: None,
            body: futures_util::stream::empty().boxed(),
        };
        super::checker::rate_limited_until(&response, now).unwrap() - now
    };
    let minutes = |value: i64| chrono::Duration::minutes(value);
    assert_eq!(wait("120"), minutes(2));
    assert_eq!(wait("8640000"), minutes(24 * 60), "capped at a day");
    assert_eq!(wait("100000000000000000"), minutes(1), "too large to parse: the one-minute default, no panic");
    assert_eq!(wait("-9000000000000"), minutes(1), "negative: ignored, no panic");
    assert_eq!(wait("soon"), minutes(1));
    let date = (now + minutes(3)).to_rfc2822();
    let dated = wait(&date);
    assert!(dated > minutes(2) && dated <= minutes(3), "an HTTP date is honoured: {dated:?}");
    let reset = Response {
        status: 403,
        location: None,
        retry_after: None,
        rate_remaining: Some("0".into()),
        rate_reset: Some(i64::MAX.to_string()),
        content_length: None,
        body: futures_util::stream::empty().boxed(),
    };
    assert_eq!(super::checker::rate_limited_until(&reset, now).unwrap() - now, minutes(1), "an out-of-range reset is ignored");
}

#[test]
fn github_requests_use_the_pinned_api_version() {
    assert_eq!(
        request_headers(true),
        [("Accept", "application/vnd.github+json"), ("X-GitHub-Api-Version", "2026-03-10")]
    );
    assert_eq!(request_headers(false), [("Accept", "application/json")]);
}

#[test]
fn transport_errors_never_contain_the_requested_url() {
    let dir = crate::instances::StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/update-tests").join(uuid::Uuid::new_v4().to_string()),
    )
    .unwrap();
    let state = LauncherState::test_fixture(dir.path().join("profile"), Default::default(), crate::storage::test_client());
    let transport = HttpTransport::new(&state).unwrap();
    // https_only rejects this before connecting; reqwest's own text would name the URL.
    let error = run(transport.send(Request { url: "http://127.0.0.1:9/x?sig=SECRET".into(), api: false })).err().unwrap();
    drop(state);
    assert_eq!(error, "无法连接更新服务器");
}

#[test]
fn the_mirror_manifest_must_carry_the_tag_picked_from_its_list() {
    let fake = Fake::with(vec![
        (GITEE_RELEASES, ok(gitee_list("v0.7.0"))),
        (&gitee_manifest_url("v0.7.0"), ok(release_json("v0.8.0", SHA, 5))),
    ]);
    let error = run(check(&fake, Preference::Gitee, &RateLimit::default(), chrono::Utc::now())).err().unwrap();
    assert_eq!(error, "发布标签与跳转链不一致");
}

#[test]
fn a_second_answer_inside_the_window_is_still_compared() {
    // Gitee answers 600 ms after GitHub, inside the one-second window, with
    // different bytes for the same version: the check must see it and refuse.
    let fake = Fake::with(vec![
        (API_LATEST, delayed(ok(release_json("v0.7.0", SHA, 5)), 50)),
        (GITEE_RELEASES, delayed(ok(gitee_list("v0.7.0")), 650)),
        (&gitee_manifest_url("v0.7.0"), ok(release_json("v0.7.0", OTHER_SHA, 5))),
    ]);
    let result = run(check(&fake, Preference::Auto, &RateLimit::default(), chrono::Utc::now()));
    assert!(result.is_err(), "{result:?}");
}

#[test]
fn auto_starts_both_sources_before_either_answers_and_waits_at_most_a_second() {
    let fake = Fake::with(vec![
        (API_LATEST, delayed(ok(release_json("v0.7.0", SHA, 5)), 50)),
        (GITEE_RELEASES, delayed(ok(gitee_list("v0.7.0")), 3000)),
    ]);
    let started = Instant::now();
    let release = run(check(&fake, Preference::Auto, &RateLimit::default(), chrono::Utc::now())).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(release.source, Source::GitHub);
    // GitHub answers at 50 ms; the window then lasts one second (sleeps never fire early).
    assert!(
        elapsed >= Duration::from_millis(1000) && elapsed < Duration::from_millis(1800),
        "the slow mirror got exactly the one-second window: {elapsed:?}"
    );
    let seen = fake.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "{seen:?}");
    assert!(seen[1].2.duration_since(seen[0].2) < Duration::from_millis(40), "both requests left before the first answer");
}

#[test]
fn a_single_source_preference_never_contacts_the_other_host() {
    let github = Fake::with(vec![(API_LATEST, ok(release_json("v0.7.0", SHA, 5)))]);
    run(check(&github, Preference::GitHub, &RateLimit::default(), chrono::Utc::now())).unwrap();
    assert_eq!(github.urls(), [API_LATEST]);
    let gitee = Fake::with(vec![(GITEE_RELEASES, ok(gitee_list("v0.7.0"))), (&gitee_manifest_url("v0.7.0"), ok(release_json("v0.7.0", SHA, 5)))]);
    let release = run(check(&gitee, Preference::Gitee, &RateLimit::default(), chrono::Utc::now())).unwrap();
    assert_eq!(release.source, Source::Gitee);
    assert_eq!(release.notes.as_deref(), Some("notes v0.7.0"), "the manifest's own body wins when present");
    assert!(gitee.urls().iter().all(|url| url.starts_with("https://gitee.com/")));
    gitee.done();
}

fn release(version: (u64, u64, u64), sha: &str, size: u64, source: Source) -> Release {
    let semver = SemVer::stable(version);
    let tag = format!("v{}", semver.display());
    Release {
        version: semver,
        tag: tag.clone(),
        source,
        notes: None,
        package: Some(Package { version: semver, tag, file_name: installer_name_for(semver), size, sha256: sha.into(), source }),
    }
}

#[test]
fn selection_prefers_higher_versions_and_refuses_disagreeing_installers() {
    let a = release((0, 7, 0), SHA, 5, Source::GitHub);
    let b = release((0, 7, 1), SHA, 5, Source::Gitee);
    assert_eq!(select(Ok(a.clone()), Some(Ok(b.clone()))).unwrap().version, SemVer::stable((0, 7, 1)));
    assert_eq!(select(Ok(b.clone()), Some(Ok(a.clone()))).unwrap().version, SemVer::stable((0, 7, 1)));
    assert!(select(Ok(a.clone()), Some(Ok(release((0, 7, 0), OTHER_SHA, 5, Source::Gitee)))).is_err());
    assert!(select(Ok(a.clone()), Some(Ok(release((0, 7, 0), SHA, 6, Source::Gitee)))).is_err());
    assert_eq!(select(Ok(a.clone()), Some(Ok(release((0, 7, 0), SHA, 5, Source::Gitee)))).unwrap().source, Source::GitHub);
    assert_eq!(select(Err("down".into()), Some(Ok(b.clone()))).unwrap().source, Source::Gitee);
    assert_eq!(select(Ok(a.clone()), Some(Err("down".into()))).unwrap().source, Source::GitHub);
    assert_eq!(select(Err("first".into()), Some(Err("second".into()))).err().unwrap(), "first");
}

#[test]
fn auto_refuses_when_the_sources_disagree_on_the_same_version() {
    let fake = Fake::with(vec![
        (API_LATEST, ok(release_json("v0.7.0", SHA, 5))),
        (GITEE_RELEASES, ok(gitee_list("v0.7.0"))),
        (&gitee_manifest_url("v0.7.0"), ok(release_json("v0.7.0", OTHER_SHA, 5))),
    ]);
    let result = run(check(&fake, Preference::Auto, &RateLimit::default(), chrono::Utc::now()));
    assert!(result.is_err(), "{result:?}");
}

#[test]
fn only_a_strictly_higher_version_than_current_and_highest_seen_is_offered() {
    let at = |version| release(version, SHA, 5, Source::GitHub);
    assert_eq!(classify(&at((0, 7, 0)), (0, 6, 0), None), Offer::Newer);
    assert_eq!(classify(&at((0, 6, 0)), (0, 6, 0), None), Offer::Current);
    assert_eq!(classify(&at((0, 5, 9)), (0, 6, 0), None), Offer::Current);
    assert_eq!(classify(&at((0, 7, 0)), (0, 6, 0), Some((0, 7, 1))), Offer::Stale);
    assert_eq!(classify(&at((0, 7, 1)), (0, 6, 0), Some((0, 7, 1))), Offer::Newer);
}

#[test]
fn a_check_records_the_highest_version_seen_and_flags_a_frozen_source() {
    let dir = crate::instances::StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/update-tests").join(uuid::Uuid::new_v4().to_string()),
    )
    .unwrap();
    let mut data = crate::models::Persisted::default();
    data.config.update_source = "github".into();
    let state = LauncherState::test_fixture(dir.path().join("profile"), data, crate::storage::test_client());
    let service = UpdateService::default();
    let newer = Fake::with(vec![(API_LATEST, ok(release_json("v99.0.0", SHA, 5)))]);
    let view = run(check_with(&state, &service, &newer, chrono::Utc::now())).unwrap();
    assert_eq!((view.status, view.latest_version.as_str()), ("newer", "99.0.0"));
    assert_eq!(state.snapshot().unwrap().update_highest_seen.as_deref(), Some("99.0.0"));
    let frozen = Fake::with(vec![(API_LATEST, ok(release_json("v98.0.0", SHA, 5)))]);
    let view = run(check_with(&state, &service, &frozen, chrono::Utc::now())).unwrap();
    assert_eq!(view.status, "stale");
    assert_eq!(state.snapshot().unwrap().update_highest_seen.as_deref(), Some("99.0.0"), "a lower answer never lowers it");
    let on_disk = std::fs::read_to_string(dir.path().join("profile/state.json")).unwrap();
    assert!(on_disk.contains("\"updateHighestSeen\": \"99.0.0\""), "{on_disk}");
    drop(state);
}

#[test]
fn the_general_save_and_preset_import_keep_the_update_preferences() {
    let dir = crate::instances::StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/update-tests").join(uuid::Uuid::new_v4().to_string()),
    )
    .unwrap();
    let state = LauncherState::test_fixture(dir.path().join("profile"), Default::default(), crate::storage::test_client());
    let mut config = state.snapshot().unwrap().config;
    config.game_directory = dir.path().join("game").to_string_lossy().into_owned();
    for (source, channel, check) in [("mirror", "beta", false), ("gitee", "beta", false)] {
        config.update_source = source.into();
        config.update_channel = channel.into();
        config.check_for_updates = check;
        let saved = crate::commands::save_config_inner(&state, config.clone()).unwrap();
        assert_eq!(
            (saved.update_source.as_str(), saved.update_channel.as_str(), saved.check_for_updates),
            ("auto", "stable", true),
            "{source}"
        );
    }
    let service = UpdateService::default();
    let saved = set_preferences_with(&state, &service, false, "gitee", Some("beta")).unwrap();
    assert_eq!((saved.update_source.as_str(), saved.update_channel.as_str(), saved.check_for_updates), ("gitee", "beta", false));
    drop(state);
}

#[test]
fn update_settings_default_to_auto_and_a_startup_check() {
    let config = crate::models::Config::default();
    assert!(config.check_for_updates);
    assert_eq!(config.update_source, "auto");
    assert_eq!(config.update_channel, "stable");
    let old: crate::models::Config = serde_json::from_str("{}").unwrap();
    assert!(
        old.check_for_updates && old.update_source == "auto" && old.update_channel == "stable",
        "older state files get the defaults"
    );
    assert!(Preference::parse("auto").is_some() && Preference::parse("github").is_some() && Preference::parse("gitee").is_some());
    assert!(Preference::parse("mirror").is_none());
    assert!(Channel::parse("stable").is_some() && Channel::parse("beta").is_some());
    assert!(Channel::parse("nightly").is_none());
}

// ---- C4b: the verified download ----

const BYTES: &[u8] = b"voxelight installer fixture bytes";

fn sha_of(bytes: &[u8]) -> String {
    use sha2::Digest;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

fn package_of(bytes: &[u8], source: Source) -> Package {
    Package {
        version: SemVer::stable((0, 7, 0)),
        tag: "v0.7.0".into(),
        file_name: installer_name((0, 7, 0)),
        size: bytes.len() as u64,
        sha256: sha_of(bytes),
        source,
    }
}

fn file_on(source: Source) -> String {
    super::sources::file_url(source, "v0.7.0", &installer_name((0, 7, 0)))
}

fn body(bytes: &[u8]) -> Reply {
    Reply { body: bytes.to_vec(), ..status(200) }
}

struct Root(crate::instances::StagingDirectory);

impl Root {
    fn new() -> Self {
        Self(
            crate::instances::StagingDirectory::create(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("target/update-download-tests")
                    .join(uuid::Uuid::new_v4().to_string()),
            )
            .unwrap(),
        )
    }
    fn path(&self) -> &std::path::Path {
        self.0.path()
    }
    /// Staging directories left under the root.
    fn leftovers(&self) -> Vec<String> {
        std::fs::read_dir(self.path()).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()
    }
}

fn fetch(fake: &Fake, package: &Package, preference: Preference, root: &Root) -> Result<super::download::StagedUpdate, String> {
    run(super::download::download(fake, package, preference, root.path(), &|_, _| {}, &|| false))
}

#[test]
fn a_verified_download_is_committed_and_held_against_writers() {
    let root = Root::new();
    let package = package_of(BYTES, Source::GitHub);
    let fake = Fake::with(vec![(&file_on(Source::GitHub), body(BYTES))]);
    let mut staged = fetch(&fake, &package, Preference::Auto, &root).unwrap();
    assert_eq!(std::fs::read(&staged.installer).unwrap(), BYTES);
    assert_eq!(staged.installer.file_name().unwrap(), "VoxelightLauncher-0.7.0-x64-setup.exe");
    assert!(!staged.directory.join("download.bin").exists(), "the part was committed under its final name");
    let name = staged.directory.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.len() == 32 && name.bytes().all(|byte| byte.is_ascii_hexdigit()), "{name}");
    #[cfg(windows)]
    assert!(std::fs::OpenOptions::new().write(true).open(&staged.installer).is_err(), "writers are denied while staged");
    staged.verify().unwrap();
    let expected = staged.package.sha256.clone();
    staged.package.sha256 = sha_of(b"something else");
    assert!(staged.verify().is_err(), "the held file is hashed again before use");
    staged.package.sha256 = expected;
    drop(staged);
    assert!(root.leftovers().is_empty(), "dropping the staged update removes its files");
    fake.done();
}

#[test]
fn integrity_failures_leave_nothing_and_never_try_the_other_source() {
    let package = package_of(BYTES, Source::GitHub);
    let mut longer = BYTES.to_vec();
    longer.push(b'!');
    let mut tampered = BYTES.to_vec();
    tampered[0] ^= 1;
    // Each case names the check that must catch it, not a later safety net.
    let cases = [
        ("truncated", Reply { length: Some(Some(BYTES.len() as u64)), ..body(&BYTES[..10]) }, "安装包的大小或 SHA-256 校验失败"),
        ("overlong without a length", Reply { length: Some(None), ..body(&longer) }, "安装包超过发布信息中的大小"),
        ("declared length differs", body(&longer), "安装包大小与发布信息不一致"),
        ("hash mismatch", body(&tampered), "安装包的大小或 SHA-256 校验失败"),
    ];
    for (case, reply, expected) in cases {
        let root = Root::new();
        // Auto would allow Gitee after a transport failure; the fake panics if it is contacted.
        let fake = Fake::with(vec![(&file_on(Source::GitHub), reply)]);
        let result = fetch(&fake, &package, Preference::Auto, &root);
        assert_eq!(result.err().as_deref(), Some(expected), "{case}");
        assert!(root.leftovers().is_empty(), "{case}: {:?}", root.leftovers());
        assert_eq!(fake.urls(), [file_on(Source::GitHub)], "{case}");
    }
}

#[test]
fn a_transport_failure_tries_the_other_source_only_in_auto() {
    let package = package_of(BYTES, Source::GitHub);
    let root = Root::new();
    let gitee = file_on(Source::Gitee);
    let attach = format!("https://gitee.com/liangyun_Liu/Voxelight_Launcher/attach_files/7/download/{}", package.file_name);
    let cdn = format!("https://foruda.gitee.com/attach_file/7/{}?token=t", package.file_name);
    let fake = Fake::with(vec![
        (&file_on(Source::GitHub), status(503)),
        (&gitee, moved(&attach)),
        (&attach, moved(&cdn)),
        (&cdn, body(BYTES)),
    ]);
    let staged = fetch(&fake, &package, Preference::Auto, &root).unwrap();
    assert_eq!(std::fs::read(&staged.installer).unwrap(), BYTES);
    fake.done();
    drop(staged);

    let only = Fake::with(vec![(&file_on(Source::GitHub), status(503))]);
    assert!(fetch(&only, &package, Preference::GitHub, &root).is_err(), "a single-source preference never falls back");
    assert!(root.leftovers().is_empty());
}

fn chunked(parts: Vec<(u64, Result<Vec<u8>, FetchError>)>) -> Reply {
    Reply { chunks: Some(parts), length: Some(Some(BYTES.len() as u64)), ..status(200) }
}

fn short_limits() -> super::download::Limits {
    super::download::Limits { idle: Duration::from_millis(300), total: Duration::from_secs(5) }
}

fn fetch_limited(fake: &Fake, package: &Package, preference: Preference, root: &Root, cancelled: &(dyn Fn() -> bool + Sync)) -> Result<super::download::StagedUpdate, String> {
    run(super::download::download_with_limits(fake, package, preference, root.path(), short_limits(), &|_, _| {}, cancelled))
}

#[test]
fn a_body_that_ends_early_is_an_integrity_failure_but_a_reset_tries_the_other_source() {
    let package = package_of(BYTES, Source::GitHub);
    let root = Root::new();
    let ended = Fake::with(vec![(&file_on(Source::GitHub), chunked(vec![
        (0, Ok(BYTES[..10].to_vec())),
        (0, Err(FetchError::Invalid(RESPONSE_ENDED.into()))),
    ]))]);
    assert_eq!(fetch(&ended, &package, Preference::Auto, &root).err().as_deref(), Some(RESPONSE_ENDED));
    assert_eq!(ended.urls().len(), 1, "an early end never tries the other source");

    let gitee = file_on(Source::Gitee);
    let attach = format!("https://gitee.com/liangyun_Liu/Voxelight_Launcher/attach_files/7/download/{}", package.file_name);
    let cdn = format!("https://foruda.gitee.com/attach_file/7/{}", package.file_name);
    let reset = Fake::with(vec![
        (&file_on(Source::GitHub), chunked(vec![(0, Ok(BYTES[..10].to_vec())), (0, Err(FetchError::Transport("reset".into())))])),
        (&gitee, moved(&attach)),
        (&attach, moved(&cdn)),
        (&cdn, body(BYTES)),
    ]);
    let staged = fetch(&reset, &package, Preference::Auto, &root).unwrap();
    assert_eq!(std::fs::read(&staged.installer).unwrap(), BYTES);
    reset.done();
}

#[test]
fn a_stalled_read_times_out_and_counts_as_a_transport_failure() {
    let package = package_of(BYTES, Source::GitHub);
    let root = Root::new();
    let stalled = Fake::with(vec![(&file_on(Source::GitHub), chunked(vec![(0, Ok(BYTES[..5].to_vec())), (60_000, Ok(BYTES[5..].to_vec()))]))]);
    let started = Instant::now();
    let result = fetch_limited(&stalled, &package, Preference::GitHub, &root, &|| false);
    assert_eq!(result.err().as_deref(), Some("更新下载超时"));
    assert!(started.elapsed() < Duration::from_secs(3), "the idle limit ended the wait: {:?}", started.elapsed());
    assert!(root.leftovers().is_empty());
}

#[test]
fn the_total_limit_bounds_a_slow_but_steady_download() {
    let package = package_of(BYTES, Source::GitHub);
    let root = Root::new();
    // Every part arrives inside the idle limit, but the whole takes too long.
    let parts = BYTES.chunks(2).map(|part| (200, Ok(part.to_vec()))).collect();
    let slow = Fake::with(vec![(&file_on(Source::GitHub), chunked(parts))]);
    let limits = super::download::Limits { idle: Duration::from_millis(500), total: Duration::from_millis(800) };
    let result = run(super::download::download_with_limits(&slow, &package, Preference::GitHub, root.path(), limits, &|_, _| {}, &|| false));
    assert_eq!(result.err().as_deref(), Some("更新下载超时"));
    assert!(root.leftovers().is_empty());
}

#[test]
fn cancel_interrupts_a_stalled_read_and_never_tries_the_other_source() {
    let package = package_of(BYTES, Source::GitHub);
    let root = Root::new();
    // The read stalls longer than the idle limit, so only Cancel can end it early.
    let stalled = Fake::with(vec![(&file_on(Source::GitHub), chunked(vec![(0, Ok(BYTES[..5].to_vec())), (60_000, Ok(BYTES[5..].to_vec()))]))]);
    let started = Instant::now();
    let limits = super::download::Limits { idle: Duration::from_secs(30), total: Duration::from_secs(60) };
    let cancelled = || started.elapsed() > Duration::from_millis(200);
    let result = run(super::download::download_with_limits(&stalled, &package, Preference::Auto, root.path(), limits, &|_, _| {}, &cancelled));
    assert_eq!(result.err().as_deref(), Some(crate::downloads::CANCELLED));
    assert!(started.elapsed() < Duration::from_secs(3), "Cancel interrupted the read: {:?}", started.elapsed());
    assert_eq!(stalled.urls(), [file_on(Source::GitHub)], "no other source after a cancel");
    assert!(root.leftovers().is_empty());
}

#[test]
fn a_cancel_after_the_last_byte_still_stops_before_the_commit() {
    let package = package_of(BYTES, Source::GitHub);
    let root = Root::new();
    let fake = Fake::with(vec![(&file_on(Source::GitHub), body(BYTES))]);
    let seen = std::sync::atomic::AtomicBool::new(false);
    // Cancel turns true once the whole body was reported.
    let progress = |done: u64, total: u64| {
        if done == total {
            seen.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    };
    let cancelled = || seen.load(std::sync::atomic::Ordering::SeqCst);
    let result = run(super::download::download_with_limits(&fake, &package, Preference::Auto, root.path(), super::download::LIMITS, &progress, &cancelled));
    assert_eq!(result.err().as_deref(), Some(crate::downloads::CANCELLED));
    assert!(root.leftovers().is_empty());
}

#[test]
fn body_errors_are_classified_by_their_cause() {
    #[derive(Debug)]
    struct Wrapper(std::io::Error);
    impl std::fmt::Display for Wrapper {
        fn fmt(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("wrapped")
        }
    }
    impl std::error::Error for Wrapper {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&self.0)
        }
    }
    let ended = Wrapper(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "early eof"));
    assert_eq!(stream_error(&ended), FetchError::Invalid(RESPONSE_ENDED.into()));
    let reset = Wrapper(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "reset"));
    assert_eq!(stream_error(&reset), FetchError::Transport("更新数据传输中断".into()));
}

#[test]
fn an_untrusted_redirect_is_an_integrity_failure() {
    let package = package_of(BYTES, Source::GitHub);
    let root = Root::new();
    let fake = Fake::with(vec![(&file_on(Source::GitHub), moved("https://evil.example/x.exe"))]);
    assert!(fetch(&fake, &package, Preference::Auto, &root).is_err());
    assert_eq!(fake.urls().len(), 1, "no fallback after an untrusted redirect");
}

#[test]
fn cancelling_removes_the_part_and_the_staging_directory() {
    let package = package_of(BYTES, Source::GitHub);
    let root = Root::new();
    let fake = Fake::with(vec![(&file_on(Source::GitHub), body(BYTES))]);
    let result = run(super::download::download(&fake, &package, Preference::Auto, root.path(), &|_, _| {}, &|| true));
    assert_eq!(result.err().as_deref(), Some(crate::downloads::CANCELLED));
    assert!(root.leftovers().is_empty());
}

#[test]
fn the_final_commit_never_replaces_an_existing_file() {
    let root = Root::new();
    let target = root.path().join("installer.exe");
    std::fs::write(&target, b"existing").unwrap();
    let part_path = root.path().join("download.bin");
    let mut part = crate::download_io::DownloadPart::create(part_path.clone()).unwrap();
    run(async { tokio::io::AsyncWriteExt::write_all(part.file(), b"new").await }).unwrap();
    assert!(part.publish_new(&target).is_err());
    assert_eq!(std::fs::read(&target).unwrap(), b"existing", "H08: the existing file is untouched");
    assert!(!part_path.exists(), "the refused part is removed");
}

#[cfg(windows)]
#[test]
fn staging_refuses_a_junctioned_root() {
    let root = Root::new();
    let real = root.path().join("real");
    std::fs::create_dir(&real).unwrap();
    let alias = root.path().join("alias");
    let output = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(alias.to_string_lossy().replace('/', r"\"))
        .arg(real.to_string_lossy().replace('/', r"\"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let package = package_of(BYTES, Source::GitHub);
    let result = run(super::download::download(&Fake::default(), &package, Preference::Auto, &alias.join("updates"), &|_, _| {}, &|| false));
    let _ = std::fs::remove_dir(&alias);
    assert!(result.is_err());
    assert!(std::fs::read_dir(&real).unwrap().next().is_none(), "nothing was written through the junction");
}

#[test]
fn digests_compare_exactly_and_locations_follow_the_preference() {
    use super::download::{digest_equals, locations};
    use sha2::Digest;
    let digest = sha2::Sha256::digest(BYTES);
    assert!(digest_equals(&digest, &sha_of(BYTES)));
    assert!(!digest_equals(&digest, &sha_of(b"other")));
    assert!(!digest_equals(&digest, &sha_of(BYTES)[..63]));
    let gitee = package_of(BYTES, Source::Gitee);
    assert_eq!(locations(&gitee, Preference::Auto), [(Source::Gitee, file_on(Source::Gitee)), (Source::GitHub, file_on(Source::GitHub))]);
    assert_eq!(locations(&gitee, Preference::Gitee), [(Source::Gitee, file_on(Source::Gitee))]);
}

#[test]
fn the_download_uses_only_the_offered_package_and_reuses_a_staged_one() {
    let dir = crate::instances::StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/update-tests").join(uuid::Uuid::new_v4().to_string()),
    )
    .unwrap();
    let mut data = crate::models::Persisted::default();
    data.config.update_source = "github".into();
    let state = LauncherState::test_fixture(dir.path().join("profile"), data, crate::storage::test_client());
    let service = UpdateService::default();
    let root = Root::new();
    let none = run(download_with(&state, &service, &Fake::default(), root.path(), &|_, _| {}));
    assert_eq!(none.err().as_deref(), Some("没有可下载的更新，请先检查更新"));
    // A check that finds a version not newer than the running build offers nothing to download.
    let not_newer = if current_is_prerelease() {
        let (major, minor, patch) = current_version();
        if patch > 0 {
            display_version((major, minor, patch - 1))
        } else if minor > 0 {
            display_version((major, minor - 1, 0))
        } else {
            display_version((major.saturating_sub(1), 0, 0))
        }
    } else {
        display_version(current_version())
    };
    let same = Fake::with(vec![(API_LATEST, ok(release_json(&format!("v{not_newer}"), &sha_of(BYTES), BYTES.len() as u64)))]);
    run(check_with(&state, &service, &same, chrono::Utc::now())).unwrap();
    let none = run(download_with(&state, &service, &Fake::default(), root.path(), &|_, _| {}));
    assert_eq!(none.err().as_deref(), Some("没有可下载的更新，请先检查更新"));
    let mut json = release_json("v99.0.0", &sha_of(BYTES), BYTES.len() as u64);
    json["assets"][0]["name"] = json!(installer_name((99, 0, 0)));
    run(check_with(&state, &service, &Fake::with(vec![(API_LATEST, ok(json))]), chrono::Utc::now())).unwrap();
    let url = super::sources::file_url(Source::GitHub, "v99.0.0", &installer_name((99, 0, 0)));
    let fake = Fake::with(vec![(&url, body(BYTES))]);
    let first = run(download_with(&state, &service, &fake, root.path(), &|_, _| {})).unwrap();
    let again = run(download_with(&state, &service, &fake, root.path(), &|_, _| {})).unwrap();
    assert_eq!(first, again);
    assert_eq!(fake.urls().len(), 1, "an already staged package is reused");

    // An Auto re-check answered by the other source offers the same bytes: still reused.
    if let Ok(mut offered) = service.offered.lock() {
        if let Some((package, ..)) = offered.as_mut() {
            package.source = Source::Gitee;
        }
    }
    run(download_with(&state, &service, &Fake::default(), root.path(), &|_, _| {})).unwrap();

    // A late cancel while idle never stops the next download.
    request_cancel(&service);
    assert_eq!(service.download_state.load(std::sync::atomic::Ordering::SeqCst), IDLE);

    // A source changed after the check (by any writer) requires a new check; nothing is contacted.
    set_source(&state, "gitee");
    let changed = run(download_with(&state, &service, &Fake::default(), root.path(), &|_, _| {}));
    assert_eq!(changed.err().as_deref(), Some("更新来源已更改，请重新检查更新"));
    assert_eq!(service.download_state.load(std::sync::atomic::Ordering::SeqCst), IDLE, "the in-progress state is cleared");
    drop(service);
    assert!(root.leftovers().is_empty());
    drop(state);
}

fn preference_fixture(source: &str) -> (crate::instances::StagingDirectory, LauncherState) {
    let dir = crate::instances::StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/update-tests").join(uuid::Uuid::new_v4().to_string()),
    )
    .unwrap();
    let mut data = crate::models::Persisted::default();
    data.config.update_source = source.into();
    data.config.game_directory = dir.path().join("game").to_string_lossy().into_owned();
    let state = LauncherState::test_fixture(dir.path().join("profile"), data, crate::storage::test_client());
    (dir, state)
}

fn newer_release() -> serde_json::Value {
    let mut json = release_json("v99.0.0", &sha_of(BYTES), BYTES.len() as u64);
    json["assets"][0]["name"] = json!(installer_name((99, 0, 0)));
    json
}

#[test]
fn the_state_reports_the_last_check_for_the_saved_source_and_the_download_phase() {
    let (_dir, state) = preference_fixture("github");
    let service = UpdateService::default();
    let servers = crate::server_manager::ServerRegistry::default();
    let empty = state_with(&state, &service, &servers).unwrap();
    assert_eq!(empty.current_version, current_version_string());
    assert_eq!((empty.check, empty.download, empty.staged), (None, "idle", None));

    let view = run(check_with(&state, &service, &Fake::with(vec![(API_LATEST, ok(newer_release()))]), chrono::Utc::now())).unwrap();
    assert_eq!(state_with(&state, &service, &servers).unwrap().check, Some(view.clone()));
    for (phase, name) in [(RUNNING, "downloading"), (CANCELLING, "cancelling"), (INSTALLING, "installing"), (IDLE, "idle")] {
        service.download_state.store(phase, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(state_with(&state, &service, &servers).unwrap().download, name);
    }

    // A source saved another way hides a check made with the old one.
    set_source(&state, "gitee");
    assert_eq!(state_with(&state, &service, &servers).unwrap().check, None);

    // A check that fails clears the previous result (HSR clears it when a check starts).
    set_source(&state, "github");
    assert_eq!(state_with(&state, &service, &servers).unwrap().check, Some(view));
    let failed = run(check_with(&state, &service, &Fake::with(vec![(API_LATEST, status(500))]), chrono::Utc::now()));
    assert!(failed.is_err());
    assert_eq!(state_with(&state, &service, &servers).unwrap().check, None);
    assert!(service.offered.lock().unwrap().is_none(), "a failed check leaves nothing to download");
    drop(state);
}

#[test]
fn the_state_lists_a_staged_installer() {
    let (_dir, state) = preference_fixture("github");
    let service = UpdateService::default();
    let servers = crate::server_manager::ServerRegistry::default();
    let root = Root::new();
    run(check_with(&state, &service, &Fake::with(vec![(API_LATEST, ok(newer_release()))]), chrono::Utc::now())).unwrap();
    let url = super::sources::file_url(Source::GitHub, "v99.0.0", &installer_name((99, 0, 0)));
    let staged = run(download_with(&state, &service, &Fake::with(vec![(&url, body(BYTES))]), root.path(), &|_, _| {})).unwrap();
    assert_eq!(state_with(&state, &service, &servers).unwrap().staged, Some(staged));
    // While a download holds the slot the state reports the phase, not a stale file.
    let slot = run(async { service.staged.lock().await });
    assert_eq!(state_with(&state, &service, &servers).unwrap().staged, None);
    drop(slot);
    drop(service);
    assert!(root.leftovers().is_empty());
    drop(state);
}

#[test]
fn update_preferences_save_at_once_and_a_new_source_clears_the_check() {
    let (_dir, state) = preference_fixture("github");
    let service = UpdateService::default();
    let servers = crate::server_manager::ServerRegistry::default();
    let invalid = set_preferences_with(&state, &service, true, "sourceforge", None).err().map(|error| error.code);
    assert_eq!(invalid.as_deref(), Some("update.sourceInvalid"));
    let invalid_channel = set_preferences_with(&state, &service, true, "github", Some("nightly")).err().map(|error| error.code);
    assert_eq!(invalid_channel.as_deref(), Some("update.channelInvalid"));

    run(check_with(&state, &service, &Fake::with(vec![(API_LATEST, ok(newer_release()))]), chrono::Utc::now())).unwrap();
    // The toggle alone keeps the result.
    let config = set_preferences_with(&state, &service, false, "github", None).unwrap();
    assert!(!config.check_for_updates);
    assert!(!state.snapshot().unwrap().config.check_for_updates, "saved, not only returned");
    assert!(service.offered.lock().unwrap().is_some());
    assert!(state_with(&state, &service, &servers).unwrap().check.is_some());

    // While a download runs (or the install holds the service) neither source nor channel can change; the toggle can.
    for phase in [RUNNING, CANCELLING, INSTALLING] {
        service.download_state.store(phase, std::sync::atomic::Ordering::SeqCst);
        let refused = set_preferences_with(&state, &service, true, "gitee", None).err().map(|error| error.code);
        assert_eq!(refused.as_deref(), Some("update.downloading"));
        let refused_ch = set_preferences_with(&state, &service, true, "github", Some("beta")).err().map(|error| error.code);
        assert_eq!(refused_ch.as_deref(), Some("update.downloading"));
        assert_eq!(state.snapshot().unwrap().config.update_source, "github");
        assert_eq!(state.snapshot().unwrap().config.update_channel, "stable");
        set_preferences_with(&state, &service, true, "github", Some("stable")).unwrap();
    }
    service.download_state.store(IDLE, std::sync::atomic::Ordering::SeqCst);

    let config = set_preferences_with(&state, &service, true, "gitee", Some("beta")).unwrap();
    assert_eq!((config.check_for_updates, config.update_source.as_str(), config.update_channel.as_str()), (true, "gitee", "beta"));
    assert!(service.offered.lock().unwrap().is_none(), "the next download needs a check with the new source/channel");
    assert_eq!(state_with(&state, &service, &servers).unwrap().check, None);
    drop(state);
}

#[test]
fn a_source_change_while_the_download_waits_for_the_slot_is_refused() {
    let (_dir, state) = preference_fixture("github");
    let service = UpdateService::default();
    let root = Root::new();
    run(check_with(&state, &service, &Fake::with(vec![(API_LATEST, ok(newer_release()))]), chrono::Utc::now())).unwrap();
    let fake = Fake::default();
    run(async {
        let slot = service.staged.lock().await;
        let download = download_with(&state, &service, &fake, root.path(), &|_, _| {});
        let change = async {
            // The download has claimed RUNNING and waits for the slot; the source changes meanwhile.
            tokio::time::sleep(Duration::from_millis(50)).await;
            set_source(&state, "gitee");
            drop(slot);
        };
        let (result, ()) = futures_util::future::join(download, change).await;
        assert_eq!(result.err().as_deref(), Some(SOURCE_CHANGED));
    });
    assert_eq!(service.download_state.load(std::sync::atomic::Ordering::SeqCst), IDLE);
    drop(service);
    assert!(root.leftovers().is_empty());
    drop(state);
}

#[test]
fn update_errors_reach_the_renderer_as_stable_codes() {
    let code = |error: crate::errors::AppError| (error.code, error.detail);
    let quota = format!("{} （12:00 后恢复），改读更新信息也失败：x", super::checker::QUOTA_EXHAUSTED);
    assert_eq!(code(check_error(quota.clone())), ("update.rateLimited".into(), Some(quota)));
    let late = format!("Gitee {}", super::checker::TIMED_OUT);
    assert_eq!(code(check_error(late.clone())), ("update.timedOut".into(), Some(late)));
    assert_eq!(code(check_error("Gitee 更新检查失败（HTTP 500）".into())).0, "update.checkFailed");
    assert_eq!(code(check_error("proxy.tlsInheritance".into())).0, "proxy.tlsInheritance", "network codes pass through");
    for (detail, expected) in [
        (crate::downloads::CANCELLED, "update.cancelled"),
        (SOURCE_CHANGED, "update.sourceChanged"),
        (NOT_OFFERED, "update.notOffered"),
        (ALREADY_DOWNLOADING, "update.downloading"),
        ("安装包的大小或 SHA-256 校验失败", "update.downloadFailed"),
    ] {
        let (code, kept) = code(download_error(detail.to_owned()));
        assert_eq!((code.as_str(), kept.as_deref()), (expected, Some(detail)));
    }
}

fn set_source(state: &LauncherState, source: &str) {
    state
        .update(|data| {
            data.config.update_source = source.into();
            Ok(())
        })
        .unwrap();
}

#[test]
fn the_state_names_what_would_refuse_the_install() {
    let (_dir, state) = preference_fixture("github");
    let service = UpdateService::default();
    let servers = crate::server_manager::ServerRegistry::default();
    assert_eq!(state_with(&state, &service, &servers).unwrap().busy, None);
    // The operation lock first, as hold_idle takes it.
    let operation = run(async { state.operation.lock().await });
    assert_eq!(state_with(&state, &service, &servers).unwrap().busy, Some("update.tasksRunning"));
    drop(operation);
    servers.fixture_alive("server");
    assert_eq!(state_with(&state, &service, &servers).unwrap().busy, Some("update.serverRunning"));
    let servers = crate::server_manager::ServerRegistry::default();
    service.download_state.store(RUNNING, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(state_with(&state, &service, &servers).unwrap().busy, Some("update.downloading"));
    service.download_state.store(IDLE, std::sync::atomic::Ordering::SeqCst);
    drop(state);
}

#[test]
fn a_cancel_that_arrives_as_the_download_ends_still_stops_it_and_keeps_the_file() {
    let (_dir, state) = preference_fixture("github");
    let service = UpdateService::default();
    let root = Root::new();
    run(check_with(&state, &service, &Fake::with(vec![(API_LATEST, ok(newer_release()))]), chrono::Utc::now())).unwrap();
    let url = super::sources::file_url(Source::GitHub, "v99.0.0", &installer_name((99, 0, 0)));
    run(download_with(&state, &service, &Fake::with(vec![(&url, body(BYTES))]), root.path(), &|_, _| {})).unwrap();
    // The next call finds the file staged; a cancel lands while it is past every transfer.
    let fake = Fake::default();
    run(async {
        let slot = service.staged.lock().await;
        let download = download_with(&state, &service, &fake, root.path(), &|_, _| {});
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            request_cancel(&service);
            drop(slot);
        };
        let (result, ()) = futures_util::future::join(download, cancel).await;
        assert_eq!(result.err().as_deref(), Some(crate::downloads::CANCELLED));
    });
    assert_eq!(service.download_state.load(std::sync::atomic::Ordering::SeqCst), IDLE);
    let servers = crate::server_manager::ServerRegistry::default();
    assert!(state_with(&state, &service, &servers).unwrap().staged.is_some(), "the verified file stays for the next attempt");
    // Without a cancel the staged file is reused.
    run(download_with(&state, &service, &fake, root.path(), &|_, _| {})).unwrap();
    drop(service);
    assert!(root.leftovers().is_empty());
    drop(state);
}

#[test]
fn beta_channel_supports_semver_prerelease_checks_downloads_and_separate_watermarks() {
    // SemVer 2.0.0 ordering across alpha, beta (numeric), rc, and stable.
    let v_a1 = parse_semver("v0.7.0-alpha.1").unwrap();
    let v_b1 = parse_semver("v0.7.0-beta.1").unwrap();
    let v_b2 = parse_semver("v0.7.0-beta.2").unwrap();
    let v_b10 = parse_semver("v0.7.0-beta.10").unwrap();
    let v_rc1 = parse_semver("v0.7.0-rc.1").unwrap();
    let v_rel = parse_semver("v0.7.0").unwrap();
    assert!(v_a1 < v_b1 && v_b1 < v_b2 && v_b2 < v_b10 && v_b10 < v_rc1 && v_rc1 < v_rel);
    assert_eq!(v_b2.pre, Some((PreReleaseStage::Beta, 2)));
    assert_eq!(installer_name_for(v_b2), "VoxelightLauncher-0.7.0-beta.2-x64-setup.exe");

    // Stable rejects pre-releases; Beta accepts matching prerelease flag and rejects mismatched flag/tag.
    let beta_json = release_json("v99.0.0-beta.2", &sha_of(BYTES), BYTES.len() as u64);
    assert!(parse_release_for_channel(&beta_json, Source::GitHub, None, Channel::Stable).is_err());
    let parsed_beta = parse_release_for_channel(&beta_json, Source::GitHub, None, Channel::Beta).unwrap();
    assert!(parsed_beta.version.is_prerelease());
    assert_eq!(parsed_beta.package.as_ref().unwrap().file_name, "VoxelightLauncher-99.0.0-beta.2-x64-setup.exe");
    assert_eq!(classify_semver(&parsed_beta, parse_semver("99.0.0-beta.1").unwrap(), None), Offer::Newer);
    assert_eq!(classify_semver(&parsed_beta, parse_semver("99.0.0").unwrap(), None), Offer::Current);

    let mut mismatched = beta_json.clone();
    mismatched["prerelease"] = json!(false);
    assert!(parse_release_for_channel(&mismatched, Source::GitHub, None, Channel::Beta).is_err());

    // GitHub Beta picks the highest SemVer across drafts, pre-releases, and stable releases.
    let gh_list = json!([
        {"tag_name": "v99.0.0-beta.1", "draft": false, "prerelease": true, "body": "b1", "assets": []},
        {"tag_name": "v99.1.0-beta.1", "draft": true, "prerelease": true, "body": "draft", "assets": []},
        beta_json.clone(),
        release_json("v98.0.0", &sha_of(BYTES), BYTES.len() as u64)
    ]);
    let picked_gh = pick_github_release(&gh_list, Channel::Beta).unwrap();
    assert_eq!(picked_gh.tag, "v99.0.0-beta.2");

    // Gitee Beta picks the highest pre-release or stable carrying update.json; Stable skips pre-releases.
    let gitee_mixed = json!([
        {"tag_name": "v98.0.0", "prerelease": false, "assets": [{"name": "update.json"}], "body": "stable"},
        {"tag_name": "v99.0.0-beta.2", "prerelease": true, "assets": [{"name": "update.json"}], "body": "beta2"}
    ]);
    assert_eq!(pick_gitee_release_for_channel(&gitee_mixed, Channel::Stable).unwrap().0, "v98.0.0");
    assert_eq!(pick_gitee_release_for_channel(&gitee_mixed, Channel::Beta).unwrap().0, "v99.0.0-beta.2");

    // End-to-end check + download on Beta channel via GitHub API_RELEASES.
    let (_dir, state) = preference_fixture("github");
    let service = UpdateService::default();
    let root = Root::new();
    set_preferences_with(&state, &service, true, "github", Some("beta")).unwrap();
    let fake_beta = Fake::with(vec![(API_RELEASES, ok(gh_list))]);
    let view = run(check_with(&state, &service, &fake_beta, chrono::Utc::now())).unwrap();
    assert_eq!((view.status, view.latest_version.as_str(), view.prerelease), ("newer", "99.0.0-beta.2", true));
    assert_eq!(state.snapshot().unwrap().update_highest_seen, None, "beta pre-release must not pollute stable watermark");
    assert_eq!(state.snapshot().unwrap().update_highest_seen_beta.as_deref(), Some("99.0.0-beta.2"));

    let beta_url = super::sources::file_url(Source::GitHub, "v99.0.0-beta.2", "VoxelightLauncher-99.0.0-beta.2-x64-setup.exe");
    let staged = run(download_with(&state, &service, &Fake::with(vec![(&beta_url, body(BYTES))]), root.path(), &|_, _| {})).unwrap();
    assert_eq!(staged.version, "99.0.0-beta.2");
    assert_eq!(staged.file_name, "VoxelightLauncher-99.0.0-beta.2-x64-setup.exe");

    // A frozen source serving 99.0.0-beta.1 on Beta channel is caught as stale.
    let frozen_beta = Fake::with(vec![(API_RELEASES, ok(json!([release_json("v99.0.0-beta.1", &sha_of(BYTES), BYTES.len() as u64)])))]);
    let stale_view = run(check_with(&state, &service, &frozen_beta, chrono::Utc::now())).unwrap();
    assert_eq!(stale_view.status, "stale");

    // Switching back to Stable does NOT flag stable 98.0.0 as stale because stable watermark is untouched.
    set_preferences_with(&state, &service, true, "github", Some("stable")).unwrap();
    let fake_stable = Fake::with(vec![(API_LATEST, ok(release_json("v98.0.0", &sha_of(BYTES), BYTES.len() as u64)))]);
    let stable_view = run(check_with(&state, &service, &fake_stable, chrono::Utc::now())).unwrap();
    assert_eq!((stable_view.status, stable_view.latest_version.as_str(), stable_view.prerelease), ("newer", "98.0.0", false));
    assert_eq!(state.snapshot().unwrap().update_highest_seen.as_deref(), Some("98.0.0"));

    // Gitee Beta end-to-end check works via check_channel.
    let fake_gitee_beta = Fake::with(vec![
        (GITEE_RELEASES, ok(gitee_mixed)),
        (&gitee_manifest_url("v99.0.0-beta.2"), ok(beta_json)),
    ]);
    let gitee_rel = run(check_channel(&fake_gitee_beta, Preference::Gitee, Channel::Beta, &RateLimit::default(), chrono::Utc::now())).unwrap();
    assert_eq!(gitee_rel.tag, "v99.0.0-beta.2");
    fake_gitee_beta.done();

    drop(service);
    assert!(root.leftovers().is_empty());
    drop(state);
}
