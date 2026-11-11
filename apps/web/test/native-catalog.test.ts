import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  app: {} as any,
  api: { publicSearch: vi.fn(), catalogSearch: vi.fn(), catalogHome: vi.fn(), catalogArtist: vi.fn(), catalogAlbum: vi.fn(),
    publicCatalog: vi.fn(), soundCloudArtist: vi.fn(), track: vi.fn(), catalogReact: vi.fn(), download: vi.fn(), saveTrack: vi.fn(), addToPlaylist: vi.fn() },
  catalog: { state: { error: null as string | null }, known: vi.fn(), ensure: vi.fn(), play: vi.fn(), enqueue: vi.fn(), save: vi.fn(), cancel: vi.fn() },
  public: { state: { error: null as string | null }, known: vi.fn(), ensure: vi.fn(), play: vi.fn(), enqueue: vi.fn(), save: vi.fn(), cancel: vi.fn() },
  react: vi.fn(), radio: vi.fn(),
}));
vi.mock('../src/lib/api.ts', () => ({ api: h.api }));
vi.mock('../src/store/app.ts', () => ({ useApp: { getState: () => h.app } }));
vi.mock('../src/store/catalog.ts', () => ({ catalogPlayer: h.catalog, publicPlayer: h.public }));
vi.mock('../src/pages/Search.tsx', () => ({ asCatalog: (t: any) => ({ ...t, artists: [] }), SOURCE_LABEL: { ytmusic: 'YouTube Music', youtube: 'YouTube', soundcloud: 'SoundCloud' } }));
vi.mock('../src/components/TrackList.tsx', () => ({ react: (...a: any[]) => h.react(...a) }));
vi.mock('../src/lib/radio.ts', () => ({ startRadio: (...a: any[]) => h.radio(...a) }));
const item = (id: string) => ({ externalId: id, title: id, artist: 'Artist', album: 'Album', artists: [{ id: 'artist', name: 'Artist' }],
  albumId: 'album', duration: 100, coverUrl: null, pageUrl: null, playable: true, libraryTrackId: null, explicit: true, reaction: 0 });
const found = (ids: string[], page = 0, more = false) => ({ tracks: ids.map(item), artists: [{ id: 'artist', name: 'Artist' }],
  albums: [{ id: 'album', title: 'Album', year: 2026 }], page, hasMore: { tracks: more, artists: false, albums: false } });
beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks(); h.catalog.state.error = null; h.public.state.error = null;
  h.app = { tracks: new Map(), playlists: [{ id: 'playlist' }], toast: vi.fn(), upsertTrack: vi.fn(), loadLibrary: vi.fn() };
  h.catalog.known.mockReturnValue(null); h.public.known.mockReturnValue(null);
  h.catalog.ensure.mockResolvedValue('asset'); h.public.ensure.mockResolvedValue('asset');
  h.api.track.mockResolvedValue({ id: 'asset', title: 'A', reaction: 0 });
  h.api.catalogSearch.mockResolvedValue(found(['a', 'b']));
  h.api.catalogHome.mockResolvedValue(found(['home']));
  h.api.publicSearch.mockResolvedValue({ items: [{ ...item('public'), source: 'ytmusic', audioProvider: 'youtube', labels: [] }] });
  h.api.catalogReact.mockResolvedValue({ value: 1, sync: { status: 'synced' } });
});
it('returns native Yandex tracks, artist links, album links and explicit status', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  const value = await c.search({ source: 'yandex', q: '  Song  ', scope: 'all' });
  expect(h.api.catalogSearch).toHaveBeenCalledWith('Song', 'all', 0, expect.any(AbortSignal));
  expect(value.tracks[0]).toMatchObject({ id: 'a', explicit: true, ok: true });
  expect(value.artists[0].path).toBe('/catalog/artist/artist');
  expect(value.albums[0].path).toBe('/catalog/album/album');
  expect(value.session).toBeTruthy();
});
it('uses the Yandex home catalog for an empty query', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  const value = await c.search({ source: 'yandex', q: '' });
  expect(value.tracks[0].id).toBe('home'); expect(h.api.catalogSearch).not.toHaveBeenCalled();
});
it('plays the selected item with the entire matching result queue and source context', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  const first = await c.search({ source: 'yandex', q: 'Song' });
  await c.search({ source: 'yandex', q: 'A different query' });
  await c.searchAction({ session: first.session, id: 'b', kind: 'play' });
  expect(h.catalog.play).toHaveBeenCalledWith([item('a'), item('b')], 1, { type: 'search', label: 'Яндекс Музыка · Song' });
  await c.searchAction({ session: first.session, id: 'a', kind: 'next' });
  expect(h.catalog.enqueue).toHaveBeenCalledWith(item('a'), true);
});
it('merges Yandex pagination without duplicates and rejects a changed query', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  h.api.catalogSearch.mockResolvedValueOnce(found(['a', 'b'], 0, true)).mockResolvedValueOnce(found(['b', 'c'], 1));
  const first = await c.search({ source: 'yandex', q: 'Song' });
  const second = await c.search({ source: 'yandex', q: 'Song', more: true, session: first.session });
  expect(second.tracks.map(t => t.id)).toEqual(['a', 'b', 'c']); expect(second.more).toBe(false);
  await expect(c.search({ source: 'yandex', q: 'Wrong', more: true, session: first.session })).rejects.toThrow('изменился');
});
it('keeps Yandex reactions instant without preparing or downloading audio', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  const value = await c.search({ source: 'yandex', q: 'Song' });
  await c.searchAction({ session: value.session, id: 'a', kind: 'like' });
  expect(h.api.catalogReact).toHaveBeenCalledWith('a', 1); expect(h.catalog.ensure).not.toHaveBeenCalled();
  h.api.catalogReact.mockResolvedValueOnce({ value: 0 });
  await c.searchAction({ session: value.session, id: 'a', kind: 'like' });
  expect(h.api.catalogReact).toHaveBeenLastCalledWith('a', 0);
});
it('prepares an external replacement target and rejects stale or missing selections', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  const value = await c.search({ source: 'youtube', q: 'Song' });
  await expect(c.searchAction({ session: value.session, id: 'public', kind: 'versions' })).resolves.toEqual({ versions: 'asset' });
  expect(h.public.ensure).toHaveBeenCalledOnce();
  await expect(c.searchAction({ session: 'stale', id: 'a', kind: 'play' })).rejects.toThrow('устарели');
  await expect(c.searchAction({ session: value.session, id: 'missing', kind: 'play' })).rejects.toThrow('не найден');
  await expect(c.search({ source: 'wrong', q: 'Song' })).rejects.toThrow('источник');
});
it('provides native artist/album navigation and validates playlists before preparation', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  const value = await c.search({ source: 'yandex', q: 'Song' });
  await expect(c.searchAction({ session: value.session, id: 'a', kind: 'artist' })).resolves.toEqual({ go: '/catalog/artist/artist' });
  await expect(c.searchAction({ session: value.session, id: 'a', kind: 'album' })).resolves.toEqual({ go: '/catalog/album/album' });
  await expect(c.searchAction({ session: value.session, id: 'a', kind: 'playlist', playlist: 'missing' })).rejects.toThrow('Плейлист');
  expect(h.catalog.ensure).not.toHaveBeenCalled();
});
it('renders an album using native rows and reuses metadata across playback snapshots', async () => {
  const { describeNativeCatalog } = await import('../src/lib/native-catalog.ts');
  h.api.catalogAlbum.mockResolvedValue({ album: { title: 'Album', artists: [{ id: 'artist', name: 'Artist' }] }, tracks: [item('a'), item('b')] });
  const page = await describeNativeCatalog(['catalog', 'album', 'album']);
  expect(page.title).toBe('Album');
  expect(page.sections[1].rows).toHaveLength(2);
  expect(page.sections[1].rows[1]).toMatchObject({ kind: 'item', title: 'b', act: { name: 'searchItem', args: { kind: 'play' } } });
  await describeNativeCatalog(['catalog', 'album', 'album']);
  expect(h.api.catalogAlbum).toHaveBeenCalledOnce();
});
it('lays out album and artist pages as catalog pages: header, numbered album tracks, card shelves', async () => {
  const { describeNativeCatalog } = await import('../src/lib/native-catalog.ts');
  h.api.catalogAlbum.mockResolvedValue({ album: { title: 'Album', year: 2025, artists: [{ id: 'artist', name: 'Artist' }] }, tracks: [item('a'), item('b')] });
  const album = await describeNativeCatalog(['catalog', 'album', 'album']);
  expect(album.style).toBe('catalog');
  expect(album.sections[0].rows[0]).toMatchObject({ kind: 'hero', style: 'album', title: 'Album', subtitle: 'Artist', detail: '2025 · 2 трека',
    play: { name: 'searchItem', args: { kind: 'playAll' } }, shuffle: { name: 'searchItem', args: { kind: 'shuffleAll' } } });
  expect(album.sections[1].rows.map((r) => 'number' in r && r.number)).toEqual([1, 2]);
  expect(album.sections[2].rows[0]).toMatchObject({ kind: 'shelf', items: [{ title: 'Artist', round: true }] });

  h.api.publicCatalog.mockResolvedValue({ source: 'ytmusic', title: 'OG Buda', description: '', coverUrl: 'c', limited: false,
    tracks: Array.from({ length: 3 }, (_, i) => ({ ...item('t' + i), duration: 0, source: 'ytmusic', audioProvider: 'youtube', labels: [] })),
    albums: [{ id: 'MPREb_x', title: 'SZN', artist: '2025', coverUrl: 'a' }] });
  const artist = await describeNativeCatalog(['public', 'artist', 'UC1']);
  expect(artist.sections[0].rows[0]).toMatchObject({ kind: 'hero', style: 'artist', title: 'OG Buda' });
  // YouTube Music artist pages carry no durations: the tag must not read "0:00"
  expect(artist.sections[1].rows[0]).toMatchObject({ kind: 'item', cover: null, tag: 'E' });
  expect(artist.sections[2]).toMatchObject({ title: 'Альбомы', rows: [{ kind: 'shelf', items: [{ title: 'SZN', round: false }] }] });
});
it('aborts a superseded provider request while retaining the new results', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  h.api.publicSearch.mockImplementationOnce((_source, _q, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  const pending = expect(c.search({ source: 'youtube', q: 'old' })).rejects.toThrow('aborted');
  const next = await c.search({ source: 'youtube', q: 'new' });
  await pending;
  expect(next.tracks[0].id).toBe('public');
});
it('does not cache a failed catalog request', async () => {
  const { describeNativeCatalog } = await import('../src/lib/native-catalog.ts');
  h.api.catalogAlbum.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ album: { title: 'Album', artists: [] }, tracks: [] });
  await expect(describeNativeCatalog(['catalog', 'album', 'album'])).rejects.toThrow('offline');
  await expect(describeNativeCatalog(['catalog', 'album', 'album'])).resolves.toMatchObject({ title: 'Album' });
  expect(h.api.catalogAlbum).toHaveBeenCalledTimes(2);
});
it('persists a prepared public result in the visible library rather than only caching audio', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  const value = await c.search({ source: 'youtube', q: 'Song' });
  await c.searchAction({ session: value.session, id: 'public', kind: 'save' });
  expect(h.api.saveTrack).toHaveBeenCalledWith('asset');
  expect(h.app.upsertTrack).toHaveBeenCalledWith(expect.objectContaining({ id: 'asset', saved: true }));
  h.api.saveTrack.mockRejectedValueOnce(new Error('disk full'));
  h.app.upsertTrack.mockClear();
  await expect(c.searchAction({ session: value.session, id: 'public', kind: 'save' })).rejects.toThrow('disk full');
  expect(h.app.upsertTrack).not.toHaveBeenCalled();
});
it('surfaces preparation failures from catalog transports to the native error dialog', async () => {
  const { nativeCatalogCommands: c } = await import('../src/lib/native-catalog.ts');
  const value = await c.search({ source: 'yandex', q: 'Song' });
  h.catalog.enqueue.mockImplementationOnce(() => { h.catalog.state.error = 'offline'; });
  await expect(c.searchAction({ session: value.session, id: 'a', kind: 'queue' })).rejects.toThrow('offline');
  h.catalog.play.mockImplementationOnce(() => { h.catalog.state.error = 'audio unavailable'; });
  await expect(c.searchAction({ session: value.session, id: 'a', kind: 'play' })).rejects.toThrow('audio unavailable');
});
