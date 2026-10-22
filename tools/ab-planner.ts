/** Same-input A/B of the planner: a frozen control copy versus the working tree.
 * Reads a saved audit report (tracks with embedded analysis), never the server's DB writes.
 *   npx tsx tools/ab-planner.ts --report user-library-planning-baseline-v10.json --tag NAME
 *   npx tsx tools/ab-planner.ts --report user-library-rated-a10-baseline.json --rated --tag NAME
 *   ... --render 12 [--audio] [--only variant]   renders changed pairs with both plans
 * The control is tools/.cache/baseline-planner/planner.ts (planner.ts copied before this work,
 * importing the live vocals.ts/timing.ts), so differences are the planner change only.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import { EventHub } from '../apps/server/src/events.ts';
import type { Library } from '../apps/server/src/library.ts';
import { planTransition, renderTransitionOffline, type PlannerTrack, type StereoPcm, type TransitionPlan } from '../packages/core/src/index.ts';
import { planTransition as controlPlan } from './.cache/baseline-planner/planner.ts';
import { decode, shortTermLoudness } from './eval-transitions.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
const cfg = loadConfig(), dir = path.join(cfg.dataDir, 'reports');
const tag = arg('--tag', 'ab');
if (!/^[\p{L}\p{N}_-]+$/u.test(tag)) throw new Error('bad tag');
const report = JSON.parse(fs.readFileSync(path.join(dir, arg('--report', 'user-library-planning-baseline-v10.json')), 'utf8'));
const settings = report.settings;
const db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
const sources = db.prepare('SELECT t.id,t.title,t.provider,t.content_hash,(SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t').all() as { id: string; title: string; provider: string; content_hash: string; file: string }[];
const ratedRows = db.prepare("SELECT id,from_track,to_track,rating,rating_reason,plan FROM transition_log WHERE rating IS NOT NULL ORDER BY id").all() as { id: number; from_track: string; to_track: string; rating: string; rating_reason: string | null; plan: string }[];
db.close();
// --no-stems: a PC without GPU / not yet separated tracks: no vocal activity, no ASR
const noStems = process.argv.includes('--no-stems');
if (noStems) settings.stemMixing = false;
const tracks = new Map<string, PlannerTrack & { title: string }>(report.tracks.filter((t: any) => t.analysis).map((t: any) =>
  [t.id, { id: t.id, title: t.title ?? sources.find(s => s.id === t.id)?.title ?? t.id, duration: t.analysis.duration,
    analysis: noStems ? { ...t.analysis, vocalActivity: undefined } : t.analysis, mixingAllowed: true }]));
const pairs: { from: string; to: string; rating?: string; reason?: string | null; logId?: number; heard?: TransitionPlan }[] = [];
if (process.argv.includes('--rated')) {
  for (const r of ratedRows) if (tracks.has(r.from_track) && tracks.has(r.to_track))
    pairs.push({ from: r.from_track, to: r.to_track, rating: r.rating, reason: r.rating_reason, logId: r.id, heard: JSON.parse(r.plan) });
} else for (const a of tracks.keys()) for (const b of tracks.keys()) if (a !== b) pairs.push({ from: a, to: b });

const variant = (p: TransitionPlan) => typeof p.debug.variant === 'string' ? p.debug.variant
  : p.method === 'crossfade' ? (p.debug.washout ? 'washout' : p.debug.naturalFade ? 'fade' : 'crossfade') : p.method;
const geometry = (p: TransitionPlan) => ({ method: p.method, variant: variant(p), aExit: p.aExit, bEntry: p.bEntry, duration: p.duration, swapAt: p.swapAt,
  bars: p.beatAlign ? p.beatAlign.overlapBeats / 4 : undefined, skipB: p.entrySelection?.skippedSeconds, cut: p.debug.cut,
  lostA: (p.debug.stems as any)?.lostA, lostB: (p.debug.stems as any)?.lostB, bassSwap: (p.debug.bassSwap as any)?.at, grid: p.debug.gridTrust, structure: p.debug.structure });
const t0 = Date.now();
const rows = pairs.map(pair => {
  const A = tracks.get(pair.from)!, B = tracks.get(pair.to)!;
  const control = controlPlan(A, B, settings), current = planTransition(A, B, settings);
  const same = ['method', 'aExit', 'bEntry', 'duration', 'swapAt'].every(k => (control as any)[k] === (current as any)[k]);
  return { ...pair, fromTitle: A.title, toTitle: B.title, same, sameLanes: same && JSON.stringify(control.automation) === JSON.stringify(current.automation),
    control: geometry(control), current: geometry(current), controlPlan: control, currentPlan: current };
});
const count = (key: 'control' | 'current') => rows.reduce<Record<string, number>>((c, r) => { c[r[key].variant] = (c[r[key].variant] ?? 0) + 1; return c; }, {});
const beatmatchKept = rows.filter(r => r.control.method === 'beatmatch_blend');
const summary = {
  pairs: rows.length, planMs: Date.now() - t0, unchanged: rows.filter(r => r.same).length, lanesIdentical: rows.filter(r => r.sameLanes).length,
  control: count('control'), current: count('current'),
  controlBeatmatch: beatmatchKept.length, beatmatchGeometryKept: beatmatchKept.filter(r => r.same).length,
  beatmatchLost: beatmatchKept.filter(r => r.current.method !== 'beatmatch_blend').length,
  meanSkipB: { control: mean(rows.map(r => r.control.skipB ?? 0)), current: mean(rows.map(r => r.current.skipB ?? 0)) },
  deepEntries20: { control: rows.filter(r => (r.control.skipB ?? 0) >= 20).length, current: rows.filter(r => (r.current.skipB ?? 0) >= 20).length },
  meanDuration: { control: mean(rows.map(r => r.control.duration)), current: mean(rows.map(r => r.current.duration)) },
  meanLostB: { control: mean(rows.map(r => r.control.lostB ?? 0)), current: mean(rows.map(r => r.current.lostB ?? 0)) },
  meanLostA: { control: mean(rows.map(r => r.control.lostA ?? 0)), current: mean(rows.map(r => r.current.lostA ?? 0)) },
  ...(process.argv.includes('--rated') ? { rated: { good: rows.filter(r => r.rating === 'good').length, goodUnchanged: rows.filter(r => r.rating === 'good' && r.same).length,
    bad: rows.filter(r => r.rating === 'bad').length, badChanged: rows.filter(r => r.rating === 'bad' && !r.same).length } } : {}),
};
function mean(x: number[]) { return x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0; }

// ---- optional rendering of changed pairs, control and current, identical sources/settings ----
const TP = [1, 2, 3].map(k => { const h = Array.from({ length: 64 }, (_, j) => { const d = j - 31 - k / 4; return Math.sin(Math.PI * d) / (Math.PI * d) * (.5 + .5 * Math.cos(Math.PI * d / 33)); }), s = h.reduce((a, b) => a + b); return h.map(v => v / s); });
function truePeak(...chs: Float32Array[]) { let mx = 0; for (const x of chs) for (let n = 0; n < x.length; n++) { mx = Math.max(mx, Math.abs(x[n])); for (const h of TP) { let y = 0; for (let j = 0; j < 64; j++) { const m = n - 31 + j; if (m >= 0 && m < x.length) y += h[j] * x[m]; } mx = Math.max(mx, Math.abs(y)); } } return 20 * Math.log10(Math.max(1e-10, mx)); }
const stems = new StemService({ ...cfg, stemsPython: null }, {} as Library, new EventHub());
const pcmCache = new Map<string, StereoPcm>();
function pcm(id: string): StereoPcm {
  const hit = pcmCache.get(id); if (hit) return hit;
  const t = sources.find(s => s.id === id)!;
  const file = t.provider === 'yandex' ? path.join(cfg.dataDir, 'remote/yandex', `${t.content_hash}.mp3`) : t.file;
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== t.content_hash) throw Error(`changed original ${t.title}`);
  const audio = decode(file), meta = stems.get(t.content_hash);
  let vocals: StereoPcm['vocals'];
  if (meta && meta.frames === audio.L.length) {
    const L = new Float32Array(meta.frames), R = new Float32Array(meta.frames);
    for (let f = 0; f < meta.frames; f += 65536) { const c = Math.min(65536, meta.frames - f), b = stems.readNative(t.content_hash, f, c); for (let i = 0; i < c; i++) { L[f + i] = b.readFloatLE(i * 8); R[f + i] = b.readFloatLE(i * 8 + 4); } }
    vocals = { L, R };
  }
  if (pcmCache.size >= 4) pcmCache.delete(pcmCache.keys().next().value!);
  const p = { ...audio, sampleRate: 44100, vocals }; pcmCache.set(id, p); return p;
}
function render(plan: TransitionPlan, audioFile?: string) {
  const a = pcm(plan.fromTrackId), b = pcm(plan.toTrackId);
  if ((plan.vocalA && !a.vocals) || (plan.vocalB && !b.vocals)) throw Error('plan needs vocal PCM that is not cached');
  const r = renderTransitionOffline(a, b, plan, 8, 12), lv = shortTermLoudness(r.L, r.R);
  const s0 = Math.max(1, Math.round(r.transitionStartFrame / 4410) - 30), s1 = Math.min(lv.length - 1, s0 + Math.round((plan.duration + plan.gap) * 10) + 30);
  const med = (x: number[]) => [...x].sort((p, q) => p - q)[Math.floor(x.length / 2)] ?? -90;
  const before = med(lv.slice(Math.max(0, s0 - 40), Math.max(1, s0 - 5))), after = med(lv.slice(s1)), during = lv.slice(s0, s1);
  if (audioFile) {
    fs.mkdirSync(path.dirname(audioFile), { recursive: true });
    const inter = new Float32Array(r.L.length * 2); for (let i = 0; i < r.L.length; i++) { inter[2 * i] = r.L[i]; inter[2 * i + 1] = r.R[i]; }
    execFileSync(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-q:a', '2', audioFile], { input: Buffer.from(inter.buffer), windowsHide: true, maxBuffer: 1 << 26 });
  }
  return { underruns: r.metrics.underruns, maxLimiterReductionDb: r.metrics.maxLimiterReductionDb, truePeakDbTP: truePeak(r.L, r.R),
    dipLU: Math.min(0, ...during.map(v => v - Math.min(before, after))), bumpLU: Math.max(0, ...during.map(v => v - Math.max(before, after))),
    beforeLUFS: before, afterLUFS: after, completed: r.events.some(e => e.type === 'transitionEnd'), finite: r.L.every(Number.isFinite) && r.R.every(Number.isFinite) };
}
const renderN = Number(arg('--render', '0')), only = arg('--only', '');
const changed = rows.filter(r => !r.same && (!only || r.current.variant === only || r.control.variant === only || String(r.current.grid ?? '').includes(only)));
// spread renders over different A tracks
const picked: typeof rows = [];
for (const r of changed) if (picked.length < renderN && !picked.some(p => p.from === r.from)) picked.push(r);
for (const r of changed) if (picked.length < renderN && !picked.includes(r)) picked.push(r);
const renders: any[] = [];
for (const [i, r] of picked.entries()) {
  const base = path.join(dir, 'previews', tag, `${String(i + 1).padStart(2, '0')}_${r.from.slice(0, 8)}_${r.to.slice(0, 8)}`);
  const audio = process.argv.includes('--audio');
  try {
    renders.push({ from: r.fromTitle, to: r.toTitle, rating: r.rating, control: r.control, current: r.current,
      controlRender: render(r.controlPlan, audio ? `${base}_control.mp3` : undefined), currentRender: render(r.currentPlan, audio ? `${base}_current.mp3` : undefined) });
  } catch (e) { renders.push({ from: r.fromTitle, to: r.toTitle, error: (e as Error).message }); }
  console.log(`rendered ${i + 1}/${picked.length}: ${r.fromTitle} -> ${r.toTitle}`);
}
const out = path.join(dir, `planner-ab-${tag}.json`);
fs.writeFileSync(out, JSON.stringify({ settings, summary, renders, rows: rows.map(({ controlPlan: _c, currentPlan: _p, heard, ...r }) => ({ ...r, heard: heard ? { method: heard.method, version: heard.version, aExit: heard.aExit, bEntry: heard.bEntry, duration: heard.duration } : undefined })) }, null, 1));
console.log(JSON.stringify(summary, null, 1));
if (renders.length) console.log(JSON.stringify(renders.map(r => r.error ? r : { pair: `${r.from} -> ${r.to}`, c: `${r.control.variant} dip ${r.controlRender.dipLU.toFixed(2)} bump ${r.controlRender.bumpLU.toFixed(2)} tp ${r.controlRender.truePeakDbTP.toFixed(2)} u ${r.controlRender.underruns}`,
  n: `${r.current.variant} dip ${r.currentRender.dipLU.toFixed(2)} bump ${r.currentRender.bumpLU.toFixed(2)} tp ${r.currentRender.truePeakDbTP.toFixed(2)} u ${r.currentRender.underruns}` }), null, 1));
console.log(out);
