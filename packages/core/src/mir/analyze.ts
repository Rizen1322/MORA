import {
  ANALYZER_VERSION,
  CURVE_RATE,
  type BeatAccents,
  type BeatGrid,
  type CueCandidate,
  type KeyInfo,
  type LoudnessInfo,
  type TrackAnalysis,
  type TrackFeatures,
} from '../types.ts';
import { estimateKey } from './key.ts';
import { beatAttacks } from './attacks.ts';
import { ANALYSIS_RATE, computeSpectral, powerDb, toCurve, type SpectralData } from './spectral.ts';
import { detectSections } from './structure.ts';
import { analyzeStructure } from './repetition.ts';
import { detectBeatRegions } from './regions.ts';
import { Biquad, BUTTERWORTH_Q, highpass, lowpass } from '../dsp/biquad.ts';
import {
  estimateTempo,
  fitGridRobust,
  fitOnsetGrid,
  hiResOnset,
  median,
  onsetAt,
  onsetEnvelope,
  refineGrid,
  refineGridHiRes,
  snapBeatsHiRes,
  trackBeats,
  type OnsetEnvelope,
} from './tempo.ts';

export interface AnalyzeInput {
  /** Mono PCM at ANALYSIS_RATE (22050 Hz). */
  mono: Float32Array;
  loudness: LoudnessInfo;
  /** Duration of the original file, seconds. */
  duration: number;
  /** Mean power of the side channel per CURVE_RATE window: total and below 150 Hz. */
  side?: { power: Float32Array; low: Float32Array };
}

export interface AnalyzeOptions {
  onProgress?: (p: number, stage: string) => void;
  /** Throw from inside to abort; checked between stages. */
  checkCancel?: () => void;
}

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));

function percentile(a: ArrayLike<number>, p: number): number {
  const s = Array.from(a).sort((x, y) => x - y);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))];
}

function smooth(a: number[], radius: number): number[] {
  const out = new Array<number>(a.length);
  let s = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < a.length; i++) {
    while (hi < Math.min(a.length - 1, i + radius)) s += a[++hi];
    while (lo < i - radius) s -= a[lo++];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

function curveAt(curve: number[], t: number): number {
  const i = Math.round(t * CURVE_RATE);
  return curve[Math.max(0, Math.min(curve.length - 1, i))] ?? 0;
}

function curveMean(curve: number[], a: number, b: number): number {
  const i0 = Math.max(0, Math.floor(a * CURVE_RATE));
  const i1 = Math.min(curve.length, Math.max(i0 + 1, Math.ceil(b * CURVE_RATE)));
  let s = 0;
  for (let i = i0; i < i1; i++) s += curve[i];
  return i1 > i0 ? s / (i1 - i0) : 0;
}

function chromaMean(sp: SpectralData, t0: number, a: number, b: number): number[] {
  const out = new Array<number>(12).fill(0);
  const i0 = Math.max(0, Math.floor((a - t0) * sp.chromaFps));
  const i1 = Math.min(sp.chromaFrames, Math.max(i0 + 1, Math.ceil((b - t0) * sp.chromaFps)));
  for (let i = i0; i < i1; i++) for (let k = 0; k < 12; k++) out[k] += sp.chroma[i * 12 + k];
  const n = Math.max(1, i1 - i0);
  for (let k = 0; k < 12; k++) out[k] /= n;
  return out;
}

/** Per-second local key (8 s chroma window, the existing FFT) and onset peak density (2 s).
 * A window key is a local profile, not a calibrated probability; low confidence stays ''. */
export function localFeatures(sp: SpectralData, onset: { fps: number; t0: number; env: Float32Array }, duration: number): NonNullable<TrackAnalysis['local']> {
  const n = Math.max(1, Math.ceil(duration));
  const camelot: string[] = [], keyConfidence: number[] = [], transients: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = estimateKey(chromaMean(sp, onset.t0, i + 0.5 - 4, i + 0.5 + 4));
    camelot.push(k.confidence >= 0.15 ? k.camelot : '');
    keyConfidence.push(Math.round(k.confidence * 100) / 100);
    const f0 = Math.max(1, Math.floor((i - 0.5 - onset.t0) * onset.fps)), f1 = Math.min(onset.env.length - 1, Math.ceil((i + 1.5 - onset.t0) * onset.fps));
    let peaks = 0;
    for (let f = f0; f < f1; f++) { const v = onset.env[f]; if (v > 1.5 && v > onset.env[f - 1] && v >= onset.env[f + 1]) peaks++; }
    transients.push(Math.round(clamp(peaks / 2 / 8) * 100) / 100);
  }
  return { rate: 1, camelot, keyConfidence, transients };
}

