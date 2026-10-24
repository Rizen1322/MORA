import Foundation

// Swift port of packages/core/src/engine/mixer.ts and its DSP (dsp/*.ts), compiled for the
// iPhone's real-time producer. Scalars are Double and buffers Float, exactly like JavaScript
// numbers and Float32Array, so the Node reference and this port render the same samples
// (checked by apps/mobile/scripts/check-native-dsp.mjs). iOS has no separated vocal stems:
// the vocal mask, vocal throw and stem fitting of the TypeScript mixer are not ported, and
// plans that use them are never armed natively.

// MARK: - Buffers and JavaScript numerics

/// Fixed-size buffer without bounds checks (a Float32Array / Float64Array).
final class Buf<T> {
    let p: UnsafeMutablePointer<T>
    let count: Int
    init(_ count: Int, _ value: T) {
        self.count = count
        p = .allocate(capacity: max(1, count))
        p.initialize(repeating: value, count: max(1, count))
    }
    deinit { p.deallocate() }
    @inline(__always) subscript(i: Int) -> T {
        get { p[i] }
        set { p[i] = newValue }
    }
    func fill(_ value: T, _ from: Int = 0, _ to: Int? = nil) {
        let end = to ?? count
        if end > from { (p + from).update(repeating: value, count: end - from) }
    }
}
typealias FBuf = Buf<Float>
typealias DBuf = Buf<Double>

/// Math.round: the nearest integer, ties towards +infinity.
@inline(__always) func jsRound(_ x: Double) -> Double {
    let f = x.rounded(.down)
    return x - f >= 0.5 ? f + 1 : f
}
@inline(__always) func jsRoundInt(_ x: Double) -> Int { Int(jsRound(x)) }
@inline(__always) func fround(_ x: Double) -> Double { Double(Float(x)) }

// MARK: - PCM sources

protocol PcmSource: AnyObject {
    var totalFrames: Int { get }
    /// Copies frames [start, start + len) into L/R at offset; frames outside the track are zeros.
    func read(_ start: Int, _ len: Int, _ L: FBuf, _ R: FBuf, _ offset: Int) -> Bool
}

/// Whole track in memory (parity fixtures).
final class ArraySource: PcmSource {
    let L: [Float], R: [Float]
    var totalFrames: Int { L.count }
    init(_ L: [Float], _ R: [Float]) { self.L = L; self.R = R }
    func read(_ start: Int, _ len: Int, _ outL: FBuf, _ outR: FBuf, _ offset: Int) -> Bool {
        for i in 0..<len {
            let p = start + i
            if p < 0 || p >= L.count { outL[offset + i] = 0; outR[offset + i] = 0 }
            else { outL[offset + i] = L[p]; outR[offset + i] = R[p] }
        }
        return true
    }
}

/// Memory-mapped interleaved 32-bit float stereo file written by the page.
final class FileSource: PcmSource {
    private let data: NSData
    private let samples: UnsafePointer<Float>
    let totalFrames: Int
    init(url: URL) throws {
        data = try NSData(contentsOf: url, options: .alwaysMapped)
        guard data.length > 0, data.length % 8 == 0 else { throw NativeRenderError.invalid("Invalid PCM file") }
        samples = data.bytes.assumingMemoryBound(to: Float.self)
        totalFrames = data.length / 8
    }
    func read(_ start: Int, _ len: Int, _ outL: FBuf, _ outR: FBuf, _ offset: Int) -> Bool {
        for i in 0..<len {
            let p = start + i
            if p < 0 || p >= totalFrames { outL[offset + i] = 0; outR[offset + i] = 0 }
            else { outL[offset + i] = samples[p * 2]; outR[offset + i] = samples[p * 2 + 1] }
        }
        return true
    }
}

/// Silent placeholder of an unloaded deck.
final class EmptySource: PcmSource {
    var totalFrames: Int { 0 }
    func read(_ start: Int, _ len: Int, _ L: FBuf, _ R: FBuf, _ offset: Int) -> Bool {
        L.fill(0, offset, offset + len); R.fill(0, offset, offset + len); return true
    }
}

/// The deck's current track; load() replaces it under the stretcher and loop source.
final class DeckSource: PcmSource {
    var inner: PcmSource = EmptySource()
    var totalFrames: Int { inner.totalFrames }
    func read(_ start: Int, _ len: Int, _ L: FBuf, _ R: FBuf, _ offset: Int) -> Bool { inner.read(start, len, L, R, offset) }
}

// MARK: - Biquads (dsp/biquad.ts)

struct BiquadCoefs { var b0, b1, b2, a1, a2: Double }
private func norm(_ b0: Double, _ b1: Double, _ b2: Double, _ a0: Double, _ a1: Double, _ a2: Double) -> BiquadCoefs {
    BiquadCoefs(b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0)
}
func lowpass(_ fs: Double, _ f0: Double, _ q: Double) -> BiquadCoefs {
    let w = (2 * Double.pi * f0) / fs, c = cos(w), alpha = sin(w) / (2 * q)
    return norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha)
}
func highpass(_ fs: Double, _ f0: Double, _ q: Double) -> BiquadCoefs {
    let w = (2 * Double.pi * f0) / fs, c = cos(w), alpha = sin(w) / (2 * q)
    return norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha)
}
func allpass(_ fs: Double, _ f0: Double, _ q: Double) -> BiquadCoefs {
    let w = (2 * Double.pi * f0) / fs, c = cos(w), alpha = sin(w) / (2 * q)
    return norm(1 - alpha, -2 * c, 1 + alpha, 1 + alpha, -2 * c, 1 - alpha)
}
func peaking(_ fs: Double, _ f0: Double, _ gainDb: Double, _ q: Double) -> BiquadCoefs {
    let A = pow(10, gainDb / 40), w = (2 * Double.pi * f0) / fs, c = cos(w), alpha = sin(w) / (2 * q)
    return norm(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A)
}
func magnitude(_ c: BiquadCoefs, _ fs: Double, _ f: Double) -> Double {
    let w = (2 * Double.pi * f) / fs
    let cr = cos(w), ci = -sin(w), c2r = cos(2 * w), c2i = -sin(2 * w)
    let nr = c.b0 + c.b1 * cr + c.b2 * c2r, ni = c.b1 * ci + c.b2 * c2i
    let dr = 1 + c.a1 * cr + c.a2 * c2r, di = c.a1 * ci + c.a2 * c2i
    return sqrt((nr * nr + ni * ni) / (dr * dr + di * di))
}
let BUTTERWORTH_Q = 0.5.squareRoot()

final class Biquad {
    private var z1 = 0.0, z2 = 0.0
    let c: BiquadCoefs
    init(_ c: BiquadCoefs) { self.c = c }
    @inline(__always) func process(_ x: Double) -> Double {
        let y = c.b0 * x + z1
        z1 = c.b1 * x - c.a1 * y + z2
        z2 = c.b2 * x - c.a2 * y
        return y
    }
    func reset() { z1 = 0; z2 = 0 }
}

// MARK: - Three-band isolator (dsp/crossover.ts)

private final class ChannelSplitter {
    private let lp1a, lp1b, hp1a, hp1b, lp2a, lp2b, hp2a, hp2b, ap2, uni1, uni2: Biquad
    init(_ fs: Double, _ f1: Double, _ f2: Double) {
        let q = BUTTERWORTH_Q
        lp1a = Biquad(lowpass(fs, f1, q)); lp1b = Biquad(lowpass(fs, f1, q))
        hp1a = Biquad(highpass(fs, f1, q)); hp1b = Biquad(highpass(fs, f1, q))
        lp2a = Biquad(lowpass(fs, f2, q)); lp2b = Biquad(lowpass(fs, f2, q))
        hp2a = Biquad(highpass(fs, f2, q)); hp2b = Biquad(highpass(fs, f2, q))
        ap2 = Biquad(allpass(fs, f2, q)); uni1 = Biquad(allpass(fs, f1, q)); uni2 = Biquad(allpass(fs, f2, q))
    }
    @inline(__always) func process(_ x: Double, _ gl: Double, _ gm: Double, _ gh: Double) -> Double {
        let low = ap2.process(lp1b.process(lp1a.process(x)))
        let rest = hp1b.process(hp1a.process(x))
        let mid = lp2b.process(lp2a.process(rest))
        let high = hp2b.process(hp2a.process(rest))
        return gl * low + gm * mid + gh * high
    }
    @inline(__always) func processUnity(_ x: Double) -> Double { uni2.process(uni1.process(x)) }
    func reset() { for b in [lp1a, lp1b, hp1a, hp1b, lp2a, lp2b, hp2a, hp2b, ap2, uni1, uni2] { b.reset() } }
}

final class StereoIsolator {
    private let l: ChannelSplitter, r: ChannelSplitter
    var idle = false
    private let warmFrames: Double
    private var fullWarm = Double.infinity, uniWarm = Double.infinity
    init(_ fs: Double) {
        l = ChannelSplitter(fs, 180, 2500); r = ChannelSplitter(fs, 180, 2500)
        warmFrames = jsRound(fs * 0.05)
    }
    func processBlock(_ L: FBuf, _ R: FBuf, _ start: Int, _ end: Int, _ from: (Double, Double, Double), _ to: (Double, Double, Double)) {
        let n = end - start
        if n <= 0 { return }
        let unity = from.0 == 1 && from.1 == 1 && from.2 == 1 && to.0 == 1 && to.1 == 1 && to.2 == 1
        let fullReady = fullWarm >= warmFrames, uniReady = uniWarm >= warmFrames
        let useUni = unity && uniReady && (idle || !fullReady)
        let runFull = !useUni || (!idle && !fullReady)
        let runUni = useUni || (unity && idle && !uniReady)
        fullWarm = runFull ? fullWarm + Double(n) : 0
        uniWarm = runUni ? uniWarm + Double(n) : 0
        if !runFull {
            for i in start..<end { L[i] = Float(l.processUnity(Double(L[i]))); R[i] = Float(r.processUnity(Double(R[i]))) }
            return
        }
        if runUni {
            for i in start..<end {
                let xl = Double(L[i]), xr = Double(R[i])
                let ul = l.processUnity(xl), ur = r.processUnity(xr)
                let fl = l.process(xl, 1, 1, 1), fr = r.process(xr, 1, 1, 1)
                L[i] = Float(useUni ? ul : fl); R[i] = Float(useUni ? ur : fr)
            }
            return
        }
        let dn = Double(n)
        let dl = (to.0 - from.0) / dn, dm = (to.1 - from.1) / dn, dh = (to.2 - from.2) / dn
        var gl = from.0, gm = from.1, gh = from.2
        for i in start..<end {
            L[i] = Float(l.process(Double(L[i]), gl, gm, gh))
            R[i] = Float(r.process(Double(R[i]), gl, gm, gh))
            gl += dl; gm += dm; gh += dh
        }
    }
    func reset() { l.reset(); r.reset(); fullWarm = .infinity; uniWarm = .infinity }
}

