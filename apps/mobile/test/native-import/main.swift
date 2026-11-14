import Foundation

func require(_ value: Bool, _ message: String) { precondition(value, message) }
func rejects(_ work: () throws -> Void) { do { try work(); fatalError("Invalid import accepted") } catch {} }
func run<T>(_ work: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: Swift.Result<T, Error>!
    Task.detached { do { result = .success(try await work()) } catch { result = .failure(error) }; done.signal() }
    require(done.wait(timeout: .now() + 10) == .success, "Native import timed out")
    return try result.get()
}
let folder = FileManager.default.temporaryDirectory.appendingPathComponent("native-import-test-" + UUID().uuidString)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: folder) }
let source = folder.appendingPathComponent("Оригинал.wav"), root = folder.appendingPathComponent("server")
let bytes = Data([1, 2, 3, 4])
try bytes.write(to: source)
let copy = try NativeImportFiles.stage(source, root: root)
let staged = root.appendingPathComponent("data/incoming/native/" + copy.file)
require(try Data(contentsOf: staged) == bytes && Data(contentsOf: source) == bytes, "Staging copies bytes without removing provider originals")
require(copy.name == "Оригинал.wav" && UUID(uuidString: String(copy.file.dropLast(4))) != nil, "Private name is independent from the display name")
let empty = folder.appendingPathComponent("empty.wav"); try Data().write(to: empty)
rejects { _ = try NativeImportFiles.stage(empty, root: root) }
let bad = folder.appendingPathComponent("unsupported.exe"); try bytes.write(to: bad)
rejects { _ = try NativeImportFiles.stage(bad, root: root) }
let playlist = folder.appendingPathComponent("Мой.csv")
try "Track Name,Artist Name(s)\nSong,Artist\nSong,Artist\n".write(to: playlist, atomically: true, encoding: .utf8)
let body = try NativeImportFiles.playlist(playlist)
require((body["file"] as? [String: String])?["text"]?.components(separatedBy: "Song").count == 3, "Playlist read preserves repeats")
let large = folder.appendingPathComponent("large.csv")
try Data(repeating: 0, count: 1024 * 1024).write(to: large)
rejects { _ = try NativeImportFiles.playlist(large) } // JSON escaping must also fit the API's 4 MB limit.
let link = root.appendingPathComponent("data/incoming/native/link.wav")
try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
rejects { _ = try NativeImportFiles.stage(link, root: root) }
try NativeImportFiles.cleanStaging(root: root)
require(!FileManager.default.fileExists(atPath: staged.path) && FileManager.default.fileExists(atPath: source.path), "Restart cleanup removes only abandoned private copies")

final class API {
    struct Call { let method: String, path: String, body: [String: Any]? }
    var calls: [Call] = []
    var response: [String: Any] = [:]
    func request(_ method: String, _ path: String, _ body: [String: Any]?) async throws -> [String: Any] {
        calls.append(Call(method: method, path: path, body: body)); return response
    }
}
let api = API(), state = NativeImportState()
let rows: [[String: Any]] = [
    ["position": 0, "title": "Song", "artist": "Artist", "status": "matched", "how": "source"],
    ["position": 1, "title": "Song", "artist": "Artist", "status": "uncertain"],
    ["position": 2, "title": "Missing", "artist": "Artist", "status": "missing"],
]
let job: [String: Any] = ["id": "job/id", "name": "Import", "state": "ready", "complete": false, "note": "Partial source", "rows": rows]
api.response = job
try run { try await state.start(body, request: api.request) }
require(api.calls.last?.method == "POST" && api.calls.last?.path == "/api/imports", "File metadata uses the direct import API")
let page = try run { try await state.page("/import", request: api.request) }
require(api.calls.last?.path == "/api/imports/job%2Fid", "Job identifiers cannot change the request path")
let rendered = NativePage(page)!
require(rendered.sections[2].rows.count == 3, "Report preserves order and intentional repeated tracks")
require(String(describing: page).contains("Partial source"), "Partial collections stay visibly partial")
let pick = try state.pick(2)
require(pick.job == "job/id" && pick.position == 2 && pick.title == "Missing", "Manual choice retains job and original position")
let before = api.calls.count
rejects { _ = try run { try await state.execute("resolveImport", ["job": "stale", "position": 2, "choice": ["trackId": "x"]], request: api.request) } }
require(api.calls.count == before, "A stale sheet cannot edit a different import")
_ = try run { try await state.execute("resolveImport", ["job": "job/id", "position": 2, "choice": ["trackId": "x"]], request: api.request) }
require(api.calls.last?.path == "/api/imports/job%2Fid/resolve" && api.calls.last?.body?["position"] as? Int == 2, "Manual resolution uses the original position")
_ = try run { try await state.execute("importUncertain", ["value": true], request: api.request) }
_ = try run { try await state.execute("importPlaylist", [:], request: api.request) }
require(api.calls.last?.body?["includeUncertain"] as? Bool == true, "Uncertain matches require the listener's explicit choice")
_ = try run { try await state.execute("closeImport", [:], request: api.request) }
require(state.job == nil && !state.includeUncertain, "Closing clears only the selection")
rejects { _ = try run { try await state.execute("importUrl", ["form": ["url": "file:///private/file"]], request: api.request) } }
api.response = ["id": "new/id", "count": 3, "unavailable": 1]
let imported = try run { try await state.execute("importYandexPlaylist", ["kind": "kind/1"], request: api.request) }
require(imported.mutated && imported.path == "/playlist/new%2Fid" && imported.message?.contains("Недоступно: 1") == true, "Yandex import preserves unavailable-slot warnings")
require(api.calls.last?.path == "/api/providers/yandex/playlists/kind%2F1/import", "Yandex kinds are encoded")
let candidate = try NativeImportState.candidate(["playable": true, "audioProvider": "youtube", "externalId": "x", "title": "Song", "artist": "Artist", "duration": 180, "audioUrl": "must-not-be-sent"])
require(candidate["provider"] as? String == "youtube" && candidate["audioUrl"] == nil, "Manual candidates contain metadata only")
rejects { _ = try NativeImportState.candidate(["playable": false]) }
require(NativeImportState.handles("/import") && NativeImportState.handles("/yandex-playlists") && !NativeImportState.handles("/settings"), "Only import pages use this state")
print("Native import: private file copies, originals, bounded text, duplicate rows, partial reports, stale choices and API actions passed")
