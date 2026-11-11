import Foundation

let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: root) }
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
let file = root.appendingPathComponent("one.media")
try Data([1, 2, 3]).write(to: file)
let track = NativeStationSnapshot.Track(trackId: "one", title: "Трек", artist: "Исполнитель", album: "Альбом", duration: 180, artwork: nil, localFile: "one.media")
let snapshot = NativeStationSnapshot(context: "wave", source: "own", index: 0, position: 12, settings: .init(mood: "calm", diversity: "balanced", mode: "normal"), tracks: [track])
let encoded = try JSONEncoder().encode(snapshot)
let decoded = try NativeStationSnapshot.decode(encoded)
assert(decoded == snapshot && decoded.isWave)
var librarySnapshot = snapshot; librarySnapshot.context = "library"
assert(!librarySnapshot.isWave)
let local = try decoded.localTracks(in: root)
assert(local.count == 1)
for bytes in [Data(), Data("broken".utf8), Data("{}".utf8)] {
    do { _ = try NativeStationSnapshot.decode(bytes); assertionFailure("Accepted corrupt snapshot") } catch {}
}
var invalid = snapshot
invalid.schemaVersion = 99
do { _ = try NativeStationSnapshot.decode(JSONEncoder().encode(invalid)); assertionFailure("Accepted future schema") } catch {}
invalid = snapshot; invalid.index = 2
do { _ = try invalid.localTracks(in: root); assertionFailure("Accepted invalid index") } catch {}
invalid = snapshot; invalid.tracks[0].localFile = "../one.media"
do { _ = try invalid.localTracks(in: root); assertionFailure("Accepted path traversal") } catch {}
try FileManager.default.removeItem(at: file)
do { _ = try decoded.localTracks(in: root); assertionFailure("Started absent file") } catch {}
print("Native station snapshot passed")
