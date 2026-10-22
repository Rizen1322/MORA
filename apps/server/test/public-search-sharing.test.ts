import { afterEach, expect, it, vi } from 'vitest';
import { PublicMusic } from '../src/public/provider.ts';
import { setYtmTransport } from '../src/public/ytmusic.ts';
import { setSoundCloudTransport } from '../src/public/soundcloud.ts';

afterEach(() => { vi.useRealTimers(); setYtmTransport((...args) => fetch(...args)); setSoundCloudTransport((...args) => fetch(...args)); });
const service = (runner: object = {}) => new PublicMusic(null as never, null as never, null as never, {} as never, runner as never);

it('shares identical pending searches without cancelling the second listener', async () => {
  let finish!: (response: Response) => void;
  let upstream!: AbortSignal;
  const fetcher = vi.fn(async (_input, init) => { upstream = init!.signal as AbortSignal; return new Promise<Response>((r) => { finish = r; }); });
  setYtmTransport(fetcher);
  const music = service(), cancel = new AbortController();
  const first = music.search('ytmusic', ' Same ', cancel.signal);
  const second = music.search('ytmusic', 'same');
  const rejected = expect(first).rejects.toThrow();
  await Promise.resolve(); cancel.abort(); await rejected;
  expect(upstream.aborted).toBe(false);
  finish(new Response('{}'));
  await expect(second).resolves.toEqual([]);
  await expect(music.search('ytmusic', 'same')).resolves.toEqual([]);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('uses the Music songs fallback and allows retries after failure', async () => {
  setYtmTransport(async () => { throw new Error('upstream down'); });
  const searchMusic = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce([
    { id: 'abcdefghijk', title: 'Song', artists: ['Артист'], duration: 180 },
  ]);
  const music = service({ searchMusic });
  await expect(music.search('ytmusic', 'fallback')).rejects.toThrow('temporary');
  const result = await music.search('ytmusic', 'fallback');
  expect(result[0]).toMatchObject({ source: 'ytmusic', kind: 'song', artist: 'Артист', externalId: 'abcdefghijk' });
  expect(searchMusic).toHaveBeenCalledTimes(2);
});

it('falls back to the SoundCloud resolver when public search is unavailable', async () => {
  setSoundCloudTransport(async () => { throw new Error('API down'); });
  const search = vi.fn().mockResolvedValue([{ id: '123456789', title: 'Track', uploader: 'Artist', duration: 180 }]);
  const result = await service({ search }).search('soundcloud', 'track');
  expect(result[0]).toMatchObject({ source: 'soundcloud', audioProvider: 'soundcloud', externalId: '123456789' });
  expect(search).toHaveBeenCalledWith('scsearch', 'track', 15, expect.any(AbortSignal));
});

it('keeps one overall deadline even while a fallback waits in the resolver queue', async () => {
  vi.useFakeTimers();
  setYtmTransport(async () => { throw new Error('upstream down'); });
  let fallbackSignal!: AbortSignal;
  const searchMusic = vi.fn((_q, _limit, signal: AbortSignal) => new Promise((_r, reject) => {
    fallbackSignal = signal;
    signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true });
  }));
  const pending = service({ searchMusic }).search('ytmusic', 'deadline');
  const rejected = expect(pending).rejects.toThrow('deadline');
  await vi.advanceTimersByTimeAsync(15001);
  await rejected;
  expect(fallbackSignal.aborted).toBe(true);
});
