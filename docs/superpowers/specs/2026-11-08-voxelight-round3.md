# Voxelight 第三轮：Client ID 拆仓、材质分层、Mod 安装引导、浅色山体

日期：2026-11-08。基线：main @ da0e008。用户已对下列 4 项做出决定（2026-11-07）。每项的只读调查报告在 `E:/CodeX/VoxelightLauncher-worklogs/round3/scout/scout-*.md`，其中有逐行定位、建议代码、验收和风险。本清单是判定依据；报告是实现参考，两者冲突时以本清单为准。

总规则：
- 只在 main 上工作，提交信息不加任何 AI 署名，不改版本号，不加依赖，不构建安装包。
- 每条修复先有失败的测试，再改产品。
- 四项各一个提交，按 R3-1 → R3-2 → R3-3 → R3-4 的顺序。每个提交前，`npm test`、`npx tsc -b`、`cd src-tauri; cargo test` 和完整 Playwright 都要通过；世界、设计、焦点、玻璃相关测试在 D3D11 上跑。
- 每推送一个提交，都用 `git ls-remote origin` 确认。
- 门槛、验收区域或产品参数与实际画面冲突时，停下报告。

## R3-1 Microsoft Client ID：构建时注入，公开仓库不含 ID

**决定：** 公开仓库（现有 GitHub 仓库）不包含 Client ID。另建一个本地私有仓库 `E:/CodeX/VoxelightLauncher-private`，它跟踪公开仓库，只多一个提交：`src-tauri/.cargo/config.toml`，内容是 `[env] VOXELIGHT_MS_CLIENT_ID = { value = "…", force = true }`。正式构建从私有仓库出。**私有仓库由审查方建立，Codex 不碰私有仓库，也不在任何文件、日志或报告里写真实 ID。**

**修法：** 详见 scout-client-id.md 的 recommendation A–C。

后端：
- 新增 `client_id.rs`：用 `option_env!` 读取；值不是 UUID 时视为不存在。
- 优先级：用户填的非空 ID 优先，其次用内置 ID；两者都没有时，行为与现在一致。
- 内置 ID 永远不写进 Config、settings.json、导出预设，也不经 IPC 传输；只向前端暴露布尔值 `microsoftBuiltinClientId` 和 `microsoftBuiltin`。
- build.rs 加 `rerun-if-env-changed`，并做格式检查；报错信息里不带具体的值。
- 旧的 `start_microsoft_login` 改为共用同一个解析函数，或者直接删除。

错误码：
- 把认证错误串改成常量，在 errors.rs 里按常量匹配，新增以下错误码：
  - `auth.clientRejected`（invalid_client / unauthorized_client）
  - `auth.appNotApproved`（login_with_xbox 返回 403，且内容为“Invalid app registration”）
  - `auth.rateLimited`
  - `auth.minecraftExchangeFailed`
  - `auth.xboxFailed`
- 每个新错误码都要有中英文翻译。`auth.appNotApproved` 的文案要说清楚：微软账号已登录成功，但这个应用还没有通过 Mojang 的 Minecraft API 审核。

日志脱敏：processes.rs 的 `redact` 遮盖 `--clientId` 和 `clientid=`。

前端：
- 登录对话框按三种状态显示：
  1. 没有内置 ID：与现在完全一样。
  2. 有内置 ID、没有覆盖：不显示必填输入框，“开始登录”可以直接点，并提供一个折叠的“使用自定义 Client ID”。
  3. 有内置 ID 且有覆盖：提示当前正在使用自定义 ID，并提供“恢复内置”按钮。
- 设置页的 Client ID 字段在有内置 ID 时改为“可选”。界面任何地方都不显示内置 ID 的值。

公开仓库守护：
- 新增 `scripts/check-public-secrets.mjs`，接入 `npm run check`。
- 规则 1：client-id 类键名后面出现 GUID 就失败，重复字符的测试夹具（1111… 这种）除外；输出里只给出文件、行号和键名，不打印值。
- 规则 2：跟踪文件里或提交历史里出现 `.cargo/` 或 `src-tauri/.cargo/`，就失败。
- 私有模式（`git config voxelight.private true`）跳过规则 2，改为检查：真实 ID 不得出现在 config.toml 以外的任何文件里；任何真实的推送地址也算失败。
- `.gitignore` 加上 `/.cargo/config.toml` 和 `/src-tauri/.cargo/config.toml`。

文档：README 或 docs 里写一份私有仓库的建立、同步和构建步骤（scout D 节），以及 Azure 检查清单（scout E 节）：
- 允许公共客户端流打开；
- 支持个人微软账号；
- 不需要重定向 URI；
- 需要提交 Mojang 审核。

