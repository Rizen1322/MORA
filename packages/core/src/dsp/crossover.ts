import { Biquad, BUTTERWORTH_Q, allpass, highpass, lowpass } from './biquad.ts';

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
  /** Unity-gain equivalent: LR4 low + high sums to a 2nd order allpass, so all bands at 1 = AP2(AP1(x)). */
  private uni1: Biquad;
  private uni2: Biquad;

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
    this.uni1 = new Biquad(allpass(fs, f1, q));
    this.uni2 = new Biquad(allpass(fs, f2, q));
  }

  process(x: number, gl: number, gm: number, gh: number): number {
    const low = this.ap2.process(this.lp1b.process(this.lp1a.process(x)));
    const rest = this.hp1b.process(this.hp1a.process(x));
    const mid = this.lp2b.process(this.lp2a.process(rest));
    const high = this.hp2b.process(this.hp2a.process(rest));
    return gl * low + gm * mid + gh * high;
  }

  processUnity(x: number): number {
    return this.uni2.process(this.uni1.process(x));
  }

  reset(): void {
    for (const b of [this.lp1a, this.lp1b, this.hp1a, this.hp1b, this.lp2a, this.lp2b, this.hp2a, this.hp2b, this.ap2, this.uni1, this.uni2]) b.reset();
  }
}

/**
 * Samples a chain must run on the same input before its output may replace the other one: its
 * slowest pole (180 Hz, Q 0.707) forgets a stale state by e^-40 (-350 dB) in 50 ms.
 */
const WARM_SECONDS = 0.05;

export class StereoIsolator {
  private l: ChannelSplitter;
  private r: ChannelSplitter;
  /**
   * Set by the owner while no band move is expected (no transition armed for this deck). Then
   * unity blocks run only the 2-section allpass equivalent (2 instead of 9 biquads per channel).
   * Without it the three-band chain stays current, warming up behind the allpass output first.
   */
  idle = false;
  private readonly warmFrames: number;
  /** Samples each chain has run on the actual input since it was last skipped (reset: exact). */
  private fullWarm = Infinity;
  private uniWarm = Infinity;
  constructor(fs: number, f1 = LOW_MID_HZ, f2 = MID_HIGH_HZ) {
    this.l = new ChannelSplitter(fs, f1, f2);
    this.r = new ChannelSplitter(fs, f1, f2);
    this.warmFrames = Math.round(fs * WARM_SECONDS);
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
    const unity = from[0] === 1 && from[1] === 1 && from[2] === 1 && to[0] === 1 && to[1] === 1 && to[2] === 1;
    const fullReady = this.fullWarm >= this.warmFrames, uniReady = this.uniWarm >= this.warmFrames;
    const useUni = unity && uniReady && (this.idle || !fullReady);
    const runFull = !useUni || (!this.idle && !fullReady);
    const runUni = useUni || (unity && this.idle && !uniReady);
    this.fullWarm = runFull ? this.fullWarm + n : 0;
    this.uniWarm = runUni ? this.uniWarm + n : 0;
    const l = this.l, r = this.r;
    if (!runFull) {
      for (let i = start; i < end; i++) {
        L[i] = l.processUnity(L[i]);
        R[i] = r.processUnity(R[i]);
      }
      return;
    }
    if (runUni) {
      // one chain warms up on the same input while the other one is heard
      for (let i = start; i < end; i++) {
        const xl = L[i], xr = R[i];
        const ul = l.processUnity(xl), ur = r.processUnity(xr);
        const fl = l.process(xl, 1, 1, 1), fr = r.process(xr, 1, 1, 1);
        L[i] = useUni ? ul : fl;
        R[i] = useUni ? ur : fr;
      }
      return;
    }
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
    this.fullWarm = this.uniWarm = Infinity;
  }
}
