# SPDX-License-Identifier: GPL-3.0-only

function Resolve-LauncherProcessPath($Process) {
    try {
        if ($Process.Path) { return [IO.Path]::GetFullPath($Process.Path) }
    } catch {
        # Inaccessible or exited processes are never candidates for closing.
        # The later exact-path file lock check will still protect the build.
    }
}

function Get-BuildLaunchers([string[]]$ExePaths) {
    $expected = @($ExePaths | ForEach-Object { [IO.Path]::GetFullPath($_) })
    foreach ($process in @(Get-Process -Name 'voxelight-launcher' -ErrorAction SilentlyContinue)) {
        $path = Resolve-LauncherProcessPath $process
        if ($path -and $path -iin $expected) { $process }
    }
}

function Stop-SelectedBuildLauncher([string[]]$ExePaths, [switch]$CloseRunning, [string]$CloseRunningPath) {
    $running = @(Get-BuildLaunchers $ExePaths)
    if ($CloseRunning -and -not $CloseRunningPath) {
        $candidates = $running | ForEach-Object { "pid $($_.Id): $(Resolve-LauncherProcessPath $_)" }
        throw ("-CloseRunning needs -CloseRunningPath with the exact build executable path. " + ($candidates -join '; '))
    }
    if ($CloseRunningPath -and -not $CloseRunning) { throw 'Use -CloseRunning with -CloseRunningPath to request a close.' }
    if (-not $running) { return }
    $selected = if ($CloseRunningPath) { [IO.Path]::GetFullPath($CloseRunningPath) } else { $null }
    $list = ($running | ForEach-Object { "pid $($_.Id): $(Resolve-LauncherProcessPath $_)" }) -join '; '
    # Never stop some of them and then discover another executable still blocks
    # the build. The operator can name one exact path or close the others first.
    if (-not $CloseRunning -or @($running | Where-Object { (Resolve-LauncherProcessPath $_) -ine $selected }).Count) {
        throw "These exact build outputs are in use: $list. Close them, or name an exact path with -CloseRunning -CloseRunningPath."
    }
    Write-Step "Closing $list"
    foreach ($process in $running) {
        if ((Resolve-LauncherProcessPath $process) -ine $selected) { throw 'The selected launcher process changed before close.' }
        $null = $process.CloseMainWindow()
        if ($process.WaitForExit(15000)) { continue }
        if ((Resolve-LauncherProcessPath $process) -ine $selected) { throw 'The selected launcher process changed before stop.' }
        Write-Detail "pid $($process.Id) ignored WM_CLOSE (hides to tray); terminating"
        try { $process.Kill() } catch { }
        if (-not $process.WaitForExit(15000)) {
            throw "pid $($process.Id) could not be stopped: $selected. Close it with Task Manager before building."
        }
    }
}
