import Foundation
import JavaScriptCore
import Security
import SQLite3

/// apps/server in JavaScriptCore inside the app process (www/server-jsc.js), instead of a WebView worker.
/// The JS side of the contract is apps/mobile/src/jsc/host.ts; the messages are the worker protocol of
/// apps/mobile/src/shared/protocol.ts, so the page talks to it exactly as it talked to the worker.
/// Everything that touches the JSContext runs on `queue`.
final class NativeServer {
    struct Services {
        /// Whole-file decode to one Float32 plane per channel at `sampleRate` (the page's WebAudio decode before).
        var decode: (_ bytes: Data, _ sampleRate: Double, _ channels: Int) throws -> (planes: [Data], sourceRate: Double, duration: Double)
        var analyzerVersion: () -> String
        /// TrackAnalysis of an audio file; nil when cancelled.
        var analyze: (_ file: URL, _ cancelled: @escaping () -> Bool) throws -> [String: Any]?
    }

    let root: URL
    let queue = DispatchQueue(label: "ru.mora.server", qos: .userInitiated)
    /// Server → page messages (head/chunk/end/fail/ready/boot-error), called on `queue`. Binary parts are Data.
    /// Set through `attach`, which may be called again when the WebView reloads.
    private var onMessage: (([String: Any]) -> Void)?
    private(set) var booted = false
    private var bootError: String?
    private var loading = false
    /// Requests of the attached page still owed a reply; replies to anything else are dropped.
    private var open = Set<Int>()
    private let services: Services
    private let script: String
    private var context: JSContext!
    private var timers: [Int: DispatchSourceTimer] = [:]
    private var fds = Set<Int32>()
    private var dbs: [Int: SQLiteConnection] = [:]
    private var nextDb = 1
    private var requests: [Int: URLSessionTask] = [:]
    private var analyses: [Int: Bool] = [:] // job → cancelled
    private var nextAnalysis = 1
    private let work = DispatchQueue(label: "ru.mora.server.work", qos: .utility, attributes: .concurrent)
    private let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 15 * 60
        return URLSession(configuration: config)
    }()

    init(root: URL, script: String, services: Services) {
        self.root = root.standardizedFileURL
        self.script = script
        self.services = services
    }

    func start() {
        queue.async { self.boot() }
    }

    /// (Re)connects a page. The server outlives the WebView (iOS reloads it under memory pressure): a new
    /// page gets `ready` (or the boot error) again, and requests of the previous one are aborted, so their
    /// replies never land on the new page's requests with the same ids.
    func attach(_ handler: @escaping ([String: Any]) -> Void) {
        queue.async {
            for id in self.open { self.receive(["t": "abort", "id": Double(id)]) }
            self.open.removeAll()
            self.onMessage = handler
            if let error = self.bootError { handler(["t": "boot-error", "error": error]) }
            else if self.booted { handler(["t": "ready"]) }
        }
    }

    /// Page → server: the same messages the page posted to the worker.
    func send(_ message: [String: Any]) {
        queue.async {
            if message["t"] as? String == "req", let id = (message["id"] as? NSNumber)?.intValue { self.open.insert(id) }
            self.receive(message)
        }
    }

    /// Runs `script` in the server's context and hands back its plain value (tests).
    func evaluate(_ script: String, _ done: @escaping (Any) -> Void) {
        queue.async { done(self.swift(self.context?.evaluateScript(script))) }
    }

    private func receive(_ message: [String: Any]) {
        guard let context, let receive = context.objectForKeyedSubscript("__moraReceive") else { return }
        receive.call(withArguments: [js(message)])
    }

    private func failBoot(_ text: String) {
        guard bootError == nil, !booted else { return }
        bootError = text
        onMessage?(["t": "boot-error", "error": text])
    }

    private func boot() {
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        #if os(iOS)
        // Playback continues after the screen locks: the library must stay readable then.
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
        #endif
        guard let vm = JSVirtualMachine(), let context = JSContext(virtualMachine: vm) else { failBoot("JavaScriptCore недоступен"); return }
        self.context = context
        context.name = "MORA server"
        context.exceptionHandler = { [weak self] _, value in
            guard let self else { return }
            let text = "\(value?.toString() ?? "?")\n\(value?.forProperty("stack")?.toString() ?? "")"
            self.log("error", "uncaught: \(text)")
            // a throw while the script loads is a failed boot; the worker's boot().catch covers the async part
            if self.loading { self.failBoot(text) }
        }
        context.setObject(makeHost(), forKeyedSubscript: "moraHost" as NSString)
        loading = true
        context.evaluateScript(script, withSourceURL: URL(string: "capacitor://localhost/server-jsc.js"))
        loading = false
    }

    // MARK: - JS ⇄ Swift values

    private var ctx: JSContextRef { context.jsGlobalContextRef }

    /// Plain data out of JS: typed arrays and ArrayBuffers become Data.
    private func swift(_ value: JSValue?) -> Any {
        guard let value, !value.isNull, !value.isUndefined else { return NSNull() }
        if value.isBoolean { return value.toBool() }
        if value.isNumber { return value.toDouble() }
        if value.isString { return value.toString() ?? "" }
        if let data = bytes(value) { return data }
        if value.isArray {
            let count = Int(value.forProperty("length")?.toInt32() ?? 0)
            return (0..<count).map { swift(value.atIndex($0)) }
        }
        guard let object = JSValueToObject(ctx, value.jsValueRef, nil) else { return NSNull() }
        let names = JSObjectCopyPropertyNames(ctx, object)
        defer { JSPropertyNameArrayRelease(names) }
        var out: [String: Any] = [:]
        for i in 0..<JSPropertyNameArrayGetCount(names) {
            let name = JSPropertyNameArrayGetNameAtIndex(names, i)!
            let key = JSStringCopyCFString(kCFAllocatorDefault, name) as String
            let v = value.forProperty(key)
            if v?.isUndefined == true || v?.isObject == true && JSObjectIsFunction(ctx, JSValueToObject(ctx, v!.jsValueRef, nil)) { continue }
            out[key] = swift(v)
        }
        return out
    }

    private func bytes(_ value: JSValue) -> Data? {
        let type = JSValueGetTypedArrayType(ctx, value.jsValueRef, nil)
        guard type != kJSTypedArrayTypeNone, let object = JSValueToObject(ctx, value.jsValueRef, nil) else { return nil }
        if type == kJSTypedArrayTypeArrayBuffer {
            let length = JSObjectGetArrayBufferByteLength(ctx, object, nil)
            guard length > 0, let pointer = JSObjectGetArrayBufferBytesPtr(ctx, object, nil) else { return Data() }
            return Data(bytes: pointer, count: length)
        }
        let length = JSObjectGetTypedArrayByteLength(ctx, object, nil)
        // JSC returns the backing-buffer base, not the view's first byte.
        guard length > 0, let pointer = JSObjectGetTypedArrayBytesPtr(ctx, object, nil) else { return Data() }
        return Data(bytes: pointer.advanced(by: JSObjectGetTypedArrayByteOffset(ctx, object, nil)), count: length)
    }

    private func uint8Array(_ data: Data) -> JSValue {
        guard let array = JSObjectMakeTypedArray(ctx, kJSTypedArrayTypeUint8Array, data.count, nil) else { return JSValue(nullIn: context) }
        if !data.isEmpty, let target = JSObjectGetTypedArrayBytesPtr(ctx, array, nil) {
            data.withUnsafeBytes { if let source = $0.baseAddress { memcpy(target, source, data.count) } }
        }
        return JSValue(jsValueRef: array, in: context)
    }

    private func js(_ value: Any?) -> JSValue {
        switch value {
        case nil, is NSNull: return JSValue(nullIn: context)
        // messages carry ArrayBuffers, as postMessage gave the worker (rpc.ts reads `new Float32Array(plane)`)
        case let data as Data: return uint8Array(data).forProperty("buffer")
        case let string as String: return JSValue(object: string, in: context)
        case let number as NSNumber:
            return CFGetTypeID(number) == CFBooleanGetTypeID() ? JSValue(bool: number.boolValue, in: context) : JSValue(double: number.doubleValue, in: context)
        case let list as [Any]:
            let array = JSValue(newArrayIn: context)!
            for (i, item) in list.enumerated() { array.setValue(js(item), at: i) }
            return array
        case let map as [String: Any]:
            let object = JSValue(newObjectIn: context)!
            for (k, v) in map { object.setValue(js(v), forProperty: k) }
            return object
        default: return JSValue(object: value, in: context)
        }
    }

    /// Makes the current host call throw an Error with a Node-style `code` in JS.
    @discardableResult private func fail(_ code: String, _ message: String) -> JSValue? {
        let error = JSValue(newErrorFromMessage: "\(code): \(message)", in: context)
        error?.setValue(code, forProperty: "code")
        context.exception = error
        return nil
    }

    private func log(_ level: String, _ text: String) {
        #if DEBUG
        NSLog("[server %@] %@", level, text)
        #else
        if level == "error" || level == "warn" { NSLog("[server %@] %@", level, String(text.prefix(2000))) }
        #endif
    }

    // MARK: - host

    private func makeHost() -> JSValue {
        let host = JSValue(newObjectIn: context)!
        func set(_ object: JSValue, _ name: String, _ block: Any) { object.setObject(block, forKeyedSubscript: name as NSString) }

        set(host, "log", { [unowned self] (level: String, text: String) in self.log(level, text) } as @convention(block) (String, String) -> Void)
        set(host, "post", { [unowned self] (message: JSValue) in self.route(message) } as @convention(block) (JSValue) -> Void)
        set(host, "timer", { [unowned self] (id: Int, ms: Double, repeating: Bool) in self.arm(id, ms, repeating) } as @convention(block) (Int, Double, Bool) -> Void)
        set(host, "clearTimer", { [unowned self] (id: Int) in self.timers.removeValue(forKey: id)?.cancel() } as @convention(block) (Int) -> Void)
        set(host, "now", { ProcessInfo.processInfo.systemUptime * 1000 } as @convention(block) () -> Double)
        set(host, "random", { [unowned self] (length: Int) -> JSValue in
            var data = Data(count: max(0, min(length, 65536)))
            _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
            return self.uint8Array(data)
        } as @convention(block) (Int) -> JSValue)
        set(host, "analyze", { [unowned self] (file: String, _: Double, version: String, done: JSValue, progress: JSValue) -> Int in
            self.analyze(file, version, done)
        } as @convention(block) (String, Double, String, JSValue, JSValue) -> Int)
        set(host, "cancelAnalysis", { [unowned self] (job: Int) in if self.analyses[job] != nil { self.analyses[job] = true } } as @convention(block) (Int) -> Void)

        let fs = JSValue(newObjectIn: context)!
        set(fs, "stat", { [unowned self] (p: String) -> JSValue? in
            guard let path = self.real(p) else { return self.fail("EACCES", p) }
            var st = stat()
            guard stat(path, &st) == 0 else { return JSValue(nullIn: self.context) }
            return self.js(["dir": (st.st_mode & S_IFMT) == S_IFDIR, "size": Double(st.st_size),
                            "mtimeMs": Double(st.st_mtimespec.tv_sec) * 1000 + Double(st.st_mtimespec.tv_nsec) / 1e6])
        } as @convention(block) (String) -> JSValue?)
        set(fs, "readdir", { [unowned self] (p: String) -> JSValue? in
            guard let path = self.real(p) else { return self.fail("EACCES", p) }
            guard let dir = opendir(path) else { return self.fail(Self.code(errno), "scandir '\(p)'") }
            defer { closedir(dir) }
            var out: [[String: Any]] = []
            while let entry = readdir(dir) {
                let name = withUnsafeBytes(of: entry.pointee.d_name) { String(cString: $0.bindMemory(to: CChar.self).baseAddress!) }
                if name == "." || name == ".." { continue }
                var isDir = entry.pointee.d_type == DT_DIR
                if entry.pointee.d_type == DT_UNKNOWN { var st = stat(); isDir = stat(path + "/" + name, &st) == 0 && (st.st_mode & S_IFMT) == S_IFDIR }
                out.append(["name": name, "dir": isDir])
            }
            return self.js(out)
        } as @convention(block) (String) -> JSValue?)
        set(fs, "mkdir", { [unowned self] (p: String, recursive: Bool) -> JSValue? in self.mkdir(p, recursive) } as @convention(block) (String, Bool) -> JSValue?)
        set(fs, "open", { [unowned self] (p: String, flags: String) -> JSValue? in
            guard let path = self.real(p) else { return self.fail("EACCES", p) }
            let mode: [String: Int32] = ["r": O_RDONLY, "rs": O_RDONLY, "r+": O_RDWR, "w": O_WRONLY | O_CREAT | O_TRUNC, "w+": O_RDWR | O_CREAT | O_TRUNC,
                                         "wx": O_WRONLY | O_CREAT | O_EXCL, "w+x": O_RDWR | O_CREAT | O_EXCL, "a": O_WRONLY | O_CREAT, "a+": O_RDWR | O_CREAT, "ax": O_WRONLY | O_CREAT | O_EXCL]
            guard let flag = mode[flags] else { return self.fail("EINVAL", "open flags \(flags)") }
            let fd = Darwin.open(path, flag | O_CLOEXEC, 0o644)
            guard fd >= 0 else { return self.fail(Self.code(errno), "open '\(p)'") }
            var st = stat()
            if fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR { Darwin.close(fd); return self.fail("EISDIR", "open '\(p)'") }
            self.fds.insert(fd)
            return JSValue(int32: fd, in: self.context)
        } as @convention(block) (String, String) -> JSValue?)
        set(fs, "read", { [unowned self] (fd: Int32, length: Int, position: Double) -> JSValue? in
            guard self.fds.contains(fd) else { return self.fail("EBADF", "read") }
            guard length > 0 else { return self.uint8Array(Data()) }
            guard let array = JSObjectMakeTypedArray(self.ctx, kJSTypedArrayTypeUint8Array, length, nil),
                  let target = JSObjectGetTypedArrayBytesPtr(self.ctx, array, nil) else { return self.fail("ENOMEM", "read \(length)") }
            var total = 0
            // No JSC calls while the backing-store pointer is in use.
            while total < length {
                let n = pread(fd, target.advanced(by: total), length - total, off_t(position) + off_t(total))
                if n < 0 { if errno == EINTR { continue }; return self.fail(Self.code(errno), "read") }
                if n == 0 { break }
                total += n
            }
            let value = JSValue(jsValueRef: array, in: self.context)!
            return total == length ? value : value.invokeMethod("subarray", withArguments: [0, total])
        } as @convention(block) (Int32, Int, Double) -> JSValue?)
        set(fs, "write", { [unowned self] (fd: Int32, data: JSValue, position: Double) -> JSValue? in
            guard self.fds.contains(fd) else { return self.fail("EBADF", "write") }
            guard let bytes = self.bytes(data) else { return self.fail("EINVAL", "write: not bytes") }
            let written = bytes.withUnsafeBytes { buffer -> Int in
                var total = 0
                while total < buffer.count {
                    let n = pwrite(fd, buffer.baseAddress!.advanced(by: total), buffer.count - total, off_t(position) + off_t(total))
                    if n < 0 { if errno == EINTR { continue }; return -Int(errno) }
                    total += n
                }
                return total
            }
            return written < 0 ? self.fail(Self.code(Int32(-written)), "write") : JSValue(double: Double(written), in: self.context)
        } as @convention(block) (Int32, JSValue, Double) -> JSValue?)
        set(fs, "size", { [unowned self] (fd: Int32) -> JSValue? in
            var st = stat()
            guard self.fds.contains(fd), fstat(fd, &st) == 0 else { return self.fail("EBADF", "fstat") }
            return JSValue(double: Double(st.st_size), in: self.context)
        } as @convention(block) (Int32) -> JSValue?)
        set(fs, "truncate", { [unowned self] (fd: Int32, length: Double) in
            if !self.fds.contains(fd) || ftruncate(fd, off_t(length)) != 0 { self.fail(Self.code(errno), "ftruncate") }
        } as @convention(block) (Int32, Double) -> Void)
        set(fs, "sync", { [unowned self] (fd: Int32) in if self.fds.contains(fd) { fsync(fd) } } as @convention(block) (Int32) -> Void)
        set(fs, "close", { [unowned self] (fd: Int32) in if self.fds.remove(fd) != nil { Darwin.close(fd) } } as @convention(block) (Int32) -> Void)
        set(fs, "rm", { [unowned self] (p: String, recursive: Bool, force: Bool) in
            guard let path = self.real(p), p != "/" else { self.fail("EBUSY", "rm '\(p)'"); return }
            var st = stat()
            guard lstat(path, &st) == 0 else { if !force { self.fail("ENOENT", "rm '\(p)'") }; return }
            if (st.st_mode & S_IFMT) != S_IFDIR { if unlink(path) != 0 { self.fail(Self.code(errno), "unlink '\(p)'") }; return }
            if !recursive { if rmdir(path) != 0 { self.fail(Self.code(errno), "rmdir '\(p)'") }; return }
            do { try FileManager.default.removeItem(atPath: path) } catch { self.fail("EIO", "rm '\(p)': \(error.localizedDescription)") }
        } as @convention(block) (String, Bool, Bool) -> Void)
        set(fs, "rename", { [unowned self] (a: String, b: String) in
            guard let from = self.real(a), let to = self.real(b) else { self.fail("EACCES", "rename"); return }
            if Darwin.rename(from, to) != 0 { self.fail(Self.code(errno), "rename '\(a)' -> '\(b)'") }
        } as @convention(block) (String, String) -> Void)
        set(fs, "copy", { [unowned self] (a: String, b: String) in
            guard let from = self.real(a), let to = self.real(b) else { self.fail("EACCES", "copyfile"); return }
            if copyfile(from, to, nil, copyfile_flags_t(COPYFILE_DATA)) != 0 { self.fail(Self.code(errno), "copyfile '\(a)' -> '\(b)'") }
        } as @convention(block) (String, String) -> Void)
        set(fs, "utimes", { [unowned self] (p: String, mtimeMs: Double) in
            guard let path = self.real(p) else { return }
            try? FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: mtimeMs / 1000)], ofItemAtPath: path)
        } as @convention(block) (String, Double) -> Void)
        host.setValue(fs, forProperty: "fs")

        let db = JSValue(newObjectIn: context)!
        set(db, "open", { [unowned self] (p: String) -> JSValue? in
            guard let path = self.real(p) else { return self.fail("EACCES", p) }
            do {
                let connection = try SQLiteConnection(path: path)
                let id = self.nextDb; self.nextDb += 1
                self.dbs[id] = connection
                return JSValue(double: Double(id), in: self.context)
            } catch { return self.sqliteFail(error) }
        } as @convention(block) (String) -> JSValue?)
        set(db, "exec", { [unowned self] (h: Int, sql: String) in
            do { try self.connection(h).exec(sql) } catch { self.sqliteFail(error) }
        } as @convention(block) (Int, String) -> Void)
        set(db, "run", { [unowned self] (h: Int, sql: String, params: JSValue) -> JSValue? in
            do {
                let c = try self.connection(h)
                let stmt = try c.statement(sql, bind: { try self.bind($0, params) })
                defer { sqlite3_reset(stmt) }
                while true {
                    let rc = sqlite3_step(stmt)
                    if rc == SQLITE_DONE { break }
                    if rc != SQLITE_ROW { throw c.error(rc) }
                }
                return self.js(["changes": Double(sqlite3_changes(c.handle)), "lastInsertRowid": Double(sqlite3_last_insert_rowid(c.handle))])
            } catch { return self.sqliteFail(error) }
        } as @convention(block) (Int, String, JSValue) -> JSValue?)
        set(db, "get", { [unowned self] (h: Int, sql: String, params: JSValue) -> JSValue? in
            do {
                let c = try self.connection(h)
                let stmt = try c.statement(sql, bind: { try self.bind($0, params) })
                defer { sqlite3_reset(stmt) }
                let rc = sqlite3_step(stmt)
                if rc == SQLITE_DONE { return JSValue(nullIn: self.context) }
                guard rc == SQLITE_ROW else { throw c.error(rc) }
                return self.row(stmt)
            } catch { return self.sqliteFail(error) }
        } as @convention(block) (Int, String, JSValue) -> JSValue?)
        set(db, "all", { [unowned self] (h: Int, sql: String, params: JSValue) -> JSValue? in
            do {
                let c = try self.connection(h)
                let stmt = try c.statement(sql, bind: { try self.bind($0, params) })
                defer { sqlite3_reset(stmt) }
                let rows = JSValue(newArrayIn: self.context)!
                var i = 0
                while true {
                    let rc = sqlite3_step(stmt)
                    if rc == SQLITE_DONE { break }
                    guard rc == SQLITE_ROW else { throw c.error(rc) }
                    rows.setValue(self.row(stmt), at: i); i += 1
                }
                return rows
            } catch { return self.sqliteFail(error) }
        } as @convention(block) (Int, String, JSValue) -> JSValue?)
        set(db, "inTransaction", { [unowned self] (h: Int) -> Bool in
            guard let c = self.dbs[h] else { return false }
            return sqlite3_get_autocommit(c.handle) == 0
        } as @convention(block) (Int) -> Bool)
        set(db, "close", { [unowned self] (h: Int) in self.dbs.removeValue(forKey: h)?.close() } as @convention(block) (Int) -> Void)
        host.setValue(db, forProperty: "db")
        return host
    }

    /// A virtual absolute path ("/data/x") under `root`; nil for anything that could leave it.
    private func real(_ virtual: String) -> String? {
        guard virtual.hasPrefix("/"), !virtual.contains("\0") else { return nil }
        let parts = virtual.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.contains(where: { $0 == ".." || $0 == "." }) else { return nil }
        return parts.isEmpty ? root.path : root.path + "/" + parts.joined(separator: "/")
    }

    private func mkdir(_ p: String, _ recursive: Bool) -> JSValue? {
        guard real(p) != nil else { return fail("EACCES", p) }
        let parts = p.split(separator: "/", omittingEmptySubsequences: true)
        var current = "", first: String?
        for (i, part) in parts.enumerated() {
            current += "/" + part
            let path = root.path + current, last = i == parts.count - 1
            var st = stat()
            if stat(path, &st) == 0 {
                if (st.st_mode & S_IFMT) != S_IFDIR { return fail("ENOTDIR", "mkdir '\(p)'") }
                if last && !recursive { return fail("EEXIST", "mkdir '\(p)'") }
                continue
            }
            if !recursive && !last { return fail("ENOENT", "mkdir '\(p)'") }
            if Darwin.mkdir(path, 0o755) != 0 && errno != EEXIST { return fail(Self.code(errno), "mkdir '\(p)'") }
            first = first ?? current
        }
        return first.map { JSValue(object: $0, in: context) } ?? JSValue(undefinedIn: context)
    }

    private static func code(_ e: Int32) -> String {
        switch e {
        case ENOENT: return "ENOENT"
        case EEXIST: return "EEXIST"
        case ENOTDIR: return "ENOTDIR"
        case EISDIR: return "EISDIR"
        case ENOTEMPTY: return "ENOTEMPTY"
        case EACCES, EPERM: return "EACCES"
        case ENOSPC: return "ENOSPC"
        case EBUSY: return "EBUSY"
        case EBADF: return "EBADF"
        case EINVAL: return "EINVAL"
        case EXDEV: return "EXDEV"
        default: return "EIO"
        }
    }

    // MARK: - SQLite

    private func connection(_ h: Int) throws -> SQLiteConnection {
        guard let c = dbs[h] else { throw SQLiteConnection.Failure(code: SQLITE_MISUSE, message: "database is not open") }
        return c
    }

    @discardableResult private func sqliteFail(_ error: Error) -> JSValue? {
        let failure = error as? SQLiteConnection.Failure
        let message = failure?.message ?? error.localizedDescription
        // node:sqlite's shape: the message is SQLite's own text, which callers match on (UNIQUE constraint failed, …)
        let value = JSValue(newErrorFromMessage: message, in: context)
        value?.setValue("ERR_SQLITE_ERROR", forProperty: "code")
        value?.setValue(Int(failure?.code ?? SQLITE_ERROR), forProperty: "errcode")
        context.exception = value
        return nil
    }

    private func bind(_ stmt: OpaquePointer, _ params: JSValue) throws {
        let count = sqlite3_bind_parameter_count(stmt)
        guard count > 0 else { return }
        let positional = params.isArray
        for i in 1...count {
            let value: JSValue?
            if positional { value = params.atIndex(Int(i) - 1) }
            else if let name = sqlite3_bind_parameter_name(stmt, i) { value = params.forProperty(String(String(cString: name).dropFirst())) }
            else { value = nil }
            let rc: Int32
            if let value, !value.isNull, !value.isUndefined {
                if value.isBoolean { rc = sqlite3_bind_int64(stmt, i, value.toBool() ? 1 : 0) }
                else if value.isNumber {
                    let d = value.toDouble()
                    // sql.js's rule, under which the iPhone library was written: 32-bit integers as INTEGER, the rest as REAL
                    rc = Int32(exactly: d) != nil ? sqlite3_bind_int64(stmt, i, Int64(d)) : sqlite3_bind_double(stmt, i, d)
                } else if let data = bytes(value) {
                    rc = data.withUnsafeBytes { sqlite3_bind_blob(stmt, i, $0.baseAddress, Int32($0.count), SQLiteConnection.transient) }
                } else {
                    // by byte count: a NUL inside the string must not cut it short
                    let text = Array((value.toString() ?? "").utf8)
                    rc = text.withUnsafeBytes { sqlite3_bind_text(stmt, i, $0.baseAddress?.assumingMemoryBound(to: CChar.self) ?? "", Int32($0.count), SQLiteConnection.transient) }
                }
            } else { rc = sqlite3_bind_null(stmt, i) }
            guard rc == SQLITE_OK else { throw SQLiteConnection.Failure(code: rc, message: "bind \(i): \(rc)") }
        }
    }

    private func row(_ stmt: OpaquePointer) -> JSValue {
        let object = JSValue(newObjectIn: context)!
        for i in 0..<sqlite3_column_count(stmt) {
            let name = String(cString: sqlite3_column_name(stmt, i)!)
            let value: JSValue
            switch sqlite3_column_type(stmt, i) {
            case SQLITE_INTEGER: value = JSValue(double: Double(sqlite3_column_int64(stmt, i)), in: context)
            case SQLITE_FLOAT: value = JSValue(double: sqlite3_column_double(stmt, i), in: context)
            case SQLITE_TEXT:
                let n = Int(sqlite3_column_bytes(stmt, i))
                let text = sqlite3_column_text(stmt, i).map { String(decoding: UnsafeBufferPointer(start: $0, count: n), as: UTF8.self) } ?? ""
                value = JSValue(object: text, in: context)
            case SQLITE_BLOB:
                let n = Int(sqlite3_column_bytes(stmt, i))
                value = uint8Array(n > 0 ? Data(bytes: sqlite3_column_blob(stmt, i)!, count: n) : Data())
            default: value = JSValue(nullIn: context)
            }
            object.setValue(value, forProperty: name)
        }
        return object
    }

    // MARK: - timers, messages, native services

    private func arm(_ id: Int, _ ms: Double, _ repeating: Bool) {
        timers.removeValue(forKey: id)?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        // Node's limit; Int(.infinity) would trap (prelude.ts clamps too)
        let interval = DispatchTimeInterval.microseconds(Int((ms.isFinite ? min(max(0, ms), 2_147_483_647) : 0) * 1000))
        timer.schedule(deadline: .now() + interval, repeating: repeating ? (ms > 0 ? interval : .milliseconds(1)) : .never, leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if !repeating { self.timers.removeValue(forKey: id)?.cancel() }
            self.context.objectForKeyedSubscript("__moraTimer")?.call(withArguments: [id])
        }
        timers[id] = timer
        timer.resume()
    }

    private func reply(_ id: Any, _ result: Result<Any, Error>) {
        queue.async {
            switch result {
            case .success(let value): self.send(["t": "rpc-res", "id": id, "ok": true, "value": value])
            case .failure(let error): self.send(["t": "rpc-res", "id": id, "ok": false, "error": error.localizedDescription])
            }
        }
    }

    /// The worker's own posts: rpc calls the page used to serve are answered here, the rest go to the page.
    private func route(_ value: JSValue) {
        guard let message = swift(value) as? [String: Any] else { return }
        switch message["t"] as? String {
        case "rpc":
            let id = message["id"] ?? 0, args = message["args"] as? [String: Any] ?? [:]
            if message["op"] as? String == "fetch" { fetch(id, args) } else { decode(id, args) }
        case "rpc-abort":
            if let id = message["id"] as? Double { requests.removeValue(forKey: Int(id))?.cancel() }
        case "head", "chunk", "end", "fail":
            guard let id = (message["id"] as? NSNumber)?.intValue, open.contains(id) else { return } // owed to a page that is gone
            if message["t"] as? String != "head" && message["t"] as? String != "chunk" { open.remove(id) }
            onMessage?(message)
        case "ready":
            booted = true
            onMessage?(message)
        case "boot-error":
            failBoot(message["error"] as? String ?? "?")
        default:
            onMessage?(message)
        }
    }

    private func fetch(_ id: Any, _ args: [String: Any]) {
        guard let address = args["url"] as? String, let url = URL(string: address), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            reply(id, .failure(URLError(.unsupportedURL))); return
        }
        var request = URLRequest(url: url)
        request.httpMethod = args["method"] as? String ?? "GET"
        for (k, v) in args["headers"] as? [String: Any] ?? [:] { request.setValue("\(v)", forHTTPHeaderField: k) }
        if let body = args["body"] as? String { request.httpBody = Data(body.utf8) }
        else if let body = args["body"] as? Data { request.httpBody = body }
        let key = Int(id as? Double ?? 0)
        let task = session.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            self.queue.async { self.requests.removeValue(forKey: key) }
            if let error { self.reply(id, .failure(error)); return }
            guard let http = response as? HTTPURLResponse else { self.reply(id, .failure(URLError(.badServerResponse))); return }
            var headers: [String: Any] = [:]
            for (k, v) in http.allHeaderFields { headers["\(k)".lowercased()] = "\(v)" }
            self.reply(id, .success(["status": Double(http.statusCode), "url": http.url?.absoluteString ?? address, "headers": headers, "body": data ?? Data()] as [String: Any]))
        }
        requests[key] = task
        task.resume()
    }

    private func decode(_ id: Any, _ args: [String: Any]) {
        guard let bytes = args["bytes"] as? Data, let rate = args["sampleRate"] as? Double, let channels = args["channels"] as? Double else {
            reply(id, .failure(CocoaError(.fileReadCorruptFile))); return
        }
        work.async {
            do {
                let r = try self.services.decode(bytes, rate, Int(channels))
                self.reply(id, .success(["planes": r.planes, "sourceRate": r.sourceRate, "duration": r.duration] as [String: Any]))
            } catch { self.reply(id, .failure(error)) }
        }
    }

    private func analyze(_ file: String, _ version: String, _ done: JSValue) -> Int {
        let job = nextAnalysis; nextAnalysis += 1
        analyses[job] = false
        let finish = { (error: String?, result: Any?) in
            self.queue.async {
                guard self.analyses.removeValue(forKey: job) == false else { return } // cancelled
                done.call(withArguments: [error.map { $0 as Any } ?? NSNull(), self.js(result)])
            }
        }
        guard let path = real(file) else { finish("недопустимый путь", nil); return job }
        guard services.analyzerVersion() == version else { finish("анализатор приложения \(services.analyzerVersion()), сервер ждёт \(version)", nil); return job }
        let cancelled = { [weak self] () -> Bool in self?.queue.sync { self?.analyses[job] != false } ?? true }
        work.async {
            do {
                guard let result = try self.services.analyze(URL(fileURLWithPath: path), cancelled) else { finish("отменено", nil); return }
                finish(nil, result)
            } catch { finish("не удалось проанализировать файл: \(error.localizedDescription)", nil) }
        }
        return job
    }
}

