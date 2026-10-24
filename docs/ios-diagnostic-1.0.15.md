# MORA iOS 1.0.15 (16): preparing the queue without WebContent

Branch: `ios`. Base: 1.0.14, commit `527206e`, with the existing Swift AutoMix renderer.

## Problem and change

In 1.0.14 the audio renderer was native, but the page still downloaded, decoded and
analysed the next songs. Only the current song and two upcoming songs reached Swift.
When iOS suspended WebContent under screen lock, those three files played and the
queue ran out. Native DSP alone could not refill it.

1.0.15 hands the entire **known queue** and repeat catalogue to the app process once.
Native audible-track updates release a preparation permit; no page timer or JavaScript
callback from WebContent is needed between songs. The producer downloads the next
file, decodes it with AVAudioFile/AVAudioConverter, analyses it, plans a transition and
appends the ready PCM track. It maintains two upcoming tracks instead of decoding the
whole playlist into memory. Older PCM files are pruned. New queues cancel the old
producer and stale work cannot append to the replacement session.

The initial song still uses the existing foreground bootstrap. Keep MORA open until
the message **«Очередь передана iPhone для фоновой подготовки»**, then lock the screen.
Address resolution and copying imported local files happen before that handoff.

## Implementation

- `NativeMediaHTTP.swift`: cancellable URLSession file streaming, HTTP status and byte
  limits, partial-file cleanup, cross-host redirect removal of Authorization/Cookie.
- `NativeMediaLoader.swift`: direct files, finite unencrypted HLS, fresh Yandex download
  URLs, and local compressed files copied from the app's OPFS storage. HLS preserves
  required request headers; encrypted/live playlists fail with a diagnostic reason.
- `NativePCMDecoder.swift`: streaming stereo float PCM conversion to 48 kHz and MIR
  resampling to 44.1 kHz. iOS files explicitly use protection available after the first
  device unlock, so a subsequent screen lock does not make them inaccessible.
- `NativePreparationCore.swift` + `native-preparation-core.ts`: the same MIR and
  transition planner as desktop, bundled into an app-process JavaScriptCore. They run
  off the audio control queue. **Audio DSP remains Swift**; JavaScriptCore performs
  analysis/planning only. No local ML models or stem separation are added.
- `NativeQueuePreparation.swift`: sequential producer, native backpressure, cancellation,
  bounded repeated-track analysis cache and skip reasons. Three consecutive preparation
  failures stop the producer. Ready audio can wait for a delayed next preparation.
- `NativeMixHost.swift`: session/file ownership, native append and resume, repeat loop,
  artwork, source/PCM cleanup and diagnostic snapshots. Prepared source files referenced
  by the live manifest are retained for repeat, within a 512 MiB local-source budget.
- `apps/server/src/native-sources.ts`: mobile-only private source recipes. Credentials,
  signed URLs and source recipes stay out of playback journals and planner debug data.
  Cached analysis/artwork may be handed over. Remote HTTPS artwork is fetched natively.
- `controller.ts`: passes the known queue, follows native entry IDs beyond song three,
  and disables duplicate page-side focused analysis in this mode.
- Diagnostics shows preparation stage, cumulative prepared count and failures; its
  state continues to be exported with the existing playback journal.

## Source coverage and boundaries

| Source | Handoff and native work |
| --- | --- |
| Yandex | Account/download-info recipe; Swift resolves a fresh audio URL per preparation |
| YouTube / SoundCloud | Existing foreground extractor supplies direct/HLS address; Swift downloads and decodes |
| Jamendo / Audius | Provider supplies direct stream address; Swift downloads and decodes |
| Subsonic | Configured server URL/credentials; explicit HTTP allowed only for that configured host |
| Imported/cached local music | Compressed file mirrored before handoff, then decoded natively |

The provider routes have implementation/unit coverage, not a physical-iPhone test of
every service. Signed extractor URLs can expire in long queues; refreshing those
recipes still requires the foreground app. Generating **new** Wave recommendations
beyond the already handed-over list also still requires WebContent. This release
targets finite albums/playlists and their repeats. It does not promise background
execution after force-quit, indefinite pause or loss of network access.

## Verification

- Local: 233 tests in 33 mobile/web/server files, workspace TypeScript checks and the
  production mobile web build.
- macOS CI: native WAV/artwork checks, unsigned iPhone build, AAC/WAV decoding and
  resampling, HTTP status/size/cancellation/redirect tests, Yandex XML signing and HLS
  headers/concatenation.
- An eight-track preparation/repeat fixture runs without WebContent and verifies order,
  native gate progression, accepted files and temporary-file cleanup.
- Native JavaScriptCore MIR output agrees with Node acoustic fields within relative
  2e-5. Only `elapsedMs` is excluded from equality, because it measures execution time;
  it must still be finite and nonnegative.
- The existing eight Swift DSP scenarios remain within 2e-5 of Node; the PCM queue
  parity scenarios continue to match exactly.
- Luna independently reviewed the implementation. Fixed its HLS-header, stale local
  source retention and WebContent session-rebind findings, then repeated CI.

These automated results are from macOS CI, not a physical iPhone. Real screen-lock
scheduling, provider availability and heat still require the device check below.

## iPhone check

1. Install 1.0.15 over 1.0.14 with the same signing account and bundle identifier.
2. Leave native playback enabled and forced audio auto-resume disabled.
3. Play an album/playlist of at least eight songs. Wait for the handoff message.
4. Lock the screen and let at least five consecutive songs play naturally, including
   the transitions after songs three and four. First use an ordinary queue with repeat off.
5. Check Next/Previous, pause, resume after three minutes and seeking. Repeat with
   repeat-all enabled and with another source. A seek shortcut alone is not evidence
   that natural queue refilling worked.
6. Unlock, put a diagnostic marker and export JSON. If it stopped, include roughly
   when it stopped, whether the screen stayed locked and whether reopening resumed it.

Useful signals: `preparation.state`, `ready`, `failedCount`, sanitized preparation
failure reason, `waitingForPreparation`, audible index/count and audio underruns.
