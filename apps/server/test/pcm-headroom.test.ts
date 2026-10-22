import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/app.ts';
import { FfmpegTools } from '../src/ffmpeg.ts';
import { PcmCache } from '../src/pcmCache.ts';

describe('playback decoder headroom', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-headroom-'));
  let app: Awaited<ReturnType<typeof createApp>>;
  let id: string;
  const source = path.join(dir, 'hot.wav');
  beforeAll(async () => {
    // Floating WAV is intentionally clean above full scale, not a clipped sine.
    const sr = 44100, frames = sr;
    const wav = Buffer.alloc(44 + frames * 8);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22);
    wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 8, 28);
    wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 8, 40);
    for (let i = 0; i < frames; i++) {
      const v = 1.25 * Math.sin(2 * Math.PI * 997 * i / sr);
      wav.writeFloatLE(v, 44 + i * 8); wav.writeFloatLE(-v, 48 + i * 8);
    }
    fs.writeFileSync(source, wav);
    app = await createApp({ dataDir: path.join(dir, 'data'), analysisWorkers: 1, stemsPython: null, port: 0 });
    const imported = await app.app.inject({ method: 'POST', url: '/api/import/upload?name=hot.wav',
      headers: { 'content-type': 'application/octet-stream' }, payload: wav });
    expect(imported.statusCode, imported.body).toBe(200);
    id = imported.json().trackId;
  });
  afterAll(async () => { await app?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('preserves overs through API and resampling, including exact seeks; retains legacy s16 compatibility', async () => {
    for (const sr of [44100, 48000]) {
      const start = 1000, frames = 4096;
      const float = await app.app.inject(`/api/tracks/${id}/pcm?sr=${sr}&start=${start}&frames=${frames}&format=f32le`);
      expect(float.statusCode, float.body.slice(0, 80)).toBe(200);
      expect(float.headers['x-pcm-format']).toBe('f32le');
      expect(float.rawPayload.length).toBe(frames * 8);
      const reference = execFileSync('ffmpeg', ['-v', 'error', '-i', source, '-ac', '2', '-ar', String(sr), '-f', 'f32le', 'pipe:1'], { windowsHide: true });
      expect(float.rawPayload.equals(reference.subarray(start * 8, (start + frames) * 8))).toBe(true);
      let peak = 0;
      for (let i = 0; i < float.rawPayload.length; i += 4) peak = Math.max(peak, Math.abs(float.rawPayload.readFloatLE(i)));
      expect(peak).toBeGreaterThan(1.24);
      const legacy = await app.app.inject(`/api/tracks/${id}/pcm?sr=${sr}&start=${start}&frames=${frames}`);
      expect(legacy.headers['x-pcm-format']).toBe('s16le');
      expect(legacy.rawPayload.length).toBe(frames * 4);
      expect(legacy.rawPayload.includes(Buffer.from([255, 127]))).toBe(true);
    }
    expect((await app.app.inject(`/api/tracks/${id}/pcm?sr=44100&format=bad`)).statusCode).toBe(400);
  });

  it('never reuses clipped legacy cache and reloads persisted float cache with correct frame counts', async () => {
    // Use the active configuration's values without touching the real library.
    const { loadConfig } = await import('../src/config.ts');
    const config = loadConfig({ dataDir: path.join(dir, 'isolated'), stemsPython: null });
    const cacheDir = path.join(config.dataDir, 'cache', 'pcm'); fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'hot_44100.s16'), Buffer.alloc(400));
    const ff = new FfmpegTools(config.ffmpeg, config.ffprobe);
    const cache = new PcmCache(config, ff);
    try {
      const e = cache.open('hot', 44100, async () => source, 1);
      const data = await cache.read(e, 0, 44101);
      expect(data.totalFrames).toBe(44100);
      expect(data.data.length).toBe(44100 * 8);
      expect(data.data.readFloatLE(8 * 10)).toBeGreaterThan(1);
    } finally { cache.shutdown(); }
    const reopened = new PcmCache(config, ff);
    try {
      const e = reopened.open('hot', 44100, async () => { throw new Error('must reuse float'); }, 99);
      expect(e.estimatedFrames).toBe(44100);
      expect((await reopened.read(e, 44000, 1000)).data.length).toBe(100 * 8);
    } finally { reopened.shutdown(); }
  });

  it('joins concurrent requests before the source resolves instead of decoding twice', async () => {
    const cfg = loadConfig({ dataDir: path.join(dir, 'single-flight'), stemsPython: null });
    const ff = new FfmpegTools(cfg.ffmpeg, cfg.ffprobe), decode = vi.spyOn(ff, 'decode');
    const cache = new PcmCache(cfg, ff);
    let release!: (value: string) => void;
    const input = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    try {
      const first = cache.open('shared', 44100, input, 1);
      const second = cache.open('shared', 44100, input, 1);
      expect(first).toBe(second); expect(input).toHaveBeenCalledOnce();
      const read = cache.read(first, 0, 44101);
      release(source);
      expect((await read).data.length).toBe(44100 * 8);
      expect(decode).toHaveBeenCalledOnce();
    } finally { cache.shutdown(); }
  });

  it('does not launch abandoned input after clear and keeps a replacement generation readable', async () => {
    const cfg = loadConfig({ dataDir: path.join(dir, 'cancel-opening'), stemsPython: null });
    const ff = new FfmpegTools(cfg.ffmpeg, cfg.ffprobe), decode = vi.spyOn(ff, 'decode');
    const cache = new PcmCache(cfg, ff);
    let release!: (value: string) => void;
    try {
      const old = cache.open('replace', 44100, () => new Promise(resolve => { release = resolve; }), 1);
      await cache.clear();
      const replacement = cache.open('replace', 44100, async () => source, 1);
      release(source);
      expect(replacement.part).not.toBe(old.part);
      expect((await cache.read(replacement, 0, 44101)).data.length).toBe(44100 * 8);
      expect(decode).toHaveBeenCalledOnce();
      expect(cache.status('replace', 44100)?.error).toBeNull();
    } finally { cache.shutdown(); }
  });

  it('serializes eviction and protects pinned playback during manual cache clearing', async () => {
    const cfg = loadConfig({ dataDir: path.join(dir, 'protected-clear'), pcmCacheBytes: 16 });
    const folder = path.join(cfg.dataDir, 'cache/pcm'); fs.mkdirSync(folder, { recursive: true });
    for (const key of ['playing', 'cold']) fs.writeFileSync(path.join(folder, `${key}_44100.f32`), Buffer.alloc(80));
    const cache = new PcmCache(cfg, new FfmpegTools(cfg.ffmpeg, cfg.ffprobe));
    try {
      cache.pin('playing', 44100);
      const first = cache.evict(), second = cache.evict();
      expect(first).toBe(second); await first;
      await cache.clear();
      expect(fs.existsSync(path.join(folder, 'cold_44100.f32'))).toBe(false);
      const playing = cache.open('playing', 44100, async () => { throw new Error('playing audio must survive'); }, 1);
      expect((await cache.read(playing, 0, 10)).data.length).toBe(80);
    } finally { cache.shutdown(); }
  });

  it('releases obsolete queue pins after a short grace period, retaining current and next as active reserve', async () => {
    const cfg = loadConfig({ dataDir: path.join(dir, 'queue-budget'), pcmCacheBytes: 100 });
    const folder = path.join(cfg.dataDir, 'cache/pcm'); fs.mkdirSync(folder, { recursive: true });
    for (const key of ['old', 'current', 'next']) fs.writeFileSync(path.join(folder, `${key}_48000.f32`), Buffer.alloc(80));
    const cache = new PcmCache(cfg, new FfmpegTools(cfg.ffmpeg, cfg.ffprobe));
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      for (const key of ['old', 'current', 'next']) cache.pin(key, 48000);
      cache.focus(new Set(['current', 'next']));
      await cache.evict(); expect(cache.totalBytes()).toBe(240);
      now.mockReturnValue(131_000);
      await cache.evict(); expect(cache.totalBytes()).toBe(160);
      expect(cache.totalBytes()).toBeGreaterThan(cfg.pcmCacheBytes);
      expect(fs.existsSync(path.join(folder, 'old_48000.f32'))).toBe(false);
      expect(fs.existsSync(path.join(folder, 'current_48000.f32'))).toBe(true);
      expect(fs.existsSync(path.join(folder, 'next_48000.f32'))).toBe(true);
    } finally { now.mockRestore(); cache.shutdown(); }
  });

  it('keeps focused current and next beyond the prepare timeout, then grants a grace period when focus moves', async () => {
    const cfg = loadConfig({ dataDir: path.join(dir, 'focus-lifetime'), pcmCacheBytes: 16 });
    const folder = path.join(cfg.dataDir, 'cache/pcm'); fs.mkdirSync(folder, { recursive: true });
    for (const key of ['current', 'next', 'cold']) fs.writeFileSync(path.join(folder, `${key}_48000.f32`), Buffer.alloc(80));
    const cache = new PcmCache(cfg, new FfmpegTools(cfg.ffmpeg, cfg.ffprobe));
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      cache.focus(new Set(['current', 'next']));
      now.mockReturnValue(11 * 60_000);
      await cache.evict();
      expect(fs.existsSync(path.join(folder, 'current_48000.f32'))).toBe(true);
      expect(fs.existsSync(path.join(folder, 'next_48000.f32'))).toBe(true);
      expect(fs.existsSync(path.join(folder, 'cold_48000.f32'))).toBe(false);

      cache.focus(new Set());
      now.mockReturnValue(11 * 60_000 + 30_001);
      await cache.evict();
      expect(fs.existsSync(path.join(folder, 'current_48000.f32'))).toBe(false);
      expect(fs.existsSync(path.join(folder, 'next_48000.f32'))).toBe(false);
    } finally { now.mockRestore(); cache.shutdown(); }
  });
});
