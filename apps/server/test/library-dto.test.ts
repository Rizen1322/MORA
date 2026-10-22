import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-library-dto-'));
let a: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  a = await createApp({ dataDir: dir, stemsPython: null, accessToken: null, port: 0, analysisWorkers: 1 }, { startWorkers: false });
  const db = a.services.db;
  const track = db.prepare('INSERT INTO tracks(id, content_hash, title, provider, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  const source = db.prepare('INSERT INTO track_sources(track_id, provider, kind, external_id, meta) VALUES (?, ?, ?, ?, ?)');
  track.run('y1', 'a'.repeat(64), 'Yandex song', 'yandex', 1, 1);
  source.run('y1', 'yandex', 'remote', '12345:678', '{"pageUrl":"https://music.yandex.ru/track/12345"}');
  // A sync row for the same track under another album id must still be found.
  db.prepare("INSERT INTO yandex_reaction_sync(track_id, external_id, value, status, updated_at) VALUES (NULL, '12345:999', 1, 'synced', 5)").run();
  db.prepare("INSERT INTO yandex_reaction_sync(track_id, external_id, value, status, updated_at) VALUES (NULL, '123456', -1, 'synced', 9)").run();
  track.run('w1', 'w'.repeat(64), 'Wrapper', 'youtube', 2, 2);
  source.run('w1', 'youtube', 'remote', 'aaaaaaaaaaa', '{"pageUrl":"x","metadataSource":"ytmusic","uploader":"U"}');
  track.run('r1', 'r'.repeat(64), 'Recording', 'soundcloud', 3, 3);
  source.run('r1', 'soundcloud', 'remote', '42', '{"metadataSource":"soundcloud","uploader":"S"}');
  db.prepare('INSERT INTO track_bindings(track_id, asset_id, chosen_at) VALUES (?, ?, 1)').run('w1', 'r1');
  db.prepare('INSERT INTO reactions(track_id, value, updated_at) VALUES (?, 1, 7)').run('w1');
});
afterAll(async () => { await a?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

it('builds one track exactly as the full list does, without reading the whole list', () => {
  const list = a.services.lib.listDTO();
  for (const id of ['y1', 'w1', 'r1']) expect(a.services.lib.trackDTO(id)).toEqual(list.find((t) => t.id === id));
  expect(a.services.lib.trackDTO('y1')!.reaction).toBe(1);
  expect(a.services.lib.trackDTO('w1')).toMatchObject({ likedAt: 7, binding: { assetId: 'r1', origin: { uploader: 'S' } } });
});
