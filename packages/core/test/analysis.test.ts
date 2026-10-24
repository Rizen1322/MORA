import { describe, expect, it } from 'vitest';
import { camelotCompatibility, camelotOf } from '../src/mir/key.ts';
import { analyzePcm } from '../src/mir/analyzePcm.ts';
import { detectSections } from '../src/mir/structure.ts';
import { fixture } from './helpers.ts';

function phaseError(truth: number[], found: number[]): number {
  const errs = truth.slice(8, -8).map((t) => Math.min(...found.map((x) => Math.abs(x - t))));
  return (errs.reduce((a, b) => a + b, 0) / errs.length) * 1000;
}

describe('beat and tempo analysis on signals with known beats', () => {
  const cases = [
    { style: 'house', bpm: 124 },
    { style: 'techno', bpm: 128 },
    { style: 'hiphop', bpm: 88 },
    { style: 'pop', bpm: 118 },
  ] as const;
  for (const c of cases) {
    it(`${c.style} ${c.bpm} BPM: tempo, stable grid, beat phase and downbeats`, () => {
      const f = fixture({ style: c.style, bpm: c.bpm, tonic: 9, mode: 'minor', bars: 48, seed: 1 });
      const b = f.analysis.beat!;
      expect(b).toBeTruthy();
      expect(Math.abs(b.bpm - c.bpm)).toBeLessThan(0.3);
      expect(b.stable).toBe(true);
      expect(b.confidence).toBeGreaterThan(0.6);
      expect(phaseError(f.pcm.beats, b.beats)).toBeLessThan(6);
      // downbeats land on true bar starts
      const db = f.pcm.downbeats.slice(4, 12).map((t) => Math.min(...b.downbeats.map((x) => Math.abs(x - t))));
      expect(Math.max(...db)).toBeLessThan(0.03);
    });
  }

  it('resolves double tempo for drum and bass (174 BPM, not 87)', () => {
    const f = fixture({ style: 'dnb', bpm: 174, tonic: 2, mode: 'minor', bars: 64, seed: 4 });
    expect(Math.abs(f.analysis.beat!.bpm - 174)).toBeLessThan(0.5);
  });

  it('reports no beat grid for beatless ambient material', () => {
    const f = fixture({ style: 'ambient', bpm: 70, tonic: 7, mode: 'major', bars: 24, seed: 5 });
    expect(f.analysis.beat).toBeNull();
    expect(f.analysis.rhythmStrength).toBeLessThan(0.3);
  });

  it('marks rubato playing as an unstable grid', () => {
    const f = fixture({ style: 'acoustic', bpm: 96, tonic: 5, mode: 'major', bars: 32, seed: 6 });
    expect(f.analysis.beat?.stable ?? false).toBe(false);
  });

  it('trims leading and trailing silence', () => {
    const f = fixture({ style: 'pop', bpm: 118, tonic: 2, mode: 'major', bars: 24, seed: 7, leadSilence: 2, tailSilence: 3 });
    expect(Math.abs(f.analysis.audibleStart - 2)).toBeLessThan(0.15);
    expect(f.analysis.audibleEnd).toBeLessThan(f.analysis.duration - 2);
  });
});

describe('edge cases', () => {
  it('handles a completely silent file', () => {
    const z = new Float32Array(44100 * 5);
    const a = analyzePcm(z, z);
    expect(a.warnings).toContain('silent');
    expect(a.beat).toBeNull();
    expect(a.key.camelot).toBe('');
  });

  it('handles a very short file', () => {
    const f = fixture({ style: 'house', bpm: 124, tonic: 0, mode: 'major', bars: 4, seed: 11, introBars: 0, outroBars: 0 });
    expect(f.analysis.warnings).toContain('short');
    expect(f.analysis.duration).toBeLessThan(10);
  });

  it('handles noise without crashing and with low key confidence', () => {
    const n = 44100 * 20;
    const L = new Float32Array(n).map(() => (Math.random() * 2 - 1) * 0.3);
    const a = analyzePcm(L, L);
    expect(a.key.confidence).toBeLessThan(0.3);
  });

  it('does not mistake anti-phase stereo music for a silent file', () => {
    const f = fixture({ style: 'house', bpm: 124, tonic: 0, mode: 'major', bars: 16, seed: 44 });
    const a = analyzePcm(f.pcm.L, Float32Array.from(f.pcm.L, (v) => -v));
    expect(a.warnings).toContain('stereo-cancellation-guard');
    expect(a.warnings).not.toContain('silent');
    expect(a.beat!.bpm).toBeCloseTo(124, 0);
    expect(a.loudness.integratedLufs).toBeGreaterThan(-40);
  });

  it('rejects malformed PCM explicitly instead of caching non-finite measurements', () => {
    const l = new Float32Array(44100);
    const r = new Float32Array(44100);
    l[200] = Number.NaN;
    expect(() => analyzePcm(l, r)).toThrow(/non-finite/);
    expect(() => analyzePcm(r, new Float32Array(10))).toThrow(/channel lengths/);
  });
});

