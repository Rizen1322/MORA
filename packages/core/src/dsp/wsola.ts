import { hann } from './fft.ts';

/** Random-access PCM provider used by decks and the stretcher. */
export interface PcmSource {
  readonly totalFrames: number;
  /**
   * Copies frames [start, start + len) into `outL/outR` at `offset`.
   * Frames outside [0, totalFrames) are written as zeros.
   * Returns false when some required in-range frames are not loaded yet.
   */
  read(start: number, len: number, outL: Float32Array, outR: Float32Array, offset: number): boolean;
}

/**
 * Streaming WSOLA (waveform similarity overlap-add) time stretcher with a
 * variable ratio. Pitch is preserved because frames are copied, not resampled.
 *
 * ratio = input frames consumed per output frame (1.05 = 5 % faster).
 * At ratio 1 the stretcher degenerates to an exact identity (Hann frames at
 * 50 % overlap sum to one), so playback outside transitions is bit-transparent
 * apart from float rounding.
 */
export class Wsola {
  readonly W: number;
  readonly H: number;
  readonly tol: number;
  private readonly win: Float64Array;
  private readonly accL: Float32Array;
  private readonly accR: Float32Array;
  private readonly fifoL: Float32Array;
  private readonly fifoR: Float32Array;
  private fifoRead = 0;
  private fifoLen = 0;
  /** Input position of fifo[0]. */
  private fifoStart = 0;
  private prevStart: number | null = null;
  private nominal = 0;
  private readonly frameL: Float32Array;
  private readonly frameR: Float32Array;
  private readonly searchL: Float32Array;
  private readonly searchR: Float32Array;
  private readonly natL: Float32Array;
  private readonly natR: Float32Array;
  /** Box-decimation factor of the coarse search and its buffers. */
  private readonly D: number;
  private readonly boxL: Float32Array;
  private readonly boxR: Float32Array;
  private readonly natBoxL: Float32Array;
  private readonly natBoxR: Float32Array;
  /** Last search offset, exposed for diagnostics/tests. */
  lastOffset = 0;
  /**
   * Optional side signal stretched with exactly the same frame offsets as the
   * main source (chosen from the main signal only), so it stays sample-aligned
   * with it. A missing side frame is silence; it never stalls playback.
   */
  private side: PcmSource | null = null;
  private readonly sideAccL: Float32Array;
  private readonly sideAccR: Float32Array;
  private readonly sideFifoL: Float32Array;
  private readonly sideFifoR: Float32Array;

  /** Overlap-add normalization for the chosen overlap (Hann sums to W / 2H). */
  private readonly norm: number;
  /** Length of the waveform-similarity comparison region. */
  private readonly C: number;
  /** Inner search range (the former tolerance): preferred when as good. */
  private readonly near: number;

  constructor(
    readonly sampleRate: number,
    private readonly source: PcmSource,
    opts: { windowMs?: number; overlap?: 2 | 4; toleranceMs?: number } = {},
  ) {
    const overlap = opts.overlap ?? 2;
    let W = Math.round((sampleRate * (opts.windowMs ?? 40)) / 1000);
    W = Math.ceil(W / (2 * overlap)) * 2 * overlap;
    this.W = W;
    this.H = W / overlap;
    this.norm = 2 / overlap;
    this.C = Math.min(W - this.H, this.H * 2);
    // ±12 ms reaches a matching cycle of bass down to ~42 Hz. With ±6 ms a
    // 50 Hz bass often had no in-phase candidate and beat (SNR 6-11 dB at 3-8 %).
    this.tol = Math.round((sampleRate * (opts.toleranceMs ?? 12)) / 1000);
    this.near = Math.round(sampleRate * 0.006);
    this.win = hann(W, true);
    this.accL = new Float32Array(W);
    this.accR = new Float32Array(W);
    this.fifoL = new Float32Array(this.H);
    this.fifoR = new Float32Array(this.H);
    this.frameL = new Float32Array(W);
    this.frameR = new Float32Array(W);
    const sLen = this.C + 2 * this.tol + 2;
    this.searchL = new Float32Array(sLen);
    this.searchR = new Float32Array(sLen);
    this.natL = new Float32Array(this.C);
    this.natR = new Float32Array(this.C);
    this.D = Math.max(2, Math.round(sampleRate / 11025));
    this.boxL = new Float32Array(Math.ceil(sLen / this.D) + 1);
    this.boxR = new Float32Array(this.boxL.length);
    this.natBoxL = new Float32Array(Math.ceil(this.C / this.D) + 1);
    this.natBoxR = new Float32Array(this.natBoxL.length);
    this.sideAccL = new Float32Array(W);
    this.sideAccR = new Float32Array(W);
    this.sideFifoL = new Float32Array(this.H);
    this.sideFifoR = new Float32Array(this.H);
  }

