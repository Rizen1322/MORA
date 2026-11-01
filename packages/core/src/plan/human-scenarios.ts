import { PLANNER_VERSION, type AutoMixSettings, type TrackAnalysis, type TransitionPlan } from '../types.ts';
import { integrateTempo, outputTimeAt, pointValue } from './timing.ts';

/** Counterfactual for a recorded drum rotation: retain the entire mix, but put
 * B back on its measured bar phase. An averaged kick/snare pattern is not proof
 * that moving the song's musical downbeat improves the transition. Manual only. */
export function measuredBarEntryAudition(base: TransitionPlan, B: TrackAnalysis, s: AutoMixSettings): { name: string; plan: TransitionPlan; auditionOnly: true } | null {
  const grid = B.beat, rotation = (base.debug.drumPattern as { k?: number } | undefined)?.k;
  if (!s.enabled || base.debug.processingAllowed === false || base.method !== 'beatmatch_blend' || !base.beatAlign
    || base.beatAlign.relation !== 1 || !grid?.stable || !Number.isInteger(rotation) || !rotation || rotation < 1 || rotation > 3
    || base.echo || base.voiceEcho || base.loopA || base.tapeStopA || base.vocalA || base.vocalB
    || base.gap !== 0 || (base.bDelay ?? 0) !== 0 || !(grid.period > 0)
    || ![base.bEntry, base.duration, B.audibleStart, B.audibleEnd, B.duration, grid.period].every(Number.isFinite)) return null;
  const span = integrateTempo(base.tempoB, base.duration);
  const skip = s.entryMode === 'preserve' || s.maxEntrySkipSeconds === 0 ? 0
    : Math.min(s.maxEntrySkipSeconds ?? 45, (B.audibleEnd - B.audibleStart) * 0.45);
  const targets = [base.bEntry - rotation * grid.period, base.bEntry + (4 - rotation) * grid.period];
  const entry = grid.downbeats.filter(t => Number.isFinite(t) && targets.some(target => Math.abs(t - target) <= 0.03)
    && t >= B.audibleStart && t <= B.audibleStart + skip + 0.001 && t + span <= Math.min(B.duration, B.audibleEnd))
    .sort((a, b) => Math.abs(a - base.bEntry) - Math.abs(b - base.bEntry))[0];
  if (entry === undefined || !Number.isFinite(span) || span <= 0) return null;
  return { name: 'measured-bar-entry', auditionOnly: true, plan: { ...base, id: `${base.id}:measured-bar-entry`, version: PLANNER_VERSION,
    bEntry: entry, beatAlign: { ...base.beatAlign, phraseAligned: false },
    entrySelection: { kind: entry - B.audibleStart < 1 ? 'start' : 'intro-trim', skippedSeconds: Math.max(0, entry - B.audibleStart), confidence: grid.downbeatConfidence },
    reasons: ['Пробный вход B на измеренной сильной доле без поворота рисунка ударных; исходное сведение сохранено'],
    debug: { processingAllowed: base.debug.processingAllowed, humanScenario: { policy: 'human-1', kind: 'measured-bar-entry', auditionOnly: true,
      originalEntry: base.bEntry, restoredEntry: entry, originalRotation: rotation, downbeatConfidence: grid.downbeatConfidence,
      limits: ['bar-grid-may-be-wrong', 'voice-unknown', 'requires-listening'] } } } };
}

/** Manual-only comparison anchored to a measured A structural closure and a B
 * downbeat. B's clock waits until the final two bars, so both decks meet at
 * that boundary instead of leaving B full under A's outgoing tail. */
