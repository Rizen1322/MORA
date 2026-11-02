import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../app.ts';
import { PRIORITY } from '../analysis.ts';
import type { DownloadJob } from '../public/downloads.ts';
import { kvGet, kvSet } from '../db.ts';

/** Playlist preparation shares download jobs and the analysis pool; it never decodes a whole playlist to PCM. */
export function registerListeningPreparationRoutes(app: FastifyInstance, s: Services): void {
  type Batch = { trackIds: string[]; order: string[]; ownedJobs: Set<string>; cancelled: boolean; plans: Set<string>; planErrors: Set<string> };
  const batches = new Map<string, Batch>();
  const saved = kvGet<{ id: string; trackIds: string[]; order?: string[]; ownedJobs: string[]; cancelled: boolean } | null>(s.db, 'listening.preparation', null);
  if (saved) batches.set(saved.id, { ...saved, order: saved.order ?? saved.trackIds, ownedJobs: new Set(saved.ownedJobs), plans: new Set(), planErrors: new Set() });
  let planning = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const save = (id: string, b: Batch) => kvSet(s.db, 'listening.preparation', { id, trackIds: b.trackIds, order: b.order, ownedJobs: [...b.ownedJobs], cancelled: b.cancelled });
  const jobsByTrack = () => new Map(s.downloads.list().filter(j => j.state !== 'cancelled').reverse().map(j => [j.trackId, j]));
  const inspect = (id: string, jobs = jobsByTrack()) => {
    const t = s.lib.media(id);
    if (!t || t.status !== 'ok' || !s.providers.caps(t.provider)?.playback) return { trackId: id, state: 'unavailable' as const, message: t?.error ?? 'Источник недоступен' };
    const job: DownloadJob | undefined = jobs.get(id);
    const local = !!s.publicMusic.cachedAudioPath(t.id) || s.lib.sources(t.id).some(src => !!src.path && fs.existsSync(src.path))
      || (t.provider === 'yandex' && /^[a-f\d]{64}$/.test(t.content_hash) && fs.existsSync(path.join(s.cfg.dataDir, 'remote', 'yandex', `${t.content_hash}.mp3`)));
    if (!local && job?.state === 'failed') return { trackId: id, state: 'unavailable' as const, message: job.error ?? 'Не удалось скачать', jobId: job.id };
    const a = s.analysis.statusOf(t.content_hash);
    const message = local ? a.status === 'done' ? 'Готов к AutoMix' : a.status === 'error' ? 'Звук готов · AutoMix недоступен' : 'Звук готов · анализ перед переходом' : job?.state === 'downloading' ? 'Загружается' : job?.state === 'waiting' ? 'Ожидает подключения' : job?.state === 'queued' ? 'В очереди загрузки' : job?.state === 'paused' ? 'Загрузка приостановлена' : 'Нужно загрузить';
    return { trackId: id, state: local ? 'ready' as const : 'loading' as const, analysis: a.status, message, jobId: job?.id };
  };
  const status = (b: Batch) => {
    const jobs = jobsByTrack();
    const tracks = b.trackIds.map(id => inspect(id, jobs));
    const ready = tracks.filter(t => t.state === 'ready' && (t.analysis === 'done' || !s.lib.mixingPolicy.get(s.lib.media(t.trackId)!.provider))).length;
    const unavailable = tracks.filter(t => t.state === 'unavailable' || t.analysis === 'error').length;
    const pairs = [...new Set(b.order.slice(1).map((id, i) => JSON.stringify([b.order[i], id])))];
    return { total: tracks.length, ready, unavailable, cancelled: b.cancelled,
      plansReady: b.plans.size, plansTotal: pairs.length, plansFailed: b.planErrors.size,
      complete: ready + unavailable === tracks.length && b.plans.size + b.planErrors.size === pairs.length, tracks };
  };
  // A single bounded analysis window across batches, below current/next playback priority.
  const advance = () => {
    const active = [...batches.values()].filter(b => !b.cancelled && !status(b).complete);
    if (!active.length) { clearInterval(timer); timer = undefined; return; }
    const jobs = jobsByTrack();
    const candidates = [...new Set([...batches.values()].filter(b => !b.cancelled).flatMap(b => b.trackIds))].map(id => inspect(id, jobs))
      .filter(t => t.state === 'ready' && t.analysis !== 'done' && t.analysis !== 'error');
    for (const t of candidates.slice(0, 2)) { const media = s.lib.media(t.trackId); if (media) s.analysis.ensure(media, PRIORITY.wave); }
    if (planning) return;
    for (const b of active) for (let i = 1; i < b.order.length; i++) {
      const from = b.order[i - 1], to = b.order[i], pair = JSON.stringify([from, to]);
      if (b.plans.has(pair) || b.planErrors.has(pair)) continue;
      const states = [inspect(from, jobs), inspect(to, jobs)];
      if (states.some(t => t.state === 'unavailable' || t.analysis === 'error')) { b.planErrors.add(pair); continue; }
      if (!states.every(t => t.state === 'ready' && (t.analysis === 'done' || !s.lib.mixingPolicy.get(s.lib.media(t.trackId)!.provider)))) continue;
      planning = true;
      void s.automix.preplan(s.lib.mediaId(from), s.lib.mediaId(to)).then(() => b.plans.add(pair), () => b.planErrors.add(pair))
        .finally(() => { planning = false; });
      return;
    }
  };
  const start = () => { if (!timer) { timer = setInterval(advance, 1000); timer.unref(); } advance(); };
  if (batches.size) start();
  app.addHook('onClose', async () => clearInterval(timer));
  app.post<{ Body: { trackIds?: string[] } }>('/api/listening/readiness', async (req, reply) => {
    const ids = req.body?.trackIds;
    if (!Array.isArray(ids) || ids.length > 40 || ids.some(id => typeof id !== 'string' || id.length > 200)) return reply.code(400).send({ error: 'Нужно не более 40 треков' });
    const jobs = jobsByTrack();
    return { tracks: [...new Set(ids)].map(id => inspect(id, jobs)) };
  });
  app.post<{ Params: { id: string } }>('/api/playlists/:id/prepare-listening', async (req, reply) => {
    const rows = s.db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(req.params.id) as { track_id: string }[];
    if (!rows.length) return reply.code(404).send({ error: 'Плейлист пуст или не найден' });
    if ([...batches.entries()].some(([id, b]) => id !== req.params.id && !b.cancelled && !status(b).complete)) return reply.code(409).send({ error: 'Сначала завершите или отмените подготовку другого плейлиста' });
    const previous = batches.get(req.params.id);
    if (previous && !previous.cancelled && !status(previous).complete) return status(previous);
    const b: Batch = { trackIds: [...new Set(rows.map(r => r.track_id))], order: rows.map(r => r.track_id), ownedJobs: new Set(), cancelled: false, plans: new Set(), planErrors: new Set() };
    const existing = new Set(s.downloads.list().map(j => j.id));
    for (const trackId of b.trackIds) {
      const t = s.lib.media(trackId);
      if (!t || t.status !== 'ok' || !s.providers.caps(t.provider)?.playback) continue;
      const job = s.downloads.add({ trackId });
      if (!existing.has(job.id)) b.ownedJobs.add(job.id);
    }
    batches.clear();
    batches.set(req.params.id, b);
    save(req.params.id, b);
    start();
    return status(b);
  });
  app.get<{ Params: { id: string } }>('/api/playlists/:id/prepare-listening', async (req) => {
    const b = batches.get(req.params.id);
    return b ? status(b) : null;
  });
  app.delete<{ Params: { id: string } }>('/api/playlists/:id/prepare-listening', async (req) => {
    const b = batches.get(req.params.id);
    if (b) { b.cancelled = true; for (const id of b.ownedJobs) s.downloads.cancel(id); save(req.params.id, b); }
    return b ? status(b) : null;
  });
}
