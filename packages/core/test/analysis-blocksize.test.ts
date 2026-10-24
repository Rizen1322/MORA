import { describe, expect, it } from 'vitest';
import { AnalysisAccumulator } from '../src/mir/analyzePcm.ts';
import { synthesize } from '../src/synth/synth.ts';

function analyzeInBlocks(L: Float32Array, R: Float32Array, block: number) {
  const acc = new AnalysisAccumulator(L.length / 44100);
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    acc.push(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  // elapsedMs is wall-clock time, not analysis output
  return { ...acc.finish(), elapsedMs: 0 };
}

describe('AnalysisAccumulator block-size independence', () => {
  const pcm = synthesize({ style: 'house', bpm: 124, tonic: 9, mode: 'minor', bars: 16, seed: 3 });
  const fully = { L: pcm.L, R: pcm.L.map((v) => -v) };
  // out of phase only from an odd offset on, so the switch never lines up with any caller block
  const cut = 100_001;
  const partly = { L: pcm.L, R: pcm.R.map((v, i) => (i >= cut ? -pcm.L[i] : v)) };

  for (const [name, s] of [['out-of-phase', fully], ['partly out-of-phase', partly]] as const) {
    it(`${name}: identical analysis for block sizes 1000, 4096 and 65536`, () => {
      const [a, b, c] = [1000, 4096, 65536].map((block) => analyzeInBlocks(s.L, s.R, block));
      expect(a.warnings).toContain('stereo-cancellation-guard');
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    });
  }
});
