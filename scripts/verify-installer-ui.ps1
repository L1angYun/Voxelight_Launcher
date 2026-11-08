# SPDX-License-Identifier: GPL-3.0-only
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("English", "SimpChinese")]
    [string]$Language,
    [string]$Installer,
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VoxelightNativeMethods {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
$project = Split-Path -Parent $PSScriptRoot
$targetDir = & node.exe (Join-Path $project 'scripts\build-runtime.mjs') --print-target-dir
if ($LASTEXITCODE -ne 0 -or -not $targetDir) { throw 'Could not resolve the Windows build output directory.' }
if (-not $Installer) {
    $config = Get-Content -Raw (Join-Path $project "src-tauri/tauri.conf.json") | ConvertFrom-Json
    $profileJson = & node.exe (Join-Path $project 'scripts\build-runtime.mjs') --print-artifact-dirs
    if ($LASTEXITCODE -ne 0) { throw 'Could not locate the Cargo artifact profile directories.' }
    $installerCandidates = @(@($profileJson | ConvertFrom-Json | ForEach-Object { $_ }) | ForEach-Object {
        $candidate = Join-Path $_ "bundle/nsis/Voxelight Launcher_$($config.version)_x64-setup.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate }
    })
    if ($installerCandidates.Count -ne 1) {
        throw "Expected one installer below $targetDir; found $($installerCandidates.Count). Supply -Installer with the intended artifact path."
    }
    $Installer = $installerCandidates[0]
}
$Installer = [IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
    throw "Installer not found: $Installer"
}

$runId = [Guid]::NewGuid().ToString("N")
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $targetDir "installer-ui-$Language-$runId"
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$target = Join-Path $env:LOCALAPPDATA "Temp/VoxelightLauncherUiSmoke-$runId"
$executable = Join-Path $target "voxelight-launcher.exe"
$uninstaller = Join-Path $target "uninstall.exe"
$protected = Join-Path $env:ProgramFiles "VoxelightLauncherProtectedSmoke-$runId"
$isolatedData = Join-Path $OutputDirectory "data"
$isolatedGame = Join-Path $OutputDirectory "game"
$realData = Join-Path $env:LOCALAPPDATA "dev.voxelight.launcher"
$installerRegistryPath = "Software\voxelight\Voxelight Launcher"
$registryBefore = $null
$env:VOXELIGHT_LAUNCHER_DATA_DIR = $isolatedData
$env:VOXELIGHT_LAUNCHER_GAME_DIR = $isolatedGame
New-Item -ItemType Directory -Force -Path $isolatedData, $isolatedGame | Out-Null
[IO.File]::WriteAllText((Join-Path $isolatedData "owned-state.json"), '{"preserve":true}')
[IO.File]::WriteAllText((Join-Path $isolatedGame "owned-game.txt"), "preserve isolated game data")

$copy = if ($Language -eq "English") {
    @{
        LanguageItem = "English"
        Welcome = "Install Voxelight Launcher"
        Options = "Installation options"
        Desktop = "Desktop shortcut"
        StartMenu = "Start menu shortcut"
        Finish = "Voxelight is ready"
        Installing = "Preparing Voxelight Launcher"
        InstallComplete = "Installation Complete"
        Maintenance = "Already Installed"
    }
} else {
    @{
        LanguageItem = "中文"
        Welcome = "安装 Voxelight Launcher"
        Options = "安装选项"
        Desktop = "桌面快捷方式"
        StartMenu = "开始菜单快捷方式"
        Finish = "Voxelight 已就绪"
        Installing = "正在准备 Voxelight Launcher"
        InstallComplete = "安装完成"
        Maintenance = "已安装"
    }
}

$report = [ordered]@{
    language = $Language
    installer = $Installer
    target = $target
    protectedPath = $protected
    screenshots = @()
    checks = @()
    cleanupError = $null
    registryRestoreError = $null
    success = $false
}
$startedProcesses = @()
$uninstallVerified = $false
$installCompleted = $false
$desktopLink = Join-Path ([Environment]::GetFolderPath("Desktop")) "Voxelight Launcher.lnk"
$startMenuLink = Join-Path ([Environment]::GetFolderPath("Programs")) "Voxelight Launcher.lnk"

function Get-Names([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @(Get-ChildItem -LiteralPath $Path -Force | ForEach-Object Name | Sort-Object)
}

function Reset-LanguageForTest {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($installerRegistryPath)
    try {
        if (-not $script:registryBefore) {
            $script:registryBefore = @{
                language = $key.GetValue("Installer Language", $null)
                installLocation = $key.GetValue("", $null)
            }
        }
        $key.DeleteValue("Installer Language", $false)
    } finally {
        $key.Close()
    }
}

function Restore-InstallerRegistry {
    if (-not $registryBefore) { return }
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($installerRegistryPath)
    try {
        if ($null -eq $registryBefore.language) {
            $key.DeleteValue("Installer Language", $false)
        } else {
            $key.SetValue("Installer Language", $registryBefore.language)
        }
        if ($null -eq $registryBefore.installLocation) {
            $key.DeleteValue("", $false)
        } else {
            $key.SetValue("", $registryBefore.installLocation)
        }
    } finally {
        $key.Close()
    }
}

function Get-LinkState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @{ exists = $false; sha256 = $null } }
    return @{ exists = $true; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash }
}

