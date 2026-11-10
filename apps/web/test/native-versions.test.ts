import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tracks: new Map<string, any>(), current: null as any,
  catalogSearch: vi.fn(), catalogEnsure: vi.fn(), providers: [] as any[], search: vi.fn(), ensure: vi.fn(), bind: vi.fn(), track: vi.fn(), save: vi.fn(), upsert: vi.fn(), start: vi.fn(), changed: vi.fn(),
}));
vi.mock('../src/lib/api.ts', () => ({ api: { catalogSearch: (...a: any[]) => h.catalogSearch(...a), publicSearch: (...a: any[]) => h.search(...a), bindRecording: (...a: any[]) => h.bind(...a),
  track: (...a: any[]) => h.track(...a), saveTrack: (...a: any[]) => h.save(...a) } }));
vi.mock('../src/store/app.ts', () => ({
  useApp: { getState: () => ({ providers: h.providers, tracks: h.tracks, order: [...h.tracks.keys()], upsertTrack: h.upsert }) },
  controller: { get currentEntry() { return h.current; }, state: { index: 2 }, startAt: (...a: any[]) => h.start(...a), onRecordingChanged: (...a: any[]) => h.changed(...a) },
}));
vi.mock('../src/pages/Search.tsx', () => ({ ensurePublic: (...a: any[]) => h.ensure(...a), SOURCE_LABEL: { ytmusic: 'YouTube Music', youtube: 'YouTube', soundcloud: 'SoundCloud' } }));
vi.mock('../src/store/catalog.ts', () => ({ catalogPlayer: { ensure: (...a: any[]) => h.catalogEnsure(...a) } }));
vi.mock('../src/components/VersionPanel.tsx', () => ({ sameSong: (a: string, b: string) => b.includes(a) }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.current = null; h.providers = [];
  h.tracks = new Map([['original', { id: 'original', title: 'Song', artist: 'Artist', coverUrl: 'original-cover', duration: 100, status: 'ok' }],
    ['local', { id: 'local', title: 'Song live', artist: 'Artist', coverUrl: 'live-cover', duration: 130, status: 'ok' }]]);
  h.search.mockResolvedValue({ items: [{ externalId: 'remote', title: 'Song remix', artist: 'Remixer', duration: 140, playable: true, labels: [] },
    { externalId: 'other', title: 'Another track', artist: 'Artist', duration: 110, playable: true, labels: [] }] });
  h.ensure.mockResolvedValue({ id: 'asset', title: 'Song remix', coverUrl: 'remix-cover' });
  h.track.mockResolvedValue({ ...h.tracks.get('original'), binding: { assetId: 'asset' } });
});

it('searches native candidates, includes local recordings and filters unrelated songs', async () => {
  const { nativeVersionCommands: c } = await import('../src/lib/native-versions.ts');
  const result = await c.versionSearch({ target: 'original', query: 'Artist Song remix', request: 'one', source: 'all' });
  expect(result.rows.map(row => row.key)).toEqual(['local:local', 'ytmusic:remote', 'youtube:remote', 'soundcloud:remote']);
  expect(h.search).toHaveBeenCalledTimes(3);
  expect(result.rows[0]).toMatchObject({ source: 'Медиатека', cover: 'live-cover' });
});

it('binds only audio to the original identity and restarts the same queue entry', async () => {
  const { nativeVersionCommands: c } = await import('../src/lib/native-versions.ts');
  await c.versionSearch({ target: 'original', query: 'Song', request: 'two', source: 'ytmusic' });
  h.current = { trackId: 'original' };
  await c.versionApply({ target: 'original', session: 'two', key: 'ytmusic:remote', resume: true });
  expect(h.bind).toHaveBeenCalledWith('original', 'asset');
  expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'original', title: 'Song', coverUrl: 'original-cover' }));
  expect(h.start).toHaveBeenCalledWith(2, 0, 'skip', false);
  expect(h.changed).not.toHaveBeenCalled();
});

