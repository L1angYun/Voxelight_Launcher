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

#[test]
fn publishing_new_moves_a_verified_part_and_leaves_only_the_target() {
    let root = Root::new();
    let store = root.store();
    let target = root.path().join("file.bin");
    for force in [false, true] {
        let mut part = store.open(&key(), SIZE).unwrap().unwrap();
        part.restart(validator("https://a.example", None)).unwrap();
        part.append(b"0123456789").unwrap();
        part.sync().unwrap();
        FORCE_CROSS_VOLUME.with(|cell| cell.set(force));
        let published = part.publish_new(&target);
        FORCE_CROSS_VOLUME.with(|cell| cell.set(false));
        published.unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"0123456789", "force={force}");
        assert!(root.names().is_empty(), "force={force}: {:?}", root.names());
        let siblings: Vec<_> = fs::read_dir(root.path()).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(siblings.len(), 2, "force={force}: only the target and the parts folder: {siblings:?}");
        fs::remove_file(&target).unwrap();
    }
}

#[test]
fn publishing_new_never_replaces_an_existing_target_and_keeps_the_part() {
    let root = Root::new();
    let store = root.store();
    let target = root.path().join("file.bin");
    fs::write(&target, b"user bytes").unwrap();
    for force in [false, true] {
        let mut part = store.open(&key(), SIZE).unwrap().unwrap();
        part.restart(validator("https://a.example", None)).unwrap();
        part.append(b"0123456789").unwrap();
        part.sync().unwrap();
        FORCE_CROSS_VOLUME.with(|cell| cell.set(force));
        let published = part.publish_new(&target);
        FORCE_CROSS_VOLUME.with(|cell| cell.set(false));
        assert!(published.is_err(), "force={force}");
        assert_eq!(fs::read(&target).unwrap(), b"user bytes", "force={force}");
        let siblings: Vec<_> = fs::read_dir(root.path()).unwrap().flatten().map(|entry| entry.file_name()).collect();
        assert_eq!(siblings.len(), 2, "force={force}: only the target and the parts folder: {siblings:?}");
        let part = store.open(&key(), SIZE).unwrap().expect("the part stays usable");
        assert_eq!(part.done(), SIZE, "force={force}: the verified bytes were kept");
        assert!(part.complete());
    }
}

#[test]
fn publishing_new_off_the_task_keeps_the_cross_volume_path_and_refuses_an_existing_target() {
    let root = Root::new();
    let target = root.path().join("published.bin");
    let mut part = root.store().open(&key(), SIZE).unwrap().unwrap();
    part.restart(validator("https://a.example", None)).unwrap();
    part.append(b"0123456789").unwrap();
    part.sync().unwrap();
    FORCE_CROSS_VOLUME.with(|cell| cell.set(true));
    let result = tokio::runtime::Runtime::new().unwrap().block_on(publish_new_off_task(part, &target));
    FORCE_CROSS_VOLUME.with(|cell| cell.set(false));
    result.unwrap();
    assert_eq!(fs::read(&target).unwrap(), b"0123456789");
    assert!(root.names().is_empty(), "nothing is left in the part folder");

    let mut part = root.store().open(&key(), SIZE).unwrap().unwrap();
    part.restart(validator("https://a.example", None)).unwrap();
    part.append(b"0123456789").unwrap();
    part.sync().unwrap();
    fs::write(&target, b"user bytes").unwrap();
    FORCE_CROSS_VOLUME.with(|cell| cell.set(true));
    let result = tokio::runtime::Runtime::new().unwrap().block_on(publish_new_off_task(part, &target));
    FORCE_CROSS_VOLUME.with(|cell| cell.set(false));
    assert!(result.is_err());
    assert_eq!(fs::read(&target).unwrap(), b"user bytes");
    let siblings: Vec<_> = fs::read_dir(root.path()).unwrap().flatten().map(|entry| entry.file_name()).collect();
    assert_eq!(siblings.len(), 2, "only the target and the parts folder: {siblings:?}");
    let part = root.store().open(&key(), SIZE).unwrap().expect("the part stays usable");
    assert_eq!(part.done(), SIZE, "the verified bytes were kept");
}

#[test]
fn ranged_replies_follow_the_request_and_count_the_body_bytes_sent() {
    use range_server::{RangeServer, Scripted};
    let whole: Vec<u8> = (0..32u8).collect();
    let server = RangeServer::new(vec![Scripted::ranged(&whole, "\"v\""), Scripted::ranged(&whole, "\"v\"")]);
    let url = format!("http://{}/file", server.address);
    let client = crate::storage::test_client();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let fetch = |range: Option<&str>| {
        let client = client.clone();
        let url = url.clone();
        runtime.block_on(async move {
            let mut request = client.get(&url);
            if let Some(range) = range {
                request = request.header(reqwest::header::RANGE, range);
            }
            let response = request.send().await.unwrap();
            let status = response.status().as_u16();
            let etag = response.headers().get(reqwest::header::ETAG).map(|value| value.to_str().unwrap().to_owned());
            let content_range = response.headers().get(reqwest::header::CONTENT_RANGE).map(|value| value.to_str().unwrap().to_owned());
            (status, etag, content_range, response.bytes().await.unwrap().to_vec())
        })
    };
    let (status, etag, content_range, body) = fetch(None);
    assert_eq!((status, etag.as_deref(), content_range.as_deref()), (200, Some("\"v\""), None));
    assert_eq!(body, whole);
    let (status, etag, content_range, body) = fetch(Some("bytes=3-"));
    assert_eq!((status, etag.as_deref(), content_range.as_deref()), (206, Some("\"v\""), Some("bytes 3-31/32")));
    assert_eq!(body, whole[3..]);
    assert_eq!(server.header(0, "range"), None);
    assert_eq!(server.header(1, "range").as_deref(), Some("bytes=3-"));
    let sent = server.sent.clone();
    drop(server);
    assert_eq!(sent.load(std::sync::atomic::Ordering::SeqCst), whole.len() + whole[3..].len());
}