// MARK: - DJ filter (dsp/sweep.ts)

final class StereoSweep {
    private var value = 0.0, l1 = 0.0, l2 = 0.0, r1 = 0.0, r2 = 0.0
    private var mode = 1.0, control = 0.0, a1 = 1.0, a2 = 0.0, a3 = 0.0
    private let smoothing: Double, sampleRate: Double
    init(_ sampleRate: Double) { self.sampleRate = sampleRate; smoothing = 1 - exp(-1 / (sampleRate * 0.02)) }
    func reset() { value = 0; l1 = 0; l2 = 0; r1 = 0; r2 = 0; control = 0; mode = 1 }
    func processBlock(_ L: FBuf, _ R: FBuf, _ n: Int, _ rawFrom: Double, _ rawTo: Double) {
        let from = rawFrom.isFinite ? max(-1, min(1, rawFrom)) : 0
        let to = rawTo.isFinite ? max(-1, min(1, rawTo)) : 0
        if from == 0 && to == 0 && abs(value) < 1e-6 { reset(); return }
        let step = (to - from) / Double(max(1, n)), k = 2.0.squareRoot()
        var target = from
        for i in 0..<n {
            value += (target - value) * smoothing
            let amount = abs(value), m: Double = value < 0 ? -1 : 1
            if m != mode { mode = m; l1 = 0; l2 = 0; r1 = 0; r2 = 0; control = 0 }
            let due = control <= 0
            control -= 1
            if due {
                let upper = sampleRate * 0.45
                let cutoff = m > 0 ? 20 * exp(log(min(6000, upper) / 20) * amount) : upper * exp(log(180 / upper) * amount)
                let g = tan(Double.pi * cutoff / sampleRate)
                a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2; control = 15
            }
            let xL = Double(L[i]), xR = Double(R[i])
            let vL = xL - l2, vR = xR - r2
            let bL = a1 * l1 + a2 * vL, bR = a1 * r1 + a2 * vR
            let lowL = l2 + a2 * l1 + a3 * vL, lowR = r2 + a2 * r1 + a3 * vR
            l1 = 2 * bL - l1; r1 = 2 * bR - r1
            l2 = 2 * lowL - l2; r2 = 2 * lowR - r2
            let wet = min(1, amount / 0.08)
            let filteredL = m > 0 ? xL - k * bL - lowL : lowL
            let filteredR = m > 0 ? xR - k * bR - lowR : lowR
            L[i] = Float(xL + (filteredL - xL) * wet); R[i] = Float(xR + (filteredR - xR) * wet)
            target += step
        }
    }
}

// MARK: - Room (dsp/reverb.ts)

private final class Comb {
    private let data: FBuf
    private var index = 0, low = 0.0
    init(_ length: Double) { data = FBuf(max(1, jsRoundInt(length)), 0) }
    @inline(__always) func step(_ input: Double) -> Double {
        let value = Double(data[index])
        low += (value - low) * 0.32
        data[index] = Float(input + low * 0.72)
        index += 1
        if index == data.count { index = 0 }
        return value
    }
    func reset() { data.fill(0); index = 0; low = 0 }
}

final class MasterReverb {
    private let left: [Comb], right: [Comb]
    private var mix = 0.0, target = 0.0, clean = true
    private let glide: Double
    init(_ sampleRate: Double) {
        left = [0.0297, 0.0371, 0.0411, 0.0437].map { Comb($0 * sampleRate) }
        right = [0.0302, 0.0383, 0.0403, 0.0451].map { Comb($0 * sampleRate) }
        glide = 1 - exp(-1 / (0.025 * sampleRate))
    }
    func setMix(_ value: Double) { target = value.isFinite ? max(0, min(0.35, value)) : 0 }
    func reset() { for c in left { c.reset() }; for c in right { c.reset() }; clean = true }
    func process(_ L: FBuf, _ R: FBuf, _ n: Int) {
        if target == 0 && mix < 1e-5 { mix = 0; if !clean { reset() }; return }
        clean = false
        for i in 0..<n {
            mix += (target - mix) * glide
            let l = Double(L[i]), r = Double(R[i])
            var wetL = 0.0, wetR = 0.0
            for c in 0..<4 {
                wetL += left[c].step(l * 0.85 + r * 0.15)
                wetR += right[c].step(r * 0.85 + l * 0.15)
            }
            L[i] = Float(l * (1 - mix) + wetL * 0.07 * mix)
            R[i] = Float(r * (1 - mix) + wetR * 0.07 * mix)
        }
    }
}

// MARK: - True-peak limiter (dsp/limiter.ts)

private let TP_TAPS = 24, TP_DELAY = 12, FOLD = 12
private let TRUE_PEAK_MARGIN = pow(10, 0.05 / 20)
private func besselI0(_ x: Double) -> Double {
    var sum = 1.0, term = 1.0
    for k in 1..<30 { let q = x / Double(2 * k); term *= q * q; sum += term }
    return sum
}
private let TRUE_PEAK_KERNEL: [[Double]] = [1.0, 2.0, 3.0].map { k in
    var h = [Double](repeating: 0, count: TP_TAPS), sum = 0.0
    for j in 0..<TP_TAPS {
        let d = Double(TP_DELAY - j) - k / 4
        let u = d / (Double(TP_DELAY) + 0.25)
        let sinc = d == 0 ? 1 : sin(Double.pi * d) / (Double.pi * d)
        h[j] = sinc * besselI0(6 * (1 - u * u).squareRoot())
        sum += h[j]
    }
    for j in 0..<TP_TAPS { h[j] /= sum }
    return h
}
private let FOLD_P = (0..<FOLD).map { (TRUE_PEAK_KERNEL[0][$0] + TRUE_PEAK_KERNEL[0][TP_TAPS - 1 - $0]) / 2 }
private let FOLD_M = (0..<FOLD).map { (TRUE_PEAK_KERNEL[0][$0] - TRUE_PEAK_KERNEL[0][TP_TAPS - 1 - $0]) / 2 }
private let FOLD_H = (0..<FOLD).map { (TRUE_PEAK_KERNEL[1][$0] + TRUE_PEAK_KERNEL[1][TP_TAPS - 1 - $0]) / 2 }
@inline(__always) private func crest(_ a: Double, _ b: Double, _ c: Double) -> Double {
    let ab = abs(b), d = a - 2 * b + c
    if ab < abs(a) || ab < abs(c) || b * d >= 0 { return ab }
    return abs(b - ((a - c) * (a - c)) / (8 * d))
}

final class Limiter {
    let lookahead: Int
    private let histL = FBuf(48, 0), histR = FBuf(48, 0)
    private var histPos = 0
    private var prevSeg = 0.0, prevCL = 0.0, prevCR = 0.0
    private let delayL: FBuf, delayR: FBuf
    private let win: Int, half: Int
    private let envRing: FBuf, ma1Ring: FBuf
    private var envPos = 0, ma1Pos = 0, pos = 0
    private var ma1Sum: Double, envSum: Double, env = 1.0
    private let relCoef: Double, threshold: Double
    private let dq: DBuf, dqVal: FBuf
    private var dqHead = 0, dqTail = 0, counter = 0
    private let foldP = DBuf(12, 0), foldM = DBuf(12, 0), foldH = DBuf(12, 0)
    init(_ sampleRate: Double, threshold: Double = pow(10, -1.0 / 20), lookaheadMs: Double = 5, releaseMs: Double = 120) {
        self.threshold = threshold
        let L = max(2, jsRoundInt((sampleRate * lookaheadMs) / 1000))
        lookahead = L + TP_DELAY
        delayL = FBuf(lookahead, 0); delayR = FBuf(lookahead, 0)
        win = L
        half = max(1, L / 2)
        envRing = FBuf(half, 1); envSum = Double(half)
        ma1Ring = FBuf(L - half, 1); ma1Sum = Double(L - half)
        relCoef = 1 - exp(-1 / ((sampleRate * releaseMs) / 1000))
        dq = DBuf(L + 2, 0); dqVal = FBuf(L + 2, 0)
        for j in 0..<FOLD { foldP[j] = FOLD_P[j]; foldM[j] = FOLD_M[j]; foldH[j] = FOLD_H[j] }
    }
    func processBlock(_ L: FBuf, _ R: FBuf, _ start: Int, _ end: Int) {
        let la = lookahead, dqN = dq.count, n2 = ma1Ring.count
        for i in start..<end {
            let xl = L[i], xr = R[i]
            let tp = histPos == 0 ? TP_TAPS - 1 : histPos - 1
            histPos = tp
            histL[tp] = xl; histL[tp + TP_TAPS] = xl
            histR[tp] = xr; histR[tp + TP_TAPS] = xr
            var pl = 0.0, ml = 0.0, bl = 0.0, pr = 0.0, mr = 0.0, br = 0.0
            var q = tp + TP_TAPS - 1
            for j in 0..<FOLD {
                let ul = Double(histL[tp + j]), wl = Double(histL[q]), ur = Double(histR[tp + j]), wr = Double(histR[q])
                let sl = ul + wl, sr = ur + wr
                pl += foldP[j] * sl
                ml += foldM[j] * (ul - wl)
                bl += foldH[j] * sl
                pr += foldP[j] * sr
                mr += foldM[j] * (ur - wr)
                br += foldH[j] * sr
                q -= 1
            }
            let al = pl + ml, cl = pl - ml, ar = pr + mr, cr = pr - mr
            let sl = Double(histL[tp + TP_DELAY]), sr = Double(histR[tp + TP_DELAY])
            let nl = Double(histL[tp + TP_DELAY - 1]), nr = Double(histR[tp + TP_DELAY - 1])
            let seg = max(crest(prevCL, sl, al), crest(sl, al, bl), crest(al, bl, cl), crest(bl, cl, nl),
                          crest(prevCR, sr, ar), crest(sr, ar, br), crest(ar, br, cr), crest(br, cr, nr))
            prevCL = cl; prevCR = cr
            let peak = max(seg, prevSeg) * TRUE_PEAK_MARGIN
            prevSeg = seg
            let req = peak > threshold ? threshold / peak : 1
            let c = counter
            counter += 1
            var tail = dqTail, head = dqHead
            while tail != head {
                let last = tail == 0 ? dqN - 1 : tail - 1
                if Double(dqVal[last]) >= req { tail = last } else { break }
            }
            dq[tail] = Double(c)
            dqVal[tail] = Float(req)
            dqTail = tail + 1 == dqN ? 0 : tail + 1
            while dq[head] < Double(c - win) { head = head + 1 == dqN ? 0 : head + 1 }
            dqHead = head
            let minReq = Double(dqVal[head])
            if minReq < env { env = minReq } else { env += (minReq - env) * relCoef }
            let p = pos
            let hp = envPos
            let e = fround(env)
            envSum += e - Double(envRing[hp])
            envRing[hp] = Float(e)
            envPos = hp + 1 == half ? 0 : hp + 1
            let m1 = fround(min(1, envSum / Double(half)))
            let qp = ma1Pos
            ma1Sum += m1 - Double(ma1Ring[qp])
            ma1Ring[qp] = Float(m1)
            ma1Pos = qp + 1 == n2 ? 0 : qp + 1
            if p == 0 {
                var a = 0.0
                for k in 0..<half { a += Double(envRing[k]) }
                envSum = a
                var b = 0.0
                for k in 0..<n2 { b += Double(ma1Ring[k]) }
                ma1Sum = b
            }
            let g = min(1, ma1Sum / Double(n2))
            let dl = Double(delayL[p]), dr = Double(delayR[p])
            delayL[p] = xl; delayR[p] = xr
            pos = p + 1 == la ? 0 : p + 1
            L[i] = Float(dl * g); R[i] = Float(dr * g)
        }
    }
    func reset() {
        delayL.fill(0); delayR.fill(0); histL.fill(0); histR.fill(0)
        histPos = 0; prevSeg = 0; prevCL = 0; prevCR = 0
        envRing.fill(1); envSum = Double(half); envPos = 0
        ma1Ring.fill(1); ma1Sum = Double(ma1Ring.count); ma1Pos = 0
        env = 1; dqHead = 0; dqTail = 0; counter = 0; pos = 0
    }
}

