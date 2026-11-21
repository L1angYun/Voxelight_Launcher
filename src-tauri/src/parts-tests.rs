use super::*;
use sha1::{Digest, Sha1};

struct Root(crate::instances::StagingDirectory);

impl Root {
    fn new() -> Self {
        Self(
            crate::instances::StagingDirectory::create(
                Path::new(env!("CARGO_MANIFEST_DIR")).join("target/parts-tests").join(uuid::Uuid::new_v4().to_string()),
            )
            .unwrap(),
        )
    }
    fn path(&self) -> &Path {
        self.0.path()
    }
    fn store(&self) -> PartStore {
        PartStore::new(self.path().join("parts"))
    }
    fn names(&self) -> Vec<String> {
        let mut names: Vec<_> = fs::read_dir(self.path().join("parts"))
            .map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }
}

const SIZE: u64 = 10;

fn key() -> PartKey {
    PartKey::new(Algo::Sha1, &format!("{:x}", Sha1::digest(b"0123456789")), SIZE).unwrap()
}

fn validator(origin: &str, etag: Option<&str>) -> Validator {
    Validator { origin: origin.into(), etag: etag.map(str::to_owned), last_modified: None }
}

#[test]
fn keys_name_the_strongest_digest_and_parse_only_canonical_names() {
    let hex = "AbCdEf0123456789abcdef0123456789abcdef01";
    let key = PartKey::new(Algo::Sha1, hex, 42).unwrap();
    assert_eq!(key.0, format!("sha1-{}-42", hex.to_ascii_lowercase()));
    assert_eq!(PartKey::parse(&key.0), Some(key.clone()));
    assert!(PartKey::new(Algo::Sha1, &hex[1..], 42).is_none(), "wrong length");
    assert!(PartKey::new(Algo::Sha1, &format!("{}g", &hex[1..]), 42).is_none(), "not hex");
    assert!(PartKey::new(Algo::Sha1, hex, 0).is_none(), "empty files are not parts");
    assert!(PartKey::new(Algo::Sha512, hex, 42).is_none(), "SHA-512 needs 128 digits");
    assert!(PartKey::new(Algo::Sha512, &"a".repeat(128), 1).is_some());
    for foreign in [
        format!("sha1-{hex}-42"),
        format!("sha1-{}-042", hex.to_ascii_lowercase()),
        format!("sha1-{}-+42", hex.to_ascii_lowercase()),
        format!("md5-{}-42", "a".repeat(32)),
        format!("sha1-{}", hex.to_ascii_lowercase()),
        "run-1234".into(),
    ] {
        assert_eq!(PartKey::parse(&foreign), None, "{foreign}");
    }
}

#[test]
fn a_part_keeps_its_bytes_and_record_across_holders() {
    let root = Root::new();
    let store = root.store();
    let mut part = store.open(&key(), SIZE).unwrap().unwrap();
    assert_eq!((part.done(), part.resume_for("https://a.example")), (0, None));
    part.restart(validator("https://a.example", Some("\"v1\""))).unwrap();
    part.append(b"01234").unwrap();
    drop(part);
    let part = store.open(&key(), SIZE).unwrap().unwrap();
    assert_eq!(part.done(), 5);
    assert_eq!(part.resume_for("https://a.example"), Some((5, "\"v1\"".into())));
    assert_eq!(part.resume_for("https://b.example"), None, "another origin starts from zero");
    drop(part);
    // A date validates when there is no strong tag; no validator means no resume.
    let mut part = store.open(&key(), SIZE).unwrap().unwrap();
    part.restart(Validator { origin: "https://a.example".into(), etag: None, last_modified: Some("Wed, 21 Oct 2026 07:28:00 GMT".into()) }).unwrap();
    part.append(b"012").unwrap();
    assert_eq!(part.resume_for("https://a.example"), Some((3, "Wed, 21 Oct 2026 07:28:00 GMT".into())));
    part.restart(validator("https://a.example", None)).unwrap();
    part.append(b"012").unwrap();
    assert_eq!(part.resume_for("https://a.example"), None);
    drop(part);
}

#[test]
fn only_one_holder_at_a_time() {
    let root = Root::new();
    let store = root.store();
    let first = store.open(&key(), SIZE).unwrap();
    assert!(first.is_some());
    assert!(store.open(&key(), SIZE).unwrap().is_none(), "a second download uses a part of its own");
    drop(first);
    assert!(store.open(&key(), SIZE).unwrap().is_some());
}

