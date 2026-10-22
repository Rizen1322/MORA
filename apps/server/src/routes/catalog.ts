import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CatalogSearchType, ReactionValue } from '@automix/core';
import { isYandexTrackId } from '../providers/yandex-audio.ts';
import { tx } from '../db.ts';
import type { Services } from '../app.ts';
import { CatalogError } from '../providers/yandex-catalog.ts';

function pageOf(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value) || Number(value) > 100) throw new CatalogError(400, 'Некорректная страница каталога');
  return Number(value);
}

function idOf(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{1,24}$/.test(value)) throw new CatalogError(400, 'Некорректный ID каталога');
  return value;
}

async function respond(reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> {
  reply.header('Cache-Control', 'private, no-store');
  try { return await work(); }
  catch (error) {
    if (error instanceof CatalogError) return reply.code(error.statusCode).send({ error: error.message });
    return reply.code(502).send({ error: 'Не удалось загрузить каталог Яндекс Музыки. Повторите запрос' });
  }
}

export function registerCatalogRoutes(app: FastifyInstance, services: Services): void {
  const catalog = services.providers.yandex.catalog;
  app.get('/api/catalog/yandex/home', async (_req, reply) => respond(reply, () => catalog.home()));
  app.get('/api/providers/yandex/reactions/sync', async (_req, reply) => { reply.header('Cache-Control', 'private, no-store'); return services.yandexReactions.stats(); });
  app.post<{ Params: { id: string }; Body: { value?: unknown } }>('/api/catalog/yandex/tracks/:id/reaction', async (req, reply) => respond(reply, async () => {
    if (!isYandexTrackId(req.params.id)) throw new CatalogError(400, 'Некорректный ID трека Яндекса');
    const raw = req.body?.value;
    if (typeof raw !== 'number' || ![-1, 0, 1].includes(raw)) throw new CatalogError(400, 'Оценка должна быть -1, 0 или 1');
    if (!services.providers.yandex.reactionSession()) throw new CatalogError(409, 'Подключите аккаунт Яндекс Музыки');
    const externalId = await services.providers.yandex.verifyReactionId(req.params.id);
    tx(services.db, () => services.yandexReactions.enqueueExternal(externalId, raw as ReactionValue));
    services.events.emit({ type: 'library', reason: 'reaction' });
    return { value: raw, sync: await services.yandexReactions.settleExternal(externalId) };
  }));
  app.get<{ Querystring: { q?: unknown; page?: unknown; type?: unknown } }>('/api/catalog/yandex/search', async (req, reply) => respond(reply, async () => {
    const { q, type = 'all' } = req.query;
    if (typeof q !== 'string' || !q.trim() || q.trim().length > 300 || /[\u0000-\u001f\u007f]/.test(q)) throw new CatalogError(400, 'Введите поисковый запрос длиной до 300 символов');
    if (typeof type !== 'string' || !['all', 'track', 'artist', 'album'].includes(type)) throw new CatalogError(400, 'Некорректный тип поиска');
    return catalog.search(q.trim(), pageOf(req.query.page), type as CatalogSearchType);
  }));
  app.get<{ Params: { id: string }; Querystring: { page?: unknown } }>('/api/catalog/yandex/artists/:id', async (req, reply) => respond(reply, () => catalog.artistPage(idOf(req.params.id), pageOf(req.query.page))));
  app.get<{ Params: { id: string } }>('/api/catalog/yandex/albums/:id', async (req, reply) => respond(reply, () => catalog.albumPage(idOf(req.params.id))));
}
