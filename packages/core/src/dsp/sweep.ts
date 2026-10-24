/** Stereo TPT state-variable DJ filter. No allocations in processBlock.
 * -1: low-pass to 180 Hz; 0: exact bypass; +1: high-pass to 6 kHz.
 * Butterworth damping, no resonant boost. Coefficients update at control rate.
 */
export class StereoSweep {
  private value = 0;
  private l1 = 0; private l2 = 0; private r1 = 0; private r2 = 0;
  private mode = 1;
  private control = 0;
  private a1 = 1; private a2 = 0; private a3 = 0;
  private readonly smoothing: number;
  constructor(private readonly sampleRate: number) { this.smoothing = 1 - Math.exp(-1 / (sampleRate * .02)); }
  reset(): void { this.value = this.l1 = this.l2 = this.r1 = this.r2 = 0; this.control = 0; this.mode = 1; }
  processBlock(L: Float32Array, R: Float32Array, n: number, from: number, to: number): void {
    from = Number.isFinite(from) ? Math.max(-1, Math.min(1, from)) : 0;
    to = Number.isFinite(to) ? Math.max(-1, Math.min(1, to)) : 0;
    if (!from && !to && Math.abs(this.value) < 1e-6) { this.reset(); return; }
    const step = (to - from) / Math.max(1, n), k = Math.SQRT2;
    let target = from;
    for (let i = 0; i < n; i++, target += step) {
      this.value += (target - this.value) * this.smoothing;
      const amount = Math.abs(this.value), mode = this.value < 0 ? -1 : 1;
      if (mode !== this.mode) { this.mode = mode; this.l1 = this.l2 = this.r1 = this.r2 = 0; this.control = 0; }
      if (this.control-- <= 0) {
        const upper = this.sampleRate * .45;
        const cutoff = mode > 0 ? 20 * Math.exp(Math.log(Math.min(6000, upper) / 20) * amount) : upper * Math.exp(Math.log(180 / upper) * amount);
        const g = Math.tan(Math.PI * cutoff / this.sampleRate);
        this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2; this.control = 15;
      }
      const xL = L[i], xR = R[i];
      const vL = xL - this.l2, vR = xR - this.r2;
      const bL = this.a1 * this.l1 + this.a2 * vL, bR = this.a1 * this.r1 + this.a2 * vR;
      const lowL = this.l2 + this.a2 * this.l1 + this.a3 * vL, lowR = this.r2 + this.a2 * this.r1 + this.a3 * vR;
      this.l1 = 2 * bL - this.l1; this.r1 = 2 * bR - this.r1;
      this.l2 = 2 * lowL - this.l2; this.r2 = 2 * lowR - this.r2;
      const wet = Math.min(1, amount / .08);
      const filteredL = mode > 0 ? xL - k * bL - lowL : lowL;
      const filteredR = mode > 0 ? xR - k * bR - lowR : lowR;
      L[i] = xL + (filteredL - xL) * wet; R[i] = xR + (filteredR - xR) * wet;
    }
  }
}