function cosine(a: number[], b: number[]): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / Math.sqrt(Math.max(1e-12, na * nb));
}

type Envelope = { rate: number; env: Float32Array };
/** 1 kHz amplitude envelopes (10 ms smoothing) of the kick band (<150 Hz) and the snare/clap
 * band (1-4 kHz). Linear, unlike the log onset: a loud snare outweighs a 3 ms kick click. */
export function drumEnvelopes(mono: Float32Array, sr = ANALYSIS_RATE): { kick: Envelope; snare: Envelope } {
  const band = (cs: ReturnType<typeof lowpass>[]): Envelope => {
    const x = new Float32Array(mono);
    for (const c of cs) new Biquad(c).processBuffer(x);
    const hop = Math.round(sr / 1000), env = new Float32Array(Math.floor(x.length / hop)), a = Math.exp(-1 / (sr * 0.01));
    let e = 0;
    for (let i = 0; i < env.length; i++) {
      for (let j = i * hop, end = j + hop; j < end; j++) e = a * e + (1 - a) * x[j] * x[j];
      env[i] = Math.sqrt(e);
    }
    return { rate: sr / hop, env };
  };
  const lp = lowpass(sr, 150, BUTTERWORTH_Q), hp = highpass(sr, 1000, BUTTERWORTH_Q), lp4 = lowpass(sr, 4000, BUTTERWORTH_Q);
  return { kick: band([lp, lp]), snare: band([hp, hp, lp4, lp4]) };
}

/** Rise of each band's envelope at each beat (peak in -15..+40 ms over the mean in -90..-25 ms),
 * relative to the band's median rise over the grid. */
export function beatAccents(drums: { kick: Envelope; snare: Envelope }, beats: number[]): BeatAccents {
  const at = (h: Envelope, t: number) => {
    const c = Math.round(t * h.rate), ms = h.rate / 1000;
    let peak = 0, base = 0, n = 0;
    for (let k = Math.round(-15 * ms); k <= Math.round(40 * ms); k++) peak = Math.max(peak, h.env[c + k] ?? 0);
    for (let k = Math.round(-90 * ms); k <= Math.round(-25 * ms); k++) { base += h.env[c + k] ?? 0; n++; }
    return Math.max(0, peak - base / n);
  };
  const norm = (v: number[]) => { const m = median(v.filter((x) => x > 0)) || 1; return v.map((x) => Math.round((x / m) * 100) / 100); };
  return { kick: norm(beats.map((t) => at(drums.kick, t))), snare: norm(beats.map((t) => at(drums.snare, t))) };
}