// MARK: - Listener tone (dsp/tone.ts)

let EQ_BANDS: [Double] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
private let EQ_Q = 2.0.squareRoot()

struct ToneSettings {
    var enabled = false
    var gains = [Double](repeating: 0, count: 10)
    var preampDb = 0.0
    var autoHeadroom = true
    var balance = 0.0
    var mono = false
    var reverbMix = 0.0
    /** sanitizeTone(): anything from the page becomes valid settings. */
    init(_ raw: [String: Any]?) {
        let r = raw ?? [:]
        func clamp(_ v: Any?, _ lo: Double, _ hi: Double, _ d: Double) -> Double {
            guard let x = v as? Double, x.isFinite else { return d }
            return min(hi, max(lo, x))
        }
        enabled = r["enabled"] as? Bool == true
        let g = r["gains"] as? [Any] ?? []
        gains = (0..<10).map { jsRound(clamp($0 < g.count ? g[$0] : nil, -12, 12, 0) * 10) / 10 }
        preampDb = clamp(r["preampDb"], -12, 6, 0)
        autoHeadroom = r["autoHeadroom"] as? Bool != false
        balance = clamp(r["balance"], -1, 1, 0)
        mono = r["mono"] as? Bool == true
        reverbMix = clamp(r["reverbMix"], 0, 0.35, 0)
    }
}
@inline(__always) private func usableBand(_ f: Double, _ fs: Double) -> Bool { f < 0.45 * fs }
private func eqPeakDb(_ gains: [Double], _ fs: Double) -> Double {
    let cs = EQ_BANDS.indices.compactMap { i in usableBand(EQ_BANDS[i], fs) && abs(gains[i]) > 0.01 ? peaking(fs, EQ_BANDS[i], gains[i], EQ_Q) : nil }
    if cs.isEmpty { return 0 }
    var best = 0.0
    for k in 0...480 {
        let f = 20 * pow(min(20000, 0.45 * fs) / 20, Double(k) / 480)
        var m = 1.0
        for c in cs { m *= magnitude(c, fs, f) }
        best = max(best, 20 * log10(m))
    }
    return best
}
private func preampFor(_ s: ToneSettings, _ fs: Double) -> Double { s.preampDb - (s.autoHeadroom ? eqPeakDb(s.gains, fs) : 0) }

final class MasterTone {
    private var target = ToneSettings(nil)
    private var cur = [Double](repeating: 0, count: 10)
    private var c = [BiquadCoefs?](repeating: nil, count: 10)
    private var z = [[Double]](repeating: [0, 0, 0, 0], count: 10)
    private var pre = 1.0, preTarget = 1.0, bal = 0.0, mono = 0.0
    private var idle = true
    private let fs: Double
    init(_ fs: Double) { self.fs = fs }
    func set(_ s: ToneSettings, _ preDb: Double?) {
        target = s
        let p = preDb.map { $0.isFinite ? max(-36, min(6, $0)) : preampFor(s, fs) } ?? preampFor(s, fs)
        preTarget = s.enabled ? pow(10, p / 20) : 1
        idle = false
    }
    private func step() {
        let on = target.enabled
        var moving = false
        for b in 0..<10 {
            let goal = on ? target.gains[b] : 0
            let d = goal - cur[b]
            if abs(d) < 1e-6 { continue }
            moving = true
            cur[b] += max(-0.5, min(0.5, d))
            let was = c[b]
            c[b] = usableBand(EQ_BANDS[b], fs) && abs(cur[b]) > 0.01 ? peaking(fs, EQ_BANDS[b], cur[b], EQ_Q) : nil
            if was == nil && c[b] != nil { z[b] = [0, 0, 0, 0] }
        }
        let balGoal = on ? target.balance : 0, monoGoal: Double = on && target.mono ? 1 : 0
        if bal != balGoal || mono != monoGoal || pre != preTarget { moving = true }
        if !moving && !on { idle = true }
    }
    func process(_ L: FBuf, _ R: FBuf, _ n: Int) {
        if idle { return }
        var s = 0
        while s < n {
            step()
            let e = min(n, s + 64)
            for b in 0..<10 {
                guard let k = c[b] else { continue }
                var z1 = z[b][0], z2 = z[b][1], y1 = z[b][2], y2 = z[b][3]
                for i in s..<e {
                    let xl = Double(L[i])
                    let yl = k.b0 * xl + z1
                    z1 = k.b1 * xl - k.a1 * yl + z2
                    z2 = k.b2 * xl - k.a2 * yl
                    L[i] = Float(yl)
                    let xr = Double(R[i])
                    let yr = k.b0 * xr + y1
                    y1 = k.b1 * xr - k.a1 * yr + y2
                    y2 = k.b2 * xr - k.a2 * yr
                    R[i] = Float(yr)
                }
                z[b] = [z1, z2, y1, y2]
            }
            let on = target.enabled, span = Double(e - s)
            let preStep = (preTarget - pre) / span
            let balGoal = on ? target.balance : 0, monoGoal: Double = on && target.mono ? 1 : 0
            let balStep = max(-0.02, min(0.02, balGoal - bal)) / span
            let monoStep = max(-0.02, min(0.02, monoGoal - mono)) / span
            var p = pre, b = bal, m = mono
            for i in s..<e {
                p += preStep; b += balStep; m += monoStep
                let l = Double(L[i]) * p, r = Double(R[i]) * p
                let mid = (l + r) * 0.5
                let ml = l + (mid - l) * m, mr = r + (mid - r) * m
                L[i] = Float(ml * min(1, 1 - b))
                R[i] = Float(mr * min(1, 1 + b))
            }
            pre = abs(preTarget - p) < 1e-6 ? preTarget : p
            bal = abs(balGoal - b) < 1e-6 ? balGoal : b
            mono = abs(monoGoal - m) < 1e-6 ? monoGoal : m
            s += 64
        }
    }
    func reset() { z = [[Double]](repeating: [0, 0, 0, 0], count: 10) }
}

// MARK: - WSOLA time stretcher (dsp/wsola.ts)

