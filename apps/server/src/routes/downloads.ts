import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { ResolverError } from '../public/ytdlp.ts';

export function registerDownloadRoutes(app: FastifyInstance, s: Services): void {
  const { downloads, lib } = s;

  app.get('/api/downloads', async () => ({ jobs: downloads.list(), usage: await downloads.usage() }));

  app.post<{ Body: { trackId?: string; provider?: string; externalId?: string; title?: string } }>('/api/downloads', async (req, reply) => {
    try { return { job: downloads.add(req.body ?? {}) }; }
    catch (e) { return reply.code(e instanceof ResolverError ? 400 : 500).send({ error: (e as Error).message }); }
  });

  /** Downloads every track of a playlist, keeping its order; duplicates collapse to one job. */
  app.post<{ Params: { id: string } }>('/api/playlists/:id/download', async (req, reply) => {
    const rows = s.db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(req.params.id) as { track_id: string }[];
    if (!rows.length) return reply.code(404).send({ error: 'плейлист пуст или не найден' });
    const jobs = [...new Set(rows.map((r) => r.track_id))].filter((id) => lib.get(id)).map((trackId) => downloads.add({ trackId }));
    return { jobs: jobs.length };
  });

  app.post<{ Params: { id: string; action: string } }>('/api/downloads/:id/:action', async (req, reply) => {
    const { id, action } = req.params;
    if (action === 'pause') downloads.pause(id);
    else if (action === 'resume' || action === 'retry') downloads.resume(id);
    else if (action === 'cancel') downloads.cancel(id);
    else return reply.code(404).send({ error: 'неизвестное действие' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/tracks/:id/download', async (req, reply) => {
    if (!lib.get(req.params.id)) return reply.code(404).send({ error: 'трек не найден' });
    downloads.unpin(req.params.id);
    return { ok: true };
  });

  app.put<{ Body: { cacheLimitMb?: number } }>('/api/downloads/settings', async (req, reply) => {
    const mb = Number(req.body?.cacheLimitMb);
    if (!Number.isFinite(mb)) return reply.code(400).send({ error: 'нужен размер в мегабайтах' });
    downloads.setCacheLimitMb(mb);
    return { usage: await downloads.usage() };
  });

  app.post('/api/downloads/clear-cache', async () => ({ removed: await downloads.clearCache(), usage: await downloads.usage() }));
}
