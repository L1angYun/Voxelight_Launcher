# 第二轮修复：阶段1收尾及阶段2–4验收记录

**2026-11-07 最终验证：npm716项Vitest＋96项Node、间距基线359、TypeScript及完整Playwright304/304全部通过。** 完整套件26.735分钟、退出0、无失败／跳过／flaky／重试；世界、设计、焦点闸门均核对实际D3D11／DPR1。S4四组列剖面与四处共享条纹检查通过，最终产品26组同帧前后证据及明确范围的人工观察已完成。旧301／3、S4的5／1和2／2失败保留为历史。详见[本次S4结果](#s4-r6-progress)及[16项归属](#independent-review-results)。以上为已推送的 CVERIFY 验证，提交为 `6921a83eb198a3665e858956d3f473557623dcf5`。6921a83 的后续修订与验证见[独立小节](#follow-ups-6921a83)。

日期：2026-11-05（Asia/Singapore）。下文先保留已推送的阶段1记录，再补充复核后的收尾说明；新的收尾与阶段2–4验证结果按实际执行补录。

**已推送的阶段1记录：五组原生闸门5/5通过，npm test与TypeScript通过。修复提交推送并确认远端后，完成五场景各十次候选重复（50次，250对正式截图），M1/M2逐次门槛和S1重复性均通过，无偶发失败。此记录截止时未开始阶段2–4；用户随后独立复跑并认可阶段1。**

初始文档提交为 `d6916d535a5e65a22d3b390f5e82d5943be30161`。M1/M2/S1代码、测试、用户清单修订和本报告作为一个修复提交：`2f17cdb14e5d6bec41cd0a846146f02436cf30a5`。普通推送完成后，`git ls-remote origin`确认只有HEAD和refs/heads/main、均指向该提交。其后才开始候选重复测量；本次补录仅更新报告和基线JSON，不拆分或改写修复提交。未改版本、依赖、Git身份或添加AI署名，未构建安装包。

## 阶段1收尾：复核后的解释与证据边界

清单M1/M2的这几次修订由审查方代用户决定，用户在对话中转达并确认执行。此前报告中的“用户已批准”表示此授权链，不表示实施者自行修改验收口径。本次仍保留全部历史失败记录和原始数据。

### 地形呼吸与长期分布

空闲态`uT`持续推进，地形包含慢漂移和约12.5秒周期的起伏。岛面倾斜及高度变化会改变脚下ROI中顶面、侧面和柱缝的比例。下面数据来自审查方探测文件的154个离散相位（0–600、步长4，另含9.7/21.7/55.7）；本次只复算原文件，没有将它写成新运行的浏览器实测。复核原始文件发现，清单所引约33–98及51–100对应探测脚本额外隐藏角色地板的`hiddenFloor`支路；当前M2使用的仅隐藏角色canvas支路为`hiddenChar`，两组不能混写，因此同时列出。

| 审查方相位扫描及隐藏对象 | ROI均值范围 | ROI均值中位数 | 有效率低于85%的相位占比 |
| --- | ---: | ---: | ---: |
| 深色地平线1920，仅canvas（M2口径） | 35.9101–101.1900 | 65.6238 | 69.4805% |
| 深色地平线1280，仅canvas（M2口径） | 53.8872–101.7814 | 65.4450 | 72.7273% |
| 深色地平线1920，canvas＋地板（清单所引诊断） | 33.1625–97.8001 | 60.3844 | 71.4286% |
| 深色地平线1280，canvas＋地板（清单所引诊断） | 51.1542–100.0250 | 62.6690 | 73.3766% |

此项已按用户确认修正：M2长期统计采用仅隐藏角色canvas的数据，1920约36–101、中位66，1280约54–102、中位65；额外隐藏地板的数据保留为诊断记录。原差异是审查方说明文字的口径笔误，不涉及门槛、验收区域或产品参数。`reviewer-terrain-drift/sampling-scope-proof.json`逐项核对两种宽度各154个相位：`terrain-correlation.json`的roi均值全部精确匹配`hiddenFloor`，与`hiddenChar`没有一项精确相同。复算脚本与原始文件同存于worklogs。

这是离散相位分布，不能把该比例直接当作连续运行时间占比。审查方人工观察为各相位角色仍站在岛上，未见白斑；该观察与数值记录分开。启动附近`uT≈8–10`接近扫描中的最亮点，所以现有启动闸门用于约束过曝较重的时刻，均值下限90不是长期亮度保证。新增测试按清单仅在测试中包装`uniform1f`，固定9.7、188、288、588；每相位只判p95与两项纯白上限，均值和有效率只记录。新增测试的实际结果见下方收尾验证，长期分布说明已按用户确认修正。

审查方来源为`C:/Users/LiuYu/AppData/Local/Temp/claude/c316e987faaa6d11/b19ef28c-172d-46e4-9107-7bb458e1b697/scratchpad/drift/out/terrain-correlation.json`及同目录扫描原始记录；可复核副本见本次worklogs收尾目录中的`reviewer-terrain-drift/`。

### 五帧下降、山体与锚点口径

深色1920在联合等待判据成立后，正式五帧均值仍从97.0644依次降至95.5334、93.7174、92.1468、88.9178。闸门采用五帧中位数93.7174，因此这一组通过；最后一帧低于90的事实仍保留。相邻两次差值小于1只限定开始采样的局部时刻，不能证明后续相位或整段空闲过程没有变化。

山体的复核记录为修复前岛面ROI均值约90.5，修复后约48.6（本次正式五帧中位数48.6232）。这个ROI落在半径5岛的前排侧面和柱缝，修复后的ROI有效率中位数76.7608%；不能将亮度下降隐去，也不能把它当作岛顶均匀亮度。按审查方代用户修订的口径，这些岛面数字仅记录，数值门槛只判下半区纯白。本次该项为0%。

人工图为`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/revision4-result/dark-massif-1280-manual.png`。既有人工检查观察到受光面暖色及棱角仍清晰，背光面和柱缝保持暗部，没有整座山覆盖灰雾的观感；用户已认可该图。这是人工观察，不并入数值通过项。

`git show d5e31ad:src/features/home/HomePage.tsx`确认旧版`data-world-anchor`挂在`.vx-home__char-col`，并非`.vx-home__feet`。历史采集使用旧版真实锚点，当前版使用feet底边中点；两个版本的DOM锚点不能描述为同一个元素。既定历史比较保留此差异，原始数据可追溯，未人为移动旧版锚点来对齐新版本。

“改相机at.y后无需改ROI”的一般保证列为未验证：收尾时实际将at.y改回18.5，原camera测试仍11/11通过，反证日志为`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/closeout/camera-circular-mutation-still-green.log`。因此删除了三条循环意图断言，未将它们改写为仅锁定常量的伪几何证明。DOM锚点会重新读取，只能证明坐标跟随行为；任意相机变化后是否仍覆盖实际岛面，需要重新测量，不能从剩余camera单测推出。

### 收尾实际验证（口径说明已修正）

真GPU八个固定相位用例与原五组闸门合计13/13通过（2.4分钟）。每相位的五帧均逐帧通过p95≤200、岛内纯白<0.5%、下半区纯白<0.1%；没有对均值或有效率新增下限。每个用例断言实际提交的data-world-scene和html[data-theme]。

| 宽度 | uT | 均值中位数（记录） | 有效率中位数%（记录） | 五帧最大p95 | 最大岛内纯白% | 最大下半区纯白% | 等待ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1280 | 9.7 | 98.5213 | 98.1608 | 166.3333 | 0.000000 | 0.005159 | 2940.0 |
| 1280 | 188 | 57.3550 | 77.6824 | 161.3333 | 0.070736 | 0.007143 | 2894.8 |
| 1280 | 288 | 61.7836 | 67.0510 | 166.6667 | 0.010264 | 0.030159 | 2837.6 |
| 1280 | 588 | 75.5568 | 80.5686 | 168.6667 | 0.000000 | 0.005952 | 2874.8 |
| 1920 | 9.7 | 95.2608 | 97.5098 | 166.0000 | 0.016928 | 0.002739 | 2805.4 |
| 1920 | 188 | 43.6518 | 64.0431 | 155.0000 | 0.033252 | 0.003551 | 2756.3 |
| 1920 | 288 | 52.7620 | 65.0000 | 167.3333 | 0.000000 | 0.006189 | 2767.0 |
| 1920 | 588 | 101.1906 | 93.2157 | 174.6667 | 0.000000 | 0.002029 | 2762.8 |

自动验证：`npm test`为625项Vitest＋42项Node通过，实际退出0；`npx tsc -b`退出0。片元反照率回1.2、删除主题高光肩部混合的实际变异各使新增测试失败，恢复原字节后通过。旧camera循环断言在at.y=18.5下仍11/11通过，已删除三条循环断言；相机修改后的真实ROI覆盖仍未验证。

基线从3,887,799字节缩至4,394字节，各限值精确保持原值。新加载器按原公式重新推导并比对限值；完整原始数据与旧单帧基线已归档。未在版本化JSON中保留GPU字符串、绝对路径或逐帧数据。

本次证据根：`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/closeout`。`acceptance.json`包含八相位和五闸门的全部数值、原始文件路径；`gpu.log`、`npm-test-final.log`、`tsc-final.log`记录实际命令结果。截图仍为正常／隐藏角色两份，详见以下对应目录。

- 1280／uT=9.7：`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-dd257--retains-highlight-headroom\terrain-phase\normal-2.png`；采样图`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-dd257--retains-highlight-headroom\terrain-phase\island-2.png`。
- 1280／uT=188：`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-980cd--retains-highlight-headroom\terrain-phase\normal-2.png`；采样图`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-980cd--retains-highlight-headroom\terrain-phase\island-2.png`。
- 1280／uT=288：`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-6ef7a--retains-highlight-headroom\terrain-phase\normal-2.png`；采样图`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-6ef7a--retains-highlight-headroom\terrain-phase\island-2.png`。
- 1280／uT=588：`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-13a06--retains-highlight-headroom\terrain-phase\normal-2.png`；采样图`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-13a06--retains-highlight-headroom\terrain-phase\island-2.png`。
- 1920／uT=9.7：`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-186c1--retains-highlight-headroom\terrain-phase\normal-2.png`；采样图`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-186c1--retains-highlight-headroom\terrain-phase\island-2.png`。
- 1920／uT=188：`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-1f13a--retains-highlight-headroom\terrain-phase\normal-2.png`；采样图`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-1f13a--retains-highlight-headroom\terrain-phase\island-2.png`。
- 1920／uT=288：`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-db768--retains-highlight-headroom\terrain-phase\normal-2.png`；采样图`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-db768--retains-highlight-headroom\terrain-phase\island-2.png`。
- 1920／uT=588：`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-90ba2--retains-highlight-headroom\terrain-phase\normal-2.png`；采样图`E:\CodeX\VoxelightLauncher-worklogs\review-round2\2026-11-05\closeout\gpu-results\world-acceptance-terrain-b-90ba2--retains-highlight-headroom\terrain-phase\island-2.png`。

阶段1收尾已单独提交并推送：`e0c0fdf47271ee8684b40ab67cbc4caf21b2db28`，推送后`git ls-remote origin`确认远端只有main。说明文字笔误已按用户确认修正，后续只有门槛、验收区域或产品参数与实际画面冲突才暂停。此节点尚未执行完整Playwright、Cargo、Intel、真实Tauri/WebView2及浅色键盘巡检，未构建安装包；阶段2已完成的浅色巡检见下节。

## 阶段2：无障碍与交互缺陷

阶段2提交为`99b44995c799d39806e6601de7ad790ec67a999e`，已推送并用`git ls-remote origin`确认远端只有main。证据根为`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage2/`；以下数值与测试均已实际运行，人工检查单列。

| 清单 | 实现及实际结果 | 测试与证据 |
| --- | --- | --- |
| M3 | Toast的key仅含host.id与toast.id，同id替换保留节点及关闭按钮焦点；revision仍重置通知计时。full、lite、减少动态三种模式中原关闭按钮保持activeElement，替换后仍能关闭一次 | `ToastProvider.test.tsx`：`keeps the focused close button when the launcher's notification is replaced in $mode`；与首页焦点用例共52项通过。`focus-toast-red.log`记录修复前失败，`focus-toast-green.log`记录通过 |
| M4 | 创建表单使用单个loader-group，收起时分段控件底至实例名称标签为20px；full/lite/reduced均一致。展开焦点环外伸5px，slot内容与dialog body左右各保留6px，全部裁切祖先的净空均不小于5px | `field-focus.spec.ts`三种create用例；`fields-complete/field-focus-create-*/field-focus.json`；完整字段及既有library回归10/10通过，`fields-complete.log` |
| R2-01 | 新增指示色并接入全局焦点、输入边框、下拉、Lattice焦点框、进度实点及光标。默认浅色`#5a9205`（90,146,5）对三种指定表面对比为3.350953/3.592623/3.064844；默认和三种高亮强调色全部≥3。深色indicator等于base，强调绿本身未改。三模式真实Tab巡检共六处轮廓均为2px solid且focus-visible=true。英文1050下载页已完成点列462个实测核心像素的最低对比为3.592623 | `indicator-values.json`、`indicator-red.log`、`indicator-green.log`（69项通过）；`accessibility-focus.spec.ts`，`light-keyboard/*/keyboard-focus.json`与`completed-columns-contrast.json` |
| R2-02 | 启动、取消、停止保留可聚焦按钮，通过aria-disabled与点击守卫阻止忙碌操作；状态切换只接续控制台内焦点。真实键盘从启动进入取消，再到停止，结束返回启动。两次Enter相隔50.4ms，第二次落在aria-disabled=true的取消按钮，取消命令调用0次。单测另覆盖249/250ms边界、重新进入准备、取消后回焦及不抢外部焦点 | `HomePage.test.tsx`三模式`hands keyboard focus through launch states…`等；`light-keyboard/accessibility-focus-R2-02--c008b--idle-with-the-cancel-guard/cancel-guard.json`及三个状态截图 |
| R2-03 | 去掉游戏库输入框压制外层轮廓的规则，游戏库与探索的搜索容器使用同一2px轮廓。减少动态时两者均为rgb(90,146,5)，强制颜色时均采用系统Highlight，实测rgb(55,0,110) | `field-focus.spec.ts`的search reduced/forced；`fields-complete/field-focus-search-*/search-focus.json`和两页对应截图 |

M4实施调整有实际几何依据：按原建议给独立slot加−20px margin会被grid自动轨道抵消，收起间距仍为40px。最终将加载器与其上方字段放入同一个loader-group，slot的margin从0过渡至20px，保持展开/收起动画，Lite和减少动态立即切换。第一次只给slot内容留6px净空后，人工截图发现dialog body仍裁掉左右焦点环；新增裁切祖先断言先失败（`body-clip-red.log`），再给dialog body同样留出6px。最终三模式间距均20px、焦点环四边净空达标，没有放宽20±2px或5px环外伸的验收值。

### 阶段2自动验证

| 命令 | 实际结果 | 日志 |
| --- | --- | --- |
| `npm test` | 65文件、641项Vitest＋42项Node通过 | `stage2/npm-test.log` |
| `npx tsc -b` | 最终类型检查退出0 | `stage2/tsc-final.log` |
| `npx playwright test tests/e2e/accessibility-focus.spec.ts --output=…/stage2/light-keyboard` | 5/5通过，22.0秒；记录真实D3D11渲染器、DPR1及浅色主题 | `stage2/light-keyboard.log` |
| `npx playwright test tests/e2e/field-focus.spec.ts tests/e2e/library-review.spec.ts --output=…/stage2/fields-complete` | 最终10/10通过，29.5秒；包含新增字段/搜索检查与既有展开动画回归 | `stage2/fields-complete.log` |

全量单测在dialog body最后一项仅CSS净空修正之前运行；最终CSS通过上述10项浏览器回归和最终tsc检查。未将这15项浏览器用例描述为完整Playwright套件，也未运行Cargo或安装包构建。

### 阶段2截图与人工检查

以下路径均位于上述stage2证据根。浅色full/lite/reduced的首页与游戏库截图分别保存在`light-keyboard/accessibility-focus-R2-01--{a9304,91a03,ec142}-…/`，文件为`focus-home-light-{full,lite,reduced}.png`和`focus-library-light-{full,lite,reduced}.png`；各目录`keyboard-focus.json`保留真实Tab路径及轮廓数值。

- **人工已查看：** `light-keyboard/accessibility-focus-R2-01--a9304-ines-remain-visible-in-full/focus-library-light-full.png`，搜索容器轮廓清晰。
- **人工已查看：** `fields-complete/field-focus-create-full-co-0e17b-panded-focus-is-not-clipped/create-loader-keyboard-focus.png`，新图中加载器绿色焦点轮廓左右完整，四边可见。
- 下载像素证据：`light-keyboard/accessibility-focus-R2-01--b8352--have-three-to-one-contrast/en-light-1050-downloads.png`和`downloads-under-progress.png`；检查的是进度50%任务中已完成的前40%实点列，没有把气态未完成点或抗锯齿边缘算成实体指示色。
- 键盘状态图：`light-keyboard/accessibility-focus-R2-02--c008b--idle-with-the-cancel-guard/keyboard-{preparing,running,ended}-light.png`。
- 字段与搜索图：`fields-complete/field-focus-create-*/create-{collapsed,loader-keyboard-focus}.png`，以及`field-focus-search-{reduced,forced}-*/{library,discover}-search-focus.png`。

人工结论仅覆盖上面明确列出的两张图；其它图已保存并有对应自动检查，不冒充逐张人工签字。真实Tauri/WebView2、Intel和读屏实际播报仍未验证。阶段3、4尚未纳入本节结论。

## 阶段3：设计语言收口

下表R2-04–07属于同一阶段3提交，`3f674c3d360308a00dc7bd18d4e674b4fb2f3a5f`已推送，并用`git ls-remote origin`确认远端只有main。证据根为`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage3/`。当前源码已冻结，42张改前图与42张改后图均采集完成，采集记录中页面错误为0、源码前后校验一致；30项跨阶段回归已通过，另补两项命令栏用例2/2通过。audit-comparison.json/.md确认42页h1的x/y/宽/高精确零差异，按钮与表面节点无新增或缺失，按钮填充色无变化；表面填充与圆角变化全部对应R2-04–07，未分类差异为0。

| 清单 | 实现与已完成的自动验证 | 主要证据 |
| --- | --- | --- |
| R2-04 | 行、侧栏和标签使用selection-fill与hairline，卡片仍用LatticeFrame点框。实例卡片的aria-current移动到可聚焦按钮，最近实例使用aria-current；当前账号可Tab到达且重复激活不发起切换。真实键盘用例验证库卡片当前态、当前账号可访问名称和焦点，Enter前后select_account调用数不增加 | `design-first/design-consistency-R2-04-c-56516-r-state-on-keyboard-targets/current-semantics.json`及`library-current-keyboard.png`、`account-current-keyboard.png`；`tsx-red.log`、`tsx-green.log`、`managed-current-red.log`、`managed-layer-green.log` |
| R2-05 | 按钮统一为sm/md/lg的32/38/56px、999px药丸及14/16/18px图标；页面级尺寸覆盖删除。跨两主题、三宽度、七页的设计测试通过按钮与图标几何断言。游戏库D4仅按已定决策将操作按钮的半径改验999px，字段和视图切换仍为12px、38px高 | `design-red.log`中的修复前药丸/图标失败；`design-first/design-consistency-R2-05-l-369fe--38px-pills-with-16px-icons/library-primary-controls.json`及PNG；六组`design-audit.json` |
| R2-06 | 角色预览、下载空态及详情阅读面使用panel/card与hairline；命令栏去掉额外填充和描边，探索搜索去掉嵌套panel，浅色card为白色。真实页面角落像素：浅色页面239.6667、面板247、卡片255，层级差7.3333及8均≥4；角色预览深色16>页面8.6667，浅色255>页面239.6667。面板/卡片6或12px圆角与1px hairline断言通过 | `reading-surfaces-v2/reading-surfaces.json`、六张原图及各页JSON；`after/`42页审计。差分摘要见audit-comparison.json/.md；阅读面变化全部对应计划，字段控件与世界背景单独记录，不当作panel/card填充 |
| R2-07 | 阶段3迁移了五个层，但引入实际层序倒置：tokens先注册overrides，导致其落在features之前；导航features中的blur还压过primitives折射。阶段3的几何测试通过不能证明降级材料或折射无回归。两处产品问题由后续C4 `8a9ed45`修复：最早tokens入口声明完整层序、删除导航重复blur；仓库`interface-quality.spec.ts`读取实际CSSOM层序并检查真实条纹位移。详情720px及几何数据仍作为历史有效证据保留 | 阶段3原图与几何：`design-first/design-consistency-R2-07-d-ee5b4-eps-its-720px-width-at-1440/discover-details-geometry.json`、`forced-geometry/*/degraded-geometry.json`；实际修复验证：`stage4/revision5-full/interface-quality-*`。外部`check-entry-css-order.mjs`与`check-css-contract.mjs`没有接入npm test，不作为仓库持续守护；实际层序与折射由上述浏览器回归守护 |

### 阶段3测量说明与已验证数值

强制颜色模式启用系统滚动条后，阅读面整体屏幕x增加4px，宽度仍为1280px，标题相对阅读面左边的内缩仍为32px，各内容页标题x仍相同。最初用“与普通模式绝对x不变”代替清单所需的页面间对齐，导致12项设计测试中11项通过、1项失败。修正检查对象为同一阅读面的内部偏移和宽度，保留原失败图及JSON，再运行该项通过（7.1秒）。此次是测量坐标参照修正，没有改变产品布局、按钮要求或对齐公差。

阅读面像素探针第一版将覆盖整屏但透明的玻璃管理canvas当作前景遮挡，导致页面gutter无法取样。第二版按实际玻璃surface边界检查遮挡；固定角落候选、采样区域、阈值和产品均未修改，第一版失败数据保留在`reading-surfaces/`。第二版所有样本有效，数值检查全部通过，前后源码hash一致。探针只读真实DOM和截图，没有隐藏层、重涂底色或制作测试色板。

| 像素项目（1440×930） | 实测RGB平均亮度中位数 | 差值／要求 |
| --- | ---: | --- |
| 浅色设置页gutter → settings panel | 239.6667 → 247.0000 | +7.3333，要求≥4 |
| 浅色settings panel → library card | 247.0000 → 255.0000 | +8.0000，要求≥4 |
| 浅色settings panel → character preview card | 247.0000 → 255.0000 | +8.0000，要求≥4 |
| 深色账号页gutter → character preview card | 8.6667 → 16.0000 | +7.3333，预览比页面亮 |
| 浅色账号页gutter → character preview card | 239.6667 → 255.0000 | +15.3333，预览比页面亮 |

以上是6×6无遮挡角落patch的实际像素中位数，准确DOM、候选拒绝原因、坐标及全部RGB值保存在`reading-surfaces-v2/*.json`。card与panel的层级比较取自同主题同窗口的不同真实页面，该局限保留在结果中。截图为`light-1440-{library,settings,accounts}.png`和`dark-1440-{library,settings,accounts}.png`。

### 阶段3测试状态与人工检查边界

- `npm test`最终654项Vitest＋42项Node通过，见`npm-test-final.log`；`npx tsc -b`最终退出0，见`tsc-final.log`。
- `design-consistency.spec.ts`首次12项中11项通过，仅强制颜色的绝对屏幕x比较失败；该项修正坐标参照后单独通过。原日志和截图均保留，不把首次运行写成12/12。
- jsdom解析但未将CSS层应用到computed style，受此影响的10条既有断言没有删除或放宽；`isolatedStylesheetCss`只在组件单测中展开传入组件CSS的layer包装，保留原断言。生产级联仍由真实浏览器测试与42页改前/改后审计验证，未用此辅助函数模拟整套生产级联。
- 最终跨阶段回归30/30通过，3.2分钟，见`regression.log`：12项design、5项accessibility、5项field-focus、5组M1/M2以及3项library D3。旧D4用例已按新语义改名，原grep未包含它们，两项library commandbar另跑2/2通过（9.0秒，toolbar-final-v2.log）；没有把未被筛选的用例算作通过。完整Playwright、Cargo和安装包构建未据此宣称完成。
- **人工已查看：** `after/zh-light-1440-accounts.png`，白色角色预览卡与页面形成明确层级；`after/zh-dark-1440-library.png`，操作按钮为药丸、卡片点框仍保留，未见横向溢出。人工结论仅覆盖这两张图，未遍历全部角色预览模式，也不把42张自动截图当作全部人工通过。阶段4的世界与玻璃诊断尚未开始。

## 阶段4：第五次修订验证完成，已提交并推送

本节全部编号归属同一个 **C4：`8a9ed455ccbaf48df01ab2a69d4693a82282258a`**，已普通推送；`git ls-remote origin`确认只有HEAD及refs/heads/main且均为该SHA，回执为`stage4/commit-receipt.json`。第三遍完整验收出现1920动态等待超时，当时按用户规则停止；用户确认M2第五次修订后恢复并完成新验证。本段SHA由阶段2–3复核提交补录，不改写C4或历史结果。

证据根为`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/`。第四次及后续第五次清单修订由审查方代用户决定，用户确认后执行。以下区分已完成的专项数值／行为检查、人工检查与第五次修订后的最终验证；失败批次按发生时的状态保留。R2-29按要求不做。版本仍为0.6.0，未新增依赖、构建安装包或改变全局背景。

**当前执行状态：C4已提交、推送并确认远端。**第五次修订后的新完整Playwright为252通过、0失败、0跳过、0flaky，运行错误列表为空；新的npm为67文件674项Vitest＋77项Node通过，TypeScript由主流程确认退出0、日志无错误输出。六项原生专项、30项聚焦Node及三种S2键盘关闭检查另有独立记录。完整世界数值已汇总，主流程已单独查看最终三张固定9.7正常图，人工范围仅限这三张；C4推送回执见上文。下文三遍历史完整252项的248通过／4失败、251通过／1失败、251通过／1失败均保留，均0跳过、0flaky。第三遍唯一失败仍是旧稳定判据下深色地平线1920动态M1/M2等待20017.1ms超时，未生成正式五帧或numeric-acceptance；此次新运行不改写该次失败。

### M2第五次修订：动态结晶收敛与恢复后的专项记录

动态采样保留覆盖率差严格小于0.3个百分点，将隐藏ROI均值差小于1替换为结晶uniform收敛：同一世界WebGL上下文代次、同一有效voxel程序的`uLat`、`uCry`、`uIsland`，在两次实际读取之间的绝对差分别严格小于`1e-3`。实际uniform读取间隔及隐藏截图窗口间隔都必须至少400ms；要求世界提交帧和各uniform写入序号继续推进，缺失、非有限值、旧写入或混合程序／上下文不能作为收敛证据。20秒共同deadline、超时失败及原始失败工件保留。`uT`持续驱动地形呼吸，只记录，不判稳定；动态均值也只记录。固定相位仍按覆盖率差小于0.3个百分点、隐藏ROI均值差小于1等待，固定`uT=9.7`的均值90–150及其余既定数值门槛不变。

这次修改限于测试采集器、uniform探针及回归测试，没有修改产品renderer、shader、worldDirector、亮度参数、相机、ROI或历史基线。探针只在测试初始化时包装uniform位置／写入生命周期，读取时通过`getUniform`取得实际GPU值；固定时间拦截与观察器的两种安装顺序均有回归。等待及正式样本保存`uniforms`，包含`atMs`、`worldFrames`、`contextId`、`voxelProgramId`、`terrainProgramId`、四个实际浮点值和`writes`序号；等待样本另保留正常／隐藏截图前后的`frameCheckpoints`，没有把配置目标值或缺失值当成实测零值。

`revision5-world-gates.log`记录六项原生专项6/6通过（1.1分钟）：深色地平线1050／1280／1920各一项固定9.7和一项动态。六份`settling.json`均记录NVIDIA GeForce RTX 5080 Laptop GPU、Direct3D11、DPR=1。以下均为本次原始JSON读数；动态均值列仅记录，不恢复为90–150门槛。

| 深色地平线 | 等待模式 | 实际等待ms | 正式五帧均值中位数 | 数值结果 |
| --- | --- | ---: | ---: | --- |
| 1050×720 | 固定uT=9.7 | 2679.8 | 103.378767 | startupMean及allNumericPass=true |
| 1280×720 | 固定uT=9.7 | 2866.4 | 99.360465 | startupMean及allNumericPass=true |
| 1920×1080 | 固定uT=9.7 | 2753.7 | 92.053544 | startupMean及allNumericPass=true |
| 1050×720 | 动态 | 6957.5 | 103.155549（记录） | allAGatesPass=true |
| 1280×720 | 动态 | 4693.6 | 100.900381（记录） | allAGatesPass=true |
| 1920×1080 | 动态 | 4986.8 | 92.090492（记录） | allAGatesPass=true |

三个动态接受pair的实际读取间隔分别为624.9／641.7／759.9ms，覆盖率差0.084755／0.045238／0.026684pp，`uLat`与`uCry`差均为0，`uIsland`差分别为0.000002861／0.000560760／0.000511169；三组均为相同contextId=1、voxelProgramId=10、terrainProgramId=7且写入序号全部增加。1920该pair的ROI均值仍变化2.890691、`uT`变化0.762500，说明接受条件是结晶收敛，而非将继续呼吸的均值或时钟误写为稳定。原图与逐次值在`revision5-world-gates/*/{anchored-island,terrain-phase}/settling.json`、`measurements.json`，正式数值在各例`numeric-acceptance.json`或`terrain-breathing.json`。本次六项没有新增人工视觉签字，也不替代新的完整套件。

`revision5-node-green.log`实际记录15项稳定等待＋15项uniform探针，共30项通过、0失败、0跳过；包含严格边界、缺失／旧写入／混合代次、删除／重链接／恢复上下文、固定时间双顺序、采集成本间隔及共同20秒deadline。`revision5-stability-red.log`与`revision5-stability-green.log`保留RED→GREEN；这些Node用例不代替真实GPU测量。

S2另外实跑了指针打开后分别用真实Tab、Enter、Escape关闭的三组检查：3/3通过，三组blankFrames均为0，D3D11／DPR=1、可信键盘事件、实际rAF、最终标题／菜单及焦点检查均通过，页面错误为0。`revision5-s2-keyboard/summary.json`的sourceBefore与sourceAfter均为`83c71de0a3803a7217d65c10af092a63f65334de03403fda94d938eb6567711b`，sourceUnchanged=true；各组原始帧在`Tab.json`、`Enter.json`、`Escape.json`，执行记录为`revision5-s2-keyboard.log`。当前S2实现通过这三种关闭方式，无需追加S2产品修复；结论只覆盖本次测试范围。

### 第五次修订完整套件：最终世界数值与独立人工记录

以下来自完整`revision5-full/`，与上面的六项专项批次分别保留。[final-world-acceptance.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/final-world-acceptance.json)及[同名逐帧汇总](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/final-world-acceptance.md)覆盖12个固定相位、5组动态和4组S5；脚本只汇总数值，没有自动判定manual通过。固定相位的p95、岛内／下半区纯白上限及既定动态闸门均通过。

| 最终固定uT=9.7 | 五帧均值中位数 | 稳定等待ms |
| --- | ---: | ---: |
| 深色1050×720 | 103.378671 | 2678.8 |
| 深色1280×720 | 99.357758 | 2795.8 |
| 深色1920×1080 | 92.053506 | 2731.4 |

最终五组动态接受pair的真实GPU读数如下；均值只记录，不能把固定启动均值门槛套回动态样本。完整写入序号、上下文／程序代次、截图前后读数及正式五帧保存在[revision5-uniform-summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/revision5-uniform-summary.json)与各例原始`settling.json`／`measurements.json`。

| 动态场景 | 等待ms | 实际读数间隔ms | ΔuLat | ΔuCry | ΔuIsland | 前→后uT | 前→后世界帧数 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| dark/horizon/1050 | 6884.9 | 593.0 | 0 | 0 | 0.000002861 | 8.407600→9.003400 | 1981→2122 |
| dark/horizon/1280 | 4770.2 | 624.8 | 0 | 0 | 0.000445366 | 6.274400→6.899400 | 1466→1614 |
| dark/horizon/1920 | 4924.8 | 745.8 | 0 | 0 | 0.000554085 | 6.216100→6.962000 | 1425→1599 |
| dark/massif/1280 | 4438.9 | 691.5 | 0 | 0 | 0.000722408 | 5.857900→6.549600 | 1365→1530 |
| light/horizon/1280 | 4767.6 | 632.1 | 0 | 0 | 0.000464439 | 6.257800→6.886900 | 1468→1617 |

三项结晶控制在五组中均达到严格差值门槛，`uT`继续变化。实际S5预览来源的intro／idle对比度为：dark1050为8.789692／8.680488，dark1280为8.695501／9.040192，light1050为5.587494／5.114514，light1280为5.849832／5.839109，均≥4.5。原始世界记录保留D3D11、DPR=1、场景、锚点及逐次时间／帧数；外观测试在采样前后断言实际html主题，但runtime文件未独立保存主题值，此来源限制保留，不将fixture值当成另一次主题采集。

**独立人工记录：**主流程实际查看最终完整套件固定9.7的[1050正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/revision5-full/world-acceptance-terrain-b-3091c--retains-highlight-headroom/terrain-phase/normal-2.png)、[1280正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/revision5-full/world-acceptance-terrain-b-dd257--retains-highlight-headroom/terrain-phase/normal-2.png)、[1920正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/revision5-full/world-acceptance-terrain-b-186c1--retains-highlight-headroom/terrain-phase/normal-2.png)：脚在岛上，控制台没有遮挡人物。该人工结论仅覆盖这三张正常图，不扩写为全部12相位／动态／S5图片已人工逐张签字，也不改写自动JSON中的manual占位状态。

### 阶段4按编号：数值与行为检查

下表每条均归属已提交并推送的 C4 `8a9ed455ccbaf48df01ab2a69d4693a82282258a`。行内“通过”指列出的专项检查；C4 第五次修订后的完整结果为 252/252，通过及推送回执见本节开头。JSON 所在目录保留原始截图；单测不当作视觉或读屏验证。

| 编号 | 已实际验证／实现 | 证据 | 未验证／范围说明 |
| --- | --- | --- | --- |
| R2-08 | Segmented自动激活与设备码期间手动激活通过；额外修复当前Microsoft标签重复Enter/Space误取消会话。单位回归RED1→24/24；native ArrowRight→ArrowLeft→Enter/Space仍cancel=0，Offline激活cancel=1。 | [review-findings-v2.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/review-findings-v2.log)；[login-same-tab-green.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/login-same-tab-green.log) | 未用真实Microsoft账号登录；使用确定的本地设备码接口夹具。 |
| R2-09 | 四页forced-colors通过。7个可见字段wrapper均1px solid CanvasText；5个实际箭头分别有8个精确CanvasText黑色核心像素；Downloads没有下拉箭头，记录不适用。brand/nav也检查CanvasText/Highlight。 | [forced-fields.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-09-fo-32286-ored-chevrons-on-four-pages/forced-fields.json)；[interface-evidence-offline.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-evidence-offline.json) | 字段1px为computed校验；箭头像素独立解码已复核。没有把computed边框厚度冒充实际像素厚度。 |
| R2-10 | placeholder深／浅最亮已测输入背景最差对比分别5.194163 / 5.392209:1，均≥4.5；Lens最终边界opacity=65%，九行各行最高对比的最小值2.609375:1≥2.5。65%指不透明度，不是描边宽度；宽度未改。 | [summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/nav-placeholder-first/summary.json)；[light-selector-boundary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/r2-10-opacity-65/review-fixes-R2-10-light-l-c9f2f-nst-its-adjacent-background/light-selector-boundary.json) | 边界45/50/55/60%的历史失败全部保留；placeholder候选范围详见下文，未遍历任意未来弹窗。 |
| R2-11 | 深／浅1050均为按钮height=38px、font=13px、面板radius=12px；statusContainsButton=false | [profile-failure.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-11-da-9f45a-try-outside-its-live-region/profile-failure.json)；[profile-failure.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-11-li-d06be-try-outside-its-live-region/profile-failure.json) | 两主题1050的真实截图已保存；未声称读屏软件已实测。 |
| R2-12 | LoadingStatus同一空live节点先挂载，150ms后填字；准备进度100次推送同一阶段只在阶段初始及25/50/75/100%更新，变化≤5次，按钮和progressbar不在播报节点内。 | [tsx-red.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/tsx-red.log)；[tsx-green.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/tsx-green.log) | DOM/更新频率单测；NVDA/真实读屏语音尚未验证。 |
| R2-13 | 1440：gap=16px、两按钮top=836px；1050：gap=16px、两按钮top=638px。次操作均为secondary | [empty-home.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-13-em-7aa12-lose-and-actions-on-one-row/empty-home.json)；[empty-home.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-13-em-f9af9-lose-and-actions-on-one-row/empty-home.json) | 1050／1440均通过；修空态间距和英文按钮换行，未改首页左x。 |
| R2-14 | English1050：detail x=296px；title height=50px / line-height=25px=2行；address wbr=7。 | [server-1050.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-14-En-b5c03-nd-the-shared-rail-position/server-1050.json) | title完整值保留在title属性；窄容器布局采用真正container query，非偷偷增加全局断点。 |
| R2-15 | interface-quality-R2-15-en-5f72d-ontent-pages-begin-together: spread=0.0000px，accounts h2=[219.796875, 219.796875]<br>interface-quality-R2-15-en-d38f7-ontent-pages-begin-together: spread=0.0000px，accounts h2=[219.796875, 219.796875]<br>interface-quality-R2-15-zh-662ee-ontent-pages-begin-together: spread=0.0000px，accounts h2=[219.796875, 219.796875]<br>interface-quality-R2-15-zh-8ef38-ontent-pages-begin-together: spread=0.0000px，accounts h2=[219.796875, 219.796875] | [content-origins.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-15-en-5f72d-ontent-pages-begin-together/content-origins.json)；[content-origins.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-15-en-d38f7-ontent-pages-begin-together/content-origins.json)；[content-origins.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-15-zh-662ee-ontent-pages-begin-together/content-origins.json)；[content-origins.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-15-zh-8ef38-ontent-pages-begin-together/content-origins.json) | zh/en×1050/1440；首区静态选择为commandbar、discover-workspace、multiplayer-tabs、task-center、accounts-layout、settings-layout，未按结果移动ROI。 |
| R2-16 | 最终native Doto计数=15px/900；资源标题font=13px、line-height=19.5px。此前16px/600失败已修，不能引用旧待修结论。 | [typography-contract.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/font-fixes-green/interface-quality-R2-16-21-82d0e-titles-inherit-line-spacing/typography-contract.json)；[.last-run.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/font-fixes-green/.last-run.json) | 全量h2角色盘点另见CSSreview；实体标题按R2-14仍20px，不应与16px区块标题混作一个角色。 |
| R2-17 | 1440深色专项已完成2/2：Discover两真实flat surface空白背景均RGBA(28,29,31,255)，同相位内侧直边均RGBA(77,76,76,255)，逐像素完全相等；Settings实际Select和两number input也同值。五控件computed border均rgba(237,232,223,0.23)、1px solid、radius6px。 | [summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/r2-17-fields-settled/summary.json) | 不把23%原始border颜色当成屏幕RGB。首次抓到入场尾段x漂移0.007164，严格拒绝；仅增加100ms几何完全一致前置条件后重采，未改产品或像素阈值。 |
| R2-18 | 清除Vite旧样式缓存并加载已落盘CSS后，原用例通过：199条历史默认30条，均56px；首屏完整8条；页面高2338px<4000；h2 x=[369.5, 369.5]。Show more→60，Failed→1且无Size pending，Completed→30；原任务总数200保留。 | [downloads-200.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/download-cache-green/interface-quality-R2-18-tw-f9d22-ts-in-compact-paged-history/downloads-200.json)；[download-cache-green.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/download-cache-green.log) | 前两轮7条失败均保留，未放宽8条阈值或更换夹具。过滤空态由单测验证。 |
| R2-19 | 1050：textWidth=176px，cards=[313.5, 313.5]，feet=(676.5000,464.4063)；1920：textWidth=280px，cards=[274.65625, 274.671875]，feet=(1167.5000,687.4063)；1280：textWidth=176px，cards=[277.65625, 277.671875]，feet=(795.5000,456.4063) | [home-anchor.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-19-ho-2163b-hor-and-responsive-controls/home-anchor.json)；[home-anchor.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-19-ho-9220b-hor-and-responsive-controls/home-anchor.json)；[home-anchor.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-19-ho-b6f47-hor-and-responsive-controls/home-anchor.json) | 1920文本280px达标；原动态M2 mean88.979失败保留，现按用户第四次修订在固定uT9.7判均值，固定三宽已通过，第三遍历史批次的1920动态等待曾超时；第五次修订后1920已正式取样并通过，见本报告动态五组结果；站位人工结论在本节另列。 |
| R2-20 | 有效响应式采样11/11通过：1050/1179/1180/1279/1280/1440/1920正常，以及1050/1920 forced-colors和减少透明；console/character交叠面积均0。全局max-width只保留1179/760。 | [css-independent-review.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/css-independent-review.json)；[responsive-reduced-transparency.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/responsive-reduced-transparency.log) | 最初两次减少透明modeApplied=false是无效模式模拟，已保留；后续保持CDP会话重测通过，不混作产品失败。第三遍对应窄视口套件通过但整体因1920动态等待失败停止；第五次修订后新的完整套件252/252通过，历史失败不改写。 |
| R2-21 | library-grid 576行＋instance-detail 321行=897≤900；按完整layer/media/container上下文逐个选择器审计重复0。错误font shorthand已修为独立size/weight，native line-height=19.5px。 | [library-selector-audit.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/library-selector-audit.json)；[typography-contract.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/font-fixes-green/interface-quality-R2-16-21-82d0e-titles-inherit-line-spacing/typography-contract.json) | 采用现有PostCSS检查，不冒充运行stylelint；第三遍library-review／frontend-completion／ui-stress均通过；不替代世界等待闸门。 |
| R2-22 | 当前基线与实际均359。R2-22 由 `npm test` 中的静态守护（令牌、按钮几何及面板圆角）与 `npm run test:design` 的跨页浏览器几何共同满足。C4时基线428及67文件674项Vitest＋77项Node为历史；旧a4快照曾按预期触发守护 | [revision5-npm.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/revision5-npm.log)；`scripts/design-token-baseline.json`；`historical-guard-red.json`；旧`npm-verified.log`保留 | 第五次修订后新的完整Playwright252/252，0失败／跳过／flaky，errors为空；主流程TypeScript退出0。C4已推送并确认，远端CI未验证 |
| R2-23 | zh页面h1和导航保留“角色”；按钮/登录/离线身份用“账号”；模型为经典（宽臂）/纤细（细臂），本地错误文本同步。native术语用例通过；旧accounts E2E五处完整术语定位已更新。 | [accounts-terminology.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-23-Ch-dfc22-s-and-translate-model-names/accounts-terminology.json) | 未对“角色”进行全局替换。 |
| R2-24 | 空服务器只有一条“No saved servers”说明；右框height=380px，border=1px solid；文案指向上方已有Add server。 | [server-empty.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-24-em-74d7c-n-in-the-380px-detail-frame/server-empty.json) | 未增加第二个主按钮。 |
| R2-25 | 真实Tab从启动按钮开始，在动画控件前经过2个最近实例；最后焦点animation=true；重复group/aria-label已去除。 | [home-tab-order.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-25-ke-2b2f3-he-single-animation-control/home-tab-order.json) | 旧round6 helper已按新DOM定位controls容器，全部bbox/count/click-hit断言保留，第三遍对应回归通过。 |
| R2-26 | 路径tail=shared-world，client=73px / scroll=73px；名称高44.875px、行高22.44px≤2行；禁止的span aria-label=false。 | [library-long-path.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-26-En-0c8b1--segment-and-two-line-names/library-long-path.json) | 该数值用长父目录＋常见basename shared-world。原80字符basename另在压力截图记录，不能声称所有长度都不截断。 |
| R2-27 | width=279.546875 / content=269.546875 / insets=10 / fill=false；width=167.265625 / content=157.265625 / insets=10 / fill=false；width=344.984375 / content=334.984375 / insets=10 / fill=false | [create-tracks.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-27-cr-039fa-their-actual-option-content/create-tracks.json) | 三个创建轨道fit-content，详情页tabs显式fill；第三遍旧详细流程回归通过。 |
| R2-28 | nav-dark-full-solid: 6.670934:1；nav-dark-lite: 6.781874:1；nav-light-full-solid: 5.604944:1；nav-light-lite: 5.497016:1 | [summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/nav-placeholder-first/summary.json) | 两主题×full-solid/Lite四组，每组三帧，文本Range上2/下2行全部像素最差值；是真GPU实际背景，不拿CSS变量代替像素。 |


### S2–S6及M2修订（均已包含在C4并推送）

| 编号 | 实现与已完成数值／行为检查 | 证据及范围 |
| --- | --- | --- |
| R2-07追补 | 阶段3 `3f674c3`已完成的层级分离之外，C4再修真实导航折射被shell层blur覆盖、tokens提前注册overrides两项生产级联回归；分别原生2/2、1/1通过 | `refraction-red/green.log`、`layer-order-red/green.log`。这些修复归C4，不写成已包含在3f674c3内 |
| S2 | 指针关闭在实际Popup退出完成后通知；键盘／静态模式立即通知，回调去重并隔离旧退出。3项RED后Select＋HomePage53项通过。最终pointer 68帧、overlap0；keyboard（Escape）70帧、blank0、overlap0 | `s2-native-final/review-fixes-S2-picker-kee-3f88b-iately-for-keyboard-closure/picker-exit-frames.json`及关闭截图。指针仍有3个低透明度过渡帧，不扩写为指针零空白 |
| S3 | submission预算为最近30个全部rAF回调间隔中位数×1.25，连续两个2秒超标窗口才降档，健康窗口／暂停清理历史。真实GPU计时保留独立16.7ms。5项RED后43项通过 | `s3-red.log`、`s3-green.log`。60Hz每90帧跳一帧、50Hz各10秒不降；100Hz每6回调只提交一次仍降。不作为Intel/WebView2实测 |
| S4 | 真实曲率URL恢复后，按实际轮廓内缩4px、扣文字／图标的内部区域检查，四组差值>25占比均0%，低于0.5%；原生4/4通过 | 下面分列内部／全轮廓数值与6倍人工图。色散保持0.65，未套用浅色0.25 |
| S5 | 预览胶囊surface-card 78%、blur(10px)、hairline；减少透明和高对比回退实底／无blur。两主题×1050／1280四组intro与idle均≥4.5 | 下表只列实际绘制的preview source，不用nominal-only区域冒充可见文字 |
| S6 | solid裙深9、lattice仍3。相同相位3→9对照的下方诊断区精确背景点236/32000（0.7375%）→0，两主题一致；正式源码补采三个原ROI也全部0 | 改前236/32000来自 `solid-cliff-v2/summary.json`；改后0来自 `solid-cliff-final/summary.json`。各目录保留自身的 `dark-normal.png`、`light-normal.png`；两份summary均为sourceUnchanged=true |
| M2第四次修订（历史停止） | R2-19后1920动态五帧92.19→90.23→88.98→86.69→74.39，中位88.98，按旧90–150门槛失败并停止。经用户裁定，均值90–150仅在固定uT=9.7的深色地平线1050／1280／1920判；相位覆盖三宽×9.7／188／288／588，同样稳定后连拍5帧 | 第三遍12相位和4个其它动态闸门通过；1920动态等待20017.1ms超时，无正式五帧，当时按规则STOP。该历史失败保留；随后按第五次修订恢复，六项专项及新完整252/252通过，C4已推送。动态均值仅记录，旧单相位92.06不代替新验收 |
| M2第五次修订 | 动态等待改为覆盖率差<0.3pp及三项实际GPU结晶uniform各差<1e-3，实际读数间隔≥400ms且必须有新写入／提交；固定均值等待、20秒deadline和数值门槛保持原值 | `revision5-world-gates.log`六项原生专项6/6通过；30项聚焦Node通过；`revision5-full.json`新完整套件252/252。第三遍STOP保留为历史，C4已推送并确认 |

### 阶段4失败记录与修复依据

- **界面15/23→22/23→下载原用例通过：**空首页gap40px来自h1下边距16与stage gap24叠加；英文两按钮需329.92px，超过254.4px可用宽度。角色页两个h2相差6px，1920选择器正文仅232px。修后gap16、按钮同行，角色h2均219.796875px，选择器正文280px。`interface-first.log`及失败PNG保留。
- **下载旧CSS缓存：**已落盘gap24px、section纵向padding16px，浏览器却仍加载gap34／padding24的Vite模块，见`download-layout-probe.json`。仅重启开发服务器重新加载，没有再加产品覆盖或放宽200任务夹具的门槛。首行y662.515625→628.515625，完整可见7→8条，总高2380→2338；`download-cache-green.log`及JSON记录原用例通过。
- **字体遗漏已经修复：**独立RED发现Doto仍16px／600，资源标题的font简写把继承行高重置normal。只将Doto恢复15px／900、资源标题恢复独立size／weight声明。`font-fixes-green.log`原生1/1通过（5.8秒），资源标题为MiSans 13px／19.5px。旧`css-independent-review.json`、`interface-evidence-review.md`里的待修是修复前快照，不能作为最终状态。
- **两项真实级联回归：**shell features层遗留blur(8px)覆盖glass primitives层曲率URL，删除两条冗余声明后深浅条纹2/2通过；tokens先注册overrides使后声明完整层序无法重排，匹配的R2-10阴影仍被box-shadow:none压住，将完整层序声明移到tokens最首后RED→GREEN。证据为`refraction-red/green.log`、`layer-order-red/green.log`；这是产品回归，不能归因为统计偏差。
- **无效探针保留：**`initial-optics/`、`controlled-optics-v2/`中S4采集时真实折射未启用，标为INVALID-S4-REFRACTION-INACTIVE，不用于色散判断。S6初版包装错误draw API，标INVALID-S6-REFERENCE；改拦真实drawArraysInstanced后重采。响应式初版减少透明两例CDP detach导致modeApplied=false，不算模式验证；保留会话重测后才纳入11个有效组合。
- **M2停止与裁定：**`world1920-comparison.json/.md`保留逐帧和等待。rail320→400使人物与脚锚点均右移40px，ROI随之移动，不能称为相同几何。失败批等待8376.9ms，最后稳定对93.707463→92.930966，差0.776497，之后五帧继续下降；帧数1879／2039／2192／2355／2530。先按旧门槛停止，再按用户裁定改测试，没有调整亮度参数迁就结果。

### R2-10玻璃边界：最终65%，描边宽度和色散不变

实际DOM使用`data-glass-variant="control"`。原45%内阴影被3px内缩clip裁掉，随后沿共享live contour加同色描边，居中2px经既有clip留下内侧约1px。第四次修订只允许以5个百分点步进调同一边界的不透明度；颜色`--text-secondary`、refraction0.9、dispersion0.65、描边宽2px保持不变。

| 不透明度 | 九行最低对比 | 结果 |
| ---: | ---: | --- |
| 45% | 1.8280680777 | 失败 |
| 50% | 1.9952213514 | 失败 |
| 55% | 2.1706243369 | 失败 |
| 60% | 2.3818745628 | 失败 |
| 65% | 2.6093754999 | 通过，停止迭代 |

65%按dy=-4..4的九行值：**2.6327540287、2.6093754999、2.6566645718、2.6566645718、2.6589781016、2.6370155025、2.6566645718、2.6589781016、2.6661822522**。全部≥2.5；60%失败证明65%为规定步进的最小达标值。原始RGB、样式和各步截图见`r2-10-opacity-steps.json`及`r2-10-opacity-{45,50,55,60,65}/`；除glass.css之外产品源码逐步hash一致。最终图：[light-selector-boundary.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/r2-10-opacity-65/review-fixes-R2-10-light-l-c9f2f-nst-its-adjacent-background/light-selector-boundary.png)。初始1.046581和45%真实边界1.828068–1.865199的失败也保留。

### S4数值检查：内部与全轮廓分开记录

**本小节为第四次口径的历史结果，已由2026-11-06第五次口径复核取代。**旧参照仅隐藏活动胶囊，不能据内部0%证明竖条消失。新参照、列剖面RED及诊断见末节第1项；旧原图和数字不回写。

读取实际clip-path，用居中8px的Path2D stroke取得内缩4px的内部，再扣实际文字／图标框，不用矩形或按亮暗挑像素。测试冻结rAF，参考仅隐藏胶囊材料，文字图标和worldFrames不动，四组框外变化均0、computed backdrop均含曲率URL。`s4-final.log`记录4/4通过（21.4秒），`s4-final-source.json`记录产品前后hash一致。

| 场景 | 内部像素 | 通道差>25像素／比例 | 全轮廓比例（只记录） | 内部最大通道差 |
| --- | ---: | --- | ---: | ---: |
| 深色首页 | 788 | 0／0% | 3.515625% | 18 |
| 深色游戏库 | 956 | 0／0% | 3.514377% | 18 |
| 浅色首页 | 788 | 0／0% | 8.984375% | 1 |
| 浅色游戏库 | 956 | 0／0% | 8.266773% | 1 |

浅色全轮廓比例包含获批65%可读边界，不把内部0%写成整颗0%。早期有效v3深色全轮廓约3.49%／3.53%、内部0%保留在`controlled-optics-v3/`，但它发生在最终边界之前，只作历史。最终6倍人工检查见下表。

独立条纹实测两主题均为：边缘最大位移12px（≥2）、中心0.0003223px（≤1）、live位移7px（6–8）、均匀底色差0（≤1）。证据为`interface-final/interface-quality-curvatur-{8cd61,c0c00}-ction-across-cascade-layers/refraction/glass-pixel-report.json`和原图；第三遍完整套件中对应条纹用例通过；该遍整体因1920动态等待失败停止，后续按第五次修订恢复，不能改写该遍结果。

### S6正式源码和最终参数

正式源码两主题三ROI：中部[980,350,1160,500)27000像素、右侧[1230,330,1410,490)28800、下方[1000,700,1200,860)32000，精确背景点全部0。背景参考实际抑制40／50次draw、改变452060／670014个地形像素；sourceUnchanged=true，见[改后solid-cliff-final/summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/solid-cliff-final/summary.json)。改前下方236/32000（0.7375%）的真实来源为[solid-cliff-v2/summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/solid-cliff-v2/summary.json)，不是final文件；原始点和截图均保留。深色“通道差≤2”可能包含暗侧面，只作诊断，未替代精确背景指标。

| 参数 | 最终值 |
| --- | --- |
| 岛面反照率下限 | `vec3(.6,.588,.552)*uLat*vIsland` |
| 照明补偿 | `max(vLit,mix(1.25,1.1,uLight)*uLat*isl)`，深色1.25／浅色1.1 |
| 高光肩部 | `k=max(col-.8,0.); sh=min(col,.8)+k/(1.+5.*k); col=mix(sh,col,uLight);` |
| 裙深 | `mix(s,mix(9.,3.,uLat),m*mix(1.,crE*crE*crE,uLat))`，solid9／lattice3 |
| 玻璃 | refraction0.9、dispersion0.65；浅色control边界opacity65%，居中stroke2px |
| 首页 | rail `clamp(296px,21vw,400px)`；recent auto-fill且最小240px；内容最大宽1280px不变 |

相机、曝光、泛光、岛半径、全局背景没有随本阶段调整。父规格4.2／4.3已同步最终机制，第一轮105.62、远景83及覆盖率历史数字原样保留。


### S5复用E1：无账号预览对比

以下四组来自world-final内已实际通过的no-account preview用例。这里只列preview source真实绘制区域（不是nominal-only），每组还对其他首页文字执行既有验收。

| 场景 | intro最差对比 | idle最差对比 | 数据 |
| --- | ---: | ---: | --- |
| no-account-dark-1050x720 | 8.841689 | 8.775655 | [states.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/s5/no-account-dark-1050x720/states.json) |
| no-account-dark-1280x720 | 8.491456 | 9.040192 | [states.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/s5/no-account-dark-1280x720/states.json) |
| no-account-light-1050x720 | 5.849832 | 5.493608 | [states.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/s5/no-account-light-1050x720/states.json) |
| no-account-light-1280x720 | 5.849832 | 5.835506 | [states.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/s5/no-account-light-1280x720/states.json) |

### R2-10占位符测量范围与原图

- placeholder-dark：最亮已测输入为accounts-local-preview／Online skin URL，最差5.194163:1；[accounts-local-preview-under-placeholder.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/nav-placeholder-first/placeholder-dark/accounts-local-preview-under-placeholder.png)。
- placeholder-light：最亮已测输入为discover-search／Search resources，最差5.392209:1；[discover-search-under-placeholder.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/nav-placeholder-first/placeholder-light/discover-search-under-placeholder.png)。

候选来自库/探索搜索、角色本地URL、添加服务器地址、设置General与Java的可见启用空输入。仅隐藏placeholder字形，保留布局与实际背景；按采样背景均值亮度选最亮输入，再取该输入内容框内最差像素对比。其他候选全部留在summary，未声称遍历所有可能弹窗。六组导航/placeholder均pass、无page/console错误，sourceBefore=sourceAfter。


### R2-28导航文字的实际背景对比

solid／Lite导航为88% surface-solid。实际WorldScene与导航为兄弟节点，通过`.vx-app-body:has(> .world-scene[data-world-material="solid"])`匹配导航，而非照搬无效祖先选择器。四组合各采三帧，逐文字Range上方2行／下方2行全部x像素求最差对比。

| 组合 | 最低对比 |
| --- | ---: |
| dark／full／solid | 6.6709342087 |
| dark／Lite | 6.7818739363 |
| light／full／solid | 5.6049438503 |
| light／Lite | 5.4970162867 |

全部≥4.5。`nav-placeholder-first/summary.json`及四个nav目录保存`nav-{0,1,2}.png`。导航／占位符六组均无page/console错误、DPR1、实际NVIDIA RTX5080 Laptop／D3D11，采集前后sourcehash一致；Lite运行时material为solid，不是只用CSS变量推算对比。

### R2-14／19／20／21响应式和清理复核

详情使用930px实际内容容器查询，全局max-width只保留1179与workspace的760兜底，wide从1680起消费令牌、内容最大宽仍1280。采样的控制台／角色bbox交叠面积全部0，服务器实体标题最多两行。

| 窗口宽 | 详情容器宽 | 服务器卡实际列宽 | 选择器正文宽 |
| ---: | ---: | --- | ---: |
| 1050 | 715 | 657px单列 | 176 |
| 1179 | 844 | 786px单列 | 176 |
| 1180 | 829 | 771px单列 | 176 |
| 1279 | 928 | 870px单列 | 176 |
| 1280 | 929 | 871px单列 | 176 |
| 1440 | 944 | 622.406px＋239.594px | 182.390625 |
| 1920 | 944 | 622.406px＋239.594px | 280 |

再加1050／1920各forced-colors、减少透明，总11个有效组合。数据为`css-independent-review.json`、`responsive-boundaries/results.json`、`responsive-reduced-transparency/results.json`，记录modeApplied、nativeGPU、DPR与几何。1280仍单列是实际可用空间的结果，不新增“1280必须双列”门槛。

两新库CSS为576＋321=897行，完整layer／media／container条件下逐个selector（含列表内部）重复0，保留降级分支，没有压缩格式凑行数。`library-selector-audit.json`分别记录104／67条规则、122／73个selector；这是PostCSS检查，未声称执行stylelint。继承行高遗漏已经独立修复。圆角守护只对白名单中既有Select button、selection mark、launch-console content、LatticeFrame的inherit开放，保持宿主曲率；新增inherit或独立px仍拒绝。

### R2-17补充像素检查

`r2-17-fields-settled/summary.json`记录深色1440×930、原生D3D11、DPR1、两组通过且sourceUnchanged=true。Discover目标／来源两个flat Select空白背景各15个采样像素均为RGBA(28,29,31,255)，同0.5px栅格相位的内侧直边各9像素均为RGBA(77,76,76,255)，逐像素相同。Settings实际Select及两个number input也为这两个屏幕值；五控件computed边框都是rgba(237,232,223,.23)、1px solid、radius6px，不把声明颜色当作合成后RGB。

初采`r2-17-fields-first/`捕捉到入场尾段x漂移0.007164px，按原严格条件拒绝，没有宽容成稳定。仅增加相隔100ms几何完全相等的前置检查后重采，未改产品、取样位置或像素阈值。Discover目标含metadata，高52px；来源高40px，Settings Select40px／number input39px如实记录，本条不要求这些不同内容的字段同高。

### 阶段4人工检查

| 项目 | 实际查看的截图与结论 | 范围 |
| --- | --- | --- |
| R2-09 | 独立审查逐张查看`interface-final/interface-quality-R2-09-fo-32286-ored-chevrons-on-four-pages/`四页原图；库／探索／角色的箭头和字段边界清晰，下载无下拉箭头 | 见`interface-evidence-review.md`；不把computed 1px冒充物理边框厚度实测 |
| R2-17普通深色字段 | 主流程及界面审查实际查看[discover-fields.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/r2-17-fields-settled/discover-fields.png)与[settings-fields.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/r2-17-fields-settled/settings-fields.png)，底色／描边一致 | 保留目标字段metadata带来的52／40px高差，不强求同高；不扩展为全部状态已人工签字 |
| S4深色首页 | [actual-6x.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/s4-final/review-fixes-S4-dark-home--ae1ab--clear-with-real-refraction/glass-interior/actual-6x.png)及同目录without-indicator-6x.png | 光学审查逐张查看实际／参考各4张，共8张，未见材料新增中心接缝或单侧彩色楔形 |
| S4深色游戏库 | [actual-6x.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/s4-final/review-fixes-S4-dark-libra-81d20--clear-with-real-refraction/glass-interior/actual-6x.png)及参考图 | 可见背景细列在隐藏材料后仍同位，未称整幅画面无竖列 |
| S4浅色首页 | [actual-6x.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/s4-final/review-fixes-S4-light-home-75bc6--clear-with-real-refraction/glass-interior/actual-6x.png)及参考图 | 右下淡块在参考图仍存在，未满足进一步改色散的诊断条件 |
| S4浅色游戏库 | [actual-6x.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/s4-final/review-fixes-S4-light-libr-b4973--clear-with-real-refraction/glass-interior/actual-6x.png)及参考图 | 两主题dispersion仍0.65，不额外使用浅色0.25 |
| S6浅色山体 | 主流程实际查看`solid-cliff-final/light-normal.png`，正式solid9格，三个原数值区均0精确背景点 | 深色图有数据及原图，此处不补写未经记录的人工签字 |
| M2／R2-19裁定前历史 | 第四次裁定前1920 normal/island由审查方查看：脚仍在岛上，最后一帧为呼吸倾斜、无发灰或白斑 | 只保留当时裁定依据，不作为第三遍人工验收 |
| M2／R2-19第三遍固定9.7 | 主流程逐张实际查看[1050 normal-2](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified/world-acceptance-terrain-b-3091c--retains-highlight-headroom/terrain-phase/normal-2.png)、[1280 normal-2](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified/world-acceptance-terrain-b-dd257--retains-highlight-headroom/terrain-phase/normal-2.png)、[1920 normal-2](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified/world-acceptance-terrain-b-186c1--retains-highlight-headroom/terrain-phase/normal-2.png)：三张脚与岛顶接触，岛面有暖色和暗侧层次，未见大片纯白，控制台未遮挡人物 | 本行人工结论仅限这3张；均值103.369059／99.354945／92.052806的数值通过独立列于固定相位表，不代替动态等待 |
| 第三遍1920超时末次正常图 | 主流程实际查看[settling-27-normal.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified/world-acceptance-round-2-a-5f78c-oundings-meet-their-budgets/anchored-island/settling-27-normal.png)：脚仍落在岛面，形态起伏，未见明显白斑 | 这是等待期单张目视，不能替代20秒稳定闸门；未声称28组等待图全部人工查看 |

### 阶段4命令记录和未完成验证

| 命令／批次 | 已读到的实际结果 | 日志与限制 |
| --- | --- | --- |
| `npm run check`（含于最新npm test） | 双语710键、120个TS/TSX、32个后端错误码，无白名单外未用键；23样式表、spacing428＝已收紧基线428 | `revision5-npm.log`；旧`npm-final.log`和429→428记录保留，旧a4快照失败见`historical-guard-red.json` |
| 第五次修订前`npm test` | 67文件、674项Vitest；57项Node通过、0失败、0跳过，含3项cleanup回归 | `npm-verified.log`；早期674＋54批次`npm-final.log`仍保留，不替代第五次修订后的新验证 |
| 第五次修订后最新`npm test` | 67文件、674项Vitest＋77项Node通过，0失败、0跳过 | `revision5-npm.log`；主流程新验证，保留修订前日志 |
| interface-quality专项 | 首批15/23，下一批22/23；剩余R2-18原门槛1/1、字体R2-16/21原生1/1通过 | 保留各批失败，不拼称某一次23/23 |
| S2／S4／R2-10专项原生 | 最终分别1/1、4/4、65%时1/1 | `s2-native-final.log`、`s4-final.log`、`r2-10-opacity-65.log`；所有RED、无效探针和一次错误grep日志均保留 |
| `npm run build` | 最终tsc＋vite build完成330ms，保留bundle>500kB提示 | `build-final.log`；先前596ms批次`build.log`保留。本命令仅构建前端，未构建安装包 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 122通过、0失败、1项原有网络smoke忽略；main和doc各0项通过 | `cargo-test.log`；忽略的官方元数据／JAR网络smoke不计作已通过 |
| 第五次修订前`npx tsc -b` | 退出0，无错误输出 | `tsc-verified.log`；早期`tsc-final.log`及`optics-final-tsc.log`保留，不替代恢复后的新验证 |
| 第五次修订后最新`npx tsc -b` | 主流程确认退出0，无错误输出 | `revision5-tsc.log`为0字节；退出状态由主流程完成的验证管线确认 |
| 完整Playwright首轮 | 248通过、4失败、0跳过、0flaky，22.4分钟 | `full-suite.log`及`full-suite.json`；四项失败与修正如下，未删失败数据 |
| 旧语义／分页专项重跑 | 2/2通过，11.1秒 | `legacy-semantic-green.log`；保留全部200任务与原滚动门槛 |
| 独立Toast入口修复后重跑 | 原4/4通过，5.0秒 | `toast-harness-green.log`；1.5px、ease-in和退出中间帧约束未改 |
| 第二遍完整252项Playwright | 251通过、1失败、0跳过、0flaky，约21.5分钟 | `full-suite-final.log/.json`；唯一迟到ACK错误与实际中间帧证据见下节，未重写该次结果 |
| 采集器确定性Node回归 | 原清理顺序2通过／1失败→修复后3/3通过 | `screencast-cleanup-red.log`、`screencast-cleanup-green.log`，stop／ACK／detach错误仍全部记录 |
| review-supplement＋transitions原生专项 | 7＋20＝27/27通过，2.8分钟 | `screencast-e2e-green.log`及同名输出目录；原阈值不变 |
| 第三遍完整252项Playwright | **251通过、1失败、0跳过、0flaky，21.5分钟；STOP** | `full-suite-verified.log/.json`、`full-suite-verified/`；唯一1920动态等待超时20017.1ms，无正式五帧及numeric-acceptance。S5输出在`full-suite-verified-world-states/` |
| 第五次修订后新完整252项Playwright | **252通过、0失败、0跳过、0flaky，22.2分钟；errors=[]** | `revision5-full.log/.json`、`revision5-full/`；JSON原始duration=1330320.944ms，不拼接前三遍结果 |
| M2第五次修订聚焦Node | 15项稳定等待＋15项uniform探针，30通过、0失败、0跳过 | `../revision5-node-green.log`；真实GPU结果另列 |
| M2第五次修订六项原生专项 | 固定9.7三宽＋动态三宽，6/6通过，1.1分钟 | `revision5-world-gates.log`及同名输出目录；不代替完整套件 |
| S2三种真实键盘关闭 | Tab／Enter／Escape，3/3通过，各0空白帧，sourceUnchanged=true | `revision5-s2-keyboard/summary.json`及各组原始帧；没有追加S2产品修改 |
| C4提交／推送／远端确认 | **8a9ed45已提交、普通推送并确认** | 本节全部编号归同一C4；stage4/commit-receipt.json保存完整SHA、身份及只有main的ls-remote读数 |

### 首轮完整套件四项失败与原证据

首轮`full-suite.json`的expected=248、unexpected=4、skipped=0、flaky=0。四项失败截图及错误上下文原样保留，未重写成首轮全过：

1. `card-theme`旧测试仍在article检查aria-current，与R2-04已批准的按钮归属不符。只把该断言移到`.vx-instance-card__select`，原点群／边框／可操作性断言保留。
2. `ui-stress`旧下载用例直接查未挂载history-0，与R2-18默认30条分页不符。通过真实Show more逐次30→60→90→120→150→180→199，验证总任务200，然后原样执行20000滚轮、30000ms等待、滚动余量≤2及history-0视口边界断言。两处迁移已应用，`legacy-semantic-green.log`记录原生2/2通过。
3. Toast固定id屏幕锚点测试右缘漂移390px／下缘34px。
4. Toast的dialog退场没有中间帧。后两项共同根因是独立harness缺tokens导入：`toast-harness-before/computed.json`中space5／font-ui／duration-exit为空，dialog和backdrop均0s。只在测试入口最前补一行tokens导入后，`toast-harness-tokens/computed.json`为space5=24px、duration-exit=80ms、host right／bottom=24px、打开dialog／backdrop=0.18s；原4项Toast全部通过。未改生产样式或放宽1.5px、ease-in、中间帧门槛。

更早旧用例迁移仍保留覆盖：global-glass／round6最近卡片使用已批准的aria-current；round6定位实际animation controls，保留数量／画布上方几何／命中断言；固定id Toast按M3验证同节点、焦点、单live、旧timer无效、关闭一次，保留原几何边界。真正toggle的aria-pressed和tabs的aria-selected没有全局替换。

首轮有些旧脚本仍向仓库`test-results/`写固定路径，产物已移到外部worklogs，保留相对路径与原文件内容。以下路径映射避免报告中的历史路径失联；没有删除测试源码、夹具或失败证据：

| 原目录（E:/CodeX/VoxelightLauncher/test-results/） | 新目录（本节证据根下） | 文件数 |
| --- | --- | ---: |
| card-theme/ | full-suite-side-effects/card-theme/ | 9 |
| reference-alignment/ | full-suite-side-effects/reference-alignment/ | 23 |
| transitions/ | full-suite-side-effects/transitions/ | 367 |
| world-regressions/ | full-suite-side-effects/world-regressions/ | 106 |


### 第二遍完整套件：迟到ACK与会话清理竞态

第二遍`full-suite-final.json`记录expected=251、unexpected=1、skipped=0、flaky=0。唯一失败是`review-supplement`的真实命令栏grid→list→grid采集。两份原trace均有真实trusted输入、21个满足原条件（目标mode、实际rAF、0.01<opacity<0.99）的中间态、9张与观察时间差<20ms的匹配中间PNG；list错误数组为空，grid保存`Error: cdpSession.send: Target page, context or browser has been closed`。这些证据表明失败发生在采集器清理时序；并未据此删除errors必须为空的断言或将第二遍改成通过。

原`review-supplement`在会话detach前始终保留frame listener，`transitions`则在等待一份ACK Promise快照之后才移除listener。等待期间新到的frame又追加ACK，未包含在先前快照里，随后撞上detach。测试辅助`tests/e2e/helpers/stop-screencast.ts`统一执行：stop（记录失败）→同步移除确切listener→等待全部已接纳ACK（逐个记录拒绝）→detach（记录失败）。两个采集器共用它，原每帧错误记录及最终错误数组断言保留，生产代码、运动参数和画面阈值未改。

`tests/unit/screencast-cleanup.test.mjs`用可控Promise和EventEmitter确定性复现：stop未完成时帧2应正常ACK；stop完成、ACK仍等待时的帧3不应再被listener接纳；detach必须等待全部已接纳ACK。旧顺序RED为2通过／1失败（listener仍为1，预期0）；修后原3项全部通过，包括stop／ACK／detach原始Error全部保留及尚未开始采集时的清理。随后两份浏览器套件7＋20＝27项原生专项全过（2.8分钟）。新增辅助与测试归R2-22验证收口，不是产品转场修复，也未放宽trusted输入、实际rAF、中间PNG、deltaMs<20或几何／时序要求。

诊断与RED／GREEN日志：[screencast-cleanup-diagnostic.md](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/screencast-cleanup-diagnostic.md)、`screencast-cleanup-{red,green}.log`、`screencast-e2e-green.log`。专项图在`screencast-e2e-green/`，transitions逐帧原图在`screencast-transitions/`。

两次完整失败证据仍独立保留，以下均为实际绝对路径，未用后续成功覆盖：

| 批次／失败项 | 日志、原图及trace |
| --- | --- |
| 首轮248/252完整记录 | [full-suite.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite.json)与同目录full-suite.log |
| 首轮卡片当前态旧归属 | [test-failed-1.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite/card-theme-shared-points-o-efb20-frame-returns-after-leaving/test-failed-1.png) |
| 首轮Toast屏幕锚点 | [test-failed-1.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite/toast-review-M3-fixed-id-r-6fbca-preserves-its-screen-anchor/test-failed-1.png) |
| 首轮dialog退场中间帧 | [test-failed-1.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite/toast-review-review-D1-nat-9b86c-te-exit-frames-with-ease-in/test-failed-1.png) |
| 首轮下载旧全量渲染假设 | [test-failed-1.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite/ui-stress-the-maximum-down-60c28-ry-scrolls-to-its-last-task/test-failed-1.png) |
| 第二遍251/252完整记录 | [full-suite-final.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-final.json)与同目录full-suite-final.log |
| 第二遍迟到ACK错误 | [test-failed-1.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-final/review-supplement-suppleme-13924-tured-content-intermediates/test-failed-1.png)；同目录`library-list/trace.json`、`library-grid/trace.json`及匹配PNG保留 |

第三遍使用独立目录`full-suite-verified.log/.json`与`full-suite-verified/`，S5为`full-suite-verified-world-states/`。现已结束为251/252，唯一1920动态等待超时；前述迟到ACK问题在本次对应采集用例已通过，但不能据此称第三遍完整通过。

### 第三遍完整套件：1920稳定等待超时，按规则停止

`full-suite-verified.json`记录expected=251、unexpected=1、skipped=0、flaky=0，唯一失败为`M1/M2 dark horizon 1920: anchored island and its surroundings meet their budgets`。`captureAppearanceSeries`已保存settling.json后，在“waiting.status必须stable”断言失败，实际状态timeout、耗时20017.1ms，超出原20秒上限。

此用例没有进入正式五帧采样，也没有numeric-acceptance。等待期间图片和统计属于settling诊断，不能作为正式五帧中位数或亮度闸门结果。其余251项通过不会覆盖此失败；没有重试到偶然通过，也没有调整产品参数、ROI、稳定判据或等待上限。阶段4按用户规则停下，不提交、不推送。

完整记录：[full-suite-verified.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified.json)、同目录full-suite-verified.log。失败原图：[test-failed-1.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified/world-acceptance-round-2-a-5f78c-oundings-meet-their-budgets/test-failed-1.png)。完整等待逐次值如下；人工结论独立列于本节人工表，不以固定相位或截图代替动态等待闸门。

#### 完整稳定等待复算

离线分析[revision4-timeout-analysis.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/revision4-timeout-analysis.json)及[同名说明](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/revision4-timeout-analysis.md)逐对调用未修改的`appearanceSamplesStable`，同时独立复算每个布尔条件；结果全部一致，没有合格pair被误拒绝。第三遍28次观察、27对相邻采样中，时间间隔全部≥400ms、数据均有限值；覆盖率差从index3起全部<0.3pp，但**均值差<1从未满足**。最小均值差为index14的1.0935215804（90.0412120469→88.9476904665），仍高于原严格门槛。第二遍在index9→10正确接受：93.0015685002→92.1169377773，均值差0.8846307229、覆盖率差0.0336850649pp、间隔623.9ms均满足。第三遍没有已满足判据的样本对被deadline误拒绝。

| 1920采集批次 | 状态 | 实际等待ms | 观察数 | 合格pair index | 记录期间world提交率/s | 隐藏截图平均ms |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| 第二遍full-suite-final | stable | 7610.8 | 11 | 10 | 232.182403 | 97.245455 |
| 第三遍full-suite-verified | timeout | 20017.1 | 28 | 无 | 234.173427 | 97.128571 |

两遍脚锚点都为x=1167.5、y=747.40625、2×2，角色canvas也相同，tier始终animated、grid160。本次提交率没有低于第二遍、隐藏截图平均耗时也没有增加，这些记录不支持“第三遍截图明显更慢”的解释；没有记录逐样本实际提交的uT，不能仅用页内时间或帧数认定具体地形相位。等待用时按完整采集结束计，不把隐藏PNG结束时刻偷换为完成时刻。

下表为第三遍**等待观察**全序列，不是正式五帧。before／after是页内`performance.now()`的隐藏截图前后时间；worldFrames取同一before检查点。全下半区coverage单位为百分比、Δcoverage为百分点，岛ROI coverage为0–1比例。首行尚无相邻pair。

| index | before ms | after ms | worldFrames | mean | 全下半区coverage% | 岛ROI coverage | 与上张间隔ms | Δmean | Δcoverage pp | gap≥400 | Δmean<1 | Δcoverage<0.3 | 全满足 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| 0 | 3718.800000 | 3818.100000 | 574 | 52.088906 | 10.049412 | 0.709490 | — | — | — | — | — | — | false |
| 1 | 4448.000000 | 4547.800000 | 744 | 71.213565 | 13.421368 | 0.844118 | 629.900000 | 19.124660 | 3.371956 | true | false | false | false |
| 2 | 5168.800000 | 5266.600000 | 916 | 74.374779 | 14.157670 | 0.861529 | 621.000000 | 3.161214 | 0.736303 | true | false | false | false |
| 3 | 5886.700000 | 5980.700000 | 1086 | 77.382958 | 14.272423 | 0.884431 | 620.100000 | 3.008178 | 0.114752 | true | false | true | false |
| 4 | 6597.700000 | 6695.200000 | 1252 | 82.331114 | 14.372666 | 0.921961 | 617.000000 | 4.948156 | 0.100244 | true | false | true | false |
| 5 | 7310.500000 | 7406.600000 | 1417 | 85.262697 | 14.467938 | 0.940471 | 615.300000 | 2.931583 | 0.095272 | true | false | true | false |
| 6 | 8035.400000 | 8132.500000 | 1588 | 87.209142 | 14.541498 | 0.951922 | 628.800000 | 1.946446 | 0.073559 | true | false | true | false |
| 7 | 8755.900000 | 8851.300000 | 1755 | 89.832091 | 14.599939 | 0.966588 | 623.400000 | 2.622949 | 0.058442 | true | false | true | false |
| 8 | 9468.300000 | 9565.500000 | 1922 | 91.333635 | 14.515321 | 0.967725 | 617.000000 | 1.501544 | 0.084619 | true | false | true | false |
| 9 | 10177.900000 | 10275.400000 | 2088 | 93.033172 | 14.505885 | 0.963804 | 612.400000 | 1.699537 | 0.009436 | true | false | true | false |
| 10 | 10901.800000 | 10998.800000 | 2257 | 91.853701 | 14.537033 | 0.966510 | 626.400000 | 1.179472 | 0.031149 | true | false | true | false |
| 11 | 11619.400000 | 11715.300000 | 2426 | 93.396894 | 14.672484 | 0.973804 | 620.600000 | 1.543193 | 0.135450 | true | false | true | false |
| 12 | 12335.200000 | 12434.900000 | 2591 | 91.784062 | 14.750609 | 0.968000 | 619.900000 | 1.612832 | 0.078125 | true | false | true | false |
| 13 | 13043.500000 | 13140.200000 | 2756 | 90.041212 | 14.824675 | 0.958745 | 608.600000 | 1.742850 | 0.074067 | true | false | true | false |
| 14 | 13760.900000 | 13857.500000 | 2925 | 88.947690 | 14.846692 | 0.942353 | 620.700000 | 1.093522 | 0.022017 | true | false | true | false |
| 15 | 14480.600000 | 14576.700000 | 3091 | 87.226297 | 14.802354 | 0.928471 | 623.100000 | 1.721393 | 0.044338 | true | false | true | false |
| 16 | 15197.200000 | 15293.100000 | 3258 | 77.261221 | 14.576907 | 0.871098 | 620.500000 | 9.965076 | 0.225446 | true | false | true | false |
| 17 | 15906.700000 | 16002.600000 | 3425 | 69.194884 | 14.352679 | 0.854510 | 613.600000 | 8.066338 | 0.224229 | true | false | true | false |
| 18 | 16635.700000 | 16732.000000 | 3595 | 67.245268 | 14.306209 | 0.868471 | 633.100000 | 1.949616 | 0.046469 | true | false | true | false |
| 19 | 17347.400000 | 17444.500000 | 3762 | 70.421893 | 14.247058 | 0.870471 | 615.400000 | 3.176625 | 0.059152 | true | false | true | false |
| 20 | 18068.100000 | 18165.400000 | 3931 | 72.270383 | 14.176441 | 0.878824 | 623.600000 | 1.848490 | 0.070617 | true | false | true | false |
| 21 | 18777.300000 | 18874.800000 | 4096 | 74.753453 | 14.155337 | 0.901176 | 611.900000 | 2.483070 | 0.021104 | true | false | true | false |
| 22 | 19497.200000 | 19592.500000 | 4265 | 77.566308 | 14.253957 | 0.921765 | 622.400000 | 2.812855 | 0.098620 | true | false | true | false |
| 23 | 20221.800000 | 20323.000000 | 4436 | 80.521313 | 14.268973 | 0.930157 | 629.300000 | 2.955004 | 0.015016 | true | false | true | false |
| 24 | 20935.400000 | 21032.600000 | 4602 | 83.656690 | 14.251928 | 0.946824 | 612.400000 | 3.135377 | 0.017045 | true | false | true | false |
| 25 | 21647.000000 | 21746.200000 | 4769 | 85.920991 | 14.236303 | 0.955373 | 614.400000 | 2.264301 | 0.015625 | true | false | true | false |
| 26 | 22376.900000 | 22473.600000 | 4943 | 88.316313 | 14.295353 | 0.964196 | 630.700000 | 2.395322 | 0.059050 | true | false | true | false |
| 27 | 23097.600000 | 23193.900000 | 5112 | 90.417861 | 14.249696 | 0.958196 | 624.000000 | 2.101548 | 0.045657 | true | false | true | false |

原始settling：[settling.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified/world-acceptance-round-2-a-5f78c-oundings-meet-their-budgets/anchored-island/settling.json)。该目录保留`settling-{0..27}-normal.png`和`settling-{0..27}-island.png`，analysis.md逐行列出绝对路径；第二遍11次等待和已通过数据另存于full-suite-final，未拿来替换此次失败。

28次采样及相邻差值的诊断图：[revision4-timeout-chart.svg](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/revision4-timeout-chart.svg)。图中红线仍为原1.0判据，首条没有前值，不绘制差值；此图不替代原始表格和截图。

#### 第三遍固定相位独立记录

**第三遍历史快照（当时251/252、未提交）：** 当时建议仅在固定相位等待均值稳定。用户后续裁定动态用例等覆盖率稳定且 uLat、uCry、uIsland 收敛；第五次修订已执行，C4完整252/252通过并推送。此处保留第三遍固定相位数据，后续正式动态五组结果见上文。

以下三宽×四相位全部通过各自数值断言；只在uT=9.7要求均值90–150，其余相位均值及ROI有效率只记录。白像素为0–1比例（岛内要求<0.005、下半区<0.001），每个相位的p95及白像素断言针对各帧执行。它们不能替代超时的1920动态用例。

| 宽度／uT | 实际等待ms | 均值中位 | p95中位 | 岛ROI有效率中位 | 岛内白比例中位 | 下半区白比例中位 | 本相位数值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1050/9.7 | 2560.3 | 103.369059 | 168.000000 | 0.987922 | 0.000000000 | 0.000047974 | 通过 |
| 1050/188 | 2561.0 | 61.415057 | 162.666667 | 0.806157 | 0.000515092 | 0.000079957 | 通过 |
| 1050/288 | 2565.2 | 65.585087 | 167.000000 | 0.684353 | 0.000048833 | 0.000250533 | 通过 |
| 1050/588 | 2591.4 | 80.795168 | 167.000000 | 0.817843 | 0.000000000 | 0.000053305 | 通过 |
| 1280/9.7 | 2673.7 | 99.354945 | 167.000000 | 0.982000 | 0.000000000 | 0.000055556 | 通过 |
| 1280/188 | 2662.7 | 57.085496 | 161.000000 | 0.787922 | 0.000656234 | 0.000067460 | 通过 |
| 1280/288 | 2676.5 | 62.466320 | 167.333333 | 0.676471 | 0.000051432 | 0.000253968 | 通过 |
| 1280/588 | 2672.6 | 77.228664 | 167.666667 | 0.812549 | 0.000000000 | 0.000059524 | 通过 |
| 1920/9.7 | 2591.7 | 92.052806 | 166.666667 | 0.966392 | 0.000113520 | 0.000026380 | 通过 |
| 1920/188 | 2602.2 | 44.461747 | 160.000000 | 0.612784 | 0.000209415 | 0.000033482 | 通过 |
| 1920/288 | 2602.1 | 52.194344 | 168.666667 | 0.637569 | 0.000000000 | 0.000061891 | 通过 |
| 1920/588 | 2599.7 | 99.056275 | 175.333333 | 0.906784 | 0.000000000 | 0.000019278 | 通过 |

三张固定启动相位正常图如下；人工结论见本节人工表。每个相位完整五帧及数值见analysis.json所列source绝对路径。

- 1050：[normal-2.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified/world-acceptance-terrain-b-3091c--retains-highlight-headroom/terrain-phase/normal-2.png)。
- 1280：[normal-2.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified/world-acceptance-terrain-b-dd257--retains-highlight-headroom/terrain-phase/normal-2.png)。
- 1920：[normal-2.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/full-suite-verified/world-acceptance-terrain-b-186c1--retains-highlight-headroom/terrain-phase/normal-2.png)。

未验证范围：Intel Graphics、真实Tauri/WebView2、NVDA语音、真实Microsoft登录／Minecraft启动、全部可能弹窗占位符、所有页面逐张人工签字。R2-17已补本节所列普通深色字段2组像素与人工检查，但不扩写为全部主题／弹窗／状态。上述未验证范围与第三遍1920等待失败分别记录；没有“全通过”结论。

## M1、M2、S1实现与复核

| 清单 | 修复提交 | 实现与证据 |
| --- | --- | --- |
| M1 | `2f17cdb` | 反照率下限`.6/.588/.552`；深色肩部起点`.8`、强度`5`；顶点使用既有uLight，照明为`mix(1.25,1.1,uLight)`，深色1.25、浅色1.1。renderer/shader回归验证实际提交的表达式和uniform，两阶段highp一致 |
| M2 | `2f17cdb` | 岛面与岛外使用仅隐藏角色canvas、等待两帧的采样图；正常图独立保留。锚点ROI跟随实际DOM；山体ROI四项只记录，数值只判下半区纯白。深色地平线1280独立远景门槛；浅色只判有效性和相对a4f756e差值（另有既定岛外门槛） |
| S1等待 | `2f17cdb` | 单一20秒截止时间，最新两轮覆盖率差<0.3pp、隐藏ROI均值差<1、截图时窗间隔≥400ms同时成立；没有改变这些判据。超时／迟到均失败并恢复visibility。新增可在8秒后继续等待及20秒边界回归 |
| S1帧数 | `2f17cdb` | 每轮正常／隐藏PNG前后，各用一次page.evaluate同时读时间戳和data-world-frames；PNG之后的检查点在decodePng前记录。记录实际提交帧率，避免把解码或截图调用当作纯GPU耗时 |

新增等待回归先在8秒实现上失败，修改后10项等待／帧率工具测试通过；之前的shader浅色错误、ROI边界RED均保留。原有浅色1050覆盖率用例没有删除。

本次生产参数没有新增改动。相机、曝光、泛光、岛半径、结晶带、pointGain及背景颜色保持原样。父转场方案4.2/4.3已写回阶段1值和随锚点采样的说明。

## 五组数值结果与逐帧值

真实Chromium / NVIDIA RTX5080 Laptop / ANGLE D3D11，DPR1，160网格、65536点。全部截图和原始JSON保留。有效率表列中位数；地平线有效性断言检查五帧全部≥85%。山体ROI有效率、均值、p95、岛内纯白只记录。远景60–90只用于深色地平线1280。

浅色均值156.980471，与保留的a4f756e基线157.011693相比变化约0.031222，满足≤3。1920本次实际等候7988.6ms，接近原8秒，不能据这一次运行反推上一轮超时无效，也不能声称20秒上限提高了渲染速度。

| 场景 | 实际等待ms | ROI有效率中位数% | 岛面均值 | p95 | 岛内纯白% | 下半区纯白% | 岛外MAD | 远景p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dark-horizon-1050 | 7429.7 | 98.933333 | 101.6752 | 167.0000 | 0.000000 | 0.005330 | 12.7334 | 99 |
| dark-horizon-1280 | 4666.2 | 98.627451 | 100.7845 | 166.6667 | 0.000000 | 0.004365 | 8.2428 | 82 |
| dark-horizon-1920 | 7988.6 | 96.886275 | 93.7174 | 171.0000 | 0.005737 | 0.002638 | 6.7286 | 42 |
| dark-massif-1280 | 2354.5 | 76.760784 | 48.6232 | 115.3333 | 0.000000 | 0.000000 | 16.4456 | 191 |
| light-horizon-1280 | 2889.2 | 98.133333 | 156.9805 | 175.6667 | 0.000000 | 0.000000 | 15.6750 | 243 |

### dark-horizon-1050 正式五帧

| 帧 | ROI有效率% | 均值 | p95 | 岛内纯白% | 下半区纯白% | 岛外MAD | 远景p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 98.839216 | 103.719143 | 167.000000 | 0.000000 | 0.005864 | 12.556297 | 99 |
| 1 | 98.960784 | 101.072819 | 165.000000 | 0.000000 | 0.005864 | 12.552733 | 100 |
| 2 | 99.003922 | 103.128596 | 167.000000 | 0.000000 | 0.003731 | 13.066161 | 99 |
| 3 | 98.933333 | 101.675199 | 167.333333 | 0.000000 | 0.005330 | 12.953397 | 99 |
| 4 | 98.764706 | 100.412680 | 168.333333 | 0.000000 | 0.005330 | 12.733397 | 99 |

### dark-horizon-1280 正式五帧

| 帧 | ROI有效率% | 均值 | p95 | 岛内纯白% | 下半区纯白% | 岛外MAD | 远景p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 98.690196 | 102.128468 | 167.333333 | 0.012726 | 0.006349 | 7.834096 | 82 |
| 1 | 98.627451 | 101.484287 | 166.666667 | 0.000000 | 0.004365 | 8.011763 | 81 |
| 2 | 98.670588 | 100.784521 | 165.333333 | 0.000000 | 0.003175 | 8.242779 | 82 |
| 3 | 98.376471 | 100.445003 | 165.333333 | 0.000000 | 0.003968 | 8.496306 | 82 |
| 4 | 98.243137 | 100.459434 | 167.000000 | 0.000000 | 0.005159 | 8.498936 | 81 |

### dark-horizon-1920 正式五帧

| 帧 | ROI有效率% | 均值 | p95 | 岛内纯白% | 下半区纯白% | 岛外MAD | 远景p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 98.356863 | 97.064396 | 171.000000 | 0.012953 | 0.002739 | 6.498876 | 42 |
| 1 | 98.003922 | 95.533448 | 168.666667 | 0.000000 | 0.002131 | 6.606269 | 42 |
| 2 | 96.886275 | 93.717359 | 168.333333 | 0.006164 | 0.002638 | 6.728648 | 42 |
| 3 | 94.650980 | 92.146827 | 171.000000 | 0.005737 | 0.002638 | 6.780697 | 42 |
| 4 | 91.670588 | 88.917767 | 173.333333 | 0.005620 | 0.002435 | 6.745279 | 42 |

### dark-massif-1280 正式五帧

| 帧 | ROI有效率% | 均值 | p95 | 岛内纯白% | 下半区纯白% | 岛外MAD | 远景p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 76.423529 | 48.486097 | 116.000000 | 0.000000 | 0.000000 | 16.269195 | 201 |
| 1 | 76.733333 | 48.637798 | 116.333333 | 0.000000 | 0.000000 | 16.344069 | 198 |
| 2 | 76.847059 | 48.680139 | 115.333333 | 0.000000 | 0.000000 | 16.445591 | 191 |
| 3 | 76.874510 | 48.623222 | 112.666667 | 0.000000 | 0.000000 | 16.488024 | 187 |
| 4 | 76.760784 | 48.529119 | 111.333333 | 0.000000 | 0.000000 | 16.518606 | 188 |

### light-horizon-1280 正式五帧

| 帧 | ROI有效率% | 均值 | p95 | 岛内纯白% | 下半区纯白% | 岛外MAD | 远景p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 97.117647 | 157.020680 | 175.666667 | 0.000000 | 0.000000 | 16.031361 | 243 |
| 1 | 97.494118 | 157.242392 | 175.666667 | 0.000000 | 0.000000 | 15.674985 | 243 |
| 2 | 98.133333 | 156.980471 | 175.666667 | 0.000000 | 0.000000 | 15.613177 | 243 |
| 3 | 98.341176 | 156.938745 | 175.666667 | 0.000000 | 0.000000 | 15.572636 | 243 |
| 4 | 98.776471 | 156.510915 | 175.666667 | 0.000000 | 0.000000 | 15.868662 | 243 |

## 保留的历史岛外基线与本次候选

以下历史数值读取自收尾前的完整基线JSON，没有重采。完整文件现归档于 `E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/closeout/world-island-baseline.full-346b0c0.json`，SHA256为`7C43897CC15950BB8354CF4187693C137DF2F63561B68551F21DBB40F0294E20`。历史各版本先按每轮五帧取中位数，再列出十轮均值；本次正式闸门列单轮五帧中位数。按已批准口径，岛外上限=d5e31ad十轮均值+0.35×(287a3af十轮均值−d5e31ad十轮均值)。候选十次岛外原值另列于后文逐轮表，不能用历史σ代替候选σ。

| 主题／宽度 | d5e31ad | 287a3af | a4f756e | 岛外上限 | 本次正式闸门 | 候选十次均值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dark-1280 | 5.838059 | 36.344590 | 13.579124 | 16.515345 | 8.242779 | 8.370363 |
| dark-1050 | 8.221948 | 44.254746 | 19.023075 | 20.833427 | 12.733397 | 12.535326 |
| dark-1920 | 3.510780 | 19.161258 | 8.802066 | 8.988447 | 6.728648 | 6.691205 |
| light-1280 | 19.877717 | 83.127350 | 15.669897 | 42.015089 | 15.674985 | 15.705531 |

历史岛外指标的十轮原始中位数（顺序run-0到run-9；各轮五帧原值保留在上述worklogs完整归档的sources.runs中）：

| 主题／宽度 | 版本 | 十次原始值 |
| --- | --- | --- |
| dark-1280 | d5e31ad | 5.842764、5.838865、5.838215、5.838603、5.838187、5.839364、5.827820、5.838478、5.839722、5.838572 |
| dark-1280 | 287a3af | 36.456656、36.359067、36.332294、36.378494、36.393950、36.316283、36.391578、36.327104、36.260734、36.229738 |
| dark-1280 | a4f756e | 13.585264、13.607520、13.611101、13.595816、13.612160、13.595344、13.548940、13.544225、13.550146、13.540724 |
| dark-1050 | d5e31ad | 8.203685、8.202276、8.249554、8.249546、8.244234、8.247096、8.246823、8.194538、8.191754、8.189977 |
| dark-1050 | 287a3af | 44.233995、44.264913、44.269332、44.228069、44.268637、44.273652、44.250121、44.268250、44.237981、44.252509 |
| dark-1050 | a4f756e | 19.061801、19.102130、19.114413、19.030722、19.147643、19.131945、19.228174、18.873738、18.761581、18.778602 |
| dark-1920 | d5e31ad | 3.508944、3.511391、3.510503、3.512561、3.512584、3.511126、3.510247、3.510729、3.506961、3.512754 |
| dark-1920 | 287a3af | 19.160465、19.164634、19.145524、19.173655、19.167484、19.171365、19.165044、19.145556、19.173464、19.145389 |
| dark-1920 | a4f756e | 8.802774、8.802437、8.786253、8.801119、8.796362、8.794715、8.810359、8.819413、8.809572、8.797652 |
| light-1280 | d5e31ad | 19.899747、19.869358、19.868929、19.867784、19.869522、19.865142、19.898200、19.873472、19.867551、19.897466 |
| light-1280 | 287a3af | 83.123679、83.133915、83.132590、83.136467、83.110225、83.129491、83.127048、83.116291、83.131662、83.132132 |
| light-1280 | a4f756e | 15.635151、15.632227、15.622695、15.637392、15.651302、15.752979、15.629996、15.719139、15.669660、15.748431 |

历史采样使用当时已批准的等待方法；按本轮明确指令保留原值，不以新的20秒联合等待重采。worklogs完整归档保存原始相机锚点、渲染器及每轮数据来源，可与本次样本区分。版本化测试基线只保留读取和推导限值所需的摘要，不再携带绝对路径、GPU字符串或逐帧数据。

## 截图与提交帧率比较

下文FPS只表示data-world-frames的提交速率，不是显示帧率或GPU完成数。1920的PNG调用较久，但全观测提交率仅比1280低约1.05%，本次数据不支持“1920因明显整体帧率下降而更慢”的判断。截图窗口内的提交率低于空档，与采集开销一致；没有无截图对照，不能作严格因果归因。

### 第四次修订：等待采样中的世界提交帧率

单位FPS表示成功提交到世界渲染器的帧数/秒，不是显示器帧率或已完成GPU帧率。加权率按各窗口总帧增量/总时长计算，零帧窗口没有丢弃。

| 场景 | 等待ms | 观测数 | 全观测窗口提交FPS | 截图窗口FPS | 非截图空档FPS | 跨轮空档FPS | 普通截图均时ms | 隐藏截图均时ms | 截图占观测时间 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| dark-horizon-1050 | 7429.7 | 13 | 237.795 | 228.277 | 240.541 | 240.384 | 64.023 | 63.015 | 22.39% |
| dark-horizon-1280 | 4666.2 | 8 | 235.384 | 219.684 | 240.598 | 239.739 | 71.250 | 72.138 | 24.93% |
| dark-horizon-1920 | 7988.6 | 11 | 232.907 | 218.681 | 239.003 | 238.514 | 107.236 | 107.273 | 30.00% |
| dark-massif-1280 | 2354.5 | 4 | 234.248 | 222.080 | 240.603 | 239.798 | 99.775 | 96.100 | 34.31% |
| light-horizon-1280 | 2889.2 | 5 | 235.899 | 225.170 | 240.312 | 240.048 | 84.700 | 79.620 | 29.15% |

1920相对1280：全观测提交率比0.9895；截图窗口率比0.9954；空档率比0.9934。

这些是同次采集中的时间窗口比较。截图窗口含完整截图API与检查点往返，而非纯GPU绘制；没有无截图对照，不能把差异全部归因于截图，也不能声称把等待上限改到20s提升了帧率。

## dark-horizon-1280 等待序列

| 次序 | 隐藏截图前相对时间ms | data-world-frames | ROI均值 | 覆盖率% | 距前次ROI起点提交FPS |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 175.1 | 560 | 45.262937 | 9.693651 | — |
| 1 | 812.0 | 708 | 80.015634 | 19.423810 | 232.376 |
| 2 | 1437.2 | 857 | 88.146971 | 22.303571 | 238.324 |
| 3 | 2049.1 | 1002 | 92.298333 | 23.017857 | 236.967 |
| 4 | 2682.5 | 1152 | 94.668850 | 23.342460 | 236.817 |
| 5 | 3304.9 | 1296 | 99.175687 | 23.182937 | 231.362 |
| 6 | 3912.4 | 1440 | 101.757531 | 23.030556 | 237.037 |
| 7 | 4529.5 | 1587 | 102.293968 | 23.062698 | 238.211 |

## dark-horizon-1920 等待序列

| 次序 | 隐藏截图前相对时间ms | data-world-frames | ROI均值 | 覆盖率% | 距前次ROI起点提交FPS |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 256.6 | 560 | 55.999829 | 9.643770 | — |
| 1 | 1023.4 | 738 | 71.789645 | 13.246246 | 232.134 |
| 2 | 1773.3 | 911 | 74.671213 | 13.949269 | 230.697 |
| 3 | 2526.4 | 1084 | 77.245300 | 13.964184 | 229.717 |
| 4 | 3282.9 | 1259 | 81.984097 | 13.942167 | 231.328 |
| 5 | 4030.0 | 1435 | 86.061793 | 14.180093 | 235.578 |
| 6 | 4780.3 | 1613 | 88.681252 | 14.264103 | 237.238 |
| 7 | 5527.4 | 1788 | 91.373854 | 14.359984 | 234.239 |
| 8 | 6273.0 | 1963 | 94.246048 | 14.318994 | 234.710 |
| 9 | 7022.9 | 2137 | 95.873543 | 14.254160 | 232.031 |
| 10 | 7765.6 | 2312 | 96.776494 | 14.231940 | 235.627 |



## 人工检查与未验证范围

用户已认可上一轮山体人工图；本次另查看新保存的山体图，受光面暖色和棱角清晰，没有观察到覆盖整座山的灰雾，背光面和柱缝仍暗。该观察单列在manual，不混入allAGatesPass。

候选十次重复σ已在修复提交推送之后测量，详见下文；历史d5e31ad、287a3af、a4f756e均未重采。收尾前完整原始数值与限值摘要为`5eca34a43aea657009dee2c00a1a47da5a95589a97e30a5480650b8eac8f652b`，完整文件已归档到worklogs，瘦身后的测试JSON只保留必要摘要。旧基线和先前失败数据均保留，不以单测或人工图替代数值门槛。

上述已推送阶段1记录未运行完整Playwright、Cargo检查／测试或构建，未验证Intel、真实Tauri/WebView2或真实账号游戏流程；当时阶段2–4及浅色键盘巡检尚未开始。后续执行结果按实际验证另行补录。

## 已推送阶段1的验证

| 命令／检查 | 结果 | 日志 |
| --- | --- | --- |
| `npx playwright test tests/e2e/world-acceptance.spec.ts --grep M1/M2 --output=…/revision4-gate-results` | **5/5通过，1.0分钟** | `revision4-gate.log` |
| `npm test` | **624项Vitest＋37项Node通过** | `revision4-unit.log` |
| `npx tsc -b` | 零错误，退出0 | `revision4-tsc.log` |
| 20秒等待与提交率工具回归 | RED后10项通过 | `revision4-wait-red.log` / `revision4-wait-green.log` |
| 独立静态复核、git diff --check | 未发现代码阻塞项；diff检查通过 | 相机测试限定于y=3逻辑足迹，未冒充地形顶面像素检查 |

## 文件与证据

修复文件：`src/components/world/shaders.ts`、`renderer.test.ts`、`camera.test.ts`；`tests/e2e/helpers/world-appearance.ts`与`world-appearance-capture.ts`；`tests/e2e/world-acceptance.spec.ts`；两份world-appearance Node测试；`tests/e2e/data/world-island-baseline.json`；本轮清单、父转场方案及本报告。

证据根：`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/`。

- 五组正式原始图与数据：`revision4-gate-results/<用例>/anchored-island/`，包含settling.json、measurements.json、所有等待图及normal-0..4/island-0..4。
- 汇总：`revision4-result/acceptance.json`，numeric与manual分开，五组数值allAGatesPass=true；repeatability单列补测结果，S1=通过。
- 代表图：`revision4-result/{dark-horizon-1280,dark-horizon-1050,dark-horizon-1920,light-horizon-1280,dark-massif-1280}-{normal,island}.png`。代表第3帧，不冒充所有指标同时处于中位数。
- 山体人工图：`revision4-result/dark-massif-1280-manual.png`。
- 帧数／时窗原始分析：`revision4-fps.json`、`revision4-fps.md`、`analyze-revision4.mjs`。
- 上一轮8秒失败完整报告：`report-before-revision4.md`；更早的失败数据仍在原目录，未覆盖。

## 推送后的候选十次重复

采样版本固定为 `2f17cdb14e5d6bec41cd0a846146f02436cf30a5`。开始于 `2026-11-05T05:02:18.638Z`，结束于 `2026-11-05T05:11:58.591Z`（均为UTC；本地Asia/Singapore加8小时）。新开浏览器及上下文逐次串行采集，每场景预先限定十次，共50次；不重试、不替换失败、不剔除异常。始末源码哈希一致，采集期间工作区干净，历史基线未重采。

每次使用同一20秒等待与既定判据，稳定后保留五张正常图及五张仅隐藏角色的采样图；先按五帧取中位数，再对十个中位数算总体标准差 σ=√(Σ(x−均值)²/10)。覆盖率σ单位是百分点（pp）。这次使用固定提交的Vite开发服务与真实D3D11 Chromium，未构建或验证Tauri/WebView2本体。

M1/M2逐次门槛：**50/50通过**；S1：**通过**。原始记录无缺失，完整性校验通过；采集失败、数值失败和运行错误分别保留，不以人工结论代替数值。山体ROI统计仍只记录；其σ同时列出，但不恢复已取消的岛面绝对门槛。

| 场景 | 完成／数值通过 | 岛面均值σ | 覆盖率σ(pp) | 实际等待最短–最长(ms) | 十次均值中位数范围 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 深色地平线 1280×720 | 10/10、10/10 | 0.264949 | 0.201090 | 4481.0–5226.1 | 100.5283–101.4169 |
| 深色地平线 1050×720 | 10/10、10/10 | 0.182471 | 0.010182 | 6616.9–6713.5 | 102.7526–103.2739 |
| 深色地平线 1920×1080 | 10/10、10/10 | 0.301466 | 0.012488 | 7671.5–7760.3 | 94.4712–95.3025 |
| 浅色地平线 1280×720 | 10/10、10/10 | 0.007342 | 0.010388 | 2777.2–2834.6 | 157.1133–157.1387 |
| 深色山体 1280×720 | 10/10、10/10 | 0.008319（记录） | 0.020958 | 2308.8–2974.9 | 48.6169–48.6495 |

以下轮号沿用原始目录run-0至run-9，每个数值均为该轮五帧中位数。M1/M2列只汇总既定数值项；纯白与ROI有效性、完整五帧及等待过程保存在worklogs完整基线归档和原始采样文件中。

### 深色地平线 1280×720：十次原始结果

| 轮 | 等待ms | 岛面均值 | p95 | 岛外MAD | 覆盖率% | M1/M2 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 5135.7 | 100.528304 | 166.3333 | 8.469904 | 23.678175 | 通过 |
| 1 | 4481.0 | 101.255289 | 166.3333 | 8.132019 | 23.222619 | 通过 |
| 2 | 5173.1 | 100.694213 | 166.3333 | 8.468430 | 23.678968 | 通过 |
| 3 | 5116.9 | 100.964555 | 166.3333 | 8.480970 | 23.611508 | 通过 |
| 4 | 4521.8 | 101.416872 | 165.6667 | 8.128874 | 23.215476 | 通过 |
| 5 | 5188.6 | 100.718764 | 166.3333 | 8.472907 | 23.644048 | 通过 |
| 6 | 5135.4 | 100.752766 | 165.6667 | 8.462631 | 23.651984 | 通过 |
| 7 | 5226.1 | 100.750076 | 166.3333 | 8.455991 | 23.681349 | 通过 |
| 8 | 4532.8 | 100.855728 | 165.3333 | 8.150422 | 23.234524 | 通过 |
| 9 | 5154.1 | 100.651084 | 166.0000 | 8.481483 | 23.678571 | 通过 |

原始数据和截图：`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/candidate-repeatability/dark-horizon-1280x720/run-0..9/`。每轮包含`settling.json`、`measurements.json`、`attempt.json`、全部等待图与`normal-0..4.png`／`island-0..4.png`。

### 深色地平线 1050×720：十次原始结果

| 轮 | 等待ms | 岛面均值 | p95 | 岛外MAD | 覆盖率% | M1/M2 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 6646.8 | 103.056539 | 166.3333 | 12.575754 | 33.148721 | 通过 |
| 1 | 6679.3 | 103.004930 | 167.3333 | 12.521022 | 33.113006 | 通过 |
| 2 | 6636.9 | 103.273921 | 166.6667 | 12.548365 | 33.119936 | 通过 |
| 3 | 6680.4 | 103.156852 | 166.6667 | 12.522167 | 33.120469 | 通过 |
| 4 | 6700.1 | 102.802828 | 166.6667 | 12.522001 | 33.116205 | 通过 |
| 5 | 6689.9 | 102.902712 | 166.6667 | 12.522100 | 33.123667 | 通过 |
| 6 | 6676.1 | 103.043514 | 167.0000 | 12.525106 | 33.115139 | 通过 |
| 7 | 6713.5 | 102.752598 | 166.3333 | 12.524927 | 33.123134 | 通过 |
| 8 | 6654.4 | 102.777253 | 167.3333 | 12.554717 | 33.129531 | 通过 |
| 9 | 6616.9 | 103.262981 | 166.6667 | 12.537098 | 33.134328 | 通过 |

原始数据和截图：`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/candidate-repeatability/dark-horizon-1050x720/run-0..9/`。每轮包含`settling.json`、`measurements.json`、`attempt.json`、全部等待图与`normal-0..4.png`／`island-0..4.png`。

### 深色地平线 1920×1080：十次原始结果

| 轮 | 等待ms | 岛面均值 | p95 | 岛外MAD | 覆盖率% | M1/M2 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 7680.7 | 95.161347 | 170.3333 | 6.685203 | 14.497768 | 通过 |
| 1 | 7700.3 | 94.471197 | 169.6667 | 6.692900 | 14.521307 | 通过 |
| 2 | 7760.3 | 94.765665 | 169.3333 | 6.705454 | 14.533989 | 通过 |
| 3 | 7688.8 | 94.750888 | 170.0000 | 6.690331 | 14.514915 | 通过 |
| 4 | 7700.4 | 95.142594 | 171.3333 | 6.689037 | 14.510856 | 通过 |
| 5 | 7671.5 | 95.258015 | 171.0000 | 6.689801 | 14.509233 | 通过 |
| 6 | 7692.8 | 95.302486 | 170.6667 | 6.689450 | 14.512277 | 通过 |
| 7 | 7689.9 | 95.224242 | 169.6667 | 6.681068 | 14.494521 | 通过 |
| 8 | 7718.2 | 94.865697 | 171.0000 | 6.689651 | 14.514205 | 通过 |
| 9 | 7738.7 | 94.477357 | 169.6667 | 6.699157 | 14.534700 | 通过 |

原始数据和截图：`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/candidate-repeatability/dark-horizon-1920x1080/run-0..9/`。每轮包含`settling.json`、`measurements.json`、`attempt.json`、全部等待图与`normal-0..4.png`／`island-0..4.png`。

### 浅色地平线 1280×720：十次原始结果

| 轮 | 等待ms | 岛面均值 | p95 | 岛外MAD | 覆盖率% | M1/M2 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 2808.9 | 157.125647 | 175.6667 | 15.722951 | 25.259921 | 通过 |
| 1 | 2824.7 | 157.136000 | 175.6667 | 15.676896 | 25.251587 | 通过 |
| 2 | 2818.4 | 157.128641 | 175.6667 | 15.719065 | 25.254762 | 通过 |
| 3 | 2785.7 | 157.113307 | 175.6667 | 15.678124 | 25.232540 | 通过 |
| 4 | 2834.6 | 157.120327 | 175.6667 | 15.717578 | 25.259921 | 通过 |
| 5 | 2804.9 | 157.138732 | 175.6667 | 15.711163 | 25.267063 | 通过 |
| 6 | 2815.3 | 157.126235 | 175.6667 | 15.718792 | 25.259921 | 通过 |
| 7 | 2800.2 | 157.127830 | 175.6667 | 15.725772 | 25.259524 | 通过 |
| 8 | 2777.2 | 157.117974 | 175.6667 | 15.669684 | 25.238492 | 通过 |
| 9 | 2820.2 | 157.129203 | 175.6667 | 15.715291 | 25.262302 | 通过 |

原始数据和截图：`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/candidate-repeatability/light-horizon-1280x720/run-0..9/`。每轮包含`settling.json`、`measurements.json`、`attempt.json`、全部等待图与`normal-0..4.png`／`island-0..4.png`。

### 深色山体 1280×720：十次原始结果

| 轮 | 等待ms | 岛面均值 | p95 | 岛外MAD | 覆盖率% | M1/M2 |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 0 | 2932.7 | 48.649506 | 113.0000 | 16.483744 | 36.251587 | 通过 |
| 1 | 2974.9 | 48.630947 | 113.3333 | 16.490843 | 36.250397 | 通过 |
| 2 | 2969.5 | 48.634268 | 113.3333 | 16.490269 | 36.254365 | 通过 |
| 3 | 2941.2 | 48.637455 | 113.3333 | 16.486858 | 36.250397 | 通过 |
| 4 | 2967.5 | 48.633054 | 113.3333 | 16.494097 | 36.270635 | 通过 |
| 5 | 2939.0 | 48.621863 | 113.3333 | 16.480861 | 36.254365 | 通过 |
| 6 | 2308.8 | 48.616933 | 115.6667 | 16.446219 | 36.309921 | 通过 |
| 7 | 2933.5 | 48.633070 | 113.0000 | 16.481901 | 36.233333 | 通过 |
| 8 | 2916.1 | 48.627852 | 113.0000 | 16.483818 | 36.230159 | 通过 |
| 9 | 2928.4 | 48.630401 | 113.6667 | 16.478739 | 36.254762 | 通过 |

原始数据和截图：`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/candidate-repeatability/dark-massif-1280x720/run-0..9/`。每轮包含`settling.json`、`measurements.json`、`attempt.json`、全部等待图与`normal-0..4.png`／`island-0..4.png`。

### 补测验证与证据边界

- 采集命令：`node E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/capture-candidate-repeatability.mjs`；日志`candidate-repeatability.log`，全部预定50次已执行。
- 统计命令：`node E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/analyze-candidate-repeatability.mjs`；从五帧原始数字独立复算各轮中位数、σ、等待判据和各项门槛，并检查截图存在、锚点/布局不变、真实GPU、DPR、网格/点数及计数器时间戳单调。
- 追加基线后再次复算：脚本从`git show 2f17cdb:tests/e2e/data/world-island-baseline.json`读取采样时的不可变基线，字节SHA与采样记录一致；当前工作区只额外核查历史source/限值摘要。复算结果另存`candidate-repeatability-reproduced.json/.md`，严格比较5组、50轮、250帧及416条等待记录全部相同，证明追加结果没有改变历史依据。比较证据为`candidate-repeatability-reproduction-check.json`，原始分析未覆盖。
- `candidate-repeatability-analysis.json`保留全部250帧数值、等待时序、帧数与四个截图检查点；`.md`为50次完整数值表和额外旧覆盖率限值对照。补测时曾追加到版本化JSON的`candidateRepeatability`；阶段1收尾时，完整数据随`world-island-baseline.full-346b0c0.json`归档到worklogs，版本化基线只保留必要摘要和限值，未更改原有门槛。
- 本次补测是自动数字复核，没有新增人工视觉签字；山体人工检查沿用前文独立记录。完整Playwright、Cargo、安装包、Intel、真实Tauri/WebView2、浅色键盘巡检和阶段2–4仍未执行。
- 初次五组闸门的1280／1920提交率比较及局限见前文。所有补测等待也保存data-world-frames和时间戳，但没有进行无截图对照实验。

## 阶段2–3后续复核：历史STOP，后经用户第六次修订恢复

**本节记录停止时的历史状态；用户批准第六次indicator参考修订后已恢复，最新进度见后节。**已完成的阶段4是独立提交`8a9ed455ccbaf48df01ab2a69d4693a82282258a`，此前已普通推送并确认远端；其完整Playwright252/252、npm674项Vitest＋77项Node和TypeScript退出0均为真实历史结果。下面的7通过／4失败及逐项表保留当时未提交工作的原貌，不能把C4的通过当成当前工作区的全套通过，也不能因后续新RED否定C4当时实际运行的252/252。

本轮最初原生焦点／加载器检查实际为**7通过、4失败，0跳过、0flaky，43.4秒，退出1**，见[review23-focus-red.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23-focus-red.log)及[原始JSON](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23-focus-red.json)。除选中框颜色、输入边框与加载器位置的可复现缺陷外，还发现旧indicator无法满足Lite／减少动态下实际相邻背景≥3:1的要求，当时按用户“验收／参数冲突先停止报告”的规则冻结全部后续工作。该停止节点没有修改indicator、世界参数、阈值、采样区域或第8／13项产品CSS；后续修改经用户第六次决定批准后才实施，不能改写原RED。

### 冲突的实际像素与证据边界

Lite未选中卡片的真实焦点环为`rgb(90,146,5)`。在已保存PNG的x=632处，y=460／461两行实际环像素均为该颜色，**紧邻的y=462背景像素为`rgb(228,226,220)`，对比度2.921666582751533:1，小于3:1**；原探针底部(632,465)读取同样背景及比值。右侧(837,367)为`rgb(228,226,221)`，比值2.923582458283364:1。减少动态的未选中卡片也复现相邻对比不足；full模式该未选中卡片的最低值为3.350953345846304:1。重新读取现有PNG的立即相邻像素没有消除失败，不需要另起GPU运行即可确认这组已采像素的数值冲突。

原始证据为[focus-lattice-unselected-lite.png](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23-focus-red/accessibility-focus-R2-01--91a03-ines-remain-visible-in-lite/focus-lattice-unselected-lite.png)、[keyboard-focus.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23-focus-red/accessibility-focus-R2-01--91a03-ines-remain-visible-in-lite/keyboard-focus.json)及[adjacent-edge-pixels.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23-focus-red/accessibility-focus-R2-01--91a03-ines-remain-visible-in-lite/adjacent-edge-pixels.json)；独立PNG扫描脚本为`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23-focus-pixel-diagnostic.mjs`。主流程已查看该PNG及源码；画面可见阅读面后的世界，源码存在透明阅读面，因此“世界经透明阅读面参与合成后压低了实际相邻背景亮度”是目前有依据的来源推断。尚未做改变世界／移除透明面的对照实验，不能把这一推断写成已用反事实实验排除所有其他合成因素的因果证明。实际相邻像素与对比度失败本身已测得，不依赖该因果推断成立。

### 14项逐条状态（均以停止时为准）

| 复核项 | 已完成的部分与实际证据 | 尚未完成／停止边界 |
| --- | --- | --- |
| 1 完整层序及降级玻璃／chrome | C4已修最早完整层序，原生CSSOM层序检查真实通过 | 新增实底／无blur等材质断言已在后续测试中准备，尚未运行，不能写为新降级验收通过 |
| 2 导航真实折射URL与条纹 | 已包含在C4；深浅真实URL／条纹回归及C4完整套件已通过 | 无需重写C4归属，不以新增未运行测试冒充另一轮通过 |
| 3 Stop被无关busy禁用 | 后续实现已收窄为`busy === "game.stop"`，保留重复Stop守卫；对应单测已修 | 包含在本轮行为单测68/68中；尚无本轮完整套件验证 |
| 4 Authlib双行profile按钮 | 已由固定md高度改为按内容定高的语义行按钮；强化原生RED按真实padding内容区复现越界；行为单测68/68通过 | 改后原生GREEN尚未运行，不能把早期只看外框的无效证明或单测当成视觉通过 |
| 5 同id Toast节点／角色／关闭 | C4已有单节点、无隐藏副本、可用关闭与焦点保持；本轮新增info→info保持status角色用例。Toast＋S2专项3/3通过、0失败／跳过／flaky，errors=[]，见`review23/toast-picker.json`及同名log | info→error按语义变为alert，不要求错误地冻结旧status；专项3/3不代表整个后续复核完成 |
| 6 卡片current属性及旧e2e | C4已统一到真实键盘目标和点框语义，并通过C4完整套件 | 无需把既有完成项重复计作本轮新增产品修复 |
| 7 forced-colors独立Highlight | 新测试用真实DOM系统色probe，库／探索均为实际`rgb(55,0,110)`；对应原生用例通过 | 本项通过限于已执行的两个搜索控件与模式；未扩写为所有系统色场景 |
| 8 逐站焦点indicator及实际背景对比 | 新原生RED在full／Lite／减少动态均测得选中框`rgb(36,37,34)`、输入边框`rgba(50,45,36,.26)`，没有等于indicator；Lite／减少动态未选中框虽颜色正确，实际相邻对比仍不足3 | **阻断项。**相关产品CSS未动，未改indicator或世界参数；不存在GREEN。按用户规则停止，等待对验收／参数冲突的决定 |
| 9 Project／账号／菜单选中语法 | Project current移到Details按钮，去选中填充／阴影和描述文字600；账号选中hover及玻璃菜单selection-fill已做局部修复。HomePage＋ProjectCard＋AccountsPage行为单测68/68通过 | flat菜单产品覆盖仍待有效原生RED；最初“General无Select”及随后触发器／popup选择器歧义两次无效测试流程均保留、已纠正测试入口，但纠正后有效RED尚未运行；本项原生GREEN未运行，整体未完成 |
| 10 仓库像素层级与深色大面积填充 | 后续已准备真实页面像素探针及实例／版本目录详情覆盖 | 新测试尚未运行，浅色page＜panel＜card每级≥4、preview亮于page及深色allowed-set在本轮均未获得GREEN；不沿用外部旧审计冒充守护已通过 |
| 11 降级材质及源码守护范围 | 后续优先准备实际浏览器cascade／fallback实底与blur断言 | 新材质测试尚未运行。外部entry／CSS-contract源码扫描脚本未纳入npm guard，已明确不属于当前持续守护范围；不声称已经集成，也不据此增设脚本 |
| 12 LibraryDrill非空identity | 加非空断言先真实失败1/13（空字符串），每份CSS独立展开layer后，与helper合跑21/21通过 | 证据为`review23/library-identity-red.log`及`library-identity-green.log`；仅证明该组件单测不再空值相等，不替代生产浏览器级联 |
| 13 loader status相对Select位置 | 原生RED实测相对Select的left／bottom均仅6px，目标为12px，两个位置断言失败 | 产品CSS未修改，改后GREEN未运行；随第8项冲突冻结，不声称位置已修 |
| 14 历史阶段3报告归属 | 本轮已在历史R2-07行直接注明层序／真实折射回归后来由C4 `8a9ed455ccbaf48df01ab2a69d4693a82282258a`修复；没有改写阶段3原提交内容。外部源码守护未集成也已明确披露；闲置`.vx-settings-heading`规则已删除 | 这些只是本轮未提交工作的一部分；尚未提交／推送，不把文档与闲置CSS清理写成14项全部完成 |

行为实现及RED／GREEN细节见[review23-behaviors-implementation.md](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23-behaviors-implementation.md)，焦点／加载器及像素冲突见[review23-focus-notes.md](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23-focus-notes.md)，初始只读映射见[review23-audit.md](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23-audit.md)。其中早期审计是当时快照；本节停止记录与后续第六次修订分别保留。仍保持main，未改版本／依赖、未构建安装包。

## 阶段2–3后续C23：第六次修订最终复核（历史，indicator口径已被第七次取代）

本节保留 C23 当时的验证与完整套件结果。2026-11-06 独立复核确认，第六次采用的最暗单像素 (415,471)、(893,234) 落在字形或1px分隔线前景上，不能代表相邻底色。由此取得的 `#91918c` 参考把默认 indicator 压成 `#1c4f00`，比 ink `#3f7400` 更暗；第七次修订已改用完整相邻边的中位色。以下第六次“最终”均仅指当时批次，不能作为当前 indicator、取样方法或本轮全套结果；旧RED、重算原因及所有原始样本原样保留。

**C23提交前最终验证全部通过：68文件677项Vitest＋77项Node，TypeScript退出0，完整Playwright 265/265通过、0失败／跳过／flaky、errors=[]，24.6分钟。**全部265项均首次通过，没有靠重试取得GREEN。当前14项实现、清单第六次修订和本报告合入同一笔指定提交 `fix: close phase 2–3 review findings`；C23指本节所属的该提交，完整SHA与普通推送后的远端确认记录在 `review23/commit-receipt.json`，最终交付同时给出。C4已推送的完整SHA仍为 `8a9ed455ccbaf48df01ab2a69d4693a82282258a`。

本节是提交前的验证快照，推送事实以提交后回执为准；可在仓库用 `git log -1 --format=%H --grep='^fix: close phase 2–3 review findings$'` 解析C23。下表明确每项的修复／测试归属，不把C4已完成的修复冒充C23新增实现。
### 第六次indicator初次参考与保留限制（一次重算前历史）

初次新增参考色是从48个已保存的实际相邻背景样本中取得最暗实测`(228,226,220)`，逐通道减4，得到`(224,222,216)`即`#e0ded8`，作为固定计算参考，与原三种浅色表面共同要求indicator≥3:1。当时默认浅色indicator由`#5a9205`变为`#558c00`；对初次参考色为3.0383583310198183:1。`accent-ink`保留`#3f7400`，对初次参考为4.207981067095447:1，低于4.5；用户明确要求本轮保留ink，不把该文字色写成也满足4.5。此初次参考后由完整路线实测触发且仅触发一次获准重算，最终值与最终ink限制见下节。没有修改阅读面透明度、世界参数、原对比度门槛或既有测量区域。

[revision6-accent-initial.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-accent-initial.json)对照C4源码，记录默认绿／白／黄／青四种强调色在深浅主题共8组的完整角色值，`onlyIndicatorChanged=true`；所有非indicator字段保持一致，深色indicator也保持原值。该结果是已列8组的源码计算比较，不是全部任意强调色的穷举。原accent测试先4失败／5通过，再9/9通过，日志为`review23/revision6-accent-red.log`及`revision6-accent-green.log`。

选中Lattice焦点轮廓已显式用indicator，避免被后置selection文字色改写；Field焦点边框覆盖已修；加载器status已补偿外层6px。首轮[revision6-focus.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-focus.json)为11通过、0失败／跳过／flaky、42.5秒。实际加载器[loader-status-inset.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-focus/field-focus-M4-loading-sta-a4e49-et-inside-the-loader-Select/loader-status-inset.json)记录left=12px、bottom=12px，原6px RED保留；forced-colors搜索和可见Lattice轮廓均等于独立系统Highlight `rgb(55,0,110)`。此批对部分站位仍以规定表面计算对比，因此只作为初次专项历史，不能单独证明完整Tab路线实际相邻像素达标；扩充后的RED与一次重算GREEN另列如下。

### 扩充576点：一次获准重算与最终焦点专项

扩充检查每种模式的42个真实经过Tab站位与6个具名焦点站位，每站保留原四个采样点，三模式共576点。在初次`#558c00`下，三模式均有两处新失败：网格按钮旁(893,234)为`rgb(208,204,197)`、比值2.5548201726478093；原版分段下方(415,471)为`rgb(149,149,144)`、比值1.3585643490733013。主流程查看原PNG，第二处包含邻近label边缘合成，halo前后该点alpha均为0，不能归为halo前景；没有移动、排除该点或改原采样区域。扩充批次[revision6-focus-all-stations.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-focus-all-stations.json)为0通过／3失败、0跳过／flaky，38.1秒；首次11项GREEN没有覆盖这两处新证据。

用户允许的**一次重算已使用**：取全部576个已保存样本的最暗值`(149,149,144)`逐通道减4，得到最终参考`(145,145,140)`即`#91918c`。常量注释链接[revision6-expanded-reference.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-expanded-reference.json)，该文件保留原样本SHA、坐标和截图。默认浅色indicator轨迹为`#5a9205`→初次`#558c00`→**最终`#1c4f00`**。最终[revision6-accent-recalculated.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-accent-recalculated.json)再次对照C4验证四种强调色×两主题共8组，onlyIndicatorChanged=true，非indicator角色及深色indicator保持一致。第二次accent测试先4失败／5通过，再9/9通过，日志为`revision6-recalculated-accent-red.log`／`revision6-recalculated-accent-green.log`。**ink仍为`#3f7400`，对最终参考仅1.788052911976136:1；这是用户明确保留的已知未处理项，不声称文字色达到4.5。**

最终[revision6-focus-recalculated.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-focus-recalculated.json)记录full／Lite／减少动态3/3通过，0失败／跳过／flaky，errors=[]，33.0秒；对应log及同名目录保留所有原始PNG与`keyboard-focus.json`。[revision6-focus-final-summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-focus-final-summary.json)独立汇总仍为每模式192点、总576点，三模式最低对比均为**3.219723461690725:1**，位置仍为原版分段下方(415,471)、背景仍为`(149,149,144)`；网格原点也保留，最终比值6.054784564224626。最终Lite原图为[原版分段](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-focus-recalculated/accessibility-focus-R2-01--91a03-ines-remain-visible-in-lite/input-lite-tab-03.png)，其余模式及全部坐标由汇总中的source路径和SHA对应。

每个经过Tab站位记录实际焦点owner、轮廓／边框及halo二维前景诊断。正常截图和原四点契约保留；只有诊断确认halo确实在某原点绘制前景时，才在同一坐标另存暂时visibility:hidden的halo下方PNG并随即恢复，不移动点、不重涂背景。两处新失败点均为普通正常截图源，不靠暂隐halo取得通过。详细实现与原生断言在`tests/e2e/accessibility-focus.spec.ts`。这次只改获准的indicator参考与色阶，不改产品世界／透明度；C4的M2第五次口径、三宽固定9.7均值门槛及真实三宽结果均保持原样。

### 已执行23项原生设计／行为检查

[revision6-design-green.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-design-green.json)记录23通过、0失败／跳过／flaky，errors=[]，154.8秒；23项均记录实际D3D11／RTX5080Laptop／DPR=1。包含六组七页设计矩阵、双主题Authlib／ProjectCard／选中hover、六种主题×降级组合、两种主题真实阅读面与实例／版本目录默认详情。flat菜单先在正确入口取得2项有效RED，只有selection-fill前后／hover比较失败，再仅改一条flat选中背景为selection-fill后合并GREEN；`revision6-flat-red.json/.log`与两次更早无效定位流程均保留。

实际无遮挡6×6角落patch中，浅色page=239.666667、panel=247、card=255，两级差7.333333和8均≥4；深色page=8.666667、preview=16，浅色preview=255，预览均亮于页面。实例及版本目录详情默认外层面板也已采样。六种降级组合×三页共48个glass／chrome／panel观察全部alpha=255、backdrop-filter=none；forced-colors预期取浏览器实际Canvas解析值。详细坐标、候选拒绝原因、截图与逐项数据见[revision6-design-summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-design-summary.json)及[说明](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/revision6-design-summary.md)。

深色填充目录只覆盖显式外层阅读容器；嵌套fact单元当前仍使用24%-solid混合，不在本次已验证目录中，不据外层通过声称详情每个嵌套单元都遵循allowed-set。各Tab／隐藏表单也未穷举。此处记录已知未验证范围，没有修改产品透明度。外部entry／CSS-contract源码扫描脚本仍未纳入npm guard，实际浏览器cascade／fallback检查与该未集成事实分别说明。

### 14项最终状态（完整套件265/265通过）

| 编号 | 归属提交 | 最终结果与证据 | 验证边界 |
| --- | --- | --- | --- |
| 1 层序及降级材质 | C4 `8a9ed45`＋C23 | C4完整层序检查保留；本轮六种主题／降级组合的48个材质观察通过 | 23项专项通过；C23完整套件265/265通过 |
| 2 真实折射 | C4 `8a9ed45`＋C23 | C4已修并有仓库URL／条纹回归及完整252项通过 | C4结果不改写，C23完整套件265/265通过 |
| 3 Stop无关busy | C23 | 当时已收窄至game.stop，行为68项单测通过；“重复Stop守卫保留”的判断已被独立复核推翻，安装busy期间仍可重入，本轮第6项补独立锁 | 历史完整npm677＋77和Playwright265/265未覆盖该重入场景，不能作为它的通过证据 |
| 4 Authlib双行 | C23 | 内容定高行已实现，1050／1440原生padding内容区、双行非重叠及session/profile命令参数用例通过 | 包含本轮23项GREEN |
| 5 Toast | C4 `8a9ed45`＋C23 | C4节点／焦点保持；后续info→info status角色及唯一可见节点验证通过，info→error按语义变alert | Toast／S2专项3/3；C23完整套件265/265通过 |
| 6 旧current断言 | C4 `8a9ed45`＋C23 | C4已统一，后续真实键盘current场景亦通过 | 不重复记为本轮新的C4产品修复 |
| 7 Highlight | C23 | 两搜索及可见Lattice轮廓均匹配独立系统色rgb(55,0,110) | 首轮11项焦点专项通过 |
| 8 指示色／逐站焦点 | C23 | 一次重算后的最终参考#91918c、indicator#1c4f00；8组角色对照、accent9项通过；扩充3模式3/3，576点全部保留，最低3.219723461690725 | 焦点专项已GREEN，完整C23套件265/265通过；ink对最终参考1.788052911976136的已知不足按用户决定保留；初次11项及随后3项RED均不改写 |
| 9 选中语法 | C23 | Project焦点current、400字重、点框；账号／glass／flat／sidebar／详情Tab的hover与selection-fill均已验证 | 有效flat RED2→合并23项GREEN，原失败保留 |
| 10 像素层级及详情 | C23 | 浅色page→panel→card差7.333333／8，双主题preview较亮，两种默认详情外层面已采样 | 明确外层目录范围；24%-solid嵌套fact、全部Tab／隐藏表单未验证，未改透明度 |
| 11 降级与守护边界 | C23 | 六种组合实底／无blur及原几何要求通过 | 外部源码脚本未集成guard，已披露；实际浏览器覆盖不等于源码守护已集成 |
| 12 LibraryDrill | C23 | 历史非空断言RED1/13→独立展开CSS后21/21 GREEN；独立复核确认相同未解析var字符串仍是同义比较 | 该批只能证明不再空值相等，不能证明身份连续性；本轮第12项改为实际身份／kind／layoutId／字母与图标断言，并补浏览器解析色 |
| 13 status位置 | C23 | Select相对left／bottom均12px，gap20px及焦点净空用例保留通过 | 首轮11项专项GREEN |
| 14 历史归属及闲置规则 | C4 `8a9ed45`＋C23 | 历史R2-07已归因C4实际SHA，闲置settings heading删除，外部guard范围已说明 | 属于C23；独立复查、最终diff与完整验证通过 |

| C23最终命令 | 当前实际结果 | 证据 |
| --- | --- | --- |
| `npm test` | 68文件677项Vitest＋77项Node通过；Node 0失败／跳过 | `review23/revision6-final-npm.log` |
| `npx tsc -b` | 主流程确认退出0，日志0字节，管线继续进入Playwright | `review23/revision6-final-tsc.log` |
| 完整Playwright | 265/265首次通过，0失败／跳过／flaky，errors=[]，24.6分钟 | `review23/revision6-full.json/.log`及`revision6-full-summary.json` |
| C23提交／推送 | 本验证快照形成于指定提交前；完整验证已通过 | 提交后完整SHA及普通推送的ls-remote确认由`review23/commit-receipt.json`记录，最终交付同步给出 |

最终265项结果已读取并独立汇总；普通提交／推送后的SHA与远端确认单列回执，不预写推送事实。嵌套24%-solid fact单元未验证的范围限制继续保留，没有借此次色阶修订改变透明度。

### C23文件归属与人工查看范围

| 文件组 | 对应复核项 |
| --- | --- |
| `src/design/accent.ts`、`accent.test.ts` | 8，第六次参考值及四种强调色的四表面对比；ink不变 |
| `src/design/global.css`、`src/visual/lattice/lattice.css`、`tests/e2e/accessibility-focus.spec.ts`、`field-focus.spec.ts` | 7、8，独立系统色、逐站真实像素、Field与选中框焦点修复 |
| `src/features/home/LaunchConsole.tsx`、`HomePage.test.tsx` | 3，无关安装busy不阻止Stop |
| `src/features/accounts/LoginDialog.tsx`、`accounts.css`、`tests/e2e/review23-behavior.spec.ts` | 4、9，两行列表与当前账号悬停；原生完整UUID、边界及IPC |
| `src/features/discover/ProjectCard.tsx`、`ProjectCard.test.tsx`、`discover.css`、`tests/e2e/harness/project-selection.{html,tsx}` | 9，可聚焦Details的current、仅点框选中与普通描述字重 |
| `src/components/ui/AnchoredListbox.css` | 9，glass／flat选项统一selection-fill |
| `tests/e2e/design-consistency.spec.ts`、`helpers/reading-surface-probe.ts` | 1、9、10、11，实测材料、选中语法、阅读面像素及两种详情 |
| `src/features/library/LibraryDrill.test.tsx`、`create-instance.css` | 12、13，非空样式断言与Select相对12px内缩 |
| `tests/e2e/toast-review.spec.ts`、`harness/toast-review.tsx`、`review-fixes.spec.ts` | 5及S2耐久覆盖，同类替换role与Tab／Enter／Escape逐帧 |
| `src/features/settings/settings.css` | 14附带清理，删除孤立heading规则 |
| 本报告、父转场规格、最终验证计划及第二轮清单 | 14历史归属、第六次裁定及完整验证记录 |

人工查看与自动数字分列：主流程查看了最终参考值下Lite未选中卡片和实例名称输入框的正常截图，两处绿色焦点轮廓与边框清晰；路径为`review23/revision6-focus-recalculated/accessibility-focus-R2-01--91a03-ines-remain-visible-in-lite/{focus-lattice-unselected-lite,focus-input-lite}.png`。主流程另查看1050 Authlib正常图，名字与完整UUID可见且两行之间、按钮之间没有重叠；路径为`review23/revision6-design-green/review23-behavior-R2-05-Au-b30ef--both-lines-without-overlap/authlib-profile-rows.png`。设计检查代理查看四张深浅实例／版本目录默认详情图，范围见`revision6-design-summary.md`。这些有限人工观察不替代全套数字断言，也没有将全部自动保存图写成人工签字。


### 最终完整套件中的独立汇总

完整结果与全部265项名称／状态见 `review23/revision6-full-summary.json`。汇总重新核对12个固定相位、5组动态闸门的实际D3D11／DPR=1、20秒内稳定条件、5帧数值和对应门槛。深色三宽固定uT=9.7的均值分别为 1050：103.387533；1280：99.361807；1920：92.053733，均在90–150；其余相位的均值仍只记录。动态均值不恢复为下限门槛，所有既定p95、纯白、覆盖率、岛外项通过。

| 动态场景 | 均值中位数（记录） | 等待ms |
| --- | ---: | ---: |
| dark/horizon/1050 | 102.585960 | 6588.3 |
| dark/horizon/1280 | 100.673982 | 4890.3 |
| dark/horizon/1920 | 92.430882 | 5240.8 |
| dark/massif/1280 | 50.058536 | 4684.6 |
| light/horizon/1280 | 157.011830 | 5097.1 |

完整套件再次获得576个焦点样本，见 `review23/revision6-full-focus-summary.json`；三个模式最低值仍为3.219723461690725，最暗坐标与RGBA不变，无第二次参考值重算。独立源码复核 `review23/revision6-final-review.md`未发现Critical／Important具体问题，其源码指纹对应本轮最终实现。世界／光学／设计／焦点原生套件分别断言D3D11，未把其余采用默认SwiftShader的用例冒称原生GPU。

本轮未验证真实Tauri/WebView2、Intel显卡、NVDA、真实微软登录或游戏启动；相关UI流程使用夹具。Rust后端未修改，未重跑Cargo检查／测试；没有构建安装包、修改版本或依赖。最终数值检查与上述有限人工图结论分开。

<a id="independent-review-results"></a>

## 独立复核结果（2026-11-07，最终验证完成）

本节基线为 `main` @ `0cc8f5500a59e1885ad778751d35eb438e7147ab`，证据根记作 `verification/`，实际路径为 `E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/`。S4第六次修订跨日执行，证据继续使用开工日目录 `s4-r6/`，本次记录日期为2026-11-07（Asia/Singapore）。11月7日liveShift几何采样补充已批准并实现，最新完整验证全部通过；旧失败批次及其原因分别保留。

**统一提交归属 CVERIFY：`6921a83eb198a3665e858956d3f473557623dcf5`。** 本节16项、R2-01第七次修订、S4第五／第六次修订及11月7日采样补充均在该提交。已正常推送；[git-ls-remote-origin.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/git-ls-remote-origin.log) 记录远端 HEAD、main 均指向该 SHA，[提交回执](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/commit-receipt.json) 逐项记录归属。

**11月6日非S4收尾的历史完整结果**保留为 `non-s4-final`：304项301通过／3失败、0跳过／flaky、顶层errors=[]、1666.675秒（27.78分钟），300项非S4通过，S4四组1通过／3失败，命令退出1。该批npm为69文件686项Vitest＋90项Node、间距基线359，TypeScript退出0，14对截图对应当时的 `edb0836f…ec341b` 源码。`non-s4-complete`的295／9真实失败、其后原断言11项GREEN及更早39项中止批次全部保留。它们不代表当前S4限幅代码已通过完整套件。

S4第五次口径及冻结状态现为历史：[s4-frozen-before-non-s4.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-frozen-before-non-s4.json)证明非S4收尾期间未动玻璃或S4测试。用户随后以第六次修订批准按尺寸限幅，并撤销内部对无折射参照的<0.5%判定；该值现在只记录，实际列差≤12及边缘／中心位移要求保留。旧3失败／1通过不回写为新结果，也不再声称当前S4产品仍冻结。

<a id="s4-r6-progress"></a>

### S4第六次修订最终结果：限幅、几何采样及完整套件通过

**旧liveShift采样区域冲突已经用户批准的几何筛选修复。** 三处调用共用同一个probe，只对前后端点都处于实际扫描行平坦区的样本判6–8，每条入选样本均须通过且至少一条；斜面与未配对样本保留记录。旧5／1失败和后续尺寸假设2／2失败不回写。最终304项已全部通过，并已合入CVERIFY提交 `6921a83eb198a3665e858956d3f473557623dcf5`，正常推送完成；[远端读数](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/git-ls-remote-origin.log)与[提交回执](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/commit-receipt.json)确认该提交。

**数值实现与已运行验证。** `geometry.ts`使用每个表面钳制后的有效B及最大RGB通道幅度判断预算；已满足预算的分支保留旧计算和编码。需要限幅的场使用有平坦内部的单调轮廓，`curvatureBounds.ts`对实际8bit编码及双线性采样的法线导数作下界检查，包含弯曲逆映射、单元格内法线区间及图像边缘的clamp条带。每次进一步缩幅后重新检查编码结果，不以连续曲线的理想导数代替8bit实际贴图。

声明的refraction **0.9**、dispersion **0.65**、各表面bevel／radius和贴图尺寸均未改；RGB标尺仍为29.268／28.8／28.332。按最大RGB通道计算，旧峰值为14.04864；此前诊断的13.824是中通道峰值，两者没有混成同一数值。预算倍率作 `(1−4×Number.EPSILON)` 的浮点内缩，处理原先5.720000000000001大于5.72的数值越界，没有放宽≤B/2的断言。旧 `refraction.test.ts` 的固定幅度>0.3与获准的新尺寸预算不兼容，已改为保留方向／对称性并检查正幅度及上限；真实边缘≥2px的浏览器要求继续保留。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 三种小面新上限测试，产品修复前 | 3个测试失败，共6个soft断言失败；68×44／40×32／96×40的编码导数分别−0.262541／−0.836424／−0.492094，旧峰值14.04864分别超过8.36／5.72／7.48 | [size-limit-red.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/size-limit-red.log) |
| 首次玻璃专项 | 108通过／2失败：旧>0.3断言，以及5.720000000000001的浮点上界；均保留，不改写初次结果 | `s4-r6/glass-first.log` |
| 修正后的玻璃专项 | 13文件、110/110通过 | [glass-green.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/glass-green.log) |
| `npx tsc -b` | 主流程确认退出0，日志为空 | `s4-r6/product-tsc.log` |
| 首次定向Playwright六项（历史） | **5通过／1失败**，0跳过／flaky，35.156秒；四组S4均实际D3D11通过，拖动用例通过，旧条纹liveShift失败 | [native-product-first.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/native-product-first.json)及同名log |
| 获准几何采样后的首次条纹专项（历史） | 2通过／2失败、19.759秒；英语DOM小数宽度与整数SVG尺寸被错误要求严等，属于测试假设问题 | `s4-r6/live-shift-targeted.json/.log` |
| 修正尺寸模型后的条纹专项 | **4/4通过**、18.343秒、0跳过／flaky；global-glass、interface-quality深浅、round6-acceptance共用probe | [live-shift-targeted-r2.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/live-shift-targeted-r2.json)及同名log |
| 最新完整`npm test` | 71文件716项Vitest＋96项Node通过，check实际359，主流程确认退出0 | [final-r2-npm-test.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-r2-npm-test.log) |
| 最新`npx tsc -b` | 主流程确认退出0，日志为空 | `s4-r6/final-r2-tsc.log` |
| 最新完整Playwright | **304/304通过**，1604.075696秒（26.735分钟）、退出0，0失败／跳过／flaky，所有结果单次retry0 | [原始reporter](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright.json)／[日志](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright.log) |

[最终独立汇总](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright-summary.json)及[证据审计](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-evidence-audit.json)核对全部304结果，audit状态为passed。实际D3D11／DPR1覆盖5份焦点runtime、19份设计runtime、12固定相位及5动态世界场景；三模式共576条焦点边全部有效且≥3。四组实际S4与四份共享条纹数据均齐全且通过，不把其余采用默认渲染配置的测试一概写成原生GPU。

验证前后387个源码、测试及配置／脚本文件的摘要集合未变，`validated-tree.mjs verify`退出0；集合SHA256为 `20eb36d9d05cac09713b6c1f64d48ac5a44cb7fe21e586452928262fb254a6cb`，见[validated-tree.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/validated-tree.json)。文档不在这个源／测试集合内，报告补录不冒称又修改或重新验证了产品；版本、依赖、锁文件及Rust未变。

| 最终原生闸门 | 本批实测 |
| --- | --- |
| 固定uT=9.7深色岛面均值，1050／1280／1920 | 103.3746616758／99.3574595055／92.0533923639；等待2638.2／2754.0／2653.5ms，均在90–150 |
| 动态dark horizon均值，1050／1280／1920（只记录） | 105.0188772059／101.0189687877／91.9207807936；等待4409.0／4591.7／4859.2ms，各自allAGatesPass=true |
| 动态massif dark／horizon light，1280 | 均值50.0481594282／157.0065228758，等待4338.0／4765.2ms；按各自既定口径通过，不套用深色地平线下限 |
| 焦点full／Lite／减少动态最低对比 | 3.186023314444064／3.1903018717913123／3.3725538233759105 |
| 导航dark solid／dark Lite／light solid／light Lite最低对比 | 6.690176593326156／6.781873936349915／5.5944466148976755／5.497016286699072 |

完整逐帧值、适用门槛、等待uniform序列、runtime与原图路径保留在summary及对应原件内；上表数值检查与下文人工查看范围分列。

**实际表面与字节兼容范围。** [实际表面清单](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/surface-inventory-summary.json)记录23个真实静止应用状态、93张现有贴图，全部匹配改前生成器、实际D3D11／DPR1，去重得到15种几何。它们原先都超过A≤0.5B，所以这15种都记录为贴图改变，不能把其中的大面写成“逐字节未变”。`__fixtures__/curvature-before-r6.json`固化这些实际形状、原字节摘要和轮廓摘要；单测检查尺寸／轮廓不变、原超预算图发生改变及新预算。

| 实际拥有曲率图的对象 | 去重尺寸（CSS px） | 数量 | 原预算／本次贴图 |
| --- | --- | ---: | --- |
| 导航活动胶囊 | 61×44、68×44、71×44、80×44 | 4 | 全超预算／全改变 |
| 首页实例选择器 | 256×50、262×50、360×50 | 3 | 全超预算／全改变 |
| 首页启动表面 | 296×56、302×56、400×56 | 3 | 全超预算／全改变 |
| 动作选择控件 | 180×50 | 1 | 超预算／改变 |
| 实例／动作菜单大面 | 324×198、362×198、324×360、180×194 | 4 | 全超预算／全改变；视觉覆盖另列如下 |

另有两条**合成**低refraction=0.2兼容性用例（320×160及560×320，后者贴图512×293），验证原已在预算内的编码字节摘要完全不变。它们不是真实产品表面，不能替代“真实大面未变”的证据。实测Dialog／Toast本体、flat Select和导航外壳没有曲率feImage，不能把这些未注册对象列作geometry贴图的兼容通过项。

**先期大面候选验证（历史，后续最终产品重拍另列）。** [certified-summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/certified-summary.json)六组均为无弯曲、同一冻结帧，只临时替换目标feImage，背景、文字、反射及其他贴图不变；恢复后像素差为0，目标以外像素差也为0。实际候选峰值为 **9px**、旧最大RGB峰值14.04864，下降35.936859%；实际编码法线下界均为 **0.540894117647057**。原始driver中的`budget.ratio`／`ceilingA`只是先前B/2参考计算，不能把参考峰值10或比例0.7118当作此候选的最终幅度。

| 候选场景 | 大面尺寸 | 贴图改变字节数 | 表面meanAbsDelta | 同帧前／后裁剪 |
| --- | --- | ---: | ---: | --- |
| dark，1440长实例菜单 | 324×360 | 26152 | 0.034732 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/dark-1440-instance-long/before-crop.png)／[候选后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/dark-1440-instance-long/certified-crop.png) |
| light，1440长实例菜单 | 324×360 | 26152 | 0.025644 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/light-1440-instance-long/before-crop.png)／[候选后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/light-1440-instance-long/certified-crop.png) |
| dark，1920实例菜单 | 362×198 | 21192 | 0 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/dark-1920-instance-wide/before-crop.png)／[候选后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/dark-1920-instance-wide/certified-crop.png) |
| light，1920实例菜单 | 362×198 | 21192 | 0 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/light-1920-instance-wide/before-crop.png)／[候选后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/light-1920-instance-wide/certified-crop.png) |
| dark，1440动作菜单 | 180×194 | 13752 | 0.665836 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/dark-1440-animation/before-crop.png)／[候选后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/dark-1440-animation/certified-crop.png) |
| light，1440动作菜单 | 180×194 | 13752 | 0.437342 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/light-1440-animation/before-crop.png)／[候选后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/light-1440-animation/certified-crop.png) |

