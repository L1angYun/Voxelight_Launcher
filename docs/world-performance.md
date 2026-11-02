# 结晶世界性能实测

日期：2026-11-02。当前记录为 Task 5 完成后的完整原生界面；Task 8 最终版本仍需复测。

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

## Intel 与最终验收状态

| 项目 | 当前状态 |
| --- | --- |
| RTX 5080，Task 5 完整原生界面 | 已实测通过以上预算 |
| Intel Graphics，原生自动降档／25,600 点档，p95≤33ms | 未测；用户于 2026-11-02 明确允许继续 Task 6–8，移到最终人工验收 |
| Task 8 完整最终功能版，两显卡复测 | 尚未进行 |
| 用户最后视觉确认 | 尚未进行 |

以上结果仅代表本次设备、驱动、视口及界面负载，不代表所有低配机器。Chromium／SwiftShader 的功能测试没有纳入物理显卡性能结论。

## 双显卡复测步骤

1. Windows 设置 → 系统 → 显示 → 图形，添加桌面应用 `E:/CodeX/VoxelightLauncher/src-tauri/target/debug/voxelight-launcher.exe`。
2. 选择“高性能”或“节能”，确认显示的是 NVIDIA RTX 5080 或 Intel Graphics；保存。该系统操作由用户完成。
3. 重启本次隔离测试实例，使新 GPU 选择生效。需要通过 `WEBGL_debug_renderer_info` 再确认实际渲染器，不以设置面板或 GPU 枚举代替。
4. 使用同一 1280×720 视口、深色、地平线、完全档，点阵与实体分别测空闲／鼠标各 10 秒，记录实际网格、点数、DPR、rAF p50/p95、CPU/GPU 样本。
5. 记录自动降档后的实际预算。若 Intel 25,600 点档仍超过 33ms，按计划先报告数据，由用户确认后再调整该设备的实体回退策略。

隔离启动使用原有 `npm run desktop:dev`，仅覆盖 beforeDevCommand 以复用当前 Vite，并设置进程级数据目录及 CDP 端口；没有改持久系统环境变量或项目 Tauri 权限。
