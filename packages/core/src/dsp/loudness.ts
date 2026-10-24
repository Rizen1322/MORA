import { Biquad, type BiquadCoefs } from './biquad.ts';
import { TRUE_PEAK_KERNEL } from './limiter.ts';

/**
 * ITU-R BS.1770-4 K-weighting coefficients for an arbitrary sample rate.
 * Same analog-matched design as libebur128 (MIT): reproduces the reference
 * 48 kHz coefficients of the standard and adapts them to other rates.
 */
export function kWeighting(fs: number): [BiquadCoefs, BiquadCoefs] {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf: BiquadCoefs = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp: BiquadCoefs = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

/** Streaming loudness meter: integrated LUFS (gated), sample peak and estimated true peak. */
export class LoudnessMeter {
  private readonly filters: [Biquad, Biquad][];
  private readonly blockSize: number;
  private readonly stepSize: number;
  private readonly sums: Float64Array;
  private ring: Float64Array[];
  private ringPos = 0;
  private filled = 0;
  private sinceStep = 0;
  private blocks: number[] = [];
  private samplePeak = 0;
  private truePeak = 0;
  private readonly hist: Float64Array[];
  private histPos = 0;

  constructor(
    readonly sampleRate: number,
    readonly channels = 2,
  ) {
    const [shelf, hp] = kWeighting(sampleRate);
    this.filters = Array.from({ length: channels }, () => [new Biquad(shelf), new Biquad(hp)] as [Biquad, Biquad]);
    this.blockSize = Math.round(sampleRate * 0.4);
    this.stepSize = Math.round(sampleRate * 0.1);
    this.sums = new Float64Array(channels);
    this.ring = Array.from({ length: channels }, () => new Float64Array(this.blockSize));
    this.hist = Array.from({ length: channels }, () => new Float64Array(TRUE_PEAK_KERNEL[0].length));
  }

  push(chans: Float32Array[], len = chans[0].length): void {
    const C = this.channels;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < C; c++) {
        const x = chans[c][i];
        const ax = Math.abs(x);
        if (ax > this.samplePeak) this.samplePeak = ax;
        // true peak estimate only where it can matter: the interpolated points
        // sit between the samples n/2 and n/2 - 1 back, so gate on those, not on x
        const h = this.hist[c];
        const n = h.length;
        h[this.histPos] = x;
        const near = Math.max(Math.abs(h[(this.histPos + n / 2) % n]), Math.abs(h[(this.histPos + n / 2 + 1) % n]));
        if (near > this.truePeak * 0.5) this.interp(c);
        const [f1, f2] = this.filters[c];
        const y = f2.process(f1.process(x));
        const sq = y * y;
        const r = this.ring[c];
        this.sums[c] += sq - r[this.ringPos];
        r[this.ringPos] = sq;
      }
      this.histPos = (this.histPos + 1) % this.hist[0].length;
      this.ringPos = (this.ringPos + 1) % this.blockSize;
      if (this.filled < this.blockSize) this.filled++;
      this.sinceStep++;
      if (this.filled === this.blockSize && this.sinceStep >= this.stepSize) {
        this.sinceStep = 0;
        let z = 0;
        for (let c = 0; c < C; c++) z += Math.max(0, this.sums[c]) / this.blockSize;
        this.blocks.push(z);
      }
    }
  }

  private interp(c: number): void {
    // Same 4x kernel as the master limiter (normalized branches; the former
    // 48-tap Blackman branches read up to +1 dB high at 1 kHz).
    const h = this.hist[c];
    const n = h.length;
    for (const k of TRUE_PEAK_KERNEL) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += k[j] * h[(this.histPos - j + n) % n];
      const a = Math.abs(acc);
      if (a > this.truePeak) this.truePeak = a;
    }
  }

  result(): { integratedLufs: number; samplePeakDb: number; truePeakDb: number } {
    const toL = (z: number) => -0.691 + 10 * Math.log10(Math.max(z, 1e-12));
    const abs = this.blocks.filter((z) => toL(z) > -70);
    let lufs = -70;
    if (abs.length) {
      const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
      const rel = toL(meanAbs) - 10;
      const gated = abs.filter((z) => toL(z) > rel);
      if (gated.length) lufs = toL(gated.reduce((a, b) => a + b, 0) / gated.length);
    }
    const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));
    const tp = Math.max(this.truePeak, this.samplePeak);
    return { integratedLufs: lufs, samplePeakDb: db(this.samplePeak), truePeakDb: db(tp) };
  }
}

/** Streaming 2:1 decimator with a windowed-sinc half-band lowpass. */
export class Decimator2 {
  private readonly h: Float64Array;
  private readonly buf: Float64Array;
  private pos = 0;
  private phase = 0;
  constructor() {
    const taps = 31;
    this.h = new Float64Array(taps);
    const c = (taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const x = (i - c) / 2;
      const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
      this.h[i] = s * w;
      sum += this.h[i];
    }
    for (let i = 0; i < taps; i++) this.h[i] /= sum;
    // stored twice, so the taps read the history oldest-first without a modulo
    this.buf = new Float64Array(2 * taps);
  }

  /** Pushes samples; returns decimated output samples appended to `out`. */
  push(x: Float32Array, len: number, out: (v: number) => void): void {
    const h = this.h;
    const n = h.length;
    const buf = this.buf;
    for (let i = 0; i < len; i++) {
      buf[this.pos] = buf[this.pos + n] = x[i];
      this.pos = this.pos + 1 === n ? 0 : this.pos + 1;
      this.phase ^= 1;
      if (this.phase === 0) {
        const p = this.pos;
        let acc = 0;
        for (let k = 0; k < n; k++) acc += h[k] * buf[p + k];
        out(acc);
      }
    }
  }
}
