import type { PcmSource } from '../dsp/wsola.ts';

export const CHUNK_FRAMES = 32768;

/** Sparse chunked PCM store with bounded memory, filled asynchronously. */
export class ChunkStore implements PcmSource {
  private chunks = new Map<number, { L: Float32Array; R: Float32Array }>();
  constructor(public totalFrames: number) {}

  get chunkCount(): number {
    return Math.ceil(this.totalFrames / CHUNK_FRAMES);
  }

  /** Takes the decoder's exact length. Returns chunks to fetch again: the one that ended at the old
   * estimate was cut short there (growth), and none beyond the new end are kept (shrink). */
  resize(totalFrames: number): number[] {
    const grew = totalFrames > this.totalFrames, edge = Math.floor((this.totalFrames - 1) / CHUNK_FRAMES);
    this.totalFrames = totalFrames;
    for (const k of this.chunks.keys()) if (k >= this.chunkCount) this.chunks.delete(k);
    if (!grew || edge < 0) return [];
    this.chunks.delete(edge);
    return [edge];
  }

  put(index: number, L: Float32Array, R: Float32Array): void {
    if (index < 0 || index >= this.chunkCount) return;
    this.chunks.set(index, { L, R });
  }

  get(index: number): { L: Float32Array; R: Float32Array } | undefined {
    return this.chunks.get(index);
  }

  has(index: number): boolean {
    return this.chunks.has(index);
  }

  loadedCount(): number {
    return this.chunks.size;
  }

  /** True if every chunk overlapping [from, to) is present. */
  covers(from: number, to: number): boolean {
    const a = Math.max(0, Math.floor(from / CHUNK_FRAMES));
    const b = Math.min(this.chunkCount - 1, Math.floor((Math.max(from, to) - 1) / CHUNK_FRAMES));
    for (let i = a; i <= b; i++) if (!this.chunks.has(i)) return false;
    return true;
  }

  missing(from: number, to: number): number[] {
    const out: number[] = [];
    const a = Math.max(0, Math.floor(from / CHUNK_FRAMES));
    const b = Math.min(this.chunkCount - 1, Math.floor((Math.max(from, to) - 1) / CHUNK_FRAMES));
    for (let i = a; i <= b; i++) if (!this.chunks.has(i)) out.push(i);
    return out;
  }

  /** Drops chunks fully outside [keepFrom, keepTo). */
  evictOutside(keepFrom: number, keepTo: number): void {
    const a = Math.floor(keepFrom / CHUNK_FRAMES);
    const b = Math.floor((keepTo - 1) / CHUNK_FRAMES);
    for (const k of this.chunks.keys()) if (k < a || k > b) this.chunks.delete(k);
  }

  /** Keep separate playback/prefetch windows without pinning the gap between them. */
  evictOutsideRanges(ranges: readonly (readonly [number, number])[]): void {
    for (const k of this.chunks.keys()) {
      const from = k * CHUNK_FRAMES;
      const to = from + CHUNK_FRAMES;
      if (!ranges.some(([a, b]) => b > a && from < b && to > a)) this.chunks.delete(k);
    }
  }

  clear(): void {
    this.chunks.clear();
  }

  read(start: number, len: number, outL: Float32Array, outR: Float32Array, offset: number): boolean {
    const total = this.totalFrames;
    let i = 0;
    while (i < len) {
      const p = start + i;
      if (p < 0) {
        const n = Math.min(len - i, -p);
        outL.fill(0, offset + i, offset + i + n);
        outR.fill(0, offset + i, offset + i + n);
        i += n;
        continue;
      }
      if (p >= total) {
        outL.fill(0, offset + i, offset + len);
        outR.fill(0, offset + i, offset + len);
        return true;
      }
      const ci = Math.floor(p / CHUNK_FRAMES);
      const c = this.chunks.get(ci);
      if (!c) return false;
      const within = p - ci * CHUNK_FRAMES;
      const n = Math.min(len - i, c.L.length - within, total - p);
      if (n <= 0) return false;
      outL.set(c.L.subarray(within, within + n), offset + i);
      outR.set(c.R.subarray(within, within + n), offset + i);
      i += n;
    }
    return true;
  }
}
