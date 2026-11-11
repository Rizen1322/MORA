import Foundation

struct NativeStationPayload: Decodable {
    let context: String, source: String?
    let index: Int, position: Double
    let settings: NativeStationSnapshot.Settings
    let tracks: [NativeStationSnapshot.Track]
}

struct NativeStationSnapshot: Codable, Equatable {
    struct Track: Codable, Equatable {
        var trackId: String, title: String, artist: String, album: String
        var duration: Double
        var artwork: String?
        var localFile: String?
    }
    struct Settings: Codable, Equatable { var mood: String, diversity: String, mode: String }
    var schemaVersion = 1
    var context: String
    var source: String?
    var index: Int
    var position: Double
    var settings: Settings
    var tracks: [Track]
    var updatedAt = Date()

    enum Failure: LocalizedError {
        case invalid, noLocalFiles
        var errorDescription: String? {
            switch self {
            case .invalid: return "Сохранённая станция повреждена. Откройте MORA, чтобы начать"
            case .noLocalFiles: return "Нет доступных локальных треков. Откройте MORA, чтобы начать"
            }
        }
    }
    static func decode(_ data: Data) throws -> Self {
        guard data.count <= 1024 * 1024 else { throw Failure.invalid }
        let value = try JSONDecoder().decode(Self.self, from: data)
        try value.validate()
        return value
    }
    func validate() throws {
        guard schemaVersion == 1, !tracks.isEmpty, tracks.count <= 50, tracks.indices.contains(index),
              position.isFinite, position >= 0,
              ["wave", "yandex-wave", "online-radio", "library", "liked", "playlist", "album", "artist", "history", "search"].contains(context),
              source == nil || ["own", "online", "yandex"].contains(source!),
              ["calm", "normal", "energetic"].contains(settings.mood),
              ["familiar", "balanced", "discover"].contains(settings.diversity),
              ["normal", "mix"].contains(settings.mode),
              tracks.allSatisfy({ !$0.trackId.isEmpty && $0.trackId.utf8.count <= 512 && $0.duration.isFinite && $0.duration >= 0 }) else { throw Failure.invalid }
    }
    func localTracks(in root: URL) throws -> [Track] {
        try validate()
        func available(_ track: Track) -> Bool {
            guard let name = track.localFile, !name.isEmpty, name == URL(fileURLWithPath: name).lastPathComponent,
                  !name.contains("/"), !name.contains("\\"), name.hasSuffix(".media") else { return false }
            let file = root.appendingPathComponent(name).resolvingSymlinksInPath()
            guard file.deletingLastPathComponent() == root.resolvingSymlinksInPath(),
                  let size = try? file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
                  size.isRegularFile == true, (size.fileSize ?? 0) > 0 else { return false }
            return true
        }
        guard available(tracks[index]) else { throw Failure.noLocalFiles }
        return tracks.dropFirst(index).filter(available)
    }
}
