import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { SoundCloudCatalog, SoundCloudCatalogError } from '../public/soundcloud-catalog.ts';

export function registerSoundCloudCatalogRoutes(app: FastifyInstance, services: Services, catalog = new SoundCloudCatalog()): void {
  app.get<{ Params: { id: string } }>('/api/catalog/soundcloud/artists/:id', async (req, reply) => {
    const ctl = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) ctl.abort(); });
    reply.header('Cache-Control', 'private, no-store');
    try {
      const page = await catalog.get(req.params.id, ctl.signal);
      const tracks = services.publicMusic.rememberSoundCloud(page.tracks);
      const known = services.publicMusic.known('soundcloud', tracks.map((track) => track.externalId));
      return { id: page.id, userId: page.id, permalink: page.permalink, type: 'artist' as const, title: page.title,
        description: page.description, coverUrl: page.coverUrl, source: 'soundcloud' as const, limited: true as const,
        tracks: tracks.map((track) => ({ ...track, libraryTrackId: known.get(track.externalId) ?? null })) };
    } catch (error) {
      if (ctl.signal.aborted) return reply.code(499).send({ error: 'Отменено' });
      if (error instanceof SoundCloudCatalogError) return reply.code(error.statusCode).send({ error: error.message });
      return reply.code(502).send({ error: 'SoundCloud не ответил. Попробуйте ещё раз.' });
    }
  });
}
