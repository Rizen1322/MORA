import type { TrackAnalysis, TransitionPlan } from '@automix/core';

export interface DisplayBeatGrid {
  beats: number[];
  downbeats: number[];
  phrases: number[];
  local: boolean;
}

/** Show the exact local grid selected by the plan. An unstable whole-song
 * hypothesis must not replace it in the transition visualization.
 */
export function diagnosticBeatGrid(analysis: TrackAnalysis, plan: TransitionPlan, deck: 'A' | 'B'): DisplayBeatGrid | null {
  const region = plan.beatAlign?.regions?.[deck];
  let beats: number[], downbeats: number[], local = false;
  if (region && Number.isFinite(region.period) && region.period > 0 && Number.isFinite(region.downbeat)
    && Number.isFinite(region.start) && Number.isFinite(region.end) && region.end > region.start) {
    const grid = (step: number) => {
      const from = Math.ceil((region.start - region.downbeat) / step - 1e-6);
      const count = Math.max(0, Math.min(20000, Math.ceil((region.end - region.downbeat) / step) - from));
      return Array.from({ length: count }, (_, i) => region.downbeat + (from + i) * step)
        .filter((time) => time >= region.start - 1e-4 && time < region.end - 1e-6);
    };
    beats = grid(region.period);
    downbeats = grid(region.period * 4);
    local = true;
  } else {
    if (!analysis.beat) return null;
    beats = analysis.beat.beats;
    downbeats = analysis.beat.downbeats;
  }
  const phrases = analysis.phraseConfidence >= 0.2
    ? downbeats.filter((bar) => analysis.phrases.some((time) => Math.abs(bar - time) < 0.025)) : [];
  return { beats, downbeats, phrases, local };
}