宽实例菜单的截图像素不变只说明该安静背景下没有可见像素变化，不代表其位移图字节未变。上述先期六组缺少普通324×198实例菜单；该尺寸的[补充候选两组](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-candidate-324x198/candidate-summary.json)另存独立目录，取证代理实际查看其中四张原倍率前后图。它同时也纳入下面最终产品配对；旧候选记录没有被重命名或回写成产品证据。

**最终产品的26组同帧前后取证。** [原始summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/summary.json)及[compact产品汇总](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/product-summary.json)标明`mode=product-final`、26组`productEvidence=true`、`candidateMetadata=null`，覆盖11种对象与尺寸组合。after使用页面自然显示的feImage；浏览器再导入实际产品生成器重建RGBA，26组均逐字节匹配。冻结帧内只把目标图临时换成改前同形状贴图取得legacy对照，然后恢复原产品图；26组目标以外变化均为0、恢复差均为0，文字、反射、形状／标尺及其他贴图保持一致，旧轮廓命令与坐标值均未变。全部实际D3D11／DPR1，六个光学源码文件在采集前后摘要相同。

这批包括四种菜单尺寸×深浅共8组，另有启动表面、实例选择器、动作选择控件三种类型×三宽×深浅共18组。以下meanAbsDelta是表面RGB平均绝对差，只用于量化变化，不是自行添加的视觉通过阈值。

