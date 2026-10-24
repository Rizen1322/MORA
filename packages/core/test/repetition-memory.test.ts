import { expect, it } from 'vitest';
import { analyzeStructure } from '../src/mir/repetition.ts';
import { ANALYSIS_RATE, CHROMA_EVERY, HOP, MEL_BANDS, type SpectralData } from '../src/mir/spectral.ts';

it('keeps structure analysis of a two-hour recording within a bounded amount of memory', () => {
  const seconds = 2 * 3600, fps = ANALYSIS_RATE / HOP, chromaFps = fps / CHROMA_EVERY;
  const frames = Math.floor(seconds * fps), chromaFrames = Math.floor(seconds * chromaFps);
  const mel = new Float32Array(frames * MEL_BANDS), chroma = new Float32Array(chromaFrames * 12);
  // Two alternating 32 s sections, so there is repetition to find.
  for (let f = 0; f < frames; f++) { const sec = Math.floor(f / fps / 32) % 2; for (let k = 0; k < MEL_BANDS; k++) mel[f * MEL_BANDS + k] = sec ? 1 + k : MEL_BANDS - k; }
  for (let f = 0; f < chromaFrames; f++) { const sec = Math.floor(f / chromaFps / 32) % 2; chroma[f * 12 + (sec ? 0 : 7)] = 1; chroma[f * 12 + (sec ? 4 : 11)] = 0.5; }
  const sp = { fps, frames, mel, chroma, chromaFps, chromaFrames } as unknown as SpectralData;
  const rmsDb = new Array(seconds * 20).fill(-12);
  const before = process.resourceUsage().maxRSS;
  const st = analyzeStructure({ sp, rmsDb, curveRate: 20, start: 0, end: seconds, body: -12, beat: null });
  const grewMiB = (process.resourceUsage().maxRSS - before) / 1024;
  expect(st).not.toBeNull();
  expect(st!.groups.length).toBeGreaterThan(0);
  // A full 0.5 s grid would need three 14400 x 14400 float matrices (~2.3 GiB).
  expect(grewMiB).toBeLessThan(400);
});
