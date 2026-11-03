import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { compilePhraseMix, createPhraseMixRecipe } from '../packages/core/src/plan/phrase-mix.ts';
import type { TransitionPlan, TrackAnalysis, PhraseMixRecipe } from '../packages/core/src/types.ts';

const exe = process.env.MORA_AUDIO_EXE ?? 'packages/audio-rust/target/release/mora-audio.exe';
const base: TransitionPlan = { id: 'pair_🎧', version: 'test', fromTrackId: 'a', toTrackId: 'b', method: 'crossfade', confidence: .5, reasons: [], aExit: 10, bEntry: 1, duration: 8, gap: 0, swapAt: 4, tempoB: [[0, 1]], gainA: 0, gainB: 0, automation: [], debug: {} };
const analysis = { duration: 180, beat: { stable: true, confidence: .9, downbeatConfidence: .9, period: .5, bpm: 120, beats: Array.from({ length: 360 }, (_, i) => i / 2), downbeats: Array.from({ length: 90 }, (_, i) => i * 2) } } as TrackAnalysis;
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value));
let cases = 0;
function check(mode: 'create' | 'compile', b = base, recipe: unknown = null, a: TrackAnalysis | null = analysis, next: TrackAnalysis | null = analysis) {
  const input = clean({ operation: 'phrase', mode, base: b, recipe, a, b: next });
  let expected: unknown, error: string | undefined;
  try { expected = clean(mode === 'create' ? createPhraseMixRecipe(input.base, input.a, input.b) : compilePhraseMix(input.base, input.recipe as PhraseMixRecipe, input.a, input.b)); }
  catch (e) { error = (e as Error).message; }
  const proc = spawnSync(exe, ['--compute'], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true });
  assert.ifError(proc.error);
  const actual = JSON.parse(proc.stdout);
  if (error) { assert.equal(proc.status, 1); assert.equal(actual.error, error); }
  else {
    assert.equal(proc.status, 0, proc.stdout + proc.stderr);
    function compare(x: any, y: any, path = '') {
      if (typeof y === 'number') assert.ok(typeof x === 'number' && Math.abs(x - y) < 1e-8, `${path}: ${x} != ${y}`);
      else if (y && typeof y === 'object') {
        assert.deepEqual(Object.keys(x).sort(), Object.keys(y).sort(), path);
        for (const key of Object.keys(y)) compare(x[key], y[key], `${path}.${key}`);
      } else assert.equal(x, y, path);
    }
    compare(actual, expected);
  }
  cases++;
}
const draft = createPhraseMixRecipe(base);
for (const b of [base, { ...base, duration: 0, aExit: 180 }, { ...base, aExit: 179.9, tempoA: [[0, 1], [8, 2]] as [number, number][] }]) {
  check('create', b); check('create', b, null, null, null);
}
for (const preset of ['bass_swap', 'drop_in', 'tail_to_start'] as const) {
  for (const bDelay of [0, 1.5, 3]) check('compile', base, { ...draft, preset, bDelay });
  check('compile', base, { ...draft, preset, curves: [{ deck: 'B', lane: 'gain', points: [[0, 0], [.5, .8], [1, 1]] }] });
}
for (const bars of [4, 8, 16]) check('compile', base, { ...draft, timing: { unit: 'bars', bars } });
check('compile', base, { ...draft, timing: { unit: 'bars', bars: 4 }, tempo: { a: [[0, 1], [8, 2]], b: [[0, .9], [8, 1]] } });
check('compile', base, { ...draft, timing: { unit: 'bars', bars: 4, resolvedDuration: 8 } }, { ...analysis, beat: { ...analysis.beat!, stable: false } });
for (const bad of [null, {}, { ...draft, tempo: null }, { ...draft, curves: [null] }, { ...draft, curves: [{ deck: 'B', lane: 'gain', points: [null, [1, 1]] }] }, ...[{ bDelay: 8 }, { handoff: -1 }, { aExit: null }, { bEntry: 179 }, { aExit: 179 }, { timing: { unit: 'bars', bars: 3 } }, { curves: [{ deck: 'B', lane: 'low', points: [[0, 0], [1, .5]] }] }].map(p => ({ ...draft, ...p }))]) check('compile', base, bad);
check('compile', { ...base, debug: { processingAllowed: false } }, draft);
fs.mkdirSync('data-bench-results/rust-phrase', { recursive: true });
fs.writeFileSync('data-bench-results/rust-phrase/summary.json', JSON.stringify({ date: new Date().toISOString(), cases, differences: 0, tolerance: 1e-8 }, null, 2));
console.log(`Phrase compiler parity: ${cases} cases passed`);
