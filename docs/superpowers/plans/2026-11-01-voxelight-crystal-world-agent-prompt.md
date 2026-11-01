你要在 Voxelight Launcher 中实现“结晶世界背景”：用 WebGL2 替换现有的 Canvas 2D 方块墙，默认外观为地平线场景 + 点阵材质，并让背景响应真实启动进度。

仓库：`E:\CodeX\VoxelightLauncher`（React 19、TypeScript、Tauri 2、Rust）

开始前完整阅读这些文件：

1. 设计文档：`docs/superpowers/specs/2026-11-01-voxelight-crystal-world-design.md`
2. 实施计划：`docs/superpowers/plans/2026-11-01-voxelight-crystal-world.md`
3. 参考代码：`docs/superpowers/reference/2026-11-01-crystal-world-concept.html`
4. 仍然有效的上一版设计：`docs/superpowers/specs/2026-10-26-voxelight-liquid-ui-design.md`
5. 点阵设计规范和粒子实现：`E:\CodeX\design-systems-main\lattice\DESIGN.md`、`E:\CodeX\design-systems-main\lattice\src\gl\field.js`

优先级：设计文档 > 实施计划 > 参考代码。参考代码是已确认观感的单文件概念实现，可以运行查看，也可以移植其中的 GLSL、常量和算法，但不要照搬结构。它与设计文档的已知差异写在计划开头。计划末尾的附录汇总了主要渲染参数。如果文档之间有冲突，或计划与实际代码不符，先告诉我，不要自行选一边。

计划开头提到的 superpowers 技能是可选的。你的环境没有这些技能时，直接按计划的步骤逐项执行。

开始前：

- 设计文档、实施计划和参考代码可能还没有提交，请确认它们存在。
- 工作区可能有未提交的改动，涉及 `WorldScene.tsx`、`App.tsx`、`HomePage.tsx` 等文件。不要提交、覆盖或丢弃这些改动。如果它们还在，停下来告诉我，等我处理后再继续。
- 工作区干净后，从当前分支创建 `feat/crystal-world`，不要直接在 `master` 或 `main` 上开发。

执行规则：

- 按 Task 1 到 Task 8 的顺序执行，每个任务都先写失败的测试，再实现，再确认通过，然后提交。
- Task 5 末尾的性能检查会影响后续预算。未达到计划中的标准时，把数据告诉我，等我确认后再继续。
- Windows 图形设置（切换显卡）和最后的视觉确认由我来做。到这些步骤时告诉我具体要操作什么，不要修改系统设置。
- 不要修改玻璃系统或全局 `--bg-base`，也不要引入 three.js 依赖。设计文档第 8 节列出的范围外内容不要顺手处理。
- 不要推送，不要创建 PR，除非我要求。
- 不要跳过、删除或放宽测试来让结果通过。计划明确要求改写或删除的测试除外。
- 不要跳过 git hooks。

完成时汇报：

- 每个任务的状态和提交哈希。
- 实际运行的验证命令和结果，包括 `npm test`、`npm run test:e2e`、`npm run build`、`cargo test --manifest-path src-tauri/Cargo.toml`。
- `docs/world-performance.md` 中的实测数据。
- 未完成、未验证或与计划不同的地方，直接写明原因。不要把没有实际运行过的内容说成已通过。
