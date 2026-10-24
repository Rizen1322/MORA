import { describe, expect, it } from 'vitest';
import { FFT } from '../src/dsp/fft.ts';
import { StereoIsolator } from '../src/dsp/crossover.ts';
import { Limiter } from '../src/dsp/limiter.ts';
import { LoudnessMeter } from '../src/dsp/loudness.ts';
import { ArraySource, Wsola } from '../src/dsp/wsola.ts';
import { synthesize } from '../src/synth/synth.ts';
import { countClicks, rms } from './helpers.ts';

const sine = (hz: number, sec: number, sr: number, amp = 1) => {
  const n = Math.round(sec * sr);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return x;
};

describe('FFT', () => {
  it('round-trips a random signal', () => {
    const f = new FFT(1024);
    const re = new Float64Array(1024).map(() => Math.random() - 0.5);
    const orig = Float64Array.from(re);
    const im = new Float64Array(1024);
    f.forward(re, im);
    f.inverse(re, im);
    for (let i = 0; i < 1024; i++) expect(re[i]).toBeCloseTo(orig[i], 9);
  });
});

describe('LoudnessMeter (BS.1770)', () => {
  it('measures a stereo 997 Hz sine at -20 dBFS as about -20 LUFS', () => {
    for (const sr of [44100, 48000]) {
      const x = sine(997, 10, sr, Math.pow(10, -20 / 20));
      const m = new LoudnessMeter(sr, 2);
      m.push([x, x]);
      const r = m.result();
      expect(r.integratedLufs).toBeGreaterThan(-20.25);
      expect(r.integratedLufs).toBeLessThan(-19.75);
      expect(r.samplePeakDb).toBeCloseTo(-20, 1);
      expect(Math.abs(r.truePeakDb + 20)).toBeLessThan(0.3);
    }
  });

  it('reads the true peak of a quarter-rate sine whose samples miss its crests', () => {
    // fs/4 at 45 degrees: every sample sits 3 dB below the crest.
    const sr = 44100;
    const x = Float32Array.from({ length: sr }, (_, i) => 0.5 * Math.min(1, i / 2000) * Math.sin((Math.PI / 2) * i + Math.PI / 4));
    const m = new LoudnessMeter(sr, 1);
    m.push([x]);
    const r = m.result();
    expect(r.samplePeakDb).toBeLessThan(20 * Math.log10(0.5) - 2.9);
    expect(Math.abs(r.truePeakDb - 20 * Math.log10(0.5))).toBeLessThan(0.1);
  });

  it('gates silence (silent file reads -70)', () => {
    const m = new LoudnessMeter(44100, 2);
    const z = new Float32Array(44100 * 3);
    m.push([z, z]);
    expect(m.result().integratedLufs).toBe(-70);
  });
});

