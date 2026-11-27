use futures_util::{future::Either, pin_mut};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::{
    io,
    process::ExitStatus,
    time::{Duration, Instant},
};
use tokio::{
    process::Child,
    sync::{mpsc, oneshot, watch, Mutex},
};

const STOP_ERROR: &str = "无法确认或结束游戏进程";
const CLOSE_GRACE: Duration = Duration::from_secs(8);
/// An exit this soon after a delivered close request was asked for (slow world saves
/// included). A game that keeps running past it and exits later ended on its own.
const REQUESTED_STOP_WINDOW: Duration = Duration::from_secs(120);

/// How an owned game process ended.
pub(crate) struct GameExit {
    pub status: ExitStatus,
    /// True when the launcher killed the game, or it exited within the window after a close
    /// request the launcher delivered, so a non-zero code is not reported as a crash.
    pub requested_stop: bool,
}

impl GameExit {
    pub fn code(&self) -> Option<i32> {
        self.status.code()
    }

    pub fn success(&self) -> bool {
        self.status.success()
    }

    /// The launcher://game-exit payload.
    pub fn event_payload(&self, game_id: &str, pid: u32) -> serde_json::Value {
        serde_json::json!({
            "gameId": game_id,
            "pid": pid,
            "code": self.code(),
            "requestedStop": self.requested_stop,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum StopStatus {
    Stopped,
    ForceRequired,
    Declined,
}

#[derive(Serialize)]
pub(crate) struct StopResult {
    pub status: StopStatus,
}

type StopReply = Result<StopStatus, String>;

pub(crate) struct StopHandle {
    requests: mpsc::Sender<(bool, oneshot::Sender<StopReply>)>,
    pub authorization: Mutex<()>,
    pub force_required: Arc<AtomicBool>,
    completion: watch::Receiver<Option<bool>>,
}

impl StopHandle {
    pub async fn request(&self, force: bool) -> StopReply {
        let (reply, receive) = oneshot::channel();
        if self.requests.send((force, reply)).await.is_err() {
            // The actor already exited; this handle can never be retargeted.
            return self.completed();
        }
        match receive.await {
            Ok(result) => result,
            Err(_) => self.completed(),
        }
    }

    pub fn completion_status(&self) -> Option<StopReply> {
        self.completion.borrow().map(|success| {
            if success {
                Ok(StopStatus::Stopped)
            } else {
                Err(STOP_ERROR.into())
            }
        })
    }

    fn completed(&self) -> StopReply {
        self.completion_status()
            .unwrap_or_else(|| Err(STOP_ERROR.into()))
    }
}

pub(crate) struct GameProcess {
    child: Child,
    requests: mpsc::Receiver<(bool, oneshot::Sender<StopReply>)>,
    force_required: Arc<AtomicBool>,
    completion: watch::Sender<Option<bool>>,
}

impl GameProcess {
    pub fn new(child: Child) -> (Self, StopHandle) {
        let (sender, receiver) = mpsc::channel(1);
        let (completion, observe_completion) = watch::channel(None);
        let force_required = Arc::new(AtomicBool::new(false));
        (
            Self {
                child,
                requests: receiver,
                force_required: force_required.clone(),
                completion,
            },
            StopHandle {
                requests: sender,
                authorization: Mutex::new(()),
                force_required,
                completion: observe_completion,
            },
        )
    }

    pub async fn wait(self) -> io::Result<GameExit> {
        self.wait_with(request_window_close, CLOSE_GRACE, REQUESTED_STOP_WINDOW)
            .await
    }

    async fn wait_with(
        mut self,
        request_close: impl Fn(&Child) -> bool,
        grace: Duration,
        stop_window: Duration,
    ) -> io::Result<GameExit> {
        let result = self.run(request_close, grace, stop_window).await;
        self.completion.send_replace(Some(result.is_ok()));
        result
    }

    async fn run(
        &mut self,
        request_close: impl Fn(&Child) -> bool,
        grace: Duration,
        stop_window: Duration,
    ) -> io::Result<GameExit> {
        // When the last close request reached the game's window.
        let mut close_requested: Option<Instant> = None;
        let exit = |status: ExitStatus, close_requested: Option<Instant>| GameExit {
            status,
            requested_stop: close_requested.is_some_and(|at| at.elapsed() <= stop_window),
        };
        loop {
            let request = {
                let exited = self.child.wait();
                let request = self.requests.recv();
                pin_mut!(exited, request);
                match futures_util::future::select(exited, request).await {
                    Either::Left((status, _)) => {
                        return status.map(|status| exit(status, close_requested))
                    }
                    Either::Right((request, _)) => request,
                }
            };
            let Some((force, reply)) = request else {
                // Losing the webview/registry must not terminate someone's running game.
                return self
                    .child
                    .wait()
                    .await
                    .map(|status| exit(status, close_requested));
            };
            if force {
                if !self.force_required.load(Ordering::Acquire) {
                    let _ = reply.send(Ok(StopStatus::ForceRequired));
                    continue;
                }
                if let Err(error) = self.child.start_kill() {
                    if let Some(status) = self.child.try_wait()? {
                        let _ = reply.send(Ok(StopStatus::Stopped));
                        return Ok(exit(status, close_requested));
                    }
                    let _ = reply.send(Err(STOP_ERROR.into()));
                    eprintln!("[voxelight/game] owned stop failed: {error}");
                    continue;
                }
                // Keep the handle in this actor until the exact process has been reaped.
                let status = self.child.wait().await;
                let _ = reply.send(
                    status
                        .as_ref()
                        .map(|_| StopStatus::Stopped)
                        .map_err(io::Error::to_string),
                );
                return status.map(|status| GameExit {
                    status,
                    requested_stop: true,
                });
            }
            if let Some(status) = self.child.try_wait()? {
                let _ = reply.send(Ok(StopStatus::Stopped));
                return Ok(exit(status, close_requested));
            }
            if request_close(&self.child) {
                close_requested = Some(Instant::now());
                if let Ok(status) = tokio::time::timeout(grace, self.child.wait()).await {
                    let _ = reply.send(
                        status
                            .as_ref()
                            .map(|_| StopStatus::Stopped)
                            .map_err(io::Error::to_string),
                    );
                    return status.map(|status| GameExit {
                        status,
                        requested_stop: true,
                    });
                }
            }
            self.force_required.store(true, Ordering::Release);
            let _ = reply.send(Ok(StopStatus::ForceRequired));
        }
    }
}

#[cfg(windows)]
fn request_window_close(child: &Child) -> bool {
    use windows::core::BOOL;
    use windows::Win32::{
        Foundation::{
            CloseHandle, CompareObjectHandles, HANDLE, HWND, LPARAM, WAIT_TIMEOUT, WPARAM,
        },
        System::Threading::{
            GetProcessId, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
        },
    };

    let Some(raw) = child.raw_handle() else {
        return false;
    };
    let source = HANDLE(raw);
    let pid = unsafe { GetProcessId(source) };
    if pid == 0 {
        return false;
    }

    struct Visit {
        source: HANDLE,
        pid: u32,
        posted: bool,
    }

    // EnumWindows is synchronous: Visit belongs to request_window_close for
    // the full callback lifetime. The associated Child owns the source handle.
    unsafe extern "system" fn request(hwnd: HWND, context: LPARAM) -> BOOL {
        let visit = unsafe { &mut *(context.0 as *mut Visit) };
        if !unsafe { IsWindowVisible(hwnd).as_bool() } {
            return BOOL(1);
        }
        let mut pid = 0;
        let thread = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if thread == 0 || pid != visit.pid {
            return BOOL(1);
        }
        // Access by PID here only checks the window's owner against the actual
        // child handle; a numeric PID is never used for process termination.
        let Ok(owner) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        else {
            return BOOL(1);
        };
        let matches = unsafe { CompareObjectHandles(visit.source, owner).as_bool() };
        let _ = unsafe { CloseHandle(owner) };
        let mut checked = 0;
        if matches
            && unsafe { WaitForSingleObject(visit.source, 0) } == WAIT_TIMEOUT
            && unsafe { GetWindowThreadProcessId(hwnd, Some(&mut checked)) } == thread
            && checked == visit.pid
            && unsafe { PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok() }
        {
            visit.posted = true;
        }
        BOOL(1)
    }

    let mut visit = Visit {
        source,
        pid,
        posted: false,
    };
    let _ = unsafe { EnumWindows(Some(request), LPARAM((&mut visit as *mut Visit) as isize)) };
    visit.posted
}

#[cfg(not(windows))]
fn request_window_close(_: &Child) -> bool {
    // A stdio pipe is not a Minecraft client quit protocol. Let the player exit
    // in-game, or explicitly confirm force against the handle owned here.
    false
}

#[cfg(test)]
mod stop_request_tests {
    use super::*;
    use std::{fs, path::Path, process::Stdio};

    const SLEEP_FIXTURE_DIR: &str = "VOXELIGHT_STOP_FLAG_TEST_DIR";

    #[test]
    fn stop_flag_child_fixture() {
        let Some(directory) = std::env::var_os(SLEEP_FIXTURE_DIR) else {
            return;
        };
        let directory = std::path::PathBuf::from(directory);
        fs::write(directory.join("ready"), b"stop flag fixture").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        while !directory.join("exit").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    async fn spawn_fixture() -> (std::path::PathBuf, Child) {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/process-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&directory).unwrap();
        let child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "game_process::stop_request_tests::stop_flag_child_fixture"])
            .env(SLEEP_FIXTURE_DIR, &directory)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !directory.join("ready").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        (directory, child)
    }

    const GRACE: Duration = Duration::from_millis(20);
    const WINDOW: Duration = Duration::from_secs(60);

    #[test]
    fn a_confirmed_force_stop_reports_a_requested_stop() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (directory, child) = spawn_fixture().await;
            let (actor, owner) = GameProcess::new(child);
            let wait = tokio::spawn(actor.wait_with(|_| false, GRACE, WINDOW));
            assert_eq!(owner.request(false).await.unwrap(), StopStatus::ForceRequired);
            assert_eq!(owner.request(true).await.unwrap(), StopStatus::Stopped);
            let exit = wait.await.unwrap().unwrap();
            assert!(!exit.success());
            assert!(exit.requested_stop);
            let payload = exit.event_payload("g-1", 42);
            assert_eq!(payload["gameId"], "g-1");
            assert_eq!(payload["pid"], 42);
            assert_eq!(payload["code"], serde_json::json!(exit.code()));
            assert_eq!(payload["requestedStop"], true);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn an_exit_soon_after_a_delivered_close_request_is_requested() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (directory, child) = spawn_fixture().await;
            let (actor, owner) = GameProcess::new(child);
            let wait = tokio::spawn(actor.wait_with(|_| true, GRACE, WINDOW));
            assert_eq!(owner.request(false).await.unwrap(), StopStatus::ForceRequired);
            fs::write(directory.join("exit"), b"exit").unwrap();
            let exit = wait.await.unwrap().unwrap();
            assert!(exit.success());
            assert!(exit.requested_stop);
            assert_eq!(exit.event_payload("g-2", 7)["requestedStop"], true);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn a_game_that_outlives_its_close_request_window_exits_on_its_own() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (directory, child) = spawn_fixture().await;
            let (actor, owner) = GameProcess::new(child);
            let wait = tokio::spawn(actor.wait_with(|_| true, GRACE, Duration::from_millis(100)));
            // The close request reached the game, it kept running and the user declined force.
            assert_eq!(owner.request(false).await.unwrap(), StopStatus::ForceRequired);
            tokio::time::sleep(Duration::from_millis(400)).await;
            fs::write(directory.join("exit"), b"exit").unwrap();
            let exit = wait.await.unwrap().unwrap();
            assert!(!exit.requested_stop);
            assert_eq!(exit.event_payload("g-3", 8)["requestedStop"], false);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn an_exit_after_an_undelivered_close_request_is_not_requested() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (directory, child) = spawn_fixture().await;
            let (actor, owner) = GameProcess::new(child);
            let wait = tokio::spawn(actor.wait_with(|_| false, GRACE, WINDOW));
            assert_eq!(owner.request(false).await.unwrap(), StopStatus::ForceRequired);
            fs::write(directory.join("exit"), b"exit").unwrap();
            assert!(!wait.await.unwrap().unwrap().requested_stop);
            fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn an_exit_without_a_stop_request_is_not_requested() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (directory, child) = spawn_fixture().await;
            let (actor, _owner) = GameProcess::new(child);
            let wait = tokio::spawn(actor.wait_with(|_| true, GRACE, WINDOW));
            fs::write(directory.join("exit"), b"exit").unwrap();
            let exit = wait.await.unwrap().unwrap();
            assert!(exit.success());
            assert!(!exit.requested_stop);
            assert_eq!(exit.event_payload("g-4", 9)["requestedStop"], false);
            fs::remove_dir_all(directory).unwrap();
        });
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Stdio};

    const GUI_FIXTURE_DIR: &str = "VOXELIGHT_M09_GUI_TEST_DIR";

    #[test]
    fn close_window_child_fixture() {
        let Some(directory) = std::env::var_os(GUI_FIXTURE_DIR) else {
            return;
        };
        use windows::{
            core::w,
            Win32::{
                Foundation::{HWND, LPARAM, LRESULT, WPARAM},
                UI::WindowsAndMessaging::{
                    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
                    PostQuitMessage, RegisterClassW, TranslateMessage, HCURSOR, MSG, PM_REMOVE,
                    WM_CLOSE, WM_DESTROY, WM_QUIT, WNDCLASSW, WS_EX_TOOLWINDOW,
                    WS_OVERLAPPEDWINDOW, WS_VISIBLE,
                },
            },
        };

        unsafe extern "system" fn window(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
            match msg {
                WM_CLOSE => {
                    if let Some(directory) = std::env::var_os(GUI_FIXTURE_DIR) {
                        let _ = fs::write(Path::new(&directory).join("close"), b"WM_CLOSE");
                    }
                    let _ = unsafe { DestroyWindow(hwnd) };
                    LRESULT(0)
                }
                WM_DESTROY => {
                    unsafe { PostQuitMessage(0) };
                    LRESULT(0)
                }
                _ => unsafe { DefWindowProcW(hwnd, msg, w, l) },
            }
        }

        let class = w!("VoxelightOwnedStopFixture");
        let registration = WNDCLASSW {
            lpfnWndProc: Some(window),
            hCursor: HCURSOR::default(),
            lpszClassName: class,
            ..Default::default()
        };
        assert_ne!(unsafe { RegisterClassW(&registration) }, 0);
        let _window = unsafe {
            CreateWindowExW(
                WS_EX_TOOLWINDOW,
                class,
                w!("Voxelight test fixture"),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                -30_000,
                -30_000,
                128,
                128,
                None,
                None,
                None,
                None,
            )
        }
        .unwrap();
        fs::write(Path::new(&directory).join("ready"), b"owned GUI fixture").unwrap();
        let timeout = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < timeout {
            let mut message = MSG::default();
            while unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() } {
                if message.message == WM_QUIT {
                    return;
                }
                let _ = unsafe { TranslateMessage(&message) };
                unsafe { DispatchMessageW(&message) };
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("fixture did not receive its close request");
    }

    #[test]
    fn m09_close_requests_are_delivered_to_an_owned_gui_and_allow_normal_exit() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("target/process-tests")
                .join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(&directory).unwrap();
            let child = tokio::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "game_process::tests::close_window_child_fixture"])
                .env(GUI_FIXTURE_DIR, &directory)
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let (actor, owner) = GameProcess::new(child);
            let wait = tokio::spawn(actor.wait_with(
                request_window_close,
                Duration::from_secs(2),
                REQUESTED_STOP_WINDOW,
            ));
            tokio::time::timeout(Duration::from_secs(2), async {
                while !directory.join("ready").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(owner.request(false).await.unwrap(), StopStatus::Stopped);
            let exit = wait.await.unwrap().unwrap();
            assert!(exit.success());
            assert!(exit.requested_stop);
            assert_eq!(fs::read(directory.join("close")).unwrap(), b"WM_CLOSE");
            fs::remove_dir_all(directory).unwrap();
        });
    }
}
