# 结晶世界实施与复核记录

日期：2026-11-02。分支：`feat/crystal-world`。本文件记录实际完成情况；尚未执行的步骤明确列为待验。

## 范围与用户修订

- 按已定稿的结晶世界设计和 Task 1–8 实施。旧 Canvas 2D 方块墙及其逐格翻转、四相位要求由新设计明确替代，不保留兼容实现。
- 用户授权先提交原工作区，再创建功能分支，按任务提交；不推送、不建 PR、不绕过 hooks。
- 用户明确清理范围为测试产物和临时数据，保留测试源码、必要夹具和设计文档。
- 开始实施前已迁出 `test-results`、Vitest 缓存和 `tsbuildinfo`，再执行 317 项初始基线验证；结束清理另列实际清单。
- 用户于 2026-11-02 取消完全档的 30/60 FPS 上限。每个可用 rAF 绘制；系统静态策略、隐藏／离屏／演出暂停、运行后停绘及自动降档仍有效。
- 用户明确允许先完成 Task 6–8，Intel 原生测量移至最终人工验收。没有修改 Windows 图形设置。
- 实施期间追加四项：移除卡片多余粒子、跟随系统明暗、原版风格奔跑、统一姿态选择器。

## 任务和提交

| 任务 | 当前状态 | 提交 |
| --- | --- | --- |
| 原工作区检查点 | 已保存 | `f3c02c6` |
| Task 1 配置、迁移和真实状态推导 | 已完成 | `0de2e95` |
| Task 2 相机和导演 | 已完成 | `95dd2d8` |
| Task 3 字标、档位和按压排除 | 已完成 | `64f3508` |
| Task 4 WebGL2 实体世界 | 已完成 | `1d30504` |
| Task 5 点阵、鼠标交互、性能记录 | 已完成；Intel 经用户批准延期 | `3b6e0d3` |
| Task 6 真实启动／进度／停止与角色锚点 | 已完成 | `8919be0` |
| Task 7 开场、字体、局部 scrim、四项追加修正 | 已完成 | `228b605` |
| Task 8 对比度、资源、全量验证与清理 | 代码与自动验收完成，完整 120/120；Intel／用户视觉及真实游戏流程待人工验收 | `6782a17` |

## 四项追加反馈：根因、改动、证据

| 反馈 | Before／根因 | After／对应文件 | 证据 |
| --- | --- | --- | --- |
| 有些卡片出现多余粒子 | `LatticeFrame` 在每张卡片维护独立 64 点池与离开动画，叠加共享鼠标点群 | 删除卡片局部点池；保留共享鼠标点群、静态键盘焦点和独立选中勾选。`LatticeFrame.tsx`、`lattice.css`、`InstanceCard.tsx`、`ProjectCard.tsx`、版本目录与最近实例 | `LatticeFrame.test.tsx`、`LibraryPage.test.tsx`、`card-theme.spec.ts` 的共享点群迁移及三种静态策略；`card-theme/keyboard-selection-lite.png` |
| 背景跟随系统明暗 | 已有实时主题链，但新配置默认 dark；性能演示也曾显式选择 dark | TS／Rust 新配置及缺失设置默认 system，保留存量明确 light/dark；世界调色板实时响应界面主题。`launcher.ts`、`models.rs`、`AppearanceProvider.test.tsx` | 系统主题浏览器用例同时检查实际世界像素变化、静态档和正帧数；原生隔离设置已通过真实 UI 保存为 system |
| 奔跑姿势不像原版 | 库展示动画包含较大摆臂、身体跳动／侧摆，应用还叠加前倾 | 原创落地空手步态：相位 .6662、摆臂幅度 1、迈腿 1.4，无整体上下跳动／前倾。沿用原时钟、暂停与释放。`CharacterCanvas.tsx` | 角色单测、Node 8 项；`character-language/2026-11-02-after-run-{0,1,2,3}.png` 与 `2026-11-02-after-proof.json` |
| 姿态选择栏不符合设计语言 | 首页自己绘制深色三按钮条 | 使用共用 `Select` 的 Lens 触发器、菜单、勾选、键盘操作，仅站立／行走／奔跑。`HomeAnimationSelector.*`、`HomePage.tsx`、`home.css` | `HomeAnimationSelector.test.tsx`、`HomePage.test.tsx`；Round6 两色／两尺寸及英文长名实际命中与键盘用例；`native-visual-after/*-pose-menu.png` |

