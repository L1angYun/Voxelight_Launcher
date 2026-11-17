# SPDX-License-Identifier: GPL-3.0-only

function Get-VoxelightInstallerRegistryPaths([string]$ProductName) {
    return @{
        UninstallKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\$ProductName"
        VendorKeys = @("Software\voxelight\$ProductName", "Software\$ProductName\$ProductName")
    }
}

function Get-VoxelightInstallRegistration(
    [string]$ProductName,
    [hashtable]$Paths = (Get-VoxelightInstallerRegistryPaths $ProductName)
) {
    $uninstallKey = $Paths.UninstallKey
    $vendorKeys = $Paths.VendorKeys
    $views = if ([Environment]::Is64BitOperatingSystem) { @('Registry64', 'Registry32') } else { @('Default') }
    foreach ($hive in @('CurrentUser', 'LocalMachine')) {
        foreach ($view in $views) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
            try {
                $entry = $base.OpenSubKey($uninstallKey, $false)
                if ($entry) {
                    $entry.Dispose()
                    return "$hive/$view/$uninstallKey"
                }
                foreach ($vendorKey in $vendorKeys) {
                    $vendor = $base.OpenSubKey($vendorKey, $false)
                    if ($vendor) {
                        try {
                            # A remembered language is not an installation. NSIS
                            # records a previous install path as the default value.
                            if ($vendor.GetValue('', $null)) { return "$hive/$view/$vendorKey" }
                        } finally { $vendor.Dispose() }
                    }
                }
            } finally { $base.Dispose() }
        }
    }
}

function Assert-CleanInstallerAccount([string]$ProductName) {
    try {
        $registration = Get-VoxelightInstallRegistration $ProductName
    } catch {
        throw "Cannot verify the installer registration is absent. Do not run installer tests outside a clean, dedicated Windows account or VM. $($_.Exception.Message)"
    }
    if ($registration) {
        throw "Existing $ProductName installation registration: $registration. Installer tests require a clean, dedicated Windows account or VM."
    }
}
