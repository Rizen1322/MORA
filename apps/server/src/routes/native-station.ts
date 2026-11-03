import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { getSettings } from '../automix.ts';
import { q } from '../db.ts';
import { isYandexTrackId } from '../providers/yandex-audio.ts';
import { radioIdentity, rankRadio, tasteSeeds } from '../../../web/src/lib/radio-taste.ts';
import type { PublicTrack } from '../public/provider.ts';

type Body = { kind: 'own' | 'yandex' | 'online'; seed?: { title: string; artist: string }; currentId?: string; exclude: string[]; count?: number; yandexSessionId?: string };

export function registerNativeStationRoutes(app: FastifyInstance, s: Services): void {
  app.post<{ Body: Body }>('/internal/desktop/station-next', async (req, reply) => {
    const secret = s.cfg.desktopPlaybackToken, supplied = req.headers['x-mora-desktop-token'];
    if (!secret || typeof supplied !== 'string' || Buffer.byteLength(secret) !== Buffer.byteLength(supplied) ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(supplied))) return reply.code(403).send({ error: 'Недоступно' });
    const b = req.body;
    const validId = (id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 256;
    if (!b || !['own', 'yandex', 'online'].includes(b.kind) || !Array.isArray(b.exclude) || b.exclude.length > 2000 || b.exclude.some(id => !validId(id)) ||
      (b.currentId !== undefined && !validId(b.currentId)) || (b.yandexSessionId !== undefined && !validId(b.yandexSessionId)) ||
      (b.count !== undefined && (!Number.isInteger(b.count) || b.count < 1 || b.count > 6)) ||
      (b.seed !== undefined && (!b.seed || typeof b.seed.title !== 'string' || typeof b.seed.artist !== 'string' || !(b.seed.title.trim() || b.seed.artist.trim()) || b.seed.title.length + b.seed.artist.length > 199)))
      return reply.code(400).send({ error: 'Некорректные параметры волны' });
    const abort = new AbortController();
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) abort.abort(); });
    try {
      const count = b.count ?? 3, excluded = new Set([...b.exclude, ...(b.currentId ? [b.currentId] : [])]);
      const settings = getSettings(s.db).wave;
      if (b.kind === 'own') {
        const picks = s.wave.next({ currentId: b.currentId ?? null, session: b.exclude, exclude: [...excluded], mood: settings.mood, diversity: settings.diversity, mix: settings.mode === 'mix', count });
        if (!picks.length) throw new Error('Пока нет рекомендаций');
        return { entries: picks.map(p => ({ trackId: p.id, entryId: randomUUID(), origin: 'wave' })), context: { type: 'wave', label: 'Моя волна' } };
      }
      if (b.kind === 'yandex') {
        const queue = [...excluded].flatMap(id => s.lib.sources(id).filter(src => src.provider === 'yandex' && src.kind === 'remote' && isYandexTrackId(src.external_id ?? '')).map(src => src.external_id!)).slice(-200);
        const result = await s.providers.yandex.wave(b.yandexSessionId, queue, { count: Math.min(count, 4), exclude: queue, seeds: settings.yandexSeeds });
        abort.signal.throwIfAborted();
        const disliked = new Set(s.lib.listDTO().filter(t => t.reaction < 0).map(t => t.id));
        const entries = result.items.filter(item => item.trackId && !excluded.has(item.trackId) && !disliked.has(item.trackId)).slice(0, count).map(item => ({ trackId: item.trackId!, entryId: randomUUID(), origin: 'yandex', yandexId: item.yandexId, yandexSessionId: result.sessionId, yandexBatchId: result.batchId }));
        if (!entries.length) throw new Error('Пока нет рекомендаций Яндекса');
        return { entries, context: { type: 'yandex-wave', label: 'Моя волна Яндекса' }, yandexSessionId: result.sessionId };
      }
      const library = s.lib.listDTO();
      const history = q(s.db, 'SELECT track_id, started_at FROM plays ORDER BY id DESC LIMIT 200').all() as { track_id: string; started_at: number }[];
      const byId = new Map(library.map(t => [t.id, t]));
      const seen = new Set<string>();
      for (const id of excluded) {
        const t = byId.get(id); if (t) seen.add(radioIdentity(t));
        for (const src of s.lib.sources(id)) if (src.kind === 'remote') seen.add(`${src.provider}:${src.external_id}`);
      }
      for (const play of history) { const t = byId.get(play.track_id); if (t && Date.now() - play.started_at < 7200000) seen.add(radioIdentity(t)); }
      const initial = !b.currentId && !b.exclude.length;
      const seeds = tasteSeeds(library, history.length ? history[0].started_at : 0);
      const primary = initial && b.seed ? b.seed : (b.currentId ? byId.get(b.currentId) : undefined) ?? seeds.shift() ?? b.seed;
      if (!primary) throw new Error('Поставьте лайк или выберите основу радио');
      const resolved = await Promise.allSettled([primary, ...seeds.slice(0, 2)].map(async seed => (await s.publicMusic.search('ytmusic', `${seed.artist} ${seed.title}`.trim(), abort.signal)).find(t => t.playable)));
      abort.signal.throwIfAborted();
      const found = resolved.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []);
      const first = resolved[0].status === 'fulfilled' ? resolved[0].value : undefined;
      if (initial && b.seed && !first) throw new Error('Не нашли начальную песню для радио');
      if (!found.length) throw new Error('Не нашли основу радио');
      const results = await Promise.allSettled([...new Set(found.map(t => t.externalId))].slice(0, 3).map(id => s.publicMusic.radio(id, abort.signal)));
      abort.signal.throwIfAborted();
      const pool = results.flatMap(r => r.status === 'fulfilled' ? r.value.map(t => ({ ...t, libraryTrackId: t.libraryTrackId ?? null })) : []);
      let picks: PublicTrack[];
      if (initial && b.seed && first) {
        if (!rankRadio([first], library, new Set(), [], settings, primary, Infinity).length) throw new Error('Эта песня отмечена дизлайком');
        seen.add(radioIdentity(first)); seen.add(`${first.audioProvider}:${first.externalId}`);
        picks = [first, ...rankRadio([...found.slice(1), ...pool], library, seen, [first.artist], settings, primary)];
      } else {
        for (const t of found) { seen.add(radioIdentity(t)); seen.add(`${t.audioProvider}:${t.externalId}`); }
        picks = rankRadio(pool, library, seen, [], settings, primary);
      }
      if (!picks.length) throw new Error('Пока нет свежих рекомендаций');
      const entries = await Promise.all(picks.slice(0, count).map(async t => ({ trackId: await s.publicMusic.prepareProgressive(t.audioProvider, t.externalId), entryId: randomUUID(), origin: 'wave' })));
      abort.signal.throwIfAborted();
      return { entries, context: { type: 'online-radio', label: 'Онлайн-радио · Моя волна' } };
    } catch (e) {
      return reply.code(abort.signal.aborted ? 499 : 502).send({ error: (e as Error).message });
    }
  });
}
