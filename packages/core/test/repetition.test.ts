import { describe, expect, it } from 'vitest';
import { analyzePcm } from '../src/mir/analyzePcm.ts';
import { analyzeStructure, closureAt, skipCost } from '../src/mir/repetition.ts';
import { ANALYSIS_RATE, computeSpectral } from '../src/mir/spectral.ts';
import type { TrackAnalysis } from '../src/types.ts';

const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM;

/** Chords as MIDI notes; each chord lasts one 4/4 bar (2 s). */
const PROG: Record<string, number[][]> = {
  intro: [[57, 60, 64], [57, 60, 64], [53, 57, 60], [53, 57, 60]],
  verse: [[57, 60, 64], [52, 55, 59], [53, 57, 60], [48, 52, 55]], // Am Em F C
  chorus: [[53, 57, 60], [55, 59, 62], [48, 52, 55], [55, 59, 62]], // F G C G
  bridge: [[50, 53, 57], [58, 62, 65], [50, 53, 57], [52, 56, 59]], // Dm Bb Dm E
};
const LEAD = [72, 74, 76, 79, 77, 76, 74, 72];

interface Part { name: keyof typeof PROG; bars: number; loud: number; drums: boolean; hats: boolean; lead: boolean }

/** A pop-like song with known structure. Returns PCM and the true section starts. */
function song(parts: Part[], seed = 1) {
  const total = parts.reduce((s, p) => s + p.bars, 0) * 4 * BEAT;
  const n = Math.round(total * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let rnd = seed;
  const noise = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
  const starts: number[] = [];
  let t0 = 0;
  for (const p of parts) {
    starts.push(t0);
    const prog = PROG[p.name];
    for (let bar = 0; bar < p.bars; bar++) {
      const chord = prog[bar % prog.length];
      const b0 = t0 + bar * 4 * BEAT;
      const i0 = Math.round(b0 * SR), i1 = Math.round((b0 + 4 * BEAT) * SR);
      for (let i = i0; i < i1 && i < n; i++) {
        const t = i / SR, tb = t - b0;
        let v = 0;
        for (const m of chord) for (const o of [-12, 0, 12]) v += Math.sin(2 * Math.PI * hz(m + o) * t) * (o === 0 ? 0.08 : 0.04);
        v += 0.12 * Math.sin(2 * Math.PI * hz(chord[0] - 24) * t);
        const beatPos = tb % BEAT, beatIdx = Math.floor(tb / BEAT);
        if (p.drums) v += 0.5 * Math.exp(-beatPos * 25) * Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-beatPos * 30)) * beatPos);
        if (p.drums && beatIdx % 2 === 1) v += 0.15 * Math.exp(-beatPos * 30) * noise();
        if (p.hats) { const h = tb % (BEAT / 2); v += 0.05 * Math.exp(-h * 80) * noise(); }
        if (p.lead) {
          const note = LEAD[(bar * 2 + Math.floor(tb / (2 * BEAT))) % LEAD.length];
          v += 0.07 * Math.sin(2 * Math.PI * hz(note) * t) + 0.03 * Math.sin(2 * Math.PI * hz(note) * 2 * t);
        }
        L[i] = v * p.loud;
        R[i] = v * p.loud;
      }
    }
    t0 += p.bars * 4 * BEAT;
  }
  return { L, R, starts };
}

const P = (name: Part['name'], bars: number, loud: number, drums = true, hats = false, lead = false): Part => ({ name, bars, loud, drums, hats, lead });
// I V C V C B C C O: 4 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 4 bars, 2 s per bar
const POP = [P('intro', 4, 0.35, false), P('verse', 8, 0.5), P('chorus', 8, 0.9, true, true, true), P('verse', 8, 0.5), P('chorus', 8, 0.9, true, true, true),
  P('bridge', 8, 0.55), P('chorus', 8, 0.9, true, true, true), P('chorus', 8, 0.9, true, true, true), P('intro', 4, 0.35, false)];

let popCache: { a: TrackAnalysis; starts: number[] } | null = null;
const pop = () => {
  if (!popCache) { const s = song(POP); popCache = { a: analyzePcm(s.L, s.R), starts: s.starts }; }
  return popCache;
};

