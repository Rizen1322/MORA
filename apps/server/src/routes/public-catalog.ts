import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { PublicCatalog, PublicCatalogError } from '../public/catalog.ts';

export function registerPublicCatalogRoutes(app: FastifyInstance, services: Services, catalog = new PublicCatalog()): void {
  for (const type of ['artist', 'album'] as const) {
    app.get<{ Params: { id: string } }>(`/api/catalog/public/${type}s/:id`, async (req, reply) => {
      const ctl = new AbortController();
      reply.raw.once('close', () => { if (!reply.raw.writableEnded) ctl.abort(); });
      reply.header('Cache-Control', 'private, no-store');
      try {
        const page = await catalog.get(type, req.params.id, ctl.signal);
        const tracks = services.publicMusic.rememberYtm(page.tracks), known = services.publicMusic.known('youtube', tracks.map(t => t.externalId));
        return { ...page, tracks: tracks.map(t => ({ ...t, libraryTrackId: known.get(t.externalId) ?? null })) };
      } catch (e) {
        if (ctl.signal.aborted) return reply.code(499).send({ error: 'Отменено' });
        if (e instanceof PublicCatalogError) return reply.code(e.statusCode).send({ error: e.message });
        return reply.code(502).send({ error: 'YouTube Music не ответил. Попробуйте ещё раз.' });
      }
    });
  }
}
