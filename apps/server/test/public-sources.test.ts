import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { matchConfidence, normalize, rank, relevance, versionLabels } from '../src/public/match.ts';
import { parseSearch } from '../src/public/ytmusic.ts';
import { checkedMediaUrl, classifyError } from '../src/public/ytdlp.ts';

describe('text and versions', () => {
  it('folds case, ё, punctuation and feat spellings without dropping version words', () => {
    expect(normalize('Ёлка (feat. Скриптонит) — Remix!')).toBe('елка feat скриптонит remix');
    expect(normalize('Track ft. A & B')).toBe('track feat a b');
  });

  it('labels versions by origin: the source badge differs from a title guess', () => {
    expect(versionLabels('Верить', true)).toEqual([{ tag: 'explicit', origin: 'source' }]);
    expect(versionLabels('Верить (slowed + reverb)').map((l) => l.tag)).toEqual(['slowed', 'reverb']);
    expect(versionLabels('Песня (живое исполнение)').map((l) => l.tag)).toEqual(['live']);
    expect(versionLabels('Song (Clean Radio Edit)').map((l) => l.tag).sort()).toEqual(['clean', 'radio-edit']);
  });

  it('ranks the plain recording above covers, remixes and slowed uploads the query did not ask for', () => {
    const items = [
      { title: 'Верить (slowed + reverb)', artist: 'fan', labels: versionLabels('Верить (slowed + reverb)'), kind: 'video' as const, duration: 240 },
      { title: 'Верить — кавер на гитаре', artist: 'cover guy', labels: versionLabels('Верить — кавер на гитаре'), kind: 'video' as const, duration: 200 },
      { title: 'Верить', artist: 'Yanix', labels: versionLabels('Верить', true), kind: 'song' as const, duration: 209 },
    ];
    expect(rank('Yanix Верить', items)[0].artist).toBe('Yanix');
    // Asking for the remix promotes it instead.
    const remix = { title: 'Верить (Remix)', artist: 'Yanix', labels: versionLabels('Верить (Remix)'), kind: 'song' as const, duration: 200 };
    expect(relevance('Yanix Верить remix', remix)).toBeGreaterThan(relevance('Yanix Верить', remix));
  });

  it('match confidence: ISRC wins, duration and alternate tags count', () => {
    const target = { title: 'Верить', artist: 'Yanix', duration: 209 };
    expect(matchConfidence({ ...target, isrc: 'RUA1D1900123' }, { title: 'x', artist: 'y', labels: [], isrc: 'rua1d1900123' })).toBe(1);
    expect(matchConfidence(target, { title: 'Верить', artist: 'Yanix', duration: 210, labels: [] })).toBeGreaterThanOrEqual(0.8);
    expect(matchConfidence(target, { title: 'Верить (Live)', artist: 'Yanix', duration: 260, labels: versionLabels('Верить (Live)') })).toBeLessThan(0.6);
  });
});

describe('YouTube Music response parsing (offline fixture)', () => {
  it('keeps ids, artists, albums, duration and the source explicit badge', () => {
    const json = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ytm-search.json'), 'utf8'));
    const items = parseSearch(json, 'song');
    expect(items.length).toBe(3);
    expect(items[0]).toMatchObject({ videoId: 'fAbCGcOZNFo', title: 'Верить', artist: 'Yanix', album: 'Пока рэп не разлучит нас', duration: 209, explicit: true, kind: 'song' });
    expect(items[0].artistId).toMatch(/^UC/);
    expect(items[0].albumId).toMatch(/^MPRE/);
  });

  it('ignores malformed rows instead of throwing', () => {
    expect(parseSearch({ contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [{}, { musicResponsiveListItemRenderer: { playlistItemData: { videoId: 'bad' } } }] } }] } } } }] } } }, 'song')).toEqual([]);
    expect(parseSearch(null, 'song')).toEqual([]);
  });
});

describe('resolver safety', () => {
  it('passes only https links of supported services', () => {
    expect(checkedMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toContain('youtube.com');
    for (const bad of ['http://www.youtube.com/watch?v=x', 'https://evil.example/x', 'https://user:pw@youtube.com/', 'https://youtube.com:8443/', 'https://127.0.0.1/', 'file:///C:/x', '--exec=calc'])
      expect(() => checkedMediaUrl(bad)).toThrow();
  });

  it('turns yt-dlp errors into short reasons without echoing URLs', () => {
    expect(classifyError('ERROR: [youtube] x: Sign in to confirm your age').kind).toBe('auth');
    expect(classifyError('ERROR: Video unavailable. This video has been removed').kind).toBe('unavailable');
    expect(classifyError('ERROR: The uploader has not made this video available in your country').kind).toBe('unavailable');
    expect(classifyError('ERROR: Read timed out').kind).toBe('timeout');
    expect(classifyError('https://secret.example/?sig=abc').message).not.toContain('secret');
  });
});

/** A tiny valid WAV; `seed` changes the bytes (a "re-encoded" upload). */
function wav(seed: number): Buffer {
  const sr = 8000, frames = sr * 3;
  const b = Buffer.alloc(44 + frames * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * (220 + seed) * i / sr)), 44 + i * 2);
  return b;
}

