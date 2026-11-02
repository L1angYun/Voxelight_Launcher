# Voxelight Launcher 液态 UI 与安装体验验证记录

核对日期：2026-10-27（Asia/Singapore）  
版本：0.5.0  
范围：全新 React + Tauri UI、简体中文 / English、`lite / full` 两档特效、Windows 系统外观、定制双语 NSIS 安装器，以及用户后续决定的 Lumen 完整移除。

本文只记录实际执行过的命令和证据。未执行的项目不作为通过项。

## 验证环境与边界

| 项目 | 本次环境 |
| --- | --- |
| OS | Microsoft Windows 11 专业版 Insider Preview，build 26220（10.0.26220） |
| WebView2 | 157.0.4341.16 |
| CPU | Intel Core Ultra 9 275HX |
| 内存 | 31.4 GiB（Windows 报告值） |
| GPU | NVIDIA GeForce RTX 5080 Laptop GPU / Intel Graphics；另有 SudoMaker Virtual Display Adapter |
| 浏览器性能采样 | Playwright Chromium，SwiftShader；不是独立物理低配设备，也不是硬件 GPU 基准 |
| 安装签名 | `NotSigned`，没有进行受信任代码签名 |

没有单独的真实低配验收设备。强制无 WebGL2、上下文丢失和 `lite` 渲染预算检查不能替代低配实机结论。性能数据只描述本次机器和采样窗口，不保证所有 GPU、驱动或低配设备的表现。

## 构建、静态检查与回归

| 命令 | 实际结果 |
| --- | --- |
| `npm test` | 26 个测试文件，145 / 145 通过 |
| `npm run test:e2e` | 49 / 49 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 116 通过、0 失败、1 忽略；忽略项为需要显式运行的官方下载专项 |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 |
| `node scripts/check-i18n.mjs` | 2 个语言包、662 个键、32 个后端错误码、52 个 TSX 文件 |
| `npm run license:check` | 711 个第三方包、1129 份许可通知，声明、排除资源与打包资源均通过 |
| `node scripts/check-installer.mjs` | 五页流程、双语、真实进度、currentUser、原生键盘控件、数据保留、资源与验证脚本均通过 |
| `npm run desktop:build` | release 主程序与 NSIS x64 安装包构建成功；编译保留 6 个既有未使用代码警告，前端有大 chunk 提示 |

最终安装包：

- 文件：`src-tauri/target/release/bundle/nsis/Voxelight Launcher_0.5.0_x64-setup.exe`
- SHA-256：`6C356572A6FFB4563AF57B3992727D9FD08120ACADABCCFB58CF3F0CF58015E9`
- 大小：约 3.75 MiB
- 原生验证副本 SHA-256：`B4A82898975903DE996AB736EA277F99CDB6FA0B29C68BD413C85D20A2F9FE52`

工作区输出继承 Low Mandatory Level。验证时把同一份 setup / exe 复制到当前用户 Temp，先核对 SHA-256，再确认普通完整性标签；没有修改 ACL、完整性标签或系统安全设置。

## Lumen 移除与默认预览

用户决定不再保留 Lumen。最终实现：

- 默认角色只有 Steve / Alex；Steve 仍是新配置默认值。
- `defaultSkin=lumen` 的旧配置在 `migrate_state_json` 中迁移为 Steve，账号和实例数据保留。
- 后端校验、默认角色加载、前端类型、单选入口、素材生成器、两种语言文案和当前文档中的 Lumen 分支均已移除。
- `public/assets/skins/lumen.png` 与 `face.png` 已删除；安装冒烟额外禁止捆绑 `lumen.png` / `face.png`。
- 默认纹理加载失败时返回空预览，不用另一个角色顶替。角色页提供重试或本地导入，首页提供“默认预览暂不可用 / 重试默认预览”。
- RED→GREEN 证据：前端 3 个断言、Rust 3 个断言、浏览器 1 个断言先失败，随后全部通过；首页失败状态另有独立 RED→GREEN 测试。

相关文件：`src/lib/defaultSkin.ts`、`src/features/home/HomePage.tsx`、`src/features/accounts/AppearancePanel.tsx`、`src-tauri/src/storage.rs`、`src-tauri/src/content.rs`。