function Assert-LinkUnchanged([string]$Path, $Before) {
    $state = Get-LinkState $Path
    if ((ConvertTo-Json $state -Compress) -ne (ConvertTo-Json $Before -Compress)) {
        throw "Disabled shortcut option changed $Path"
    }
}

$realDataBefore = Get-Names $realData
$linksBefore = @{
    desktop = Get-LinkState $desktopLink
    startMenu = Get-LinkState $startMenuLink
}
$linkBackup = @{}
foreach ($path in @($desktopLink, $startMenuLink)) {
    if (Test-Path -LiteralPath $path) {
        $linkBackup[$path] = [IO.File]::ReadAllBytes($path)
    } else {
        $linkBackup[$path] = $null
    }
}

function Mark-Stage([string]$Stage) {
    $report.stage = $Stage
    Write-Host "[installer-ui] $Stage"
}

function Get-UiWindows([int]$ProcessId) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
        $ProcessId
    )
    $items = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        $condition
    )
    $result = @()
    foreach ($item in $items) { $result += $item }
    return $result
}

function Get-MainWindow([int]$ProcessId) {
    $windows = @(Get-UiWindows $ProcessId)
    $named = @($windows | Where-Object { $_.Current.Name -like "*Voxelight*" })
    if ($named.Count) { return $named[0] }
    if ($windows.Count) { return $windows[0] }
    return $null
}

function Wait-MainWindow([int]$ProcessId, [int]$Seconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $window = Get-MainWindow $ProcessId
        if ($window) { return $window }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for installer window (PID $ProcessId)"
}

function Find-Controls($Root, $ControlType) {
    if (-not $Root) { return @() }
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        $ControlType
    )
    $items = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $result = @()
    foreach ($item in $items) { $result += $item }
    return $result
}

function Find-Button([int]$ProcessId, [string]$AutomationId) {
    foreach ($window in @(Get-UiWindows $ProcessId)) {
        $button = @(Find-Controls $window ([System.Windows.Automation.ControlType]::Button) |
            Where-Object { $_.Current.AutomationId -eq $AutomationId }) | Select-Object -First 1
        if ($button) { return $button }
    }
    return $null
}

function Wait-Button([int]$ProcessId, [string]$AutomationId, [int]$Seconds = 15) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $button = Find-Button $ProcessId $AutomationId
        if ($button) { return $button }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for button $AutomationId"
}

