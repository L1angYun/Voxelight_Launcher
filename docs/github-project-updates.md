# GitHub 参考项目更新记录

检查日期：2026-10-23（Asia/Singapore）。

5 个项目已更新到下表固定 commit 并完成逐文件 SHA-256 / 符号链接校验。各原目录均先完整复制为快照并验证，之后同步上游新增及变更文件。
没有删除任何本地额外文件，没有执行上游脚本，没有升级依赖，没有构建参考启动器。

| 目录 | 官方仓库 / 分支 | 固定 commit | 更新 | 新增 | 保留额外文件 | 状态 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| PCL-CE-dev | [PCL-Community/PCL-CE](https://github.com/PCL-Community/PCL-CE/tree/dev) / dev | 8f0beaf9315597fdd4cf6171d7e1074e10171be9 | 109 | 46 | 9 | updated_verified |
| BlockHelm-Launcher-master | [zqq-699/BlockHelm-Launcher](https://github.com/zqq-699/BlockHelm-Launcher/tree/master) / master | 027cadf8d56e0525e953f8f44a0bc051673065ed | 329 | 179 | 67 | updated_verified |
| Axolotl-main | [Axolotl-Launcher/Axolotl](https://github.com/Axolotl-Launcher/Axolotl/tree/main) / main | 5893c15253e0eae6851c14a0b6d79abc6f120aee | 967 | 2380 | 2925 | updated_verified |
| HMCL-main | [HMCL-dev/HMCL](https://github.com/HMCL-dev/HMCL/tree/main) / main | 0d20910ea302a907d6a01fec9244ab10d2993d5e | 326 | 159 | 108 | updated_verified |
| SJMCL-main | [UNIkeEN/SJMCL](https://github.com/UNIkeEN/SJMCL/tree/main) / main | 80057af0c6f6262ac4c4ab28b512519fa1f5be9a | 174 | 54 | 22 | updated_verified |

更新前完整快照：

- PCL-CE、BlockHelm、HMCL：E:\CodeX\tmp\github-refresh-2026-10-23\before
- Axolotl、SJMCL（按链接本身备份并验证）：E:\CodeX\tmp\github-refresh-2026-10-23\before-verified

Axolotl 最初普通复制被 packages/ui/AGENTS.md 的失效链接（目标末尾包含换行）阻断；SJMCL 最初普通复制跟随 .claude/skills 目录链接，多出 4 个文件而未通过验证。两者都在覆盖前停止。
随后采用不跟随链接的完整复制，原始链接目标和目录类型逐项验证通过。最初失败快照仍保留在 before，对这两个项目应使用 before-verified。
ZIP 中的实际符号链接已恢复为 Windows 符号链接后同步；不会把链接目标字符串覆盖写入实际目标文件。

逐项目 JSON 清单包含更新前及上游 SHA-256、所有变更路径、保留路径及符号链接信息。summary.json 为汇总。
原始目录均缺少 .git，无法可靠区分旧上游内容和用户本地改动。覆盖文件的旧内容完整保留于快照；只在本地存在的文件或链接仍留在原目录。
因此原目录包含固定 commit 的所有文件，也可能保留上游已经删除的旧文件。这是保留式同步。

回滚：从对应快照复制回原路径，符号链接需按链接本身复制。精确回滚还需参考 JSON 的 added 列表处理本次新增文件，不应盲目清空原目录。

未发现可核实上游的其它目录（career_competition_2026、.mimocode、shots、tmp）未刷新。MinecraftLauncher、Skin3DTest 未修改。
