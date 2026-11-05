# Voxelight 前端转场与界面统一方案

- 日期：2026-11-03
- 状态：第 1、2 项已于 0.5.1 交付；2026-11-03 用户授权完成全部工作项并解除第 4、5 节限制，0.6.0 实施复核见 `../../reports/frontend-completion-0.6.0.md`
- 基线：实施时 `feat/crystal-world`，历史改写后对应 `d5e31ad`；当前维护分支为 `main`
- 依据：Playwright 测试数据环境下的真实 WebGL 截图和转场采集；4 路独立审查，48 条发现逐条复核（12 条完全成立，36 条需要修正严重度或修法，没有被完全推翻的）；再经一轮代码可行性批判

仍然有效的约束：`2026-10-26-voxelight-liquid-ui-design.md`（日常操作快速克制，同一时刻一个运动焦点，Lite 和减少动态规则）、`2026-11-01-voxelight-crystal-world-design.md`。

## 1. 诊断

### 1.1 内容没有转场层

| 转场 | 内容区动画帧数 |
|---|---|
| 5 次一级页面切换 | 0 |
| 卡片进详情、详情返回 | 0 |
| 详情分区切换、设置分区切换 | 0 |
| 打开创建弹窗 | 0 |
| 实例选择器下拉（唯一例外） | 11 |

内容一帧替换，导航透镜和世界相机却还在运动，所以一次点击被看成互不相干的几件事。

### 1.2 其余放大因素

- **透镜弹簧欠阻尼：** 现值 260/17。模拟 400px 位移，超调 53px，约 750ms 才收敛到 0.5px。采集到的从下载回首页时，透镜冲过目标，压到 Voxelight 字标上。
- **卡片没有空间连续性：** 同一个身份块从卡片瞬移到详情头，焦点丢到 body，滚动位置不恢复。
- **七个页面不是一张纸：** 标题 x 从 28 到 65，内容起点差约 30px；`--space-*` 使用 0 次；圆角有 16 种 px 值；`library.css` 累积到 2134 行。只加淡入也掩盖不了切页时的跳动。
- **首页没有分量：** 世界太暗，左栏黑板截断世界，启动按钮与周围几乎没有对比，成功启动时世界反而冻结 830ms。
- **语言分裂：** 背景是真 Lattice，界面仍是灰卡片和通用控件；玻璃用在约 25 个下拉框上，导航条本身却是透明空框。

## 2. 动效词汇

新增 `src/design/motion.ts` 作为唯一数值来源，`tokens.css` 补 `--duration-exit: 80ms`、`--duration-slow: 240ms`。

| 词汇 | 用于 | 规格 |
|---|---|---|
| `press` | 按钮按压 | 沿用 jelly；普通按钮 `scale(.96)`，全宽 `scale(.985)` |
| `lens` | 导航透镜 | 弹簧 340/30，x 按压阻尼 34；约 230ms 到 1%，440ms 收敛，超调约 2.5px；绘制位置 clamp 在导航内 |
| `swap` | 一级页面 | 出 80ms（opacity→0，x -6）；入 180ms（opacity→1，x 10→0，`[.23,1,.32,1]`）；新页从目标导航项所在一侧进入；首页只做 opacity |
| `drill` | 卡片↔详情 | 身份块 `layoutId`，弹簧 380/36，约 300ms，无超调；其余内容淡入 140ms，不滑动；旧子树不退场 |
| `section` | Tab、分区、分段 | 选中标记 `layoutId`，弹簧 420/38，约 290ms；面板只入不退，opacity 140ms |
| `overlay` | 原生 dialog | CSS：入 180ms（`translateY(8px) scale(.98)`），出 80ms；backdrop 只淡 opacity，不动画模糊半径 |
| `menu` | 下拉弹层 | 维持现状（入 150ms，出 100ms），数值改用 token |
| `toast` | 通知 | 入 180ms（y 8→0），出 80ms；新消息替换旧消息 |
| `console` | 启动控制台状态 | 底部 56px 玻璃不换实例、不改高度；内容交叉 140ms；选择器行 `layout="position"` |
| `list` | 搜索、排序、范围切换 | `layout="position"` 180ms；可见数大于 40 或输入中时关闭；网格与列表切换不做形变，只淡入 |
| `reveal` | 异步内容 | 指示器延迟 150ms 才出现；内容淡入 140ms；不做 stagger |
| `world` | 世界相机 | 临界阻尼 36/12：0.5s、0.75s、1s 达 81%、94%、98%，起步速度为 0；唯一允许超过 300ms 的日常动效 |
| `overture` | 成功启动 | `flash = 1.1 * exp(-t/450)`，最长 1400ms，不阻塞任何操作 |

