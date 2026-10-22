import { parseDuration, requestYtm, type YtmItem } from './ytmusic.ts';
import { SharedPreparation } from './shared-preparation.ts';

type Json = Record<string, any>;
export interface PublicCatalogRef { id: string; name: string }
export interface PublicCatalogAlbum { id: string; title: string; coverUrl: string | null; artist: string }
export interface ParsedPublicCatalog {
  id: string; type: 'artist' | 'album'; title: string; description: string; coverUrl: string | null;
  source: 'ytmusic'; tracks: YtmItem[]; albums: PublicCatalogAlbum[]; artists: PublicCatalogRef[]; limited: boolean;
}
export class PublicCatalogError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
export function validCatalogId(type: 'artist' | 'album', id: string): boolean {
  return type === 'artist' ? /^UC[\w-]{22}$/.test(id) : /^MPRE[\w-]{6,80}$/.test(id);
}
const text = (value: Json | undefined): string => typeof value?.simpleText === 'string' ? value.simpleText.slice(0, 4000)
  : Array.isArray(value?.runs) ? value.runs.map((r: Json) => typeof r.text === 'string' ? r.text : '').join('').slice(0, 4000) : '';
const endpoint = (run: Json | undefined) => run?.navigationEndpoint?.browseEndpoint;
const pageType = (e: Json | undefined) => e?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
function refs(runs: Json[]): PublicCatalogRef[] {
  const out = new Map<string, PublicCatalogRef>();
  for (const run of runs) {
    const e = endpoint(run), name = text({ runs: [run] }).trim();
    if (name && pageType(e) === 'MUSIC_PAGE_TYPE_ARTIST' && validCatalogId('artist', e.browseId)) out.set(e.browseId, { id: e.browseId, name });
  }
  return [...out.values()];
}
function thumb(renderer: Json | undefined): string | null {
  const list = renderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? renderer?.thumbnails;
  if (!Array.isArray(list)) return null;
  const sizeDistance = (item: Json) => typeof item?.width === 'number' ? Math.abs(item.width - 640) : 10000;
  for (const item of [...list].sort((a, b) => sizeDistance(a) - sizeDistance(b))) {
    if (typeof item?.url !== 'string') continue;
    try {
      const url = new URL(item.url);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && /(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com)$/.test(url.hostname)) return url.href;
    } catch { /* malformed upstream thumbnail */ }
  }
  return null;
}
const sectionsOf = (json: Json): Json[] => json?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents
  ?? json?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents ?? [];

