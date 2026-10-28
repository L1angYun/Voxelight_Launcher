use crate::{
    errors::{expected, AppResult},
    minecraft,
    storage::LauncherState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub kind: String,
    pub target: String,
    pub label: String,
    pub status: String,
    pub stage: String,
    pub completed: usize,
    pub total: usize,
    pub bytes_completed: u64,
    pub bytes_total: u64,
    pub message: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub struct DownloadControl {
    jobs: Mutex<Vec<DownloadJob>>,
    active: Mutex<Option<String>>,
    paused: AtomicBool,
    cancelled: AtomicBool,
    limit_kib: AtomicU64,
    next_slot: Mutex<Instant>,
    journal: Option<PathBuf>,
    last_save: Mutex<Instant>,
}

impl Default for DownloadControl {
    fn default() -> Self {
        Self {
            jobs: Mutex::new(Vec::new()),
            active: Mutex::new(None),
            paused: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            limit_kib: AtomicU64::new(0),
            next_slot: Mutex::new(Instant::now()),
            journal: None,
            last_save: Mutex::new(Instant::now()),
        }
    }
}

impl DownloadControl {
    pub fn load(directory: PathBuf, limit: u64) -> Result<Self, Box<dyn std::error::Error>> {
        let file = directory.join("download-jobs.json");
        let mut result = Self::default();
        result.journal = Some(file.clone());
        result.limit_kib.store(limit, Ordering::Relaxed);
        if file.exists() {
            let bytes = fs::read(&file)?;
            match serde_json::from_slice::<Vec<DownloadJob>>(&bytes) {
                Ok(mut jobs) => {
                    for job in &mut jobs {
                        if ["running", "paused", "queued"].contains(&job.status.as_str()) {
                            job.status = "interrupted".into();
                            job.message = "上次运行被中断，可重试继续复用已校验文件".into();
                        }
                    }
                    result.jobs = Mutex::new(jobs);
                }
                Err(_) => {
                    fs::copy(
                        &file,
                        directory.join(format!(
                            "download-jobs-corrupt-{}.json",
                            uuid::Uuid::new_v4()
                        )),
                    )?;
                }
            }
        }
        result.persist()?;
        Ok(result)
    }
    pub fn list(&self) -> Vec<DownloadJob> {
        self.jobs
            .lock()
            .map(|jobs| jobs.clone())
            .unwrap_or_default()
    }
    fn persist(&self) -> Result<(), String> {
        let Some(file) = &self.journal else {
            return Ok(());
        };
        let bytes = serde_json::to_vec_pretty(&self.list()).map_err(|e| e.to_string())?;
        let temp = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        fs::rename(temp, file).map_err(|e| e.to_string())
    }
    pub fn enqueue(&self, kind: &str, target: &str, label: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let time = chrono::Utc::now().to_rfc3339();
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.push(DownloadJob {
                id: id.clone(),
                kind: kind.into(),
                target: target.into(),
                label: label.into(),
                status: "queued".into(),
                stage: "queued".into(),
                completed: 0,
                total: 0,
                bytes_completed: 0,
                bytes_total: 0,
                message: "等待执行".into(),
                error: None,
                created_at: time.clone(),
                updated_at: time,
            });
            if jobs.len() > 200 {
                if let Some(index) = jobs
                    .iter()
                    .position(|j| ["completed", "failed", "cancelled"].contains(&j.status.as_str()))
                {
                    jobs.remove(index);
                }
            }
        }
        let _ = self.persist();
        id
    }
    pub fn activate(&self, id: &str) -> bool {
        let mut found = false;
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.iter_mut().find(|job| job.id == id) {
                if job.status == "cancelled" {
                    return false;
                }
                job.status = "running".into();
                job.message = "正在准备".into();
                job.updated_at = chrono::Utc::now().to_rfc3339();
                found = true;
            }
        }
        if found {
            self.cancelled.store(false, Ordering::SeqCst);
            self.paused.store(false, Ordering::SeqCst);
            if let Ok(mut active) = self.active.lock() {
                *active = Some(id.into());
            }
            if let Ok(mut slot) = self.next_slot.lock() {
                *slot = Instant::now();
            }
            let _ = self.persist();
        }
        found
    }
    pub fn begin(&self, kind: &str, target: &str, label: &str) -> String {
        let id = self.enqueue(kind, target, label);
        self.activate(&id);
        id
    }
    pub fn finish(&self, id: &str, error: Option<&str>) {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.iter_mut().find(|j| j.id == id) {
                job.status = if error.is_none() {
                    "completed"
                } else if self.cancelled.load(Ordering::SeqCst) {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                job.error = error.map(str::to_owned);
                job.message = error.unwrap_or("任务完成").into();
                job.updated_at = chrono::Utc::now().to_rfc3339();
            }
        }
        if let Ok(mut active) = self.active.lock() {
            if active.as_deref() == Some(id) {
                *active = None;
                self.paused.store(false, Ordering::SeqCst);
            }
        }
        let _ = self.persist();
    }
    pub fn record(&self, progress: &Value) {
        let active = self.active.lock().ok().and_then(|id| id.clone());
        let Some(id) = active else { return };
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.iter_mut().find(|job| job.id == id) {
                job.stage = progress["stage"].as_str().unwrap_or("").into();
                job.message = progress["message"].as_str().unwrap_or("").into();
                job.completed = progress["completed"].as_u64().unwrap_or(0) as usize;
                job.total = progress["total"].as_u64().unwrap_or(0) as usize;
                job.bytes_completed = progress["bytesCompleted"].as_u64().unwrap_or(0);
                job.bytes_total = progress["bytesTotal"].as_u64().unwrap_or(0);
                job.updated_at = chrono::Utc::now().to_rfc3339();
            }
        }
        let save = self
            .last_save
            .lock()
            .map(|mut last| {
                if last.elapsed() > Duration::from_millis(750) {
                    *last = Instant::now();
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if save {
            let _ = self.persist();
        }
    }
    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
        let id = self.active.lock().ok().and_then(|id| id.clone());
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.iter_mut().find(|job| Some(&job.id) == id.as_ref()) {
                job.status = if paused { "paused" } else { "running" }.into();
            }
        }
        let _ = self.persist();
    }
    pub fn cancel(&self, task_id: Option<&str>) {
        let active = self.active.lock().ok().and_then(|id| id.clone());
        if task_id.is_none() || task_id == active.as_deref() {
            self.cancelled.store(true, Ordering::SeqCst);
            self.paused.store(false, Ordering::SeqCst);
        }
        if let Some(id) = task_id {
            if let Ok(mut jobs) = self.jobs.lock() {
                if let Some(job) = jobs
                    .iter_mut()
                    .find(|job| job.id == id && job.status == "queued")
                {
                    job.status = "cancelled".into();
                    job.message = "已取消排队任务".into();
                }
            }
        }
        let _ = self.persist();
    }
    pub fn set_limit(&self, kib: u64) {
        self.limit_kib.store(kib, Ordering::Relaxed);
    }
    pub async fn checkpoint(&self) -> Result<(), String> {
        loop {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err("任务已取消，已校验文件保留供下次复用".into());
            }
            if !self.paused.load(Ordering::SeqCst) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }
    }
    pub async fn throttle(&self, bytes: usize) -> Result<(), String> {
        self.checkpoint().await?;
        let limit = self.limit_kib.load(Ordering::Relaxed);
        if limit == 0 {
            return Ok(());
        }
        let until = {
            let mut slot = self.next_slot.lock().map_err(|_| "限速状态异常")?;
            let now = Instant::now();
            if *slot < now {
                *slot = now;
            }
            *slot += Duration::from_secs_f64(bytes as f64 / (limit as f64 * 1024.0));
            *slot
        };
        while Instant::now() < until {
            self.checkpoint().await?;
            tokio::time::sleep(
                until
                    .saturating_duration_since(Instant::now())
                    .min(Duration::from_millis(80)),
            )
            .await;
        }
        Ok(())
    }
}

