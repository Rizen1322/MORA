import { CHUNK_FRAMES, DEFAULT_AUTOMIX_SETTINGS, planRequestedTransition, planTransition } from '@automix/core';
import { expect, it, vi } from 'vitest';
import { DesktopPlayback } from '../src/desktop-playback.ts';

it.each([0, CHUNK_FRAMES + 123, 9 * CHUNK_FRAMES + 123])('keeps decoding past an estimated length of %i frames until the real end', async (estimate) => {
  const chunk = Math.max(2, Math.floor(estimate / CHUNK_FRAMES));
  const total = (chunk + 2) * CHUNK_FRAMES + 123;
  let host: DesktopPlayback, loaded: any;
  let complete = false;
  const audio = { process: {}, start: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })),
    feedFile: vi.fn(async (_value: object) => {}), stop: vi.fn(async () => {}),
    command: vi.fn(async (value: any) => {
      if (value.cmd === 'load') loaded = value;
      if (value.cmd === 'start') queueMicrotask(() => host.onEvent({ type: 'tick', clock: 0, paused: false, main: value.deck,
        decks: [0, 1].map(deck => ({ token: deck === value.deck ? value.token : null, playing: deck === value.deck,
          position: 0, totalFrames: loaded.totalFrames, starved: false, ratio: 1, bufferedAhead: CHUNK_FRAMES })),
        transition: null, limiterDb: 0, peak: 0 }));
    }) };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).pathname !== '/internal/desktop/pcm-source') return Response.json({});
    const { start, frames } = JSON.parse(String(init?.body));
    return Response.json({ sourceId: 'a', path: complete ? 'a.f32' : 'a.part', finalPath: 'a.f32', partPath: 'a.part',
      format: 'f32le', totalFrames: complete ? total : estimate,
      availableFrames: complete ? total : start + frames, complete,
      track: { trackId: 'a', title: '', artist: '', duration: estimate / 48000, coverUrl: '', mixingAllowed: true } });
  });
  host = new DesktopPlayback(audio, { backend: () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: 'secret' }),
    ready: vi.fn(), track: vi.fn(), fetch: fetcher as typeof fetch });
  const need = (chunk: number) => host.onEvent({ type: 'need', deck: loaded.deck, token: loaded.token, chunks: [chunk] });
  try {
    await host.startSource({ trackId: 'a', entryId: 'entry-a' }, { sampleRate: 48000, position: 0 });
    expect(loaded.totalFrames).toBeGreaterThan(CHUNK_FRAMES);
    need(chunk);
    await vi.waitFor(() => expect(audio.feedFile).toHaveBeenCalledWith(expect.objectContaining({ chunk, frames: CHUNK_FRAMES })));
    const request = fetcher.mock.calls.find(([, init]) => init?.body && JSON.parse(String(init.body)).start === chunk * CHUNK_FRAMES);
    expect(JSON.parse(String(request![1]!.body)).frames).toBe(CHUNK_FRAMES);
    expect(host.state().duration * 48000).toBeGreaterThan((chunk + 1) * CHUNK_FRAMES);
    complete = true;
    need(chunk + 1);
    await vi.waitFor(() => expect(audio.command).toHaveBeenCalledWith({ cmd: 'length', deck: loaded.deck, token: loaded.token, totalFrames: total }));
    need(chunk + 2);
    await vi.waitFor(() => expect(audio.feedFile).toHaveBeenCalledWith(expect.objectContaining({ chunk: chunk + 2, frames: 123, path: 'a.f32' })));
    expect(host.state().duration * 48000).toBeCloseTo(total);
  } finally { await host.stop(); }
});

