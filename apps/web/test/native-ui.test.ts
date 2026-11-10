import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  app: {} as any, listeners: [] as (() => void)[], radio: { active: false, loading: false, error: null as string | null },
  resume: vi.fn(), pause: vi.fn(), nextTrack: vi.fn(), prevTrack: vi.fn(), seek: vi.fn(),
  toggleShuffle: vi.fn(), cycleRepeat: vi.fn(), playTracks: vi.fn(), addToQueue: vi.fn(), toggle: vi.fn(), startWave: vi.fn(), startRadio: vi.fn(), toast: vi.fn(),
  importFiles: vi.fn(), imports: vi.fn(), openVersionPanel: vi.fn(), yandexWaveSettings: vi.fn(), refreshYandexWave: vi.fn(), react: vi.fn(), patchTrack: vi.fn(),
  addToPlaylist: vi.fn(), createPlaylist: vi.fn(), loadPlaylists: vi.fn(), downloads: vi.fn(),
}));
vi.mock('../src/store/app.ts', () => ({
  phone: true,
  controller: { resume: () => h.resume(), pause: () => h.pause(), nextTrack: () => h.nextTrack(), prevTrack: () => h.prevTrack(), seek: (time: number) => h.seek(time), toggleShuffle: () => h.toggleShuffle(), cycleRepeat: () => h.cycleRepeat(), playTracks: (...a: any[]) => h.playTracks(...a), addToQueue: (...a: any[]) => h.addToQueue(...a), toggle: () => h.toggle(), startWave: (k: string) => h.startWave(k), refreshYandexWave: () => h.refreshYandexWave() },
  trackOf: (id: string) => h.app.tracks.get(id),
  useApp: { getState: () => h.app, setState: vi.fn(), subscribe: (fn: () => void) => h.listeners.push(fn) },
}));
vi.mock('../src/lib/importer.ts', () => ({ importFiles: (...a: any[]) => h.importFiles(...a) }));
vi.mock('../src/lib/radio.ts', () => ({ startRadio: () => h.startRadio(), useRadio: { getState: () => h.radio, subscribe: vi.fn() } }));
vi.mock('../src/store/catalog.ts', () => ({ catalogPlayer: {}, publicPlayer: {}, useCatalogPlayback: { getState: () => ({ phase: 'idle', title: '' }), subscribe: vi.fn() }, usePublicPlayback: { getState: () => ({ phase: 'idle', title: '' }), subscribe: vi.fn() } }));
vi.mock('../src/pages/Search.tsx', () => ({ asCatalog: (t: any) => t, SOURCE_LABEL: {} }));
vi.mock('../src/components/TrackList.tsx', () => ({ react: vi.fn() }));
vi.mock('../src/components/VersionPanel.tsx', () => ({
  openVersionPanel: (...a: any[]) => h.openVersionPanel(...a),
  useVersionPanel: { getState: () => ({ target: null }), subscribe: vi.fn() },
}));
vi.mock('../src/lib/api.ts', () => ({ api: { imports: () => h.imports(), react: (...args: any[]) => h.react(...args), yandexWaveSettings: () => h.yandexWaveSettings(),
  addToPlaylist: (...a: any[]) => h.addToPlaylist(...a), createPlaylist: (...a: any[]) => h.createPlaylist(...a), downloads: () => h.downloads() } }));
vi.mock('../src/store/downloads.ts', () => ({ useDownloads: { getState: () => ({ jobs: new Map(), load: async () => {} }) } }));

const track = (id: string, status = 'ok') => ({ id, title: id.toUpperCase(), artist: 'X', album: '', duration: 100, reaction: 0, coverUrl: null, status });

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.importFiles.mockReset(); h.imports.mockResolvedValue({ jobs: [] }); h.listeners.length = 0;
  h.radio = { active: false, loading: false, error: null };
  const tracks = new Map([['a', track('a')], ['b', track('b', 'missing')]]);
  h.app = { patchTrack: h.patchTrack, tracks, order: ['a', 'b'], loaded: true, playlists: [], loadPlaylists: () => h.loadPlaylists(), providers: [], toasts: [], fullPlayer: false, queueOpen: false, panel: null, toast: h.toast,
    player: { status: 'playing', queue: [{ trackId: 'a' }], index: 0, context: { type: 'wave', label: 'Моя волна' }, error: null } };
  vi.stubGlobal('location', { hash: '#/liked?x=1' });
});

