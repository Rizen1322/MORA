import { Biquad, lowpass } from '../dsp/biquad.ts';
import { autocorrelate } from '../dsp/fft.ts';
import { FRAME, ANALYSIS_RATE, type SpectralData } from './spectral.ts';

export interface OnsetEnvelope {
  fps: number;
  /** Seconds offset of frame 0 centre. */
  t0: number;
  env: Float32Array;
  /** Low+mid only (kick/snare), used for octave decisions and downbeats. */
  lowMid: Float32Array;
  low: Float32Array;
}

function movingAverage(x: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(x.length);
  let s = 0;
  let n = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < x.length; i++) {
    while (hi < Math.min(x.length - 1, i + radius)) {
      hi++;
      s += x[hi];
      n++;
    }
    while (lo < i - radius) {
      s -= x[lo];
      lo++;
      n--;
    }
    out[i] = s / Math.max(1, n);
  }
  return out;
}

function normalizeOnset(x: Float32Array, fps: number): Float32Array {
  const avg = movingAverage(x, Math.round(fps * 0.25));
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    y[i] = Math.max(0, x[i] - avg[i]);
    s += y[i] * y[i];
  }
  const std = Math.sqrt(s / Math.max(1, x.length)) || 1;
  for (let i = 0; i < y.length; i++) y[i] /= std;
  return y;
}

export function onsetEnvelope(sp: SpectralData): OnsetEnvelope {
  const n = sp.frames;
  const raw = new Float32Array(n);
  const lm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    raw[i] = 1.5 * sp.fluxLow[i] + sp.fluxMid[i] + sp.fluxHigh[i];
    lm[i] = 1.5 * sp.fluxLow[i] + sp.fluxMid[i];
  }
  return {
    fps: sp.fps,
    t0: FRAME / 2 / ANALYSIS_RATE,
    env: normalizeOnset(raw, sp.fps),
    lowMid: normalizeOnset(lm, sp.fps),
    low: normalizeOnset(sp.fluxLow, sp.fps),
  };
}

function interp(a: Float64Array | Float32Array, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  if (i < 0 || i + 1 >= a.length) return 0;
  return a[i] * (1 - f) + a[i + 1] * f;
}

export interface TempoEstimate {
  bpm: number;
  /** Periodicity peak prominence, 0..1. */
  strength: number;
  scores: { bpm: number; score: number }[];
}

/** Global tempo by comb-weighted autocorrelation with a log-normal prior around 120 BPM. */
export function estimateTempo(env: Float32Array, fps: number, from = 0, to = env.length): TempoEstimate {
  const seg = env.subarray(Math.max(0, from), Math.min(env.length, to));
  const maxLag = Math.ceil((60 * fps) / 45) * 4 + 2;
  const acf = autocorrelate(seg, Math.min(maxLag, seg.length - 1));
  const N = seg.length;
  for (let l = 0; l < acf.length; l++) acf[l] = acf[l] / Math.max(1, N - l);
  const a0 = acf[0] || 1;
  for (let l = 0; l < acf.length; l++) acf[l] /= a0;
  const scores: { bpm: number; score: number }[] = [];
  let best = 0;
  let bestBpm = 120;
  let sum = 0;
  for (let bpm = 55; bpm <= 215; bpm += 0.25) {
    const lag = (60 * fps) / bpm;
    let s = 0;
    const w = [1, 0.5, 0.33, 0.25];
    for (let k = 1; k <= 4; k++) {
      // take the max in a small neighbourhood to tolerate quantization
      const L = lag * k;
      s += w[k - 1] * Math.max(interp(acf, L - 0.5), interp(acf, L), interp(acf, L + 0.5));
    }
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const score = s * (0.35 + 0.65 * prior);
    scores.push({ bpm, score });
    sum += score;
    if (score > best) {
      best = score;
      bestBpm = bpm;
    }
  }
  const mean = sum / scores.length;
  const strength = Math.max(0, Math.min(1, (best / Math.max(1e-9, mean) - 1) / 1.5));
  return { bpm: bestBpm, strength, scores };
}