export function closureAlignedHandoffAudition(base: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis, s: AutoMixSettings): { name: string; plan: TransitionPlan; auditionOnly: true } | null {
  const ga = A.beat, gb = B.beat, alignment = base.beatAlign;
  if (!s.enabled || base.debug.processingAllowed === false || base.method !== 'beatmatch_blend' || !alignment
    || base.loopA || base.echo || base.voiceEcho || base.tapeStopA || base.vocalA || base.vocalB || base.gap !== 0 || (base.bDelay ?? 0) !== 0
    || !ga?.stable || !gb?.stable || ga.confidence < 0.8 || gb.confidence < 0.8
    || ga.downbeatConfidence < 0.8 || gb.downbeatConfidence < 0.8
    || ga.jitterMs > 20 || gb.jitterMs > 20
    || ![ga.bpm, ga.period, ga.confidence, ga.downbeatConfidence, ga.jitterMs, gb.bpm, gb.period, gb.confidence,
      gb.downbeatConfidence, gb.jitterMs, alignment.bpmA, alignment.bpmB, alignment.ratio, base.aExit, base.bEntry,
      base.duration, base.swapAt, base.confidence, base.gap, s.maxBlendSeconds,
      A.audibleStart, A.audibleEnd, A.duration, A.phraseConfidence, B.audibleStart, B.audibleEnd, B.duration, B.phraseConfidence].every(Number.isFinite)
    || ga.bpm <= 0 || gb.bpm <= 0 || ga.period <= 0 || gb.period <= 0 || base.duration <= 0
    || Math.abs(ga.bpm / alignment.bpmA - 1) > 0.01 || Math.abs(gb.bpm / alignment.bpmB - 1) > 0.01
    || Math.abs(alignment.ratio / (ga.bpm / gb.bpm) - 1) > 0.01
    || ![base.tempoA, base.tempoB].every(map => !map || (map.length > 0 && map.every(([t, v], i) => Number.isFinite(t) && Number.isFinite(v)
      && t >= 0 && t <= base.duration && v > 0 && (i === 0 ? t === 0 : t > map[i - 1][0]))))) return null;
  const gainA = base.automation.filter(l => l.deck === 'A' && l.lane === 'gain');
  const gainB = base.automation.filter(l => l.deck === 'B' && l.lane === 'gain');
  if (gainA.length !== 1 || gainB.length !== 1 || gainA[0].points.length < 2 || gainB[0].points.length < 2
    || [gainA[0].points, gainB[0].points].some(points => points.some(([t, v], i, xs) => !Number.isFinite(t) || !Number.isFinite(v)
      || t < 0 || t > base.duration || v < 0 || v > 1 || (i > 0 && t <= xs[i - 1][0])))) return null;
  const aEnd = Math.min(A.duration, A.audibleEnd), bEnd = Math.min(B.duration, B.audibleEnd);
  const endpoint = base.aExit + integrateTempo(base.tempoA, base.duration);
  const closeCandidates = (A.structure?.segments ?? []).filter(segment => segment.endClosure >= 0.8 && Number.isFinite(segment.end)
    && segment.end >= Math.max(A.audibleStart, base.aExit) && segment.end <= aEnd
    && ga.downbeats.some(t => Math.abs(t - segment.end) <= Math.max(0.06, ga.period * 0.15)))
    .sort((x, y) => Math.abs(x.end - endpoint) - Math.abs(y.end - endpoint));
  const close = closeCandidates[0]?.end;
  if (close === undefined) return null;
  const duration = outputTimeAt(base.tempoA, close - base.aExit, Math.max(base.duration + 4, s.maxBlendSeconds));
  const beatOut = ga.period / pointValue(base.tempoA ?? [[0, 1]], duration);
  if (![duration, beatOut].every(Number.isFinite) || duration < 8 * beatOut || duration > s.maxBlendSeconds
    || Math.abs(duration - base.duration) > 2 * beatOut || base.aExit < A.audibleStart
    || base.aExit + integrateTempo(base.tempoA, duration) > aEnd + 0.001) return null;
  const fadeStart = duration - 8 * beatOut, bSpan = duration - fadeStart;
  const sliceMap = (map: [number, number][] | undefined, from: number, to: number): [number, number][] => {
    const source = map?.length ? map : [[0, 1] as [number, number]];
    return [[0, pointValue(source, from)], ...source.filter(([t]) => t > from && t < to).map(([t, v]) => [t - from, v] as [number, number]),
      [to - from, pointValue(source, to)]];
  };
  const bTempo = sliceMap(base.tempoB, fadeStart, duration), bAdvance = integrateTempo(bTempo, bSpan);
  const bChoices = gb.downbeats.filter(t => Number.isFinite(t) && t >= B.audibleStart && t <= bEnd)
    .map(t => ({ downbeat: t, entry: t - bAdvance }))
    .filter(x => x.entry >= B.audibleStart - 0.001 && x.entry <= bEnd - bAdvance + 0.001
      && Math.abs(x.entry - base.bEntry) <= 1.5 * gb.period + 0.001)
    .sort((x, y) => Math.abs(x.entry - base.bEntry) - Math.abs(y.entry - base.bEntry));
  const selectedB = bChoices[0];
  if (!selectedB) return null;
  const { bEntry, bDownbeat } = { bEntry: selectedB.entry, bDownbeat: selectedB.downbeat };
  const startGain = pointValue(gainA[0].points, fadeStart);
  const times = [...new Set([...gainA[0].points.filter(([t]) => t < fadeStart).map(([t]) => t), fadeStart,
    ...Array.from({ length: 17 }, (_, i) => fadeStart + (duration - fadeStart) * i / 16), duration])].sort((x, y) => x - y);
  const aPoints: [number, number][] = times.map(t => {
    if (t <= fadeStart) return [t, pointValue(gainA[0].points, t)];
    const x = (t - fadeStart) / (duration - fadeStart), eased = x * x * (3 - 2 * x);
    return [t, startGain * (1 - eased)];
  });
  const bPoints: [number, number][] = Array.from({ length: 17 }, (_, i) => {
    const t = bSpan * i / 16, x = i / 16;
    return [t, x * x * (3 - 2 * x)];
  });
  const trimMap = (map: [number, number][] | undefined, end: number): [number, number][] => {
    const source = map?.length ? map : [[0, 1] as [number, number]];
    return [...source.filter(([t]) => t < end), [end, pointValue(source, end)]];
  };
  const { fullMix: _fullMix, ratingFeedback: _ratingFeedback, renderCheck: _renderCheck, ...debugBase } = base.debug;
  return { name: 'closure-aligned-handoff', auditionOnly: true, plan: { ...base,
    id: `${base.id}:closure-aligned-handoff`, version: PLANNER_VERSION, duration, bEntry, bDelay: fadeStart, swapAt: duration,
    tempoA: trimMap(base.tempoA, duration), tempoB: bTempo,
    beatAlign: { ...alignment, overlapBeats: 8 },
    confidence: Math.min(base.confidence, 0.5), automation: [
      { deck: 'A', lane: 'gain', points: aPoints }, { deck: 'B', lane: 'gain', points: bPoints }],
    entrySelection: base.entrySelection ? { ...base.entrySelection, skippedSeconds: Math.max(0, bEntry - B.audibleStart),
      arrivalTime: bDownbeat, confidence: Math.min(base.entrySelection.confidence, gb.downbeatConfidence) } : undefined,
    reasons: ['Пробный двухтактовый переход от измеренного закрытия A к доле B; требуется прослушивание'],
    debug: { ...debugBase, humanScenario: { policy: 'human-1', kind: 'closure-aligned-handoff', auditionOnly: true,
      sourceEndA: close, sourceEndB: bDownbeat, sourceStartB: bEntry, bDelay: fadeStart, fadeBeats: 8,
      sourceClosureConfidence: closeCandidates[0].endClosure, phraseGridConfidenceA: A.phraseConfidence,
      phraseGridConfidenceB: B.phraseConfidence, phraseGridTrustedA: A.phraseConfidence >= 0.65,
      phraseGridTrustedB: B.phraseConfidence >= 0.65,
      limits: ['structure-is-not-word-timing', 'voice-and-rhythm-unknown', 'requires-listening'] } } } };
}

