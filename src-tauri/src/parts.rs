//! Resumable download parts (U0266): one stream per file, and for a large
//! file several Range requests at once.
//!
//! A part is named by the file's expected hash and size, so a later attempt
//! (after a failure, a cancel or a restart of the launcher) continues where the
//! last one stopped. A sidecar records which bytes are in place and the
//! origin and validator they came from; a resume is asked for only from the
//! same origin with `If-Range`, and anything unexpected starts again from zero.
//! The whole part is always hashed before publication, so a part is only ever
//! a hint. Parts live outside every target, staged or journaled directory.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime},
};

/// Smaller files are downloaded in one go, as before.
pub(crate) const RESUME_MIN: u64 = 1024 * 1024;
/// Parts nobody resumed for this long are removed at startup.
pub(crate) const KEEP: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// Above this total, the oldest unlocked parts are removed first.
pub(crate) const CAP: u64 = 4 * 1024 * 1024 * 1024;
const SIDECAR_MAX: u64 = 4 * 1024;
/// The record is rewritten after this many new bytes (and when the part stops).
const RECORD_EVERY: u64 = 4 * 1024 * 1024;
/// ...and at most once a second, since each record flushes the data.
const RECORD_GAP: Duration = Duration::from_secs(1);
/// Kept bytes are hashed in pieces of this size, with an await between them.
const PREFIX_CHUNK: u64 = 8 * 1024 * 1024;
const EXTENSIONS: [&str; 4] = ["part", "json", "json.tmp", "lock"];
/// Files at least this large are fetched as several ranges at once.
pub(crate) const SEGMENT_MIN: u64 = 16 * 1024 * 1024;
/// Requests per file at most, the first one included.
pub(crate) const SEGMENTS: usize = 4;
/// A segment is never smaller than this.
const SEGMENT_FLOOR: u64 = 4 * 1024 * 1024;
/// A sidecar records at most this many separate ranges.
const RANGES_MAX: usize = 64;
/// The file was received in several ranges and some are still missing.
pub(crate) const SEGMENTS_UNFINISHED: &str = "分段下载未完成";
pub(crate) const RANGE_MISMATCH: &str = "续传响应的范围与请求不符";
/// The answer declares another size than the metadata: no retry changes that.
pub(crate) const SIZE_MISMATCH: &str = "下载大小与元数据不一致";
/// More bytes arrived than the metadata promised.
pub(crate) const OVERRUN: &str = "下载文件超出预期大小";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Algo {
    Sha1,
    Sha512,
}

/// `<algo>-<hex>-<size>`: the strongest expected digest and the exact size.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PartKey(String);

impl PartKey {
    pub(crate) fn new(algo: Algo, hex: &str, size: u64) -> Option<Self> {
        let (name, length) = match algo {
            Algo::Sha1 => ("sha1", 40),
            Algo::Sha512 => ("sha512", 128),
        };
        (size > 0 && hex.len() == length && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| Self(format!("{name}-{}-{size}", hex.to_ascii_lowercase())))
    }

    /// Only names `new` writes: lowercase hex and a canonical size.
    fn parse(name: &str) -> Option<Self> {
        let mut fields = name.splitn(3, '-');
        let algo = match fields.next()? {
            "sha1" => Algo::Sha1,
            "sha512" => Algo::Sha512,
            _ => return None,
        };
        let hex = fields.next()?;
        let size = fields.next()?.parse().ok()?;
        Self::new(algo, hex, size).filter(|key| key.0 == name)
    }

    pub(crate) fn file(&self, root: &Path, extension: &str) -> PathBuf {
        root.join(format!("{}.{extension}", self.0))
    }
}

/// Where the bytes in a part came from: a resume is asked for only from the
/// same origin, with this validator in `If-Range`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Validator {
    pub(crate) origin: String,
    /// A strong entity tag (a weak tag cannot be used in `If-Range`).
    pub(crate) etag: Option<String>,
    pub(crate) last_modified: Option<String>,
}

impl Validator {
    /// From a response to a request sent to `requested` (the candidate, not
    /// where a redirect led).
    pub(crate) fn of(requested: &reqwest::Url, headers: &reqwest::header::HeaderMap) -> Self {
        let header = |name: reqwest::header::HeaderName| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 256)
                .map(str::to_owned)
        };
        Self {
            origin: origin(requested),
            etag: header(reqwest::header::ETAG).filter(|tag| tag.len() >= 2 && tag.starts_with('"') && tag.ends_with('"')),
            last_modified: header(reqwest::header::LAST_MODIFIED),
        }
    }

    /// The `If-Range` value: the strong tag, else the date.
    fn if_range(&self) -> Option<&str> {
        self.etag.as_deref().or(self.last_modified.as_deref())
    }
}

/// `scheme://host[:port]` of a URL.
pub(crate) fn origin(url: &reqwest::Url) -> String {
    url.origin().ascii_serialization()
}

/// The record of a part received from the start: `done` bytes in place.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sidecar {
    version: u32,
    size: u64,
    done: u64,
    validator: Validator,
}

/// The record of a part received in separate ranges (version 2), written
/// only when a range is missing before another one: a part from the start
/// keeps version 1.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SidecarRanges {
    version: u32,
    size: u64,
    received: Vec<[u64; 2]>,
    validator: Validator,
}

/// Sorted, separate, non-empty ranges within `size` and the file length, or
/// None.
fn checked_ranges(received: &[[u64; 2]], size: u64, length: u64) -> Option<Vec<(u64, u64)>> {
    if received.is_empty() || received.len() > RANGES_MAX {
        return None;
    }
    let mut ranges: Vec<(u64, u64)> = Vec::with_capacity(received.len());
    for &[start, end] in received {
        if start >= end || end > size || end > length || ranges.last().is_some_and(|&(_, last)| start <= last) {
            return None;
        }
        ranges.push((start, end));
    }
    Some(ranges)
}

/// Adds `[start, end)` to sorted, separate ranges, merging what touches it.
fn insert_range(ranges: &mut Vec<(u64, u64)>, start: u64, end: u64) {
    if start >= end {
        return;
    }
    let (mut start, mut end) = (start, end);
    let mut kept = Vec::with_capacity(ranges.len() + 1);
    for &(from, to) in ranges.iter() {
        if to < start || from > end {
            kept.push((from, to));
        } else {
            start = start.min(from);
            end = end.max(to);
        }
    }
    let at = kept.partition_point(|&(from, _)| from < start);
    kept.insert(at, (start, end));
    *ranges = kept;
}

/// The bytes of `[0, size)` not covered by `ranges`.
fn gaps(ranges: &[(u64, u64)], size: u64) -> Vec<(u64, u64)> {
    let mut gaps = Vec::new();
    let mut at = 0;
    for &(from, to) in ranges {
        if from > at {
            gaps.push((at, from));
        }
        at = at.max(to);
    }
    if at < size {
        gaps.push((at, size));
    }
    gaps
}

/// Writes all of `bytes` at `offset`, whatever the file position.
fn write_at(file: &fs::File, mut offset: u64, mut bytes: &[u8]) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        while !bytes.is_empty() {
            let written = file.seek_write(bytes, offset)?;
            if written == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            bytes = &bytes[written..];
            offset += written as u64;
        }
        Ok(())
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        let _ = &mut bytes;
        let _ = &mut offset;
        file.write_all_at(bytes, offset)
    }
}

/// Reads up to `buffer.len()` bytes at `offset`, whatever the file position.
fn read_at(file: &fs::File, buffer: &mut [u8], offset: u64) -> io::Result<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(buffer, offset)
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buffer, offset)
    }
}

/// What a response to a part request means for the part.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reply {
    /// 206 for exactly the missing bytes: append.
    Continue,
    /// 200 with the whole file: start the part again.
    Restart,
    /// The server disagrees about the bytes kept (another range, or a start
    /// past its file): the part is discarded.
    Discard(String),
    /// Any other failure: the part is kept for the next attempt.
    Fail(String),
}

