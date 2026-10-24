import type { BeatGrid, BeatRegion } from '../types.ts';
import { estimateTempo, fitOnsetGrid, median, refineGridHiRes, type OnsetEnvelope } from './tempo.ts';

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const MIN_SECONDS = 12;
const WINDOW_SECONDS = 24;

interface Pulse {
  start: number;
  end: number;
  origin: number;
  period: number;
  confidence: number;
  jitterMs: number;
  support: number;
  contrast: number;
}

function peakAt(o: OnsetEnvelope, a: Float32Array, time: number, radius = 1): { value: number; time: number } {
  const c = Math.round((time - o.t0) * o.fps);
  let value = 0, frame = c;
  for (let d = -radius; d <= radius; d++) if ((a[c + d] ?? 0) > value) {
    value = a[c + d]; frame = c + d;
  }
  const left = a[frame - 1] ?? 0, right = a[frame + 1] ?? 0;
  let fraction = 0;
  if (value > 0 && left > 0 && right > 0) {
    const l = Math.log(left), m = Math.log(value), r = Math.log(right);
    const denominator = l - 2 * m + r;
    if (Math.abs(denominator) > 1e-9) fraction = clamp((l - r) / (2 * denominator), -0.5, 0.5);
  }
  return { value, time: (frame + fraction) / o.fps + o.t0 };
}

/** Regress observed attacks against their known pulse indices. The comb fit's
 * ±one-frame tolerance is intentionally broad; it must not turn into tempo
 * drift when several validated windows are joined.
 */
function refinePulse(o: OnsetEnvelope, start: number, end: number, origin: number, period: number) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  const radius = Math.max(1, Math.round(o.fps * 0.028));
  for (let k = Math.ceil((start - origin) / period); origin + k * period < end - period * 0.1; k++) {
    const p = peakAt(o, o.lowMid, origin + k * period, radius);
    if (p.value < 0.8 || Math.abs(p.time - origin - k * period) > 0.035) continue;
    n++; sx += k; sy += p.time; sxx += k * k; sxy += k * p.time;
  }
  if (n < 16) return { origin, period };
  const refined = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
  if (Math.abs(refined / period - 1) > 0.005) return { origin, period };
  return { origin: (sy - refined * sx) / n, period: refined };
}

/** Validate every local block, including the phase of measured attacks. A
 * majority of fixed-tempo music cannot conceal a different tempo at the exit.
 * Quiet leading/trailing passages are trimmed rather than declared rhythmic.
 */
function validatePulse(o: OnsetEnvelope, start: number, end: number, origin: number, period: number): Pulse | null {
  if (!(period > 0) || !Number.isFinite(period) || end - start < MIN_SECONDS) return null;
  const raw: { time: number; on: number; off: number; residual: number }[] = [];
  const radius = Math.max(1, Math.round(o.fps * 0.028));
  for (let k = Math.ceil((start - origin) / period - 1e-6); origin + k * period < end - period * 0.1; k++) {
    const time = origin + k * period;
    const p = peakAt(o, o.lowMid, time, radius);
    const on = p.value;
    const off = [0.25, 0.5, 0.75].reduce((s, f) => s + peakAt(o, o.lowMid, time + period * f).value, 0) / 3;
    raw.push({ time, on, off, residual: p.time - time });
  }
  if (raw.length < 16) return null;
  const averageOn = raw.reduce((s, p) => s + p.on, 0) / raw.length;
  const attackFloor = Math.max(0.7, averageOn * 0.32);
  const supported = raw.map((p) => p.on > attackFloor && Math.abs(p.residual) <= 0.028 + 1 / o.fps);
  const first = supported.indexOf(true), last = supported.lastIndexOf(true);
  if (first < 0 || last - first < 15) return null;
  start = Math.max(start, raw[first].time);
  end = Math.min(end, raw[last].time + period);
  if (end - start < MIN_SECONDS) return null;
  const points = raw.slice(first, last + 1);
  const flags = supported.slice(first, last + 1);
  const attacks = points.filter((_, i) => flags[i]);
  const support = attacks.length / points.length;
  const on = points.reduce((s, p) => s + p.on, 0) / points.length;
  const off = points.reduce((s, p) => s + p.off, 0) / points.length;
  const contrast = clamp((on - off) / Math.max(0.01, on));
  const jitterMs = Math.sqrt(attacks.reduce((s, p) => s + p.residual ** 2, 0) / Math.max(1, attacks.length)) * 1000;
  if (support < 0.65 || contrast < 0.24 || on < 1 || jitterMs > 22) return null;

  // Four-second blocks prevent a steady beginning from licensing a drifting,
  // noisy or drumless ending. The final short block joins its predecessor.
  const blockCount = Math.max(1, Math.floor((end - start) / 4));
  const blocks = Array.from({ length: blockCount }, () => ({ on: 0, off: 0, n: 0, hits: 0, offsets: [] as number[] }));
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const b = blocks[Math.min(blocks.length - 1, Math.max(0, Math.floor((p.time - start) / 4)))];
    b.on += p.on; b.off += p.off; b.n++;
    if (flags[i]) { b.hits++; b.offsets.push(p.residual); }
  }
  const phaseOffsets: number[] = [];
  for (const b of blocks) {
    if (!b.n || b.hits / b.n < 0.5 || b.on / b.n < 0.8 || (b.on - b.off) / Math.max(0.01, b.on) < 0.16) return null;
    phaseOffsets.push(median(b.offsets));
  }
  if (Math.max(...phaseOffsets) - Math.min(...phaseOffsets) > 0.026) return null;
  const confidence = clamp(0.55 * support + 0.3 * contrast + 0.15 * (1 - jitterMs / 30));
  return { start, end, origin, period, support, contrast, jitterMs, confidence };
}

