/**
 * Replaces the yt-dlp process on iOS with in-app extractors. Same public surface as
 * apps/server/src/public/ytdlp.ts; errors, priorities and helpers come from the original.
 *
 * YouTube: youtubei.js plus the visionOS client's audio-only HLS rendition (~128 kbps
 * AAC), whose segments download without a proof-of-origin token; direct m4a as a
 * fallback. SoundCloud: public api-v2 with the web client's id. Approach and
 * request shapes adapted from Muriel (cloverscripts/riff-muriel, branch muriel,
 * mobile/extract.js and mobile/ts2aac.js, MIT, (c) rootscripts and contributors).
 */
import { Innertube, Platform, Constants } from 'youtubei.js/web';
import path from 'path-browserify';
import { promises as fsp } from '../opfs-fs.ts';
import { outboundFetch } from '../rpc.ts';
import { ResolverError, classifyError, checkedMediaUrl, type Priority, type YtDlpConfig } from 'orig-ytdlp';
import { parseSoundCloudSearch } from 'orig-soundcloud';

export { ResolverError, classifyError, checkedMediaUrl, type Priority, type YtDlpConfig };

type Info = Record<string, unknown>;

// youtubei.js deciphers signatures with player JS; the WebView may run it.
(Platform.shim as { eval: unknown }).eval = async (data: { output: string }, env: { n?: string; sig?: string }) => {
  const props: string[] = [];
  if (env.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
  if (env.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
  return new Function(`${data.output}\nreturn { ${props.join(', ')} }`)();
};

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const VOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

let ytPromise: Promise<Innertube> | null = null;
function yt(): Promise<Innertube> {
  ytPromise ??= Innertube.create({ generate_session_locally: true, fetch: outboundFetch as typeof fetch }).catch((e) => { ytPromise = null; throw e; });
  return ytPromise;
}

const txt = (t: unknown): string => (t == null ? '' : typeof t === 'string' ? t : String((t as { text?: string }).text ?? t.toString()));
const thumbs = (arr: unknown): { url: string; width?: number; height?: number }[] =>
  ((arr as { url: string; width?: number; height?: number }[] | undefined) ?? []).map((t) => ({ url: t.url, width: t.width, height: t.height })).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
const ytId = (u: string): string | null => /(?:v=|youtu\.be\/|\/shorts\/|^)([\w-]{11})(?:[&?#]|$)/.exec(u)?.[1] ?? null;

async function getText(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<string> {
  const r = await outboundFetch(url, { headers, signal });
  if (!r.ok) throw new ResolverError(`HTTP ${r.status}`, r.status === 403 || r.status === 410 ? 'unavailable' : 'failed');
  return r.text();
}

// ---------------- YouTube ----------------

interface Audio { kind: 'hls' | 'direct'; url: string; headers: Record<string, string>; ext: string; title: string; artist: string; duration: number; acodec: string; abr: number | null }

let visitorId: string | null = null;
async function getVisitorId(force: boolean, signal?: AbortSignal): Promise<string | null> {
  if (visitorId && !force) return visitorId;
  const html = await getText('https://www.youtube.com/', { 'User-Agent': VOS_UA, 'Accept-Language': 'en-US' }, signal);
  visitorId = /"VISITOR_DATA":"([^"]+)"/.exec(html)?.[1] ?? null;
  return visitorId;
}

async function youtubeHls(id: string, signal?: AbortSignal): Promise<Audio> {
  for (const force of [false, true]) {
    const visitor = await getVisitorId(force, signal);
    const body = {
      context: { client: { clientName: 'VISIONOS', clientVersion: '1.02', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1', userAgent: VOS_UA, osName: 'visionOS', osVersion: '26.5.23O471', hl: 'en', timeZone: 'UTC', utcOffsetMinutes: 0, visitorData: visitor ?? undefined } },
      videoId: id, contentCheckOk: true, racyCheckOk: true,
    };
    const headers: Record<string, string> = { 'User-Agent': VOS_UA, 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '101', 'X-Youtube-Client-Version': '1.02', Origin: 'https://www.youtube.com' };
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    const res = await outboundFetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', headers, body: JSON.stringify(body), signal });
    const j = await res.json() as { streamingData?: { hlsManifestUrl?: string }; playabilityStatus?: { status?: string; reason?: string }; videoDetails?: { title?: string; author?: string; lengthSeconds?: string } };
    const master = j.streamingData?.hlsManifestUrl;
    if (!master) {
      if (j.playabilityStatus?.status === 'LOGIN_REQUIRED' && !force) continue; // stale visitor id
      throw new ResolverError(j.playabilityStatus?.reason || 'YouTube не отдал поток', 'unavailable');
    }
    const m3u = await getText(master, { 'User-Agent': VOS_UA }, signal);
    const pick = (itag: number) => new RegExp(`#EXT-X-MEDIA:[^\\n]*URI="([^"]+/itag/${itag}/[^"]*)"`).exec(m3u)?.[1];
    const playlist = pick(234) ?? pick(233);
    if (!playlist) throw new ResolverError('Нет аудиодорожки', 'unavailable');
    const d = j.videoDetails ?? {};
    return { kind: 'hls', url: playlist, headers: { 'User-Agent': VOS_UA }, ext: '.aac', acodec: 'aac', abr: playlist.includes('/itag/234/') ? 128 : 48,
      artist: (d.author ?? '').replace(/\s*-\s*Topic$/i, ''), title: d.title ?? '', duration: Number(d.lengthSeconds) || 0 };
  }
  throw new ResolverError('YouTube отклонил запрос', 'failed');
}

async function youtubeAudio(id: string, signal?: AbortSignal): Promise<Audio> {
  let first: unknown;
  try { return await youtubeHls(id, signal); } catch (e) { if (signal?.aborted) throw e; first = e; console.warn('[youtube] HLS не удался, пробую прямой поток', (e as Error).message); }
  const y = await yt();
  let last: unknown = first;
  for (const client of ['IOS', 'MWEB', 'TV'] as const) {
    try {
      const info = await y.getBasicInfo(id, { client });
      const formats = (info.streaming_data?.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video);
      const pick = formats.filter((f) => /mp4/.test(f.mime_type)).sort((a, b) => b.bitrate - a.bitrate)[0] ?? formats.sort((a, b) => b.bitrate - a.bitrate)[0];
      if (!pick) throw new Error('нет аудиоформата');
      const url = pick.url ?? await pick.decipher(y.session.player);
      const clients = Constants.CLIENTS as Record<string, { USER_AGENT?: string }>;
      const ua = clients[client]?.USER_AGENT ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
      const mp4 = /mp4/.test(pick.mime_type);
      return { kind: 'direct', url, headers: { 'User-Agent': ua }, ext: mp4 ? '.m4a' : '.webm', acodec: mp4 ? 'aac' : 'opus', abr: Math.round(pick.bitrate / 1000),
        artist: txt(info.basic_info.author).replace(/\s*-\s*Topic$/i, ''), title: info.basic_info.title ?? '', duration: info.basic_info.duration ?? 0 };
    } catch (e) { if (signal?.aborted) throw e; last = e; }
  }
  throw last instanceof ResolverError ? last : new ResolverError((last as Error)?.message ?? 'Не удалось получить звук YouTube', 'failed');
}

async function youtubeSearch(query: string, limit: number): Promise<Info[]> {
  const r = await (await yt()).search(query, { type: 'video' });
  return ((r.videos ?? []) as unknown as Record<string, unknown>[]).filter((v) => v.id).slice(0, limit).map((v) => {
    const author = (v.author as { name?: string } | undefined)?.name ?? '';
    return { id: v.id, title: txt(v.title), uploader: author, channel: author, duration: (v.duration as { seconds?: number } | undefined)?.seconds ?? 0,
      thumbnails: thumbs(v.thumbnails), webpage_url: `https://www.youtube.com/watch?v=${v.id}` };
  });
}

async function youtubePlaylist(listId: string, limit: number): Promise<Info> {
  const y = await yt();
  let page = await y.getPlaylist(listId);
  const title = txt(page.info?.title) || 'Плейлист';
  const entries: Info[] = [];
  const parseDur = (s: unknown) => String(s ?? '').split(':').map(Number).reduce((acc, n) => acc * 60 + (n || 0), 0);
  const take = (p: { videos?: unknown[]; items?: unknown[] }) => {
    for (const raw of (p.videos ?? p.items ?? []) as Record<string, any>[]) {
      if (entries.length >= limit) return;
      if (raw.type === 'LockupView') {
        if (raw.content_type && raw.content_type !== 'VIDEO') continue;
        const md = raw.metadata ?? {};
        const rows = md.metadata?.metadata_rows ?? [];
        const channel = rows[0]?.metadata_parts?.[0] ? txt(rows[0].metadata_parts[0].text) : '';
        const badge = (raw.content_image?.overlays ?? []).flatMap((o: { badges?: unknown[] }) => o.badges ?? [])[0] as { text?: string } | undefined;
        if (!raw.content_id) continue;
        entries.push({ id: raw.content_id, title: txt(md.title), uploader: channel, channel, duration: parseDur(badge?.text),
          thumbnails: thumbs(raw.content_image?.image), webpage_url: `https://www.youtube.com/watch?v=${raw.content_id}` });
        continue;
      }
      if (!raw.id) continue;
      entries.push({ id: raw.id, title: txt(raw.title), uploader: txt(raw.author?.name), channel: txt(raw.author?.name),
        duration: raw.duration?.seconds ?? 0, thumbnails: thumbs(raw.thumbnails), webpage_url: `https://www.youtube.com/watch?v=${raw.id}` });
    }
  };
  take(page as never);
  while (entries.length < limit && page.has_continuation) {
    page = await page.getContinuation();
    take(page as never);
  }
  return { _type: 'playlist', title, playlist_count: entries.length, entries };
}

// ---------------- SoundCloud ----------------

let scClientId: string | null = null;
async function scId(force: boolean, signal?: AbortSignal): Promise<string> {
  if (scClientId && !force) return scClientId;
  const html = await getText('https://soundcloud.com/', { 'User-Agent': DESKTOP_UA }, signal);
  const scripts = [...html.matchAll(/<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]).reverse();
  for (const s of scripts) {
    const m = /client_id\s*[:=]\s*"([a-zA-Z0-9]{20,})"/.exec(await getText(s, { 'User-Agent': DESKTOP_UA }, signal));
    if (m) return (scClientId = m[1]);
  }
  throw new ResolverError('SoundCloud: не найден client_id', 'failed');
}

async function scApi<T = Record<string, any>>(p: string, signal?: AbortSignal): Promise<T> {
  for (const force of [false, true]) {
    const id = await scId(force, signal);
    const r = await outboundFetch(`https://api-v2.soundcloud.com${p}${p.includes('?') ? '&' : '?'}client_id=${id}`, { headers: { 'User-Agent': DESKTOP_UA }, signal });
    if (r.status === 401 || r.status === 403) continue; // client_id rotated
    if (r.status === 404) throw new ResolverError('Запись SoundCloud недоступна', 'unavailable');
    if (!r.ok) throw new ResolverError(`SoundCloud: HTTP ${r.status}`, 'failed');
    return r.json() as Promise<T>;
  }
  throw new ResolverError('SoundCloud отклонил запрос', 'failed');
}

const scEntry = (t: Record<string, any>): Info => ({
  id: String(t.id), url: `https://api.soundcloud.com/tracks/${t.id}`, title: t.title, uploader: t.user?.username,
  duration: Math.round((t.full_duration || t.duration || 0) / 1000),
  thumbnails: t.artwork_url ? [{ url: String(t.artwork_url).replace('-large.', '-t500x500.') }] : [],
  thumbnail: t.artwork_url ? String(t.artwork_url).replace('-large.', '-t500x500.') : undefined,
  webpage_url: t.permalink_url, artist_id: t.user?.id ? String(t.user.id) : undefined, artist_permalink: t.user?.permalink,
});

async function scTrack(url: string, signal?: AbortSignal): Promise<Record<string, any>> {
  const id = /api\.soundcloud\.com\/tracks\/(\d{1,20})/.exec(url)?.[1];
  return id ? scApi(`/tracks/${id}`, signal) : scApi(`/resolve?url=${encodeURIComponent(url)}`, signal);
}

async function soundcloudAudio(url: string, signal?: AbortSignal): Promise<Audio & { track: Record<string, any> }> {
  const t = await scTrack(url, signal);
  const list = (t.media?.transcodings ?? []) as { url: string; format: { protocol: string; mime_type: string } }[];
  const usable = list.filter((x) => !/encrypted|ctr|cbc/.test(x.format.protocol));
  const tc = usable.find((x) => x.format.protocol === 'progressive') ?? usable.find((x) => x.format.protocol === 'hls' && /mpeg|aac|mp4a/.test(x.format.mime_type)) ?? usable[0];
  if (!tc) throw new ResolverError(list.length ? 'Запись SoundCloud защищена DRM: её можно слушать только в приложении SoundCloud' : 'У записи SoundCloud нет открытого потока', 'unavailable');
  const auth = t.track_authorization ? `?track_authorization=${t.track_authorization}` : '';
  const { url: media } = await scApi<{ url: string }>(tc.url.replace('https://api-v2.soundcloud.com', '') + auth, signal);
  const mime = tc.format.mime_type;
  const hls = tc.format.protocol !== 'progressive';
  // HLS "audio/mp4" is fragmented MP4 (init + fragments → one .m4a); "audio/mpeg" segments are plain MP3
  const ext = /mpeg/.test(mime) ? '.mp3' : /ogg|opus/.test(mime) ? '.opus' : /mp4/.test(mime) ? '.m4a' : '.aac';
  return { kind: hls ? 'hls' : 'direct', url: media, headers: { 'User-Agent': DESKTOP_UA }, ext, acodec: ext === '.mp3' ? 'mp3' : ext === '.opus' ? 'opus' : 'aac', abr: null,
    title: t.title, artist: t.user?.username ?? '', duration: Math.round((t.full_duration || t.duration || 0) / 1000), track: t };
}

async function soundcloudSearch(query: string, limit: number, signal?: AbortSignal): Promise<Info[]> {
  const r = await scApi<{ collection?: Record<string, any>[] }>(`/search/tracks?q=${encodeURIComponent(query)}&limit=${limit}`, signal);
  // same filter as the desktop fast path: no previews, private or DRM-only records
  return parseSoundCloudSearch(r, limit);
}

async function soundcloudPlaylist(pageUrl: string, limit: number): Promise<Info> {
  const set = await scApi(`/resolve?url=${encodeURIComponent(pageUrl)}`);
  if (set.kind === 'track') return { _type: 'playlist', title: set.title, entries: [scEntry(set)] };
  const tracks = ((set.tracks ?? set.collection ?? []) as Record<string, any>[]).map((x) => x.track ?? x).slice(0, limit);
  const missing = tracks.filter((t) => !t.title).map((t) => t.id);
  const full = new Map(tracks.filter((t) => t.title).map((t) => [t.id, t]));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = await scApi<Record<string, any>[]>(`/tracks?ids=${missing.slice(i, i + 50).join(',')}`).catch(() => []);
    for (const t of batch ?? []) full.set(t.id, t);
  }
  const entries = tracks.map((t) => full.get(t.id)).filter(Boolean).map((t) => scEntry(t!));
  return { _type: 'playlist', title: set.title || 'Плейлист SoundCloud', playlist_count: set.track_count ?? entries.length, entries };
}

// ---------------- download ----------------

/** HLS "packed audio" (ADTS behind ID3) or MPEG-TS segments joined into one ADTS .aac file. */
function ts2aac(ts: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  let audioPid = -1;
  for (let i = 0; i + 188 <= ts.length; i += 188) {
    if (ts[i] !== 0x47) {
      const next = ts.indexOf(0x47, i + 1);
      if (next < 0) break;
      i = next - 188;
      continue;
    }
    const pusi = (ts[i + 1] & 0x40) !== 0;
    const pid = ((ts[i + 1] & 0x1f) << 8) | ts[i + 2];
    const afc = (ts[i + 3] >> 4) & 3;
    let p = i + 4;
    if (afc === 2) continue;
    if (afc === 3) p += 1 + ts[p];
    if (p >= i + 188) continue;
    if (pusi && ts[p] === 0 && ts[p + 1] === 0 && ts[p + 2] === 1) {
      const streamId = ts[p + 3];
      if (streamId >= 0xc0 && streamId <= 0xdf) { audioPid = pid; p += 9 + ts[p + 8]; }
      else if (pid === audioPid) continue;
    }
    if (pid === audioPid && audioPid >= 0) out.push(ts.subarray(p, i + 188));
  }
  return concat(out);
}
function stripId3(seg: Uint8Array): Uint8Array {
  let p = 0;
  while (seg[p] === 0x49 && seg[p + 1] === 0x44 && seg[p + 2] === 0x33) {
    const size = (seg[p + 6] << 21) | (seg[p + 7] << 14) | (seg[p + 8] << 7) | seg[p + 9];
    p += 10 + size + ((seg[p + 5] & 0x10) ? 10 : 0);
  }
  return seg.subarray(p);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

async function fetchBytes(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await outboundFetch(url, { headers, signal });
      if (!r.ok) throw new ResolverError(`HTTP ${r.status}`, r.status === 403 || r.status === 410 ? 'unavailable' : 'failed');
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (signal?.aborted || attempt >= 2) throw e;
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
  }
}

/**
 * Plain frame streams (ADTS .aac, .mp3) are appended to `out` segment by segment, in order, while
 * the rest still downloads: the player's growing-file reader starts decoding from the first ones.
 * Fragmented MP4 (#EXT-X-MAP) needs its init segment first and is returned whole.
 */
async function downloadHls(a: Audio, maxBytes: number, signal?: AbortSignal, onProgress?: (f: number) => void, out?: string): Promise<Uint8Array | null> {
  const list = await getText(a.url, a.headers, signal);
  const base = new URL(a.url);
  if (/#EXT-X-KEY:(?!.*METHOD=NONE)/.test(list)) throw new ResolverError('Поток зашифрован', 'unavailable');
  const urls = list.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new URL(l, base).href);
  if (!urls.length) throw new ResolverError('Пустой поток', 'failed');
  const map = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/.exec(list)?.[1];
  const frames = (seg: Uint8Array) => (seg[0] === 0x47 ? ts2aac(seg) : stripId3(seg));
  const file = !map && out ? await fsp.open(out, 'w') : null;
  const parts: (Uint8Array | undefined)[] = new Array(urls.length);
  let done = 0, bytes = 0, next = 0, written = 0, writing = Promise.resolve();
  // segments finish out of order (4 at a time): write each run that became contiguous
  const flush = () => {
    writing = writing.then(async () => {
      while (file && written < urls.length && parts[written]) {
        await file.write(frames(parts[written]!));
        parts[written++] = undefined;
      }
    });
    return writing;
  };
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      parts[i] = await fetchBytes(urls[i], a.headers, signal);
      bytes += parts[i]!.byteLength;
      if (bytes > maxBytes) throw new ResolverError('Файл слишком большой', 'too-large');
      onProgress?.(++done / urls.length);
      if (file) await flush();
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, worker));
    if (file) { await flush(); await file.sync(); return null; }
  } finally { await writing.catch(() => {}); await file?.close(); }
  if (map) return concat([await fetchBytes(new URL(map, base).href, a.headers, signal), ...parts as Uint8Array[]]);
  return concat((parts as Uint8Array[]).map(frames));
}

const SAFE_ID = /^[\w-]{1,64}$/;

export class YtDlp {
  private queue: { priority: Priority; start: () => void }[] = [];
  private running = 0;

  constructor(readonly cfg: YtDlpConfig) {}

  get available(): boolean { return true; }

  /** Bounded parallelism, audible-now first (as in the desktop resolver). */
  private schedule<T>(priority: Priority, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        work().then(resolve, reject).finally(() => { this.running--; this.pump(); });
      };
      this.queue.push({ priority, start });
      this.queue.sort((a, b) => a.priority - b.priority);
      this.pump();
    });
  }
  private pump(): void {
    while (this.running < Math.max(1, this.cfg.concurrency) && this.queue.length) this.queue.shift()!.start();
  }

  /** Only the yt-dlp invocations the server makes: playlist listings for link import. */
  async run(args: string[], opts: { priority: Priority; timeoutMs: number; signal?: AbortSignal }): Promise<string> {
    const target = args[args.length - 1];
    if (args.includes('--flat-playlist')) {
      return this.schedule(opts.priority, opts.signal, async () => {
        if (/soundcloud\.com/.test(target)) return JSON.stringify(await soundcloudPlaylist(target, 1000));
        const list = /[?&]list=([\w-]+)/.exec(target)?.[1];
        if (list) return JSON.stringify(await youtubePlaylist(list, 1000));
        throw new ResolverError('Ссылка не поддерживается', 'failed');
      });
    }
    if (args.includes('--version')) return 'in-app';
    throw new ResolverError('Эта операция yt-dlp недоступна на iPhone', 'not-installed');
  }

  async version(): Promise<string | null> { return 'youtubei.js (в приложении)'; }

  async metadata(url: string): Promise<Info> {
    const target = checkedMediaUrl(url);
    if (/soundcloud\.com/.test(target)) {
      const t = await scTrack(target);
      return scEntry(t);
    }
    const id = ytId(target);
    if (!id) throw new ResolverError('Ссылка не поддерживается', 'failed');
    const info = await (await yt()).getBasicInfo(id);
    return { id, title: info.basic_info.title, uploader: txt(info.basic_info.author), duration: info.basic_info.duration,
      thumbnail: thumbs(info.basic_info.thumbnail).at(-1)?.url, webpage_url: `https://www.youtube.com/watch?v=${id}` };
  }

  async search(prefix: 'scsearch' | 'ytsearch', query: string, limit: number, signal?: AbortSignal): Promise<Info[]> {
    const q = query.replace(/[\r\n]/g, ' ').trim().slice(0, 200);
    if (!q) return [];
    const n = Math.min(25, Math.max(1, limit));
    return this.schedule(2, signal, () => (prefix === 'scsearch' ? soundcloudSearch(q, n, signal) : youtubeSearch(q, n)));
  }

  async warmMetadata(): Promise<boolean> { return false; }

  async searchMusic(query: string, limit: number, signal?: AbortSignal): Promise<Info[]> {
    // the Music shelf has its own HTTP path (ytmusic.ts); this is only its fallback
    return this.search('ytsearch', query, limit, signal);
  }

  /** Downloads the published audio (no re-encoding) into a fresh staging folder. */
  async nativeSource(url: string): Promise<import('@automix/core/native-preparation.ts').NativeMediaSource> {
    const target = checkedMediaUrl(url);
    const audio = /soundcloud\.com/.test(target)
      ? await soundcloudAudio(target)
      : await youtubeAudio(ytId(target) ?? '');
    return { kind: audio.kind, url: audio.url, headers: audio.headers, ext: audio.ext };
  }
  async download(url: string, stagingDir: string, opts: { priority: Priority; signal?: AbortSignal; maxMb?: number; onProgress?: (fraction: number) => void }): Promise<{ file: string; info: Info }> {
    const target = checkedMediaUrl(url);
    await fsp.mkdir(stagingDir, { recursive: true });
    return this.schedule(opts.priority, opts.signal, async () => {
      const signal = opts.signal;
      const maxBytes = (opts.maxMb ?? 200) << 20;
      let audio: Audio, id: string, extra: Info = {};
      if (/soundcloud\.com/.test(target)) {
        const sc = await soundcloudAudio(target, signal);
        audio = sc;
        id = String(sc.track.id);
        extra = scEntry(sc.track);
      } else {
        const yid = ytId(target);
        if (!yid) throw new ResolverError('Ссылка не поддерживается', 'failed');
        id = yid;
        audio = await youtubeAudio(yid, signal);
        extra = { thumbnail: `https://i.ytimg.com/vi/${yid}/hqdefault.jpg`, webpage_url: `https://www.youtube.com/watch?v=${yid}` };
      }
      if (!SAFE_ID.test(id)) throw new ResolverError('Некорректный идентификатор записи', 'failed');
      const file = path.join(stagingDir, `${id}${audio.ext}`);
      // ADTS/MP3 HLS is written straight to its streamable name, segment by segment
      const progressive = audio.kind === 'hls' && (audio.ext === '.aac' || audio.ext === '.mp3');
      let bytes: Uint8Array | null;
      if (audio.kind === 'hls') bytes = await downloadHls(audio, maxBytes, signal, opts.onProgress, progressive ? file : undefined);
      else {
        bytes = await fetchBytes(audio.url, audio.headers, signal);
        if (bytes.byteLength > maxBytes) throw new ResolverError('Файл слишком большой', 'too-large');
        opts.onProgress?.(1);
      }
      const size = bytes ? bytes.byteLength : (await fsp.stat(file)).size;
      if (size < 4096) throw new ResolverError('Источник не отдал аудио', 'failed');
      signal?.throwIfAborted();
      if (bytes) {
        // the growing-file reader ignores unknown extensions: publish the name only when complete
        const tmp = `${file}.download`;
        await fsp.writeFile(tmp, bytes);
        await fsp.rename(tmp, file);
      }
      const info: Info = { ...extra, id, title: audio.title, artist: audio.artist || undefined, uploader: audio.artist, duration: audio.duration,
        ext: audio.ext.slice(1), acodec: audio.acodec, abr: audio.abr, asr: null, webpage_url: extra.webpage_url ?? target, extractor_key: /soundcloud/.test(target) ? 'Soundcloud' : 'Youtube' };
      return { file, info };
    });
  }
}