/// Classifies a response to a request for `offset..` of a `size`-byte file
/// (offset 0: no Range was sent).
pub(crate) fn classify(status: u16, content_range: Option<&str>, offset: u64, size: u64) -> Reply {
    let exact = size > 0 && content_range == Some(format!("bytes {offset}-{}/{size}", size - 1).as_str());
    match status {
        200 => Reply::Restart,
        206 if offset > 0 && exact => Reply::Continue,
        206 | 416 => Reply::Discard(RANGE_MISMATCH.into()),
        status => Reply::Fail(format!("下载失败（HTTP {status}）")),
    }
}

/// Classifies a response to a request for `from..=to` of a `size`-byte file:
/// only a 206 for exactly those bytes continues.
pub(crate) fn classify_range(status: u16, content_range: Option<&str>, from: u64, to: u64, size: u64) -> Reply {
    let exact = size > 0 && to < size && content_range == Some(format!("bytes {from}-{to}/{size}").as_str());
    match status {
        200 => Reply::Restart,
        206 if exact => Reply::Continue,
        206 | 416 => Reply::Discard(RANGE_MISMATCH.into()),
        status => Reply::Fail(format!("下载失败（HTTP {status}）")),
    }
}

/// A directory of parts on the same volume as the files they become.
#[derive(Clone, Debug)]
pub(crate) struct PartStore {
    root: PathBuf,
}

impl PartStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Opens the part for `key`, or None when another download (in this or
    /// another launcher) holds it; the caller then uses a part of its own. A
    /// part whose record does not add up starts again from zero.
    pub(crate) fn open(&self, key: &PartKey, size: u64) -> io::Result<Option<ResumablePart>> {
        crate::instances::checked_absolute(&self.root).map_err(io::Error::other)?;
        fs::create_dir_all(&self.root)?;
        crate::instances::checked_absolute(&self.root).map_err(io::Error::other)?;
        let lock = lock_options().create(true).truncate(false).open(key.file(&self.root, "lock"))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => return Ok(None),
            Err(fs::TryLockError::Error(error)) => return Err(error),
        }
        let part = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(key.file(&self.root, "part"))?;
        let length = part.metadata()?.len();
        let sidecar = key.file(&self.root, "json");
        let (received, validator) = match read_sidecar(&sidecar) {
            Some(record) if record.version == 1 && record.size == size && record.done <= size && record.done <= length => {
                (if record.done > 0 { vec![(0, record.done)] } else { Vec::new() }, record.validator)
            }
            Some(_) => (Vec::new(), Validator::default()),
            None => match read_ranges(&sidecar) {
                Some(record) if record.version == 2 && record.size == size => {
                    match checked_ranges(&record.received, size, length) {
                        Some(ranges) => (ranges, record.validator),
                        None => (Vec::new(), Validator::default()),
                    }
                }
                _ => (Vec::new(), Validator::default()),
            },
        };
        // Bytes past the last recorded range were never confirmed.
        let end = received.last().map_or(0, |&(_, end)| end);
        if length != end {
            part.set_len(end)?;
        }
        Ok(Some(ResumablePart {
            root: self.root.clone(),
            key: key.clone(),
            size,
            lock: Some(lock),
            part: Some(part),
            received,
            validator,
            unrecorded: 0,
            last_record: Instant::now(),
            restarts: 0,
            whole_only: false,
            finished: false,
        }))
    }

    /// Removes this folder's parts nobody holds that are older than `keep`,
    /// then the oldest unlocked ones while the total is above `cap`.
    pub(crate) fn sweep(&self, now: SystemTime, keep: Duration, cap: u64) {
        sweep(std::slice::from_ref(self), now, keep, cap);
    }

    /// Removes expired unlocked parts and returns the others as (newest
    /// modification, bytes, key). Only exact part names are touched, and
    /// nothing is done through a link.
    fn expire(&self, now: SystemTime, keep: Duration) -> Vec<(SystemTime, u64, PartKey)> {
        if crate::instances::validate_absolute_syntax(&self.root).is_err() || !ordinary_tree(&self.root) {
            return Vec::new();
        }
        let Ok(entries) = fs::read_dir(&self.root) else { return Vec::new() };
        let mut groups: std::collections::BTreeMap<String, (PartKey, Vec<fs::Metadata>)> = Default::default();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(stem) = EXTENSIONS.iter().find_map(|extension| name.strip_suffix(&format!(".{extension}"))) else {
                continue;
            };
            let Some(key) = PartKey::parse(stem) else { continue };
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else { continue };
            if !metadata.is_file() || !ordinary(&metadata) {
                continue;
            }
            groups.entry(key.0.clone()).or_insert_with(|| (key, Vec::new())).1.push(metadata);
        }
        let mut kept = Vec::new();
        for (_, (key, files)) in groups {
            let newest = files.iter().filter_map(|metadata| metadata.modified().ok()).max().unwrap_or(now);
            let bytes: u64 = files.iter().map(fs::Metadata::len).sum();
            let expired = now.duration_since(newest).is_ok_and(|age| age >= keep);
            if expired && self.remove_unlocked(&key) {
                continue;
            }
            kept.push((newest, bytes, key));
        }
        kept
    }

    /// Removes the key's files while holding its lock; false when it is in use.
    fn remove_unlocked(&self, key: &PartKey) -> bool {
        let lock_path = key.file(&self.root, "lock");
        // Created if missing: a download that starts now finds this lock held.
        let Ok(lock) = lock_options().create(true).truncate(false).open(&lock_path) else { return false };
        if lock.try_lock().is_err() {
            return false;
        }
        for extension in ["part", "json", "json.tmp"] {
            let _ = fs::remove_file(key.file(&self.root, extension));
        }
        release_lock(lock, &lock_path);
        true
    }

    /// Removes every part of this folder that no download holds, returning the
    /// bytes of part data that were freed. The lock is the ownership rule: a
    /// part another task (in this or another launcher) holds is kept. Only
    /// exact part names are touched, and nothing is done through a link.
    pub(crate) fn remove_unreferenced(&self) -> u64 {
        if crate::instances::validate_absolute_syntax(&self.root).is_err() || !ordinary_tree(&self.root) {
            return 0;
        }
        let Ok(entries) = fs::read_dir(&self.root) else { return 0 };
        let mut groups: std::collections::BTreeMap<String, (PartKey, u64)> = Default::default();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some(stem) = EXTENSIONS.iter().find_map(|extension| name.strip_suffix(&format!(".{extension}"))) else {
                continue;
            };
            let Some(key) = PartKey::parse(stem) else { continue };
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else { continue };
            if !metadata.is_file() || !ordinary(&metadata) {
                continue;
            }
            let group = groups.entry(key.0.clone()).or_insert_with(|| (key, 0));
            if name.ends_with(".part") {
                group.1 += metadata.len();
            }
        }
        groups
            .into_values()
            .filter_map(|(key, bytes)| self.remove_unlocked(&key).then_some(bytes))
            .sum()
    }

    /// Takes back a verified `file` of `size` bytes that a download moved out
    /// of its part, as a complete part: the next download only checks it.
    /// Best effort: false when the part is in use or the file cannot be moved
    /// here (it then goes with the stage it was in).
    pub(crate) fn adopt(&self, key: &PartKey, size: u64, file: &Path) -> bool {
        if fs::symlink_metadata(file).map_or(true, |stat| !stat.is_file() || stat.len() != size) {
            return false;
        }
        let Ok(Some(mut part)) = self.open(key, size) else { return false };
        drop(part.part.take());
        // The verified file replaces whatever the part held.
        if fs::rename(file, key.file(&self.root, "part")).is_err() {
            return false;
        }
        part.received = vec![(0, size)];
        part.validator = Validator::default();
        part.record().is_ok()
    }
}

/// Verified downloads moved from their parts into a stage. If the stage is
/// not committed they go back to their parts, complete, so the next install
/// does not download them again.
pub(crate) struct Reuse {
    store: PartStore,
    moved: std::sync::Mutex<Vec<(PartKey, u64, PathBuf)>>,
}

impl Reuse {
    pub(crate) fn new(store: PartStore) -> Self {
        Self { store, moved: Default::default() }
    }

