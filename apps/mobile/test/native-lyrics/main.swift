import Foundation

// Self-check for NativeLyrics.swift: LRC parsing, title cleaning, confidence scoring,
// Whisper word alignment validation, sidecar reading, LRCLIB retries/fallback and disk caching.

func fail(_ message: String) -> Never { fatalError("FAIL: " + message) }
func check(_ condition: Bool, _ message: String) { if !condition { fail(message) } }
func jsonData(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }

// MARK: LRC & cleaning

let lrc = """
[ar: Artist]
[offset:+500]
[00:10.00][00:02.00] Chorus line
[00:00.20] Intro
[00:05:50] Middle line
"""
let parsed = NativeLyricsParser.parseLrc(lrc)
check(parsed.count == 4, "multi-stamp and standard lines")
check(abs(parsed[0].time - 0.0) < 0.001 && parsed[0].text == "Intro", "negative adjusted stamp clamps to 0")
check(abs(parsed[1].time - 1.5) < 0.001 && parsed[1].text == "Chorus line", "sorted earlier stamp with offset")
check(abs(parsed[2].time - 5.0) < 0.001 && parsed[2].text == "Middle line", "colon fractional separator")
check(abs(parsed[3].time - 9.5) < 0.001 && parsed[3].text == "Chorus line", "second chorus stamp")

check(NativeLyricsParser.cleanTitle("Song (Official Music Video) [Lyrics] (Премьера 2026)") == "Song", "strips decorations")
check(NativeLyricsParser.cleanTitle("Song (Remix) (HD)") == "Song (Remix)", "preserves remix version")
check(NativeLyricsParser.cleanTitle("Track [Live] [4K]") == "Track [Live]", "preserves live version")
check(NativeLyricsParser.primaryArtist("Ёлка feat. Баста") == "Ёлка", "primary artist before feat")

// MARK: matching & Whisper

check(NativeLyricsParser.normalizeMatchText("Ёлка feat. M.O.") == "елка feat m o", "NFKC + ё -> е")
let exactScore = NativeLyricsParser.matchConfidence(
    targetTitle: "Ёлка", targetArtist: "Звери", targetDuration: 180,
    candTitle: "Елка", candArtist: "Звери", candDuration: 181
)
check(exactScore >= 0.9, "exact normalized match >= 0.9: \(exactScore)")
let remixPenalty = NativeLyricsParser.matchConfidence(
    targetTitle: "Song", targetArtist: "Artist", targetDuration: 180,
    candTitle: "Song (Slowed + Reverb)", candArtist: "Artist", candDuration: 180
)
check(remixPenalty < 0.7, "unrequested alternate tag drops below threshold: \(remixPenalty)")

let whisperValid: [String: Any] = [
    "version": "whisper-words-1",
    "words": [["start": 1.0, "end": 1.3, "word": " Hello"], ["start": 1.35, "end": 1.7, "word": " world."]],
    "lines": [["start": 1.0, "end": 1.7, "text": "Hello world."]],
]
let whisperLines = NativeLyricsParser.parseWhisperLyrics(whisperValid, duration: 10)
check(whisperLines?.count == 1 && whisperLines?[0].words.count == 2, "valid whisper alignment")
check(NativeLyricsParser.parseWhisperLyrics(["version": "other", "words": [], "lines": []], duration: 10) == nil, "invalid version rejected")
check(NativeLyricsParser.parseWhisperLyrics([
    "version": "whisper-words-1",
    "words": [["start": 1.0, "end": 12.0, "word": " Bad"]],
    "lines": [["start": 1.0, "end": 12.0, "text": "Bad"]],
], duration: 10) == nil, "out-of-duration word rejected")

// MARK: service retries, search fallback & cache

let row: [String: Any] = [
    "trackName": "Song", "artistName": "Artist", "duration": 180,
    "syncedLyrics": "[00:01.00]First line\n[00:04.00]Second line",
]

