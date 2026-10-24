# MORA: background queue investigation, 2026-10-25

## Device observations from 1.0.15

- The page still lists six future entries, but the Lock Screen stops offering Next
  after the current track and two prepared tracks. The last available track ends in silence.
- Briefly reopening MORA makes another three tracks accessible. This is a native
  prepared-buffer refill problem, not evidence that the visible playlist is exhausted.
- An artist page can initially offer no Next at all.
- A native prepared track has no Lock Screen duration/seek bar. The in-app position
  stays at zero after foregrounding, even while the sound plays. Track/cover mismatch
  is visible, and the foreground queue-handoff toast repeats unnecessarily.

## Confirmed defects and changes

1. `NativeMixHost` read `totalFrames as? Double`. Bridge numbers are NSNumber, but
   native preparation inserts a concrete Swift Int; its cast to Double returns nil.
   Duration became zero, position was clamped to zero, and seeking was clamped to zero.
   A macOS Swift regression reproduced this with 357 * 48000 frames before fixing it
   through NSNumber.doubleValue in `NativeMixTimeline`.
2. The page inferred an active incoming overlap from track position. Zero or seeked
   positions made an old overlap appear active, showing the previous cover and the
   current song as its own incoming next song. The renderer now includes actual
   audible overlap/progress in marks; an explicit null clears the page's overlap.
3. The successful handoff toast was a product nuisance. It is removed; handoff and
   preparation state belong in Diagnostics.
4. Next availability was based only on decoded files. A known future song still
   preparing was treated like a missing queue entry. Next can now keep a native
   pending request, leaving current audio running until the replacement is ready.
5. MIR/planning exceptions could skip otherwise decodable audio and stop after three
   consecutive errors. Analysis failure now permits a fallback plan; planner failure
   permits sequential playback. Cancellation still cancels work. Transfer/decode
   failures remain failures and are reported instead of claiming a valid song.

Items 1–3 explain the metadata/UI regressions. They do **not**, by themselves, prove
the exact cause of the device's three-track refill stop. The new fallback and pending
Next paths also need device verification, not just source inspection.

## What Apple actually documents

[Apple's AutoMix announcement](https://www.apple.com/newsroom/2025/06/apple-services-deliver-powerful-features-and-intelligent-updates-to-users-this-fall/)
describes audio-feature analysis, beat matching and time stretching. Apple's
[transition guide](https://support.apple.com/guide/iphone/transition-songs-iphadf2fe1f4/ios)
says the system chooses an appropriate transition; sometimes that is silence removal
or a simple crossfade. Apple does not publish Apple Music's complete queue scheduler,
download pipeline or proprietary implementation. We cannot claim a particular private
Apple Music architecture from these descriptions.

Public APIs provide the relevant building blocks:

- [Media playback configuration](https://developer.apple.com/documentation/avfoundation/configuring-your-app-for-media-playback):
  playback audio session plus the audio background mode.
- [AVAudioPlayerNode](https://developer.apple.com/documentation/avfaudio/avaudioplayernode):
  schedules consecutive PCM buffers/files and provides consumed/rendered/played-back
  callbacks for feeding additional sound. The player timeline differs from a UI timer.
- [Background networking](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background):
  apps with the appropriate background mode may use ordinary URL sessions/data tasks.
  A background URLSession separately handles transfers while an app is suspended, but
  it has different scheduling/redirect restrictions; changing the configuration is not
  automatically a fix for this audio pipeline.

MORA already uses a playback session, audio background mode, Swift DSP and native
URLSession. Its correctness must be established across the producer and audio consumer,
not by assuming that having these APIs guarantees continuous playback. No local ML
model is required for MORA's existing beat/energy analysis and transition planner.

## Missing proof in the old test

The old eight-preparation fixture calls `NativeQueuePreparation` directly and advances
its gate inside the fake accept callback. It never tests
`NativeMixHost.played -> updatePosition -> publish -> gate.advance`, actual renderer
updates or native Next availability. Its passing result was not a Lock Screen test.
Luna independently identified the same coverage gap.

The new Simulator harness builds a minimal iOS app containing the real NativeMixHost,
AVAudioEngine, producer and bundled planner, with **no WebView or Capacitor**. It leaves
the foreground, plays eight fixture tracks naturally, then separately checks repeated
Next and seeking. Physical-device scheduling, provider HTTP and long-song analysis
remain separate checks even if this harness passes.

## Diagnostic decision table

| Observation while stopped | Investigate |
| --- | --- |
| Audible index advances; preparation waits for an eligible gate | Native producer/consumer permit signalling |
| `downloading` with a growing stage age | HTTP request, provider response and timeout |
| `analyzing` with a growing stage age | MIR execution time, cancellation and fallback |
| Failure count rises with a reason | Transfer, decode, file budget or commit rejection |
| Ready count rises but native queue count does not | Ownership, renderer update and commit |
| Native position advances but the page does not | Bridge/poll recovery on foregrounding |

The preparation snapshot now exposes its stage age, running flag, gate upper bound
and waiting index, in addition to ready/remaining/failure counts. A device JSON must
cover the point before reopening the app, because a foreground handoff can replace
the stalled producer. Do not declare the three-track problem fixed solely because
the page displays a longer queue or a macOS fixture passes.
