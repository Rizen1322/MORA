import { expect, it, vi } from 'vitest';
import { computeSpectral } from '../src/mir/spectral.ts';

// Field order of NativeSpectral.swift's packed result.
const order = ['fluxLow', 'fluxMid', 'fluxHigh', 'powLow', 'powMid', 'powHigh', 'centroid', 'midDensity', 'chroma', 'mel', 'rmsDb', 'peaks'] as const;

it('unpacks the native spectral stage exactly like the JS reference and never falls back after a bad result', () => {
  const x = Float32Array.from({ length: 22050 * 3 + 77 }, (_, i) => Math.sin(i * .05) * .3 + Math.sin(i * .71) * .1);
  const reference = computeSpectral(x);
  const packed = new Float32Array(order.reduce((n, key) => n + reference[key].length, 0));
  let at = 0;
  for (const key of order) { packed.set(reference[key], at); at += reference[key].length; }
  const native = vi.fn((input: Float32Array, sr: number) => (input === x && sr === 22050 ? packed : null));
  vi.stubGlobal('moraPreparationSpectral', native);
  try {
    expect(computeSpectral(x)).toEqual(reference);
    native.mockReturnValueOnce(new Float32Array(0)); // Cancelled native run.
    expect(() => computeSpectral(x)).toThrow('native_spectral');
    native.mockReturnValueOnce(null);
    expect(computeSpectral(x)).toEqual(reference);
  } finally { vi.unstubAllGlobals(); }
});