| 最终产品类型 | 组数 | 尺寸／宽度覆盖 | 表面meanAbsDelta范围 | 记录边界 |
| --- | ---: | --- | ---: | --- |
| 普通实例菜单 | 2 | 324×198，1440深浅 | 0.000228–0.003787 | 补齐先期候选未覆盖尺寸 |
| 宽屏实例菜单 | 2 | 362×198，1920深浅 | 0 | 贴图字节仍改变，不能从静色背景像素相同推断图未变 |
| 长实例菜单 | 2 | 324×360，1440深浅 | 0.027601–0.034672 | 与候选是不同批次，均保留原始值 |
| 动作菜单 | 2 | 180×194，1440深浅 | 0.436851–0.669972 | 有局部背景边缘差异 |
| 启动表面 | 6 | 1050／1440／1920深浅 | 0.000098–0.001277 | 三种实际宽度均有产品配对 |
| 实例选择器 | 6 | 1050／1440／1920深浅 | 0.013019–0.047031 | 保留全部尺寸与同帧控制项 |
| 动作选择小控件 | 6 | 180×50，三宽深浅 | 0.912180–1.570829 | 有真实可见变化：旧背景点的长竖向拉伸缩短或恢复点状，不写成“无变化” |

15 种几何与 26 对最终产品取证逐一对应如下。四种胶囊均未纳入26对同帧前后图；68×44、80×44 另有 S4 最终实际图（与同帧无折射参照对比，非旧贴图对照），61×44、71×44 未按该几何重拍。

