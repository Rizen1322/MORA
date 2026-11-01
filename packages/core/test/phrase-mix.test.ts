import { describe, expect, it } from 'vitest';
import { compilePhraseMix, createPhraseMixRecipe, phraseMixGrid, phraseSourceTime, PhraseMixValidationError } from '../src/plan/phrase-mix.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import { evalPoints } from '../src/engine/mixer.ts';
import type { PhraseMixRecipe, TrackAnalysis, TransitionPlan } from '../src/types.ts';

function base(): TransitionPlan {
  return { id: 'pair', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'crossfade', confidence: 0.5, reasons: [], aExit: 10, bEntry: 1, duration: 8, gap: 0, swapAt: 4, tempoB: [[0, 1]], gainA: 0, gainB: 0, automation: [], debug: {} };
}
function analysis(): TrackAnalysis {
  return { duration: 180, beat: { stable: true, confidence: 0.9, downbeatConfidence: 0.9, period: 0.5, bpm: 120, beats: Array.from({ length: 360 }, (_, i) => i / 2), downbeats: Array.from({ length: 90 }, (_, i) => i * 2) } } as TrackAnalysis;
}
function recipe(patch: Partial<PhraseMixRecipe> = {}): PhraseMixRecipe { return { ...createPhraseMixRecipe(base()), ...patch }; }

