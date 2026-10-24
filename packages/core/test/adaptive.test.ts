import { describe, expect, it } from 'vitest';
import { fitOnsetGrid, type OnsetEnvelope } from '../src/mir/tempo.ts';
import { planRequestedTransition, planTransition, skipPlanFrom } from '../src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type PlannerTrack, type TrackAnalysis } from '../src/types.ts';
import { planToArmed, renderTransitionOffline } from '../src/engine/arm.ts';
import { CHUNK_FRAMES } from '../src/engine/chunks.ts';
import { MixerCore, type MixerEvent } from '../src/engine/mixer.ts';

/** Constant electronic rhythm with missing kicks, syncopated snares and hats. */
function syncopatedOnsets(bpm: number, duration = 96, amplitude = 1): OnsetEnvelope {
  const fps = 100;
  const env = new Float32Array(Math.ceil(duration * fps));
  const p = 60 / bpm;
  const pulse = (t: number, height: number) => {
    const c = t * fps;
    for (let i = Math.max(0, Math.floor(c) - 2); i <= Math.min(env.length - 1, Math.ceil(c) + 2); i++) {
      env[i] += amplitude * height * Math.exp(-0.5 * ((i - c) / 0.6) ** 2);
    }
  };
  for (let k = 0; 0.173 + k * p < duration; k++) {
    if (k % 7 !== 3 && k % 11 !== 5) pulse(0.173 + k * p, k % 4 === 0 ? 4 : 2.6);
    if (k % 4 === 1 || k % 4 === 3) pulse(0.173 + (k + 0.5) * p, 3.5);
    if (k % 3 === 0) pulse(0.173 + (k + 0.75) * p, 1.2);
  }
  return { fps, t0: 0, env, lowMid: env, low: env };
}

function measured(id: string, bpm: number, intro = 0, duration = 180): PlannerTrack {
  const period = 60 / bpm;
  const beats = Array.from({ length: Math.ceil(duration / period) }, (_, i) => i * period).filter((t) => t < duration);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  const rmsDb = Array.from({ length: Math.ceil(duration * 20) }, (_, i) => i / 20 < intro ? -35 : -16);
  const analysis: TrackAnalysis = {
    version: 'measured-adaptive-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: { bpm, period, beats, downbeats, confidence: 0.95, stable: true, jitterMs: 0, downbeatConfidence: 0.9, downbeatPhase: 0, alternatives: [] },
    rhythmStrength: 0.95, key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases: downbeats.filter((_, i) => i % 8 === 0), phraseConfidence: 0.8,
    sectionBoundaries: intro ? [intro] : [], intro: { start: 0, end: intro }, outro: { start: duration - 16, end: duration }, bodyRmsDb: -16,
    curves: { rate: 20, rmsDb, lowDb: rmsDb.map((v) => v - 3), midDb: rmsDb.map((v) => v - 6), highDb: rmsDb.map((v) => v - 10), midDensity: rmsDb.map(() => 0.2) },
    peaks: rmsDb.map(() => 0.8),
    cues: {
      entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }, ...(intro ? [{ time: intro, score: 0.85, kind: 'section' as const, tags: ['energy-arrival'] }] : [])],
      exit: downbeats.filter((t) => t > duration - 40).map((time) => ({ time, score: 0.8, kind: 'downbeat' as const, tags: ['outro'] })),
    },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.95, onsetRate: 0.4, bassWeight: 0.6, midDensity: 0.2, dynamics: 0.2, acousticness: 0.1 },
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}

function value(points: [number, number][], t: number): number {
  for (let i = 1; i < points.length; i++) if (t <= points[i][0]) {
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    return y0 + (y1 - y0) * (t - x0) / (x1 - x0);
  }
  return points.at(-1)![1];
}

function integral(points: [number, number][], end: number): number {
  const times = [0, ...points.map(([t]) => t).filter((t) => t > 0 && t < end), end];
  let sum = 0;
  for (let i = 1; i < times.length; i++) sum += (times[i] - times[i - 1]) * (value(points, times[i]) + value(points, times[i - 1])) / 2;
  return sum;
}

const S = DEFAULT_AUTOMIX_SETTINGS;

