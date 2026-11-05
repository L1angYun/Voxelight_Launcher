# Voxelight 第二轮审查修复清单

- 日期：2026-11-05
- 基线：`main` @ `a4f756e`
- 依据：同一套测试数据在真实 D3D11 上的完整采集。范围包括：
  - 6 组页面矩阵：中文 1440 深浅主题，英文压力数据 1050 和 1920 深浅主题。
  - 5 种降级模式、7 种状态（含山体场景和实体材质）、弹窗与流程、键盘焦点巡检。
  - 每页自动体检：控制台报错、可访问名称、截断、溢出，以及按钮、面板、字号的种类数。
- 审查：上一轮 4 路审查（23 条发现，推翻 2 条），本轮 4 路审查（48 条发现，推翻 1 条），合并去重为 39 条。
- 上级文档：`2026-11-03-voxelight-0.6.0-review-fixes.md`、`2026-11-03-voxelight-frontend-transitions-and-surfaces.md`

## 结论

骨架层已经统一：

- 六个内容页的标题位置完全一致。
- 所有页面和状态都没有控制台报错，所有控件都有可访问名称，任何宽度都没有横向溢出。
- 字体只有三族，玻璃只出现在分工允许的位置。

以下三层还不能交付：

1. **世界：** 深色主题岛面过曝成纯白，地平线和山体两个场景都有，原因是反照率下限 1.2；岛面验收门槛在相机改动后失效。
2. **无障碍：** 浅色主题的焦点环对比度只有约 1.2:1，等于看不见；启动、取消、停止时焦点掉到页面；游戏库搜索框没有焦点环；通知替换时焦点丢失。
3. **设计语言：** 选中样式有 4 种写法；按钮仍有页面级的尺寸和圆角覆盖；部分阅读面没有用统一的面板令牌；CSS 加载顺序颠倒，基础样式反而后加载。

## 执行规则

- 按阶段顺序执行。阶段 1 是闸门：达不到验收就停下，给用户数据和截图，不进入阶段 2。
- 每个阶段完成后推送一次。
- 每条修复先写失败的测试，再实现。
- 下面“已定的决定”按建议默认执行。

## 已定的决定

审查留下 8 个需要用户决定的问题，下面按建议默认执行，用户可以改：

| 问题 | 默认 |
|---|---|
| 游戏库命令栏按钮 | 改为药丸形（按转场方案第 5 项）。搜索框、下拉、视图切换这类字段控件保留 12px 圆角。同步修改 `library-review.spec.ts:163/169` |
| 联机服务器列表的选中样式 | 用 `--selection-fill` 实色块，和侧栏一致 |
| 账号行选中后的对勾 | 删除，选中靠实色块和 `aria-current` 表达 |
| 登录方式标签在设备码流程中 | 手动激活：方向键只移动焦点，Enter 才切换 |
| 宽屏 ≥1680px 时放宽内容宽度 | 本轮不做 |
| 下载页 Active 和 History 两段 | 都放进面板 |
| S6 实体材质的柱裙 | 先截山体实体材质的陡坡；没有露缝就保持 3 格 |
| R2-29 首页左缘对齐网格 | 本轮不做 |

## 岛面验收的新口径（用户已批准）

- 取样框跟随角色脚下的锚点 `.vx-home__feet[data-world-anchor]`，不再固定在屏幕坐标上。
- 门槛（只适用于深色主题）：均值 90–150、p95 ≤200、纯白（R=G=B=255）<0.5%；深色首页下半区纯白 <0.1%。浅色只验收 ROI 有效性和“与 `a4f756e` 相比变化 ≤3”。山体只判下半区纯白。采样前要等岛面均值稳定。详见 M2。
- 写进仓库的 `world-acceptance.spec.ts`，覆盖深色 1280、1050、1920，浅色 1280，以及山体点阵 1280。
- 世界外观的数值检查不能和人工检查混在一起汇总成“全部通过”。

## 阶段 1：世界（闸门）

### M1 深色岛面过曝成纯白：反照率下限 vec3(1.2,1.176,1.104) 大于 1，且没有色调映射（horizon 和 massif 都受影响）

- **分组：** world；**工作量：** S
- **问题：** a4f756e 的 shaders.ts:257 仍是 `alb = max(alb, vec3(1.2,1.176,1.104)*uLat*vIsland)`。乘上 vLit≥1.1 和漫反射系数 2.5 后，颜色在泛光之前就超过 1。实测下半区纯白像素：zh-dark-1440-home.png 11966 px，state-massif-lattice-home.png 2610 px，截图上角色脚下可见白色光斑。这项上一轮因 massif 未验证而保留，现在已确认。
- **修法：** 1）shaders.ts:257 改为 `vec3(.6,.588,.552)`。2）在 VOXEL_FRAGMENT 的 `col *= uExposure;` 之后加一个只作用于深色的高光肩部：`vec3 k=max(col-.8,0.); vec3 sh=min(col,.8)+k/(1.+5.*k); col=mix(sh,col,uLight);`。3）如果锚点 ROI 下岛顶偏暗，只从照明侧补，不要再抬反照率。照明补偿只作用于深色（2026-11-05 修订）：VOXEL_VERTEX 声明 `uniform float uLight;`（renderer 已对 voxel 程序设置该值，两阶段都是 highp），写成 `vLit=max(vLit,mix(1.25,1.1,uLight)*uLat*isl)`。原因：1.25 不分主题时，浅色岛面均值变化 4.17，超过 ≤3；照明 1.1 时只变化 0.03。4）把规格 4.2/4.3 中的 vec3(1.2,…) 改回。必须与 M2 在同一提交。
- **验收：** 深色 horizon 1280/1050/1920，首页锚点 ROI 内：均值 90–150，p95≤200，纯白（255,255,255）<0.5%；这三组和 massif lattice 1280 的首页下半区 [380,440,W,H) 纯白 <0.1%（massif 的 ROI 只记录，见 M2）。浅色 1280 与修改前相比，ROI 均值变化 ≤3。

### M2 岛面门槛改为跟随锚点的 ROI，加入 p95 和纯白约束，并写进仓库（用户已批准新口径）

