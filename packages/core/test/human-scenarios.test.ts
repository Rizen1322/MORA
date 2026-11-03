import { describe, expect, it } from 'vitest';
import { cleanOutAudition, closureAlignedHandoffAudition, complementaryHandoffAudition, humanTransitionScenarios, measuredBarEntryAudition, sequentialRelayAudition } from '../src/plan/human-scenarios.ts';
import { integrateTempo, pointValue } from '../src/plan/timing.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';

const base = (): TransitionPlan => ({ id: 'a-b', version: 'old', fromTrackId: 'a', toTrackId: 'b', method: 'beatmatch_blend', confidence: 0.8,
  reasons: [], aExit: 80, bEntry: 25, duration: 20, swapAt: 10, gap: 0, tempoA: [[0, 1.1]], tempoB: [[0, 0.9]], gainA: 0, gainB: 0,
  vocalA: [[0, 0]], echo: { delay: 0.5, feedback: 0.5 }, automation: [], debug: { fullMix: { obsolete: true } } });
const analysis = (): TrackAnalysis => ({ duration: 100, audibleStart: 0, audibleEnd: 100, bodyRmsDb: -15,
  phraseConfidence: 0.8, phrases: [32, 64, 96], curves: { rate: 10, rmsDb: Array(1000).fill(-15) } } as TrackAnalysis);