以上相对证据路径均位于 `E:/CodeX/VoxelightLauncher-worklogs/`；`card-theme/`、`native-visual-after/` 的父目录为其下 `crystal-world/`。最终冻结版菜单截图使用 `crystal-world/native-visual-release/pose-menu.png`；早期两色／尺寸图仍保留。

主题行为：新安装和缺失配置默认“跟随系统”；存量配置里明确选择的深色／浅色继续保留。需要实时跟随系统时，在“设置 → 外观 → 主题”选择“跟随系统”。人物奔跑只复现空手、落地的步态；披风继续沿用预览器，不宣称实现完整游戏实体和披风物理。

检查追加发现精简进度画布被 ResizeObserver 同尺寸赋值清空。修正为同尺寸不重置，实际尺寸改变后静态单次重绘；真实 1024/2048、50% 下载数据保持。四项受控观察器测试先失败后通过，full/lite 浏览器像素检查保留。

## 文件与需求对应

| 文件 | 对应需求 |
| --- | --- |
| `src/components/world/{types,deriveWorldState,presets,camera,worldDirector,wordmark,qualityTier,pointerTarget,renderer,shaders,worldAvailability}.ts` 及同目录测试 | Task 1–6：真实状态、相机／前沿、字标、降档、GL 通道、输入与降级 |
| `src/components/WorldScene.tsx`、`WorldScene.css`、`WorldScene.test.tsx`、`WorldScene.intro.test.tsx`；删除 `cubeGeometry.ts` | Task 4–8：替换旧墙、生命周期、全局画布、首屏演出与静态策略；低帧率实际字标补帧／真实截止守卫 |
| `src/app/App.tsx`、`src/app/controller/{types,useLauncherController,useLauncherController.test}.ts*` | Task 6–7：真实进度和角色锚点；等待实际配置，避免精简设置读取前误播 |
| `src/lib/launcher.ts`、`src-tauri/src/{models,storage}.rs`、`src/features/settings/{AppearanceSettings,SettingsPage.test,worldAvailability.test}.tsx`、双语 `settings.json` | Task 1／5：持久世界选项、兼容默认值、不可用能力说明；追加系统主题默认值 |
| `src/visual/lattice/{LatticeFrame,LatticeProgress}.tsx` 及测试、`lattice.css`；`src/features/library/{InstanceCard,LibraryPage}.tsx`、`src/features/discover/ProjectCard.tsx`、`src/features/home/RecentInstances.tsx` | 追加问题 1：删除局部粒子池，独立选中勾选与静态焦点；精简进度重绘修正 |
| `src/app/AppearanceProvider.test.tsx`、`tests/e2e/card-theme.spec.ts` | 追加问题 1–2：共享点群和静态策略、真实系统主题像素变化 |
| `src/visual/lattice/cursor.ts`、`cursor.test.ts`、`tests/e2e/reference-alignment.spec.ts` | Task 8 与追加问题 1：补足低帧率下点群的实际时间推进，保留弹簧参数；真实四边覆盖、帧时间与稳定布局证据 |
| `src/visual/character/CharacterCanvas.tsx` 及测试、`tests/unit/character-animation.test.mjs` | 追加问题 3：落地奔跑、暂停／时钟／释放与四相位证据 |
| `src/features/home/{HomeAnimationSelector.tsx,HomeAnimationSelector.css,HomeAnimationSelector.test.tsx,HomePage.tsx,HomePage.test.tsx,home.css}` | Task 7 与追加问题 4：统一姿态选择器、局部 scrim、角色与启动区分离 |
| `src/visual/overture/OvertureScene.tsx`、`motion.ts` | Task 7–8：去掉旧首页入场及废弃墙体常量，保留创建／启动成功演出 |
| `public/fonts/Doto-Black.woff2`、`licenses/fonts/Doto/OFL.txt`、`src/design/{fonts,tokens}.css`、`THIRD_PARTY_NOTICES.md` | Task 7：真实百分比点阵字体、许可；保留 MiSans 和全局底色 |
| `tests/e2e/{global-glass,round6-acceptance,round12-runtime-probe,round15-runtime,world-lattice,world-acceptance}.spec.ts`、`fixtures.ts`、`helpers/{glass-pixel-probe.mjs,glass-pixel-probe.d.mts,world-image.ts,world-contrast-probe.ts,world-intro-compositor.ts,world-resource-probe.ts}`、`playwright.config.ts` | Task 4–8：迁移旧墙断言、真实 GL／合成像素、前沿、静态、对比度、资源；单实例 SwiftShader 验证 |
| `.gitignore`、双语 `accounts.json`、其余六处页面测试夹具 | 恢复被旧宽泛忽略规则遗漏的源语言文件；同步新增 bootstrap 类型字段 |
| `docs/superpowers/{specs,plans}/2026-11-01-voxelight-crystal-world*.md`、`docs/world-performance.md`、本文 | 已批准的帧率／Intel 修订、性能原始数据、验收与提交记录 |

