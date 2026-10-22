/**
 * Reading public collections (playlists/albums) as metadata lists. Ideas from
 * Riff (MIT, (c) rootscripts, server.js at add6843): Spotify embed page data,
 * Apple Music serialized page data and the iTunes lookup API. Here: order and
 * intentional repeats are kept, partial reads are reported as partial, and all
 * requests are bounded (size, time, redirects, hosts).
 */
import type { YtDlp } from './ytdlp.ts';

export interface CollectionItem { position: number; title: string; artist: string; album?: string; duration?: number; isrc?: string | null; source?: { provider: 'youtube' | 'soundcloud'; externalId: string } }
export interface Collection {
  source: 'spotify' | 'apple' | 'youtube' | 'soundcloud' | 'file';
  name: string;
  cover: string | null;
  /** How many items the source says the collection has (null = unknown). */
  total: number | null;
  items: CollectionItem[];
  /** false when only part of the list could be read. */
  complete: boolean;
  note?: string;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const ALLOWED = [/^open\.spotify\.com$/, /^api-partner\.spotify\.com$/, /^music\.apple\.com$/, /^itunes\.apple\.com$/];

async function fetchText(url: string, init: RequestInit = {}, maxBytes = 6 << 20): Promise<{ status: number; body: string }> {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== 'https:' || !ALLOWED.some((re) => re.test(u.hostname))) throw new Error('Адрес не относится к поддерживаемому сервису');
    const res = await fetch(u, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': UA, 'accept-language': 'ru,en;q=0.8', ...(init.headers ?? {}) } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location')!, u); continue; }
    const body = await res.text();
    if (body.length > maxBytes) throw new Error('Слишком большой ответ сервиса');
    return { status: res.status, body };
  }
  throw new Error('Слишком много перенаправлений');
}

const reasonFor = (status: number) => (status === 404 ? 'Коллекция не найдена' : status === 401 || status === 403 ? 'Коллекция закрыта или доступна только после входа' : status === 429 ? 'Сервис просит подождать — попробуйте позже' : `Сервис ответил ${status}`);

// ---------------------------------------------------------------- Spotify

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function spotify(kind: 'playlist' | 'album', id: string): Promise<Collection> {
  const page = await fetchText(`https://open.spotify.com/embed/${kind}/${id}`);
  if (page.status !== 200) throw new Error(reasonFor(page.status));
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(page.body);
  if (!m) throw new Error('Не удалось прочитать страницу Spotify');
  const props = JSON.parse(m[1])?.props?.pageProps;
  const entity = props?.state?.data?.entity ?? {};
  const name: string = entity.name ?? entity.title ?? 'Плейлист Spotify';
  const cover: string | null = entity.coverArt?.sources?.[0]?.url ?? entity.images?.[0]?.url ?? null;
  const embedItems: CollectionItem[] = (Array.isArray(entity.trackList) ? entity.trackList : []).map((t: Any, i: number) => ({
    position: i, title: String(t.title ?? t.name ?? '').trim(), artist: String(t.subtitle ?? t.artist ?? '').replace(/ /g, ' ').trim(),
    duration: typeof t.duration === 'number' ? Math.round(t.duration / 1000) : undefined,
  })).filter((t: CollectionItem) => t.title);
  // Full list (with pagination) when Spotify offers its web player query to this anonymous session.
  const token: string | undefined = props?.state?.settings?.session?.accessToken;
  if (kind === 'playlist' && token) {
    try {
      const all: CollectionItem[] = [];
      let total = Infinity;
      for (let offset = 0; offset < total && offset < 10000;) {
        const r = await fetchText('https://api-partner.spotify.com/pathfinder/v1/query', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', referer: 'https://open.spotify.com/' },
          body: JSON.stringify({ variables: { uri: `spotify:playlist:${id}`, offset, limit: 100 }, operationName: 'fetchPlaylist', extensions: { persistedQuery: { version: 1, sha256Hash: '8964e8eafb21aa992a7d951d256d83285c04be2105d209262901de70cb97584a' } } }),
        });
        if (r.status !== 200) throw new Error(String(r.status));
        const content = JSON.parse(r.body)?.data?.playlistV2?.content;
        const items: Any[] = content?.items ?? [];
        total = Number(content?.totalCount ?? items.length);
        if (!items.length) break;
        for (const it of items) {
          const t = it?.itemV2?.data ?? it?.item?.data ?? {};
          const ms = t.trackDuration?.totalMilliseconds ?? t.duration?.totalMilliseconds;
          all.push({ position: all.length, title: String(t.name ?? '').trim(), artist: (t.artists?.items ?? t.albumOfTrack?.artists?.items ?? []).map((a: Any) => a?.profile?.name).filter(Boolean).join(', '), album: t.albumOfTrack?.name, duration: typeof ms === 'number' ? Math.round(ms / 1000) : undefined });
        }
        offset += items.length;
      }
      if (all.length) return { source: 'spotify', name, cover, total: Number.isFinite(total) ? total : all.length, items: all.filter((t) => t.title), complete: all.length >= total };
    } catch { /* fall back to what the embed page lists */ }
  }
  const declared = Number(entity.trackCount ?? entity.totalTracks ?? NaN);
  return {
    source: 'spotify', name, cover, total: Number.isFinite(declared) ? declared : null, items: embedItems,
    complete: Number.isFinite(declared) ? embedItems.length >= declared : kind === 'album',
    note: Number.isFinite(declared) && embedItems.length < declared ? `Spotify показал без входа ${embedItems.length} из ${declared}`
      : kind === 'playlist' && !Number.isFinite(declared) ? `Spotify без входа показал первые ${embedItems.length}; сколько всего треков, сервис не сообщил` : undefined,
  };
}