var calls = 0
let suite = "mora-lyrics-test-" + UUID().uuidString
let defaults = UserDefaults(suiteName: suite)!
let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("mora-lyrics-test-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
defer {
    defaults.removePersistentDomain(forName: suite)
    try? FileManager.default.removeItem(at: tempDir)
}

// 1. Retries 503 on exact lookup and succeeds
calls = 0
let retryService = NativeLyricsService(fetch: { req in
    calls += 1
    if calls == 1 { return (503, Data()) }
    return (200, jsonData(row))
}, defaults: defaults)
let recovered = try await retryService.findLyrics(title: "Song", artist: "Artist", duration: 180)
check(recovered.status == "synced" && recovered.lines.first?.text == "First line" && calls == 2, "retries 503 once")

// 2. Falls back to search when /api/get returns 404, rejecting >4s duration mismatch
var paths: [String] = []
let fallbackService = NativeLyricsService(fetch: { req in
    paths.append(req.url?.path ?? "")
    if req.url?.path == "/api/get" { return (404, Data()) }
    let wrongDur: [String: Any] = ["trackName": "Song", "artistName": "Artist", "duration": 195, "syncedLyrics": "[00:01.00]Wrong"]
    return (200, jsonData([wrongDur, row]))
}, defaults: defaults)
let searched = try await fallbackService.findLyrics(title: "Song", artist: "Artist", duration: 180)
check(paths == ["/api/get", "/api/search"] && searched.lines.first?.text == "First line", "search fallback filters by duration")

// 3. Double 503 + empty search throws error (never caches as .none)
let failingService = NativeLyricsService(fetch: { req in
    if req.url?.path == "/api/get" { return (503, Data()) }
    return (200, jsonData([]))
}, defaults: defaults)
do {
    _ = try await failingService.findLyrics(title: "Song", artist: "Artist", duration: 180)
    fail("failed lookup must throw instead of returning .none")
} catch {}

// 4. Disk caching & refresh: true
var netLoads = 0
let cachedService = NativeLyricsService(fetch: { _ in
    netLoads += 1
    return (200, jsonData(["trackName": "Song", "artistName": "Artist", "duration": 180, "plainLyrics": "Load \(netLoads)"]))
}, defaults: defaults)
let firstLoad = try await cachedService.load(trackId: "tr-cache", title: "Song", artist: "Artist", duration: 180, cacheDir: tempDir)
let secondLoad = try await cachedService.load(trackId: "tr-cache", title: "Song", artist: "Artist", duration: 180, cacheDir: tempDir)
check(netLoads == 1 && firstLoad.plain == "Load 1" && secondLoad.plain == "Load 1", "disk cache avoids second network call")
let refreshed = try await cachedService.load(trackId: "tr-cache", title: "Song", artist: "Artist", duration: 180, refresh: true, cacheDir: tempDir)
check(netLoads == 2 && refreshed.plain == "Load 2", "refresh bypasses disk cache")

// 5. Offset persistence & fixture override
cachedService.saveOffsetMs(750, for: "tr-cache")
check(cachedService.savedOffsetMs(for: "tr-cache") == 750, "offset persisted")
cachedService.saveOffsetMs(99_000, for: "tr-cache")
check(cachedService.savedOffsetMs(for: "tr-cache") == 30_000, "offset clamped to +30s")
cachedService.installFixture("fix-1", NativeLyricsResult(status: "synced", lines: [NativeLyricLine(time: 12, text: "Fixture line")], plain: "Fixture line", source: "lrclib"))
let fix = try await cachedService.load(trackId: "fix-1", title: "X", artist: "Y", duration: 60)
check(fix.lines.first?.text == "Fixture line", "fixture returned without network")
cachedService.removeFixtures()

// 6. Sidecar .lrc/.txt files
let audioURL = tempDir.appendingPathComponent("track.mp3")
let lrcURL = tempDir.appendingPathComponent("track.lrc")
try Data("[00:03.00]Sidecar line".utf8).write(to: lrcURL)
let sidecar = NativeLyricsParser.sidecarLyrics(audioFile: audioURL)
check(sidecar?.status == "synced" && sidecar?.source == "file" && sidecar?.lines.first?.text == "Sidecar line", "sidecar lrc parsed")

print("Native lyrics: LRC, cleaning, confidence matching, Whisper validation, LRCLIB retries/fallback, sidecar and cache passed")
