import { describe, expect, it } from 'vitest';
import { planTransition } from '../src/plan/planner.ts';
import { pointValue } from '../src/plan/timing.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';

const S = DEFAULT_AUTOMIX_SETTINGS;
const RATE = 20;

/** Measured-looking analysis: steady grid, level/low curves per second, separated-voice activity spans. */
function track(id: string, bpm: number, o: { duration?: number; voice: [number, number][]; audibleStart?: number;
  rms?: (t: number) => number; low?: (t: number) => number; stems?: boolean }): PlannerTrack {
  const duration = o.duration ?? 180, period = 60 / bpm, start = o.audibleStart ?? 0;
  const beats = Array.from({ length: Math.ceil((duration - start) / period) }, (_, i) => start + i * period).filter(t => t < duration);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  const frames = Math.ceil(duration * RATE), at = (i: number) => i / RATE;
  const rmsDb = Array.from({ length: frames }, (_, i) => at(i) < start ? -90 : (o.rms ?? (() => -9))(at(i)));
  const lowDb = Array.from({ length: frames }, (_, i) => at(i) < start ? -90 : (o.low ?? (() => -11))(at(i)));
  const values = Array.from({ length: frames }, (_, i) => o.voice.some(([a, b]) => at(i) >= a && at(i) < b) ? 0.9 : 0);
  const analysis: TrackAnalysis = {
    version: 'unlocked-test', duration, audibleStart: start, audibleEnd: duration,
    loudness: { integratedLufs: -9, samplePeakDb: -1, truePeakDb: -1 },
    beat: { bpm, period, beats, downbeats, confidence: 0.95, stable: true, jitterMs: 2, downbeatConfidence: 0.8, downbeatPhase: 0, alternatives: [] },
    rhythmStrength: 0.95, key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases: downbeats.filter((_, i) => i % 8 === 0), phraseConfidence: 0.6,
    sectionBoundaries: [], intro: { start, end: start }, outro: { start: duration - 10, end: duration }, bodyRmsDb: -9,
    curves: { rate: RATE, rmsDb, lowDb, midDb: rmsDb.map(v => v - 6), highDb: rmsDb.map(v => v - 14), midDensity: rmsDb.map(() => 0.3) },
    peaks: rmsDb.map(() => 0.8),
    cues: { entry: [{ time: start, score: 0.76, kind: 'start', tags: [] }], exit: [] },
    features: { energy: 0.7, brightness: 0.5, rhythmStrength: 0.95, onsetRate: 0.4, bassWeight: 0.8, midDensity: 0.3, dynamics: 0.2, acousticness: 0.1 },
    warnings: [], elapsedMs: 0,
    ...(o.stems === false ? {} : { vocalActivity: { rate: RATE, values, source: 'demucs' as const, model: 'test' } }),
  };
  return { id, duration, mixingAllowed: true, analysis };
}

const lane = (p: TransitionPlan, deck: 'A' | 'B', name: string) => p.automation.find(l => l.deck === deck && l.lane === name)?.points ?? [[0, 1]] as [number, number][];
const sungAt = (an: TrackAnalysis, src: number) => { const v = an.vocalActivity!; return (v.values[Math.floor(src * v.rate)] ?? 0) > 0.5; };

/** Output-time checks shared by both layouts: words kept, one voice, a bar between lines, grooves never together. */
function checkHandoff(p: TransitionPlan, a: PlannerTrack, b: PlannerTrack, lowQuietA: (src: number) => boolean) {
  const A = a.analysis!, B = b.analysis!, delay = p.bDelay ?? 0, bar = 4 * A.beat!.period;
  let lastA = -Infinity, firstB = Infinity;
  // past the overlap A is gone and every lane/mask holds its last value: B's first line may come later
  for (let t = 0; t <= p.duration + 15; t += 0.02) {
    const srcA = p.aExit + t, ga = t > p.duration ? 0 : pointValue(lane(p, 'A', 'gain'), t), tb = t - delay, srcB = p.bEntry + tb;
    const gb = tb < 0 ? 0 : pointValue(lane(p, 'B', 'gain'), tb);
    // A's words are never masked while A is heard; B's never once B is heard
    if (ga > 0.05 && sungAt(A, srcA)) { expect(pointValue(p.vocalA ?? [[0, 1]], t)).toBeGreaterThan(0.5); lastA = t; }
    if (gb > 0.05 && sungAt(B, srcB)) { expect(pointValue(p.vocalB ?? [[0, 1]], tb)).toBeGreaterThan(0.5); firstB = Math.min(firstB, t); }
    // the two grooves never run together: wherever both decks are up, A's bass is already gone
    if (ga > 0.05 && gb > 0.05) expect(pointValue(lane(p, 'A', 'low'), t) < 0.05 || lowQuietA(srcA)).toBe(true);
  }
  // A's line before the transition counts too
  for (let src = p.aExit; src > p.aExit - 12 && lastA === -Infinity; src -= 0.02) if (sungAt(A, src)) lastA = src - p.aExit;
  expect(firstB).toBeLessThan(Infinity);
  expect(firstB - lastA).toBeGreaterThanOrEqual(bar - 0.05);
  // nothing of A's measured singing after the transition start is skipped
  for (let src = p.aExit; src < A.audibleEnd; src += 0.05) if (sungAt(A, src)) expect(pointValue(lane(p, 'A', 'gain'), src - p.aExit)).toBeGreaterThan(0.5);
}

