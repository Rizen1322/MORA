/** Repetition structure (am-analyzer structure field) measured on the real library; private output only.
 * Re-analyzes decoded audio with the current analyzer, checks that the pre-existing fields are unchanged
 * against the stored analysis, and compares the structure with independent signals:
 *  - separated vocal activity (stem cache), when present;
 *  - repeated lines of a word-timed transcript in data-dev/reports/lyrics-proto/<hash>.json, when present
 *    (times only; no text is printed or stored);
 *  - listener-rated transitions (structural position of A's exit and B's entry).
 * Usage: npx tsx tools/structure-report.ts [--limit 40] [--rated] [--clips] [--tag NAME]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import { EventHub } from '../apps/server/src/events.ts';
import type { Library } from '../apps/server/src/library.ts';
import { analyzePcm } from '../packages/core/src/mir/analyzePcm.ts';
import { closureAt, skipCost } from '../packages/core/src/mir/repetition.ts';
import type { SongStructure, TrackAnalysis, TransitionPlan } from '../packages/core/src/types.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const cfg = loadConfig();
const tag = arg('--tag', 'structure-v1');
if (!/^[\p{L}\p{N}_-]+$/u.test(tag)) throw new Error('некорректное имя отчёта');
const limit = Number(arg('--limit', '40'));
const out = path.join(cfg.dataDir, 'reports');
const db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
// Never start Python jobs: read validated caches only.
const stems = new StemService({ ...cfg, stemsPython: null }, {} as Library, new EventHub());

interface Track { id: string; title: string; artist: string; provider: string; content_hash: string; file: string; duration: number }
const all = (db.prepare("SELECT t.id, t.title, t.artist, t.provider, t.content_hash, t.duration, (SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t WHERE provider IN ('local','yandex') AND status='ok' ORDER BY added_at, id").all() as unknown as Track[])
  .map((t) => (t.provider === 'yandex' && /^[a-f\d]{64}$/.test(t.content_hash) ? { ...t, file: path.join(cfg.dataDir, 'remote', 'yandex', `${t.content_hash}.mp3`) } : t))
  .filter((t) => t.file && fs.existsSync(t.file) && !t.file.includes(`${path.sep}examples${path.sep}`));
const rated = (db.prepare("SELECT id, from_track, to_track, rating, rating_reason, plan FROM transition_log WHERE rating IS NOT NULL ORDER BY id").all() as { id: number; from_track: string; to_track: string; rating: string; rating_reason: string | null; plan: string }[]);
const lyricsDir = path.join(out, 'lyrics-proto');
const byId = new Map(all.map((t) => [t.id, t]));
const chosen = new Map<string, Track>();
// tracks with transcripts and rated transitions first, then an even spread over the library
for (const t of all) if (fs.existsSync(path.join(lyricsDir, `${t.content_hash}.json`))) chosen.set(t.id, t);
if (process.argv.includes('--rated')) for (const r of rated) for (const id of [r.from_track, r.to_track]) { const t = byId.get(id); if (t) chosen.set(id, t); }
for (let k = 0; k < Math.min(limit, all.length); k++) { const t = all[Math.floor((k * all.length) / limit)]; chosen.set(t.id, t); }

function decode(file: string) {
  const buf = execFileSync(cfg.ffmpeg, ['-v', 'fatal', '-i', file, '-ac', '2', '-ar', '44100', '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 30, windowsHide: true });
  const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const n = f.length / 2, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
  return { L, R };
}

/** Time intervals of transcript lines whose (normalized) text occurs at least twice. */
function repeatedLyricIntervals(hash: string): { repeated: [number, number][]; sung: [number, number][] } | null {
  const file = path.join(lyricsDir, `${hash}.json`);
  if (!fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { lines?: { start: number; end: number; text: string }[] };
  if (!Array.isArray(j.lines) || !j.lines.length) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  const count = new Map<string, number>();
  for (const l of j.lines) { const k = norm(l.text); if (k.split(' ').length >= 3) count.set(k, (count.get(k) ?? 0) + 1); }
  return {
    repeated: j.lines.filter((l) => (count.get(norm(l.text)) ?? 0) >= 2).map((l) => [l.start, l.end]),
    sung: j.lines.map((l) => [l.start, l.end]),
  };
}
const overlap = (a: [number, number][], b: [number, number][]) => {
  let s = 0;
  for (const x of a) for (const y of b) s += Math.max(0, Math.min(x[1], y[1]) - Math.max(x[0], y[0]));
  return s;
};
const total = (a: [number, number][]) => a.reduce((s, x) => s + x[1] - x[0], 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

const stored = db.prepare("SELECT version, data FROM analysis WHERE content_hash=? AND status='done' ORDER BY updated_at DESC LIMIT 1");
const rows: Record<string, unknown>[] = [];
const structures = new Map<string, { st: SongStructure; a: TrackAnalysis }>();
let i = 0;
for (const t of chosen.values()) {
  i++;
  const started = Date.now();
  let pcm;
  try { pcm = decode(t.file); } catch { console.log(`${i}/${chosen.size} декодирование не удалось: ${t.id}`); continue; }
  const a = analyzePcm(pcm.L, pcm.R);
  const st = a.structure;
  if (!st) { rows.push({ id: t.id, provider: t.provider, structure: null }); continue; }
  structures.set(t.id, { st, a });
  // regression: fields computed before the structure stage must not change
  const prev = stored.get(t.content_hash) as { version: string; data: string } | undefined;
  let regression: Record<string, unknown> | null = null;
  if (prev) {
    const p = JSON.parse(prev.data) as TrackAnalysis;
    const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
    regression = {
      version: prev.version,
      beat: same(p.beat?.beats, a.beat?.beats) && same(p.beat?.downbeats, a.beat?.downbeats) && same(p.beat?.accents, a.beat?.accents),
      regions: same(p.beatRegions?.map((r) => [r.start, r.end, r.bpm]), a.beatRegions?.map((r) => [r.start, r.end, r.bpm])),
      sections: same(p.sections, a.sections),
      cues: same(p.cues, a.cues),
    };
  }
  const chorusGroup = st.likelyChorus?.group ?? -2;
  const segs = st.segments;
  const span = (pred: (s: SongStructure['segments'][number]) => boolean) => segs.filter(pred).map((s) => [s.start, s.end] as [number, number]);
  const chorusSpans = span((s) => s.group === chorusGroup), repeatSpans = span((s) => s.group >= 0);
  // vocals: mean separated-vocal activity inside the chorus hypothesis vs elsewhere
  const meta = stems.get(t.content_hash);
  let vocal: Record<string, number> | null = null;
  if (meta && st.likelyChorus) {
    const act = meta.activity, mean = (spans: [number, number][], inside: boolean) => {
      let s = 0, c = 0;
      for (let k = 0; k < act.values.length; k++) {
        const time = k / act.rate, inSpan = spans.some(([x, y]) => time >= x && time < y);
        if (inSpan === inside && time >= a.audibleStart && time < a.audibleEnd) { s += act.values[k]; c++; }
      }
      return c ? s / c : 0;
    };
    vocal = { chorus: r2(mean(chorusSpans, true)), other: r2(mean(chorusSpans, false)) };
  }
  const lyr = repeatedLyricIntervals(t.content_hash);
  let lyrics: Record<string, number> | null = null;
  if (lyr && total(lyr.sung) > 20) {
    lyrics = {
      sungSeconds: Math.round(total(lyr.sung)),
      repeatedLineSeconds: Math.round(total(lyr.repeated)),
      // precision: share of chorus-hypothesis singing that is repeated lyrics; recall: share of repeated lyrics inside it
      chorusPrecision: r2(overlap(chorusSpans, lyr.repeated) / Math.max(1e-6, overlap(chorusSpans, lyr.sung))),
      chorusRecall: r2(overlap(chorusSpans, lyr.repeated) / Math.max(1e-6, total(lyr.repeated))),
      repeatRecall: r2(overlap(repeatSpans, lyr.repeated) / Math.max(1e-6, total(lyr.repeated))),
      baseRate: r2(total(lyr.repeated) / Math.max(1e-6, total(lyr.sung))),
    };
  }
  const row = {
    id: t.id, provider: t.provider, duration: Math.round(a.duration),
    bpm: a.beat?.bpm ?? null, gridStable: a.beat?.stable ?? false, downbeatConfidence: a.beat ? r2(a.beat.downbeatConfidence) : null,
    segments: segs.length, groups: st.groups.length, coverage: st.repetitionCoverage,
    likelyChorus: st.likelyChorus ? { confidence: st.likelyChorus.confidence, occurrences: st.groups[chorusGroup].occurrences.length, first: st.groups[chorusGroup].occurrences[0].start, tags: st.likelyChorus.tags } : null,
    chorusLevelDb: st.likelyChorus ? r2(st.groups[chorusGroup].relDb) : null,
    gridCheck: st.gridCheck ?? null, regression, vocal, lyrics,
    // C = chorus hypothesis, gN = other repeat group, bare time = heard once
    layout: segs.map((s) => `${Math.round(s.start)}${s.group < 0 ? '' : `:${s.group === chorusGroup ? 'C' : `g${s.group}.`}${s.occurrence}`}`).join(' '),
    elapsedMs: Date.now() - started,
  };
  rows.push(row);
  console.log(`${i}/${chosen.size} ${t.provider} ${row.duration}s bpm ${row.bpm ?? '-'} seg ${row.segments} grp ${row.groups} cov ${row.coverage} chorus ${row.likelyChorus ? row.likelyChorus.confidence + 'x' + row.likelyChorus.occurrences : '-'}`
    + `${row.gridCheck ? ` grid ${row.gridCheck.beatIntegerShare}/${row.gridCheck.barIntegerShare}` : ''}${vocal ? ` voc ${vocal.chorus}/${vocal.other}` : ''}${lyrics ? ` lyr P${lyrics.chorusPrecision} R${lyrics.chorusRecall} base${lyrics.baseRate}` : ''}`
    + `${regression && !(regression.beat && regression.sections && regression.cues) ? ' REGRESSION ' + JSON.stringify(regression) : ''}`);
  if (process.argv.includes('--clips') && st.likelyChorus) {
    const dir = path.join(out, `${tag}-clips`);
    fs.mkdirSync(dir, { recursive: true });
    const at = st.groups[chorusGroup].occurrences[0].start;
    execFileSync(cfg.ffmpeg, ['-v', 'fatal', '-y', '-ss', String(Math.max(0, at - 4)), '-t', '14', '-i', t.file, '-af', 'afade=t=in:d=0.5', path.join(dir, `${t.content_hash.slice(0, 12)}-chorus-at-${Math.round(at)}s.mp3`)], { windowsHide: true });
  }
}

// listener-rated transitions: structural position of the exit and the entry
const transitions = [];
for (const r of rated) {
  const A = structures.get(r.from_track), B = structures.get(r.to_track);
  if (!A || !B) continue;
  const plan = JSON.parse(r.plan) as TransitionPlan;
  const bSeg = B.st.segments.find((s) => plan.bEntry >= s.start - 1.5 && plan.bEntry < s.end) ?? null;
  const chorusB = B.st.likelyChorus ? B.st.groups[B.st.likelyChorus.group].occurrences : [];
  const blendEndB = plan.bEntry + plan.duration;
  transitions.push({
    id: r.id, rating: r.rating, reason: r.rating_reason, method: plan.method,
    aExitClosure: r2(closureAt(A.st, plan.aExit)), aEndClosure: r2(closureAt(A.st, plan.aExit + plan.duration)),
    bEntryAtSegmentStart: !!bSeg && Math.abs(bSeg.start - plan.bEntry) <= 1.5,
    bSkipCost: r2(skipCost(B.st, B.a.audibleStart, plan.bEntry)), bSkipped: r2(plan.bEntry - B.a.audibleStart),
    bChorusStartsUnderBlend: chorusB.some((o) => o.start > plan.bEntry + 1 && o.start < blendEndB),
    bChorusSkipped: chorusB.some((o) => o.end <= plan.bEntry),
  });
}

const ok = rows.filter((r) => r.segments !== undefined) as any[];
const share = (f: (r: any) => boolean, of = ok) => r2(of.filter(f).length / Math.max(1, of.length));
const median = (v: number[]) => { const s = [...v].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const withLyrics = ok.filter((r) => r.lyrics && r.likelyChorus);
const withVocal = ok.filter((r) => r.vocal);
const grid = ok.filter((r) => r.gridCheck && r.gridCheck.lags >= 3);
const summary = {
  tracks: ok.length,
  regressionFree: share((r) => !r.regression || (r.regression.beat && r.regression.sections && r.regression.cues)),
  withLikelyChorus: share((r) => !!r.likelyChorus),
  medianCoverage: median(ok.map((r) => r.coverage)),
  medianSegments: median(ok.map((r) => r.segments)),
  medianElapsedMs: median(ok.map((r) => r.elapsedMs)),
  vocal: withVocal.length ? { tracks: withVocal.length, chorusMoreVocal: share((r) => r.vocal.chorus > r.vocal.other, withVocal), medianChorus: median(withVocal.map((r) => r.vocal.chorus)), medianOther: median(withVocal.map((r) => r.vocal.other)) } : null,
  lyrics: withLyrics.length ? { tracks: withLyrics.length, medianPrecision: median(withLyrics.map((r) => r.lyrics.chorusPrecision)), medianBaseRate: median(withLyrics.map((r) => r.lyrics.baseRate)), medianRecall: median(withLyrics.map((r) => r.lyrics.chorusRecall)), medianRepeatRecall: median(withLyrics.map((r) => r.lyrics.repeatRecall)) } : null,
  gridCheck: grid.length ? {
    tracks: grid.length,
    stableWithWholeBeats: share((r) => r.gridCheck.beatIntegerShare >= 0.7, grid.filter((r) => r.gridStable)),
    unstableWithWholeBeats: share((r) => r.gridCheck.beatIntegerShare >= 0.7, grid.filter((r) => !r.gridStable)),
    stableWithWholeBars: share((r) => r.gridCheck.barIntegerShare >= 0.7, grid.filter((r) => r.gridStable && r.gridCheck.beatIntegerShare >= 0.7)),
    suspicious: grid.filter((r) => r.gridStable && r.gridCheck.beatIntegerShare < 0.5).map((r) => r.id),
    periodHints: grid.filter((r) => r.gridCheck.periodHint).map((r) => ({ id: r.id, bpm: r.bpm, stable: r.gridStable, hint: r.gridCheck.periodHint })),
  } : null,
  ratedTransitions: transitions.length,
};
fs.writeFileSync(path.join(out, `${tag}.json`), JSON.stringify({ summary, transitions, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const t of transitions) console.log(`#${t.id} ${t.rating} ${t.reason ?? ''} ${t.method}: A closure ${t.aExitClosure}/${t.aEndClosure}, B seg-start ${t.bEntryAtSegmentStart}, skip ${t.bSkipped}s cost ${t.bSkipCost}, chorus under blend ${t.bChorusStartsUnderBlend}, chorus skipped ${t.bChorusSkipped}`);
console.log(path.join(out, `${tag}.json`));