| 实际对象 | 尺寸 | 产品前后对数 | 覆盖 |
| --- | --- | ---: | --- |
| 导航活动胶囊 | 61×44 | 0 | 未重拍该几何；库存记录有旧图 |
| 导航活动胶囊 | 68×44 | 0 | 不在26对内；另有深浅首页实际6倍图 |
| 导航活动胶囊 | 71×44 | 0 | 未重拍该几何；库存记录有旧图 |
| 导航活动胶囊 | 80×44 | 0 | 不在26对内；另有深浅库页实际6倍图 |
| 实例选择器 | 256×50 | 2 | 深浅1050 |
| 实例选择器 | 262×50 | 2 | 深浅1440 |
| 实例选择器 | 360×50 | 2 | 深浅1920 |
| 启动表面 | 296×56 | 2 | 深浅1050 |
| 启动表面 | 302×56 | 2 | 深浅1440 |
| 启动表面 | 400×56 | 2 | 深浅1920 |
| 姿态选择控件 | 180×50 | 6 | 深浅 × 1050/1440/1920 |
| 普通实例菜单 | 324×198 | 2 | 深浅1440；另有独立候选补测 |
| 宽屏实例菜单 | 362×198 | 2 | 深浅1920 |
| 长实例菜单 | 324×360 | 2 | 深浅1440 |
| 姿态菜单 | 180×194 | 2 | 深浅1440 |

