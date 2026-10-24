import { Wsola, type PcmSource } from './wsola.ts';

export interface PlaybackSettings { speed: number; semitones: number }
export const DEFAULT_PLAYBACK: PlaybackSettings = { speed: 1, semitones: 0 };
export function sanitizePlayback(raw: unknown): PlaybackSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PlaybackSettings>;
  const clamp = (v: unknown, fallback: number, lo: number, hi: number, scale: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(lo, Math.min(hi, v)) * scale) / scale : fallback;
  return { speed: clamp(r.speed, 1, .8, 1.2, 100), semitones: clamp(r.semitones, 0, -6, 6, 2) };
}

type Pull = (L: Float32Array, R: Float32Array, n: number) => void;
/** Bounded rewindable view of a sequential renderer, needed by WSOLA's overlap search. */
class PullSource implements PcmSource {
  readonly totalFrames = Number.MAX_SAFE_INTEGER;
  private L: Float32Array;
  private R: Float32Array;
  private tempL = new Float32Array(128);
  private tempR = new Float32Array(128);
  private end = 0;
  constructor(private capacity: number, private pull: Pull) {
    this.L = new Float32Array(capacity); this.R = new Float32Array(capacity);
  }
  reset(): void { this.end = 0; this.L.fill(0); this.R.fill(0); }
  get generatedFrames(): number { return this.end; }
  read(start: number, len: number, L: Float32Array, R: Float32Array, offset: number): boolean {
    const wanted = Math.max(0, start + len);
    if (len > this.capacity || wanted - this.end > this.capacity || Math.max(0, start) < this.end - this.capacity) return false;
    while (this.end < wanted) {
      this.pull(this.tempL, this.tempR, 128);
      for (let i = 0; i < 128; i++) {
        const at = (this.end + i) % this.capacity;
        this.L[at] = this.tempL[i]; this.R[at] = this.tempR[i];
      }
      this.end += 128;
    }
    if (Math.max(0, start) < this.end - this.capacity) return false;
    for (let i = 0; i < len; i++) {
      const frame = start + i, at = frame % this.capacity;
      L[offset + i] = frame < 0 ? 0 : this.L[at]; R[offset + i] = frame < 0 ? 0 : this.R[at];
    }
    return true;
  }
}

const RADIUS = 32, DENSITY = 1024;
// Shared immutable lookup tables: no trig, allocations or coefficient rebuilding per audio quantum.
const SINC = Float64Array.from({ length: RADIUS * DENSITY + 2 }, (_, i) => i === 0 ? 1 : Math.sin(Math.PI * i / DENSITY) / (Math.PI * i / DENSITY));
const WINDOW = Float64Array.from({ length: RADIUS * DENSITY + 2 }, (_, i) => {
  const x = Math.min(1, i / (RADIUS * DENSITY));
  return .42 + .5 * Math.cos(Math.PI * x) + .08 * Math.cos(2 * Math.PI * x);
});
const lookup = (table: Float64Array, x: number) => {
  const at = Math.min(table.length - 2, Math.abs(x) * DENSITY), i = Math.floor(at);
  return table[i] + (table[i + 1] - table[i]) * (at - i);
};

/**
 * Common musical timeline → WSOLA (s/p) → band-limited resampling (p).
 * Both decks, vocal masks and all transition automation are rendered together
 * before this stage. Their relative phase/timing is never changed independently.
 * Master effects and the true-peak limiter MUST run after this transform.
 */
