use super::checker::{check, classify, select, Offer, RateLimit};
use super::manifest::{parse_release, parse_version, pick_gitee_release, strict_json, Package, Release};
use super::sources::{get_file, manifest_location_tag, validate_location, Location, Request, Response, Transport};
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
}

fn ok(body: serde_json::Value) -> Reply {
    Reply { status: 200, location: None, headers: vec![], body: body.to_string().into_bytes(), delay: Duration::ZERO }
}

fn status(code: u16) -> Reply {
    Reply { status: code, location: None, headers: vec![], body: vec![], delay: Duration::ZERO }
}

fn moved(to: &str) -> Reply {
    Reply { status: 302, location: Some(to.into()), headers: vec![], body: vec![], delay: Duration::ZERO }
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
                content_length: Some(reply.body.len() as u64),
                body: futures_util::stream::iter(vec![Ok(reply.body)]).boxed(),
            })
        })
    }
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

fn release_json(tag: &str, sha: &str, size: u64) -> serde_json::Value {
    let version = parse_version(tag).unwrap();
    json!({"tag_name": tag, "draft": false, "prerelease": false, "body": format!("notes {tag}"),
        "assets": [{"name": installer_name(version), "size": size, "digest": format!("sha256:{sha}")}]})
}

fn gitee_list(tag: &str) -> serde_json::Value {
    json!([{"tag_name": tag, "prerelease": false, "body": format!("gitee notes {tag}"), "assets": [{"name": "update.json"}]}])
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
    assert_eq!(current_version(), parse_version(env!("CARGO_PKG_VERSION")).unwrap());
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
    assert_eq!(release.version, (0, 7, 0));
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
    assert_eq!((release.version, release.source), ((0, 7, 0), Source::GitHub));
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
    let tag = format!("v{}.{}.{}", version.0, version.1, version.2);
    Release {
        version,
        tag: tag.clone(),
        source,
        notes: None,
        package: Some(Package { version, tag, file_name: installer_name(version), size, sha256: sha.into(), source }),
    }
}

#[test]
fn selection_prefers_higher_versions_and_refuses_disagreeing_installers() {
    let a = release((0, 7, 0), SHA, 5, Source::GitHub);
    let b = release((0, 7, 1), SHA, 5, Source::Gitee);
    assert_eq!(select(Ok(a.clone()), Some(Ok(b.clone()))).unwrap().version, (0, 7, 1));
    assert_eq!(select(Ok(b.clone()), Some(Ok(a.clone()))).unwrap().version, (0, 7, 1));
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
fn saving_an_unknown_update_source_is_refused() {
    let dir = crate::instances::StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/update-tests").join(uuid::Uuid::new_v4().to_string()),
    )
    .unwrap();
    let state = LauncherState::test_fixture(dir.path().join("profile"), Default::default(), crate::storage::test_client());
    let mut config = state.snapshot().unwrap().config;
    config.game_directory = dir.path().join("game").to_string_lossy().into_owned();
    config.update_source = "mirror".into();
    assert_eq!(crate::commands::save_config_inner(&state, config.clone()).err().as_deref(), Some("更新来源无效"));
    config.update_source = "gitee".into();
    config.check_for_updates = false;
    let saved = crate::commands::save_config_inner(&state, config).unwrap();
    assert_eq!((saved.update_source.as_str(), saved.check_for_updates), ("gitee", false));
    drop(state);
}

#[test]
fn update_settings_default_to_auto_and_a_startup_check() {
    let config = crate::models::Config::default();
    assert!(config.check_for_updates);
    assert_eq!(config.update_source, "auto");
    let old: crate::models::Config = serde_json::from_str("{}").unwrap();
    assert!(old.check_for_updates && old.update_source == "auto", "older state files get the defaults");
    assert!(Preference::parse("auto").is_some() && Preference::parse("github").is_some() && Preference::parse("gitee").is_some());
    assert!(Preference::parse("mirror").is_none());
}
