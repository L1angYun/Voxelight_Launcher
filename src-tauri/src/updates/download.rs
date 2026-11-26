//! The verified installer download (HSR `UpdateInstaller.DownloadAsync`,
//! with the NovaBar same-user staging model for a per-user install):
//! - staging in `<LOCALAPPDATA>/dev.voxelight.launcher/updates/<guid32>/`,
//!   never under an environment-overridden data directory, never through a
//!   reparse point;
//! - Content-Length must equal the asset size, 8 s idle per read, 10 min in
//!   total, abort as soon as the body runs past the size, SHA-256 compared
//!   in constant time;
//! - in Auto mode only a transport failure tries the other source, an
//!   integrity failure never does;
//! - the final name is committed without replacing anything (H08), then the
//!   file is reopened deny-write and hashed again.
use super::manifest::Package;
use super::sources::{file_url, get_file, FetchError, Transport};
use super::{Preference, Source};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

const READ_IDLE: Duration = Duration::from_secs(8);
const TOTAL: Duration = Duration::from_secs(10 * 60);
const PART: &str = "download.bin";

/// The per-user staging root. Deliberately not the data directory, which
/// `VOXELIGHT_LAUNCHER_DATA_DIR` can move (for example into a test folder).
pub(crate) fn updates_root() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|local| local.join("dev.voxelight.launcher").join("updates"))
        .ok_or_else(|| "无法定位更新暂存目录".into())
}

fn ordinary_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return false;
            }
        }
        metadata.is_dir() && !metadata.file_type().is_symlink()
    })
}

/// Every existing ancestor is an ordinary directory (no junction or link).
pub(crate) fn checked_ancestors(path: &Path) -> bool {
    crate::instances::validate_absolute_syntax(path).is_ok()
        && path.ancestors().filter(|ancestor| ancestor.exists()).all(ordinary_directory)
}

/// A verified installer in its own staging directory. Dropping it removes
/// only the names it owns, then the directory.
pub(crate) struct StagedUpdate {
    pub(crate) package: Package,
    pub(crate) directory: PathBuf,
    pub(crate) installer: PathBuf,
    /// Held open with writers denied until the hand-off.
    handle: Option<std::fs::File>,
    handed_off: bool,
}

impl StagedUpdate {
    #[cfg(test)]
    pub(crate) fn for_test(directory: PathBuf, installer: PathBuf, package: Package) -> Self {
        Self { package, directory, installer, handle: None, handed_off: false }
    }

    /// Keeps the files on disk: the helper process owns them from now on.
    pub(crate) fn hand_off(mut self) {
        self.handed_off = true;
        self.handle = None;
    }

    /// Hashes the held file again (for example right before the hand-off).
    pub(crate) fn verify(&mut self) -> Result<(), String> {
        let handle = self.handle.as_mut().ok_or("暂存的安装包已不可用")?;
        verify_open(handle, &self.package)
    }

}

impl Drop for StagedUpdate {
    fn drop(&mut self) {
        self.handle = None;
        if !self.handed_off && checked_ancestors(&self.directory) {
            let _ = std::fs::remove_file(self.directory.join(PART));
            let _ = std::fs::remove_file(&self.installer);
            let _ = std::fs::remove_dir(&self.directory);
        }
    }
}

fn verify_open(file: &mut std::fs::File, package: &Package) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).map_err(|_| "无法读取暂存的安装包")?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(|_| "无法读取暂存的安装包")?;
        if count == 0 {
            break;
        }
        total += count as u64;
        hash.update(&buffer[..count]);
    }
    if total != package.size || !digest_equals(&hash.finalize(), &package.sha256) {
        return Err("暂存的安装包校验失败，已拒绝安装".into());
    }
    Ok(())
}

/// Constant-time comparison of a SHA-256 digest with its lowercase hex form.
pub(crate) fn digest_equals(actual: &[u8], expected_hex: &str) -> bool {
    let actual: String = actual.iter().map(|byte| format!("{byte:02x}")).collect();
    actual.len() == expected_hex.len()
        && actual.bytes().zip(expected_hex.bytes()).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

/// Opens the committed installer for reading with writers denied.
fn open_deny_write(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x1); // FILE_SHARE_READ only
    }
    options.open(path)
}

