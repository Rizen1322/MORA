import { expect, it } from 'vitest';
import { stemlessLoopAudition } from '../src/plan/stemless-loop.ts';
import { humanTransitionScenarios } from '../src/plan/human-scenarios.ts';
import { DEFAULT_AUTOMIX_SETTINGS as settings, PLANNER_VERSION, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';
import { integrateTempo, pointValue } from '../src/plan/timing.ts';
import { planForSourceWindows } from '../../../tools/review-source-window.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';

function fixture() {
  const A = { duration: 60, audibleStart: 0, audibleEnd: 60, bodyRmsDb: -16,
    beat: { stable: true, confidence: .95, downbeatConfidence: .95, jitterMs: 5, period: .5, downbeats: Array.from({ length: 30 }, (_, i) => i * 2) },
    curves: { rate: 20, ...Object.fromEntries(['rmsDb', 'lowDb', 'midDb', 'highDb'].map(key => [key, Array.from({ length: 1200 }, (_, i) => -16 + Math.sin(i * Math.PI / 20))])) }
  } as unknown as TrackAnalysis;
  const base = { id: 'test', version: 'test', fromTrack: 'a', toTrack: 'b', method: 'beatmatch_blend', aExit: 20, bEntry: 2, duration: 16,
    swapAt: 8, gap: 0, gainA: 0, gainB: 0, confidence: .8, tempoB: [[0, 1]], beatAlign: {}, reasons: [], debug: { processingAllowed: true },
    automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [12, .5], [16, 0]] }, { deck: 'B', lane: 'gain', points: [[0, 0], [8, 1], [16, 1]] }]
  } as unknown as TransitionPlan;
  return { A, base };
}
it('uses full-mix measurements with stems disabled, keeps B intact and stops A at a measured bar', () => {
  const { A, base } = fixture(), before = JSON.stringify(base);
  const candidate = stemlessLoopAudition(base, A, { ...settings, stemMixing: false })!;
  expect(candidate.auditionOnly).toBe(true);
  expect(candidate.plan.version).toBe(PLANNER_VERSION);
  expect(candidate.plan.vocalA).toBeUndefined();
  expect(candidate.plan.automation.filter(l => l.deck === 'B')).toEqual(base.automation.filter(l => l.deck === 'B'));
  expect(candidate.plan.tempoB).toEqual(base.tempoB);
  expect(candidate.plan.bEntry).toBe(base.bEntry);
  expect(A.beat!.downbeats).toContain(candidate.plan.loopA!.until);
  const gain = candidate.plan.automation.find(l => l.deck === 'A' && l.lane === 'gain')!;
  expect(pointValue(gain.points, 8)).toBe(0);
  expect(pointValue(gain.points, 15)).toBe(0);
  expect(JSON.stringify(base)).toBe(before);
  // The editor recipe format cannot serialize source loops yet: never offer a
  // scenario there which would silently lose its defining audio operation.
  expect(humanTransitionScenarios(base, A, A, settings).some(x => x.name === candidate.name)).toBe(false);
});
it('rejects incomplete analysis, invalid clocks, unreliable bars and disabled looping', () => {
  const { A, base } = fixture();
  expect(stemlessLoopAudition(base, A, { ...settings, loopBridges: false })).toBeNull();
  expect(stemlessLoopAudition(base, { ...A, beat: { ...A.beat!, downbeatConfidence: .1 } }, settings)).toBeNull();
  expect(stemlessLoopAudition(base, { ...A, curves: { ...A.curves, midDb: [] } }, settings)).toBeNull();
  expect(stemlessLoopAudition({ ...base, tempoA: [[0, NaN]] }, A, settings)).toBeNull();
  for (const key of ['confidence', 'downbeatConfidence', 'jitterMs'] as const)
    expect(stemlessLoopAudition(base, { ...A, beat: { ...A.beat!, [key]: NaN } }, settings)).toBeNull();
  expect(stemlessLoopAudition({ ...base, swapAt: NaN }, A, settings)).toBeNull();
  expect(stemlessLoopAudition(base, A, { ...settings, maxBlendSeconds: NaN })).toBeNull();
  expect(stemlessLoopAudition(base, { ...A, curves: { ...A.curves, midDb: undefined! } }, settings)).toBeNull();
  for (const downbeats of [undefined, [0, NaN, 4], [0, 4, 2]])
    expect(stemlessLoopAudition(base, { ...A, beat: { ...A.beat!, downbeats: downbeats! } }, settings)).toBeNull();
});
it('maps the finite source loop stop and release through a changing A tempo', () => {
  const { A, base } = fixture();
  const p = stemlessLoopAudition({ ...base, tempoA: [[0, 1], [16, .96]] }, A, settings)!.plan;
  const detail = p.debug.humanScenario as { exit: number; release: number };
  expect(p.aExit + integrateTempo(p.tempoA, detail.exit)).toBeCloseTo(p.loopA!.until, 6);
  expect(p.aExit + integrateTempo(p.tempoA, detail.release)).toBeCloseTo(p.loopA!.until - 4 * A.beat!.period, 6);
  expect(pointValue(p.automation.find(l => l.deck === 'A' && l.lane === 'gain')!.points, detail.exit)).toBe(0);
  expect(detail.exit).not.toBe(p.loopA!.until - p.aExit);
});
it('renders identically from full files and shifted source windows, including loop coordinates', () => {
  const { A, base } = fixture(), p = stemlessLoopAudition(base, A, settings)!.plan;
  const sr = 8000, L = Float32Array.from({ length: sr * 60 }, (_, i) => .15 * Math.sin(i * .17) + .03 * Math.sin(i * .023));
  const full = { L, R: L, sampleRate: sr }, offset = 16;
  const cropped = { L: L.slice(offset * sr), R: L.slice(offset * sr), sampleRate: sr };
  const original = JSON.stringify(p), shifted = planForSourceWindows(p, offset, 0);
  const a = renderTransitionOffline(full, full, p, 2, 2), b = renderTransitionOffline(cropped, full, shifted, 2, 2);
  expect(a.metrics.underruns).toBe(0); expect(b.metrics.underruns).toBe(0);
  expect(b.L).toEqual(a.L); expect(JSON.stringify(p)).toBe(original);
  const roll = planForSourceWindows({ ...p, loopA: { ...p.loopA!, roll: [{ at: 26, length: 1 }] } }, offset, 0).loopA!;
  expect(roll.roll).toEqual([{ at: 10, length: 1 }]);
  expect(roll.crossfade).toBe(.006);
});
