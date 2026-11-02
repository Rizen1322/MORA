import type { BeatGrid, BeatRegion, TrackAnalysis, TransitionPlan } from '../types.ts';
import { integrateTempo, outputTimeAt, pointValue } from './timing.ts';

type RhythmGrid = Pick<BeatGrid | BeatRegion, 'beats' | 'period' | 'confidence' | 'jitterMs' | 'accents'> & { stable?: boolean };
type Event = { time: number; kick: number; snare: number };
type Pair = { a: Event | null; b: Event | null };

export interface RhythmBandAgreement {
  /** Pearson correlation of the measured per-beat accents at their actual output times (-1..1). */
  correlation: number;
  samples: number;
}

export interface RhythmOverlapDiagnostic {
  policy: 'rhythm-overlap-1';
  interpretation: 'structural-beat-accent-agreement-not-audibility';
  windowSeconds: number;
  timingToleranceMs: number;
  grids: {
    A: { source: 'global' | 'region'; confidence: number; jitterMs: number; beats: number };
    B: { source: 'global' | 'region'; confidence: number; jitterMs: number; beats: number };
  };
  pairedBeats: number;
  unmatchedBeats: number;
  kick: RhythmBandAgreement | null;
  snare: RhythmBandAgreement | null;
}

const laneValue = (p: TransitionPlan, deck: 'A' | 'B', t: number): number => {
  const points = p.automation.find(l => l.deck === deck && l.lane === 'gain')?.points;
  return points?.length ? pointValue(points, t) : 1;
};

function selectedGrid(an: TrackAnalysis, p: TransitionPlan, deck: 'A' | 'B', from: number, to: number): { grid: RhythmGrid; source: 'global' | 'region' } | null {
  const summary = p.beatAlign?.regions?.[deck];
  if (summary) {
    const region = (an.beatRegions ?? []).find(r => Math.abs(r.start - summary.start) < 0.05
      && Math.abs(r.end - summary.end) < 0.05 && r.start <= from && r.end >= to);
    if (!region?.accents) return null;
    return { grid: region, source: 'region' };
  }
  const grid = an.beat;
  // A repetition period hint explicitly rejects this global clock; do not report alignment on it.
  if (!grid?.accents || an.structure?.gridCheck?.periodHint) return null;
  return { grid, source: 'global' };
}

function hasCoverage(grid: RhythmGrid, from: number, to: number): boolean {
  const { beats, period, confidence, jitterMs, accents } = grid;
  if (!(period > 0 && Number.isFinite(period)) || !Number.isFinite(confidence) || confidence < 0.65 || grid.stable === false
    || !Number.isFinite(jitterMs) || jitterMs > 20
    || !accents || accents.kick.length !== beats.length || accents.snare.length !== beats.length
    || !beats.length || beats.some((t, i) => !Number.isFinite(t) || i > 0 && t <= beats[i - 1])
    || accents.kick.some(x => !Number.isFinite(x) || x < 0)
    || accents.snare.some(x => !Number.isFinite(x) || x < 0)) return false;
  const inWindow = beats.filter(t => t >= from && t < to);
  if (inWindow.length < 8 || inWindow[0] - from > period * 1.5 || to - inWindow[inWindow.length - 1] > period * 1.5) return false;
  return inWindow.every((t, i) => i === 0 || t - inWindow[i - 1] <= period * 1.5);
}

function outputEvents(plan: TransitionPlan, grid: RhythmGrid, deck: 'A' | 'B', sourceFrom: number, sourceTo: number, A: TrackAnalysis, B: TrackAnalysis): Event[] {
  const acc = grid.accents!;
  const delay = deck === 'B' ? plan.bDelay ?? 0 : 0;
  const cue = deck === 'A' ? plan.aExit : plan.bEntry;
  const tempo = deck === 'A' ? plan.tempoA : plan.tempoB;
  const events: Event[] = [];
  grid.beats.forEach((source, i) => {
    if (source < sourceFrom || source >= sourceTo) return;
    const out = delay + outputTimeAt(tempo, source - cue, Math.max(0, plan.duration - delay));
    if (out < delay || out >= plan.duration || laneValue(plan, deck, out - delay) <= 0) return;
    const peer = deck === 'A' ? 'B' : 'A', peerAnalysis = peer === 'A' ? A : B;
    const peerTime = out - (peer === 'B' ? plan.bDelay ?? 0 : 0);
    if (peerTime < 0 || laneValue(plan, peer, peerTime) <= 0) return;
    const peerSource = (peer === 'A' ? plan.aExit : plan.bEntry)
      + integrateTempo(peer === 'A' ? plan.tempoA : plan.tempoB, peerTime);
    if (peerSource < peerAnalysis.audibleStart || peerSource >= peerAnalysis.audibleEnd) return;
    events.push({ time: out, kick: acc.kick[i], snare: acc.snare[i] });
  });
  return events;
}

