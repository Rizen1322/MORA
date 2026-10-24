import { expect, it } from 'vitest';
import { interleave } from '../src/worker/rpc.ts';

it('interleaves decoded planes the way ffmpeg writes f32le and s16le', () => {
  const L = Float32Array.from([0.5, -1]), R = Float32Array.from([0.25, 1]);
  expect([...new Float32Array(interleave([L, R], 'f32le'))]).toEqual([0.5, 0.25, -1, 1]);
  expect([...new Int16Array(interleave([L, R], 's16le'))]).toEqual([16383, 8191, -32768, 32767]);
});
