/** Read-only, cache-only comparison of saved/current plans. No analysis or inference.
 * npx tsx tools/review-planning-techniques.ts [--render] [--tag NAME]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import { EventHub } from '../apps/server/src/events.ts';
import type { Library } from '../apps/server/src/library.ts';
import { PLANNER_VERSION, planTransition, renderTransitionOffline, type PlannerTrack, type StereoPcm, type TransitionPlan } from '../packages/core/src/index.ts';
import { decode, shortTermLoudness } from './eval-transitions.ts';

const cfg = loadConfig(), dir = path.join(cfg.dataDir, 'reports');
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const base = read('user-library-planning-baseline-v10.json');
const inherited = read('user-library-planning-bridge-review.json');
const option = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const bassReview = process.argv.includes('--bass');
const tightReview = process.argv.includes('--tight');
const settings = { ...base.settings, ...(tightReview ? { style: 'tight' } : {}) };
const controlName = option('--control', '');
const control = controlName ? read(controlName) : null;
const db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
const sources = db.prepare('SELECT t.id,t.provider,t.content_hash,(SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t').all() as { id: string; provider: string; content_hash: string; file: string }[];
const currentVersions = db.prepare('SELECT version,status,count(*) AS count FROM analysis GROUP BY version,status').all();
db.close();
const stems = new StemService({ ...cfg, stemsPython: null }, {} as Library, new EventHub());
const byId = new Map<string, PlannerTrack>(base.tracks.map((t: any) => [t.id, { id: t.id, duration: t.analysis.duration, analysis: t.analysis, mixingAllowed: true }]));
const pcm = (id: string): StereoPcm => {
  const t = sources.find(t => t.id === id)!;
  const file = t.provider === 'yandex' ? path.join(cfg.dataDir, 'remote/yandex', `${t.content_hash}.mp3`) : t.file;
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== t.content_hash) throw Error(`Changed original ${id}`);
  const audio = decode(file), meta = stems.get(t.content_hash);
  if (!meta || meta.frames !== audio.L.length) throw Error(`Missing aligned cached stem ${id}`);
  const L = new Float32Array(meta.frames), R = new Float32Array(meta.frames);
  for (let frame = 0; frame < meta.frames; frame += 65536) {
    const count = Math.min(65536, meta.frames - frame), bytes = stems.readNative(t.content_hash, frame, count);
    if (bytes.length !== count * 8) throw Error(`Incomplete cached stem ${id}`);
    for (let i = 0; i < count; i++) { L[frame + i] = bytes.readFloatLE(i * 8); R[frame + i] = bytes.readFloatLE(i * 8 + 4); }
  }
  return { ...audio, sampleRate: 44100, vocals: { L, R } };
};
function metrics(a: StereoPcm, b: StereoPcm, plan: TransitionPlan, audioPath?: string) {
  const r = renderTransitionOffline(a, b, plan, 8, 12), levels = shortTermLoudness(r.L, r.R);
  if (audioPath) {
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    const wav = Buffer.alloc(44 + r.L.length * 8);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(44100 * 8, 28);
    wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(r.L.length * 8, 40);
    for (let i = 0; i < r.L.length; i++) { wav.writeFloatLE(r.L[i], 44 + i * 8); wav.writeFloatLE(r.R[i], 48 + i * 8); }
    fs.writeFileSync(audioPath, wav);
  }
  const t0 = Math.max(1, Math.round(r.transitionStartFrame / 4410) - 30);
  const t1 = Math.min(levels.length - 1, t0 + Math.round((plan.duration + plan.gap) * 10) + 30);
  const median = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)] ?? -90;
  const before = median(levels.slice(Math.max(0, t0 - 40), Math.max(1, t0 - 5))), after = median(levels.slice(t1)), during = levels.slice(t0, t1);
  return { ...r.metrics, dipLU: Math.min(0, ...during.map(v => v - Math.min(before, after))), bumpLU: Math.max(0, ...during.map(v => v - Math.max(before, after))),
    beforeLUFS: before, afterLUFS: after, completed: r.events.some(e => e.type === 'transitionEnd'), finite: r.L.every(Number.isFinite) && r.R.every(Number.isFinite) };
}
const matrix = base.rows.map((row: any) => ({ fromId: row.fromId, toId: row.toId, before: row.plan,
  after: planTransition(byId.get(row.fromId)!, byId.get(row.toId)!, settings) }));
const rows = [];
const selection = tightReview ? base.rows.filter((row: any) => matrix.find((r: any) => r.fromId === row.fromId && r.toId === row.toId)!.after.method === 'phrase_cut'
  && sources.find(s => s.id === row.fromId)?.provider !== sources.find(s => s.id === row.toId)?.provider).slice(0, Number(option('--pairs', '2')))
  : bassReview ? base.rows.filter((row: any) => matrix.find((r: any) => r.fromId === row.fromId && r.toId === row.toId)!.after.debug.bassSwap)
  : inherited.rows.filter((r: any) => r.render);
for (const row of selection) {
  const original = base.rows.find((r: any) => r.fromId === row.fromId && r.toId === row.toId);
  const current = matrix.find((r: any) => r.fromId === row.fromId && r.toId === row.toId)!.after;
  const savedBaseline = control?.matrix.find((r: any) => r.fromId === row.fromId && r.toId === row.toId)?.after ?? original.plan;
  if (bassReview && !['aExit', 'bEntry', 'duration', 'swapAt'].every(k => savedBaseline[k] === current[k])) throw Error('Control geometry differs');
  // Isolate bass automation from concurrent vocal-boundary changes. All other
  // current lanes, masks, echo and gains are identical in the two renders.
  const baseline = bassReview ? { ...current, automation: current.automation.map((l: any) => l.lane === 'low'
    ? savedBaseline.automation.find((q: any) => q.deck === l.deck && q.lane === 'low') ?? l : l) } : savedBaseline;
  const result: any = { from: row.from, to: row.to, fromId: row.fromId, toId: row.toId, baseline, inherited: row.plan, current,
    unchanged: Object.fromEntries(['method', 'aExit', 'bEntry', 'duration', 'swapAt', 'tempoA', 'tempoB', 'vocalA', 'vocalB', 'voiceEcho'].map(k => [k, JSON.stringify(baseline[k]) === JSON.stringify(current[k])])) };
  if (process.argv.includes('--render')) {
    const a = pcm(row.fromId), b = pcm(row.toId);
    for (const variant of tightReview ? ['current'] : bassReview ? ['baseline', 'current'] : ['baseline', 'inherited', 'current']) {
      const audioPath = process.argv.includes('--audio') ? path.join(dir, 'previews/sol-planning-ab', `${row.fromId.slice(0, 8)}_${row.toId.slice(0, 8)}_${variant}.wav`) : undefined;
      result[`${variant}Render`] = metrics(a, b, result[variant], audioPath);
      if (audioPath) result[`${variant}Audio`] = audioPath;
      console.log(JSON.stringify({ from: row.from, to: row.to, variant, ...result[`${variant}Render`] }));
    }
  }
  rows.push(result);
}
const locked = matrix.filter((r: any) => r.before.method === 'beatmatch_blend');
const variants = matrix.reduce((sum: Record<string, number>, r: any) => { const v = r.after.debug.variant ?? r.after.method; sum[v] = (sum[v] ?? 0) + 1; return sum; }, {});
const report = { generatedAt: new Date().toISOString(), planner: PLANNER_VERSION, settings, provenance: { selection: 'user-library-planning-baseline-v10.json', analyses: 'saved analyzer-10, no inference', audio: 'float decode + cached aligned stems',
  control: bassReview ? 'Isolated low-lane AB: all current non-low automation, vocal masks, echo and gains identical' : 'Saved baseline and inherited plans, current planner on the same saved analysis', currentVersions },
  summary: { pairs: matrix.length, variants, locked: locked.length, lockedAnchorsPreserved: locked.filter((r: any) => ['method', 'aExit', 'bEntry', 'duration'].every(k => r.before[k] === r.after[k])).length }, rows, matrix };
const index = process.argv.indexOf('--tag'), tag = index >= 0 ? process.argv[index + 1] : 'planning-techniques-review';
if (!/^[a-z0-9_-]+$/i.test(tag)) throw Error('Invalid tag');
fs.writeFileSync(path.join(dir, `${tag}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary));