it.each([false, true])('waits for the decoded end before arming AutoMix, even with a cached metadata plan (%s)', async cached => {
  const track = (id: string, duration: number) => ({ id, duration, mixingAllowed: true, analysis: null });
  const early = planTransition(track('a', 20), track('b', 180), DEFAULT_AUTOMIX_SETTINGS);
  let complete = false, host: DesktopPlayback;
  const loads: any[] = [], arms: any[] = [];
  const audio = { process: {}, start: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })),
    feedFile: vi.fn(async (_value: object) => {}), stop: vi.fn(async () => {}),
    command: vi.fn(async (value: any) => {
      if (value.cmd === 'load') loads.push(value);
      if (value.cmd === 'arm') arms.push(value.transition);
      if (value.cmd === 'start') queueMicrotask(() => host.onEvent({ type: 'tick', clock: 0, paused: false, main: value.deck,
        decks: [0, 1].map(deck => ({ token: deck === value.deck ? value.token : null, playing: deck === value.deck,
          position: 0, totalFrames: loads[0].totalFrames, starved: false, ratio: 1, bufferedAhead: CHUNK_FRAMES })),
        transition: null, limiterDb: 0, peak: 0 }));
    }) };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/settings') return Response.json({ automix: DEFAULT_AUTOMIX_SETTINGS });
    if (path === '/api/automix/plan') return cached ? Response.json({ plan: early, pending: [] }) : Response.json({}, { status: 503 });
    if (path !== '/internal/desktop/pcm-source') return Response.json({});
    const { trackId, start, frames } = JSON.parse(String(init?.body));
    const done = trackId === 'b' || complete;
    return Response.json({ path: `${trackId}.f32`, finalPath: `${trackId}.f32`, partPath: '', format: 'f32le',
      totalFrames: (done ? 180 : 20) * 48000, availableFrames: done ? 180 * 48000 : start + frames, complete: done,
      track: { trackId, title: '', artist: '', duration: trackId === 'a' ? 20 : 180, coverUrl: '', mixingAllowed: true } });
  };
  host = new DesktopPlayback(audio, { backend: () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: 'secret' }),
    ready: vi.fn(), track: vi.fn(), fetch: fetcher as typeof fetch });
  try {
    await host.startSource({ trackId: 'a', entryId: 'entry-a' }, { sampleRate: 48000, position: 0 });
    await host.prepareQueue(1, [{ trackId: 'b', entryId: 'entry-b' }], 'a');
    await vi.waitFor(() => expect(host.state().nextTrack?.plan).toBeDefined());
    expect(arms).toEqual([]);
    complete = true;
    host.onEvent({ type: 'need', deck: loads[0].deck, token: loads[0].token, chunks: [6] });
    await vi.waitFor(() => expect(arms).toHaveLength(1));
    expect(host.state().nextTrack!.plan!.aExit).toBeGreaterThan(150);
    expect(arms[0].triggerFrame).toBeGreaterThan(150 * 48000);
  } finally { await host.stop(); }
});

it('reuses a slow initial plan after arming the one-second fallback', async () => {
  const track = (id: string) => ({ id, duration: 20, mixingAllowed: true, analysis: null });
  const plan = { ...planTransition(track('a'), track('b'), DEFAULT_AUTOMIX_SETTINGS), id: 'slow-plan' };
  let release!: (value: Response) => void, calls = 0;
  const delayed = new Promise<Response>(resolve => { release = resolve; });
  let host: DesktopPlayback;
  const audio = { process: {}, start: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })),
    feedFile: vi.fn(async () => {}), stop: vi.fn(async () => {}), command: vi.fn(async (v: any) => {
      if (v.cmd === 'start') queueMicrotask(() => host.onEvent({ type: 'tick', clock: 0, paused: false, main: v.deck,
        decks: [0, 1].map(deck => ({ token: deck === v.deck ? v.token : null, playing: deck === v.deck,
          position: v.frame, totalFrames: 960000, starved: false, ratio: 1, bufferedAhead: 960000 })), transition: null, limiterDb: 0, peak: 0 }));
    }) };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === '/internal/desktop/pcm-source') return Response.json({ path: 'private', finalPath: 'private', partPath: '',
      format: 'f32le', totalFrames: 960000, availableFrames: 960000, complete: true,
      track: { trackId: body.trackId, title: '', artist: '', duration: 20, coverUrl: '', mixingAllowed: true } });
    if (path === '/api/settings') return Response.json({ automix: DEFAULT_AUTOMIX_SETTINGS });
    if (path === '/api/automix/plan') { calls++; return delayed; }
    return Response.json({});
  };
  host = new DesktopPlayback(audio, { backend: () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: 'secret' }),
    ready: vi.fn(), track: vi.fn(), fetch: fetcher as typeof fetch });
  try {
    await host.startSource({ trackId: 'a', entryId: 'entry-a' }, { sampleRate: 48000, position: 0 });
    await host.prepareQueue(1, [{ trackId: 'b', entryId: 'entry-b' }], 'a');
    await vi.waitFor(() => expect(host.state().nextTrack?.plan).toBeDefined(), { timeout: 2500 });
    expect(calls).toBe(1);
    release(Response.json({ plan, pending: [] }));
    await vi.waitFor(() => expect(host.state().nextTrack?.plan?.id).toBe('slow-plan'));
  } finally { await host.stop(); }
});

