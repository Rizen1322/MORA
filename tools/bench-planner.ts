/** Planner cost per pair on saved analyses (no audio): time and memory.
 *   npx tsx --expose-gc tools/bench-planner.ts [--report user-library-planning-baseline-v10.json] [--no-stems]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../apps/server/src/config.ts';
import { planTransition, type PlannerTrack } from '../packages/core/src/index.ts';
const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const file = path.join(loadConfig().dataDir, 'reports', arg('--report', 'user-library-planning-baseline-v10.json'));
const raw = fs.readFileSync(file, 'utf8'), rep = JSON.parse(raw), noStems = process.argv.includes('--no-stems');
const settings = { ...rep.settings, ...(noStems ? { stemMixing: false } : {}) };
const tracks: PlannerTrack[] = rep.tracks.map((t: any) => ({ id: t.id, duration: t.analysis.duration, mixingAllowed: true, analysis: noStems ? { ...t.analysis, vocalActivity: undefined } : t.analysis }));
const sizes = rep.tracks.map((t: any) => Buffer.byteLength(JSON.stringify(noStems ? { ...t.analysis, vocalActivity: undefined } : t.analysis)));
const gc = (globalThis as any).gc as (() => void) | undefined;
gc?.(); const heap0 = process.memoryUsage().heapUsed;
const times: number[] = []; let peak = 0;
for (const a of tracks) for (const b of tracks) if (a !== b) {
  const t0 = performance.now(); planTransition(a, b, settings); times.push(performance.now() - t0);
  peak = Math.max(peak, process.memoryUsage().heapUsed - heap0);
}
times.sort((x, y) => x - y);
const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
console.log(JSON.stringify({ report: path.basename(file), noStems, pairs: times.length, msMedian: q(0.5), msP95: q(0.95), msMax: times.at(-1),
  analysisJsonKiB: { median: sizes.sort((x: number, y: number) => x - y)[sizes.length >> 1] / 1024, max: Math.max(...sizes) / 1024 },
  heapGrowthWhilePlanningMiB: peak / 1048576, gcExposed: !!gc }, null, 1));
