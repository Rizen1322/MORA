/** Stemless AutoMix A/B: the planner snapshot taken before the full-mix work versus the working tree,
 * on the same analyses from the server DB (read-only). Two input states per pair:
 *   stemless — the stored analysis has no vocal maps (phone / not yet separated);
 *   stems    — vocal activity of separated tracks attached as the server does; plans must not change.
 *   npx tsx tools/stemless-ab.ts --tag NAME [--sample 300] [--render 12] [--audio]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import { EventHub } from '../apps/server/src/events.ts';
import { getSettings } from '../apps/server/src/automix.ts';
import type { Library } from '../apps/server/src/library.ts';
import { chooseByRender, planFinalists, planTransition, renderTransitionOffline, type PlannerTrack, type StereoPcm, type TrackAnalysis, type TransitionPlan } from '../packages/core/src/index.ts';
import { planTransition as controlPlan } from './.cache/stemless-before-2026-10-22/core-src/plan/planner.ts';
import { decode, shortTermLoudness } from './eval-transitions.ts';

const arg = (name: string, d: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : d; };
const cfg = loadConfig(), dir = path.join(cfg.dataDir, 'reports');
const tag = arg('--tag', 'stemless');
if (!/^[\p{L}\p{N}_-]+$/u.test(tag)) throw new Error('bad tag');
const db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
const settings = getSettings(db as never).automix;
const rowsT = db.prepare(`SELECT t.id,t.title,t.provider,t.content_hash,t.duration,(SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file,
  a.data FROM tracks t JOIN analysis a ON a.content_hash=t.content_hash AND a.status='done' AND a.version=?`).all('am-analyzer-12') as
  { id: string; title: string; provider: string; content_hash: string; duration: number; file: string | null; data: string }[];
const rated = db.prepare("SELECT id,from_track,to_track,rating,rating_reason FROM transition_log WHERE rating IS NOT NULL ORDER BY id").all() as
  { id: number; from_track: string; to_track: string; rating: string; rating_reason: string | null }[];
db.close();
const stems = new StemService({ ...cfg, stemsPython: null }, {} as Library, new EventHub());
const tracks = new Map(rowsT.map(t => {
  const analysis = JSON.parse(t.data) as TrackAnalysis;
  const activity = stems.activity(t.content_hash);
  const base = { id: t.id, duration: t.duration || analysis.duration, mixingAllowed: true };
  return [t.id, { title: t.title, row: t, plain: { ...base, analysis: { ...analysis, vocalActivity: undefined } } as PlannerTrack,
    voiced: activity ? { ...base, analysis: { ...analysis, vocalActivity: activity } } as PlannerTrack : null }];
}));

// rated pairs first, then a deterministic sample of other directed pairs
const pairs: { from: string; to: string; rating?: string; reason?: string | null }[] = rated
  .filter(r => tracks.has(r.from_track) && tracks.has(r.to_track)).map(r => ({ from: r.from_track, to: r.to_track, rating: r.rating, reason: r.rating_reason }));
const ids = [...tracks.keys()].sort(), want = Number(arg('--sample', '300'));
for (let i = 0; pairs.length < want + rated.length && i < want * 20; i++) {
  const h = crypto.createHash('sha1').update(`pair${i}`).digest();
  const a = ids[h.readUInt32LE(0) % ids.length], b = ids[h.readUInt32LE(4) % ids.length];
  if (a !== b && !pairs.some(p => p.from === a && p.to === b)) pairs.push({ from: a, to: b });
}

const variant = (p: TransitionPlan) => typeof p.debug.variant === 'string' ? p.debug.variant
  : p.method === 'crossfade' ? (p.debug.washout ? 'washout' : p.debug.naturalFade ? 'fade' : 'crossfade') : p.method;
const geometry = (p: TransitionPlan) => ({ method: p.method, variant: variant(p), aExit: p.aExit, bEntry: p.bEntry, duration: p.duration, swapAt: p.swapAt,
  bars: p.beatAlign ? p.beatAlign.overlapBeats / 4 : undefined, skipB: p.entrySelection?.skippedSeconds, echo: !!p.echo, loop: !!p.loopA,
  fullMix: (p.debug.fullMix as { selected?: string } | undefined)?.selected });
const same = (x: TransitionPlan, y: TransitionPlan) => JSON.stringify({ ...x, debug: undefined, id: undefined, version: undefined })
  === JSON.stringify({ ...y, debug: undefined, id: undefined, version: undefined });

const t0 = Date.now();
const rows = pairs.map(pair => {
  const A = tracks.get(pair.from)!, B = tracks.get(pair.to)!;
  const control = controlPlan(A.plain as never, B.plain as never, settings as never) as TransitionPlan, current = planTransition(A.plain, B.plain, settings);
  const voiced = A.voiced && B.voiced ? { control: controlPlan(A.voiced as never, B.voiced as never, settings as never) as TransitionPlan, current: planTransition(A.voiced, B.voiced, settings) } : null;
  return { ...pair, fromTitle: A.title, toTitle: B.title, changed: !same(control, current), stemsChanged: voiced ? !same(voiced.control, voiced.current) : null,
    control: geometry(control), current: geometry(current), reasons: current.reasons.slice(-3), controlPlan: control, currentPlan: current };
});
const count = (key: 'control' | 'current') => rows.reduce<Record<string, number>>((c, r) => { c[r[key].variant] = (c[r[key].variant] ?? 0) + 1; return c; }, {});
const mean = (x: number[]) => x.length ? Math.round(x.reduce((a, b) => a + b, 0) / x.length * 100) / 100 : 0;
const summary = {
  pairs: rows.length, planMs: Date.now() - t0, stemless: { changed: rows.filter(r => r.changed).length, control: count('control'), current: count('current'),
    meanDuration: { control: mean(rows.map(r => r.control.duration)), current: mean(rows.map(r => r.current.duration)) },
    meanSkipB: { control: mean(rows.map(r => r.control.skipB ?? 0)), current: mean(rows.map(r => r.current.skipB ?? 0)) },
    echo: { control: rows.filter(r => r.control.echo).length, current: rows.filter(r => r.current.echo).length },
    loops: { control: rows.filter(r => r.control.loop).length, current: rows.filter(r => r.current.loop).length } },
  stems: { compared: rows.filter(r => r.stemsChanged !== null).length, changed: rows.filter(r => r.stemsChanged).length },
  rated: { good: rows.filter(r => r.rating === 'good').length, goodChanged: rows.filter(r => r.rating === 'good' && r.changed).length,
    bad: rows.filter(r => r.rating === 'bad').length, badChanged: rows.filter(r => r.rating === 'bad' && r.changed).length },
};

// ---- optional renders of changed stemless pairs: same PCM, original full mix only ----
const pcmCache = new Map<string, StereoPcm>();
function pcm(id: string): StereoPcm {
  const hit = pcmCache.get(id); if (hit) return hit;
  const t = tracks.get(id)!.row;
  const file = t.provider === 'yandex' ? path.join(cfg.dataDir, 'remote/yandex', `${t.content_hash}.mp3`) : t.file!;
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== t.content_hash) throw Error(`changed original ${t.title}`);
  if (pcmCache.size >= 4) pcmCache.delete(pcmCache.keys().next().value!);
  const p = { ...decode(file), sampleRate: 44100 }; pcmCache.set(id, p); return p;
}
function render(plan: TransitionPlan, audioFile?: string) {
  const r = renderTransitionOffline(pcm(plan.fromTrackId), pcm(plan.toTrackId), plan, 8, 12), lv = shortTermLoudness(r.L, r.R);
  const s0 = Math.max(1, Math.round(r.transitionStartFrame / 4410) - 30), s1 = Math.min(lv.length - 1, s0 + Math.round((plan.duration + plan.gap) * 10) + 30);
  const med = (x: number[]) => [...x].sort((p, q) => p - q)[Math.floor(x.length / 2)] ?? -90;
  const before = med(lv.slice(Math.max(0, s0 - 40), Math.max(1, s0 - 5))), after = med(lv.slice(s1)), during = lv.slice(s0, s1);
  if (audioFile) {
    fs.mkdirSync(path.dirname(audioFile), { recursive: true });
    const inter = new Float32Array(r.L.length * 2); for (let i = 0; i < r.L.length; i++) { inter[2 * i] = r.L[i]; inter[2 * i + 1] = r.R[i]; }
    execFileSync(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-q:a', '2', audioFile], { input: Buffer.from(inter.buffer), windowsHide: true, maxBuffer: 1 << 26 });
  }
  return { underruns: r.metrics.underruns, maxLimiterReductionDb: Math.round(r.metrics.maxLimiterReductionDb * 100) / 100,
    dipLU: Math.round(Math.min(0, ...during.map(v => v - Math.min(before, after))) * 100) / 100,
    bumpLU: Math.round(Math.max(0, ...during.map(v => v - Math.max(before, after))) * 100) / 100 };
}
const renderN = Number(arg('--render', '0')), renders: unknown[] = [];
const local = (id: string) => { const t = tracks.get(id)!.row; return t.provider === 'yandex' || !!t.file; };
const changed = [...rows.filter(r => r.changed && r.rating), ...rows.filter(r => r.changed && !r.rating)].filter(r => local(r.from) && local(r.to)).slice(0, renderN);
for (const [i, r] of changed.entries()) {
  const base = path.join(dir, 'previews', tag, `${String(i + 1).padStart(2, '0')}_${r.from.slice(0, 8)}_${r.to.slice(0, 8)}`), audio = process.argv.includes('--audio');
  try {
    // the server's P10 step: finalists rendered on the same full PCM, technical faults only
    const A = tracks.get(r.from)!, B = tracks.get(r.to)!, whole = (id: string) => ({ pcm: pcm(id), start: 0 });
    const checked = await chooseByRender(planFinalists(A.plain, B.plain, settings), whole(r.from), whole(r.to));
    renders.push({ pair: `${r.fromTitle} -> ${r.toTitle}`, rating: r.rating, control: { ...r.control, ...render(r.controlPlan, audio ? `${base}_control.mp3` : undefined) },
      current: { ...r.current, ...render(r.currentPlan, audio ? `${base}_current.mp3` : undefined) },
      checked: { ...geometry(checked), selected: (checked.debug.renderCheck as { selected?: string }).selected, ...render(checked, audio ? `${base}_checked.mp3` : undefined) } });
  }
  catch (e) { renders.push({ pair: `${r.fromTitle} -> ${r.toTitle}`, error: (e as Error).message }); }
  console.log(`rendered ${i + 1}/${changed.length}`);
}
const out = path.join(dir, `stemless-ab-${tag}.json`);
fs.writeFileSync(out, JSON.stringify({ settings, summary, renders, rows: rows.map(({ controlPlan: _c, currentPlan: _p, ...r }) => r) }, null, 1));
console.log(JSON.stringify({ summary, renders }, null, 1));
console.log(out);
