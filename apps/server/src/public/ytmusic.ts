/**
 * Public YouTube Music web endpoints (no account): song search and radio
 * ("up next"). Idea and request shape adapted from Riff (MIT, (c) rootscripts,
 * https://github.com/rootscripts/riff, server.js at add6843): WEB_REMIX search
 * with the songs filter. Here: bounded response size, timeout, AbortSignal,
 * a circuit breaker per endpoint and a parser that keeps the source's own
 * explicit badge and artist/album ids.
 */

const CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20260101.01.00', hl: 'ru', gl: 'RU' };
const SONGS = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
const VIDEOS = 'EgWKAQIQAWoMEA4QChADEAQQCRAF';
const MAX_BYTES = 4 << 20;

export interface YtmItem {
  videoId: string;
  title: string;
  artist: string;
  artistId: string | null;
  album: string;
  albumId: string | null;
  duration: number;
  thumbnail: string | null;
  /** Declared by YouTube Music itself (MUSIC_EXPLICIT_BADGE). */
  explicit: boolean;
  kind: 'song' | 'video';
}

const breakers = new Map<string, { fails: number; until: number }>();
let transport: typeof fetch = (...args) => fetch(...args);
/** Desktop uses Chromium networking, including the system proxy configuration. */
export function setYtmTransport(fetcher: typeof fetch): void { transport = fetcher; }


export async function requestYtm(endpoint: 'search' | 'next' | 'browse', body: Record<string, unknown>, signal?: AbortSignal, service: 'music' | 'youtube' = 'music'): Promise<unknown> {
  if (signal?.aborted) throw new Error('Отменено');
  const key = `${service}:${endpoint}`;
  let breaker = breakers.get(key);
  if (!breaker) { breaker = { fails: 0, until: 0 }; breakers.set(key, breaker); }
  const origin = service === 'music' ? 'https://music.youtube.com' : 'https://www.youtube.com';
  if (Date.now() < breaker.until) throw new Error('YouTube Music временно не отвечает');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const abort = () => ctl.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const res = await transport(`${origin}/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      redirect: 'error',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        origin,
        referer: `${origin}/`,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      },
      body: JSON.stringify({ context: { client: service === 'music' ? CLIENT : { ...CLIENT, clientName: 'WEB' } }, ...body }),
    });
    if (!res.ok) throw new Error(`YouTube Music: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) throw new Error('YouTube Music: слишком большой ответ');
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('YouTube Music: слишком большой ответ');
    breaker.fails = 0;
    breaker.until = 0;
    return JSON.parse(text);
  } catch (e) {
    if (!signal?.aborted && ++breaker.fails >= 3) { breaker.until = Date.now() + 15_000; breaker.fails = 0; }
    throw signal?.aborted ? new Error('Отменено') : e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export function parseDuration(text: string): number {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(text.trim())) return 0;
  return text.trim().split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
}

