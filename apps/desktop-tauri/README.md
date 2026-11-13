# MORA for Windows (Tauri, x64)

This is the current desktop application: Tauri 2 / WebView2, a bundled Node backend and Rust audio, decoder and network helpers. The version comes from `src-tauri/tauri.conf.json`. By default it uses `%LOCALAPPDATA%\MORA`; an existing `%LOCALAPPDATA%\MORA-Native-Preview` library is retained and selected when the stable profile has no library. Existing data is backed up before an upgrade.

`unified-installer.mjs` keeps the existing MORA NSIS installation and GitHub update channel. Updates are checked automatically, downloaded only on request, verified by size and SHA-512, and installed after confirmation. The installer is unsigned. See [update and release instructions](../../docs/desktop-auto-update.md). Symphonia is the primary decoder; FFmpeg remains the compatibility fallback, including AAC gapless handling.

To build from a fresh checkout, install Node.js (22.13 or later), Rust with the `x86_64-pc-windows-gnu` toolchain, CMake on PATH (4.4.5 was used here), and WebView2. Use an ASCII-only checkout path (or map the checkout to a free drive letter with `subst`) and run these commands from that repository root in PowerShell. The first build downloads pinned LLVM-MinGW, Node 22, FFmpeg and yt-dlp; Cargo and npm also download dependencies. LLVM-MinGW includes the make program required by the CMake generator; CMake itself is a separate prerequisite and may be portable. LLVM-MinGW and Node are stored under this directory, not installed system-wide.

```powershell
npm ci
node apps/desktop-tauri/fetch-toolchain.mjs
$env:PATH = "$PWD\apps\desktop-tauri\toolchain\llvm-mingw-20260908-ucrt-x86_64\bin;$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:CC = 'clang'
$env:CXX = 'clang++'
$env:CMAKE_GENERATOR = 'MinGW Makefiles'
$env:RUSTFLAGS = '-C linker=rust-lld -C link-self-contained=yes'
node apps/desktop/scripts/fetch-ffmpeg.mjs
node apps/desktop/scripts/fetch-ytdlp.mjs
node apps/desktop/scripts/build.mjs
node apps/desktop-tauri/package.mjs
node apps/desktop-tauri/unified-installer.mjs
```

`package.mjs` prepares its own backend and resources from `apps/desktop/build`, builds the release shell and a separate Tauri NSIS installer under `src-tauri/target/release/bundle/nsis`. `unified-installer.mjs` then produces `dist-unified/MORA-Setup-<version>.exe`, its blockmap and `latest.yml` for the existing update channel. It packages the native executable; using electron-builder for NSIS does not include Electron in the application. Neither command publishes a release.

Rebuild the shared desktop resources after changing the web app, audio engine, decoder, network helper or analysis worker. The release executable also runs from its `target/release` directory with the adjacent `resources` directory and WebView2Loader DLL. The app carries its own Node runtime; no development environment overrides are needed. The root `desktop:dev` and `desktop:package` npm scripts still target the legacy Electron shell; use the commands above for Tauri.

For a hidden, muted end-to-end smoke test of the packaged release, run:

```powershell
$env:MORA_PACKAGED = '1'
$env:MORA_BUILD_MODE = 'release'
node apps/desktop-tauri/shell-smoke.mjs
node apps/desktop-tauri/autonomy-smoke.mjs
```

The scripts create disposable profiles in `probe-profile`. The autonomy test uses the real audio output with mute and zero volume, freezes WebView2 for 45 seconds, and tests recovery and a paused backend restart.

Windows CI builds all three Rust helpers before running integration tests, runs their Rust tests, builds and tests the Tauri shell, and runs `shell-smoke.mjs` against the release resources. Autonomy with a real audio device and the interactive Windows media-session test remain local checks. Run the latter with `cargo test --release --locked --manifest-path packages/audio-rust/Cargo.toml --test smtc_windows` from an interactive Windows session.
