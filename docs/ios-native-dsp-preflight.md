# Native DSP portability preflight

The independent native player in 1.0.10 now has phone confirmation of Play/Pause, seeking, resuming after a pause longer than three minutes, and track skipping. The main MORA music path still renders in an AudioWorklet. Its migration must preserve the existing AutoMix rather than replace it with a basic crossfade.

## Automated check

From the repository root, after installing dependencies:

```sh
node apps/mobile/scripts/check-native-dsp.mjs
```

This requires macOS and Swift's JavaScriptCore framework. On Windows/Linux, `--reference-only` checks fixture semantics in Node; it does **not** validate native JavaScriptCore. The iOS build workflow runs the complete check after its build installs npm dependencies.

The script bundles the existing `MixerCore` with esbuild. It executes that identical bundle first in a bare Node VM, then in a native Swift `JSContext`, without DOM, WebKit, AudioContext, timers, models or browser shims. The fixture does not implement another mixer. Two sample rates (44.1/48 kHz) exercise:

- play, fade to pause, seek while paused, resume, speed/pitch settings and stop;
- two-deck transition, non-unity WSOLA tempo, gain/EQ/filter automation, echo send, now-playing swap and transition completion.

All 534,016 scalar output samples (left/right interleaved), transport phase snapshots and emitted events are compared with an absolute tolerance of 0.00002. Structural/event/string differences fail. Independent assertions reject silence, clipping, underruns, fallbacks, missing transition events, missing tempo changes and failed pause/seek/stop behaviour. A deliberately different sample must fail the comparator. Input uses deterministic integer-generated signals; no user audio is involved.

This establishes portability for the exercised paths, not complete coverage of all transition types. It is an offline numerical check, not an iPhone benchmark or an audible real-time playback test. A successful macOS run cannot establish iOS sustained throughput, GC pauses, memory use, background survival, or streaming preparation correctness.

## Verified run

On 2026-10-24, [GitHub Actions run 40119199046](https://github.com/Rizen1322/MORA/actions/runs/40119199046) passed for source commit `9e415b0411bc02eb1183449df3591d70598eb580` on branch `ios`, with Xcode 26.2. The log confirms execution of the compiled Swift JavaScriptCore program and comparison of every sample, phase and event within the stated tolerance. The unsigned iOS build also passed. This is a macOS offline test result; the actual iPhone DSP host is not implemented by this change.

## Next implementation boundaries

Apple permits JavaScriptCore execution from Swift in the app process; a VM serializes access across threads ([JSContext](https://developer.apple.com/documentation/javascriptcore/jscontext), [JSVirtualMachine](https://developer.apple.com/documentation/javascriptcore/jsvirtualmachine)). A candidate native host should own a dedicated serial producer queue and feed bounded PCM buffers to native audio. It must never evaluate JS, allocate JS values or wait for the VM from a real-time render callback.

Before exposing this host for normal music, implement and test:

1. Separate **rendered**, **queued** and **audibly presented** time. MixerCore advances while producing buffered audio; its swap/ended events cannot immediately change the audible Now Playing item. Include output latency, tempo mapping and buffer epochs.
2. Flush queued audio and retire obsolete render results on pause, seek, skip and interruption; preserve the authoritative transport intent and native command results.
3. Native access to prepared PCM/files and queue state. Moving only the output to native while keeping a required producer/preparer in a WKWebView Worker does not prove background reliability. Do not rely on `evaluateJavaScript` or a finite background task to keep a suspended page alive.
4. Device measurement and regression checks for AutoMix continuity, starvation recovery, CPU/memory, audio route changes, long lock/pause, and real library track changes.

The preflight changes only test/CI/documentation files. It does not change the installed 1.0.10 playback path or justify another IPA with identical playback behaviour.

The current preparation dependency is concrete: `apps/mobile/src/worker/replace/ffmpeg.ts` delegates decoding through worker RPC, and `apps/mobile/src/bridge/index.ts` decodes using a page-side `OfflineAudioContext.decodeAudioData`. Cached PCM lives behind the worker's OPFS filesystem adapter. A native host needs a deliberate handoff/storage strategy for this data and must not treat the present page-side decoder as an independent background service.
