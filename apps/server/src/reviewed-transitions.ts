import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PLANNER_VERSION, planToArmed, type AutoMixSettings, type PlannerTrack, type TransitionPlan } from '@automix/core';
import { integrateTempo } from '@automix/core/plan/timing.ts';
import { LoopPcmSource } from '@automix/core/engine/loop.ts';

/** Local, explicitly reviewed recordings. This is not a similarity rule or training data. */
export const REVIEWED_SETTINGS = ['style', 'maxBlendSeconds', 'maxStretchPercent', 'entryMode', 'maxEntrySkipSeconds',
  'loudnessTarget', 'eqHandoff', 'loopBridges', 'masterTempo', 'djPhrasing', 'respectAlbums'] as const;
export function reviewedSettings(settings: AutoMixSettings): Record<string, unknown> {
  return Object.fromEntries(REVIEWED_SETTINGS.map(key => [key, settings[key] ?? null]));
}
export interface ReviewedTransitionEntry {
  id: string;
  fromHash: string;
  toHash: string;
  settings: Record<string, unknown>;
  plan: TransitionPlan;
  planSha256: string;
  evidence: { reviewId: string; manifestSha256: string; variantId: string; rating: 'good' };
}
export interface ReviewedTransitionFile { schema: 'mora-reviewed-transitions-1'; entries: ReviewedTransitionEntry[] }
export interface ReviewedPlanResolver {
  resolve(a: PlannerTrack, b: PlannerTrack, fromHash: string, toHash: string, settings: AutoMixSettings): TransitionPlan | null;
}
export const reviewedPlanHash = (plan: TransitionPlan): string => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
export function reviewedGeometryHash(plan: TransitionPlan): string {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(
    ['method', 'aExit', 'bEntry', 'duration', 'gap', 'swapAt', 'tempoA', 'tempoB', 'gainA', 'gainB', 'bDelay', 'automation', 'loopA', 'vocalA', 'vocalB', 'echo', 'voiceEcho', 'tapeStopA']
      .map(key => [key, plan[key as keyof TransitionPlan] ?? null])))).digest('hex');
}
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const points = (value: unknown, duration: number, lo: number, hi: number): boolean => Array.isArray(value) && value.length > 0 && value.length <= 256
  && value.every((p, i) => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]) && p[0] >= 0 && p[0] <= duration + .001
    && p[1] >= lo && p[1] <= hi && (i === 0 ? p[0] === 0 : p[0] > value[i - 1][0]));