describe('direct onset-grid recovery', () => {
  it('recovers a stable 118 BPM pulse despite missed attacks and stronger offbeat snares', () => {
    const o = syncopatedOnsets(118);
    const g = fitOnsetGrid(o, 0, 96, 117.5);
    expect(g.stable).toBe(true);
    expect(60 / g.period).toBeCloseTo(118, 1);
    const distance = Math.abs(g.t0 - 0.173 - Math.round((g.t0 - 0.173) / g.period) * g.period);
    expect(distance).toBeLessThan(0.02);
    expect(g.support).toBeGreaterThan(0.65);
    expect(g.jitterMs).toBeLessThan(22);
  });

  it('does not promote barely audible periodic energy to a reliable beat', () => {
    const g = fitOnsetGrid(syncopatedOnsets(118, 96, 0.1), 0, 96, 118);
    expect(g.stable).toBe(false);
  });

  it('rejects nonperiodic onset noise even when its attacks are loud', () => {
    const env = new Float32Array(9600);
    let state = 1879;
    for (let i = 0; i < env.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      env[i] = (state / 4294967296) * 4;
    }
    const g = fitOnsetGrid({ fps: 100, t0: 0, env, lowMid: env, low: env }, 0, 96, 118);
    expect(g.stable).toBe(false);
    expect(g.contrast).toBeLessThan(0.22);
  });

  it('does not extrapolate stability from a fragment shorter than twelve beats', () => {
    const g = fitOnsetGrid(syncopatedOnsets(118, 4), 0, 4, 118);
    expect(g.stable).toBe(false);
  });

  it('rejects a global grid when the final musical section actually changes tempo', () => {
    const fps = 100;
    const env = new Float32Array(120 * fps);
    const pulse = (time: number) => {
      const center = Math.round(time * fps);
      for (let offset = -1; offset <= 1; offset++) if (center + offset < env.length) env[center + offset] = 3 * Math.exp(-0.5 * offset ** 2);
    };
    for (let t = 0.17; t < 75; t += 60 / 118) pulse(t);
    for (let t = 75.17; t < 120; t += 60 / 130) pulse(t);
    const g = fitOnsetGrid({ fps, t0: 0, env, lowMid: env, low: env }, 0, 120, 118);
    // A global majority vote alone accepts this case, but the exit is off-grid.
    expect(g.support).toBeGreaterThan(0.6);
    expect(g.stable).toBe(false);
  });

  it('tolerates a long quiet breakdown when audible drums on both sides keep the same pulse', () => {
    const o = syncopatedOnsets(118, 144);
    o.env.fill(0.001, 48 * o.fps, 72 * o.fps);
    const g = fitOnsetGrid(o, 0, 144, 118);
    expect(g.stable).toBe(true);
    expect(60 / g.period).toBeCloseTo(118, 1);
  });
});

describe('v2: no forced rhythm lock across a wide tempo gap', () => {
  it.each([[118, 140], [140, 118], [110, 140], [140, 110], [70, 118], [118, 70]])('%i → %i plays an unlocked blend at native tempi', (bpmA, bpmB) => {
    const a = measured('a', bpmA), b = measured('b', bpmB, 24);
    const p = planTransition(a, b, S);
    expect(['tempo_bridge', 'drop_mix', 'echo_out']).not.toContain(p.method);
    for (const [, rate] of [...(p.tempoA ?? [[0, 1]]), ...p.tempoB]) expect(rate).toBe(1);
    // not a cut: listeners rated sub-second and 3 s joins "резко"
    expect(p.duration).toBeGreaterThanOrEqual(6);
    expect(p.duration).toBeLessThanOrEqual(S.maxBlendSeconds + 0.001);
    expect(p.bEntry).toBeLessThanOrEqual(S.maxEntrySkipSeconds! + 0.001);
  });

  it('v2.5: stretches a deck by more than 8 % (never 10 %) only in a slow glide of at least 8 bars and 12 s', () => {
    let long = 0;
    for (const [x, y] of [[118, 127], [118, 128.5], [124, 135], [140.04, 110], [87, 174], [100, 108], [120, 131], [131, 120]]) {
      const p = planTransition(measured('a', x), measured('b', y), { ...S, maxStretchPercent: 12 });
      const worst = Math.max(...[...(p.tempoA ?? [[0, 1]]), ...p.tempoB].map(([, rate]) => Math.abs(rate - 1)));
      expect(worst).toBeLessThanOrEqual(0.1 + 1e-9);
      if (worst > 0.08 + 1e-9) {
        long++;
        expect(p.method).toBe('beatmatch_blend');
        expect(p.beatAlign!.overlapBeats).toBeGreaterThanOrEqual(32);
        expect(p.duration).toBeGreaterThanOrEqual(12);
      }
    }
    // 118 → 128.5 (8.9 %) and 120 ↔ 131 (9.2 %) were unlocked blends in v2.4
    expect(long).toBeGreaterThanOrEqual(2);
    // short transitions keep the 8 % limit
    const tight = planTransition(measured('a', 120), measured('b', 131), { ...S, style: 'tight' });
    for (const [, rate] of [...(tight.tempoA ?? [[0, 1]]), ...tight.tempoB]) expect(Math.abs(rate - 1)).toBeLessThanOrEqual(0.08 + 1e-9);
  });

  it('still beatmatches tempi within reach, including half/double time', () => {
    for (const [x, y] of [[124, 127], [87, 174], [128, 64.5]]) expect(planTransition(measured('a', x), measured('b', y), S).method).toBe('beatmatch_blend');
  });

  it('preserves the musical opening when intro skipping is disabled', () => {
    const p = planTransition(measured('a', 118), measured('b', 140, 24), { ...S, entryMode: 'preserve' });
    expect(p.bEntry).toBe(0);
  });
});

