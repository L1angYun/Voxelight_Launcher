# Changelog

All notable changes to **Voxelight Launcher** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning 2.0.0](https://semver.org/):

- `MAJOR.MINOR.PATCH` — Stable release (`v0.7.0`, `v1.0.0`), distributed via the in-app stable auto-updater.
- `MAJOR.MINOR.PATCH-(alpha|beta|rc).N` — Pre-release (`v0.7.0-beta.1`, `v0.7.0-rc.1`), published as a GitHub/Gitee Pre-release; users on the **Stable** channel never receive pre-releases automatically, while users who opt into the **Beta** update channel in **Settings → About** can update to newer pre-releases and graduate seamlessly to stable releases.

## [Unreleased]

## [0.7.0-beta.2] - 2026-11-27

_Pre-release beta for 0.7.0._

### Security
- **Lumen**:
  - Crash wake-ups run read-only.
  - Installing mods or packs, changing loaders, starting or saving servers and joining a server always ask first, even in Full access.
  - At most three changes run without approval per message.
  - Tool output is passed to the model as untrusted data.
  - Approval cards name the real instance, project and server, run exactly what was shown, and can be decided per action.
  - Focus no longer lands on the approve button.
  - A stop you confirm is no longer treated as a crash.
- **MCP**:
  - A slow write is no longer abandoned at the 120 s deadline, which could leave the download queue stuck until restart.
  - Stopping or restarting the server cancels queued writes, and every write rechecks the permission after it gets its turn.
  - New error texts explain a busy or reserved port.
- **Log redaction**: masks Minecraft session tokens (including the 1.7/1.8 `Session ID is token:…` line, `--accessToken` arguments and JWTs), provider API keys and the masked key fragments providers echo back, before logs or errors reach the UI, Lumen or diagnostic exports.
- **Imported Forge/NeoForge servers**: `win_args.txt` is checked against an allowlist of printable-ASCII options. `-XX:VMOptionsFile`, `-XX:Flags` and similar indirections are refused, and application paths must stay inside the server folder.
- **Online OptiFine installation is turned off**, because there is no trustworthy hash for the mirrored installer. Import the official installer JAR from optifine.net instead.

### Changed
- **Loader switches**:
  - Back up the instance before anything is installed.
  - Explain why a backup is impossible (links, size, file count, free space), and offer to switch without a backup only after a second confirmation.
  - Keep only the newest two automatic switch backups.
- **Factory reset**:
  - Erases saved keys before it commits and finishes account sign-out removal at the next start, so a crash can no longer leave keys behind.
  - Its texts now say what happened when it could not finish.

### Fixed
- **Downloads and imports**:
  - Clearing unfinished downloads keeps only the partial files a paused or retryable task can still resume.
  - Listing a world's data packs no longer renames files.
  - Disabling a folder data pack really unloads it.
  - A new file drop no longer breaks an import from an earlier drop.
  - Import size limits follow the detected pack format.
- **Network check**: recognises Clash/mihomo-style TUN tunnels instead of reporting the proxy's address as a direct-connect address, and a local web server is no longer offered as a proxy.
- **Beta channel**: no longer falls back to the stable feed when GitHub rate-limits.
- **Interface**:
  - The empty home page keeps its two actions on one row.
  - The sound checkbox in Appearance settings sits beside its label.
  - Discover names vanilla targets in the interface language.
  - The first-run card no longer half-covers the home page.
  - Clicking the Lumen permission caption no longer switches it to Read-only.
  - The file-drop overlay has its shadow again.
- **Translations**: corrected for Traditional Chinese, Japanese, Korean, Russian and Spanish.

## [0.7.0-beta.1] - 2026-11-26

_Pre-release beta for 0.7.0._

### Added
- **Lumen & local MCP server**: Optional built-in BYO-API assistant (`OpenAI-compatible` & `Anthropic` providers, plus local loopback servers such as Ollama/LM Studio) with 39 curated launcher tools across Read-only, Controlled (explicit per-action confirmation), and Full access tiers, Windows DPAPI key storage, and an opt-in `127.0.0.1` Streamable HTTP JSON-RPC 2.0 MCP server with per-session Bearer token rotation and Host/Origin checks. Completely invisible outside **Settings → Lumen & MCP** until configured.
- **Proactive Lumen wake-ups**: Automatic crash wake-up on abnormal game exit (configurable toggle) plus contextual help shortcuts on instance log errors, failed downloads, and restricted NAT checks (active only when Lumen is configured).
- **Voxelight-styled 4-step OOBE**: Interactive first-run welcome setup with live 3D world scene/material/theme/language preview, quick offline player creation, runtime/Java/memory/proxy check, and workspace orientation.
- **Factory reset**: **Settings → General → Restore initial state** clears settings, accounts, DPAPI tokens/keys, instance registrations, download history, and stops MCP while never deleting Minecraft game directories, worlds, mods, backups, or server files.
- **Local & Windows system proxy auto-detection**: Detects Windows system proxy (WinHTTP), PAC URLs, environment variables, and common local HTTP proxy listeners (`127.0.0.1`) with one-click adoption in Settings and OOBE.
- **7 interface languages**: Added Traditional Chinese (`zh-TW`), Japanese (`ja-JP`), Korean (`ko-KR`), Russian (`ru-RU`), and Spanish (`es-ES`) alongside Simplified Chinese (`zh-CN`) and English (`en-US`), with full system-locale mapping, native Windows CJK font stacks, and diagnostic report localization.
- **Version management & Beta update channel**: Added `scripts/version.mjs` (`npm run version:check` / `npm run version:set`), pre-release packaging support (`--prerelease`) in release metadata and asset staging scripts, and an opt-in **Update channel** selector (**Stable** / **Beta**) in **Settings → About** with full SemVer 2.0.0 ordering, GitHub/Gitee pre-release discovery, and independent stable/beta anti-downgrade watermarks.
- **Loader switching, OptiFine, MultiMC / MCBBS import, drag-and-drop, and STUN network check**: Change the loader of existing instances, install OptiFine via local installer JAR or BMCLAPI, import MultiMC / Prism / MCBBS modpacks, drag-and-drop mods/modpacks/skins, import JAR / folder / `win_args.txt` third-party servers, and diagnose IPv4/IPv6 NAT reachability.

### Changed
- Unified all system-capable launcher defaults (`theme`, `language`, `accentSource`, `proxyMode`, `gameProxyMode`) to `"system"`, with native initial window background matching Windows light/dark mode to prevent white/black startup flashes.
- Streamlined `README.md` and `README.zh-CN.md` into concise release-ready documentation.

### Fixed
- Hardened local MCP concurrency and shutdown to eliminate factory-reset / operation-lock deadlocks and single-threaded request stalls.
- Prevented untrusted config preset imports from overriding Lumen provider/base URL endpoints or silently enabling proactive crash wake-ups.
- Removed download pause checkpoints from read-only local resource directory scans so browsing mods never blocks while a download is paused.
- Hardened Lumen status error handling (fail-closed zero-presence), session persistence across dialog close/reopen, response size bounds, live permission re-checks, and bare Bearer token log redaction.

## [0.6.0] - 2026-11-23

### Added
- In-app self-updater checking GitHub and Gitee concurrently with SHA-256 verification and downgrade protection.
- Online modpack updates with diff plans, user-edit preservation, and automatic backup/restore recovery.
- Custom Windows NSIS installer with Voxelight branding, bilingual pages, current-user install mode, and opt-in app-data deletion on uninstall.
- Live instance game log viewer, batch resource controls, and automatic download source selection (Official vs BMCLAPI).

## [0.5.0] - 2026-11-12

### Added
- Initial public preview of Voxelight Launcher featuring the 3D WebGL world scene (`Horizon` / `Massif`, `Lattice` / `Solid`), instance management, Modrinth & CurseForge discovery, Microsoft/offline/Authlib accounts with 3D skin viewer, unified downloads, and local vanilla server management.