/** Ellis (2007) dynamic programming beat tracker. Returns beat frame indices (float). */
export function trackBeats(env: Float32Array, fps: number, bpm: number, tightness = 100, from = 0, to = env.length): number[] {
  const period = (60 * fps) / bpm;
  const n = to - from;
  if (n < period * 4) return [];
  // smooth onset with a gaussian of width period/32
  const sigma = Math.max(1, period / 32);
  const radius = Math.ceil(sigma * 3);
  const kern = new Float64Array(radius * 2 + 1);
  for (let i = -radius; i <= radius; i++) kern[i + radius] = Math.exp(-0.5 * (i / sigma) ** 2);
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = from + i + k;
      if (j >= from && j < to) s += env[j] * kern[k + radius];
    }
    local[i] = s;
  }
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  const penalty = new Float64Array(hi + 1);
  for (let d = lo; d <= hi; d++) penalty[d] = -tightness * Math.log(d / period) ** 2;
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = lo; d <= hi; d++) {
      const j = i - d;
      if (j < 0) break;
      const v = cum[j] + penalty[d];
      if (v > best) {
        best = v;
        arg = j;
      }
    }
    if (arg >= 0 && best > 0) {
      cum[i] = local[i] + best;
      back[i] = arg;
    } else {
      cum[i] = local[i];
    }
  }
  // pick the best end point within the last period
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) {
    if (cum[i] > bestEnd) {
      bestEnd = cum[i];
      end = i;
    }
  }
  const beats: number[] = [];
  for (let i = end; i >= 0; i = back[i]) {
    beats.push(i + from);
    if (back[i] < 0) break;
  }
  beats.reverse();
  // trim weak beats at the edges (silence)
  const med = median(beats.map((b) => local[b - from]));
  while (beats.length && local[beats[0] - from] < med * 0.1) beats.shift();
  while (beats.length && local[beats[beats.length - 1] - from] < med * 0.1) beats.pop();
  return beats;
}

export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface GridFit {
  t0: number;
  period: number;
  jitterMs: number;
  outlierShare: number;
}

/** Least squares fit t_i = t0 + i * period. */
export function fitGrid(times: number[]): GridFit {
  const n = times.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += times[i];
    sxx += i * i;
    sxy += i * times[i];
  }
  const period = (n * sxy - sx * sy) / Math.max(1e-9, n * sxx - sx * sx);
  const t0 = (sy - period * sx) / n;
  let ss = 0;
  let out = 0;
  for (let i = 0; i < n; i++) {
    const r = times[i] - (t0 + i * period);
    ss += r * r;
    if (Math.abs(r) > 0.04) out++;
  }
  return { t0, period, jitterMs: Math.sqrt(ss / Math.max(1, n)) * 1000, outlierShare: out / Math.max(1, n) };
}

export interface RobustGrid extends GridFit {
  inlierShare: number;
}

/** Fits the pulse directly to onset energy, independently of the DP path.
 * Syncopated drums can pull DP onto an irregular sequence despite a strong
 * constant pulse. Cross-beat energy and measured attack support guard this fit.
 */