四种改变的菜单大面均补齐最终产品的深浅前后原倍率图；这八组不再用候选图替代：

| 实际菜单尺寸 | 贴图改变字节数 | 深色legacy／product | 浅色legacy／product |
| --- | ---: | --- | --- |
| 324×198 | 19672 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-instance-normal/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-instance-normal/product-crop.png) | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1440-instance-normal/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1440-instance-normal/product-crop.png) |
| 362×198 | 21192 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1920-instance-wide/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1920-instance-wide/product-crop.png) | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1920-instance-wide/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1920-instance-wide/product-crop.png) |
| 324×360 | 26152 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-instance-long/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-instance-long/product-crop.png) | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1440-instance-long/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1440-instance-long/product-crop.png) |
| 180×194 | 13752 | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-animation/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-animation/product-crop.png) | [前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1440-animation/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1440-animation/product-crop.png) |

主流程已实际查看最终产品深色动作菜单的[legacy原倍率裁剪](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-animation/legacy-crop.png)／[product原倍率裁剪](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-animation/product-crop.png)，以及浅色1050启动表面的[legacy裁剪](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1050-home-launch/legacy-crop.png)／[product裁剪](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1050-home-launch/product-crop.png)，未见这两组明显整体弱化，动作菜单可见局部背景边缘差异。

