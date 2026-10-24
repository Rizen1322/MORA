# MORA iOS 1.0.9 (10): independent native playback baseline

Branch `ios`. This build follows the failed 1.0.8 WebKit/legacy-Native comparison. It adds a real native diagnostic player; normal music/AutoMix still uses the existing WebAudio engine.

## What the latest phone reports established

The user reported: WebKit Pause works, Next buttons are clickable without switching, scrubber does not work and the system clock visually resets after Pause; in legacy Native mode the same behaviour occurs but Next buttons are disabled.

Reports (3) and (4) contain 150 and 218 events respectively, including old persisted events. They are cumulative snapshots, not independent sessions. In the latest app run all seven WebKit handlers registered successfully. No `js.command.received` or `native.remote.callback` occurred in either route.

Relative to `native.load`, the WebKit run shows context suspension at +41.130 s and return at +41.949 s without a JS command, with automatic resume suppressed. Accepted published positions are 94.373 and 94.392 seconds, followed by continued progress. Legacy Native shows the equivalent at +77.209/+78.051 s, with positions 107.563/107.573 seconds. These pause/resume episodes do not publish a zero position. The trace does not measure the actual system UI clock, so its reported reset is still a device observation; accepted position publication is not proof of display correctness.

The experiment shows that simply switching JS/native command registrations did not repair this phone. Legacy Native was still **WebAudio sound + native navigation callbacks**, not a native audio host. The next comparison must remove WebKit from audible playback and Now Playing publication.

## New phone test — one mode, one report

1. Sign/install the IPA over the existing MORA using the same bundle ID and signing account.
2. Open **Диагностика → Нативный плеер · две тестовые мелодии** and tap **Запустить нативный тест**. Normal music pauses. A quiet original test melody A starts. Both A/B are real, finite 90-second WAVs generated locally; there is no network or ML.
3. Lock the iPhone. The card should show **MORA · тестовая мелодия A**. Try Pause → wait 5 seconds → Play, Next to melody B, Previous (after 3 seconds it restarts the current melody), and scrub to 60 seconds. Note audible results, button availability and any clock reset.
4. Also leave it paused for more than 3 minutes, then try Play while locked. This is an essential native recovery check.
5. Unlock and tap **Сохранить / поделиться JSON**. Export while the native test is still active so the report includes its native state. Markers preserve history; no clearing is needed.
6. Tap **Остановить тест и вернуться к музыке**. Normal music stays paused until explicit Play. The WebKit/legacy-route settings are disabled while this native test owns audio.

If the card never changes to the test title, say so. A disabled slider, wrong melody, stopped sound or missing callback is also useful evidence. The in-app test buttons operate the native player directly during the test and are labelled `source=test`; they do not simulate a system tap.

## Implementation and isolation

- `NativeProbeWave.swift` generates two distinct mono 22.05 kHz 16-bit WAV melodies. Complete files are cached in the app's own Caches/MORA/native-probe-v1 folder. No user tracks, library or credentials are copied or changed.
- `NativePlaybackProbe.swift` uses AVAudioPlayer with a native two-item queue, native command-center targets and MPNowPlayingInfoCenter metadata/elapsed time/rate. Pause, Play, Next, Previous and Seek execute in Swift. The second melody and automatic advancement require no JS producer.
- Before native start, normal controller Pause and explicit AudioContext.suspend complete. WebKit metadata/position/handlers are cleared, its audioSession type is temporarily auto, and further JS publication/commands are blocked. A running normal context prevents native start.
- Native Play session activation runs off the main queue, with revision guards so a later Pause cannot be undone by an old activation. The main queue owns player/metadata operations. Native interruption/route handling does not depend on a JS callback.
- Stop first releases the native player/targets/publisher and audio-session activation, then restores WebKit handlers, playback audioSession type and normal paused metadata. Failed release keeps WebKit blocked until a successful Stop. The normal engine awaits native-state recovery after a WebContent reload, preventing two active audio owners.
- No fake silent keeper or JS-wakeup promise is used. This is an audible native baseline, not a streaming PCM bridge, native AutoMix port or claim that the main music path is fixed.

## Journal

`native.probe.callback` records an actual MP callback; its ID is carried into `native.probe.command` and `native.probe.applied`. Test commands use source=test without a fabricated MP callback. Applied records handling acceptance/rejection, not hardware audibility. `native.probe.state` records position/duration/playing and melody index (`seq=0/1`) on actions and every 5 seconds while playing. There is no polling timer while paused. An MP callback's immediate success only means queued for main-thread handling.

The JSON report includes `nativeProbe: {active, playing, index, position, duration}`. Existing WebAudio snapshots remain separately visible with `probeActive=true`; those paused controller fields must not be mistaken for the native player's state. No user track titles, URLs, tokens or raw errors enter the journal.

## What this test decides

If real native commands/time work, that supports moving the actual iOS transport/control owner out of WebKit. It does not validate continuous JS-to-native PCM feeding or preservation of AutoMix. Those still require a producer/timeline prototype and audio comparisons. If native buttons/time also fail, investigate this native baseline/session integration and the OS route before migrating DSP.

Local validation covers bridge ordering, cleanup failures, duplicate-start prevention, command delegation, WebKit publication isolation and normal-engine blocking. CI additionally compiles/runs the pure Swift WAV checks, then builds the iPhone IPA through Xcode. Physical command delivery, heard output and long-pause wake require the phone run above.
