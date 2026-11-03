# Decoder measurements — 2026-11-02

Windows, AMD Ryzen 5 9600X, Node 26.13.0, bundled FFmpeg n9.0.2-29-g6dfaba896f-20261020; Symphonia 0.6.1 plus libopus and Rubato. Fixtures were generated with FFmpeg from a 120-second stereo 997 Hz sine. WAV, FLAC and MP3 were generated at 44.1 kHz and decoded/resampled to 48 kHz; WebM/Opus decoded at 48 kHz. Output was stereo f32le. Three serial runs per case. These are synthetic measurements, not a library-wide estimate.

`decoder-process-120s.json` records child-only measurements from `tools/bench-decoder.ps1`. First PCM is elapsed time from spawn to first stdout data; wall is elapsed through process exit; speed is 120 seconds divided by wall. Both implementations used the same stdout pipe drained to `.NET Stream.Null`. CPU time and peak working set were sampled every 5 ms: CPU can be incomplete when the process exits between samples, and peak working set is not private memory. Table values are medians.

| Input | Decoder | First PCM ms | Wall s | Speed × realtime | Sampled CPU s | Peak working set MiB |
|---|---|---:|---:|---:|---:|---:|
| WAV | native / FFmpeg | 20.9 / 41.9 | 0.102 / 0.086 | 1177 / 1395 | 0.047 / 0.047 | 4.8 / 21.4 |
| FLAC | native / FFmpeg | 15.6 / 36.2 | 0.112 / 0.095 | 1075 / 1261 | 0.062 / 0.188 | 4.8 / 22.5 |
| MP3 | native / FFmpeg | 16.0 / 31.3 | 0.126 / 0.099 | 952 / 1216 | 0.109 / 0.172 | 5.2 / 20.8 |
| WebM Opus | native / FFmpeg | 15.5 / 46.3 | 0.172 / 0.212 | 697 / 565 | 0.109 / 0.266 | 4.7 / 21.0 |

`node-adapter-120s.jsonl` records the real `FfmpegTools` path, draining stdout in Node. Its first PCM and wall include the spawned child but exclude the preceding probe. `adapter_cpu_s` measures Node only; `adapter_peak_mib` is the whole Node process RSS sampled during the run, affected by garbage collection and previous runs, not child memory or incremental private memory. All outputs were 46,080,000 bytes. Median first PCM native / FFmpeg: WAV 10.9 / 43.2 ms, FLAC 12.4 / 27.3 ms, MP3 11.9 / 26.0 ms, WebM 12.3 / 30.8 ms. Median wall: 0.081 / 0.088 s, 0.096 / 0.092 s, 0.123 / 0.089 s, 0.160 / 0.177 s respectively.

The compatibility script checks mono/stereo, 44.1/48 kHz conversions, raw f32/s16 output, gapless MP3 and Ogg/WebM Opus, progressive stdin, process-tree cancellation and fractional lengths. WAV/FLAC were bit-identical without resampling; MP3 sample error was at float rounding scale. Rubato and FFmpeg use different resampling filters: on these sine fixtures the stereo resampling RMSE was 9e-6–5.1e-5, with edge peaks up to 0.0072. Ogg/WebM Opus was within 1.5e-6 RMSE on the measured fixture after discard-padding correction. This does not prove equivalence for arbitrary content or codecs.

Reproduce child tests with `tools/bench-decoder.ps1 -Decoder <mora-decode.exe> -Ffmpeg <ffmpeg.exe> -Codec <wav|flac|mp3|webm> -Duration 120`. Reproduce the Node path with `npx tsx packages/decoder-rust/tests/bench-adapter.ts <decoder> <ffmpeg> <ffprobe> <codec> 120`. Run compatibility via `node packages/decoder-rust/tests/compat.mjs <decoder> <ffmpeg>`.