/** Whole-deck, native-speed relay for listening only. Neither the structure
 * analysis nor a quiet tail establishes a word ending or a pleasant cut. */
export function sequentialRelayAudition(base: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis, s: AutoMixSettings): { name: string; plan: TransitionPlan; auditionOnly: true } | null {
  if (!s.enabled || base.debug.processingAllowed === false) return null;
  const endA = Math.min(A.duration, A.audibleEnd), entry = Math.max(0, B.audibleStart), endB = Math.min(B.duration, B.audibleEnd);
  const hold = 0.85, fade = 0.15, separation = 0.05, bSpan = 0.5, duration = hold + fade + separation + bSpan;
  if (![endA, entry, endB, A.audibleStart, base.aExit, s.maxBlendSeconds].every(Number.isFinite)
    || s.maxBlendSeconds < duration || endB - entry < bSpan) return null;
  const afterClosure = separation + bSpan, minClose = Math.max(A.audibleStart + hold + fade, base.aExit + hold + fade, endA - 12);
  const maxClose = endA - afterClosure;
  let close = (A.structure?.segments ?? []).filter(x => Number.isFinite(x.end) && x.endClosure >= 0.75
    && x.end >= minClose && x.end <= maxClose).map(x => x.end).sort((a, b) => b - a)[0];
  let evidence = 'measured structural closure';
  if (close === undefined) {
    // The untouched tail after the proposed cut must actually be measured
    // quiet; the last half-second is still read while B starts.
    const c = A.curves, rate = c?.rate, from = Math.floor((endA - 1.5) * rate), to = Math.ceil(endA * rate);
    if (!(rate > 0) || from < 0 || to > c.rmsDb.length || !Number.isFinite(A.bodyRmsDb)) return null;
    const values = c.rmsDb.slice(from, to);
    if (!values.length || !values.every(Number.isFinite)) return null;
    const mean = 10 * Math.log10(values.reduce((sum, db) => sum + 10 ** (db / 10), 0) / values.length);
    if (!(mean < A.bodyRmsDb - 10) || maxClose < minClose) return null;
    close = maxClose; evidence = 'measured quiet end tail';
  }
  const { beatAlign: _beat, tempoA: _ta, loopA: _loop, tapeStopA: _stop, vocalA: _va, vocalB: _vb,
    echo: _echo, voiceEcho: _ve, entrySelection: _entry, fallbackReason: _fallback, ...clean } = base;
  const bDelay = hold + fade + separation;
  return { name: 'sequential-relay', auditionOnly: true, plan: { ...clean, id: `${base.id}:sequential-relay`, version: PLANNER_VERSION,
    method: 'phrase_cut', aExit: close - hold - fade, bEntry: entry, duration, gap: 0, bDelay, swapAt: bDelay,
    tempoB: [[0, 1]], confidence: Math.min(base.confidence, 0.5),
    automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [hold, 1], [hold + fade, 0], [duration, 0]] },
      { deck: 'B', lane: 'gain', points: [[0, 0], [0.05, 1], [bSpan, 1]] }],
    entrySelection: { kind: 'start', skippedSeconds: 0, confidence: 1 },
    reasons: ['Пробная последовательная передача: A уходит до запуска B; требуется прослушивание'],
    debug: { humanScenario: { policy: 'human-1', kind: 'sequential-relay', auditionOnly: true, evidence,
      sourceEndA: close, remainingASeconds: Math.max(0, endA - close), preservedOpeningB: true, nativeTempo: true,
      limits: ['may-cut-A-phrase', 'structure-is-not-word-timing', 'not-beatmatched', 'requires-listening'] } },
  } };
}

