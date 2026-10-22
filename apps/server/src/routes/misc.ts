import type { FastifyInstance } from 'fastify';
import { sanitizeSound } from '@automix/core';
import { ANALYZER_VERSION, PLANNER_VERSION } from '@automix/core';
import type { Services } from '../app.ts';
import { getSettings, type AppSettings } from '../automix.ts';
import { kvSet, q } from '../db.ts';
import type { ExternalTrack } from '../providers/types.ts';
import { PRIORITY } from '../analysis.ts';
import { isYandexTrackId } from '../providers/yandex-audio.ts';

const clampNum = (v: unknown, a: number, b: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d;
};

export function registerMiscRoutes(app: FastifyInstance, s: Services): void {
  const { db, providers, lib, events, pcm, analysis, automix } = s;

  app.get('/api/health', async () => ({
    ok: true,
    ffmpeg: s.ffmpegVersion,
    analyzer: ANALYZER_VERSION,
    planner: PLANNER_VERSION,
    analysis: analysis.stats(),
    stems: s.stems.stats(),
    pcmCacheBytes: pcm.totalBytes(),
    pcmCacheLimit: s.cfg.pcmCacheBytes,
    pcmCacheProtectedBytes:pcm.protectedBytes(),
    tracks: (q(db, 'SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n,
    lan: s.cfg.host !== '127.0.0.1' && s.cfg.host !== 'localhost',
  }));

  // Gigabytes are downloaded only with the size the user confirmed in the settings dialog.
  app.post<{ Body: { acceptBytes?: number } }>('/api/stems/gpu', async (req, reply) => {
    const cuda = s.stems.cuda;
    if (!cuda) return reply.code(404).send({ error: 'Ускорение на видеокарте доступно только в приложении для Windows' });
    if (req.body?.acceptBytes !== cuda.status().downloadBytes) return reply.code(400).send({ error: 'Нужно подтвердить размер загрузки' });
    void cuda.install();
    return cuda.status();
  });

  app.delete('/api/stems/gpu', async (_req, reply) => {
    const cuda = s.stems.cuda;
    if (!cuda) return reply.code(404).send({ error: 'Пакет не установлен' });
    try { await cuda.remove(); } catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    return cuda.status();
  });

  app.get('/api/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    events.add(reply);
    req.raw.on('close', () => reply.raw.end());
    return reply;
  });

  app.get('/api/settings', async () => getSettings(db));

  app.put<{ Body: Partial<AppSettings> }>('/api/settings', async (req, reply) => {
    const cur = getSettings(db);
    const b = req.body ?? {};
    if (b.wave?.yandexSeeds !== undefined) {
      const seeds = b.wave.yandexSeeds;
      if (!Array.isArray(seeds) || seeds.length > 12 || seeds.some((seed) => typeof seed !== 'string' || seed.length > 120)) return reply.code(400).send({ error: 'Некорректные настройки Яндекс-волны' });
      if (seeds.length) {
        try {
          const { groups } = await providers.yandex.waveSettings();
          const available = new Set(groups.flatMap((g) => g.values.map((v) => v.seed)));
          if (seeds.some((seed) => !available.has(seed)) || groups.some((g) => g.values.filter((v) => seeds.includes(v.seed)).length > 1)) return reply.code(400).send({ error: 'Яндекс не поддерживает выбранные настройки волны' });
        } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
      }
    }
    const a = { ...cur.automix, ...(b.automix ?? {}) };
    const next: AppSettings = {
      automix: {
        enabled: !!a.enabled,
        maxStretchPercent: clampNum(a.maxStretchPercent, 0, 16, cur.automix.maxStretchPercent),
        maxBlendSeconds: clampNum(a.maxBlendSeconds, 4, 48, cur.automix.maxBlendSeconds),
        eqHandoff: !!a.eqHandoff,
        respectAlbums: !!a.respectAlbums,
        loudnessTarget: a.loudnessTarget === null ? null : clampNum(a.loudnessTarget, -24, -8, -14),
        style: ['auto', 'smooth', 'tight'].includes(a.style) ? a.style : 'auto',
        fallbackSeconds: clampNum(a.fallbackSeconds, 1, 15, cur.automix.fallbackSeconds),
        entryMode: a.entryMode === 'preserve' ? 'preserve' : 'smart',
        maxEntrySkipSeconds: clampNum(a.maxEntrySkipSeconds, 0, 75, cur.automix.maxEntrySkipSeconds ?? 45),
        mixOnNext: a.mixOnNext !== false,
        stemMixing: a.stemMixing !== false,
        loopBridges: a.loopBridges !== false,
        masterTempo: a.masterTempo !== false,
        djPhrasing: a.djPhrasing !== false,
      },
      wave: {
        ...(cur.wave.yandexSeeds ? { yandexSeeds: cur.wave.yandexSeeds } : {}),
        ...(b.wave?.yandexSeeds !== undefined ? { yandexSeeds: [...new Set(b.wave.yandexSeeds)] } : {}),
        mood: ['calm', 'normal', 'energetic'].includes(b.wave?.mood ?? '') ? b.wave!.mood : cur.wave.mood,
        diversity: ['familiar', 'balanced', 'discover'].includes(b.wave?.diversity ?? '') ? b.wave!.diversity : cur.wave.diversity,
        mode: b.wave?.mode === 'mix' || b.wave?.mode === 'normal' ? b.wave.mode : cur.wave.mode,
      },
      ui: { showDiagnostics: b.ui?.showDiagnostics ?? cur.ui.showDiagnostics,
        motion: b.ui?.motion === 'full' || b.ui?.motion === 'reduced' || b.ui?.motion === 'system' ? b.ui.motion : cur.ui.motion ?? 'system',
        graphics: b.ui?.graphics === 'canvas' || b.ui?.graphics === 'auto' ? b.ui.graphics : cur.ui.graphics ?? 'auto' },
      sound: b.sound ? sanitizeSound({ ...cur.sound, ...b.sound }) : cur.sound,
    };
    kvSet(db, 'settings', { ...next, version: 2 });
    return next;
  });

  app.post('/api/system/clear-cache', async () => {
    await pcm.clear();
    automix.clearCache();
    return { ok: true };
  });

  // ---------------------------------------------------------------- providers

  app.get<{ Querystring: { force?: string } }>('/api/providers', async (req) => ({ providers: await providers.infos(req.query.force === '1') }));

  app.post<{ Params: { id: string }; Body: { config?: Record<string, string>; secret?: Record<string, string> } }>('/api/providers/:id/connect', async (req, reply) => {
    const p = providers.get(req.params.id);
    if (!p?.connect) return reply.code(400).send({ error: 'источник нельзя подключить' });
    try {
      await p.connect(req.body?.config ?? {}, req.body?.secret ?? {});
      events.emit({ type: 'providers' });
      return { ok: true, info: await p.info(true) };
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>('/api/providers/:id/disconnect', async (req, reply) => {
    const p = providers.get(req.params.id);
    if (!p?.disconnect) return reply.code(400).send({ error: 'нечего отключать' });
    await p.disconnect();
    events.emit({ type: 'providers' });
    return { ok: true };
  });

  const markKnown = (items: ExternalTrack[], provider: string) => {
    const known = new Map(
      (q(db, "SELECT external_id, track_id FROM track_sources WHERE provider = ? AND kind = 'remote'").all(provider) as { external_id: string; track_id: string }[]).map((r) => [
        r.external_id,
        r.track_id,
      ]),
    );
    return items.map((i) => ({ ...i, libraryTrackId: known.get(i.externalId) ?? null }));
  };

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/providers/:id/search', async (req, reply) => {
    const p = providers.get(req.params.id);
    if (!p?.search) return reply.code(400).send({ error: 'поиск не поддерживается' });
    try {
      const query = String(req.query.q ?? '').trim();
      const items = query ? await p.search(query) : p.featured ? await p.featured() : [];
      return { items: markKnown(items, p.id) };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post<{ Params: { id: string }; Body: { track: ExternalTrack } }>('/api/providers/:id/import', async (req, reply) => {
    const p = providers.get(req.params.id);
    if (!p?.importTrack || !req.body?.track) return reply.code(400).send({ error: 'импорт не поддерживается' });
    try {
      return { trackId: await p.importTrack(req.body.track) };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.get<{ Params: { cover: string } }>('/api/providers/subsonic/cover/:cover', async (req, reply) => {
    try {
      const res = await providers.subsonic.coverStream(req.params.cover);
      if (!res.ok) return reply.code(404).send();
      reply.type(res.headers.get('content-type') ?? 'image/jpeg');
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(Buffer.from(await res.arrayBuffer()));
    } catch {
      return reply.code(404).send();
    }
  });

  app.get<{ Querystring: { session?: string } }>('/api/providers/yandex/wave', async (req, reply) => {
    try {
      return await providers.yandex.wave(req.query.session || null, [], { seeds: getSettings(db).wave.yandexSeeds });
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post<{ Body: { session?: string | null; queue?: string[]; count?: number } }>('/api/providers/yandex/wave', async (req, reply) => {
    const body = req.body;
    if (!body || (body.session != null && (typeof body.session !== 'string' || !body.session.length || body.session.length > 256)) ||
      (body.queue !== undefined && (!Array.isArray(body.queue) || body.queue.length > 200 || body.queue.some((id) => typeof id !== 'string' || !isYandexTrackId(id)))) ||
      (body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > 4))) {
      return reply.code(400).send({ error: 'Некорректные параметры пополнения волны' });
    }
    try {
      const queue = [...new Set(body.queue ?? [])];
      const wave = await providers.yandex.wave(body.session ?? null, queue, { count: body.count ?? 2, exclude: queue, seeds: getSettings(db).wave.yandexSeeds });
      const ids = wave.items.flatMap((item) => item.trackId ? [item.trackId] : []);
      analysis.prioritize(ids.slice(0, body.count ?? 2), PRIORITY.wave);
      return wave;
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.get('/api/providers/yandex/wave/settings', async (_req, reply) => {
    try { return await providers.yandex.waveSettings(); }
    catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
  });

  app.get('/api/providers/yandex/likes', async (_req, reply) => {
    try {
      return { items: await providers.yandex.likes() };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post<{ Body: { sessionId: string; batchId: string | null; event: { type: 'trackStarted' | 'trackFinished' | 'skip'; trackId: string; totalPlayedSeconds?: number } } }>(
    '/api/providers/yandex/feedback',
    async (req, reply) => {
      try {
        await providers.yandex.feedback(req.body.sessionId, req.body.batchId, req.body.event);
        return { ok: true };
      } catch (e) {
        return reply.code(502).send({ error: (e as Error).message });
      }
    },
  );

  void lib;
}
