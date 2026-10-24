# MORA iOS 1.0.12 (13): native transition admission and artwork

Branch: `ios`. This updates the prepared-pair native AutoMix experiment from 1.0.11. The ordinary player is still WebKit; native mode still owns only two fully prepared songs.

## What report (8) established

The latest 1.0.11 session has no `transitionStart`, `swap` or `transitionEnd` events. Twice it records `fallback`, then `fallback`/`ended`, followed by the second song starting near zero. The planned trigger is 159.3 seconds; the user also used the panel's seek to 151.3 seconds, eight seconds before that trigger. The final native snapshot has `failed=false`, `underruns=0`, and maximum producer time around 112 ms on the tested iPhone. Output starvation is not the transition admission problem.

The old journal kept only the event type and dropped the fallback reason. A controlled reproduction now fails with `buffer_not_ready` at both 44.1 and 48 kHz. The native adapter requested two seconds ahead (2.2 seconds after the core's request margin). MixerCore's admission gate for a normal transition requires up to `3 * sampleRate * 1.15 + 4096` incoming frames, approximately 3.54 seconds. The incoming idle deck never accumulated enough PCM to start. Earlier tests used short transitions that passed with the smaller window.

## Changes

- Native PCM prefetch is four seconds ahead, or 4.4 seconds with the existing request margin. This satisfies the unchanged mixer admission gate without weakening its readiness check. Input remains chunked and evicted; scheduled output remains capped at eight buffers. No alternative transition algorithm or local model is introduced.
- Regression tests run eight-second transitions with a nonzero incoming cue and an eight-second lead-in seek at both sample rates. They require start/swap/end in order, `late=false` and no fallback. The macOS Swift file/JavaScriptCore parity fixture now uses a 2.5-second transition and explicitly rejects fallback too.
- Covers for both queue songs are fetched before start through the existing native/API artwork loader. The optional fetch has an eight-second wait limit; absence/failure does not prevent playback. URLs are removed before passing the prepared metadata to Swift. Cancelling during this step cannot start audio afterwards.
- Swift decodes a bounded ImageIO thumbnail (at most 512 pixels on its longest side, original aspect ratio), then installs an `MPMediaItemArtwork` for the audibly selected track. The encoded input is capped at 2 MiB and 8192 pixels per axis. Encoded images are stripped out of the DSP configuration so seeking does not reinsert them into JavaScriptCore. Artwork follows automatic swaps and manual Next/Previous/Seek selection. The optional `artworkReady` flag enters snapshots/journal without image data or URLs.
- Render events now record `kind` (event type), `reason` (actual fallback/abort code) and `late`. The native journal whitelist now actually retains rendered/queued/presented counts, epoch, maximum producer duration and underrun count; these fields were previously present only in the snapshot.

The artwork API uses Apple's [bounds/request-handler initializer](https://developer.apple.com/documentation/mediaplayer/mpmediaitemartwork/init(boundssize:requesthandler:)). Image decoding and resizing are outside audio callbacks.

## Phone check

Install/sign 1.0.12 over the previous app. Start a fresh native pair from the queue using **Диагностика → Нативный AutoMix**, keeping the app visible until preparation ends. On the first song tap **За 8 с до DJ-перехода**, then lock the phone. Listen through the overlap, check title/cover selection, and export JSON while native mode is active. Also check that Next/Previous changes the cover. Songs without an available cover can still have no artwork.

The automated reproduction and native parity checks verify the corrected code path. Audible transition quality and system artwork presentation still need this phone run. No repeat of the entire previous lock-screen investigation is required unless controls regress.
