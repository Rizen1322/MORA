import { PLANNER_VERSION, type AutoMixSettings, type TrackAnalysis, type TransitionPlan } from '../types.ts';
import { integrateTempo, outputTimeAt, pointValue } from './timing.ts';

/** A listening hypothesis, never an automatic instrumental/vocal-safe label.
 * Reuse a complete measured bar of the full mix instead of introducing the
 * next outgoing phrase. Ranking measures band-envelope repetition only. */
export function stemlessLoopAudition(base: TransitionPlan, A: TrackAnalysis, s: AutoMixSettings): { name: string; plan: TransitionPlan; auditionOnly: true } | null {
  const g = A.beat, c = A.curves;
  if (!s.enabled || s.loopBridges === false || base.debug.processingAllowed === false
    || base.method !== 'beatmatch_blend' || !base.beatAlign || base.loopA || base.tapeStopA || base.echo || base.voiceEcho
    || base.vocalA || base.vocalB || base.gap !== 0 || (base.bDelay ?? 0) !== 0
    || !g?.stable || g.confidence < .8 || g.downbeatConfidence < .75 || g.jitterMs > 20 || A.structure?.gridCheck?.periodHint
    || !c || ![g.period, g.confidence, g.downbeatConfidence, g.jitterMs, base.aExit, base.duration, base.swapAt,
      A.audibleStart, A.audibleEnd, A.duration, c.rate, s.maxBlendSeconds].every(Number.isFinite)
    || !Array.isArray(g.downbeats) || g.downbeats.some((t, i) => !Number.isFinite(t) || t < 0 || (i > 0 && t <= g.downbeats[i - 1]))
    || ![c.rmsDb, c.lowDb, c.midDb, c.highDb].every(Array.isArray)
    || g.period <= 0 || c.rate <= 0 || base.swapAt <= 0 || base.swapAt > base.duration
    || base.duration < 4 || base.duration > s.maxBlendSeconds) return null;
  const maps = [base.tempoA ?? [[0, 1]], base.tempoB];
  if (maps.some(map => !map.length || map.some(([t, v], i) => !Number.isFinite(t) || !Number.isFinite(v) || v <= 0
    || t < 0 || (i === 0 ? t !== 0 : t <= map[i - 1][0])))) return null;
  const sourceEnd = base.aExit + integrateTempo(base.tempoA, base.duration);
  if (sourceEnd > Math.min(A.duration, A.audibleEnd) || base.aExit < A.audibleStart) return null;
  const handoff = base.aExit + integrateTempo(base.tempoA, base.swapAt);
  const until = g.downbeats.find(t => t >= handoff && t <= sourceEnd);
  if (until === undefined) return null;
  const exit = outputTimeAt(base.tempoA, until - base.aExit, base.duration);
  const release = outputTimeAt(base.tempoA, until - g.period * 4 - base.aExit, base.duration);
  if (release <= 0 || exit <= release) return null;
  const bands = [c.rmsDb, c.lowDb, c.midDb, c.highDb];
  const sample = (band: number[], time: number) => {
    const x = time * c.rate, i = Math.floor(x), f = x - i;
    return i >= 0 && i + 1 < band.length && Number.isFinite(band[i]) && Number.isFinite(band[i + 1])
      ? band[i] * (1 - f) + band[i + 1] * f : NaN;
  };
  const choices: { start: number; end: number; bars: number; differenceDb: number }[] = [];
  for (let i = 0; i < g.downbeats.length; i++) for (const bars of [1, 2]) {
    const start = g.downbeats[i], end = g.downbeats[i + bars], length = end - start;
    const at = outputTimeAt(base.tempoA, start - base.aExit, base.duration);
    if (![start, end, length, at].every(Number.isFinite) || start < base.aExit || at < base.duration * .1 || at > release
      || length < 1 || length > 8 || Math.abs(length - g.period * 4 * bars) > .02
      || until - start < length * 2 || until - start > length * 4 || start < .006) continue;
    // Compare the source loop with the following complete cycle. This is not
    // pitch/word recognition; constant envelopes can still contain changing vocals.
    let error = 0, count = 0;
    for (const band of bands) for (let k = 0; k < 32 * bars; k++) {
      const t = start + (k + .5) * length / (32 * bars);
      const x = sample(band, t), y = sample(band, t + length);
      if (!Number.isFinite(x) || !Number.isFinite(y)) { error = Infinity; break; }
      error += Math.abs(x - y); count++;
    }
    if (Number.isFinite(error) && count) choices.push({ start, end, bars, differenceDb: error / count });
  }
  choices.sort((a, b) => a.differenceDb - b.differenceDb || b.bars - a.bars || a.start - b.start);
  const chosen = choices[0];
  if (!chosen) return null;
  const automation = base.automation.filter(l => !(l.deck === 'A' && ['gain', 'low', 'filter'].includes(l.lane)));
  for (const lane of ['gain', 'low', 'filter'] as const) {
    const original = base.automation.find(l => l.deck === 'A' && l.lane === lane)?.points ?? [[0, lane === 'filter' ? 0 : 1]] as [number, number][];
    const times = [...new Set([0, ...original.map(([t]) => t), release, exit,
      ...Array.from({ length: 17 }, (_, i) => release + (exit - release) * i / 16), base.duration])].sort((a, b) => a - b);
    automation.push({ deck: 'A', lane, points: times.map(t => {
      const x = Math.max(0, Math.min(1, (t - release) / (exit - release))), smooth = x * x * (3 - 2 * x);
      const old = pointValue(original, t);
      return [t, lane === 'filter' ? old + (.6 - old) * smooth : old * (1 - smooth)];
    }) });
  }
  return { name: 'stemless-bar-loop', auditionOnly: true, plan: { ...base, id: `${base.id}:stemless-bar-loop`, version: PLANNER_VERSION,
    automation, loopA: { start: chosen.start, end: chosen.end, until, crossfade: .006 },
    reasons: ['Пробная петля полного микса A с выходом через фильтр на границе такта; наличие вокала неизвестно, требуется прослушивание'],
    debug: { processingAllowed: base.debug.processingAllowed, humanScenario: { policy: 'stemless-loop-1', kind: 'stemless-bar-loop', auditionOnly: true,
      ...chosen, release, exit, candidates: choices.length, cycles: (until - chosen.start) / (chosen.end - chosen.start),
      limits: ['voice-unknown', 'envelope-repetition-is-not-instrumental', 'may-repeat-or-cut-words', 'requires-listening'] } } } };
}
