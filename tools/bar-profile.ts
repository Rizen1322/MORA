/** Drum-pattern bar alignment of logged transitions, with the production analyzer and planner code.
 * For each transition: accents of A around its exit and B after its entry on the stored analysis grids
 * (local region grid when the plan used one), bar patterns and their match at rotations k = 0..3.
 * Private output. Usage: npx tsx tools/bar-profile.ts --rated | LOG_ID...
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../apps/server/src/config.ts';
import type { BeatGrid, BeatRegion, TrackAnalysis, TransitionPlan } from '../packages/core/src/index.ts';
import { ANALYSIS_RATE } from '../packages/core/src/mir/spectral.ts';
import { beatAccents, drumEnvelopes } from '../packages/core/src/mir/analyze.ts';
import { barPattern, drumAlignment } from '../packages/core/src/plan/planner.ts';

const cfg = loadConfig(), db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
const trackQ = db.prepare("SELECT t.*, (SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t WHERE id=?");
// newest stored analysis of any version: only its grid is used, accents are recomputed here
const analysisQ = db.prepare("SELECT data FROM analysis WHERE content_hash=? AND status='done' ORDER BY updated_at DESC LIMIT 1");
const fileOf = (t: { provider: string; content_hash: string; file: string }) => t.provider === 'yandex' && /^[a-f\d]{64}$/.test(t.content_hash) ? path.join(cfg.dataDir, 'remote', 'yandex', `${t.content_hash}.mp3`) : t.file;
const drums = new Map<string, ReturnType<typeof drumEnvelopes>>();
const drumsOf = (file: string) => {
  let d = drums.get(file);
  if (!d) {
    const buf = execFileSync(cfg.ffmpeg, ['-v', 'fatal', '-i', file, '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 28, windowsHide: true });
    d = drumEnvelopes(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    if (drums.size > 8) drums.delete(drums.keys().next().value!);
    drums.set(file, d);
  }
  return d;
};

const ids = process.argv[2] === '--rated'
  ? (db.prepare("SELECT id FROM transition_log WHERE rating IS NOT NULL AND method IN ('beatmatch_blend','tempo_bridge') ORDER BY id DESC").all() as { id: number }[]).map((r) => r.id)
  : process.argv.slice(2).map(Number);
const rows: object[] = [];
for (const id of ids) {
  const log = db.prepare('SELECT plan, from_track, to_track, rating, rating_reason FROM transition_log WHERE id=?').get(id) as { plan: string; from_track: string; to_track: string; rating: string; rating_reason: string } | undefined;
  if (!log) continue;
  const plan = JSON.parse(log.plan) as TransitionPlan, ba = plan.beatAlign;
  if (!ba || ba.relation !== 1) { console.log(`#${id} ${log.rating} ${log.rating_reason ?? ''}: relation ${ba?.relation ?? '-'}, не сравнивается`); continue; }
  const pats: (number[][] | null)[] = [];
  const names: string[] = [];
  for (const [deck, tid] of [['A', log.from_track], ['B', log.to_track]] as const) {
    const t = trackQ.get(tid) as { title: string; provider: string; content_hash: string; file: string };
    const a = JSON.parse((analysisQ.get(t.content_hash) as { data: string }).data) as TrackAnalysis;
    const r = ba.regions?.[deck];
    const grid: Pick<BeatGrid, 'beats' | 'downbeats'> | BeatRegion | null = r ? a.beatRegions?.find((x) => Math.abs(x.start - r.start) < 0.01) ?? null : a.beat;
    if (!grid) { pats.push(null); continue; }
    const g = { ...grid, accents: beatAccents(drumsOf(fileOf(t)), grid.beats) };
    // same windows as the planner: four bars of A before its exit through the overlap; B's overlap plus 16 beats
    const pa = 60 / (deck === 'A' ? ba.bpmA : ba.bpmB);
    const native = ba.overlapBeats * pa;
    pats.push(deck === 'A' ? barPattern(g, plan.aExit - 16 * pa, plan.aExit + native) : barPattern(g, plan.bEntry, plan.bEntry + native + 16 * pa));
    names.push(t.title);
  }
  const match = pats[0] && pats[1] ? drumAlignment(pats[0], pats[1]) : null;
  const k = match ? match.indexOf(Math.max(...match)) : 0;
  const shift = !!match && k > 0 && match[k] - match[0] >= 0.5 && match[k] >= 0.3;
  rows.push({ id, rating: log.rating, reason: log.rating_reason, from: names[0], to: names[1], version: plan.version, method: plan.method, patterns: pats, match, shift: shift ? k : 0 });
  console.log(`#${id} ${log.rating} ${log.rating_reason ?? ''} ${plan.method} ${names.join(' → ')}: match ${match ? JSON.stringify(match.map((x) => +x.toFixed(2))) : 'нет рисунка'}${shift ? ` → сдвиг ${k}` : ''}`);
}
const file = path.join(cfg.dataDir, 'reports', 'drum-pattern-rated.json');
fs.writeFileSync(file, JSON.stringify(rows, null, 2));
console.log(file);