- **分组：** world；**工作量：** M
- **问题：** at.y 改为 13 后，固定 ROI [600,530,1000,580) 漂到了暗缝上。105.6 这个值来自黑白双峰（p95=255）。final-acceptance 把人工项硬编码为 pass。仓库里的长期门槛只有二值覆盖率。
- **修法：** 1）tests/e2e/helpers/world-appearance.ts 新增 islandMetrics()：读取 `.vx-home__feet[data-world-anchor]` 底边中点 (cx,by)，ROI 取 [cx-170,by-40,cx+170,by+35)，保留通道极差 <65 的像素。角色画布的外框会盖住整个 ROI，所以岛面和“岛外”两项改用专门的采样帧：只给角色 canvas 设 `visibility: hidden`（不用 `display: none`，布局和锚点不变），等两帧后截图；其余指标和站位检查仍用正常画面，两张都保存。2）前置有效性断言：ROI 内与背景差 >10 的像素 ≥85%，否则报“ROI 未覆盖岛面”。3）门槛：均值 90–150、p95≤200、纯白<0.5%；深色下半区纯白<0.1%；岛外区域 meanAbsDelta 和远景 p95 按下面的定义（2026-11-05 修订）。

   - **岛外 meanAbsDelta：** 区域为首页下半区 `[380, 440, W, H)` 减去锚点岛 ROI 矩形，取自隐藏角色的采样帧。值为区域内每个像素 `|(R+G+B)/3 − 背景 RGB 均值|` 的平均，背景同首轮报告（深色 `(7,8,11)`，浅色 `(243,241,235)`）。门槛是相对的：用同一方法测 `d5e31ad`（0.6.0 之前认可的版本）和 `287a3af`（过重的 0.6.0），要求 `≤ d5e31ad + 0.35 × (287a3af − d5e31ad)`，即明显轻于 0.6.0、接近认可版本。覆盖深色 1280、1050、1920 和浅色 1280，各自用本尺寸、本主题的基线。三个版本的原始值都写进报告和基线 JSON。
   - **远景 p95：** 取样框按窗口比例换算，`x ∈ [0.703W, 0.9375W)`、`y ∈ [0.326H, 0.556H)`，在 1280×720 下正好等于原来的 `[900,235,1200,400)`。**只在深色地平线 1280 作为门槛（60–90）。** 其余情况只记录不判定（2026-11-05 再次修订）：
     - 1920：同一画面下光点覆盖的像素比例不同，p95 不随分辨率稳定，实测 42。
     - 1050：左侧渐隐会占到远景区。
     - 山体：框内是实体山面，测到的不是远景。
     - 浅色：框内是纸面背景，测到的不是远景。
   - **岛面门槛的适用范围（2026-11-05 再次修订）：** 均值 90–150、p95 ≤200、纯白 <0.5%、下半区纯白 <0.1% 只适用于**深色**（地平线 1280、1050、1920 和山体点阵 1280）。这几项是为深色底上的亮岛设计的，浅色下岛面靠纸面混合，亮度方向相反。浅色地平线 1280 只验收两项：ROI 有效性；岛面均值与 `a4f756e` 相比变化 ≤3（当前 156.98）。
   - **山体只判下半区纯白（2026-11-05 第三次修订）：** 山体的岛半径是 5，锚点 ROI 落在岛前排柱子的侧面和柱缝上，不在岛顶。它的“有效率”取决于暗侧面是否比背景亮 10 以上，所以随亮度变化：修复前 85.4–86.2%，修复后 75.9–76.9%。这测的是亮度，不是取样框有没有对准岛面。山体的 ROI 有效率、均值、p95、岛内纯白改为只记录；数值门槛只保留下半区纯白 <0.1%（修复前 0.73%）。另加一张人工检查截图，确认山体岛面没有发灰发暗，结论记在 manual 里。
   - **采样前等岛面稳定（2026-11-05 第三次修订）：** 覆盖率稳定时岛面仍在结晶变亮。1920 连拍 5 帧的岛面均值是 76.4→82.0→85.0→88.0→90.5，修复前同样一路上升（179.5→205.8）。在原有“覆盖率差 <0.3pp”之外再加一条：隐藏角色的采样帧中，相隔 ≥400ms 的两次 ROI 均值差 <1，才开始连拍 5 帧。最长等 20s（原定 8s；1920 在 8s 时仍以每次约 2–3 的幅度上升，已到 95.8，见第二轮报告），超时算失败并记录等待时长。每次等待采样同时记录 `data-world-frames` 和时间戳，用来判断 1920 变慢是不是帧率造成的。所有用例都用这个等待。历史基线不重采：岛外指标的修复版在等待更久时只会更亮，比较偏严；浅色均值逐帧几乎不变（157.0±0.3）。
   4）写进 world-acceptance.spec.ts，覆盖深色 1280/1050/1920、浅色 1280、massif lattice 1280。5）camera.test.ts 增加意图断言：锚点在 island=9 的投影内，下缘 ≤0.9H，水平偏差 <40px。6）final-acceptance 拆成 numeric 和 manual，allAGatesPass 只汇总数值项。7）规格补一句：相机变化后 ROI 随锚点移动。
- **验收：** 在 a4f756e 上运行，新断言因纯白和 p95 而失败；合入 M1 后全部通过。改相机 at.y 后测试无需改动 ROI 坐标即可通过。

## 阶段 2：无障碍与交互缺陷

### M3 同 id 替换 Toast 时重挂元素，键盘焦点落到 body

- **分组：** motion；**工作量：** S
- **问题：** ToastProvider.tsx 的 key 含 revision（:49-50 每次加一），替换时卸载旧节点。旧节点退场期间 inert 且按钮 disabled，焦点被 fixup 到 body。App.tsx:38 的 "launcher" 通知始终复用同一个 id，真实场景必然触发。a4f756e 仍是这个写法。
- **修法：** key 改为 `${host.id}:${toast.id}`，原地更新。revision 只用于重置计时器。如需过渡，给内部 `<motion.span key={toast.revision}>` 加 120ms 淡入。
- **验收：** ToastProvider.test.tsx 新用例：先 focus 旧 Toast 的关闭按钮，再触发同 id 替换，断言 document.activeElement 仍是关闭按钮，不是 body。Lite 和减少动态下同样通过。

### M4 创建实例对话框：加载器槽收起后留下双倍间距，overflow:hidden 裁掉 Select 焦点环

- **分组：** consistency；**工作量：** S
- **问题：** create-instance.css:5-7 的 0fr 行仍是 .vx-form-stack（gap 20）的直接子项，上下两个 gap 都保留，实测间距约 43px，其他字段间约 24px。:7 的 overflow:hidden 会裁掉 AnchoredListbox.css:6-8 外凸 5px 的焦点环。
- **修法：** 1）收起态 `.vx-create-loader-slot{margin-block-start:-20px}`，与 grid-template-rows 一起过渡；`[data-expanded="true"]{margin-block-start:0}`；减少动态和 Lite 下 transition:none。2）`.vx-create-loader-slot__content{padding:0 6px 6px;margin:0 -6px -6px}`。
- **验收：** library-review.spec：原版状态下分段控件底到“实例名称”标签为 20±2px；选 Fabric 后键盘聚焦加载器版本，截图中 outline 四边可见。

### R2-01 浅色主题焦点环和进度点阵改用 3:1 指示色令牌 --accent-indicator（强调绿不变）