export function fitOnsetGrid(o: OnsetEnvelope, start: number, end: number, bpm: number) {
  const env = o.lowMid;
  const from = Math.max(0, (start - o.t0) * o.fps);
  const to = Math.min(env.length - 2, (end - o.t0) * o.fps);
  const at = (p: number) => {
    const i = Math.round(p);
    return Math.max(env[i - 1] ?? 0, env[i] ?? 0, env[i + 1] ?? 0);
  };
  let best = { score: -Infinity, period: 60 / bpm, t0: start, on: 0, off: 0 };
  const step = Math.max(0.01, 60 / Math.max(16, end - start) / 100);
  for (let b = bpm * 0.985; b <= bpm * 1.015 + step / 2; b += step) {
    const period = 60 * o.fps / b;
    for (let phase = 0; phase < period; phase += 1) {
      let on = 0, off = 0, n = 0;
      for (let p = from + phase; p < to - period; p += period) {
        on += at(p);
        off += (at(p + period * 0.25) + at(p + period * 0.5) + at(p + period * 0.75)) / 3;
        n++;
      }
      const score = (on - off * 0.6) / Math.max(1, n);
      if (score > best.score) best = { score, period: period / o.fps, t0: (from + phase) / o.fps + o.t0, on: on / Math.max(1,n), off: off / Math.max(1,n) };
    }
  }
  let supported = 0, count = 0, ss = 0;
  const windowSeconds=12;
  const windows=Array.from({length:Math.max(1,Math.ceil((end-start)/windowSeconds))},()=>({supported:0,count:0,energy:0,frames:0}));
  for(let f=Math.ceil(from);f<to;f++){
    const w=Math.min(windows.length-1,Math.floor((f/o.fps+o.t0-start)/windowSeconds));
    if(w>=0){windows[w].energy+=env[f];windows[w].frames++;}
  }
  const radius = Math.max(1, Math.round(o.fps * 0.028));
  for (let t = best.t0; t < end - best.period; t += best.period) {
    const center = Math.round((t - o.t0) * o.fps);
    let peak = 0, offset = 0;
    for (let d = -radius; d <= radius; d++) if ((env[center + d] ?? 0) > peak) { peak = env[center + d]; offset = d; }
    count++;
    const w=windows[Math.min(windows.length-1,Math.max(0,Math.floor((t-start)/windowSeconds)))];
    w.count++;
    if (peak > Math.max(0.7, best.on * 0.32)) { supported++;w.supported++;ss += (offset / o.fps) ** 2; }
  }
  const support = supported / Math.max(1, count);
  const contrast = Math.max(0, (best.on - best.off) / Math.max(0.01, best.on));
  const jitterMs = Math.sqrt(ss / Math.max(1, supported)) * 1000;
  const confidence = Math.max(0, Math.min(1, support * 0.65 + contrast * 0.35));
  // A majority fit can hide a tempo change near the ending, precisely where
  // mixing needs a reliable grid. Check active regions independently; a quiet
  // drumless breakdown is allowed to have no supported attacks.
  const active=windows.filter(w=>w.count>=4&&w.energy/Math.max(1,w.frames)>Math.max(0.05,best.on*0.025));
  const regionalSupport=active.length?active.filter(w=>w.supported/w.count>=0.5).length/active.length:0;
  const tailSupported=active.length>0&&active[active.length-1].supported/active[active.length-1].count>=0.5;
  const stable = count >= 12 && support >= 0.6 && contrast >= 0.22 && best.on >= 1 && jitterMs < 22 && regionalSupport>=0.75 && tailSupported;
  return { t0: best.t0, period: best.period, support, contrast, jitterMs, confidence, regionalSupport, stable };
}

/**
 * Constant-tempo grid fit that tolerates missing or extra beats (breakdowns,
 * fills): each beat gets its grid index from the current period estimate, and
 * outliers are dropped before refitting.
 */
export function fitGridRobust(times: number[], approxPeriod: number): RobustGrid {
  // span over 8 beats averages out the frame quantization of single intervals
  const diffs: number[] = [];
  for (let i = 8; i < times.length; i++) {
    const d = (times[i] - times[i - 8]) / 8;
    if (d > approxPeriod * 0.8 && d < approxPeriod * 1.25) diffs.push(d);
  }
  const P0 = diffs.length ? median(diffs) : approxPeriod;
  let best: RobustGrid = { t0: times[0] ?? 0, period: P0, jitterMs: 999, outlierShare: 1, inlierShare: 0 };
  if (times.length < 4) return best;
  // several phase hypotheses: a fill or breakdown can shift the tracker by half a beat for a while
  const hyps = 12;
  for (let h = 0; h < hyps; h++) {
    const ref0 = times[Math.floor(((h + 0.5) / hyps) * times.length)];
    const g = fitFrom(times, ref0, P0);
    if (g.inlierShare > best.inlierShare + 1e-9 || (Math.abs(g.inlierShare - best.inlierShare) < 1e-9 && g.jitterMs < best.jitterMs)) best = g;
  }
  return best;
}

function fitFrom(times: number[], ref0: number, P0: number): RobustGrid {
  let P = P0;
  let ref = ref0;
  let use = times.map((t) => Math.abs(t - (ref + Math.round((t - ref) / P) * P)) < 0.035);
  let t0 = ref;
  let jit = 999;
  let share = 0;
  for (let iter = 0; iter < 8; iter++) {
    const byIdx = new Map<number, { t: number; r: number }>();
    for (let i = 0; i < times.length; i++) {
      if (!use[i]) continue;
      const k = Math.round((times[i] - ref) / P);
      const r = Math.abs(times[i] - (ref + k * P));
      const prev = byIdx.get(k);
      if (!prev || r < prev.r) byIdx.set(k, { t: times[i], r });
    }
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (const [k, v] of byIdx) {
      sx += k; sy += v.t; sxx += k * k; sxy += k * v.t; n++;
    }
    if (n < 4) break;
    const p = (n * sxy - sx * sy) / Math.max(1e-12, n * sxx - sx * sx);
    if (!(p > P0 * 0.9 && p < P0 * 1.1)) break;
    t0 = (sy - p * sx) / n;
    P = p;
    ref = t0;
    let ss = 0;
    let inl = 0;
    use = times.map((t) => {
      const k = Math.round((t - ref) / P);
      const r = t - (ref + k * P);
      const ok = Math.abs(r) < 0.035;
      if (ok) {
        ss += r * r;
        inl++;
      }
      return ok;
    });
    jit = Math.sqrt(ss / Math.max(1, inl)) * 1000;
    share = inl / Math.max(1, times.length);
  }
  return { t0, period: P, jitterMs: jit, outlierShare: 1 - share, inlierShare: share };
}

