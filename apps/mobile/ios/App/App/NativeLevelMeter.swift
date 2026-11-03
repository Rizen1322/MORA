import Accelerate
import Foundation

/// 16 band levels + RMS of 2048 mono samples; mirrors `bandLevels` in apps/web/src/audio/desktop-engine.ts.
/// All buffers are allocated once. Confined to one queue (the mix host's `work`).
final class NativeLevelMeter {
    static let n = 2048
    private let half = NativeLevelMeter.n / 2
    private let setup = vDSP_create_fftsetup(11, FFTRadix(kFFTRadix2))!
    private let mono: UnsafeMutablePointer<Float>, windowed: UnsafeMutablePointer<Float>, window: UnsafeMutablePointer<Float>
    private let re: UnsafeMutablePointer<Float>, im: UnsafeMutablePointer<Float>, mag: UnsafeMutablePointer<Float>
    private var edges: [(lo: Int, hi: Int)] = [], edgesRate = 0.0

    init() {
        let n = NativeLevelMeter.n
        mono = .allocate(capacity: n); windowed = .allocate(capacity: n); window = .allocate(capacity: n)
        re = .allocate(capacity: n / 2); im = .allocate(capacity: n / 2); mag = .allocate(capacity: n / 2)
        for i in 0..<n {
            let x = 2 * Double.pi * Double(i) / Double(n)
            window[i] = Float(0.42 - 0.5 * cos(x) + 0.08 * cos(2 * x))
        }
    }
    deinit {
        vDSP_destroy_fftsetup(setup)
        for p in [mono, windowed, window, re, im, mag] { p.deallocate() }
    }

    /// `fill` writes exactly 2048 mono samples (zeros where nothing was played).
    func analyze(sampleRate: Double, fill: (UnsafeMutablePointer<Float>) -> Void) -> (rms: Double, bands: [Double]) {
        let n = NativeLevelMeter.n, len = vDSP_Length(n), h = vDSP_Length(half)
        if edgesRate != sampleRate {
            edgesRate = sampleRate
            edges = (0..<16).map { b in
                (max(1, Int((40 * pow(2, Double(b) / 2) * Double(n) / sampleRate).rounded(.up))),
                 min(half - 1, Int((40 * pow(2, Double(b + 1) / 2) * Double(n) / sampleRate).rounded(.down))))
            }
        }
        fill(mono)
        var meanSquare: Float = 0
        vDSP_measqv(mono, 1, &meanSquare, len)
        vDSP_vmul(mono, 1, window, 1, windowed, 1, len)
        var split = DSPSplitComplex(realp: re, imagp: im)
        windowed.withMemoryRebound(to: DSPComplex.self, capacity: half) { vDSP_ctoz($0, 2, &split, 1, h) }
        vDSP_fft_zrip(setup, &split, 1, 11, FFTDirection(FFT_FORWARD))
        var scale = Float(1) / Float(2 * n), floor: Float = 1e-12, one: Float = 1 // zrip output is 2x the plain DFT
        vDSP_zvabs(&split, 1, mag, 1, h)
        vDSP_vsmul(mag, 1, &scale, mag, 1, h)
        vDSP_vthr(mag, 1, &floor, mag, 1, h)
        vDSP_vdbcon(mag, 1, &one, mag, 1, h, 0)
        let bands = edges.map { e -> Double in
            guard e.hi >= e.lo else { return -120 }
            var sum: Float = 0
            vDSP_sve(mag + e.lo, 1, &sum, vDSP_Length(e.hi - e.lo + 1))
            return Double(sum) / Double(e.hi - e.lo + 1)
        }
        return (Double(meanSquare).squareRoot(), bands)
    }
}