#[test]
fn part_folders_of_an_earlier_game_root_are_still_swept_at_startup() {
    let root = Root::new();
    let data = root.path().join("data");
    let old = root.path().join("old-game").join(".launcher-temp").join("parts");
    let current = root.path().join("game");
    fs::create_dir_all(&old).unwrap();
    fs::create_dir_all(current.join(".launcher-temp").join("parts")).unwrap();
    remember(&data, &old);
    remember(&data, &old);
    assert_eq!(remembered(&data), [old.clone()], "a repeated folder is stored once");
    let roots: Vec<_> = startup_stores(&data, Some(&current)).iter().map(|store| store.root().to_path_buf()).collect();
    assert_eq!(
        roots,
        [
            data.join(".launcher-temp").join("parts"),
            data.join("pack-cache").join(".parts"),
            current.join(".launcher-temp").join("parts"),
            old.clone(),
        ],
        "remembered once, after the configured folders"
    );
    // The current game root is not listed twice when it was remembered too.
    remember(&data, &current.join(".launcher-temp").join("parts"));
    assert_eq!(startup_stores(&data, Some(&current)).len(), 4);
    // The sweep reaches the earlier root: an old part there goes.
    let expired = PartKey::new(Algo::Sha1, &"d".repeat(40), 100).unwrap();
    fs::write(expired.file(&old, "part"), vec![0u8; 100]).unwrap();
    touch(&expired.file(&old, "part"), KEEP + Duration::from_secs(60));
    sweep_on_startup(startup_stores(&data, Some(&current)));
    assert!(!expired.file(&old, "part").exists(), "the expired part in the earlier root is removed");
    // A folder that is gone while its game folder is still there is dropped;
    // one whose game folder cannot be reached (an unplugged drive) is kept.
    let gone = root.path().join("gone-game").join(".launcher-temp").join("parts");
    fs::create_dir_all(&gone).unwrap();
    remember(&data, &gone);
    fs::remove_dir_all(&gone).unwrap();
    let unreachable = root.path().join("offline-drive").join(".launcher-temp").join("parts");
    remember(&data, &unreachable);
    // The next record looks at both again.
    let later = root.path().join("later-game");
    fs::create_dir_all(&later).unwrap();
    remember(&data, &later);
    let listed = remembered(&data);
    assert!(!listed.contains(&gone) && listed.contains(&unreachable), "{listed:?}");
    // A bounded list: the oldest folders are forgotten first.
    for index in 0..REMEMBERED_MAX + 3 {
        let folder = root.path().join(format!("game-{index}"));
        fs::create_dir_all(&folder).unwrap();
        remember(&data, &folder);
    }
    let kept = remembered(&data);
    assert_eq!(kept.len(), REMEMBERED_MAX);
    assert_eq!(kept.last().unwrap(), &root.path().join(format!("game-{}", REMEMBERED_MAX + 2)));
    assert!(!kept.contains(&old));
    // A damaged or relative list is ignored rather than trusted.
    fs::write(remembered_file(&data), br#"["relative/parts", 7]"#).unwrap();
    assert!(remembered(&data).is_empty());
    fs::write(remembered_file(&data), br#"["relative/parts"]"#).unwrap();
    assert!(remembered(&data).is_empty());
    let leftovers: Vec<_> = fs::read_dir(data.join(".launcher-temp")).unwrap().flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(leftovers, [REMEMBERED], "no temporary file is left");
}

// ---- C11: segmented parallel transfers ----------------------------------

const MIB: usize = 1024 * 1024;

/// Hooks with a connection limit; with `cancel_after`, every checkpoint
/// fails once that many bytes went through.
struct Limited {
    connections: crate::downloads::Connections,
    cancel_after: Option<u64>,
    passed: std::sync::atomic::AtomicU64,
}

impl Limited {
    fn new(limit: usize) -> Self {
        Self { connections: crate::downloads::Connections::new(limit), cancel_after: None, passed: Default::default() }
    }
}

impl Hooks for Limited {
    async fn cancellable<F: std::future::Future>(&self, future: F) -> Result<F::Output, String> {
        Ok(future.await)
    }
    async fn checkpoint(&self) -> Result<(), String> {
        match self.cancel_after {
            Some(after) if self.passed.load(Ordering::SeqCst) >= after => Err("cancelled".into()),
            _ => Ok(()),
        }
    }
    async fn throttle(&self, bytes: usize) -> Result<(), String> {
        self.passed.fetch_add(bytes as u64, Ordering::SeqCst);
        Ok(())
    }
    fn stall_limit(&self) -> Duration {
        STALL
    }
    fn connections(&self) -> Option<&crate::downloads::Connections> {
        Some(&self.connections)
    }
}

fn big(size: usize) -> Vec<u8> {
    (0..size).map(|index| (index.wrapping_mul(31) % 251) as u8).collect()
}

fn sha1_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha1::digest(bytes))
}

