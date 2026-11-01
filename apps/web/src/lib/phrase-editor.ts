import { phraseMixGrid, phraseSourceTime, type PhraseMixRecipe, type TrackAnalysis, type TransitionPlan } from '@automix/core';

/** Freeze a measured scenario into editable lanes, including neutral lanes. Without
 * those explicit curves the recipe compiler would add its preset EQ and filter. */
export function phraseScenario(plan: TransitionPlan, name: string): PhraseMixRecipe {
  const bDelay = plan.bDelay ?? 0;
  const curves: NonNullable<PhraseMixRecipe['curves']> = [];
  for (const deck of ['A', 'B'] as const) for (const lane of ['gain', 'low', 'mid', 'high', 'filter'] as const) {
    const span = plan.duration - (deck === 'B' ? bDelay : 0);
    const source = plan.automation.find(c => c.deck === deck && c.lane === lane);
    const neutral = lane === 'filter' ? 0 : 1;
    curves.push({ deck, lane, points: source
      ? source.points.map(([t, v]) => [t / span, v])
      : [[0, neutral], [1, neutral]] });
  }
  return { version: 1, preset: name === 'natural-tail-start' ? 'tail_to_start' : name === 'arrival-build' ? 'drop_in' : 'bass_swap',
    timing: { unit: 'seconds', seconds: plan.duration }, aExit: plan.aExit, bEntry: plan.bEntry, bDelay, handoff: plan.swapAt,
    tempo: { ...(plan.tempoA ? { a: plan.tempoA.map(p => [...p] as [number, number]) } : {}), b: plan.tempoB.map(p => [...p] as [number, number]) },
    curves, locks: { aExit: false, bEntry: false, handoff: false } };
}

/** Move the existing automation around the handoff while keeping its nodes and levels. */
function retimeCurves(recipe: PhraseMixRecipe, duration: number, nextDuration: number, delay: number, handoff: number): PhraseMixRecipe['curves'] {
  return recipe.curves?.map(curve => {
    const oldStart = curve.deck === 'B' ? recipe.bDelay : 0;
    const newStart = curve.deck === 'B' ? delay : 0;
    const oldPivot = (recipe.handoff - oldStart) / (duration - oldStart);
    const newPivot = (handoff - newStart) / (nextDuration - newStart);
    // An endpoint pivot still needs a small interval to retain distinct user nodes.
    const clampPivot = (x: number) => Math.max(0.000001, Math.min(0.999999, x));
    const before = clampPivot(oldPivot), after = clampPivot(newPivot);
    return { ...curve, points: curve.points.map(([x, y]): [number, number] => [
      x === 0 || x === 1 ? x : x <= before ? x * after / before : after + (x - before) * (1 - after) / (1 - before), y,
    ]) };
  });
}

/** Update timeline markers and keep explicit scenario and user curves aligned. */
export function phraseMarker(recipe: PhraseMixRecipe, duration: number, key: 'bDelay' | 'handoff', value: number): PhraseMixRecipe {
  if (!Number.isFinite(value) || !(duration >= 0.5)) return recipe;
  const delay = key === 'bDelay' ? Math.max(0, Math.min(recipe.handoff, duration - 0.05, value)) : recipe.bDelay;
  const handoff = key === 'handoff' ? Math.max(delay, Math.min(duration, value)) : recipe.handoff;
  return { ...recipe, bDelay: delay, handoff,
    curves: retimeCurves(recipe, duration, duration, delay, handoff),
    ...(key === 'handoff' ? { locks: { aExit: recipe.locks?.aExit ?? false, bEntry: recipe.locks?.bEntry ?? false, handoff: true } } : {}) };
}

/** Keep the heard end of A when changing length, until its cue is explicitly locked by the user. */
export function phraseTiming(recipe: PhraseMixRecipe, timing: PhraseMixRecipe['timing'], base: TransitionPlan,
  analysis: TrackAnalysis | null, previousDuration: number): PhraseMixRecipe {
  const native = recipe.preset === 'tail_to_start';
  const tempoA = native ? undefined : recipe.tempo ? recipe.tempo.a : base.tempoA;
  let duration = timing.unit === 'seconds' ? timing.seconds : NaN;
  if (timing.unit === 'bars') {
    const grid = phraseMixGrid({ ...base, aExit: recipe.aExit }, analysis);
    if (grid) {
      let lo = 0, hi = 128;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (phraseSourceTime(tempoA, mid) < grid.barSeconds * timing.bars) lo = mid; else hi = mid; }
      duration = (lo + hi) / 2;
    }
  }
  if (!(duration >= 0.5) || duration > 64) return { ...recipe, timing };
  const aExit = recipe.locks?.aExit ? recipe.aExit
    : Math.max(0, recipe.aExit + phraseSourceTime(tempoA, previousDuration) - phraseSourceTime(tempoA, duration));
  const bDelay = native ? Math.max(0, duration - 1.2) : Math.min(recipe.bDelay, duration - 0.1);
  const handoff = Math.min(duration, Math.max(bDelay, recipe.locks?.handoff ? recipe.handoff : native ? duration - 0.6
    : recipe.handoff / Math.max(0.5, previousDuration) * duration));
  return { ...recipe, timing, aExit, bDelay, handoff, curves: retimeCurves(recipe, previousDuration, duration, bDelay, handoff) };
}

export function phrasePreset(recipe: PhraseMixRecipe, preset: PhraseMixRecipe['preset'], duration: number): PhraseMixRecipe {
  if (preset === 'tail_to_start') return { ...recipe, preset, timing: { unit: 'seconds', seconds: duration }, bDelay: Math.max(0, duration - 1.2), handoff: Math.max(0.1, duration - 0.6), curves: undefined };
  return { ...recipe, preset, bDelay: 0, handoff: duration / 2, curves: undefined };
}

/** Waveform samples follow the exact source-time maps used by the mixer. */
export function phraseWaveform(analysis: TrackAnalysis | null, plan: TransitionPlan, deck: 'A' | 'B'): string {
  if (!analysis?.peaks.length) return '';
  const delay = deck === 'B' ? plan.bDelay ?? 0 : 0;
  const entry = deck === 'A' ? plan.aExit : plan.bEntry;
  const tempo = deck === 'A' ? plan.tempoA : plan.tempoB;
  return Array.from({ length: 240 }, (_, i) => {
    const output = i / 239 * plan.duration;
    const source = entry + phraseSourceTime(tempo, Math.max(0, output - delay));
    const height = output < delay ? 0 : Math.min(1, analysis.peaks[Math.floor(source * analysis.curves.rate)] ?? 0) * 25;
    return `M${i / 239 * 600},${30 - height}v${height * 2}`;
  }).join(' ');
}

/** Actual measured downbeats projected onto the outgoing deck's output clock. */
export function phraseGridTimes(analysis: TrackAnalysis | null, plan: TransitionPlan): number[] {
  if (!analysis?.beat?.stable || analysis.beat.confidence < 0.7 || analysis.beat.downbeatConfidence < 0.6) return [];
  const end = plan.aExit + phraseSourceTime(plan.tempoA, plan.duration);
  return analysis.beat.downbeats.filter(t => t >= plan.aExit && t <= end).map(source => {
    let lo = 0, hi = plan.duration;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (plan.aExit + phraseSourceTime(plan.tempoA, mid) < source) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  });
}
