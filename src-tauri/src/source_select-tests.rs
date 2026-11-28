use super::*;
use crate::models::{Config, Persisted};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;

/// A loopback server for the two probe routes. Every connection is answered
/// on its own thread, so one slow route never delays the other.
struct ProbeServer {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}

#[derive(Clone, Copy)]
enum Route {
    Status(u16),
    Delay(u16, u64),
    /// Accept and never answer (the connection is held until the server drops).
    Hang,
}

impl ProbeServer {
    fn new(official: Route, mirror: Route) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, done) = (requests.clone(), stop.clone());
        let worker = thread::spawn(move || {
            let held = Arc::new(Mutex::new(Vec::new()));
            let mut replies = Vec::new();
            while !done.load(Ordering::SeqCst) {
                let Ok((mut socket, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                };
                let (seen, held) = (seen.clone(), held.clone());
                replies.push(thread::spawn(move || {
                    socket.set_nonblocking(false).unwrap();
                    socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut received = Vec::new();
                    let mut byte = [0];
                    while received.len() < 8192 && !received.ends_with(b"\r\n\r\n") {
                        if socket.read_exact(&mut byte).is_err() {
                            break;
                        }
                        received.push(byte[0]);
                    }
                    let line = String::from_utf8_lossy(&received).lines().next().unwrap_or_default().to_owned();
                    let route = if line.contains("/official") { official } else { mirror };
                    seen.lock().unwrap().push(line);
                    let status = match route {
                        Route::Status(status) => status,
                        Route::Delay(status, ms) => {
                            thread::sleep(Duration::from_millis(ms));
                            status
                        }
                        Route::Hang => {
                            held.lock().unwrap().push(socket);
                            return;
                        }
                    };
                    let _ = socket.write_all(
                        format!("HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes(),
                    );
                }));
            }
            for reply in replies {
                let _ = reply.join();
            }
        });
        Self { port, requests, stop, worker: Some(worker) }
    }

    fn resolver(&self) -> impl Fn(&str) -> String + Sync {
        let port = self.port;
        move |url: &str| {
            let route = if url.contains("bmclapi") { "mirror" } else { "official" };
            format!("http://127.0.0.1:{port}/{route}")
        }
    }

    fn requests(&self) -> Vec<String> {
        let mut requests = self.requests.lock().unwrap().clone();
        requests.sort();
        requests
    }
}

impl Drop for ProbeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Field order matters: the state (and its profile lock) drops before the
/// directory, so the directory can be removed on Windows.
struct Fixture {
    state: LauncherState,
    dir: crate::instances::StagingDirectory,
}

fn fixture(source: &str) -> Fixture {
    let dir = crate::instances::StagingDirectory::create(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/source-select-tests")
            .join(uuid::Uuid::new_v4().to_string()),
    )
    .unwrap();
    let data = Persisted {
        config: Config { download_source: source.into(), ..Config::default() },
        ..Persisted::default()
    };
    let state = LauncherState::test_fixture(dir.path().join("profile"), data, crate::storage::test_client());
    Fixture { state, dir }
}

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

/// A passive caller (no task) with the server's resolver and a fixed clock.
fn passive(fixture: &Fixture, server: &ProbeServer, at: Instant) -> Result<String, String> {
    run(effective_with(&fixture.state, "auto", None, &server.resolver(), || at))
}

fn verdict(fixture: &Fixture) -> Option<Verdict> {
    run(fixture.state.source_verdict.lock()).clone()
}

#[test]
fn u0272_rank_prefers_mirror_only_when_official_fails_or_is_clearly_slower() {
    let at = Instant::now();
    let ms = Duration::from_millis;
    for (official, mirror, mirror_first, conclusive) in [
        (None, Some(ms(200)), true, true),
        (Some(ms(900)), Some(ms(200)), true, true),
        (Some(ms(551)), Some(ms(200)), true, true),
        (Some(ms(550)), Some(ms(200)), false, true),
        (Some(ms(300)), Some(ms(200)), false, true),
        (Some(ms(100)), Some(ms(200)), false, true),
        (Some(ms(100)), None, false, true),
        (None, None, false, false),
    ] {
        let verdict = rank(official, mirror, at);
        assert_eq!((verdict.mirror_first, verdict.conclusive), (mirror_first, conclusive), "{official:?} {mirror:?}");
        assert_eq!(verdict.official_ms, official.map(|value| value.as_millis() as u64));
    }
}

