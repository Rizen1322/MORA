import { CREATIVE_TRANSITION_STYLES, planCreativeTransition } from './creative.ts';
import { fnv1a } from './planner.ts';
import { ratingBias, type RatingStats } from './feedback.ts';
import type { AutoMixSettings, PlannerTrack, TransitionPlan } from '../types.ts';

/** Preserve manual/album choices; rotate only among recipes that fit the actual recordings. */
export function creativeFinalists(plans: TransitionPlan[], a: PlannerTrack, b: PlannerTrack, settings: AutoMixSettings, feedback: RatingStats | null): TransitionPlan[] {
  const base = plans[0];
  if (!base || !settings.enabled || settings.djPhrasing === false || settings.entryMode === 'preserve' || settings.style === 'smooth'
    || base.debug.processingAllowed === false || base.debug.reviewedTransition || base.vocalA || base.vocalB
    || !['crossfade', 'beatmatch_blend', 'echo_out', 'drop_mix'].includes(base.method)) return plans;
  const seed = parseInt(fnv1a(`${a.id}|${b.id}|creative-selection-1`), 36);
  // Keep ordinary blends in the rotation rather than applying an effect to every pair.
  if (seed % 3 === 0) return plans;
  const floor = feedback ? Math.min(0, ratingBias(feedback, base, a.analysis, b.analysis).bias) : 0;
  const suitable = CREATIVE_TRANSITION_STYLES.flatMap(({ id }) => {
    const p = planCreativeTransition(a, b, settings, id);
    return p && (!feedback || ratingBias(feedback, p, a.analysis, b.analysis).bias >= floor) ? [p] : [];
  });
  if (!suitable.length) return plans;
  const selected = suitable[Math.floor(seed / 3) % suitable.length];
  selected.debug = { ...selected.debug, creative: { ...(selected.debug.creative as object), experimental: false },
    creativeSelection: { policy: 'creative-selection-1', baseline: base.id, candidates: suitable.map(p => p.id) } };
  return [selected, ...plans];
}