只读复核未发现上述四项追加实现的明确回归；运行结果仍以以下实际命令和图像证据为准。

相对检查点 `f3c02c6` 的逐文件清单在 `E:/CodeX/VoxelightLauncher-worklogs/crystal-world/final-changed-files.txt`；上表按需求分组，对照该清单可逐个复核。没有提交生成的测试数据、历史诊断产物或安装包。

## 实现证据和限制

- 世界只有一个 WebGL2 画布；地平线／山体、点阵／实体、两色主题覆盖全局页面。真实进度优先字节、其次条目，总量未知上限 15%，同次准备只增不减。
- 业务前沿使用真实单调时间，物理积分仍限制单帧 delta≤.05。两项慢帧测试先证明准备／停止拖慢，再修正，保留原浏览器时限。
- 首次进入仅消费实际首个计划帧，避免 StrictMode 的临时挂载吞掉演出；全局一次标记防止重挂重播。等待首帧也计入 2.5 秒截止，指针按下、启动、离开首页和静态策略立即结束。
- 完整浏览器检查发现持久精简设置返回前默认 full 曾先播放开场。现控制器显式记录首次真实 bootstrap 成功；此前只显示静态 CSS 底图，导航和首页继续工作，不以库是否为空推断就绪。成功后标记保持，设置 reload 不重建世界。空库、失败与后续 reload 的测试先 RED 后 GREEN；最终 lite／reduce／高对比全程无 intro，且静态像素逐值不变。
- GPU 字标结束曾残留 7,282 点；真实 GL RED→GREEN 归零，58,254 普通点的位置与速度逐值不变，GL 错误为 0。证据：`E:/CodeX/VoxelightLauncher-worklogs/task7-word-end/2026-11-02-green.json`。
- RTX 原生 600–2100ms 序列发现原 6.6 秒概念的物理过程压进 2.5 秒后，字形仍不清楚。真实 GL RED：1200ms 时字标目标 RMS 误差 26.65 世界单位，只有 2.88% 点进入半格。现仅字标点使用开场专用的错峰云→字形→地形插值，普通点保留 38／6.5 弹簧和 ABC；真实阶段时间独立于物理 delta。GREEN：60Hz／6Hz 逻辑步长的 900–1350ms 均 100% 字标点进入半格，正常 60Hz／6Hz 路径在 2.3 秒前归地；低帧率晚补关键帧也受原 2.5 秒硬截止约束。默认字标函数参数不变，渲染器开场中心改为 NDC [.28,.62]，避开 scrim、角色并保留边缘留白。
- 最终 RTX 原生合成截图已实际查看并清楚读到 VOXELIGHT；`crystal-world/native-intro-sequence-after/1200.png`、`samples.json`，以及 `native-visual-after/proof.json` 的 15 张画面记录。后者 HTML on→off 为 2440.9ms，无页面错误。普通点逐值保持和 GL 释放回归仍通过。软件渲染的 GPU PNG 与原生合成截图分别注明来源，没有将 shader 分支启用当作观感通过。
- Doto Black 静态 900 字重只用于真实百分比，保留 MiSans。OFL 和第三方声明随资源打包；没有新增 npm／Cargo 依赖。
- 基线 `f3c02c6` 至本轮，玻璃系统、`AppProviders.tsx`、全局 `--bg-base` 和依赖清单／锁文件没有功能改动。

