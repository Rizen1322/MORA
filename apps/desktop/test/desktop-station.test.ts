import { expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMIX_SETTINGS } from '@automix/core';
import { DesktopPlayback } from '../src/desktop-playback.ts';

function setup() {
  let host: DesktopPlayback, stationId = 0, playId = 0;
  const requests: { path: string; body: any }[] = [];
  const audio = { process: {}, start: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })),
    feedFile: vi.fn(async () => {}), stop: vi.fn(async () => {}), command: vi.fn(async (v: any) => {
      if (v.cmd === 'start') queueMicrotask(() => host.onEvent({ type: 'tick', clock: 0, paused: false, main: v.deck,
        decks: [0, 1].map(deck => ({ token: deck === v.deck ? v.token : null, playing: deck === v.deck,
          position: v.frame, totalFrames: 960000, starved: false, ratio: 1, bufferedAhead: 960000 })), transition: null, limiterDb: 0, peak: 0 }));
    }) };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body });
    if (path === '/internal/desktop/station-next') return Response.json({ context: { type: 'online-radio', label: 'Моя волна' },
      entries: Array.from({ length: body.count }, () => ({ trackId: `radio-${++stationId}`, entryId: `entry-${stationId}`, origin: 'wave' })) });
    if (path === '/internal/desktop/pcm-source') return Response.json({ path: 'private-pcm', finalPath: 'private-pcm', partPath: '',
      format: 'f32le', gainDb: -6, totalFrames: 960000, availableFrames: 960000, complete: true,
      track: { trackId: body.trackId, title: body.trackId, artist: '', duration: 20, coverUrl: '', mixingAllowed: true, binding: false } });
    if (path === '/api/settings') return Response.json({ automix: { ...DEFAULT_AUTOMIX_SETTINGS, mixOnNext: false } });
    if (path === '/api/plays') return Response.json({ id: ++playId });
    if (path === '/api/automix/plan') return Response.json({ error: 'not ready' }, { status: 503 });
    return Response.json({});
  });
  host = new DesktopPlayback(audio, { backend: () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: 'secret' }),
    ready: vi.fn(), track: vi.fn(), fetch: fetcher as typeof fetch });
  return { host, requests, fetcher, audio };
}

it('skips a login-only opening recommendation and excludes it from later refills', async () => {
  const { host, requests, fetcher } = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/internal/desktop/pcm-source') && JSON.parse(String(init?.body)).trackId === 'radio-1')
      return Response.json({ error: 'Источник требует вход в аккаунт для этой записи' }, { status: 502 });
    return original(url, init);
  });
  try {
    await host.startStation({ kind: 'online' }, { position: 0, sampleRate: 48000 });
    expect(host.state().currentTrack?.trackId).toBe('radio-2');
    expect(host.state().station?.kind).toBe('online');
    const refills = requests.filter(r => r.path === '/internal/desktop/station-next');
    expect(refills.slice(1).every(r => r.body.exclude.includes('radio-1'))).toBe(true);
  } finally { await host.stop(); }
});

it('restores station intent from an older checkpoint context and continues beyond its saved queue', async () => {
  const { host } = setup();
  try {
    await host.restoreRecovery({ queue: [{ trackId: 'saved', entryId: 'saved' }], index: 0, position: 3, device: '', settings: {},
      context: { type: 'online-radio', label: 'Моя волна' } });
    expect(host.state().station?.kind).toBe('online');
    for (let i = 0; i < 4; i++) {
      await vi.waitFor(() => expect(host.state().nextTrack).toBeDefined());
      await host.command('nexttrack');
    }
    expect(host.state().index).toBeGreaterThan(1);
  } finally { await host.stop(); }
});

it('retries a station after three unavailable tracks without requesting the same failed recordings', async () => {
  const { host, requests, fetcher, audio } = setup();
  const original = fetcher.getMockImplementation()!;
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/internal/desktop/pcm-source') && ['radio-2', 'radio-3', 'radio-4'].includes(JSON.parse(String(init?.body)).trackId))
      return Response.json({ error: 'Источник требует вход в аккаунт для этой записи' }, { status: 502 });
    return original(url, init);
  });
  try {
    await host.startStation({ kind: 'online' }, { position: 0, sampleRate: 48000 });
    await vi.waitFor(() => expect(host.state().preparation?.state).toBe('error'));
    const start = audio.command.mock.calls.map(([value]) => value).find(value => value.cmd === 'start');
    now += 16000;
    host.onEvent({ type: 'tick', clock: 0, paused: false, main: start.deck,
      decks: [0, 1].map(deck => ({ token: deck === start.deck ? start.token : null, playing: deck === start.deck,
        position: 48000, totalFrames: 960000, starved: false, ratio: 1, bufferedAhead: 960000 })), transition: null, limiterDb: 0, peak: 0 });
    await vi.waitFor(() => expect(host.state().nextTrack?.trackId).toBe('radio-5'));
    expect(requests.filter(r => r.path === '/internal/desktop/station-next').at(-1)!.body.exclude).toEqual(expect.arrayContaining(['radio-2', 'radio-3', 'radio-4']));
  } finally { clock.mockRestore(); await host.stop(); }
});

