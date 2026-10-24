import { magnitude, peaking, type BiquadCoefs } from './biquad.ts';
import { sanitizePlayback } from './playback.ts';

/**
 * Listener's sound panel, applied to the final DJ mix (after both decks and the
 * transition EQ are summed) and before master volume and the true-peak limiter.
 * It never changes analysis or loudness normalisation of tracks.
 */

export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
export const EQ_MAX_DB = 12;
/** One-octave bells. */
const EQ_Q = Math.SQRT2;

export interface ToneSettings {
  /** false = everything below is bypassed (gains glide to flat first, no click). */
  enabled: boolean;
  /** dB per band of EQ_BANDS, each within ±EQ_MAX_DB. */
  gains: number[];
  /** Manual pre-gain in dB (-12..+6). */
  preampDb: number;
  /** Subtract the measured peak boost of the EQ curve so boosts do not hit the limiter. */
  autoHeadroom: boolean;
  /** -1 (left) .. 1 (right). */
  balance: number;
  mono: boolean;
  /** Optional small-room wet mix, 0..0.35. Zero keeps the original signal. */
  reverbMix?: number;
}

export const FLAT_TONE: ToneSettings = { enabled: false, gains: EQ_BANDS.map(() => 0), preampDb: 0, autoHeadroom: true, balance: 0, mono: false, reverbMix: 0 };

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Accepts anything (old settings, a hand-edited file) and returns valid settings. */
export function sanitizeTone(raw: unknown): ToneSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ToneSettings>;
  const gains = Array.isArray(r.gains) ? r.gains : [];
  return {
    enabled: r.enabled === true,
    gains: EQ_BANDS.map((_, i) => Math.round(clamp(gains[i], -EQ_MAX_DB, EQ_MAX_DB, 0) * 10) / 10),
    preampDb: clamp(r.preampDb, -12, 6, 0),
    autoHeadroom: r.autoHeadroom !== false,
    balance: clamp(r.balance, -1, 1, 0),
    mono: r.mono === true,
    reverbMix: clamp(r.reverbMix, 0, .35, 0),
  };
}

/** Bands that make sense at this sample rate (below 0.45 × fs). */
export const usableBand = (f: number, fs: number) => f < 0.45 * fs;

function coefs(gains: readonly number[], fs: number): (BiquadCoefs | null)[] {
  return EQ_BANDS.map((f, i) => (usableBand(f, fs) && Math.abs(gains[i]) > 0.01 ? peaking(fs, f, gains[i], EQ_Q) : null));
}

/**
 * Highest boost of the whole EQ curve in dB (≥ 0), measured on a dense log
 * grid: overlapping bells add up, so the loudest slider alone underestimates it.
 */
export function eqPeakDb(gains: readonly number[], fs: number): number {
  const cs = coefs(gains, fs).filter((c): c is BiquadCoefs => !!c);
  if (!cs.length) return 0;
  let max = 0;
  for (let k = 0; k <= 480; k++) {
    const f = 20 * Math.pow(Math.min(20000, 0.45 * fs) / 20, k / 480);
    let m = 1;
    for (const c of cs) m *= magnitude(c, fs, f);
    max = Math.max(max, 20 * Math.log10(m));
  }
  return max;
}

/** Effective pre-gain in dB for given settings. */
export function preampFor(s: ToneSettings, fs: number): number {
  return s.preampDb - (s.autoHeadroom ? eqPeakDb(s.gains, fs) : 0);
}

const BLOCK = 64;
/** Max gain change per 64-sample block: 12 dB in ~30 ms at 48 kHz. */
const STEP_DB = 0.5;

export class MasterTone {
  private target: ToneSettings = FLAT_TONE;
  private cur = EQ_BANDS.map(() => 0);
  private c: (BiquadCoefs | null)[] = EQ_BANDS.map(() => null);
  private z = EQ_BANDS.map(() => new Float64Array(4)); // z1L, z2L, z1R, z2R
  private pre = 1;
  private preTarget = 1;
  private bal = 0;
  private mono = 0;
  private idle = true;

  constructor(private readonly fs: number) {}

  /** `preDb` lets the main thread measure the curve so the audio thread does not. */
  set(s: ToneSettings, preDb?: number): void {
    this.target = sanitizeTone(s);
    const pre = typeof preDb === 'number' && Number.isFinite(preDb) ? Math.max(-36, Math.min(6, preDb)) : preampFor(this.target, this.fs);
    this.preTarget = this.target.enabled ? Math.pow(10, pre / 20) : 1;
    this.idle = false;
  }

  /** True while settings are flat and nothing is gliding: the caller may skip process(). */
  get bypassed(): boolean { return this.idle; }

