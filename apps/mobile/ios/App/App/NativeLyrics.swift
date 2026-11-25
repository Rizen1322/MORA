import Foundation

/// Single karaoke word span with exact start/end timestamps (seconds).
struct NativeLyricWord: Equatable {
    let time: Double
    let end: Double
    let text: String
}

/// One displayed lyric line and optional word-level timings (Whisper).
struct NativeLyricLine: Equatable {
    let time: Double
    let text: String
    let words: [NativeLyricWord]

    init(time: Double, text: String, words: [NativeLyricWord] = []) {
        self.time = time
        self.text = text
        self.words = words
    }
}

/// What LRCLIB matched, so the listener can judge a wrong match.
struct NativeLyricMatched: Equatable {
    let title: String
    let artist: String
    let duration: Double?
}

/// Native representation of song lyrics (LRCLIB, local sidecar .lrc/.txt, or Whisper word timings).
/// Foundation-only (covered by standalone `swiftc` self-checks).
struct NativeLyricsResult: Equatable {
    let status: String // "synced" | "plain" | "none"
    let lines: [NativeLyricLine]
    let plain: String
    let source: String? // "lrclib" | "file" | nil
    let matched: NativeLyricMatched?
    var offsetMs: Double

    var hasWordTimings: Bool { lines.contains { !$0.words.isEmpty } }

    static let none = NativeLyricsResult(status: "none", lines: [], plain: "", source: nil, matched: nil, offsetMs: 0)

    init(status: String, lines: [NativeLyricLine], plain: String, source: String?, matched: NativeLyricMatched? = nil, offsetMs: Double = 0) {
        self.status = status
        self.lines = lines
        self.plain = plain
        self.source = source
        self.matched = matched
        self.offsetMs = offsetMs
    }

    init(dictionary value: [String: Any]) {
        let rawStatus = value["status"] as? String ?? "none"
        status = ["synced", "plain", "none"].contains(rawStatus) ? rawStatus : "none"
        plain = value["plain"] as? String ?? ""
        source = value["source"] as? String
        if let m = value["matched"] as? [String: Any],
           let title = m["title"] as? String,
           let artist = m["artist"] as? String {
            matched = NativeLyricMatched(title: title, artist: artist, duration: (m["duration"] as? NSNumber)?.doubleValue)
        } else {
            matched = nil
        }
        let rawLines = value["wordLines"] as? [[String: Any]] ?? value["lines"] as? [[String: Any]] ?? []
        lines = rawLines.compactMap { line in
            guard let t = (line["t"] as? NSNumber)?.doubleValue, t.isFinite,
                  let text = line["text"] as? String else { return nil }
            let words: [NativeLyricWord] = (line["words"] as? [[String: Any]] ?? []).compactMap { word in
                guard let wt = (word["t"] as? NSNumber)?.doubleValue, wt.isFinite,
                      let we = (word["end"] as? NSNumber)?.doubleValue, we.isFinite,
                      let wtext = word["text"] as? String else { return nil }
                return NativeLyricWord(time: wt, end: we, text: wtext)
            }
            return NativeLyricLine(time: t, text: text, words: words)
        }
        offsetMs = (value["offsetMs"] as? NSNumber)?.doubleValue ?? 0
    }

    func toDictionary() -> [String: Any] {
        var out: [String: Any] = [
            "status": status,
            "plain": plain,
            "lines": lines.map { line -> [String: Any] in
                var entry: [String: Any] = ["t": line.time, "text": line.text]
                if !line.words.isEmpty {
                    entry["words"] = line.words.map { ["t": $0.time, "end": $0.end, "text": $0.text] as [String: Any] }
                }
                return entry
            },
        ]
        if let source { out["source"] = source }
        if let matched {
            var m: [String: Any] = ["title": matched.title, "artist": matched.artist]
            if let duration = matched.duration { m["duration"] = duration }
            out["matched"] = m
        }
        return out
    }
}

/// Pure parsing, LRC handling, title cleaning and confidence scoring matching `apps/server/src/lyrics.ts`
/// and `apps/server/src/public/match.ts`.
enum NativeLyricsParser {
    private static let alternateTags: Set<String> = [
        "slowed", "sped-up", "reverb", "nightcore", "remix", "mashup",
        "live", "acoustic", "instrumental", "karaoke", "cover",
        "bass-boosted", "8d", "demo", "extended",
    ]

