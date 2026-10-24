/** Metadata only: public SoundCloud web search; audio stays in the existing resolver. */
const ORIGIN = 'https://soundcloud.com';
const API = 'https://api-v2.soundcloud.com/search/tracks';
let transport: typeof fetch = (...args) => fetch(...args);
let client: { id: string; until: number } | null = null;
let retryAt = 0;
let artistRetryAt = 0;

/** Desktop supplies Chromium networking, like YouTube Music. */
export function setSoundCloudTransport(fetcher: typeof fetch): void {
  transport = fetcher;
  client = null;
  retryAt = 0;
  artistRetryAt = 0;
}

async function text(url: string, signal: AbortSignal, maxBytes: number): Promise<string> {
  const res = await transport(url, { signal, redirect: 'error', headers: { accept: '*/*', origin: ORIGIN, referer: `${ORIGIN}/` } });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) client = null;
    await res.body?.cancel();
    throw new Error(`SoundCloud: HTTP ${res.status}`);
  }
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
    await res.body?.cancel();
    throw new Error('SoundCloud: слишком большой ответ');
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('SoundCloud: пустой ответ');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('SoundCloud: слишком большой ответ');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function clientId(signal: AbortSignal): Promise<string> {
  if (client && client.until > Date.now()) return client.id;
  const html = await text(`${ORIGIN}/`, signal, 1 << 20);
  const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)]
    .map((m) => m[1]).filter((url) => /^https:\/\/a-v2\.sndcdn\.com\/assets\/[\w.-]+\.js$/.test(url));
  // Only official assets, bounded independently of whatever the remote HTML contains.
  for (const url of [...new Set(scripts)].slice(-3).reverse()) {
    const js = await text(url, signal, 4 << 20);
    const id = /client_id\s*:\s*["']([0-9a-zA-Z]{32})["']/.exec(js)?.[1];
    if (id) { client = { id, until: Date.now() + 30 * 60_000 }; return id; }
  }
  throw new Error('SoundCloud: изменился формат публичного поиска');
}

type Json = Record<string, unknown>;
const object = (v: unknown): Json => v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const image = (v: unknown): string | null => typeof v === 'string' && /^https:\/\/i\d?\.sndcdn\.com\/[^\s]+$/.test(v)
  ? v.replace(/-large\.(jpg|png)(\?.*)?$/, '-t500x500.$1$2') : null;

/** False when every published transcoding is DRM-encrypted (cbc/ctr-encrypted-hls): such a record cannot be downloaded. */
export function hasOpenStream(track: unknown): boolean {
  const list = object(object(track).media).transcodings;
  if (!Array.isArray(list)) return true; // no media listing: let the resolver decide
  return list.some((t) => !/encrypted/.test(String(object(object(t).format).protocol ?? '')));
}