/** Manual gain-only hypothesis. Keep B at least as audible as in the source
 * plan, then bring it to full level over a short window around the handoff.
 * Complement A throughout B's clock so overlap is reduced before B is full. */
export function complementaryHandoffAudition(base: TransitionPlan): { name: string; plan: TransitionPlan; auditionOnly: true } | null {
  if (base.method !== 'beatmatch_blend' || !base.beatAlign || base.debug.processingAllowed === false
    || base.loopA || base.echo || base.voiceEcho || base.tapeStopA || base.vocalA || base.vocalB || base.gap !== 0) return null;
  const delay = base.bDelay ?? 0, duration = base.duration, span = duration - delay;
  const gainA = base.automation.filter(l => l.deck === 'A' && l.lane === 'gain');
  const gainB = base.automation.filter(l => l.deck === 'B' && l.lane === 'gain');
  const points = gainB[0]?.points;
  const bpm = base.beatAlign.bpmA;
  if (![delay, duration, base.swapAt, bpm].every(Number.isFinite) || delay < 0 || span < 1 || base.swapAt < delay || base.swapAt > duration || bpm <= 0
    || gainA.length !== 1 || gainB.length !== 1 || !points || points.length < 2
    || points.some(([t, v], i) => !Number.isFinite(t) || !Number.isFinite(v) || t < 0 || t > span || v < 0 || v > 1 || (i > 0 && t <= points[i - 1][0]))
    || points[0][0] !== 0 || points[0][1] !== 0 || points.at(-1)![0] !== span || points.at(-1)![1] !== 1) return null;
  const width = Math.min(3, Math.max(1, 240 / bpm), span);
  const start = Math.max(0, Math.min(span - width, base.swapAt - delay - width / 2)), end = start + width;
  const ramp = (t: number) => Math.max(0, Math.min(1, (t - start) / width));
  const knots = [...new Set([0, span, start, end, ...points.map(([t]) => t)])].sort((a, b) => a - b);
  // Include intersections so piecewise linear interpolation really is max(old, ramp).
  const intersections: number[] = [];
  for (let i = 1; i < knots.length; i++) {
    const l = knots[i - 1], r = knots[i], dl = pointValue(points, l) - ramp(l), dr = pointValue(points, r) - ramp(r);
    if (dl * dr < 0) intersections.push(l + (r - l) * dl / (dl - dr));
  }
  const times = [...knots, ...intersections].sort((a, b) => a - b);
  const bPoints: [number, number][] = times.map(t => [t, Math.max(pointValue(points, t), ramp(t))]);
  const aPoints: [number, number][] = [...(delay > 0 ? [[0, 1] as [number, number]] : []),
    ...bPoints.map(([t, v]): [number, number] => [t + delay, 1 - v])];
  return { name: 'complementary-handoff', auditionOnly: true, plan: { ...base, id: `${base.id}:complementary-handoff`, version: PLANNER_VERSION,
    automation: base.automation.map(l => l === gainA[0] ? { ...l, points: aPoints } : l === gainB[0] ? { ...l, points: bPoints } : l),
    reasons: [...base.reasons, 'Пробная встречная передача громкости; требуется прослушивание'],
    debug: { ...base.debug, humanScenario: { policy: 'human-1', kind: 'complementary-handoff', auditionOnly: true,
      start: start + delay, end: end + delay, limits: ['original-intro-may-be-quiet', 'voice-and-rhythm-unknown', 'requires-listening'] } } } };
}