function Find-FailureDialog([int]$ProcessId, [int]$MainHandle) {
    foreach ($candidate in @(Get-UiWindows $ProcessId)) {
        $errorText = @(Find-Controls $candidate ([System.Windows.Automation.ControlType]::Text) |
            Where-Object { $_.Current.AutomationId -eq "65535" -and $_.Current.Name }) | Select-Object -First 1
        if (-not $errorText) { continue }
        $buttons = @(Find-Controls $candidate ([System.Windows.Automation.ControlType]::Button))
        $button = @($buttons | Where-Object {
            $_.Current.AutomationId -eq "3" -and $_.Current.IsEnabled
        }) | Select-Object -First 1
        if (-not $button) {
            $button = @($buttons | Where-Object {
                $_.Current.AutomationId -eq "1" -and $_.Current.IsEnabled
            }) | Select-Object -First 1
        }
        if ($button) { return @{ window = $candidate; button = $button } }
    }
    return $null
}

function Invoke-Ui($Element) {
    Write-Host "[installer-ui] invoke $($Element.Current.ControlType.ProgrammaticName) '$($Element.Current.Name)' id=$($Element.Current.AutomationId) hwnd=$($Element.Current.NativeWindowHandle)"
    if ($Element.Current.NativeWindowHandle) {
        $root = [VoxelightNativeMethods]::GetAncestor([IntPtr]::new($Element.Current.NativeWindowHandle), 2)
        [VoxelightNativeMethods]::SetForegroundWindow($root) | Out-Null
        Start-Sleep -Milliseconds 100
    }
    $Element.SetFocus()
    [Windows.Forms.SendKeys]::SendWait(" ")
}

function Wait-Text($Window, [string]$Text, [int]$Seconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $match = @(Find-Controls $Window ([System.Windows.Automation.ControlType]::Text) |
            Where-Object { $_.Current.Name -like "*$Text*" }) | Select-Object -First 1
        if ($match) { return $match }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    $visible = @(Find-Controls $Window ([System.Windows.Automation.ControlType]::Text) |
        ForEach-Object { $_.Current.Name }) -join " | "
    throw "Text '$Text' not found. Visible text: $visible"
}

function Save-Screenshot($Window, [string]$Name) {
    $bounds = $Window.Current.BoundingRectangle
    if ($bounds.Width -lt 1 -or $bounds.Height -lt 1) { throw "Cannot screenshot an empty window" }
    $path = Join-Path $OutputDirectory "$Name.png"
    $bitmap = [Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)
    try {
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size)
        } finally {
            $graphics.Dispose()
        }
        $bitmap.Save($path, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $bitmap.Dispose()
    }
    $report.screenshots += $path
}

