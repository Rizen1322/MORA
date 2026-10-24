import AVFoundation
import Foundation

/// File conversion on the preparation queue; never called by the audio renderer.
enum NativePCMDecoder {
    enum Failure: Error { case invalid, cancelled, limit }
    static func decode(_ source: URL, to destination: URL, sampleRate: Double,
                       cancelled: @escaping () -> Bool = { false }) throws -> Int {
        let file = try AVAudioFile(forReading: source)
        guard let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 32768) else { throw Failure.invalid }
        return try convert(from: file.processingFormat, to: destination, sampleRate: sampleRate, cancelled: cancelled) { requested in
            try file.read(into: input, frameCount: min(requested, input.frameCapacity))
            return input.frameLength > 0 ? input : nil
        }
    }
    static func resample(_ source: URL, from sourceRate: Double, to destination: URL, sampleRate: Double,
                         cancelled: @escaping () -> Bool = { false }) throws -> Int {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sourceRate, channels: 2, interleaved: true),
              let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 32768) else { throw Failure.invalid }
        let file = try FileHandle(forReadingFrom: source)
        defer { try? file.close() }
        return try convert(from: format, to: destination, sampleRate: sampleRate, cancelled: cancelled) { requested in
            let data = try file.read(upToCount: Int(min(requested, input.frameCapacity)) * 8) ?? Data()
            guard !data.isEmpty else { return nil }
            guard data.count % 8 == 0, let output = input.mutableAudioBufferList.pointee.mBuffers.mData else { throw Failure.invalid }
            data.withUnsafeBytes { if let bytes = $0.baseAddress { memcpy(output, bytes, $0.count) } }
            input.frameLength = AVAudioFrameCount(data.count / 8)
            return input
        }
    }
    private static func convert(from source: AVAudioFormat, to destination: URL, sampleRate: Double,
                                cancelled: @escaping () -> Bool,
                                read: @escaping (AVAudioFrameCount) throws -> AVAudioPCMBuffer?) throws -> Int {
        guard [44100.0, 48000.0].contains(sampleRate), !FileManager.default.fileExists(atPath: destination.path),
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 2, interleaved: true),
              let converter = AVAudioConverter(from: source, to: format),
              let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192) else { throw Failure.invalid }
        let partial = destination.deletingLastPathComponent().appendingPathComponent("\(UUID().uuidString).partial")
        guard FileManager.default.createFile(atPath: partial.path, contents: nil) else { throw Failure.invalid }
        defer { try? FileManager.default.removeItem(at: partial) }
        let file = try FileHandle(forWritingTo: partial)
        defer { try? file.close() }
        var frames = 0, idle = 0
        while true {
            if cancelled() { throw Failure.cancelled }
            var error: NSError?, inputError: Error?
            let result = converter.convert(to: output, error: &error) { requested, status in
                do {
                    if cancelled() { throw Failure.cancelled }
                    guard let input = try read(min(requested, 32768)) else { status.pointee = .endOfStream; return nil }
                    status.pointee = .haveData; return input
                } catch { inputError = error; status.pointee = .noDataNow; return nil }
            }
            if let inputError { throw inputError }
            if let error { throw error }
            guard result != .error else { throw Failure.invalid }
            let count = Int(output.frameLength)
            if count > 0 {
                guard (frames + count) * 8 <= 384 * 1024 * 1024,
                      let data = output.audioBufferList.pointee.mBuffers.mData else { throw Failure.limit }
                let floats = data.bindMemory(to: Float.self, capacity: count * 2)
                for i in 0..<count * 2 { guard floats[i].isFinite else { throw Failure.invalid } }
                try file.write(contentsOf: Data(bytes: data, count: count * 8)); frames += count; idle = 0
            } else { idle += 1 }
            if result == .endOfStream { break }
            guard idle < 8 else { throw Failure.invalid }
        }
        guard frames > 0, !cancelled() else { if cancelled() { throw Failure.cancelled }; throw Failure.invalid }
        try file.synchronize(); try file.close()
        // Never replace a file already used by the native mixer.
        try FileManager.default.moveItem(at: partial, to: destination)
        return frames
    }
}