### 降级

`useMotionTier()` 分别返回 `tier`（`full`、`fade`、`none`）和 `sceneStatic`，不压成一个值：现有 `HomePage.tsx:120` 的判断不含减少透明，合并会让只开“减少透明”的用户失去角色动画。

| 档位 | 表现 |
|---|---|
| Full | 全部词汇 |
| Lite | 无位移、无 layout、无 jelly，保留淡入 |
| 减少动态 | 全部 0ms；`MotionConfig reducedMotion="always"` 只关 transform 和 layout，opacity 时长要由 helper 显式归零 |
| 高对比 | 保留可见的选中标记 |

### 机制选择

使用已安装的 `motion/react` 和 CSS：页面用 `AnimatePresence mode="wait"`，卡片用 `layoutId`，dialog 用 `@starting-style`。

不采用：

- **View Transitions：** 快照盖在整个文档之上，会盖住导航和光标；捕获期间渲染暂停，世界和透镜卡住；快速连点时上一个转场直接跳到终点。这些判断来自规范和代码，未实测。
- **crossfade：** 两页同屏叠加比短暂空档更乱。
- **统一世界时间线：** 世界按规范是长尾，同步靠缩短透镜和内容实现。

### 玻璃规则

- transform 安全。
- 祖先 `opacity < 1` 会形成 backdrop root，淡入要放在玻璃元素自身，或人工验收。
- 面板不加 `backdrop-filter`。
- layout 节点必须写 `layoutDependency`。否则悬停和每次 `launcher://progress` 都会触发全量测量。

## 3. 工作项

顺序按“每单位工作量对观感的改善”排列。第 1、2 项已交付试用；2026-11-03 用户反馈后授权继续完成全部项目，并解除本文第 4、5 节的限制与决策门槛，由实现者统一设计。续做记录见 `../plans/2026-11-03-frontend-completion.md`。

### 第 1 项：页面切换（L）

目标：内容和透镜同时响应，约 300ms 内基本结束，世界作为长尾。

1. **先做玻璃缓存：** `refractionImage.ts` 加约 32 项的 LRU，键为 `w|h|radius|bevel|inset|refraction|dispersion`；`GlassSystem.tsx:329-344` 合并 `getComputedStyle`。`mode="wait"` 会把新页挂载推到透镜高速段，所以必须先做。首访仍会同步生成贴图，真正减负靠第 5 项收回 Select 玻璃。
   - **2026-11-03 用户确认的实现修订：** 当前 `liveOptics.ts` 还会以动态姿态调用贴图函数。缓存键补入实际影响曲率的 `bendX`、`bendY`、`pressure`、`stretch`、`heading`，容量仍为 32，避免误复用静态贴图而改变既有折射。