    pub(crate) fn store(&self) -> &PartStore {
        &self.store
    }

    fn list(&self) -> std::sync::MutexGuard<'_, Vec<(PartKey, u64, PathBuf)>> {
        self.moved.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A verified part became `file`.
    pub(crate) fn add(&self, key: &PartKey, size: u64, file: &Path) {
        self.list().push((key.clone(), size, file.to_path_buf()));
    }

    /// A listed file was renamed in the stage.
    pub(crate) fn moved(&self, from: &Path, to: &Path) {
        for (_, _, file) in self.list().iter_mut().filter(|(_, _, file)| file == from) {
            *file = to.to_path_buf();
        }
    }

    /// The stage will not be committed: every listed file still there goes
    /// back to its part.
    pub(crate) fn restore(&self) {
        for (key, size, file) in std::mem::take(&mut *self.list()) {
            self.store.adopt(&key, size, &file);
        }
    }
}

/// Lock files are opened without FILE_SHARE_DELETE, so the name cannot be
/// removed while anyone (even an opener that has not locked it yet) holds a
/// handle: the path always names the one file whose lock excludes others.
fn lock_options() -> fs::OpenOptions {
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ | FILE_SHARE_WRITE, as the profile lock (storage.rs).
        options.share_mode(0x1 | 0x2);
    }
    options
}

/// Releases a lock, then removes its name if nobody else has it open. A
/// failed removal (someone just opened it) is harmless: the name stays with
/// the file that opener will lock. Elsewhere the name is kept, because an
/// open handle does not stop an unlink there.
fn release_lock(lock: fs::File, path: &Path) {
    drop(lock);
    if cfg!(windows) {
        let _ = fs::remove_file(path);
    }
}

/// Removes parts nobody resumed for `keep`, then, oldest first, unlocked parts
/// while all the folders together hold more than `cap`.
pub(crate) fn sweep(stores: &[PartStore], now: SystemTime, keep: Duration, cap: u64) {
    // The game root may be the data directory: list each folder once.
    let mut seen = std::collections::HashSet::new();
    let mut kept: Vec<_> = stores
        .iter()
        .enumerate()
        .filter(|(_, store)| fs::canonicalize(store.root()).map_or(true, |real| seen.insert(real)))
        .flat_map(|(index, store)| store.expire(now, keep).into_iter().map(move |part| (part, index)))
        .collect();
    let mut total: u64 = kept.iter().map(|((_, bytes, _), _)| bytes).sum();
    kept.sort_by_key(|((newest, ..), _)| *newest);
    for ((_, bytes, key), index) in kept {
        if total <= cap {
            break;
        }
        if stores[index].remove_unlocked(&key) {
            total = total.saturating_sub(bytes);
        }
    }
}

/// Removes every part in `stores` that no download holds, returning the bytes
/// of part data freed. A folder reachable by several store entries is listed
/// once. This never removes a part whose lock is held, so a paused task's or
/// another launcher's part is safe.
pub(crate) fn remove_unreferenced(stores: &[PartStore]) -> u64 {
    let mut seen = std::collections::HashSet::new();
    stores
        .iter()
        .filter(|store| fs::canonicalize(store.root()).map_or(true, |real| seen.insert(real)))
        .map(|store| store.remove_unreferenced())
        .sum()
}

/// The part folders this launcher writes: the data directory's, the modpack
/// cache's, the configured game root's (canonical, as downloads use it) and
/// those of game roots that received parts before the setting changed.
pub(crate) fn startup_stores(data_dir: &Path, game_root: Option<&Path>) -> Vec<PartStore> {
    let mut roots = vec![data_dir.join(".launcher-temp").join("parts"), data_dir.join("pack-cache").join(".parts")];
    if let Some(game) = game_root {
        roots.push(game.join(".launcher-temp").join("parts"));
    }
    for remembered in remembered(data_dir) {
        if !roots.contains(&remembered) {
            roots.push(remembered);
        }
    }
    roots.into_iter().map(PartStore::new).collect()
}

/// Part folders outside the data directory that received parts, newest last.
const REMEMBERED: &str = "part-folders.json";
const REMEMBERED_MAX: usize = 64;

fn remembered_file(data_dir: &Path) -> PathBuf {
    data_dir.join(".launcher-temp").join(REMEMBERED)
}

/// The remembered part folders: absolute paths only, a bounded list.
fn remembered(data_dir: &Path) -> Vec<PathBuf> {
    let Ok(file) = fs::File::open(remembered_file(data_dir)) else { return Vec::new() };
    let mut text = String::new();
    if file.take(64 * 1024).read_to_string(&mut text).is_err() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<PathBuf>>(&text)
        .unwrap_or_default()
        .into_iter()
        .filter(|path| path.is_absolute())
        .take(REMEMBERED_MAX)
        .collect()
}

