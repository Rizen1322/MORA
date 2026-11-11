import AVFoundation
import Capacitor
import Foundation

/// The app's NativeServer: where its files live, the native services it uses, and the one-time move
/// of the library out of the WebView's storage (OPFS), which the page performs through serverImport.
enum NativeServerApp {
    private static let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    static let root = support.appendingPathComponent("server", isDirectory: true)
    private static let staging = support.appendingPathComponent("server-import", isDirectory: true)
    /// Written last when an import completed; until then the library is still the WebView worker's.
    private static var marker: URL { root.appendingPathComponent(".imported") }
    /// Written at the server's first `ready`. Before it, the imported copy has served nothing, so a server
    /// that cannot start may be abandoned and the worker go on with OPFS; after it, OPFS is stale.
    private static var bootedMarker: URL { root.appendingPathComponent(".booted") }
    static var ready: Bool { FileManager.default.fileExists(atPath: marker.path) }
    static var booted: Bool { FileManager.default.fileExists(atPath: bootedMarker.path) }
    private(set) static var shared: NativeServer?

    static func start(onMessage: @escaping ([String: Any]) -> Void) throws {
        let handler: ([String: Any]) -> Void = { message in
            if message["t"] as? String == "ready", !booted { FileManager.default.createFile(atPath: bootedMarker.path, contents: nil) }
            onMessage(message)
        }
        if let shared { shared.attach(handler); return }
        guard ready else { throw CocoaError(.fileNoSuchFile) }
        guard let url = Bundle.main.url(forResource: "server-jsc", withExtension: "js", subdirectory: "public") else { throw CocoaError(.fileReadNoSuchFile) }
        let server = NativeServer(root: root, script: try String(contentsOf: url, encoding: .utf8), services: services)
        server.attach(handler)
        shared = server
        server.start()
    }

    /// A server that never reached `ready`: drop its copy so the worker keeps the (still current) OPFS library.
    static func abandon() throws {
        guard !booted else { throw CocoaError(.fileWriteNoPermission) }
        shared = nil // its JSContext stays idle in memory until the app restarts
        if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
    }

