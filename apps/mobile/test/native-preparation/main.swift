import AVFoundation
import Foundation

let root = FileManager.default.temporaryDirectory.appendingPathComponent("mora-native-preparation-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }
let source = root.appendingPathComponent("source.wav")
try NativeProbeWave.make(track: 0, seconds: 0.5).write(to: source)
let pcm = root.appendingPathComponent("playback.f32le")
let frames = try NativePCMDecoder.decode(source, to: pcm, sampleRate: 48000)
precondition(abs(frames - 24000) <= 1)
let bytes = try Data(contentsOf: pcm)
precondition(bytes.count == frames * 8)
let samples = bytes.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
precondition(samples.allSatisfy { $0.isFinite && abs($0) <= 0.5 })
precondition(samples.contains { abs($0) > 0.01 })
for i in stride(from: 0, to: samples.count, by: 2) { precondition(abs(samples[i] - samples[i + 1]) < 1e-6) }
let analysis = root.appendingPathComponent("analysis.f32le")
let analysisFrames = try NativePCMDecoder.resample(pcm, from: 48000, to: analysis, sampleRate: 44100)
precondition(abs(analysisFrames - 22050) <= 1)
let cancelled = root.appendingPathComponent("cancelled.f32le")
do { _ = try NativePCMDecoder.decode(source, to: cancelled, sampleRate: 48000, cancelled: { true }); fatalError("Cancellation ignored") }
catch NativePCMDecoder.Failure.cancelled {}
precondition(!FileManager.default.fileExists(atPath: cancelled.path))
let remaining = try FileManager.default.contentsOfDirectory(atPath: root.path)
precondition(remaining.allSatisfy { !$0.contains("partial") })
let compressed = root.appendingPathComponent("source.m4a")
do {
    let original = try AVAudioFile(forReading: source)
    let file = try AVAudioFile(forWriting: compressed, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: original.processingFormat.sampleRate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000])
    let buffer = AVAudioPCMBuffer(pcmFormat: original.processingFormat, frameCapacity: 32768)!
    try original.read(into: buffer); try file.write(from: buffer)
}
let aacOutput = root.appendingPathComponent("aac.f32le")
let aacFrames = try NativePCMDecoder.decode(compressed, to: aacOutput, sampleRate: 48000)
precondition(abs(aacFrames - 24000) < 4800) // AAC encoder priming/container trimming varies by OS.
print("Native preparation: WAV decode, stereo conversion, 48k/44.1k duration, finite PCM and atomic cancellation passed")
