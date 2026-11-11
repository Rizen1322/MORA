import Foundation
import SQLite3

// NativeServer.swift with the real www/server-jsc.js (node apps/mobile/build.mjs --no-web) in macOS JavaScriptCore:
// boot, /api requests, and settings written to a real SQLite file at once.
let bundle = URL(fileURLWithPath: CommandLine.arguments[1])
let root = FileManager.default.temporaryDirectory.appendingPathComponent("mora-server-\(UUID().uuidString)")
defer { try? FileManager.default.removeItem(at: root) }

let server = NativeServer(root: root, script: try String(contentsOf: bundle, encoding: .utf8), services: .init(
    // two frames, both channels: 0.5, 0.25
    decode: { _, _, _ in let plane = [Float(0.5), 0.25].withUnsafeBufferPointer { Data(buffer: $0) }; return ([plane, plane], 48000, 1) },
    analyzerVersion: { "test" },
    analyze: { _, _ in nil }))
let lock = NSCondition()
var messages: [[String: Any]] = []
server.attach { message in
    lock.lock(); messages.append(message); lock.broadcast(); lock.unlock()
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
// diagnostics: each request with its path (never the query) and duration
assert(server.trace.contains { $0.contains("api GET /api/health ") } && server.trace.contains { $0.contains("ready after") }, "trace \(server.trace)")

var db: OpaquePointer?
assert(sqlite3_open_v2(root.appendingPathComponent("data/automix.sqlite").path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK)
var stmt: OpaquePointer?
assert(sqlite3_prepare_v2(db, "SELECT value FROM kv WHERE key = 'settings'", -1, &stmt, nil) == SQLITE_OK)
assert(sqlite3_step(stmt) == SQLITE_ROW)
let settings = String(cString: sqlite3_column_text(stmt, 0))
assert(settings.contains(#""motion":"full""#), settings)
sqlite3_finalize(stmt); sqlite3_close(db)

func nativeRequest(_ path: String, method: String = "GET", body: [String: Any]? = nil, timeout: Double = 2,
                   cancel: Bool = false, reattach: Bool = false) -> Result<[String: Any], Error> {
    let done = DispatchSemaphore(value: 0)
    var result: Result<[String: Any], Error>!
    let task = Task.detached {
        do { result = .success(try await server.request(method, path, body: body, timeout: timeout)) }
        catch { result = .failure(error) }
        done.signal()
    }
    if cancel { DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { task.cancel() } }
    if reattach {
        var pending = false
        for _ in 0..<100 {
            pending = evaluate("typeof globalThis.__releaseNativeDelayed === 'function'") as? Bool == true
            if pending { break }
            Thread.sleep(forTimeInterval: 0.01)
        }
        assert(pending, "native request was not dispatched before reattach")
        server.attach { message in lock.lock(); messages.append(message); lock.broadcast(); lock.unlock() }
        _ = evaluate("globalThis.__releaseNativeDelayed(); delete globalThis.__releaseNativeDelayed; 0")
    }
    assert(done.wait(timeout: .now() + 10) == .success, "native request never completed")
    return result
}
let nativeSettings = try nativeRequest("/api/settings").get()
assert((nativeSettings["ui"] as? [String: Any])?["motion"] as? String == "full")
let nativePut = try nativeRequest("/api/settings", method: "PUT", body: ["automix": ["enabled": false]]).get()
assert((nativePut["automix"] as? [String: Any])?["enabled"] as? Bool == false)
if case .success = nativeRequest("/api/not-found") { fatalError("native accepted HTTP 404") }
lock.lock()
assert(!messages.contains { (($0["id"] as? NSNumber)?.intValue ?? 0) < 0 }, "native response leaked to the page")
lock.unlock()

// Decoded planes reach the server as ArrayBuffers, as postMessage handed them to the worker (rpc.ts: new Float32Array(plane)).
func evaluate(_ script: String) -> Any {
    let done = DispatchSemaphore(value: 0)
    var out: Any = NSNull()
    server.evaluate(script) { out = $0; done.signal() }
    done.wait()
    return out
}
_ = evaluate("""
globalThis.__originalReceive = globalThis.__moraReceive;
globalThis.__nativeAborted = [];
globalThis.__moraReceive = m => {
  if (m.t === 'abort' && m.id < 0) globalThis.__nativeAborted.push(m.id);
  if (m.url === '/api/native-hang') return;
  if (m.url === '/api/native-invalid' || m.url === '/api/native-delayed') {
    const reply = () => { postMessage({t:'head',id:m.id,status:200,headers:{}});
      postMessage({t:'chunk',id:m.id,data:m.url.endsWith('invalid')?'broken':'{"ok":true}'});
      postMessage({t:'end',id:m.id}); };
    if (m.url.endsWith('delayed')) globalThis.__releaseNativeDelayed = reply; else reply();
    return;
  }
  return globalThis.__originalReceive(m);
}; 0
""")
let delayed = try nativeRequest("/api/native-delayed", reattach: true).get()
assert(delayed["ok"] as? Bool == true, "reattach aborted native request")
if case .success = nativeRequest("/api/native-invalid") { fatalError("native accepted invalid JSON") }
if case .success = nativeRequest("/api/native-hang", timeout: 0.05) { fatalError("native request did not time out") }
switch nativeRequest("/api/native-hang", cancel: true) {
case .failure(is CancellationError): break
default: fatalError("native cancellation was not preserved")
}
assert((evaluate("globalThis.__nativeAborted.length") as? Double ?? 0) >= 2, "native timeouts/cancellation did not abort server work")
_ = evaluate("globalThis.__moraReceive = globalThis.__originalReceive; 0")
_ = evaluate("""
(() => { const prev = self.onmessage; globalThis.__decoded = null;
  self.onmessage = (e) => { const m = e.data;
    if (m.t === 'rpc-res' && m.id === 900001) { const p = m.value.planes[0]; globalThis.__decoded = [p instanceof ArrayBuffer, new Float32Array(p).length, new Float32Array(p)[1]]; self.onmessage = prev; }
    else prev(e); };
  postMessage({ t: 'rpc', id: 900001, op: 'decode', args: { bytes: new Uint8Array([1, 2, 3]).buffer, sampleRate: 44100, channels: 2, format: 'f32le' } });
  return 0; })()
""")
var decoded: [Any] = []
for _ in 0..<100 where decoded.isEmpty { decoded = evaluate("globalThis.__decoded") as? [Any] ?? []; if decoded.isEmpty { Thread.sleep(forTimeInterval: 0.05) } }
assert(decoded.count == 3 && decoded[0] as? Bool == true && decoded[1] as? Double == 2 && decoded[2] as? Double == 0.25, "decoded \(decoded)")

// Deep recursion fits: JavaScriptCore's stack limit follows the thread's stack (512 KB on a GCD thread overflowed).
let depth = evaluate("(() => { const f = (n) => n ? f(n - 1) + 1 : 0; try { return f(30000); } catch (e) { return String(e); } })()")
assert(depth as? Double == 30000, "recursion \(depth)")

// A reloaded WebView attaches again and must get ready again (the server outlives the page).
lock.lock(); messages.removeAll(); lock.unlock()
server.attach { message in lock.lock(); messages.append(message); lock.broadcast(); lock.unlock() }
_ = wait("ready again") { $0["t"] as? String == "ready" }

// A script that throws while loading is a boot error, not a silent hang.
let broken = NativeServer(root: root.appendingPathComponent("broken"), script: "throw new Error('полифил не найден')", services: .init(
    decode: { _, _, _ in throw CocoaError(.featureUnsupported) }, analyzerVersion: { "test" }, analyze: { _, _ in nil }))
let failed = DispatchSemaphore(value: 0)
var bootError = ""
broken.attach { if $0["t"] as? String == "boot-error" { bootError = $0["error"] as? String ?? ""; failed.signal() } }
broken.start()
assert(failed.wait(timeout: .now() + 10) == .success && bootError.contains("полифил не найден"), "boot error \(bootError)")
print("Native server passed")
