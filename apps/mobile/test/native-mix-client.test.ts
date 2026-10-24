import { expect, it, vi } from 'vitest';
import { createNativeMix, prepareNativeMixArtwork } from '../src/bridge/native-mix.ts';
const state = { active: true, playing: true, index: 0, position: 0, duration: 3 };
it('prefetches both covers, strips URLs, and preserves the corresponding track artwork', async () => {
  const config = { tracks: [0, 1].map(i => ({ title: String(i), artist: '', totalFrames: 100, gainDb: 0, coverUrl: `https://covers.test/${i}` })) } as never;
  const result = await prepareNativeMixArtwork(config, async url => ({ base64: url.endsWith('/0') ? 'AAAA' : 'BBBB', mime: 'image/png' }));
  expect(result.tracks.map(t => t.artwork?.base64)).toEqual(['AAAA', 'BBBB']);
  expect(result.tracks.every(t => !('coverUrl' in t))).toBe(true);
});
it('allows playback without a missing, failed or oversized cover', async () => {
  const config = { tracks: [0, 1, 2].map(i => ({ title: String(i), artist: '', totalFrames: 100, gainDb: 0,
    ...(i ? { coverUrl: `https://covers.test/${i}` } : {}) })) } as never;
  const result = await prepareNativeMixArtwork(config, async url => {
    if (url.endsWith('/1')) throw Error('unavailable');
    return { base64: 'A'.repeat(2800001), mime: 'image/png' };
  });
  expect(result.tracks.every(t => !t.artwork && !('coverUrl' in t))).toBe(true);
});
it('isolates WebKit before uploading and starts only after preparation completes', async () => {
  const order: string[] = [];
  const port = {
    nativeMixBegin: async () => { order.push('begin'); return { id: 'test' }; },
    nativeMixAppend: async () => { order.push('append'); },
    nativeMixStart: async () => { order.push('start'); return state; },
    nativeMixStop: async () => { order.push('stop'); },
    nativeMixState: async () => state, nativeMixCommand: async () => state,
  };
  const mix = createNativeMix(port, { prepare: async () => { order.push('isolate'); }, restore: () => { order.push('restore'); } });
  await mix.start(async put => { await put(0, 0, new ArrayBuffer(8)); return { sampleRate: 48000, position: 0,
    tracks: [0, 1].map(i => ({ title: String(i), artist: '', totalFrames: 100, gainDb: 0 })) }; });
  expect(order).toEqual(['isolate', 'begin', 'append', 'start']);
  await mix.stop(); expect(order.slice(-2)).toEqual(['stop', 'restore']);
});
it('keeps WebKit isolated if native release fails after an upload failure', async () => {
  const restore = vi.fn();
  const mix = createNativeMix({ nativeMixBegin: async () => ({ id: 'x' }), nativeMixAppend: vi.fn(),
    nativeMixStart: vi.fn(), nativeMixStop: async () => { throw Error('release'); },
    nativeMixState: vi.fn(), nativeMixCommand: vi.fn(),
  }, { prepare: async () => {}, restore });
  await expect(mix.start(async () => { throw Error('upload'); })).rejects.toThrow('release');
  expect(restore).not.toHaveBeenCalled();
});
it('does not start audio after cancellation while covers were being loaded', async () => {
  const abort = new AbortController(), start = vi.fn(), stop = vi.fn(), restore = vi.fn();
  const mix = createNativeMix({ nativeMixBegin: async () => ({ id: 'x' }), nativeMixAppend: vi.fn(), nativeMixStart: start,
    nativeMixStop: stop, nativeMixState: vi.fn(), nativeMixCommand: vi.fn(),
  }, { prepare: async () => {}, restore, artwork: async () => { abort.abort(); return undefined; } });
  await expect(mix.start(async () => ({ sampleRate: 48000, position: 0,
    tracks: [0, 1].map(i => ({ title: String(i), artist: '', totalFrames: 100, gainDb: 0, coverUrl: 'https://cover.test/x' })),
  }), abort.signal)).rejects.toThrow();
  expect(start).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce(); expect(restore).toHaveBeenCalledOnce();
});
