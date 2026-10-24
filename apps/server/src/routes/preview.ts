import type { FastifyInstance } from 'fastify';
import { fallbackWithoutVocalStems, finalistSpans, stepAsync, type PcmSpan, type TransitionPlan } from '@automix/core';
import { renderTransitionSteps, type StereoPcm } from '@automix/core/engine/arm.ts';
import type { Services } from '../app.ts';

/** Seconds of the outgoing track before the blend and of the incoming one after it. */
const PRE = 4, POST = 5;

/** 16-bit stereo WAV: every browser and WKWebView plays it from a blob without a decoder of ours. */
function wav(L: Float32Array, R: Float32Array, sampleRate: number): Buffer {
  const n = L.length, out = Buffer.alloc(44 + n * 4);
  out.write('RIFF', 0); out.writeUInt32LE(36 + n * 4, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(n * 4, 40);
  const pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) {
    pcm[2 * i] = Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767)));
    pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767)));
  }
  Buffer.from(pcm.buffer).copy(out, 44);
  return out;
}

/**
 * "Как прозвучит переход": the planned blend from the current track into a queued one, rendered by
 * the same mixer core the player runs, as a short WAV. Voice masks need separated vocals; without
 * them the preview uses the plan's own fallback (as the player does when stems are missing).
 */
export function registerPreviewRoutes(app: FastifyInstance, s: Services): void {
  const { lib, pcm, automix } = s;

  const span = async (trackId: string, from: number, to: number, sr: number): Promise<PcmSpan | null> => {
    const t = lib.media(trackId);
    if (!t || t.status === 'missing') return null;
    const key = s.publicMusic.pcmKey(t.id, t.content_hash);
    const entry = pcm.open(key, sr, (signal) => s.publicMusic.playbackInput(t.id, signal), t.duration, s.providers.caps(t.provider)?.caching !== 'persistent');
    const start = Math.max(0, Math.floor(from * sr)), frames = Math.ceil((to - Math.max(0, from)) * sr);
    const r = await pcm.read(entry, start, frames, 30_000);
    const n = Math.floor(r.data.length / 8);
    if (!n) return null;
    const f = new Float32Array(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + n * 8));
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
    return { pcm: { L, R, sampleRate: sr }, start: start / sr };
  };

  app.get<{ Querystring: { from: string; to: string; sr?: string } }>('/api/automix/preview', async (req, reply) => {
    const { from, to } = req.query;
    if (typeof from !== 'string' || typeof to !== 'string' || !from || !to) return reply.code(400).send({ error: 'нужны ID двух треков' });
    const sr = Number(req.query.sr) === 44100 ? 44100 : 48000;
    try {
      const planned = await automix.planChecked(lib.mediaId(from), lib.mediaId(to), async () => null);
      let plan: TransitionPlan = planned.plan;
      if (plan.vocalA || plan.vocalB) plan = fallbackWithoutVocalStems(plan);
      const spans = finalistSpans([plan]);
      const [a, b] = await Promise.all([span(from, spans.a[0] - PRE, spans.a[1], sr), span(to, spans.b[0], spans.b[1] + POST, sr)]);
      if (!a || !b) return reply.code(409).send({ error: 'звук треков ещё не готов' });
      const shifted = { ...plan, aExit: plan.aExit - a.start, bEntry: plan.bEntry - b.start };
      const r = await stepAsync(renderTransitionSteps(a.pcm as StereoPcm, b.pcm as StereoPcm, shifted, PRE, POST));
      return reply.header('Content-Type', 'audio/wav').header('Cache-Control', 'no-store')
        .header('X-Transition-Start', String(Math.max(0, r.transitionStartFrame) / sr)).header('X-Transition-Method', plan.method)
        .send(wav(r.L, r.R, sr));
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 502).send({ error: err.message });
    }
  });
}
