import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planTransition, planRequestedTransition, planSkip, planFinalists } from '../packages/core/src/plan/planner.ts';
import { ANALYZER_VERSION, DEFAULT_AUTOMIX_SETTINGS, type PlannerTrack, type AutoMixSettings, type TrackAnalysis } from '../packages/core/src/types.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'data-bench-results/rust-planner');
fs.mkdirSync(out, { recursive: true });
const executable = process.argv.find(v => v.startsWith('--exe='))?.slice(6) ?? path.join(root, 'packages/audio-rust/target/release/mora-audio.exe');
const simpleOnly = process.argv.includes('--simple');
const dbPath = process.argv.find(v => v.startsWith('--db='))?.slice(5);
type Case = { name: string; from: PlannerTrack; to: PlannerTrack; settings: AutoMixSettings; mode?: string; position?: number; simple?: boolean; feedback?: any };
const track = (id: string, extra: Partial<PlannerTrack> = {}): PlannerTrack => ({ id, duration: 180, mixingAllowed: true, analysis: null, ...extra });
const settings = (extra: Partial<AutoMixSettings> = {}): AutoMixSettings => ({ ...DEFAULT_AUTOMIX_SETTINGS, ...extra });
const cases: Case[] = [];
const add = (name: string, a: Partial<PlannerTrack> = {}, b: Partial<PlannerTrack> = {}, extra: Partial<AutoMixSettings> = {}, mode = 'normal', position?: number) => cases.push({ name, from: track('a', a), to: track('b', b), settings: settings(extra), mode, position, simple: true });
add('missing-both');
add('disabled', {}, {}, { enabled: false });
add('no-overlap', {}, {}, { maxBlendSeconds: 0 });
add('restricted-a', { mixingAllowed: false });
add('restricted-b', {}, { mixingAllowed: false });
add('same-album', { album: 'Album', albumArtist: 'Artist', trackNo: 1 }, { album: 'Album', albumArtist: 'Artist', trackNo: 2 });
add('same-album-next-disc', { album: 'Album', trackNo: 12, discNo: 1 }, { album: 'Album', trackNo: 1, discNo: 2 });
add('short-clip', { duration: .05 });
add('unicode-id', { id: 'Диск 🎵' }, { id: 'Трек 🦀' });
add('normal-finalists', {}, {}, {}, 'finalists');
for (const position of [-1, 0, 17.123, 179.999, 999]) add(`skip-${position}`, {}, {}, {}, 'skip', position);
add('skip-restricted', { mixingAllowed: false }, {}, {}, 'skip', 20);
add('skip-disabled', {}, {}, { enabled: false }, 'skip', 20);
add('request-missing', {}, {}, {}, 'requested', 20);
add('request-disabled', {}, {}, { enabled: false }, 'requested', 20);
add('request-no-overlap', {}, {}, { maxBlendSeconds: 0 }, 'requested', 20);
add('request-near-end', {}, {}, {}, 'requested', 179.99);

function measured(bpm: number, duration = 160): TrackAnalysis {
  const period = 60 / bpm;
  const beats = Array.from({ length: Math.ceil(duration / period) }, (_, i) => i * period).filter(t => t < duration);
  const curve = Array.from({ length: duration * 20 }, () => -16);
  return { version: 'measured-test', duration, audibleStart: 0, audibleEnd: duration,
    loudness: { integratedLufs: -16, samplePeakDb: -4, truePeakDb: -3 }, bodyRmsDb: -16,
    beat: { bpm, confidence: .95, period, stable: true, jitterMs: 0, beats, downbeats: beats.filter((_, i) => i % 4 === 0), downbeatConfidence: .9, downbeatPhase: 0, alternatives: [] },
    key: { tonic: 0, mode: 'major', name: 'C major', camelot: '8B', confidence: .9 },
    phrases: beats.filter((_, i) => i % 32 === 0), phraseConfidence: .9, sectionBoundaries: [32, 64], sections: [],
    intro: { start: 0, end: 8, confidence: .8, kind: 'intro' }, outro: { start: duration - 16, end: duration, confidence: .8, kind: 'outro' },
    curves: { rate: 20, rmsDb: curve, lowDb: curve.map(v => v - 3), midDb: curve.map(v => v - 6), highDb: curve.map(v => v - 10), midDensity: curve.map(() => .3), waveform: curve.map(() => .1) },
    cues: { entry: [{ time: 0, score: 1, kind: 'start', tags: [] }], exit: [{ time: duration - 16 * period * 4, score: .8, kind: 'phrase', tags: [] }] },
    energy: .5, rhythmStrength: .9, spectralCentroid: 2000, warnings: [],
  } as unknown as TrackAnalysis;
}
for (const [name, aa, bb, extra] of [
  ['locked', measured(120), measured(124), {}],
  ['unlocked', measured(120), measured(88), {}],
  ['tight', measured(120), measured(88), { style: 'tight' }],
] as const) cases.push({ name, from: track('a', { duration: aa.duration, analysis: aa }), to: track('b', { duration: bb.duration, analysis: bb }), settings: settings(extra) });
// v19.2 styles: a calm, slower B with a soft intro (loop wash) and musical Next requests (drop swap / loop roll)
for (const mode of ['normal', 'finalists', 'requested']) {
  const aa: any = measured(129), bb: any = measured(90);
  for (const key of ['rmsDb', 'lowDb', 'midDb', 'highDb']) for (let i = 0; i < 60 * 20; i++) bb.curves[key][i] -= 5;
  cases.push({ name: `calm-wash-${mode}`, from: track('a', { duration: aa.duration, analysis: aa }), to: track('b', { duration: bb.duration, analysis: bb }),
    settings: settings({ mixOnNext: true }), mode, position: mode === 'requested' ? 120.4 : undefined });
}