function toRegion(o: OnsetEnvelope, pulse: Pulse, global: BeatGrid | null): BeatRegion {
  const { start, end, origin, period } = pulse;
  const beats: number[] = [];
  for (let k = Math.ceil((start - origin) / period - 1e-6); origin + k * period < end - period * 0.1; k++) beats.push(origin + k * period);
  let phase = 0, downbeatConfidence = 0;
  const globalPhase = global?.stable && Math.abs(period / global.period - 1) < 0.0005
    ? global.downbeats.find((t) => t >= start - period * 0.1 && t < end) : undefined;
  if (globalPhase !== undefined && beats.length && Math.abs((globalPhase - beats[0]) / period - Math.round((globalPhase - beats[0]) / period)) < 0.04) {
    phase = ((Math.round((globalPhase - beats[0]) / period) % 4) + 4) % 4;
    downbeatConfidence = global!.downbeatConfidence;
  } else {
    // Low-band accents supply only a 4/4 bar hypothesis. Uniform clicks have
    // zero bar confidence; a beat grid alone does not identify musical bars.
    const scores = [0, 1, 2, 3].map((p) => {
      let s = 0, n = 0;
      for (let i = p; i < beats.length; i += 4) { s += peakAt(o, o.low, beats[i]).value; n++; }
      return s / Math.max(1, n);
    });
    const order = scores.map((score, index) => ({ score, index })).sort((a, b) => b.score - a.score);
    phase = order[0].index;
    downbeatConfidence = clamp((order[0].score - order[1].score) / Math.max(0.01, order[0].score) * 3);
  }
  return {
    start: Math.round(start * 10000) / 10000, end: Math.round(end * 10000) / 10000,
    bpm: Math.round(60 / period * 100) / 100, period,
    confidence: Math.round(pulse.confidence * 1000) / 1000, jitterMs: Math.round(pulse.jitterMs * 10) / 10,
    beats: beats.map((t) => Math.round(t * 10000) / 10000),
    downbeats: beats.filter((_, i) => i % 4 === phase).map((t) => Math.round(t * 10000) / 10000),
    downbeatConfidence, downbeatPhase: phase,
  };
}

/** Measured constant-tempo regions for local mixing. Scans the full track,
 * with denser coverage of the first 75 and final 96 seconds; at most 100
 * windows bound work on unusually long recordings. Regions never extrapolate
 * across a tempo change or a drumless gap. No meter/vocal classifier is used.
 */
