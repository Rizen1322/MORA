import type { AutoMixSettings, TrackAnalysis, TransitionPlan } from '../types.ts';
import { integrateTempo, pointValue } from './timing.ts';
import { vocalMean } from './vocals.ts';

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Preserve A's sung timing on small locks. B recovers alone after the overlap.
 * Retiming uses the exact existing source map, without another stretcher. */
export function withMasterTempo(p: TransitionPlan, A: TrackAnalysis | null, B: TrackAnalysis | null, s: AutoMixSettings, requestedAt?: number): TransitionPlan {
  if (!s.enabled || s.masterTempo === false || s.stemMixing === false || requestedAt !== undefined || !A || !B
    || p.debug.processingAllowed === false || p.method !== 'beatmatch_blend' || !p.tempoA?.length || !p.beatAlign
    || p.duration < 6 || p.loopA || p.vocalA || p.vocalB || p.voiceEcho || p.beatAlign.bridge || p.beatAlign.regions
    || !A.beat?.stable || !B.beat?.stable || A.beat.confidence < .8 || B.beat.confidence < .8
    || A.beat.jitterMs > 12 || B.beat.jitterMs > 12 || A.structure?.gridCheck?.periodHint || B.structure?.gridCheck?.periodHint) return p;
  const ratio = pointValue(p.tempoB, 0) / pointValue(p.tempoA, 0);
  const stretch = Math.max(Math.abs(ratio - 1), Math.abs(1 / ratio - 1)) * 100;
  if (!Number.isFinite(ratio) || stretch < .2 || stretch > Math.min(3, s.maxStretchPercent) + 1e-6) return p;
  for (const [t] of [...p.tempoA, ...p.tempoB]) {
    if (t > p.duration) return p;
    if (Math.abs(pointValue(p.tempoB, t) / pointValue(p.tempoA, t) - ratio) > 2e-6) return p;
  }
  const aEnd = p.aExit + integrateTempo(p.tempoA, p.duration);
  const bEnd = p.bEntry + integrateTempo(p.tempoB, p.duration);
  const covered = (an: TrackAnalysis, from: number, to: number) => {
    const v = an.vocalActivity;
    return !!v && Number.isFinite(v.rate) && v.rate > 0 && from >= 0 && to > from && to * v.rate <= v.values.length
      && v.values.slice(Math.floor(from * v.rate), Math.ceil(to * v.rate)).every(x => Number.isFinite(x) && x >= 0 && x <= 1);
  };
  const aVoiceEnd = p.aExit + (aEnd - p.aExit) * .6;
  const bIntroEnd = p.bEntry + Math.min(3, (bEnd - p.bEntry) * .3);
  if (!covered(A, p.aExit, aVoiceEnd) || vocalMean(A, p.aExit, aVoiceEnd) < .5
    || !covered(B, p.bEntry, bIntroEnd) || vocalMean(B, p.bEntry, bIntroEnd) > .2) return p;
  const duration = round(aEnd - p.aExit);
  if (duration > s.maxBlendSeconds || duration <= 0) return p;
  const recovery = round(Math.max(4, Math.min(8, A.beat.period * 8)));
  if (bEnd + recovery * Math.max(1, ratio) + 2 > B.audibleEnd) return p;
  const time = (t: number) => round(integrateTempo(p.tempoA, t));
  const tempoB: [number, number][] = [[0, ratio], [duration, ratio]];
  for (let i = 1; i <= 12; i++) {
    const x = i / 12, smooth = x * x * (3 - 2 * x);
    tempoB.push([round(duration + recovery * x), i === 12 ? 1 : ratio + (1 - ratio) * smooth]);
  }
  let echo = p.echo;
  if (echo) {
    let delay = A.beat.period;
    while (delay < .3) delay *= 2;
    while (delay > .8) delay /= 2;
    echo = { ...echo, delay: round(delay) };
  }
  return { ...p, duration, swapAt: time(p.swapAt), tempoA: undefined, tempoB, echo,
    automation: p.automation.map(l => ({ ...l, points: l.points.map(([t, gain]) => [time(t), gain]) })),
    beatAlign: { ...p.beatAlign, glide: false, masterDeck: 'A', recoverySeconds: recovery },
    reasons: [...p.reasons.filter(r => !r.startsWith('общий темп плавно переходит')),
      `темп текущего вокала сохраняется: следующий трек подстраивается, затем за ${recovery} с возвращается к своему темпу`],
    debug: { ...p.debug, ...(typeof p.debug.holdUntil === 'number' ? { holdUntil: time(p.debug.holdUntil) } : {}),
      masterTempo: { policy: 'vocal-master-1', deck: 'A', ratio, recoverySeconds: recovery, previousDuration: p.duration } },
  };
}
