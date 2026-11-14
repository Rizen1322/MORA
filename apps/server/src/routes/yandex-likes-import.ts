import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';

export function registerYandexLikesImportRoutes(app: FastifyInstance, { yandexLikesImport: job }: Services) {
  // Native screens consume an object; keep the nullable response for existing clients.
  app.get<{ Querystring: { envelope?: string } }>('/api/providers/yandex/likes/import', (req) => req.query.envelope === '1' ? { job: job.status() } : job.status());
  app.post('/api/providers/yandex/likes/import', (_req, reply) => {
    try { return job.start(); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
  app.post('/api/providers/yandex/likes/import/pause', () => job.pause());
  app.post('/api/providers/yandex/likes/import/cancel', () => job.cancel());
  app.post<{ Body: { retryFailed?: boolean } }>('/api/providers/yandex/likes/import/resume', (req, reply) => {
    if (req.body?.retryFailed !== undefined && typeof req.body.retryFailed !== 'boolean') return reply.code(400).send({ error: 'Некорректный параметр повтора' });
    try { return job.resume(req.body?.retryFailed === true); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
  });
}
