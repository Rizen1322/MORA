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


// Check the AVAudioConverter block path used in the app against the previous file path.
let folder = output.deletingLastPathComponent()
let short = folder.appendingPathComponent("check-44100.f32le")
let original = folder.appendingPathComponent("check-48000.f32le")
let converted = folder.appendingPathComponent("check-file.f32le")
let handle = try FileHandle(forReadingFrom: input)
let sample = try handle.read(upToCount: min(frames, 44100 * 16) * 8)!
try handle.close()
try sample.write(to: short)
let inputFrames = try NativePCMDecoder.resample(short, from: 44100, to: original, sampleRate: 48000)
let convertStart = Date()
let fileFrames = try NativePCMDecoder.resample(original, from: 48000, to: converted, sampleRate: 44100)
let fileResult = NativeRustAnalysis.analyze(converted, frames: fileFrames, cancelled: { false })!
let fileMs = Int(Date().timeIntervalSince(convertStart) * 1000)
let streamStart = Date()
var streamedFrames = 0
let streamResult = try NativeRustAnalysis.analyzePCM(expectedFrames: inputFrames) { consume in
    streamedFrames = try NativePCMDecoder.resample(original, from: 48000, sampleRate: 44100, cancelled: { false }, consume: consume)
}!
let streamMs = Int(Date().timeIntervalSince(streamStart) * 1000)
func comparable(_ value: [String: Any]) throws -> Data {
    var copy = value
    copy.removeValue(forKey: "elapsedMs")
    return try JSONSerialization.data(withJSONObject: copy, options: .sortedKeys)
}
precondition(streamedFrames == fileFrames, "The streaming conversion lost PCM frames")
let streamed = try comparable(streamResult), written = try comparable(fileResult)
precondition(streamed == written, "Streaming MIR changed the analysis")
print("Swift resampling → Rust MIR: file \(fileMs) ms, stream \(streamMs) ms, \(fileFrames * 8) temporary bytes avoided")

let request = """
{"from":{"id":"A","duration":120,"mixingAllowed":true},"to":{"id":"B","duration":95,"mixingAllowed":true},"settings":{"enabled":true}}
"""
let planned = NativeRustAnalysis.plan(request).flatMap { value in
    (try? JSONSerialization.jsonObject(with: Data(value.utf8))) as? [String: Any]
}
precondition((planned?["method"] as? String) != nil, "Rust planner bridge returned no transition plan")
precondition(NativeRustAnalysis.plan("{}") == nil, "Rust planner accepted missing tracks")