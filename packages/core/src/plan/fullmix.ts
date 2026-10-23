import { camelotCompatibility } from '../mir/key.ts';
import { closureAt } from '../mir/repetition.ts';
import type { AutoMixSettings, AutomationLane, TrackAnalysis, TransitionPlan } from '../types.ts';
import { integrateTempo, linearPower, pointValue } from './timing.ts';

/**
 * Full-mix planning without separated voices (research: mobile-stemless-automix-research-2026-10-22).
 * A deck's voice is unknown without a vocal map or with stem mixing off. Unknown is a risk, never
 * measured silence: nothing here earns a bonus for "no vocals". Every measure below is a structure or
 * band-level estimate; none of them detects singing or the end of a lyric line.
 */
export const voiceUnknown = (an: TrackAnalysis | null | undefined, s: AutoMixSettings) => s.stemMixing === false || !an?.vocalActivity;
export const fullMixPair = (A: TrackAnalysis | null, B: TrackAnalysis | null, s: AutoMixSettings) => voiceUnknown(A, s) || voiceUnknown(B, s);

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const r3 = (x: number) => Math.round(x * 1000) / 1000;
type Deck = 'A' | 'B';

export function laneValue(p: TransitionPlan, deck: Deck, name: AutomationLane['lane'], t: number): number {
  return pointValue(p.automation.find(l => l.deck === deck && l.lane === name)?.points ?? [[0, name === 'filter' || name === 'echo' ? 0 : 1]], t);
}

/** Mean band powers (linear) of a deck around a source time, ±0.5 s: the one-second scale of P4. */
function bands(an: TrackAnalysis, src: number): [number, number, number] | null {
  const c = an.curves, rate = c.rate;
  if (!(rate > 0)) return null;
  const lo = Math.max(0, Math.floor((src - 0.5) * rate)), hi = Math.min(c.lowDb.length, Math.ceil((src + 0.5) * rate));
  if (hi <= lo) return null;
  const out: [number, number, number] = [0, 0, 0];
  const lin = [linearPower(c.lowDb), linearPower(c.midDb), linearPower(c.highDb)];
  for (let i = lo; i < hi; i++) {
    if (!(Number.isFinite(c.lowDb[i]) && Number.isFinite(c.midDb[i]) && Number.isFinite(c.highDb[i]))) return null;
    for (let k = 0; k < 3; k++) out[k] += lin[k][i];
  }
  return out.map(x => x / (hi - lo)) as [number, number, number];
}

// sample points inside the analysis bands (low < 150 Hz, mid 150-2500 Hz, high above; spectral.ts)
const LOW_HZ = [50, 80, 120], MID_HZ = [250, 700, 1800], HIGH_HZ = [3500, 6000, 9000];

/** Mean power gain of the DJ filter over a band's sample points, as StereoSweep (dsp/sweep.ts) does it:
 * + is a high-pass, - a low-pass, 12 dB/oct at an exponential cutoff, dry/wet below 0.08. The three
 * bands cannot give the exact loss on a real spectrum; the render check measures that. */
export function sweepPower(v: number, hz: readonly number[]): number {
  const a = clamp(Math.abs(v));
  if (a < 1e-6) return 1;
  const upper = 48000 * 0.45, fc = v > 0 ? 20 * Math.exp(Math.log(300) * a) : upper * Math.exp(Math.log(180 / upper) * a);
  const wet = Math.min(1, a / 0.08);
  return hz.reduce((sum, f) => {
    const r = (f / fc) ** 4, h = Math.sqrt(v > 0 ? r / (1 + r) : 1 / (1 + r));
    return sum + (1 - wet + wet * h) ** 2;
  }, 0) / hz.length;
}

