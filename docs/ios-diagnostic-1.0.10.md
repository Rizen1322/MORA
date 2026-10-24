# MORA iOS 1.0.10 (11): music buttons in the native baseline

Source branch: `ios`. This is a small follow-up to the independent native player introduced in 1.0.9. The primary music/AutoMix path has not yet migrated to a native audio host.

## Confirmed by the phone run

Report `MORA-playback-diagnostics (5).json` from iPhone 15 Pro Max / iOS 27.0.1 contains 414 cumulative events, including older builds. The current native probe reports AVAudioSessionCategoryPlayback and 28 native MP callbacks, 28 native command entries, and 28 applied/accepted entries.

System Pause, Play and absolute seek reach Swift and change native transport state. The user confirms that heard Pause/seek work and that Play after more than 3 minutes works normally.

The long-pause example, relative to `js.probe.prepared`:

- +51.089 s: native paused melody B at 6.895 s.
- +240.576 s: a system Play callback arrives, after approximately 189.487 s of pause.
- +240.653 s: native transport reports playing at 6.859 s and accepts that command. These are AVAudioPlayer timing observations, not an exact hardware-latency measurement.

This is evidence for native transport/control viability on the tested phone. It is not evidence that a WebKit Worker can feed native audio indefinitely or that AutoMix has been preserved in a new host.

## Why the user saw ±10 seconds

The 1.0.9 probe enabled both next/previous and skipForward/skipBackward interval commands. The displayed iOS controls were ±10 seconds. Those taps appear as seekforward/seekbackward in the native journal; there are no physical nexttrack/previoustrack callbacks in that run. Automatic advance from melody A to B did occur, but it is not a test of the Next button.

The 1.0.10 probe no longer registers/enables interval-skip or continuous-seek commands. It enables Play/Pause/Toggle, Next, Previous and absolute changePlaybackPosition. This requests music-style track controls while retaining the scrubber. Actual system presentation still requires the brief phone check below. Report nativeProbe.commandAvailability now includes the local next/previous/position and interval-skip flags, which are configuration evidence, not proof of the UI.

## Short phone check

1. Sign/install 1.0.10 over MORA, preserving the signing account and bundle ID.
2. Open **Диагностика → Нативный плеер → Запустить нативный тест**.
3. Lock the phone. Check whether next/previous track buttons replace ±10. Press Next: melody A/title A should become B/title B. Press Previous within 3 seconds to switch back; after 3 seconds Previous restarts the current melody by policy.
4. Check that the scrubber still moves the heard position. Export one JSON while native playback is active, then stop the native test to return to normal music.

No repeat of the long-pause test is required for this small control-configuration change unless behaviour regresses.

Native AVAudioPlayer, the complete cached WAV files, activation/revision guards, interruption handling and WebKit isolation remain the same. The next production step is a native main transport/renderer that preserves the existing AutoMix, with independent validation of DSP timing and preparation in the background. Do not replace the working DJ mixer with a simple file player and claim the migration is complete.
