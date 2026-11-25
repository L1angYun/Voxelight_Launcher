# Voxelight Launcher

English | [简体中文](README.zh-CN.md)

An open-source launcher for Minecraft: Java Edition on 64-bit Windows, built with Rust, Tauri 2 and React. GPL-3.0-only. Unofficial: not affiliated with or endorsed by Mojang or Microsoft.

![Voxelight Launcher home page](docs/images/home-0.5.0.png)

_Screenshot from 0.5.0; the current interface looks different._

## Download

Get `VoxelightLauncher-<version>-x64-setup.exe` from [GitHub Releases](https://github.com/L1angYun/Voxelight_Launcher/releases) or the [Gitee mirror](https://gitee.com/liangyun_Liu/Voxelight_Launcher/releases) (same files).

- Installs for the current user, without administrator rights, by default to `%LOCALAPPDATA%\Voxelight Launcher`. Installs the WebView2 runtime if it is missing.
- **Releases come with a built-in Microsoft Client ID and CurseForge API key**, so Microsoft sign-in and CurseForge work without any setup. A build from source has neither; see [Accounts and service keys](#accounts-and-service-keys).
- Updates install from **Settings → About → Download and update**, after the installer's size and SHA-256 are checked. Older versions are never installed over newer ones.

## Features

✅ available · 🚧 planned. Planned items are updated as they are done.

| Area | Feature | Status |
| --- | --- | --- |
| Versions | Every release and snapshot, with Fabric, Quilt, Forge or NeoForge | ✅ |
| Versions | Version list grouped into releases, snapshots, Beta & Alpha and April Fools versions, with search, sorting and release dates | ✅ |
| Versions | OptiFine | 🚧 |
| Versions | Change the loader of an existing instance | 🚧 |
| Java | Finds installed Java; downloads Mojang's runtime when a version needs another; automatic or manual memory | ✅ |
| Instances | Own folder per instance, with its own or the global Java, memory, JVM arguments, window size and game proxy | ✅ |
| Instances | Backup and restore, copy, export as a personal backup or a Modrinth `.mrpack` | ✅ |
| Instances | Worlds: import and back up as ZIP; screenshots | ✅ |
| Instances | Data packs per world | ✅ |
| Instances | Crash-log analysis and diagnostic report | ✅ |
| Instances | Game logs per instance, with search and level filters | ✅ |
| Content | Search and install mods, resource packs, shaders and modpacks from Modrinth and CurseForge | ✅ |
| Content | Modrinth installs bring required dependencies; update checks with rollback | ✅ |
| Content | Search, filter, sort and batch enable or disable local mods and packs | ✅ |
| Content | Batch delete of local mods and packs | ✅ |
| Content | In a project's version list, show how many of your instances each version fits | ✅ |
| Content | Drag-and-drop import of mods, modpacks and skins | 🚧 |
| Modpacks | Import a `.mrpack` or CurseForge ZIP, or install online | ✅ |
| Modpacks | Update online-installed packs: a plan of every change, your edits kept, automatic backup | ✅ |
| Modpacks | Import MultiMC and MCBBS packs | 🚧 |
| Downloads | One task page with pause, resume, cancel and retry | ✅ |
| Downloads | Resumable and multi-connection downloads; game files, Java, mods and modpacks checked against their published hashes; Official or BMCLAPI source; proxy | ✅ |
| Downloads | Retry all, and clear unfinished downloads | ✅ |
| Accounts | Microsoft, offline and Authlib accounts; skin upload and cape for Microsoft accounts | ✅ |
| Multiplayer | Server list, status, LAN worlds, direct join; local vanilla servers with a console | ✅ |
| Multiplayer | Import third-party server software, such as Spigot, Paper or Fabric, as a JAR or an existing server folder, and run it as a managed server | ✅ |
| Multiplayer | Import Forge and NeoForge servers that start only from an arguments file (Forge 1.17+ without a shim JAR, NeoForge) | 🚧 |
| Multiplayer | Network check: IPv4 and IPv6, NAT type, and advice for direct connections | 🚧 |
| Interface | Simplified Chinese and English; dark and light themes; Lite and Full effects; follows Windows accessibility settings | ✅ |
| Interface | Lower memory use, such as unloading the 3D world in Lite mode | 🚧 |
| Interface | Instance icons by loader and version type | ✅ |
| Interface | Keyboard shortcuts, settings search and a first-run tour | ✅ |
| Interface | Custom home background | ✅ |
| Updates | Update checks on GitHub or Gitee, and updates from inside the launcher | ✅ |
| Installer | Installer pages with the launcher's icon, colors, typeface and world scene | ✅ |
| Installer | A dark installer theme to match the launcher's default theme | 🚧 |
| Assistant | Built-in assistant using your own AI API key, also available over MCP | 🚧 |

## Accounts and service keys

**Microsoft sign-in** uses the device-code flow: the launcher shows a code, you enter it on Microsoft's page, and the launcher never sees your password. The flow runs under a Microsoft app registration (a Client ID) that Mojang has to approve for the Minecraft Java API.

**CurseForge** needs an API key for search, installs and update checks. Modrinth needs no key.

Releases include both. To use your own instead, or in a build from source, enter them in **Settings → General → Service connections**. Your own Client ID must be a public-client registration that allows the device-code flow for personal accounts and has passed Mojang's review; don't reuse another launcher's.

An **offline account** is enough for single-player and for servers that allow offline players. An **Authlib** password goes only to that server and is not saved.

## Your data

| | Location |
| --- | --- |
| Launcher data (settings, accounts, logs, Java runtimes, backups, servers, caches) | `%LOCALAPPDATA%\dev.voxelight.launcher` |
| Game directory (versions, libraries, assets, `instances\`) | `%APPDATA%\.minecraft` by default; **Settings → Game** |

- The default game directory is the official launcher's, so versions, libraries and assets are shared with it. Nothing is imported from other launchers.
- Tokens, the saved CurseForge key and proxy credentials are encrypted with Windows DPAPI for your Windows user. Copy the data folder to another user or PC and you have to sign in and enter the CurseForge key and proxy credentials again.
- Uninstalling keeps your data unless you tick **Delete the application data**. The game directory is never deleted.
- `VOXELIGHT_LAUNCHER_DATA_DIR` and `VOXELIGHT_LAUNCHER_GAME_DIR` move the folders for test setups or a second profile; a game directory set this way is also saved in the settings.

## Network

No telemetry, analytics or crash reporting. The launcher connects only to:

| For | Hosts |
| --- | --- |
| Game files, version list, Java | Mojang; BMCLAPI if the download source allows |
| Loaders | Fabric, Quilt, Forge and NeoForge servers; partly BMCLAPI if allowed |
| Microsoft accounts | Microsoft, Xbox Live and Minecraft services |
| Authlib accounts | The server you entered; `authlib-injector.yushi.moe` |
| Content and modpacks | Modrinth, CurseForge; files listed in a modpack can also come from GitHub or GitLab |
| Launcher updates | GitHub, Gitee |
| Multiplayer | The servers you check; UDP 4445 for LAN discovery |
| Skin preview | A skin URL you enter |

- Every start fetches the version list. The update check also runs at every start by default; with the default Auto source it asks both GitHub and Gitee (**Settings → About**).
- With an offline account or none, showing the default Steve or Alex can download an official Minecraft client once, if no installed one can be used.
- Installing from Modrinth, checking content for updates and exporting a Modrinth pack send hashes of local files, not their names, to Modrinth; update checks also send CurseForge fingerprints if a key is available.

## Download sources and proxy

**Settings → Downloads → Download source**: **Official only** (default), **Automatic** (Mojang first, unless it fails or is clearly slower this session), or **BMCLAPI first**. BMCLAPI is a community mirror, not a Mojang service; it covers Mojang's files and part of Fabric, Forge, NeoForge and authlib-injector, and every mirrored file is still hash-checked.

**Network proxy**: Follow system (default), Off, or Custom `http://` / `https://`; restart the launcher after changing it. **Game proxy mode** (default Off) lets Minecraft itself follow the system proxy or inherit the launcher's `http://` proxy, globally or per instance. Modrinth search and images such as project icons and skins are loaded by WebView2, which does not use the launcher's proxy setting.

## Limitations

- Windows x64 and Java Edition only.
- Shader packs need a shader loader such as Iris, installed as a mod.
- The built-in server download is vanilla only; other server software can be imported, except Forge and NeoForge servers that start only from an arguments file. CurseForge installs don't fetch dependencies.
- Closing the window quits the launcher; unfinished installs can be retried from **Downloads**.

## Building from source

Windows, Node.js 22.13.0+ on 22.x or 24.0.0+, Rust 1.90+ (MSVC), Visual Studio C++ build tools with the Windows SDK, WebView2, Git.

```powershell
npm ci
npm run desktop:dev      # run in development
npm run desktop:build    # build the installer
```

A build from source has no built-in Client ID or CurseForge key unless you set them at build time. Tests, release steps and details: [docs/development.md](docs/development.md).

## License

[GPL-3.0-only](LICENSE); see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Third-party licenses are in [licenses/](licenses/). The MiSans typeface is Xiaomi's, under its own license. Steve and Alex textures are not included; the launcher reads them from an official, hash-checked Minecraft client.

Minecraft is a trademark of Mojang and Microsoft.

Source: [GitHub](https://github.com/L1angYun/Voxelight_Launcher) · [Gitee](https://gitee.com/liangyun_Liu/Voxelight_Launcher)
