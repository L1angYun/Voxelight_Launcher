param(
    [ValidateSet('dev', 'build', 'check', 'test', 'sign')][string]$Action = 'dev',
    [string]$CertificatePath,
    [string]$CertificateThumbprint,
    [SecureString]$CertificatePassword
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
function Invoke-SignArtifacts {
    if ([bool]$CertificatePath -eq [bool]$CertificateThumbprint) {
        throw 'Provide exactly one of CertificatePath or CertificateThumbprint; no certificate is selected automatically.'
    }
    $signTool = Get-SignTool
    $artifacts = @()
    $targetDir = & node.exe (Join-Path $taskRoot 'scripts\build-runtime.mjs') --print-target-dir
    if ($LASTEXITCODE -ne 0 -or -not $targetDir) { throw 'Could not resolve the Windows build output directory.' }
    $profileJson = & node.exe (Join-Path $taskRoot 'scripts\build-runtime.mjs') --print-artifact-dirs
    if ($LASTEXITCODE -ne 0) { throw 'Could not locate the Cargo artifact profile directories.' }
    foreach ($profile in @($profileJson | ConvertFrom-Json | ForEach-Object { $_ })) {
        $artifacts += Join-Path $profile 'voxelight-launcher.exe'
        $bundle = Join-Path $profile 'bundle\nsis'
        if (Test-Path -LiteralPath $bundle) {
            $artifacts += Get-ChildItem -LiteralPath $bundle -Filter '*-setup.exe' -File |
                ForEach-Object { $_.FullName }
        }
    }
    if (-not $artifacts) { throw "No Release executable or installer found below $targetDir. Run the build action first." }
    Write-Host 'Signing existing/cached Release candidates; no artifact is assumed to have been rebuilt.'
    $arguments = @('sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256')
    if ($CertificatePath) {
        if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
            throw "Certificate file does not exist: $CertificatePath"
        }
        $arguments += @('/f', $CertificatePath)
    } else {
        $arguments += @('/sha1', $CertificateThumbprint)
    }
    $plainPassword = $null
    $passwordHandle = [IntPtr]::Zero
    try {
        if ($CertificatePassword) {
            $passwordHandle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($CertificatePassword)
            $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordHandle)
            $arguments += @('/p', $plainPassword)
        }
        & $signTool @arguments @artifacts
        if ($LASTEXITCODE -ne 0) { throw "Signing failed (exit $LASTEXITCODE)" }
        foreach ($artifact in $artifacts) {
            & $signTool verify /pa /v $artifact
            if ($LASTEXITCODE -ne 0) { throw "Signature verification failed: $artifact" }
        }
    } finally {
        if ($passwordHandle -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordHandle)
        }
        $plainPassword = $null
    }
}
Push-Location -LiteralPath $taskRoot
try {
    switch ($Action) {
        'dev' { & npm.cmd run desktop:dev }
        'build' { & npm.cmd run desktop:build }
        'check' { & cargo check --manifest-path src-tauri/Cargo.toml --locked }
        'test' { & cargo test --manifest-path src-tauri/Cargo.toml --locked }
        'sign' { Invoke-SignArtifacts }
    }
    if ($LASTEXITCODE -ne 0) { throw "Launcher command failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
