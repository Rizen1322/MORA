import { expect, it } from 'vitest';
import { Echo, LANE_INDEX } from '../src/engine/mixer.ts';
import { planToArmed, renderTransitionOffline } from '../src/engine/arm.ts';
import { planTransition } from '../src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type TransitionPlan } from '../src/types.ts';

function plan(): TransitionPlan {
  const track = { id: 'a', duration: 8, mixingAllowed: true, analysis: null };
  return { ...planTransition(track, { ...track, id: 'b' }, DEFAULT_AUTOMIX_SETTINGS),
    aExit: 1, bEntry: 0, duration: 2, gap: 0, swapAt: 0, gainA: 0, gainB: 0,
    tempoB: [[0, 1]], automation: [{ deck: 'A', lane: 'gain', points: [[0, 0]] },
      { deck: 'B', lane: 'gain', points: [[0, 1]] }] };
}

it('narrows only stereo side energy and preserves mono at the original level', () => {
  const sr = 8000, tone = Float32Array.from({ length: sr * 8 }, (_, i) => .1 * Math.sin(i * .21));
  const silent = { L: new Float32Array(tone.length), R: new Float32Array(tone.length), sampleRate: sr };
  const p = plan();
  p.automation.push({ deck: 'B', lane: 'width', points: [[0, 0], [.5, 0], [1, 1], [2, 1]] });
  const stereo = renderTransitionOffline(silent, { L: tone, R: tone.map(v => -v), sampleRate: sr }, p, 0, .1);
  const energy = (from: number, to: number) => stereo.L.slice(from * sr, to * sr).reduce((s, v) => s + v * v, 0);
  expect(energy(.1, .4)).toBe(0);
  expect(energy(1.2, 1.8)).toBeGreaterThan(1);
  expect(stereo.L.every((v, i) => Math.abs(v + stereo.R[i]) < 1e-6)).toBe(true);
  expect(stereo.metrics.underruns).toBe(0);
  const mono = { L: tone, R: tone, sampleRate: sr };
  const narrowed = renderTransitionOffline(silent, mono, p, 0, .1);
  const bypass = renderTransitionOffline(silent, mono, plan(), 0, .1);
  expect(narrowed.L).toEqual(bypass.L);
});

it('slows repeats continuously and independently of render block size', () => {
  const sr = 8000, n = sr, input = new Float32Array(n);
  input[80] = .3;
  const render = (block: number, moving: boolean) => {
    const echo = new Echo(sr), L = new Float32Array(n), R = new Float32Array(n);
    echo.configure(800, .3);
    if (moving) echo.setDelayMap([[0, 800], [1600, 800], [4800, 1600], [8000, 1600]], 0);
    for (let at = 0; at < n; at += block) {
      const end = Math.min(n, at + block), source = input.subarray(at, end);
      echo.process(source, source, L.subarray(at, end), R.subarray(at, end), end - at, at);
    }
    return L;
  };
  const moving = render(128, true), fixed = render(128, false);
  expect(moving).toEqual(render(317, true));
  expect(moving).not.toEqual(fixed);
  const energy = (v: Float32Array, start: number, end: number) => v.slice(start, end).reduce((s, x) => s + x * x, 0);
  expect(energy(moving, 1900, 2050)).toBeGreaterThan(energy(fixed, 1900, 2050));
  expect(moving.every(Number.isFinite)).toBe(true);
});

it('a bounded echo cannot reappear after its tail deadline, even with an open send', () => {
  const sr = 8000, n = sr, input = Float32Array.from({ length: n }, (_, i) => .1 * Math.sin(i * .2));
  const echo = new Echo(sr), L = new Float32Array(n), R = new Float32Array(n);
  echo.configure(800, .7); echo.limitTailAt(4000, 400);
  for (let at = 0; at < n; at += 128) {
    const end = Math.min(n, at + 128), source = input.subarray(at, end);
    echo.process(source, source, L.subarray(at, end), R.subarray(at, end), end - at, at);
  }
  expect(L.slice(1000, 2000).some(v => Math.abs(v) > .01)).toBe(true);
  expect(L.slice(4000).every(v => v === 0)).toBe(true);
});

it('converts and validates creative automation at the engine boundary', () => {
  const p = plan();
  p.echo = { delay: .25, feedback: .4, delayPoints: [[0, .25], [2, .5]], clearAt: 1.9 };
  p.automation.push({ deck: 'B', lane: 'width', points: [[0, 0], [1, 1]] });
  const armed = planToArmed(p, 48000, 'a', 'b');
  expect(armed.echoDelayPointsFrames).toEqual([[0, 12000], [96000, 24000]]);
  expect(armed.echoClearFrame).toBe(91200);
  expect(armed.lanes.at(-1)?.lane).toBe(LANE_INDEX.width);
  for (const points of [[[0, NaN]], [[0, -.1]], [[0, 3]], [[1, .2], [0, .3]], [[3, .3]]] as [number, number][][]) {
    expect(() => planToArmed({ ...p, echo: { ...p.echo!, delayPoints: points } }, 48000, 'a', 'b')).toThrow('Invalid creative');
  }
  expect(() => planToArmed({ ...p, echo: { ...p.echo!, clearAt: 3 } }, 48000, 'a', 'b')).toThrow('Invalid creative');
});
