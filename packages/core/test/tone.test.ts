import { describe, expect, it } from 'vitest';
import { magnitude, peaking } from '../src/dsp/biquad.ts';
import { Limiter } from '../src/dsp/limiter.ts';
import { LoudnessMeter } from '../src/dsp/loudness.ts';
import { EQ_BANDS, FLAT_TONE, MasterTone, eqPeakDb, preampFor, sanitizeTone, type ToneSettings } from '../src/dsp/tone.ts';

const FS = 48000;
const sine = (f: number, amp: number, n: number, phase = 0) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * f * i / FS + phase));
const gainsAt = (b: number, db: number) => EQ_BANDS.map((_, i) => (i === b ? db : 0));
const on = (gains: number[], extra: Partial<ToneSettings> = {}): ToneSettings => ({ ...FLAT_TONE, enabled: true, gains, ...extra });

/** Runs the tone in realistic 128-frame render quanta. */
function run(tone: MasterTone, L: Float32Array, R: Float32Array): void {
  for (let s = 0; s < L.length; s += 128) {
    const e = Math.min(L.length, s + 128);
    const l = L.subarray(s, e), r = R.subarray(s, e);
    tone.process(l, r, e - s);
  }
}
const rms = (x: Float32Array, from = 0) => Math.sqrt(x.subarray(from).reduce((a, v) => a + v * v, 0) / (x.length - from));

describe('listener EQ', () => {
  it('peaking bell reaches its gain at the centre and stays flat far away', () => {
    const c = peaking(FS, 1000, 6, Math.SQRT2);
    expect(20 * Math.log10(magnitude(c, FS, 1000))).toBeCloseTo(6, 1);
    expect(Math.abs(20 * Math.log10(magnitude(c, FS, 20)))).toBeLessThan(0.05);
  });

  it('measured curve peak accounts for overlapping bands, not just the largest slider', () => {
    const one = eqPeakDb(gainsAt(1, 6), FS);
    const neighbours = eqPeakDb(EQ_BANDS.map((_, i) => (i === 1 || i === 2 ? 6 : 0)), FS);
    expect(one).toBeCloseTo(6, 0);
    expect(neighbours).toBeGreaterThan(one + 1);
    expect(preampFor(on(EQ_BANDS.map((_, i) => (i === 1 || i === 2 ? 6 : 0))), FS)).toBeCloseTo(-neighbours, 5);
  });

  it('disabled or flat settings leave the signal bit-identical', () => {
    const tone = new MasterTone(FS);
    const L = sine(440, 0.5, 4800), R = sine(550, 0.5, 4800);
    const L0 = L.slice(), R0 = R.slice();
    tone.set(FLAT_TONE);
    run(tone, L, R);
    expect(L).toEqual(L0);
    expect(R).toEqual(R0);
    expect(tone.bypassed).toBe(true);
  });

  it('boosts the chosen band by its gain (with auto headroom off) and keeps others', () => {
    const tone = new MasterTone(FS);
    tone.set(on(gainsAt(5, 6), { autoHeadroom: false }));
    const L = sine(1000, 0.1, FS), R = sine(1000, 0.1, FS);
    run(tone, L, R);
    expect(20 * Math.log10(rms(L, FS / 2) / (0.1 / Math.SQRT2))).toBeCloseTo(6, 0);
    const tone2 = new MasterTone(FS);
    tone2.set(on(gainsAt(5, 6), { autoHeadroom: false }));
    const L2 = sine(31, 0.1, FS), R2 = L2.slice();
    run(tone2, L2, R2);
    expect(Math.abs(20 * Math.log10(rms(L2, FS / 2) / (0.1 / Math.SQRT2)))).toBeLessThan(0.3);
  });

  it('a 12 dB jump glides without clicks or NaN', () => {
    const tone = new MasterTone(FS);
    const L = sine(62, 0.4, FS), R = sine(62, 0.4, FS);
    tone.set(on(gainsAt(1, 12), { autoHeadroom: false }));
    run(tone, L, R);
    let maxStep = 0;
    for (let i = 1; i < L.length; i++) { expect(Number.isFinite(L[i])).toBe(true); maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1])); }
    // A 62 Hz sine at the final amplitude (×4) moves at most 2πf/fs × 1.6 per sample.
    expect(maxStep).toBeLessThan(2 * Math.PI * 62 / FS * 1.6 * 1.3);
  });

  it('hot bass-heavy master + bass boost: after the limiter true peak stays at the ceiling', () => {
    const n = FS * 2;
    // −0.2 dBFS master: bass + kick-like bursts + bright content.
    const L = Float32Array.from({ length: n }, (_, i) => 0.55 * Math.sin(2 * Math.PI * 55 * i / FS) + 0.3 * Math.sin(2 * Math.PI * 7000 * i / FS) * (i % 12000 < 600 ? 1 : 0.3) + 0.12 * Math.sin(2 * Math.PI * 140 * i / FS));
    const R = L.slice();
    const tone = new MasterTone(FS);
    tone.set(on(EQ_BANDS.map((_, i) => (i <= 2 ? 10 : 0))));
    const lim = new Limiter(FS);
    for (let s = 0; s < n; s += 128) {
      const e = Math.min(n, s + 128);
      tone.process(L.subarray(s, e), R.subarray(s, e), e - s);
      lim.processBlock(L, R, s, e);
    }
    const meter = new LoudnessMeter(FS);
    meter.push([L, R]);
    expect(meter.result().truePeakDb).toBeLessThanOrEqual(-0.95);
    expect(L.every(Number.isFinite)).toBe(true);
  });

  it('mono and balance', () => {
    const tone = new MasterTone(FS);
    tone.set(on(EQ_BANDS.map(() => 0), { mono: true }));
    const L = sine(300, 0.5, FS / 2), R = new Float32Array(FS / 2);
    run(tone, L, R);
    expect(Math.abs(L[L.length - 7] - R[R.length - 7])).toBeLessThan(1e-6);
    const t2 = new MasterTone(FS);
    t2.set(on(EQ_BANDS.map(() => 0), { balance: -1 }));
    const L2 = sine(300, 0.5, FS / 2), R2 = sine(300, 0.5, FS / 2);
    run(t2, L2, R2);
    expect(rms(R2, FS / 4)).toBeLessThan(1e-4);
    expect(rms(L2, FS / 4)).toBeGreaterThan(0.3);
  });

  it('sanitises stored settings (old/malformed values get defaults)', () => {
    expect(sanitizeTone(undefined)).toEqual(FLAT_TONE);
    const s = sanitizeTone({ enabled: true, gains: [99, -99, 'x', 3.33], preampDb: 50, balance: 4, mono: 'yes' });
    expect(s.gains.slice(0, 4)).toEqual([12, -12, 0, 3.3]);
    expect(s.gains).toHaveLength(10);
    expect(s).toMatchObject({ preampDb: 6, balance: 1, mono: false, autoHeadroom: true });
  });

  it('skips bands at or above 0.45 × sample rate', () => {
    expect(eqPeakDb(gainsAt(9, 12), 32000)).toBe(0);
    expect(eqPeakDb(gainsAt(9, 12), 48000)).toBeGreaterThan(10);
  });
});
