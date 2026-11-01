#Requires -Version 5.1
<#
.SYNOPSIS
    Release build for Voxelight Launcher (Rust + Tauri).

.DESCRIPTION
    One entry point for "build the app". It wraps `npm run tauri build` so the
    build works from any shell, and fails fast with an actionable message
    instead of three minutes into cargo.

    What it adds over calling tauri directly:
      * puts the rustup toolchain (%USERPROFILE%\.cargo\bin) on PATH, which is
        NOT on this machine's default PATH
      * preflights Rust / MSVC / node / npm before compiling
      * refuses to start while a built launcher is running and locking
        target\release\voxelight-launcher.exe (or closes it with -CloseRunning)
      * streams everything to target\build-logs\build-<timestamp>.log
      * prints artifacts with size and SHA256 when it finishes

.PARAMETER NoBundle
    Executable only (`tauri build --no-bundle`). Skips the NSIS installer.

.PARAMETER CloseRunning
    Stop a running voxelight-launcher instead of aborting. It first asks the
    window to close (WM_CLOSE); this app hides to the tray instead of exiting,
    so it is then terminated. Anything unsaved is lost, and a Minecraft instance
    the launcher started keeps running on its own.

.PARAMETER Clean
    Delete dist\ and the previous bundles first. Slower; use when the frontend
    output looks stale.

.EXAMPLE
    .\scripts\build.ps1

    Full build: frontend + executable + NSIS installer.

.EXAMPLE
    .\scripts\build.ps1 -NoBundle -CloseRunning

    Rebuild just the executable, closing the running launcher first.

.NOTES
    Exit code is the build's exit code (0 = success), so CI can call it.
#>
[CmdletBinding()]
param(
    [switch]$NoBundle,
    [switch]$CloseRunning,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$started = Get-Date

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $root 'src-tauri\tauri.conf.json'))) {
    throw "Not a Voxelight Launcher checkout: $root"
}

# npm/tauri resolve package.json from the working directory, so the build must
# not inherit wherever the caller happened to be.
Set-Location -LiteralPath $root

$exePath = Join-Path $root 'src-tauri\target\release\voxelight-launcher.exe'
$bundleDir = Join-Path $root 'src-tauri\target\release\bundle\nsis'
$logDir = Join-Path $root 'src-tauri\target\build-logs'
$logPath = Join-Path $logDir ('build-{0}.log' -f $started.ToString('yyyyMMdd-HHmmss'))

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Detail([string]$Message) {
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Fail([string]$Message) {
    Write-Host ''
    Write-Host "BUILD FAILED: $Message" -ForegroundColor Red
}

function Format-Size([long]$Bytes) {
    if ($Bytes -ge 1MB) { return '{0:N2} MB' -f ($Bytes / 1MB) }
    if ($Bytes -ge 1KB) { return '{0:N0} KB' -f ($Bytes / 1KB) }
    return "$Bytes B"
}

function Test-FileLocked([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $stream = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
        $stream.Close()
        return $false
    } catch {
        return $true
    }
}

# --------------------------------------------------------------------------
# Preflight
# --------------------------------------------------------------------------
Write-Host ''
Write-Host 'Voxelight Launcher - release build' -ForegroundColor White
Write-Detail "root:   $root"
Write-Detail "mode:   $(if ($NoBundle) { 'executable only' } else { 'executable + NSIS installer' })"

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe')) {
    if (($env:PATH -split ';') -notcontains $cargoBin) {
        $env:PATH = $cargoBin + ';' + $env:PATH
    }
}

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    Write-Fail 'Rust toolchain not found.'
    Write-Host '  Install the stable MSVC toolchain from https://rustup.rs/ and re-run.' -ForegroundColor Yellow
    Write-Host "  (expected at $cargoBin)" -ForegroundColor DarkGray
    exit 1
}
$rustc = Get-Command rustc -ErrorAction SilentlyContinue
Write-Detail "rust:   $(& $rustc.Source -V 2>&1) / $(& $cargo.Source -V 2>&1)"

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$msvcOk = $false
if (Test-Path -LiteralPath $vswhere) {
    $msvcPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($msvcPath) {
        $msvcOk = $true
        Write-Detail "msvc:   $msvcPath"
    }
}
if (-not $msvcOk) {
    Write-Host '    msvc:   NOT FOUND - link.exe comes from "Desktop development with C++"; the Rust link step will fail' -ForegroundColor Yellow
}

$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCmd) {
    Write-Fail 'npm.cmd not found on PATH.'
    exit 1
}
$nodeCmd = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
Write-Detail "node:   $(& $nodeCmd -v 2>&1) ($nodeCmd)"

if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\@tauri-apps\cli'))) {
    Write-Fail 'node_modules is missing the Tauri CLI. Run `npm install` first.'
    exit 1
}

