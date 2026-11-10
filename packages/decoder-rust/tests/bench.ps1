param([Parameter(Mandatory)] [string] $Decoder, [Parameter(Mandatory)] [string] $Ffmpeg, [ValidateSet('flac','mp3','wav','webm')] [string] $Codec = 'flac', [int] $Duration = 300)
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) ("mora-bench-" + [guid]::NewGuid() + ".${Codec}")
try {
  $encoder = @{ flac = 'flac'; mp3 = 'libmp3lame'; wav = 'pcm_s16le'; webm = 'libopus' }[$Codec]
  & $Ffmpeg -y -v error -f lavfi -i "sine=frequency=997:duration=${Duration}:sample_rate=44100" -ac 2 -c:a $encoder $fixture
  if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
  foreach ($kind in @('native', 'ffmpeg')) {
    $measurements = foreach ($iteration in 1..3) {
      $info = [System.Diagnostics.ProcessStartInfo]::new()
      $info.FileName = if ($kind -eq 'native') { $Decoder } else { $Ffmpeg }
      $arguments = if ($kind -eq 'native') { @($fixture, '48000', '2', 'f32le') } else { @('-v', 'error', '-i', $fixture, '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1') }
      foreach ($arg in $arguments) { $info.ArgumentList.Add($arg) }
      $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
      $proc = [System.Diagnostics.Process]::new(); $proc.StartInfo = $info
      $watch = [System.Diagnostics.Stopwatch]::StartNew(); [void] $proc.Start()
      $stderr = $proc.StandardError.ReadToEndAsync()
      $buffer = [byte[]]::new(65536)
      $firstRead = $proc.StandardOutput.BaseStream.ReadAsync($buffer, 0, $buffer.Length)
      $cpu = 0; $peak = 0
      while (-not $firstRead.IsCompleted -and -not $proc.HasExited) { $proc.Refresh(); $cpu = $proc.TotalProcessorTime.TotalSeconds; $peak = [Math]::Max($peak, $proc.PeakWorkingSet64); Start-Sleep -Milliseconds 5 }
      $first = $watch.Elapsed.TotalMilliseconds
      $bytes = $firstRead.GetAwaiter().GetResult()
      $copy = $proc.StandardOutput.BaseStream.CopyToAsync([System.IO.Stream]::Null)
      while (-not $proc.HasExited) { $proc.Refresh(); try { $cpu = $proc.TotalProcessorTime.TotalSeconds; $peak = [Math]::Max($peak, $proc.PeakWorkingSet64) } catch {}; Start-Sleep -Milliseconds 5 }
      $proc.WaitForExit(); [void] $copy.GetAwaiter().GetResult(); $watch.Stop()
      if ($proc.ExitCode -ne 0 -or $bytes -eq 0) { throw $stderr.GetAwaiter().GetResult() }
      [pscustomobject]@{ first_ms = [Math]::Round($first, 1); wall_s = [Math]::Round($watch.Elapsed.TotalSeconds, 3); cpu_s = [Math]::Round($cpu, 3); peak_mib = [Math]::Round($peak / 1MB, 1); speed = [Math]::Round($Duration / $watch.Elapsed.TotalSeconds, 1) }
      $proc.Dispose()
    }
    [pscustomobject]@{ decoder = $kind; input = "${Duration}s stereo $Codec"; output = '48kHz stereo f32le'; runs = @($measurements) } | ConvertTo-Json -Depth 4
  }
} finally { Remove-Item -LiteralPath $fixture -Force -ErrorAction SilentlyContinue }
