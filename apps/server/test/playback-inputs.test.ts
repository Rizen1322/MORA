import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type { Services } from '../src/app.ts';
import { registerPlaybackRoutes } from '../src/routes/playback.ts';

function setup() {
  const all = vi.fn(() => []);
  const next = vi.fn(() => []);
  const services = { cfg: {}, db: { prepare: () => ({ get: () => undefined, all, run: () => ({ lastInsertRowid: 1 }) }) },
    wave: { next } } as unknown as Services;
  const app = Fastify();
  registerPlaybackRoutes(app, services);
  return { app, all, next };
}

it('clamps history limits instead of letting SQLite read the whole journal', async () => {
  const { app, all } = setup();
  try {
    await app.inject('/api/history?limit=-5');
    expect(all).toHaveBeenLastCalledWith(1);
    await app.inject('/api/history?limit=9999');
    expect(all).toHaveBeenLastCalledWith(500);
    await app.inject('/api/history?limit=abc');
    expect(all).toHaveBeenLastCalledWith(100);
  } finally { await app.close(); }
});

it('rejects malformed wave parameters before recommending anything', async () => {
  const { app, next } = setup();
  try {
    for (const payload of [{ session: 'abc' }, { currentId: 42 }, { exclude: [1] }, { exclude: ['ok', ''] }, { count: 0 }, { count: 500 }, { mode: 'other' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/wave/next', payload });
      expect(response.statusCode).toBe(400);
    }
    expect(next).not.toHaveBeenCalled();
    const ok = await app.inject({ method: 'POST', url: '/api/wave/next', payload: { currentId: null, session: [], count: 4 } });
    expect(ok.statusCode).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  } finally { await app.close(); }
});
