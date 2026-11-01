import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  app: {} as any, listeners: [] as (() => void)[], radio: { active: false, loading: false, error: null as string | null },
  playTracks: vi.fn(), addToQueue: vi.fn(), toggle: vi.fn(), startWave: vi.fn(), startRadio: vi.fn(), toast: vi.fn(),
}));
vi.mock('../src/store/app.ts', () => ({
  phone: true,
  controller: { playTracks: (...a: any[]) => h.playTracks(...a), addToQueue: (...a: any[]) => h.addToQueue(...a), toggle: () => h.toggle(), startWave: (k: string) => h.startWave(k) },
  trackOf: (id: string) => h.app.tracks.get(id),
  useApp: { getState: () => h.app, setState: vi.fn(), subscribe: (fn: () => void) => h.listeners.push(fn) },
}));
vi.mock('../src/lib/radio.ts', () => ({ startRadio: () => h.startRadio(), useRadio: { getState: () => h.radio, subscribe: vi.fn() } }));
vi.mock('../src/store/catalog.ts', () => ({ publicPlayer: {}, usePublicPlayback: { getState: () => ({ phase: 'idle', title: '' }), subscribe: vi.fn() } }));
vi.mock('../src/pages/Search.tsx', () => ({ asCatalog: (t: any) => t, SOURCE_LABEL: {} }));
vi.mock('../src/components/TrackList.tsx', () => ({ react: vi.fn() }));
vi.mock('../src/lib/api.ts', () => ({ api: {} }));

const track = (id: string, status = 'ok') => ({ id, title: id.toUpperCase(), artist: 'X', album: '', duration: 100, reaction: 0, coverUrl: null, status });

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.listeners.length = 0;
  h.radio = { active: false, loading: false, error: null };
  const tracks = new Map([['a', track('a')], ['b', track('b', 'missing')]]);
  h.app = { tracks, order: ['a', 'b'], loaded: true, playlists: [], providers: [], toasts: [], fullPlayer: false, queueOpen: false, panel: null, toast: h.toast,
    player: { status: 'playing', queue: [{ trackId: 'a' }], index: 0, context: { type: 'wave', label: 'Моя волна' }, error: null } };
  vi.stubGlobal('location', { hash: '#/liked?x=1' });
});

describe('native shell bridge (page side)', () => {
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
