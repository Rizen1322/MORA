# MORA iOS 1.0.14 (15): the AutoMix mixer in Swift

Branch: `ios`. Feedback on 1.0.13: blends sounded like plain crossfades, the phone got hot, the player showed no upcoming transition, and after the second song no blend played.

## Causes found

- **Heat.** 1.0.13 ran the TypeScript MixerCore in an app-process JavaScriptCore. iOS gives that context no JIT, so the DSP ran in an interpreter: on the iPhone one 85 ms block took up to 160 ms to produce, on macOS CI up to 370 ms.
- **Plain crossfades.** Native preparation asked the server with role `candidate`, i.e. analysis priority 50 (wave) instead of 90/100. Blends were planned before the tracks were analysed and were never planned again when analysis finished.
- **No transition in the player.** The native path never set `nextPlan`/`transition`.
- **No blend after the second song.** Not established from a report yet; the likely cause is the page being suspended while locked before the third track was prepared.

## Changes

- `NativeDSPRenderer.swift` is a Swift port of `engine/mixer.ts` with its DSP: WSOLA, playback speed/pitch transform, three-band isolator, DJ filter, echo, room, listener EQ/balance/mono, true-peak limiter, source loops and tape stops. Doubles for scalars and Float buffers, exactly like JavaScript numbers and Float32Array. iOS has no separated vocals; the vocal mask/throw/stem fit are not ported and such plans are not armed.
- The queue runtime (deck alternation, appended tracks, gapless continuation) is ported too and reads the uploaded PCM files directly through memory mapping. JavaScriptCore and the `native-mixer.js` bundle are no longer used by the app.
- Speed/pitch, EQ and volume (sleep timer fade) now apply natively and live (`nativeMixSettings`).
- The playing track is prepared with role `current`, upcoming ones with `next`. When analysis of a queued track finishes, its blends are planned again and replace the prepared ones unless that blend is already audible.
- The player shows the next blend (zone on the progress bar, countdown) and "AutoMix · …" while it plays, derived from the native audible position.

## Checks

- `check-native-dsp.mjs` (macOS CI): the Swift mixer renders 8 fixtures — transport/seek/pause/speed+pitch/stop, a stretched blend with echo/EQ/filter, and blends with listener tone, room, loop, tape stop, B delay, tempo glides and a later speed/pitch change, at 44.1 and 48 kHz — and every sample, phase and audible event agrees with Node within 2e-5.
- `check-native-mix.mjs` (macOS CI): a three-file queue with two blends, a start on the second track, and a speed/pitch/volume variant; Swift output equals the Node runtime exactly (max difference 0). Longest producer block on the CI Mac: about 3 ms (was 370 ms through JavaScriptCore). Not an iPhone measurement.
- Web/mobile unit tests include the analysis roles, transition state and replanning.

## Phone check

Install over 1.0.13. Play an album or playlist normally. Keep the app open for the first minute, then lock it and let at least three blends play. Check whether the phone stays cooler than 1.0.13, whether blends sound like the PC, and whether the player shows the upcoming blend. Export JSON afterwards.