**验收：** scout-client-id.md 的 acceptance 1–18 全部做到，每条都有 RED→GREEN 记录。另外两条：
- 公开仓库从首个提交到现在的全部历史里，`git grep` 搜真实 ID 的结果为空。这一条由审查方用真实 ID 检查，Codex 用守护脚本代替。
- 公开构建下，登录对话框的行为与现在逐项一致。

## R3-2 材质分层：玻璃只给浮在世界上的外框

**决定：** 只有浮在世界上方的外框类控件用液态玻璃（GlassSurface），具体是：导航栏及其活动胶囊、所有弹出菜单和列表弹层、首页的实例选择器、动画选择胶囊。内容面上的按钮、卡片、行、Segmented、面板一律用实底。主操作“启动游戏”用实底强调色。不允许出现第三种“半透明加 blur”的材质。

**修法：** 按 scout-materials.md recommendation 1–12 执行：
- `--surface-panel` 改为不透明；
- 启动按钮去掉 GlassSurface，改为实底 accent，悬停时用 accent-hover；
- 全部 22 个内容页 Select 的弹层改用玻璃，触发器保持实底；
- 实例详情的管理菜单改用玻璃，并像 AnchoredListbox 一样 portal 出去，避免页面淡入淡出期间成为 Backdrop Root；
- toast 改实底；
- 预览胶囊、游戏库命令栏、空态、设置分组、错误代码块里的半透明值，全部改为不透明混色；
- dialog::backdrop 在 Lite、减少透明、高对比三种模式下去掉 blur。

**启动按钮的果冻弹性动画保留**：保留 launchJelly 的 transform，只去掉玻璃。窗口栏不得加 backdrop-filter。

**守护：** 静态测试 `tests/unit/material-tier-guard.test.mjs`，草稿在 scout 目录下；e2e `tests/e2e/material-tiers.spec.ts`，覆盖深浅 × full/Lite × 7 个页面，外加弹层打开、管理菜单打开、toast 出现几种状态。已有测试按 scout 的 (c) 节修改选择器，不得放宽断言。

**停止条件：** 玻璃弹层压在内容页文字上时，浅色或 Lite 下选项文字的对比度如果低于 4.5:1，先停下报告，不要自己给玻璃加底色。

**验收：** scout-materials.md acceptance 1–7。另外附深浅 × full/Lite 的首页、设置页（弹层打开）、游戏库截图，人工确认只有外框是玻璃。

## R3-3 安装 Mod：选择安装位置，必要时引导新建带加载器的实例

**决定：** 在发现页点“安装”时：
- 当前选中的目标兼容，就直接安装，和现在一样一键完成；
- 不兼容，就弹出“选择安装位置”：列出兼容的已有实例，不兼容的实例收在折叠区并注明原因；
- 没有兼容实例时，默认展开“新建实例”：加载器、游戏版本、加载器版本都按这个 Mod 支持的范围预填（优先 Fabric，其次 NeoForge、Forge、Quilt；版本取最新的正式版，按 Mojang 清单排序，不按字符串排序）。确认后，一个“resource”任务依次完成：安装加载器 → 创建实例 → 安装 Mod 及必需前置。整个过程有进度，可以取消；在创建实例之前取消，不会留下实例。

**修法：** 按 scout-mod-install.md recommendation A1–A6、B1–B4 执行：
- 结构化错误码 `resource.loaderRequired`、`resource.noCompatibleVersion`、`resource.versionMissing`、`resource.installAfterCreate`；
- 纯函数规划模块 `resource_targets.rs`；
- 新命令 `resolve_resource_targets`、`create_instance_for_resource`（用 `lock().await`，调用 `install_loader_inner`，不调用 `install_loader` 这个命令）、`get_resource_context`；
- 详情接口在没有目标时不再报错；
- 搜索参数改用真实游戏版本，加上加载器分类；
- 整合包分支移到 `instance.required` 检查之前。

范围：
- CurseForge 这一轮只把旧的报错换成结构化错误码，并给出清楚的文案和“新建实例”入口，不做完整的目标规划。
- 光影只给出加载器提示，不自动安装 Iris。
- 数据包显示“暂不支持”，并附外部页面链接。

**验收：** scout-mod-install.md acceptance 1–20 全部做到，每条都有 RED→GREEN 记录。另外做一次真实 Modrinth 手动验证：只装了原版 1.21.x 时，安装 Fabric API，一个任务完成后 `instances/<id>/mods` 里出现 fabric-api 的 jar；在加载器阶段取消，不留下新实例。报告里附截图。

