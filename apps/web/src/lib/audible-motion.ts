import { MusicMotion } from './music-motion.ts';

type OutputClock = { currentTime: number; baseLatency?: number; outputLatency?: number; getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number } };
/** Estimate where the speakers are, rather than displaying the render-ahead head. */
export function audibleDelay(clock: OutputClock, nowMs: number): number {
  const stamp = clock.getOutputTimestamp?.();
  const measured = stamp?.contextTime && stamp.performanceTime
    ? clock.currentTime - (stamp.contextTime + Math.max(0, nowMs - stamp.performanceTime) / 1000) : NaN;
  const fallback = (clock.baseLatency ?? 0) + (clock.outputLatency ?? 0);
  return Math.min(.4, Math.max(0, Number.isFinite(measured) ? measured : fallback));
}

/** Fixed ~11 KB history, no per-frame allocation. Delays visual features only. */
export class AudibleMotion {
  bass = 0; mid = 0; high = 0; kick = 0; level = 0;
  readonly bands = new Float32Array(16);
  private readonly source = new MusicMotion();
  private readonly history = new Float32Array(128 * 21);
  private readonly times = new Float64Array(128);
  private cursor = 0;
  private count = 0;
  update(spectrum: Float32Array | null, waveform: Float32Array | null, sampleRate: number, fftSize: number, dt: number, now: number, delay: number): void {
    if (this.count && now < this.times[(this.cursor + 127) % 128]) this.count = 0;
    this.source.update(spectrum, waveform, sampleRate, fftSize, dt);
    const offset = this.cursor * 21, s = this.source;
    this.times[this.cursor] = now;
    this.history[offset] = s.bass; this.history[offset + 1] = s.mid; this.history[offset + 2] = s.high;
    this.history[offset + 3] = s.kick; this.history[offset + 4] = s.level;
    this.history.set(s.bands, offset + 5);
    this.cursor = (this.cursor + 1) % 128; this.count = Math.min(128, this.count + 1);
    const target = now - Math.max(0, delay);
    let selected = (this.cursor + 128 - this.count) % 128;
    if (this.times[selected] > target) {
      this.bass = this.mid = this.high = this.kick = this.level = 0; this.bands.fill(0); return;
    }
    for (let i = this.count - 1; i >= 0; i--) {
      const index = (this.cursor + 128 - this.count + i) % 128;
      if (this.times[index] <= target) { selected = index; break; }
    }
    const at = selected * 21;
    this.bass = this.history[at]; this.mid = this.history[at + 1]; this.high = this.history[at + 2];
    this.kick = this.history[at + 3]; this.level = this.history[at + 4];
    for (let i = 0; i < 16; i++) this.bands[i] = this.history[at + 5 + i];
  }
}