/// The download order: the package's own source first; in Auto mode the
/// other source as the fallback for transport failures.
pub(crate) fn locations(package: &Package, preference: Preference) -> Vec<(Source, String)> {
    let other = match package.source {
        Source::GitHub => Source::Gitee,
        Source::Gitee => Source::GitHub,
    };
    let mut order = vec![package.source];
    if preference == Preference::Auto {
        order.push(other);
    }
    order
        .into_iter()
        .map(|source| (source, file_url(source, &package.tag, &package.file_name)))
        .collect()
}

enum Attempt {
    Transport(String),
    Integrity(String),
}

/// The download limits; tests use short ones.
#[derive(Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) idle: Duration,
    pub(crate) total: Duration,
}

pub(crate) const LIMITS: Limits = Limits { idle: READ_IDLE, total: TOTAL };

const CANCEL_POLL: Duration = Duration::from_millis(100);

/// Waits for a remote step, bounded by the idle limit and interrupted by
/// Cancel (HSR links the caller's token into every remote read).
async fn remote<T>(
    future: impl std::future::Future<Output = T>,
    limits: Limits,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<T, Attempt> {
    use futures_util::future::{select, Either};
    let read = std::pin::pin!(tokio::time::timeout(limits.idle, future));
    let stop = std::pin::pin!(async {
        while !cancelled() {
            tokio::time::sleep(CANCEL_POLL).await;
        }
    });
    match select(read, stop).await {
        Either::Left((Ok(output), _)) => Ok(output),
        Either::Left((Err(_), _)) => Err(Attempt::Transport("更新下载超时".into())),
        Either::Right(_) => Err(Attempt::Integrity(crate::downloads::CANCELLED.into())),
    }
}

fn fetch_failure(error: FetchError) -> Attempt {
    match error {
        FetchError::Transport(message) => Attempt::Transport(message),
        FetchError::Invalid(message) => Attempt::Integrity(message),
    }
}

#[allow(clippy::too_many_arguments)]
async fn attempt(
    transport: &dyn Transport,
    package: &Package,
    source: Source,
    url: &str,
    part: &Path,
    limits: Limits,
    progress: &(dyn Fn(u64, u64) + Sync),
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<(), Attempt> {
    use tokio::io::AsyncWriteExt;
    let response = remote(get_file(transport, url, &package.file_name, source, Some(&package.tag)), limits, cancelled)
        .await?
        .map_err(fetch_failure)?;
    if response.content_length.is_some_and(|length| length != package.size) {
        return Err(Attempt::Integrity("安装包大小与发布信息不一致".into()));
    }
    let write_error = |_| Attempt::Integrity("无法写入更新暂存文件".into());
    let mut part_file = crate::download_io::DownloadPart::create(part.to_owned())
        .map_err(|_| Attempt::Integrity("无法创建更新暂存文件".into()))?;
    let mut body = response.body;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    while let Some(chunk) = remote(body.next(), limits, cancelled).await? {
        // A reset is a transport failure; a body that ends before its
        // declared length is an integrity failure (HSR ResponseEnded).
        let chunk = chunk.map_err(fetch_failure)?;
        if chunk.len() as u64 > package.size - total {
            return Err(Attempt::Integrity("安装包超过发布信息中的大小".into()));
        }
        part_file.file().write_all(&chunk).await.map_err(write_error)?;
        hash.update(&chunk);
        total += chunk.len() as u64;
        progress(total, package.size);
    }
    if total != package.size || !digest_equals(&hash.finalize(), &package.sha256) {
        return Err(Attempt::Integrity("安装包的大小或 SHA-256 校验失败".into()));
    }
    // flush surfaces a failed last write before sync_all (HSR FlushAsync + Flush(true)).
    part_file.file().flush().await.map_err(write_error)?;
    part_file.file().sync_all().await.map_err(write_error)?;
    if cancelled() {
        return Err(Attempt::Integrity(crate::downloads::CANCELLED.into()));
    }
    part_file.publish_new(&part.with_file_name(&package.file_name)).map_err(|error| {
        Attempt::Integrity(if error.kind() == std::io::ErrorKind::AlreadyExists {
            "更新暂存目录中已有同名安装包，已停止".into()
        } else {
            "无法提交更新暂存文件".into()
        })
    })
}

/// Reopens the committed installer deny-write and hashes it again; the
/// staged update holds that handle until the hand-off.
pub(crate) fn hold(staged: &mut StagedUpdate) -> Result<(), String> {
    let mut handle = open_deny_write(&staged.installer).map_err(|_| "无法打开暂存的安装包")?;
    verify_open(&mut handle, &staged.package)?;
    staged.handle = Some(handle);
    Ok(())
}

/// Downloads and verifies `package` into a new directory under `root`.
pub(crate) async fn download(
    transport: &dyn Transport,
    package: &Package,
    preference: Preference,
    root: &Path,
    progress: &(dyn Fn(u64, u64) + Sync),
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<StagedUpdate, String> {
    download_with_limits(transport, package, preference, root, LIMITS, progress, cancelled).await
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_with_limits(
    transport: &dyn Transport,
    package: &Package,
    preference: Preference,
    root: &Path,
    limits: Limits,
    progress: &(dyn Fn(u64, u64) + Sync),
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<StagedUpdate, String> {
    // Check the existing ancestors before creating anything, so nothing is
    // ever created through a junction, and again once the root exists.
    if !checked_ancestors(root) {
        return Err("更新暂存目录经过链接或重解析点，已拒绝".into());
    }
    std::fs::create_dir_all(root).map_err(|_| "无法创建更新暂存目录")?;
    if !checked_ancestors(root) {
        return Err("更新暂存目录经过链接或重解析点，已拒绝".into());
    }
    let directory = root.join(uuid::Uuid::new_v4().simple().to_string());
    std::fs::create_dir(&directory).map_err(|_| "无法创建更新暂存目录")?;
    let mut staged = StagedUpdate {
        package: package.clone(),
        installer: directory.join(&package.file_name),
        directory: directory.clone(),
        handle: None,
        handed_off: false,
    };
    let part = directory.join(PART);
    let attempts = locations(package, preference);
    let run = async {
        let mut last = String::from("没有可用的更新下载地址");
        for (source, url) in &attempts {
            if cancelled() {
                return Err(crate::downloads::CANCELLED.to_owned());
            }
            match attempt(transport, package, *source, url, &part, limits, progress, cancelled).await {
                Ok(()) => return Ok(()),
                Err(Attempt::Integrity(message)) => return Err(message),
                // A cancel never tries the other source or reads as a timeout.
                Err(Attempt::Transport(_)) if cancelled() => return Err(crate::downloads::CANCELLED.to_owned()),
                // Only a transport failure tries the other source.
                Err(Attempt::Transport(message)) => last = message,
            }
        }
        Err(last)
    };
    tokio::time::timeout(limits.total, run).await.map_err(|_| "更新下载超时".to_owned())??;
    hold(&mut staged)?;
    Ok(staged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hold_refuses_a_file_changed_after_the_commit() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/update-download-tests")
            .join(uuid::Uuid::new_v4().simple().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let bytes = b"committed bytes";
        let package = Package {
            version: (0, 7, 0).into(),
            tag: "v0.7.0".into(),
            file_name: "VoxelightLauncher-0.7.0-x64-setup.exe".into(),
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            source: Source::GitHub,
        };
        let mut staged = StagedUpdate {
            installer: root.join(&package.file_name),
            directory: root.clone(),
            package,
            handle: None,
            handed_off: false,
        };
        // The same length, different bytes: only a re-read can tell.
        std::fs::write(&staged.installer, b"COMMITTED BYTES").unwrap();
        assert!(hold(&mut staged).is_err());
        assert!(staged.handle.is_none());
        std::fs::write(&staged.installer, bytes).unwrap();
        hold(&mut staged).unwrap();
        assert!(staged.handle.is_some());
        drop(staged);
        assert!(!root.exists(), "the staged update removed its own names and directory");
    }
}
