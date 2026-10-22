import { describe, expect, it } from 'vitest';
import { planSkip, planTransition, skipPlanFrom, tempoRelation } from '../src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';
import { renderTransitionOffline } from '../src/engine/arm.ts';
import { Biquad, lowpass } from '../src/dsp/biquad.ts';
import { kWeighting } from '../src/dsp/loudness.ts';
import { fixture, plannerTrack } from './helpers.ts';

const S = DEFAULT_AUTOMIX_SETTINGS;
const house124a = () => fixture({ style: 'house', bpm: 124, tonic: 9, mode: 'minor', bars: 64, seed: 21 });
const house124b = () => fixture({ style: 'house', bpm: 124, tonic: 0, mode: 'major', bars: 64, seed: 22 });
const techno127 = () => fixture({ style: 'techno', bpm: 127, tonic: 4, mode: 'minor', bars: 64, seed: 23 });
const hiphop88 = () => fixture({ style: 'hiphop', bpm: 88, tonic: 2, mode: 'minor', bars: 40, seed: 24 });
const dnb174 = () => fixture({ style: 'dnb', bpm: 174, tonic: 5, mode: 'minor', bars: 80, seed: 25 });
const pop160 = () => fixture({ style: 'pop', bpm: 160, tonic: 7, mode: 'major', bars: 64, seed: 26 });
const ambient = () => fixture({ style: 'ambient', bpm: 70, tonic: 7, mode: 'major', bars: 24, seed: 27, fadeOut: true });

function checkPlanShape(p: TransitionPlan) {
  for (const l of p.automation) {
    for (let i = 1; i < l.points.length; i++) expect(l.points[i][0]).toBeGreaterThanOrEqual(l.points[i - 1][0]);
    for (const [, v] of l.points) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.05);
    }
  }
  for (let i = 1; i < p.tempoB.length; i++) expect(p.tempoB[i][0]).toBeGreaterThanOrEqual(p.tempoB[i - 1][0]);
  expect(p.tempoB[p.tempoB.length - 1][1]).toBe(1);
  const aGain = p.automation.find((l) => l.deck === 'A' && l.lane === 'gain');
  if (p.duration > 0.1 && aGain) expect(aGain.points[aGain.points.length - 1][1]).toBe(0);
  const bGain = p.automation.find((l) => l.deck === 'B' && l.lane === 'gain');
  if (bGain) expect(bGain.points[bGain.points.length - 1][1]).toBe(1);
}

describe('tempo relation', () => {
  it('handles same, close, half and double tempo', () => {
    expect(tempoRelation(124, 124).stretchPercent).toBe(0);
    expect(tempoRelation(124, 127).ratio).toBeCloseTo(124 / 127, 6);
    const h = tempoRelation(87, 174);
    expect(h.m).toBe(0.5);
    expect(h.stretchPercent).toBeLessThan(0.01);
    expect(tempoRelation(174, 86).m).toBe(2);
    expect(tempoRelation(124, 160).stretchPercent).toBeGreaterThan(20);
  });

  it('limits the largest speed change on either deck, in either direction', () => {
    expect(tempoRelation(100, 112).stretchPercent).toBeCloseTo(12, 8);
    expect(tempoRelation(112, 100).stretchPercent).toBeCloseTo(12, 8);
  });
});

/** Exact measured-feature fixtures isolate planning from beat detector errors. */
function measuredTrack(id: string, bpm: number, introSeconds = 0, duration = 180): PlannerTrack {
  const period = 60 / bpm;
  const beats = Array.from({ length: Math.ceil(duration / period) }, (_, i) => i * period).filter((t) => t < duration);
  const downbeats = beats.filter((_t, i) => i % 4 === 0);
  const phrases = beats.filter((_t, i) => i % 32 === 0);
  const rmsDb = Array.from({ length: Math.ceil(duration * 20) }, (_, i) => i / 20 < introSeconds ? -35 : -16);
  const analysis: TrackAnalysis = {
    version: 'measured-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: { bpm, period, confidence: 0.95, stable: true, jitterMs: 0, beats, downbeats, downbeatConfidence: 0.9, downbeatPhase: 0, alternatives: [] },
    rhythmStrength: 0.95,
    key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases, phraseConfidence: 0.8,
    sectionBoundaries: introSeconds ? [introSeconds] : [],
    intro: { start: 0, end: introSeconds }, outro: { start: duration - 16, end: duration }, bodyRmsDb: -16,
    curves: {
      rate: 20, rmsDb, lowDb: rmsDb.map((v) => v - 3), midDb: rmsDb.map((v) => v - 6), highDb: rmsDb.map((v) => v - 10),
      midDensity: rmsDb.map((v) => v < -25 ? 0.03 : 0.3),
    },
    peaks: rmsDb.map(() => 0.8),
    cues: {
      entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }, ...(introSeconds ? [{ time: introSeconds, score: 0.8, kind: 'section' as const, tags: ['energy-arrival'] }] : [])],
      exit: downbeats.filter((t) => t > duration - 40).map((time) => ({ time, score: 0.8, kind: 'downbeat' as const, tags: ['outro'] })),
    },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.95, onsetRate: 0.4, bassWeight: 0.6, midDensity: 0.4, dynamics: 0.2, acousticness: 0.1 },
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}