- **分组：** a11y；**工作量：** S
- **问题：** 以下位置在浅色下直接用 --accent #b4f17a，对 #f3f1eb/#faf9f5 只有 1.18/1.26:1，低于 WCAG 1.4.11 要求的 3:1：global.css:26 `:focus-visible`、:40 input:focus 边框、AnchoredListbox.css:8、lattice.css:16-18（data-focused）、LatticeProgress.tsx:42 solid、cursor.ts:406。键盘巡检从未在浅色主题下跑过。
- **修法：** 1）accent.ts buildAccentScale 新增 indicator：复用 ink 的亮度搜索，阈值 3.0，对照 #f3f1eb/#faf9f5/#eae7e0。深色下 indicator 等于 base。2）AppearanceProvider.tsx:137 后加一行 setProperty('--accent-indicator', accentScale.indicator)，tokens.css 给回退值 var(--accent)。3）上面六处改为 var(--accent-indicator)。
- **验收：** accent.test.ts：默认色和 3 个高亮度强调色在浅色下 contrast(indicator, 三种表面) ≥3，深色下 indicator===base。新增浅色 focus-home/focus-library 截图，outline 色不是 rgb(180,241,122)。en-light-1050-downloads 的完成点阵对卡片 ≥3:1。

### R2-02 启动 → 准备 → 运行 → 结束：每次切换焦点都掉到 body

- **分组：** a11y；**工作量：** M
- **问题：** LaunchConsole.tsx 中：:114 启动按钮 disabled={busy}；:106-118 AnimatePresence 以 key={state} 整块重挂，退场节点 inert（:17）；:108 取消按钮前 250ms disabled；:113 停止按钮也是重挂出来的；全组件没有 focus()。键盘用户按回车启动后，要 Tab 14 次才能回到取消按钮。
- **修法：** 1）三个按钮改用 aria-disabled，onClick 内判断 busy 和 cancelAvailableAt 后 return，保留 250ms 防误触。2）加 actionsRef：在 onLaunch/onStop/onCancel 时记录焦点是否在控制台内；useLayoutEffect([state]) 中对新内容的 `[data-launch-action]` 调用 focus({preventScroll:true})。
- **验收：** HomePage.test.tsx：键盘聚焦启动按钮后按 Enter，activeElement 为“取消准备”；切到运行态后为“停止”；结束后回到“启动游戏”；250ms 内连按 Enter 不会取消。

### R2-03 游戏库搜索框 outline:0：关闭光晕的模式下几乎看不到焦点，且与探索页写法不同

- **分组：** a11y；**工作量：** S
- **问题：** library.css:101-103 `.vx-library-page .vx-search input:focus{outline:0}`（0,3,1）压过 global.css:26；:86-88 只把图标变色。audit keyboard-library 中“搜索实例”的 outline 为 none 0px。光晕在减少动态、高对比、强制颜色、Lite 下都关闭。discover.css:24 保留了焦点环。
- **修法：** 删除 library.css:101-103。新增 `.vx-library-page .vx-search:has(input:focus-visible), .vx-discover-search:has(input:focus-visible){outline:2px solid var(--accent-indicator);outline-offset:2px}`，内部 input:focus-visible 改为 outline:none；forced-colors 下 outline-color:Highlight。
- **验收：** library-review.spec：emulateMedia reducedMotion 和 forcedColors 下 Tab 到搜索框，容器 outlineStyle 为 solid、宽 2px；两个页面的 audit keyboard 记录一致。

## 阶段 3：设计语言收口

### R2-04 选中语法收为两条规则（卡片用点框，行/标签/侧栏用 selection 实色块），ARIA 统一用 aria-current

- **分组：** consistency；**工作量：** M
- **问题：** 四种写法并存：multiplayer.css:37 accent-soft 底加 3px 绿条（en-light-1050-multiplayer.png）；:94 accent-soft；accounts.css:12-13 灰块加对勾，绿条由 surfaces.css:32 content:none 硬关；discover.css:33 surface-hover。ARIA：InstanceCard.tsx:63 把 aria-current 写在 article 上，可聚焦的 button 不含当前态；RecentInstances.tsx:39 用 aria-pressed；AccountList.tsx:67 当前账号按钮 disabled，Tab 走不到。
- **修法：** 1）multiplayer.css:37/:94、accounts.css:12、discover.css:33 统一为 `background:var(--selection-fill);color:var(--text-primary);font-weight:600;box-shadow:inset 0 0 0 1px var(--hairline);border-radius:var(--radius-sm)`，删除 accent 竖条、accounts.css:13 和 surfaces.css:32 的补丁。绿色只留给在线状态点。2）InstanceCard 的 aria-current 移到 .vx-instance-card__select；RecentInstances 改为 aria-current；AccountList 当前项不再 disabled，onClick 无操作。3）规格第 3 项补一句：卡片用 LatticeFrame 点框，其余用 selection-fill。
- **验收：** 各页 audit surfaceFills 中不再出现 rgb(40,55,41) 等 accent 底。grep 功能 CSS 中 `accent-soft` 只出现在状态类上。e2e 中 Tab 能到达当前账号，读屏名称含“当前”；库卡片聚焦按钮带 aria-current=true。

### R2-05 按钮收口到 32/38/56 药丸，删除页面级尺寸和圆角覆盖

- **分组：** consistency；**工作量：** M
- **问题：** library.css:1631-1636 的 (0,3,0) 选择器把命令栏 .vx-button 设成 12px（zh-dark-1440-library.png 中“导入整合包/创建实例”是圆角矩形，联机/设置的主操作是药丸）。高度覆盖：library.css:339/:1728（31）、accounts.css:9/22/44、discover.css:44（34）、multiplayer.css:74（40）、overture.css:79（34/11px）、home.css:171/201。accounts.css:23 的 8px 只是因为加载顺序才被压住。
- **修法：** 1）删除 library.css:1625-1629，并从 :1632 的 :is() 中去掉 .vx-button（命令栏是否保留 12px 先由用户定案，见 user_decisions；默认按规格用药丸）。2）删除上述各处 min-height/padding/radius 覆盖，JSX 改传 size="sm"|"md"，图标按钮用 IconButton size="sm"。3）按钮内图标统一：sm 14、md 16、lg 18。4）以上完成后删除 surfaces.css:31 的页面白名单。5）同步修改 library-review.spec.ts:163/169。
- **验收：** 新 design-consistency e2e：七页 × 3 宽度下，可见 .vx-button 高度 ∈{32,38,56}、圆角=999px（白名单：窗口按钮、Lens 控件）。grep 功能 CSS 中不存在同时含 .vx-button 和 border-radius/min-height 的规则。

### R2-06 阅读面只保留 panel/card + hairline，补齐浅色层级

