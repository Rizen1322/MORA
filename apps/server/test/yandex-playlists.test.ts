import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

it('imports a confirmed Yandex playlist in order, preserving repeats and unavailable slots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-yandex-playlists-'));
  const previous = process.env.YANDEX_API_BASE, paths: string[] = [];
  const fixture = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); paths.push(url.pathname);
    const json = (result: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result })); };
    if (req.headers.authorization !== 'OAuth playlist-test-token') { res.statusCode = 401; return json(null); }
    if (url.pathname === '/account/status') return json({ account: { uid: 42 } });
    if (url.pathname === '/users/42/playlists/list') return json([{ kind: 7, title: 'Вечер', trackCount: 3 }]);
    if (url.pathname === '/users/42/playlists/7') return json({ title: 'Вечер', trackCount: 3, tracks: [{ id: '107', albumId: '10' }, { id: '108', albumId: '10' }, { id: '107', albumId: '10' }] });
    if (url.pathname === '/tracks') return json([107, 108].map(id => ({ id, title: 'Трек ' + id, durationMs: 180000, available: id === 107, artists: [{ name: 'Артист' }], albums: [{ id: 10, title: 'Альбом' }] })));
    res.statusCode = 404; json(null);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  process.env.YANDEX_API_BASE = `http://127.0.0.1:${(fixture.address() as any).port}`;
  const app = await createApp({ dataDir: dir, port: 0, accessToken: null, stemsPython: null }, { startWorkers: false });
  try {
    await app.app.inject({ method: 'POST', url: '/api/providers/yandex/connect', payload: { secret: { token: 'playlist-test-token' } } });
    expect((await app.app.inject('/api/providers/yandex/playlists')).json().playlists).toEqual([{ kind: '7', name: 'Вечер', count: 3 }]);
    const imported = await app.app.inject({ method: 'POST', url: '/api/providers/yandex/playlists/7/import' });
    expect(imported.statusCode, imported.body).toBe(200);
    expect(imported.json().unavailable).toBe(1);
    const list = (await app.app.inject('/api/playlists/' + imported.json().id)).json();
    expect(list.entries).toHaveLength(3);
    expect(list.entries[0].trackId).toBe(list.entries[2].trackId);
    expect(app.services.lib.get(list.entries[1].trackId)?.status).toBe('missing');
    expect(paths.some(url => url.includes('download-info'))).toBe(false);
  } finally {
    await app.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    if (previous === undefined) delete process.env.YANDEX_API_BASE; else process.env.YANDEX_API_BASE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