/** Linear power a deck contributes at output time t after its fader, band EQ and filter. */
function deckPower(p: TransitionPlan, an: TrackAnalysis, deck: Deck, t: number): { total: number; low: number; mid: number } | null {
  const delay = deck === 'B' ? p.bDelay ?? 0 : 0, tt = t - delay;
  if (tt < 0) return { total: 0, low: 0, mid: 0 };
  const src = deck === 'A' ? p.aExit + integrateTempo(p.tempoA, tt) : p.bEntry + integrateTempo(p.tempoB, tt);
  if (src > an.audibleEnd) return { total: 0, low: 0, mid: 0 };
  const b = bands(an, src);
  if (!b) return null;
  const g = laneValue(p, deck, 'gain', tt) ** 2 * 10 ** ((deck === 'A' ? p.gainA : p.gainB) / 10);
  const f = laneValue(p, deck, 'filter', tt);
  const low = b[0] * laneValue(p, deck, 'low', tt) ** 2 * g * sweepPower(f, LOW_HZ);
  const mid = b[1] * laneValue(p, deck, 'mid', tt) ** 2 * g * sweepPower(f, MID_HZ);
  const high = b[2] * laneValue(p, deck, 'high', tt) ** 2 * g * sweepPower(f, HIGH_HZ);
  return { total: low + mid + high, low, mid };
}

/** Output time and A source position where A has really left: its audible power stays 10 dB
 * under its own unprocessed level until the end of the overlap (fader x EQ x filter, P2). */
export function effectiveExit(p: TransitionPlan, A: TrackAnalysis): { t: number; source: number } {
  const D = p.duration;
  for (let t = D; t >= 0; t -= 0.1) {
    const src = p.aExit + integrateTempo(p.tempoA, t), b = bands(A, src), q = deckPower(p, A, 'A', t);
    if (!b || !q) continue;
    if (q.total >= 0.1 * (b[0] + b[1] + b[2]) * 10 ** (p.gainA / 10)) return { t: r3(t), source: r3(src) };
  }
  return { t: 0, source: p.aExit };
}

/** A downbeat entry that cuts off B's pickup: the beat before the entry rises into it (fill,
 * anacrusis, first syllable) instead of being steady music. 0 or 1; P3. */
export function pickupLost(B: TrackAnalysis, entry: number): number {
  if (!B.beat || entry < B.audibleStart + 0.05) return 0;
  const beat = B.beat.period, rate = B.curves.rate;
  const level = (a: number, b: number) => {
    const lo = Math.max(0, Math.floor(a * rate)), hi = Math.min(B.curves.rmsDb.length, Math.ceil(b * rate));
    const lin = linearPower(B.curves.rmsDb);
    let s = 0; for (let i = lo; i < hi; i++) s += lin[i];
    return hi > lo ? 10 * Math.log10(Math.max(1e-12, s / (hi - lo))) : -90;
  };
  const last = level(entry - beat, entry - 0.02), before = level(entry - 2 * beat, entry - beat);
  return last >= B.bodyRmsDb - 12 && last >= before + 3 ? 1 : 0;
}

/** Local key at a source time (analyzer-13), '' when unknown or not confident. */
function localKey(an: TrackAnalysis, t: number): string {
  const l = an.local;
  if (!l || !(l.rate > 0)) return '';
  const i = Math.floor(t * l.rate);
  return i >= 0 && i < l.camelot.length && (l.keyConfidence[i] ?? 0) >= 0.3 ? l.camelot[i] : '';
}

/** Share (0..1) of 8 points along two source spans where both local keys are known and clash (P9). */
export function localClashFraction(A: TrackAnalysis, aStart: number, aLen: number, B: TrackAnalysis, bStart: number, bLen: number): number {
  if (!A.local || !B.local) return 0;
  let clash = 0;
  for (let i = 0; i < 8; i++) {
    const x = (i + 0.5) / 8, ka = localKey(A, aStart + x * aLen), kb = localKey(B, bStart + x * bLen);
    if (ka && kb && camelotCompatibility(ka, kb).score < 0.5) clash++;
  }
  return clash / 8;
}

/** Seconds where both local keys are known, clash, and both decks' mids are clearly audible (P9). */
export function tonalClashSeconds(p: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis): number {
  if (!A.local || !B.local) return 0;
  let s = 0;
  for (let t = 0.25; t < p.duration; t += 0.5) {
    const tb = t - (p.bDelay ?? 0);
    if (tb < 0) continue;
    const ka = localKey(A, p.aExit + integrateTempo(p.tempoA, t)), kb = localKey(B, p.bEntry + integrateTempo(p.tempoB, tb));
    if (!ka || !kb || camelotCompatibility(ka, kb).score >= 0.5) continue;
    if (laneValue(p, 'A', 'gain', t) * laneValue(p, 'A', 'mid', t) >= 0.5 && laneValue(p, 'B', 'gain', tb) * laneValue(p, 'B', 'mid', tb) >= 0.5) s += 0.5;
  }
  return s;
}

