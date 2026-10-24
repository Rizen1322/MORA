import { expect, it } from 'vitest';
import { CHUNK_FRAMES, ChunkStore } from '../src/engine/chunks.ts';

const chunk = (n: number) => [new Float32Array(n).fill(0.5), new Float32Array(n).fill(0.5)] as const;

it('growing past the estimate refetches the chunk cut at the old end; real EOF ends reads', () => {
  const s = new ChunkStore(CHUNK_FRAMES + 100);
  s.put(0, ...chunk(CHUNK_FRAMES));
  s.put(1, ...chunk(100));
  expect(s.resize(CHUNK_FRAMES + 500)).toEqual([1]);
  expect(s.has(0)).toBe(true);
  expect(s.has(1)).toBe(false);
  s.put(1, ...chunk(500));
  const L = new Float32Array(600), R = new Float32Array(600);
  expect(s.read(CHUNK_FRAMES, 600, L, R, 0)).toBe(true);
  expect(L[499]).toBe(0.5);
  expect(L[500]).toBe(0);
});

it('shrinking drops chunks past the new end and needs no refetch', () => {
  const s = new ChunkStore(3 * CHUNK_FRAMES);
  for (let i = 0; i < 3; i++) s.put(i, ...chunk(CHUNK_FRAMES));
  expect(s.resize(CHUNK_FRAMES + 10)).toEqual([]);
  expect(s.has(2)).toBe(false);
  expect(s.chunkCount).toBe(2);
});