describe('public recordings in the library', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-public-'));
  let a: Awaited<ReturnType<typeof createApp>>;
  let seed = 0;
  const download = vi.fn(async (_url: string, staging: string) => {
    await new Promise((r) => setTimeout(r, 30));
    fs.mkdirSync(staging, { recursive: true });
    const file = path.join(staging, 'clip.wav');
    fs.writeFileSync(file, wav(seed));
    return { file, info: { title: 'Upload title', uploader: 'Uploader', acodec: 'pcm' } };
  });
  beforeAll(async () => {
    a = await createApp({ dataDir: path.join(dir, 'data'), analysisWorkers: 1, stemsPython: null, port: 0 }, { startWorkers: false });
    (a.services.publicMusic.ytdlp as unknown as { download: typeof download }).download = download;
  });
  afterAll(async () => { await a?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = (url: string, payload: unknown) => a.app.inject({ method: 'POST', url, payload: payload as object });

  it('prepares once for concurrent requests, as a technical row outside the collection', async () => {
    const [r1, r2] = await Promise.all([post('/api/public/prepare', { provider: 'youtube', externalId: 'dQw4w9WgXcQ' }), post('/api/public/prepare', { provider: 'youtube', externalId: 'dQw4w9WgXcQ' })]);
    expect(r1.statusCode, r1.body).toBe(200);
    expect(r1.json().trackId).toBe(r2.json().trackId);
    expect(download).toHaveBeenCalledTimes(1);
    const t = (await a.app.inject('/api/tracks/' + r1.json().trackId)).json();
    expect(t).toMatchObject({ saved: false, provider: 'youtube', title: 'Upload title' });
    expect(t.origin.metadataSource).toBe('youtube');
  });

  it('rejects bad ids and unknown providers before any download', async () => {
    const calls = download.mock.calls.length;
    for (const body of [{ provider: 'youtube', externalId: '../../etc' }, { provider: 'soundcloud', externalId: 'abc' }, { provider: 'spotify', externalId: 'x' }])
      expect((await post('/api/public/prepare', body)).statusCode).toBeGreaterThanOrEqual(400);
    expect(download.mock.calls.length).toBe(calls);
  });

  it('liking a technical row saves it; saving explicitly works too', async () => {
    const id = (await post('/api/public/prepare', { provider: 'youtube', externalId: 'dQw4w9WgXcQ' })).json().trackId;
    await post(`/api/tracks/${id}/reaction`, { value: 1 });
    expect((await a.app.inject('/api/tracks/' + id)).json().saved).toBe(true);
    await post(`/api/tracks/${id}/save`, { saved: false });
    expect((await a.app.inject('/api/tracks/' + id)).json().saved).toBe(false);
  });

  it('re-downloads an evicted file; different bytes get a new content hash so old analysis is never reused', async () => {
    const id = (await post('/api/public/prepare', { provider: 'youtube', externalId: 'dQw4w9WgXcQ' })).json().trackId;
    const before = a.services.lib.get(id)!.content_hash;
    fs.rmSync(path.join(dir, 'data', 'remote', 'youtube'), { recursive: true, force: true });
    seed = 7;
    const file = await a.services.lib.resolveMediaPath(id);
    expect(fs.existsSync(file)).toBe(true);
    const after = a.services.lib.get(id)!.content_hash;
    expect(after).not.toBe(before);
    expect(a.services.analysis.get(after)).toBeFalsy();
  });

  it('binding plays another recording while likes and identity stay on the track', async () => {
    const original = (await post('/api/public/prepare', { provider: 'youtube', externalId: 'dQw4w9WgXcQ' })).json().trackId;
    seed = 11;
    const other = (await post('/api/public/prepare', { provider: 'soundcloud', externalId: '1025527330' })).json().trackId;
    expect((await post(`/api/tracks/${original}/binding`, { assetId: other })).json().mediaId).toBe(other);
    const lib = (await a.app.inject('/api/library')).json().tracks as { id: string; binding?: { assetId: string } }[];
    expect(lib.find((t) => t.id === original)!.binding!.assetId).toBe(other);
    // Media routes answer for the asset.
    const audio = await a.app.inject({ method: 'GET', url: `/api/tracks/${original}/audio`, headers: { range: 'bytes=0-15' } });
    expect(audio.statusCode).toBe(206);
    expect(audio.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    await post(`/api/tracks/${original}/binding`, { assetId: null });
    expect(a.services.lib.mediaId(original)).toBe(original);
  });

  it('repairs old/imported artwork lazily, persists it and exposes a playlist cover without downloading audio', async () => {
    const track = a.services.lib.addRemote({ provider: 'youtube', externalId: 'CoverTest01', title: 'Artwork', artist: 'Artist', duration: 180, meta: {} });
    const playlist = (await post('/api/playlists', { name: 'Artwork test', trackIds: [track.id] })).json().id;
    const before = download.mock.calls.length;
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array(512).fill(5), { headers: { 'content-type': 'image/jpeg' } }));
    try {
      const dto = (await a.app.inject(`/api/tracks/${track.id}`)).json();
      expect(dto.coverUrl).toBe(`/api/tracks/${track.id}/cover`);
      const list = (await a.app.inject('/api/playlists')).json().playlists;
      expect(list.find((p: { id: string }) => p.id === playlist).coverUrl).toBe(dto.coverUrl);
      const [one, two] = await Promise.all([a.app.inject(dto.coverUrl), a.app.inject(dto.coverUrl)]);
      expect(one.statusCode).toBe(200); expect(two.rawPayload).toEqual(one.rawPayload);
      expect(fetch).toHaveBeenCalledOnce();
      expect(a.services.lib.get(track.id)!.cover_id).toBeTruthy();
      expect((await a.app.inject(`/api/tracks/${track.id}`)).json().coverUrl).toMatch(/^\/api\/covers\//);
      expect(download).toHaveBeenCalledTimes(before);
    } finally { fetch.mockRestore(); }
  });
});

describe('offline downloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-dl-'));
  let a: Awaited<ReturnType<typeof createApp>>;
  let mode: 'ok' | 'network' | 'partial' = 'ok';
  let seed = 100;
  const download = vi.fn(async (_url: string, staging: string) => {
    fs.mkdirSync(staging, { recursive: true });
    if (mode === 'network') throw Object.assign(new (await import('../src/public/ytdlp.ts')).ResolverError('Источник не ответил', 'timeout'));
    const file = path.join(staging, 'clip.wav');
    fs.writeFileSync(file, wav(seed++));
    if (mode === 'partial') { fs.truncateSync(file, 30); }
    return { file, info: { title: 'Clip', uploader: 'U' } };
  });
  beforeAll(async () => {
    a = await createApp({ dataDir: path.join(dir, 'data'), analysisWorkers: 1, stemsPython: null, port: 0 }, { startWorkers: false });
    (a.services.publicMusic.ytdlp as unknown as { download: typeof download }).download = download;
  });
  afterAll(async () => { await a?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const waitJob = async (id: string, states: string[]) => {
    for (let i = 0; i < 200; i++) { const j = a.services.downloads.list().find((x) => x.id === id)!; if (states.includes(j.state)) return j; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error('job did not settle');
  };

  it('a finished download pins and saves the track; asking again reuses the job', async () => {
    const r = await a.app.inject({ method: 'POST', url: '/api/downloads', payload: { provider: 'youtube', externalId: 'aaaaaaaaaaa' } });
    const job = await waitJob(r.json().job.id, ['done', 'failed']);
    expect(job.state, job.error ?? '').toBe('done');
    expect(a.services.lib.get(job.trackId!)).toMatchObject({ pinned: 1, saved: 1 });
    const again = await a.app.inject({ method: 'POST', url: '/api/downloads', payload: { provider: 'youtube', externalId: 'aaaaaaaaaaa' } });
    expect(again.json().job.id).toBe(job.id);
  });

  it('network failure waits and retries instead of failing; a broken file is never published', async () => {
    mode = 'network';
    const j1 = a.services.downloads.add({ provider: 'youtube', externalId: 'bbbbbbbbbbb' });
    expect((await waitJob(j1.id, ['waiting', 'failed', 'done'])).state).toBe('waiting');
    mode = 'partial';
    const j2 = a.services.downloads.add({ provider: 'youtube', externalId: 'ccccccccccc' });
    expect((await waitJob(j2.id, ['failed', 'done'])).state).toBe('failed');
    expect(a.services.publicMusic.known('youtube', ['ccccccccccc']).size).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'data', 'remote', '.staging'))).toEqual([]);
    mode = 'ok';
  });

  it('cache eviction removes old unpinned audio and never pinned downloads', async () => {
    const plain = (await a.app.inject({ method: 'POST', url: '/api/public/prepare', payload: { provider: 'youtube', externalId: 'ddddddddddd' } })).json().trackId;
    const pinnedId = a.services.downloads.list().find((j) => j.externalId === 'aaaaaaaaaaa')!.trackId!;
    const old = new Date(Date.now() - 5 * 3600_000);
    for (const f of fs.readdirSync(path.join(dir, 'data', 'remote', 'youtube'))) fs.utimesSync(path.join(dir, 'data', 'remote', 'youtube', f), old, old);
    expect(await a.services.downloads.evict(0)).toBe(1);
    const hashOf = (id: string) => a.services.lib.get(id)!.content_hash;
    const left = fs.readdirSync(path.join(dir, 'data', 'remote', 'youtube')).map((f) => f.slice(0, 64));
    expect(left).toContain(hashOf(pinnedId));
    expect(left).not.toContain(hashOf(plain));
  });
});
