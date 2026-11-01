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
  // Rate distinct recipes even when the unassisted chooser already prefers the unlocked one.
  const base = plain.find(p => (p.debug.fullMix as { this: string }).this === 'baseline')!;
  const unlocked = plain.find(p => (p.debug.fullMix as { this: string }).this === 'unlocked')!;

  it('describes plans by method, tempo gap, key, length and vocal masks', () => {
    expect(unlocked.method).toBe('crossfade');
    expect(ratingFeatures(base, a.analysis, b.analysis)).toEqual(expect.arrayContaining([`method:${base.method}`, `bpm:${base.method}:8-12`, `key:${base.method}:mid`, 'vocals:none']));
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

  it('keeps scarce feedback bounded and only selects an existing valid alternative', () => {
    for (const n of [1, 2]) {
      const p = planFinalists(a, b, S, ratingStats(rows(base, 'bad', n)));
      expect((base.debug.fullMix as { candidates: { name: string }[] }).candidates.map(c => c.name)).toContain(selected(p[0]));
      const changes = p[0].debug.ratingFeedback as { candidates: { bias: number }[] };
      expect(changes.candidates.every(c => Math.abs(c.bias) < 0.1)).toBe(true);
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

describe('reason-aware recipe evidence', () => {
  const control = planFinalists(a, b, S).find(p => (p.debug.fullMix as {this:string}).this === 'baseline')!;
  const p: TransitionPlan = { ...control, bDelay: 0, automation: [
    { deck: 'A' as const, lane: 'gain' as const, points: [[0, 1], [control.duration, 1]] as [number, number][] },
    { deck: 'B' as const, lane: 'gain' as const, points: [[0, 1], [control.duration, 1]] as [number, number][] },
  ] };
  const features = (plan: TransitionPlan) => ratingFeatures(plan, a.analysis, b.analysis);
  const identity = (plan: TransitionPlan) => features(plan).find(f => f.startsWith('pair-recipe:'));

  it('targets a voice complaint at overlap without teaching method or length dislikes', () => {
    const stats = ratingStats([{ rating: 'bad', reason: 'голоса наложились', features: features(p) }])!;
    expect(stats.features).toEqual({});
    expect(Object.keys(stats.reasons!['голоса наложились']!)).toEqual(expect.arrayContaining([expect.stringMatching(/^mid-overlap:/), expect.stringMatching(/^pair-recipe:/)]));
    expect(Object.keys(stats.reasons!['голоса наложились']!).some(f => /^(method|length|bpm):/.test(f))).toBe(false);
    const other = ratingStats([{ rating: 'bad', reason: 'резко', features: features(p) }])!;
    expect(other.version).not.toBe(stats.version);
  });

  it('distinguishes same-length automation and scopes exact evidence to ordered pair and version', () => {
    const open = { ...p, automation: p.automation.map(l => l.lane === 'mid' ? { ...l, points: [[0, 1], [p.duration, 1]] as [number, number][] } : l) };
    const closed = { ...p, automation: [...p.automation.filter(l => l.lane !== 'mid'), { deck: 'A' as const, lane: 'mid' as const, points: [[0, 0], [p.duration, 0]] as [number, number][] }] };
    expect(features(open).find(f => f.startsWith('mid-overlap:'))).not.toBe(features(closed).find(f => f.startsWith('mid-overlap:')));
    for (const different of [closed, { ...p, fromTrackId: p.toTrackId, toTrackId: p.fromTrackId }, { ...p, version: 'future' }, { ...p, bEntry: p.bEntry + 1 }]) expect(identity(different)).not.toBe(identity(p));
    const stats = ratingStats(Array.from({ length: 8 }, () => ({ rating: 'bad' as const, reason: 'голоса наложились' as const, features: features(open) })))!;
    expect(ratingBias(stats, open, a.analysis, b.analysis).bias).toBeLessThan(ratingBias(stats, closed, a.analysis, b.analysis).bias);
  });

  it('leaves missing historical cuts, entries, key and tempo unknown and uses executed mask availability', () => {
    const historical = { ...p, beatAlign: undefined, keyInfo: undefined, vocalA: [[0, 0]] as [number, number][] };
    const fs = ratingFeatures(historical, null, null, { outcome: { stems: { masks: { A: false, B: false } } } });
    expect(fs).toContain('vocals:none');
    expect(fs.some(f => /^(cut|entry|key|bpm):/.test(f))).toBe(false);
  });
  it('carries measured complaint risks across planner upgrades without carrying exact recipe identity', () => {
    const open = { ...p, automation: p.automation.map(l => l.lane === 'mid' ? { ...l, points: [[0, 1], [p.duration, 1]] as [number, number][] } : l) };
    const closed = { ...p, automation: [...p.automation.filter(l => l.lane !== 'mid'), { deck: 'A' as const, lane: 'mid' as const, points: [[0, 0], [p.duration, 0]] as [number, number][] }] };
    const old = { ...open, version: 'previous-planner' };
    const stats = ratingStats(Array.from({ length: 8 }, () => ({ rating: 'bad' as const, reason: 'голоса наложились' as const, features: features(old) })))!;
    expect(identity(old)).not.toBe(identity(open));
    expect(ratingBias(stats, open, a.analysis, b.analysis).bias).toBeLessThan(ratingBias(stats, closed, a.analysis, b.analysis).bias);
  });
});