/// Remembers a part folder outside the data directory, so startup cleanup
/// still reaches it after the game directory setting changes. Best effort:
/// a lost write only delays that folder's cleanup.
pub(crate) fn remember(data_dir: &Path, folder: &Path) {
    let mut folders = remembered(data_dir);
    if folders.iter().any(|known| known == folder) {
        return;
    }
    // A folder that is gone while its game folder is still there needs no
    // cleanup. One whose game folder cannot be reached (an unplugged drive, an
    // offline share) is kept until the bound pushes it out.
    folders.retain(|known| known.exists() || !known.parent().and_then(Path::parent).is_some_and(Path::exists));
    folders.push(folder.to_path_buf());
    let skip = folders.len().saturating_sub(REMEMBERED_MAX);
    let folders: Vec<_> = folders.into_iter().skip(skip).collect();
    let path = remembered_file(data_dir);
    let Some(parent) = path.parent() else { return };
    let temporary = parent.join(format!("{REMEMBERED}.{}.tmp", uuid::Uuid::new_v4()));
    let written = fs::create_dir_all(parent)
        .and_then(|()| fs::write(&temporary, serde_json::to_vec(&folders).map_err(io::Error::other)?))
        .and_then(|()| fs::rename(&temporary, &path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
}

/// Startup cleanup (spec: keep 7 days, 4 GiB in total).
pub(crate) fn sweep_on_startup(stores: Vec<PartStore>) {
    sweep(&stores, SystemTime::now(), KEEP, CAP);
}

fn ordinary(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    !metadata.file_type().is_symlink()
}

fn ordinary_tree(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
        && path.ancestors().all(|part| fs::symlink_metadata(part).is_ok_and(|metadata| ordinary(&metadata)))
}

fn read_sidecar(path: &Path) -> Option<Sidecar> {
    serde_json::from_str(&read_record(path)?).ok()
}

fn read_ranges(path: &Path) -> Option<SidecarRanges> {
    serde_json::from_str(&read_record(path)?).ok()
}

fn read_record(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > SIDECAR_MAX {
        return None;
    }
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    Some(text)
}

/// A part this download holds until it is published, discarded or dropped.
/// Dropping it keeps the bytes and their record for the next attempt.
pub(crate) struct ResumablePart {
    root: PathBuf,
    key: PartKey,
    size: u64,
    lock: Option<fs::File>,
    part: Option<fs::File>,
    /// Sorted, separate ranges in place.
    received: Vec<(u64, u64)>,
    validator: Validator,
    unrecorded: u64,
    last_record: Instant,
    /// Times kept bytes were thrown away for a whole-file response.
    restarts: u32,
    /// The server refused a segment: this download is not split again.
    whole_only: bool,
    finished: bool,
}

impl ResumablePart {
    /// How often kept bytes were thrown away for a whole-file response: an
    /// attempt that restarted did not continue the part, whatever it reached.
    pub(crate) fn restarts(&self) -> u32 {
        self.restarts
    }

    /// What an attempt is judged by.
    pub(crate) fn mark(&self) -> Mark {
        Mark { restarts: self.restarts, done: self.done(), origin: self.validator.origin.clone() }
    }

    /// Whether the kept bytes came from another origin than `origin`.
    pub(crate) fn holds_bytes_from_another(&self, origin: &str) -> bool {
        self.done() > 0 && self.validator.origin != origin
    }

    /// Bytes already in place, wherever they are.
    pub(crate) fn done(&self) -> u64 {
        self.received.iter().map(|(from, to)| to - from).sum()
    }

    /// Bytes in place from the start of the file without a gap.
    fn prefix(&self) -> u64 {
        match self.received.first() {
            Some(&(0, end)) => end,
            _ => 0,
        }
    }

    /// Whether every byte is in place (only the check is left).
    pub(crate) fn complete(&self) -> bool {
        self.received == [(0, self.size)]
    }

    /// The bytes still missing.
    fn missing(&self) -> Vec<(u64, u64)> {
        gaps(&self.received, self.size)
    }

    /// The Range start (the first missing byte) and `If-Range` value for a
    /// request to `origin`, or None to ask for the whole file (nothing kept,
    /// another origin, no validator).
    pub(crate) fn resume_for(&self, origin: &str) -> Option<(u64, String)> {
        if self.received.is_empty() || self.complete() || self.validator.origin != origin {
            return None;
        }
        let start = self.missing().first().map_or(self.size, |&(start, _)| start);
        self.validator.if_range().map(|value| (start, value.to_owned()))
    }

    fn file(&self) -> &fs::File {
        self.part.as_ref().expect("the part stays open until it is published or discarded")
    }

    /// Starts the part again from zero for a whole-file response.
    pub(crate) fn restart(&mut self, validator: Validator) -> io::Result<()> {
        // Bytes from another origin could never be continued from this one, so
        // starting over loses nothing (as with an empty part).
        if self.done() > 0 && self.validator.origin == validator.origin {
            self.restarts += 1;
        }
        self.file().set_len(0)?;
        self.received.clear();
        self.validator = validator;
        self.record()
    }

    /// Feeds up to `max` kept bytes from `from` to `hash` and returns how
    /// many it read (0 once every byte kept from the start was read).
    /// Callers await between pieces, so a long prefix never holds up cancel
    /// or the task's other downloads.
    pub(crate) fn hash_prefix_chunk(&mut self, from: u64, max: u64, hash: &mut dyn FnMut(&[u8])) -> io::Result<u64> {
        let to = self.prefix();
        self.hash_chunk(from, to, max, hash)
    }

    /// Feeds up to `max` bytes of `[from, to)` to `hash` and returns how many
    /// it read.
    fn hash_chunk(&self, from: u64, to: u64, max: u64, hash: &mut dyn FnMut(&[u8])) -> io::Result<u64> {
        let file = self.file();
        let total = max.min(to.saturating_sub(from));
        let mut remaining = total;
        let mut at = from;
        let mut buffer = vec![0u8; 128 * 1024];
        while remaining > 0 {
            let want = buffer.len().min(usize::try_from(remaining).unwrap_or(usize::MAX));
            let read = read_at(file, &mut buffer[..want], at)?;
            if read == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "下载分片比记录短"));
            }
            hash(&buffer[..read]);
            remaining -= read as u64;
            at += read as u64;
        }
        Ok(total)
    }

    /// Every kept byte at once (tests).
    #[cfg(test)]
    pub(crate) fn hash_prefix(&mut self, mut hash: impl FnMut(&[u8])) -> io::Result<()> {
        let mut from = 0;
        loop {
            let read = self.hash_prefix_chunk(from, u64::MAX, &mut hash)?;
            if read == 0 {
                return Ok(());
            }
            from += read;
        }
    }

    /// Appends received bytes after those kept from the start.
    pub(crate) fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        let at = self.prefix();
        self.write(at, bytes)
    }

    /// Writes received bytes at `offset`; the record is rewritten every few MiB.
    fn write(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
        let end = offset + bytes.len() as u64;
        if end > self.size {
            return Err(io::Error::other(OVERRUN));
        }
        write_at(self.file(), offset, bytes)?;
        insert_range(&mut self.received, offset, end);
        self.unrecorded += bytes.len() as u64;
        Ok(())
    }

    /// Whether the next record is due: every few MiB, at most once a second.
    fn record_due(&self) -> bool {
        self.unrecorded >= RECORD_EVERY && self.last_record.elapsed() >= RECORD_GAP
    }

    /// Makes the bytes durable and records them (on the calling thread).
    #[cfg(test)]
    pub(crate) fn sync(&mut self) -> io::Result<()> {
        self.file().sync_all()?;
        self.record()
    }

    /// The ranges in place (tests).
    #[cfg(test)]
    pub(crate) fn received(&self) -> &[(u64, u64)] {
        &self.received
    }

    /// Writes bytes at an offset (tests: a part left with a gap).
    #[cfg(test)]
    pub(crate) fn write_test(&mut self, offset: u64, bytes: &[u8]) -> io::Result<()> {
        self.write(offset, bytes)
    }

    fn record(&mut self) -> io::Result<()> {
        let ranges = self.received.clone();
        self.record_ranges(&ranges)
    }

    /// Records `ranges` (bytes known to be on disk): version 1 for bytes from
    /// the start, version 2 for separate ranges. Past the range limit only
    /// the bytes from the start are recorded.
    fn record_ranges(&mut self, ranges: &[(u64, u64)]) -> io::Result<()> {
        self.unrecorded = 0;
        self.last_record = Instant::now();
        let bytes = match ranges {
            [] => serde_json::to_vec(&Sidecar { version: 1, size: self.size, done: 0, validator: self.validator.clone() }),
            [(0, done)] => serde_json::to_vec(&Sidecar { version: 1, size: self.size, done: *done, validator: self.validator.clone() }),
            ranges if ranges.len() <= RANGES_MAX => serde_json::to_vec(&SidecarRanges {
                version: 2,
                size: self.size,
                received: ranges.iter().map(|&(from, to)| [from, to]).collect(),
                validator: self.validator.clone(),
            }),
            ranges => {
                let done = match ranges.first() {
                    Some(&(0, end)) => end,
                    _ => 0,
                };
                serde_json::to_vec(&Sidecar { version: 1, size: self.size, done, validator: self.validator.clone() })
            }
        }
        .map_err(io::Error::other)?;
        let temporary = self.key.file(&self.root, "json.tmp");
        fs::write(&temporary, bytes)?;
        fs::rename(&temporary, self.key.file(&self.root, "json"))
    }

    /// Moves the verified part to `target`, replacing what is there (the
    /// content-addressed launcher files repair themselves this way). Across
    /// volumes the bytes are copied next to the target first.
    pub(crate) fn publish_replace(mut self, target: &Path) -> io::Result<()> {
        drop(self.part.take());
        let part = self.key.file(&self.root, "part");
        let renamed = if force_cross_volume() {
            Err(io::Error::from_raw_os_error(CROSS_VOLUME))
        } else {
            fs::rename(&part, target)
        };
        match renamed {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(CROSS_VOLUME) => {
                // A mount point between the parts and the target.
                let parent = target.parent().ok_or_else(|| io::Error::other("下载路径缺少父目录"))?;
                let temporary = parent.join(format!(".launcher-{}.part", uuid::Uuid::new_v4()));
                let copied = fs::copy(&part, &temporary)
                    .and_then(|_| fs::OpenOptions::new().write(true).open(&temporary)?.sync_all())
                    .and_then(|()| fs::rename(&temporary, target));
                if copied.is_err() {
                    let _ = fs::remove_file(&temporary);
                }
                copied?;
                let _ = fs::remove_file(&part);
            }
            Err(error) => return Err(error),
        }
        self.finish();
        Ok(())
    }

    /// Moves the verified part to a vacant `target`, never replacing a file
    /// that appeared there (staged resource files must not be overwritten). A
    /// failed publish leaves the target and the part as they were. On Windows
    /// the no-replace move copies a file across volumes by itself; where a
    /// rename cannot cross volumes, the bytes are copied next to the target
    /// first and moved from there.
    pub(crate) fn publish_new(mut self, target: &Path) -> io::Result<()> {
        drop(self.part.take());
        let part = self.key.file(&self.root, "part");
        let moved = if force_cross_volume() {
            Err(io::Error::from_raw_os_error(CROSS_VOLUME))
        } else {
            crate::instances::publish_archive_file(&part, target)
        };
        match moved {
            Ok(()) => {}
            Err(error) if error.raw_os_error() == Some(CROSS_VOLUME) => {
                // A mount point between the parts and the target.
                let parent = target.parent().ok_or_else(|| io::Error::other("下载路径缺少父目录"))?;
                let temporary = parent.join(format!(".launcher-{}.part", uuid::Uuid::new_v4()));
                let destination = fs::OpenOptions::new().create_new(true).write(true).open(&temporary)?;
                let copied = (|| {
                    let mut source = fs::File::open(&part)?;
                    let mut destination = destination;
                    io::copy(&mut source, &mut destination)?;
                    destination.sync_all()?;
                    drop(destination);
                    crate::instances::publish_archive_file(&temporary, target)
                })();
                if copied.is_err() {
                    let _ = fs::remove_file(&temporary);
                }
                copied?;
                let _ = fs::remove_file(&part);
            }
            Err(error) => return Err(error),
        }
        self.finish();
        Ok(())
    }

    /// Removes the part and its record: it can never become the file.
    pub(crate) fn discard(mut self) {
        drop(self.part.take());
        let _ = fs::remove_file(self.key.file(&self.root, "part"));
        self.finish();
    }

    /// Removes the record while the lock is still held, then releases it.
    fn finish(&mut self) {
        self.finished = true;
        let _ = fs::remove_file(self.key.file(&self.root, "json"));
        let _ = fs::remove_file(self.key.file(&self.root, "json.tmp"));
        if let Some(lock) = self.lock.take() {
            release_lock(lock, &self.key.file(&self.root, "lock"));
        }
    }
}