[最终产品人工清单](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/manual-review.json)记录取证代理实际查看64张图：26对原倍率图共52张，动作小控件4张6倍图、动作菜单8张6倍图。八组菜单、六组启动表面及六组实例选择器未见明显整体材质减弱；六组180×50动作小控件有真实可见变化，旧长竖条变短或恢复圆点，1440深浅尤其明显。主流程另查看了[深色小控件前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-home-animation-selector/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/dark-1440-home-animation-selector/product-crop.png)及[浅色小控件前](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1440-home-animation-selector/legacy-crop.png)／[后](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-product-final/light-1440-home-animation-selector/product-crop.png)，确认边缘光学层次仍在，并判断小控件异常拉伸减少符合本轮修复目的，不触发“大面明显弱化”停线。这是主流程对实际图像的判断，不是新增用户口径或数值门槛。重复查看的图不重复计算独立图片总数；未列入清单的其它6倍图不宣称已人工检查，任意背景及移动／弯曲姿态仍不能由静止图外推。

**四组实际S4列剖面与色边记录（首个产品专项，保留历史）。** `native-product-first/*/glass-interior/interior.json`均为1440×930、D3D11／DPR1，内部对无折射参照的比例只记录；列差仍按中心±6对±8–16邻列均值判≤12。左右色边用实际轮廓内4px带、扣除真实文字／图标后各记录有符号R−B均值，差值是左减右，没有新增颜色数值门槛。

| 场景 | 列差最大值（≤12） | 内部差>25比例（只记） | 左／右像素数 | 左mean(R−B) | 右mean(R−B) | 左−右 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| dark／home | 5.347883597884 | 2.664975% | 310／310 | −3.467741935484 | −4.193548387097 | 0.725806451613 |
| dark／library | 4.521645021645 | 0.209205% | 358／358 | −3.622905027933 | −3.812849162011 | 0.189944134078 |
| light／home | 5.123015873016 | 2.538071% | 310／310 | 7.303225806452 | 7.961290322581 | −0.658064516129 |
| light／library | 2.944624819625 | 0% | 358／358 | 7.452513966480 | 7.525139664804 | −0.072625698324 |

**最终完整套件四组S4。** 下表来自 `final-playwright/*/glass-interior/interior.json`，均D3D11／DPR1。每组完整6倍图已重拍并由主流程实际查看：未见原中心竖条、未见明显不对称色楔，边缘仍可见点阵弯折；存在微弱冷暖差，未据此宣称左右RGB完全一致。内部比例和色边只记录，列差≤12仍为原判据。

| 最终场景 | 列差最大值 | 内部差>25比例（只记） | 左／右像素数 | 左mean(R−B) | 右mean(R−B) | 左−右 |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| dark／home | 5.347883597884 | 2.664975% | 310／310 | −3.467741935484 | −4.193548387097 | 0.725806451613 |
| dark／library | 3.922318422318 | 0% | 358／358 | −3.620111731844 | −3.754189944134 | 0.134078212291 |
| light／home | 5.123015873016 | 2.538071% | 310／310 | 7.303225806452 | 7.961290322581 | −0.658064516129 |
| light／library | 2.950937950938 | 0% | 358／358 | 7.416201117318 | 7.505586592179 | −0.089385474860 |

**旧条纹采样冲突与坐标系（修复前历史）。** 首次定向套件唯一失败是旧`liveShift`要求6–8而实际均值9；边缘≥2、中心≤1及匀色不染色原判据全部通过。随后三次独立D3D11捕获重复得到下列数值。其中[第三次稳定光学复现](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/stripe-d3d11-stable/glass-pixel-report.json)配有[capture-optics-stability.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/stripe-d3d11-stable/capture-optics-stability.json)：5张截图各自前后metadata相等，期间epoch均为2、href／scales／clip／bounds全等，排除了该批结果来自光学瞬态的解释。前两次[初次复现](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/stripe-d3d11-conflict/glass-pixel-report.json)及[带几何复现](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/stripe-d3d11-geometry/glass-pixel-report.json)仍保留原件，没有回写成当时已记录上述稳定性字段。

| 条纹检查 | 实测 | 原要求／状态 |
| --- | ---: | --- |
| maxEdgeShift | 2.999677679290892px | ≥2，通过 |
| maxCenterShift | 0.000322320709109647px | ≤1，通过 |
| maxUniformDelta | 0 | ≤1，通过 |
| liveShift | 9px | 6–8，失败且未改断言 |
| 第1条PNG transition | 32.49771689497717→39.49771689497717 | 位移7px，继续保留原始样本 |
| 第2条PNG transition | 48.50228310502283→59.50228310502283 | 位移11px，继续保留原始样本 |

[几何原件](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/stripe-d3d11-geometry/runtime.json)确认DOM为x=160.75、y=19、68×44，PNG为69×44，cropOffsetX=0.75、Y=0。旧probe按PNG宽度得到 `safeMargin=min(32,69×0.25)=17.25`，窗口为(17.25,51.75)，只用移动前transition的位置筛选，没有核对移动后终点是否仍在平坦区。

坐标不能直接混用：transition算法以像素中心索引作位置，因此本例CSS局部x=`PNG transition x＋0.5−0.75`；第2条的局部起止约48.2523→59.2523。扫描行`floor(44/2)=22`对应CSS局部Y=22.5；[19.72,48.28]只是Y=22几何中线的参考flat范围，不能当作实际扫描行的精确边界。考虑圆角SDF及半像素偏移，第2条起点邻近平坦区／斜面分界，终点明确进入右斜面，不能要求它仍只移动7px。

**2026-11-07已批准并完成的采样修订。** 共享probe由实际DOM位置、live SVG尺寸／轮廓／标尺取得静止几何，并明确整数document clip与像素中心+.5换算；从圆角SDF向内profileWidth求实际扫描行平坦区。只有前后两个端点都在该区间内的样本进入liveShift判定，每条必须6–8且至少一条。斜面及未配对样本继续写入JSON；原maxEdgeShift≥2、maxCenterShift≤1及uniform检查不变。原始条纹对应关系按同极性、32px周期的一半16px找邻近边，不用6–8这个通过范围做匹配或筛选。

首次应用时错误要求DOM小数尺寸与SVG整数尺寸严等，导致英语interface-quality深浅2项失败；实际DOM宽69.15625、产品以offsetWidth69生成SVG，PNG捕获宽70，并不存在缩放错误。修复使用整数layout尺寸验证SVG，再用实际DOM作捕获，保留translation-only和CSS单位检查，没有扩大几何容差。该批2通过／2失败保留在`live-shift-targeted.json/.log`。修正后的`live-shift-targeted-r2`四项18.343秒全部通过，0跳过／flaky。

| 定向场景 | DOM／SVG／PNG宽 | PNG平坦区间（扫描行22） | 入选位移 | 只记录的主要斜面位移 | 边缘／中心最大位移 |
| --- | --- | --- | ---: | --- | --- |
| global-glass | 68／68／69 | [20.0255000562,48.4744999438] | 7 | 9、11；未配对轮廓保留 | 2.999677679291／0.000322320709 |
| round6-acceptance | 68／68／69 | [20.0255000562,48.4744999438] | 7 | 9、11；未配对轮廓保留 | 2.999677679291／0.000322320709 |
| interface-quality深色 | 69.15625／69／70 | [20.0255000562,49.4744999438] | 7 | 9、10，另有轮廓2.024788；未配对项保留 | 2.999677679291／0.000322320709 |
| interface-quality浅色 | 69.15625／69／70 | [20.0255000562,49.4744999438] | 7 | 9、10；未配对轮廓保留 | 2.999677679291／0.000322320709 |

四组入选的PNG transition均为32.49771689497717→39.49771689497717。三个Node回归覆盖分数origin／半像素扫描行、跨入斜面的样本必须只记录、无合格样本不能通过，以及5与9平均成7仍须失败。最新完整CPU验证实际为71文件716项Vitest、96项Node与check359，TypeScript也退出0；证据为`final-r2-npm-test.log`和`final-r2-tsc.log`。三处浏览器调用均使用该probe，未在某页另设通过规则。

最终完整套件再次生成四份共享probe报告，均有一个合格平坦样本、liveShift=7、maxEdgeShift=2.999677679290892、maxCenterShift=0.000322320709109647；两份中文场景的斜面位移9／11、两份英语interface场景9／10继续记录（深色另保留轮廓样本2.024788），未配对项也未删除。来源为 `final-playwright/interface-quality-*/refraction/glass-pixel-report.json`及 `final-world-evidence/{global-glass/slider,round6}/glass-pixel-report.json`，精确路径由最终audit列明。

**实际人工查看（与数值分列）。** 主流程先看了以下首个产品专项的四张6倍图，结论是未见原中心竖条或明显单侧色楔，边缘点阵仍有可见曲变；这些初次图不替换成后续批次：

- [dark／home 6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/native-product-first/review-fixes-S4-dark-home--340a1-y-even-with-real-refraction/glass-interior/actual-6x.png)
- [dark／library 6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/native-product-first/review-fixes-S4-dark-libra-e5e17-y-even-with-real-refraction/glass-interior/actual-6x.png)
- [light／home 6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/native-product-first/review-fixes-S4-light-home-c8cf6-y-even-with-real-refraction/glass-interior/actual-6x.png)
- [light／library 6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/native-product-first/review-fixes-S4-light-libr-9b93d-y-even-with-real-refraction/glass-interior/actual-6x.png)

完整套件结束前，主流程又实际查看了最终四图：[dark／home 6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright/review-fixes-S4-dark-home--340a1-y-even-with-real-refraction/glass-interior/actual-6x.png)、[dark／library 6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright/review-fixes-S4-dark-libra-e5e17-y-even-with-real-refraction/glass-interior/actual-6x.png)、[light／home 6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright/review-fixes-S4-light-home-c8cf6-y-even-with-real-refraction/glass-interior/actual-6x.png)、[light／library 6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright/review-fixes-S4-light-libr-9b93d-y-even-with-real-refraction/glass-interior/actual-6x.png)。四张均未见原中心竖条或明显不对称色楔，点阵在边缘仍有弯折，微弱冷暖差如实保留；不把全部自动保存图都扩写为已人工查看。

主流程另已实际查看最新固定uT=9.7的[1050正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright/world-acceptance-terrain-b-3091c--retains-highlight-headroom/terrain-phase/normal-2.png)、[1280正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright/world-acceptance-terrain-b-dd257--retains-highlight-headroom/terrain-phase/normal-2.png)、[1920正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/final-playwright/world-acceptance-terrain-b-186c1--retains-highlight-headroom/terrain-phase/normal-2.png)：三张脚部投影均在岛面范围内，未见明显离岛或过曝光斑。这里只给这三张人工观察，不扩写为全部地形相位已经看图；全部12固定相位的数值通过由上述audit另行确认。

主流程另看D3D11条纹[正常6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/stripe-d3d11-conflict/stripes-full-6x.png)和[平移后6倍](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/stripe-d3d11-conflict/stripes-live-shift-7px-6x.png)，用于解释上述区域冲突。大面方面，主流程看了深色动作菜单的[改前6倍裁剪](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/dark-1440-animation/before-crop-6x.png)／[候选6倍裁剪](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/dark-1440-animation/certified-crop-6x.png)，以及浅色动作菜单的[改前全帧](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/light-1440-animation/sameframe-before.png)／[候选全帧](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/light-1440-animation/certified.png)。盘点代理另实际查看20张候选前后图，逐图名单与观察在[manual-review.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-r6/large-surface-certified/manual-review.json)，未见这六组静态候选整体明显减弱；动态姿态、任意壁纸及最终产品大面不能由这些候选图外推。

**最终验证与边界。** 获准的liveShift规则、四组S4、最终产品配对及完整npm716＋96／check359、TypeScript、Playwright304/304均已取得通过证据，源码／测试集合前后核对一致。原R2-26长尾及ink参考对比限制继续保留；本阶段没有新增真实WebView2、Intel、读屏、真实账号／游戏进程或安装包验证，也不把静止菜单图外推为任意背景或移动／弯曲姿态的视觉验收。版本、依赖未改，未构建安装包，临时Vite已停止。CVERIFY 已提交、推送，远端证据见本节开头。

### 11月6日非S4收尾记录（以下数值及“最终”均指S4第六次修订之前的批次）

### 前置单项：R2-01第七次修订

`tests/e2e/helpers/focus-edge-sampling.ts` 现在沿焦点轮廓外缘的四条完整1px线采样，距离为 `outline-offset + outline-width + 1`，每条边以逐通道中位色判定3:1；单个最暗像素仍保留，只记录、不判定。helper新增前的 `focus-edge-red.log` 是模块不存在的失败，不当作旧算法断言失败；实现后 `focus-edge-green.log` 为2/2通过，覆盖孤立前景点与越界边不能被悄悄缩短。旧indicator真正的数值RED另由下述accent亮度断言给出。

参考值由既有正常PNG重新计算，未为取值改变世界或阅读面：`derive-edge-reference.mjs` 读取 C23 `revision6-full/` 三模式各48站，共576条边。最暗边中位色为full模式“开始”下边 `(222,220,214)`，逐通道减4得 **`#dad8d2`**，仍比名义表面 `#eae7e0` 暗，所以保留附加参考常量。完整来源路径、站位、边、原图和逐边数据见 [revision7-edge-reference.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/revision7-edge-reference.json)。此处576是边的数量，不再是第六次的576个单点。

`accent.test.ts` 新增“浅色indicator亮度不得低于ink”。旧 `#1c4f00` 在新断言下 **4失败／5通过**，更换参考后 **9/9通过**，见 `accent-r7-red.log`／`accent-r7-green.log`。默认浅色indicator为 **`#508700`**，ink仍为 **`#3f7400`**，亮度次序满足新断言；indicator对参考色的对比度为 **3.0653275873:1**；ink对该参考为 **3.9719708151:1**，仍低于4.5，按裁定保留不处理。这次更正不改变ink的对照表面、世界参数或阅读面透明度。

[focus-r7-first.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/focus-r7-first.json) 为full／Lite／减少动态 **3/3通过**，0失败／跳过／flaky，32.2秒；每例均断言实际D3D11及DPR=1。重新读取本次各 `keyboard-focus.json`：每模式48站、192边，共576边均有效且≥3:1，full最低3.186023314444064，Lite最低3.1903018717913123，减少动态最低3.3747653670846054。每条边的完整像素、单点最暗值和正常截图均留在 `focus-r7-first/`；本次没有新增这些焦点截图的人工视觉签字。

### 1–16项状态、修复归属与证据

以下16项的本次处理统一归属CVERIFY，完整SHA和推送证据见本节开头，回执逐项映射；不以旧C4／C23哈希冒充本次提交。证据列保留有意义的历史RED与专项，最新完整304项全部通过，名称／状态在 `s4-r6/final-playwright-summary.json`。第13项压力尾段仍按用户允许如实保留未满足条件，不因记录测试通过而宣称整段完整显示。