describe('Limiter', () => {
  it('never lets samples exceed the threshold', () => {
    const sr = 48000;
    const lim = new Limiter(sr);
    const L = new Float32Array(sr * 2).map((_, i) => Math.sin(i / 7) * (i % 9000 < 300 ? 2.5 : 0.7));
    const R = Float32Array.from(L, (v) => -v * 0.9);
    lim.processBlock(L, R, 0, L.length);
    let mx = 0;
    for (let i = 0; i < L.length; i++) mx = Math.max(mx, Math.abs(L[i]), Math.abs(R[i]));
    expect(mx).toBeLessThanOrEqual(lim.threshold + 1e-6);
  });

  it('keeps the 4x-oversampled true peak under the threshold', () => {
    // Independent long windowed-sinc 4x interpolator used as the dBTP meter.
    const truePeak = (x: Float32Array, from: number) => {
      let mx = 0;
      for (let n = from; n < x.length - 64; n++) {
        for (let k = 0; k < 4; k++) {
          let y = 0;
          for (let j = -63; j <= 64; j++) {
            const d = j - k / 4;
            const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / 65);
            y += x[n + j] * (d === 0 ? 1 : (Math.sin(Math.PI * d) / (Math.PI * d)) * w);
          }
          mx = Math.max(mx, Math.abs(y));
        }
      }
      return 20 * Math.log10(mx);
    };
    for (const sr of [44100, 48000]) {
      const lim = new Limiter(sr);
      // fs/4 at 45 degrees: samples sit at -0.5 dBFS, the waveform peaks at +2.5 dBTP.
      const amp = Math.pow(10, -0.5 / 20) * Math.SQRT2;
      const n = 6000;
      const L = Float32Array.from({ length: n }, (_, i) => (i % 2000 < 1200 ? amp : 0.2) * Math.sin((Math.PI * i) / 2 + Math.PI / 4));
      const R = Float32Array.from({ length: n }, (_, i) => 0.9 * amp * Math.sin(0.23 * 2 * Math.PI * i + 1));
      expect(truePeak(L, 200)).toBeGreaterThan(2.4);
      for (let i = 0; i < n; i += 128) lim.processBlock(L, R, i, Math.min(n, i + 128));
      const ceiling = 20 * Math.log10(lim.threshold);
      expect(truePeak(L, 64)).toBeLessThanOrEqual(ceiling + 0.1);
      expect(truePeak(R, 64)).toBeLessThanOrEqual(ceiling + 0.1);
    }
  });

  it.each([0.35, 0.4, 0.43])('holds the ceiling for a hot sine at %f fs, between the 4x grid points too', (f) => {
    // 16x reference meter: the crest of a 0.4 fs sine can sit 0.45 dB above
    // every 4x grid point, so a 4x detector alone lets it through.
    const truePeak16 = (x: Float32Array, from: number) => {
      let mx = 0;
      for (let n = from; n < x.length - 64; n++) {
        for (let k = 0; k < 16; k++) {
          let y = 0;
          for (let j = -63; j <= 64; j++) {
            const d = j - k / 16;
            const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / 65);
            y += x[n + j] * (d === 0 ? 1 : (Math.sin(Math.PI * d) / (Math.PI * d)) * w);
          }
          mx = Math.max(mx, Math.abs(y));
        }
      }
      return 20 * Math.log10(mx);
    };
    const lim = new Limiter(44100);
    const ceiling = 20 * Math.log10(lim.threshold);
    let worst = -Infinity;
    for (const phase of [0, 0.4, 0.8, 1.2]) {
      const n = 5000;
      const L = Float32Array.from({ length: n }, (_, i) => 1.4 * Math.min(1, i / 2000) * Math.sin(2 * Math.PI * f * i + phase));
      const R = Float32Array.from(L);
      lim.reset();
      for (let i = 0; i < n; i += 128) lim.processBlock(L, R, i, Math.min(n, i + 128));
      worst = Math.max(worst, truePeak16(L, 3000));
    }
    expect(worst).toBeLessThanOrEqual(ceiling + 0.02);
  });

  it('is transparent (pure delay) below the threshold', () => {
    const sr = 48000;
    const lim = new Limiter(sr);
    const x = sine(220, 0.5, sr, 0.5);
    const L = Float32Array.from(x);
    const R = Float32Array.from(x);
    lim.processBlock(L, R, 0, L.length);
    const d = lim.lookahead;
    for (let i = d + 10; i < L.length; i += 37) expect(L[i]).toBeCloseTo(x[i - d], 6);
  });
});

describe('StereoIsolator (LR4 three-band)', () => {
  it('keeps energy with all bands at unity (allpass sum)', () => {
    const sr = 48000;
    const iso = new StereoIsolator(sr);
    const L = new Float32Array(sr).map(() => Math.random() * 2 - 1);
    const R = Float32Array.from(L);
    const before = rms(L);
    iso.processBlock(L, R, 0, L.length, [1, 1, 1], [1, 1, 1]);
    expect(Math.abs(rms(L, 4800) / before - 1)).toBeLessThan(0.03);
  });

  it('removes the bass band when low gain is zero', () => {
    const sr = 48000;
    const iso = new StereoIsolator(sr);
    const L = sine(55, 1, sr, 0.8);
    const R = Float32Array.from(L);
    iso.processBlock(L, R, 0, L.length, [0, 1, 1], [0, 1, 1]);
    const att = 20 * Math.log10(rms(L, 9600) / (0.8 / Math.SQRT2));
    expect(att).toBeLessThan(-24);
  });
});