/// One SQLite connection with its statements cached by SQL text, so JS never has to finalize anything.
final class SQLiteConnection {
    struct Failure: Error { let code: Int32; let message: String }
    static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    let handle: OpaquePointer
    private var statements: [String: OpaquePointer] = [:]
    private var order: [String] = []

    init(path: String) throws {
        var db: OpaquePointer?
        let rc = sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX, nil)
        guard rc == SQLITE_OK, let db else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close_v2(db)
            throw Failure(code: rc, message: message)
        }
        handle = db
        sqlite3_busy_timeout(db, 5000)
        sqlite3_extended_result_codes(db, 1)
    }

    func error(_ rc: Int32) -> Failure { Failure(code: rc, message: String(cString: sqlite3_errmsg(handle))) }

    func exec(_ sql: String) throws {
        var message: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(handle, sql, nil, nil, &message)
        defer { sqlite3_free(message) }
        guard rc == SQLITE_OK else { throw Failure(code: rc, message: message.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(handle))) }
    }

    /// A reset statement with fresh bindings.
    func statement(_ sql: String, bind: (OpaquePointer) throws -> Void) throws -> OpaquePointer {
        let stmt: OpaquePointer
        if let cached = statements[sql] {
            stmt = cached
            sqlite3_reset(stmt); sqlite3_clear_bindings(stmt)
        } else {
            var prepared: OpaquePointer?
            let rc = sqlite3_prepare_v2(handle, sql, -1, &prepared, nil)
            guard rc == SQLITE_OK, let prepared else { throw error(rc) }
            stmt = prepared
            statements[sql] = stmt; order.append(sql)
            if order.count > 256, let old = statements.removeValue(forKey: order.removeFirst()) { sqlite3_finalize(old) }
        }
        try bind(stmt)
        return stmt
    }

    func close() {
        for stmt in statements.values { sqlite3_finalize(stmt) }
        statements.removeAll(); order.removeAll()
        sqlite3_close_v2(handle)
    }
}
