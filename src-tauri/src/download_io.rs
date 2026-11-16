use crate::downloads::DownloadControl;
use std::{
    fs,
    future::Future,
    io,
    path::{Path, PathBuf},
};

pub(crate) async fn cancellable<F: Future>(
    control: Option<&DownloadControl>,
    pending: F,
) -> Result<F::Output, String> {
    match control {
        Some(control) => control.during_cancellable_io(pending).await,
        None => Ok(pending.await),
    }
}

/// Owns exactly the temporary file this attempt created, including when a
/// fail-fast batch drops a future without polling its error-handling code.
pub(crate) struct DownloadPart {
    path: Option<PathBuf>,
    file: Option<tokio::fs::File>,
}

impl DownloadPart {
    pub(crate) fn create(path: PathBuf) -> io::Result<Self> {
        // Complete the create and adopt its ownership before the first await.
        // Async open can still create a file after its future is dropped.
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Self {
            path: Some(path),
            file: Some(tokio::fs::File::from_std(file)),
        })
    }

    pub(crate) fn file(&mut self) -> &mut tokio::fs::File {
        self.file
            .as_mut()
            .expect("download part stays open until publication")
    }

    pub(crate) fn publish(mut self, target: &Path) -> io::Result<()> {
        drop(self.file.take());
        fs::rename(
            self.path
                .as_ref()
                .expect("download part owns an unpublished path"),
            target,
        )?;
        self.path = None;
        Ok(())
    }
}

impl Drop for DownloadPart {
    fn drop(&mut self) {
        drop(self.file.take());
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}