describe('WSOLA time stretcher', () => {
  it('is an exact identity at ratio 1 after the initial fade-in', () => {
    const sr = 44100;
    const s = synthesize({ style: 'house', bpm: 124, tonic: 9, mode: 'minor', bars: 4, seed: 3, introBars: 0, outroBars: 0 });
    const w = new Wsola(sr, new ArraySource(s.L, s.R));
    w.reset(0);
    const n = 44100;
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    expect(w.render(oL, oR, 0, n, () => 1)).toBe(n);
    for (let i = w.H; i < n; i++) expect(Math.abs(oL[i] - s.L[i])).toBeLessThan(1e-6);
    expect(w.position()).toBe(n);
  });

  it('changes tempo without changing pitch', () => {
    const sr = 44100;
    const x = sine(440, 4, sr, 0.5);
    const w = new Wsola(sr, new ArraySource(x, x));
    w.reset(0);
    const n = sr * 3;
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    w.render(oL, oR, 0, n, () => 1.06);
    // input consumed ~6 % faster than output
    expect(w.position() / n).toBeGreaterThan(1.055);
    expect(w.position() / n).toBeLessThan(1.065);
    // pitch from zero crossings in the steady part
    let zc = 0;
    for (let i = sr; i < 2 * sr; i++) if (oL[i - 1] <= 0 && oL[i] > 0) zc++;
    expect(Math.abs(zc - 440)).toBeLessThanOrEqual(4);
  });

  it('preserves pitch and waveform alignment for anti-phase stereo', () => {
    const sr = 44100;
    const x = sine(440, 3, sr, 0.45);
    const inverted = Float32Array.from(x, (v) => -v);
    for (const ratio of [0.9, 1.12]) {
      const mono = new Wsola(sr, new ArraySource(x, x));
      const wide = new Wsola(sr, new ArraySource(x, inverted));
      mono.reset(0);
      wide.reset(0);
      const n = sr * 2;
      const reference = new Float32Array(n);
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      mono.render(reference, new Float32Array(n), 0, n, () => ratio);
      expect(wide.render(L, R, 0, n, () => ratio)).toBe(n);
      let maxError = 0;
      let crossings = 0;
      for (let i = wide.H; i < n; i++) {
        maxError = Math.max(maxError, Math.abs(L[i] - reference[i]), Math.abs(L[i] + R[i]));
        if (i > sr && L[i - 1] <= 0 && L[i] > 0) crossings++;
      }
      expect(maxError).toBeLessThan(1e-6);
      expect(Math.abs(crossings - 440)).toBeLessThanOrEqual(4);
      expect(rms(L, sr)).toBeGreaterThan(0.30);
    }
  });

  it.each([1.03, 1.06, 0.94])('keeps a 49 Hz bass line phase-coherent at ratio %f', (ratio) => {
    // Bass periods (20 ms) are longer than twice the old +-6 ms search: there
    // was often no in-phase candidate and the stretched bass beat (6-12 dB SNR).
    const sr = 44100;
    const x = Float32Array.from(sine(49, 8, sr, 0.4), (v, i) => v + 0.2 * Math.sin((2 * Math.PI * 98 * i) / sr + 1));
    const w = new Wsola(sr, new ArraySource(x, x));
    w.reset(0);
    const n = Math.floor((7 * sr) / ratio);
    const L = new Float32Array(n);
    for (let p = 0; p < n; ) p += w.render(L, new Float32Array(n), p, Math.min(128, n - p), () => ratio);
    // Least-squares fit of both partials per 80 ms block: what is left is distortion.
    const B = Math.round(sr * 0.08);
    let total = 0, residual = 0;
    for (let s = sr; s + B < n - sr / 4; s += B) {
      const r = Float64Array.from(L.subarray(s, s + B));
      for (const v of r) total += v * v;
      for (const hz of [49, 98]) {
        let c = 0, d = 0;
        for (let i = 0; i < B; i++) {
          const ph = (2 * Math.PI * hz * (s + i)) / sr;
          c += r[i] * Math.cos(ph);
          d += r[i] * Math.sin(ph);
        }
        for (let i = 0; i < B; i++) {
          const ph = (2 * Math.PI * hz * (s + i)) / sr;
          r[i] -= (2 / B) * (c * Math.cos(ph) + d * Math.sin(ph));
        }
      }
      for (const v of r) residual += v * v;
    }
    expect(10 * Math.log10(total / residual)).toBeGreaterThan(25);
  });

  it('switches ratio smoothly on music without clicks', () => {
    const sr = 44100;
    const s = synthesize({ style: 'techno', bpm: 128, tonic: 4, mode: 'minor', bars: 16, seed: 9, introBars: 0, outroBars: 0, clean: true });
    const w = new Wsola(sr, new ArraySource(s.L, s.R));
    w.reset(0);
    const n = sr * 12;
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    let produced = 0;
    while (produced < n) {
      const t = produced / sr;
      const r = t < 3 ? 1 : t < 5 ? 1.05 : t < 8 ? 1.05 - ((t - 5) / 3) * 0.05 : 1;
      produced += w.render(oL, oR, produced, Math.min(512, n - produced), () => r);
    }
    expect(countClicks(oL.subarray(w.H))).toBe(0);
  });
});
