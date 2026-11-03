# Voxelight Launcher 0.6.0 前端统一与性能复核

日期：2026-11-03（Asia/Singapore）。基线 `bd12066`，分支 `feat/frontend-transitions`。

用户授权完成前端方案全部项目，并解除原方案第 4、5 节的禁止项和逐项决策门槛。版本从 0.5.1 更新到 0.6.0。沿用现有依赖、MiSans、真实结晶世界和导航透镜，保留原有业务操作、原创许可和系统无障碍优先级。

## 实施与原因

| 范围 | Before / 根因 | After |
| --- | --- | --- |
| 下载切页 | 每次透镜移动生成约 66–70 张形变 PNG，同步编码占约 71–122ms；30 条任务挂载又触发布局、格式化和屏外画布分配 | 完整形变仍参与贴图，但实时贴图异步编码，仅保留最新待处理姿态和有界缓存；任务分组与 Intl 格式化缓存；画布先批量读尺寸再写，屏外静态画布延后分配 |
| 一级转场 | 页面使用 Motion 的 x 简写，页面位置不同放大跳动；首屏 boot 后的整页淡入遮住启动操作 | 合成 transform 字符串、统一标题和页面边距。首次首页由世界自己的开场负责；回首页与内容页仍保留转场 |
| 第 3 项 | 分区硬切、选中语法不同；创建表单 Tab 路径错误、重复 DOM id；通知被嵌套原生 dialog 遮住 | 共用 tabs/toggle/nav 控件和滑动标记、分区淡入、原生弹窗进退场、保留抽屉关闭快照、唯一全局通知。处理 native close 事件排队后的快速重开 |
| 第 4 项 | 标题与操作分散、左侧黑板、人物落点随布局变化失准、世界偏暗 | 左下紧凑控制台、局部可读性渐隐、脚底独立锚点；内容页溶解岛面；在线账户不重复显示预览胶囊；单实例隐藏最近列表，多实例最多四列 |
| 第 5 项 | 各页标题位置、圆角、按钮、下拉与表面各自定义 | PageShell/PageHeader、共同表面和圆角、三档药丸按钮；普通下拉扁平化，首页关键选择器保留玻璃。内容滚动裁切在导航下方，下载历史有稳定阅读底层，日志可选择 |
| 第 6 项 | 自定义强调色作为浅色正文不保证可读，世界与文字抢对比 | 信号色保留原值，文字使用经有界搜索校验的 accent-ink；纸面场景在内容页降低墨量，次要文字加深 |
| 第 7 项 | 启动控制块更换、成功反馈会冻结背景，初始已运行状态可能误播 | 56px 控制玻璃持续存在，内部状态转场，250ms 防误触取消；真实进度前沿、准备冲击和实际成功闪光；运行后角色回待机并暂停 |
| 第 8 项 | 搜索清空内容、旧卡可按新类型安装，初始化失败没有独立恢复状态，加载与空态冲突 | 同源旧结果保留但立即 inert，并守住操作处理器；换源清除旧结果；初始 bootstrap 失败可重试且不受过期 StrictMode 回调影响；共用延迟加载、空态只保留一个主操作 |
| 第 9 项 | 选中对勾与箭头重叠，静止光标还持续转动与申请 RAF | 选中静态点框、一个共享光标点池、静止后停帧并在输入时重启；Doto 数据、徽记点纹、小列表位置重排，输入中/大列表不重排 |

## 证据位置

本轮完整证据根：`E:/CodeX/VoxelightLauncher-worklogs/frontend-completion/2026-11-03/`。自动产物留在仓库外，测试源码与必要夹具保留。

