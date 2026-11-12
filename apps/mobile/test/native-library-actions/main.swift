import Foundation

func require(_ condition: Bool, _ message: String) { precondition(condition, message) }
func run<T>(_ work: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: Swift.Result<T, Error>!
    Task.detached {
        do { result = .success(try await work()) } catch { result = .failure(error) }
        done.signal()
    }
    require(done.wait(timeout: .now() + 10) == .success, "Action never completed")
    return try result.get()
}
func rejects(_ message: String, _ work: () throws -> Void) {
    do { try work(); fatalError(message) } catch {}
}
final class API {
    struct Call { let method: String, path: String, body: [String: Any]? }
    var calls: [Call] = []
    var response: (Call) throws -> [String: Any] = { _ in [:] }
    func request(_ method: String, _ path: String, _ body: [String: Any]?) async throws -> [String: Any] {
        let call = Call(method: method, path: path, body: body)
        calls.append(call)
        return try response(call)
    }
    func execute(_ name: String, _ args: [String: Any] = [:]) throws -> NativeLibraryActions.Result? {
        try run { try await NativeLibraryActions.execute(name, args, request: self.request) }
    }
}
let api = API()
api.response = { _ in ["id": "new/id"] }
let created = try api.execute("createPlaylist", ["value": "  Мои песни  "])!
require(created.mutated && created.go == "/playlist/new%2Fid", "Creation navigates using the server id")
require(api.calls.count == 1 && api.calls[0].method == "POST" && api.calls[0].path == "/api/playlists", "Creation endpoint")
require(api.calls[0].body?["name"] as? String == "Мои песни", "Name is trimmed")

api.calls = []
let renamed = try api.execute("renamePlaylist", ["id": "id/a?b&c", "value": "  Новое  "])!
require(renamed.mutated && api.calls[0].method == "PATCH" && api.calls[0].path == "/api/playlists/id%2Fa%3Fb%26c", "Rename safely encodes the path segment")
require(api.calls[0].body?.count == 1 && api.calls[0].body?["name"] as? String == "Новое", "Rename does not overwrite the description")
api.calls = []
let deleted = try api.execute("deletePlaylist", ["id": "p"])!
require(deleted.mutated && deleted.go == "/library/playlists", "Deletion navigates to the list")
require(api.calls[0].method == "DELETE" && api.calls[0].path == "/api/playlists/p" && api.calls[0].body == nil, "Delete only the playlist")

api.calls = []
api.response = { call in call.method == "GET" ? ["name": "Повторы"] : ["added": 2] }
let added = try api.execute("addToPlaylist", ["playlistId": "p", "ids": ["same", "same"]])!
require(added.mutated && added.go == nil && added.message?.contains("Повторы") == true, "Adding keeps the current screen")
require(api.calls.count == 2 && api.calls[0].method == "GET" && api.calls[1].method == "POST", "Adding reads the name, then writes once")
require(api.calls[1].path == "/api/playlists/p/tracks" && api.calls[1].body?["trackIds"] as? [String] == ["same", "same"], "Duplicate track entries must not be collapsed")
api.calls = []
_ = try api.execute("addToPlaylist", ["name": "  Новый  ", "ids": ["same", "same"]])
require(api.calls.count == 1 && api.calls[0].path == "/api/playlists" && api.calls[0].body?["name"] as? String == "Новый", "Picker creates one playlist with its selected tracks")
require(api.calls[0].body?["trackIds"] as? [String] == ["same", "same"], "Creation preserves repeated track entries")

api.calls = []
_ = try api.execute("removeFromPlaylist", ["id": "p", "entry": 42])
require(api.calls[0].method == "DELETE" && api.calls[0].path == "/api/playlists/p/tracks/42", "Remove by entry identity, never by track identity")
let order = try NativeLibraryActions.reordered([11, 12, 13, 14], from: 1, to: 4)
require(order == [11, 13, 14, 12], "SwiftUI forward destination is adjusted after removing the source")
require(try NativeLibraryActions.reordered([11, 12, 13, 14], from: 3, to: 0) == [14, 11, 12, 13], "Move backwards")
api.calls = []
_ = try api.execute("reorderPlaylist", ["id": "p", "entries": [11, 12, 13], "from": 0, "to": 3])
require(api.calls[0].method == "PUT" && api.calls[0].path == "/api/playlists/p/order", "Reorder endpoint")
require(api.calls[0].body?["entryIds"] as? [Int] == [12, 13, 11], "Send entry IDs as a complete permutation")
for (entries, from, to) in [([11, 11], 0, 2), ([11], -1, 1), ([11], 1, 0), ([11], 0, 2), ([], 0, 0)] {
    rejects("Invalid move accepted") { _ = try NativeLibraryActions.reordered(entries, from: from, to: to) }
}
rejects("Boolean entry ID accepted") { _ = try NativeLibraryActions.reordered([true], from: 0, to: 1) }
rejects("Fractional entry ID accepted") { _ = try NativeLibraryActions.reordered([1.5], from: 0, to: 1) }
api.calls = []
api.response = { _ in throw NativeLibraryActions.Failure(message: "список не совпадает с плейлистом") }
rejects("Stale server order was silently accepted") { _ = try api.execute("reorderPlaylist", ["id": "p", "entries": [1], "from": 0, "to": 1]) }
require(api.calls.count == 1, "A supported failure must not retry or fall back")

api.calls = []
api.response = { _ in ["ok": true] }
let cleared = try api.execute("clearHistory")!
require(cleared.mutated && api.calls[0].method == "DELETE" && api.calls[0].path == "/api/history", "Clear history uses the dedicated API")
api.calls = []
api.response = { _ in ["format": "mora-playlists", "version": 1, "origin": "fixture", "tracks": [], "playlists": [["key": "p", "tracks": ["same", "same"]]]] }
let exported = try api.execute("exportPlaylist", ["id": "p&other=1"])!
require(!exported.mutated && exported.export?.name == "MORA-playlist.json", "Export is not a library mutation")
require(api.calls[0].method == "GET" && api.calls[0].path == "/api/backup/playlists?playlist=p%26other%3D1", "Export query cannot select another playlist through query injection")
let backup = try JSONSerialization.jsonObject(with: Data(exported.export!.text.utf8)) as! [String: Any]
require((backup["playlists"] as? [[String: Any]])?.first?["tracks"] as? [String] == ["same", "same"], "Export preserves the server backup and repeated entries")

api.calls = []
require(try api.execute("playAll", ["ids": ["same"]]) == nil, "Unsupported playback stays with its existing owner")
require(try api.execute("downloadTracks", [:]) == nil, "Downloads stay out of this dispatcher")
require(try api.execute("createPlaylist", ["value": "  "])?.mutated == false, "An empty create prompt is a handled no-op")
require(try api.execute("renamePlaylist", ["id": "p", "value": ""])?.mutated == false, "An empty rename prompt is a handled no-op")
rejects("Empty selection accepted") { _ = try api.execute("addToPlaylist", ["playlistId": "p", "ids": []]) }
rejects("Missing playlist accepted") { _ = try api.execute("deletePlaylist", [:]) }
require(api.calls.isEmpty, "Unsupported and invalid input never reaches the server")
print("Native library actions: endpoints, errors, duplicate entries, reorder validation, export and unsupported fallback passed")
