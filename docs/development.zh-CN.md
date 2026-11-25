# Voxelight Launcher 开发说明

[English](development.md) | 简体中文

启动器的构建、测试和发布。启动器本身的功能见 [README](../README.zh-CN.md)。

## 环境要求

只支持 Windows x64。

- Node.js 22.13.0 及以上的 22.x，或 24.0.0 及以上（不支持 23）。
- Rust 1.90 及以上（MSVC 工具链），Visual Studio C++ 生成工具和 Windows SDK。
- WebView2 运行时、Git、Windows PowerShell 5.1 和 `icacls`。
- 第一次构建需要联网（npm 包、crate，以及第一次生成安装程序时 Tauri 下载的 NSIS 工具链）。

部分任务另需：

- Python 3.9 及以上，命令名为 `python`：用于 `npm run source:package` 及其测试。Pillow：用于 `scripts/generate-installer-assets.py`。
- `npm run test:e2e` 需要 Playwright 的 Chromium：`npx playwright install chromium`。

## 运行和构建

```powershell
npm ci
npm run desktop:dev                     # 在 127.0.0.1:1420 启动 Vite，再启动 Debug 版程序
npm run desktop:build                   # 生成安装程序和可执行文件
npm run tauri -- build --no-bundle      # 只生成可执行文件
```

- 产物在 `<target>\release\`（`voxelight-launcher.exe`，安装程序在 `bundle\nsis\` 下）。`<target>` 默认是 `src-tauri\target`，`CARGO_TARGET_DIR` 或 Cargo 配置可以改变它；`node scripts/build-runtime.mjs --print-target-dir` 会打印出来。Release 构建启用了 LTO，比较慢。
- `npm run dev` 只启动 Vite 开发服务器，需要自己在浏览器打开 `http://127.0.0.1:1420`。所有后端命令在这里都会失败，只适合调布局。在 Vite 服务器上，网址加 `?stress-locale` 会把所有文字换成加长的伪翻译。
- `scripts\build.ps1` 进行 Release 构建，列出每个产物的大小和 SHA-256 的前 16 位，日志写到 `<target>\build-logs\`。开关：`-NoBundle`（只生成可执行文件）、`-Clean`（先删除 `dist\` 和旧安装包）、`-CloseRunning -CloseRunningPath <确切路径>`（关闭正在运行的该构建产物，最多等 15 秒后结束进程）、`-PrepareSigning`（见[发布](#发布)）。PowerShell 拒绝运行未签名脚本时，改用 `scripts\build.cmd` 加同样的参数；不要修改系统的执行策略。
- `scripts\desktop.ps1 -Action dev|build|check|test|sign` 封装了同样的任务（`check`/`test` 分别运行 `cargo check --locked` / `cargo test --locked`）。
- 构建从不写入 `releases\`，那是[发布](#发布)的步骤。

## 内置凭据

发布版构建时编译进了 Microsoft Client ID 和 CurseForge API Key。直接从仓库克隆构建的版本两者都没有；它照样能运行，用户可以在设置里填写自己的。

| 变量 | 值 |
| --- | --- |
| `VOXELIGHT_MS_CLIENT_ID` | Microsoft 应用注册的 Client ID，必须是 UUID，否则构建失败。 |
| `VOXELIGHT_CF_API_KEY` | CurseForge API Key，`$2a$10$` 后跟 53 个字符。其他格式的值会被忽略。 |

在构建环境里设置，或写进未纳入版本管理的 `src-tauri/.cargo/config.toml` 的 `[env]` 表（Cargo 在 `src-tauri` 下运行）。不要提交它们：如果提交了 `.cargo` 配置或它出现在历史里，或者出现 CurseForge Key、赋给 `VOXELIGHT_MS_CLIENT_ID` 等 Client ID 名称的 UUID，`npm test` 会失败。它认不出单独出现的 Client ID，所以绝不要把 Client ID 粘贴进仓库。

这些值是可执行文件里的常量，拿到程序的人都能读出来。用户在设置里填写的值优先。要确认构建环境会内置它们，在 `src-tauri` 下用与构建相同的变量或配置运行 `cargo test --locked`，并把 `VOXELIGHT_EXPECT_BUILTIN` / `VOXELIGHT_EXPECT_CF_BUILTIN` 设为 `1`（必须内置）或 `0`（不得内置）。这检查的是测试自己的构建，不是已有的可执行文件。

## 低完整性标签

代码目录带有 Windows 低完整性强制标签（Low mandatory label）时，新生成的可执行文件会继承它，并以低完整性启动，无法写入用户数据。npm 和 Tauri 的入口在每次开发启动前、每次构建后，都会把可执行文件自身的标签改为中完整性（Medium）；不需要管理员权限，也不改动目录。

处理较早的构建或复制过来的安装程序：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/repair-build-integrity.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/repair-build-integrity.ps1 -Path '<.exe 的路径>'
```

