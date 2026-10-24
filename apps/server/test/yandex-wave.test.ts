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
