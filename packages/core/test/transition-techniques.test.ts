import { describe, expect, it } from 'vitest';
import { gridTrust, planRequestedTransition, planTransition, sungSeconds } from '../src/plan/planner.ts';
import { integrateTempo, outputTimeAt } from '../src/plan/timing.ts';
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

function bridgePair() {
  const a = song('a', 90), b = song('b', 120);
  const A = a.analysis!;
  for (let i = 174 * A.curves.rate; i < A.curves.rmsDb.length; i++) {
    A.curves.lowDb[i] = -40; A.curves.highDb[i] = -40;
    A.curves.rmsDb[i] = -21;
  }
  A.vocalActivity!.values.fill(0.02, 174 * 10);
  return { a, b };
}

describe('measured transition techniques', () => {
  it('keeps a downbeat cut’s complete de-click ramp inside the outgoing audible audio', () => {
    const a = song('short-ending', 120, { voice: false }), b = song('incoming', 156, { voice: false });
    a.analysis!.audibleEnd = 176.05;
    const p = planTransition(a, b, { ...S, style: 'tight' });
    expect(p.method).toBe('phrase_cut');
    expect(p.aExit + integrateTempo(p.tempoA, p.duration)).toBeLessThanOrEqual(a.analysis!.audibleEnd + 0.001);
  });

  it('uses an instrumental tail to change tempo without truncation or stretching', () => {
    const { a, b } = bridgePair();
    const p = planTransition(a, b, S);
    expect(p.debug.variant).toBe('instrumental-bridge');
    expect(p.aExit + p.duration).toBeCloseTo(180, 3);
    expect(p.bEntry).toBe(0);
    expect(p.tempoB).toEqual([[0, 1]]);
    expect(integrateTempo(p.tempoA, p.duration)).toBe(p.duration);
    expect(p.debug.preparation).toBeGreaterThan(1);
    const bassAt = p.bEntry + p.swapAt;
    expect(b.analysis!.beat!.downbeats.some(t => Math.abs(t - bassAt) < 0.004)).toBe(true);
  });

  it('prepares the bridge before A has already fallen into a quiet ending', () => {
    const { a, b } = bridgePair(), A = a.analysis!;
    for (let i = 170 * 20; i < 174 * 20; i++) A.curves.rmsDb[i] = -16 - (i / 20 - 170) * 2;
    const p = planTransition(a, b, S);
    expect(p.debug.variant).toBe('instrumental-bridge');
    expect(p.aExit).toBeLessThanOrEqual(172);
    expect(p.aExit + p.duration).toBe(180);
  });

  it('rejects a bridge when an energetic first beat hides a later incoming hole', () => {
    const { a, b } = bridgePair();
    b.analysis!.curves.rmsDb.fill(-32, 4 * 20, 7 * 20);
    expect(planTransition(a, b, { ...S, entryMode: 'preserve' }).debug.variant).not.toBe('instrumental-bridge');
  });

  it('does not overlap unmeasured voices while preparing a bridge with stems disabled', () => {
    const { a, b } = bridgePair();
    expect(planTransition(a, b, { ...S, stemMixing: false }).debug.variant).not.toBe('instrumental-bridge');
    delete b.analysis!.vocalActivity;
    expect(planTransition(a, b, S).debug.variant).not.toBe('instrumental-bridge');
  });

  it('rejects a vocal return or percussion return hidden by a quiet tail average', () => {
    for (const kind of ['voice', 'drums', 'missing', 'bad-curve', 'truncated-curve'] as const) {
      const { a, b } = bridgePair(), A = a.analysis!;
      if (kind === 'voice') A.vocalActivity!.values.fill(0.9, 1780, 1785);
      if (kind === 'drums') A.curves.highDb.fill(-15, 178 * 20, 178.5 * 20);
      if (kind === 'missing') delete A.vocalActivity;
      if (kind === 'bad-curve') A.curves.midDb[178 * 20] = NaN;
      if (kind === 'truncated-curve') A.curves.rmsDb.length = 178 * 20;
      expect(planTransition(a, b, S).debug.variant).not.toBe('instrumental-bridge');
    }
  });

  it('keeps preserve-opening and refuses a low-confidence arrival', () => {
    const { a, b } = bridgePair();
    b.analysis!.beat!.downbeats = b.analysis!.beat!.downbeats.map(t => t + 0.3);
    expect(planTransition(a, b, { ...S, entryMode: 'preserve' }).debug.variant).not.toBe('instrumental-bridge');
    b.analysis!.beat!.downbeatConfidence = 0.1;
    expect(planTransition(a, b, S).debug.variant).not.toBe('instrumental-bridge');
  });

  it('does not introduce techniques across album/source restrictions or into manual Next', () => {
    const { a, b } = bridgePair();
    a.album = b.album = 'album'; a.trackNo = 1; b.trackNo = 2;
    expect(planTransition(a, b, { ...S, respectAlbums: true }).method).toBe('gapless');
    a.mixingAllowed = false;
    expect(planTransition(a, b, S).method).toBe('gapless');
    a.mixingAllowed = true; a.album = b.album = undefined;
    expect(planRequestedTransition(a, b, 120, { ...S, mixOnNext: true }).debug.variant).not.toBe('instrumental-bridge');
  });

  it('exchanges bass at a confident incoming phrase without moving the overlap or vocal handoff', () => {
    const a = song('a', 120), b = song('b', 120);
    a.analysis!.vocalActivity!.values.fill(0.02);
    b.analysis!.vocalActivity!.values.fill(0.02);
    b.analysis!.curves.lowDb.fill(-8);
    b.analysis!.curves.rmsDb.fill(-10);
    b.analysis!.bodyRmsDb = -10;
    const control = planTransition(a, b, S);
    const phrase = control.bEntry + control.swapAt - 2;
    b.analysis!.phrases.push(phrase);
    const p = planTransition(a, b, S);
    expect(p.method).toBe('beatmatch_blend');
    expect([p.aExit, p.bEntry, p.duration, p.swapAt]).toEqual([control.aExit, control.bEntry, control.duration, control.swapAt]);
    expect(p.vocalA).toEqual(control.vocalA);
    expect(p.vocalB).toEqual(control.vocalB);
    expect(p.debug.bassSwap).toMatchObject({ technique: 'phrase-bass-swap', at: control.swapAt - 2 });
    b.analysis!.phraseConfidence = 0.1;
    expect(planTransition(a, b, S).debug.bassSwap).toBeUndefined();
    expect(planTransition(a, b, { ...S, eqHandoff: false }).debug.bassSwap).toBeUndefined();
    b.analysis!.phraseConfidence = 0.8;
    b.analysis!.curves.lowDb.fill(-50, Math.floor(phrase * 20), Math.ceil((phrase + 2) * 20));
    expect(planTransition(a, b, S).debug.bassSwap).toBeUndefined();
  });

  it('maps a phrase bass handoff through the actual tempo glide', () => {
    const a = song('a', 120, { voice: false }), b = song('b', 126, { voice: false });
    b.analysis!.curves.lowDb.fill(-8); b.analysis!.curves.rmsDb.fill(-10); b.analysis!.bodyRmsDb = -10;
    const control = planTransition(a, b, S);
    const midpoint = control.bEntry + integrateTempo(control.tempoB, control.swapAt);
    const phrase = b.analysis!.beat!.downbeats.filter(t => t < midpoint - 0.5).at(-1)!;
    b.analysis!.phrases.push(phrase);
    const p = planTransition(a, b, S);
    const bass = p.debug.bassSwap as { at: number; sourceB: number };
    expect(bass).toBeDefined();
    expect(bass.at).toBeCloseTo(outputTimeAt(p.tempoB, phrase - p.bEntry, p.duration), 3);
    expect(p.bEntry + integrateTempo(p.tempoB, bass.at)).toBeCloseTo(phrase, 2);
    expect([p.aExit, p.bEntry, p.duration, p.tempoA, p.tempoB]).toEqual([control.aExit, control.bEntry, control.duration, control.tempoA, control.tempoB]);
  });

  it('cuts incompatible grooves on measured downbeats, ending A before the next beat', () => {
    const a = song('a', 90, { voice: false }), b = song('b', 120, { voice: false, phase: 0.31 });
    const p = planTransition(a, b, { ...S, style: 'tight' });
    expect(p.method).toBe('phrase_cut');
    expect(p.duration).toBeLessThanOrEqual(0.12);
    expect(b.analysis!.beat!.downbeats.some(t => Math.abs(t - p.bEntry) < 0.004)).toBe(true);
    expect(p.automation.find(l => l.deck === 'A' && l.lane === 'gain')!.points.at(-1)![1]).toBe(0);
    expect(planTransition(a, b, { ...S, style: 'tight', entryMode: 'preserve' }).method).not.toBe('phrase_cut');
  });

  it('refuses a cut through a continuing vocal phrase', () => {
    expect(planTransition(song('a', 90), song('b', 120), { ...S, style: 'tight' }).method).not.toBe('phrase_cut');
  });

  it('does not mistake quiet consonants inside measured phrases for a tempo-reset gap', () => {
    const a = song('quiet-consonants', 90), b = song('new-groove', 120, { voice: false });
    const voice = a.analysis!.vocalActivity!;
    voice.values.fill(0.02);
    // The separator's phrase detector bridges low-energy consonants. Its
    // positive evidence must survive a locally quiet frame average.
    voice.phrases = [{ start: 160, end: 180, confidence: 0.9 }];
    expect(planTransition(a, b, { ...S, style: 'tight' }).method).not.toBe('phrase_cut');
    // A genuine instrumental ending still permits the useful downbeat cut.
    voice.phrases = [{ start: 160, end: 171, confidence: 0.9 }];
    expect(planTransition(a, b, { ...S, style: 'tight' }).method).toBe('phrase_cut');
  });
});