final class Wsola {
    let W: Int, H: Int, tol: Int
    private let sampleRate: Double
    private let source: PcmSource
    private let win: DBuf
    private let accL: FBuf, accR: FBuf, fifoL: FBuf, fifoR: FBuf, frameL: FBuf, frameR: FBuf
    private let searchL: FBuf, searchR: FBuf, natL: FBuf, natR: FBuf, boxL: FBuf, boxR: FBuf, natBoxL: FBuf, natBoxR: FBuf
    private var fifoRead = 0, fifoLen = 0, fifoStart = 0
    private var prevStart: Int?
    private var nominal = 0.0
    private let D: Int, norm: Double, C: Int, near: Int
    private(set) var lastOffset = 0
    init(_ sampleRate: Double, _ source: PcmSource, windowMs: Double = 40, overlap: Int = 2, toleranceMs: Double = 12) {
        self.sampleRate = sampleRate
        self.source = source
        var w = jsRoundInt((sampleRate * windowMs) / 1000)
        w = Int((Double(w) / Double(2 * overlap)).rounded(.up)) * 2 * overlap
        W = w; H = w / overlap
        norm = 2 / Double(overlap)
        C = min(W - H, H * 2)
        tol = jsRoundInt((sampleRate * toleranceMs) / 1000)
        near = jsRoundInt(sampleRate * 0.006)
        win = DBuf(W, 0)
        for i in 0..<W { win[i] = 0.5 - 0.5 * cos((2 * Double.pi * Double(i)) / Double(W)) }
        accL = FBuf(W, 0); accR = FBuf(W, 0); fifoL = FBuf(H, 0); fifoR = FBuf(H, 0)
        frameL = FBuf(W, 0); frameR = FBuf(W, 0)
        let sLen = C + 2 * tol + 2
        searchL = FBuf(sLen, 0); searchR = FBuf(sLen, 0)
        natL = FBuf(C, 0); natR = FBuf(C, 0)
        D = max(2, jsRoundInt(sampleRate / 11025))
        boxL = FBuf(Int((Double(sLen) / Double(D)).rounded(.up)) + 1, 0); boxR = FBuf(boxL.count, 0)
        natBoxL = FBuf(Int((Double(C) / Double(D)).rounded(.up)) + 1, 0); natBoxR = FBuf(natBoxL.count, 0)
    }
    func reset(_ position: Double) {
        accL.fill(0); accR.fill(0)
        fifoRead = 0; fifoLen = 0; prevStart = nil
        nominal = position
        fifoStart = jsRoundInt(position)
        lastOffset = 0
    }
    func position() -> Double {
        if fifoLen > fifoRead { return Double(fifoStart + fifoRead) }
        if let prevStart { return Double(prevStart + H) }
        return nominal
    }
    func render(_ outL: FBuf, _ outR: FBuf, _ offset: Int, _ n: Int, _ ratioAt: (Int) -> Double) -> Int {
        var produced = 0
        while produced < n {
            if fifoRead >= fifoLen { if !hop(ratioAt(produced)) { break } }
            let take = min(n - produced, fifoLen - fifoRead)
            for i in 0..<take {
                outL[offset + produced + i] = fifoL[fifoRead + i]
                outR[offset + produced + i] = fifoR[fifoRead + i]
            }
            fifoRead += take
            produced += take
        }
        return produced
    }
    private func hop(_ ratio: Double) -> Bool {
        let s: Int
        if let previous = prevStart {
            if abs(ratio - 1) < 1e-9 {
                s = previous + H
                nominal = Double(s)
            } else {
                let natural = previous + H
                let drift = Double(natural) - nominal
                guard let t = transientAhead(natural) else { return false }
                if t && abs(drift) < Double(tol * 2) {
                    s = natural
                    lastOffset = jsRoundInt(drift)
                } else {
                    guard let found = search(jsRoundInt(nominal), natural) else { return false }
                    s = found
                }
            }
        } else {
            s = jsRoundInt(nominal)
        }
        if !source.read(s, W, frameL, frameR, 0) { return false }
        let g = norm
        for i in 0..<W {
            accL[i] = Float(Double(accL[i]) + Double(frameL[i]) * win[i] * g)
            accR[i] = Float(Double(accR[i]) + Double(frameR[i]) * win[i] * g)
        }
        for i in 0..<H { fifoL[i] = accL[i]; fifoR[i] = accR[i] }
        memmove(accL.p, accL.p + H, (W - H) * MemoryLayout<Float>.size)
        memmove(accR.p, accR.p + H, (W - H) * MemoryLayout<Float>.size)
        accL.fill(0, W - H); accR.fill(0, W - H)
        fifoStart = s
        fifoRead = 0
        fifoLen = H
        if prevStart == nil { nominal = Double(s) }
        prevStart = s
        nominal += Double(H) * ratio
        return true
    }
    private func transientAhead(_ natural: Int) -> Bool? {
        if !source.read(natural, W, frameL, frameR, 0) { return nil }
        let B = max(128, jsRoundInt(sampleRate * 128 / 44100))
        let nb = W / B
        var prev = 0.0, running = 0.0
        for b in 0..<nb {
            var e = 0.0
            for i in (b * B)..<((b + 1) * B) {
                let l = Double(frameL[i]), r = Double(frameR[i])
                e += l * l + r * r
            }
            e /= Double(B)
            if b >= 2 && e > 1e-6 && e > 6 * max(prev, running / Double(b)) { return true }
            prev = e
            running += e
        }
        return false
    }
    private func search(_ target: Int, _ natural: Int) -> Int? {
        let H = C, base = target - tol, len = H + 2 * tol + 1
        if !source.read(base, len, searchL, searchR, 0) { return nil }
        if !source.read(natural, H, natL, natR, 0) { return nil }
        var natEnergy = 0.0
        for i in 0..<H {
            let l = Double(natL[i]), r = Double(natR[i])
            natEnergy += l * l + r * r
        }
        if natEnergy < 1e-12 { lastOffset = 0; return target }
        let nb = H / D, sb = (2 * tol) / D + nb
        for k in 0..<sb {
            var l = 0.0, r = 0.0
            for j in (k * D)..<(k * D + D) { l += Double(searchL[j]); r += Double(searchR[j]) }
            boxL[k] = Float(l); boxR[k] = Float(r)
        }
        for k in 0..<nb {
            var l = 0.0, r = 0.0
            for j in (k * D)..<(k * D + D) { l += Double(natL[j]); r += Double(natR[j]) }
            natBoxL[k] = Float(l); natBoxR[k] = Float(r)
        }
        var e = 1e-9
        for k in 0..<nb { let l = Double(boxL[k]), r = Double(boxR[k]); e += l * l + r * r }
        var best = 0, bestScore = -Double.infinity, nearAt = 0, nearScore = -Double.infinity
        var j = 0
        while j + nb <= sb {
            if j > 0 {
                let o = j - 1, a = j + nb - 1
                let al = Double(boxL[a]), ar = Double(boxR[a]), ol = Double(boxL[o]), or = Double(boxR[o])
                e += al * al + ar * ar - ol * ol - or * or
            }
            var c = 0.0
            for k in 0..<nb { c += Double(boxL[j + k]) * Double(natBoxL[k]) + Double(boxR[j + k]) * Double(natBoxR[k]) }
            let score = c / max(e, 1e-9).squareRoot()
            if score > bestScore { bestScore = score; best = j * D }
            if abs(j * D - tol) <= near && score > nearScore { nearScore = score; nearAt = j * D }
            j += 1
        }
        var natBox = 0.0
        for k in 0..<nb { let l = Double(natBoxL[k]), r = Double(natBoxR[k]); natBox += l * l + r * r }
        if nearScore >= bestScore - 0.01 * natBox.squareRoot() { best = nearAt }
        let lo = max(0, best - D), hi = min(2 * tol, best + D)
        bestScore = -Double.infinity
        var refined = best
        if lo <= hi {
            for d in lo...hi {
                var c = 0.0, en = 1e-9
                for i in 0..<H {
                    let l = Double(searchL[d + i]), r = Double(searchR[d + i])
                    c += l * Double(natL[i]) + r * Double(natR[i])
                    en += l * l + r * r
                }
                let score = c / en.squareRoot()
                if score > bestScore { bestScore = score; refined = d }
            }
        }
        lastOffset = refined - tol
        return base + refined
    }
}

// MARK: - Speed and pitch (dsp/playback.ts)

struct PlaybackSettings: Equatable {
    var speed = 1.0, semitones = 0.0
    init(speed: Double = 1, semitones: Double = 0) { self.speed = speed; self.semitones = semitones }
    /** sanitizePlayback(). */
    init(_ raw: [String: Any]?) {
        func clamp(_ v: Any?, _ fallback: Double, _ lo: Double, _ hi: Double, _ scale: Double) -> Double {
            guard let x = v as? Double, x.isFinite else { return fallback }
            return jsRound(max(lo, min(hi, x)) * scale) / scale
        }
        speed = clamp(raw?["speed"], 1, 0.8, 1.2, 100)
        semitones = clamp(raw?["semitones"], 0, -6, 6, 2)
    }
}

/// Bounded rewindable view of a sequential renderer, needed by WSOLA's overlap search.
private final class PullSource: PcmSource {
    let totalFrames = Int.max
    private let L: FBuf, R: FBuf, tempL = FBuf(128, 0), tempR = FBuf(128, 0)
    private let capacity: Int
    private(set) var end = 0
    var pull: (FBuf, FBuf, Int) -> Void = { _, _, _ in }
    init(_ capacity: Int) { self.capacity = capacity; L = FBuf(capacity, 0); R = FBuf(capacity, 0) }
    func reset() { end = 0; L.fill(0); R.fill(0) }
    func read(_ start: Int, _ len: Int, _ outL: FBuf, _ outR: FBuf, _ offset: Int) -> Bool {
        let wanted = max(0, start + len)
        if len > capacity || wanted - end > capacity || max(0, start) < end - capacity { return false }
        while end < wanted {
            pull(tempL, tempR, 128)
            for i in 0..<128 { let at = (end + i) % capacity; L[at] = tempL[i]; R[at] = tempR[i] }
            end += 128
        }
        if max(0, start) < end - capacity { return false }
        for i in 0..<len {
            let frame = start + i
            if frame < 0 { outL[offset + i] = 0; outR[offset + i] = 0 }
            else { let at = frame % capacity; outL[offset + i] = L[at]; outR[offset + i] = R[at] }
        }
        return true
    }
}

private let RADIUS = 32, DENSITY = 1024
private let SINC: [Double] = (0..<(RADIUS * DENSITY + 2)).map { (i: Int) -> Double in
    if i == 0 { return 1 }
    let x: Double = Double.pi * Double(i) / Double(DENSITY)
    return sin(x) / x
}
private let WINDOW: [Double] = (0..<(RADIUS * DENSITY + 2)).map { (i: Int) -> Double in
    let x: Double = min(1, Double(i) / Double(RADIUS * DENSITY))
    let a: Double = 0.5 * cos(Double.pi * x), b: Double = 0.08 * cos(2 * Double.pi * x)
    return 0.42 + a + b
}
@inline(__always) private func lookup(_ table: UnsafePointer<Double>, _ count: Int, _ x: Double) -> Double {
    let at = min(Double(count - 2), abs(x) * Double(DENSITY)), i = Int(at.rounded(.down))
    return table[i] + (table[i + 1] - table[i]) * (at - Double(i))
}

final class PlaybackTransform {
    private let source: PullSource, stretched: PullSource
    private let wsola: Wsola
    private var settings = PlaybackSettings()
    private var speed = 1.0, pitch = 1.0, position = 0.0, active = false
    private let inputL = FBuf(4096, 0), inputR = FBuf(4096, 0), warmL = FBuf(4096, 0), warmR = FBuf(4096, 0)
    private var warmPosition = 0.0, warmLeft = 0
    private let warmFrames: Int, glide: Double
    private let pull: (FBuf, FBuf, Int) -> Void
    private let sinc = DBuf(SINC.count, 0), window = DBuf(WINDOW.count, 0)
    init(_ sampleRate: Double, _ pull: @escaping (FBuf, FBuf, Int) -> Void) {
        self.pull = pull
        let capacity = Int((sampleRate / 128).rounded(.up)) * 128
        source = PullSource(capacity)
        source.pull = pull
        wsola = Wsola(sampleRate, source)
        stretched = PullSource(capacity)
        glide = 1 - exp(-128 / (sampleRate * 0.04))
        warmFrames = Int((sampleRate * 0.03).rounded(.up))
        for i in 0..<SINC.count { sinc[i] = SINC[i]; window[i] = WINDOW[i] }
        stretched.pull = { [unowned self] L, R, n in
            let produced = self.wsola.render(L, R, 0, n) { _ in self.speed / self.pitch }
            if produced < n { L.fill(0, produced, n); R.fill(0, produced, n) }
        }
    }
    func set(_ s: PlaybackSettings) { settings = s }
    func reset() {
        source.reset(); stretched.reset(); wsola.reset(0); position = 0; active = false
        speed = settings.speed; pitch = pow(2, settings.semitones / 12)
        warmLeft = 0; warmPosition = 0
    }
    var bufferedMusicalFrames: Double {
        active ? max(0, Double(source.end) - wsola.position() + max(0, Double(stretched.end) - position) * speed / pitch) : 0
    }
    var engaged: Bool { active || settings.speed != 1 || settings.semitones != 0 }
    func process(_ L: FBuf, _ R: FBuf, _ n: Int) {
        if !active && settings.speed == 1 && settings.semitones == 0 { pull(L, R, n); return }
        if !active {
            active = true; speed = settings.speed; pitch = pow(2, settings.semitones / 12)
            warmLeft = warmFrames
        }
        let amount = 1 - pow(1 - glide, Double(n) / 128)
        speed += (settings.speed - speed) * amount
        let p0 = pitch
        pitch += (pow(2, settings.semitones / 12) - pitch) * amount
        let start = Int(position.rounded(.down)) - RADIUS + 1
        let length = Int((Double(n) * max(p0, pitch)).rounded(.up)) + RADIUS * 2 + 2
        if length > inputL.count || !stretched.read(start, length, inputL, inputR, 0) {
            L.fill(0, 0, n); R.fill(0, 0, n); return
        }
        let cutoff = 0.94 / max(1, p0, pitch)
        let sc = sinc.count
        for i in 0..<n {
            let centre = position, first = Int(centre.rounded(.down)) - RADIUS + 1
            var l = 0.0, r = 0.0, sum = 0.0
            for j in 0..<(RADIUS * 2) {
                let x = Double(first + j) - centre
                let w = cutoff * lookup(sinc.p, sc, x * cutoff) * lookup(window.p, sc, x)
                let at = first + j - start
                l += Double(inputL[at]) * w; r += Double(inputR[at]) * w; sum += w
            }
            L[i] = Float(l / sum); R[i] = Float(r / sum)
            position += p0 + (pitch - p0) * Double(i + 1) / Double(n)
        }
        if warmLeft > 0 {
            let first = Int(warmPosition.rounded(.down)), length = Int((Double(n) * speed).rounded(.up)) + 2
            if source.read(first, length, warmL, warmR, 0) {
                var i = 0
                while i < n && warmLeft > 0 {
                    let at = warmPosition - Double(first), a = Int(at.rounded(.down)), fraction = at - Double(a)
                    let wet = 1 - Double(warmLeft) / Double(warmFrames)
                    L[i] = Float(Double(L[i]) * wet + (Double(warmL[a]) + (Double(warmL[a + 1]) - Double(warmL[a])) * fraction) * (1 - wet))
                    R[i] = Float(Double(R[i]) * wet + (Double(warmR[a]) + (Double(warmR[a + 1]) - Double(warmR[a])) * fraction) * (1 - wet))
                    warmPosition += speed
                    i += 1; warmLeft -= 1
                }
            } else { warmLeft = 0 }
        }
    }
}

