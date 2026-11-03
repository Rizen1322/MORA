/** Offline, read-only replay of the fixed 18 listener examples. No providers or application services.
 * npx tsx tools/review-rated-transitions.ts [--db <sqlite>] [--report <json>] [--audio-dir <directory>] [--ffmpeg <exe>]
 * Only local cached PCM/source files are read. Audio excerpts go to ignored data-bench-results/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ANALYZER_VERSION, PLANNER_VERSION, DEFAULT_AUTOMIX_SETTINGS, planFinalists, ratingFeatures, ratingStats, type TrackAnalysis, type PlannerTrack, type TransitionPlan, type TransitionRating, type TransitionRatingReason } from '../packages/core/src/index.ts';
import { effectiveExit, fullMixCost } from '../packages/core/src/plan/fullmix.ts';
import { chooseByRender, finalistSpans, renderMetrics, stepAsync, type PcmSpan } from '../packages/core/src/engine/render-check.ts';
import { renderTransitionSteps } from '../packages/core/src/engine/arm.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const dataDir = path.join(process.env.LOCALAPPDATA ?? '', 'MORA', 'data');
const database = arg('--db') ?? path.join(dataDir, 'automix.sqlite');
const reportFile = arg('--report') ?? 'docs/transition-upgrade-validation-v15-2026-10-26.json';
const audioDir = path.resolve(arg('--audio-dir') ?? 'data-bench-results/review-v15-2026-10-26');
if (fs.existsSync(audioDir)) throw Error('Choose a new --audio-dir: existing comparison audio must remain immutable.');
const ffmpeg = arg('--ffmpeg') ?? process.env.FFMPEG_PATH ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'MORA', 'resources', 'ffmpeg', 'ffmpeg.exe');
const rootDir = path.dirname(database), sr = 48000;
const evidence = JSON.parse(fs.readFileSync('docs/transition-listener-evidence-2026-10-26.json', 'utf8'));
const db = new DatabaseSync(database, { readOnly: true });
type Track = { id: string; content_hash: string; duration: number; album: string; album_artist: string; artist: string; track_no: number; disc_no: number; provider: string };
type Log = { id: number; from_track: string; to_track: string; plan: string; outcome: string; rating: TransitionRating; rating_reason: TransitionRatingReason | null };
const parse = (value: string | null) => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
const track = (id: string) => db.prepare('SELECT * FROM tracks WHERE id=?').get(id) as unknown as Track | undefined;
const analyses = new Map<string, TrackAnalysis | null>();
function analysis(t: Track): TrackAnalysis | null {
  if (!analyses.has(t.content_hash)) {
    const row = db.prepare("SELECT data FROM analysis WHERE content_hash=? AND status='done' AND data IS NOT NULL ORDER BY version=? DESC,updated_at DESC LIMIT 1").get(t.content_hash, ANALYZER_VERSION) as { data: string } | undefined;
    analyses.set(t.content_hash, parse(row?.data ?? null));
  }
  return analyses.get(t.content_hash)!;
}
const plannerTrack = (t: Track): PlannerTrack => ({ id: t.id, duration: t.duration, album: t.album || null, albumArtist: t.album_artist || t.artist || null, trackNo: t.track_no, discNo: t.disc_no, mixingAllowed: ['local', 'yandex', 'youtube', 'soundcloud'].includes(t.provider), analysis: analysis(t) });

function localInput(t: Track): { file: string; format: 'f32' | 's16h' | 'encoded'; rate: number } | null {
  for (const dir of ['cache/pcm', 'session-cache/pcm']) {
    const folder = path.join(rootDir, dir);
    if (!fs.existsSync(folder)) continue;
    const name = fs.readdirSync(folder).find(n => n.startsWith(`${t.content_hash}_`) && /_48000\.(f32|s16h)$/.test(n));
    if (name) return { file: path.join(folder, name), format: name.endsWith('.f32') ? 'f32' : 's16h', rate: sr };
  }
  const sources = db.prepare('SELECT path FROM track_sources WHERE track_id=? AND path IS NOT NULL').all(t.id) as { path: string }[];
  for (const source of sources) if (!/^[a-z]+:\/\//i.test(source.path) && fs.existsSync(source.path) && fs.statSync(source.path).isFile()) return { file: source.path, format: 'encoded', rate: sr };
  for (const provider of ['yandex', 'youtube', 'soundcloud']) {
    const folder = path.join(rootDir, 'remote', provider);
    if (!fs.existsSync(folder)) continue;
    const name = fs.readdirSync(folder).find(n => n.startsWith(`${t.content_hash}.`) && /\.(mp3|m4a|webm|opus|ogg|flac|wav)$/i.test(n));
    if (name) return { file: path.join(folder, name), format: 'encoded', rate: sr };
  }
  return null;
}

function readSpan(input: NonNullable<ReturnType<typeof localInput>>, span: [number, number]): PcmSpan {
  const start = Math.max(0, Math.floor(span[0] * sr) / sr), seconds = Math.max(0, span[1] - start);
  let raw: Buffer;
  if (input.format === 'encoded') {
    raw = execFileSync(ffmpeg, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', input.file, '-t', String(seconds), '-vn', '-sn', '-dn', '-ac', '2', '-ar', String(sr), '-f', 'f32le', 'pipe:1'], { windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  } else {
    const width = input.format === 'f32' ? 8 : 4, offset = Math.round(start * sr) * width;
    const count = Math.min(Math.ceil(seconds * sr) * width, Math.max(0, fs.statSync(input.file).size - offset));
    raw = Buffer.alloc(count);
    const fd = fs.openSync(input.file, 'r');
    try { const n = fs.readSync(fd, raw, 0, count, offset); raw = raw.subarray(0, n); } finally { fs.closeSync(fd); }
  }
  const width = input.format === 's16h' ? 4 : 8, n = Math.floor(raw.length / width), L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = width === 8 ? raw.readFloatLE(i * 8) : raw.readInt16LE(i * 4) * 2 / 32768;
    R[i] = width === 8 ? raw.readFloatLE(i * 8 + 4) : raw.readInt16LE(i * 4 + 2) * 2 / 32768;
  }
  return { pcm: { L, R, sampleRate: sr }, start };
}

async function excerpt(plan: TransitionPlan, a: PcmSpan, b: PcmSpan, name: string) {
  const shifted = { ...plan, aExit: plan.aExit - a.start, bEntry: plan.bEntry - b.start };
  const rendered = await stepAsync(renderTransitionSteps(a.pcm, b.pcm, shifted, 6, 6));
  const bytes = rendered.L.length * 8, wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 8, 28);
  wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  let nonFinite = 0;
  for (let i = 0; i < rendered.L.length; i++) {
    if (!Number.isFinite(rendered.L[i]) || !Number.isFinite(rendered.R[i])) nonFinite++;
    wav.writeFloatLE(rendered.L[i], 44 + i * 8); wav.writeFloatLE(rendered.R[i], 48 + i * 8);
  }
  fs.mkdirSync(audioDir, { recursive: true }); fs.writeFileSync(path.join(audioDir, name), wav);
  const planFile = name.replace(/\.wav$/, '.plan.json');
  fs.writeFileSync(path.join(audioDir, planFile), JSON.stringify(plan, null, 2) + '\n');
  return { file: name, planFile, transitionStartsAtSeconds: rendered.transitionStartFrame / sr, seconds: rendered.L.length / sr, nonFiniteFrames: nonFinite, underruns: rendered.metrics.underruns };
}

try {
  const saved = db.prepare("SELECT value FROM kv WHERE key='settings'").get() as { value: string } | undefined;
  const settings = { ...DEFAULT_AUTOMIX_SETTINGS, ...parse(saved?.value ?? null)?.automix };
  const logged = db.prepare("SELECT * FROM transition_log WHERE rating IN ('good','bad') ORDER BY id").all() as unknown as Log[];
  // Match the application's historical fallback: only stored features or historical BPM, no
  // invented source endpoints/vocal availability for old ratings.
  const feedback = ratingStats(logged.map(row => {
    const p = parse(row.plan) as TransitionPlan, outcome = parse(row.outcome) ?? {};
    const tempo = (id: string) => { const t = track(id); return { beat: t && analysis(t)?.beat ? { bpm: analysis(t)!.beat!.bpm } : null }; };
    return { rating: row.rating, reason: row.rating_reason, features: outcome.listenerFeatures?.version === 4 && Array.isArray(outcome.listenerFeatures.features) ? outcome.listenerFeatures.features : ratingFeatures(p, p.beatAlign ? null : tempo(row.from_track), p.beatAlign ? null : tempo(row.to_track), { outcome }) };
  }));
  const rows: Record<string, unknown>[] = [];
  for (const fixture of evidence.transitions) {
    const log = logged.find(r => r.id === fixture.id);
    if (!log) { rows.push({ logId: fixture.id, unavailable: 'historical log no longer present' }); continue; }
    const ta = track(log.from_track), tb = track(log.to_track);
    if (!ta || !tb) { rows.push({ logId: log.id, unavailable: 'track metadata missing' }); continue; }
    const a = plannerTrack(ta), b = plannerTrack(tb), old = parse(log.plan) as TransitionPlan;
    const finalists = planFinalists(a, b, settings, feedback), top = finalists[0];
    const describe = (p: TransitionPlan) => ({ version: p.version, method: p.method, duration: p.duration, aExit: p.aExit, bEntry: p.bEntry, bDelay: p.bDelay ?? 0, selected: (p.debug.fullMix as { this?: string } | undefined)?.this ?? null, effectiveCutSeconds: a.analysis ? Math.max(0, a.analysis.audibleEnd - effectiveExit(p, a.analysis).source) : null, cost: a.analysis && b.analysis ? fullMixCost(p, a.analysis, b.analysis, settings) : null });
    const result: Record<string, unknown> = { logId: log.id, rating: log.rating, reason: log.rating_reason, analysis: { A: a.analysis?.version ?? null, B: b.analysis?.version ?? null, currentAnalyzer: a.analysis?.version === ANALYZER_VERSION && b.analysis?.version === ANALYZER_VERSION }, historical: describe(old), planned: describe(top), candidates: finalists.map(describe) };
    const ia = localInput(ta), ib = localInput(tb);
    result.localAudio = { A: ia?.format ?? 'unavailable', B: ib?.format ?? 'unavailable' };
    if (ia && ib) {
      try {
        const spans = finalistSpans([old, ...finalists]), sa = readSpan(ia, spans.a), sb = readSpan(ib, spans.b);
        const selected = await chooseByRender(finalists, sa, sb);
        result.final = describe(selected); result.renderCheck = selected.debug.renderCheck;
        result.historicalRenderMetrics = renderMetrics(old, sa, sb);
        result.snippets = [await excerpt(old, sa, sb, `${log.id}-A-historical.wav`), await excerpt(selected, sa, sb, `${log.id}-B-upgrade.wav`)];
      } catch (error) { result.renderUnavailable = error instanceof Error ? error.message.replaceAll(rootDir, '[data directory]').replaceAll(ffmpeg, '[ffmpeg]') : 'local render failed'; }
    } else result.renderUnavailable = 'PCM/local encoded source unavailable; no provider requests made';
    rows.push(result);
    console.log(JSON.stringify({ logId: log.id, historicalDuration: old.duration, plannedDuration: top.duration, rendered: !!result.final, error: result.renderUnavailable ?? null }));
  }
  const report = { generatedAt: new Date().toISOString(), plannerVersion: PLANNER_VERSION, analyzerVersion: ANALYZER_VERSION, fixedEvidenceCount: evidence.transitions.length, databaseReadOnly: true, networkUsed: false, listeningPerformed: false, settings, sampleRate: sr, snippetContextSeconds: 6, audioDirectory: path.relative(process.cwd(), audioDir).replaceAll('\\', '/'), limitations: ['Musical risk measures are heuristics, not singing detection or listening judgments.', 'Historical logs are preserved; historical/current costs above are recomputed with the same new cost function.', 'These selected listener examples are not a random quality sample.', 'Blind listening to voice complaints and IDs 169/179 plus four liked controls is still required.'], summary: { evaluated: rows.length, rendered: rows.filter(r => r.final).length, unavailable: rows.filter(r => !r.final).length }, transitions: rows };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary));
} finally { db.close(); }
