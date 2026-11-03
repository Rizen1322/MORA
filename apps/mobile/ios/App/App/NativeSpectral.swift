import Accelerate
import Foundation

/// Whole-track STFT stage of core/mir/spectral.ts (computeSpectral) on vDSP; the TS code is the numerical reference.
/// Packed in SpectralData field order: fluxLow, fluxMid, fluxHigh, powLow, powMid, powHigh, centroid, midDensity,
/// chroma, mel, rmsDb, peaks. Float32 stores and float32 accumulators match the TS typed arrays.
enum NativeSpectral {
    static let frame = 2048, hop = 256, chromaFrame = 4096, chromaEvery = 4, melBands = 24, curveRate = 20.0

    /// nil only when cancelled.
    static func compute(_ x: UnsafeBufferPointer<Float>, sampleRate sr: Double, cancelled: () -> Bool = { false }) -> [Float]? {
        let n = x.count, nBins = frame / 2 + 1, winSum = Double(frame / 2)
        let frames = max(1, n >= frame ? (n - frame) / hop + 1 : 0)
        let chromaFrames = (frames + chromaEvery - 1) / chromaEvery
        let nCurve = Int((Double(n) * curveRate / sr).rounded(.up))
        func hann(_ size: Int) -> [Double] { (0..<size).map { 0.5 - 0.5 * cos(2 * Double.pi * Double($0) / Double(size)) } }
        let win = hann(frame), cwin = hann(chromaFrame)
        let binHz = sr / Double(frame)
        func bin(_ hz: Double) -> Int { min(nBins - 1, max(1, Int((hz / binHz).rounded()))) }
        let bLow0 = bin(30), bLow1 = bin(150), bMid1 = bin(2500), bHigh1 = bin(10000), bD0 = bin(250), bD1 = bin(4000)
        func toMel(_ hz: Double) -> Double { 2595 * log10(1 + hz / 700) }
        let melLo = toMel(40), melStep = (toMel(8000) - melLo) / Double(melBands + 1)
        var melBand = [Int](repeating: -2, count: nBins), melFrac = [Float](repeating: 0, count: nBins)
        for k in 1..<nBins {
            let pos = (toMel(Double(k) * binHz) - melLo) / melStep
            if pos < 0 || pos >= Double(melBands + 1) { continue }
            melBand[k] = Int(pos.rounded(.down)); melFrac[k] = Float(pos - pos.rounded(.down))
        }
        let cBinHz = sr / Double(chromaFrame)
        let cMin = Int((110 / cBinHz).rounded(.up)), cMax = Int((3520 / cBinHz).rounded(.down))
        var pcOf = [Int](repeating: 0, count: cMax + 1), pcW = [Float](repeating: 0, count: cMax + 1)
        for k in max(0, cMin)...cMax {
            let midi = 69 + 12 * log2(Double(k) * cBinHz / 440), r = midi.rounded()
            pcOf[k] = ((Int(r) % 12) + 12) % 12; pcW[k] = Float(max(0, 1 - 2 * abs(midi - r)))
        }

        var out = [Float](repeating: 0, count: frames * (8 + melBands) + chromaFrames * 12 + nCurve * 2)
        let fluxLow = 0, fluxMid = frames, fluxHigh = 2 * frames, powLow = 3 * frames, powMid = 4 * frames, powHigh = 5 * frames
        let centroid = 6 * frames, midDensity = 7 * frames, chroma = 8 * frames, mel = chroma + chromaFrames * 12
        let rmsDb = mel + frames * melBands, peaks = rmsDb + nCurve

        guard let setup = vDSP_create_fftsetupD(12, FFTRadix(kFFTRadix2)) else { return nil }
        defer { vDSP_destroy_fftsetupD(setup) }
        var re = [Double](repeating: 0, count: frame), im = [Double](repeating: 0, count: frame)
        var cre = [Double](repeating: 0, count: chromaFrame), cim = [Double](repeating: 0, count: chromaFrame)
        var prev = [Double](repeating: 0, count: nBins), cur = [Double](repeating: 0, count: nBins)
        var cmag = [Double](repeating: 0, count: chromaFrame / 2 + 1)
        func forward(_ re: inout [Double], _ im: inout [Double], log2n: vDSP_Length) {
            re.withUnsafeMutableBufferPointer { r in
                im.withUnsafeMutableBufferPointer { i in
                    var split = DSPDoubleSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
                    vDSP_fft_zipD(setup, &split, 1, log2n, FFTDirection(kFFTDirection_Forward)) // Unscaled, sign -1, like fft.ts.
                }
            }
        }
        for f in 0..<frames {
            if f % 256 == 0 && cancelled() { return nil }
            let off = f * hop
            for i in 0..<frame { re[i] = (off + i < n ? Double(x[off + i]) : 0) * win[i]; im[i] = 0 }
            forward(&re, &im, log2n: 11)
            var pL = 0.0, pM = 0.0, pH = 0.0, num = 0.0, den = 0.0, fL = 0.0, fM = 0.0, fH = 0.0, dSum = 0.0, dLog = 0.0, total = 0.0
            for k in 1..<nBins {
                let mag = (re[k] * re[k] + im[k] * im[k]).squareRoot() / winSum
                let p = mag * mag
                total += p
                let c = log1p(100 * mag)
                cur[k] = c
                let d = c - prev[k]
                if k >= bLow0 && k < bLow1 { pL += p; if d > 0 { fL += d } }
                else if k >= bLow1 && k < bMid1 { pM += p; if d > 0 { fM += d } }
                else if k >= bMid1 && k < bHigh1 { pH += p; if d > 0 { fH += d } }
                if k >= bD0 && k < bD1 { dSum += p; dLog += log(p + 1e-14) }
                num += Double(k) * binHz * p
                den += p
                let mb = melBand[k], at = mel + f * melBands
                if mb >= 1 { out[at + mb - 1] = Float(Double(out[at + mb - 1]) + p * (1 - Double(melFrac[k]))) }
                if mb >= 0 && mb < melBands { out[at + mb] = Float(Double(out[at + mb]) + p * Double(melFrac[k])) }
            }
            swap(&prev, &cur)
            out[fluxLow + f] = Float(fL); out[fluxMid + f] = Float(fM / 4); out[fluxHigh + f] = Float(fH / 8)
            out[powLow + f] = Float(pL); out[powMid + f] = Float(pM); out[powHigh + f] = Float(pH)
            out[centroid + f] = Float(den > 0 ? num / den : 0)
            let nD = Double(bD1 - bD0)
            let flat = dSum > 0 ? exp(dLog / nD) / (dSum / nD) : 1
            let share = total > 0 ? dSum / total : 0
            out[midDensity + f] = Float(total > 1e-9 ? min(1, (1 - pow(flat, 0.25)) * min(1, share * 1.6)) : 0)

            guard f % chromaEvery == 0 else { continue }
            let coff = off + frame / 2 - chromaFrame / 2
            for i in 0..<chromaFrame {
                let idx = coff + i
                cre[i] = (idx >= 0 && idx < n ? Double(x[idx]) : 0) * cwin[i]; cim[i] = 0
            }
            forward(&cre, &cim, log2n: 12)
            let row = chroma + f / chromaEvery * 12
            for k in 1...cMax { cmag[k] = (cre[k] * cre[k] + cim[k] * cim[k]).squareRoot() }
            for k in cMin...cMax {
                let mag = cmag[k], k3 = Int((Double(k) / 3).rounded()), k5 = Int((Double(k) / 5).rounded())
                // Same overtone suppression as spectral.ts: 3rd/5th harmonics of a lower note.
                let h3 = max(cmag[k3], cmag[k3 + 1], cmag[k3 - 1]), h5 = max(cmag[k5], cmag[k5 + 1])
                var w = 1.0
                if h3 > mag * 0.6 { w *= 0.25 }
                if h5 > mag * 0.6 { w *= 0.5 }
                let at = row + pcOf[k]
                out[at] = Float(Double(out[at]) + log1p(10 * mag) * Double(pcW[k]) * w)
            }
        }
        for c in 0..<nCurve {
            let a = Int((Double(c) * sr / curveRate).rounded(.down)), b = min(n, Int((Double(c + 1) * sr / curveRate).rounded(.down)))
            var s = 0.0, pk: Float = 0
            if a < b { for i in a..<b { let v = Double(x[i]); s += v * v; pk = max(pk, abs(x[i])) } }
            out[rmsDb + c] = Float(10 * log10(s / Double(max(1, b - a)) + 1e-12)); out[peaks + c] = pk
        }
        return out
    }
}