// MARK: - Source loop and tape stop (engine/loop.ts)

struct SourceLoop { var start: Int, end: Int, until: Int, fade: Int; var roll: [(at: Int, length: Int)]? }
struct SourceTapeStop { var start: Int, end: Int, fade: Int }

final class LoopPcmSource: PcmSource {
    private var loop: SourceLoop?
    private var tape: SourceTapeStop?
    private let scratchL: FBuf, scratchR: FBuf
    private let source: PcmSource
    private let sampleRate: Double
    init(_ source: PcmSource, _ sampleRate: Double) {
        self.source = source; self.sampleRate = sampleRate
        scratchL = FBuf(Int((sampleRate * 0.02).rounded(.up)), 0); scratchR = FBuf(scratchL.count, 0)
    }
    var totalFrames: Int { max(source.totalFrames, loop?.until ?? 0) }
    var hasLoop: Bool { loop != nil }
    @discardableResult func setLoop(_ value: SourceLoop?) -> Bool {
        loop = nil; tape = nil
        guard let l = value else { return true }
        let length = l.end - l.start, sr = sampleRate
        if l.fade < 1 || l.fade > scratchL.count || l.start < l.fade || l.end > source.totalFrames
            || Double(length) < sr * 0.25 || Double(length) > sr * 8 || Double(l.fade) > Double(length) / 8
            || l.until <= l.end || l.until - l.start > length * 4 { return false }
        if let roll = l.roll {
            if roll.count > 3 { return false }
            var at = l.start, previousLength = length
            for step in roll {
                let cycles = Double(step.at - at) / Double(previousLength)
                let valid = step.at >= at + previousLength - 1 && step.at < l.until && Double(step.length) >= sr * 0.1
                    && abs(Double(step.length) - Double(previousLength) / 2) <= 1 && step.length >= l.fade * 8
                    && abs(cycles - jsRound(cycles)) * Double(previousLength) <= 1
                at = step.at; previousLength = step.length
                if !valid { return false }
            }
        }
        loop = l
        return true
    }
    @discardableResult func setTapeStop(_ value: SourceTapeStop?) -> Bool {
        tape = nil
        guard let t = value else { return true }
        let d = Double(t.end - t.start)
        if loop != nil || t.start < 0 || t.end > source.totalFrames || d < sampleRate * 0.15 || d > sampleRate * 1.5
            || t.fade < 1 || Double(t.fade) > d / 2 { return false }
        tape = t
        return true
    }
    private func readTape(_ tape: SourceTapeStop, _ start: Int, _ len: Int, _ L: FBuf, _ R: FBuf, _ offset: Int) -> Bool {
        let duration = Double(tape.end - tape.start)
        var i = 0
        while i < len {
            let p = start + i
            if p < tape.start {
                let n = min(len - i, tape.start - p)
                if !source.read(p, n, L, R, offset + i) { return false }
                i += n; continue
            }
            if p >= tape.end { L.fill(0, offset + i, offset + len); R.fill(0, offset + i, offset + len); return true }
            let n = min(len - i, tape.end - p, scratchL.count - 3), u = Double(p - tape.start)
            let from = Int((Double(tape.start) + u - u * u / (2 * duration)).rounded(.down)), last = u + Double(n - 1)
            let to = Int((Double(tape.start) + last - last * last / (2 * duration)).rounded(.up)) + 1
            if !source.read(from, to - from + 1, scratchL, scratchR, 0) { return false }
            for j in 0..<n {
                let input = u + Double(j), x = Double(tape.start) + input - input * input / (2 * duration) - Double(from)
                let k = Int(x.rounded(.down)), f = x - Double(k)
                let gain = min(1, Double(tape.end - p - j) / Double(tape.fade))
                L[offset + i + j] = Float((Double(scratchL[k]) * (1 - f) + Double(scratchL[k + 1]) * f) * gain)
                R[offset + i + j] = Float((Double(scratchR[k]) * (1 - f) + Double(scratchR[k + 1]) * f) * gain)
            }
            i += n
        }
        return true
    }
    func read(_ start: Int, _ len: Int, _ L: FBuf, _ R: FBuf, _ offset: Int) -> Bool {
        if let tape { return readTape(tape, start, len, L, R, offset) }
        guard let loop else { return source.read(start, len, L, R, offset) }
        var i = 0
        while i < len {
            let p = start + i
            if p < loop.start {
                let n = min(len - i, loop.start - p)
                if !source.read(p, n, L, R, offset + i) { return false }
                i += n; continue
            }
            if p >= loop.until { L.fill(0, offset + i, offset + len); R.fill(0, offset + i, offset + len); return true }
            var length = loop.end - loop.start, origin = loop.start, next = loop.until
            if let roll = loop.roll {
                for step in roll {
                    if step.at > p { next = min(next, step.at); break }
                    origin = step.at; length = step.length
                }
            }
            let phase = (p - origin) % length
            let seam = phase >= length - loop.fade
            let n = min(len - i, next - p, (seam ? length : length - loop.fade) - phase)
            if !source.read(loop.start + phase, n, L, R, offset + i) { return false }
            if seam {
                let at = phase - (length - loop.fade)
                if !source.read(loop.start - loop.fade + at, n, scratchL, scratchR, 0) { return false }
                for j in 0..<n {
                    let x = Double(at + j + 1) / Double(loop.fade), wet = x * x * (3 - 2 * x), out = offset + i + j
                    L[out] = Float(Double(L[out]) + (Double(scratchL[j]) - Double(L[out])) * wet)
                    R[out] = Float(Double(R[out]) + (Double(scratchR[j]) - Double(R[out])) * wet)
                }
            }
            i += n
        }
        return true
    }
}

// MARK: - Echo (engine/mixer.ts)

final class Echo {
    private let L: FBuf, R: FBuf
    private var pos = 0, delay = 1, feedback = 0.5
    private var hpL = 0.0, hpR = 0.0, hpXL = 0.0, hpXR = 0.0, lpL = 0.0, lpR = 0.0
    private let hpA: Double, lpA: Double
    private var zeros: Int
    private var out = 1.0, outStep = 0.0
    init(_ sampleRate: Double) {
        let n = Int((sampleRate * 2.5).rounded(.up))
        L = FBuf(n, 0); R = FBuf(n, 0); zeros = n
        hpA = exp((-2 * Double.pi * 250) / sampleRate)
        lpA = 1 - exp((-2 * Double.pi * 6000) / sampleRate)
    }
    func configure(_ delayFrames: Double, _ feedback: Double) {
        reset()
        delay = max(1, min(L.count - 1, jsRoundInt(delayFrames)))
        self.feedback = max(0, min(0.75, feedback))
    }
    func process(_ inL: FBuf, _ inR: FBuf, _ outL: FBuf, _ outR: FBuf, _ n: Int) {
        let N = L.count
        if zeros >= N && outStep == 0 {
            var silent = true
            for i in 0..<n where inL[i] != 0 || inR[i] != 0 { silent = false; break }
            if silent { hpL = 0; hpR = 0; hpXL = 0; hpXR = 0; lpL = 0; lpR = 0; return }
        }
        for i in 0..<n {
            let rp = (pos - delay + N) % N
            let yL = Double(L[rp]), yR = Double(R[rp])
            if outStep > 0 {
                out = max(0, out - outStep)
                if out == 0 { reset(); return }
            }
            outL[i] = Float(Double(outL[i]) + yL * out * 1)
            outR[i] = Float(Double(outR[i]) + yR * out * 1)
            let hL = hpA * (hpL + yL - hpXL), hR = hpA * (hpR + yR - hpXR)
            hpXL = yL; hpXR = yR; hpL = hL; hpR = hR
            lpL += lpA * (hL - lpL); lpR += lpA * (hR - lpR)
            L[pos] = Float(Double(inL[i]) + lpL * feedback)
            R[pos] = Float(Double(inR[i]) + lpR * feedback)
            zeros = L[pos] == 0 && R[pos] == 0 ? zeros + 1 : 0
            pos = pos + 1 == N ? 0 : pos + 1
        }
    }
    func reset() {
        L.fill(0); R.fill(0); zeros = L.count; pos = 0
        hpL = 0; hpR = 0; hpXL = 0; hpXR = 0; lpL = 0; lpR = 0
        out = 1; outStep = 0
    }
}

// MARK: - Transitions

struct LanePoint { let t: Double, v: Double }
func evalPoints(_ points: [LanePoint], _ t: Double) -> Double {
    let n = points.count
    if n == 0 { return 1 }
    if t <= points[0].t { return points[0].v }
    if t >= points[n - 1].t { return points[n - 1].v }
    var lo = 0, hi = n - 1
    while hi - lo > 1 {
        let mid = (lo + hi) >> 1
        if points[mid].t <= t { lo = mid } else { hi = mid }
    }
    let a = points[lo], b = points[hi]
    return b.t == a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
}

/// ArmedTransition of engine/mixer.ts without the vocal fields.
struct ArmedTransition {
    struct Lane { let isA: Bool; let lane: Int; let points: [LanePoint] }
    var planId: String, method: String, fromToken: String, toToken: String
    var triggerFrame: Double, entryFrame: Double, durationFrames: Double, gapFrames: Double, swapFrame: Double
    var bDelayFrames: Double?
    var tempoB: [LanePoint], tempoA: [LanePoint]?
    var loopA: SourceLoop?, tapeStopA: SourceTapeStop?
    var lanes: [Lane]
    var echoDelayFrames: Double?, echoFeedback: Double?
    /** Vocal stems or a vocal throw: not playable natively. */
    var usesVocals = false

