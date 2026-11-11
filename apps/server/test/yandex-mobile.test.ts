import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

it('keeps like dates and reuses wave metadata on iPhone without downloading audio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-yandex-mobile-'));
  const previous = process.env.YANDEX_API_BASE, paths: string[] = [];
  const fixture = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); paths.push(url.pathname);
    res.setHeader('content-type', 'application/json');
    const send = (result: unknown) => res.end(JSON.stringify({ result }));
    if (url.pathname === '/account/status') return send({ account: { uid: 42 } });
    if (url.pathname === '/users/42/likes/tracks') return send({ library: { tracks: [
      { id: '101', albumId: '10', timestamp: '2025-01-01T00:00:00Z' },
      { id: '102', albumId: '10', timestamp: '2026-01-01T00:00:00Z' },
    ] } });
    if (url.pathname === '/rotor/session/new') return send({ radioSessionId: 'fixture', sequence: [{ track: {
      id: 103, title: 'Mobile wave', durationMs: 180000, available: true,
      artists: [{ name: 'Artist' }], albums: [{ id: 10, title: 'Album' }],
    } }] });
    res.statusCode = 404; send(null);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  process.env.YANDEX_API_BASE = `http://127.0.0.1:${(fixture.address() as any).port}`;
  const app = await createApp({ dataDir: dir, port: 0, accessToken: null, stemsPython: null }, { startWorkers: false });
  try {
    await app.app.inject({ method: 'POST', url: '/api/providers/yandex/connect', payload: { secret: { token: 'fixture-token' } } });
    const provider = app.services.providers.yandex;
    expect((await provider.likeIds()).ids).toEqual(['102:10', '101:10']);
    provider.metadataOnlyImport = true;
    const wave = await provider.wave();
    expect(wave.items[0].trackId).toBeTruthy();
    expect(app.services.lib.get(wave.items[0].trackId!)?.title).toBe('Mobile wave');
    expect(paths).not.toContain('/tracks');
    expect(paths.some(p => p.includes('download-info'))).toBe(false);
  } finally {
    await app.close(); fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    if (previous === undefined) delete process.env.YANDEX_API_BASE; else process.env.YANDEX_API_BASE = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
