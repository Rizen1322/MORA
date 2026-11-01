import Foundation
import JavaScriptCore

/// Analysis/planning only. The real-time mixer and its producer remain Swift.
final class NativePreparationCore {
    private let context: JSContext
    private var api: JSValue!
    private var transforms: [Int: NativeAnalysisFFT] = [:]
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
        let read: @convention(block) (Int32, Int32) -> JSValue? = { [weak self] offset, frames in
            guard let self, let file = self.file, self.ticket?.cancelled == false, offset >= 0, frames > 0, frames <= 32768 else { return nil }
            return autoreleasepool {
                do {
                    try file.seek(toOffset: UInt64(offset) * 8)
                    guard let data = try file.read(upToCount: Int(frames) * 8), data.count == Int(frames) * 8,
                          let array = JSObjectMakeTypedArray(self.context.jsGlobalContextRef, kJSTypedArrayTypeFloat32Array, Int(frames) * 2, nil),
                          let value = JSValue(jsValueRef: array, in: self.context),
                          let target = JSObjectGetTypedArrayBytesPtr(self.context.jsGlobalContextRef, array, nil) else { return nil }
                    // No JSC calls while the temporary backing-store pointer is in use.
                    data.withUnsafeBytes { bytes in if let source = bytes.baseAddress { memcpy(target, source, data.count) } }
                    return value
                } catch { return nil }
            }
        }
        let cancelled: @convention(block) () -> Bool = { [weak self] in self?.ticket?.cancelled ?? true }
        context.setObject(read, forKeyedSubscript: "moraPreparationRead" as NSString)
        context.setObject(cancelled, forKeyedSubscript: "moraPreparationCancelled" as NSString)
        let report: @convention(block) (String) -> Void = { [weak self] stage in self?.progress?(stage) }
        context.setObject(report, forKeyedSubscript: "moraPreparationProgress" as NSString)
        let fft: @convention(block) (JSValue, JSValue) -> Bool = { [weak self] real, imaginary in
            guard let self else { return false }
            let ctx = self.context.jsGlobalContextRef
            func read(_ value: JSValue) -> [Double]? {
                guard JSValueGetTypedArrayType(ctx, value.jsValueRef, nil) == kJSTypedArrayTypeFloat64Array,
                      let object = JSValueToObject(ctx, value.jsValueRef, nil) else { return nil }
                let count = JSObjectGetTypedArrayLength(ctx, object, nil)
                guard count >= 2, count <= 262144, count & (count - 1) == 0,
                      let pointer = JSObjectGetTypedArrayBytesPtr(ctx, object, nil) else { return nil }
                return Array(UnsafeBufferPointer(start: pointer.assumingMemoryBound(to: Double.self), count: count))
            }
            guard var re = read(real), var im = read(imaginary), re.count == im.count else { return false }
            let n = re.count, plan = self.transforms[re.count] ?? NativeAnalysisFFT(re.count)
            self.transforms[n] = plan; plan.forward(&re, &im)
            func write(_ value: JSValue, _ data: [Double]) -> Bool {
                guard let object = JSValueToObject(ctx, value.jsValueRef, nil),
                      let pointer = JSObjectGetTypedArrayBytesPtr(ctx, object, nil) else { return false }
                data.withUnsafeBytes { if let source = $0.baseAddress { memcpy(pointer, source, $0.count) } }; return true
            }
            return write(real, re) && write(imaginary, im)
        }
        context.setObject(fft, forKeyedSubscript: "moraPreparationFFT" as NSString)
        let decimate: @convention(block) (JSValue, Int32, JSValue, JSValue, Int32, Int32) -> JSValue? = { [weak self] input, length, coefficients, history, position, phase in
            guard let self, length >= 0, length <= 65536, position >= 0, position < 31, phase == 0 || phase == 1 else { return nil }
            let ctx = self.context.jsGlobalContextRef, count = Int(length)
            func doubles(_ value: JSValue, count: Int) -> [Double]? {
                guard JSValueGetTypedArrayType(ctx, value.jsValueRef, nil) == kJSTypedArrayTypeFloat64Array,
                      let object = JSValueToObject(ctx, value.jsValueRef, nil), JSObjectGetTypedArrayLength(ctx, object, nil) == count,
                      let pointer = JSObjectGetTypedArrayBytesPtr(ctx, object, nil) else { return nil }
                return Array(UnsafeBufferPointer(start: pointer.assumingMemoryBound(to: Double.self), count: count))
            }
            guard JSValueGetTypedArrayType(ctx, input.jsValueRef, nil) == kJSTypedArrayTypeFloat32Array,
                  let inputObject = JSValueToObject(ctx, input.jsValueRef, nil), JSObjectGetTypedArrayLength(ctx, inputObject, nil) >= count,
                  let taps = doubles(coefficients, count: 31), var buffer = doubles(history, count: 62),
                  taps.allSatisfy({ $0.isFinite }), buffer.allSatisfy({ $0.isFinite }) else { return nil }
            let samples: [Float]
            if count == 0 { samples = [] }
            else {
                guard let pointer = JSObjectGetTypedArrayBytesPtr(ctx, inputObject, nil) else { return nil }
                samples = Array(UnsafeBufferPointer(start: pointer.assumingMemoryBound(to: Float.self), count: count))
            }
            guard samples.allSatisfy({ $0.isFinite }) else { return nil }
            var pos = Int(position), parity = Int(phase), output: [Double] = []
            output.reserveCapacity((count + parity) / 2)
            for sample in samples {
                buffer[pos] = Double(sample); buffer[pos + 31] = Double(sample)
                pos = pos + 1 == 31 ? 0 : pos + 1; parity ^= 1
                if parity == 0 {
                    var value = 0.0
                    for k in 0..<31 { value += taps[k] * buffer[pos + k] }
                    output.append(value)
                }
            }
            guard let array = JSObjectMakeTypedArray(ctx, kJSTypedArrayTypeFloat64Array, output.count, nil),
                  let values = JSValue(jsValueRef: array, in: self.context), let result = JSValue(newObjectIn: self.context) else { return nil }
            if !output.isEmpty {
                guard let pointer = JSObjectGetTypedArrayBytesPtr(ctx, array, nil) else { return nil }
                output.withUnsafeBytes { if let source = $0.baseAddress { memcpy(pointer, source, $0.count) } }
            }
            result.setValue(values, forProperty: "output"); result.setValue(pos, forProperty: "pos"); result.setValue(parity, forProperty: "phase")
            guard let object = JSValueToObject(ctx, history.jsValueRef, nil), let pointer = JSObjectGetTypedArrayBytesPtr(ctx, object, nil) else { return nil }
            buffer.withUnsafeBytes { if let source = $0.baseAddress { memcpy(pointer, source, $0.count) } }
            return result
        }
        context.setObject(decimate, forKeyedSubscript: "moraPreparationDecimate" as NSString)
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

/// Same radix-2 transform as core/dsp/fft.ts, computed outside the JS interpreter.
private final class NativeAnalysisFFT {
    let n: Int, reverse: [Int], cosine: [Double], sine: [Double]
    init(_ n: Int) {
        self.n = n
        let bits = Int(log2(Double(n)))
        reverse = (0..<n).map { i in
            var r = 0
            for b in 0..<bits { r |= ((i >> b) & 1) << (bits - 1 - b) }; return r
        }
        cosine = (0..<(n / 2)).map { cos(-2 * .pi * Double($0) / Double(n)) }
        sine = (0..<(n / 2)).map { sin(-2 * .pi * Double($0) / Double(n)) }
    }
    func forward(_ re: inout [Double], _ im: inout [Double]) {
        for i in 0..<n { let j = reverse[i]; if j > i { re.swapAt(i, j); im.swapAt(i, j) } }
        var size = 2
        while size <= n {
            let half = size / 2, step = n / size
            for start in stride(from: 0, to: n, by: size) {
                for k in 0..<half {
                    let wr = cosine[k * step], wi = sine[k * step], a = start + k, b = a + half
                    let xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr
                    re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi
                }
            }
            size *= 2
        }
    }
}