## 实际验证记录

最终生产代码冻结后的实际命令和结果如下；历史失败也保留在表内，不以专项覆盖代替最终完整运行。

| 命令 | 当前最近结果 | 日志 |
| --- | --- | --- |
| `npx tsc -b` | 最终首帧计时探针修改后 exit 0 | `crystal-world/intro-first-draw-budget-tsc.log` |
| `npm test` | 补帧后 53 文件、428 项通过 | `crystal-world/intro-frame-2026-11-02/full-unit.txt` |
| `node tests/unit/character-animation.test.mjs` | 8/8 通过 | `crystal-world/final-character.log` |
| `node --test tests/unit/floating-nav.test.mjs` | 12/12 通过 | `crystal-world/final-nav.log` |
| `node E:/CodeX/VoxelightLauncher-worklogs/crystal-world/task8/resource-listener-regression.mjs` | 9/9 通过；事件探针生命周期的独立回归 | `crystal-world/final-listener-probe.log` |
| `node E:/CodeX/VoxelightLauncher-worklogs/crystal-world/intro-pbo-regression.mjs` | 11/11 通过；实际采集函数的状态／字节／清理回归 | `crystal-world/intro-pbo-unit-green.log` |
| `npm run license:check` | 711 包、1129 许可声明通过 | `crystal-world/final-license.log` |
| `cargo check --locked`（src-tauri，PATH 加 cargo/bin） | 通过，6 项既有 dead_code 警告 | `crystal-world/final-cargo-check.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 122 通过、0 失败、1 项既有忽略 | `crystal-world/final-cargo-test.log` |
| `npm run test:e2e -- --output=E:/CodeX/VoxelightLauncher-worklogs/crystal-world/verified-e2e-results` | 补帧前 119/120，22.8 分钟；唯一自然开场阶段采样失败 | `crystal-world/verified-e2e.log` |
| `npx playwright test tests/e2e/world-lattice.spec.ts --workers=1` | 补帧后 14/14，一次完整运行通过，3.0 分钟 | `crystal-world/intro-frame-2026-11-02/world-lattice.log` |
| `npm run test:e2e -- --output=E:/CodeX/VoxelightLauncher-worklogs/crystal-world/complete-e2e-results` | 补帧后 119/120，21 分钟；真实形成／结束帧均存在，结束 PNG 同步读回超时 | `crystal-world/complete-e2e.log` |
| `npx playwright test tests/e2e/world-lattice.spec.ts --workers=1` | 最终 PBO 探针版 14/14，一次完整运行通过，2.8 分钟 | `crystal-world/intro-pbo-world14.log` |
| `npm run test:e2e -- --output=E:/CodeX/VoxelightLauncher-worklogs/crystal-world/acceptance-e2e-results` | 119/120，21.6 分钟；结束 PBO 等待使收图跨过从导航算起的 5 秒 | `crystal-world/acceptance-e2e.log` |
| `npx playwright test tests/e2e/world-lattice.spec.ts -g "plays once on home" --workers=1` | 首帧锚点版冷进程一次 1/1 通过；两张图距首帧 1601／2134.8ms | `crystal-world/intro-first-draw-budget-cold.log` |
| `npm run test:e2e -- --output=E:/CodeX/VoxelightLauncher-worklogs/crystal-world/delivery-e2e-results` | 完整 120/120 通过，21.1 分钟，exit 0；单 worker，无 retry | `crystal-world/delivery-e2e-final.log` |
| `npm run build` | 补帧后通过；保留 500kB 分包提示 | `crystal-world/intro-frame-2026-11-02/frontend-build.log` |
| `powershell -File scripts/build.ps1` | 补帧后完整 Tauri／NSIS 通过，3 分钟 | `crystal-world/intro-frame-2026-11-02/release-build.log` |

早期 Rust 全量曾有一次 `resources::tests::interrupted_modrinth_downloads_retry_with_a_clean_temporary_file` 失败；单独及后续完整原样重跑通过。没有删除、跳过或降低该测试断言，初次失败日志保留于项目外。

浏览器检查纠正了两种无效测量前提：Lens 圆角导致 IntersectionObserver 面积比不足 1，改为完整边界、图标／文字命中与实际点击；旧玻璃探针曾采到布局前 2×2 占位，补足现有 settled／实际尺寸前提，保留所有原折射像素阈值。开场探针也纠正了 initScript 中 HTML 根节点未建立及 PNG 返回跨过演出窗的问题；没有将这些探针失败冒称生产修复。

最终 Task 7 冻结门槛：`npx playwright test tests/e2e/world-lattice.spec.ts --workers=1`，14/14 通过，2.7 分钟，`crystal-world/task7/world14-green-complete.log`。形成 PNG 按该帧实际 `uIntroTime`／`uToWord` 取样，要求 .8≤phaseTime<1.4，而非把冷驱动执行耗时当作动画阶段；截止时读取真实 HTML 状态后才编码 PNG，避免探针自己的同步工作拖延观察器时间。没有预热、重试或降低 3 秒门槛。

Task 8 首次全套双 worker 运行实际为 118/120（`full-e2e.log`），两项失败保留：共享鼠标点群某点距矩形边 13.44px；自然开场的 5 秒 PNG 收集等待超时。原样单 worker 隔离运行是 1 通过、1 失败：鼠标点群的最大距离 4.09px，符合半径 14px 的真实圆角；开场仍超时，但真实 on→off 为 2026.3ms、两张真实帧元数据和控件状态完整。没有把失败写成通过，也没有把并发下未收敛直接认定为产品几何缺陷。

随后外部计时诊断测到两次同步 `toDataURL` 分别阻塞 884.6／525.4ms，RAF predicate 调用在相同时间段中断。这次诊断本身在 3763.8ms 收集完成，不能据此声称每次必超时。探针现于实际绘制帧先登记相位／真实 HTML 状态，再发起 `toBlob` 快照和异步 PNG 数据读取；pending 去重，编码失败显式失败。单项验证 1/1 通过、on→off 1649.6ms；GPU 快照本身仍同步耗时 906.2／382.5ms，没有宣称零阻塞。原 5000ms 收集、3000ms 生命周期、相位与像素门槛全部保留。诊断证据在 `intro-collection-diagnostic/`，修正后证据在 `intro-async-collection-results/`。

本套件在配置中强制 CPU SwiftShader，每个用例都渲染完整启动器；默认 worker 改为 1，防止多个软件 GPU 实例争用同一 CPU 而污染弹簧采样。产品的帧率、弹簧、绘制预算和上述测试门槛均未因此修改。最终全量结果另记于命令表。

串行首次完整运行仍为 119/120，唯一失败变为四边覆盖距离 18.926px（要求 <8）。进一步确认 cursor 与共享 DotField 都将一次回调截为 50ms；6Hz 实际经过 166.7ms 却只推进 50ms，现有帧率测试只覆盖 30／120Hz。新增回归先 RED：6Hz 四边距离 13.057px、500ms 时与 60Hz 路径相差 687.606px。现只在 cursor 内按实际经过时间、最多 250ms、每片 ≤1/120s 更新目标和物理；每个真实 RAF 只读取一次当前目标几何。共享 DotField 的长停顿契约、140／12 弹簧参数和原 E2E 等待／阈值全部保留。

GREEN：相关 48 项通过，最终完整单测增至 409 项；原 reference 八项一次全部通过（2.3 分钟）。预断言保存的真实几何证明卡片位置变化 0px，30 点四边最近距离均 <0.002px、单点最大轮廓距离 1.174px、最小 alpha .95。target-owned 38 帧的真实 RAF 间隔 p50／p95／max 为 16.7／483.3／483.4ms，使用 nearest-rank；这是软件渲染的探针诊断，不替代显卡性能测量。证据：`cursor-catchup-unit-{red,green}.log`、`cursor-catchup-reference.log`、`cursor-catchup-reference-evidence/cursor-real-geometry.json`、`cursor-catchup-summary.json`。

随后清理后的完整运行 `verified-e2e.log` 是 119/120（22.8 分钟），点群和五项验收全部通过，只有自然开场未采到形成帧：captures／encodingErrors 都为空，HTML on→off 2112.6ms，控件可用。根代理曾只看后续通过行而误报此项通过，随后核对失败行并向用户纠正。一次独立冷进程全绘制诊断记录了 78 个真实合成 draw、240 次 phase uniform 写入，字段无缺失；聚字阶段只绘制了 0→0.9512s 两帧，然后进入归地。该次诊断本身通过，不能证明历史失败的精确时间序列，但源码及新增 RED 确认 .7→1.6s 可以跳过整个成形窗口，陈旧 rAF 时间戳也可晚于真实截止。

现仅在实际绘制边界补交遗漏的真实字标关键帧；只有 points pass 和 final composite 都实际提交、未丢失上下文时确认。成功后可补足最多 120ms 短暂停留，截止仍是最初 queue 起的 2500ms，现场 `performance.now()` 优先于陈旧 rAF 时间；director 真实时钟、普通粒子和业务进度不回拨。正常高帧率／6Hz 原路径不变，publish-only 不消费确认，隐藏／暂停／精简／按下／准备立即优先。新增单元 RED→GREEN，全部单元增至 428/53；实际世界 14/14 全过。逐 draw 的真实 phase／context／rAF 时间现随成功和失败报告保留，原 5s／3s／.8–1.4 和像素阈值未改。

一次实际 GPU 补帧验证：真实 return frame 保持 .2／fromWord，draw clone=1／toWord，7282 个字标点 100% 进入半格，RMS 2.47e-8 格；dt0 下 58254 个普通点位置与速度逐值不变。硬截止后 7282 个字标权重和速度归零，普通点仍不变；GL 错误与释放后资源均为零。已实际查看补帧 PNG，字标清楚。证据：`intro-frame-2026-11-02/{red.txt,green.txt,gpu-supplement/result.json,gpu-supplement/supplement.png}`。这是实际 GPU 提交与读回证明，不宣称操作系统必然呈现每一帧。旧 `full-tsc.txt` 因空 stdout 的 Tee 未生成，已由根代理重跑 `npx tsc -b` 并保存 `root-tsc.log`，没有把不存在的日志作证。

补帧后完整运行 `complete-e2e.log` 仍是 119/120（21 分钟），但逐帧记录确认产品补帧成功：phase=1 的真实形成帧和按时结束帧都存在。结束 PNG 的 `toBlob` 同步快照耗时 2313.9ms，数据到达 5295.5ms，撞到探针原 5000ms。最终仅替换测试采集为 PBO／fence 异步读回，保留完整 1280×720 RGBA、行序翻转、所有 GL 状态恢复与资源清理，再用 OffscreenCanvas 编码 PNG；没有裁剪、降采样、伪造帧或改时钟。

该采集函数新增外部回归先 RED 后 11/11 GREEN，覆盖非默认 READ／PACK 状态、精确字节、等待、分配／复制／编码错误及幂等释放。一次冷进程自然开场 1/1，随后完整世界专项 14/14 通过，未重试。后者结束图像在 4178.3ms 收齐，PBO 提交 0.9ms、等待 386ms、CPU 复制 525.5ms、PNG 编码 7.5ms；这些环节仍有实际耗时，未称零阻塞。原 5 秒采集、3 秒生命周期、.8–1.4 阶段和像素门槛全部保留。日志 `intro-pbo-{unit-red,unit-green,cold,world14}.log`，汇总 `intro-pbo-summary.json`。后续仅改测试探针，生产七项源码哈希与本轮安装包／原生性能记录保持一致，未无故重复原生测量。

上述“保留 5 秒”的描述适用于当时的 PBO 修改。随后完整 `acceptance-e2e.log` 仍为 119/120：真实首个开场 draw 在 878.5ms，phase=1 的形成帧在 2285ms，HTML 在 2989.2ms 已 off；结束 PBO fence 等待约 2348ms，最终 PNG 在 5519.2ms 编码完成，距实际开场首帧 4640.7ms。失败是从导航 commit 就启动的采集计时包含了首帧前的应用初始化。最终探针修正已向用户明确披露：先等待历史记录中实际 active=1 的默认帧缓冲提交和首次控件可用记录（最多 5 秒），再进入原 5 秒收图等待；另对两张图逐张断言 `encodedAt - firstActiveDraw.wallAt <= 5000`，防止驱动响应晚到暗中增加预算。观察器仍在导航前安装，冷启动全部帧记录保留，不预热、不 sleep、不等开场结束后重拍。此处确实改变了测试采集的计时起点；没有改变产品 2.5 秒截止、E2E 3 秒生命周期、.8–1.4 阶段、像素、首次控件和不重播断言。

最终完整 `delivery-e2e-final.log`：120/120、21.1 分钟、退出 0；包含本套件自然冷启动，不是合并专项结果。真实首个 active draw 为 905.1ms，形成／结束图距首帧分别 1938.2／4771.9ms，HTML on→off 2099.1ms，84/84 次默认帧缓冲 draw 的阶段字段完整，编码错误为空。根代理已实际查看该次完整运行的形成 PNG，可读到 VOXELIGHT。原图及不含 base64 的逐帧元数据：`delivery-e2e-results/world-lattice-world-intro--22bd0-d-ends-within-three-seconds/{intro-forming-real-world.png,intro-finished-real-world.png,intro-lifecycle.json}`；四组对比度、资源及开场汇总在 `delivery-summary.json`。最初启动最终运行的日志命令使用了不支持的 `Tee-Object -LiteralPath -Append` 参数组合，未实际运行套件；保留 `delivery-e2e.log`，实际成功日志是带 `-final` 的文件。

开发预览运行中 Vite 转发过 `ResizeObserver loop completed with undelivered notifications` 消息，日志完整保留、没有静默过滤；本轮未据此判定新旧来源。测试断言和原生采样记录的 pageerror／GL 错误为空，不将其泛化成全项目零警告。另有 jsdom Canvas 未实现和 Rust 6 项既有 dead_code 提示；未增加依赖来隐藏提示。

## 性能、清理与人工复核

- 原生设备及两阶段四组数据见 [world-performance.md](world-performance.md)。包含最终点群与补帧修正的 RTX 四组 rAF p95 均 4.3ms，GPU p95 0.548／0.679／1.198／1.221ms，未降档、无页面错误；`native-performance-release/active-adapter.json` 记录七个实际源码 SHA256，均已与当前文件比对一致。不能将不同运行的差值当作优化收益。
- Intel 仍为用户批准延期的人工项；不把 SwiftShader 或设备枚举当作 Intel 实测。
- 已清理四次：合计 520 个条目、137,298 个生成文件，约 43,804.42MiB（42.78GiB）迁出项目，源和目标都在 E 盘；这是移动归档，不代表释放同等磁盘空间。清单在 `E:/CodeX/VoxelightLauncher-worklogs/crystal-world/cleanup/{2026-11-02,2026-11-02-final,2026-11-02-readback,2026-11-02-delivery}/manifest.json`。后三次只补迁出 tsbuildinfo、Vitest 缓存和最后构建日志。保留全部源码／必要夹具、`releases/`、已引用历史证据、既有 UI 配置目录及当前 debug／release 构建；空诊断目录已清除。首次迁移前后 Git 源码状态一致，已复查历史报告链接、必读 round15 日志和发布目录。最后完整 E2E 在这棵清理后的项目上运行。
- 最后由用户在原生应用确认两个场景、两种材质、深浅主题、1050×720／常用尺寸／最大化，特别检查浅色和山体内容页构图，以及真实游戏完整启动／停止。当前原生演示使用项目外隔离测试账号、原创合成皮肤和不可运行实例，没有操作用户账号／存档。

最终原生补拍在 `native-visual-verified/{home,pose-menu,grounded-run}.png`，以及 `proof.json`；实际系统主题为浅色，材质点阵，皮肤 ready，无页面错误。补拍脚本初次误用了不存在的 `.vx-home__character-col` 而超时，读源码后改为 `.vx-home__char-col`，保留初次日志 `native-visual-verified-initial.log`；这次改动只在项目外采集脚本中。

上述中间补拍保留；包含最后补帧修正的同组原生截图在 `native-visual-release/`，保存了同样的实际 system／light、点阵、ready、run 和原生 API 只读状态证据。

## 本轮构建产物

没有安装、推送或发布以下产物；旧 `releases/` 保持原样。

| 文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| `src-tauri/target/release/voxelight-launcher.exe` | 21,017,088 | `99FB9F45043A0E30137EA9566C1F2DC0CABFD22CA1B3FDBF3C25EDBE6C5ECB94` |
| `src-tauri/target/release/bundle/nsis/Voxelight Launcher_0.5.0_x64-setup.exe` | 23,409,949 | `14C776DE8D5E1710BF1B956C79CFBEB0176542CF5D1D5ADE186FD75981A72534` |

## 像素与资源验收

Task 8 首轮像素／资源完整验收：`npx playwright test tests/e2e/world-acceptance.spec.ts --workers=1`，5/5 通过，5.1 分钟，`crystal-world/task8/e2e-final.log`。下表使用清理后最终冻结版本的四组实际采样；完整套件结果见命令表。

| 主题／尺寸 | 七种状态中最差正文对比度 | 像素证据目录 |
| --- | ---: | --- |
| 深色 1050×720 | 7.2058:1 | `delivery-evidence/world-acceptance/dark-1050x720/` |
| 深色 1440×1000 | 7.2058:1 | `delivery-evidence/world-acceptance/dark-1440x1000/` |
| 浅色 1050×720 | 5.1179:1 | `delivery-evidence/world-acceptance/light-1050x720/` |
| 浅色 1440×1000 | 5.1179:1 | `delivery-evidence/world-acceptance/light-1440x1000/` |

这些目录位于 `E:/CodeX/VoxelightLauncher-worklogs/crystal-world/`。七状态是开场、空闲、真实 37%／70%／95% 前沿、运行前沿和运行停绘。正文保留 4.5:1、大标题保留 3:1 原门槛；开场故意隐藏的标题／元数据仅做名义颜色检查，实际可见的角色来源说明与启动操作另行检查。开场使用真正 compositor swap 的 PNG，时间戳被两条真实 on／同主题／同布局观察夹住；后读状态真实保留 off，未延长或冻结开场，也没有用 CSS 背景色代替像素。候选帧选择最小对比度裕量，不选择容易通过的帧。

资源基线先实际开关共用菜单、等待角色 ready，以包含 Motion 首次创建的一次共享 resize 监听；Node 实际模块证明再构造 20 次不增长。清理后最终完整运行的 30 次页面往返及 10 次场景／材质切换：世界画布 1、同一上下文 id2；纹理 10、FBO 8、RBO 2、program 8、shader 0、buffer 1、VAO 2 均回到基线；在途 query 4→1、全程≤4，window.resize 5→5。没有重复释放、GL 错误或页面错误。原始记录在 `delivery-evidence/world-acceptance/resources/gpu-resources.json`。事件检查明确限定 window／document／world canvas 的持久监听；once／signal 按真实生命周期去重处理并单列，不将它冒称完整堆内存分析。
