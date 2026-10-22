import { expect, it } from 'vitest';
import { ANALYSIS_RATE, computeSpectral } from '../src/mir/spectral.ts';
import { CURVE_RATE } from '../src/types.ts';

it('keeps the level curve on the clock: 22050 / 20 Hz windows do not drift', () => {
  const seconds = 600, sr = ANALYSIS_RATE;
  const x = new Float32Array(seconds * sr + 77);
  const click = 590 * sr; // exactly 590.000 s
  for (let i = click; i < click + 100; i++) x[i] = 0.9;
  const sp = computeSpectral(x, sr);
  expect(sp.rmsDb.length).toBe(Math.ceil((x.length * CURVE_RATE) / sr));
  const peak = sp.peaks.indexOf(Math.max(...sp.peaks));
  // 1103-sample windows would put the click 0.27 s (5 points) early.
  expect(peak).toBe(590 * CURVE_RATE);
});
