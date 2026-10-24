import { describe, expect, it } from 'vitest';
import { barPattern, drumAlignment, planTransition } from '../src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type BeatGrid, type PlannerTrack, type TrackAnalysis } from '../src/types.ts';
import { fixture } from './helpers.ts';

/** Kick on bar positions 0 and 2, snare on 1 and 3, counted from beat `drumPhase`. */
function accents(n: number, drumPhase: number, flat = false) {
  const pos = (i: number) => (((i - drumPhase) % 4) + 4) % 4;
  return {
    kick: Array.from({ length: n }, (_, i) => (flat ? 1 : pos(i) % 2 === 0 ? 1.6 : 0.4)),
    snare: Array.from({ length: n }, (_, i) => (flat ? 1 : pos(i) % 2 === 1 ? 1.7 : 0.5)),
  };
}

/** A 120 BPM song whose analysed downbeats are beats 0, 4, 8...; its drums start their bar at `drumPhase`. */
function song(id: string, drumPhase: number, flat = false): PlannerTrack {
  const duration = 180, rate = 20, period = 0.5;
  const beats = Array.from({ length: duration / period }, (_, i) => i * period);
  const beat: BeatGrid = {
    bpm: 120, confidence: 0.9, period, stable: true, jitterMs: 2, beats, downbeats: beats.filter((_, i) => i % 4 === 0),
    downbeatConfidence: 0.4, downbeatPhase: 0, alternatives: [], accents: accents(beats.length, drumPhase, flat),
  };
  const rmsDb = Array.from({ length: duration * rate }, () => -16);
  const analysis: TrackAnalysis = {
    version: 'drum-alignment-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat, beatRegions: [], rhythmStrength: 0.9,
    key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases: beat.downbeats.filter((_, i) => i % 8 === 0), phraseConfidence: 0.8,
    sectionBoundaries: [16], intro: { start: 0, end: 16 }, outro: { start: 164, end: duration }, bodyRmsDb: -16,
    curves: { rate, rmsDb, lowDb: rmsDb.map((v) => v - 3), midDb: rmsDb.map((v) => v - 6), highDb: rmsDb.map((v) => v - 10), midDensity: rmsDb.map(() => 0.3) },
    peaks: rmsDb.map(() => 0.8),
    cues: {
      entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }, { time: 16, score: 0.85, kind: 'section', tags: ['energy-arrival'] }],
      exit: beat.downbeats.filter((t) => t > 140).map((time) => ({ time, score: 0.8, kind: 'downbeat' as const, tags: ['outro'] })),
    },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.9, onsetRate: 0.4, bassWeight: 0.6, midDensity: 0.3, dynamics: 0.2, acousticness: 0.1 },
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}

/** Bar position (0 = drum downbeat) of the beat each deck plays at the transition start. */
const drumPos = (track: PlannerTrack, time: number) => {
  const g = track.analysis!.beat!, i = g.beats.findIndex((t) => Math.abs(t - time) < 0.004);
  expect(i).toBeGreaterThanOrEqual(0);
  return g.accents!.kick[i] > 1 && g.accents!.snare[i] < 1 ? 'kick' : 'snare';
};

