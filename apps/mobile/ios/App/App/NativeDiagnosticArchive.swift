import Foundation

enum NativeDiagnosticArchive {
    static func make(report: [String: Any], metrics: URL?) throws -> URL {
        let fm = FileManager.default, id = UUID().uuidString
        let folder = fm.temporaryDirectory.appendingPathComponent("MORA-diagnostics-\(id)", isDirectory: true)
        let archive = fm.temporaryDirectory.appendingPathComponent("MORA-diagnostics-\(id).zip")
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: folder) }
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent("playback.json"), options: .atomic)
        if let metrics, fm.fileExists(atPath: metrics.path) {
            let destination = folder.appendingPathComponent("metrics", isDirectory: true)
            try fm.createDirectory(at: destination, withIntermediateDirectories: true)
            let files = try fm.contentsOfDirectory(at: metrics, includingPropertiesForKeys: [.fileSizeKey]).filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent > $1.lastPathComponent }.prefix(20)
            for file in files {
                let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 4 * 1024 * 1024 else { continue }
                try fm.copyItem(at: file, to: destination.appendingPathComponent(file.lastPathComponent))
            }
        }
        var coordinatorError: NSError?, copyError: Error?
        NSFileCoordinator().coordinate(readingItemAt: folder, options: .forUploading, error: &coordinatorError) { zip in
            do { try fm.copyItem(at: zip, to: archive) } catch { copyError = error }
        }
        if let coordinatorError { throw coordinatorError }
        if let copyError { throw copyError }
        let file = try FileHandle(forReadingFrom: archive); defer { try? file.close() }
        guard try file.read(upToCount: 4) == Data([0x50, 0x4b, 0x03, 0x04]) else { throw CocoaError(.fileReadCorruptFile) }
        return archive
    }
}
