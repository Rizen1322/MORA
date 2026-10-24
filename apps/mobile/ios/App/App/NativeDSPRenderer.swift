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

    init(script: String, files: [URL], config: [String: Any]) throws {
        guard let vm = JSVirtualMachine(), let context = JSContext(virtualMachine: vm) else {
            throw Failure.invalid("JavaScriptCore unavailable")
        }
        self.context = context
        context.exceptionHandler = { [weak self] _, value in self?.exception = value?.toString() ?? "JavaScript exception" }
        let reader: @convention(block) (Int32, Int32) -> String = { deck, chunk in
            guard (0..<files.count).contains(Int(deck)), chunk >= 0 else { return "" }
            do {
                let file = try FileHandle(forReadingFrom: files[Int(deck)])
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
                  (0...1).contains(index), frame >= 0, frame <= left.count / 4 else {
                throw Failure.invalid("Invalid timeline mark")
            }
            return NativeMixMark(frame: frame, index: index, position: position)
        }
        return NativeMixBlock(left: left, right: right, marks: marks,
            events: result?.forProperty("events")?.toArray() as? [[String: Any]] ?? [],
            done: result?.forProperty("done")?.toBool() ?? false)
    }
}
