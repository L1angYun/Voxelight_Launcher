use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::Mutex,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

const MAX_LINE_BYTES: usize = 64 * 1024;
const LOG_SHARD_BYTES: u64 = 4 * 1024 * 1024;
const ACTIVE_LOGS: usize = 4;
static WRITE_LOG: Mutex<()> = Mutex::new(());

pub(crate) async fn next_process_line<R>(reader: &mut R) -> Result<Option<String>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().await.map_err(|error| error.to_string())?;
        if available.is_empty() {
            if !oversized && bytes.is_empty() {
                return Ok(None);
            }
            break;
        }
        let end = available.iter().position(|&byte| byte == b'\n');
        let count = end.unwrap_or(available.len());
        if !oversized && bytes.len() + count <= MAX_LINE_BYTES {
            bytes.extend_from_slice(&available[..count]);
        } else {
            // Redact complete records only. An arbitrary prefix can end
            // midway through a credential or another redaction delimiter.
            oversized = true;
            bytes.clear();
        }
        reader.consume(count + usize::from(end.is_some()));
        if end.is_some() {
            break;
        }
    }
    Ok(Some(if oversized {
        "子进程输出行超过 64 KiB，已省略".into()
    } else {
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }))
}

pub(crate) fn append_log(directory: &Path, record: &str) -> io::Result<()> {
    let _guard = WRITE_LOG
        .lock()
        .map_err(|_| io::Error::other("log lock poisoned"))?;
    append_limited(directory, record.as_bytes(), LOG_SHARD_BYTES)
}

fn ordinary(path: &Path) -> io::Result<Option<u64>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err(io::Error::other("redirected log file"));
                }
            }
            Ok(Some(metadata.len()))
        }
        Ok(_) => Err(io::Error::other("not an ordinary log file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn append_limited(directory: &Path, record: &[u8], shard_limit: u64) -> io::Result<()> {
    let marker = "输出记录过大，已省略\n".as_bytes();
    let record = if record.len() as u64 > shard_limit {
        marker
    } else {
        record
    };
    if record.len() as u64 > shard_limit {
        return Err(io::Error::other("bad log size limit"));
    }
    crate::instances::checked_absolute(directory).map_err(io::Error::other)?;
    fs::create_dir_all(directory)?;
    let current = directory.join("launcher-current.log");
    let length = ordinary(&current)?.unwrap_or(0);
    if length.saturating_add(record.len() as u64) > shard_limit {
        // Rotate only this format's owned names. Legacy dated logs and
        // unrelated files in the directory never enter this loop.
        let archive = |n| directory.join(format!("launcher-current.{n}.log"));
        let last = archive(ACTIVE_LOGS - 1);
        if ordinary(&last)?.is_some() {
            fs::remove_file(last)?;
        }
        for n in (1..ACTIVE_LOGS - 1).rev() {
            let previous = archive(n);
            if ordinary(&previous)?.is_some() {
                fs::rename(previous, archive(n + 1))?;
            }
        }
        fs::rename(&current, archive(1))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(current)?
        .write_all(record)
}

pub(crate) struct LaunchScratch {
    dir: crate::instances::StagingDirectory,
    in_use: bool,
}

impl LaunchScratch {
    pub(crate) fn create(game: &Path) -> Result<Self, String> {
        let root = crate::storage::runtime_temp_directory(game)?;
        let path = crate::storage::safe_join(&root, &format!("run-{}", uuid::Uuid::new_v4()))?;
        Ok(Self {
            dir: crate::instances::StagingDirectory::create(path)?,
            in_use: false,
        })
    }

    pub(crate) fn natives(&self) -> Result<std::path::PathBuf, String> {
        crate::storage::safe_join(self.dir.path(), "natives")
    }

    pub(crate) fn java_temp(&self) -> Result<std::path::PathBuf, String> {
        let path = crate::storage::safe_join(self.dir.path(), "tmp")?;
        fs::create_dir(&path).map_err(|error| error.to_string())?;
        Ok(path)
    }

    pub(crate) fn write_args(&self, content: &str) -> Result<std::path::PathBuf, String> {
        let path = crate::storage::safe_join(self.dir.path(), "launcher.args")?;
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .and_then(|mut file: File| file.write_all(content.as_bytes()))
            .map_err(|error| format!("写入 Java 参数文件失败：{error}"))?;
        Ok(path)
    }

    pub(crate) fn started(&mut self) {
        self.in_use = true;
    }

    pub(crate) fn finished(&mut self) {
        self.in_use = false;
    }
}

impl Drop for LaunchScratch {
    fn drop(&mut self) {
        // An abandoned wait future does not imply that Java has stopped:
        // launcher exit, crash, or a failed wait must preserve its resources.
        if self.in_use {
            self.dir.preserve();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory() -> std::path::PathBuf {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/process-output-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn m07_log_rotates_only_owned_shards_and_keeps_the_latest_record() {
        let path = test_directory();
        fs::write(path.join("launcher-2026-11-01.log"), "existing history").unwrap();
        for n in 0..12 {
            append_limited(&path, format!("record {n:02}\n").as_bytes(), 15).unwrap();
        }
        let current = path.join("launcher-current.log");
        assert_eq!(fs::read_to_string(current).unwrap(), "record 11\n");
        for n in 1..4 {
            let shard = fs::read_to_string(path.join(format!("launcher-current.{n}.log"))).unwrap();
            assert_eq!(shard, format!("record {:02}\n", 11 - n));
        }
        assert_eq!(fs::read_dir(&path).unwrap().count(), 5);
        assert_eq!(
            fs::read_to_string(path.join("launcher-2026-11-01.log")).unwrap(),
            "existing history"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn m07_launch_preparation_owns_only_its_scratch() {
        let path = test_directory();
        let base = crate::storage::runtime_temp_directory(&path).unwrap();
        fs::write(base.join("other-run"), "untouched").unwrap();
        let (args, temp, natives) = {
            let scratch = LaunchScratch::create(&path).unwrap();
            let args = scratch.write_args("harmless JVM metadata").unwrap();
            let temp = scratch.java_temp().unwrap();
            let natives = scratch.natives().unwrap();
            fs::create_dir(&natives).unwrap();
            assert!(args.is_file() && temp.is_dir() && natives.is_dir());
            (args, temp, natives)
        };
        assert!(!args.exists() && !temp.exists() && !natives.exists());
        assert_eq!(
            fs::read_to_string(base.join("other-run")).unwrap(),
            "untouched"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn m07_uncertain_child_exit_keeps_resources_but_confirmed_exit_cleans() {
        let path = test_directory();
        let run_path = {
            let mut scratch = LaunchScratch::create(&path).unwrap();
            let args = scratch.write_args("launcher-owned JVM arguments").unwrap();
            scratch.started();
            args
        };
        assert!(run_path.is_file());
        let finished_path = {
            let mut scratch = LaunchScratch::create(&path).unwrap();
            let args = scratch.write_args("launcher-owned JVM arguments").unwrap();
            scratch.started();
            scratch.finished();
            args
        };
        assert!(!finished_path.exists());
        fs::remove_dir_all(path).unwrap();
    }
}
