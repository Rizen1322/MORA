import Foundation

enum NativeBackupFiles {
    static let maximumBytes = NativeBackupStore.maximumBytes
    struct Share {
        let folder: URL, url: URL
    }
    struct Entry: Identifiable {
        let name: String, root: URL, cloud: Bool
        var id: String { (cloud ? "cloud:" : "local:") + name }
    }
    struct Selection: Identifiable {
        let id = UUID()
        let backup: NativeSettingsBackup
        let cloud: Bool
        var hasLibrary: Bool { backup.raw["library"] is [String: Any] }
    }
    struct Listing {
        var entries: [Entry] = []
        var warnings: [String] = []
    }
    static func listing(local: URL, cloud: Result<URL, Error>? = nil) -> Listing {
        var result = Listing()
        do { result.entries += try entries(in: local, cloud: false) }
        catch { result.warnings.append("Локальные копии недоступны: \(error.localizedDescription)") }
        if let cloud {
            do { result.entries += try entries(in: cloud.get(), cloud: true) }
            catch { result.warnings.append("Копии iCloud недоступны: \(error.localizedDescription). Проверьте iCloud Drive и подключение, затем обновите список.") }
        }
        return result
    }
    static func entries(in root: URL, cloud: Bool) throws -> [Entry] {
        try NativeBackupStore.files(in: root).map { Entry(name: $0.lastPathComponent, root: root, cloud: cloud) }
    }
    static func inspect(_ entry: Entry) throws -> Selection {
        let text = try NativeBackupStore.read(entry.name, in: entry.root)
        return Selection(backup: try NativeSettingsBackup(data: Data(text.utf8), name: entry.name), cloud: entry.cloud)
    }
    /// Security-scoped Files URLs are kept open only for the bounded read.
    static func read(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try NativeBackupStore.readData(url)
    }
    static func prepareShare(_ raw: [String: Any], library: Bool, temporaryDirectory: URL = FileManager.default.temporaryDirectory) throws -> Share {
        let data = try JSONSerialization.data(withJSONObject: raw, options: [.sortedKeys])
        _ = try NativeSettingsBackup(data: data, name: "MORA")
        let folder = temporaryDirectory.appendingPathComponent("MORA-backup-\(UUID().uuidString)", isDirectory: true)
        let url = folder.appendingPathComponent(library ? "MORA-library.json" : "MORA-playlists.json")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        do { try data.write(to: url, options: .atomic) }
        catch { try? FileManager.default.removeItem(at: folder); throw error }
        return Share(folder: folder, url: url)
    }
    static func restoreMessage(_ result: [String: Any]) -> String {
        let playlists = max(0, (result["playlists"] as? NSNumber)?.intValue ?? 0)
        let missing = max(0, (result["missingFiles"] as? NSNumber)?.intValue ?? 0)
        return "Восстановлено плейлистов: \(playlists)." + (missing > 0 ? " Не найдено локальных файлов: \(missing). Их места в плейлистах сохранены." : "")
    }
}