2. **基础设施：** 新增 `motion.ts`、`useMotionTier()`，`AppProviders` 接 `MotionConfig`。
3. **透镜：** `FloatingNav.tsx:28` 改 340/30；`paint` 中 clamp；`activeId` 变化时测量延迟改 1 帧，其余路径保留 3 帧。
4. **页面容器：** `App.tsx` 用 `AnimatePresence mode="wait" custom={dir}` 包 `motion.div.vx-page-stage`，`key` 从 `PageErrorBoundary` 移到它上面。退场期间 `pointer-events: none`，不留 `will-change: opacity`。
5. **滚动：** `onExitComplete` 中 `scrollTo(0)`。保留点击当前项回到顶部的行为：`FloatingNav.tsx:472` 对已激活项也会调用 `onNavigate`，`nextPage === page` 时继续直接 `scrollTo(0)`。
6. **世界锚点：** `HomePage` 在 `useLayoutEffect` 派发 `vx:world-anchor`，`WorldScene` 收到后 `fit()`，锚点变化时补一次 paint（静态档否则不重绘）；保留 `lastAnchorNdc`，离开和回到首页都不瞬移。
7. **fixed 元素：** `LibraryLaunchStatus` portal 到 `.vx-glass-provider`；Toast 见第 3 项。
8. **首页入场：**
   - `CharacterCanvas` 加 `deferMs`，约 280ms 后创建 `SkinViewer`，避开透镜高速段；清理时清定时器。`AppearancePanel.tsx:218` 共用这段 effect，要一起处理。
   - 相机 `worldDirector.ts:146-151` 的 eye、at 改 `advanceSpring` 36/12，`snap()` 清零速度。
   - 角色淡入放在 `.vx-home__character-panel`，由 `data-character-state=ready` 触发，不放在 `char-col`，否则会让动画选择器的玻璃失去背景。首次启动跳过。这段属于 `world` 长尾。
9. **Lite：** 首页不淡 stage，只淡非玻璃块；内容页在第 5 项收回 Select 玻璃前用 0ms。
10. **光标：** 导航加 `data-visual-owner="lens"`（加在 `FloatingNav.tsx:495` 的 nav，不加在 `.vx-window-chrome__bar`，否则窗口按钮的光标点框也会消失），切页时导航只留透镜一种语言。

验收：

- `page-*` 的 `contentAnimFrames > 0`。
- 从下载回首页的关键帧，透镜不压字标。
- 角色全显时不早于岛接触。
- 快速连点后页面正确。
- 二访时 `settings-section-switch` 的 `maxFrameGapMs < 40`。
- 人工查看 Discover 的玻璃、首页启动按钮，以及 Lite 和减少动态。

### 第 2 项：卡片到详情（M）

目标：身份块是唯一运动焦点，层级、焦点和滚动都读得出来。

1. 卡片和详情头的身份块用 `motion.span`，`layoutId="instance-identity-${id}"`，`layoutDependency={id}`。`layoutId` 放在紧贴身份块的元素上：`.vx-instance-card__identity` 撑满 60px 列，而身份块只有 56×64。
   - **2026-11-03 用户确认的实现修订：** 已装 Motion 在新旧 `layoutDependency` 相等时跳过共享快照接续，实际出现身份块瞬移。依赖键在卡片与详情分别为 `id:card`、`id:detail`；共享 `layoutId` 不变，同一位置的普通重渲染仍不重测。
2. 不给 main 加 `layoutScroll`。进详情前记录 `scrollTop`，详情 `useLayoutEffect` 置 0；返回时恢复。
3. 旧子树直接卸载。新子树淡入 140ms，排除身份块所在层。名称只做 opacity，不做字号动画。
4. 身份块颜色：详情头把 `--identity-color` 从 `--text-tertiary` 改为 `--accent`（`library.css:1722-1731`），第一帧会跳色。让两边同色，或加过渡。
5. **版本目录同样覆盖：** `VersionDirectoryCard` 和 `VersionDirectoryDetailPage` 使用同一套机制，它们的 DOM 标记是 `data-version-directory`（`LibraryPage.tsx:421`）。
6. **焦点和滚动统一在 `selectedId` 变化的 `useLayoutEffect` 中处理：** 打开时 `h1` 获得焦点（`preventScroll`）；返回时回到原卡。还要覆盖不经过 `onBack` 的路径：删除实例（`InstanceDetailPage.tsx:54-58`）、外部 reload 使实例消失（`LibraryPage.tsx:57`）、创建后直接进详情（`:107`）。目标不存在时落到页面 `h1`。
7. `navResetTick`：在详情页点已激活的“游戏库”回到网格。