#[test]
fn u0272_probe_targets_are_fixed_trusted_constants() {
    let [official, mirror] = probe_targets().unwrap();
    assert_eq!(official, crate::minecraft::MANIFEST_URL);
    assert_eq!(mirror, "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json");
    for target in [&official, &mirror] {
        crate::storage::trusted_url(target).unwrap();
    }
}

#[test]
fn u0272_auto_with_unreachable_official_goes_mirror_first_once_per_session() {
    let server = ProbeServer::new(Route::Status(500), Route::Status(200));
    let fixture = fixture("auto");
    let now = Instant::now();
    let first = passive(&fixture, &server, now).unwrap();
    let later = passive(&fixture, &server, now + Duration::from_secs(3600)).unwrap();
    let requests = server.requests();
    let saved = fixture.state.snapshot().unwrap().config.download_source;
    let log = std::fs::read_dir(fixture.dir.path().join("profile/logs"))
        .unwrap()
        .flatten()
        .map(|entry| std::fs::read_to_string(entry.path()).unwrap())
        .collect::<String>();
    assert_eq!((first.as_str(), later.as_str()), ("bmclapi", "bmclapi"));
    assert_eq!(requests.len(), 2, "a conclusive verdict lasts the session: {requests:?}");
    assert_eq!(saved, "auto", "the effective source is never written back");
    assert!(log.contains("下载源自动选择：镜像优先（官方 未响应，镜像 "), "{log}");
    assert!(!log.contains("bangbang93") && !log.contains("mojang") && !log.contains("127.0.0.1"));
}

#[test]
fn u0272_a_slower_but_reachable_official_source_stays_first() {
    let server = ProbeServer::new(Route::Delay(200, 120), Route::Status(200));
    let fixture = fixture("auto");
    assert_eq!(passive(&fixture, &server, Instant::now()).unwrap(), "auto");
    let measured = verdict(&fixture).unwrap();
    let (official, mirror) = (measured.official_ms.unwrap(), measured.mirror_ms.unwrap());
    // The fixture really measured official as slower; the margin keeps it first.
    assert!(official >= 120 && official > mirror, "official {official} ms, mirror {mirror} ms");
}

#[test]
fn u0272_a_quick_official_answer_does_not_wait_for_a_dead_mirror() {
    let server = ProbeServer::new(Route::Status(200), Route::Hang);
    let fixture = fixture("auto");
    let started = Instant::now();
    assert_eq!(passive(&fixture, &server, Instant::now()).unwrap(), "auto");
    let elapsed = started.elapsed();
    assert!(elapsed < MIRROR_GRACE + Duration::from_secs(2), "waited {elapsed:?} for a mirror that cannot change the order");
    let measured = verdict(&fixture).unwrap();
    assert!(measured.conclusive && !measured.mirror_first && measured.mirror_ms.is_none());
}

#[test]
fn u0272_a_hung_official_probe_times_out_as_unreachable() {
    let server = ProbeServer::new(Route::Hang, Route::Status(200));
    let fixture = fixture("auto");
    let started = Instant::now();
    let resolver = server.resolver();
    let result = run(async {
        tokio::time::timeout(
            PROBE_TIMEOUT + Duration::from_secs(3),
            effective_with(&fixture.state, "auto", None, &resolver, Instant::now),
        )
        .await
    })
    .expect("the per-probe timeout bounds the wait");
    assert_eq!(result.unwrap(), "bmclapi");
    assert!(started.elapsed() >= PROBE_TIMEOUT - Duration::from_millis(200));
}

#[test]
fn u0272_concurrent_callers_share_one_probe_pair() {
    let server = ProbeServer::new(Route::Status(200), Route::Status(200));
    let fixture = fixture("auto");
    let resolver = server.resolver();
    let results = run(futures_util::future::join_all(
        (0..8).map(|_| effective_with(&fixture.state, "auto", None, &resolver, Instant::now)),
    ));
    assert!(results.iter().all(|result| result.as_deref() == Ok("auto")), "{results:?}");
    assert_eq!(server.requests(), ["GET /mirror HTTP/1.1", "GET /official HTTP/1.1"]);
}

