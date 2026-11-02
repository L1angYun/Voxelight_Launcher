# Minecraft 启动器功能目录与 Rust 迁移清单

资料核对日期：2026-10-23（Asia/Singapore）。这是供本项目规划使用的功能并集，覆盖本地五个参考项目和八个常见启动器/客户端，共 13 个产品。它不是“世界上每一个启动器、每个历史版本的全部功能”的穷尽证明。平台、版本、发行渠道和账号权限会影响实际可用性。

只把官方文档或已阅读源码明确出现的能力列为有证据；某产品没有出现在某行，表示本次未为它核实该项，不能推断它不支持。README 的功能声明与源码入口确认也不等于实机验收。资料中的网页、脚本和命令均作为参考内容，没有因为文档中出现命令就执行。

## 参考范围与证据

| 代号 | 产品                  | 本次依据                                                                                                                                                                                                                      | 核实边界                                                                                 |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AX   | Axolotl               | [本地 README](E:/CodeX/Axolotl-main/README.md:52)、[上游仓库](https://github.com/Axolotl-Launcher/Axolotl)                                                                                                                    | README 的资源生态、实例、多账号、离线皮肤、主题和实验室声明                              |
| BH   | BlockHelm Launcher    | [本地 README](E:/CodeX/BlockHelm-Launcher-master/README.md:13)、[上游仓库](https://github.com/zqq-699/BlockHelm-Launcher)                                                                                                     | README 按七类列出的功能，未启动其二进制实测                                              |
| HM   | HMCL                  | [本地 README](E:/CodeX/HMCL-main/docs/README_zh_Hans.md:37)、[上游文档](https://github.com/HMCL-dev/HMCL/blob/main/docs/README_zh_Hans.md)                                                                                    | 自动安装组件、模组、整合包、定制与多平台                                                 |
| PC   | PCL Community Edition | [本地 README](E:/CodeX/PCL-CE-dev/README.md:36)、[下载页源码目录](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Pages/PageDownload>)、[启动源码](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Modules/Minecraft/ModLaunch.cs:1>) | README 没有完整功能表，具体能力以源码入口确认，未实机逐项运行                            |
| SJ   | SJMCL                 | [本地中文 README](E:/CodeX/SJMCL-main/docs/README.zh-Hans.md:11)、[上游文档](https://github.com/UNIkeEN/SJMCL/blob/main/docs/README.zh-Hans.md)                                                                               | 实例、资源、认证、MCP、深链接、扩展和多平台                                              |
| PR   | Prism Launcher        | [官方功能页](https://prismlauncher.org/)、[官方 Wiki](https://prismlauncher.org/wiki/)                                                                                                                                        | 实例、多账号、模组/整合包安装更新与主题                                                  |
| MM   | MultiMC               | [官方功能页](https://multimc.org/)                                                                                                                                                                                            | 隔离实例、Java 覆盖、日志、旧版、组件、资源与导入导出                                    |
| AT   | ATLauncher            | [官方 About](https://atlauncher.com/about)、[官网](https://atlauncher.com/)                                                                                                                                                   | 多来源整合包、Java、账号、备份、服务端、资源                                             |
| GD   | GDLauncher            | [官方功能页](https://gdlauncher.com/)                                                                                                                                                                                         | 双来源搜索、依赖、并行下载、Java、组件与分享码                                           |
| MR   | Modrinth App          | [官方 App 功能页](https://modrinth.com/app)                                                                                                                                                                                   | 模组/整合包、导入、分享、网站协同、跨实例设置同步、皮肤选择                              |
| OF   | Minecraft 官方启动器  | [官方下载与 FAQ](https://www.minecraft.net/en-us/download)、[官方皮肤说明](https://www.minecraft.net/en-us/article/what-is-minecraft-skin)                                                                                    | PC 多游戏入口、版本、档案、皮肤、更新；不把网页上笼统的“mod support”解释成第三方模组商店 |
| CF   | CurseForge App        | [官方 App 功能页](https://www.curseforge.com/download/app)、[自定义 Profile 文档](https://support.curseforge.com/support/solutions/articles/9000196904-creating-a-custom-profile)                                             | 资源发现、安装更新、自定义 Profile 与主题；发行形态区别见官网                            |
| FT   | FTB App               | [官方功能页](https://www.feed-the-beast.com/ftb-app)                                                                                                                                                                          | FTB/CurseForge 整合包、版本、模组、Java/内存和服务端安装                                 |

本地五仓库固定版本与更新快照见 [GitHub 项目更新记录](E:/CodeX/tmp/github-project-updates-2026-10-23.md:1)。产品来源与实现授权需要分开看：参考功能不表示可以直接复制对方源码、品牌、客户端 ID 或 API 密钥。

## 1. 游戏版本、安装与启动

| 编号 | 功能                                                      | 已找到的实现证据                                                                                                                                                                                             |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G01  | 下载原版 Minecraft Java 并启动指定版本                    | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)、[OF](https://www.minecraft.net/en-us/download)                                                                                                 |
| G02  | 管理多个互不干扰的游戏版本/实例                           | [PR](https://prismlauncher.org/)、[MM](https://multimc.org/)                                                                                                                                                 |
| G03  | 保留旧版原有的启动兼容方式                                | [MM](https://multimc.org/)                                                                                                                                                                                   |
| G04  | 自动安装 Forge                                            | [HM README](E:/CodeX/HMCL-main/docs/README_zh_Hans.md:37)、[GD](https://gdlauncher.com/)                                                                                                                     |
| G05  | 自动安装 NeoForge                                         | [HM README](E:/CodeX/HMCL-main/docs/README_zh_Hans.md:37)、[FT](https://www.feed-the-beast.com/ftb-app)                                                                                                      |
| G06  | 自动安装 Fabric                                           | [MM](https://multimc.org/)、[BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)                                                                                                                     |
| G07  | 自动安装 Quilt                                            | [MM](https://multimc.org/)、[GD](https://gdlauncher.com/)                                                                                                                                                    |
| G08  | 安装 OptiFine                                             | [HM README](E:/CodeX/HMCL-main/docs/README_zh_Hans.md:37)、[PC 下载入口](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Pages/PageDownload/PageDownloadOptiFine.xaml.cs:1>)                                     |
| G09  | 安装 LiteLoader、Legacy Fabric、Cleanroom 等旧版/专门组件 | [HM README](E:/CodeX/HMCL-main/docs/README_zh_Hans.md:37)、[PC 下载目录](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Pages/PageDownload>)                                                                    |
| G10  | LabyMod 专门安装入口与启动兼容处理                        | [PC 下载入口](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Pages/PageDownload/PageDownloadLabyMod.xaml.cs:1>)、[PC 启动处理](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Modules/Minecraft/ModLaunch.cs:995>) |
| G11  | 检查缺失/损坏文件并自动补全                               | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)                                                                                                                                                 |
| G12  | 显示启动阶段、进度、最终状态                              | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)                                                                                                                                                 |
| G13  | 强制终止崩溃或无响应的游戏进程                            | [MM](https://multimc.org/)                                                                                                                                                                                   |
| G14  | 官方 Java/Bedrock 等 PC 游戏的统一入口                    | [OF](https://www.minecraft.net/en-us/download)；具体游戏取决于平台和购买权限                                                                                                                                 |

## 2. 账号、认证与角色

| 编号 | 功能                                | 已找到的实现证据                                                                                                                                              |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01  | Microsoft 正版账号登录              | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:33)、[SJ README](E:/CodeX/SJMCL-main/docs/README.zh-Hans.md:11)                                      |
| A02  | 管理多个账号并切换当前账号          | [PR](https://prismlauncher.org/)、[AT](https://atlauncher.com/about)                                                                                          |
| A03  | 创建离线角色                        | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:33)、[AX README](E:/CodeX/Axolotl-main/README.md:52)                                                 |
| A04  | Authlib/Yggdrasil 第三方认证        | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:33)、[PC 启动处理](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Modules/Minecraft/ModLaunch.cs:1570>) |
| A05  | Yggdrasil Connect 的 OAuth 认证流程 | [SJ README](E:/CodeX/SJMCL-main/docs/README.zh-Hans.md:11)                                                                                                    |
| A06  | 离线 UUID 的不同生成方式            | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:33)                                                                                                  |
| A07  | 角色重命名、头像、皮肤与披风管理    | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:33)                                                                                                  |
| A08  | 正版皮肤选择和 PNG 皮肤导入         | [OF 官方说明](https://www.minecraft.net/en-us/article/what-is-minecraft-skin)、[MR](https://modrinth.com/app)                                                 |

AT 官网还保留 Mojang 账号的历史表述，本清单不据此承诺旧 Mojang 认证在今天仍能用于正常登录。

## 3. 实例、目录与参数

| 编号 | 功能                                     | 已找到的实现证据                                                                                           |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| I01  | 创建、命名、删除实例                     | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:24)                                               |
| I02  | 为不同实例隔离 mods、配置、存档和资源    | [MM](https://multimc.org/)、[PR](https://prismlauncher.org/)                                               |
| I03  | 管理多个游戏目录并汇总实例               | [SJ README](E:/CodeX/SJMCL-main/docs/README.zh-Hans.md:11)                                                 |
| I04  | 实例覆盖全局设置                         | [MM](https://multimc.org/)                                                                                 |
| I05  | 每实例 Java 路径与版本                   | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:24)、[FT](https://www.feed-the-beast.com/ftb-app) |
| I06  | 每实例内存配置                           | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:24)、[FT](https://www.feed-the-beast.com/ftb-app) |
| I07  | 每实例游戏窗口设置                       | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:24)                                               |
| I08  | 自定义 JVM/游戏启动参数                  | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:24)、[MM](https://multimc.org/)                   |
| I09  | 启动前与退出后的命令                     | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:24)                                               |
| I10  | 备份和恢复实例，设置备份目录             | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:24)                                               |
| I11  | 导入已有游戏目录或其它启动器实例         | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:24)、[MR](https://modrinth.com/app)               |
| I12  | 实例导入导出，供迁移与分享               | [MM](https://multimc.org/)                                                                                 |
| I13  | 同一整合包安装多个版本/副本              | [AT](https://atlauncher.com/about)、[FT](https://www.feed-the-beast.com/ftb-app)                           |
| I14  | 跨实例同步游戏设置、服务器列表和资源包等 | [MR App 功能与更新](https://modrinth.com/app)；同步内容与行为以其当前版本说明为准                          |

## 4. Java 与运行环境

| 编号 | 功能                                                     | 已找到的实现证据                                                                               |
| ---- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| J01  | 自动发现已安装 Java                                      | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:66)                                   |
| J02  | 自动下载、管理 Java                                      | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:66)、[GD](https://gdlauncher.com/)    |
| J03  | 手动导入本地 Java                                        | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:66)                                   |
| J04  | 为版本/整合包自动选择适合的 Java                         | [AT](https://atlauncher.com/about)、[GD](https://gdlauncher.com/)                              |
| J05  | 对旧 Forge、OptiFine、Cleanroom 等应用细分 Java 兼容限制 | [PC 启动源码](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Modules/Minecraft/ModLaunch.cs:892>) |
| J06  | 全局 Java 设置与实例覆盖                                 | [MM](https://multimc.org/)                                                                     |
| J07  | 整合包推荐内存与实例自定义内存                           | [FT](https://www.feed-the-beast.com/ftb-app)                                                   |

## 5. 下载、来源与资源发现

| 编号 | 功能                                       | 已找到的实现证据                                                                                           |
| ---- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| D01  | 查看和管理下载任务                         | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)                                               |
| D02  | 配置下载源                                 | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)                                               |
| D03  | 配置并发线程、并行下载                     | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)、[GD](https://gdlauncher.com/)                |
| D04  | 限制下载速度/控制安装下载速率              | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)、[FT](https://www.feed-the-beast.com/ftb-app) |
| D05  | Modrinth/CurseForge 双资源源               | [AX README](E:/CodeX/Axolotl-main/README.md:52)、[PR](https://prismlauncher.org/)                          |
| D06  | 同时搜索两个内容平台                       | [GD](https://gdlauncher.com/)                                                                              |
| D07  | 按游戏版本、加载器、分类、来源筛选         | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:42)                                               |
| D08  | 查看项目详情、可下载版本、依赖             | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:42)                                               |
| D09  | 从网站跳转桌面客户端，或通过深链接触发动作 | [MR](https://modrinth.com/app)、[SJ README](E:/CodeX/SJMCL-main/docs/README.zh-Hans.md:11)                 |

## 6. 模组、资源包、光影与世界

| 编号 | 功能                                 | 已找到的实现证据                                                                                                                       |
| ---- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| R01  | 搜索、下载和安装单个模组             | [PR](https://prismlauncher.org/)、[CF](https://www.curseforge.com/download/app)                                                        |
| R02  | 检查并更新已安装模组                 | [PR](https://prismlauncher.org/)、[MR](https://modrinth.com/app)                                                                       |
| R03  | 卸载模组                             | [MR](https://modrinth.com/app)、[FT](https://www.feed-the-beast.com/ftb-app)                                                           |
| R04  | 识别缺少的模组依赖并辅助安装         | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:42)                                                                           |
| R05  | 自动处理资源安装依赖                 | [GD](https://gdlauncher.com/)                                                                                                          |
| R06  | 拖放导入本地模组、资源等内容         | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:42)                                                                           |
| R07  | 搜索本地内容                         | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:42)                                                                           |
| R08  | 批量启用、禁用、删除内容             | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:42)                                                                           |
| R09  | 浏览/安装资源包                      | [AT](https://atlauncher.com/about)、[AX README](E:/CodeX/Axolotl-main/README.md:52)                                                    |
| R10  | 浏览/安装光影包                      | [AX README](E:/CodeX/Axolotl-main/README.md:52)、[BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:42)                          |
| R11  | 浏览/安装地图与世界                  | [AT](https://atlauncher.com/about)、[BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:42)                                       |
| R12  | 管理存档、资源包、截图和其它实例资源 | [SJ README](E:/CodeX/SJMCL-main/docs/README.zh-Hans.md:11)、[MM](https://multimc.org/)                                                 |
| R13  | 下载数据包的专门入口                 | [PC 下载入口](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Pages/PageDownload/Comp/PageDownloadDataPack.xaml.cs:1>)；这里只确认源码入口 |

## 7. 整合包制作、安装与分享

| 编号 | 功能                                  | 已找到的实现证据                                                                                                                                                  |
| ---- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P01  | 搜索并安装 Modrinth 整合包            | [AT](https://atlauncher.com/about)、[MR](https://modrinth.com/app)                                                                                                |
| P02  | 搜索并安装 CurseForge 整合包          | [PR](https://prismlauncher.org/)、[FT](https://www.feed-the-beast.com/ftb-app)                                                                                    |
| P03  | 安装 ATLauncher、Technic 等来源整合包 | [AT](https://atlauncher.com/about)、[MM](https://multimc.org/)                                                                                                    |
| P04  | FTB 整合包及其新版本                  | [FT](https://www.feed-the-beast.com/ftb-app)；[AT 官网](https://atlauncher.com/)也公布了恢复 FTB 支持                                                             |
| P05  | 导入本地整合包归档                    | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:50)、[PC 导入实现](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Modules/Minecraft/ModModpack.cs:1>)       |
| P06  | 更新已安装整合包                      | [PR](https://prismlauncher.org/)、[FT](https://www.feed-the-beast.com/ftb-app)                                                                                    |
| P07  | 创建自定义整合包                      | [FT](https://www.feed-the-beast.com/ftb-app)、[CF 自定义 Profile](https://support.curseforge.com/support/solutions/articles/9000196904-creating-a-custom-profile) |
| P08  | 导出实例为整合包                      | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:50)、[HM README](E:/CodeX/HMCL-main/docs/README_zh_Hans.md:37)                                           |
| P09  | 分享/发布整合包                       | [MR](https://modrinth.com/app)、[FT](https://www.feed-the-beast.com/ftb-app)                                                                                      |
| P10  | 使用云端分享码复现朋友的实例配置      | [GD](https://gdlauncher.com/)                                                                                                                                     |
| P11  | 提示用户手动补齐限制分发的文件        | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:50)                                                                                                      |

FTB 官网关于“最快获取官方包”的表述不等于所有其它启动器永久无法安装 FTB 包；ATLauncher 已公开宣布恢复 FTB 包入口。导入、联网安装和平台合作权限应分别核对。

## 8. 服务端、联机与备份

| 编号 | 功能                           | 已找到的实现证据                                                                                           |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| S01  | 将支持的整合包部署成独立服务端 | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:50)、[FT](https://www.feed-the-beast.com/ftb-app) |
| S02  | 从启动器创建和运行整合包服务端 | [AT](https://atlauncher.com/about)                                                                         |
| S03  | 服务端图形安装或命令行安装     | [FT](https://www.feed-the-beast.com/ftb-app)                                                               |
| S04  | 自动发现本机已开放的 LAN 世界  | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:57)                                               |
| S05  | 创建跨网络联机房间与加入码     | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:57)                                               |
| S06  | 查看联机房间成员和状态         | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:57)                                               |
| S07  | 一键备份存档                   | [AT](https://atlauncher.com/about)                                                                         |

## 9. 日志、诊断与可靠性

| 编号 | 功能                             | 已找到的实现证据                                                                            |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| L01  | 查看游戏日志与相关实例信息       | [MM](https://multimc.org/)                                                                  |
| L02  | 带颜色和额外诊断信息的日志       | [MM](https://multimc.org/)                                                                  |
| L03  | 启动失败原因分析                 | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)                                |
| L04  | 生成诊断报告                     | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)                                |
| L05  | 文件损坏识别与修复               | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:17)                                |
| L06  | 内容平台提供的安全检查和版本管理 | [CF](https://www.curseforge.com/download/app)；这是平台功能声明，不是“所有模组都安全”的保证 |

## 10. 界面、平台与扩展

| 编号 | 功能                                        | 已找到的实现证据                                                                                                                                            |
| ---- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U01  | 深色、浅色、跟随系统主题                    | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:66)、[PC 设置页](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Pages/PageSetup/PageSetupUI.xaml:54>) |
| U02  | 自定义主题色                                | [AX README](E:/CodeX/Axolotl-main/README.md:60)、[BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:66)                                               |
| U03  | 图片背景、透明/亚克力/模糊视觉选项          | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:66)、[PC 设置页](<E:/CodeX/PCL-CE-dev/Plain Craft Launcher 2/Pages/PageSetup/PageSetupUI.xaml:75>) |
| U04  | 自定义主题与菜单                            | [PR](https://prismlauncher.org/)                                                                                                                            |
| U05  | 简体中文、繁体中文、英文、日文等多语言      | [BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:66)                                                                                                |
| U06  | Windows、macOS、Linux 版本                  | [PR](https://prismlauncher.org/)、[SJ README](E:/CodeX/SJMCL-main/docs/README.zh-Hans.md:41)                                                                |
| U07  | ARM、RISC-V、MIPS、LoongArch 等额外架构适配 | [HM README](E:/CodeX/HMCL-main/docs/README_zh_Hans.md:37)；具体支持程度需看其平台表                                                                         |
| U08  | 启动器自身更新                              | [OF](https://www.minecraft.net/en-us/download)、[BH README](E:/CodeX/BlockHelm-Launcher-master/README.md:66)                                                |
| U09  | 带签名校验的桌面自动更新                    | [AX README](E:/CodeX/Axolotl-main/README.md:67)                                                                                                             |
| U10  | 扩展/插件系统                               | [SJ README](E:/CodeX/SJMCL-main/docs/README.zh-Hans.md:11)                                                                                                  |
| U11  | MCP 服务，与外部 Agent 协作                 | [SJ README](E:/CodeX/SJMCL-main/docs/README.zh-Hans.md:11)                                                                                                  |
| U12  | 实验室工具，例如种子地图、投影工坊          | [AX README](E:/CodeX/Axolotl-main/README.md:60)                                                                                                             |

PCL-CE 的 macOS/Linux“可交叉编译”不能写成“有可运行的跨平台客户端”；它的 README 明确区分这两者。第三方启动器的 Java 版功能也不能据此算成 Bedrock 支持。

## Voxelight Launcher 的实现与验证边界

### 0.5.0 当前实现与验证

当前项目只包含 Rust、Tauri 2、React 和 TypeScript 实现，不构建或维护 WinUI/C# 版本。0.5.0 的测试与实机结果以 `docs/migration-status.md`、`docs/reports/smoke/release-0.5.0-smoke-report.json` 和 `docs/reports/smoke/install-0.5.0-smoke-report.json` 为准；下列内容不把局部测试扩大解释为所有环境均已验证。

| 能力组                     | 当前实现与 0.5.0 验证                                                                                                                                                                          | 尚未覆盖的边界                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 原创界面与当前账号角色     | 原创 WorldScene、双栏任务式首页和分组页面已接通；首页优先显示当前账号的皮肤、模型和披风，无账号或资料失败时明确区分默认预览与重试状态。56 项前端单元测试、19 项浏览器测试通过；42 张新版截图已检查 | 不同 DPI、高清皮肤和第三方渲染环境的差异不能由一次截图排除；本地预览不等于上传或修改正版皮肤   |
| 动效与皮肤兼容             | 保留场景入场、环境和启动状态动效，并验证减少动态效果、离屏暂停、WebGL 生命周期、64×32 旧皮肤及损坏 PNG 恢复。Steve / Alex 可主动选择并从已校验客户端读取                                                             | 在线皮肤依赖实际账号和远程服务；未穷尽所有显卡、WebView2 和第三方皮肤组合                       |
| 下载来源与缓存             | `official`、`auto`、`bmclapi` 三种模式已接入支持的 vanilla 清单、客户端、库、assets、日志配置、Java 和服务端文件；保留官方 URL/预期 SHA-1、候选回退、固定哈希重定向限制及离线缓存             | 不为 Quilt、Modrinth、CurseForge、OptiFine 或任意 Maven 主机虚构镜像；镜像清单哈希不是 Mojang 独立背书 |
| 实例与四类加载器           | 同一实例在后端防止重复启动，不同实例可运行相同版本；Fabric、Quilt、Forge、NeoForge 及旧版 NeoForge 的官方安装、真实 Java 渲染和运行保护由完整原生报告逐项记录                                | OptiFine 尚未实现；少数版本的成功不代表所有 Minecraft、Java、加载器和模组组合均兼容             |
| 资源、世界与服务端         | Modrinth 依赖、更新与回滚，实例克隆/备份、基础 mrpack、世界 NBT/ZIP/PNG、服务器 NBT、本地协议、下载控制和 EULA 拒绝启动均纳入 0.5.0 原生验收                                               | 真实个人存档、公开大型整合包和真实服务端未纳入本次验收；测试没有代替用户接受 EULA               |
| 许可、隐私与安装           | 项目源码及原创资源采用 GPL-3.0-only；706 个第三方包、1,126 份通知已核对。安装包携带许可资源；Windows DPAPI、注册信息、正常完整性标签及默认卸载的数据保留已检查                               | 安装程序未做受信任代码签名；仅验收 Windows x64。Microsoft、CurseForge 和第三方认证仍需用户授权 |

### 0.4.0 历史基线

当前项目只包含 Rust、Tauri 2、React 和 TypeScript 实现，不构建或维护 WinUI/C# 版本。旧目录仅作为独立的恢复来源，不自动导入旧账号、令牌、实例或设置。功能是否存在，必须分别检查界面、IPC、真实文件和真实进程，不能由竞品清单或同名源码文件推断。

| 能力组                         | 已核实的实现与测试                                                                                                                          | 尚未覆盖的边界                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| React 界面与 WebGL 皮肤        | 0.4.0 当时接入 Magic UI、Aceternity 效果和 skinview3d，并在桌面 WebView2 中显示 3D 角色；前端单元与浏览器回归通过。0.5.0 已移除 Aceternity，当前实现见上节 | 不同 DPI、高清皮肤和第三方渲染环境的差异不能由一次截图排除                                 |
| 旧皮肤与交互                   | 64×32 双腿、损坏 PNG 恢复、减少动态效果、手动旋转缩放、反复切页均有专项回归                                                                 | 在线皮肤依赖实际账号和远程服务；本地预览不等于上传正版皮肤                                 |
| 游戏安装与启动                 | 原版文件校验、Java 检测与下载、独立实例、参数继承、日志和进程管理已实现；已进行真实 Java 渲染验证                                           | 不把少数版本的成功解释为所有 Minecraft、Java 和模组组合均兼容                              |
| Fabric、Quilt、Forge、NeoForge | 0.4.0 的历史验收版本为 Fabric 0.20.1、Quilt 0.30.1、Forge 47.4.28、NeoForge 21.1.264 和旧版 47.1.106；当时均已分别实际启动并通过运行中实例保护。0.5.0 的当前版本见上节 | OptiFine 尚未实现；旧版、专门加载器和更多版本仍需逐项验证                                  |
| 账号与配置                     | 离线角色可创建；凭据使用 Windows DPAPI；Microsoft、第三方认证的接口和取消/竞态测试已实现                                                    | Microsoft OAuth 与第三方授权需要用户配置和实际授权，未宣称已完成实机登录；不自动迁移旧凭据 |
| Modrinth 资源事务              | 哈希识别、兼容性和必需依赖、SHA-512、更新记录与回滚已接通；界面更新及回滚已执行；断流后有界重试通过本地三次请求专项测试                     | 更复杂的依赖组合和长期真实使用仍需回归；CurseForge 不是 Modrinth 的替代品                  |
| 实例、世界与整合包             | 克隆、备份恢复、运行保护、世界和截图管理、基础 mrpack 导入导出已用隔离测试文件验证                                                          | 真实个人存档、其它启动器全量实例格式和公开整合包的兼容性不能由小型测试包证明               |
| 下载与服务端                   | 暂停、恢复、排队取消、活动任务取消和后续任务通过；官方服务端 JAR 校验及 EULA 拒绝启动通过                                                   | 控制台目前用受控测试进程验证；没有替用户接受 EULA，也没有宣称真实服务端已启动              |
| 诊断与多人联机                 | 游戏日志、进程退出、常见错误诊断、服务器 NBT 与本地协议查询已实现                                                                           | 实际服务器联机、房间、跨实例同步、分享码、插件/MCP 和实验室工具未完成                      |
| 数据与安装                     | 默认数据目录与安装目录分离；便携测试目录与真实账号隔离；NSIS 当前用户安装、升级和默认卸载的数据保留已通过专项检查                           | 本次仅验收 Windows x64；其它平台及所有版本、模组组合不在本次覆盖范围                       |

### 后续实施边界

1. **OptiFine 与更多下载来源。** OptiFine 尚未实现。0.5.0 已接通 BMCLAPI 候选、回退与校验，但不支持 Quilt、Modrinth、CurseForge、OptiFine 或任意 Maven 主机的镜像；镜像清单的哈希属于该镜像信任链，不能当作 Mojang 独立背书。
2. **授权和外部服务。** Microsoft OAuth、CurseForge API Key、第三方认证及公开整合包仍需用户凭据和真实服务验收。
3. **更多启动器能力。** 多游戏目录汇总、批量操作、跨实例同步、分享码、启动钩子、完整国际化、房间联机和扩展平台没有因列入目录而自动纳入完成范围。
4. **维护 WinUI 不在本项目范围内。** 本项目不复用旧 C# 的进程作为启动代理，也不要求安装 WinUI 运行时。

此优先级和状态只描述 Voxelight Launcher，不是对其它产品质量的排名。最终交付状态以 README、`docs/migration-status.md`、构建/测试结果和真实桌面验收记录为准。
