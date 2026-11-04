# 结晶世界性能实测

原生测量日期：2026-11-02。包含 Task 5 与当时最终功能版的两次完整原生界面测量；Intel 按用户决定留待人工验收。2026-11-03 的 0.6.0 前端与下载切页测量见文末，旧原生结果不冒充新版本重新测量。

用户于 2026-11-02 明确取消完全档的 30/60 FPS 上限。以下回调间隔来自未节流的 rAF；CPU 提交耗时、异步完成的 GPU 绘制耗时分别记录。精简、系统减少动态、高对比度、隐藏、离屏和游戏运行后的停绘规则继续生效。

## 设备与环境

- CPU：Intel Core Ultra 9 275HX，24 核／24 逻辑处理器。
- 实际 WebGL 渲染器：ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 Laptop GPU (0x00002C59) Direct3D11 vs_5_0 ps_5_0, D3D11)。
- WebView2：157.0.4341.30；NVIDIA 驱动 32.0.16.1742。
- 可见但尚未切换测量的 Intel Graphics 驱动：32.0.101.8826。系统另有虚拟显示适配器；不能由设备枚举结果冒称测过该设备。
- CSS 视口：1280×720，DPR 1.5，画布 1920×1080。通过原生 WebView2 CDP device metrics 设置视口，宿主窗口维持原尺寸；没有修改 Windows 图形设置。
- 完整界面含一个世界画布、一个 skinview3d 角色画布和一个共享玻璃画布。合成角色纹理由本次测试原创生成；账号／实例元数据保存在项目外隔离目录，无真实账号、令牌、存档或可运行游戏。
- 场景：地平线；深色；完全档。每组取 10 秒，指针组通过真实 CDP 鼠标输入在场景上移动。记录期没有并行 SwiftShader 功能测试。
- 所有组均保持 160×160 网格、DPR 1.5；点阵组为 65,536 点，未触发降档。

## Task 5：RTX 5080 原生结果

单位为毫秒；分位数采用有序样本的 nearest-rank。rAF 指标包含完整界面的调度／合成影响，CPU 和 GPU 列只代表世界渲染器的对应工作，不能互相代替。

| 材质／活动 | 10 秒绘制帧数 | rAF p50 | rAF p95 | CPU 提交 p95 | 已完成 GPU p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 点阵／空闲 | 2402 | 4.2 | 4.3 | 0.1 | 1.502 |
| 点阵／鼠标 | 2400 | 4.2 | 4.3 | 0.1 | 3.074 |
| 实体／空闲 | 2401 | 4.2 | 4.3 | 0.2 | 0.854 |
| 实体／鼠标 | 2402 | 4.2 | 4.3 | 0.2 | 0.879 |

本次 RTX 环境四组 rAF p95 均低于设计的 16.7ms 预算。异步 GPU 有效样本分别为 2399、2151、2392、2252；没有完成的 query 不记作零。页面错误列表为空。

原始数据及截图：`E:/CodeX/VoxelightLauncher-worklogs/crystal-world/native-performance/active-adapter.json`、同目录四组 `*-raw.json` 与 PNG。可重跑的采样器：`E:/CodeX/VoxelightLauncher-worklogs/crystal-world/measure-native.mjs`。

## Task 8：最终功能版 RTX 5080 原生结果

与上表使用同一实际 NVIDIA D3D11 适配器、WebView2 157.0.4341.30、1280×720 CSS 视口和 DPR 1.5。包含新开场、MiSans／Doto、角色步态、共用姿态菜单、局部 scrim、真实玻璃、鼠标点群低帧率积分修正，以及最后的字标关键帧补交／真实截止守卫；空闲／交互采样在开场结束后进行。三种画布均真实存在，角色为 ready；采样前等待原生后台纹理读取结束。没有替换 IPC 或修改系统显卡设置，期间没有并行软件渲染测试。

