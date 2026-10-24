import { expect, it } from 'vitest';
import { analyzePcm } from '../src/mir/analyzePcm.ts';

const tone = (side: boolean) => {
  const sr = 44100, n = sr * 4, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const bass = 0.2 * Math.sin(2 * Math.PI * 60 * i / sr), mid = 0.1 * Math.sin(2 * Math.PI * 997 * i / sr);
    L[i] = bass + mid; R[i] = (side ? -bass : bass) + mid;
  }
  return analyzePcm(L, R);
};
const mean = (x: number[]) => x.slice(10, -10).reduce((s, v) => s + v, 0) / (x.length - 20);

// DSP audit B2: the same stereo energy, once with the bass out of phase between the channels
it('level and bass curves follow the stereo energy, not the mid fold-down', () => {
  const centre = tone(false), side = tone(true);
  expect(Math.abs(mean(side.curves.lowDb) - mean(centre.curves.lowDb))).toBeLessThan(1.5);
  expect(Math.abs(mean(side.curves.rmsDb) - mean(centre.curves.rmsDb))).toBeLessThan(1.5);
  expect(side.loudness.integratedLufs).toBeCloseTo(centre.loudness.integratedLufs, 2);
});
