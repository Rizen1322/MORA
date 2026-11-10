import { expect, it } from 'vitest';
import { bandLevels, LevelsAnalyser } from '../src/audio/levels-analyser.ts';

it('drives the visuals from native band levels: RMS kept, spectral peak in the right band', () => {
  const pcm = Array.from({ length: 2048 }, (_, i) => .5 * Math.sin(2 * Math.PI * 64 * i / 2048));
  const { rms, bands } = bandLevels(pcm, 48000);
  expect(rms).toBeCloseTo(.5 / Math.SQRT2, 3);
  const banded = new LevelsAnalyser({ sampleRate: 48000, currentTime: 0, baseLatency: 0 });
  banded.levels(rms, bands);
  const b = new Float32Array(2048);
  const r = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  banded.getFloatTimeDomainData(b); expect(r(b)).toBeCloseTo(rms, 5);
  const fb = new Float32Array(1024);
  banded.getFloatFrequencyData(fb);
  const peak = fb.indexOf(Math.max(...fb.subarray(1)));
  expect(Math.abs(peak * 48000 / 2048 - 1500)).toBeLessThan(500);
  banded.levels(NaN, bands); banded.getFloatTimeDomainData(b); expect(r(b)).toBeCloseTo(rms, 5);
});
