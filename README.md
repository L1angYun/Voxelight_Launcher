# Voxelight Launcher

Voxelight Launcher is a Minecraft Java desktop launcher built with Rust, Tauri 2, React and TypeScript. Its original interface includes a WebGL2 voxel-and-point "crystal world" background that responds to launch progress, and a skinview3d WebGL character preview. The application entry points are `src/main.tsx` and `src-tauri/src/main.rs`.

This directory contains only the active Rust application. WinUI is not part of this project.

![Voxelight Launcher 0.5.0 home](docs/screenshots/0.5.0/home-dark-1440.png)

_Screenshot from 0.5.0. The current interface differs; an updated screenshot will replace it._

## Open-source license and source

Original project code and original artwork are **GPL-3.0-only**. See `LICENSE`, `NOTICE` and `THIRD_PARTY_NOTICES.md`. Third-party dependencies keep their own licenses; their notices are collected in `licenses/`.

Source repository: https://github.com/L1angYun/Voxelight_Launcher

The source archive contains the Rust/React sources, original assets, build scripts, tests and lockfiles. It does not contain user accounts, tokens, save games, downloaded game clients, build outputs or proprietary UI sources. `python scripts/package-source.py --output <output.zip>` creates and verifies a source archive matching the current files.

New configurations default to Steve, with Alex also available. The home preview prioritizes the selected account's actual skin, model and cape rather than replacing them with a default character. Steve and Alex textures are read at runtime from a hash-verified official Minecraft client, rather than being bundled as project assets. If the selected client texture is unavailable, the launcher shows an empty preview with retry or local-import actions instead of substituting another character. Voxelight Launcher is unofficial and is not endorsed by Mojang or Microsoft.

## Data isolation

The default launcher data directory is `%LOCALAPPDATA%\dev.voxelight.launcher`, matching the application identifier and deliberately separate from the NSIS program directory `%LOCALAPPDATA%\Voxelight Launcher`. Existing accounts, service secrets, settings and instances from other launchers are not imported automatically.

Portable runs and isolated tests can override these locations explicitly:

- `VOXELIGHT_LAUNCHER_DATA_DIR`: launcher state, encrypted service secrets and managed runtimes.
- `VOXELIGHT_LAUNCHER_GAME_DIR`: Minecraft versions, libraries, assets and instances.

The former `MINECRAFT_LAUNCHER_*` variables remain explicit override aliases. They do not enable legacy data migration.

## Download sources and game safety

Settings offers three download modes: `official` uses only Mojang/Minecraft sources, `auto` measures both sources once per session and tries the official source first unless it does not answer or is slower than twice BMCLAPI plus 150 ms (provisional thresholds), with the other as the fallback; the measurement is not saved or uploaded, and `bmclapi` tries BMCLAPI before the official fallback. The mirror applies to supported vanilla metadata, clients, libraries, assets, logging, hash-verified Java runtime entries and the official server JAR. It does not invent mirrors for Quilt, Modrinth, CurseForge, OptiFine or arbitrary Maven hosts.

Version-manifest v2 entries retain the official URL and expected SHA-1. Files are checked before being committed. A hash supplied by a mirrored manifest belongs to that mirror's trust chain and is not independent Mojang signing. BMCLAPI is a community service, not an official Mojang endpoint.

A running instance cannot be launched twice or modified by backup, clone, restore, export or removal operations. Separate instances can run the same game version independently, and an instance can be restarted after its process exits.

The Rust HTTP client honors the existing Windows system proxy through reqwest's `system-proxy` support. Proxy use does not disable TLS verification, redirect restrictions or content hashes. Local test fixtures explicitly bypass proxies so they cannot accidentally reach external services.

## Run

Requirements on Windows: Node.js 22.13.0 or later on 22.x, or Node.js 24.0.0 or later; Rust 1.90 or later with the MSVC target; Visual Studio C++ build tools, the Windows SDK and WebView2. Python 3 is used for original asset generation and source packaging; only `scripts/generate-installer-assets.py` additionally needs Pillow. The license collector uses the system `tar` in local-archive mode and does not run dependency install scripts.

```powershell
npm ci
npm run desktop:dev
```

Build the Windows desktop executable with `powershell -File scripts/build.ps1 -NoBundle`. Omit `-NoBundle` when building an NSIS installer for release. The script wraps Tauri, configures the Rust PATH, and prints output paths from the configured Cargo target directory. It does not copy artifacts to `releases/<version>/`. Create the matching source archive separately with `npm run source:package` from the same checkout used to build the binary; this command writes to the untracked `releases/<version>/` directory. See the [0.6.0 implementation and verification report](docs/reports/frontend-completion-0.6.0.md) for measured results and manual checks still outstanding. The NSIS installer uses current-user installation mode and includes the GPL and third-party notices under `licenses/`. It does not require administrator rights. Updates are installed manually; the installer maintenance flow is not an in-app updater.

`scripts/desktop.ps1` is an optional helper when local PowerShell policy permits unsigned local scripts. Do not change that policy merely to build the app: the npm commands above invoke the same Tauri toolchain.

For a planned signing run, use `scripts/build.ps1 -PrepareSigning` (add `-NoBundle` for the launcher only). It builds into a fresh directory and prints a receipt. Then run `scripts/desktop.ps1 -Action sign -CertificateThumbprint <thumbprint> -SigningReceipt <receipt-path>` using a code-signing certificate provisioned in the current user's Windows certificate store. No PFX path or password is passed to SignTool. The receipt pins the paths and bytes built in that run; rebuild to get a new receipt if an artifact changes.

