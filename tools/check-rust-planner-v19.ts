import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { planTransition, planFinalists } from '../packages/core/src/plan/planner.ts';
import { DEFAULT_AUTOMIX_SETTINGS, type PlannerTrack, type TrackAnalysis } from '../packages/core/src/types.ts';

const binary = path.resolve('packages/audio-rust/target/release/mora-audio.exe');
const fixture = JSON.parse(fs.readFileSync('packages/core/test/fixtures/liked-transitions.json', 'utf8'));
const cases: { name: string; from: PlannerTrack; to: PlannerTrack; settings: typeof DEFAULT_AUTOMIX_SETTINGS; feedback?: any }[] = [];
for (const row of fixture.cases) for (const variant of Object.keys(row.plans)) {
  const track = (side: any): PlannerTrack => ({ id: side.id, duration: side.duration, mixingAllowed: side.mixingAllowed,
    analysis: { ...fixture.analyses[side.analysis], ...(variant.startsWith('desktop') ? { vocalActivity: undefined } : {}) } });
  cases.push({ name: `${row.id}-${variant}`, from: track(row.from), to: track(row.to), settings: fixture.settings,
    feedback: variant.endsWith('ratings') ? fixture.feedback : null });
}
function steady(id: string, bpm: number): PlannerTrack {
  const analysis: TrackAnalysis = structuredClone(Object.values(fixture.analyses)[0]) as TrackAnalysis;
  const duration = 180, period = 60 / bpm, rate = 20;
  analysis.duration = duration; analysis.audibleStart = 0; analysis.audibleEnd = duration;
  const beats = Array.from({ length: Math.floor(duration / period) }, (_, i) => i * period);
  const downbeats = beats.filter((_, i) => i % 4 === 0);
  analysis.beat = { bpm, period, confidence: .95, stable: true, jitterMs: 2, beats, downbeats,
    downbeatConfidence: .9, downbeatPhase: 0, alternatives: [] };
  analysis.beatRegions = []; analysis.rhythmStrength = .95;
  analysis.phrases = downbeats.filter((_, i) => i % 8 === 0); analysis.phraseConfidence = .9;
  analysis.vocalActivity = undefined; analysis.bodyRmsDb = -16;
  analysis.intro = { start: 0, end: 0 }; analysis.outro = { start: 180, end: 180 };
  analysis.sectionBoundaries = [];
  analysis.curves = { rate, rmsDb: Array(3600).fill(-16), lowDb: Array(3600).fill(-16), midDb: Array(3600).fill(-20),
    highDb: Array(3600).fill(-24), midDensity: Array(3600).fill(.3) };
  analysis.cues = { entry: [{ time: 0, score: .8, kind: 'start', tags: [] }], exit: downbeats.filter(t => t > 140).map(time => ({ time, score: .8, kind: 'phrase', tags: [] })) };
  return { id, duration, mixingAllowed: true, analysis };
}
for (const bpm of [124, 170]) cases.push({ name: bpm === 124 ? 'full-energy-filter-handoff' : 'incompatible-drop-swap',
  from: steady('steady-a', 120), to: steady('steady-b', bpm), settings: { ...DEFAULT_AUTOMIX_SETTINGS, maxBlendSeconds: 60 } });

function compare(a: any, b: any, at = 'result'): void {
  if (typeof a === 'number' && typeof b === 'number') { assert.ok(Math.abs(a - b) <= 1e-9, `${at}: ${a} != ${b}`); return; }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), at);
    for (const key of Object.keys(a)) compare(a[key], b[key], `${at}.${key}`);
  } else assert.deepEqual(a, b, at);
}
let checks = 0;
for (const c of cases) for (const mode of ['normal', 'finalists']) {
  const expected = mode === 'normal' ? planTransition(c.from, c.to, c.settings, undefined, c.feedback) : planFinalists(c.from, c.to, c.settings, c.feedback);
  const run = spawnSync(binary, ['--compute'], { input: JSON.stringify({ ...c, operation: 'plan', mode }), encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  compare(JSON.parse(run.stdout), JSON.parse(JSON.stringify(expected)), `${c.name}/${mode}`);
  checks++;
}
fs.mkdirSync('data-bench-results/desktop-0.3.25', { recursive: true });
const report = { date: new Date().toISOString(), cases: cases.length, checks, tolerance: 1e-9,
  includes: ['listener-approved plans', 'full-energy-filter-handoff', 'incompatible-drop-swap'] };
fs.writeFileSync('data-bench-results/desktop-0.3.25/planner-parity.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
