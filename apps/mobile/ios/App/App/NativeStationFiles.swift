import Foundation
import CryptoKit

enum NativeStationFiles {
    private static let lock = NSRecursiveLock()
    private static let playbackIO = DispatchQueue(label: "ru.mora.station-position")
    private static var lastPositionWrite = 0.0 // playbackIO only
    static var root: URL? {
        // Sideload signing can drop the App Group; Siri and CarPlay run in the app and restore from its own container.
        (FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.ru.mora.player")
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)?
            .appendingPathComponent("station", isDirectory: true)
    }
    static func name(_ trackId: String) -> String {
        SHA256.hash(data: Data(trackId.utf8)).map { String(format: "%02x", $0) }.joined() + ".media"
    }
    static func load() throws -> NativeStationSnapshot {
        lock.lock(); defer { lock.unlock() }
        guard let root else { throw NativeStationSnapshot.Failure.noLocalFiles }
        return try NativeStationSnapshot.decode(Data(contentsOf: root.appendingPathComponent("station.json")))
    }
    /// A hard link leases an already uploaded local source without duplicating audio bytes.
    static func retainLocal(_ item: [String: Any], folder: URL) {
        lock.lock(); defer { lock.unlock() }
        guard let root, let source = item["source"] as? [String: Any], source["kind"] as? String == "local",
              let key = source["file"] as? Int, (0..<500000).contains(key),
              let id = item["trackId"] as? String, !id.isEmpty else { return }
        let fm = FileManager.default, destination = root.appendingPathComponent(name(id))
        do {
            try fm.createDirectory(at: root, withIntermediateDirectories: true)
            guard !fm.fileExists(atPath: destination.path) else { return }
            let existing = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey])
                .filter { $0.pathExtension == "media" }
            let size = try existing.reduce(0) { try $0 + ($1.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) }
            let original = folder.appendingPathComponent("source-\(key).media")
            let bytes = try original.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard bytes > 0, size + bytes <= 512 * 1024 * 1024 else { return }
            try fm.linkItem(at: original, to: destination)
        } catch { /* Playback keeps its original source; an unavailable lease cannot promise native restore. */ }
    }
    static func save(_ snapshot: NativeStationSnapshot) throws {
        lock.lock(); defer { lock.unlock() }
        try snapshot.validate()
        guard let root else { throw NativeStationSnapshot.Failure.noLocalFiles }
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("station.json")
        try JSONEncoder().encode(snapshot).write(to: file, options: .atomic)
        #if os(iOS)
        try fm.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
        #endif
        let keep = Set(snapshot.tracks.compactMap(\.localFile))
        for url in try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            where url.pathExtension == "media" && !keep.contains(url.lastPathComponent) {
            try? fm.removeItem(at: url)
        }
    }
    static func updatePosition(trackId: String, position: Double) {
        playbackIO.async {
            let now = ProcessInfo.processInfo.systemUptime
            guard now - lastPositionWrite >= 1.5 else { return }
            lock.lock(); defer { lock.unlock() }
            guard var snapshot = try? load(), let at = snapshot.tracks.firstIndex(where: { $0.trackId == trackId }) else { return }
            snapshot.index = at; snapshot.position = position; snapshot.updatedAt = .now
            do { try save(snapshot); lastPositionWrite = now } catch {}
        }
    }
    static func localURL(_ name: String) throws -> URL {
        guard let root, name == URL(fileURLWithPath: name).lastPathComponent, name.hasSuffix(".media"),
              !name.contains("/"), !name.contains("\\") else { throw NativeStationSnapshot.Failure.noLocalFiles }
        let url = root.appendingPathComponent(name).resolvingSymlinksInPath()
        guard url.deletingLastPathComponent() == root.resolvingSymlinksInPath(), FileManager.default.isReadableFile(atPath: url.path) else { throw NativeStationSnapshot.Failure.noLocalFiles }
        return url
    }
    static func remapTracks(_ mapping: [String: String]) throws {
        lock.lock(); defer { lock.unlock() }
        guard var snapshot = try? load(), let root else { return }
        for i in snapshot.tracks.indices {
            guard let id = mapping[snapshot.tracks[i].trackId] else { continue }
            if let old = snapshot.tracks[i].localFile, let original = try? localURL(old) {
                let destination = root.appendingPathComponent(name(id))
                if !FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.linkItem(at: original, to: destination) }
                snapshot.tracks[i].localFile = destination.lastPathComponent
            }
            snapshot.tracks[i].trackId = id
        }
        try save(snapshot)
    }
}