describe('native shell bridge (page side)', () => {
  it('passes like and addition dates to the native favorites list', async () => {
    const { uiTrack } = await import('../src/lib/native-ui.ts');
    expect(uiTrack({ ...track('a'), reaction: 1, likedAt: 123, addedAt: 456 } as any)).toMatchObject({ likedAt: 123, addedAt: 456 });
    expect(uiTrack({ ...track('b'), addedAt: 789 } as any)).toMatchObject({ addedAt: 789 });
  });

  it('maps the store to the small snapshot', async () => {
    const { uiState } = await import('../src/lib/native-ui.ts');
    const s = uiState();
    expect(s.path).toBe('/liked');
    expect(s.wave).toMatchObject({ own: true, yandex: false, active: 'own', playing: true });
    expect(s.now).toMatchObject({ id: 'a', title: 'A', playing: true, label: 'Моя волна' });
    h.radio.active = true;
    expect(uiState().wave.active).toBe('online');
  });

  it('checks native commands before they reach the controller', async () => {
    const { commands } = await import('../src/lib/native-ui.ts');
    await commands.play({ ids: ['a', 7, 'b'], index: 9, type: 'evil', label: '' });
    expect(h.playTracks).toHaveBeenCalledWith(['a', 'b'], 1, { type: 'library', label: 'Медиатека' });
    commands.queue({ ids: ['a', 'b', 'zzz'], next: true });
    expect(h.addToQueue).toHaveBeenCalledWith(['a'], true);
    commands.wave({ source: 'own' }); // already playing: toggles
    commands.wave({ source: 'online' });
    expect(h.toggle).toHaveBeenCalledTimes(1);
    expect(h.startRadio).toHaveBeenCalledTimes(1);
    await expect(commands.searchAction({ session: 'stale', id: 'x', kind: 'play' })).rejects.toThrow('устарел');
    await expect(commands.cover({ url: 'https://evil/' })).rejects.toThrow();
  });

  it('opens the version picker for a native menu row', async () => {
    const { commands } = await import('../src/lib/native-ui.ts');
    commands.versions({ id: 'a' });
    expect(h.openVersionPanel).toHaveBeenCalledWith({ trackId: 'a', title: 'A', artist: 'X', duration: 100 });
    expect(() => commands.versions({ id: 'zzz' })).toThrow('не найден');
    expect(h.openVersionPanel).toHaveBeenCalledTimes(1);
  });

  it('pushes the library only when it changed, and follows the shell on the page', async () => {
    vi.useFakeTimers();
    const classes = new Set<string>();
    const push = vi.fn(async () => ({ shown: true }));
    vi.stubGlobal('window', { moraNativePlayback: { uiState: push }, addEventListener: vi.fn() });
    vi.stubGlobal('document', { documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) } } });
    const { startNativeUi } = await import('../src/lib/native-ui.ts');
    startNativeUi();
    await vi.advanceTimersByTimeAsync(200);
    expect(push).toHaveBeenCalledTimes(1);
    expect((push.mock.calls[0] as any)[0].library.map((t: any) => t.id)).toEqual(['a', 'b']);
    expect(classes.has('mora-native-shell')).toBe(true);
    h.listeners.forEach((fn) => fn()); // nothing changed
    await vi.advanceTimersByTimeAsync(200);
    expect(push).toHaveBeenCalledTimes(1);
    h.app = { ...h.app, fullPlayer: true };
    h.listeners.forEach((fn) => fn());
    await vi.advanceTimersByTimeAsync(200);
    expect(push).toHaveBeenCalledTimes(2);
    expect((push.mock.calls[1] as any)[0]).toMatchObject({ overlay: true });
    expect((push.mock.calls[1] as any)[0].library).toBeUndefined();
    vi.useRealTimers();
  });
});

it('acknowledges native lock-screen reactions only after persistence succeeds', async () => {
  const { commands } = await import('../src/lib/native-ui.ts');
  h.react.mockRejectedValueOnce(new Error('offline'));
  await expect(commands.reactSaved({ id: 'a', value: 1 })).rejects.toThrow('offline');
  expect(h.patchTrack).not.toHaveBeenCalled();
  h.react.mockResolvedValueOnce({ value: 1, sync: { status: 'pending' } });
  await expect(commands.reactSaved({ id: 'a', value: 1 })).resolves.toEqual({ saved: true });
  expect(h.patchTrack).toHaveBeenCalledWith('a', { reaction: 1, reactionSync: { status: 'pending' } });
  await expect(commands.reactSaved({ id: 'a', value: 7 })).rejects.toThrow();
});