describe('echo out between unlockable grooves', () => {
  // 152 → 100 BPM: 31.6 % apart, not a 2:1 pair either (cf. listener dislike 256)
  const a = track('a', 152, { voice: [[20, 150]] });
  const b = track('b', 100, { voice: [[8, 170]] });

  it('throws A’s last bar into a one-beat echo and starts B on its downbeat after it', () => {
    const p = planTransition(a, b, S);
    expect(p.method).toBe('echo_out');
    expect(p.echo!.delay).toBeCloseTo(60 / 152, 2);
    const A = a.analysis!, B = b.analysis!, bar = 4 * A.beat!.period;
    // A exits on its own bar grid, after its last sung line
    expect(A.beat!.downbeats.some(t => Math.abs(t - p.aExit) < 0.002)).toBe(true);
    expect(p.aExit).toBeGreaterThanOrEqual(150 - 0.01);
    // A is cut at the end of that bar; its echo send is open only on that bar's last beats
    expect(pointValue(lane(p, 'A', 'gain'), bar - 0.04)).toBe(1);
    expect(pointValue(lane(p, 'A', 'gain'), bar + 0.01)).toBe(0);
    expect(pointValue(lane(p, 'A', 'echo'), bar - 0.1)).toBeGreaterThan(0.5);
    expect(pointValue(lane(p, 'A', 'echo'), bar + 0.05)).toBe(0);
    expect(pointValue(lane(p, 'A', 'low'), bar - 0.05)).toBeLessThan(0.01);
    // B starts on one of its downbeats, after A's cut (silent pre-roll or bDelay)
    const startsAt = p.bDelay ?? lane(p, 'B', 'gain').find(([, v]) => v > 0.5)![0];
    expect(startsAt).toBeGreaterThan(bar);
    expect(B.beat!.downbeats.some(t => Math.abs(t - (p.bEntry + (p.bDelay ? 0 : startsAt))) < 0.03)).toBe(true);
    // B's skipped opening holds no words
    expect(p.bEntry + (p.bDelay ? 0 : startsAt)).toBeLessThanOrEqual(8);
    checkHandoff(p, a, b, () => false);
  });

  it('keeps the existing unlocked blend without measured voices or for a moderate tempo gap', () => {
    const plain = planTransition(track('a', 152, { voice: [[20, 150]], stems: false }), track('b', 100, { voice: [], stems: false }), S);
    expect(plain.method).not.toBe('echo_out');
    const near = planTransition(track('a', 120, { voice: [[20, 150]] }), track('b', 140, { voice: [[8, 170]] }), S);
    expect(near.method).not.toBe('echo_out');
  });

  it('half/double tempo pairs still lock instead (87 → 174 BPM)', () => {
    const p = planTransition(track('a', 87, { voice: [[20, 150]] }), track('b', 174, { voice: [[8, 170]] }), S);
    expect(p.method).toBe('beatmatch_blend');
  });
});

describe('echo out when B sings from its first moment', () => {
  // 89 → 130 BPM (cf. listener dislike 259): A's groove stops at 116, its line ends at 118 over a
  // bass-free tail; B's intro voice starts at once and its beat comes later
  const quietTail = (t: number) => t >= 116;
  const a = track('a', 89, { duration: 128, voice: [[20, 118]], rms: t => quietTail(t) ? -24 : -9, low: t => quietTail(t) ? -50 : -11 });
  const b = track('b', 130, { duration: 150, audibleStart: 0.3, voice: [[0.3, 140]], rms: t => t < 7 ? -18 : -9, low: t => t < 7 ? -40 : -11 });

  it('lets A finish its line and starts B from its beginning a bar later, over A’s beatless tail', () => {
    const p = planTransition(a, b, S);
    expect(p.method).toBe('echo_out');
    expect(p.bEntry).toBeLessThanOrEqual(0.3);
    expect(p.bDelay ?? 0).toBe(0);
    checkHandoff(p, a, b, src => quietTail(src));
  });
});