    static func importReset() throws {
        if FileManager.default.fileExists(atPath: staging.path) { try FileManager.default.removeItem(at: staging) }
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true, attributes: NativePreparationFiles.attributes)
    }

    /// One piece of an OPFS file, at its server path ("/data/automix.sqlite").
    static func importChunk(path: String, offset: Int, data: Data) throws {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard path.hasPrefix("/"), !parts.isEmpty, !parts.contains(where: { $0 == ".." || $0 == "." }), offset >= 0 else { throw CocoaError(.fileWriteInvalidFileName) }
        let file = staging.appendingPathComponent(parts.joined(separator: "/"))
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if offset == 0 { guard FileManager.default.createFile(atPath: file.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) } }
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        try handle.write(contentsOf: data)
    }

    /// Makes the imported copy the server's library in one rename. The OPFS original is left as it was.
    static func importDone() throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: root.path) { try fm.removeItem(at: root) } // an earlier unfinished copy, never a used library: `ready` was false
        try fm.moveItem(at: staging, to: root)
        guard fm.createFile(atPath: marker.path, contents: Data(ISO8601DateFormatter().string(from: Date()).utf8)) else { throw CocoaError(.fileWriteUnknown) }
    }

    private static let services = NativeServer.Services(
        decode: { bytes, sampleRate, channels in
            let temp = FileManager.default.temporaryDirectory
            let source = temp.appendingPathComponent("\(UUID().uuidString).\(audioExtension(bytes))")
            let pcm = temp.appendingPathComponent("\(UUID().uuidString).f32")
            defer { try? FileManager.default.removeItem(at: source); try? FileManager.default.removeItem(at: pcm) }
            try bytes.write(to: source)
            let file = try AVAudioFile(forReading: source)
            let sourceRate = file.processingFormat.sampleRate
            let frames = try NativePCMDecoder.decode(source, to: pcm, sampleRate: sampleRate)
            let interleaved = try Data(contentsOf: pcm)
            var left = [Float](repeating: 0, count: frames), right = [Float](repeating: 0, count: frames)
            interleaved.withUnsafeBytes { raw in
                let samples = raw.bindMemory(to: Float.self)
                for i in 0..<min(frames, samples.count / 2) { left[i] = samples[2 * i]; right[i] = samples[2 * i + 1] }
            }
            // WebAudio's down-mix into one channel: the mean of left and right
            let planes = channels == 1 ? [zip(left, right).map { ($0 + $1) / 2 }] : [left, right]
            return (planes.map { $0.withUnsafeBufferPointer { Data(buffer: $0) } }, sourceRate, Double(file.length) / sourceRate)
        },
        analyzerVersion: { NativeRustAnalysis.version },
        analyze: { file, cancelled in
            let pcm = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).mir-44100")
            defer { try? FileManager.default.removeItem(at: pcm) }
            let frames = try NativePCMDecoder.decode(file, to: pcm, sampleRate: 44100, cancelled: cancelled)
            return NativeRustAnalysis.analyze(pcm, frames: frames, cancelled: cancelled)
        })

    /// AVAudioFile picks its parser by extension; the worker hands over bare bytes.
    private static func audioExtension(_ data: Data) -> String {
        let b = [UInt8](data.prefix(12))
        func at(_ i: Int, _ s: String) -> Bool { b.count >= i + s.utf8.count && Array(b[i..<(i + s.utf8.count)]) == Array(s.utf8) }
        if at(4, "ftyp") { return "m4a" }
        if at(0, "fLaC") { return "flac" }
        if at(0, "RIFF") { return "wav" }
        if at(0, "FORM") { return "aiff" }
        if at(0, "ID3") { return "mp3" }
        if b.count >= 2, b[0] == 0xFF, b[1] & 0xF6 == 0xF0 { return "aac" } // ADTS
        return "mp3"
    }
}

/// Page ⇄ NativeServer. Binary parts travel as {"$b64": …}: Capacitor messages are JSON.
extension MoraAudioPlugin {
    static func encode(_ value: Any) -> Any {
        switch value {
        case let data as Data: return ["$b64": data.base64EncodedString()]
        case let list as [Any]: return list.map(encode)
        case let map as [String: Any]: return map.mapValues(encode)
        default: return value
        }
    }
    static func decode(_ value: Any) -> Any {
        switch value {
        case let map as [String: Any]:
            if map.count == 1, let b64 = map["$b64"] as? String { return Data(base64Encoded: b64) ?? Data() }
            return map.mapValues(decode)
        case let list as [Any]: return list.map(decode)
        default: return value
        }
    }

    @objc func serverStatus(_ call: CAPPluginCall) { call.resolve(["ready": NativeServerApp.ready, "booted": NativeServerApp.booted]) }
    @objc func serverAbandon(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do { try NativeServerApp.abandon(); call.resolve() } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func serverImportReset(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            do { try NativeServerApp.importReset(); call.resolve() } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func serverImport(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), let offset = call.getInt("offset"), let b64 = call.getString("data"),
              let data = Data(base64Encoded: b64) else { call.reject("Неверный фрагмент"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            do { try NativeServerApp.importChunk(path: path, offset: offset, data: data); call.resolve() } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func serverImportDone(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            do { try NativeServerApp.importDone(); call.resolve() } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func serverStart(_ call: CAPPluginCall) {
        do {
            try NativeServerApp.start { [weak self] message in
                let data = Self.encode(message) as? [String: Any] ?? [:]
                DispatchQueue.main.async { self?.notifyListeners("server", data: data) }
            }
            call.resolve()
        } catch { call.reject(error.localizedDescription) }
    }
    @objc func serverSend(_ call: CAPPluginCall) {
        guard let message = call.getObject("message"), let server = NativeServerApp.shared else { call.reject("Сервер не запущен"); return }
        server.send(Self.decode(message) as? [String: Any] ?? [:])
        call.resolve()
    }
}