const bodies = new WeakMap<TrackAnalysis, number>();
/** Median mid density of the audible song: the reference for "as dense as its own body". */
export function bodyDensity(an: TrackAnalysis): number {
  let v = bodies.get(an);
  if (v === undefined) {
    const c = an.curves, x = c.midDensity.slice(Math.floor(an.audibleStart * c.rate), Math.ceil(an.audibleEnd * c.rate)).sort((a, b) => a - b);
    v = x.length ? x[x.length >> 1] : 1;
    bodies.set(an, v);
  }
  return v;
}

const meanDensity = (an: TrackAnalysis, a: number, b: number) => {
  const c = an.curves, lo = Math.max(0, Math.floor(a * c.rate)), hi = Math.min(c.midDensity.length, Math.ceil(b * c.rate));
  let x = 0; for (let i = lo; i < hi; i++) x += c.midDensity[i];
  return hi > lo ? x / (hi - lo) : 0;
};

const density = (an: TrackAnalysis, src: number) => {
  const c = an.curves, i = Math.round(src * c.rate);
  return i >= 0 && i < c.midDensity.length ? c.midDensity[i] : 0;
};

/** Seconds where both decks are audible at full mid level in passages at least as dense as their own
 * body, while at least one voice is unknown: two possible lead parts at once (rule 1). Density is
 * relative to each song: most songs sit near 0.24 overall. A heuristic, not a voice detector. */
export function leadRiskSeconds(p: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis): number {
  let s = 0;
  for (let t = 0.25; t < p.duration; t += 0.5) {
    const tb = t - (p.bDelay ?? 0);
    if (tb < 0) continue;
    const ma = laneValue(p, 'A', 'gain', t) * laneValue(p, 'A', 'mid', t), mb = laneValue(p, 'B', 'gain', tb) * laneValue(p, 'B', 'mid', tb);
    if (ma < 0.5 || mb < 0.5) continue;
    if (density(A, p.aExit + integrateTempo(p.tempoA, t)) >= bodyDensity(A) && density(B, p.bEntry + integrateTempo(p.tempoB, tb)) >= bodyDensity(B)) s += 0.5;
  }
  return s;
}

export interface FullMixCost {
  total: number;
  /** 1 - structural closure where A really leaves (P2). */
  closureMiss: number;
  /** Seconds of A's remaining music skipped after it really left, weighted by its density. */
  cutA: number;
  pickup: number;
  holeDb: number;
  /** Seconds where A's own music has already ended and B has not reached its body (P4). */
  unsupported: number;
  /** Largest 0.5 s step of the summed level, dB above 4. */
  jumpDb: number;
  doubleBass: number;
  leadRisk: number;
  tonalClash: number;
  skippedUnknownB: number;
}