function addMeasured(name: string, aa: TrackAnalysis, bb: TrackAnalysis, extra: Partial<AutoMixSettings> = {}, mode = 'normal', position?: number, feedback?: any): void {
  cases.push({ name, from: track('a', { duration: aa.duration, analysis: aa }), to: track('b', { duration: bb.duration, analysis: bb }), settings: settings(extra), mode, position, feedback });
}
// Soft echo keeps B's opening, including leading silence handling; Next keeps an energetic entry.
for (const audibleStart of [0, 0.05, 2.3]) for (const mode of ['normal', 'finalists', 'requested']) {
  const aa = measured(120), bb = measured(88);
  aa.curves.midDensity = aa.curves.midDensity.map((_, i) => aa.phrases.some(t => Math.abs(i / aa.curves.rate - t) < 2 * aa.beat!.period) ? 0.05 : 0.2);
  bb.audibleStart = audibleStart;
  bb.cues.entry.push({ time: 16, score: 0.95, kind: 'section', tags: [] });
  addMeasured(`soft-echo-${audibleStart}-${mode}`, aa, bb, { mixOnNext: true }, mode, mode === 'requested' ? 120.4 : undefined);
}
function voice(an: TrackAnalysis, phase = 0): TrackAnalysis {
  an.vocalActivity = { rate: 2, source: 'demucs', model: 'parity', values: Array.from({ length: Math.ceil(an.duration * 2) }, (_, i) => (i + phase) % 32 > 16 ? .8 : 0) };
  return an;
}
for (const bpm of [60, 90, 120, 150]) for (const style of ['smooth', 'auto', 'tight'] as const) for (const eqHandoff of [false, true]) for (const stems of [false, true]) {
  const aa = measured(bpm), bb = measured(bpm * 1.03333);
  if (stems) { voice(aa); voice(bb, 12); }
  addMeasured(`matrix-${bpm}-${style}-${eqHandoff}-${stems}`, aa, bb, { style, eqHandoff });
}
for (const bpm of [60, 90, 120, 150]) for (const position of [0, 20.123, 120, 159.5]) addMeasured(`request-${bpm}-${position}`, measured(120), measured(bpm), {}, 'requested', position);
for (const mode of ['normal', 'finalists']) {
  for (const variant of ['fade', 'no-grid', 'rejected-grid', 'loose-grid', 'half-time', 'dense', 'keys', 'preserve', 'one-voice', 'truncated-voice', 'strong-closure', 'drums']) {
    const aa: any = measured(120), bb: any = measured(variant === 'half-time' ? 60 : 124);
    const extra: Partial<AutoMixSettings> = {};
    if (variant === 'fade') for (let i = 140 * 20; i < aa.curves.rmsDb.length; i++) aa.curves.rmsDb[i] -= (i / 20 - 140) * 2;
    if (variant === 'no-grid') { aa.beat = null; bb.beat = null; }
    if (variant === 'rejected-grid') aa.structure = { segments: [], gridCheck: { periodHint: { bpm: 90 } } };
    if (variant === 'loose-grid') { aa.beat.confidence = .5; aa.beat.jitterMs = 24; }
    if (variant === 'dense') { aa.curves.midDensity.fill(.8); bb.curves.midDensity.fill(.9); }
    if (variant === 'keys') { bb.key.camelot = '2A'; bb.key.confidence = .95; }
    if (variant === 'preserve') extra.entryMode = 'preserve';
    if (variant === 'one-voice' || variant === 'truncated-voice') voice(bb);
    if (variant === 'truncated-voice') bb.vocalActivity.values.length = 20;
    if (variant === 'strong-closure') { aa.structure = { segments: [{ start: 0, end: 159, endClosure: .9, chorusLikelihood: .2 }], gridCheck: {} }; aa.beat.confidence = .5; }
    if (variant === 'drums') for (const [an, phase] of [[aa, 0], [bb, 1]] as const) {
      an.beat.accents = { kick: an.beat.beats.map((_: number, i: number) => (i + phase) % 4 === 0 ? 1 : .05), snare: an.beat.beats.map((_: number, i: number) => (i + phase) % 4 === 2 ? 1 : .05) };
    }
    addMeasured(`${variant}-${mode}`, aa, bb, extra, mode);
  }
}
const feedback = { version: 'test', features: { 'method:beatmatch_blend': { good: 1, bad: 5 }, 'length:long': { good: 8, bad: 1 } }, reasons: { 'резко': { 'method:crossfade': { good: 1, bad: 4 } } } };
addMeasured('ratings', measured(120), measured(124), {}, 'normal', undefined, feedback);
addMeasured('ratings-finalists', measured(120), measured(124), {}, 'finalists', undefined, feedback);
for (const bpm of [120.25, 120.5, 120.75, 87.25]) addMeasured(`decimal-tie-${bpm}`, measured(bpm), measured(124.25));
for (const mode of ['normal', 'finalists', 'requested']) for (const both of [false, true]) {
  const aa: any = voice(measured(120)), bb: any = voice(measured(124), 12);
  aa.beatRegions = [{ ...structuredClone(aa.beat), start: 80, end: 160 }]; aa.beat.stable = false;
  if (both) { bb.beatRegions = [{ ...structuredClone(bb.beat), start: 0, end: 80 }]; bb.beat.stable = false; }
  addMeasured(`local-${mode}-${both}`, aa, bb, {}, mode, mode === 'requested' ? 120 : undefined);
}
for (const maxBlendSeconds of [.03, .19, .4, 1, 5, 9, 17, 60]) {
  addMeasured(`cap-${maxBlendSeconds}`, voice(measured(150)), voice(measured(150), 20), { maxBlendSeconds });
}
for (const mode of ['normal', 'finalists', 'requested']) for (const verified of [false, true]) {
  const aa: any = voice(measured(120)), bb: any = voice(measured(124), 12);
  for (const an of [aa, bb]) {
    const words = Array.from({ length: 100 }, (_, i) => [i * 1.5, i * 1.5 + .6]);
    an.vocalActivity.lyrics = { version: 'test', language: null, confidence: .95, words, lines: words.filter((_, i) => i % 4 === 0).map(([start]) => [start, start + 5.1]), ...(verified ? { timing: 'stem-verified-1', voiced: words } : {}) };
    an.vocalActivity.vocalRmsDb = an.vocalActivity.values.map((v: number) => v > .5 ? -24 : -90);
    an.vocalActivity.accompanimentRmsDb = an.vocalActivity.values.map(() => -18);
  }
  addMeasured(`lyrics-${mode}-${verified}`, aa, bb, {}, mode, mode === 'requested' ? 120 : undefined);
}
let randomState = 846391;
const random = () => ((randomState = Math.imul(randomState, 1664525) + 1013904223 >>> 0) / 2 ** 32);
for (let i = 0; i < 32; i++) {
  const aa: any = measured(70 + random() * 100), bb: any = measured(70 + random() * 100);
  for (const an of [aa, bb]) {
    const rate = an.curves.rate;
    const fade = random() > .6;
    for (let k = 0; k < an.curves.rmsDb.length; k++) {
      const wave = 2 * Math.sin(k / rate * .8) + 3 * Math.sin(k / rate * .05) - (fade ? Math.max(0, k / rate - 145) * 2 : 0);
      for (const key of ['rmsDb', 'lowDb', 'midDb', 'highDb']) an.curves[key][k] += wave;
      an.curves.midDensity[k] = .1 + .7 * (Math.sin(k / rate * .1) + 1) / 2;
    }
    if (random() > .45) voice(an, Math.floor(random() * 32));
    if (random() > .7) an.beat.stable = false;
  }
  addMeasured(`varied-${i}`, aa, bb, { style: ['auto', 'smooth', 'tight'][i % 3] as AutoMixSettings['style'], maxBlendSeconds: 8 + random() * 24 }, i % 3 === 0 ? 'finalists' : 'normal');
}
// Liked pairs (packages/core/test/fixtures/liked-transitions.json): the desktop core must plan them exactly like the TS core.
{
  const liked = JSON.parse(fs.readFileSync(path.join(root, 'packages/core/test/fixtures/liked-transitions.json'), 'utf8'));
  for (const c of liked.cases) for (const desktop of [true, false]) for (const fb of [null, liked.feedback]) for (const mode of ['normal', 'finalists']) {
    const side = (x: { id: string; duration: number; mixingAllowed: boolean; analysis: string }): PlannerTrack =>
      ({ ...x, analysis: desktop ? { ...liked.analyses[x.analysis], vocalActivity: undefined } : liked.analyses[x.analysis] });
    cases.push({ name: `liked-${c.id}-${desktop ? 'desktop' : 'full'}-${fb ? 'ratings' : 'plain'}-${mode}`, from: side(c.from), to: side(c.to), settings: liked.settings, mode, feedback: fb });
    // the exact plan the desktop app played, with the ratings it had then
    if (desktop && !fb && mode === 'finalists' && c.playedFeedback) cases.push({ name: `liked-${c.id}-desktop-played`, from: side(c.from), to: side(c.to), settings: liked.settings, mode, feedback: c.playedFeedback });
  }
}
if (dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  try {
    const rows = db.prepare(`SELECT t.content_hash,t.duration FROM tracks t WHERE EXISTS
      (SELECT 1 FROM analysis a WHERE a.content_hash=t.content_hash AND a.status='done' AND a.data IS NOT NULL)
      ORDER BY t.content_hash LIMIT 12`).all() as { content_hash: string; duration: number }[];
    assert.ok(rows.length >= 2, 'Real-data replay needs at least two analyzed tracks');
    const read = db.prepare(`SELECT data FROM analysis WHERE content_hash=? AND status='done' AND data IS NOT NULL
      ORDER BY version=? DESC,updated_at DESC LIMIT 1`);
    const analyses = rows.map(row => JSON.parse((read.get(row.content_hash, ANALYZER_VERSION) as { data: string }).data) as TrackAnalysis);
    for (let i = 0; i < analyses.length; i++) for (const mode of ['normal', 'finalists', 'requested']) {
      const aa = analyses[i], bb = analyses[(i + 1) % analyses.length];
      addMeasured(`real-${i}-${mode}`, aa, bb, {}, mode, mode === 'requested' ? aa.duration * .75 : undefined);
    }
  } finally { db.close(); }
}

