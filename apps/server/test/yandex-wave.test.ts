import { describe, expect, it, vi } from 'vitest';
import { YandexProvider, type YandexWaveItem } from '../src/providers/yandex.ts';

describe('bounded wave audio preparation', () => {
  it('downloads two at a time, preserves sequence, and does not prepare the whole catalog', async () => {
    const provider = Object.create(YandexProvider.prototype) as YandexProvider;
    let inflight = 0, peak = 0;
    const releases: (() => void)[] = [];
    provider.importTrack = vi.fn(async (track) => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inflight--;
      return `local-${track.externalId}`;
    });
    const items: YandexWaveItem[] = Array.from({ length: 30 }, (_, i) => ({ yandexId: `${i+1}:10`, title: 'Track', artist: 'Artist', trackId: null }));
    const h = provider as unknown as { prepareWave(items: YandexWaveItem[], count: number): Promise<YandexWaveItem[]> };
    const job = h.prepareWave(items, 4);
    expect(provider.importTrack).toHaveBeenCalledTimes(2);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(provider.importTrack).toHaveBeenCalledTimes(4));
    releases.splice(0).forEach((release) => release());
    await job;
    expect(peak).toBe(2);
    expect(items.filter((item) => item.trackId).map((item) => item.yandexId)).toEqual(['1:10','2:10','3:10','4:10']);
    expect(items.slice(4).every((item) => !item.trackId)).toBe(true);
  });

  it('limits failed download attempts and skips work when cached tracks satisfy the reserve', async () => {
    const provider = Object.create(YandexProvider.prototype) as YandexProvider;
    provider.importTrack = vi.fn().mockRejectedValue(new Error('unavailable'));
    const h = provider as unknown as { prepareWave(items: YandexWaveItem[], count: number): Promise<YandexWaveItem[]> };
    const items: YandexWaveItem[] = Array.from({ length: 30 }, (_, i) => ({ yandexId: String(i+1), title: 'Track', artist: 'Artist', trackId: null }));
    await h.prepareWave(items, 4);
    expect(provider.importTrack).toHaveBeenCalledTimes(5);
    expect(items.filter((item) => item.error)).toHaveLength(5);
    vi.mocked(provider.importTrack).mockClear();
    items[20].trackId = 'cached-a'; items[21].trackId = 'cached-b';
    await h.prepareWave(items, 2);
    expect(provider.importTrack).not.toHaveBeenCalled();
  });
});

describe('metadata-only import (iPhone)', () => {
  it('records the track without downloading its MP3', async () => {
    const provider = Object.create(YandexProvider.prototype) as YandexProvider;
    const prepare = vi.fn().mockRejectedValue(new Error('must not download'));
    const added = vi.fn((input: { duration: number; meta: Record<string, unknown> }) => ({ id: 'row', ...input }));
    const track = { id: 7, title: 'T', durationMs: 200000, available: true, artists: [{ id: 1, name: 'A' }], albums: [{ id: 9, title: 'Al' }] };
    Object.assign(provider, { metadataOnlyImport: true, audio: { prepare, cover: async () => null }, imports: new Map(), store: { load: () => ({ secret: { token: 't' } }) },
      lib: { tracksBySource: () => [], addRemote: added }, call: async () => [track], checkedId: (id: string) => id });
    await provider.importTrack({ externalId: '7:9', title: '', artist: '', album: '', duration: 0, coverUrl: null, pageUrl: null, license: null, playable: true });
    expect(prepare).not.toHaveBeenCalled();
    expect(added.mock.calls[0][0].duration).toBe(200);
    expect(added.mock.calls[0][0].meta.audioHash).toBeUndefined();
  });
});

it('uses trusted rotor metadata on iPhone without another metadata or cover request', async () => {
  const provider = Object.create(YandexProvider.prototype) as YandexProvider;
  const added = vi.fn((input: { meta: Record<string, unknown> }) => ({ id: 'local', ...input }));
  const call = vi.fn(), cover = vi.fn(), prepare = vi.fn();
  Object.assign(provider, { base: "https://api.music.yandex.net", metadataOnlyImport: true, audio: { prepare, cover }, lib: { tracksBySource: () => [], addRemote: added }, checkedId: (id: string) => id });
  const track = { id: 7, title: 'T', durationMs: 200000, available: true, coverUri: 'avatars.yandex.net/get-music-content/7/%%', artists: [{ id: 1, name: 'A' }], albums: [{ id: 9, title: 'Al' }] };
  const h = provider as any; h.call = call;
  const items = [{ yandexId: '7:9', title: 'T', artist: 'A', trackId: null }];
  await h.prepareWave(items, 2, [track]);
  expect(items[0].trackId).toBe('local');
  expect(call).not.toHaveBeenCalled(); expect(cover).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  expect(added.mock.calls[0][0].meta.coverUrl).toMatch(/^https:/);
});
