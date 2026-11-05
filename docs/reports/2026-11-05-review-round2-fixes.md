# 第二轮修复：阶段1收尾及阶段2–4验收记录

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
| R2-07 | 基础CSS在App前导入，按tokens/base/primitives/features/overrides分层，清理失效覆盖；详情弹窗实测1440窗口下宽720px。普通与减少透明/高对比的几何检查通过；强制颜色测试原先错误比较跨系统滚动条模式的绝对屏幕x，修正为相同阅读面内部几何后重跑通过，未改产品迁就测试 | `design-first/design-consistency-R2-07-d-ee5b4-eps-its-720px-width-at-1440/discover-details-geometry.json`与PNG；`forced-geometry.log`、`forced-geometry/*/degraded-geometry.json`；`css-entry-red.log`、`css-entry-green.log`、`css-contract.json` |

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

## 阶段4：第五次修订后的自动验证完成，准备同一C4提交

本节全部编号归属同一个待提交的 **C4：阶段4工作区修复（尚未提交、尚未推送）**。第三遍完整验收出现1920动态等待超时，当时按用户“验收冲突先停下报告”的规则停止；用户确认M2第五次修订后恢复验收，现已完成新的自动验证。C4仍只是工作编号，不代表实际提交SHA；本报告随同一提交进入版本控制，不能预先自嵌该提交的SHA。实际提交／推送后由后续补录填写SHA及外部回执，不能用此前已提交阶段的git log结果代替C4。

证据根为`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/`。第四次及后续第五次清单修订由审查方代用户决定，用户确认后执行。以下区分已经结束的专项数值／行为检查、人工检查和仍待完成的最终验证；R2-29按要求不做。版本仍为0.6.0，未新增依赖、构建安装包或改变全局背景。

**当前执行状态：自动验证完成，准备同一C4提交。**第五次修订后的新完整Playwright为252通过、0失败、0跳过、0flaky，运行错误列表为空；新的npm为67文件674项Vitest＋77项Node通过，TypeScript由主流程确认退出0、日志无错误输出。六项原生专项、30项聚焦Node及三种S2键盘关闭检查另有独立记录。完整世界数值已汇总，主流程已单独查看最终三张固定9.7正常图，人工范围仅限这三张；当前尚未提交／推送。下文三遍历史完整252项的248通过／4失败、251通过／1失败、251通过／1失败均保留，均0跳过、0flaky。第三遍唯一失败仍是旧稳定判据下深色地平线1920动态M1/M2等待20017.1ms超时，未生成正式五帧或numeric-acceptance；此次新运行不改写该次失败。

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