旧导出预设也通过 `migrate_state_json` 迁移，避免只处理启动状态而遗漏导入路径。`legacy_lumen_preset_migrates_to_steve_and_preserves_other_settings` 验证 Steve、8192 MB 内存和 `lite` 同时保留。有效皮肤 / 披风切换到损坏地址时，`CharacterCanvas` 隐藏旧角色并先清空旧披风，转换回归已覆盖。

## 源码包

`python scripts/package-source.py --output E:\CodeX\tmp\VoxelightLauncher-0.5.0-source-validation.zip` 实际生成并校验：

- 包含 `src/app/App.tsx`、完整 `src-tauri/installer`、双语 NSIS 文件、模板和原创 BMP / ICO。
- ZIP CRC、内嵌清单路径和逐文件 SHA-256 均通过；没有 `lumen.png` 或 `face.png`。
- 最终文件数、字节数和 ZIP SHA-256 见[源码打包日志](../../../VoxelightLauncher-worklogs/workspace-cleanup/2026-11-02/archive/.superpowers/sdd/2026-10-26-voxelight-liquid-ui/review-source-final.log)，避免文档自身被打包后形成哈希自引用。

## 安装器与数据保留

最终安装包执行了以下真实流程：

- `node scripts/smoke-install.mjs`：当前用户静默首装、同版本重装、`/UPDATE` 重装、最后卸载；`/S`、`/D=...`、`/NS` 均覆盖。
- 检查注册版本、主程序版本、普通完整性标签、许可资源、1135 个安装文件及 1129 份许可通知；没有被打包的排除角色素材。
- `owned-install-fixture.txt`、隔离配置 / 游戏数据以及真实数据目录名称在重装和卸载后保持不变。默认卸载未选择删除数据。
- `scripts/verify-installer-ui.ps1` 分别以 English 和 SimpChinese 运行：语言选择、取消、目录输入、Tab / Space 键盘操作、安装文件页、完成页、条件重装、受保护路径失败、最后卸载。
- Program Files 受保护路径产生真实 `Error opening file for writing`；没有请求管理员权限，没有安装受保护目标文件。
- 每种语言保留欢迎、位置、选项、安装、完成、开始菜单-only 重装和权限失败共八张截图。
- English 首次 GUI 安装只创建桌面链接，第二次重装只创建开始菜单链接，并验证第一次链接不变；SimpChinese 执行相同流程。测试结束后恢复测试前链接字节。
- 静默 `/NS` 在首装、重装和卸载后直接比较桌面 / 开始菜单链接的 SHA-256，确认没有创建或修改链接。

证据：

- [English UI 报告](../../../VoxelightLauncher-worklogs/workspace-cleanup/2026-11-02/archive/.superpowers/sdd/2026-10-26-voxelight-liquid-ui/review-final-installer-english/report.json)
- [简体中文 UI 报告](../../../VoxelightLauncher-worklogs/workspace-cleanup/2026-11-02/archive/.superpowers/sdd/2026-10-26-voxelight-liquid-ui/review-final-installer-simpchinese/report.json)
- [静默安装报告](../../../VoxelightLauncher-worklogs/workspace-cleanup/2026-11-02/archive/.superpowers/sdd/2026-10-26-voxelight-liquid-ui/review-final-install-report.json)

安装器基于 `tauri-cli-v2.12.4`（上游提交 `993038c49185307dfc895ab7657d77ca0d5ed7c7`）的 NSIS 模板，保留 Apache-2.0 / MIT 许可和修改说明。详见 `src-tauri/installer/windows/README.md`。

## 原生完整验证

最终二进制副本 SHA-256：`B4A82898975903DE996AB736EA277F99CDB6FA0B29C68BD413C85D20A2F9FE52`。

执行 `node scripts/smoke-native.mjs` 后，完整轮次有 18 项检查通过；Forge 因当时 `maven.minecraftforge.net` / `maven.creeperhost.net` 连接拒绝而失败。随后 `SMOKE_CHECKS="official Forge"` 的专项重试通过，因此 19 个唯一原生检查均有真实通过证据，不把它们写成同一轮 19/19。

