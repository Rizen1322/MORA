import { expect, it } from 'vitest';
import { sweepPower } from '../src/plan/fullmix.ts';

const db = (v: number, hz: number) => 10 * Math.log10(sweepPower(v, [hz]));

// measured on StereoSweep at 48 kHz (DSP audit, B1): + is high-pass, - is low-pass
it('the planner estimate follows the real filter, not one shared share for both directions', () => {
  for (const [v, hz, measured] of [[0.7, 60, -50.3], [0.7, 1000, -3.77], [0.7, 8000, 0], [-0.7, 60, 0], [-0.7, 1000, -6.08], [-0.7, 8000, -42.65]] as const)
    expect(Math.abs(db(v, hz) - measured)).toBeLessThan(2.5);
  expect(sweepPower(0, [1000])).toBe(1);
});
