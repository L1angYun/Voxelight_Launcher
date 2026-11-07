# Microsoft 应用构建配置

公开仓库不保存内置 Microsoft Client ID。公开构建没有内置值时，登录入口继续要求用户填写自己的 Client ID；用户保存的非空配置优先于内置值。内置值只参与认证，前端只能取得是否存在的布尔值，不会取得该值。

以下私有仓库操作仅供维护者执行。Codex 在第三轮任务中不建立、读取或修改该仓库。文档中的路径和占位符不是可直接执行的完整脚本；不要把实际注册值粘贴进公开代码、共享日志、问题报告或终端录制。

## 建立私有构建仓库

1. 等公开改动已提交、推送后，从本地公开仓库克隆到独立目录：

   ```powershell
   git clone E:/CodeX/VoxelightLauncher E:/CodeX/VoxelightLauncher-private
   cd E:/CodeX/VoxelightLauncher-private
   git remote rename origin public
   git remote set-url --push public DISABLED-private-never-pushes
   git config voxelight.private true
   git branch --set-upstream-to=public/main main
   ```

2. 在私有仓库的 `src-tauri/.cargo/config.toml` 创建唯一的私有配置，使用无 BOM 的 UTF-8。由维护者在本地编辑器中填写注册值：

   ```toml
   [env]
   VOXELIGHT_MS_CLIENT_ID = { value = "<维护者填写应用注册值>", force = true }
   ```

   `force = true` 防止进程环境覆盖该构建配置。占位符不是 UUID，直接构建会报格式错误，错误消息不回显输入。不要创建客户端密钥。

3. 确认 Git 身份正确，不要改全局配置；仅在私有仓库执行：

   ```powershell
   git config user.email
   git add -f src-tauri/.cargo/config.toml
   git commit -m "private: bake Microsoft client ID"
   ```

   公开仓库忽略根目录及 `src-tauri` 下的 Cargo 配置，`-f` 仅用于私有提交。私有分支始终只比公开分支多这一笔配置提交。禁止从私有仓库推送；不要把私有提交合并回公开仓库。

## 同步、验证和构建

在公开仓库完成并推送改动后，维护者在私有仓库执行：

```powershell
git pull --rebase public main
npm ci
npm test
cd src-tauri
$env:VOXELIGHT_EXPECT_BUILTIN = "1"
cargo test builtin_presence_matches_expectation
Remove-Item Env:VOXELIGHT_EXPECT_BUILTIN
cd ..
powershell -File scripts/build.ps1 -NoBundle
```

必须从 `src-tauri` 目录运行 Cargo 命令，才能读取这里的 Cargo 配置。从仓库根目录仅传 `--manifest-path` 不会替代配置发现目录。正式发行如需安装包，由维护者另行选择构建模式；第三轮任务不构建安装包。

私有与公开构建不要共用 `CARGO_TARGET_DIR`，避免混用二进制。内置值会进入私有二进制，因此私有构建产物也不应作为不含该值的公开产物发布。切换内置值或恢复默认不会迁移已经登录的凭据；旧账号按登录时的应用刷新，需要切换时重新登录。

## 公开仓库守护

`npm run check`（也由 `npm test` 调用）运行 `scripts/check-public-secrets.mjs`。公开模式检查 Client ID 类键名后的 UUID，并拒绝当前或历史中跟踪的 Cargo 配置目录；重复字符 UUID 仅作为测试夹具豁免。失败输出只包含位置与键名，不打印值。

私有模式由该私有仓库本地的 `voxelight.private=true` 开启：允许配置提交，但检查配置值不能出现在配置之外的文件中，所有推送地址必须保持禁用。守护不替代远端权限隔离；维护者还应在公开仓库全部历史上做真实注册值的精确检查，此检查结果不要附带值。

## Azure 与 Minecraft 准入检查

- 启用允许公共客户端流（Allow public client flows）。
- 支持个人 Microsoft 账号，与本项目的 consumers 设备代码流程一致。
- 设备代码流程不需要重定向 URI，也不需要客户端密钥。
- 为该应用提交 Mojang 的 Minecraft API 审核。Microsoft 授权成功不等于 Minecraft API 已准入；应用未获准时，界面应显示明确的应用审核错误。

实际账号授权与 Mojang 准入需要维护者在私有构建中验证。自动测试只使用合成夹具，不证明应用已获批准。
