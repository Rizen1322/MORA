# MORA iOS 1.0.8 (9): E1 command-route and clock investigation

Source branch: `ios`. This is a diagnostic prerelease following 1.0.7 and the independent review. Physical lock-screen Next/Seek and long-pause recovery are not yet confirmed fixed.

## Phone test

1. Sign/install the unsigned IPA over MORA with the same bundle ID (`ru.mora.player`) and signing account. Keep the existing installation/data.
2. Open **Диагностика → Управление на экране блокировки**. Defaults are **WebKit** route and automatic recovery **off**. Leave recovery off during the route comparison.
3. Queue two prepared/local tracks. Start music and wait until the position exceeds 15 seconds. Tap **Поставить метку теста**. This preserves previous events; recording is continuous.
4. Lock the phone, wait 10 seconds while hearing music. Try Pause → wait 5 seconds → Play → wait 5 seconds → Next → Previous → scrub the position. Note approximate tap times, audible response and the displayed clock. An unavailable button/slider is a result too.
5. Unlock and tap **Сохранить / поделиться JSON**. Save this report separately as the WebKit run. Do not clear the journal.
6. Expand **Сравнить маршруты системных команд**, select **Native — прежний**, wait for the switch to finish. Start music again, tap the marker and repeat. Export a second JSON separately. Both files may contain shared earlier history; marker and route events identify each run.
7. Also note the result of Play after a pause longer than 3 minutes. This tests the existing idle suspension; working short Pause/Play does not imply this case works.

The advanced **Очистить весь журнал** button is the only explicit history reset. Reports stay on the phone until the user opens the share sheet. No track titles, URLs or provider tokens are logged.

## Changes

- Marker and clear are separate. Marker/export snapshots include controller intent/status/position, actual context state, last mixer pause observation, declared media state, route and recovery option when available.
- Recovery is off by default on native iOS, including before diagnostics initialize. The existing desktop recovery remains. The diagnostic option can re-enable the previous recovery for a separately marked experiment; restart restores off.
- Context statechanges notify the mobile bridge. Effective system playback is controller-playing **and** context-running. A direct WebKit suspension freezes the published clock at the last engine position; context return republishes that position and allows an immediate first-tick correction.
- A context statechange does not invent a new user Play/Pause intent or unpause MixerCore. A later running state cannot cancel an explicit controller Pause. Native interruption policy receives intent separately from effective playback, preserving the possibility of legitimate shouldResume recovery.
- `setPositionState` keeps a nonzero playback rate. Position/duration/rate, metadata sequence (no title/identity), route, publication reason and accepted/rejected/unavailable outcome are recorded. Unchanged paused positions are not republished continuously. Metadata/artwork retain their existing immediate position correction.
- Default command route registers real handlers in WebKit for all actions. Swift installs no native navigation targets on cold WebKit startup and does not overwrite command-center capability flags then.
- The legacy Native route remains selectable for comparison. Switches are serialized: WebKit navigation is removed, the old native route is disabled, then the selected route is registered. Only this plugin's targets are removed. Epochs reject late callbacks from earlier routes; stale native configuration calls are ignored. Notifications and labelled diagnostic test events remain separate.
- Schema 2 adds numeric duration/rate, intentPlaying and short route/kind/mediaState fields to both allowlists. New values still pass the same finite-number/short-code privacy filters. Existing persisted schema-1 rows can appear in an upgraded report.

## Limits and interpretation

WebKit controls are an experiment, not proof that AudioContext supports seeking. There is still one WebKit metadata publisher and no native audio host. Native enabled flags alone do not establish command ownership. The user's long-pause case may still require another transport architecture.

Controller status is the latest intent/transport status, while `js.media.publish` state represents effective context playback. During a direct WebKit Pause, controller status may remain playing with context suspended and mediaState paused. This is deliberately explicit in the trace; we do not guess that every suspension is a user Pause or that every running event is user Play. The last engine position can lag by a telemetry interval; device verification must check heard/displayed alignment.

Neither `engine.ack`, handler promise resolution nor a render-block observation proves audible hardware output or completion of a musical transition. Match a real tap with callbacks, engine state and the user's audible/displayed result. Diagnostic test buttons exercise the bridge; they do not synthesize a system tap.

No native session-category change, silent keeper, PCM bridge or DSP rewrite is included. Those would add independent variables to this comparison. A future native host must prove producer execution in the background and distinguish rendered/queued/presented frames before it can claim preserved AutoMix timing.

## Verification

Regression coverage includes history-preserving markers, positive-speed clock publications across context Pause/Play, failure telemetry, route switching and stale callbacks, no automatic native context resume, and preserving an explicit Pause on later context running. Existing controller/PCM and worklet tests remain. Workspace TypeScript checks and production mobile build are required; macOS CI compiles Swift/device IPA. Only the phone test above can verify actual lock-screen delivery.
