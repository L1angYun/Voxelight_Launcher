你要改进 Voxelight Launcher 的前端转场和界面一致性。现在切页、开卡、返回、切分区时内容都是一帧硬切，用户觉得生硬、不对味。

仓库：`E:\CodeX\VoxelightLauncher`（React 19、TypeScript、Tauri 2、WebGL2）

开始前完整阅读：

1. 方案：`docs/superpowers/specs/2026-11-03-voxelight-frontend-transitions-and-surfaces.md`
2. 仍然有效的约束：`docs/superpowers/specs/2026-10-26-voxelight-liquid-ui-design.md`、`docs/superpowers/specs/2026-11-01-voxelight-crystal-world-design.md`
3. 转场采集脚本（参考）：`docs/superpowers/reference/2026-11-03-transition-capture.spec.ts`

方案里的行号基于提交 `9d3b641`，动手前先对照实际代码。方案与代码不符，或按方案做会出问题时，告诉我，不要自行另选方案。

开始前：

- 方案和采集脚本可能还没有提交，请确认它们存在。
- 确认工作区除这些文档外没有其它未提交改动。如果有，停下来告诉我，不要提交、覆盖或丢弃。
- 从 `feat/crystal-world` 创建分支 `feat/frontend-transitions`。

范围：

- 这一轮只做方案第 3 节的第 1 项和第 2 项，并按顺序来。
- 第 1 项里的玻璃缓存必须最先做。
- 第 2 项完成后停下，告诉我怎么运行和试手感。等我确认后再做第 3 项及之后的内容。
- 不要提前做第 4 项的世界亮度、第 5 项的页面骨架或第 6 项的浅色主题，即使看到相关问题，也只记录下来。

已定的决定：

- 第 5 节第 1 项“首页构图”未定：保持现有构图，不做贴底控制台。
- 第 5 节第 2 到 5 项按方案默认值执行。其中弹窗和 Toast 用实色这一点，以新方案为准；不要修改 2026-10-26 文档。
- 默认强调色不改。

必须遵守：

- 动效数值只写在 `src/design/motion.ts` 和 `tokens.css`，不要在组件里另写时长或缓动。
- 用已安装的 `motion/react` 和 CSS。不要用 View Transitions，不要加新依赖。
- 所有 layout 节点都写 `layoutDependency`。玻璃元素的祖先不要在淡入中保留 `opacity < 1` 或 `will-change: opacity`，具体见方案“玻璃规则”。
- Lite、减少动态、减少透明、高对比都按方案的降级表实现，并且逐一验证。`useMotionTier()` 要分别返回 `tier` 和 `sceneStatic`。
- 不能破坏键盘路径、焦点恢复、文字选择、窗口拖动。任何动画都不能阻塞启动游戏。
- 保留“点击当前导航项回到顶部”的行为。
- 不要改世界背景架构，不要修改玻璃系统的视觉行为。玻璃缓存只是性能优化。

测试和验证：

- 先写失败的测试，再实现。jsdom 测试要把 motion 时长设为 0，否则退场不会结束。
- 把采集脚本改成仓库内的 `tests/e2e/transitions.spec.ts`。它现在用了绝对路径，输出目录要改到 `test-results/`，fixture 用相对导入。修正 `library-view-toggle-list` 的选择器（`.vx-library` 选不到元素）。
- 新增多实例 fixture。现有 fixture 只有 1 个实例，无法覆盖滚动场景。
- `contentAnimFrames` 查不出 `layoutId` 动画。开卡和返回要逐帧采样身份块的 `getBoundingClientRect`，断言首帧等于卡片位置，且位置连续。
- 按方案第 1、2 项列出的验收条目逐条检查，并保存关键帧。
- 运行 `npm test`、`npm run test:e2e`、`npm run build`。不要跳过、删除或放宽测试来让结果通过。必须改写测试时，说明原因。
- 浏览器预览没有 Tauri 后端，不带 fixture 打开只会看到空实例和 CSS 降级背景，不能作为依据。
- 手感和真实 Tauri 窗口里的效果由我确认。不要声称手感已达标。

提交：

- 每个独立改动一个提交，不要跳过 git hooks。
- 不要推送，不要创建 PR，除非我要求。

完成时汇报：

- 改了什么，每项的提交哈希。
- 实际运行的命令和结果。
- 关键帧或采样数据的位置，以及每条验收条目是否通过。
- 哪些没有验证、与方案有何不同、顺手发现但没有处理的问题。
- 我该如何运行和试手感，重点看哪几个操作。