下表每条计划归属C4，当前均为未提交工作区改动。“通过”只指本行列出的专项检查，不替代最终全套结果。JSON所在目录保留原始截图；单测不当作视觉或读屏验证。

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
| R2-19 | 1050：textWidth=176px，cards=[313.5, 313.5]，feet=(676.5000,464.4063)；1920：textWidth=280px，cards=[274.65625, 274.671875]，feet=(1167.5000,687.4063)；1280：textWidth=176px，cards=[277.65625, 277.671875]，feet=(795.5000,456.4063) | [home-anchor.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-19-ho-2163b-hor-and-responsive-controls/home-anchor.json)；[home-anchor.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-19-ho-9220b-hor-and-responsive-controls/home-anchor.json)；[home-anchor.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-19-ho-b6f47-hor-and-responsive-controls/home-anchor.json) | 1920文本280px达标；原动态M2 mean88.979失败保留，现按用户第四次修订在固定uT9.7判均值，固定三宽已通过，1920动态等待超时未完成正式取样；站位人工结论在本节另列。 |
| R2-20 | 有效响应式采样11/11通过：1050/1179/1180/1279/1280/1440/1920正常，以及1050/1920 forced-colors和减少透明；console/character交叠面积均0。全局max-width只保留1179/760。 | [css-independent-review.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/css-independent-review.json)；[responsive-reduced-transparency.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/responsive-reduced-transparency.log) | 最初两次减少透明modeApplied=false是无效模式模拟，已保留；后续保持CDP会话重测通过，不混作产品失败。第三遍对应窄视口套件通过但整体因1920动态等待失败停止；第五次修订后新的完整套件252/252通过，历史失败不改写。 |
| R2-21 | library-grid 576行＋instance-detail 321行=897≤900；按完整layer/media/container上下文逐个选择器审计重复0。错误font shorthand已修为独立size/weight，native line-height=19.5px。 | [library-selector-audit.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/library-selector-audit.json)；[typography-contract.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/font-fixes-green/interface-quality-R2-16-21-82d0e-titles-inherit-line-spacing/typography-contract.json) | 采用现有PostCSS检查，不冒充运行stylelint；第三遍library-review／frontend-completion／ui-stress均通过；不替代世界等待闸门。 |
| R2-22 | 最新`npm test`：120个TS/TSX、双语710键、32个后端错误码，白名单外未用键0；spacing基线和当前均428；67文件674项Vitest＋77项Node全通过。旧a4快照按预期触发守护失败 | [revision5-npm.log](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/revision5-npm.log)；`scripts/design-token-baseline.json`；`historical-guard-red.json`；旧`npm-verified.log`保留 | 第五次修订后新的完整Playwright252/252，0失败／跳过／flaky，errors为空；主流程TypeScript退出0。当前准备同一C4提交，尚未提交推送，远端CI未验证 |
| R2-23 | zh页面h1和导航保留“角色”；按钮/登录/离线身份用“账号”；模型为经典（宽臂）/纤细（细臂），本地错误文本同步。native术语用例通过；旧accounts E2E五处完整术语定位已更新。 | [accounts-terminology.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-23-Ch-dfc22-s-and-translate-model-names/accounts-terminology.json) | 未对“角色”进行全局替换。 |
| R2-24 | 空服务器只有一条“No saved servers”说明；右框height=380px，border=1px solid；文案指向上方已有Add server。 | [server-empty.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-24-em-74d7c-n-in-the-380px-detail-frame/server-empty.json) | 未增加第二个主按钮。 |
| R2-25 | 真实Tab从启动按钮开始，在动画控件前经过2个最近实例；最后焦点animation=true；重复group/aria-label已去除。 | [home-tab-order.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-25-ke-2b2f3-he-single-animation-control/home-tab-order.json) | 旧round6 helper已按新DOM定位controls容器，全部bbox/count/click-hit断言保留，第三遍对应回归通过。 |
| R2-26 | 路径tail=shared-world，client=73px / scroll=73px；名称高44.875px、行高22.44px≤2行；禁止的span aria-label=false。 | [library-long-path.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-26-En-0c8b1--segment-and-two-line-names/library-long-path.json) | 该数值用长父目录＋常见basename shared-world。原80字符basename另在压力截图记录，不能声称所有长度都不截断。 |
| R2-27 | width=279.546875 / content=269.546875 / insets=10 / fill=false；width=167.265625 / content=157.265625 / insets=10 / fill=false；width=344.984375 / content=334.984375 / insets=10 / fill=false | [create-tracks.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/interface-final/interface-quality-R2-27-cr-039fa-their-actual-option-content/create-tracks.json) | 三个创建轨道fit-content，详情页tabs显式fill；第三遍旧详细流程回归通过。 |
| R2-28 | nav-dark-full-solid: 6.670934:1；nav-dark-lite: 6.781874:1；nav-light-full-solid: 5.604944:1；nav-light-lite: 5.497016:1 | [summary.json](E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage4/nav-placeholder-first/summary.json) | 两主题×full-solid/Lite四组，每组三帧，文本Range上2/下2行全部像素最差值；是真GPU实际背景，不拿CSS变量代替像素。 |


### S2–S6及M2修订（均为C4未提交范围）