- 五组加载器均完成官方安装、真实 Java 渲染、6 项运行中实例保护和退出后重启：Fabric 0.20.1、Quilt 0.30.1、NeoForge 21.1.265、旧版 NeoForge 47.1.106、Forge 47.4.28。
- Steve / Alex 均从 SHA-1 和大小已校验的官方客户端读取 64×64 纹理，没有捆绑其图片。
- 同版本独立实例并发、克隆、备份恢复、基础 mrpack、世界 NBT / ZIP / PNG、服务器 NBT 和本地协议查询均通过。
- Modrinth 真实项目执行 UI 更新及回滚：识别哈希、安装必需前置、SHA-512、保留未知文件、拒绝覆盖后续变化。
- 下载暂停 / 恢复 / 排队取消 / 活动取消及后续任务通过；受管服务端保持 `eula=false`，未同意时拒绝启动，没有替用户接受 EULA。
- 首页场景与角色页没有 WebView 运行时错误；缓存只包含不可变客户端文件，没有复制世界或凭据。

证据：[完整原生报告](../../../VoxelightLauncher-worklogs/workspace-cleanup/2026-11-02/archive/.superpowers/sdd/2026-10-26-voxelight-liquid-ui/review-final-native-report.json)、[Forge 专项重试报告](../../../VoxelightLauncher-worklogs/workspace-cleanup/2026-11-02/archive/.superpowers/sdd/2026-10-26-voxelight-liquid-ui/review-forge-retry-report.json)。

## 视觉矩阵与性能采样

`node scripts/review-ui.mjs` 实际执行并保存：

- 72 个基础场景：2 语言 × 2 主题 × 2 特效档，覆盖各功能页和 1050 / 1440 / 1920 宽度。
- 10 个空状态、16 个长文本 / 200% 伪翻译压力场景、6 个减少动态 / 减少透明 / 高对比度场景，以及 1 个无 WebGL2 回退场景。
- 所有当前场景均无页面横向溢出、缺失图片、旧 UI 或浏览器运行时错误。装饰光圈可以超出自身容器，但 `documentElement.scrollWidth` 不超过视口。
- 输出目录：[voxelight-ui-rework](../../../tmp/voxelight-ui-rework/)。

性能采样在 1440×930 下执行导航与页面切换，每档约 2.4 秒。rAF 间隔包含测试自身的采样调度；长任务包含页面初始化与导航，不应解释为持续稳定帧率。CDP `TaskDuration` 是渲染主线程耗时，不是完整进程 CPU 百分比。

| 语言 | 主题 | 档位 | rAF 平均 / p95 | 长任务 | JS 堆（MiB） |
| --- | --- | --- | --- | --- | --- |
| zh-CN | dark | lite | 24.74 / 33.40 ms | 3 | 37.9 |
| zh-CN | dark | full | 23.24 / 33.40 ms | 3 | 30.7 |
| zh-CN | light | lite | 21.58 / 33.30 ms | 3 | 38.5 |
| zh-CN | light | full | 23.69 / 33.40 ms | 3 | 31.6 |
| en-US | dark | lite | 22.64 / 16.80 ms | 3 | 38.1 |
| en-US | dark | full | 23.53 / 33.40 ms | 3 | 30.6 |
| en-US | light | lite | 22.02 / 16.80 ms | 3 | 38.4 |
| en-US | light | full | 24.00 / 33.40 ms | 3 | 31.4 |

完整帧时间、长任务、CDP 主线程耗时、DOM 节点、动画数和玻璃模式见 [performance.json](../../../tmp/voxelight-ui-rework/performance.json)。这些样本不支持“某档在所有设备上更快”的推断。

## 二十条设计原则的证据