/** Manual comparison: clear the entire outgoing deck after the incoming deck
 * has arrived, while leaving the original blend length, grids and B intact.
 * This can cut A's phrase, so it must never enter automatic selection. */
export function cleanOutAudition(base: TransitionPlan, A: TrackAnalysis): { name: string; plan: TransitionPlan; auditionOnly: true } | null {
  if (base.method !== 'beatmatch_blend' || !base.beatAlign || base.loopA || base.echo || base.tapeStopA || base.duration < 4) return null;
  const gainA = base.automation.find(l => l.deck === 'A' && l.lane === 'gain');
  if (!gainA || !A.beat?.stable || !(A.beat.period > 0)) return null;
  const b = (lane: 'gain' | 'low' | 'mid' | 'high', t: number) =>
    pointValue(base.automation.find(l => l.deck === 'B' && l.lane === lane)?.points ?? [[0, 1]], t);
  const delay = base.bDelay ?? 0;
  let start = -1;
  for (let t = Math.max(0, delay); t <= base.duration - 1; t += 0.05) {
    const tb = t - delay;
    if (['gain', 'low', 'mid', 'high'].every(l => b(l as 'gain' | 'low' | 'mid' | 'high', tb) >= 0.95)
      && pointValue(base.automation.find(l => l.deck === 'B' && l.lane === 'filter')?.points ?? [[0, 0]], tb) === 0
      && pointValue(gainA.points, t) >= 0.3) { start = t; break; }
  }
  if (start < 0) return null;
  const tempo = pointValue(base.tempoA ?? [[0, 1]], start);
  if (!(tempo > 0)) return null;
  const end = Math.min(base.duration, start + 4 * A.beat.period / tempo);
  if (end - start < 1) return null;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const knots = [...new Set([...gainA.points.map(([t]) => t), ...Array.from({ length: 17 }, (_, i) => r3(start + (end - start) * i / 16))])].sort((a, b) => a - b);
  const points = knots.map(t => [t, r3(pointValue(gainA.points, t) * (t <= start ? 1 : t >= end ? 0 : Math.cos((t - start) / (end - start) * Math.PI / 2)))] as [number, number]);
  return { name: 'clean-out', auditionOnly: true, plan: { ...base, id: `${base.id}:clean-out`,
    automation: base.automation.map(l => l === gainA ? { ...l, points } : l),
    reasons: [...base.reasons, 'Пробный плавный выход всей деки A после прихода B; требуется прослушивание'],
    debug: { ...base.debug, humanScenario: { policy: 'human-1', kind: 'clean-out', auditionOnly: true, start: r3(start), end: r3(end), limits: ['may-cut-A-phrase', 'requires-listening'] } } } };
}

