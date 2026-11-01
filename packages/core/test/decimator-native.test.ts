import { expect, it, vi } from 'vitest';
import { Decimator2 } from '../src/dsp/loudness.ts';
import { Decimator2 as Reference } from './reference/decimator-v1.ts';

it('keeps decimator history, odd phase and double precision across native/fallback blocks', () => {
  let calls = 0;
  const native = vi.fn((input: Float32Array, length: number, coefficients: Float64Array, history: Float64Array, pos: number, phase: number) => {
    if (++calls % 2 === 0) return null;
    const reference = new Reference();
    Object.assign(reference, { h: coefficients, buf: history.subarray(0, 31), pos, phase });
    const output: number[] = [];
    reference.push(input, length, value => output.push(value));
    history.set(history.subarray(0, 31), 31);
    const state = reference as unknown as { pos: number; phase: number };
    return { output: Float64Array.from(output), pos: state.pos, phase: state.phase };
  });
  vi.stubGlobal('moraPreparationDecimate', native);
  try {
    const actual = new Decimator2(), reference = new Reference(), got: number[] = [], expected: number[] = [];
    let offset = 0;
    for (const length of [0, 1, 2, 7, 31, 4, 127, 65536, 1]) {
      const backing = Float32Array.from({ length: length + 2 }, (_, i) => Math.sin((offset + i) * .19));
      const input = backing.subarray(1, length + 1);
      actual.push(input, length, value => got.push(value));
      reference.push(input, length, value => expected.push(value));
      offset += length;
    }
    expect(got).toEqual(expected);
    expect(native).toHaveBeenCalledTimes(9);
    expect(got.some(value => value !== Math.fround(value))).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