function pairEvents(a: Event[], b: Event[], tolerance: number): Pair[] {
  const used = new Set<number>(), pairs: Pair[] = [];
  for (const ea of a) {
    let best = -1, distance = Infinity;
    for (let i = 0; i < b.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(ea.time - b[i].time);
      if (d < distance) { distance = d; best = i; }
    }
    if (best >= 0 && distance <= tolerance) { used.add(best); pairs.push({ a: ea, b: b[best] }); }
    else pairs.push({ a: ea, b: null });
  }
  b.forEach((event, i) => { if (!used.has(i)) pairs.push({ a: null, b: event }); });
  return pairs;
}

function bandAgreement(pairs: Pair[], band: 'kick' | 'snare'): RhythmBandAgreement | null {
  const a = pairs.map(p => p.a?.[band] ?? 0), b = pairs.map(p => p.b?.[band] ?? 0);
  if (a.length < 8) return null;
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(a), mb = mean(b);
  const va = a.reduce((s, v) => s + (v - ma) ** 2, 0), vb = b.reduce((s, v) => s + (v - mb) ** 2, 0);
  if (!(va > 1e-9 && vb > 1e-9)) return null;
  const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0);
  return { correlation: Math.round((cov / Math.sqrt(va * vb)) * 1000) / 1000, samples: a.length };
}

function medianInterval(events: Event[]): number | null {
  const intervals = events.slice(1).map((e, i) => e.time - events[i].time).filter(x => x > 0 && Number.isFinite(x)).sort((a, b) => a - b);
  return intervals.length ? intervals[intervals.length >> 1] : null;
}

function hasSimultaneousStructure(plan: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis, from: number, to: number): boolean {
  // This checks timeline geometry and source coverage only; it makes no claim that either deck is audible.
  const step = 0.05;
  for (let t = from + step / 2; t < to; t += step) {
    const tb = t - (plan.bDelay ?? 0);
    const sa = plan.aExit + integrateTempo(plan.tempoA, t), sb = plan.bEntry + integrateTempo(plan.tempoB, tb);
    if (sa >= A.audibleStart && sa < A.audibleEnd && sb >= B.audibleStart && sb < B.audibleEnd
      && laneValue(plan, 'A', t) > 0 && laneValue(plan, 'B', tb) > 0) return true;
  }
  return false;
}

/** Beat-level kick/snare accent agreement at the source/output clocks the renderer will use.
 * This is a diagnostic, not a drum transcription or a planner cost. Missing, weak, or gapped
 * beat evidence stays unknown. It does not rotate a bar or infer unmeasured subdivisions. */
export function rhythmOverlap(plan: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis): RhythmOverlapDiagnostic | null {
  // These effects remap source positions beyond the tempo integral. Until this
  // diagnostic models them, do not report the replaced tail's accents as heard.
  if (plan.loopA || plan.tapeStopA) return null;
  if (!(plan.duration > 0) || plan.gap > 0 || !Number.isFinite(plan.bDelay ?? 0)) return null;
  const delay = plan.bDelay ?? 0, outFrom = Math.max(0, delay), outTo = plan.duration;
  if (!(outTo - outFrom >= 4) || !hasSimultaneousStructure(plan, A, B, outFrom, outTo)) return null;
  // Convert the actual audible overlap endpoints through the executed tempo maps.
  const aFrom = plan.aExit + integrateTempo(plan.tempoA, outFrom);
  const aTo = plan.aExit + integrateTempo(plan.tempoA, outTo);
  const bFrom = plan.bEntry + integrateTempo(plan.tempoB, outFrom - delay);
  const bTo = plan.bEntry + integrateTempo(plan.tempoB, outTo - delay);
  if (aFrom < A.audibleStart || aTo > A.audibleEnd || bFrom < B.audibleStart || bTo > B.audibleEnd) return null;
  const ga = selectedGrid(A, plan, 'A', aFrom, aTo), gb = selectedGrid(B, plan, 'B', bFrom, bTo);
  if (!ga || !gb || !hasCoverage(ga.grid, aFrom, aTo) || !hasCoverage(gb.grid, bFrom, bTo)) return null;
  const ea = outputEvents(plan, ga.grid, 'A', aFrom, aTo, A, B), eb = outputEvents(plan, gb.grid, 'B', bFrom, bTo, A, B);
  if (ea.length < 8 || eb.length < 8) return null;
  const periodA = medianInterval(ea), periodB = medianInterval(eb);
  if (periodA === null || periodB === null) return null;
  const tolerance = Math.min(periodA, periodB) * 0.2;
  const pairs = pairEvents(ea, eb, tolerance);
  const pairedBeats = pairs.filter(x => x.a && x.b).length;
  return {
    policy: 'rhythm-overlap-1', interpretation: 'structural-beat-accent-agreement-not-audibility', windowSeconds: Math.round((outTo - outFrom) * 1000) / 1000,
    timingToleranceMs: Math.round(tolerance * 1000),
    grids: { A: { source: ga.source, confidence: ga.grid.confidence, jitterMs: ga.grid.jitterMs, beats: ea.length },
      B: { source: gb.source, confidence: gb.grid.confidence, jitterMs: gb.grid.jitterMs, beats: eb.length } },
    pairedBeats, unmatchedBeats: pairs.length - pairedBeats,
    kick: bandAgreement(pairs, 'kick'), snare: bandAgreement(pairs, 'snare'),
  };
}