function compare(actual: any, expected: any, where = 'plan'): void {
  if (typeof expected === 'number') {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-9, `${where}: ${actual} != ${expected}`);
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', where);
    const keys = Object.keys(expected).filter(k => expected[k] !== undefined).sort();
    assert.deepEqual(Object.keys(actual).sort(), keys, `${where} keys`);
    for (const key of keys) compare(actual[key], expected[key], `${where}.${key}`);
  } else assert.equal(actual, expected, where);
}
const report = [];
const only = process.argv.find(v => v.startsWith('--only='))?.slice(7);
for (const c of cases.filter(c => (!simpleOnly || c.simple) && (!only || c.name.includes(only)))) {
  const mode = c.mode ?? 'normal';
  const begin = performance.now();
  const expected = mode === 'skip' ? planSkip(c.from, c.to, c.position!, c.settings)
    : mode === 'requested' ? planRequestedTransition(c.from, c.to, c.position!, c.settings)
    : mode === 'finalists' ? planFinalists(c.from, c.to, c.settings, c.feedback) : planTransition(c.from, c.to, c.settings, undefined, c.feedback);
  const typescriptMs = performance.now() - begin;
  const input = path.join(out, `${c.name}-input.json`), output = path.join(out, `${c.name}-rust.json`);
  fs.writeFileSync(input, JSON.stringify(c));
  const nativeBegin = performance.now();
  const child = spawnSync(executable, ['--compute'], { input: JSON.stringify({ ...c, operation: 'plan' }), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const rustWallMs = performance.now() - nativeBegin;
  assert.equal(child.status, 0, `${c.name}: ${child.error ?? child.stderr + child.stdout}`);
  const actual = JSON.parse(child.stdout);
  fs.writeFileSync(output, child.stdout);
  fs.writeFileSync(path.join(out, `${c.name}-typescript.json`), JSON.stringify(expected));
  try { compare(actual, JSON.parse(JSON.stringify(expected))); }
  catch (error) {
    if (!process.argv.includes('--keep-going')) throw error;
    report.push({ name: c.name, parity: false, error: String(error), typescriptMs, rustWallMs });
    console.error(`${c.name}: ${String(error)}`);
    continue;
  }
  report.push({ name: c.name, parity: true, typescriptMs, rustWallMs });
  console.log(`${c.name}: parity OK`);
}
fs.writeFileSync(path.join(out, dbPath ? 'real-report.json' : simpleOnly ? 'simple-report.json' : 'report.json'), JSON.stringify({ date: new Date().toISOString(), tolerance: 1e-9, simpleOnly, cases: report }, null, 2));
assert.ok(report.every(c => c.parity), `${report.filter(c => !c.parity).length} parity failures`);
