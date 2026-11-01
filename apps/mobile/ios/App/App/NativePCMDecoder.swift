import AudioToolbox
import AVFoundation
import Foundation

/// Preparation continues after screen lock, after the device's first unlock.
enum NativePreparationFiles {
    static var attributes: [FileAttributeKey: Any] {
        #if os(iOS)
        return [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        #else
        return [:]
        #endif
    }
}

/// File conversion on the preparation queue; never called by the audio renderer.
enum NativePCMDecoder {
    enum Failure: Error { case invalid, cancelled, limit }
    static func decode(_ source: URL, to destination: URL, sampleRate: Double,
                       cancelled: @escaping () -> Bool = { false }) throws -> Int {
        let file = try AVAudioFile(forReading: source)
        guard let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 32768) else { throw Failure.invalid }
        return try convert(from: file.processingFormat, to: destination, sampleRate: sampleRate, cancelled: cancelled) { requested in
            if file.framePosition >= file.length { return nil }
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
        guard FileManager.default.createFile(atPath: partial.path, contents: nil, attributes: NativePreparationFiles.attributes) else { throw Failure.invalid }
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
    /// AudioFileStream hint for a download's first bytes (0: let it guess); nil when it needs the
    /// whole file: MP4/M4A (the moov atom may follow the audio) and WebM, like growing-audio.ts.
    static func streamType(_ prefix: Data) -> AudioFileTypeID? {
        let b = [UInt8](prefix.prefix(12))
        guard b.count == 12, !b[4..<8].elementsEqual("ftyp".utf8), !b[0..<4].elementsEqual([0x1A, 0x45, 0xDF, 0xA3]) else { return nil }
        if b[0] == 0xFF && b[1] & 0xF6 == 0xF0 { return kAudioFileAAC_ADTSType } // MPEG sync, layer 0
        if b[0] == 0xFF && b[1] & 0xE0 == 0xE0 || b[0..<3].elementsEqual("ID3".utf8) { return kAudioFileMP3Type }
        return 0
    }
}

/// Decodes a download while it arrives (AudioFileStream + AVAudioConverter) into the growing
/// f32le stereo 48 kHz file the player reads. Bytes arrive on the HTTP queue; `frames` is
/// written and readable. Refused streams leave no file: the caller decodes the finished download.
final class NativeStreamDecoder: @unchecked Sendable {
    private let lock = NSLock()
    private let destination: URL
    private let cancelled: () -> Bool
    private var stream: AudioFileStreamID?
    private var input: AVAudioFormat?
    private var converter: AVAudioConverter?
    private let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: true)!
    private var file: FileHandle?
    private var written = 0, parsed = 0
    private var failed = false, ended = false, refusedStream = false
    init(destination: URL, cancelled: @escaping () -> Bool) { self.destination = destination; self.cancelled = cancelled }
    deinit { if let stream { AudioFileStreamClose(stream) }; try? file?.close() }
    var frames: Int { lock.lock(); defer { lock.unlock() }; return written }
    var receiving: Bool { lock.lock(); defer { lock.unlock() }; return !ended }
    var refused: Bool { lock.lock(); defer { lock.unlock() }; return refusedStream }
    func endInput() { lock.lock(); ended = true; lock.unlock() }
    func feed(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard !refusedStream, !failed, !data.isEmpty else { return }
        if cancelled() { fail(); return }
        if stream == nil {
            guard let type = NativePCMDecoder.streamType(data) else { refusedStream = true; return }
            let client = Unmanaged.passUnretained(self).toOpaque()
            guard AudioFileStreamOpen(client, { client, stream, property, _ in
                guard property == kAudioFileStreamProperty_ReadyToProducePackets else { return }
                let client: UnsafeMutableRawPointer? = client
                if let client { Unmanaged<NativeStreamDecoder>.fromOpaque(client).takeUnretainedValue().ready(stream) }
            }, { client, bytes, count, data, descriptions in
                let client: UnsafeMutableRawPointer? = client
                let descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>? = descriptions
                if let client { Unmanaged<NativeStreamDecoder>.fromOpaque(client).takeUnretainedValue().packets(bytes, count, data, descriptions) }
            }, type, &stream) == noErr else { refusedStream = true; return }
        }
        parsed += data.count
        let status = data.withUnsafeBytes { AudioFileStreamParseBytes(stream!, UInt32($0.count), $0.baseAddress!, []) }
        // No playable format within 1 MB: leave it to the whole-file decoder.
        if status != noErr || (converter == nil && parsed > 1 << 20) { fail() }
    }
    /// Flushes the converter and closes the file; returns the final frame count.
    func finish() throws -> Int {
        lock.lock(); defer { lock.unlock() }
        if let converter, !failed, !refusedStream {
            convert(converter) { status in status.pointee = .endOfStream; return nil }
        }
        guard !failed, !refusedStream, written > 0, let file else { throw NativePCMDecoder.Failure.invalid }
        try file.synchronize(); try file.close(); self.file = nil
        return written
    }
    // Callbacks below run inside AudioFileStreamParseBytes, under the lock.
    private func fail() {
        failed = true
        if written == 0 { refusedStream = true }
    }
    private func ready(_ stream: AudioFileStreamID) {
        var description = AudioStreamBasicDescription(), size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        guard converter == nil, AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_DataFormat, &size, &description) == noErr,
              let format = AVAudioFormat(streamDescription: &description) else { fail(); return }
        var cookieSize: UInt32 = 0
        if AudioFileStreamGetPropertyInfo(stream, kAudioFileStreamProperty_MagicCookieData, &cookieSize, nil) == noErr, cookieSize > 0 {
            var cookie = [UInt8](repeating: 0, count: Int(cookieSize))
            if AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_MagicCookieData, &cookieSize, &cookie) == noErr {
                format.magicCookie = Data(cookie.prefix(Int(cookieSize)))
            }
        }
        guard let converter = AVAudioConverter(from: format, to: output) else { fail(); return }
        input = format; self.converter = converter
    }
    private func packets(_ bytes: UInt32, _ count: UInt32, _ data: UnsafeRawPointer,
                         _ descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
        guard !failed, let converter, let input, bytes > 0 else { return }
        let buffer: AVAudioBuffer
        if input.streamDescription.pointee.mFormatID == kAudioFormatLinearPCM {
            let size = input.streamDescription.pointee.mBytesPerFrame, frames = size > 0 ? bytes / size : 0
            guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: frames),
                  let target = pcm.mutableAudioBufferList.pointee.mBuffers.mData else { fail(); return }
            memcpy(target, data, Int(frames * size)); pcm.frameLength = frames; buffer = pcm
        } else {
            guard let descriptions, count > 0 else { fail(); return }
            let compressed = AVAudioCompressedBuffer(format: input, packetCapacity: count, maximumPacketSize: Int(bytes))
            guard let target = compressed.packetDescriptions else { fail(); return }
            memcpy(compressed.data, data, Int(bytes))
            for i in 0..<Int(count) { target[i] = descriptions[i] }
            compressed.packetCount = count; compressed.byteLength = bytes; buffer = compressed
        }
        var given = false
        convert(converter) { status in
            if given { status.pointee = .noDataNow; return nil }
            given = true; status.pointee = .haveData; return buffer
        }
    }
    private func convert(_ converter: AVAudioConverter, _ next: @escaping (UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer?) {
        guard let out = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: 8192) else { fail(); return }
        while !failed {
            if cancelled() { fail(); return }
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, status in next(status) }
            guard status != .error, error == nil else { fail(); return }
            let count = Int(out.frameLength)
            if count > 0 {
                guard (written + count) * 8 <= 384 * 1024 * 1024, let samples = out.audioBufferList.pointee.mBuffers.mData else { fail(); return }
                let floats = samples.bindMemory(to: Float.self, capacity: count * 2)
                for i in 0..<count * 2 { guard floats[i].isFinite else { fail(); return } }
                do {
                    if file == nil {
                        guard FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: NativePreparationFiles.attributes) else { fail(); return }
                        file = try FileHandle(forWritingTo: destination)
                    }
                    try file?.write(contentsOf: Data(bytes: samples, count: count * 8)); written += count
                } catch { fail(); return }
            }
            if status != .haveData { return }
        }
    }
}
