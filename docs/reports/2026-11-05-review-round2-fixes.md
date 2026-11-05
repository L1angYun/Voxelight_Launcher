# 第二轮修复：阶段1收尾、阶段2与阶段3验收记录

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

下表R2-04–07属于同一阶段3提交，哈希待本阶段提交后补录。证据根为`E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/stage3/`。当前源码已冻结，42张改前图与42张改后图均采集完成，采集记录中页面错误为0、源码前后校验一致；30项跨阶段回归已通过，另补两项命令栏用例2/2通过。audit-comparison.json/.md确认42页h1的x/y/宽/高精确零差异，按钮与表面节点无新增或缺失，按钮填充色无变化；表面填充与圆角变化全部对应R2-04–07，未分类差异为0。

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
- jsdom不解析生产CSS层导致的10条既有断言没有删除或放宽；`isolatedStylesheetCss`只在组件单测中展开传入组件CSS的layer包装，保留原断言。生产级联仍由真实浏览器测试与42页改前/改后审计验证，未用此辅助函数模拟整套生产级联。
- 最终跨阶段回归30/30通过，3.2分钟，见`regression.log`：12项design、5项accessibility、5项field-focus、5组M1/M2以及3项library D3。旧D4用例已按新语义改名，原grep未包含它们，两项library commandbar另跑2/2通过（9.0秒，toolbar-final-v2.log）；没有把未被筛选的用例算作通过。完整Playwright、Cargo和安装包构建未据此宣称完成。
- **人工已查看：** `after/zh-light-1440-accounts.png`，白色角色预览卡与页面形成明确层级；`after/zh-dark-1440-library.png`，操作按钮为药丸、卡片点框仍保留，未见横向溢出。人工结论仅覆盖这两张图，未遍历全部角色预览模式，也不把42张自动截图当作全部人工通过。阶段4的世界与玻璃诊断尚未开始。

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