### R3-3 附加裁定（2026-11-08）：焦点采样排除光标点框层

R3-3 的完整套件只失败了一项：浅色 Full 模式下，“关闭”按钮左侧的焦点对比度为 2.9717。原因是光标点框（`.vx-cursor-halo` 画布）正从上一个目标弹簧移向“关闭”，它的一列深色点正好压在采样线上。点框的外扩距离 OUTSET=6，恰好等于采样距离，所以它停稳后也会落在这条线上。点框是独立的装饰运动层，不属于焦点环的“相邻底色”。因此修订 R2-01 第七次修订的采样口径：
- 每条边上的像素，如果同一帧光标点框画布在该点的 alpha > 0（用现有的 haloPaint 读数），就从中位色的计算里排除，但要记录排除了哪些点、排除了几个。
- 每条边至少保留 50% 的有效像素，不足就判失败，不能因为点被排除完而通过。
- 门槛 3:1、采样距离、参考值、indicator 色值和点框本身的动画一律不改；不准用延长等待或隐藏点框的方式来通过。
- 采样函数要补单测：点框像素会被排除；有效像素低于 50% 时判失败。
- 改完后重跑浅色三模式巡检，以及上次失败的那个站点。

### R3-3 附加裁定二（2026-11-08）：用背景参照帧代替排除

上一条裁定的“排除点框像素，且至少保留 50%”是审查方定得不妥。点框过渡时 alpha 从 6 到 241，几乎盖住整条边：“关闭”左边 38 点里有 20 点被排除，只剩 47%。排除的办法本身行不通，50% 也是随手定的数。改为：
- 焦点环本身的颜色、几何，仍从正常帧读取。
- 相邻底色另取一张“背景参照帧”：正常帧截完后立刻再截一张，截这一张时只把 `.vx-cursor-halo` 画布设为 visibility:hidden，截完马上恢复。产品代码和点框动画都不改，这张图只用来读点框下面的真实底色。
- 每条边的中位色：同一帧点框 alpha 为 0 的像素用正常帧，点框 alpha 大于 0 的像素用背景参照帧的同一位置。记录被替换的点数，以及在两帧都没有点框的像素上两帧的最大差值；该差值超过 8 时，这个站点判为无效，并重截一次。
- 撤销 50% 保留率规则。门槛 3:1、采样距离、参考值、indicator 均不变。
- 补充（2026-11-08）：某个站点的替换数为 0，即点框没有覆盖任何采样点时，没有用到参照帧，两帧差值只记录、不判定，直接用正常帧验收。只有替换数大于 0 的站点，才适用“差值超过 8 判无效、重截一次”的规则。
- 单测覆盖三种情况：点框像素按参照帧取值；没有点框时结果与原算法相同；两帧差值超限时判为无效。

## R3-4 浅色主题下山体可辨

**决定：** 浅色主题首页的世界要能一眼看出是山或岛，同时保持轻盈。深色主题的画面和第二轮的深色闸门保持不变。

**修法：** 按 scout-light-world.md recommendation 1 执行，只在粒子 pass 里加浅色专用的山脊点描：`uLight * uHome * (1-uMask) * (1-P.w) * smoothstep(h) * smoothstep(dist)`，点的尺寸乘以 `(1 + k·ridge)`。uLight=0 时，计算式必须与现在完全一致。调参顺序：先调尺寸系数，再调浅色雾，最后调 alpha。可选的天空网格减淡要受 skyOffset 约束。不得改 presets、tokens、palette() 或任何深色值。只有点描方案达不到门槛时才考虑体素淡墨，而且要先停下报告。

**验收：** 浅色 horizon 1280 和 1050 新增闸门：
- silhouetteDeltaL ≤ −5.0；
- silhouetteTiles ≥ 0.50；
- −14 ≤ silhouetteDeltaL，且 silhouetteFarP05 ≥ 45（防止山体压得太重）；
- |skyOffset| ≤ 1.0；
- 下半区纯白比例 < 0.1%。

已有的浅色闸门不改门槛，全部要通过；深色各项数值与 verify-r4 一致，允许运行噪声。另增加一个浅色 massif 1280 的只记录用例；它的山体如果偏弱，在报告里说明。

着色器源码单测要先失败、再通过。附浅色 1280、1440 首页截图，人工确认右侧远处是一条连续的点描山带，能看到山脊线。如果首次 D3D11 实测后门槛与画面观感明显不符，停下报告，附数据和截图，由审查方和用户调整一次门槛。