#[test]
fn a_record_that_does_not_add_up_starts_from_zero() {
    let root = Root::new();
    let store = root.store();
    let parts = root.path().join("parts");
    let prepare = |done: &[u8]| {
        let mut part = store.open(&key(), SIZE).unwrap().unwrap();
        part.restart(validator("https://a.example", Some("\"v\""))).unwrap();
        part.append(done).unwrap();
        drop(part);
    };
    // Bytes past the record are cut.
    prepare(b"0123");
    fs::OpenOptions::new().append(true).open(key().file(&parts, "part")).unwrap().write_all(b"xx").unwrap();
    let part = store.open(&key(), SIZE).unwrap().unwrap();
    assert_eq!(part.done(), 4);
    assert_eq!(fs::metadata(key().file(&parts, "part")).unwrap().len(), 4);
    drop(part);
    // A part shorter than its record, a record for another size, an unknown field, an oversized record.
    let cases: [Box<dyn Fn()>; 4] = [
        Box::new(|| fs::OpenOptions::new().write(true).open(key().file(&parts, "part")).unwrap().set_len(1).unwrap()),
        Box::new(|| {
            let text = fs::read_to_string(key().file(&parts, "json")).unwrap().replace("\"size\":10", "\"size\":11");
            fs::write(key().file(&parts, "json"), text).unwrap();
        }),
        Box::new(|| {
            let text = fs::read_to_string(key().file(&parts, "json")).unwrap().replacen('{', "{\"extra\":1,", 1);
            fs::write(key().file(&parts, "json"), text).unwrap();
        }),
        Box::new(|| fs::write(key().file(&parts, "json"), " ".repeat(5000)).unwrap()),
    ];
    for (index, damage) in cases.iter().enumerate() {
        prepare(b"0123");
        damage();
        let part = store.open(&key(), SIZE).unwrap().unwrap();
        assert_eq!(part.done(), 0, "case {index}");
        assert_eq!(part.resume_for("https://a.example"), None, "case {index}");
        assert_eq!(fs::metadata(key().file(&parts, "part")).unwrap().len(), 0, "case {index}");
        drop(part);
    }
}

#[test]
fn the_prefix_hash_covers_exactly_the_kept_bytes_and_appends_stop_at_the_size() {
    let root = Root::new();
    let store = root.store();
    let mut part = store.open(&key(), SIZE).unwrap().unwrap();
    part.restart(validator("https://a.example", Some("\"v\""))).unwrap();
    part.append(b"01234").unwrap();
    drop(part);
    let mut part = store.open(&key(), SIZE).unwrap().unwrap();
    let mut hash = Sha1::new();
    part.hash_prefix(|bytes| hash.update(bytes)).unwrap();
    part.append(b"56789").unwrap();
    hash.update(b"56789");
    assert_eq!(format!("{:x}", hash.finalize()), format!("{:x}", Sha1::digest(b"0123456789")));
    assert!(part.complete());
    assert!(part.append(b"x").is_err(), "never more than the expected size");
    part.sync().unwrap();
    let target = root.path().join("file.bin");
    part.publish_replace(&target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"0123456789");
    assert!(root.names().is_empty(), "publishing removes the part, its record and the lock: {:?}", root.names());
}

#[test]
fn publishing_replaces_the_target_and_works_across_volumes() {
    let root = Root::new();
    let store = root.store();
    let target = root.path().join("file.bin");
    fs::write(&target, b"stale").unwrap();
    for force in [false, true] {
        let mut part = store.open(&key(), SIZE).unwrap().unwrap();
        part.restart(validator("https://a.example", None)).unwrap();
        part.append(b"0123456789").unwrap();
        part.sync().unwrap();
        FORCE_CROSS_VOLUME.with(|cell| cell.set(force));
        let published = part.publish_replace(&target);
        FORCE_CROSS_VOLUME.with(|cell| cell.set(false));
        published.unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"0123456789", "force={force}");
        assert!(root.names().is_empty(), "force={force}: {:?}", root.names());
        let siblings: Vec<_> = fs::read_dir(root.path()).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(siblings.len(), 2, "only the target and the parts folder: {siblings:?}");
        fs::write(&target, b"stale").unwrap();
    }
}

