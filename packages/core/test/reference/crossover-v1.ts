/** Isolator before the unity allpass path (CPU audit 2026-10-24): reference for equivalence tests. */
import { Biquad, BUTTERWORTH_Q, allpass, highpass, lowpass } from '../../src/dsp/biquad.ts';

export const LOW_MID_HZ = 180;
export const MID_HIGH_HZ = 2500;

/**
 * Three-band isolator built from Linkwitz-Riley 4th order crossovers.
 * With all band gains at 1 the output equals the input passed through a
 * 2nd order allpass, so the magnitude response is flat (no coloration).
 */
class ChannelSplitter {
  private lp1a: Biquad;
  private lp1b: Biquad;
  private hp1a: Biquad;
  private hp1b: Biquad;
  private lp2a: Biquad;
  private lp2b: Biquad;
  private hp2a: Biquad;
  private hp2b: Biquad;
  private ap2: Biquad;

  constructor(fs: number, f1: number, f2: number) {
    const q = BUTTERWORTH_Q;
    this.lp1a = new Biquad(lowpass(fs, f1, q));
    this.lp1b = new Biquad(lowpass(fs, f1, q));
    this.hp1a = new Biquad(highpass(fs, f1, q));
    this.hp1b = new Biquad(highpass(fs, f1, q));
    this.lp2a = new Biquad(lowpass(fs, f2, q));
    this.lp2b = new Biquad(lowpass(fs, f2, q));
    this.hp2a = new Biquad(highpass(fs, f2, q));
    this.hp2b = new Biquad(highpass(fs, f2, q));
    this.ap2 = new Biquad(allpass(fs, f2, q));
  }

  process(x: number, gl: number, gm: number, gh: number): number {
    const low = this.ap2.process(this.lp1b.process(this.lp1a.process(x)));
    const rest = this.hp1b.process(this.hp1a.process(x));
    const mid = this.lp2b.process(this.lp2a.process(rest));
    const high = this.hp2b.process(this.hp2a.process(rest));
    return gl * low + gm * mid + gh * high;
  }

  reset(): void {
    for (const b of [this.lp1a, this.lp1b, this.hp1a, this.hp1b, this.lp2a, this.lp2b, this.hp2a, this.hp2b, this.ap2]) b.reset();
  }
}

export class StereoIsolator {
  private l: ChannelSplitter;
  private r: ChannelSplitter;
  constructor(fs: number, f1 = LOW_MID_HZ, f2 = MID_HIGH_HZ) {
    this.l = new ChannelSplitter(fs, f1, f2);
    this.r = new ChannelSplitter(fs, f1, f2);
  }

  /**
   * Processes a block in place. Band gains are linearly interpolated from the
   * `from` values to the `to` values across the block to avoid zipper noise.
   */
  processBlock(
    L: Float32Array,
    R: Float32Array,
    start: number,
    end: number,
    from: [number, number, number],
    to: [number, number, number],
  ): void {
    const n = end - start;
    if (n <= 0) return;
    const dl = (to[0] - from[0]) / n;
    const dm = (to[1] - from[1]) / n;
    const dh = (to[2] - from[2]) / n;
    let gl = from[0];
    let gm = from[1];
    let gh = from[2];
    for (let i = start; i < end; i++) {
      L[i] = this.l.process(L[i], gl, gm, gh);
      R[i] = this.r.process(R[i], gl, gm, gh);
      gl += dl;
      gm += dm;
      gh += dh;
    }
  }

  reset(): void {
    this.l.reset();
    this.r.reset();
  }
}
