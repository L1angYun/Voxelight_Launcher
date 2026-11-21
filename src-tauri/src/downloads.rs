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
pub(crate) const RETRY_UNSUPPORTED: &str = "请回到对应资源、整合包或备份页面重新执行；已校验文件会复用";
pub(crate) const ALREADY_RETRIED: &str = "此任务已经重试过，请在新的任务上操作";
const STILL_ACTIVE: &str = "该任务仍在执行或排队";

/// What a task needs to run again from the Downloads page (U0256). Only the
/// ids and names the user chose: never URLs, paths or secrets, so every retry
/// resolves metadata and passes the host checks again. A request for the
/// latest version records the version the first attempt resolved.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum RetryRequest {
    Install { version_id: String },
    Loader { loader: String, game_version: String, loader_version: String },
    ModrinthModpack { project_id: String, modpack_version_id: String, name: Option<String>, include_optional: bool },
    /// Recorded now; its runner comes with the resource install refactor (C7).
    Resource { request: ResourceRequest },
}

/// The stored form: a version, so a payload from a newer build loads as "not
/// retryable" instead of failing the whole history.
const RETRY_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetryEnvelope {
    v: u32,
    request: RetryRequest,
}

impl RetryRequest {
    fn stored(&self) -> serde_json::Value {
        serde_json::to_value(RetryEnvelope { v: RETRY_VERSION, request: self.clone() }).unwrap_or(serde_json::Value::Null)
    }
}

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
    /// The retry payload as stored ({"v":1,"request":…}), kept as raw JSON so
    /// an unknown shape never makes the history unreadable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<serde_json::Value>,
    /// The task this one retried.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retried_from: Option<String>,
    /// Computed for every snapshot from the payload and the history; a stored
    /// value is never trusted.
    #[serde(default)]
    pub retryable: bool,
}

impl DownloadJob {
    /// The payload, if it is one this build understands.
    pub(crate) fn retry_request(&self) -> Option<RetryRequest> {
        let envelope: RetryEnvelope = serde_json::from_value(self.retry.clone()?).ok()?;
        (envelope.v == RETRY_VERSION).then_some(envelope.request)
    }
}

