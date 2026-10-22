/** RBJ audio EQ cookbook biquads, transposed direct form II. */
export interface BiquadCoefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoefs {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function lowpass(fs: number, f0: number, q: number): BiquadCoefs {
  const w = (2 * Math.PI * f0) / fs;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  return norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
}

export function highpass(fs: number, f0: number, q: number): BiquadCoefs {
  const w = (2 * Math.PI * f0) / fs;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  return norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
}

export function allpass(fs: number, f0: number, q: number): BiquadCoefs {
  const w = (2 * Math.PI * f0) / fs;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  return norm(1 - alpha, -2 * c, 1 + alpha, 1 + alpha, -2 * c, 1 - alpha);
}

export function highshelf(fs: number, f0: number, gainDb: number, q: number): BiquadCoefs {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / fs;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const sq = 2 * Math.sqrt(A) * alpha;
  return norm(
    A * (A + 1 + (A - 1) * c + sq),
    -2 * A * (A - 1 + (A + 1) * c),
    A * (A + 1 + (A - 1) * c - sq),
    A + 1 - (A - 1) * c + sq,
    2 * (A - 1 - (A + 1) * c),
    A + 1 - (A - 1) * c - sq,
  );
}

/** RBJ peaking EQ ("bell"). */
export function peaking(fs: number, f0: number, gainDb: number, q: number): BiquadCoefs {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / fs;
  const c = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  return norm(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A);
}

/** |H(e^jw)| of one section at frequency f. */
export function magnitude(c: BiquadCoefs, fs: number, f: number): number {
  const w = (2 * Math.PI * f) / fs;
  const cr = Math.cos(w), ci = -Math.sin(w), c2r = Math.cos(2 * w), c2i = -Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cr + c.b2 * c2r, ni = c.b1 * ci + c.b2 * c2i;
  const dr = 1 + c.a1 * cr + c.a2 * c2r, di = c.a1 * ci + c.a2 * c2i;
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

export class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(public c: BiquadCoefs) {}

  process(x: number): number {
    const c = this.c;
    const y = c.b0 * x + this.z1;
    this.z1 = c.b1 * x - c.a1 * y + this.z2;
    this.z2 = c.b2 * x - c.a2 * y;
    return y;
  }

  processBuffer(buf: Float32Array | Float64Array, start = 0, end = buf.length): void {
    const c = this.c;
    let z1 = this.z1;
    let z2 = this.z2;
    for (let i = start; i < end; i++) {
      const x = buf[i];
      const y = c.b0 * x + z1;
      z1 = c.b1 * x - c.a1 * y + z2;
      z2 = c.b2 * x - c.a2 * y;
      buf[i] = y;
    }
    this.z1 = z1;
    this.z2 = z2;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/** Linkwitz-Riley 4th order = two cascaded Butterworth (Q = 1/sqrt2) sections. */
export const BUTTERWORTH_Q = Math.SQRT1_2;
