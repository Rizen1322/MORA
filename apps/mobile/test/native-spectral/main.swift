import Foundation

// Runs NativeSpectral.compute on a raw little-endian Float32 mono file; check-native-spectral.mjs compares it with TS.
guard CommandLine.arguments.count == 4, let sr = Double(CommandLine.arguments[2]) else { fatalError("Expected <input.f32> <sampleRate> <output.f32>") }
let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let samples = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
let started = DispatchTime.now().uptimeNanoseconds
guard let packed = samples.withUnsafeBufferPointer({ NativeSpectral.compute($0, sampleRate: sr) }) else { fatalError("cancelled") }
let ms = Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6
try packed.withUnsafeBytes { Data($0) }.write(to: URL(fileURLWithPath: CommandLine.arguments[3]))
print(String(format: "%.1f", ms))
