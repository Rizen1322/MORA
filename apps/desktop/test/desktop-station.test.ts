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
  return { host, requests, fetcher };
}

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
