import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { Services } from '../src/app.ts';
import { registerNativeStationRoutes } from '../src/routes/native-station.ts';

it('carries artist spacing over the native queue refill boundary including collaborations', async () => {
  const app = Fastify();
  const item = (id: string, artist: string) => ({ externalId: id, title: id, artist, playable: true, audioProvider: 'youtube' });
  const library = [{ id: 'queued', title: 'queued', artist: 'PHARAOH', reaction: 1, status: 'ok', addedAt: 1, playCount: 10, lastPlayedAt: null }];
  const prepareProgressive = vi.fn(async (_provider: string, id: string) => `local-${id}`);
  const services = { cfg: { desktopPlaybackToken: 'secret' }, db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
    lib: { listDTO: () => library, sources: () => [] }, publicMusic: { search: async () => [item('queued', 'PHARAOH')],
      radio: async () => [item('repeat', 'PHARAOH'), item('collab', 'Boulevard Depo, PHARAOH'), item('fresh', 'ROCKET')], prepareProgressive } } as unknown as Services;
  registerNativeStationRoutes(app, services);
  try {
    const response = await app.inject({ method: 'POST', url: '/internal/desktop/station-next', headers: { 'x-mora-desktop-token': 'secret' }, payload: { kind: 'online', currentId: 'queued', exclude: ['queued'], count: 2 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries[0].trackId).toBe('local-fresh');
  } finally { await app.close(); }
});

it('protects and validates station requests and carries Yandex attribution', async () => {
  const app = Fastify();
  const wave = vi.fn(async () => ({ sessionId: 'session', batchId: 'batch', items: [{ trackId: 'new', yandexId: '42:1' }, { trackId: 'queued', yandexId: '10:2' }] }));
  const services = { cfg: { desktopPlaybackToken: 'secret' }, db: { prepare: () => ({ get: () => undefined }) },
    lib: { listDTO: () => [], sources: (id: string) => id === 'queued' ? [{ provider: 'yandex', kind: 'remote', external_id: '10:2' }] : [] },
    providers: { yandex: { wave } } } as unknown as Services;
  registerNativeStationRoutes(app, services);
  const payload = { kind: 'yandex', exclude: ['queued'], yandexSessionId: 'previous', count: 2 };
  try {
    expect((await app.inject({ method: 'POST', url: '/internal/desktop/station-next', payload })).statusCode).toBe(403);
    const headers = { 'x-mora-desktop-token': 'secret' };
    expect((await app.inject({ method: 'POST', url: '/internal/desktop/station-next', headers, payload: { ...payload, count: 7 } })).statusCode).toBe(400);
    const response = await app.inject({ method: 'POST', url: '/internal/desktop/station-next', headers, payload });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ context: { type: 'yandex-wave' }, yandexSessionId: 'session', entries: [{ trackId: 'new', yandexId: '42:1', yandexSessionId: 'session', yandexBatchId: 'batch' }] });
    expect(wave).toHaveBeenCalledWith('previous', ['10:2'], expect.objectContaining({ exclude: ['10:2'] }));
    await app.inject({ method: 'POST', url: '/internal/desktop/station-next', headers, payload: { ...payload, count: 3 } });
    // One parallel round of full imports per refill.
    expect(wave).toHaveBeenLastCalledWith('previous', ['10:2'], expect.objectContaining({ count: 2 }));
  } finally { await app.close(); }
});

it('starts an explicit online seed and prepares only the requested selections', async () => {
  const app = Fastify();
  const item = (id: string) => ({ externalId: id, title: id, artist: id, playable: true, audioProvider: 'youtube' });
  const prepareProgressive = vi.fn(async (_provider: string, id: string) => `local-${id}`);
  const services = { cfg: { desktopPlaybackToken: 'secret' }, db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
    lib: { listDTO: () => [], sources: () => [] }, publicMusic: { search: async () => [item('seed')], radio: async () => Array.from({ length: 18 }, (_, i) => item(`other${i}`)), prepareProgressive } } as unknown as Services;
  registerNativeStationRoutes(app, services);
  try {
    const response = await app.inject({ method: 'POST', url: '/internal/desktop/station-next', headers: { 'x-mora-desktop-token': 'secret' }, payload: { kind: 'online', seed: { title: 'seed', artist: 'seed' }, exclude: [], count: 2 } });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries[0].trackId).toBe('local-seed');
    expect(prepareProgressive).toHaveBeenCalledTimes(2);
  } finally { await app.close(); }
});

it('rechecks committed local dislikes after a Yandex station request completes', async () => {
  const app = Fastify();
  let reaction = 0;
  const services = { cfg: { desktopPlaybackToken: 'secret' }, db: { prepare: () => ({ get: () => undefined }) },
    lib: { listDTO: () => [{ id: 'blocked', reaction }], sources: () => [] },
    providers: { yandex: { wave: async () => {
      reaction = -1;
      return { sessionId: 'session', batchId: 'batch', items: [{ trackId: 'blocked', yandexId: '42:1' }, { trackId: 'safe', yandexId: '43:1' }] };
    } } } } as unknown as Services;
  registerNativeStationRoutes(app, services);
  try {
    const response = await app.inject({ method: 'POST', url: '/internal/desktop/station-next', headers: { 'x-mora-desktop-token': 'secret' }, payload: { kind: 'yandex', exclude: [] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().entries.map((e: { trackId: string }) => e.trackId)).toEqual(['safe']);
  } finally { await app.close(); }
});
