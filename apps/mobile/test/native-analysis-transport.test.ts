import { afterEach, expect, it, vi } from 'vitest';
import { analyzeJSON } from '../src/native-preparation-core.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('keeps the same analysis when native PCM arrives as Float32Array instead of base64', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const frames = 44100, input = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) { input[i * 2] = Math.sin(i * .03) * .1; input[i * 2 + 1] = input[i * 2] * .8; }
  vi.stubGlobal('moraPreparationCancelled', () => false);
  vi.stubGlobal('moraPreparationProgress', () => {});
  vi.stubGlobal('moraPreparationRead', (start: number, count: number) => Buffer.from(input.buffer, start * 8, count * 8).toString('base64'));
  const old = JSON.parse(analyzeJSON(JSON.stringify({ frames })));
  vi.stubGlobal('moraPreparationRead', (start: number, count: number) => input.subarray(start * 2, (start + count) * 2));
  expect(JSON.parse(analyzeJSON(JSON.stringify({ frames })))).toEqual(old);
  vi.stubGlobal('moraPreparationRead', () => new Float32Array(1));
  expect(() => analyzeJSON(JSON.stringify({ frames }))).toThrow('short_pcm');
  vi.stubGlobal('moraPreparationRead', () => undefined);
  expect(() => analyzeJSON(JSON.stringify({ frames }))).toThrow('short_pcm');
});