不带 `-Path` 时，它检查 `src-tauri\target\debug` 和 `release`、其中的 NSIS 安装包，以及 `releases\` 下一层的安装程序，不会去找别处配置的目标目录。以低完整性启动、又打不开数据目录的启动器会说明原因，语言按 Windows 显示语言选择中文或英文。

## 测试与检查

```powershell
npm run build
npm test
Push-Location src-tauri; cargo test --locked; Pop-Location
npm run test:e2e
npm run license:check
```

| 命令 | 作用 |
| --- | --- |
| `npm test` | i18n 检查、设计令牌检查、公开仓库检查、Vitest、Node 单元测试（`tests/unit/*.test.mjs`）。必须在 Git 仓库根目录运行。 |
| `npm run test:e2e` | 用 Playwright 测试 Vite 页面，Tauri IPC 由 `tests/e2e/fixtures.ts` 模拟；一个 worker，软件 WebGL。使用 1420 端口；未设置 `CI` 时复用已在运行的服务。`npm run test:design` 只运行设计测试。 |
| `npx playwright test -c tests/mem/mem.config.ts` | 内存测量工具，独立于其他测试。 |
| `python -m unittest tests/unit/test_source_package.py` | 源码打包脚本的测试，没有 npm 脚本运行它。 |
| `npm run check:msrv` | 用声明的 Rust 版本在 `src-tauri/target/msrv` 中运行 `cargo check --locked --all-targets`。没有 rustup 或该工具链时跳过；加 `-- --strict` 则改为报错。安装：`rustup toolchain install 1.90 --profile minimal`。 |
| `npm run audit:deps` | 运行 `npm audit` 和 `cargo audit`（或 OSV-Scanner）；`-- --only=npm` 或 `-- --only=cargo` 只查其一。需要联网。只要有公告命中就失败，除非 `scripts/advisory-allowlist.json` 列出了完全相同的 `id` 和 `package`，并写明 `reason` 和 `expires`（`YYYY-MM-DD`，UTC，当天有效）。 |
| `npm run license:check` | 把锁定的 npm 和 Cargo 依赖与 `licenses/` 对比。离线运行，但需要先 `npm ci`，并且 Cargo 缓存已有内容。 |
| `npm run license:update` | 依赖变更后重建 `licenses/npm`、`cargo` 和 `toolchain`。需要联网、Git，以及之前生成安装程序时留下的 NSIS 工具链。从不运行安装脚本，也不编造版权声明。 |

**公开仓库检查**（`scripts/check-public-secrets.mjs`，属于 `npm test`）拦截不能公开的内容：`.cargo` 配置、AI 编程助手（agent）工具的文件夹和文件、`docs/` 下的开发过程记录、意外的点文件、`public/`、`src-tauri/icons/`、`src-tauri/installer/windows/assets/`、`tests/fixtures/`、`licenses/` 和 `docs/images/` 以外的图片、字体或压缩包、本机用户路径、Client ID 和 CurseForge Key，以及提交信息里的 AI 工具名称。它还会检查 Git 历史中的 `.cargo` 配置、agent 和过程文件夹、本机路径，以及提交信息。

## 源码包

`npm run source:package` 生成 `releases\<版本>\VoxelightLauncher-<版本>-source.zip`（`python scripts/package-source.py --output <文件.zip>` 可指定其他路径）。它要求所有版本号和许可证声明一致，打包磁盘上的文件（所以请在干净的代码目录运行，被包含的文件夹里未跟踪的文件也会被打包），附上列出每个文件 SHA-256 的 `SOURCE_MANIFEST.json`，并校验生成的 ZIP。包里有 MiSans 字体及其许可协议，不含依赖、构建产物、用户数据、密钥、证书，以及 Steve 和 Alex 的贴图。

检查已发布的源码包：解压到任何 Git 仓库之外的空文件夹，在解压出的 `VoxelightLauncher-<版本>` 文件夹里运行：

```powershell
npm run source:check
npm ci
npm run tauri -- build --no-bundle --no-sign --debug -- --locked
```

`source:check` 只需要 Node。`npm test` 需要 Git 历史，只能在代码仓库里运行。

## 版本管理与版本号规范

Voxelight Launcher 遵循 [语义化版本 2.0.0（SemVer）](https://semver.org/lang/zh-CN/)：

- **正式版（`MAJOR.MINOR.PATCH`）**：例如 `0.7.0`、`1.0.0`，对应 Git 标签 `v0.7.0`，在 GitHub / Gitee 以正式发布（`prerelease: false`）推送，启动器内置自动更新器会自动检测并提供升级。
- **预发布版（`MAJOR.MINOR.PATCH-(alpha|beta|rc).N`）**：例如 `0.7.0-beta.1`、`0.7.0-rc.1`，对应 Git 标签 `v0.7.0-beta.1`，在 GitHub / Gitee 显式勾选为 Pre-release（`prerelease: true`）。正式版用户不会被自动推送预发布版；而运行预发布版的用户在对应正式版（如 `0.7.0`）发布后会自动收到正式版升级提示。
- **多文件版本号同步**：仓库中的 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` 与 `licenses/dependency-inventory.json` 必须保持完全一致。日常通过 `npm run version:check`（已纳入 `npm run check`）自动校验，切版本时使用 `npm run version:set -- <版本号>` 原子同步六处文件。
- **变更记录**：开发期间把用户可见变更维护在 `CHANGELOG.md` 的 `[Unreleased]` 小节，切标签发布时整理为对应版本号与日期。

## 发布

1. 运行 `npm run version:set -- <版本>`（预发布如 `0.7.0-beta.1`，正式版如 `0.7.0`），整理 `CHANGELOG.md`，运行 `npm run version:check` 校验一致后构建安装程序。
2. 签名（可选）：`scripts\build.ps1 -PrepareSigning`（只要可执行文件时加 `-NoBundle`）在新文件夹里重新构建，并写出签名回执。然后运行 `scripts\desktop.ps1 -Action sign -CertificateThumbprint <指纹> -SigningReceipt <回执>`，用当前用户证书存储里的证书签名（不用 PFX 文件和密码），通过 `timestamp.digicert.com` 加时间戳。它为独立的可执行文件和安装程序签名，安装程序里打包的那份可执行文件不签名。回执里的文件有变化就要重新构建。
3. `node scripts/release-metadata.mjs --installer "<路径>\Voxelight Launcher_<版本>_x64-setup.exe" --out releases\<版本>-installer`（预发布构建加 `--prerelease`）把安装程序复制为 `VoxelightLauncher-<版本>-x64-setup.exe`，并据此写出 `update.json`。
4. 在同一个代码目录运行 `npm run source:package`。
5. `node scripts/prepare-release-assets.mjs --version <版本> --installer releases\<版本>-installer\VoxelightLauncher-<版本>-x64-setup.exe --source releases\<版本>\VoxelightLauncher-<版本>-source.zip --out releases\<版本>-assets`（预发布构建加 `--prerelease`）。
6. 把这四个文件上传到 `v<版本>` 的 GitHub 发布和 Gitee 发布（`-alpha`/`-beta`/`-rc` 勾选为预发布）：先传安装程序、源码包和 `SHA256SUMS.txt`，最后传 `update.json`。

`release-metadata.mjs` 和 `prepare-release-assets.mjs` 从不上传、签名或运行任何东西。内置自动更新器只推送正式版本，安装程序必须保持固定名称，且小于 512 MiB。

## 冒烟测试

**只在干净的专用 Windows 账户或虚拟机里运行安装程序测试。** 已注册 Voxelight 安装时它们会拒绝运行，但临时文件夹无法隔离 Windows 的安装注册。

- `node scripts/smoke-install.mjs` 把 Release 安装程序静默安装到临时文件夹，检查版本、注册信息、许可证文件和完整性标签，再安装一次、用 `/UPDATE` 重复一次，然后卸载；同时检查真实启动器数据文件夹里的文件名以及桌面和开始菜单快捷方式没有变化。`SMOKE_INSTALLER` 指定安装程序（低完整性标签的先复制到普通文件夹）；`SMOKE_REPORT` 指定报告路径。
- `scripts\verify-installer-ui.ps1 -Language English|SimpChinese [-Installer <路径>] [-OutputDirectory <文件夹>]` 通过 Windows UI 自动化操作安装程序的各个页面。
- `node scripts/smoke-native.mjs` 通过 WebView2 远程调试驱动 `npm run tauri -- build --debug --no-bundle` 生成的 Debug 构建（运行前刚构建；`desktop:dev` 会覆盖同一个文件），数据放在 `src-tauri\target\native-<id>` 下。**它使用真实网络**（Mojang、BMCLAPI、Modrinth、各加载器发布方），并启动真实的游戏实例；它会安装一个受管理的服务端，但从不接受 EULA，也不启动它。它的界面检查按中文标签查找，所以 Windows 的首选显示语言必须是简体中文。`SMOKE_BINARY` 指定可执行文件；`SMOKE_CACHE` 指定一个游戏文件夹，从中复制 1.20.1 的客户端、库和资源文件（例如之前运行留下的 `native-<id>\game`；不设置时从 `%APPDATA%\.minecraft` 读取，从不复制存档和凭据）；`SMOKE_CHECKS`、`SMOKE_REPORT` 和 `SMOKE_CDP_PORT`（默认 9333）分别选择检查项、报告路径和调试端口。带低完整性标签的可执行文件会被拒绝。

不要让任何测试指向你自己的启动器或游戏文件夹。

## 测试用的数据目录

- `VOXELIGHT_LAUNCHER_DATA_DIR` 替换 `%LOCALAPPDATA%\dev.voxelight.launcher`，并关闭自动备用文件夹。
- `VOXELIGHT_LAUNCHER_GAME_DIR` 替换游戏目录，并保存到所用数据目录的设置里；两者一起设置，才不会改动你自己的设置。
- `MINECRAFT_LAUNCHER_DATA_DIR` 和 `MINECRAFT_LAUNCHER_GAME_DIR` 仍可作为旧名称使用。它们不迁移任何数据，启动器更新后重启时也不会传递它们。
- 更新下载总是暂存在 `%LOCALAPPDATA%\dev.voxelight.launcher\updates`。
