import { expect, it } from 'vitest';
import { complementaryHandoffAudition } from '../../../packages/core/src/plan/human-scenarios.ts';
import { phraseGridTimes, phraseMarker, phrasePreset, phraseScenario, phraseTiming, phraseWaveform } from '../src/lib/phrase-editor.ts';
import { compilePhraseMix, createPhraseMixRecipe, DEFAULT_AUTOMIX_SETTINGS, evalPoints, humanTransitionScenarios, type TrackAnalysis, type TransitionPlan } from '@automix/core';

const plan = { aExit: 1, bEntry: 0, duration: 4, bDelay: 2, tempoA: [[0, 2]], tempoB: [[0, 1]] } as TransitionPlan;
const analysis = { peaks: new Array(100).fill(1), curves: { rate: 1 }, beat: { stable: true, confidence: 0.9, downbeatConfidence: 0.9, downbeats: [0, 2, 4, 6, 8] } } as TrackAnalysis;
it('moves an unlocked near-end cue to keep its heard ending when length grows', () => {
  const recipe = { version: 1, preset: 'bass_swap', timing: { unit: 'seconds', seconds: 6 }, aExit: 149, bEntry: 0, bDelay: 0, handoff: 3 } as const;
  const base = { ...plan, aExit: 149, tempoA: [[0, 1]] } as TransitionPlan;
  const longer = phraseTiming(recipe, { unit: 'seconds', seconds: 16 }, base, null, 6);
  expect(longer.aExit).toBe(139);
  expect(longer.handoff).toBe(8);
  const locked = phraseTiming({ ...recipe, locks: { aExit: true, bEntry: false, handoff: true } }, { unit: 'seconds', seconds: 16 }, base, null, 6);
  expect(locked.aExit).toBe(149);
  expect(locked.handoff).toBe(3);
});
it('projects measured downbeats without inventing a bar at the source cue', () => {
  expect(phraseGridTimes(analysis, plan)).toEqual(expect.arrayContaining([expect.closeTo(0.5), expect.closeTo(1.5), expect.closeTo(2.5), expect.closeTo(3.5)]));
  expect(phraseGridTimes({ ...analysis, beat: { ...analysis.beat!, confidence: 0.1 } }, plan)).toEqual([]);
});
it('keeps B silent until its output delay on aligned waveform rows', () => {
  const path = phraseWaveform(analysis, plan, 'B').split(' ');
  expect(path[0]).toBe('M0,30v0');
  expect(path[119]).toContain(',30v0');
  expect(path[120]).toContain(',5v50');
  expect(phraseWaveform(null, plan, 'A')).toBe('');
});
it('tail preset starts B near the real end and exposes its musical opening immediately', () => {
  const base = { id: 'p', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'crossfade', confidence: 0.5, reasons: [], aExit: 10, bEntry: 0, duration: 8, gap: 0, swapAt: 4, tempoB: [[0, 1]], gainA: 0, gainB: 0, automation: [], debug: {} } as TransitionPlan;
  const recipe = phrasePreset(createPhraseMixRecipe(base), 'tail_to_start', 8);
  expect(recipe.bDelay).toBeCloseTo(6.8);
  const compiled = compilePhraseMix(base, recipe);
  const gainA = compiled.automation.find(l => l.deck === 'A' && l.lane === 'gain')!, gainB = compiled.automation.find(l => l.deck === 'B' && l.lane === 'gain')!;
  expect(evalPoints(gainB.points, 0.35)).toBe(1);
  expect(evalPoints(gainA.points, 5)).toBe(1);
  expect(compiled.bEntry).toBe(0);
});

