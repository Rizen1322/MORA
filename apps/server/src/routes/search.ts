import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { audioProviderOf, type AudioProvider, type PublicSource } from '../public/provider.ts';
import { ResolverError } from '../public/ytdlp.ts';

const SOURCES: PublicSource[] = ['ytmusic', 'youtube', 'soundcloud'];
const AUDIO_TYPES: Record<string, string> = { '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.webm': 'audio/webm', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav' };

/** Public search and playback preparation: works without any account. */
export function registerSearchRoutes(app: FastifyInstance, s: Services): void {
  const { publicMusic, lib } = s;

  app.get<{ Params: { id: string } }>('/api/tracks/:id/cover', async (req, reply) => {
    const file = await publicMusic.ensureCover(req.params.id);
    if (!file) return reply.code(404).header('Cache-Control', 'no-store').send();
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.type(file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    return reply.send(fs.createReadStream(file));
  });

  app.get('/api/search/sources', async () => ({
    sources: SOURCES.map((id) => ({ id, available: publicMusic.ytdlp.available || id === 'ytmusic' })),
    resolver: publicMusic.ytdlp.available,
  }));

  app.get<{ Params: { source: string }; Querystring: { q?: string } }>('/api/search/:source', async (req, reply) => {
    const source = req.params.source as PublicSource;
    if (!SOURCES.includes(source)) return reply.code(404).send({ error: 'неизвестный источник' });
    const query = String(req.query.q ?? '').trim();
    if (query.length > 200) return reply.code(400).send({ error: 'слишком длинный запрос' });
    // A closed request (the listener typed further) cancels the work behind it.
    const ctl = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) ctl.abort(); });
    try {
      const items = await publicMusic.search(source, query, ctl.signal);
      const known = publicMusic.known(audioProviderOf(source), items.map((i) => i.externalId));
      return { items: items.map((i) => ({ ...i, libraryTrackId: known.get(i.externalId) ?? null })) };
    } catch (e) {
      if (ctl.signal.aborted) return reply.code(499).send({ error: 'отменено' });
      const kind = e instanceof ResolverError ? e.kind : 'failed';
      return reply.code(kind === 'not-installed' ? 503 : 502).send({ error: (e as Error).message, kind });
    }
  });

  app.post<{ Body: { provider?: string; externalId?: string } }>('/api/public/warmup', async (req, reply) => {
    const provider = req.body?.provider;
    if (provider !== 'youtube' && provider !== 'soundcloud') return reply.code(400).send({ error: 'неизвестный источник' });
    const ctl = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) ctl.abort(); });
    try { return { ready: await publicMusic.warmup(provider, String(req.body.externalId ?? ''), ctl.signal) }; }
    catch { return { ready: false }; }
  });

  app.post<{ Body: { provider?: string; externalId?: string; priority?: number; progressive?: boolean } }>('/api/public/prepare', async (req, reply) => {
    const provider = req.body?.provider as AudioProvider;
    const externalId = String(req.body?.externalId ?? '');
    if (provider !== 'youtube' && provider !== 'soundcloud') return reply.code(400).send({ error: 'неизвестный источник' });
    const priority = ([0, 1, 2, 3] as const).find((p) => p === req.body?.priority) ?? 0;
    try {
      return { trackId: await (req.body.progressive === true ? publicMusic.prepareProgressive(provider, externalId) : publicMusic.prepare(provider, externalId, priority)) };
    } catch (e) {
      const kind = e instanceof ResolverError ? e.kind : 'failed';
      return reply.code(kind === 'not-installed' ? 503 : 502).send({ error: (e as Error).message, kind });
    }
  });

  app.get<{ Params: { id: string } }>('/api/public/radio/:id', async (req, reply) => {
    const ctl = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) ctl.abort(); });
    try {
      const items = await publicMusic.radio(req.params.id, ctl.signal);
      const known = publicMusic.known('youtube', items.map((i) => i.externalId));
      return { items: items.map((i) => ({ ...i, libraryTrackId: known.get(i.externalId) ?? null })) };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  /** Chooses which recording plays for a track (null = the original). Likes, playlists and history stay put. */
  app.post<{ Params: { id: string }; Body: { assetId?: string | null } }>('/api/tracks/:id/binding', async (req, reply) => {
    const track = lib.get(req.params.id);
    if (!track) return reply.code(404).send({ error: 'трек не найден' });
    const requested = req.body?.assetId ?? null;
    if (requested !== null) {
      const asset = lib.get(lib.mediaId(String(requested)));
      if (!asset || asset.status !== 'ok') return reply.code(404).send({ error: 'запись не найдена' });
      lib.bind(track.id, asset.id === track.id ? null : asset.id);
    } else lib.bind(track.id, null);
    return { ok: true, mediaId: lib.mediaId(track.id) };
  });

  /** Original audio file for a short preview (Range requests; no transcoding). */
  app.get<{ Params: { id: string } }>('/api/tracks/:id/audio', async (req, reply) => {
    const t = lib.media(req.params.id);
    if (!t) return reply.code(404).send({ error: 'трек не найден' });
    let file: string;
    try { file = await lib.resolveMediaPath(t.id); } catch (e) { return reply.code(410).send({ error: (e as Error).message }); }
    const size = fs.statSync(file).size;
    const type = AUDIO_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    let start = 0, end = size - 1;
    if (m) {
      start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
      if (start > end || start >= size) return reply.code(416).header('Content-Range', `bytes */${size}`).send();
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    reply.header('Accept-Ranges', 'bytes').header('Content-Length', String(end - start + 1)).header('Content-Type', type).header('Cache-Control', 'no-store');
    return reply.send(fs.createReadStream(file, { start, end }));
  });

  app.post<{ Params: { id: string }; Body: { saved?: boolean } }>('/api/tracks/:id/save', async (req, reply) => {
    if (!lib.get(req.params.id)) return reply.code(404).send({ error: 'трек не найден' });
    lib.setSaved(req.params.id, req.body?.saved !== false);
    return { ok: true };
  });
}
