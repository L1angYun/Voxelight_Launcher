//! Process identity for the update hand-off: a process is identified by its
//! PID plus its creation time, so a reused PID is never mistaken for it.
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Identity {
    pub(crate) pid: u32,
    pub(crate) created: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Liveness {
    Alive,
    Stale,
    Unknown,
}

#[cfg(windows)]
mod win32 {
    use super::{Identity, Liveness};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::time::Duration;
    use windows::core::HRESULT;
    use windows::Win32::Foundation::{ERROR_INVALID_PARAMETER, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    fn creation_time(process: HANDLE) -> Option<u64> {
        let (mut created, mut exit, mut kernel, mut user) =
            (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        // The handle is valid for the call and all four structures are writable.
        unsafe { GetProcessTimes(process, &mut created, &mut exit, &mut kernel, &mut user) }.ok()?;
        Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    pub(super) fn current() -> Option<Identity> {
        // The pseudo handle needs no closing.
        let created = creation_time(unsafe { GetCurrentProcess() })?;
        Some(Identity { pid: std::process::id(), created })
    }

    /// Opens `who` only if it is still the same process (PID and creation time).
    fn open(who: Identity) -> Result<OwnedHandle, Liveness> {
        if who.pid == 0 || who.created == 0 {
            return Err(Liveness::Unknown);
        }
        let process = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, who.pid) } {
            Ok(handle) => handle,
            // A PID missing from the process table: that process is gone.
            Err(error) if error.code() == HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) => return Err(Liveness::Stale),
            Err(_) => return Err(Liveness::Unknown),
        };
        // OpenProcess returned a newly owned handle, closed by OwnedHandle.
        let owned = unsafe { OwnedHandle::from_raw_handle(process.0) };
        match creation_time(HANDLE(owned.as_raw_handle())) {
            Some(created) if created == who.created => Ok(owned),
            Some(_) => Err(Liveness::Stale),
            None => Err(Liveness::Unknown),
        }
    }

    pub(super) fn liveness(who: Identity) -> Liveness {
        match open(who) {
            Ok(handle) => match unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), 0) } {
                WAIT_OBJECT_0 => Liveness::Stale,
                WAIT_TIMEOUT => Liveness::Alive,
                _ => Liveness::Unknown,
            },
            Err(state) => state,
        }
    }

    /// Waits for `who` to exit. True once it has exited (or was already gone).
    pub(super) fn wait_exit(who: Identity, timeout: Duration) -> bool {
        match open(who) {
            Ok(handle) => {
                let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
                let waited = unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), millis) };
                waited == WAIT_OBJECT_0
            }
            Err(Liveness::Stale) => true,
            Err(_) => false,
        }
    }

    /// A process handle opened after its identity was confirmed; waiting on
    /// it can never wait on a process that reused the PID.
    pub(crate) struct Held(OwnedHandle);

    pub(super) fn open_alive(who: Identity) -> Option<Held> {
        let handle = open(who).ok()?;
        (unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), 0) } == WAIT_TIMEOUT).then_some(Held(handle))
    }

    pub(super) fn wait_held(held: &Held, timeout: Duration) -> bool {
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        let waited = unsafe { WaitForSingleObject(HANDLE(held.0.as_raw_handle()), millis) };
        waited == WAIT_OBJECT_0
    }

    /// The user's own fresh environment (as Explorer gives a new program),
    /// built from the profile rather than from this process.
    pub(super) fn user_environment() -> Option<Vec<(std::ffi::OsString, std::ffi::OsString)>> {
        use std::os::windows::ffi::OsStringExt;
        use windows::Win32::Security::{TOKEN_DUPLICATE, TOKEN_IMPERSONATE, TOKEN_QUERY};
        use windows::Win32::System::Threading::OpenProcessToken;
        #[link(name = "Userenv")]
        unsafe extern "system" {
            fn CreateEnvironmentBlock(environment: *mut *mut core::ffi::c_void, token: isize, inherit: i32) -> i32;
            fn DestroyEnvironmentBlock(environment: *mut core::ffi::c_void) -> i32;
        }
        let mut token = HANDLE::default();
        // The pseudo handle needs no closing; the token is closed below.
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, &mut token) }.ok()?;
        let token = unsafe { OwnedHandle::from_raw_handle(token.0) };
        let mut block: *mut core::ffi::c_void = std::ptr::null_mut();
        if unsafe { CreateEnvironmentBlock(&mut block, token.as_raw_handle() as isize, 0) } == 0 || block.is_null() {
            return None;
        }
        let mut pairs = Vec::new();
        let mut cursor = block as *const u16;
        // The block is a run of NUL-terminated UTF-16 strings ending in an empty one.
        unsafe {
            loop {
                let mut length = 0;
                while *cursor.add(length) != 0 {
                    length += 1;
                }
                if length == 0 {
                    break;
                }
                let entry = std::slice::from_raw_parts(cursor, length);
                if entry[0] != u16::from(b'=') {
                    if let Some(split) = entry.iter().position(|unit| *unit == u16::from(b'=')) {
                        pairs.push((
                            std::ffi::OsString::from_wide(&entry[..split]),
                            std::ffi::OsString::from_wide(&entry[split + 1..]),
                        ));
                    }
                }
                cursor = cursor.add(length + 1);
            }
            DestroyEnvironmentBlock(block);
        }
        Some(pairs)
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct UniqueProcess {
        pid: u32,
        started: FILETIME,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct ProcessInfo {
        process: UniqueProcess,
        app_name: [u16; 256],
        service_name: [u16; 64],
        application_type: i32,
        app_status: u32,
        session_id: u32,
        restartable: i32,
    }

    /// The processes using `executable`, as the installer's Restart Manager
    /// check will see them, except `except`.
    pub(super) fn other_users(executable: &std::path::Path, except: Option<Identity>) -> Result<bool, String> {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "Rstrtmgr")]
        unsafe extern "system" {
            fn RmStartSession(session: *mut u32, flags: u32, key: *mut u16) -> u32;
            fn RmRegisterResources(
                session: u32,
                files: u32,
                names: *const *const u16,
                applications: u32,
                processes: *const UniqueProcess,
                services: u32,
                service_names: *const *const u16,
            ) -> u32;
            fn RmGetList(session: u32, needed: *mut u32, count: *mut u32, info: *mut ProcessInfo, reasons: *mut u32) -> u32;
            fn RmEndSession(session: u32) -> u32;
        }
        const ERROR_MORE_DATA: u32 = 234;
        let failed = |step: &str, code: u32| format!("无法确认是否有其他启动器正在运行（{step} {code}）");
        let mut session = 0u32;
        let mut key = [0u16; 33];
        let started = unsafe { RmStartSession(&mut session, 0, key.as_mut_ptr()) };
        if started != 0 {
            return Err(failed("start", started));
        }
        struct End(u32);
        impl Drop for End {
            fn drop(&mut self) {
                unsafe { RmEndSession(self.0) };
            }
        }
        let _end = End(session);
        let path: Vec<u16> = executable.as_os_str().encode_wide().chain(Some(0)).collect();
        let names = [path.as_ptr()];
        let registered = unsafe { RmRegisterResources(session, 1, names.as_ptr(), 0, std::ptr::null(), 0, std::ptr::null()) };
        if registered != 0 {
            return Err(failed("register", registered));
        }
        let mut list: Vec<ProcessInfo> = Vec::new();
        for _ in 0..4 {
            let (mut needed, mut count, mut reasons) = (0u32, list.len() as u32, 0u32);
            let status = unsafe { RmGetList(session, &mut needed, &mut count, list.as_mut_ptr(), &mut reasons) };
            if status == 0 {
                list.truncate(count as usize);
                let started = |info: &ProcessInfo| {
                    (u64::from(info.process.started.dwHighDateTime) << 32) | u64::from(info.process.started.dwLowDateTime)
                };
                return Ok(list.iter().any(|info| {
                    except.is_none_or(|me| info.process.pid != me.pid || started(info) != me.created)
                }));
            }
            if status != ERROR_MORE_DATA {
                return Err(failed("list", status));
            }
            // Zeroed plain-data structs are valid ProcessInfo values.
            list = vec![unsafe { std::mem::zeroed() }; needed as usize + 4];
        }
        Err(failed("list", ERROR_MORE_DATA))
    }

    pub(super) fn show_error(message: &str) {
        use windows::core::PCWSTR;
        use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "Voxelight Launcher".encode_utf16().chain(Some(0)).collect();
        // Both buffers are NUL-terminated and outlive the call.
        unsafe {
            MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR);
        }
    }
}

