# MORA iOS 1.0.13 (14): the ordinary player on native AutoMix

Branch: `ios`. Phone report (9) for 1.0.12 confirmed the native prepared pair: `transitionStart`, `swap` and `transitionEnd` with `late=false`, zero underruns, cover art ready, and working Pause/Play, Next/Previous and seeking on the lock screen. The four `fallback` records in that file predate 1.0.12 (no `artworkReady` field, 17 minutes earlier).

## What changed

- The ordinary player (queue, Play/Pause, Next/Previous, seeking, jumping in the queue, waves/radio) now plays through the native host instead of the WebKit AudioWorklet. Diagnostics has a switch back to WebKit, applied after an app restart.
- The native runtime is no longer a pair: track *i* plays on deck *i* mod 2, with the DJ transition planned from track *i − 1*. After each blend (or gapless end) it loads the next track itself, so the native queue continues without the page.
- The page uploads the audible track and keeps **two tracks ahead** prepared (whole PCM file plus the planned blend), publishing each as soon as it is ready. Queue edits replace the upcoming tracks, except one that is already blending in. A track appended after the queue ran out starts gaplessly.
- The host deletes files of tracks before the previous one; Previous on the lock screen works for one track back. Now Playing shows the real queue position/count; Next is disabled on the last prepared track.
- The page polls the native state (twice a second when visible) and follows the audible track: queue index, position, history (`transition`/`skip`) and wave top-ups.

## Known limits

- Preparation runs in the WKWebView (provider download, decode, planning). Whether iOS keeps that page running while the screen is locked with native audio is **not established**. The two prepared tracks cover roughly 6–10 minutes; if the page is suspended, the queue stops after them and continues once MORA is opened again.
- Speed/pitch are not applied natively (1×, original key; a notice is shown). Tone/EQ and loudness are captured when a track starts. Vocal-stem blends fall back to the full-mix plan. Manual Next is an instant switch, not a quick blend. The player UI shows no transition countdown.
- Each prepared track is a 48 kHz float file (about 23 MB per minute) in Caches; at most about four are kept.

## Phone check

Install over 1.0.12. Play an album or playlist normally from the app (not from Diagnostics). Lock the phone and let it play through **at least three transitions** (about 10–15 minutes). Check Pause/Play, Next/Previous, seeking and covers on the lock screen, then unlock, check that the app shows the right song and position, and export JSON. If the music stopped while locked, note after which song.