- `downloads-baseline/`：实际 RTX 5080/D3D11 的原始 RAF、longtask、CPU profiles、30 任务截图、首轮静态贴图对照、最终异步贴图解码、滚动到末行并执行重试的记录。
- `home-world-qa.json` 与同目录 PNG：三个宽度、深浅主题、准备和运行状态；实际像素与控件几何。
- `first-home-native/`：新增首帧可见性回归的失败证据；`first-home-native-green/`、`home-1050-firstboot-fixed.png`：修复后的原断言及最小窗口截图。
- `shared-browser-final.log` 及其输出目录：原生 Chromium 输入、实际 NVIDIA renderer/命令行、共享标记中间态、弹窗进退中间态、嵌套通知与焦点路径。
- 各模块 `*-red.log` / `*-green.log`：失败先行回归，包括首屏、菜单、共享选择、真实下载列表测量、图像队列、焦点和空状态。
- `settled-visual-final/`：真实 D3D11、1050×720 深色与 1440×930 浅色首页、设置下拉菜单。等待页面、标题和菜单入场完成后采集；六个设置分区的导航实测高度均为 300.5px，菜单全在视口内，两组无页面错误。角色为测试夹具皮肤。

首页布局阶段实测岛面均值约 104.77/255、远景 p95 为 86。浅色正文最低 5.16:1；深色标题约 16.7:1，取消悬停约 9.86:1，启动操作不低于 11.29:1。完整测量方法、采样区域和逐状态值在 `home-world-qa.*` 中；最终状态对比度以最后一次完整套件的 `world-acceptance/` 为准。测试角色使用明显的合成皮肤，不代表用户账号资源。

## 测试变更说明

旧验收按本轮明确的新行为更新：在线预览胶囊消失但账号名称仍在角色的无障碍标签中；最近列表使用两实例夹具；选中 SVG 对勾改为真实静态点框；启动前沿起点由 0 改为 30，37% 对应约 80；scrim 移至首页伪元素。原有真实状态、焦点、动作、对比度和资源释放断言保留。共享布局和转场仍使用实际输入、实际 RAF 与合成帧。

GPU 队列修复后的阶段构建 `index-Bqq73mxa.js`，实际 NVIDIA RTX 5080 Laptop / ANGLE D3D11，关闭 CPU profiler，仅保留真实 RAF/longtask 观察：30 条下载任务的三个全新上下文冷切入最大帧间隔 **52.2 / 24.8 / 27.9ms**；五次复访 **11.3 / 12.6 / 12.7 / 11.3 / 9.9ms**。8 次均无 longtask 和 pageerror，**7/8 低于 40ms**。首个 52.2ms 峰值出现在输入后 148.1–200.3ms；这段已记录的回调耗时合计约 0.5ms，尚不能给该峰值归因，没有重采样覆盖。复访同步 PNG 编码为 0；实时形变使用异步路径，实际 Blob 解码成功。完整约 1.5 秒窗口、构建文件名和 SHA256 在 `downloads-baseline/gated-production-final-summary.json`。

**最终交付构建** `index-DCbvhwtL.js` 在全部功能修复和 149 项验收之后，以同一协议固定执行一次 3 次冷切入 + 5 次复访，30 条真实夹具任务、实际 NVIDIA/D3D11、CPU profiler 关闭：冷切入 **35.5 / 22.3 / 21.8ms**，复访 **9.2 / 8.5 / 8.9 / 8.4 / 19.5ms**，8 个样本均小于 40ms，无 longtask 或 pageerror。每个完整约 1.5 秒窗口记录 350–363 个真实 RAF；保持网格 160、65,536 点、DPR 1，未靠降画质取得结果。同步 PNG 仅冷进入有一次静态贴图，复访为零。采样前后 JS/CSS SHA256 相同，完整数据与资产哈希在 `downloads-baseline/final-release-production-summary.json`。阶段构建的 52.2ms 记录仍保留；这些有限样本不构成所有设备或每次冷启动的帧间隔保证。

此前尚未加入 GPU 队列调度时的生产数据保留在 `production-final-summary.json`，其冷峰值 36.1/26.0/24.1ms 不作为最终版本结果。方案的独立设置二访硬件验收最终通过：272 个真实 RAF、1124.9ms，最大间隔 **16.6ms**、首个输入后回调 **16ms**；见 `final-hardware.log` 和 `final-hardware-evidence/`。

