import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { kvGet, kvSet, q } from '../src/db.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-library-backup-'));
let app: Awaited<ReturnType<typeof createApp>>;
afterAll(async () => { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
it('round trips settings, reactions and history without credentials, and restores idempotently', async () => {
  app = await createApp({ dataDir: dir, port: 0, stemsPython: null, accessToken: null }, { startWorkers: false });
  const { db, lib } = app.services;
  const t = lib.addRemote({ provider: 'youtube', externalId: 'BackupFull1', title: 'Трек', artist: 'Артист', duration: 180, meta: { token: 'SECRET' } });
  kvSet(db, 'secret.fixture', 'SECRET');
  kvSet(db, 'settings', { version: 2, automix: { enabled: false, token: 'SECRET' }, wave: { mood: 'calm' } });
  q(db, 'INSERT INTO reactions(track_id,value,updated_at) VALUES(?,1,100)').run(t.id);
  q(db, 'INSERT INTO smart_playlists(id,name,rules,created_at) VALUES(?,?,?,1)').run('smart-original', 'Любимое', JSON.stringify({ liked: true }));
  q(db, 'INSERT INTO plays(track_id,started_at,ended_at,played_ms,duration_ms,end_reason) VALUES(?,1,100,99000,180000,?)').run(t.id, 'stop');
  const backup = await app.app.inject('/api/backup/playlists?library=1');
  expect(backup.statusCode, backup.body).toBe(200);
  expect(backup.body).not.toContain('SECRET');
  expect(backup.json().library.history).toHaveLength(1);
  expect(backup.json().tracks).toHaveLength(1);
  q(db, 'DELETE FROM reactions').run(); q(db, 'DELETE FROM plays').run();
  const restore = () => app.app.inject({ method: 'POST', url: '/api/backup/playlists/restore', payload: backup.json() });
  const settingsChanged: string[] = [];
  const off = app.services.events.on(event => { if (event.type === 'settings') settingsChanged.push(event.type); });
  expect((await restore()).statusCode).toBe(200);
  expect((await restore()).statusCode).toBe(200);
  off();
  expect(settingsChanged).toHaveLength(2);
  expect(q(db, 'SELECT value FROM reactions WHERE track_id=?').get(t.id)).toMatchObject({ value: 1 });
  expect(q(db, 'SELECT COUNT(*) AS n FROM plays').get()).toMatchObject({ n: 1 });
  expect(q(db, 'SELECT COUNT(*) AS n FROM smart_playlists').get()).toMatchObject({ n: 2 });
  const invalid = backup.json(); invalid.library.history[0].trackId = 'absent';
  expect((await app.app.inject({ method: 'POST', url: '/api/backup/playlists/restore', payload: invalid })).statusCode).toBe(400);
});

it('restores an exported library with over 50000 plays and a backup larger than 16 MiB', async () => {
  const largeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-large-backup-'));
  const largeApp = await createApp({ dataDir: largeDir, port: 0, stemsPython: null, accessToken: null }, { startWorkers: false });
  try {
    const { db } = largeApp.services;
    kvSet(db, 'settings', { version: 2, automix: { enabled: false } });
    const track = q(db, 'INSERT INTO tracks(id,content_hash,title,artist,album,duration,added_at,updated_at) VALUES(?,?,?,?,?,1,1,1)');
    const play = q(db, 'INSERT INTO plays(track_id,started_at,played_ms) VALUES(?,1,0)');
    db.exec('BEGIN');
    for (let i = 0; i < 10000; i++) track.run(`large-${i}`, i.toString(16).padStart(64, '0'), 'a'.repeat(500), 'b'.repeat(500), 'c'.repeat(500));
    for (let i = 0; i < 50001; i++) play.run('large-0');
    db.exec('COMMIT');
    const exported = await largeApp.app.inject('/api/backup/playlists?library=1');
    expect(exported.statusCode).toBe(200);
    expect(Buffer.byteLength(exported.body)).toBeGreaterThan(16 * 1024 * 1024);
    const expectedHistory = (q(db, 'SELECT COUNT(*) AS n FROM plays').get() as { n: number }).n;
    q(db, 'DELETE FROM plays').run();
    kvSet(db, 'settings', {});
    const restored = await largeApp.app.inject({ method: 'POST', url: '/api/backup/playlists/restore', headers: { 'content-type': 'application/json' }, payload: exported.body });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(q(db, 'SELECT COUNT(*) AS n FROM plays').get()).toMatchObject({ n: expectedHistory });
    expect(kvGet<{ automix: { enabled: boolean } }>(db, 'settings', { automix: { enabled: true } }).automix.enabled).toBe(false);
  } finally { await largeApp.close(); fs.rmSync(largeDir, { recursive: true, force: true }); }
}, 60000);