export function analyzeTrack(input: AnalyzeInput, opts: AnalyzeOptions = {}): TrackAnalysis {
  const started = Date.now();
  const progress = opts.onProgress ?? (() => {});
  const cancel = opts.checkCancel ?? (() => {});
  const warnings: string[] = [];
  const { mono } = input;
  const duration = input.duration || mono.length / ANALYSIS_RATE;

  progress(0.05, 'spectrum');
  const sp = computeSpectral(mono, ANALYSIS_RATE);
  cancel();
  progress(0.45, 'curves');

  const nCurve = sp.rmsDb.length;
  // Stereo energy = mid + side power (B2). The side low band comes from a biquad, the mid one from
  // Hann-windowed FFT bins, which read an in-band tone 1.25 dB lower: the side is scaled to match.
  const side = input.side;
  const plus = (dbValue: number, p: number | undefined) => (p ? powerDb(10 ** (dbValue / 10) + p) : dbValue);
  const rmsDb = Array.from(sp.rmsDb, (v, c) => Math.max(-90, plus(v, side?.power[c])));
  const midLow = toCurve(sp.powLow, sp.fps, nCurve, ANALYSIS_RATE);
  const lowDb = midLow.map((v, c) => Math.max(-90, powerDb(v + (side?.low[c] ?? 0) * 0.75)));
  const midDb = toCurve(sp.powMid, sp.fps, nCurve, ANALYSIS_RATE, (v) => Math.max(-90, powerDb(v)));
  const highDb = toCurve(sp.powHigh, sp.fps, nCurve, ANALYSIS_RATE, (v) => Math.max(-90, powerDb(v)));
  const midDensityRaw = toCurve(sp.midDensity, sp.fps, nCurve);
  const midDensity = smooth(midDensityRaw, Math.round(CURVE_RATE * 0.5));
  let peakMax = 1e-6;
  for (const peak of sp.peaks) peakMax = Math.max(peakMax, peak);
  const peaks = Array.from(sp.peaks, (v) => Math.round((v / peakMax) * 1000) / 1000);

  // ---- silence / audible region
  const loud = percentile(rmsDb, 0.95);
  const thr = Math.max(-60, loud - 40);
  let first = -1;
  let last = -1;
  for (let i = 0; i < nCurve - 1; i++) if (rmsDb[i] > thr && rmsDb[i + 1] > thr) { first = i; break; }
  for (let i = nCurve - 1; i > 0; i--) if (rmsDb[i] > thr && rmsDb[i - 1] > thr) { last = i; break; }
  const silent = first < 0 || loud < -65;
  const audibleStart = silent ? 0 : first / CURVE_RATE;
  const audibleEnd = silent ? duration : Math.min(duration, (last + 1) / CURVE_RATE);
  if (silent) warnings.push('silent');
  if (duration < 30) warnings.push('short');

  const body = silent ? -90 : median(rmsDb.slice(Math.floor(audibleStart * CURVE_RATE), Math.ceil(audibleEnd * CURVE_RATE)));
  const smoothRms = smooth(rmsDb, CURVE_RATE * 2);

  // ---- tempo and beats
  progress(0.55, 'tempo');
  const onset = onsetEnvelope(sp);
  const fA = Math.max(0, Math.floor((audibleStart - onset.t0) * onset.fps));
  const fB = Math.min(onset.env.length, Math.ceil((audibleEnd - onset.t0) * onset.fps));
  let beat: BeatGrid | null = null;
  let beatRegions: TrackAnalysis['beatRegions'] = [];
  let rhythmStrength = 0;
  if (!silent && fB - fA > onset.fps * 6) {
    const hi = hiResOnset(mono, ANALYSIS_RATE, 220);
    beat = buildBeatGrid(onset, hi, fA, fB, audibleStart, audibleEnd, sp, warnings);
    rhythmStrength = beat ? beat.confidence : 0;
    if (beat && beat.confidence < 0.22) {
      warnings.push('weak-pulse');
      beat = null;
    }
    beatRegions = detectBeatRegions(onset, audibleStart, audibleEnd, beat, hi, cancel);
    const drums = drumEnvelopes(mono);
    if (beat) beat = { ...beat, accents: beatAccents(drums, beat.beats), attacks: beatAttacks(hi, beat.beats) };
    beatRegions = beatRegions.map((r) => ({ ...r, accents: beatAccents(drums, r.beats) }));
  }
  cancel();

  // ---- key
  progress(0.75, 'key');
  let key: KeyInfo = { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 };
  if (!silent) key = estimateKey(chromaMean(sp, onset.t0, audibleStart, audibleEnd));
  const local = silent ? undefined : localFeatures(sp, onset, duration);

  // ---- structure
  progress(0.85, 'structure');
  let phrases: number[] = [];
  let phraseConfidence = 0;
  let sectionBoundaries: number[] = [];
  if (beat && beat.downbeats.length >= 8) {
    const st = phraseStructure(beat, sp, onset.t0, { rmsDb, lowDb, midDb, highDb, midDensity });
    phrases = st.phrases;
    phraseConfidence = st.confidence;
    sectionBoundaries = st.sections;
  }
  const sections = detectSections({ rate: CURVE_RATE, rmsDb, lowDb, midDb, highDb, midDensity }, audibleStart, audibleEnd, beat, sectionBoundaries);
  sectionBoundaries = sections.slice(1).map((section) => section.start);
  const structure = silent ? null : analyzeStructure({ sp, rmsDb, curveRate: CURVE_RATE, start: audibleStart, end: audibleEnd, body, beat, boundaries: sectionBoundaries });
  cancel();

  const bars = beat?.downbeats ?? [];
  const snapBar = (t: number) => (bars.length ? bars.reduce((p, c) => (Math.abs(c - t) < Math.abs(p - t) ? c : p), bars[0]) : t);
  let introEnd = audibleStart;
  for (let i = Math.floor(audibleStart * CURVE_RATE); i < smoothRms.length; i++) {
    if (smoothRms[i] >= body - 3) { introEnd = i / CURVE_RATE; break; }
  }
  introEnd = Math.min(introEnd, audibleStart + (audibleEnd - audibleStart) * 0.35);
  let outroStart = audibleEnd;
  for (let i = Math.min(smoothRms.length - 1, Math.floor(audibleEnd * CURVE_RATE)); i >= 0; i--) {
    if (smoothRms[i] >= body - 3) { outroStart = i / CURVE_RATE; break; }
  }
  outroStart = Math.max(outroStart, audibleStart + (audibleEnd - audibleStart) * 0.6);
  const intro = { start: audibleStart, end: bars.length ? snapBar(introEnd) : introEnd };
  const outro = { start: bars.length ? snapBar(outroStart) : outroStart, end: audibleEnd };

  const cues = findCues({
    duration, audibleStart, audibleEnd, beat, phrases, phraseConfidence, sectionBoundaries,
    rmsDb: smoothRms, midDensity, intro, outro, body,
  });

  // ---- features for recommendations
  let onsetCount = 0;
  for (let i = fA + 1; i < fB - 1; i++) {
    const v = onset.env[i];
    if (v > 1.5 && v > onset.env[i - 1] && v >= onset.env[i + 1]) onsetCount++;
  }
  const audibleLen = Math.max(1, audibleEnd - audibleStart);
  const onsetRate = onsetCount / audibleLen;
  const meanPow = (a: Float32Array) => {
    let s = 0;
    for (let i = fA; i < fB; i++) s += a[i];
    return s / Math.max(1, fB - fA);
  };
  const pl = meanPow(sp.powLow);
  const pm = meanPow(sp.powMid);
  const ph = meanPow(sp.powHigh);
  const ptot = pl + pm + ph + 1e-12;
  const cent = (() => {
    let s = 0;
    for (let i = fA; i < fB; i++) s += sp.centroid[i];
    return s / Math.max(1, fB - fA);
  })();
  const lufs = input.loudness.integratedLufs;
  const p95 = percentile(rmsDb.slice(Math.floor(audibleStart * CURVE_RATE), Math.ceil(audibleEnd * CURVE_RATE)), 0.95);
  const p10 = percentile(rmsDb.slice(Math.floor(audibleStart * CURVE_RATE), Math.ceil(audibleEnd * CURVE_RATE)), 0.1);
  const features: TrackFeatures = {
    energy: clamp(0.35 * clamp(onsetRate / 6) + 0.25 * clamp((ph / ptot) / 0.12) + 0.2 * rhythmStrength + 0.2 * clamp((lufs + 22) / 16)),
    brightness: clamp((cent - 600) / 3000),
    rhythmStrength,
    onsetRate: clamp(onsetRate / 8),
    bassWeight: clamp((pl / ptot) / 0.6),
    midDensity: clamp(midDensity.reduce((a, b) => a + b, 0) / Math.max(1, midDensity.length) / 0.6),
    dynamics: clamp((p95 - p10) / 30),
    acousticness: clamp((1 - rhythmStrength) * 0.6 + (1 - clamp((ph / ptot) / 0.12)) * 0.4),
  };

  progress(1, 'done');
  return {
    version: ANALYZER_VERSION,
    duration,
    audibleStart,
    audibleEnd,
    loudness: input.loudness,
    beat,
    beatRegions,
    rhythmStrength,
    key,
    phrases,
    phraseConfidence,
    sectionBoundaries,
    sections,
    ...(structure ? { structure } : {}),
    intro,
    outro,
    bodyRmsDb: body,
    curves: {
      rate: CURVE_RATE,
      rmsDb: rmsDb.map((v) => Math.round(v * 10) / 10),
      lowDb: lowDb.map((v) => Math.round(v * 10) / 10),
      midDb: midDb.map((v) => Math.round(v * 10) / 10),
      highDb: highDb.map((v) => Math.round(v * 10) / 10),
      midDensity: midDensity.map((v) => Math.round(v * 1000) / 1000),
    },
    ...(local ? { local } : {}),
    peaks,
    cues,
    features,
    warnings,
    elapsedMs: Date.now() - started,
  };
}

