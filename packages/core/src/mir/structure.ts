import type { BeatGrid, MusicalSection } from '../types.ts';
import { median } from './tempo.ts';

interface StructureCurves {
  rate: number;
  rmsDb: number[];
  lowDb: number[];
  midDb: number[];
  highDb: number[];
  midDensity: number[];
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Two-sided, multi-band acoustic novelty. Works without a beat grid; reliable
 * grids only snap measured changes to nearby bars. A section is not a chorus.
 */
export function detectSections(c: StructureCurves, start: number, end: number, beat: BeatGrid | null, harmonicBoundaries: number[] = []): MusicalSection[] {
  const arrays = [c.rmsDb, c.lowDb, c.midDb, c.highDb, c.midDensity];
  const prefix = arrays.map((a) => {
    const p = new Float64Array(a.length + 1);
    for (let i = 0; i < a.length; i++) p[i + 1] = p[i] + a[i];
    return p;
  });
  const mean = (k: number, a: number, b: number) => {
    const p = prefix[k];
    const from = Math.max(0, Math.min(p.length - 1, Math.floor(a * c.rate)));
    const to = Math.max(from, Math.min(p.length - 1, Math.ceil(b * c.rate)));
    return to > from ? (p[to] - p[from]) / (to - from) : k === 4 ? 0 : -90;
  };
  const samples: { time: number; value: number }[] = [];
  for (let t = start + 3; t <= end - 3; t += 0.25) {
    const change = arrays.map((_a, k) => Math.abs(mean(k, t - 2, t) - mean(k, t, t + 2)));
    const value = 0.35 * change[0] / 6 + 0.65 * (change[1] + change[2] + change[3]) / 18 + change[4] * 1.5;
    samples.push({ time: t, value });
  }
  const med = median(samples.map((s) => s.value));
  const mad = median(samples.map((s) => Math.abs(s.value - med)));
  const threshold = Math.max(0.55, med + 2.5 * mad);
  const peaks = samples.filter((s, i) => s.value >= threshold && s.value >= (samples[i - 1]?.value ?? 0) && s.value > (samples[i + 1]?.value ?? 0));
  const candidates = peaks.map((s) => ({ time: s.time, value: clamp(s.value / 1.5) }));
  for (const time of harmonicBoundaries) if (time > start + 3 && time < end - 3) candidates.push({ time, value: 0.45 });
  candidates.sort((a, b) => b.value - a.value);
  const accepted: { time: number; value: number }[] = [];
  for (const candidate of candidates) {
    let time = candidate.time;
    if (beat?.stable && beat.downbeatConfidence >= 0.25 && beat.downbeats.length) {
      const nearest = beat.downbeats.reduce((a, b) => Math.abs(b - time) < Math.abs(a - time) ? b : a);
      if (Math.abs(nearest - time) <= Math.min(1.2, beat.period * 2)) time = nearest;
    }
    if (time <= start + 2 || time >= end - 2 || accepted.some((s) => Math.abs(s.time - time) < 6)) continue;
    accepted.push({ ...candidate, time });
  }
  accepted.sort((a, b) => a.time - b.time);
  const boundaries = [{ time: start, value: 0 }, ...accepted, { time: end, value: 0 }];
  return boundaries.slice(0, -1).map((b, i) => ({
    start: Math.round(b.time * 1000) / 1000,
    end: Math.round(boundaries[i + 1].time * 1000) / 1000,
    rmsDb: Math.round(mean(0, b.time, boundaries[i + 1].time) * 10) / 10,
    midDensity: Math.round(mean(4, b.time, boundaries[i + 1].time) * 1000) / 1000,
    novelty: Math.round(b.value * 1000) / 1000,
  }));
}
