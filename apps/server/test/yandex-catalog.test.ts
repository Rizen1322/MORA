import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { q } from '../src/db.ts';

type App = Awaited<ReturnType<typeof createApp>>;
type SeenRequest = { path: string; authorization: string | undefined; method: string; body?: string };
const TOKEN = 'catalog-fixture-oauth-never-real';
const SECOND_TOKEN = 'catalog-fixture-second-account';
const CATALOG = '/api/catalog/yandex';

describe('Yandex catalog metadata through a local authenticated API fixture', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-yandex-catalog-'));
  const oldApiBase = process.env.YANDEX_API_BASE;
  const seen: SeenRequest[] = [];
  let fixture: Server, base: string, a: App;
  let libraryTrackId: string;
  const artist = (id = 7) => ({
    id, name: id === 7 ? 'Fixture Artist' : 'Similar Artist', genres: ['electronic'],
    cover: { uri: id === 7 ? `${base}/images/artist/%%` : 'https://untrusted.example/artist.jpg' },
    description: { text: '<p>Fixture artist biography</p>' },
    counts: { tracks: 12, directAlbums: 3, alsoAlbums: 1 },
  });
  const album = (id = 10) => ({
    id, title: `Fixture Album ${id}`, artists: [artist()], year: 2024, type: 'single',
    trackCount: 3, available: true, coverUri: `${base}/images/album/${id}/%%`,
  });
  const track = (id: number, albumId = 10, position?: number, volume?: number) => ({
    id, title: id === 101 ? 'Fixture song' : `Fixture song ${id}`,
    ...(id === 101 ? { version: 'Live' } : {}),
    artists: [artist()], albums: [{ ...album(albumId), trackPosition: { index: position, volume } }],
    durationMs: 180000, available: id !== 102, availableForPremiumUsers: false,
    contentWarning: id === 101 ? 'explicit' : undefined,
    coverUri: id === 102 ? 'https://untrusted.example/track.jpg' : `${base}/images/track/${id}/%%`,
  });
  const albumPageTrack = (id: number, position: number) => {
    const otherRelease = track(id, 99, 3 - position, 9);
    return { ...otherRelease, albums: [...otherRelease.albums, { ...album(10), trackPosition: { index: position, volume: 1 } }] };
  };
  const json = (res: ServerResponse, result: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result }));
  };
  const requests = (pathname: string) => seen.filter((request) => new URL(request.path, base).pathname === pathname);
  const searchRequests = (query: string) => requests('/search').filter((request) => new URL(request.path, base).searchParams.get('text') === query);
  const countTracks = () => (q(a.services.db, 'SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
  const search = (query: string, suffix = '') => a.app.inject(`${CATALOG}/search?q=${encodeURIComponent(query)}${suffix}`);

  beforeAll(async () => {
    fixture = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base);
      const request: SeenRequest = { path: url.pathname + url.search, authorization: req.headers.authorization, method: req.method ?? 'GET' };
      seen.push(request);
      if (![TOKEN, SECOND_TOKEN].some((token) => req.headers.authorization === `OAuth ${token}`)) {
        return json(res, null, 401);
      }
      if (url.pathname === '/account/status') return json(res, { account: { uid: 42, displayName: 'Catalog Fixture' } });
      if (url.pathname === '/users/42/likes/tracks') return json(res, { library: { tracks: Array.from({ length: 25 }, (_, index) => ({ id: String(100 + index), albumId: '10' })) } });
      if (url.pathname === '/users/42/dislikes/tracks') return json(res, { library: { tracks: [{ id: '200', albumId: '10' }] } });
      if (url.pathname === '/tracks' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
          request.body = body;
          const ids = new URLSearchParams(body).get('track-ids') ?? '';
          json(res, ids.split(',').filter(Boolean).map((id) => track(Number(id.split(':')[0]))));
        });
        return;
      }
      if (url.pathname === '/search') {
        const text = url.searchParams.get('text') ?? '';
        if (text === 'upstream-error') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { name: 'FixtureFailure', message: `${TOKEN} ${base}/private?access_token=${TOKEN}` } }));
          return;
        }
        const type = url.searchParams.get('type') ?? 'all';
        const page = Number(url.searchParams.get('page') ?? 0);
        const tracks = page === 0 ? [track(100), track(101), track(100, 11), track(102)] : [track(105)];
        const resultType = text === 'best-artist' ? 'artist' : text === 'best-album' ? 'album' : 'track';
        const bestResult = resultType === 'artist' ? artist() : resultType === 'album' ? album() : tracks[0];
        return json(res, {
          text, best: { type: resultType, result: bestResult },
          ...(type === 'all' || type === 'track' ? { tracks: { page, perPage: 4, total: 5, results: tracks } } : {}),
          ...(type === 'all' || type === 'artist' ? { artists: { page, perPage: 1, total: 1, results: page === 0 ? [artist()] : [] } } : {}),
          ...(type === 'all' || type === 'album' ? { albums: { page, perPage: 1, total: 1, results: page === 0 ? [album()] : [] } } : {}),
        });
      }
      if (url.pathname === '/artists/7/brief-info') return json(res, {
        artist: artist(), albums: [album()], popularTracks: [track(100), track(101)], similarArtists: [artist(8)],
        stats: { lastMonthListeners: 123456 },
      });
      if (url.pathname === '/artists/7/direct-albums') {
        const page = Number(url.searchParams.get('page') ?? 0);
        return json(res, { albums: page === 0 ? [album(10), album(11)] : [album(12)], pager: { page, perPage: 2, total: 3 } });
      }
      if (url.pathname === '/albums/10/with-tracks') return json(res, {
        ...album(), description: { text: '<p>Fixture album description</p>' },
        volumes: [[albumPageTrack(103, 2), albumPageTrack(100, 1)], [track(104, 99, 9, 9)]],
      });
      if (/^\/(artists|albums)\/999\//.test(url.pathname)) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { name: 'FixtureFailure', message: `${SECOND_TOKEN} ${base}/private` } }));
        return;
      }
      json(res, null, 404);
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('catalog fixture did not bind a TCP port');
    base = `http://127.0.0.1:${address.port}`;
    process.env.YANDEX_API_BASE = base;
    a = await createApp({ dataDir, stemsPython: null, accessToken: null, port: 0, analysisWorkers: 1 }, { startWorkers: false });
    a.services.providers.store.save('yandex', {}, { token: TOKEN }, true);
  });

  afterAll(async () => {
    await a?.close();
    if (fixture) {
      const closed = new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()));
      fixture.closeAllConnections(); await closed;
    }
    if (oldApiBase === undefined) delete process.env.YANDEX_API_BASE; else process.env.YANDEX_API_BASE = oldApiBase;
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('automix-yandex-catalog-')) throw new Error('unsafe catalog fixture cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
  });

  it('maps all search sections, versions, canonical IDs, availability, and safe cover URLs without importing audio', async () => {
    const before = countTracks();
    const response = await search('fixture');
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json();
    expect(data).toMatchObject({ query: 'fixture', best: { type: 'track', id: '100:10' }, page: 0, hasMore: { tracks: true, artists: false, albums: false } });
    expect(data.tracks).toHaveLength(4);
    expect(data.tracks[0]).toMatchObject({ externalId: '100:10', title: 'Fixture song 100', artist: 'Fixture Artist', albumId: '10', duration: 180, playable: true, explicit: false, libraryTrackId: null });
    expect(data.tracks[0].artists[0]).toMatchObject({ id: '7', name: 'Fixture Artist' });
    expect(data.tracks[0].coverUrl).toBe(`${base}/images/track/100/400x400`);
    expect(data.tracks[1]).toMatchObject({ title: 'Fixture song (Live)', explicit: true });
    expect(data.tracks[2].externalId).toBe('100:11');
    expect(data.tracks[3]).toMatchObject({ playable: false, coverUrl: null });
    expect(data.artists[0]).toMatchObject({ id: '7', name: 'Fixture Artist', genres: ['electronic'], description: 'Fixture artist biography', listeners: null });
    expect(data.albums[0]).toMatchObject({ id: '10', title: 'Fixture Album 10', year: 2024, type: 'single', trackCount: 3, available: true });
    expect(countTracks()).toBe(before);
    expect(seen.some((request) => /\/download-info|\/tracks(?:\?|$)|get-mp3/.test(request.path))).toBe(false);
    expect(response.body).not.toContain(TOKEN);
  });

  it.each(['track', 'artist', 'album'] as const)('forwards search type %s and maps its best result', async (type) => {
    const query = type === 'track' ? 'best-track' : `best-${type}`;
    const response = await search(query, `&type=${type}`);
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json();
    expect(data.best).toEqual({ type, id: type === 'track' ? '100:10' : type === 'artist' ? '7' : '10' });
    expect(data[type === 'track' ? 'tracks' : type === 'artist' ? 'artists' : 'albums'].length).toBeGreaterThan(0);
    for (const section of ['tracks', 'artists', 'albums']) if (section !== `${type}s`) expect(data[section]).toEqual([]);
    const request = searchRequests(query).at(-1)!;
    expect(new URL(request.path, base).searchParams.get('type')).toBe(type);
    expect(request.authorization).toBe(`OAuth ${TOKEN}`);
  });

  it('keeps search page zero and subsequent pages separate with accurate hasMore flags', async () => {
    const first = await search('paging');
    const next = await search('paging', '&page=1');
    expect(first.statusCode, first.body).toBe(200); expect(next.statusCode, next.body).toBe(200);
    expect(first.json()).toMatchObject({ page: 0, hasMore: { tracks: true, artists: false, albums: false } });
    expect(next.json()).toMatchObject({ page: 1, hasMore: { tracks: false, artists: false, albums: false } });
    expect(next.json().tracks.map((item: { externalId: string }) => item.externalId)).toEqual(['105:10']);
    expect(searchRequests('paging').map((request) => new URL(request.path, base).searchParams.get('page'))).toEqual(['0', '1']);
  });

  it('returns an artist, popular tracks, paginated discography, and similar artists without importing them', async () => {
    const before = countTracks();
    const first = await a.app.inject(`${CATALOG}/artists/7?page=0`);
    const next = await a.app.inject(`${CATALOG}/artists/7?page=1`);
    expect(first.statusCode, first.body).toBe(200); expect(next.statusCode, next.body).toBe(200);
    const data = first.json();
    expect(data.artist).toMatchObject({ id: '7', listeners: 123456, description: 'Fixture artist biography' });
    expect(data.popularTracks.map((item: { externalId: string }) => item.externalId)).toEqual(['100:10', '101:10']);
    expect(data.similarArtists[0]).toMatchObject({ id: '8', imageUrl: null });
    expect(data.albums.map((item: { id: string }) => item.id)).toEqual(['10', '11']);
    expect(data).toMatchObject({ page: 0, hasMoreAlbums: true });
    expect(next.json()).toMatchObject({ page: 1, hasMoreAlbums: false });
    expect(next.json().albums.map((item: { id: string }) => item.id)).toEqual(['12']);
    const albumRequests = requests('/artists/7/direct-albums');
    expect(albumRequests).toHaveLength(2);
    for (const request of albumRequests) {
      const query = new URL(request.path, base).searchParams;
      expect(query.get('page-size')).toBe('20'); expect(query.get('sort-by')).toBe('year');
    }
    expect(countTracks()).toBe(before);
  });

  it('maps album discs and explicit positions, using the selected album for canonical track IDs', async () => {
    const before = countTracks();
    const response = await a.app.inject(`${CATALOG}/albums/10`);
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json();
    expect(data.album).toMatchObject({ id: '10', title: 'Fixture Album 10', trackCount: 3 });
    expect(data.description).toBe('Fixture album description');
    expect(data.tracks.map((item: { externalId: string; disc: number; position: number }) => [item.externalId, item.disc, item.position])).toEqual([
      ['100:10', 1, 1], ['103:10', 1, 2], ['104:10', 2, 1],
    ]);
    expect(data.tracks.every((item: { albumId: string }) => item.albumId === '10')).toBe(true);
    // Track 104 belongs only to release 99 in its metadata; that release's disc 9/position 9 must not leak into release 10.
    expect(data.tracks[2]).toMatchObject({ externalId: '104:10', disc: 2, position: 1 });
    expect(countTracks()).toBe(before);
  });

  it('builds a bounded home catalog from account likes without preparing audio or importing songs', async () => {
    const before = countTracks(), requestStart = seen.length;
    const response = await a.app.inject(`${CATALOG}/home`);
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json();
    expect(data).toMatchObject({ query: '', best: null, page: 0 });
    expect(data.tracks).toHaveLength(20);
    expect(data.artists.map((item: { id: string }) => item.id)).toEqual(['7']);
    expect(data.albums.map((item: { id: string }) => item.id)).toEqual(['10']);
    const newRequests = seen.slice(requestStart);
    const metadata = newRequests.filter((request) => request.path === '/tracks');
    expect(metadata).toHaveLength(1); expect(metadata[0].method).toBe('POST');
    expect(new URLSearchParams(metadata[0].body).get('track-ids')?.split(',')).toHaveLength(20);
    expect(newRequests.some((request) => /download-info|get-mp3|\/audio\//.test(request.path))).toBe(false);
    expect(countTracks()).toBe(before);
    // Home refreshes the account reaction snapshot; later metadata-only searches reuse it without listing likes again.
    expect(data.tracks[0]).toMatchObject({ externalId: '100:10', reaction: 1 });
    const listed = requests('/users/42/likes/tracks').length;
    const searched = await search('fixture');
    expect(searched.json().tracks[0]).toMatchObject({ externalId: '100:10', reaction: 1 });
    expect(requests('/users/42/likes/tracks')).toHaveLength(listed);
  });

  it('reuses cached metadata while annotating exact canonical library IDs afresh', async () => {
    const first = await search('fresh-library');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().tracks[0].libraryTrackId).toBeNull();
    libraryTrackId = a.services.lib.addRemote({ provider: 'yandex', externalId: '100:10', title: 'Fixture song 100', artist: 'Fixture Artist', duration: 180, meta: {} }).id;
    const before = countTracks();
    const second = await search('fresh-library');
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().tracks[0].libraryTrackId).toBe(libraryTrackId);
    expect(second.json().tracks[2].libraryTrackId).toBeNull();
    expect(searchRequests('fresh-library')).toHaveLength(1);
    const albumResponse = await a.app.inject(`${CATALOG}/albums/10`);
    expect(albumResponse.json().tracks[0].libraryTrackId).toBe(libraryTrackId);
    expect(countTracks()).toBe(before);
  });

  it('evicts old search entries once the bounded metadata cache is full', async () => {
    await search('cache-oldest'); await search('cache-oldest');
    expect(searchRequests('cache-oldest')).toHaveLength(1);
    for (let index = 0; index < 41; index++) {
      const response = await search(`cache-new-${index}`);
      expect(response.statusCode, response.body).toBe(200);
    }
    await search('cache-oldest');
    expect(searchRequests('cache-oldest')).toHaveLength(2);
  });

  it('coalesces concurrent search requests and refreshes expired metadata', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => search('cache-expiry')));
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    expect(searchRequests('cache-expiry')).toHaveLength(1);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120001);
    try {
      const refreshed = await search('cache-expiry');
      expect(refreshed.statusCode, refreshed.body).toBe(200);
      expect(searchRequests('cache-expiry')).toHaveLength(2);
    } finally { now.mockRestore(); }
  });

  it.each([
    '/search?q=', '/search?q=%20%20', '/search?q=fixture&page=-1', '/search?q=fixture&page=1.5',
    '/search?q=fixture&page=abc', '/search?q=fixture&type=playlist', '/artists/nope', '/albums/10x',
    '/artists/..%2F7', '/albums/..%2F10', '/artists/7?page=-1',
  ])('rejects invalid catalog input %s before calling the upstream API', async (route) => {
    const before = seen.length;
    const response = await a.app.inject(`${CATALOG}${route}`);
    expect(response.statusCode, response.body).toBe(400);
    expect(seen).toHaveLength(before);
  });

  it.each(['/search?q=upstream-error', '/artists/999', '/albums/999'])('sanitizes upstream failures at %s', async (route) => {
    const response = await a.app.inject(`${CATALOG}${route}`);
    expect(response.statusCode, response.body).toBe(502);
    expect(Object.keys(response.json())).toEqual(['error']);
    expect(response.json().error).toEqual(expect.any(String));
    for (const secret of [TOKEN, SECOND_TOKEN, base, 'access_token', 'FixtureFailure', 'stack']) expect(response.body).not.toContain(secret);
  });

  it('clears cached metadata after account changes and checks credentials even for cached pages', async () => {
    expect((await search('account-cache')).statusCode).toBe(200);
    expect((await search('account-cache')).statusCode).toBe(200);
    expect(searchRequests('account-cache')).toHaveLength(1);
    const connect = (token: string) => a.app.inject({ method: 'POST', url: '/api/providers/yandex/connect', payload: { secret: { token } } });
    const connected = await connect(SECOND_TOKEN);
    expect(connected.statusCode, connected.body).toBe(200);
    expect((await search('account-cache')).statusCode).toBe(200);
    expect(searchRequests('account-cache')).toHaveLength(2);
    expect(searchRequests('account-cache').at(-1)?.authorization).toBe(`OAuth ${SECOND_TOKEN}`);
    const disconnected = await a.app.inject({ method: 'POST', url: '/api/providers/yandex/disconnect' });
    expect(disconnected.statusCode, disconnected.body).toBe(200);
    const before = seen.length;
    for (const route of ['/search?q=account-cache', '/artists/7', '/albums/10', '/home']) {
      const response = await a.app.inject(`${CATALOG}${route}`);
      expect(response.statusCode, response.body).toBe(409);
      expect(response.body).not.toContain(TOKEN);
    }
    expect(seen).toHaveLength(before);
    // Restore only the fixture credential so this request proves disconnect cleared the cache itself.
    a.services.providers.store.save('yandex', {}, { token: TOKEN }, true);
    expect((await search('account-cache')).statusCode).toBe(200);
    expect(searchRequests('account-cache')).toHaveLength(3);
  });
});