  /** Starts (or stops, with null) the aligned side signal; its history starts empty. */
  setSide(source: PcmSource | null): void {
    this.side = source;
    this.sideAccL.fill(0);
    this.sideAccR.fill(0);
    this.sideFifoL.fill(0);
    this.sideFifoR.fill(0);
  }

  hasSide(): boolean {
    return this.side !== null;
  }

  /** Restarts at an input position. Output fades in over H frames. */
  reset(position: number): void {
    this.accL.fill(0);
    this.accR.fill(0);
    this.sideAccL.fill(0);
    this.sideAccR.fill(0);
    this.fifoRead = 0;
    this.fifoLen = 0;
    this.prevStart = null;
    this.nominal = position;
    this.fifoStart = Math.round(position);
    this.lastOffset = 0;
  }

  /** Input position (frames) that corresponds to the next output sample. */
  position(): number {
    if (this.fifoLen > this.fifoRead) return this.fifoStart + this.fifoRead;
    return this.prevStart === null ? this.nominal : this.prevStart + this.H;
  }

  /**
   * Renders `n` frames into outL/outR at `offset`.
   * `ratioAt(k)` is called once per hop with the number of frames already
   * produced in this call, so callers can evaluate tempo automation.
   * Returns the number of frames produced (less than n on underrun).
   */
  render(
    outL: Float32Array,
    outR: Float32Array,
    offset: number,
    n: number,
    ratioAt: (producedSoFar: number) => number,
    sideL?: Float32Array,
    sideR?: Float32Array,
  ): number {
    let produced = 0;
    const side = !!(sideL && sideR && this.side);
    while (produced < n) {
      if (this.fifoRead >= this.fifoLen) {
        if (!this.hop(ratioAt(produced))) break;
      }
      const take = Math.min(n - produced, this.fifoLen - this.fifoRead);
      for (let i = 0; i < take; i++) {
        outL[offset + produced + i] = this.fifoL[this.fifoRead + i];
        outR[offset + produced + i] = this.fifoR[this.fifoRead + i];
      }
      if (side) {
        for (let i = 0; i < take; i++) {
          sideL![offset + produced + i] = this.sideFifoL[this.fifoRead + i];
          sideR![offset + produced + i] = this.sideFifoR[this.fifoRead + i];
        }
      }
      this.fifoRead += take;
      produced += take;
    }
    return produced;
  }