function buildBeatGrid(
  onset: OnsetEnvelope,
  hi: { rate: number; env: Float32Array },
  fA: number,
  fB: number,
  audibleStart: number,
  audibleEnd: number,
  sp: SpectralData,
  warnings: string[],
): BeatGrid | null {
  const fps = onset.fps;
  const tempo = estimateTempo(onset.env, fps, fA, fB);
  let bpm = tempo.bpm;

  // window consistency (octave-equivalent agreement)
  const win = Math.round(fps * 20);
  let agree = 0;
  let total = 0;
  for (let s = fA; s + win <= fB; s += Math.round(win / 2)) {
    const w = estimateTempo(onset.env, fps, s, s + win).bpm;
    const r = w / bpm;
    const ok = [0.5, 1, 2, 1.5, 2 / 3].some((m) => Math.abs(r / m - 1) < 0.025);
    if (ok) agree++;
    total++;
  }
  const consistency = total ? agree / total : 0.5;

  // octave decision using kick/snare onsets on and between beats
  const testOctave = (b: number) => {
    const beatsF = trackBeats(onset.env, fps, b, 100, fA, fB);
    if (beatsF.length < 8) return 0;
    let on = 0;
    let off = 0;
    for (let i = 0; i + 1 < beatsF.length; i++) {
      on += onset.lowMid[beatsF[i]] ?? 0;
      off += onset.lowMid[Math.round((beatsF[i] + beatsF[i + 1]) / 2)] ?? 0;
    }
    return off / Math.max(1e-9, on);
  };
  const offRatio = testOctave(bpm);
  const alternatives = [
    { bpm: bpm / 2, score: 0 },
    { bpm, score: 1 },
    { bpm: bpm * 2, score: 0 },
  ];
  if ((offRatio > 0.45 && bpm * 2 <= 190) || bpm < 70) {
    alternatives[2].score = 1.1;
    bpm *= 2;
    warnings.push('tempo-doubled');
  }

  const beatFrames = trackBeats(onset.env, fps, bpm, 100, fA, fB);
  if (beatFrames.length < 8) return null;
  let times = beatFrames.map((f) => f / fps + onset.t0);
  let fit = fitGridRobust(times, 60 / bpm);
  if (tempo.strength >= 0.45 && (fit.inlierShare < 0.65 || fit.jitterMs > 18)) {
    const direct = fitOnsetGrid(onset, audibleStart, audibleEnd, bpm);
    if (direct.stable) {
      fit = { t0: direct.t0, period: direct.period, jitterMs: direct.jitterMs, inlierShare: direct.support, outlierShare: 1 - direct.support };
      times = [];
      for (let t = direct.t0; t <= audibleEnd; t += direct.period) times.push(t);
      warnings.push('syncopated-grid-recovered');
    }
  }
  // breakdowns without drums leave the tracker wandering; what matters is that
  // the beats we do hear sit on one constant grid spanning the track
  const inlierTimes = times.filter((t) => Math.abs(t - (fit.t0 + Math.round((t - fit.t0) / fit.period) * fit.period)) < 0.035);
  const span = inlierTimes.length ? inlierTimes[inlierTimes.length - 1] - inlierTimes[0] : 0;
  const coverage = span / Math.max(1, audibleEnd - audibleStart);
  // produced music sits on a DAW grid; swing and loose tracking widen the jitter a little
  const stable = (fit.jitterMs < 15 || (fit.jitterMs < 24 && fit.inlierShare >= 0.7)) && fit.inlierShare >= 0.6 && inlierTimes.length >= 16 && coverage > 0.6;
  let period = fit.period;
  if (stable) {
    let kFrom = Math.ceil((audibleStart - fit.t0) / period - 0.01);
    let kTo = Math.floor((audibleEnd - fit.t0) / period);
    const ref = refineGrid(onset, fit.t0, fit.period, kFrom, kTo);
    period = ref.period;
    const t0 = refineGridHiRes(hi, ref.t0, period, kFrom, kTo);
    kFrom = Math.ceil((audibleStart - t0) / period - 0.01);
    kTo = Math.floor((audibleEnd - t0) / period);
    times = [];
    for (let k = kFrom; k <= kTo; k++) times.push(t0 + k * period);
  } else {
    times = snapBeatsHiRes(hi, times);
    const diffs = [];
    for (let i = 1; i < times.length; i++) diffs.push(times[i] - times[i - 1]);
    period = median(diffs);
  }
  if (times.length < 8) return null;

  // salience: share of beats sitting on above-median onset strength
  const envSlice = Array.from(onset.env.subarray(fA, fB));
  const med = median(envSlice);
  let strong = 0;
  for (const t of times) if (onsetAt(onset, onset.env, t) > med * 1.5) strong++;
  const salience = strong / times.length;
  let confidence = clamp(0.5 * tempo.strength + 0.25 * clamp((salience - 0.3) / 0.5) + 0.25 * consistency);
  // weak periodicity cannot be rescued by the other cues
  if (tempo.strength < 0.4) confidence *= tempo.strength / 0.4;
  if (!stable) confidence *= 0.75;

  // downbeat phase: harmonic change + kick emphasis + level change at bar starts
  const beatChroma = times.map((t, i) => chromaMean(sp, onset.t0, t, times[i + 1] ?? t + period));
  const change = beatChroma.map((c, i) => (i === 0 ? 0 : 1 - cosine(beatChroma[i - 1], c)));
  const lowAt = times.map((t) => onsetAt(onset, onset.low, t));
  const norm = (a: number[]) => {
    const m = a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    return a.map((v) => v / (m || 1));
  };
  const nChange = norm(change);
  const nLow = norm(lowAt);
  const phaseScores = [0, 1, 2, 3].map((p) => {
    let s = 0;
    let n = 0;
    for (let i = p; i < times.length; i += 4) {
      s += nChange[i] * 0.6 + nLow[i] * 0.4;
      n++;
    }
    return s / Math.max(1, n);
  });
  const order = [...phaseScores].map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s);
  const phase = order[0].i;
  const dbConf = clamp(((order[0].s - order[1].s) / Math.max(1e-9, order[0].s)) * 4);
  const downbeats: number[] = [];
  for (let i = phase; i < times.length; i += 4) downbeats.push(times[i]);

  return {
    bpm: Math.round((60 / period) * 100) / 100,
    confidence,
    period,
    stable,
    jitterMs: Math.round(fit.jitterMs * 10) / 10,
    beats: times.map((t) => Math.round(t * 10000) / 10000),
    downbeats: downbeats.map((t) => Math.round(t * 10000) / 10000),
    downbeatConfidence: dbConf,
    downbeatPhase: phase,
    alternatives: alternatives.map((a) => ({ bpm: Math.round(a.bpm * 100) / 100, score: a.score })),
  };
}