function consumed(points: [number, number][], duration: number): number {
  if (points.length === 1) return points[0][1] * duration;
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += (points[i][0] - points[i - 1][0]) * (points[i][1] + points[i - 1][1]) / 2;
  return sum;
}

describe('adaptive structural entries and limits', () => {
  it('enters around 20–30 seconds when a measured section follows a long quiet introduction', () => {
    const a = measuredTrack('a', 124);
    const b = measuredTrack('b', 160, 32);
    const p = planTransition(a, b, S);
    expect(p.bEntry).toBeGreaterThanOrEqual(20);
    expect(p.bEntry).toBeLessThanOrEqual(30);
    expect(p.entrySelection!.skippedSeconds).toBeCloseTo(p.bEntry, 2);
    expect(p.entrySelection!.arrivalTime).toBeCloseTo(32, 0);
  });

  it('preserves the complete opening when requested and obeys a smaller skip budget', () => {
    const a = measuredTrack('a', 124);
    const b = measuredTrack('b', 160, 32);
    const preserve = planTransition(a, b, { ...S, entryMode: 'preserve' });
    expect(preserve.bEntry).toBe(0);
    expect(preserve.entrySelection!.kind).toBe('start');
    const limited = planTransition(a, b, { ...S, maxEntrySkipSeconds: 10 });
    expect(limited.bEntry).toBeLessThanOrEqual(10);
  });

  it('can use one or two bars for slow material under a strict overlap cap', () => {
    const p = planTransition(measuredTrack('a', 60), measuredTrack('b', 63), { ...S, maxBlendSeconds: 6 });
    expect(p.method).toBe('beatmatch_blend');
    expect(p.duration).toBeLessThanOrEqual(6);
    expect(p.beatAlign!.overlapBeats).toBeLessThanOrEqual(8);
    for (const l of p.automation) expect(l.points[l.points.length - 1][0]).toBeLessThanOrEqual(p.duration + 0.001);
  });

  it('v2: does not meet halfway when a full glide would need more than 8 % (100 → 112)', () => {
    const p = planTransition(measuredTrack('a', 100), measuredTrack('b', 112), { ...S, maxStretchPercent: 11 });
    expect(p.method).not.toBe('tempo_bridge');
    for (const [, rate] of [...(p.tempoA ?? [[0, 1]]), ...p.tempoB]) expect(Math.abs(rate - 1)).toBeLessThanOrEqual(0.08 + 1e-9);
  });

  it('covers different BPM pairs without unbounded stretching or silent joins', () => {
    for (const [bpmA, bpmB] of [[60, 63], [70, 140], [100, 112], [112, 100], [90, 180], [128, 160], [83, 117], [174, 87]]) {
      const a = measuredTrack(`a-${bpmA}`, bpmA);
      const b = measuredTrack(`b-${bpmB}`, bpmB);
      const p = planTransition(a, b, S);
      expect(p.duration, `${bpmA} → ${bpmB}`).toBeGreaterThan(0);
      expect(p.duration).toBeLessThanOrEqual(S.maxBlendSeconds + 0.001);
      expect(p.tempoB.every(([, v]) => Math.abs(v - 1) <= S.maxStretchPercent / 100 + 0.00001)).toBe(true);
      expect(p.tempoA?.every(([, v]) => Math.abs(v - 1) <= S.maxStretchPercent / 100 + 0.00001) ?? true).toBe(true);
      if (p.method === 'beatmatch_blend') {
        const nativeA = consumed(p.tempoA ?? [[0, 1]], p.duration);
        const nativeB = consumed(p.tempoB, p.duration);
        expect(p.aExit + nativeA).toBeLessThanOrEqual(a.analysis!.audibleEnd + 0.005);
        expect(p.bEntry + nativeB).toBeLessThan(b.analysis!.audibleEnd);
        expect(nativeA).toBeCloseTo(p.beatAlign!.overlapBeats * 60 / bpmA, 2);
        expect(nativeB / nativeA).toBeCloseTo(p.beatAlign!.ratio, 4);
      }
      checkPlanShape(p);
    }
  });

  it('keeps every method below the duration cap, including sub-second clips', () => {
    const clipped = planTransition(measuredTrack('a', 124, 0, 0.2), measuredTrack('b', 160, 0, 0.3), { ...S, maxBlendSeconds: 0.1 });
    expect(clipped.duration).toBeLessThanOrEqual(0.1);
    const fallback = planTransition(plannerTrack('a', null, { duration: 0.2 }), plannerTrack('b', null, { duration: 0.1 }), S);
    expect(fallback.duration).toBeLessThanOrEqual(0.1);
    const off = planTransition(measuredTrack('a', 124), measuredTrack('b', 124), { ...S, maxBlendSeconds: 0 });
    expect(off.duration).toBe(0);
  });

  it('drops old tempo and echo processing when a prepared plan becomes a manual skip', () => {
    const prepared = planTransition(measuredTrack('a', 124), measuredTrack('b', 127), S);
    prepared.echo = { delay: 0.4, feedback: 0.5 };
    const p = skipPlanFrom(prepared, 85);
    expect(p.tempoA).toBeUndefined();
    expect(p.echo).toBeUndefined();
    expect(p.tempoB).toEqual([[0, 1]]);
  });

  it('does not create a loudness hole when a sparse outro meets a percussive intro', () => {
    const a = fixture({ style: 'dnb', bpm: 174, tonic: 5, mode: 'minor', bars: 80, seed: 206 });
    const b = fixture({ style: 'house', bpm: 124, tonic: 9, mode: 'minor', bars: 64, seed: 207 });
    const p = planTransition(plannerTrack('a', a), plannerTrack('b', b), S);
    const r = renderTransitionOffline(a.pcm, b.pcm, p, 8, 5);
    const levels = shortTerm(r);
    const start = r.transitionStartFrame / r.sampleRate;
    const before = levels.filter((l) => l.time > start - 4 && l.time < start - 0.5).map((l) => l.lufs).sort((a, b) => a - b);
    const reference = before[Math.floor(before.length / 2)];
    const earlyHandoff = levels.filter((l) => l.time >= start && l.time <= start + Math.min(8, p.duration));
    expect(Math.min(...earlyHandoff.map((l) => l.lufs)) - reference).toBeGreaterThan(-3);
    expect(r.metrics.underruns).toBe(0);
    expect(r.metrics.peak).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 0.0001);
  });
});