/** Stemless plan cost on one-second windows. Lower is better; null when curves are not measured. */
export function fullMixCost(p: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis, s: AutoMixSettings): FullMixCost | null {
  const D = p.duration;
  if (!(D > 0.5)) return null;
  const power = (an: TrackAnalysis, a: number, b: number, curve = an.curves.rmsDb) => {
    const lo = Math.max(0, Math.floor(a * an.curves.rate)), hi = Math.min(curve.length, Math.ceil(b * an.curves.rate));
    const lin = linearPower(curve);
    let x = 0; for (let i = lo; i < hi; i++) x += lin[i];
    return hi > lo ? 10 * Math.log10(Math.max(1e-12, x / (hi - lo))) : -90;
  };
  const before = Math.max(power(A, Math.max(A.audibleStart, p.aExit - 6), Math.max(A.audibleStart + 0.1, p.aExit - 1)), A.bodyRmsDb - 2) + p.gainA;
  const endB = p.bEntry + integrateTempo(p.tempoB, D - (p.bDelay ?? 0));
  const after = power(B, endB, Math.min(B.audibleEnd, endB + 4)) + p.gainB;
  const bodyLowA = power(A, A.audibleStart, A.audibleEnd, A.curves.lowDb), bodyLowB = power(B, B.audibleStart, B.audibleEnd, B.curves.lowDb);
  let hole = 0, unsupported = 0, jump = 0, doubleBass = 0, prev: number | null = null;
  for (let t = 0.25; t < D; t += 0.5) {
    const a = deckPower(p, A, 'A', t), b = deckPower(p, B, 'B', t);
    if (!a || !b) return null;
    const level = 10 * Math.log10(Math.max(1e-12, a.total + b.total));
    const target = before + (after - before) * (t / D);
    hole = Math.max(hole, target - level - 3);
    if (prev !== null) jump = Math.max(jump, Math.abs(level - prev) - 4);
    prev = level;
    const srcA = p.aExit + integrateTempo(p.tempoA, t), tb = t - (p.bDelay ?? 0);
    const srcB = tb < 0 ? -1 : p.bEntry + integrateTempo(p.tempoB, tb);
    // A's own music is over (not the fader: the recording) while B is still far from its body
    if (power(A, srcA - 0.5, srcA + 0.5) < before - p.gainA - 12 && (srcB < 0 || power(B, srcB - 0.5, srcB + 0.5) < after - p.gainB - 8)) unsupported += 0.5;
    // two full bass lines at once, both decks near their own bass level
    const lowA = 10 * Math.log10(Math.max(1e-12, a.low)) - p.gainA, lowB = 10 * Math.log10(Math.max(1e-12, b.low)) - p.gainB;
    if (lowA >= bodyLowA - 4 && lowB >= bodyLowB - 4) doubleBass += 0.5;
  }
  const exit = effectiveExit(p, A);
  const closureMiss = A.structure ? 1 - closureAt(A.structure, exit.source) : 0.5;
  const rest = Math.max(0, A.audibleEnd - exit.source);
  const restDensity = rest > 0 ? density(A, (exit.source + A.audibleEnd) / 2) : 0;
  const cutA = rest <= 2 ? 0 : clamp(rest / (restDensity < 0.18 ? 45 : 14));
  const unknownB = voiceUnknown(B, s), skipped = Math.max(0, p.bEntry - B.audibleStart);
  // a skipped opening as dense as B's body may hold its first words; a sparse intro is cheap to skip
  const skippedDensity = skipped > 5 ? meanDensity(B, B.audibleStart, p.bEntry) / bodyDensity(B) : 0;
  const skippedUnknownB = unknownB && skipped > 5 ? (skipped - 5) * clamp((skippedDensity - 0.7) / 0.3) : 0;
  const pickup = pickupLost(B, p.bEntry), leadRisk = leadRiskSeconds(p, A, B), tonalClash = tonalClashSeconds(p, A, B);
  // Overlap risks count as shares of the overlap: a cost in seconds would make every short cut look safer
  // than a long blend, which the listener rated worse ("резко").
  const total = 0.25 * closureMiss + 0.2 * cutA + 0.15 * pickup + 0.05 * Math.max(0, hole) + 0.1 * unsupported + 0.03 * Math.max(0, jump)
    + 0.3 * doubleBass / D + 0.3 * leadRisk / D + 0.2 * tonalClash / D + 0.005 * skippedUnknownB
    // listener ratings: blends under ~10 s were heard as abrupt switches ("резко")
    + 0.15 * clamp((10 - D) / 10);
  if (!Number.isFinite(total)) return null;
  return { total: r3(total), closureMiss: r3(closureMiss), cutA: r3(cutA), pickup, holeDb: r3(Math.max(0, hole)), unsupported, jumpDb: r3(Math.max(0, jump)),
    doubleBass, leadRisk, tonalClash, skippedUnknownB: r3(skippedUnknownB) };
}

/** P6: the same plan with its bass exchange moved by dt seconds (both low lanes, clamped to the overlap). */
export function withBassShift(p: TransitionPlan, dt: number): TransitionPlan | null {
  const D = p.duration, lows = p.automation.filter(l => l.lane === 'low');
  if (lows.length !== 2) return null;
  const moving = lows.flatMap(l => l.points.filter(([t]) => t > 0 && t < D).map(([t]) => t));
  if (!moving.length || Math.min(...moving) + dt <= 0.05 || Math.max(...moving) + dt >= D - 0.05) return null;
  const automation = p.automation.map(l => l.lane !== 'low' ? l : {
    ...l, points: l.points.map(([t, v]) => [t > 0 && t < D ? r3(t + dt) : t, v] as [number, number]),
  });
  return { ...p, id: `${p.id}_bass${Math.round(dt * 1000)}`, automation,
    debug: { ...p.debug, bassShift: r3(dt) } };
}