  private hop(ratio: number): boolean {
    const H = this.H;
    const W = this.W;
    let s: number;
    if (this.prevStart === null) {
      s = Math.round(this.nominal);
    } else if (Math.abs(ratio - 1) < 1e-9) {
      s = this.prevStart + H;
      this.nominal = s;
    } else {
      const natural = this.prevStart + H;
      const drift = natural - this.nominal;
      const t = this.transientAhead(natural);
      if (t === null) return false;
      // drift can reach tol + H * |ratio - 1|: a smaller bound let attacks be searched
      // (shifted) and heard twice, +1 dB peaks on a real beatmatch
      if (t && Math.abs(drift) < this.tol * 2) {
        // an attack is coming: never shift it (a shifted copy would be heard twice, a "flam");
        // the small timing drift is absorbed by the following non-transient hops
        s = natural;
        this.lastOffset = Math.round(drift);
      } else {
        const found = this.search(Math.round(this.nominal), natural);
        if (found === null) return false;
        s = found;
      }
    }
    if (!this.source.read(s, W, this.frameL, this.frameR, 0)) return false;
    const w = this.win;
    const aL = this.accL;
    const aR = this.accR;
    const g = this.norm;
    for (let i = 0; i < W; i++) {
      aL[i] += this.frameL[i] * w[i] * g;
      aR[i] += this.frameR[i] * w[i] * g;
    }
    for (let i = 0; i < H; i++) {
      this.fifoL[i] = aL[i];
      this.fifoR[i] = aR[i];
    }
    aL.copyWithin(0, H, W);
    aR.copyWithin(0, H, W);
    aL.fill(0, W - H);
    aR.fill(0, W - H);
    if (this.side) {
      // frame buffers are free again: reuse them for the side frame at the same start
      if (!this.side.read(s, W, this.frameL, this.frameR, 0)) {
        this.frameL.fill(0);
        this.frameR.fill(0);
      }
      const sL = this.sideAccL;
      const sR = this.sideAccR;
      for (let i = 0; i < W; i++) {
        sL[i] += this.frameL[i] * w[i] * g;
        sR[i] += this.frameR[i] * w[i] * g;
      }
      for (let i = 0; i < H; i++) {
        this.sideFifoL[i] = sL[i];
        this.sideFifoR[i] = sR[i];
      }
      sL.copyWithin(0, H, W);
      sR.copyWithin(0, H, W);
      sL.fill(0, W - H);
      sR.fill(0, W - H);
    }
    this.fifoStart = s;
    this.fifoRead = 0;
    this.fifoLen = H;
    if (this.prevStart === null) this.nominal = s;
    this.prevStart = s;
    this.nominal += H * ratio;
    return true;
  }

  /**
   * True when a sharp attack starts inside the next frame's overlap region
   * (energy of a 2.9 ms block jumps well above the preceding level).
   * Returns null when the audio is not loaded yet.
   */
  private transientAhead(natural: number): boolean | null {
    const W = this.W;
    if (!this.source.read(natural, W, this.frameL, this.frameR, 0)) return null;
    // Keep enough samples per energy estimate at low rates: very short blocks
    // can mistake individual waveform cycles for attacks and bias beat phase.
    // Above 44.1 kHz scale the block to retain the same physical attack window.
    const B = Math.max(128, Math.round(this.sampleRate * 128 / 44100));
    const nb = Math.floor(W / B);
    let prev = 0;
    let running = 0;
    for (let b = 0; b < nb; b++) {
      let e = 0;
      for (let i = b * B; i < (b + 1) * B; i++) {
        // Summing the channels would cancel wide/anti-phase stereo material.
        e += this.frameL[i] * this.frameL[i] + this.frameR[i] * this.frameR[i];
      }
      e /= B;
      if (b >= 2 && e > 1e-6 && e > 6 * Math.max(prev, running / b)) return true;
      prev = e;
      running += e;
    }
    return false;
  }

