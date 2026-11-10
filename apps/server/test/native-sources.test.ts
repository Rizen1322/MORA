import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Services } from '../src/app.ts';
vi.mock('../src/automix.ts', () => ({ getSettings: () => ({ automix: { enabled: true } }) }));
import { nativeSources } from '../src/native-sources.ts';

it('hands off the whole known queue rather than just the next two songs, preserving order', async () => {
  const resolve = vi.fn(async (source: { external_id: string }) => ({ kind: 'direct', url: `https://audio.test/${source.external_id}.mp3` }));
  const services = { db: {}, lib: {
    get: () => null,
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

afterEach(() => { vi.useRealTimers(); });
const svc = (resolve: (source: { external_id: string }) => Promise<unknown>) => ({ db: {}, lib: {
  get: () => null,
  media: (id: string) => ({ id, duration: 180, content_hash: id, provider: 'test', title: id, artist: 'artist', cover_id: null }),
  sources: (id: string) => [{ provider: 'test', kind: 'remote', external_id: id, meta: '{}' }],
  mixingPolicy: new Map([['test', true]]),
}, providers: { get: () => ({ nativeSource: resolve }) }, analysis: { get: () => null }, publicMusic: { cachedAudioPath: () => null } } as unknown as Services);
const list = (n: number) => Array.from({ length: n }, (_, i) => ({ trackId: `t${i}`, entryId: `e${i}`, file: i }));
it('drops failed and hung entries, keeping queue order', async () => {
  vi.useFakeTimers();
  const services = svc(async ({ external_id }) => {
    if (external_id === 't1') throw Error('dead');
    if (external_id === 't3') return new Promise(() => {});
    return { kind: 'direct', url: `https://audio.test/${external_id}.mp3` };
  });
  const result = nativeSources(services, list(5), 'previous');
  await vi.advanceTimersByTimeAsync(20000);
  expect((await result).items.map(t => t.entryId)).toEqual(['e0', 'e2', 'e4']);
});
it('resolves at most four entries at once, in queue order', async () => {
  let active = 0, peak = 0;
  const started: string[] = [];
  const services = svc(async ({ external_id }) => {
    started.push(external_id); peak = Math.max(peak, ++active);
    await new Promise(r => setTimeout(r, 5)); active--;
    return { kind: 'direct', url: 'https://audio.test/x.mp3' };
  });
  await nativeSources(services, list(10), 'previous');
  expect(peak).toBe(4);
  expect(started.slice(0, 4)).toEqual(['t0', 't1', 't2', 't3']);
});

it('reuses resolved remote sources across growing handoffs', async () => {
  const resolve = vi.fn(async (source: { external_id: string }) => ({ kind: 'direct', url: `https://audio.test/${source.external_id}.mp3` }));
  const services = svc(resolve);
  const list = (n: number) => Array.from({ length: n }, (_, i) => ({ trackId: `t${i}`, entryId: `e${i}`, file: i }));
  await nativeSources(services, list(4), 'previous');
  await nativeSources(services, list(8), 'previous');
  expect(resolve).toHaveBeenCalledTimes(8);
});

it('plays a downloaded Yandex track from disk instead of streaming it again', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-native-yandex-'));
  const hash = 'c'.repeat(64);
  fs.mkdirSync(path.join(dataDir, 'remote', 'yandex'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'remote', 'yandex', `${hash}.mp3`), Buffer.alloc(16));
  const resolve = vi.fn(async () => ({ kind: 'direct', url: 'https://audio.test/stream.mp3' }));
  const services = { cfg: { dataDir }, db: {}, lib: {
    get: () => null,
    media: (id: string) => ({ id, duration: 180, content_hash: hash, provider: 'yandex', title: id, artist: 'artist', cover_id: null }),
    sources: (id: string) => [{ provider: 'yandex', kind: 'remote', external_id: id, meta: '{}' }],
    mixingPolicy: new Map([['yandex', true]]),
  }, providers: { get: () => ({ nativeSource: resolve }) }, analysis: { get: () => null }, publicMusic: { cachedAudioPath: () => null } } as unknown as Services;
  try {
    const manifest = await nativeSources(services, [{ trackId: 'track1', entryId: 'entry1', file: 1 }], 'track1');
    expect(manifest.items[0].source).toEqual({ kind: 'upload', trackId: 'track1' });
    expect(resolve).not.toHaveBeenCalled();
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

it('replaces audio while keeping the original title, artist and artwork', async () => {
  const services = svc(async () => ({ kind: 'direct', url: 'https://audio.test/new.mp3' }));
  services.lib.get = vi.fn(() => ({ id: 'original', title: 'Original title', artist: 'Original artist', cover_id: null })) as any;
  services.lib.media = vi.fn(() => ({ id: 'replacement', title: 'Remix title', artist: 'Remixer', provider: 'test', duration: 240, content_hash: 'replacement', cover_id: null })) as any;
  services.lib.sources = vi.fn((id: string) => [{ kind: 'remote', provider: 'test', external_id: id,
    meta: JSON.stringify({ coverUrl: id === 'original' ? 'https://covers.test/original.jpg' : 'https://covers.test/remix.jpg' }) }]) as any;
  const manifest = await nativeSources(services, [{ trackId: 'original', entryId: 'entry', file: 1 }], 'original');
  expect(manifest.items[0]).toMatchObject({ trackId: 'original', title: 'Original title', artist: 'Original artist', duration: 240, coverUrl: 'https://covers.test/original.jpg', source: { url: 'https://audio.test/new.mp3' } });
});