interface Curves {
  rmsDb: number[];
  lowDb: number[];
  midDb: number[];
  highDb: number[];
  midDensity: number[];
}

function phraseStructure(beat: BeatGrid, sp: SpectralData, t0: number, c: Curves) {
  const bars = beat.downbeats;
  const nb = bars.length;
  const barLen = beat.period * 4;
  const feats = bars.map((b) => {
    const e = b + barLen;
    return {
      v: [curveMean(c.rmsDb, b, e), curveMean(c.lowDb, b, e), curveMean(c.midDb, b, e), curveMean(c.highDb, b, e)],
      d: curveMean(c.midDensity, b, e),
      ch: chromaMean(sp, t0, b, e),
    };
  });
  const novelty = new Array<number>(nb).fill(0);
  const W = 4;
  for (let j = 1; j < nb; j++) {
    const a0 = Math.max(0, j - W);
    const b1 = Math.min(nb, j + W);
    const avg = (from: number, to: number) => {
      const v = [0, 0, 0, 0];
      const ch = new Array<number>(12).fill(0);
      let d = 0;
      for (let k = from; k < to; k++) {
        for (let q = 0; q < 4; q++) v[q] += feats[k].v[q];
        for (let q = 0; q < 12; q++) ch[q] += feats[k].ch[q];
        d += feats[k].d;
      }
      const n = Math.max(1, to - from);
      return { v: v.map((x) => x / n), ch, d: d / n };
    };
    const L = avg(a0, j);
    const R = avg(j, b1);
    let dist = 0;
    for (let q = 0; q < 4; q++) dist += Math.abs(L.v[q] - R.v[q]) / 10;
    dist += 2 * (1 - cosine(L.ch, R.ch));
    dist += 3 * Math.abs(L.d - R.d);
    novelty[j] = dist;
  }
  const scores = [];
  for (let o = 0; o < 8; o++) {
    let s = 0;
    let n = 0;
    for (let j = o; j < nb; j += 8) {
      s += novelty[j];
      n++;
    }
    scores.push({ o, s: (s / Math.max(1, n)) * (o === 0 ? 1.08 : 1) });
  }
  scores.sort((a, b) => b.s - a.s);
  const best = scores[0];
  const conf = clamp(((best.s - scores[1].s) / Math.max(1e-9, best.s)) * 3) * Math.sqrt(beat.downbeatConfidence || 0.3);
  const phrases: number[] = [];
  for (let j = best.o; j < nb; j += 8) phrases.push(bars[j]);
  const mean = novelty.reduce((a, b) => a + b, 0) / Math.max(1, nb);
  const sd = Math.sqrt(novelty.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, nb));
  const sections: number[] = [];
  for (let j = 1; j < nb - 1; j++) {
    if (novelty[j] > mean + sd && novelty[j] >= novelty[j - 1] && novelty[j] >= novelty[j + 1]) sections.push(bars[j]);
  }
  return { phrases, confidence: conf, sections };
}

