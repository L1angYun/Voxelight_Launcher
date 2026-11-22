//! Resumable download parts (U0266, step one: one stream per file).
//!
//! A part is named by the file's expected hash and size, so a later attempt
//! (after a failure, a cancel or a restart of the launcher) continues where the
//! last one stopped. A sidecar records how many bytes are in place and the
//! origin and validator they came from; a resume is asked for only from the
//! same origin with `If-Range`, and anything unexpected starts again from zero.
//! The whole part is always hashed before publication, so a part is only ever
//! a hint. Parts live outside every target, staged or journaled directory.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
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

    fn file(&self, root: &Path, extension: &str) -> PathBuf {
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

#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Sidecar {
    version: u32,
    size: u64,
    done: u64,
    validator: Validator,
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
        let mut part = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(key.file(&self.root, "part"))?;
        let length = part.metadata()?.len();
        let (done, validator) = match read_sidecar(&key.file(&self.root, "json")) {
            Some(record) if record.version == 1 && record.size == size && record.done <= size && record.done <= length => {
                (record.done, record.validator)
            }
            _ => (0, Validator::default()),
        };
        // Bytes past the record were never confirmed.
        if length != done {
            part.set_len(done)?;
        }
        part.seek(SeekFrom::Start(done))?;
        Ok(Some(ResumablePart {
            root: self.root.clone(),
            key: key.clone(),
            size,
            lock: Some(lock),
            part: Some(part),
            done,
            validator,
            unrecorded: 0,
            last_record: Instant::now(),
            restarts: 0,
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
        part.done = size;
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
    let mut file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > SIDECAR_MAX {
        return None;
    }
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

/// A part this download holds until it is published, discarded or dropped.
/// Dropping it keeps the bytes and their record for the next attempt.
pub(crate) struct ResumablePart {
    root: PathBuf,
    key: PartKey,
    size: u64,
    lock: Option<fs::File>,
    part: Option<fs::File>,
    done: u64,
    validator: Validator,
    unrecorded: u64,
    last_record: Instant,
    /// Times kept bytes were thrown away for a whole-file response.
    restarts: u32,
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
        Mark { restarts: self.restarts, done: self.done, origin: self.validator.origin.clone() }
    }

    /// Whether the kept bytes came from another origin than `origin`.
    pub(crate) fn holds_bytes_from_another(&self, origin: &str) -> bool {
        self.done > 0 && self.validator.origin != origin
    }

    /// Bytes already in place.
    pub(crate) fn done(&self) -> u64 {
        self.done
    }

    /// Whether every byte is in place (only the check is left).
    pub(crate) fn complete(&self) -> bool {
        self.done == self.size
    }

    /// The Range start and `If-Range` value for a request to `origin`, or None
    /// to ask for the whole file (nothing kept, another origin, no validator).
    pub(crate) fn resume_for(&self, origin: &str) -> Option<(u64, String)> {
        if self.done == 0 || self.done >= self.size || self.validator.origin != origin {
            return None;
        }
        self.validator.if_range().map(|value| (self.done, value.to_owned()))
    }

    fn file(&mut self) -> &mut fs::File {
        self.part.as_mut().expect("the part stays open until it is published or discarded")
    }

    /// Starts the part again from zero for a whole-file response.
    pub(crate) fn restart(&mut self, validator: Validator) -> io::Result<()> {
        // Bytes from another origin could never be continued from this one, so
        // starting over loses nothing (as with an empty part).
        if self.done > 0 && self.validator.origin == validator.origin {
            self.restarts += 1;
        }
        self.file().set_len(0)?;
        self.file().seek(SeekFrom::Start(0))?;
        self.done = 0;
        self.validator = validator;
        self.record()
    }

    /// Feeds up to `max` kept bytes from `from` to `hash` and returns how
    /// many it read (0 once every kept byte was read); the write position is
    /// left at the end of the kept bytes. Callers await between pieces, so a
    /// long prefix never holds up cancel or the task's other downloads.
    pub(crate) fn hash_prefix_chunk(&mut self, from: u64, max: u64, hash: &mut dyn FnMut(&[u8])) -> io::Result<u64> {
        let done = self.done;
        let file = self.file();
        file.seek(SeekFrom::Start(from))?;
        let total = max.min(done.saturating_sub(from));
        let mut remaining = total;
        let mut buffer = vec![0u8; 128 * 1024];
        while remaining > 0 {
            let want = buffer.len().min(usize::try_from(remaining).unwrap_or(usize::MAX));
            let read = file.read(&mut buffer[..want])?;
            if read == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "下载分片比记录短"));
            }
            hash(&buffer[..read]);
            remaining -= read as u64;
        }
        file.seek(SeekFrom::Start(done))?;
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

    /// Appends received bytes; the record is rewritten every few MiB.
    pub(crate) fn append(&mut self, bytes: &[u8]) -> io::Result<()> {
        if self.done + bytes.len() as u64 > self.size {
            return Err(io::Error::other(OVERRUN));
        }
        self.file().write_all(bytes)?;
        self.done += bytes.len() as u64;
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

    fn record(&mut self) -> io::Result<()> {
        self.unrecorded = 0;
        self.last_record = Instant::now();
        let record = Sidecar { version: 1, size: self.size, done: self.done, validator: self.validator.clone() };
        let temporary = self.key.file(&self.root, "json.tmp");
        fs::write(&temporary, serde_json::to_vec(&record).map_err(io::Error::other)?)?;
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
/// same origin, appends a 206 for exactly that range, starts again on a 200,
/// and discards the part on any other range answer. `hash` sees every byte of
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
        return hash_kept(part, hooks, hash).await;
    }
    let resume = part.resume_for(&origin(requested));
    let offset = resume.as_ref().map_or(0, |(offset, _)| *offset);
    let mut request = request.timeout(TRANSFER_TIMEOUT);
    if let Some((offset, validator)) = &resume {
        request = request
            .header(reqwest::header::RANGE, format!("bytes={offset}-"))
            .header(reqwest::header::IF_RANGE, validator.as_str());
    }
    let response = within_stall(hooks, request.send())
        .await?
        // reqwest errors print the request URL; keep it (and any signed query) out of logs.
        .map_err(|error| error.without_url().to_string())?;
    let content_range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    match classify(response.status().as_u16(), content_range.as_deref(), offset, size) {
        Reply::Continue => {}
        Reply::Restart => {
            check(&response)?;
            if response.content_length().is_some_and(|length| length != size) {
                return Err(SIZE_MISMATCH.into());
            }
            part.restart(Validator::of(requested, response.headers())).map_err(io)?;
        }
        Reply::Discard(message) => {
            if let Some(part) = slot.take() {
                part.discard();
            }
            return Err(message);
        }
        Reply::Fail(message) => return Err(message),
    }
    let part = slot.as_mut().ok_or("下载分片不可用")?;
    if part.done() > 0 {
        check(&response)?;
        if response.content_length().is_some_and(|length| length != size - part.done()) {
            return Err("续传响应的长度与请求不符".into());
        }
        hash_kept(part, hooks, &mut *hash).await?;
    }
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = within_stall(hooks, futures_util::StreamExt::next(&mut chunks)).await? {
        hooks.checkpoint().await?;
        let chunk = chunk.map_err(|error| error.without_url().to_string())?;
        part.append(&chunk).map_err(io)?;
        hash(&chunk);
        if part.record_due() {
            durable(part, false).await.map_err(io)?;
        }
        hooks.throttle(chunk.len()).await?;
    }
    durable(part, true).await.map_err(io)?;
    if !part.complete() {
        return Err("下载在预期大小之前结束".into());
    }
    Ok(())
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

/// Hashes the kept bytes a piece at a time, letting cancel, pause and the
/// other downloads of the task run in between.
async fn hash_kept<H: Hooks>(part: &mut ResumablePart, hooks: &H, hash: &mut (dyn FnMut(&[u8]) + Send)) -> Result<(), String> {
    let mut from = 0;
    loop {
        let read = part.hash_prefix_chunk(from, PREFIX_CHUNK, hash).map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(());
        }
        from += read;
        hooks.checkpoint().await?;
        tokio::task::yield_now().await;
    }
}

#[cfg(test)]
#[path = "parts-tests.rs"]
mod tests;

#[cfg(test)]
#[path = "parts-range-server.rs"]
pub(crate) mod range_server;
