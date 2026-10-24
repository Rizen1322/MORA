import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { growingAudioInput } from '../src/public/growing-audio.ts';
import type { PublicTrack } from '../src/public/provider.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const fn of cleanup.splice(0).reverse()) await fn(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };

describe('progressive audio through the single PCM engine', () => {
  it.each(['wav', 'webm'])('delivers %s PCM before download completion and keeps the same timeline after hashing', async (extension) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-progressive-'));
    const cfg = loadConfig(); const original = path.join(dir, `fixture.${extension}`);
    execFileSync(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000', '-ac', '2', original], { windowsHide: true });
    const bytes = fs.readFileSync(original), half = Math.floor(bytes.length / 2);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 })); // Artwork must not use the network.
    const a = await createApp({ dataDir: path.join(dir, 'data'), accessToken: null, stemsPython: null }, { startWorkers: false });
    const finish = deferred();
    cleanup.push(async () => { finish.resolve(); await a.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    let downloads = 0;
    a.services.publicMusic.ytdlp.download = async (_url, staging) => {
      downloads++; await fsp.mkdir(staging, { recursive: true }); const file = path.join(staging, `track.${extension}`);
      await fsp.writeFile(file, bytes.subarray(0, half)); await finish.promise;
      await fsp.appendFile(file, bytes.subarray(half));
      return { file, info: { title: 'Fixture', ext: 'wav' } };
    };
    const hint: PublicTrack = { externalId: 'Progressiv1', audioProvider: 'youtube', source: 'ytmusic', kind: 'song', explicit: false, uploader: 'Fixture', labels: [], artistId: null, albumId: null, title: 'Fixture', artist: 'Fixture', album: '', duration: 8, coverUrl: null, pageUrl: null, license: null, playable: true };
    // A real search stores this exact server-side hint before the playback request.
    (a.services.publicMusic as any).seen.set('youtube:Progressiv1', hint);
    const prepared = await a.app.inject({ method: 'POST', url: '/api/public/prepare', payload: { provider: 'youtube', externalId: hint.externalId, progressive: true } });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const id = prepared.json().trackId;
    const first = await a.app.inject(`/api/tracks/${id}/pcm?sr=48000&start=0&frames=4096&format=f32le`);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.rawPayload.length).toBe(4096 * 8);
    expect(first.headers['x-complete']).toBe('0');
    const reference = execFileSync(cfg.ffmpeg, ['-v', 'error', '-i', original, '-ac', '2', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { windowsHide: true, maxBuffer: 8 << 20 });
    expect(first.rawPayload.equals(reference.subarray(0, 4096 * 8))).toBe(true);
    const keyBefore = a.services.publicMusic.pcmKey(id, a.services.lib.get(id)!.content_hash);
    const readers = [a.services.lib.resolveMediaPath(id), a.services.lib.resolveMediaPath(id)];
    finish.resolve(); await Promise.all(readers);
    expect(downloads).toBe(1);
    expect(a.services.lib.get(id)!.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.services.publicMusic.pcmKey(id, a.services.lib.get(id)!.content_hash)).toBe(keyBefore);
    const repeated = await a.app.inject(`/api/tracks/${id}/pcm?sr=48000&start=0&frames=4096&format=f32le`);
    expect(repeated.rawPayload.equals(first.rawPayload)).toBe(true);
    const tail = await a.app.inject(`/api/tracks/${id}/pcm?sr=48000&start=380000&frames=4000&format=f32le`);
    expect(tail.statusCode, tail.body).toBe(200);
    expect(tail.rawPayload.length).toBeGreaterThan(0);
  });

  it('keeps reading after the finished download is moved out of staging (ADTS .aac streams too)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-moved-stream-'));
    cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    const staging = path.join(dir, 'staging'), staged = path.join(staging, 'track.aac'), published = path.join(dir, 'published.aac');
    await fsp.mkdir(staging);
    const bytes = Buffer.from(Array.from({ length: 600_000 }, (_, i) => i % 251));
    await fsp.writeFile(staged, bytes.subarray(0, 300_000));
    const finish = deferred();
    const state = { staging, done: false, error: null as Error | null, result: finish.promise.then(() => published) };
    const input = await growingAudioInput(state);
    if (typeof input === 'string') throw new Error('expected stream');
    const got: Buffer[] = [];
    const reading = (async () => { for await (const c of input) got.push(c as Buffer); })();
    await vi.waitFor(() => expect(got.reduce((n, c) => n + c.length, 0)).toBe(300_000));
    // the writer completes, publishes (moves) the file, then reports done
    await fsp.appendFile(staged, bytes.subarray(300_000));
    await fsp.rename(staged, published);
    state.done = true; finish.resolve();
    await reading;
    expect(Buffer.concat(got).equals(bytes)).toBe(true);
  });

  it('does not treat a broken transfer as a completed stream', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mora-broken-stream-'));
    cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    await fsp.writeFile(path.join(dir, 'audio.webm'), Buffer.alloc(32768, 1));
    const finish = deferred(); let failure: Error | null = null;
    const state = { staging: dir, done: false, error: null as Error | null, result: finish.promise.then(() => { throw failure; }) };
    state.result.catch(() => {});
    const input = await growingAudioInput(state);
    expect(typeof input).not.toBe('string');
    if (typeof input === 'string') throw new Error('expected stream');
    const iterator = input[Symbol.asyncIterator](); expect((await iterator.next()).value.length).toBe(32768);
    failure = new Error('transfer failed'); state.error = failure; state.done = true; finish.resolve();
    await expect(iterator.next()).rejects.toThrow('transfer failed');
  });
});
