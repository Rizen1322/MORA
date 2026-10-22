import type { PcmSource } from '../dsp/wsola.ts';
import { VOICE_LIFT_MAX } from '../types.ts';

type Points = [number, number][];

function value(points: Points, t: number, before = points[0]?.[1] ?? 1): number {
  if (!points.length || t < points[0][0]) return before;
  for (let i = 1; i < points.length; i++) {
    const [end, gain] = points[i];
    const [start, previous] = points[i - 1];
    if (t <= end) return previous + (gain - previous) * (t - start) / Math.max(1e-9, end - start);
  }
  return points[points.length - 1][1];
}

/** Exact source position at every vocal/tempo knot (both maps use output frames). */
export function vocalSourceMap(cue: number, tempo: Points | undefined, gains: Points | undefined): Points | null {
  if (!gains?.length || gains.every(([, gain]) => gain === 1)) return null;
  const speed = tempo?.length ? tempo : [[0, 1]] as Points;
  const last = gains[gains.length - 1][0];
  const knots = [...new Set([0, ...gains.map(([t]) => t), ...speed.map(([t]) => t).filter((t) => t > 0 && t < last)])].sort((a, b) => a - b);
  const result: Points = [];
  let source = cue;
  let previous = 0;
  for (const t of knots) {
    source += (t - previous) * (value(speed, previous) + value(speed, t)) / 2;
    result.push([source, Math.max(0, Math.min(VOICE_LIFT_MAX, value(gains, t, 1)))]);
    previous = t;
  }
  return result;
}

/**
 * Subtracts only the separated vocal from the original PCM before one WSOLA.
 * Drums, accompaniment and vocal therefore use exactly the same chosen frame
 * offsets; two independently stretched stems could otherwise comb or flam.
 */
export class VocalPcmSource implements PcmSource {
  private points: Points | null = null;
  private spans: [number, number][] = [];
  /**
   * Gain on the subtracted stem. Demucs stems slightly underestimate the
   * voice, so (original - stem) still correlates with it: a small measured
   * over-subtraction (1..1.15) removes most of that ghost voice.
   */
  scale = 1;
  private readonly scratchL: Float32Array;
  private readonly scratchR: Float32Array;

  constructor(private readonly original: PcmSource, private readonly vocals: PcmSource, maxReadFrames: number) {
    this.scratchL = new Float32Array(maxReadFrames);
    this.scratchR = new Float32Array(maxReadFrames);
  }

  get totalFrames(): number { return this.original.totalFrames; }
  getMap(): Points | null { return this.points; }
  /** Source ranges with an actual attenuation. */
  getSpans(): readonly [number, number][] { return this.spans; }

  setMap(points: Points | null): void {
    this.points = points;
    this.spans = [];
    if (!points) return;
    for (let i = 0; i < points.length; i++) {
      const next = points[i + 1];
      if (points[i][1] === 1 && (!next || next[1] === 1)) continue;
      const start = points[i][0], end = next?.[0] ?? Infinity;
      const previous = this.spans[this.spans.length - 1];
      if (previous?.[1] === start) previous[1] = end;
      else this.spans.push([start, end]);
    }
  }

  /** Only ranges with an actual attenuation need a vocal chunk. */
  needs(from: number, to: number): boolean {
    return this.spans.some(([start, end]) => to > start && from < end && to > 0 && from < this.totalFrames);
  }

  gainAt(sourceFrame: number): number { return this.points ? value(this.points, sourceFrame, 1) : 1; }

  /** Largest voice gain anywhere in [from, to] (piecewise linear: endpoints and knots suffice). */
  maxGain(from: number, to: number): number {
    if (!this.points) return 1;
    let m = Math.max(this.gainAt(from), this.gainAt(to));
    for (const [frame, gain] of this.points) if (frame > from && frame < to && gain > m) m = gain;
    return m;
  }

  read(start: number, len: number, outL: Float32Array, outR: Float32Array, offset: number): boolean {
    if (!this.original.read(start, len, outL, outR, offset)) return false;
    if (!this.points || !this.needs(start, start + len)) return true;
    if (len > this.scratchL.length) throw new Error('vocal read exceeds preallocated WSOLA window');
    for (const [from, to] of this.spans) {
      const a = Math.max(start, 0, Math.ceil(from));
      const b = Math.min(start + len, this.totalFrames, Math.ceil(to));
      if (a >= b) continue;
      const local = a - start;
      if (!this.vocals.read(a, b - a, this.scratchL, this.scratchR, local)) return false;
      for (let i = a; i < b; i++) {
        const gain = (this.gainAt(i) - 1) * this.scale;
        outL[offset + i - start] += gain * this.scratchL[i - start];
        outR[offset + i - start] += gain * this.scratchR[i - start];
      }
    }
    return true;
  }
}
