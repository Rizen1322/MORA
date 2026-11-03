# Native network transport

`mora-network` is one persistent reqwest/Tokio helper per backend. It binds a random loopback port and requires the 256-bit capability supplied through `MORA_NETWORK_TOKEN`. Its first stdout line contains the port. Stdin EOF/newline shuts it down. URLs, account headers, proxy credentials and upstream error bodies are never printed.

The Node adapter is `apps/server/src/rust-network.ts`. Metadata remains parsed by the existing TypeScript providers. Audio downloads use authenticated control requests containing a destination staging path; Rust writes response chunks directly to that file. Response audio is never encoded as JSON/base64 or buffered in the JS heap. Metadata request bodies are base64 encoded; response bodies stream through the loopback bridge.

| Contract | Implementation |
| --- | --- |
| Connections | Pooled HTTP/1.1 and HTTP/2 with native TLS/ALPN; five active requests, at most three bulk/search requests, two slots reserved for priorities 0/1. |
| TLS | Certificate and hostname verification remain enabled. Windows uses Schannel and the OS trust store. |
| Redirects | Maximum five, with manual/error modes; provider media allowlists checked on every hop. Authorization/cookies are stripped across origins; POST changes to GET for 301/302/303 according to Fetch rules. |
| Ranges | Upstream Range, 206 and Content-Range preserved. HEAD preserves upstream Content-Length without counting a body that does not exist. |
| Limits | Metadata responses capped at 16 MiB by default; native files use the caller's existing cap. `network.fetch(input, init, maxBytes)` can use an explicit caller budget: the resolver updater passes its existing 100-MiB executable limit. Timeout includes queueing. Incomplete native files are removed on transfer errors/cancellation. |
| Cancellation | Signal abort cancels queued/download work. Closing a streamed response closes its upstream stream. Shared provider downloads stop only when all subscribers leave. |
| Recovery | A crashed helper is restarted lazily before a later request. A request already in flight is never replayed by this recovery. |
| Explicit proxies | Provider proxy settings, HTTP(S)/SOCKS5 proxies and proxy credentials supported; an empty proxy disables proxies. Environment proxy/NO_PROXY behavior retained. |
| Windows system proxy | Manual settings use reqwest's system proxy support. PAC/WPAD uses WinHTTP, with a bounded 60-second cache for complete destination URLs and new resolution for each redirect target. Ordered proxy/DIRECT alternatives are retried only after connection failures before a request is sent. |
| PAC errors | Fail closed. Electron metadata can use its existing transport when native system proxy resolution/policy is unsupported. Windows integrated authentication is not silently sent to PAC servers. |
| Cookies/tokens | Explicit request headers preserved. Cross-origin redirects do not carry account headers. No browser cookie jar is imported. |

The actual callers include Yandex audio, shared Audius/Jamendo/Subsonic downloads, provider metadata/covers, lyrics, public collection/radio metadata and the injected YouTube Music/SoundCloud search transports. Direct public playback uses yt-dlp to resolve the selected audio URL/site headers, then Rust downloads the original container into the existing growing file. Site challenges, HLS/DASH segments and the extraction/import path remain in yt-dlp. The existing yt-dlp scheduling and foreground reserve remain active.

## Validation and benchmark

Build the release binary with Cargo, then run:

```powershell
npx vitest run apps/server/test/rust-network.test.ts apps/server/test/rust-network-fallback.test.ts apps/server/test/ytdlp-native-network.test.ts apps/server/test/ytdlp-runner.test.ts apps/server/test/yandex-audio.test.ts apps/server/test/yandex-cover.test.ts
cargo test --release --manifest-path packages/network-rust/Cargo.toml
npx tsc -p apps/server --noEmit
```

Yandex decoding fixtures require FFmpeg on PATH. The Windows GNU toolchain needs binutils and an ASCII build path on this machine; the isolated W: mapping/toolchain used by the desktop build supplies them.

`npx tsx tools/bench-rust-network.ts` compares Node fetch/pipeline with native download. Set `AUTOMIX_BENCH_ELECTRON` to a usable Electron executable to include Electron.net and Electron+Rust under the same shell. It uses three alternating rounds, 16 metadata requests and four 32-MiB files per mode. All files are SHA256 checked. A separate delayed two-chunk fixture measures the first audio byte visible on disk. No external service is involved. The fixture disables proxies explicitly for loopback.

The report is written to `data-bench-results/rust-network.json`. Process startup, child CPU and child peak RSS are included in separate fields. The sum of individual process RSS peaks is an upper estimate, not a measured simultaneous application peak. These are transport harness measurements, not complete desktop application memory measurements; both improved CPU/memory and any throughput/startup regressions must be reported.

PAC parsing/failover and no-POST-replay are checked with synthetic policies and local sockets. Tests do not change Windows proxy settings. Actual enterprise PAC/authentication, public services and a complete packaged GUI session still require deployment-environment validation.