describe('event anchored human scenarios', () => {
  it('auditions the measured bar phase only for a recorded rotation, preserving the mix and skip budget', () => {
    const b = analysis(); b.beat = { stable: true, period: 0.5, downbeats: [0, 2, 4, 6], downbeatConfidence: 0.9 } as TrackAnalysis['beat'];
    const p: TransitionPlan = { ...base(), bEntry: 2.5, vocalA: undefined, echo: undefined,
      beatAlign: { bpmA: 120, bpmB: 120, ratio: 1, relation: 1, stretchPercent: 0, overlapBeats: 32, phraseAligned: false },
      debug: { drumPattern: { k: 1 }, fullMix: { obsolete: true }, renderCheck: { obsolete: true } } };
    const original = structuredClone(p), candidate = measuredBarEntryAudition(p, b, DEFAULT_AUTOMIX_SETTINGS)!;
    expect(candidate.auditionOnly).toBe(true); expect(candidate.plan.bEntry).toBe(2);
    expect(candidate.plan.automation).toEqual(p.automation); expect(candidate.plan.tempoA).toEqual(p.tempoA);
    expect(candidate.plan.tempoB).toEqual(p.tempoB); expect(candidate.plan.duration).toBe(p.duration);
    expect(candidate.plan.swapAt).toBe(p.swapAt); expect(candidate.plan.debug.fullMix).toBeUndefined();
    expect(candidate.plan.debug.renderCheck).toBeUndefined(); expect(p).toEqual(original);
    expect(measuredBarEntryAudition(p, b, { ...DEFAULT_AUTOMIX_SETTINGS, entryMode: 'preserve' })).toBeNull();
    expect(measuredBarEntryAudition(p, b, { ...DEFAULT_AUTOMIX_SETTINGS, maxEntrySkipSeconds: 1 })).toBeNull();
    expect(measuredBarEntryAudition({ ...p, debug: { drumPattern: { k: 0 } } }, b, DEFAULT_AUTOMIX_SETTINGS)).toBeNull();
    b.audibleEnd = 10;
    expect(measuredBarEntryAudition(p, b, DEFAULT_AUTOMIX_SETTINGS)).toBeNull();
  });
  const structural = () => { const a = analysis(); a.structure = { segments: [{ end: 96, endClosure: 0.8 }] } as TrackAnalysis['structure']; return a; };
  const aligned = () => ({ ...base(), beatAlign: { bpmA: 120, bpmB: 120, ratio: 1, relation: 1, stretchPercent: 0, overlapBeats: 32, phraseAligned: true } });
  it('offers a bounded manual relay only at measured closure or a measured quiet end', () => {
    const a = structural(), b = analysis(), p = aligned(); b.audibleStart = 0.4;
    const candidate = sequentialRelayAudition(p, a, b, DEFAULT_AUTOMIX_SETTINGS)!;
    expect(candidate.auditionOnly).toBe(true);
    expect(candidate.plan.bEntry).toBe(0.4);
    expect(candidate.plan.aExit + candidate.plan.duration).toBeLessThanOrEqual(a.audibleEnd);
    expect(candidate.plan.bEntry + candidate.plan.duration - candidate.plan.bDelay!).toBeLessThanOrEqual(b.audibleEnd);
    expect(candidate.plan.tempoA).toBeUndefined(); expect(candidate.plan.tempoB).toEqual([[0, 1]]);
    expect(candidate.plan.beatAlign).toBeUndefined(); expect(candidate.plan.echo).toBeUndefined();
    expect((candidate.plan.debug.humanScenario as { remainingASeconds: number }).remainingASeconds).toBe(4);
    expect(humanTransitionScenarios(p, a, b, DEFAULT_AUTOMIX_SETTINGS).find(x => x.name === 'sequential-relay')?.auditionOnly).toBe(true);
    a.structure = undefined;
    expect(sequentialRelayAudition(p, a, b, DEFAULT_AUTOMIX_SETTINGS)).toBeNull();
    a.curves.rmsDb.fill(-30, 985);
    expect(sequentialRelayAudition(p, a, b, DEFAULT_AUTOMIX_SETTINGS)).not.toBeNull();
    a.curves.rmsDb[990] = NaN;
    expect(sequentialRelayAudition(p, a, b, DEFAULT_AUTOMIX_SETTINGS)).toBeNull();
    expect(sequentialRelayAudition(p, structural(), b, { ...DEFAULT_AUTOMIX_SETTINGS, maxBlendSeconds: 1 })).toBeNull();
  });
  it('renders whole decks without overlap and starts B on its own unadvanced source clock', () => {
    const a = structural(), b = analysis(), p = sequentialRelayAudition(aligned(), a, b, DEFAULT_AUTOMIX_SETTINGS)!.plan;
    const sr = 8000, n = 100 * sr, silence = new Float32Array(n);
    const aTone = Float32Array.from({ length: n }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 211 * i / sr));
    const bTone = Float32Array.from({ length: n }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 317 * i / sr));
    const pcm = (L: Float32Array) => ({ L, R: L, sampleRate: sr });
    const onlyA = renderTransitionOffline(pcm(aTone), pcm(silence), p, 0, 0.2);
    const onlyB = renderTransitionOffline(pcm(silence), pcm(bTone), p, 0, 0.2);
    let simultaneous = 0, energyA = 0, energyB = 0;
    for (let i = 0; i < onlyA.L.length; i++) {
      const x = Math.abs(onlyA.L[i]), y = Math.abs(onlyB.L[i]);
      if (x > 1e-6 && y > 1e-6) simultaneous++;
      energyA += x; energyB += y;
    }
    expect(energyA).toBeGreaterThan(1); expect(energyB).toBeGreaterThan(1);
    expect(simultaneous).toBe(0);
    expect(onlyA.metrics.underruns + onlyB.metrics.underruns).toBe(0);
    const immediate = renderTransitionOffline(pcm(silence), pcm(bTone), { ...p, bDelay: 0 }, 0, 0.2);
    let difference = 0;
    const shift = Math.round(p.bDelay! * sr);
    for (let i = 0; i < Math.floor(0.45 * sr); i++) difference = Math.max(difference, Math.abs(onlyB.L[i + shift] - immediate.L[i]));
    expect(difference).toBeLessThan(1e-5);
  });
  it('offers a manual whole-deck departure after B arrives without altering its clock or the lock', () => {
    const a = analysis(); a.beat = { stable: true, period: 0.5 } as NonNullable<TrackAnalysis['beat']>;
    const p = { ...aligned(), echo: undefined, bDelay: 2, automation: [
      { deck: 'A' as const, lane: 'gain' as const, points: [[0, 1], [18, 1], [20, 0]] as [number, number][] },
      ...(['gain', 'low', 'mid', 'high'] as const).map(lane => ({ deck: 'B' as const, lane, points: [[0, 0], [5, 1], [18, 1]] as [number, number][] })),
    ] };
    const original = structuredClone(p), candidate = cleanOutAudition(p, a)!;
    expect(candidate.auditionOnly).toBe(true);
    expect(p).toEqual(original);
    expect(candidate.plan.beatAlign).toEqual(p.beatAlign);
    expect(candidate.plan.duration).toBe(p.duration);
    expect(candidate.plan.tempoB).toEqual(p.tempoB);
    expect(candidate.plan.automation.filter(l => l.deck === 'B')).toEqual(p.automation.filter(l => l.deck === 'B'));
    const gain = candidate.plan.automation.find(l => l.deck === 'A' && l.lane === 'gain')!.points;
    expect(pointValue(gain, 6)).toBe(1); // B's clock starts two seconds late
    expect(pointValue(gain, 9.5)).toBe(0);
    const listed = humanTransitionScenarios(p, a, analysis(), DEFAULT_AUTOMIX_SETTINGS).find(x => x.name === 'clean-out');
    expect(listed?.auditionOnly).toBe(true);
    expect(listed?.plan).toEqual(candidate.plan);
    expect(cleanOutAudition({ ...p, echo: { delay: 0.5, feedback: 0.5 } }, a)).toBeNull();
  });
  it('offers a gain-only complementary handoff around the existing swap without changing either source clock', () => {
    const p: TransitionPlan = { ...aligned(), vocalA: undefined, vocalB: undefined, echo: undefined, voiceEcho: undefined,
      aExit: 82, bEntry: 7.25, bDelay: 2, duration: 20, swapAt: 10,
      tempoA: [[0, 1.07], [8, 1.02]], tempoB: [[0, 0.96], [6, 1]],
      automation: [
        { deck: 'A', lane: 'gain', points: [[0, 1], [20, 0]] },
        { deck: 'B', lane: 'gain', points: [[0, 0], [1, 0.1], [3, 0.3], [6, 0.7], [18, 1]] },
        { deck: 'A', lane: 'mid', points: [[0, 1], [20, 1]] },
      ] };
    const source = structuredClone(p), scenario = complementaryHandoffAudition(p)!;
    const out = scenario.plan;
    expect(scenario.auditionOnly).toBe(true);
    expect(out.aExit).toBe(p.aExit); expect(out.bEntry).toBe(p.bEntry); expect(out.bDelay).toBe(p.bDelay);
    expect(out.duration).toBe(p.duration); expect(out.swapAt).toBe(p.swapAt);
    expect(out.tempoA).toEqual(p.tempoA); expect(out.tempoB).toEqual(p.tempoB); expect(out.beatAlign).toEqual(p.beatAlign);
    expect(out.automation.find(l => l.deck === 'A' && l.lane === 'mid')).toEqual(p.automation[2]);
    expect(p).toEqual(source);
    const ga = out.automation.find(l => l.deck === 'A' && l.lane === 'gain')!.points;
    const gb = out.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points;
    expect((out.debug.humanScenario as { kind: string }).kind).toBe('complementary-handoff');
    // In B's own clock the outgoing fader is exactly the complement of incoming.
    for (let t = 0; t <= p.duration - p.bDelay!; t += 0.05) {
      const incoming = pointValue(gb, t);
      const outgoing = pointValue(ga, t + p.bDelay!);
      expect(outgoing + incoming).toBeCloseTo(1, 8);
      expect(outgoing === 1 && incoming === 1).toBe(false);
    }
    expect(pointValue(gb, p.swapAt - p.bDelay!)).toBeGreaterThan(0);
    expect(pointValue(gb, p.swapAt - p.bDelay!)).toBeLessThan(1);
    expect(humanTransitionScenarios(p, analysis(), analysis(), DEFAULT_AUTOMIX_SETTINGS).find(x => x.name === 'complementary-handoff')?.auditionOnly).toBe(true);
  });
  it('aligns a slow manual A release to a measured shared closure and B downbeat', () => {
    const p: TransitionPlan = { ...aligned(), beatAlign: { ...aligned().beatAlign!, phraseAligned: false }, echo: undefined, voiceEcho: undefined, vocalA: undefined, vocalB: undefined, aExit: 88, bEntry: 0, duration: 8, swapAt: 4,
      tempoA: [[0, 1], [8, 1]], tempoB: [[0, 1], [8, 1]], automation: [
        { deck: 'A', lane: 'gain', points: [[0, 1], [4, 1], [8, 0]] },
        { deck: 'B', lane: 'gain', points: [[0, 0], [1, 1], [8, 1]] },
      ] };
    const a = analysis(), b = analysis();
    const grid = { bpm: 120, confidence: 0.95, period: 0.5, stable: true, jitterMs: 5, beats: [88, 88.5, 89, 89.5, 90, 90.5, 91, 91.5, 92, 92.5, 93, 93.5, 94, 94.5, 95, 95.5, 96],
      downbeats: [88, 90, 92, 94, 96], downbeatConfidence: 0.95, downbeatPhase: 0, alternatives: [] } as NonNullable<TrackAnalysis['beat']>;
    a.beat = grid; b.beat = { ...grid, beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], downbeats: [0, 2, 4] };
    a.phrases = [96]; a.phraseConfidence = 0.9;
    a.structure = { segments: [{ end: 96, endClosure: 0.9 }] } as TrackAnalysis['structure'];
    const original = structuredClone(p), candidate = closureAlignedHandoffAudition(p, a, b, DEFAULT_AUTOMIX_SETTINGS)!;
    expect(candidate.name).toBe('closure-aligned-handoff'); expect(candidate.auditionOnly).toBe(true);
    expect(p).toEqual(original);
    expect(candidate.plan.debug.fullMix).toBeUndefined(); expect(candidate.plan.debug.ratingFeedback).toBeUndefined();
    expect(candidate.plan.debug.renderCheck).toBeUndefined();
    expect(candidate.plan.aExit + integrateTempo(candidate.plan.tempoA, candidate.plan.duration)).toBeCloseTo(96, 6);
    expect(candidate.plan.bEntry + integrateTempo(candidate.plan.tempoB, candidate.plan.duration - candidate.plan.bDelay!)).toBeCloseTo(4, 6);
    expect(candidate.plan.bEntry).toBe(0);
    expect(candidate.plan.bDelay).toBeCloseTo(4, 6);
    expect(candidate.plan.beatAlign?.phraseAligned).toBe(false);
    expect((candidate.plan.debug.humanScenario as { sourceClosureConfidence: number }).sourceClosureConfidence).toBe(0.9);
    expect(candidate.plan.tempoB.at(-1)![0]).toBeCloseTo(4, 6);
    expect(candidate.plan.automation.every(l => l.lane === 'gain')).toBe(true);
    expect(candidate.plan.tempoA?.[0]).toEqual(p.tempoA?.[0]); expect(candidate.plan.tempoA?.at(-1)?.[1]).toEqual(p.tempoA?.at(-1)?.[1]);
    expect(candidate.plan.tempoB[0]).toEqual(p.tempoB[0]); expect(candidate.plan.tempoB.at(-1)?.[1]).toEqual(p.tempoB.at(-1)?.[1]);
    const release = candidate.plan.automation.find(l => l.deck === 'A' && l.lane === 'gain')!.points;
    const incoming = candidate.plan.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points;
    const fadeStart = candidate.plan.duration - 4;
    expect(pointValue(release, fadeStart)).toBeCloseTo(1, 6);
    expect(pointValue(release, fadeStart + 2)).toBeCloseTo(0.5, 5);
    expect(pointValue(release, candidate.plan.duration)).toBe(0);
    expect(pointValue(incoming, 0)).toBe(0);
    expect(pointValue(incoming, candidate.plan.duration - candidate.plan.bDelay! - 0.1)).toBeLessThan(1);
    expect(pointValue(incoming, candidate.plan.duration - candidate.plan.bDelay!)).toBe(1);
    expect(candidate.plan.automation.find(l => l.deck === 'B' && l.lane === 'gain')!.points.at(-1)![0]).toBeCloseTo(4, 6);
  });
  it('refuses closure ramps without the paired phrase and confident B downbeat evidence', () => {
    const p: TransitionPlan = { ...aligned(), echo: undefined, voiceEcho: undefined, vocalA: undefined, vocalB: undefined, aExit: 88, bEntry: 0, duration: 8, swapAt: 4,
      tempoA: [[0, 1], [8, 1]], tempoB: [[0, 1], [8, 1]], automation: [
        { deck: 'A', lane: 'gain', points: [[0, 1], [4, 1], [8, 0]] },
        { deck: 'B', lane: 'gain', points: [[0, 0], [1, 1], [8, 1]] },
      ] };
    const a = analysis(), b = analysis();
    const grid = { bpm: 120, confidence: 0.95, period: 0.5, stable: true, jitterMs: 5, beats: [88, 89, 90, 91, 92, 93, 94, 95, 96],
      downbeats: [88, 90, 92, 94, 96], downbeatConfidence: 0.95, downbeatPhase: 0, alternatives: [] } as NonNullable<TrackAnalysis['beat']>;
    a.beat = grid; b.beat = { ...grid, downbeats: [0, 2, 4] };
    a.phrases = []; a.phraseConfidence = 0.9;
    a.structure = { segments: [{ end: 96, endClosure: 0.7 }] } as TrackAnalysis['structure'];
    expect(closureAlignedHandoffAudition(p, a, b, DEFAULT_AUTOMIX_SETTINGS)).toBeNull();
    a.structure = { segments: [{ end: 96, endClosure: 0.9 }] } as TrackAnalysis['structure'];
    b.beat = { ...b.beat!, downbeatConfidence: 0.4 };
    expect(closureAlignedHandoffAudition(p, a, b, DEFAULT_AUTOMIX_SETTINGS)).toBeNull();
    b.beat = { ...b.beat!, downbeatConfidence: 0.95 }; a.beat = { ...grid, downbeats: [88, 90, 92, 94] };
    expect(closureAlignedHandoffAudition(p, a, b, DEFAULT_AUTOMIX_SETTINGS)).toBeNull();
    expect(closureAlignedHandoffAudition({ ...p, vocalA: [[0, 1]] }, a, b, DEFAULT_AUTOMIX_SETTINGS)).toBeNull();
  });
  it('keeps phrase-grid-only handoffs out of automatic selection', () => {
    expect(humanTransitionScenarios(base(), analysis(), analysis(), DEFAULT_AUTOMIX_SETTINGS)[0].auditionOnly).toBe(true);
  });
  it('allows strong structural closure automatically only without trusted beat alignment', () => {
    expect(humanTransitionScenarios(base(), structural(), analysis(), DEFAULT_AUTOMIX_SETTINGS)[0].auditionOnly).toBe(false);
    expect(humanTransitionScenarios(aligned(), structural(), analysis(), DEFAULT_AUTOMIX_SETTINGS)[0].auditionOnly).toBe(true);
  });
  it('requires explicit shaky-grid evidence to replace an aligned plan', () => {
    const a = structural(); a.beat = { confidence: 0.9, jitterMs: 5 } as NonNullable<TrackAnalysis['beat']>;
    expect(humanTransitionScenarios(aligned(), a, analysis(), DEFAULT_AUTOMIX_SETTINGS)[0].auditionOnly).toBe(true);
    a.beat.jitterMs = 25;
    expect(humanTransitionScenarios(aligned(), a, analysis(), DEFAULT_AUTOMIX_SETTINGS)[0].auditionOnly).toBe(false);
  });
  it('preserves measured vocal handling from automatic full-deck replacement', () => {
    const a = structural(); a.vocalActivity = { rate: 1, values: [1], source: 'demucs', model: 'test' };
    const p = base(), original = structuredClone(p);
    expect(humanTransitionScenarios(p, a, analysis(), DEFAULT_AUTOMIX_SETTINGS)[0].auditionOnly).toBe(true);
    expect(p).toEqual(original);
    expect(humanTransitionScenarios(p, a, analysis(), { ...DEFAULT_AUTOMIX_SETTINGS, stemMixing: false })[0].auditionOnly).toBe(false);
  });
  it('does not override an explicit smooth or tight style with automatic section cuts', () => {
    for (const style of ['smooth', 'tight'] as const) expect(humanTransitionScenarios(base(), structural(), analysis(), { ...DEFAULT_AUTOMIX_SETTINGS, style })[0].auditionOnly).toBe(true);
  });
  it('limits natural tails to automatic unknown-voice auto style and preserves B beginning', () => {
    const a = analysis(), b = analysis(); b.audibleStart = 0.3;
    for (let i = 960; i < 1000; i++) a.curves.rmsDb[i] = -15 - (i - 960) * 0.7;
    const tail = (style: 'auto' | 'smooth') => humanTransitionScenarios(base(), a, b, { ...DEFAULT_AUTOMIX_SETTINGS, style }).find(x => x.name === 'natural-tail-start')!;
    expect(tail('auto').auditionOnly).toBe(false);
    expect(humanTransitionScenarios(aligned(), a, b, DEFAULT_AUTOMIX_SETTINGS).find(x => x.name === 'natural-tail-start')!.auditionOnly).toBe(true);
    expect(tail('smooth').auditionOnly).toBe(true);
    b.vocalActivity = { rate: 1, values: [1], source: 'demucs', model: 'test' };
    expect(tail('auto').auditionOnly).toBe(true);
    expect(tail('auto').plan.bEntry).toBe(0.3);
  });
  it('respects disabled processing and refuses incomplete decay measurements', () => {
    expect(humanTransitionScenarios(base(), analysis(), analysis(), { ...DEFAULT_AUTOMIX_SETTINGS, enabled: false })).toEqual([]);
    expect(humanTransitionScenarios({ ...base(), debug: { processingAllowed: false } }, analysis(), analysis(), DEFAULT_AUTOMIX_SETTINGS)).toEqual([]);
    const a = analysis();
    for (let i = 960; i < 1000; i++) a.curves.rmsDb[i] = -15 - (i - 960) * 0.7;
    a.curves.rmsDb[997] = NaN;
    expect(humanTransitionScenarios(base(), a, analysis(), DEFAULT_AUTOMIX_SETTINGS).some(x => x.name === 'natural-tail-start')).toBe(false);
  });
  it('offers a measured arrival only for audition, with audible opening and native close tempi', () => {
    const a = analysis(), b = analysis();
    a.beat = b.beat = { stable: true, confidence: 0.9, bpm: 120 } as NonNullable<TrackAnalysis['beat']>;
    b.curves.rmsDb = Array.from({ length: 1000 }, (_, i) => i < 40 ? -25 : -15);
    b.curves.lowDb = [...b.curves.rmsDb];
    b.structure = { segments: [{ start: 4, novelty: 0.8 }] } as TrackAnalysis['structure'];
    const candidate = humanTransitionScenarios(base(), a, b, DEFAULT_AUTOMIX_SETTINGS).find(x => x.name === 'arrival-build')!;
    expect(candidate.auditionOnly).toBe(true);
    expect(candidate.plan.aExit + candidate.plan.swapAt).toBeCloseTo(96);
    expect(candidate.plan.bEntry + candidate.plan.swapAt).toBe(4);
    expect(candidate.plan.automation.some(l => l.lane === 'mid')).toBe(false);
    expect(candidate.plan.beatAlign).toBeUndefined();
    b.beat = { ...b.beat!, bpm: 90 };
    expect(humanTransitionScenarios(base(), a, b, DEFAULT_AUTOMIX_SETTINGS).some(x => x.name === 'arrival-build')).toBe(false);
  });
  it('keeps the arrival inside A and requires a measured window after B arrives', () => {
    const a = analysis(), b = analysis();
    a.beat = b.beat = { stable: true, confidence: 0.9, bpm: 120 } as NonNullable<TrackAnalysis['beat']>;
    a.audibleEnd = 96;
    a.phrases = [92, 96];
    b.curves.rmsDb = Array.from({ length: 1000 }, (_, i) => i < 40 ? -25 : -15);
    b.curves.lowDb = [...b.curves.rmsDb];
    b.structure = { segments: [{ start: 4, novelty: 0.8 }] } as TrackAnalysis['structure'];
    const arrival = () => humanTransitionScenarios(base(), a, b, DEFAULT_AUTOMIX_SETTINGS).find(x => x.name === 'arrival-build');
    expect(arrival()!.plan.aExit + arrival()!.plan.swapAt).toBeCloseTo(92);
    expect(arrival()!.plan.aExit + arrival()!.plan.duration).toBeLessThanOrEqual(a.audibleEnd);
    a.phrases = [96];
    expect(arrival()).toBeUndefined();
    a.phrases = [92]; b.audibleEnd = 4.8;
    expect(arrival()).toBeUndefined();
  });
  it('keeps the incoming first words instead of silently advancing the old B cue', () => {
    const p = humanTransitionScenarios(base(), analysis(), analysis(), { ...DEFAULT_AUTOMIX_SETTINGS, entryMode: 'preserve', maxEntrySkipSeconds: 0 })[0].plan;
    expect(p.bEntry).toBe(0);
    expect(p.aExit + p.duration).toBeCloseTo(96);
    expect(p.duration - p.bDelay!).toBeLessThan(0.5);
    expect(p.tempoA).toBeUndefined();
    expect(p.tempoB).toEqual([[0, 1]]);
    expect(p.vocalA).toBeUndefined();
    expect(p.echo).toBeUndefined();
    expect(p.beatAlign).toBeUndefined();
    expect(p.debug.fullMix).toBeUndefined();
    expect(p.automation.every(l => l.lane === 'gain')).toBe(true);
  });
  it('does not invent closure from a beat grid or force a recipe without evidence', () => {
    const a = analysis(); a.phraseConfidence = 0.1;
    expect(humanTransitionScenarios(base(), a, analysis(), DEFAULT_AUTOMIX_SETTINGS)).toEqual([]);
  });
  it('preserves the natural recording tail and holds B at its opening until release', () => {
    const a = analysis();
    for (let i = 960; i < 1000; i++) a.curves.rmsDb[i] = -15 - (i - 960) * 0.7;
    const p = humanTransitionScenarios(base(), a, analysis(), DEFAULT_AUTOMIX_SETTINGS).find(x => x.name === 'natural-tail-start')!.plan;
    expect(p.aExit + p.duration).toBe(100);
    expect(p.duration - p.bDelay!).toBe(0.5);
    expect(p.automation.find(l => l.deck === 'B')!.points.at(-1)![0]).toBe(0.5);
  });
  it('bounds source clocks and never rewinds A behind the prepared start', () => {
    const a = analysis(), b = analysis(); b.duration = b.audibleEnd = 0.6;
    for (const { plan: p } of humanTransitionScenarios(base(), a, b, { ...DEFAULT_AUTOMIX_SETTINGS, maxBlendSeconds: 0.7, eqHandoff: false })) {
      expect(p.duration).toBeLessThanOrEqual(0.7);
      expect(p.aExit).toBeGreaterThanOrEqual(80);
      expect(p.aExit + p.duration).toBeLessThanOrEqual(a.duration);
      expect(p.bEntry + p.duration - p.bDelay!).toBeLessThanOrEqual(b.duration);
    }
    expect(humanTransitionScenarios({ ...base(), aExit: 99.9 }, a, b, DEFAULT_AUTOMIX_SETTINGS)).toEqual([]);
  });
});