/// One transfer of `whole` from `server` into `slot`; returns its result and
/// the SHA-1 of what the hash callback saw.
fn segmented_once(server: &range_server::RangeServer, slot: &mut Option<ResumablePart>, size: u64, hooks: &Limited) -> (Result<(), String>, String) {
    let url = reqwest::Url::parse(&format!("http://{}/file", server.address)).unwrap();
    let client = crate::storage::test_client();
    let mut hasher = Sha1::new();
    let result = tokio::runtime::Runtime::new().unwrap().block_on(transfer(
        client.get(url.clone()),
        &url,
        slot,
        size,
        hooks,
        &|_| Ok(()),
        &mut |bytes| hasher.update(bytes),
    ));
    (result, format!("{:x}", hasher.finalize()))
}

fn big_key(whole: &[u8]) -> PartKey {
    PartKey::new(Algo::Sha1, &sha1_hex(whole), whole.len() as u64).unwrap()
}

/// The closed `bytes=a-b` ranges the server was asked for, sorted.
fn closed_ranges(server: &range_server::RangeServer) -> Vec<(u64, u64)> {
    let mut ranges: Vec<(u64, u64)> = (0..server.count())
        .filter_map(|request| server.range(request))
        .filter_map(|range| {
            let (from, to) = range.strip_prefix("bytes=")?.split_once('-')?;
            Some((from.parse().ok()?, to.parse::<u64>().ok()? + 1))
        })
        .collect();
    ranges.sort();
    ranges
}

#[test]
fn ranges_merge_and_gaps_are_what_is_left() {
    let mut ranges = Vec::new();
    for (from, to) in [(10, 20), (30, 40), (20, 25), (0, 5), (35, 50), (5, 5)] {
        insert_range(&mut ranges, from, to);
    }
    assert_eq!(ranges, [(0, 5), (10, 25), (30, 50)]);
    assert_eq!(gaps(&ranges, 60), [(5, 10), (25, 30), (50, 60)]);
    assert_eq!(gaps(&[], 60), [(0, 60)]);
    assert_eq!(gaps(&[(0, 60)], 60), []);
    // Pieces of about an equal share, each within one gap; a remainder
    // under the floor stays with the piece before it.
    let spans = |pieces: Vec<Piece>| pieces.iter().map(|piece| (piece.start, piece.end)).collect::<Vec<_>>();
    assert_eq!(spans(plan_pieces(&[(0, 100)], 4, 10)), [(0, 25), (25, 50), (50, 75), (75, 100)]);
    assert_eq!(spans(plan_pieces(&[(0, 30), (50, 100)], 2, 20)), [(0, 30), (50, 100)]);
    assert_eq!(spans(plan_pieces(&[(0, 30), (50, 100)], 2, 5)), [(0, 30), (50, 90), (90, 100)]);
    assert_eq!(spans(plan_pieces(&[(0, 3)], 4, 10)), [(0, 3)], "a small gap stays one piece");
    assert!(plan_pieces(&[(0, 100)], 4, 10).iter().all(|piece| piece.state == PieceState::Free));
    // A segment's answer is the same version: the same strong tag, or no other date.
    let tag = |etag: Option<&str>, date: Option<&str>| Validator { origin: "o".into(), etag: etag.map(str::to_owned), last_modified: date.map(str::to_owned) };
    assert!(same_version(&tag(Some("\"a\""), None), &tag(Some("\"a\""), Some("d"))));
    assert!(!same_version(&tag(Some("\"a\""), None), &tag(Some("\"b\""), None)), "another tag");
    assert!(!same_version(&tag(Some("\"a\""), None), &tag(None, None)), "no tag at all");
    assert!(same_version(&tag(None, Some("d")), &tag(None, None)), "a 206 need not repeat the date");
    assert!(!same_version(&tag(None, Some("d")), &tag(Some("\"x\""), None)), "a strong tag where the first answer had none");
    assert!(!same_version(&tag(None, Some("d")), &tag(None, Some("e"))), "another date");
    assert!(!same_version(&tag(None, None), &tag(None, None)), "nothing to compare");
    // A segment continues only on a 206 for exactly its bytes.
    assert_eq!(classify_range(206, Some("bytes 10-19/100"), 10, 19, 100), Reply::Continue);
    assert_eq!(classify_range(206, Some("bytes 0-99/100"), 0, 99, 100), Reply::Continue);
    for (status, range) in [(206, Some("bytes 10-20/100")), (206, Some("bytes 10-19/101")), (206, None), (416, None)] {
        assert_eq!(classify_range(status, range, 10, 19, 100), Reply::Discard(RANGE_MISMATCH.into()), "{status} {range:?}");
    }
    assert_eq!(classify_range(200, None, 10, 19, 100), Reply::Restart);
    assert_eq!(classify_range(503, None, 10, 19, 100), Reply::Fail("下载失败（HTTP 503）".into()));
}

