import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import { TRANSITION_RATING_REASONS, type PcmSpan, type TransitionPlan, type TransitionRatingReason, type WaveDiversity, type WaveMood } from '@automix/core';
import type { Services } from '../app.ts';
import { PRIORITY } from '../analysis.ts';
import { getSettings } from '../automix.ts';
import { kvGet, kvSet, q } from '../db.ts';

const ALLOWED_RATES = new Set([22050, 32000, 44100, 48000, 88200, 96000]);

export function registerPlaybackRoutes(app: FastifyInstance, s: Services): void {
  const { lib, pcm, analysis, automix, wave, db, providers } = s;

  // Media routes serve the recording that actually plays (a chosen alternative or the track itself).
  const pcmEntry = (trackId: string, sr: number) => {
    const t = lib.media(trackId);
    if (!t) throw Object.assign(new Error('трек не найден'), { statusCode: 404 });
    if (t.status === 'missing') throw Object.assign(new Error(t.error ?? 'файл не найден'), { statusCode: 410 });
    const caps = providers.caps(t.provider);
    if (!caps?.playback) throw Object.assign(new Error('источник не поддерживает воспроизведение'), { statusCode: 409 });
    const key = s.publicMusic.pcmKey(t.id, t.content_hash);
    const entry = pcm.open(key, sr, (signal) => s.publicMusic.playbackInput(t.id, signal), t.duration, caps.caching !== 'persistent');
    return { t, key, entry };
  };

  /** Plans are computed on the playing recordings but addressed to the queue's tracks. */
  const relabel = (plan: TransitionPlan, from: string, to: string): TransitionPlan =>
    plan.fromTrackId === from && plan.toTrackId === to ? plan : { ...plan, fromTrackId: from, toTrackId: to };

  /** Starts decoding the track for playback and pins it in the cache. */
  app.post<{ Params: { id: string }; Body: { sampleRate: number; role?: 'current' | 'next' | 'candidate' } }>('/api/tracks/:id/prepare', async (req, reply) => {
    const sr = Number(req.body?.sampleRate);
    if (!ALLOWED_RATES.has(sr)) return reply.code(400).send({ error: 'неподдерживаемая частота' });
    try {
      const { t, key, entry } = pcmEntry(req.params.id, sr);
      pcm.pin(key, sr, req.body.role === 'candidate' ? 30_000 : 10 * 60_000);
      analysis.prioritize([t.id], req.body.role === 'current' ? PRIORITY.current : req.body.role === 'next' ? PRIORITY.next : PRIORITY.wave);
      const st = analysis.statusOf(t.content_hash);
      if(getSettings(db).automix.enabled&&req.body.role!=='candidate')s.stems.ensure(t,req.body.role==='current'?100:95);
      return { totalFrames: Math.round(entry.estimatedFrames), complete: entry.done, analysis: st.status, stems:s.stems.supports(t)?s.stems.status(t.content_hash):{status:'unavailable'} };
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  });

  /** Float PCM keeps decoder overs until the mixer. Legacy clients may request s16. */
  app.get<{ Params: { id: string }; Querystring: { sr: string; start: string; frames: string; format?: string } }>('/api/tracks/:id/pcm', async (req, reply) => {
    const sr = Number(req.query.sr);
    const start = Math.max(0, Math.floor(Number(req.query.start) || 0));
    const frames = Math.min(1 << 20, Math.max(1, Math.floor(Number(req.query.frames) || 65536)));
    if (!ALLOWED_RATES.has(sr)) return reply.code(400).send({ error: 'неподдерживаемая частота' });
    const format = req.query.format ?? 's16le';
    if (format !== 'f32le' && format !== 's16le') return reply.code(400).send({ error: 'неподдерживаемый формат PCM' });
    try {
      const { entry } = pcmEntry(req.params.id, sr);
      const r = await pcm.read(entry, start, frames);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('X-Total-Frames', String(Math.round(r.totalFrames)));
      reply.header('X-Complete', r.complete ? '1' : '0');
      reply.header('X-PCM-Format', format);
      reply.header('Cache-Control', 'no-store');
      if (format === 'f32le') return reply.send(r.data);
      const legacy = Buffer.alloc(r.data.length / 2);
      for (let i = 0; i < r.data.length / 4; i++) {
        legacy.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r.data.readFloatLE(i * 4) * 32768))), i * 2);
      }
      return reply.send(legacy);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 502).send({ error: err.message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/tracks/:id/analysis', async (req, reply) => {
    const t = lib.media(req.params.id);
    if (!t) return reply.code(404).send({ error: 'трек не найден' });
    const a = analysis.get(t.content_hash);
    return { status: a ? 'done' : analysis.statusOf(t.content_hash).status, analysis: a, error: analysis.statusOf(t.content_hash).error ?? null };
  });

  app.post<{ Params: { id: string } }>('/api/tracks/:id/analyze', async (req, reply) => {
    const t = lib.media(req.params.id);
    if (!t) return reply.code(404).send({ error: 'трек не найден' });
    if (t.status === 'error') lib.setStatus(t.id, 'ok', null);
    analysis.reanalyze(lib.get(t.id)!);
    return { ok: true };
  });

  /** The client tells which tracks matter now; stale queued work is demoted. */
  app.post<{ Body: { current?: string | null; next?: string[]; candidates?: string[] } }>('/api/analysis/focus', async (req) => {
    const b = req.body ?? {};
    const current=typeof b.current==='string'?lib.media(b.current):undefined;
    const nextIds=Array.isArray(b.next)?b.next.filter((id):id is string=>typeof id==='string').slice(0,1):[];
    const candidateIds=Array.isArray(b.candidates)?b.candidates.filter((id):id is string=>typeof id==='string').slice(0,2):[];
    const next=nextIds[0]?lib.media(nextIds[0]):undefined;
    const playbackHashes = new Set<string>();
    for (const t of [current,next]) {
      if (t) playbackHashes.add(s.publicMusic.pcmKey(t.id, t.content_hash));
    }
    pcm.focus(playbackHashes);
    if(getSettings(db).automix.enabled){
      const localInputs=new Map<string,string>();
      const candidates=candidateIds.map(id=>lib.media(id)).filter((t):t is NonNullable<typeof t>=>!!t).filter(t=>{
        const file=lib.sources(t.id).find(src=>(src.kind==='managed'||src.kind==='linked')&&!!src.path&&fs.existsSync(src.path))?.path
          ??s.publicMusic.cachedAudioPath(t.id);
        if(file)localInputs.set(t.content_hash,file);
        return !!file||!!s.stems.get(t.content_hash);
      });
      s.stems.focus(current??undefined,next??undefined,candidates,localInputs);
    }else s.stems.focus();
    const candidateMedia=candidateIds.map(id=>lib.media(id)).filter((t):t is NonNullable<typeof t>=>!!t);
    const keep = new Set([current?.id,next?.id,...candidateMedia.map(t=>t.id)].filter(Boolean) as string[]);
    analysis.demote(keep);
    if (current) analysis.prioritize([current.id], PRIORITY.current);
    analysis.prioritize(next?[next.id]:[], PRIORITY.next);
    analysis.prioritize(candidateMedia.map(t=>t.id), PRIORITY.wave);
    return analysis.stats();
  });

  // ------------------------------------------------------------------ automix

  app.get<{Params:{id:string}}>('/api/tracks/:id/stems',async(req,reply)=>{
    const t=lib.media(req.params.id);
    if(!t)return reply.code(404).send({error:'трек не найден'});
    return {...(s.stems.supports(t)?s.stems.status(t.content_hash):{status:'unavailable'}),model:s.stems.supports(t)?s.stems.get(t.content_hash)?.model??null:null};
  });

  app.post<{Params:{id:string}}>('/api/tracks/:id/stems/rebuild',async(req,reply)=>{
    const t=lib.media(req.params.id);
    if(!t)return reply.code(404).send({error:'трек не найден'});
    try{
      const state=s.stems.rebuild(t);
      return reply.code(state.quality?.status==='ready'?200:202).send({...state,model:s.stems.get(t.content_hash)?.model??null});
    }catch(error){const e=error as Error&{statusCode?:number};return reply.code(e.statusCode??502).send({error:e.message});}
  });

  app.get<{Params:{id:string};Querystring:{sr:string;start:string;frames:string;revision?:string}}>('/api/tracks/:id/vocals/pcm',async(req,reply)=>{
    const t=lib.media(req.params.id);
    if(!t)return reply.code(404).send({error:'трек не найден'});
    if(!s.stems.supports(t))return reply.code(409).send({error:'разделение источника недоступно'});
    const sr=Number(req.query.sr),start=Number(req.query.start),frames=Number(req.query.frames);
    if(!ALLOWED_RATES.has(sr)||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(frames)||frames<1||frames>1<<20)
      return reply.code(400).send({error:'некорректный диапазон вокального PCM'});
    if(req.query.revision!==undefined&&(typeof req.query.revision!=='string'||req.query.revision.length<1||req.query.revision.length>300))
      return reply.code(400).send({error:'некорректная версия вокальной партии'});
    try{
      const revision=s.stems.revision(t.content_hash,req.query.revision);
      const data=await s.stems.read(t.content_hash,sr,start,frames,revision??undefined);
      if(!req.query.revision&&revision!==s.stems.revision(t.content_hash))return reply.code(409).send({error:'Вокальная партия обновилась; повторите загрузку'});
      return reply.header('Content-Type','application/octet-stream').header('X-PCM-Format','f32le').header('X-Automix-Vocal-Revision',revision!).header('Cache-Control','no-store').send(data);
    }catch(e){const error=e as Error&{statusCode?:number};return reply.code(error.statusCode??502).send({error:error.message});}
  });

  /** PCM for the full-mix render check (P10): only a recording the player is already decoding, never a
   * new decode; a span the decoder has not reached within 1.5 s is skipped rather than awaited. */
  const readSpan = async (trackId: string, from: number, to: number): Promise<PcmSpan | null> => {
    const t = lib.media(trackId);
    if (!t) return null;
    const key = s.publicMusic.pcmKey(t.id, t.content_hash);
    const sr = [48000, 44100, 96000, 88200, 32000, 22050].find(rate => { const st = pcm.status(key, rate); return st && !st.error; });
    if (!sr) return null;
    const { entry } = pcmEntry(trackId, sr);
    const start = Math.floor(from * sr), frames = Math.ceil((to - from) * sr);
    const r = await pcm.read(entry, start, frames, 1500);
    const n = Math.floor(r.data.length / 8);
    // a span may run past the end of the recording: the render then ends where the file does
    if (n < Math.min(frames, r.totalFrames - start) * 0.98) return null;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = r.data.readFloatLE(i * 8); R[i] = r.data.readFloatLE(i * 8 + 4); }
    return { pcm: { L, R, sampleRate: sr }, start: start / sr };
  };

  app.get<{ Querystring: { from: string; to: string } }>('/api/automix/plan', async (req, reply) => {
    try {
      const r = await automix.planChecked(lib.mediaId(req.query.from), lib.mediaId(req.query.to), readSpan);
      return { ...r, plan: relabel(r.plan, req.query.from, req.query.to) };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.post<{ Body: { from: string; to: string; position: number } }>('/api/automix/skip', async (req, reply) => {
    try {
      return { plan: relabel(automix.skip(lib.mediaId(req.body.from), lib.mediaId(req.body.to), Number(req.body.position) || 0), req.body.from, req.body.to) };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.post<{ Body: { from: string; to: string; position: number } }>('/api/automix/mix-now', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body.from !== 'string' || !body.from.trim() || typeof body.to !== 'string' || !body.to.trim()
      || typeof body.position !== 'number' || !Number.isFinite(body.position) || body.position < 0) {
      return reply.code(400).send({ error: 'нужны ID двух треков и корректная позиция воспроизведения' });
    }
    try {
      return { plan: relabel(automix.requested(lib.mediaId(body.from), lib.mediaId(body.to), body.position), body.from, body.to) };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.post<{ Body: { plan: TransitionPlan; outcome: Record<string, unknown> } }>('/api/automix/log', async (req, reply) => {
    if (!req.body?.plan?.id) return reply.code(400).send({ error: 'нет плана' });
    // Voice readiness at execution time: the evidence for "no masks" dislikes.
    const plan = req.body.plan, ready = (trackId?: string) => {
      const t = trackId ? lib.media(trackId) : undefined;
      return t ? s.stems.readiness(t.content_hash) : null;
    };
    const stems = { A: ready(plan.fromTrackId), B: ready(plan.toTrackId), masks: { A: !!plan.vocalA, B: !!plan.vocalB } };
    const id = automix.log({ ...req.body, outcome: { ...req.body.outcome, stems } });
    const show = (x: typeof stems.A) => !x ? 'none' : x.status === 'ready' ? `ready${x.readyAgoS === undefined ? '' : ` ${x.readyAgoS}s before`}` : `${x.status}${x.waitedS === undefined ? '' : ` waited ${x.waitedS}s`}${x.error ? ` (${x.error})` : ''}`;
    console.log(`[automix] transition #${id} ${plan.method} voice A=${show(stems.A)} B=${show(stems.B)} masks A=${stems.masks.A} B=${stems.masks.B}`);
    return { ok: true, id };
  });

  app.post<{ Params: { id: string }; Body: { rating?: unknown; reason?: unknown } }>('/api/automix/log/:id/rating', async (req, reply) => {
    const id = Number(req.params.id);
    const { rating = null, reason = null } = req.body ?? {};
    if (!Number.isSafeInteger(id) || id <= 0) return reply.code(400).send({ error: 'некорректный id' });
    if (rating !== null && rating !== 'good' && rating !== 'bad') return reply.code(400).send({ error: 'оценка: good, bad или null' });
    if (reason !== null && (rating !== 'bad' || !(TRANSITION_RATING_REASONS as readonly unknown[]).includes(reason)))
      return reply.code(400).send({ error: 'причина допустима только для плохой оценки и из списка' });
    if (!automix.rate(id, rating, reason as TransitionRatingReason | null)) return reply.code(404).send({ error: 'переход не найден' });
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/automix/log', async (req) => ({ items: automix.recent(Math.min(100, Number(req.query.limit) || 30)) }));

  // --------------------------------------------------------------------- wave

  app.post<{ Body: { currentId?: string | null; session?: string[]; mood?: WaveMood; diversity?: WaveDiversity; mode?: 'normal' | 'mix'; count?: number; exclude?: string[] } }>('/api/wave/next', async (req) => {
    const st = getSettings(db).wave;
    const b = req.body ?? {};
    const picks = wave.next({
      currentId: b.currentId ?? null,
      session: b.session ?? [],
      mood: b.mood ?? st.mood,
      diversity: b.diversity ?? st.diversity,
      mix: (b.mode ?? st.mode) === 'mix',
      count: b.count ?? 3,
      exclude: b.exclude,
    });
    return { picks };
  });

  // -------------------------------------------------------------------- plays

  app.post<{ Body: { trackId: string; context?: string } }>('/api/plays', async (req, reply) => {
    const t = lib.get(req.body?.trackId);
    if (!t) return reply.code(404).send({ error: 'трек не найден' });
    const r = q(db, 'INSERT INTO plays(track_id, context, started_at, duration_ms) VALUES (?, ?, ?, ?)').run(
      t.id,
      String(req.body.context ?? '').slice(0, 60),
      Date.now(),
      Math.round(t.duration * 1000),
    );
    return { id: Number(r.lastInsertRowid) };
  });

  app.patch<{ Params: { id: string }; Body: { playedMs: number; endReason?: string; transitionId?: string } }>('/api/plays/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = q(db, 'SELECT * FROM plays WHERE id = ?').get(id) as { track_id: string; ended_at: number | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'нет такой записи' });
    const playedMs = Math.max(0, Math.round(Number(req.body?.playedMs) || 0));
    const reason = ['finished', 'skip', 'transition', 'stop', 'error'].includes(String(req.body?.endReason)) ? String(req.body.endReason) : null;
    q(db, 'UPDATE plays SET played_ms = ?, end_reason = COALESCE(?, end_reason), ended_at = ?, transition_id = COALESCE(?, transition_id) WHERE id = ?').run(
      playedMs,
      reason,
      Date.now(),
      req.body?.transitionId ?? null,
      id,
    );
    if (reason && !row.ended_at) {
      if (reason === 'skip') q(db, 'UPDATE tracks SET skip_count = skip_count + 1, last_played_at = ? WHERE id = ?').run(Date.now(), row.track_id);
      else if (playedMs > 30000 || reason === 'finished' || reason === 'transition') q(db, 'UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?').run(Date.now(), row.track_id);
    }
    return { ok: true };
  });

  app.get<{ Querystring: { limit?: string } }>('/api/history', async (req) => {
    const rows = q(db, 'SELECT id, track_id, context, started_at, played_ms, end_reason FROM plays ORDER BY id DESC LIMIT ?').all(Math.min(500, Number(req.query.limit) || 100)) as {
      id: number;
      track_id: string;
      context: string;
      started_at: number;
      played_ms: number;
      end_reason: string | null;
    }[];
    return { items: rows.map((r) => ({ id: r.id, trackId: r.track_id, context: r.context, startedAt: r.started_at, playedMs: r.played_ms, endReason: r.end_reason })) };
  });

  app.delete('/api/history', async () => {
    q(db, 'DELETE FROM plays').run();
    return { ok: true };
  });

  // -------------------------------------------------------------------- queue

  app.get('/api/queue', async () => kvGet(db, 'queue', null));
  app.put<{ Body: unknown }>('/api/queue', async (req, reply) => {
    const body = req.body as { items?: unknown[] } | null;
    if (!body || !Array.isArray(body.items) || body.items.length > 5000) return reply.code(400).send({ error: 'некорректная очередь' });
    kvSet(db, 'queue', body);
    return { ok: true };
  });
}