function Start-Installer([string]$TargetPath, [switch]$NoShortcuts) {
    Reset-LanguageForTest
    $arguments = @()
    if ($NoShortcuts) { $arguments += "/NS" }
    $arguments += "/D=`"$TargetPath`""
    $process = Start-Process -FilePath $Installer -ArgumentList $arguments -PassThru
    $script:startedProcesses += $process
    return $process
}

function Select-Language([System.Diagnostics.Process]$Process) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $combo = $null
    do {
        foreach ($window in @(Get-UiWindows $Process.Id)) {
            $combo = @(Find-Controls $window ([System.Windows.Automation.ControlType]::ComboBox)) | Select-Object -First 1
            if ($combo) { break }
        }
        if ($combo) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $combo) { throw "Language selection combo box was not shown" }

    $expand = $combo.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
    $expand.Expand()
    Start-Sleep -Milliseconds 400
    $items = @(Find-Controls $combo ([System.Windows.Automation.ControlType]::ListItem))
    $item = @($items | Where-Object { $_.Current.Name -like "*$($copy.LanguageItem)*" }) | Select-Object -First 1
    if (-not $item) {
        $names = @($items | ForEach-Object { $_.Current.Name }) -join " | "
        throw "Language '$Language' not available. Items: $names"
    }
    $selection = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $selection.Select()
    if (-not $selection.Current.IsSelected) { throw "Language item was not selected: $Language" }
    $expand.Collapse()
    Start-Sleep -Milliseconds 400
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $ok = Wait-Button $Process.Id "1"
        Invoke-Ui $ok
        $main = Wait-MainWindow $Process.Id
        try {
            Wait-Text $main $copy.Welcome 8 | Out-Null
            $report.checks += "language selector chose $Language"
            return $main
        } catch {
            if ($attempt -eq 2) { throw }
            Write-Host "[installer-ui] retry language confirmation"
            Start-Sleep -Milliseconds 400
        }
    }
}

function Set-Directory($Window, [string]$Path) {
    $edit = @(Find-Controls $Window ([System.Windows.Automation.ControlType]::Edit)) | Select-Object -First 1
    $maintenance = @(Find-Controls $Window ([System.Windows.Automation.ControlType]::Text) |
        Where-Object { $_.Current.Name -eq $copy.Maintenance }) | Select-Object -First 1
    if (-not $edit -and $maintenance) {
        Mark-Stage "conditional reinstall: choose Add/Reinstall"
        $radios = @(Find-Controls $Window ([System.Windows.Automation.ControlType]::RadioButton))
        if (-not $radios.Count) { throw "Reinstall choices were not found" }
        $selection = $radios[0].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if (-not $selection.Current.IsSelected) { $selection.Select() }
        Invoke-Ui (Wait-Button $Window.Current.ProcessId "1")
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $edit = @(Find-Controls $Window ([System.Windows.Automation.ControlType]::Edit)) | Select-Object -First 1
        } while (-not $edit -and [DateTime]::UtcNow -lt $deadline)
        $report.checks += "conditional reinstall page kept the existing installation and continued without uninstalling"
    }
    if (-not $edit) { throw "Install directory edit control not found" }
    $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue($Path)
    if ($value.Current.Value -ne $Path) { throw "Directory path was not applied" }
}

function Get-CheckBoxes($Window) {
    return @(Find-Controls $Window ([System.Windows.Automation.ControlType]::CheckBox))
}

function Set-Toggle($Element, [bool]$On) {
    $toggle = $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $desired = if ($On) { [System.Windows.Automation.ToggleState]::On } else { [System.Windows.Automation.ToggleState]::Off }
    Write-Host "[installer-ui] toggle '$($Element.Current.Name)' from $($toggle.Current.ToggleState) to $desired"
    if ($toggle.Current.ToggleState -ne $desired) { $toggle.Toggle() }
    if ($toggle.Current.ToggleState -ne $desired) { throw "Checkbox did not reach $desired" }
}

function Stop-Installer([System.Diagnostics.Process]$Process) {
    if (-not $Process -or $Process.HasExited) { return }
    try {
        $cancel = Find-Button $Process.Id "2"
        if ($cancel) {
            Invoke-Ui $cancel
            if ($Process.WaitForExit(3000)) { return }
            $yes = Wait-Button $Process.Id "6" 3
            Invoke-Ui $yes
        }
        if (-not $Process.WaitForExit(5000)) {
            $Process.Kill()
            $Process.WaitForExit()
        }
    } catch {
        if (-not $Process.HasExited) { $Process.Kill() }
    }
}

function Remove-OwnedLink([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Path)
    if ([IO.Path]::GetFullPath($shortcut.TargetPath) -eq [IO.Path]::GetFullPath($executable)) {
        Remove-Item -LiteralPath $Path -Force
    }
}

function Get-LinkTarget([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $shell = New-Object -ComObject WScript.Shell
    return [IO.Path]::GetFullPath($shell.CreateShortcut($Path).TargetPath)
}

function Assert-LinkTarget([string]$Path) {
    $target = Get-LinkTarget $Path
    if (-not $target -or $target -ne [IO.Path]::GetFullPath($executable)) {
        throw "Shortcut does not target the isolated executable: $Path -> $target"
    }
}

function Restore-Links {
    foreach ($path in @($desktopLink, $startMenuLink)) {
        $original = $linkBackup[$path]
        if ($null -ne $original) {
            [IO.File]::WriteAllBytes($path, $original)
        } else {
            Remove-OwnedLink $path
        }
    }
}

function Uninstall-Last {
    if ($uninstallVerified) { return }
    if (-not (Test-Path -LiteralPath $uninstaller)) {
        if ($installCompleted) { throw "The installed uninstaller is missing" }
        return
    }
    $process = Start-Process -FilePath $uninstaller -ArgumentList "/S" -WindowStyle Hidden -PassThru
    $process.WaitForExit(120000) | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ((Test-Path -LiteralPath $executable) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Test-Path -LiteralPath $executable) { throw "Uninstall left the test executable behind" }
    if ((Get-Content -Raw (Join-Path $isolatedData "owned-state.json")) -ne '{"preserve":true}') {
        throw "Uninstall changed isolated launcher data"
    }
    if ((Get-Content -Raw (Join-Path $isolatedGame "owned-game.txt")) -ne "preserve isolated game data") {
        throw "Uninstall changed isolated game data"
    }
    $after = Get-Names $realData
    if ((ConvertTo-Json $after -Compress) -ne (ConvertTo-Json $realDataBefore -Compress)) {
        throw "Real launcher data directory names changed"
    }
    $script:uninstallVerified = $true
    $report.checks += "uninstall ran last and preserved isolated fixtures and real data-directory names"
}

function Complete-InstallAndFinish($Process, $Window, [string]$InstallingShot, [string]$FinishShot) {
    $installCaptured = $false
    $installFilesAdvanced = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    Mark-Stage "install flow: wait for install/finish"
    do {
        $Window = Wait-MainWindow $Process.Id
        $finished = @(Find-Controls $Window ([System.Windows.Automation.ControlType]::Text) |
            Where-Object { $_.Current.Name -like "*$($copy.Finish)*" })
        if ($finished.Count) { break }
        $installing = @(Find-Controls $Window ([System.Windows.Automation.ControlType]::Text) |
            Where-Object { $_.Current.Name -like "*$($copy.Installing)*" })
        if ($installing.Count -and -not $installCaptured) {
            Save-Screenshot $Window $InstallingShot
            $installCaptured = $true
        }
        $installComplete = @(Find-Controls $Window ([System.Windows.Automation.ControlType]::Text) |
            Where-Object { $_.Current.Name -eq $copy.InstallComplete })
        if ($installComplete.Count -and -not $installFilesAdvanced) {
            if (-not $installCaptured) {
                Save-Screenshot $Window $InstallingShot
                $installCaptured = $true
            }
            Mark-Stage "install flow: file copy complete, open finish page"
            Invoke-Ui (Wait-Button $Process.Id "1")
            $installFilesAdvanced = $true
        }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline -and -not $Process.HasExited)
    Wait-Text $Window $copy.Finish 5 | Out-Null
    Mark-Stage "install flow: finish"
    foreach ($box in @(Get-CheckBoxes $Window)) { Set-Toggle $box $false }
    Save-Screenshot $Window $FinishShot
    Invoke-Ui (Wait-Button $Process.Id "1")
    if (-not $Process.WaitForExit(15000)) { throw "Finish did not close the installer" }
    if (-not (Test-Path -LiteralPath $executable)) { throw "Successful flow did not install the executable" }
    $script:installCompleted = $true
}

try {
    Mark-Stage "validate standard-user context"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this verification from a non-elevated shell; protected-path testing must not use administrator rights"
    }
    # 1. Verify the welcome page and its Cancel confirmation without installing.
    Mark-Stage "cancel flow: start"
    $process = Start-Installer $target -NoShortcuts
    $window = Select-Language $process
    Save-Screenshot $window "01-welcome"
    Mark-Stage "cancel flow: invoke Cancel"
    Invoke-Ui (Wait-Button $process.Id "2")
    if (-not $process.WaitForExit(3000)) {
        Invoke-Ui (Wait-Button $process.Id "6")
    }
    if (-not $process.WaitForExit(10000)) { throw "Cancel did not close the installer" }
    if (Test-Path -LiteralPath $executable) { throw "Cancel installed the application" }
    $report.checks += "Cancel closed setup before installation"

    # 2. Install into an owned directory using Tab and Space for both options.
    Mark-Stage "install flow: start"
    $process = Start-Installer $target -NoShortcuts
    $window = Select-Language $process
    Mark-Stage "install flow: welcome Next"
    Invoke-Ui (Wait-Button $process.Id "1")
    Set-Directory $window $target
    Save-Screenshot $window "02-location"
    Mark-Stage "install flow: location Next"
    Invoke-Ui (Wait-Button $process.Id "1")
    Wait-Text $window $copy.Options | Out-Null
    Mark-Stage "install flow: inspect options"
    $boxes = @(Get-CheckBoxes $window)
    $desktop = @($boxes | Where-Object { $_.Current.Name -like "*$($copy.Desktop)*" }) | Select-Object -First 1
    $startMenu = @($boxes | Where-Object { $_.Current.Name -like "*$($copy.StartMenu)*" }) | Select-Object -First 1
    if (-not $desktop -or -not $startMenu) {
        $names = @($boxes | ForEach-Object { $_.Current.Name }) -join " | "
        throw "Shortcut options not found: $names"
    }
    Set-Toggle $desktop $true
    Set-Toggle $startMenu $true
    Mark-Stage "install flow: keyboard desktop"
    $desktop.SetFocus()
    [Windows.Forms.SendKeys]::SendWait(" ")
    $desktopToggle = $desktop.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if ($desktopToggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) {
        throw "Space did not toggle the desktop checkbox"
    }
    Mark-Stage "install flow: keyboard Tab"
    [Windows.Forms.SendKeys]::SendWait("{TAB}")
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused.Current.Name -ne $startMenu.Current.Name) {
        throw "Tab did not move from desktop to Start menu option (focused: $($focused.Current.Name))"
    }
    Mark-Stage "install flow: keyboard Start menu"
    [Windows.Forms.SendKeys]::SendWait(" ")
    $startToggle = $startMenu.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if ($startToggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) {
        throw "Space did not toggle the Start menu checkbox"
    }
    $report.checks += "keyboard Tab and Space controlled both native shortcut checkboxes"
    Mark-Stage "install flow: desktop-only option"
    [Windows.Forms.SendKeys]::SendWait("+{TAB}")
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($focused.Current.Name -ne $desktop.Current.Name) {
        throw "Shift+Tab did not return to the desktop option"
    }
    [Windows.Forms.SendKeys]::SendWait(" ")
    if ($desktopToggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On -or
        $startToggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) {
        throw "Mixed desktop-only option was not applied"
    }
    Start-Sleep -Milliseconds 400
    Save-Screenshot $window "03-options"
    Mark-Stage "install flow: options Next"
    Invoke-Ui (Wait-Button $process.Id "1")

    Complete-InstallAndFinish $process $window "04-installing" "05-finish"
    Assert-LinkTarget $desktopLink
    Assert-LinkUnchanged $startMenuLink $linksBefore.startMenu
    $desktopAfterFirst = Get-LinkState $desktopLink
    $report.checks += "desktop-only install created the isolated desktop link and left Start menu unchanged"

    # 3. Reinstall with Start menu only, preserving the existing desktop link.
    Mark-Stage "start-menu-only reinstall: start"
    $process = Start-Installer $target -NoShortcuts
    $window = Select-Language $process
    Invoke-Ui (Wait-Button $process.Id "1")
    Set-Directory $window $target
    Invoke-Ui (Wait-Button $process.Id "1")
    Wait-Text $window $copy.Options | Out-Null
    $boxes = @(Get-CheckBoxes $window)
    $desktop = @($boxes | Where-Object { $_.Current.Name -like "*$($copy.Desktop)*" }) | Select-Object -First 1
    $startMenu = @($boxes | Where-Object { $_.Current.Name -like "*$($copy.StartMenu)*" }) | Select-Object -First 1
    Set-Toggle $desktop $false
    Set-Toggle $startMenu $true
    Invoke-Ui (Wait-Button $process.Id "1")
    Complete-InstallAndFinish $process $window "07-reinstall-installing" "08-reinstall-finish"
    Assert-LinkUnchanged $desktopLink $desktopAfterFirst
    Assert-LinkTarget $startMenuLink
    $report.checks += "Start-menu-only reinstall created its link and preserved the existing desktop link"

    # 4. A protected destination must fail in the same non-elevated process.
    Mark-Stage "protected flow: start"
    $process = Start-Installer $protected -NoShortcuts
    $window = Select-Language $process
    Invoke-Ui (Wait-Button $process.Id "1")
    Set-Directory $window $protected
    Invoke-Ui (Wait-Button $process.Id "1")
    Wait-Text $window $copy.Options | Out-Null
    foreach ($box in @(Get-CheckBoxes $window)) { Set-Toggle $box $false }
    Invoke-Ui (Wait-Button $process.Id "1")
    $failureWindow = $null
    $failureButton = $null
    $mainHandle = $window.Current.NativeWindowHandle
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $failure = Find-FailureDialog $process.Id $mainHandle
        if ($failure) {
            $failureWindow = $failure.window
            $failureButton = $failure.button
        }
        if ($failureButton -or $process.HasExited -or (Test-Path -LiteralPath (Join-Path $protected "voxelight-launcher.exe"))) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $failureButton -and -not $process.HasExited) {
        $failure = Find-FailureDialog $process.Id $mainHandle
        if ($failure) {
            $failureWindow = $failure.window
            $failureButton = $failure.button
        }
    }
    if ($failureWindow) { $window = $failureWindow }
    Save-Screenshot $window "06-protected-failure"
    if (Test-Path -LiteralPath (Join-Path $protected "voxelight-launcher.exe")) {
        throw "Protected path unexpectedly installed the application"
    }
    $protectedFailureObserved = $false
    if ($failureButton) {
        $protectedFailureObserved = $true
        if (-not $process.HasExited) { Invoke-Ui $failureButton }
    } elseif ($process.HasExited -and $process.ExitCode -ne 0) {
        $protectedFailureObserved = $true
    }
    if (-not $protectedFailureObserved) {
        throw "Protected path did not produce a visible failure"
    }
    Stop-Installer $process
    $report.checks += "protected path failed without administrator rights or an installed executable"

    # 5. Uninstall is deliberately last, after all install/failure flows.
    Mark-Stage "uninstall flow"
    Uninstall-Last
    if (-not $uninstallVerified) { throw "Uninstall was not verified" }
    $report.success = $true
} catch {
    $report.error = $_.Exception.Message
    $report.uiDiagnostics = @()
    try {
        foreach ($process in $startedProcesses) {
            if (-not $process -or $process.HasExited) { continue }
            $windowIndex = 0
            foreach ($window in @(Get-UiWindows $process.Id)) {
                $windowIndex++
                $controls = @()
                foreach ($type in @("Button", "Text", "ComboBox", "CheckBox", "Edit")) {
                    $controlType = [System.Windows.Automation.ControlType]::$type
                    foreach ($control in @(Find-Controls $window $controlType)) {
                        $controls += @{
                            type = $type
                            name = $control.Current.Name
                            automationId = $control.Current.AutomationId
                            enabled = $control.Current.IsEnabled
                        }
                    }
                }
                $report.uiDiagnostics += @{
                    processId = $process.Id
                    window = $window.Current.Name
                    controls = $controls
                }
                try { Save-Screenshot $window "error-$($process.Id)-$windowIndex" } catch { }
            }
        }
    } catch {
        $report.diagnosticError = $_.Exception.Message
    }
    Write-Error $report.error
} finally {
    foreach ($process in $startedProcesses) {
        if ($process -and -not $process.HasExited) { Stop-Installer $process }
    }
    try { Uninstall-Last } catch { $report.cleanupError = $_.Exception.Message }
    try { Restore-InstallerRegistry } catch { $report.registryRestoreError = $_.Exception.Message }
    Restore-Links
    if ($report.cleanupError -or $report.registryRestoreError) { $report.success = $false }
    if (-not $uninstallVerified) { $report.success = $false }
    $report.finishedAt = [DateTime]::UtcNow.ToString("o")
    $reportPath = Join-Path $OutputDirectory "report.json"
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 6))
    Write-Output "Installer UI report: $reportPath"
}

if (-not $report.success) { exit 1 }
$report | ConvertTo-Json -Depth 6
