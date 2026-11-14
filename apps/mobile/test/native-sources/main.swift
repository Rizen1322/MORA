import Foundation

func require(_ value: Bool, _ message: String) { precondition(value, message) }
func run<T>(_ work: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: Result<T, Error>!
    Task.detached {
        do { result = .success(try await work()) } catch { result = .failure(error) }
        done.signal()
    }
    require(done.wait(timeout: .now() + 10) == .success, "Native account request never completed")
    return try result.get()
}
func rejects(_ work: () throws -> Void) {
    do { try work(); fatalError("Invalid account data was accepted") } catch {}
}
let provider: [String: Any] = [
    "id": "yandex", "status": "needs_credentials", "hasSecret": false,
    "configFields": [["key": "token", "label": "OAuth-токен", "type": "password", "secret": true]],
    "config": ["token": "must-not-appear-in-form"],
    "docs": ["https://ym.marshal.dev/", "http://untrusted.example", "javascript:alert(1)", "https://user:secret@example.org/"],
]
let account = try NativeSourceAccount(provider)
require(!account.linked && account.fields.first?.secure == true && account.docs.count == 1, "Secure form and safe documentation links")
let body = try account.credentials(["token": "  OAuth fixture  ", "unexpected": "not-sent"])
require((body["secret"] as? [String: String]) == ["token": "OAuth fixture"], "Only declared credentials go into the request")
require((body["config"] as? [String: String])?.isEmpty == true, "Secrets never enter public config")
rejects { _ = try account.credentials([:]) }
rejects { _ = try account.credentials(["token": String(repeating: "x", count: 8193)]) }
rejects { _ = try NativeSourceAccount(["id": "other", "status": "connected"]) }
rejects { _ = try NativeSourceAccount(["id": "yandex", "status": "unknown"]) }
var saved = provider
saved["hasSecret"] = true; saved["status"] = "error"
let offline = try NativeSourceAccount(saved)
require(offline.linked && !offline.connected, "A saved account stays available when its status check fails")
require((try offline.credentials([:])["secret"] as? [String: String])?["token"] == "", "Empty input reuses a saved secret instead of echoing it")

final class API {
    struct Call { let method: String, path: String, body: [String: Any]? }
    var calls: [Call] = []
    var response: [String: Any] = [:]
    var error: Error?
    func request(_ method: String, _ path: String, _ body: [String: Any]?) async throws -> [String: Any] {
        calls.append(Call(method: method, path: path, body: body))
        if let error { throw error }
        return response
    }
}
let api = API()
api.response = ["providers": [provider]]
_ = try run { try await NativeSourcesState.account(force: true, request: api.request) }
require(api.calls.last?.path == "/api/providers?force=1" && api.calls.last?.method == "GET", "Refresh talks directly to the provider API")
var connected = provider
connected["status"] = "connected"; connected["hasSecret"] = true; connected["account"] = "Fixture listener"
api.response = ["ok": true, "info": connected]
let result = try run { try await NativeSourcesState.connect(account, values: ["token": "fixture"], request: api.request) }
require(result.connected && result.name == "Fixture listener", "Connection uses the returned account")
require(api.calls.last?.path == "/api/providers/yandex/connect" && api.calls.last?.method == "POST", "Connection endpoint")
api.error = NativeSourcesState.Failure(message: "Token rejected")
rejects { _ = try run { try await NativeSourcesState.connect(account, values: ["token": "rejected"], request: api.request) } }
api.error = nil; api.response = ["ok": true]
try run { try await NativeSourcesState.disconnect(request: api.request) }
require(api.calls.last?.path == "/api/providers/yandex/disconnect" && api.calls.last?.body == nil, "Disconnect sends no credentials")
api.response = [:]
rejects { try run { try await NativeSourcesState.disconnect(request: api.request) } }

api.response = ["job": NSNull()]
let empty = try run { try await NativeSourcesState.likes(request: api.request) }
require(empty == nil && api.calls.last?.path == "/api/providers/yandex/likes/import?envelope=1", "No import is a valid empty state")
api.response = ["job": ["state": "paused", "total": 10, "done": 4, "failed": 1, "skipped": 1, "busy": false]]
let likes = try run { try await NativeSourcesState.likes(request: api.request) }!
require(!likes.active && !likes.finished && likes.progress == 0.6, "Paused import keeps its progress and can resume")
api.response = ["ok": true]
try run { try await NativeSourcesState.changeLikes("retry", request: api.request) }
require(api.calls.last?.path == "/api/providers/yandex/likes/import/resume" && api.calls.last?.body?["retryFailed"] as? Bool == true, "Retry only failed items")
for action in ["start", "pause", "cancel", "resume"] {
    try run { try await NativeSourcesState.changeLikes(action, request: api.request) }
    require(api.calls.last?.method == "POST" && api.calls.last?.body == nil, "Import controls retain the existing API contract")
}
let before = api.calls.count
rejects { try run { try await NativeSourcesState.changeLikes("../../disconnect", request: api.request) } }
require(api.calls.count == before, "Unknown actions never reach the server")
rejects { _ = try NativeSourceLikes(["state": "unknown"]) }
print("Native sources: account forms, credential isolation, offline status, direct requests, import progress and controls passed")