it('keeps asking for the real plan after a failed request instead of keeping the fallback', async () => {
  const track = (id: string) => ({ id, duration: 20, mixingAllowed: true, analysis: null });
  const plan = { ...planTransition(track('a'), track('b'), DEFAULT_AUTOMIX_SETTINGS), id: 'late-plan' };
  let calls = 0;
  let host: DesktopPlayback;
  const audio = { process: {}, start: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })),
    feedFile: vi.fn(async () => {}), stop: vi.fn(async () => {}), command: vi.fn(async (v: any) => {
      if (v.cmd === 'start') queueMicrotask(() => host.onEvent({ type: 'tick', clock: 0, paused: false, main: v.deck,
        decks: [0, 1].map(deck => ({ token: deck === v.deck ? v.token : null, playing: deck === v.deck,
          position: v.frame, totalFrames: 960000, starved: false, ratio: 1, bufferedAhead: 960000 })), transition: null, limiterDb: 0, peak: 0 }));
    }) };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path === '/internal/desktop/pcm-source') return Response.json({ path: 'private', finalPath: 'private', partPath: '',
      format: 'f32le', totalFrames: 960000, availableFrames: 960000, complete: true,
      track: { trackId: body.trackId, title: '', artist: '', duration: 20, coverUrl: '', mixingAllowed: true } });
    if (path === '/api/settings') return Response.json({ automix: DEFAULT_AUTOMIX_SETTINGS });
    // the first two requests fail (busy server), the third one has the plan
    if (path === '/api/automix/plan') return ++calls < 3 ? Response.json({ error: 'busy' }, { status: 503 }) : Response.json({ plan, pending: [] });
    return Response.json({});
  };
  host = new DesktopPlayback(audio, { backend: () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: 'secret' }),
    ready: vi.fn(), track: vi.fn(), fetch: fetcher as typeof fetch });
  try {
    await host.startSource({ trackId: 'a', entryId: 'entry-a' }, { sampleRate: 48000, position: 0 });
    await host.prepareQueue(1, [{ trackId: 'b', entryId: 'entry-b' }], 'a');
    await vi.waitFor(() => expect(host.state().nextTrack?.plan?.id).toBe('late-plan'), { timeout: 6000 });
  } finally { await host.stop(); }
}, 10000);