- **分组：** consistency；**工作量：** M
- **问题：** 深色下实测有 7 档填充。偏离令牌的面：accounts.css:31 角色预览（bg-raised + 冷光渐变 + 16px，深色偏亮、浅色偏暗，zh-dark/light-1440-accounts.png）；downloads.css:2/:158-160 的 --download-quiet；library.css:1432-1435 详情工作区（无描边，30%）；library.css:1555-1559 命令栏（28%、8px）；DiscoverPage.tsx:96-97 面板套面板；library.css:3-9 私有令牌。浅色下 tokens.css:73-75 的 panel 和 card 都是 #faf9f5，看不出层级。账号行和若干控件还有 8px 圆角。
- **修法：** 1）角色预览加 vx-card：`border:1px solid var(--hairline);border-radius:var(--radius-md);background:var(--surface-card)`；如需冷光，放到 ::before，不透明度 ≤6%，reduced-transparency 下关闭。2）下载空态改用 vx-panel，删除 --download-quiet。3）详情工作区 `border:1px solid var(--hairline);border-radius:var(--radius-lg);background:var(--surface-panel)`。4）命令栏去掉填充和描边。5）DiscoverPage.tsx:97 去掉 vx-panel，改为普通输入框描边。6）删除 --library-surface-quiet/--library-rule，改用 --hairline。7）浅色 --surface-card 改为 #ffffff。8）accounts.css 的 8px 改为 --radius-sm，10/16px 改为 --radius-md。
- **验收：** audit 各页 surfaceRadii ⊆{6,12}px。深色主内容区的大面积填充 ⊆{页面底, surface-panel, surface-card, selection-fill}。浅色截图实测 页面<面板<卡片，相邻两级差 ≥4。角色预览在深浅两种主题下都比页面底亮。

### R2-07 修正 CSS 级联：基础层先加载，用 @layer 分层；修复探索详情弹窗被锁 560px

- **分组：** tests/health；**工作量：** M
- **问题：** App.tsx:6-13 先 import 功能 CSS，:25-27 才 import global/shell/surfaces，没有 @layer。global.css:86 的 `.vx-dialog{width:min(560px,…)}` 与 discover.css:45 的 `.vx-project-details{width:min(720px,…)}` 同为 (0,1,0)，后加载的 global 胜出，ProjectDetailsDrawer 因此被锁在 560px。另外 accounts.css:1-3/:23、library.css:1095-1098/:1892-1894/:1942-1944、accounts.css:87-88 都是写了不生效的死覆盖。
- **修法：** 1）main.tsx 在 import App 之前 import tokens/global/surfaces。2）global.css 顶部声明 `@layer tokens, base, primitives, features, overrides;`；功能 CSS 包进 @layer features；surfaces.css 中 data-reduced-transparency/high-contrast 的分支放进 overrides。3）discover.css:45 改为 `.vx-dialog.vx-project-details`。4）同一提交里删除上述死覆盖和 PageHeader 调用方的 vx-page-heading/vx-accounts-heading。5）surfaces.css:2 改为纯 .vx-page-shell，:6 去掉 [class]。
- **验收：** 打开探索详情弹窗并截图，1440 下宽度=720px。改动前后七页 × 3 宽度 × 深浅主题的 audit h1/按钮/表面数据不变，或按 R2-05/R2-06 预期变化。forced-colors、contrast-more、reduced-transparency 截图无回归。

## 阶段 4：应修项

### R2-08 登录对话框的方式切换改用 Segmented semantic="tabs"

- **分组：** a11y；**工作量：** S
- **问题：** LoginDialog.tsx:274-287 手写 tablist：没有漫游 tabindex、没有方向键，tabpanel 也没有 aria-labelledby。样式 accounts.css:66-68（bg-raised、8px、650）是第五种选中写法。changeTab 会 resetAttempt。
- **修法：** 换成 `<Segmented semantic="tabs" idPrefix="login-method" …/>`，tabpanel 设 aria-labelledby。设备码流程进行中时，方向键只移动焦点，Enter/Space 才切换（手动激活）。删除 accounts.css:24-28 和 :66-68。
- **验收：** accounts e2e：按 ArrowRight 后焦点和选中都移到“离线”；设备码进行中按 ArrowRight 不会中断流程；选中样式与 selection.css 一致。

### R2-09 forced-colors 下排序下拉和搜索框没有边界，有色 SVG 不跟随系统色

- **分组：** a11y；**工作量：** S
- **问题：** library.css:1639-1641 的下拉边界只靠 box-shadow，强制颜色下被清掉；箭头 SVG 保留主题色 rgb(238,237,233)，在 Canvas 上约 1.17:1（mode-forced-colors-library.png）；搜索框没有 border。shell.css:63/:88、AnchoredListbox.css:16 的图标同样保留主题色。
- **修法：** `@media (forced-colors:active){.vx-select__chevron,.vx-select__button>svg,.vx-window-chrome__brand svg,.vx-floating-nav__item>svg,.vx-discover-search>svg{forced-color-adjust:auto;color:CanvasText}.vx-floating-nav__item.is-active>svg{color:Highlight}.vx-select__surface,.vx-library-page .vx-search,.vx-discover-search{border:1px solid CanvasText}}`。保留 WorldScene 的 opacity .12，不要整体隐藏。
- **验收：** 补拍 forced-colors 下 library/discover/downloads/accounts：下拉和搜索框有 1px CanvasText 边框，箭头像素与 CanvasText 一致。

### R2-10 浅色 Lens 控件边界消失；深浅主题占位符都低于 4.5:1

- **分组：** a11y；**工作量：** S
- **问题：** zh-light-1440-home.png 中实例选择器左缘与背景约 1.0:1，glass.css 没有浅色规则。占位符：global.css:41 的 text-tertiary ×0.9，浅色 4.15:1，深色（reduced-transparency 实底命令栏）约 4.0:1。
- **修法：** 1）`[data-theme="light"] .vx-glass-surface[data-variant="control"]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--text-secondary) 45%,transparent),var(--shadow-raised)}`。2）`input::placeholder,textarea::placeholder{color:var(--text-tertiary);opacity:1}`，深色 --text-tertiary 由 #8b8b88 改为 #8f8f8b。
- **验收：** 浅色首页选择器边缘与相邻背景 ≥2.5:1。占位符在深浅两种主题、各自最亮的输入底色上 ≥4.5:1（实测采样）。

### R2-11 资料加载失败态：灰板过重，按钮被泄漏样式压小，live 区域包住了按钮

- **分组：** consistency；**工作量：** S
- **问题：** HomePage.tsx:187 的 role=status 包含 :202 的重试按钮。overture.css:77-79 的 `.vx-character-placeholder .vx-button{min-height:34px;font-size:11px}` 泄漏到首页。home.css:148-160 用 bg-raised、24px 圆角，约 480×310 的灰板盖住岛面（state-profile-failure-home.png）。
- **修法：** 1）role=status 只挂在常驻的 <strong> 上，按钮移到 live 区域外。2）overture.css:77-79 限定到 `.vx-overture-root` 作用域内；按钮改用 variant="secondary" size="md"。3）home.css:148-160 改为 `background:var(--surface-panel);border:1px solid var(--hairline);border-radius:var(--radius-md);height:auto;max-width:320px;align-self:center`。
- **验收：** audit state-profile-failure-home：按钮高 38px、字号 ≥13px，surfaceRadii 不含 24px；live 区域文本不含按钮文字。

