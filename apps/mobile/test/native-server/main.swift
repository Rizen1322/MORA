import Foundation
import SQLite3

// NativeServer.swift with the real www/server-jsc.js (node apps/mobile/build.mjs --no-web) in macOS JavaScriptCore:
// boot, /api requests, and settings written to a real SQLite file at once.
let bundle = URL(fileURLWithPath: CommandLine.arguments[1])
let root = FileManager.default.temporaryDirectory.appendingPathComponent("mora-server-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: root) }

let server = NativeServer(root: root, script: try String(contentsOf: bundle, encoding: .utf8), services: .init(
    decode: { _, _, _ in throw CocoaError(.featureUnsupported) },
    analyzerVersion: { "test" },
    analyze: { _, _ in nil }))
let lock = NSCondition()
var messages: [[String: Any]] = []
server.onMessage = { message in
    lock.lock(); messages.append(message); lock.broadcast(); lock.unlock()
    // outbound HTTP is not part of this check: the server must cope with being offline
}
func wait(_ what: String, _ match: @escaping ([String: Any]) -> Bool) -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    let deadline = Date().addingTimeInterval(30)
    while true {
        if let hit = messages.first(where: match) { return hit }
        if let failure = messages.first(where: { $0["t"] as? String == "boot-error" }) { fatalError("boot-error: \(failure["error"] ?? "")") }
        guard lock.wait(until: deadline) else { fatalError("timed out waiting for \(what)") }
    }
}
var nextId = 0
func request(_ method: String, _ url: String, _ body: String? = nil) -> (status: Int, text: String) {
    nextId += 1
    let id = Double(nextId)
    server.send(["t": "req", "id": id, "method": method, "url": url, "headers": body == nil ? [:] : ["content-type": "application/json"], "body": body ?? NSNull()])
    _ = wait("end \(url)") { ($0["t"] as? String == "end" || $0["t"] as? String == "fail") && $0["id"] as? Double == id }
    lock.lock(); defer { lock.unlock() }
    let mine = messages.filter { $0["id"] as? Double == id }
    if let fail = mine.first(where: { $0["t"] as? String == "fail" }) { fatalError("\(url) failed: \(fail["error"] ?? "")") }
    let status = Int(mine.first { $0["t"] as? String == "head" }?["status"] as? Double ?? 0)
    let text = mine.filter { $0["t"] as? String == "chunk" }.map { m -> String in
        if let s = m["data"] as? String { return s }
        return String(decoding: m["data"] as? Data ?? Data(), as: UTF8.self)
    }.joined()
    return (status, text)
}

server.start()
server.send(["t": "secret-key", "key": NSNull()])
_ = wait("ready") { $0["t"] as? String == "ready" }

let health = request("GET", "/api/health")
assert(health.status == 200, "health \(health)")
let library = request("GET", "/api/library")
assert(library.status == 200 && library.text == #"{"tracks":[]}"#, "library \(library)")
let put = request("PUT", "/api/settings", #"{"ui":{"motion":"full"}}"#)
assert(put.status < 300, "settings \(put)")

var db: OpaquePointer?
assert(sqlite3_open_v2(root.appendingPathComponent("data/automix.sqlite").path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK)
var stmt: OpaquePointer?
assert(sqlite3_prepare_v2(db, "SELECT value FROM kv WHERE key = 'settings'", -1, &stmt, nil) == SQLITE_OK)
assert(sqlite3_step(stmt) == SQLITE_ROW)
let settings = String(cString: sqlite3_column_text(stmt, 0))
assert(settings.contains(#""motion":"full""#), settings)
sqlite3_finalize(stmt); sqlite3_close(db)
print("Native server passed")