| 编号 | 归属提交 | 本次实际结果 | 证据及未完成边界 |
| --- | --- | --- | --- |
| 1 S4竖条、参照和列剖面 | CVERIFY | **已完成并通过最终套件。** 四组列差5.347884／3.922318／5.123016／2.950938均≤12，内部比例只记；四共享probe均live7、合格样本非空且每条6–8 | 最终304/304、audit及四张实际6倍人工观察；26组产品前后图与64张取证代理查看图分列。旧5／1、2／2不回写；归属CVERIFY |
| 2 LoginDialog选中块脱离tab | CVERIFY | **已修，专项通过。** 先在明确full模式下真实复现快速Authlib切换／提交后的投影错位，再通过 `SelectionProjectionContext` 仅在Dialog内关闭shared layout projection，无新增DOM容器，Dialog外保持原投影行为 | `dialog-rapid-projection-red.json/.log`：81个profile可见rAF样本，113.1ms时上下边误差96.8485px；`dialogs-native-green.json`与 `dialogs-summary.json`：6段panel重排轨迹最大误差均0，18组几何误差均0。最终77项相关单测和7项原生通过；最终稳定截图曾通过的早期批次未冒称该问题RED |
| 3 登录tab间距与manual tab stop | CVERIFY | **已修，专项通过。** 选中tab始终为唯一 `tabIndex=0`，箭头仅移动DOM焦点；Dialog的Tab陷阱从负tabIndex项目按DOM顺序继续。login tabs使用真实 `--space-5`，与panel实测间距24px | `dialog-behaviors-unit-red.log`、`dialog-tab-order-valid-red.log`及 `dialogs-native-red.json`保留真实RED；18组间距均24px。原生ArrowRight→Tab→Shift+Tab→Enter返回已选Microsoft tab，取消登录命令0次。jsdom缺showModal的第一次设置失败仅作无效测试记录；见 `dialog-behavior-notes.md` |
| 4 首页角色placeholder居中／secondary | CVERIFY | **已修，原生4/4通过。** 真实RED为横向中心差80px、纵向55.8／114.7px且文字仍primary；局部恢复absolute／inset0／margin-auto／fit-content居中及secondary | `non-s4-home-red.json/.log`；`non-s4-layout-green/verification-home-*/placeholder-geometry.json`实际横差0、纵差0或0.0078125，文字等于secondary，按钮高38px、占位卡圆角12px，status不包按钮。所属批次的下载6项后来判为无效，未用于本项结论 |
| 5 library紧凑级联及前后截图 | CVERIFY | **已修，原契约及最终整套对应项通过，14对截图通过。** commandbar恢复物理2px，保持38外高／32内高／1px边框；紧凑170、detail刻度与死规则清理保持 | 原11项GREEN后，完整套件再次通过对应项；当前14对mask外最大0.404902%≤0.5%，source=`edb0836f…ec341b`。295／9批次的6项RED及旧所有截图保留 |
| 6 Stop在安装busy时重复发送 | CVERIFY | **已修，专项通过。** 原全局busy保留首个 `instance.install`，不能承担Stop互斥；改用独立promise ref即时锁及状态，保持键盘焦点和aria-disabled语义 | `dialog-behaviors-unit-red.log`真实失败后，通过 `dialog-behaviors-unit-final.log` 的HomePage相关用例。最终四文件77/77包含重复Stop排除；不代表真实游戏进程验证 |
| 7 Authlib disabled与完整焦点 | CVERIFY | **追加修复完成，整份dialog原生11/11通过。** 新增contrast-more／forced-colors验证先2失败／2通过；仅在 `@media (forced-colors:none)` 下给disabled角色行复用opacity0.48，tokens、非禁用控件和系统GrayText不变 | `non-s4-authlib-contrast-red.json/.log`及 `non-s4-authlib-contrast-green.json/.log`，GREEN65.466秒、0失败／跳过／flaky、实际D3D11。普通模式tertiary色原断言保留并要求opacity0.48；contrast-more颜色不变但1→0.48，forced-colors仍GrayText／opacity1；焦点内缩原用例同步通过 |
| 8 下载历史列对齐 | CVERIFY | **已修，强化后原生6/6通过。** 历史父列表拥有共同五列，子行subgrid；额外RED证实content-visibility布局隔离使列堆叠，随后仅移除历史行该设置及无用intrinsic-size | `non-s4-downloads-final-green.json/.log`与final-summary：zh/en×1050/1440/1920，每例30行、56px，五列x差全0，横向顺序／行内边界／垂直中心均通过。`non-s4-layout-green`里下载六项仅equal-x通过但所有列同x堆叠，明确作**无效覆盖**保留，不能计为GREEN |
| 9 两处zh账号文案 | CVERIFY | **已修，专项通过。** 空态为“还没有账号”，当前项为“当前账号”；页面“角色”标题保留 | 两个独立zh单测及 `dialogs-native-green/verification-dialogs-verif-808f1-counts-uses-account-wording/zh-empty-accounts.png`。i18n没有新增／删除键或全局替换“角色” |
| 10 px编码别名与真实刻度 | CVERIFY | **已修并通过最终静态／对应几何验收，baseline359。** 40定义／102声明保持，通用form24、创建panel局部20、commandbar物理2px；非零声明值变化92 | [逐条附录](2026-11-06-design-token-mapping.md)与修正JSON同步；427减69个var名称匹配得358，再加真实2px得359。原几何11项及最终套件对应项通过，初次映射和295／9失败保留 |
| 11 持续设计守护及test:design | CVERIFY | **已完成。** 最新npm716＋96及359通过；设计独立命令曾实跑19/19，最新完整套件再次执行同19项全过 | 当前为`s4-r6/final-r2-npm-test.log`及最终audit；`non-s4-test-design.json/.log`保留前批独立19/19、137.7秒，不冒称又单独执行该命令 |
| 12 LibraryDrill身份一致性 | CVERIFY | **单测及原生专项通过。** 独立字面值验证kind、id、实际Motion layoutId、字母／图标，覆盖card→detail→card及版本目录、full／Lite；真实浏览器也验证卡片／详情的解析色与身份 | 三文件36/36、5种内存变异均失败的历史专项保留。`non-s4-layout-green/.../identity-resolved-color.json`实测两处均 `rgb(143,143,139)`、key=`instance-identity-fixture-world`、字母“合”，不再以未解析var同义作证明 |
| 13 补齐R2-17／28／14／26／08持久验收 | CVERIFY | **守护已补并在最终套件通过；超长尾段保持已知未满足。** 双Select／Settings边框、h2角色、常见名scroll-box及四组导航像素对比均通过；R2-08见第2／3项 | 最终原始JSON再次实测压力尾段484／172、entireTailVisible=false，未缩短夹具；常见两名称高22／22、宽261／261。用户允许如实记录该限制，不能声称压力尾段完整显示 |
| 14 Toast减少透明／高对比实底 | CVERIFY | **已补持久验收，最终12材质状态全部通过，无需产品修复。** 两主题×三种材质偏好×root／modal，alpha255、有效opacity1、本体及伪元素无blur | 最终summary含6份Toast JSON／12host状态，全部reducedMotion=false，实际D3D11／DPR1；不以运动偏好代替材质偏好。早期10项材质专项仍保留原批次 |
| 15 旧报告C4／M2及S6来源 | CVERIFY | **文档已修正。** C4编号表及S2–S6标题改为已包含在 `8a9ed455ccbaf48df01ab2a69d4693a82282258a` 并推送，第四次M2 STOP、旧行220未取样及旧行501待审建议均标为历史；第五次修订后1920已正式取样，6项专项和252/252结果分列；236/32000的改前来源改为solid-cliff-v2 | 已读取 `stage4/commit-receipt.json`、`solid-cliff-v2/summary.json`及final summary并确认文件存在；已同步旧行223的359与双命令验收口径；修正来源和状态，不重写失败数据或重采历史基线 |
| 16 独立复核报告与证据归档 | CVERIFY | **已完成验证并推送。** 最新716＋96、tsc0、304/304及audit通过；旧301／3、295／9、39中止、S4的5／1和2／2均保留 | 16项统一归属 CVERIFY，真实SHA及远端确认见本节开头，已知限制及人工范围单列 |

### 最近一次完整批次（2026-11-06，S4第六次之前的历史）：301通过、3项冻结S4失败

[原始reporter](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-final.json)与[独立汇总](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-final-summary.json)均为304项、301通过／3失败、0跳过／flaky、顶层errors=[]，所有结果retry=0；完整命令退出1。汇总逐项保留名称、状态、原始结果及失败消息，并重新读取3组焦点、12固定相位、5动态场景、4组S4、4组导航、6份Toast材质和123份runtime记录。19项design-consistency在本次完整套件中全部通过；这不意味着再次单独运行了 `test:design` 命令。

[独立数值证据审计](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-final-evidence-audit.json)另行验证每项只有一次retry0结果、唯一失败均为S4，以及12固定／5动态的实际D3D11／DPR1、576有效焦点边、19设计项、4导航对比和12Toast材质状态，pass=true。它是数据一致性审计，不替代人工外观结论，也不把完整套件的退出1改成0。

最终S4的3失败仍来自未修改的测试与光学实现；浅色library通过。表中内部<0.5%及列差≤12均原样保留，失败未改成skip、expected failure或放宽门槛：

| S4场景（1440） | 内部差>25像素／总数 | 内部比例 | 最大列差 | 最终结果 |
| --- | ---: | ---: | ---: | --- |
| 深色首页 | 58/788 | 7.360406% | 23.281085 | 失败 |
| 深色library | 1/956 | 0.104603% | 14.001443 | 失败（列差） |
| 浅色首页 | 49/788 | 6.218274% | 20.296296 | 失败 |
| 浅色library | 0/956 | 0% | 9.716631 | 通过 |

**世界数值。** 三宽×四固定相位共12项全部通过。固定uT=9.7在稳定后采五帧，startupMean及90–150判据如下；其余相位的均值仅记录，p95／纯白等原闸门不变。

| 深色地平线固定9.7 | 五帧均值中位数 | 等待ms | startupMean／allNumericPass |
| --- | ---: | ---: | --- |
| 1050×720 | 103.3877437432828 | 2827.9 | true／true |
| 1280×720 | 99.36176470588187 | 2979.6 | true／true |
| 1920×1080 | 92.0537140046169 | 2882.1 | true／true |

五组动态均在20秒内按M2第五次结晶uniform收敛＋覆盖率判据稳定，`allAGatesPass=true`。以下为正式五帧中位数；动态均值只记录，不恢复90的下限。山体ROI均值／p95与浅色亮度数据按各自既定口径记录，不把深色地平线门槛套到这些行。

| 动态场景 | 等待ms | 岛面均值（记录） | p95 | 下半区纯白% | 岛外meanAbsDelta |
| --- | ---: | ---: | ---: | ---: | ---: |
| dark/horizon/1050 | 6630.5 | 103.029067 | 166.666667 | 0.004264 | 12.504006 |
| dark/horizon/1280 | 4887.1 | 100.705010 | 166.000000 | 0.003968 | 8.593338 |
| dark/horizon/1920 | 5167.0 | 92.802537 | 166.666667 | 0.002537 | 7.216939 |
| dark/massif/1280 | 4755.0 | 50.015772 | 115.333333 | 0 | 16.755756 |
| light/horizon/1280 | 5074.1 | 157.008379 | 175.666667 | 0 | 16.959701 |

逐帧值、uniform／等待序列、适用门槛和来源路径均在summary及其指向的原始JSON内；数值通过与后面的有限人工图签字分开。

**R2-01焦点。** 最终三模式各48站、192条完整相邻边，共576边，invalidEdges均0，每条边中位色对indicator均≥3:1。参考仍 `#dad8d2`、默认indicator仍 `#508700`，没有再重算参考。

| 模式 | 最低对比 | 对应边中位RGB | 最低边 |
| --- | ---: | --- | --- |
| full | 3.186023314444064 | (222,220,214) | “开始”下边 |
| Lite | 3.1903018717913123 | (222,220,216) | “开始”下边 |
| 减少动态 | 3.3725538233759105 | (228,226,220) | “打开实例 合成测试世界 002”下边 |

单个最暗像素仍只记录。ink保持 `#3f7400`，对附加参考为3.9719708151:1，低于4.5；按用户决定保留，不以indicator通过替ink作合格声明。

**R2-28导航。** 最终四组合重新采实际背景像素，各组3帧，最差值如下且均≥4.5；数据来自 `non-s4-final/verification-materials-*/navigation-contrast.json`。

| 导航场景 | 实际最差对比 |
| --- | ---: |
| dark／full／solid | 6.670934208664121 |
| dark／Lite／solid | 6.781873936349915 |
| light／full／solid | 5.5944466148976755 |
| light／Lite／solid | 5.497016286699072 |

**Toast材质。** 最终6例×root／modal两个host，共12状态，背景alpha全部255、effectiveOpacity全部1，本体／before／after的backdrop-filter全部none。各例reducedMotion=false，材质偏好与运动偏好分开验证。

| 主题／材质模式 | root与modal实际背景RGB | 两host有效opacity | 两host本体及伪元素blur |
| --- | --- | --- | --- |
| dark／减少透明 | (36,37,39) | 1／1 | 全部none |
| light／减少透明 | (250,249,245) | 1／1 | 全部none |
| dark／contrast-more | (36,37,39) | 1／1 | 全部none |
| light／contrast-more | (250,249,245) | 1／1 | 全部none |
| dark／forced-colors | (255,255,255)，实际系统Canvas | 1／1 | 全部none |
| light／forced-colors | (255,255,255)，实际系统Canvas | 1／1 | 全部none |

上述世界、焦点、导航和Toast记录均核对实际D3D11／DPR1；不把完整304项的其余用例一概冒称原生GPU测试。真实Tauri/WebView2、Intel显卡、NVDA、真实身份服务和真实游戏进程未在本轮新增验证；R2-26压力尾段484／172的限制同样保留。

### 首次跑完304项的真实RED与6项回归修复

[non-s4-complete.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-complete.json)实际为295通过／9失败、0跳过／flaky，1649.606秒（27.5分钟）。这是完整的真实RED；下列6项不能归入S4设计待定，也不能用较早专项通过覆盖。其后只修产品，原断言未改；`geometry-contract-green.json/.log`重跑这6项及5项相邻检查，**11/11通过、34.2秒、0失败／跳过／flaky**。新的完整结果另用 `non-s4-final` 前缀。

| 失败组 | 用例数 | 原断言 | 本批实测 | 当前处理 |
| --- | ---: | --- | --- | --- |
| `field-focus.spec.ts` full／Lite／减少动态 | 3 | collapsedGap为18–22px | RED三种模式均24px | 创建panel局部form gap改为space-4＋space-1=20，原断言GREEN |
| `library-review.spec.ts` D3导入panel | 1 | importPanel.height=197px | RED204.59375px | 两个gap各恢复4px，内容自然高196.59375受原min197约束；原197断言GREEN |
| `library-review.spec.ts` commandbar1050／1280 | 2 | view外壳padding=2px | RED两种宽度均4px | 恢复物理2px，38=32＋2×(1边框＋2内缩)，原断言GREEN |
| S4深色首页／深色library／浅色首页 | 3 | 冻结的内部<0.5%／列差≤12 | 深浅首页内部7.360406%／6.218274%；深色library列差14.878908 | 保留失败及设计待定，不计为本次新增非S4回归 |

该失败批次的12个固定相位、5组动态世界闸门均通过，但只是当时304项中的已通过部分，不能改写其295／9结果。6项修复后重新取得源码14对截图及 `edb0836f…ec341b`指纹，npm／TypeScript与完整304项均已重跑；最新结果为301／3，3项均属冻结S4。旧 `a6fc420b…`仍是修复前快照。

### 非S4专项结果及无效下载覆盖更正

Authlib高对比追加检查先得到 `non-s4-authlib-contrast-red.json` **2失败／2通过**：深浅contrast-more因disabled仍opacity1而失败，深浅forced-colors原本已经使用系统GrayText并通过。修复仅为 `accounts.css` 中 `@media (forced-colors:none)` 下的disabled角色行复用既有Button禁用opacity **0.48**，没有改颜色tokens或非禁用控件。GREEN重跑整份 `verification-dialogs.spec.ts`，包含原有7项及新增4项，共 **11/11、65.466秒**，0失败／跳过／flaky，实际D3D11／DPR1。

| Authlib模式 | 前景色变化 | opacity变化 | 结果与边界 |
| --- | --- | --- | --- |
| contrast-more深色 | `rgb(238,237,233)`保持 | 1→0.48 | 禁用区分来自既有禁用透明度，前景token未改 |
| contrast-more浅色 | `rgb(36,37,34)`保持 | 1→0.48 | 与深色同一局部规则 |
| forced-colors深浅 | 保持浏览器实际GrayText `rgb(96,0,0)` | 1→1 | forced-color-adjust:auto，系统禁用文字不叠加透明度 |
| 普通深浅主题 | 原有text-tertiary颜色断言保留 | disabled为0.48 | 原focus／禁用交互／布局断言随整份11项重跑通过 |

原普通主题7项GREEN仍是先前批次，未回写为“当时已覆盖高对比”。新的四组原始状态在 `non-s4-authlib-contrast-green/*/authlib-disabled-accessibility.json`，before是该用例禁用前状态，rows是禁用后的计算值；两者不与旧批次截图混作同一帧。

`non-s4-layout-green.json`原始reporter为18/18、96.3秒；其中4项首页和8项library有效通过。六项下载在首版断言下只比较了每列各行的x差，所有单元格实际同x堆叠时也会通过。人工查看发现后保留该批原始JSON／PNG，明确这六项不计入有效验收，没有回写reporter或把18项全称为设计GREEN。

下载最初真实RED中，中文status列x跨度44.671875px、英文30.78125px，其余列最大92.28125px。改为共同父grid／子行subgrid后，额外加入横向顺序、单元格在56px行内、垂直中心差≤1px断言（最终实测最大0.5px），`non-s4-downloads-containment-red.json`得到真实失败：content-visibility:auto使该行解析为grid-template-columns:none，首单元格中心在行中心上方18px。仅移除历史行content-visibility及对应intrinsic-size后，[non-s4-downloads-final-green.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-downloads-final-green.json) **6/6通过**、34.7秒、0失败／跳过／flaky；所有例都验证实际D3D11／DPR1。

| 最终下载语言／宽度 | 历史行数 | 行高 | 五列各自x跨度 | 列内／顺序／垂直中心 |
| --- | ---: | ---: | --- | --- |
| en-US／1050、1440、1920（各一例） | 每例30 | 56px | 每例0／0／0／0／0px | 六项全部通过 |
| zh-CN／1050、1440、1920（各一例） | 每例30 | 56px | 每例0／0／0／0／0px | 六项全部通过 |

数据、全部矩形及原图见[最终下载汇总](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-downloads-final-summary.md)。200任务夹具、30行、失败／完成覆盖、56px行高及原五列minmax保留，未缩短内容来通过。实际页面可用性另由后面的两张人工图记录支持。

材质专项 [non-s4-materials-summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-materials-summary.json) **10/10通过**、15.6秒、0失败／跳过／flaky。R2-28四组均按真实文本Range上下各两行、每组3帧／每帧7标签、共4200像素取最差值；下表均≥4.5，没有用CSS名义色代替相邻背景像素。

| 导航场景 | 实测最差对比 |
| --- | ---: |
| dark／full／solid | 6.670934208664121 |
| dark／Lite／solid | 6.781873936349915 |
| light／full／solid | 5.5944466148976755 |
| light／Lite／solid | 5.497016286699072 |

Toast两主题×减少透明／contrast-more／forced-colors共6例，每例root和modal两个host合计12状态；本体背景alpha255、有效opacity1，本体／before／after的backdrop-filter均none。强制色使用实际系统Canvas白色，其余使用相应surface实底；所有用例reducedMotion=false。现有产品已经满足这些材质规则，本次补的是持久原生守护，无Toast产品修改。

### S4第五次口径：五组诊断与四组正式RED

分层诊断读取实际CSS与SVG filter，并冻结同一帧作反事实截图。当前实际带曲率URL的匹配目标为活动胶囊；只移除导航表面filter对这批样本没有改变。首页深浅1280的列差在去掉胶囊折射后明显下降，去掉色散后几乎不变；隐藏文字／图标也没有降低深色首页的15.1349206。证据将问题定位到胶囊折射采样路径，尚不足以断言唯一修法或宣称不存在保留参数的修复。

以下来自 [s4-diagnostic-before/summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-diagnostic-before/summary.json)，每行是自己的固定帧，不与后续正式用例混合成同批测量：

| 场景 | 内部差>25比例 | 实际列差最大值 | 只关导航filter | 只关胶囊折射 | 只关色散 | 只关反射 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| dark/home/1280 | 4.695431% | 15.134921 | 15.134921 | 4.928571 | 15.140212 | 16.939153 |
| light/home/1280 | 3.553299% | 13.684524 | 13.684524 | 4.485450 | 13.690476 | 15.045635 |
| dark/library/1280 | 1.150628% | 3.620911 | 3.620911 | 1.188612 | 3.750120 | 4.025553 |
| light/library/1280 | 0% | 2.111171 | 2.111171 | 0.502345 | 2.116222 | 2.953884 |
| dark/home/1920 | 4.568528% | 5.392857 | 5.392857 | 2.224988 | 4.030423 | 6.569444 |

`s4-map-counterfactual/dark-home-1280/map-and-sampling-trace.json`记录实际map与计算map相同（mapMatch=true），shape为68×44、radius22、bevel20、inset3、refraction0.9、dispersion0.65。y=3.5–15的输出带被采到约17.3–18.9的窄source范围，提示采样聚集。仅在诊断图中换线性profile、反向位移、反向加线性后，列差分别14.440476、5.604497、6.204365；这些均是反事实，未写入产品，也未通过完整四组门槛与条纹位移回归。

[s4-new-reference-red.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-new-reference-red.json) 则为独立正式用例，实际D3D11／DPR=1，28.0秒、0跳过／flaky。深浅×首页／游戏库共四组；它们与上表所处帧不同，所以完整保留两批原始数据。

| 正式场景 | 内部差>25像素／总数 | 内部比例（须<0.5%） | 列差最大值（须≤12） | 结果 |
| --- | ---: | ---: | ---: | --- |
| dark/home/1440 | 58/788 | 7.360406% | 23.281085 | 失败 |
| dark/library/1440 | 0/956 | 0% | 15.238696 | 失败 |
| light/home/1440 | 49/788 | 6.218274% | 20.296296 | 失败 |
| light/library/1440 | 0/956 | 0% | 10.244889 | 通过 |

深浅首页首先在内部比例断言失败；表中的列剖面仍来自同次已保存JSON，不因测试提前失败而省略。`s4-new-reference-red/*/glass-interior/`保留actual／同帧reference／放大图及实际轮廓、内容框、renderer、refraction0.9、dispersion0.65与三个scale `[29.268,28.8,28.332]`。没有为了得到GREEN而减少full折射、修改色散、map尺寸、世界参数或阅读面不透明度。

### 第5项的预先对比方法、几何回归修复后14组结果与范围

6项非S4几何回归修复并通过原11项断言后，已再次采集全部14张当前图。最新权威批次为 `candidate-geometry-final/`／`comparison-geometry-final/`；`candidate-after-authlib/`／`comparison-after-authlib/`及更早 `complete` 等目录全部保留为修前历史。基线、夹具、mask、阈值及渲染参数未改。

`library/method-before-capture.md`在截图前规定：同一dark/full夹具、实际D3D11、DPR1，1050×720与1440×930；网格、列表和overview/content/worlds/logs/settings五个Tab，测试内固定uT=9.7并等待结晶／字体／UI稳定。像素变化定义为max RGB差>8，报告全图比例及预先列明UI矩形并集内各区比例，并集之外比例须≤0.5%。没有已有历史截图阈值可沿用，不会在见到失败后扩大mask或抬高阈值。

比较helper先2个真实失败后3/3通过。旧基线 `3f674c3d360308a00dc7bd18d4e674b4fb2f3a5f` 和候选源码分别启动浏览器、采集同夹具配对图。`baseline-clean/`为有效旧图，当前 `candidate-geometry-final/`对应165份src/public指纹 **`edb0836fb27ccb2dd7102cdad222db965f38754a500b7d84d37c2541b6ec341b`**，旧版为 `78bbc9fe0921eee4b9f012e64192144631ebee3493b829575792d5cdd6754e07`，各自采集前后保持相同。更新后的 `non-s4-final-integrity.json`确认当前工作区与最新截图源一致。旧 `after-authlib` 的 `a6fc420b…`、`complete` 的 `95402f79…`及更早批次按历史保留，没有重用其PNG冒充新源码。

[最终比较JSON](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/library/comparison-geometry-final/comparison.json)及[逐对表](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/library/comparison-geometry-final/comparison.md)共有14对，mask外变化比例均≤0.5%，最大为1050列表 **0.40490152597775914%**。全图变化为2.3360215053763438%–15.734617682198326%，包括预先声明的有意变化区域，不把它写成全画面未变化。

| 宽度 | 状态 | 全图变化比例 | 预声明UI并集外变化比例 | ≤0.5% |
| ---: | --- | ---: | ---: | --- |
| 1050 | 网格 | 4.234392% | 0.304399% | 通过 |
| 1050 | 列表 | 7.657275% | 0.404902% | 通过 |
| 1050 | 概览 | 9.946958% | 0.076074% | 通过 |
| 1050 | 内容 | 5.151587% | 0.046275% | 通过 |
| 1050 | 世界 | 5.000794% | 0.012537% | 通过 |
| 1050 | 日志 | 8.715079% | 0.086072% | 通过 |
| 1050 | 设置 | 15.401984% | 0.081183% | 通过 |
| 1440 | 网格 | 2.336022% | 0.101310% | 通过 |
| 1440 | 列表 | 4.818250% | 0.188531% | 通过 |
| 1440 | 概览 | 8.105361% | 0.069455% | 通过 |
| 1440 | 内容 | 2.857378% | 0.025689% | 通过 |
| 1440 | 世界 | 2.810111% | 0.025724% | 通过 |
| 1440 | 日志 | 5.391428% | 0.011591% | 通过 |
| 1440 | 设置 | 15.734618% | 0.015912% | 通过 |

差异所在区域、前后矩形与逐区像素比例由JSON逐项记录。[library最终复核说明](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/library/final-assessment.md)对网格、列表、概览、内容、世界、日志、设置逐项列出差异解释及其证据边界。命令栏差异包括已恢复的紧凑170px列最小值和真实刻度间距；详情包括获准padding22→24／26→24／28→32、h1 26→28、h2 16→20、数据单元／字段／日志区间距与圆角，以及已接受的选中语法。设置页仍可滚动，不声称全部内容一屏容纳。导航区域跨越基线后已有的C4真实折射修复，同时仍带当前S4待定外观，不能据本项像素比例把S4标为修复。

两版均使用未修改夹具SHA256 `23f98c5e0c37933e13d09ef87532664cdd9147d52bfd1eb31b8c50b9a1b4f7c3`，实际D3D11／DPR1。以下是图中实际应用的uOrigin，三个live program在各宽度一致且七个状态保持相同，GL读取前后错误均0：

| 宽度 | 基线uOrigin | 最终uOrigin |
| ---: | --- | --- |
| 1050 | (17.65468406677246, −59.457340240478516) | (18.8610897064209, −64.38088989257812) |
| 1440 | (15.686092376708984, −59.57719039916992) | (15.905516624450684, −63.41200256347656) |

**lastAnchorNdc 只做定性说明。** 两版从首页离开后保留lastAnchorNdc，先前首页几何不同使世界原点保留值不同。这是已观测的可比性限制，不能称背景完全相同；两个坐标均有变化，也不能把来源单独归因于水平rail。未做同帧world-only因果拆分，因此不把每一个区域外差异唯一归因于uOrigin。正常图和原始差值都包含这些变化，没有修改世界参数、归一化原点、扩大mask或调整门槛来消除差异。`baseline-original/`曾因读取StrictMode已删program而仅作诊断；有效基线已完整重采为 `baseline-clean/`，未偷偷替换单张失败图。

**逐区差异归类（原14对，以下列出1440全部7对及1050的内容／世界／日志）。** 数字是改后区域内 max RGB 差>8 的比例；区域有重叠，不能相加。所有行的导航区差异含 C4 已修的真实折射；当批 S4 竖条尚未修，不能作为预期差异，之后由 CVERIFY 单独关闭。页眉差异属于既定标题／页眉对齐样式；详情的 h1 从26到28为有意，历史区块 h2 的20已在后续修订纠正。区域外保留原数字，不作像素级因果归类。

| 宽/视图 | 导航 / 页眉 % | 操作栏 / 卡片表，或上下文 / 工作区 % | 区外 % | 区内归类 |
| --- | --- | --- | ---: | --- |
| 1050/content | 0.544 / 10.899 | 13.267 / 10.155 | 0.046 | 上下文：侧栏选块及内距（有意）；工作区：紧凑22→24四边为有意刻度规范化，覆盖顺序修复属于此前分拆回归的修复过程；工具栏间距及当批空态标题映射（有意，后续恢复区块字号）。图中没有资源行，不把资源标题行距修复归因为本对差异。 |
| 1050/worlds | 0.542 / 10.854 | 16.627 / 6.003 | 0.013 | 上下文：侧栏选块及内距（有意）；工作区：紧凑22→24四边为有意刻度规范化，覆盖顺序修复属于此前分拆回归的修复过程；世界面板间距及当批区块／空态标题带来的高度变化（有意的历史映射，后续恢复区块字号）。 |
| 1050/logs | 0.566 / 10.857 | 18.904 / 17.628 | 0.086 | 上下文：侧栏选块及内距（有意）；工作区：紧凑22→24四边为有意刻度规范化，覆盖顺序修复属于此前分拆回归的修复过程；日志块间距、圆角及当批区块标题（有意的历史映射，后续恢复区块字号）。 |
| 1440/grid | 0.531 / 3.086 | 13.292 / 7.823 | 0.101 | 操作栏：间距刻度加宽列轨道（有意为之），来自控件宽度变化后的轨道分配；旧版与最终版inset均2px，列模板均为minmax(180px,1fr) auto auto，本对无inset恢复或模板恢复；卡区：卡片/footer间距与路径排列（有意）。 |
| 1440/list | 0.571 / 3.225 | 13.025 / 13.077 | 0.189 | 操作栏：间距刻度加宽列轨道（有意为之），来自控件宽度变化后的轨道分配；旧版与最终版inset均2px，列模板均为minmax(180px,1fr) auto auto，本对无inset恢复或模板恢复；列表区：行和footer刻度（有意），压力尾段限制另列。 |
| 1440/overview | 0.550 / 8.667 | 10.165 / 13.646 | 0.069 | 上下文：侧栏行选块、间距（有意）；工作区：常规padding24/26/28/26→24/24/32/24为有意规范化，1440不适用紧凑规则；数据单元间距／圆角及当批标题映射（有意）。 |
| 1440/content | 0.665 / 8.802 | 13.453 / 7.063 | 0.026 | 上下文：侧栏选块及内距（有意）；工作区：常规padding24/26/28/26→24/24/32/24为有意规范化，1440不适用紧凑规则；工具栏间距及当批空态标题映射（有意，后续恢复区块字号）。图中没有资源行，不把资源标题行距修复归因为本对差异。 |
| 1440/worlds | 0.533 / 8.789 | 17.077 / 4.252 | 0.026 | 上下文：侧栏选块及内距（有意）；工作区：常规padding24/26/28/26→24/24/32/24为有意规范化，1440不适用紧凑规则；世界面板间距及当批标题映射（有意，后续恢复区块字号）。 |
| 1440/logs | 0.544 / 8.726 | 18.853 / 14.832 | 0.012 | 上下文：侧栏选块及内距（有意）；工作区：常规padding24/26/28/26→24/24/32/24为有意规范化，1440不适用紧凑规则；日志块间距／圆角及当批标题映射（有意，后续恢复区块字号）。 |
| 1440/settings | 0.531 / 8.726 | 20.758 / 27.517 | 0.016 | 上下文：侧栏选块及内距（有意）；工作区：常规padding24/26/28/26→24/24/32/24为有意规范化，1440不适用紧凑规则；表单刻度、标签及当批标题映射（有意，后续恢复区块字号）。 |