### R2-12 准备进度 live 区域播报过量；LoadingStatus 插入时已带文字，可能不播报

- **分组：** a11y；**工作量：** S
- **问题：** LaunchConsole.tsx:87 的 aria-live=polite 包住阶段名、百分比、progressbar 和文件计数，每次进度推送都会播报。LoadingStatus.tsx:11 延迟后才插入带文字的 role=status 节点。
- **修法：** 1）去掉 :87 的 aria-live，另加常驻的 sr-only role=status，只在阶段变化和 25/50/75/100% 时更新文字（useRef 记住上次播报的档位）。2）LoadingStatus 改为常驻 `<p role="status">{visible?children:null}</p>`。
- **验收：** 单测：准备阶段模拟 100 次进度推送，status 文本变化 ≤5 次；LoadingStatus 容器在 visible 前已挂载。

### R2-13 首页无实例空态：标题与说明空约 80px，按钮上下堆叠、左缘不齐

- **分组：** consistency；**工作量：** S
- **问题：** global.css:114 的 `.vx-empty{padding:32px 0}` 后加载，覆盖了 home.css:79；home.css:81 用 grid 让两个按钮纵向排列，ghost 次按钮的图标 x 不齐（state-no-instances-home.png）。
- **修法：** home.css:79 改为 `.vx-home .vx-home__empty.vx-empty{padding:0;gap:16px}`；:81 改为 `display:flex;flex-wrap:wrap;gap:8px`；次按钮改用 variant="secondary"。
- **验收：** h1 底到说明文字顶 ≤20px；两个按钮同一行、顶边对齐。

### R2-14 联机页：服务器详情标题与 h1 同为 28px，1050 下折 7 行；列表列宽与其他工作区不一致

- **分组：** responsive；**工作量：** S
- **问题：** multiplayer.css:71 h2 用 --text-2xl 加 overflow-wrap:anywhere；:56-57 header 与 actions 同行；:19 列宽 minmax(250px,300px)、gap 28px，详情列从 x=352 开始，其他页是 296；:119 的 ≤960 断点不可达（en-dark-1050-multiplayer.png）。
- **修法：** 1）:19 改为 `grid-template-columns:var(--rail-w) minmax(0,1fr);gap:var(--space-5)`。2）≤1279px 时 .vx-server-row 改为单列，actions 换行到 header 下。3）:71 改为 `font-size:var(--text-xl);line-height:1.25;-webkit-line-clamp:2` 加 overflow:hidden，h2 和 ServerList.tsx:60 的 <strong> 加 title。4）地址在 . @ : 后插入 <wbr>，CSS 改用 break-word。5）:68 图标由 60px 改为 44px。6）删除 :119/:124。
- **验收：** en-dark-1050-multiplayer：标题 ≤2 行，详情列左缘 x=296，audit fontSizes 中 28px 只出现 1 次（h1）。

### R2-15 内容起点统一：PageHeader 都带描述，并设最小高度

- **分组：** consistency；**工作量：** S
- **问题：** AccountsPage.tsx:24、DiscoverPage.tsx:57、DownloadsPage.tsx:29 没有传 description（accounts/discover 的 subtitle 文案已有），首个区块在 y≈181–197；游戏库/联机/设置在 210–216，切页时跳约 30px。角色页“账号”h2 有分隔线，“外观”h2 没有，y 分别为 197 和 203。
- **修法：** 三页都传 description；downloads.json 在 zh/en 新增 subtitle。surfaces.css 设 `.vx-page-header__text{min-block-size:calc(var(--text-2xl)*1.25 + var(--space-2) + var(--text-sm)*1.6)}`。accounts.css:6-8 两个子标题区都设 min-height:44px，分隔线统一为都有。
- **验收：** zh/en × 1440/1050：六个内容页首个区块顶 y 的差 ≤2px；角色页两栏 h2 的 y 相等。

### R2-16 文字角色令牌化：字重两档、区块标题一种字号、去掉非令牌小字号、Doto ≥15px

- **分组：** consistency；**工作量：** M
- **问题：** fonts.css 只有 MiSans 400 和 600 两个字面，CSS 却写了 11 种字重。区块 h2 有 16px 和 18px（settings.css:55）两种；表单标签有三种写法（global.css:102 是 600 主色，settings.css:28 是 13/400 次色，accounts.css:42 是 12px）；downloads.css:65/346/369/408/420 有 10.5–11.5px，accounts.css:65 有 11px；multiplayer.css:32 用 13px Doto（“0”读起来像菱形）。
- **修法：** tokens.css 增加 `--weight-regular:400;--weight-strong:600` 和角色令牌 --type-section（600 16px）、--type-label（400 13px 次色）、--type-meta（400 12px）。所有 h2 显式写字重；550–700 一律改为 strong；10.5/11/11.5/12.5px 改为 var(--text-xs)。multiplayer.css:32 改为 15px/900；downloads.css:356 改为 900。15/17/19px 和徽记首字的 21/25/31px 不动（见 not_doing）。
- **验收：** grep 功能 CSS：font-weight 只出现 400/600/900 或令牌；没有 <12px 的字号。audit 中各页 h2 字号唯一。

### R2-17 字段外观统一：扁平 Select 触发器与输入框同一套描边；去掉探索页 embedded 选择器

- **分组：** consistency；**工作量：** S
- **问题：** AnchoredListbox.css:33 的触发器是 surface-solid + hairline，global.css:29-35 的输入框是 bg-raised + border-strong。DiscoverPage.tsx:63 的“安装到”是 embedded，与 :78 的“来源”扁平框并排却不同。仓库已没有原生 <select>，相关规则都是死规则：discover.css:5/:12、accounts.css:43/:71、library.css:105/:1584。
- **修法：** 只改触发器：`.vx-select--flat .vx-select__surface{background:var(--bg-raised);border-color:var(--border-strong);border-radius:var(--radius-sm)}`，弹出层不变。去掉 DiscoverPage.tsx:63 的 embedded；删除上述死规则。命令栏是否 12px 随 R2-05 的决定。
- **验收：** zh-dark-1440-discover 左栏两个选择器像素外观一致；设置页输入框和下拉的边框色相同。

### R2-18 下载历史：终态改紧凑行，加筛选和分页，两段容器统一

