import { describe, expect, it } from 'vitest';
import { effectiveExit, fullMixCost, localClashFraction, pickupLost, voiceUnknown, withBassShift } from '../src/plan/fullmix.ts';
import { planFinalists, planTransition } from '../src/plan/planner.ts';
import { chooseByRender, finalistSpans, renderMetrics } from '../src/engine/render-check.ts';
import { DEFAULT_AUTOMIX_SETTINGS as S, ANALYZER_VERSION, type PlannerTrack, type TrackAnalysis, type TransitionPlan } from '../src/types.ts';
import { fixture } from './helpers.ts';

function song(id: string, bpm: number, { voice = false, density = 0.3, duration = 180 } = {}): PlannerTrack {
  const rate = 20, period = 60 / bpm;
  const rmsDb = Array.from({ length: duration * rate }, () => -16);
  const beats = Array.from({ length: Math.floor(duration / period) }, (_, i) => i * period);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  const analysis: TrackAnalysis = {
    version: 'fullmix-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 },
    beat: { bpm, period, confidence: 0.93, stable: true, jitterMs: 2, beats, downbeats, downbeatConfidence: 0.85, downbeatPhase: 0, alternatives: [] },
    beatRegions: [], rhythmStrength: 0.93,
    key: { tonic: -1, mode: 'unknown', name: 'unknown', camelot: '', confidence: 0 },
    phrases: downbeats.filter((_, i) => i % 8 === 0), phraseConfidence: 0.8,
    sectionBoundaries: [], intro: { start: 0, end: 0 }, outro: { start: duration - 16, end: duration }, bodyRmsDb: -16,
    curves: { rate, rmsDb, lowDb: rmsDb.map(v => v - 3), midDb: rmsDb.map(v => v - 6), highDb: rmsDb.map(v => v - 10), midDensity: rmsDb.map(() => density) },
    peaks: rmsDb.map(() => 0.8),
    cues: { entry: [{ time: 0, score: 0.76, kind: 'start', tags: [] }], exit: downbeats.filter(t => t > duration - 40).map(time => ({ time, score: 0.8, kind: 'downbeat' as const, tags: [] })) },
    features: { energy: 0.6, brightness: 0.5, rhythmStrength: 0.93, onsetRate: 0.4, bassWeight: 0.6, midDensity: density, dynamics: 0.2, acousticness: 0.1 },
    ...(voice ? { vocalActivity: { rate: 10, values: new Array(duration * 10).fill(0.03), source: 'demucs' as const, model: 'measured-test' } } : {}),
    warnings: [], elapsedMs: 0,
  };
  return { id, duration, mixingAllowed: true, analysis };
}

function blend(D: number, fadeFrom: number): TransitionPlan {
  return { id: 'p', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'crossfade', confidence: 0.6, reasons: [],
    aExit: 150, bEntry: 0, duration: D, gap: 0, swapAt: D / 2, tempoB: [[0, 1]], gainA: 0, gainB: 0, debug: {},
    automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [fadeFrom, 1], [fadeFrom + 1, 0], [D, 0]] }, { deck: 'B', lane: 'gain', points: [[0, 0], [2, 1], [D, 1]] }] };
}