describe('musical Next request', () => {
  it('matches B’s entry to the loud current section rather than A’s quiet ending', () => {
    const a = measured('a', 118), b = measured('b', 140, 24);
    const an = a.analysis!;
    // The same song has a full middle section and a long quiet ending. A
    // natural end-of-song bridge can use B's quiet intro; Next in the middle
    // must select the later energetic arrival instead.
    for (let i = 90 * an.curves.rate; i < an.curves.rmsDb.length; i++) {
      an.curves.rmsDb[i] = -35;
      an.curves.lowDb[i] = -38;
      an.curves.midDb[i] = -41;
      an.curves.highDb[i] = -45;
    }
    const requested = planRequestedTransition(a, b, 52.37, S);
    expect(requested.aExit).toBeGreaterThan(52.37);
    expect(requested.aExit).toBeLessThan(55.57);
    // B's audible part starts at its loud section, not inside its quiet intro
    expect(requested.bEntry + requested.swapAt).toBeGreaterThanOrEqual(23.5);
    expect(requested.entrySelection!.kind).toBe('section');
  });

  it('retains the scored local exit instead of moving the chosen mix to an earlier downbeat', () => {
    const a = measured('a', 118), b = measured('b', 120, 24);
    const [first, stronger] = a.analysis!.beat!.downbeats.slice(26, 28);
    a.analysis!.cues.exit = [
      { time: first, score: 0, kind: 'downbeat', tags: [] },
      { time: stronger, score: 1, kind: 'downbeat', tags: ['clear-exit'] },
    ];
    // Both bar boundaries fall within the permitted short scheduling window.
    const now = first - 0.151;
    const p = planRequestedTransition(a, b, now, S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.aExit).toBeCloseTo(stronger, 2);
    expect(p.aExit - now).toBeLessThan(3.2);
  });

  it.each([[118, 140], [140, 118], [124, 127], [124, 160]])('starts %i → %i near the actual playback position', (bpmA, bpmB) => {
    const a = measured('a', bpmA), b = measured('b', bpmB, 24);
    const now = 52.37;
    const p = planRequestedTransition(a, b, now, S);
    expect(p.method).not.toBe('skip_fade');
    expect(p.aExit).toBeGreaterThan(now);
    expect(p.aExit - now).toBeLessThanOrEqual(3.2);
    expect(p.duration).toBeLessThanOrEqual(8.001);
    expect(p.aExit + integral(p.tempoA ?? [[0, 1]], p.duration)).toBeLessThanOrEqual(a.analysis!.audibleEnd + 0.003);
    expect(p.debug.requested).toBe(true);
  });

  it('retains the complete opening in preserve mode', () => {
    const p = planRequestedTransition(measured('a', 118), measured('b', 140, 24), 52.37, { ...S, entryMode: 'preserve' });
    expect(p.bEntry).toBe(0);
  });

  it('uses the fast switch when musical Next or AutoMix is disabled', () => {
    const a = measured('a', 118), b = measured('b', 140);
    for (const settings of [{ ...S, mixOnNext: false }, { ...S, enabled: false }]) {
      const p = planRequestedTransition(a, b, 52.37, settings);
      expect(p.method).toBe('skip_fade');
      expect(p.aExit).toBe(52.37);
      expect(p.duration).toBeLessThan(1);
    }
  });

  it('falls back to a short join when the outgoing track is almost over', () => {
    const a = measured('a', 118), b = measured('b', 140);
    const p = planRequestedTransition(a, b, 179.95, S);
    expect(p.method).toBe('skip_fade');
    expect(p.aExit).toBeGreaterThanOrEqual(179.95);
  });

  it('does not overlap or time-stretch a source that forbids processing', () => {
    for (const protectedDeck of ['A', 'B']) {
      const a = measured('a', 118), b = measured('b', 140);
      (protectedDeck === 'A' ? a : b).mixingAllowed = false;
      const p = planRequestedTransition(a, b, 52.37, S);
      expect(p.duration).toBe(0);
      expect(p.automation).toEqual([]);
      expect(p.tempoA).toBeUndefined();
      expect(p.tempoB).toEqual([[0, 1]]);
      const repeated = skipPlanFrom(planTransition(a, b, S), 52.37);
      expect(repeated.duration).toBe(0);
      expect(repeated.automation).toEqual([]);
      expect(repeated.gainA).toBe(0);
      expect(repeated.gainB).toBe(0);
    }
  });

  it('sanitizes invalid positions before building either a musical request or a fast skip', () => {
    const a = measured('a', 118), b = measured('b', 140);
    for (const position of [NaN, Infinity, -Infinity, -100, 1000]) for (const settings of [S, { ...S, mixOnNext: false }]) {
      const p = planRequestedTransition(a, b, position, settings);
      expect(Number.isFinite(p.aExit)).toBe(true);
      expect(p.aExit).toBeGreaterThanOrEqual(0);
      expect(p.aExit).toBeLessThanOrEqual(a.duration);
      expect(Number.isFinite(p.duration)).toBe(true);
      expect(Number.isFinite(p.bEntry)).toBe(true);
    }
  });
});
