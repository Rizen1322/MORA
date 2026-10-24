import Foundation

struct LocalTrack: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let fileName: String
    let title: String
    let artist: String
    let duration: Double
    let artworkName: String?
    var liked: Bool

    func matches(_ query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || "\(title) \(artist)".localizedStandardContains(query)
    }
}

func playbackTime(_ value: Double) -> String {
    let seconds = value.isFinite ? Int(min(Double(Int.max / 2), max(0, value))) : 0
    return String(format: "%lld:%02lld", Int64(seconds / 60), Int64(seconds % 60))
}
