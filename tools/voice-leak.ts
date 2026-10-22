/** Audible old voice after the handoff, measured by separating the rendered output; private outputs only.
 * For each pair: current plan, render with B silent (A exactly as in playback: vocal mask, voice echo,
 * deck echo, EQ/fades), separate that render with the same local model, and compare the separated
 * voice after B's voice opens with A's singing before the transition. Unlike --voice-tail (clean stem
 * through the mask), this includes voice left in A's accompaniment (separation leakage).
 * Usage: npx tsx tools/voice-leak.ts --report data-dev/reports/user-library-X.json [--limit N] [--tag NAME]
 *        npx tsx tools/voice-leak.ts --log ID,ID [--tag NAME]
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

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] ?? fallback; };
const tag = arg('--tag', 'voice-leak'), limit = Number(arg('--limit', '12'));
if (!/^[\p{L}\p{N}_-]+$/u.test(tag)) throw new Error('некорректное имя отчёта');
const cfg = loadConfig();
if (!cfg.stemsPython) throw new Error('STEMS_PYTHON не задан');
const out = path.join(cfg.dataDir, 'reports'), work = path.join(out, 'voice-leak', tag), cacheDir = path.join(out, 'analysis-cache');
fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(cacheDir, { recursive: true });
const db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
const stems = new StemService({ ...cfg, stemsPython: null }, {} as Library, new EventHub());
const saved = db.prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
const settings = { ...DEFAULT_AUTOMIX_SETTINGS, ...(saved ? JSON.parse(saved.value).automix : {}) };
interface Track { id: string; title: string; provider: string; content_hash: string; file: string; duration: number; album: string; album_artist: string; artist: string; track_no: number | null; disc_no: number | null }
const trackQ = db.prepare("SELECT t.*, (SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t WHERE id=?");
const trackOf = (id: string) => { const t = trackQ.get(id) as unknown as Track; return { ...t, file: t.provider === 'yandex' && /^[a-f\d]{64}$/.test(t.content_hash) ? path.join(cfg.dataDir, 'remote', 'yandex', `${t.content_hash}.mp3`) : t.file }; };

type Pair = { label: string; from: string; to: string; rating?: string | null; reason?: string | null };
const pairs: Pair[] = [];
if (arg('--log', '')) for (const id of arg('--log', '').split(',').map(Number)) {
  const r = db.prepare('SELECT from_track, to_track, rating, rating_reason FROM transition_log WHERE id=?').get(id) as { from_track: string; to_track: string; rating: string | null; rating_reason: string | null } | undefined;
  if (r) pairs.push({ label: `log${id}`, from: r.from_track, to: r.to_track, rating: r.rating, reason: r.rating_reason });
}
if (arg('--pairs-from', '')) for (const r of JSON.parse(fs.readFileSync(path.resolve(arg('--pairs-from', '')), 'utf8')).rows as Pair[])
  pairs.push({ label: r.label, from: r.from, to: r.to, rating: r.rating, reason: r.reason });
if (arg('--report', '')) {
  // pairs whose plan really hands the voice over (A masked while A sings), spread over methods
  const rows = (JSON.parse(fs.readFileSync(path.resolve(arg('--report', '')), 'utf8')).rows as { fromId: string; toId: string; plan: TransitionPlan }[])
    .filter((r) => r.plan.vocalA?.some(([, g]) => g < 1) && (r.plan.debug.stems as { bVoiceStart?: number } | undefined)?.bVoiceStart !== undefined);
  // deterministic spread over different A and B tracks (golden-ratio stride)
  const used = new Set<string>();
  for (let k = 0, n = 0; k < rows.length * 4 && n < limit; k++) {
    const i = Math.floor((k * 0.6180339887 % 1) * rows.length), r = rows[i];
    if (used.has(r.fromId) || used.has(`to:${r.toId}`)) continue;
    used.add(r.fromId); used.add(`to:${r.toId}`); pairs.push({ label: `r${i}`, from: r.fromId, to: r.toId }); n++;
  }
}

const pcm = new Map<string, StereoPcm>();
function load(t: Track): StereoPcm {
  let p = pcm.get(t.id);
  if (p) return p;
  if (pcm.size >= 2) pcm.delete(pcm.keys().next().value!);
  p = { ...decode(t.file), sampleRate: 44100 };
  const meta = stems.get(t.content_hash);
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
  if (!a) { const row = db.prepare("SELECT data FROM analysis WHERE content_hash=? AND version=? AND status='done'").get(t.content_hash, ANALYZER_VERSION) as { data: string } | undefined; a = row ? JSON.parse(row.data) : null; }
  if (!a) { const p = load(t); a = analyzePcm(p.L, p.R); fs.writeFileSync(file, JSON.stringify({ hash: t.content_hash, version: ANALYZER_VERSION, analysis: a })); }
  const v = stems.activity(t.content_hash);
  return v ? { ...a!, vocalActivity: v } : a!;
}
const pt = (t: Track, analysis: TrackAnalysis): PlannerTrack => ({ id: t.id, duration: t.duration, mixingAllowed: true, analysis, album: t.album, albumArtist: t.album_artist || t.artist, trackNo: t.track_no, discNo: t.disc_no });

/** Separated voice level (dBFS per 100 ms) of a rendered snippet, using the production separator. */
function separatedVoiceDb(L: Float32Array, R: Float32Array, dir: string): number[] {
  fs.mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, 'render.f32'), inter = new Float32Array(L.length * 2);
  for (let i = 0; i < L.length; i++) { inter[2 * i] = L[i]; inter[2 * i + 1] = R[i]; }
  const flac = path.join(dir, 'render.flac');
  fs.writeFileSync(wav, Buffer.from(inter.buffer));
  execFileSync(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'f32le', '-ar', '44100', '-ac', '2', '-i', wav, flac], { windowsHide: true });
  fs.rmSync(wav);
  execFileSync(cfg.stemsPython!, [path.resolve('tools/separate-vocals.py'), '--input', flac, '--output', dir, '--ffmpeg', cfg.ffmpeg], { windowsHide: true, maxBuffer: 64 * 1048576, env: { ...process.env, TORCH_HOME: path.join(cfg.dataDir, 'cache', 'models') } });
  return JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')).activity.vocalRmsDb as number[];
}

