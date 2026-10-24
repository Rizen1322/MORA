/** Our beat grid against Beat This! (CPJKU, MIT) on a small set of real tracks; private output only.
 *  1. npx tsx tools/beat-this-compare.ts --prepare --dir DIR [--limit 20]
 *     picks tracks from data-dev/reports/structure-v3.json: every periodHint first, then unstable and stable grids
 *     alternately, up to --limit; decodes WAV into DIR (44.1 kHz, same ffmpeg decode as our analysis)
 *     and writes DIR/manifest.json with our current beats/downbeats.
 *  2. python -I tools/beat-this-run.py DIR/manifest.json DIR/beat-this.json --site SITE [--checkpoint small0]
 *  3. npx tsx tools/beat-this-compare.ts --compare DIR
 *     beat and downbeat F-measure (±70 ms, MIREX convention), tempo ratio, whether periodHint matches Beat This.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../apps/server/src/config.ts';
import { analyzePcm } from '../packages/core/src/mir/analyzePcm.ts';

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const cfg = loadConfig();

/** F-measure of detected vs reference event times, one-to-one matches within `tol` seconds. */
export function fMeasure(ref: number[], est: number[], tol = 0.07): number {
  if (!ref.length || !est.length) return 0;
  let i = 0, j = 0, hit = 0;
  while (i < ref.length && j < est.length) {
    const d = est[j] - ref[i];
    if (Math.abs(d) <= tol) { hit++; i++; j++; } else if (d < 0) j++; else i++;
  }
  return (2 * hit) / (ref.length + est.length);
}
assert.equal(fMeasure([1, 2, 3], [1.05, 2.01, 3.2]), 2 * 2 / 6);
assert.equal(fMeasure([1, 2], [1, 1.01, 2]), 2 * 2 / 5);

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
/** Beat period by least squares over beat indices (gaps count as whole missed beats) and the rms residual:
 * a small residual means Beat This! itself found one constant tempo. */
function fitPeriod(b: number[]) {
  const med = median(b.slice(1).map((t, k) => t - b[k]));
  const ks = [0];
  for (let i = 1; i < b.length; i++) ks.push(ks[i - 1] + Math.max(1, Math.round((b[i] - b[i - 1]) / med)));
  const n = b.length, sx = ks.reduce((a, c) => a + c, 0), sy = b.reduce((a, c) => a + c, 0);
  const sxx = ks.reduce((a, c) => a + c * c, 0), sxy = ks.reduce((a, c, i) => a + c * b[i], 0);
  const period = (n * sxy - sx * sy) / (n * sxx - sx * sx), t0 = (sy - period * sx) / n;
  return { period, residual: Math.sqrt(b.reduce((a, t, i) => a + (t - t0 - ks[i] * period) ** 2, 0) / n) };
}
{
  const f = fitPeriod([0, 0.5, 1, 2, 2.5]);
  assert(Math.abs(f.period - 0.5) < 1e-9 && f.residual < 1e-9);
}
const wholeShare = (xs: number[]) => xs.filter((x) => Math.abs(x - Math.round(x)) < 0.15).length / Math.max(1, xs.length);

if (process.argv.includes('--prepare')) {
  const dir = arg('--dir', ''), limit = Number(arg('--limit', '20'));
  if (!dir) throw new Error('--dir обязателен');
  fs.mkdirSync(dir, { recursive: true });
  const report = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'reports', 'structure-v3.json'), 'utf8')) as { rows: any[] };
  const rows = report.rows.filter((r) => r.segments !== undefined && r.bpm);
  // periodHint first, then unstable and stable grids alternately, capped at --limit
  const hints = rows.filter((r) => r.gridCheck?.periodHint), rest = rows.filter((r) => !r.gridCheck?.periodHint);
  const unstable = rest.filter((r) => !r.gridStable), stable = rest.filter((r) => r.gridStable);
  const mixed = Array.from({ length: Math.max(unstable.length, stable.length) }, (_, k) => [unstable[k], stable[k]]).flat().filter(Boolean);
  const picked = [...hints, ...mixed].slice(0, limit);
  const db = new DatabaseSync(path.join(cfg.dataDir, 'automix.sqlite'), { readOnly: true });
  const q = db.prepare("SELECT t.provider, t.content_hash, (SELECT path FROM track_sources s WHERE s.track_id=t.id AND s.path IS NOT NULL LIMIT 1) AS file FROM tracks t WHERE id=?");
  const tracks = [];
  for (const r of picked) {
    const t = q.get(r.id) as { provider: string; content_hash: string; file: string };
    const file = t.provider === 'yandex' ? path.join(cfg.dataDir, 'remote', 'yandex', `${t.content_hash}.mp3`) : t.file;
    const wav = path.join(dir, `${t.content_hash.slice(0, 16)}.wav`);
    execFileSync(cfg.ffmpeg, ['-v', 'fatal', '-y', '-i', file, '-ac', '2', '-ar', '44100', wav], { windowsHide: true });
    const buf = execFileSync(cfg.ffmpeg, ['-v', 'fatal', '-i', wav, '-f', 'f32le', 'pipe:1'], { maxBuffer: 1 << 30, windowsHide: true });
    const f = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4), n = f.length / 2, L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = f[2 * i]; R[i] = f[2 * i + 1]; }
    const a = analyzePcm(L, R);
    tracks.push({ id: r.id, wav, bpm: a.beat?.bpm ?? null, stable: a.beat?.stable ?? false, beats: a.beat?.beats ?? [], downbeats: a.beat?.downbeats ?? [],
      regions: (a.beatRegions ?? []).map((g) => ({ start: g.start, end: g.end, bpm: g.bpm })), periodHint: a.structure?.gridCheck?.periodHint ?? null });
    console.log(`${tracks.length}/${picked.length} ${r.id.slice(0, 8)} ${a.beat?.bpm ?? '-'}${a.structure?.gridCheck?.periodHint ? ` hint ${a.structure.gridCheck.periodHint.bpm}` : ''}`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ tracks }, null, 1));
  console.log(path.join(dir, 'manifest.json'));
}