    private static let tagRules: [(String, NSRegularExpression)] = {
        let defs: [(String, String)] = [
            ("slowed", #"\bslowed\b|замедл"#),
            ("sped-up", #"\bsped\s*up\b|\bspeed\s*up\b|ускор"#),
            ("reverb", #"\breverb\b|ревер"#),
            ("nightcore", #"\bnightcore\b"#),
            ("remix", #"\bremix\b|\brmx\b|\bflip\b|\bbootleg\b|ремикс"#),
            ("mashup", #"\bmash\s*-?up\b|мэшап"#),
            ("live", #"\blive\b|концерт|живое исполнение|лайв"#),
            ("acoustic", #"\bacoustic\b|акустик"#),
            ("instrumental", #"\binstrumental\b|\bminus\b|минусовк|инструментал"#),
            ("karaoke", #"\bkaraoke\b|караоке"#),
            ("cover", #"\bcover\b|кавер"#),
            ("remaster", #"\bremaster(ed)?\b|ремастер"#),
            ("extended", #"\bextended\b|\bext\.? mix\b"#),
            ("radio-edit", #"\bradio\s*(edit|version)\b"#),
            ("clean", #"\bclean\b|\bcensored\b|без мата|цензур"#),
            ("uncensored", #"\buncensored\b|\bdirty\b|без цензуры"#),
            ("demo", #"\bdemo\b|демо"#),
            ("bass-boosted", #"bass\s*boost"#),
            ("8d", #"\b8d\b"#),
        ]
        return defs.compactMap { tag, pattern in
            guard let re = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return nil }
            return (tag, re)
        }
    }()

    private static let lrcOffsetRegex = try! NSRegularExpression(pattern: #"\[offset:\s*([+-]?\d+)\s*\]"#, options: .caseInsensitive)
    private static let lrcStampRegex = try! NSRegularExpression(pattern: #"\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]"#)
    private static let lrcTagStripRegex = try! NSRegularExpression(pattern: #"\[[^\]]*\]"#)
    private static let cleanTitleRegex = try! NSRegularExpression(
        pattern: #"[(\[](?:official\s*(?:music\s*)?(?:video|audio|clip|lyric video)|lyrics?|lyric video|hd|hq|4k|audio|video|клип|премьера[^)\]]*)[)\]]"#,
        options: .caseInsensitive
    )
    private static let multiSpaceRegex = try! NSRegularExpression(pattern: #"\s{2,}"#)
    private static let featRegex = try! NSRegularExpression(pattern: #"\b(featuring|feat\.?|ft\.?)\b"#, options: .caseInsensitive)
    private static let nonWordRegex = try! NSRegularExpression(pattern: #"[^\p{L}\p{N}]+"#)
    private static let artistSplitRegex = try! NSRegularExpression(pattern: #",|&| feat\.? | ft\.? "#, options: .caseInsensitive)

    /// Parses LRC: `[mm:ss.xx]` lines, several stamps per line, `[offset:+/-ms]`.
    static func parseLrc(_ text: String) -> [NativeLyricLine] {
        let full = NSRange(text.startIndex..., in: text)
        var offsetSeconds = 0.0
        if let match = lrcOffsetRegex.firstMatch(in: text, range: full),
           let range = Range(match.range(at: 1), in: text),
           let ms = Double(text[range]) {
            offsetSeconds = ms / 1000.0
        }

        var entries: [(index: Int, time: Double, text: String)] = []
        var counter = 0
        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
            let nsRange = NSRange(line.startIndex..., in: line)
            let matches = lrcStampRegex.matches(in: line, range: nsRange)
            guard !matches.isEmpty else { continue }
            let words = lrcTagStripRegex.stringByReplacingMatches(in: line, range: nsRange, withTemplate: "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            for m in matches {
                guard let mr = Range(m.range(at: 1), in: line),
                      let sr = Range(m.range(at: 2), in: line),
                      let mins = Double(line[mr]),
                      let secs = Double(line[sr].replacingOccurrences(of: ":", with: ".")) else { continue }
                let t = max(0, mins * 60.0 + secs - offsetSeconds)
                entries.append((counter, t, words))
                counter += 1
            }
        }
        return entries
            .sorted { $0.time == $1.time ? $0.index < $1.index : $0.time < $1.time }
            .map { NativeLyricLine(time: $0.time, text: $0.text) }
    }

    /// Removes upload decorations ("Official Video", "Lyrics", "HD") while preserving version words.
    static func cleanTitle(_ title: String) -> String {
        let r1 = NSRange(title.startIndex..., in: title)
        let stripped = cleanTitleRegex.stringByReplacingMatches(in: title, range: r1, withTemplate: "")
        let r2 = NSRange(stripped.startIndex..., in: stripped)
        return multiSpaceRegex.stringByReplacingMatches(in: stripped, range: r2, withTemplate: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func primaryArtist(_ artist: String) -> String {
        let range = NSRange(artist.startIndex..., in: artist)
        let marked = artistSplitRegex.stringByReplacingMatches(in: artist, range: range, withTemplate: "\n")
        return marked.components(separatedBy: "\n").first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    static func normalizeMatchText(_ text: String) -> String {
        let nfkc = (text as NSString).precomposedStringWithCompatibilityMapping
            .lowercased()
            .replacingOccurrences(of: "ё", with: "е")
        let r1 = NSRange(nfkc.startIndex..., in: nfkc)
        let withFeat = featRegex.stringByReplacingMatches(in: nfkc, range: r1, withTemplate: " feat ")
        let r2 = NSRange(withFeat.startIndex..., in: withFeat)
        return nonWordRegex.stringByReplacingMatches(in: withFeat, range: r2, withTemplate: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func versionLabels(_ title: String) -> Set<String> {
        let range = NSRange(title.startIndex..., in: title)
        var labels = Set<String>()
        for (tag, regex) in tagRules where regex.firstMatch(in: title, range: range) != nil {
            labels.insert(tag)
        }
        return labels
    }

    private static func tokens(_ text: String) -> [String] {
        normalizeMatchText(text)
            .split(whereSeparator: \.isWhitespace)
            .map(String.init)
            .filter { !$0.isEmpty && $0 != "feat" }
    }

    static func matchConfidence(targetTitle: String, targetArtist: String, targetDuration: Double,
                                candTitle: String, candArtist: String, candDuration: Double?) -> Double {
        let tt = tokens(targetTitle)
        let ct = Set(tokens(candTitle))
        let ta = tokens(targetArtist)
        let ca = Set(tokens(candArtist)).union(ct)
        let titleCover = tt.isEmpty ? 0.0 : Double(tt.filter { ct.contains($0) }.count) / Double(tt.count)
        let artistCover = ta.isEmpty ? 0.5 : Double(ta.filter { ca.contains($0) }.count) / Double(ta.count)
        var score = titleCover * 0.55 + artistCover * 0.30
        if targetDuration > 0, let cd = candDuration, cd > 0 {
            let diff = abs(targetDuration - cd)
            if diff <= 3 { score += 0.15 }
            else if diff <= 8 { score += 0.08 }
            else if diff > 30 { score -= 0.25 }
        } else {
            score += 0.05
        }
        let wanted = versionLabels(targetTitle)
        for tag in versionLabels(candTitle) where alternateTags.contains(tag) && !wanted.contains(tag) {
            score -= 0.30
        }
        return max(0.0, min(1.0, score))
    }

    /// Reads real local Whisper timestamps (`whisper-words-1`); never estimates word timings from line duration.
    static func parseWhisperLyrics(_ raw: [String: Any], duration: Double) -> [NativeLyricLine]? {
        guard raw["version"] as? String == "whisper-words-1",
              let wordsRaw = raw["words"] as? [[String: Any]],
              let linesRaw = raw["lines"] as? [[String: Any]],
              !wordsRaw.isEmpty else { return nil }
        struct W { let start, end: Double; let word: String }
        var words: [W] = []
        var prevStart = -Double.infinity
        for item in wordsRaw {
            guard let start = (item["start"] as? NSNumber)?.doubleValue,
                  let end = (item["end"] as? NSNumber)?.doubleValue,
                  let word = item["word"] as? String,
                  start.isFinite, end.isFinite, start >= 0, end > start, end <= duration + 1,
                  !word.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  start >= prevStart else { return nil }
            prevStart = start
            words.append(W(start: start, end: end, word: word))
        }
        var out: [NativeLyricLine] = []
        for seg in linesRaw {
            guard let start = (seg["start"] as? NSNumber)?.doubleValue,
                  let end = (seg["end"] as? NSNumber)?.doubleValue,
                  let text = seg["text"] as? String,
                  start.isFinite, end.isFinite, start >= 0, end > start, end <= duration + 1 else { return nil }
            let lineWords = words
                .filter { $0.start >= start - 0.01 && $0.end <= end + 0.01 }
                .map { NativeLyricWord(time: $0.start, end: $0.end, text: $0.word) }
            if !lineWords.isEmpty {
                out.append(NativeLyricLine(time: start, text: text, words: lineWords))
            }
        }
        return out
    }

    /// Reads a `.lrc`, `.LRC` or `.txt` file next to a local audio file (max 1 MiB).
    static func sidecarLyrics(audioFile: URL) -> NativeLyricsResult? {
        let base = audioFile.deletingPathExtension().path
        let fm = FileManager.default
        for ext in [".lrc", ".LRC", ".txt"] {
            let path = base + ext
            guard let attrs = try? fm.attributesOfItem(atPath: path),
                  let size = (attrs[.size] as? NSNumber)?.intValue,
                  size <= (1 << 20),
                  let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                  let text = String(data: data, encoding: .utf8) else { continue }
            let lines = ext.lowercased() == ".lrc" ? parseLrc(text) : []
            let plain = lines.isEmpty ? text : lines.map(\.text).joined(separator: "\n")
            return NativeLyricsResult(
                status: lines.isEmpty ? "plain" : "synced",
                lines: lines,
                plain: plain,
                source: "file"
            )
        }
        return nil
    }
}

private final class NativeLyricsRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Native LRCLIB + local cache + sidecar lyrics service (no WebView / JSC dependency).
final class NativeLyricsService {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    typealias Fetch = (_ request: URLRequest) async throws -> (Int, Data)

    static let shared = NativeLyricsService()
    private static let userAgent = "MORA/0.1 (iOS native music player)"
    private static let noneTTL: TimeInterval = 24 * 3600
    private static let maxResponseBytes = 2 << 20
    private static let totalDeadlineSeconds: TimeInterval = 12

    private final class InFlightJob {
        let task: Task<NativeLyricsResult, Error>
        var waiters = 0
        init(_ task: Task<NativeLyricsResult, Error>) { self.task = task }
    }

    private let fetch: Fetch
    private let defaults: UserDefaults
    private let lock = NSLock()
    private var fixtures: [String: NativeLyricsResult] = [:]
    private var inFlight: [String: InFlightJob] = [:]

    init(fetch: @escaping Fetch = NativeLyricsService.urlSessionFetch, defaults: UserDefaults = .standard) {
        self.fetch = fetch
        self.defaults = defaults
    }

    private func locked<T>(_ work: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return work()
    }

    func installFixture(_ trackId: String, _ result: NativeLyricsResult) {
        locked { fixtures[trackId] = result }
    }

    func removeFixtures() {
        locked { fixtures.removeAll() }
    }

    func fixture(for trackId: String) -> NativeLyricsResult? {
        locked { fixtures[trackId] }
    }

    static func cacheKey(for id: String) -> String {
        let replaced = id.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "_" }
        let s = String(replaced)
        return s.isEmpty ? "_" : String(s.prefix(128))
    }

    func savedOffsetMs(for trackId: String) -> Double {
        let key = "mora.lyricsOffset." + Self.cacheKey(for: trackId)
        return min(30_000, max(-30_000, defaults.double(forKey: key)))
    }

    func saveOffsetMs(_ ms: Double, for trackId: String) {
        let key = "mora.lyricsOffset." + Self.cacheKey(for: trackId)
        let clamped = min(30_000, max(-30_000, ms.rounded()))
        defaults.set(clamped, forKey: key)
    }

    /// Loads cached/sidecar/LRCLIB lyrics, deduplicating simultaneous requests for the same recording.
    func load(trackId: String, title: String, artist: String, album: String = "", duration: Double,
              refresh: Bool = false, audioFile: URL? = nil, cacheDir: URL? = nil) async throws -> NativeLyricsResult {
        if let hit = fixture(for: trackId) {
            var copy = hit
            copy.offsetMs = savedOffsetMs(for: trackId)
            return copy
        }
        guard !trackId.isEmpty else { throw Failure(message: "Трек недоступен") }

        let key = Self.cacheKey(for: trackId)
        let offset = savedOffsetMs(for: trackId)
        let cacheFile = cacheDir?.appendingPathComponent("\(key).json")

        if !refresh, let cacheFile, let cached = readCached(file: cacheFile) {
            var result = cached
            result.offsetMs = offset
            return result
        }

        let jobKey = "\(key)|\(refresh ? "1" : "0")"
        let job = locked { () -> InFlightJob in
            if let existing = inFlight[jobKey] {
                existing.waiters += 1
                return existing
            }
            let created = Task { () -> NativeLyricsResult in
                let found: NativeLyricsResult
                if let audioFile, let sidecar = NativeLyricsParser.sidecarLyrics(audioFile: audioFile) {
                    found = sidecar
                } else {
                    found = try await self.findLyrics(title: title, artist: artist, album: album, duration: duration)
                }
                if let cacheFile {
                    self.writeCache(found, to: cacheFile)
                }
                return found
            }
            let entry = InFlightJob(created)
            entry.waiters = 1
            inFlight[jobKey] = entry
            return entry
        }
        defer {
            locked {
                if inFlight[jobKey] === job {
                    job.waiters = max(0, job.waiters - 1)
                    if job.waiters == 0 { inFlight.removeValue(forKey: jobKey) }
                }
            }
        }
        var result = try await withTaskCancellationHandler {
            try await job.task.value
        } onCancel: {
            let cancelTask = self.locked { () -> Task<NativeLyricsResult, Error>? in
                guard self.inFlight[jobKey] === job else { return nil }
                job.waiters = max(0, job.waiters - 1)
                if job.waiters == 0 {
                    self.inFlight.removeValue(forKey: jobKey)
                    return job.task
                }
                return nil
            }
            cancelTask?.cancel()
        }
        result.offsetMs = offset
        return result
    }

    /// Exact lookup by artist, title and duration first; falls back to scored search within 4 seconds.
    func findLyrics(title: String, artist: String, album: String = "", duration: Double) async throws -> NativeLyricsResult {
        let deadline = Date().addingTimeInterval(Self.totalDeadlineSeconds)
        let clean = NativeLyricsParser.cleanTitle(title)
        let primary = NativeLyricsParser.primaryArtist(artist)
        guard !clean.isEmpty, !primary.isEmpty else { return .none }

        var exactParams: [(String, String)] = [
            ("track_name", clean),
            ("artist_name", primary),
        ]
        if !album.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            exactParams.append(("album_name", album))
        }
        if duration.isFinite, duration > 0 {
            exactParams.append(("duration", String(Int(duration.rounded()))))
        }

        var lookupError: Error?
        var exactRow: [String: Any]?
        do {
            exactRow = try await lrclib("/api/get", params: exactParams, deadline: deadline) as? [String: Any]
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            lookupError = error
        }

        if let exactRow, hasText(exactRow) {
            return fromRow(exactRow)
        }

        let found = try await lrclib("/api/search", params: [("track_name", clean), ("artist_name", primary)], deadline: deadline) as? [[String: Any]] ?? []
        let best = found
            .filter { row in
                guard hasText(row) else { return false }
                guard duration > 0, let candDur = (row["duration"] as? NSNumber)?.doubleValue, candDur > 0 else { return true }
                return abs(candDur - duration) <= 4
            }
            .map { row -> (row: [String: Any], score: Double) in
                let rTitle = row["trackName"] as? String ?? ""
                let rArtist = row["artistName"] as? String ?? ""
                let rDur = (row["duration"] as? NSNumber)?.doubleValue
                let hasSynced = !(row["syncedLyrics"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                let score = NativeLyricsParser.matchConfidence(
                    targetTitle: clean, targetArtist: primary, targetDuration: duration,
                    candTitle: rTitle, candArtist: rArtist, candDuration: rDur
                ) + (hasSynced ? 0.05 : 0.0)
                return (row, score)
            }
            .sorted { $0.score > $1.score }
            .first

        if let best, best.score >= 0.7 {
            return fromRow(best.row)
        }
        if let lookupError {
            throw lookupError
        }
        return .none
    }

    private func hasText(_ row: [String: Any]) -> Bool {
        let synced = (row["syncedLyrics"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let plain = (row["plainLyrics"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return !synced.isEmpty || !plain.isEmpty
    }

    private func fromRow(_ row: [String: Any]) -> NativeLyricsResult {
        let synced = row["syncedLyrics"] as? String
        let lines = synced.map(NativeLyricsParser.parseLrc) ?? []
        let plain = row["plainLyrics"] as? String ?? lines.map(\.text).joined(separator: "\n")
        let status = !lines.isEmpty ? "synced" : (!plain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "plain" : "none")
        let matched = NativeLyricMatched(
            title: row["trackName"] as? String ?? "",
            artist: row["artistName"] as? String ?? "",
            duration: (row["duration"] as? NSNumber)?.doubleValue
        )
        return NativeLyricsResult(status: status, lines: lines, plain: plain, source: "lrclib", matched: matched)
    }

    private func lrclib(_ pathname: String, params: [(String, String)], deadline: Date) async throws -> Any? {
        var components = URLComponents(string: "https://lrclib.net" + pathname)!
        components.queryItems = params.filter { !$0.1.isEmpty }.map { URLQueryItem(name: $0.0, value: $0.1) }
        guard let url = components.url, url.scheme == "https", url.host == "lrclib.net" else {
            throw Failure(message: "Некорректный адрес сервиса текстов")
        }

        var attempt = 0
        while true {
            try Task.checkCancellation()
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0.05 else {
                throw Failure(message: "Сервис текстов не ответил. Попробуйте чуть позже.")
            }
            var request = URLRequest(url: url, timeoutInterval: min(8.0, remaining))
            request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            do {
                let (status, data) = try await fetch(request)
                if attempt == 0 && (status == 408 || status >= 500) {
                    attempt += 1
                    try await Task.sleep(for: .milliseconds(350))
                    continue
                }
                if status == 404 { return nil }
                guard (200..<300).contains(status) else {
                    throw Failure(message: "Сервис текстов ответил \(status)")
                }
                guard data.count <= Self.maxResponseBytes else {
                    throw Failure(message: "Слишком большой ответ сервиса текстов")
                }
                return try JSONSerialization.jsonObject(with: data)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                try Task.checkCancellation()
                if attempt > 0 || !shouldRetry(error) {
                    throw error
                }
                attempt += 1
                try await Task.sleep(for: .milliseconds(350))
            }
        }
    }

    private func shouldRetry(_ error: Error) -> Bool {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            return [
                NSURLErrorTimedOut,
                NSURLErrorCannotConnectToHost,
                NSURLErrorNetworkConnectionLost,
                NSURLErrorNotConnectedToInternet,
                NSURLErrorDNSLookupFailed,
                NSURLErrorCannotFindHost,
            ].contains(ns.code)
        }
        return false
    }

    private func readCached(file: URL) -> NativeLyricsResult? {
        guard let data = try? Data(contentsOf: file),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let atMs = (raw["at"] as? NSNumber)?.doubleValue,
              let lyricsDict = raw["lyrics"] as? [String: Any] else { return nil }
        let parsed = NativeLyricsResult(dictionary: lyricsDict)
        let ageSeconds = Date().timeIntervalSince1970 - (atMs / 1000.0)
        if parsed.status == "none" && ageSeconds >= Self.noneTTL {
            return nil
        }
        return parsed
    }

    private func writeCache(_ result: NativeLyricsResult, to file: URL) {
        let fm = FileManager.default
        let dir = file.deletingLastPathComponent()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let payload: [String: Any] = [
            "at": Date().timeIntervalSince1970 * 1000.0,
            "lyrics": result.toDictionary(),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        let tmp = dir.appendingPathComponent(".\(file.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            try data.write(to: tmp, options: .atomic)
            _ = try? fm.replaceItemAt(file, withItemAt: tmp)
            if !fm.fileExists(atPath: file.path), fm.fileExists(atPath: tmp.path) {
                try? fm.moveItem(at: tmp, to: file)
            }
        } catch {
            try? fm.removeItem(at: tmp)
        }
    }

    private static func urlSessionFetch(_ request: URLRequest) async throws -> (Int, Data) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 2
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        let blocker = NativeLyricsRedirectBlocker()
        let session = URLSession(configuration: configuration, delegate: blocker, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}