it('replans a missed musical point after seeking instead of keeping the nearby fallback', async () => {
  const settings = { ...DEFAULT_AUTOMIX_SETTINGS, mixOnNext: false };
  const track = (id: string) => ({ id, duration: 20, mixingAllowed: true, analysis: null });
  const fallback = planTransition(track('a'), track('b'), settings);
  const position = fallback.aExit - 2.5;
  let caughtUp: ReturnType<typeof planRequestedTransition>;
  const requests: any[] = [], commands: any[] = [];
  let host: DesktopPlayback;
  const audio = { process: {}, start: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })),
    feedFile: vi.fn(async () => {}), stop: vi.fn(async () => {}), command: vi.fn(async (v: any) => {
      commands.push(v);
      if (v.cmd === 'start') queueMicrotask(() => host.onEvent({ type: 'tick', clock: 0, paused: false, main: v.deck,
        decks: [0, 1].map(deck => ({ token: deck === v.deck ? v.token : null, playing: deck === v.deck,
          position: v.frame, totalFrames: 960000, starved: false, ratio: 1, bufferedAhead: 960000 })), transition: null, limiterDb: 0, peak: 0 }));
    }) };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (pathname === '/internal/desktop/pcm-source') return Response.json({ path: 'private', finalPath: 'private', partPath: '',
      format: 'f32le', gainDb: -6, totalFrames: 960000, availableFrames: 960000, complete: true,
      track: { trackId: body.trackId, title: body.trackId, artist: '', duration: 20, coverUrl: '', mixingAllowed: true } });
    if (pathname === '/api/settings') return Response.json({ automix: settings });
    if (pathname === '/api/automix/plan') return Response.json({ plan: { ...fallback, aExit: position - 2 }, pending: [] });
    if (pathname === '/api/automix/mix-now') {
      requests.push(body);
      caughtUp = planRequestedTransition(track('a'), track('b'), body.position, { ...settings, mixOnNext: true });
      return Response.json({ plan: caughtUp });
    }
    return Response.json({});
  };
  host = new DesktopPlayback(audio, { backend: () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: 'secret' }),
    ready: vi.fn(), track: vi.fn(), fetch: fetcher as typeof fetch });
  try {
    await host.startSource({ trackId: 'a', entryId: 'entry-a' }, { sampleRate: 48000, position });
    await host.prepareQueue(1, [{ trackId: 'b', entryId: 'entry-b' }], 'a');
    await vi.waitFor(() => expect(host.state().nextTrack?.plan?.debug.requested).toBe(true));
    expect(requests).toEqual([{ from: 'a', to: 'b', position: position + 1, catchUp: true }]);
    expect(host.state().nextTrack?.plan?.method).toBe('fallback_crossfade');
    expect(commands.findLast(c => c.cmd === 'arm').transition.planId).toBe(caughtUp!.id);
  } finally { await host.stop(); }
});

it('arms the ready plan instead of the no-analysis fallback after a seek near the end', async () => {
  const settings = { ...DEFAULT_AUTOMIX_SETTINGS, mixOnNext: false };
  const track = (id: string) => ({ id, duration: 20, mixingAllowed: true, analysis: null });
  const fallback = planTransition(track('a'), track('b'), settings);
  const position = fallback.aExit - 1.5, real = { ...fallback, id: 'tp_real', method: 'echo_out' as const, aExit: fallback.aExit + 0.6 };
  const commands: any[] = [];
  let host: DesktopPlayback;
  const audio = { process: {}, start: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })),
    feedFile: vi.fn(async () => {}), stop: vi.fn(async () => {}), command: vi.fn(async (v: any) => {
      commands.push(v);
      if (v.cmd === 'start') queueMicrotask(() => host.onEvent({ type: 'tick', clock: 0, paused: false, main: v.deck,
        decks: [0, 1].map(deck => ({ token: deck === v.deck ? v.token : null, playing: deck === v.deck,
          position: v.frame, totalFrames: 960000, starved: false, ratio: 1, bufferedAhead: 960000 })), transition: null, limiterDb: 0, peak: 0 }));
    }) };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (pathname === '/internal/desktop/pcm-source') return Response.json({ path: 'private', finalPath: 'private', partPath: '',
      format: 'f32le', gainDb: -6, totalFrames: 960000, availableFrames: 960000, complete: true,
      track: { trackId: body.trackId, title: body.trackId, artist: '', duration: 20, coverUrl: '', mixingAllowed: true } });
    if (pathname === '/api/settings') return Response.json({ automix: settings });
    if (pathname === '/api/automix/plan') return Response.json({ plan: real, pending: [] });
    return Response.json({});
  };
  host = new DesktopPlayback(audio, { backend: () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: 'secret' }),
    ready: vi.fn(), track: vi.fn(), fetch: fetcher as typeof fetch });
  try {
    await host.startSource({ trackId: 'a', entryId: 'entry-a' }, { sampleRate: 48000, position });
    await host.prepareQueue(1, [{ trackId: 'b', entryId: 'entry-b' }], 'a');
    await vi.waitFor(() => expect(commands.some(c => c.cmd === 'arm')).toBe(true));
    expect(commands.filter(c => c.cmd === 'arm').map(c => c.transition.planId)).toEqual(['tp_real']);
    expect(host.state().nextTrack?.plan?.method).toBe('echo_out');
  } finally { await host.stop(); }
});