/** 3 s K-weighted loudness every 0.25 s, timed at the end of its window. */
function shortTerm(r: { L: Float32Array; R: Float32Array; sampleRate: number }) {
  const [shelf, hp] = kWeighting(r.sampleRate);
  const filters = [[new Biquad(shelf), new Biquad(hp)], [new Biquad(shelf), new Biquad(hp)]];
  const win = r.sampleRate * 3;
  const energy = new Float32Array(win);
  const levels: { time: number; lufs: number }[] = [];
  let sum = 0;
  for (let i = 0; i < r.L.length; i++) {
    const l = filters[0][1].process(filters[0][0].process(r.L[i]));
    const rr = filters[1][1].process(filters[1][0].process(r.R[i]));
    const power = l * l + rr * rr;
    sum += power - energy[i % win];
    energy[i % win] = power;
    if (i >= win && i % 11025 === 0) levels.push({ time: i / r.sampleRate, lufs: -0.691 + 10 * Math.log10(Math.max(1e-12, sum / win)) });
  }
  return levels;
}

describe('loudness through band handoffs', () => {
  it.each([['pop', 'dnb'], ['ambient', 'house']] as const)('%s → %s: the middle is not hollowed out by gains and EQ at once', (from, to) => {
    const make = { pop: pop160, dnb: dnb174, ambient, house: house124a };
    const a = make[from](), b = make[to]();
    const p = planTransition(plannerTrack('a', a), plannerTrack('b', b), S);
    expect(p.debug.loudnessHold).toBeDefined();
    checkPlanShape(p); // raised faders never exceed a deck's own level
    const r = renderTransitionOffline(a.pcm, b.pcm, p, 8, 8);
    const levels = shortTerm(r), start = r.transitionStartFrame / r.sampleRate, end = start + p.duration;
    const median = (x: number[]) => [...x].sort((u, v) => u - v)[Math.floor(x.length / 2)];
    const before = median(levels.filter((l) => l.time > start - 5 && l.time < start - 0.5).map((l) => l.lufs));
    const after = median(levels.filter((l) => l.time > end + 3.5 && l.time < end + 8).map((l) => l.lufs));
    const during = levels.filter((l) => l.time >= start + 1.5 && l.time <= end + 1.5).map((l) => l.lufs);
    expect(Math.min(...during) - Math.min(before, after)).toBeGreaterThan(-3);
    expect(r.metrics.peak).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 0.0001);
  });
});