#[test]
fn a_part_with_a_gap_is_recorded_as_separate_ranges_and_reopened() {
    let root = Root::new();
    let store = root.store();
    let size = 100;
    let key = PartKey::new(Algo::Sha1, &"a".repeat(40), size).unwrap();
    {
        let mut part = store.open(&key, size).unwrap().unwrap();
        part.restart(validator("https://a.example", Some("\"v\""))).unwrap();
        part.write_test(0, &[1; 10]).unwrap();
        part.write_test(40, &[2; 20]).unwrap();
        part.sync().unwrap();
    }
    let record: serde_json::Value = serde_json::from_slice(&fs::read(key.file(&store.root, "json")).unwrap()).unwrap();
    assert_eq!(record["version"], 2);
    assert_eq!(record["received"], serde_json::json!([[0, 10], [40, 60]]));
    let part = store.open(&key, size).unwrap().unwrap();
    assert_eq!(part.received(), [(0, 10), (40, 60)]);
    assert_eq!(part.done(), 30);
    assert_eq!(part.resume_for("https://a.example").map(|(start, _)| start), Some(10), "the first missing byte");
    assert_eq!(part.missing(), [(10, 40), (60, 100)]);
    drop(part);
    // Bytes past the last recorded range were never confirmed.
    fs::OpenOptions::new().append(true).open(key.file(&store.root, "part")).unwrap().write_all(&[9; 5]).unwrap();
    let part = store.open(&key, size).unwrap().unwrap();
    assert_eq!(fs::metadata(key.file(&store.root, "part")).unwrap().len(), 60);
    drop(part);
    // A part from the start stays a version-1 record.
    {
        let mut part = store.open(&key, size).unwrap().unwrap();
        part.write_test(10, &[3; 30]).unwrap();
        part.write_test(60, &[4; 40]).unwrap();
        part.sync().unwrap();
    }
    let record: serde_json::Value = serde_json::from_slice(&fs::read(key.file(&store.root, "json")).unwrap()).unwrap();
    assert_eq!((record["version"].clone(), record["done"].clone()), (serde_json::json!(1), serde_json::json!(100)));
    assert!(store.open(&key, size).unwrap().unwrap().complete());
}

#[test]
fn a_record_of_ranges_that_do_not_add_up_starts_the_part_again() {
    let root = Root::new();
    let store = root.store();
    let size = 200;
    let key = PartKey::new(Algo::Sha1, &"b".repeat(40), size).unwrap();
    drop(store.open(&key, size).unwrap().unwrap());
    let origin = serde_json::json!({"origin": "https://a.example", "etag": "\"v\"", "lastModified": null});
    let many: Vec<[u64; 2]> = (0..65u64).map(|n| [2 * n, 2 * n + 1]).collect();
    for (label, received, length) in [
        ("overlapping", serde_json::json!([[0, 30], [20, 40]]), 200),
        ("unsorted", serde_json::json!([[40, 50], [0, 10]]), 200),
        ("touching", serde_json::json!([[0, 10], [10, 20]]), 200),
        ("empty range", serde_json::json!([[10, 10]]), 200),
        ("past the size", serde_json::json!([[190, 220]]), 230),
        ("past the file", serde_json::json!([[0, 10], [85, 90]]), 80),
        ("no range", serde_json::json!([]), 200),
        ("more than the limit", serde_json::json!(many), 200),
    ] {
        let record = serde_json::json!({"version": 2, "size": size, "received": received, "validator": origin});
        fs::write(key.file(&store.root, "json"), serde_json::to_vec(&record).unwrap()).unwrap();
        fs::write(key.file(&store.root, "part"), vec![7u8; length]).unwrap();
        let part = store.open(&key, size).unwrap().unwrap();
        assert_eq!(part.done(), 0, "{label}");
        drop(part);
    }
    // The same ranges within the limits are kept.
    let record = serde_json::json!({"version": 2, "size": size, "received": [[0, 10], [40, 60]], "validator": origin});
    fs::write(key.file(&store.root, "json"), serde_json::to_vec(&record).unwrap()).unwrap();
    fs::write(key.file(&store.root, "part"), vec![7u8; 200]).unwrap();
    assert_eq!(store.open(&key, size).unwrap().unwrap().done(), 30);
}

#[test]
fn a_large_file_is_fetched_in_parallel_ranges_within_the_connection_limit() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    for (limit, expected) in [
        (4usize, vec![(8 * MIB as u64, 16 * MIB as u64), (16 * MIB as u64, 24 * MIB as u64), (24 * MIB as u64, 32 * MIB as u64)]),
        (2, vec![(16 * MIB as u64, 32 * MIB as u64)]),
    ] {
        let root = Root::new();
        let server = RangeServer::repeating(vec![Scripted::ranged(&whole, "\"v\"").accepting_ranges()]);
        let hooks = Limited::new(limit);
        let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
        let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
        result.unwrap();
        assert_eq!(seen, sha1_hex(&whole), "limit {limit}: the hash saw every byte in order");
        assert!(slot.as_ref().unwrap().complete());
        assert_eq!(server.range(0), None, "limit {limit}: the first request asks for the whole file");
        assert_eq!(closed_ranges(&server), expected, "limit {limit}");
        assert_eq!(server.count(), expected.len() + 1, "limit {limit}: nothing was asked for twice");
        for request in 1..server.count() {
            assert_eq!(server.header(request, "if-range").as_deref(), Some("\"v\""), "limit {limit}: a segment asks for the same version");
            let range = server.range(request).unwrap();
            let (from, to) = range.strip_prefix("bytes=").unwrap().split_once('-').unwrap();
            let length = to.parse::<usize>().unwrap() + 1 - from.parse::<usize>().unwrap();
            assert_eq!(server.sent_by(request), length, "limit {limit}: a segment sends exactly its range");
        }
        assert_eq!(hooks.connections.peak(), limit, "limit {limit}: every connection, never more");
        assert_eq!(hooks.connections.in_use(), 0, "limit {limit}: every permit was given back");
        // The finished part publishes as the file.
        let target = root.path().join("file.bin");
        slot.take().unwrap().publish_replace(&target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), whole);
    }
}