export class PlaybackTransform {
  private source: PullSource;
  private stretched: PullSource;
  private wsola: Wsola;
  private settings = { ...DEFAULT_PLAYBACK };
  private speed = 1;
  private pitch = 1;
  private position = 0;
  private active = false;
  private inputL = new Float32Array(4096);
  private inputR = new Float32Array(4096);
  private warmL = new Float32Array(4096);
  private warmR = new Float32Array(4096);
  private warmPosition = 0;
  private warmLeft = 0;
  private readonly warmFrames: number;
  private readonly glide: number;
  constructor(sampleRate: number, private pull: Pull) {
    const capacity = Math.ceil(sampleRate / 128) * 128;
    this.source = new PullSource(capacity, pull);
    this.wsola = new Wsola(sampleRate, this.source);
    this.stretched = new PullSource(capacity, (L, R, n) => {
      const produced = this.wsola.render(L, R, 0, n, () => this.speed / this.pitch);
      if (produced < n) { L.fill(0, produced); R.fill(0, produced); }
    });
    this.glide = 1 - Math.exp(-128 / (sampleRate * .04));
    this.warmFrames = Math.ceil(sampleRate * .03);
  }
  set(raw: PlaybackSettings): void { this.settings = sanitizePlayback(raw); }
  reset(): void {
    this.source.reset(); this.stretched.reset(); this.wsola.reset(0); this.position = 0; this.active = false;
    this.speed = this.settings.speed; this.pitch = 2 ** (this.settings.semitones / 12);
    this.warmLeft = 0; this.warmPosition = 0;
  }
  get speedRatio(): number { return this.active ? this.speed : this.settings.speed; }
  /** Musical frames rendered ahead but not yet heard; used to drain the ending. */
  get bufferedMusicalFrames(): number {
    return this.active ? Math.max(0, this.source.generatedFrames - this.wsola.position()
      + Math.max(0, this.stretched.generatedFrames - this.position) * this.speed / this.pitch) : 0;
  }
  get engaged(): boolean { return this.active || this.settings.speed !== 1 || this.settings.semitones !== 0; }
  process(L: Float32Array, R: Float32Array, n: number): void {
    if (!this.active && this.settings.speed === 1 && this.settings.semitones === 0) { this.pull(L, R, n); return; }
    if (!this.active) {
      this.active = true; this.speed = this.settings.speed; this.pitch = 2 ** (this.settings.semitones / 12);
      this.warmLeft = this.warmFrames;
    }
    // Keep the buffered path when returning to neutral, avoiding a skipped lookahead window.
    const amount = 1 - (1 - this.glide) ** (n / 128);
    this.speed += (this.settings.speed - this.speed) * amount;
    const p0 = this.pitch;
    this.pitch += (2 ** (this.settings.semitones / 12) - this.pitch) * amount;
    const start = Math.floor(this.position) - RADIUS + 1;
    const length = Math.ceil(n * Math.max(p0, this.pitch)) + RADIUS * 2 + 2;
    if (length > this.inputL.length || !this.stretched.read(start, length, this.inputL, this.inputR, 0)) {
      L.fill(0, 0, n); R.fill(0, 0, n); return;
    }
    const cutoff = .94 / Math.max(1, p0, this.pitch);
    for (let i = 0; i < n; i++) {
      const centre = this.position, first = Math.floor(centre) - RADIUS + 1;
      let l = 0, r = 0, sum = 0;
      for (let j = 0; j < RADIUS * 2; j++) {
        const x = first + j - centre;
        const w = cutoff * lookup(SINC, x * cutoff) * lookup(WINDOW, x);
        const at = first + j - start;
        l += this.inputL[at] * w; r += this.inputR[at] * w; sum += w;
      }
      L[i] = l / sum; R[i] = r / sum;
      this.position += p0 + (this.pitch - p0) * (i + 1) / n;
    }
    if (this.warmLeft > 0) {
      // WSOLA's first overlap ramps up from silence. Blend from the same source
      // window when enabling the effect mid-song, rather than cutting to zero.
      const first = Math.floor(this.warmPosition), length = Math.ceil(n * this.speed) + 2;
      if (this.source.read(first, length, this.warmL, this.warmR, 0)) {
        for (let i = 0; i < n && this.warmLeft > 0; i++, this.warmLeft--) {
          const at = this.warmPosition - first, a = Math.floor(at), fraction = at - a;
          const wet = 1 - this.warmLeft / this.warmFrames;
          L[i] = L[i] * wet + (this.warmL[a] + (this.warmL[a + 1] - this.warmL[a]) * fraction) * (1 - wet);
          R[i] = R[i] * wet + (this.warmR[a] + (this.warmR[a + 1] - this.warmR[a]) * fraction) * (1 - wet);
          this.warmPosition += this.speed;
        }
      } else this.warmLeft = 0;
    }
  }
}
