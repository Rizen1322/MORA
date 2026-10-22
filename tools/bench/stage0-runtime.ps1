[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\MORA'),
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'MORA\data'),
    [string]$PythonPath = '',
    [string]$PackPath = '',
    [string]$OutputPath = (Join-Path (Get-Location) 'stage0-runtime.txt')
)

$ErrorActionPreference = 'Continue'
$lines = [System.Collections.Generic.List[string]]::new()
function Add-Line([string]$Text = '') {
    $lines.Add($Text)
    Write-Host $Text
}
function Read-JsonFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }
    catch { Add-Line "WARN: не удалось прочитать JSON: $Path — $($_.Exception.Message)"; return $null }
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) { $PythonPath = Join-Path $InstallRoot 'resources\vocal\python.exe' }
if ([string]::IsNullOrWhiteSpace($PackPath)) { $PackPath = Join-Path $InstallRoot 'resources\vocal\pack.json' }
$desktopPath = Join-Path $env:LOCALAPPDATA 'MORA\desktop.json'

Add-Line '=== MORA stage 0: runtime verification ==='
Add-Line "Timestamp: $([DateTimeOffset]::Now.ToString('o'))"
Add-Line "InstallRoot: $InstallRoot"
Add-Line "DataRoot: $DataRoot"
Add-Line "PythonPath: $PythonPath"
Add-Line "PackPath: $PackPath"
Add-Line ''

Add-Line '--- desktop.json ---'
$desktop = Read-JsonFile $desktopPath
if ($null -eq $desktop) { Add-Line "NOT FOUND/INVALID: $desktopPath" }
else {
    $stemsPython = $desktop.stemsPython
    if ($null -eq $stemsPython) { $stemsPythonText = '<null>' } else { $stemsPythonText = [string]$stemsPython }
    Add-Line "stemsPython: $stemsPythonText"
}

Add-Line ''
Add-Line '--- vocal pack metadata ---'
$pack = Read-JsonFile $PackPath
if ($null -eq $pack) { Add-Line "NOT FOUND/INVALID: $PackPath" }
else {
    Add-Line "version: $($pack.version)"
    Add-Line "python: $($pack.python)"
    Add-Line "torch: $($pack.torch)"
    Add-Line "torchaudio: $($pack.torchaudio)"
    Add-Line "model: $($pack.model)"
}

Add-Line ''
Add-Line '--- bundled Python / torch ---'
if (Test-Path -LiteralPath $PythonPath -PathType Leaf) {
    $torchCode = "import json; import torch; import torchaudio; print(json.dumps({'torch':torch.__version__,'torch_cuda':torch.version.cuda,'cuda_available':torch.cuda.is_available(),'threads':torch.get_num_threads(),'torchaudio':getattr(torchaudio,'__version__','unknown')}))"
    $torchOutput = & $PythonPath -c $torchCode 2>&1
    $torchExit = $LASTEXITCODE
    Add-Line "exit_code: $torchExit"
    foreach ($line in $torchOutput) { Add-Line ([string]$line) }
}
else { Add-Line 'BUNDLED PYTHON NOT FOUND — проверьте -InstallRoot/-PythonPath.' }

Add-Line ''
Add-Line '--- running MORA/python processes (snapshot at this instant) ---'
try {
    $processes = Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object { $_.Name -in @('python.exe', 'MORA.exe') } |
        Select-Object ProcessId, Name, ExecutablePath, CommandLine
    if (-not $processes) { Add-Line 'No matching processes found.' }
    foreach ($p in $processes) {
        # Hide common token/password values if the command line is later shared.
        $cmd = [string]$p.CommandLine
        $cmd = $cmd -replace '(?i)(--?(?:token|password|secret)\s+)[^\s]+', '$1<redacted>'
        $cmd = $cmd -replace '(?i)(ACCESS_TOKEN=)[^\s]+', '$1<redacted>'
        Add-Line ("PID={0} NAME={1} EXE={2} CMD={3}" -f $p.ProcessId, $p.Name, $p.ExecutablePath, $cmd)
    }
} catch { Add-Line "WARN: process snapshot unavailable: $($_.Exception.Message)" }

Add-Line ''
Add-Line '--- latest stems metadata ---'
if (Test-Path -LiteralPath $DataRoot -PathType Container) {
    $latest = Get-ChildItem -LiteralPath (Join-Path $DataRoot 'cache\stems') -Recurse -Filter 'metadata.json' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $latest) { Add-Line 'No metadata.json found under cache\stems.' }
    else {
        Add-Line "file: $($latest.FullName)"
        Add-Line "mtime: $($latest.LastWriteTime.ToString('o'))"
        $meta = Read-JsonFile $latest.FullName
        if ($null -ne $meta) {
            $trackSec = $null
            if ($null -ne $meta.frames -and [double]$meta.frames -gt 0) { $trackSec = [math]::Round(([double]$meta.frames / 44100.0), 2) }
            $shifts = $null
            if ($null -ne $meta.inference) { $shifts = $meta.inference.shifts }
            Add-Line "device: $($meta.device)"
            Add-Line "metadata.seconds: $($meta.seconds)"
            Add-Line "track_seconds_from_frames_at_44k1: $trackSec"
            Add-Line "inference.version: $($meta.inference.version)"
            Add-Line "inference.shifts: $shifts"
            Add-Line "activity.version: $($meta.activity.version)"
        }
    }
} else { Add-Line "DataRoot not found: $DataRoot" }

Add-Line ''
Add-Line '=== interpretation ==='
Add-Line 'Это моментальный снимок, а не подтверждение того, какой Python использовался во время уже завершившейся задачи.'
Add-Line 'Для живой проверки запустите этот скрипт, пока новый uncached-трек реально отделяется.'
Add-Line 'metadata.seconds — поле из metadata; не считайте его T_total, пока не подтверждено, что именно оно измеряет.'

try {
    $parent = Split-Path -Parent $OutputPath
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    Set-Content -LiteralPath $OutputPath -Value $lines -Encoding UTF8
    Write-Host "`nReport saved: $OutputPath"
} catch { Write-Warning "Не удалось сохранить отчёт: $($_.Exception.Message)" }