describe('drum-pattern bar alignment', () => {
  it('measures a one-beat rotation between bar patterns', () => {
    const g = song('x', 0).analysis!.beat!, h = song('y', 1).analysis!.beat!;
    const m = drumAlignment(barPattern(g, 0, 40)!, barPattern(h, 0, 40)!)!;
    expect(m[0]).toBeCloseTo(-1, 6);
    expect(m[1]).toBeCloseTo(1, 6);
    expect(barPattern({ ...g, accents: undefined }, 0, 40)).toBeNull();
    expect(drumAlignment(barPattern(g, 0, 40)!, barPattern(song('z', 0, true).analysis!.beat!, 0, 40)!)).toBeNull();
  });

  it('moves B one beat so kick meets kick when its analysed downbeat is a beat off', () => {
    const a = song('a', 0), b = song('b', 1);
    const p = planTransition(a, b, S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.debug.drumPattern).toMatchObject({ k: 1 });
    // A starts on its drum downbeat; B now starts on its (unanalysed) drum downbeat too
    expect(drumPos(a, p.aExit)).toBe('kick');
    expect(drumPos(b, p.bEntry)).toBe('kick');
    expect(b.analysis!.beat!.downbeats.some((t) => Math.abs(t - p.bEntry) < 0.004)).toBe(false);
    expect(p.beatAlign!.phraseAligned).toBe(false);
    expect(p.reasons.some((r) => r.includes('рисунок ударных'))).toBe(true);
  });

  it('keeps an already agreeing alignment, and the plan without accents, unchanged', () => {
    const a = song('a', 0), b = song('b', 0);
    const p = planTransition(a, b, S);
    expect(p.debug.drumPattern).toMatchObject({ k: 0 });
    const strip = (t: PlannerTrack): PlannerTrack => ({ ...t, analysis: { ...t.analysis!, beat: { ...t.analysis!.beat!, accents: undefined } } });
    const q = planTransition(strip(a), strip(b), S);
    expect([p.aExit, p.bEntry, p.duration, p.method]).toEqual([q.aExit, q.bEntry, q.duration, q.method]);
    expect(q.debug.drumPattern).toBeUndefined();
  });

  it('never skips the opening in preserve mode to fix the pattern', () => {
    const p = planTransition(song('a', 0), song('b', 1), { ...S, entryMode: 'preserve' });
    expect(p.bEntry).toBe(0);
    expect(p.debug.drumPattern).toMatchObject({ k: 0, blocked: 'preserve-opening' });
  });

  it('never shifts the drum entry beyond the listener’s skip budget', () => {
    const p = planTransition(song('a', 0), song('b', 1), { ...S, maxEntrySkipSeconds: 0.2 });
    expect(p.method).toBe('beatmatch_blend');
    expect(p.bEntry).toBeLessThanOrEqual(0.2);
    expect(p.debug.drumPattern).toMatchObject({ k: 0 });
  });

  it('does not rotate backwards into trimmed leading silence', () => {
    const a = song('a', 0), b = song('b', 1);
    b.analysis!.audibleStart = 2;
    b.analysis!.cues.entry = [{ time: 2, score: 1, kind: 'start', tags: [] }];
    // At the skip ceiling the forward half-beat is forbidden. The opposite
    // rotation would land at 0.5 s, inside trimmed leading silence.
    const p = planTransition(a, b, { ...S, maxEntrySkipSeconds: 0.2 });
    expect(p.method).toBe('beatmatch_blend');
    expect(p.bEntry).toBeGreaterThanOrEqual(2);
    expect(p.bEntry).toBeLessThanOrEqual(2.2);
  });

  it('analysis stores kick and snare accents on the beat grid', () => {
    const f = fixture({ style: 'hiphop', bpm: 88, tonic: 9, mode: 'minor', bars: 32, seed: 1 });
    const g = f.analysis.beat!;
    expect(g.accents!.kick).toHaveLength(g.beats.length);
    const p = barPattern(g, g.beats[8], g.beats[g.beats.length - 8])!;
    // synthetic hip-hop: kick on 1 (and 3 or its offbeat), snare on 2 and 4 of each true bar
    expect(p[0][0]).toBeGreaterThan(1.5 * Math.max(p[0][1], p[0][3]));
    expect(Math.min(p[1][1], p[1][3])).toBeGreaterThan(1.5 * Math.max(p[1][0], p[1][2]));
    // a steady four-on-the-floor kick is no bar evidence
    const house = fixture({ style: 'house', bpm: 124, tonic: 9, mode: 'minor', bars: 32, seed: 1 }).analysis.beat!;
    const hp = barPattern(house, house.beats[8], house.beats[house.beats.length - 8])!;
    expect(drumAlignment([hp[0], hp[0]], [hp[0], hp[0]])).toBeNull();
    for (const r of f.analysis.beatRegions ?? []) expect(r.accents!.snare).toHaveLength(r.beats.length);
  });
});