/** Returns the same metadata shape as yt-dlp's flat SoundCloud entries. */
export function parseSoundCloudSearch(value: unknown, limit: number): Json[] {
  const collection = object(value).collection;
  if (!Array.isArray(collection)) throw new Error('SoundCloud: изменился формат результатов');
  const seen = new Set<string>();
  return collection.flatMap((raw) => {
    const x = object(raw), user = object(x.user), publisher = object(x.publisher_metadata);
    const id = String(x.id ?? '').replace(/^soundcloud:tracks:/, '');
    const title = typeof x.title === 'string' ? x.title.trim() : '';
    if (!/^\d{1,20}$/.test(id) || !title || seen.has(id) || x.kind && x.kind !== 'track') return [];
    if (x.streamable === false || x.sharing === 'private' || x.policy === 'BLOCK' || x.policy === 'SNIP' || !hasOpenStream(x)) return [];
    const duration = Number(x.duration) / 1000;
    if (!Number.isFinite(duration) || duration < 30 || duration > 10800) return [];
    seen.add(id);
    const page = typeof x.permalink_url === 'string' && /^https:\/\/soundcloud\.com\/[^\s?#]+\/[^\s?#]+$/.test(x.permalink_url) ? x.permalink_url : null;
    const userId = String(user.id ?? '');
    const artistPermalink = typeof user.permalink === 'string' && /^[\w-]{1,100}$/.test(user.permalink) ? user.permalink : '';
    return [{ id, title, duration, url: `https://api.soundcloud.com/tracks/${id}`, webpage_url: page,
      uploader: typeof user.username === 'string' ? user.username : '',
      artist: typeof publisher.artist === 'string' && publisher.artist.trim() ? publisher.artist : typeof user.username === 'string' ? user.username : '',
      artist_id: /^\d{1,20}$/.test(userId) && artistPermalink ? userId : null, artist_permalink: artistPermalink,
      thumbnail: image(x.artwork_url) ?? image(user.avatar_url), license: typeof x.license === 'string' ? x.license : null }];
  }).slice(0, limit);
}

export interface SoundCloudArtist {
  id: string; permalink: string; title: string; description: string; coverUrl: string | null;
  tracks: Json[];
}

/** Loads a public profile and its first track shelf; identity must agree across both API responses. */
export async function getSoundCloudArtist(id: string, signal?: AbortSignal): Promise<SoundCloudArtist> {
  if (!/^\d{1,20}$/.test(id)) throw new Error('Некорректный ID исполнителя');
  if (signal?.aborted) throw new Error('Отменено');
  if (Date.now() < artistRetryAt) throw new Error('SoundCloud: профили временно недоступны');
  const ctl = new AbortController(), abort = () => ctl.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 4000);
  try {
    const client_id = await clientId(ctl.signal);
    const params = new URLSearchParams({ client_id });
    const user = object(JSON.parse(await text(`https://api-v2.soundcloud.com/users/${id}?${params}`, ctl.signal, 1 << 20)));
    const userId = String(user.id ?? '');
    const permalink = typeof user.permalink === 'string' && /^[\w-]{1,100}$/.test(user.permalink) ? user.permalink : '';
    const page = typeof user.permalink_url === 'string' ? user.permalink_url : '';
    if (user.kind !== 'user' || userId !== id || !permalink || page !== `https://soundcloud.com/${permalink}`)
      throw new Error('SoundCloud: профиль исполнителя не подтверждён');
    const tracksParams = new URLSearchParams({ client_id, limit: '25', linked_partitioning: '1' });
    const raw = JSON.parse(await text(`https://api-v2.soundcloud.com/users/${id}/tracks?${tracksParams}`, ctl.signal, 2 << 20));
    const collection = object(raw).collection;
    if (!Array.isArray(collection)) throw new Error('SoundCloud: изменился формат треков');
    const tracks = parseSoundCloudSearch({ collection }, 25).filter((track) => String(track.artist_id ?? '') === id);
    artistRetryAt = 0;
    return { id, permalink, title: typeof user.username === 'string' ? user.username.slice(0, 300) : '',
      description: typeof user.description === 'string' ? user.description.slice(0, 4000) : '', coverUrl: image(user.avatar_url), tracks };
  } catch (e) {
    if (!signal?.aborted) artistRetryAt = Date.now() + 30_000;
    throw signal?.aborted ? new Error('Отменено') : e;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/** Four-second total fast path; callers retain yt-dlp as an independent fallback. */
export async function searchSoundCloud(query: string, limit = 15, signal?: AbortSignal): Promise<Json[]> {
  if (signal?.aborted) throw new Error('Отменено');
  const q = query.replace(/[\r\n]/g, ' ').trim().slice(0, 200);
  if (!q) return [];
  if (Date.now() < retryAt) throw new Error('SoundCloud: быстрый поиск временно недоступен');
  const ctl = new AbortController();
  const abort = () => ctl.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 4000);
  try {
    const id = await clientId(ctl.signal);
    const count = Math.min(25, Math.max(1, Math.trunc(limit) || 15));
    const params = new URLSearchParams({ q, limit: String(count), client_id: id, linked_partitioning: '1' });
    const result = parseSoundCloudSearch(JSON.parse(await text(`${API}?${params}`, ctl.signal, 2 << 20)), count);
    retryAt = 0;
    return result;
  } catch (e) {
    if (!signal?.aborted) retryAt = Date.now() + 30_000;
    throw signal?.aborted ? new Error('Отменено') : e;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
