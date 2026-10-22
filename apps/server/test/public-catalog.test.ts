import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { PublicCatalog, parsePublicCatalog } from '../src/public/catalog.ts';
import { registerPublicCatalogRoutes } from '../src/routes/public-catalog.ts';
import type { Services } from '../src/app.ts';

const artistId = 'UCOd9uX6JP374Wgu9c0m4qlw', albumId = 'MPREb_Br5t7blIZ0N';
const run = (text: string, id: string, type: string) => ({ text, navigationEndpoint: { browseEndpoint: { browseId: id, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: type } } } } });
const artist = run('Исполнитель', artistId, 'MUSIC_PAGE_TYPE_ARTIST');
const row = (id = '5IC-IHxp8lU') => ({ musicResponsiveListItemRenderer: { playlistItemData: { videoId: id },
  flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Песня' }] } } }, { musicResponsiveListItemFlexColumnRenderer: { text: {} } }],
  fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '2:38' }] } } }],
  badges: [{ musicInlineBadgeRenderer: { icon: { iconType: 'MUSIC_EXPLICIT_BADGE' } } }] } });
const album = () => ({ contents: { twoColumnBrowseResultsRenderer: {
  tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicResponsiveHeaderRenderer: {
    title: { runs: [{ text: 'Альбом' }] }, straplineTextOne: { runs: [artist] },
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: 'https://yt3.googleusercontent.com/cover=w544-h544' }] } } },
  } }] } } } }],
  secondaryContents: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [row(), row(), row('fAbCGcOZNFo')] } }] } },
} } });
const artistPage = () => ({ header: { musicImmersiveHeaderRenderer: { title: { runs: [{ text: 'Исполнитель' }] } } },
  contents: { singleColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [
    { musicShelfRenderer: { contents: [row()] } },
    { musicCarouselShelfRenderer: { contents: [{ musicTwoRowItemRenderer: { title: { runs: [run('Альбом', albumId, 'MUSIC_PAGE_TYPE_ALBUM')] } } }] } },
  ] } } } }] } } });

describe('public musical catalog', () => {
  it('reads current two-column album layout, fixed-column duration and authoritative header artist', () => {
    const data = parsePublicCatalog(album(), 'album', albumId);
    expect(data).toMatchObject({ title: 'Альбом', type: 'album', limited: false, artists: [{ id: artistId, name: 'Исполнитель' }] });
    expect(data.tracks).toHaveLength(2);
    expect(data.tracks[0]).toMatchObject({ duration: 158, artistId, artist: 'Исполнитель', album: 'Альбом', albumId, explicit: true });
    expect(data.tracks[0].thumbnail).toContain('googleusercontent.com');
  });
  it('keeps artist page albums and flags that artist shelves are a preview', () => {
    const data = parsePublicCatalog(artistPage(), 'artist', artistId);
    expect(data.limited).toBe(true);
    expect(data.albums).toEqual([{ id: albumId, title: 'Альбом', artist: 'Исполнитель', coverUrl: null }]);
    expect(data.tracks).toHaveLength(1);
  });
  it('rejects arbitrary channel headers, malformed ids and non-https/foreign thumbnail URLs', () => {
    expect(() => parsePublicCatalog({ header: { musicVisualHeaderRenderer: { title: { runs: [{ text: 'Uploader' }] } } } }, 'artist', artistId)).toThrow('Музыкальная страница');
    for (const id of ['../../x', 'UCbad', 'https://example.com', 'MPREbad']) expect(() => parsePublicCatalog(artistPage(), 'artist', id)).toThrow('Некорректный ID');
    const input = album();
    const h = input.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].musicResponsiveHeaderRenderer;
    h.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails[0].url = 'https://evil.example/track';
    expect(parsePublicCatalog(input, 'album', albumId).coverUrl).toBe(null);
  });
  it('takes tracks only from content shelves and never expands menu queue commands', () => {
    const input = album() as any;
    input.contents.twoColumnBrowseResultsRenderer.secondaryContents.sectionListRenderer.contents[0].musicShelfRenderer.contents.push({ menuRenderer: { items: [row('bXcDefGh123')] } });
    expect(parsePublicCatalog(input, 'album', albumId).tracks).toHaveLength(2);
  });
  it('bounds oversized shelves and does not treat user channels as confirmed artist credits', () => {
    const input = album() as any;
    const shelf = input.contents.twoColumnBrowseResultsRenderer.secondaryContents.sectionListRenderer.contents[0].musicShelfRenderer;
    shelf.contents = Array.from({ length: 150 }, (_, i) => row(`id${String(i).padStart(9, '0')}`));
    const data = parsePublicCatalog(input, 'album', albumId);
    expect(data.tracks).toHaveLength(100); expect(data.limited).toBe(true);
    const header = input.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].musicResponsiveHeaderRenderer;
    header.straplineTextOne.runs = [run('Uploader', artistId, 'MUSIC_PAGE_TYPE_USER_CHANNEL')];
    expect(parsePublicCatalog(input, 'album', albumId).artists).toEqual([]);
    expect(parsePublicCatalog(input, 'album', albumId).tracks[0].artistId).toBe(null);
  });
  it('shares one browse request, keeps individual cancellation and caches only success', async () => {
    let finish!: (data: unknown) => void;
    const request = vi.fn(() => new Promise(resolve => { finish = resolve; })) as any;
    const catalog = new PublicCatalog(request), ctl = new AbortController();
    const one = catalog.get('album', albumId, ctl.signal).catch(e => e.message), two = catalog.get('album', albumId);
    await Promise.resolve(); ctl.abort(); finish(album());
    expect(await one).toBeTruthy(); expect((await two).tracks).toHaveLength(2);
    await catalog.get('album', albumId);
    expect(request).toHaveBeenCalledTimes(1);
    const failing = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(album());
    const retry = new PublicCatalog(failing);
    await expect(retry.get('album', albumId)).rejects.toThrow('offline');
    expect((await retry.get('album', albumId)).title).toBe('Альбом');
  });
  it('registers playable server metadata and looks up library identities on every cached page response', async () => {
    const rememberYtm = vi.fn(items => items.map((x: any) => ({ externalId: x.videoId, title: x.title })));
    const known = vi.fn(() => new Map([['5IC-IHxp8lU', 'local-123']]));
    const app = Fastify();
    registerPublicCatalogRoutes(app, { publicMusic: { rememberYtm, known } } as unknown as Services, new PublicCatalog(vi.fn().mockResolvedValue(album())));
    try {
      const result = await app.inject({ method: 'GET', url: `/api/catalog/public/albums/${albumId}` });
      expect(result.statusCode).toBe(200);
      expect(result.json().tracks[0].libraryTrackId).toBe('local-123');
      expect(rememberYtm).toHaveBeenCalledTimes(1);
      expect((await app.inject({ method: 'GET', url: '/api/catalog/public/artists/UCbad' })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