if (process.argv.includes('--compare')) {
  const dir = arg('--compare', '');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { tracks: any[] };
  const bt = JSON.parse(fs.readFileSync(path.join(dir, 'beat-this.json'), 'utf8')) as { checkpoint: string; device: string; loadSeconds: number; results: any[] };
  // repetition lags of the music (structure gridCheck, in our beats) decide between the two tempi
  const structure = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'reports', 'structure-v3.json'), 'utf8')) as { rows: any[] };
  const rows = [];
  for (const m of manifest.tracks) {
    const r = bt.results.find((x) => x.id === m.id);
    if (!r) continue;
    const fit = fitPeriod(r.beats);
    // shortcut: median beat interval (20 ms frames) when Beat This! tempo is not constant; enough for a tempo ratio
    const btBpm = fit.residual < 0.05 ? 60 / fit.period : 60 / median(r.beats.slice(1).map((t: number, k: number) => t - r.beats[k]));
    const ratio = m.bpm ? btBpm / m.bpm : NaN;
    const lags: number[] = structure.rows.find((x) => x.id === m.id)?.gridCheck?.lagBeats ?? [];
    rows.push({
      id: m.id, ourBpm: m.bpm, stable: m.stable, btBpm: Math.round(btBpm * 100) / 100, ratio: Math.round(ratio * 1000) / 1000,
      beatF: Math.round(fMeasure(r.beats, m.beats) * 1000) / 1000, downbeatF: Math.round(fMeasure(r.downbeats, m.downbeats) * 1000) / 1000,
      hint: m.periodHint?.bpm ?? null, hintMatches: m.periodHint ? Math.abs(m.periodHint.bpm / btBpm - 1) < 0.03 || Math.abs((2 * m.periodHint.bpm) / btBpm - 1) < 0.03 || Math.abs(m.periodHint.bpm / (2 * btBpm) - 1) < 0.03 : null,
      btConstantTempo: fit.residual < 0.05, lags: lags.length,
      lagsWholeOurs: lags.length ? Math.round(wholeShare(lags) * 100) / 100 : null,
      lagsWholeBeatThis: lags.length && fit.residual < 0.05 && m.bpm ? Math.round(wholeShare(lags.map((x) => (x * 60) / m.bpm / fit.period)) * 100) / 100 : null,
      seconds: r.seconds, peakMiB: Math.round(r.peakMiB),
    });
  }
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const summary = {
    checkpoint: bt.checkpoint, device: bt.device, loadSeconds: bt.loadSeconds, tracks: rows.length,
    medianSeconds: median(rows.map((r) => r.seconds)), maxPeakMiB: Math.max(...rows.map((r) => r.peakMiB)),
    stable: { tracks: rows.filter((r) => r.stable).length, beatF: mean(rows.filter((r) => r.stable).map((r) => r.beatF)), downbeatF: mean(rows.filter((r) => r.stable).map((r) => r.downbeatF)) },
    unstable: { tracks: rows.filter((r) => !r.stable).length, beatF: mean(rows.filter((r) => !r.stable).map((r) => r.beatF)), downbeatF: mean(rows.filter((r) => !r.stable).map((r) => r.downbeatF)) },
    tempoDisagreements: rows.filter((r) => Math.abs(r.ratio - 1) > 0.03 && Math.abs(r.ratio - 2) > 0.06 && Math.abs(r.ratio - 0.5) > 0.015)
      .map((r) => ({ id: r.id, ourBpm: r.ourBpm, btBpm: r.btBpm, ratio: r.ratio, lagsWholeOurs: r.lagsWholeOurs, lagsWholeBeatThis: r.lagsWholeBeatThis })),
    periodHints: rows.filter((r) => r.hint).map((r) => ({ id: r.id, ourBpm: r.ourBpm, hint: r.hint, btBpm: r.btBpm, matches: r.hintMatches })),
  };
  const out = path.join(cfg.dataDir, 'reports', 'beat-this-compare.json');
  fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(out);
}
