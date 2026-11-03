import Foundation

/// What the native full player shows, mapped from NativeMixHost.playerState. Foundation only (swiftc test).
struct NativePlayerRow: Equatable, Identifiable {
    let id: String
    let title: String
    let artist: String
    let automix: Bool
    /// HTTPS, or a library cover (/api/...) that the page serves.
    let cover: String?
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
        trackId = current["trackId"] as? String ?? ""
        entryId = value["entryId"] as? String ?? current["entryId"] as? String ?? ""
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

    var automix: Bool { blending || upcoming.first?.automix == true }
    /// The «Далее» pill; nil hides it.
    var nextLabel: String? {
        if blending { return "Уже входит в микс" }
        guard let next = upcoming.first else { return nil }
        return next.automix ? "AutoMix · далее «\(next.title)»" : "Далее: \(next.title)"
    }

    /// Prepared tracks after the audible one, then the manifest items not prepared yet.
    static func queue(current: String, prepared: [[String: Any]], manifest: [[String: Any]]) -> [NativePlayerRow] {
        var covers: [String: String] = [:]
        for item in manifest {
            if let id = item["entryId"] as? String, let text = item["coverUrl"] as? String,
               text.hasPrefix("https://") || text.hasPrefix("/api/") { covers[id] = text }
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

/// A queue edit made in the sheet, shown until the host reports it: the page re-prepares the
/// changed tracks first, and the List would otherwise snap back to the old order meanwhile.
struct NativeQueueEdit {
    var order: [String], removed: Set<String> = []
    var at = Date()

    func apply(_ rows: [NativePlayerRow]) -> [NativePlayerRow] {
        let byId = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }), known = Set(order)
        return order.compactMap { byId[$0] } + rows.filter { !known.contains($0.id) && !removed.contains($0.id) }
    }
    /// The host's own rows show the edit (a Wave refill may have appended more after it).
    func landed(_ rows: [NativePlayerRow]) -> Bool {
        rows.map(\.id).starts(with: order) && !rows.contains { removed.contains($0.id) }
    }
}

enum NativePlayerTime {
    static func text(_ seconds: Double) -> String {
        let s = seconds.isFinite ? Int(min(max(0, seconds), 360_000)) : 0
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
}