# --------------------------------------------------------------------------
# The build cannot replace the exe while it is running
# --------------------------------------------------------------------------
$running = @(Get-Process -Name 'voxelight-launcher' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    $list = ($running | ForEach-Object { "$($_.ProcessName) (pid $($_.Id))" }) -join ', '
    if (-not $CloseRunning) {
        Write-Fail "a launcher is running and locks $exePath"
        Write-Host "  running: $list" -ForegroundColor Yellow
        Write-Host '  Close it, or re-run with -CloseRunning to close it for you.' -ForegroundColor Yellow
        exit 1
    }
    Write-Step "Closing $list"
    foreach ($proc in $running) {
        $null = $proc.CloseMainWindow()
        if ($proc.WaitForExit(15000)) {
            Write-Detail "pid $($proc.Id) exited"
            continue
        }
        # The launcher intercepts CloseRequested (hides to the tray instead of
        # exiting), so WM_CLOSE alone never ends the process. -CloseRunning was
        # explicit consent to stop it, so fall back to terminating it.
        Write-Detail "pid $($proc.Id) ignored WM_CLOSE (hides to tray); terminating"
        try { $proc.Kill() } catch { }
        if (-not $proc.WaitForExit(15000)) {
            Write-Fail "pid $($proc.Id) could not be terminated"
            Write-Host '  Close it from Task Manager, then re-run.' -ForegroundColor Yellow
            exit 1
        }
        Write-Detail "pid $($proc.Id) terminated"
    }
}

if (Test-FileLocked $exePath) {
    Write-Fail "$exePath is still locked by another process"
    Write-Host '  Usually an editor/antivirus scan or a second copy launched from Explorer.' -ForegroundColor Yellow
    Write-Host '  Check with: Get-Process | Where-Object { $_.Path -eq ' + "'$exePath' }" -ForegroundColor DarkGray
    exit 1
}

# --------------------------------------------------------------------------
# Optional clean
# --------------------------------------------------------------------------
if ($Clean) {
    Write-Step 'Cleaning previous output'
    foreach ($path in @((Join-Path $root 'dist'), $bundleDir)) {
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Recurse -Force
            Write-Detail "removed $path"
        }
    }
}

# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------
if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$tauriArgs = 'build'
if ($NoBundle) { $tauriArgs = 'build --no-bundle' }

# Run through a scratch .cmd so npm's stderr stays plain text and PowerShell
# does not turn it into terminating NativeCommandError records.
$launcher = Join-Path $env:TEMP ('voxelight-build-{0}.cmd' -f $PID)
@(
    '@echo off',
    "`"$npmCmd`" run tauri -- $tauriArgs 2>&1"
) | Set-Content -LiteralPath $launcher -Encoding ASCII

$header = @(
    "# Voxelight Launcher build log",
    "# started: $($started.ToString('yyyy-MM-dd HH:mm:ss'))",
    "# root:    $root",
    "# cargo:   $(& $cargo.Source -V 2>&1)",
    "# rustc:   $(& $rustc.Source -V 2>&1)",
    "# node:    $(& $nodeCmd -v 2>&1)",
    "# command: npm run tauri -- $tauriArgs",
    ''
)
# Let Tee-Object create the file so the header and the streamed build output
# share one encoding (Windows PowerShell 5.1 Tee has no -Encoding switch).
$header | Tee-Object -FilePath $logPath | Out-Null

Write-Step "Building (log: $logPath)"

& cmd.exe /c $launcher | Tee-Object -FilePath $logPath -Append
$code = $LASTEXITCODE
Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue

# --------------------------------------------------------------------------
# Result
# --------------------------------------------------------------------------
$elapsed = (Get-Date) - $started
if ($code -ne 0) {
    Write-Fail "tauri build exited with $code (after $([int]$elapsed.TotalSeconds)s)"
    $tail = Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue |
        Select-String -Pattern 'error(\[|:)|npm error|failed to|aborting creation process' |
        Select-Object -Last 6
    if ($tail) {
        Write-Host ''
        Write-Host '  last errors:' -ForegroundColor Yellow
        foreach ($line in $tail) { Write-Host "    $($line.Line.Trim())" -ForegroundColor Yellow }
    }
    Write-Host ''
    Write-Host "  full log: $logPath" -ForegroundColor DarkGray
    exit $code
}

Write-Step 'Done'
Write-Host ("    time:    {0:mm\:ss}" -f $elapsed) -ForegroundColor DarkGray
Write-Host ''

$artifacts = @()
if (Test-Path -LiteralPath $exePath) { $artifacts += Get-Item -LiteralPath $exePath }
if (-not $NoBundle -and (Test-Path -LiteralPath $bundleDir)) {
    $artifacts += Get-ChildItem -LiteralPath $bundleDir -Filter '*-setup.exe' -File |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

foreach ($item in $artifacts) {
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    Write-Host ("  {0}" -f $item.Name) -ForegroundColor Green
    Write-Host ("    {0}  {1}  sha256 {2}" -f (Format-Size $item.Length), $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'), $hash.Substring(0, 16)) -ForegroundColor DarkGray
    Write-Host ("    {0}" -f $item.FullName) -ForegroundColor DarkGray
}

if ($NoBundle) {
    Write-Host '  (executable only - any existing installer in bundle\nsis was left untouched)' -ForegroundColor Yellow
} elseif (-not (Test-Path -LiteralPath $bundleDir)) {
    Write-Host '  (no installer produced - check the log for the bundling step)' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "  log: $logPath" -ForegroundColor DarkGray
exit 0
