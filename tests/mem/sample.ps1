param([int]$RootPid, [string]$Label, [string]$Out, [int]$Samples = 5, [int]$IntervalSec = 4)
# Samples memory for the launcher process tree (launcher + all msedgewebview2 descendants).
# Per process: private bytes (commit), working set, private working set (= Task Manager "Memory" column),
# and GPU dedicated/shared usage summed per adapter LUID.
$ErrorActionPreference = 'Stop'
function Get-Tree([int]$root) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine
  $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add($root)
  do { $added = $false
    foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) { [void]$ids.Add([int]$p.ProcessId); $added = $true } }
  } while ($added)
  $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
}
$rows = @(); $adapterRows = @()
for ($i = 0; $i -lt $Samples; $i++) {
  $tree = Get-Tree $RootPid
  $treeIds = @($tree | ForEach-Object { [int]$_.ProcessId })
  $perf = @{}; Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = $_ }
  $gpu = @{}; $byLuid = @{}
  try {
    $c = Get-Counter -Counter '\GPU Process Memory(*)\Dedicated Usage', '\GPU Process Memory(*)\Shared Usage' -ErrorAction SilentlyContinue
    foreach ($s in $c.CounterSamples) {
      if ($s.InstanceName -match 'pid_(\d+)_(luid_0x[0-9a-f]+_0x[0-9a-f]+)') { $id = [int]$Matches[1]; $luid = $Matches[2]
        $kind = if ($s.Path -like '*dedicated usage') { 'ded' } else { 'shr' }
        if (-not $gpu.ContainsKey($id)) { $gpu[$id] = @{ ded = 0; shr = 0 } }
        $gpu[$id][$kind] += $s.CookedValue
        if ($treeIds -contains $id) { $k = "$luid $kind"; if (-not $byLuid.ContainsKey($k)) { $byLuid[$k] = 0 }; $byLuid[$k] += $s.CookedValue } }
    }
  } catch {}
  foreach ($k in $byLuid.Keys) { $adapterRows += [pscustomobject]@{ label = $Label; sample = $i; adapter = $k; MB = [math]::Round($byLuid[$k] / 1MB, 1) } }
  foreach ($p in $tree) {
    $id = [int]$p.ProcessId; $gp = Get-Process -Id $id -ErrorAction SilentlyContinue; if (-not $gp) { continue }
    $type = 'main'
    if ($p.Name -eq 'msedgewebview2.exe') { $type = 'browser'; if ($p.CommandLine -match '--type=([\w-]+)') { $type = $Matches[1] } ; if ($p.CommandLine -match '--utility-sub-type=([\w.]+)') { $type += ':' + $Matches[1] } }
    $wsp = if ($perf.ContainsKey($id)) { [double]$perf[$id].WorkingSetPrivate } else { 0 }
    $g = if ($gpu.ContainsKey($id)) { $gpu[$id] } else { @{ ded = 0; shr = 0 } }
    $rows += [pscustomobject]@{ label = $Label; sample = $i; t = (Get-Date -Format "HH:mm:ss"); pid = $id; type = $type
      privateMB = [math]::Round($gp.PrivateMemorySize64 / 1MB, 1); wsMB = [math]::Round($gp.WorkingSet64 / 1MB, 1)
      wsPrivateMB = [math]::Round($wsp / 1MB, 1); gpuDedMB = [math]::Round($g.ded / 1MB, 1); gpuShrMB = [math]::Round($g.shr / 1MB, 1) }
  }
  if ($i -lt $Samples - 1) { Start-Sleep -Seconds $IntervalSec }
}
[pscustomobject]@{ processes = $rows; adapters = $adapterRows } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Out
$last = $rows | Where-Object { $_.sample -eq ($Samples - 1) }
$last | Sort-Object type | Format-Table type, pid, privateMB, wsMB, wsPrivateMB, gpuDedMB, gpuShrMB -AutoSize | Out-String -Width 200
foreach ($r in ($rows | Group-Object sample)) { "sample {0} @{5}: private={1} wsPrivate={2} gpuDed={3} gpuShr={4}" -f $r.Name, ($r.Group | Measure-Object privateMB -Sum).Sum, ($r.Group | Measure-Object wsPrivateMB -Sum).Sum, ($r.Group | Measure-Object gpuDedMB -Sum).Sum, ($r.Group | Measure-Object gpuShrMB -Sum).Sum, $r.Group[0].t }
$adapterRows | Where-Object { $_.sample -eq ($Samples - 1) -and $_.MB -gt 0 } | ForEach-Object { "GPU {0} = {1} MB" -f $_.adapter, $_.MB }
