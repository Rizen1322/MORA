import { describe, expect, it } from 'vitest';
import { detectBeatRegions } from '../src/mir/regions.ts';
import type { BeatGrid } from '../src/types.ts';
import type { OnsetEnvelope } from '../src/mir/tempo.ts';

function onsets(duration: number, parts: { start: number; end: number; bpm: number; phase?: number }[]): OnsetEnvelope {
  const fps = 100;
  const env = new Float32Array(Math.ceil(duration * fps));
  const low = new Float32Array(env.length);
  for (const part of parts) {
    const period = 60 / part.bpm;
    for (let k = 0; part.start + (part.phase ?? 0.173) + k * period < part.end; k++) {
      const time = part.start + (part.phase ?? 0.173) + k * period;
      const center = time * fps;
      for (let i = Math.floor(center) - 2; i <= Math.ceil(center) + 2; i++) if (i >= 0 && i < env.length) {
        const height = k % 4 === 0 ? 5 : 3;
        env[i] += height * Math.exp(-0.5 * ((i - center) / 0.65) ** 2);
        low[i] += (k % 4 === 0 ? 5 : 1) * Math.exp(-0.5 * ((i - center) / 0.65) ** 2);
      }
    }
  }
  return { fps, t0: 0, env, lowMid: env, low };
}

function grid(bpm: number, duration: number): BeatGrid {
  const period = 60 / bpm;
  const beats = Array.from({ length: Math.ceil(duration / period) }, (_, i) => 0.173 + i * period).filter((t) => t < duration);
  return { bpm, period, confidence: 0.95, stable: true, jitterMs: 1, beats, downbeats: beats.filter((_, i) => i % 4 === 0), downbeatConfidence: 0.9, downbeatPhase: 0, alternatives: [] };
}

describe('measured local rhythm regions', () => {
  it('reuses a reliable global grid without changing its tempo or phase', () => {
    const o = onsets(144, [{ start: 0, end: 144, bpm: 118 }]);
    const global = grid(118, 144);
    const regions = detectBeatRegions(o, 0, 144, global);
    expect(regions).toHaveLength(1);
    expect(regions[0].bpm).toBe(118);
    expect(regions[0].period).toBe(global.period);
    expect(regions[0].end - regions[0].start).toBeGreaterThan(140);
    expect(regions[0].downbeatConfidence).toBe(0.9);
    for (const beat of regions[0].beats) expect(Math.abs((beat - 0.173) / global.period - Math.round((beat - 0.173) / global.period))).toBeLessThan(0.0002);
  });

  it('finds independently stable 118 and 130 BPM sections instead of fitting one global tempo', () => {
    const o = onsets(144, [{ start: 0, end: 72, bpm: 118 }, { start: 72, end: 144, bpm: 130 }]);
    const regions = detectBeatRegions(o, 0, 144);
    const beginning = regions.find((r) => r.start < 10 && r.end > 40);
    const ending = regions.find((r) => r.start < 110 && r.end > 138 && Math.abs(r.bpm - 130) < 0.1);
    expect(beginning).toBeDefined();
    expect(ending).toBeDefined();
    expect(beginning!.bpm).toBeCloseTo(118, 1);
    expect(ending!.bpm).toBeCloseTo(130, 1);
    expect(regions.every((r) => !(r.start < 60 && r.end > 84))).toBe(true);
  });

  it('does not extrapolate a rhythmic region through a long drumless breakdown', () => {
    const p = 60 / 118;
    const o = onsets(144, [{ start: 0, end: 48, bpm: 118 }, { start: 72, end: 144, bpm: 118, phase: 0.173 + Math.ceil((72 - 0.173) / p) * p - 72 }]);
    const regions = detectBeatRegions(o, 0, 144, grid(118, 144));
    expect(regions.some((r) => r.start < 10 && r.end > 40)).toBe(true);
    expect(regions.some((r) => r.start < 90 && r.end > 135)).toBe(true);
    expect(regions.every((r) => r.end <= 49 || r.start >= 71)).toBe(true);
  });

  it('rejects loud nonperiodic onset noise', () => {
    const fps = 100, env = new Float32Array(96 * fps);
    let state = 729;
    for (let i = 0; i < env.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      env[i] = state / 4294967296 * 4;
    }
    expect(detectBeatRegions({ fps, t0: 0, env, lowMid: env, low: env }, 0, 96)).toEqual([]);
  });

  it('does not claim fixed-tempo sections in a continuously drifting pulse', () => {
    const fps = 100, env = new Float32Array(96 * fps);
    for (let time = 0.173; time < 96; time += 60 / (112 + time * 0.5)) {
      const center = time * fps;
      for (let i = Math.floor(center) - 2; i <= Math.ceil(center) + 2; i++) if (i >= 0 && i < env.length) env[i] = 4 * Math.exp(-0.5 * ((i - center) / 0.65) ** 2);
    }
    expect(detectBeatRegions({ fps, t0: 0, env, lowMid: env, low: env }, 0, 96)).toEqual([]);
  });

  it('keeps measured beat and bar phases consistent after merging overlapping windows', () => {
    const o = onsets(144, [{ start: 0, end: 144, bpm: 118 }]);
    const regions = detectBeatRegions(o, 0, 144);
    expect(regions.some((r) => r.end - r.start > 100)).toBe(true);
    for (const r of regions) {
      expect(r.jitterMs).toBeLessThan(15);
      expect(r.downbeatConfidence).toBeGreaterThan(0.5);
      for (const beat of r.beats) {
        const distance = beat - 0.173 - Math.round((beat - 0.173) * 118 / 60) * 60 / 118;
        expect(Math.abs(distance)).toBeLessThan(0.018);
      }
      for (const beat of r.downbeats) {
        const distance = beat - 0.173 - Math.round((beat - 0.173) * 118 / 240) * 240 / 118;
        expect(Math.abs(distance)).toBeLessThan(0.018);
      }
    }
  });

  it('checks the middle of long recordings as well as the entry and exit', () => {
    const o = onsets(360, [{ start: 0, end: 180, bpm: 118 }, { start: 180, end: 360, bpm: 130 }]);
    const regions = detectBeatRegions(o, 0, 360);
    expect(regions.some((r) => r.start <= 120 && r.end >= 145 && Math.abs(r.bpm - 118) < 0.1)).toBe(true);
    expect(regions.some((r) => r.start <= 220 && r.end >= 245 && Math.abs(r.bpm - 130) < 0.1)).toBe(true);
  });

  it('supports cancellation between analysis windows', () => {
    const o = onsets(144, [{ start: 0, end: 144, bpm: 118 }]);
    let checks = 0;
    expect(() => detectBeatRegions(o, 0, 144, null, undefined, () => { if (++checks === 3) throw new Error('cancelled'); })).toThrow('cancelled');
  });
});
