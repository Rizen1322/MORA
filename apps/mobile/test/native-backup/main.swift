import Foundation

let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: folder) }
func text(_ n: Int) -> String { #"{"format":"mora-playlists","version":1,"origin":"test","createdAt":"now","tracks":[],"playlists":[],"revision":\#(n)}"# }
let first = try NativeBackupStore.save(text(0), folder: folder)
assert(first != nil)
let same = try NativeBackupStore.save(text(0), folder: folder)
assert(same == nil)
for n in 1...6 { _ = try NativeBackupStore.save(text(n), folder: folder) }
let names = try FileManager.default.contentsOfDirectory(atPath: folder.path)
assert(names.count == 5)
do { _ = try NativeBackupStore.save("broken", folder: folder); assertionFailure("Accepted corrupt backup") } catch {}
do { _ = try NativeBackupStore.save(#"{"format":"mora-playlists","version":1,"tracks":[],"playlists":[],"token":"secret"}"#, folder: folder); assertionFailure("Accepted credentials") } catch {}
print("Native backup retention passed")