#[test]
fn a_file_is_not_split_without_a_spare_connection_its_size_or_a_server_that_takes_ranges() {
    use range_server::{RangeServer, Scripted};
    let large = big(32 * MIB);
    let small = big(SEGMENT_MIN as usize - 1);
    // (label, body, the server says it takes ranges, permits held elsewhere)
    for (label, whole, accepting, held) in [
        ("no spare connection", &large, true, 3usize),
        ("smaller than the threshold", &small, true, 0),
        ("no Accept-Ranges", &large, false, 0),
    ] {
        let root = Root::new();
        let reply = Scripted::ranged(whole, "\"v\"");
        let server = RangeServer::repeating(vec![if accepting { reply.accepting_ranges() } else { reply }]);
        let hooks = Limited::new(4);
        let held: Vec<_> = (0..held).map(|_| hooks.connections.try_acquire_spare().unwrap()).collect();
        let mut slot = root.store().open(&big_key(whole), whole.len() as u64).unwrap();
        let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
        result.unwrap();
        assert_eq!(seen, sha1_hex(whole), "{label}");
        assert_eq!(server.count(), 1, "{label}: one stream");
        drop(held);
    }
}

#[test]
fn a_server_that_refuses_a_segment_gets_the_rest_in_one_stream() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    // The first answer stops after the first piece; the segments get the
    // whole file instead of their ranges; later answers follow the Range.
    let refused = Scripted::ok(&whole, "\"v\"");
    let server = RangeServer::repeating(vec![
        Scripted::ranged(&whole, "\"v\"").accepting_ranges().cut(8 * MIB),
        refused.clone(),
        refused.clone(),
        refused,
        Scripted::ranged(&whole, "\"v\"").accepting_ranges(),
    ]);
    let hooks = Limited::new(4);
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole), "one attempt finishes the file");
    assert_eq!(server.count(), 5, "the first answer, three refused segments and one more stream");
    assert_eq!(server.range(4).as_deref(), Some("bytes=8388608-"), "the rest in one stream from the first missing byte");
    assert!(slot.as_ref().unwrap().whole_only, "this download is not split again");
}

#[test]
fn a_refusal_after_the_first_response_stopped_is_finished_in_one_more_stream() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    // The first answer takes its piece at once; the segments are refused
    // only after it has stopped; the rest then follows the Range.
    let late = Scripted::ok(&whole, "\"v\"").delayed(Duration::from_millis(400));
    let server = RangeServer::repeating(vec![
        Scripted::ranged(&whole, "\"v\"").accepting_ranges(),
        late.clone(),
        late.clone(),
        late,
        Scripted::ranged(&whole, "\"v\"").accepting_ranges(),
    ]);
    let hooks = Limited::new(4);
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole), "one attempt finishes the file");
    assert_eq!(server.count(), 5);
    assert_eq!(server.range(4).as_deref(), Some("bytes=8388608-"), "the rest in one stream from the first missing byte");
    assert_eq!(server.header(4, "if-range").as_deref(), Some("\"v\""));
    assert!(slot.as_ref().unwrap().whole_only, "this download is not split again");
}

#[test]
fn a_segment_that_breaks_off_is_finished_after_the_segments() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    // Every segment answers late and closes after 1 MiB of its 8 MiB; by
    // then the first answer has stopped at its piece (its neighbours were
    // taken), so what is missing comes in one more stream.
    let broken = Scripted::ranged(&whole, "\"v\"").accepting_ranges().delayed(Duration::from_millis(300)).cut(MIB);
    let server = RangeServer::repeating(vec![
        Scripted::ranged(&whole, "\"v\"").accepting_ranges(),
        broken.clone(),
        broken.clone(),
        broken,
        Scripted::ranged(&whole, "\"v\"").accepting_ranges(),
    ]);
    let hooks = Limited::new(4);
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole));
    assert_eq!(server.count(), 5);
    assert_eq!(server.range(4).as_deref(), Some("bytes=9437184-"), "one stream from the first byte a segment left missing");
    assert!(!slot.as_ref().unwrap().whole_only, "a break is not a refusal");
}

