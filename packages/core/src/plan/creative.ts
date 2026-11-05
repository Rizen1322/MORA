import { PLANNER_VERSION, type AutoMixSettings, type AutomationLane, type BeatGrid, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../types.ts';
import { fnv1a, normalizationGain } from './planner.ts';

/** Measured local recipes; desktop selection also keeps the ordinary planner as a fallback. */
export const CREATIVE_TRANSITION_STYLES = [
  { id: 'echo-pickup', name: 'Эхо + затакт', description: 'Ввести затакт B под A и ограниченным эхом, раскрыть его устойчивую сильную долю.' },
  { id: 'echo-adaptive', name: 'Адаптивное эхо', description: 'Подобрать атаку B по измеренным RMS и onset, сохранив начало записи.' },
  { id: 'natural-break', name: 'Естественный брейк', description: 'Подвести звучащий B к измеренной паузе A и плавно передать музыку.' },
  { id: 'half-time-handoff', name: 'Полутемповая передача', description: 'Передать бас на общей границе темпов 2:1 без растяжения.' },
  { id: 'percussion-exchange', name: 'Обмен перкуссией', description: 'Ввести верх B, освободить середину и затем передать бас.' },
  { id: 'two-stage-bass', name: 'Двухступенчатый бас', description: 'Сначала убрать низ A, затем в две доли ввести низ B.' },
  { id: 'dub-throw', name: 'Короткий dub throw', description: 'Один короткий посыл и два тихих повтора вместо длинного хвоста.' },
  { id: 'slowing-echo', name: 'Замедляющееся эхо', description: 'Замедлить последние повторы A поверх уже входящего более медленного B.' },
  { id: 'filter-arrival', name: 'Фильтр к приходу энергии', description: 'Раскрыть спектр B к измеренному подъёму его энергии.' },
  { id: 'tail-threshold', name: 'Вход по затуханию', description: 'Подвести B до затухания хвоста A и передать музыку на сильной доле.' },
  { id: 'short-brake', name: 'Короткий тормоз', description: 'Тормозить разреженную фразу A под уже входящим B и попасть в его сильную долю.' },
] as const;
export type CreativeTransitionStyle = (typeof CREATIVE_TRANSITION_STYLES)[number]['id'];

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
type Points = [number, number][];
const curveNames = ['rmsDb', 'lowDb', 'midDb', 'highDb', 'midDensity'] as const;
type CurveName = (typeof curveNames)[number];

function mean(values: number[], rate: number, from: number, to: number, power = false): number {
  const lo = Math.floor(from * rate), hi = Math.ceil(to * rate);
  if (!Number.isFinite(rate) || rate <= 0 || !Array.isArray(values) || lo < 0 || hi <= lo || hi > values.length) return NaN;
  let sum = 0;
  for (let i = lo; i < hi; i++) {
    if (!Number.isFinite(values[i])) return NaN;
    sum += power ? 10 ** (values[i] / 10) : values[i];
  }
  return power ? 10 * Math.log10(Math.max(1e-12, sum / (hi - lo))) : sum / (hi - lo);
}
function measured(an: TrackAnalysis, name: CurveName, from: number, to: number): number {
  return mean(an.curves[name], an.curves.rate, from, to, name !== 'midDensity');
}
function onset(an: TrackAnalysis, from: number, to: number): number {
  return an.local ? mean(an.local.transients, an.local.rate, from, to) : NaN;
}
function voiceClear(an: TrackAnalysis, from: number, to: number, limit = .25): boolean {
  const v = an.vocalActivity;
  if (!v) return true;
  const value = mean(v.values, v.rate, from, to);
  return Number.isFinite(value) && value <= limit;
}
function grid(an: TrackAnalysis): BeatGrid | null {
  const g = an.beat;
  if (!g || !g.stable || ![g.period, g.bpm, g.confidence, g.downbeatConfidence, g.jitterMs].every(Number.isFinite)
    || g.period < .25 || g.period > 1.5 || Math.abs(g.bpm * g.period - 60) > .6
    || g.confidence < .7 || g.downbeatConfidence < .65 || g.jitterMs > 25 || an.structure?.gridCheck?.periodHint
    || !Array.isArray(g.downbeats) || g.downbeats.length < 2
    || g.downbeats.some((t, i) => !Number.isFinite(t) || t < 0 || t > an.duration || i > 0 && t <= g.downbeats[i - 1])) return null;
  return g;
}
function analysis(track: PlannerTrack): TrackAnalysis | null {
  const a = track.analysis;
  if (!track.mixingAllowed || !a || ![track.duration, a.duration, a.audibleStart, a.audibleEnd, a.bodyRmsDb, a.curves?.rate].every(Number.isFinite)
    || a.curves.rate <= 0 || a.curves.rate > 200 || a.audibleStart < 0 || a.audibleEnd <= a.audibleStart
    || a.audibleEnd > Math.min(track.duration, a.duration) + 1e-6
    || curveNames.some(k => !Array.isArray(a.curves[k]) || a.curves[k].length < Math.ceil(a.audibleEnd * a.curves.rate))) return null;
  return a;
}

function points(knots: Points, end: number): Points {
  const sorted = knots.map(([t, v]) => [r3(clamp(t, 0, end)), r3(v)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: Points = [];
  for (const p of sorted) {
    if (out.length && out[out.length - 1][0] === p[0]) out[out.length - 1] = p;
    else out.push(p);
  }
  if (out[0][0] > 0) out.unshift([0, out[0][1]]);
  if (out[out.length - 1][0] < r3(end)) out.push([r3(end), out[out.length - 1][1]]);
  // Eight smooth samples per ramp avoid a new interpolation contract in either mixer.
  const smooth: Points = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const [a, x] = out[i - 1], [b, y] = out[i];
    for (let j = 1; j <= (x === y ? 1 : 8); j++) {
      const u = j / (x === y ? 1 : 8), t = r3(a + (b - a) * u), value = r3(x + (y - x) * u * u * (3 - 2 * u));
      if (t === smooth[smooth.length - 1][0]) smooth[smooth.length - 1][1] = value;
      else smooth.push([t, value]);
    }
  }
  return smooth;
}

/** Keep the outgoing music until the incoming recording actually has a musical bed, not merely a nonzero sample. */
function connectIncoming(p: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis, ga: BeatGrid, gb: BeatGrid, style: CreativeTransitionStyle, limit: number): TransitionPlan | null {
  if (style === 'percussion-exchange' || style === 'two-stage-bass') return p;
  const beat = ga.period, beatB = gb.period, bar = 4 * beat, oldPre = p.swapAt, oldDelay = p.bDelay ?? 0;
  const supportWindow = Math.max(4 * beatB, 2 * beat);
  const anchor = gb.downbeats.find(t => t >= B.audibleStart + beatB && t + supportWindow < B.audibleEnd
    && t - B.audibleStart < limit - bar
    && measured(B, 'rmsDb', t - 2 * beatB, t) >= B.bodyRmsDb - 8
    && measured(B, 'rmsDb', t - beatB, t) >= B.bodyRmsDb - 6
    && measured(B, 'rmsDb', t, t + beatB) >= B.bodyRmsDb - 6
    && measured(B, 'rmsDb', t, t + supportWindow) >= B.bodyRmsDb - 8);
  if (anchor === undefined) return null;
  if (style === 'half-time-handoff') {
    const low = measured(B, 'lowDb', anchor, anchor + beatB), bodyLow = measured(B, 'lowDb', B.audibleStart, B.audibleEnd);
    if (!Number.isFinite(low) || !Number.isFinite(bodyLow) || low < bodyLow - 6
      || low < measured(B, 'rmsDb', anchor, anchor + beatB) - 14) return null;
  }
  const incomingAge = anchor - p.bEntry;
  const pre = r3(Math.max(oldPre, Math.ceil((incomingAge + beat) / bar) * bar));
  const overlap = r3(Math.max(2 * beat, (style === 'slowing-echo' ? 3 : 2) * beatB));
  let event = p.aExit + oldPre;
  if (style === 'short-brake') {
    const accents = style === 'short-brake' && Array.isArray(ga.beats) && ga.beats.length ? ga.beats.filter(Number.isFinite) : ga.downbeats;
    event = accents.reduce((best, t) => Math.abs(t - event) < Math.abs(best - event) ? t : best, accents[0] ?? event);
  }
  const exit = r3(event - pre), duration = r3(pre + overlap), delay = r3(pre - incomingAge);
  if (exit < A.audibleStart + .025 || event + overlap > A.audibleEnd || duration > limit || delay < 0
    || anchor + overlap > B.audibleEnd) return null;
  const phaseDrift = style === 'half-time-handoff' ? Math.abs(Math.max(beat, beatB) / (2 * Math.min(beat, beatB)) - 1) * (duration - delay) : 0;
  if (phaseDrift > .02) return null;
  const originalAnchor = oldPre - oldDelay, bEnd = duration - delay;
  const neutral = (lane: AutomationLane['lane']) => ['echo', 'voiceEcho', 'filter'].includes(lane) ? 0 : 1;
  const lanes = p.automation.map(l => ({ ...l, points: points([[0, l.deck === 'A' ? neutral(l.lane) : l.points[0][1]],
    ...l.points.map(([t, v]) => [t + (l.deck === 'A' ? pre - oldPre : incomingAge - originalAnchor), v] as [number, number])], l.deck === 'A' ? duration : bEnd) }));
  const add = (deck: 'A' | 'B', lane: AutomationLane['lane'], knots: Points) => {
    const i = lanes.findIndex(l => l.deck === deck && l.lane === lane), value = { deck, lane, points: points(knots, deck === 'A' ? duration : bEnd) };
    if (i < 0) lanes.push(value); else lanes[i] = value;
  };
  const approach = Math.min(incomingAge - .05, Math.max(beat, beatB) * (style === 'short-brake' ? 2 : 1));
  add('A', 'gain', [[0, 1], [pre - approach, 1], [pre, .65], [duration, 0]]);
  // Run the preserved intro silently; only the last beat approaches the common accent.
  add('B', 'gain', [[0, 0], [incomingAge - approach, 0], [incomingAge, .85], [incomingAge + overlap, 1]]);
  // Bass is handed over on the common accent, rather than removed before B has any low end.
  const swap = Math.min(beat, beatB) * .5;
  add('A', 'low', [[0, 1], [pre - swap, 1], [pre, .707], [pre + swap, 0], [duration, 0]]);
  add('B', 'low', [[0, .12], [incomingAge - swap, .12], [incomingAge, .707], [incomingAge + swap, 1], [bEnd, 1]]);
  if (style === 'natural-break' || style === 'tail-threshold') {
    add('B', 'gain', [[0, 0], [incomingAge - approach, 0], [incomingAge, 1], [bEnd, 1]]);
    add('A', 'gain', [[0, 1], [pre - approach, 1], [pre, .5], [duration, 0]]);
  }
  if (style === 'tail-threshold') {
    add('A', 'gain', [[0, 1], [pre - approach, 1], [pre, .9], [duration, 0]]);
    add('B', 'gain', [[0, 0], [incomingAge - approach, 0], [incomingAge - .25 * beatB, .95], [incomingAge, 1], [bEnd, 1]]);
  }

  if (style === 'dub-throw') {
    add('A', 'echo', [[0, 0], [pre - beat, 0], [pre - .8 * beat, .32], [pre, .32], [pre + .1 * beat, 0], [duration, 0]]);
  }

  if (style === 'slowing-echo') {
    add('A', 'gain', [[0, 1], [pre - .04, 1], [pre + .04, 0], [duration, 0]]);
    add('A', 'echo', [[0, 0], [pre - beat, 0], [pre - .85 * beat, .7], [pre, .7], [pre + .04, 0], [duration, 0]]);
    // Let the repeats carry A's mids while B takes the beat and bass underneath.
    add('B', 'mid', [[0, .35], [incomingAge + beatB, .35], [incomingAge + 2 * beatB, 1], [bEnd, 1]]);
    add('B', 'high', [[0, .45], [incomingAge + beatB, .45], [incomingAge + 2 * beatB, 1], [bEnd, 1]]);
  }

  let tapeStopA = p.tapeStopA;
  if (style === 'short-brake') {
    const brake = clamp(beat, .25, .65);
    tapeStopA = { start: r3(event - brake), end: r3(event + .025), crossfade: .025 };
    add('A', 'gain', [[0, 1], [pre - brake, 1], [pre, .4], [pre + .025, 0], [duration, 0]]);
    add('B', 'gain', [[0, 0], [.04, .15], [Math.max(.05, incomingAge - approach), .35], [incomingAge, 1], [bEnd, 1]]);
  }
  const echo = p.echo ? { ...p.echo, feedback: style === 'slowing-echo' ? .62 : style === 'dub-throw' ? .32 : Math.min(.52, p.echo.feedback),
    delay: style === 'dub-throw' ? r3(beat) : p.echo.delay,
    clearAt: style === 'slowing-echo' ? duration : r3(Math.min(duration, Math.max(pre + beat, (p.echo.clearAt ?? p.duration) + pre - oldPre))),
    delayPoints: p.echo.delayPoints ? points(p.echo.delayPoints.map(([t, d]) => [t + pre - oldPre, d]), duration) : undefined } : undefined;
  const measuredInfo = (p.debug.creative as any)?.measured ?? {};
  const revision = style === 'short-brake' ? 2 : 3;
  const reasons = style === 'short-brake' ? p.reasons : [p.reasons[0], 'Вступление B до последней доли приглушено полностью; сильная доля B совмещена с передачей.'];
  return { ...p, id: `creative_${fnv1a('creative-' + revision + '|' + p.id + '|' + exit + '|' + anchor)}`, aExit: exit, duration,
    bDelay: delay, swapAt: pre, automation: lanes, tapeStopA, echo, reasons,
    entrySelection: { ...p.entrySelection!, arrivalTime: r3(anchor) },
    debug: { ...p.debug, creative: { ...(p.debug.creative as any), reasons: [...reasons], policy: 'audible-overlap-' + revision, measured: { ...measuredInfo,
      incomingAnchorSeconds: r3(anchor), incomingAnchorRmsDb: r3(measured(B, 'rmsDb', anchor, anchor + beatB)),
      incomingPrerollSeconds: r3(incomingAge), dryOverlapSeconds: overlap, handoffSourceA: r3(event),
      ...(style === 'half-time-handoff' ? { phaseDriftMs: r3(phaseDrift * 1000) } : {}) } } } };
}

/** A null result means this recording pair lacks the measurements or musical fit for the requested effect.
 * No sources are separated and no automatic planner/decorators are called. */
export function planCreativeTransition(a: PlannerTrack, b: PlannerTrack, settings: AutoMixSettings, style: CreativeTransitionStyle, preferredHandoffA?: number): TransitionPlan | null {
  const spec = CREATIVE_TRANSITION_STYLES.find(s => s.id === style), A = analysis(a), B = analysis(b);
  if (!spec || !settings.enabled || !A || !B || !Number.isFinite(settings.maxBlendSeconds) || settings.maxBlendSeconds <= 0) return null;
  const ga = grid(A), gb = grid(B);
  if (!ga || !gb) return null;
  const beat = ga.period, beatB = gb.period, bar = 4 * beat, barB = 4 * beatB, entry = B.audibleStart;
  const first = gb.downbeats.find(t => t >= entry - .002 && t <= entry + barB + .002);
  if (first === undefined) return null;
  const pickup = Math.max(0, first - entry), bEnd = B.audibleEnd;
  const bLevel = measured(B, 'rmsDb', entry, Math.min(bEnd, entry + beatB));
  const bDensity = measured(B, 'midDensity', entry, Math.min(bEnd, entry + barB));
  const bOnset = onset(B, entry, Math.min(bEnd, entry + beatB));
  if (![bLevel, bDensity].every(Number.isFinite)) return null;
  const nativeLock = Math.abs(beat / beatB - 1) <= .015;
  let pre = bar, delay = bar, duration = bar + barB, arrival = 0;
  if (style === 'echo-pickup') {
    if (pickup < .08 || pickup > bar - .05) return null;
    delay = pre - pickup;
  } else if (style === 'echo-adaptive') {
    if (!Number.isFinite(bOnset)) return null;
  } else if (style === 'natural-break') {
    pre = beat; delay = pre; duration = pre + barB;
  } else if (style === 'half-time-handoff') {
    if (Math.min(Math.abs(beat / beatB - 2), Math.abs(beatB / beat - 2)) > .03) return null;
    pre = 4 * Math.max(beat, beatB); delay = pre - pickup; duration = pre * 2;
  } else if (style === 'percussion-exchange' || style === 'two-stage-bass') {
    if (!nativeLock || pickup > bar - .05 || !settings.eqHandoff) return null;
    delay = bar - pickup; pre = 2 * bar; duration = 3 * bar;
  } else if (style === 'dub-throw') {
    pre = 2 * beat; delay = pre; duration = pre + barB;
  } else if (style === 'slowing-echo') {
    if (gb.bpm / ga.bpm < .5 || gb.bpm / ga.bpm > .82) return null;
    delay = pre + beatB; duration = delay + barB;
  } else if (style === 'filter-arrival') {
    if (!settings.eqHandoff || bDensity > .5 || !voiceClear(B, entry, Math.min(bEnd, entry + barB))) return null;
    const initial = measured(B, 'rmsDb', entry, entry + beatB), initialLow = measured(B, 'lowDb', entry, entry + beatB);
    const candidates = gb.downbeats.filter(t => t >= entry + beatB && t <= Math.min(bEnd - beatB, entry + 4 * barB));
    const rise = candidates.find(t => measured(B, 'rmsDb', t, t + beatB) - initial >= 5 && measured(B, 'lowDb', t, t + beatB) - initialLow >= 4);
    if (rise === undefined) return null;
    arrival = rise - entry; pre = arrival; delay = 0; duration = pre + barB;
  } else if (style === 'short-brake') {
    pre = beat; delay = pre + clamp(beat, .25, .65) - .03; duration = delay + barB;
  }
  duration = r3(duration); delay = r3(delay); pre = r3(pre);
  if (delay < 0 || duration > Math.min(60, settings.maxBlendSeconds) || entry + duration - delay > bEnd + 1e-6) return null;
  const rhythmic = style === 'half-time-handoff' || style === 'percussion-exchange' || style === 'two-stage-bass';
  let phaseDrift = 0;
  if (rhythmic) {
    const mismatch = style === 'half-time-handoff' ? Math.abs(Math.max(beat, beatB) / (2 * Math.min(beat, beatB)) - 1) : Math.abs(beat / beatB - 1);
    phaseDrift = mismatch * (style === 'half-time-handoff' ? pre + 2 * Math.min(beat, beatB) - delay : duration - delay);
    const swapSource = entry + pre - delay;
    const incomingLow = measured(B, 'lowDb', swapSource, swapSource + beatB);
    const incomingRms = measured(B, 'rmsDb', swapSource, swapSource + beatB);
    const bodyLow = measured(B, 'lowDb', entry, B.audibleEnd);
    if (phaseDrift > .02 || (style !== 'half-time-handoff' && (![incomingLow, incomingRms, bodyLow].every(Number.isFinite)
      || incomingLow < bodyLow - 6 || incomingLow < incomingRms - 14 || incomingRms < B.bodyRmsDb - 8))) return null;
    if (style === 'percussion-exchange') {
      const high = measured(B, 'highDb', entry, entry + barB), bodyHigh = measured(B, 'highDb', entry, B.audibleEnd);
      if (!Number.isFinite(high) || !Number.isFinite(bodyHigh) || high < bodyHigh - 8) return null;
    }
  }

  const earliest = Math.max(A.audibleStart + pre, A.audibleEnd * .55, A.audibleEnd - 40);
  const latest = A.audibleEnd - (duration - pre) - .025;
  let handoffs = ga.downbeats.filter(t => t >= earliest && t <= latest);
  if (style === 'tail-threshold') {
    handoffs = [];
    const threshold = A.bodyRmsDb - 14, rate = A.curves.rate;
    for (let i = Math.ceil(earliest * rate); i <= Math.floor(latest * rate); i++) {
      const t = i / rate;
      if (measured(A, 'rmsDb', t, t + beat * .5) <= threshold && measured(A, 'rmsDb', t - beat * .5, t) > threshold
        && measured(A, 'rmsDb', t - bar, t - bar + beat) > threshold + 2) handoffs.push(t);
    }
  }
  const marked = (t: number) => (A.phraseConfidence >= .5 && A.phrases.some(p => Math.abs(p - t) <= .06))
    || A.sectionBoundaries.some(p => Math.abs(p - t) <= .06);
  handoffs.sort((x, y) => Number(marked(y)) - Number(marked(x)) || y - x);
  if (Number.isFinite(preferredHandoffA)) handoffs.sort((x, y) => Math.abs(x - preferredHandoffA!) - Math.abs(y - preferredHandoffA!));
  for (const handoff of handoffs) {
    const exit = r3(handoff - pre), end = exit + duration, bClock = r3(duration - delay);
    if (exit < A.audibleStart || end > A.audibleEnd || exit < .025) continue;
    if (curveNames.some(k => !Number.isFinite(measured(A, k, exit, end)) || !Number.isFinite(measured(B, k, entry, entry + bClock)))) continue;
    const aLevel = measured(A, 'rmsDb', Math.max(exit, handoff - beat), handoff);
    if (rhythmic && measured(A, 'lowDb', Math.max(exit, handoff - beat), handoff) < aLevel - 14) continue;
    const aDensity = measured(A, 'midDensity', exit, Math.min(end, handoff + beat));
    const aOnset = onset(A, exit, Math.min(end, handoff + beat));
    const reasons = [spec.description, 'Начало B сохранено с первого слышимого сэмпла; вариант предназначен для прослушивания.'];
    const measuredInfo: Record<string, number | boolean> = {
      bpmA: r3(ga.bpm), bpmB: r3(gb.bpm), firstDownbeatB: r3(first), pickupSeconds: r3(pickup),
      outgoingRmsDb: r3(aLevel), incomingRmsDb: r3(bLevel), outgoingMidDensity: r3(aDensity), incomingMidDensity: r3(bDensity),
      phraseBoundary: marked(handoff), vocalActivityKnown: !!A.vocalActivity && !!B.vocalActivity,
    };
    if (rhythmic) measuredInfo.phaseDriftMs = r3(phaseDrift * 1000);
    if (Number.isFinite(aOnset)) measuredInfo.outgoingOnset = r3(aOnset);
    if (Number.isFinite(bOnset)) measuredInfo.incomingOnset = r3(bOnset);
    let score = .65 + (marked(handoff) ? .08 : 0);
    let attack = clamp(beatB * .35, .06, .3);
    const p: TransitionPlan = {
      id: '', version: PLANNER_VERSION, fromTrackId: a.id, toTrackId: b.id, method: 'crossfade', confidence: 0, reasons,
      aExit: exit, bEntry: r3(entry), duration, gap: 0, swapAt: pre, bDelay: delay, tempoB: [[0, 1]], automation: [],
      gainA: Number.isFinite(settings.loudnessTarget) && Number.isFinite(A.loudness.truePeakDb) ? normalizationGain(A, settings.loudnessTarget) : 0,
      gainB: Number.isFinite(settings.loudnessTarget) && Number.isFinite(B.loudness.truePeakDb) ? normalizationGain(B, settings.loudnessTarget) : 0,
      entrySelection: { kind: 'start', skippedSeconds: 0, arrivalTime: r3(first), confidence: r3(gb.downbeatConfidence) }, debug: {},
    };
    const add = (deck: 'A' | 'B', lane: AutomationLane['lane'], knots: Points) => {
      if (deck === 'B' && lane === 'gain') knots = [[0, 0], [.012, knots[0][1]], ...knots.filter(([t]) => t > .012)];
      const existing = p.automation.findIndex(l => l.deck === deck && l.lane === lane);
      const l = { deck, lane, points: points(knots, deck === 'A' ? duration : bClock) };
      if (existing < 0) p.automation.push(l); else p.automation[existing] = l;
    };
    const fadeA = (from: number, to: number) => add('A', 'gain', [[0, 1], [from, 1], [to, 0], [duration, 0]]);
    const openB = (time: number, initial = 0) => add('B', 'gain', [[0, initial], [time, 1], [bClock, 1]]);
    const echo = (feedback: number, clearAt: number, send = .45) => {
      p.method = 'echo_out'; p.echo = { delay: r3(.75 * beat), feedback, clearAt: r3(Math.min(duration, clearAt)) };
      add('A', 'echo', [[0, 0], [Math.max(0, pre - beat), 0], [pre - .4 * beat, send], [pre, send], [pre + .06, 0], [duration, 0]]);
    };
    fadeA(pre - .2 * beat, pre + .2 * beat); openB(attack);
    if (style === 'echo-pickup') {
      if (!voiceClear(A, handoff - beat, handoff + .2 * beat, .4)) continue;
      echo(.55, pre + Math.min(2 * beat, barB), .38);
      add('B', 'gain', [[0, .55], [.025, .65], [Math.max(.026, pickup - .05), .7], [pickup + .06, 1], [bClock, 1]]);
      measuredInfo.pickupRetained = true; score += .08;
    } else if (style === 'echo-adaptive') {
      const load = clamp((bLevel - B.bodyRmsDb + 8) / 12) * .6 + clamp(bOnset) * .4;
      attack = clamp(beatB * (.16 + .8 * load), .055, .7);
      const voice = B.vocalActivity && mean(B.vocalActivity.values, B.vocalActivity.rate, entry, entry + Math.min(.3, beatB));
      if (voice && voice > .3) attack = Math.min(attack, .08);
      echo(.48, pre + 2 * beat, .34); openB(attack, .12);
      measuredInfo.attackSeconds = r3(attack); measuredInfo.attackLoad = r3(load); score += .04;
    } else if (style === 'natural-break') {
      const after = measured(A, 'rmsDb', handoff, handoff + beat * .75), drop = aLevel - after;
      if (drop < 7 || after > A.bodyRmsDb - 9) continue;
      fadeA(pre - .025, pre + .06); openB(clamp(beatB * .15, .025, .1), .2);
      measuredInfo.breakDropDb = r3(drop); measuredInfo.breakRmsDb = r3(after); score += clamp(drop / 60, 0, .18);
    } else if (style === 'half-time-handoff') {
      p.method = 'beatmatch_blend';
      add('A', 'low', [[0, 1], [pre - .3 * Math.min(beat, beatB), 1], [pre, 0], [duration, 0]]);
      add('B', 'low', [[0, 0], [pickup, 0], [pickup + .5 * Math.min(beat, beatB), 1], [bClock, 1]]);
      fadeA(pre, pre + 2 * Math.min(beat, beatB)); openB(Math.max(.08, pickup + .05), .5);
      measuredInfo.tempoRelation = ga.bpm > gb.bpm ? 2 : .5; measuredInfo.nativeTempo = true; score += .1;
    } else if (style === 'percussion-exchange') {
      if (aDensity > .4 || bDensity > .4 || !Number.isFinite(aOnset) || !Number.isFinite(bOnset) || aOnset < .25 || bOnset < .25
        || !voiceClear(A, exit, handoff + beat) || !voiceClear(B, entry, entry + bClock)) continue;
      p.method = 'beatmatch_blend';
      add('A', 'high', [[0, 1], [delay, 1], [delay + beat, .25], [duration, 0]]);
      add('A', 'mid', [[0, 1], [delay, 1], [pre, .2], [duration, 0]]);
      add('B', 'mid', [[0, .2], [pickup + beat, .35], [pre - delay, .7], [pre - delay + beat, 1]]);
      add('A', 'low', [[0, 1], [pre - .2 * beat, 1], [pre + .2 * beat, 0]]);
      add('B', 'low', [[0, 0], [pre - delay - .2 * beat, 0], [pre - delay + .2 * beat, 1]]);
      fadeA(pre, duration); openB(pickup + bar, .65); score += .08;
    } else if (style === 'two-stage-bass') {
      const lowA = measured(A, 'lowDb', handoff - beat, handoff), lowB = measured(B, 'lowDb', entry, entry + barB);
      if (lowA < aLevel - 12 || lowB < bLevel - 14) continue;
      p.method = 'beatmatch_blend';
      add('A', 'low', [[0, 1], [pre - beat, 1], [pre - .5 * beat, .25], [pre - .15 * beat, 0]]);
      add('B', 'low', [[0, 0], [pre - delay, 0], [pre - delay + beatB, .55], [pre - delay + 2 * beatB, 1]]);
      add('A', 'mid', [[0, 1], [pre, .65], [pre + beat, 0]]);
      add('B', 'mid', [[0, .45], [pre - delay, .7], [pre - delay + beatB, 1]]);
      fadeA(pre, duration); openB(pickup + beatB, .6);
      measuredInfo.outgoingLowDb = r3(lowA); measuredInfo.incomingLowDb = r3(lowB); score += .06;
    } else if (style === 'dub-throw') {
      if (aDensity > .45 || !Number.isFinite(aOnset) || aOnset < .35 || !voiceClear(A, handoff - beat, handoff + .1, .2)) continue;
      echo(.25, pre + 1.25 * beat, .6);
      add('A', 'echo', [[0, 0], [pre - beat, 0], [pre - .9 * beat, .6], [pre - .65 * beat, .6], [pre - .55 * beat, 0], [duration, 0]]);
      fadeA(pre - .06, pre + .04); openB(Math.min(.12, .25 * beatB), .25); score += .05;
    } else if (style === 'slowing-echo') {
      if (aLevel < A.bodyRmsDb - 6 || !Number.isFinite(aOnset) || aOnset < .25 || !voiceClear(A, handoff - beat, handoff + .1, .25)) continue;
      echo(.56, delay + beatB, .5);
      const slowEnd = pre + Math.max(2 * beat, beatB);
      p.echo!.delayPoints = [[0, r3(.75 * beat)], [pre, r3(.75 * beat)], [r3(slowEnd), r3(beatB)], [duration, r3(beatB)]];
      add('A', 'low', [[0, 1], [pre, .25], [pre + .2 * beat, 0]]);
      measuredInfo.finalEchoDelay = r3(beatB); score += .04;
    } else if (style === 'filter-arrival') {
      const rise = measured(B, 'rmsDb', entry + arrival, entry + arrival + beatB) - bLevel;
      add('B', 'filter', [[0, -.7], [arrival * .5, -.5], [arrival, 0]]);
      add('B', 'low', [[0, .25], [Math.max(0, arrival - beatB), .25], [arrival, 1]]);
      add('A', 'filter', [[0, 0], [Math.max(0, pre - beat), 0], [pre + .25 * beat, .7]]);
      fadeA(Math.max(0, pre - beat), pre + .5 * beat); openB(Math.min(beatB, arrival * .5), .65);
      p.entrySelection!.arrivalTime = r3(entry + arrival); measuredInfo.energyRiseDb = r3(rise); measuredInfo.arrivalSeconds = r3(arrival); score += .08;
    } else if (style === 'tail-threshold') {
      const tail = measured(A, 'rmsDb', handoff, handoff + .5 * beat);
      if (tail > A.bodyRmsDb - 14) continue;
      fadeA(pre, pre + beat); openB(Math.min(.15, .25 * beatB), .3);
      measuredInfo.thresholdDb = r3(A.bodyRmsDb - 14); measuredInfo.tailRmsDb = r3(tail); score += .1;
    } else if (style === 'short-brake') {
      const brake = clamp(beat, .25, .65), stopEnd = handoff + brake;
      if (aDensity > .25 || !Number.isFinite(aOnset) || aOnset > .25 || aLevel > A.bodyRmsDb - 3 || aLevel < A.bodyRmsDb - 20
        || !voiceClear(A, handoff - .025, stopEnd, .12)) continue;
      p.method = 'drop_mix'; p.tapeStopA = { start: r3(handoff), end: r3(stopEnd), crossfade: .025 };
      fadeA(pre + brake - .025, pre + brake);
      attack = Number.isFinite(bOnset) ? clamp(.05 + bOnset * .08, .05, .13) : .08;
      openB(attack, .72); p.swapAt = delay;
      measuredInfo.brakeSeconds = r3(brake); measuredInfo.attackSeconds = r3(attack); score -= .02;
    }
    p.confidence = r3(clamp(score));
    p.debug = { processingAllowed: true, creative: { style, name: spec.name, score: p.confidence, reasons: [...reasons], experimental: true,
      limits: ['requires-listening', ...(!A.vocalActivity || !B.vocalActivity ? ['vocal-overlap-unknown'] : [])], measured: measuredInfo } };
    const key = [a.id, b.id, style, p.aExit, p.bEntry, p.duration, p.gainA, p.gainB].join('|');
    p.id = `creative_${fnv1a('creative-1|' + key)}`;
    const connected = connectIncoming(p, A, B, ga, gb, style, Math.min(60, settings.maxBlendSeconds));
    if (connected) {
      if (!settings.eqHandoff) connected.automation = connected.automation.filter(l => !['low', 'mid', 'high', 'filter'].includes(l.lane));
      return connected;
    }
  }
  return null;
}