- **分组：** responsive；**工作量：** M
- **问题：** DownloadsPage.tsx:86-87 把 199 条历史全部渲染成约 285px 的完整卡（en-dark-1920-downloads.png），失败行仍显示“Size pending”和空进度条。Active 段在面板外，History 段在 .vx-panel 内（:72-74，surfaces.css:33 有单页特例），标题左缘错开 25px。
- **修法：** 1）终态行改为 56px 单行 grid（标题｜状态 chip｜大小或文件数｜时间与操作），不渲染 LatticeProgress。2）History 标题旁加 Segmented 筛选（全部/失败/已完成）。3）默认显示 30 条，加“显示更多”sm 按钮，contain-intrinsic-block-size 改为 56px。4）两段都放进 vx-panel，删除 surfaces.css:33。
- **验收：** 200 任务夹具：首屏可见 ≥8 条历史，页面总高 <4000px；两段 h2 的 x 相等；失败行不出现“Size pending”。

### R2-19 首页 rail 和最近实例随宽度伸缩

- **分组：** responsive；**工作量：** S
- **问题：** home.css:3 --home-rail 固定 320（≤1180 时为 296，:232）；home.css:207 最近实例写死 4 列，1920 下每张约 223px，1050 下 2 列反而约 315px，选择器截成“Christopher Alexa…”。
- **修法：** home.css:3 改为 `clamp(296px,21vw,400px)`，删除 :232；:207 改为 `repeat(auto-fill,minmax(min(100%,240px),1fr))`，删除 :235；同步 ::before 渐变宽度。
- **验收：** 1920 下选择器文本区 ≥280px，最近卡宽 ≥240px；1050/1280/1920 的 data-world-anchor 复测脚仍落在岛上；M2 门槛通过。

### R2-20 断点体系与 minWidth 1050 对齐，清理不可达规则和死选择器

- **分组：** responsive；**工作量：** M
- **问题：** tauri.conf.json:20 minWidth=1050，30 条 max-width 中 22 条低于 1050，约 406 行永远不会生效。1050/1100/1150/1180 四个阈值散在各处，没有宽屏断点。overture.css 有 36 处 vx-overture-scene 死类，还有 .vx-lattice-selection、.vx-settings-field-full。
- **修法：** tokens.css 定义 compact ≤1179（`--page-gutter:24px`）、regular、wide ≥1680 三档，功能 CSS 只消费令牌。删除 <1050 的规则，只保留一条 ≤760 的 .vx-workspace 单列兜底。删除上述死选择器。规格 workstream 5 写明三档。
- **验收：** grep @media max-width 的值 ∈{1179,760}；playwright 窄视口用例仍通过。

### R2-21 拆分 library.css，只保留最终生效的一版

- **分组：** tests/health；**工作量：** L
- **问题：** library.css 有 2154 行，约占全部 CSS 的一半。.vx-instance-card 在 :147、:1663、:2007 三处定义，335 个规则头中 80 个重复。死选择器有 .vx-detail-tabs、.vx-segmented、.vx-detail-context__signature、__category、__played 等。圆角令牌只用了 5 处，间距令牌 0 处。
- **修法：** 拆成 library-grid.css 和 instance-detail.css。每个选择器只保留 Round 2 那一版，保留 :1336/:1343/:1989 的 reduced-motion/contrast/forced-colors 分支。数值换成 --radius-*/--space-*。.vx-dialog .vx-segmented 移到 selection.css（与 R2-27 一起）。
- **验收：** 两个文件合计 ≤900 行；stylelint no-duplicate-selectors 0 报错；library-review、frontend-completion、ui-stress 截图像素差异在阈值内。

### R2-22 守护：i18n、令牌棘轮、跨页几何 e2e 接入 npm test

- **分组：** tests/health；**工作量：** M
- **问题：** package.json 和 CI 都没调用 check-i18n.mjs；它只扫 .tsx，也不查没用到的键（home:greeting*、library:noInstances* 等）。没有令牌计数和跨页几何断言，测试还按轮次锁定局部值。
- **修法：** 1）`"check":"node scripts/check-i18n.mjs && node scripts/check-design-tokens.mjs"`，并由 test 调用。2）check-i18n 扫描 .ts，检测未用键（支持动态前缀和 errors.* 白名单）。3）check-design-tokens：border-radius 只允许 var()/0/50%，font-size 不允许 px 字面量，padding/margin/gap 的 px 计数写进 baseline.json，只许减少。4）tests/e2e/design-consistency.spec.ts：六个内容页 × 3 宽度 h1 同 x，.vx-button 高度 ∈{32,38,56}、圆角 999（白名单），.vx-panel/.vx-card 圆角 ∈{6,12}；外加一轮浅色键盘巡检。5）逐步把 round*/review-* spec 并入按功能命名的文件。
- **验收：** npm test 包含上述检查，在 a4f756e 上因 R2-05/R2-06/R2-01 的项而失败，修复后通过；未用键清零。

### R2-23 zh 术语：账号与角色分开，模型名翻译

- **分组：** responsive；**工作量：** S
- **问题：** zh-CN/accounts.json:5-6 的 addAccount/loginTitle 是“添加角色”，:4 listTitle 是“账号”，:7 是“离线角色”，:105-106 是“Classic · 宽臂/Slim · 细臂”，:157 混用英文。
- **修法：** 改为“添加账号”“离线账号”，模型改为“经典（宽臂）/纤细（细臂）”，modelInvalid 同步改。页面 h1 和导航保留“角色”。
- **验收：** zh-dark-1440-accounts 中按钮显示“添加账号”，没有 Classic/Slim 英文；coverage.test 通过。

### R2-24 联机页空状态放进与有数据时相同的外框，去掉重复文案

- **分组：** consistency；**工作量：** S
- **问题：** ServerList.tsx:61 左栏与 :87 右栏的 EmptyState 文案相同，右栏没有外框（zh-dark-1440-multiplayer.png）。有数据时是 min-height 380 的卡片。
- **修法：** 左栏无数据时只显示计数 0；:87 包进 `<article className="vx-server-row vx-server-row--empty">`，`display:grid;place-content:center;justify-items:start`。说明文字指向工具栏的“添加服务器”，不新增主按钮。
- **验收：** 空态右栏有 hairline 外框，高度 380px；页面中“还没有保存的服务器”只出现 1 次。

### R2-25 首页 Tab 顺序和重复标签

- **分组：** a11y；**工作量：** S
- **问题：** keyboard-home 顺序为 启动游戏(64,616) → 动画模式(720,203)，多实例时再回到底部的最近实例。HomePage.tsx:283-289 的 role=group 与 Select 的 aria-label 都是“动画模式”，读屏念两遍。
- **修法：** 把 .vx-home__animation-controls 的 DOM 移到 .vx-home__recent 之后，视觉位置用 grid-area 保持；去掉外层 role/aria-label。
- **验收：** keyboard-home 中最近实例在动画模式之前；读屏树中“动画模式”只出现 1 次。

### R2-26 实例卡：路径中间省略，名称 2 行