interface CueInput {
  duration: number;
  audibleStart: number;
  audibleEnd: number;
  beat: BeatGrid | null;
  phrases: number[];
  phraseConfidence: number;
  sectionBoundaries: number[];
  rmsDb: number[];
  midDensity: number[];
  intro: { start: number; end: number };
  outro: { start: number; end: number };
  body: number;
}

function findCues(c: CueInput): { entry: CueCandidate[]; exit: CueCandidate[] } {
  const exit: CueCandidate[] = [];
  const entry: CueCandidate[] = [];
  const len = c.audibleEnd - c.audibleStart;
  const usePhrases = c.beat && c.phrases.length >= 2 && c.phraseConfidence >= 0.2;
  const sectionSet = new Set(c.sectionBoundaries.map((t) => Math.round(t * 10)));
  let points: { t: number; kind: CueCandidate['kind'] }[] = [];
  if (c.beat) {
    const bars = c.beat.downbeats;
    const phraseSet = new Set(c.phrases.map((t) => Math.round(t * 1000)));
    for (let i = 0; i < bars.length; i++) {
      const isPhrase = phraseSet.has(Math.round(bars[i] * 1000));
      if (isPhrase) points.push({ t: bars[i], kind: 'phrase' });
      else if (sectionSet.has(Math.round(bars[i] * 10))) points.push({ t: bars[i], kind: 'section' });
      else if (!usePhrases && i % 4 === 0) points.push({ t: bars[i], kind: 'downbeat' });
      else if (i % 4 === 0) points.push({ t: bars[i], kind: 'downbeat' });
    }
  } else {
    for (let t = c.audibleStart; t < c.audibleEnd; t += 1) points.push({ t, kind: 'energy' });
  }

  const midAfter = (t: number, span: number) => curveMean(c.midDensity, t, t + span);
  const lvl = (a: number, b: number) => curveMean(c.rmsDb, a, b);
  const kindBonus = (k: CueCandidate['kind']) => (k === 'phrase' ? 1 : k === 'section' ? 0.85 : k === 'downbeat' ? 0.55 : 0.4);

  // exits: second half of the track, enough audio left for a blend
  for (const p of points) {
    const remaining = c.audibleEnd - p.t;
    if (p.t < c.audibleStart + len * 0.5 || remaining < 3) continue;
    const tags: string[] = [];
    const posScore = Math.exp(-0.5 * ((remaining - 26) / 16) ** 2);
    const drop = lvl(p.t - 8, p.t) - lvl(p.t, p.t + 8);
    const dropScore = clamp(drop / 6 + 0.5);
    if (drop > 2) tags.push('energy-drop');
    const dens = midAfter(p.t, 10);
    const densScore = 1 - clamp(dens / 0.5);
    if (dens < 0.15) tags.push('low-mid-density');
    if (p.t >= c.outro.start - 0.5) tags.push('outro');
    const score = clamp(0.35 * posScore + 0.2 * dropScore + 0.2 * densScore + 0.25 * kindBonus(p.kind) + (tags.includes('outro') ? 0.08 : 0));
    exit.push({ time: Math.round(p.t * 1000) / 1000, score, kind: p.kind, tags });
  }

  // entries: first part of the track, earliest preferred
  const firstBar = c.beat?.downbeats.find((t) => t >= c.audibleStart - 0.05);
  entry.push({ time: Math.round((firstBar ?? c.audibleStart) * 1000) / 1000, score: 0.76, kind: 'start', tags: [c.beat ? 'first-downbeat' : 'audible-start'] });
  // Retain actual novelty boundaries even without a reliable bar/phrase grid.
  for (const time of c.sectionBoundaries) {
    if (time > c.audibleStart + 3 && time <= c.audibleStart + Math.min(len * 0.45, 75)) {
      const before = lvl(Math.max(c.audibleStart, time - 6), time);
      const after = lvl(time, time + 6);
      const tags = ['structural-change'];
      if (after - before > 3) tags.push('energy-arrival');
      if (midAfter(time, 8) < 0.15) tags.push('low-mid-density');
      entry.push({ time, kind: 'section', score: clamp(0.62 + 0.18 * clamp((after - before) / 8) - 0.12 * (time - c.audibleStart) / 75), tags });
    }
  }
  if (c.beat) {
    for (const p of points) {
      if (p.t <= (firstBar ?? 0) + 0.01 || p.t > c.audibleStart + Math.min(len * 0.45, 75)) continue;
      if (entry.some((cue) => Math.abs(cue.time - p.t) < 0.03)) continue;
      const tags: string[] = [];
      const early = Math.exp(-(p.t - c.audibleStart) / 40);
      const dens = midAfter(p.t, 16);
      if (dens < 0.15) tags.push('low-mid-density');
      if (p.t <= c.intro.end) tags.push('intro');
      const score = clamp(0.32 * early + 0.24 * (1 - clamp(dens / 0.5)) + 0.3 * kindBonus(p.kind));
      entry.push({ time: Math.round(p.t * 1000) / 1000, score, kind: p.kind, tags });
    }
  }
  exit.sort((a, b) => b.score - a.score);
  entry.sort((a, b) => b.score - a.score);
  points = [];
  return { entry: entry.slice(0, 24), exit: exit.slice(0, 24) };
}
