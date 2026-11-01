# MORA desktop audio

Rust audio, analysis and transition-planning core used by the Windows Electron app. iOS is unchanged. The crate builds a reusable Rust/static library and a small executable host; the Electron main process owns playback, and the backend invokes native analysis/planning/offline rendering.

Implemented: two decks, sample-clock transition scheduling, WSOLA with transient protection and coarse/fine stereo correlation, tempo automation, delayed entries, LR4 isolators, DJ filter, loops/rolls, tape stop, vocal subtraction and voice echo, independent speed/pitch, EQ/headroom/balance/mono, room reverb, transport fades, normalization ramps, starvation recovery, and the lookahead true-peak limiter. Streaming MIR covers BPM, keys, loudness, structure and repetition. Native planning preserves the existing calibrated candidate selection, vocal protection and rating bias. `f64` scalar arithmetic and `f32` PCM match the reference implementation in the tested cases.

The native device callback only reads a bounded lock-free stereo ring and writes a bounded monitor ring. Mixing and command decoding run on the producer thread, JSON output runs on a separate writer. The 2048-frame producer reserve is about 43 ms at 48 kHz **in addition to** the OS/device latency. The main renderer receives a small native waveform for the existing visuals; no second Web Audio output is created.

## Build and check

Install Rust with rustup. Windows GNU works with its bundled linker; MSVC works with the usual Microsoft build tools. Runtime users need neither Rust nor additional system tools.

From the repository root:

```sh
node apps/desktop/scripts/build-rust.mjs --test
node apps/desktop/scripts/build-rust.mjs
node --import tsx tools/check-rust-audio.ts --runs=3
node --import tsx tools/check-rust-analysis.ts
node --import tsx tools/check-rust-planner.ts
node --import tsx tools/check-rust-phrase.ts
node --import tsx tools/check-rust-vocals.ts
node --import tsx tools/check-rust-vocal-plan.ts
node --import tsx tools/check-rust-level-plan.ts
node --import tsx tools/check-rust-unlocked.ts
node --import tsx tools/check-rust-render.ts
node apps/desktop/scripts/build.mjs
node tools/check-rust-desktop.mjs
```

The build script uses `Cargo.lock`, copies the executable and dependency license texts into `apps/desktop/build/audio`, and the desktop packager includes that directory. It fails if Rust or the native artifact is missing. No silent switch to the old engine occurs in a desktop build.

`check-rust-audio.ts` compares identical deterministic stereo PCM, commands, samples and transport events with the TypeScript mixer at 44.1/48 kHz. It rejects silence, clipping, non-finite PCM, changed samples and changed events. It warms V8 and runs three repetitions by default. Reports and disposable fixtures go to `data-bench-results/rust-audio/`. `--only=playback` limits a diagnostic run without replacing the full report. Timings cover offline rendering, excluding process startup, command parsing and file output; they do not measure the complete Electron app.

`check-rust-desktop.mjs` launches the actual Electron app hidden, uses a disposable profile and muted synthetic WAVs, imports through the API, restores the queue, clicks Play/Pause, and checks native ticks, device selection and telemetry. It uses a temporary loopback-only debugging port and closes the test app afterwards. It never opens the user's library.

## Platform boundaries

- Decoding remains the bundled native FFmpeg. PCM caching, library/network services, approved-transition lookup and final render-selection policy remain server responsibilities. Desktop analysis, automatic/manual planning, preview mixing and device playback use Rust through `AUTOMIX_RUST_CORE`, set by the shell.
- The normal web player and iOS retain their platform implementations. TypeScript remains the numerical reference for parity tests.
- Desktop uses original full recordings, with no vocal subtraction or separation. Cached separation metadata is excluded from planning and legacy vocal plans are converted to full-mix playback. The crate retains the reference vocal DSP for parity checks; it is not enabled in the desktop product.
- WASAPI shared stereo float output is supported at 44.1/48/88.2/96 kHz; numerical parity is currently tested at 44.1/48 kHz. Other output formats/rates and exclusive/ASIO modes are not added.
- Switching devices keeps the mixer state and creates a new device ring. If the new device cannot support the current sample rate, the old output is retained and an error is shown. Unplugging or a device-stream error pauses the player; the next user Play rebuilds the engine and reloads PCM at the saved position. No automatic restart on wake.
- A page reload or renderer crash stops the native host; closing the window to the tray keeps playback. The host also stops on app exit and EOF from its parent.

Short device smoke tests and offline numeric tests do not replace long playback, Bluetooth/USB/sleep testing, or listening to real music.
