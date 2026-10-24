# MORA iOS 1.0.7 (8): diagnostic IPA

This build investigates missing lock-screen Pause/Play/Next/Previous/Seek on iPhone 15 Pro Max / iOS 27. It does not claim a lock-screen fix. Source and macOS build use the `ios` branch. The release is a prerelease and must not replace the stable Windows release as Latest.

## On the phone

1. Sign/install the unsigned IPA over MORA with the same bundle identifier (`ru.mora.player`) and signing account. Do not delete the installed app first.
2. Open **Диагностика**, find **Управление на экране блокировки**. Queue the same two tracks for both runs, preferably already available on the phone.
3. Leave **Автовозобновление звука** enabled, start playback, tap **Начать запись**. Lock the phone and wait 10 seconds. Try Pause, Play, Next, Previous and moving the progress slider, leaving 3–5 seconds between commands. Record approximately when you tapped and whether sound changed. A grey/unavailable slider is also a result; do not repeatedly tap it.
4. Unlock, tap **Сохранить / поделиться JSON** and save the report as the first run. The button opens the system share sheet; nothing is uploaded automatically.
5. Turn off auto-resume, tap **Начать запись**, start playback and repeat. Export a second report, keeping the first. Playback may stop when locked with recovery disabled; note that result too. Restarting the app restores the default enabled option.
6. If useful, **Проверить доставку команды внутри приложения** sends a labelled native test event through the same Capacitor listener. This validates only that bridge and the engine; it is not a simulation of a system remote-control tap.

## Reading the trace

- `native.remote.callback`: native MPRemoteCommandCenter callback entered. Its `.success` result means accepted by the callback, not executed by JS. Existing native navigation and WebKit play/pause registration stay in place; no second Now Playing publisher or native play/pause target is added.
- `native.send` → `js.command.received` → `controller.action` → `controller.post` → `engine.ack` → `engine.render`: command delivery and render snapshots. Match `id`, then the engine `seq`. JS WebKit callbacks use `source=webkit`; native test commands use `source=test`. Notifications/interruption commands are labelled separately.
- `engine.ack` follows command handling on the audio thread. `engine.render` is an output-block observation, **not** a promise that a musical transition/seek finished. Pause waits for a full paused block (or a 0.5 s audio-frame timeout). Commands not rendered because the context stopped will have no render observation.
- Controller correlation represents the most recently entered playback intent. Asynchronous preparation may post commands after a newer intent; interpret the journal together with the existing generation/intent guards, not as proof of exact async causality.
- `context.event`, `context.autoResume.*` and `context.explicitResume.*` distinguish a WebKit suspension from a delivered JS pause. The switch suppresses only the existing automatic recovery; explicit Play still calls resume. `engine.tick` every 5 seconds records controller status, context state and mixer pause state.
- `js.handler.resolved` describes the handler's promise only. It is not an audio acknowledgement. Missing handlers and rejected handlers have separate entries. No native or JS entry from a real tap means delivery is unproven; enabled buttons alone are not proof of command ownership.

## Storage and scope

The Info.plist `MoraPlaybackDiagnostics` flag enables this build only. Removing it disables the journal and UI; production/old shells have no diagnostic object. The native private ring persists up to 1200 events and flushes at most twice per second, plus immediately when backgrounding. The JS bridge bounds outstanding writes to 64; excess observations are dropped rather than building an unbounded queue. A stopped/suspended process cannot log until it runs again.

Both JS and native sides allow only explicit numeric, boolean and short code fields. No titles, track/provider identifiers, tokens, source URLs, artwork, raw errors, library data, hardware serial, device name or Bluetooth names are read into the report. Runtime metadata includes app/SDK/OS versions, generic hardware model code, audio port types and session configuration. AVAudioSession activity is reported as unknown, since the public API has no activity getter. Reports leave the phone only through the user-opened share sheet.

Local verification: TypeScript workspace checks; production mobile build; regression tests for MediaSession routing, cross-bundle IDs, bounded queues/privacy, automatic-resume suppression, controller races and real MixerCore output through the worklet adapter. macOS CI compiles the native device app; physical lock-screen delivery still requires these phone reports.
