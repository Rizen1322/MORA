/** Taps per polyphase branch of the 4x true-peak interpolator. */
const TP_TAPS = 24;
/** Detection delay: the interpolator is centred TP_TAPS / 2 samples back. */
const TP_DELAY = TP_TAPS / 2;
/** Covers the residual +-0.05 dB error of the 4x grid with crest refinement. */
export const TRUE_PEAK_MARGIN = Math.pow(10, 0.05 / 20);

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

/**
 * Branches for the points 1/4, 2/4 and 3/4 of a sample after the detected
 * sample: full-band Kaiser (beta 6) windowed sinc, unity DC gain, matching
 * an independent long-sinc meter on bright masters (a 0.95-band kernel read
 * up to 0.011 dB low there). Without the crest refinement below and with 12
 * taps a 0.4 fs sine reached -0.56 dBTP for a -1 dBTP ceiling.
 */
export const TRUE_PEAK_KERNEL: readonly Float64Array[] = [1, 2, 3].map((k) => {
  const h = new Float64Array(TP_TAPS);
  let sum = 0;
  for (let j = 0; j < TP_TAPS; j++) {
    // tap j multiplies x[c - j]; the point sits TP_DELAY - k/4 samples back
    const d = TP_DELAY - j - k / 4;
    const u = d / (TP_DELAY + 0.25);
    const x = d;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    h[j] = sinc * besselI0(6 * Math.sqrt(1 - u * u));
    sum += h[j];
  }
  for (let j = 0; j < TP_TAPS; j++) h[j] /= sum;
  return h;
});

/** |b|, or the vertex of the parabola through (a, b, c) when b is a local extremum. */
function crest(a: number, b: number, c: number): number {
  const ab = Math.abs(b);
  const d = a - 2 * b + c;
  if (ab < Math.abs(a) || ab < Math.abs(c) || b * d >= 0) return ab;
  return Math.abs(b - ((a - c) * (a - c)) / (8 * d));
}

/**
 * Stereo lookahead true-peak limiter.
 *
 * Required gain comes from a 4x oversampled peak estimate: the sample itself
 * and the interpolated points on both sides of it. Gain envelope = two
 * cascaded moving averages (L/2 each, so a smooth S-shaped ramp without
 * corners) of a min-hold (length L+1) of the required gain. The combined
 * averaging support is L, so delayed peaks never exceed the threshold while
 * gain changes stay free of slope discontinuities. Audio is delayed by L plus
 * the interpolator's TP_DELAY.
 */
export class Limiter {
  /** Total audio delay in frames: envelope lookahead L + TP_DELAY. */
  readonly lookahead: number;
  private readonly histL = new Float32Array(2 * TP_TAPS);
  private readonly histR = new Float32Array(2 * TP_TAPS);
  private histPos = 0;
  /** Peak of the interpolated segment before the detected sample. */
  private prevSeg = 0;
  /** Last interpolated point (3/4) of the previous sample, per channel. */
  private prevCL = 0;
  private prevCR = 0;
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private readonly reqRing: Float32Array;
  private readonly envRing: Float32Array;
  private readonly ma1Ring: Float32Array;
  private envPos = 0;
  private ma1Pos = 0;
  private ma1Sum: number;
  private readonly half: number;
  private pos = 0;
  private env = 1;
  private envSum: number;
  private readonly relCoef: number;
  /** Monotonic deque of indices (absolute sample counters) into reqRing. */
  private readonly dq: Float64Array;
  private dqHead = 0;
  private dqTail = 0;
  private counter = 0;
  /** Minimum gain applied since the last call to `takeStats`. */
  private minGain = 1;

  constructor(
    readonly sampleRate: number,
    public threshold = Math.pow(10, -1 / 20),
    lookaheadMs = 5,
    releaseMs = 120,
  ) {
    // Both smoothing stages need at least one sample. A one-frame delay used
    // to create an empty second average and turn the output into NaN.
    const L = Math.max(2, Math.round((sampleRate * lookaheadMs) / 1000));
    this.lookahead = L + TP_DELAY;
    this.delayL = new Float32Array(this.lookahead);
    this.delayR = new Float32Array(this.lookahead);
    this.reqRing = new Float32Array(L + 1).fill(1);
    this.half = Math.max(1, Math.floor(L / 2));
    this.envRing = new Float32Array(this.half).fill(1);
    this.envSum = this.half;
    this.ma1Ring = new Float32Array(L - this.half).fill(1);
    this.ma1Sum = L - this.half;
    this.relCoef = 1 - Math.exp(-1 / ((sampleRate * releaseMs) / 1000));
    this.dq = new Float64Array(L + 2);
  }

