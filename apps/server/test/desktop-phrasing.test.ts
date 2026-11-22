import { expect, it } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS, planTransition, type OfflineRender } from '@automix/core';
import { creativeTrack } from '../../../packages/core/test/creative-fixtures.ts';
import { desktopPhrase, usefulDesktopRender } from '../src/desktop-phrasing.ts';
import { reviewedPlanFits } from '../src/reviewed-transitions.ts';

function track(id: string, bpm: number) {
  const t = creativeTrack(id, bpm);
  const a = t.analysis!;
  a.key.camelot = '8A';
  a.beat!.accents = { kick: a.beat!.beats.map(() => 1.2), snare: a.beat!.beats.map(() => 1) };
  return t;
}

it('keeps the two cues aligned and trades bass before either source leaves', () => {
  const a = track('A', 120), b = track('B', 122), settings = DEFAULT_AUTOMIX_SETTINGS;
  const base = planTransition(a, b, settings), plan = desktopPhrase(base, a, b, settings, false)!;
  expect(plan.debug.desktopPhrase).toMatchObject({ style: 'relay' });
  expect(a.analysis!.beat!.downbeats).toContain(plan.aExit + plan.swapAt);
  expect(b.analysis!.beat!.downbeats.some(cue => Math.abs(cue - plan.bEntry - plan.tempoB[0][1] * plan.swapAt) < .001)).toBe(true);
  expect(plan.automation.find(x => x.lane === 'gain' && x.deck === 'A')!.points.at(-1)![0]).toBeGreaterThan(plan.swapAt);
  expect(desktopPhrase(base, a, b, { ...settings, entryMode: 'preserve' }, false)).toBeNull();
});

it('limits the three-beat bridge to marked instrumental recordings with compatible grids', () => {
  const a = track('A', 128), b = track('B', 128 * 4 / 3), settings = DEFAULT_AUTOMIX_SETTINGS;
  const base = { ...planTransition(a, b, settings), method: 'crossfade' as const };
  expect(desktopPhrase(base, a, b, settings, false)).toBeNull();
  expect(desktopPhrase(base, a, b, { ...settings, loopBridges: false }, true)).toBeNull();
  const plan = desktopPhrase(base, a, b, settings, true)!;
  const lead = 4 * b.analysis!.beat!.period;
  expect(plan.bDelay).toBeCloseTo(plan.swapAt - lead);
  expect(plan.loopA!.end - plan.loopA!.start).toBeCloseTo(3 * a.analysis!.beat!.period);
  expect(plan.loopA!.until - plan.loopA!.start).toBeGreaterThan(plan.swapAt);
  expect(plan.vocalA || plan.vocalB || plan.voiceEcho).toBeUndefined();
  expect(reviewedPlanFits(plan, a, b)).toBe(true);
  expect(reviewedPlanFits({ ...plan, bDelay: plan.bDelay! + .10 }, a, b)).toBe(false);
});

it('rejects failed native handoffs and large changes at the join', () => {
  const settings = DEFAULT_AUTOMIX_SETTINGS, a = track('A', 120), b = track('B', 120);
  const plan = desktopPhrase(planTransition(a, b, settings), a, b, settings, false)!;
  const sampleRate = 1000, n = 10000;
  const steady = Float32Array.from({ length: n }, (_, i) => .17 * Math.sin(i * .30));
  const audio: OfflineRender = { L: steady, R: steady, sampleRate, transitionStartFrame: 1000,
    events: [{ type: 'transitionEnd', planId: plan.id, token: 'B', forced: false }],
    metrics: { peak: .17, maxLimiterReductionDb: 0, underruns: 0 } };
  expect(usefulDesktopRender(plan, audio)).toBeTruthy();
  expect(usefulDesktopRender(plan, { ...audio, events: [] })).toBeNull();
  const drop = steady.slice();
  drop.fill(0, Math.round(1000 + sampleRate * plan.swapAt));
  expect(usefulDesktopRender(plan, { ...audio, L: drop, R: drop })).toBeNull();
});
