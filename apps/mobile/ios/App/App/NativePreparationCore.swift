import Foundation
import JavaScriptCore

/// Analysis/planning only. The real-time mixer and its producer remain Swift.
final class NativePreparationCore {
    private let context: JSContext
    private var api: JSValue!
    private var file: FileHandle?
    private var ticket: NativePreparationTicket?
    private var exception: String?
    private var progress: ((String) -> Void)?
    var analyzerVersion: String { api.forProperty("analyzerVersion")?.toString() ?? "" }
    enum Failure: Error { case script, analysis }
    init(script: String) throws {
        guard let vm = JSVirtualMachine(), let context = JSContext(virtualMachine: vm) else { throw Failure.script }
        self.context = context
        context.exceptionHandler = { [weak self] _, value in self?.exception = value?.toString() ?? "script" }
        let read: @convention(block) (Int32, Int32) -> String = { [weak self] offset, frames in
            guard let self, let file = self.file, self.ticket?.cancelled == false, offset >= 0, frames > 0, frames <= 32768 else { return "" }
            return autoreleasepool {
                do { try file.seek(toOffset: UInt64(offset) * 8); return try file.read(upToCount: Int(frames) * 8)?.base64EncodedString() ?? "" }
                catch { return "" }
            }
        }
        let cancelled: @convention(block) () -> Bool = { [weak self] in self?.ticket?.cancelled ?? true }
        context.setObject(read, forKeyedSubscript: "moraPreparationRead" as NSString)
        context.setObject(cancelled, forKeyedSubscript: "moraPreparationCancelled" as NSString)
        let report: @convention(block) (String) -> Void = { [weak self] stage in self?.progress?(stage) }
        context.setObject(report, forKeyedSubscript: "moraPreparationProgress" as NSString)
        context.evaluateScript(script)
        guard exception == nil else { throw Failure.script }
        api = context.objectForKeyedSubscript("MoraPreparation")
    }
    func analyze(_ source: URL, frames: Int, ticket: NativePreparationTicket, progress: ((String) -> Void)? = nil) throws -> [String: Any] {
        self.ticket = ticket; self.file = try FileHandle(forReadingFrom: source)
        self.progress = progress
        defer { try? file?.close(); file = nil; self.ticket = nil; self.progress = nil }
        return try call("analyzeJSON", ["frames": frames])
    }
    func plan(a: [String: Any], b: [String: Any], settings: [String: Any], sampleRate: Double) throws -> [String: Any] {
        func track(_ value: [String: Any]) -> [String: Any] {
            ["id": value["id"] ?? "", "duration": value["duration"] ?? 0,
             "mixingAllowed": value["mixingAllowed"] ?? false, "analysis": value["analysis"] ?? NSNull()]
        }
        // No source recipe, bearer token, address or headers may reach planner debug data.
        return try call("planJSON", ["a": track(a), "b": track(b), "settings": settings, "sampleRate": sampleRate])
    }
    private func call(_ name: String, _ input: [String: Any]) throws -> [String: Any] {
        try autoreleasepool {
        exception = nil
        let data = try JSONSerialization.data(withJSONObject: input)
        guard let argument = String(data: data, encoding: .utf8),
              let result = api.invokeMethod(name, withArguments: [argument])?.toString(), exception == nil,
              let bytes = result.data(using: .utf8), let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw Failure.analysis // Do not export script exceptions, source paths or addresses.
        }
        return object
        }
    }
}
