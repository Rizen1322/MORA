import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ANALYZER_VERSION } from '@automix/core';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { q } from '../src/db.ts';
import type { ExternalTrack, Provider } from '../src/providers/types.ts';
import { parseYandexDownloadXml } from '../src/providers/yandex-audio.ts';

type App = Awaited<ReturnType<typeof createApp>>;
type SeenRequest = { method: string; path: string; authorization: string | undefined; body: string };
const TOKEN = 'fixture-yandex-oauth-no-cdn';
const UPLOAD_ID = '11111111-2222-4333-8444-555555555555';
const HEX_TS = '00061f6ed11e2346';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind a TCP port');
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

describe('Yandex full MP3 import through local API/download fixtures', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-yandex-audio-'));
  const oldApiBase = process.env.YANDEX_API_BASE;
  const seen: SeenRequest[] = [], foreignSeen: SeenRequest[] = [];
  let fixture: Server, foreign: Server, base: string, foreignBase: string, a: App;
  let mp3: Buffer, replacementMp3: Buffer;
  let changedDownload = false;
  let fullTrack: ExternalTrack;
  let importedId: string;
  const digest = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');
  const trackId = (id: string) => String(id).split(':')[0];
  const track = (id: string) => ({
    id: trackId(id), title: ['100', '740', '750'].includes(id) ? 'Fixture full track' : `Fixture ${id}`,
    ...(id === '740' ? { version: 'Live' } : {}),
    artists: [{ id: 7, name: 'Fixture Artist' }],
    albums: id === UPLOAD_ID ? [] : ['110', '111'].includes(id) ? [
      { id: 10, title: 'Wrong first edition', trackPosition: { index: 1, volume: 1 } },
      { id: 11, title: 'Selected album', year: 2025, genre: 'electronic', trackPosition: { index: 7, volume: 2 } },
    ] : [{ id: 10, title: 'Fixture Album' }],
    durationMs: id === '500' || id === '750' ? 30000 : 3000, available: true, availableForPremiumUsers: true,
  });
  const json = (res: ServerResponse, result: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result }));
  };
  async function bodyOf(req: IncomingMessage): Promise<string> {
    let body = ''; for await (const chunk of req) body += chunk.toString(); return body;
  }
  async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', base), body = await bodyOf(req);
    seen.push({ method: req.method ?? 'GET', path: url.pathname + url.search, authorization: req.headers.authorization, body });
    const api = /^\/(account|search|tracks|users|chart|landing3|rotor)(\/|$)/.test(url.pathname);
    if (api && req.headers.authorization !== `OAuth ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { name: 'Unauthorized', message: 'fixture token rejected' } })); return;
    }
    if (url.pathname === '/account/status') return json(res, { account: { uid: 42, login: 'fixture', displayName: 'Fixture User' }, plus: { hasPlus: true }, subscription: { nonAutoRenewableRemainder: { end: '2030-01-01T00:00:00Z' } } });
    if (url.pathname === '/search') {
      if (url.searchParams.get('type') !== 'track') return json(res, null, 400);
      return json(res, { type: 'track', tracks: { total: 1, perPage: 30, page: 0, results: [track('100')] } });
    }
    if (url.pathname === '/users/42/likes/tracks') return json(res, { library: { tracks: [{ id: '100', albumId: '10' }, { id: UPLOAD_ID }] } });
    if (url.pathname === '/rotor/wave/settings') return json(res, { settingRestrictions: {
      diversity: { name: 'Характер', type: 'enum', possibleValues: [
        { name: 'Любимое', serializedSeed: 'settingDiversity:favorite' },
        { name: 'Открытия', serializedSeed: 'settingDiversity:discover' },
      ] },
      language: { name: 'Язык', possibleValues: [{ name: 'На русском', serializedSeed: 'settingLanguage:russian' }] },
    } });
    if (url.pathname === '/rotor/session/new') return json(res, {
      radioSessionId: 'fixture-wave', batchId: 'batch-new',
      sequence: ['200', ...Array.from({ length: 12 }, (_, i) => String(710 + i))].map((id) => ({ track: track(id) })),
    });
    if (url.pathname === '/rotor/session/fixture-reservoir/tracks') return json(res, {
      batchId: 'reservoir-batch',
      sequence: ['100','100','760','761','762','763','764','765','766'].map(id => ({track: track(id)})),
    });
    if (url.pathname === '/rotor/session/expired/tracks') return json(res, { unknownSession: true });
    if (url.pathname === '/rotor/session/fixture-wave/tracks') return json(res, {
      radioSessionId: 'fixture-wave', batchId: 'batch-next',
      sequence: ['100', '720', '721', '722', '723', '724'].map((id) => ({ track: track(id) })),
    });
    if (url.pathname === '/rotor/session/fixture-failures/tracks') return json(res, {
      radioSessionId: 'fixture-failures', batchId: 'batch-failures',
      sequence: ['200', '300', '500', '730', '731'].map((id) => ({ track: track(id) })),
    });
    if (url.pathname === '/rotor/session/fixture-version/tracks') return json(res, {
      radioSessionId: 'fixture-version', batchId: 'batch-version',
      sequence: ['740', '742'].map((id) => ({ track: track(id) })),
    });
    if (url.pathname === '/rotor/session/fixture-duration/tracks') return json(res, {
      radioSessionId: 'fixture-duration', batchId: 'batch-duration',
      sequence: ['750', '751'].map((id) => ({ track: track(id) })),
    });
    if (url.pathname === '/chart') return json(res, { chart: { tracks: [{ track: track('100') }] } });
    if (url.pathname === '/tracks' && req.method === 'POST') {
      let ids = new URLSearchParams(body).get('track-ids');
      if (!ids) try { ids = JSON.parse(body)['track-ids']; } catch { /* only fixture protocols */ }
      // Metadata responses may arrive in a different order from the likes list.
      return json(res, String(ids ?? '').split(',').filter(Boolean).map((id) => track(trackId(id))).reverse());
    }
    const info = /^\/tracks\/([^/]+)\/download-info$/.exec(url.pathname);
    if (info) {
      const id = trackId(decodeURIComponent(info[1]));
      const item = { codec: 'mp3', bitrateInKbps: 320, preview: false, downloadInfoUrl: `${base}/xml/${id}/320`, direct: false };
      if (id === '200') return json(res, [{ ...item, preview: true }]);
      if (id === '201') { const { preview: _missingPreview, ...missing } = item; return json(res, [missing]); }
      if (id === '300') return json(res, [{ ...item, codec: 'flac', transport: 'encraw' }]);
      if (id === '301') return json(res, [{ ...item, transport: 'encraw' }]);
      if (id === '600') return json(res, [{ ...item, downloadInfoUrl: `${foreignBase}/foreign.xml` }]);
      // Prefer the best full MP3 even when a preview appears first.
      return json(res, [{ ...item, preview: true }, { ...item, bitrateInKbps: 128, downloadInfoUrl: `${base}/xml/${id}/128` }, item]);
    }
    const xml = /^\/xml\/(\d+)\/(\d+)$/.exec(url.pathname);
    if (xml) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<download-info><host>${new URL(base).host}</host><path>/audio/${xml[1]}.mp3</path><ts>${xml[1] === '103' ? HEX_TS : '1700000000'}</ts><s>fixture-salt</s></download-info>`); return;
    }
    const audio = /^\/(?:get-mp3\/[^/]+\/[^/]+\/)?audio\/(\d+)\.mp3$/.exec(url.pathname);
    if (audio) {
      if (audio[1] === '601') { res.writeHead(302, { location: `${foreignBase}/foreign.mp3` }); res.end(); return; }
      if (audio[1] === '102' && url.pathname.startsWith('/get-mp3/')) { res.writeHead(302, { location: `${base}/audio/102.mp3` }); res.end(); return; }
      const bytes = changedDownload ? replacementMp3 : mp3;
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': bytes.length });
      if (audio[1] === '400') {
        res.flushHeaders(); res.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
        setImmediate(() => res.destroy()); return;
      }
      res.end(bytes); return;
    }
    json(res, null, 404);
  }
  const external = (id: string): ExternalTrack => ({ externalId: `${id}:10`, title: `untrusted client title ${id}`, artist: 'client artist', album: '', duration: 3, coverUrl: null, pageUrl: null, license: null, playable: true });
  const importViaApi = (value: ExternalTrack) => a.app.inject({ method: 'POST', url: '/api/providers/yandex/import', payload: { track: value } });
  const countTracks = () => (q(a.services.db, 'SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
  const audioRequests = () => seen.filter((request) => /^\/get-mp3\//.test(request.path));

  beforeAll(async () => {
    const ffmpeg = loadConfig().ffmpeg;
    const makeMp3 = (frequency: number) => execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=44100:duration=3`, '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '320k', '-f', 'mp3', 'pipe:1'], { windowsHide: true, maxBuffer: 1024 * 1024 });
    mp3 = makeMp3(440); replacementMp3 = makeMp3(880);
    foreign = createServer((req, res) => {
      foreignSeen.push({ method: req.method ?? 'GET', path: req.url ?? '/', authorization: req.headers.authorization, body: '' });
      res.writeHead(200, { 'content-type': 'application/xml' }); res.end('<download-info/>');
    });
    foreignBase = await listen(foreign);
    fixture = createServer((req, res) => { void serve(req, res).catch((error) => { res.writeHead(500); res.end(String(error)); }); });
    base = await listen(fixture); process.env.YANDEX_API_BASE = base;
    a = await createApp({ dataDir, stemsPython: null, accessToken: null, port: 0, analysisWorkers: 1 }, { startWorkers: false });
    a.services.providers.store.save('yandex', {}, { token: TOKEN }, true);
  });
  afterAll(async () => {
    await a?.close(); await closeServer(fixture); await closeServer(foreign);
    if (oldApiBase === undefined) delete process.env.YANDEX_API_BASE; else process.env.YANDEX_API_BASE = oldApiBase;
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('automix-yandex-audio-')) throw new Error('unsafe fixture cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it('connects OAuth, exposes audio capabilities, and keeps the token out of API responses', async () => {
    const connected = await a.app.inject({ method: 'POST', url: '/api/providers/yandex/connect', payload: { secret: { token: TOKEN } } });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.body).not.toContain(TOKEN);
    const info = await a.services.providers.yandex.info(true);
    expect(info.status).toBe('connected');
    expect(info.capabilities).toMatchObject({ search: true, playback: true, seek: true, pcm: true, analysis: true, mixing: true });
    const rejected = await a.app.inject({ method: 'POST', url: '/api/providers/yandex/connect', payload: { secret: { token: 'invalid-fixture-token' } } });
    expect(rejected.statusCode).toBe(422);
    expect((await a.services.providers.yandex.info(true)).status).toBe('connected');
  });

  it('loads genuine provider choices, validates them, preserves them on local edits and sends session seeds', async () => {
    const response = await a.app.inject('/api/providers/yandex/wave/settings');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().groups[0]).toEqual({ id: 'diversity', name: 'Характер', values: [
      { name: 'Любимое', seed: 'settingDiversity:favorite' }, { name: 'Открытия', seed: 'settingDiversity:discover' },
    ] });
    for (const yandexSeeds of [['track:123'], ['settingDiversity:invented'], ['settingDiversity:favorite','settingDiversity:discover']]) {
      expect((await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { wave: { yandexSeeds } } })).statusCode).toBe(400);
    }
    const saved = await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { wave: { yandexSeeds: ['settingDiversity:discover'] } } });
    expect(saved.statusCode, saved.body).toBe(200);
    const local = await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { wave: { mood: 'calm' } } });
    expect(local.json().wave.yandexSeeds).toEqual(['settingDiversity:discover']);
    const calls = seen.length;
    const wave = await a.app.inject({ method: 'POST', url: '/api/providers/yandex/wave', payload: { count: 1, queue: ['200', ...Array.from({ length: 12 }, (_, i) => String(710 + i))] } });
    expect(wave.statusCode, wave.body).toBe(200);
    expect(JSON.parse(seen.slice(calls).find((r) => r.path === '/rotor/session/new')!.body).seeds).toEqual(['user:onyourwave','settingDiversity:discover']);
    await a.app.inject({ method: 'PUT', url: '/api/settings', payload: { wave: { yandexSeeds: [], mood: 'normal' } } });
  });

  it('searches tracks and exposes featured account tracks through the provider', async () => {
    const response = await a.app.inject('/api/providers/yandex/search?q=fixture');
    expect(response.statusCode, response.body).toBe(200);
    fullTrack = response.json().items[0];
    expect(fullTrack).toMatchObject({ title: 'Fixture full track', artist: 'Fixture Artist', playable: true });
    expect(trackId(fullTrack.externalId)).toBe('100');
    const provider: Provider = a.services.providers.yandex;
    expect((await provider.featured!()).some((item) => trackId(item.externalId) === '100')).toBe(true);
    expect(seen.some((request) => request.path.startsWith('/search?') && request.path.includes('type=track'))).toBe(true);
  });

  it('keeps numeric and uploaded UUID tracks in the same featured and likes collection', async () => {
    const requests = seen.length;
    const featured = await a.services.providers.yandex.featured();
    expect(featured.map((item) => item.externalId)).toEqual(['100:10', UPLOAD_ID]);
    const likes = await a.services.providers.yandex.likes();
    expect(likes.map((item) => item.yandexId)).toEqual(['100:10', UPLOAD_ID]);
    const details = seen.slice(requests).filter((request) => request.method === 'POST' && request.path === '/tracks');
    expect(details).toHaveLength(2);
    for (const request of details) expect(new URLSearchParams(request.body).get('track-ids')).toBe(`100:10,${UPLOAD_ID}`);
    const snapshot = await a.services.providers.yandex.likeIds();
    expect(snapshot.ids).toEqual(['100:10', UPLOAD_ID]);
    expect(snapshot.key).not.toContain(TOKEN);
  });

  it('preserves a hexadecimal Yandex timestamp when parsing signed MP3 XML', () => {
    const url = parseYandexDownloadXml(`<download-info><host>fixture.yandex.net</host><path>/audio/103.mp3</path><ts>${HEX_TS}</ts><s>fixture-salt</s></download-info>`, 'https://api.music.yandex.net');
    expect(new URL(url).origin).toBe('https://fixture.yandex.net');
    expect(new URL(url).pathname).toMatch(new RegExp(`^/get-mp3/[a-f0-9]{32}/${HEX_TS}/audio/103\\.mp3$`));
  });

  it('imports verified full MP3 and hashes the actual audio before exposing a track', async () => {
    const response = await importViaApi(fullTrack);
    expect(response.statusCode, response.body).toBe(200);
    importedId = response.json().trackId;
    const row = a.services.lib.get(importedId)!;
    expect(row.provider).toBe('yandex');
    expect(row.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(row.content_hash).toBe(digest(mp3));
    expect(row.duration).toBeGreaterThan(2.9);
    expect(row.duration).toBeLessThan(3.5);
    const src = a.services.lib.sources(importedId)[0];
    expect(JSON.parse(src.meta).audioHash).toBe(row.content_hash);
    expect(seen.some((request) => request.method === 'POST' && request.path === '/tracks' && request.body.includes('100'))).toBe(true);
    expect(seen.some((request) => request.path === '/xml/100/320')).toBe(true);
    expect(seen.some((request) => request.path === '/xml/100/128')).toBe(false);
    const downloads = seen.filter((request) => request.path.startsWith('/xml/') || request.path.startsWith('/get-mp3/') || request.path.startsWith('/audio/'));
    expect(downloads.length).toBeGreaterThan(1);
    for (const request of downloads) expect(request.authorization).toBeUndefined();
    expect(audioRequests().length).toBe(1);
  });

  it('deduplicates repeated imports without another audio download or library row', async () => {
    const before = countTracks(), downloads = audioRequests().length;
    const response = await importViaApi(fullTrack);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().trackId).toBe(importedId);
    expect(countTracks()).toBe(before);
    expect(audioRequests().length).toBe(downloads);
  });

  it('canonicalizes a bare track ID to the same imported album-qualified track', async () => {
    const tracks = countTracks(), downloads = audioRequests().length;
    const response = await importViaApi({ ...fullTrack, externalId: '100' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().trackId).toBe(importedId);
    expect(countTracks()).toBe(tracks);
    expect(audioRequests().length).toBe(downloads);
  });

  it('coalesces concurrent imports of a new track and trusts API metadata rather than the browser', async () => {
    const before = countTracks(), downloads = audioRequests().length;
    const responses = await Promise.all(Array.from({ length: 6 }, () => importViaApi({ ...external('101'), duration: 999 })));
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    const ids = new Set(responses.map((response) => response.json().trackId));
    expect(ids.size).toBe(1);
    expect(countTracks()).toBe(before + 1);
    expect(audioRequests().length).toBe(downloads + 1);
    const imported = a.services.lib.get([...ids][0])!;
    expect(imported.title).toBe('Fixture 101');
    expect(imported.artist).toBe('Fixture Artist');
    expect(imported.duration).toBeLessThan(3.5);
  });

  it('imports the selected album edition with its server-side track and disc metadata', async () => {
    const before = countTracks(), requests = seen.length;
    const response = await importViaApi({ ...external('110'), externalId: '110:11', album: 'Untrusted browser edition', duration: 999 });
    expect(response.statusCode, response.body).toBe(200);
    const row = a.services.lib.get(response.json().trackId)!;
    expect(row).toMatchObject({ title: 'Fixture 110', artist: 'Fixture Artist', album: 'Selected album', year: 2025, genre: 'electronic', track_no: 7, disc_no: 2 });
    expect(row.content_hash).toBe(digest(mp3));
    expect(row.duration).toBeGreaterThan(2.9); expect(row.duration).toBeLessThan(3.5);
    const [source] = a.services.lib.sources(row.id);
    expect(source.external_id).toBe('110:11');
    expect(JSON.parse(source.meta)).toMatchObject({ catalogAlbumId: '11', catalogArtists: [{ id: '7', name: 'Fixture Artist' }], audioHash: row.content_hash });
    expect(seen.slice(requests).some((request) => decodeURIComponent(request.path) === '/tracks/110:11/download-info')).toBe(true);
    expect(countTracks()).toBe(before + 1);
  });

  it('rejects a requested album edition missing from server metadata before downloading or adding a song', async () => {
    const before = countTracks(), requests = seen.length;
    const response = await importViaApi({ ...external('111'), externalId: '111:99', album: 'Requested missing release' });
    expect(response.statusCode, response.body).toBe(502);
    expect(response.json().error).toEqual(expect.any(String));
    const requested = seen.slice(requests);
    expect(requested.some((request) => request.path === '/tracks' && new URLSearchParams(request.body).get('track-ids') === '111:99')).toBe(true);
    expect(requested.some((request) => /download-info|\/xml\/|get-mp3/.test(request.path))).toBe(false);
    expect(countTracks()).toBe(before);
  });

  it('accepts a same-origin media redirect without forwarding the account token', async () => {
    const response = await importViaApi(external('102'));
    expect(response.statusCode, response.body).toBe(200);
    const requests = seen.filter((request) => request.path.endsWith('/audio/102.mp3'));
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.authorization).toBeUndefined();
  });

  it('imports a full MP3 whose download XML uses a hexadecimal timestamp', async () => {
    const response = await importViaApi(external('103'));
    expect(response.statusCode, response.body).toBe(200);
    expect(a.services.lib.get(response.json().trackId)!.content_hash).toBe(digest(mp3));
    const downloaded = audioRequests().find((request) => request.path.endsWith('/audio/103.mp3'))!;
    expect(downloaded.path).toContain(`/${HEX_TS}/`);
    expect(downloaded.authorization).toBeUndefined();
  });

  it('resolves a public track link through metadata without requesting its web page', async () => {
    const response = await a.app.inject(`/api/providers/yandex/search?q=${encodeURIComponent('https://music.yandex.ru/album/10/track/100')}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items[0].title).toBe('Fixture full track');
  });

  it.each(['../100', '100/10', '100?token=evil', '', '100:10:20', '%31'])('rejects invalid import ID %j before any upstream request', async (id) => {
    const requests = seen.length, tracks = countTracks();
    const response = await importViaApi({ ...external('100'), externalId: id });
    expect(response.statusCode).toBe(502);
    expect(seen.length).toBe(requests);
    expect(countTracks()).toBe(tracks);
  });

  it('prepares and seeks the imported audio through the ordinary PCM endpoint', async () => {
    const prepared = await a.app.inject({ method: 'POST', url: `/api/tracks/${importedId}/prepare`, payload: { sampleRate: 48000, role: 'current' } });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const forward = await a.app.inject(`/api/tracks/${importedId}/pcm?sr=48000&start=57600&frames=1024`);
    const backward = await a.app.inject(`/api/tracks/${importedId}/pcm?sr=48000&start=24000&frames=1024`);
    for (const response of [forward, backward]) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload.length).toBe(4096);
      let energy = 0; for (let i = 0; i < response.rawPayload.length; i += 2) energy += response.rawPayload.readInt16LE(i) ** 2;
      expect(energy).toBeGreaterThan(1000);
    }
  });

  it('analyzes remote audio under its verified hash rather than a remote placeholder', async () => {
    a.services.analysis.start();
    const hash = a.services.lib.get(importedId)!.content_hash;
    const deadline = Date.now() + 15000;
    while (!a.services.analysis.get(hash) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.services.analysis.get(hash)?.version).toBe(ANALYZER_VERSION);
    expect((await a.app.inject(`/api/tracks/${importedId}/analysis`)).json().status).toBe('done');
    expect(q(a.services.db, "SELECT content_hash FROM analysis WHERE status='done' AND content_hash=?").get(hash)).toBeDefined();
  });

  it('prepares only two available recommendations from a long new-wave sequence', async () => {
    const requests = seen.length, tracks = countTracks(), downloads = audioRequests().length;
    const response = await a.app.inject('/api/providers/yandex/wave');
    expect(response.statusCode, response.body).toBe(200);
    const wave = response.json();
    expect(wave.sessionId).toBe('fixture-wave');
    expect(wave.batchId).toBe('batch-new');
    expect(wave.items).toHaveLength(13);
    const prepared = wave.items.filter((item: { trackId: string | null }) => item.trackId);
    expect(prepared.map((item: { yandexId: string }) => trackId(item.yandexId))).toEqual(['710', '711']);
    for (const item of prepared) {
      const ready = a.services.lib.get(item.trackId)!;
      expect(ready.content_hash).toBe(digest(mp3));
      expect(ready.provider).toBe('yandex');
      expect(ready.status).toBe('ok');
    }
    expect(wave.items[0].error).toMatch(/превью|полный/i);
    expect(countTracks()).toBe(tracks + 2);
    expect(audioRequests().length).toBe(downloads + 2);
    const attempted = seen.slice(requests).filter((request) => request.path.includes('/download-info'));
    expect(attempted).toHaveLength(3);
    expect(attempted.map((request) => decodeURIComponent(request.path).split('/')[2]).sort()).toEqual(['200:10', '710:10', '711:10']);
    expect(wave.items.slice(3).every((item: { trackId: string | null }) => !item.trackId)).toBe(true);
    const started = seen.slice(requests).find((request) => request.path === '/rotor/session/new')!;
    expect(JSON.parse(started.body)).toMatchObject({ seeds: ['user:onyourwave'], includeTracksInResponse: true });
  });

  it('tops up an existing wave session without downloading all its recommendations', async () => {
    const requests = seen.length, tracks = countTracks(), downloads = audioRequests().length;
    const wave = await a.services.providers.yandex.wave('fixture-wave', ['100:10']);
    expect(wave.batchId).toBe('batch-next');
    expect(wave.items.filter((item) => item.trackId)).toHaveLength(2);
    expect(wave.items[0].trackId).toBe(importedId);
    expect(a.services.lib.get(wave.items[1].trackId!)!.content_hash).toBe(digest(mp3));
    expect(countTracks()).toBe(tracks + 1);
    expect(audioRequests().length).toBe(downloads + 1);
    expect(wave.items.slice(2).every((item) => !item.trackId)).toBe(true);
    const continued = seen.slice(requests).find((request) => request.path === '/rotor/session/fixture-wave/tracks')!;
    expect(JSON.parse(continued.body)).toMatchObject({ queue: ['100:10'] });
  });

  it('stops after three failed wave attempts and returns an error for each refused item', async () => {
    const requests = seen.length, tracks = countTracks();
    const response = await a.app.inject('/api/providers/yandex/wave?session=fixture-failures');
    expect(response.statusCode, response.body).toBe(200);
    const wave = response.json();
    expect(wave.items.every((item: { trackId: string | null }) => !item.trackId)).toBe(true);
    expect(wave.items.slice(0, 3).every((item: { error?: string }) => !!item.error)).toBe(true);
    expect(wave.items.slice(3).every((item: { error?: string }) => !item.error)).toBe(true);
    expect(seen.slice(requests).filter((request) => request.path.includes('/download-info'))).toHaveLength(3);
    expect(seen.slice(requests).some((request) => /730|731/.test(request.path + request.body))).toBe(false);
    expect(countTracks()).toBe(tracks);
  });

  it('does not substitute an existing original recording for a live wave recommendation', async () => {
    const downloads = audioRequests().length;
    const wave = await a.services.providers.yandex.wave('fixture-version');
    expect(wave.items[0].yandexId).toBe('740:10');
    expect(wave.items[0].trackId).not.toBe(importedId);
    const live = a.services.lib.get(wave.items[0].trackId!)!;
    expect(live.title).toBe('Fixture full track (Live)');
    expect(wave.items[0].title).toBe(live.title);
    expect(audioRequests().length).toBe(downloads + 2);
  });

  it('does not match a different-duration recording solely by artist and title', async () => {
    const tracks = countTracks();
    const wave = await a.services.providers.yandex.wave('fixture-duration');
    expect(wave.items[0].yandexId).toBe('750:10');
    expect(wave.items[0].trackId).toBeNull();
    expect(wave.items[0].error).toMatch(/длительность|превью|верси/i);
    expect(wave.items[1].trackId).toBeTruthy();
    expect(countTracks()).toBe(tracks + 1);
    expect(a.services.lib.get(importedId)!.title).toBe('Fixture full track');
  });

  it('serves a ready aligned vocal cache for a verified Yandex track without Python', async () => {
    const row = a.services.lib.get(importedId)!;
    expect(row.content_hash).toMatch(/^[a-f0-9]{64}$/);
    const dir = path.join(dataDir, 'cache', 'stems', row.content_hash, 'hdemucs-v1');
    fs.mkdirSync(dir, { recursive: true });
    const voice = Buffer.alloc(8 * 8);
    for (let i = 0; i < 16; i++) voice.writeFloatLE(i % 2 === 0 ? 1.25 : -0.75, i * 4);
    fs.writeFileSync(path.join(dir, 'vocals.f32'), voice);
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
      version: 'hdemucs-v1', model: 'HDEMUCS_HIGH_MUSDB_PLUS', sampleRate: 44100, frames: 8, device: 'fixture', seconds: 0,
      activity: { rate: 10, values: [0.7], source: 'demucs', model: 'HDEMUCS_HIGH_MUSDB_PLUS' },
    }));
    expect(a.services.stems.stats().available).toBe(false);
    expect(a.services.stems.supports(row)).toBe(true);
    const status = await a.app.inject(`/api/tracks/${importedId}/stems`);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ status: 'ready', model: 'HDEMUCS_HIGH_MUSDB_PLUS' });
    const audio = await a.app.inject(`/api/tracks/${importedId}/vocals/pcm?sr=44100&start=0&frames=8`);
    expect(audio.statusCode, audio.body).toBe(200);
    expect(audio.headers['x-pcm-format']).toBe('f32le');
    expect(audio.rawPayload.equals(voice)).toBe(true);
  });

  it.each(['200', '201', '300', '301', '400', '500', '600', '601'])('rejects incomplete, preview, encrypted or off-origin audio %s without adding a track', async (id) => {
    const before = countTracks();
    const response = await importViaApi(external(id));
    expect(response.statusCode, response.body).toBe(502);
    expect(response.json().error).toBeTruthy();
    expect(countTracks()).toBe(before);
    expect(q(a.services.db, 'SELECT track_id FROM track_sources WHERE provider=? AND external_id=?').get('yandex', id)).toBeUndefined();
    expect(foreignSeen).toHaveLength(0);
    const cache = path.join(dataDir, 'remote', 'yandex');
    expect(fs.existsSync(cache) ? fs.readdirSync(cache).filter((file) => file.startsWith('incoming-')) : []).toEqual([]);
  });

  it('revalidates a damaged cache before serving playback and rejects changed remote content', async () => {
    const src = a.services.lib.sources(importedId)[0];
    const provider: Provider = a.services.providers.yandex;
    const file = await provider.fetchAudio!(src);
    expect(path.resolve(file).startsWith(path.resolve(dataDir) + path.sep)).toBe(true);
    const downloads = audioRequests().length;
    fs.writeFileSync(file, Buffer.from('damaged fixture cache'));
    const repaired = await provider.fetchAudio!(src);
    expect(digest(fs.readFileSync(repaired))).toBe(digest(mp3));
    expect(audioRequests().length).toBe(downloads + 1);
    fs.unlinkSync(repaired); changedDownload = true;
    try { await expect(provider.fetchAudio!(src)).rejects.toThrow(/измен|хеш|hash|содержим/i); }
    finally { changedDownload = false; }
    expect(a.services.lib.get(importedId)!.content_hash).toBe(digest(mp3));
  });

  it('keeps playback pinned to the library hash when optional source metadata is missing', async () => {
    const src = a.services.lib.sources(importedId)[0];
    const originalHash = a.services.lib.get(importedId)!.content_hash;
    const cached = path.join(dataDir, 'remote', 'yandex', `${originalHash}.mp3`);
    fs.rmSync(cached, { force: true });
    changedDownload = true;
    try {
      await expect(a.services.providers.yandex.fetchAudio({ ...src, meta: '{}' })).rejects.toThrow(/измен|хеш|hash|содержим/i);
    } finally { changedDownload = false; }
    expect(a.services.lib.get(importedId)!.content_hash).toBe(originalHash);
  });

  it('rejects conflicting source and library hashes before any download request', async () => {
    const src = a.services.lib.sources(importedId)[0];
    const requests = seen.length;
    const meta = JSON.stringify({ ...JSON.parse(src.meta), audioHash: digest(replacementMp3) });
    await expect(a.services.providers.yandex.fetchAudio({ ...src, meta })).rejects.toThrow();
    expect(seen.length).toBe(requests);
    expect(a.services.lib.get(importedId)!.content_hash).toBe(digest(mp3));
  });
  it('POST refill excludes received aliases, deduplicates and prepares a bounded four-track reserve', async () => {
    const requests = seen.length;
    const response = await a.app.inject({ method:'POST', url:'/api/providers/yandex/wave',
      payload:{ session:'fixture-reservoir', queue:['100:999'], count:4 } });
    expect(response.statusCode, response.body).toBe(200);
    const wave = response.json();
    expect(wave.items.some((item: {yandexId:string}) => trackId(item.yandexId) === '100')).toBe(false);
    expect(wave.items.filter((item:{trackId:string|null})=>item.trackId).map((item:{yandexId:string})=>trackId(item.yandexId)), JSON.stringify(wave.items)).toEqual(['760','761','762','763']);
    const calls = seen.slice(requests);
    expect(calls.filter(request=>request.path.includes('/download-info'))).toHaveLength(4);
    expect(calls.some(request=>/764|765|766/.test(request.path))).toBe(false);
    expect(JSON.parse(calls.find(request=>request.path.endsWith('fixture-reservoir/tracks'))!.body).queue).toEqual(['100:999']);
  });

  it('renews an unknown session and forwards exclusions to the replacement session', async () => {
    const requests = seen.length;
    const response = await a.app.inject({method:'POST',url:'/api/providers/yandex/wave',payload:{session:'expired',queue:['710:99'],count:1}});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().sessionId).toBe('fixture-wave');
    expect(response.json().items.some((item:{yandexId:string})=>trackId(item.yandexId)==='710')).toBe(false);
    const started = seen.slice(requests).find(request=>request.path==='/rotor/session/new')!;
    expect(JSON.parse(started.body).queue).toEqual(['710:99']);
  });

  it('rejects invalid reserve sizes and queue IDs before contacting Yandex', async () => {
    const requests = seen.length;
    for (const payload of [{count:100},{count:0},{queue:['invalid/id']},{queue:Array(201).fill('100')},{session:9}]) {
      const response = await a.app.inject({method:'POST',url:'/api/providers/yandex/wave',payload});
      expect(response.statusCode).toBe(400);
    }
    expect(seen.length).toBe(requests);
  });

  it('accepts verified identical audio published by a competing import on Windows', async () => {
    const target = path.join(dataDir, 'remote', 'yandex', `${digest(mp3)}.mp3`);
    fs.rmSync(target, { force: true });
    const originalRename = fsp.rename;
    let injected = false;
    const rename = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (!injected && String(to) === target) {
        injected = true;
        await fsp.copyFile(from, to);
        throw Object.assign(new Error('another import published the target'), { code: 'EEXIST' });
      }
      return originalRename(from, to);
    });
    try {
      const id = await a.services.providers.yandex.importTrack({ ...fullTrack, externalId: '780:10' });
      expect(injected).toBe(true);
      expect(a.services.lib.get(id)!.content_hash).toBe(digest(mp3));
      expect(digest(fs.readFileSync(target))).toBe(digest(mp3));
    } finally { rename.mockRestore(); }
  });

});
