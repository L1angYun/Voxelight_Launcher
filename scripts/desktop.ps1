param(
    [ValidateSet('dev', 'build', 'check', 'test', 'sign')][string]$Action = 'dev',
    [string]$CertificateThumbprint,
    [string]$SigningReceipt
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskCargo = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath (Join-Path $taskCargo 'cargo.exe')) {
    $env:PATH = $taskCargo + ';' + $env:PATH
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Rust is required. Install the stable MSVC toolchain from https://rustup.rs/'
}
function Get-SignTool {
    $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $candidate = Get-ChildItem -LiteralPath $sdk -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' |
            Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
    }
    if (-not $candidate) { throw 'signtool.exe is required from the Windows SDK.' }
    return $candidate
}
function Invoke-CargoAction([string]$CargoAction) {
    Push-Location -LiteralPath (Join-Path $taskRoot 'src-tauri')
    try {
        & cargo $CargoAction --locked
        if ($LASTEXITCODE -ne 0) { throw "Cargo $CargoAction failed (exit $LASTEXITCODE)" }
    } finally { Pop-Location }
}
function Invoke-SignArtifacts {
    if ($CertificateThumbprint -notmatch '^[a-f0-9]{40}$' -or -not $SigningReceipt) {
        throw 'Provide -CertificateThumbprint for a certificate in the current-user certificate store and -SigningReceipt from build.ps1 -PrepareSigning.'
    }
    $receiptJson = & node.exe (Join-Path $taskRoot 'scripts\signing-receipt.mjs') read $SigningReceipt
    if ($LASTEXITCODE -ne 0 -or -not $receiptJson) { throw 'Signing receipt validation failed.' }
    $artifacts = @($receiptJson | ConvertFrom-Json | ForEach-Object { $_ })
    if (-not $artifacts) { throw 'Signing receipt has no validated artifacts.' }
    $signTool = Get-SignTool
    Write-Host 'Signing the exact outputs of the recorded build.'
    $arguments = @('sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256', '/s', 'My', '/sha1', $CertificateThumbprint)
    & $signTool @arguments @artifacts
    if ($LASTEXITCODE -ne 0) { throw "Signing failed (exit $LASTEXITCODE)" }
    foreach ($artifact in $artifacts) {
        & $signTool verify /pa /v $artifact
        if ($LASTEXITCODE -ne 0) { throw "Signature verification failed: $artifact" }
    }
}
Push-Location -LiteralPath $taskRoot
try {
    switch ($Action) {
        'dev' { & npm.cmd run desktop:dev }
        'build' { & npm.cmd run desktop:build }
        'check' { Invoke-CargoAction 'check' }
        'test' { Invoke-CargoAction 'test' }
        'sign' { Invoke-SignArtifacts }
    }
    if ($LASTEXITCODE -ne 0) { throw "Launcher command failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
