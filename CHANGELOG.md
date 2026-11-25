# Changelog

All notable changes to **Voxelight Launcher** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning 2.0.0](https://semver.org/):

- `MAJOR.MINOR.PATCH` — Stable release (`v0.7.0`, `v1.0.0`), distributed via the in-app stable auto-updater.
- `MAJOR.MINOR.PATCH-(alpha|beta|rc).N` — Pre-release (`v0.7.0-beta.1`, `v0.7.0-rc.1`), published as a GitHub/Gitee Pre-release and never auto-pushed to stable users; pre-release builds automatically upgrade to the corresponding stable release once published.

## [Unreleased]

_Target pre-release: `0.7.0-beta.1`_

### Added
- **Lumen & local MCP server**: Optional built-in BYO-API assistant (`OpenAI-compatible` & `Anthropic` providers, plus local loopback servers such as Ollama/LM Studio) with 39 curated launcher tools across Read-only, Controlled (explicit per-action confirmation), and Full access tiers, Windows DPAPI key storage, and an opt-in `127.0.0.1` Streamable HTTP JSON-RPC 2.0 MCP server with per-session Bearer token rotation and Host/Origin checks. Completely invisible outside **Settings → Lumen & MCP** until configured.
- **Proactive Lumen wake-ups**: Automatic crash wake-up on abnormal game exit (configurable toggle) plus contextual help shortcuts on instance log errors, failed downloads, and restricted NAT checks (active only when Lumen is configured).
- **Voxelight-styled 4-step OOBE**: Interactive first-run welcome setup with live 3D world scene/material/theme/language preview, quick offline player creation, runtime/Java/memory/proxy check, and workspace orientation.
- **Factory reset**: **Settings → General → Restore initial state** clears settings, accounts, DPAPI tokens/keys, instance registrations, download history, and stops MCP while never deleting Minecraft game directories, worlds, mods, backups, or server files.
- **Local & Windows system proxy auto-detection**: Detects Windows system proxy (WinHTTP), PAC URLs, environment variables, and common local HTTP proxy listeners (`127.0.0.1`) with one-click adoption in Settings and OOBE.
- **7 interface languages**: Added Traditional Chinese (`zh-TW`), Japanese (`ja-JP`), Korean (`ko-KR`), Russian (`ru-RU`), and Spanish (`es-ES`) alongside Simplified Chinese (`zh-CN`) and English (`en-US`), with full system-locale mapping and diagnostic report localization.
- **Version management tooling**: Added `scripts/version.mjs` (`npm run version:check` / `npm run version:set`) and pre-release packaging support (`--prerelease`) in release metadata and asset staging scripts, plus SemVer pre-release support in the launcher updater's current-version check.
- **Loader switching, OptiFine, MultiMC / MCBBS import, drag-and-drop, and STUN network check**: Change the loader of existing instances, install OptiFine via local installer JAR or BMCLAPI, import MultiMC / Prism / MCBBS modpacks, drag-and-drop mods/modpacks/skins, import JAR / folder / `win_args.txt` third-party servers, and diagnose IPv4/IPv6 NAT reachability.

### Changed
- Unified all system-capable launcher defaults (`theme`, `language`, `accentSource`, `proxyMode`, `gameProxyMode`) to `"system"`, with native initial window background matching Windows light/dark mode to prevent white/black startup flashes.
- Streamlined `README.md` and `README.zh-CN.md` into concise release-ready documentation.

## [0.6.0] - 2026-11-23

### Added
- In-app self-updater checking GitHub and Gitee concurrently with SHA-256 verification and downgrade protection.
- Online modpack updates with diff plans, user-edit preservation, and automatic backup/restore recovery.
- Custom Windows NSIS installer with Voxelight branding, bilingual pages, current-user install mode, and opt-in app-data deletion on uninstall.
- Live instance game log viewer, batch resource controls, and automatic download source selection (Official vs BMCLAPI).

## [0.5.0] - 2026-11-12

### Added
- Initial public preview of Voxelight Launcher featuring the 3D WebGL world scene (`Horizon` / `Massif`, `Lattice` / `Solid`), instance management, Modrinth & CurseForge discovery, Microsoft/offline/Authlib accounts with 3D skin viewer, unified downloads, and local vanilla server management.
