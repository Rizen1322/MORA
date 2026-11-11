import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { q } from '../src/db.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-smart-'));
let app: Awaited<ReturnType<typeof createApp>>;
afterAll(async () => { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
it('evaluates saved smart rules and merges duplicate identities without deleting linked originals', async () => {
  app = await createApp({ dataDir: dir, port: 0, accessToken: null, stemsPython: null }, { startWorkers: false });
  const { db, lib } = app.services;
  const a = lib.addRemote({ provider: 'youtube', externalId: 'Duplicate01', title: 'Первый', artist: 'Артист', duration: 180, meta: {} });
  const b = lib.addRemote({ provider: 'youtube', externalId: 'Duplicate02', title: 'Второй', artist: 'Артист', duration: 180, meta: {} });
  const owned = path.join(dir, 'library'); fs.mkdirSync(owned, { recursive: true });
  const first = path.join(owned, 'first.wav'), second = path.join(owned, 'second.wav'), linked = path.join(dir, 'original.wav');
  for (const file of [first, second, linked]) fs.writeFileSync(file, 'same audio');
  for (const [id, count, file] of [[a.id, 2, first], [b.id, 5, second]] as const) {
    q(db, 'UPDATE tracks SET content_hash=?,provider=?,play_count=?,genre=?,year=2000 WHERE id=?').run('a'.repeat(64), 'local', count, 'Джаз', id);
    q(db, 'INSERT INTO track_sources(track_id,provider,kind,path) VALUES(?,?,?,?)').run(id, 'local', 'managed', file);
  }
  q(db, 'INSERT INTO track_sources(track_id,provider,kind,path) VALUES(?,?,?,?)').run(a.id, 'local', 'linked', linked);
  q(db, 'INSERT INTO reactions(track_id,value,updated_at) VALUES(?,1,100)').run(a.id);
  for (const id of [a.id, b.id]) q(db, 'INSERT INTO plays(track_id,started_at,played_ms) VALUES(?,?,60000)').run(id, Date.now());
  const post = (url: string, payload: object) => app.app.inject({ method: 'POST', url, payload });
  const playlist = (await post('/api/playlists', { name: 'Список', trackIds: [a.id, b.id, a.id] })).json();
  const smart = (await post('/api/smart-playlists', { name: 'Любимый джаз', rules: { genre: 'джаз', liked: true, minPlays: 2 } })).json();
  expect((await app.app.inject('/api/smart-playlists/' + smart.id)).json().tracks).toEqual([a.id]);
  const response = await post('/api/library/duplicates/merge', { hash: 'a'.repeat(64) });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().keep).toBe(b.id);
  expect(lib.get(a.id)).toBeNull();
  expect(lib.get(b.id)?.play_count).toBe(7);
  expect(lib.trackDTO(b.id)?.reaction).toBe(1);
  expect((await app.app.inject('/api/playlists/' + playlist.id)).json().entries.map((row: any) => row.trackId)).toEqual([b.id, b.id, b.id]);
  expect(fs.existsSync(first)).toBe(false); expect(fs.existsSync(second)).toBe(true); expect(fs.existsSync(linked)).toBe(true);
  expect((await app.app.inject('/api/library/statistics')).json()).toMatchObject({ plays: 2, playedMs: 120000, longestStreak: 1, topTracks: [{ id: b.id, plays: 2 }] });
  expect((await post('/api/library/duplicates/merge', { hash: 'a'.repeat(64) })).statusCode).toBe(409);
  const patch = await app.app.inject({ method: 'PATCH', url: '/api/tracks/' + b.id, payload: { albumArtist: 'Группа', year: 2001 } });
  expect(patch.statusCode).toBe(200);
  expect(lib.get(b.id)).toMatchObject({ album_artist: 'Группа', year: 2001 });
  expect((await app.app.inject({ method: 'PATCH', url: '/api/tracks/' + b.id, payload: { year: -1 } })).statusCode).toBe(400);
});
