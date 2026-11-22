import { camelotCompatibility, PLANNER_VERSION, type AutoMixSettings, type OfflineRender, type PcmSpan,
  type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '@automix/core';
import { normalizationGain } from '@automix/core/plan/planner.ts';
import { integrateTempo, linearPower } from '@automix/core/plan/timing.ts';
import { renderRust } from './rust-render.ts';

type Style = 'blend' | 'relay' | 'three';
type Points = [number, number][];
type Analysed = PlannerTrack & { analysis: TrackAnalysis };
const names: Record<Style, string> = { blend: 'Сведение по фразам', relay: 'Подхват следующей фразы', three: 'Трёхдольный переход' };

function level(a: TrackAnalysis, from: number, to: number, band: 'rmsDb' | 'lowDb' = 'rmsDb') {
  const { rate } = a.curves, curve = linearPower(a.curves[band]);
  const start = Math.max(0, Math.round(from * rate)), end = Math.min(curve.length, Math.round(to * rate));
  let sum = 0;
  for (let i = start; i < end; i++) sum += curve[i];
  return end > start && Number.isFinite(sum) ? 10 * Math.log10(Math.max(1e-9, sum / (end - start))) : -90;
}

function key(a: TrackAnalysis, time: number) {
  const local = a.local;
  const i = local ? Math.round(time * local.rate) : 0;
  return local && local.keyConfidence[i] >= .28 && local.camelot[i] ? local.camelot[i] : a.key.camelot;
}

function build(style: Style, a: Analysed, b: Analysed, settings: AutoMixSettings, cueA: number, cueB: number): TransitionPlan | null {
  const period = a.analysis.beat!.period, periodB = b.analysis.beat!.period;
  const ratio = periodB / period;
  const accents = style === 'blend' ? 16 : 8;
  const swap = style === 'three' ? 9 * period : accents * period;
  const release = swap + (style === 'blend' ? 8 : style === 'relay' ? 4 : .94) * period;
  const duration = release + (style === 'three' ? .20 : 3 * period);
  const bLead = (style === 'three' ? 4 : accents) * periodB;
  const aExit = style === 'three' ? cueA : cueA - swap, bEntry = cueB - bLead;
  const delay = style === 'three' ? swap - bLead : 0;
  const tempoB: Points = style === 'three' ? [[0, 1]] : [[0, ratio], [release, ratio], [duration, 1]];
  if (!Number.isFinite(duration) || duration > Math.min(32, settings.maxBlendSeconds) || aExit < Math.max(3, a.analysis.audibleStart)
    || bEntry < Math.max(0, b.analysis.audibleStart - .08)
    || bEntry - b.analysis.audibleStart > (settings.maxEntrySkipSeconds ?? 45)
    || aExit + duration > Math.min(a.duration, a.analysis.audibleEnd)
    || bEntry + integrateTempo(tempoB, duration - delay) + 3 > Math.min(b.duration, b.analysis.audibleEnd)) return null;
  const automation: TransitionPlan['automation'] = [];
  const lane = (deck: 'A' | 'B', name: 'gain' | 'low' | 'mid' | 'high' | 'filter', points: Points) =>
    automation.push({ deck, lane: name, points });
  const plan: TransitionPlan = {
    id: `desktop-${style}-${a.id}-${b.id}-${Math.round(aExit * 1000)}-${Math.round(bEntry * 1000)}`,
    version: PLANNER_VERSION, fromTrackId: a.id, toTrackId: b.id, method: 'beatmatch_blend',
    confidence: .75, reasons: [names[style]], aExit, bEntry, duration, gap: 0, swapAt: swap,
    tempoB, automation, gainA: normalizationGain(a.analysis, settings.loudnessTarget),
    gainB: normalizationGain(b.analysis, settings.loudnessTarget),
    debug: { processingAllowed: true, desktopPhrase: { style, beatSeconds: period } },
  };
  if (style === 'three') {
    plan.bDelay = delay;
    plan.loopA = { start: cueA, end: cueA + 3 * period, until: cueA + release, crossfade: .008 };
    lane('A', 'gain', [[0, 1], [6 * period, .94], [swap - .075, .66], [swap + .16, .39], [release, 0]]);
    lane('A', 'low', [[0, 1], [swap - .085, .73], [swap + .09, 0]]);
    lane('A', 'filter', [[0, 0], [6 * period, 0], [swap, .15], [release, .35]]);
    lane('B', 'gain', [[0, 0], [bLead * .40, .37], [bLead, .78], [bLead + .58 * periodB, 1]]);
    lane('B', 'low', [[0, .06], [bLead - .045, .12], [bLead + .17, 1]]);
    lane('B', 'high', [[0, .49], [bLead, .84], [bLead + .26, 1]]);
    return plan;
  }
  const bassLead = style === 'blend' ? .90 : .46;
  lane('A', 'gain', [[0, 1], [swap * .5, .98], [swap - .5 * period, .85], [swap + period, .62],
    [release - period, .18], [release, 0]]);
  lane('A', 'low', [[0, 1], [swap - bassLead * period, 1], [swap - .09 * period, .50], [swap + .42 * period, .04]]);
  lane('A', 'mid', [[0, 1], [swap - period, .91], [swap + .8 * period, .77], [release, .52]]);
  lane('A', 'high', [[0, 1], [swap - period, .91], [release, .63]]);
  lane('B', 'gain', [[0, 0], [swap * .30, .35], [swap * .70, .65], [swap, .88], [swap + .90 * period, .98], [release, 1]]);
  lane('B', 'low', [[0, .06], [swap - bassLead * period, .11], [swap, .65], [swap + .45 * period, 1]]);
  lane('B', 'mid', [[0, .53], [swap - .5 * period, .64], [swap + .6 * period, .79], [release, 1]]);
  lane('B', 'high', [[0, .72], [swap, .92], [swap + period, 1]]);
  plan.beatAlign = { bpmA: a.analysis.beat!.bpm, bpmB: b.analysis.beat!.bpm, relation: 1, ratio,
    stretchPercent: Math.abs(ratio - 1) * 100, overlapBeats: accents, phraseAligned: true };
  return plan;
}

function anchors(an: TrackAnalysis, from: number, to: number, grid: NonNullable<TrackAnalysis['beat']>) {
  const marks = [...an.phrases, ...(an.sections ?? []).filter(s => s.novelty >= .40).map(s => s.start)];
  return grid.downbeats.filter(t => t >= from && t <= to
    && marks.some(mark => Math.abs(t - mark) <= .2 * grid.period));
}

export function desktopPhrase(base: TransitionPlan, a: PlannerTrack, b: PlannerTrack,
  settings: AutoMixSettings, instrumental: boolean): TransitionPlan | null {
  if (!settings.enabled || !settings.eqHandoff || settings.djPhrasing === false || settings.style === 'tight'
    || settings.entryMode === 'preserve' || !a.mixingAllowed || !b.mixingAllowed
    || base.debug.processingAllowed === false || base.debug.reviewedTransition || base.vocalA || base.vocalB
    || a.id === b.id || !['beatmatch_blend', 'crossfade', 'drop_mix', 'echo_out'].includes(base.method)
    || (settings.respectAlbums && a.album && a.album === b.album && a.albumArtist === b.albumArtist)) return null;
  const A = a.analysis, B = b.analysis, ga = A?.beat, gb = B?.beat;
  if (!A || !B || !ga?.stable || !gb?.stable || ga.confidence < .76 || gb.confidence < .76
    || ga.downbeatConfidence < .54 || gb.downbeatConfidence < .54 || ga.jitterMs > 24 || gb.jitterMs > 24
    || ga.period < .26 || ga.period > .9 || gb.period < .26 || gb.period > .9) return null;
  const stretch = Math.abs(ga.period / gb.period - 1);
  const three = instrumental && settings.loopBridges !== false && settings.style === 'auto'
    && Math.abs(9 * ga.period - 12 * gb.period) <= .045;
  if (!three && stretch > Math.min(.05, settings.maxStretchPercent / 100)) return null;
  const end = Math.min(a.duration, A.audibleEnd);
  const outgoing = anchors(A, end - Math.min(32, end * .22), end - 3, ga);
  const incoming = anchors(B, B.audibleStart + 4 * gb.period, B.audibleStart + (settings.maxEntrySkipSeconds ?? 45) + 16 * gb.period, gb);
  let best: TransitionPlan | null = null, rank = -Infinity;
  for (const at of outgoing) {
    const levelA = level(A, at - 2 * ga.period, at);
    const tail = level(A, at, at + 2 * ga.period);
    if (levelA < -32 || tail > levelA + 2) continue;
    if (three) {
      const beat = ga.beats.findIndex(t => Math.abs(t - at) < .01);
      if (beat < 0 || (ga.accents?.kick[beat] ?? 0) < .9 || tail < levelA - 7) continue;
    }
    for (const bt of incoming) {
      const harmony = camelotCompatibility(key(A, at - ga.period), key(B, bt + gb.period)).score;
      if (harmony < .85) continue;
      const before = level(B, bt - 4 * gb.period, bt);
      const arrival = level(B, bt, bt + 2 * gb.period);
      if (arrival < -28 || arrival < before - 2 || Math.abs(arrival - levelA) > 9
        || level(B, bt, bt + 2 * gb.period, 'lowDb') < -38) continue;
      const styles: Style[] = three ? ['three'] : before <= arrival - 3 || settings.style === 'smooth' ? ['blend', 'relay'] : ['relay'];
      for (const style of styles) {
        const plan = build(style, { ...a, analysis: A }, { ...b, analysis: B }, settings, at, bt);
        if (!plan) continue;
        const score = harmony * 6 + Math.min(4, arrival - before) * .45 - Math.abs(arrival - levelA) * .23
          - Math.max(0, levelA - tail - 4) * .33 - (end - at) * .026 - plan.bEntry * .075 + (style === 'blend' ? .5 : 0);
        if (score > rank) { rank = score; best = plan; }
      }
    }
  }
  return best;
}

/** Compare the actual levels of adjacent beats across the native handoff. */
export function usefulDesktopRender(plan: TransitionPlan, audio: OfflineRender) {
  if (audio.transitionStartFrame < 0 || audio.metrics.underruns || audio.metrics.peak >= 1
    || audio.metrics.maxLimiterReductionDb > 2.5 || !audio.events.some(e => e.type === 'transitionEnd' && !e.forced)
    || audio.events.some(e => e.type === 'fallback' || e.type === 'transitionAborted')) return null;
  const beat = (plan.debug.desktopPhrase as { beatSeconds: number }).beatSeconds;
  const span = Math.round(beat * audio.sampleRate), pivot = audio.transitionStartFrame + Math.round(plan.swapAt * audio.sampleRate);
  if (span < 1 || pivot - span < 0 || pivot + span > audio.L.length) return null;
  const full = [0, 0], low = [0, 0], k = Math.exp(-2 * Math.PI * 120 / audio.sampleRate);
  let l = 0, r = 0;
  for (let i = pivot - span; i < pivot + span; i++) {
    const half = i < pivot ? 0 : 1, x = audio.L[i], y = audio.R[i];
    l = k * l + (1 - k) * x; r = k * r + (1 - k) * y;
    full[half] += (x * x + y * y) / 2; low[half] += (l * l + r * r) / 2;
  }
  if (Math.min(...full) / span < 1e-4) return null;
  const change = (power: number[]) => 10 * Math.log10(Math.max(1e-9, power[1]) / Math.max(1e-9, power[0]));
  const rmsDb = change(full), bassDb = change(low);
  return Math.abs(rmsDb) <= 4 && Math.abs(bassDb) <= 6 ? { rmsDb, bassDb } : null;
}

export async function verifyDesktopPhrase(plan: TransitionPlan, a: PcmSpan, b: PcmSpan): Promise<TransitionPlan | null> {
  const shifted = { ...plan, aExit: plan.aExit - a.start, bEntry: plan.bEntry - b.start,
    loopA: plan.loopA && { ...plan.loopA, start: plan.loopA.start - a.start, end: plan.loopA.end - a.start, until: plan.loopA.until - a.start } };
  if (shifted.aExit < 2.99 || shifted.bEntry < 0) return null;
  const audio = await renderRust(a.pcm, b.pcm, shifted, 3, 3);
  const levels = usefulDesktopRender(plan, audio);
  return levels && { ...plan, debug: { ...plan.debug, renderCheck: { policy: 'desktop-phrase-1', ...levels } } };
}