If the checkout has a Windows **Low mandatory label**, newly linked executables inherit it and Windows starts them at Low integrity. They cannot write normal user data. The Windows npm/Tauri entry points repair the executable's own label to Medium before every development launch, including after a Rust rebuild. Successful builds also repair their executable and NSIS setup files. This requires no administrator rights and leaves directory ACLs and integrity labels unchanged. Cargo still runs from `src-tauri`, so its `.cargo/config.toml` remains effective; output directories are not shared between checkouts by these scripts.

For an older build or a setup copied back into a Low-labeled `releases` directory, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/repair-build-integrity.ps1
# Or repair one explicitly selected executable:
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/repair-build-integrity.ps1 -Path 'C:\Downloads\Voxelight-setup.exe'
```

This changes only the selected `.exe` files' mandatory labels; it does not recurse or grant access permissions. `-ExecutionPolicy Bypass` applies only to that PowerShell invocation. Reinstalling or copying the program into a normal directory is another option; a same-volume move can retain the old label. A Low-integrity startup that cannot open either data directory now explains this cause in Chinese or English instead of suggesting elevation. A new file installed by the Medium-integrity setup into a normal directory inherits that destination's security, rather than the build directory's Low label.

`npm run dev` starts a browser preview. It can display the interface, WebGL skins and public resource search, but cannot access local game files or launch games.

## Verification

```powershell
npm run build
npm test
npm run test:e2e
Push-Location src-tauri
cargo test --locked
Pop-Location
npm run license:check
```

Use `npm run check:msrv` to check the Rust version declared in `src-tauri/Cargo.toml`
against all locked targets. The check uses a separate `src-tauri/target/msrv` directory.
If the toolchain is missing, install it with `rustup toolchain install 1.90 --profile minimal`.
For release verification or CI, run `npm run check:msrv -- --strict` so a missing toolchain fails.

Run `npm run audit:deps` when preparing a release. For one dependency graph, use
`npm run audit:deps -- --only=npm` or `npm run audit:deps -- --only=cargo`.
These checks may access the network and are separate from `npm test`.
The Rust audit skips if neither cargo-audit nor OSV-Scanner is installed.
The wrapper fails on findings reported by either scanner unless an exact advisory ID and
package pair is covered by an optional `scripts/advisory-allowlist.json` entry with
`id`, `package`, `reason`, and `expires` (YYYY-MM-DD, inclusive in UTC).
Expired entries fail the check. npm advisories without a GitHub advisory ID are listed as
`npm:<source>`; Cargo yanks without an advisory are listed as `RUSTSEC-YANKED`.

The license check reads the locked npm/Cargo dependency graph and compares it with the collected notices. After intentionally changing dependencies, run `npm run license:update` to refresh the inventory. Missing npm notices use the integrity-checked registry metadata/package and verified upstream source; missing Cargo notices use the source commit recorded by Cargo. Packages without a standalone license file retain their actual metadata and the official SPDX text, with that distinction recorded in `licenses/dependency-inventory.json`; no copyright lines are invented.

`npm run source:package` creates and verifies the GPL source archive under `releases/<version>/`. It excludes dependencies, build outputs, user data, secrets, proprietary textures and restricted UI sources.

To verify a released source ZIP, extract it into a clean directory outside any Git checkout. Run `npm run source:check` there to verify the manifest and run the public source guard, then run `npm ci` and `npm run tauri -- build --no-bundle --no-sign --debug -- --locked` to build and link the Debug Windows executable without packaging or signing. The archive does not include Git metadata; `npm test` in a normal Git checkout still checks the index and history.

`node scripts/smoke-install.mjs` verifies a current-user NSIS installation and uninstall, including registration, license resources, executable integrity and preservation of launcher data. **Run installer verification only in a clean, dedicated Windows account or VM.** The silent and UI smoke scripts refuse to start if a Voxelight installation is registered or the registration cannot be checked. Temporary directories do not isolate Windows installer registration. The silent script looks for a matching Release setup in the configured Cargo target directory; set `SMOKE_INSTALLER` to pick an exact file. If the setup has a Low mandatory label, copy it to a normal per-user directory and set `SMOKE_INSTALLER` to that copy. Set `SMOKE_REPORT` to choose its JSON report path.

`node scripts/smoke-native.mjs` runs isolated native IPC checks against the Debug executable in the configured Cargo target directory. Set `SMOKE_BINARY` to choose a specific executable if several are present or to test an installed Release build. On Windows it rejects an executable with a Low mandatory label. Set `SMOKE_CACHE` to reuse immutable versions, libraries and assets from an isolated prior run; worlds and credentials are never copied. `SMOKE_CHECKS` optionally selects comma-separated substrings of check names for focused debugging; omit it for the full suite.

Test state is created below `src-tauri/target/native-*`; do not point the test overrides at personal launcher or game directories.

## Features and research

Start with [the documentation index](docs/README.md) for the current design, verification reports and directory layout.

See `docs/migration-status.md` for verified functionality and remaining limitations, and `docs/launcher-feature-catalog.md` for the competing-launcher feature inventory. Third-party component attribution is in `THIRD_PARTY_NOTICES.md`.

Microsoft device authorization requires your own OAuth Client ID. CurseForge requires your own API Key and is subject to each project's distribution permissions. Neither is configured by default; missing credentials are not treated as a successful login or restricted-download test.
