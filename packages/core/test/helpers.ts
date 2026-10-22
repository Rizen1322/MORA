import { Biquad, highpass } from '../src/dsp/biquad.ts';
import { analyzePcm } from '../src/mir/analyzePcm.ts';
import { synthesize, type SynthResult, type SynthSpec } from '../src/synth/synth.ts';
import type { PlannerTrack, TrackAnalysis } from '../src/types.ts';

const cache = new Map<string, { pcm: SynthResult; analysis: TrackAnalysis }>();

/** Synthesizes and analyzes a track once per spec (memoized across tests in a file). */
export function fixture(spec: SynthSpec): { pcm: SynthResult; analysis: TrackAnalysis } {
  const key = JSON.stringify(spec);
  let v = cache.get(key);
  if (!v) {
    const pcm = synthesize(spec);
    v = { pcm, analysis: analyzePcm(pcm.L, pcm.R) };
    cache.set(key, v);
  }
  return v;
}

export function plannerTrack(id: string, f: { pcm: SynthResult; analysis: TrackAnalysis } | null, extra: Partial<PlannerTrack> = {}): PlannerTrack {
  return {
    id,
    duration: f ? f.pcm.L.length / f.pcm.sampleRate : 180,
    mixingAllowed: true,
    analysis: f ? f.analysis : null,
    ...extra,
  };
}

export function rms(x: Float32Array, a = 0, b = x.length): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

export function peakAbs(...xs: Float32Array[]): number {
  let p = 0;
  for (const x of xs) for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

/**
 * Click detector for band-limited test material: a discontinuity (step,
 * impulse, slope break) spreads energy far above the content, so we look for
 * isolated spikes in a 14 kHz high-passed copy. Synthetic "clean" tracks keep
 * all their energy below ~8 kHz, so false positives stay at zero.
 */
export function countClicks(x: Float32Array, minLevelArg?: number): number {
  const fs = 44100;
  // scale with programme level: louder material carries proportionally more HF residue
  const minLevel = minLevelArg ?? Math.max(0.004, 0.03 * rms(x));
  const c1 = highpass(fs, 14000, 0.54);
  const c2 = highpass(fs, 14000, 1.31);
  const y = Float32Array.from(x);
  new Biquad(c1).processBuffer(y);
  new Biquad(c2).processBuffer(y);
  const win = 882;
  let sum = 0;
  for (let i = 0; i < Math.min(y.length, win); i++) sum += y[i] * y[i];
  let clicks = 0;
  const warmup = 256; // the high-pass filter starts from rest: ignore its own onset transient
  for (let i = 0; i < y.length; i++) {
    const lo = i - win / 2;
    const hi = i + win / 2;
    if (hi < y.length && lo >= 0) sum += y[hi] * y[hi] - y[lo] * y[lo];
    if (i < warmup) continue;
    const local = Math.sqrt(Math.max(0, sum) / win);
    const v = Math.abs(y[i]);
    if (v > minLevel && v > local * 6) {
      clicks++;
      i += 256;
    }
  }
  return clicks;
}

/** Times (s) of kick-like low band attacks in a rendered signal. */
export function lowAttacks(x: Float32Array, sr: number): number[] {
  const hop = Math.round(sr / 1000);
  const a = Math.exp(-1 / (sr * 0.004));
  let lp1 = 0;
  let lp2 = 0;
  const c = Math.exp((-2 * Math.PI * 150) / sr);
  let e = 0;
  const env: number[] = [];
  let prev = -10;
  for (let i = 0; i < x.length; i += hop) {
    let mx = 0;
    for (let j = i; j < Math.min(x.length, i + hop); j++) {
      lp1 = c * lp1 + (1 - c) * x[j];
      lp2 = c * lp2 + (1 - c) * lp1;
      e = a * e + (1 - a) * lp2 * lp2;
      if (e > mx) mx = e;
    }
    const lg = Math.log10(mx + 1e-10);
    env.push(Math.max(0, lg - prev));
    prev = lg;
  }
  const out: number[] = [];
  // the first hop jumps from silence; keep it out of the threshold
  const thr = Math.max(...env.slice(100)) * 0.25;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] > thr && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
      out.push((i * hop) / sr);
      i += 80;
    }
  }
  return out;
}

/** Low-band attack envelope at 1 kHz (positive log-energy slope). */
function lowEnvelope(x: Float32Array, sr: number): Float32Array {
  const hop = Math.round(sr / 1000);
  const a = Math.exp(-1 / (sr * 0.004));
  const c = Math.exp((-2 * Math.PI * 150) / sr);
  let lp1 = 0;
  let lp2 = 0;
  let e = 0;
  let prev = -10;
  const out = new Float32Array(Math.floor(x.length / hop));
  for (let k = 0; k < out.length; k++) {
    let mx = 0;
    for (let j = k * hop; j < (k + 1) * hop; j++) {
      lp1 = c * lp1 + (1 - c) * x[j];
      lp2 = c * lp2 + (1 - c) * lp1;
      e = a * e + (1 - a) * lp2 * lp2;
      if (e > mx) mx = e;
    }
    const lg = Math.log10(mx + 1e-10);
    out[k] = Math.max(0, lg - prev);
    prev = lg;
  }
  return out;
}

/**
 * Lag (ms) that best aligns the low-band attacks of b to a within [from, to] seconds.
 * 0 means kicks coincide.
 */
export function attackLagMs(a: Float32Array, b: Float32Array, sr: number, from: number, to: number, maxLagMs = 200): number {
  const ea = lowEnvelope(a, sr);
  const eb = lowEnvelope(b, sr);
  const i0 = Math.round(from * 1000);
  const i1 = Math.min(ea.length, eb.length, Math.round(to * 1000));
  let best = 0;
  let bestS = -Infinity;
  for (let lag = -maxLagMs; lag <= maxLagMs; lag++) {
    let s = 0;
    for (let i = i0; i < i1; i++) s += ea[i] * (eb[i + lag] ?? 0);
    if (s > bestS) {
      bestS = s;
      best = lag;
    }
  }
  return best;
}