describe('acoustic structure without semantic labels', () => {
  it('finds an energy arrival around 24 seconds without requiring a reliable beat grid', () => {
    const rate = 20;
    const levels = Array.from({ length: 60 * rate }, (_, i) => i / rate < 24 ? -35 : -16);
    const sections = detectSections({
      rate, rmsDb: levels, lowDb: levels.map((v) => v - 3), midDb: levels.map((v) => v - 6), highDb: levels.map((v) => v - 10),
      midDensity: levels.map((v) => v < -25 ? 0.05 : 0.4),
    }, 0, 60, null);
    expect(sections).toHaveLength(2);
    expect(sections[1].start).toBeCloseTo(24, 1);
    expect(sections[1].novelty).toBeGreaterThan(0.7);
    expect(sections[1].rmsDb).toBeCloseTo(-16, 1);
  });

  it('retains later structural entry cues in the full PCM analysis', () => {
    const sr = 44100;
    const signal = new Float32Array(sr * 60);
    for (let i = 0; i < signal.length; i++) {
      const amp = i < sr * 24 ? 0.025 : 0.22;
      signal[i] = amp * (Math.sin(2 * Math.PI * 220 * i / sr) + 0.3 * Math.sin(2 * Math.PI * 330 * i / sr));
    }
    const a = analyzePcm(signal, signal);
    expect(a.sectionBoundaries.some((t) => Math.abs(t - 24) < 0.6)).toBe(true);
    expect(a.cues.entry.some((cue) => cue.kind === 'section' && Math.abs(cue.time - 24) < 0.6)).toBe(true);
    expect(a.sections!.every((s) => Number.isFinite(s.rmsDb) && s.midDensity >= 0 && s.midDensity <= 1)).toBe(true);
  });

  it('does not invent acoustic changes in a flat feature curve', () => {
    const curve = new Array<number>(1200).fill(-16);
    const sections = detectSections({ rate: 20, rmsDb: curve, lowDb: curve, midDb: curve, highDb: curve, midDensity: curve.map(() => 0.3) }, 0, 60, null);
    expect(sections).toHaveLength(1);
  });
});

describe('key detection', () => {
  it('finds a Camelot-compatible key for chord progressions', () => {
    let ok = 0;
    const n = 6;
    for (let i = 0; i < n; i++) {
      const tonic = (i * 5) % 12;
      const mode = i % 2 ? 'minor' : 'major';
      const f = fixture({ style: i % 2 ? 'pop' : 'house', bpm: 112 + i, tonic, mode, bars: 24, seed: 100 + i, introBars: 2, outroBars: 2 });
      const got = f.analysis.key.camelot;
      if (got && camelotCompatibility(camelotOf(tonic, mode), got).score >= 0.85) ok++;
    }
    expect(ok).toBeGreaterThanOrEqual(n - 1);
  });

  it('scores Camelot neighbours', () => {
    expect(camelotCompatibility('8A', '8A').score).toBe(1);
    expect(camelotCompatibility('8A', '9A').score).toBeGreaterThan(0.8);
    expect(camelotCompatibility('8A', '8B').score).toBeGreaterThan(0.8);
    expect(camelotCompatibility('8A', '2A').score).toBeLessThan(0.3);
    expect(camelotCompatibility('', '2A').score).toBe(0.5);
  });
});
