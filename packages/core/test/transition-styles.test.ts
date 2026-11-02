import { describe, expect, it } from 'vitest';
import { planRequestedTransition, planTransition } from '../src/plan/planner.ts';
import { pointValue } from '../src/plan/timing.ts';
import { planToArmed } from '../src/engine/arm.ts';
import { LoopPcmSource } from '../src/engine/loop.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, type PlannerTrack, type TrackAnalysis } from '../src/types.ts';

// v19 style selection: bass-swap blend (default lock), filter handoff (lock, A at full energy),
// drop swap (steady grooves that cannot lock), crossfade fallback (shaky grid).
function song(id: string, bpm: number, o: { fade?: number; jitterMs?: number; stable?: boolean; sparsePhrases?: boolean; softIntro?: number } = {}): PlannerTrack {
  const duration = 180, rate = 20, period = 60 / bpm;
  const beats = Array.from({ length: Math.ceil(duration / period) }, (_, i) => i * period).filter(t => t < duration);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  // an optional natural fade over the last `fade` seconds
  const rmsDb = Array.from({ length: duration * rate }, (_, i) => o.fade && i / rate > duration - o.fade ? -16 - 30 * (i / rate - duration + o.fade) / o.fade
    : o.softIntro && i / rate < o.softIntro ? -21 : -16);
  const analysis: TrackAnalysis = {
    version: 'styles-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: { bpm, period, beats, downbeats, confidence: 0.95, stable: o.stable ?? true, jitterMs: o.jitterMs ?? 2, downbeatConfidence: 0.9, downbeatPhase: 0, alternatives: [] },
    rhythmStrength: 0.95, key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases: downbeats.filter((_, i) => i % 8 === 0), phraseConfidence: 0.8,
    sectionBoundaries: [], intro: { start: 0, end: 0 }, outro: { start: duration - 16, end: duration }, bodyRmsDb: -16,
    // sparsePhrases: A's middle thins out around each phrase start (a line ends there: a clean exit)
    curves: { rate, rmsDb, lowDb: rmsDb.map(v => v - 3), midDb: rmsDb.map(v => v - 6), highDb: rmsDb.map(v => v - 10),
      midDensity: rmsDb.map((_, i) => o.sparsePhrases && downbeats.some((t, k) => k % 8 === 0 && Math.abs(i / rate - t) < 2 * period) ? 0.05 : 0.2) },
    peaks: rmsDb.map(() => 0.8),
    cues: { entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }], exit: downbeats.filter(t => t > duration - 40).map(time => ({ time, score: 0.8, kind: 'downbeat' as const, tags: [] })) },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.95, onsetRate: 0.4, bassWeight: 0.6, midDensity: 0.2, dynamics: 0.2, acousticness: 0.1 },
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}
const lane = (p: ReturnType<typeof planTransition>, deck: 'A' | 'B', name: string) => p.automation.find(l => l.deck === deck && l.lane === name)?.points;

