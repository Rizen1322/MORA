param([Parameter(Mandatory)] [string] $Decoder, [Parameter(Mandatory)] [string] $Ffmpeg, [ValidateSet('flac','mp3','wav','webm')] [string] $Codec = 'flac', [int] $Duration = 300)
& (Join-Path $PSScriptRoot '../packages/decoder-rust/tests/bench.ps1') -Decoder $Decoder -Ffmpeg $Ffmpeg -Codec $Codec -Duration $Duration