describe('v2 filter washout between unlocked grooves', () => {
  it('never runs the two decks’ bass/kicks together (124 → 160 BPM)', () => {
    const a = house124a(), b = pop160();
    const p = planTransition(plannerTrack('a', a), plannerTrack('b', b), S);
    expect(p.method).toBe('crossfade');
    expect(p.debug.washout).toBe(true);
    // render each deck alone with its real lanes, the other deck muted
    const solo = (deck: 'A' | 'B') => renderTransitionOffline(a.pcm, b.pcm, { ...p, automation: [
      ...p.automation.filter((l) => l.deck === deck || l.lane !== 'gain'),
      { deck: deck === 'A' ? 'B' : 'A', lane: 'gain', points: [[0, 0]] },
    ] }, 4, 2);
    const low = (r: ReturnType<typeof solo>) => {
      const f = new Biquad(lowpass(r.sampleRate, 120, 0.7)), blk = Math.round(r.sampleRate * 0.25), out: number[] = [];
      let e = 0;
      for (let i = 0; i < r.L.length; i++) { const y = f.process(r.L[i]); e += y * y; if ((i + 1) % blk === 0) { out.push(10 * Math.log10(e / blk + 1e-12)); e = 0; } }
      return out;
    };
    const rA = solo('A'), rB = solo('B'), la = low(rA), lb = low(rB);
    const blk = Math.round(rA.sampleRate * 0.25), s0 = Math.ceil(rA.transitionStartFrame / blk), s1 = Math.floor((rA.transitionStartFrame + p.duration * rA.sampleRate) / blk);
    const ref = Math.max(...la.slice(Math.max(0, s0 - 12), s0));
    let overlap = -Infinity;
    for (let k = s0; k < s1; k++) overlap = Math.max(overlap, Math.min(la[k], lb[k]) - ref);
    // at every moment at least one deck's bass is ≥ 18 dB below A's bass before the blend
    // (the old mid-point bass swap ran both at about -12 dB for ~1.75 s)
    expect(overlap).toBeLessThan(-18);
  });
});