/// Publishes a verified part on the blocking pool: across volumes this copies
/// the whole file, which must not stall the task that drives the other
/// downloads. Once started, the publish completes even if the caller is dropped.
pub(crate) async fn publish_off_task(part: ResumablePart, target: &Path) -> io::Result<()> {
    let target = target.to_path_buf();
    #[cfg(test)]
    let forced = force_cross_volume();
    tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        FORCE_CROSS_VOLUME.with(|cell| cell.set(forced));
        part.publish_replace(&target)
    })
    .await
    .map_err(io::Error::other)?
}

/// Publishes a verified part to a vacant target on the blocking pool, for the
/// same reason as `publish_off_task`.
pub(crate) async fn publish_new_off_task(part: ResumablePart, target: &Path) -> io::Result<()> {
    let target = target.to_path_buf();
    #[cfg(test)]
    let forced = force_cross_volume();
    tokio::task::spawn_blocking(move || {
        #[cfg(test)]
        FORCE_CROSS_VOLUME.with(|cell| cell.set(forced));
        part.publish_new(&target)
    })
    .await
    .map_err(io::Error::other)?
}

/// ERROR_NOT_SAME_DEVICE on Windows, EXDEV elsewhere.
const CROSS_VOLUME: i32 = if cfg!(windows) { 17 } else { 18 };

#[cfg(test)]
thread_local! {
    pub(crate) static FORCE_CROSS_VOLUME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn force_cross_volume() -> bool {
    #[cfg(test)]
    {
        FORCE_CROSS_VOLUME.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        false
    }
}

impl Drop for ResumablePart {
    fn drop(&mut self) {
        // Record only what is on disk: after a failed flush the older, smaller
        // record stays, and the next open cuts the part back to it.
        if !self.finished && self.part.as_mut().is_some_and(|part| part.flush().and_then(|()| part.sync_data()).is_ok()) {
            let _ = self.record();
        }
        drop(self.part.take());
        drop(self.lock.take());
    }
}

/// A file transfer fails after this long without data (the spec's stall
/// rule); metadata requests keep their clients' total timeouts.
pub(crate) const STALL: Duration = Duration::from_secs(30);
/// Replaces a client's total timeout for one file transfer: a large file on a
/// slow link must not fail just for taking long, only for stalling.
pub(crate) const TRANSFER_TIMEOUT: Duration = Duration::from_secs(12 * 60 * 60);
pub(crate) const STALLED: &str = "下载连续 30 秒没有收到数据";

/// How a transfer is cancelled, paced and throttled by its caller.
pub(crate) trait Hooks {
    fn cancellable<F: std::future::Future>(&self, future: F) -> impl std::future::Future<Output = Result<F::Output, String>>;
    fn checkpoint(&self) -> impl std::future::Future<Output = Result<(), String>>;
    fn throttle(&self, bytes: usize) -> impl std::future::Future<Output = Result<(), String>>;
    fn stall_limit(&self) -> Duration;
    /// The connections a transfer takes its permits from; None: unlimited,
    /// and never segmented.
    fn connections(&self) -> Option<&crate::downloads::Connections> {
        None
    }
    /// The bytes in place after each write, wherever they landed: progress
    /// that does not wait for the in-order hash.
    fn received(&self, _done: u64) {}
}

/// `hooks`, reporting the bytes in place to `report`.
pub(crate) struct Reporting<'a, H> {
    pub(crate) hooks: &'a H,
    pub(crate) report: &'a (dyn Fn(u64) + Sync),
}

impl<H: Hooks + Sync> Hooks for Reporting<'_, H> {
    async fn cancellable<F: std::future::Future>(&self, future: F) -> Result<F::Output, String> {
        self.hooks.cancellable(future).await
    }
    async fn checkpoint(&self) -> Result<(), String> {
        self.hooks.checkpoint().await
    }
    async fn throttle(&self, bytes: usize) -> Result<(), String> {
        self.hooks.throttle(bytes).await
    }
    fn stall_limit(&self) -> Duration {
        self.hooks.stall_limit()
    }
    fn connections(&self) -> Option<&crate::downloads::Connections> {
        self.hooks.connections()
    }
    fn received(&self, done: u64) {
        (self.report)(done);
    }
}

/// A permit for one request in flight, waited for cancellably; None when the
/// caller has no connection limit.
pub(crate) async fn connection<H: Hooks>(hooks: &H) -> Result<Option<crate::downloads::ConnectionPermit<'_>>, String> {
    let permit = match hooks.connections() {
        Some(connections) => Some(hooks.cancellable(connections.acquire()).await?),
        None => None,
    };
    // A pause that began while waiting holds the request back.
    hooks.checkpoint().await?;
    Ok(permit)
}

/// `future`, cancellable, failing when nothing arrives for the stall limit.
pub(crate) async fn within_stall<H: Hooks, F: std::future::Future>(hooks: &H, future: F) -> Result<F::Output, String> {
    hooks
        .cancellable(tokio::time::timeout(hooks.stall_limit(), future))
        .await?
        .map_err(|_| STALLED.to_owned())
}

