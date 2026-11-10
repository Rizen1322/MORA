import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planCreativeTransition } from '../packages/core/src/plan/creative.ts';
import { creativeCases } from '../packages/core/test/creative-fixtures.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const exe = process.argv.find(v => v.startsWith('--exe='))?.slice(6) ?? path.join(root, 'packages/audio-rust/target/debug/mora-audio.exe');
type CreativeCase = ReturnType<typeof creativeCases>[number] & { handoffA?: number };
function compare(actual: any, expected: any, at = '$'): void {
  if (typeof actual === 'number' && typeof expected === 'number') {
    assert.ok(Math.abs(actual - expected) <= 1e-9, `${at}: ${actual} != ${expected}`); return;
  }
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') { assert.equal(actual, expected, at); return; }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), at);
  for (const key of Object.keys(expected)) compare(actual[key], expected[key], `${at}.${key}`);
}
const variants = [
  ['baseline', (_: CreativeCase) => {}],
  ['preferred-handoff', c => { c.handoffA = 112; }],
  ['fractional-handoff', c => { c.handoffA = 111.7; }],
  ['early-handoff', c => { c.handoffA = -100; }],
  ['late-handoff', c => { c.handoffA = 1000; }],
  ['nonfinite-handoff', c => { c.handoffA = NaN; }],
  ['short-limit', c => { c.settings.maxBlendSeconds = 1; }],
  ['no-eq', c => { c.settings.eqHandoff = false; }],
  ['no-grid', c => { c.from.analysis!.beat = null; }],
  ['no-onset', c => { delete c.to.analysis!.local; delete c.from.analysis!.local; }],
  ['dense', c => { c.from.analysis!.curves.midDensity.fill(.75); c.to.analysis!.curves.midDensity.fill(.8); }],
  ['voice', c => { for (const t of [c.from, c.to]) t.analysis!.vocalActivity = { rate: 1, source: 'demucs', model: 'fixture', values: Array(128).fill(.8) }; }],
  ['pickup', c => { c.to.analysis!.audibleStart = .075; }],
  ['native-drift', c => { const g = c.to.analysis!.beat!; g.bpm *= 1.005; g.period /= 1.005; g.beats = g.beats.map(t => t / 1.005); g.downbeats = g.downbeats.map(t => t / 1.005); }],
  ['pickup-drift', c => { c.to.analysis!.audibleStart = .5; const g = c.to.analysis!.beat!; g.bpm *= 1.014; g.period /= 1.014; g.beats = g.beats.map(t => t / 1.014); g.downbeats = g.downbeats.map(t => t / 1.014); }],
  ['bassless-a', c => { c.from.analysis!.curves.lowDb.fill(-60); }],
  ['bassless-b', c => { c.to.analysis!.curves.lowDb.fill(-60); }],
  ['quiet-intro', c => { const B = c.to.analysis!; for (let i = 0; i < 12 * B.curves.rate; i++) for (const k of ['rmsDb', 'lowDb', 'highDb'] as const) B.curves[k][i] -= 20; }],
  ['restricted', c => { c.from.mixingAllowed = false; }],
  ['normalization', c => { c.settings.loudnessTarget = -14; c.from.analysis!.loudness.truePeakDb = 1; }],
  ['unicode', c => { c.from.id = 'Диск 🎵'; c.to.id = 'Следующий 🦀'; }],
] satisfies [string, (c: CreativeCase) => void][];
let count = 0, applicable = 0;
for (const [variant, mutate] of variants) for (const original of creativeCases()) {
  const c: CreativeCase = structuredClone(original); mutate(c);
  const expected = planCreativeTransition(c.from, c.to, c.settings, c.style, c.handoffA);
  const input = JSON.stringify({ ...c, operation: 'plan' });
  const child = spawnSync(exe, ['--compute'], { input, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(child.status, 0, `${variant}/${c.style}: ${child.error ?? child.stderr}`);
  try { compare(JSON.parse(child.stdout), JSON.parse(JSON.stringify(expected))); }
  catch (error) { throw new Error(`${variant}/${c.style}: ${String(error)}`); }
  count++; if (expected) applicable++;
}
console.log(`Creative TS/Rust parity: ${count} cases, ${applicable} applicable, tolerance 1e-9.`);
