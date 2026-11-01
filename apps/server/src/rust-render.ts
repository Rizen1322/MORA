import { planToArmed, type OfflineRender, type StereoPcm } from '@automix/core/engine/arm.ts';
import { DEFAULT_PLAYBACK, sanitizePlayback, type PlaybackSettings } from '@automix/core/dsp/playback.ts';
import type { PcmSpan, TransitionPlan } from '@automix/core';
import type { RenderMetrics } from '@automix/core/engine/render-check.ts';
import { rustComputeAsync } from './rust-core.ts';

function channel(pcm: Float32Array) { return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'); }
function source(pcm: StereoPcm) {
  return { L: channel(pcm.L), R: channel(pcm.R), ...(pcm.vocals ? { vocals: { L: channel(pcm.vocals.L), R: channel(pcm.vocals.R) } } : {}) };
}
function request(a: StereoPcm, b: StereoPcm, plan: TransitionPlan, preSeconds: number, postSeconds: number, playback: PlaybackSettings) {
  if (a.sampleRate !== b.sampleRate) throw new Error('sample rates must match');
  for (const [pcm, mask] of [[a, plan.vocalA], [b, plan.vocalB]] as const) {
    if (mask?.some(([, gain]) => gain !== 1) && !pcm.vocals) throw new Error('vocal envelopes require time-aligned vocal PCM for offline rendering');
    if (pcm.vocals && (pcm.vocals.L.length !== pcm.L.length || pcm.vocals.R.length !== pcm.R.length)) throw new Error('vocal PCM must match the original frame count');
  }
  const settings = sanitizePlayback(playback), sr = a.sampleRate, startAt = Math.max(0, plan.aExit - preSeconds);
  const frames = Math.round((plan.aExit - startAt + plan.duration + plan.gap + postSeconds) * sr / settings.speed);
  return {
    a: source(a), b: source(b), sampleRate: sr, startFrame: Math.round(startAt * sr), frames, speed: settings.speed,
    gainA: plan.gainA, gainB: plan.gainB, armed: planToArmed(plan, sr, 'A', 'B'), playback: settings,
  };
}
export async function renderRust(a: StereoPcm, b: StereoPcm, plan: TransitionPlan, preSeconds = 8, postSeconds = 10, playback: PlaybackSettings = DEFAULT_PLAYBACK): Promise<OfflineRender> {
  const input = request(a, b, plan, preSeconds, postSeconds, playback);
  const rendered = await rustComputeAsync<Omit<OfflineRender, 'L' | 'R'> & { L: string; R: string }>('render', input);
  const decode = (raw: string) => {
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length !== input.frames * 4) throw new Error('Некорректная длина Rust-рендера');
    const values = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (!values.every(Number.isFinite)) throw new Error('Некорректный PCM Rust-рендера');
    return values;
  };
  return { ...rendered, L: decode(rendered.L), R: decode(rendered.R) };
}

export async function measureRust(plan: TransitionPlan, a: PcmSpan, b: PcmSpan): Promise<RenderMetrics | null> {
  if (plan.loopA || plan.tapeStopA || plan.vocalA || plan.vocalB || plan.aExit - 6 < a.start || plan.bEntry < b.start) return null;
  const shifted = { ...plan, aExit: plan.aExit - a.start, bEntry: plan.bEntry - b.start };
  return rustComputeAsync<RenderMetrics | null>('render', { ...request(a.pcm, b.pcm, shifted, 6, 6, DEFAULT_PLAYBACK), measure: true, plan: shifted });
}