describe('full-mix rules without vocal maps', () => {
  it('distinguishes unknown voices from measured ones (research §3.2)', () => {
    const plain = song('a', 120).analysis!, measured = song('b', 120, { voice: true }).analysis!;
    expect(voiceUnknown(plain, S)).toBe(true);
    expect(voiceUnknown(measured, S)).toBe(false);
    expect(voiceUnknown(measured, { ...S, stemMixing: false })).toBe(true);
  });

  it('judges where A is really gone, not the formal end of the overlap (P2)', () => {
    const A = song('a', 120).analysis!;
    expect(effectiveExit(blend(12, 3), A).t).toBeLessThan(4.5);
    expect(effectiveExit(blend(12, 3), A).source).toBeCloseTo(150 + effectiveExit(blend(12, 3), A).t, 3);
    expect(effectiveExit(blend(12, 10.5), A).t).toBeGreaterThan(10);
  });

  it('notices a cut pickup only where the beat before the entry rises into it (P3)', () => {
    const B = song('b', 120).analysis!;
    expect(pickupLost(B, 0)).toBe(0);
    expect(pickupLost(B, 32)).toBe(0); // steady music before a downbeat is not a pickup
    // a new array: the planner caches the linear power of each analysed curve
    const rms = [...B.curves.rmsDb];
    for (let i = Math.round(31 * 20); i < 32 * 20; i++) rms[i] = -14;
    for (let i = Math.round(30.5 * 20); i < 31 * 20; i++) rms[i] = -24;
    B.curves = { ...B.curves, rmsDb: rms };
    expect(pickupLost(B, 31.5)).toBe(1);
  });

  it('counts overlap risks as shares of the overlap, so a longer blend is not punished for its length', () => {
    const A = song('a', 120).analysis!, B = song('b', 120).analysis!;
    const both = (D: number) => ({ ...blend(D, D - 1), automation: [{ deck: 'A' as const, lane: 'gain' as const, points: [[0, 1], [D, 1]] as [number, number][] },
      { deck: 'B' as const, lane: 'gain' as const, points: [[0, 1], [D, 1]] as [number, number][] }] });
    const short = fullMixCost(both(6), A, B, S)!, long = fullMixCost(both(18), A, B, S)!;
    expect(long.leadRisk).toBeGreaterThan(short.leadRisk);
    expect(long.leadRisk / 18).toBeCloseTo(short.leadRisk / 6, 1);
    expect(long.doubleBass / 18).toBeCloseTo(short.doubleBass / 6, 1);
  });

  it('reads clashing local keys only where both are confident (P9)', () => {
    const A = song('a', 120).analysis!, B = song('b', 120).analysis!;
    expect(localClashFraction(A, 0, 10, B, 0, 10)).toBe(0); // no local data: unknown, no clash claimed
    A.local = { rate: 1, camelot: new Array(180).fill('8A'), keyConfidence: new Array(180).fill(0.6), transients: new Array(180).fill(0.5) };
    B.local = { rate: 1, camelot: new Array(180).fill('2B'), keyConfidence: new Array(180).fill(0.6), transients: new Array(180).fill(0.5) };
    expect(localClashFraction(A, 0, 10, B, 0, 10)).toBe(1);
    B.local.keyConfidence.fill(0.1);
    expect(localClashFraction(A, 0, 10, B, 0, 10)).toBe(0);
    B.local = { ...B.local, camelot: new Array(180).fill('8A'), keyConfidence: new Array(180).fill(0.6) };
    expect(localClashFraction(A, 0, 10, B, 0, 10)).toBe(0);
  });

  it('moves only the bass exchange for a render finalist (P6)', () => {
    const p = { ...blend(12, 8), automation: [...blend(12, 8).automation,
      { deck: 'A' as const, lane: 'low' as const, points: [[0, 1], [5, 1], [6, 0], [12, 0]] as [number, number][] },
      { deck: 'B' as const, lane: 'low' as const, points: [[0, 0], [5, 0], [6, 1], [12, 1]] as [number, number][] }] };
    const q = withBassShift(p, 0.5)!;
    expect(q.automation.find(l => l.deck === 'A' && l.lane === 'low')!.points).toEqual([[0, 1], [5.5, 1], [6.5, 0], [12, 0]]);
    expect(q.automation.filter(l => l.lane === 'gain')).toEqual(p.automation.filter(l => l.lane === 'gain'));
    expect(withBassShift(p, 7)).toBeNull();
  });
});

