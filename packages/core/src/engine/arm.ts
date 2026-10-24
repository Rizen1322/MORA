import type { TransitionPlan } from '../types.ts';
import { CHUNK_FRAMES } from './chunks.ts';
import { LANE_INDEX, MixerCore, type ArmedTransition, type MixerEvent } from './mixer.ts';
import { DEFAULT_PLAYBACK, sanitizePlayback, type PlaybackSettings } from '../dsp/playback.ts';
import { drain } from '../plan/timing.ts';

/** Converts a planner TransitionPlan (seconds) to engine frames for a sample rate. */
export function planToArmed(plan: TransitionPlan, sampleRate: number, fromToken: string, toToken: string): ArmedTransition {
  const f = (s: number) => Math.round(s * sampleRate);
  return {
    planId: plan.id,
    method: plan.method,
    fromToken,
    toToken,
    triggerFrame: f(plan.aExit),
    entryFrame: f(plan.bEntry),
    durationFrames: Math.max(1, f(plan.duration)),
    gapFrames: f(plan.gap),
    swapFrame: f(plan.swapAt),
    bDelayFrames: plan.bDelay ? f(plan.bDelay) : undefined,
    tempoB: plan.tempoB.map(([t, r]) => [f(t), r] as [number, number]),
    tempoA: plan.tempoA?.map(([t, r]) => [f(t), r] as [number, number]),
    loopA: plan.loopA ? { start: f(plan.loopA.start), end: f(plan.loopA.end), until: f(plan.loopA.until), fade: Math.max(1, f(plan.loopA.crossfade)),
      roll: plan.loopA.roll?.map(x => ({ at: f(x.at), length: f(x.length) })) } : undefined,
    vocalA: plan.vocalA?.map(([t, gain]) => [f(t), gain] as [number, number]),
    tapeStopA: plan.tapeStopA ? {start:f(plan.tapeStopA.start),end:f(plan.tapeStopA.end),fade:Math.max(1,f(plan.tapeStopA.crossfade))}:undefined,
    vocalB: plan.vocalB?.map(([t, gain]) => [f(t), gain] as [number, number]),
    echoDelayFrames: plan.echo ? f(plan.echo.delay) : undefined,
    echoFeedback: plan.echo?.feedback,
    voiceEchoDelayFrames: plan.voiceEcho ? f(plan.voiceEcho.delay) : undefined,
    voiceEchoFeedback: plan.voiceEcho?.feedback,
    voiceEchoClearFrame: Number.isFinite(plan.voiceEcho?.clearAt) && plan.voiceEcho!.clearAt! >= 0 && plan.voiceEcho!.clearAt! <= plan.duration ? f(plan.voiceEcho!.clearAt!) : undefined,
    lanes: plan.automation.map((l) => ({
      deck: l.deck,
      lane: LANE_INDEX[l.lane],
      points: l.points.map(([t, v]) => [f(t), v] as [number, number]),
    })),
  };
}

export interface StereoPcm {
  L: Float32Array;
  R: Float32Array;
  sampleRate: number;
  /** Time-aligned separated voice, at the original sample rate and length. */
  vocals?: { L: Float32Array; R: Float32Array };
}

function feedAll(m: MixerCore, deck: number, token: string, pcm: StereoPcm): void {
  const n = Math.ceil(pcm.L.length / CHUNK_FRAMES);
  for (let c = 0; c < n; c++) {
    const a = c * CHUNK_FRAMES;
    const b = Math.min(pcm.L.length, a + CHUNK_FRAMES);
    m.feed(deck, token, c, pcm.L.slice(a, b), pcm.R.slice(a, b));
    if (pcm.vocals) m.feedVocal(deck, token, c, pcm.vocals.L.slice(a, b), pcm.vocals.R.slice(a, b));
  }
}

export interface OfflineRender {
  L: Float32Array;
  R: Float32Array;
  sampleRate: number;
  /** Output frame where the transition started. */
  transitionStartFrame: number;
  events: MixerEvent[];
  /** Actual rendered sample peak and positive peak attenuation by the limiter. */
  metrics: { peak: number; maxLimiterReductionDb: number; underruns: number };
}

/**
 * Renders a transition region offline through the exact same MixerCore the
 * AudioWorklet uses: `preSeconds` of A before the exit point, the overlap and
 * `postSeconds` of B afterwards.
 */
