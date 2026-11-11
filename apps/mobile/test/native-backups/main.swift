import Foundation

let root = FileManager.default.temporaryDirectory.appendingPathComponent("mora-backups-\(UUID().uuidString)", isDirectory: true)
let local = root.appendingPathComponent("local", isDirectory: true)
let cloud = root.appendingPathComponent("cloud", isDirectory: true)
try FileManager.default.createDirectory(at: local, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: cloud, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }
let raw: [String: Any] = ["format": "mora-playlists", "version": 1, "origin": "test", "tracks": [], "playlists": [], "library": ["settings": [:]]]
let data = try JSONSerialization.data(withJSONObject: raw)
let name = "auto-0000000000000001-test.json"
try data.write(to: local.appendingPathComponent(name))
try data.write(to: cloud.appendingPathComponent(name))
let listing = NativeBackupFiles.listing(local: local, cloud: .success(cloud))
precondition(listing.warnings.isEmpty && listing.entries.count == 2)
precondition(Set(listing.entries.map(\.id)).count == 2)
let selected = try NativeBackupFiles.inspect(listing.entries[0])
precondition(selected.backup.count == 0 && selected.hasLibrary && !selected.cloud)
try Data("corrupt".utf8).write(to: local.appendingPathComponent(name))
precondition(selected.backup.raw["format"] as? String == "mora-playlists")
func requireFailure(_ operation: () throws -> Void) {
    do { try operation(); fatalError("Unsafe or corrupt backup accepted") } catch {}
}
requireFailure { _ = try NativeBackupFiles.inspect(listing.entries[0]) }
for invalid in ["../" + name, "auto-../" + name, "/" + name, "auto-\\outside.json"] {
    requireFailure { _ = try NativeBackupStore.read(invalid, in: local) }
}
let outside = root.appendingPathComponent("outside.json")
try data.write(to: outside)
let link = local.appendingPathComponent("auto-symlink.json")
try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
requireFailure { _ = try NativeBackupStore.read(link.lastPathComponent, in: local) }
let directory = local.appendingPathComponent("auto-directory.json", isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
requireFailure { _ = try NativeBackupStore.read(directory.lastPathComponent, in: local) }
let oversized = local.appendingPathComponent("auto-large.json")
precondition(FileManager.default.createFile(atPath: oversized.path, contents: nil))
let handle = try FileHandle(forWritingTo: oversized)
try handle.truncate(atOffset: UInt64(NativeBackupFiles.maximumBytes + 1)); try handle.close()
requireFailure { _ = try NativeBackupStore.read(oversized.lastPathComponent, in: local) }
requireFailure { _ = try NativeBackupFiles.read(oversized) }
let newestOversized = local.appendingPathComponent("auto-zzzz-large.json")
try FileManager.default.moveItem(at: oversized, to: newestOversized)
let saved = try NativeBackupStore.save(String(decoding: data, as: UTF8.self), folder: local)
precondition(saved != nil, "A corrupt oversized predecessor must not prevent a valid automatic backup")
let unavailable = NativeBackupFiles.listing(local: cloud, cloud: .failure(CocoaError(.fileReadNoPermission)))
precondition(unavailable.entries.count == 1 && unavailable.warnings.count == 1)
let invalidRoot = NativeBackupFiles.listing(local: outside, cloud: .success(cloud))
precondition(invalidRoot.entries.count == 1 && invalidRoot.warnings.count == 1)
let file = try NativeBackupFiles.prepareShare(selected.backup.raw, library: true, temporaryDirectory: root)
precondition(file.url.lastPathComponent == "MORA-library.json")
let shared = try NativeSettingsBackup(data: NativeBackupFiles.read(file.url), name: file.url.lastPathComponent)
precondition(shared.raw["origin"] as? String == "test" && shared.raw["library"] is [String: Any])
precondition(FileManager.default.fileExists(atPath: cloud.appendingPathComponent(name).path))
try FileManager.default.removeItem(at: file.folder)
precondition(FileManager.default.fileExists(atPath: cloud.appendingPathComponent(name).path))
requireFailure { _ = try NativeBackupFiles.prepareShare(["format": "wrong"], library: false, temporaryDirectory: root) }
precondition(NativeBackupFiles.restoreMessage(["playlists": 2, "missingFiles": 1]).contains("Их места в плейлистах сохранены"))
print("Native backups file checks passed")
