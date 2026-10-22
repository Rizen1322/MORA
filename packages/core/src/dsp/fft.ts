/** In-place iterative radix-2 complex FFT with precomputed tables. */
export class FFT {
  readonly n: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }

  /** Forward transform (sign -1). `re` and `im` are modified in place. */
  forward(re: Float64Array, im: Float64Array): void {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  /** Inverse transform, scaled by 1/n. */
  inverse(re: Float64Array, im: Float64Array): void {
    for (let i = 0; i < this.n; i++) im[i] = -im[i];
    this.forward(re, im);
    const s = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] *= s;
      im[i] = -im[i] * s;
    }
  }
}

const fftCache = new Map<number, FFT>();
export function getFFT(n: number): FFT {
  let f = fftCache.get(n);
  if (!f) {
    f = new FFT(n);
    fftCache.set(n, f);
  }
  return f;
}

export function hann(n: number, periodic = true): Float64Array {
  const w = new Float64Array(n);
  const d = periodic ? n : n - 1;
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / d);
  return w;
}

export function nextPow2(x: number): number {
  let p = 1;
  while (p < x) p <<= 1;
  return p;
}

/** Autocorrelation of a real signal via FFT. Returns lags 0..maxLag. */
export function autocorrelate(x: ArrayLike<number>, maxLag: number): Float64Array {
  const n = nextPow2(x.length * 2);
  const fft = getFFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < x.length; i++) re[i] = x[i];
  fft.forward(re, im);
  for (let i = 0; i < n; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft.inverse(re, im);
  const out = new Float64Array(maxLag + 1);
  for (let i = 0; i <= maxLag && i < n; i++) out[i] = re[i];
  return out;
}