it.each([
  ['section-handoff', 'bass_swap'], ['natural-tail-start', 'tail_to_start'], ['arrival-build', 'drop_in'],
] as const)('roundtrips %s through editable recipes without adding preset processing', (name, preset) => {
  const base = { id: 'automatic', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'beatmatch_blend', confidence: 0.8,
    reasons: [], aExit: 80, bEntry: 25, duration: 20, gap: 0, swapAt: 10, tempoA: [[0, 1.1]], tempoB: [[0, 0.9]],
    gainA: -2, gainB: -1, automation: [], debug: {}, vocalA: [[0, 0]], echo: { delay: 0.5, feedback: 0.5 } } as TransitionPlan;
  const makeAnalysis = () => ({ duration: 100, audibleStart: 0, audibleEnd: 100, bodyRmsDb: -15,
    phraseConfidence: 0.8, phrases: [96], beat: { stable: true, confidence: 0.9, bpm: 120 },
    curves: { rate: 10, rmsDb: Array(1000).fill(-15) } } as TrackAnalysis);
  const a = makeAnalysis(), b = makeAnalysis();
  for (let i = 960; i < 1000; i++) a.curves.rmsDb[i] = -15 - (i - 960) * 0.7;
  b.curves.rmsDb = Array.from({ length: 1000 }, (_, i) => i < 40 ? -25 : -15);
  b.curves.lowDb = [...b.curves.rmsDb];
  b.structure = { segments: [{ start: 4, novelty: 0.8 }] } as TrackAnalysis['structure'];
  const source = humanTransitionScenarios(base, a, b, DEFAULT_AUTOMIX_SETTINGS).find(x => x.name === name)!.plan;
  const original = structuredClone(source);
  const recipe = phraseScenario(source, name);
  expect(recipe.preset).toBe(preset);
  expect(recipe.timing).toEqual({ unit: 'seconds', seconds: source.duration });
  expect(recipe.locks).toEqual({ aExit: false, bEntry: false, handoff: false });
  expect(recipe.curves).toHaveLength(10);
  // Save/load JSON and compile against the original stretched automatic plan.
  const compiled = compilePhraseMix(base, JSON.parse(JSON.stringify(recipe)), a, b);
  for (const key of ['aExit', 'bEntry', 'bDelay', 'duration', 'swapAt', 'gainA', 'gainB'] as const) expect(compiled[key]).toBe(source[key]);
  expect(compiled.tempoA).toBeUndefined();
  expect(compiled.tempoB).toEqual([[0, 1]]);
  expect(compiled.vocalA).toBeUndefined();
  expect(compiled.echo).toBeUndefined();
  for (const lane of compiled.automation) {
    const expected = source.automation.find(x => x.deck === lane.deck && x.lane === lane.lane);
    if (expected) {
      expect(lane.points).toHaveLength(expected.points.length);
      lane.points.forEach(([time, value], i) => {
        expect(time).toBeCloseTo(expected.points[i][0], 12);
        expect(value).toBe(expected.points[i][1]);
      });
    } else expect(lane.points).toEqual([[0, lane.lane === 'filter' ? 0 : 1], [lane.deck === 'A' ? source.duration : source.duration - source.bDelay!, lane.lane === 'filter' ? 0 : 1]]);
  }
  expect(source).toEqual(original);
  recipe.curves![0].points[0][1] = 0.5;
  expect(source).toEqual(original);
});

it('saves a clean-out with the original incoming deck and playback clocks', () => {
  const base = { id: 'p', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'beatmatch_blend', confidence: 0.8,
    reasons: [], aExit: 80, bEntry: 3, duration: 12, gap: 0, swapAt: 5, tempoA: [[0, 1.03]], tempoB: [[0, 0.97]],
    beatAlign: { overlapBeats: 24 }, gainA: -5, gainB: -6, debug: {},
    automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [10, 1], [12, 0]] },
      { deck: 'B', lane: 'gain', points: [[0, 0], [5, 1], [12, 1]] }] } as TransitionPlan;
  const a = { duration: 100, audibleStart: 0, audibleEnd: 100, phraseConfidence: 0, phrases: [],
    beat: { stable: true, period: 0.5 }, curves: { rate: 1, rmsDb: Array(100).fill(-15) } } as TrackAnalysis;
  const scenario = humanTransitionScenarios(base, a, a, DEFAULT_AUTOMIX_SETTINGS).find(x => x.name === 'clean-out')!;
  expect(scenario.auditionOnly).toBe(true);
  const compiled = compilePhraseMix(base, JSON.parse(JSON.stringify(phraseScenario(scenario.plan, scenario.name))), a, a);
  expect(compiled.tempoA).toEqual(base.tempoA);
  expect(compiled.tempoB).toEqual(base.tempoB);
  expect(compiled.duration).toBe(base.duration);
  expect(compiled.bEntry).toBe(base.bEntry);
  const b = compiled.automation.find(l => l.deck === 'B' && l.lane === 'gain')!;
  expect(b.points).toEqual(base.automation[1].points);
  const outgoing = compiled.automation.find(l => l.deck === 'A' && l.lane === 'gain')!;
  expect(evalPoints(outgoing.points, 8)).toBe(0);
  expect(evalPoints(base.automation[0].points, 8)).toBe(1);
});

