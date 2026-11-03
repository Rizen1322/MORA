# MORA iOS 1.0.11 (12): native AutoMix prepared-pair experiment

Branch: `ios`. This is the first device build that runs the existing `MixerCore` DSP through app-process JavaScriptCore and sends its actual PCM to native AVAudioEngine. It adds an explicit diagnostic mode for two real songs from the current queue. The ordinary player and the already-tested A/B baseline remain available.

## Phone check

1. Install/sign this unsigned IPA with the same signing account/bundle ID as before. Select a song with another song after it in the queue. Start near the beginning, with speed 1× and pitch 0.
2. Open **Диагностика → Нативный AutoMix → Запустить пару из очереди**. Keep the app visible until preparation finishes. This copies complete original PCM to private native cache files; the displayed seconds show progress. Preparation can be cancelled. Library files are not moved or changed.
3. Lock the phone and try Pause/Play, scrub, Next and Previous. Previous after three seconds restarts the current song; within three seconds it returns to the first song. Next on the second song is intentionally unavailable: this queue has only two tracks.
4. To hear the planned transition soon, return to the panel while the first song is selected, tap **За 8 с до DJ-перехода**, then lock the phone. Listen for continuity and confirm the title changes near the heard switch. Also test Play after a pause longer than three minutes.
5. Export diagnostics JSON while native AutoMix is still active. Stop AutoMix in this panel to return to the ordinary player, which remains paused until explicitly started.

The main player UI stays paused while this separate diagnostic mode owns audio. Use this panel or system controls during the test. This build does not claim the ordinary player has fully migrated.

## Implementation

- `native-mixer.ts` hosts the same `MixerCore`, with two decks, the existing planner's full-mix transition, normalization, EQ/filter/echo/tempo automation, and optional captured master tone. It does not load local models or separated vocal PCM. Plans use the existing `fallbackWithoutVocalStems` policy rather than inventing another crossfade algorithm.
- Full decoding/preparation happens while foregrounded using the existing page-side decoder. Each float-stereo chunk is transferred sequentially to private native cache. Only `X-Complete` and the actual frame count establish EOF; estimated duration never finalizes a truncated file. Combined native input is capped at 384 MiB. Once started, this finite pair requires no WebKit callbacks, worker responses, downloads or page-side PCM producer.
- `NativeDSPRenderer` owns a JavaScriptCore context on a serial native producer queue. A synchronous reader supplies bounded file chunks; JS emits planar typed arrays. Swift copies borrowed JSC pointers immediately into owned data and schedules native buffers. No JS, file read, lock, DSP allocation or VM wait runs in the audio completion callback.
- The producer renders 4,096-frame buffers and keeps at most eight scheduled (about 0.68 s at 48 kHz). A `.dataPlayedBack` callback dispatches refill work to the serial queue. Rendered/queued frame counts remain separate from presented position. Per-128-frame deck/position marks map native player time onto source track time. Completed-buffer callbacks account for device latency; interpolation between those checkpoints uses native player time minus reported output latency. This position remains an estimate requiring phone measurement, especially with Bluetooth.
- Pause preserves scheduled audio and pauses the engine. Seek/skip creates a fresh core and flushes old buffers; an epoch prevents cancelled callbacks from changing the new timeline. Seeking beyond the first track's planned trigger cancels that transition for the new run and advances at EOF; seeking before it can arm the original plan again. This avoids retroactively firing an already-passed mix.
- Native Swift owns six MPRemoteCommand targets and Now Playing state. Interval/continuous skip commands stay disabled. JS metadata/handlers and WebAudio are suppressed while this mode owns audio. Foreign native owners are rejected before rollback; failed session release keeps WebKit isolated.
- Interruption/route handling, a native command journal, render/queue/presentation counters, maximum block generation time and starvation counts are included. No track titles, provider IDs or PCM enter the journal. Cached native PCM is removed on successful Stop.

## Boundaries

This is a finite pair, not an endless radio/playlist service. There is no background preparation of a third song. Speed/pitch transformations outside 1×/0, live streams, vocal-stem transitions, artwork, ordinary-player UI/state/history integration, and persistent queue restoration are outside this first mode. Captured tone/gain settings stay fixed until another pair is prepared. A media-services reset fails the test explicitly rather than resuming stale audio.

Device CPU, GC stalls, memory, battery use, background longevity and audible buffer continuity need measurement. The bounded buffer queue is an implementation choice, not a proven latency or efficiency guarantee. Native file-reader/typed-array/timeline parity is tested against Node on macOS; iOS compilation alone cannot establish these device properties.