it('publishes queue entries separately when only the continuation changed', async () => {
  vi.useFakeTimers();
  const push = vi.fn(async () => ({ shown: true }));
  vi.stubGlobal('window', { moraNativePlayback: { uiState: push }, addEventListener: vi.fn() });
  vi.stubGlobal('document', { documentElement: { classList: { toggle: vi.fn() } } });
  const { startNativeUi } = await import('../src/lib/native-ui.ts');
  startNativeUi(); await vi.advanceTimersByTimeAsync(200);
  h.app.player = { ...h.app.player, queue: [{ entryId: 'e-a', trackId: 'a' }, { entryId: 'e-b', trackId: 'b' }] };
  h.listeners.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(200);
  expect(push).toHaveBeenCalledTimes(2);
  expect((push.mock.calls[1] as any)[0].queue).toEqual(h.app.player.queue);
  expect((push.mock.calls[1] as any)[0].library).toBeUndefined();
  vi.useRealTimers();
});

it('gives focus exclusively to native content and restores web inputs for web screens and overlays', async () => {
  vi.useFakeTimers();
  let shown = true;
  const root = { inert: false }, blur = vi.fn();
  const push = vi.fn(async (state: any) => ({ shown, nativeContent: shown && !state.overlay && state.path !== '/diagnostics/charts' }));
  vi.stubGlobal('window', { moraNativePlayback: { uiState: push }, addEventListener: vi.fn() });
  vi.stubGlobal('document', { getElementById: () => root, activeElement: { blur }, documentElement: { classList: { toggle: vi.fn() } } });
  const { startNativeUi } = await import('../src/lib/native-ui.ts');
  startNativeUi(); await vi.advanceTimersByTimeAsync(200);
  expect(root.inert).toBe(true); expect(blur).toHaveBeenCalledTimes(1);
  h.app = { ...h.app, toasts: [{ id: 1, text: 'test' }] }; h.listeners.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(200);
  expect(blur).toHaveBeenCalledTimes(1); // State refreshes must not dismiss the native keyboard.
  h.app = { ...h.app, fullPlayer: true }; h.listeners.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(200);
  expect(root.inert).toBe(false);
  h.app = { ...h.app, fullPlayer: false }; (location as any).hash = '#/diagnostics/charts';
  h.listeners.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(200); expect(root.inert).toBe(false);
  (location as any).hash = '#/search'; h.listeners.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(200);
  expect(root.inert).toBe(true); expect(blur).toHaveBeenCalledTimes(2);
  shown = false; h.app = { ...h.app, toasts: [] }; h.listeners.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(200);
  expect(root.inert).toBe(false);
  vi.useRealTimers();
});

it('describes wave tuning over the current screen without navigating or starting playback', async () => {
  const { commands } = await import('../src/lib/native-ui.ts');
  h.app.settings = { wave: { mood: 'normal', diversity: 'balanced', mode: 'normal', yandexSeeds: [] } };
  h.app.saveSettings = vi.fn(async (patch: any) => { h.app.settings = { ...h.app.settings, ...patch }; });
  const before = location.hash;
  const page = await commands.waveSettings({ source: 'own' }) as any;
  expect(page.title).toBe('Настроить волну');
  expect(page.sections).toHaveLength(1);
  expect(page.sections[0].rows.map((row: any) => row.title)).toEqual(['Энергия', 'Характер', 'Для микса']);
  await commands.act({ name: 'set', args: { group: 'wave', key: 'mood', value: 'energetic' } });
  expect(h.app.saveSettings).toHaveBeenCalledWith({ wave: expect.objectContaining({ mood: 'energetic', diversity: 'balanced' }) });
  expect(location.hash).toBe(before); expect(h.startWave).not.toHaveBeenCalled();
  await expect(commands.waveSettings({ source: 'invalid' })).rejects.toThrow('Неизвестный источник');
});

