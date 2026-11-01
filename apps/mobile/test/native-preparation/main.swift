import AudioToolbox
import AVFoundation
import Foundation
func stage(_ name: String) { FileHandle.standardError.write(Data((name + "\n").utf8)) }

let root = FileManager.default.temporaryDirectory.appendingPathComponent("mora-native-preparation-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }
let source = root.appendingPathComponent("source.wav")
try NativeProbeWave.make(track: 0, seconds: 0.5).write(to: source)
let pcm = root.appendingPathComponent("playback.f32le")
stage("Decode WAV")
let frames = try NativePCMDecoder.decode(source, to: pcm, sampleRate: 48000)
precondition(abs(frames - 24000) <= 1)
let bytes = try Data(contentsOf: pcm)
precondition(bytes.count == frames * 8)
let samples = bytes.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
precondition(samples.allSatisfy { $0.isFinite && abs($0) <= 0.5 })
precondition(samples.contains { abs($0) > 0.01 })
for i in stride(from: 0, to: samples.count, by: 2) { precondition(abs(samples[i] - samples[i + 1]) < 1e-6) }
let analysis = root.appendingPathComponent("analysis.f32le")
stage("Resample raw PCM")
let analysisFrames = try NativePCMDecoder.resample(pcm, from: 48000, to: analysis, sampleRate: 44100)
precondition(abs(analysisFrames - 22050) <= 1)
let cancelled = root.appendingPathComponent("cancelled.f32le")
stage("Cancel conversion")
do { _ = try NativePCMDecoder.decode(source, to: cancelled, sampleRate: 48000, cancelled: { true }); fatalError("Cancellation ignored") }
catch NativePCMDecoder.Failure.cancelled {}
precondition(!FileManager.default.fileExists(atPath: cancelled.path))
let remaining = try FileManager.default.contentsOfDirectory(atPath: root.path)
precondition(remaining.allSatisfy { !$0.contains("partial") })
let compressed = root.appendingPathComponent("source.m4a")
stage("Encode AAC fixture")
try autoreleasepool {
    let original = try AVAudioFile(forReading: source)
    let file = try AVAudioFile(forWriting: compressed, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: original.processingFormat.sampleRate, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000])
    let buffer = AVAudioPCMBuffer(pcmFormat: original.processingFormat, frameCapacity: 32768)!
    try original.read(into: buffer); try file.write(from: buffer)
}
let aacOutput = root.appendingPathComponent("aac.f32le")
stage("Decode AAC")
let aacFrames = try NativePCMDecoder.decode(compressed, to: aacOutput, sampleRate: 48000)
precondition(abs(aacFrames - 24000) < 4800) // AAC encoder priming/container trimming varies by OS.
stage("Stream decode")
precondition(NativePCMDecoder.streamType(Data([0xFF, 0xF1] + [UInt8](repeating: 0, count: 10))) == kAudioFileAAC_ADTSType)
precondition(NativePCMDecoder.streamType(Data([0xFF, 0xFB] + [UInt8](repeating: 0, count: 10))) == kAudioFileMP3Type)
precondition(NativePCMDecoder.streamType(Data("ID3".utf8) + Data(count: 9)) == kAudioFileMP3Type)
precondition(NativePCMDecoder.streamType(Data([0x1A, 0x45, 0xDF, 0xA3] + [UInt8](repeating: 0, count: 8))) == nil)
precondition(NativePCMDecoder.streamType(Data([1, 2, 3])) == nil)
let streamed = root.appendingPathComponent("streamed.f32le")
let streamer = NativeStreamDecoder(destination: streamed, cancelled: { false })
let wave = try Data(contentsOf: source)
for at in stride(from: 0, to: wave.count, by: 4096) { streamer.feed(wave.subdata(in: at..<min(wave.count, at + 4096))) }
precondition(!streamer.refused && streamer.frames > 0)
let streamedFrames = try streamer.finish()
precondition(abs(streamedFrames - frames) <= 1, "Streamed \(streamedFrames) frames, decoded \(frames)")
let streamedSamples = try Data(contentsOf: streamed).withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
precondition(streamedSamples.count == streamedFrames * 2 && streamedSamples.allSatisfy { $0.isFinite && abs($0) <= 0.5 })
for i in stride(from: 0, to: streamedSamples.count, by: 2) { precondition(abs(streamedSamples[i] - streamedSamples[i + 1]) < 1e-6) }
let m4a = NativeStreamDecoder(destination: root.appendingPathComponent("refused.f32le"), cancelled: { false })
m4a.feed(try Data(contentsOf: compressed))
precondition(m4a.refused && !FileManager.default.fileExists(atPath: root.appendingPathComponent("refused.f32le").path), "MP4 must wait for the whole file")
print("Native preparation: WAV decode, stereo conversion, 48k/44.1k duration, finite PCM and atomic cancellation passed")
print("Native stream decoder: chunked WAV matches the file decoder; MP4/WebM fall back to the whole file")
