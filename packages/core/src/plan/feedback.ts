import { fnv1a, tempoRelation } from './planner.ts';
import { integrateTempo, pointValue } from './timing.ts';
import { leadBandRetention } from './fullmix.ts';
import type { TrackAnalysis, TransitionPlan, TransitionRating, TransitionRatingReason } from '../types.ts';
import { TRANSITION_RATING_REASONS } from '../types.ts';

/** Schema is part of every statistics version, including ratings from older planners. */
const SCHEMA = 'listener-ratings-4';
const GEOMETRY = 'geometry-2';
type Counts = { good: number; bad: number };
export interface RatingStats {
  /** Changes whenever the effective evidence or feature schema changes. */
  version: string;
  features: Record<string, Counts>;
  /** Explicit complaints are targeted evidence, rather than votes against every shared feature. */
  reasons?: Partial<Record<TransitionRatingReason, Record<string, Counts>>>;
}

const PRIOR = 8, WEIGHT = 0.8, CAP = 0.15;
const bucket = (x: number, edges: number[], names: string[]) => names[edges.findIndex(e => x < e)] ?? names[names.length - 1];
type Tempo = { beat: { bpm: number } | null; audibleStart?: number; audibleEnd?: number } | Pick<TrackAnalysis, 'beat' | 'audibleStart' | 'audibleEnd'>;
type Execution = { outcome?: Record<string, unknown> };
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const clamp = (x: number) => Math.max(0, Math.min(1, x));

/** These are automation proxies, not a voice detector. B uses its own clock after bDelay. */
function geometry(plan: TransitionPlan): { midOverlap: number; slope: number; exitTime: number; gainFloor: number } | null {
  if (!finite(plan.duration) || plan.duration < 0 || !Array.isArray(plan.automation)) return null;
  if (plan.automation.some(l => !Array.isArray(l.points) || l.points.some(p => !finite(p[0]) || !finite(p[1])))) return null;
  const lane = (deck: 'A' | 'B', name: string, t: number) => {
    if (t < 0) return 0;
    const points = plan.automation.find(l => l.deck === deck && l.lane === name)?.points;
    return points?.length ? pointValue(points, t) : name === 'filter' || name === 'echo' || name === 'voiceEcho' ? 0 : 1;
  };
  const mid = (deck: 'A' | 'B', t: number) => {
    const tt = t - (deck === 'B' ? plan.bDelay ?? 0 : 0);
    return tt < 0 ? 0 : clamp(lane(deck, 'gain', tt)) * clamp(leadBandRetention(plan, deck, tt));
  };
  // Fixed sample count bounds planner work even for malformed/very long historical windows.
  const steps = Math.max(1, Math.min(256, Math.ceil(plan.duration / 0.1))), dt = plan.duration / steps;
  let midOverlap = 0, exitTime = 0, slope = 0, gainFloor = 2;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    midOverlap += Math.min(mid('A', t), mid('B', t)) * dt;
    gainFloor = Math.min(gainFloor, clamp(lane('A', 'gain', t)) + clamp(lane('B', 'gain', t - (plan.bDelay ?? 0))));
    if (mid('A', t) > 0.1) exitTime = (i + 1) * dt;
  }
  for (const l of plan.automation.filter(l => ['gain', 'mid', 'filter'].includes(l.lane))) {
    for (let i = 1; i < l.points.length; i++) {
      const [a, x] = l.points[i - 1], [b, y] = l.points[i];
      if (y !== x) slope = Math.max(slope, Math.abs(y - x) / Math.max(0.01, b - a));
    }
  }
  return { midOverlap, slope, exitTime, gainFloor };
}

/** Features of the actual plan, never the winner named by a stale fullMix/render debug summary.
 * Missing historical measurements stay absent; "vocals:none" means no mask, not no singing.
 * The optional execution context records whether masks were actually available at playback. */
