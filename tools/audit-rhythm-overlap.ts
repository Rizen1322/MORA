/** Read-only diagnostic coverage on rated, actually logged transitions. No ranking or training. */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ANALYZER_VERSION, type TrackAnalysis, type TransitionPlan } from '../packages/core/src/types.ts';
import { rhythmOverlap } from '../packages/core/src/plan/rhythm-overlap.ts';

const output = process.argv[2] ?? 'docs/rhythm-overlap-evidence-2026-10-27.json';
if (fs.existsSync(output)) throw Error('Choose a new evidence file; previous snapshots are immutable.');
const db = new DatabaseSync(path.join(process.env.LOCALAPPDATA!, 'MORA/data/automix.sqlite'), { readOnly: true });
try {
  const analysis = db.prepare(`SELECT data FROM analysis WHERE content_hash=? AND status='done' AND data IS NOT NULL
    ORDER BY version=? DESC, updated_at DESC LIMIT 1`);
  const measured = (hash: string): TrackAnalysis | null => {
    const row = analysis.get(hash, ANALYZER_VERSION) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  };
  const rows = db.prepare(`SELECT l.id, l.rating, l.rating_reason, l.plan, a.title fromTitle, b.title toTitle,
    a.content_hash fromHash, b.content_hash toHash FROM transition_log l
    LEFT JOIN tracks a ON a.id=l.from_track LEFT JOIN tracks b ON b.id=l.to_track
    WHERE l.rating IN ('good','bad') ORDER BY l.id`).all() as {
      id: number; rating: string; rating_reason: string | null; plan: string;
      fromTitle: string; toTitle: string; fromHash: string; toHash: string;
    }[];
  const evidence = rows.map(row => {
    const plan: TransitionPlan = JSON.parse(row.plan), a = measured(row.fromHash), b = measured(row.toHash);
    return { id: row.id, rating: row.rating, reason: row.rating_reason, from: row.fromTitle, to: row.toTitle,
      planVersion: plan.version, analysisVersions: { a: a?.version ?? null, b: b?.version ?? null },
      diagnostic: a && b ? rhythmOverlap(plan, a, b) : null };
  });
  const summary = { rated: evidence.length, measured: evidence.filter(x => x.diagnostic !== null).length,
    unknown: evidence.filter(x => x.diagnostic === null).length };
  fs.writeFileSync(output, JSON.stringify({ createdAt: new Date().toISOString(), databaseReadOnly: true,
    automaticSelectionChanged: false, interpretation: 'Structural beat-level accents, not audibility, vocals or musical quality.',
    summary, evidence }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, ...summary }));
} finally { db.close(); }
