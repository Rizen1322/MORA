import { normalize, versionLabels, matchConfidence } from './match.ts';
import { SharedPreparation } from './shared-preparation.ts';
import { parseDuration, radioYtm, requestYtm, type YtmItem } from './ytmusic.ts';

type Json = Record<string, any>;
export interface RadioCandidateOptions {
  seed: { artist: string; title: string; duration: number };
  resolve: (query: string, signal?: AbortSignal) => Promise<YtmItem[]>;
}

/** A regular YouTube Mix is a separate client/host from Music's up-next queue. */
export function parseYoutubeMix(json: Json): YtmItem[] {
  const panel = json?.contents?.twoColumnWatchNextResults?.playlist?.playlist;
  if (!Array.isArray(panel?.contents)) return [];
  const out: YtmItem[] = [];
  for (const wrap of panel.contents.slice(0, 100)) {
    const row = wrap?.playlistPanelVideoRenderer;
    if (!row || typeof row.videoId !== 'string' || !/^[\w-]{11}$/.test(row.videoId)) continue;
    const text = (value: Json | undefined): string => typeof value?.simpleText === 'string' ? value.simpleText :
      Array.isArray(value?.runs) ? value.runs.map((r: Json) => typeof r.text === 'string' ? r.text : '').join('') : '';
    const title = text(row.title).trim(), artist = text(row.longBylineText ?? row.shortBylineText).replace(/\s*-\s*Topic$/i, '').trim();
    const duration = parseDuration(text(row.lengthText));
    // Unknown-duration and live videos must not turn a music station into a stream.
    if (!title || !artist || duration < 30 || duration > 15 * 60 || row.isPlayable === false) continue;
    out.push({ videoId: row.videoId, title, artist, artistId: null, album: '', albumId: null, duration,
      thumbnail: `https://i.ytimg.com/vi/${row.videoId}/hqdefault.jpg`, explicit: false, kind: 'video' });
  }
  return out;
}

/** Metadata never supplies audio: resolve only a close artist/title/duration recording. */
export function matchRadioMetadata(target: { title: string; artist: string; duration: number }, items: YtmItem[]): YtmItem | undefined {
  if (!target.title || !target.artist || !(target.duration > 0)) return undefined;
  return items.find(item => item.duration > 0 && Math.abs(item.duration - target.duration) <= 8 &&
    normalize(item.artist) === normalize(target.artist) &&
    normalize(item.title) === normalize(target.title) &&
    matchConfidence(target, { ...item, labels: versionLabels(item.title, item.explicit) }) >= .9);
}

async function deezerJson(path: string, signal: AbortSignal): Promise<Json> {
  const res = await fetch(`https://api.deezer.com/${path}`, { signal, redirect: 'error' });
  if (!res.ok || Number(res.headers.get('content-length') ?? 0) > 256 * 1024) throw new Error('Deezer metadata недоступны');
  const reader = res.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) throw new Error('Deezer: слишком большой ответ');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function deezerFallback(options: RadioCandidateOptions, signal: AbortSignal): Promise<YtmItem[]> {
  const artist = options.seed.artist.split(/,|&| feat\.? | ft\.? /i)[0].trim();
  if (!artist) return [];
  const artists = await deezerJson(`search/artist?q=${encodeURIComponent(artist)}&limit=3`, signal);
  // Never assume the first search result is the requested artist (including Cyrillic names).
  const found = Array.isArray(artists.data) ? artists.data.find((a: Json) => normalize(String(a.name ?? '')) === normalize(artist) && /^\d+$/.test(String(a.id))) : undefined;
  if (!found) return [];
  const radio = await deezerJson(`artist/${found.id}/radio?limit=8`, signal);
  const metadata = (Array.isArray(radio.data) ? radio.data : []).filter((t: Json) =>
    typeof t.title === 'string' && typeof t.artist?.name === 'string' && Number(t.duration) >= 30 && Number(t.duration) <= 900).slice(0, 3);
  const out: YtmItem[] = [];
  // At most two searches at once, and three total; no eager resolution of an entire catalogue.
  for (let i = 0; i < metadata.length; i += 2) {
    const matched = await Promise.allSettled(metadata.slice(i, i + 2).map(async (t: Json) => {
      signal.throwIfAborted();
      return matchRadioMetadata({ title: t.title, artist: t.artist.name, duration: Number(t.duration) }, await options.resolve(`${t.artist.name} ${t.title}`, signal));
    }));
    out.push(...matched.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []));
    signal.throwIfAborted();
  }
  return out;
}

const pending = new SharedPreparation<YtmItem[]>();
const cache = new Map<string, { at: number; items: YtmItem[] }>();

/** Small successful pool cache; every caller retains independent cancellation. */
export function radioCandidates(videoId: string, signal?: AbortSignal, options?: RadioCandidateOptions): Promise<YtmItem[]> {
  if (!/^[\w-]{11}$/.test(videoId)) return Promise.reject(new Error('Некорректный ID'));
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Отменено'));
  const key = `${videoId}:${options ? 'metadata' : 'youtube'}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) {
    cache.delete(key); cache.set(key, hit); return Promise.resolve(hit.items);
  }
  cache.delete(key);
  return pending.run(key, { signal }, async signal => {
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(new Error('Радио: превышено время ожидания')), 14_000);
    const bounded = AbortSignal.any([signal, timeout.signal]);
    let items: YtmItem[] = [], failure: unknown;
    try {
      try { items = await radioYtm(videoId, bounded); } catch (error) { failure = error; }
      signal.throwIfAborted();
      if (!items.length) bounded.throwIfAborted();
      if (items.length < 12 && !bounded.aborted) {
        try { items.push(...parseYoutubeMix(await requestYtm('next', { videoId, playlistId: `RD${videoId}` }, bounded, 'youtube') as Json)); }
        catch (error) { failure = error; }
      }
      signal.throwIfAborted();
      if (!items.length) bounded.throwIfAborted();
      if (!items.length && options && !bounded.aborted) {
        try { items = await deezerFallback(options, bounded); } catch (error) { failure = error; }
      }
      signal.throwIfAborted();
      if (!items.length) bounded.throwIfAborted();
      const seen = new Set<string>([videoId]);
      items = items.filter(t => { if (seen.has(t.videoId)) return false; seen.add(t.videoId); return true; }).slice(0, 80);
      if (!items.length && failure) throw failure;
      if (items.length) {
        cache.set(key, { at: Date.now(), items });
        while (cache.size > 64) cache.delete(cache.keys().next().value!);
      }
      return items;
    } finally { clearTimeout(timer); }
  });
}
