import type { TransitionPlan } from '../packages/core/src/types.ts';

/** Source effects use absolute source seconds, unlike deck automation clocks. */
export function planForSourceWindows(plan: TransitionPlan, startA: number, startB: number): TransitionPlan {
  return { ...plan, aExit: plan.aExit - startA, bEntry: plan.bEntry - startB,
    loopA: plan.loopA ? { ...plan.loopA, start: plan.loopA.start - startA, end: plan.loopA.end - startA,
      until: plan.loopA.until - startA, roll: plan.loopA.roll?.map(x => ({ ...x, at: x.at - startA })) } : undefined,
    tapeStopA: plan.tapeStopA ? { ...plan.tapeStopA, start: plan.tapeStopA.start - startA, end: plan.tapeStopA.end - startA } : undefined };
}
