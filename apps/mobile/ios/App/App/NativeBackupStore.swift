import Foundation
import CryptoKit

enum NativeBackupStore {
    static let maximumBytes = 16 * 1024 * 1024
    private static let lock = NSLock()
    static var folder: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("backup", isDirectory: true) }

    static func files(in root: URL = folder) throws -> [URL] {
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("auto-") && $0.pathExtension == "json" }.sorted { $0.lastPathComponent > $1.lastPathComponent }
    }
    private static func validated(_ text: String) throws -> (Data, Data) {
        let data = Data(text.utf8)
        guard data.count <= maximumBytes,
              var object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["format"] as? String == "mora-playlists", object["version"] as? Int == 1,
              object["tracks"] is [Any], object["playlists"] is [Any] else { throw CocoaError(.fileReadCorruptFile) }
        func safe(_ value: Any) -> Bool {
            if let map = value as? [String: Any] {
                return map.allSatisfy { key, value in !["token", "secret", "password", "authorization", "audio", "path", "url"].contains(key.lowercased()) && safe(value) }
            }
            if let list = value as? [Any] { return list.allSatisfy(safe) }
            return true
        }
        guard safe(object) else { throw CocoaError(.fileReadCorruptFile) }
        object.removeValue(forKey: "createdAt")
        let content = try JSONSerialization.data(withJSONObject: object, options: .sortedKeys)
        return (data, Data(SHA256.hash(data: content)))
    }
    @discardableResult static func save(_ text: String, folder root: URL = folder) throws -> URL? {
        lock.lock(); defer { lock.unlock() }
        let (data, digest) = try validated(text)
        if let last = try files(in: root).first,
           let text = try? String(contentsOf: last, encoding: .utf8), let previous = try? validated(text), previous.1 == digest { return nil }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let stamp = String(format: "%016lld", Int64(Date().timeIntervalSince1970 * 1000))
        let file = root.appendingPathComponent("auto-\(stamp)-\(UUID().uuidString).json")
        try data.write(to: file, options: .atomic)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
        #endif
        for old in try files(in: root).dropFirst(5) { try FileManager.default.removeItem(at: old) }
        return file
    }
    static func read(_ name: String, in root: URL = folder) throws -> String {
        guard name == URL(fileURLWithPath: name).lastPathComponent, name.hasPrefix("auto-"), name.hasSuffix(".json"),
              !name.contains("/"), !name.contains("\\") else { throw CocoaError(.fileReadInvalidFileName) }
        let file = root.appendingPathComponent(name).resolvingSymlinksInPath()
        guard file.deletingLastPathComponent() == root.resolvingSymlinksInPath() else { throw CocoaError(.fileReadInvalidFileName) }
        let data = try readData(file)
        guard let text = String(data: data, encoding: .utf8) else { throw CocoaError(.fileReadCorruptFile) }
        _ = try validated(text)
        return text
    }
    static func readData(_ file: URL) throws -> Data {
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let size = values.fileSize else { throw CocoaError(.fileReadCorruptFile) }
        let oversized = NSError(domain: "MORABackup", code: 2, userInfo: [NSLocalizedDescriptionKey: "Файл больше 16 МБ"])
        guard size <= maximumBytes else { throw oversized }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        guard data.count <= maximumBytes else { throw oversized }
        return data
    }
    #if MORA_ICLOUD
    static func cloudFolder() throws -> URL {
        guard let root = FileManager.default.url(forUbiquityContainerIdentifier: "iCloud.ru.mora.player") else {
            throw NSError(domain: "MORABackup", code: 1, userInfo: [NSLocalizedDescriptionKey: "Локальная копия сохранена; контейнер iCloud недоступен для этой подписи"])
        }
        return root.appendingPathComponent("Documents/MORA/backup", isDirectory: true)
    }
    #endif
}
