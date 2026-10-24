import { expect, it, vi } from 'vitest';
import type { Services } from '../src/app.ts';
vi.mock('../src/automix.ts', () => ({ getSettings: () => ({ automix: { enabled: true } }) }));
import { nativeSources } from '../src/native-sources.ts';

it('hands off the whole known queue rather than just the next two songs, preserving order', async () => {
  const resolve = vi.fn(async (source: { external_id: string }) => ({ kind: 'direct', url: `https://audio.test/${source.external_id}.mp3` }));
  const services = { db: {}, lib: {
    media: (id: string) => ({ id, duration: 180, content_hash: id, provider: 'test', title: id, artist: 'artist', cover_id: null }),
    sources: (id: string) => [{ provider: 'test', kind: 'remote', external_id: id, meta: '{}' }],
    mixingPolicy: new Map([['test', true]]),
  }, providers: { get: () => ({ nativeSource: resolve }) }, analysis: { get: () => null }, publicMusic: { cachedAudioPath: () => null } } as unknown as Services;
  const entries = Array.from({ length: 8 }, (_, i) => ({ trackId: `track${i}`, entryId: `entry${i}`, file: i + 10 }));
  const manifest = await nativeSources(services, entries, 'previous');
  expect(manifest.items.map(t => t.entryId)).toEqual(entries.map(e => e.entryId));
  expect(resolve).toHaveBeenCalledTimes(8);
  expect(manifest.items.every(t => t.source.kind === 'direct')).toBe(true);
});
it('rejects malformed queue file keys before querying any provider', async () => {
  await expect(nativeSources({} as Services, [{ trackId: 'x', entryId: 'x', file: -1 }], 'x')).rejects.toThrow('Неверная очередь');
});