/// One attempt to bring the part in `slot` to `size` bytes from `requested`.
/// Asks for the rest with `Range` and `If-Range` when the part came from the
/// same origin, writes a 206 for exactly that range, starts again on a 200,
/// and discards the part on any other range answer. A file of `SEGMENT_MIN`
/// or more whose server takes ranges is fetched in up to `SEGMENTS` ranges at
/// once, the extra ones only on spare connections. `hash` sees every byte of
/// the finished part in order. The caller checks the hash and publishes.
pub(crate) async fn transfer<H: Hooks>(
    request: reqwest::RequestBuilder,
    requested: &reqwest::Url,
    slot: &mut Option<ResumablePart>,
    size: u64,
    hooks: &H,
    check: &(dyn Fn(&reqwest::Response) -> Result<(), String> + Sync),
    hash: &mut (dyn FnMut(&[u8]) + Send),
) -> Result<(), String> {
    let io = |error: io::Error| error.to_string();
    let part = slot.as_mut().ok_or("下载分片不可用")?;
    if part.complete() {
        // Everything arrived last time; only the check is left.
        return hash_kept(part, 0, size, hooks, hash).await;
    }
    let resume = part.resume_for(&origin(requested));
    let offset = resume.as_ref().map_or(0, |(offset, _)| *offset);
    let base = request.timeout(TRANSFER_TIMEOUT);
    // Segments are the same request with another Range.
    let extra = base.try_clone();
    let mut request = base;
    if let Some((offset, validator)) = &resume {
        request = request
            .header(reqwest::header::RANGE, format!("bytes={offset}-"))
            .header(reqwest::header::IF_RANGE, validator.as_str());
    }
    let main = connection(hooks).await?;
    let response = within_stall(hooks, request.send())
        .await?
        // reqwest errors print the request URL; keep it (and any signed query) out of logs.
        .map_err(|error| error.without_url().to_string())?;
    let content_range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let status = response.status().as_u16();
    let reply = match &resume {
        // A gap at the start (bytes kept further on): `bytes=0-` was sent.
        Some(_) if offset == 0 => classify_range(status, content_range.as_deref(), 0, size - 1, size),
        _ => classify(status, content_range.as_deref(), offset, size),
    };
    let offset = match reply {
        Reply::Continue => offset,
        Reply::Restart => {
            check(&response)?;
            if response.content_length().is_some_and(|length| length != size) {
                return Err(SIZE_MISMATCH.into());
            }
            part.restart(Validator::of(requested, response.headers())).map_err(io)?;
            0
        }
        Reply::Discard(message) => {
            if let Some(part) = slot.take() {
                part.discard();
            }
            return Err(message);
        }
        Reply::Fail(message) => return Err(message),
    };
    let part = slot.as_mut().ok_or("下载分片不可用")?;
    if offset > 0 || part.done() > 0 {
        check(&response)?;
        if response.content_length().is_some_and(|length| length != size - offset) {
            return Err("续传响应的长度与请求不符".into());
        }
    }
    hooks.received(part.done());
    let accepts = status == 206
        || response
            .headers()
            .get(reqwest::header::ACCEPT_RANGES)
            .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"bytes"));
    let helpers = match (hooks.connections(), part.validator.if_range().is_some(), extra) {
        (Some(connections), true, Some(extra)) if size >= SEGMENT_MIN && accepts && !part.whole_only => {
            let missing: u64 = part.missing().iter().map(|(from, to)| to - from).sum();
            let wanted = usize::try_from(missing / SEGMENT_FLOOR).unwrap_or(usize::MAX).saturating_sub(1).min(SEGMENTS - 1);
            let permits: Vec<_> = std::iter::from_fn(|| connections.try_acquire_spare()).take(wanted).collect();
            (!permits.is_empty()).then(|| (permits, extra, part.validator.clone()))
        }
        _ => None,
    };
    if let Some((permits, extra, validator)) = helpers {
        let segmenting = Segmenting { permits, main, extra, validator, requested, check };
        return segmented(part, response, offset, segmenting, hooks, hash).await;
    }
    hash_kept(part, 0, offset, hooks, &mut *hash).await?;
    let mut at = offset;
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = within_stall(hooks, futures_util::StreamExt::next(&mut chunks)).await? {
        hooks.checkpoint().await?;
        let chunk = chunk.map_err(|error| error.without_url().to_string())?;
        part.write(at, &chunk).map_err(io)?;
        at += chunk.len() as u64;
        hooks.received(part.done());
        hash(&chunk);
        if part.record_due() {
            durable(part, false).await.map_err(io)?;
        }
        hooks.throttle(chunk.len()).await?;
    }
    drop(main);
    durable(part, true).await.map_err(io)?;
    if !part.complete() {
        return Err("下载在预期大小之前结束".into());
    }
    // The answer may end where bytes kept from before begin: they are
    // hashed from the part, so the hash still covers every byte in order.
    hash_kept(part, at, size, hooks, &mut *hash).await
}

/// What the extra segments of a transfer are made from.
struct Segmenting<'a, 'c> {
    permits: Vec<crate::downloads::ConnectionPermit<'c>>,
    /// The first request's permit, for what is fetched after the segments.
    main: Option<crate::downloads::ConnectionPermit<'c>>,
    extra: reqwest::RequestBuilder,
    /// The version the first response belongs to.
    validator: Validator,
    requested: &'a reqwest::Url,
    check: &'a (dyn Fn(&reqwest::Response) -> Result<(), String> + Sync),
}

/// A missing range and who is fetching it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Piece {
    start: u64,
    end: u64,
    state: PieceState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PieceState {
    Free,
    Taken,
    Done,
}

/// Splits the missing ranges into pieces of about an equal share for
/// `workers`, each within one gap; a remainder smaller than `floor` stays
/// with the piece before it.
fn plan_pieces(missing: &[(u64, u64)], workers: usize, floor: u64) -> Vec<Piece> {
    let total: u64 = missing.iter().map(|(from, to)| to - from).sum();
    let share = total.div_ceil(workers.max(1) as u64).max(1);
    let mut pieces = Vec::new();
    for &(from, to) in missing {
        let mut start = from;
        while start < to {
            let mut end = (start + share).min(to);
            if to - end < floor {
                end = to;
            }
            pieces.push(Piece { start, end, state: PieceState::Free });
            start = end;
        }
    }
    pieces
}

/// Whether a segment's answer belongs to the version `stored` describes:
/// the same strong tag, or (for a date) no other date.
fn same_version(stored: &Validator, answered: &Validator) -> bool {
    match &stored.etag {
        Some(tag) => answered.etag.as_deref() == Some(tag.as_str()),
        // A 206 need not repeat the date, but a strong tag where the
        // first answer had none is another version.
        None => {
            stored.last_modified.is_some()
                && answered.etag.is_none()
                && (answered.last_modified.is_none() || answered.last_modified == stored.last_modified)
        }
    }
}

/// The part, the pieces, and whether the server refused a segment.
struct Shared<'p> {
    part: std::sync::Mutex<&'p mut ResumablePart>,
    pieces: std::sync::Mutex<Vec<Piece>>,
    refused: AtomicBool,
    recording: AtomicBool,
    /// A segment's answer failed the caller's check (an untrusted host): the
    /// transfer fails as a single stream would.
    untrusted: std::sync::Mutex<Option<String>>,
}

