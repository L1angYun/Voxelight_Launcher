# Developing Voxelight Launcher

English | [简体中文](development.zh-CN.md)

Building, testing and releasing the launcher. For what the launcher does, see the [README](../README.md).

## Requirements

Windows x64 only.

- Node.js 22.13.0 or later on 22.x, or 24.0.0 or later (not 23).
- Rust 1.90 or later with the MSVC toolchain; Visual Studio C++ build tools and the Windows SDK.
- WebView2 runtime, Git, Windows PowerShell 5.1 and `icacls`.
- Network access for the first build (npm packages, crates, and the NSIS toolchain Tauri downloads for the first installer).

For some tasks only:

- Python 3.9+, as `python`: `npm run source:package` and its test. Pillow: `scripts/generate-installer-assets.py`.
- Playwright Chromium for `npm run test:e2e`: `npx playwright install chromium`.

## Run and build

```powershell
npm ci
npm run desktop:dev                     # Vite on 127.0.0.1:1420 + the Debug app
npm run desktop:build                   # installer and executable
npm run tauri -- build --no-bundle      # executable only
```

- Outputs go to `<target>\release\` (`voxelight-launcher.exe`, and the installer under `bundle\nsis\`). `<target>` is `src-tauri\target` unless `CARGO_TARGET_DIR` or a Cargo config says otherwise; `node scripts/build-runtime.mjs --print-target-dir` prints it. Release builds use LTO and are slow.
- `npm run dev` starts only the Vite server; open `http://127.0.0.1:1420` in a browser. Every backend command fails there, so it is only good for layout work. On the Vite server, `?stress-locale` in the URL swaps every string for a padded pseudo-translation.
- `scripts\build.ps1` builds Release and prints each artifact's size and the first 16 hex digits of its SHA-256, with a log in `<target>\build-logs\`. Switches: `-NoBundle` (executable only), `-Clean` (remove `dist\` and old bundles first), `-CloseRunning -CloseRunningPath <exact path>` (close that running build output, waiting up to 15 s before ending it), `-PrepareSigning` (see [Releasing](#releasing)). If PowerShell refuses the unsigned script, run `scripts\build.cmd` with the same arguments; don't change the system execution policy.
- `scripts\desktop.ps1 -Action dev|build|check|test|sign` wraps the same tasks (`check`/`test` run `cargo check --locked` / `cargo test --locked`).
- Builds never write to `releases\`; that is part of [Releasing](#releasing).

## Built-in Client ID and CurseForge key

Releases are built with a Microsoft Client ID and a CurseForge API key compiled in. A build from a plain clone has neither; it still runs, and users can enter their own in Settings.

| Variable | Value |
| --- | --- |
| `VOXELIGHT_MS_CLIENT_ID` | Microsoft app registration's Client ID. Must be a UUID, or the build fails. |
| `VOXELIGHT_CF_API_KEY` | CurseForge API key, `$2a$10$` plus 53 characters. Any other value is ignored. |

Set them in the build environment, or in an `[env]` table in an untracked `src-tauri/.cargo/config.toml` (Cargo runs from `src-tauri`). Never commit them: `npm test` fails on a committed or historical `.cargo` config, a CurseForge key, or a UUID assigned to a client-ID name such as `VOXELIGHT_MS_CLIENT_ID`. It cannot recognise a bare Client ID, so never paste one into the repository.

The values are constants in the executable, readable by anyone who has it. A value the user enters in Settings takes precedence. To check that your build environment embeds them, run `cargo test --locked` in `src-tauri` with the same variables or config as the build, and `VOXELIGHT_EXPECT_BUILTIN` / `VOXELIGHT_EXPECT_CF_BUILTIN` set to `1` (must be embedded) or `0` (must not be). This checks the test build, not an existing executable.

## Low integrity label

On a checkout with a Windows Low mandatory label, new executables inherit it and start at Low integrity, where they cannot write user data. The npm and Tauri entry points reset the executable's own label to Medium before every development launch and after every build; no administrator rights, no directory changes.

For an older build or a copied installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/repair-build-integrity.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/repair-build-integrity.ps1 -Path '<path to the .exe>'
```