type Run = { text: string; navigationEndpoint?: { browseEndpoint?: { browseId?: string; browseEndpointContextSupportedConfigs?: { browseEndpointContextMusicConfig?: { pageType?: string } } } } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function bestThumb(list: { url: string; width?: number }[] | undefined): string | null {
  if (!list?.length) return null;
  const url = list[list.length - 1].url;
  return /^https:\/\//.test(url) ? url.replace(/=w\d+-h\d+[^&]*$/, '=w544-h544') : null;
}

/** Parses musicResponsiveListItemRenderer rows (search shelves). */
export function parseSearch(json: Any, kind: 'song' | 'video'): YtmItem[] {
  const out: YtmItem[] = [];
  const sections = json?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents ?? [];
  for (const section of sections) {
    for (const wrap of section?.musicShelfRenderer?.contents ?? []) {
      const r = wrap?.musicResponsiveListItemRenderer;
      if (!r) continue;
      const cols = r.flexColumns ?? [];
      const runs = (i: number): Run[] => cols[i]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
      const videoId: string | undefined = r.playlistItemData?.videoId ?? r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
      if (!videoId || !/^[\w-]{11}$/.test(videoId)) continue;
      const title = runs(0).map((x) => x.text).join('').trim();
      const meta = runs(1);
      const pageOf = (x: Run) => x.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
      const artists = meta.filter((x) => pageOf(x) === 'MUSIC_PAGE_TYPE_ARTIST' || pageOf(x) === 'MUSIC_PAGE_TYPE_USER_CHANNEL');
      const albumRun = meta.find((x) => pageOf(x) === 'MUSIC_PAGE_TYPE_ALBUM');
      const parts = meta.map((x) => x.text).join('').split(' • ').map((s) => s.trim()).filter(Boolean);
      const duration = parts.length ? parseDuration(parts[parts.length - 1]) : 0;
      const artist = artists.length ? artists.map((a) => a.text).join(', ') : (parts[0] ?? '').replace(/\s*-\s*Topic$/i, '');
      const explicit = (r.badges ?? []).some((b: Any) => b?.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE');
      if (!title || (duration && duration < 30)) continue;
      out.push({
        videoId, title, artist: artist.trim() || 'Неизвестный исполнитель',
        artistId: artists.find((x) => pageOf(x) === 'MUSIC_PAGE_TYPE_ARTIST')?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
        album: albumRun?.text ?? '', albumId: albumRun?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
        duration, thumbnail: bestThumb(r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails), explicit, kind,
      });
    }
  }
  return out;
}

/** Parses the "up next" radio playlist of /next. */
export function parseNext(json: Any): YtmItem[] {
  const tabs = json?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs ?? [];
  const items = tabs[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents ?? [];
  const out: YtmItem[] = [];
  for (const wrap of items) {
    const r = wrap?.playlistPanelVideoRenderer ?? wrap?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
    const videoId: string | undefined = r?.videoId;
    if (!r || !videoId || !/^[\w-]{11}$/.test(videoId)) continue;
    const by: Run[] = r.longBylineText?.runs ?? [];
    const pageOf = (x: Run) => x.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
    const artists = by.filter((x) => pageOf(x) === 'MUSIC_PAGE_TYPE_ARTIST');
    const albumRun = by.find((x) => pageOf(x) === 'MUSIC_PAGE_TYPE_ALBUM');
    const title = (r.title?.runs ?? []).map((x: Run) => x.text).join('').trim();
    const duration = parseDuration(r.lengthText?.runs?.[0]?.text ?? '');
    const explicit = (r.badges ?? []).some((b: Any) => b?.musicInlineBadgeRenderer?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE');
    if (!title || (duration && duration < 30)) continue;
    out.push({
      videoId, title, artist: (artists.length ? artists.map((a) => a.text).join(', ') : by[0]?.text ?? '').trim() || 'Неизвестный исполнитель',
      artistId: artists.find((x) => pageOf(x) === 'MUSIC_PAGE_TYPE_ARTIST')?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
      album: albumRun?.text ?? '', albumId: albumRun?.navigationEndpoint?.browseEndpoint?.browseId ?? null,
      duration, thumbnail: bestThumb(r.thumbnail?.thumbnails), explicit, kind: 'song',
    });
  }
  return out;
}

export async function searchYtm(query: string, kind: 'song' | 'video', signal?: AbortSignal): Promise<YtmItem[]> {
  const q = query.trim().slice(0, 200);
  if (!q) return [];
  return parseSearch(await requestYtm('search', { query: q, params: kind === 'song' ? SONGS : VIDEOS }, signal), kind);
}

/** YouTube Music's own radio for a recording: what the service itself plays next. */
export async function radioYtm(videoId: string, signal?: AbortSignal): Promise<YtmItem[]> {
  if (!/^[\w-]{11}$/.test(videoId)) throw new Error('Некорректный ID');
  return parseNext(await requestYtm('next', { videoId, playlistId: `RDAMVM${videoId}`, isAudioOnly: true }, signal)).filter((x) => x.videoId !== videoId);
}
