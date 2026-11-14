import Foundation

enum NativeImportFiles {
    struct Staged { let file: String, name: String }
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
    static let audioExtensions = ["mp3", "m4a", "aac", "wav", "flac", "opus", "ogg", "oga", "aiff", "aif", "wv", "ape", "alac", "wma", "mka", "webm"]
    /// Called before a new server starts, when no request can still be consuming these copies.
    static func cleanStaging(root: URL) throws {
        let folder = root.resolvingSymlinksInPath().appendingPathComponent("data/incoming/native", isDirectory: true)
        guard FileManager.default.fileExists(atPath: folder.path) else { return }
        guard folder.resolvingSymlinksInPath().path == folder.path else { throw Failure(message: "Недопустимая папка импорта") }
        for file in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]) {
            guard UUID(uuidString: file.deletingPathExtension().lastPathComponent) != nil, audioExtensions.contains(file.pathExtension.lowercased()) else { continue }
            let info = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            if info.isRegularFile == true && info.isSymbolicLink != true { try FileManager.default.removeItem(at: file) }
        }
    }
    static func stage(_ source: URL, root: URL) throws -> Staged {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        guard source.isFileURL, audioExtensions.contains(source.pathExtension.lowercased()) else { throw Failure(message: "Формат аудио не поддерживается") }
        let info = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard info.isRegularFile == true, info.isSymbolicLink != true, let size = info.fileSize, size > 0, size <= 2 * 1024 * 1024 * 1024 else {
            throw Failure(message: "Выберите непустой аудиофайл размером до 2 ГБ")
        }
        let folder = root.resolvingSymlinksInPath().appendingPathComponent("data/incoming/native", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard folder.resolvingSymlinksInPath().path == folder.path else { throw Failure(message: "Недопустимая папка импорта") }
        let file = UUID().uuidString + "." + source.pathExtension.lowercased(), destination = folder.appendingPathComponent(file)
        do {
            try FileManager.default.copyItem(at: source, to: destination)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
            #endif
            let name = source.deletingPathExtension().lastPathComponent.replacingOccurrences(of: #"[\x00-\x1f<>:"/\\|?*]"#, with: "_", options: .regularExpression)
            return Staged(file: file, name: String(name.prefix(199 - source.pathExtension.count)) + "." + source.pathExtension.lowercased())
        } catch { try? FileManager.default.removeItem(at: destination); throw error }
    }
    static func playlist(_ source: URL) throws -> [String: Any] {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        guard source.isFileURL else { throw Failure(message: "Выберите файл плейлиста") }
        let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= 4 * 1024 * 1024 else { throw Failure(message: "Файл плейлиста должен быть не больше 4 МБ") }
        let handle = try FileHandle(forReadingFrom: source)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: 4 * 1024 * 1024 + 1) ?? Data()
        guard !data.isEmpty, data.count <= 4 * 1024 * 1024,
              let text = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16) else { throw Failure(message: "Не удалось прочитать текст плейлиста") }
        let body: [String: Any] = ["file": ["name": String(source.lastPathComponent.prefix(200)), "text": text]]
        guard try JSONSerialization.data(withJSONObject: body).count <= 4 * 1024 * 1024 else { throw Failure(message: "Текст плейлиста превышает лимит импорта 4 МБ") }
        return body
    }
}