export interface LeakResult { refDb: number; tailDb: number; tailPeakDb: number; overlapVoiceDb: number; cleanTailDb: number }
/** Levels relative to A's loudest singing 100 ms block in the 4 s before the transition. */
export function leakLevels(voice: number[], clean: number[], startS: number, openS: number, endS: number): LeakResult | null {
  const at = (x: number[], a: number, b: number) => x.slice(Math.max(0, Math.round(a * 10)), Math.max(0, Math.round(b * 10)));
  const ref = Math.max(...at(voice, startS - 4, startS));
  if (!(ref > -50)) return null;
  const power = (x: number[]) => 10 * Math.log10(x.reduce((s, v) => s + 10 ** (v / 10), 0) / Math.max(1, x.length));
  const tail = at(voice, openS, Math.min(endS, openS + 2));
  return { refDb: ref, tailDb: power(tail) - ref, tailPeakDb: Math.max(...tail) - ref, overlapVoiceDb: power(at(voice, openS, endS)) - ref, cleanTailDb: power(at(clean, openS, Math.min(endS, openS + 2))) - ref };
}

const rows: object[] = [];
for (const pair of pairs) {
  try {
    const A = trackOf(pair.from), B = trackOf(pair.to), plan = planTransition(pt(A, analysisOf(A)), pt(B, analysisOf(B)), settings);
    const st = plan.debug.stems as { bVoiceStart?: number; lostA?: number; lostB?: number } | undefined;
    if (!plan.vocalA || st?.bVoiceStart === undefined) { console.log(`${pair.label} ${A.title} → ${B.title}: нет передачи голоса (${plan.method})`); continue; }
    const a = load(A), b = load(B), zero = new Float32Array(b.L.length), silentB: StereoPcm = { L: zero, R: zero, sampleRate: 44100, vocals: { L: zero, R: zero } };
    const r = renderTransitionOffline(a, silentB, plan, 8, 4);
    const startS = r.transitionStartFrame / 44100, openS = startS + st.bVoiceStart, endS = startS + plan.duration;
    const voice = separatedVoiceDb(r.L, r.R, path.join(work, `${pair.label}_${A.id.slice(0, 8)}_${B.id.slice(0, 8)}`));
    // the clean stem through the same mask (what the existing voice-tail metric sees)
    const c = renderTransitionOffline({ L: a.vocals!.L, R: a.vocals!.R, sampleRate: 44100, vocals: a.vocals }, silentB, plan, 8, 4);
    const clean: number[] = [];
    for (let i = 0; i + 4410 <= c.L.length; i += 4410) { let e = 0; for (let j = i; j < i + 4410; j++) e += c.L[j] ** 2 + c.R[j] ** 2; clean.push(10 * Math.log10(Math.max(1e-12, e / 8820))); }
    const lv = leakLevels(voice, clean, startS, openS, endS);
    const row = { ...pair, fromTitle: A.title, toTitle: B.title, method: plan.method, duration: plan.duration, bVoiceStart: st.bVoiceStart, lostA: st.lostA, lostB: st.lostB, leak: lv };
    rows.push(row);
    console.log(`${pair.label} ${pair.reason ?? ''} ${A.title} → ${B.title} ${plan.method} ${plan.duration.toFixed(1)}s: ` +
      (lv ? `слышимый старый голос после открытия B ${lv.tailDb.toFixed(1)} dB (пик ${lv.tailPeakDb.toFixed(1)}), чистый stem ${lv.cleanTailDb.toFixed(1)} dB` : 'A не поёт перед переходом'));
  } catch (e) { console.log(`${pair.label}: ${(e as Error).message.slice(0, 200)}`); }
}
db.close();
const file = path.join(out, `${tag}.json`);
fs.writeFileSync(file, JSON.stringify({ settings, rows }, null, 2));
console.log(file);