it('refills a station through several native skips with no page producer', async () => {
  const { host, requests } = setup();
  try {
    await host.startStation({ kind: 'online' }, { position: 0, sampleRate: 48000, volume: .25 });
    for (let i = 0; i < 6; i++) {
      await vi.waitFor(() => expect(host.state().nextTrack, JSON.stringify({ state: host.state(), requests: requests.slice(-5) })).toBeDefined());
      await host.command('nexttrack');
    }
    expect(host.state().currentTrack?.trackId).toBe('radio-7');
    expect(requests.filter(r => r.path === '/internal/desktop/station-next').length).toBeGreaterThan(2);
    expect(requests.filter(r => r.path === '/internal/desktop/station-next').every(r => r.body.count <= 6)).toBe(true);
    const snapshot = host.recoverySnapshot()!;
    expect(JSON.stringify(snapshot)).not.toContain('private-pcm');
    expect(snapshot.settings.volume).toBe(.25);
    await host.stop();
    await host.restoreRecovery(snapshot);
    expect(host.state().currentTrack?.trackId).toBe('radio-7');
    expect(host.state().index).toBe(snapshot.index);
    expect(host.state().station?.kind).toBe('online');
    await vi.waitFor(() => expect(requests.filter(r => r.path === '/api/plays').length).toBeGreaterThan(6));
  } finally { await host.stop(); }
});

it('does not start a late station response after the listener starts a playlist', async () => {
  const { host, fetcher } = setup();
  let resolve!: (r: Response) => void;
  fetcher.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const station = host.startStation({ kind: 'online' }, { position: 0, sampleRate: 48000 });
  const cancelled = expect(station).rejects.toThrow('Запуск отменён');
  try {
    await host.startSource({ trackId: 'playlist-song', entryId: 'playlist-entry' }, { position: 0, sampleRate: 48000 });
    resolve(Response.json({ entries: [{ trackId: 'late', entryId: 'late' }], context: { type: 'online-radio', label: 'Поздно' } }));
    await cancelled;
    expect(host.state().currentTrack?.trackId).toBe('playlist-song');
    expect(host.state().station).toBeNull();
  } finally { await host.stop(); }
});

it('ignores a station sync that arrives while a start is still choosing its first track', async () => {
  const { host, fetcher } = setup();
  const original = fetcher.getMockImplementation()!;
  let release!: (response: Response) => void;
  let asked = false;
  // fetch() rejects a cancelled request with the signal's reason, so a cancel here is visible as an error.
  fetcher.mockImplementation((url, init) => {
    if (!asked && String(url).endsWith('/internal/desktop/station-next')) {
      asked = true;
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason), { once: true });
        release = resolve;
      });
    }
    return original(url, init);
  });
  try {
    const started = host.startStation({ kind: 'yandex' }, { position: 0, sampleRate: 48000 });
    const failure = started.then(() => null, (error: Error) => error);
    await vi.waitFor(() => expect(asked).toBe(true));
    // The station the page knew before the switch restores itself while Yandex's first track is imported.
    await host.setStation({ kind: 'online' }, { type: 'online-radio', label: 'Моя волна' });
    release(Response.json({ entries: [{ trackId: 'yandex-1', entryId: 'yandex-entry', origin: 'yandex' }],
      context: { type: 'yandex-wave', label: 'Моя волна Яндекса' }, yandexSessionId: 'session-1' }));
    expect(await failure).toBeNull();
    expect(host.state().currentTrack?.trackId).toBe('yandex-1');
    expect(host.state().station).toEqual({ kind: 'yandex', yandexSessionId: 'session-1' });
  } finally { await host.stop(); }
});