it('keeps Yandex tuning groups independent and shows an error when its settings cannot load', async () => {
  const { commands } = await import('../src/lib/native-ui.ts');
  h.app.settings = { wave: { yandexSeeds: ['mood:calm', 'diversity:discover'] } };
  h.app.saveSettings = vi.fn(async (patch: any) => { h.app.settings = { ...h.app.settings, ...patch }; });
  h.yandexWaveSettings.mockResolvedValue({ groups: [{ name: 'Настроение', values: [{ seed: 'mood:calm', name: 'Спокойно' }, { seed: 'mood:fun', name: 'Весело' }] }] });
  const page = await commands.waveSettings({ source: 'yandex' }) as any;
  const row = page.sections[0].rows[0];
  expect(row.value).toBe('mood:calm');
  await commands.act({ name: row.act.name, args: { ...row.act.args, value: 'mood:fun' } });
  expect(h.app.settings.wave.yandexSeeds).toEqual(['diversity:discover', 'mood:fun']);
  expect(h.refreshYandexWave).toHaveBeenCalledOnce();
  h.yandexWaveSettings.mockRejectedValueOnce(new Error('offline'));
  const failed = await commands.waveSettings({ source: 'yandex' }) as any;
  expect(failed.sections[0].rows[0]).toMatchObject({ kind: 'text', tone: 'warn' });
});


it('connects native queue modes to the real command paths and preserves other AutoMix settings', async () => {
  const { commands, uiState } = await import('../src/lib/native-ui.ts');
  h.app.player = { ...h.app.player, context: { type: 'liked' }, shuffle: false, repeat: 'off' };
  h.app.settings = { automix: { enabled: true, mixOnNext: false, loudnessTarget: -14 } };
  h.app.saveSettings = vi.fn(async (patch: any) => { h.app.settings = { ...h.app.settings, ...patch }; });
  h.toggleShuffle.mockImplementation(() => { h.app.player.shuffle = !h.app.player.shuffle; });
  h.cycleRepeat.mockImplementation(() => { h.app.player.repeat = ({ off: 'all', all: 'one', one: 'off' } as any)[h.app.player.repeat]; });
  expect(uiState().playback).toEqual({ shuffle: false, repeat: 'off', automix: true, canShuffle: true });
  expect(await commands.playbackMode({ mode: 'shuffle' })).toMatchObject({ shuffle: true });
  for (const repeat of ['all', 'one', 'off']) expect(await commands.playbackMode({ mode: 'repeat' })).toMatchObject({ repeat });
  expect(await commands.playbackMode({ mode: 'automix' })).toMatchObject({ automix: false });
  expect(h.app.saveSettings).toHaveBeenCalledWith({ automix: { enabled: false, mixOnNext: false, loudnessTarget: -14 } });
  for (const type of ['wave', 'yandex-wave', 'online-radio']) {
    h.app.player.context = { type };
    expect(uiState().playback.canShuffle).toBe(false);
    await commands.playbackMode({ mode: 'shuffle' });
  }
  expect(h.toggleShuffle).toHaveBeenCalledOnce();
  await expect(commands.playbackMode({ mode: 'invalid' })).rejects.toThrow('Неизвестный режим');
  h.app.settings = null;
  await expect(commands.playbackMode({ mode: 'automix' })).rejects.toThrow('Настройки ещё загружаются');
});
it('uses the same album and individual artist links as the web player', async () => {
  const { commands } = await import('../src/lib/native-ui.ts');
  h.app.tracks.set('a', { ...track('a'), provider: 'yandex', album: 'Original Album', catalogAlbumId: '88',
    catalogArtists: [{ id: '1', name: 'Artist One' }, { id: '2', name: 'Artist Two' }], binding: { assetId: 'different-audio' } });
  expect(commands.trackLinks({ id: 'a' })).toEqual({ album: '/catalog/album/88', artists: [
    { id: '#/catalog/artist/1', title: 'Artist One', path: '/catalog/artist/1' },
    { id: '#/catalog/artist/2', title: 'Artist Two', path: '/catalog/artist/2' },
  ] });
  expect(() => commands.trackLinks({ id: 'missing' })).toThrow('Трек не найден');
});
it('offers a separate native audio picker on the Import page', async () => {
  const { describe } = await import('../src/lib/native-pages.ts');
  (location as any).hash = '#/import';
  const page = await describe() as any;
  expect(page.sections[0].rows[0]).toMatchObject({ kind: 'file', title: 'Добавить аудиофайлы', multiple: true, act: { name: 'importAudio' } });
  expect(page.sections[0].rows[0].types).toContain('mp3');
  expect(page.sections[1].rows).toContainEqual(expect.objectContaining({ title: 'Файл плейлиста (CSV, M3U, JSON)' }));
});
it('passes native file bytes and the original name to the importer and surfaces failures', async () => {
  const { actions } = await import('../src/lib/native-pages.ts');
  await actions.importAudio({ name: 'Трек.wav', base64: 'AQID' });
  const [file] = h.importFiles.mock.calls[0][0];
  expect(file.name).toBe('Трек.wav');
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
  await expect(actions.importAudio({ name: 'empty.wav', base64: '' })).rejects.toThrow('пустой');
  h.importFiles.mockImplementationOnce(() => { h.app.upload = { failed: [{ name: 'broken.mp3', error: 'Не удалось прочитать' }] }; });
  await expect(actions.importAudio({ name: 'broken.mp3', base64: 'AQID' })).rejects.toThrow('broken.mp3: Не удалось прочитать');
});


