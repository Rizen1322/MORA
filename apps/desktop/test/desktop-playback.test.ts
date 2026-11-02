import { DEFAULT_AUTOMIX_SETTINGS, planRequestedTransition } from '@automix/core';
import { expect, it, vi } from 'vitest';
import { DesktopPlayback } from '../src/desktop-playback.ts';

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