验收：新增多实例 fixture；网格滚动后开卡和返回，列表视图开卡；键盘全流程。**验收脚本要逐帧采样身份块的 `getBoundingClientRect`，断言首帧等于卡片位置且位置连续**：`layoutId` 由 JS 驱动，`document.getAnimations()` 看不到，`contentAnimFrames` 查不出身份块是否跳了。

### 第 3 项：同层切换和浮层（M）

1. **弹窗：** `global.css` 给 `.vx-dialog` 和 `::backdrop` 加 `overlay` 规则，`overlay`、`display` 用 `allow-discrete`。`showModal`、`close` 语义不动。首页内的弹窗要排除出 `home.css:226-228` 的 Lite 全局规则。
2. **抽屉退场：** `closeProject` 会在同一批更新里清掉 details、loading、error（`useDiscover.ts:82-88`）。用 ref 同时冻结这四项，只在 `open` 时更新。`DiscoverPage:110` 同理，写成 `open ? modpackProject : last`，防止泄漏到后续的创建操作。
3. **弹窗内部高度：** `CreateInstanceDialog.tsx:143-173` 的版本和整合包切换、loader 字段插入会让高度突变，进出场做完后更显眼。固定内容区最小高度，字段插入用 `reveal`。
4. **全局 Toast：**
   - 在 `AppShell` 放唯一的 `ToastRegion`，把 Settings、Multiplayer 的过滤条件移过去，Discover 的本地 notice 接入。
   - 现在只有 4 处渲染，在游戏库启动失败时**用户什么也看不到**，这是独立缺陷。
   - 宿主放进 state，`Dialog` 在 `showModal` 和 `close` 后通知，取最后一个 `dialog[open]`。不能在渲染时查询，因为 close 发生在提交后的 effect（`Dialog.tsx:59-60`）；还要处理抽屉和整合包弹窗同时打开的情况。
   - 材质：实色 82% 加模糊；删 `home.css:202`。
5. **共用切换控件：**
   - `SelectionMark`（`LayoutGroup` 的 id 用 `useId`，常驻的多个弹窗否则会串组；`layoutDependency` 用常量）。
   - `Segmented`（`tabs`、`toggle`、`nav` 三种语义）和 `RailNav`。
   - 按实际语义替换，不按类名批量替换：`CreateInstanceDialog.tsx:145、156` 是 `toggle`，`:137` 是 `tablist` 且缺方向键，`:140` 的 span 不用 Segmented。`library-scope` 用 `toggle`，`settings-nav` 用 `nav`。
6. **统一选中语法：** 一块滑动的 `--surface-solid` 底、`--text-primary`、字重 600；不再有绿图标、圆点、方点、下划线混用。
7. **面板淡入覆盖全部同类切换：** 设置内容、详情工作区、Multiplayer 的 tabpanel、`AppearancePanel` 模式切换、`InstanceContent` 内部切换。
8. **实例和版本目录范围切换（从打磨项提前）：** 这是显眼的整屏硬切，至少淡入 140ms。
9. **详情头菜单：** `InstanceDetailPage.tsx:86-98` 的 details 菜单不是 `AnchoredListbox`，要补 `menu` 进出场。
10. `shell.css:123` 改 `scroll-padding-top: calc(var(--shell-height) + 16px)`。

验收：弹窗关键帧有中间态；标记滑动且不串组；方向键和 Tab 顺序不变；补抓详情弹窗和 Toast（现有采集未覆盖）；抽屉内安装时反馈不被模糊盖住。

