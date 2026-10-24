import { describe, expect, it } from 'vitest';
import { planTransition } from '../src/plan/planner.ts';
import { integrateTempo } from '../src/plan/timing.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type BeatGrid, type BeatRegion, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';
function rhythm(bpm: number, start: number, end: number, phase = start): BeatRegion {
  const period = 60 / bpm;
  const beats = Array.from({ length: Math.ceil((end - phase) / period) }, (_, i) => phase + i * period).filter((t) => t >= start && t < end);
  return { start, end, bpm, period, confidence: 0.93, jitterMs: 2, beats, downbeats: beats.filter((_, i) => i % 4 === 0), downbeatConfidence: 0.85, downbeatPhase: 0 };
}

function song(id: string, bpm: number, { intro = 0, voice = true, phase = 0, global = true, regions = [] as BeatRegion[] } = {}): PlannerTrack {
  const duration = 180, rate = 20;
  const rmsDb = Array.from({ length: duration * rate }, (_, i) => i / rate < intro ? -34 : -16);
  const pulse = rhythm(bpm, 0, duration, phase);
  const beat: BeatGrid = { ...pulse, stable: global, alternatives: [] };
  const analysis: TrackAnalysis = {
    version: 'dj-policy-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: global ? beat : null, beatRegions: regions, rhythmStrength: 0.93,
    key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases: pulse.downbeats.filter((_, i) => i % 8 === 0), phraseConfidence: 0.8,
    sectionBoundaries: intro ? [intro] : [], intro: { start: 0, end: intro }, outro: { start: 164, end: duration }, bodyRmsDb: -16,
    curves: { rate, rmsDb, lowDb: rmsDb.map((v) => v - 3), midDb: rmsDb.map((v) => v - 6), highDb: rmsDb.map((v) => v - 10), midDensity: rmsDb.map(() => 0.3) },
    peaks: rmsDb.map(() => 0.8),
    cues: {
      entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }, ...(intro ? [{ time: intro, score: 0.85, kind: 'section' as const, tags: ['energy-arrival'] }] : [])],
      exit: pulse.downbeats.filter((t) => t > 140).map((time) => ({ time, score: 0.8, kind: 'downbeat' as const, tags: ['outro'] })),
    },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.93, onsetRate: 0.4, bassWeight: 0.6, midDensity: 0.3, dynamics: 0.2, acousticness: 0.1 },
    ...(voice ? { vocalActivity: { rate: 10, values: Array.from({ length: duration * 10 }, (_, i) => i / 10 < intro ? 0.03 : 0.85), source: 'demucs' as const, model: 'measured-test' } } : {}),
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}


function inside(plan: TransitionPlan, region: BeatRegion, deck: 'A'|'B') {
  const start = deck === 'A' ? plan.aExit : plan.bEntry;
  const map = deck === 'A' ? plan.tempoA : plan.tempoB;
  expect(start).toBeGreaterThanOrEqual(region.start - 0.001);
  expect(start + integrateTempo(map, plan.duration)).toBeLessThanOrEqual(region.end + 0.005);
}

describe('local transition recovery', () => {
  it('recovers compatible outro tempo even when both global grids are marked stable', () => {
    const region = rhythm(118, 142, 180);
    const a = song('a', 90, { voice: false, regions: [region] });
    const b = song('b', 121, { voice: false });
    const p = planTransition(a, b, S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.debug.localRhythm).toBe(true);
    expect(p.beatAlign!.bpmA).toBe(118);
    expect(p.beatAlign!.overlapBeats).toBeGreaterThanOrEqual(16);
    inside(p, region, 'A');
  });

  it('finds a measured entry whose phase differs from every whole-song cue', () => {
    const region = rhythm(121, 12.37, 55);
    const a = song('a', 118, { voice: false });
    const b = song('b', 90, { voice: false, regions: [region] });
    const p = planTransition(a, b, S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.beatAlign!.bpmB).toBe(121);
    expect(p.bEntry).toBeCloseTo(12.37, 3);
    inside(p, region, 'B');
    expect(planTransition(a, b, { ...S, entryMode: 'preserve' }).debug.localRhythm).not.toBe(true);
    expect(planTransition(a, b, { ...S, maxEntrySkipSeconds: 10 }).debug.localRhythm).not.toBe(true);
  });

  it('allows a gradual 9 percent local glide only over at least eight bars', () => {
    const region = rhythm(120, 136, 180);
    const a = song('a', 90, { voice: false, regions: [region] });
    const b = song('b', 131, { voice: false });
    const settings = { ...S, maxStretchPercent: 10, maxBlendSeconds: 32 };
    const p = planTransition(a, b, settings);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.debug.localRhythm).toBe(true);
    expect(p.beatAlign!.stretchPercent).toBeGreaterThan(8);
    expect(p.beatAlign!.overlapBeats).toBeGreaterThanOrEqual(32);
    expect(p.duration).toBeGreaterThanOrEqual(12);
    inside(p, region, 'A');
    // The actual piecewise tempo maps must advance both metrical grids together,
    // not merely report a compatible BPM in diagnostics.
    for (let i = 0; i <= 100; i++) {
      const t = p.duration * i / 100;
      const beatsA = integrateTempo(p.tempoA, t) / region.period;
      const beatsB = integrateTempo(p.tempoB, t) / b.analysis!.beat!.period;
      expect(Math.abs(beatsA - beatsB)).toBeLessThan(0.002);
    }
    expect(planTransition(a, b, { ...settings, maxStretchPercent: 8 }).debug.localRhythm).not.toBe(true);
    expect(planTransition(a, b, { ...settings, maxBlendSeconds: 10 }).debug.localRhythm).not.toBe(true);
    expect(planTransition(a, b, { ...settings, style: 'tight' }).debug.localRhythm).not.toBe(true);
  });

  it('preserves half-time matching in a recovered local region', () => {
    const region = rhythm(130, 136, 180);
    const a = song('a', 90, { voice: false, regions: [region] });
    const b = song('b', 65, { voice: false });
    const p = planTransition(a, b, S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.debug.localRhythm).toBe(true);
    expect(p.beatAlign!.relation).toBe(2);
    expect(p.beatAlign!.stretchPercent).toBe(0);
    inside(p, region, 'A');
  });

  it('keeps successful global planning and ignores weak local hypotheses', () => {
    const a = song('a', 118, { voice: false });
    const b = song('b', 121, { voice: false });
    const original = planTransition(a, b, S);
    a.analysis!.beatRegions = [rhythm(95, 136, 180)];
    expect(planTransition(a, b, S)).toEqual(original);
    a.analysis!.beat = song('other', 90).analysis!.beat;
    a.analysis!.beatRegions = [{ ...rhythm(118, 136, 180), confidence: 0.4 }];
    expect(planTransition(a, b, S).debug.localRhythm).not.toBe(true);
  });
});
