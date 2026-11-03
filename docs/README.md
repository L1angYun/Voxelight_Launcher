# 文档与目录入口

当前界面以 2026-11-03 的转场与统一设计及续作授权为准，背景基础采用 2026-11-01 的结晶世界设计。较早报告保留其原始日期、版本和测试结果，不代表当前版本重新执行过这些验收。

## 当前设计和验证

- [0.6.0 前端统一、性能与完整复核](reports/frontend-completion-0.6.0.md)
- [全部工作项续作计划与授权](superpowers/plans/2026-11-03-frontend-completion.md)
- [结晶世界设计](superpowers/specs/2026-11-01-voxelight-crystal-world-design.md)
- [实施计划与完成状态](superpowers/plans/2026-11-01-voxelight-crystal-world.md)
- [已确认的概念实现](superpowers/reference/2026-11-01-crystal-world-concept.html)
- [实施与自动验收报告](crystal-world-implementation-report.md)
- [0.5.1 前端转场复核](reports/frontend-transitions-0.5.1.md)
- [RTX 实测数据及 Intel 人工验收步骤](world-performance.md)
- [仍有效的液态 UI 设计](superpowers/specs/2026-10-26-voxelight-liquid-ui-design.md)

## 功能和历史记录

- [UI 动作、代码责任与测试映射](ui/feature-inventory.md)
- [2026-10-27 液态 UI／安装器验收](ui/validation.md)
- [0.4／0.5 功能交付历史](migration-status.md)
- [竞品功能研究](launcher-feature-catalog.md)
- [历史原生与安装 smoke 报告](reports/smoke/)
- [0.5.0 发布截图](screenshots/0.5.0/)；[更早未标版本的截图](screenshots/legacy/)

## 项目文件放在哪里

| 目录 | 内容 |
| --- | --- |
| `src/`、`public/` | 前端实现与运行素材 |
| `src-tauri/src/`、`capabilities/`、`icons/`、`installer/` | Rust 实现、权限和安装器源码／资产 |
| `tests/` | 测试源码和必要夹具 |
| `scripts/` | 构建、许可、国际化、源码打包、原生和安装器验证工具 |
| `licenses/` | 必须保留和打包的第三方许可资料 |
| `docs/` | 设计、使用说明、报告和版本截图 |
| `releases/` | 已发布安装包与对应 GPL 源码包，保留历史版本 |
| `src-tauri/target/{debug,release}/` | 当前原生 EXE／DLL、调试符号、许可和安装包；构建时重新产生编译缓存 |
| `src-tauri/gen/` | Tauri 生成的权限 schema，编辑器和 capability 声明会引用 |
| `node_modules/` | 当前开发依赖；不是项目自有源码 |

`test-results/`、`playwright-report/`、`dist/`、Python 缓存和 Cargo 中间文件都是可重建产物。测试截图默认进入 `test-results/`；设置 `VOXELIGHT_E2E_EVIDENCE` 或 `VOXELIGHT_TASK8_EVIDENCE` 可写到项目外，不再把常规测试结果写入设计文档目录。

`scripts/review-ui.mjs` 是旧版视觉矩阵工具，含旧选择器；当前视觉验收使用 `tests/e2e/` 中的 Playwright 用例。已经失效且无调用方的 `capture-preview.mjs` 已从活动脚本中移除，原文件保存在下面的外部归档。

2026-11-02 的目录整理把旧测试／开发数据、历史诊断资料和编译缓存迁至项目外，未删除其中的数据。归档清单及恢复说明：`E:/CodeX/VoxelightLauncher-worklogs/workspace-cleanup/2026-11-02/`。`ui-dev-*` 的配置和 WebView profile 也在归档内；如需继续使用，按清单移回原路径或更新相应启动环境变量。
