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
- Replaced the stock welcome/finish composition with two native custom pages: task copy on the left, original optical voxel artwork on the right, and an explicit launch checkbox on completion.
- Added independently generated voxel terrarium/aperture artwork. No reference-brand or third-party installer artwork is used. Native file-copy progress and error handling remain intact.
- Preserved Tauri's template substitutions, WebView2 bootstrap, current-user
  registration, `/S`, `/D=...`, `/NS`, `/P`, `/UPDATE`, upgrade/reinstall and
  explicit-opt-in data deletion paths.

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