describe('phrase recipe compiler', () => {
  it('keeps saved source mapping and automation when the automatic baseline is reranked', () => {
    const automatic = { ...base(), tempoA: [[0, 1], [8, 1.1]] as [number, number][], tempoB: [[0, 0.9], [8, 1]] as [number, number][] };
    const saved = createPhraseMixRecipe(automatic, analysis(), analysis());
    const preview = compilePhraseMix(automatic, saved, analysis(), analysis());
    const playback = compilePhraseMix({ ...automatic, aExit: 0, duration: 20, tempoA: [[0, 1.5]], tempoB: [[0, 1.4]] }, saved, analysis(), analysis());
    expect(playback.tempoA).toEqual(preview.tempoA);
    expect(playback.tempoB).toEqual(preview.tempoB);
    expect(playback.automation).toEqual(preview.automation);
    expect(playback.aExit).toBe(preview.aExit);
    expect(playback.bEntry).toBe(preview.bEntry);
    expect(() => compilePhraseMix(automatic, { ...saved, tempo: { b: [[1, 1]] } })).toThrow(PhraseMixValidationError);
  });
  it('reserves a real six-second A tail when opening an album gapless join', () => {
    const a = { ...analysis(), duration: 155.439 };
    const b = { ...base(), duration: 0, aExit: a.duration, bEntry: 0, swapAt: 0, method: 'gapless' as const };
    const draft = createPhraseMixRecipe(b, a, analysis());
    expect(draft.timing).toEqual({ unit: 'seconds', seconds: 6 });
    expect(draft.aExit).toBeCloseTo(149.439);
    expect(() => compilePhraseMix(b, draft, a, analysis())).not.toThrow();
    expect(createPhraseMixRecipe(b).aExit).toBeCloseTo(149.439);
  });
  it('moves a near-EOF cue backwards using integrated rates and bounds very short recordings', () => {
    const a = { ...analysis(), duration: 20 }, b = { ...base(), aExit: 19.9, tempoA: [[0, 1], [8, 2]] as [number, number][] };
    const draft = createPhraseMixRecipe(b, a, analysis());
    expect(draft.aExit).toBeCloseTo(8);
    expect(() => compilePhraseMix(b, draft, a, analysis())).not.toThrow();
    const shortB = { ...analysis(), duration: 2 };
    const short = createPhraseMixRecipe({ ...b, bEntry: 1 }, a, shortB);
    expect(short.timing).toEqual({ unit: 'seconds', seconds: 1 });
    expect(() => compilePhraseMix(b, short, a, shortB)).not.toThrow();
  });
  it('keeps weak grids in seconds and refuses invented bars', () => {
    const a = analysis(); a.beat!.downbeatConfidence = 0.2;
    expect(phraseMixGrid(base(), a)).toBeNull();
    expect(createPhraseMixRecipe(base(), a).timing.unit).toBe('seconds');
    expect(() => compilePhraseMix(base(), recipe({ timing: { unit: 'bars', bars: 4 } }), a)).toThrow(PhraseMixValidationError);
  });
  it('integrates tempo ramps when translating bars and source limits', () => {
    const b = { ...base(), tempoA: [[0, 1], [8, 2]] as [number, number][] };
    const p = compilePhraseMix(b, recipe({ timing: { unit: 'bars', bars: 4 }, tempo: { a: b.tempoA, b: b.tempoB } }), analysis(), analysis());
    expect(p.duration).toBeCloseTo(5.856406, 5);
    expect(phraseSourceTime(p.tempoA, p.duration)).toBeCloseTo(8);
    expect(() => compilePhraseMix(b, recipe({ tempo: { a: b.tempoA, b: b.tempoB } }), { ...analysis(), duration: 20 }, analysis())).toThrow('конец A');
  });
  it('uses a validated resolved bar duration even after the beat grid changes', () => {
    const draft = recipe({ timing: { unit: 'bars', bars: 4, resolvedDuration: 8 } });
    const original = compilePhraseMix(base(), draft, analysis(), analysis());
    const changed = analysis(); changed.beat!.stable = false;
    expect(compilePhraseMix(base(), draft, changed, analysis()).automation).toEqual(original.automation);
    for (const resolvedDuration of [NaN, Infinity, 0, 65])
      expect(() => compilePhraseMix(base(), recipe({ timing: { unit: 'bars', bars: 4, resolvedDuration } }), analysis(), analysis())).toThrow(PhraseMixValidationError);
    expect(() => compilePhraseMix(base(), recipe({ timing: { unit: 'bars', bars: 3 as 4, resolvedDuration: 8 } }), analysis(), analysis())).toThrow(PhraseMixValidationError);
  });
  it('maps B automation on its own clock after bDelay', () => {
    const p = compilePhraseMix(base(), recipe({ bDelay: 2, handoff: 4, curves: [{ deck: 'B', lane: 'gain', points: [[0, 0], [0.5, 0.8], [1, 1]] }] }));
    expect(p.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points).toEqual([[0, 0], [3, 0.8], [6, 1]]);
    expect(p.swapAt).toBe(4);
  });
  it.each(['bass_swap', 'drop_in', 'tail_to_start'] as const)('%s connects both decks without endpoint jumps', preset => {
    const p = compilePhraseMix(base(), recipe({ preset }));
    for (const deck of ['A', 'B'] as const) {
      const gain = p.automation.find(l => l.deck === deck && l.lane === 'gain')!;
      expect(gain.points[0][1]).toBe(deck === 'A' ? 1 : 0);
      expect(gain.points.at(-1)![1]).toBe(deck === 'A' ? 0 : 1);
      expect(gain.points.every(([t, v]) => Number.isFinite(t) && Number.isFinite(v))).toBe(true);
    }
    for (const lane of p.automation.filter(l => l.deck === 'B' && l.lane !== 'gain')) expect(lane.points.at(-1)![1]).toBe(lane.lane === 'filter' ? 0 : 1);
  });
  it('tail preserves native tempo and removes incompatible automatic effects', () => {
    const b = { ...base(), tempoB: [[0, 1.12]] as [number, number][], tempoA: [[0, 0.9]] as [number, number][], vocalA: [[0, 0]] as [number, number][], echo: { delay: 0.5, feedback: 0.4 }, loopA: { start: 5, end: 6, until: 7, crossfade: 0.1 } };
    const p = compilePhraseMix(b, recipe({ preset: 'tail_to_start' }));
    expect(p.tempoB).toEqual([[0, 1]]); expect(p.tempoA).toBeUndefined(); expect(p.loopA).toBeUndefined(); expect(p.vocalA).toBeUndefined(); expect(p.echo).toBeUndefined();
  });
  it('drop has an audible filter build and bass swap separates low bands', () => {
    const drop = compilePhraseMix(base(), recipe({ preset: 'drop_in' }));
    expect(drop.automation.find(l => l.deck === 'B' && l.lane === 'filter')!.points[0][1]).toBeLessThan(0);
    const bass = compilePhraseMix(base(), recipe());
    const lowA = bass.automation.find(l => l.deck === 'A' && l.lane === 'low')!, lowB = bass.automation.find(l => l.deck === 'B' && l.lane === 'low')!;
    expect(evalPoints(lowA.points, 2)).toBe(1); expect(evalPoints(lowB.points, 2)).toBe(0);
    expect(evalPoints(lowA.points, 6)).toBe(0); expect(evalPoints(lowB.points, 6)).toBe(1);
    expect(evalPoints(bass.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points, 1)).toBeCloseTo(0.3);
  });
  it('rejects malformed JSON with validation issues rather than TypeError', () => {
    for (const bad of [null, {}, recipe({ curves: [null] as never }), recipe({ curves: [{ deck: 'B', lane: 'gain', points: [null, [1, 1]] }] as never }), recipe({ curves: [{ deck: 'A', lane: 'gain', points: [[0, 1], [0.5, 0.3], [0.4, 0], [1, 0]] }] })]) expect(() => compilePhraseMix(base(), bad as PhraseMixRecipe)).toThrow(PhraseMixValidationError);
  });
  it('respects the source processing policy in native and manual compilation', () => {
    expect(() => compilePhraseMix({ ...base(), debug: { processingAllowed: false } }, recipe())).toThrow(PhraseMixValidationError);
  });
  it('rejects impossible cues, delay and cleanup discontinuities', () => {
    for (const patch of [{ bDelay: 8 }, { handoff: -1 }, { aExit: NaN }, { bEntry: 179 }, { aExit: 179 }, { curves: [{ deck: 'B', lane: 'low', points: [[0, 0], [1, 0.5]] }] }] as Partial<PhraseMixRecipe>[]) expect(() => compilePhraseMix(base(), recipe(patch), analysis(), analysis())).toThrow(PhraseMixValidationError);
  });
  it('fingerprints changed intent and does not mutate baseline', () => {
    const b = base(), before = JSON.stringify(b);
    expect(compilePhraseMix(b, recipe()).id).not.toBe(compilePhraseMix(b, recipe({ handoff: 3 })).id);
    expect(JSON.stringify(b)).toBe(before);
  });
  it('renders each preset with delayed B through the playback mixer without underruns', () => {
    const sr = 22050;
    const L = Float32Array.from({ length: sr * 25 }, (_, i) => Math.sin(2 * Math.PI * 220 * i / sr) * 0.08);
    const pcm = { L, R: L.slice(), sampleRate: sr };
    for (const preset of ['bass_swap', 'drop_in', 'tail_to_start'] as const) {
      const p = compilePhraseMix(base(), recipe({ preset, bDelay: 1.5 }));
      const rendered = renderTransitionOffline(pcm, pcm, p, 1, 1);
      expect(rendered.metrics.underruns).toBe(0);
      expect(rendered.metrics.peak).toBeGreaterThan(0.01);
      expect(rendered.L.every(Number.isFinite)).toBe(true);
    }
  });
});
