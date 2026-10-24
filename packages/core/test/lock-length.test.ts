import { expect, it } from 'vitest';
import { planTransition } from '../src/plan/planner.ts';
import { pointValue } from '../src/plan/timing.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';

// v13 (P1, P2): a lock is judged in seconds, and a key clash takes turns in the mids instead of shortening it.
function analysis(bpm: number, camelot = '', duration = 240): TrackAnalysis {
  const rate = 20, period = 60 / bpm, beats = Array.from({ length: Math.ceil(duration / period) }, (_, i) => i * period).filter(t => t < duration);
  const c = Array.from({ length: duration * rate }, () => -18), downbeats = beats.filter((_, i) => i % 4 === 0);
  return { version: 'lock', duration, audibleStart: 0, audibleEnd: duration, bodyRmsDb: -18,
    loudness: { integratedLufs: -16, samplePeakDb: -5, truePeakDb: -4 },
    beat: { bpm, period, confidence: .95, stable: true, jitterMs: 2, beats, downbeats, downbeatConfidence: .9, downbeatPhase: 0, alternatives: [] },
    rhythmStrength: .9, key: { tonic: -1, mode: 'unknown', name: camelot || 'unknown', camelot, confidence: camelot ? .8 : 0 },
    phrases: downbeats.filter((_, i) => i % 4 === 0), phraseConfidence: .9, sectionBoundaries: [], intro: { start: 0, end: 0 }, outro: { start: duration - 4, end: duration },
    curves: { rate, rmsDb: c, lowDb: c.map(x => x - 3), midDb: c.map(x => x - 6), highDb: c.map(x => x - 10), midDensity: c.map(() => .2) }, peaks: c.map(() => .8),
    cues: { entry: [{ time: 0, score: .9, kind: 'start', tags: [] }], exit: downbeats.filter(t => t > duration / 2).map(time => ({ time, score: .8, kind: 'downbeat', tags: [] })) },
    features: { energy: .6, brightness: .5, rhythmStrength: .9, onsetRate: .4, bassWeight: .6, midDensity: .2, dynamics: .2, acousticness: .1 },
    vocalActivity: { rate: 100, values: Array(duration * 100).fill(.01), source: 'demucs', model: 'test' }, warnings: [], elapsedMs: 0 };
}
const track = (id: string, a: TrackAnalysis): PlannerTrack => ({ id, duration: a.duration, mixingAllowed: true, analysis: a });
const lane = (p: TransitionPlan, d: 'A' | 'B', l: 'mid', t: number) => pointValue(p.automation.find(x => x.deck === d && x.lane === l)?.points ?? [[0, 1]], t);

it('keeps a fast-tempo lock at 10 s or longer', () => {
  const p = planTransition(track('a', analysis(152)), track('b', analysis(150)), S);
  expect(p.method).toBe('beatmatch_blend');
  expect(p.duration).toBeGreaterThanOrEqual(10);
});

it('does not shorten a lock with clashing keys; the mids take turns around the bass swap', () => {
  const p = planTransition(track('a', analysis(152, '8A')), track('b', analysis(150, '3B')), S);
  expect(p.method).toBe('beatmatch_blend');
  expect(p.keyInfo!.compatibility).toBeLessThan(0.5);
  expect(p.duration).toBeGreaterThanOrEqual(10);
  const beat = 60 / 152;
  expect(lane(p, 'B', 'mid', p.swapAt / 2)).toBeLessThanOrEqual(0.45);
  // harmonic.ts may already hold A's mids at -1 dB
  expect(lane(p, 'A', 'mid', p.swapAt - beat)).toBeGreaterThanOrEqual(0.85);
  expect(lane(p, 'A', 'mid', p.swapAt + beat)).toBeGreaterThanOrEqual(0.5);
  expect(lane(p, 'A', 'mid', p.duration)).toBeLessThanOrEqual(0.25);
  expect(lane(p, 'B', 'mid', p.swapAt + beat)).toBeGreaterThanOrEqual(0.95);
  expect(p.reasons.some(r => r.includes('по очереди'))).toBe(true);
});
