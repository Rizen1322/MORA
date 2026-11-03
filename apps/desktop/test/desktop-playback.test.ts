import { DEFAULT_AUTOMIX_SETTINGS, planRequestedTransition, planTransition } from '@automix/core';
import { expect, it, vi } from 'vitest';
import { DesktopPlayback } from '../src/desktop-playback.ts';

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
