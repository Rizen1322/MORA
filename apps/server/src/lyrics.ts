import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { matchConfidence, versionLabels } from './public/match.ts';

/**
 * Song lyrics for the interface (karaoke view). Timed lines from LRCLIB
 * (https://lrclib.net/docs) or a local .lrc/.txt next to the audio file.
 * These timings are for display only: AutoMix keeps using its own measured
 * vocal activity, never these lines.
 */

export interface LyricLine { t: number; text: string }
export interface TimedLyricWord { t: number; end: number; text: string }
export interface TimedLyricLine extends LyricLine { words: TimedLyricWord[] }
export interface Lyrics {
  status: 'synced' | 'plain' | 'none';
  lines: LyricLine[];
  plain: string;
  source: 'lrclib' | 'file' | null;
  /** What was matched, so the listener can judge a wrong match. */
  matched?: { title: string; artist: string; duration: number | null };
}

/** Reads real local Whisper timestamps; never estimates word timing from line duration. */
export function parseWhisperLyrics(raw: unknown, duration: number): TimedLyricLine[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as { version?: unknown; words?: unknown; lines?: unknown };
  if (data.version !== 'whisper-words-1' || !Array.isArray(data.words) || !Array.isArray(data.lines) || !data.words.length) return null;
  const words = data.words as { start?: unknown; end?: unknown; word?: unknown }[];
  if (!words.every((w) => Number.isFinite(w?.start) && Number.isFinite(w?.end) && (w.start as number) >= 0
    && (w.end as number) > (w.start as number) && (w.end as number) <= duration + 1 && typeof w.word === 'string' && w.word.trim())) return null;
  const segments = data.lines as { start?: unknown; end?: unknown; text?: unknown }[];
  if (!segments.every((l) => Number.isFinite(l?.start) && Number.isFinite(l?.end) && (l.start as number) >= 0
    && (l.end as number) > (l.start as number) && (l.end as number) <= duration + 1 && typeof l.text === 'string')) return null;
  if (words.some((w, i) => i > 0 && (w.start as number) < (words[i - 1].start as number))) return null;
  return segments.flatMap((line) => {
    const lineWords = words.filter((w) => (w.start as number) >= (line.start as number) - 0.01 && (w.end as number) <= (line.end as number) + 0.01);
    if (!lineWords.length) return [];
    return [{ t: line.start as number, text: line.text as string,
      words: lineWords.map((w) => ({ t: w.start as number, end: w.end as number, text: w.word as string })) }];
  });
}

const UA = 'MORA/0.1 (local desktop music player)';
const NONE: Lyrics = { status: 'none', lines: [], plain: '', source: null };

/** Parses LRC: [mm:ss.xx] lines, several stamps per line, [offset:+/-ms]. */
export function parseLrc(text: string): LyricLine[] {
  const offset = Number(/\[offset:\s*([+-]?\d+)\s*\]/i.exec(text)?.[1] ?? 0) / 1000;
  const out: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const words = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: Math.max(0, Number(m[1]) * 60 + Number(m[2].replace(':', '.')) - offset), text: words });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Removes upload decorations ("Official Video", "Lyrics", "HD") but keeps version words. */
export function cleanTitle(title: string): string {
  return title
    .replace(/[([](?:official\s*(?:music\s*)?(?:video|audio|clip|lyric video)|lyrics?|lyric video|hd|hq|4k|audio|video|клип|премьера[^)\]]*)[)\]]/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
}

interface LrclibRow { trackName: string; artistName: string; albumName?: string; duration?: number; syncedLyrics?: string | null; plainLyrics?: string | null; instrumental?: boolean }

async function lrclib(pathname: string, params: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const url = new URL(`https://lrclib.net${pathname}`);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  // A cold connection or a temporary LRCLIB failure should not require a UI retry.
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
      if (attempt === 0 && (res.status === 408 || res.status >= 500)) {
        await res.body?.cancel();
        await delay(350, undefined, { signal });
        continue;
      }
      break;
    } catch (e) {
      if (signal?.aborted || attempt > 0 || !(e instanceof TypeError || (e as Error).name === 'TimeoutError')) throw e;
      await delay(350, undefined, { signal });
    }
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Сервис текстов ответил ${res.status}`);
  const text = await res.text();
  if (text.length > 2 << 20) throw new Error('Слишком большой ответ сервиса текстов');
  return JSON.parse(text);
}

function fromRow(r: LrclibRow): Lyrics {
  const lines = r.syncedLyrics ? parseLrc(r.syncedLyrics) : [];
  const plain = r.plainLyrics ?? lines.map((l) => l.text).join('\n');
  return { status: lines.length ? 'synced' : plain.trim() ? 'plain' : 'none', lines, plain, source: 'lrclib', matched: { title: r.trackName, artist: r.artistName, duration: r.duration ?? null } };
}

/**
 * Exact lookup by artist, title and duration first; otherwise a search where a
 * candidate must match the artist/title and lie within 4 s of the recording.
 * The first search hit is never taken blindly.
 */
export async function findLyrics(q: { title: string; artist: string; album?: string; duration: number }, signal?: AbortSignal): Promise<Lyrics> {
  signal=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
  const title = cleanTitle(q.title);
  const artist = q.artist.split(/,|&| feat\.? | ft\.? /i)[0].trim();
  let lookupError: unknown;
  const exact = (await lrclib('/api/get', { track_name: title, artist_name: artist, album_name: q.album ?? '', duration: q.duration ? String(Math.round(q.duration)) : '' }, signal)
    .catch((e) => { if (signal?.aborted) throw e; lookupError = e; return null; })) as LrclibRow | null;
  if (exact && (exact.syncedLyrics || exact.plainLyrics)) return fromRow(exact);
  const found = ((await lrclib('/api/search', { track_name: title, artist_name: artist }, signal)) as LrclibRow[] | null) ?? [];
  const scored = found
    .filter((r) => r && (r.syncedLyrics || r.plainLyrics) && (!q.duration || !r.duration || Math.abs(r.duration - q.duration) <= 4))
    .map((r) => ({ r, s: matchConfidence({ title, artist, duration: q.duration }, { title: r.trackName, artist: r.artistName, duration: r.duration, labels: versionLabels(r.trackName) }) + (r.syncedLyrics ? 0.05 : 0) }))
    .sort((a, b) => b.s - a.s);
  if (scored[0] && scored[0].s >= 0.7) return fromRow(scored[0].r);
  // An unavailable exact lookup is not proof that lyrics do not exist.
  if (lookupError) throw lookupError;
  return NONE;
}

/** .lrc or .txt with the same base name as a local audio file. */
export async function sidecarLyrics(audioFile: string): Promise<Lyrics | null> {
  const base = audioFile.slice(0, -path.extname(audioFile).length);
  for (const ext of ['.lrc', '.LRC', '.txt']) {
    const f = base + ext;
    if (!fs.existsSync(f)) continue;
    const text = await fsp.readFile(f, 'utf8');
    if (text.length > 1 << 20) continue;
    const lines = ext.toLowerCase() === '.lrc' ? parseLrc(text) : [];
    return { status: lines.length ? 'synced' : 'plain', lines, plain: lines.length ? lines.map((l) => l.text).join('\n') : text, source: 'file' };
  }
  return null;
}