it('invalidates a future recording and restores without selecting another candidate', async () => {
  const { nativeVersionCommands: c } = await import('../src/lib/native-versions.ts');
  await c.versionApply({ target: 'original', mode: 'restore' });
  expect(h.bind).toHaveBeenCalledWith('original', null);
  expect(h.changed).toHaveBeenCalledWith('original');
  expect(h.start).not.toHaveBeenCalled();
});

it('rejects stale selections and leaves the binding alone when preparation fails', async () => {
  const { nativeVersionCommands: c } = await import('../src/lib/native-versions.ts');
  await expect(c.versionApply({ target: 'original', session: 'stale', key: 'local:local' })).rejects.toThrow('устарел');
  await c.versionSearch({ target: 'original', query: 'Song', request: 'three', source: 'ytmusic' });
  h.ensure.mockRejectedValueOnce(new Error('offline'));
  await expect(c.versionApply({ target: 'original', session: 'three', key: 'ytmusic:remote' })).rejects.toThrow('offline');
  expect(h.bind).not.toHaveBeenCalled();
});

it('keeps successful search providers when one is unavailable', async () => {
  const { nativeVersionCommands: c } = await import('../src/lib/native-versions.ts');
  h.search.mockRejectedValueOnce(new Error('offline'));
  const result = await c.versionSearch({ target: 'original', query: 'Song', request: 'four', source: 'all' });
  expect(result.rows).toHaveLength(3);
  expect(result.errors).toEqual(['YouTube Music: offline']);
});

it('opens the current wave recording even when it is not saved in the library tab', async () => {
  const { nativeVersionCommands: c } = await import('../src/lib/native-versions.ts');
  h.tracks.set('wave', { id: 'wave', title: 'Wave title', artist: 'Artist', coverUrl: 'wave-cover', status: 'ok', saved: false, binding: { assetId: 'other' } });
  expect(c.versionTarget({ target: 'wave' })).toMatchObject({ id: 'wave', title: 'Wave title', cover: 'wave-cover', binding: 'other' });
  expect(() => c.versionTarget({ target: 'missing' })).toThrow('Трек не найден');
});
it('searches Yandex versions and binds their audio to the original identity', async () => {
  h.providers = [{ id: 'yandex', status: 'connected' }];
  h.catalogSearch.mockResolvedValue({ tracks: [{ externalId: 'ya', title: 'Song album version', artist: 'Artist', duration: 100, playable: true }] });
  h.catalogEnsure.mockResolvedValue('asset');
  const { nativeVersionCommands: c } = await import('../src/lib/native-versions.ts');
  const found = await c.versionSearch({ target: 'original', query: 'Song', source: 'yandex', request: 'ya-search' });
  h.tracks.set('asset', { id: 'asset', title: 'Song album version', status: 'ok' });
  expect(found.rows.map(row => row.key)).toEqual(['local:local', 'yandex:ya']);
  expect(h.search).not.toHaveBeenCalled();
  await c.versionApply({ target: 'original', session: 'ya-search', key: 'yandex:ya' });
  expect(h.catalogEnsure).toHaveBeenCalledOnce();
  expect(h.bind).toHaveBeenCalledWith('original', 'asset');
  expect(h.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'original', title: 'Song', coverUrl: 'original-cover' }));
});
it('offers a local-only version search without a network request', async () => {
  const { nativeVersionCommands: c } = await import('../src/lib/native-versions.ts');
  const found = await c.versionSearch({ target: 'original', query: 'Song', source: 'local', request: 'local-only' });
  expect(found.rows.map(row => row.key)).toEqual(['local:local']);
  expect(h.search).not.toHaveBeenCalled(); expect(h.catalogSearch).not.toHaveBeenCalled();
  await expect(c.versionSearch({ target: 'original', source: 'yandex', request: 'offline' })).rejects.toThrow('Подключите Яндекс');
});
