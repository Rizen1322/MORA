import { expect, it, vi } from 'vitest';
import { createNativeMix, prepareNativeMixArtwork } from '../src/bridge/native-mix.ts';
const state = { active: true, playing: true, index: 0, position: 0, duration: 3 };
const track = (i: number) => ({ title: String(i), artist: '', totalFrames: 100, gainDb: 0, file: i });
const port = (order: string[] = []) => ({
  nativeMixBegin: async () => { order.push('begin'); return { id: 'test' }; },
  nativeMixAppend: async ({ track }: { track: number }) => { order.push(`append ${track}`); },
  nativeMixStart: async () => { order.push('start'); return state; },
  nativeMixUpdate: async ({ from }: { from: number }) => { order.push(`update ${from}`); return state; },
  nativeMixStop: async () => { order.push('stop'); },
  nativeMixState: async () => state, nativeMixCommand: async () => state,
});
it('prefetches both covers, strips URLs, and preserves the corresponding track artwork', async () => {
  const tracks = [0, 1].map(i => ({ ...track(i), coverUrl: `https://covers.test/${i}` }));
  const result = await prepareNativeMixArtwork(tracks, async url => ({ base64: url.endsWith('/0') ? 'AAAA' : 'BBBB', mime: 'image/png' }));
  expect(result.map(t => t.artwork?.base64)).toEqual(['AAAA', 'BBBB']);
  expect(result.every(t => !('coverUrl' in t))).toBe(true);
});
it('allows playback without a missing, failed or oversized cover', async () => {
  const tracks = [0, 1, 2].map(i => ({ ...track(i), ...(i ? { coverUrl: `https://covers.test/${i}` } : {}) }));
  const result = await prepareNativeMixArtwork(tracks, async url => {
    if (url.endsWith('/1')) throw Error('unavailable');
    return { base64: 'A'.repeat(2800001), mime: 'image/png' };
  });
  expect(result.every(t => !t.artwork && !('coverUrl' in t))).toBe(true);
});
it('isolates WebKit once, keeps the session for later tracks and releases it on stop', async () => {
  const order: string[] = [];
  const mix = createNativeMix(port(order), { prepare: async () => { order.push('isolate'); }, restore: () => { order.push('restore'); } });
  await mix.upload(0, 0, new ArrayBuffer(8));
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  await mix.upload(1, 0, new ArrayBuffer(8));
  await mix.update(1, [track(1)]);
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(1)] });
  expect(order).toEqual(['isolate', 'begin', 'append 0', 'start', 'append 1', 'update 1', 'start']);
  await mix.stop(); expect(order.slice(-2)).toEqual(['stop', 'restore']);
});
it('keeps WebKit isolated if native release fails after an upload failure', async () => {
  const restore = vi.fn();
  const mix = createNativeMix({ ...port(), nativeMixAppend: async () => { throw Error('upload'); },
    nativeMixStart: async () => { throw Error('start'); }, nativeMixStop: async () => { throw Error('release'); },
  }, { prepare: async () => {}, restore });
  await expect(mix.upload(0, 0, new ArrayBuffer(8))).rejects.toThrow('upload');
  await expect(mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] })).rejects.toThrow('release');
  expect(restore).not.toHaveBeenCalled();
});
it('does not start audio after cancellation while covers were being loaded', async () => {
  const abort = new AbortController(), start = vi.fn(), stop = vi.fn(), restore = vi.fn();
  const mix = createNativeMix({ ...port(), nativeMixStart: start, nativeMixStop: stop },
    { prepare: async () => {}, restore, artwork: async () => { abort.abort(); return undefined; } });
  await expect(mix.start({ sampleRate: 48000, position: 0,
    tracks: [0, 1].map(i => ({ ...track(i), coverUrl: 'https://cover.test/x' })) }, abort.signal)).rejects.toThrow();
  expect(start).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce(); expect(restore).toHaveBeenCalledOnce();
});
it('keeps the playing queue when a replacement start fails', async () => {
  const stop = vi.fn();
  let fail = false;
  const mix = createNativeMix({ ...port(), nativeMixStop: stop,
    nativeMixStart: async () => { if (fail) throw Error('invalid'); return state; } }, { prepare: async () => {}, restore: vi.fn() });
  await mix.start({ sampleRate: 48000, position: 0, tracks: [track(0)] });
  fail = true;
  await expect(mix.start({ sampleRate: 48000, position: 0, tracks: [track(1)] })).rejects.toThrow('invalid');
  expect(stop).not.toHaveBeenCalled();
});