| 材质／活动 | 10 秒绘制帧数 | rAF p50 | rAF p95 | CPU 提交 p95 | 已完成 GPU p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 点阵／空闲 | 2401 | 4.2 | 4.3 | 0.2 | 0.548 |
| 点阵／鼠标 | 2401 | 4.2 | 4.3 | 0.2 | 0.679 |
| 实体／空闲 | 2401 | 4.2 | 4.3 | 0.2 | 1.198 |
| 实体／鼠标 | 2401 | 4.2 | 4.3 | 0.2 | 1.221 |

四组均低于 RTX 16.7ms 的预算，保持 160×160 网格、DPR 1.5；点阵为 65,536 点，未降档。GPU 有效样本分别为 2388、2209、2316、2211；不可用的计时不记作零。页面错误为空。各阶段的测量是不同运行时段的实际记录，不将差值当作优化收益。

原始数据：`E:/CodeX/VoxelightLauncher-worklogs/crystal-world/native-performance-release/active-adapter.json` 及同目录四组 `*-raw.json` 和 PNG。该 JSON 记录 App、WorldScene、renderer、shaders、cursor、CharacterCanvas 和 HomeAnimationSelector 共七个实际源码 SHA256，已逐一与本轮最终源码比对。采样器：`E:/CodeX/VoxelightLauncher-worklogs/crystal-world/measure-native-final.mjs`；输出日志：`intro-frame-2026-11-02/native-performance.log`。此前的中间测量保留在 `native-performance-final/`、`native-performance-complete/` 和 `native-performance-verified/`，未作为本表的最终数据。

另外，最终原生 600–2100ms 地平线开场序列保存在 `native-intro-sequence-after/`，山体开场补验保存在 `native-massif-intro-final/`，15 张两色／尺寸／菜单／山体截图保存在 `native-visual-after/`。完整截图证明字标已避开 scrim 和角色；这些是图像证据，不代替用户的最终视觉确认。

补帧修正后的原生主页／姿态菜单／奔跑补拍保存在 `native-visual-release/`。软件 WebGL 的补帧点位读回在 `intro-frame-2026-11-02/gpu-supplement/`：7282 个字标点均进入半格，58254 个普通点位置／速度不变，截止权重归零、GL 错误和释放后资源均为零；该功能验证不纳入物理显卡性能结论。

## Intel 与最终验收状态

| 项目 | 当前状态 |
| --- | --- |
| RTX 5080，Task 5 完整原生界面 | 已实测通过以上预算 |
| Intel Graphics，原生自动降档／25,600 点档，p95≤33ms | 未测；用户于 2026-11-02 明确允许继续 Task 6–8，移到最终人工验收 |
| Task 8 完整最终功能版，RTX 5080 | 已实测通过，见最终四组数据 |
| Task 8 完整最终功能版，Intel Graphics | 未测；按用户决定留待人工验收 |
| 用户最后视觉确认 | 尚未进行 |

以上结果仅代表本次设备、驱动、视口及界面负载，不代表所有低配机器。Chromium／SwiftShader 的功能测试没有纳入物理显卡性能结论。

## 双显卡复测步骤

1. Windows 设置 → 系统 → 显示 → 图形，添加桌面应用 `E:/CodeX/VoxelightLauncher/src-tauri/target/debug/voxelight-launcher.exe`。
2. 选择“高性能”或“节能”，确认显示的是 NVIDIA RTX 5080 或 Intel Graphics；保存。该系统操作由用户完成。
3. 重启本次隔离测试实例，使新 GPU 选择生效。需要通过 `WEBGL_debug_renderer_info` 再确认实际渲染器，不以设置面板或 GPU 枚举代替。
4. 使用同一 1280×720 视口、深色、地平线、完全档，点阵与实体分别测空闲／鼠标各 10 秒，记录实际网格、点数、DPR、rAF p50/p95、CPU/GPU 样本。
5. 记录自动降档后的实际预算。若 Intel 25,600 点档仍超过 33ms，按计划先报告数据，由用户确认后再调整该设备的实体回退策略。