#[tauri::command]
pub fn list_download_tasks(state: State<'_, Arc<LauncherState>>) -> Vec<DownloadJob> {
    state.control.list()
}
#[tauri::command]
pub fn set_download_paused(state: State<'_, Arc<LauncherState>>, paused: bool) -> Vec<DownloadJob> {
    state.control.set_paused(paused);
    state.control.list()
}
#[tauri::command]
pub fn cancel_download_task(
    state: State<'_, Arc<LauncherState>>,
    task_id: Option<String>,
) -> Vec<DownloadJob> {
    state.control.cancel(task_id.as_deref());
    state.control.list()
}
#[tauri::command]
pub async fn queue_install(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
) -> Result<String, String> {
    crate::storage::validate_id(&version_id)?;
    let id = state
        .control
        .enqueue("install", &version_id, &format!("Minecraft {version_id}"));
    spawn_install(app, state.inner().clone(), id.clone(), version_id);
    Ok(id)
}
fn spawn_install(app: AppHandle, state: Arc<LauncherState>, id: String, version: String) {
    tauri::async_runtime::spawn(async move {
        let _guard = state.operation.lock().await;
        if !state.control.activate(&id) {
            return;
        }
        let _ = app.emit("launcher://tasks", state.control.list());
        let result = minecraft::install(&state, &app, &version).await;
        state
            .control
            .finish(&id, result.as_ref().err().map(String::as_str));
        if let Err(error) = result {
            minecraft::log(&app, &state, "error", error);
        }
        let _ = app.emit("launcher://tasks", state.control.list());
    });
}
#[tauri::command]
pub async fn retry_download_task(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    task_id: String,
) -> AppResult<String> {
    let job = state
        .control
        .list()
        .into_iter()
        .find(|job| job.id == task_id)
        .ok_or_else(|| expected("任务不存在"))?;
    if job.kind != "install" {
        return Err(expected(
            "请回到对应资源、整合包或备份页面重新执行；已校验文件会复用",
        ));
    }
    if ["running", "paused", "queued"].contains(&job.status.as_str()) {
        return Err(expected("该任务仍在执行或排队"));
    }
    queue_install(app, state, job.target)
        .await
        .map_err(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelling_a_queued_job_does_not_cancel_active_job() {
        let control = DownloadControl::default();
        let first = control.begin("install", "1.21.1", "First");
        let second = control.enqueue("install", "1.20.1", "Second");
        control.cancel(Some(&second));
        assert!(!control.cancelled.load(Ordering::SeqCst));
        assert!(!control.activate(&second));
        control.finish(&first, None);
        assert_eq!(control.list()[0].status, "completed");
        assert_eq!(control.list()[1].status, "cancelled");
    }
    #[test]
    fn finishing_an_old_task_preserves_the_active_tasks_pause_and_cancellation() {
        let control = DownloadControl::default();
        let old = control.begin("install", "old", "Old");
        control.finish(&old, None);
        let active = control.begin("launch", "active", "Active");
        control.set_paused(true);
        control.finish(&old, None);
        assert!(control.paused.load(Ordering::SeqCst));
        assert_eq!(
            control.active.lock().unwrap().as_deref(),
            Some(active.as_str())
        );
        control.cancel(Some(&active));
        control.finish(&old, None);
        assert!(control.cancelled.load(Ordering::SeqCst));
        control.finish(&active, Some("cancelled"));
        assert!(control.active.lock().unwrap().is_none());
        assert_eq!(control.list()[1].status, "cancelled");
    }

    #[test]
    fn paused_operation_cancels_promptly_and_next_job_can_run() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let control = Arc::new(DownloadControl::default());
            let task = control.begin("install", "test", "Test");
            control.set_paused(true);
            let copy = control.clone();
            let waiter = tokio::spawn(async move { copy.checkpoint().await });
            tokio::time::sleep(Duration::from_millis(20)).await;
            control.cancel(None);
            assert!(tokio::time::timeout(Duration::from_secs(1), waiter)
                .await
                .unwrap()
                .unwrap()
                .is_err());
            control.finish(&task, Some("cancelled"));
            let next = control.begin("install", "next", "Next");
            assert!(control.checkpoint().await.is_ok());
            control.finish(&next, None);
        });
    }
}
