use crate::{
    errors::{expected, AppResult},
    minecraft,
    models::ProgressEvent,
    storage::LauncherState,
};
use futures_util::{future::Either, pin_mut};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::watch;

pub(crate) const CANCELLED: &str = "任务已取消，已校验文件保留供下次复用";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    pub kind: String,
    pub target: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_target: Option<String>,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSnapshot {
    revision: u64,
    tasks: Vec<DownloadJob>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RunSignal {
    Ready,
    Paused,
    Cancelled,
    Finished,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceRequest {
    pub source: ResourceSource,
    pub project_id: String,
    pub resource_type: String,
    pub target: ResourceTarget,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ResourceSource {
    Modrinth,
    Curseforge,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum ResourceTarget {
    Existing {
        version_id: String,
        instance_id: Option<String>,
        file_id: Option<u64>,
    },
    Create {
        game_version: String,
        loader: String,
        loader_version: Option<String>,
        name: String,
    },
}

#[derive(PartialEq)]
enum Reservation {
    Launch { instance_id: Option<String> },
    Resource(ResourceRequest),
}

struct PendingTask {
    signal: watch::Sender<RunSignal>,
    reservation: Option<Reservation>,
    claimed: bool,
    starting_game: bool,
}

struct Scheduler {
    jobs: Vec<DownloadJob>,
    live: HashMap<String, PendingTask>,
    active: Option<String>,
    revision: u64,
    last_save: Instant,
}

impl Default for Scheduler {
    fn default() -> Self {
        Self {
            jobs: Vec::new(),
            live: HashMap::new(),
            active: None,
            revision: 0,
            last_save: Instant::now(),
        }
    }
}

type SnapshotEmitter = dyn Fn(DownloadSnapshot) + Send + Sync;

pub struct DownloadControl {
    scheduler: Mutex<Scheduler>,
    emitter: Mutex<Option<Arc<SnapshotEmitter>>>,
    limit_kib: AtomicU64,
    next_slot: Mutex<Instant>,
    journal: Option<PathBuf>,
}

impl Default for DownloadControl {
    fn default() -> Self {
        Self {
            scheduler: Mutex::new(Scheduler::default()),
            emitter: Mutex::new(None),
            limit_kib: AtomicU64::new(0),
            next_slot: Mutex::new(Instant::now()),
            journal: None,
        }
    }
}

fn update_state(job: &mut DownloadJob, status: &str, stage: Option<&str>, message: &str) {
    job.status = status.into();
    if let Some(stage) = stage {
        job.stage = stage.into();
    }
    job.message = message.into();
    job.updated_at = chrono::Utc::now().to_rfc3339();
}

fn snapshot_of(state: &Scheduler) -> DownloadSnapshot {
    DownloadSnapshot {
        revision: state.revision,
        tasks: state.jobs.clone(),
    }
}

// The caller holds the scheduler lock until the replace completes. A progress
// write cannot publish older bytes after a terminal transition.
fn write_journal(path: &Path, jobs: &[DownloadJob]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(jobs).map_err(|error| error.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    let result = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| fs::rename(&temp, path));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result.map_err(|error| error.to_string())
}

impl DownloadControl {
    pub fn load(directory: PathBuf, limit: u64) -> Result<Self, Box<dyn std::error::Error>> {
        let path = directory.join("download-jobs.json");
        let mut result = Self::default();
        result.journal = Some(path.clone());
        result.set_limit(limit);
        let state = result.scheduler.get_mut().unwrap();
        if path.exists() {
            let bytes = fs::read(&path)?;
            match serde_json::from_slice::<Vec<DownloadJob>>(&bytes) {
                Ok(mut jobs) => {
                    for job in &mut jobs {
                        if matches!(job.status.as_str(), "running" | "paused" | "queued") {
                            update_state(
                                job,
                                "interrupted",
                                Some("interrupted"),
                                "上次运行被中断，可重试继续复用已校验文件",
                            );
                        }
                    }
                    state.jobs = jobs;
                }
                Err(_) => {
                    fs::copy(
                        &path,
                        directory.join(format!(
                            "download-jobs-corrupt-{}.json",
                            uuid::Uuid::new_v4()
                        )),
                    )?;
                }
            }
        }
        write_journal(&path, &state.jobs)?;
        Ok(result)
    }

    pub fn bind_events(&self, app: AppHandle) {
        self.set_emitter(move |snapshot| {
            let _ = app.emit("launcher://tasks", snapshot);
        });
    }

    fn set_emitter(&self, emit: impl Fn(DownloadSnapshot) + Send + Sync + 'static) {
        if let Ok(mut emitter) = self.emitter.lock() {
            *emitter = Some(Arc::new(emit));
        }
    }

    pub fn unbind_events(&self) {
        if let Ok(mut emitter) = self.emitter.lock() {
            *emitter = None;
        }
    }

    fn mutate<T>(
        &self,
        immediate_save: bool,
        edit: impl FnOnce(&mut Scheduler) -> Option<T>,
    ) -> Option<T> {
        let emitter = self.emitter.lock().ok().and_then(|emit| emit.clone());
        let (out, snapshot) = {
            let mut state = self.scheduler.lock().ok()?;
            let out = edit(&mut state)?;
            state.revision += 1;
            if immediate_save || state.last_save.elapsed() >= Duration::from_millis(750) {
                state.last_save = Instant::now();
                if let Some(path) = &self.journal {
                    if let Err(error) = write_journal(path, &state.jobs) {
                        eprintln!("[voxelight/downloads] cannot save task history: {error}");
                    }
                }
            }
            let snapshot = emitter.as_ref().map(|_| snapshot_of(&state));
            (out, snapshot)
        };
        if let (Some(snapshot), Some(emit)) = (snapshot, emitter) {
            emit(snapshot);
        }
        Some(out)
    }

    pub fn snapshot(&self) -> DownloadSnapshot {
        self.scheduler
            .lock()
            .map(|state| snapshot_of(&state))
            .unwrap_or(DownloadSnapshot {
                revision: 0,
                tasks: Vec::new(),
            })
    }

    pub fn list(&self) -> Vec<DownloadJob> {
        self.snapshot().tasks
    }

    fn create_job(
        &self,
        kind: &str,
        target: &str,
        label: &str,
        display_target: Option<&str>,
        reservation: Option<Reservation>,
        start_now: bool,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let time = chrono::Utc::now().to_rfc3339();
        self.mutate(true, |state| {
            if start_now && state.active.is_some() {
                return None;
            }
            if start_now {
                state.active = Some(id.clone());
            }
            state.jobs.push(DownloadJob {
                id: id.clone(),
                kind: kind.into(),
                target: target.into(),
                label: label.into(),
                display_target: display_target.map(str::to_owned),
                status: if start_now { "running" } else { "queued" }.into(),
                stage: "queued".into(),
                completed: 0,
                total: 0,
                bytes_completed: 0,
                bytes_total: 0,
                message: if start_now {
                    "正在准备"
                } else {
                    "等待执行"
                }
                .into(),
                error: None,
                created_at: time.clone(),
                updated_at: time,
            });
            state.live.insert(
                id.clone(),
                PendingTask {
                    signal: watch::channel(RunSignal::Ready).0,
                    reservation,
                    claimed: false,
                    starting_game: false,
                },
            );
            if state.jobs.len() > 200 {
                if let Some(index) = state
                    .jobs
                    .iter()
                    .position(|job| !state.live.contains_key(&job.id))
                {
                    state.jobs.remove(index);
                }
            }
            Some(())
        })
        .ok_or("已有下载或启动准备任务运行")?;
        Ok(id)
    }

    pub fn enqueue(&self, kind: &str, target: &str, label: &str) -> Result<String, String> {
        self.create_job(kind, target, label, None, None, false)
    }

    pub fn reserve_launch(
        &self,
        version: &str,
        instance: Option<String>,
    ) -> Result<String, String> {
        self.create_job(
            "launch",
            version,
            &format!("启动 Minecraft {version}"),
            None,
            Some(Reservation::Launch { instance_id: instance }),
            false,
        )
    }

    pub fn claim_launch(
        &self,
        id: &str,
        version: &str,
        instance: Option<&str>,
    ) -> Result<(), String> {
        self.claim(id, "launch", version, &Reservation::Launch {
            instance_id: instance.map(str::to_owned),
        })
    }

    pub(crate) fn reserve_resource(&self, request: ResourceRequest) -> Result<String, String> {
        let label = match (&request.source, &request.target) {
            (ResourceSource::Modrinth, ResourceTarget::Create { .. }) => "创建实例并安装资源",
            (ResourceSource::Modrinth, _) => "安装 Modrinth 资源及必需前置",
            (ResourceSource::Curseforge, _) => "安装 CurseForge 资源",
        };
        let project_id = request.project_id.clone();
        self.create_job("resource", &project_id, label, None, Some(Reservation::Resource(request)), false)
    }

    pub(crate) fn claim_resource(&self, id: &str, request: ResourceRequest) -> Result<(), String> {
        let project_id = request.project_id.clone();
        self.claim(id, "resource", &project_id, &Reservation::Resource(request))
    }

    fn claim(&self, id: &str, kind: &str, target: &str, reservation: &Reservation) -> Result<(), String> {
        let mut state = self.scheduler.lock().map_err(|_| "下载任务状态异常")?;
        let job = state
            .jobs
            .iter()
            .find(|job| job.id == id)
            .ok_or("任务不存在")?;
        if job.kind != kind || job.target != target {
            return Err("任务不存在".into());
        }
        if job.status == "cancelled" {
            return Err(CANCELLED.into());
        }
        let live = state.live.get_mut(id).ok_or("任务不存在")?;
        if live.reservation.as_ref() != Some(reservation) || live.claimed {
            return Err("任务不存在".into());
        }
        live.claimed = true;
        Ok(())
    }

    pub fn activate(&self, id: &str) -> bool {
        self.mutate(true, |state| {
            if state.active.is_some() {
                return None;
            }
            let job = state.jobs.iter_mut().find(|job| job.id == id)?;
            if job.status != "queued" || !state.live.contains_key(id) {
                return None;
            }
            state.active = Some(id.into());
            update_state(job, "running", None, "正在准备");
            Some(())
        })
        .is_some()
    }

    pub fn begin(&self, kind: &str, target: &str, label: &str) -> Result<String, String> {
        self.create_job(kind, target, label, None, None, true)
    }

    pub(crate) fn begin_with_display(
        &self,
        kind: &str,
        target: &str,
        label: &str,
        display_target: &str,
    ) -> Result<String, String> {
        self.create_job(kind, target, label, Some(display_target), None, true)
    }

    pub fn finish(&self, id: &str, error: Option<&str>) {
        self.mutate(true, |state| {
            let job = state.jobs.iter_mut().find(|job| job.id == id)?;
            let signal = state.live.remove(id)?.signal;
            let (status, stage, message) = match error {
                None => ("completed", "complete", "任务完成"),
                Some(_) if *signal.borrow() == RunSignal::Cancelled => {
                    ("cancelled", "cancelled", CANCELLED)
                }
                Some(error) => ("failed", "failed", error),
            };
            update_state(job, status, Some(stage), message);
            job.error = error.map(str::to_owned);
            if state.active.as_deref() == Some(id) {
                state.active = None;
            }
            signal.send_replace(RunSignal::Finished);
            Some(())
        });
    }

    /// Stamp progress synchronously while on the source task's stack. Do not
    /// feed it back through app listeners that can run after the task changes.
    pub fn record_progress(&self, mut progress: ProgressEvent) -> Option<ProgressEvent> {
        self.mutate(false, |state| {
            let id = state.active.as_ref()?;
            if *state.live.get(id)?.signal.borrow() == RunSignal::Cancelled {
                return None;
            }
            let job = state.jobs.iter_mut().find(|job| &job.id == id)?;
            progress.task_id.clone_from(id);
            progress.operation.clone_from(&job.kind);
            job.stage.clone_from(&progress.stage);
            job.message.clone_from(&progress.message);
            job.completed = progress.completed;
            job.total = progress.total;
            job.bytes_completed = progress.bytes_completed;
            job.bytes_total = progress.bytes_total;
            job.updated_at = chrono::Utc::now().to_rfc3339();
            Some(progress)
        })
    }

    pub fn set_paused(&self, id: &str, paused: bool) {
        self.mutate(true, |state| {
            if state.active.as_deref() != Some(id) {
                return None;
            }
            let live = state.live.get(id)?;
            if live.starting_game {
                return None;
            }
            let signal = &live.signal;
            let next = if paused {
                RunSignal::Paused
            } else {
                RunSignal::Ready
            };
            let previous = *signal.borrow();
            if !matches!(previous, RunSignal::Ready | RunSignal::Paused) || previous == next {
                return None;
            }
            let job = state.jobs.iter_mut().find(|job| job.id == id)?;
            job.status = if paused { "paused" } else { "running" }.into();
            job.updated_at = chrono::Utc::now().to_rfc3339();
            signal.send_replace(next);
            Some(())
        });
    }

    pub fn cancel(&self, id: &str) {
        self.mutate(true, |state| {
            let job = state.jobs.iter_mut().find(|job| job.id == id)?;
            let live = state.live.get(id)?;
            if live.starting_game {
                return None;
            }
            let signal = &live.signal;
            if *signal.borrow() == RunSignal::Cancelled {
                return None;
            }
            signal.send_replace(RunSignal::Cancelled);
            if state.active.as_deref() != Some(id) {
                update_state(job, "cancelled", Some("cancelled"), CANCELLED);
                state.live.remove(id);
            }
            Some(())
        });
    }

    fn active_signal(&self) -> Option<watch::Receiver<RunSignal>> {
        let state = self.scheduler.lock().ok()?;
        Some(state.live.get(state.active.as_ref()?)?.signal.subscribe())
    }

    pub async fn wait_for_turn<'a>(
        &self,
        operation: &'a tokio::sync::Mutex<()>,
        id: &str,
    ) -> Result<tokio::sync::MutexGuard<'a, ()>, String> {
        let signal = self
            .scheduler
            .lock()
            .map_err(|_| "下载任务状态异常")?
            .live
            .get(id)
            .ok_or(CANCELLED)?
            .signal
            .subscribe();
        race_cancellation(signal, operation.lock()).await
    }

    pub async fn checkpoint(&self) -> Result<(), String> {
        match self.active_signal() {
            Some(signal) => checkpoint(signal).await,
            None => Ok(()),
        }
    }

    pub async fn during_cancellable_io<F: Future>(&self, future: F) -> Result<F::Output, String> {
        match self.active_signal() {
            Some(signal) => race_cancellation(signal, future).await,
            None => Ok(future.await),
        }
    }

    /// Cancellation and starting the operating-system process have one ordering.
    /// If spawning won already, the normal Stop action owns that live game.
    pub async fn start_game<T>(
        &self,
        task_id: &str,
        start: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        loop {
            let signal = {
                let mut state = self.scheduler.lock().map_err(|_| "下载任务状态异常")?;
                if state.active.as_deref() != Some(task_id) {
                    return Err(CANCELLED.into());
                }
                let task = state.live.get_mut(task_id).ok_or(CANCELLED)?;
                let current = *task.signal.borrow();
                match current {
                    RunSignal::Ready if !task.starting_game => {
                        task.starting_game = true;
                        None
                    }
                    RunSignal::Paused => Some(task.signal.subscribe()),
                    _ => return Err(CANCELLED.into()),
                }
            };
            match signal {
                Some(signal) => checkpoint(signal).await?,
                None => return start(),
            }
        }
    }

    pub fn set_limit(&self, kib: u64) {
        self.limit_kib.store(kib, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(crate) fn limit_for_test(&self) -> u64 {
        self.limit_kib.load(Ordering::Relaxed)
    }

    pub async fn throttle(&self, bytes: usize) -> Result<(), String> {
        self.wait_for_bandwidth(bytes, self.active_signal()).await
    }

    pub(crate) async fn throttle_preview(&self, bytes: usize) -> Result<(), String> {
        self.wait_for_bandwidth(bytes, None).await
    }

    async fn wait_for_bandwidth(
        &self,
        bytes: usize,
        signal: Option<watch::Receiver<RunSignal>>,
    ) -> Result<(), String> {
        if let Some(signal) = &signal {
            checkpoint(signal.clone()).await?;
        }
        let limit = self.limit_kib.load(Ordering::Relaxed);
        if limit == 0 {
            return Ok(());
        }
        let until = {
            let mut slot = self.next_slot.lock().map_err(|_| "限速状态异常")?;
            *slot = (*slot).max(Instant::now())
                + Duration::from_secs_f64(bytes as f64 / (limit as f64 * 1024.0));
            *slot
        };
        let delay = tokio::time::sleep(until.saturating_duration_since(Instant::now()));
        if let Some(signal) = signal {
            race_cancellation(signal.clone(), delay).await?;
            checkpoint(signal).await
        } else {
            delay.await;
            Ok(())
        }
    }
}

async fn checkpoint(mut signal: watch::Receiver<RunSignal>) -> Result<(), String> {
    loop {
        let current = *signal.borrow_and_update();
        match current {
            RunSignal::Cancelled | RunSignal::Finished => return Err(CANCELLED.into()),
            RunSignal::Ready => return Ok(()),
            RunSignal::Paused => {
                signal.changed().await.map_err(|_| CANCELLED)?;
            }
        }
    }
}

async fn wait_cancelled(mut signal: watch::Receiver<RunSignal>) {
    let _ = signal
        .wait_for(|signal| matches!(signal, RunSignal::Cancelled | RunSignal::Finished))
        .await;
}

async fn race_cancellation<F: Future>(
    signal: watch::Receiver<RunSignal>,
    future: F,
) -> Result<F::Output, String> {
    let cancellation = wait_cancelled(signal);
    pin_mut!(cancellation, future);
    match futures_util::future::select(cancellation, future).await {
        Either::Left(_) => Err(CANCELLED.into()),
        Either::Right((output, _)) => Ok(output),
    }
}

#[tauri::command]
pub fn list_download_tasks(state: State<'_, Arc<LauncherState>>) -> DownloadSnapshot {
    state.control.snapshot()
}
#[tauri::command]
pub fn set_download_paused(
    state: State<'_, Arc<LauncherState>>,
    task_id: String,
    paused: bool,
) -> DownloadSnapshot {
    state.control.set_paused(&task_id, paused);
    state.control.snapshot()
}
#[tauri::command]
pub fn cancel_download_task(
    state: State<'_, Arc<LauncherState>>,
    task_id: String,
) -> DownloadSnapshot {
    state.control.cancel(&task_id);
    state.control.snapshot()
}
#[tauri::command]
pub fn reserve_launch_task(
    state: State<'_, Arc<LauncherState>>,
    version_id: String,
    instance_id: Option<String>,
) -> AppResult<String> {
    crate::storage::validate_id(&version_id)?;
    if let Some(id) = instance_id.as_deref() {
        crate::storage::validate_id(id)?;
    }
    Ok(state.control.reserve_launch(&version_id, instance_id)?)
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
        .enqueue("install", &version_id, &format!("Minecraft {version_id}"))?;
    spawn_install(app, state.inner().clone(), id.clone(), version_id);
    Ok(id)
}
fn spawn_install(app: AppHandle, state: Arc<LauncherState>, id: String, version: String) {
    tauri::async_runtime::spawn(async move {
        let Ok(_guard) = state.control.wait_for_turn(&state.operation, &id).await else {
            return;
        };
        if !state.control.activate(&id) {
            return;
        }
        let result = minecraft::install(&state, &app, &version).await;
        state
            .control
            .finish(&id, result.as_ref().err().map(String::as_str));
        if let Err(error) = result {
            minecraft::log(&app, &state, "error", error);
        }
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
    use std::sync::{atomic::AtomicBool, mpsc};

    #[test]
    fn m04_cancellation_cannot_disappear_between_queued_and_running() {
        let control = Arc::new(DownloadControl::default());
        let (running, observed) = mpsc::channel();
        let (released, resume_publish) = mpsc::channel();
        let resume_publish = Mutex::new(resume_publish);
        let first_publication = AtomicBool::new(true);
        control.set_emitter(move |snapshot| {
            if snapshot
                .tasks
                .last()
                .is_some_and(|task| task.status == "running")
                && first_publication.swap(false, Ordering::Relaxed)
            {
                running.send(()).unwrap();
                resume_publish.lock().unwrap().recv().unwrap();
            }
        });
        let task = control.enqueue("install", "fixture", "Fixture").unwrap();
        let preparation = {
            let control = control.clone();
            let task = task.clone();
            std::thread::spawn(move || control.activate(&task))
        };
        observed.recv_timeout(Duration::from_secs(3)).unwrap();
        // Running became observable while activation's publication was still in flight.
        // Cancellation must target that exact task even in this gap.
        control.cancel(&task);
        released.send(()).unwrap();
        assert!(preparation.join().unwrap());
        assert_eq!(
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(control.checkpoint())
                .unwrap_err(),
            CANCELLED
        );
        control.finish(&task, Some(CANCELLED));
        assert_eq!(control.list()[0].status, "cancelled");
    }

    #[test]
    fn m04_late_old_journal_write_cannot_replace_a_terminal_snapshot() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target/m04-probes")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&directory).unwrap();
        let control = Arc::new(DownloadControl::load(directory.clone(), 0).unwrap());
        let task = control.begin("install", "fixture", "Fixture").unwrap();

        // Hold an in-flight progress mutation until a terminal writer attempts to
        // proceed. The terminal mutation cannot overtake the progress journal write.
        let (entered, observe_edit) = mpsc::channel();
        let (release, allow_edit) = mpsc::channel();
        let early = {
            let control = control.clone();
            std::thread::spawn(move || {
                control.mutate(true, |state| {
                    let job = &mut state.jobs[0];
                    job.completed = 1;
                    entered.send(()).unwrap();
                    allow_edit.recv_timeout(Duration::from_secs(3)).unwrap();
                    Some(())
                })
            })
        };
        observe_edit.recv_timeout(Duration::from_secs(3)).unwrap();
        let (attempt, attempted) = mpsc::channel();
        let terminal = {
            let (control, task) = (control.clone(), task.clone());
            std::thread::spawn(move || {
                attempt.send(()).unwrap();
                control.finish(&task, None);
            })
        };
        attempted.recv_timeout(Duration::from_secs(3)).unwrap();
        release.send(()).unwrap();
        assert!(early.join().unwrap().is_some());
        terminal.join().unwrap();

        let bytes = fs::read(directory.join("download-jobs.json")).unwrap();
        let mut disk = serde_json::from_slice::<Vec<DownloadJob>>(&bytes).unwrap();
        let disk = disk.pop().unwrap();
        assert_eq!(disk.id, task);
        assert_eq!(disk.completed, 1);
        assert_eq!(disk.status, "completed");
        assert_eq!(control.list()[0].status, "completed");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn m01_every_terminal_result_publishes_a_new_revision_without_later_progress() {
        let control = DownloadControl::default();
        let (sender, events) = mpsc::channel();
        control.set_emitter(move |snapshot| sender.send(snapshot).unwrap());
        let first = control.enqueue("install", "one", "fixture").unwrap();
        let first_priority = events.recv().unwrap();
        assert_eq!(first_priority.tasks[0].status, "queued");
        assert!(control.activate(&first));
        let running = events.recv().unwrap();
        assert_eq!(running.tasks[0].status, "running");
        assert!(running.revision > first_priority.revision);
        control.finish(&first, None);
        let complete = events.recv().unwrap();
        assert_eq!(complete.tasks[0].status, "completed");
        assert!(complete.revision > running.revision);
        assert_eq!(control.snapshot().revision, complete.revision);

        let another = control.begin("resource", "two", "fixture").unwrap();
        let active = events.recv().unwrap();
        control.finish(&another, Some("fixture failure"));
        let fail = events.recv().unwrap();
        assert_eq!(fail.tasks[1].status, "failed");
        assert!(fail.revision > active.revision);

        let last = control.enqueue("launch", "three", "fixture").unwrap();
        let queued = events.recv().unwrap();
        control.cancel(&last);
        let cancelled = events.recv().unwrap();
        assert_eq!(cancelled.tasks[2].status, "cancelled");
        assert!(cancelled.revision > queued.revision);
        control.finish(&last, None);
        assert!(
            events.try_recv().is_err(),
            "a stale finish cannot replace a terminal state"
        );
    }

    #[test]
    fn finishing_an_old_task_preserves_the_active_tasks_pause_and_cancellation() {
        let control = DownloadControl::default();
        let old = control.begin("install", "old", "Old").unwrap();
        control.finish(&old, None);
        let active = control.begin("launch", "fixture", "Active").unwrap();
        control.set_paused(&active, true);
        control.finish(&old, None);
        control.set_paused(&old, false);
        control.cancel(&old);
        assert_eq!(
            *control.active_signal().unwrap().borrow(),
            RunSignal::Paused
        );
        control.cancel(&active);
        control.finish(&old, None);
        assert_eq!(
            *control.active_signal().unwrap().borrow(),
            RunSignal::Cancelled
        );
        control.finish(&active, Some(CANCELLED));
        assert!(control.active_signal().is_none());
        assert_eq!(control.list()[1].status, "cancelled");
    }

    #[test]
    fn paused_operation_cancels_promptly_and_next_job_can_run() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let control = DownloadControl::default();
            let task = control.begin("install", "test", "Test").unwrap();
            control.set_paused(&task, true);
            let waiter = control.checkpoint();
            tokio::pin!(waiter);
            assert!(tokio::time::timeout(Duration::from_millis(20), &mut waiter)
                .await
                .is_err());
            control.cancel(&task);
            assert_eq!(waiter.await.unwrap_err(), CANCELLED);
            control.finish(&task, Some(CANCELLED));
            let next = control.begin("install", "next", "Next").unwrap();
            assert!(control.checkpoint().await.is_ok());
            control.finish(&next, None);
        });
    }

    #[test]
    fn progress_is_stamped_at_source_and_stale_pause_or_cancel_does_not_touch_the_next_job() {
        let control = DownloadControl::default();
        let first = control.begin("install", "same", "Fixture").unwrap();
        let progress = control
            .record_progress(ProgressEvent {
                task_id: String::new(),
                operation: String::new(),
                version_id: "same".into(),
                stage: "download".into(),
                completed: 1,
                total: 2,
                bytes_completed: 100,
                bytes_total: 200,
                message: "fixture".into(),
            })
            .unwrap();
        control.finish(&first, None);
        let next = control.begin("launch", "same", "Fixture").unwrap();
        control.cancel(&first);
        control.set_paused(&first, true);
        assert_eq!(progress.operation, "install");
        assert_eq!(progress.task_id, first);
        let next_row = control
            .list()
            .into_iter()
            .find(|job| job.id == next)
            .unwrap();
        assert_eq!(next_row.status, "running");
        assert_eq!(next_row.completed, 0);
        assert_eq!(*control.active_signal().unwrap().borrow(), RunSignal::Ready);
    }

    #[test]
    fn passive_preview_preserves_foreground_cancellation_and_reserves_the_same_quota() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let control = DownloadControl::default();
            control.set_limit(1000);
            let pending = control.begin("install", "fixture", "Fixture only").unwrap();
            control.cancel(&pending);
            let before = *control.next_slot.lock().unwrap();
            control.throttle_preview(1024).await.unwrap();
            let preview_slot = *control.next_slot.lock().unwrap();
            assert!(preview_slot >= before + Duration::from_millis(1));
            assert!(control.checkpoint().await.is_err());
            assert_eq!(control.list().len(), 1);
            control.finish(&pending, Some(CANCELLED));
            let next = control.begin("install", "another", "Fixture only").unwrap();
            control.throttle(1024).await.unwrap();
            assert!(*control.next_slot.lock().unwrap() >= preview_slot + Duration::from_millis(1));
            control.finish(&next, None);
        });
    }
}
