import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ state: {} as any, queueVersion: 1, heard: new Set<string>(), tracks: new Map<string, any>(), settings: { wave: { mood: 'normal', diversity: 'balanced', mode: 'normal' } } as any,
  callbacks: [] as (() => void)[], hold: vi.fn(), continueAs: vi.fn(), follow: vi.fn(), search: vi.fn(), related: vi.fn(), waveNext: vi.fn(), toast: vi.fn(),
  ensure: vi.fn(), play: vi.fn(), playTracks: vi.fn(), appListeners: [] as ((s: any, prev: any) => void)[] }));
vi.mock('../src/store/app.ts', () => ({ controller: { unlockAudio: async () => {}, intentVersion: 1, get queueVersion() { return h.queueVersion }, get state() { return h.state }, get heard() { return h.heard },
  get currentEntry() { return h.state.queue[h.state.index] ?? null },
  holdQueueEnd: (label: string | null) => { h.hold(label); h.state = { ...h.state, continuation: label }; },
  continueAs: (...args: any[]) => { h.continueAs(...args); h.state = { ...h.state, context: args[0] }; },
  playTracks: (...args: any[]) => h.playTracks(...args),
  subscribe: (fn: () => void) => h.callbacks.push(fn) },
  useApp: { getState: () => ({ tracks: h.tracks, settings: h.settings, toast: h.toast }), subscribe: (fn: (s: any, prev: any) => void) => h.appListeners.push(fn) } }));
vi.mock('../src/store/catalog.ts', () => ({ publicPlayer: { sessionVersion: 7, remaining: 15, sessionItems: [], follow: (...args: any[]) => h.follow(...args),
  ensure: (...args: any[]) => h.ensure(...args), play: (...args: any[]) => h.play(...args), extend: vi.fn() } }));
vi.mock('../src/pages/Search.tsx', () => ({ asCatalog: (t: any) => t }));
vi.mock('../src/lib/api.ts', () => ({ api: { publicSearch: (...args: any[]) => h.search(...args), publicRadio: (...args: any[]) => h.related(...args), waveNext: (...args: any[]) => h.waveNext(...args) } }));

const song = (id: string, artist: string, reaction = 0) => ({ id, title: id, artist, reaction, status: 'ok', addedAt: 1, playCount: 0, analysis: {} });
const candidate = (id: string, artist: string) => ({ externalId: id, title: id, artist, playable: true, audioProvider: 'youtube' });
const tick = () => h.callbacks.forEach((fn) => fn());

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.useRealTimers(); h.callbacks.length = 0; h.appListeners.length = 0;
  for (const m of [h.related, h.search, h.waveNext, h.playTracks, h.play]) m.mockReset();
  h.ensure.mockImplementation(async (t: any) => `lib-${t.externalId}`); h.tracks.clear(); h.heard = new Set(['a-entry']); h.queueVersion = 1;
  h.settings = { wave: { mood: 'normal', diversity: 'balanced', mode: 'normal' } };
  for (const t of [song('a', 'Alpha'), song('b', 'Beta'), song('n1', 'Nope', -1), song('n2', 'Nope', -1)]) h.tracks.set(t.id, t);
  h.state = { status: 'playing', queue: [{ entryId: 'a-entry', trackId: 'a', origin: 'context' }, { entryId: 'b-entry', trackId: 'b', origin: 'context' }], index: 1,
    repeat: 'off', context: { type: 'playlist', id: 'p', label: 'Летний' }, position: 170, duration: 220, continuation: null };
  h.search.mockImplementation(async (_source: string, q: string) => ({ items: [candidate(`yt-${q}`, q.split(' ')[0])] }));
  h.related.mockResolvedValue({ items: [candidate('a', 'Alpha'), candidate('fresh', 'Fresh'), candidate('banned', 'Nope'), candidate('other', 'Other')] });
  h.follow.mockReturnValue(7);
});

