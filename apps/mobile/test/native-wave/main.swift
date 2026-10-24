import Foundation

func number(_ data: Data, _ offset: Int, _ bytes: Int) -> UInt32 {
    (0..<bytes).reduce(UInt32(0)) { $0 | UInt32(data[offset + $1]) << UInt32($1 * 8) }
}
let a = NativeProbeWave.make(track: 0, seconds: 0.5)
let b = NativeProbeWave.make(track: 1, seconds: 0.5)
precondition(a.count == 44 + 11025 * 2 && a.count == b.count)
precondition(String(data: a[0..<4], encoding: .ascii) == "RIFF")
precondition(String(data: a[8..<16], encoding: .ascii) == "WAVEfmt ")
precondition(number(a, 4, 4) == a.count - 8)
precondition(number(a, 20, 2) == 1 && number(a, 22, 2) == 1)
precondition(number(a, 24, 4) == 22050 && number(a, 34, 2) == 16)
precondition(number(a, 40, 4) == a.count - 44)
precondition(a != b && a == NativeProbeWave.make(track: 0, seconds: 0.5))
let samples = stride(from: 44, to: a.count, by: 2).map { Int16(bitPattern: UInt16(number(a, $0, 2))) }
precondition(samples.contains { abs(Int($0)) > 1000 })
precondition(samples.allSatisfy { abs(Int($0)) <= 7000 })
print("Native probe WAV: format, length, deterministic distinct audible samples passed")
