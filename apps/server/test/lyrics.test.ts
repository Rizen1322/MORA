import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findLyrics, parseWhisperLyrics } from '../src/lyrics.ts';
import { registerLyricsRoutes } from '../src/routes/lyrics.ts';
import type { Services } from '../src/app.ts';

vi.mock('../src/db.ts', () => ({ kvGet: () => 0, kvSet: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
const query = { title: 'Song', artist: 'Artist', duration: 180 };
const row = { trackName: 'Song', artistName: 'Artist', duration: 180, syncedLyrics: '[00:01.00]First line' };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe('local word-timed lyrics', () => {
  const transcript = { version: 'whisper-words-1', words: [
    { start: 1, end: 1.3, word: ' Hello' }, { start: 1.35, end: 1.7, word: ' world.' },
  ], lines: [{ start: 1, end: 1.7, text: 'Hello world.' }] };

  it('keeps actual local Whisper word edges and text', () => {
    expect(parseWhisperLyrics(transcript, 10)).toEqual([{ t: 1, text: 'Hello world.', words: [
      { t: 1, end: 1.3, text: ' Hello' }, { t: 1.35, end: 1.7, text: ' world.' },
    ] }]);
  });

  it('rejects missing, malformed, or out-of-track timestamps', () => {
    expect(parseWhisperLyrics({ ...transcript, version: 'unknown' }, 10)).toBeNull();
    expect(parseWhisperLyrics({ ...transcript, words: [{ start: 1, end: 12, word: ' bad' }] }, 10)).toBeNull();
    expect(parseWhisperLyrics({ ...transcript, words: [{ start: 2, end: 3, word: 'later' }, transcript.words[0]] }, 10)).toBeNull();
  });
});

describe('lyrics first-load recovery', () => {
  it('bounds retries and fallback lookups by one total deadline',async()=>{
    vi.useFakeTimers();
    const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{
      const c=new AbortController();if(ms===12000)setTimeout(()=>c.abort(new DOMException('Timeout','TimeoutError')),ms);return c.signal;
    });
    const fetcher=vi.fn((_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true})))
      .mockResolvedValueOnce(json({},404));
    vi.stubGlobal('fetch',fetcher);
    try{
      const result=findLyrics(query).then(()=>null,error=>error);
      await vi.advanceTimersByTimeAsync(12000);expect((await result).name).toBe('TimeoutError');
      expect(fetcher).toHaveBeenCalledTimes(2);
    }finally{timeout.mockRestore();vi.useRealTimers();}
  });
  it('recovers from a cold connection without asking the listener to retry', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json(row));
    vi.stubGlobal('fetch', fetcher);
    expect((await findLyrics(query)).status).toBe('synced');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries temporary service errors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json(row));
    vi.stubGlobal('fetch', fetcher);
    expect((await findLyrics(query)).lines[0].text).toBe('First line');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses search when the exact lookup remains unavailable', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json([row]));
    vi.stubGlobal('fetch', fetcher);
    expect((await findLyrics(query)).status).toBe('synced');
    expect(String(fetcher.mock.calls[2][0])).toContain('/api/search');
  });

  it('does not turn a failed lookup into a cacheable missing text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json([])));
    await expect(findLyrics(query)).rejects.toThrow('503');
  });

  it('does not retry an explicitly cancelled request', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => { controller.abort(); throw new TypeError('cancelled'); });
    vi.stubGlobal('fetch', fetcher);
    await expect(findLyrics(query, controller.signal)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shares a simultaneous sidebar/full-screen lookup and cache write', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mora-lyrics-'));
    const app = Fastify();
    const fetcher = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return json(row); });
    vi.stubGlobal('fetch', fetcher);
    registerLyricsRoutes(app, { cfg: { dataDir: dir }, db: {}, stems: { wordLyrics: () => null }, lib: {
      get: () => query, media: () => ({ id: 'recording', content_hash: 'same-recording', duration: 180 }), sources: () => [],
    } } as unknown as Services);
    try {
      const replies = await Promise.all([app.inject('/api/tracks/one/lyrics'), app.inject('/api/tracks/two/lyrics')]);
      expect(replies.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(replies.map((r) => r.json().status)).toEqual(['synced', 'synced']);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await app.inject('/api/tracks/one/lyrics')).json().status).toBe('synced');
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('returns existing local word timing alongside synced lyrics without starting Whisper', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mora-lyrics-'));
    const app = Fastify();
    registerLyricsRoutes(app, { cfg: { dataDir: dir }, db: {}, stems: { wordLyrics: () => [{ t: 1, text: 'Hello world.', words: [
      { t: 1, end: 1.3, text: ' Hello' }, { t: 1.35, end: 1.7, text: ' world.' },
    ] }] }, lib: {
      get: () => query, media: () => ({ id: 'recording', content_hash: 'same-recording', duration: 180 }), sources: () => [],
    } } as unknown as Services);
    const offline=vi.fn(async()=>{throw new TypeError('offline');});
    vi.stubGlobal('fetch',offline);
    try {
      const reply = await app.inject('/api/tracks/one/lyrics');
      expect(reply.statusCode).toBe(200);expect(offline).not.toHaveBeenCalled();
      expect(reply.json().wordLines[0].words[1]).toEqual({ t: 1.35, end: 1.7, text: ' world.' });
    } finally { await app.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });
});
