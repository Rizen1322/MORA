import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { q } from '../src/db.ts';

describe('favorite import ordering', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-favorites-'));
  let a: Awaited<ReturnType<typeof createApp>>;
  beforeAll(async () => { a = await createApp({ dataDir: dir, port: 0, stemsPython: null, accessToken: null }, { startWorkers: false }); });
  afterAll(async () => { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const make = (id: string) => a.services.lib.addRemote({ provider: 'youtube', externalId: id, title: id, artist: '', duration: 180, meta: {} }).id;
  const post = (url: string, payload: object) => a.app.inject({ method: 'POST', url, payload });

  it('preserves newest-first order across already imported tracks without changing library dates', async () => {
    const ids = [make('NewestTest1'), make('MiddleTest1'), make('OldestTest1')];
    ids.forEach((id, i) => {
      q(a.services.db, 'UPDATE tracks SET added_at = ? WHERE id = ?').run(i + 1, id);
      q(a.services.db, 'INSERT INTO reactions(track_id, value, updated_at) VALUES (?, 1, ?)').run(id, i + 1);
    });
    expect((await post('/api/library/favorites/order', { trackIds: ids })).statusCode).toBe(200);
    const rows = (await a.app.inject('/api/library')).json().tracks;
    const sorted = rows.sort((x: any, y: any) => y.likedAt - x.likedAt);
    expect(sorted.map((t: any) => t.id)).toEqual(ids);
    expect(sorted.map((t: any) => t.addedAt)).toEqual([1, 2, 3]);
    expect((await post('/api/library/favorites/order', { trackIds: ids })).statusCode).toBe(200);
    expect(a.services.yandexReactions.stats().pending).toBe(0);
    await post(`/api/tracks/${ids[2]}/reaction`, { value: 0 });
    await post(`/api/tracks/${ids[2]}/reaction`, { value: 1 });
    const after = (await a.app.inject('/api/library')).json().tracks;
    expect(after.sort((x: any, y: any) => y.likedAt - x.likedAt)[0].id).toBe(ids[2]);
  });

  it('rejects invalid orders before changing any favorite', async () => {
    const id = make('UnlikedTest');
    const before = q(a.services.db, 'SELECT * FROM reactions ORDER BY track_id').all();
    for (const trackIds of [[id], ['missing'], ['missing', 'missing'], [], 'not-an-array']) {
      expect((await post('/api/library/favorites/order', { trackIds })).statusCode).toBe(400);
    }
    expect(q(a.services.db, 'SELECT * FROM reactions ORDER BY track_id').all()).toEqual(before);
  });
});
