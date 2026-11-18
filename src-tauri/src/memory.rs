use crate::models::{Config, Instance};

pub(crate) fn effective_mode<'a>(config: &'a Config, instance: Option<&'a Instance>) -> &'a str {
    if let Some(instance) = instance {
        if let Some(mode) = instance.memory_mode.as_deref() {
            return mode;
        }
        // Configs made before memory modes stored just this override.
        if instance.max_memory_mb.is_some() {
            return "manual";
        }
    }
    &config.memory_mode
}

pub(crate) fn manual_max(config: &Config, instance: Option<&Instance>) -> u32 {
    instance
        .and_then(|instance| instance.max_memory_mb)
        .unwrap_or(config.max_memory_mb)
        .clamp(512, 65_536)
}

pub(crate) fn validate_mode(mode: &str) -> Result<(), String> {
    if !matches!(mode, "auto" | "manual") {
        return Err("不支持所选内存分配模式".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MemorySnapshot {
    pub total_mb: u64,
    pub available_mb: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HeapReason {
    Recommended,
    LowAvailable,
    ManualFallback,
    BitnessCap,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MemoryPlan {
    pub max_mb: u32,
    pub reason: HeapReason,
}

#[cfg(windows)]
pub(crate) fn system_memory() -> Option<MemorySnapshot> {
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    // The structure is writable for this call and has its ABI size set above.
    unsafe { GlobalMemoryStatusEx(&mut status) }.ok()?;
    let total_mb = status.ullTotalPhys / (1024 * 1024);
    let available_mb = status.ullAvailPhys / (1024 * 1024);
    (total_mb > 0 && available_mb <= total_mb).then_some(MemorySnapshot { total_mb, available_mb })
}

#[cfg(not(windows))]
pub(crate) fn system_memory() -> Option<MemorySnapshot> {
    None
}

fn request(loader: Option<&str>, enabled_mods: usize) -> u32 {
    match loader {
        None | Some("" | "vanilla") => 2048,
        Some(_) => match enabled_mods {
            0 => 3072,
            1..=30 => 3072 + 512,
            31..=80 => 3072 + 1024,
            81..=150 => 3072 + 2048,
            151..=250 => 3072 + 3072,
            // c247b6c: a separate tier for very large packs.
            _ => 8192,
        },
    }
}

pub(crate) fn auto_heap_mb(
    snapshot: Option<MemorySnapshot>,
    loader: Option<&str>,
    enabled_mods: usize,
    java_64bit: bool,
    fallback_mb: u32,
) -> MemoryPlan {
    let (mut max_mb, mut reason) = match snapshot {
        Some(memory) => {
            let floor = if memory.total_mb <= 3072 { 768 } else { 1024 };
            let ceiling = (memory.total_mb.saturating_mul(3) / 4)
                .min(memory.total_mb.saturating_sub(2048))
                .min(memory.available_mb.saturating_sub(1024));
            let recommended = u64::from(request(loader, enabled_mods)).clamp(floor, ceiling.max(floor));
            let reason = if ceiling < floor { HeapReason::LowAvailable } else { HeapReason::Recommended };
            ((recommended / 256 * 256) as u32, reason)
        }
        None => (fallback_mb.clamp(512, 65_536), HeapReason::ManualFallback),
    };
    if !java_64bit && max_mb > 1024 {
        max_mb = 1024;
        if reason != HeapReason::LowAvailable {
            reason = HeapReason::BitnessCap;
        }
    }
    MemoryPlan { max_mb, reason }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MemoryOverview {
    total_mb: Option<u64>,
    available_mb: Option<u64>,
    recommended_mb: u32,
    effective_mode: String,
    mod_count: usize,
}

#[tauri::command]
pub(crate) async fn get_memory_overview(
    state: tauri::State<'_, std::sync::Arc<crate::storage::LauncherState>>,
    instance_id: Option<String>,
) -> Result<MemoryOverview, String> {
    let data = state.snapshot()?;
    tokio::task::spawn_blocking(move || {
        let instance = instance_id.as_ref().map(|id| {
            data.instances.iter().find(|row| &row.id == id).ok_or("实例不存在")
        }).transpose()?;
        let mod_count = if let Some(instance) = instance {
            let directory = crate::resources::resource_directory(&data, &instance.version_id,
                Some(&instance.id), crate::resources::ResourceKind::Mod)?;
            crate::resources::count_enabled_mods(&directory)?
        } else {
            0
        };
        let memory = system_memory();
        let loader = instance.map(|row| row.loader.as_str());
        let fallback = instance.and_then(|row| row.max_memory_mb).unwrap_or(data.config.max_memory_mb);
        Ok(MemoryOverview {
            total_mb: memory.map(|snapshot| snapshot.total_mb),
            available_mb: memory.map(|snapshot| snapshot.available_mb),
            recommended_mb: auto_heap_mb(memory, loader, mod_count, true, fallback).max_mb,
            effective_mode: effective_mode(&data.config, instance).into(),
            mod_count,
        })
    }).await.map_err(|error| format!("读取内存信息失败：{error}"))?
}

pub(crate) fn effective_min(config: &Config, instance: Option<&Instance>) -> Option<u32> {
    instance.and_then(|row| row.min_memory_mb).or(config.min_memory_mb)
}

pub(crate) fn validate_min(mode: &str, min_mb: Option<u32>, max_mb: u32) -> Result<(), String> {
    if let Some(min) = min_mb {
        if !(256..=65_536).contains(&min) {
            return Err("最小内存需要在 256–65536 MB 之间".into());
        }
        if mode == "manual" && min > max_mb {
            return Err("最小内存不能大于最大内存".into());
        }
    }
    Ok(())
}

pub(crate) fn memory_arguments(max_mb: u32, min_mb: Option<u32>) -> (Vec<String>, bool) {
    let mut args = vec![format!("-Xmx{max_mb}M")];
    if let Some(min_mb) = min_mb {
        args.push(format!("-Xms{}M", min_mb.clamp(256, max_mb)));
    }
    (args, min_mb.is_some_and(|min| min > max_mb))
}

pub(crate) fn is_memory_argument(arg: &str) -> bool {
    arg.starts_with("-Xms") || arg.starts_with("-Xmx")
}

pub(crate) fn validate_changed_heap_arguments(previous: &str, candidate: &str) -> Result<(), String> {
    if previous == candidate {
        return Ok(());
    }
    let args = shell_words::split(candidate).map_err(|_| "JVM 参数引号不匹配")?;
    if args.iter().any(|arg| is_memory_argument(arg)) {
        return Err("请使用最小和最大内存设置，不要在自定义 JVM 参数里使用 -Xms 或 -Xmx".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn u1675_system_memory_reports_plausible_values() {
        #[cfg(windows)]
        {
            let memory = system_memory().expect("system memory is available on this Windows host");
            assert!(memory.total_mb > 0 && memory.available_mb <= memory.total_mb);
        }
        #[cfg(not(windows))]
        assert!(system_memory().is_none());
    }

    const LARGE: MemorySnapshot = MemorySnapshot {
        total_mb: 32_768,
        available_mb: 20_000,
    };

    #[test]
    fn u1054_auto_heap_respects_low_memory_ceiling() {
        let plan = auto_heap_mb(
            Some(MemorySnapshot { total_mb: 4096, available_mb: 1800 }),
            None, 0, true, 4096,
        );
        assert_eq!(plan, MemoryPlan { max_mb: 1024, reason: HeapReason::LowAvailable });
        let plan = auto_heap_mb(
            Some(MemorySnapshot { total_mb: 3000, available_mb: 1000 }),
            Some("fabric"), 400, true, 4096,
        );
        assert_eq!(plan, MemoryPlan { max_mb: 768, reason: HeapReason::LowAvailable });
    }

    #[test]
    fn u1054_mod_count_boundaries_follow_the_adjudicated_tiers() {
        assert_eq!(auto_heap_mb(Some(LARGE), Some("vanilla"), 400, true, 4096).max_mb, 2048);
        for (mods, mb) in [
            (0, 3072), (1, 3584), (30, 3584), (31, 4096), (80, 4096),
            (81, 5120), (120, 5120), (150, 5120), (151, 6144), (250, 6144),
            (251, 8192), (400, 8192),
        ] {
            assert_eq!(auto_heap_mb(Some(LARGE), Some("forge"), mods, true, 4096).max_mb, mb, "{mods}");
        }
    }

    #[test]
    fn u1054_auto_heap_applies_physical_available_and_bitness_caps() {
        let physical_limit = MemorySnapshot { total_mb: 8192, available_mb: 8100 };
        assert_eq!(auto_heap_mb(Some(physical_limit), Some("fabric"), 400, true, 4096).max_mb, 6144);
        let available_limit = MemorySnapshot { total_mb: 32768, available_mb: 5001 };
        assert_eq!(auto_heap_mb(Some(available_limit), Some("fabric"), 400, true, 4096).max_mb, 3840);
        let limited = auto_heap_mb(Some(LARGE), Some("fabric"), 400, false, 4096);
        assert_eq!(limited, MemoryPlan { max_mb: 1024, reason: HeapReason::BitnessCap });
    }

    #[test]
    fn u1054_auto_heap_without_snapshot_uses_configured_fallback() {
        let plan = auto_heap_mb(None, Some("fabric"), 400, true, 5376);
        assert_eq!(plan, MemoryPlan { max_mb: 5376, reason: HeapReason::ManualFallback });
        assert_eq!(auto_heap_mb(None, None, 0, false, 5376).max_mb, 1024);
    }

    #[test]
    fn u1054_existing_manual_setting_beats_default_auto_for_instances() {
        let mut global = Config::default();
        assert_eq!(effective_mode(&global, None), "auto");
        let legacy = Instance { max_memory_mb: Some(6144), ..Default::default() };
        assert_eq!(effective_mode(&global, Some(&legacy)), "manual");
        assert_eq!(manual_max(&global, Some(&legacy)), 6144);
        global.memory_mode = "manual".into();
        let automatic = Instance { memory_mode: Some("auto".into()), ..legacy };
        assert_eq!(effective_mode(&global, Some(&automatic)), "auto");
    }


    #[test]
    fn u1054_missing_persisted_mode_preserves_manual_value() {
        let saved: Config = serde_json::from_value(serde_json::json!({ "maxMemoryMb": 6144 })).unwrap();
        assert_eq!(effective_mode(&saved, None), "manual");
        assert_eq!(manual_max(&saved, None), 6144);
    }
    #[test]
    fn u0880_initial_heap_arguments_clamp_only_when_set() {
        let (args, clamped) = memory_arguments(4096, Some(1024));
        assert_eq!(args, ["-Xmx4096M", "-Xms1024M"]);
        assert!(!clamped);
        let (args, clamped) = memory_arguments(4096, Some(8192));
        assert_eq!(args, ["-Xmx4096M", "-Xms4096M"]);
        assert!(clamped);
        let (args, clamped) = memory_arguments(4096, None);
        assert_eq!(args, ["-Xmx4096M"]);
        assert!(!clamped);
        assert!(validate_min("manual", Some(8192), 4096).is_err());
        assert!(validate_min("auto", Some(8192), 4096).is_ok());
        assert!(validate_min("auto", Some(255), 4096).is_err());
    }

    #[test]
    fn u0880_new_heap_flags_are_rejected_but_saved_and_unrelated_flags_are_allowed() {
        assert!(validate_changed_heap_arguments("-Xmx2G -XX:+UseG1GC", "-Xmx2G -XX:+UseG1GC").is_ok());
        assert!(validate_changed_heap_arguments("-Xmx2G", "-Xmx3G").is_err());
        assert!(validate_changed_heap_arguments("", "'-Xms512M'").is_err());
        assert!(validate_changed_heap_arguments("-Xmx2G", "-Dexample=-Xmx2G").is_ok());
    }
}