it('keeps feeding the audible track when seeking after the swap of a running transition', async () => {
  const files: any[] = [];
  let host: DesktopPlayback;
  const audio = { process: {}, start: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })),
    feedFile: vi.fn(async (v: any) => { files.push(v); }), stop: vi.fn(async () => {}), command: vi.fn(async (v: any) => {
      if (v.cmd === 'start') queueMicrotask(() => host.onEvent({ type: 'tick', clock: 0, paused: false, main: v.deck,
        decks: [0, 1].map(deck => ({ token: deck === v.deck ? v.token : null, playing: deck === v.deck,
          position: v.frame, totalFrames: 960000, starved: false, ratio: 1, bufferedAhead: 960000 })), transition: null, limiterDb: 0, peak: 0 }));
    }) };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const pathname = new URL(String(url)).pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (pathname === '/internal/desktop/pcm-source') return Response.json({ path: 'private', finalPath: 'private', partPath: '',
      format: 'f32le', totalFrames: 960000, availableFrames: 960000, complete: true,
      track: { trackId: body.trackId, title: body.trackId, artist: '', duration: 20, coverUrl: '', mixingAllowed: true } });
    if (pathname === '/api/settings') return Response.json({ automix: DEFAULT_AUTOMIX_SETTINGS });
    return Response.json({ error: 'not ready' }, { status: 503 });
  };
  host = new DesktopPlayback(audio, { backend: () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: 'secret' }),
    ready: vi.fn(), track: vi.fn(), fetch: fetcher as typeof fetch });
  try {
    await host.startSource({ trackId: 'a', entryId: 'entry-a' }, { sampleRate: 48000, position: 0 });
    await host.prepareQueue(1, [{ trackId: 'b', entryId: 'entry-b' }, { trackId: 'c', entryId: 'entry-c' }], 'a');
    await vi.waitFor(() => expect(host.state().nextTrack?.entryId).toBe('entry-b'));
    const b = host.state().nextTrack!, token = audio.command.mock.calls.map(([c]: any) => c).findLast((c: any) => c.cmd === 'arm').transition.toToken;
    host.onEvent({ type: 'swap', planId: b.plan!.id, token } as any);
    expect(host.state().entryId).toBe('entry-b');
    await host.command('seekto', 10);
    expect(audio.command).toHaveBeenCalledWith({ cmd: 'seek', token, frame: 10 * 48000 });
    expect(host.state()).toMatchObject({ entryId: 'entry-b', position: 10, blend: null });
    files.length = 0;
    host.onEvent({ type: 'need', deck: 1, token, chunks: [20] } as any);
    await vi.waitFor(() => expect(files.some(f => f.token === token && f.chunk === 20)).toBe(true));
  } finally { await host.stop(); }
});

