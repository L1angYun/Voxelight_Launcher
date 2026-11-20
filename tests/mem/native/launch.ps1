param([string]$Name, [string]$Effects = 'full', [string]$ExtraArgs = '', [switch]$Maximize, [string]$Exe = "$env:TEMP\vx-mem\voxelight-launcher.exe")
# Starts the launcher with an isolated temp data/game dir and a CDP port (9333). Writes pid.txt in the run dir.
$run = "$env:TEMP\vx-mem\$Name"; New-Item -ItemType Directory -Force "$run\data", "$run\game" | Out-Null
if ($Effects -eq 'lite') { [IO.File]::WriteAllText("$run\data\state.json", '{"config":{"effects":"lite"}}', (New-Object Text.UTF8Encoding $false)) }
$env:VOXELIGHT_LAUNCHER_DATA_DIR = "$run\data"; $env:VOXELIGHT_LAUNCHER_GAME_DIR = "$run\game"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = ("--remote-debugging-port=9333 " + $ExtraArgs).Trim()
$p = Start-Process $Exe -PassThru -RedirectStandardError "$run\stderr.log" -RedirectStandardOutput "$run\stdout.log"
$p.Id | Set-Content "$run\pid.txt"
for ($i = 0; $i -lt 60 -and $p.MainWindowHandle -eq 0; $i++) { Start-Sleep -Milliseconds 500; $p.Refresh() }
if ($Maximize) {
  Add-Type -Namespace V -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'
  [V.U]::ShowWindow($p.MainWindowHandle, 3) | Out-Null
}
"started $Name pid=$($p.Id) args='$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS' maximize=$Maximize"
