import Foundation

struct PlaybackBookmark: Codable, Equatable {
    var version = 1
    let queue: [UUID]
    let index: Int
    let position: Double

    func validate() throws {
        guard version == 1, !queue.isEmpty, queue.count <= 10_000,
              queue.indices.contains(index), position.isFinite, position >= 0, position <= 86400 else {
            throw CocoaError(.fileReadCorruptFile)
        }
    }
}

struct PlaybackBookmarkStore {
    private let directory: URL
    private var file: URL { directory.appendingPathComponent("playback.json") }
    init(directory: URL) { self.directory = directory }

    func load() throws -> PlaybackBookmark? {
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        let bookmark = try JSONDecoder().decode(PlaybackBookmark.self, from: Data(contentsOf: file))
        try bookmark.validate()
        return bookmark
    }

    func save(_ bookmark: PlaybackBookmark) throws {
        try bookmark.validate()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(bookmark)
        try data.write(to: file, options: .atomic)
    }
}