#[test]
fn a_segment_that_fails_with_a_server_error_is_not_a_refusal() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    let failing = Scripted::status(503).delayed(Duration::from_millis(300));
    let server = RangeServer::repeating(vec![
        Scripted::ranged(&whole, "\"v\"").accepting_ranges(),
        failing.clone(),
        failing.clone(),
        failing,
        Scripted::ranged(&whole, "\"v\"").accepting_ranges(),
    ]);
    let hooks = Limited::new(4);
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole));
    assert_eq!(server.range(4).as_deref(), Some("bytes=8388608-"), "what the segments missed came in one more stream");
    assert!(!slot.as_ref().unwrap().whole_only, "a 503 says nothing about ranges: the next download may split");
}

#[test]
fn a_segment_from_an_untrusted_answer_fails_the_transfer() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    let server = RangeServer::repeating(vec![Scripted::ranged(&whole, "\"v\"").accepting_ranges()]);
    let hooks = Limited::new(4);
    let url = reqwest::Url::parse(&format!("http://{}/file", server.address)).unwrap();
    let client = crate::storage::test_client();
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    // The caller's check refuses every segment's answer (as it would refuse a
    // redirect to an untrusted host); the first answer passes it.
    let check = |response: &reqwest::Response| if response.status() == 206 { Err("untrusted answer".to_owned()) } else { Ok(()) };
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(transfer(client.get(url.clone()), &url, &mut slot, whole.len() as u64, &hooks, &check, &mut |_| {}));
    assert_eq!(result.unwrap_err(), "untrusted answer", "a single stream would fail the same way");
    assert_eq!(hooks.connections.in_use(), 0);
}

#[test]
fn a_resumed_answer_that_ends_where_kept_bytes_begin_is_still_hashed_in_full() {
    use range_server::{RangeServer, Scripted};
    let whole = big(4 * MIB);
    let root = Root::new();
    let key = big_key(&whole);
    let server_whole = whole.clone();
    // Kept: [0, 1 MiB) and [3 MiB, 4 MiB). The 206 for the rest ends cleanly
    // after the missing middle.
    let partial = Scripted::partial(&server_whole, MIB, "\"v\"").with_body(whole[MIB..3 * MIB].to_vec()).without_length();
    let server = RangeServer::new(vec![partial]);
    let mut slot = root.store().open(&key, whole.len() as u64).unwrap();
    {
        let part = slot.as_mut().unwrap();
        part.restart(validator(&format!("http://{}", server.address), Some("\"v\""))).unwrap();
        part.write_test(0, &whole[..MIB]).unwrap();
        part.write_test(3 * MIB as u64, &whole[3 * MIB..]).unwrap();
    }
    let url = reqwest::Url::parse(&format!("http://{}/file", server.address)).unwrap();
    let client = crate::storage::test_client();
    let mut hasher = Sha1::new();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(transfer(client.get(url.clone()), &url, &mut slot, whole.len() as u64, &Plain, &|_| Ok(()), &mut |bytes| hasher.update(bytes)))
        .unwrap();
    assert_eq!(server.range(0).as_deref(), Some("bytes=1048576-"));
    assert_eq!(format!("{:x}", hasher.finalize()), sha1_hex(&whole), "the kept tail is hashed too");
    assert!(slot.as_ref().unwrap().complete());
}

#[test]
fn a_small_gap_is_left_to_the_first_response_not_a_segment() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    let server = RangeServer::repeating(vec![Scripted::ranged(&whole, "\"v\"").accepting_ranges()]);
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    // Missing: [8, 16), [20, 21) and [24, 32) MiB.
    {
        let part = slot.as_mut().unwrap();
        part.restart(validator(&format!("http://{}", server.address), Some("\"v\""))).unwrap();
        for (from, to) in [(0, 8), (16, 20), (21, 24)] {
            part.write_test((from * MIB) as u64, &whole[from * MIB..to * MIB]).unwrap();
        }
    }
    let hooks = Limited::new(4);
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole));
    assert_eq!(server.range(0).as_deref(), Some("bytes=8388608-"));
    assert_eq!(closed_ranges(&server), [(24 * MIB as u64, 32 * MIB as u64)], "no segment for the 1 MiB gap");
}

#[test]
fn a_download_marked_whole_only_is_not_split_again() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    let server = RangeServer::repeating(vec![Scripted::ranged(&whole, "\"v\"").accepting_ranges()]);
    let hooks = Limited::new(4);
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    slot.as_mut().unwrap().whole_only = true;
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole));
    assert_eq!(server.count(), 1, "a server that refused a segment gets one stream");
}

#[test]
fn a_file_without_a_validator_is_not_split_and_the_threshold_itself_is() {
    use range_server::{RangeServer, Scripted};
    let root = Root::new();
    // No ETag and no date: segments could not ask for the same version.
    let whole = big(32 * MIB);
    let server = RangeServer::repeating(vec![Scripted::ranged(&whole, "\"v\"").accepting_ranges().with_headers(Vec::new())]);
    let hooks = Limited::new(4);
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole));
    assert_eq!(server.count(), 1, "no validator: one stream");
    // Exactly SEGMENT_MIN is split.
    let whole = big(SEGMENT_MIN as usize);
    let server = RangeServer::repeating(vec![Scripted::ranged(&whole, "\"v\"").accepting_ranges()]);
    let hooks = Limited::new(4);
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole));
    assert_eq!(server.count(), 4, "16 MiB in four pieces of 4 MiB");
}