describe('repetition structure (SSM)', () => {
  it('finds the repeated chorus and verse as separate groups and leaves the bridge unique', () => {
    const { a, starts } = pop();
    const st = a.structure!;
    expect(st).toBeTruthy();
    const segAt = (t: number) => st.segments.find((s) => t >= s.start && t < s.end)!;
    const chorus = [starts[2], starts[4], starts[6], starts[7]].map((t) => segAt(t + 8));
    const verse = [starts[1], starts[3]].map((t) => segAt(t + 8));
    expect(new Set(chorus.map((s) => s.group)).size).toBe(1);
    expect(chorus[0].group).toBeGreaterThanOrEqual(0);
    expect(verse[0].group).toBeGreaterThanOrEqual(0);
    expect(verse[1].group).toBe(verse[0].group);
    expect(verse[0].group).not.toBe(chorus[0].group);
    expect(segAt(starts[5] + 8).group).toBe(-1);
    expect(st.likelyChorus?.group).toBe(chorus[0].group);
    expect(st.likelyChorus!.confidence).toBeGreaterThan(0.5);
    expect(chorus[0].chorusLikelihood).toBeGreaterThan(verse[0].chorusLikelihood);
    expect(st.repetitionCoverage).toBeGreaterThan(0.6);
  });

  it('puts segment boundaries on the true section starts', () => {
    const { a, starts } = pop();
    const found = a.structure!.segments.map((s) => s.start);
    for (const t of starts.slice(1)) expect(Math.min(...found.map((f) => Math.abs(f - t)))).toBeLessThan(1.1);
    expect(found.length).toBeLessThanOrEqual(starts.length + 2);
  });

  it('rates closure high at a section end and low inside the chorus; skipping the chorus costs more', () => {
    const { a, starts } = pop();
    const st = a.structure!;
    expect(closureAt(st, starts[3])).toBeGreaterThan(0.5);
    expect(closureAt(st, starts[2] + 9)).toBeLessThan(0.1);
    expect(skipCost(st, starts[2], starts[3])).toBeGreaterThan(2 * skipCost(st, 0, starts[1]));
  });

  it('reports chorus segments louder than verses and a measured level trend', () => {
    const st = pop().a.structure!;
    const c = st.segments.find((s) => s.group === st.likelyChorus!.group)!;
    const v = st.segments.find((s) => s.group >= 0 && s.group !== st.likelyChorus!.group)!;
    expect(c.relDb - v.relDb).toBeGreaterThan(3);
    for (const s of st.segments) expect(Number.isFinite(s.slopeDb)).toBe(true);
  });

  it('measures repeats a whole number of bars apart on a correct grid', () => {
    const { a } = pop();
    const g = a.structure!.gridCheck!;
    expect(g.lags).toBeGreaterThanOrEqual(3);
    expect(g.beatIntegerShare).toBeGreaterThanOrEqual(0.8);
    expect(g.barIntegerShare).toBeGreaterThanOrEqual(0.8);
    expect(g.medianBeatError).toBeLessThan(0.1);
  });

  it('flags a 3:2 tempo error of the grid from the repetition lags', () => {
    const s = song(POP);
    const mono = new Float32Array(Math.floor(s.L.length / 2));
    for (let i = 0; i < mono.length; i++) mono[i] = s.L[2 * i];
    const sp = computeSpectral(mono, ANALYSIS_RATE);
    const a = pop().a;
    const base = { sp, rmsDb: a.curves.rmsDb, curveRate: a.curves.rate, start: a.audibleStart, end: a.audibleEnd, body: a.bodyRmsDb };
    const wrongPeriod = BEAT * 1.5; // tracker locked to 80 BPM on a 120 BPM song
    const beats = Array.from({ length: Math.floor(a.audibleEnd / wrongPeriod) }, (_, i) => i * wrongPeriod);
    const wrong = analyzeStructure({ ...base, beat: { ...a.beat!, bpm: 80, period: wrongPeriod, beats, downbeats: beats.filter((_, i) => i % 4 === 0) } })!.gridCheck!;
    expect(wrong.beatIntegerShare).toBeLessThan(0.5);
    expect(wrong.periodHint?.bpm).toBeCloseTo(120, 0);
    expect(a.structure!.gridCheck!.periodHint).toBeUndefined();
  });

  it('does not call anything a chorus in a song without repeats', () => {
    // every 16 s a new progression: transposed copies share no chroma pattern at lag 0
    const parts = Array.from({ length: 6 }, (_, k) => P((['intro', 'verse', 'chorus', 'bridge'] as const)[k % 4], 8, 0.5 + 0.08 * k));
    const s = song(parts, 7);
    // transpose each part by a different interval so that no section repeats
    for (let k = 0; k < parts.length; k++) {
      const a = Math.round(s.starts[k] * SR), b = Math.round((s.starts[k] + 16) * SR);
      const shift = [0, 0, 0, 0, 5, 7][k];
      if (!shift) continue;
      const src = s.L.slice(a, b);
      const ratio = 2 ** (shift / 12);
      for (let i = a; i < b; i++) { const j = (i - a) * ratio; const v = src[Math.floor(j) % src.length]; s.L[i] = s.R[i] = v; }
    }
    const st = analyzePcm(s.L, s.R).structure!;
    expect(st.likelyChorus).toBeUndefined();
  });

  it('does not call a single looped section a chorus', () => {
    const s = song([P('chorus', 40, 0.8, true, true, true)], 3);
    const st = analyzePcm(s.L, s.R).structure!;
    expect(st.likelyChorus).toBeUndefined();
  });
});
