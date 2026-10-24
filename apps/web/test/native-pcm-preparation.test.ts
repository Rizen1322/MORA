import { expect, it } from 'vitest';
import { uploadNativePcm } from '../src/lib/native-pcm-preparation.ts';
it('uses actual completed length rather than the earlier duration estimate', async () => {
  let calls = 0; const offsets: number[] = [];
  const count = await uploadNativePcm(async start => {
    calls++; return new Response(new Uint8Array(calls === 1 ? 16 : 8), { headers: {
      'X-Complete': calls === 1 ? '0' : '1', 'X-Total-Frames': calls === 1 ? '200' : '3', 'X-PCM-Format': 'f32le',
    } });
  }, async offset => { offsets.push(offset); }, new AbortController().signal);
  expect(count).toBe(3); expect(offsets).toEqual([0, 16]);
});
it('rejects a short incomplete response rather than silently completing the queue', async () => {
  await expect(uploadNativePcm(async () => new Response(new Uint8Array(), { headers: { 'X-Complete': '0', 'X-PCM-Format': 'f32le' } }),
    async () => {}, new AbortController().signal)).rejects.toThrow();
});
it('does not continue transferring after cancellation', async () => {
  const abort = new AbortController(); abort.abort();
  await expect(uploadNativePcm(async () => { throw Error('Should not fetch'); }, async () => {}, abort.signal)).rejects.toThrow();
});
