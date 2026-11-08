#Requires -Version 5.1
<#
.SYNOPSIS
    Restore Medium integrity on local launcher/setup executables only.
.DESCRIPTION
    Does not elevate, recurse, change directory labels, or grant permissions.
    With no -Path, checks this checkout's legacy debug/release outputs and
    releases/<version>/*-setup.exe. Normal npm/Tauri builds perform this repair
    automatically before development launches and after successful builds.
.EXAMPLE
    powershell -File scripts/repair-build-integrity.ps1
.EXAMPLE
    powershell -File scripts/repair-build-integrity.ps1 -Path 'C:\Downloads\Voxelight-setup.exe'
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param([string[]]$Path)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This repair is only available on Windows.' }
$checkoutRoot = Split-Path -Parent $PSScriptRoot
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
if (-not (Test-Path -LiteralPath $icacls -PathType Leaf)) { throw 'Windows icacls.exe was not found.' }

if (-not $PSBoundParameters.ContainsKey('Path')) {
    $Path = @()
    foreach ($relative in @('src-tauri\target\debug\voxelight-launcher.exe', 'src-tauri\target\release\voxelight-launcher.exe')) {
        $candidate = Join-Path $checkoutRoot $relative
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $Path += $candidate }
    }
    $setupDirectories = @((Join-Path $checkoutRoot 'src-tauri\target\release\bundle\nsis'))
    $releaseRoot = Join-Path $checkoutRoot 'releases'
    if (Test-Path -LiteralPath $releaseRoot -PathType Container) {
        $releaseRootItem = Get-Item -LiteralPath $releaseRoot
        if ($releaseRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a redirected releases directory.' }
        $setupDirectories += Get-ChildItem -LiteralPath $releaseRoot -Directory |
            Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
            ForEach-Object { $_.FullName }
    }
    foreach ($directory in $setupDirectories) {
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) { continue }
        $item = Get-Item -LiteralPath $directory
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a redirected output directory: $directory" }
        $Path += Get-ChildItem -LiteralPath $directory -Filter '*-setup.exe' -File | ForEach-Object { $_.FullName }
    }
}
if (-not $Path -or $Path.Count -eq 0) { throw 'No launcher or setup executables found. Supply -Path with an existing .exe file.' }

# Validate the complete list before changing anything. Literal paths never
# expand wildcards; directories and links cannot turn this into an ACL sweep.
$artifacts = @($Path | ForEach-Object {
    $item = Get-Item -LiteralPath $_ -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Extension -ine '.exe' -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Only ordinary .exe files can be repaired: $_"
    }
    $item.FullName
} | Select-Object -Unique)

foreach ($artifact in $artifacts) {
    if ($PSCmdlet.ShouldProcess($artifact, 'Set this executable integrity label to Medium')) {
        & $icacls $artifact /setintegritylevel medium
        if ($LASTEXITCODE -ne 0) { throw "Could not set Medium integrity on executable: $artifact (icacls exit $LASTEXITCODE). No elevation or directory changes were attempted." }
        Write-Output "Medium integrity: $artifact"
    }
}