/**
 * Time-domain onset function at 1 kHz: positive slope of the smoothed log
 * energy. Used to place beats with ~1 ms precision independent of STFT latency.
 */
export function hiResOnset(input: Float32Array, sr: number, lowpassHz = 0): { rate: number; env: Float32Array } {
  let x = input;
  if (lowpassHz > 0) {
    x = new Float32Array(input);
    const c = lowpass(sr, lowpassHz, Math.SQRT1_2);
    new Biquad(c).processBuffer(x);
    new Biquad(c).processBuffer(x);
  }
  const hop = Math.round(sr / 1000);
  const rate = sr / hop;
  const n = Math.floor(x.length / hop);
  const env = new Float32Array(n);
  const a = Math.exp(-1 / (sr * 0.004));
  let e = 0;
  let prevLog = -12;
  for (let i = 0; i < n; i++) {
    let mx = 0;
    for (let j = i * hop, end = j + hop; j < end; j++) {
      const v = x[j] * x[j];
      e = a * e + (1 - a) * v;
      if (e > mx) mx = e;
    }
    const lg = Math.log10(mx + 1e-10);
    env[i] = Math.max(0, lg - prevLog);
    prevLog = lg;
  }
  return { rate, env };
}

function hiAt(h: { rate: number; env: Float32Array }, t: number, radius = 2): number {
  const c = Math.round(t * h.rate);
  let s = 0;
  for (let k = -radius; k <= radius; k++) s += h.env[c + k] ?? 0;
  return s;
}

/** Fine phase alignment of a constant grid against the high resolution onset. */
export function refineGridHiRes(h: { rate: number; env: Float32Array }, t0: number, period: number, kFrom: number, kTo: number): number {
  let best = 0;
  let bestS = -Infinity;
  for (let dt = -0.03; dt <= 0.03 + 1e-9; dt += 0.0005) {
    let s = 0;
    for (let k = kFrom; k <= kTo; k++) s += hiAt(h, t0 + dt + k * period);
    if (s > bestS) {
      bestS = s;
      best = dt;
    }
  }
  return t0 + best;
}

/** Snaps individual beats to the nearest strong attack within ±radius seconds. */
export function snapBeatsHiRes(h: { rate: number; env: Float32Array }, beats: number[], radius = 0.025): number[] {
  return beats.map((t) => {
    let best = t;
    let bestS = hiAt(h, t) * 0.9;
    for (let dt = -radius; dt <= radius + 1e-9; dt += 0.001) {
      const s = hiAt(h, t + dt);
      if (s > bestS) {
        bestS = s;
        best = t + dt;
      }
    }
    return best;
  });
}

/** Onset value at time t (seconds), interpolated. */
export function onsetAt(o: OnsetEnvelope, arr: Float32Array, t: number): number {
  return interp(arr, (t - o.t0) * o.fps);
}

/**
 * Refines phase and period of a constant grid by maximizing onset energy on the grid.
 */
export function refineGrid(o: OnsetEnvelope, t0: number, period: number, kFrom: number, kTo: number): { t0: number; period: number } {
  let best = { t0, period, s: -Infinity };
  for (let dp = -0.002; dp <= 0.002 + 1e-12; dp += 0.0005) {
    const p = period * (1 + dp);
    for (let dt = -0.02; dt <= 0.02 + 1e-12; dt += 0.001) {
      let s = 0;
      for (let i = kFrom; i <= kTo; i += 1) s += onsetAt(o, o.env, t0 + dt + i * p);
      if (s > best.s) best = { t0: t0 + dt, period: p, s };
    }
  }
  return { t0: best.t0, period: best.period };
}