#[test]
fn u0272_official_and_bmclapi_modes_never_probe() {
    let server = ProbeServer::new(Route::Status(200), Route::Status(200));
    let fixture = fixture("official");
    let resolver = server.resolver();
    for configured in ["official", "bmclapi"] {
        for control in [None, Some(&fixture.state.control)] {
            let result = run(effective_with(&fixture.state, configured, control, &resolver, Instant::now));
            assert_eq!(result.unwrap(), configured);
        }
    }
    assert!(server.requests().is_empty());
    assert!(verdict(&fixture).is_none());
}

#[test]
fn u0272_inconclusive_verdict_is_retried_only_by_passive_callers() {
    let server = ProbeServer::new(Route::Status(503), Route::Status(503));
    let fixture = fixture("auto");
    let resolver = server.resolver();
    let start = Instant::now();
    assert_eq!(passive(&fixture, &server, start).unwrap(), "auto");
    assert_eq!(passive(&fixture, &server, start + Duration::from_secs(59)).unwrap(), "auto");
    assert_eq!(server.requests().len(), 2, "still inside the 60 s window");
    // A task (a launch, an install) never waits on a retry, even after it expired.
    let task = run(effective_with(&fixture.state, "auto", Some(&fixture.state.control), &resolver, || {
        start + Duration::from_secs(600)
    }));
    assert_eq!(task.unwrap(), "auto");
    assert_eq!(server.requests().len(), 2, "a task keeps the expired verdict");
    assert_eq!(passive(&fixture, &server, start + Duration::from_secs(61)).unwrap(), "auto");
    assert_eq!(server.requests().len(), 4, "the next passive caller probes again");
}

#[test]
fn u0272_with_effective_source_returns_a_copy_only() {
    let server = ProbeServer::new(Route::Status(500), Route::Status(200));
    let fixture = fixture("auto");
    // Seed the verdict through the resolver path, then use the production entry.
    passive(&fixture, &server, Instant::now()).unwrap();
    let config = fixture.state.snapshot().unwrap().config;
    let effective = run(with_effective_source(&fixture.state, &config)).unwrap();
    assert_eq!(effective.download_source, "bmclapi");
    assert_eq!(fixture.state.snapshot().unwrap().config.download_source, "auto");
    assert_eq!(config.download_source, "auto");
}

#[test]
fn u0272_cancelling_the_task_stops_the_probe_without_a_verdict() {
    let server = ProbeServer::new(Route::Hang, Route::Hang);
    let fixture = fixture("auto");
    let state = &fixture.state;
    let resolver = server.resolver();
    // begin() makes the task the active one, so its signal reaches the probe.
    let task = state.control.begin("install", "1.21.1", "fixture").unwrap();
    let started = Instant::now();
    let result = run(async {
        let probe = effective_with(state, "auto", Some(&state.control), &resolver, Instant::now);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            state.control.cancel(&task);
        };
        futures_util::future::join(probe, cancel).await.0
    });
    assert!(result.is_err(), "{result:?}");
    assert!(started.elapsed() < PROBE_TIMEOUT, "cancellation, not the probe timeout, ended the wait");
    assert!(verdict(&fixture).is_none(), "a cancelled probe caches nothing");
}

#[test]
fn u0272_a_task_waiting_behind_another_probe_still_cancels() {
    let server = ProbeServer::new(Route::Hang, Route::Hang);
    let fixture = fixture("auto");
    let state = &fixture.state;
    let resolver = server.resolver();
    let started = Instant::now();
    let task = state.control.begin("install", "1.21.1", "fixture").unwrap();
    let result = run(async {
        // A passive probe holds the verdict lock until its 4 s timeout.
        let passive = effective_with(state, "auto", None, &resolver, Instant::now);
        let waiting = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let waiting = effective_with(state, "auto", Some(&state.control), &resolver, Instant::now);
            let cancel = async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                state.control.cancel(&task);
            };
            let (waited, ()) = futures_util::future::join(waiting, cancel).await;
            (waited, started.elapsed())
        };
        futures_util::future::join(passive, waiting).await.1
    });
    assert!(result.0.is_err(), "the waiting task was cancelled: {:?}", result.0);
    assert!(result.1 < PROBE_TIMEOUT, "it did not wait for the other probe: {:?}", result.1);
}

