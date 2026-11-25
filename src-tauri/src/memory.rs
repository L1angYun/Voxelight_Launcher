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

/// The heap one launch gets, plus the log lines that explain it.
pub(crate) struct LaunchHeap {
    pub max_mb: u32,
    pub logs: Vec<(&'static str, String)>,
}

/// Chooses the launch heap. Manual mode uses the configured value. Automatic
/// mode sizes by mod count and system memory; when the mods folder cannot be
/// read safely it falls back to the configured value. `snapshot` is only
/// consulted when the mod count is known.
pub(crate) fn launch_heap(
    config: &Config,
    instance: Option<&Instance>,
    loader: Option<&str>,
    mods: Result<usize, String>,
    snapshot: impl FnOnce() -> Option<MemorySnapshot>,
    java_64bit: bool,
) -> LaunchHeap {
    let fallback_mb = manual_max(config, instance);
    if effective_mode(config, instance) != "auto" {
        return LaunchHeap { max_mb: fallback_mb, logs: Vec::new() };
    }
    let mut logs = Vec::new();
    let (memory, mods) = match mods {
        Ok(count) => (snapshot(), Some(count)),
        Err(error) => {
            logs.push(("warn", error));
            (None, None)
        }
    };
    let plan = auto_heap_mb(memory, loader, mods.unwrap_or(0), java_64bit, fallback_mb);
    logs.push(heap_log(plan, memory, mods, java_64bit));
    LaunchHeap { max_mb: plan.max_mb, logs }
}

/// One launch-log line with every input of the automatic plan. Unknown inputs
/// are written as such, never as zero.
pub(crate) fn heap_log(
    plan: MemoryPlan,
    memory: Option<MemorySnapshot>,
    mods: Option<usize>,
    java_64bit: bool,
) -> (&'static str, String) {
    let reason = match plan.reason {
        HeapReason::Recommended => "按当前物理内存和启用模组数推荐",
        HeapReason::LowAvailable => "当前可用内存不足，使用最低档",
        HeapReason::ManualFallback => "无法读取自动分配所需数据，使用设置的备用值",
        HeapReason::BitnessCap => "受 32 位 Java 上限约束",
    };
    let (total, available) = memory.map_or_else(
        || ("未知".to_owned(), "未知".to_owned()),
        |value| (format!("{} MiB", value.total_mb), format!("{} MiB", value.available_mb)),
    );
    let mods = mods.map_or_else(|| "未知".to_owned(), |count| count.to_string());
    let bits = if java_64bit { 64 } else { 32 };
    let level = if plan.reason == HeapReason::LowAvailable { "warn" } else { "info" };
    (
        level,
        format!(
            "自动分配游戏内存：{} MiB（{reason}；总内存 {total}，可用 {available}，启用模组 {mods} 个，{bits} 位 Java）",
            plan.max_mb
        ),
    )
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

/// Resolves the loader the way launch does: a known instance loader wins,
/// otherwise the installed version profile decides.
pub(crate) fn overview_loader(recorded: &str, installed: Option<String>) -> Option<String> {
    Some(recorded)
        .filter(|loader| matches!(*loader, "forge" | "neoforge" | "fabric" | "quilt"))
        .map(str::to_owned)
        .or(installed)
}

/// Builds the overview. An instance whose mods folder cannot be read safely
/// gets no snapshot, so the hint is hidden instead of the command failing;
/// launch falls back to the configured value in the same case.
pub(crate) fn memory_overview(
    config: &Config,
    instance: Option<&Instance>,
    loader: Option<&str>,
    mods: Result<usize, String>,
    snapshot: Option<MemorySnapshot>,
) -> MemoryOverview {
    let (memory, mod_count) = match mods {
        Ok(count) => (snapshot, count),
        Err(_) => (None, 0),
    };
    let fallback = manual_max(config, instance);
    MemoryOverview {
        total_mb: memory.map(|value| value.total_mb),
        available_mb: memory.map(|value| value.available_mb),
        recommended_mb: auto_heap_mb(memory, loader, mod_count, true, fallback).max_mb,
        effective_mode: effective_mode(config, instance).into(),
        mod_count,
    }
}

pub(crate) async fn memory_overview_for_state(
    state: &std::sync::Arc<crate::storage::LauncherState>,
    instance_id: Option<String>,
) -> Result<MemoryOverview, String> {
    let data = state.snapshot()?;
    tokio::task::spawn_blocking(move || {
        let instance = instance_id.as_ref().map(|id| {
            data.instances.iter().find(|row| &row.id == id).ok_or("实例不存在")
        }).transpose()?;
        let (loader, mods) = if let Some(instance) = instance {
            let installed = crate::processes::configured_game_root(std::path::Path::new(&data.config.game_directory))
                .ok()
                .and_then(|root| crate::resources::version_context(&root, &instance.version_id).ok())
                .and_then(|(_, loader)| loader);
            let mods = crate::resources::resource_directory(&data, &instance.version_id,
                Some(&instance.id), crate::resources::ResourceKind::Mod)
                .and_then(|directory| crate::resources::count_enabled_mods(&directory));
            (overview_loader(&instance.loader, installed), mods)
        } else {
            (None, Ok(0))
        };
        Ok(memory_overview(&data.config, instance, loader.as_deref(), mods, system_memory()))
    }).await.map_err(|error| format!("读取内存信息失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn get_memory_overview(
    state: tauri::State<'_, std::sync::Arc<crate::storage::LauncherState>>,
    instance_id: Option<String>,
) -> Result<MemoryOverview, String> {
    memory_overview_for_state(state.inner(), instance_id).await
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

/// Validates the memory part of an instance save. Only a change to the
/// instance's own effective memory settings may be rejected: a conflict that
/// comes from an inherited global value is left to the launch-time clamp, so
/// unrelated edits such as a rename or notes still save.
pub(crate) fn validate_instance_memory(
    config: &Config,
    current: &Instance,
    candidate: &Instance,
) -> Result<(), String> {
    let own = |row: &Instance| {
        (effective_mode(config, Some(row)).to_owned(), row.max_memory_mb, row.min_memory_mb)
    };
    if own(current) == own(candidate) {
        return Ok(());
    }
    validate_min(
        effective_mode(config, Some(candidate)),
        effective_min(config, Some(candidate)),
        manual_max(config, Some(candidate)),
    )
}

pub(crate) fn memory_arguments(max_mb: u32, min_mb: Option<u32>) -> (Vec<String>, bool) {
    let mut args = vec![format!("-Xmx{max_mb}M")];
    if let Some(min_mb) = min_mb {
        args.push(format!("-Xms{}M", min_mb.clamp(256, max_mb)));
    }
    (args, min_mb.is_some_and(|min| min > max_mb))
}

pub(crate) fn is_memory_argument(arg: &str) -> bool {
    // HotSpot takes the last value, so the -XX spellings would override the
    // launcher's own -Xmx/-Xms and bypass the automatic and 32-bit caps.
    ["-Xms", "-Xmx", "-XX:MaxHeapSize=", "-XX:InitialHeapSize=", "-XX:MinHeapSize="]
        .iter()
        .any(|prefix| arg.starts_with(prefix))
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
    fn c5_launch_heap_keeps_manual_values_and_falls_back_when_mods_are_unreadable() {
        let never = || -> Option<MemorySnapshot> { panic!("manual mode must not read system memory") };
        let legacy = Instance { max_memory_mb: Some(16_384), ..Default::default() };
        let heap = launch_heap(&Config::default(), Some(&legacy), Some("forge"), Ok(200), never, true);
        assert_eq!(heap.max_mb, 16_384);
        assert!(heap.logs.is_empty());

        let auto = Config { max_memory_mb: 5376, ..Default::default() };
        let unread = || -> Option<MemorySnapshot> { panic!("an unreadable mods folder must not use system memory") };
        let heap = launch_heap(&auto, None, Some("forge"), Err("模组目录是链接".into()), unread, true);
        assert_eq!(heap.max_mb, 5376);
        assert_eq!(heap.logs[0], ("warn", "模组目录是链接".to_owned()));
        assert!(heap.logs[1].1.contains("使用设置的备用值") && heap.logs[1].1.contains("启用模组 未知 个"));

        let heap = launch_heap(&auto, None, Some("forge"), Ok(200), || Some(LARGE), true);
        assert_eq!(heap.max_mb, 6144);
        assert_eq!(heap.logs.len(), 1);
    }

    #[test]
    fn c5_overview_matches_launch_inputs_and_hides_on_unreadable_mods() {
        assert_eq!(overview_loader("vanilla", Some("fabric".into())).as_deref(), Some("fabric"));
        assert_eq!(overview_loader("forge", Some("fabric".into())).as_deref(), Some("forge"));
        assert_eq!(overview_loader("vanilla", None), None);
        let instance = Instance { memory_mode: Some("auto".into()), ..Default::default() };
        let config = Config::default();
        let overview = memory_overview(&config, Some(&instance), Some("forge"), Ok(200), Some(LARGE));
        assert_eq!((overview.total_mb, overview.mod_count, overview.recommended_mb), (Some(32_768), 200, 6144));
        let hidden = memory_overview(&config, Some(&instance), Some("forge"), Err("链接".into()), Some(LARGE));
        assert_eq!((hidden.total_mb, hidden.available_mb), (None, None));
    }

    #[test]
    fn c5_heap_log_names_every_input_and_warns_when_memory_is_low() {
        let (level, text) = heap_log(
            MemoryPlan { max_mb: 6144, reason: HeapReason::Recommended },
            Some(LARGE), Some(200), true,
        );
        assert_eq!(level, "info");
        for part in ["6144 MiB", "总内存 32768 MiB", "可用 20000 MiB", "启用模组 200 个", "64 位 Java"] {
            assert!(text.contains(part), "{part} in {text}");
        }
        let low = MemorySnapshot { total_mb: 16_384, available_mb: 500 };
        let (level, text) = heap_log(auto_heap_mb(Some(low), Some("forge"), 10, true, 4096), Some(low), Some(10), true);
        assert_eq!(level, "warn");
        assert!(text.contains("可用 500 MiB"));
        let (level, text) = heap_log(
            MemoryPlan { max_mb: 1024, reason: HeapReason::BitnessCap }, Some(LARGE), Some(0), false,
        );
        assert_eq!(level, "info");
        assert!(text.contains("32 位 Java") && text.contains("启用模组 0 个"));
    }

    #[test]
    fn c5_inherited_initial_memory_does_not_block_unrelated_instance_saves() {
        let global = Config {
            memory_mode: "manual".into(),
            max_memory_mb: 8192,
            min_memory_mb: Some(4096),
            ..Default::default()
        };
        let legacy = Instance { max_memory_mb: Some(2048), ..Default::default() };
        // A rename resubmits the same memory fields; the form maps the legacy row to manual.
        let renamed = Instance { name: "renamed".into(), memory_mode: Some("manual".into()), ..legacy.clone() };
        assert!(validate_instance_memory(&global, &legacy, &renamed).is_ok());
        // Changing the instance's own memory still rejects a new conflict.
        let lowered = Instance { max_memory_mb: Some(1024), ..legacy.clone() };
        assert!(validate_instance_memory(&global, &legacy, &lowered).is_err());
        let own_min = Instance { min_memory_mb: Some(3072), ..legacy.clone() };
        assert!(validate_instance_memory(&global, &legacy, &own_min).is_err());
        let fitting = Instance { min_memory_mb: Some(1024), ..legacy.clone() };
        assert!(validate_instance_memory(&global, &legacy, &fitting).is_ok());
    }

    #[test]
    fn u0880_new_heap_flags_are_rejected_but_saved_and_unrelated_flags_are_allowed() {
        assert!(validate_changed_heap_arguments("-Xmx2G -XX:+UseG1GC", "-Xmx2G -XX:+UseG1GC").is_ok());
        assert!(validate_changed_heap_arguments("-Xmx2G", "-Xmx3G").is_err());
        assert!(validate_changed_heap_arguments("", "'-Xms512M'").is_err());
        assert!(validate_changed_heap_arguments("-Xmx2G", "-Dexample=-Xmx2G").is_ok());
        for spelling in ["-XX:MaxHeapSize=1g", "-XX:InitialHeapSize=512m", "-XX:MinHeapSize=256m"] {
            assert!(is_memory_argument(spelling), "{spelling}");
            assert!(validate_changed_heap_arguments("", spelling).is_err(), "{spelling}");
        }
        assert!(!is_memory_argument("-XX:MaxRAMPercentage=50"));
    }

    #[test]
    fn u0880_equal_initial_and_maximum_is_accepted_without_a_clamp() {
        assert!(validate_min("manual", Some(4096), 4096).is_ok());
        assert_eq!(memory_arguments(4096, Some(4096)), (vec!["-Xmx4096M".to_owned(), "-Xms4096M".to_owned()], false));
        assert!(validate_min("auto", Some(65_536), 70_000).is_ok());
        assert!(validate_min("auto", Some(65_537), 70_000).is_err());
        assert!(validate_min("auto", Some(256), 4096).is_ok());
    }
}
