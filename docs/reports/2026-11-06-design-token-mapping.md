# 非S4设计令牌映射附录（2026-11-06历史快照）

本附录记录2026-11-06非S4收尾时[独立复核报告](2026-11-05-review-round2-fixes.md)第10、11项的刻度映射，基线为 `main` @ `0cc8f5500a59e1885ad778751d35eb438e7147ab`。当时用户要求先不提交或推送；随后在11月7日批准S4第六次修订、真实平坦区采样，以及全套通过后统一提交／推送。最新验证与提交状态以[主报告当前节](2026-11-05-review-round2-fixes.md#independent-review-results)为准，本附录随同一合并提交保留这些历史映射及证据。

**11月6日历史验证批次：**首次完整304项295通过／9失败原样保留；6项非S4映射回归按原断言修复后，相关11项专项通过，该日完整304项为 **301通过／3项冻结S4失败**，所有非S4自动用例通过。下表保留创建panel局部20px、commandbar物理2px及间距基线359；当时14对截图对应 `edb0836f…ec341b` 源码，不是后续S4代码的当前指纹。旧102条首次映射原件保存为 `token-scale-mapping-initial-applied.json`，没有覆盖原始失败。

已移除40个按像素命名的定义，14份样式表共102条声明改为真实刻度、明确豁免的语义角色或有实际几何依据的2px内缩。以下内容由已应用回执 `verification/token-scale-mapping-applied.json` 按原顺序逐条转录，并包含其 `postValidationCorrections`；证据根为 `E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-06/verification/`。102条替换数保持不变，其中非零声明值变化由最初93条更正为92条，不将其计为92处可见变化。

表中“数值变化”描述声明所引用的像素值，不等于最终可见像素变化：级联可能覆盖声明，布局可能约束宽高，小型装饰圆角也可能被浏览器裁限。实际浏览器几何和旧版／新版截图证据由主报告第5项分别记录；不将102条声明统称102处可见变化。回执没有单列media上下文，重复选择器按各自声明分别列出，以序号、原始回执和源码上下文对应。

## 保留的语义角色与明确例外

R2-16明确保护的15／17／19px保持数值，改用描述用途的名称。窗口按钮按R2-05明文例外保留min-height34px及radius8px；guard只放行指定选择器和指定值，不将例外扩大到其它feature Button。窗口外框24→12是另一条真实尺寸变更，不与按钮例外混淆。running页脚88px保持为真实刻度64＋24；未使用的21／25／31px装饰别名直接删除，没有对应可见用法。

| 语义角色 | 保留px |
| --- | ---: |
| --text-brand | 15 |
| --text-transfer-volume | 15 |
| --text-instance-title | 17 |
| --text-instance-title-compact | 15 |
| --text-identity-letter-compact | 17 |
| --text-identity-letter | 19 |
| --text-matrix-count | 15 |
| --radius-window-control | 8 |

间距使用既有space-1..8（4／8／12／16／24／32／48／64）；圆角常规角色为6／12；h1用28，非豁免区块标题用20。detail紧凑padding先恢复到base后才能生效，再按获准刻度由22→24；regular原24／26／28／26映射为24／24／32／24。这是明确的最终尺寸变化，没有宣称保留22／26／28原字面值。

## 102条已应用声明

| 序号 | 文件 | 选择器／角色 | 属性 | 修改前 | 修改后 | 引用数值变化px |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | src/app/shell.css | .vx-window-chrome__bar | border-radius | var(--radius-24) | var(--radius-md) | 24→12（-12） |
| 2 | src/app/shell.css | .vx-window-chrome__brand | font-size | var(--text-15) | var(--text-brand) | 15→15（保持） |
| 3 | src/app/shell.css | .vx-floating-nav__count | border-radius | var(--radius-5) | var(--radius-sm) | 5→6（+1） |
| 4 | src/app/shell.css | .vx-floating-nav__avatar | border-radius | var(--radius-5) | var(--radius-sm) | 5→6（+1） |
| 5 | src/app/shell.css | .vx-window-chrome__controls .vx-button | border-radius | var(--radius-8) | var(--radius-window-control) | 8→8（保持） |
| 6 | src/app/shell.css | .vx-page-error h1 | font-size | var(--text-24) | var(--text-2xl) | 24→28（+4） |
| 7 | src/components/PlayerAvatar.css | .player-avatar | border-radius | var(--radius-8) | var(--radius-sm) | 8→6（-2） |
| 8 | src/design/global.css | ::-webkit-scrollbar-thumb | border-radius | var(--radius-8) | var(--radius-sm) | 8→6（-2） |
| 9 | src/design/surfaces.css | .vx-form-stack | gap | var(--space-20px) | var(--space-5) | 通用20→24（+4）；创建panel局部仍20，见后表 |
| 10 | src/design/surfaces.css | .vx-resource-row | gap | var(--space-18px) | var(--space-4) | 18→16（-2） |
| 11 | src/design/surfaces.css | .vx-resource-row | padding | var(--space-14px) 0 | var(--space-4) 0 | 14→16（+2） |
| 12 | src/features/accounts/accounts.css | .vx-account-section-heading h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 13 | src/features/discover/discover.css | .vx-discover-results-heading h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 14 | src/features/discover/discover.css | .vx-project-details__section h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 15 | src/features/downloads/downloads.css | .vx-task-section__heading h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 16 | src/features/downloads/downloads.css | .vx-downloads-empty .vx-empty__icon | border-radius | var(--radius-7) | var(--radius-sm) | 7→6（-1） |
| 17 | src/features/downloads/downloads.css | .vx-task-row__stage | border-radius | var(--radius-5) | var(--radius-sm) | 5→6（+1） |
| 18 | src/features/downloads/downloads.css | .vx-task-row__bytes | font-size | var(--text-15) | var(--text-transfer-volume) | 15→15（保持） |
| 19 | src/features/downloads/downloads.css | .vx-task-row__percent | font-size | var(--text-32) | var(--text-xl) | 32→20（-12） |
| 20 | src/features/downloads/downloads.css | .vx-task-row__percent | font-size | var(--text-29) | var(--text-xl) | 29→20（-9） |
| 21 | src/features/home/home.css | .vx-launch-console__progress-text | font-size | var(--text-18) | var(--text-xl) | 18→20（+2） |
| 22 | src/features/home/home.css | .vx-section-heading h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 23 | src/features/library/create-instance.css | .vx-check-row input | margin-top | var(--space-2px) | var(--space-1) | 2→4（+2） |
| 24 | src/features/library/instance-detail.css | .vx-detail-header > .vx-button:first-child | margin-top | var(--space-1px) | 0 | 1→0（-1） |
| 25 | src/features/library/instance-detail.css | .vx-detail-header__identity h1 | font-size | var(--text-26) | var(--text-2xl) | 26→28（+2） |
| 26 | src/features/library/instance-detail.css | .vx-detail-context | gap | var(--space-20px) | var(--space-5) | 20→24（+4） |
| 27 | src/features/library/instance-detail.css | .vx-detail-section ul | gap | var(--space-7px) | var(--space-2) | 7→8（+1） |
| 28 | src/features/library/instance-detail.css | .vx-detail-section ul | padding-left | var(--space-20px) | var(--space-5) | 20→24（+4） |
| 29 | src/features/library/instance-detail.css | .vx-overview-ledger > .vx-action-row | padding-top | var(--space-2px) | var(--space-1) | 2→4（+2） |
| 30 | src/features/library/instance-detail.css | .vx-check-grid | gap | var(--space-10px) var(--space-18px) | var(--space-3) var(--space-4) | 10→12（+2）；18→16（-2） |
| 31 | src/features/library/instance-detail.css | .vx-check-grid label input | margin-top | var(--space-2px) | var(--space-1) | 2→4（+2） |
| 32 | src/features/library/instance-detail.css | .vx-screenshot-grid | gap | var(--space-9px) | var(--space-2) | 9→8（-1） |
| 33 | src/features/library/instance-detail.css | .vx-screenshot-preview img | border-radius | var(--radius-7) | var(--radius-sm) | 7→6（-1） |
| 34 | src/features/library/instance-detail.css | .vx-detail-page summary | padding | var(--space-10px) 0 | var(--space-3) 0 | 10→12（+2） |
| 35 | src/features/library/instance-detail.css | .vx-detail-manage__menu | padding | var(--space-5px) | var(--space-1) | 5→4（-1） |
| 36 | src/features/library/instance-detail.css | .vx-detail-manage__menu | border-radius | var(--radius-8) | var(--radius-sm) | 8→6（-2） |
| 37 | src/features/library/instance-detail.css | .vx-detail-manage__menu button | padding | var(--space-7px) var(--space-10px) | var(--space-2) var(--space-3) | 7→8（+1）；10→12（+2） |
| 38 | src/features/library/instance-detail.css | .vx-detail-header__identity | gap | var(--space-14px) | var(--space-4) | 14→16（+2） |
| 39 | src/features/library/instance-detail.css | .vx-detail-workspace | padding | var(--space-5) var(--space-26px) var(--space-28px) | var(--space-5) var(--space-5) var(--space-6) | 26→24（-2）；28→32（+4） |
| 40 | src/features/library/instance-detail.css | .vx-overview-operations | gap | var(--space-22px) | var(--space-5) | 22→24（+2） |
| 41 | src/features/library/instance-detail.css | .vx-overview-operations | padding-top | var(--space-22px) | var(--space-5) | 22→24（+2） |
| 42 | src/features/library/instance-detail.css | .vx-facts | gap | var(--space-2px) | var(--space-1) | 2→4（+2） |
| 43 | src/features/library/instance-detail.css | .vx-facts > div | padding | var(--space-3) var(--space-14px) | var(--space-3) var(--space-4) | 14→16（+2） |
| 44 | src/features/library/instance-detail.css | .vx-facts > div | border-radius | var(--radius-4) | var(--radius-sm) | 4→6（+2） |
| 45 | src/features/library/instance-detail.css | .vx-screenshot | gap | var(--space-7px) | var(--space-2) | 7→8（+1） |
| 46 | src/features/library/instance-detail.css | .vx-screenshot | border-radius | var(--radius-7) | var(--radius-sm) | 7→6（-1） |
| 47 | src/features/library/instance-detail.css | .vx-log-view | padding | var(--space-14px) | var(--space-4) | 14→16（+2） |
| 48 | src/features/library/instance-detail.css | .vx-log-view | border-radius | var(--radius-7) | var(--radius-sm) | 7→6（-1） |
| 49 | src/features/library/instance-detail.css | .vx-launch-status | gap | var(--space-18px) | var(--space-4) | 18→16（-2） |
| 50 | src/features/library/instance-detail.css | .vx-launch-status | border-radius | var(--radius-10) | var(--radius-md) | 10→12（+2） |
| 51 | src/features/library/instance-detail.css | .vx-detail-selection > button | padding | var(--space-10px) var(--space-3) | var(--space-3) var(--space-3) | 10→12（+2） |
| 52 | src/features/library/instance-detail.css | .vx-detail-workspace | padding | var(--space-22px) | var(--space-5) | 22→24（+2） |
| 53 | src/features/library/library-grid.css | .vx-instance-card.is-running .vx-instance-card__state::before | border-radius | var(--radius-2) | 0 | 2→0（-2） |
| 54 | src/features/library/library-grid.css | .vx-library-empty .vx-empty__action | margin-top | var(--space-5px) | var(--space-1) | 5→4（-1） |
| 55 | src/features/library/library-grid.css | .vx-library-scope | gap | var(--space-2px) | var(--space-1) | 2→4（+2） |
| 56 | src/features/library/library-grid.css | .vx-library-scope | padding | var(--space-3px) | var(--space-1) | 3→4（+1） |
| 57 | src/features/library/library-grid.css | .vx-library-scope | border-radius | var(--radius-8) | var(--radius-sm) | 8→6（-2） |
| 58 | src/features/library/library-grid.css | .vx-library-page .vx-library-scope button | padding | var(--space-6px) var(--space-11px) | var(--space-2) var(--space-3) | 6→8（+2）；11→12（+1） |
| 59 | src/features/library/library-grid.css | .vx-library-commandbar | margin | 0 0 var(--space-18px) | 0 0 var(--space-4) | 18→16（-2） |
| 60 | src/features/library/library-grid.css | .vx-library-commandbar | padding | var(--space-6px) | var(--space-2) | 6→8（+2） |
| 61 | src/features/library/library-grid.css | .vx-library-page .vx-search | gap | var(--space-9px) | var(--space-2) | 9→8（-1） |
| 62 | src/features/library/library-grid.css | .vx-library-page .vx-search | padding | 0 var(--space-10px) | 0 var(--space-3) | 10→12（+2） |
| 63 | src/features/library/library-grid.css | .vx-library-page .vx-search input | padding | var(--space-5px) 0 | var(--space-1) 0 | 5→4（-1） |
| 64 | src/features/library/library-grid.css | .vx-library-commandbar__actions | gap | var(--space-6px) | var(--space-2) | 6→8（+2） |
| 65 | src/features/library/library-grid.css | .vx-library-view | gap | var(--space-1px) | 0 | 1→0（-1） |
| 66 | src/features/library/library-grid.css | .vx-library-view | padding | var(--space-2px) | var(--space-1) | 基础声明2→4（+2）；commandbar被第68条覆为2，非最终可见2→4 |
| 67 | src/features/library/library-grid.css | .vx-library-view | border-radius | var(--radius-7) | var(--radius-sm) | 7→6（-1） |
| 68 | src/features/library/library-grid.css | .vx-library-page .vx-library-commandbar .vx-library-view | padding | var(--space-2px) | 2px | 2→2（保持；首次尝试4已修回2） |
| 69 | src/features/library/library-grid.css | .vx-library-page .vx-library-commandbar .vx-library-view > button | padding | 0 var(--space-10px) | 0 var(--space-3) | 10→12（+2） |
| 70 | src/features/library/library-grid.css | .vx-instance-card__select | padding | var(--space-4) var(--space-4) var(--space-10px) | var(--space-4) var(--space-4) var(--space-3) | 10→12（+2） |
| 71 | src/features/library/library-grid.css | .vx-instance-card__select | border-radius | var(--radius-8) | var(--radius-sm) | 8→6（-2） |
| 72 | src/features/library/library-grid.css | .vx-instance-card__information | gap | var(--space-5px) | var(--space-1) | 5→4（-1） |
| 73 | src/features/library/library-grid.css | .vx-instance-card__name | font | var(--weight-strong) var(--text-17)/1.32 var(--font-ui) | var(--weight-strong) var(--text-instance-title)/1.32 var(--font-ui) | 17→17（保持） |
| 74 | src/features/library/library-grid.css | .vx-instance-card__technical | gap | var(--space-6px) | var(--space-2) | 6→8（+2） |
| 75 | src/features/library/library-grid.css | .vx-instance-card__path | gap | var(--space-5px) | var(--space-1) | 5→4（-1） |
| 76 | src/features/library/library-grid.css | .vx-instance-card__open | margin-top | var(--space-1px) | 0 | 1→0（-1） |
| 77 | src/features/library/library-grid.css | .vx-instance-card__footer | gap | var(--space-14px) | var(--space-4) | 14→16（+2） |
| 78 | src/features/library/library-grid.css | .vx-instance-card__footer | padding | 0 var(--space-4) var(--space-3) var(--space-88px) | 0 var(--space-4) var(--space-3) calc(var(--space-8) + var(--space-5)) | 88→88（保持） |
| 79 | src/features/library/library-grid.css | .vx-instance-card__state | gap | var(--space-6px) | var(--space-2) | 6→8（+2） |
| 80 | src/features/library/library-grid.css | .vx-instance-identity__plane::after | border-radius | var(--radius-1) | 0 | 1→0（-1） |
| 81 | src/features/library/library-grid.css | .vx-instance-sheet--list | gap | var(--space-6px) | var(--space-2) | 6→8（+2） |
| 82 | src/features/library/library-grid.css | .vx-instance-sheet--list .vx-instance-card__information | gap | var(--space-3px) | var(--space-1) | 3→4（+1） |
| 83 | src/features/library/library-grid.css | .vx-instance-sheet--list .vx-instance-card__name | font-size | var(--text-15) | var(--text-instance-title-compact) | 15→15（保持） |
| 84 | src/features/library/library-grid.css | .vx-instance-sheet--list .vx-instance-identity__letter | font-size | var(--text-17) | var(--text-identity-letter-compact) | 17→17（保持） |
| 85 | src/features/library/library-grid.css | .vx-instance-sheet--list .vx-instance-card__footer | padding | var(--space-3) var(--space-14px) | var(--space-3) var(--space-4) | 14→16（+2） |
| 86 | src/features/library/library-grid.css | .vx-library-page > .vx-library-empty | column-gap | var(--space-18px) | var(--space-4) | 18→16（-2） |
| 87 | src/features/library/library-grid.css | .vx-library-page > .vx-library-empty | padding | var(--space-38px) var(--space-40px) | var(--space-6) var(--space-7) | 38→32（-6）；40→48（+8） |
| 88 | src/features/library/library-grid.css | .vx-library-page > .vx-library-empty | border-radius | var(--radius-8) | var(--radius-sm) | 8→6（-2） |
| 89 | src/features/library/library-grid.css | .vx-library-empty .vx-empty__icon | border-radius | var(--radius-5) | var(--radius-sm) | 5→6（+1） |
| 90 | src/features/library/library-grid.css | .vx-instance-card__secondary-line | gap | var(--space-10px) | var(--space-3) | 10→12（+2） |
| 91 | src/features/library/library-grid.css | .vx-instance-identity__letter | font | var(--weight-strong) var(--text-19)/1 var(--font-ui) | var(--weight-strong) var(--text-identity-letter)/1 var(--font-ui) | 19→19（保持） |
| 92 | src/features/library/library-grid.css | .vx-library-view.vx-selection > button | padding | var(--space-7px) var(--space-10px) | var(--space-2) var(--space-3) | 7→8（+1）；10→12（+2） |
| 93 | src/features/multiplayer/multiplayer.css | .vx-managed-create h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 94 | src/features/multiplayer/multiplayer.css | .vx-server-inventory > h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 95 | src/features/multiplayer/multiplayer.css | .vx-server-inventory > h2 > span | font-size | var(--text-15) | var(--text-matrix-count) | 15→15（保持） |
| 96 | src/features/multiplayer/multiplayer.css | .vx-server-address-state[data-state='unknown'] | border-radius | var(--radius-2) | 0 | 2→0（-2） |
| 97 | src/features/multiplayer/multiplayer.css | .vx-lan-section > header h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 98 | src/features/multiplayer/multiplayer.css | .vx-server-population__cells > i | border-radius | var(--radius-2) | 0 | 2→0（-2） |
| 99 | src/features/multiplayer/multiplayer.css | .vx-managed-overview h2, .vx-managed-console h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 100 | src/features/settings/settings.css | .vx-settings-section > header h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 101 | src/features/settings/settings.css | .vx-settings-section > header h2 | font-size | var(--text-lg) | var(--text-xl) | 16→20（+4） |
| 102 | src/design/tokens.css | :root | --type-section | var(--weight-strong) var(--text-lg)/1.5 var(--font-ui) | var(--weight-strong) var(--text-xl)/1.5 var(--font-ui) | 16→20（+4） |

## 6921a83 复核后的区块标题裁定

上表保留历史102条替换，不将当时的16→20当作最终值。第12–15、22、93–94、97、99–102条涉及区块角色的字号最终均为16px；R2-14 服务器详情等实体标题仍为20px；第99条涉及的托管服务器名称是实体，保持20px，只有同条控制台区块回到16px。R2-16 与此区分一致。

补记原附录遗漏：`.vx-detail-section h2` 在 6921a83 把继承的16px/1.35改为 `--type-section` 的20px/1.5；本次恢复16px/1.35。该条是历史漏项说明，不重写当时按像素别名统计的102条。

## 完整套件后的两处局部修正

首次304项完整运行提供真实RED：full／Lite／减少动态collapsedGap24超出原18–22；导入panel204.59375不等于原197；1050／1280 commandbar view padding4不等于原2。修复只改产品，相关测试及数值断言未修改。`geometry-contract-green.json`重跑原6个失败及5个相邻用例，11/11通过、34.2秒、0失败／跳过／flaky。

| 文件／选择器 | 首次映射后的实效 | 当前修正 | 几何原因 |
| --- | --- | --- | --- |
| `create-instance.css` `.vx-create-panel > .vx-form-stack` | gap24px | `calc(var(--space-4) + var(--space-1))` =20px | 保持M4的20±2；导入两个gap各少4，204.59375−8=196.59375，由原有min-height197约束为197 |
| `library-grid.css` `.vx-library-page .vx-library-commandbar .vx-library-view` | padding4px | 物理 `2px` | 38px外高＝32px内高＋2×（1px边框＋2px内缩）；不用像素别名或半刻度伪装实际固定几何 |

通用form gap24和基础view padding4声明仍保留，但上述局部高特异性规则决定这两处控件的最终效果；第9、66条不能被误读成创建面板或commandbar的最终可见增量。物理2px产生一个真实间距字面量，因此当前计数由358变为359。

## 移除的40个像素别名定义

移除定义不等于删除其所有视觉用途；有用的引用已在上表映射，受保护角色保留原值。

| 原定义 | 原值 |
| --- | --- |
| --text-26 | 26px |
| --text-15 | 15px |
| --radius-24 | 24px |
| --radius-5 | 5px |
| --radius-8 | 8px |
| --text-24 | 24px |
| --radius-7 | 7px |
| --text-32 | 32px |
| --text-29 | 29px |
| --text-18 | 18px |
| --text-19 | 19px |
| --radius-2 | 2px |
| --radius-1 | 1px |
| --text-25 | 25px |
| --text-21 | 21px |
| --text-31 | 31px |
| --radius-10 | 10px |
| --text-23 | 23px |
| --radius-4 | 4px |
| --text-17 | 17px |
| --space-5px | 5px |
| --space-1px | 1px |
| --space-20px | 20px |
| --space-7px | 7px |
| --space-2px | 2px |
| --space-10px | 10px |
| --space-18px | 18px |
| --space-9px | 9px |
| --space-14px | 14px |
| --space-13px | 13px |
| --space-100px | 100px |
| --space-22px | 22px |
| --space-26px | 26px |
| --space-28px | 28px |
| --space-3px | 3px |
| --space-6px | 6px |
| --space-11px | 11px |
| --space-88px | 88px |
| --space-38px | 38px |
| --space-40px | 40px |

## spacing计数来源更正

旧存储基线428，基线HEAD实际正则匹配427；移除名称后减少69次匹配，首次得到358。恢复物理2px commandbar内缩新增一个真实字面量，当前实际数与重写基线为 **359**，来源为 `non-s4-spacing-counts.json`。旧正则会匹配 `--space-Npx` 名称内数值片段，并非所有间距别名引用都逃过计数。真实缺口是缺少命名空间／定义检查及数字radius／font别名仍获接受，已分别加守护。既有账号margin改动造成存储428与HEAD427差1。

| 文件 | 旧存储基线 | HEAD实际匹配 | 当前实际匹配 |
| --- | ---: | ---: | ---: |
| src/design/surfaces.css | 8 | 8 | 5 |
| src/features/accounts/accounts.css | 44 | 43 | 43 |
| src/features/library/create-instance.css | 11 | 11 | 10 |
| src/features/library/instance-detail.css | 25 | 25 | 0 |
| src/features/library/library-grid.css | 40 | 40 | 1 |

其余文件计数无变化。当前359为禁止像素编码名称后的实际直接字面量计数，不代表69处本来获准的尺寸被删除，也不把间距计数下降等同于布局验收。

## 守护与验证边界

`non-s4-token-guard-final.log`为12/12单测通过，覆盖编码定义／var引用／嵌套fallback、真实space与radius角色值、feature Button几何、panel/card圆角、窗口按钮精确例外及quoted content误报。旧baseline日志358保留，359见 `non-s4-spacing-counts.json`。11月6日收尾npm为69文件686项Vitest＋90项Node通过、TypeScript退出0；局部11项原几何断言及该次完整套件对应项均通过。单独 `test:design`命令19/19属于更前批，该日完整套件再次执行同19项且全部通过，没有宣称又单独运行该命令。该次304项301通过／3项S4失败、退出1，属于历史结果；S4后续实施与最新全套结果另见主报告。

11月6日非S4收尾期间，S4产品、门槛、失败用例和光学参数保持冻结；`s4-frozen-before-non-s4.json`保留这一历史指纹。该批没有修改依赖、版本、世界参数或阅读面透明度，没有构建安装包，也没有提交或推送。后续获准的S4限幅及采样修订已经改变相关代码和测试，不能继续用此旧指纹声称它们仍未改动。

当前已应用映射回执SHA256：`3c588413466d7ef28f9d917c36fb93b7e1aa5efe3c79ae3b9083d9b035ccb0bb`。初次原件 `token-scale-mapping-initial-applied.json` 为 `3c23c3e00d68d7b5ee8bdd0af3ab5959d4e17ffac4f04e8f0efc836abe65f444`；两个版本分别保留。