| # | 原则 | 对应实现与证据 |
| --- | --- | --- |
| 1 | 为设计选一种个性 | “方块光学仪器”贯穿首页 WorldScene、GlassSystem、点阵和安装器原创立方体 / 光圈素材；见首页与安装器截图。 |
| 2 | 别着急上色 | `src/design/tokens.css` 先定义灰阶层级，再生成强调色变体；深浅主题截图分别核对。 |
| 3 | 字号并非万能 | 有限字号层级、元数据弱化和操作优先级共同建立层级；首页不把版本号当主标题。 |
| 4 | 弱化来凸显重点 | 次要路径、版本 / Java 元数据使用次文字、间距和位置弱化，启动动作保持唯一主按钮。 |
| 5 | 非必要不用标签 | 首页无英文眉题、宣传语和重复状态卡片；状态由实例名、形状、文本和动作表达。 |
| 6 | 按钮看主次不看含义 | `Button` 的 `variant` 与 `tone` 独立；启动、保存、危险动作按当前任务排序。 |
| 7 | 从过度留白开始 | 1440 / 1920 首页和安装器保留真实空白，没有用宣传卡填满。 |
| 8 | 不必填满屏幕 | 内容最大宽度与宽屏外边距并存；设置正文不无限拉宽。 |
| 9 | 间距有亲疏 | 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 的间距序列；相关控件成组，功能组分离。 |
| 10 | 缩放不总是等比 | 1050×720、1440×930、1920 宽屏分别截图；场景和网格扩展，正文不整体等比放大。 |
| 11 | 行长与行高联动 | 正文行长受最大宽度约束，紧凑控件与阅读文本使用不同行高；长英文压力场景通过。 |
| 12 | 基线对齐，不居中 | 启动控制、字段标签、图标和文本按基线组织，而非只按边界框几何居中。 |
| 13 | 颜色比想象的多 | OKLCH 强调色变体、语义状态、玻璃 / 实色表面和深浅中性色分别定义；系统强调色也经过对比度处理。 |
| 14 | 无障碍也能好看 | 减少动态、减少透明、高对比度、焦点、键盘与语义名称均有测试和截图，视觉语言没有因无障碍被移除。 |
| 15 | 别只靠颜色 | 选中、运行、错误和下载状态同时使用形状、文本、图标、线型或点阵，不依赖单独变色。 |
| 16 | 强调色边框 | 焦点和选中使用强调色边框 / 描边；普通容器不全部加彩色边框。 |
| 17 | 图上文字先处理背景 | `OvertureScene` 使用稳定 scrim，首页深浅主题与场景文字分别验证，不依赖图片碰巧可读。 |
| 18 | 每样东西有适用尺寸 | 角色画布、WorldScene、实例卡片、日志、安装器 164×314 sidebar 与 150×57 header 使用各自尺寸。 |
| 19 | 慎用边框 | 普通卡片主要依靠背景差、阴影和间距；边框保留给焦点、选择和必要分隔。 |
| 20 | 别忽视空状态 | 10 个空状态截图、无实例 / 无账号 / 无资源 / 无结果 / 默认预览失败均有具体状态与恢复动作。 |

## 未扩大解释的项目

- 没有真实 Microsoft 授权、CurseForge 密钥、个人账号或个人存档验收；没有复制真实凭据。
- 没有启动真实外部 Minecraft 服务端，也没有替用户接受 EULA。受管服务端验证保持 `eula=false` 并拒绝未授权启动。
- 没有宣称所有 Minecraft / Java / 加载器 / 模组组合、所有 GPU 或所有低配设备均兼容。
- 历史报告中的 Lumen 仅表示当时状态；当前产品、资源与测试以本记录为准。

## 审查结果与保留边界

独立只读审查未发现已确立的 Critical 问题，提出 5 个 Important 问题，均已处理并重新验证：

1. 源码包旧入口与缺失安装器：更新为 `src/app/App.tsx`，纳入 `src-tauri/installer`，实际 ZIP 验证通过。
2. 旧预设绕过 Lumen 迁移：导入复用 `migrate_state_json`，新增预设回归，完整 Rust 套件通过。
3. 有效到失效纹理转换残留旧角色：加载时隐藏旧角色、先清空旧披风，新增转换测试，完整前端与浏览器套件通过。
4. 快捷方式证据不足：新增桌面-only、开始菜单-only、已有链接与 `/NS` 前后哈希检查，两种语言均通过。
5. 安装器脚本可能假通过：受保护路径必须出现真实错误或非零退出，卸载器必须存在并验证卸载与数据保留，两种语言均通过。

保留为 Minor、未作为完成条件的事项：

- `review-ui.mjs` 对已有 1420 服务没有额外应用身份断言；本次使用项目 Vite 服务和当前源码。
- `smoke-install.mjs` 的超时/失败清理仍可加强；本次成功流程均完成卸载和登记恢复，没有遗留失败清理任务。
- 性能采样没有通过/失败预算，仅作为本地证据，不作为性能保证。

其他路径与实现决策、成本和历史记录见[进度台账](../../../VoxelightLauncher-worklogs/workspace-cleanup/2026-11-02/archive/.superpowers/sdd/2026-10-26-voxelight-liquid-ui/progress.md)。修复后没有重复安排审查代理；按照实施流程，以 RED→GREEN 回归和完整套件作为修正验证。
