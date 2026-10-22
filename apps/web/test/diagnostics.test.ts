import { describe, expect, it } from 'vitest';
import type { TrackAnalysis, TransitionPlan } from '@automix/core';
import { diagnosticBeatGrid } from '../src/lib/diagnostics.ts';

const analysis = {
  beat: { beats: [0, 1, 2, 3], downbeats: [0, 2], stable: false },
  phrases: [0, 21, 22, 99], phraseConfidence: 0.8,
} as TrackAnalysis;
const plan = {
  beatAlign: { regions: { A: { start: 20, end: 32, period: 0.5, downbeat: 21 } } },
} as TransitionPlan;

describe('transition diagnostic grid', () => {
  it('draws the selected local beats and bars inside their bounds instead of the global hypothesis', () => {
    const grid = diagnosticBeatGrid(analysis, plan, 'A')!;
    expect(grid.local).toBe(true);
    expect(grid.beats).toEqual(Array.from({ length: 24 }, (_, i) => 20 + i * 0.5));
    expect(grid.downbeats).toEqual([21, 23, 25, 27, 29, 31]);
    expect(grid.phrases).toEqual([21]);
  });

  it('works when no global grid exists and omits uncertain phrase claims', () => {
    const grid = diagnosticBeatGrid({ ...analysis, beat: null, phraseConfidence: 0.1 }, plan, 'A')!;
    expect(grid.local).toBe(true);
    expect(grid.beats.length).toBe(24);
    expect(grid.phrases).toEqual([]);
  });

  it('places a measured nearby phrase on the selected bar for a consistent marker', () => {
    const grid = diagnosticBeatGrid({ ...analysis, phrases: [21.01] }, plan, 'A')!;
    expect(grid.phrases).toEqual([21]);
  });

  it('uses only a deck’s own selected region', () => {
    const grid = diagnosticBeatGrid(analysis, plan, 'B')!;
    expect(grid.local).toBe(false);
    expect(grid.beats).toEqual(analysis.beat!.beats);
    expect(grid.downbeats).toEqual(analysis.beat!.downbeats);
    expect(grid.phrases).toEqual([0]);
  });

  it('does not construct markers from invalid region metadata', () => {
    const malformed = { beatAlign: { regions: { A: { start: 20, end: 32, period: 0, downbeat: 21 } } } } as TransitionPlan;
    expect(diagnosticBeatGrid({ ...analysis, beat: null }, malformed, 'A')).toBeNull();
  });
});
