import { describe, expect, it } from 'vitest';
import { Limiter, TRUE_PEAK_KERNEL, TRUE_PEAK_MARGIN } from '../src/dsp/limiter.ts';
import { ArraySource, Wsola } from '../src/dsp/wsola.ts';

function maximumError(a: Float32Array, b: Float32Array): number {
  let error = 0;
  for (let i = 0; i < a.length; i++) error = Math.max(error, Math.abs(a[i] - b[i]));
  return error;
}

/**
 * Independent, deliberately slow envelope reference with chronological windows.
 * `delay` is the envelope lookahead; detection adds the interpolator's centre delay.
 */
function referenceLimiter(input: Float32Array, sampleRate: number, threshold: number, delay: number): Float32Array {
  const half = Math.max(1, Math.floor(delay / 2));
  const second = delay - half;
  const release = 1 - Math.exp(-1 / (sampleRate * 0.12));
  const centre = TRUE_PEAK_KERNEL[0].length / 2;
  const at = (n: number) => (n >= 0 && n < input.length ? input[n] : 0);
  // Sample n (k = 0) or the interpolated point k/4 of a sample after it.
  const point = (n: number, k: number) => {
    if (k === 0) return at(n);
    let y = 0;
    TRUE_PEAK_KERNEL[k - 1].forEach((h, j) => (y += h * at(n + centre - j)));
    return y;
  };
  // Points on the 4x grid, m = 4 n + k; each one may be refined to the vertex
  // of the parabola through its two grid neighbours when it is an extremum.
  const grid = (m: number) => point(Math.floor(m / 4), ((m % 4) + 4) % 4);
  const refined = (m: number) => {
    const a = grid(m - 1), b = grid(m), c = grid(m + 1);
    const curvature = a - 2 * b + c;
    if (Math.abs(b) < Math.max(Math.abs(a), Math.abs(c)) || b * curvature >= 0) return Math.abs(b);
    return Math.abs(b - (a - c) ** 2 / (8 * curvature));
  };
  const required = Float32Array.from(input, (_, i) => {
    let peak = 0;
    for (let m = 4 * (i - 1); m < 4 * (i + 1); m++) peak = Math.max(peak, refined(m));
    peak *= TRUE_PEAK_MARGIN;
    return peak > threshold ? threshold / peak : 1;
  });
  const held = new Float32Array(input.length);
  const first = new Float32Array(input.length);
  const output = new Float32Array(input.length);
  let envelope = 1;
  for (let i = 0; i < input.length; i++) {
    let min = 1;
    for (let k = Math.max(0, i - delay); k <= i; k++) min = Math.min(min, required[k]);
    envelope = min < envelope ? min : envelope + (min - envelope) * release;
    held[i] = envelope;
    let sum = 0;
    for (let k = i - half + 1; k <= i; k++) sum += k < 0 ? 1 : held[k];
    first[i] = Math.min(1, sum / half);
    sum = 0;
    for (let k = i - second + 1; k <= i; k++) sum += k < 0 ? 1 : first[k];
    if (i + centre < input.length) output[i + centre] = i < delay ? 0 : input[i - delay] * Math.min(1, sum / second);
  }
  return output;
}

describe('lookahead limiter chronology', () => {
  it.each([44100, 48000, 96000])('matches chronological smoothing at %i Hz through repeated delay wraps', (sr) => {
    const input = Float32Array.from({ length: 5000 }, (_, i) => {
      const burst = i % 653 > 170 && i % 653 < 263;
      return (burst ? 2.7 : 0.3) * Math.sin(i * 0.13);
    });
    const limiter = new Limiter(sr);
    const expected = referenceLimiter(input, sr, limiter.threshold, limiter.lookahead - TRUE_PEAK_KERNEL[0].length / 2);
    const L = Float32Array.from(input), R = Float32Array.from(input);
    for (let i = 0; i < L.length; i += 128) limiter.processBlock(L, R, i, Math.min(L.length, i + 128));
    expect(maximumError(L, expected)).toBeLessThan(1e-6);
    expect(maximumError(L, R)).toBe(0);
  });

  it('keeps a minimum valid smoothing delay and resets it completely', () => {
    const input = Float32Array.from({ length: 1000 }, (_, i) => 2 * Math.sin(i * 0.17));
    for (const milliseconds of [0, 0.001, 0.02]) {
      const limiter = new Limiter(44100, 0.8, milliseconds);
      const L = Float32Array.from(input), R = Float32Array.from(input);
      limiter.processBlock(L, R, 0, L.length);
      expect(L.every(Number.isFinite)).toBe(true);
      expect(L.every((x) => Math.abs(x) <= 0.800001)).toBe(true);
      limiter.reset();
      const resetL = Float32Array.from(input), resetR = Float32Array.from(input);
      limiter.processBlock(resetL, resetR, 0, resetL.length);
      expect(maximumError(L, resetL)).toBe(0);
    }
  });
});

describe('WSOLA at high device sample rates', () => {
  it.each([0.88, 1.12])('preserves high-frequency stereo pitch at 96 kHz and ratio %f', (ratio) => {
    const sr = 96000;
    // Both the main tone and a high harmonic exceed a decimated search's Nyquist.
    // Final alignment therefore needs full-rate stereo refinement.
    const source = Float32Array.from({ length: sr * 3 }, (_, i) =>
      0.3 * Math.sin(2 * Math.PI * 13000 * i / sr) + 0.1 * Math.sin(2 * Math.PI * 17000 * i / sr));
    const opposite = Float32Array.from(source, (x) => -x);
    const stretcher = new Wsola(sr, new ArraySource(source, opposite));
    const L = new Float32Array(sr * 2), R = new Float32Array(L.length);
    stretcher.reset(0);
    for (let i = 0; i < L.length; i += 128) {
      const n = Math.min(128, L.length - i);
      expect(stretcher.render(L, R, i, n, () => ratio)).toBe(n);
    }
    let energy = 0, error = 0, crossings = 0;
    for (let i = sr; i < L.length; i++) {
      energy += L[i] ** 2;
      error = Math.max(error, Math.abs(L[i] + R[i]));
      if (L[i - 1] <= 0 && L[i] > 0) crossings++;
    }
    expect(Math.sqrt(energy / sr)).toBeGreaterThan(0.20);
    expect(error).toBeLessThan(1e-6);
    expect(Math.abs(crossings - 13000)).toBeLessThan(30);
    expect(Math.abs(stretcher.position() / L.length - ratio)).toBeLessThan(0.004);
  });

  it('keeps percussion attack positions independent of 128/512-frame calls during a tempo ramp', () => {
    const sr = 96000;
    const input = new Float32Array(sr * 3);
    for (let start = sr / 4; start < input.length; start += sr / 4) {
      for (let k = 0; k < sr * 0.025; k++) input[start + k] = 0.5 * Math.exp(-k / (sr * 0.005)) * Math.sin(2 * Math.PI * 700 * k / sr);
    }
    const render = (block: number) => {
      const w = new Wsola(sr, new ArraySource(input));
      w.reset(0);
      const L = new Float32Array(sr * 2), R = new Float32Array(L.length);
      for (let i = 0; i < L.length; i += block) {
        w.render(L, R, i, Math.min(block, L.length - i), (k) => 0.92 + 0.16 * (i + k) / L.length);
      }
      return L;
    };
    expect(maximumError(render(128), render(512))).toBeLessThan(1e-6);
  });
});