export function ratingFeatures(plan: TransitionPlan, A?: Tempo | null, B?: Tempo | null, execution?: Execution): string[] {
  const m = plan.method, version = plan.version || 'unknown';
  const stretch = plan.beatAlign?.stretchPercent ?? (A?.beat && B?.beat ? tempoRelation(A.beat.bpm, B.beat.bpm).stretchPercent : null);
  const out = [`method:${m}`];
  if (finite(stretch)) out.push(`bpm:${m}:${bucket(stretch, [2, 5, 8, 12], ['<2', '2-5', '5-8', '8-12', '12+'])}`);
  if (plan.keyInfo && finite(plan.keyInfo.compatibility)) out.push(`key:${m}:${bucket(plan.keyInfo.compatibility, [0.5, 0.8], ['low', 'mid', 'high'])}`);
  if (finite(plan.duration)) out.push(`length:${bucket(plan.duration, [4, 10, 20], ['<4', '4-10', '10-20', '20+'])}`);
  const masks = (execution?.outcome?.stems as { masks?: { A?: boolean; B?: boolean } } | undefined)?.masks;
  out.push(`vocals:${masks ? masks.A || masks.B ? 'masked' : 'none' : plan.vocalA || plan.vocalB ? 'masked' : 'none'}`);
  const g = geometry(plan);
  if (g) {
    out.push(`mid-overlap:${GEOMETRY}:${bucket(g.midOverlap, [1, 3, 6, 10], ['<1', '1-3', '3-6', '6-10', '10+'])}`);
    out.push(`slope:${GEOMETRY}:${bucket(g.slope, [0.15, 0.5, 2], ['slow', 'medium', 'fast', 'cut'])}`);
    out.push(`gain-floor:${GEOMETRY}:${bucket(g.gainFloor, [0.5, 0.85, 1.15], ['deep', 'dip', 'level', 'boost'])}`);
    // Only a known source endpoint can establish how much of A was skipped.
    if (finite(A?.audibleEnd) && finite(plan.aExit)) {
      const cut = Math.max(0, A.audibleEnd - plan.aExit - integrateTempo(plan.tempoA, g.exitTime));
      out.push(`cut:${GEOMETRY}:${bucket(cut, [2, 8, 20, 40], ['<2', '2-8', '8-20', '20-40', '40+'])}`);
    }
    const round = (x: number) => Math.round(x * 1000) / 1000;
    const recipe = {
      method: m, aExit: plan.aExit, bEntry: plan.bEntry, duration: plan.duration, bDelay: plan.bDelay ?? 0,
      tempoA: plan.tempoA, tempoB: plan.tempoB, vocalA: plan.vocalA, vocalB: plan.vocalB,
      automation: [...plan.automation].sort((a, b) => `${a.deck}:${a.lane}`.localeCompare(`${b.deck}:${b.lane}`)),
      echo: plan.echo, voiceEcho: plan.voiceEcho, loopA: plan.loopA, tapeStopA: plan.tapeStopA, gainA: plan.gainA, gainB: plan.gainB,
    };
    if (plan.fromTrackId && plan.toTrackId) out.push(`pair-recipe:${version}:${fnv1a(JSON.stringify([plan.fromTrackId, plan.toTrackId]))}:${fnv1a(JSON.stringify(recipe, (_, v) => typeof v === 'number' ? round(v) : v))}`);
    const shape = typeof plan.debug?.variant === 'string' ? plan.debug.variant : 'plain';
    out.push(`shape:${version}:${shape}`);
    const phrase = plan.debug?.phraseMix as { preset?: unknown } | undefined;
    if (typeof phrase?.preset === 'string') out.push(`preset:${version}:${phrase.preset}`);
    out.push(`rhythm:${GEOMETRY}:${plan.beatAlign ? 'locked' : 'free'}:${plan.loopA ? 'loop' : 'linear'}`);
  }
  if (finite(plan.bEntry) && finite(B?.audibleStart)) out.push(`entry:${GEOMETRY}:${bucket(Math.max(0, plan.bEntry - B.audibleStart), [1, 8, 25], ['start', '1-8', '8-25', '25+'])}`);
  if (finite(plan.bDelay)) out.push(`delay:${GEOMETRY}:${bucket(plan.bDelay, [0.1, 2, 6], ['none', '<2', '2-6', '6+'])}`);
  return out;
}

const targeted = (reason: TransitionRatingReason, f: string) => f.startsWith('pair-recipe:') || (
  reason === 'голоса наложились' ? /^(mid-overlap|vocals):/.test(f) :
  reason === 'резко' ? /^(slope|cut|entry):/.test(f) :
  reason === 'сбился ритм' ? /^(bpm|rhythm):/.test(f) : /^(gain-floor|shape|preset):/.test(f));

/** Null only when there is no usable rating. Reason edits participate in the version. */
export function ratingStats(rows: { rating: TransitionRating; features: string[]; reason?: TransitionRatingReason | null }[]): RatingStats | null {
  if (!rows.length) return null;
  const features: RatingStats['features'] = {}, reasons: NonNullable<RatingStats['reasons']> = {};
  for (const r of rows) for (const f of new Set(r.features)) {
    // Explicit complaints never teach unrelated tempo/length preferences.
    const reason = r.reason && TRANSITION_RATING_REASONS.includes(r.reason) ? r.reason : null;
    const target = r.rating === 'bad' && reason ? targeted(reason, f) ? reasons[reason] ??= {} : null : features;
    if (target) (target[f] ??= { good: 0, bad: 0 })[r.rating] += 1;
  }
  const canonical = (v: unknown): string => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
  return { version: `${SCHEMA}-${fnv1a(canonical({ features, reasons }))}`, features, reasons };
}

/** Bounded soft preference, with a neutral prior. Exact directed recipes have modest extra weight. */
export function ratingBias(stats: RatingStats, plan: TransitionPlan, A?: TrackAnalysis | null, B?: TrackAnalysis | null): { bias: number; features: Record<string, number> } {
  const used: Record<string, number> = {};
  let sum = 0;
  for (const f of ratingFeatures(plan, A, B)) {
    const add = (c: Counts | undefined, key: string, weight = 1) => {
      if (!c) return;
      const dev = (c.good + PRIOR / 2) / (c.good + c.bad + PRIOR) - 0.5;
      used[key] = Math.round(dev * 1000) / 1000;
      sum += dev * weight;
    };
    const weight = f.startsWith('pair-recipe:') ? 2 : /^(method|bpm|key|length|vocals):/.test(f) ? 1 : 0.5;
    add(stats.features[f], f, weight);
    for (const [reason, evidence] of Object.entries(stats.reasons ?? {})) add(evidence?.[f], `${reason}/${f}`, weight);
  }
  return { bias: Math.round(Math.max(-CAP, Math.min(CAP, WEIGHT * sum / 10)) * 1000) / 1000, features: used };
}
