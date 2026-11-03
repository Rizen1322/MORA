import Foundation

/// Two original audible test melodies. Real finite PCM, not a silent keep-alive.
enum NativeProbeWave {
    static let sampleRate = 22050
    static func make(track: Int, seconds: Double = 90) -> Data {
        precondition((0...1).contains(track) && seconds > 0 && seconds <= 90)
        let frames = Int(seconds * Double(sampleRate))
        var data = Data(capacity: 44 + frames * 2)
        func text(_ s: String) { data.append(contentsOf: s.utf8) }
        func u16(_ n: UInt16) { var v = n.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        func u32(_ n: UInt32) { var v = n.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        text("RIFF"); u32(UInt32(36 + frames * 2)); text("WAVEfmt "); u32(16)
        u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        text("data"); u32(UInt32(frames * 2))
        let notes = track == 0 ? [261.63, 329.63, 392.0, 523.25] : [220.0, 293.66, 349.23, 440.0]
        for frame in 0..<frames {
            let t = Double(frame) / Double(sampleRate)
            let phase = t.truncatingRemainder(dividingBy: 0.5)
            let envelope = min(1, phase / 0.012) * min(1, (0.5 - phase) / 0.08)
                * min(1, (seconds - t) / 0.03)
            let hz = notes[Int(t * 2) % notes.count]
            let value = (sin(2 * .pi * hz * t) + 0.25 * sin(4 * .pi * hz * t)) * envelope * 0.16
            u16(UInt16(bitPattern: Int16((value * 32767).rounded())))
        }
        return data
    }
}