/// Whether `job` can run again now, and with what. Live tasks, completed
/// ones, ones already retried and kinds without a runner cannot.
fn retry_plan(job: &DownloadJob, jobs: &[DownloadJob]) -> Result<RetryRequest, &'static str> {
    if matches!(job.status.as_str(), "running" | "paused" | "queued") {
        return Err(STILL_ACTIVE);
    }
    if !matches!(job.status.as_str(), "failed" | "interrupted" | "cancelled") {
        return Err(RETRY_UNSUPPORTED);
    }
    if jobs.iter().any(|other| other.retried_from.as_deref() == Some(job.id.as_str())) {
        return Err(ALREADY_RETRIED);
    }
    // Rows from before payloads were recorded: an install is retried by its target.
    let request = match job.retry_request() {
        Some(request) => request,
        None if job.retry.is_none() && job.kind == "install" => RetryRequest::Install { version_id: job.target.clone() },
        None => return Err(RETRY_UNSUPPORTED),
    };
    match request {
        RetryRequest::Install { .. } | RetryRequest::Loader { .. } | RetryRequest::ModrinthModpack { .. } => Ok(request),
        RetryRequest::Resource { .. } => Err(RETRY_UNSUPPORTED),
    }
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

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceRequest {
    pub source: ResourceSource,
    pub project_id: String,
    pub resource_type: String,
    pub target: ResourceTarget,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ResourceSource {
    Modrinth,
    Curseforge,
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum ResourceTarget {
    Existing {
        version_id: String,
        instance_id: Option<String>,
        file_id: Option<u64>,
        #[serde(default)]
        resource_version_id: Option<String>,
    },
    Create {
        game_version: String,
        loader: String,
        loader_version: Option<String>,
        name: String,
        #[serde(default)]
        file_id: Option<u64>,
        #[serde(default)]
        resource_version_id: Option<String>,
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
    /// Milliseconds without data before a transfer fails; 0 is the default.
    stall_ms: AtomicU64,
}

impl Default for DownloadControl {
    fn default() -> Self {
        Self {
            scheduler: Mutex::new(Scheduler::default()),
            emitter: Mutex::new(None),
            limit_kib: AtomicU64::new(0),
            next_slot: Mutex::new(Instant::now()),
            journal: None,
            stall_ms: AtomicU64::new(0),
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
    let mut tasks = state.jobs.clone();
    for task in &mut tasks {
        task.retryable = retry_plan(task, &state.jobs).is_ok();
    }
    DownloadSnapshot { revision: state.revision, tasks }
}

/// A new task row, the same for every way a task is created.
struct NewJob<'a> {
    kind: &'a str,
    target: &'a str,
    label: &'a str,
    display_target: Option<&'a str>,
    reservation: Option<Reservation>,
    start_now: bool,
    retry: Option<RetryRequest>,
    retried_from: Option<String>,
}

fn insert_job(state: &mut Scheduler, id: &str, job: NewJob<'_>) -> Option<()> {
    if job.start_now && state.active.is_some() {
        return None;
    }
    if job.start_now {
        state.active = Some(id.to_owned());
    }
    let time = chrono::Utc::now().to_rfc3339();
    state.jobs.push(DownloadJob {
        id: id.to_owned(),
        kind: job.kind.into(),
        target: job.target.into(),
        label: job.label.into(),
        display_target: job.display_target.map(str::to_owned),
        status: if job.start_now { "running" } else { "queued" }.into(),
        stage: "queued".into(),
        completed: 0,
        total: 0,
        bytes_completed: 0,
        bytes_total: 0,
        message: if job.start_now { "正在准备" } else { "等待执行" }.into(),
        error: None,
        created_at: time.clone(),
        updated_at: time,
        retry: job.retry.as_ref().map(RetryRequest::stored),
        retried_from: job.retried_from,
        retryable: false,
    });
    state.live.insert(
        id.to_owned(),
        PendingTask {
            signal: watch::channel(RunSignal::Ready).0,
            reservation: job.reservation,
            claimed: false,
            starting_game: false,
        },
    );
    if state.jobs.len() > 200 {
        if let Some(index) = state.jobs.iter().position(|job| !state.live.contains_key(&job.id)) {
            state.jobs.remove(index);
        }
    }
    Some(())
}

/// How a retried task is queued: its kind, target and labels.
fn retry_job(request: &RetryRequest) -> (&'static str, String, String, Option<String>) {
    match request {
        RetryRequest::Install { version_id } => ("install", version_id.clone(), format!("Minecraft {version_id}"), None),
        RetryRequest::Loader { loader, game_version, .. } => ("loader", game_version.clone(), format!("安装 {loader}"), None),
        RetryRequest::ModrinthModpack { project_id, name, .. } => (
            "modpack",
            project_id.clone(),
            "安装 Modrinth 整合包".into(),
            name.as_deref().map(str::trim).filter(|name| !name.is_empty()).map(str::to_owned),
        ),
        RetryRequest::Resource { request } => ("resource", request.project_id.clone(), "安装资源".into(), None),
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
        self.create(NewJob { kind, target, label, display_target, reservation, start_now, retry: None, retried_from: None })
    }

    fn create(&self, job: NewJob<'_>) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.mutate(true, |state| insert_job(state, &id, job)).ok_or("已有下载或启动准备任务运行")?;
        Ok(id)
    }

    pub fn enqueue(&self, kind: &str, target: &str, label: &str) -> Result<String, String> {
        self.create_job(kind, target, label, None, None, false)
    }

    /// A queued task that records how to run it again.
    pub(crate) fn enqueue_recorded(&self, kind: &str, target: &str, label: &str, request: RetryRequest) -> Result<String, String> {
        self.create(NewJob { kind, target, label, display_target: None, reservation: None, start_now: false, retry: Some(request), retried_from: None })
    }

    /// A task that starts now and records how to run it again.
    pub(crate) fn begin_recorded(
        &self,
        kind: &str,
        target: &str,
        label: &str,
        display_target: Option<&str>,
        request: RetryRequest,
    ) -> Result<String, String> {
        self.create(NewJob { kind, target, label, display_target, reservation: None, start_now: true, retry: Some(request), retried_from: None })
    }

    /// Replaces (or clears) the payload, e.g. once "latest" is resolved, or when
    /// a failure kept files that a second run would duplicate.
    pub(crate) fn set_retry(&self, id: &str, request: Option<RetryRequest>) {
        self.mutate(true, |state| {
            let job = state.jobs.iter_mut().find(|job| job.id == id)?;
            job.retry = request.as_ref().map(RetryRequest::stored);
            Some(())
        });
    }

    /// Checks that `id` can run again and queues the new task, in one step, so
    /// two clicks cannot both retry it. The old row stays as it was.
    pub(crate) fn queue_retry(&self, id: &str) -> Result<(String, RetryRequest), String> {
        let new_id = uuid::Uuid::new_v4().to_string();
        let mut refusal: Option<&'static str> = None;
        let request = self.mutate(true, |state| {
            let job = state.jobs.iter().find(|job| job.id == id);
            let plan = match job {
                Some(job) => retry_plan(job, &state.jobs),
                None => Err("任务不存在"),
            };
            let request = match plan {
                Ok(request) => request,
                Err(reason) => {
                    refusal = Some(reason);
                    return None;
                }
            };
            let (kind, target, label, display) = retry_job(&request);
            insert_job(state, &new_id, NewJob {
                kind,
                target: &target,
                label: &label,
                display_target: display.as_deref(),
                reservation: None,
                start_now: false,
                retry: Some(request.clone()),
                retried_from: Some(id.to_owned()),
            })?;
            Some(request)
        });
        match (request, refusal) {
            (Some(request), _) => Ok((new_id, request)),
            (None, Some(reason)) => Err(reason.into()),
            (None, None) => Err("下载任务状态异常".into()),
        }
    }

    /// Runs a queued task when its turn comes: behind the operation lock,
    /// with cancel honoured while it waits, and its result recorded.
    pub(crate) async fn run_queued<T, F, Fut>(&self, operation: &tokio::sync::Mutex<()>, id: &str, run: F) -> Option<Result<T, String>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, String>>,
    {
        let Ok(_guard) = self.wait_for_turn(operation, id).await else {
            return None;
        };
        if !self.activate(id) {
            return None;
        }
        let result = run().await;
        self.finish(id, result.as_ref().err().map(String::as_str));
        Some(result)
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
            (_, ResourceTarget::Create { .. }) => "创建实例并安装资源",
            (ResourceSource::Modrinth, _) => "安装 Modrinth 资源及必需前置",
            (ResourceSource::Curseforge, _) => "安装 CurseForge 资源",
        };
        let project_id = request.project_id.clone();
        let retry = RetryRequest::Resource { request: request.clone() };
        self.create(NewJob {
            kind: "resource",
            target: &project_id,
            label,
            display_target: None,
            reservation: Some(Reservation::Resource(request)),
            start_now: false,
            retry: Some(retry),
            retried_from: None,
        })
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

    /// No task is running or waiting (a lock failure counts as busy).
    pub(crate) fn is_idle(&self) -> bool {
        self.scheduler
            .lock()
            .map(|state| state.live.is_empty() && state.active.is_none())
            .unwrap_or(false)
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

    /// How long a transfer may go without data (crate::parts::STALL).
    pub(crate) fn stall_limit(&self) -> Duration {
        match self.stall_ms.load(Ordering::Relaxed) {
            0 => crate::parts::STALL,
            ms => Duration::from_millis(ms),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_stall_limit(&self, limit: Duration) {
        self.stall_ms.store(limit.as_millis().max(1) as u64, Ordering::Relaxed);
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
    let id = state.control.enqueue_recorded(
        "install",
        &version_id,
        &format!("Minecraft {version_id}"),
        RetryRequest::Install { version_id: version_id.clone() },
    )?;
    spawn_install(app, state.inner().clone(), id.clone(), version_id);
    Ok(id)
}
fn spawn_install(app: AppHandle, state: Arc<LauncherState>, id: String, version: String) {
    tauri::async_runtime::spawn(async move {
        let result = state.control.run_queued(&state.operation, &id, || minecraft::install(&state, &app, &version)).await;
        if let Some(Err(error)) = result {
            minecraft::log(&app, &state, "error", error);
        }
    });
}

/// Starts the runner for a retried task; the task is already queued.
fn spawn_retry(app: AppHandle, state: Arc<LauncherState>, id: String, request: RetryRequest) {
    match request {
        RetryRequest::Install { version_id } => spawn_install(app, state, id, version_id),
        RetryRequest::Loader { loader, game_version, loader_version } => {
            tauri::async_runtime::spawn(crate::loaders::run_queued_loader(app, state, id, loader, game_version, loader_version));
        }
        RetryRequest::ModrinthModpack { project_id, modpack_version_id, name, include_optional } => {
            tauri::async_runtime::spawn(crate::modpacks::run_queued_modpack(
                app,
                state,
                id,
                project_id,
                modpack_version_id,
                name,
                include_optional,
            ));
        }
        // retry_plan never offers these yet.
        RetryRequest::Resource { .. } => state.control.finish(&id, Some(RETRY_UNSUPPORTED)),
    }
}
#[tauri::command]
pub async fn retry_download_task(
    app: AppHandle,
    state: State<'_, Arc<LauncherState>>,
    task_id: String,
) -> AppResult<String> {
    // Queued behind the operation lock like any other queued task; a request
    // for "latest" reuses the version the first attempt resolved.
    let (id, request) = state.control.queue_retry(&task_id).map_err(expected)?;
    spawn_retry(app, state.inner().clone(), id.clone(), request);
    Ok(id)
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

    struct Journal(PathBuf);

    impl Journal {
        fn new(rows: serde_json::Value) -> Self {
            let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/u0256-probes").join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(&directory).unwrap();
            if !rows.is_null() {
                fs::write(directory.join("download-jobs.json"), serde_json::to_vec(&rows).unwrap()).unwrap();
            }
            Self(directory)
        }
        fn load(&self) -> DownloadControl {
            DownloadControl::load(self.0.clone(), 0).unwrap()
        }
        fn corrupt_copies(&self) -> usize {
            fs::read_dir(&self.0).unwrap().flatten().filter(|entry| entry.file_name().to_string_lossy().starts_with("download-jobs-corrupt-")).count()
        }
    }

    impl Drop for Journal {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn row(id: &str, kind: &str, target: &str, status: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "kind": kind, "target": target, "label": "Fixture", "status": status, "stage": status,
            "completed": 0, "total": 0, "bytesCompleted": 0, "bytesTotal": 0, "message": "", "error": null,
            "createdAt": "2026-11-20T00:00:00Z", "updatedAt": "2026-11-20T00:00:00Z"
        })
    }

    fn job(control: &DownloadControl, id: &str) -> DownloadJob {
        control.list().into_iter().find(|job| job.id == id).unwrap()
    }

    fn code(error: String) -> String {
        crate::errors::expected(error).code
    }

    #[test]
    fn u0256_an_old_journal_loads_and_only_legacy_installs_are_retryable() {
        let journal = Journal::new(serde_json::json!([
            row("old-install", "install", "1.20.1", "failed"),
            row("old-resource", "resource", "AANobbMI", "failed"),
            row("old-loader", "loader", "1.20.1", "failed"),
            row("old-running", "install", "1.21", "running"),
        ]));
        let control = journal.load();
        assert_eq!(journal.corrupt_copies(), 0, "the history is kept");
        assert!(job(&control, "old-install").retryable, "an old install row retries by its target");
        assert!(!job(&control, "old-resource").retryable, "no payload, no runner");
        assert!(!job(&control, "old-loader").retryable, "an old loader row never recorded its loader");
        let interrupted = job(&control, "old-running");
        assert_eq!(interrupted.status, "interrupted");
        assert!(interrupted.retryable);
    }

    #[test]
    fn u0256_an_unknown_payload_loads_as_not_retryable_without_losing_history() {
        let mut future = row("future", "loader", "1.20.1", "failed");
        future["retry"] = serde_json::json!({"v": 99, "request": {"kind": "teleport"}});
        let mut odd = row("odd", "install", "1.20.1", "failed");
        odd["retry"] = serde_json::json!({"v": 1, "request": {"kind": "install", "versionId": "1.20.1", "extra": true}});
        // Readable fields under a newer version may mean something else there.
        let mut newer = row("newer", "install", "1.20.1", "failed");
        newer["retry"] = serde_json::json!({"v": 2, "request": {"kind": "install", "versionId": "1.20.1"}});
        let journal = Journal::new(serde_json::json!([future, odd, newer, row("kept", "install", "1.19", "completed")]));
        let control = journal.load();
        assert_eq!(journal.corrupt_copies(), 0);
        assert_eq!(control.list().len(), 4);
        assert!(!job(&control, "future").retryable);
        assert!(!job(&control, "newer").retryable, "a newer payload version is not read as this one");
        assert!(!job(&control, "odd").retryable, "a payload this build cannot read is never guessed at");
        assert!(!job(&control, "kept").retryable, "completed tasks are not retried");
        assert_eq!(code(control.queue_retry("future").unwrap_err()), "download.retryUnsupported");
    }

    #[test]
    fn u0256_payloads_survive_a_restart_and_an_interrupted_task_retries_with_them() {
        let journal = Journal::new(serde_json::Value::Null);
        let request = RetryRequest::Loader { loader: "fabric".into(), game_version: "1.20.1".into(), loader_version: "0.15.11".into() };
        let task = {
            let control = journal.load();
            control.enqueue_recorded("loader", "1.20.1", "安装 fabric", request.clone()).unwrap()
        };
        let control = journal.load();
        let row = job(&control, &task);
        assert_eq!(row.status, "interrupted");
        assert_eq!(row.retry_request(), Some(request.clone()));
        assert!(row.retryable);
        let on_disk = fs::read_to_string(journal.0.join("download-jobs.json")).unwrap();
        assert!(on_disk.contains("\"v\": 1") && on_disk.contains("\"loaderVersion\": \"0.15.11\""), "{on_disk}");
        let (retried, planned) = control.queue_retry(&task).unwrap();
        assert_eq!(planned, request);
        let new_row = job(&control, &retried);
        assert_eq!((new_row.kind.as_str(), new_row.status.as_str(), new_row.retried_from.as_deref()), ("loader", "queued", Some(task.as_str())));
        assert_eq!(new_row.retry_request(), Some(request));
        let old = job(&control, &task);
        assert_eq!((old.status.as_str(), old.retryable), ("interrupted", false), "the old row stays, and is not retried twice");
        assert_eq!(code(control.queue_retry(&task).unwrap_err()), "download.alreadyRetried");
        control.cancel(&retried);
    }

    #[test]
    fn u0256_retry_refuses_live_missing_and_unsupported_tasks() {
        let journal = Journal::new(serde_json::Value::Null);
        let control = journal.load();
        let running = control.begin_recorded("install", "1.20.1", "Minecraft 1.20.1", None, RetryRequest::Install { version_id: "1.20.1".into() }).unwrap();
        assert_eq!(code(control.queue_retry(&running).unwrap_err()), "download.active");
        assert!(!job(&control, &running).retryable);
        control.set_paused(&running, true);
        assert_eq!(code(control.queue_retry(&running).unwrap_err()), "download.active");
        control.finish(&running, None);
        assert_eq!(code(control.queue_retry(&running).unwrap_err()), "download.retryUnsupported", "a completed task is not retried");
        assert_eq!(code(control.queue_retry("missing").unwrap_err()), "download.notFound");
        // Kinds without a runner: no payload, or a resource payload before its runner exists.
        for kind in ["export", "backup", "restore", "clone", "world-import", "server-start", "launch", "modpack"] {
            let task = control.begin(kind, "fixture", "Fixture").unwrap();
            control.finish(&task, Some("failed"));
            assert!(!job(&control, &task).retryable, "{kind}");
            assert_eq!(code(control.queue_retry(&task).unwrap_err()), "download.retryUnsupported", "{kind}");
        }
        let resource = control.reserve_resource(ResourceRequest {
            source: ResourceSource::Modrinth,
            project_id: "AANobbMI".into(),
            resource_type: "mod".into(),
            target: ResourceTarget::Existing { version_id: "1.20.1".into(), instance_id: None, file_id: None, resource_version_id: Some("abc".into()) },
        }).unwrap();
        control.finish(&resource, Some("failed"));
        let row = job(&control, &resource);
        assert!(matches!(row.retry_request(), Some(RetryRequest::Resource { .. })), "recorded now for the later runner");
        assert!(!row.retryable);
    }

    #[test]
    fn u0256_a_resolved_version_replaces_latest_and_a_kept_failure_clears_the_payload() {
        let journal = Journal::new(serde_json::Value::Null);
        let control = journal.load();
        let latest = RetryRequest::Loader { loader: "fabric".into(), game_version: "1.20.1".into(), loader_version: "latest".into() };
        let task = control.begin_recorded("loader", "1.20.1", "安装 fabric", None, latest).unwrap();
        let resolved = RetryRequest::Loader { loader: "fabric".into(), game_version: "1.20.1".into(), loader_version: "0.15.11".into() };
        control.set_retry(&task, Some(resolved.clone()));
        control.finish(&task, Some("network"));
        let (_, planned) = control.queue_retry(&task).unwrap();
        assert_eq!(planned, resolved, "the retry repeats exactly what the first attempt chose");
        let pack = control.begin_recorded("modpack", "pack", "安装 Modrinth 整合包", Some("My pack"), RetryRequest::ModrinthModpack {
            project_id: "pack".into(), modpack_version_id: "v1".into(), name: Some("My pack".into()), include_optional: false,
        }).unwrap();
        control.set_retry(&pack, None);
        control.finish(&pack, Some("kept"));
        assert!(!job(&control, &pack).retryable);
    }

    #[test]
    fn u0256_a_queued_retry_waits_for_the_operation_lock_and_honours_cancel() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let journal = Journal::new(serde_json::Value::Null);
            let control = journal.load();
            let operation = tokio::sync::Mutex::new(());
            let request = RetryRequest::Install { version_id: "1.20.1".into() };
            let first = control.enqueue_recorded("install", "1.20.1", "Minecraft 1.20.1", request).unwrap();
            control.cancel(&first);
            let (retried, _) = control.queue_retry(&first).unwrap();

            // Behind the lock: the runner does not start until the lock is free.
            let held = operation.lock().await;
            let ran = std::sync::atomic::AtomicBool::new(false);
            let inside = std::sync::Mutex::new(None);
            let run = control.run_queued(&operation, &retried, || async {
                ran.store(true, std::sync::atomic::Ordering::SeqCst);
                // While it runs, the lock is held and the task shows as running.
                *inside.lock().unwrap() = Some((operation.try_lock().is_err(), job(&control, &retried).status));
                Err::<(), String>("synthetic failure".into())
            });
            tokio::pin!(run);
            assert!(tokio::time::timeout(Duration::from_millis(100), &mut run).await.is_err());
            assert!(!ran.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(job(&control, &retried).status, "queued");
            drop(held);
            assert_eq!(run.await, Some(Err("synthetic failure".into())));
            assert!(ran.load(std::sync::atomic::Ordering::SeqCst));
            assert_eq!(inside.lock().unwrap().take(), Some((true, "running".to_owned())));
            assert!(operation.try_lock().is_ok(), "the lock is released afterwards");
            let row = job(&control, &retried);
            assert_eq!((row.status.as_str(), row.retryable), ("failed", true));

            // Cancelled while waiting: the runner never starts.
            let (again, _) = control.queue_retry(&retried).unwrap();
            let held = operation.lock().await;
            let never = control.run_queued(&operation, &again, || async {
                if true {
                    panic!("a cancelled task never runs");
                }
                Ok::<(), String>(())
            });
            tokio::pin!(never);
            assert!(tokio::time::timeout(Duration::from_millis(50), &mut never).await.is_err());
            control.cancel(&again);
            assert_eq!(never.await, None);
            drop(held);
            assert_eq!(job(&control, &again).status, "cancelled");
        });
    }

    #[test]
    fn u0256_two_retries_of_one_task_queue_only_one() {
        let journal = Journal::new(serde_json::Value::Null);
        let control = Arc::new(journal.load());
        let task = control.enqueue_recorded("install", "1.20.1", "Minecraft 1.20.1", RetryRequest::Install { version_id: "1.20.1".into() }).unwrap();
        control.cancel(&task);
        let start = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8).map(|_| {
            let control = control.clone();
            let task = task.clone();
            let start = start.clone();
            std::thread::spawn(move || {
                start.wait();
                control.queue_retry(&task).is_ok()
            })
        }).collect();
        let queued = threads.into_iter().map(|thread| thread.join().unwrap()).filter(|ok| *ok).count();
        assert_eq!(queued, 1);
        assert_eq!(control.list().iter().filter(|job| job.retried_from.as_deref() == Some(task.as_str())).count(), 1);
    }

    #[test]
    fn u0256_a_retry_hands_each_payload_value_to_the_parameter_of_its_name() {
        fn list(source: &str, opening: &str) -> Vec<String> {
            let (_, rest) = source.split_once(opening).unwrap();
            let (items, _) = rest.split_once(')').unwrap();
            items.split(',').map(|item| item.split(':').next().unwrap().trim().to_owned()).filter(|item| !item.is_empty()).collect()
        }
        let downloads = include_str!("downloads.rs");
        let (_, spawn) = downloads.split_once("fn spawn_retry(").unwrap();
        let (spawn, _) = spawn.split_once("\n}").unwrap();
        for (call, source, signature) in [
            ("crate::loaders::run_queued_loader(", include_str!("loaders.rs"), "pub(crate) async fn run_queued_loader("),
            ("crate::modpacks::run_queued_modpack(", include_str!("modpacks.rs"), "pub(crate) async fn run_queued_modpack("),
        ] {
            let (arguments, parameters) = (list(spawn, call), list(source, signature));
            assert_eq!(arguments[..3], ["app", "state", "id"], "{call}");
            assert_eq!(parameters[..3], ["app", "state", "task"], "{signature}");
            assert_eq!(arguments[3..], parameters[3..], "{call}");
        }
    }

    #[test]
    fn u0256_payloads_hold_only_ids_and_names() {
        let requests = [
            RetryRequest::Install { version_id: "1.20.1".into() },
            RetryRequest::Loader { loader: "forge".into(), game_version: "1.20.1".into(), loader_version: "47.2.0".into() },
            RetryRequest::ModrinthModpack { project_id: "1KVo5zza".into(), modpack_version_id: "abc".into(), name: Some("Pack".into()), include_optional: true },
        ];
        for request in requests {
            let stored = request.stored().to_string();
            for forbidden in ["http", "\\\\", ":/", "key", "token", "password", "path"] {
                assert!(!stored.to_ascii_lowercase().contains(forbidden), "{stored}");
            }
            let round: RetryEnvelope = serde_json::from_str(&stored).unwrap();
            assert_eq!(round.request, request);
        }
    }
}