- **分组：** responsive；**工作量：** S
- **问题：** InstanceCard.tsx:97 路径尾部省略，1920 下仍截断；名称单行截断（en-dark-1920-library.png）。:97 在 span 上用 aria-label，属于禁止用法。
- **修法：** 路径拆成 head（可省略）和 tail（最后一段，flex:0 0 auto，max-width:70%），保留 title。library.css:224 和 :1692 的 name 改为 2 行 clamp，list 视图（:464/:1810）保持单行。aria-label 改为 sr-only 前缀。
- **验收：** en-dark-1920-library：路径可见最后一段目录名；名称 ≤2 行且不截断常见长度。

### R2-27 创建对话框三条分段轨道宽度统一

- **分组：** consistency；**工作量：** S
- **问题：** flow-create-dialog.png 中第一条按内容收缩，另两条撑满 510px 但选项左对齐。来源是 library.css:839-847/:1509 的 display:flex。
- **修法：** 移到 selection.css：`.vx-dialog .vx-segmented{display:inline-flex;justify-self:start;max-inline-size:100%;flex-wrap:wrap}`，在 Segmented.tsx 加 fill 属性显式控制；详情页标签显式保留现有形态。
- **验收：** 三条轨道宽度都等于内容宽度；flow-instance-detail-tab*.png 无回归。

### R2-28 solid/Lite 场景下导航栏改为近实底

- **分组：** a11y；**工作量：** S
- **问题：** state-horizon-solid-library、mode-lite-library 中半透明导航栏透出体块纹理，次级导航文字在亮块边缘局部降到约 3.5:1。
- **修法：** `[data-world-material="solid"] .vx-window-chrome__bar,[data-effects="lite"] .vx-window-chrome__bar{background:color-mix(in srgb,var(--surface-solid) 88%,transparent)}`，与 shell.css:211-212 的 reduced-transparency 处理一致。
- **验收：** 两张截图中导航文字对其上下两行像素的最差对比 ≥4.5:1。

### R2-29 首页控制台左缘在紧凑档对齐 24px 网格（低优先级）

- **分组：** consistency；**工作量：** S
- **问题：** audit：首页 h1.x 为 60/97/337，内容页为 24/105/345。只有 1050 下 36px 的差可以感知；首页构图已接受，h1 的 y 与内容页相差数百 px。
- **修法：** 只在 ≤1179 时让 .vx-home__layout 的 padding-inline 等于 var(--page-gutter)，stage 的 padding-inline 设为 0，并同步 home.css:13 的渐变公式。1440/1920 不动。
- **验收：** en-*-1050-home h1.x=24；1050 的 data-world-anchor 复测脚落在岛上；M2 门槛通过。

### S1 世界外观测试不确定：固定 sleep 加单帧截图，没有渲染器断言

- **分组：** tests/health；**工作量：** S
- **问题：** world-acceptance.spec.ts:29-30 sleep 3500/700ms 后截单帧，覆盖率余量只剩 0.78pp。
- **修法：** 复用 E1 的 afterEach，断言 renderer 不是软件渲染、DPR=1。等待角色 ready 且连续两次采样差 <0.3pp 后，间隔 250ms 连拍 5 帧取中位数。在 d5e31ad 和修复版各采 10 次，把 σ 写进 baseline，余量 = 设计增量 + 3σ。与 M2 同批落地。
- **验收：** 同一构建连跑 10 次，岛面均值 σ<3，覆盖率 σ<0.5pp，无偶发失败。

### S2 指针关闭选择器时，标题提前淡回，与列表重叠约 50ms

- **分组：** motion；**工作量：** S
- **问题：** home.css:46 标题 80ms 淡回，列表 100ms ease-exit 退场。
- **修法：** 把 AnchoredListbox.tsx:73-77 中 cleanup 里的 onOpenChange(false) 挪到 AnimatePresence onExitComplete 回调；不要给标题无条件加 delay。
- **验收：** review-fixes.spec.ts 逐 RAF 采样：凡 surface opacity>0.05 的帧，identity opacity 必须 <0.05；键盘关闭时标题无空白帧。

### S3 无 GPU 计时时帧预算没有余量，偶发跳帧就会不可逆降档

- **分组：** world；**工作量：** S
- **问题：** WorldScene.tsx:173-174 用 16.7ms 预算，60Hz 下偶发一次跳帧就降档。
- **修法：** submission 源的预算改为 1.25×最近 30 个 rAF 间隔的中位数，且要求连续 2 个 2s 窗口都超标才降档。
- **验收：** 单测：60Hz 每 90 帧跳 1 帧、持续 10s 不降档；50Hz 不降档；100Hz 每 6 帧成功 1 帧仍降档。

### S4 导航活动胶囊中心有竖向细条，边缘有色散楔形

- **分组：** world；**工作量：** M
- **问题：** 深浅两种主题都有，竖条与胶囊中心重合，与背景点阵相位无关。
- **修法：** 在 GlassSystem 中对比 dispersion=0 与 0.65 的静止截图，定位位移贴图中心的采样接缝并修正；确认楔形来自色散后，再加 `[data-theme="light"]{--vx-lens-dispersion:.25}`。
- **验收：** 深浅两种主题 × 首页/内容页的胶囊：与背景差 >25 的像素占比 <0.5%。

### S5 无账户预览胶囊是不透明实底，浅色下像贴着的标签

- **分组：** consistency；**工作量：** S
- **问题：** home.css:139-140 是 surface-card 实底。
- **修法：** 改为 `color-mix(in srgb,var(--surface-card) 78%,transparent)`、blur(10px)、hairline；reduced-transparency 和高对比下回退为实底、不加 blur。
- **验收：** E1 无账户深浅色 × 1280/1050 的 intro 和 idle 对比度 ≥4.5。

### S6 solid 材质的柱裙从 9 格变成 3 格，没有验收覆盖

- **分组：** world；**工作量：** S
- **问题：** shaders.ts:234 在 uLat=0 时化简为 mix(s,3.,m)。
- **修法：** 先截 massif profile=1 的 solid 陡坡，确认是否露缝；如露缝，或用户希望保持 0.6.0 观感，改为 `mix(s, mix(9.,3.,uLat), …)`，并在 settings-solid-massif 截图上加回归比较。
- **验收：** solid massif 陡坡截图中没有背景色穿透（柱间背景像素占比 <0.5%）。

## 评分

