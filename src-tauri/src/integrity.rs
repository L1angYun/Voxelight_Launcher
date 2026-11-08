const MEDIUM_INTEGRITY_RID: u32 = 0x2000;

fn format_data_directory_failure(error: &str, integrity_rid: Option<u32>, locale: &str) -> String {
    let chinese = locale.starts_with("zh");
    if integrity_rid.is_some_and(|rid| rid < MEDIUM_INTEGRITY_RID) {
        if chinese {
            format!(
                "无法加载启动器数据目录。\n\n{error}\n\n\
                启动器正以低完整性级别运行，无法写入普通用户数据目录。\
                原因是可执行文件所在的目录带有低完整性标签。\n\
                以管理员身份运行不是正确的解决办法。\
                请将启动器重新安装或复制到普通目录（同卷移动可能保留标签），或在仓库中运行修复脚本：\n\
                powershell -NoProfile -ExecutionPolicy Bypass -File scripts/repair-build-integrity.ps1"
            )
        } else {
            format!(
                "Unable to load the launcher data directory.\n\n{error}\n\n\
                The launcher is running at low integrity and cannot write to a normal user data directory. \
                The directory containing the executable has a low-integrity label.\n\
                Running as administrator is not the correct fix. Please reinstall or copy the launcher to a normal directory \
                (moving it on the same volume can retain the label), \
                or run the repair script from the repository:\n\
                powershell -NoProfile -ExecutionPolicy Bypass -File scripts/repair-build-integrity.ps1"
            )
        }
    } else if chinese {
        format!("无法加载启动器数据目录。\n\n{error}\n\n请检查磁盘、目录权限和杀毒软件拦截。")
    } else {
        format!("Unable to load the launcher data directory.\n\n{error}\n\nCheck the disk, directory permissions, and antivirus blocking.")
    }
}

#[cfg(windows)]
fn current_process_integrity_level() -> Option<u32> {
    use std::mem::size_of;
    use windows::{
        core::Owned,
        Win32::{
            Foundation::HANDLE,
            Security::{
                GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid,
                TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
            },
            System::Threading::{GetCurrentProcess, OpenProcessToken},
        },
    };

    // Only TOKEN_QUERY is needed. Owned closes the real token handle on every
    // return path; the GetCurrentProcess pseudo-handle is never closed.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
        let token = Owned::new(token);
        let mut length = 0;
        let _ = GetTokenInformation(*token, TokenIntegrityLevel, None, 0, &mut length);
        if (length as usize) < size_of::<TOKEN_MANDATORY_LABEL>() {
            return None;
        }

        // Vec<u8> does not promise TOKEN_MANDATORY_LABEL alignment. usize
        // storage provides the native pointer alignment the returned label needs.
        let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
        GetTokenInformation(
            *token,
            TokenIntegrityLevel,
            Some(buffer.as_mut_ptr().cast()),
            length,
            &mut length,
        )
        .ok()?;
        let label = &*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
        let sid = label.Label.Sid;
        if !IsValidSid(sid).as_bool() {
            return None;
        }
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return None;
        }
        Some(*GetSidSubAuthority(sid, u32::from(count - 1)))
    }
}

pub(crate) fn data_directory_failure(error: &str) -> String {
    #[cfg(windows)]
    {
        use windows::Win32::Globalization::GetUserDefaultUILanguage;
        // No persisted language setting can be read when the data directory
        // cannot be opened. Use Windows' UI language without initializing COM.
        let language = unsafe { GetUserDefaultUILanguage() };
        let locale = if language & 0x03ff == 0x0004 {
            "zh-CN"
        } else {
            "en-US"
        };
        format_data_directory_failure(error, current_process_integrity_level(), locale)
    }
    #[cfg(not(windows))]
    {
        // Preserve the existing startup error on non-Windows platforms.
        format_data_directory_failure(error, None, "zh-CN")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ERROR: &str = "primary: Access is denied. (os error 5); fallback: denied";

    #[test]
    fn below_medium_integrity_explains_the_cause_and_repair_in_chinese() {
        for rid in [0, 0x1000, MEDIUM_INTEGRITY_RID - 1] {
            let message = format_data_directory_failure(ERROR, Some(rid), "zh-CN");
            assert!(
                message.contains("启动器正以低完整性级别运行"),
                "RID={rid}: {message}"
            );
            assert!(message.contains("可执行文件所在的目录带有低完整性标签"));
            assert!(message.contains("以管理员身份运行不是正确的解决办法"));
            assert!(message.contains("重新安装或复制到普通目录"));
            assert!(message.contains("同卷移动可能保留标签"));
            assert!(message.contains("scripts/repair-build-integrity.ps1"));
            assert!(message.contains(ERROR));
            assert!(!message.contains("请检查磁盘、目录权限和杀毒软件拦截"));
        }
    }

    #[test]
    fn below_medium_integrity_explains_the_cause_and_repair_in_english() {
        let message = format_data_directory_failure(ERROR, Some(0x1000), "en-US");
        assert!(message.contains("The launcher is running at low integrity"));
        assert!(message.contains("directory containing the executable has a low-integrity label"));
        assert!(message.contains("Running as administrator is not the correct fix"));
        assert!(message.contains("reinstall or copy the launcher to a normal directory"));
        assert!(message.contains("moving it on the same volume can retain the label"));
        assert!(message.contains("powershell -NoProfile -ExecutionPolicy Bypass -File scripts/repair-build-integrity.ps1"));
        assert!(message.contains(ERROR));
        assert!(!message.contains("antivirus"));
    }

    #[test]
    fn medium_higher_and_unknown_integrity_keep_the_general_diagnostic() {
        for rid in [
            None,
            Some(MEDIUM_INTEGRITY_RID),
            Some(0x2100),
            Some(0x3000),
            Some(0x4000),
        ] {
            let chinese = format_data_directory_failure(ERROR, rid, "zh-CN");
            assert!(chinese.contains("请检查磁盘、目录权限和杀毒软件拦截"));
            assert!(chinese.contains(ERROR));
            assert!(!chinese.contains("低完整性"));
            let english = format_data_directory_failure(ERROR, rid, "en-US");
            assert!(
                english.contains("Check the disk, directory permissions, and antivirus blocking")
            );
            assert!(english.contains(ERROR));
            assert!(!english.contains("low integrity"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_reads_the_real_process_token_integrity() {
        current_process_integrity_level().expect("TokenIntegrityLevel must be readable on Windows");
    }
}