  /** Finds the frame start near `target` that best continues the waveform at `natural`. */
  private search(target: number, natural: number): number | null {
    const H = this.C;
    const tol = this.tol;
    const base = target - tol;
    const len = H + 2 * tol + 1;
    if (!this.source.read(base, len, this.searchL, this.searchR, 0)) return null;
    if (!this.source.read(natural, H, this.natL, this.natR, 0)) return null;
    let natEnergy = 0;
    for (let i = 0; i < H; i++) {
      natEnergy += this.natL[i] * this.natL[i] + this.natR[i] * this.natR[i];
    }
    if (natEnergy < 1e-12) {
      this.lastOffset = 0;
      return target;
    }
    // Coarse pass on 4:1 (about 11 kHz) box-decimated copies: a +-12 ms range
    // at full rate cost up to 2.4 ms of a 2.67 ms quantum at 48 kHz when both
    // decks hopped together. The box keeps the bass/mid alignment that drives
    // the choice; the full-rate refinement below restores the fine phase.
    const D = this.D;
    const bL = this.boxL, bR = this.boxR, nL = this.natBoxL, nR = this.natBoxR;
    const nb = Math.floor(H / D);
    const sb = Math.floor((2 * tol) / D) + nb;
    for (let k = 0; k < sb; k++) {
      let l = 0, r = 0;
      for (let j = k * D; j < k * D + D; j++) { l += this.searchL[j]; r += this.searchR[j]; }
      bL[k] = l; bR[k] = r;
    }
    for (let k = 0; k < nb; k++) {
      let l = 0, r = 0;
      for (let j = k * D; j < k * D + D; j++) { l += this.natL[j]; r += this.natR[j]; }
      nL[k] = l; nR[k] = r;
    }
    let e = 1e-9;
    for (let k = 0; k < nb; k++) e += bL[k] * bL[k] + bR[k] * bR[k];
    let best = 0;
    let bestScore = -Infinity;
    let near = 0;
    let nearScore = -Infinity;
    const inner = this.near;
    for (let j = 0; j + nb <= sb; j++) {
      if (j > 0) {
        const o = j - 1, a = j + nb - 1;
        e += bL[a] * bL[a] + bR[a] * bR[a] - bL[o] * bL[o] - bR[o] * bR[o];
      }
      let c = 0;
      for (let k = 0; k < nb; k++) c += bL[j + k] * nL[k] + bR[j + k] * nR[k];
      const score = c / Math.sqrt(Math.max(e, 1e-9));
      if (score > bestScore) {
        bestScore = score;
        best = j * D;
      }
      if (Math.abs(j * D - tol) <= inner && score > nearScore) {
        nearScore = score;
        near = j * D;
      }
    }
    // Prefer the inner +-6 ms range (smaller beat drift) unless the wider range
    // matches better by more than 1 % of |natural|. Larger margins already
    // gave bass phase jumps back (SNR 33 -> 13 dB at 3 %).
    let natBox = 0;
    for (let k = 0; k < nb; k++) natBox += nL[k] * nL[k] + nR[k] * nR[k];
    if (nearScore >= bestScore - 0.01 * Math.sqrt(natBox)) best = near;
    const stride = D;
    // refine at full resolution
    const lo = Math.max(0, best - stride);
    const hi = Math.min(2 * tol, best + stride);
    bestScore = -Infinity;
    let refined = best;
    for (let d = lo; d <= hi; d++) {
      let c = 0;
      let e = 1e-9;
      for (let i = 0; i < H; i++) {
        const l = this.searchL[d + i];
        const r = this.searchR[d + i];
        c += l * this.natL[i] + r * this.natR[i];
        e += l * l + r * r;
      }
      const score = c / Math.sqrt(e);
      if (score > bestScore) {
        bestScore = score;
        refined = d;
      }
    }
    this.lastOffset = refined - tol;
    return base + refined;
  }
}

/** PCM source backed by whole in-memory arrays (tests, offline render). */
export class ArraySource implements PcmSource {
  readonly totalFrames: number;
  constructor(
    readonly L: Float32Array,
    readonly R: Float32Array = L,
  ) {
    this.totalFrames = L.length;
  }
  read(start: number, len: number, outL: Float32Array, outR: Float32Array, offset: number): boolean {
    const total = this.totalFrames;
    for (let i = 0; i < len; i++) {
      const p = start + i;
      if (p < 0 || p >= total) {
        outL[offset + i] = 0;
        outR[offset + i] = 0;
      } else {
        outL[offset + i] = this.L[p];
        outR[offset + i] = this.R[p];
      }
    }
    return true;
  }
}
