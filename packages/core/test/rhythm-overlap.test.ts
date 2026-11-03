import { describe, expect, it } from 'vitest';
import { rhythmOverlap } from '../src/plan/rhythm-overlap.ts';
import type { BeatAccents, BeatGrid, BeatRegion, TrackAnalysis, TransitionPlan } from '../src/types.ts';

const accentsAt = (beats: number[], snareAt = 2): BeatAccents => ({
  kick: beats.map((_, i) => i % 4 === 0 ? 4 : 0.1),
  snare: beats.map((_, i) => i % 4 === snareAt ? 4 : 0.1),
});

function grid(period: number, length = 40, snareAt = 2): BeatGrid {
  const beats = Array.from({ length: Math.floor(length / period) }, (_, i) => i * period);
  return { bpm: 60 / period, period, confidence: 0.95, stable: true, jitterMs: 2, beats,
    downbeats: beats.filter((_, i) => i % 4 === 0), downbeatConfidence: 0.9, downbeatPhase: 0, alternatives: [],
    accents: accentsAt(beats, snareAt) };
}

function track(beat: BeatGrid | null, beatRegions: BeatRegion[] = []): TrackAnalysis {
  return { audibleStart: 0, audibleEnd: 40, beat, beatRegions } as TrackAnalysis;
}

function plan(overrides: Partial<TransitionPlan> = {}): TransitionPlan {
  return { id: 'rhythm-test', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'beatmatch_blend', confidence: 1,
    reasons: [], aExit: 0, bEntry: 0, duration: 8, gap: 0, swapAt: 4, tempoA: [[0, 1]], tempoB: [[0, 1]], gainA: 0, gainB: 0,
    automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [8, 1]] }, { deck: 'B', lane: 'gain', points: [[0, 1], [8, 1]] }], debug: {}, ...overrides };
}

describe('structural beat-accent overlap diagnostics', () => {
  it('keeps nonlinear loop and tape-stop source clocks unknown rather than reporting the unplayed tail', () => {
    const A = track(grid(.5)), B = track(grid(.5));
    expect(rhythmOverlap(plan(), A, B)?.kick?.correlation).toBe(1);
    expect(rhythmOverlap(plan({ loopA: { start: 2, end: 4, until: 8, crossfade: .006 } }), A, B)).toBeNull();
    expect(rhythmOverlap(plan({ tapeStopA: { start: 6, end: 7, crossfade: .01 } }), A, B)).toBeNull();
  });
  it('reports aligned kick and snare accents at the actual output phase', () => {
    const d = rhythmOverlap(plan(), track(grid(0.5)), track(grid(0.5)))!;
    expect(d.interpretation).toBe('structural-beat-accent-agreement-not-audibility');
    expect(d.kick?.correlation).toBe(1);
    expect(d.snare?.correlation).toBe(1);
    expect(d.pairedBeats).toBeGreaterThan(10);
  });

  it('reveals an opposing snare pattern while the kick pattern still aligns', () => {
    const d = rhythmOverlap(plan(), track(grid(0.5, 40, 2)), track(grid(0.5, 40, 0)))!;
    expect(d.kick?.correlation).toBe(1);
    expect(d.snare?.correlation).toBeLessThan(0);
  });

  it('uses the actual slower source beat clock without classifying the feel', () => {
    const d = rhythmOverlap(plan(), track(grid(0.5)), track(grid(1)))!;
    expect(d.grids.B.beats).toBeGreaterThan(7);
    expect(d.pairedBeats).toBeLessThan(d.grids.A.beats);
    expect(d.kick?.correlation).toBeLessThan(1);
    const mapped = rhythmOverlap(plan({ tempoB: [[0, 2]] }), track(grid(0.5)), track(grid(1)))!;
    expect(mapped.pairedBeats).toBeGreaterThan(d.pairedBeats);
    expect(mapped.kick?.correlation).toBe(1);
  });

  it('uses bEntry and bDelay on the incoming source clock', () => {
    const A = track(grid(0.5)), B = track(grid(0.5));
    const delayedAndCued = rhythmOverlap(plan({ bEntry: 0.25, bDelay: 0.25 }), A, B)!;
    const delayIgnored = rhythmOverlap(plan({ bEntry: 0.25 }), A, B)!;
    expect(delayedAndCued.pairedBeats).toBeGreaterThan(delayIgnored.pairedBeats);
    expect(delayedAndCued.kick?.correlation).toBeGreaterThan(delayIgnored.kick?.correlation ?? 1);
  });

  it('uses selected local beat regions and stays unknown for gapped or sequential evidence', () => {
    const localBeats = Array.from({ length: 32 }, (_, i) => i * 0.5);
    const region: BeatRegion = { start: 0, end: 16, bpm: 120, period: 0.5, confidence: 0.95, jitterMs: 2,
      beats: localBeats, downbeats: localBeats.filter((_, i) => i % 4 === 0), downbeatConfidence: 0.9, downbeatPhase: 0,
      accents: accentsAt(localBeats) };
    const localPlan = plan({ beatAlign: { bpmA: 120, bpmB: 120, relation: 1, ratio: 1, stretchPercent: 0,
      overlapBeats: 16, phraseAligned: false, regions: { A: { start: 0, end: 16, period: 0.5, downbeat: 0 }, B: { start: 0, end: 16, period: 0.5, downbeat: 0 } } } });
    expect(rhythmOverlap(localPlan, track(null, [region]), track(null, [region]))?.grids.A.source).toBe('region');

    const complete = grid(0.5), kept = complete.beats.map((_, i) => i < 6 || i > 11);
    const gappedBeats = complete.beats.filter((_, i) => kept[i]);
    const gapped = { ...complete, beats: gappedBeats, accents: {
      kick: complete.accents!.kick.filter((_, i) => kept[i]), snare: complete.accents!.snare.filter((_, i) => kept[i]),
    } };
    expect(rhythmOverlap(plan(), track(gapped), track(complete))).toBeNull();
    expect(rhythmOverlap(plan(), track({ ...complete, confidence: Number.NaN }), track(complete))).toBeNull();
    expect(rhythmOverlap(plan(), track({ ...complete, accents: undefined }), track(complete))).toBeNull();
    expect(rhythmOverlap(plan(), track({ ...complete, stable: false }), track(complete))).toBeNull();
    const ambiguous = { ...track(complete), structure: { gridCheck: { periodHint: { bpm: 90, share: 0.8 } } } } as TrackAnalysis;
    expect(rhythmOverlap(plan(), ambiguous, track(complete))).toBeNull();
    expect(rhythmOverlap(plan({ automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [4, 1], [4.001, 0], [8, 0]] },
      { deck: 'B', lane: 'gain', points: [[0, 0], [4, 0], [4.001, 1], [8, 1]] }] }), track(complete), track(complete))).toBeNull();
    expect(rhythmOverlap(plan({ gap: 1 }), track(complete), track(complete))).toBeNull();
  });
});
