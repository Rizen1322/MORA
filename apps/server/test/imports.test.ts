import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { classify, parseCollectionFile } from '../src/public/collections.ts';
import { versionLabels } from '../src/public/match.ts';
import type { PublicTrack } from '../src/public/provider.ts';

describe('collection links and files', () => {
  it('recognises supported links only', () => {
    expect(classify('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=x')).toEqual({ kind: 'spotify-playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
    expect(classify('spotify:album:4aawyAB9vmqN3uQ7FjRGTy')?.kind).toBe('spotify-album');
    expect(classify('https://music.apple.com/ru/album/x/1440857781')).toEqual({ kind: 'apple-album', id: '1440857781' });
    expect(classify('https://music.youtube.com/playlist?list=PLabcdefghij12345')?.kind).toBe('youtube');
    expect(classify('https://soundcloud.com/artist/sets/best')?.kind).toBe('soundcloud');
    for (const bad of ['http://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'https://evil.example/playlist?list=PLx', 'not a url']) expect(classify(bad)).toBeNull();
  });

  it('parses CSV with quotes, keeps order and intentional repeats', () => {
    const c = parseCollectionFile('my.csv', 'Track Name,Artist Name(s),Album Name,Duration (ms),ISRC\n"Hello, World",A,Alb,180000,USAAA1\nSong,B,,200000,\n"Hello, World",A,Alb,180000,USAAA1\n');
    expect(c.items.map((i) => i.title)).toEqual(['Hello, World', 'Song', 'Hello, World']);
    expect(c.items[0]).toMatchObject({ artist: 'A', duration: 180, isrc: 'USAAA1', position: 0 });
    expect(c.name).toBe('my');
  });

  it('parses M3U and JSON exports', () => {
    const m3u = parseCollectionFile('x.m3u8', '#EXTM3U\n#EXTINF:215,Yanix - Верить\nC:\\music\\a.mp3\nD:/b/Artist - Track.flac\n');
    expect(m3u.items).toMatchObject([{ artist: 'Yanix', title: 'Верить', duration: 215 }, { artist: 'Artist', title: 'Track' }]);
    const json = parseCollectionFile('x.json', JSON.stringify({ tracks: [{ track: { name: 'A', artists: [{ name: 'B' }], duration_ms: 123000, external_ids: { isrc: 'X1' } } }] }));
    expect(json.items[0]).toMatchObject({ title: 'A', artist: 'B', duration: 123, isrc: 'X1' });
    expect(() => parseCollectionFile('x.csv', 'foo,bar\n1,2\n')).toThrow();
  });
});

describe('import jobs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automix-import-'));
  let a: Awaited<ReturnType<typeof createApp>>;
  let searches = 0;
  const result = (id: string, title: string, artist: string, duration: number): PublicTrack => ({
    externalId: id, title, artist, album: '', duration, coverUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, pageUrl: null, license: null, playable: true, source: 'ytmusic', audioProvider: 'youtube',
    kind: 'song', explicit: false, uploader: artist, labels: versionLabels(title), artistId: null, albumId: null,
  });
  beforeAll(async () => {
    a = await createApp({ dataDir: path.join(dir, 'data'), analysisWorkers: 1, stemsPython: null, port: 0 }, { startWorkers: false });
    a.services.publicMusic.search = async (_s, q) => {
      searches++;
      if (q.includes('Верить')) return [result('fAbCGcOZNFo', 'Верить', 'Yanix', 209)];
      if (q.includes('Song A')) return [result('aaaaaaaaaaa', 'Song A (Live)', 'C', 300)];
      return [];
    };
  });
  afterAll(async () => { await a?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const wait = async (id: string) => {
    for (let i = 0; i < 200; i++) { const j = a.services.imports.get(id)!; if (j.state !== 'matching') return j; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('matching did not finish');
  };

  it('matches confidently, flags doubtful and missing items, searches each song once', async () => {
    const csv = 'Title,Artist,Duration\nВерить,Yanix,3:29\nSong A,C,3:00\nUnknown,Nobody,2:00\nВерить,Yanix,3:29\n';
    const res = await a.app.inject({ method: 'POST', url: '/api/imports', payload: { file: { name: 'mix.csv', text: csv } } });
    expect(res.statusCode, res.body).toBe(200);
    const j = await wait(res.json().id);
    expect(j.rows.map((r) => r.status)).toEqual(['matched', 'missing', 'missing', 'matched']);
    expect(searches).toBe(4); // Верить once (the repeat reuses it), Song A once, Unknown on two sources
    // Importing the same file again returns the same job.
    expect((await a.app.inject({ method: 'POST', url: '/api/imports', payload: { file: { name: 'mix.csv', text: csv } } })).json().id).toBe(j.id);
  });

  it('creates one playlist in source order with repeats; creating again does not duplicate; resolving a gap fills its position', async () => {
    const j = a.services.imports.list()[0];
    const first = (await a.app.inject({ method: 'POST', url: `/api/imports/${j.id}/playlist`, payload: {} })).json();
    const again = (await a.app.inject({ method: 'POST', url: `/api/imports/${j.id}/playlist`, payload: {} })).json();
    expect(again.playlistId).toBe(first.playlistId);
    const rows = () => a.services.db.prepare('SELECT track_id, position FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(first.playlistId) as { track_id: string; position: number }[];
    expect(rows().map((r) => r.position)).toEqual([0, 30]);
    expect(rows()[0].track_id).toBe(rows()[1].track_id);
    expect(a.services.lib.get(rows()[0].track_id)).toMatchObject({ saved: 1, provider: 'youtube' });
    expect(JSON.parse(a.services.lib.sources(rows()[0].track_id)[0].meta).coverUrl).toBe('https://i.ytimg.com/vi/fAbCGcOZNFo/hqdefault.jpg');
    await a.app.inject({ method: 'POST', url: `/api/imports/${j.id}/resolve`, payload: { position: 2, choice: { provider: 'youtube', externalId: 'bbbbbbbbbbb', title: 'Unknown', artist: 'Nobody', duration: 120, coverUrl: null, labels: [] } } });
    expect(rows().map((r) => r.position)).toEqual([0, 20, 30]);
  });

  it('keeps each row bound to its own playlist entry after a manual reorder, and skipping removes it', async () => {
    const j = a.services.imports.list()[0];
    const playlistId = a.services.imports.get(j.id)!.playlistId!;
    const entries = () => a.services.db.prepare('SELECT id, track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(playlistId) as { id: number; track_id: string }[];
    const [first, gap, repeat] = entries();
    expect(first.track_id).toBe(repeat.track_id);
    // Listener moves the resolved gap to the top, then refreshes the import.
    expect((await a.app.inject({ method: 'PUT', url: `/api/playlists/${playlistId}/order`, payload: { entryIds: [gap.id, first.id, repeat.id] } })).statusCode).toBe(200);
    await a.app.inject({ method: 'POST', url: `/api/imports/${j.id}/playlist`, payload: {} });
    expect(entries()).toEqual([gap, first, repeat]);
    // Skipping the row afterwards takes its entry out of the playlist.
    await a.app.inject({ method: 'POST', url: `/api/imports/${j.id}/resolve`, payload: { position: 2, choice: null } });
    expect(entries()).toEqual([first, repeat]);
  });

  it('keeps a bounded number of reports and drops search results once matching ends', async () => {
    for (let i = 0; i < 25; i++) await wait(a.services.imports.fromFile(`n${i}.csv`, `Title,Artist\nSong ${i},Nobody\n`).id);
    expect(a.services.imports.list()).toHaveLength(20);
    expect((a.services.imports as unknown as { searchCache: Map<string, unknown> }).searchCache.size).toBe(0);
  });
});