### 第 4 项：首页门面（M）

1. **启动按钮：** 外层玻璃填充 `color-mix(in srgb, var(--accent) 90%, transparent)`，药丸形，文字用 `--accent-foreground`；对底不低于 4.5:1。减少透明时用纯 `--accent`。卡片启动按钮用 secondary 小药丸，详情页不变。
2. **去掉左侧黑板（审查后最终值，对应 4.2）：** `.vx-home__stage` 不画背景和圆角；`.vx-home::before` 使用全高局部渐变，宽度为 `calc(max(40px, (100% - 1280px) / 2) + var(--home-rail) + 300px)`。从左到右为：实色至 `calc(100% - 320px)`，88% 色标位于 `-250px`，62% 位于 `-180px`，32% 位于 `-110px`，10% 位于 `-45px`，末尾透明。取 `--world-ink`，缺值回退 `--bg-base`。标题始终在实色区；删除旧媒体查询的 layout 宽度覆盖，减少透明和高对比保留实底。旧 160px 线性渐隐已废弃。
3. **世界亮度（2026-11-05第二轮阶段1修订值，对应 4.3）：**
   - 方块深度：`mix(s, 3., m * mix(1., crE * crE * crE, uLat))`；共享结晶岛渐隐带从 `+18` 收到 `+10`，首页岛半径仍为 9。
   - 方块顶点：`vIsland = 1. - smoothstep(uIsland, uIsland + 10., d)`，`vLit = max(f.b, mix(1.25,1.1,uLight) * uLat * vIsland)`。顶点声明与片元同为highp的`uLight`，复用renderer原有主题uniform；照明补偿仅深色1.25，浅色保留1.1。使用正向smoothstep后取反，保持10格范围。
   - 方块片元：`alb = max(alb, vec3(.6,.588,.552) * uLat * vIsland)`。在`col *= uExposure`后增加深色高光肩部：`k=max(col-.8,0.)`、`sh=min(col,.8)+k/(1.+5.*k)`、`col=mix(sh,col,uLight)`。不提高全局曝光或泛光。
   - 页面标量：首页 `pointGain=1, home=1`，内容页 `.3, 0`，加入 director 的 scalarKeys，通过 `1-exp(-statusDt*2.4)` 随真实时间连续插值并传 uniform。不能按 page 硬切。
   - 普通点 alpha 基础为 `(.42 + 1.47 * f.b * (.55 + .45 * smoothstep(3.,20.,h))) * (1. + .5 * uHome * smoothstep(10.,26.,h)) * (1.-smoothstep(.35,.9,cr))`；飞行下限 `.55`、fog、runDim 后乘 `uPointGain`，再限幅 `.85`。字标专用 alpha `.95` 不变。
   - 点投影尺寸 clamp 下限 `mix(.72,1.05,uHome)`、上限 `2.7`；高度增量为 `.45*uHome*smoothstep(8.,26.,h)`，其余速度／字标尺寸因子保留。内容页 `paperInk=.12` 不变。
   - 第二轮岛面ROI由实际`.vx-home__feet[data-world-anchor]`底边中点偏移`[-170,-40,+170,+35]`确定；相机或布局变化后重新读取锚点，不沿用固定屏幕坐标框。岛面及岛外使用仅隐藏角色canvas、等待两帧后的图，其余指标保留正常图。采样前联合等待覆盖率差<0.3pp、相隔≥400ms的隐藏ROI均值差<1，统一上限20s并记录世界帧数／时间；然后五帧取中位数。
   - 深色地平线1280/1050/1920执行均值90–150、p95≤200、岛内纯白<0.5%、下半区纯白<0.1%；浅色1280检查有效性及相对a4f756e均值变化≤3；山体ROI只记录，数值只判下半区纯白并另存人工图。远景60–90只判深色地平线1280；岛外相对限值及重复采样要求详见第二轮清单M2/S1。
   - 旧固定岛面ROI的105.62等数值仅作为首轮历史保留，不用于第二轮放行。当前五组逐帧值、等待时长与重复验证结果见 `../../reports/2026-11-05-review-round2-fixes.md`。导航色散`.65`、既有遮罩及其余世界参数保持原样。