describe('planner integration', () => {
  it('plans unknown voices as a full mix and keeps measured-voice plans on the stem path', () => {
    const stemless = planTransition(song('a', 120), song('b', 122), S);
    expect(stemless.debug.fullMix).toMatchObject({ policy: 'full-mix-1' });
    expect((stemless.debug.fullMix as { candidates: unknown[] }).candidates.length).toBeGreaterThanOrEqual(2);
    const voiced = planTransition(song('a', 120, { voice: true }), song('b', 122, { voice: true }), S);
    expect(voiced.debug.fullMix).toBeUndefined();
  });

  it('offers the selected plan first among render finalists, with bass variants', () => {
    const a = song('a', 120), b = song('b', 122);
    const finalists = planFinalists(a, b, S), selected = planTransition(a, b, S);
    expect(finalists[0]).toEqual(selected);
    expect(finalists.length).toBeGreaterThan(1);
    expect(finalists.some(p => typeof p.debug.bassShift === 'number')).toBe(true);
    expect(planFinalists(song('a', 120, { voice: true }), song('b', 122, { voice: true }), S)).toHaveLength(1);
  });

  it('does not throw the echo over a dense, unknown last bar of A (P7)', () => {
    const dense = planTransition(song('a', 120, { density: 0.5 }), song('b', 120), S);
    expect(dense.method).toBe('beatmatch_blend');
    expect(dense.debug.fullMixRules).toMatchObject({ echoSafe: false });
    expect(dense.echo).toBeUndefined();
    const voicedEcho = planTransition(song('a', 120, { voice: true, density: 0.5 }), song('b', 120, { voice: true }), S);
    expect((voicedEcho.debug.fullMixRules as unknown)).toBeUndefined();
  });
});

describe('local analysis features (P9)', () => {
  it('stores per-second local key confidence and attack density', () => {
    const f = fixture({ style: 'house', bpm: 124, tonic: 9, mode: 'minor', bars: 32, seed: 3 });
    expect(f.analysis.version).toBe(ANALYZER_VERSION);
    const l = f.analysis.local!;
    expect(l.rate).toBe(1);
    expect(l.camelot.length).toBe(Math.ceil(f.analysis.duration));
    expect(l.keyConfidence.length).toBe(l.camelot.length);
    expect(l.transients.every(x => x >= 0 && x <= 1)).toBe(true);
    // a steady synthetic house loop has attacks in most seconds and some confident local keys
    expect(l.transients.filter(x => x > 0).length).toBeGreaterThan(l.transients.length / 2);
    expect(l.camelot.filter(Boolean).length).toBeGreaterThan(0);
  });
});