it('keeps a similar station anchored to its seed when the page syncs the plain station', async () => {
  const { host, requests } = setup();
  const station = { kind: 'online' as const, seed: { title: 'anchor', artist: 'anchor' }, anchor: 'seed' as const };
  try {
    await host.startStation(station, { position: 0, sampleRate: 48000 });
    // The page only knows "online radio": its periodic sync must not strip the seed the station is anchored to.
    await host.setStation({ kind: 'online' }, { type: 'online-radio', label: 'Похожее на «anchor»' });
    expect(host.state().station).toMatchObject(station);
    await vi.waitFor(() => expect(requests.filter(r => r.path === '/internal/desktop/station-next')
      .some(r => r.body.anchor === 'seed' && r.body.seed?.title === 'anchor')).toBe(true));
  } finally { await host.stop(); }
});

it('anchors an already playing online station without restarting its current track', async () => {
  const { host, requests } = setup();
  const station = { kind: 'online' as const, seed: { title: 'anchor', artist: '' }, anchor: 'seed' as const };
  try {
    await host.startStation({ kind: 'online' }, { position: 0, sampleRate: 48000 });
    const trackId = host.state().currentTrack!.trackId!;
    await host.setStation(station);
    await host.prepareQueue(1, [], trackId, [], true);
    expect(host.state().station).toMatchObject(station);
    expect(host.state().currentTrack?.trackId).toBe(trackId);
    await vi.waitFor(() => expect(requests.some(r => r.path === '/internal/desktop/station-next' &&
      r.body.anchor === 'seed' && r.body.seed?.title === 'anchor')).toBe(true));
  } finally { await host.stop(); }
});

it('drops a stale seed anchor when switching an online station to a new unanchored seed', async () => {
  const { host, requests } = setup();
  try {
    await host.startStation({ kind: 'online', seed: { title: 'first', artist: '' }, anchor: 'seed' }, { position: 0, sampleRate: 48000 });
    await host.setStation({ kind: 'online', seed: { title: 'second', artist: 'Artist' }, yandexSessionId: undefined });
    await host.prepareQueue(1, [], host.state().currentTrack!.trackId!, [], true);
    expect(host.state().station).toEqual({ kind: 'online', seed: { title: 'second', artist: 'Artist' } });
    expect(host.state().station?.anchor).toBeUndefined();
    await vi.waitFor(() => expect(requests.some(r => r.path === '/internal/desktop/station-next' &&
      r.body.seed?.title === 'second' && r.body.anchor === undefined)).toBe(true));
  } finally { await host.stop(); }
});

it('clears a station wait when the listener starts another track', async () => {
  const { host, fetcher, audio } = setup();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => new URL(String(url)).pathname === '/internal/desktop/station-next'
    ? Promise.resolve(Response.json({ entries: [] })) : original(url, init));
  try {
    const config = { position: 0, sampleRate: 48000 };
    await host.startSource({ trackId: 'a', entryId: 'a' }, config);
    await host.setStation({ kind: 'online' });
    const start = audio.command.mock.calls.map(([value]) => value).find(value => value.cmd === 'start');
    host.onEvent({ type: 'ended', token: start.token });
    expect(host.state().waitingForPreparation).toBe(true);
    const next = await host.startSource({ trackId: 'b', entryId: 'b' }, config);
    expect(next).toMatchObject({ entryId: 'b', playing: true, waitingForPreparation: false });
  } finally { await host.stop(); }
});

it('keeps long-running radio history bounded and its recovery cursor valid', async () => {
  const { host } = setup();
  try {
    await host.restoreRecovery({ queue: Array.from({ length: 241 }, (_,i) => ({ trackId: `old-${i}`, entryId: `old-entry-${i}`, origin: 'wave' })),
      index: 240, position: 0, settings: { volume: .2 }, device: '', station: { kind: 'online' } });
    await vi.waitFor(() => expect(host.state().nextTrack).toBeDefined());
    await host.command('nexttrack');
    const snapshot = host.recoverySnapshot()!;
    expect(snapshot.queue.length).toBeLessThanOrEqual(206);
    expect(snapshot.index).toBe(199);
    expect(snapshot.queue[snapshot.index].entryId).toBe(host.state().entryId);
  } finally { await host.stop(); }
});