4. **角色站位：** `horizon.at` 最终为 `[2, 13, -40]`（审查 A1 顺序完成第 3–5 步后的值）；`data-world-anchor` 位于 `.vx-home__feet`，并观察 `.vx-home__layout` 尺寸变化后重新派发。1280×720、1050×720、1920×1080 实测脚落在岛上，`bottom:16%` 保持不变。
5. **内容页溶解岛：** `worldDirector.ts:35` 在内容页把 `island` 设为 -18，离开首页时原地溶解，不再瞬移到右下角干扰阅读。
6. **预览胶囊：** 只在没有在线账户时显示。审查 E1 的必选像素检查发现去底色后对比度约 1:1，因此保留原位置和尺寸，使用现有 `--surface-card` 实色阅读底板及药丸圆角，以 4.5:1 重新验收；在线账户仍不显示。
7. **最近实例：** 只有 1 个实例时不显示，不过滤已选项，最多 4 列。

风险：世界变亮后 scrim 和内容面板压力变大，必须同批验收。`at` 同时影响实体材质。

### 第 5 项：七页同一骨架和表面（L，分提交）

1. **`PageShell`、`PageHeader`：** 统一标题位置、字号和内容起点；删除各页 padding 和标题样式；`scrollbar-gutter: stable`。
2. **表面令牌：** `--surface-panel`（`--world-ink` 86%）、`--surface-card`（不透明 `#0d0f14`）、`--hairline`；`.vx-panel`、`.vx-card` 只管背景、描边、圆角，不管 padding。
3. **圆角：** `--radius-sm: 6px`，`--radius-md: 12px`，`--radius-lg: 12px`；透镜自身半径不动。共 32 处引用，要回归 toast、listbox、field。
4. **按钮：** `Button` 加 `size`（32、38、56px）和 `--icon`，全部药丸形；删除各页的圆角覆盖。
5. **收回玻璃：** `AnchoredListbox` 默认扁平，只有 `HomeAnimationSelector` 和 `InstancePicker` 用玻璃。
6. **对齐：** `--rail-w: 248px`，统一 `.vx-workspace`；详情头走 `PageHeader`。身份块缩到 40×44 后，开卡路径都带缩放，要与第 2 项一起复测。
7. **日志可选中：** `.vx-log-view, .vx-detail-section pre { user-select: text }`。这是独立 bug，可以先修。
8. 只折叠改到的选择器，不对全部 CSS 做 codemod。

### 第 6 项：浅色主题（S，可独立提前）

这些是真实的可读性缺陷，与转场无关：

- 强调色做文字约 1.1:1。新增 `--accent-ink`，由 `accent.ts` 按主题降亮度到至少 4.5:1；循环要有终止条件；19 处文字和图标改用它。
- 内容页地形把正文压到约 1.8:1。新增 `paperInk`，内容页取 0.12。
- 浅色 `--text-tertiary` 调到约 `#66665f`。

取值来自公式推算，未实测。如果你主要用浅色，这一项应提到第一位。

### 第 7 项：启动这一刻（L）