impl<'p> Shared<'p> {
    fn part(&self) -> std::sync::MutexGuard<'_, &'p mut ResumablePart> {
        self.part.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn pieces(&self) -> std::sync::MutexGuard<'_, Vec<Piece>> {
        self.pieces.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The first free piece of at least the segment floor, now taken;
    /// smaller ones are left to the first response and what follows it.
    fn take_free(&self) -> Option<(u64, u64)> {
        let mut pieces = self.pieces();
        let piece = pieces.iter_mut().find(|piece| piece.state == PieceState::Free && piece.end - piece.start >= SEGMENT_FLOOR)?;
        piece.state = PieceState::Taken;
        Some((piece.start, piece.end))
    }

    /// The piece starting at `start` stopped at `reached`: what is left of it
    /// is free again.
    fn release(&self, start: u64, reached: u64) {
        let mut pieces = self.pieces();
        if let Some(piece) = pieces.iter_mut().find(|piece| piece.start == start) {
            if reached >= piece.end {
                piece.state = PieceState::Done;
            } else {
                piece.start = reached.max(piece.start);
                piece.state = PieceState::Free;
            }
        }
    }

    /// Writes received bytes and reports the bytes in place.
    fn write<H: Hooks>(&self, at: u64, bytes: &[u8], hooks: &H) -> io::Result<()> {
        let done = {
            let mut part = self.part();
            part.write(at, bytes)?;
            part.done()
        };
        hooks.received(done);
        Ok(())
    }

    /// Records the ranges in place when due, one worker at a time: the
    /// ranges are taken before the flush, so only flushed bytes are recorded.
    async fn record_if_due(&self) -> io::Result<()> {
        let (file, ranges) = {
            let part = self.part();
            if !part.record_due() || self.recording.swap(true, Ordering::SeqCst) {
                return Ok(());
            }
            (part.file().try_clone(), part.received.clone())
        };
        let flushed = match file {
            Ok(file) => tokio::task::spawn_blocking(move || file.sync_data()).await.map_err(io::Error::other).and_then(|result| result),
            Err(error) => Err(error),
        };
        let recorded = flushed.and_then(|()| self.part().record_ranges(&ranges));
        self.recording.store(false, Ordering::SeqCst);
        recorded
    }
}

/// The rest of a transfer in several ranges: the first response carries the
/// first piece and runs on into the next free ones; each extra permit
/// fetches free pieces with a closed `Range` and `If-Range`. A segment the
/// server does not answer exactly is given up without touching the part.
/// What is still missing afterwards comes in one stream on the first
/// connection. Nothing is hashed until every byte is in place (segments land
/// out of order and a piece may be written twice): then the whole part is
/// hashed in order from disk, so the hash covers exactly what is published.
async fn segmented<H: Hooks>(
    part: &mut ResumablePart,
    response: reqwest::Response,
    offset: u64,
    segmenting: Segmenting<'_, '_>,
    hooks: &H,
    hash: &mut (dyn FnMut(&[u8]) + Send),
) -> Result<(), String> {
    let io = |error: io::Error| error.to_string();
    let size = part.size;
    let Segmenting { permits, main, extra, validator, requested, check } = segmenting;
    let mut pieces = plan_pieces(&part.missing(), permits.len() + 1, SEGMENT_FLOOR);
    if let Some(first) = pieces.first_mut() {
        first.state = PieceState::Taken;
    }
    // Writing far past the end makes Windows fill the gap with zeros inside
    // that write: do it once, off the task, before the segments start. The
    // byte lies in a missing range, so a segment overwrites it.
    let last = pieces.iter().map(|piece| piece.start).max().unwrap_or(0);
    if part.file().metadata().map_err(io)?.len() < last {
        let file = part.file().try_clone().map_err(io)?;
        tokio::task::spawn_blocking(move || write_at(&file, last - 1, &[0]))
            .await
            .map_err(|error| error.to_string())?
            .map_err(io)?;
    }
    let shared = Shared {
        part: std::sync::Mutex::new(part),
        pieces: std::sync::Mutex::new(pieces),
        refused: AtomicBool::new(false),
        recording: AtomicBool::new(false),
        untrusted: std::sync::Mutex::new(None),
    };
    let fetcher = Fetcher { shared: &shared, extra: &extra, validator: &validator, requested, check, size };
    let helpers = permits.into_iter().map(|permit| fetcher.helper(permit, hooks));
    let (first, _) = futures_util::future::join(fetcher.first(response, offset, hooks), futures_util::future::join_all(helpers)).await;
    let refused = shared.refused.load(Ordering::SeqCst);
    let untrusted = shared.untrusted.into_inner().unwrap_or_else(std::sync::PoisonError::into_inner);
    let part = shared.part.into_inner().unwrap_or_else(std::sync::PoisonError::into_inner);
    part.whole_only |= refused;
    // A cancel ends every segment and the transfer. Otherwise what is still
    // missing (a refused or broken segment, or a first response that broke
    // off) comes in one more stream; the first response's own failure no
    // longer matters once that has run.
    let _ = first;
    let mut failure = hooks.checkpoint().await.err().or(untrusted);
    if failure.is_none() && !part.complete() {
        failure = continue_rest(part, &extra, &validator, requested, check, hooks).await.err();
        if let Err(cancelled) = hooks.checkpoint().await {
            failure = Some(cancelled);
        }
    }
    drop(main);
    durable(part, true).await.map_err(io)?;
    if let Some(error) = failure {
        return Err(error);
    }
    if !part.complete() {
        return Err(SEGMENTS_UNFINISHED.into());
    }
    hash_kept(part, 0, size, hooks, hash).await
}

/// One stream from the first missing byte to the end (after the segments),
/// as a single-stream transfer would continue; a whole-file answer starts
/// the part again. Nothing is hashed here.
async fn continue_rest<H: Hooks>(
    part: &mut ResumablePart,
    extra: &reqwest::RequestBuilder,
    validator: &Validator,
    requested: &reqwest::Url,
    check: &(dyn Fn(&reqwest::Response) -> Result<(), String> + Sync),
    hooks: &H,
) -> Result<(), String> {
    let io = |error: io::Error| error.to_string();
    let size = part.size;
    let Some(&(from, _)) = part.missing().first() else { return Ok(()) };
    hooks.checkpoint().await?;
    let request = extra
        .try_clone()
        .ok_or("下载请求无法复制")?
        .header(reqwest::header::RANGE, format!("bytes={from}-"))
        .header(reqwest::header::IF_RANGE, validator.if_range().unwrap_or_default());
    let response = within_stall(hooks, request.send()).await?.map_err(|error| error.without_url().to_string())?;
    let content_range = response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok()).map(str::to_owned);
    let mut at = match classify_range(response.status().as_u16(), content_range.as_deref(), from, size - 1, size) {
        Reply::Continue => {
            check(&response)?;
            if response.content_length().is_some_and(|length| length != size - from) {
                return Err("续传响应的长度与请求不符".into());
            }
            from
        }
        Reply::Restart => {
            check(&response)?;
            if response.content_length().is_some_and(|length| length != size) {
                return Err(SIZE_MISMATCH.into());
            }
            part.restart(Validator::of(requested, response.headers())).map_err(io)?;
            0
        }
        Reply::Discard(message) => {
            // The server disagrees about the bytes kept: they are thrown away.
            part.restart(Validator::default()).map_err(io)?;
            return Err(message);
        }
        Reply::Fail(message) => return Err(message),
    };
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = within_stall(hooks, futures_util::StreamExt::next(&mut chunks)).await? {
        hooks.checkpoint().await?;
        let chunk = chunk.map_err(|error| error.without_url().to_string())?;
        part.write(at, &chunk).map_err(io)?;
        at += chunk.len() as u64;
        hooks.received(part.done());
        if part.record_due() {
            durable(part, false).await.map_err(io)?;
        }
        hooks.throttle(chunk.len()).await?;
    }
    Ok(())
}

/// Fetches the pieces of one segmented transfer.
struct Fetcher<'s, 'p, 'a> {
    shared: &'s Shared<'p>,
    extra: &'a reqwest::RequestBuilder,
    validator: &'a Validator,
    requested: &'a reqwest::Url,
    check: &'a (dyn Fn(&reqwest::Response) -> Result<(), String> + Sync),
    size: u64,
}