describe('queue-end radio continuation', () => {
  it('continues a finishing playlist with an online station from the heard songs, minus session songs and turned-down artists', async () => {
    await import('../src/lib/radio.ts');
    tick();
    await vi.waitFor(() => expect(h.follow).toHaveBeenCalled());
    expect(h.hold).toHaveBeenCalledWith('Радио по мотивам «Летний»');
    expect(h.search.mock.calls.map((c) => c[1])).toEqual(['Beta b', 'Alpha a']);
    expect(h.continueAs).toHaveBeenCalledWith({ type: 'online-radio', label: 'Радио по мотивам «Летний»' });
    const picked = h.follow.mock.calls[0][0].map((t: any) => t.externalId);
    expect(picked).toEqual(expect.arrayContaining(['fresh', 'other']));
    expect(picked).not.toContain('banned'); expect(picked).not.toContain('a');
    expect(h.waveNext).not.toHaveBeenCalled(); expect(h.toast).not.toHaveBeenCalled();
    tick(); expect(h.search).toHaveBeenCalledTimes(2);
  });
  it('continues from the local library when the network is down', async () => {
    h.search.mockRejectedValue(new TypeError('Failed to fetch')); h.related.mockRejectedValue(new TypeError('Failed to fetch'));
    h.waveNext.mockResolvedValue({ picks: [{ id: 'local1', reasons: [] }, { id: 'local2', reasons: [] }] });
    await import('../src/lib/radio.ts');
    tick();
    await vi.waitFor(() => expect(h.continueAs).toHaveBeenCalled());
    expect(h.continueAs).toHaveBeenCalledWith({ type: 'wave', label: 'Моя волна' }, ['local1', 'local2'], 'wave');
    expect(h.waveNext).toHaveBeenCalledWith({ currentId: 'b', session: ['a', 'b'], count: 2 });
    expect(h.follow).not.toHaveBeenCalled();
  });
  it('stops honestly when nothing similar is available', async () => {
    h.related.mockResolvedValue({ items: [] }); h.waveNext.mockResolvedValue({ picks: [] });
    await import('../src/lib/radio.ts');
    tick();
    await vi.waitFor(() => expect(h.hold).toHaveBeenLastCalledWith(null));
    expect(h.continueAs).not.toHaveBeenCalled(); expect(h.toast).toHaveBeenCalledOnce();
  });
  it('does not continue with repeat, when switched off, too early, or after the listener moved on', async () => {
    const { continueQueue } = await import('../src/lib/radio.ts');
    h.state = { ...h.state, repeat: 'all' }; tick();
    h.state = { ...h.state, repeat: 'off', position: 10 }; tick();
    h.settings = { wave: { ...h.settings.wave, continueRadio: false } }; h.state = { ...h.state, position: 170 }; tick();
    expect(h.hold).not.toHaveBeenCalled();
    h.settings = { wave: { ...h.settings.wave, continueRadio: true } };
    let release!: (v: any) => void; h.related.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const task = continueQueue('b-entry');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    h.queueVersion = 2; release({ items: [candidate('late', 'Late')] }); await task;
    expect(h.continueAs).not.toHaveBeenCalled(); expect(h.follow).not.toHaveBeenCalled(); expect(h.toast).not.toHaveBeenCalled();
  });

  it('returns from the offline local wave to the online station from the next song, checking no more often than every 30 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    h.search.mockRejectedValue(new TypeError('Failed to fetch')); h.related.mockRejectedValue(new TypeError('Failed to fetch'));
    h.waveNext.mockResolvedValue({ picks: [{ id: 'local1', reasons: [] }] });
    const { RETRY_ONLINE_MS } = await import('../src/lib/radio.ts');
    tick();
    await vi.waitFor(() => expect(h.continueAs).toHaveBeenCalledWith({ type: 'wave', label: 'Моя волна' }, ['local1'], 'wave'));
    const searches = h.search.mock.calls.length;
    h.search.mockImplementation(async (_source: string, q: string) => ({ items: [candidate(`yt-${q}`, q.split(' ')[0])] }));
    h.related.mockResolvedValue({ items: [candidate('fresh', 'Fresh'), candidate('other', 'Other')] });
    vi.advanceTimersByTime(RETRY_ONLINE_MS - 1000); tick(); await Promise.resolve();
    expect(h.search).toHaveBeenCalledTimes(searches);
    vi.advanceTimersByTime(1000); tick();
    await vi.waitFor(() => expect(h.follow).toHaveBeenCalled());
    expect(h.continueAs).toHaveBeenLastCalledWith({ type: 'online-radio', label: 'Радио по мотивам «Летний»' }, [expect.stringMatching(/^lib-/)], 'context', true);
    expect(h.ensure).toHaveBeenCalledOnce();
    expect(h.follow.mock.calls[0][0]).toHaveLength(1);
  });
  it('stops trying to return once the listener leaves the fallback wave', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    h.search.mockRejectedValue(new TypeError('offline')); h.related.mockRejectedValue(new TypeError('offline'));
    h.waveNext.mockResolvedValue({ picks: [{ id: 'local1', reasons: [] }] });
    const { RETRY_ONLINE_MS } = await import('../src/lib/radio.ts');
    tick();
    await vi.waitFor(() => expect(h.continueAs).toHaveBeenCalled());
    const searches = h.search.mock.calls.length;
    h.state = { ...h.state, context: { type: 'album', label: 'Другое' } };
    vi.advanceTimersByTime(RETRY_ONLINE_MS); tick();
    h.appListeners.forEach((fn) => fn({ serverOnline: true }, { serverOnline: false }));
    await Promise.resolve();
    expect(h.search).toHaveBeenCalledTimes(searches);
  });
});

