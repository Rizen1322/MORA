# Native HTTP transport measurements — 2026-11-02

Three alternating rounds against the same loopback HTTP/1.1 fixture. Every mode fetched 16 metadata responses, measured a delayed two-chunk audio response, and downloaded four 32-MiB files. All 48 audio files had identical SHA256. The helper persists across all requests and uses one upstream keep-alive connection; Node fetch used two. No compiler, other benchmark or external service ran during the final measurement window.

| Transport harness | Warm metadata median, ms | First audio byte on disk, ms | Audio MiB/s | Total CPU, ms | Sum of process peak RSS, MiB | Workload including startup, ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node fetch → JS pipeline | 0.420 | 37.24 | 713.5 | 406.0 | 113.6 | 327.1 |
| Node + native helper → file | 0.629 | 29.94 | 252.7 | 248.6 | 105.2 | 684.1 |
| Electron.net → JS pipeline | 0.814 | 37.50 | 621.6 | 656.0 | 297.9 | 395.0 |
| Same Electron + native helper → file | 0.614 | 36.51 | 681.4 | 280.0 | 206.3 | 431.6 |

Each cell is the median of three complete runs. CPU includes the harness and its helper/Chromium children. Peak RSS sums each process's individual peak; this is an upper estimate, not a simultaneous full-application peak. Workload time includes startup, metadata and the delayed audio probe, excludes later process inspection/hash verification. Raw end-to-end startup/verification time is also recorded in [the JSON report](native-network-benchmark.json).

Within the same Electron harness, median transfer throughput rose 9.6%, CPU fell 57.3% and the RSS estimate fell 30.7%. Startup-inclusive workload took 9.3% longer. Native transfer throughput varied from 213.6 to 752.7 MiB/s, so the median does not establish a stable speed advantage.

The Node + helper harness regressed in throughput and startup time relative to Node fetch while using less CPU and modestly less memory. These results support moving audio copies out of Electron/JS; they do not establish that Rust networking is faster in every runtime, or that a complete Tauri application uses the harness's memory figure.

The first-byte fixture sends 32 KiB after 10 ms and its final 32 KiB after 90 ms. Both native modes expose file bytes before the response finishes. Range correctness, truncation, size caps, timeout/cancellation, authentication stripping, HEAD/null-body statuses, foreground reserve and helper recovery are covered by the focused tests rather than extrapolated from throughput.

Reproduce with a release helper and Node on PATH:

```powershell
$env:AUTOMIX_BENCH_ELECTRON = '<Electron executable>'
npx tsx tools/bench-rust-network.ts
```

The fixture explicitly disables proxies for loopback. PAC parsing, ordered proxy failover and refusal to replay a sent POST were tested using synthetic policies and local sockets. Actual enterprise PAC/authentication, public providers and live TLS/HTTP2 servers were not exercised in this benchmark. No production proxy settings were changed.