it('prunes a prepared dislike, blocks stale queue handoffs, and cuts a disliked current song without a mix', async () => {
  const { host, requests, audio } = setup();
  try {
    await host.startSource({ trackId: 'a', entryId: 'a' }, { position: 0, sampleRate: 48000 });
    await host.prepareQueue(1, ['b', 'c', 'b'].map((trackId, i) => ({ trackId, entryId: `e${i}` })), 'a');
    await vi.waitFor(() => expect(host.state().nextTrack?.trackId).toBe('b'));
    await host.applyDislikes(['b']);
    await vi.waitFor(() => expect(host.state().nextTrack?.trackId).toBe('c'));
    expect(audio.command).toHaveBeenCalledWith({ cmd: 'disarm' });
    expect(host.recoverySnapshot()!.queue.map(e => e.trackId)).toEqual(['a', 'c']);
    await host.prepareQueue(1, [{ trackId: 'b', entryId: 'stale' }, { trackId: 'c', entryId: 'e1' }], 'a', [{ trackId: 'b', entryId: 'loop' }], true);
    expect(host.recoverySnapshot()!.loop).toEqual([]);
    await host.applyDislikes(['a', 'b']);
    expect(host.state().currentTrack?.trackId).toBe('c');
    expect(requests.some(r => r.path === '/api/automix/mix-now')).toBe(false);
    await expect(host.startSource({ trackId: 'b', entryId: 'manual' }, { position: 0, sampleRate: 48000 })).rejects.toThrow('дизлайком');
  } finally { await host.stop(); }
});

it('pauses a disliked last song and restores past a negative current and future entry', async () => {
  const { host, audio } = setup();
  try {
    await host.startSource({ trackId: 'a', entryId: 'a' }, { position: 0, sampleRate: 48000 });
    await host.applyDislikes(['a', 'b']);
    expect(audio.command).toHaveBeenCalledWith({ cmd: 'pause', paused: true });
    await host.restoreRecovery({ queue: ['a', 'c', 'b', 'd'].map(id => ({ trackId: id, entryId: id })), index: 0,
      position: 10, settings: {}, device: '', loop: [{ trackId: 'b', entryId: 'loop' }] });
    expect(host.state().currentTrack?.trackId).toBe('c');
    expect(host.state().position).toBe(0);
    expect(host.recoverySnapshot()!.queue.map(e => e.trackId)).toEqual(['a', 'c', 'd']);
    expect(host.recoverySnapshot()!.loop).toEqual([]);
  } finally { await host.stop(); }
});

it('filters a late station response against a dislike committed while it was loading', async () => {
  const { host, fetcher } = setup();
  let resolve!: (response: Response) => void;
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/internal/desktop/station-next') && JSON.parse(String(init?.body)).exclude.length)
      return new Promise<Response>(r => { resolve = r; });
    return original(url, init);
  });
  try {
    await host.startStation({ kind: 'online' }, { position: 0, sampleRate: 48000 });
    await vi.waitFor(() => expect(resolve).toBeDefined());
    await host.applyDislikes(['late']);
    resolve(Response.json({ entries: [{ trackId: 'late', entryId: 'late' }, { trackId: 'good', entryId: 'good' }] }));
    await vi.waitFor(() => expect(host.state().nextTrack?.trackId).toBe('good'));
    expect(host.recoverySnapshot()!.queue.some(e => e.trackId === 'late')).toBe(false);
  } finally { await host.stop(); }
});

it('resumes the safe successor when the disliked current song had preparation in flight', async () => {
  const { host, fetcher, audio } = setup();
  const original = fetcher.getMockImplementation()!;
  let release!: () => void;
  let held = false;
  fetcher.mockImplementation(async (url, init) => {
    if (!held && String(url).endsWith('/internal/desktop/pcm-source') && JSON.parse(String(init?.body)).trackId === 'b') {
      held = true;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return original(url, init);
  });
  try {
    await host.startSource({ trackId: 'a', entryId: 'a' }, { position: 0, sampleRate: 48000 });
    await host.prepareQueue(1, [{ trackId: 'b', entryId: 'b' }, { trackId: 'c', entryId: 'c' }], 'a');
    await vi.waitFor(() => expect(release).toBeDefined());
    const reaction = host.applyDislikes(['a']);
    await vi.waitFor(() => expect(audio.command).toHaveBeenCalledWith({ cmd: 'pause', paused: true }));
    release(); await reaction;
    await vi.waitFor(() => expect(host.state().currentTrack?.trackId).toBe('b'));
    await vi.waitFor(() => expect(host.state().nextTrack?.trackId).toBe('c'));
    expect(audio.command).toHaveBeenCalledWith({ cmd: 'pause', paused: false });
  } finally { release?.(); await host.stop(); }
});