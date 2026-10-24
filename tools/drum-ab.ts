/** A/B of the drum-pattern bar alignment on logged pairs; private outputs only.
 * Fresh current-version analysis (cached in reports/analysis-cache), then the current planner with
 * and without beat accents (= the previous behaviour), both rendered through the production mixer
 * with separated vocals to data-dev/reports/previews/<tag>/ for listening.
 * Usage: npx tsx tools/drum-ab.ts LOG_ID... [--tag NAME] [--all-shifts]
 *        npx tsx tools/drum-ab.ts --from-report data-dev/reports/user-library-X.json [--tag NAME]  (pairs with a drum shift)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import { EventHub } from '../apps/server/src/events.ts';
import type { Library } from '../apps/server/src/library.ts';
import { ANALYZER_VERSION, DEFAULT_AUTOMIX_SETTINGS, analyzePcm, planTransition, renderTransitionOffline,
  type PlannerTrack, type StereoPcm, type TrackAnalysis, type TransitionPlan } from '../packages/core/src/index.ts';
import { decode } from './eval-transitions.ts';
import { beatAccents, drumEnvelopes } from '../packages/core/src/mir/analyze.ts';
import { barPattern, drumAlignment } from '../packages/core/src/plan/planner.ts';
import { integrateTempo } from '../packages/core/src/plan/timing.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; };
const tag = arg('--tag', 'drum-ab');
if (!/^[\p{L}\p{N}_-]+$/u.test(tag)) throw new Error('некорректное имя отчёта');
const cfg = loadConfig(), out = path.join(cfg.dataDir, 'reports'), cacheDir = path.join(out, 'analysis-cache'), previews = path.join(out, 'previews', tag);
fs.mkdirSync(cacheDir, { recursive: true }); fs.mkdirSync(previews, { recursive: true });
const db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
const stems = new StemService({ ...cfg, stemsPython: null }, {} as Library, new EventHub());
const saved = db.prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
const settings = { ...DEFAULT_AUTOMIX_SETTINGS, ...(saved ? JSON.parse(saved.value).automix : {}) };
interface Track { id: string; title: string; provider: string; content_hash: string; file: string; duration: number; album: string; album_artist: string; artist: string; track_no: number | null; disc_no: number | null }
const trackQ = db.prepare("SELECT t.*, (SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t WHERE id=?");
type Pair = { id: number | string; from_track: string; to_track: string; rating: string | null; rating_reason: string | null };
const report = arg('--from-report', '');
const logs: Pair[] = report
  ? (JSON.parse(fs.readFileSync(path.resolve(report), 'utf8')).rows as { fromId: string; toId: string; plan: TransitionPlan }[])
    .filter((r) => Number((r.plan.debug.drumPattern as { k?: number } | undefined)?.k)).map((r, i) => ({ id: `r${i + 1}`, from_track: r.fromId, to_track: r.toId, rating: null, rating_reason: null }))
  : process.argv.slice(2).filter((x) => /^\d+$/.test(x)).map((id) => db.prepare('SELECT id, from_track, to_track, rating, rating_reason FROM transition_log WHERE id=?').get(Number(id)) as Pair | undefined).filter((x) => !!x);
const trackOf = (id: string) => {
  const t = trackQ.get(id) as unknown as Track;
  return { ...t, file: t.provider === 'yandex' && /^[a-f\d]{64}$/.test(t.content_hash) ? path.join(cfg.dataDir, 'remote', 'yandex', `${t.content_hash}.mp3`) : t.file };
};
const pcm = new Map<string, StereoPcm>();
function load(t: Track): StereoPcm {
  let p = pcm.get(t.id);
  if (p) return p;
  if (pcm.size >= 2) pcm.delete(pcm.keys().next().value!);
  p = { ...decode(t.file), sampleRate: 44100 };
  const meta = settings.stemMixing !== false ? stems.get(t.content_hash) : null;
  if (meta && meta.frames === p.L.length) {
    const L = new Float32Array(meta.frames), R = new Float32Array(meta.frames);
    for (let f = 0; f < meta.frames; f += 65536) { const n = Math.min(65536, meta.frames - f), s = stems.readNative(t.content_hash, f, n); for (let i = 0; i < n; i++) { L[f + i] = s.readFloatLE(i * 8); R[f + i] = s.readFloatLE(i * 8 + 4); } }
    p.vocals = { L, R };
  }
  pcm.set(t.id, p);
  return p;
}
function analysisOf(t: Track): TrackAnalysis {
  const file = path.join(cacheDir, `${t.content_hash}_${ANALYZER_VERSION}.json`);
  let a: TrackAnalysis | null = null;
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c.hash === t.content_hash && c.analysis?.version === ANALYZER_VERSION) a = c.analysis; } catch { /* compute */ }
  if (!a) { const p = load(t); a = analyzePcm(p.L, p.R); fs.writeFileSync(file, JSON.stringify({ hash: t.content_hash, version: ANALYZER_VERSION, analysis: a })); }
  const v = settings.stemMixing !== false ? stems.activity(t.content_hash) : undefined;
  return v ? { ...a, vocalActivity: v } : a;
}
const strip = (a: TrackAnalysis): TrackAnalysis => ({ ...a, beat: a.beat && { ...a.beat, accents: undefined }, beatRegions: a.beatRegions?.map((r) => ({ ...r, accents: undefined })) });
const pt = (t: Track, analysis: TrackAnalysis): PlannerTrack => ({ id: t.id, duration: t.duration, mixingAllowed: true, analysis, album: t.album, albumArtist: t.album_artist || t.artist, trackNo: t.track_no, discNo: t.disc_no });
function render(a: StereoPcm, b: StereoPcm, plan: TransitionPlan, file: string) {
  const r = renderTransitionOffline(a, b, plan, 12, 12), inter = new Float32Array(r.L.length * 2);
  for (let i = 0; i < r.L.length; i++) { inter[2 * i] = r.L[i]; inter[2 * i + 1] = r.R[i]; }
  execFileSync(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-q:a', '2', file], { input: Buffer.from(inter.buffer), windowsHide: true, maxBuffer: 16 * 1048576 });
  return { completed: r.events.some((e) => e.type === 'transitionEnd'), underruns: r.metrics.underruns, peakDbFS: +(20 * Math.log10(Math.max(1e-10, r.metrics.peak))).toFixed(2), finite: r.L.every(Number.isFinite) };
}
const summary = (p: TransitionPlan) => { const st = p.debug.stems as { lostA?: number; lostB?: number } | undefined;
  return { method: p.method, aExit: p.aExit, bEntry: p.bEntry, duration: p.duration, lostA: st?.lostA, lostB: st?.lostB, score: p.debug.score }; };
/** End-to-end check in the rendered signal: each deck rendered alone through the mixer (tempo maps,
 * WSOLA; no fades/EQ/masks), drum accents of both outputs sampled at A's beats in output time, and the
 * bar-pattern match of B against A at the rendered alignment (k = 0) and rotations. */
function renderedMatch(a: StereoPcm, b: StereoPcm, plan: TransitionPlan, A: TrackAnalysis) {
  const bare: TransitionPlan = { ...plan, automation: [], vocalA: undefined, vocalB: undefined, echo: undefined, voiceEcho: undefined };
  const silent = (p: StereoPcm): StereoPcm => ({ L: new Float32Array(p.L.length), R: new Float32Array(p.L.length), sampleRate: 44100 });
  const ra = renderTransitionOffline({ ...a, vocals: undefined }, silent(b), bare, 4, 2), rb = renderTransitionOffline(silent(a), { ...b, vocals: undefined }, bare, 4, 2);
  const start = ra.transitionStartFrame / 44100, mono = (r: { L: Float32Array; R: Float32Array }) => r.L.map((v, i) => (v + r.R[i]) / 2);
  // output time of each A beat inside the overlap (A position advances by the integral of tempoA)
  const beats: number[] = [], downs = new Set<number>();
  const grid = A.beat!, region = plan.beatAlign?.regions?.A;
  const g = region ? A.beatRegions?.find((r) => Math.abs(r.start - region.start) < 0.01) ?? grid : grid;
  for (const [i, tb] of g.beats.entries()) {
    if (tb < plan.aExit || tb > plan.aExit + integrateTempo(plan.tempoA, plan.duration)) continue;
    let lo = 0, hi = plan.duration;
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (plan.aExit + integrateTempo(plan.tempoA, mid) < tb) lo = mid; else hi = mid; }
    beats.push(start + lo);
    if (g.downbeats.some((d) => Math.abs(d - tb) < 0.001)) downs.add(beats.length - 1);
  }
  const da = beatAccents(drumEnvelopes(mono(ra), 44100), beats), db = beatAccents(drumEnvelopes(mono(rb), 44100), beats);
  const downbeats = beats.filter((_, i) => downs.has(i));
  const pa = barPattern({ beats, downbeats, accents: da }, 0, Infinity), pb = barPattern({ beats, downbeats, accents: db }, 0, Infinity);
  const m = pa && pb ? drumAlignment(pa, pb) : null;
  return m ? m.map((x) => +x.toFixed(2)) : null;
}
const rows: object[] = [];
for (const log of logs) {
  const A = trackOf(log.from_track), B = trackOf(log.to_track);
  const aa = analysisOf(A), ab = analysisOf(B);
  const withDrums = planTransition(pt(A, aa), pt(B, ab), settings), before = planTransition(pt(A, strip(aa)), pt(B, strip(ab)), settings);
  const drum = withDrums.debug.drumPattern as { k?: number; match?: number[] } | undefined;
  const changed = withDrums.bEntry !== before.bEntry || withDrums.aExit !== before.aExit || withDrums.method !== before.method;
  const row: Record<string, unknown> = { log: log.id, rating: log.rating, reason: log.rating_reason, from: A.title, to: B.title, method: withDrums.method, drum,
    before: summary(before), after: summary(withDrums), changed };
  if (changed || process.argv.includes('--all-shifts')) {
    const a = load(A), b = load(B), base = `${log.id}_${A.id.slice(0, 8)}_${B.id.slice(0, 8)}`;
    row.renderBefore = { file: path.join(previews, `${base}_1-before.mp3`), ...render(a, b, before, path.join(previews, `${base}_1-before.mp3`)), renderedMatch: renderedMatch(a, b, before, aa) };
    row.renderAfter = { file: path.join(previews, `${base}_2-drums.mp3`), ...render(a, b, withDrums, path.join(previews, `${base}_2-drums.mp3`)), renderedMatch: renderedMatch(a, b, withDrums, aa) };
  }
  rows.push(row);
  console.log(`#${log.id} ${log.rating ?? ''} ${log.rating_reason ?? ''} ${A.title} → ${B.title}: ${withDrums.method} match ${JSON.stringify(drum?.match ?? null)} k ${drum?.k ?? '-'}; bEntry ${before.bEntry} → ${withDrums.bEntry}${changed ? ' (изменён)' : ''}${row.renderBefore ? `
   в рендере k=0..3: до ${JSON.stringify((row.renderBefore as { renderedMatch: unknown }).renderedMatch)} после ${JSON.stringify((row.renderAfter as { renderedMatch: unknown }).renderedMatch)}` : ''}
   до ${JSON.stringify(row.before)}
   после ${JSON.stringify(row.after)}`);
}
db.close();
const file = path.join(out, `${tag}.json`);
fs.writeFileSync(file, JSON.stringify({ analyzer: ANALYZER_VERSION, settings, rows }, null, 2));
console.log(file);