export function renderTransitionOffline(a: StereoPcm, b: StereoPcm, plan: TransitionPlan, preSeconds = 8, postSeconds = 10, playback: PlaybackSettings = DEFAULT_PLAYBACK): OfflineRender {
  return drain(renderTransitionSteps(a, b, plan, preSeconds, postSeconds, playback));
}

/** renderTransitionOffline in steps: it yields after every 32768 output frames, so an
 * in-process caller (the iPhone app's server) can serve other requests in between. */
export function* renderTransitionSteps(a: StereoPcm, b: StereoPcm, plan: TransitionPlan, preSeconds = 8, postSeconds = 10, playback: PlaybackSettings = DEFAULT_PLAYBACK): Generator<void, OfflineRender> {
  const sr = a.sampleRate;
  if (b.sampleRate !== sr) throw new Error('sample rates must match');
  if ((plan.vocalA?.some(([, gain]) => gain !== 1) && !a.vocals) || (plan.vocalB?.some(([, gain]) => gain !== 1) && !b.vocals)) {
    throw new Error('vocal envelopes require time-aligned vocal PCM for offline rendering');
  }
  for (const pcm of [a, b]) if (pcm.vocals && (pcm.vocals.L.length !== pcm.L.length || pcm.vocals.R.length !== pcm.R.length)) {
    throw new Error('vocal PCM must match the original frame count');
  }
  const events: MixerEvent[] = [];
  const pending: Extract<MixerEvent, { type: 'need' }>[] = [];
  const metrics = { peak: 0, maxLimiterReductionDb: 0, underruns: 0 };
  const m = new MixerCore(sr, (e) => {
    if (e.type === 'need') pending.push(e);
    else if (e.type === 'tick') metrics.maxLimiterReductionDb = Math.max(metrics.maxLimiterReductionDb, -e.limiterDb);
    else {
      if (e.type === 'underrun') metrics.underruns++;
      events.push(e);
    }
  });
  const playbackSettings = sanitizePlayback(playback);
  m.setPlayback(playbackSettings);
  m.load(0, 'A', a.L.length, plan.gainA);
  feedAll(m, 0, 'A', a);
  m.load(1, 'B', b.L.length, plan.gainB, Math.round(plan.bEntry * sr));
  feedAll(m, 1, 'B', b);
  const startAt = Math.max(0, plan.aExit - preSeconds);
  m.start(0, 'A', Math.round(startAt * sr));
  m.arm(planToArmed(plan, sr, 'A', 'B'));
  const total = Math.round((plan.aExit - startAt + plan.duration + plan.gap + postSeconds) * sr / playbackSettings.speed);
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const block = 512;
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  let startFrame = -1;
  for (let off = 0; off < total; off += block) {
    if (off && off % 32768 === 0) yield;
    // Model the controller's refill path too. The live core evicts distant
    // chunks, so feeding a whole track once cannot sustain a long render.
    for (const e of pending.splice(0)) {
      const pcm = e.token === 'A' ? a : b;
      for (const c of e.chunks) {
        const from = c * CHUNK_FRAMES;
        if (e.part === 'vocals' && pcm.vocals) m.feedVocal(e.deck, e.token, c, pcm.vocals.L.slice(from, from + CHUNK_FRAMES), pcm.vocals.R.slice(from, from + CHUNK_FRAMES));
        else if (e.part !== 'vocals') m.feed(e.deck, e.token, c, pcm.L.slice(from, from + CHUNK_FRAMES), pcm.R.slice(from, from + CHUNK_FRAMES));
      }
    }
    const n = Math.min(block, total - off);
    const before = events.length;
    m.process(bl, br, n);
    metrics.maxLimiterReductionDb = Math.max(metrics.maxLimiterReductionDb, -m.getMetering().limiterDb);
    for (let i = 0; i < n; i++) metrics.peak = Math.max(metrics.peak, Math.abs(bl[i]), Math.abs(br[i]));
    for (let i = before; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'transitionStart' && startFrame < 0) startFrame = Math.round(e.clock / playbackSettings.speed);
    }
    L.set(bl.subarray(0, n), off);
    R.set(br.subarray(0, n), off);
  }
  return { L, R, sampleRate: sr, transitionStartFrame: startFrame, events, metrics };
}
