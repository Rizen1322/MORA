import Foundation

/// What the native full player shows, mapped from NativeMixHost.playerState. Foundation only (swiftc test).
struct NativePlayerRow: Equatable, Identifiable {
    let id: String
    let trackId: String
    let title: String
    let artist: String
    let automix: Bool
    var mixLabel: String? = nil
    /// HTTPS, or a library cover (/api/...) that the page serves.
    let cover: String?
    /// Embedded cover from the native queue manifest (local files).
    let artwork: String?
}

struct NativePlayerState: Equatable {
    var active = false, playing = false, blending = false, artworkReady = false
    var title = "", artist = "", entryId = "", trackId = ""
    var position = 0.0, duration = 0.0
    var upcoming: [NativePlayerRow] = []
    /// Where the AutoMix transition into the next track starts and how long it lasts (seconds), if planned.
    var mixStart: Double?, mixLength = 0.0

    init() {}
    init(_ value: [String: Any]) {
        let current = value["currentTrack"] as? [String: Any] ?? [:]
        active = value["active"] as? Bool == true
        playing = value["playing"] as? Bool == true
        blending = value["blend"] is [String: Any]
        artworkReady = value["artworkReady"] as? Bool == true
        title = current["title"] as? String ?? ""
        artist = current["artist"] as? String ?? ""
        entryId = value["entryId"] as? String ?? current["entryId"] as? String ?? ""
        trackId = current["trackId"] as? String ?? ""
        duration = max(0, value["duration"] as? Double ?? 0)
        position = min(duration, max(0, value["position"] as? Double ?? 0))
        let prepared = value["upcoming"] as? [[String: Any]] ?? []
        if let start = (value["transitionStart"] as? NSNumber)?.doubleValue, start.isFinite, start >= 0, start < duration {
            mixStart = start
            // The native mixer runs at 48 kHz (NativeMixHost refuses other rates).
            let frames = ((prepared.first?["transition"] as? [String: Any])?["durationFrames"] as? NSNumber)?.doubleValue ?? 0
            mixLength = min(duration - start, max(0, frames.isFinite ? frames / 48000 : 0))
        }
        upcoming = Self.queue(current: entryId, prepared: prepared,
                              manifest: value["manifestItems"] as? [[String: Any]] ?? [])
    }

    static func mixLabel(_ item: [String: Any]) -> String {
        let plan = item["plan"] as? [String: Any] ?? [:]
        let transition = item["transition"] as? [String: Any] ?? [:]
        let method = plan["method"] as? String ?? transition["method"] as? String ?? ""
        let names = ["fallback_crossfade": "Резервный кроссфейд", "beatmatch_blend": "Битматч", "tempo_bridge": "Смена темпа", "drop_mix": "Дроп", "phrase_cut": "Срез по фразе", "crossfade": "Кроссфейд", "echo_out": "Эхо", "gapless": "Без паузы", "skip_fade": "Быстрый переход"]
        return "AutoMix · " + (names[method] ?? (method.isEmpty ? "Плавный переход" : method.replacingOccurrences(of: "_", with: " ").capitalized))
    }

    var automix: Bool { blending || upcoming.first?.automix == true }
    /// The «Далее» pill; nil hides it.
    var nextLabel: String? {
        if blending { return "Уже входит в микс" }
        guard let next = upcoming.first else { return nil }
        return next.automix ? "AutoMix · далее «\(next.title)»" : "Далее: \(next.title)"
    }

    /// Prepared tracks after the audible one, then the manifest items not prepared yet.
    static func queue(current: String, prepared: [[String: Any]], manifest: [[String: Any]]) -> [NativePlayerRow] {
        var covers: [String: String] = [:], artworks: [String: String] = [:]
        for item in manifest {
            guard let id = item["entryId"] as? String else { continue }
            if let text = item["coverUrl"] as? String, text.hasPrefix("https://") || text.hasPrefix("/api/") { covers[id] = text }
            if let embedded = item["artwork"] as? [String: Any], let base64 = embedded["base64"] as? String { artworks[id] = base64 }
        }
        var rows: [NativePlayerRow] = [], seen: Set<String> = [current]
        func add(_ item: [String: Any], automix: Bool) {
            guard let id = item["entryId"] as? String, !id.isEmpty, seen.insert(id).inserted else { return }
            rows.append(NativePlayerRow(id: id, trackId: item["trackId"] as? String ?? "", title: item["title"] as? String ?? "", artist: item["artist"] as? String ?? "",
                                        automix: automix, mixLabel: automix ? Self.mixLabel(item) : nil, cover: covers[id], artwork: artworks[id]))
        }
        for track in prepared { add(track, automix: track["transition"] != nil) }
        // The manifest can still list tracks that were played since it was sent.
        let tail = manifest.lastIndex { seen.contains($0["entryId"] as? String ?? "") }.map { $0 + 1 } ?? 0
        for item in manifest[tail...] { add(item, automix: false) }
        return rows
    }
}

enum NativePlayerTime {
    static func text(_ seconds: Double) -> String {
        let s = seconds.isFinite ? Int(min(max(0, seconds), 360_000)) : 0
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// Foundation-only sleep decisions; gain is separate from the user's saved volume.
struct NativeSleepStep {
    let remaining: Int
    let entryId: String
    let gain: Double
    let finished: Bool
    static func fade(seconds: Double) -> Double { seconds.isFinite ? min(1, max(0, seconds / 5)) : 1 }
    static func evaluate(remaining: Int, entryId: String, state: NativePlayerState) -> Self {
        let left = remaining - (state.entryId != entryId ? 1 : 0)
        let finished = !state.active || left <= 0 || (left == 1 && state.blending)
        let end = state.mixStart ?? state.duration
        let gain = finished ? 0 : left == 1 && state.playing && end > 0 ? fade(seconds: end - state.position) : 1
        return Self(remaining: max(0, left), entryId: state.entryId, gain: gain, finished: finished)
    }
}