| 编号 | 实现与已完成数值／行为检查 | 证据及范围 |
| --- | --- | --- |
| R2-07追补 | 阶段3 `3f674c3`已完成的层级分离之外，C4再修真实导航折射被shell层blur覆盖、tokens提前注册overrides两项生产级联回归；分别原生2/2、1/1通过 | `refraction-red/green.log`、`layer-order-red/green.log`。这些修复归C4，不写成已包含在3f674c3内 |
| S2 | 指针关闭在实际Popup退出完成后通知；键盘／静态模式立即通知，回调去重并隔离旧退出。3项RED后Select＋HomePage53项通过。最终pointer 68帧、overlap0；keyboard（Escape）70帧、blank0、overlap0 | `s2-native-final/review-fixes-S2-picker-kee-3f88b-iately-for-keyboard-closure/picker-exit-frames.json`及关闭截图。指针仍有3个低透明度过渡帧，不扩写为指针零空白 |
| S3 | submission预算为最近30个全部rAF回调间隔中位数×1.25，连续两个2秒超标窗口才降档，健康窗口／暂停清理历史。真实GPU计时保留独立16.7ms。5项RED后43项通过 | `s3-red.log`、`s3-green.log`。60Hz每90帧跳一帧、50Hz各10秒不降；100Hz每6回调只提交一次仍降。不作为Intel/WebView2实测 |
| S4 | 真实曲率URL恢复后，按实际轮廓内缩4px、扣文字／图标的内部区域检查，四组差值>25占比均0%，低于0.5%；原生4/4通过 | 下面分列内部／全轮廓数值与6倍人工图。色散保持0.65，未套用浅色0.25 |
| S5 | 预览胶囊surface-card 78%、blur(10px)、hairline；减少透明和高对比回退实底／无blur。两主题×1050／1280四组intro与idle均≥4.5 | 下表只列实际绘制的preview source，不用nominal-only区域冒充可见文字 |
| S6 | solid裙深9、lattice仍3。相同相位3→9对照的下方诊断区精确背景点236/32000（0.7375%）→0，两主题一致；正式源码补采三个原ROI也全部0 | `solid-cliff-final/summary.json`及`dark-normal.png`、`light-normal.png`；sourceUnchanged=true |
| M2第四次修订 | R2-19后1920动态五帧92.19→90.23→88.98→86.69→74.39，中位88.98，按旧90–150门槛失败并停止。经用户裁定，均值90–150仅在固定uT=9.7的深色地平线1050／1280／1920判；相位覆盖三宽×9.7／188／288／588，同样稳定后连拍5帧 | 动态均值仅记录，其余p95、纯白、有效性、覆盖率和岛外指标不放宽。第三遍12相位和4个其它动态闸门通过；1920动态等待20017.1ms超时，无正式五帧，按规则STOP。旧单相位92.06不代替本次验收 |
| M2第五次修订 | 动态等待改为覆盖率差<0.3pp及三项实际GPU结晶uniform各差<1e-3，实际读数间隔≥400ms且必须有新写入／提交；固定均值等待、20秒deadline和数值门槛保持原值 | `revision5-world-gates.log`六项原生专项6/6通过；30项聚焦Node通过；`revision5-full.json`新完整套件252/252。第三遍STOP保留为历史，当前准备同一C4提交，尚未提交／推送 |

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

正式源码两主题三ROI：中部[980,350,1160,500)27000像素、右侧[1230,330,1410,490)28800、下方[1000,700,1200,860)32000，精确背景点全部0。背景参考实际抑制40／50次draw、改变452060／670014个地形像素；sourceUnchanged=true，见`solid-cliff-final/summary.json`。改前下方236个背景点未删除。深色“通道差≤2”可能包含暗侧面，只作诊断，未替代精确背景指标。

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
| C4提交／推送／远端确认 | **自动验证完成，准备同一C4提交；尚未提交、尚未推送** | 本节全部编号归同一待提交C4；实际SHA及外部回执留待提交／推送后补录，不自嵌未来SHA，不以过往远端状态冒充本阶段回执 |

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

**待审建议，尚未执行：**均值90–150已经改到固定启动相位，但动态等待仍要求相邻均值差<1。建议将这条均值稳定前置条件也仅用于固定相位用例；动态用例保留覆盖率差<0.3pp的稳定等待，20秒上限、≥400ms采样间隔、正式五帧及动态其余门槛保持原值。此为等待规则调整，已向用户提出，未擅自修改测试或产品；当前结论仍为251/252、未提交。

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