    init?(_ raw: [String: Any]) {
        func num(_ k: String) -> Double? { (raw[k] as? Double).flatMap { $0.isFinite ? $0 : nil } }
        func points(_ v: Any?) -> [LanePoint]? {
            guard let a = v as? [[Double]] else { return nil }
            let p = a.compactMap { $0.count >= 2 && $0[0].isFinite && $0[1].isFinite ? LanePoint(t: $0[0], v: $0[1]) : nil }
            return p.count == a.count ? p : nil
        }
        guard let planId = raw["planId"] as? String, let trigger = num("triggerFrame"), let entry = num("entryFrame"),
              let duration = num("durationFrames"), let swap = num("swapFrame"), let tempoB = points(raw["tempoB"]),
              let lanes = raw["lanes"] as? [[String: Any]] else { return nil }
        self.planId = planId
        method = raw["method"] as? String ?? ""
        fromToken = raw["fromToken"] as? String ?? "A"; toToken = raw["toToken"] as? String ?? "B"
        triggerFrame = trigger; entryFrame = entry; durationFrames = duration; swapFrame = swap
        gapFrames = num("gapFrames") ?? 0
        bDelayFrames = num("bDelayFrames")
        self.tempoB = tempoB
        tempoA = points(raw["tempoA"])
        var parsed: [Lane] = []
        for lane in lanes {
            guard let deck = lane["deck"] as? String, let index = lane["lane"] as? Int, (0...6).contains(index),
                  let p = points(lane["points"]) else { return nil }
            parsed.append(Lane(isA: deck == "A", lane: index, points: p))
        }
        self.lanes = parsed
        echoDelayFrames = num("echoDelayFrames"); echoFeedback = num("echoFeedback")
        if let l = raw["loopA"] as? [String: Any], let s = l["start"] as? Int, let e = l["end"] as? Int,
           let u = l["until"] as? Int, let f = l["fade"] as? Int {
            let roll = (l["roll"] as? [[String: Any]])?.compactMap { r -> (at: Int, length: Int)? in
                guard let at = r["at"] as? Int, let length = r["length"] as? Int else { return nil }
                return (at, length)
            }
            loopA = SourceLoop(start: s, end: e, until: u, fade: f, roll: roll)
        }
        if let t = raw["tapeStopA"] as? [String: Any], let s = t["start"] as? Int, let e = t["end"] as? Int, let f = t["fade"] as? Int {
            tapeStopA = SourceTapeStop(start: s, end: e, fade: f)
        }
        usesVocals = raw["vocalA"] != nil || raw["vocalB"] != nil || (num("voiceEchoDelayFrames") ?? 0) != 0
            || parsed.contains { $0.isA && $0.lane == 5 && $0.points.contains { $0.v > 0 } }
    }
}

enum MixerEvent {
    case transitionStart(planId: String, late: Bool)
    case swap(planId: String, token: String)
    case transitionEnd(planId: String, token: String, forced: Bool)
    case transitionAborted(planId: String, reason: String)
    case disarmed(planId: String, reason: String)
    case ended(deck: Int, token: String)
    case fallback(planId: String, reason: String)

    var fields: [String: Any] {
        switch self {
        case let .transitionStart(planId, late): return ["type": "transitionStart", "planId": planId, "late": late]
        case let .swap(planId, token): return ["type": "swap", "planId": planId, "token": token]
        case let .transitionEnd(planId, token, forced): return ["type": "transitionEnd", "planId": planId, "token": token, "forced": forced]
        case let .transitionAborted(planId, reason): return ["type": "transitionAborted", "planId": planId, "reason": reason]
        case let .disarmed(planId, reason): return ["type": "disarmed", "planId": planId, "reason": reason]
        case let .ended(deck, token): return ["type": "ended", "deck": deck, "token": token]
        case let .fallback(planId, reason): return ["type": "fallback", "planId": planId, "reason": reason]
        }
    }
}

// MARK: - Mixer (engine/mixer.ts)

typealias Lanes = [Double]
private func unity() -> Lanes { [1, 1, 1, 1, 0, 0, 0] }

final class Deck {
    let index: Int
    var token: String?
    let store = DeckSource()
    let loopSource: LoopPcmSource
    let wsola: Wsola
    let iso: StereoIsolator
    let filter: StereoSweep
    var lastRawL = 0.0, lastRawR = 0.0, tailLeft = 0, tailL = 0.0, tailR = 0.0
    var playing = false, starved = false
    var normGain = 1.0, normGainTarget = 1.0
    var lanes = unity()
    var laneTarget: Lanes?
    var tempo: (origin: Double, points: [LanePoint])?
    var cueFrame = 0.0
    var fade = 1.0, fadeTarget = 1.0, fadeStep = 1.0
    var stopWhenSilent = false
    var pendingSeek: Double?
    var endedNotified = false
    var echoGate = 1.0
    var totalFrames: Int { store.totalFrames }
    init(_ index: Int, _ sampleRate: Double) {
        self.index = index
        loopSource = LoopPcmSource(store, sampleRate)
        wsola = Wsola(sampleRate, loopSource)
        iso = StereoIsolator(sampleRate)
        filter = StereoSweep(sampleRate)
    }
    func clearTail() { lastRawL = 0; lastRawR = 0; tailLeft = 0; tailL = 0; tailR = 0 }
    func position() -> Double { wsola.position() }
}

final class MixerCore {
    let sampleRate: Double
    let decks: [Deck]
    var main = 0
    private(set) var paused = false
    private(set) var clock = 0.0
    private var transport = 1.0, transportTarget = 1.0
    private var silentTransportFrames = 0
    private let transportStep: Double
    private var volume = 1.0, volumeTarget = 1.0
    private var armed: ArmedTransition?
    private var active = false, late = false, lateNotified = false, swapped = false, forced = false
    private var t = 0.0
    private var bufL = FBuf(4096, 0), bufR = FBuf(4096, 0)
    private let limiter: Limiter
    private let tone: MasterTone
    private let reverb: MasterReverb
    private var playback: PlaybackTransform!
    private let echo: Echo
    private var echoInL = FBuf(4096, 0), echoInR = FBuf(4096, 0)
    var emit: (MixerEvent) -> Void = { _ in }

    init(_ sampleRate: Double) {
        self.sampleRate = sampleRate
        decks = [Deck(0, sampleRate), Deck(1, sampleRate)]
        limiter = Limiter(sampleRate)
        tone = MasterTone(sampleRate)
        reverb = MasterReverb(sampleRate)
        echo = Echo(sampleRate)
        transportStep = 1 / jsRound(sampleRate * 0.012)
        playback = PlaybackTransform(sampleRate) { [unowned self] L, R, n in self.renderMusical(L, R, n) }
    }

    var isTransitionActive: Bool { active }
    var transitionProgress: Double? {
        guard active, let armed else { return nil }
        return min(1, max(0, t / max(1, armed.durationFrames)))
    }
    var armedTransition: ArmedTransition? { armed }

    // ------------------------------------------------------------ commands

    func load(_ deck: Int, _ token: String, _ source: PcmSource, _ gainDb: Double, _ cueFrame: Double = 0) {
        let d = decks[deck]
        d.loopSource.setLoop(nil)
        if let tr = armed, tr.toToken == d.token || tr.fromToken == d.token, d.token != token { detachDeck(d, "deck_reloaded") }
        d.token = token
        d.clearTail()
        d.store.inner = source
        d.echoGate = 1
        d.normGain = pow(10, gainDb / 20)
        d.normGainTarget = d.normGain
        d.playing = false
        d.starved = false
        d.tempo = nil
        d.lanes = unity()
        d.laneTarget = nil
        d.cueFrame = max(0, jsRound(cueFrame))
        d.fade = 1; d.fadeTarget = 1
        d.stopWhenSilent = false
        d.pendingSeek = nil
        d.endedNotified = false
        d.iso.reset(); d.filter.reset()
        d.wsola.reset(d.cueFrame)
    }
    func unload(_ deck: Int) {
        let d = decks[deck]
        detachDeck(d, "deck_unloaded")
        d.loopSource.setLoop(nil)
        d.token = nil
        d.playing = false
        d.store.inner = EmptySource()
    }
    func setGain(_ deck: Int, _ gainDb: Double) {
        let d = decks[deck]
        d.normGainTarget = pow(10, gainDb / 20)
        if !d.playing { d.normGain = d.normGainTarget }
    }
    func start(_ deck: Int, _ token: String, _ frame: Double) {
        let d = decks[deck]
        if d.token != token { return }
        playback.reset()
        d.clearTail()
        if active { abortTransition("restart") }
        disarm("restart")
        let other = decks[1 - deck]
        if other.playing { fadeOutAndStop(other, 0.03) }
        main = deck
        echo.reset()
        d.iso.reset(); d.filter.reset()
        d.loopSource.setLoop(nil)
        d.wsola.reset(max(0, jsRound(frame)))
        d.playing = true
        d.starved = false
        d.tempo = nil
        d.lanes = unity()
        d.laneTarget = nil
        d.fade = 1; d.fadeTarget = 1
        d.stopWhenSilent = false
        d.pendingSeek = nil
        d.endedNotified = false
    }
    func stopAll() {
        playback.reset()
        if active { abortTransition("stop") } else { disarm("stop") }
        for d in decks { d.playing = false; d.loopSource.setLoop(nil) }
        echo.reset()
        tone.reset()
        reverb.reset()
        limiter.reset()
    }
    func setPaused(_ p: Bool) {
        if p == paused && transportTarget == (p ? 0 : 1) { return }
        if p { transportTarget = 0 } else { paused = false; transportTarget = 1 }
    }
    func setVolume(_ v: Double) { volumeTarget = max(0, min(1.5, v)) }
    func setTone(_ s: ToneSettings, _ preDb: Double?) {
        tone.set(s, preDb)
        reverb.setMix(s.enabled ? s.reverbMix : 0)
    }
    func setPlayback(_ s: PlaybackSettings) { playback.set(s) }
    func seek(_ token: String, _ frame: Double) {
        guard let di = decks.firstIndex(where: { $0.token == token }) else { return }
        playback.reset()
        let d = decks[di]
        if active {
            fadeOutAndStop(decks[1 - di], 0.25)
            let planId = armed?.planId ?? ""
            active = false
            armed = nil
            emit(.transitionAborted(planId: planId, reason: "seek"))
        } else {
            disarm("seek")
        }
        main = di
        echo.reset()
        let target = max(0, min(Double(d.totalFrames - 1), jsRound(frame)))
        d.tempo = nil
        d.endedNotified = false
        d.stopWhenSilent = false
        if paused || !d.playing {
            d.loopSource.setLoop(nil)
            d.wsola.reset(target)
            d.clearTail()
            d.iso.reset(); d.filter.reset()
            d.pendingSeek = nil
            d.lanes = unity()
            d.laneTarget = nil
            d.playing = true
            d.fade = 1; d.fadeTarget = 1
        } else {
            d.pendingSeek = target
            d.fadeTarget = 0
            d.fadeStep = 1 / jsRound(sampleRate * 0.006)
        }
        d.cueFrame = target
    }
    func arm(_ tr: ArmedTransition) {
        if active { return }
        for d in decks { d.loopSource.setLoop(nil) }
        armed = tr
        active = false; late = false; lateNotified = false; swapped = false; forced = false
        t = 0
    }
    func disarm(_ reason: String) {
        if let tr = armed, !active {
            armed = nil
            for d in decks { d.loopSource.setLoop(nil) }
            emit(.disarmed(planId: tr.planId, reason: reason))
        }
    }