Without `-Path` it checks `src-tauri\target\debug` and `release`, the NSIS bundle there, and installers one level below `releases\`, but not a target directory configured elsewhere. A launcher that starts at Low integrity and cannot open its data directory says so, in Chinese or English by the Windows display language.

## Tests and checks

```powershell
npm run build
npm test
Push-Location src-tauri; cargo test --locked; Pop-Location
npm run test:e2e
npm run license:check
```

| Command | What it does |
| --- | --- |
| `npm test` | i18n check, design-token check, public guard, Vitest, Node unit tests (`tests/unit/*.test.mjs`). Needs the root of a Git checkout. |
| `npm run test:e2e` | Playwright against the Vite page with a faked Tauri IPC (`tests/e2e/fixtures.ts`), one worker, software WebGL. Uses port 1420; reuses a running server unless `CI` is set. `npm run test:design` runs only the design spec. |
| `npx playwright test -c tests/mem/mem.config.ts` | Memory-measurement harness, separate from the suites. |
| `python -m unittest tests/unit/test_source_package.py` | Source packager test; no npm script runs it. |
| `npm run check:msrv` | `cargo check --locked --all-targets` with the declared Rust version, in `src-tauri/target/msrv`. Skips if rustup or that toolchain is missing; `-- --strict` fails instead. Install with `rustup toolchain install 1.90 --profile minimal`. |
| `npm run audit:deps` | `npm audit` and `cargo audit` (or OSV-Scanner); `-- --only=npm` or `-- --only=cargo`. Needs the network. Any finding fails unless `scripts/advisory-allowlist.json` lists its exact `id` and `package` with a `reason` and an `expires` date (`YYYY-MM-DD`, UTC, inclusive). |
| `npm run license:check` | Compares the locked npm and Cargo graph with `licenses/`. Offline, but needs `npm ci` and a filled Cargo cache. |
| `npm run license:update` | Rebuilds `licenses/npm`, `cargo` and `toolchain` after a dependency change. Needs the network, Git and the NSIS toolchain from an earlier installer build. Never runs install scripts or invents copyright lines. |

**Public guard** (`scripts/check-public-secrets.mjs`, part of `npm test`) blocks what must not be published: `.cargo` configs, local tool workspace folders and files, internal process notes under `docs/`, unexpected dotfiles, images, fonts or archives outside `public/`, `src-tauri/icons/`, `src-tauri/installer/windows/assets/`, `tests/fixtures/`, `licenses/` and `docs/images/`, local user paths, Client IDs and CurseForge keys, and disallowed commit-message patterns. It also audits Git history for `.cargo` configs, excluded local folders, local paths, and commit messages.

## Source archive

`npm run source:package` writes `releases\<version>\VoxelightLauncher-<version>-source.zip` (`python scripts/package-source.py --output <file.zip>` for another path). It requires all version numbers and license declarations to agree, packs the files on disk (so run it from a clean checkout; untracked files in included folders are packed too), adds a `SOURCE_MANIFEST.json` with every file's SHA-256, and verifies the result. It includes the MiSans fonts with their license and leaves out dependencies, build outputs, user data, keys, certificates and the Steve and Alex textures.

To check a released source ZIP, extract it into an empty folder outside any Git checkout and run these in the `VoxelightLauncher-<version>` folder it creates:

```powershell
npm run source:check
npm ci
npm run tauri -- build --no-bundle --no-sign --debug -- --locked
```

`source:check` needs only Node. `npm test` needs Git history, so it runs only in a checkout.

## Versioning & Release Policy

Voxelight Launcher follows [Semantic Versioning 2.0.0](https://semver.org/):

- **Stable releases (`MAJOR.MINOR.PATCH`)**: e.g. `0.7.0`, `1.0.0`, tagged `v0.7.0`. Distributed via GitHub Releases and Gitee Releases with `prerelease: false` and offered automatically by the in-app updater on both channels.
- **Pre-releases (`MAJOR.MINOR.PATCH-(alpha|beta|rc).N`)**: e.g. `0.7.0-beta.1`, `0.7.0-rc.1`, tagged `v0.7.0-beta.1`. Published explicitly as a GitHub/Gitee Pre-release (`prerelease: true`). Users on the default **Stable** channel never receive pre-releases automatically; users who opt into the **Beta** update channel in **Settings → About** can update to newer pre-releases, and pre-release builds automatically graduate to the corresponding stable release (`0.7.0`) once published.
- **Version synchronization**: Every release manifest (`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`, `licenses/dependency-inventory.json`) must declare the exact same SemVer string. Use `npm run version:check` (also part of `npm run check`) to verify and `npm run version:set -- <version>` to bump all six files atomically.
- **Changelog**: Record user-visible changes under `CHANGELOG.md` (`[Unreleased]`) during development and move them under the version heading when cutting a tag.

## Releasing

1. Run `npm run version:set -- <version>` (e.g. `0.7.0-beta.1` for a pre-release or `0.7.0` for stable), update `CHANGELOG.md`, verify `npm run version:check`, and build the installer.
2. Optional signing: `scripts\build.ps1 -PrepareSigning` (with `-NoBundle` for the executable only) rebuilds into a fresh folder and writes a signing receipt. Then `scripts\desktop.ps1 -Action sign -CertificateThumbprint <thumbprint> -SigningReceipt <receipt>` signs with a certificate from the current user's store (no PFX or password) and timestamps through `timestamp.digicert.com`. It signs the standalone executable and the installer, not the copy inside the installer. Rebuild if a file in the receipt changes.
3. `node scripts/release-metadata.mjs --installer "<path>\Voxelight Launcher_<version>_x64-setup.exe" --out releases\<version>-installer` (add `--prerelease` for `-alpha.N` / `-beta.N` / `-rc.N` builds) copies the installer as `VoxelightLauncher-<version>-x64-setup.exe` and writes `update.json` from it.
4. `npm run source:package` from the same checkout.
5. `node scripts/prepare-release-assets.mjs --version <version> --installer releases\<version>-installer\VoxelightLauncher-<version>-x64-setup.exe --source releases\<version>\VoxelightLauncher-<version>-source.zip --out releases\<version>-assets` (add `--prerelease` for pre-releases).
6. Upload the four files to the GitHub and Gitee releases of `v<version>` (mark as Pre-release for `-alpha`/`-beta`/`-rc` tags): installer, source ZIP and `SHA256SUMS.txt` first, `update.json` last.

`release-metadata.mjs` and `prepare-release-assets.mjs` never upload, sign or run anything. By default the in-app auto-updater offers stable releases only, and offers pre-releases when the user opts into the **Beta** update channel in **Settings → About**; the installer must keep its fixed name and stay under 512 MiB.

## Smoke tests

**Run the installer tests only in a clean, dedicated Windows account or VM.** They refuse to start if a Voxelight installation is registered, but a temporary folder does not isolate Windows installer registration.

- `node scripts/smoke-install.mjs` installs a Release installer silently into a temporary folder, checks version, registration, license files and integrity label, reinstalls, repeats with `/UPDATE` and uninstalls, checking that the names in the real launcher data folder and the desktop and Start-menu shortcuts are unchanged. `SMOKE_INSTALLER` picks the installer (copy a Low-labelled one to a normal folder first); `SMOKE_REPORT` sets the report path.
- `scripts\verify-installer-ui.ps1 -Language English|SimpChinese [-Installer <path>] [-OutputDirectory <folder>]` drives the installer pages through Windows UI Automation.
- `node scripts/smoke-native.mjs` drives a Debug build from `npm run tauri -- build --debug --no-bundle` (build it right before; `desktop:dev` overwrites the same file) through WebView2 remote debugging, with its data under `src-tauri\target\native-<id>`. **It uses the real network** (Mojang, BMCLAPI, Modrinth, loader publishers) and launches real game instances; it installs a managed server but never accepts the EULA or starts it. Its UI checks look for Chinese labels, so Chinese (Simplified) must be the first Windows display language. `SMOKE_BINARY` picks the executable; `SMOKE_CACHE` names a game folder to copy the 1.20.1 client, libraries and assets from (such as an earlier run's `native-<id>\game`; without it they are read from `%APPDATA%\.minecraft`, never worlds or credentials); `SMOKE_CHECKS`, `SMOKE_REPORT` and `SMOKE_CDP_PORT` (default 9333) select checks, the report path and the debugging port. It refuses a Low-labelled executable.

Never point a test at your own launcher or game folders.

## Data directories for testing

- `VOXELIGHT_LAUNCHER_DATA_DIR` replaces `%LOCALAPPDATA%\dev.voxelight.launcher` and turns off the automatic fallback folder.
- `VOXELIGHT_LAUNCHER_GAME_DIR` replaces the game directory and is saved into the settings of the data directory in use; set both together to keep your own settings unchanged.
- `MINECRAFT_LAUNCHER_DATA_DIR` and `MINECRAFT_LAUNCHER_GAME_DIR` still work as older names. They migrate nothing and are not passed on when the launcher restarts after an update.
- Update downloads are always staged in `%LOCALAPPDATA%\dev.voxelight.launcher\updates`.
