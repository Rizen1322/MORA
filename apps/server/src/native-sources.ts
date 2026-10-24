import type { Services } from './app.ts';
import { getSettings } from './automix.ts';
import type { NativeMediaSource, NativePreparationItem } from '@automix/core/native-preparation.ts';
import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';

interface Entry { trackId: string; entryId: string; file: number }
function localFile(s: Services, trackId: string): string | null {
  const t = s.lib.media(trackId);
  if (!t) return null;
  return s.lib.sources(t.id).find(source => source.kind !== 'remote' && source.path)?.path
    ?? s.publicMusic.cachedAudioPath(t.id);
}
export async function nativeSources(s: Services, entries: Entry[], previousId: string) {
  if (!Array.isArray(entries) || entries.length > 1000 || entries.some(e => !e || typeof e.trackId !== 'string'
    || typeof e.entryId !== 'string' || !Number.isSafeInteger(e.file) || e.file < 0 || e.file >= 1000000)) throw Error('Неверная очередь');
  let analysisBytes = 0;
  const items: NativePreparationItem[] = new Array(entries.length);
  let next = 0;
  // Address resolution happens only during handoff; native owns every later transfer/decode.
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++, entry = entries[index], track = s.lib.media(entry.trackId);
      if (!track || !(track.duration > 0)) throw Error('Неподдерживаемый трек в очереди');
      let source: NativeMediaSource;
      const sources = s.lib.sources(track.id), remote = sources.find(source => source.kind === 'remote');
      try {
      const local = localFile(s, track.id);
      if (local && await fs.stat(local).then(stat => stat.isFile()).catch(() => false)) source = { kind: 'upload', trackId: track.id };
      else if (remote && ['youtube', 'soundcloud'].includes(remote.provider)) {
        const resolver = s.publicMusic.ytdlp as unknown as { nativeSource(url: string): Promise<NativeMediaSource> };
        if (typeof resolver.nativeSource !== 'function') throw Error('Нужен нативный мобильный загрузчик');
        const meta = JSON.parse(remote.meta || '{}') as { pageUrl?: string; canonicalUrl?: string };
        source = await resolver.nativeSource(meta.pageUrl ?? meta.canonicalUrl ?? (remote.provider === 'youtube'
          ? `https://www.youtube.com/watch?v=${encodeURIComponent(remote.external_id ?? '')}`
          : `https://soundcloud.com/${encodeURIComponent(remote.external_id ?? '')}`));
      } else if (remote) {
        const provider = s.providers.get(remote.provider);
        if (!provider?.nativeSource) throw Error('Источник пока не поддерживает нативную подготовку');
        source = await provider.nativeSource(remote);
      } else throw Error('Не найден источник аудио');
      } catch { source = { kind: 'unavailable' }; }
      const analysis = s.analysis.get(track.content_hash);
      const size = analysis ? JSON.stringify(analysis).length : 0;
      const includeAnalysis = analysisBytes + size <= 2 * 1024 * 1024;
      if (includeAnalysis) analysisBytes += size;
      const meta = remote ? JSON.parse(remote.meta || '{}') as { coverUrl?: string } : {};
      let artwork: NativePreparationItem['artwork'];
      const coverPath = track.cover_id && s.lib.coverPath(track.cover_id);
      if (coverPath) {
        const data = await fs.readFile(coverPath);
        if (data.length <= 256 * 1024 && analysisBytes + data.length * 1.4 < 4 * 1024 * 1024) {
          analysisBytes += data.length * 1.4;
          artwork = { base64: data.toString('base64'), mime: coverPath.endsWith('.png') ? 'image/png' : coverPath.endsWith('.webp') ? 'image/webp' : 'image/jpeg' };
        }
      }
      items[index] = { ...entry, title: track.title, artist: track.artist, duration: track.duration,
        mixingAllowed: s.lib.mixingPolicy.get(track.provider) === true, source,
        analysis: includeAnalysis ? analysis : null, ...(artwork ? { artwork } : {}),
        ...(meta.coverUrl?.startsWith('https:') ? { coverUrl: meta.coverUrl } : {}) };
    }
  }));
  const previous = s.lib.media(previousId);
  if (!previous) throw Error('Текущий трек не найден');
  return { items, previous: { trackId: previousId, duration: previous.duration,
    mixingAllowed: s.lib.mixingPolicy.get(previous.provider) === true, analysis: s.analysis.get(previous.content_hash) },
    settings: getSettings(s.db).automix };
}

/** Mobile worker only. These private handoff routes are never registered by the desktop server. */
export function registerNativeSources(app: FastifyInstance, services: Services) {
  app.post('/api/mobile/native-sources', async (req: any, reply: any) => {
    try { return await nativeSources(services, req.body?.entries, req.body?.previousId); }
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
