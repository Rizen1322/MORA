import { expect, it } from 'vitest';
import { StereoSweep } from '../src/dsp/sweep.ts';
import { LANE_INDEX } from '../src/engine/mixer.ts';
import { planToArmed } from '../src/engine/arm.ts';
import { planTransition } from '../src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS } from '../src/types.ts';

function response(hz: number, control: number, sr = 48000) {
  const filter = new StereoSweep(sr), L = new Float32Array(128), R = L.slice(); let power = 0, count = 0;
  for (let b = 0; b < sr / 128; b++) {
    for (let i = 0; i < L.length; i++) L[i] = R[i] = .2 * Math.sin(2 * Math.PI * hz * (b * 128 + i) / sr);
    filter.processBlock(L, R, L.length, control, control);
    if (b > sr / 256) for (const x of L) { power += x * x; count++; }
  }
  return Math.sqrt(power / count);
}
it('is a bit-exact bypass with no filter automation', () => {
  const L = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i) * .3), R = L.slice(), original = L.slice();
  new StereoSweep(48000).processBlock(L, R, L.length, 0, 0);
  expect(L).toEqual(original); expect(R).toEqual(original);
});
it('provides real HPF/LPF frequency rejection at different device rates', () => {
  for (const sr of [32000, 44100, 48000, 96000]) {
    expect(response(60, .7, sr)).toBeLessThan(response(4000, .7, sr) * .02);
    expect(response(4000, -1, sr)).toBeLessThan(response(60, -1, sr) * .02);
  }
});
it('keeps rapid bipolar sweeps finite and bounded', () => {
  const filter = new StereoSweep(48000), L = new Float32Array(128), R = L.slice(); let previous = 0, maxJump = 0;
  for (let b = 0; b < 1000; b++) {
    for (let i = 0; i < L.length; i++) L[i] = R[i] = .2 * Math.sin((b * 128 + i) * .03);
    filter.processBlock(L, R, L.length, b % 2 ? -1 : 1, b % 2 ? 1 : -1);
    for (const x of L) { expect(Number.isFinite(x)).toBe(true); expect(Math.abs(x)).toBeLessThan(.7); maxJump = Math.max(maxJump, Math.abs(x - previous)); previous = x; }
  }
  expect(maxJump).toBeLessThan(.08);
});
it('keeps filter lanes through the seconds-to-audio-clock conversion', () => {
  const plan = planTransition({ id: 'a', duration: 180, mixingAllowed: true, analysis: null }, { id: 'b', duration: 180, mixingAllowed: true, analysis: null }, DEFAULT_AUTOMIX_SETTINGS);
  plan.automation.push({ deck: 'A', lane: 'filter', points: [[0, 0], [1, .7]] });
  expect(planToArmed(plan, 48000, 'a', 'b').lanes.find(l => l.lane === LANE_INDEX.filter)?.points).toEqual([[0, 0], [48000, .7]]);
});