隔离启动使用原有 `npm run desktop:dev`，仅覆盖 beforeDevCommand 以复用当前 Vite，并设置进程级数据目录及 CDP 端口；没有改持久系统环境变量或项目 Tauri 权限。

复测时先在项目目录用一个终端运行 `npm run dev`；另一个 PowerShell 终端设置以下进程环境并启动原生应用：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;" + $env:PATH
$env:VOXELIGHT_LAUNCHER_DATA_DIR = 'E:/CodeX/VoxelightLauncher-worklogs/crystal-world/native-fixture-data'
$env:VOXELIGHT_LAUNCHER_GAME_DIR = 'E:/CodeX/VoxelightLauncher-worklogs/crystal-world/native-fixture-games'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9238'
npm run desktop:dev -- --no-watch --config E:/CodeX/VoxelightLauncher-worklogs/crystal-world/desktop-dev-config.json
```

原生首页和合成角色就绪后，在第三个终端运行采样器。Intel 使用独立输出目录，保留已完成的 RTX 原始数据：

```powershell
$env:VOXELIGHT_NATIVE_PERF_OUTPUT = 'E:/CodeX/VoxelightLauncher-worklogs/crystal-world/native-performance-intel'
node E:/CodeX/VoxelightLauncher-worklogs/crystal-world/measure-native-final.mjs
```

采样器会通过真实设置界面选择深色并依次测试两种材质，结束时恢复跟随系统；材质停留在最后测量的实体，可在设置中改回点阵。先核对输出 JSON 中实际 GPU 名称，再记录 Intel 是否达到预算。

## 0.6.0 下载切页与 GPU 提交调度（2026-11-03）

本轮前端源码 `6396b53`（历史改写后的当前引用），生产入口 `index-DCbvhwtL.js`。实际 Chromium / ANGLE NVIDIA RTX 5080 Laptop D3D11，CPU profiler 关闭；并非原生 WebView2 重测。完整方案和全部验证见 [0.6.0 复核报告](reports/frontend-completion-0.6.0.md)。

每次输入后观察完整约 1.5 秒，30 条下载任务，固定一次采集三个全新上下文的首次切入和五次复访，没有为改善结果重复挑选样本：

| 测量 | 最大 rAF 帧间隔 |
| --- | --- |
| 首次切入，三个上下文 | 35.5 / 22.3 / 21.8ms |
| 复访，五次 | 9.2 / 8.5 / 8.9 / 8.4 / 19.5ms |

八个窗口均无 longtask 和 pageerror，350–363 个真实 RAF；保持 160 网格、65,536 点和 DPR 1。同步 PNG 编码在复访为零，冷进入保留一次静态贴图。原始数据及采样前后相同的 JS/CSS SHA256：`E:/CodeX/VoxelightLauncher-worklogs/frontend-completion/2026-11-03/downloads-baseline/final-release-production-summary.json`。

阶段构建 `index-Bqq73mxa.js` 的一个冷样本曾出现 52.2ms 峰值，其余两个为 24.8 / 27.9ms；原记录完整保留在 `gated-production-final-summary.json`，未被新数据覆盖。这里报告有限样本，不将其推广为所有设备或每次冷启动保证。

世界调度没有重新引入 FPS 上限：整帧提交前以零超时查询前一帧 fence，GPU 忙时不排入过期帧；逻辑时间继续推进。最终停稳帧会重试提交，随后仅查询完成，不再绘制，完成后停止 RAF。静态模式不创建查询循环，隐藏、暂停和卸载仍停止调度。材质标签对应最后有效提交，资源降档不会提前改写画面状态。单测覆盖这些边界，完整 149 项浏览器套件通过。

本版本的 Intel、实际 Tauri 手感和真实账号游戏流程仍按此前约定留待人工验收；上面的 Chromium 测量不代替这些步骤。