it('adds a track to a playlist from the native menu, or creates one with it', async () => {
  const { commands } = await import('../src/lib/native-ui.ts');
  h.app.playlists = [{ id: 'p1', name: 'Дорога', count: 3 }];
  h.addToPlaylist.mockResolvedValue({ added: 1 });
  await expect(commands.addToPlaylist({ ids: ['a', 'zzz'], playlistId: 'p1' })).resolves.toEqual({ added: 1 });
  expect(h.addToPlaylist).toHaveBeenCalledWith('p1', ['a']);
  expect(h.loadPlaylists).toHaveBeenCalledTimes(1);
  expect(h.toast).toHaveBeenCalledWith('Добавлено в «Дорога»: 1', 'success');
  h.createPlaylist.mockResolvedValue({ id: 'p2' });
  await expect(commands.addToPlaylist({ ids: ['a'], name: '  Новое  ' })).resolves.toEqual({ id: 'p2' });
  expect(h.createPlaylist).toHaveBeenCalledWith('Новое', ['a']);
  await expect(commands.addToPlaylist({ ids: ['zzz'], playlistId: 'p1' })).rejects.toThrow('Трек не найден');
  await expect(commands.addToPlaylist({ ids: ['a'], name: '   ' })).rejects.toThrow('название');
});

it('keeps own phone files in Downloads next to downloaded tracks', async () => {
  const { describe } = await import('../src/lib/native-pages.ts');
  h.app.tracks.set('own', { ...track('own'), title: 'Своя запись', provider: 'local', pinned: false });
  h.app.tracks.set('net', { ...track('net'), title: 'Из сети', provider: 'youtube', pinned: true });
  h.app.order = ['a', 'b', 'own', 'net'];
  h.downloads.mockResolvedValue({ usage: null });
  (location as any).hash = '#/downloads';
  const page = await describe() as any;
  const own = page.sections.find((s: any) => s.title?.startsWith('Свои файлы'));
  expect(own.rows).toEqual([{ kind: 'track', id: 'own' }]);
  const downloaded = page.sections.find((s: any) => s.title?.startsWith('Скачано'));
  expect(downloaded.rows[0]).toMatchObject({ id: 'net', remove: { title: 'Удалить загрузку' } });
});

it('presents restored metadata and dispatches transport without opening the web player', async () => {
  const { uiState, commands } = await import('../src/lib/native-ui.ts');
  h.app.player = { ...h.app.player, status: 'idle', position: 37, queue: [{ trackId: 'a', entryId: 'saved-entry' }] };
  expect(uiState().now).toMatchObject({ id: 'a', entryId: 'saved-entry', position: 37, duration: 100, playing: false });
  for (const action of ['play', 'pause', 'nexttrack', 'previoustrack']) await commands.playerCommand({ action });
  expect(h.resume).toHaveBeenCalledTimes(1);
  expect(h.pause).toHaveBeenCalledTimes(1);
  expect(h.nextTrack).toHaveBeenCalledTimes(1);
  expect(h.prevTrack).toHaveBeenCalledTimes(1);
  commands.playerCommand({ action: 'seekto', time: 45 });
  expect(h.seek).toHaveBeenCalledWith(45);
  for (const time of [-1, NaN, Infinity, '45']) expect(() => commands.playerCommand({ action: 'seekto', time })).toThrow();
  expect(() => commands.playerCommand({ action: 'invalid' })).toThrow();
});