/** Parse only content shelves: menu/queue commands must never become visible tracks. */
export function parsePublicCatalog(json: Json, type: 'artist' | 'album', id: string): ParsedPublicCatalog {
  if (!validCatalogId(type, id)) throw new PublicCatalogError('Некорректный ID каталога', 400);
  const primary = json?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  const header = type === 'artist' ? json?.header?.musicImmersiveHeaderRenderer
    : json?.header?.musicDetailHeaderRenderer ?? primary.find((x: Json) => x.musicResponsiveHeaderRenderer)?.musicResponsiveHeaderRenderer;
  const title = text(header?.title).trim();
  if (!title || (type === 'album' && !json?.contents?.twoColumnBrowseResultsRenderer && !json?.header?.musicDetailHeaderRenderer))
    throw new PublicCatalogError(type === 'artist' ? 'Музыкальная страница исполнителя не найдена' : 'Альбом не найден', 404);
  const artists = refs([...(header?.straplineTextOne?.runs ?? []), ...(header?.subtitle?.runs ?? [])]);
  if (type === 'artist') artists.unshift({ id, name: title });
  const coverUrl = thumb(header?.thumbnail) ?? thumb(json?.microformat?.microformatDataRenderer?.thumbnail);
  const tracks: YtmItem[] = [], albums: PublicCatalogAlbum[] = [];
  const seen = new Set<string>(), seenAlbums = new Set<string>();
  let limited = type === 'artist'; // Artist shelves are previews, not the complete discography.
  for (const section of sectionsOf(json).slice(0, 30)) {
    const shelf = section.musicShelfRenderer ?? section.musicCarouselShelfRenderer ?? section.musicPlaylistShelfRenderer;
    if (!shelf) continue;
    if (shelf.continuations?.length) limited = true;
    for (const wrap of (shelf.contents ?? []).slice(0, 200)) {
      const row = wrap.musicResponsiveListItemRenderer;
      if (row) {
        const columns = (row.flexColumns ?? []).map((x: Json) => x.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? []);
        const videoId = row.playlistItemData?.videoId ?? row.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
        const name = text({ runs: columns[0] }).trim();
        if (!/^[\w-]{11}$/.test(videoId ?? '') || !name || seen.has(videoId) || row.musicItemRendererDisplayPolicy === 'MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT') continue;
        const meta: Json[] = columns.slice(1).flat();
        const credits = refs(meta), albumRun = meta.find(r => pageType(endpoint(r)) === 'MUSIC_PAGE_TYPE_ALBUM');
        const fixed = row.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text;
        const duration = parseDuration(text(fixed)) || meta.map(r => parseDuration(r.text ?? '')).find(Boolean) || 0;
        seen.add(videoId);
        tracks.push({ videoId, title: name, artist: credits.length ? credits.map(a => a.name).join(', ') : artists.map(a => a.name).join(', ') || 'Неизвестный исполнитель',
          artistId: credits[0]?.id ?? artists[0]?.id ?? null, album: type === 'album' ? title : albumRun?.text ?? '',
          albumId: type === 'album' ? id : validCatalogId('album', endpoint(albumRun)?.browseId ?? '') ? endpoint(albumRun).browseId : null,
          duration, thumbnail: thumb(row.thumbnail) ?? coverUrl, explicit: (row.badges ?? []).some((b: Json) => b.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE'), kind: 'song' });
        if (tracks.length === 100) { limited = true; break; }
      }
      const card = wrap.musicTwoRowItemRenderer;
      const e = endpoint(card?.title?.runs?.[0]) ?? card?.navigationEndpoint?.browseEndpoint;
      if (card && pageType(e) === 'MUSIC_PAGE_TYPE_ALBUM' && validCatalogId('album', e.browseId) && !seenAlbums.has(e.browseId) && albums.length < 40) {
        seenAlbums.add(e.browseId);
        albums.push({ id: e.browseId, title: text(card.title), coverUrl: thumb(card.thumbnailRenderer), artist: refs(card.subtitle?.runs ?? []).map(a => a.name).join(', ') || artists.map(a => a.name).join(', ') });
      }
    }
    if (tracks.length >= 100) break;
  }
  return { id, type, title, source: 'ytmusic', coverUrl, description: text(header?.description) || text(header?.secondSubtitle), artists, tracks, albums, limited };
}

export class PublicCatalog {
  private cache = new Map<string, { until: number; data: ParsedPublicCatalog }>();
  private jobs = new SharedPreparation<ParsedPublicCatalog>();
  constructor(private request: typeof requestYtm = requestYtm) {}
  async get(type: 'artist' | 'album', id: string, signal?: AbortSignal): Promise<ParsedPublicCatalog> {
    if (!validCatalogId(type, id)) throw new PublicCatalogError('Некорректный ID каталога', 400);
    if (signal?.aborted) throw new Error('Отменено');
    const key = `${type}:${id}`, cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) { this.cache.delete(key); this.cache.set(key, cached); return cached.data; }
    return this.jobs.run(key, { signal }, async abort => {
      const data = parsePublicCatalog(await this.request('browse', { browseId: id }, abort) as Json, type, id);
      this.cache.delete(key); this.cache.set(key, { until: Date.now() + 5 * 60_000, data });
      while (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
      return data;
    });
  }
}