export function detectBeatRegions(
  o: OnsetEnvelope,
  audibleStart: number,
  audibleEnd: number,
  global: BeatGrid | null = null,
  hi?: { rate: number; env: Float32Array },
  checkCancel: () => void = () => {},
): BeatRegion[] {
  if (audibleEnd - audibleStart < MIN_SECONDS) return [];
  checkCancel();
  if (global?.stable && global.confidence >= 0.45 && global.beats.length) {
    const whole = validatePulse(o, audibleStart, audibleEnd, global.beats[0], global.period);
    if (whole && whole.start - audibleStart < global.period && audibleEnd - whole.end < global.period) return [toRegion(o, whole, global)];
  }
  const starts = new Set<number>();
  const lastStart = Math.max(audibleStart, audibleEnd - WINDOW_SECONDS);
  const add = (start: number) => starts.add(Math.round(clamp(start, audibleStart, lastStart) * 1000) / 1000);
  for (let t = audibleStart; t < Math.min(audibleEnd, audibleStart + 75) - MIN_SECONDS; t += 8) add(t);
  for (let t = Math.max(audibleStart, audibleEnd - 96); t < audibleEnd - MIN_SECONDS; t += 8) add(t);
  add(lastStart);
  const remaining = Math.max(1, 100 - starts.size);
  const coarse = Math.max(16, (lastStart - audibleStart) / remaining);
  for (let t = audibleStart; t <= lastStart && starts.size < 100; t += coarse) add(t);
  const pulses: Pulse[] = [];
  for (const start of [...starts].sort((a, b) => a - b)) {
    checkCancel();
    const end = Math.min(audibleEnd, start + WINDOW_SECONDS);
    if (end - start < MIN_SECONDS) continue;
    let best: Pulse | null = global?.stable && global.confidence >= 0.45 && global.beats.length
      ? validatePulse(o, start, end, global.beats[0], global.period) : null;
    if (!best) {
      const from = Math.max(0, Math.floor((start - o.t0) * o.fps));
      const to = Math.min(o.lowMid.length, Math.ceil((end - o.t0) * o.fps));
      const estimate = estimateTempo(o.lowMid, o.fps, from, to);
      if (estimate.strength < 0.4) continue;
      const tempos = [...(global?.stable ? [global.bpm] : []), estimate.bpm, estimate.bpm / 2, estimate.bpm * 2, ...(global && !global.stable ? [global.bpm] : [])]
        .filter((bpm, i, all) => bpm >= 55 && bpm <= 215 && all.findIndex((x) => Math.abs(x - bpm) < 0.2) === i);
      for (const bpm of tempos) {
        const fitted = fitOnsetGrid(o, start, end, bpm);
        if (!fitted.stable) continue;
        const refined = refinePulse(o, start, end, fitted.t0, fitted.period);
        let origin = refined.origin;
        if (hi) origin = refineGridHiRes(hi, origin, refined.period, Math.ceil((start - origin) / refined.period), Math.floor((end - origin) / refined.period));
        const candidate = validatePulse(o, start, end, origin, refined.period);
        if (!candidate) continue;
        if (!best || candidate.confidence > best.confidence + 0.015) best = candidate;
        // Preserve the established metrical level when its independently
        // fitted local pulse is reliable; a half-time kick pattern alone
        // should not turn a known 118 BPM song into 59 BPM.
        if (global?.stable && Math.abs(candidate.period / global.period - 1) < 0.002) break;
      }
    }
    if (best) pulses.push(best);
  }
  const merged: Pulse[] = [];
  for (const p of pulses.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = merged.at(-1);
    if (previous && p.start <= previous.end + previous.period * 0.15 && Math.abs(p.period / previous.period - 1) < 0.005) {
      const phase = p.origin - previous.origin - Math.round((p.origin - previous.origin) / previous.period) * previous.period;
      if (Math.abs(phase) < 0.025) {
        const whole = validatePulse(o, previous.start, Math.max(previous.end, p.end), previous.origin, previous.period);
        if (whole) { merged[merged.length - 1] = whole; continue; }
      }
    }
    // A fully covered duplicate contributes no additional usable audio.
    if (!merged.some((r) => p.start >= r.start && p.end <= r.end && Math.abs(p.period / r.period - 1) < 0.005)) merged.push(p);
  }
  return merged.map((p) => toRegion(o, p, global));
}
