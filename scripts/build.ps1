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
    Stop only a running executable at -CloseRunningPath instead of aborting. It first asks the
    window to close (WM_CLOSE) and waits up to 15 seconds; a launcher still
    running then is terminated. Anything unsaved is lost, and a Minecraft instance
    the launcher started keeps running on its own.

.PARAMETER Clean
    Delete dist\ and the previous bundles first. Slower; use when the frontend
    output looks stale.

.PARAMETER PrepareSigning
    Use a new Cargo output directory and record the exact unsigned outputs for
    the later desktop.ps1 -Action sign command. No signing is performed here.

.EXAMPLE
    .\scripts\build.ps1

    Full build: frontend + executable + NSIS installer.

.EXAMPLE
    .\scripts\build.ps1 -NoBundle -CloseRunning -CloseRunningPath '<exact path shown by the preflight>'

    Rebuild just the executable, closing the running launcher first.

.NOTES
    Exit code is the build's exit code (0 = success), so CI can call it.
#>
[CmdletBinding()]
param(
    [switch]$NoBundle,
    [switch]$CloseRunning,
    [string]$CloseRunningPath,
    [switch]$PrepareSigning,
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

$nodeCmd = (Get-Command node.exe -ErrorAction Stop).Source
$targetDir = & $nodeCmd (Join-Path $root 'scripts\build-runtime.mjs') --print-target-dir
if ($LASTEXITCODE -ne 0 -or -not $targetDir) { throw 'Could not resolve the Windows build output directory.' }
$previousTarget = $env:CARGO_TARGET_DIR
if ($PrepareSigning) {
    $signingRoot = Join-Path $targetDir 'signing-builds'
    foreach ($directory in @($targetDir, $signingRoot)) {
        if (-not (Test-Path -LiteralPath $directory)) {
            New-Item -ItemType Directory -Path $directory | Out-Null
        }
        $item = Get-Item -LiteralPath $directory
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to prepare signing under a redirected output directory: $directory"
        }
    }
    # New-Item without -Force also rejects a collision. Keep the child
    # short for MSVC-generated object and debug-record paths.
    $targetDir = Join-Path $signingRoot ([Guid]::NewGuid().ToString('N').Substring(0, 16))
    New-Item -ItemType Directory -Path $targetDir | Out-Null
    $env:CARGO_TARGET_DIR = $targetDir
}
try {
function Get-ArtifactDirectories {
    $json = & $nodeCmd (Join-Path $root 'scripts\build-runtime.mjs') --print-artifact-dirs
    if ($LASTEXITCODE -ne 0) { throw 'Could not locate the Cargo artifact profile directories.' }
    return @($json | ConvertFrom-Json | ForEach-Object { $_ })
}
$artifactDirectories = @(Get-ArtifactDirectories)
$exePaths = @($artifactDirectories | ForEach-Object { Join-Path $_ 'voxelight-launcher.exe' })
$bundleDirectories = @($artifactDirectories | ForEach-Object { Join-Path $_ 'bundle\nsis' })
$logDir = Join-Path $targetDir 'build-logs'
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
Write-Detail "target: $targetDir"
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
. (Join-Path $PSScriptRoot 'build-process-safety.ps1')
Stop-SelectedBuildLauncher -ExePaths $exePaths -CloseRunning:$CloseRunning -CloseRunningPath $CloseRunningPath

foreach ($exePath in $exePaths) {
    if (Test-FileLocked $exePath) {
        Write-Fail "$exePath is still locked by another process"
        Write-Host '  Usually an editor/antivirus scan or a second copy launched from Explorer.' -ForegroundColor Yellow
        Write-Host '  Check with: Get-Process | Where-Object { $_.Path -eq ' + "'$exePath' }" -ForegroundColor DarkGray
        exit 1
    }
}

# --------------------------------------------------------------------------
# Optional clean
# --------------------------------------------------------------------------
if ($Clean) {
    Write-Step 'Cleaning previous output'
    $distPath = [IO.Path]::GetFullPath((Join-Path $root 'dist'))
    $targetPrefix = [IO.Path]::GetFullPath($targetDir).TrimEnd('\') + '\'
    foreach ($path in @($distPath) + $bundleDirectories) {
        $resolvedPath = [IO.Path]::GetFullPath($path)
        if ($resolvedPath -ine $distPath -and -not $resolvedPath.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to clean an output outside the expected build directory: $resolvedPath"
        }
        if (Test-Path -LiteralPath $path) {
            if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing to clean a redirected output: $path" }
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

$tauriConfig = Get-Content -Raw -LiteralPath (Join-Path $root 'src-tauri\tauri.conf.json') | ConvertFrom-Json
$productName = [string]$tauriConfig.productName
$version = [string]$tauriConfig.version
$releaseSetupName = "VoxelightLauncher-$version-x64-setup.exe"
$rawNsisName = "{0}_{1}_x64-nsis.exe" -f $productName, $version
$tauriNsisName = "{0}_{1}_x64-setup.exe" -f $productName, $version

function Get-ExpectedInstallBytes([string]$LauncherExe) {
    [long]$sum = (Get-Item -LiteralPath $LauncherExe).Length + 1MB
    foreach ($relative in @('LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md')) {
        $file = Join-Path $root $relative
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $sum += (Get-Item -LiteralPath $file).Length
        }
    }
    $licensesDir = Join-Path $root 'licenses'
    if (Test-Path -LiteralPath $licensesDir -PathType Container) {
        foreach ($item in @(Get-ChildItem -LiteralPath $licensesDir -Recurse -File)) {
            $sum += $item.Length
        }
    }
    return $sum
}

# One child process per artifact. Under -File, a comma list after -Path reaches
# the child as separate arguments: only the first binds, and the child stops
# with "A positional parameter cannot be found" (exit 1).
function Repair-SetupArtifactIntegrity([string]$RepairScript, [string[]]$Targets, [string]$LogPath) {
    foreach ($repairTarget in $Targets) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $RepairScript -Path $repairTarget | Tee-Object -FilePath $LogPath -Append | Out-Host
        $repairCode = $LASTEXITCODE
        if ($repairCode -ne 0) {
            Write-Fail "Could not restore Medium integrity on $repairTarget (exit $repairCode)"
            return $repairCode
        }
    }
    return 0
}

if (-not $NoBundle) {
    Write-Step 'Building Voxelight Setup'
    $artifactDirectories = @(Get-ArtifactDirectories)
    $setupBuiltCount = 0

    $setupUiLauncher = Join-Path $env:TEMP ('voxelight-setup-ui-{0}.cmd' -f $PID)
    @(
        '@echo off',
        "`"$npmCmd`" run setup:build 2>&1"
    ) | Set-Content -LiteralPath $setupUiLauncher -Encoding ASCII
    & cmd.exe /c $setupUiLauncher | Tee-Object -FilePath $logPath -Append
    $setupUiCode = $LASTEXITCODE
    Remove-Item -LiteralPath $setupUiLauncher -Force -ErrorAction SilentlyContinue
    if ($setupUiCode -ne 0) {
        Write-Fail "Voxelight Setup frontend build exited with $setupUiCode"
        Write-Host "  full log: $logPath" -ForegroundColor DarkGray
        exit $setupUiCode
    }

    $setupManifest = Join-Path $root 'setup\src-tauri\Cargo.toml'
    $repairScript = Join-Path $root 'scripts\repair-build-integrity.ps1'
    $previousPayload = $env:VOXELIGHT_SETUP_PAYLOAD
    $previousExpected = $env:VOXELIGHT_SETUP_EXPECTED_INSTALL_BYTES
    $previousSetupTarget = $env:CARGO_TARGET_DIR
    try {
        $env:CARGO_TARGET_DIR = $targetDir
        foreach ($directory in $artifactDirectories) {
            $bundleDir = Join-Path $directory 'bundle\nsis'
            if (-not (Test-Path -LiteralPath $bundleDir -PathType Container)) {
                continue
            }

            # Only embed an NSIS installer written by this run. An older build,
            # possibly under another target triple, can leave a stale file in
            # bundle\nsis; wrapping that would ship the wrong payload.
            $freshArtifactJson = & $nodeCmd (Join-Path $root 'scripts\build-runtime.mjs') --fresh-nsis $bundleDir $tauriNsisName $rawNsisName $started.ToString('o')
            if ($LASTEXITCODE -ne 0) {
                Write-Fail 'Could not determine whether the NSIS installer was written by this build.'
                exit 1
            }
            $freshArtifact = if ($freshArtifactJson) { $freshArtifactJson | ConvertFrom-Json } else { $null }
            if (-not $freshArtifact) {
                Write-Detail "skipped NSIS installer not written by this build in $bundleDir"
                continue
            }
            $rawNsisPath = [string]$freshArtifact.path
            if ($freshArtifact.renameTo) {
                Move-Item -LiteralPath $rawNsisPath -Destination ([string]$freshArtifact.renameTo) -Force
                $rawNsisPath = [string]$freshArtifact.renameTo
            }
            if (-not (Test-Path -LiteralPath $rawNsisPath -PathType Leaf)) {
                continue
            }

            $expectedBytes = Get-ExpectedInstallBytes (Join-Path $directory 'voxelight-launcher.exe')
            $env:VOXELIGHT_SETUP_PAYLOAD = $rawNsisPath
            $env:VOXELIGHT_SETUP_EXPECTED_INSTALL_BYTES = [string]$expectedBytes

            $profileParent = [IO.Path]::GetFullPath((Split-Path -Parent $directory)).TrimEnd('\')
            $resolvedTargetDir = [IO.Path]::GetFullPath($targetDir).TrimEnd('\')
            $targetTriple = $null
            if ($profileParent -ine $resolvedTargetDir) {
                $targetTriple = Split-Path -Leaf $profileParent
            }

            # custom-protocol embeds dist\setup; without it the window loads the devUrl.
            $cargoArgs = @('build', '--release', '--offline', '--locked', '--features', 'custom-protocol', '--manifest-path', $setupManifest)
            if ($targetTriple) {
                $cargoArgs += @('--target', $targetTriple)
            }
            $cargoCmdLine = "`"$($cargo.Source)`" " + (($cargoArgs | ForEach-Object {
                if ($_ -match '\s') { "`"$_`"" } else { $_ }
            }) -join ' ') + ' 2>&1'
            $setupCargoLauncher = Join-Path $env:TEMP ('voxelight-setup-cargo-{0}.cmd' -f $PID)
            @('@echo off', $cargoCmdLine) | Set-Content -LiteralPath $setupCargoLauncher -Encoding ASCII
            & cmd.exe /c $setupCargoLauncher | Tee-Object -FilePath $logPath -Append
            $setupCargoCode = $LASTEXITCODE
            Remove-Item -LiteralPath $setupCargoLauncher -Force -ErrorAction SilentlyContinue
            if ($setupCargoCode -ne 0) {
                Write-Fail "Voxelight Setup Cargo build exited with $setupCargoCode"
                Write-Host "  full log: $logPath" -ForegroundColor DarkGray
                exit $setupCargoCode
            }

            $setupExe = Join-Path $directory 'voxelight-setup.exe'
            if (-not (Test-Path -LiteralPath $setupExe -PathType Leaf)) {
                throw "Voxelight Setup executable was not produced at $setupExe"
            }
            $releaseAssetPath = Join-Path $bundleDir $releaseSetupName
            Copy-Item -LiteralPath $setupExe -Destination $releaseAssetPath -Force
            $repairCode = Repair-SetupArtifactIntegrity -RepairScript $repairScript -Targets @($releaseAssetPath, $rawNsisPath) -LogPath $logPath
            if ($repairCode -ne 0) {
                exit $repairCode
            }
            $setupBuiltCount += 1
        }
    } finally {
        $env:VOXELIGHT_SETUP_PAYLOAD = $previousPayload
        $env:VOXELIGHT_SETUP_EXPECTED_INSTALL_BYTES = $previousExpected
        $env:CARGO_TARGET_DIR = $previousSetupTarget
    }
    if ($setupBuiltCount -eq 0) {
        Write-Fail "No NSIS installer written by this build was found to embed in Voxelight Setup. Refusing to wrap a stale payload."
        exit 1
    }
}

$elapsed = (Get-Date) - $started
Write-Step 'Done'
Write-Host ("    time:    {0:mm\:ss}" -f $elapsed) -ForegroundColor DarkGray
Write-Host ''

$artifacts = @()
$rawNsisArtifacts = @()
$artifactDirectories = @(Get-ArtifactDirectories)
foreach ($directory in $artifactDirectories) {
    $artifacts += Get-Item -LiteralPath (Join-Path $directory 'voxelight-launcher.exe')
    $bundleDir = Join-Path $directory 'bundle\nsis'
    if (-not $NoBundle -and (Test-Path -LiteralPath $bundleDir)) {
        $artifacts += Get-ChildItem -LiteralPath $bundleDir -Filter '*-setup.exe' -File
        $rawNsisArtifacts += Get-ChildItem -LiteralPath $bundleDir -Filter '*-nsis.exe' -File
    }
}
if ($artifacts.Count -eq 0) { throw 'No ordinary launcher build artifacts were found.' }
if ($PrepareSigning) {
    Write-Detail 'artifacts: fresh outputs in this signing build directory'
} else {
    Write-Detail 'artifacts: repaired existing/cached candidates; the Cargo build log identifies what was rebuilt'
}

foreach ($item in $artifacts) {
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    Write-Host ("  {0}" -f $item.Name) -ForegroundColor Green
    Write-Host ("    {0}  {1}  sha256 {2}" -f (Format-Size $item.Length), $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'), $hash.Substring(0, 16)) -ForegroundColor DarkGray
    Write-Host ("    {0}" -f $item.FullName) -ForegroundColor DarkGray
}
foreach ($item in $rawNsisArtifacts) {
    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
    Write-Host ("  {0} (raw NSIS payload for smoke tests)" -f $item.Name) -ForegroundColor Yellow
    Write-Host ("    {0}  {1}  sha256 {2}" -f (Format-Size $item.Length), $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'), $hash.Substring(0, 16)) -ForegroundColor DarkGray
    Write-Host ("    {0}" -f $item.FullName) -ForegroundColor DarkGray
}

if ($NoBundle) {
    Write-Host '  (executable only - any existing installer in bundle\nsis was left untouched)' -ForegroundColor Yellow
} elseif (@($artifacts | Where-Object Name -Like '*-setup.exe').Count -eq 0) {
    Write-Host '  (no installer produced - check the log for the bundling step)' -ForegroundColor Yellow
}
if ($PrepareSigning) {
    $receiptArguments = @((Join-Path $root 'scripts\signing-receipt.mjs'), 'create', $targetDir)
    if ($NoBundle) { $receiptArguments += '--no-bundle' }
    $receipt = & $nodeCmd @receiptArguments
    if ($LASTEXITCODE -ne 0 -or -not $receipt) { throw 'Could not record the exact signing build outputs.' }
    Write-Host "  signing receipt: $receipt"
}

Write-Host ''
Write-Host "  log: $logPath" -ForegroundColor DarkGray
exit 0
} finally {
    if ($PrepareSigning) { $env:CARGO_TARGET_DIR = $previousTarget }
}