// ---------------------------------------------------------------- Apple Music

async function appleAlbum(id: string): Promise<Collection> {
  const r = await fetchText(`https://itunes.apple.com/lookup?id=${id}&entity=song&limit=200`);
  if (r.status !== 200) throw new Error(reasonFor(r.status));
  const results: Any[] = JSON.parse(r.body)?.results ?? [];
  const album = results.find((x) => x?.wrapperType === 'collection');
  if (!album) throw new Error('Альбом не найден');
  const items = results.filter((x) => x?.wrapperType === 'track').sort((a, b) => (a.discNumber - b.discNumber) || (a.trackNumber - b.trackNumber))
    .map((x, i) => ({ position: i, title: String(x.trackName ?? ''), artist: String(x.artistName ?? album.artistName ?? ''), album: album.collectionName, duration: x.trackTimeMillis ? Math.round(x.trackTimeMillis / 1000) : undefined }));
  return { source: 'apple', name: album.collectionName ?? 'Альбом', cover: String(album.artworkUrl100 ?? '').replace('100x100', '600x600') || null, total: album.trackCount ?? items.length, items, complete: items.length >= (album.trackCount ?? items.length) };
}

async function applePlaylist(url: string): Promise<Collection> {
  const r = await fetchText(url);
  if (r.status !== 200) throw new Error(reasonFor(r.status));
  const m = /<script\s+type=["']application\/json["']\s+id=["']serialized-server-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(r.body);
  if (!m) throw new Error('Не удалось прочитать страницу Apple Music');
  const data = JSON.parse(m[1]);
  const items: CollectionItem[] = [];
  let name = '', cover: string | null = null, total: number | null = null;
  const walk = (node: Any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (!name && (node.contentDescriptor?.kind === 'playlist')) { name = node.title ?? ''; cover = node.artwork?.dictionary?.url?.replace('{w}x{h}bb.{f}', '600x600bb.jpg') ?? null; }
    if (total === null && typeof node.trackCount === 'number') total = node.trackCount;
    const kind = node.contentDescriptor?.kind;
    if ((kind === 'song' || kind === 'music-video') && typeof node.title === 'string') {
      // Keep repeats: the same song twice in a playlist is the curator's choice.
      items.push({ position: items.length, title: node.title, artist: String(node.artistName ?? node.subtitleLinks?.[0]?.title ?? ''), duration: typeof node.duration === 'number' ? Math.round(node.duration / 1000) : undefined });
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(data);
  if (!items.length) throw new Error('Плейлист пуст или закрыт');
  return { source: 'apple', name: name || 'Плейлист Apple Music', cover, total, items, complete: total === null || items.length >= total, note: total !== null && items.length < total ? `Apple Music показал без входа ${items.length} из ${total}` : undefined };
}

// ---------------------------------------------------------------- YouTube / SoundCloud

async function viaYtdlp(ytdlp: YtDlp, url: string, source: 'youtube' | 'soundcloud'): Promise<Collection> {
  const raw = await ytdlp.run(['--flat-playlist', '--yes-playlist', '-J', '--', url], { priority: 2, timeoutMs: 120000, maxBytes: 32 << 20 });
  const j = JSON.parse(raw) as { title?: string; playlist_count?: number; entries?: Any[]; thumbnails?: { url: string }[] };
  const items: CollectionItem[] = (j.entries ?? []).filter(Boolean).map((e, i) => {
    const id = source === 'youtube' ? String(e.id ?? '') : (/(\d{1,20})$/.exec(decodeURIComponent(String(e.url ?? e.id ?? '')))?.[1] ?? '');
    return { position: i, title: String(e.title ?? ''), artist: String(e.uploader ?? e.channel ?? '').replace(/\s*-\s*Topic$/i, ''), duration: Number(e.duration) || undefined, source: id ? { provider: source, externalId: id } : undefined };
  });
  return { source, name: j.title ?? 'Плейлист', cover: j.thumbnails?.at(-1)?.url ?? null, total: j.playlist_count ?? items.length, items, complete: items.length >= (j.playlist_count ?? items.length) };
}

/** Recognises a collection link; null when it is not one. */
export function classify(url: string): { kind: 'spotify-playlist' | 'spotify-album' | 'apple-album' | 'apple-playlist' | 'youtube' | 'soundcloud'; id: string } | null {
  const uri = /^spotify:(playlist|album):([A-Za-z0-9]{22})$/.exec(url.trim());
  if (uri) return { kind: uri[1] === 'album' ? 'spotify-album' : 'spotify-playlist', id: uri[2] };
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const sp = /^\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album)\/([A-Za-z0-9]{22})/.exec(u.pathname);
  if (host === 'open.spotify.com' && sp) return { kind: sp[1] === 'album' ? 'spotify-album' : 'spotify-playlist', id: sp[2] };
  if (host === 'music.apple.com') {
    const album = /\/album\/(?:[^/]+\/)?(\d+)/.exec(u.pathname);
    if (album && !u.searchParams.get('i')) return { kind: 'apple-album', id: album[1] };
    if (/\/playlist\/(?:[^/]+\/)?pl\.[\w-]+/.test(u.pathname)) return { kind: 'apple-playlist', id: u.pathname };
  }
  if ((host === 'www.youtube.com' || host === 'music.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') && /^[\w-]{10,64}$/.test(u.searchParams.get('list') ?? '')) return { kind: 'youtube', id: u.searchParams.get('list')! };
  if ((host === 'soundcloud.com' || host === 'www.soundcloud.com' || host === 'm.soundcloud.com') && /^\/[\w-]+\/(sets\/[\w-]+|likes)\/?$/.test(u.pathname)) return { kind: 'soundcloud', id: u.pathname };
  return null;
}

export async function fetchCollection(url: string, ytdlp: YtDlp): Promise<Collection> {
  const c = classify(url);
  if (!c) throw new Error('Не похоже на ссылку на плейлист или альбом Spotify, Apple Music, YouTube или SoundCloud');
  switch (c.kind) {
    case 'spotify-playlist': return spotify('playlist', c.id);
    case 'spotify-album': return spotify('album', c.id);
    case 'apple-album': return appleAlbum(c.id);
    case 'apple-playlist': return applePlaylist(`https://music.apple.com${c.id}`);
    case 'youtube': return viaYtdlp(ytdlp, `https://www.youtube.com/playlist?list=${c.id}`, 'youtube');
    case 'soundcloud': return viaYtdlp(ytdlp, `https://soundcloud.com${c.id}`, 'soundcloud');
  }
}

// ---------------------------------------------------------------- files

const parseDuration = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d+(:\d{1,2}){1,2}$/.test(t)) return t.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? (n > 10000 ? Math.round(n / 1000) : Math.round(n)) : undefined;
};

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  const sep = (text.split(/\r?\n/)[0].match(/;/g)?.length ?? 0) > (text.split(/\r?\n/)[0].match(/,/g)?.length ?? 0) ? ';' : ',';
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** CSV (Exportify-like headers), JSON (array or {tracks: [...]}) or M3U/M3U8. */
export function parseCollectionFile(name: string, text: string): Collection {
  if (text.length > 8 << 20) throw new Error('Файл слишком большой');
  const base = name.replace(/\.[^.]+$/, '') || 'Импорт';
  const items: CollectionItem[] = [];
  if (/^\s*#EXTM3U/.test(text) || /\.m3u8?$/i.test(name)) {
    let pending: { title: string; artist: string; duration?: number } | null = null;
    for (const line of text.split(/\r?\n/)) {
      const ext = /^#EXTINF:(-?\d+)[^,]*,(.*)$/.exec(line.trim());
      if (ext) {
        const [artist, ...rest] = ext[2].split(' - ');
        pending = rest.length ? { artist: artist.trim(), title: rest.join(' - ').trim() } : { artist: '', title: ext[2].trim() };
        if (Number(ext[1]) > 0) pending.duration = Number(ext[1]);
      } else if (line.trim() && !line.startsWith('#')) {
        const fallback = line.trim().split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
        const p = pending ?? (fallback.includes(' - ') ? { artist: fallback.split(' - ')[0], title: fallback.split(' - ').slice(1).join(' - ') } : { artist: '', title: fallback });
        items.push({ position: items.length, ...p });
        pending = null;
      }
    }
  } else if (/^\s*[[{]/.test(text)) {
    const j = JSON.parse(text);
    const arr: Any[] = Array.isArray(j) ? j : j.tracks ?? j.items ?? [];
    for (const x of arr) {
      const t = x?.track ?? x;
      const title = String(t?.title ?? t?.name ?? t?.trackName ?? '').trim();
      const artist = Array.isArray(t?.artists) ? t.artists.map((a: Any) => a?.name ?? a).join(', ') : String(t?.artist ?? t?.artistName ?? '');
      if (title) items.push({ position: items.length, title, artist, album: t?.album?.name ?? t?.album ?? undefined, duration: parseDuration(String(t?.duration ?? t?.duration_ms ?? '')), isrc: t?.isrc ?? t?.external_ids?.isrc ?? null });
    }
  } else {
    const rows = csvRows(text);
    const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const ti = col('track name', 'title', 'name', 'название', 'трек'), ai = col('artist name', 'artist', 'исполнитель'), al = col('album name', 'album', 'альбом');
    const du = col('duration', 'длительность'), is = col('isrc');
    if (ti < 0) throw new Error('В CSV нет колонки с названием трека');
    for (const r of rows) {
      const title = (r[ti] ?? '').trim();
      if (title) items.push({ position: items.length, title, artist: ai >= 0 ? (r[ai] ?? '').trim() : '', album: al >= 0 ? r[al]?.trim() : undefined, duration: du >= 0 ? parseDuration(r[du]) : undefined, isrc: is >= 0 ? r[is]?.trim() || null : null });
    }
  }
  if (!items.length) throw new Error('В файле не нашлось треков');
  return { source: 'file', name: base, cover: null, total: items.length, items, complete: true };
}