describe('similar and artist station buttons', () => {
  it('"similar to this song" keeps the playing song and seeds only from it', async () => {
    const { startSimilar } = await import('../src/lib/radio.ts');
    await startSimilar(h.tracks.get('b'));
    expect(h.playTracks).not.toHaveBeenCalled();
    expect(h.search.mock.calls.map((c) => c[1])).toEqual(['Beta b']);
    expect(h.continueAs).toHaveBeenCalledWith({ type: 'online-radio', label: 'Похожее на «b»' }, [expect.stringMatching(/^lib-/)], 'context', true);
    expect(h.follow).toHaveBeenCalledOnce();
  });
  it('"similar" on another song plays it first, and refuses a disliked one', async () => {
    h.playTracks.mockImplementation(async (ids: string[]) => { h.queueVersion++; h.state = { ...h.state, queue: [{ entryId: 'new', trackId: ids[0], origin: 'context' }], index: 0 }; });
    const { startSimilar } = await import('../src/lib/radio.ts');
    await startSimilar(h.tracks.get('a'));
    expect(h.playTracks).toHaveBeenCalledWith(['a'], 0, { type: 'online-radio', label: 'Похожее на «a»' });
    expect(h.search.mock.calls.map((c) => c[1])).toEqual(['Alpha a']);
    expect(h.follow).toHaveBeenCalledOnce();
    await startSimilar(h.tracks.get('n1'));
    expect(h.toast).toHaveBeenCalledWith(expect.stringContaining('дизлайком'), 'error');
  });
  it('artist radio seeds from the artist\'s liked and most played songs and starts a new station', async () => {
    for (const t of [{ ...song('z1', 'Zeta'), playCount: 9 }, song('z2', 'Zeta', 1), song('z3', 'Zeta feat. Alpha'), song('z4', 'Zeta', -1)]) h.tracks.set(t.id, t);
    h.play.mockResolvedValue(undefined);
    const { startArtistRadio } = await import('../src/lib/radio.ts');
    await startArtistRadio('Zeta');
    expect(h.search.mock.calls.map((c) => c[1])).toEqual(['Zeta z2', 'Zeta z1']);
    expect(h.play).toHaveBeenCalledWith(expect.any(Array), 0, { type: 'online-radio', label: 'Радио: Zeta' });
  });
});