#[test]
fn a_discarded_part_is_gone_and_the_next_holder_starts_from_zero() {
    let root = Root::new();
    let store = root.store();
    let mut part = store.open(&key(), SIZE).unwrap().unwrap();
    part.restart(validator("https://a.example", Some("\"v\""))).unwrap();
    part.append(b"0123").unwrap();
    part.discard();
    assert!(root.names().is_empty(), "{:?}", root.names());
    assert_eq!(store.open(&key(), SIZE).unwrap().unwrap().done(), 0);
}

#[test]
fn the_part_store_refuses_a_linked_root() {
    let root = Root::new();
    let real = root.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = root.path().join("link");
    let output = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link.to_string_lossy().replace('/', r"\"))
        .arg(real.to_string_lossy().replace('/', r"\"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    // An old, unlocked part behind the junction: a sweep through the link must not reach it.
    fs::create_dir(real.join("parts")).unwrap();
    let behind = key().file(&real.join("parts"), "part");
    fs::write(&behind, b"keep").unwrap();
    touch(&behind, Duration::from_secs(30 * 24 * 60 * 60));
    let result = PartStore::new(link.join("parts")).open(&key(), SIZE);
    PartStore::new(link.join("parts")).sweep(SystemTime::now(), Duration::ZERO, 0);
    let _ = fs::remove_dir(&link);
    assert!(result.is_err());
    assert_eq!(fs::read(&behind).unwrap(), b"keep", "nothing was removed through the junction");
    assert_eq!(fs::read_dir(real.join("parts")).unwrap().count(), 1, "nothing was created through the junction");
}

#[test]
fn replies_continue_only_for_exactly_the_missing_bytes() {
    assert_eq!(classify(200, None, 0, 10), Reply::Restart);
    assert_eq!(classify(200, None, 4, 10), Reply::Restart, "a server that ignores Range sends everything");
    assert_eq!(classify(206, Some("bytes 4-9/10"), 4, 10), Reply::Continue);
    for (range, offset) in [(Some("bytes 0-9/10"), 4), (Some("bytes 4-8/10"), 4), (Some("bytes 4-9/11"), 4), (Some("bytes 4-9/*"), 4), (None, 4), (Some("bytes 0-9/10"), 0)] {
        assert_eq!(classify(206, range, offset, 10), Reply::Discard(RANGE_MISMATCH.into()), "{range:?} at {offset}");
    }
    assert_eq!(classify(416, Some("bytes */8"), 9, 10), Reply::Discard(RANGE_MISMATCH.into()));
    assert_eq!(classify(503, None, 4, 10), Reply::Fail("下载失败（HTTP 503）".into()));
}

#[test]
fn validators_use_only_strong_tags_and_the_requested_origin() {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(reqwest::header::ETAG, "W/\"weak\"".parse().unwrap());
    headers.insert(reqwest::header::LAST_MODIFIED, "Wed, 21 Oct 2026 07:28:00 GMT".parse().unwrap());
    let url = reqwest::Url::parse("https://piston-data.mojang.com:443/v1/objects/x?sig=secret").unwrap();
    let weak = Validator::of(&url, &headers);
    assert_eq!(weak, Validator { origin: "https://piston-data.mojang.com".into(), etag: None, last_modified: Some("Wed, 21 Oct 2026 07:28:00 GMT".into()) });
    headers.insert(reqwest::header::ETAG, "\"strong\"".parse().unwrap());
    let strong = Validator::of(&reqwest::Url::parse("http://127.0.0.1:8080/a").unwrap(), &headers);
    assert_eq!((strong.origin.as_str(), strong.etag.as_deref()), ("http://127.0.0.1:8080", Some("\"strong\"")));
    assert_eq!(strong.if_range(), Some("\"strong\""));
}

fn touch(path: &Path, age: Duration) {
    let file = fs::OpenOptions::new().write(true).create(true).truncate(false).open(path).unwrap();
    file.set_modified(SystemTime::now() - age).unwrap();
}

#[test]
fn the_sweep_removes_only_old_unlocked_parts_and_then_the_oldest_above_the_cap() {
    let root = Root::new();
    let store = root.store();
    let parts = root.path().join("parts");
    fs::create_dir_all(&parts).unwrap();
    let day = Duration::from_secs(24 * 60 * 60);
    let key_of = |n: u64| PartKey::new(Algo::Sha1, &format!("{:040x}", n), 100 + n).unwrap();
    // 1: expired, unlocked. 2: expired but held. 3: fresh. 4: expired, no lock file.
    for n in 1..=4 {
        let key = key_of(n);
        fs::write(key.file(&parts, "part"), vec![0u8; 100]).unwrap();
        touch(&key.file(&parts, "part"), if n == 3 { day } else { 8 * day });
        touch(&key.file(&parts, "json"), if n == 3 { day } else { 8 * day });
        if n != 4 {
            touch(&key.file(&parts, "lock"), 8 * day);
        }
    }
    let held = fs::OpenOptions::new().read(true).write(true).open(key_of(2).file(&parts, "lock")).unwrap();
    held.try_lock().unwrap();
    // Foreign names, a stray directory and a junction with a part-like name are never touched.
    fs::write(parts.join("notes.part"), b"x").unwrap();
    touch(&parts.join("notes.part"), 30 * day);
    fs::create_dir(parts.join(format!("{}.part", key_of(9).0))).unwrap();
    let outside = root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("keep.bin"), b"keep").unwrap();
    let junction = parts.join(format!("{}.part", key_of(8).0));
    let output = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(junction.to_string_lossy().replace('/', r"\"))
        .arg(outside.to_string_lossy().replace('/', r"\"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");

    store.sweep(SystemTime::now(), KEEP, CAP);
    let names = root.names();
    assert!(!names.iter().any(|name| name.starts_with(&key_of(1).0)), "expired and unlocked: removed");
    assert!(!names.iter().any(|name| name.starts_with(&key_of(4).0)), "expired without a lock file: removed");
    assert!(names.contains(&format!("{}.part", key_of(2).0)), "held: kept");
    assert!(names.contains(&format!("{}.part", key_of(3).0)), "fresh: kept");
    assert!(names.contains(&"notes.part".to_owned()));
    assert!(parts.join(format!("{}.part", key_of(9).0)).is_dir());
    assert_eq!(fs::read(outside.join("keep.bin")).unwrap(), b"keep", "nothing through the junction");

    // Over the cap: the oldest unlocked go first; held parts stay even then.
    for n in [5, 6] {
        let key = key_of(n);
        fs::write(key.file(&parts, "part"), vec![0u8; 100]).unwrap();
        touch(&key.file(&parts, "part"), Duration::from_secs(n * 60));
    }
    // Ages: 3 one day, 6 six minutes, 5 five minutes; 2 is held. A 250-byte cap removes 3, then 6.
    store.sweep(SystemTime::now(), KEEP, 250);
    let names = root.names();
    assert!(!names.iter().any(|name| name.starts_with(&key_of(3).0)), "the oldest unlocked part went first");
    assert!(!names.iter().any(|name| name.starts_with(&key_of(6).0)), "then the next oldest, until under the cap");
    assert!(names.iter().any(|name| name.starts_with(&key_of(2).0)), "a held part is never removed");
    assert!(names.contains(&format!("{}.part", key_of(5).0)), "the newest stays");
    let _ = fs::remove_dir(&junction);
    drop(held);
}

#[test]
fn a_lock_file_keeps_its_name_while_another_opener_holds_it() {
    let root = Root::new();
    let store = root.store();
    let lock_path = key().file(&root.path().join("parts"), "lock");
    let first = store.open(&key(), SIZE).unwrap().unwrap();
    // A second download has opened the lock file but not locked it yet.
    let pending = lock_options().open(&lock_path).unwrap();
    first.discard();
    assert!(lock_path.is_file(), "the name stays while another handle is open");
    pending.try_lock().unwrap();
    // A third download finds the same file, locked: never a second holder.
    assert!(store.open(&key(), SIZE).unwrap().is_none());
    drop(pending);
    let again = store.open(&key(), SIZE).unwrap().unwrap();
    again.discard();
    assert!(!lock_path.exists(), "with nobody else holding it, the name goes");
}

#[test]
fn restarts_count_only_thrown_away_bytes_and_the_prefix_is_hashed_in_pieces() {
    let root = Root::new();
    let store = root.store();
    let mut part = store.open(&key(), SIZE).unwrap().unwrap();
    part.restart(validator("https://a.example", Some("\"v\""))).unwrap();
    assert_eq!(part.restarts(), 0, "an empty part loses nothing");
    part.append(b"012345").unwrap();
    part.restart(validator("https://a.example", Some("\"w\""))).unwrap();
    assert_eq!(part.restarts(), 1);
    let file = root.path().join("parts").join(format!("{}.part", key().0));
    assert_eq!(fs::metadata(&file).unwrap().len(), 0, "the thrown-away bytes are gone at once, not at the next open");
    part.append(b"0123456").unwrap();
    let mut seen = Vec::new();
    let mut from = 0;
    loop {
        let read = part.hash_prefix_chunk(from, 3, &mut |bytes| seen.extend_from_slice(bytes)).unwrap();
        if read == 0 {
            break;
        }
        assert!(read <= 3);
        from += read;
    }
    assert_eq!(seen, b"0123456");
    // A partial piece leaves the read position at 3; the write position must return to 7.
    assert_eq!(part.hash_prefix_chunk(0, 3, &mut |_| {}).unwrap(), 3);
    part.append(b"789").unwrap();
    assert!(part.complete());
    part.sync().unwrap();
    let target = root.path().join("file.bin");
    part.publish_replace(&target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"0123456789");
}

#[test]
fn the_sweep_lists_a_folder_once_and_the_startup_folders_include_the_game_root() {
    let root = Root::new();
    let parts = root.path().join("parts");
    fs::create_dir_all(&parts).unwrap();
    let key = PartKey::new(Algo::Sha1, &"c".repeat(40), 100).unwrap();
    fs::write(key.file(&parts, "part"), vec![0u8; 100]).unwrap();
    // Listed twice and spelled differently (the data directory and the game root
    // naming one folder): 100 bytes are still 100.
    let respelled = PathBuf::from(parts.to_string_lossy().to_ascii_uppercase());
    assert_ne!(respelled, parts);
    sweep(&[PartStore::new(parts.clone()), PartStore::new(respelled)], SystemTime::now(), KEEP, 150);
    assert!(key.file(&parts, "part").is_file(), "one 100-byte part is under a 150-byte cap");
    let data = Path::new("C:\\Data");
    let game = Path::new("D:\\Games\\MC");
    let names = |stores: Vec<PartStore>| stores.iter().map(|store| store.root().to_path_buf()).collect::<Vec<_>>();
    assert_eq!(
        names(startup_stores(data, Some(game))),
        [data.join(".launcher-temp").join("parts"), data.join("pack-cache").join(".parts"), game.join(".launcher-temp").join("parts")]
    );
    assert_eq!(names(startup_stores(data, None)).len(), 2);
}

struct Plain;

impl Hooks for Plain {
    async fn cancellable<F: std::future::Future>(&self, future: F) -> Result<F::Output, String> {
        Ok(future.await)
    }
    async fn checkpoint(&self) -> Result<(), String> {
        Ok(())
    }
    async fn throttle(&self, _: usize) -> Result<(), String> {
        Ok(())
    }
    fn stall_limit(&self) -> Duration {
        STALL
    }
}

fn transfer_once(server: &range_server::RangeServer, slot: &mut Option<ResumablePart>, size: u64) -> Result<(), String> {
    let url = reqwest::Url::parse(&format!("http://{}/file", server.address)).unwrap();
    let client = crate::storage::test_client();
    tokio::runtime::Runtime::new().unwrap().block_on(transfer(client.get(url.clone()), &url, slot, size, &Plain, &|_| Ok(()), &mut |_| {}))
}

#[test]
fn a_206_whose_length_disagrees_is_refused_before_any_byte_is_kept() {
    use range_server::{RangeServer, Scripted};
    let root = Root::new();
    let whole: Vec<u8> = (0..64u8).collect();
    let key = PartKey::new(Algo::Sha1, &format!("{:x}", Sha1::digest(&whole)), whole.len() as u64).unwrap();
    // The right Content-Range, but ten more bytes than were asked for.
    let mut body = whole[16..].to_vec();
    body.extend_from_slice(&[0xee; 10]);
    let server = RangeServer::new(vec![Scripted::partial(&whole, 16, "\"v\"").with_body(body)]);
    let mut slot = root.store().open(&key, whole.len() as u64).unwrap();
    let part = slot.as_mut().unwrap();
    part.restart(validator(&format!("http://{}", server.address), Some("\"v\""))).unwrap();
    part.append(&whole[..16]).unwrap();
    let result = transfer_once(&server, &mut slot, whole.len() as u64);
    assert_eq!(result.unwrap_err(), "续传响应的长度与请求不符");
    assert_eq!(server.header(0, "range").as_deref(), Some("bytes=16-"));
    assert_eq!(slot.as_ref().unwrap().done(), 16, "nothing of the wrong reply was kept");
}

#[test]
fn a_body_that_ends_early_keeps_the_part_for_the_next_attempt() {
    use range_server::{RangeServer, Scripted};
    let root = Root::new();
    let whole: Vec<u8> = (0..64u8).collect();
    let key = PartKey::new(Algo::Sha1, &format!("{:x}", Sha1::digest(&whole)), whole.len() as u64).unwrap();
    // No Content-Length: the body ends cleanly after 20 of 64 bytes.
    let short = Scripted::ok(&whole[..20], "\"v\"").without_length();
    let server = RangeServer::new(vec![short]);
    let mut slot = root.store().open(&key, whole.len() as u64).unwrap();
    let result = transfer_once(&server, &mut slot, whole.len() as u64);
    assert_eq!(result.unwrap_err(), "下载在预期大小之前结束");
    let part = slot.as_ref().expect("the part is kept, not discarded");
    assert_eq!(part.done(), 20);
    assert!(!part.complete());
}

#[test]
fn the_sweep_locks_a_part_whose_lock_file_is_missing() {
    let root = Root::new();
    let parts = root.path().join("parts");
    fs::create_dir_all(&parts).unwrap();
    // A part and record without a lock file (an older build, or a lock name that was removed).
    let key = key();
    fs::write(key.file(&parts, "part"), b"0123").unwrap();
    fs::write(key.file(&parts, "json"), b"{}").unwrap();
    let old = Duration::from_secs(30 * 24 * 60 * 60);
    touch(&key.file(&parts, "part"), old);
    touch(&key.file(&parts, "json"), old);
    // While a download holds the key the sweep leaves it, however old the
    // files look (opening wrote the record and the lock, so age them all).
    let held = root.store().open(&key, SIZE).unwrap().unwrap();
    for extension in ["part", "json", "lock"] {
        touch(&key.file(&parts, extension), old);
    }
    root.store().sweep(SystemTime::now(), KEEP, CAP);
    assert!(key.file(&parts, "part").is_file(), "a held part survives the sweep");
    drop(held);
    touch(&key.file(&parts, "part"), old);
    touch(&key.file(&parts, "json"), old);
    fs::remove_file(key.file(&parts, "lock")).unwrap();
    root.store().sweep(SystemTime::now(), KEEP, CAP);
    assert!(root.names().is_empty(), "removed under its lock, lock name included: {:?}", root.names());
}

#[test]
fn a_restart_over_another_origins_bytes_is_not_charged() {
    let root = Root::new();
    let mut part = root.store().open(&key(), SIZE).unwrap().unwrap();
    part.restart(validator("https://mirror.example", Some("\"v\""))).unwrap();
    part.append(b"0123").unwrap();
    let before = part.mark();
    part.restart(validator("https://official.example", Some("\"w\""))).unwrap();
    assert_eq!(part.restarts(), 0, "another origin's bytes could never be continued here");
    part.append(b"01").unwrap();
    assert!(progressed(Some(&before), Some(&part.mark())), "two new bytes from zero are progress");
    assert!(part.holds_bytes_from_another("https://mirror.example"));
    assert!(!part.holds_bytes_from_another("https://official.example"));
    let before = part.mark();
    part.restart(validator("https://official.example", Some("\"w\""))).unwrap();
    part.append(b"012").unwrap();
    assert_eq!(part.restarts(), 1);
    assert!(!progressed(Some(&before), Some(&part.mark())), "starting over at the same origin is never progress");
    assert!(wrote(Some(&before), Some(&part.mark())));
    assert!(!wrote(Some(&part.mark()), Some(&part.mark())));
}

/// Passes everything through, but once `at` bytes went by, waits longer than
/// the record gap before the next chunk.
#[derive(Default)]
struct Pausing {
    at: usize,
    seen: std::sync::atomic::AtomicUsize,
    paused: std::sync::atomic::AtomicBool,
}

impl Hooks for Pausing {
    async fn cancellable<F: std::future::Future>(&self, future: F) -> Result<F::Output, String> {
        Ok(future.await)
    }
    async fn checkpoint(&self) -> Result<(), String> {
        Ok(())
    }
    async fn throttle(&self, bytes: usize) -> Result<(), String> {
        use std::sync::atomic::Ordering;
        if self.seen.fetch_add(bytes, Ordering::SeqCst) + bytes >= self.at && !self.paused.swap(true, Ordering::SeqCst) {
            tokio::time::sleep(RECORD_GAP + Duration::from_millis(100)).await;
        }
        Ok(())
    }
    fn stall_limit(&self) -> Duration {
        STALL
    }
}

#[test]
fn a_long_transfer_records_its_bytes_while_it_runs() {
    use range_server::{RangeServer, Scripted};
    const MIB: usize = 1024 * 1024;
    let root = Root::new();
    let whole: Vec<u8> = (0..6 * MIB).map(|index| (index % 251) as u8).collect();
    let size = whole.len() as u64;
    let key = PartKey::new(Algo::Sha1, &format!("{:x}", Sha1::digest(&whole)), size).unwrap();
    // 5 MiB arrive, then the reply hangs: only a record made during the
    // transfer shows those bytes (a crashed launcher never reaches Drop).
    let server = RangeServer::new(vec![Scripted::ok(&whole, "\"v\"").stall(5 * MIB)]);
    let mut slot = root.store().open(&key, size).unwrap();
    let sidecar = key.file(&root.path().join("parts"), "json");
    let url = reqwest::Url::parse(&format!("http://{}/file", server.address)).unwrap();
    let client = crate::storage::test_client();
    let check = |_: &reqwest::Response| Ok(());
    let mut hash = |_: &[u8]| {};
    // A slow link: past 4.5 MiB the stream pauses longer than the record gap.
    let hooks = Pausing { at: 9 * MIB / 2, ..Pausing::default() };
    let recorded = tokio::runtime::Runtime::new().unwrap().block_on(async {
        let transfer = Box::pin(transfer(client.get(url.clone()), &url, &mut slot, size, &hooks, &check, &mut hash));
        let watch = Box::pin(async {
            for _ in 0..100 {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if let Some(record) = read_sidecar(&sidecar).filter(|record| record.done >= RECORD_EVERY) {
                    return record.done;
                }
            }
            0
        });
        match futures_util::future::select(transfer, watch).await {
            futures_util::future::Either::Left((result, _)) => panic!("the stalled transfer ended: {result:?}"),
            futures_util::future::Either::Right((done, _)) => done,
        }
    });
    assert!((RECORD_EVERY..=5 * MIB as u64).contains(&recorded), "recorded {recorded} bytes while running");
}

#[test]
fn verified_parts_are_published_off_the_async_task() {
    for (name, source) in [("minecraft.rs", include_str!("minecraft.rs")), ("modpacks.rs", include_str!("modpacks.rs"))] {
        let code = crate::storage::executable_source(source.split("\nmod tests {").next().unwrap());
        assert!(!code.contains(".publish_replace("), "{name} publishes a part on the async task");
        assert!(code.contains("crate::parts::publish_off_task("), "{name}");
    }
}

#[test]
fn a_part_published_off_the_task_keeps_the_cross_volume_path() {
    let root = Root::new();
    let target = root.path().join("published.bin");
    fs::write(&target, b"old").unwrap();
    let mut part = root.store().open(&key(), SIZE).unwrap().unwrap();
    part.restart(validator("https://a.example", None)).unwrap();
    part.append(b"0123456789").unwrap();
    part.sync().unwrap();
    FORCE_CROSS_VOLUME.with(|cell| cell.set(true));
    let result = tokio::runtime::Runtime::new().unwrap().block_on(publish_off_task(part, &target));
    FORCE_CROSS_VOLUME.with(|cell| cell.set(false));
    result.unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"0123456789");
    assert_eq!(root.names(), Vec::<String>::new(), "nothing is left in the part folder");
}