it('roundtrips complementary handoff as full-mix gain curves and retains source cues, tempo maps and B delay', () => {
  const base = { id: 'complement', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'beatmatch_blend', confidence: 0.8,
    reasons: [], aExit: 82, bEntry: 7.25, duration: 20, bDelay: 2, swapAt: 10, gap: 0,
    tempoA: [[0, 1.07], [8, 1.02]], tempoB: [[0, 0.96], [6, 1]], beatAlign: { bpmA: 120, bpmB: 120, ratio: 1, relation: 1, stretchPercent: 0, overlapBeats: 32, phraseAligned: true },
    gainA: 0, gainB: 0, debug: { humanScenario: { kind: 'complementary-handoff', auditionOnly: true } },
    automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [20, 0]] },
      { deck: 'B', lane: 'gain', points: [[0, 0], [1, 0.1], [3, 0.3], [6, 0.7], [18, 1]] }] } as TransitionPlan;
  const scenario = complementaryHandoffAudition(base)!;
  const recipe = JSON.parse(JSON.stringify(phraseScenario(scenario.plan, scenario.name)));
  const compiled = compilePhraseMix(base, recipe);
  expect(compiled.aExit).toBe(base.aExit); expect(compiled.bEntry).toBe(base.bEntry);
  expect(compiled.bDelay).toBe(base.bDelay); expect(compiled.duration).toBe(base.duration); expect(compiled.swapAt).toBe(base.swapAt);
  expect(compiled.tempoA).toEqual(base.tempoA); expect(compiled.tempoB).toEqual(base.tempoB);
  const a = compiled.automation.find(l => l.deck === 'A' && l.lane === 'gain')!;
  const b = compiled.automation.find(l => l.deck === 'B' && l.lane === 'gain')!;
  for (let t = 0; t <= compiled.duration - compiled.bDelay!; t += 0.05) {
    expect(evalPoints(a.points, t + compiled.bDelay!) + evalPoints(b.points, t)).toBeCloseTo(1, 8);
    expect(evalPoints(a.points, t + compiled.bDelay!) === 1 && evalPoints(b.points, t) === 1).toBe(false);
  }
});


it('moves scenario automation with the handoff while preserving edited nodes and levels', () => {
  const base = { id: 'markers', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'crossfade', confidence: 0.5,
    reasons: [], aExit: 10, bEntry: 0, duration: 8, gap: 0, swapAt: 4, bDelay: 2, tempoB: [[0, 1]], gainA: 0, gainB: 0,
    automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [4, 0.5], [8, 0]] },
      { deck: 'B', lane: 'gain', points: [[0, 0], [2, 0.5], [6, 1]] }], debug: {} } as TransitionPlan;
  const recipe = phraseScenario(base, 'section-handoff');
  const moved = phraseMarker(recipe, 8, 'handoff', 6);
  const compiled = compilePhraseMix(base, moved);
  expect(compiled.swapAt).toBe(6);
  expect(evalPoints(compiled.automation.find(x => x.deck === 'A' && x.lane === 'gain')!.points, 6)).toBeCloseTo(0.5);
  expect(evalPoints(compiled.automation.find(x => x.deck === 'B' && x.lane === 'gain')!.points, 4)).toBeCloseTo(0.5);
  expect(moved.curves!.find(x => x.deck === 'B' && x.lane === 'gain')!.points.map(p => p[1])).toEqual([0, 0.5, 1]);
  const delayed = phraseMarker(moved, 8, 'bDelay', 3);
  const withDelay = compilePhraseMix(base, delayed);
  expect(withDelay.bDelay).toBe(3);
  expect(evalPoints(withDelay.automation.find(x => x.deck === 'B' && x.lane === 'gain')!.points, 3)).toBeCloseTo(0.5);
  expect(recipe.handoff).toBe(4);
  for (const extreme of [phraseMarker(recipe, 8, 'handoff', 8), phraseMarker(recipe, 8, 'handoff', 2)])
    expect(() => compilePhraseMix(base, extreme)).not.toThrow();
});

it('keeps shortened transitions valid when a locked handoff exceeds the new end', () => {
  const base = { id: 'timing', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'crossfade', confidence: 0.5,
    reasons: [], aExit: 10, bEntry: 0, duration: 8, gap: 0, swapAt: 7, tempoB: [[0, 1]], gainA: 0, gainB: 0, automation: [], debug: {} } as TransitionPlan;
  const recipe = { ...createPhraseMixRecipe(base), locks: { aExit: false, bEntry: false, handoff: true } };
  const shorter = phraseTiming(recipe, { unit: 'seconds', seconds: 4 }, base, null, 8);
  expect(shorter.handoff).toBe(4);
  expect(() => compilePhraseMix(base, shorter)).not.toThrow();
});


it('keeps a sequential relay silent between decks when made editable and saved', () => {
  const source = { id: 'relay', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'phrase_cut', confidence: 0.5,
    reasons: [], aExit: 42, bEntry: 0, duration: 1.55, gap: 0, bDelay: 1.05, swapAt: 1.05, tempoB: [[0, 1]], gainA: 0, gainB: 0,
    automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [0.85, 1], [1, 0], [1.55, 0]] },
      { deck: 'B', lane: 'gain', points: [[0, 0], [0.05, 1], [0.5, 1]] }], debug: {} } as TransitionPlan;
  const draft = phraseScenario(source, 'sequential-relay');
  const compiled = compilePhraseMix(source, JSON.parse(JSON.stringify(draft)));
  expect(compiled.bDelay).toBe(1.05);
  expect(compiled.tempoA).toBeUndefined();
  expect(compiled.tempoB).toEqual([[0, 1]]);
  expect(evalPoints(compiled.automation.find(x => x.deck === 'A' && x.lane === 'gain')!.points, compiled.bDelay!)).toBe(0);
  expect(evalPoints(compiled.automation.find(x => x.deck === 'B' && x.lane === 'gain')!.points, 0)).toBe(0);
});
