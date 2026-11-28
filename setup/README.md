# Voxelight Setup

The launcher's Windows installer front end. Voxelight Setup embeds the NSIS
installer as its payload, shows the launcher-styled UI for an interactive
install, and passes NSIS command-line flags straight through for silent,
passive and self-update installs.

## Exit codes

- Any NSIS flag (`/S`, `/P`, `/UPDATE`, `/R`, `/D=`, ...): the embedded NSIS
  installer runs with the raw command line and Voxelight Setup returns its exit
  code unchanged.
- `2`: Voxelight Setup could not extract, verify or start the embedded
  installer before NSIS ran. This is deliberately distinct from NSIS exit code
  `1` ("the user cancelled"), and no error dialog is shown when `/S` is present.
- Interactive UI: `0` after the user closes the window.

The WebView2 user-data profile is created in a private temporary folder and is
removed after the WebView2 processes exit; Voxelight Setup never falls back to
`%LOCALAPPDATA%\dev.voxelight.setup`.
