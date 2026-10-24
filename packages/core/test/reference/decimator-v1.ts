/** Decimator2 before the doubled history buffer (CPU audit 2026-10-24): reference for equivalence tests. */
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
    this.buf = new Float64Array(taps);
  }

  /** Pushes samples; returns decimated output samples appended to `out`. */
  push(x: Float32Array, len: number, out: (v: number) => void): void {
    const h = this.h;
    const n = h.length;
    for (let i = 0; i < len; i++) {
      this.buf[this.pos] = x[i];
      this.pos = (this.pos + 1) % n;
      this.phase ^= 1;
      if (this.phase === 0) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += h[k] * this.buf[(this.pos + k) % n];
        out(acc);
      }
    }
  }
}
