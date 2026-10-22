import { Decimator2, LoudnessMeter } from '../dsp/loudness.ts';
import type { TrackAnalysis } from '../types.ts';
import { analyzeTrack, type AnalyzeOptions } from './analyze.ts';

/** Frames per stereo-cancellation decision (~1.5 s at 44100 Hz). */
const GUARD_WINDOW = 65536;

/**
 * Streaming front-end for the analyzer: feed stereo PCM at 44100 Hz in blocks,
 * get loudness on the full-rate signal and a 22050 Hz mono signal for MIR.
 */
export class AnalysisAccumulator {
  private meter = new LoudnessMeter(44100, 2);
  private dec = new Decimator2();
  private mono: Float32Array;
  private len = 0;
  private tmp = new Float32Array(GUARD_WINDOW);
  // Input is regrouped into fixed windows so the result does not depend on the caller's block size.
  private pendL = new Float32Array(GUARD_WINDOW);
  private pendR = new Float32Array(GUARD_WINDOW);
  private pending = 0;
  private cancellationGuard = false;
  frames = 0;

  constructor(expectedSeconds = 300) {
    this.mono = new Float32Array(Math.ceil(Math.max(0, Math.min(600, Number.isFinite(expectedSeconds) ? expectedSeconds : 300)) * 22050) + 1024);
  }

  push(L: Float32Array, R: Float32Array, n = L.length): void {
    if (!Number.isInteger(n) || n < 0 || n > L.length || n > R.length) throw new RangeError('PCM channel lengths do not match the block size');
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new TypeError('PCM contains non-finite samples');
    }
    for (let i = 0; i < n; ) {
      const take = Math.min(n - i, GUARD_WINDOW - this.pending);
      this.pendL.set(L.subarray(i, i + take), this.pending);
      this.pendR.set(R.subarray(i, i + take), this.pending);
      this.pending += take;
      i += take;
      if (this.pending === GUARD_WINDOW) this.flush();
    }
    this.frames += n;
  }

  private flush(): void {
    const n = this.pending;
    if (n === 0) return;
    this.pending = 0;
    const L = this.pendL;
    const R = this.pendR;
    let monoPower = 0;
    let leftPower = 0;
    let rightPower = 0;
    for (let i = 0; i < n; i++) {
      const mid = (L[i] + R[i]) * 0.5;
      this.tmp[i] = mid;
      monoPower += mid * mid;
      leftPower += L[i] * L[i];
      rightPower += R[i] * R[i];
    }
    // An out-of-phase stereo recording must not look silent to MIR. Loudness is
    // still measured from both original channels; only the analysis fold-down changes.
    if (monoPower < Math.max(leftPower, rightPower) * 0.05 && Math.max(leftPower, rightPower) > 1e-12) {
      this.tmp.set((leftPower >= rightPower ? L : R).subarray(0, n));
      this.cancellationGuard = true;
    }
    this.meter.push([L, R], n);
    this.dec.push(this.tmp, n, (v) => {
      if (this.len >= this.mono.length) {
        const grown = new Float32Array(this.mono.length * 2);
        grown.set(this.mono);
        this.mono = grown;
      }
      this.mono[this.len++] = v;
    });
  }

  finish(opts?: AnalyzeOptions): TrackAnalysis {
    this.flush();
    const loud = this.meter.result();
    const analysis = analyzeTrack({ mono: this.mono.subarray(0, this.len), loudness: loud, duration: this.frames / 44100 }, opts);
    if (this.cancellationGuard) analysis.warnings.push('stereo-cancellation-guard');
    return analysis;
  }
}

/** Convenience: analyze whole in-memory stereo PCM at 44100 Hz. */
export function analyzePcm(L: Float32Array, R: Float32Array, opts?: AnalyzeOptions): TrackAnalysis {
  const acc = new AnalysisAccumulator(L.length / 44100);
  const block = 65536;
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    acc.push(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return acc.finish(opts);
}
