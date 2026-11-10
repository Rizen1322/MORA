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