describe('render check of finalists (P10)', () => {
  const fa = fixture({ style: 'house', bpm: 124, tonic: 9, mode: 'minor', bars: 48, seed: 11 });
  const fb = fixture({ style: 'house', bpm: 126, tonic: 0, mode: 'major', bars: 48, seed: 12 });
  const a = { id: 'a', duration: fa.pcm.L.length / fa.pcm.sampleRate, mixingAllowed: true, analysis: fa.analysis };
  const b = { id: 'b', duration: fb.pcm.L.length / fb.pcm.sampleRate, mixingAllowed: true, analysis: fb.analysis };
  const span = (f: typeof fa) => ({ pcm: { L: f.pcm.L, R: f.pcm.R, sampleRate: f.pcm.sampleRate }, start: 0 });

  it('measures every finalist on the same PCM and keeps a clean planner choice', async () => {
    const finalists = planFinalists(a, b, S);
    expect(finalists.length).toBeGreaterThan(1);
    const chosen = await chooseByRender(finalists, span(fa), span(fb));
    const check = chosen.debug.renderCheck as { candidates: { metrics: { cost: number } | null }[]; selected: string };
    expect(check.candidates).toHaveLength(finalists.length);
    expect(check.candidates.every(c => c.metrics && Number.isFinite(c.metrics.cost))).toBe(true);
    if (check.candidates[0].metrics!.cost < 0.3) expect(chosen.id).toBe(finalists[0].id);
  });

  it('replaces a selected plan whose render has a bass hole', async () => {
    const [top, ...rest] = planFinalists(a, b, S);
    const holed = { ...top, automation: [...top.automation.filter(l => l.lane !== 'low'),
      { deck: 'A' as const, lane: 'low' as const, points: [[0, 0], [top.duration, 0]] as [number, number][] },
      { deck: 'B' as const, lane: 'low' as const, points: [[0, 0], [top.duration, 0]] as [number, number][] }] };
    const bad = renderMetrics(holed, span(fa), span(fb))!;
    expect(bad.lowHoleSeconds).toBeGreaterThan(1);
    const chosen = await chooseByRender([holed, top, ...rest], span(fa), span(fb));
    expect(chosen.id).not.toBe(holed.id);
    expect(chosen.reasons.at(-1)).toMatch(/проверка рендером/);
  });

  it('does not count a song\'s own double kicks (808 rolls) as flams of the blend', () => {
    // both songs: a kick pair 50 ms apart every half second, at the same phase in the overlap
    const sr = 22050, n = sr * 40, L = new Float32Array(n);
    for (let t = 0; t < 40; t += 0.5) for (const at of [t, t + 0.05]) {
      const i0 = Math.round(at * sr);
      for (let i = 0; i < sr * 0.04 && i0 + i < n; i++) L[i0 + i] += 0.5 * Math.sin(2 * Math.PI * 55 * i / sr) * Math.exp(-i / (sr * 0.01));
    }
    const pcm = { pcm: { L, R: L, sampleRate: sr }, start: 0 };
    const plan: TransitionPlan = { id: 'roll', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'crossfade', confidence: 1, reasons: [], debug: {},
      aExit: 15, bEntry: 0, duration: 8, gap: 0, swapAt: 4, tempoB: [[0, 1]], gainA: 0, gainB: 0,
      automation: [{ deck: 'A', lane: 'gain', points: [[0, 1], [8, 0]] }, { deck: 'B', lane: 'gain', points: [[0, 0], [8, 1]] }] };
    expect(renderMetrics(plan, pcm, pcm)!.flams).toBeLessThanOrEqual(2);
  });

  const tone = (sr: number, seconds: number, side: boolean) => {
    const n = sr * seconds, L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = 0.1 * Math.sin(2 * Math.PI * 60 * i / sr); R[i] = side ? -L[i] : L[i]; }
    return { pcm: { L, R, sampleRate: sr }, start: 0 };
  };
  const plain = (D: number, automation: TransitionPlan['automation']): TransitionPlan => ({ id: 'p', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'crossfade',
    confidence: 1, reasons: [], debug: {}, aExit: 15, bEntry: 0, duration: D, gap: 0, swapAt: D / 2, tempoB: [[0, 1]], gainA: 0, gainB: 0, automation });

  it('hears a missing bass the same way when it is side (L = -R) bass (B3)', () => {
    const D = 4, holed = plain(D, [{ deck: 'A', lane: 'low', points: [[0, 1], [0.1, 0], [D, 0]] }, { deck: 'B', lane: 'low', points: [[0, 0], [D - 0.1, 0], [D, 1]] }]);
    const mid = renderMetrics(holed, tone(44100, 40, false), tone(44100, 40, false))!, side = renderMetrics(holed, tone(44100, 40, true), tone(44100, 40, true))!;
    expect(mid.lowHoleSeconds).toBeGreaterThan(1);
    expect(side.lowHoleSeconds).toBe(mid.lowHoleSeconds);
  });

  it('a steady sparse groove handed over unchanged is not a level bump (B4)', () => {
    const sr = 44100, n = sr * 40, L = new Float32Array(n);
    for (let t = 0; t < 40; t += 0.5) for (const at of [t, t + 0.065]) {
      const i0 = Math.round(at * sr);
      for (let i = 0; i < sr * 0.035 && i0 + i < n; i++) L[i0 + i] += 0.2 * Math.sin(2 * Math.PI * 80 * i / sr) * Math.exp(-i / (sr * 0.012));
    }
    const pcm = { pcm: { L, R: L, sampleRate: sr }, start: 0 };
    const handover = plain(4, [{ deck: 'A', lane: 'gain', points: [[0, 1], [3.99, 1], [4, 0]] }, { deck: 'B', lane: 'gain', points: [[0, 0], [3.99, 0], [4, 1]] }]);
    const m = renderMetrics(handover, pcm, pcm)!;
    expect(m.bumpLU).toBeLessThan(1.5);
    expect(m.flams).toBe(0);
  });

  it('covers every finalist with one source span per deck', () => {
    const finalists = planFinalists(a, b, S), s = finalistSpans(finalists);
    for (const p of finalists) { expect(s.a[0]).toBeLessThanOrEqual(p.aExit - 2); expect(s.b[0]).toBeLessThanOrEqual(p.bEntry); }
  });
});
