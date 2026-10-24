import { describe, expect, it } from 'vitest';
import { planFinalists, planTransition } from '../src/plan/planner.ts';
import { ratingBias, ratingFeatures, ratingStats } from '../src/plan/feedback.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type PlannerTrack, type TrackAnalysis, type TransitionPlan, type TransitionRating } from '../src/types.ts';

/** A measured, voice-unknown song (a full-mix pair), as in fullmix.test.ts. */
function song(id: string, bpm: number, { duration = 180, jitterMs = 2 } = {}): PlannerTrack {
  const rate = 20, period = 60 / bpm, density = 0.3;
  const rmsDb = Array.from({ length: duration * rate }, () => -16);
  const beats = Array.from({ length: Math.floor(duration / period) }, (_, i) => i * period);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  const analysis: TrackAnalysis = {
    version: 'feedback-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: { bpm, period, confidence: 0.93, stable: true, jitterMs, beats, downbeats, downbeatConfidence: 0.85, downbeatPhase: 0, alternatives: [] },
    beatRegions: [], rhythmStrength: 0.93,
    key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases: downbeats.filter((_, i) => i % 8 === 0), phraseConfidence: 0.8,
    sectionBoundaries: [], intro: { start: 0, end: 0 }, outro: { start: duration - 16, end: duration }, bodyRmsDb: -16,
    curves: { rate, rmsDb, lowDb: rmsDb.map(v => v - 3), midDb: rmsDb.map(v => v - 6), highDb: rmsDb.map(v => v - 10), midDensity: rmsDb.map(() => density) },
    peaks: rmsDb.map(() => 0.8),
    cues: { entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }], exit: downbeats.filter(t => t > duration - 40).map(time => ({ time, score: 0.8, kind: 'downbeat' as const, tags: [] })) },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.93, onsetRate: 0.4, bassWeight: 0.6, midDensity: density, dynamics: 0.2, acousticness: 0.1 },
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}

// a shaky pulse on A: the full mix offers an unlocked crossfade next to the locked baseline
const a = song('a', 120, { jitterMs: 25 }), b = song('b', 130);
const rows = (plan: TransitionPlan, rating: TransitionRating, n: number) =>
  Array.from({ length: n }, () => ({ rating, features: ratingFeatures(plan, a.analysis, b.analysis) }));
const selected = (p: TransitionPlan) => (p.debug.fullMix as { selected: string }).selected;

describe('listener ratings as a soft preference between finalists', () => {
  const plain = planFinalists(a, b, S);
  const base = plain[0];
  const unlocked = plain.find(p => (p.debug.fullMix as { this: string }).this === 'unlocked')!;

  it('describes plans by method, tempo gap, key, length and vocal masks', () => {
    expect(selected(base)).toBe('baseline');
    expect(unlocked.method).toBe('crossfade');
    expect(ratingFeatures(base, a.analysis, b.analysis)).toEqual(['method:beatmatch_blend', 'bpm:beatmatch_blend:8-12', 'key:beatmatch_blend:mid', 'length:10-20', 'vocals:none']);
    expect(ratingFeatures(unlocked, a.analysis, b.analysis)[1]).toBe('bpm:crossfade:8-12');
    // the tempo gap of an unlocked plan comes from the analyses; without them it is left out
    expect(ratingFeatures(unlocked).some(f => f.startsWith('bpm:'))).toBe(false);
  });

  it('plans exactly as before without ratings', () => {
    expect(ratingStats([])).toBeNull();
    for (const fb of [undefined, null, { version: 'ratings-empty', features: {} }]) {
      expect(planFinalists(a, b, S, fb)).toEqual(plain);
      expect(planTransition(a, b, S, undefined, fb)).toEqual(planTransition(a, b, S));
    }
    expect(base.debug.ratingFeedback).toBeUndefined();
  });

  it('smooths scarce ratings toward neutral and caps the bias', () => {
    const one = ratingStats(rows(base, 'bad', 1))!, many = ratingStats(rows(base, 'bad', 200))!;
    const b1 = ratingBias(one, base, a.analysis, b.analysis).bias, bMany = ratingBias(many, base, a.analysis, b.analysis).bias;
    expect(b1).toBeLessThan(0);
    expect(b1).toBeGreaterThan(-0.05);
    expect(bMany).toBe(-0.15);
    expect(ratingBias(ratingStats(rows(base, 'good', 200))!, base, a.analysis, b.analysis).bias).toBe(0.15);
    // a new rating is a new statistics version (part of the server's plan cache key)
    expect(one.version).not.toBe(ratingStats(rows(base, 'bad', 2))!.version);
  });

  it('does not change the choice for one or two bad ratings', () => {
    for (const n of [1, 2]) {
      const p = planFinalists(a, b, S, ratingStats(rows(base, 'bad', n)));
      expect(p[0].id).toBe(base.id);
      expect(selected(p[0])).toBe('baseline');
      expect(p[0].debug.ratingFeedback).toMatchObject({ policy: 'listener-ratings-1', selected: 'baseline' });
    }
  });

  it('prefers the alternative listeners rated well once the evidence is consistent', () => {
    const fb = ratingStats([...rows(base, 'bad', 6), ...rows(unlocked, 'good', 6)])!;
    const [top] = planFinalists(a, b, S, fb);
    expect(selected(top)).toBe('unlocked');
    expect(top.method).toBe('crossfade');
    // the alternative itself is the planner's own valid plan, only labelled
    expect(top.automation).toEqual(unlocked.automation);
    const record = top.debug.ratingFeedback as { version: string; selected: string; candidates: { name: string; bias: number }[] };
    expect(record.version).toBe(fb.version);
    expect(record.selected).toBe('unlocked');
    expect(record.candidates.find(c => c.name === 'baseline')!.bias).toBeLessThan(0);
    expect(record.candidates.find(c => c.name === 'unlocked')!.bias).toBeGreaterThan(0);
    expect(planTransition(a, b, S, undefined, fb).id).toBe(top.id);
  });
});