    // -------------------------------------------------------------- render

    func process(_ outL: FBuf, _ outR: FBuf, _ n: Int) {
        if paused { outL.fill(0, 0, n); outR.fill(0, 0, n); return }
        if !playback.engaged {
            renderMusical(outL, outR, n)
            applyMaster(outL, outR, n)
        } else {
            // n is at most 128 here: the native runtime renders in 128-frame quanta.
            playback.process(outL, outR, n)
            applyMaster(outL, outR, n)
        }
        checkEnded()
    }

    private func renderMusical(_ outL: FBuf, _ outR: FBuf, _ n: Int) {
        outL.fill(0, 0, n); outR.fill(0, 0, n)
        if paused { return }
        if bufL.count < n { bufL = FBuf(n, 0); bufR = FBuf(n, 0) }
        if echoInL.count < n { echoInL = FBuf(n, 0); echoInR = FBuf(n, 0) }
        echoInL.fill(0, 0, n); echoInR.fill(0, 0, n)
        var off = 0
        while off < n {
            var len = n - off
            if let tr = armed, !active {
                if let a = deckByToken(tr.fromToken), a.playing {
                    let pA = a.position()
                    if pA >= tr.triggerFrame || late {
                        _ = tryStartTransition(tr, a)
                    } else {
                        let rA = ratioFor(a, clock)
                        let framesTo = Int(((tr.triggerFrame - pA) / max(0.25, rA)).rounded(.up))
                        if framesTo < len { len = max(1, framesTo) }
                    }
                }
            }
            if active, let current = armed {
                let end = current.durationFrames + current.gapFrames
                let rem = end - t
                if rem > 0 && rem < Double(len) { len = Int(rem) }
                for lane in current.lanes {
                    if !lane.isA && current.gapFrames > 0 { continue }
                    let shift = !lane.isA ? current.bDelayFrames ?? 0 : 0
                    for p in lane.points {
                        let point = p.t + shift
                        if point > t && point - t < Double(len) { len = Int(point - t) }
                    }
                }
                if !swapped && current.swapFrame > t && current.swapFrame - t < Double(len) { len = Int(current.swapFrame - t) }
                let delay = current.bDelayFrames ?? 0
                if delay > t && delay - t < Double(len) { len = Int(delay - t) }
            }
            renderSub(outL, outR, off, len)
            clock += Double(len)
            if active, let tr2 = armed {
                t += Double(len)
                if !swapped && t >= tr2.swapFrame {
                    swapped = true
                    main = deckByToken(tr2.toToken)?.index ?? main
                    emit(.swap(planId: tr2.planId, token: tr2.toToken))
                }
                if t >= tr2.durationFrames + tr2.gapFrames { endTransition() }
            }
            off += len
        }
        echo.process(echoInL, echoInR, outL, outR, n)
    }

    private func renderSub(_ outL: FBuf, _ outR: FBuf, _ off: Int, _ len: Int) {
        let tr = active ? armed : nil
        for d in decks {
            if !d.playing { continue }
            var role: Bool?  // true = A, false = B
            if let tr {
                if d.token == tr.fromToken { role = true } else if d.token == tr.toToken { role = false }
            }
            if let tr, role == false, tr.gapFrames > 0 || t < (tr.bDelayFrames ?? 0) { continue }
            let from: Lanes, to: Lanes
            if let tr, let isA = role {
                let t0 = max(0, t - (tr.gapFrames + (tr.bDelayFrames ?? 0)) * (isA ? 0 : 1))
                let at = isA ? t : t0
                from = evalLanes(tr, isA, at)
                to = evalLanes(tr, isA, at + Double(len))
                d.lanes = to
            } else if let target = d.laneTarget {
                from = d.lanes
                to = glide(d.lanes, target, len)
                d.lanes = to
                if to == target { d.laneTarget = nil }
            } else {
                from = d.lanes
                to = d.lanes
            }
            renderDeck(d, outL, outR, off, len, from, to)
        }
    }

    private func renderDeck(_ d: Deck, _ outL: FBuf, _ outR: FBuf, _ off: Int, _ len: Int, _ from: Lanes, _ to: Lanes) {
        let bl = bufL, br = bufR
        let clock = self.clock
        let produced = d.wsola.render(bl, br, 0, len) { k in self.ratioFor(d, clock + Double(k)) }
        if produced < len {
            bl.fill(0, produced, len); br.fill(0, produced, len)
            if !d.starved && d.token != nil {
                d.tailL = produced > 0 ? Double(bl[produced - 1]) : d.lastRawL
                d.tailR = produced > 0 ? Double(br[produced - 1]) : d.lastRawR
                d.tailLeft = max(1, jsRoundInt(sampleRate * 0.003))
                d.starved = true
            }
            let tailFrames = Double(max(1, jsRoundInt(sampleRate * 0.003)))
            var i = produced
            while i < len && d.tailLeft > 0 {
                let gain = 0.5 - 0.5 * cos(Double.pi * Double(d.tailLeft - 1) / tailFrames)
                bl[i] = Float(d.tailL * gain); br[i] = Float(d.tailR * gain)
                i += 1; d.tailLeft -= 1
            }
        } else if d.starved {
            d.starved = false
            d.fade = 0
            d.fadeTarget = 1
            d.fadeStep = 1 / jsRound(sampleRate * 0.008)
        }
        if produced > 0 { d.lastRawL = Double(bl[produced - 1]); d.lastRawR = Double(br[produced - 1]) }
        let a = armed
        d.iso.idle = d.laneTarget == nil && !(a != nil && (a!.fromToken == d.token || a!.toToken == d.token))
        d.iso.processBlock(bl, br, 0, len, (from[1], from[2], from[3]), (to[1], to[2], to[3]))
        d.filter.processBlock(bl, br, len, from[6], to[6])
        let n0 = d.normGain
        if n0 != d.normGainTarget {
            let step = (Double(len) / (sampleRate * 2)) * max(abs(d.normGainTarget - n0), 0.05)
            d.normGain = n0 < d.normGainTarget ? min(d.normGainTarget, n0 + step) : max(d.normGainTarget, n0 - step)
        }
        let g0 = from[0] * n0, g1 = to[0] * d.normGain
        let dg = (g1 - g0) / Double(len)
        var g = g0
        var fade = d.fade
        let target = d.fadeTarget, step = d.fadeStep
        let sending = from[4] > 0 || to[4] > 0
        var send = from[4]
        let ds = (to[4] - from[4]) / Double(len)
        let gate = d.echoGate
        for i in 0..<len {
            if fade != target { fade = fade < target ? min(target, fade + step) : max(target, fade - step) }
            let k = g * fade
            let l = Double(bl[i]) * k, r = Double(br[i]) * k
            outL[off + i] = Float(Double(outL[off + i]) + l)
            outR[off + i] = Float(Double(outR[off + i]) + r)
            if sending {
                let pre = d.normGain * fade * send * gate
                echoInL[off + i] = Float(Double(echoInL[off + i]) + Double(bl[i]) * pre)
                echoInR[off + i] = Float(Double(echoInR[off + i]) + Double(br[i]) * pre)
                send += ds
            }
            g += dg
        }
        d.fade = fade
        if fade == 0 && target == 0 {
            if let seek = d.pendingSeek {
                d.loopSource.setLoop(nil)
                d.wsola.reset(seek)
                d.clearTail()
                d.iso.reset(); d.filter.reset()
                d.pendingSeek = nil
                d.lanes = unity()
                d.laneTarget = nil
                d.fade = 1; d.fadeTarget = 1
            } else if d.stopWhenSilent {
                d.loopSource.setLoop(nil)
                d.playing = false
                d.stopWhenSilent = false
                d.fade = 1; d.fadeTarget = 1
            }
        }
    }

    private func applyMaster(_ outL: FBuf, _ outR: FBuf, _ n: Int) {
        reverb.process(outL, outR, n)
        tone.process(outL, outR, n)
        var tg = transport
        let tgt = transportTarget
        let vol0 = volume, vol1 = volumeTarget
        let dv = (vol1 - vol0) / Double(n)
        var v = vol0
        for i in 0..<n {
            if tg != tgt { tg = tg < tgt ? min(tgt, tg + transportStep) : max(tgt, tg - transportStep) }
            let k = tg * v
            outL[i] = Float(Double(outL[i]) * k)
            outR[i] = Float(Double(outR[i]) * k)
            silentTransportFrames = tg == 0 && tgt == 0 ? silentTransportFrames + 1 : 0
            v += dv
        }
        transport = tg
        volume = vol1
        limiter.processBlock(outL, outR, 0, n)
        if tg == 0 && tgt == 0 && silentTransportFrames >= limiter.lookahead { paused = true }
    }

    // --------------------------------------------------------- transitions

