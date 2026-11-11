import type { Services } from './app.ts';
import { getSettings } from './automix.ts';
import type { NativeMediaSource, NativePreparationItem } from '@automix/core/native-preparation.ts';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { TrackRow } from './library.ts';
import { readRecipe, recipeContext, type RecipeContext } from './phrase-recipes.ts';

const RESOLVE_TIMEOUT_MS = 20000;
// A growing Wave reserve is handed off several times; stream addresses outlive 30 min, so do not re-run yt-dlp each time.
const RESOLVED_TTL_MS = 30 * 60 * 1000;
const resolvedBy = new WeakMap<Services, Map<string, { source: NativeMediaSource; at: number }>>();
interface Entry { trackId: string; entryId: string; file: number; transitionContext?: RecipeContext; fromEntryId?: string }
/** A verified Yandex download sits in remote/yandex/<content hash>.mp3 (YandexAudio): the phone can play it offline. */
function yandexCachedAudio(s: Services, track: TrackRow): string | null {
  if (!/^[a-f0-9]{64}$/.test(track.content_hash)) return null;
  const file = path.join(s.cfg.dataDir, 'remote', 'yandex', `${track.content_hash}.mp3`);
  return existsSync(file) ? file : null;
}
function localFile(s: Services, trackId: string): string | null {
  const t = s.lib.media(trackId);
  if (!t) return null;
  return s.lib.sources(t.id).find(source => source.kind !== 'remote' && source.path)?.path
    ?? s.publicMusic.cachedAudioPath(t.id)
    ?? yandexCachedAudio(s, t);
}
export async function nativeSources(s: Services, entries: Entry[], previousId: string, nativeFiles: string[] = []) {
  if (!Array.isArray(entries) || entries.length > 1000 || entries.some(e => !e || typeof e.trackId !== 'string'
    || typeof e.entryId !== 'string' || !Number.isSafeInteger(e.file) || e.file < 0 || e.file >= 1000000)) throw Error('Неверная очередь');
  if (!Array.isArray(nativeFiles) || nativeFiles.length > 1000 || nativeFiles.some(id => typeof id !== 'string' || id.length > 512)) throw Error('Неверные локальные файлы');
  const native = new Set(nativeFiles);
  let resolved = resolvedBy.get(s);
  if (!resolved) resolvedBy.set(s, resolved = new Map());
  let analysisBytes = 0;
  const items: NativePreparationItem[] = new Array(entries.length);
  let next = 0;
  // Address resolution happens only during handoff; native owns every later transfer/decode.
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++, entry = entries[index], track = s.lib.media(entry.trackId);
      if (!track || !(track.duration > 0)) throw Error('Неподдерживаемый трек в очереди');
      const identity = s.lib.get(entry.trackId) ?? track;
      const sources = s.lib.sources(track.id), remote = sources.find(source => source.kind === 'remote');
      const resolving = (async (): Promise<NativeMediaSource> => {
        if (native.has(entry.trackId)) return { kind: 'upload', trackId: entry.trackId };
        const local = localFile(s, track.id);
        if (local && await fs.stat(local).then(stat => stat.isFile()).catch(() => false)) return { kind: 'upload', trackId: track.id };
        const cached = resolved.get(track.id);
        if (cached && Date.now() - cached.at < RESOLVED_TTL_MS) return cached.source;
        let found: NativeMediaSource;
        if (remote && ['youtube', 'soundcloud'].includes(remote.provider)) {
          const resolver = s.publicMusic.ytdlp as unknown as { nativeSource(url: string): Promise<NativeMediaSource> };
          if (typeof resolver.nativeSource !== 'function') throw Error('Нужен нативный мобильный загрузчик');
          const meta = JSON.parse(remote.meta || '{}') as { pageUrl?: string; canonicalUrl?: string };
          found = await resolver.nativeSource(meta.pageUrl ?? meta.canonicalUrl ?? (remote.provider === 'youtube'
            ? `https://www.youtube.com/watch?v=${encodeURIComponent(remote.external_id ?? '')}`
            : `https://soundcloud.com/${encodeURIComponent(remote.external_id ?? '')}`));
        } else if (remote) {
          const provider = s.providers.get(remote.provider);
          if (!provider?.nativeSource) throw Error('Источник пока не поддерживает нативную подготовку');
          found = await provider.nativeSource(remote);
        } else throw Error('Не найден источник аудио');
        resolved.set(track.id, { source: found, at: Date.now() });
        if (resolved.size > 500) resolved.delete(resolved.keys().next().value!);
        return found;
      })();
      resolving.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      let source: NativeMediaSource;
      try {
        source = await Promise.race([resolving, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), RESOLVE_TIMEOUT_MS); })]);
      } catch { source = { kind: 'unavailable' }; }
      finally { clearTimeout(timer); }
      const analysis = s.analysis.get(track.content_hash);
      const size = analysis ? JSON.stringify(analysis).length : 0;
      const includeAnalysis = analysisBytes + size <= 2 * 1024 * 1024;
      if (includeAnalysis) analysisBytes += size;
      const identitySource = identity.id === track.id ? remote : s.lib.sources(identity.id).find(source => source.kind === 'remote');
      const meta = identitySource ? JSON.parse(identitySource.meta || '{}') as { coverUrl?: string } : {};
      let artwork: NativePreparationItem['artwork'];
      const coverPath = identity.cover_id && s.lib.coverPath(identity.cover_id);
      if (coverPath) {
        const data = await fs.readFile(coverPath);
        if (data.length <= 256 * 1024 && analysisBytes + data.length * 1.4 < 4 * 1024 * 1024) {
          analysisBytes += data.length * 1.4;
          artwork = { base64: data.toString('base64'), mime: coverPath.endsWith('.png') ? 'image/png' : coverPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
        }
      }
      let phraseTransition: NativePreparationItem['phraseTransition'];
      if (getSettings(s.db).automix.enabled && entry.transitionContext && typeof entry.fromEntryId === 'string'
        && entry.fromEntryId.length > 0 && entry.fromEntryId !== entry.entryId) {
        try {
          const c = recipeContext(entry.transitionContext), saved = c && readRecipe(s, c);
          if (saved?.recipe && saved.toId === entry.trackId) phraseTransition = { fromTrackId: saved.fromId, fromEntryId: entry.fromEntryId, recipe: saved.recipe };
        } catch { /* Reordered or stale edges use the normal planner. */ }
      }
      items[index] = { ...entry, title: identity.title, artist: identity.artist, duration: track.duration,
        mixingAllowed: s.lib.mixingPolicy.get(track.provider) === true, source,
        ...(phraseTransition ? { phraseTransition } : {}),
        analysis: includeAnalysis ? analysis : null, ...(artwork ? { artwork } : {}),
        ...(meta.coverUrl?.startsWith('https:') ? { coverUrl: meta.coverUrl } : {}) };
    }
  }));
  const previous = s.lib.media(previousId);
  if (!previous) throw Error('Текущий трек не найден');
  // Dead entries are not handed to native; the page removes them by entryId.
  return { items: items.filter(item => item && item.source.kind !== 'unavailable'), previous: { trackId: previousId, duration: previous.duration,
    mixingAllowed: s.lib.mixingPolicy.get(previous.provider) === true, analysis: s.analysis.get(previous.content_hash) },
    settings: getSettings(s.db).automix, feedback: s.automix.ratingStats() };
}

/** Mobile worker only. These private handoff routes are never registered by the desktop server. */
export function registerNativeSources(app: FastifyInstance, services: Services) {
  app.post('/api/mobile/native-sources', async (req: any, reply: any) => {
    try { return await nativeSources(services, req.body?.entries, req.body?.previousId, req.body?.nativeFiles); }
    catch { return reply.code(409).send({ error: 'Не удалось передать источники очереди. Откройте приложение и повторите.' }); }
  });
  app.get('/api/mobile/native-file', async (req: any, reply: any) => {
    const file = typeof req.query.id === 'string' && localFile(services, req.query.id);
    if (!file) return reply.code(404).send({ error: 'Файл не найден' });
    const stat = await fs.stat(file), start = Math.max(0, Math.floor(Number(req.query.start) || 0));
    const handle = await fs.open(file, 'r');
    try {
      const bytes = new Uint8Array(Math.max(0, Math.min(262144, stat.size - start)));
      const result = await handle.read(bytes, 0, bytes.length, start);
      reply.header('Content-Type', 'application/octet-stream'); reply.header('X-Native-Length', String(stat.size));
      return reply.send(bytes.subarray(0, result.bytesRead));
    } finally { await handle.close(); }
  });
}