  processBlock(L: Float32Array, R: Float32Array, start: number, end: number): void {
    const la = this.lookahead;
    const ringN = this.reqRing.length;
    const win = ringN - 1;
    const thr = this.threshold;
    const dqN = this.dq.length;
    const [k1, k2, k3] = TRUE_PEAK_KERNEL;
    const hL = this.histL;
    const hR = this.histR;
    for (let i = start; i < end; i++) {
      const xl = L[i];
      const xr = R[i];
      // History is stored twice so taps read x[c - j] contiguously at tp + j.
      const tp = this.histPos === 0 ? TP_TAPS - 1 : this.histPos - 1;
      this.histPos = tp;
      hL[tp] = hL[tp + TP_TAPS] = xl;
      hR[tp] = hR[tp + TP_TAPS] = xr;
      let al = 0, bl = 0, cl = 0, ar = 0, br = 0, cr = 0;
      for (let j = 0; j < TP_TAPS; j++) {
        const vl = hL[tp + j];
        const vr = hR[tp + j];
        al += k1[j] * vl;
        bl += k2[j] * vl;
        cl += k3[j] * vl;
        ar += k1[j] * vr;
        br += k2[j] * vr;
        cr += k3[j] * vr;
      }
      // Sample x[c - TP_DELAY], the three points after it and the vertices of
      // parabolas through neighbouring points: a 4x grid alone misses up to
      // 0.45 dB of a crest near 0.4 fs (the output reached -0.56 dBTP).
      const sl = hL[tp + TP_DELAY], sr = hR[tp + TP_DELAY];
      const nl = hL[tp + TP_DELAY - 1], nr = hR[tp + TP_DELAY - 1];
      const seg = Math.max(
        crest(this.prevCL, sl, al), crest(sl, al, bl), crest(al, bl, cl), crest(bl, cl, nl),
        crest(this.prevCR, sr, ar), crest(sr, ar, br), crest(ar, br, cr), crest(br, cr, nr),
      );
      this.prevCL = cl;
      this.prevCR = cr;
      const peak = Math.max(seg, this.prevSeg) * TRUE_PEAK_MARGIN;
      this.prevSeg = seg;
      const req = peak > thr ? thr / peak : 1;
      const c = this.counter++;
      this.reqRing[c % ringN] = req;
      // push into monotonic deque (keep increasing values from head to tail)
      while (this.dqTail !== this.dqHead) {
        const lastIdx = this.dq[(this.dqTail - 1 + dqN) % dqN];
        if (this.reqRing[lastIdx % ringN] >= req) this.dqTail = (this.dqTail - 1 + dqN) % dqN;
        else break;
      }
      this.dq[this.dqTail] = c;
      this.dqTail = (this.dqTail + 1) % dqN;
      // drop indices that left the window [c - win, c]
      while (this.dq[this.dqHead] < c - win) this.dqHead = (this.dqHead + 1) % dqN;
      const minReq = this.reqRing[this.dq[this.dqHead] % ringN];

      if (minReq < this.env) this.env = minReq;
      else this.env += (minReq - this.env) * this.relCoef;

      const p = this.pos;
      // first moving average (length half) over the held envelope
      // This cursor is independent of the audio delay. In particular, 5 ms
      // at 44.1 kHz is 221 frames, which is not divisible by half=110.
      // Deriving hp from p repeated an entry every time the delay wrapped.
      const hp = this.envPos;
      const e = Math.fround(this.env);
      this.envSum += e - this.envRing[hp];
      this.envRing[hp] = e;
      this.envPos = hp + 1 === this.half ? 0 : hp + 1;
      const m1 = Math.fround(Math.min(1, this.envSum / this.half));
      // second moving average (length L - half) over the first
      const n2 = this.ma1Ring.length;
      const qp = this.ma1Pos;
      this.ma1Sum += m1 - this.ma1Ring[qp];
      this.ma1Ring[qp] = m1;
      this.ma1Pos = qp + 1 === n2 ? 0 : qp + 1;
      if (p === 0) {
        // re-sum once per lookahead period to stop floating point drift
        let a = 0;
        for (let k = 0; k < this.half; k++) a += this.envRing[k];
        this.envSum = a;
        let b = 0;
        for (let k = 0; k < n2; k++) b += this.ma1Ring[k];
        this.ma1Sum = b;
      }
      const g = Math.min(1, this.ma1Sum / n2);

      const dl = this.delayL[p];
      const dr = this.delayR[p];
      this.delayL[p] = xl;
      this.delayR[p] = xr;
      this.pos = p + 1 === la ? 0 : p + 1;

      if (g < this.minGain) this.minGain = g;
      L[i] = dl * g;
      R[i] = dr * g;
    }
  }

  takeStats(): { minGainDb: number } {
    const stats = this.getStats();
    this.minGain = 1;
    return stats;
  }

  getStats(): { minGainDb: number } {
    return { minGainDb: 20 * Math.log10(Math.max(this.minGain, 1e-9)) };
  }

  reset(): void {
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.histL.fill(0);
    this.histR.fill(0);
    this.histPos = 0;
    this.prevSeg = 0;
    this.prevCL = this.prevCR = 0;
    this.reqRing.fill(1);
    this.envRing.fill(1);
    this.envSum = this.half;
    this.envPos = 0;
    this.ma1Ring.fill(1);
    this.ma1Sum = this.ma1Ring.length;
    this.ma1Pos = 0;
    this.env = 1;
    this.dqHead = this.dqTail = 0;
    this.counter = 0;
    this.pos = 0;
    this.minGain = 1;
  }
}