  private step(): void {
    const on = this.target.enabled;
    let moving = false;
    for (let b = 0; b < EQ_BANDS.length; b++) {
      const goal = on ? this.target.gains[b] : 0;
      const d = goal - this.cur[b];
      if (Math.abs(d) < 1e-6) continue;
      moving = true;
      this.cur[b] += Math.max(-STEP_DB, Math.min(STEP_DB, d));
      const was = this.c[b];
      this.c[b] = usableBand(EQ_BANDS[b], this.fs) && Math.abs(this.cur[b]) > 0.01 ? peaking(this.fs, EQ_BANDS[b], this.cur[b], EQ_Q) : null;
      if (!was && this.c[b]) this.z[b].fill(0);
    }
    const balGoal = on ? this.target.balance : 0, monoGoal = on && this.target.mono ? 1 : 0;
    if (this.bal !== balGoal || this.mono !== monoGoal || this.pre !== this.preTarget) moving = true;
    if (!moving && !on) this.idle = true;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    if (this.idle) return;
    for (let s = 0; s < n; s += BLOCK) {
      this.step();
      const e = Math.min(n, s + BLOCK);
      for (let b = 0; b < EQ_BANDS.length; b++) {
        const c = this.c[b];
        if (!c) continue;
        const z = this.z[b];
        let z1 = z[0], z2 = z[1], y1 = z[2], y2 = z[3];
        for (let i = s; i < e; i++) {
          const xl = L[i];
          const yl = c.b0 * xl + z1;
          z1 = c.b1 * xl - c.a1 * yl + z2;
          z2 = c.b2 * xl - c.a2 * yl;
          L[i] = yl;
          const xr = R[i];
          const yr = c.b0 * xr + y1;
          y1 = c.b1 * xr - c.a1 * yr + y2;
          y2 = c.b2 * xr - c.a2 * yr;
          R[i] = yr;
        }
        z[0] = z1; z[1] = z2; z[2] = y1; z[3] = y2;
      }
      // Pre-gain, mono and balance glide per sample within the block.
      const on = this.target.enabled;
      const preStep = (this.preTarget - this.pre) / (e - s);
      const balGoal = on ? this.target.balance : 0, monoGoal = on && this.target.mono ? 1 : 0;
      const balStep = Math.max(-0.02, Math.min(0.02, balGoal - this.bal)) / (e - s);
      const monoStep = Math.max(-0.02, Math.min(0.02, monoGoal - this.mono)) / (e - s);
      let pre = this.pre, bal = this.bal, mono = this.mono;
      for (let i = s; i < e; i++) {
        pre += preStep; bal += balStep; mono += monoStep;
        const l = L[i] * pre, r = R[i] * pre;
        const m = (l + r) * 0.5;
        const ml = l + (m - l) * mono, mr = r + (m - r) * mono;
        L[i] = ml * Math.min(1, 1 - bal);
        R[i] = mr * Math.min(1, 1 + bal);
      }
      this.pre = Math.abs(this.preTarget - pre) < 1e-6 ? this.preTarget : pre;
      this.bal = Math.abs(balGoal - bal) < 1e-6 ? balGoal : bal;
      this.mono = Math.abs(monoGoal - mono) < 1e-6 ? monoGoal : mono;
    }
  }

  reset(): void {
    for (const z of this.z) z.fill(0);
  }
}

export interface TonePreset { name: string; gains: number[] }
/** Stored with the app settings: current tone plus the listener's own presets. */
export interface SoundSettings { tone: ToneSettings; presets: TonePreset[]; playback: import('./playback.ts').PlaybackSettings }

/** Moderate built-in starting points; the listener can save their own. */
export const BUILTIN_PRESETS: TonePreset[] = [
  { name: 'Ровно', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: 'Больше баса', gains: [4, 3.5, 2.5, 1, 0, 0, 0, 0, 0, 0] },
  { name: 'Вокал', gains: [-1.5, -1, 0, 0.5, 1.5, 2.5, 2.5, 1.5, 0, -0.5] },
  { name: 'Тихое прослушивание', gains: [3, 2.5, 1.5, 0, 0, 0, 0, 0.5, 1.5, 2] },
  { name: 'Электроника', gains: [3.5, 3, 1, 0, -1, -0.5, 0.5, 1.5, 2.5, 2] },
];

export function sanitizeSound(raw: unknown): SoundSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SoundSettings>;
  const presets = Array.isArray(r.presets) ? r.presets : [];
  return {
    tone: sanitizeTone(r.tone),
    playback: sanitizePlayback(r.playback),
    presets: presets
      .filter((p): p is TonePreset => !!p && typeof p.name === 'string' && p.name.trim().length > 0)
      .slice(0, 16)
      .map((p) => ({ name: p.name.trim().slice(0, 40), gains: sanitizeTone({ gains: p.gains }).gains })),
  };
}
