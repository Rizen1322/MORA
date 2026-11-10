# MORA iOS 1.0.32 (33)

- Native player: artwork, inline continuation queue, system volume, likes/dislikes; transport remains visible in the queue. Queue rows show the actual AutoMix method.
- System UITabBar: Home, Library, Search; library opens likes, playlists, artists, albums, songs and downloads. Artists of liked tracks are available separately.
- Lock-screen like/dislike uses MPRemoteCommandCenter. Native reactions are persisted on the phone immediately; the existing library/provider API synchronizes them once WebContent is active. An older response cannot clear a newer reaction.
- iPhone Yandex Wave reuses metadata already returned by rotor, skips blocking cover downloads and starts with one track before refilling.
- Queue handoff gives native the next two songs first, then extends in batches of 32. Large lists no longer fail the 1000-entry source request limit. Native manifests support up to 10000 tracks; the existing native source-file budget still applies.

- Native recording picker: local recordings and YouTube Music/YouTube/SoundCloud search, quick variants, native audio preview with seeking, replace/restore and save separately. Replacement keeps the original title, artist and cover in the library, queue and Now Playing; only audio/duration/analysis follow the chosen recording. Changed upcoming entries are prepared again.

Validation: TypeScript (server, web, mobile); targeted regression tests; native state assertions are included in macOS CI. Physical iPhone, provider network latency and lock-screen button presentation require device verification. The system decides which remote feedback buttons to display.

Unsigned IPA, bundle ru.mora.player; install over the previous app with the same signing identity to preserve the library.
