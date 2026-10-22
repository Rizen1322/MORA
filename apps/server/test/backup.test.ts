import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { kvSet, q } from '../src/db.ts';

describe('playlist backup and restore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-backup-'));
  let a: Awaited<ReturnType<typeof createApp>>;
  let backup: any;
  beforeAll(async () => { a = await createApp({ dataDir: dir, port: 0, stemsPython: null, accessToken: null }, { startWorkers: false }); });
  afterAll(async () => { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (url: string, payload: object) => a.app.inject({ method: 'POST', url, payload });

  it('exports order and intentional repeats, with no credentials or file paths', async () => {
    const t = a.services.lib.addRemote({ provider: 'youtube', externalId: 'BackupTest1', title: 'Song', artist: 'Artist', duration: 180, meta: { token: 'DO-NOT-EXPORT', pageUrl: 'https://example.invalid/?token=DO-NOT-EXPORT' } });
    kvSet(a.services.db, 'secret.fixture', 'DO-NOT-EXPORT');
    await post('/api/playlists', { name: 'Вечер', trackIds: [t.id, t.id] });
    const r = await a.app.inject('/api/backup/playlists');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain('DO-NOT-EXPORT'); expect(r.body).not.toContain(dir.replaceAll('\\', '\\\\'));
    backup = r.json();
    expect(backup.tracks).toHaveLength(1); expect(backup.playlists[0].tracks).toEqual([t.id, t.id]);
    expect(backup.tracks[0].source).toEqual({ provider: 'youtube', externalId: 'BackupTest1' });
  });

  it('restores separate copies once, preserves repeats and never changes the original playlist', async () => {
    const original = backup.playlists[0].key;
    const first = await post('/api/backup/playlists/restore', backup);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ playlists: 1, tracks: 1, missingFiles: 0 });
    const second = await post('/api/backup/playlists/restore', backup);
    expect(second.statusCode, second.body).toBe(200);
    const list = (await a.app.inject('/api/playlists')).json().playlists;
    expect(list).toHaveLength(2); expect(list.every((p: { count: number }) => p.count === 2)).toBe(true);
    expect(q(a.services.db, 'SELECT name FROM playlists WHERE id = ?').get(original)).toEqual(expect.objectContaining({ name: 'Вечер' }));
  });

  it('keeps missing local files in their places and rejects malformed backups before writing anything', async () => {
    const local = { format: 'mora-playlists', version: 1, origin: 'another-profile', createdAt: '', tracks: [{ key: 'missing', hash: 'a'.repeat(64), title: 'Own file', artist: '', album: '', duration: 200 }], playlists: [{ key: 'list', name: 'Своё', description: '', tracks: ['missing','missing'] }] };
    expect((await post('/api/backup/playlists/restore', local)).json()).toEqual({ playlists: 1, tracks: 1, missingFiles: 1 });
    const before = (await a.app.inject('/api/playlists')).json().playlists.length;
    const invalid = structuredClone(local); invalid.playlists.push({ key: 'bad', name: '', description: '', tracks: ['not-in-tracks'] });
    expect((await post('/api/backup/playlists/restore', invalid)).statusCode).toBe(400);
    expect((await a.app.inject('/api/playlists')).json().playlists).toHaveLength(before);
  });
});
