param([Parameter(Mandatory=$true)][int]$RootProcessId, [Parameter(Mandatory=$true)][string]$Profile, [switch]$StopOwned)
$ErrorActionPreference = 'Stop'
function Test-ParentAge($parent, $child) {
  return $parent -and $parent.CreationDate -and $child.CreationDate -and $child.CreationDate -ge $parent.CreationDate
}
$older = [pscustomobject]@{ CreationDate = [datetime]'2026-01-01' }
$newer = [pscustomobject]@{ CreationDate = [datetime]'2026-01-02' }
if ((Test-ParentAge $newer $older) -or !(Test-ParentAge $older $newer)) { throw 'Process PID reuse check failed' }
$all = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($item in $all) { $byId[[int]$item.ProcessId] = $item }
if (!$StopOwned -and !$byId.ContainsKey($RootProcessId)) { throw 'Measured app exited before snapshot' }
$owned = [System.Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($RootProcessId)
foreach ($item in $all) {
  if ($item.ProcessId -ne $PID -and $item.CommandLine -and $item.CommandLine.Contains($Profile)) { [void]$owned.Add([int]$item.ProcessId) }
}
do {
  $changed = $false
  foreach ($item in $all) {
    $parent = $byId[[int]$item.ParentProcessId]
    # A recycled PID is not the parent of processes that were created before it.
    if ($item.ProcessId -ne $PID -and (Test-ParentAge $parent $item) -and $owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)) { $changed = $true }
  }
} while ($changed)
if ($StopOwned) {
  foreach ($id in @($RootProcessId) + @($owned | Where-Object { $_ -ne $RootProcessId })) {
    $original = $byId[$id]
    $current = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    if ($original -and $current -and $original.CreationDate -eq $current.CreationDate) {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
  }
  exit
}
$private = @{}
foreach ($item in Get-CimInstance Win32_PerfRawData_PerfProc_Process) { $private[[int]$item.IDProcess] = [double]$item.WorkingSetPrivate }
$rows = @(foreach ($id in $owned) {
  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($process) {
    [pscustomobject]@{ pid=$id; name=$process.ProcessName; cpuSeconds=$process.TotalProcessorTime.TotalSeconds; privateBytes=$process.PrivateMemorySize64; workingSetBytes=$process.WorkingSet64; privateWorkingSetBytes=$private[$id] }
  }
})
ConvertTo-Json -InputObject $rows -Compress
