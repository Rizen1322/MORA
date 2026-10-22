[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:4732',
    [Parameter(Mandatory=$true)][string]$FocusBodyFile,
    [Parameter(Mandatory=$true)][string]$TrackId,
    [string]$AccessToken = $env:ACCESS_TOKEN,
    [int]$PollMs = 200,
    [int]$TimeoutSec = 900,
    [string]$OutputPath = (Join-Path (Get-Location) 'bench-api-result.json')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $FocusBodyFile -PathType Leaf)) { throw "Focus body file not found: $FocusBodyFile" }
$focusBody = Get-Content -LiteralPath $FocusBodyFile -Raw
try { $null = $focusBody | ConvertFrom-Json } catch { throw "FocusBodyFile must contain valid JSON: $($_.Exception.Message)" }
$headers = @{}
if (-not [string]::IsNullOrWhiteSpace($AccessToken)) { $headers['X-Access-Token'] = $AccessToken }

$samples = [System.Collections.Generic.List[object]]::new()
$focusStart = [DateTimeOffset]::UtcNow
$watch = [System.Diagnostics.Stopwatch]::StartNew()
Write-Host "POST $BaseUrl/api/analysis/focus"
$focusResponse = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/analysis/focus" -Headers $headers -ContentType 'application/json' -Body $focusBody
$focusPostMs = $watch.Elapsed.TotalMilliseconds
Write-Host "Focus request returned after $([math]::Round($focusPostMs, 1)) ms. Polling track ID '$TrackId'."

$firstRunningMs = $null
$readyMs = $null
$lastStatus = $null
$lastResponse = $null
while ($watch.Elapsed.TotalSeconds -lt $TimeoutSec) {
    $sampleStart = [DateTimeOffset]::UtcNow
    $response = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/tracks/$TrackId/stems" -Headers $headers
    $sampleEnd = [DateTimeOffset]::UtcNow
    $status = [string]$response.status
    if ([string]::IsNullOrWhiteSpace($status)) { $status = '<status field absent>' }
    $lastStatus = $status
    $lastResponse = $response
    $elapsedMs = $watch.Elapsed.TotalMilliseconds
    $samples.Add([pscustomobject]@{
        timestamp = $sampleEnd.ToString('o')
        elapsed_ms = [math]::Round($elapsedMs, 1)
        status = $status
        request_ms = [math]::Round(($sampleEnd - $sampleStart).TotalMilliseconds, 1)
        response = $response
    })
    if ($null -eq $firstRunningMs -and $status -eq 'running') { $firstRunningMs = $elapsedMs }
    if ($status -eq 'ready') { $readyMs = $elapsedMs; break }
    if ($status -in @('error', 'failed', 'unavailable')) { break }
    Start-Sleep -Milliseconds $PollMs
}
$watch.Stop()

$result = [ordered]@{
    focus_started_utc = $focusStart.ToString('o')
    focus_post_ms = [math]::Round($focusPostMs, 1)
    track_id = $TrackId
    last_status = $lastStatus
    first_running_elapsed_ms = if ($null -ne $firstRunningMs) { [math]::Round($firstRunningMs, 1) } else { $null }
    ready_elapsed_ms = if ($null -ne $readyMs) { [math]::Round($readyMs, 1) } else { $null }
    T_queue_ms = if ($null -ne $firstRunningMs) { [math]::Round($firstRunningMs, 1) } else { $null }
    T_job_ms = if ($null -ne $firstRunningMs -and $null -ne $readyMs) { [math]::Round($readyMs - $firstRunningMs, 1) } else { $null }
    T_total_observed_ms = if ($null -ne $readyMs) { [math]::Round($readyMs, 1) } else { $null }
    timeout_or_terminal = ($null -eq $readyMs)
    focus_response = $focusResponse
    last_stems_response = $lastResponse
    samples = @($samples)
}
$json = $result | ConvertTo-Json -Depth 30
$parent = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8
Write-Host "Last status: $lastStatus"
Write-Host "T_queue: $($result.T_queue_ms) ms | T_job: $($result.T_job_ms) ms | T_total observed: $($result.T_total_observed_ms) ms"
Write-Host "JSON report: $OutputPath"
if ($null -eq $readyMs) { Write-Warning 'Status did not reach ready before timeout or task ended in an error. Inspect report samples/response.'; exit 1 }