describe('v19 transition styles', () => {
  it('filter handoff: a lock over A at full energy keeps at most 8 bars, mids take turns and A leaves through a high-pass', () => {
    const p = planTransition(song('a', 120), song('b', 122), S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.debug.style).toBe('filter-handoff');
    expect(p.beatAlign!.overlapBeats).toBeLessThanOrEqual(32);
    const filter = lane(p, 'A', 'filter')!;
    expect(pointValue(filter, p.swapAt)).toBe(0);
    expect(pointValue(filter, p.duration)).toBeCloseTo(0.8, 3);
    // B's mids stay back until the bass swap: the two leads overlap only around it
    expect(pointValue(lane(p, 'B', 'mid')!, p.swapAt * 0.5)).toBeLessThanOrEqual(0.36);
    // the filter carries A out: its fader stays up until the last bar; B's middle is as dense as its
    // body after the swap (a voice is likely), so A's mids leave within a beat there (0.3)
    expect(pointValue(lane(p, 'A', 'gain')!, p.duration - 4 * 0.5 - 0.05)).toBe(1);
    expect(Math.min(...lane(p, 'A', 'mid')!.map(([, v]) => v))).toBeCloseTo(0.3, 3);
    expect(pointValue(lane(p, 'A', 'mid')!, p.swapAt + 0.5 + 0.01)).toBeLessThan(0.35);
  });

  it('bass-swap blend: A in its outro (natural fade) keeps the plain lock without the filter handoff', () => {
    const p = planTransition(song('a', 120, { fade: 30 }), song('b', 122), S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.debug.style).toBeUndefined();
    expect(lane(p, 'A', 'filter')).toBeUndefined();
  });

  it('echo out: a clean phrase exit swaps on A’s downbeat with an audible 3/4-beat echo', () => {
    const a = song('a', 124, { sparsePhrases: true }), p = planTransition(a, song('b', 160), S);
    expect(p.debug.variant).toBe('drop-swap');
    const cut = p.aExit + p.swapAt;
    expect(a.analysis!.phrases.some(t => Math.abs(t - cut) < 0.002)).toBe(true);
    // The high-pass carries A's bass out without a second cut that dips the level.
    expect(lane(p, 'A', 'low')).toBeUndefined();
    expect(pointValue(lane(p, 'A', 'filter')!, p.swapAt)).toBeCloseTo(0.3, 3);
    expect(p.bDelay).toBe(p.swapAt);
    // 3/4 beat; v19.3 lets it breathe: feedback up to 0.82 and the send fades over a bar after the cut
    expect(p.echo!.delay).toBeCloseTo(0.75 * 60 / 124, 3);
    expect(p.echo!.feedback).toBeGreaterThan(0.75);
    expect(p.echo!.feedback).toBeLessThanOrEqual(0.82);
    const send = lane(p, 'A', 'echo')!, bar = 4 * 60 / 124;
    expect(pointValue(send, p.swapAt + bar / 2)).toBeGreaterThan(0.3);
    expect(pointValue(send, p.swapAt + bar + 0.01)).toBe(0);
    expect(pointValue(lane(p, 'B', 'gain')!, 0.05)).toBeLessThan(0.85);
  });

  it('loop roll: without a clean exit A’s last bar is caught and rolled 1 → 1/2 → 1/4 → 1/8 bar, B drops on the one', () => {
    const a = song('a', 124), p = planTransition(a, song('b', 160), S);
    expect(p.debug.variant).toBe('loop-roll');
    const loop = p.loopA!, L = loop.end - loop.start;
    expect(L).toBeCloseTo(4 * 60 / 124, 2);
    loop.roll!.forEach((r, i) => expect(r.length / L).toBeCloseTo([0.5, 0.25, 0.125][i], 9));
    // the engine accepts the loop and its rolls at both sample rates (whole-frame grid)
    for (const sr of [44100, 48000]) {
      const source = new LoopPcmSource({ totalFrames: 180 * sr, read: () => true }, sr);
      expect(source.setLoop(planToArmed(p, sr, 'a', 'b').loopA!)).toBe(true);
    }
    expect(loop.until - loop.start).toBeCloseTo(3 * L, 9);
    // the rolled bar is the one before A's phrase boundary; B starts exactly when the roll ends
    expect(a.analysis!.phrases.some(t => Math.abs(t - loop.end) < 0.004)).toBe(true);
    expect(p.aExit).toBeCloseTo(loop.start, 3);
    expect(p.bDelay).toBeCloseTo(3 * L, 3);
    expect(pointValue(lane(p, 'B', 'gain')!, 0.05)).toBe(1);
    expect(pointValue(lane(p, 'A', 'filter')!, p.swapAt)).toBeCloseTo(0.6, 3);
  });

  it('echo out: B opens gradually from its muffled intro (2-4 bars, about 4 s), bass waits a beat', () => {
    const p = planTransition(song('a', 124, { sparsePhrases: true }), song('b', 160), S);
    expect(p.debug.variant).toBe('drop-swap');
    const barB = 4 * 60 / 160, span = 3 * barB; // ceil(4 s / 1.5 s) = 3 bars
    expect(pointValue(lane(p, 'B', 'filter')!, 0)).toBeCloseTo(-0.5, 3);
    expect(pointValue(lane(p, 'B', 'filter')!, barB)).toBeLessThan(-0.3);
    expect(pointValue(lane(p, 'B', 'filter')!, span)).toBe(0);
    expect(pointValue(lane(p, 'B', 'gain')!, span)).toBe(1);
    // the transition lasts until B is open (lanes reset to neutral at its end)
    expect(p.duration - p.bDelay!).toBeGreaterThanOrEqual(span - 0.001);
    expect(pointValue(lane(p, 'B', 'low')!, 0.7 * 60 / 160)).toBe(0);
    expect(pointValue(lane(p, 'B', 'low')!, 60 / 160 + 0.01)).toBe(1);
  });

  it('a calm, slower B gets a wash, not a hype roll: the bar loops twice, a low-pass closes, B rises softly', () => {
    const p = planTransition(song('a', 129), song('b', 90, { softIntro: 60 }), S);
    expect(p.debug.variant).toBe('loop-wash');
    const loop = p.loopA!, L = loop.end - loop.start;
    expect(loop.roll).toBeUndefined();
    expect(loop.until - loop.start).toBeCloseTo(2 * L, 9);
    expect(pointValue(lane(p, 'A', 'filter')!, p.swapAt)).toBeLessThan(-0.45);
    expect(pointValue(lane(p, 'B', 'gain')!, 0.05)).toBeLessThan(0.7);
    expect(p.echo!.feedback).toBeGreaterThan(0.7 - 1e-9);
    for (const sr of [44100, 48000]) {
      const source = new LoopPcmSource({ totalFrames: 180 * sr, read: () => true }, sr);
      expect(source.setLoop(planToArmed(p, sr, 'a', 'b').loopA!)).toBe(true);
    }
    // the same pair with an energetic B keeps the build-up roll
    expect(planTransition(song('a', 129), song('b', 90), S).debug.variant).toBe('loop-roll');
  });

  it('Next uses the same moves on the next downbeat', () => {
    const a = song('a', 124), p = planRequestedTransition(a, song('b', 160), 100, { ...S, mixOnNext: true });
    expect(['drop-swap', 'loop-roll']).toContain(p.debug.variant);
    expect(p.aExit).toBeGreaterThan(100);
    expect(p.aExit).toBeLessThan(100 + 0.2 + 4 * 60 / 124);
  });

  it('a loose grid gets no loop roll (the loop needs an exact bar)', () => {
    const p = planTransition(song('a', 124, { jitterMs: 15 }), song('b', 160), S);
    expect(p.debug.variant).toBe('drop-swap');
    expect(p.loopA).toBeUndefined();
  });

  it('falls back to the short crossfade on a shaky grid or when A fades out by itself', () => {
    for (const [a, b] of [[song('a', 124, { jitterMs: 25 }), song('b', 160)], [song('a', 124), song('b', 160, { stable: false })], [song('a', 124, { fade: 20 }), song('b', 160)]]) {
      const p = planTransition(a, b, S);
      expect(p.method).toBe('crossfade');
      expect(p.duration).toBeLessThanOrEqual(16);
    }
  });
});