it('follows confirmed tokens and serializes rapid skips without exposing file commands to the page', async () => {
  const commands: any[] = [], files: any[] = [];
  const logs: any[] = [];
  let musical = false;
  let host: DesktopPlayback;
  const audio = { process: {} as unknown, start: vi.fn(async () => ({ sampleRate: 48000, queueFrames: 2048 })),
    feedFile: vi.fn(async (v: any) => { files.push(v); }), stop: vi.fn(async () => {}),
    command: vi.fn(async (v: any) => {
      commands.push(v);
      if (v.cmd === 'start') queueMicrotask(() => host.onEvent({ type: 'tick', clock: 0, paused: false, main: v.deck,
        decks: [0, 1].map(deck => ({ token: deck === v.deck ? v.token : null, playing: deck === v.deck,
          position: v.frame, totalFrames: 960000, starved: false, ratio: 1, bufferedAhead: 960000 })),
        transition: null, limiterDb: 0, peak: 0 }));
    }) };
  const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/internal/desktop/pcm-source') {
      const body = JSON.parse(String(init?.body));
      return Response.json({ sourceId: body.trackId, path: `private-${body.trackId}`, finalPath: `private-${body.trackId}`, partPath: '',
        format: 'f32le', gainDb: -6, totalFrames: 960000, availableFrames: 960000, complete: true,
        track: { trackId: body.trackId, title: body.trackId, artist: '', duration: 20, coverUrl: '', mixingAllowed: true } });
    }
    if (path === '/api/settings') return Response.json({ automix: DEFAULT_AUTOMIX_SETTINGS });
    if (path === '/api/automix/log') { logs.push(JSON.parse(String(init?.body))); return Response.json({ id: logs.length }); }
    if (path === '/api/automix/mix-now' && musical) {
      const body = JSON.parse(String(init?.body));
      return Response.json({ plan: planRequestedTransition({ id: body.from, duration: 20, mixingAllowed: true, analysis: null },
        { id: body.to, duration: 20, mixingAllowed: true, analysis: null }, body.position, DEFAULT_AUTOMIX_SETTINGS) });
    }
    return Response.json({ error: 'not ready' }, { status: 503 });
  });
  host = new DesktopPlayback(audio, { backend: () => ({ origin: 'http://127.0.0.1', accessToken: '', pcmToken: 'secret' }),
    ready: vi.fn(), track: vi.fn(), fetch: fakeFetch as typeof fetch });
  const entry = (id: string) => ({ trackId: id, entryId: `entry-${id}` });
  await host.startSource(entry('a'), { sampleRate: 48000, position: 7 });
  expect(host.state()).toMatchObject({ entryId: 'entry-a', position: 7, sampleRate: 48000 });
  await host.prepareQueue(1, [entry('b'), entry('c')], 'a');
  await vi.waitFor(() => expect(commands.some(c => c.cmd === 'arm')).toBe(true));
  expect(host.state().currentTrack?.gainDb).toBe(-6);
  expect(host.state().nextTrack?.plan?.gainA).toBe(-6);
  expect(commands.filter(c => c.cmd === 'gain' && c.deck === 0)).toHaveLength(0);
  await Promise.all([host.command('nexttrack'), host.command('nexttrack')]);
  expect(host.state().entryId).toBe('entry-c');
  expect(files.every(f => f.cmd === 'feedFile' && f.path.startsWith('private-'))).toBe(true);
  await host.prepareQueue(3, [entry('d')], 'c');
  await vi.waitFor(() => expect(host.state().nextTrack?.entryId).toBe('entry-d'));
  musical = true;
  await host.command('nexttrack');
  expect(host.state().entryId).toBe('entry-c');
  expect(commands.findLast(c => c.cmd === 'arm').transition.triggerFrame).toBeLessThan(48000);
  await host.command('nexttrack');
  expect(host.state().entryId).toBe('entry-d');
  // A producer records completion even when no page callback observes the transition.
  await host.prepareQueue(4, [entry('e')], 'd');
  await vi.waitFor(() => expect(host.state().nextTrack?.entryId).toBe('entry-e'));
  const arm = commands.findLast(c => c.cmd === 'arm').transition;
  host.onEvent({ type: 'transitionEnd', planId: arm.planId, token: arm.toToken, forced: false });
  await vi.waitFor(() => expect(host.state().lastTransition?.logId).toBe(logs.length));
  expect(logs.at(-1).plan).toMatchObject({ fromTrackId: 'd', toTrackId: 'e', gainA: -6 });
  expect(logs.some(row => row.outcome.manual && row.plan.method === 'skip_fade')).toBe(true);
  await host.stop();
});