#[test]
fn a_long_segmented_download_records_its_ranges_while_it_runs() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    let store = root.store();
    let key = big_key(&whole);
    // About 2.5 s per 8 MiB piece: long enough for records to fall due.
    let slow = Scripted::ranged(&whole, "\"v\"").accepting_ranges().paced(64 * 1024, Duration::from_millis(20));
    let server = RangeServer::repeating(vec![slow]);
    let hooks = Limited::new(4);
    let sidecar = key.file(store.root(), "json");
    let watching = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let watcher = {
        let (sidecar, watching) = (sidecar.clone(), watching.clone());
        std::thread::spawn(move || {
            while watching.load(Ordering::SeqCst) {
                if let Some(record) = read_ranges(&sidecar).filter(|record| record.version == 2 && record.received.len() > 1) {
                    return Some(record.received);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            None
        })
    };
    let mut slot = store.open(&key, whole.len() as u64).unwrap();
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    watching.store(false, Ordering::SeqCst);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole));
    let recorded = watcher.join().unwrap().expect("separate ranges were recorded while the segments ran");
    assert!(recorded.iter().all(|&[from, to]| from < to && to <= whole.len() as u64), "{recorded:?}");
}

#[test]
fn a_dropped_segmented_download_keeps_its_ranges() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    let store = root.store();
    let key = big_key(&whole);
    let slow = Scripted::ranged(&whole, "\"v\"").accepting_ranges().paced(64 * 1024, Duration::from_millis(5));
    let server = RangeServer::repeating(vec![slow]);
    let hooks = Limited::new(4);
    let url = reqwest::Url::parse(&format!("http://{}/file", server.address)).unwrap();
    let client = crate::storage::test_client();
    let mut slot = store.open(&key, whole.len() as u64).unwrap();
    // A sibling failure drops the whole transfer future, segments included.
    let outcome = tokio::runtime::Runtime::new().unwrap().block_on(async {
        tokio::time::timeout(
            Duration::from_millis(600),
            transfer(client.get(url.clone()), &url, &mut slot, whole.len() as u64, &hooks, &|_| Ok(()), &mut |_| {}),
        )
        .await
    });
    assert!(outcome.is_err(), "the transfer was dropped before it finished");
    assert_eq!(hooks.connections.in_use(), 0, "every permit was given back");
    drop(slot);
    let reopened = store.open(&key, whole.len() as u64).unwrap().unwrap();
    assert!(reopened.received().len() > 1, "the ranges of every segment were kept: {:?}", reopened.received());
}

#[test]
fn a_cancelled_segmented_download_keeps_its_ranges_and_fetches_only_what_is_missing() {
    use range_server::{RangeServer, Scripted};
    let whole = big(32 * MIB);
    let root = Root::new();
    let store = root.store();
    let key = big_key(&whole);
    // One server for both runs: a resume goes back to the same origin.
    let slow = Scripted::ranged(&whole, "\"v\"").accepting_ranges().paced(64 * 1024, Duration::from_millis(2));
    let server = RangeServer::repeating(vec![slow]);
    let mut hooks = Limited::new(4);
    hooks.cancel_after = Some(12 * MIB as u64);
    let mut slot = store.open(&key, whole.len() as u64).unwrap();
    let (result, _) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    assert_eq!(result.unwrap_err(), "cancelled");
    assert_eq!(hooks.connections.in_use(), 0);
    drop(slot);
    let reopened = store.open(&key, whole.len() as u64).unwrap().unwrap();
    let kept = reopened.received().to_vec();
    assert!(kept.len() >= 2, "the bytes of the segments were kept: {kept:?}");
    let starts = [0, 8, 16, 24].map(|start| start * MIB as u64);
    assert!(kept.iter().all(|&(from, to)| starts.contains(&from) && to > from), "each kept range starts at a piece: {kept:?}");
    let missing = reopened.missing();
    drop(reopened);
    let earlier = server.count();
    let hooks = Limited::new(4);
    let mut slot = store.open(&key, whole.len() as u64).unwrap();
    let (result, seen) = segmented_once(&server, &mut slot, whole.len() as u64, &hooks);
    result.unwrap();
    assert_eq!(seen, sha1_hex(&whole), "the finished part is hashed in order");
    assert_eq!(server.range(earlier), Some(format!("bytes={}-", missing[0].0)), "the first request starts at the first missing byte");
    assert_eq!(server.header(earlier, "if-range").as_deref(), Some("\"v\""));
    let later: Vec<(u64, u64)> = (earlier + 1..server.count())
        .filter_map(|request| server.range(request))
        .filter_map(|range| {
            let (from, to) = range.strip_prefix("bytes=")?.split_once('-')?;
            Some((from.parse().ok()?, to.parse::<u64>().ok()? + 1))
        })
        .collect();
    assert!(!later.is_empty(), "the rest was fetched in segments too");
    for (from, to) in later {
        assert!(missing.iter().any(|&(gap_from, gap_to)| from >= gap_from && to <= gap_to), "{from}-{to} lies in a missing range {missing:?}");
    }
    let target = root.path().join("file.bin");
    slot.take().unwrap().publish_replace(&target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), whole);
}