/** Alternatives with a musical event as their anchor. These are hypotheses to audition,
 * not vocal-safe guarantees: structural boundaries do not identify sung word endings. */
export function humanTransitionScenarios(base: TransitionPlan, A: TrackAnalysis, B: TrackAnalysis, s: AutoMixSettings): { name: string; plan: TransitionPlan; auditionOnly?: boolean }[] {
  const result: { name: string; plan: TransitionPlan; auditionOnly?: boolean }[] = [];
  if (!s.enabled || base.debug.processingAllowed === false) return result;
  const endA = Math.min(A.duration, A.audibleEnd), entry = Math.max(0, B.audibleStart);
  const roomB = Math.min(B.duration, B.audibleEnd) - entry;
  if (![endA, entry, roomB, s.maxBlendSeconds].every(Number.isFinite) || roomB < 0.5 || endA - A.audibleStart < 0.5 || s.maxBlendSeconds < 0.5) return result;
  const addManual = () => {
    const complementary = complementaryHandoffAudition(base); if (complementary) result.push(complementary);
    const cleanOut = cleanOutAudition(base, A); if (cleanOut) result.push(cleanOut);
    const relay = sequentialRelayAudition(base, A, B, s); if (relay) result.push(relay);
  };
  const bothUnknown = s.stemMixing === false || (!A.vocalActivity && !B.vocalActivity);
  const ordinaryAuto = bothUnknown && s.style === 'auto';
  // Absence of a global grid is not proof that a locally aligned plan is shaky.
  const shakyGrid = [A.beat, B.beat].some(g => g && (g.confidence < 0.55 || g.jitterMs > 20));
  const strongClosure = (end: number) => !!A.structure?.segments.some(segment => segment.endClosure >= 0.75 && Math.abs(segment.end - end) < 0.001);
  // Preserve the musical opening even in smart mode. A quiet, unplayed opening is
  // not an instrumental cue; silently consuming it would discard first words.
  const add = (name: string, end: number, span: number, delay: number, fade: number, evidence: string) => {
    const start = end - span, bSpan = span - delay;
    if (start < Math.max(A.audibleStart, base.aExit) - 0.001 || end > endA || bSpan > roomB || bSpan < 0.1) return;
    const { beatAlign: _beat, tempoA: _ta, loopA: _loop, tapeStopA: _stop, vocalA: _va, vocalB: _vb,
      echo: _echo, voiceEcho: _ve, entrySelection: _entry, fallbackReason: _fallback, ...clean } = base;
    const pointsA: [number, number][] = [[0, 1]];
    if (span > fade) pointsA.push([span - fade, 1]);
    pointsA.push([span, 0]);
    const attack = Math.min(0.12, bSpan / 3);
    const auditionOnly = !(ordinaryAuto && (!base.beatAlign || shakyGrid) && (name === 'natural-tail-start'
      || name === 'section-handoff' && strongClosure(end)));
    result.push({ name, auditionOnly, plan: { ...clean, id: `${base.id}:${name}`, version: PLANNER_VERSION,
      method: name === 'natural-tail-start' ? 'crossfade' : 'phrase_cut', aExit: start, bEntry: entry,
      duration: span, gap: 0, bDelay: delay, swapAt: delay + attack, tempoB: [[0, 1]],
      confidence: Math.min(base.confidence, 0.65),
      automation: [{ deck: 'A', lane: 'gain', points: pointsA },
        { deck: 'B', lane: 'gain', points: [[0, 0], [attack, 1], [bSpan, 1]] }],
      reasons: [name === 'natural-tail-start' ? 'Естественный хвост A перед сохранённым началом B' : strongClosure(end) ? 'Короткая передача полной записи у структурного закрытия A' : 'Пробная передача у предполагаемой границы фразы A'],
      entrySelection: { kind: 'start', skippedSeconds: 0, confidence: 1 },
      debug: { humanScenario: { policy: 'human-1', kind: name === 'natural-tail-start' ? 'natural-tail' : 'phrase-handoff', name, evidence, sourceEndA: end, preservedOpeningB: true,
        nativeTempo: true, auditionOnly, limits: ['structure-is-not-word-timing', 'not-beatmatched'] } },
    } });
  };
  // Only late measured closures: this alternative must not solve a transition by
  // discarding an entire final verse. No arbitrary downbeat is called a phrase.
  const closures = [...(A.structure?.segments.filter(x => x.endClosure >= 0.65).map(x => x.end) ?? []),
    ...(A.phraseConfidence >= 0.65 ? A.phrases : [])]
    .filter(t => Number.isFinite(t) && t >= Math.max(base.aExit + 0.5, endA - 12) && t <= endA)
    .sort((a, b) => b - a);
  if (closures.length) {
    const end = closures[0], span = Math.min(1.2, s.maxBlendSeconds, end - Math.max(A.audibleStart, base.aExit), roomB + 0.35);
    if (span >= 0.5) add('section-handoff', end, span, span * 0.65, span * 0.55, strongClosure(end) ? 'late measured structural closure; short full-deck overlap' : 'phrase-grid hypothesis; audition only');
  }
  // A natural tail needs measured decay, not merely an outro label. Leave the
  // recording intact until its last fraction of a second and delay B's clock.
  const curve = A.curves, rate = curve?.rate;
  const mean = (from: number, to: number) => {
    if (!(rate > 0)) return NaN;
    const lo = Math.max(0, Math.floor(from * rate)), hi = Math.ceil(to * rate);
    if (hi > curve.rmsDb.length) return NaN;
    const values = curve.rmsDb.slice(lo, hi);
    return values.length && values.every(Number.isFinite) ? 10 * Math.log10(values.reduce((sum, x) => sum + 10 ** (x / 10), 0) / values.length) : NaN;
  };
  const tail = Math.min(4, s.maxBlendSeconds, endA - Math.max(A.audibleStart, base.aExit));
  if (tail >= 1.5 && roomB >= 0.5) {
    const early = mean(endA - tail, endA - tail / 2), late = mean(endA - 0.7, endA);
    if (late < early - 6 && late < A.bodyRmsDb - 10) add('natural-tail-start', endA, tail, tail - 0.5, 0.25, 'measured declining RMS tail; B starts at audible opening');
  }
  // A deliberately audible preview hypothesis, never an automatic vocal-safe
  // alternative. Sparse/quiet does not mean instrumental. Close native tempi
  // only limit gross drift; no beat alignment is claimed without phase evidence.
  const ga = A.beat, gb = B.beat;
  if (s.eqHandoff && s.djPhrasing !== false && closures.length && ga?.stable && gb?.stable
    && ga.confidence >= 0.75 && gb.confidence >= 0.75 && ga.bpm > 0 && gb.bpm > 0
    && Math.abs(ga.bpm / gb.bpm - 1) <= 0.025) {
    const average = (values: number[], from: number, to: number) => {
      if (!(B.curves.rate > 0) || Math.ceil(to * B.curves.rate) > values.length) return NaN;
      const xs = values.slice(Math.max(0, Math.floor(from * B.curves.rate)), Math.ceil(to * B.curves.rate));
      return xs.length && xs.every(Number.isFinite) ? 10 * Math.log10(xs.reduce((a, b) => a + 10 ** (b / 10), 0) / xs.length) : NaN;
    };
    const arrival = (B.structure?.segments ?? []).find(segment => {
      const t = segment.start, lead = t - entry;
      if (lead < 2 || lead > 8 || lead + 0.4 > s.maxBlendSeconds || lead + 1.5 > roomB || segment.novelty < 0.5) return false;
      const before = average(B.curves.rmsDb, entry, t), after = average(B.curves.rmsDb, t, Math.min(t + 1.5, B.audibleEnd));
      const lowBefore = average(B.curves.lowDb, entry, t), lowAfter = average(B.curves.lowDb, t, Math.min(t + 1.5, B.audibleEnd));
      return before < B.bodyRmsDb - 5 && after - before >= 4 && lowAfter - lowBefore >= 4;
    });
    if (arrival) {
      const lead = arrival.start - entry, duration = lead + 0.4;
      const close = closures.find(t => t + 0.4 <= endA && t - lead >= Math.max(A.audibleStart, base.aExit) - 0.001);
      if (close === undefined) { addManual(); return result; }
      const count = result.length;
      add('arrival-build', close + 0.4, duration, 0, 0.65, 'measured energy and bass arrival; quiet opening; voice unknown; preview only');
      if (result.length > count) {
        const candidate = result.at(-1)!; candidate.auditionOnly = true;
        const p = candidate.plan;
        p.swapAt = lead;
        p.automation = [
          { deck: 'A', lane: 'gain', points: [[0, 1], [Math.max(0, lead - 0.25), 1], [duration, 0]] },
          { deck: 'B', lane: 'gain', points: [[0, 0], [0.04, 0.7], [Math.max(0.04, lead - 0.3), 0.7], [lead, 1], [duration, 1]] },
          { deck: 'A', lane: 'low', points: [[0, 1], [lead - 0.2, 1], [lead + 0.2, 0], [duration, 0]] },
          { deck: 'B', lane: 'low', points: [[0, 0.35], [lead - 0.2, 0.35], [lead + 0.2, 1], [duration, 1]] },
        ];
        p.reasons = ['Пробный слышимый вход B к измеренному приходу энергии; требуется прослушивание'];
        p.entrySelection!.arrivalTime = arrival.start;
        p.debug.humanScenario = { ...(p.debug.humanScenario as object), kind: 'arrival-build', arrivalSourceB: arrival.start, closureSourceA: close, auditionOnly: true, voiceStatus: 'unknown' };
      }
    }
  }
  addManual();
  return result;
}
