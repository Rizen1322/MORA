import Foundation

/// What the native full player shows, mapped from NativeMixHost.playerState. Foundation only (swiftc test).
struct NativePlayerRow: Equatable, Identifiable {
    let id: String
    let title: String
    let artist: String
    let automix: Bool
    let cover: URL?
}

struct NativePlayerState: Equatable {
    var active = false, playing = false, blending = false, artworkReady = false
    var title = "", artist = "", entryId = ""
    var position = 0.0, duration = 0.0
    var upcoming: [NativePlayerRow] = []

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
        duration = max(0, value["duration"] as? Double ?? 0)
        position = min(duration, max(0, value["position"] as? Double ?? 0))
        upcoming = Self.queue(current: entryId, prepared: value["upcoming"] as? [[String: Any]] ?? [],
                              manifest: value["manifestItems"] as? [[String: Any]] ?? [])
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
        var covers: [String: URL] = [:]
        for item in manifest {
            if let id = item["entryId"] as? String, let text = item["coverUrl"] as? String,
               let url = URL(string: text), url.scheme == "https" { covers[id] = url }
        }
        var rows: [NativePlayerRow] = [], seen: Set<String> = [current]
        func add(_ item: [String: Any], automix: Bool) {
            guard let id = item["entryId"] as? String, !id.isEmpty, seen.insert(id).inserted else { return }
            rows.append(NativePlayerRow(id: id, title: item["title"] as? String ?? "", artist: item["artist"] as? String ?? "",
                                        automix: automix, cover: covers[id]))
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
