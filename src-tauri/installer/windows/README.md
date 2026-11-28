# Voxelight Launcher NSIS template

The installer template and its two NSIS helper files were vendored from the
Tauri repository and then modified for Voxelight Launcher.

- Upstream release: `tauri-cli-v2.12.4`
- Upstream commit: `993038c49185307dfc895ab7657d77ca0d5ed7c7`
- Source directory: `crates/tauri-bundler/src/bundle/windows/nsis/`
- Source URL: <https://github.com/tauri-apps/tauri/tree/993038c49185307dfc895ab7657d77ca0d5ed7c7/crates/tauri-bundler/src/bundle/windows/nsis>
- Upstream license: Apache License 2.0 OR MIT, Copyright (c) 2017 - Present
  Tauri Apps Contributors.

The corresponding license texts are distributed with the application in
`licenses/npm/tauri-apps--cli@2.12.4/LICENSE-APACHE-2.0` and
`licenses/npm/tauri-apps--cli@2.12.4/LICENSE-MIT`.

## Voxelight changes

- Replaced the license/start-menu pages with a five-step welcome, location,
  options, installation and finish flow. License texts remain installed as
  resources; no separate license acceptance is implied.
- Added native, keyboard-accessible shortcut options and localized page copy.
- Replaced the stock welcome/finish composition with two native custom pages: task copy on the left, the launcher's own world on the right, and an explicit launch checkbox on completion.
- The pages use the launcher's light-theme colors and accent, and the app icon. The artwork is a frame of the launcher's Massif world scene (the world canvas alone, rendered by the app upright), kept as `assets/source/massif-dark.png`; `scripts/generate-installer-assets.py` makes the bitmaps from it and the icons from `src-tauri/icons/icon.ico`. No reference-brand or third-party installer artwork is used. Native file-copy progress and error handling remain intact.
- Preserved Tauri's template substitutions, WebView2 bootstrap, current-user
  registration, `/S`, `/D=...`, `/NS`, `/P`, `/UPDATE`, upgrade/reinstall and
  explicit-opt-in data deletion paths.
- Only restores the remembered install folder when it still contains
  `${MAINBINARYNAME}.exe`; a stale remembered path (for example from a silent
  smoke-test uninstall) no longer replaces the default install directory.
  Reinstall/update uninstall flows use the validated `$INSTDIR`.
- Built-in MUI pages use Segoe UI for English and Microsoft YaHei UI for
  Simplified Chinese instead of the language-file defaults (SimSun for
  SimpChinese). The branding line reads "Voxelight Launcher" in the small UI
  font on both installer and uninstaller pages.
- `scripts/smoke-install.mjs` and `scripts/verify-installer-ui.ps1` snapshot the
  remembered install-location registry key before installing, restore its exact
  previous state after uninstalling, remove their temporary target folder, and
  report that the remembered location no longer points at that target.

`VoxelightPages.nsh`, both files under `languages/`, and the assets under
`assets/` are Voxelight additions. `installer.nsi`, `utils.nsh`, and
`FileAssociation.nsh` contain upstream code and carry the upstream license
above; their Voxelight modifications are recorded here as required by Apache
License 2.0 section 4(b).

Tauri only writes its generated template and upstream helpers into the NSIS
build directory. `VoxelightPages.nsh` is therefore passed through the existing
`installerHooks` configuration solely as a canonical absolute include. It does
not register `NSIS_HOOK_*` macros, and no build-output-relative include path is
required.