分区矩形、改前与改后两套比例及差值图见[原始比较JSON](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/library/comparison-geometry-final/comparison.json)。此次补充按已有源审计、图和区域统计归类，未重拍14对，也未把像素逐个分配给某个CSS改动。

### 人工查看记录（与自动数字分列）

主流程实际查看S4的 [dark/home/1280实际6倍图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-diagnostic-before/dark-home-1280/actual-6x.png)、[light/home/1280实际6倍图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-diagnostic-before/light-home-1280/actual-6x.png)，以及dark/home/1280的 [linear-profile](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-map-counterfactual/dark-home-1280/linear-profile/actual-6x.png)、[inverse-direction](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-map-counterfactual/dark-home-1280/inverse-direction/actual-6x.png)、[inverse-linear](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-map-counterfactual/dark-home-1280/inverse-linear/actual-6x.png) 三张反事实6倍图。以上查看用于问题诊断，没有签字确认四组合“竖条／单侧色边均已消失”，反事实图不能作为产品修复后图。

对话框代理实际查看以下四张最终PNG，结论与完整18组自动几何分开：

- [dark1050 Authlib列表](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/dialogs-native-green/verification-dialogs-verif-a8244--stay-inside-their-controls/authlib-profile-rows.png)：选中填充位于tab内，panel有明确间距，名称与完整UUID可见。
- [light1440 manual焦点](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/dialogs-native-green/verification-dialogs-verif-3d7ee-code-tab-without-cancelling/login-manual-focus.png)：Microsoft选中填充／焦点贴合tab，设备码panel分隔清楚。
- [light1050 Authlib焦点](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/dialogs-native-green/verification-dialogs-verif-62d29--stay-inside-their-controls/authlib-focus.png)：第二行四条内缩焦点边均可见。
- [light1050 Authlib禁用](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/dialogs-native-green/verification-dialogs-verif-62d29--stay-inside-their-controls/authlib-disabled.png)：两行名称均显示弱化前景色。

恢复非S4后、追加Authlib修复前，主流程实际查看了以下三张；保留实际查看的原路径，不把旧图改名冒充新批次：

- [浅色1440首页占位](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-layout-green/verification-home-verifica-19512-entered-with-secondary-text/profile-failure-centered.png)：占位内容居中，文字使用次要色。
- [当批1050详情概览](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/library/candidate-complete/1050/overview.png)：详情侧栏选块对齐，h2与紧凑间距可读。
- [当批1440列表](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/library/candidate-complete/1440/list.png)：三行列表、路径与按钮无重叠；未把已知导航S4外观称为已修。

下载代理实际查看最终 [英文1050](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-downloads-final-green/verification-downloads-R2--f8383--failed-and-completed-tasks/downloads-200-columns.png) 与 [英文1920](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-downloads-final-green/verification-downloads-R2--4be14--failed-and-completed-tasks/downloads-200-columns.png)：status、size、date与Retry实际在同一行横向显示，失败／完成行列对齐。该观察仅覆盖这两张，不扩大为全部六组均逐张人工签字。

library代理实际查看最新 `candidate-geometry-final/` 的1050 grid／list／overview／settings及1440 content／worlds／logs共7张，配合已查看的7张 `baseline-clean/`构成最终7组、14张正常图。逐张路径和各视图差异说明见[最终人工清单](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/library/final-assessment.md)。commandbar在中间实现中出现过4px inset，随后恢复2px，这是中间回归修复；本节旧基线和最终配对均为2px，不能用该修复解释两版截图差异。`candidate-after-authlib/`及更早各批人工记录保留历史，未替代最新图；没有声称全部28张正常图或14张diff图均人工看过。

Authlib追加修复后，token代理实际查看了 [深色contrast-more](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-authlib-contrast-green/verification-dialogs-verif-64900-pearance-dark-contrast-more/authlib-disabled-accessibility.png)、[浅色contrast-more](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-authlib-contrast-green/verification-dialogs-verif-96aef-earance-light-contrast-more/authlib-disabled-accessibility.png) 和 [浅色forced-colors](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-authlib-contrast-green/verification-dialogs-verif-7105b-earance-light-forced-colors/authlib-disabled-accessibility.png) 三张禁用态图，用于核查高对比禁用弱化及系统GrayText保留；此人工范围与11项数值／行为通过分别记录。

上述有限观察不扩写为全部自动保存图、操作系统或真实身份服务已人工验证；登录IPC、安装与游戏状态均使用明确夹具。

首次304项完整批次中，主流程另实际查看固定uT=9.7的 [1050正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-complete/world-acceptance-terrain-b-3091c--retains-highlight-headroom/terrain-phase/normal-2.png)、[1280正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-complete/world-acceptance-terrain-b-dd257--retains-highlight-headroom/terrain-phase/normal-2.png)、[1920正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-complete/world-acceptance-terrain-b-186c1--retains-highlight-headroom/terrain-phase/normal-2.png)：角色脚部均在岛面范围内，未见明显离岛或纯白光斑。人工签字只覆盖这3张，不扩大为全部12相位。对应startupMean分别为 **103.38753262705372、99.36089087808988、92.05369508457301**，固定90–150数值条件通过。

最新 `non-s4-final` 完整批次中，主流程重新打开固定uT=9.7的 [1050正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-final/world-acceptance-terrain-b-3091c--retains-highlight-headroom/terrain-phase/normal-2.png)、[1280正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-final/world-acceptance-terrain-b-dd257--retains-highlight-headroom/terrain-phase/normal-2.png)、[1920正常图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-final/world-acceptance-terrain-b-186c1--retains-highlight-headroom/terrain-phase/normal-2.png)：结论仍为脚部在岛面范围内，未见明显离岛或纯白光斑。此次签字仅覆盖这3张最新图；本次startupMean使用前面最新完整批次表中的103.3877437432828／99.36176470588187／92.0537140046169，不沿用上一批数值，也不扩写为全部相位或动态图均已人工看过。

主流程还查看了同批 [山体人工图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-complete/world-acceptance-round-2-a-855b6-oundings-meet-their-budgets/massif-manual.png)：受光面、暗侧面和柱缝仍可辨，未见大片纯白光斑；此图不另声称精确脚站位。另看同批 [浅色contrast-more Authlib图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-complete/verification-dialogs-verif-96aef-earance-light-contrast-more/authlib-disabled-accessibility.png)：两行明显弱化且可读，完整UUID、标签选块和间距正常。这5张新增人工观察不改变该完整批次295通过／9失败的总体结果。

### 关键证据SHA256与当前验证边界

下面是本部分报告读取时的证据指纹，路径均相对本节 `verification/`；它们固定可复查结果，不表示整个未提交工作区已经完成验收。

| 证据 | SHA256 |
| --- | --- |
| `revision7-edge-reference.json` | `5af6fc303e38520c59fec37cb906a02938867b277b83b127d82531b6123b7337` |
| `focus-r7-first.json` | `e99d0e1c9e67e35c913f210fe28c982e2df57b496d6412f23d22659d6e40b7ce` |
| `s4-diagnostic-before/summary.json` | `d553a686abf764089159337688369b7e9eb7ec158ceb6032bbd0f35b6c397dae` |
| `s4-new-reference-red.json` | `10053f24b71fcf400a1d6170edc8ada3a3a28407452d0019d7ceca5245b0e980` |
| `dialogs-summary.json` | `5a8c6670305232de878728cac3f5e2385b30c321659e10bcaa1753bb1b0d12bf` |
| `library/identity-mutations.json` | `b081ff6e2292f69c033cfaf67cf280950c121119641fd9d37d4b9d4531e94e32` |
| `token-guard-final-green.log` | `57a752b5fbd1e2eea2f694387e7194cd4baf22725f1c2db0d1a92e0c0f13c8ad` |
| `s4-frozen-before-non-s4.json` | `3c5c446d1a72a20b44a35031239bb3ed94439f4f6869c7fcf84860f27b9f55d0` |
| `non-s4-layout-green.json`（下载六项无效覆盖，仅取首页／library有效项） | `d40cce91d57123b6ce9854ead630d1efe5b6e90bab4c6f2069e4466b72a88ea6` |
| `non-s4-downloads-final-green.json` | `acc7273036cf9276de8bd4bd3eb71322848ff65baa8d0282202543ffa1d2f31a` |
| `non-s4-materials-summary.json` | `1a2bc88f32e497e71b434eb2bb4672441dda23d21ffe95b0af049f0f2bb07a87` |
| `token-scale-mapping-initial-applied.json`（首次102条原件） | `3c23c3e00d68d7b5ee8bdd0af3ab5959d4e17ffac4f04e8f0efc836abe65f444` |
| `token-scale-mapping-applied.json`（含全套后局部修正） | `3c588413466d7ef28f9d917c36fb93b7e1aa5efe3c79ae3b9083d9b035ccb0bb` |
| `non-s4-spacing-counts.json`（当前359） | `fd5819f37dd43388c4ccf82db103610aaee2f58942691105509ad679b73ff79f` |
| `library/comparison-complete/comparison.json` | `b8a55f0c9afc3743b5dc3c3aabfb980f347394dab6d37e821756474c56fd0748` |
| `non-s4-test-design.json` | `33b284e3f25f99e61046496bdc987a227e2bba63688b445f0361079c1ba7271b` |
| `non-s4-authlib-contrast-green.json` | `3f6bfbcac15f637c08896d4bce3b0351524da9a59946771447a980af55be593e` |
| `library/comparison-after-authlib/comparison.json` | `8c1e9c32aca854e82fa16d60f487c23a1c6b73fc08dd72d6924d793723152995` |
| `non-s4-final-integrity.json`（最终完整运行后核对） | `9f30a9acee8ca7718fb191505d84c5fccbb83dd810edde12a8988fd929201f1c` |
| `non-s4-complete-npm-test.log` | `0712bafe8de06552e64b6209e361a62c18d3c6780047acd82ac83150d3a82ca2` |
| `non-s4-complete.json`（295通过／9失败原件） | `86392ce813596e384bdaa58997a4c1285c5202b0f7ddccf027d326e29777ccf8` |
| `geometry-contract-green.json` | `6aa8fb5373a9f60ff03745e613c6022984e4843d57eb06518ffb175ccf580904` |
| `library/comparison-geometry-final/comparison.json` | `b8e0d2cc190c55d2edeb9c57b88835d1bebd4f2de490ccc554cdda4d8bd36b9a` |
| `non-s4-final-npm-test.log` | `6b1ceeb1aa018f7954e6937bfd62bc61a3fda9a7f8e8ea8643b992886ee6bbf2` |
| `non-s4-final.json`（301通过／3项S4失败） | `86bf2c5546161ec32448d0eb6670b0aeffba9de9c29721cfc692688c501ae02c` |
| `non-s4-final-summary.json` | `7483477254b2bab09882f3a991c1169eaa6f41e4551f049451985e2e1847941b` |
| `non-s4-final-evidence-audit.json` | `9f7e2bc6007e32970dc4fadbc7519e0ad47092dc0e6c4db6642680ada20e7e2d` |

所有早期专项及截图保留实际批次，不合并为完整GREEN。39项中止批次不是完整结果；`non-s4-complete`的完整 **295通过／9失败**不回写。6项非S4回归按原断言修复后，11月6日 `non-s4-final`完整 **301通过／3项S4失败**，300项非S4用例通过。当时14对截图、npm686＋90／实际359和TypeScript退出0对应 `edb0836f…ec341b` 源码；S4在该历史批次仍冻结。11月7日第六次限幅与获准采样修订后的最新完整结果为`s4-r6/final-playwright`的304/304，数值与审计见上节，不回写历史批次。

[11月6日完整运行后的核对](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/non-s4-final-integrity.json)确认**该批次**S4的23文件及测试块全部未变，当时165份src/public为 `edb0836f…ec341b`并与 `candidate-geometry-final`匹配；它不能证明获准第六次修订后glass文件仍未改。该批次结束时没有构建安装包、提交或推送，临时服务已停止。11月7日的新源码验证与运行状态以上方S4进展为准。

| 验证命令／批次 | 当前已取得结果 | 证据 |
| --- | --- | --- |
| `npm test`（高对比追加修复前） | 69文件686项Vitest＋90项Node通过，静态guard实际358，退出0；作为历史批次保留 | `non-s4-full-npm-test.log` |
| `npx tsc -b`（高对比追加修复前） | 首次3处新下载测试隐式any失败；仅修测试类型后退出0，作为历史批次保留 | 初次 `non-s4-full-tsc.log` 保留；复验 `non-s4-tsc-types-fixed.log` 无输出，主流程确认退出0 |
| `npm run test:design`（高对比追加修复前） | 19/19通过、137.7秒、0失败／跳过／flaky，退出0；最终完整套件已再次执行并通过这19项，未再次单独执行该命令 | `non-s4-test-design.json/.log` |
| `npm run test:e2e`（首次全套尝试） | **主动中止于39项通过，非完整结果。** 原因是发现第7项Authlib contrast-more残留，先补RED／修复；S4仍冻结 | `non-s4-full.log`保留中止前输出，不将39项当完整GREEN |
| `npm test`（Authlib追加后、6项回归修复前） | 69文件686项Vitest＋90项Node通过，静态358，退出0；只证明该批命令 | `non-s4-complete-npm-test.log` |
| `npx tsc -b`（Authlib追加后、6项回归修复前） | 退出0，日志无输出；由主流程实际退出码确认 | `non-s4-complete-tsc.log` |
| `npm run test:e2e`（首次跑完304项） | **295通过／9失败，0跳过／flaky，27.5分钟**；3项S4冻结、6项非S4回归待修 | `non-s4-complete.json/.log`及全部输出原样保留 |
| 原几何契约专项 | 原6项失败及相邻5项共11/11通过、34.2秒，测试及门槛未改 | `geometry-contract-green.json/.log` |
| `npm test`（6项回归修复后） | 69文件686项Vitest＋90项Node通过，实际spacing359，退出0 | `non-s4-final-npm-test.log` |
| `npx tsc -b`（6项回归修复后） | 退出0，空日志由主流程实际退出码确认 | `non-s4-final-tsc.log` |
| `npm run test:e2e`（最终修复后完整批次） | **304项：301通过／3失败，0跳过／flaky，顶层errors=[]，27.78分钟；退出1**。3失败全部为冻结S4，300项非S4通过 | `non-s4-final.json/.log`、summary及独立evidence-audit；原39中止及295／9失败批次不覆盖 |
| 最终套件中的design-consistency | 同一最终完整套件内19/19通过；并非再次单独执行test:design | `non-s4-final-summary.json`中该文件19项均expected／passed |
| 提交／推送（11月6日收尾） | 当时按要求均未执行；后续S4完整验证已通过，已合成 CVERIFY 并推送，提交和远端读数见本节开头 | 本表只保留11月6日状态，与后续已推送的 CVERIFY 分列 |

### S4第五次停止判断的独立复核（历史，后续第六次已批准尺寸限幅）

[独立只读诊断](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/s4-independent-diagnosis.md)核对源码、逐字节map匹配、采样轨迹和既有PNG，没有运行第二个GPU进程或更改产品。它确认当前直边位移的有效宽度为16.72px，峰值位移13.824px；源采样坐标随输出y的最小导数为−0.24019，在局部y约7.68–15.04存在折返，进入当前4px内缩ROI。失败亮条最大值在屏幕x=199，实际胶囊中心为194.75，不能直接当作贴图中心拼缝。

这解释了当前曲线如何拉长背景特征，但没有证明所有同参数算法都不可能满足要求。三种仅在测试页替换map的反事实，内部比例分别为7.233503%、4.568528%、3.680203%，仍超过0.5%；没有一项成为产品修复，也没有据此接受色边或放宽门槛。以上是停止时的诊断历史。用户随后确认第五次内部差异口径会测入折射本身，决定**S4保持冻结、另待设计裁定，继续全部非S4工作**。折射强度0.9、色散0.65、map尺寸、世界参数、阅读面透明度及S4失败用例均保持原样；本轮不自行选择新的光学设计或调整验收口径。

<a id="follow-ups-6921a83"></a>

## 6921a83 独立复核后的修订

本节已合入并正常推送提交 `301029025bb2014f6be9eeb44be36e990913d9cf`；[远端原始读数](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/git-ls-remote-origin.log)和[提交回执](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/commit-receipt.json)记录该完整SHA。下方的精确主题定位保留作复查方式。

用户独立复核确认 6921a83 的提交身份、远端、716＋96、tsc、完整 304/304 和人工视觉结果。本节单独记录随后第1–11项；证据在 `E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/`。最终完整套件305/305通过；实测命令及提交归属见本节末。

| 编号 | 处理与实测 | 证据 |
| --- | --- | --- |
| 1、4 | 共享区块字型恢复16px；原被提升的区块选择器复用该角色。详情 `.vx-detail-section h2` 恢复16px/1.35（21.6px）。英文深色1050确实渲染了服务器：实体名20px、行距25px、高50px，正好两行；托管服务器名称同为20px，控制台区块16px。受测每页的28px只出现在h1。 | `type-loader/red-headings.json` 实测区块误为20、详情行距30；`red-managed.json` 证实区分实体与区块；`green.json` 和 `green-managed.json` 对应验证通过。[刻度附录](2026-11-06-design-token-mapping.md)保留历史并补遗漏。 |
| 2 | 按有效几何（含实际图栅格、inset/radius、两轴 bend）缓存区间锥，最多8种几何、每种8192格；解析快检只跳过对所有法线都安全的角点，余下沿用原区间证书并在首个失败点短路。重试比率、门槛、光学参数不变；每次重试只重编码斜面。实时路径仍同步生成后异步编码，未移线程。 | [Node三版本基准](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/curvature-performance/node-final.json)、`node-red.json`；`refraction-live-bytes.test.ts` 锁定来自6921a83的60个完整RGBA摘要，0差异。7文件64项玻璃专项通过。下表列出Node与真实D3D11交互。 |
| 3 | 收起时不保留底部6px焦点留白及其抵消负边距；打开后恢复。固定1280同一帧仅隐藏槽标签作像素对照，折叠86→0，展开正对照641；保持各模式M4间距20、焦点轮廓5、留白6/6/28.796875/6及状态左/底12。 | `type-loader/red.json`、`green.json`、`green-managed.json` 及其输出图；先改用正确 ChildNode 移除语义解决初次 tsc TS2339，未改变像素门槛或旧M4断言。 |
| 5 | 右、下相邻像素改为 `ceil(edge+offset+width)`；左、上原偏移保持。单测覆盖几何四边和1:1孤立暗点：中位数合格，单点只记录。按一次新校准改浅色参考 `#dad8d2 → #dbd9d3`，默认指示色 `#508700 → #538900`；文字强调色 `#3f7400` 不动，对新参考4.010716:1低于4.5，按原裁定记录。 | [校准](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/focus/recomputed-reference.json)、[独立复验](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/focus/native-verified-edges.json)。校准最暗是full「关闭」左边x1209、y22–59，中位(223,221.5,215.5)，减4并向下取整；历史图同帧复读只作诊断。复验全动态/Lite/减少动态各48站192边，最低3.433399/3.277515/3.277515；最暗孤立点低于3的条数16/8/8，只记录。没有用复验数据再次校准。 |
| 6 | 新增 en/1920 普通夹具名 “Western Wilderness Workshop District”，36字符、两行，实际 `scrollHeight/clientHeight=45/45`、`scrollWidth/clientWidth=261/261`，正向证明内容完整。原压力夹具未改，尾段484/172的限制仍保留。 | `type-loader/green.json`、常见名称截图及布局JSON。新增是覆盖缺口，既有产品本就支持该长度，未为制造RED而改产品。 |
| 7 | 任意前缀的裸数字结尾、声明等于同一px数值会失败；真实 spacing 刻度保留固定值校验，既有语义角色不受影响。原编码名称守护仍在。 | `token-red.log` 明确失败在 `--font-18`，`token-green.log` 13/13；真实仓库23份样式表、359间距字面量。 |
| 8–11 | 修正旧220、501、223行的时间口径；补CVERIFY完整SHA和原远端读数；15个实际几何逐一对照26组产品图，区分4个胶囊的另拍／未拍；补14对中指定10对逐区差异归类及lastAnchorNdc证据边界。 | `report-red.log` 原八项缺漏，`report-green.log` 八项通过；见本报告对应历史段落。 |

Node v24.18.0、Core Ultra 9 275HX。每个尺寸12种按产品量化刻度选取的合成实时姿态，预热两轮，交错计时七轮并取批次中位；仅生成RGBA，不含DOM/PNG。三版本用相同输入。

| 尺寸 | 0cc8f55 ms/图 | 6921a83 ms/图 | 修后 ms/图 | 修后/0cc8f55 |
| --- | ---: | ---: | ---: | ---: |
| 80×44 | 0.734 | 9.446 | 1.358 | 1.850 |
| 400×56 | 4.149 | 57.018 | 3.988 | 0.961 |
| 360×50 | 3.382 | 45.625 | 3.336 | 0.986 |
| 324×198 | 7.241 | 64.984 | 5.917 | 0.817 |
| 324×360 | 11.044 | 88.231 | 8.283 | 0.750 |

[原生帧间隔录制](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/native-timing-comparison/summary.json) 在 RTX 5080 Laptop D3D11、1920×1080、DPR1、深色Full、动态世界下交错对照两版，每版三次独立浏览器上下文。导航从首页拖到设置，启动表面保持按压并小幅移动，移出后释放以免启动。两版发送相同序列的真实指针事件；实际墙钟长度随阻塞不同。只统计完全落在 pointerdown 到 pointerup 之间的 rAF 间隔，保留逐帧时间、实际压力、光学图更新和空闲对照；录制中不截图。

| 动作 | 6921a83 各次 p95 (ms) | 修后各次 p95 (ms) | p95中位 (ms) | >16.7ms 帧数（旧→新） |
| --- | --- | --- | --- | --- |
| 导航拖动 | 12.6 / 12.6 / 12.6 | 4.3 / 4.3 / 4.3 | 12.6 → 4.3 | 7/3/5 → 0/0/0 |
| 启动表面按压 | 158.4 / 166.7 / 166.6 | 4.3 / 4.3 / 4.3 | 166.6 → 4.3 | 34/35/36 → 0/0/0 |

该测试衡量指定机器与手势下主线程可见的帧间隔，不外推到其它显卡、WebView2 或输入设备。本轮未构建安装包、未改版本/依赖；没有重新拍摄上一轮26组或14组静态历史对照，也未验证旧压力尾段完整可见。

| 最终命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | 退出0；72份文件、722项Vitest、99项Node、静态守护23份CSS／359 | [npm-test.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/npm-test.log) |
| `npx tsc -b` | 退出0 | [tsc.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/tsc.log)（空输出） |
| `npm run test:e2e` | 退出0；305/305，26.6分钟（1597.569486秒）；0失败／跳过／flaky／重试 | [Playwright日志](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/playwright.log)、[独立证据审计](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/playwright-audit.json) |

审计读取实际 GPU 字符串，确认 19 个设计用例、5 个焦点用例、12 个固定相位、5 个动态世界场景及4组S4均为 RTX 5080 Laptop D3D11、DPR1；其余测试不一概写作原生。三模式最低边对比为3.433399／3.277515／3.277515，576边全部合格。S4实际四组（深首页／深库页／浅首页／浅库页）列差5.347884／4.162157／5.123016／3.056157，均≤12；四个共用条纹用例均通过。完整套件也覆盖了 `npm run test:design` 所选的19项，未在本轮另行执行该命令。校验前后的389个源码／测试／脚本文件指纹相同，SHA256为 `710a53cdb7b1a75976316ac54b961fb6be3d06c9ccf41666bc19c22702e3aac1`。

本节第1–11项属于同一提交 `fix: close 6921a83 review follow-ups`。仓库内以 `git log main -1 --format=%H --grep='^fix: close 6921a83 review follow-ups$' -- docs/reports/2026-11-05-review-round2-fixes.md` 取得本节的完整 SHA；[提交回执](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/commit-receipt.json)逐项记录该 SHA，[远端原始读数](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/git-ls-remote-origin.log)记录推送后远端 ref。报告不将自身提交的哈希写入自身内容。

<a id="final-round-two-cleanup"></a>

## 第二轮最终清理（3010290 独立复核后）

本节只涉及单向姿态字节夹具、一条托管服务器标题CSS及对应浏览器断言、历史报告说明。归属唯一提交 `chore: final round two cleanup`；完整SHA可由 `git log main -1 --format=%H --grep='^chore: final round two cleanup$' -- docs/reports/2026-11-05-review-round2-fixes.md` 精确定位。提交后[回执](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/commit-receipt.json)记录该SHA、四项归属和推送确认，[远端原始读数](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/git-ls-remote-origin.log)保留ls-remote结果。

| 项 | 实际处理及证据 |
| --- | --- |
| 1 字节锁单向姿态 | 保留原12姿态／60摘要，新增(2.4,0)、(−2.4,0)、(0,−1.2)、(0,1.2)，压力均非0，覆盖80×44、400×56、360×50、324×198、324×360，现16姿态／80摘要。期望值全部由 `git show 6921a83` 的独立原生成器计算，先复算确认原60摘要一致；源码blob和SHA见[oracle-provenance.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/axis/oracle-provenance.json)。 |
| 1 变异RED | 把单向弯曲迭代分支从1改0：原夹具5/5通过，扩展后五种尺寸全失败、20个新增摘要全不同；恢复后5/5通过。保留[变异失败日志](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/axis/02-expanded-fixture-mutant-red.log)、[恢复后通过日志](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/axis/03-expanded-fixture-restored-green.log)和[源码恢复核对](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/axis/mutation-integrity.json)。geometry.ts前后字节和SHA完全一致，产品算法没有改动。 |
| 2 实体标题 | `.vx-managed-overview h2` 显式 `font-weight:var(--weight-strong)`、`line-height:1.25`，保持20px。标题用例新增字重600和实际行距25px断言。修改前字重已经由全局继承为600；真实RED是行距30≠25，[title-red.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/title-red.log)保留；修改后20/600/25，控制台区块仍16。[最终heading-scale.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/playwright/verification-library-R2-14-e9150-ile-R2-16-sections-use-16px/heading-scale.json)。 |
| 3 历史图归因 | 1440 grid/list两端inset都2px，删除“恢复inset”作为配对差异解释，改为间距与控件宽度造成的列轨重新分配；列模板本身未改。1440详情5行统一说明常规padding24/26/28/26→24/24/32/24是有意规范化，紧凑规则不适用。1050三行明确紧凑22→24也是刻度规范化；覆盖顺序修复另记为中间回归过程。content两张均空资源区，删除资源行距修复的错误因果归属。逐区数值、原截图、mask和门槛未改；lastAnchorNdc仍仅定性说明，无像素因果拆分。 |
| 4 历史完成状态 | 原974行改成CVERIFY已提交／推送，引用6921a83完整SHA及真实ls-remote回执。3010290独立小节补 `301029025bb2014f6be9eeb44be36e990913d9cf` 及其远端回执；不再将已完成的前两次提交写作未来操作。 |

最终实际运行：

| 命令 | 结果 |
| --- | --- |
| `npm test` | 退出0；72文件、722项Vitest＋99项Node；CSS守护23文件／359。[完整日志](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/npm-test.log)。扩展的是表驱动夹具，所以Vitest项数不变。 |
| `npx tsc -b` | 退出0，[日志](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/tsc.log)为空。 |
| `node node_modules/@playwright/test/cli.js test tests/e2e/verification-library.spec.ts tests/e2e/review-fixes.spec.ts tests/e2e/interface-quality.spec.ts -g 'R2-14 server entity|S4 (dark|light)|curvature (dark|light):' --output=… --reporter=list,json` | **7/7通过**，42.469684秒，0失败／跳过／flaky，全部首次通过，退出0。[原始JSON](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/playwright.json)、[日志](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/playwright.log)、[独立读数审计](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/playwright-audit.json)。 |

上述7项是：英文深色1050真实服务器及托管实体／区块标题1项；深浅×首页／库页S4列剖面4项；interface-quality深浅真实背景折射2项。7份runtime实际均为RTX 5080 Laptop D3D11；标题及折射上下文DPR1，四组S4也各自记录DPR1。S4列差5.347884／4.162278／5.123016／3.065416均≤12；两条纹用例live=7、edge≈3、center≈0.000322，通过原门槛。首次筛选只命中标题的1/1通过批次另存 `title-green.json/.log`，没有当作7项结果。

主流程实际打开了本批托管标题的[修改前图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/title-red/verification-library-R2-14-e9150-ile-R2-16-sections-use-16px/en-dark-1050-managed-title.png)及[修改后图](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/final-cleanup/playwright/verification-library-R2-14-e9150-ile-R2-16-sections-use-16px/en-dark-1050-managed-title.png)：标题仍为两行粗体，行距更紧；该观察不扩大为本批全部S4图均已逐张人工复看。

本轮依用户要求**未重跑完整Playwright**，也未重测三版本性能、未重拍原26／14对历史取证。未改版本、依赖或贴图产品算法，未构建安装包。上一轮完整305/305及1628张字节一致属于用户独立复核结论，不冒称本轮新增测量。