pub(crate) fn current() -> Option<Identity> {
    #[cfg(windows)]
    {
        win32::current()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

pub(crate) fn liveness(who: Identity) -> Liveness {
    #[cfg(windows)]
    {
        win32::liveness(who)
    }
    #[cfg(not(windows))]
    {
        let _ = who;
        Liveness::Unknown
    }
}

pub(crate) fn wait_exit(who: Identity, timeout: Duration) -> bool {
    #[cfg(windows)]
    {
        win32::wait_exit(who, timeout)
    }
    #[cfg(not(windows))]
    {
        let _ = (who, timeout);
        false
    }
}

pub(crate) fn show_error(message: &str) {
    #[cfg(windows)]
    win32::show_error(message);
    #[cfg(not(windows))]
    eprintln!("{message}");
}

#[cfg(windows)]
pub(crate) use win32::Held;
#[cfg(not(windows))]
pub(crate) struct Held;

/// Opens `who` if it is still that process and still running.
pub(crate) fn open_alive(who: Identity) -> Option<Held> {
    #[cfg(windows)]
    {
        win32::open_alive(who)
    }
    #[cfg(not(windows))]
    {
        let _ = who;
        None
    }
}

/// Waits on a held process; true once it has exited.
pub(crate) fn wait_held(held: &Held, timeout: Duration) -> bool {
    #[cfg(windows)]
    {
        win32::wait_held(held, timeout)
    }
    #[cfg(not(windows))]
    {
        let _ = (held, timeout);
        false
    }
}

/// A fresh user environment for programs started on the user's behalf.
pub(crate) fn user_environment() -> Option<Vec<(std::ffi::OsString, std::ffi::OsString)>> {
    #[cfg(windows)]
    {
        win32::user_environment()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Whether any process other than `except` uses `executable` (fails closed).
pub(crate) fn other_users(executable: &std::path::Path, except: Option<Identity>) -> Result<bool, String> {
    #[cfg(windows)]
    {
        win32::other_users(executable, except)
    }
    #[cfg(not(windows))]
    {
        let _ = (executable, except);
        Err("仅支持 Windows".into())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn identity_is_pid_plus_creation_time() {
        let me = current().unwrap();
        assert_eq!(current(), Some(me));
        assert_eq!(liveness(me), Liveness::Alive);
        assert_eq!(liveness(Identity { created: me.created + 1, ..me }), Liveness::Stale, "a reused PID is another process");
        assert_eq!(liveness(Identity { pid: 0, created: 1 }), Liveness::Unknown);
        assert!(!wait_exit(me, Duration::from_millis(50)), "a running process does not exit");
        let held = open_alive(me).unwrap();
        assert!(!wait_held(&held, Duration::from_millis(50)));
        assert!(open_alive(Identity { created: me.created + 1, ..me }).is_none());
    }

    #[test]
    fn a_finished_child_is_stale_and_its_wait_returns() {
        use std::os::windows::io::AsRawHandle;
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let created = win32_creation(child.as_raw_handle());
        let who = Identity { pid: child.id(), created };
        let held = open_alive(who);
        assert!(child.wait().unwrap().success());
        if let Some(held) = held {
            assert!(wait_held(&held, Duration::from_secs(5)));
        }
        assert!(wait_exit(who, Duration::from_secs(5)));
        assert_eq!(liveness(who), Liveness::Stale);
    }

    fn win32_creation(handle: std::os::windows::io::RawHandle) -> u64 {
        use windows::Win32::Foundation::{FILETIME, HANDLE};
        use windows::Win32::System::Threading::GetProcessTimes;
        let (mut created, mut exit, mut kernel, mut user) =
            (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe { GetProcessTimes(HANDLE(handle), &mut created, &mut exit, &mut kernel, &mut user) }.unwrap();
        (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)
    }

    #[test]
    fn the_user_environment_comes_from_the_profile() {
        let pairs = user_environment().expect("an environment block");
        let has = |name: &str| pairs.iter().any(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name));
        assert!(has("SystemRoot") && has("Path") && has("USERPROFILE") && has("ProgramFiles"));
        assert!(!pairs.iter().any(|(key, _)| key.to_string_lossy().starts_with("VOXELIGHT_UPD_")));
    }

    #[test]
    fn restart_manager_sees_other_users_of_a_running_executable() {
        let me = current().unwrap();
        let exe = std::env::current_exe().unwrap();
        // A test binary built in a folder with a Low integrity label runs at Low
        // IL, where Restart Manager cannot open its session (ERROR_WRITE_FAULT).
        // Production fails closed in that case; this check is then run from a
        // Medium-IL copy of the test binary.
        if let Err(error) = other_users(&exe, Some(me)) {
            assert!(error.ends_with("（start 29）"), "{error}");
            eprintln!("skipped at low integrity: {error}");
            return;
        }
        assert_eq!(other_users(&exe, Some(me)), Ok(false), "only this test process uses its binary");
        assert_eq!(other_users(&exe, None), Ok(true), "without the exception it is in use");
        let reused = Identity { created: me.created + 1, ..me };
        assert_eq!(other_users(&exe, Some(reused)), Ok(true), "the same PID with another start time is another process");
        let unused = std::env::temp_dir().join(format!("vx-rm-{}.exe", uuid::Uuid::new_v4().simple()));
        std::fs::write(&unused, b"not running").unwrap();
        let result = other_users(&unused, None);
        let _ = std::fs::remove_file(&unused);
        assert_eq!(result, Ok(false));
    }
}
