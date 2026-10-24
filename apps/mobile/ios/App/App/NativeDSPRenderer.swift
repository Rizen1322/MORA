import Foundation
import JavaScriptCore

struct NativeMixMark {
    var frame: Int64
    let index: Int
    let position: Double
}
struct NativeMixBlock {
    let left: Data
    let right: Data
    let marks: [NativeMixMark]
    let events: [[String: Any]]
    let done: Bool
    var frames: Int { left.count / MemoryLayout<Float>.size }
}

/// Confined to the host's serial producer queue. No JS work on the audio callback.
final class NativeDSPRenderer {
    enum Failure: Error { case invalid(String) }
    private let context: JSContext
    private var runtime: JSValue?
    private var exception: String?
    /// Valid timeline indices; the host updates it together with the queue.
    var trackCount: Int

    init(script: String, folder: URL, config: [String: Any]) throws {
        guard let vm = JSVirtualMachine(), let context = JSContext(virtualMachine: vm) else {
            throw Failure.invalid("JavaScriptCore unavailable")
        }
        self.context = context
        trackCount = (config["tracks"] as? [Any])?.count ?? 0
        context.exceptionHandler = { [weak self] _, value in self?.exception = value?.toString() ?? "JavaScript exception" }
        let reader: @convention(block) (Int32, Int32) -> String = { key, chunk in
            guard key >= 0, chunk >= 0 else { return "" }
            do {
                let file = try FileHandle(forReadingFrom: folder.appendingPathComponent("\(key).f32le"))
                defer { try? file.close() }
                try file.seek(toOffset: UInt64(chunk) * 32768 * 8)
                return try file.read(upToCount: 32768 * 8)?.base64EncodedString() ?? ""
            } catch { return "" }
        }
        context.setObject(reader, forKeyedSubscript: "moraReadPcm" as NSString)
        context.evaluateScript(script)
        try check()
        runtime = context.objectForKeyedSubscript("MoraNativeMixer")?.invokeMethod("create", withArguments: [config])
        try check()
        guard runtime?.isObject == true else { throw Failure.invalid("Missing mixer instance") }
    }
    private func check() throws {
        if let exception { throw Failure.invalid(exception) }
    }
    private func pcm(_ value: JSValue?) throws -> Data {
        var error: JSValueRef?
        guard let value, let object = JSValueToObject(context.jsGlobalContextRef, value.jsValueRef, &error), error == nil else {
            throw Failure.invalid("Invalid PCM object")
        }
        let count = JSObjectGetTypedArrayByteLength(context.jsGlobalContextRef, object, &error)
        guard error == nil, count <= 4096 * 4, count % 4 == 0 else { throw Failure.invalid("Invalid PCM length") }
        guard count > 0 else { return Data() }
        guard let bytes = JSObjectGetTypedArrayBytesPtr(context.jsGlobalContextRef, object, &error), error == nil else {
            throw Failure.invalid("Missing PCM bytes")
        }
        // Copy immediately: the borrowed JSC pointer cannot survive another JS API call.
        return Data(bytes: bytes, count: count)
    }
    func update(from: Int, tracks: [[String: Any]]) throws -> Bool {
        let accepted = runtime?.invokeMethod("update", withArguments: [from, tracks])?.toBool() ?? false
        try check()
        return accepted
    }
    func render() throws -> NativeMixBlock {
        let result = runtime?.invokeMethod("render", withArguments: [])
        try check()
        let left = try pcm(result?.forProperty("left"))
        let right = try pcm(result?.forProperty("right"))
        guard left.count == right.count, let raw = result?.forProperty("marks")?.toArray() as? [[String: Any]] else {
            throw Failure.invalid("Invalid output")
        }
        let marks = try raw.map { mark -> NativeMixMark in
            guard let frame = mark["offset"] as? Int64, let index = mark["index"] as? Int,
                  let position = mark["position"] as? Double, position.isFinite,
                  (0..<trackCount).contains(index), frame >= 0, frame <= left.count / 4 else {
                throw Failure.invalid("Invalid timeline mark")
            }
            return NativeMixMark(frame: frame, index: index, position: position)
        }
        return NativeMixBlock(left: left, right: right, marks: marks,
            events: result?.forProperty("events")?.toArray() as? [[String: Any]] ?? [],
            done: result?.forProperty("done")?.toBool() ?? false)
    }
}
