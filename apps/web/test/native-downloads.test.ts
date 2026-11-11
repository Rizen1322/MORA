import { afterEach, expect, it, vi } from 'vitest';
import { waveDownloadIds } from '../src/lib/native-downloads.ts';
afterEach(() => vi.unstubAllGlobals());

it('keeps only the next configured window, excluding existing and duplicate downloads', () => {
  expect(waveDownloadIds(['a', 'b', 'a', 'c', 'd', 'e'], 5, new Set(['b']))).toEqual(['a', 'c', 'd']);
  expect(waveDownloadIds(['a'], 0, new Set())).toEqual([]);
  expect(waveDownloadIds(['a'], 7, new Set())).toEqual([]);
});

it('hands library downloads to native and keeps the worker cache inside the same limit', async () => {
  const job = { id: 'native-one', trackId: 'one', state: 'queued', key: 'native:one', title: 'Трек', progress: 0, error: null };
  const native = { list: vi.fn(async () => ({ jobs: [job], cacheBytes: 100, wifiOnly: false })),
    add: vi.fn(async () => ({ job })), action: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
  vi.stubGlobal('window', { moraNativePlayback: { downloads: native } });
  const fetch = vi.fn(async () => new Response(JSON.stringify({ jobs: [], usage: { cacheBytes: 50, pinnedBytes: 100, limitBytes: 1000, freeBytes: null } })));
  vi.stubGlobal('fetch', fetch);
  const { api } = await import('../src/lib/api.ts');
  expect(await api.download({ trackId: 'one' })).toEqual({ job });
  expect(native.add).toHaveBeenCalledWith('one', 850);
  expect((await api.downloads()).usage.pinnedBytes).toBe(200);
  await api.downloadAction('native-one', 'pause');
  expect(native.action).toHaveBeenCalledWith('native-one', 'pause');
});
