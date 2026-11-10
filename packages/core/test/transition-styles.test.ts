import { describe, expect, it } from 'vitest';
import { planRequestedTransition, planTransition } from '../src/plan/planner.ts';
import { pointValue } from '../src/plan/timing.ts';
import { renderTransitionOffline, planToArmed } from '../src/engine/arm.ts';
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
    // no separate bass cut of A; v19.4 soft: no high-pass sweep either
    expect(lane(p, 'A', 'low')).toBeUndefined();
    expect(p.bDelay).toBe(p.swapAt);
    // 3/4 beat, feedback up to 0.78; the send is 0.6 on the last beat, then 0.4, 0.2 and closed 3 beats after the cut
    expect(p.echo!.delay).toBeCloseTo(0.75 * 60 / 124, 3);
    expect(p.echo!.feedback).toBeGreaterThan(0.7);
    expect(p.echo!.feedback).toBeLessThanOrEqual(0.78);
    const send = lane(p, 'A', 'echo')!, beat = 60 / 124;
    expect(pointValue(send, p.swapAt - 0.1)).toBeGreaterThan(0.4);
    expect(pointValue(send, p.swapAt)).toBeCloseTo(0.6, 3);
    expect(pointValue(send, p.swapAt + beat)).toBeCloseTo(0.4, 2);
    expect(pointValue(send, p.swapAt + 2 * beat)).toBeCloseTo(0.2, 2);
    expect(pointValue(send, p.swapAt + 3 * beat + 0.01)).toBe(0);
    // B eases in over half its own beat, reaching unity within its own bar.
    expect(pointValue(lane(p, 'B', 'gain')!, 0.05)).toBeLessThan(0.4);
    expect(pointValue(lane(p, 'B', 'gain')!, 4 * beat)).toBe(1);
  });

  it('renders a softer B attack without delaying or skipping its source', () => {
    const p = planTransition(song('a', 124, { sparsePhrases: true }), song('b', 160), S);
    const sampleRate = 8000, quiet = new Float32Array(180 * sampleRate);
    const tone = Float32Array.from(quiet, (_, i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
    const a = { L: quiet, R: quiet, sampleRate }, b = { L: tone, R: tone, sampleRate };
    const old = { ...p, automation: p.automation.map(l => l.deck === 'B' && l.lane === 'gain'
      ? { ...l, points: [[0, 0], [0.01, 0.8], [4 * 60 / 124, 1]] as [number, number][] } : l) };
    const soft = renderTransitionOffline(a, b, p, 0, 1), hard = renderTransitionOffline(a, b, old, 0, 1);
    const energy = (v: Float32Array, from: number, to: number) => {
      const start = Math.round((p.bDelay! + from) * sampleRate), end = Math.round((p.bDelay! + to) * sampleRate);
      let sum = 0; for (let i = start; i < end; i++) sum += v[i] ** 2; return sum / (end - start);
    };
    expect(soft.metrics.underruns).toBe(0);
    expect(soft.events.some(e => e.type === 'transitionEnd')).toBe(true);
    expect(energy(soft.L, 0.02, 0.08)).toBeLessThan(energy(hard.L, 0.02, 0.08) * 0.3);
    expect(energy(soft.L, 2.1, 2.3)).toBeCloseTo(energy(hard.L, 2.1, 2.3), 3);
    expect(soft.L.every(Number.isFinite)).toBe(true);
  });

  it('echo out: a low-pass muffles A’s echo tail after the cut', () => {
    const p = planTransition(song('a', 124, { sparsePhrases: true }), song('b', 160), S);
    expect(p.debug.variant).toBe('drop-swap');
    const filter = lane(p, 'A', 'filter')!;
    expect(filter.every(([, v]) => v <= 0)).toBe(true);
    expect(pointValue(filter, p.swapAt)).toBeCloseTo(-0.25, 3);
    expect(pointValue(filter, p.swapAt + 0.4)).toBeCloseTo(-0.3, 3);
    expect(pointValue(filter, p.duration)).toBeCloseTo(-0.3, 3);
  });

  it('echo out never trims B’s intro: B enters at its audible start, including its pickup after leading silence', () => {
    const b = song('b', 160, { softIntro: 16 });
    b.analysis!.cues.entry.push({ time: b.analysis!.beat!.downbeats.find(t => t >= 16)!, score: 0.95, kind: 'section', tags: [] });
    const p = planTransition(song('a', 124, { sparsePhrases: true }), b, S);
    expect(p.debug.variant).toBe('drop-swap');
    expect(p.bEntry).toBe(0);
    expect(p.entrySelection!.kind).toBe('start');
    const silent = song('b', 160);
    silent.analysis!.audibleStart = 2.3;
    const q = planTransition(song('a', 124, { sparsePhrases: true }), silent, S);
    expect(q.debug.variant).toBe('drop-swap');
    expect(q.bEntry).toBe(2.3);
    expect(q.bDelay).toBe(q.swapAt);
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

  it('echo out: B has no bass gate and no filter (v19.4 soft)', () => {
    const p = planTransition(song('a', 124, { sparsePhrases: true }), song('b', 160), S);
    expect(p.debug.variant).toBe('drop-swap');
    expect(lane(p, 'B', 'low')).toBeUndefined();
    expect(lane(p, 'B', 'filter')).toBeUndefined();
    // the transition still lasts two of B's bars
    expect(p.duration - p.bDelay!).toBeGreaterThanOrEqual(2 * 4 * 60 / 160 - 0.001);
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
