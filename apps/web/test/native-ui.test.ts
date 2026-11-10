import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  app: {} as any, listeners: [] as (() => void)[], radio: { active: false, loading: false, error: null as string | null },
  playTracks: vi.fn(), addToQueue: vi.fn(), toggle: vi.fn(), startWave: vi.fn(), startRadio: vi.fn(), toast: vi.fn(),
  openVersionPanel: vi.fn(), yandexWaveSettings: vi.fn(), refreshYandexWave: vi.fn(), react: vi.fn(), patchTrack: vi.fn(),
}));
vi.mock('../src/store/app.ts', () => ({
  phone: true,
  controller: { playTracks: (...a: any[]) => h.playTracks(...a), addToQueue: (...a: any[]) => h.addToQueue(...a), toggle: () => h.toggle(), startWave: (k: string) => h.startWave(k), refreshYandexWave: () => h.refreshYandexWave() },
  trackOf: (id: string) => h.app.tracks.get(id),
  useApp: { getState: () => h.app, setState: vi.fn(), subscribe: (fn: () => void) => h.listeners.push(fn) },
}));
vi.mock('../src/lib/radio.ts', () => ({ startRadio: () => h.startRadio(), useRadio: { getState: () => h.radio, subscribe: vi.fn() } }));
vi.mock('../src/store/catalog.ts', () => ({ publicPlayer: {}, usePublicPlayback: { getState: () => ({ phase: 'idle', title: '' }), subscribe: vi.fn() } }));
vi.mock('../src/pages/Search.tsx', () => ({ asCatalog: (t: any) => t, SOURCE_LABEL: {} }));
vi.mock('../src/components/TrackList.tsx', () => ({ react: vi.fn() }));
vi.mock('../src/components/VersionPanel.tsx', () => ({
  openVersionPanel: (...a: any[]) => h.openVersionPanel(...a),
  useVersionPanel: { getState: () => ({ target: null }), subscribe: vi.fn() },
}));
vi.mock('../src/lib/api.ts', () => ({ api: { react: (...args: any[]) => h.react(...args), yandexWaveSettings: () => h.yandexWaveSettings() } }));

const track = (id: string, status = 'ok') => ({ id, title: id.toUpperCase(), artist: 'X', album: '', duration: 100, reaction: 0, coverUrl: null, status });

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.listeners.length = 0;
  h.radio = { active: false, loading: false, error: null };
  const tracks = new Map([['a', track('a')], ['b', track('b', 'missing')]]);
  h.app = { patchTrack: h.patchTrack, tracks, order: ['a', 'b'], loaded: true, playlists: [], providers: [], toasts: [], fullPlayer: false, queueOpen: false, panel: null, toast: h.toast,
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
    expect(() => commands.publicPlay({ source: 'ytmusic', id: 'x' })).toThrow('устарел');
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
  const push = vi.fn(async (state: any) => ({ shown, nativeContent: shown && !state.overlay && state.path !== '/yandex' }));
  vi.stubGlobal('window', { moraNativePlayback: { uiState: push }, addEventListener: vi.fn() });
  vi.stubGlobal('document', { getElementById: () => root, activeElement: { blur }, documentElement: { classList: { toggle: vi.fn() } } });
  const { startNativeUi } = await import('../src/lib/native-ui.ts');
  startNativeUi(); await vi.advanceTimersByTimeAsync(200);
  expect(root.inert).toBe(true); expect(blur).toHaveBeenCalledTimes(1);
  h.app = { ...h.app, toasts: [{ id: 1, text: 'test' }] }; h.listeners.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(200);
  expect(blur).toHaveBeenCalledTimes(1); // State refreshes must not dismiss the native keyboard.
  h.app = { ...h.app, fullPlayer: true }; h.listeners.forEach(fn => fn()); await vi.advanceTimersByTimeAsync(200);
  expect(root.inert).toBe(false);
  h.app = { ...h.app, fullPlayer: false }; (location as any).hash = '#/yandex';
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
