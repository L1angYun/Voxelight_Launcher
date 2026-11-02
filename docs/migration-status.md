# Voxelight Launcher 交付状态

核对日期：2026-10-25。本文区分已实现、已通过测试和仍待验收的能力，不把竞品功能目录当作完成清单。0.4.0 的历史验收原样保留，不代替 0.5.0 的验证。

## 0.5.0 已完成的验证

- 全新原创 WorldScene、双栏任务式首页和全应用排版已重做；深色/浅色和 1050/1440/1920 宽度已截图检查，减少动态效果与离屏暂停已验证。
- 前端 56 项单元测试、19 项浏览器测试通过，生产构建通过，包括旧版皮肤、损坏 PNG 恢复、反复切页、弹窗键盘焦点及 Steve / Alex 实际像素渲染。
- Steve / Alex 为可选默认角色，后端通过官方 manifest v2 和客户端 SHA-1/大小校验后读取精确 JAR 条目。
- Rust 105 项测试通过、0 失败，另有一个默认忽略的真实网络专项已显式验证 Mojang 26.3 元数据及 41,483,720 字节客户端 SHA-1。Rust 格式检查和 Release/NSIS 桌面构建通过。
- BMCLAPI 候选顺序、固定预期哈希、文件提交、缓存和同实例防重复启动已有本地测试；最终安装包内 EXE 已进一步完成真实镜像下载和完整桌面原生验收，官方回退路径保留。

### 最终原生与安装验收

- [19 项完整原生验收](reports/smoke/release-0.5.0-smoke-report.json)全部通过，0 失败、0 个 WebView 运行时错误。测试对象为最终 NSIS 安装包内 EXE，SHA-256 为 `3481a7663cbe5af32b17048ba5b946ab1021191fe52bbfbb130a8215445f24bc`。
- Fabric 0.20.1、Quilt 0.30.1、NeoForge 21.1.265、旧版 NeoForge 47.1.106 和 Forge 47.4.28 均完成官方安装与真实 Java 渲染；每组均有 6 项运行中实例保护及退出后重启记录。BMCLAPI、Steve/Alex、同版本独立实例、Modrinth 界面更新与回滚、下载控制、官方服务端 JAR 和 EULA 拒绝启动也在同一轮通过。
- [安装、许可资源与卸载检查](reports/smoke/install-0.5.0-smoke-report.json)通过。安装包 SHA-256 为 `1e3059f00ec69de5be3d1959b022304d302b38390cd08bd2d011713d99b458cd`；签名状态为 `NotSigned`，无 Low 完整性标签，1,126 份第三方通知验证通过。

## 项目边界

- 本目录只维护 Rust、Tauri 2、React 和 TypeScript 应用；WinUI/C# 不在当前项目中。
- 默认数据目录为 `%LOCALAPPDATA%\dev.voxelight.launcher`，与 NSIS 当前用户安装目录 `%LOCALAPPDATA%\Voxelight Launcher` 分离。
- 不自动迁移其它启动器的账号、令牌、实例或设置。`VOXELIGHT_LAUNCHER_DATA_DIR` 和 `VOXELIGHT_LAUNCHER_GAME_DIR` 可显式指定隔离目录。
- 桌面测试使用离线测试角色、隔离游戏文件和本地测试替身。没有复制个人存档或凭据，没有替用户接受安全警告或服务端 EULA。
- 0.5.0 仍未实现 OptiFine；Microsoft OAuth、CurseForge API Key 和第三方认证需要用户配置与授权，未做真实授权验收。真实 Minecraft 服务端未启动，更多未验证边界见功能对照文档。

## 0.4.0 历史基线

## 已验证的实现

- 官方版本安装、Java 检测与选择、实例隔离、继承参数、日志与进程管理。
- Fabric 0.20.1、Quilt 0.30.1、Forge 47.4.28、NeoForge 21.1.264 和 NeoForge 47.1.106：在最终安装的 Release 中分别完成官方安装和真实 Java 渲染，运行中的备份、克隆、恢复、导出和删除均被保护。
- Modrinth 资源识别、必需依赖、SHA-512、更新记录与回滚；真实界面已执行一次更新及回滚。第二次下载曾中断，因此加入有界重试和独立临时文件；本地“断流两次、第三次成功”测试已验证三次请求、最终内容和临时文件清理。
- 实例克隆、备份恢复、基础 mrpack 导入导出、世界 NBT/ZIP、PNG 预览、服务器 NBT 与本地协议查询，均使用隔离测试文件。
- 下载暂停、恢复、排队取消、活动取消及后续任务；官方服务端 JAR 校验、`eula=false` 和未同意时拒绝启动。
- 数据目录与安装目录的分离有 Rust 单元测试。Windows Low 文件标签的根因已定位；同一未签名 Debug 程序在不继承 Low 标签的位置可正常启动 Fabric，不要求用自签名或修改 ACL 来规避。
- 非 UTF-8 的进程日志不再导致安装器或游戏日志读取中断。旧版 NeoForge 已完成[安装器与实际启动专项验收](reports/smoke/legacy-neoforge-smoke-report.json)，官方安装器退出状态、生成文件和启动结果仍分别校验。

## 当前验证基线

- 前端：31 项单元测试、6 项浏览器测试通过。
- Rust：76 项通过，另有 1 项默认忽略的真实网络专项已显式运行通过：Mojang 26.3 元数据和 41,483,720 字节客户端 JAR 的 SHA-1 与缓存复用验证。该专项不等同于启动 26.3。
- Rust 格式检查、前端构建通过。构建仍有未使用代码警告，不是无警告构建。
- 原生 Modrinth 更新/回滚、后续变化保护和桌面确认权限已通过[专项验收](reports/smoke/debug-focused-smoke-report.json)，桌面皮肤无运行时错误。
- 最终安装的 Release 已通过[16 项完整原生验收](reports/smoke/release-smoke-report.json)，五组加载器均有实际渲染证据；[安装、升级与默认卸载检查](reports/smoke/install-smoke-report.json)也已通过。历史失败报告不作为成功依据。

### 0.4.0 时尚未完成或不能宣称已验证（历史记录）

- OptiFine 尚未实现；BMCLAPI 选项尚未接入实际下载镜像。
- Microsoft OAuth、CurseForge API Key 和第三方认证需要用户配置与授权，未进行真实账号登录验收。
- 真实 Minecraft 服务端尚未启动；控制台和停止目前用受控测试进程验证，EULA 未由测试代为接受。
- 公开大型整合包、其它启动器实例格式、真实个人存档、所有 Java/Minecraft/模组组合的兼容性未穷尽验证。
- 多游戏目录汇总、跨实例同步、分享码、启动前后钩子、完整国际化、房间联机、插件/MCP 和实验室功能未完成。

## Windows 构建与运行位置

`E:\CodeX` 的继承 Low 完整性标签会使构建出的 EXE 和它的 Java 子进程以 Low 运行，进而导致 Fabric/Quilt 重映射及普通临时文件写入失败。不要修改工作区标签、ACL 或系统安全策略来规避。使用正常的开发输出位置或标准安装位置，并对最终 EXE 检查标签；自签名不能清除文件标签。

## 功能对照

`docs/launcher-feature-catalog.md` 是 13 款启动器/客户端的功能并集研究，不是 Voxelight Launcher 已全部实现这些功能的声明。
