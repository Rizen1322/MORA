import { expect, it, vi } from 'vitest';
import { createNativeMix } from '../src/bridge/native-mix.ts';
const state = { active: true, playing: true, index: 0, position: 0, duration: 3 };
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
  await mix.start(async put => { await put(0, 0, new ArrayBuffer(8)); return {} as never; });
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