#[test]
fn transfers_together_never_hold_more_connections_than_the_limit() {
    use range_server::{RangeServer, Scripted};
    let first = big(32 * MIB);
    let mut second = big(32 * MIB);
    second.reverse();
    let root = Root::new();
    let hooks = Limited::new(3);
    let servers = [&first, &second].map(|whole| RangeServer::repeating(vec![Scripted::ranged(whole, "\"v\"").accepting_ranges().paced(256 * 1024, Duration::from_millis(1))]));
    let mut slots = [&first, &second].map(|whole| root.store().open(&big_key(whole), whole.len() as u64).unwrap());
    let client = crate::storage::test_client();
    let urls = servers.each_ref().map(|server| reqwest::Url::parse(&format!("http://{}/file", server.address)).unwrap());
    let [slot_a, slot_b] = &mut slots;
    let results = tokio::runtime::Runtime::new().unwrap().block_on(futures_util::future::join(
        transfer(client.get(urls[0].clone()), &urls[0], slot_a, first.len() as u64, &hooks, &|_| Ok(()), &mut |_| {}),
        transfer(client.get(urls[1].clone()), &urls[1], slot_b, second.len() as u64, &hooks, &|_| Ok(()), &mut |_| {}),
    ));
    results.0.unwrap();
    results.1.unwrap();
    assert!(hooks.connections.peak() <= 3, "peak {}", hooks.connections.peak());
    assert_eq!(servers[0].count() + servers[1].count(), 3, "two first requests and one spare segment");
}

#[test]
fn progress_follows_the_bytes_in_place_not_the_in_order_hash() {
    use range_server::{RangeServer, Scripted};
    use std::sync::atomic::{AtomicBool, AtomicU64};
    let whole = big(32 * MIB);
    let root = Root::new();
    let server = RangeServer::repeating(vec![Scripted::ranged(&whole, "\"v\"").accepting_ranges()]);
    let limited = Limited::new(4);
    let hashed = AtomicU64::new(0);
    let ahead = AtomicBool::new(false);
    let last = std::sync::Mutex::new(0u64);
    let report = |done: u64| {
        let mut previous = last.lock().unwrap();
        assert!(done >= *previous, "progress never goes back: {done} after {previous}");
        *previous = done;
        if done > hashed.load(Ordering::SeqCst) + 4 * MIB as u64 {
            ahead.store(true, Ordering::SeqCst);
        }
    };
    let reporting = Reporting { hooks: &limited, report: &report };
    let url = reqwest::Url::parse(&format!("http://{}/file", server.address)).unwrap();
    let client = crate::storage::test_client();
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(transfer(client.get(url.clone()), &url, &mut slot, whole.len() as u64, &reporting, &|_| Ok(()), &mut |bytes| {
            hashed.fetch_add(bytes.len() as u64, Ordering::SeqCst);
        }))
        .unwrap();
    assert!(ahead.load(Ordering::SeqCst), "segments are reported as they land, before the hash reads them");
    assert_eq!(*last.lock().unwrap(), whole.len() as u64);
    assert_eq!(hashed.load(Ordering::SeqCst), whole.len() as u64);
}

#[test]
fn a_task_download_is_split_on_the_task_connections() {
    use range_server::{RangeServer, Scripted};
    // The hooks the modpack, Modrinth and CurseForge downloads pass.
    let whole = big(32 * MIB);
    let root = Root::new();
    let server = RangeServer::repeating(vec![Scripted::ranged(&whole, "\"v\"").accepting_ranges()]);
    let control = crate::downloads::DownloadControl::default();
    control.set_concurrency(3);
    let url = reqwest::Url::parse(&format!("http://{}/file", server.address)).unwrap();
    let client = crate::storage::test_client();
    let mut slot = root.store().open(&big_key(&whole), whole.len() as u64).unwrap();
    let mut hasher = Sha1::new();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(transfer(client.get(url.clone()), &url, &mut slot, whole.len() as u64, &&control, &|_| Ok(()), &mut |bytes| hasher.update(bytes)))
        .unwrap();
    assert_eq!(format!("{:x}", hasher.finalize()), sha1_hex(&whole));
    assert_eq!(server.count(), 3, "the first request and two segments");
    assert_eq!(control.connections().peak(), 3);
    assert_eq!(control.connections().in_use(), 0);
}

#[test]
fn every_one_go_file_request_waits_for_a_connection_first() {
    for (name, text, function, permit, send) in [
        ("minecraft.rs", include_str!("minecraft.rs"), "async fn download_once(", "crate::parts::connection(&policy).await?", "request.send()"),
        ("modpacks.rs", include_str!("modpacks.rs"), "async fn fetch_whole(", "crate::parts::connection(&control).await?", "request.send()"),
        ("resources.rs", include_str!("resources.rs"), "async fn download_verified_progress(", "state.control.connection().await?", "client.get(url.clone()).send()"),
        ("curseforge.rs", include_str!("curseforge.rs"), "async fn download(", "state.control.connection().await?", "during_cancellable_io(client.get(url).send())"),
    ] {
        let source = crate::storage::executable_source(text);
        let body = source.split_once(function).unwrap_or_else(|| panic!("{name}: {function}")).1;
        let body = body.split_once("
}").map_or(body, |(body, _)| body);
        let waits = body.find(permit).unwrap_or_else(|| panic!("{name}: no connection before the request"));
        let sends = body.find(send).unwrap_or_else(|| panic!("{name}: {send}"));
        assert!(waits < sends, "{name}: the connection is taken before the request");
    }
}
