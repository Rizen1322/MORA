/** Word-level check of vocal handoffs in audit reports: how often the old voice fades inside a
 * recognised word, B opens on a word, and how many words are masked. Uses lyrics.json timing.
 * Usage: npx tsx tools/word-cuts.ts REPORT.json [REPORT2.json ...] */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../apps/server/src/config.ts';
import { StemService } from '../apps/server/src/stems.ts';
import { EventHub } from '../apps/server/src/events.ts';
import type { Library } from '../apps/server/src/library.ts';
import type { TransitionPlan } from '../packages/core/src/index.ts';
import { integrateTempo } from '../packages/core/src/plan/timing.ts';
import { lyricTiming, splitsWord, wordsIn } from '../packages/core/src/plan/vocals.ts';

const cfg = loadConfig(), stems = new StemService({ ...cfg, stemsPython: null }, {} as Library, new EventHub());
for (const file of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as { planner: string; tracks: { id: string; contentHash: string; analysis: never }[]; rows: { fromId: string; toId: string; plan: TransitionPlan }[] };
  const hash = new Map(r.tracks.map((t) => [t.id, t.contentHash]));
  const timing = (id: string) => { const a = stems.activity(hash.get(id)!); return a ? lyricTiming({ vocalActivity: a } as never) : null; };
  let n = 0, aSplit = 0, bSplit = 0, lostA = 0, lostB = 0, guard = 0;
  for (const { fromId, toId, plan: p } of r.rows) {
    if (!p.vocalA || !p.vocalB) continue;
    const la = timing(fromId), lb = timing(toId);
    if (!la || !lb) continue;
    n++;
    const src = (m: [number, number][] | undefined, base: number, t: number) => base + integrateTempo(m, t);
    const [aFade, aEnd] = [p.vocalA[1][0], p.vocalA[2][0]], [bStart, bOpen] = [p.vocalB[1][0], p.vocalB[2][0]];
    if (splitsWord(la, src(p.tempoA, p.aExit, aFade), src(p.tempoA, p.aExit, aEnd))) aSplit++;
    if (splitsWord(lb, src(p.tempoB, p.bEntry, bStart), src(p.tempoB, p.bEntry, bOpen))) bSplit++;
    // words masked: A's words after its voice is gone while A is still in the mix, B's words before it opens
    const gA = p.automation.find((l) => l.deck === 'A' && l.lane === 'gain')?.points ?? [[0, 1]];
    let aGone = p.duration; for (let t = p.duration; t > 0; t -= 0.05) { let v = gA[gA.length - 1][1]; for (let i = 1; i < gA.length; i++) if (t <= gA[i][0]) { v = gA[i - 1][1] + (gA[i][1] - gA[i - 1][1]) * (t - gA[i - 1][0]) / (gA[i][0] - gA[i - 1][0]); break; } if (v > 0.1) { aGone = t; break; } }
    lostA += wordsIn(la, src(p.tempoA, p.aExit, aEnd), src(p.tempoA, p.aExit, Math.max(aEnd, aGone)));
    lostB += wordsIn(lb, p.bEntry, src(p.tempoB, p.bEntry, bStart));
    if ((p.debug.stems as { bleedGuard?: unknown })?.bleedGuard) guard++;
  }
  console.log(`${r.planner}: ${n} передач голоса со словами; A режется в слове ${aSplit}, B открывается на слове ${bSplit}; скрыто слов A ${lostA} (${(lostA / n).toFixed(2)}/переход), B ${lostB} (${(lostB / n).toFixed(2)}); защита от утечки ${guard}`);
}
