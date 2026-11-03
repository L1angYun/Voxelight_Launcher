# Voxelight Launcher 0.5.1 前端转场复核

日期：2026-11-03（Asia/Singapore）。基线 `feat/crystal-world@9d3b641`，工作分支 `feat/frontend-transitions`。本次只实施[转场方案](../superpowers/specs/2026-11-03-voxelight-frontend-transitions-and-surfaces.md)第 3 节的第 1、2 项。用户直接授权自查后推送此分支，并要求更新版本；第 3 项以后等待用户试手感。

| 独立改动 | 提交 | 验证 |
| --- | --- | --- |
| 先实现 32 项折射贴图 LRU、合并计算样式读取 | `4758d46` | 先 RED，玻璃相关 27 项通过；包含静态重复、LRU 淘汰、失败恢复和不同姿态贴图 |
| 版本和锁文件同步到 0.5.1 | `37311eb` | 版本校验 16/16，许可检查 711 包／1129 份声明；`cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过，6 项既有警告 |
| 中央动效数值、独立 tier 与 sceneStatic、MotionConfig | `004cb87` | `motion.test.ts`；Vitest 显式 0ms，浏览器使用真实时长 |
| 导航透镜 340/30、按压阻尼 34、单帧测量和绘制边界 | `ee8a882` | 真组件 RAF 测试及五次一级切页的边界／字标检查 |
| 世界相机 36/12、保留上次锚点，重绑同坐标的新节点 | `44206ef`、`eec7738` | 相机起步速度、0.5s／1s 收敛目标、静态一次重绘及重新观察的 RED→GREEN |
| 回首页／角色预览延迟、取消与角色局部淡入 | `b3c184b` | 角色、首页、账号 62 项及 Node 角色回归 8 项通过；none 档构造等待为 0，减少透明不关角色动画 |
| 页面按序退入、退场禁操作、状态条脱离变换祖先 | `94f1199` | 真实页面舞台 RED→GREEN；已有首页／参考对齐 11/11 通过 |
| 保留捕获指针后的当前项点击，补齐低帧率弹簧时钟 | `0571608` | 原生点击先复现回顶失败；Node 回归 17/17，真实 48 实例浏览器滚动 2821→0 |
| 实际页面、降级和硬件帧时采集，多实例 fixture | `d93e5b4` | 新 `tests/e2e/transitions.spec.ts`；本节下方记录测量边界 |
| 实例／版本目录共享身份、滚动及焦点 | `32dffd5` | 13 个新回归先失败再通过；独立卡片依旧无需外观 Provider；11 项真实专项全过 |
| 逐 RAF 的身份几何及硬件采集 | `2e1a7f9` | RTX 5080 实测 8 组开卡／返回，精简、减少动态和同页回顶由软件套件覆盖 |
| 版本测试的 Node ESM JSON 导入 | `d70cb91` | 添加 Node 所需的 JSON import attribute，版本断言不改；完整 140 项可发现 |
| 详情淡入结束后释放合成层 | `34718f2` | 真实 Chromium 先测到 `both` 残留；移除后，详情恢复常态合成，原几何与焦点断言同时通过 |
| 角色即时构造失败仅报错一次 | `72b38bf` | 构造失败原来被资源 effect 重放；角色套件 23/23 通过，显式重试可用新资源 |
| 等设置舞台就位后测静态分区 | `5dbffc4` | 原三个几何门槛保留；1440×930、1050×720 两项复测通过 |
| 慢渲染时采满真实 RAF 再结束采集 | `b6e3985` | 原 7 秒预算和至少 3 帧门槛保留；快速连点连续 3 次通过 |

缓存键与方案原七项不同，原因已向用户报告并获确认：实际 `liveOptics.ts` 会把带形变的几何传进同一函数，键补入 `bendX`、`bendY`、`pressure`、`stretch`、`heading`，总容量仍为 32。不改光学计算和贴图内容。出入场标称 80+180ms；软件渲染的真实时长会受到调度和 GPU 负载影响，不把标称时长当实测。

## 第 1 项证据

本轮外部证据根：`E:/CodeX/VoxelightLauncher-worklogs/frontend-transitions/2026-11-03/`。常规测试默认写 `test-results/transitions/`，本轮用 `VOXELIGHT_TRANSITION_EVIDENCE` 迁出项目。

| 验收项 | 证据与结果 |
| --- | --- |
| 五次一级页面切换都出现真实内容动画 | `evidence-step1/` 逐帧，首页→库、库→探索、探索→设置、设置→下载、下载→首页的 `contentAnimFrames` 为 1、3、4、4、3；只统计实际舞台 |
| 下载→首页透镜不压字标 | 同目录 `downloads-to-home/` 的真实合成关键帧、导航／透镜／字标边界；完整横向行程 Node 回归保留 |
| 人物不早于岛全显 | 实际查看 `03-548ms.jpg`、`04-1981ms.jpg`、`settled.png`：岛先出现、人物后显。此为软件 Chromium 图像证据，不宣称真实 Tauri 手感已确认 |
| 快速连点最后目标正确 | `step1-six-e2e.log` 与 `evidence-step1-six/` 的 `rapid-latest-target/`，记录真实输入序列和动作完成边界 |
| 当前项回到顶部 | `nav-clock-e2e.log`、`evidence-nav-clock/` 的 `current-library-to-top/`，实际 48 个实例、scrollTop 2821→0、11 个 RAF 样本、真实 post-input 合成帧及前后截图 |
| Lite／减少动态／减少透明／高对比 | 四个真实浏览器用例通过；页面无位移，保留键盘选中标记，减少透明下场景／角色保持动态 |
| 设置二访分区切换小于 40ms | 最终 `delivery-reviewed-hardware.log`，完整 Chromium，ANGLE D3D11 NVIDIA GeForce RTX 5080 Laptop GPU；173 帧、1125ms，最大 RAF 间隔 **20.9ms**、首个输入后回调 **20.7ms**，无 SwiftShader 参数。原始 `delivery-reviewed-hardware/`；上次原始证据在 `evidence-hardware-chromium/` |
| 人工查看探索玻璃、首页启动区 | 浏览器 settled PNG 和现有玻璃／启动回归；最终原生窗口的视觉和手感由用户确认 |

探针失败保留：首轮新专项 3/9，四项 `.focus()` 未进入键盘模式，另有输入后取样过早或 CDP 尚未交付帧。修正为真实 Tab、采完实际操作后 1100ms、采集等待共用原 7000ms，不减少帧数或焦点断言。原生同页捕获把 click 重定向到 nav 导致回顶失败，由指针释放提交并抑制重复 click 修复。后续多实例用例先在原 5s 收敛等待失败；真实组件 1Hz 诊断证实每秒只积 80ms，17s 才收敛。仅 Nav 按实际时间分片，一次 RAF 仍只绘制一次，保留共享 Spring 和弹簧参数，原 5s/7s 门槛通过。

全套中的既有设置布局用例在 1050×720 下测到设置 Bar 的 Y 跨度 105px；设置 Bar 和窗口 Bar 的高度一直分别是 55px、58px。探针 `settings-scroll-hw.json` 复现首次定位器点击前 `main.scrollTop` 从 0 跳到 105，随后因较短分区的滚动上限降为 15、13、0。`settings-scroll-comparison.json` 和 `settings-scroll-raw-during-entry.json` 显示等页面就位再点击、或直接发送真实坐标点击时，滚动都保持 0、设置 Bar 的 Y 保持 197.46875px。布局测试现在先等新舞台完成入场、字体就绪、滚动为 0，再测各分区；仍保留三个原有 `< 1px` 断言，未重设滚动，也未改产品代码。

硬件入口曾因 CDP 参数读取需要 `--enable-automation`、默认 Headless Shell 内置 SwiftShader 而失败，这两次未声称进行了合格硬件计时。最终使用完整 Chromium 的无头模式及 Windows D3D11，保留实际参数、renderer、最后一个输入前帧和首个输入后帧；软件功能套件的同类数据明确不参加 40ms 硬件结论。

## 第 2 项证据

- 共享布局放在真实身份 span。网格／列表、实例／版本目录、鼠标／键盘 8 组，每组均实际开卡并返回。`drill-correct-clock-e2e.log`：11/11、1.9 分钟；`evidence-drill-correct-clock/` 下每个方向有原始 `trace.json`、`drill-geometry.json`、时钟边界和真实合成关键帧。`drill-verified-summary.json` 汇总 16 段：首投影与源的四维最大误差 **0px**、终点与实际 DOM 的最大误差 **0px**，每段至少 242 个 RAF 样本、37 个不同中间位置。
- 同一次开／回验证详情 `h1` 获得焦点且滚动归 0，返回恢复原卡焦点和真实 scrollTop。实例网格键盘示例：**1200→0→1200**，其 `back/01-239ms.jpg` 与 `back/settled.png` 已实际查看。实例删除、reload 使数据消失、新建后直进、缺卡时可见 h1、版本目录返回和当前项回顶有独立单元或浏览器回归。
- 内容 140ms 淡入只作用于非身份层，旧子树直接卸载，无 `main layoutScroll`，两端保持同色，已知坏图标的回退在库内跨子树复用。Lite 和减少动态两条真实键盘开／回无共享位移用例通过；高对比和减少透明的降级另由第 1 项浏览器和策略单测覆盖。
- 详情淡入结束后不保留 opacity 动画填充，避免继续隔离内部玻璃下拉的背景。真实 Chromium 回归 `review-glass-red.log` 先测到 `both`，`review-glass-green.log` 通过；检查的是 CSS 合成条件，原生窗口的瞬态折射仍待人工查看。

这项有一处经用户确认的方案修订：实际安装的 Motion `NodeStack.promote` 在新旧 `layoutDependency` 相等时跳过快照接续，原始同一 id 写法实测 25 个目标 RAF 全为终点。仅改为 `id:card`／`id:detail`，保留同一个共享 `layoutId`，同一位置的悬停、进度和重渲染仍不改变依赖。旧独立卡的测试曾发现强制要求外观 Provider，现从游戏库的身份上下文传入 tier，独立实例卡保持静态，既有测试未改。

采集修正留痕：当前 Chromium 的 CSSOM 没有可包装的 `transformOrigin` 原型 setter。先用空白 Chromium 验证实际 `HTMLElement.style` getter 的局部透传代理，真实样式写入后同步读首矩形；保留浏览器原始 RAF。使用新依赖键后，SwiftShader 的首投影已准确，但实测一次帧间隔 2433.3ms，未能呈现中间帧；仅新增的 8 个连续几何用例改用与原参考一致的硬件 Chromium，旧 120 项及新软件功能用例配置原样。硬件探针首轮的速度假失败来自把实际样式写入时刻／原生 RAF stamp 当成 Motion 的计算时钟。现用真实输入和实际回调计算首段保守上界，后续按实际回调进入至投影写入的时钟区间，并计入 Motion 对毫秒取整的 1ms。几何 0.1px、距离／中间位置、380/36 速度上界、焦点和滚动条件保留。早期失败及离线时钟诊断均在外部证据根，不冒称首次就过。

## 最终验证

`npm test`：56 个文件、471 项通过，`delivery-reviewed-unit.log`。`npm run build`：TypeScript 与生产打包通过，`delivery-reviewed-build.log`，保留分包大小提示。`cargo check --locked --manifest-path src-tauri/Cargo.toml`：通过，6 项既有警告，`cargo-check.log`。

完整 `npm run test:e2e -- --output=…/delivery-reviewed-results` 于 11:26（Asia/Singapore）结束，**136 通过、4 失败，28.9 分钟，退出码 1**。`delivery-reviewed-e2e.log` 和 `delivery-reviewed-evidence/` 保留完整结果。最初启动因缺 JSON import attribute 中止于注册阶段（`final-e2e.log`）；下一次跑到 53 项通过时为修正自查发现主动结束（`delivery-e2e.log`），这两次不作为完整结果。

| 完整运行失败项 | 独立复测 |
| --- | --- |
| 1050×720 设置 Bar 的 Y 跨度 | `reference-alignment.spec.ts --grep 'settings navigation height'`：两尺寸 2/2。所有分区实测设置 Bar 55px、窗口 Bar 58px、设置 Bar Y 197.46875px、scrollTop 0。`settings-alignment-verified.log` 及对应 PNG／JSON |
| 快速连点的 RAF 数不足 | `transitions.spec.ts --grep 'rapid navigation' --repeat-each=3`：3/3。原完整运行记录 6 次真实按下、最终游戏库，但 1100ms 最短区间结束时只有 2 帧。保留 7 秒总预算，等待至少 3 个实测帧；复测留存的 trace 有 36 个 RAF、34 个合成帧。`rapid-capture-verified.log` |
| 世界序曲自然完成的 PNG 回读 | `world-lattice.spec.ts --grep 'plays once on home'`：原样 1/1。完整运行中序曲本身约 2110ms，结束帧 PNG 在首次有效绘制后约 5017ms 编码完成。单独复测序曲 1845.5ms，结束帧 2731.8ms，原 3 秒／5 秒条件不变。`world-intro-verified.log` 及 `world-intro-verified-results/` |
| 游戏库启动→下载→首页找到停止按钮 | `world-lattice.spec.ts --grep 'launching from the library'`：原样 1/1。完整运行到 5 秒断言时仍在下载舞台，失败截图随后已出现首页和停止按钮。单独复测所有原断言通过。`world-cross-launch-verified.log` |

四项分别复测通过。后续仅改两处测试采样逻辑，未改生产代码；这不是一次全绿的完整运行。两条世界用例的完整运行偶发超时仍需记录，不把单独复测当成已消除。浏览器日志另有 ResizeObserver 通知警告，未扩大本轮改动范围。

测试改写范围：世界锚点旧断言按第 1 项改为保留上次有效坐标；关于页仍严格比较当前包版本；上述两个浏览器测试仅改采样时机和记录项。历史参考脚本的本机绝对路径改为相对导入和 `test-results/reference-transitions/`，维护入口仍是 `tests/e2e/transitions.spec.ts`。没有删除或跳过既有用例。

## 人工试用

在 PowerShell 中运行以下命令，使用真实 Tauri 窗口：

```powershell
Set-Location 'E:\CodeX\VoxelightLauncher'
$env:PATH = "$env:USERPROFILE\.cargo\bin;" + $env:PATH
npm run desktop:dev
```

先检查首页→游戏库→探索→设置→下载→首页、快速连续切页、点击当前导航项；然后在游戏库滚动到较后位置开卡、返回，切列表与版本目录重复，用 Tab／Enter 验证焦点回原卡。再分别试精简、系统减少动态、减少透明及高对比，确认启动／取消和窗口拖动正常。

首页构图、默认强调色、世界亮度、页面骨架、浅色主题和第 3 项后的内容按范围保持原状。现有世界偏暗、设置分区硬切、深滚动时导航后方仍可见卡片等后续问题按范围留待处理。硬件 Chromium 有第三方角色着色器 `X4713` 提示，未修改该着色器。此次完成的是 0.5.1 源码和前端生产构建，未生成新的 NSIS 安装包。真实 Tauri 手感和实际游戏完整启动由用户确认。
