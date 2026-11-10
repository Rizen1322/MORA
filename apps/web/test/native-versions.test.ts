import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  tracks: new Map<string, any>(), current: null as any,
  search: vi.fn(), ensure: vi.fn(), bind: vi.fn(), track: vi.fn(), save: vi.fn(), upsert: vi.fn(), start: vi.fn(), changed: vi.fn(),
}));
vi.mock('../src/lib/api.ts', () => ({ api: { publicSearch: (...a: any[]) => h.search(...a), bindRecording: (...a: any[]) => h.bind(...a),
  track: (...a: any[]) => h.track(...a), saveTrack: (...a: any[]) => h.save(...a) } }));
vi.mock('../src/store/app.ts', () => ({
  useApp: { getState: () => ({ tracks: h.tracks, order: [...h.tracks.keys()], upsertTrack: h.upsert }) },
  controller: { get currentEntry() { return h.current; }, state: { index: 2 }, startAt: (...a: any[]) => h.start(...a), onRecordingChanged: (...a: any[]) => h.changed(...a) },
}));
vi.mock('../src/pages/Search.tsx', () => ({ ensurePublic: (...a: any[]) => h.ensure(...a), SOURCE_LABEL: { ytmusic: 'YouTube Music', youtube: 'YouTube', soundcloud: 'SoundCloud' } }));
vi.mock('../src/components/VersionPanel.tsx', () => ({ sameSong: (a: string, b: string) => b.includes(a) }));

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.current = null;
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