开发环境与 CPU profiler 的冷样本曾达到 58.1ms，未删除该记录，也不把上述生产测量推广为所有设备保证。30 条任务从首屏起均有 DOM/无障碍值；首次只分配 3 个可见进度图；Tab 到末行实际滚动约 7285px 后，进度图绘制并执行了真实重试夹具命令。

最终源码验证：`npm test` 63 文件 / **566 项通过**（`release-final-unit.log`），`npx tsc -b` 零错误（`release-final-tsc.log`）；`cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过；`cargo test --locked --manifest-path src-tauri/Cargo.toml` **122 通过，1 项仓库原有网络 smoke 为 ignored**（会下载官方元数据和客户端，未新增忽略项）；`node scripts/check-i18n.mjs` 与 `node scripts/check-installer.mjs` 通过。国际化检查 2 个语言、725 个键。保留已有的大于 500kB 分包提示、jsdom Canvas 提示和 Rust 未使用项警告。

`npm run license:check` 最终通过：711 个第三方包、1,131 份许可声明，排除素材和 bundle 资源检查通过，日志 `release-final-license-check.log`。

首轮完整 Playwright 为 **141/149，8 项失败，30.6 分钟**，原始 `final-e2e.log` 未覆盖。分别定位并修复：通知/弹窗关闭名称冲突；取消保护时间和原生 disabled 状态不同步；滚动容器新边界对应两条旧几何断言；光学内缩裁切按钮（实测比例与 `(250×50)/(254×56)` 完全相等）；键盘框被光标所有权隐藏；世界标量使用模拟步长导致低帧率收敛过慢；软件 GPU 渲染队列积压导致截图回读超时。八条原用例在修复后 **8/8 通过，50.3 秒**，见 `fixed-e2e.log`。

GPU 修复在整帧提交前以零超时查询完成信号；忙时不继续排入过期帧，没有固定 FPS 上限。实际提交才计入帧数，逻辑时间继续推进；静态更新不会被丢弃，最终停稳画面会重试直到提交。暂停、隐藏、上下文丢失和卸载均有回归。截图仍使用原 PBO 辅助代码及原 5 秒/3 秒门槛。两个曾尝试的采集 API 虽通过逐字节像素对照，但未通过时限，均未引入产品/测试代码，失败证据完整保留在 `world-capture-canary/`。

第二轮完整 Playwright 为 **147/149，2 项失败，12.3 分钟**，见 `final-reviewed-e2e.log`。材质失败来自资源降档把尚未重绘的画面错误标注为实体材质；现只在有效提交后发布。复核同时补强 GPU 完成语义：连续 700ms 没有新提交也可能只是 GPU 忙，不能证明最后一帧已完成。最后提交后仅用零超时 fence 检查完成，不再绘制，完成才发布停稳状态并停止 RAF。验收在原 15 秒内同时要求帧数不变和真实停稳。五个新增失败回归转绿，四组 114 项定向单测通过，见 `fix-world-completion-{red,green,types}.log`。

补强后逐像素用例仍失败，实际查看两张截图并计算差异证明：19,942 个变化像素全部位于右下通知及其阴影 `[1056,620,1280,720]` 内，区域外变化为零。第 3 项把 Toast 移出内容容器后，旧 `withWorldView` 工具漏隐藏了全局通知，它在两张截图间自动消失。这才是该像素失败的根因。工具补隐藏 `.vx-toast-host` 及其子元素，保持原来“只观察世界”的范围；零像素变化断言、时间预算、分辨率和真实合成截图均保留。证据在 `gpu-final-frame-results/`，没有把最初的 GPU 假设当作已证实根因。

独立代码复核另发现持久整合包弹窗的请求竞态：关闭 A 后打开 B，A 的迟到版本列表可能覆盖 B。现在版本选择按项目绑定，关闭、重开和卸载会使旧请求失效；等待新列表期间禁止安装，关闭时仍保留退场快照。三条失败回归转绿，相关 33 项通过，见 `pack-generation-{red,green}.log`。

第 8 项收尾补齐资源列表、更新和历史的加载／失败状态：请求未完成时不显示空态，失败显示错误，成功返回空列表才显示对应空态。四条新增失败回归转绿，含整合包回归的相关 37 项通过，见 `resource-loading-{red,green}.log`。

| 实现 | 提交 |
| --- | --- |
| 共用表面、可访问控件、动效基础与文字对比度 | `7989f0a` |
| 异步折射、下载渲染、静止光标与有界缓存 | `34f7cc5` |
| 弹窗初始焦点遵守可访问 Tab 路径 | `d3d108f` |
| 首页构图、角色锚点、世界亮度和启动反馈 | `a36110d` |
| 七页、分区、初始化、搜索与全局通知 | `ef8e0cb` |
| 0.6.0 版本与固定来源的许可声明更新 | `34e8e4d` |
| 初始浏览器验收覆盖 | `f5e4a7c` |
| 通知按钮名称与弹窗区分 | `829366e` |
| 控制玻璃与交互内容分层、取消按钮就绪状态 | `4730ea8` |
| 光标接管下保留键盘焦点框 | `7b1b8ea` |
| 低帧率世界状态按真实时间收敛 | `3f3895e` |
| 动效位移与弹簧预设集中定义 | `780ddcc` |
| GPU 在途绘制调度、真实帧计数和释放 | `b5de73d` |
| 内容滚动边界验收 | `32b9e9e` |
| 已提交材质、GPU 完成状态与纯世界截图范围 | `a09ca43` |
| 整合包请求隔离、资源加载和空态边界 | `402354a` |

最终完整浏览器套件 **149/149 通过，12.2 分钟，退出码 0**，对应已冻结源码 `402354a`。实际命令为 `npm run test:e2e -- --output=E:/CodeX/VoxelightLauncher-worklogs/frontend-completion/2026-11-03/release-final-e2e-results`，截图环境变量同样指向仓库外。完整日志 `release-final-e2e.log`，证据 `release-final-evidence/` 和 `release-final-e2e-results/`。包含真实 D3D11 的共享几何、键盘与弹窗验收，以及 SwiftShader 的世界逐像素、对比度、资源与降级验收；没有并行运行其它 GPU 采样。

`powershell -File scripts/build.ps1` 成功，耗时 3 分 19 秒，内部实际执行 `npm run build` 与 Tauri/Rust/NSIS 构建。日志 `release-final-desktop-build.log`。最终生产资源为 `index-DCbvhwtL.js` / `index-BGI_yrR_.css`。桌面文件生成于 2026-11-03 14:52:25；安装包 22.33 MiB，完整 SHA256 为 `CE8B83CCC59B2CD2767C2346FDFCD48BC7E478B665C1417DE92B206AE9E360F9`，已复制到 `releases/0.6.0/VoxelightLauncher-0.6.0-x64-setup.exe`。前一轮构建产物没有作为最终包交付。

对应 GPL 源码包使用 `python scripts/package-source.py` 生成：`releases/0.6.0/VoxelightLauncher-0.6.0-source.zip`。该脚本校验版本一致性、必要源码／许可文件、ZIP CRC 和逐文件 SHA256 清单；不打包账号、游戏数据、依赖缓存或编译产物。安装包与源码包的完整哈希放在同目录 `SHA256SUMS.txt`，运行和人工检查提示见 `使用说明.txt`。

## 文件与需求复核清单

| 需求 | 主要文件 | 测试／页面证据 |
| --- | --- | --- |
| 下载切页卡顿、保留折射形变 | `src/visual/glass/{refractionImage,liveOptics,GlassSystem}.*`；`src/features/downloads/{DownloadsPage,TaskList,useDownloadTasks,downloads.css}`；`src/i18n/format.*`；`LatticeProgress.*` | `liveRefractionImage.test.ts`、`liveOptics.test.ts`、`format.test.ts`、`LatticeProgress.test.tsx`、`DownloadsPage.test.tsx`；`downloads-baseline/` 实测 |
| 页面与分区转场，第 3 项 | `src/design/motion.*`；`src/app/{App.tsx,shell.css}`；`src/components/ui/{SelectionMark,Segmented,RailNav,SectionPanel,Dialog,ToastProvider}.*` | `Segmented.test.tsx`、`ToastProvider.test.tsx`；`frontend-completion.spec.ts`、`transitions.spec.ts` 的中间帧、焦点与几何 |
| 首页、人物落点、世界，第 4 项 | `src/features/home/{HomePage,LaunchConsole,RecentInstances,home.css}`；`src/components/world/{presets,shaders,worldDirector,renderer}.*`；`WorldScene.*` | `HomePage.test.tsx`、`worldDirector.test.ts`、`renderer.test.ts`、`WorldScene*.test.tsx`；`settled-visual-final/home-*.png`、`world-acceptance/` |
| 七页表面、按钮、下拉，第 5 项 | `PageShell.tsx`、`Button.tsx`、`AnchoredListbox.*`；`tokens.css`、`surfaces.css`；`src/features/{accounts,discover,downloads,library,multiplayer,settings}` 页面与对应样式 | 各页现有单测、`Select.test.tsx`；`settled-visual-final/settings-menu-*.png` 与 `review.json`，最小窗口滚动验收 |
| 浅色和强调文字，第 6 项 | `src/design/accent.*`、`tokens.css`；页面文字颜色；`worldDirector.ts`、`shaders.ts` | `accent.test.ts`；深浅两主题 × 两尺寸的真实合成文本对比度 |
| 启动进度与成功反馈，第 7 项 | `LaunchConsole.tsx`、`HomePage.tsx`、`App.tsx`；世界 director／renderer；`LatticeProgress.tsx` | 0／249／250ms 取消保护、真实进度、已运行不误播、GPU 完成／释放单测；`world-lattice.spec.ts` 逐像素冻结与恢复 |
| 异步、空态和恢复，第 8 项 | `useDiscover.ts`、`DiscoverPage.tsx`、`ProjectDetailsDrawer.tsx`；controller；`LoadingStatus.tsx`；`CreateInstanceDialog.tsx`、`InstanceContent.tsx`、`useInstanceContent.ts`、`InstanceWorlds.tsx` | Discover／controller／LoadingStatus 单测；`LibraryPage.test.tsx` 迟到响应、关闭快照、加载和错误回归；完整浏览器的初始化重试、嵌套通知 |
| Lattice、数字和列表，第 9 项 | `src/visual/lattice/{cursor,staticMotion,lattice.css}`；实例卡片／LibraryPage；Downloads／ServerList | cursor／staticMotion／LatticeFrame 单测；`card-theme.spec.ts`、`transitions.spec.ts` 的键盘、减少透明和高对比 |
| 版本、许可和交付 | `package.json`、`package-lock.json`、`src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`；`licenses/`、`THIRD_PARTY_NOTICES.md`；本报告与设计入口 | 版本一致性、许可生成、TypeScript、566 项单测、Rust、完整浏览器与 NSIS 构建日志 |

所有操作使用原有业务命令；未新增依赖、未更换默认强调色。截图中的账号、实例和皮肤均为测试夹具；没有宣称真实账号安装、登录、游戏启动或安装升级手感已验收。

## 人工验收边界

Chromium/D3D11 的测量与截图不等于 Tauri/WebView2 手感确认。Intel 集显、真实账号完整游戏流程和安装/升级交互的人工验收尚未宣称通过。测试中出现的警告及完整失败记录会保留，不以单独复测冒充一次全绿运行。