describe('transition planner', () => {
  it('beatmatches tracks with the same BPM on phrase boundaries', () => {
    const p = planTransition(plannerTrack('a', house124a()), plannerTrack('b', house124b()), S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.beatAlign!.stretchPercent).toBeLessThan(0.3);
    expect(p.beatAlign!.overlapBeats % 16).toBe(0);
    expect(p.aExit).toBeGreaterThan(house124a().analysis.duration * 0.45);
    // exit point is a downbeat of A
    expect(house124a().analysis.beat!.downbeats.some((t) => Math.abs(t - p.aExit) < 0.002)).toBe(true);
    expect(house124b().analysis.beat!.downbeats.some((t) => Math.abs(t - p.bEntry) < 0.002)).toBe(true);
    checkPlanShape(p);
    // bass swap: A low ends at 0, B low starts at 0
    expect(p.automation.find((l) => l.deck === 'B' && l.lane === 'low')!.points[0][1]).toBe(0);
  });

  it('glides the common tempo from A to B while keeping beats locked', () => {
    const p = planTransition(plannerTrack('a', house124a()), plannerTrack('b', techno127()), S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.beatAlign!.glide).toBe(true);
    expect(p.beatAlign!.stretchPercent).toBeGreaterThan(1.5);
    expect(p.tempoA).toBeDefined();
    // A starts native and ends at B's tempo; B starts at A's tempo and ends native
    expect(p.tempoA![0][1]).toBe(1);
    expect(p.tempoA![p.tempoA!.length - 1][1]).toBeCloseTo(127 / 124, 2);
    expect(p.tempoB[0][1]).toBeCloseTo(124 / 127, 2);
    expect(p.tempoB[p.tempoB.length - 1]).toEqual([p.duration, 1]);
    // B speed = A speed * constant everywhere (beats stay aligned)
    for (let i = 0; i < p.tempoB.length - 1; i++) expect(p.tempoB[i][1] / p.tempoA![i][1]).toBeCloseTo(124 / 127, 3);
    // long, musical overlap
    expect(p.duration).toBeGreaterThan(10);
    checkPlanShape(p);
  });

  it('respects the max stretch setting', () => {
    const p = planTransition(plannerTrack('a', house124a()), plannerTrack('b', techno127()), { ...S, maxStretchPercent: 1 });
    expect(p.method).not.toBe('beatmatch_blend');
    expect(p.fallbackReason).toMatch(/темп/);
  });

  it('locks half/double tempo pairs', () => {
    const p = planTransition(plannerTrack('a', hiphop88()), plannerTrack('b', dnb174()), S);
    expect(p.method).toBe('beatmatch_blend');
    expect(p.beatAlign!.relation).toBe(0.5);
    expect(p.beatAlign!.stretchPercent).toBeLessThan(2);
  });

  it('v2: uses a long unlocked blend for a large tempo gap (no echo of A’s groove over B, no abrupt cut)', () => {
    const p = planTransition(plannerTrack('a', house124a()), plannerTrack('b', pop160()), S);
    expect(p.method).toBe('crossfade');
    expect(p.duration).toBeGreaterThanOrEqual(8);
    expect(p.echo).toBeUndefined();
    expect(p.tempoB).toEqual([[0, 1]]);
    expect(p.fallbackReason).toMatch(/темп/);
    // the ending of A is heard: transition runs to A's audible end
    expect(p.aExit + p.duration).toBeGreaterThan(house124a().analysis.audibleEnd - 1);
    checkPlanShape(p);
  });

  it('uses a short phrase cut only when short transitions are requested', () => {
    const p = planTransition(plannerTrack('a', house124a()), plannerTrack('b', pop160()), { ...S, style: 'tight' });
    expect(p.method).toBe('phrase_cut');
    expect(p.duration).toBeLessThan(5);
    checkPlanShape(p);
  });

  it('uses an equal-power crossfade for beatless material', () => {
    const p = planTransition(plannerTrack('a', ambient()), plannerTrack('b', house124a()), S);
    expect(p.method).toBe('crossfade');
    expect(p.tempoB).toEqual([[0, 1]]);
    checkPlanShape(p);
    const a = p.automation.find((l) => l.deck === 'A' && l.lane === 'gain')!;
    const b = p.automation.find((l) => l.deck === 'B' && l.lane === 'gain')!;
    // no hole in the middle: summed power stays up
    const at = (l: typeof a, t: number) => {
      const pts = l.points;
      for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (t - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0]);
      return pts[pts.length - 1][1];
    };
    for (const f of [0.25, 0.5, 0.75]) expect(at(a, p.duration * f) ** 2 + at(b, p.duration * f) ** 2).toBeGreaterThan(0.6);
    expect(p.duration).toBeGreaterThanOrEqual(3);
  });

  it('falls back safely when analysis is missing', () => {
    const p = planTransition(plannerTrack('a', null, { duration: 200 }), plannerTrack('b', house124b()), S);
    expect(p.method).toBe('fallback_crossfade');
    expect(p.fallbackReason).toMatch(/анализ/);
    expect(p.aExit).toBeLessThan(200);
    checkPlanShape(p);
  });

  it('plays consecutive album tracks gapless', () => {
    const a = plannerTrack('a', house124a(), { album: 'X', albumArtist: 'Y', trackNo: 3 });
    const b = plannerTrack('b', house124b(), { album: 'X', albumArtist: 'Y', trackNo: 4 });
    const p = planTransition(a, b, S);
    expect(p.method).toBe('gapless');
    expect(p.duration).toBe(0);
    expect(p.aExit).toBeCloseTo(a.duration, 2);
    expect(p.bEntry).toBe(0);
  });

  it('never mixes sources that do not allow processing', () => {
    const p = planTransition(plannerTrack('a', house124a()), plannerTrack('b', house124b(), { mixingAllowed: false }), S);
    expect(p.method).toBe('gapless');
    expect(p.tempoB).toEqual([[0, 1]]);
    expect(p.automation).toHaveLength(0);
  });

  it('plays tracks in sequence when AutoMix is disabled', () => {
    const p = planTransition(plannerTrack('a', house124a()), plannerTrack('b', house124b()), { ...S, enabled: false });
    expect(p.method).toBe('gapless');
    expect(p.bEntry).toBe(0);
  });

  it('is deterministic (same inputs, same plan id and points)', () => {
    const p1 = planTransition(plannerTrack('a', house124a()), plannerTrack('b', techno127()), S);
    const p2 = planTransition(plannerTrack('a', house124a()), plannerTrack('b', techno127()), S);
    expect(p1).toEqual(p2);
  });

  it('builds a fast skip fade from the current position', () => {
    const p = planSkip(plannerTrack('a', house124a()), plannerTrack('b', house124b()), 42.5, S);
    expect(p.method).toBe('skip_fade');
    expect(p.aExit).toBe(42.5);
    expect(p.duration).toBeLessThan(1);
  });
});
