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
    $binary = Join-Path $taskRoot 'src-tauri\target\release\voxelight-launcher.exe'
    if (Test-Path -LiteralPath $binary) { $artifacts += $binary }
    $bundle = Join-Path $taskRoot 'src-tauri\target\release\bundle\nsis'
    if (Test-Path -LiteralPath $bundle) {
        $artifacts += Get-ChildItem -LiteralPath $bundle -Filter '*-setup.exe' -File |
            ForEach-Object { $_.FullName }
    }
    if (-not $artifacts) { throw 'No Release executable or installer found. Run the build action first.' }
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
    if ($Action -eq 'dev' -and -not $env:CARGO_TARGET_DIR) {
        $buildDirectory = Join-Path $taskRoot 'src-tauri\target'
        $checkedDirectories = @($taskRoot)
        if (Test-Path -LiteralPath $buildDirectory) { $checkedDirectories += $buildDirectory }
        $lowIntegrity = $checkedDirectories | ForEach-Object {
            & icacls.exe $_
        } | Select-String -SimpleMatch 'Low Mandatory Level'
        if ($lowIntegrity) {
            $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'Temp\VoxelightLauncher\build'
            New-Item -ItemType Directory -Path $env:CARGO_TARGET_DIR -Force | Out-Null
            $runtimeIntegrity = & icacls.exe $env:CARGO_TARGET_DIR | Out-String
            if ($runtimeIntegrity.Contains('Low Mandatory Level')) {
                throw 'The runtime build directory has a Low mandatory label. Choose a normal writable CARGO_TARGET_DIR; do not weaken ACLs or integrity labels.'
            }
            Write-Host "Low integrity labels are inherited by the project build directory. Development output: $env:CARGO_TARGET_DIR (ACLs and integrity labels are unchanged)."
        }
    }
    switch ($Action) {
        'dev' { & npm.cmd run desktop:dev }
        'build' { & npm.cmd run desktop:build }
        'check' { & cargo check --manifest-path src-tauri/Cargo.toml --locked }
        'test' { & cargo test --manifest-path src-tauri/Cargo.toml --locked }
        'sign' { Invoke-SignArtifacts }
    }
    if ($LASTEXITCODE -ne 0) { throw "Launcher command failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }
