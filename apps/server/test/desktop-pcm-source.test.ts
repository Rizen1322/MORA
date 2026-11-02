import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Services } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { FfmpegTools } from '../src/ffmpeg.ts';
import { PcmCache } from '../src/pcmCache.ts';
import { registerPlaybackRoutes } from '../src/routes/playback.ts';

it('only returns native cache paths to the desktop capability holder', async () => {
  const app = Fastify();
  const source = { sourceId: 'key_48000', path: 'private.part', finalPath: 'private.f32', partPath: 'private.part',
    format: 'f32le', totalFrames: 100, availableFrames: 32, complete: false };
  const pcm = { open: vi.fn(() => ({})), pin: vi.fn(), nativeSource: vi.fn(async () => source) };
  const cfg = { desktopPlaybackToken: 'host-secret', accessToken: 'browser-secret' };
  const services = { cfg, pcm, lib: { media: () => ({ id: 'a', title: 'A', artist: 'Artist', provider: 'local', content_hash: 'hash', duration: 1 }), mixingPolicy: new Map([['local', true]]) },
    providers: { caps: () => ({ playback: true, caching: 'persistent' }) }, publicMusic: { pcmKey: () => 'key' },
    analysis: { prioritize: vi.fn(), get: () => null }, automix: {}, wave: {}, db: { prepare: () => ({ get: () => undefined }) } } as unknown as Services;
  registerPlaybackRoutes(app, services);
  const payload = { trackId: 'a', sampleRate: 48000, start: 0, frames: 32 };
  try {
    for (const headers of [{}, { 'x-mora-desktop-token': 'wrong' }, { cookie: 'token=host-secret' }, { authorization: 'Bearer browser-secret' }]) {
      const r = await app.inject({ method: 'POST', url: '/internal/desktop/pcm-source', headers, payload });
      expect(r.statusCode).toBe(403);
      expect(r.body).not.toContain('private');
    }
    const headers = { 'x-mora-desktop-token': 'host-secret' };
    const ok = await app.inject({ method: 'POST', url: '/internal/desktop/pcm-source', headers, payload });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject(source);
    expect(pcm.nativeSource).toHaveBeenCalledOnce();
    const invalid = await app.inject({ method: 'POST', url: '/internal/desktop/pcm-source', headers, payload: { ...payload, frames: 32769 } });
    expect(invalid.statusCode).toBe(400);
    cfg.desktopPlaybackToken = '';
    const disabled = await app.inject({ method: 'POST', url: '/internal/desktop/pcm-source', headers, payload });
    expect(disabled.statusCode).toBe(403);
  } finally { await app.close(); }
});

it('reports progressive and renamed cache files, format and decoder errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-native-source-'));
  const cfg = loadConfig({ dataDir: dir, pcmCacheFormat: 's16le' });
  const cache = new PcmCache(cfg, new FfmpegTools(cfg.ffmpeg, cfg.ffprobe));
  const part = path.join(dir, 'a.part'), file = path.join(dir, 'a.s16h');
  const entry = { key: 'a_48000', part, file, bytes: 8, done: false, error: null as string | null,
    estimatedFrames: 10, lastUse: 0, readers: 0, waiters: new Set<() => void>() };
  const source = () => cache.nativeSource(entry as unknown as ReturnType<PcmCache['open']>, 0, 2);
  try {
    fs.writeFileSync(part, Buffer.alloc(8));
    expect(await source()).toMatchObject({ path: part, partPath: part, finalPath: file, format: 's16h', availableFrames: 2, totalFrames: 10, complete: false });
    fs.renameSync(part, file); entry.done = true;
    expect(await source()).toMatchObject({ path: file, totalFrames: 2, complete: true });
    entry.error = 'decoder failed';
    await expect(source()).rejects.toThrow('decoder failed');
    expect(entry.readers).toBe(0);
  } finally { cache.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