    private func tryStartTransition(_ plan: ArmedTransition, _ a: Deck) -> Bool {
        var tr = plan
        guard let b = deckByToken(tr.toToken), b !== a else {
            emit(.fallback(planId: tr.planId, reason: "deck_missing"))
            armed = nil
            return false
        }
        // Whole tracks are on disk: the incoming buffer is always ready.
        if late {
            let D = jsRound(sampleRate * 2)
            func pts(_ f: (Double) -> Double) -> [LanePoint] {
                (0..<9).map { i in LanePoint(t: jsRound((D * Double(i)) / 8), v: f(Double(i) / 8)) }
            }
            tr.method = "fallback_crossfade"
            tr.durationFrames = D; tr.gapFrames = 0; tr.swapFrame = jsRound(D / 2)
            tr.tempoB = [LanePoint(t: 0, v: 1)]; tr.tempoA = nil; tr.loopA = nil; tr.tapeStopA = nil
            tr.lanes = [ArmedTransition.Lane(isA: true, lane: 0, points: pts { cos(($0 * Double.pi) / 2) }),
                        ArmedTransition.Lane(isA: false, lane: 0, points: pts { sin(($0 * Double.pi) / 2) })]
            armed = tr
        }
        if !a.loopSource.setLoop(tr.loopA) { emit(.fallback(planId: tr.planId, reason: "invalid_loop")) }
        if !a.loopSource.setTapeStop(tr.tapeStopA) { emit(.fallback(planId: tr.planId, reason: "invalid_tape_stop")) }
        a.echoGate = 1
        b.echoGate = 1
        b.wsola.reset(tr.entryFrame)
        b.clearTail()
        b.playing = true
        b.starved = false
        b.fade = 1; b.fadeTarget = 1
        b.stopWhenSilent = false
        b.pendingSeek = nil
        b.endedNotified = false
        if let delay = tr.echoDelayFrames, delay != 0 { echo.configure(delay, tr.echoFeedback ?? 0.5) }
        b.tempo = (origin: clock + (tr.gapFrames > 0 ? tr.durationFrames + tr.gapFrames : tr.bDelayFrames ?? 0), points: tr.tempoB)
        if let tempoA = tr.tempoA, !tempoA.isEmpty { a.tempo = (origin: clock, points: tempoA) }
        b.lanes = evalLanes(tr, false, 0)
        a.laneTarget = nil; b.laneTarget = nil
        active = true
        t = 0
        swapped = false
        emit(.transitionStart(planId: tr.planId, late: late))
        return true
    }

    private func endTransition() {
        guard let tr = armed else { return }
        if let a = deckByToken(tr.fromToken) {
            a.playing = false
            a.loopSource.setLoop(nil)
            a.lanes = unity()
        }
        if let b = deckByToken(tr.toToken) {
            b.lanes = unity()
            main = b.index
        }
        active = false
        armed = nil
        if !swapped { emit(.swap(planId: tr.planId, token: tr.toToken)) }
        emit(.transitionEnd(planId: tr.planId, token: tr.toToken, forced: forced))
    }

    private func abortTransition(_ reason: String) {
        let id = armed?.planId ?? ""
        active = false
        armed = nil
        for d in decks { d.loopSource.setLoop(nil) }
        emit(.transitionAborted(planId: id, reason: reason))
    }

    private func detachDeck(_ d: Deck, _ reason: String) {
        guard let tr = armed, tr.fromToken == d.token || tr.toToken == d.token else { return }
        if !active { disarm(reason); return }
        let other = decks[1 - d.index]
        if other.playing {
            other.laneTarget = unity()
            let ratio = ratioFor(other, clock)
            other.tempo = (origin: clock, points: [LanePoint(t: 0, v: ratio), LanePoint(t: jsRound(sampleRate * 0.6), v: 1)])
            main = other.index
        }
        echo.reset()
        abortTransition(reason)
    }

    private func glide(_ from: Lanes, _ target: Lanes, _ len: Int) -> Lanes {
        let step = Double(len) / (sampleRate * 0.3)
        return from.indices.map { from[$0] + max(-step, min(step, target[$0] - from[$0])) }
    }

    private func evalLanes(_ tr: ArmedTransition, _ isA: Bool, _ t: Double) -> Lanes {
        var v = unity()
        for l in tr.lanes where l.isA == isA { v[l.lane] = evalPoints(l.points, t) }
        return v
    }

    private func fadeOutAndStop(_ d: Deck, _ seconds: Double) {
        d.fadeTarget = 0
        d.fadeStep = 1 / max(1, jsRound(sampleRate * seconds))
        d.stopWhenSilent = true
        d.pendingSeek = nil
    }

    private func ratioFor(_ d: Deck, _ clock: Double) -> Double {
        guard let tempo = d.tempo else { return 1 }
        let r = evalPoints(tempo.points, clock - tempo.origin)
        if let last = tempo.points.last, clock - tempo.origin >= last.t && abs(last.v - 1) < 1e-9 { d.tempo = nil }
        return r
    }

    private func deckByToken(_ token: String) -> Deck? { decks.first { $0.token == token } }

    private func checkEnded() {
        for d in decks {
            guard d.playing, let token = d.token, !d.endedNotified else { continue }
            if d.position() - playback.bufferedMusicalFrames * ratioFor(d, clock) >= Double(d.totalFrames) {
                let isA = armed != nil && token == armed!.fromToken
                if active && isA { continue }
                d.endedNotified = true
                d.playing = false
                if let tr = armed, !active, isA {
                    armed = nil
                    emit(.fallback(planId: tr.planId, reason: "a_ended_before_transition"))
                }
                emit(.ended(deck: d.index, token: token))
            }
        }
    }
}

// MARK: - Native queue (port of apps/mobile/src/native-mixer.ts)

struct NativeMixBlend {
    let index: Int
    let progress: Double
}
struct NativeMixMark {
    var frame: Int64
    let index: Int
    let position: Double
    var blend: NativeMixBlend? = nil
}
struct NativeMixBlock {
    let left: Data
    let right: Data
    let marks: [NativeMixMark]
    let events: [[String: Any]]
    let done: Bool
    var frames: Int { left.count / MemoryLayout<Float>.size }
}
enum NativeRenderError: Error { case invalid(String) }

/// Track i plays on deck i % 2 with token "T\(i)"; `current` is the outgoing/main track.
/// Confined to the host's serial producer queue; never runs on the audio callback.
final class NativeQueueRenderer {
    private struct Track { let totalFrames: Int; let gainDb: Double; let file: Int; let transition: ArmedTransition? }
    private let folder: URL
    private let sampleRate: Double
    private let core: MixerCore
    private var tracks: [Track]
    private var current: Int
    private var advance = false, promote = false, endedLast = false, done = false
    private var tail = -1
    private var events: [[String: Any]] = []
    private let left = FBuf(4096, 0), right = FBuf(4096, 0)
    var trackCount: Int { tracks.count }

    init(folder: URL, config: [String: Any]) throws {
        guard let sr = config["sampleRate"] as? Double, [44100.0, 48000.0].contains(sr),
              let raw = config["tracks"] as? [[String: Any]], !raw.isEmpty else { throw NativeRenderError.invalid("Invalid native queue") }
        self.folder = folder
        sampleRate = sr
        core = MixerCore(sr)
        tracks = try raw.enumerated().map { try Self.track($0.element, $0.offset) }
        let index = max(0, min(tracks.count - 1, config["index"] as? Int ?? 0))
        current = index
        core.emit = { [unowned self] event in self.handle(event) }
        let position = max(0, min(config["position"] as? Double ?? 0, Double(tracks[index].totalFrames) / sr))
        try loadTrack(index, 0)
        core.start(index % 2, "T\(index)", jsRound(position * sr))
        apply(config)
        try loadNext()
    }
    private static func track(_ raw: [String: Any], _ i: Int) throws -> Track {
        guard let frames = raw["totalFrames"] as? Int, frames > 0, let gain = raw["gainDb"] as? Double, gain.isFinite else {
            throw NativeRenderError.invalid("Invalid native track")
        }
        return Track(totalFrames: frames, gainDb: gain, file: raw["file"] as? Int ?? i,
                     transition: (raw["transition"] as? [String: Any]).flatMap { ArmedTransition($0) })
    }
    /// Tone, speed/pitch and volume from a config or a later settings change.
    func apply(_ settings: [String: Any]) {
        if let tone = settings["tone"] as? [String: Any] { core.setTone(ToneSettings(tone), settings["preDb"] as? Double) }
        if let playback = settings["playback"] as? [String: Any] { core.setPlayback(PlaybackSettings(playback)) }
        if let volume = settings["volume"] as? Double, volume.isFinite { core.setVolume(volume) }
    }
    private func handle(_ event: MixerEvent) {
        events.append(event.fields)
        switch event {
        case .transitionEnd: promote = true
        case let .ended(deck, _):
            if deck == current % 2 && core.main == deck {
                if current + 1 < tracks.count { advance = true }
                else { endedLast = true; tail = Int((sampleRate * 0.1 / 128).rounded(.up)) * 128 }
            }
        default: break
        }
    }
    private func loadTrack(_ i: Int, _ cue: Double) throws {
        let t = tracks[i]
        let source = try FileSource(url: folder.appendingPathComponent("\(t.file).f32le"))
        guard source.totalFrames == t.totalFrames else { throw NativeRenderError.invalid("Short native PCM") }
        core.load(i % 2, "T\(i)", source, t.gainDb, cue)
    }
    /// Loads the track after `current` on the free deck and arms its transition when still ahead.
    private func loadNext() throws {
        core.disarm("queue")
        let n = current + 1
        guard n < tracks.count else { core.unload(n % 2); return }
        let plan = tracks[n].transition
        try loadTrack(n, plan?.entryFrame ?? 0)
        if var plan, !plan.usesVocals, core.decks[current % 2].position() < plan.triggerFrame {
            plan.fromToken = "T\(current)"; plan.toToken = "T\(n)"
            core.arm(plan)
        }
    }
    /// Replaces tracks from `from`; false while that track is already audible or blending in.
    func update(from: Int, tracks raw: [[String: Any]]) throws -> Bool {
        let blending = core.isTransitionActive || promote || core.main != current % 2
        if done || from <= current || from > tracks.count || (from == current + 1 && blending) { return false }
        let added = try raw.enumerated().map { try Self.track($0.element, from + $0.offset) }
        tracks.replaceSubrange(from..<tracks.count, with: added)
        if from == current + 1 {
            try loadNext()
            if endedLast && from < tracks.count { endedLast = false; tail = -1; advance = true }
        }
        return true
    }
    func render() throws -> NativeMixBlock {
        var marks: [NativeMixMark] = []
        func mark(_ offset: Int) {
            let main = core.main
            marks.append(NativeMixMark(frame: Int64(offset), index: main == current % 2 ? current : current + 1,
                                       position: core.decks[main].position() / sampleRate,
                                       blend: core.transitionProgress.map { NativeMixBlend(index: current + 1, progress: $0) }))
        }
        var length = 0
        let block = FBuf(128, 0), blockR = FBuf(128, 0)
        while length < left.count && !done {
            if advance {
                advance = false; current += 1
                core.start(current % 2, "T\(current)", 0)
                try loadNext()
            }
            if promote { promote = false; current += 1; try loadNext() }
            mark(length)
            core.process(block, blockR, 128)
            for i in 0..<128 {
                guard block[i].isFinite && blockR[i].isFinite else { throw NativeRenderError.invalid("Nonfinite native output") }
                left[length + i] = block[i]; right[length + i] = blockR[i]
            }
            length += 128
            if tail > 0 { tail -= 128; if tail <= 0 { done = true } }
        }
        mark(length)
        let out = (Data(bytes: left.p, count: length * 4), Data(bytes: right.p, count: length * 4))
        let emitted = events
        events.removeAll(keepingCapacity: true)
        return NativeMixBlock(left: out.0, right: out.1, marks: marks, events: emitted, done: done)
    }
}
