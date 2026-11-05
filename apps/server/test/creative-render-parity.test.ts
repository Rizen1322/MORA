import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS, planTransition, renderMetrics, type TransitionPlan } from '@automix/core';
import { renderTransitionOffline } from '@automix/core/engine/arm.ts';
import { measureRust, renderRust } from '../src/rust-render.ts';
import { creativePair } from '../../../packages/core/test/creative-fixtures.ts';
import { planCreativeTransition } from '@automix/core';
import { stopRustCompute } from '../src/rust-core.ts';

const binary = process.env.AUTOMIX_RUST_CORE;
afterAll(stopRustCompute);

it.skipIf(!binary || !fs.existsSync(path.resolve(binary)))('measures the brake from cropped source windows instead of skipping its render check', async () => {
  const c = creativePair('short-brake'), plan = planCreativeTransition(c.from, c.to, c.settings, c.style)!;
  const sampleRate = 44100, fromA = plan.aExit - 7;
  const pcm = { L: Float32Array.from({ length: sampleRate * 32 }, (_, i) => .1 * Math.sin(i * .2)), R: new Float32Array(sampleRate * 32), sampleRate };
  pcm.R.set(pcm.L);
  const a = { pcm, start: fromA }, b = { pcm, start: 0 };
  const ts = renderMetrics(plan, a, b), rust = await measureRust(plan, a, b);
  expect(ts).not.toBeNull(); expect(rust).not.toBeNull();
  expect(ts!.underruns).toBe(0); expect(rust!.underruns).toBe(0);
  for (const key of ['dipLU', 'bumpLU', 'limiterDb', 'lowHoleSeconds', 'flams', 'cost'] as const) expect(rust![key]).toBeCloseTo(ts![key], 2);
});

it.skipIf(!binary || !fs.existsSync(path.resolve(binary)))('renders moving echoes and bounded tails like the native mixer', async () => {
  const sampleRate = 48000, n = sampleRate * 6;
  const a = { L: new Float32Array(n), R: new Float32Array(n), sampleRate };
  for (let i = sampleRate; i < sampleRate * 1.15; i++) a.L[i] = a.R[i] = .2 * Math.sin(i * .37);
  const L = Float32Array.from({ length: n }, (_, i) => .08 * Math.sin(i * .19));
  const b = { L, R: L.map(v => -v * .7), sampleRate };
  const track = { id: 'a', duration: 6, analysis: null, mixingAllowed: true };
  const base: TransitionPlan = { ...planTransition(track, { ...track, id: 'b' }, DEFAULT_AUTOMIX_SETTINGS),
    aExit: 1, bEntry: 0, duration: 3, gap: 0, swapAt: 1, gainA: 0, gainB: 0, tempoB: [[0, 1]],
    echo: { delay: .2, feedback: .3, delayPoints: [[0, .2], [.5, .2], [1.5, .4], [3, .4]], clearAt: 2.5 },
    automation: [{ deck: 'A', lane: 'gain', points: [[0, .5], [.2, 0]] },
      { deck: 'A', lane: 'echo', points: [[0, .5], [.15, .5], [.2, 0]] },
      { deck: 'B', lane: 'gain', points: [[0, 0], [.1, .8], [1, 1]] },
      { deck: 'B', lane: 'filter', points: [[0, -.4], [1.5, 0], [3, 0]] }] };
  const ts = renderTransitionOffline(a, b, base, .25, .25);
  const rust = await renderRust(a, b, base, .25, .25);
  expect(ts.metrics.underruns).toBe(0); expect(rust.metrics.underruns).toBe(0);
  expect(rust.L.length).toBe(ts.L.length);
  let max = 0, power = 0;
  for (let i = 0; i < ts.L.length; i++) for (const channel of ['L', 'R'] as const) {
    const error = rust[channel][i] - ts[channel][i]; max = Math.max(max, Math.abs(error)); power += error * error;
  }
  expect(max).toBeLessThan(2e-5);
  expect(Math.sqrt(power / (ts.L.length * 2))).toBeLessThan(2e-6);
  expect(rust.events.some(e => e.type === 'transitionEnd')).toBe(true);
});
