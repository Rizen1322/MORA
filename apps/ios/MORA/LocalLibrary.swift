import Foundation
import AVFoundation
import Combine

@MainActor
final class LocalLibrary: ObservableObject {
    @Published private(set) var tracks: [LocalTrack] = []
    @Published private(set) var importing = false
    @Published var error: String?
    let directory: URL
    private var storageAvailable = true
    private struct Archive: Codable { let version: Int; let tracks: [LocalTrack] }

    init() {
        directory = URL.applicationSupportDirectory.appendingPathComponent("MORA", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent("library.json")
            if FileManager.default.fileExists(atPath: file.path) {
                let archive = try JSONDecoder().decode(Archive.self, from: Data(contentsOf: file))
                guard archive.version == 1, archive.tracks.allSatisfy({
                    $0.fileName.hasPrefix($0.id.uuidString + ".") && $0.fileName == URL(fileURLWithPath: $0.fileName).lastPathComponent && $0.duration.isFinite && $0.duration > 0 &&
                    ($0.artworkName == nil || $0.artworkName == "\($0.id.uuidString)-cover.img")
                }) else { throw CocoaError(.fileReadCorruptFile) }
                tracks = archive.tracks
            }
        } catch {
            storageAvailable = false
            self.error = "Не удалось открыть медиатеку. Существующие файлы сохранены. \(error.localizedDescription)"
        }
    }

    func url(for track: LocalTrack) -> URL { directory.appendingPathComponent(track.fileName) }
    func artworkURL(for track: LocalTrack) -> URL? { track.artworkName.map { directory.appendingPathComponent($0) } }

    func toggleLike(_ track: LocalTrack) {
        guard let index = tracks.firstIndex(where: { $0.id == track.id }), storageAvailable else { return }
        tracks[index].liked.toggle()
        do { try save() } catch { tracks[index].liked.toggle(); self.error = error.localizedDescription }
    }

    func importFiles(_ urls: [URL]) async {
        guard !importing, storageAvailable else { return }
        importing = true
        defer { importing = false }
        var failures: [String] = []
        for url in urls {
            do {
                let track = try await Self.copyAudio(from: url, into: directory)
                tracks.insert(track, at: 0)
                do { try save() }
                catch {
                    tracks.removeAll { $0.id == track.id }
                    try? FileManager.default.removeItem(at: self.url(for: track))
                    if let artwork = artworkURL(for: track) { try? FileManager.default.removeItem(at: artwork) }
                    throw error
                }
            } catch { failures.append("\(url.lastPathComponent): \(error.localizedDescription)") }
        }
        if !failures.isEmpty { error = failures.joined(separator: "\n") }
    }

    private func save() throws {
        let data = try JSONEncoder().encode(Archive(version: 1, tracks: tracks))
        try data.write(to: directory.appendingPathComponent("library.json"), options: .atomic)
    }

    nonisolated private static func copyAudio(from url: URL, into directory: URL) async throws -> LocalTrack {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let id = UUID()
        let ext = url.pathExtension.lowercased().filter { $0.isLetter || $0.isNumber }.prefix(10)
        let name = "\(id.uuidString).\(ext.isEmpty ? "audio" : String(ext))"
        let staging = directory.appendingPathComponent("incoming-\(name)")
        let destination = directory.appendingPathComponent(name)
        defer { try? FileManager.default.removeItem(at: staging) }
        try FileManager.default.copyItem(at: url, to: staging)
        let audio = try AVAudioFile(forReading: staging)
        let duration = Double(audio.length) / audio.processingFormat.sampleRate
        guard duration.isFinite, duration > 0 else { throw CocoaError(.fileReadCorruptFile) }
        var title = url.deletingPathExtension().lastPathComponent
        var artist = "Неизвестный исполнитель"
        var artwork: Data?
        let asset = AVURLAsset(url: staging)
        if let metadata = try? await asset.load(.commonMetadata) {
            for item in metadata {
                if item.commonKey == .commonKeyTitle, let value = try? await item.load(.stringValue), !value.isEmpty { title = value }
                if item.commonKey == .commonKeyArtist, let value = try? await item.load(.stringValue), !value.isEmpty { artist = value }
                if item.commonKey == .commonKeyArtwork, let value = try? await item.load(.dataValue), value.count <= 3 * 1024 * 1024 { artwork = value }
            }
        }
        let artworkName = artwork == nil ? nil : "\(id.uuidString)-cover.img"
        do {
            if let data = artwork, let name = artworkName { try data.write(to: directory.appendingPathComponent(name), options: .atomic) }
            try FileManager.default.moveItem(at: staging, to: destination)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
        } catch {
            try? FileManager.default.removeItem(at: destination)
            if let name = artworkName { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
            throw error
        }
        return LocalTrack(id: id, fileName: name, title: title, artist: artist, duration: duration, artworkName: artworkName, liked: false)
    }
}
