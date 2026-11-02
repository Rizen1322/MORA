import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerListeningPreparationRoutes } from '../src/routes/listening-preparation.ts';
import type { Services } from '../src/app.ts';

const persisted = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../src/db.ts', () => ({ kvGet: (_db: unknown, key: string, fallback: unknown) => persisted.get(key) ?? fallback, kvSet: (_db: unknown, key: string, value: unknown) => persisted.set(key, value) }));

it('preplans repeated playlist edges serially without decoding playlist PCM', async () => {
  persisted.clear();
  const app = Fastify(), preplan = vi.fn(async () => {});
  const s = {
    db: { prepare: () => ({ all: () => ['a', 'b', 'a'].map(track_id => ({ track_id })) }) },
    lib: { media: (id: string) => ({ id, status: 'ok', provider: 'local', content_hash: id }), mediaId: (id: string) => id,
      sources: () => [], mixingPolicy: new Map([['local', true]]) },
    providers: { caps: () => ({ playback: true }) }, publicMusic: { cachedAudioPath: () => '/cached' },
    analysis: { statusOf: () => ({ status: 'done' }), ensure: vi.fn() }, automix: { preplan },
    downloads: { list: () => [], add: ({ trackId }: { trackId: string }) => ({ id: trackId }), cancel: vi.fn() },
  } as unknown as Services;
  registerListeningPreparationRoutes(app, s);
  try {
    await app.inject({ method: 'POST', url: '/api/playlists/repeated/prepare-listening' });
    await vi.waitFor(() => expect(preplan).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(preplan.mock.calls).toEqual([['a', 'b'], ['b', 'a']]);
    expect((await app.inject('/api/playlists/repeated/prepare-listening')).json()).toMatchObject({ total: 2, ready: 2, plansReady: 2, plansTotal: 2, complete: true });
  } finally { await app.close(); persisted.clear(); }
});

it('reuses downloads, limits preparation analysis and cancels only jobs owned by this batch', async () => {
  const app = Fastify();
  const jobs = [{ id: 'shared', trackId: 'a', state: 'downloading' }];
  const ensure = vi.fn(), cancel = vi.fn();
  const tracks = ['a', 'b', 'c', 'missing'].map(id => ({ id, status: id === 'missing' ? 'missing' : 'ok', provider: 'youtube', content_hash: id }));
  const s = {
    db: { prepare: () => ({ all: () => ['a', 'a', 'b', 'c', 'missing'].map(track_id => ({ track_id })) }) },
    lib: { media: (id: string) => tracks.find(t => t.id === id), sources: () => [], mixingPolicy: new Map([['youtube', true]]) },
    providers: { caps: () => ({ playback: true }) },
    publicMusic: { cachedAudioPath: (id: string) => id === 'missing' ? null : '/cached' },
    analysis: { statusOf: () => ({ status: 'none' }), ensure },
    downloads: { list: () => [...jobs], cancel, add: ({ trackId }: { trackId: string }) => {
      const shared = jobs.find(j => j.trackId === trackId);
      if (shared) return shared;
      const j = { id: `owned-${trackId}`, trackId, state: 'queued' }; jobs.push(j); return j;
    } },
  } as unknown as Services;
  registerListeningPreparationRoutes(app, s);
  try {
    const started = await app.inject({ method: 'POST', url: '/api/playlists/p/prepare-listening' });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ total: 4, ready: 0, unavailable: 1, cancelled: false });
    expect(jobs).toHaveLength(3);
    expect(ensure).toHaveBeenCalledTimes(2);
    const stopped = await app.inject({ method: 'DELETE', url: '/api/playlists/p/prepare-listening' });
    expect(stopped.json().cancelled).toBe(true);
    expect(cancel.mock.calls).toEqual([['owned-b'], ['owned-c']]);
    expect((await app.inject({ method: 'POST', url: '/api/listening/readiness', payload: { trackIds: Array(41).fill('a') } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/listening/readiness', payload: { trackIds: ['missing', 'a'] } })).json().tracks.map((t: { state: string }) => t.state)).toEqual(['unavailable', 'ready']);
    const restarted = Fastify();
    registerListeningPreparationRoutes(restarted, s);
    try { expect((await restarted.inject('/api/playlists/p/prepare-listening')).json()).toMatchObject({ total: 4, cancelled: true }); }
    finally { await restarted.close(); }
  } finally { await app.close(); }
});
