// SPDX-License-Identifier: GPL-3.0-only
//! NSIS command-line detection, forwarding, and silent argument formatting.
use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Command;

/// Returns true if an argument looks like an NSIS command-line flag
/// (`/S`, `/P`, `/UPDATE`, `/R`, `/D=...`, `/NS`, `/NCRC`, `/ARGS`, etc.).
pub fn is_nsis_flag(arg: &OsStr) -> bool {
    let text = arg.to_string_lossy();
    let mut chars = text.chars();
    matches!((chars.next(), chars.next()), (Some('/'), Some(c)) if c.is_ascii_alphabetic())
}

/// Returns true when Setup must bypass its UI and forward all arguments
/// verbatim to the embedded NSIS payload.
pub fn should_passthrough(args: &[OsString]) -> bool {
    args.iter().any(|arg| is_nsis_flag(arg))
}

/// Returns the raw command-line text after the program name.
///
/// Setup runs the embedded NSIS payload with this exact text (not a rebuilt
/// argument list) so repeated spaces inside an unquoted `/D=...` path survive
/// and NSIS parses the same command line the user wrote. A program name may be
/// quoted or unquoted; everything after it is kept byte for byte except the
/// separating whitespace.
fn is_separator(ch: char) -> bool {
    ch == ' ' || ch == '\t'
}

pub fn raw_command_line_tail(command_line: &str) -> &str {
    let trimmed = command_line.trim_start_matches(is_separator);
    if let Some(quoted) = trimmed.strip_prefix('"') {
        if let Some(end) = quoted.find('"') {
            return quoted[end + 1..].trim_start_matches(is_separator);
        }
        // An unterminated quote is not a valid command line; keep the raw tail
        // after the opening quote rather than dropping the user's arguments.
        return quoted.trim_start_matches(is_separator);
    }
    match trimmed.find(is_separator) {
        Some(end) => trimmed[end..].trim_start_matches(is_separator),
        None => "",
    }
}

/// Returns the live Windows command line after the executable name.
#[cfg(windows)]
pub fn system_raw_command_line_tail() -> Option<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCommandLineW() -> *const u16;
    }
    let pointer = unsafe { GetCommandLineW() };
    if pointer.is_null() {
        return None;
    }
    let mut length = 0usize;
    while unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    let wide = unsafe { std::slice::from_raw_parts(pointer, length) };
    let command_line = String::from_utf16_lossy(wide);
    Some(raw_command_line_tail(&command_line).to_owned())
}

/// Returns true if `arg` is an NSIS `/D=<path>` directory override that must be
/// passed unquoted as the final token on Windows.
fn is_nsis_dir_override(arg: &OsStr) -> Option<String> {
    let text = arg.to_str()?;
    let rest = text.strip_prefix("/D=")?;
    if rest.is_empty()
        || rest.contains('"')
        || rest.chars().any(|ch| ch.is_control())
    {
        return None;
    }
    Some(text.to_owned())
}

/// Builds the NSIS silent-install arguments used by the interactive Setup UI.
///
/// Note: `installer.nsi` currently supports `/NS` (which skips both Desktop and
/// Start menu shortcuts) and does not define a separate desktop-only CLI flag.
/// `/D=<target>` is always placed last per NSIS command-line rules.
pub fn build_silent_install_args(
    target_dir: &Path,
    is_update: bool,
    create_shortcuts: bool,
) -> Vec<OsString> {
    let mut args = vec![OsString::from("/S")];
    if is_update {
        args.push(OsString::from("/UPDATE"));
    }
    if !create_shortcuts {
        args.push(OsString::from("/NS"));
    }
    let mut dir_arg = OsString::from("/D=");
    dir_arg.push(target_dir.as_os_str());
    args.push(dir_arg);
    args
}

/// Appends NSIS arguments to a `Command`, ensuring a trailing `/D=<path>` is
/// emitted unquoted via `raw_arg` on Windows so paths containing spaces are
/// parsed intact by NSIS.
pub fn apply_nsis_args(command: &mut Command, args: &[OsString]) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for (index, arg) in args.iter().enumerate() {
            let is_last = index + 1 == args.len();
            if is_last {
                if let Some(raw_dir) = is_nsis_dir_override(arg) {
                    command.raw_arg(raw_dir);
                    continue;
                }
            }
            command.arg(arg);
        }
    }
    #[cfg(not(windows))]
    {
        command.args(args);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn detects_all_nsis_passthrough_flags() {
        for sample in [
            vec!["/S"],
            vec!["/P", "/UPDATE", "/R"],
            vec!["/S", "/NS", "/D=C:\\Users\\User\\Voxelight"],
            vec!["/D=C:\\Apps\\Voxelight Launcher"],
            vec!["/NCRC"],
            vec!["/UPDATE"],
            vec!["/R"],
            vec!["/NS"],
            vec!["/s"],
        ] {
            assert!(should_passthrough(&os(&sample)), "expected passthrough for {sample:?}");
        }
    }

    #[test]
    fn normal_launch_without_nsis_flags_does_not_passthrough() {
        assert!(!should_passthrough(&[]));
        assert!(!should_passthrough(&os(&["--inspect"])));
        assert!(!should_passthrough(&os(&["/"])));
        assert!(!should_passthrough(&os(&["/123"])));
    }

    #[test]
    fn builds_silent_install_args_with_dir_override_last() {
        let dir = Path::new(r"C:\Users\User\AppData\Local\Voxelight Launcher");
        assert_eq!(
            build_silent_install_args(dir, false, true),
            os(&["/S", r"/D=C:\Users\User\AppData\Local\Voxelight Launcher"])
        );
        assert_eq!(
            build_silent_install_args(dir, false, false),
            os(&["/S", "/NS", r"/D=C:\Users\User\AppData\Local\Voxelight Launcher"])
        );
        assert_eq!(
            build_silent_install_args(dir, true, true),
            os(&["/S", "/UPDATE", r"/D=C:\Users\User\AppData\Local\Voxelight Launcher"])
        );
        assert_eq!(
            build_silent_install_args(dir, true, false),
            os(&["/S", "/UPDATE", "/NS", r"/D=C:\Users\User\AppData\Local\Voxelight Launcher"])
        );
    }

    #[test]
    fn raw_tail_preserves_the_original_command_line_after_the_program_name() {
        assert_eq!(raw_command_line_tail(r#""C:\Program Files\Voxelight Setup.exe" /S"#), "/S");
        assert_eq!(
            raw_command_line_tail(r#""C:\Program Files\Voxelight Setup.exe"   /D=C:\Games\A  B  "#),
            r#"/D=C:\Games\A  B  "#,
            "repeated spaces inside an unquoted /D= path must survive",
        );
        assert_eq!(raw_command_line_tail(r"C:\Setup.exe /P /UPDATE /R"), "/P /UPDATE /R");
        assert_eq!(raw_command_line_tail(r"C:\Setup.exe"), "");
        assert_eq!(raw_command_line_tail("   "), "");
    }

    #[test]
    fn dir_override_rejects_quotes_and_control_characters() {
        assert!(is_nsis_dir_override(OsStr::new(r"/D=C:\Users\User\Voxelight Launcher")).is_some());
        assert!(is_nsis_dir_override(OsStr::new(r#"/D=C:\Bad"Path"#)).is_none());
        assert!(is_nsis_dir_override(OsStr::new("/D=C:\\Bad\nPath")).is_none());
        assert!(is_nsis_dir_override(OsStr::new("/D=")).is_none());
    }
}
