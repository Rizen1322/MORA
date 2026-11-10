# MORA Native 0.4.1

Windows x64 release: Tauri/WebView2 interface, Rust audio engine and network helper, Symphonia primary decoding. The catalog backend still runs in the bundled Node runtime. FFmpeg is retained for incompatible inputs and AAC gapless correctness; it is not the default decoder for all files.

## Changes

- Integrated window controls replace the separate Windows title row. Controls remain accessible in the full and compact players. Empty top-bar areas drag the window; a double click toggles maximization. Closing uses the existing close-to-tray preference.
- Online radio retains recent artists across backend refill requests. Artist spacing considers every credited collaborator, preferring a four-track gap over affinity when alternatives exist. A smaller candidate pool uses the least recent artist while the existing three-in-a-row guard remains in force.
- Saving settings during native station startup no longer strands the starting flag, playback progress, seeking or transition state.
- Release shell uses the Windows GUI subsystem; the decoder's compatibility child suppresses its console as well.
- Installer is localized in Russian and English, uses the MORA icon and installs for the current user. Existing Native profile location is unchanged.

## Verification

Before these final UI/radio changes, 1276 tests in 164 files passed. The changed radio, shell-bridge and connected playback/controller paths subsequently passed 51 tests in nine files. Web and server TypeScript checks passed. Packaged hidden shell, frozen-interface queue/recovery, and muted native output checks are performed separately on the final installer payload.

Installer execution against the user's live installation and a long listening session are not part of disposable-profile verification. The installer is unsigned. This release is distributed as a separate Native installer; the Electron latest.yml feed is not replaced.