/** Only the bounded full-mix plan format used by the reviewed trials is accepted. */
export function reviewedPlanFits(p: TransitionPlan, a: PlannerTrack, b: PlannerTrack): boolean {
  if (!p || p.method !== 'beatmatch_blend' || ![p.aExit, p.bEntry, p.duration, p.swapAt, p.gainA, p.gainB, p.confidence].every(finite)
    || p.confidence < 0 || p.confidence > 1 || typeof p.version !== 'string'
    || p.duration < .5 || p.duration > 64 || p.aExit < 0 || p.bEntry < 0 || p.swapAt < 0 || p.swapAt > p.duration
    || p.gap !== 0 || (p.bDelay ?? 0) !== 0 || p.vocalA || p.vocalB || p.echo || p.voiceEcho || p.tapeStopA
    || p.gainA < -60 || p.gainA > 24 || p.gainB < -60 || p.gainB > 24
    || !points(p.tempoB, p.duration, .5, 2) || (p.tempoA !== undefined && !points(p.tempoA, p.duration, .5, 2))
    || !Array.isArray(p.automation) || p.automation.length < 2 || p.automation.length > 10) return false;
  const seen = new Set<string>();
  for (const lane of p.automation) {
    if (!lane || !['A', 'B'].includes(lane.deck) || !['gain', 'low', 'mid', 'high', 'filter'].includes(lane.lane)
      || seen.has(`${lane.deck}/${lane.lane}`) || !points(lane.points, p.duration, lane.lane === 'filter' ? -1 : 0, lane.lane === 'gain' ? 2 : 1)) return false;
    seen.add(`${lane.deck}/${lane.lane}`);
  }
  if (!seen.has('A/gain') || !seen.has('B/gain')) return false;
  const endA = p.aExit + integrateTempo(p.tempoA, p.duration), endB = p.bEntry + integrateTempo(p.tempoB, p.duration);
  const aEnd = Math.min(a.duration, a.analysis?.audibleEnd ?? a.duration), bEnd = Math.min(b.duration, b.analysis?.audibleEnd ?? b.duration);
  if (![endA, endB, aEnd, bEnd].every(finite) || p.aExit < (a.analysis?.audibleStart ?? 0) - .001
    || p.bEntry < (b.analysis?.audibleStart ?? 0) - .001 || endA > aEnd + .025 || endB > bEnd + .025) return false;
  if (p.loopA) {
    const l = p.loopA;
    if (![l.start, l.end, l.until, l.crossfade].every(finite) || l.roll || l.start < p.aExit || l.until > endA + .001) return false;
    // Match the actual playback loop validator at both supported output rates.
    for (const sampleRate of [44100, 48000]) {
      const source = new LoopPcmSource({ totalFrames: Math.ceil(a.duration * sampleRate), read: () => false }, sampleRate);
      if (!source.setLoop(planToArmed(p, sampleRate, 'A', 'B').loopA!)) return false;
    }
  }
  return true;
}

/** Reading a missing, damaged or incompatible local file always keeps ordinary AutoMix. */
export class ReviewedTransitions implements ReviewedPlanResolver {
  constructor(private readonly file: string) {}
  resolve(a: PlannerTrack, b: PlannerTrack, fromHash: string, toHash: string, settings: AutoMixSettings): TransitionPlan | null {
    if (!settings.enabled || !a.mixingAllowed || !b.mixingAllowed || !a.analysis || !b.analysis || settings.stemMixing === false) return null;
    // An album's playback semantics take precedence over any per-pair preference.
    if (settings.respectAlbums && a.album && a.album === b.album && a.albumArtist === b.albumArtist) return null;
    try {
      if (fs.statSync(this.file).size > 1024 * 1024) return null;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ReviewedTransitionFile;
      if (data.schema !== 'mora-reviewed-transitions-1' || !Array.isArray(data.entries) || data.entries.length > 200) return null;
      const matching = data.entries.filter(e => e.fromHash === fromHash && e.toHash === toHash);
      if (matching.length !== 1) return null;
      const e = matching[0];
      if (!e.id || !/^[a-f0-9]{64}$/.test(e.fromHash) || !/^[a-f0-9]{64}$/.test(e.toHash)
        || e.evidence?.rating !== 'good' || !e.evidence.reviewId || !e.evidence.variantId
        || !/^[a-f0-9]{64}$/.test(e.evidence.manifestSha256) || e.planSha256 !== reviewedPlanHash(e.plan)
        || REVIEWED_SETTINGS.some(key => e.settings?.[key] !== (settings[key] ?? null)) || !reviewedPlanFits(e.plan, a, b)) return null;
      const plan = JSON.parse(JSON.stringify(e.plan)) as TransitionPlan;
      return { ...plan, id: `reviewed-${e.planSha256.slice(0, 20)}`, version: PLANNER_VERSION, fromTrackId: a.id, toTrackId: b.id,
        reasons: ['Сохранённый оценённый переход для этих аудиозаписей'],
        debug: { processingAllowed: true, reviewedTransition: { id: e.id, fromHash, toHash, sourcePlanSha256: e.planSha256,
          geometrySha256: reviewedGeometryHash(plan), sourcePlanVersion: e.plan.version, reviewId: e.evidence.reviewId, manifestSha256: e.evidence.manifestSha256,
          variantId: e.evidence.variantId, rating: 'good' } } };
    } catch { return null; }
  }
}