impl Fetcher<'_, '_, '_> {
    /// The first response, from `offset`: its piece, then each next piece
    /// while nobody has it. It never writes past the piece it holds.
    async fn first<H: Hooks>(&self, response: reqwest::Response, offset: u64, hooks: &H) -> Result<(), String> {
        let io = |error: io::Error| error.to_string();
        let mut piece = offset;
        let mut end = self.shared.pieces().first().map_or(self.size, |piece| piece.end);
        let mut at = offset;
        let mut rest = None;
        let mut chunks = response.bytes_stream();
        let result = async {
            loop {
                if at >= end {
                    // Run on into the next piece if nobody has it (bytes
                    // before it are already in place and arrive again).
                    let mut pieces = self.shared.pieces();
                    if let Some(done) = pieces.iter_mut().find(|candidate| candidate.start == piece) {
                        done.state = PieceState::Done;
                    }
                    match pieces.iter_mut().find(|candidate| candidate.start >= at && candidate.state != PieceState::Done) {
                        Some(next) if next.state == PieceState::Free => {
                            next.state = PieceState::Taken;
                            piece = next.start;
                            end = next.end;
                        }
                        _ => return Ok(()),
                    }
                }
                let chunk = match rest.take() {
                    Some(chunk) => chunk,
                    None => {
                        let Some(chunk) = within_stall(hooks, futures_util::StreamExt::next(&mut chunks)).await? else {
                            return Err("下载在预期大小之前结束".to_owned());
                        };
                        hooks.checkpoint().await?;
                        chunk.map_err(|error| error.without_url().to_string())?
                    }
                };
                // Up to the end of this piece; the rest waits for the next one.
                let room = usize::try_from(end - at).unwrap_or(usize::MAX);
                let chunk = if chunk.len() > room {
                    rest = Some(chunk.slice(room..));
                    chunk.slice(..room)
                } else {
                    chunk
                };
                self.shared.write(at, &chunk, hooks).map_err(io)?;
                at += chunk.len() as u64;
                self.shared.record_if_due().await.map_err(io)?;
                hooks.throttle(chunk.len()).await?;
            }
        }
        .await;
        if result.is_err() {
            self.shared.release(piece, at);
        }
        result
    }

    /// An extra segment: free pieces, one after another, on its own permit.
    /// Every failure is local: the piece is free again and the segment ends.
    async fn helper<H: Hooks>(&self, permit: crate::downloads::ConnectionPermit<'_>, hooks: &H) {
        while let Some((from, to)) = self.shared.take_free() {
            if self.fetch(from, to, hooks).await < to {
                break;
            }
        }
        drop(permit);
    }

    /// Fetches `[from, to)` (a taken piece) with a closed Range; returns how
    /// far it got. A failure only ends this piece (a cancel is reported by
    /// the transfer's own checkpoint).
    async fn fetch<H: Hooks>(&self, from: u64, to: u64, hooks: &H) -> u64 {
        let mut at = from;
        let _ = self.fetch_into(from, to, &mut at, hooks).await;
        self.shared.release(from, at);
        at
    }

    /// Only an exact 206 from the same version is written; any other answer
    /// marks the server as refusing ranges.
    async fn fetch_into<H: Hooks>(&self, from: u64, to: u64, at: &mut u64, hooks: &H) -> Result<(), String> {
        let refuse = |message: &str| -> Result<(), String> {
            self.shared.refused.store(true, Ordering::SeqCst);
            Err(message.to_owned())
        };
        let request = self
            .extra
            .try_clone()
            .ok_or("下载请求无法复制")?
            .header(reqwest::header::RANGE, format!("bytes={from}-{}", to - 1))
            .header(reqwest::header::IF_RANGE, self.validator.if_range().unwrap_or_default());
        hooks.checkpoint().await?;
        let response = within_stall(hooks, request.send()).await?.map_err(|error| error.without_url().to_string())?;
        let content_range = response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok()).map(str::to_owned);
        match classify_range(response.status().as_u16(), content_range.as_deref(), from, to - 1, self.size) {
            Reply::Continue => {}
            // A failed request (a 5xx, a 429) says nothing about ranges.
            Reply::Fail(message) => return Err(message),
            Reply::Restart | Reply::Discard(_) => return refuse(RANGE_MISMATCH),
        }
        if response.content_length().is_some_and(|length| length != to - from) {
            return refuse(RANGE_MISMATCH);
        }
        if let Err(error) = (self.check)(&response) {
            self.shared.untrusted.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_or_insert(error.clone());
            return Err(error);
        }
        // Another version answers If-Range with the whole file; a validator
        // that differs anyway is refused too.
        if !same_version(self.validator, &Validator::of(self.requested, response.headers())) {
            return refuse(RANGE_MISMATCH);
        }
        let mut chunks = response.bytes_stream();
        while let Some(chunk) = within_stall(hooks, futures_util::StreamExt::next(&mut chunks)).await? {
            hooks.checkpoint().await?;
            let chunk = chunk.map_err(|error| error.without_url().to_string())?;
            if *at + chunk.len() as u64 > to {
                return refuse(OVERRUN);
            }
            self.shared.write(*at, &chunk, hooks).map_err(|error| error.to_string())?;
            *at += chunk.len() as u64;
            self.shared.record_if_due().await.map_err(|error| error.to_string())?;
            hooks.throttle(chunk.len()).await?;
        }
        Ok(())
    }
}

/// Flushes the part on a blocking thread (the clone shares the open file, so
/// every write is covered), then records it; the task's other downloads keep
/// running. The record follows only a successful flush.
async fn durable(part: &mut ResumablePart, all: bool) -> io::Result<()> {
    let file = part.file().try_clone()?;
    tokio::task::spawn_blocking(move || if all { file.sync_all() } else { file.sync_data() })
        .await
        .map_err(io::Error::other)??;
    part.record()
}

/// What an attempt is judged by: restarts, kept bytes and their origin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Mark {
    restarts: u32,
    done: u64,
    origin: String,
}

/// Whether an attempt continued the part and added bytes. A restart does not
/// count; bytes now from another origin than before count from zero.
pub(crate) fn progressed(before: Option<&Mark>, after: Option<&Mark>) -> bool {
    match (before, after) {
        (Some(before), Some(after)) => {
            let base = if after.origin == before.origin { before.done } else { 0 };
            after.restarts == before.restarts && after.done > base
        }
        _ => false,
    }
}

/// Whether an attempt left bytes in the part (to be protected from another
/// origin for the rest of the same download).
pub(crate) fn wrote(before: Option<&Mark>, after: Option<&Mark>) -> bool {
    after.is_some_and(|after| after.done > 0 && before != Some(after))
}

/// Hashes the kept bytes of `[from, to)` a piece at a time, letting cancel,
/// pause and the other downloads of the task run in between.
async fn hash_kept<H: Hooks>(part: &mut ResumablePart, from: u64, to: u64, hooks: &H, hash: &mut (dyn FnMut(&[u8]) + Send)) -> Result<(), String> {
    let mut from = from;
    while from < to {
        let read = part.hash_chunk(from, to, PREFIX_CHUNK, hash).map_err(|error| error.to_string())?;
        if read == 0 {
            return Err("下载分片比记录短".into());
        }
        from += read;
        hooks.checkpoint().await?;
        tokio::task::yield_now().await;
    }
    Ok(())
}

/// Some antivirus products (Kaspersky's System Watcher, for one) back up a file
/// that a program they do not trust changes, as `<NAME IN CAPITALS>.tmp` next
/// to it, and remove the copy later. A freshly built test binary is such a
/// program, so folder checks in tests leave these copies out. Every name the
/// launcher itself writes has lower-case letters.
#[cfg(test)]
pub(crate) fn scanner_copy(name: &str) -> bool {
    name.strip_suffix(".tmp").is_some_and(|stem| {
        stem.chars().any(|c| c.is_ascii_uppercase()) && !stem.chars().any(|c| c.is_ascii_lowercase())
    })
}

#[cfg(test)]
#[path = "parts-tests.rs"]
mod tests;

#[cfg(test)]
#[path = "parts-range-server.rs"]
pub(crate) mod range_server;

#[cfg(test)]
mod removal_tests {
    use super::*;

    fn temp_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/part-removal-probes")
            .join(uuid::Uuid::new_v4().to_string())
    }

    fn key(n: u64, size: u64) -> PartKey {
        PartKey::new(Algo::Sha1, &format!("{n:040x}"), size).unwrap()
    }

    #[test]
    fn only_unlocked_parts_are_removed_and_their_bytes_are_counted() {
        let root = temp_root();
        let store = PartStore::new(root.join("parts"));
        fs::create_dir_all(store.root()).unwrap();
        let freed = key(1, 100);
        let held = key(2, 50);
        fs::write(freed.file(store.root(), "part"), vec![0u8; 100]).unwrap();
        fs::write(freed.file(store.root(), "json"), b"{}").unwrap();
        fs::write(held.file(store.root(), "part"), vec![0u8; 50]).unwrap();
        fs::write(held.file(store.root(), "json"), b"{}").unwrap();
        let held_lock = lock_options().create(true).truncate(false).open(held.file(store.root(), "lock")).unwrap();
        held_lock.try_lock().unwrap();
        // Foreign names and directories with part-like names are never touched.
        fs::write(store.root().join("notes.part"), b"keep").unwrap();
        fs::create_dir(store.root().join(format!("{}.part", key(3, 1).0))).unwrap();

        assert_eq!(store.remove_unreferenced(), 100);
        assert!(!freed.file(store.root(), "part").exists());
        assert!(!freed.file(store.root(), "json").exists());
        assert!(held.file(store.root(), "part").is_file(), "a held part stays");
        assert!(store.root().join("notes.part").is_file());
        assert!(store.root().join(format!("{}.part", key(3, 1).0)).is_dir());

        drop(held_lock);
        assert_eq!(store.remove_unreferenced(), 50);
        assert!(!held.file(store.root(), "part").exists());
        assert!(store.root().join("notes.part").is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
