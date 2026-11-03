import Foundation

let args = CommandLine.arguments
let input = URL(fileURLWithPath: args[1]), output = URL(fileURLWithPath: args[2]), frames = Int(args[3])!
precondition(NativeRustAnalysis.version == args[4], "Rust analyzer version differs from the bundled script")
precondition(NativeRustAnalysis.analyze(input, frames: frames, cancelled: { true }) == nil, "Cancellation was ignored")
precondition(NativeRustAnalysis.analyze(input, frames: frames + 1, cancelled: { false }) == nil, "Short PCM was accepted")
let start = Date()
guard let result = NativeRustAnalysis.analyze(input, frames: frames, cancelled: { false }) else { fatalError("Compiled analysis failed") }
print("Swift → Rust MIR: \(frames / 44100) s audio in \(Int(Date().timeIntervalSince(start) * 1000)) ms")
try JSONSerialization.data(withJSONObject: result).write(to: output)

// In-memory stream (no 44.1 kHz file on iPhone) in uneven blocks: the same analysis.
let pcm = try Data(contentsOf: input)
guard let stream = NativeRustAnalysis.Stream(expectedFrames: frames - 999) else { fatalError("Stream not created") }
pcm.withUnsafeBytes { raw in
    let floats = raw.bindMemory(to: Float.self)
    var at = 0
    while at < frames {
        let n = min(8191, frames - at)
        precondition(stream.push(floats.baseAddress! + at * 2, frames: n), "Stream rejected valid PCM")
        at += n
    }
}
guard var streamed = stream.finish(cancel: false) else { fatalError("Streamed analysis failed") }
var whole = result
streamed.removeValue(forKey: "elapsedMs"); whole.removeValue(forKey: "elapsedMs")
precondition(NSDictionary(dictionary: streamed).isEqual(to: whole), "Streamed analysis differs from the file analysis")
precondition(NativeRustAnalysis.Stream(expectedFrames: 0)!.finish(cancel: true) == nil)
print("Swift → Rust MIR: in-memory stream matches")
