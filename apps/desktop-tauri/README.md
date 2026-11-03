# MORA Native Preview (Windows x64)

This preview uses `%LOCALAPPDATA%\MORA-Native-Preview`, separate from the stable Electron profile. It has no auto-update channel. The NSIS installer is local and unsigned; do not publish it as a stable release.

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
```

`package.mjs` prepares its own backend and resources from `apps/desktop/build`, builds the release shell, and produces `apps/desktop-tauri/src-tauri/target/release/bundle/nsis/MORA Native Preview_0.3.31-preview.1_x64-setup.exe`. Rebuild the shared desktop resources after changing the web app, audio engine, decoder, network helper or analysis worker. The release executable also runs from its `target/release` directory with the adjacent `resources` directory and WebView2Loader DLL. The app carries its own Node runtime; no development environment overrides are needed.

For a hidden, muted end-to-end smoke test of the packaged release, run:

```powershell
$env:MORA_PACKAGED = '1'
$env:MORA_BUILD_MODE = 'release'
node apps/desktop-tauri/shell-smoke.mjs
node apps/desktop-tauri/autonomy-smoke.mjs
```

The scripts create disposable profiles in `probe-profile`. The autonomy test uses the real audio output with mute and zero volume, freezes WebView2 for 45 seconds, and tests recovery and a paused backend restart.