describe('planner v7: lyric-preserving entry, grid trust, bass-swap rise', () => {
  const hinted = (bpm: number): NonNullable<TrackAnalysis['structure']> => ({ method: 'ssm-repeat-1', segments: [], groups: [], repetitionCoverage: 0,
    gridCheck: { lags: 5, beatIntegerShare: 0.2, barIntegerShare: 0, tripleShare: 0, medianBeatError: 0.33, periodHint: { bpm, share: 1 } } });

  it('counts measured singing seconds above the activity floor', () => {
    const b = song('b', 120, { intro: 24 });
    expect(sungSeconds(b.analysis!, 0, 24)).toBeCloseTo(0, 6);
    expect(sungSeconds(b.analysis!, 24, 34)).toBeCloseTo(10, 1);
    expect(sungSeconds({ ...b.analysis!, vocalActivity: undefined }, 0, 60)).toBe(0);
  });

  it('may skip an instrumental intro, but not the incoming verse that is already sung', () => {
    const a = song('a', 120), b = song('b', 120, { intro: 24 });
    const instrumental = planTransition(a, b, S);
    expect(instrumental.method).toBe('beatmatch_blend');
    expect(sungSeconds(b.analysis!, 0, instrumental.bEntry)).toBeLessThan(1);
    // same song, but the voice starts at 2 s inside the quiet intro
    b.analysis!.vocalActivity!.values.fill(0.85, 20);
    const sung = planTransition(a, b, S);
    expect(sung.method).toBe('beatmatch_blend');
    expect(sungSeconds(b.analysis!, 0, sung.bEntry)).toBeLessThan(2);
  });

  it('does not beatmatch on a grid whose repetition lags point to a 2:3 tempo', () => {
    const a = song('a', 120), b = song('b', 122);
    expect(planTransition(a, b, S).method).toBe('beatmatch_blend');
    b.analysis!.structure = hinted(81.3);
    expect(gridTrust(b.analysis!)).toMatchObject({ trusted: false, reason: 'period-hint' });
    const p = planTransition(a, b, S);
    expect(p.method).not.toBe('beatmatch_blend');
    expect(p.debug.gridTrust).toMatchObject({ A: { trusted: true }, B: { trusted: false } });
    expect(p.fallbackReason).toContain('повторы музыки');
    // a local region at the same (rejected) tempo shares the error; one at the hinted tempo does not
    b.analysis!.beatRegions = [rhythm(122, 0, 180)];
    expect(planTransition(a, b, S).method).not.toBe('beatmatch_blend');
    const a81 = song('a81', 81.3);
    b.analysis!.beatRegions = [rhythm(81.3, 0, 60)];
    expect(planTransition(a81, b, S).debug.localRhythm).toBe(true);
    // analyses without the repetition check keep their previous behaviour
    delete b.analysis!.structure;
    expect(gridTrust(b.analysis!).trusted).toBe(true);
  });

  it('keeps the default bass swap when the phrase swap would raise the peak level', () => {
    const a = song('a', 120), b = song('b', 120);
    a.analysis!.vocalActivity!.values.fill(0.02);
    b.analysis!.vocalActivity!.values.fill(0.02);
    b.analysis!.curves.lowDb.fill(-8); b.analysis!.curves.rmsDb.fill(-10); b.analysis!.bodyRmsDb = -10;
    const control = planTransition(a, b, S);
    const phrase = control.bEntry + control.swapAt - 2;
    b.analysis!.phrases.push(phrase);
    expect(planTransition(a, b, S).debug.bassSwap).toBeDefined();
    // B's bass is 10 dB hotter exactly between the phrase and the default swap
    b.analysis!.curves.lowDb.fill(2, Math.floor((phrase - 0.3) * 20), Math.ceil((control.bEntry + control.swapAt - 0.3) * 20));
    b.analysis!.curves.rmsDb.fill(0, Math.floor((phrase - 0.3) * 20), Math.ceil((control.bEntry + control.swapAt - 0.3) * 20));
    const p = planTransition(a, b, S);
    expect(p.debug.bassSwap).toBeUndefined();
    expect(p.automation.filter(l => l.lane === 'low')).toEqual(control.automation.filter(l => l.lane === 'low'));
  });

  it('ends a locked overlap where the structural unit of A closes, when that loses no ending', () => {
    const a = song('a', 120), b = song('b', 120);
    const plain = planTransition(a, b, S);
    const seg = (start: number, end: number, endClosure: number) => ({ start, end, group: -1, occurrence: -1, repeatSimilarity: 0, chorusLikelihood: 0, rmsDb: -16, relDb: 0, slopeDb: 0, novelty: 0.5, endClosure });
    a.analysis!.structure = { method: 'ssm-repeat-1', segments: [seg(0, 150, 1), seg(150, 180, 0.5)], groups: [], repetitionCoverage: 0 };
    const p = planTransition(a, b, S);
    expect(plain.aExit + plain.duration).toBeLessThan(179);
    expect(p.aExit + p.duration).toBeCloseTo(180, 3);
    expect(p.duration).toBe(plain.duration);
  });
});