| 方面 | 评级 | 说明 |
|---|---|---|
| design language | 参差 | 骨架层已统一：六个内容页 h1 在 1050/1440/1920 下 x=24/105/345、y=114；字体只有 MiSans/Doto/Cascadia 三种；玻璃只出现在角色分工允许的位置。组件层没有收口：行、标签、侧栏类的选中样式有 4 种写法；游戏库命令栏按钮是 12px 圆角，与其他页的药丸形不一致，页面级高度覆盖有 28/34/40/44px；阅读面偏离令牌的有 5 处（角色预览 bg-raised 16px、下载空态、详情工作区、命令栏、探索页面板套面板）；区块 h2 有 16 和 18 两种字号。 |
| motion | 参差 | 动效常量基本收在 MOTION 里，例外只有 jelly、lattice、progressField 的局部弹簧和 HomeAnimationSelector.css:10 的 160ms。生命周期仍有问题：M3 同 id 替换 Toast 时重挂元素、S2 指针关闭时标题与列表重叠约 50ms、R2-02 启动/取消/停止时 key 换掉导致焦点丢失。 |
| world | 差 | M1 未修：a4f756e 的 shaders.ts:257 仍是 vec3(1.2,1.176,1.104)。本轮补测，massif lattice 也过曝（state-massif-lattice-home.png 下半区纯白 2610 px，zh-dark-1440-home 为 11966 px）。M2 的岛面门槛仍失效，用户已批准新口径。内容页 1920 下世界偏暗，原因是 pointGain 0.3，这是规格有意设定，不算缺陷。 |
| accessibility | 差 | 命名、跳过链接、对话框焦点陷阱、深色焦点环都合格（unnamedCount=0，errors.json 全空）。有三处硬伤：浅色主题焦点环用 #b4f17a，对比度 1.18–1.26:1；启动/取消/停止时焦点落到 body；游戏库搜索框 outline:0。此外 live 区域播报过量，选中态的 ARIA 有三种写法，当前账号按钮 disabled 后 Tab 走不到。 |
| modes | 参差 | Lite、减少动态、高对比下都会关掉光晕和 Jelly；高对比下导航对比度 13:1。forced-colors 下，排序下拉的边界（box-shadow）被清掉，箭头保留主题色，看起来像普通文字；搜索框也没有边界。solid 和 Lite 下半透明导航栏透出体块纹理，局部对比度约 3.5:1。 |
| states | 参差 | EmptyState 和 LoadingStatus 已统一，150ms 延迟。偏差有：资料加载失败时出现 24px 圆角灰板，重试按钮被 overture.css 泄漏的规则压成 34px/11px，role=status 还包住了按钮；无实例首页标题与说明之间空约 80px；联机页空状态没有面板承载，文案与左栏重复；下载历史失败行仍显示空进度条。 |
| responsive | 参差 | 没有横向溢出，en 长文案在 1050 下放得下。断点和 minWidth 1050 不匹配：30 条 max-width 中 22 条不可达，也没有宽屏断点。联机页 1050 下服务器标题折成 7 行，详情列从 x=352 开始，其他页是 296。首页 rail 固定 320px，宽屏下最近实例卡反而比 1050 下窄。 |
| i18n | 好 | check-i18n 通过（725 个键、2 种语言），zh/en 按钮和标签都放得下。只有两处术语问题：zh 页面叫“角色”、区块叫“账号”、按钮写“添加角色”；Classic/Slim 没有翻译。另外 i18n 检查没有接入 npm test，也不查没用到的键。 |
| code health | 差 | App.tsx:6-13 先 import 功能 CSS，:25-27 才 import global/surfaces，也没有 @layer，覆盖靠加载顺序和特异度生效；探索详情弹窗因此可能被锁在 560px。library.css 有 2154 行，同一选择器三处定义；功能 CSS 中间距令牌引用 0 处，px 字面量 586 处。断点不可达和 overture-scene 死代码约 400 行。 |
| tests | 参差 | 620 个单测通过，e2e 32 个 spec，但都按评审轮次命名，只断言局部值，例如 library-review.spec.ts:163 断言 12px。没有跨页几何、按钮集合、令牌计数的断言。岛面门槛只在 worklog 脚本里，allAGatesPass 混入了人工项。浅色主题的键盘巡检从未跑过。 |

## 不做

- 不改强调绿 #b4f17a。浅色只新增 --accent-indicator 作为焦点和图形用色，深色下它等于原色。
- 不改首页左下控制台构图。首页不纳入“六页 h1 同 x”的 e2e，1440/1920 下 8px 的差不处理。
- 不把 1920 内容页世界偏暗当作缺陷。pointGain 0.3 是规格 4.3 为保护阅读刻意设定的值。
- 不收窄导航栏，也不让它与内容居中对齐：它兼任窗口标题栏，最小化/最大化/关闭必须贴着窗口右缘。
- 不给 solid/Lite 场景加全屏 72% 遮罩，也不改高对比下的世界场景，只把导航栏改成近实底（R2-28）。
- 不用全局 `svg{color:CanvasText !important}`，也不在 forced-colors 下隐藏世界层（WorldScene 已有 opacity .12）。
- 不删除 --radius-lg：规格 2026-11-03 第 172 行明确保留这个 12px 别名。
- 不把 15/17/19px 直接映射到更小的令牌；徽记首字的 21/25/31px 是装饰字形，不改。
- 不在 MiSans 许可确认前做子集化；也不以“首次加载 10MB/FOUT”为由，Tauri 本地加载没有实测证据。
- 不把卡片的 LatticeFrame 点框当作选中语法偏差，它是规格第 9 项的明文要求。
- 不在联机空状态再加一个主按钮，工具栏已经有“添加服务器”。
- 不把按钮圆角 0/6/14px 当作偏差：分别是内层点击区、Segmented 选中项和玻璃选择器。
- 不以 WCAG 1.4.11 为由改 Select 边框：border-strong 也达不到 3:1，统一只是为了一致性。

## 未验证

- 探索详情弹窗被锁在 560px：按代码层叠规则（global.css:86 与 discover.css:45 同为 0,1,0，global 后加载）可以确定，但没有弹窗打开时的截图。
- 浅色主题的焦点环：对比度是按公式算的，键盘巡检截图只拍了深色。
- forced-colors 下的 discover/downloads/accounts 页，以及浅色首页准备态，都没有截图。
- zh 在 1050/1280 下的内容页，以及实例详情页 1050 下的工具栏是否折行，都未截图。
- LoadingStatus 插入时已带文字导致不播报：属于 NVDA+Chrome 的已知行为，没有用读屏实测。
- M1 修复后（下限 .6 加肩部），锚点 ROI 能否达到均值 90–150、p95≤200，需要在真实 D3D11 上实测，可能还要从照明侧补。
- S2 的约 50ms 重叠、S3 在 50/48Hz 和非 Windows WebView 上的行为、S4 的色散根因，沿用上一轮的推断，没有补测。
- MiSans 许可是否允许子集化，未核对 licenses/fonts/MiSans/LICENSE.pdf。
- R2-07 迁移到 @layer 后，原先靠加载顺序失效的覆盖规则（accounts、library）是否全部清理干净，要靠改动后七页 × 3 宽度 × 深浅主题的 audit 对比来确认。