#[test]
fn u0272_a_passive_probe_ignores_an_unrelated_task_finishing() {
    let server = ProbeServer::new(Route::Delay(200, 300), Route::Delay(200, 300));
    let fixture = fixture("auto");
    let state = &fixture.state;
    let resolver = server.resolver();
    let task = state.control.begin("resource", "fixture", "unrelated download").unwrap();
    let result = run(async {
        let probe = effective_with(state, "auto", None, &resolver, Instant::now);
        let finish = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            state.control.finish(&task, None);
        };
        futures_util::future::join(probe, finish).await.0
    });
    assert_eq!(result.unwrap(), "auto");
    assert!(verdict(&fixture).is_some_and(|verdict| verdict.conclusive));
}

#[test]
fn u0272_view_reports_the_preference_and_latencies() {
    let verdict = rank(None, Some(Duration::from_millis(80)), Instant::now());
    assert_eq!(
        serde_json::to_value(view(&verdict)).unwrap(),
        serde_json::json!({"preferred": "mirror", "officialMs": null, "mirrorMs": 80, "conclusive": true})
    );
}

#[test]
fn u0272_every_download_entry_resolves_auto_through_the_session_verdict() {
    let production = |text: &str| {
        let source = crate::storage::executable_source(text);
        source.split("#[cfg(test)]\nmod tests").next().unwrap().to_owned()
    };
    let mut minecraft = production(include_str!("minecraft.rs"));
    // The two operations that pass a config down shadow it with the effective copy first.
    for name in ["async fn install_with_config(", "async fn install_official_java("] {
        let start = minecraft.find(name).unwrap();
        let end = start + minecraft[start..].find("\n}").unwrap();
        let body = &minecraft[start..end];
        let shadow = body.find("let config = &effective;").unwrap();
        assert!(shadow < body.find("download_source").unwrap(), "{name}");
        assert!(body.contains("crate::source_select::with_effective_source(state, config).await?"));
        minecraft.replace_range(start..end, "");
    }
    // Synchronous local library scanning performs no network requests; it only
    // filters which already-cached manifests are trusted for the configured source.
    {
        let start = minecraft.find("fn scan_versions_with_data_dir(").unwrap();
        let end = start + minecraft[start..].find("\n}").unwrap();
        minecraft.replace_range(start..end, "");
        let start = minecraft.find("pub(crate) fn scan_versions_at_root(").unwrap();
        let end = start + minecraft[start..].find("\n}").unwrap();
        let body = &minecraft[start..end];
        assert!(body.contains("read_cached_manifests_sync(dir, download_source)"));
        assert!(!body.contains("fetch_") && !body.contains("state.client"));
        minecraft.replace_range(start..end, "");
    }
    let sources = [
        ("minecraft.rs", minecraft),
        ("loaders.rs", production(include_str!("loaders.rs"))),
        ("content.rs", production(include_str!("content.rs"))),
        ("server_manager.rs", production(include_str!("server_manager.rs"))),
    ];
    for (file, text) in &sources {
        for line in text.lines().filter(|line| line.contains("download_source")) {
            assert!(
                line.contains("crate::source_select::effective_download_source(")
                    || line.contains("crate::source_select::passive_download_source("),
                "{file}: a raw download_source read bypasses the session verdict: {line}"
            );
        }
    }
    // Callers without a task of their own must not tie the probe to another task.
    let passive = |file: &str, function: &str| {
        let text = &sources.iter().find(|(name, _)| *name == file).unwrap().1;
        let start = text.find(function).unwrap();
        let body = &text[start..start + text[start..].find("\n}").unwrap()];
        assert!(body.contains("crate::source_select::passive_download_source("), "{file} {function}");
    };
    passive("minecraft.rs", "pub async fn manifest(");
    passive("loaders.rs", "pub async fn loader_versions(");
    passive("content.rs", "    let source = crate::source_select::passive_download_source(state, &config.download_source)");
}
