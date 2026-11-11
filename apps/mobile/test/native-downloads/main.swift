import Foundation

func track(_ id: String, _ title: String, provider: String = "local", pinned: Bool = false) -> NativeTrack {
    NativeTrack(["id": id, "title": title, "provider": provider, "pinned": pinned, "sourceKind": provider == "local" ? "managed" : "remote"])!
}
func job(_ id: String, trackId: String? = nil, state: String = "done") -> [String: Any] {
    var value: [String: Any] = ["id": id, "title": id, "state": state, "progress": 1.2, "bytes": 123, "totalBytes": 200]
    value["trackId"] = trackId
    return value
}
func requireFailure(_ body: () throws -> Void) {
    do { try body(); fatalError("Invalid download response accepted") }
    catch is NativeDownloadsState.Failure {} catch { fatalError("Unexpected error: \(error)") }
}
var state = NativeDownloadsState()
try state.receive(["jobs": [job("same", trackId: "server-done"), job("active", state: "downloading")],
    "usage": ["cacheBytes": 100, "pinnedBytes": 200, "limitBytes": 1000, "freeBytes": NSNull()]])
try state.receiveNative(["jobs": [job("same", trackId: "native-done"), job("native-active", state: "paused"),
    job("missing-metadata", trackId: "native-orphan"), job("cancelled", state: "cancelled")]])
precondition(state.active.map(\.identity) == ["server:active", "native:native-active"])
precondition(state.serverJobs[0].progress == 1)
precondition(state.active[0].canPause && !state.active[0].canRetry)
precondition(state.active[1].canRetry && !state.active[1].canPause)
precondition(state.nativeBytes == 246)
precondition(state.usage!.availableForNative == 700 && state.usage!.freeBytes == nil)
let library = [track("own", "Б"), track("pinned", "А", provider: "youtube", pinned: true),
    track("server-done", "В", provider: "soundcloud"), track("native-done", "Г", provider: "yandex"),
    track("remote", "Д", provider: "youtube")]
let downloaded = state.downloaded(in: library, byId: Dictionary(uniqueKeysWithValues: library.map { ($0.id, $0) }))
precondition(Set(downloaded.map(\.id)) == Set(["pinned", "server-done", "native-done", "native-orphan"]))
precondition(downloaded.first { $0.id == "native-orphan" }!.offline)
precondition(!downloaded.first { $0.id == "native-orphan" }!.ok)
precondition(NativeDownloadsState.own(in: library).map(\.id) == ["own"])
precondition(NativeDownloadsState.component("id/with?query#%.") == "id%2Fwith%3Fquery%23%25%2E")
precondition(NativeDownloadsState.space(1024 * 1024 * 512) == "512 МБ")
precondition(NativeDownloadsState.space(1024 * 1024 * 1024) == "1,0 ГБ")
requireFailure { try state.receive(["jobs": [], "usage": ["limitBytes": 100]]) }
precondition(state.serverJobs.count == 2 && state.usage!.limitBytes == 1000)
requireFailure { _ = try NativeDownloadsState.Job(["id": "x", "state": "bogus"], native: false) }
requireFailure { _ = try NativeDownloadsState.Job(["id": "", "state": "paused"], native: false) }
requireFailure { _ = try NativeDownloadsState.Usage(["cacheBytes": Double.nan, "pinnedBytes": 0, "limitBytes": 0]) }
let failed = try NativeDownloadsState.Job(["id": "failed", "state": "failed", "error": "Сеть недоступна", "bytes": Double.infinity], native: true)
precondition(failed.status == "Сеть недоступна" && failed.bytes == 0 && failed.canRetry)
print("Native downloads state checks passed")