1. **控制台：** 按 `console` 词汇；进度和文件数放在玻璃上方；取消按钮出现后 250ms 内忽略点击。
2. **前沿信号：** 起始半径 `FRONT_START = 30`，避免前段被岛盖住；世界出现强调色前沿线；idle→preparing 时触发一次冲击波。
3. **成功时刻：** 去掉 `App.tsx:45` 的 `paused={playing}`，不再冻结 830ms。`flash` 只在 preparing→running 且位于首页时触发，不能挂在 `runningAt` 上，否则打开启动器时已有运行中的游戏会误闪。
4. **运行后：** 1500ms 后角色回到 idle 并暂停，把 GPU 让给游戏。
5. **进度组件：** `LatticeProgress` 的颜色变量接到真实令牌（现在读的 CSS 变量不存在），状态接真实值。
6. **已有游戏运行时再次启动：** `deriveWorldState.ts:19-21` 一直返回 `running`，世界进不了 preparing。本方案接受这个行为，界面进度仍正常显示。

### 第 8 项：异步内容和空状态（M）

1. **探索列表：** 同来源下切类型或搜索时保留旧结果，切来源时清空。旧结果在屏期间**立即** `inert`，否则旧卡片会按新类型安装。
2. **首屏：**
   - 增加 `bootstrapFailed`，只在挂载时那次 bootstrap 的 catch 里设置，不能放进被反复调用的 `reload`。
   - pending 作为 `key="boot"` 的子节点放进同一个 `AnimatePresence`，否则 `initial={false}` 会吃掉首次入场。
   - 失败时显示现有页面、错误和重试，不能永久空白。
3. **空状态和加载态：** 统一成一种；联机页空状态只留一个主按钮；加载指示延迟 150ms。

### 第 9 项：Lattice 语言打磨（M，可取舍）

- `LatticeFrame` 选中时渲染静态点框，删除与箭头重叠的对勾。
- 光标轮廓改 `--text-primary`，去掉淡紫第三色；稀疏指针环；静止停帧。
- Doto 第二批：下载百分比、服务器数量。
- 实例徽记：保留首字，点阵作底纹。
- 列表重排：覆盖 `InstanceCard` 和版本目录卡。

## 4. 明确不做

以下为原方案历史边界，已由 2026-11-03 用户最新指令解除，不再作为设计禁令；采用哪些机制由实现与验证决定。

- 不用 View Transitions，不加新动画库或全局编排层。
- 不加常驻动效，空闲时不额外跑 rAF。
- 内容页互切不加世界动作。
- 不改默认强调色，不重做世界背景架构。
- 卡片不放大，不做 stagger，网格和列表不做形变。
- 不移植 ⌘K、`cursor:none`、slider、冰蓝和橙色，不默认开声音。
- 不对全部 CSS 做 codemod，本轮不加 stylelint。
- 面板不加 `backdrop-filter`，弹窗和 Toast 不改回透镜材质。

## 5. 需要用户决定

2026-11-03 用户已授权实现者统一决定以下事项，无需逐项等待额外确认。

1. **首页构图：** 是否把标题、元数据、选择器、启动按钮合成贴底控制台，去掉中间约 340px 的空白。这偏离已批准的上下分离构图。建议改，先出两版截图比较。
2. **文档修订：** 弹窗和 Toast 用实色、普通卡片带静态 hairline，与 2026-10-26 文档第 26、301 行和 8.1 节有出入。本方案按此写。
3. **导航型 Tab 的选中标记：** 默认用滑动实色块；点群更有 Lattice 辨识度，但多一层 canvas 和光标抑制逻辑。
4. **表单点阵化：** 建议只做点线输入框（纯 CSS），不做 DotSwitch。需要修订 2026-10-26 文档第 294 行。
5. **实例徽记：** 默认保留首字，不引入按加载器区分外形的新语义。

## 6. 验证局限

- 方案本身都还没有实际运行。
- 采集在 Chromium 和 RTX 5080 上完成，不是真实 Tauri 窗口，也未覆盖 Intel 集成显卡。
- 测试数据只有 1 个实例；Toast、详情弹窗、成功启动瞬间、多实例列表只有代码证据，实施时要补抓。
- 弹簧数值是按 `advanceSpring` 的积分方式模拟的，手感要实际确认。
- 亮度和对比度的目标值实测后可调。
