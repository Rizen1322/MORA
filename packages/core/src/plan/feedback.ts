import { fnv1a, tempoRelation } from './planner.ts';
import type { TrackAnalysis, TransitionPlan, TransitionRating } from '../types.ts';

/**
 * Listener ratings as a soft preference between finalists the planner already built. Each plan is
 * described by a few coarse features (method, tempo gap and key compatibility per method, overlap
 * length, vocal masks); each feature keeps good/bad counts. The bias is the mean over all features
 * of a Bayesian average with a neutral prior, so one or two ratings cannot outweigh the planners'
 * own margins, and it is capped well below them in total. It only reorders valid alternatives.
 */
export interface RatingStats {
  /** Changes whenever any rating changes: part of the transition cache key. */
  version: string;
  features: Record<string, { good: number; bad: number }>;
}

/** Prior weight (pseudo-ratings at 0.5) and the scale of the averaged deviation. */
const PRIOR = 8, WEIGHT = 0.8, CAP = 0.15;
const FEATURE_COUNT = 5;

const bucket = (x: number, edges: number[], names: string[]) => names[edges.findIndex(e => x < e)] ?? names[names.length - 1];

/** Only the tempo of an analysis is read. */
type Tempo = { beat: { bpm: number } | null } | Pick<TrackAnalysis, 'beat'>;

/** Coarse features of an executed or candidate plan. Unknown tempo/key leave their feature out. */
export function ratingFeatures(plan: TransitionPlan, A?: Tempo | null, B?: Tempo | null): string[] {
  const m = plan.method;
  const stretch = plan.beatAlign?.stretchPercent ?? (A?.beat && B?.beat ? tempoRelation(A.beat.bpm, B.beat.bpm).stretchPercent : null);
  const out = [`method:${m}`];
  if (stretch !== null && Number.isFinite(stretch)) out.push(`bpm:${m}:${bucket(stretch, [2, 5, 8, 12], ['<2', '2-5', '5-8', '8-12', '12+'])}`);
  if (plan.keyInfo) out.push(`key:${m}:${bucket(plan.keyInfo.compatibility, [0.5, 0.8], ['low', 'mid', 'high'])}`);
  out.push(`length:${bucket(plan.duration, [4, 10, 20], ['<4', '4-10', '10-20', '20+'])}`);
  out.push(`vocals:${plan.vocalA || plan.vocalB ? 'masked' : 'none'}`);
  return out;
}

/** Aggregates rated transitions; null when there is nothing to learn from. */
export function ratingStats(rows: { rating: TransitionRating; features: string[] }[]): RatingStats | null {
  if (!rows.length) return null;
  const features: RatingStats['features'] = {};
  for (const r of rows) for (const f of new Set(r.features)) {
    const c = features[f] ??= { good: 0, bad: 0 };
    c[r.rating] += 1;
  }
  return { version: `ratings-${fnv1a(JSON.stringify(features))}`, features };
}

/** Cost bonus (>0 better, <0 worse) for a plan, at most CAP either way, and the features it used. */
export function ratingBias(stats: RatingStats, plan: TransitionPlan, A?: TrackAnalysis | null, B?: TrackAnalysis | null): { bias: number; features: Record<string, number> } {
  const used: Record<string, number> = {};
  let sum = 0;
  for (const f of ratingFeatures(plan, A, B)) {
    const c = stats.features[f];
    if (!c) continue;
    const dev = (c.good + PRIOR / 2) / (c.good + c.bad + PRIOR) - 0.5;
    used[f] = Math.round(dev * 1000) / 1000;
    sum += dev;
  }
  const bias = Math.max(-CAP, Math.min(CAP, (WEIGHT * sum) / FEATURE_COUNT));
  return { bias: Math.round(bias * 1000) / 1000, features: used };
}
