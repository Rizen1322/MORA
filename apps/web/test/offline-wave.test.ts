import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: {} as any, tracks: new Map<string, any>(),
  continueAs: vi.fn(), nextTrack: vi.fn(), startWave: vi.fn(), setOfflineOnly: vi.fn(), resume: vi.fn(),
}));
vi.mock('../src/store/app.ts', () => ({
  controller: {
    get state() { return h.state; },
    continueAs: (ctx: any, ids: string[], origin: string, replace: boolean) => { h.continueAs(ctx, ids, origin, replace); h.state = { ...h.state, context: ctx, queue: h.state.queue.slice(0, h.state.index + 1) }; },
    nextTrack: () => h.nextTrack(), setOfflineOnly: (on: boolean) => h.setOfflineOnly(on),
    startWave: async (kind: string) => { h.startWave(kind); h.state = { ...h.state, context: { type: 'wave', label: 'Моя волна' } }; },
    subscribe: vi.fn(),
  },
  trackOf: (id: string) => h.tracks.get(id),
}));
vi.mock('../src/lib/radio.ts', () => ({ resumeStationOnline: (label: string) => h.resume(label) }));

const song = (id: string, kind: 'local' | 'remote' | 'pinned') => ({ id, status: 'ok', sourceKind: kind === 'local' ? 'file' : 'remote', pinned: kind === 'pinned' });

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  h.tracks = new Map([['cur', song('cur', 'remote')], ['net', song('net', 'remote')], ['file', song('file', 'local')], ['saved', song('saved', 'pinned')]]);
  h.state = { status: 'playing', index: 0, context: { type: 'yandex-wave', label: 'Моя волна Яндекса' },
    queue: ['cur', 'net', 'file', 'saved'].map((trackId) => ({ entryId: 'e-' + trackId, trackId })) };
  vi.stubGlobal('navigator', { onLine: true });
});

it('continues a Yandex wave with songs on the device and hands back to Yandex when the network returns', async () => {
  const w = await import('../src/lib/offline-wave.ts');
  w.setNetworkOffline(true);
  expect(h.setOfflineOnly).toHaveBeenLastCalledWith(true);
  const [ctx, ids, , replace] = h.continueAs.mock.calls[0];
  expect(ctx).toMatchObject({ type: 'wave' });
  expect(ids).toEqual(['file', 'saved']); // the network song is dropped, the playing one is not cut
  expect(replace).toBe(true);
  expect(h.nextTrack).not.toHaveBeenCalled();
  expect(w.heldStation()).toMatchObject({ type: 'yandex-wave' });
  w.setNetworkOffline(true); // repeated reports change nothing
  expect(h.continueAs).toHaveBeenCalledTimes(1);
  w.setNetworkOffline(false);
  expect(h.setOfflineOnly).toHaveBeenLastCalledWith(false);
  expect(h.continueAs).toHaveBeenLastCalledWith({ type: 'yandex-wave', label: 'Моя волна Яндекса' }, [], 'yandex', true);
  expect(w.heldStation()).toBeNull();
});

it('treats a song stuck waiting for the network as a weak network, then tries online again', async () => {
  const w = await import('../src/lib/offline-wave.ts');
  h.state = { ...h.state, status: 'buffering', context: { type: 'online-radio', label: 'Онлайн-радио · Моя волна' } };
  w.check(1000);
  w.check(1000 + w.WEAK_MS - 1);
  expect(h.continueAs).not.toHaveBeenCalled();
  w.check(1000 + w.WEAK_MS + 1);
  expect(h.continueAs).toHaveBeenCalledTimes(1);
  expect(h.nextTrack).toHaveBeenCalledTimes(1); // the stuck network song is skipped
  w.check(1000 + w.WEAK_MS + 1 + w.WEAK_HOLD_MS + 1);
  expect(h.resume).toHaveBeenCalledWith('Онлайн-радио · Моя волна');
});

it('leaves the device wave alone when only its next picks must come from the device', async () => {
  const w = await import('../src/lib/offline-wave.ts');
  h.state = { ...h.state, context: { type: 'wave', label: 'Моя волна' }, queue: [{ entryId: 'a', trackId: 'cur' }, { entryId: 'b', trackId: 'file' }] };
  w.setNetworkOffline(true);
  expect(h.setOfflineOnly).toHaveBeenLastCalledWith(true);
  expect(h.continueAs).not.toHaveBeenCalled();
});

it('forgets the held station once the listener picks something else', async () => {
  const w = await import('../src/lib/offline-wave.ts');
  w.setNetworkOffline(true);
  h.state = { ...h.state, context: { type: 'album', label: 'Альбом' } };
  w.setNetworkOffline(false);
  expect(h.continueAs).toHaveBeenCalledTimes(1);
  expect(h.resume).not.toHaveBeenCalled();
});

it('starts the device wave when Yandex is asked for offline and remembers Yandex', async () => {
  const w = await import('../src/lib/offline-wave.ts');
  await w.startOffline('yandex');
  expect(h.startWave).toHaveBeenCalledWith('own');
  expect(w.heldStation()).toMatchObject({ type: 'yandex-wave' });
});
